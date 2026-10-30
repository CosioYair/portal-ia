import { normalizeGauntlet, normalizePipeline, type PipelineConfig, type Process } from '@portal-ia/domain';
import { processesRepo } from '../db/workspace.ts';
import { trackJob } from './activeJobs.ts';
import { clearCancel, isCancelled, runAssessment } from './assessment.ts';
import { teamReadiness } from './claudeCode/backend.ts';
import { subscriptionGate } from './claudeCode/usage.ts';
import { runDelegation } from './delegation.ts';
import { projectGauntlet, resolveGauntletFor, syncEvaluatorStep } from './gauntlet.ts';
import { runStory } from './storyExecution.ts';
import { newPipeline } from './storyPipeline.ts';

/**
 * Autorización ÚNICA de un proceso pendiente (historia, encargo de desarrollo, encargo de análisis o evaluación): la usan
 * la ruta del proceso, el chat, la bandeja y los encargos. Aquí y solo aquí empieza a gastar.
 * - Gauntlet `auto` se resuelve una vez, sin IA, y se guarda el modo resultante con sus motivos.
 * - Con Claude Code: un equipo que no puede ejecutar no empieza; tampoco si el último informe del CLI dice límite sin
 *   renovar u «overage» sin reconocer. El tope de llamadas a la suscripción del proceso queda en su configuración.
 */
export interface AuthorizeInput { budgetUsd: number; pipeline?: Partial<Omit<PipelineConfig, 'gauntlet'>> & { gauntlet?: { mode: 'off' | 'standard' | 'deep' | 'auto'; maxRounds?: number } } | null }
type Fail = Error & { statusCode: number; code?: string; payload?: Record<string, unknown> };
export const DEFAULT_SUBSCRIPTION_CALLS = 60;
const fail = (statusCode: number, message: string, code?: string, payload?: Record<string, unknown>): Fail => Object.assign(new Error(message), { statusCode, code, payload });

export function authorizeProcess(slug: string, id: string, input: AuthorizeInput, log: (o: any, m: string) => void): Process {
  const procs = processesRepo(slug); const proc = procs.get(id);
  if (!proc) throw fail(404, 'Proceso no encontrado');
  if (proc.status !== 'pending_authorization') throw fail(409, 'El proceso ya fue autorizado o finalizado.');
  if (procs.running().length) throw fail(409, 'Ya hay un proceso en ejecución. Espera a que termine.');
  const story = proc.kind === 'story_execution';
  // Gauntlet: el modo de esta tarea (o el del proyecto); `auto` se resuelve aquí y se guarda resuelto.
  const gauntlet = story && input.pipeline ? resolveGauntletFor(slug, proc, normalizeGauntlet(input.pipeline.gauntlet ?? projectGauntlet(slug, proc.projectId))) : null;
  if (gauntlet) syncEvaluatorStep(slug, id, gauntlet);
  // Claude Code: un equipo que no puede ejecutar (proyecto sin autorizar, consola sin conectar…) no empieza.
  const readiness = story ? teamReadiness(slug, id) : null;
  if (readiness && !readiness.ready && readiness.fallback !== 'api') throw fail(409, `No se inicia: ${readiness.team.find(t => !t.ready)!.reason}`, 'backend_not_ready', { readiness });
  if (readiness?.team.some(t => t.backend !== 'api')) {
    const gate = subscriptionGate();
    if (!gate.ok) throw fail(409, `No se inicia: ${gate.reason}`, 'subscription_limit', { report: gate.report });
  }
  if (story && input.pipeline && proc.result) {
    // Con la suscripción el USD no limita nada: sin tope indicado, el de un lote (60 llamadas), ampliable al continuar.
    const subscription = !!readiness?.team.some(t => t.backend !== 'api');
    const maxSubscriptionCalls = input.pipeline.maxSubscriptionCalls ?? (subscription ? DEFAULT_SUBSCRIPTION_CALLS : undefined);
    procs.setResult(id, { ...procs.get(id)!.result!, pipeline: newPipeline(normalizePipeline({ ...input.pipeline, maxSubscriptionCalls, gauntlet: gauntlet ?? undefined })) });
  }
  procs.authorize(id, input.budgetUsd);
  log({ processId: id, kind: proc.kind, budget: input.budgetUsd, gauntlet: gauntlet?.mode ?? null, auto: gauntlet?.auto?.reason ?? null }, 'proceso autorizado · inicia ejecución');
  const run = story ? runStory(slug, id, log, () => isCancelled(id)).finally(() => clearCancel(id))
    : proc.kind === 'delegated_task' ? runDelegation(slug, id, log, () => isCancelled(id)).finally(() => clearCancel(id))
    : runAssessment(slug, id, log);
  // Se registra ya (no en el siguiente tick): un proceso en marcha nunca debe parecer huérfano.
  trackJob(id, run).catch(e => log({ err: e?.message, processId: id }, 'fallo inesperado en el proceso'));
  return procs.get(id)!;
}

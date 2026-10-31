import { batchesRepo } from '../../db/batches.ts';
import { claudeCodeRunsRepo, processesRepo } from '../../db/workspace.ts';

/**
 * Tope de llamadas a la suscripción de Claude: se comprueba ANTES DE CADA ejecución de la CLI (primera llamada,
 * reintentos, continuaciones, QA, Gauntlet, encargos de análisis, consola), contra el registro duradero de ejecuciones
 * (`claude_code_runs`: cuentan también las fallidas y las interrumpidas por un reinicio). Quien llama hace la comprobación
 * y el registro de la ejecución en el MISMO tramo síncrono, así que dos llamadas concurrentes no pueden pasar a la vez el
 * mismo margen. Aplica el tope del proceso y, si el proceso es de un lote, también el del lote.
 */
export function callCapCheck(slug: string, processId: string | null): { ok: true } | { ok: false; detail: string } {
  if (!processId) return { ok: true };
  const proc = processesRepo(slug).get(processId); if (!proc) return { ok: true };
  const runs = claudeCodeRunsRepo(slug);
  const cap = proc.result?.pipeline?.config.maxSubscriptionCalls ?? proc.maxSubscriptionCalls ?? null;
  if (cap) {
    const used = runs.countForProcesses([processId]);
    if (used >= cap) return { ok: false, detail: `Se usaron las ${used} llamada(s) a la suscripción autorizadas para este proceso (tope ${cap}). No se ha llamado; lo hecho se conserva. Concede más llamadas al continuar si quieres seguir.` };
  }
  const batch = batchesRepo(slug).list().find(b => b.items.some(i => i.processIds.includes(processId)));
  if (batch && batch.auth.backends.includes('claude_code')) {
    const used = runs.countForProcesses(batch.items.flatMap(i => i.processIds));
    if (used >= batch.auth.maxSubscriptionCalls) return { ok: false, detail: `Se usaron las ${used} llamada(s) a la suscripción autorizadas para el lote «${batch.title}» (tope ${batch.auth.maxSubscriptionCalls}). No se ha llamado; lo hecho se conserva.` };
  }
  return { ok: true };
}

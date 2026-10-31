import type { BacklogItem, ExecutionResult, Process, ProposedChange } from '@portal-ia/domain';
import { backlogRepo, processesRepo } from '../db/workspace.ts';
import type { GuidanceOptions } from './guidance.ts';
import { listFeedback } from './manual-test-feedback.ts';
import { detectSandbox } from './sandbox.ts';
import { lastUpdate } from './system.ts';
import { isActiveJob } from './activeJobs.ts';
import { worktreeDrift } from './worktreeDrift.ts';
import { branchIntegration } from './storyIntegration.ts';
import { projectsRepo } from '../db/workspace.ts';

/**
 * Datos que necesita el recorrido guiado de un proceso de historia (sin IA, solo lectura): pasos con falla de la prueba,
 * sandbox disponible, reconstrucción fallida y número de iteración. Lo usan la ruta del proceso y el espacio de la historia.
 */
export async function flowOptions(slug: string, p: Process, item?: BacklogItem | null): Promise<GuidanceOptions> {
  if (p.kind !== 'story_execution') return {};
  const r = p.result;
  let failedStepDetails: GuidanceOptions['failedStepDetails'] = [];
  if (r?.manualTest) {
    const fb = listFeedback(slug, p.id); const byKey = new Map(fb.items.map(i => [i.stepKey, i]));
    failedStepDetails = fb.steps.map(s => ({ s, f: byKey.get(s.stepKey) })).filter(x => x.f?.result === 'fail').map(x => ({ index: x.s.index, text: x.s.text, comment: x.f!.comment }));
  }
  const sandbox = r?.applied && !r.merged ? (await detectSandbox().catch(() => null))?.available ?? null : null;
  const u = lastUpdate();
  const updateFailedLog = r?.merged && u?.status === 'failed' && u.finishedAt && u.finishedAt > r.merged.mergedAt ? u.log : null;
  const it = item ?? (p.backlogItemId ? backlogRepo(slug).get(p.backlogItemId) : null);
  // Número de iteración: solo los ids de la historia (antes se cargaban TODOS los procesos del proyecto por cada uno).
  const siblings = it ? processesRepo(slug).storyIterationIds(it.id) : [];
  const idx = siblings.indexOf(p.id);
  // «En ejecución» sin ejecución viva en este servidor: nada trabaja de verdad (no se muestra como actividad sana).
  const orphan = p.status === 'running' && !isActiveJob(p.id);
  // Solo para historias detenidas con worktree vivo: ¿alguien confirmó o cambió algo fuera del equipo? (git, sin IA)
  const pl = r?.pipeline;
  const drift = r && pl && (pl.state === 'paused' || pl.state === 'stopped') && p.status !== 'running' && !r.merged && !r.rejected ? await worktreeDrift(r) : null;
  // Integración con la rama principal (git en memoria, sin IA): ¿avanzó main?, ¿se combina limpio o hay conflictos reales?
  const repo = r?.applied && !r.merged && !r.rejected && p.status !== 'running' ? projectsRepo(slug).repository(p.projectId) : null;
  const integration = repo && r?.applied ? await branchIntegration(repo.path, r.applied.branch).catch(() => null) : null;
  return { failedStepDetails, sandbox, updateFailedLog, iteration: idx >= 0 ? { number: siblings.length - idx, total: siblings.length } : null, orphan, drift, integration };
}

/**
 * Resultado reducido para los listados: lo que muestran (estado del pipeline, aplicado, integrado, publicado, prueba
 * manual, para el propietario, archivos cambiados) sin diffs, contenidos, registros de verificación, plan ni eventos.
 */
export function slimResult(r: ExecutionResult | null | undefined): ExecutionResult | null {
  if (!r) return null;
  const { plan: _plan, consultations: _c, manifest: _m, repairs: _r, externalCorrections: _e, ...rest } = r;
  return {
    ...rest, plan: null,
    changes: (r.changes ?? []).map((c): ProposedChange => ({ ...c, content: null, diff: null })),
    verifications: (r.verifications ?? []).map(v => ({ ...v, output: '' })),
    pipeline: r.pipeline ? { ...r.pipeline, events: r.pipeline.events.slice(-3), failures: [] } : r.pipeline,
    gauntlet: r.gauntlet ? { ...r.gauntlet, rounds: [], planReview: r.gauntlet.planReview ? { ...r.gauntlet.planReview, rounds: [] } : r.gauntlet.planReview } : r.gauntlet,
    review: r.review ? { ...r.review, findings: [] } as ExecutionResult['review'] : null
  };
}

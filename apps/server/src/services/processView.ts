import type { BacklogItem, Process } from '@portal-ia/domain';
import { backlogRepo, processesRepo } from '../db/workspace.ts';
import type { GuidanceOptions } from './guidance.ts';
import { listFeedback } from './manual-test-feedback.ts';
import { detectSandbox } from './sandbox.ts';
import { lastUpdate } from './system.ts';

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
  const siblings = it ? processesRepo(slug).listAll(p.projectId).filter(x => x.backlogItemId === it.id && x.kind === 'story_execution') : [];
  const idx = siblings.findIndex(x => x.id === p.id);
  return { failedStepDetails, sandbox, updateFailedLog, iteration: idx >= 0 ? { number: siblings.length - idx, total: siblings.length } : null };
}

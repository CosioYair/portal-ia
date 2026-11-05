import type { BacklogItem, Process, StoryClosure } from '@portal-ia/domain';
import { backlogRepo, processesRepo } from '../db/workspace.ts';
import { InboxError } from './inboxError.ts';
import { iterationNumbers } from './inbox.ts';

/**
 * EN-005 · Guarda «historia cerrada». Un proceso antiguo de una historia no se puede reactivar (continuar, autorizar,
 * aceptar el plan, recuperar, reintentar, aplicar ni verificar) en estos casos:
 *  - otra iteración de la historia ya tiene result.merged y este proceso es anterior a ella;
 *  - la historia está completada o descartada y este proceso no es el vigente.
 * Para volver a trabajar en ella hay que usar «Reabrir la historia», que crea una iteración nueva. No tiene efectos y no usa IA.
 */

const byAge = (a: Process, b: Process) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const isStory = (p: Process) => p.kind === 'story_execution';

/** Iteración integrada más reciente de la historia (null si ninguna está integrada). */
export function latestMerged(processes: Process[]): Process | null {
  return [...processes].filter(p => isStory(p) && !!p.result?.merged).sort(byAge).at(-1) ?? null;
}

/** ¿`a` se creó después que `b`? (mismo orden que la numeración de iteraciones). */
export function isNewerThan(a: Process, b: Process): boolean {
  return byAge(a, b) > 0;
}

const label = (n: number | null | undefined) => (n == null ? '?' : String(n));

/**
 * Función pura. Devuelve el cierre que bloquea a `proc` dentro de la historia `item`, con todas sus iteraciones en
 * `processes`, o null si el proceso se puede usar. El propio proceso integrado nunca se bloquea, para que puedan
 * seguir publish y runtime-check.
 */
export function storyClosureOf(item: Pick<BacklogItem, 'status' | 'lastProcessId'>, processes: Process[], proc: Process): StoryClosure | null {
  if (!isStory(proc) || !proc.backlogItemId) return null;
  if (proc.result?.merged) return null;
  const all = processes.filter(isStory);
  if (!all.some(p => p.id === proc.id)) all.push(proc);
  const sorted = [...all].sort(byAge);
  const iters = iterationNumbers(sorted);
  const newest = sorted.at(-1)!;
  const merged = latestMerged(sorted);

  if (merged && !isNewerThan(proc, merged)) {
    const current = isNewerThan(newest, merged) ? newest : merged;
    const m = iters.get(merged.id) ?? null;
    const c = iters.get(current.id) ?? null;
    const message = current.id === merged.id
      ? `Esta historia ya está integrada (iteración ${label(m)}): el proceso vigente es ${merged.id}. Para volver a trabajar en ella usa «Reabrir la historia».`
      : `Esta historia ya está integrada (iteración ${label(m)}) y se reabrió: la iteración vigente es la ${label(c)} (proceso ${current.id}). Este proceso es antiguo y no se puede reactivar.`;
    return { state: 'merged', currentProcessId: current.id, iteration: m, currentIteration: c, message };
  }

  if (item.status === 'done' || item.status === 'discarded') {
    const last = item.lastProcessId ? sorted.find(p => p.id === item.lastProcessId) ?? null : null;
    const current = merged ?? last ?? newest;
    if (current.id === proc.id) return null;
    const n = iters.get(current.id) ?? null;
    const what = item.status === 'done' ? 'ya está completada' : 'está descartada';
    return {
      state: item.status,
      currentProcessId: current.id,
      iteration: n,
      currentIteration: n,
      message: `Esta historia ${what} (iteración ${label(n)}): el proceso vigente es ${current.id}. Para volver a trabajar en ella usa «Reabrir la historia».`
    };
  }
  return null;
}

/** Cierre de la historia de un proceso, leído de la base del espacio (null si no aplica o si el proceso se puede usar). */
export function storyClosureFor(slug: string, proc: Process): StoryClosure | null {
  if (!isStory(proc) || !proc.backlogItemId) return null;
  const item = backlogRepo(slug).get(proc.backlogItemId);
  if (!item) return null;
  return storyClosureOf(item, processesRepo(slug).listByBacklogItem(item.id), proc);
}

/** 409 con el cierre (la ruta lo traduce como InboxError y añade `closure` a la respuesta). */
export class StoryClosedError extends InboxError {
  closure: StoryClosure;
  code = 'story_closed';
  constructor(closure: StoryClosure) {
    super(409, closure.message);
    this.closure = closure;
  }
}

/** Lanza 409 si el proceso es antiguo y su historia está integrada o cerrada. Se llama antes de cualquier cambio de estado. */
export function assertStoryOpen(slug: string, proc: Process): void {
  const closure = storyClosureFor(slug, proc);
  if (closure) throw new StoryClosedError(closure);
}

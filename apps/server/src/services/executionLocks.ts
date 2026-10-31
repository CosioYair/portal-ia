import type { Process } from '@portal-ia/domain';
import { backlogRepo, processesRepo } from '../db/workspace.ts';

/**
 * Exclusión por HISTORIA (o encargo), no global. Antes, cualquier proceso en ejecución impedía autorizar o continuar
 * cualquier otro («Ya hay un proceso en ejecución»): una historia del lote bloqueaba la iteración de otra que no tenía
 * nada que ver. Ahora solo chocan las operaciones que comparten de verdad algo:
 * - la misma historia o encargo (su rama `portal-ia/hu-NNN` y su worktree): una sola operación a la vez;
 * - la rama principal y los worktrees: carril del repositorio (services/repoLock.ts);
 * - Claude Code: cola de llamadas con su máximo de ejecuciones a la vez (claudeCode/backend.ts, se ve «En cola»);
 * - reconstruir y reiniciar el Portal: nada en marcha (lo interrumpiría).
 * Además de mirar la base (`running`), una operación toma un «arriendo» en memoria DESDE que se comprueba: así no hay
 * hueco entre la comprobación y el cambio de estado aunque la ruta espere a git (dos clics, dos pestañas).
 */
type Lease = { owner: string; what: string; since: number };
const leases = new Map<string, Lease>();
const LEASE_TTL_MS = 45 * 60_000;

export function workKey(slug: string, p: Pick<Process, 'id' | 'backlogItemId' | 'assignmentId'>): string {
  return p.backlogItemId ? `${slug}:story:${p.backlogItemId}` : p.assignmentId ? `${slug}:assignment:${p.assignmentId}` : `${slug}:process:${p.id}`;
}

/** Nombre del trabajo para los mensajes («HU-175», «el encargo», «este proceso»). */
function workName(slug: string, p: Pick<Process, 'backlogItemId' | 'assignmentId'>): string {
  if (p.backlogItemId) { try { return backlogRepo(slug).get(p.backlogItemId)?.storyId ?? 'esta historia'; } catch { return 'esta historia'; } }
  return p.assignmentId ? 'este encargo' : 'este proceso';
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Otro proceso de la MISMA historia o encargo en ejecución (no cuenta el propio). */
export function sameWorkRunning(slug: string, p: Pick<Process, 'id' | 'backlogItemId' | 'assignmentId'>): Process | null {
  if (!p.backlogItemId && !p.assignmentId) return null;
  return processesRepo(slug).running().find(x => x.id !== p.id && ((p.backlogItemId && x.backlogItemId === p.backlogItemId) || (p.assignmentId && x.assignmentId === p.assignmentId))) ?? null;
}

/**
 * ¿Choca con algo? null = puede seguir. Mensaje concreto si otra operación de la misma historia está en curso (arriendo)
 * u otro proceso suyo está ejecutándose. Lo que haga OTRA historia nunca es motivo.
 */
export function workConflict(slug: string, p: Pick<Process, 'id' | 'backlogItemId' | 'assignmentId'>, owner?: string): string | null {
  let l = leases.get(workKey(slug, p));
  // Red de seguridad: un arriendo de más de 45 min es de una operación que ya no existe (nunca bloquea para siempre).
  if (l && Date.now() - l.since > LEASE_TTL_MS) { leases.delete(workKey(slug, p)); l = undefined; }
  if (l && l.owner !== owner) return `${cap(workName(slug, p))} tiene otra operación en curso (${l.what}). Espera a que termine; las demás historias siguen.`;
  const other = sameWorkRunning(slug, p);
  if (other) return `${cap(workName(slug, p))} ya tiene otro proceso en ejecución («${other.title}»). Espera a que termine o cancélalo; las demás historias no se ven afectadas.`;
  return null;
}

/** Toma el arriendo de la historia (o devuelve el motivo del choque). Hay que soltarlo siempre (finally). */
export function acquireWork(slug: string, p: Pick<Process, 'id' | 'backlogItemId' | 'assignmentId'>, owner: string, what: string): { release: () => void } | { conflict: string } {
  const conflict = workConflict(slug, p, owner);
  if (conflict) return { conflict };
  const key = workKey(slug, p);
  leases.set(key, { owner, what, since: Date.now() });
  return { release: () => { if (leases.get(key)?.owner === owner) leases.delete(key); } };
}

/** Pruebas y diagnóstico: arriendos vigentes. */
export function activeLeases(): { key: string; what: string; since: number }[] { return [...leases].map(([key, l]) => ({ key, what: l.what, since: l.since })); }

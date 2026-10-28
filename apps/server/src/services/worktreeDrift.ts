import fs from 'node:fs';
import type { ExecutionResult, WorktreeDrift } from '@portal-ia/domain';
import { git } from './repoWrite.ts';

/**
 * ¿El worktree de la historia sigue en el último commit que registró el pipeline? Si alguien confirmó algo desde fuera
 * (consola) o dejó cambios sin confirmar, continuar con la evidencia guardada pagaría una corrección contra código que ya
 * no existe (HU-155). Solo lectura: git rev-parse, status y diff.
 * - same: HEAD = último commit registrado · ahead: hay commits nuevos que continúan la rama (registrables)
 * - dirty: cambios sin confirmar en archivos rastreados · diverged: la rama ya no continúa el commit registrado
 */
export async function worktreeDrift(r: ExecutionResult | null | undefined): Promise<WorktreeDrift | null> {
  const wt = r?.applied?.worktree;
  if (!r?.applied || !wt || !fs.existsSync(wt)) return null;
  try {
    const head = await git(wt, ['rev-parse', 'HEAD']);
    const prev = await git(wt, ['rev-parse', `${r.applied.commit}^{commit}`]);
    const short = await git(wt, ['rev-parse', '--short', 'HEAD']);
    const dirty = (await git(wt, ['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean).map(l => l.slice(3).trim());
    if (dirty.length) return { state: 'dirty', head: short, recorded: r.applied.commit, files: dirty };
    if (head === prev) return { state: 'same', head: short, recorded: r.applied.commit, files: [] };
    const files = (await git(wt, ['diff', '--name-only', prev, head])).split('\n').filter(Boolean);
    const ahead = await git(wt, ['merge-base', '--is-ancestor', prev, head]).then(() => true, () => false);
    return { state: ahead ? 'ahead' : 'diverged', head: short, recorded: r.applied.commit, files };
  } catch { return null; }
}

/** Explicación para el propietario (y motivo de la pausa) cuando el worktree no está en el commit registrado. */
export function driftMessage(d: WorktreeDrift): string {
  if (d.state === 'ahead') return `El worktree tiene commits que el equipo no hizo (${d.head} sobre ${d.recorded}; ${d.files.length} archivo(s): ${d.files.slice(0, 6).join(', ')}). Antes de continuar, regístralo como corrección externa: se verifica en el sandbox sin IA y no se paga una corrección con evidencia de un código que ya cambió.`;
  if (d.state === 'dirty') return `El worktree tiene cambios sin confirmar (${d.files.slice(0, 6).join(', ')}). Confírmalos en un commit y regístralo como corrección externa, o descártalos tú; el equipo no continúa sobre un estado sin registrar.`;
  if (d.state === 'diverged') return `La rama del worktree ya no continúa el último commit registrado (${d.recorded}; ahora ${d.head}): su historia se reescribió. No se continúa ni se registra: revisa la rama.`;
  return '';
}

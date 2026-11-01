import fs from 'node:fs';
import path from 'node:path';
import type { BatchStack } from '@portal-ia/domain';
import { processesRepo, projectsRepo } from '../db/workspace.ts';
import { withRepoLock } from './repoLock.ts';
import { git, repoRoot, worktreePathFor } from './repoWrite.ts';
import { updateResult } from './storyPipeline.ts';

/**
 * Preparación APILADA de una historia (lote con integración al aceptar): trabaja sobre la versión verificada y revisada de su
 * dependencia, aún sin integrar. Antes de cualquier llamada se crea su worktree SIN rama (desacoplado) en el commit de la
 * dependencia, para que el plan, las consultas y el Desarrollador lean ese código; la rama de la historia nace de ese commit
 * en su primer commit (applyChanges con `base`). Nunca toca main ni la rama de la dependencia.
 */
const fail = (message: string, code: string) => Object.assign(new Error(message), { code, statusCode: 409 });

/**
 * Comprueba con git (en el carril del repositorio) que la dependencia sigue en el commit elegido y que la rama propia de la
 * historia no existe (si existiera, applyChanges la reutilizaría con otra base), y prepara el worktree. Devuelve el commit
 * completo. Si algo no cuadra, no se crea nada (y no se ha llamado a la IA).
 */
export async function prepareStackedBase(slug: string, processId: string, stack: Pick<BatchStack, 'storyId' | 'commit' | 'branch'>, storyId: string): Promise<string> {
  const p = processesRepo(slug).get(processId); if (!p) throw fail('el proceso no existe', 'not_found');
  const repo = projectsRepo(slug).repository(p.projectId); if (!repo) throw fail('el proyecto no tiene repositorio registrado', 'no_repo');
  const root = repoRoot(repo.path); const own = `portal-ia/${storyId.toLowerCase()}`;
  return withRepoLock(root, async () => {
    if ((await git(root, ['branch', '--list', own])).trim()) throw fail(`ya existe la rama ${own} de una ejecución anterior y no se reutiliza sobre otra base`, 'branch_exists');
    const head = await git(root, ['rev-parse', '--verify', '-q', `${stack.branch}^{commit}`]).catch(() => '');
    if (!head || !head.startsWith(stack.commit.slice(0, 7))) throw fail(`${stack.storyId} cambió desde que se eligió su versión (${stack.commit.slice(0, 7)} → ${head ? head.slice(0, 7) : 'sin rama'})`, 'stack_moved');
    const wt = worktreePathFor(root, processId);
    if (fs.existsSync(wt)) { await git(root, ['worktree', 'remove', '--force', wt]).catch(() => ''); }
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    await git(root, ['worktree', 'add', '-q', '--detach', wt, head]);
    updateResult(slug, processId, r => ({ ...r, stack: { storyId: stack.storyId, commit: head, branch: stack.branch, worktree: wt, at: new Date().toISOString() }, baseCommit: head }));
    return head;
  });
}

/**
 * Antes de ejecutar o retomar una historia apilada: su worktree preparado existe (si un fallo o un reinicio lo retiró antes de
 * su primer commit, se vuelve a crear en el mismo commit) y, si ya tiene rama, la rama contiene la versión provisional. Si no,
 * se detiene SIN llamar a la IA: trabajar sobre main (sin el código de la dependencia) reescribiría su código a ciegas.
 */
export async function ensureStackWorktree(slug: string, processId: string): Promise<void> {
  const p = processesRepo(slug).get(processId); const r = p?.result; const st = r?.stack;
  if (!p || !st) return;
  const repo = projectsRepo(slug).repository(p.projectId); if (!repo) throw fail('el proyecto no tiene repositorio registrado', 'no_repo');
  const root = repoRoot(repo.path);
  if (r.applied?.branch) {
    const ok = await git(root, ['merge-base', '--is-ancestor', st.commit, r.applied.branch]).then(() => true).catch(() => false);
    if (!ok) throw fail(`la rama ${r.applied.branch} ya no contiene la versión de ${st.storyId} sobre la que se preparó (${st.commit.slice(0, 7)})`, 'stack_lost');
    return;
  }
  if (st.worktree && fs.existsSync(st.worktree)) return;
  await withRepoLock(root, async () => {
    const wt = st.worktree ?? worktreePathFor(root, processId);
    if (fs.existsSync(wt)) return;
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    // --force: la carpeta pudo quedar registrada sin existir (se borró a mano o un fallo la retiró); no se poda nada más.
    await git(root, ['worktree', 'add', '-q', '--force', '--detach', wt, st.commit]);
    updateResult(slug, processId, x => ({ ...x, stack: { ...x.stack!, worktree: wt } }));
  });
}

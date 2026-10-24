import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

// HU-011 · Worktree aislado por proceso.
// Cada proceso trabaja en su propio `git worktree` (rama efímera proc/<id>) creado desde main actualizado
// y eliminado siempre al terminar. Solo usa git vía execFile (sin shell) y no añade dependencias.

export type WorktreeErrorCode =
  | 'INVALID_PROCESS_ID'
  | 'PATH_OUTSIDE_WORKTREES_DIR'
  | 'PATH_EXISTS'
  | 'BRANCH_EXISTS'
  | 'BASE_NOT_FOUND'
  | 'FETCH_FAILED'
  | 'GIT_FAILED';

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  readonly stderr: string;
  constructor(code: WorktreeErrorCode, message: string, stderr = '') {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
    this.stderr = stderr;
  }
}

export interface WorktreeOptions {
  /** Directorio que contiene los worktrees (fuera del repositorio). Por defecto config.worktreesDir. */
  worktreesDir?: string;
  /** Rama principal de la que parte cada proceso. Por defecto config.mainBranch. */
  mainBranch?: string;
}

export interface ProcessWorktree {
  path: string;
  branch: string;
  baseCommit: string;
}

const PROCESS_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Ejecuta git sin shell. Rechaza con WorktreeError('GIT_FAILED') si el código de salida no es 0. */
export function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim();
          reject(new WorktreeError('GIT_FAILED', `git ${args.join(' ')} falló: ${detail.slice(0, 500)}`, String(stderr)));
          return;
        }
        resolve(String(stdout).trim());
      }
    );
  });
}

function assertValidProcessId(processId: string): void {
  if (typeof processId !== 'string' || !PROCESS_ID_RE.test(processId)) {
    throw new WorktreeError('INVALID_PROCESS_ID', 'El identificador del proceso no es válido: solo letras, números, «_» y «-» (máximo 64 caracteres).');
  }
}

function resolveWorktreePath(worktreesDir: string, processId: string): string {
  assertValidProcessId(processId);
  const base = path.resolve(worktreesDir);
  const target = path.resolve(base, processId);
  if (path.dirname(target) !== base) {
    throw new WorktreeError('PATH_OUTSIDE_WORKTREES_DIR', 'La ruta del worktree queda fuera del directorio de worktrees configurado.');
  }
  return target;
}

function settings(opts: WorktreeOptions): { worktreesDir: string; mainBranch: string } {
  return { worktreesDir: opts.worktreesDir ?? config.worktreesDir, mainBranch: opts.mainBranch ?? config.mainBranch };
}

export const worktreeBranchName = (processId: string): string => `proc/${processId}`;

// Cola por repositorio: evita conflictos de index.lock entre procesos concurrentes (válido para un único servidor).
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoRoot);
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ['show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Crea el worktree del proceso desde main actualizado: fetch de origin/main si existe el remoto «origin»;
 * si no hay remoto, usa la rama main local. Si hay remoto y el fetch falla, no se continúa con una base obsoleta.
 */
export async function createProcessWorktree(repoRoot: string, processId: string, opts: WorktreeOptions = {}): Promise<ProcessWorktree> {
  const { worktreesDir, mainBranch } = settings(opts);
  const wtPath = resolveWorktreePath(worktreesDir, processId); // valida antes de ejecutar git
  const branch = worktreeBranchName(processId);

  return serialize(repoRoot, async () => {
    if (fs.existsSync(wtPath)) {
      throw new WorktreeError('PATH_EXISTS', `Ya existe la carpeta del worktree del proceso «${processId}».`);
    }
    if (await refExists(repoRoot, `refs/heads/${branch}`)) {
      throw new WorktreeError('BRANCH_EXISTS', `Ya existe la rama «${branch}».`);
    }

    const remotes = (await runGit(repoRoot, ['remote'])).split(/\r?\n/).map(s => s.trim());
    let baseRef: string;
    if (remotes.includes('origin')) {
      try {
        await runGit(repoRoot, ['fetch', 'origin', `+refs/heads/${mainBranch}:refs/remotes/origin/${mainBranch}`]);
      } catch (e) {
        throw new WorktreeError('FETCH_FAILED', `No se pudo actualizar origin/${mainBranch}; no se crea el worktree sobre una base posiblemente obsoleta. ${(e as Error).message}`, (e as WorktreeError).stderr ?? '');
      }
      baseRef = `refs/remotes/origin/${mainBranch}`;
    } else {
      baseRef = `refs/heads/${mainBranch}`;
    }
    if (!(await refExists(repoRoot, baseRef))) {
      throw new WorktreeError('BASE_NOT_FOUND', `No existe la referencia base «${baseRef}» en el repositorio.`);
    }

    const baseCommit = await runGit(repoRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
    fs.mkdirSync(path.resolve(worktreesDir), { recursive: true });
    await runGit(repoRoot, ['worktree', 'add', '-q', '-b', branch, wtPath, baseCommit]);
    return { path: wtPath, branch, baseCommit };
  });
}

/** Elimina worktree, carpeta y rama efímera del proceso. Idempotente: no falla si ya no existen. */
export async function removeProcessWorktree(repoRoot: string, processId: string, opts: WorktreeOptions = {}): Promise<void> {
  const { worktreesDir } = settings(opts);
  const wtPath = resolveWorktreePath(worktreesDir, processId); // valida antes de ejecutar git
  const branch = worktreeBranchName(processId);

  await serialize(repoRoot, async () => {
    try {
      await runGit(repoRoot, ['worktree', 'remove', '--force', wtPath]);
    } catch {
      // No registrado o ya borrado: se limpia lo que quede abajo.
    }
    fs.rmSync(wtPath, { recursive: true, force: true }); // wtPath está validado dentro de worktreesDir
    await runGit(repoRoot, ['worktree', 'prune']);
    if (await refExists(repoRoot, `refs/heads/${branch}`)) {
      await runGit(repoRoot, ['branch', '-D', branch]);
    }
  });
}

/**
 * Ejecuta `fn` dentro del worktree del proceso y lo elimina siempre al terminar
 * (éxito, fallo o cancelación). Si `fn` falla, su error prevalece sobre uno de limpieza.
 */
export async function withProcessWorktree<T>(
  repoRoot: string,
  processId: string,
  fn: (worktree: ProcessWorktree) => Promise<T>,
  opts: WorktreeOptions = {}
): Promise<T> {
  const worktree = await createProcessWorktree(repoRoot, processId, opts);
  let result: T;
  try {
    result = await fn(worktree);
  } catch (e) {
    await removeProcessWorktree(repoRoot, processId, opts).catch(() => { /* prevalece el error original */ });
    throw e;
  }
  await removeProcessWorktree(repoRoot, processId, opts);
  return result;
}

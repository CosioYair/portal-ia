// Guardas de rama para Integrar (HU-143). Sin dependencias de config ni de base de datos:
// funciones puras (evaluateIntegration, translatePushError) y comprobaciones git de solo lectura,
// más la publicación con refspec explícito.
import { execFile } from 'node:child_process';
import type { GitActionableError, IntegrationStatus } from '@portal-ia/domain';

export interface GitResult { code: number; stdout: string; stderr: string; }

/** Ejecuta git sin shell, con LC_ALL=C para que los mensajes de error sean estables. */
export function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return new Promise(resolve => {
    execFile(
      'git', args,
      { cwd, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        const raw = (err as { code?: unknown }).code;
        resolve({ code: typeof raw === 'number' ? raw : -1, stdout: String(stdout ?? ''), stderr: String(stderr || err.message) });
      }
    );
  });
}

/** Nombre de rama aceptable: sin guion inicial, sin «..», sin espacios ni caracteres de control. */
export function isSafeBranchName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock');
}

export interface HeadState { isRepo: boolean; branch: string | null; }

/**
 * Estado de HEAD. Usa symbolic-ref (funciona también en repositorios sin commits):
 * branch = null cuando HEAD está desacoplado.
 */
export async function getHeadState(cwd: string): Promise<HeadState> {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { isRepo: false, branch: null };
  const head = await runGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const name = head.stdout.trim();
  return { isRepo: true, branch: head.code === 0 && name ? name : null };
}

/** Rama activa, o null si HEAD está desacoplado (o la carpeta no es un repositorio). */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  return (await getHeadState(cwd)).branch;
}

/** ¿Existe la rama local? (git show-ref --verify --quiet refs/heads/<rama>) */
export async function localBranchExists(cwd: string, branch: string): Promise<boolean> {
  if (!isSafeBranchName(branch)) return false;
  const r = await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.code === 0;
}

/** Decide si se puede integrar. Pura: no toca git. */
export function evaluateIntegration(input: { currentBranch: string | null; mainBranch: string; isRepo?: boolean }): IntegrationStatus {
  const { currentBranch, mainBranch } = input;
  const isRepo = input.isRepo ?? true;
  if (!isRepo) {
    return {
      currentBranch: null, mainBranch, canIntegrate: false, reasonCode: 'NOT_A_REPO',
      reason: `La carpeta del Portal no es un repositorio git. Integrar solo opera sobre la rama «${mainBranch}» de un repositorio.`
    };
  }
  if (currentBranch === null) {
    return {
      currentBranch: null, mainBranch, canIntegrate: false, reasonCode: 'DETACHED_HEAD',
      reason: `La carpeta del Portal está en HEAD desacoplado (sin rama activa). Integrar solo opera sobre «${mainBranch}». Cambia con git switch ${mainBranch} y vuelve a intentarlo.`
    };
  }
  if (currentBranch !== mainBranch) {
    return {
      currentBranch, mainBranch, canIntegrate: false, reasonCode: 'NOT_ON_MAIN',
      reason: `La carpeta del Portal está en la rama «${currentBranch}». Integrar solo opera sobre «${mainBranch}». Cambia a ${mainBranch} con git switch ${mainBranch} y vuelve a intentarlo.`
    };
  }
  return { currentBranch, mainBranch, canIntegrate: true };
}

/** Traduce el stderr de git push a una causa y una solución legibles. Pura. */
export function translatePushError(stderr: string, branch: string): GitActionableError {
  const text = String(stderr ?? '');
  const m = text.match(/src refspec\s+(\S+)\s+does not match any/i);
  if (m) {
    const name = (m[1] ?? branch).replace(/^refs\/heads\//, '');
    return {
      code: 'LOCAL_BRANCH_MISSING',
      cause: `La rama local «${name}» no existe en esta carpeta, así que no hay nada que publicar.`,
      solution: `Crea o recupera la rama con git switch -c ${name} origin/${name} o git fetch origin ${name}:${name} y reintenta.`
    };
  }
  const trimmed = text.trim();
  const detail = trimmed ? (trimmed.length > 400 ? `…${trimmed.slice(-400)}` : trimmed) : 'sin detalle';
  return {
    code: 'PUSH_FAILED',
    cause: `git push no pudo publicar «${branch}». Detalle de git: ${detail}`,
    solution: 'Revisa que el remoto sea accesible y que tus credenciales sean válidas, y vuelve a intentarlo.'
  };
}

export type PublishResult =
  | { ok: true; remote: string }
  | { ok: false; error: GitActionableError };

type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;

/**
 * Publica la rama principal. Antes del push verifica que la rama local existe (git show-ref)
 * y usa un refspec explícito refs/heads/<rama>:refs/heads/<rama>.
 */
export async function publishMain(cwd: string, mainBranch: string, run: GitRunner = runGit): Promise<PublishResult> {
  const exists = isSafeBranchName(mainBranch)
    && (await run(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${mainBranch}`])).code === 0;
  if (!exists) {
    return { ok: false, error: translatePushError(`error: src refspec ${mainBranch} does not match any`, mainBranch) };
  }
  const remotes = (await run(cwd, ['remote'])).stdout.split('\n').map(s => s.trim()).filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) {
    return {
      ok: false,
      error: {
        code: 'NO_REMOTE',
        cause: 'Esta carpeta no tiene un remoto configurado, así que no se puede publicar.',
        solution: 'Añade el remoto con git remote add origin <url> y vuelve a intentarlo.'
      }
    };
  }
  const push = await run(cwd, ['push', remote, `refs/heads/${mainBranch}:refs/heads/${mainBranch}`]);
  if (push.code !== 0) return { ok: false, error: translatePushError(push.stderr, mainBranch) };
  return { ok: true, remote };
}

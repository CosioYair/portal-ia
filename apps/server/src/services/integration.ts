// Integración siempre contra la rama principal configurada (HU-143).
// La rama destino sale de config.mainBranch; la rama activa solo se usa para decidir si se puede integrar.
import type { IntegrationStatus } from '@portal-ia/domain';
import { REPO_ROOT, config } from '../config.ts';
import { evaluateIntegration, getHeadState, isSafeBranchName, localBranchExists, publishMain, runGit } from './git-branch-guard.ts';

export interface IntegrationErrorBody {
  code: string;
  /** Motivo del bloqueo (antes de tocar nada). */
  reason?: string;
  /** Causa de un fallo de git (merge o push). */
  cause?: string;
  solution?: string;
  /** Si el merge local ya se hizo pero la publicación falló. */
  mergedCommit?: string;
}

/** Error tipado: la ruta lo traduce a 409 con este cuerpo. */
export class IntegrationError extends Error {
  readonly status = 409;
  readonly body: IntegrationErrorBody;
  constructor(body: IntegrationErrorBody) {
    super(body.reason ?? body.cause ?? body.code);
    this.name = 'IntegrationError';
    this.body = body;
  }
}

export interface IntegrationOptions {
  /** Rama a integrar en la principal. */
  sourceBranch: string;
  /** Carpeta del Portal (por defecto, la raíz del repositorio). */
  cwd?: string;
  /** Rama principal (por defecto config.mainBranch). */
  mainBranch?: string;
}

export interface IntegrationResult { into: string; commit: string; remote: string; published: true; }

/** Estado de la carpeta del Portal: se revalida siempre; el servidor no confía en la UI. */
export async function getIntegrationStatus(cwd: string = REPO_ROOT, mainBranch: string = config.mainBranch): Promise<IntegrationStatus> {
  const head = await getHeadState(cwd);
  return evaluateIntegration({ currentBranch: head.branch, mainBranch, isRepo: head.isRepo });
}

export async function integrateIntoMain(opts: IntegrationOptions): Promise<IntegrationResult> {
  const cwd = opts.cwd ?? REPO_ROOT;
  const mainBranch = opts.mainBranch ?? config.mainBranch;
  const source = opts.sourceBranch;

  // 1) Bloqueo previo: ningún comando de escritura se ejecuta si no estamos en main.
  const status = await getIntegrationStatus(cwd, mainBranch);
  if (!status.canIntegrate) {
    throw new IntegrationError({ code: status.reasonCode ?? 'BLOCKED', reason: status.reason ?? 'La integración no está disponible.' });
  }

  // 2) Validación de la rama de origen.
  if (!isSafeBranchName(source)) {
    throw new IntegrationError({ code: 'INVALID_SOURCE', reason: `El nombre de rama «${source}» no es válido.` });
  }
  if (source === mainBranch) {
    throw new IntegrationError({ code: 'SOURCE_IS_MAIN', reason: `La rama a integrar no puede ser la propia «${mainBranch}».` });
  }
  if (!(await localBranchExists(cwd, source))) {
    throw new IntegrationError({ code: 'SOURCE_NOT_FOUND', reason: `La rama «${source}» no existe en esta carpeta.` });
  }

  // 3) Merge en main (estamos en main: lo garantiza el bloqueo previo).
  const merge = await runGit(cwd, ['merge', '--no-ff', '--no-edit', '-m', `Integra ${source} en ${mainBranch}`, source]);
  if (merge.code !== 0) {
    await runGit(cwd, ['merge', '--abort']);
    const detail = (merge.stderr || merge.stdout).trim().slice(-400) || 'sin detalle';
    throw new IntegrationError({
      code: 'MERGE_FAILED',
      cause: `git no pudo integrar «${source}» en «${mainBranch}». Detalle de git: ${detail}`,
      solution: 'Resuelve los conflictos en una rama de trabajo (actualízala con main) y vuelve a intentarlo. No se ha modificado main.'
    });
  }
  const commit = (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();

  // 4) Publicación: verifica la rama local y usa refspec explícito.
  const pub = await publishMain(cwd, mainBranch);
  if (!pub.ok) {
    throw new IntegrationError({ code: pub.error.code, cause: pub.error.cause, solution: pub.error.solution, mergedCommit: commit });
  }
  return { into: mainBranch, commit, remote: pub.remote, published: true };
}

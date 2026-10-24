// Comprobación previa a toda ejecución de una historia (HU-129). Reúne hechos de git (solo
// lectura; el único efecto es actualizar la referencia local origin/main) y delega la decisión
// en el dominio. Nunca lanza: cualquier fallo o timeout se traduce en «indeterminado» y bloquea.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  evaluateExecutionPreflight,
  isFullGitSha,
  parseRemoteDefaultBranch,
  type ExecutionPreflightEvaluation
} from '@portal/domain';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;

export interface ExecutionPreflightOptions {
  /** Raíz del repositorio desde el que corre el Portal (por defecto, process.cwd()). */
  readonly cwd?: string;
  /** Timeout de cada comando de git, en milisegundos. */
  readonly timeoutMs?: number;
}

export interface ExecutionPreflightService {
  run(): Promise<ExecutionPreflightEvaluation>;
}

/** Ejecuta git y devuelve la salida estándar recortada, o null si falla o supera el timeout. */
async function git(cwd: string, args: readonly string[], timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function asSha(output: string | null): string | null {
  return output !== null && isFullGitSha(output) ? output : null;
}

export function createExecutionPreflightService(
  options: ExecutionPreflightOptions = {}
): ExecutionPreflightService {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async run(): Promise<ExecutionPreflightEvaluation> {
      const branchOutput = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs);
      // «HEAD» es lo que devuelve git con HEAD desacoplado: no hay rama.
      const currentBranch =
        branchOutput === null || branchOutput === '' || branchOutput === 'HEAD' ? null : branchOutput;
      const headSha = asSha(await git(cwd, ['rev-parse', 'HEAD'], timeoutMs));

      // Si el fetch falla no se puede afirmar que origin/main esté al día: queda indeterminado.
      const fetched = await git(cwd, ['fetch', 'origin', 'main'], timeoutMs);
      const originMainSha =
        fetched === null ? null : asSha(await git(cwd, ['rev-parse', 'refs/remotes/origin/main'], timeoutMs));

      // ls-remote consulta al remoto en vivo: no depende de origin/HEAD, que puede estar obsoleto.
      const lsRemote = await git(cwd, ['ls-remote', '--symref', 'origin', 'HEAD'], timeoutMs);
      const remoteDefaultBranch = lsRemote === null ? null : parseRemoteDefaultBranch(lsRemote);

      return evaluateExecutionPreflight({ currentBranch, headSha, originMainSha, remoteDefaultBranch });
    }
  };
}

export type EjecucionProtegida<T> =
  | { readonly iniciada: true; readonly preflight: ExecutionPreflightEvaluation; readonly valor: T }
  | { readonly iniciada: false; readonly preflight: ExecutionPreflightEvaluation };

/**
 * Punto de entrada que deben usar los arranques de historia: ejecuta el preflight y SOLO si es
 * correcto invoca «iniciar» (reserva de presupuesto, llamada a complete(), registro de consumo).
 * Si falla, «iniciar» no se llama y el llamador debe pasar la historia a «detenido» con el motivo.
 */
export async function ejecutarTrasPreflight<T>(
  service: Pick<ExecutionPreflightService, 'run'>,
  iniciar: () => Promise<T>
): Promise<EjecucionProtegida<T>> {
  const preflight = await service.run();
  if (!preflight.ok) return { iniciada: false, preflight };
  return { iniciada: true, preflight, valor: await iniciar() };
}

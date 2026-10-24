// Estado de sincronización del repositorio del Portal y aviso de reinicio.
// Solo lee referencias locales de git con execFile (sin shell, sin fetch, sin red, sin coste).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PortalSyncStatus, RestartNotice } from '@portal/contracts';
import { classifyChangeImpact, describeChangedAreas, extractStoryIds } from '@portal/domain';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_MS = 5_000;

const MAIN_REF = 'refs/heads/main';
const REMOTE_MAIN_REF = 'refs/remotes/origin/main';

/** Ejecuta git con argumentos fijos (sin shell) y devuelve la salida estándar sin espacios sobrantes. */
export async function runGit(repoPath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd: repoPath,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  });
  return stdout.trim();
}

/** Igual que runGit, pero devuelve null si git falla. */
export async function tryGit(repoPath: string, args: readonly string[]): Promise<string | null> {
  try {
    return await runGit(repoPath, args);
  } catch {
    return null;
  }
}

/** Para comandos que responden con el código de salida (p. ej. merge-base --is-ancestor): 0 es true, 1 es false, otro código es un fallo. */
export async function gitSucceeds(repoPath: string, args: readonly string[]): Promise<boolean> {
  try {
    await runGit(repoPath, args);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
      return false;
    }
    throw error;
  }
}

/** Resuelve una referencia a un SHA de commit, o null si no existe. */
export function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
  return tryGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/** Cuenta los commits exclusivos de cada lado: [solo en a, solo en b]. */
export async function countLeftRight(
  repoPath: string,
  a: string,
  b: string
): Promise<readonly [number, number]> {
  const output = await runGit(repoPath, ['rev-list', '--left-right', '--count', `${a}...${b}`]);
  const [left, right] = output.split(/\s+/).map((part) => Number(part));
  return [Number.isFinite(left) ? (left ?? 0) : 0, Number.isFinite(right) ? (right ?? 0) : 0];
}

export interface PortalSyncPort {
  getSyncStatus(): Promise<PortalSyncStatus>;
  getRestartNotice(): Promise<RestartNotice>;
}

export interface PortalSyncService extends PortalSyncPort {
  /** HEAD del repositorio cuando arrancó el servidor. */
  readonly bootHeadSha: string;
  /** Descarta la caché breve (úsese tras aplicar o publicar cambios). */
  invalidate(): void;
}

export interface PortalSyncOptions {
  readonly repoPath: string;
  /** Duración de la caché en milisegundos (0 la desactiva). Por defecto 5 s. */
  readonly cacheMs?: number;
  readonly now?: () => Date;
}

async function computeStatus(repoPath: string, now: () => Date): Promise<PortalSyncStatus> {
  const [abbrev, headSha, mainSha, remoteMainSha] = await Promise.all([
    runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(repoPath, ['rev-parse', 'HEAD']),
    resolveCommit(repoPath, MAIN_REF),
    resolveCommit(repoPath, REMOTE_MAIN_REF)
  ]);
  const detached = abbrev === 'HEAD';

  const [aheadOfMain, behindMain] =
    mainSha === null ? [0, 0] : await countLeftRight(repoPath, 'HEAD', MAIN_REF);
  const [remoteAhead, remoteBehind] =
    mainSha !== null && remoteMainSha !== null
      ? await countLeftRight(repoPath, MAIN_REF, REMOTE_MAIN_REF)
      : [0, 0];

  return {
    activeBranch: detached ? null : abbrev,
    detached,
    headSha,
    mainSha,
    branchMatchesMain: mainSha !== null && headSha === mainSha,
    aheadOfMain,
    behindMain,
    remote: {
      tracked: remoteMainSha !== null,
      remoteMainSha,
      // Publicado: main local está completamente contenida en la última referencia conocida de origin/main.
      published: mainSha !== null && remoteMainSha !== null && remoteAhead === 0,
      ahead: remoteAhead,
      behind: remoteBehind
    },
    checkedAt: now().toISOString()
  };
}

async function computeNotice(repoPath: string, bootHeadSha: string): Promise<RestartNotice> {
  const currentHeadSha = await runGit(repoPath, ['rev-parse', 'HEAD']);
  if (currentHeadSha === bootHeadSha) {
    return { action: 'none', affectedStories: [], changedAreas: [], bootHeadSha, currentHeadSha };
  }
  const range = `${bootHeadSha}..${currentHeadSha}`;
  const [files, log] = await Promise.all([
    runGit(repoPath, ['-c', 'core.quotepath=false', 'diff', '--name-only', range]),
    runGit(repoPath, ['log', '--format=%B%x1e', range])
  ]);
  const paths = files.split('\n').filter((line) => line.length > 0);
  const messages = log
    .split('\x1e')
    .map((message) => message.trim())
    .filter((message) => message.length > 0);
  return {
    action: classifyChangeImpact(paths),
    affectedStories: extractStoryIds(messages),
    changedAreas: describeChangedAreas(paths),
    bootHeadSha,
    currentHeadSha
  };
}

interface CacheSlot<T> {
  get(): Promise<T>;
  clear(): void;
}

function cacheSlot<T>(ttlMs: number, load: () => Promise<T>): CacheSlot<T> {
  let entry: { readonly at: number; readonly value: Promise<T> } | null = null;
  return {
    get() {
      const nowMs = Date.now();
      if (ttlMs > 0 && entry !== null && nowMs - entry.at < ttlMs) return entry.value;
      const value = load();
      const created = { at: nowMs, value };
      entry = created;
      // Un fallo no se cachea: el siguiente sondeo vuelve a intentarlo.
      value.catch(() => {
        if (entry === created) entry = null;
      });
      return value;
    },
    clear() {
      entry = null;
    }
  };
}

/**
 * Crea el servicio y registra el HEAD de arranque. Lanza si el directorio no es un repositorio git
 * con al menos un commit.
 * Nota: si el servidor corre con recarga en caliente, este HEAD se reinicia con cada recarga.
 */
export async function createPortalSyncService(options: PortalSyncOptions): Promise<PortalSyncService> {
  const { repoPath } = options;
  const ttl = options.cacheMs ?? DEFAULT_CACHE_MS;
  const now = options.now ?? (() => new Date());
  const bootHeadSha = await runGit(repoPath, ['rev-parse', 'HEAD']);

  const status = cacheSlot(ttl, () => computeStatus(repoPath, now));
  const notice = cacheSlot(ttl, () => computeNotice(repoPath, bootHeadSha));

  return {
    bootHeadSha,
    getSyncStatus: () => status.get(),
    getRestartNotice: () => notice.get(),
    invalidate() {
      status.clear();
      notice.clear();
    }
  };
}

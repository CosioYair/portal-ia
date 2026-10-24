// Servicio de cierre de historias: obtiene los hechos de git (solo lectura, sin red) y aplica la
// regla pura del dominio. Nunca hace fetch ni push. Si git falla, el cierre queda bloqueado.

import { execFile } from 'node:child_process';
import { evaluateStoryClosure, isValidBranchName, redactCredentials } from '@portal/domain';
import type { StoryWorkState } from '@portal/domain';
import type { StoryClosureStatus } from '@portal/contracts';

export interface StoryRecord {
  readonly id: string;
  readonly projectId: string;
  readonly workState: StoryWorkState;
  /** Cambios aplicados en local (se usa en proyectos sin repositorio). */
  readonly appliedLocally: boolean;
  readonly completed: boolean;
  /** Rama de trabajo de la historia, si existe. */
  readonly branch: string | null;
  /** Commit de la historia registrado (respaldo si la rama se borró tras fusionarla). */
  readonly mergedCommit: string | null;
}

export interface RepositoryRecord {
  readonly path: string;
  /** Rama principal registrada; si falta se detecta (origin/HEAD, main, master). */
  readonly mainBranch?: string | null;
}

/** Puertos que el servicio necesita; la persistencia (SQLite por espacio) los implementa. */
export interface StoryClosureContext {
  getStory(storyId: string): Promise<StoryRecord | null>;
  getRepository(projectId: string): Promise<RepositoryRecord | null>;
  markStoryCompleted(storyId: string): Promise<void>;
}

export class StoryNotFoundError extends Error {
  constructor(storyId: string) {
    super(`No existe la historia ${storyId}`);
    this.name = 'StoryNotFoundError';
  }
}

class GitCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitCheckError';
  }
}

type GitOutcome =
  | { readonly kind: 'ok'; readonly stdout: string }
  | { readonly kind: 'exit'; readonly code: number; readonly stderr: string }
  | { readonly kind: 'error'; readonly message: string };

const GIT_TIMEOUT_MS = 10_000;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function runGit(cwd: string, args: readonly string[]): Promise<GitOutcome> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ kind: 'ok', stdout });
        } else if (typeof error.code === 'number') {
          resolve({ kind: 'exit', code: error.code, stderr });
        } else {
          resolve({ kind: 'error', message: error.message });
        }
      }
    );
  });
}

function unexpected(command: string, outcome: GitOutcome): GitCheckError {
  const detail =
    outcome.kind === 'exit'
      ? `código ${outcome.code}: ${outcome.stderr.trim().split('\n')[0] ?? ''}`
      : outcome.kind === 'error'
        ? outcome.message
        : 'respuesta inesperada';
  return new GitCheckError(`git ${command} falló (${detail})`);
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const out = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', ref]);
  if (out.kind === 'ok') return true;
  if (out.kind === 'exit' && out.code === 1) return false;
  throw unexpected('rev-parse', out);
}

async function revParseCommit(repoPath: string, ref: string): Promise<string | null> {
  const out = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (out.kind === 'ok') return out.stdout.trim();
  if (out.kind === 'exit' && out.code === 1) return null;
  throw unexpected('rev-parse', out);
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  const out = await runGit(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (out.kind === 'ok') return true;
  if (out.kind === 'exit' && out.code === 1) return false;
  throw unexpected('merge-base', out);
}

async function detectMainBranch(repo: RepositoryRecord): Promise<string> {
  const candidates: string[] = [];
  if (repo.mainBranch) candidates.push(repo.mainBranch);
  const head = await runGit(repo.path, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.kind === 'ok') {
    const name = head.stdout.trim().replace(/^origin\//, '');
    if (name) candidates.push(name);
  }
  candidates.push('main', 'master');
  for (const candidate of candidates) {
    if (isValidBranchName(candidate) && (await refExists(repo.path, `refs/heads/${candidate}`))) {
      return candidate;
    }
  }
  throw new GitCheckError('no se encontró la rama principal (main o master) en el repositorio');
}

async function resolveStoryCommit(repo: RepositoryRecord, story: StoryRecord): Promise<string> {
  if (story.branch !== null && isValidBranchName(story.branch)) {
    const commit = await revParseCommit(repo.path, `refs/heads/${story.branch}`);
    if (commit !== null) return commit;
  }
  // Respaldo: la rama pudo borrarse tras la fusión; se usa el commit registrado.
  if (story.mergedCommit !== null && SHA_PATTERN.test(story.mergedCommit)) {
    const commit = await revParseCommit(repo.path, story.mergedCommit);
    if (commit !== null) return commit;
  }
  throw new GitCheckError('no se encontró la rama ni el commit de la historia');
}

interface RepositoryFacts {
  readonly mergedIntoMain: boolean;
  readonly pushedToRemote: boolean;
}

/** Comprueba con git de solo lectura (sin fetch) si la historia está integrada y publicada. */
async function checkRepository(repo: RepositoryRecord, story: StoryRecord): Promise<RepositoryFacts> {
  const main = await detectMainBranch(repo);
  const commit = await resolveStoryCommit(repo, story);
  const localMain = `refs/heads/${main}`;
  const mergedIntoMain = await isAncestor(repo.path, commit, localMain);
  if (!mergedIntoMain) return { mergedIntoMain: false, pushedToRemote: false };
  const remoteMain = `refs/remotes/origin/${main}`;
  if (!(await refExists(repo.path, remoteMain))) return { mergedIntoMain, pushedToRemote: false };
  const pushedToRemote = await isAncestor(repo.path, localMain, remoteMain);
  return { mergedIntoMain, pushedToRemote };
}

function toStatus(
  evaluation: { canClose: boolean; reason: string | null; indicator: StoryClosureStatus['indicator'] },
  hasRepository: boolean
): StoryClosureStatus {
  return {
    canClose: evaluation.canClose,
    reason: evaluation.reason,
    indicator: evaluation.indicator,
    hasRepository
  };
}

/** Calcula el estado de cierre de una historia. Si git falla, el cierre queda bloqueado. */
export async function getStoryClosureStatus(
  ctx: StoryClosureContext,
  storyId: string
): Promise<StoryClosureStatus> {
  const story = await ctx.getStory(storyId);
  if (story === null) throw new StoryNotFoundError(storyId);
  const repo = await ctx.getRepository(story.projectId);
  const base = {
    hasRepository: repo !== null,
    workState: story.workState,
    appliedLocally: story.appliedLocally,
    completed: story.completed
  } as const;
  const sinGit = { ...base, mergedIntoMain: false, pushedToRemote: false };

  if (repo === null || story.completed) {
    return toStatus(evaluateStoryClosure(sinGit), repo !== null);
  }

  try {
    const facts = await checkRepository(repo, story);
    return toStatus(evaluateStoryClosure({ ...base, ...facts }), true);
  } catch (error) {
    if (!(error instanceof GitCheckError)) throw error;
    const evaluation = evaluateStoryClosure(sinGit);
    return {
      canClose: false,
      reason: `No se pudo comprobar el estado de git: ${redactCredentials(error.message)}`,
      indicator: evaluation.indicator,
      hasRepository: true
    };
  }
}

export type CompleteStoryResult =
  | { readonly ok: true; readonly status: StoryClosureStatus }
  | { readonly ok: false; readonly status: StoryClosureStatus };

/** Cierra la historia solo si la regla lo permite. El backend es la autoridad. */
export async function completeStory(
  ctx: StoryClosureContext,
  storyId: string
): Promise<CompleteStoryResult> {
  const status = await getStoryClosureStatus(ctx, storyId);
  if (!status.canClose) return { ok: false, status };
  await ctx.markStoryCompleted(storyId);
  return { ok: true, status };
}

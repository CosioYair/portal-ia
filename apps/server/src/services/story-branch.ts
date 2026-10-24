// Crea la rama de una historia desde origin/main actualizado, aplica y confirma los cambios
// y la publica en el remoto. No modifica nunca main (ni local ni remota).
// Git se ejecuta siempre con execFile (argumentos en array, sin shell).

import { execFile } from 'node:child_process';
import { redactCredentials, storyPublishBranchName } from '@portal/domain';
import type { PublishedStoryBranch, StoryBranchError, StoryBranchErrorCode } from '@portal/contracts';

export interface StoryBranchStory {
  /** Identificador de la historia, por ejemplo «HU-128». */
  readonly id: string;
  readonly title: string;
}

export type ApplyStoryChanges = (repoPath: string) => Promise<void>;

export interface PublishStoryBranchOptions {
  readonly timeoutMs?: number;
}

export type PublishStoryBranchOutcome =
  | { readonly ok: true; readonly result: PublishedStoryBranch }
  | { readonly ok: false; readonly error: StoryBranchError };

interface GitOutput {
  readonly ok: boolean;
  readonly stdout: string;
  readonly detail: string;
}

type GitRun = (...args: string[]) => Promise<GitOutput>;

interface OriginalPosition {
  /** Rama en la que estaba el repositorio (null si estaba con HEAD desacoplado). */
  readonly branch: string | null;
  readonly sha: string;
}

const REMOTE = 'origin';
const REMOTE_MAIN_REF = 'refs/remotes/origin/main';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_MESSAGE = 2000;
const MAX_COMMIT_TITLE = 100;

function git(args: string[], cwd: string, timeout: number): Promise<GitOutput> {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    execFile('git', args, { cwd, env, timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const detail = error?.killed ? 'tiempo de espera agotado' : stderr.trim() || error?.message || '';
      resolve({ ok: error === null, stdout, detail });
    });
  });
}

function fail(code: StoryBranchErrorCode, message: string): PublishStoryBranchOutcome {
  return { ok: false, error: { code, message: redactCredentials(message).slice(0, MAX_MESSAGE) } };
}

function existsInRemote(stdout: string, branch: string): boolean {
  return stdout.split('\n').some((linea) => linea.trim().endsWith(`\trefs/heads/${branch}`));
}

async function readOriginalPosition(run: GitRun): Promise<OriginalPosition | null> {
  const sha = await run('rev-parse', 'HEAD');
  if (!sha.ok) return null;
  const symbolic = await run('symbolic-ref', '--short', '-q', 'HEAD');
  const name = symbolic.ok ? symbolic.stdout.trim() : '';
  return { branch: name === '' ? null : name, sha: sha.stdout.trim() };
}

function restoreOriginal(run: GitRun, original: OriginalPosition): Promise<GitOutput> {
  return original.branch === null
    ? run('switch', '--detach', original.sha)
    : run('switch', original.branch);
}

/** Deshace la rama local creada: limpia lo aplicado, vuelve a la posición original y la borra. */
async function rollback(run: GitRun, original: OriginalPosition, branch: string): Promise<void> {
  await run('reset', '--hard', 'HEAD');
  await run('clean', '-fd');
  await restoreOriginal(run, original);
  await run('branch', '-D', branch);
}

function commitMessage(story: StoryBranchStory): string {
  const title = story.title.replace(/\s+/g, ' ').trim().slice(0, MAX_COMMIT_TITLE);
  return `feat(${story.id.trim().toLowerCase()}): ${title}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Crea la rama «historia/hu-XXX-slug» desde origin/main (recién obtenido), aplica y confirma
 * los cambios y la publica con upstream. Orden: árbol limpio → fetch → la rama no debe existir
 * → switch -c → aplicar y commit → push. Si algo falla antes del push se deshace la rama local;
 * si falla el push, la rama local conserva el commit y se informa con push-fallido (sin reintentos).
 */
export async function publishStoryBranch(
  repoPath: string,
  story: StoryBranchStory,
  applyChanges: ApplyStoryChanges,
  options: PublishStoryBranchOptions = {}
): Promise<PublishStoryBranchOutcome> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run: GitRun = (...args) => git(args, repoPath, timeout);

  const branch = storyPublishBranchName(story.id, story.title);
  if (branch === null) {
    return fail('historia-invalida', 'No se puede derivar un nombre de rama válido de la historia: no se ejecutó git.');
  }

  // (a) Árbol de trabajo limpio.
  const status = await run('status', '--porcelain');
  if (!status.ok) {
    return fail('git-fallido', `No se pudo comprobar el árbol de trabajo: ${status.detail}`);
  }
  if (status.stdout.trim() !== '') {
    return fail('repo-sucio', 'El repositorio tiene cambios sin confirmar: no se creó la rama.');
  }
  const original = await readOriginalPosition(run);
  if (original === null) {
    return fail('git-fallido', 'No se pudo determinar la rama actual del repositorio.');
  }

  // (b) Actualiza origin/main sin tocar la main local.
  const fetch = await run('fetch', REMOTE, `+refs/heads/main:${REMOTE_MAIN_REF}`);
  if (!fetch.ok) {
    return fail('fetch-fallido', `Falló git fetch de origin/main: ${fetch.detail}`);
  }

  // (c) La rama no debe existir ni en local ni en el remoto.
  const local = await run('show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
  if (local.ok) {
    return fail('rama-existente', `La rama ${branch} ya existe en local.`);
  }
  const remote = await run('ls-remote', '--heads', REMOTE, branch);
  if (!remote.ok) {
    return fail('fetch-fallido', `No se pudo consultar el remoto: ${remote.detail}`);
  }
  if (existsInRemote(remote.stdout, branch)) {
    return fail('rama-existente', `La rama ${branch} ya existe en el remoto.`);
  }

  const base = await run('rev-parse', '--verify', REMOTE_MAIN_REF);
  if (!base.ok) {
    return fail('git-fallido', `No se pudo resolver origin/main: ${base.detail}`);
  }
  const baseCommit = base.stdout.trim();

  // (d) Crea la rama desde origin/main (nunca checkout ni merge sobre main).
  const created = await run('switch', '--no-track', '-c', branch, REMOTE_MAIN_REF);
  if (!created.ok) {
    return fail('git-fallido', `No se pudo crear la rama ${branch}: ${created.detail}`);
  }

  const abort = async (code: StoryBranchErrorCode, message: string): Promise<PublishStoryBranchOutcome> => {
    await rollback(run, original, branch);
    return fail(code, `${message} Se deshizo la rama local.`);
  };

  // (e) Aplica los cambios y los confirma.
  try {
    await applyChanges(repoPath);
  } catch (error) {
    return abort('aplicacion-fallida', `No se pudieron aplicar los cambios: ${errorText(error)}.`);
  }
  const add = await run('add', '-A');
  if (!add.ok) {
    return abort('git-fallido', `Falló git add: ${add.detail}.`);
  }
  const pending = await run('status', '--porcelain');
  if (pending.ok && pending.stdout.trim() === '') {
    return abort('sin-cambios', 'La historia no produjo ningún cambio que confirmar.');
  }
  const commit = await run('commit', '-m', commitMessage(story));
  if (!commit.ok) {
    return abort('git-fallido', `Falló git commit: ${commit.detail}.`);
  }
  const head = await run('rev-parse', 'HEAD');
  if (!head.ok) {
    return abort('git-fallido', `No se pudo leer el commit creado: ${head.detail}.`);
  }
  const headCommit = head.stdout.trim();

  // (f) Publica con upstream. Si falla, la rama local conserva el commit.
  const push = await run('push', '-u', REMOTE, branch);
  if (!push.ok) {
    await restoreOriginal(run, original);
    return fail(
      'push-fallido',
      `Falló git push: ${push.detail}. La rama local ${branch} conserva el commit; no se reintentó.`
    );
  }

  // (g) Resultado tipado.
  return { ok: true, result: { branch, baseCommit, headCommit, remote: REMOTE, pushed: true } };
}

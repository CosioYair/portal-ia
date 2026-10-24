import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidStoryBranch, storyPublishBranchName } from '@portal/domain';
import { publishStoryBranch } from '../src/services/story-branch.ts';
import { publishStoryBranchHandler } from '../src/routes/story-branch.ts';

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const STORY = { id: 'HU-128', title: 'Flujo git mínimo' } as const;
const BRANCH = 'historia/hu-128-flujo-git-minimo';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'hu128-'));
  const bare = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const other = join(dir, 'other');
  g(dir, 'init', '--bare', bare);
  g(dir, 'init', work);
  g(work, 'config', 'user.name', 'Test');
  g(work, 'config', 'user.email', 'test@example.com');
  g(work, 'config', 'commit.gpgsign', 'false');
  g(work, 'checkout', '-b', 'main');
  await writeFile(join(work, 'a.txt'), 'base\n');
  g(work, 'add', '.');
  g(work, 'commit', '-m', 'inicial');
  g(work, 'remote', 'add', 'origin', bare);
  g(work, 'push', 'origin', 'main');
  return { dir, bare, work, other, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Avanza main en el remoto desde otro clon y devuelve el nuevo commit. */
async function advanceRemote(s: Setup): Promise<string> {
  g(s.dir, 'clone', '--branch', 'main', s.bare, s.other);
  g(s.other, 'config', 'user.name', 'Otro');
  g(s.other, 'config', 'user.email', 'otro@example.com');
  g(s.other, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(s.other, 'c.txt'), 'remoto\n');
  g(s.other, 'add', '.');
  g(s.other, 'commit', '-m', 'avance remoto');
  g(s.other, 'push', 'origin', 'main');
  return g(s.other, 'rev-parse', 'HEAD');
}

const applyFile = (work: string) => async (): Promise<void> => {
  await writeFile(join(work, 'historia.txt'), 'cambios de la historia\n');
};

test('crea la rama desde el último origin/main y la publica con upstream', async (t) => {
  const
  s = await setup();
  t.after(s.cleanup);
  const mainLocalAntes = g(s.work, 'rev-parse', 'refs/heads/main');
  const nuevoMain = await advanceRemote(s);
  assert.notEqual(nuevoMain, mainLocalAntes);

  const outcome = await publishStoryBranch(s.work, STORY, applyFile(s.work));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const { result } = outcome;

  // (i) La base es el último commit de origin/main, no el de la main local.
  assert.equal(result.branch, BRANCH);
  assert.equal(result.baseCommit, nuevoMain);
  assert.equal(g(s.work, 'rev-parse', `${BRANCH}~1`), nuevoMain);
  assert.equal(result.pushed, true);
  assert.equal(result.remote, 'origin');

  // (ii) Publicada en el remoto con el nombre esperado y con upstream.
  assert.equal(g(s.bare, 'rev-parse', `refs/heads/${BRANCH}`), result.headCommit);
  assert.equal(g(s.work, 'rev-parse', `${BRANCH}@{upstream}`), result.headCommit);
  assert.match(g(s.work, 'log', '-1', '--format=%s', BRANCH), /hu-128/);

  // (iii) main intacta en local y en el remoto.
  assert.equal(g(s.work, 'rev-parse', 'refs/heads/main'), mainLocalAntes);
  assert.equal(g(s.bare, 'rev-parse', 'refs/heads/main'), nuevoMain);
});

test('repositorio sucio: aborta sin efectos', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await writeFile(join(s.work, 'a.txt'), 'modificado\n');
  const refsAntes = g(s.work, 'for-each-ref', '--format=%(refname) %(objectname)');
  const remotoAntes = g(s.bare, 'for-each-ref');

  let aplicado = false;
  const outcome = await publishStoryBranch(s.work, STORY, async () => {
    aplicado = true;
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, 'repo-sucio');
  assert.equal(aplicado, false);
  assert.equal(g(s.work, 'for-each-ref', '--format=%(refname) %(objectname)'), refsAntes);
  assert.equal(g(s.bare, 'for-each-ref'), remotoAntes);
  assert.equal(g(s.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(g(s.work, 'status', '--porcelain'), 'M a.txt');
});

test('rama existente en local: aborta sin efectos', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  g(s.work, 'branch', BRANCH);
  const refsAntes = g(s.work, 'for-each-ref', '--format=%(refname) %(objectname)');
  const remotoAntes = g(s.bare, 'for-each-ref');

  let aplicado = false;
  const outcome = await publishStoryBranch(s.work, STORY, async () => {
    aplicado = true;
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, 'rama-existente');
  assert.equal(aplicado, false);
  assert.equal(g(s.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(g(s.work, 'for-each-ref', '--format=%(refname) %(objectname)'), refsAntes);
  assert.equal(g(s.bare, 'for-each-ref'), remotoAntes);
});

test('rama existente en el remoto: aborta sin efectos', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  g(s.work, 'push', 'origin', `main:refs/heads/${BRANCH}`);
  const remotoAntes = g(s.bare, 'for-each-ref');
  const localesAntes = g(s.work, 'for-each-ref', 'refs/heads', '--format=%(refname) %(objectname)');

  const outcome = await publishStoryBranch(s.work, STORY, applyFile(s.work));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, 'rama-existente');
  assert.equal(g(s.work, 'for-each-ref', 'refs/heads', '--format=%(refname) %(objectname)'), localesAntes);
  assert.equal(g(s.bare, 'for-each-ref'), remotoAntes);
  assert.equal(g(s.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('si aplicar los cambios falla, se deshace la rama local y no se publica nada', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const mainAntes = g(s.bare, 'rev-parse', 'refs/heads/main');

  const outcome = await publishStoryBranch(s.work, STORY, async () => {
    await writeFile(join(s.work, 'parcial.txt'), 'a medias\n');
    throw new Error('fallo simulado');
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, 'aplicacion-fallida');
  assert.equal(g(s.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(g(s.work, 'branch', '--list', BRANCH), '');
  assert.equal(g(s.work, 'status', '--porcelain'), '');
  assert.equal(g(s.bare, 'branch', '--list', BRANCH), '');
  assert.equal(g(s.bare, 'rev-parse', 'refs/heads/main'), mainAntes);
});

test('sin cambios que confirmar: aborta y deshace la rama local', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const outcome = await publishStoryBranch(s.work, STORY, async () => {});
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, 'sin-cambios');
  assert.equal(g(s.work, 'branch', '--list', BRANCH), '');
  assert.equal(g(s.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('sin remoto origin: falla en fetch sin crear la rama', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  g(s.work, 'remote', 'remove', 'origin');
  const outcome = await publishStoryBranch(s.work, STORY, applyFile(s.work));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, 'fetch-fallido');
  assert.equal(g(s.work, 'branch', '--list', BRANCH), '');
});

test('si el push falla, informa push-fallido y conserva la rama local con su commit', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await writeFile(
    join(s.bare, 'hooks', 'pre-receive'),
    '#!/bin/sh\necho "rechazado por el hook" >&2\nexit 1\n',
    { mode: 0o755 }
  );
  const mainAntes = g(s.bare, 'rev-parse', 'refs/heads/main');

  const outcome = await publishStoryBranch(s.work, STORY, applyFile(s.work));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, 'push-fallido');
  assert.equal(g(s.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.notEqual(g(s.work, 'branch', '--list', BRANCH), '');
  assert.equal(g(s.bare, 'branch', '--list', BRANCH), '');
  assert.equal(g(s.bare, 'rev-parse', 'refs/heads/main'), mainAntes);
});

test('la ruta valida el identificador, responde 404 y delega en el servicio', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const ctx = {
    getTarget: async (id: string) => (id === 'HU-128' ? { repoPath: s.work, title: STORY.title } : null),
    applyChanges: async (_id: string, repoPath: string) => applyFile(repoPath)()
  };
  assert.equal((await publishStoryBranchHandler(ctx, { id: '../x' })).status, 400);
  assert.equal((await publishStoryBranchHandler(ctx, { id: 'HU-999' })).status, 404);

  const res = await publishStoryBranchHandler(ctx, { id: 'HU-128' });
  assert.equal(res.status, 200);
  assert.equal((res.body as { branch: string }).branch, BRANCH);
  assert.equal(g(s.bare, 'branch', '--list', BRANCH).replace('*', '').trim(), BRANCH);

  // Una segunda llamada encuentra la rama ya existente: 409 con error tipado.
  const repetida = await publishStoryBranchHandler(ctx, { id: 'HU-128' });
  assert.equal(repetida.status, 409);
  assert.equal((repetida.body as { code: string }).code, 'rama-existente');
});

test('storyPublishBranchName: ID de tres dígitos y slug normalizado', () => {
  assert.equal(storyPublishBranchName('HU-128', 'Flujo git mínimo'), BRANCH);
  assert.equal(storyPublishBranchName('hu-7', 'Revisión del backlog'), 'historia/hu-007-revision-del-backlog');
  assert.equal(storyPublishBranchName('HU-1234', 'Ñandú: gestión'), 'historia/hu-1234-nandu-gestion');
  assert.equal(storyPublishBranchName('125', 'x'), null);
  assert.equal(storyPublishBranchName('HU-0', 'x'), null);
  assert.equal(storyPublishBranchName('HU-128', '***'), null);

  const largo = storyPublishBranchName('HU-128', 'palabra '.repeat(30)) ?? '';
  assert.ok(largo.length <= 'historia/hu-128-'.length + 50);
  assert.equal(isValidStoryBranch(largo), true);
  assert.equal(largo.endsWith('-'), false);
});

test('isValidStoryBranch acepta la convención y rechaza el resto', () => {
  assert.equal(isValidStoryBranch(BRANCH), true);
  for (const malo of ['main', 'hu-128/x', 'historia/hu-12-x', 'historia/hu-128-', 'historia/hu-128-A', 'historia/hu-128-a--b', 'historia/hu-128-a b']) {
    assert.equal(isValidStoryBranch(malo), false, `debería rechazar «${malo}»`);
  }
});

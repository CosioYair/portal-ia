import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// Datos de prueba aislados (config.ts crea la carpeta de datos al importarse).
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-guard-data-'));

const guard = await import('../src/services/git-branch-guard.ts');
const { IntegrationError, getIntegrationStatus, integrateIntoMain } = await import('../src/services/integration.ts');

// Las pruebas de integración necesitan git ≥ 2.28 (init -b).
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-guard-probe-'));
const gitOk = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: probe }).status === 0;
const skip = gitOk ? false : 'git ≥ 2.28 no disponible';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

/** Repositorio de trabajo en main, remoto bare con main publicada y rama portal-ia/hu-143 con un commit. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-guard-'));
  const dir = path.join(root, 'work');
  const bare = path.join(root, 'remote.git');
  fs.mkdirSync(dir); fs.mkdirSync(bare);
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'checkout', '-q', '-b', 'portal-ia/hu-143');
  fs.writeFileSync(path.join(dir, 'feat.txt'), 'feat\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'feat');
  git(dir, 'checkout', '-q', 'main');
  return { dir, bare };
}

test('evaluateIntegration: en main se puede; en otra rama, desacoplado o sin repositorio se bloquea con motivo en español', () => {
  const ok = guard.evaluateIntegration({ currentBranch: 'main', mainBranch: 'main' });
  assert.equal(ok.canIntegrate, true); assert.equal(ok.reasonCode, undefined);
  const other = guard.evaluateIntegration({ currentBranch: 'portal-ia/hu-124', mainBranch: 'main' });
  assert.equal(other.canIntegrate, false); assert.equal(other.reasonCode, 'NOT_ON_MAIN');
  assert.ok(other.reason!.includes('«portal-ia/hu-124»') && other.reason!.includes('git switch main'));
  const detached = guard.evaluateIntegration({ currentBranch: null, mainBranch: 'main' });
  assert.equal(detached.canIntegrate, false); assert.equal(detached.reasonCode, 'DETACHED_HEAD');
  const noRepo = guard.evaluateIntegration({ currentBranch: null, mainBranch: 'main', isRepo: false });
  assert.equal(noRepo.reasonCode, 'NOT_A_REPO');
});

test('translatePushError: src refspec se traduce a causa y solución; otros errores caen al genérico con stderr recortado', () => {
  const real = "error: src refspec main does not match any\nerror: failed to push some refs to '/tmp/remote.git'\n";
  const t = guard.translatePushError(real, 'main');
  assert.equal(t.code, 'LOCAL_BRANCH_MISSING');
  assert.ok(t.cause.includes('La rama local «main» no existe en esta carpeta'));
  assert.ok(t.solution.includes('git switch -c main origin/main') && t.solution.includes('git fetch origin main:main'));
  const g = guard.translatePushError('fatal: unable to access remote: timeout', 'main');
  assert.equal(g.code, 'PUSH_FAILED'); assert.ok(g.cause.includes('unable to access remote'));
  const long = guard.translatePushError('x'.repeat(2000), 'main');
  assert.ok(long.cause.length < 600, 'el stderr se recorta');
});

test('integrar desde una rama distinta de main (o HEAD desacoplado) se bloquea y no cambia ninguna rama', { skip }, async () => {
  const { dir, bare } = makeRepo();
  const mainBefore = git(dir, 'rev-parse', 'refs/heads/main');
  const featBefore = git(dir, 'rev-parse', 'refs/heads/portal-ia/hu-143');
  const remoteBefore = git(bare, 'rev-parse', 'refs/heads/main');

  git(dir, 'checkout', '-q', 'portal-ia/hu-143');
  const st = await getIntegrationStatus(dir, 'main');
  assert.equal(st.canIntegrate, false); assert.equal(st.reasonCode, 'NOT_ON_MAIN'); assert.equal(st.currentBranch, 'portal-ia/hu-143');
  await assert.rejects(
    integrateIntoMain({ cwd: dir, mainBranch: 'main', sourceBranch: 'portal-ia/hu-143' }),
    (e: unknown) => e instanceof IntegrationError && e.status === 409 && e.body.code === 'NOT_ON_MAIN' && /portal-ia\/hu-143/.test(e.body.reason ?? '')
  );
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), 'portal-ia/hu-143', 'no cambia de rama');

  git(dir, 'checkout', '-q', '--detach');
  await assert.rejects(
    integrateIntoMain({ cwd: dir, mainBranch: 'main', sourceBranch: 'portal-ia/hu-143' }),
    (e: unknown) => e instanceof IntegrationError && e.body.code === 'DETACHED_HEAD'
  );

  assert.equal(git(dir, 'rev-parse', 'refs/heads/main'), mainBefore, 'main no recibe commits');
  assert.equal(git(dir, 'rev-parse', 'refs/heads/portal-ia/hu-143'), featBefore);
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), remoteBefore, 'el remoto no cambia');
});

test('integrar desde main: integra en main y publica en el remoto bare sin error de refspec', { skip }, async () => {
  const { dir, bare } = makeRepo();
  const st = await getIntegrationStatus(dir, 'main');
  assert.equal(st.canIntegrate, true);
  await assert.rejects(integrateIntoMain({ cwd: dir, mainBranch: 'main', sourceBranch: 'no-existe' }), (e: unknown) => e instanceof IntegrationError && e.body.code === 'SOURCE_NOT_FOUND');
  await assert.rejects(integrateIntoMain({ cwd: dir, mainBranch: 'main', sourceBranch: 'main' }), (e: unknown) => e instanceof IntegrationError && e.body.code === 'SOURCE_IS_MAIN');

  const res = await integrateIntoMain({ cwd: dir, mainBranch: 'main', sourceBranch: 'portal-ia/hu-143' });
  assert.equal(res.into, 'main'); assert.equal(res.remote, 'origin'); assert.equal(res.published, true);
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.ok(fs.existsSync(path.join(dir, 'feat.txt')), 'archivo integrado en main');
  assert.ok(git(dir, 'log', '--format=%s', '-n', '1').includes('Integra portal-ia/hu-143 en main'));
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), res.commit, 'el commit llega a origin/main');
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), git(dir, 'rev-parse', 'refs/heads/main'));
});

test('publishMain con la rama local main eliminada devuelve un error accionable y no ejecuta git push', { skip }, async () => {
  const { dir, bare } = makeRepo();
  const remoteBefore = git(bare, 'rev-parse', 'refs/heads/main');
  git(dir, 'checkout', '-q', 'portal-ia/hu-143');
  git(dir, 'branch', '-D', 'main');
  assert.equal(await guard.localBranchExists(dir, 'main'), false);

  const calls: string[][] = [];
  const spy = (cwd: string, args: string[]) => { calls.push(args); return guard.runGit(cwd, args); };
  const res = await guard.publishMain(dir, 'main', spy);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.code, 'LOCAL_BRANCH_MISSING');
    assert.ok(res.error.cause.includes('«main»') && res.error.solution.includes('git switch -c main origin/main'));
  }
  assert.ok(calls.some(a => a[0] === 'show-ref'), 'se verificó la rama local');
  assert.ok(res.ok === false && calls.length > 0, 'se ejecutó al menos una comprobación git');
  assert.ok(!calls.some(a => a[0] === 'push'), 'no se intentó el push');
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), remoteBefore, 'el remoto no cambia');
});

test('API: GET de estado y POST fuera de main responden con motivo claro (409) sin escribir', { skip }, async () => {
  const { buildApp } = await import('../src/app.ts');
  const { REPO_ROOT } = await import('../src/config.ts');
  const app = await buildApp();
  const status = await app.inject({ method: 'GET', url: '/api/portal/integration/status' });
  assert.equal(status.statusCode, 200);
  const body = status.json();
  assert.equal(typeof body.canIntegrate, 'boolean');
  assert.equal(body.mainBranch, 'main');
  if (!body.canIntegrate) {
    assert.ok(['NOT_ON_MAIN', 'DETACHED_HEAD', 'NOT_A_REPO'].includes(body.reasonCode));
    assert.ok(typeof body.reason === 'string' && body.reason.length > 0);
    const headBefore = git(REPO_ROOT, 'rev-parse', 'HEAD');
    const post = await app.inject({ method: 'POST', url: '/api/portal/integration', payload: { branch: 'portal-ia/hu-143' } });
    assert.equal(post.statusCode, 409);
    assert.equal(post.json().code, body.reasonCode);
    assert.equal(git(REPO_ROOT, 'rev-parse', 'HEAD'), headBefore, 'no se hizo ningún commit');
  }
  const invalid = await app.inject({ method: 'POST', url: '/api/portal/integration', payload: {} });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});

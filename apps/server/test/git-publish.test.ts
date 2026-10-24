import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidBranchName, redactCredentials } from '@portal/domain';
import { JsonlActivityLog } from '../src/services/activity-log.ts';
import { publishBranch } from '../src/services/git-publish.ts';

const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function setup(remote: string | null) {
  const dir = await mkdtemp(join(tmpdir(), 'hu119-'));
  const bare = join(dir, 'origin.git');
  const work = join(dir, 'work');
  g(dir, 'init', '--bare', bare);
  g(dir, 'init', work);
  g(work, 'config', 'user.name', 'Test');
  g(work, 'config', 'user.email', 'test@example.com');
  g(work, 'config', 'commit.gpgsign', 'false');
  g(work, 'checkout', '-b', 'feature/x');
  await writeFile(join(work, 'a.txt'), 'hola\n');
  g(work, 'add', '.');
  g(work, 'commit', '-m', 'inicial');
  if (remote !== null) g(work, 'remote', 'add', 'origin', remote === '' ? bare : remote);
  const logPath = join(dir, 'actividad.jsonl');
  return {
    bare,
    work,
    logPath,
    log: new JsonlActivityLog(logPath),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

test('publica la rama en origin y registra la actividad', async (t) => {
  const s = await setup('');
  t.after(s.cleanup);
  const r = await publishBranch({ repoPath: s.work, branch: 'feature/x', companyId: 'acme', log: s.log });
  assert.equal(r.ok, true);
  assert.match(g(s.work, 'ls-remote', '--heads', 'origin', 'feature/x'), /refs\/heads\/feature\/x/);
  assert.match(g(s.bare, 'show-ref', 'refs/heads/feature/x'), /refs\/heads\/feature\/x/);
  const entradas = await s.log.list();
  assert.equal(entradas.length, 1);
  assert.equal(entradas[0]?.status, 'ok');
  assert.equal(entradas[0]?.companyId, 'acme');
  assert.equal(entradas[0]?.branch, 'feature/x');
});

test('un nombre de rama inválido falla sin ejecutar push', async (t) => {
  const s = await setup('');
  t.after(s.cleanup);
  const r = await publishBranch({ repoPath: s.work, branch: 'rama invalida', companyId: 'acme', log: s.log });
  assert.equal(r.ok, false);
  assert.equal(g(s.bare, 'for-each-ref').trim(), '');
  const entradas = await s.log.list();
  assert.equal(entradas.length, 1);
  assert.equal(entradas[0]?.status, 'error');
});

test('un repositorio sin origin produce una entrada de error', async (t) => {
  const s = await setup(null);
  t.after(s.cleanup);
  const r = await publishBranch({ repoPath: s.work, branch: 'feature/x', companyId: 'acme', log: s.log });
  assert.equal(r.ok, false);
  const entradas = await s.log.list();
  assert.equal(entradas.length, 1);
  assert.equal(entradas[0]?.status, 'error');
});

test('la salida de git se redacta y el registro no contiene el token', async (t) => {
  assert.equal(
    redactCredentials('fatal: https://u:ghp_FAKE@host/repo.git'),
    'fatal: https://***@host/repo.git'
  );
  const s = await setup('https://u:ghp_FAKE@127.0.0.1:1/repo.git');
  t.after(s.cleanup);
  const r = await publishBranch({
    repoPath: s.work, branch: 'feature/x', companyId: 'acme', log: s.log, timeoutMs: 15_000
  });
  assert.equal(r.ok, false);
  assert.ok(!r.message.includes('ghp_FAKE'));
  assert.ok(!(await readFile(s.logPath, 'utf8')).includes('ghp_FAKE'));
});

test('isValidBranchName rechaza nombres peligrosos', () => {
  for (const malo of ['', '-x', 'a..b', 'a b', 'a~b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'x.lock', 'a/.b']) {
    assert.equal(isValidBranchName(malo), false, `debería rechazar «${malo}»`);
  }
  for (const bueno of ['main', 'feature/x', 'hu-119/push_rama']) {
    assert.equal(isValidBranchName(bueno), true, `debería aceptar «${bueno}»`);
  }
});

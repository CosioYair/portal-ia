import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// Datos de prueba aislados (config.ts crea la carpeta de datos al importarse).
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-wt-data-'));

const wt = await import('../src/services/worktree.ts');

const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-wt-probe-'));
const gitOk = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: probe }).status === 0;
const skip = gitOk ? false : 'git ≥ 2.28 no disponible';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function identify(dir: string): void {
  git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'commit.gpgsign', 'false');
}

function commitFile(dir: string, file: string, content: string, msg: string): void {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg);
}

/** origin bare, clon principal (work), segundo clon (other) que empuja un commit nuevo a main después de clonar. */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-wt-'));
  const bare = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');
  const worktreesDir = path.join(root, 'worktrees');
  fs.mkdirSync(bare); fs.mkdirSync(work);
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(work, 'init', '-q', '-b', 'main'); identify(work);
  commitFile(work, 'base.txt', 'base\n', 'base');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', bare, other); identify(other);
  commitFile(other, 'nuevo.txt', 'nuevo\n', 'commit posterior al clon');
  git(other, 'push', '-q', 'origin', 'main');
  const latest = git(other, 'rev-parse', 'HEAD');
  return { root, bare, work, worktreesDir, latest };
}

test('el worktree parte del último commit de origin/main (tras fetch) y usa la rama proc/<id>', { skip }, async () => {
  const { work, worktreesDir, latest } = makeFixture();
  const localMainBefore = git(work, 'rev-parse', 'refs/heads/main');
  assert.notEqual(localMainBefore, latest, 'el montaje exige una main local desactualizada');

  const w = await wt.createProcessWorktree(work, 'proc-a1', { worktreesDir });
  assert.equal(w.branch, 'proc/proc-a1');
  assert.equal(w.baseCommit, latest);
  assert.equal(git(w.path, 'rev-parse', 'HEAD'), latest);
  assert.equal(git(w.path, 'symbolic-ref', '--short', 'HEAD'), 'proc/proc-a1');
  assert.ok(fs.existsSync(path.join(w.path, 'nuevo.txt')), 'contiene el commit publicado después del clon');
  assert.equal(path.dirname(w.path), path.resolve(worktreesDir));
  assert.equal(git(work, 'rev-parse', 'refs/heads/main'), localMainBefore, 'la main local no se mueve');

  await wt.removeProcessWorktree(work, 'proc-a1', { worktreesDir });
});

test('escribir dentro del worktree no altera la carpeta principal', { skip }, async () => {
  const { work, worktreesDir } = makeFixture();
  const w = await wt.createProcessWorktree(work, 'proc-b1', { worktreesDir });
  const baseBefore = fs.readFileSync(path.join(work, 'base.txt'), 'utf8');
  const headBefore = git(work, 'rev-parse', 'HEAD');
  const filesBefore = fs.readdirSync(work).sort();

  fs.writeFileSync(path.join(w.path, 'solo-en-worktree.txt'), 'x\n');
  fs.writeFileSync(path.join(w.path, 'base.txt'), 'modificado en el worktree\n');
  assert.ok(git(w.path, 'status', '--porcelain').length > 0, 'el worktree sí ve los cambios');

  assert.equal(git(work, 'status', '--porcelain'), '', 'la carpeta principal queda limpia');
  assert.equal(fs.readFileSync(path.join(work, 'base.txt'), 'utf8'), baseBefore);
  assert.equal(fs.existsSync(path.join(work, 'solo-en-worktree.txt')), false);
  assert.deepEqual(fs.readdirSync(work).sort(), filesBefore);
  assert.equal(git(work, 'rev-parse', 'HEAD'), headBefore);

  await wt.removeProcessWorktree(work, 'proc-b1', { worktreesDir });
});

test('al eliminarlo no quedan directorio, entrada en worktree list ni rama; la eliminación es idempotente', { skip }, async () => {
  const { work, worktreesDir } = makeFixture();
  const w = await wt.createProcessWorktree(work, 'proc-c1', { worktreesDir });
  fs.writeFileSync(path.join(w.path, 'sin-confirmar.txt'), 'x\n');
  assert.ok(git(work, 'worktree', 'list', '--porcelain').includes('proc-c1'));

  await wt.removeProcessWorktree(work, 'proc-c1', { worktreesDir });
  assert.equal(fs.existsSync(w.path), false);
  assert.ok(!git(work, 'worktree', 'list', '--porcelain').includes('proc-c1'));
  assert.equal(git(work, 'branch', '--list', 'proc/proc-c1'), '');

  await wt.removeProcessWorktree(work, 'proc-c1', { worktreesDir }); // segunda vez
  await wt.removeProcessWorktree(work, 'nunca-creado', { worktreesDir });
  assert.equal(git(work, 'status', '--porcelain'), '');
});

test('un processId inválido o con «../» se rechaza sin ejecutar git', { skip }, async () => {
  const noRepo = path.join(os.tmpdir(), 'portal-ia-wt-no-existe');
  const worktreesDir = path.join(os.tmpdir(), 'portal-ia-wt-no-existe-wts');
  for (const bad of ['../x', '..', 'a/b', 'a\\b', '', ' ', 'x'.repeat(65), 'a b']) {
    await assert.rejects(wt.createProcessWorktree(noRepo, bad, { worktreesDir }), (e: unknown) => e instanceof wt.WorktreeError && e.code === 'INVALID_PROCESS_ID', `crear «${bad}»`);
    await assert.rejects(wt.removeProcessWorktree(noRepo, bad, { worktreesDir }), (e: unknown) => e instanceof wt.WorktreeError && e.code === 'INVALID_PROCESS_ID', `eliminar «${bad}»`);
  }
  assert.equal(fs.existsSync(worktreesDir), false, 'no se creó nada en disco');
});

test('crear dos veces el mismo proceso falla con error claro y no toca el worktree existente', { skip }, async () => {
  const { work, worktreesDir } = makeFixture();
  const w = await wt.createProcessWorktree(work, 'proc-d1', { worktreesDir });
  await assert.rejects(wt.createProcessWorktree(work, 'proc-d1', { worktreesDir }), (e: unknown) => e instanceof wt.WorktreeError && e.code === 'PATH_EXISTS');
  assert.ok(fs.existsSync(w.path));
  await wt.removeProcessWorktree(work, 'proc-d1', { worktreesDir });
});

test('sin remoto origin usa la rama main local', { skip }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-wt-local-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main'); identify(work);
  commitFile(work, 'base.txt', 'base\n', 'base');
  const head = git(work, 'rev-parse', 'HEAD');
  const worktreesDir = path.join(root, 'worktrees');

  const w = await wt.createProcessWorktree(work, 'proc-e1', { worktreesDir });
  assert.equal(w.baseCommit, head);
  await wt.removeProcessWorktree(work, 'proc-e1', { worktreesDir });
});

test('withProcessWorktree elimina el worktree cuando el proceso termina, falla o se cancela', { skip }, async () => {
  const { work, worktreesDir } = makeFixture();
  const clean = (id: string) => {
    assert.equal(fs.existsSync(path.join(worktreesDir, id)), false, `directorio de ${id}`);
    assert.ok(!git(work, 'worktree', 'list', '--porcelain').includes(id), `entrada de ${id}`);
    assert.equal(git(work, 'branch', '--list', `proc/${id}`), '', `rama de ${id}`);
  };

  const value = await wt.withProcessWorktree(work, 'proc-f-ok', async w => {
    fs.writeFileSync(path.join(w.path, 'salida.txt'), 'ok\n');
    return 42;
  }, { worktreesDir });
  assert.equal(value, 42);
  clean('proc-f-ok');

  await assert.rejects(
    wt.withProcessWorktree(work, 'proc-f-fail', async w => {
      fs.writeFileSync(path.join(w.path, 'parcial.txt'), 'x\n');
      throw new Error('el proceso falló');
    }, { worktreesDir }),
    /el proceso falló/
  );
  clean('proc-f-fail');

  const ac = new AbortController();
  await assert.rejects(
    wt.withProcessWorktree(work, 'proc-f-cancel', async () => {
      setTimeout(() => ac.abort(), 5);
      await new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error('cancelado'))));
    }, { worktreesDir }),
    /cancelado/
  );
  clean('proc-f-cancel');
  assert.equal(git(work, 'status', '--porcelain'), '');
});

test('procesos concurrentes sobre el mismo repositorio obtienen cada uno su worktree sin conflictos', { skip }, async () => {
  const { work, worktreesDir, latest } = makeFixture();
  const ids = ['proc-g1', 'proc-g2', 'proc-g3'];
  const created = await Promise.all(ids.map(id => wt.createProcessWorktree(work, id, { worktreesDir })));
  assert.equal(new Set(created.map(c => c.path)).size, 3);
  for (const c of created) assert.equal(git(c.path, 'rev-parse', 'HEAD'), latest);
  await Promise.all(ids.map(id => wt.removeProcessWorktree(work, id, { worktreesDir })));
  assert.equal(git(work, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter(l => l.startsWith('worktree ')).length, 1);
  assert.equal(git(work, 'branch', '--list', 'proc/*'), '');
});

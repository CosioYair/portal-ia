import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateExecutionPreflight,
  parseRemoteDefaultBranch,
  PREFLIGHT_CHECK_IDS
} from '@portal/domain';
import { ExecutionPreflightResultSchema } from '@portal/contracts';
import {
  createExecutionPreflightService,
  ejecutarTrasPreflight
} from '../src/services/execution-preflight.ts';

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

// Dominio puro

test('dominio: todo correcto permite ejecutar', () => {
  const r = evaluateExecutionPreflight({
    currentBranch: 'main',
    headSha: SHA_A,
    originMainSha: SHA_A,
    remoteDefaultBranch: 'main'
  });
  assert.equal(r.ok, true);
  assert.equal(r.motivo, null);
  assert.deepEqual(r.checks.map((c) => c.id), [...PREFLIGHT_CHECK_IDS]);
  assert.ok(r.checks.every((c) => c.estado === 'ok'));
});

test('dominio: denegar por defecto, cada dato ausente bloquea como indeterminado', () => {
  const completo = {
    currentBranch: 'main',
    headSha: SHA_A,
    originMainSha: SHA_A,
    remoteDefaultBranch: 'main'
  };
  for (const campo of ['currentBranch', 'headSha', 'originMainSha', 'remoteDefaultBranch'] as const) {
    const r = evaluateExecutionPreflight({ ...completo, [campo]: null });
    assert.equal(r.ok, false, campo);
    assert.ok(r.checks.some((c) => c.estado === 'indeterminado'), campo);
    assert.match(r.motivo ?? '', /Detenido/);
  }
  const todoNulo = evaluateExecutionPreflight({
    currentBranch: null,
    headSha: null,
    originMainSha: null,
    remoteDefaultBranch: null
  });
  assert.equal(todoNulo.ok, false);
});

test('dominio: los fallos se describen en español', () => {
  const r = evaluateExecutionPreflight({
    currentBranch: 'hu-1/x',
    headSha: SHA_A,
    originMainSha: SHA_B,
    remoteDefaultBranch: 'portal-ia/hu-119'
  });
  assert.equal(r.ok, false);
  assert.ok(r.checks.every((c) => c.estado === 'fallo'));
  const motivo = r.motivo ?? '';
  for (const fragmento of ['no corre desde main actualizado', 'hu-1/x', 'origin/main', 'portal-ia/hu-119']) {
    assert.ok(motivo.includes(fragmento), `falta «${fragmento}»`);
  }
  assert.equal(ExecutionPreflightResultSchema.safeParse(r).success, true);
});

test('dominio: parseRemoteDefaultBranch lee la salida de ls-remote --symref', () => {
  assert.equal(parseRemoteDefaultBranch(`ref: refs/heads/main\tHEAD\n${SHA_A}\tHEAD\n`), 'main');
  assert.equal(
    parseRemoteDefaultBranch(`ref: refs/heads/portal-ia/hu-119\tHEAD\n${SHA_A}\tHEAD\n`),
    'portal-ia/hu-119'
  );
  assert.equal(parseRemoteDefaultBranch(`${SHA_A}\tHEAD\n`), null);
  assert.equal(parseRemoteDefaultBranch(''), null);
});

// Servicio sobre repositorios git temporales

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'hu129-'));
  const bare = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const other = join(dir, 'other');
  g(dir, 'init', '--bare', bare);
  g(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
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

async function advanceRemote(s: Setup): Promise<void> {
  g(s.dir, 'clone', '--branch', 'main', s.bare, s.other);
  g(s.other, 'config', 'user.name', 'Otro');
  g(s.other, 'config', 'user.email', 'otro@example.com');
  g(s.other, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(s.other, 'c.txt'), 'remoto\n');
  g(s.other, 'add', '.');
  g(s.other, 'commit', '-m', 'avance remoto');
  g(s.other, 'push', 'origin', 'main');
}

/** Simula el arranque de una historia y cuenta los efectos con coste que se producirían. */
async function intentarEjecutar(work: string) {
  const efectos = { reservas: 0, llamadasComplete: 0, consumos: 0 };
  const resultado = await ejecutarTrasPreflight(createExecutionPreflightService({ cwd: work }), async () => {
    efectos.reservas += 1;
    efectos.llamadasComplete += 1;
    efectos.consumos += 1;
    return 'ejecutada';
  });
  return { resultado, efectos };
}

function assertSinCoste(efectos: { reservas: number; llamadasComplete: number; consumos: number }): void {
  assert.deepEqual(efectos, { reservas: 0, llamadasComplete: 0, consumos: 0 });
}

test('servicio: caso correcto, main al día con main por defecto en el remoto', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const { resultado, efectos } = await intentarEjecutar(s.work);
  assert.equal(resultado.iniciada, true);
  assert.equal(resultado.preflight.ok, true);
  assert.equal(ExecutionPreflightResultSchema.safeParse(resultado.preflight).success, true);
  assert.equal(efectos.reservas, 1);
});

test('servicio: rama distinta de main detiene sin coste', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  g(s.work, 'checkout', '-b', 'hu-1/trabajo');
  const { resultado, efectos } = await intentarEjecutar(s.work);
  assert.equal(resultado.iniciada, false);
  assert.equal(resultado.preflight.checks.find((c) => c.id === 'rama-actual')?.estado, 'fallo');
  assert.match(resultado.preflight.motivo ?? '', /hu-1\/trabajo/);
  assertSinCoste(efectos);
});

test('servicio: main desactualizado respecto a origin/main detiene sin coste', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await advanceRemote(s);
  const { resultado, efectos } = await intentarEjecutar(s.work);
  assert.equal(resultado.iniciada, false);
  assert.equal(resultado.preflight.checks.find((c) => c.id === 'main-actualizado')?.estado, 'fallo');
  assertSinCoste(efectos);
});

test('servicio: rama por defecto del remoto distinta de main detiene sin coste', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  g(s.work, 'push', 'origin', 'main:refs/heads/otra');
  g(s.bare, 'symbolic-ref', 'HEAD', 'refs/heads/otra');
  const { resultado, efectos } = await intentarEjecutar(s.work);
  assert.equal(resultado.iniciada, false);
  const check = resultado.preflight.checks.find((c) => c.id === 'rama-por-defecto-remoto');
  assert.equal(check?.estado, 'fallo');
  assert.match(check?.detalle ?? '', /otra/);
  assertSinCoste(efectos);
});

test('servicio: remoto inaccesible es indeterminado y detiene sin coste', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  g(s.work, 'remote', 'set-url', 'origin', join(s.dir, 'no-existe.git'));
  const { resultado, efectos } = await intentarEjecutar(s.work);
  assert.equal(resultado.iniciada, false);
  assert.equal(resultado.preflight.checks.find((c) => c.id === 'main-actualizado')?.estado, 'indeterminado');
  assert.equal(
    resultado.preflight.checks.find((c) => c.id === 'rama-por-defecto-remoto')?.estado,
    'indeterminado'
  );
  assertSinCoste(efectos);
});

test('servicio: HEAD desacoplado y carpeta sin git son indeterminados y no lanzan', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  g(s.work, 'checkout', '--detach');
  const desacoplado = await intentarEjecutar(s.work);
  assert.equal(desacoplado.resultado.iniciada, false);
  assert.equal(
    desacoplado.resultado.preflight.checks.find((c) => c.id === 'rama-actual')?.estado,
    'indeterminado'
  );
  assertSinCoste(desacoplado.efectos);

  const sinGit = await mkdtemp(join(tmpdir(), 'hu129-sin-git-'));
  t.after(() => rm(sinGit, { recursive: true, force: true }));
  const r = await intentarEjecutar(sinGit);
  assert.equal(r.resultado.iniciada, false);
  assertSinCoste(r.efectos);
});

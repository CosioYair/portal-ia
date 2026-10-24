import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSURE_REASONS, evaluateStoryClosure } from '@portal/domain';
import type { StoryClosureFacts } from '@portal/domain';
import { completeStory, getStoryClosureStatus } from '../src/services/story-closure.ts';
import type {
  RepositoryRecord,
  StoryClosureContext,
  StoryRecord
} from '../src/services/story-closure.ts';
import { registerStoryClosureRoutes } from '../src/routes/story-closure.ts';
import type { RouteHandler } from '../src/routes/story-closure.ts';

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// (a) Tabla de casos de la regla pura

const base: StoryClosureFacts = {
  hasRepository: true,
  workState: 'hecha',
  appliedLocally: true,
  mergedIntoMain: false,
  pushedToRemote: false,
  completed: false
};

const tabla: ReadonlyArray<readonly [string, StoryClosureFacts, boolean, string | null, string | null]> = [
  ['repo: sin integrar', base, false, CLOSURE_REASONS.noIntegrada, 'por_cerrar'],
  ['repo: integrada sin publicar', { ...base, mergedIntoMain: true }, false, CLOSURE_REASONS.noPublicada, 'por_cerrar'],
  ['repo: integrada y publicada', { ...base, mergedIntoMain: true, pushedToRemote: true }, true, null, 'por_cerrar'],
  ['repo: publicada pero sin integrar', { ...base, pushedToRemote: true }, false, CLOSURE_REASONS.noIntegrada, 'por_cerrar'],
  ['repo: en curso', { ...base, workState: 'en_curso' }, false, CLOSURE_REASONS.noIntegrada, 'en_curso'],
  ['repo: sin empezar', { ...base, workState: 'sin_empezar' }, false, CLOSURE_REASONS.noIntegrada, 'pendiente'],
  ['local: aplicada', { ...base, hasRepository: false }, true, null, 'por_cerrar'],
  ['local: no aplicada', { ...base, hasRepository: false, appliedLocally: false }, false, CLOSURE_REASONS.noAplicadaLocal, 'por_cerrar'],
  ['local: en curso', { ...base, hasRepository: false, appliedLocally: false, workState: 'en_curso' }, false, CLOSURE_REASONS.noAplicadaLocal, 'en_curso'],
  ['local: sin empezar', { ...base, hasRepository: false, appliedLocally: false, workState: 'sin_empezar' }, false, CLOSURE_REASONS.noAplicadaLocal, 'pendiente'],
  ['ya completada', { ...base, completed: true, mergedIntoMain: true, pushedToRemote: true }, false, CLOSURE_REASONS.yaCompletada, null]
];

for (const [nombre, facts, canClose, reason, indicator] of tabla) {
  test(`regla pura: ${nombre}`, () => {
    const result = evaluateStoryClosure(facts);
    assert.equal(result.canClose, canClose);
    assert.equal(result.reason, reason);
    assert.equal(result.indicator, indicator);
  });
}

// Utilidades de contexto

interface Fixture {
  readonly ctx: StoryClosureContext;
  readonly completed: string[];
}

function makeCtx(story: Partial<StoryRecord>, repo: RepositoryRecord | null): Fixture {
  const completed: string[] = [];
  const record: StoryRecord = {
    id: 'hu-120',
    projectId: 'proyecto-1',
    workState: 'hecha',
    appliedLocally: true,
    completed: false,
    branch: 'hu-120/cierre',
    mergedCommit: null,
    ...story
  };
  const ctx: StoryClosureContext = {
    getStory: async (id) => (id === record.id ? record : null),
    getRepository: async () => repo,
    markStoryCompleted: async (id) => {
      completed.push(id);
    }
  };
  return { ctx, completed };
}

// (b) Integración con repo git temporal y remoto bare

async function setupRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'hu120-'));
  const bare = join(dir, 'origin.git');
  const work = join(dir, 'work');
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
  g(work, 'checkout', '-b', 'hu-120/cierre');
  await writeFile(join(work, 'b.txt'), 'historia\n');
  g(work, 'add', '.');
  g(work, 'commit', '-m', 'cambios de la historia');
  g(work, 'checkout', 'main');
  return { work, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('con repositorio: historia sin integrar queda bloqueada', async (t) => {
  const s = await setupRepo();
  t.after(s.cleanup);
  const { ctx } = makeCtx({}, { path: s.work });
  const status = await getStoryClosureStatus(ctx, 'hu-120');
  assert.equal(status.canClose, false);
  assert.equal(status.reason, CLOSURE_REASONS.noIntegrada);
  assert.equal(status.hasRepository, true);
  assert.equal(status.indicator, 'por_cerrar');
});

test('con repositorio: integrada pero sin publicar queda bloqueada', async (t) => {
  const s = await setupRepo();
  t.after(s.cleanup);
  g(s.work, 'merge', '--no-ff', 'hu-120/cierre', '-m', 'integra hu-120');
  const { ctx } = makeCtx({}, { path: s.work });
  const status = await getStoryClosureStatus(ctx, 'hu-120');
  assert.equal(status.canClose, false);
  assert.equal(status.reason, CLOSURE_REASONS.noPublicada);
});

test('con repositorio: integrada y publicada permite cerrar', async (t) => {
  const s = await setupRepo();
  t.after(s.cleanup);
  g(s.work, 'merge', '--no-ff', 'hu-120/cierre', '-m', 'integra hu-120');
  g(s.work, 'push', 'origin', 'main');
  const { ctx, completed } = makeCtx({}, { path: s.work });
  const status = await getStoryClosureStatus(ctx, 'hu-120');
  assert.equal(status.canClose, true);
  assert.equal(status.reason, null);
  const result = await completeStory(ctx, 'hu-120');
  assert.equal(result.ok, true);
  assert.deepEqual(completed, ['hu-120']);
});

test('con repositorio: usa el commit registrado si la rama se borró tras fusionar', async (t) => {
  const s = await setupRepo();
  t.after(s.cleanup);
  const sha = g(s.work, 'rev-parse', 'hu-120/cierre');
  g(s.work, 'merge', '--no-ff', 'hu-120/cierre', '-m', 'integra hu-120');
  g(s.work, 'push', 'origin', 'main');
  g(s.work, 'branch', '-D', 'hu-120/cierre');
  const { ctx } = makeCtx({ mergedCommit: sha }, { path: s.work });
  const status = await getStoryClosureStatus(ctx, 'hu-120');
  assert.equal(status.canClose, true);
});

test('si git falla, el cierre queda bloqueado con un motivo explícito', async () => {
  const { ctx } = makeCtx({}, { path: join(tmpdir(), 'hu120-no-existe-nunca') });
  const status = await getStoryClosureStatus(ctx, 'hu-120');
  assert.equal(status.canClose, false);
  assert.match(status.reason ?? '', /No se pudo comprobar el estado de git/);
});

// (c) Proyecto sin repositorio

test('sin repositorio: cambios no aplicados bloquean el cierre', async () => {
  const { ctx, completed } = makeCtx({ appliedLocally: false }, null);
  const status = await getStoryClosureStatus(ctx, 'hu-120');
  assert.equal(status.canClose, false);
  assert.equal(status.reason, CLOSURE_REASONS.noAplicadaLocal);
  assert.equal(status.hasRepository, false);
  const result = await completeStory(ctx, 'hu-120');
  assert.equal(result.ok, false);
  assert.deepEqual(completed, []);
});

test('sin repositorio: cambios aplicados en local permiten cerrar', async () => {
  const { ctx, completed } = makeCtx({ appliedLocally: true }, null);
  const status = await getStoryClosureStatus(ctx, 'hu-120');
  assert.equal(status.canClose, true);
  assert.equal(status.reason, null);
  const result = await completeStory(ctx, 'hu-120');
  assert.equal(result.ok, true);
  assert.deepEqual(completed, ['hu-120']);
});

// (d) Rutas: la de completar responde 409 con el motivo

function registerRoutes(ctx: StoryClosureContext) {
  const handlers = new Map<string, RouteHandler>();
  registerStoryClosureRoutes(
    {
      get: (path, handler) => handlers.set(`GET ${path}`, handler),
      post: (path, handler) => handlers.set(`POST ${path}`, handler)
    },
    ctx
  );
  return async (key: string, params: unknown): Promise<{ status: number; body: unknown }> => {
    const handler = handlers.get(key);
    assert.ok(handler, `ruta no registrada: ${key}`);
    let captured = { status: 0, body: undefined as unknown };
    await handler(
      { params },
      {
        code: (status) => ({
          send: (body) => {
            captured = { status, body };
            return undefined;
          }
        })
      }
    );
    return captured;
  };
}

test('POST /stories/:id/complete devuelve 409 con el motivo cuando está bloqueada', async (t) => {
  const s = await setupRepo();
  t.after(s.cleanup);
  const { ctx, completed } = makeCtx({}, { path: s.work });
  const call = registerRoutes(ctx);

  const closure = await call('GET /stories/:id/closure', { id: 'hu-120' });
  assert.equal(closure.status, 200);
  assert.equal((closure.body as { canClose: boolean }).canClose, false);

  const res = await call('POST /stories/:id/complete', { id: 'hu-120' });
  assert.equal(res.status, 409);
  assert.equal((res.body as { message: string }).message, CLOSURE_REASONS.noIntegrada);
  assert.equal((res.body as { code: string }).code, 'cierre_bloqueado');
  assert.deepEqual(completed, []);
});

test('POST /stories/:id/complete cierra (200) sin repositorio con cambios aplicados', async () => {
  const { ctx, completed } = makeCtx({ appliedLocally: true }, null);
  const call = registerRoutes(ctx);
  const res = await call('POST /stories/:id/complete', { id: 'hu-120' });
  assert.equal(res.status, 200);
  assert.deepEqual(completed, ['hu-120']);
});

test('las rutas validan el identificador y responden 404 si la historia no existe', async () => {
  const { ctx } = makeCtx({}, null);
  const call = registerRoutes(ctx);
  assert.equal((await call('POST /stories/:id/complete', { id: '../x' })).status, 400);
  assert.equal((await call('GET /stories/:id/closure', { id: 'otra' })).status, 404);
});

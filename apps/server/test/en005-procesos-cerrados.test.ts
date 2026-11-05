import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import type { ExecutionResult, Process } from '@portal-ia/domain';

/** EN-005 · Un proceso antiguo de una historia integrada, completada o descartada no se reactiva sin «Reabrir la historia». */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en005-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { projectsRepo, processesRepo, backlogRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { retryStory } = await import('../src/services/storyExecution.ts');
const { storyClosureOf } = await import('../src/services/storyClosure.ts');
const { threadRepo } = await import('../src/services/storyThread.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
const boot = runBootstrap();
const slug = boot.workspace.slug;
const project = projectsRepo(slug).list()[0];

// createStoryProcess (usado por la reapertura) necesita un repositorio registrado.
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en005-repo-'));
fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoDir, 'src/a.ts'), 'export const a = 1;\n');
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repoDir });
projectsRepo(slug).setRepository(project.id, repoDir, 'main');

function result(over: Partial<ExecutionResult> = {}): ExecutionResult {
  return { plan: null, implementationSummary: null, changes: [], verifyCommands: [], review: null, applied: null, verifications: [], ...over };
}
function storyProcess(itemId: string, createdAt: string): Process {
  const p = processesRepo(slug).create({ projectId: project.id, kind: 'story_execution', title: 'HU-990: Historia cerrada', estimatedUsd: 0.3, backlogItemId: itemId,
    steps: [{ agentId: 'a-test', agentName: 'Coordinador del Proyecto', title: 'Plan', model: 'claude-sonnet-4-5' }] });
  workspaceDb(slug).prepare(`UPDATE processes SET created_at = ? WHERE id = ?`).run(createdAt, p.id);
  return processesRepo(slug).get(p.id)!;
}
const MERGED = { into: 'main', commit: 'fff0001', mergedAt: '2026-05-02T02:00:00.000Z' } as any;

/** Historia con la iteración 1 antigua (fallida, sin decisión pendiente) y la iteración 2 vigente. */
function scenario(title: string, day: string, closeAs: 'merged' | 'done' | 'discarded') {
  const item = addManualItem(slug, project.id, { title, criterion: 'no se reactiva sin intención' });
  const old = storyProcess(item.id, `${day}T00:00:00.000Z`);
  processesRepo(slug).finish(old.id, 'failed', 'fallo antiguo');
  const cur = storyProcess(item.id, `${day}T01:00:00.000Z`);
  if (closeAs === 'merged') processesRepo(slug).setResult(cur.id, result({ merged: MERGED }));
  processesRepo(slug).finish(cur.id, 'done', null);
  backlogRepo(slug).setStatus(item.id, closeAs === 'discarded' ? 'discarded' : 'done', cur.id);
  return { item, old: processesRepo(slug).get(old.id)!, cur: processesRepo(slug).get(cur.id)! };
}

const ROUTES: [string, unknown][] = [
  ['continue', {}],
  ['authorize', { budgetUsd: 1, authorized: true }],
  ['accept-plan', { authorized: true }],
  ['recover', {}],
  ['retry', {}],
  ['apply', { authorized: true }],
  ['verify', { authorized: true }]
];
const fingerprint = (id: string) => { const p = processesRepo(slug).get(id)!; return JSON.stringify([p.status, p.spentUsd, p.authorizedAt, p.startedAt, p.finishedAt, p.steps.length, !!p.result?.merged]); };
const statusCodeOf = (e: any) => e?.statusCode ?? e?.status;

test('pura: storyClosureOf bloquea la iteración antigua y nunca la integrada', () => {
  const base = (over: Partial<Process>): Process => ({ id: 'x', projectId: 'pr', kind: 'story_execution', title: 't', status: 'failed', budgetUsd: 0, estimatedUsd: 0, spentUsd: 0, inputTokens: 0, outputTokens: 0,
    createdAt: '2026-01-01T00:00:00.000Z', authorizedAt: null, startedAt: null, finishedAt: null, error: null, steps: [], result: null, delegation: null, backlogItemId: 'b1', ...over } as Process);
  const it1 = base({ id: 'it1' });
  const it2 = base({ id: 'it2', status: 'done', createdAt: '2026-01-02T00:00:00.000Z', result: result({ merged: MERGED }) });
  const c = storyClosureOf({ status: 'done', lastProcessId: 'it2' }, [it1, it2], it1);
  assert.ok(c);
  assert.equal(c!.state, 'merged');
  assert.equal(c!.currentProcessId, 'it2');
  assert.equal(c!.iteration, 2);
  assert.match(c!.message, /iteración 2/);
  assert.equal(storyClosureOf({ status: 'done', lastProcessId: 'it2' }, [it1, it2], it2), null, 'la integrada sigue disponible (publish, runtime-check)');
  assert.equal(storyClosureOf({ status: 'in_progress', lastProcessId: 'it1' }, [it1], it1), null, 'historia abierta sin integrar: sin bloqueo');
});

test('historia integrada (caso HU-178): GET expone closure y cada ruta devuelve 409 sin cambiar proceso ni historia', async () => {
  const app = await buildApp();
  const { item, old, cur } = scenario('Integrada en main', '2026-05-01', 'merged');

  const g = await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/processes/${old.id}` });
  assert.equal(g.statusCode, 200, g.body);
  assert.equal(g.json().closure?.state, 'merged');
  assert.equal(g.json().closure?.currentProcessId, cur.id);
  assert.equal(g.json().closure?.iteration, 2);
  const gc = await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/processes/${cur.id}` });
  assert.ok(!gc.json().closure, 'el proceso integrado no se marca como cerrado');

  const before = fingerprint(old.id);
  for (const [action, payload] of ROUTES) {
    const r = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/processes/${old.id}/${action}`, payload: payload as any });
    assert.equal(r.statusCode, 409, `${action}: ${r.body}`);
    assert.equal(r.json().code, 'story_closed', action);
    assert.match(r.json().error, /iteración 2/, action);
    assert.ok(String(r.json().error).includes(cur.id), `${action}: el mensaje nombra el proceso vigente`);
    assert.equal(r.json().closure?.currentProcessId, cur.id, action);
    assert.equal(fingerprint(old.id), before, `${action}: el proceso antiguo no cambia`);
    assert.equal(backlogRepo(slug).get(item.id)!.status, 'done', `${action}: la historia no vuelve a in_progress`);
    assert.equal(backlogRepo(slug).get(item.id)!.lastProcessId, cur.id, `${action}: la referencia al vigente se conserva`);
  }
  await app.close();
});

for (const state of ['done', 'discarded'] as const) {
  test(`historia ${state === 'done' ? 'completada' : 'descartada'} sin integrar: 409 en cada ruta sobre el proceso antiguo`, async () => {
    const app = await buildApp();
    const { item, old, cur } = scenario(`Cerrada ${state}`, state === 'done' ? '2026-05-03' : '2026-05-04', state);
    const g = await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/processes/${old.id}` });
    assert.equal(g.json().closure?.state, state);
    assert.equal(g.json().closure?.currentProcessId, cur.id);
    const before = fingerprint(old.id);
    for (const [action, payload] of ROUTES) {
      const r = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/processes/${old.id}/${action}`, payload: payload as any });
      assert.equal(r.statusCode, 409, `${action}: ${r.body}`);
      assert.match(r.json().error, /iteración 2/, action);
      assert.equal(fingerprint(old.id), before, action);
      assert.equal(backlogRepo(slug).get(item.id)!.status, state, action);
    }
    await app.close();
  });
}

test('retryStory rechaza con 409 una historia integrada en main (sin reapertura explícita)', () => {
  const { item, old, cur } = scenario('Reintento integrada', '2026-05-05', 'merged');
  for (const id of [old.id, cur.id]) {
    assert.throws(() => retryStory(slug, id), (e: any) => statusCodeOf(e) === 409, id);
  }
  assert.equal(backlogRepo(slug).get(item.id)!.status, 'done');
  assert.equal(processesRepo(slug).listByBacklogItem(item.id).length, 2, 'no se creó ninguna iteración');
});

test('Reabrir la historia: exige confirmación y motivo; crea una iteración pendiente de autorización y deja constancia', async () => {
  const app = await buildApp();
  const { item, old, cur } = scenario('Reabrir explícitamente', '2026-05-06', 'merged');
  const url = `/api/workspaces/${slug}/processes/${old.id}/reopen-story`;
  assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, payload: { reason: 'Falta un caso del criterio' } })).statusCode, 400, 'sin confirm');
  assert.equal((await app.inject({ method: 'POST', url, payload: { confirm: true, reason: 'corto' } })).statusCode, 400, 'motivo demasiado corto');
  assert.equal(processesRepo(slug).listByBacklogItem(item.id).length, 2);
  assert.equal(backlogRepo(slug).get(item.id)!.status, 'done');

  const reason = 'Falta cubrir el caso de la historia descartada';
  const r = await app.inject({ method: 'POST', url, payload: { confirm: true, reason } });
  assert.equal(r.statusCode, 200, r.body);
  const created = r.json() as Process;
  assert.notEqual(created.id, old.id);
  assert.notEqual(created.id, cur.id);
  assert.equal(created.status, 'pending_authorization');
  assert.equal(created.backlogItemId, item.id);
  assert.equal(created.spentUsd, 0, 'reabrir no consume IA');

  const story = backlogRepo(slug).get(item.id)!;
  assert.notEqual(story.status, 'in_progress', 'reabrir no pone la historia en marcha');
  assert.equal(story.status, 'pending');
  const msgs = threadRepo(slug).messages(item.id);
  assert.ok(msgs.some(m => m.content.includes(reason)), 'el motivo queda en el hilo de la historia');

  // El proceso antiguo sigue bloqueado y ahora apunta a la iteración nueva; la nueva queda libre.
  const g = await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/processes/${old.id}` });
  assert.equal(g.json().closure?.currentProcessId, created.id);
  const c = await app.continueBlocked?.(); void c;
  const again = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/processes/${old.id}/continue`, payload: {} });
  assert.equal(again.statusCode, 409);
  assert.notEqual(backlogRepo(slug).get(item.id)!.status, 'in_progress');
  const gn = await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/processes/${created.id}` });
  assert.ok(!gn.json().closure, 'la iteración reabierta no está cerrada');
  await app.close();
});

test('interfaz: ProcessView y StoryFlowPanel ocultan las acciones de reactivación con closure y ofrecen «Reabrir la historia»', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const web = path.resolve(here, '../../web/src');
  const view = fs.readFileSync(path.join(web, 'screens/ProcessView.tsx'), 'utf8');
  const flow = fs.readFileSync(path.join(web, 'components/StoryFlowPanel.tsx'), 'utf8');
  const api = fs.readFileSync(path.join(web, 'lib/api.ts'), 'utf8');

  assert.ok(view.includes('proc.closure'), 'ProcessView lee el cierre del proceso');
  assert.ok(view.includes('Esta historia ya está'), 'aviso de historia cerrada');
  assert.ok(/iteración \$\{closure\.currentIteration\}/.test(view), 'el aviso nombra la iteración');
  assert.ok(view.includes('/procesos/${closure.currentProcessId'), 'enlace al proceso vigente');
  assert.ok(view.includes('Reabrir la historia'), 'acción explícita de reapertura');
  const auth = view.indexOf('id="sec-authorize"');
  assert.ok(auth > 0 && view.slice(Math.max(0, auth - 200), auth).includes('!closure'), 'Autorizar oculto con closure');
  const recovery = view.indexOf('id="sec-recovery"');
  assert.ok(recovery > 0 && view.slice(Math.max(0, recovery - 200), recovery).includes('!closure'), 'recuperación oculta con closure');
  const res = view.indexOf('id="sec-result"');
  assert.ok(res > 0 && view.slice(Math.max(0, res - 200), res).includes('!closure'), 'Aplicar y Verificar ocultos con closure');

  assert.ok(flow.includes('const closed = !!proc.closure'), 'StoryFlowPanel detecta el cierre');
  assert.ok(flow.includes('Esta historia ya está'), 'StoryFlowPanel muestra el aviso');
  assert.ok(/!closed/.test(flow), 'StoryFlowPanel condiciona sus acciones a closed');

  assert.ok(api.includes('reopen-story') && api.includes('confirm: true'), 'api.reopenStory envía la confirmación');
});

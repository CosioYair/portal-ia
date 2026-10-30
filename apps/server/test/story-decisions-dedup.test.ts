import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { ExecutionResult, PendingDecision, Process } from '@portal-ia/domain';

/** HU-161 · Una autorización vigente por historia: varias iteraciones de la misma historia, sin duplicados ni borrados. */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu161-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { projectsRepo, processesRepo, workspaceDb, consolidateDuplicateDecisions } = await import('../src/db/workspace.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createAssessment } = await import('../src/services/assessment.ts');
const { createCompany } = await import('../src/services/companies.ts');
const { consolidateDecisions } = await import('../src/services/inbox.ts');
const { iterateStory, supersedePreviousIterations, threadRepo } = await import('../src/services/storyThread.ts');
const { buildApp } = await import('../src/app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
const boot = runBootstrap();
const slug = boot.workspace.slug;
const project = projectsRepo(slug).list()[0];

function proc(over: Partial<Process> = {}): Process {
  return {
    id: 'p1', projectId: 'pr1', kind: 'story_execution', title: 'HU-161: Autorizaciones', status: 'pending_authorization',
    budgetUsd: 0, estimatedUsd: 0.4, spentUsd: 0, inputTokens: 0, outputTokens: 0,
    createdAt: '2026-01-01T00:00:00.000Z', authorizedAt: null, startedAt: null, finishedAt: null,
    error: null, steps: [], result: null, delegation: null, backlogItemId: 'b1', ...over
  };
}
function result(over: Partial<ExecutionResult> = {}): ExecutionResult {
  return { plan: null, implementationSummary: null, changes: [], verifyCommands: [], review: null, applied: null, verifications: [], ...over };
}
const forStory = (list: PendingDecision[], storyId: string) => list.filter(d => d.storyId === storyId);

test('pura: 3 iteraciones pendientes de una historia → 1 entrada con iteración 3 y 2 superadas; otras historias y procesos sin historia no se agrupan', () => {
  const ps = [
    proc({ id: 'a1', createdAt: '2026-01-01T00:00:00.000Z' }),
    proc({ id: 'a2', createdAt: '2026-01-02T00:00:00.000Z' }),
    proc({ id: 'a3', createdAt: '2026-01-03T00:00:00.000Z' }),
    proc({ id: 'b1x', backlogItemId: 'b2', createdAt: '2026-01-02T12:00:00.000Z' }),
    proc({ id: 'e1', kind: 'initial_assessment', backlogItemId: null }),
    proc({ id: 'e2', kind: 'initial_assessment', backlogItemId: null, createdAt: '2026-01-04T00:00:00.000Z' })
  ];
  const out = consolidateDecisions('x', ps);
  const a = forStory(out, 'b1');
  assert.equal(a.length, 1);
  assert.equal(a[0].processId, 'a3');
  assert.equal(a[0].iteration, 3);
  assert.equal(a[0].supersededCount, 2);
  const b = forStory(out, 'b2');
  assert.equal(b.length, 1);
  assert.equal(b[0].iteration, 1);
  assert.equal(b[0].supersededCount, 0);
  const loose = out.filter(d => d.storyId === null);
  assert.deepEqual(loose.map(d => d.processId).sort(), ['e1', 'e2']);
  assert.equal(out.length, 4);
});

test('pura: diff o integración de la iteración 1 + iteración 2 pendiente → una sola entrada (la vigente); una restaurada prevalece', () => {
  const changes = [{ path: 'a.ts', action: 'modify' as const, content: 'x', diff: '+x', before: 1, after: 1 }];
  const it1diff = proc({ id: 'd1', status: 'done', finishedAt: '2026-01-01T01:00:00.000Z', result: result({ changes }) });
  const it2 = proc({ id: 'd2', createdAt: '2026-01-02T00:00:00.000Z' });
  const one = consolidateDecisions('x', [it1diff, it2]);
  assert.equal(one.length, 1);
  assert.equal(one[0].kind, 'process_authorization');
  assert.equal(one[0].iteration, 2);
  assert.equal(one[0].supersededCount, 1);

  const applied = { branch: 'portal-ia/hu-161', commit: 'abc1234', files: ['a.ts'], appliedAt: '2026-01-01T02:00:00.000Z' };
  const it1int = proc({ id: 'i1', status: 'done', finishedAt: '2026-01-01T01:00:00.000Z', result: result({ changes, applied }) });
  const two = consolidateDecisions('x', [it1int, { ...it2, id: 'i2' }]);
  assert.equal(two.length, 1);
  assert.equal(two[0].processId, 'i2');

  // Restaurada la iteración 1: las otras quedan marcadas por ella → la vigente es la 1.
  const restored = consolidateDecisions('x', [
    proc({ id: 'r1' }),
    proc({ id: 'r2', createdAt: '2026-01-02T00:00:00.000Z', supersededBy: 'r1' }),
    proc({ id: 'r3', createdAt: '2026-01-03T00:00:00.000Z', supersededBy: 'r1' })
  ]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].processId, 'r1');
  assert.equal(restored[0].iteration, 1);
  assert.equal(restored[0].supersededCount, 2);
});

function storyProcess(itemId: string, createdAt: string): Process {
  const p = processesRepo(slug).create({ projectId: project.id, kind: 'story_execution', title: 'HU-900: Varias iteraciones', estimatedUsd: 0.3, backlogItemId: itemId,
    steps: [{ agentId: 'a-test', agentName: 'Coordinador del Proyecto', title: 'Plan', model: 'claude-sonnet-4-5' }] });
  // Fecha fija: el número de iteración no depende de que dos procesos se creen en el mismo milisegundo.
  workspaceDb(slug).prepare(`UPDATE processes SET created_at = ? WHERE id = ?`).run(createdAt, p.id);
  return processesRepo(slug).get(p.id)!;
}
const snapshot = () => (workspaceDb(slug).prepare(`SELECT id, status FROM processes ORDER BY id`).all() as any[]).map(r => `${r.id}:${r.status}`);

test('API: migración idempotente sin borrados, bandeja consolidada, 409 sobre superadas, historial, restauración reversible y espacios aislados', async () => {
  const app = await buildApp();
  const inbox = async (s = slug) => (await app.inject({ method: 'GET', url: `/api/workspaces/${s}/inbox` })).json() as PendingDecision[];
  const A = addManualItem(slug, project.id, { title: 'Varias iteraciones', criterion: 'una sola autorización' });
  const B = addManualItem(slug, project.id, { title: 'Otra historia', criterion: 'no se mezcla' });
  const p1 = storyProcess(A.id, '2026-02-01T00:00:00.000Z');
  const p2 = storyProcess(A.id, '2026-02-02T00:00:00.000Z');
  const p3 = storyProcess(A.id, '2026-02-03T00:00:00.000Z');
  const pb = storyProcess(B.id, '2026-02-02T12:00:00.000Z');
  const ev = createAssessment(slug, project.id);

  // Antes de migrar: duplicados existentes sin marcar, y aun así la bandeja ya muestra una sola entrada por historia.
  let list = await inbox();
  assert.equal(forStory(list, A.id).length, 1);
  assert.equal(forStory(list, A.id)[0].processId, p3.id);

  // Consolidación de lo existente: copia de seguridad, sin borrar filas ni cambiar estados; idempotente.
  const before = snapshot();
  const first = consolidateDuplicateDecisions(slug);
  assert.deepEqual(first.marked.map(m => m.processId).sort(), [p1.id, p2.id].sort());
  assert.ok(first.marked.every(m => m.supersededBy === p3.id));
  assert.ok(first.backup && fs.existsSync(first.backup), 'copia de seguridad previa');
  assert.deepEqual(snapshot(), before);
  const second = consolidateDuplicateDecisions(slug);
  assert.deepEqual(second.marked, []);
  assert.equal(second.backup, null);
  assert.deepEqual(snapshot(), before);
  assert.equal(processesRepo(slug).get(p1.id)!.supersededBy, p3.id);

  list = await inbox();
  const a = forStory(list, A.id);
  assert.equal(a.length, 1);
  assert.equal(a[0].iteration, 3);
  assert.equal(a[0].supersededCount, 2);
  assert.equal(forStory(list, B.id).length, 1);
  assert.equal(forStory(list, B.id)[0].processId, pb.id);
  assert.ok(list.some(d => d.processId === ev.id && d.storyId === null), 'la evaluación sigue aparte');

  // Decidir sobre una superada: 409 y sin efectos.
  const stale = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/inbox/process_authorization/${p1.id}/decision`, payload: { verdict: 'approve' } });
  assert.equal(stale.statusCode, 409);
  assert.match(stale.json().error, /superada por la iteración 3/);
  assert.equal(processesRepo(slug).get(p1.id)!.status, 'pending_authorization');
  assert.equal(processesRepo(slug).get(p1.id)!.spentUsd, 0);

  // Rutas directas (chat y vista del proceso): una iteración superada tampoco se autoriza, aplica, integra ni publica.
  const direct = [
    ['authorize', { budgetUsd: 1, authorized: true }],
    ['apply', { authorized: true }],
    ['merge', { authorized: true }],
    ['publish', { authorized: true }]
  ] as const;
  for (const [action, payload] of direct) {
    const r = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/processes/${p1.id}/${action}`, payload });
    assert.equal(r.statusCode, 409, `${action}: ${r.body}`);
    assert.match(r.json().error, /superada por la iteración 3/, action);
    assert.equal(r.json().code, 'superseded', action);
  }
  assert.equal(processesRepo(slug).get(p1.id)!.status, 'pending_authorization');
  assert.equal(processesRepo(slug).get(p1.id)!.spentUsd, 0);
  assert.equal(processesRepo(slug).get(p1.id)!.authorizedAt, null);
  assert.deepEqual(snapshot(), before, 'las rutas directas sobre una superada no cambian nada');

  // Historial: la vigente y las superadas (más recientes primero).
  const hist = (await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/stories/${A.id}/decisions` })).json();
  assert.equal(hist.current.processId, p3.id);
  assert.deepEqual(hist.superseded.map((d: any) => d.processId), [p2.id, p1.id]);
  assert.equal(hist.superseded[0].supersededByIteration, 3);

  // Restaurar: exige confirmación, es reversible y deja exactamente una vigente.
  const url = (id: string) => `/api/workspaces/${slug}/inbox/superseded/${id}/restore`;
  assert.equal((await app.inject({ method: 'POST', url: url(p1.id), payload: {} })).statusCode, 400);
  const r1 = await app.inject({ method: 'POST', url: url(p1.id), payload: { authorized: true } });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.deepEqual(r1.json().superseded, [p3.id]);
  list = await inbox();
  assert.equal(forStory(list, A.id).length, 1);
  assert.equal(forStory(list, A.id)[0].processId, p1.id);
  assert.equal(forStory(list, A.id)[0].iteration, 1);
  assert.equal((await app.inject({ method: 'POST', url: url(p1.id), payload: { authorized: true } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/inbox/process_authorization/${p3.id}/decision`, payload: { verdict: 'approve' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: url(p3.id), payload: { authorized: true } })).statusCode, 200);
  list = await inbox();
  assert.equal(forStory(list, A.id).length, 1);
  assert.equal(forStory(list, A.id)[0].processId, p3.id);
  assert.deepEqual(snapshot(), before, 'restaurar no borra filas ni cambia estados');
  assert.deepEqual(consolidateDuplicateDecisions(slug).marked, [], 'la consolidación respeta las restauraciones');

  // Espacios distintos no se mezclan.
  const other = createCompany('Empresa HU-161');
  assert.deepEqual(await inbox(other.slug), []);
  assert.equal((await app.inject({ method: 'GET', url: `/api/workspaces/${other.slug}/stories/${A.id}/decisions` })).statusCode, 404);
  await app.close();
});

test('iterateStory: la iteración 1 integrada sin publicar queda superada por la nueva al crearla; /inbox muestra solo la iteración 2 y el hilo lo registra', async () => {
  // createStoryProcess necesita un repositorio registrado (estimación del contexto); repositorio git temporal.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu161-repo-'));
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src/a.ts'), 'export const a = 1;\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repoDir });
  projectsRepo(slug).setRepository(project.id, repoDir, 'main');
  const app = await buildApp();
  const inbox = async () => (await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/inbox` })).json() as PendingDecision[];

  const C = addManualItem(slug, project.id, { title: 'Iterar sin duplicar', criterion: 'una sola autorización vigente' });
  const p1 = storyProcess(C.id, '2020-01-01T00:00:00.000Z');
  const changes = [{ path: 'src/a.ts', action: 'modify' as const, content: 'export const a = 2;\n', diff: '+export const a = 2;', before: 1, after: 1 }];
  processesRepo(slug).setResult(p1.id, result({
    changes,
    applied: { branch: 'portal-ia/hu-900', commit: 'abc1234', files: ['src/a.ts'], appliedAt: '2020-01-01T01:00:00.000Z', worktree: path.join(repoDir, 'wt') } as any,
    merged: { into: 'main', commit: 'fff0001', mergedAt: '2020-01-01T02:00:00.000Z' } as any
  }));
  processesRepo(slug).finish(p1.id, 'done', null);
  let list = await inbox();
  assert.equal(forStory(list, C.id).length, 1);
  assert.equal(forStory(list, C.id)[0].kind, 'publish', 'la iteración 1 espera la decisión de publicar');

  // Nueva iteración: la anterior queda superada en la misma transacción, sin cambiar su estado ni rechazarla.
  const { process: next, actions } = await iterateStory(slug, C.id, 'otra vuelta');
  assert.notEqual(next.id, p1.id);
  assert.equal(next.status, 'pending_authorization');
  const old = processesRepo(slug).get(p1.id)!;
  assert.equal(old.supersededBy, next.id);
  assert.ok(old.supersededAt, 'fecha de superación registrada');
  assert.equal(old.status, 'done');
  assert.equal(old.result!.rejected, undefined, 'lo integrado no se rechaza');
  assert.match(actions.join(' '), /marcada como superada/);

  list = await inbox();
  const c = forStory(list, C.id);
  assert.equal(c.length, 1, 'una sola entrada pendiente para la historia');
  assert.equal(c[0].processId, next.id);
  assert.equal(c[0].kind, 'process_authorization');
  assert.equal(c[0].iteration, 2);
  assert.equal(c[0].supersededCount, 1);

  const sys = threadRepo(slug).messages(C.id).filter(m => m.role === 'system');
  assert.ok(sys.some(m => m.processId === next.id && /Iteración 2 creada/.test(m.content) && /marcada como superada/.test(m.content)), JSON.stringify(sys.map(m => m.content)));

  // La superada no se publica desde la bandeja, y volver a superar no marca nada más.
  const stale = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/inbox/publish/${p1.id}/decision`, payload: { verdict: 'approve' } });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.match(stale.json().error, /superada por la iteración 2/);
  assert.ok(!processesRepo(slug).get(p1.id)!.result!.published, 'no se publicó nada');
  assert.deepEqual(supersedePreviousIterations(slug, C.id, next.id), []);
  await app.close();
});

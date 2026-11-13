import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Portal IA 3 · «Trabajo»: una sola lista con historias y encargos y su estado veraz (services/work.ts y su ruta).
 * Datos sintéticos, sin IA. Cubre lo que señaló la revisión independiente: una historia cuyo intento NUEVO espera
 * autorización debe figurar en «Te necesitan» (no «Por empezar»), y la vista no depende de last_process_id.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3w-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { backlogRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess } = await import('../src/services/storyExecution.ts');
const { createAssignment } = await import('../src/services/assignments.ts');
const { assignmentState, storyState, workView } = await import('../src/services/work.ts');

const S = 'portal-ia';
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3w-repo-'));
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { await app.close(); });

const applied = { branch: 'portal-ia/hu-1', commit: 'abc1234', worktree: 'x' };
const proc = (status: string, result: any = null, extra: any = {}) => ({ status, result, steps: [], ...extra }) as any;

test('estado de una historia: el registro manda en los extremos; en medio, su último intento', () => {
  assert.equal(storyState({ status: 'done' }, proc('done', { applied, pipeline: { state: 'stopped', pauseKind: 'limit' } })).label, 'Aceptada y cerrada');
  assert.equal(storyState({ status: 'discarded' }, undefined).label, 'Descartada');
  assert.equal(storyState({ status: 'pending' }, undefined).key, 'todo');
  assert.equal(storyState({ status: 'review' }, proc('done', { applied, pipeline: { state: 'stopped', pauseKind: 'limit' } })).label, 'Detenido sin terminar');
  assert.equal(storyState({ status: 'review' }, proc('done', { applied, pipeline: { state: 'verified' } })).label, 'Listo para revisar');
  // Integrada pero sin cerrar NO es «terminada»: falta la aceptación del propietario.
  const merged = storyState({ status: 'review' }, proc('done', { applied, merged: { into: 'main', commit: 'c' } }));
  assert.equal(merged.label, 'Integrada · falta tu aceptación'); assert.equal(merged.needsOwner, true); assert.equal(merged.open, true);
  assert.equal(storyState({ status: 'pending' }, proc('done', { applied, rejected: { at: 'x', reason: 'y' } })).label, 'Por retomar');
});

test('estado de un encargo: borrador, aceptado, cancelado, integrado sin aceptar, fallido sin entrega', () => {
  assert.equal(assignmentState({ status: 'draft' }, undefined).label, 'Borrador · sin autorizar');
  assert.equal(assignmentState({ status: 'accepted' }, proc('done', { applied })).open, false);
  assert.equal(assignmentState({ status: 'cancelled' }, undefined).open, false);
  assert.equal(assignmentState({ status: 'failed' }, undefined).label, 'No terminó');
  assert.equal(assignmentState({ status: 'needs_owner' }, proc('done', { applied, pipeline: { state: 'stopped', pauseKind: 'gauntlet' } })).label, 'Detenido sin terminar');
  assert.equal(assignmentState({ status: 'ready_for_review' }, proc('done', { applied, merged: { into: 'main', commit: 'c' } })).label, 'Integrado · falta tu aceptación');
});

test('workView: historias y encargos juntos, agrupados y con lo que te necesita primero; el intento nuevo pendiente de autorizar cuenta', async () => {
  const a = addManualItem(S, project.id, { title: 'Historia sin empezar', criterion: 'c1' });
  const b = addManualItem(S, project.id, { title: 'Historia con intento pendiente de autorizar', criterion: 'c2' });
  const c = addManualItem(S, project.id, { title: 'Historia cerrada', criterion: 'c3' });
  const d = addManualItem(S, project.id, { title: 'Historia detenida', criterion: 'c4' });
  const pb = createStoryProcess(S, project.id, b.id);
  assert.notEqual(backlogRepo(S).get(b.id)!.lastProcessId, pb.id, 'el intento recién preparado no figura en last_process_id (la vista no puede depender de él)');
  backlogRepo(S).setStatus(c.id, 'done', null);
  const pd = createStoryProcess(S, project.id, d.id);
  processesRepo(S).setResult(pd.id, { ...pd.result!, applied, pipeline: { state: 'stopped', pauseKind: 'limit', reason: 'test sigue fallando' } } as any);
  processesRepo(S).finish(pd.id, 'done');
  createAssignment(S, project.id, { request: 'Arregla el saludo sin crear historias, por favor.', title: 'Saludo completo', objective: 'Que el saludo se lea entero en cualquier ancho.', criteria: ['No se corta a 375 px.'] });

  const v = workView(S, project.id);
  const by = (id: string) => v.items.find(i => i.id === id)!;
  assert.equal(by(a.id).segment, 'todo'); assert.equal(by(a.id).state.label, 'Por empezar');
  assert.equal(by(b.id).segment, 'needs_you', 'espera tu autorización: te necesita'); assert.equal(by(b.id).state.label, 'Espera tu autorización'); assert.equal(by(b.id).processId, pb.id);
  assert.equal(by(c.id).segment, 'done'); assert.equal(by(c.id).state.label, 'Aceptada y cerrada');
  assert.equal(by(d.id).segment, 'needs_you'); assert.equal(by(d.id).state.label, 'Detenido sin terminar');
  const en = v.items.find(i => i.kind === 'assignment')!;
  assert.equal(en.code, 'EN-001'); assert.equal(en.segment, 'needs_you'); assert.match(en.ask, /sin crear historias/, 'conserva la petición con tus palabras');
  assert.deepEqual(v.counts, { needs_you: 3, running: 0, todo: 1, done: 1 });
  assert.deepEqual(v.items.map(i => i.segment), ['needs_you', 'needs_you', 'needs_you', 'todo', 'done'], 'primero lo que te necesita, al final lo terminado');
  for (const i of v.items) assert.doesNotMatch(`${i.state.label} ${i.state.meaning}`, /completad/i);

  const res = await app.inject({ method: 'GET', url: `/api/workspaces/${S}/projects/${project.id}/work` });
  assert.equal(res.statusCode, 200); assert.deepEqual(res.json().counts, v.counts);
  assert.equal((await app.inject({ method: 'GET', url: `/api/workspaces/no-existe/projects/${project.id}/work` })).statusCode, 404);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/workspaces/${S}/projects/otro-proyecto/work` })).json().items, [], 'un proyecto ajeno no devuelve nada');
});

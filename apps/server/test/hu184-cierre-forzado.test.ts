import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * HU-184 · Cierre forzado: motivo obligatorio, comprobaciones omitidas en la respuesta y registro en el hilo de la
 * historia. Sin red ni IA: proveedor simulado y procesos creados directamente en la base.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu184-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo, backlogRepo } = await import('../src/db/workspace.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { threadRepo } = await import('../src/services/storyThread.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];

const app = await buildApp();
after(async () => { await app.close(); });
const close = (id: string, payload?: unknown) => app.inject({ method: 'POST', url: `${W}/backlog/${id}/done`, payload: payload as any });

/** Historia con una iteración aplicada en su rama pero sin integrar en main ni prueba manual. */
function appliedNotMerged(title: string) {
  const item = addManualItem(S, project.id, { title, description: 'Prueba HU-184', criterion: 'Se cierra con motivo' });
  const p = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title, estimatedUsd: 0, steps: [], backlogItemId: item.id } as any);
  processesRepo(S).authorize(p.id, 1);
  processesRepo(S).setResult(p.id, { plan: null, implementationSummary: 'simulado', changes: [], verifyCommands: [], review: null, verifications: [], applied: { branch: `portal-ia/hu184-${p.id.slice(0, 6)}`, commit: 'a'.repeat(40), files: ['f.txt'], appliedAt: new Date().toISOString() } } as any);
  processesRepo(S).finish(p.id, 'done', null as any);
  const repo = backlogRepo(S) as any;
  if (typeof repo.setLastProcess === 'function') repo.setLastProcess(item.id, p.id);
  return item;
}

/** Mensajes del hilo de la historia (story_threads). */
function threadOf(itemId: string): Array<{ role: string; content: string }> {
  const t = threadRepo(S) as any;
  const fn = t.messages ?? t.list ?? t.listFor ?? t.forItem;
  assert.equal(typeof fn, 'function', 'threadRepo debe exponer una lectura del hilo de la historia');
  const rows = fn.call(t, itemId);
  assert.ok(Array.isArray(rows), 'la lectura del hilo devuelve una lista');
  return rows;
}
const forcedMsgs = (itemId: string) => threadOf(itemId).filter(m => m.role === 'system' && /Cierre forzado/.test(m.content));

test('force:true sin motivo, vacío o solo con espacios: 400 «Indica el motivo» y sin efectos', async () => {
  const item = appliedNotMerged('cierre forzado sin motivo');
  for (const payload of [{ force: true }, { force: true, reason: '' }, { force: true, reason: '   \n\t ' }]) {
    const r = await close(item.id, payload);
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().code, 'owner_reason_required');
    assert.equal(r.json().error, 'Indica el motivo');
  }
  assert.notEqual(backlogRepo(S).get(item.id)!.status, 'done', 'la historia sigue abierta');
  assert.equal(forcedMsgs(item.id).length, 0, 'no se añade ningún mensaje al hilo');
});

test('sin force: el cierre de una historia sin integrar sigue dando 409', async () => {
  const item = appliedNotMerged('cierre normal bloqueado');
  const r = await close(item.id);
  assert.equal(r.statusCode, 409, r.body);
  assert.notEqual(backlogRepo(S).get(item.id)!.status, 'done');
  assert.equal(forcedMsgs(item.id).length, 0);
});

test('force:true con motivo: cierra, enumera lo omitido y lo registra una sola vez', async () => {
  const item = appliedNotMerged('cierre forzado con motivo');
  const r = await close(item.id, { force: true, reason: '  Ya funciona en el Portal  ' });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.forced, true);
  assert.deepEqual(body.omittedChecks, ['integrar en main', 'prueba manual']);
  assert.equal(body.reason, 'Ya funciona en el Portal');
  assert.equal(backlogRepo(S).get(item.id)!.status, 'done');
  const msgs = forcedMsgs(item.id);
  assert.equal(msgs.length, 1, JSON.stringify(msgs));
  assert.ok(msgs[0].content.includes('Cierre forzado: se omitió integrar en main, prueba manual · Motivo: Ya funciona en el Portal'), msgs[0].content);

  // Doble clic: un segundo cierre forzado no vuelve a registrar nada.
  const again = await close(item.id, { force: true, reason: 'otra vez' });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(forcedMsgs(item.id).length, 1, 'no se duplica el mensaje de cierre forzado');
});

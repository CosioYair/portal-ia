import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * HU-187 · «Cerrar como resuelta» abre un diálogo del Portal: previsualización sin efectos (HTTP) y cableado de las
 * pantallas (lectura de fuentes). Sin red ni IA: proveedor simulado y procesos creados directamente en la base.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu187-'));
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
const preview = (id: string) => app.inject({ method: 'GET', url: `${W}/backlog/${id}/close-preview` });

/** Historia con una iteración aplicada en su rama pero sin integrar en main ni prueba manual. */
function appliedNotMerged(title: string) {
  const item = addManualItem(S, project.id, { title, description: 'Prueba HU-187', criterion: 'Se previsualiza sin efectos' });
  const p = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title, estimatedUsd: 0, steps: [], backlogItemId: item.id } as any);
  processesRepo(S).authorize(p.id, 1);
  processesRepo(S).setResult(p.id, { plan: null, implementationSummary: 'simulado', changes: [], verifyCommands: [], review: null, verifications: [], applied: { branch: `portal-ia/hu187-${p.id.slice(0, 6)}`, commit: 'b'.repeat(40), files: ['f.txt'], appliedAt: new Date().toISOString() } } as any);
  processesRepo(S).finish(p.id, 'done', null as any);
  const repo = backlogRepo(S) as any;
  if (typeof repo.setLastProcess === 'function') repo.setLastProcess(item.id, p.id);
  return { item, processId: p.id };
}

/** Mensajes del hilo de la historia. */
function threadOf(itemId: string): Array<{ role: string; content: string }> {
  const t = threadRepo(S) as any;
  const fn = t.messages ?? t.list ?? t.listFor ?? t.forItem;
  assert.equal(typeof fn, 'function', 'threadRepo debe exponer una lectura del hilo de la historia');
  const rows = fn.call(t, itemId);
  assert.ok(Array.isArray(rows), 'la lectura del hilo devuelve una lista');
  return rows;
}

test('close-preview enumera lo que se omitiría sin cambiar el estado ni el hilo', async () => {
  const { item, processId } = appliedNotMerged('previsualizar cierre');
  const statusBefore = backlogRepo(S).get(item.id)!.status;
  const threadBefore = threadOf(item.id).length;
  for (let i = 0; i < 2; i++) {
    const r = await preview(item.id);
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.deepEqual(body.omittedChecks, ['integrar en main', 'prueba manual']);
    assert.equal(body.lastProcessId, processId);
    assert.equal(body.merged, false);
  }
  assert.equal(backlogRepo(S).get(item.id)!.status, statusBefore, 'la previsualización no cambia el estado');
  assert.equal(threadOf(item.id).length, threadBefore, 'la previsualización no añade mensajes al hilo');

  // Al confirmar, el cierre forzado de HU-184 omite exactamente lo previsto y deja un solo mensaje.
  const d = await app.inject({ method: 'POST', url: `${W}/backlog/${item.id}/done`, payload: { force: true, reason: 'Resuelta por otra vía' } });
  assert.equal(d.statusCode, 200, d.body);
  assert.deepEqual(d.json().omittedChecks, ['integrar en main', 'prueba manual']);
  assert.equal(threadOf(item.id).filter(m => m.role === 'system' && /Cierre forzado/.test(m.content)).length, 1);
});

test('close-preview de una historia inexistente: 404', async () => {
  const r = await preview('no-existe-hu187');
  assert.equal(r.statusCode, 404, r.body);
});

// ---- Cableado de las pantallas (lectura de fuentes, como backlog-cards-wiring) ----
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const V012 = /ya funciona en el Portal \(incluido en v0\.12\)/i;

test('StoryOverview: sin prompt ni motivo rellenado; abre CloseResolvedDialog', () => {
  const so = read('components/StoryOverview.tsx');
  assert.ok(!so.includes('prompt('), 'StoryOverview no debe usar prompt()');
  assert.ok(!V012.test(so), 'debe desaparecer el ejemplo «ya funciona… v0.12»');
  assert.ok(!so.includes('resuelta fuera del flujo\''), 'el motivo no viene rellenado');
  assert.match(so, /import \{ CloseResolvedDialog \} from '\.\/CloseResolvedDialog\.tsx'/);
  assert.ok(so.includes('<CloseResolvedDialog'), 'StoryOverview debe pintar el diálogo');
  assert.ok(so.includes('Cerrar como resuelta fuera del flujo'), 'se conserva el acceso');
});

test('Backlog: «Cerrar como resuelta» abre el diálogo, sin prompt en el cierre forzado', () => {
  const bl = read('screens/Backlog.tsx');
  assert.match(bl, /import \{ CloseResolvedDialog \} from '\.\.\/components\/CloseResolvedDialog\.tsx'/);
  assert.ok(bl.includes('<CloseResolvedDialog'), 'Backlog debe pintar el diálogo');
  assert.ok(!V012.test(bl));
  assert.ok(bl.includes("'Cerrar como resuelta'"), 'falta la acción «Cerrar como resuelta» en «Más»');
  assert.ok(!bl.includes("'Cerrar sin ejecutar'"), 'la acción ya no se llama «Cerrar sin ejecutar»');
  const cs = bl.indexOf('const closeStory = async');
  const end = bl.indexOf('const cancelStory', cs);
  assert.ok(cs > 0 && end > cs, 'no se encontró closeStory');
  assert.ok(!bl.slice(cs, end).includes('prompt('), 'closeStory no debe usar prompt()');
});

test('CloseResolvedDialog: «Integrar primero» principal, motivo vacío y obligatorio, cierre forzado', () => {
  const dl = read('components/CloseResolvedDialog.tsx');
  assert.match(dl, /className="btn btn-primary"[^>]*>Integrar primero</);
  assert.match(dl, /const \[reason, setReason\] = useState\(''\)/);
  assert.ok(dl.includes('reason.trim().length > 0'), '«Cerrar sin integrar» exige motivo');
  assert.ok(dl.includes('Cerrar sin integrar'));
  assert.ok(dl.includes('api.storyClosePreview('), 'consulta lo omitido antes de cerrar');
  assert.ok(dl.includes('force: true, reason: reason.trim()'), 'usa el cierre forzado de HU-184');
  assert.ok(!dl.includes('prompt(') && !V012.test(dl));
});

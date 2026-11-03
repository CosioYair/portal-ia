import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * HU-165 · Cancelar historia (POST /backlog/:id/discard): queda en «Descartadas» con su motivo, deja rastro en el hilo
 * y no consume IA. 400 sin motivo, 404 si no existe y 409 si está en curso, completada o ya descartada.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-discard-'));
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { backlogRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts'); // con el propietario vinculado (todo cambio lo exige)
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { addManualItem } = await import('../src/services/backlog.ts');

// Como en las demás suites: un proveedor (simulado) conectado antes de inicializar el espacio interno; sin él,
// runBootstrap lanza «Conecta y verifica un proveedor…» y el archivo entero falla antes de ejecutar sus pruebas.
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const slug = createCompany('Descartes').slug;
const project = createProject(slug, 'Producto', 'x', []);
const app = await buildApp();
after(() => app.close());
const W = `/api/workspaces/${slug}`;
const discard = (id: string, payload?: unknown) => app.inject({ method: 'POST', url: `${W}/backlog/${id}/discard`, payload: payload as any });
const history = () => workspaceDb(slug).prepare('SELECT COUNT(*) AS n FROM execution_history').get() as any;

test('cancelar una historia pendiente con motivo: queda descartada, con el motivo y el rastro en el hilo, sin IA', async () => {
  const it = addManualItem(slug, project.id, { title: 'Exportar a PDF' });
  const before = Number(history().n);
  const res = await discard(it.id, { reason: 'Ya no aplica al producto' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'discarded', 'queda descartada, no completada');
  assert.match(res.json().description ?? '', /Descartada: Ya no aplica al producto/);
  assert.equal(backlogRepo(slug).get(it.id)!.status, 'discarded');
  const ctx = (await app.inject({ method: 'GET', url: `${W}/stories/${it.id}` })).json();
  const msg = ctx.messages.find((m: any) => m.role === 'system' && /Cancelada por el propietario: Ya no aplica al producto/.test(m.content));
  assert.ok(msg, 'falta el mensaje de sistema en el hilo de la historia');
  assert.equal(msg.costUsd ?? 0, 0, 'cancelar no tiene costo');
  assert.equal(msg.tokens ?? 0, 0, 'cancelar no consume tokens');
  assert.equal(Number(history().n), before, 'no se registra ningún uso de IA ni ejecución');
});

test('sin motivo o con un motivo demasiado corto responde 400 y no toca la historia', async () => {
  const it = addManualItem(slug, project.id, { title: 'Modo oscuro' });
  for (const payload of [{}, { reason: '' }, { reason: '   ' }, { reason: 'ab' }]) {
    const res = await discard(it.id, payload);
    assert.equal(res.statusCode, 400, `debería rechazar ${JSON.stringify(payload)}`);
  }
  assert.equal(backlogRepo(slug).get(it.id)!.status, 'pending');
});

test('409 si la historia está en curso, completada o ya descartada; 404 si no existe', async () => {
  for (const st of ['in_progress', 'done'] as const) {
    const it = addManualItem(slug, project.id, { title: `Historia ${st}` });
    backlogRepo(slug).setStatus(it.id, st);
    const res = await discard(it.id, { reason: 'No se necesita' });
    assert.equal(res.statusCode, 409, `${st}: ${res.body}`);
    assert.ok(String(res.json().error ?? '').length > 0, 'el 409 explica el motivo');
    assert.equal(backlogRepo(slug).get(it.id)!.status, st, 'el estado no cambia');
  }
  const it = addManualItem(slug, project.id, { title: 'Dos veces' });
  assert.equal((await discard(it.id, { reason: 'Duplicada de otra' })).statusCode, 200);
  const again = await discard(it.id, { reason: 'Otra vez' });
  assert.equal(again.statusCode, 409);
  assert.match(again.json().error, /descartada/);
  assert.equal((await discard('no-existe', { reason: 'No existe' })).statusCode, 404);
});

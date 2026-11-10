import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * HU-197 · El chat del Asistente acepta un modelo por mensaje. Proveedor SIMULADO (0 USD, sin red), datos sintéticos.
 *  - Sin `model`: se usa el modelo configurado (comportamiento de siempre).
 *  - Con un `model` del catálogo del proveedor: la llamada, el costo, el registro y el mensaje usan ese modelo.
 *  - Con un `model` que no está en el catálogo: 400 `invalid_model`, sin guardar mensajes, sin gasto y sin llamar a la IA.
 *  - Con el límite mensual alcanzado: 409 aunque el modelo sea válido (el límite se comprueba antes).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu197-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, INTERNAL_WORKSPACE } = await import('@portal-ia/domain');
const { costUsd, resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { assistantInfo, assistantRepo, resolveChatModel } = await import('../src/services/assistant.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

const CATALOG = ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', CATALOG.map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = INTERNAL_WORKSPACE.slug; const W = `/api/workspaces/${S}`;
const app = await buildApp();
after(async () => { await app.close(); });
const inject = async (method: string, u: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url: u, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };

fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: 'Cómo trabajar en esta conversación', text: 'Respuesta del Asistente.' }] }));
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const asst = agentsRepo(S).list().find(a => a.key === 'ws-asistente')!;
const cfgOf = () => agentsRepo(S).get(asst.id)!.config;
const msgCount = () => assistantRepo.list(10_000).length;
const historyCount = () => (workspaceDb(S).prepare(`SELECT COUNT(*) AS c FROM execution_history WHERE agent_id = ?`).get(asst.id) as any).c as number;
const conv = (await inject('POST', '/api/assistant/conversations', { title: 'HU-197' })).body;

test('resolveChatModel · sin modelo usa el configurado; con uno del catálogo lo devuelve; si no está (o no hay catálogo), 400 invalid_model', () => {
  const models = CATALOG.map(id => classifyModel('anthropic', id));
  assert.equal(resolveChatModel(models, undefined, 'claude-opus-4-1'), 'claude-opus-4-1');
  assert.equal(resolveChatModel(models, null, 'claude-opus-4-1'), 'claude-opus-4-1');
  assert.equal(resolveChatModel(models, 'claude-haiku-4-5', 'claude-opus-4-1'), 'claude-haiku-4-5');
  const bad = (fn: () => unknown, name: string) => assert.throws(fn, (e: any) => e.statusCode === 400 && e.code === 'invalid_model' && e.message.includes(name));
  bad(() => resolveChatModel(models, 'modelo-inventado', 'claude-opus-4-1'), 'modelo-inventado');
  bad(() => resolveChatModel(models, 'CLAUDE-HAIKU-4-5', 'claude-opus-4-1'), 'CLAUDE-HAIKU-4-5');
  bad(() => resolveChatModel([], 'claude-haiku-4-5', 'claude-opus-4-1'), 'claude-haiku-4-5');
});

test('sin model: el mensaje usa el modelo configurado del Asistente (sin cambios)', async () => {
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  const r = await inject('POST', '/api/assistant/messages', { text: 'Hola, ¿cómo va todo?', conversationId: conv.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.assistant.model, cfgOf().model);
  assert.equal(calls().at(-1).model, cfgOf().model, 'la llamada usa el modelo configurado');
});

test('con un model del catálogo: la llamada, el mensaje guardado y el costo usan ese modelo', async () => {
  const chosen = CATALOG.find(m => m !== cfgOf().model)!;
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  const hist0 = historyCount();
  const r = await inject('POST', '/api/assistant/messages', { text: 'Responde con otro modelo.', conversationId: conv.id, model: chosen });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.assistant;
  assert.equal(a.model, chosen, 'el mensaje guarda el modelo indicado');
  assert.equal(calls().length, 1); assert.equal(calls()[0].model, chosen, 'complete() recibió ese modelo');
  const provider = assistantInfo().provider as any;
  assert.ok(a.tokensIn > 0 && a.tokensOut > 0);
  assert.equal(a.costUsd, costUsd(provider, chosen, a.tokensIn, a.tokensOut), 'costo calculado con el modelo indicado');
  assert.equal(assistantRepo.get(a.id)!.model, chosen, 'persistido en SQLite');
  assert.ok(historyCount() >= hist0, 'el registro de uso no se pierde');
  // Dos envíos seguidos con modelos distintos: cada uno guarda el suyo (sin estado compartido).
  const other = CATALOG.find(m => m !== chosen)!;
  const r2 = await inject('POST', '/api/assistant/messages', { text: 'Y ahora con este.', conversationId: conv.id, model: other });
  assert.equal(r2.status, 200); assert.equal(r2.body.assistant.model, other);
  assert.equal(assistantRepo.get(a.id)!.model, chosen);
});

test('con un model que no está en el catálogo: 400 invalid_model, mensaje que lo nombra, nada guardado y sin llamar a la IA', async () => {
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  const msgs0 = msgCount(); const hist0 = historyCount();
  const r = await inject('POST', '/api/assistant/messages', { text: 'Usa este modelo.', conversationId: conv.id, model: 'gpt-inexistente-9' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'invalid_model');
  assert.match(r.body.error, /gpt-inexistente-9/); assert.match(r.body.error, /no está disponible/);
  assert.equal(msgCount(), msgs0, 'no se guarda ningún mensaje');
  assert.equal(historyCount(), hist0, 'no se registra gasto');
  assert.equal(calls().length, 0, 'no se llama a la IA');
  const empty = await inject('POST', '/api/assistant/messages', { text: 'Hola', conversationId: conv.id, model: '   ' });
  assert.equal(empty.status, 400, 'un modelo vacío se rechaza en la validación');
});

test('límite mensual alcanzado: 409 aunque el model sea válido (el límite se comprueba antes)', async () => {
  const spent = assistantInfo().spentThisMonthUsd;
  assert.ok(spent > 0, 'los mensajes anteriores registraron gasto este mes');
  const put = await inject('PUT', `${W}/agents/${asst.id}/config`, { ...cfgOf(), monthlyLimitUsd: spent / 2 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  const msgs0 = msgCount();
  const r = await inject('POST', '/api/assistant/messages', { text: 'Otro mensaje.', conversationId: conv.id, model: CATALOG[2] });
  assert.equal(r.status, 409, JSON.stringify(r.body)); assert.match(r.body.error, /límite mensual/);
  const bad = await inject('POST', '/api/assistant/messages', { text: 'Otro mensaje.', conversationId: conv.id, model: 'gpt-inexistente-9' });
  assert.equal(bad.status, 409, 'el límite manda antes que la validación del modelo');
  assert.equal(msgCount(), msgs0); assert.equal(calls().length, 0);
});

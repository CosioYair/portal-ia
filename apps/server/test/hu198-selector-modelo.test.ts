import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * HU-198 · Selector de modelo en el chat del Asistente. Proveedor SIMULADO (0 USD, sin red), datos sintéticos.
 *  - assistantInfo().models sale del mismo catálogo que valida resolveChatModel (todo lo ofrecido es válido).
 *  - Enviar «hola» con otro modelo: el mensaje guardado (SQLite) lleva ese modelo y su costo.
 *  - Sin «usar por defecto» el agente no cambia; con {...cfg, model} cambia solo el modelo.
 *  - Cableado de la UI (AssistantChat/ModelPicker), comprobado sobre el código fuente.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu198-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, INTERNAL_WORKSPACE } = await import('@portal-ia/domain');
const { costUsd, resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo } = await import('../src/db/workspace.ts');
const { assistantInfo, assistantModelChoice, assistantRepo, resolveChatModel } = await import('../src/services/assistant.ts');
const { harnessModels } = await import('../src/services/harness/index.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

const CATALOG = ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', CATALOG.map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = INTERNAL_WORKSPACE.slug; const W = `/api/workspaces/${S}`;
const app = await buildApp();
after(async () => { await app.close(); });
const inject = async (method: string, u: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url: u, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };

fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: 'Cómo trabajar en esta conversación', text: 'Hola, aquí el Asistente.' }] }));
const asst = agentsRepo(S).list().find(a => a.key === 'ws-asistente')!;
const cfgOf = () => agentsRepo(S).get(asst.id)!.config;
const conv = (await inject('POST', '/api/assistant/conversations', { title: 'HU-198' })).body;

test('assistantInfo().models: catálogo del proveedor con tipo de costo y estimación; cada id lo acepta resolveChatModel', () => {
  const info = assistantInfo() as any;
  assert.ok(Array.isArray(info.models), 'assistantInfo devuelve models');
  assert.deepEqual(info.models.map((m: any) => m.id).sort(), [...CATALOG].sort(), 'mismo catálogo que valida el envío');
  const catalog = CATALOG.map(id => classifyModel('anthropic', id));
  for (const m of info.models) {
    assert.ok(typeof m.label === 'string' && m.label.length > 0, `etiqueta de ${m.id}`);
    assert.ok(m.billing === 'api' || m.billing === 'subscription');
    assert.equal(m.billing, info.billing, 'el tipo de costo es el del backend del Asistente');
    assert.ok(typeof m.estimatedPerMessageUsd === 'number' && m.estimatedPerMessageUsd >= 0);
    if (m.billing === 'subscription') assert.equal(m.estimatedPerMessageUsd, 0, 'con suscripción no hay costo por mensaje');
    assert.equal(resolveChatModel(catalog, m.id, cfgOf().model), m.id, `${m.id} es válido al enviar`);
  }
  assert.equal(info.modelsReason ?? null, null, 'con catálogo, el selector no queda en solo lectura');
});

test('enviar «hola» con otro modelo: el mensaje guardado lleva ese modelo y su costo; el agente no cambia sin «usar por defecto»', async () => {
  const before = structuredClone(cfgOf());
  const chosen = CATALOG.find(m => m !== before.model)!;
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  const r = await inject('POST', '/api/assistant/messages', { text: 'hola', conversationId: conv.id, model: chosen });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.assistant;
  assert.equal(a.model, chosen);
  const saved = assistantRepo.get(a.id)!;
  assert.equal(saved.model, chosen, 'modelo persistido en SQLite');
  const info = assistantInfo() as any;
  const expected = info.billing === 'subscription' ? 0 : costUsd(info.provider, chosen, a.tokensIn, a.tokensOut);
  assert.equal(saved.costUsd, expected, 'costo del mensaje guardado (0 con suscripción)');
  const listed = (await inject('GET', `/api/assistant?conversationId=${encodeURIComponent(conv.id)}`)).body;
  assert.equal(listed.messages.find((m: any) => m.id === a.id)?.model, chosen, 'al recargar se ve el mismo modelo');
  assert.deepEqual(cfgOf(), before, 'la configuración del agente no cambia');
});

test('«usar por defecto» con {...cfg, model}: cambia solo el modelo y se conservan los demás ajustes', async () => {
  const before = structuredClone(cfgOf()) as any;
  // Un modelo que no sea el actual ni un alternativo (la ruta nunca deja el principal entre sus alternativos).
  const next = CATALOG.find(m => m !== before.model && !(before.fallbacks ?? []).includes(m))!;
  assert.ok(next, 'hay un modelo del catálogo distinto del actual y de sus alternativos');
  const put = await inject('PUT', `${W}/agents/${asst.id}/config`, { ...before, model: next });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const afterCfg = cfgOf() as any;
  assert.equal(afterCfg.model, next);
  assert.deepEqual({ ...afterCfg, model: before.model }, before, 'los demás campos se conservan');
  assert.equal((assistantInfo() as any).model, next, 'el Asistente usa el nuevo modelo por defecto');
});

test('suscripción: el menú solo ofrece modelos que el PUT de configuración acepta con el arnés (misma regla)', () => {
  // Regla del PUT (workspaces.ts): con arnés ≠ api, el modelo debe estar en harnessModels(arnés, proveedor) si esa lista no está vacía.
  const putAccepts = (backend: string, provider: any, model: string) => {
    const hm = harnessModels(backend as any, provider).find((g: any) => g.provider === provider)?.models ?? [];
    return !hm.length || hm.some((m: any) => m.id === model);
  };
  const cc = assistantModelChoice('anthropic', 'claude-code');
  assert.ok(cc.models.length > 0, 'Claude Code ofrece modelos del catálogo');
  for (const m of cc.models) {
    assert.equal(m.billing, 'subscription'); assert.equal(m.estimatedPerMessageUsd, 0);
    assert.ok(CATALOG.includes(m.id), `${m.id} lo acepta resolveChatModel`);
    assert.ok(putAccepts('claude-code', 'anthropic', m.id), `${m.id} lo acepta «usar por defecto» con Claude Code`);
  }
  // Codex con OpenAI: su lista ('default' + detectados) no cruza con un catálogo de OpenAI vacío → nada que ofrecer, con motivo.
  const cx = assistantModelChoice('openai', 'codex');
  for (const m of cx.models) assert.ok(putAccepts('codex', 'openai', m.id), `${m.id} lo acepta «usar por defecto» con Codex`);
  if (!cx.models.length) assert.ok(cx.modelsReason && cx.modelsReason.length > 0, 'sin modelos, se explica por qué');
});

const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

test('cableado de la UI: ModelPicker junto a «Enviar», model en el envío, «usar por defecto» como única vía y etiqueta del mensaje guardado', () => {
  const chat = read('components/AssistantChat.tsx');
  const picker = read('components/ModelPicker.tsx');
  const api = read('lib/api.ts');
  assert.match(chat, /import \{ ModelPicker \} from '\.\/ModelPicker\.tsx'/);
  assert.match(chat, /<ModelPicker[^>]*onSetDefault=/, 'ofrece «usar por defecto»');
  assert.match(chat, /portal-ia\.asistente\.modelo\./, 'el modelo se guarda por conversación');
  assert.match(api, /sendAssistant: \([^)]*model: string \| null = null\)/, 'el cliente acepta model');
  assert.match(chat, /api\.sendAssistant\([^;]*convId, sendModel\)/, 'el envío lleva el modelo de la conversación');
  const updates = chat.match(/api\.updateAgentConfig\(/g) ?? [];
  assert.equal(updates.length, 1, 'solo una llamada a updateAgentConfig');
  const handler = chat.indexOf('const setDefaultModel = async');
  const upd = chat.indexOf('api.updateAgentConfig(');
  assert.ok(handler >= 0 && upd > handler && upd < chat.indexOf('const send', handler), 'solo desde el manejador de «usar por defecto»');
  assert.match(chat, /api\.updateAgentConfig\([^;]*\{ \.\.\.cfg, model \}\)/, 'envía la configuración completa con solo el modelo cambiado');
  assert.ok(chat.indexOf('api.agent(') > handler && chat.indexOf('api.agent(') < upd, 'lee la configuración actual justo antes de guardar');
  const meta = chat.slice(chat.indexOf('function replyMeta'), chat.indexOf('const MAX_IMAGES'));
  assert.match(meta, /m\.model/); assert.match(meta, /m\.costUsd/); assert.match(meta, /Suscripción/);
  assert.doesNotMatch(meta, /chatModel/, 'la etiqueta no usa la selección local');
  assert.match(chat, /replyMeta\(m,/);
  const sendAt = chat.indexOf('await api.sendAssistant(');
  const clearAt = chat.indexOf('msgDraft.clear(); setImages([]);');
  assert.ok(sendAt > 0 && clearAt > sendAt, 'el campo se limpia solo después de un envío correcto');
  assert.match(picker, /Usar por defecto/); assert.match(picker, /Sin marcarla, el cambio solo vale para esta conversación/);
  assert.match(picker, /'Suscripción'/); assert.match(picker, /USD por mensaje/);
  assert.match(picker, /aria-haspopup="listbox"/); assert.match(picker, /Escape/);
});

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * HU-181 · Retirar la pestaña Mejoras: historial de automejoras con Deshacer. Proveedor simulado y Claude falso (0 USD).
 *  1. Cableado web (estático): sin pestaña Mejoras ni grupo propio, alias de la ruta antigua a Memoria, historial en Memoria.
 *  2. Comportamiento: las propuestas pendientes se aplican con permiso o se archivan con motivo; repetir no cambia nada;
 *     el historial trae fecha, origen, archivos y resumen; Deshacer una que no es la última da 409; sin avisos 'improvement'.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu181-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const readWeb = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

test('cableado web: el panel no tiene pestaña Mejoras y la ruta antigua abre Memoria', async () => {
  const panel = readWeb('components/AgentPanel.tsx');
  const ext = panel.slice(panel.indexOf('const EXTERNAL_TABS = ['), panel.indexOf('] as const;', panel.indexOf('const EXTERNAL_TABS = [')));
  assert.ok(ext.length > 0, 'falta EXTERNAL_TABS');
  assert.ok(!ext.includes("['mejoras'"), 'EXTERNAL_TABS ya no lleva Mejoras');
  assert.ok(!panel.includes("['mejoras', 'Mejoras']"), 'ninguna tupla de pestaña Mejoras');
  const groupOf = panel.match(/const GROUP_OF: Record<Tab, Group> = \{([^}]*)\}/);
  assert.ok(groupOf, 'falta GROUP_OF');
  assert.doesNotMatch(groupOf[1], /\bmejoras:/, 'Mejoras no tiene grupo');
  assert.match(panel, /tab === 'mejoras' \? 'memoria'/, 'la ruta antigua es un alias de Memoria');
  assert.match(panel, /Historial de automejoras/);
  assert.match(panel, /[Dd]eshacer/);
  assert.match(panel, /Deshaz primero la última/);
  const { tabFor } = await import('../../web/src/lib/routes.ts');
  assert.equal(tabFor({ kind: 'improvement' }), 'memoria', 'un aviso o enlace antiguo de automejora lleva a Memoria');
  const external = readWeb('components/ExternalAgent.tsx');
  assert.ok(!external.includes('ImprovementsTab'), 'la lista de Mejoras ya no existe');
  assert.match(external, /Puede automejorarse/);
  const chat = readWeb('components/AgentChat.tsx');
  assert.doesNotMatch(chat, /Revisar en Mejoras|Ver en Mejoras/);
});

// ---------- Comportamiento (modelo de reintento-autoaprende.test.ts) ----------
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu181-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };

const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu181-tools-'));
fs.mkdirSync(path.join(tools, 'kits', 'pdf-word'), { recursive: true });
fs.writeFileSync(path.join(tools, 'pdf_info.py'), `console.log(JSON.stringify({encrypted:false,pages:1,text_pages:1,chars:120,sizes:[[612,792]],ocr_available:false}));`);
fs.writeFileSync(path.join(tools, 'check_python.py'), `console.log('ok')`);
fs.writeFileSync(path.join(tools, 'kits', 'pdf-word', 'convertir_editable.py'), '// kit simulado');
fs.writeFileSync(path.join(tools, 'doc_qa.py'), `const fs=require('fs'),path=require('path');const [inp,out,qa]=process.argv.slice(2);fs.mkdirSync(qa,{recursive:true});const gates={texto_editable:true,sin_paginas_como_imagen:true,mismas_paginas:true};
fs.writeFileSync(path.join(qa,'qa.json'),JSON.stringify({pdf_pages:1,rendered_pages:1,recall_docx_outside_figures:1,words_in_figures:0,figure_share:0,order_render:1,duplication:0,docx:{pictures:0,largest_picture_ratio:0,pictures_over_60pct:0,tables:1},pages:[{page:1,visual_diff:0.01,rendered_words:10}],gates,passed:true,schema_problems:[]}));fs.writeFileSync(path.join(qa,'comparacion-01.png'),'png');`);
const AGENT_SCRIPT = `const fs=require('fs');const a=process.argv.slice(2);const inp=fs.readFileSync(a[0],'latin1');
if(inp.includes('FALLA')&&!a.includes('corregido')){console.error('conversión fallida');process.exit(3)}
setTimeout(()=>{fs.writeFileSync(a[1],'PK-docx-'+inp.length)},30);`;
process.env.PORTAL_DOC_TOOLS_DIR = tools;
process.env.PORTAL_PYTHON = process.execPath;
process.env.PORTAL_PYTHON_ARGS = '';
process.env.PORTAL_SOFFICE = process.execPath;

const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { resetDetectionCache, verifiedDetection } = await import('../src/services/claudeCode/detect.ts');
const { settleLegacyProposals, improvementHistory, LEGACY_ARCHIVE_PREFIX } = await import('../src/services/documentJobs.ts');
const { officeView } = await import('../src/services/agentOs.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const app = await buildApp();
after(async () => { await app.close(); });
saveClaudeCodeSettings({ ...getClaudeCodeSettings(), enabled: true, cliPath: FAKE, maxConcurrent: 1 }); resetDetectionCache();
scenario({ auth: 'subscription', defaultText: 'ok' }); await verifiedDetection(getClaudeCodeSettings(), 0);
const inject = async (method: string, u: string, payload?: unknown, headers?: Record<string, string>) => { const r = await app.inject({ method: method as any, url: u, payload: payload as any, headers }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() as any }; };
const upload = (u: string, name: string, data: Buffer) => inject('PUT', `${u}?name=${encodeURIComponent(name)}`, data, { 'content-type': 'application/octet-stream' });
const until = async (fn: () => boolean | Promise<boolean>, ms = 60_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 80)); } return false; };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu181-agente-'));
after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temporal */ } });
const root = path.join(base, 'Agente'); const w = (rel: string, t: string) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
w('AGENTS.md', '# Agente HU-181\n\nConvierte PDF.\n');
w('memoria/MEMORIA.md', '# Memoria\n\nLecciones del agente.\n');
w('skills/conv/SKILL.md', '---\nname: conv\ndescription: Convierte.\n---\n\n# Conv — versión 1.0.0\n\nUsa scripts/conv.py.\n');
w('skills/conv/scripts/conv.py', AGENT_SCRIPT);
w('documentos/LEEME.md', 'x');
const pv = (await inject('POST', `${W}/agents/external/preview`, { path: root })).json;
const GRANTS = { writeDocuments: true, runScripts: true, applyImprovements: true };
const imp = await inject('POST', `${W}/agents/external`, { path: root, hash: pv.hash, name: 'Automejoras', role: 'Pruebas HU-181', summary: '', department: 'Documentos', harness: 'claude-code', model: 'claude-sonnet-4-5', grants: GRANTS, authorized: true });
assert.equal(imp.status, 201, JSON.stringify(imp.json));
const agentId = imp.json.id as string;
const A = `${W}/agents/${agentId}`;

const PLAN_TEXT = JSON.stringify({ script: 'skills/conv/scripts/conv.py', args: ['{entrada}', '{salida}'], reason: 'Mi habilidad.' });
const RULES = { auth: 'subscription', rules: [
  { match: '"cifras"', text: 'Resumen (simulado).' }, { match: 'aprobado_por_la_QA', text: 'Informe.' },
  { match: 'REINTENTO', text: JSON.stringify({ script: 'skills/conv/scripts/conv.py', args: ['{entrada}', '{salida}', '--modo', 'corregido'], reason: 'Corrijo el fallo.' }) },
  { match: 'Reglas del plan', text: PLAN_TEXT }] };
const PDF = (marker: string) => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n${marker}\n%%EOF\n`);
const docs = async () => (await inject('GET', `${A}/documents`)).json;
const props = async () => ((await docs()).proposals ?? []) as any[];
const propOf = async (id: string) => (await props()).find(p => p.id === id);
const jobOf = async (id: string) => (await docs()).jobs.find((j: any) => j.id === id);
const setGrant = async (on: boolean) => { const g = await inject('PUT', `${A}/source/grants`, { grants: { ...GRANTS, applyImprovements: on }, authorized: true }); assert.equal(g.status, 200, JSON.stringify(g.json)); };
const processJob = async (id: string) => {
  const r = await inject('POST', `${A}/documents/${id}/process`, { authorized: true });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.ok(await until(async () => { const j = await jobOf(id); return !!j && j.status !== 'processing' && j.status !== 'queued'; }));
};
/** Un documento que falla y luego pasa con el reintento: con permiso se aplica solo; sin permiso deja una propuesta pendiente. */
async function learnFrom(marker: string, grant: boolean): Promise<any> {
  scenario(RULES);
  const up = await upload(`${A}/documents/upload`, `${marker}.pdf`, PDF(`${marker} FALLA`));
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const id = up.json.jobs[0].id as string;
  await processJob(id);
  await setGrant(grant);
  try {
    scenario(RULES);
    await processJob(id);
    assert.ok(await until(async () => (await props()).some(p => p.jobId === id && (grant ? p.state !== 'proposed' : true))), 'el reintento deja su aprendizaje');
    return (await props()).find(p => p.jobId === id);
  } finally { await setGrant(true); }
}

let p1: any = null; let p3: any = null;

test('sin aviso de automejora: una propuesta pendiente no genera nada en office.attention', async () => {
  const pending = await learnFrom('HU181-P2', false);
  assert.equal(pending.state, 'proposed', JSON.stringify(pending));
  const view = officeView(S, []);
  for (const a of view.agents) assert.ok(!a.attention.some(x => x.kind === 'improvement'), `${a.name} tiene un aviso de automejora`);
  // Sin permiso de automejora: se archiva con un motivo legible.
  await setGrant(false);
  try {
    const r = await settleLegacyProposals(S, agentId);
    const hit = r.archived.find(x => x.id === pending.id);
    assert.ok(hit, JSON.stringify(r));
    assert.ok(hit.reason.startsWith(LEGACY_ARCHIVE_PREFIX), hit.reason);
    assert.match(hit.reason, /permiso/);
    assert.notEqual((await propOf(pending.id)).state, 'proposed');
  } finally { await setGrant(true); }
});

test('con permiso: la pendiente se aplica; repetir el proceso no cambia nada', async () => {
  const pending = await learnFrom('HU181-P1', false);
  assert.equal(pending.state, 'proposed', JSON.stringify(pending));
  const r = await settleLegacyProposals(S, agentId);
  assert.ok(r.applied.includes(pending.id), JSON.stringify(r));
  p1 = await propOf(pending.id);
  assert.equal(p1.state, 'applied', JSON.stringify(p1));
  const before = JSON.stringify((await props()).map(p => [p.id, p.state]));
  const again = await settleLegacyProposals(S, agentId);
  assert.deepEqual(again, { applied: [], archived: [] });
  assert.equal(JSON.stringify((await props()).map(p => [p.id, p.state])), before, 'idempotente');
  assert.equal((await props()).filter(p => p.state === 'proposed').length, 0, 'ninguna pendiente');
});

test('historial de automejoras: fecha, origen, archivos y resumen; solo la última se puede deshacer', async () => {
  assert.ok(p1, 'depende de la prueba anterior');
  p3 = await learnFrom('HU181-P3', true);
  assert.equal(p3.state, 'applied', JSON.stringify(p3));
  const h = improvementHistory(S, agentId);
  const i1 = h.find(x => x.id === p1.id); const i3 = h.find(x => x.id === p3.id);
  assert.ok(i1 && i3, JSON.stringify(h));
  for (const it of [i1, i3]) {
    assert.ok(!Number.isNaN(Date.parse(it.at)), `fecha: ${it.at}`);
    assert.ok(it.origin === 'chat' || it.origin === 'reintento', it.origin);
    assert.ok(Array.isArray(it.files) && it.files.length > 0, 'archivos cambiados');
    assert.equal(typeof it.summary, 'string'); assert.ok(it.summary.length > 0, 'resumen');
  }
  assert.equal(i3.origin, 'reintento');
  assert.ok(h.indexOf(i3) < h.indexOf(i1), 'de la más reciente a la más antigua');
  assert.equal(i3.canUndo, true); assert.equal(i1.canUndo, false);
});

test('Deshacer: una anterior da 409; la última se deshace y después la anterior también', async () => {
  assert.ok(p1 && p3, 'depende de las pruebas anteriores');
  const early = await inject('POST', `${A}/proposals/${p1.id}/undo`, { authorized: true });
  assert.equal(early.status, 409, JSON.stringify(early.json));
  assert.equal((await propOf(p1.id)).state, 'applied', 'no se tocó');
  const last = await inject('POST', `${A}/proposals/${p3.id}/undo`, { authorized: true });
  assert.equal(last.status, 200, JSON.stringify(last.json));
  assert.equal((await propOf(p3.id)).state, 'undone');
  const h = improvementHistory(S, agentId);
  assert.equal(h.find(x => x.id === p3.id)?.undone, true);
  assert.equal(h.find(x => x.id === p1.id)?.canUndo, true, 'ahora la anterior es la última');
  assert.equal((await inject('POST', `${A}/proposals/${p1.id}/undo`, { authorized: true })).status, 200);
});

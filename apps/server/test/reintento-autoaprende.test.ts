import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * HU-179 · Automejora por reintentos (docs/agentes-externos.md). Proveedor simulado y Claude falso (0 USD). Comprueba:
 *  (a) un reintento suelto que pasa la QA aplica solo lo aprendido (diagnóstico + plan) en los archivos del agente,
 *      sube la revisión y deja la propuesta aplicada (autoApplied, origin='retry') sin pasar por 'proposed';
 *  (b) un reintento que no pasa (plan repetido o error del planificador) no toca archivos ni revisión ni crea propuesta;
 *  (c) un lote con 3 documentos corregidos en el mismo reintento: 3 aplicaciones en orden, revisiones consecutivas, sin 409;
 *  (d) Deshacer restaura los archivos y marca 'undone'; deshacer otro deja intacto lo aprendido antes;
 *  (e) sin el permiso applyImprovements queda una propuesta pendiente, como hasta ahora.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-autoap-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-autoap-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };

const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-autoap-tools-'));
const CONV = path.join(tools, 'conversiones.log');
fs.mkdirSync(path.join(tools, 'kits', 'pdf-word'), { recursive: true });
fs.writeFileSync(path.join(tools, 'pdf_info.py'), `console.log(JSON.stringify({encrypted:false,pages:1,text_pages:1,chars:120,sizes:[[612,792]],ocr_available:false}));`);
fs.writeFileSync(path.join(tools, 'check_python.py'), `console.log('ok')`);
fs.writeFileSync(path.join(tools, 'kits', 'pdf-word', 'convertir_editable.py'), '// kit simulado');
fs.writeFileSync(path.join(tools, 'doc_qa.py'), `const fs=require('fs'),path=require('path');const [inp,out,qa]=process.argv.slice(2);fs.mkdirSync(qa,{recursive:true});const gates={texto_editable:true,sin_paginas_como_imagen:true,mismas_paginas:true};
fs.writeFileSync(path.join(qa,'qa.json'),JSON.stringify({pdf_pages:1,rendered_pages:1,recall_docx_outside_figures:1,words_in_figures:0,figure_share:0,order_render:1,duplication:0,docx:{pictures:0,largest_picture_ratio:0,pictures_over_60pct:0,tables:1},pages:[{page:1,visual_diff:0.01,rendered_words:10}],gates,passed:true,schema_problems:[]}));fs.writeFileSync(path.join(qa,'comparacion-01.png'),'png');`);
// El script del agente FALLA la conversión de un PDF «FALLA» salvo que el plan lleve la corrección («corregido»).
const AGENT_SCRIPT = `const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(CONV)},'1\\n');const inp=fs.readFileSync(a[0],'latin1');
if(inp.includes('FALLA')&&!a.includes('corregido')){console.error('conversión fallida: estructura no soportada');process.exit(3)}
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-autoap-agente-'));
after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temporal */ } });
const root = path.join(base, 'Agente'); const w = (rel: string, t: string) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
w('AGENTS.md', '# Agente de pruebas\n\nConvierte PDF.\n');
w('memoria/MEMORIA.md', '# Memoria\n\nLecciones del agente.\n');
w('skills/conv/SKILL.md', '---\nname: conv\ndescription: Convierte.\n---\n\n# Conv — versión 1.0.0\n\nUsa scripts/conv.py.\n');
w('skills/conv/scripts/conv.py', AGENT_SCRIPT);
w('documentos/LEEME.md', 'x');
const pv = (await inject('POST', `${W}/agents/external/preview`, { path: root })).json;
const GRANTS = { writeDocuments: true, runScripts: true, applyImprovements: true };
const imp = await inject('POST', `${W}/agents/external`, { path: root, hash: pv.hash, name: 'Autoaprende', role: 'Pruebas de aprendizaje', summary: '', department: 'Documentos', harness: 'claude-code', model: 'claude-sonnet-4-5', grants: GRANTS, authorized: true });
assert.equal(imp.status, 201, JSON.stringify(imp.json));
const agentId = imp.json.id as string;
const A = `${W}/agents/${agentId}`;

const PLAN_TEXT = JSON.stringify({ script: 'skills/conv/scripts/conv.py', args: ['{entrada}', '{salida}'], reason: 'Mi habilidad.' });
const PLAN = { match: 'Reglas del plan', text: PLAN_TEXT };
const RETRY_PLAN = { match: 'REINTENTO', text: JSON.stringify({ script: 'skills/conv/scripts/conv.py', args: ['{entrada}', '{salida}', '--modo', 'corregido'], reason: 'Corrijo la estructura que hizo fallar la conversión.' }) };
const SUMMARY = { match: '"cifras"', text: 'Resumen del lote (simulado).' };
const REPORT = { match: 'aprobado_por_la_QA', text: 'Informe.' };
const RULES = { auth: 'subscription', rules: [SUMMARY, REPORT, RETRY_PLAN, PLAN] };
const SAME = { auth: 'subscription', rules: [SUMMARY, REPORT, { match: 'REINTENTO', text: PLAN_TEXT }, PLAN] };
const PLANNER_ERROR = { auth: 'subscription', rules: [SUMMARY, REPORT, { match: 'REINTENTO', text: 'esto no es un plan' }, PLAN] };

const PDF = (marker: string) => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n${marker}\n%%EOF\n`);
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let off = 0;
  for (const e of entries) {
    const comp = zlib.deflateRawSync(e.data); const name = Buffer.from(e.name, 'utf8'); const crc = zlib.crc32(e.data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, comp]); locals.push(local);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    centrals.push(Buffer.concat([ch, name])); off += local.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const docs = async () => (await inject('GET', `${A}/documents`)).json;
const props = async () => ((await docs()).proposals ?? []) as any[];
const propsOf = async (jobId: string) => (await props()).filter(p => p.jobId === jobId);
const batchOf = async (id: string) => (await docs()).batches.find((b: any) => b.id === id);
const jobOf = async (id: string) => (await docs()).jobs.find((j: any) => j.id === id);
const revision = async () => Number((await inject('GET', `${A}/source`)).json?.revision);
const settled = (b: any) => b && b.status === 'completed' && b.items.every((i: any) => i.state !== 'queued' && i.state !== 'processing');
/** Archivos de identidad del agente (sin CAMBIOS.md, que es el registro y crece con cada aplicación o Deshacer). */
function snap(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!D.isIgnoredExternalDir(e.name) && e.name !== 'documentos' && e.name !== 'configuracion') walk(path.join(dir, e.name), r); }
      else if (D.isIdentityPath(r) && !/CAMBIOS\.md$/i.test(r)) out[r] = fs.readFileSync(path.join(dir, e.name), 'utf8');
    }
  };
  walk(root, ''); return out;
}
const read = (rel: string) => { try { return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'); } catch { return ''; } };
/** Texto actual de los archivos que toca un aprendizaje (salvo CAMBIOS.md). */
const learnedText = (p: any) => p.changes.filter((c: any) => c.kind !== 'install' && !/CAMBIOS\.md$/i.test(c.path)).map((c: any) => read(c.path)).join('\n');

const processJob = async (id: string) => {
  const r = await inject('POST', `${A}/documents/${id}/process`, { authorized: true });
  if (r.status === 202) assert.ok(await until(async () => { const j = await jobOf(id); return !!j && j.status !== 'processing' && j.status !== 'queued'; }), JSON.stringify(await jobOf(id)));
  return r;
};
const failedLoose = async (marker: string) => {
  scenario(RULES);
  const up = await upload(`${A}/documents/upload`, `${marker.split(' ')[0]}.pdf`, PDF(marker));
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const id = up.json.jobs[0].id as string;
  assert.equal((await processJob(id)).status, 202);
  const j = await jobOf(id); assert.equal(j.versions.at(-1).passed, false, JSON.stringify(j.versions));
  return j;
};

let looseLearned: any = null; let looseBefore: Record<string, string> = {};
test('(a) suelto: el reintento que pasa la QA aplica solo lo aprendido, sube la revisión y no deja nada pendiente', async () => {
  const j0 = await failedLoose('AA-A1 FALLA');
  assert.equal((await propsOf(j0.id)).length, 0, 'un fallo no aprende nada');
  const rev0 = await revision(); looseBefore = snap();
  scenario(RULES);
  assert.equal((await processJob(j0.id)).status, 202);
  const j = await jobOf(j0.id); assert.equal(j.versions.at(-1).passed, true, JSON.stringify(j.versions.at(-1)));
  assert.ok(await until(async () => (await propsOf(j0.id)).some(p => p.state !== 'proposed')), 'el aprendizaje se aplica');
  const ps = await propsOf(j0.id);
  assert.equal(ps.length, 1, JSON.stringify(ps)); const p = ps[0];
  assert.equal(p.state, 'applied', JSON.stringify(p)); assert.equal(p.autoApplied, true); assert.equal(p.origin, 'retry');
  assert.ok(p.appliedAt && p.backupDir, 'con copia de seguridad y registro');
  assert.equal(await revision(), rev0 + 1, 'una revisión nueva');
  const txt = learnedText(p);
  assert.ok(txt.includes('corregido'), `el plan que lo resolvió queda en la memoria o habilidad: ${txt.slice(0, 400)}`);
  assert.notDeepEqual(snap(), looseBefore, 'los archivos del agente cambiaron');
  assert.equal((await props()).filter(x => x.state === 'proposed').length, 0, 'ninguna propuesta pendiente');
  looseLearned = p;
});

test('(b) un reintento que no pasa (plan repetido o error del planificador) no cambia nada ni crea propuestas', async () => {
  for (const sc of [SAME, PLANNER_ERROR]) {
    const j0 = await failedLoose(`AA-B${sc === SAME ? 1 : 2} FALLA`);
    const rev0 = await revision(); const files0 = snap(); const n0 = (await props()).length;
    scenario(sc);
    assert.equal((await processJob(j0.id)).status, 202);
    const j = await jobOf(j0.id);
    assert.equal(j.versions.length, j0.versions.length, 'ninguna versión nueva'); assert.equal(j.needsIntervention, true);
    assert.equal(await revision(), rev0, 'la revisión no cambia'); assert.deepEqual(snap(), files0, 'los archivos del agente no cambian');
    assert.equal((await propsOf(j0.id)).length, 0, 'ninguna propuesta'); assert.equal((await props()).length, n0);
  }
});

let batchLearned: any[] = [];
test('(c) lote: 3 documentos corregidos en el mismo reintento se aprenden en orden, con revisiones consecutivas y sin 409', async () => {
  scenario(RULES);
  const up = await upload(`${A}/documents/upload`, 'AA lote C.zip', zip(['AA-C1 FALLA', 'AA-C2 FALLA', 'AA-C3 FALLA'].map(m => ({ name: `${m.split(' ')[0]}.pdf`, data: PDF(m) }))));
  assert.equal(up.status, 201, JSON.stringify(up.json)); const id = up.json.batch.id as string;
  assert.equal((await inject('POST', `${A}/batches/${id}/start`, { authorized: true })).status, 200);
  assert.ok(await until(async () => settled(await batchOf(id))));
  const b0 = await batchOf(id); assert.equal(b0.counts.failed, 3, JSON.stringify(b0.counts));
  const jobIds = b0.items.map((i: any) => i.jobId as string);
  const rev0 = await revision();
  scenario(RULES);
  const r = await inject('POST', `${A}/batches/${id}/retry`, { authorized: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(await until(async () => settled(await batchOf(id))));
  assert.ok(await until(async () => (await props()).filter(p => jobIds.includes(p.jobId) && p.state !== 'proposed').length === 3), 'los 3 aprendizajes terminan');
  const b = await batchOf(id); assert.equal(b.counts.passed, 3, JSON.stringify(b.counts)); assert.equal(b.counts.failed, 0);
  const ps = (await props()).filter(p => jobIds.includes(p.jobId));
  assert.equal(ps.length, 3, JSON.stringify(ps.map(p => [p.state, p.error])));
  for (const p of ps) {
    assert.equal(p.state, 'applied', `sin conflicto de versión: ${p.error}`); assert.equal(p.autoApplied, true); assert.equal(p.origin, 'retry');
    assert.ok(!/stale|obsolet/i.test(String(p.error ?? '')), String(p.error));
  }
  assert.equal(await revision(), rev0 + 3, 'revisiones consecutivas: una por aprendizaje');
  batchLearned = [...ps].sort((x, y) => String(x.appliedAt).localeCompare(String(y.appliedAt)));
  const now = snap(); const all = Object.values(now).join('\n');
  assert.ok(all.includes('corregido'), 'lo aprendido está en los archivos');
  assert.equal((await props()).filter(x => x.state === 'proposed').length, 0, 'ninguna propuesta pendiente');
});

test('(d) Deshacer: restaura los archivos y lo marca como deshecho; deshacer otro deja intacto lo aprendido antes', async () => {
  assert.equal(batchLearned.length, 3, 'depende de (c)');
  const [first, second, last] = batchLearned;
  assert.equal((await inject('POST', `${A}/proposals/${last.id}/undo`, {})).status, 400, 'requiere confirmación');
  const paths = last.changes.filter((c: any) => c.kind !== 'install' && !/CAMBIOS\.md$/i.test(c.path)).map((c: any) => c.path as string);
  const rev0 = await revision();
  const r = await inject('POST', `${A}/proposals/${last.id}/undo`, { authorized: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const undone = (await props()).find(p => p.id === last.id);
  assert.equal(undone.state, 'undone'); assert.ok(undone.undoneAt, 'con la fecha del Deshacer');
  assert.equal(await revision(), rev0 + 1, 'Deshacer es una revisión nueva');
  for (const rel of paths) {
    const prev = last.changes.find((c: any) => c.path === rel)?.previous;
    if (typeof prev === 'string') assert.equal(read(rel), prev, `«${rel}» vuelve a su contenido anterior`);
  }
  const again = await inject('POST', `${A}/proposals/${last.id}/undo`, { authorized: true });
  assert.ok(again.status >= 400, 'no se deshace dos veces');
  const firstText = learnedText(first);
  assert.equal((await inject('POST', `${A}/proposals/${second.id}/undo`, { authorized: true })).status, 200);
  assert.equal((await props()).find(p => p.id === second.id).state, 'undone');
  assert.equal((await props()).find(p => p.id === first.id).state, 'applied', 'el primero sigue aplicado');
  assert.ok(firstText.includes('corregido') && learnedText(first).includes('corregido'), 'lo aprendido en el primero sigue en sus archivos');
  assert.ok(looseLearned, 'el aprendizaje suelto de (a) sigue registrado');
  assert.equal((await props()).find(p => p.id === looseLearned.id).state, 'applied');
});

test('(e) sin el permiso applyImprovements queda una propuesta pendiente y no se toca nada', async () => {
  const j0 = await failedLoose('AA-E1 FALLA');
  const g = await inject('PUT', `${A}/source/grants`, { grants: { ...GRANTS, applyImprovements: false }, authorized: true });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  try {
    const rev0 = await revision(); const files0 = snap();
    scenario(RULES);
    assert.equal((await processJob(j0.id)).status, 202);
    assert.equal((await jobOf(j0.id)).versions.at(-1).passed, true);
    assert.ok(await until(async () => (await propsOf(j0.id)).length === 1));
    const [p] = await propsOf(j0.id);
    assert.equal(p.state, 'proposed', JSON.stringify(p)); assert.ok(!p.autoApplied, 'no se aplicó solo');
    assert.equal(await revision(), rev0); assert.deepEqual(snap(), files0);
    assert.equal((await inject('POST', `${A}/proposals/${looseLearned.id}/undo`, { authorized: true })).status, 403, 'Deshacer también requiere el permiso');
  } finally {
    await inject('PUT', `${A}/source/grants`, { grants: GRANTS, authorized: true });
  }
});

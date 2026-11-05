import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * HU-177 · Eliminación autorizada con histórico, conciliación con el disco y reintento que aprende (docs/agentes-externos.md).
 * Sin modelo real ni Python real. Comprueba:
 *  (a) sin authorized → 403 y nada borrado;
 *  (b) eliminar un documento borra sus archivos, sale de la lista, sigue en el histórico con su SHA y los conteos cuadran;
 *  (c) eliminar un lote borra solo su carpeta y deja intactos los demás lotes;
 *  (d) un lote en proceso → 409;
 *  (e) una carpeta fuera de la raíz del agente (ruta transversal) se rechaza y no se toca;
 *  (f) lo borrado a mano aparece como «falta en disco» y se puede quitar de la lista;
 *  (g) volver a subir un PDF eliminado crea un documento nuevo;
 *  (h) el reintento de un rechazado recibe el motivo anterior y, si pasa, su aprendizaje se aplica solo (HU-179, con Deshacer).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-elim-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-elim-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };

const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-elim-tools-'));
fs.mkdirSync(path.join(tools, 'kits', 'pdf-word'), { recursive: true });
fs.writeFileSync(path.join(tools, 'pdf_info.py'), `const s=require('fs').readFileSync(process.argv[2]).toString('latin1');if(s.includes('CORRUPTO')){console.error('PDF dañado');process.exit(1)}console.log(JSON.stringify({encrypted:false,pages:1,text_pages:1,chars:120,sizes:[[612,792]],ocr_available:false}));`);
fs.writeFileSync(path.join(tools, 'check_python.py'), `console.log('ok')`);
fs.writeFileSync(path.join(tools, 'kits', 'pdf-word', 'convertir_editable.py'), '// kit simulado');
// La QA simulada rechaza un Word marcado «MALO» (texto no editable); el resto pasa.
fs.writeFileSync(path.join(tools, 'doc_qa.py'), `const fs=require('fs'),path=require('path');const [inp,out,qa]=process.argv.slice(2);fs.mkdirSync(qa,{recursive:true});const bad=[inp,out].some(f=>{try{return fs.readFileSync(f,'latin1').includes('MALO')}catch{return false}});const gates={texto_editable:!bad,sin_paginas_como_imagen:true,mismas_paginas:true};
fs.writeFileSync(path.join(qa,'qa.json'),JSON.stringify({pdf_pages:1,rendered_pages:1,recall_docx_outside_figures:1,words_in_figures:0,figure_share:0,order_render:1,duplication:0,docx:{pictures:0,largest_picture_ratio:0,pictures_over_60pct:0,tables:1},pages:[{page:1,visual_diff:0.01,rendered_words:10}],gates,passed:!bad,schema_problems:[]}));fs.writeFileSync(path.join(qa,'comparacion-01.png'),'png');`);
// El script del agente produce un Word «MALO» con un PDF «RECHAZO» salvo que el plan lleve la corrección.
const AGENT_SCRIPT = `const fs=require('fs');const a=process.argv.slice(2);const inp=fs.readFileSync(a[0],'latin1');const bad=inp.includes('RECHAZO')&&!a.includes('corregido');setTimeout(()=>{fs.writeFileSync(a[1],(bad?'MALO-':'PK-docx-')+inp.length)}, inp.includes('LENTO')?400:40);`;
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
const { documentsDb } = await import('../src/services/documentJobs.ts');

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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-elim-agente-'));
after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temporal */ } });
const root = path.join(base, 'Agente'); const w = (rel: string, t: string) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
w('AGENTS.md', '# Agente de pruebas\n\nConvierte PDF.\n');
w('skills/conv/SKILL.md', '---\nname: conv\ndescription: Convierte.\n---\n\n# Conv — versión 1.0.0\n\nUsa scripts/conv.py.\n');
w('skills/conv/scripts/conv.py', AGENT_SCRIPT);
w('documentos/LEEME.md', 'x');
const pv = (await inject('POST', `${W}/agents/external/preview`, { path: root })).json;
const imp = await inject('POST', `${W}/agents/external`, { path: root, hash: pv.hash, name: 'Conversor', role: 'Pruebas de eliminación', summary: '', department: 'Documentos', harness: 'claude-code', model: 'claude-sonnet-4-5', grants: { writeDocuments: true, runScripts: true, applyImprovements: true }, authorized: true });
const agentId = imp.json.id as string;
const A = `${W}/agents/${agentId}`;
const PLAN = { match: 'Reglas del plan', text: JSON.stringify({ script: 'skills/conv/scripts/conv.py', args: ['{entrada}', '{salida}'], reason: 'Mi habilidad.' }) };
const RETRY_PLAN = { match: 'REINTENTO', text: JSON.stringify({ script: 'skills/conv/scripts/conv.py', args: ['{entrada}', '{salida}', '--modo', 'corregido'], reason: 'Corrijo el texto no editable del intento anterior.' }) };
const SUMMARY = { match: '"cifras"', text: 'Resumen del lote (simulado).' };
const RULES = { auth: 'subscription', rules: [SUMMARY, RETRY_PLAN, PLAN] };

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
const docs = async (history = false) => (await inject('GET', `${A}/documents${history ? '?includeRemoved=1' : ''}`)).json;
const batchOf = async (id: string, history = false) => (await docs(history)).batches.find((b: any) => b.id === id);
const jobOf = async (id: string, history = false) => (await docs(history)).jobs.find((j: any) => j.id === id);
const onDisk = (rel: string) => fs.existsSync(path.join(root, 'documentos', ...rel.split('/')));
const runBatch = async (id: string) => {
  const r = await inject('POST', `${A}/batches/${id}/start`, { authorized: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(await until(async () => (await batchOf(id)).status === 'completed'), JSON.stringify((await batchOf(id))?.counts));
  return batchOf(id);
};
const newBatch = async (name: string, markers: string[]) => {
  const r = await upload(`${A}/documents/upload`, name, zip(markers.map(m => ({ name: `${m}.pdf`, data: PDF(m) }))));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.batch;
};
const addsUp = (c: any) => D.batchCountsAddUp(c);

test('(a) sin autorización → 403 y no se borra nada', async () => {
  scenario(RULES);
  const b = await runBatch((await newBatch('Sin permiso.zip', ['ELIM-A1'])).id);
  const jobId = b.items[0].jobId; const j = await jobOf(jobId);
  for (const body of [{}, { authorized: false }]) {
    const r1 = await inject('DELETE', `${A}/documents/${jobId}`, body); assert.equal(r1.status, 403, JSON.stringify(r1.json));
    const r2 = await inject('DELETE', `${A}/batches/${b.id}`, body); assert.equal(r2.status, 403, JSON.stringify(r2.json));
  }
  assert.ok(onDisk(b.slug) && onDisk(j.slug), 'los archivos siguen en disco');
  assert.ok(await jobOf(jobId)); assert.ok(await batchOf(b.id));
  const pv = await inject('GET', `${A}/batches/${b.id}/removal-preview`);
  assert.equal(pv.status, 200, JSON.stringify(pv.json)); assert.ok(pv.json.files > 0 && pv.json.freedBytes > 0 && pv.json.token);
  assert.ok(onDisk(b.slug), 'la vista previa no borra nada');
});

let removedPdf: Buffer; let removedJobId = '';
test('(b) eliminar un documento: borra sus archivos, sale de la lista, queda en el histórico y los conteos cuadran', async () => {
  scenario(RULES);
  const b = await runBatch((await newBatch('Dos.zip', ['ELIM-B1', 'ELIM-B2'])).id);
  assert.equal(b.counts.passed, 2);
  const [x, y] = await Promise.all(b.items.map((i: any) => jobOf(i.jobId)));
  const pv = (await inject('GET', `${A}/documents/${x.id}/removal-preview`)).json;
  assert.ok(pv.exists && pv.files > 0); assert.ok(pv.keeps.length > 0);
  const r = await inject('DELETE', `${A}/documents/${x.id}`, { authorized: true, reason: 'Ya no lo necesito', previewToken: pv.token });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.kind, 'document'); assert.equal(r.json.files, pv.files); assert.equal(r.json.freedBytes, pv.freedBytes);
  assert.deepEqual(r.json.sha256, [x.inputSha256]);
  assert.ok(!onDisk(x.slug), 'sus archivos ya no están'); assert.ok(onDisk(y.slug), 'el otro documento sigue');
  assert.equal(await jobOf(x.id), undefined, 'desaparece de la lista');
  const hist = await jobOf(x.id, true);
  assert.equal(hist.presence, 'removed'); assert.equal(hist.inputSha256, x.inputSha256); assert.equal(hist.versions.length, 1, 'conserva sus versiones registradas');
  assert.ok((await docs(true)).removals.some((m: any) => m.id === r.json.id && m.reason === 'Ya no lo necesito'));
  const after2 = await batchOf(b.id);
  assert.equal(after2.counts.removed, 1); assert.equal(after2.counts.passed, 1);
  assert.ok(addsUp(after2.counts), JSON.stringify(after2.counts));
  assert.ok(after2.items.find((i: any) => i.jobId === x.id).removed);
  const again = await inject('DELETE', `${A}/documents/${x.id}`, { authorized: true });
  assert.equal(again.status, 409, 'ya eliminado');
  removedPdf = PDF('ELIM-B1'); removedJobId = x.id;
});

test('(c) eliminar un lote borra solo su carpeta y deja intactos los otros lotes', async () => {
  scenario(RULES);
  const keep = await runBatch((await newBatch('Se queda.zip', ['ELIM-C1'])).id);
  const gone = await runBatch((await newBatch('Se va.zip', ['ELIM-C2', 'ELIM-C3'])).id);
  const man = fs.readFileSync(path.join(root, 'documentos', keep.slug, 'MANIFIESTO.json'), 'utf8');
  const snap = JSON.stringify(keep.items);
  const r = await inject('DELETE', `${A}/batches/${gone.id}`, { authorized: true });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.kind, 'batch'); assert.equal(r.json.sha256.length, 2);
  assert.ok(!onDisk(gone.slug)); assert.ok(onDisk(keep.slug));
  assert.equal(fs.readFileSync(path.join(root, 'documentos', keep.slug, 'MANIFIESTO.json'), 'utf8'), man, 'el otro manifiesto no cambia');
  assert.equal(await batchOf(gone.id), undefined, 'sale de la lista');
  for (const it of gone.items) assert.equal(await jobOf(it.jobId), undefined);
  assert.equal(JSON.stringify((await batchOf(keep.id)).items), snap, 'el otro lote no cambia');
  assert.equal((await batchOf(gone.id, true)).presence, 'removed', 'sigue en el histórico');
  assert.ok(fs.readFileSync(path.join(root, 'documentos', 'HISTORIAL.md'), 'utf8').includes('Se va'), 'línea en el historial, fuera de la carpeta borrada');
});

test('(d) no se puede eliminar un lote que se está procesando (409)', async () => {
  scenario(RULES);
  const b = await newBatch('En marcha.zip', ['ELIM-D1 LENTO', 'ELIM-D2 LENTO']);
  const s = await inject('POST', `${A}/batches/${b.id}/start`, { authorized: true }); assert.equal(s.status, 200, JSON.stringify(s.json));
  const r = await inject('DELETE', `${A}/batches/${b.id}`, { authorized: true });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(onDisk(b.slug)); assert.ok(await batchOf(b.id));
  assert.ok(await until(async () => (await batchOf(b.id)).status === 'completed'));
  assert.ok(addsUp((await batchOf(b.id)).counts));
});

test('(e) una carpeta fuera de la raíz del agente se rechaza y no se toca', async () => {
  scenario(RULES);
  const b = await newBatch('Transversal.zip', ['ELIM-E1']);
  const outside = path.join(base, 'fuera'); fs.mkdirSync(outside, { recursive: true }); fs.writeFileSync(path.join(outside, 'importante.txt'), 'no tocar');
  const db = documentsDb(S) as any;
  db.prepare('UPDATE document_batches SET slug = ? WHERE id = ?').run('../../fuera', b.id);
  try {
    const pv = await inject('GET', `${A}/batches/${b.id}/removal-preview`);
    assert.ok(pv.status >= 400 && pv.status < 500, `vista previa: ${pv.status} ${JSON.stringify(pv.json)}`);
    const r = await inject('DELETE', `${A}/batches/${b.id}`, { authorized: true });
    assert.ok(r.status >= 400 && r.status < 500, `borrado: ${r.status} ${JSON.stringify(r.json)}`);
    assert.ok(fs.existsSync(path.join(outside, 'importante.txt')), 'nada fuera de la raíz se borra');
  } finally { db.prepare('UPDATE document_batches SET slug = ? WHERE id = ?').run(b.slug, b.id); }
  assert.ok(onDisk(b.slug));
});

test('(f) lo borrado a mano aparece como «falta en disco» y se puede quitar de la lista', async () => {
  scenario(RULES);
  const b = await newBatch('A mano.zip', ['ELIM-F1']);
  fs.rmSync(path.join(root, 'documentos', ...b.slug.split('/')), { recursive: true, force: true });
  const listed = await batchOf(b.id);
  assert.ok(listed, 'sigue en la lista hasta que el propietario lo quite');
  assert.ok(listed.presence === 'missing' || listed.missingOnDisk === true, JSON.stringify({ presence: listed.presence, missing: listed.missingOnDisk }));
  const pv = (await inject('GET', `${A}/batches/${b.id}/removal-preview`)).json;
  assert.equal(pv.exists, false); assert.equal(pv.files, 0);
  const r = await inject('DELETE', `${A}/batches/${b.id}`, { authorized: true });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.missingOnDisk, true); assert.equal(r.json.freedBytes, 0);
  assert.equal(await batchOf(b.id), undefined);
});

test('(g) volver a subir un PDF eliminado crea un documento nuevo', async () => {
  scenario(RULES);
  assert.ok(removedJobId, 'depende de (b)');
  const r = await upload(`${A}/documents/upload`, 'ELIM-B1.pdf', removedPdf);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const j = r.json.jobs[0];
  assert.notEqual(j.id, removedJobId, 'documento nuevo'); assert.ok(!j.duplicate, 'un SHA eliminado no bloquea');
  assert.ok(await jobOf(j.id)); assert.ok(onDisk(j.slug));
  const z = await newBatch('Otra vez.zip', ['ELIM-B1']);
  assert.equal(z.items[0].outcome, 'accepted'); assert.notEqual(z.items[0].jobId, removedJobId);
});

test('(h) el reintento de un rechazado recibe el motivo anterior y una corrección exitosa se aprende sola', async () => {
  scenario(RULES);
  const b = await runBatch((await newBatch('Rechazo.zip', ['ELIM-H1 RECHAZO'])).id);
  assert.equal(b.items[0].state, 'rejected_qa', JSON.stringify(b.items[0])); assert.equal(b.counts.rejectedQa, 1);
  const jobId = b.items[0].jobId;
  const r = await inject('POST', `${A}/batches/${b.id}/retry`, { authorized: true, includeRejected: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(await until(async () => { const x = await batchOf(b.id); return x.status === 'completed' && x.items[0].state !== 'queued' && x.items[0].state !== 'processing'; }), JSON.stringify((await batchOf(b.id))?.items));
  const done = await batchOf(b.id);
  assert.equal(done.items[0].state, 'passed', JSON.stringify(done.items[0])); assert.ok(addsUp(done.counts), JSON.stringify(done.counts));
  const j = await jobOf(jobId);
  assert.equal(j.versions.length, 2, 'una sola corrección, sin reintentos en bucle');
  assert.equal(j.versions[0].passed, false); assert.equal(j.versions[1].passed, true);
  assert.ok(j.versions[1].plan.args.includes('corregido'), 'el agente replanificó con el diagnóstico');
  assert.match(String(j.versions[1].feedback ?? ''), /Corrección del intento anterior/, 'recibió el motivo del fallo anterior');
  const learned = async () => (await docs()).proposals.filter((p: any) => p.jobId === jobId && String(p.feedback).startsWith('Reintento corregido'));
  assert.ok(await until(async () => (await learned()).some((p: any) => p.state === 'applied')), JSON.stringify(await learned()));
  const props = await learned();
  assert.equal(props.length, 1, 'un solo aprendizaje del reintento');
  assert.equal(props[0].state, 'applied', 'HU-179: un reintento verificado se aprende solo, sin propuesta pendiente');
  assert.equal(props[0].autoApplied, true, 'aplicado por el Portal sin aprobación manual');
  assert.equal(props[0].origin, 'retry', 'origen: aprendido de un reintento');
  assert.ok(!props.some((p: any) => p.state === 'proposed'), 'ninguna propuesta queda pendiente');
});

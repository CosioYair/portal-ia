import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * HU-177 · Lotes independientes (docs/lotes-adjuntos-y-mejoras.md). Sin modelo real ni Python real. Comprueba:
 *  (a) un PDF con el mismo nombre y contenido distinto crea un documento nuevo, con carpeta y versiones propias;
 *  (b) el mismo PDF en otro lote se procesa en ESE lote (su trabajo, su carpeta, su versión) y el lote anterior no cambia;
 *  (c) un repetido dentro del mismo ZIP no crea otro documento y su motivo figura en el manifiesto;
 *  (d) dos lotes recibidos a la vez no comparten ni sobrescriben carpetas ni trabajos;
 *  (e) los conteos cuadran (total = listos + rechazados + fallidos + cancelados + excluidos + por hacer) al recibir, en
 *      marcha y al terminar, y cada documento que no está listo tiene su motivo.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-indep-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-indep-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };

const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-indep-tools-'));
fs.mkdirSync(path.join(tools, 'kits', 'pdf-word'), { recursive: true });
fs.writeFileSync(path.join(tools, 'pdf_info.py'), `const s=require('fs').readFileSync(process.argv[2]).toString('latin1');if(s.includes('CORRUPTO')){console.error('PDF dañado');process.exit(1)}console.log(JSON.stringify({encrypted:false,pages:1,text_pages:1,chars:120,sizes:[[612,792]],ocr_available:false}));`);
fs.writeFileSync(path.join(tools, 'check_python.py'), `console.log('ok')`);
fs.writeFileSync(path.join(tools, 'kits', 'pdf-word', 'convertir_editable.py'), '// kit simulado');
fs.writeFileSync(path.join(tools, 'doc_qa.py'), `const fs=require('fs'),path=require('path');const [inp,out,qa]=process.argv.slice(2);fs.mkdirSync(qa,{recursive:true});const gates={texto_editable:true,sin_paginas_como_imagen:true,mismas_paginas:true};
fs.writeFileSync(path.join(qa,'qa.json'),JSON.stringify({pdf_pages:1,rendered_pages:1,recall_docx_outside_figures:1,words_in_figures:0,figure_share:0,order_render:1,duplication:0,docx:{pictures:0,largest_picture_ratio:0,pictures_over_60pct:0,tables:1},pages:[{page:1,visual_diff:0.01,rendered_words:10}],gates,passed:true,schema_problems:[]}));fs.writeFileSync(path.join(qa,'comparacion-01.png'),'png');`);
const AGENT_SCRIPT = `const fs=require('fs');const a=process.argv.slice(2);const inp=fs.readFileSync(a[0],'latin1');setTimeout(()=>{fs.writeFileSync(a[1],'PK-docx-'+inp.length)}, inp.includes('LENTO')?400:40);`;
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-indep-agente-'));
after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temporal */ } });
const root = path.join(base, 'Agente'); const w = (rel: string, t: string) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
w('AGENTS.md', '# Agente de pruebas\n\nConvierte PDF.\n');
w('skills/conv/SKILL.md', '---\nname: conv\ndescription: Convierte.\n---\n\n# Conv — versión 1.0.0\n\nUsa scripts/conv.py.\n');
w('skills/conv/scripts/conv.py', AGENT_SCRIPT);
w('documentos/LEEME.md', 'x');
const pv = (await inject('POST', `${W}/agents/external/preview`, { path: root })).json;
const imp = await inject('POST', `${W}/agents/external`, { path: root, hash: pv.hash, name: 'Conversor', role: 'Pruebas de lotes', summary: '', department: 'Documentos', harness: 'claude-code', model: 'claude-sonnet-4-5', grants: { writeDocuments: true, runScripts: true, applyImprovements: true }, authorized: true });
const agentId = imp.json.id as string;
const A = `${W}/agents/${agentId}`;
const PLAN = { match: 'Reglas del plan', text: JSON.stringify({ script: 'skills/conv/scripts/conv.py', args: ['{entrada}', '{salida}'], reason: 'Mi habilidad.' }) };
const SUMMARY = { match: '"cifras"', text: 'Resumen del lote (simulado).' };

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
const batchOf = async (id: string) => (await docs()).batches.find((b: any) => b.id === id);
const jobOf = async (id: string) => (await docs()).jobs.find((j: any) => j.id === id);
const manifest = (b: any) => JSON.parse(fs.readFileSync(path.join(root, 'documentos', b.slug, 'MANIFIESTO.json'), 'utf8'));
const runBatch = async (id: string) => {
  const r = await inject('POST', `${A}/batches/${id}/start`, { authorized: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(await until(async () => (await batchOf(id)).status === 'completed'), JSON.stringify((await batchOf(id))?.counts));
  return batchOf(id);
};
/** total = suma de las partes; cada elemento cuenta en un solo estado (`duplicates` es informativo y no se suma). */
const addsUp = (c: any) => {
  const total = c.total ?? c.detected;
  const sum = c.passed + c.rejectedQa + c.failed + c.cancelled + c.excluded + c.pending + c.queued + c.processing;
  return total === c.detected && total === sum;
};

test('(a) mismo nombre y contenido distinto: documento nuevo, con carpeta y versiones propias', async () => {
  scenario({ auth: 'subscription', rules: [SUMMARY, PLAN] });
  const b1 = (await upload(`${A}/documents/upload`, 'Propuesta Visual.zip', zip([{ name: 'Propuesta Visual US-09.pdf', data: PDF('US-09 PRIMERA') }]))).json.batch;
  const b2 = (await upload(`${A}/documents/upload`, 'Propuesta Visual.zip', zip([{ name: 'Propuesta Visual US-09.pdf', data: PDF('US-09 SEGUNDA') }]))).json.batch;
  assert.notEqual(b1.id, b2.id); assert.notEqual(b1.slug, b2.slug, 'cada lote con su carpeta');
  assert.equal(b2.items[0].outcome, 'accepted', 'un nombre repetido no es un error'); assert.equal(b2.items[0].reason ?? null, null);
  assert.notEqual(b1.items[0].jobId, b2.items[0].jobId);
  const [d1, d2] = [await runBatch(b1.id), await runBatch(b2.id)];
  assert.equal(d1.counts.passed, 1); assert.equal(d2.counts.passed, 1);
  const [j1, j2] = [await jobOf(b1.items[0].jobId), await jobOf(b2.items[0].jobId)];
  assert.notEqual(j1.slug, j2.slug); assert.notEqual(j1.inputSha256, j2.inputSha256);
  assert.equal(j1.versions.length, 1); assert.equal(j2.versions.length, 1);
  assert.ok(fs.existsSync(path.join(root, 'documentos', ...j1.slug.split('/'))) && fs.existsSync(path.join(root, 'documentos', ...j2.slug.split('/'))));
  // También fuera de un lote: dos PDF sueltos con el mismo nombre y contenido distinto son dos documentos.
  const s1 = (await upload(`${A}/documents/upload`, 'Mismo nombre.pdf', PDF('SUELTO-1'))).json.jobs[0];
  const s2 = (await upload(`${A}/documents/upload`, 'Mismo nombre.pdf', PDF('SUELTO-2'))).json.jobs[0];
  assert.notEqual(s1.id, s2.id); assert.notEqual(s1.slug, s2.slug); assert.ok(!s2.duplicate);
});

test('(b) el mismo PDF en otro lote: su propio trabajo, carpeta y versión; el lote anterior no cambia', async () => {
  scenario({ auth: 'subscription', rules: [SUMMARY, PLAN] });
  const entries = [{ name: 'US-10.pdf', data: PDF('US-10') }, { name: 'US-11.pdf', data: PDF('US-11') }];
  const b1 = await runBatch((await upload(`${A}/documents/upload`, 'Lote 1.zip', zip(entries))).json.batch.id);
  const jobs1 = await Promise.all(b1.items.map((i: any) => jobOf(i.jobId)));
  const snap = JSON.stringify({ items: b1.items, versions: jobs1.map((j: any) => j.versions) });
  const man1 = fs.readFileSync(path.join(root, 'documentos', b1.slug, 'MANIFIESTO.json'), 'utf8');
  const r2 = (await upload(`${A}/documents/upload`, 'Lote 1.zip', zip(entries))).json.batch;
  assert.deepEqual(r2.items.map((i: any) => i.outcome), ['accepted', 'accepted'], 'no queda como «ya recibido antes»');
  assert.equal(r2.counts.duplicates, 0); assert.equal(r2.counts.accepted, 2);
  for (const it of r2.items) assert.ok(!b1.items.some((x: any) => x.jobId === it.jobId), 'su propio trabajo');
  const b2 = await runBatch(r2.id);
  assert.equal(b2.counts.passed, 2);
  for (const it of b2.items) {
    const j = await jobOf(it.jobId);
    assert.equal(j.batchId, b2.id); assert.equal(j.versions.length, 1, 'con su versión');
    assert.ok(!jobs1.some((x: any) => x.slug === j.slug), 'en su carpeta');
  }
  const b1After = await batchOf(b1.id); const jobs1After = await Promise.all(b1After.items.map((i: any) => jobOf(i.jobId)));
  assert.equal(JSON.stringify({ items: b1After.items, versions: jobs1After.map((j: any) => j.versions) }), snap, 'el lote anterior no cambia');
  assert.equal(fs.readFileSync(path.join(root, 'documentos', b1.slug, 'MANIFIESTO.json'), 'utf8'), man1, 'su manifiesto tampoco');
});

test('(c) repetido dentro del mismo ZIP: no crea otro documento y su motivo figura en el manifiesto', async () => {
  scenario({ auth: 'subscription', rules: [SUMMARY, PLAN] });
  const b = (await upload(`${A}/documents/upload`, 'Repetido.zip', zip([{ name: 'uno.pdf', data: PDF('DENTRO-1') }, { name: 'copias/uno (copia).pdf', data: PDF('DENTRO-1') }]))).json.batch;
  const [first, copy] = b.items;
  assert.equal(first.outcome, 'accepted');
  assert.ok(copy.outcome === 'duplicate' || copy.state === 'excluded', `la copia no es «nueva»: ${copy.outcome}/${copy.state}`);
  assert.match(copy.reason, /repetido dentro del ZIP: mismo contenido que «uno\.pdf»/);
  assert.ok(copy.jobId === first.jobId || copy.jobId == null, 'no se crea un segundo documento');
  assert.equal((await docs()).jobs.filter((j: any) => j.batchId === b.id).length, 1);
  const doc = manifest(b).documentos.find((d: any) => d.entrada === 'copias/uno (copia).pdf');
  assert.match(doc.motivo, /repetido dentro del ZIP/);
  assert.ok(addsUp(b.counts), JSON.stringify(b.counts));
  const done = await runBatch(b.id); assert.ok(addsUp(done.counts), JSON.stringify(done.counts));
  assert.equal((await jobOf(first.jobId)).versions.length, 1, 'se convierte una vez');
});

test('(d) dos lotes recibidos a la vez no comparten ni sobrescriben carpetas ni trabajos', async () => {
  scenario({ auth: 'subscription', rules: [SUMMARY, PLAN] });
  const entries = [{ name: 'US-12.pdf', data: PDF('US-12 LENTO') }, { name: 'US-13.pdf', data: PDF('US-13') }];
  const [r1, r2] = await Promise.all([upload(`${A}/documents/upload`, 'Simultaneo.zip', zip(entries)), upload(`${A}/documents/upload`, 'Simultaneo.zip', zip(entries))]);
  assert.equal(r1.status, 201, JSON.stringify(r1.json)); assert.equal(r2.status, 201, JSON.stringify(r2.json));
  const [x, y] = [r1.json.batch, r2.json.batch];
  assert.notEqual(x.id, y.id); assert.notEqual(x.slug, y.slug);
  const ids = [...x.items, ...y.items].map((i: any) => i.jobId);
  assert.equal(new Set(ids).size, 4, 'cada lote con sus trabajos');
  assert.ok(fs.existsSync(path.join(root, 'documentos', x.slug, 'origen', 'Simultaneo.zip')) && fs.existsSync(path.join(root, 'documentos', y.slug, 'origen', 'Simultaneo.zip')));
  await Promise.all([inject('POST', `${A}/batches/${x.id}/start`, { authorized: true }), inject('POST', `${A}/batches/${y.id}/start`, { authorized: true })]);
  assert.ok(await until(async () => (await batchOf(x.id)).status === 'completed' && (await batchOf(y.id)).status === 'completed'));
  const slugs = new Set<string>();
  for (const id of ids) { const j = await jobOf(id); assert.equal(j.versions.length, 1, j.slug); slugs.add(j.slug); }
  assert.equal(slugs.size, 4, 'ninguna carpeta compartida');
  assert.equal((await batchOf(x.id)).counts.passed, 2); assert.equal((await batchOf(y.id)).counts.passed, 2);
});

test('(e) los conteos cuadran al recibir, en marcha y al terminar; cada documento no listo tiene su motivo', async () => {
  scenario({ auth: 'subscription', rules: [SUMMARY, PLAN] });
  const entries = [
    ...Array.from({ length: 4 }, (_, i) => ({ name: `US-${20 + i}.pdf`, data: PDF(`CONTEO-${i} LENTO`) })),
    { name: 'US-10.pdf', data: PDF('US-10') }, // ya convertido en otro lote: aquí cuenta como uno más
    { name: 'Dañado.pdf', data: PDF('CORRUPTO') }, { name: 'notas.txt', data: Buffer.from('hola') }, { name: '__MACOSX/._x.pdf', data: Buffer.from('x') },
    { name: 'otra/US-20.pdf', data: PDF('CONTEO-0 LENTO') }
  ];
  const b = (await upload(`${A}/documents/upload`, 'Conteos.zip', zip(entries))).json.batch;
  assert.equal(b.counts.total ?? b.counts.detected, 9); assert.ok(addsUp(b.counts), JSON.stringify(b.counts));
  const r = await inject('POST', `${A}/batches/${b.id}/start`, { authorized: true }); assert.equal(r.status, 200, JSON.stringify(r.json));
  let seen = 0;
  assert.ok(await until(async () => { const x = await batchOf(b.id); assert.ok(addsUp(x.counts), `en marcha: ${JSON.stringify(x.counts)}`); seen++; return x.status === 'completed'; }));
  assert.ok(seen >= 1);
  const done = await batchOf(b.id);
  assert.ok(addsUp(done.counts), JSON.stringify(done.counts));
  assert.equal(done.counts.passed, 6); assert.equal(done.counts.failed, 1); assert.equal(done.counts.excluded, 2);
  for (const it of done.items.filter((i: any) => i.state !== 'passed')) assert.ok(it.reason || it.error, `sin motivo: ${it.entryName}`);
  const man = manifest(done);
  assert.equal(man.documentos.length, 9);
  for (const d of man.documentos.filter((d: any) => d.estado === 'excluded')) assert.ok(d.motivo, d.entrada);
});

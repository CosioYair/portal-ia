import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * HU-180 · Primer intento con lo aprendido. Sin modelo real ni Python real. Comprueba:
 *  (a) el caso del propietario: el mismo ZIP, ya resuelto con reintentos en un lote anterior, se aprueba ENTERO a la primera en
 *      un lote nuevo (1 versión por trabajo, 0 «REINTENTO», 1 conversión por documento) con el plan que funcionó (mismo SHA-256),
 *      anotado en el informe, en HISTORIAL.md y en el evento del agente; el plan del lote recibe la memoria aplicada;
 *  (b) si el plan probado ya no es válido (script inexistente o cambiado), se usa el plan del lote sin errores.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-pia-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-pia-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = () => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];
const retryRuns = () => ccRuns().filter((c: any) => String(c.prompt).includes('REINTENTO'));
const lotPlanRuns = () => ccRuns().filter((c: any) => !String(c.prompt).includes('REINTENTO') && String(c.prompt).includes('Reglas del plan'));

const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-pia-tools-'));
const CONV = path.join(tools, 'conversiones.log');
const convRuns = () => fs.existsSync(CONV) ? fs.readFileSync(CONV, 'utf8').split('\n').filter(Boolean).length : 0;
fs.mkdirSync(path.join(tools, 'kits', 'pdf-word'), { recursive: true });
fs.writeFileSync(path.join(tools, 'pdf_info.py'), `console.log(JSON.stringify({encrypted:false,pages:1,text_pages:1,chars:120,sizes:[[612,792]],ocr_available:false}));`);
fs.writeFileSync(path.join(tools, 'check_python.py'), `console.log('ok')`);
fs.writeFileSync(path.join(tools, 'kits', 'pdf-word', 'convertir_editable.py'), '// kit simulado');
fs.writeFileSync(path.join(tools, 'doc_qa.py'), `const fs=require('fs'),path=require('path');const [inp,out,qa]=process.argv.slice(2);fs.mkdirSync(qa,{recursive:true});const gates={texto_editable:true,sin_paginas_como_imagen:true,mismas_paginas:true};
fs.writeFileSync(path.join(qa,'qa.json'),JSON.stringify({pdf_pages:1,rendered_pages:1,recall_docx_outside_figures:1,words_in_figures:0,figure_share:0,order_render:1,duplication:0,docx:{pictures:0,largest_picture_ratio:0,pictures_over_60pct:0,tables:1},pages:[{page:1,visual_diff:0.01,rendered_words:10}],gates,passed:true,schema_problems:[]}));fs.writeFileSync(path.join(qa,'comparacion-01.png'),'png');`);
// Falla la conversión de un PDF «FALLA» salvo que el plan lleve la corrección (igual que reintento-aprende.test.ts).
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
const { documentsDb, planSignature } = await import('../src/services/documentJobs.ts');
const { agentEvents } = await import('../src/services/agentEvents.ts');

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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-pia-agente-'));
after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temporal */ } });
const root = path.join(base, 'Agente'); const w = (rel: string, t: string) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
w('AGENTS.md', '# Agente de pruebas\n\nConvierte PDF.\n');
w('skills/conv/SKILL.md', '---\nname: conv\ndescription: Convierte.\n---\n\n# Conv — versión 1.0.0\n\nUsa scripts/conv.py.\n');
w('skills/conv/scripts/conv.py', AGENT_SCRIPT);
w('documentos/LEEME.md', 'x');
const pv = (await inject('POST', `${W}/agents/external/preview`, { path: root })).json;
const imp = await inject('POST', `${W}/agents/external`, { path: root, hash: pv.hash, name: 'Conversor', role: 'Pruebas de primer intento', summary: '', department: 'Documentos', harness: 'claude-code', model: 'claude-sonnet-4-5', grants: { writeDocuments: true, runScripts: true, applyImprovements: true }, authorized: true });
const agentId = imp.json.id as string;
const A = `${W}/agents/${agentId}`;

const PLAN = { match: 'Reglas del plan', text: JSON.stringify({ script: 'skills/conv/scripts/conv.py', args: ['{entrada}', '{salida}'], reason: 'Mi habilidad.' }) };
const RETRY_PLAN = { match: 'REINTENTO', text: JSON.stringify({ script: 'skills/conv/scripts/conv.py', args: ['{entrada}', '{salida}', '--modo', 'corregido'], reason: 'Corrijo la estructura que hizo fallar la conversión.' }) };
const RULES = { auth: 'subscription', rules: [{ match: '"cifras"', text: 'Resumen del lote (simulado).' }, { match: 'aprobado_por_la_QA', text: 'Informe.' }, RETRY_PLAN, PLAN] };
const PROVEN = 'Primer intento con el plan que ya funcionó para este documento';

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
const ZIP = (markers: string[]) => zip(markers.map(m => ({ name: `${m.split(' ')[0]}.pdf`, data: PDF(m) })));
const docs = async () => (await inject('GET', `${A}/documents`)).json;
const batchOf = async (id: string) => (await docs()).batches.find((b: any) => b.id === id);
const jobOf = async (id: string) => (await docs()).jobs.find((j: any) => j.id === id);
const addsUp = (c: any) => D.batchCountsAddUp(c) && c.total === c.passed + c.rejectedQa + c.failed + c.excluded + c.cancelled + c.pending + c.queued + c.processing;
const settled = (b: any) => b && b.status === 'completed' && b.items.every((i: any) => i.state !== 'queued' && i.state !== 'processing');
const runBatch = async (name: string, data: Buffer) => {
  const up = await upload(`${A}/documents/upload`, name, data); assert.equal(up.status, 201, JSON.stringify(up.json));
  const id = up.json.batch.id as string;
  const r = await inject('POST', `${A}/batches/${id}/start`, { authorized: true }); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(await until(async () => settled(await batchOf(id))), JSON.stringify((await batchOf(id))?.counts));
  return batchOf(id);
};
const byMarker = async (b: any, m: string) => jobOf(b.items.find((i: any) => i.entryName.startsWith(m)).jobId);
const historyFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? historyFiles(path.join(dir, e.name)) : e.name === 'HISTORIAL.md' ? [fs.readFileSync(path.join(dir, e.name), 'utf8')] : []);

test('(a) caso del propietario: el mismo ZIP, ya resuelto con reintentos, se aprueba entero a la primera en un lote nuevo', async () => {
  const data = ZIP(['PA-1 FALLA', 'PA-2']);
  // Lote 1: PA-1 falla con el plan común, se reintenta y se aprueba con «corregido»; se aplica la propuesta.
  scenario(RULES);
  const b1 = await runBatch('Expedientes.zip', data);
  assert.equal(b1.counts.failed, 1, JSON.stringify(b1.counts));
  const rr = await inject('POST', `${A}/batches/${b1.id}/retry`, { authorized: true }); assert.equal(rr.status, 200, JSON.stringify(rr.json));
  assert.ok(await until(async () => settled(await batchOf(b1.id))));
  const j1 = await byMarker(await batchOf(b1.id), 'PA-1');
  assert.equal(j1.versions.length, 2); assert.equal(j1.versions[1].passed, true); assert.ok(j1.versions[1].plan.args.includes('corregido'));
  // HU-179: con applyImprovements, el reintento verificado se aplica solo (origin='retry'), sin propuesta pendiente.
  const learned = async () => (await docs()).proposals.find((p: any) => p.jobId === j1.id && p.origin === 'retry' && p.state === 'applied');
  assert.ok(await until(async () => !!(await learned())), JSON.stringify((await docs()).proposals));
  assert.ok(!(await docs()).proposals.some((p: any) => p.jobId === j1.id && p.state === 'proposed'), 'el reintento no deja propuestas pendientes');

  // Lote 2: mismo ZIP con otro nombre de archivo.
  scenario(RULES); const c0 = convRuns();
  const b2 = await runBatch('Expedientes (reenvío).zip', data);
  assert.equal(b2.counts.failed, 0, JSON.stringify(b2.counts)); assert.equal(b2.counts.passed, b2.counts.total); assert.equal(b2.counts.total, 2);
  assert.ok(addsUp(b2.counts), JSON.stringify(b2.counts));
  assert.equal(retryRuns().length, 0, 'ninguna llamada «REINTENTO» al planificador');
  assert.ok(lotPlanRuns().length <= 1, 'como mucho el plan común del lote');
  assert.equal(convRuns() - c0, 2, 'cada documento se convierte una sola vez');
  for (const it of b2.items) { const j = await jobOf(it.jobId); assert.equal(j.versions.length, 1, JSON.stringify(j.versions)); assert.equal(j.versions[0].passed, true); assert.notEqual(j.id, j1.id); }
  const k1 = await byMarker(b2, 'PA-1');
  assert.equal(k1.inputSha256, j1.inputSha256, 'mismo documento por SHA-256');
  assert.equal(planSignature(k1.versions[0].plan), planSignature(j1.versions[1].plan), 'v1 con el plan que pasó la QA en el lote anterior');
  assert.ok(String(k1.versions[0].report).startsWith(PROVEN), String(k1.versions[0].report));
  assert.ok(String(k1.versions[0].report).includes(j1.id));
  assert.ok(historyFiles(path.join(root, 'documentos')).some(h => h.includes(PROVEN)), 'anotado en HISTORIAL.md');
  const ev = agentEvents(S, agentId, 200).find((e: any) => (e.detail ?? {}).jobId === k1.id && (e.detail ?? {}).action === 'run') as any;
  assert.ok(ev, 'evento run del documento');
  assert.equal(ev.detail.provenFrom?.jobId, j1.id); assert.equal(ev.detail.provenFrom?.version, 2); assert.equal(ev.detail.provenFrom?.sha256, j1.inputSha256);
  const k2 = await byMarker(b2, 'PA-2');
  assert.ok(!String(k2.versions[0].report).startsWith(PROVEN) || planSignature(k2.versions[0].plan) === planSignature((await byMarker(b1, 'PA-2')).versions[0].plan));
  const lp = lotPlanRuns().map((c: any) => JSON.stringify(c)).join('\n');
  if (lotPlanRuns().length) assert.ok(lp.includes('reintento corregido'), 'el plan del lote recibe la memoria aplicada');
});

test('(b) si el plan probado ya no es válido (script inexistente o cambiado), se usa el plan del lote sin errores', async () => {
  const data = ZIP(['PB-1', 'PB-2']);
  scenario(RULES);
  const b3 = await runBatch('Lote PB.zip', data);
  assert.equal(b3.counts.passed, 2, JSON.stringify(b3.counts));
  const db = documentsDb(S) as any;
  const tamper = (jobId: string, fn: (v: any) => void) => {
    const row = db.prepare(`SELECT versions_json FROM document_jobs WHERE id = ?`).get(jobId);
    const vs = JSON.parse(row.versions_json); fn(vs[vs.length - 1]);
    db.prepare(`UPDATE document_jobs SET versions_json = ? WHERE id = ?`).run(JSON.stringify(vs), jobId);
  };
  const p1 = await byMarker(b3, 'PB-1'); const p2 = await byMarker(b3, 'PB-2');
  tamper(p1.id, v => { v.plan = { ...v.plan, script: 'skills/conv/scripts/borrado.py', args: ['{entrada}', '{salida}', '--modo', 'corregido'] }; });
  tamper(p2.id, v => { v.plan = { ...v.plan, args: ['{entrada}', '{salida}', '--modo', 'corregido'] }; v.scriptHash = 'huella-de-otra-revision'; });
  scenario(RULES); const c0 = convRuns();
  const b4 = await runBatch('Lote PB (otra vez).zip', data);
  assert.equal(b4.counts.failed, 0, JSON.stringify(b4.counts)); assert.equal(b4.counts.passed, 2); assert.ok(addsUp(b4.counts), JSON.stringify(b4.counts));
  assert.equal(retryRuns().length, 0); assert.equal(convRuns() - c0, 2);
  for (const m of ['PB-1', 'PB-2']) {
    const j = await byMarker(b4, m);
    assert.equal(j.versions.length, 1); assert.equal(j.versions[0].passed, true);
    assert.equal(planSignature(j.versions[0].plan), planSignature(b4.plan), `${m}: plan del lote`);
    assert.ok(!j.versions[0].plan.args.includes('corregido'), `${m}: no reutiliza un plan inválido`);
    assert.ok(!String(j.versions[0].report).startsWith(PROVEN));
    const ev = agentEvents(S, agentId, 200).find((e: any) => (e.detail ?? {}).jobId === j.id && (e.detail ?? {}).action === 'run') as any;
    assert.ok(ev && !ev.detail.provenFrom, `${m}: sin provenFrom`);
  }
});

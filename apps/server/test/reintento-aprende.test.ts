import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * HU-177 · Reintento que aprende (docs/agentes-externos.md). Sin modelo real ni Python real. Comprueba:
 *  (a) un documento suelto que falló en conversión se replanifica con el diagnóstico y crea UNA versión nueva;
 *  (b) en un lote, el que falló con el plan común NO repite ese plan: una versión nueva con otra firma; lo aprobado no se toca;
 *  (c) si el plan nuevo coincide con uno fallido: ninguna versión y el motivo «no encontró una corrección distinta»;
 *  (d) con el tope diario agotado: ni planificador ni convertidor, ninguna versión y el motivo nombra el tope;
 *  (e) si el planificador falla: ninguna versión ni conversión y el motivo dice «error del planificador» (suelto y lote);
 *  (f) la vista del lote y la respuesta del reintento marcan la intervención con su motivo y los conteos cuadran;
 *  (g) un reintento correcto en lote deja exactamente 2 versiones, la segunda con otro plan, 0 fallidos y su aprendizaje
 *      APLICADO solo (HU-179: autoApplied, origin='retry'), sin ninguna propuesta pendiente.
 *  (c), (d) y (e) tampoco crean propuestas: si el reintento no pasa, no se aprende nada.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-reint-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-reint-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = () => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];
/** Llamadas al planificador para un reintento (prompt «REINTENTO: …»). */
const retryRuns = () => ccRuns().filter((c: any) => String(c.prompt).includes('REINTENTO'));
/** Cualquier llamada al planificador (plan del lote o replanificación). */
const planRuns = () => ccRuns().filter((c: any) => /REINTENTO|Reglas del plan/.test(String(c.prompt)));

const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-reint-tools-'));
const CONV = path.join(tools, 'conversiones.log');
/** Veces que se ejecutó el script de conversión del agente (cada processVersionOnce que llega a convertir). */
const convRuns = () => fs.existsSync(CONV) ? fs.readFileSync(CONV, 'utf8').split('\n').filter(Boolean).length : 0;
fs.mkdirSync(path.join(tools, 'kits', 'pdf-word'), { recursive: true });
fs.writeFileSync(path.join(tools, 'pdf_info.py'), `const s=require('fs').readFileSync(process.argv[2]).toString('latin1');if(s.includes('CORRUPTO')){console.error('PDF dañado');process.exit(1)}console.log(JSON.stringify({encrypted:false,pages:1,text_pages:1,chars:120,sizes:[[612,792]],ocr_available:false}));`);
fs.writeFileSync(path.join(tools, 'check_python.py'), `console.log('ok')`);
fs.writeFileSync(path.join(tools, 'kits', 'pdf-word', 'convertir_editable.py'), '// kit simulado');
fs.writeFileSync(path.join(tools, 'doc_qa.py'), `const fs=require('fs'),path=require('path');const [inp,out,qa]=process.argv.slice(2);fs.mkdirSync(qa,{recursive:true});const gates={texto_editable:true,sin_paginas_como_imagen:true,mismas_paginas:true};
fs.writeFileSync(path.join(qa,'qa.json'),JSON.stringify({pdf_pages:1,rendered_pages:1,recall_docx_outside_figures:1,words_in_figures:0,figure_share:0,order_render:1,duplication:0,docx:{pictures:0,largest_picture_ratio:0,pictures_over_60pct:0,tables:1},pages:[{page:1,visual_diff:0.01,rendered_words:10}],gates,passed:true,schema_problems:[]}));fs.writeFileSync(path.join(qa,'comparacion-01.png'),'png');`);
// El script del agente anota cada ejecución y FALLA la conversión de un PDF «FALLA» salvo que el plan lleve la corrección.
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
const { documentsDb, planSignature, MODEL_CALLS_PER_DAY } = await import('../src/services/documentJobs.ts');

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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-reint-agente-'));
after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temporal */ } });
const root = path.join(base, 'Agente'); const w = (rel: string, t: string) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
w('AGENTS.md', '# Agente de pruebas\n\nConvierte PDF.\n');
w('skills/conv/SKILL.md', '---\nname: conv\ndescription: Convierte.\n---\n\n# Conv — versión 1.0.0\n\nUsa scripts/conv.py.\n');
w('skills/conv/scripts/conv.py', AGENT_SCRIPT);
w('documentos/LEEME.md', 'x');
const pv = (await inject('POST', `${W}/agents/external/preview`, { path: root })).json;
const imp = await inject('POST', `${W}/agents/external`, { path: root, hash: pv.hash, name: 'Conversor', role: 'Pruebas de reintento', summary: '', department: 'Documentos', harness: 'claude-code', model: 'claude-sonnet-4-5', grants: { writeDocuments: true, runScripts: true, applyImprovements: true }, authorized: true });
const agentId = imp.json.id as string;
const A = `${W}/agents/${agentId}`;

const PLAN_TEXT = JSON.stringify({ script: 'skills/conv/scripts/conv.py', args: ['{entrada}', '{salida}'], reason: 'Mi habilidad.' });
const PLAN = { match: 'Reglas del plan', text: PLAN_TEXT };
const RETRY_PLAN = { match: 'REINTENTO', text: JSON.stringify({ script: 'skills/conv/scripts/conv.py', args: ['{entrada}', '{salida}', '--modo', 'corregido'], reason: 'Corrijo la estructura que hizo fallar la conversión.' }) };
const SAME_PLAN = { match: 'REINTENTO', text: PLAN_TEXT };
const BAD_PLAN = { match: 'REINTENTO', text: 'esto no es un plan' };
const SUMMARY = { match: '"cifras"', text: 'Resumen del lote (simulado).' };
const REPORT = { match: 'aprobado_por_la_QA', text: 'Informe.' };
const RULES = { auth: 'subscription', rules: [SUMMARY, REPORT, RETRY_PLAN, PLAN] };
const SAME = { auth: 'subscription', rules: [SUMMARY, REPORT, SAME_PLAN, PLAN] };
const PLANNER_ERROR = { auth: 'subscription', rules: [SUMMARY, REPORT, BAD_PLAN, PLAN] };

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
const motive = (x: any) => String(x?.interventionReason ?? x?.error ?? '');
const propsOf = (d: any, jobId: string) => (d.proposals ?? []).filter((p: any) => p.jobId === jobId);
const addsUp = (c: any) => D.batchCountsAddUp(c) && c.total === c.passed + c.rejectedQa + c.failed + c.excluded + c.cancelled + c.pending + c.queued + c.processing;
const settled = (b: any) => b && b.status === 'completed' && b.items.every((i: any) => i.state !== 'queued' && i.state !== 'processing');

const newBatch = async (name: string, markers: string[]) => {
  const r = await upload(`${A}/documents/upload`, name, zip(markers.map(m => ({ name: `${m.split(' ')[0]}.pdf`, data: PDF(m) }))));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.batch;
};
const runBatch = async (id: string) => {
  const r = await inject('POST', `${A}/batches/${id}/start`, { authorized: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(await until(async () => settled(await batchOf(id))), JSON.stringify((await batchOf(id))?.counts));
  return batchOf(id);
};
const retryBatch = async (id: string, body: Record<string, unknown> = { authorized: true }) => {
  const r = await inject('POST', `${A}/batches/${id}/retry`, body);
  if (r.status === 200) assert.ok(await until(async () => settled(await batchOf(id))), JSON.stringify((await batchOf(id))?.items));
  return r;
};
const processJob = async (id: string) => {
  const r = await inject('POST', `${A}/documents/${id}/process`, { authorized: true });
  if (r.status === 202) assert.ok(await until(async () => { const j = await jobOf(id); return !!j && j.status !== 'processing' && j.status !== 'queued'; }), JSON.stringify(await jobOf(id)));
  return r;
};
/** Sube un PDF suelto y lo procesa una vez con el plan normal (sin «corregido»: un PDF «FALLA» falla en conversión). */
const failedLoose = async (marker: string) => {
  scenario(RULES);
  const up = await upload(`${A}/documents/upload`, `${marker.split(' ')[0]}.pdf`, PDF(marker));
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const id = up.json.jobs[0].id as string;
  const r = await processJob(id); assert.equal(r.status, 202, JSON.stringify(r.json));
  const j = await jobOf(id);
  assert.ok(j.versions.length >= 1 && j.versions.at(-1).passed === false, `falla en conversión: ${JSON.stringify(j.versions)}`);
  return j;
};
/** Lote con un PDF «FALLA» procesado con el plan común: queda fallido, con su versión fallida. */
const failedBatch = async (name: string, markers: string[]) => {
  scenario(RULES);
  const b = await runBatch((await newBatch(name, markers)).id);
  const it = b.items.find((i: any) => i.entryName.includes('FALLA') || i.state === 'failed');
  assert.equal(it.state, 'failed', JSON.stringify(b.items));
  assert.ok(b.plan?.script, 'el lote tiene su plan común');
  return { b, it, job: await jobOf(it.jobId) };
};

test('(a) suelto: un fallo de conversión se replanifica con el diagnóstico y crea UNA versión nueva', async () => {
  const j0 = await failedLoose('RA-A1 FALLA');
  scenario(RULES); const c0 = convRuns();
  const r = await processJob(j0.id); assert.equal(r.status, 202, JSON.stringify(r.json));
  const j = await jobOf(j0.id);
  assert.equal(j.versions.length, j0.versions.length + 1, 'exactamente una versión nueva por petición');
  const v = j.versions.at(-1);
  assert.equal(v.passed, true, JSON.stringify(v));
  assert.ok(v.plan.args.includes('corregido'), 'el agente replanificó');
  assert.match(String(v.feedback ?? ''), /Corrección del intento anterior/, 'recibió el diagnóstico del fallo anterior');
  assert.equal(retryRuns().length, 1, 'una sola replanificación'); assert.equal(planRuns().length, 1, 'ningún otro plan');
  assert.equal(convRuns() - c0, 1, 'una sola conversión');
  assert.ok(!j.needsIntervention, 'sin intervención');
});

test('(b) lote: el que falló con el plan común NO repite ese plan; una versión nueva con otra firma; lo aprobado no se toca', async () => {
  const { b, it, job } = await failedBatch('RA lote B.zip', ['RA-B1 FALLA', 'RA-B2']);
  const ok = b.items.find((i: any) => i.jobId !== it.jobId); assert.equal(ok.state, 'passed');
  const okBefore = (await jobOf(ok.jobId)).versions.length;
  const failedBefore = D ? job.versions.filter((v: any) => v.passed === false && v.plan?.script).map((v: any) => planSignature(v.plan)) : [];
  scenario(RULES); const c0 = convRuns();
  const r = await retryBatch(b.id); assert.equal(r.status, 200, JSON.stringify(r.json));
  const j = await jobOf(it.jobId);
  assert.equal(j.versions.length, job.versions.length + 1, 'exactamente una versión nueva');
  const sig = planSignature(j.versions.at(-1).plan);
  assert.notEqual(sig, planSignature(b.plan), 'no repite el plan del lote');
  assert.ok(!failedBefore.includes(sig), 'ni un plan fallido anterior');
  assert.equal(retryRuns().length, 1); assert.equal(planRuns().length, 1, 'el plan del lote no se vuelve a pedir ni a ejecutar');
  assert.equal(convRuns() - c0, 1, 'una sola conversión: el plan fallido no se ejecutó otra vez');
  assert.equal((await jobOf(ok.jobId)).versions.length, okBefore, 'lo aprobado no se repite');
  const done = await batchOf(b.id); assert.equal(done.counts.passed, 2); assert.equal(done.counts.failed, 0); assert.ok(addsUp(done.counts), JSON.stringify(done.counts));
});

let sameBatch = ''; let sameJob = '';
test('(c) si el plan nuevo coincide con uno fallido: ninguna versión, ninguna conversión y el motivo «no encontró una corrección distinta»', async () => {
  const { b, it, job } = await failedBatch('RA lote C.zip', ['RA-C1 FALLA']);
  scenario(SAME); const c0 = convRuns();
  const r = await retryBatch(b.id); assert.equal(r.status, 200, JSON.stringify(r.json));
  const j = await jobOf(it.jobId);
  assert.equal(j.versions.length, job.versions.length, 'no se crea versión');
  assert.equal(retryRuns().length, 1, 'una replanificación, sin una segunda'); assert.equal(convRuns() - c0, 0, 'el plan repetido no se ejecuta');
  assert.equal(j.needsIntervention, true); assert.ok(motive(j).includes(D.RETRY_REASON.same), motive(j));
  const x = await batchOf(b.id); const item = x.items.find((i: any) => i.jobId === it.jobId);
  assert.equal(item.state, 'failed'); assert.equal(item.needsIntervention, true); assert.ok(motive(item).includes(D.RETRY_REASON.same), motive(item));
  assert.equal(propsOf(await docs(), it.jobId).length, 0, 'un plan repetido no aprende nada');
  sameBatch = b.id; sameJob = it.jobId;
});

test('(d) tope diario agotado: ni planificador ni convertidor, ninguna versión y el motivo nombra el tope', async () => {
  const { b, it, job } = await failedBatch('RA lote D.zip', ['RA-D1 FALLA']);
  const loose = await failedLoose('RA-D2 FALLA');
  const db = documentsDb(S) as any; const at = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO document_model_calls (agent_id, at, what) VALUES (?, ?, 'prueba-tope')`);
  for (let i = 0; i < MODEL_CALLS_PER_DAY; i++) ins.run(agentId, at);
  try {
    scenario(RULES); const c0 = convRuns();
    const rb = await retryBatch(b.id);
    const rs = await processJob(loose.id);
    assert.equal(planRuns().length, 0, 'ninguna llamada al planificador'); assert.equal(convRuns() - c0, 0, 'ninguna conversión');
    const jb = await jobOf(it.jobId); assert.equal(jb.versions.length, job.versions.length, 'lote: ninguna versión');
    const js = await jobOf(loose.id); assert.equal(js.versions.length, loose.versions.length, 'suelto: ninguna versión');
    // O lo para la comprobación previa de la ruta (429, sin tocar nada) o el documento queda en intervención con el motivo.
    if (rb.status === 200) {
      const item = (await batchOf(b.id)).items.find((i: any) => i.jobId === it.jobId);
      assert.equal(item.state, 'failed'); assert.equal(item.needsIntervention, true); assert.match(motive(item), /tope diario/i);
      assert.equal(jb.needsIntervention, true); assert.ok(motive(jb).includes(D.RETRY_REASON.cap), motive(jb));
    } else { assert.equal(rb.status, 429, JSON.stringify(rb.json)); assert.match(String(rb.json?.error), /tope diario|consultas diarias/i); }
    if (rs.status === 202) { assert.equal(js.needsIntervention, true); assert.ok(motive(js).includes(D.RETRY_REASON.cap), motive(js)); }
    else { assert.equal(rs.status, 429, JSON.stringify(rs.json)); assert.match(String(rs.json?.error), /tope diario|consultas diarias/i); }
    assert.ok(addsUp((await batchOf(b.id)).counts));
    const d = await docs();
    assert.equal(propsOf(d, it.jobId).length + propsOf(d, loose.id).length, 0, 'con el tope agotado no se aprende nada');
  } finally { db.prepare(`DELETE FROM document_model_calls WHERE what = 'prueba-tope'`).run(); }
});

let errBatch = ''; let errJob = '';
test('(e) si el planificador falla: ninguna versión ni conversión y el motivo dice «error del planificador» (suelto y lote)', async () => {
  const { b, it, job } = await failedBatch('RA lote E.zip', ['RA-E1 FALLA']);
  const loose = await failedLoose('RA-E2 FALLA');
  scenario(PLANNER_ERROR); const c0 = convRuns();
  const rb = await retryBatch(b.id); assert.equal(rb.status, 200, JSON.stringify(rb.json));
  const rs = await processJob(loose.id); assert.equal(rs.status, 202, JSON.stringify(rs.json));
  assert.equal(retryRuns().length, 2, 'una replanificación por documento y ninguna llamada más'); assert.equal(planRuns().length, 2);
  assert.equal(convRuns() - c0, 0, 'sin plan no se convierte nada');
  const jb = await jobOf(it.jobId); const js = await jobOf(loose.id);
  assert.equal(jb.versions.length, job.versions.length, 'lote: ninguna versión'); assert.equal(js.versions.length, loose.versions.length, 'suelto: ninguna versión');
  for (const j of [jb, js]) { assert.equal(j.needsIntervention, true, JSON.stringify(j)); assert.ok(motive(j).includes(D.RETRY_REASON.planner), motive(j)); }
  const item = (await batchOf(b.id)).items.find((i: any) => i.jobId === it.jobId);
  assert.equal(item.state, 'failed'); assert.equal(item.needsIntervention, true); assert.ok(motive(item).includes(D.RETRY_REASON.planner), motive(item));
  const d = await docs();
  assert.equal(propsOf(d, it.jobId).length + propsOf(d, loose.id).length, 0, 'un error del planificador no aprende nada');
  errBatch = b.id; errJob = it.jobId;
});

test('(f) la vista del lote y la respuesta del reintento marcan la intervención con su motivo; los conteos cuadran', async () => {
  assert.ok(sameBatch && errBatch, 'depende de (c) y (e)');
  for (const [id, jobId, why] of [[sameBatch, sameJob, D.RETRY_REASON.same], [errBatch, errJob, D.RETRY_REASON.planner]] as const) {
    const x = await batchOf(id); const item = x.items.find((i: any) => i.jobId === jobId);
    assert.equal(item.needsIntervention, true); assert.ok(motive(item).includes(why), motive(item));
    assert.equal(item.state, 'failed', 'la intervención es una marca, no un estado más');
    assert.equal(x.counts.failed, 1); assert.equal(x.counts.total, x.counts.passed + x.counts.rejectedQa + x.counts.failed + x.counts.excluded);
    assert.ok(addsUp(x.counts), JSON.stringify(x.counts));
  }
  const before = (await jobOf(errJob)).versions.length;
  scenario(PLANNER_ERROR); const c0 = convRuns();
  const r = await inject('POST', `${A}/batches/${errBatch}/retry`, { authorized: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ri = (r.json.retried ?? []).find((i: any) => i.jobId === errJob);
  assert.ok(ri, `la respuesta trae el documento reintentado: ${JSON.stringify(r.json.retried)}`);
  assert.equal(typeof ri.idx, 'number'); assert.equal(ri.needsIntervention, true); assert.ok(String(ri.reason ?? '').includes(D.RETRY_REASON.planner), String(ri.reason));
  assert.ok(await until(async () => settled(await batchOf(errBatch))));
  const x = await batchOf(errBatch); const item = x.items.find((i: any) => i.jobId === errJob);
  assert.equal(item.needsIntervention, true); assert.ok(motive(item).includes(D.RETRY_REASON.planner));
  assert.equal((await jobOf(errJob)).versions.length, before, 'tampoco ahora se crea versión'); assert.equal(convRuns() - c0, 0);
  assert.ok(addsUp(x.counts), JSON.stringify(x.counts));
});

test('(g) un reintento correcto en lote: exactamente 2 versiones, la segunda con otro plan, 0 fallidos y su aprendizaje aplicado solo', async () => {
  const { b, it, job } = await failedBatch('RA lote G.zip', ['RA-G1 FALLA']);
  assert.equal(job.versions.length, 1, 'el fallo de conversión quedó como v1');
  scenario(RULES);
  const r = await retryBatch(b.id); assert.equal(r.status, 200, JSON.stringify(r.json));
  const j = await jobOf(it.jobId);
  assert.equal(j.versions.length, 2, JSON.stringify(j.versions.map((v: any) => [v.n, v.passed, v.plan?.args])));
  assert.equal(j.versions[0].passed, false); assert.equal(j.versions[1].passed, true);
  assert.notEqual(planSignature(j.versions[1].plan), planSignature(b.plan), 'la v2 no usa el plan del lote');
  assert.notEqual(planSignature(j.versions[1].plan), planSignature(j.versions[0].plan));
  assert.equal(retryRuns().length, 1);
  const x = await batchOf(b.id);
  assert.equal(x.counts.failed, 0); assert.equal(x.counts.passed, 1); assert.ok(addsUp(x.counts), JSON.stringify(x.counts));
  assert.ok(!x.items.find((i: any) => i.jobId === it.jobId).needsIntervention);
  const props = propsOf(await docs(), it.jobId);
  assert.equal(props.length, 1, 'un aprendizaje'); assert.equal(props[0].state, 'applied', JSON.stringify(props[0]));
  assert.equal(props[0].autoApplied, true); assert.equal(props[0].origin, 'retry');
  assert.equal((await docs()).proposals.filter((p: any) => p.state === 'proposed').length, 0, 'ninguna propuesta pendiente');
});

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportGrant } from '../src/services/agentCreation.ts';

/**
 * EN-007 · Paquete portable de un agente EXTERNO (y lecciones del papel de uno interno). Sin modelo real: Claude Code simulado
 * solo para poder importar el agente externo; exportar no llama a la IA. Comprueba:
 *  - los scripts de la habilidad salen del ZIP idénticos byte a byte (CRLF y no ASCII incluidos), sin scrub;
 *  - la memoria del agente (aprendida desde el chat y en reintentos verificados) viaja completa;
 *  - PLANES.json lista el plan aprobado por SHA-256 del PDF (script y argumentos) sin ids de trabajo, UUID ni rutas;
 *  - un secreto, una ruta local, un UUID o un archivo demasiado grande en un script niegan la exportación con el archivo;
 *  - toda ruta que citan GUIA.md y AGENTS.md existe en el ZIP; GUIA.md da requisitos y no promete resultados;
 *  - un agente interno lleva knowledge/lecciones-del-papel.md con las lecciones validadas de su papel;
 *  - el ZIP exportado se reimporta (HU-183) sin exponer el id, el modelo ni los permisos concedidos.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-exp-ext-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-exp-ext-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify({ auth: 'subscription', defaultText: 'ok' }));

const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { lessonsRepo } = await import('../src/services/lessons.ts');
const { listZip, readZipEntry } = await import('../src/services/zipFile.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { resetDetectionCache, verifiedDetection } = await import('../src/services/claudeCode/detect.ts');
const { provenPlansForExport } = await import('../src/services/documentJobs.ts');
const { applyZipImport, previewZipImport } = await import('../src/services/agentZipImport.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('clave-de-prueba'), 'clave…prueba');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const app = await buildApp();
saveClaudeCodeSettings({ ...getClaudeCodeSettings(), enabled: true, cliPath: FAKE, maxConcurrent: 1 }); resetDetectionCache();
await verifiedDetection(getClaudeCodeSettings(), 0);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-exp-ext-zip-'));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-exp-ext-agente-'));
after(async () => { await app.close(); for (const d of [tmp, base, fakeDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temporal */ } } });

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Construido al ejecutarse: escrito tal cual, el puente del Portal omitiría este archivo.
const SECRET = 'sk-' + 'ant-api03-' + 'Z9y8X7w6'.repeat(6);
const GRANT: ImportGrant = { department: 'Pruebas', scope: 'workspace', projectId: null, harness: 'api', model: 'claude-sonnet-4-5', provider: 'anthropic', effort: 'medium', tools: [], knowledge: [], autonomy: 'ask', authorized: true, capabilities: [] };

/** Entradas del ZIP como bytes (desde disco, como en producción). */
function unzipRaw(buf: Buffer, name: string): { file: string; bytes: Record<string, Buffer> } {
  const f = path.join(tmp, name); fs.writeFileSync(f, buf);
  const l = listZip(f, { maxEntries: 3000, maxEntryBytes: 8 * 1024 * 1024, maxRatio: 200 });
  const bytes: Record<string, Buffer> = {};
  for (const e of l.entries) { assert.equal(e.problem, null, `${e.name}: ${e.problem}`); bytes[e.name] = readZipEntry(f, e); }
  return { file: f, bytes };
}
const asText = (b: Record<string, Buffer>) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.toString('utf8')]));

// ---------------------------------------------------------------- Agente externo de ejemplo
const root = path.join(base, 'PDF Word Fiel');
const w = (rel: string, data: string | Buffer) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const SCRIPT = Buffer.from('# -*- coding: utf-8 -*-\r\n"""Conversión fiel: página, tabla y título ñandú."""\r\nimport sys\r\nimport subprocess\r\n\r\ndef main():\r\n    entrada, salida = sys.argv[1], sys.argv[2]\r\n    subprocess.run(["soffice", "--headless", "--convert-to", "docx", entrada])\r\n    print("listo →", salida)\r\n\r\nif __name__ == "__main__":\r\n    main()\r\n', 'utf8');
const REQS = Buffer.from('pdfplumber>=0.10\r\npython-docx==1.1.0\r\n', 'utf8');
w('AGENTS.md', '# PDF Word Fiel\n\nConvierto PDF a Word editable con la habilidad pdf.\n');
w('contexto/a.md', '# Contexto\n\nLos documentos llegan de la oficina de contratos.\n');
w('memoria/MEMORIA.md', '# Memoria\n\n## Aprendido desde el chat\n- MEM-CHAT: el propietario quiere conservar los encabezados como estilos de título.\n\n## Reintento verificado\n- MEM-REINTENTO: síntoma tablas partidas; causa modo rápido; resuelto con --modo fiel.\n');
w('skills/pdf/SKILL.md', '---\nname: pdf\ndescription: Convierte PDF a Word editable.\n---\n\n# PDF — versión 1.0.0\n\nUsa scripts/convertir.py. Comprueba que el texto sea editable y que no falten páginas.\n');
w('skills/pdf/scripts/convertir.py', SCRIPT);
w('skills/pdf/scripts/requirements.txt', REQS);

const pv = (await app.inject({ method: 'POST', url: `${W}/agents/external/preview`, payload: { path: root } })).json();
const imp = await app.inject({ method: 'POST', url: `${W}/agents/external`, payload: { path: root, hash: pv.hash, name: 'PDF Word Fiel', role: 'Conversión de documentos', summary: 'Convierte PDF a Word.', department: 'Documentos', harness: 'claude-code', model: 'claude-sonnet-4-5', grants: { writeDocuments: true, runScripts: true, applyImprovements: true }, authorized: true } });
assert.ok(imp.statusCode < 300, imp.body);
const extId = imp.json().id as string;

const PDF_SHA = crypto.createHash('sha256').update('pdf de ejemplo').digest('hex');
const JOB_ID = crypto.randomUUID();
const ARGS = ['{entrada}', '{salida}', '--modo', 'fiel'];

let ext: Record<string, string> = {}; let extBytes: Record<string, Buffer> = {}; let extZip = '';

test('registrar un trabajo de documento aprobado con su SHA-256', async () => {
  await app.inject({ method: 'GET', url: `${W}/agents/${extId}/documents` }); // crea las tablas de documentos
  provenPlansForExport(S, extId, {});
  const hash = crypto.createHash('sha256').update(SCRIPT.toString('utf8'), 'utf8').digest('hex');
  const at = new Date().toISOString();
  const version = { n: 1, docx: 'versiones/v1.docx', qaDir: '', passed: true, gates: { conversion_completada: true }, metrics: {}, plan: { script: 'skills/pdf/scripts/convertir.py', args: ARGS, reason: 'Tablas complejas: modo fiel.' }, scriptHash: hash, skillRevision: '1', report: `Listo en C:\\Users\\yair\\x.docx (${JOB_ID})`, reportBy: 'portal', at };
  workspaceDb(S).prepare(`INSERT INTO document_jobs (id, agent_id, title, slug, status, input_name, input_sha, pages, source, versions_json, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
    .run(JOB_ID, extId, 'Contrato', 'contrato', 'ready', 'contrato.pdf', PDF_SHA, 3, 'upload', JSON.stringify([version]), at, at);
  const plans = provenPlansForExport(S, extId, { 'skills/pdf/scripts/convertir.py': SCRIPT.toString('utf8') });
  assert.ok(plans.some(p => p.sha256 === PDF_SHA), JSON.stringify(plans));
});

test('externo: «Descargar paquete (ZIP)» entrega la revisión adoptada; scripts idénticos byte a byte', async () => {
  const r = await app.inject({ method: 'GET', url: `${W}/agents/${extId}/export.zip` });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(String(r.headers['content-type']), /application\/zip/);
  const u = unzipRaw(r.rawPayload, 'externo.zip'); extBytes = u.bytes; extZip = u.file; ext = asText(u.bytes);
  for (const f of ['AGENTS.md', 'agent.yaml', 'memory/MEMORY.md', 'contexto/a.md', 'memoria/MEMORIA.md', 'skills/pdf/SKILL.md', 'skills/pdf/scripts/convertir.py', 'skills/pdf/scripts/requirements.txt', 'PLANES.json', 'GUIA.md', 'AUTOMEJORA.md', 'CAMBIOS.md', 'scripts/anotar-cambio.mjs'])
    assert.ok(ext[f] !== undefined, `falta ${f} (hay: ${Object.keys(ext).join(', ')})`);
  assert.ok(extBytes['skills/pdf/scripts/convertir.py']!.equals(SCRIPT), 'convertir.py idéntico byte a byte (CRLF y no ASCII)');
  assert.ok(extBytes['skills/pdf/scripts/requirements.txt']!.equals(REQS), 'requirements.txt idéntico byte a byte');
  for (const p of Object.keys(ext)) assert.ok(!/^(bandeja-de-entrada|documentos|\.dependencias)\//.test(p), `no sale ${p}`);
});

test('memoria completa (chat y reintentos verificados) y PLANES.json limpio', () => {
  assert.match(ext['memoria/MEMORIA.md']!, /MEM-CHAT/); assert.match(ext['memoria/MEMORIA.md']!, /MEM-REINTENTO/);
  assert.match(ext['memory/MEMORY.md']!, /memoria\/MEMORIA\.md/, 'el índice remite a la memoria real');
  const raw = ext['PLANES.json']!; const j = JSON.parse(raw);
  assert.equal(j.schemaVersion, 1);
  const plan = j.planes.find((p: any) => p.sha256 === PDF_SHA);
  assert.ok(plan, raw); assert.equal(plan.script, 'skills/pdf/scripts/convertir.py'); assert.deepEqual(plan.args, ARGS); assert.equal(plan.skill, 'pdf');
  assert.ok(!raw.includes(JOB_ID) && !UUID_RE.test(raw), 'sin id de trabajo ni UUID');
  assert.ok(!/jobId|batchId|versiones\/|[A-Za-z]:\\|\/home\/|\/Users\//.test(raw), 'sin ids ni rutas');
});

test('sin id, modelo, permisos ni secretos en el paquete del externo', () => {
  const y = ext['agent.yaml']!;
  assert.ok(!/^id:/m.test(y) && !/^\s*model:/m.test(y) && !/^\s*tools:/m.test(y), y);
  for (const [p, c] of Object.entries(ext)) {
    assert.ok(!c.includes(extId), `${p}: id del agente`);
    assert.equal(D.findSecret(c), null, `${p}: secreto`);
    assert.ok(!c.includes(base) && !c.includes(root), `${p}: ruta local de la carpeta`);
  }
});

test('toda ruta citada en GUIA.md y AGENTS.md existe en el ZIP; flujo PDF y ZIP; requisitos sin promesas', () => {
  const names = Object.keys(ext);
  const g = ext['GUIA.md']!; const a = ext['AGENTS.md']!;
  for (const [doc, text] of [['GUIA.md', g], ['AGENTS.md', a]] as const) {
    const cited = [...text.matchAll(/(?:[\w-]+\/)*[\w-][\w.-]*\.(?:md|py|mjs)\b|PLANES\.json|(?:[\w-]+\/)*requirements[\w.-]*\.txt/g)].map(m => m[0]);
    for (const c of new Set(cited)) {
      const ok = names.includes(c) || names.some(n => n.endsWith(`/${c}`));
      assert.ok(ok, `${doc} cita ${c}, que no está en el ZIP`);
    }
  }
  assert.match(a.split('\n')[0]!, /AUTOMEJORA\.md/); assert.match(a, /GUIA\.md/); assert.match(a, /Convierto PDF a Word editable/);
  for (const re of [/SHA-256/, /PLANES\.json/, /ZIP/, /reintent/i, /AUTOMEJORA\.md/, /CAMBIOS\.md/, /skills\/pdf\/scripts\/convertir\.py/, /Python 3/, /skills\/pdf\/scripts\/requirements\.txt/, /soffice|LibreOffice/i, /no prometer/i, /sha256sum|Get-FileHash/])
    assert.match(g, re, `GUIA.md: ${re}`);
  assert.ok(!/HU-\d+/.test(g) && !UUID_RE.test(g), 'GUIA.md sin ids de historias ni UUID');
});

test('los scripts nunca se reescriben: secreto, ruta local, UUID o tamaño niegan la exportación con el archivo', () => {
  const snap = { 'AGENTS.md': '# X\n', 'skills/pdf/SKILL.md': '# pdf\n', 'skills/pdf/scripts/ok.py': 'print(1)\n' } as Record<string, string>;
  const opts = { agentName: 'X', exportedAt: new Date().toISOString(), provenPlans: [] };
  const cases: [string, string, RegExp][] = [
    ['skills/pdf/scripts/clave.py', `KEY = "${SECRET}"\n`, /parece/],
    ['skills/pdf/scripts/ruta.py', 'ENTRADA = "C:\\\\Users\\\\yair\\\\Documentos\\\\a.pdf"\n', /ruta local/],
    ['skills/pdf/scripts/id.py', `ID = "${JOB_ID}"\n`, /UUID/],
    ['skills/pdf/scripts/grande.txt', 'a'.repeat(D.EXTERNAL_TEXT_LIMIT + 1), /demasiado grande/]
  ];
  for (const [p, c, re] of cases) {
    const b = D.buildExternalBundle({ ...snap, [p]: c }, opts);
    assert.equal(b[p], c, `${p}: el script sale tal cual, sin scrub`);
    const problems = D.validatePortableBundle(b, { limits: D.EXTERNAL_BUNDLE_LIMITS });
    assert.ok(problems.some(x => x.path === p && re.test(x.message)), `${p}: ${JSON.stringify(problems)}`);
    assert.ok(!JSON.stringify(problems).includes(SECRET), 'el motivo no repite el secreto');
  }
  const clean = D.buildExternalBundle(snap, opts);
  assert.deepEqual(D.validatePortableBundle(clean, { limits: D.EXTERNAL_BUNDLE_LIMITS }), []);
  for (const p of Object.keys(clean)) assert.ok(D.allowedBundlePath(p), `ruta admitida: ${p}`);
  assert.ok(D.EXTERNAL_BUNDLE_LIMITS.fileBytes >= D.EXTERNAL_TEXT_LIMIT && D.EXTERNAL_BUNDLE_LIMITS.totalBytes >= D.EXTERNAL_TOTAL_LIMIT);
  assert.deepEqual(D.validatePortableBundle(ext, { forbidden: [extId], limits: D.EXTERNAL_BUNDLE_LIMITS }), [], 'el paquete real del externo pasa la validación');
});

test('interno: el paquete lleva las lecciones validadas de su papel', async () => {
  const r = await app.inject({ method: 'POST', url: `${W}/agents/wizard`, payload: {
    name: 'Desarrolladora Portable', role: 'Desarrollador Full Stack', summary: 'Implemento historias.', responsibilities: ['Implementar'], deliverables: ['Código'],
    department: 'Ingeniería', scope: 'workspace', projectId: null, harness: 'api', model: 'claude-sonnet-4-5', provider: 'anthropic', effort: 'medium',
    tools: [], knowledge: [], capabilities: [], autonomy: 'ask', instructions: '# Desarrolladora\n\nImplemento con pruebas.\n',
    skills: [{ name: 'Implementar', description: 'Implementa historias.', body: '# Implementar\n\n1. Lee la historia.\n' }], references: [], authorized: true
  } });
  assert.equal(r.statusCode, 201, r.body); const intId = r.json().id as string;
  const at = new Date().toISOString();
  const lesson = (status: string, title: string, text: string) => lessonsRepo(S).insert({ projectId: null, role: 'implementer', tags: [], status, version: 1, parentId: null, title, detector: 'import',
    evidence: { processId: null, processTitle: null, stepId: null, agentId: null, agentName: null, file: null, detail: 'prueba', at },
    rootCause: null, correctiveAction: null, lessonText: text, source: 'import', promotedTo: null, dedupeKey: null, agentId: null } as any);
  lesson('validated', 'Imports con extensión', 'LECCION-PAPEL: importa siempre con extensión .ts en ESM.');
  lesson('proposed', 'Sin validar', 'LECCION-NO-SALE: sin validar no viaja.');
  const z = await app.inject({ method: 'GET', url: `${W}/agents/${intId}/export.zip` });
  assert.equal(z.statusCode, 200, z.body);
  const files = asText(unzipRaw(z.rawPayload, 'interno.zip').bytes);
  for (const f of ['AGENTS.md', 'agent.yaml', 'skills/implementar/SKILL.md', 'memory/MEMORY.md', 'GUIA.md', 'AUTOMEJORA.md']) assert.ok(files[f] !== undefined, `falta ${f}`);
  const l = files['knowledge/lecciones-del-papel.md'];
  assert.ok(l, `faltan las lecciones del papel (hay: ${Object.keys(files).join(', ')})`);
  assert.match(l!, /LECCION-PAPEL/); assert.ok(!l!.includes('LECCION-NO-SALE'), 'solo lecciones validadas');
  assert.ok(Object.values(files).every(c => !c.includes(intId)), 'sin id del agente');
});

test('reimportar el ZIP exportado (HU-183) funciona y no expone id, modelo, permisos ni secretos', async () => {
  assert.ok(extZip, 'depende de la exportación del externo');
  const pvz = previewZipImport(S, extZip, 'pdf-word-fiel-paquete-portable.zip');
  assert.equal(pvz.ok, true, JSON.stringify(pvz));
  assert.equal(pvz.mode, 'nuevo');
  const r = await applyZipImport(S, { token: pvz.token, hash: pvz.hash, resolutions: {}, grant: GRANT }, () => () => { /* sin fila */ });
  assert.notEqual(r.agent.id, extId, 'id nuevo');
  const a = agentsRepo(S).get(r.agent.id)!;
  assert.equal(a.config.backend, 'api', 'arnés concedido por el propietario, no el del ZIP');
  assert.deepEqual(Object.keys(a.config.tools).filter(k => a.config.tools[k]), [], 'sin permisos heredados');
  const parsed = D.filesToDefinition(ext);
  assert.deepEqual(parsed.problems.filter(p => p.blocking), []);
  assert.equal(parsed.definition?.manifest.name, 'PDF Word Fiel');
  assert.equal((parsed.definition?.manifest as any)?.id ?? null, null, 'el ZIP no lleva id');
});

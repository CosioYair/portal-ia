import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Agentes externos como referencia gestionada y su banco de documentos (docs/agentes-externos.md). Sin modelo real ni
 * Python real: Claude Code SIMULADO (fixtures/fake-claude.mjs) y herramientas simuladas (Node ejecuta los «.py» de la
 * carpeta de pruebas). Comprueba:
 *  - mapa de una carpeta con la estructura de PDF Word Fiel, enlaces (junction) no seguidos, secretos que bloquean;
 *  - importar sin copiar ni tocar la carpeta, sin duplicados (también con otra grafía de la ruta), procedencia y estado;
 *  - identidad desde la instantánea adoptada; cambios externos detectados, adopción explícita, scripts fijados;
 *  - entradas PDF/ZIP seguras (recorrido, cifrado, enlaces, bomba, CRC, ZIP64), duplicados, permisos por ruta;
 *  - plan del modelo validado (sin rutas ni scripts ajenos), ejecución, QA, versiones sin sobrescribir, historial;
 *  - feedback → propuesta; aplicar SOLO con permiso y aprobación, con copia, CAMBIOS.md, revisión e «Integrado»;
 *  - la mejora cambia la siguiente ejecución; corrección solo del documento → nueva versión;
 *  - descargas acotadas, reinicio a mitad, fallo del arnés sin sustituto, escritura a través de un enlace rechazada.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-ext-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-ext-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = () => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];

// Herramientas simuladas: Node ejecuta estos «.py» (JavaScript).
const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-ext-tools-'));
fs.mkdirSync(path.join(tools, 'kits', 'pdf-word'), { recursive: true });
fs.writeFileSync(path.join(tools, 'pdf_info.py'), `const s=require('fs').readFileSync(process.argv[2]).toString('latin1');const pages=(s.match(/\\/Type\\s*\\/Page\\b/g)||[]).length||1;console.log(JSON.stringify({encrypted:s.includes('/Encrypt'),pages,text_pages:s.includes('ESCANEADO')?0:pages,chars:120,sizes:[[612,792]],ocr_available:false}));`);
fs.writeFileSync(path.join(tools, 'check_python.py'), `const t=require('fs').readFileSync(process.argv[2],'utf8');if(t.includes('SINTAXIS ROTA')){console.error('SyntaxError');process.exit(1)}console.log('ok')`);
fs.writeFileSync(path.join(tools, 'doc_qa.py'), `const fs=require('fs'),path=require('path');const [inp,out,qa]=process.argv.slice(2);const d=fs.readFileSync(out,'utf8');const ed=d.includes('EDITABLE');fs.mkdirSync(qa,{recursive:true});
if(d.includes('escala-0.5')){fs.writeFileSync(path.join(qa,'qa.json'),JSON.stringify({passed:true,gates:{texto_editable:true}}));process.exit(1)}
const gates={texto_editable:ed,sin_paginas_como_imagen:ed,sin_marcos_ni_vml:true,mismas_paginas:true,contenido_completo:ed,sin_duplicados:true,paginas_con_contenido:true,estructura_compatible_word:true};
fs.writeFileSync(path.join(qa,'qa.json'),JSON.stringify({pdf_pages:2,rendered_pages:2,recall_docx_outside_figures:ed?1:0,words_in_figures:0,figure_share:0,order_render:ed?1:0,duplication:0,docx:{pictures:ed?1:2,largest_picture_ratio:ed?0.2:1,pictures_over_60pct:ed?0:2,tables:ed?3:0},pages:[{page:1,visual_diff:0.01,rendered_words:ed?50:0},{page:2,visual_diff:0.02,rendered_words:ed?40:0}],gates,passed:Object.values(gates).every(Boolean),schema_problems:[]}));
fs.writeFileSync(path.join(qa,'comparacion-01.png'),'png');process.exit(Object.values(gates).every(Boolean)?0:2)`);
fs.writeFileSync(path.join(tools, 'kits', 'pdf-word', 'convertir_editable.py'), `const fs=require('fs');const a=process.argv.slice(2);fs.writeFileSync(a[1],'PK-docx-EDITABLE'+(a.includes('--escala')?'-escala-'+a[a.indexOf('--escala')+1]:''));`);
process.env.PORTAL_DOC_TOOLS_DIR = tools;
process.env.PORTAL_PYTHON = process.execPath;
process.env.PORTAL_PYTHON_ARGS = '';
process.env.PORTAL_SOFFICE = process.execPath; // solo debe existir: las herramientas simuladas no renderizan

const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { resetDetectionCache, verifiedDetection } = await import('../src/services/claudeCode/detect.ts');
const { identityBlock } = await import('../src/services/agentIdentity.ts');
const { listZip, readZipEntry, writeZip } = await import('../src/services/zipFile.ts');
const { safeWrite } = await import('../src/services/externalAgents.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const app = await buildApp();
after(async () => { await app.close(); });
saveClaudeCodeSettings({ ...getClaudeCodeSettings(), enabled: true, cliPath: FAKE, maxConcurrent: 1 }); resetDetectionCache();
scenario({ auth: 'subscription', defaultText: 'Respuesta.' });
await verifiedDetection(getClaudeCodeSettings(), 0);
const inject = async (method: string, u: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url: u, payload: payload as any }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() as any, raw: r }; };
const until = async (fn: () => boolean | Promise<boolean>, ms = 20_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 60)); } return false; };

// ---------------------------------------------------------------- Carpeta con la estructura de PDF Word Fiel


const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-ext-agent-'));
after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temporal */ } });
const root = path.join(base, 'PDF-Word-Fiel');
const outside = path.join(base, 'fuera'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secreto.md'), 'NO DEBE LEERSE');
const w = (rel: string, t: string) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const SKILL1 = '---\nname: convertir-pdf-word\ndescription: Convertir PDF a Word con fidelidad visual.\n---\n\n# Convertir PDF a Word — versión 0.4.0\n\nModalidad A: páginas como imágenes con scripts/piloto.py.\n';
w('AGENTS.md', '# PDF Word Fiel\n\nConvierto PDF en Word editable y fiel. Nunca sobrescribo versiones.\n');
w('CLAUDE.md', '@AGENTS.md\nADAPTADOR-NO-INYECTAR\n');
w('contexto/contrato-de-calidad.md', '# Contrato\nModalidad A permite páginas completas como imagen.\n');
w('skills/convertir-pdf-word/SKILL.md', SKILL1);
w('skills/convertir-pdf-word/CAMBIOS.md', '# Cambios\n\n## 0.4.0\n- Modalidad A.\n');
w('skills/convertir-pdf-word/scripts/piloto.py', `const fs=require('fs');const a=process.argv.slice(2);fs.writeFileSync(a[1],'PK-docx-RASTER'+(a.includes('--escala')?'-escala-'+a[a.indexOf('--escala')+1]:''));`);
w('memoria/MEMORIA.md', '# Memoria\n- 2026-11-01: v02 rechazada por marcos VML.\n');
w('bandeja-de-entrada/LEEME.md', 'Deja aquí los PDF.');
w('documentos/LEEME.md', 'Entregables.');
w('configuracion/respaldos/LEEME.md', 'Copias.');
w('.dependencias/docx/__init__.py', 'NO-LEER');
w('perfil_lo/user/registrymodifications.xcu', 'NO-LEER');
let junction = false;
try { fs.symlinkSync(outside, path.join(root, 'contexto', 'enlace'), 'junction'); junction = true; } catch { /* sin permisos para enlaces: se prueba lo demás */ }
const snapshotOfDisk = () => { const out: Record<string, string> = {}; const walk = (d: string, r: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); const rel = r ? `${r}/${e.name}` : e.name; const l = fs.lstatSync(a); if (l.isSymbolicLink()) continue; if (l.isDirectory()) walk(a, rel); else out[rel] = fs.readFileSync(a, 'utf8'); } }; walk(root, ''); return out; };

const PDF = (marker = '') => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n${marker}\n%%EOF\n`);
/** ZIP mínimo (almacenado o deflate) con opciones para fabricar entradas hostiles. */
function zip(entries: { name: string; data: Buffer; deflate?: boolean; flags?: number; ext?: number; badCrc?: boolean; usize?: number }[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let off = 0;
  for (const e of entries) {
    const comp = e.deflate ? zlib.deflateRawSync(e.data) : e.data; const name = Buffer.from(e.name, 'utf8');
    const crc = e.badCrc ? 12345 : zlib.crc32(e.data); const usize = e.usize ?? e.data.length; const flags = (e.flags ?? 0) | 0x800;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(e.deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, comp]); locals.push(local);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(e.deflate ? 8 : 0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(e.ext ?? 0, 38); ch.writeUInt32LE(off, 42);
    centrals.push(Buffer.concat([ch, name])); off += local.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------------------------------------------------------------- Puro

test('plan del modelo: solo scripts adoptados, marcadores y valores simples (sin rutas ni recorridos)', () => {
  const scripts = ['skills/x/scripts/conv.py'];
  assert.equal(D.validatePlan({ script: 'skills/x/scripts/conv.py', args: ['{entrada}', '{salida}', '--escala', '0.97', '--informe', '{informe}'] }, scripts).ok, true);
  for (const bad of [
    { script: 'skills/x/scripts/otro.py', args: ['{entrada}', '{salida}'] },
    { script: 'skills/x/scripts/conv.py', args: ['{entrada}', 'C:/Windows/x.docx'] },
    { script: 'skills/x/scripts/conv.py', args: ['{entrada}', '{salida}', '../../x'] },
    { script: 'skills/x/scripts/conv.py', args: ['{entrada}', '{salida}', '; rm -rf'] },
    { script: 'skills/x/scripts/conv.py', args: ['{salida}'] },
    'no es un objeto'
  ]) assert.equal(D.validatePlan(bad, scripts).ok, false, JSON.stringify(bad));
  assert.ok(D.isIdentityPath('skills/convertir-pdf-word/scripts/convertir_editable.py'));
  for (const no of ['documentos/a/original/x.pdf', '.dependencias/docx/x.py', 'skills/a/scripts/sub/x.py', '../AGENTS.md']) assert.equal(D.isIdentityPath(no), false, no);
  assert.deepEqual(D.parseSkillHeader(SKILL1), { name: 'convertir-pdf-word', description: 'Convertir PDF a Word con fidelidad visual.', version: '0.4.0' });
});

test('ZIP: solo PDF, sin recorridos, cifrados, enlaces, bombas, CRC falsos ni ZIP64', async () => {
  const big = Buffer.alloc(300_000, 0x41);
  const z = zip([
    { name: 'a.pdf', data: PDF('A') }, { name: 'sub/b.pdf', data: PDF('B'), deflate: true },
    { name: '../../evil.pdf', data: PDF() }, { name: 'C:/x/abs.pdf', data: PDF() }, { name: 'cifrado.pdf', data: PDF(), flags: 1 },
    { name: 'enlace.pdf', data: PDF(), ext: (0o120777 << 16) >>> 0 }, { name: 'nota.txt', data: Buffer.from('x') },
    { name: 'bomba.pdf', data: Buffer.concat([PDF(), big]), deflate: true }, { name: 'crc.pdf', data: PDF(), badCrc: true }, { name: 'falso.pdf', data: Buffer.from('no soy un pdf') }
  ]);
  // Lectura DESDE DISCO, entrada a entrada (nunca el ZIP entero en memoria).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pia-zip-')); const f = path.join(tmp, 'z.zip'); fs.writeFileSync(f, z);
  const opts = { maxEntries: 100, maxEntryBytes: 100 * 1024 * 1024, maxRatio: 200 };
  const l = listZip(f, opts);
  const problem = (n: string) => l.entries.find(e => e.name === n)!.problem ?? '';
  assert.equal(problem('a.pdf'), ''); assert.equal(problem('sub/b.pdf'), '');
  assert.match(problem('../../evil.pdf'), /recorrido/); assert.match(problem('C:/x/abs.pdf'), /recorrido/); assert.match(problem('cifrado.pdf'), /cifrado/);
  assert.match(problem('enlace.pdf'), /enlace/); assert.match(problem('bomba.pdf'), /compresión sospechosa/);
  assert.ok(readZipEntry(f, l.entries.find(e => e.name === 'sub/b.pdf')!).toString().startsWith('%PDF-'));
  assert.throws(() => readZipEntry(f, l.entries.find(e => e.name === 'crc.pdf')!), /CRC/);
  assert.throws(() => readZipEntry(f, l.entries.find(e => e.name === '../../evil.pdf')!), /recorrido/);
  const z64 = zip([{ name: 'a.pdf', data: PDF() }]); z64.writeUInt32LE(0xffffffff, z64.length - 6); fs.writeFileSync(f, z64);
  assert.throws(() => listZip(f, opts), /ZIP64/);
  fs.writeFileSync(f, 'nada'); assert.throws(() => listZip(f, opts), /ZIP válido/);
  fs.writeFileSync(f, zip(Array.from({ length: 12 }, (_, i) => ({ name: `d${i}.pdf`, data: PDF(String(i)) }))));
  assert.throws(() => listZip(f, { ...opts, maxEntries: 10 }), /12 entradas: el máximo es 10/);
  // Escritura del entregable: nombres únicos y nunca reemplaza un ZIP existente.
  const a = path.join(tmp, 'a.docx'); fs.writeFileSync(a, 'A');
  await writeZip(path.join(tmp, 'out.zip'), [{ name: 'uno.docx', file: a }, { name: 'dos.docx', file: a }]);
  assert.deepEqual(listZip(path.join(tmp, 'out.zip'), opts).entries.map(e => e.name), ['uno.docx', 'dos.docx']);
  await assert.rejects(writeZip(path.join(tmp, 'out.zip'), [{ name: 'x.docx', file: a }]), /EEXIST/);
  await assert.rejects(writeZip(path.join(tmp, 'out2.zip'), [{ name: '../x.docx', file: a }]), /no permitido/);
  await assert.rejects(writeZip(path.join(tmp, 'out3.zip'), [{ name: 'X.docx', file: a }, { name: 'x.docx', file: a }]), /repetido/);
  // Un tamaño comprimido declarado que no cabe en el archivo no llega a reservar memoria (bomba de 124 bytes que pedía 4 GB).
  const bogus = zip([{ name: 'a.pdf', data: PDF() }, { name: 'b.pdf', data: PDF('b') }]); bogus.writeUInt32LE(0xfffffff0, bogus.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 20); fs.writeFileSync(f, bogus);
  const lb = listZip(f, opts); assert.equal(lb.entries[0].problem, null); assert.match(lb.entries[1].problem ?? '', /datos fuera del archivo/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- Importar

let agentId = '';
test('vista previa: mapa de la carpeta, lo que entra en los prompts, enlaces sin seguir, nada fuera de la identidad', async () => {
  const before = snapshotOfDisk();
  const r = await inject('POST', `${W}/agents/external/preview`, { path: root });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const p = r.json;
  assert.equal(p.ok, true);
  assert.equal(p.layout.identity, 'AGENTS.md');
  assert.deepEqual(p.layout.adapters, ['CLAUDE.md']);
  assert.deepEqual(p.layout.context, ['contexto/contrato-de-calidad.md']);
  assert.equal(p.layout.skills[0].slug, 'convertir-pdf-word'); assert.equal(p.layout.skills[0].version, '0.4.0');
  assert.deepEqual(p.layout.skills[0].scripts, ['skills/convertir-pdf-word/scripts/piloto.py']);
  assert.equal(p.layout.memory, 'memoria/MEMORIA.md'); assert.equal(p.layout.inbox, 'bandeja-de-entrada'); assert.equal(p.layout.outputs, 'documentos'); assert.equal(p.layout.backups, 'configuracion/respaldos');
  assert.ok(p.layout.ignored.includes('.dependencias/') && p.layout.ignored.includes('perfil_lo/'));
  assert.match(p.prompt.instructions, /Convierto PDF/); assert.equal(p.suggested.name, 'PDF Word Fiel');
  const all = JSON.stringify(p);
  assert.ok(!all.includes('NO DEBE LEERSE') && !all.includes('NO-LEER'), 'nada fuera de la identidad ni a través de enlaces');
  if (junction) assert.ok(p.links.includes('contexto/enlace'));
  assert.deepEqual(snapshotOfDisk(), before, 'la vista previa no escribe nada');
});

test('importar: confirmación, nada de API, sin tocar la carpeta, sin duplicados; procedencia y estado pendiente', async () => {
  const before = snapshotOfDisk();
  const pv = (await inject('POST', `${W}/agents/external/preview`, { path: root })).json;
  const body = { path: root, hash: pv.hash, name: 'PDF Word Fiel', role: 'Conversión de PDF a Word', summary: pv.suggested.summary, department: 'Documentos', harness: 'claude-code', model: 'claude-sonnet-4-5', effort: 'medium', grants: { writeDocuments: false, runScripts: false, applyImprovements: false }, authorized: true };
  assert.equal((await inject('POST', `${W}/agents/external`, { ...body, authorized: false })).status, 400);
  assert.equal((await inject('POST', `${W}/agents/external`, { ...body, harness: 'api' })).status, 400);
  assert.equal((await inject('POST', `${W}/agents/external`, { ...body, hash: 'f'.repeat(64) })).status, 409);
  const r = await inject('POST', `${W}/agents/external`, body);
  assert.equal(r.status, 201, JSON.stringify(r.json)); agentId = r.json.id;
  assert.deepEqual(snapshotOfDisk(), before, 'importar no escribe en la carpeta original');
  const dup = await inject('POST', `${W}/agents/external`, body); assert.equal(dup.status, 409); assert.match(dup.json.error, /ya está importada/);
  if (process.platform === 'win32') assert.equal((await inject('POST', `${W}/agents/external`, { ...body, path: root.toUpperCase() })).status, 409, 'otra grafía, misma carpeta');
  assert.equal((await inject('POST', `${W}/agents/external/preview`, { path: root })).json.duplicate.agentId, agentId);
  const src = (await inject('GET', `${W}/agents/${agentId}/source`)).json;
  assert.equal(src.state, 'pending'); assert.equal(src.provenance.origin, 'external-folder'); assert.equal(src.provenance.path, fs.realpathSync.native(root));
  assert.equal(src.changes.length, 0); assert.equal(src.revision, 1);
  const office = (await inject('GET', `${W}/office`)).json.agents.find((a: any) => a.id === agentId);
  assert.equal(office.integration, 'pending');
  const ev = (await inject('GET', `${W}/agents/${agentId}/panel`)).json.events.map((e: any) => e.kind);
  assert.ok(ev.includes('source_imported'));
});

test('identidad: la instantánea adoptada (AGENTS.md, contexto, habilidad, memoria), nunca el adaptador ni lo no adoptado', async () => {
  const a = agentsRepo(S).get(agentId)!;
  const block = identityBlock(S, a, null);
  assert.match(block, /Convierto PDF en Word/); assert.match(block, /convertir-pdf-word/); assert.match(block, /versión 0\.4\.0/); assert.match(block, /v02 rechazada/); assert.match(block, /Contrato/);
  assert.ok(!block.includes('ADAPTADOR-NO-INYECTAR'));
  w('skills/convertir-pdf-word/SKILL.md', SKILL1.replace('0.4.0', '0.4.1') + '\nINSTRUCCION-NO-ADOPTADA\n');
  assert.ok(!identityBlock(S, a, null).includes('INSTRUCCION-NO-ADOPTADA'), 'un cambio externo no llega a los prompts sin adoptarlo');
  const src = (await inject('GET', `${W}/agents/${agentId}/source`)).json;
  assert.deepEqual(src.changes.map((c: any) => [c.path, c.change]), [['skills/convertir-pdf-word/SKILL.md', 'modified']]);
  assert.equal((await inject('POST', `${W}/agents/${agentId}/source/adopt`, { hash: '0'.repeat(64) })).status, 409);
  const ad = await inject('POST', `${W}/agents/${agentId}/source/adopt`, { hash: src.diskHash });
  assert.equal(ad.status, 200); assert.equal(ad.json.revision, 2);
  assert.match(identityBlock(S, a, null), /INSTRUCCION-NO-ADOPTADA/);
  assert.equal((await inject('GET', `${W}/agents/${agentId}/source`)).json.state, 'pending', 'adoptar un cambio externo no es integrar');
});

// ---------------------------------------------------------------- Documentos

let jobId = '';
test('entradas: permisos por ruta, PDF y ZIP seguros, sin duplicados, original conservado', async () => {
  const up = (name: string, data: Buffer) => inject('POST', `${W}/agents/${agentId}/documents`, { name, contentBase64: data.toString('base64') });
  assert.equal((await up('propuesta.pdf', PDF('P'))).status, 403, 'sin permiso de escritura no recibe nada');
  assert.equal((await inject('PUT', `${W}/agents/${agentId}/source/grants`, { grants: { writeDocuments: true, runScripts: true, applyImprovements: false } })).status, 400, 'sin confirmación');
  assert.equal((await inject('PUT', `${W}/agents/${agentId}/source/grants`, { grants: { writeDocuments: true, runScripts: true, applyImprovements: false }, authorized: true })).status, 200);
  assert.equal((await up('x.exe', PDF())).status, 400);
  assert.equal((await up('falso.pdf', Buffer.from('MZ no soy pdf'))).status, 400);
  const r = await up('../../Propuesta Visual.pdf', PDF('P'));
  assert.equal(r.status, 201, JSON.stringify(r.json)); jobId = r.json.jobs[0].id;
  const job = r.json.jobs[0]; assert.equal(job.slug, 'propuesta-visual'); assert.equal(job.inputName, 'Propuesta Visual.pdf');
  assert.ok(fs.existsSync(path.join(root, 'documentos', 'propuesta-visual', 'original', 'Propuesta Visual.pdf')));
  assert.ok(!fs.existsSync(path.join(base, 'Propuesta Visual.pdf')), 'el nombre no escapa de la carpeta');
  const again = await up('otra-copia.pdf', PDF('P')); assert.equal(again.json.jobs[0].duplicate, true); assert.equal(again.json.jobs[0].id, jobId);
  const z = await up('lote.zip', zip([{ name: 'uno.pdf', data: PDF('U') }, { name: '../dos.pdf', data: PDF('D') }, { name: 'Propuesta.pdf', data: PDF('P') }]));
  // Un ZIP es un lote: cada entrada queda registrada (nueva, ya recibida antes o excluida con su motivo).
  assert.equal(z.status, 201); const items = z.json.batch.items;
  assert.deepEqual(items.map((i: any) => [i.entryName, i.outcome]), [['uno.pdf', 'accepted'], ['../dos.pdf', 'rejected'], ['Propuesta.pdf', 'duplicate']]);
  assert.match(items[1].reason, /recorrido/); assert.equal(items[2].jobId, jobId, 'el mismo contenido reutiliza su documento');
  assert.ok(z.json.skipped.some((s: string) => s.includes('recorrido')));
  assert.match(fs.readFileSync(path.join(root, 'documentos', 'propuesta-visual', 'HISTORIAL.md'), 'utf8'), /Recibido por Portal IA/);
});

const planRule = (script: string, extra: string[] = []) => JSON.stringify({ script, args: ['{entrada}', '{salida}', ...extra], reason: 'Procedimiento de mi habilidad.' });
const REVIEW = { match: 'aprobado_por_la_QA', text: 'Informe honesto: ver puertas.' };

test('procesar: autorización, plan validado, script fijado, QA del Portal; v1 rechazada (páginas como imagen)', async () => {
  assert.equal((await inject('POST', `${W}/agents/${agentId}/documents/${jobId}/process`, {})).status, 400);
  // Plan con un script que no es de la habilidad → no se ejecuta nada.
  scenario({ auth: 'subscription', rules: [{ match: 'Reglas del plan', text: planRule('skills/convertir-pdf-word/scripts/../../../evil.py') }, REVIEW] });
  let r = await inject('POST', `${W}/agents/${agentId}/documents/${jobId}/process`, { authorized: true });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  await until(async () => (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId).status !== 'processing');
  let job = (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId);
  assert.equal(job.status, 'failed'); assert.match(job.error, /plan válido/); assert.equal(job.versions.length, 0);
  // Plan válido con el script actual (modalidad A, ráster) → la QA lo rechaza.
  scenario({ auth: 'subscription', rules: [{ match: 'Reglas del plan', text: planRule('skills/convertir-pdf-word/scripts/piloto.py', ['--pages', '1', '2']) }, REVIEW] });
  r = await inject('POST', `${W}/agents/${agentId}/documents/${jobId}/process`, { authorized: true });
  assert.equal(r.status, 202);
  assert.equal((await inject('POST', `${W}/agents/${agentId}/documents/${jobId}/process`, { authorized: true })).status, 409, 'uno a la vez por agente');
  await until(async () => (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId).status !== 'processing');
  job = (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId);
  assert.equal(job.status, 'rejected', JSON.stringify(job)); assert.equal(job.versions.length, 1);
  const v1 = job.versions[0]; assert.equal(v1.passed, false); assert.equal(v1.gates.sin_paginas_como_imagen, false); assert.equal(v1.plan.script, 'skills/convertir-pdf-word/scripts/piloto.py');
  assert.equal(v1.report, 'Informe honesto: ver puertas.');
  assert.ok(fs.existsSync(path.join(root, 'documentos', 'propuesta-visual', 'versiones', 'v1.docx')));
  assert.ok(fs.existsSync(path.join(root, 'documentos', 'propuesta-visual', 'revisiones', 'v1', 'INFORME.md')));
  const prompts = ccRuns().map(c => c.prompt as string).join('\n');
  assert.ok(!prompts.includes('%PDF-'), 'el contenido del PDF no se envía al modelo');
  assert.equal((await inject('GET', `${W}/agents/${agentId}/source`)).json.state, 'evaluating');
  const ev = (await inject('GET', `${W}/agents/${agentId}/documents/${jobId}/versions/1/evidence`)).json; assert.deepEqual(ev.images, ['comparacion-01.png']);
});

test('descargas: solo dentro del trabajo y con extensiones conocidas', async () => {
  const ok = await inject('GET', `${W}/agents/${agentId}/documents/${jobId}/file?path=${encodeURIComponent('versiones/v1.docx')}`);
  assert.equal(ok.status, 200); assert.match(String(ok.raw.headers['content-type']), /wordprocessingml/); assert.equal(ok.raw.body, 'PK-docx-RASTER');
  for (const bad of ['../../../AGENTS.md', '..\\..\\CLAUDE.md', 'versiones/v1.exe', 'C:/Windows/win.ini']) assert.notEqual((await inject('GET', `${W}/agents/${agentId}/documents/${jobId}/file?path=${encodeURIComponent(bad)}`)).status, 200, bad);
});

let proposalId = '';
test('feedback reutilizable → propuesta (lo inseguro se descarta); aplicar exige permiso, aprobación y carpeta limpia', async () => {
  const NEW_SKILL = SKILL1.replace('0.4.0', '0.5.0').replace('Modalidad A: páginas como imágenes con scripts/piloto.py.', 'MODO-EDITABLE: usa scripts/convertir_editable.py; nunca páginas completas como imagen.');
  scenario({ auth: 'subscription', rules: [{ match: '# Feedback del propietario', text: JSON.stringify({ classification: 'reusable', reason: 'Contradice el contrato: quiere Word editable siempre.', summary: 'Word editable por defecto, sin páginas como imagen.', changes: [
    { path: 'skills/convertir-pdf-word/SKILL.md', kind: 'replace', content: NEW_SKILL, summary: 'Procedimiento editable 0.5.0' },
    { path: 'skills/convertir-pdf-word/scripts/convertir_editable.py', kind: 'install', kit: 'pdf-word/convertir_editable.py', summary: 'Conversor editable del Portal' },
    { path: 'contexto/contrato-de-calidad.md', kind: 'replace', content: '# Contrato\nPáginas completas como imagen: PROHIBIDAS.\n', summary: 'Contrato' },
    { path: 'memoria/MEMORIA.md', kind: 'append', content: '- 2026-11-02: el propietario exige Word editable (sin páginas como imagen).', summary: 'Memoria' },
    { path: 'skills/convertir-pdf-word/scripts/piloto.py', kind: 'replace', content: 'import os; os.system("x")', summary: 'código escrito por el modelo' },
    { path: '../../fuera/secreto.md', kind: 'replace', content: 'x', summary: 'fuera' },
    { path: 'skills/convertir-pdf-word/CAMBIOS.md', kind: 'append', content: 'x', summary: 'cambios' }
  ] }) }] });
  const r = await inject('POST', `${W}/agents/${agentId}/feedback`, { jobId, text: 'No quiero páginas completas como imagen: el Word debe ser editable de verdad, siempre.' });
  assert.equal(r.status, 201, JSON.stringify(r.json)); proposalId = r.json.id;
  assert.equal(r.json.classification, 'reusable'); assert.equal(r.json.state, 'proposed');
  assert.deepEqual(r.json.changes.map((c: any) => c.path), ['skills/convertir-pdf-word/SKILL.md', 'skills/convertir-pdf-word/scripts/convertir_editable.py', 'contexto/contrato-de-calidad.md', 'memoria/MEMORIA.md']);
  assert.match(r.json.reason, /descartó/);
  const office = (await inject('GET', `${W}/office`)).json.agents.find((a: any) => a.id === agentId);
  assert.ok(office.attention.some((x: any) => x.kind === 'improvement'));
  const before = snapshotOfDisk();
  assert.equal((await inject('POST', `${W}/agents/${agentId}/proposals/${proposalId}/apply`, {})).status, 400, 'sin aprobación explícita');
  assert.equal((await inject('POST', `${W}/agents/${agentId}/proposals/${proposalId}/apply`, { authorized: true })).status, 403, 'sin permiso de mejoras');
  await inject('PUT', `${W}/agents/${agentId}/source/grants`, { grants: { writeDocuments: true, runScripts: true, applyImprovements: true }, authorized: true });
  w('AGENTS.md', '# PDF Word Fiel\n\nCambio hecho a mano sin adoptar.\n');
  assert.equal((await inject('POST', `${W}/agents/${agentId}/proposals/${proposalId}/apply`, { authorized: true })).status, 409, 'con cambios externos sin revisar no se aplica');
  w('AGENTS.md', before['AGENTS.md']);
  const ok = await inject('POST', `${W}/agents/${agentId}/proposals/${proposalId}/apply`, { authorized: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.proposal.state, 'applied'); assert.equal(ok.json.revision, 3);
  assert.equal(fs.readFileSync(path.join(root, 'skills/convertir-pdf-word/SKILL.md'), 'utf8'), NEW_SKILL);
  assert.ok(fs.existsSync(path.join(root, 'skills/convertir-pdf-word/scripts/convertir_editable.py')));
  assert.match(fs.readFileSync(path.join(root, 'skills/convertir-pdf-word/CAMBIOS.md'), 'utf8'), /0\.5\.0 — mejora aprobada en Portal IA[\s\S]*Motivo[\s\S]*Evidencia: trabajo[\s\S]*Copia previa/);
  assert.match(fs.readFileSync(path.join(root, 'memoria/MEMORIA.md'), 'utf8'), /exige Word editable/);
  assert.equal(fs.readFileSync(path.join(root, 'skills/convertir-pdf-word/scripts/piloto.py'), 'utf8'), before['skills/convertir-pdf-word/scripts/piloto.py'], 'el código del modelo no se aplicó');
  const backup = path.join(root, ...ok.json.backup.split('/'));
  assert.equal(fs.readFileSync(path.join(backup, 'skills/convertir-pdf-word/SKILL.md'), 'utf8'), before['skills/convertir-pdf-word/SKILL.md']);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'MANIFIESTO.json'), 'utf8'));
  assert.equal(manifest.archivos['skills/convertir-pdf-word/scripts/convertir_editable.py'], null, 'no existía antes');
  const src = (await inject('GET', `${W}/agents/${agentId}/source`)).json;
  assert.equal(src.state, 'integrated'); assert.equal(src.changes.length, 0);
  const evs = (await inject('GET', `${W}/agents/${agentId}/panel`)).json.events;
  const applied = evs.find((e: any) => e.kind === 'improvement_applied');
  assert.ok(applied && applied.detail.files.length >= 4 && applied.detail.files.every((f: any) => 'before' in f && 'after' in f) && applied.detail.authorization.by === 'owner' && applied.detail.revision === 3);
  assert.ok(evs.some((e: any) => e.kind === 'integration_state' && e.detail.to === 'integrated'));
  assert.equal((await inject('POST', `${W}/agents/${agentId}/proposals/${proposalId}/apply`, { authorized: true })).status, 409, 'no se aplica dos veces');
  assert.match(identityBlock(S, agentsRepo(S).get(agentId)!, null), /MODO-EDITABLE/);
});

test('la mejora cambia la siguiente ejecución; una corrección solo del documento crea otra versión', async () => {
  scenario({ auth: 'subscription', rules: [
    { match: 'MODO-EDITABLE', text: planRule('skills/convertir-pdf-word/scripts/convertir_editable.py', ['--informe', '{informe}']) },
    { match: 'Reglas del plan', text: planRule('skills/convertir-pdf-word/scripts/piloto.py', ['--pages', '1', '2']) }, REVIEW] });
  assert.equal((await inject('POST', `${W}/agents/${agentId}/documents/${jobId}/process`, { authorized: true })).status, 202);
  await until(async () => (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId).status !== 'processing');
  let job = (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId);
  assert.equal(job.status, 'ready', JSON.stringify(job.versions.at(-1))); const v2 = job.versions[1];
  assert.equal(v2.plan.script, 'skills/convertir-pdf-word/scripts/convertir_editable.py'); assert.equal(v2.passed, true); assert.equal(v2.skillRevision, '3');
  assert.equal(fs.readFileSync(path.join(root, 'documentos/propuesta-visual/versiones/v1.docx'), 'utf8'), 'PK-docx-RASTER', 'v1 no se sobrescribe');
  // Corrección solo de este documento.
  scenario({ auth: 'subscription', rules: [{ match: '# Feedback del propietario', text: JSON.stringify({ classification: 'document_only', reason: 'Solo afecta a este documento.', summary: 'Reducir un poco la escala.', changes: [] }) },
    { match: 'Reducir la escala', text: planRule('skills/convertir-pdf-word/scripts/convertir_editable.py', ['--escala', '0.96']) }, REVIEW] });
  const fb = await inject('POST', `${W}/agents/${agentId}/feedback`, { jobId, text: 'En este documento la página 2 queda muy justa.' });
  assert.equal(fb.json.classification, 'document_only'); assert.equal(fb.json.changes.length, 0); assert.equal(fb.json.state, 'rejected');
  assert.equal((await inject('POST', `${W}/agents/${agentId}/documents/${jobId}/process`, { authorized: true, feedback: 'Reducir la escala de este documento.' })).status, 202);
  await until(async () => (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId).status !== 'processing');
  job = (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId);
  assert.equal(job.versions.length, 3); assert.deepEqual(job.versions[2].plan.args, ['{entrada}', '{salida}', '--escala', '0.96']);
  assert.equal(fs.readFileSync(path.join(root, 'documentos/propuesta-visual/versiones/v3.docx'), 'utf8'), 'PK-docx-EDITABLE-escala-0.96');
  assert.equal((await inject('GET', `${W}/agents/${agentId}/source`)).json.revision, 3, 'la corrección del documento no cambia la habilidad');
});

test('fallos: script cambiado fuera, arnés caído, PDF escaneado sin OCR, reinicio a mitad, escritura por un enlace', async () => {
  // Script cambiado fuera del Portal: no se ejecuta.
  const p = path.join(root, 'skills/convertir-pdf-word/scripts/convertir_editable.py'); const orig = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, orig + '\n// cambiado fuera');
  const r = await inject('POST', `${W}/agents/${agentId}/documents/${jobId}/process`, { authorized: true });
  assert.equal(r.status, 409); assert.match(r.json.error, /sin revisar/);
  fs.writeFileSync(p, orig);
  // Arnés caído: falla con su motivo, sin otro arnés ni la API.
  scenario({ auth: 'subscription', behavior: 'error' });
  assert.equal((await inject('POST', `${W}/agents/${agentId}/documents/${jobId}/process`, { authorized: true })).status, 202);
  await until(async () => (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId).status !== 'processing');
  const failed = (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /no se usó otro arnés ni la API/); assert.equal(failed.versions.length, 3);
  // PDF escaneado sin OCR disponible: se rechaza con honestidad (no se entrega un Word de imágenes).
  scenario({ auth: 'subscription', rules: [{ match: 'Reglas del plan', text: planRule('skills/convertir-pdf-word/scripts/convertir_editable.py') }, REVIEW] });
  const sc = (await inject('POST', `${W}/agents/${agentId}/documents`, { name: 'escaneado.pdf', contentBase64: PDF('ESCANEADO').toString('base64') })).json.jobs[0];
  await inject('POST', `${W}/agents/${agentId}/documents/${sc.id}/process`, { authorized: true });
  await until(async () => (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === sc.id).status !== 'processing');
  assert.match((await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === sc.id).error, /OCR/);
  // Reinicio a mitad: un trabajo «procesando» sin ejecución viva queda como fallido y repetible.
  workspaceDb(S).prepare(`UPDATE document_jobs SET status = 'processing' WHERE id = ?`).run(sc.id);
  assert.match((await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === sc.id).error, /reinicio/);
  // Un enlace dentro de la zona de entregables no se atraviesa.
  if (junction) {
    fs.symlinkSync(outside, path.join(root, 'documentos', 'trampa'), 'junction');
    assert.throws(() => safeWrite(root, 'documentos/trampa/x.txt', 'x', ['documentos']), /enlace/);
    assert.ok(!fs.existsSync(path.join(outside, 'x.txt')));
  }
  assert.throws(() => safeWrite(root, 'AGENTS.md', 'x', ['documentos']), /zona concedida/);
  assert.throws(() => safeWrite(root, 'documentos/../AGENTS.md', 'x', ['documentos']), /no válida/);
});

test('restaurar una revisión anterior: con copia previa, nueva revisión y la carpeta vuelve a ese estado', async () => {
  const before = snapshotOfDisk();
  const r = await inject('POST', `${W}/agents/${agentId}/source/restore`, { n: 2, authorized: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(fs.readFileSync(path.join(root, 'skills/convertir-pdf-word/SKILL.md'), 'utf8'), /0\.4\.1/);
  assert.ok(!fs.existsSync(path.join(root, 'skills/convertir-pdf-word/scripts/convertir_editable.py')));
  assert.equal(fs.readFileSync(path.join(root, ...r.json.backup.split('/'), 'skills/convertir-pdf-word/SKILL.md'), 'utf8'), before['skills/convertir-pdf-word/SKILL.md']);
  const src = (await inject('GET', `${W}/agents/${agentId}/source`)).json;
  assert.equal(src.revision, 4); assert.equal(src.changes.length, 0); assert.equal(src.state, 'integrated', 'la procedencia y el historial se conservan');
  assert.ok(fs.existsSync(path.join(root, 'documentos/propuesta-visual/versiones/v2.docx')), 'restaurar no toca los entregables');
});

// ---------------------------------------------------------------- Gauntlet: regresiones de las tres revisiones independientes

test('Gauntlet · plan: cada marcador con su papel y sin opciones que elijan programas', () => {
  const sc = ['skills/x/scripts/conv.py'];
  for (const bad of [
    ['{entrada}', '{salida}', '--soffice', 'cmd'], ['{entrada}', '{salida}', '--informe', '{entrada}'], ['{salida}', '{entrada}'],
    ['{entrada}', '{salida}', '{informe}'], ['{entrada}', '{salida}', '--a', '{trabajo}', '--b', '{trabajo}'], ['{entrada}', '{salida}', '--PERFIL', 'x']
  ]) assert.equal(D.validatePlan({ script: sc[0], args: bad }, sc).ok, false, JSON.stringify(bad));
  assert.equal(D.validatePlan({ script: sc[0], args: ['{entrada}', '{salida}', '--informe', '{informe}', '--ajustar', '{trabajo}', '--pages', '1', '2'] }, sc).ok, true);
});

test('Gauntlet · propuestas: grafía canónica, añadir solo a lo que existe, sin __proto__, y obsoletas rechazadas', async () => {
  const src0 = (await inject('GET', `${W}/agents/${agentId}/source`)).json;
  const memBefore = fs.readFileSync(path.join(root, 'memoria/MEMORIA.md'), 'utf8');
  scenario({ auth: 'subscription', rules: [{ match: 'PROPUESTA-A', text: JSON.stringify({ classification: 'reusable', reason: 'r', summary: 'A', changes: [
    { path: 'memoria/memoria.md', kind: 'append', content: '- regla A', summary: 'grafía distinta' },
    { path: 'contexto/no-existe.md', kind: 'append', content: 'x', summary: 'añadir a lo que no existe' },
    { path: 'skills/convertir-pdf-word/scripts/x.py', kind: 'install', kit: '__proto__', summary: 'kit falso' }] }) },
    { match: 'PROPUESTA-B', text: JSON.stringify({ classification: 'reusable', reason: 'r', summary: 'B', changes: [{ path: 'MEMORIA/MEMORIA.md', kind: 'append', content: '- regla B', summary: 'b' }] }) }] });
  const a = (await inject('POST', `${W}/agents/${agentId}/feedback`, { jobId, text: 'PROPUESTA-A por favor' })).json;
  const b = (await inject('POST', `${W}/agents/${agentId}/feedback`, { jobId, text: 'PROPUESTA-B por favor' })).json;
  assert.deepEqual(a.changes.map((c: any) => c.path), ['memoria/MEMORIA.md'], 'la ruta se lleva a la grafía del archivo real; lo inválido se descarta');
  assert.match(a.reason, /no existe[\s\S]*herramienta desconocida/);
  assert.equal(b.changes[0].path, 'memoria/MEMORIA.md');
  const ok = await inject('POST', `${W}/agents/${agentId}/proposals/${a.id}/apply`, { authorized: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(fs.readFileSync(path.join(root, 'memoria/MEMORIA.md'), 'utf8'), `${memBefore.replace(/\s*$/, '')}\n\n- regla A\n`, 'se añade al archivo real, sin reemplazarlo');
  assert.ok(fs.readdirSync(path.join(root, 'memoria')).includes('MEMORIA.md'), 'el archivo conserva su nombre');
  assert.equal(fs.readFileSync(path.join(root, ...ok.json.backup.split('/'), 'memoria/MEMORIA.md'), 'utf8'), memBefore, 'la copia previa sí lo guarda');
  const stale = await inject('POST', `${W}/agents/${agentId}/proposals/${b.id}/apply`, { authorized: true });
  assert.equal(stale.status, 409); assert.equal(stale.json.code, 'stale_proposal');
  assert.equal((await inject('GET', `${W}/agents/${agentId}/source`)).json.revision, src0.revision + 1);
});

test('Gauntlet · restaurar incluye adaptadores (CLAUDE.md) y nunca queda a medias', async () => {
  const claude0 = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'); const agents0 = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const n0 = (await inject('GET', `${W}/agents/${agentId}/source`)).json.revision;
  w('CLAUDE.md', '@AGENTS.md\nOTRA NOTA\n'); w('AGENTS.md', `${agents0}\nCAMBIO A MANO\n`);
  const src = (await inject('GET', `${W}/agents/${agentId}/source`)).json;
  assert.deepEqual(src.diff.map((d: any) => d.path), ['AGENTS.md', 'CLAUDE.md']);
  assert.match(src.diff[0].after, /CAMBIO A MANO/, 'el texto del cambio se ve antes de adoptarlo');
  assert.equal((await inject('POST', `${W}/agents/${agentId}/source/adopt`, { hash: src.diskHash })).status, 200);
  const r = await inject('POST', `${W}/agents/${agentId}/source/restore`, { n: n0, authorized: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), claude0); assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), agents0);
  assert.equal((await inject('GET', `${W}/agents/${agentId}/source`)).json.changes.length, 0);
});

test('Gauntlet · ejecución: dependencias fijadas, copia verificada, versión libre, doble clic y QA que no se puede falsear', async () => {
  // .dependencias cambiada fuera: no se ejecuta nada hasta revisarla.
  fs.appendFileSync(path.join(root, '.dependencias', 'docx', '__init__.py'), '\n# cambiado fuera\n');
  let r = await inject('POST', `${W}/agents/${agentId}/documents/${jobId}/process`, { authorized: true });
  assert.equal(r.status, 409); assert.match(r.json.error, /\.dependencias/);
  const src = (await inject('GET', `${W}/agents/${agentId}/source`)).json; assert.ok(src.changes.some((c: any) => c.path === '@dependencias'));
  assert.equal((await inject('POST', `${W}/agents/${agentId}/source/adopt`, { hash: src.diskHash })).status, 200);
  // Una versión que quedó en disco sin registrar no bloquea: se usa la siguiente libre.
  const jobsNow = (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId);
  const next = Math.max(...jobsNow.versions.map((v: any) => v.n)) + 1;
  fs.writeFileSync(path.join(root, 'documentos/propuesta-visual/versiones', `v${next}.docx`), 'HUERFANO');
  // QA que falla tras dejar un veredicto «aprobado» falso: no cuenta. Y el doble clic no lanza dos ejecuciones.
  scenario({ auth: 'subscription', rules: [{ match: 'Reglas del plan', text: planRule('skills/convertir-pdf-word/scripts/piloto.py', ['--escala', '0.5']) }, REVIEW] });
  const [p1, p2] = await Promise.all([inject('POST', `${W}/agents/${agentId}/documents/${jobId}/process`, { authorized: true }), inject('POST', `${W}/agents/${agentId}/documents/${jobId}/process`, { authorized: true })]);
  assert.deepEqual([p1.status, p2.status].sort(), [202, 409]);
  await until(async () => (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId).status !== 'processing');
  const job = (await inject('GET', `${W}/agents/${agentId}/documents`)).json.jobs.find((j: any) => j.id === jobId);
  const v = job.versions.at(-1);
  assert.equal(v.n, next + 1, `salta la versión huérfana: ${job.status} ${job.error}`); assert.equal(fs.readFileSync(path.join(root, 'documentos/propuesta-visual/versiones', `v${next}.docx`), 'utf8'), 'HUERFANO');
  assert.equal(v.passed, false, 'un qa.json escrito por otro con «aprobado» no vale si la QA no terminó bien'); assert.equal(job.status, 'rejected');
  // El script que corre es la copia verificada: el del disco cambiado y re-adoptado vuelve a ser lo que se ejecuta.
  assert.ok(fs.existsSync(path.join(root, 'documentos/propuesta-visual/versiones', `v${next + 1}.docx`)));
});

test('Gauntlet · eliminar un agente externo retira su fuente: la carpeta se puede volver a integrar; nunca la API', async () => {
  const other = path.join(base, 'Otro-Agente'); fs.mkdirSync(path.join(other, 'documentos'), { recursive: true });
  fs.writeFileSync(path.join(other, 'AGENTS.md'), '# Otro agente\n\nHace otra cosa.\n');
  const pv = (await inject('POST', `${W}/agents/external/preview`, { path: other })).json;
  const body = { path: other, hash: pv.hash, name: 'Otro agente', role: 'Pruebas', summary: '', department: 'Documentos', harness: 'claude-code', model: 'claude-sonnet-4-5', grants: { writeDocuments: false, runScripts: false, applyImprovements: false }, authorized: true };
  assert.equal((await inject('POST', `${W}/agents/external`, { ...body, harness: 'claude-code-terminal' })).status, 400);
  const a1 = await inject('POST', `${W}/agents/external`, body); assert.equal(a1.status, 201);
  assert.equal((await inject('PUT', `${W}/agents/${a1.json.id}/harness`, { harness: 'api', model: 'claude-sonnet-4-5', provider: 'anthropic', authorized: true })).status, 409, 'un agente externo no pasa a la API');
  assert.equal((await inject('DELETE', `${W}/agents/${a1.json.id}`)).status < 300, true);
  const pv2 = (await inject('POST', `${W}/agents/external/preview`, { path: other })).json;
  assert.equal(pv2.duplicate, null);
  const a2 = await inject('POST', `${W}/agents/external`, { ...body, hash: pv2.hash }); assert.equal(a2.status, 201, JSON.stringify(a2.json));
});

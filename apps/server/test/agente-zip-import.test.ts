import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ImportGrant } from '../src/services/agentCreation.ts';

/**
 * HU-183 · Importar un agente desde ZIP y adoptar lo que aprendió fuera (docs/agentes-portables.md).
 * Sin modelos ni costo: se llama a los servicios directamente con ZIP fabricados en la prueba. Comprueba:
 *  - agente nuevo con la concesión del propietario (lo que pide el ZIP no se concede solo);
 *  - agente existente con cambios solo fuera → revisión 'import' automática, lessons y Deshacer ('restore');
 *  - conflicto (cambio en ambos lados) → 409 sin aplicar nada; resolución 'portal' y 'zip'; fusión sin conflicto;
 *  - rechazo completo de secretos, recorridos, rutas absolutas, enlaces y archivos fuera de la lista blanca;
 *  - huella obsoleta entre vista previa y confirmación; arnés y herramientas del ZIP no se adoptan.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-zipimp-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo } = await import('../src/db/workspace.ts');
const { agentFoldersRepo, updateExtras } = await import('../src/services/agentFolders.ts');
const { exportFiles } = await import('../src/services/agentCreation.ts');
const { applyZipImport, previewZipImport, undoZipImport } = await import('../src/services/agentZipImport.ts');
const { lessonsRepo } = await import('../src/services/lessons.ts');
const { agentEvents } = await import('../src/services/agentEvents.ts');
const { identityBlock } = await import('../src/services/agentIdentity.ts');

providersRepo.setCredential('anthropic', encryptSecret('clave-de-prueba'), 'clave…prueba');
providersRepo.setConnected('anthropic', ['claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia';
const noRow = () => () => { /* la identidad de la fila no se comprueba aquí */ };
const GRANT: ImportGrant = { department: 'Pruebas', scope: 'workspace', projectId: null, harness: 'api', model: 'claude-sonnet-4-5', provider: 'anthropic', effort: 'medium', tools: [], knowledge: [], autonomy: 'ask', authorized: true, capabilities: [] };

/** ZIP mínimo (almacenado) con atributos externos opcionales para fabricar enlaces. */
function zip(entries: { name: string; data: string | Buffer; ext?: number }[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let off = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8'); const name = Buffer.from(e.name, 'utf8'); const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, data]); locals.push(local);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(e.ext ?? 0, 38); ch.writeUInt32LE(off, 42);
    centrals.push(Buffer.concat([ch, name])); off += local.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pia-zipimp-in-')); let seq = 0;
const zipFile = (entries: { name: string; data: string | Buffer; ext?: number }[]) => { const f = path.join(tmpDir, `z${++seq}.zip`); fs.writeFileSync(f, zip(entries)); return f; };
const entriesOf = (files: Record<string, string>, root = '') => Object.entries(files).map(([name, data]) => ({ name: root + name, data }));
const mutate = (files: Record<string, string>, fn: (d: any) => void) => { const d = D.filesToDefinition(files).definition!; fn(d); return D.definitionToFiles(d); };
const markerFor = (agentId: string, workspace = S) => { const ad = agentFoldersRepo(S).adopted(agentId)!; return { name: 'portal-export.json', data: JSON.stringify({ workspace, agentId, n: ad.n, hash: ad.hash, exportedAt: new Date().toISOString() }) }; };
const revCount = (id: string) => agentFoldersRepo(S).revisions(id).length;
const status = (code: number, re?: RegExp) => (e: any) => { assert.equal(e?.statusCode, code, e?.message); if (re) assert.match(e.message, re); return true; };

const BASE_FILES = D.definitionToFiles({
  manifest: { schema: D.PORTABLE_AGENT_SCHEMA, id: 'ext-agente-1', name: 'Analista Portable', role: 'Análisis de datos', department: 'Pruebas', initials: 'AP', summary: 'Analiza datos y resume.', responsibilities: ['Analizar'], deliverables: ['Informe'], capabilities: [], harness: { preferred: 'codex', model: 'gpt-5', effort: 'high' }, permissions: { tools: ['shell', 'web'], autonomy: 'within_scope' }, createdAt: '2026-10-01' },
  instructions: 'Soy el analista portable. Respondo con datos.', skills: [{ slug: 'resumir', name: 'resumir', description: 'Resumir tablas.', body: 'Resume en tres puntos.' }],
  memory: [{ id: 'm-1', title: 'Formato', text: 'Usar fechas ISO.', verifiedAt: '2026-10-01', verifiedBy: 'owner', source: 'sesión externa' }], knowledge: []
} as any);

let agentId = '';

test('agente nuevo: flujo de concesión; lo que pide el ZIP (arnés, herramientas) no se concede', async () => {
  const pv = previewZipImport(S, zipFile(entriesOf(BASE_FILES, 'analista/')), 'analista.zip');
  assert.equal(pv.mode, 'nuevo'); assert.equal(pv.ok, true);
  assert.equal(pv.requests?.harness, 'codex'); assert.deepEqual(pv.requests?.tools, ['shell', 'web']);
  await assert.rejects(applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: {} }, noRow), status(400, /arnés/));
  const r = await applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: {}, grant: GRANT }, noRow);
  assert.equal(r.mode, 'nuevo'); agentId = r.agent.id;
  assert.notEqual(agentId, 'ext-agente-1', 'el agente recibe un id nuevo');
  const a = agentsRepo(S).get(agentId)!;
  assert.equal(a.config.backend, 'api', 'arnés concedido por el propietario');
  assert.ok(!Object.keys(a.config.tools).includes('shell'), 'herramientas pedidas no concedidas');
  const ad = agentFoldersRepo(S).adopted(agentId)!;
  assert.match(ad.files['AGENTS.md'] ?? '', /analista portable/);
  assert.ok(agentFoldersRepo(S).revisions(agentId).some(x => x.source === 'import'));
  assert.ok(agentEvents(S, agentId, 50).some(e => e.kind === 'imported_zip'));
});

test('existente con cambios solo fuera: se adopta solo como revisión «import»; Deshacer vuelve atrás y retira la memoria', async () => {
  const { files } = await exportFiles(S, agentId);
  const before = agentFoldersRepo(S).adopted(agentId)!; const beforeDef = D.filesToDefinition(before.files).definition!;
  const theirs = mutate(files, d => {
    d.instructions = `${d.instructions}\n\nAPRENDIDO-FUERA: siempre una tabla resumen al final.`;
    d.changelog = '# Cambios\n\n- Añadida la tabla resumen (sesión externa).';
    d.memory = [...d.memory, { id: 'm-zip-1', title: 'Tabla resumen', text: 'El propietario quiere siempre una tabla resumen.', verifiedAt: '2026-11-01', verifiedBy: 'owner', source: 'Claude Code fuera del Portal' }];
    d.manifest.harness = { preferred: 'codex', model: 'gpt-5', effort: 'max' }; d.manifest.permissions = { tools: ['shell'], autonomy: 'within_scope' };
  });
  const pv = previewZipImport(S, zipFile([...entriesOf(theirs), markerFor(agentId)]), 'fuera.zip');
  assert.equal(pv.mode, 'existente'); assert.equal(pv.agentId, agentId); assert.deepEqual(pv.conflicts, []);
  for (const p of ['AGENTS.md', 'CAMBIOS.md', 'memory/MEMORY.md']) assert.ok(pv.adopted.includes(p), `${p} se adopta: ${pv.adopted.join(', ')}`);
  assert.equal(pv.newMemory.length, 1);
  assert.ok(pv.notAdopted.length >= 1, 'el arnés y los permisos del ZIP se muestran como no adoptados');
  const r = await applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: {} }, noRow);
  assert.equal(r.revision?.source, 'import'); assert.equal(r.undo?.n, before.n);
  const ad = agentFoldersRepo(S).adopted(agentId)!; const def = D.filesToDefinition(ad.files).definition!;
  assert.equal(ad.n, r.revision!.n); assert.match(ad.files['AGENTS.md']!, /APRENDIDO-FUERA/); assert.match(ad.files['CAMBIOS.md'] ?? '', /tabla resumen/);
  assert.deepEqual(def.manifest.harness, beforeDef.manifest.harness, 'el arnés no se adopta');
  assert.deepEqual(def.manifest.permissions, beforeDef.manifest.permissions, 'los permisos no se adoptan');
  // EN-011: la memoria importada llega como lección DETECTADA del agente (pendiente de tu verificación), nunca validada sola.
  assert.ok(lessonsRepo(S).listForAgent(agentId).some(l => l.status === 'detected' && /tabla resumen/.test(l.lessonText ?? '')));
  assert.ok(!lessonsRepo(S).listForAgent(agentId, 'validated').some(l => /tabla resumen/.test(l.lessonText ?? '')), 'no entra validada');
  assert.match(identityBlock(S, agentsRepo(S).get(agentId)!, null), /APRENDIDO-FUERA/, 'los prompts usan lo adoptado');
  assert.ok(agentFoldersRepo(S).revisions(agentId).some(x => x.n === r.revision!.n && x.source === 'import'), 'visible en el historial');
  // Deshacer.
  const u = await undoZipImport(S, agentId, r.revision!.n, noRow());
  assert.equal(u.revision.source, 'restore'); assert.equal(u.retired, 1);
  const back = agentFoldersRepo(S).adopted(agentId)!;
  assert.equal(back.files['AGENTS.md'], before.files['AGENTS.md']);
  assert.ok(!(back.files['memory/MEMORY.md'] ?? '').includes('tabla resumen'), 'MEMORY.md ya no tiene la entrada importada');
  assert.ok(!lessonsRepo(S).listForAgent(agentId, 'validated').some(l => /tabla resumen/.test(l.lessonText ?? '')));
  assert.ok(!identityBlock(S, agentsRepo(S).get(agentId)!, null).includes('APRENDIDO-FUERA'), 'los prompts vuelven a lo de antes');
  await assert.rejects(undoZipImport(S, agentId, r.revision!.n, noRow()), status(409));
});

test('conflicto: si el Portal también cambió el archivo no se aplica nada hasta elegir; lo demás se fusiona', async () => {
  const { files } = await exportFiles(S, agentId); const marker = markerFor(agentId);
  await updateExtras(S, agentId, { instructions: 'VERSION-PORTAL: instrucciones editadas en el Portal.' }, 'portal', 'Cambio en el Portal');
  const theirs = mutate(files, d => { d.instructions = 'VERSION-ZIP: instrucciones editadas fuera.'; d.knowledge = [...d.knowledge, { slug: 'guia', title: 'Guía', body: 'Referencia nueva de fuera.' }]; });
  const pv = previewZipImport(S, zipFile([...entriesOf(theirs), marker]), 'conflicto.zip');
  assert.deepEqual(pv.conflicts.map(c => c.path), ['AGENTS.md']); assert.ok(pv.adopted.includes('knowledge/guia.md'));
  const n0 = agentFoldersRepo(S).adopted(agentId)!.n; const c0 = revCount(agentId);
  await assert.rejects(applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: {} }, noRow), (e: any) => { assert.equal(e.statusCode, 409); assert.deepEqual(e.payload.conflicts.map((c: any) => c.path), ['AGENTS.md']); return true; });
  assert.equal(agentFoldersRepo(S).adopted(agentId)!.n, n0, 'nada aplicado'); assert.equal(revCount(agentId), c0);
  const r = await applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: { 'AGENTS.md': 'portal' } }, noRow);
  const ad = agentFoldersRepo(S).adopted(agentId)!;
  assert.equal(r.revision?.source, 'import'); assert.match(ad.files['AGENTS.md']!, /VERSION-PORTAL/); assert.match(ad.files['knowledge/guia.md'] ?? '', /Referencia nueva/);
});

test('conflicto resuelto con la versión del ZIP', async () => {
  const { files } = await exportFiles(S, agentId); const marker = markerFor(agentId);
  await updateExtras(S, agentId, { instructions: 'OTRA-PORTAL: cambio en el Portal.' }, 'portal', 'Cambio en el Portal');
  const theirs = mutate(files, d => { d.instructions = 'OTRA-ZIP: cambio de fuera.'; });
  const pv = previewZipImport(S, zipFile([...entriesOf(theirs), marker]), 'zip.zip');
  assert.deepEqual(pv.conflicts.map(c => c.path), ['AGENTS.md']);
  const r = await applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: { 'AGENTS.md': 'zip' } }, noRow);
  assert.ok(r.adopted.includes('AGENTS.md')); assert.match(agentFoldersRepo(S).adopted(agentId)!.files['AGENTS.md']!, /OTRA-ZIP/);
});

test('sin marcador (base «parecido»): lo cambiado en el Portal y fuera sale como conflicto, nunca se pisa en silencio', async () => {
  const { files } = await exportFiles(S, agentId);
  await updateExtras(S, agentId, { instructions: 'VERSION-PORTAL-SM: editado en el Portal tras exportar.' }, 'portal', 'Cambio en el Portal');
  const theirs = mutate(files, d => {
    d.instructions = 'VERSION-ZIP-SM: editado fuera.';
    d.skills = d.skills.map((s: any) => s.slug === 'resumir' ? { ...s, body: 'HABILIDAD-FUERA: resume en cinco puntos.' } : s);
  });
  const pv = previewZipImport(S, zipFile(entriesOf(theirs)), 'sin-marcador.zip');
  assert.equal(pv.mode, 'existente'); assert.equal(pv.base?.how, 'parecido');
  assert.deepEqual(pv.conflicts.map(c => c.path), ['AGENTS.md'], 'la base adivinada no puede ser la revisión editada en el Portal');
  assert.ok(pv.adopted.includes('skills/resumir/SKILL.md'), `la habilidad de fuera se adopta: ${pv.adopted.join(', ')}`);
  const n0 = agentFoldersRepo(S).adopted(agentId)!.n;
  await assert.rejects(applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: {} }, noRow), status(409));
  assert.equal(agentFoldersRepo(S).adopted(agentId)!.n, n0, 'nada aplicado sin elegir');
  assert.match(agentFoldersRepo(S).adopted(agentId)!.files['AGENTS.md']!, /VERSION-PORTAL-SM/);
  await applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: { 'AGENTS.md': 'portal' } }, noRow);
  const ad = agentFoldersRepo(S).adopted(agentId)!;
  assert.match(ad.files['AGENTS.md']!, /VERSION-PORTAL-SM/, 'se conserva lo del Portal');
  assert.ok(!ad.files['AGENTS.md']!.includes('VERSION-ZIP-SM'));
  assert.match(ad.files['skills/resumir/SKILL.md'] ?? '', /HABILIDAD-FUERA/);
});

test('sin marcador ni base reconocible («sin-base»): todo lo que difiere sale como conflicto', async () => {
  const { files } = await exportFiles(S, agentId);
  const changedFiles = mutate(files, d => {
    d.manifest.summary = 'RESUMEN-SB: nada en común con el Portal.'; d.instructions = 'INSTR-SB: nada en común.';
    d.skills = d.skills.map((s: any) => ({ ...s, body: 'SKILL-SB: otra cosa distinta.' }));
  });
  const theirs = Object.fromEntries(Object.entries(changedFiles).filter(([p]) => p === 'agent.yaml' || p === 'AGENTS.md' || p.startsWith('skills/')));
  const pv = previewZipImport(S, zipFile(entriesOf(theirs)), 'sin-base.zip');
  assert.equal(pv.mode, 'existente'); assert.equal(pv.base?.how, 'sin-base');
  assert.deepEqual(pv.conflicts.map(c => c.path).sort(), Object.keys(theirs).sort());
  assert.deepEqual(pv.adopted, [], 'sin base no se adopta nada solo');
  const n0 = agentFoldersRepo(S).adopted(agentId)!.n; const c0 = revCount(agentId);
  await assert.rejects(applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: {} }, noRow), status(409));
  assert.equal(agentFoldersRepo(S).adopted(agentId)!.n, n0); assert.equal(revCount(agentId), c0);
});

test('rutas con «\\» se aceptan normalizadas; un duplicado real se rechaza', async () => {
  const { files } = await exportFiles(S, agentId);
  const pv = previewZipImport(S, zipFile([...entriesOf(files, 'raiz\\'), { ...markerFor(agentId), name: 'raiz\\portal-export.json' }]), 'windows.zip');
  assert.equal(pv.mode, 'existente'); assert.ok(pv.files.includes('AGENTS.md')); assert.ok(pv.files.includes('agent.yaml'));
  assert.equal(pv.upToDate, true);
  assert.throws(() => previewZipImport(S, zipFile([...entriesOf(files, 'raiz/'), { name: 'raiz\\AGENTS.md', data: 'duplicado' }]), 'dup.zip'), status(400, /AGENTS\.md: está repetido/));
});

test('rechazo completo: secretos, recorridos, rutas absolutas, enlaces y archivos fuera de la lista blanca (sin revisión)', async () => {
  const { files } = await exportFiles(S, agentId); const c0 = revCount(agentId); const n0 = agentFoldersRepo(S).adopted(agentId)!.n;
  const fake = ['sk', 'ant', 'api03'].join('-') + '-' + 'Q'.repeat(30);
  const secret = mutate(files, d => { d.skills = [{ slug: 'filtrar', name: 'filtrar', description: 'x', body: `Usa la clave ${fake}` }]; });
  assert.throws(() => previewZipImport(S, zipFile(entriesOf(secret)), 's.zip'), status(400, /skills\/filtrar\/SKILL\.md: contiene lo que parece/));
  const bad: [{ name: string; data: string; ext?: number }, RegExp][] = [
    [{ name: '../fuera.md', data: 'x' }, /fuera\.md/],
    [{ name: 'C:/Windows/AGENTS.md', data: 'x' }, /Windows/],
    [{ name: '/etc/AGENTS.md', data: 'x' }, /etc/],
    [{ name: 'scripts/run.sh', data: 'echo x' }, /fuera de la carpeta del agente/],
    [{ name: 'knowledge/enlace.md', data: '/etc/passwd', ext: (0o120777 << 16) >>> 0 }, /enlace/],
    [{ name: 'AGENTS.md', data: 'duplicado' }, /AGENTS\.md: está repetido/],
    [{ name: 'agents.md', data: 'duplicado' }, /agents\.md: está repetido/]
  ];
  for (const [entry, re] of bad) assert.throws(() => previewZipImport(S, zipFile([...entriesOf(files), entry]), 'malo.zip'), status(400, re), entry.name);
  assert.equal(revCount(agentId), c0); assert.equal(agentFoldersRepo(S).adopted(agentId)!.n, n0);
});

test('huella obsoleta (409), vista previa caducada (410), marcador de otro espacio = agente nuevo, ZIP sin cambios', async () => {
  const { files } = await exportFiles(S, agentId);
  const theirs = mutate(files, d => { d.instructions = `${d.instructions}\nCAMBIO-HUELLA`; });
  const pv = previewZipImport(S, zipFile([...entriesOf(theirs), markerFor(agentId)]), 'h.zip');
  await assert.rejects(applyZipImport(S, { token: pv.token, hash: 'f'.repeat(64), resolutions: {} }, noRow), status(409, /cambió/));
  await assert.rejects(applyZipImport(S, { token: '0'.repeat(32), hash: pv.hash, resolutions: {} }, noRow), status(410));
  const other = previewZipImport(S, zipFile([...entriesOf(files), markerFor(agentId, 'otro-espacio')]), 'otro.zip');
  assert.equal(other.mode, 'nuevo', 'nunca se adopta un agente de otro espacio');
  const same = previewZipImport(S, zipFile([...entriesOf(files), markerFor(agentId)]), 'igual.zip');
  assert.equal(same.mode, 'existente'); assert.equal(same.upToDate, true);
  const c0 = revCount(agentId);
  const r = await applyZipImport(S, { token: same.token, hash: same.hash, resolutions: {} }, noRow);
  assert.equal(r.upToDate, true); assert.equal(r.revision, null); assert.equal(revCount(agentId), c0, 'sin cambios no hay revisión');
});

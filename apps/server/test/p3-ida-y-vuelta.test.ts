import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Portal IA 3 · IDA Y VUELTA de un agente con el paquete REAL que entrega «Descargar paquete (ZIP)».
 * Antes: el paquete no llevaba ni el id ni el marcador de exportación, así que al volver a importarlo SIEMPRE entraba como
 * un agente nuevo (y el panel del propio agente lo rechazaba: «Este ZIP es de otro agente»). Las pruebas existentes
 * fabricaban ZIP a mano con un marcador que la exportación nunca escribía.
 * Aquí: exportar → (sin tocar) reimportar = al día · exportar → mejorar fuera → reimportar = se adopta solo lo cambiado,
 * la memoria nueva llega pendiente, un cambio hecho también en el Portal es un conflicto visible, y Deshacer vuelve atrás.
 * Sin IA. Datos sintéticos.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3rt-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo } = await import('../src/db/workspace.ts');
const { agentFoldersRepo, syncAgentFolder, updateExtras } = await import('../src/services/agentFolders.ts');
const { exportBundle } = await import('../src/services/agentCreation.ts');
const { applyZipImport, bundleIdOf, previewZipImport, undoZipImport, ZIP_EXPORT_MARKER } = await import('../src/services/agentZipImport.ts');
const { listZip, readZipEntry, zipBuffers } = await import('../src/services/zipFile.ts');
const { lessonsRepo } = await import('../src/services/lessons.ts');

providersRepo.setCredential('anthropic', encryptSecret('clave-de-prueba'), 'clave…prueba');
providersRepo.setConnected('anthropic', ['claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia';
const noRow = () => () => { /* la fila no se comprueba aquí */ };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pia-p3rt-zip-')); let seq = 0;

const agent = agentsRepo(S).list().find(a => /Arquitecto/.test(a.config.name)) ?? agentsRepo(S).list()[0]!;
await syncAgentFolder(S, agent);

/** Lee un ZIP a un mapa nombre → texto. */
function unzip(buf: Buffer): Record<string, string> {
  const f = path.join(tmp, `in${++seq}.zip`); fs.writeFileSync(f, buf);
  const out: Record<string, string> = {};
  for (const e of listZip(f, { maxEntries: 500, maxEntryBytes: 2_000_000, maxRatio: 500 }).entries) if (!e.isDir) out[e.name] = readZipEntry(f, e).toString('utf8');
  return out;
}
const rezip = (files: Record<string, string>) => { const f = path.join(tmp, `out${++seq}.zip`); fs.writeFileSync(f, zipBuffers(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data, 'utf8') })))); return f; };

test('el paquete exportado lleva su marcador: identificador portable (no el id interno), revisión base y huella de cada archivo', async () => {
  const { zip } = await exportBundle(S, agent.id);
  const files = unzip(zip);
  assert.ok(files[ZIP_EXPORT_MARKER], 'el paquete incluye portal-export.json');
  const m = JSON.parse(files[ZIP_EXPORT_MARKER]!);
  assert.equal(m.bundle, bundleIdOf(agent.id));
  assert.equal(m.n, agentFoldersRepo(S).adopted(agent.id)!.n);
  assert.ok(Object.keys(m.files).includes('AGENTS.md') && Object.keys(m.files).includes('agent.yaml'));
  for (const text of Object.values(files)) assert.ok(!text.includes(agent.id), 'el id interno del agente no sale en ningún archivo');
  assert.ok(!JSON.stringify(m).includes(S + '"'), 'ni el nombre del espacio');
});

test('exportar y reimportar SIN tocar nada: es su mismo agente y está al día (antes entraba como agente nuevo)', async () => {
  const { zip } = await exportBundle(S, agent.id);
  const f = path.join(tmp, `same${++seq}.zip`); fs.writeFileSync(f, zip);
  const pv = previewZipImport(S, f, 'paquete.zip');
  assert.equal(pv.mode, 'existente', 'se reconoce como el agente que lo exportó');
  assert.equal(pv.agentId, agent.id);
  assert.deepEqual(pv.conflicts, []);
  assert.equal(pv.upToDate, true, `nada que adoptar: ${pv.adopted.join(', ')}`);
  assert.equal(pv.base?.how, 'marcador');
});

test('mejorado FUERA y reimportado: se adopta solo lo que cambió, la memoria nueva llega pendiente y Deshacer vuelve atrás', async () => {
  const before = agentFoldersRepo(S).adopted(agent.id)!;
  const { zip } = await exportBundle(S, agent.id);
  const files = unzip(zip);
  // Lo que haría el agente trabajando en otra plataforma: mejora sus instrucciones, anota el cambio y aprende algo.
  files['AGENTS.md'] = `${files['AGENTS.md']!.trimEnd()}\n\n## Aprendido fuera\n\nAPRENDIDO-FUERA: antes de proponer una arquitectura, pregunta el volumen de datos esperado.\n`;
  files['CAMBIOS.md'] = `${files['CAMBIOS.md']!.trimEnd()}\n\n## 2026-11-14 · sesión externa\n\n- Añadida la pregunta sobre el volumen de datos.\n`;
  const mem = D.filesToDefinition({ 'agent.yaml': files['agent.yaml']!, 'AGENTS.md': files['AGENTS.md']!, 'memory/MEMORY.md': files['memory/MEMORY.md']! }).definition!;
  const withMem = D.definitionToFiles({ ...mem, memory: [...mem.memory, { id: 'm-fuera-1', title: 'Volumen de datos', text: 'El propietario quiere que se pregunte siempre el volumen de datos esperado.', verifiedAt: '2026-11-14', verifiedBy: 'el propietario', source: 'Claude Code fuera del Portal' }] } as any);
  files['memory/MEMORY.md'] = withMem['memory/MEMORY.md']!;
  const pv = previewZipImport(S, rezip(files), 'mejorado.zip');
  assert.equal(pv.mode, 'existente'); assert.equal(pv.agentId, agent.id);
  assert.deepEqual(pv.conflicts, [], JSON.stringify(pv.conflicts.map(c => c.path)));
  assert.ok(pv.adopted.includes('AGENTS.md'), pv.adopted.join(', '));
  assert.ok(!pv.adopted.includes('agent.yaml'), 'lo que no cambió fuera no se «adopta» (el paquete lo lleva limpio, pero es el mismo)');
  for (const p of pv.adopted) assert.ok(!/^(GUIA|AUTOMEJORA)\.md$|^scripts\//.test(p), `un archivo que genera el paquete no se adopta: ${p}`);
  assert.equal(pv.newMemory.length, 1);
  const r = await applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: {} }, noRow);
  const ad = agentFoldersRepo(S).adopted(agent.id)!;
  assert.equal(r.revision?.source, 'import');
  assert.match(ad.files['AGENTS.md']!, /APRENDIDO-FUERA/);
  assert.doesNotMatch(ad.files['AGENTS.md']!, /^> Reglas de automejora: lee y cumple AUTOMEJORA\.md/m, 'el aviso del paquete no pasa a las instrucciones del agente');
  assert.equal(ad.files['agent.yaml'], before.files['agent.yaml'], 'la ficha (id, arnés, permisos) queda como estaba');
  assert.ok(lessonsRepo(S).listForAgent(agent.id).some(l => l.status === 'detected' && /volumen de datos/.test(l.lessonText ?? '')), 'la memoria nueva llega pendiente de verificación');
  // Reimportar el mismo paquete otra vez no duplica nada.
  const again = previewZipImport(S, rezip(files), 'mejorado-otra-vez.zip');
  assert.equal(again.newMemory.length, 0);
  // Deshacer.
  const u = await undoZipImport(S, agent.id, r.revision!.n, noRow());
  assert.equal(u.revision.source, 'restore');
  assert.equal(agentFoldersRepo(S).adopted(agent.id)!.files['AGENTS.md'], before.files['AGENTS.md']);
});

test('cambió fuera Y en el Portal desde la exportación: conflicto visible, nada se pisa en silencio; lo demás se fusiona', async () => {
  const { zip } = await exportBundle(S, agent.id);
  const files = unzip(zip);
  await updateExtras(S, agent.id, { instructions: 'VERSION-PORTAL: instrucciones editadas en el Portal tras exportar.' }, 'portal', 'Cambio en el Portal');
  files['AGENTS.md'] = `${files['AGENTS.md']!.trimEnd()}\n\nVERSION-FUERA: instrucciones editadas fuera.\n`;
  files['knowledge/guia-externa.md'] = '# Guía externa\n\nReferencia nueva escrita fuera del Portal.\n';
  const pv = previewZipImport(S, rezip(files), 'conflicto.zip');
  assert.equal(pv.mode, 'existente');
  assert.deepEqual(pv.conflicts.map(c => c.path), ['AGENTS.md']);
  assert.ok(pv.adopted.includes('knowledge/guia-externa.md'));
  await assert.rejects(applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: {} }, noRow), (e: any) => e.statusCode === 409);
  const r = await applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: { 'AGENTS.md': 'portal' } }, noRow);
  const ad = agentFoldersRepo(S).adopted(agent.id)!;
  assert.equal(r.revision?.source, 'import');
  assert.match(ad.files['AGENTS.md']!, /VERSION-PORTAL/); assert.doesNotMatch(ad.files['AGENTS.md']!, /VERSION-FUERA/);
  assert.match(ad.files['knowledge/guia-externa.md'] ?? '', /Referencia nueva/);
});

test('el paquete de OTRO agente no se confunde con este: entra como nuevo (y un marcador manipulado no adopta nada ajeno)', async () => {
  const other = agentsRepo(S).list().find(a => a.id !== agent.id)!;
  await syncAgentFolder(S, other);
  const { zip } = await exportBundle(S, other.id);
  const files = unzip(zip);
  const pv = previewZipImport(S, rezip(files), 'otro.zip');
  assert.equal(pv.agentId, other.id, 'vuelve a SU agente, no al primero');
  const m = JSON.parse(files[ZIP_EXPORT_MARKER]!); m.bundle = 'pa-000000000000000000000000';
  const forged = previewZipImport(S, rezip({ ...files, [ZIP_EXPORT_MARKER]: JSON.stringify(m) }), 'falso.zip');
  assert.equal(forged.mode, 'nuevo', 'un identificador que no es de ningún agente de este espacio es un agente nuevo');
});

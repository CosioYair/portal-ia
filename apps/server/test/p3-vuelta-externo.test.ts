import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Portal IA 3 · VUELTA de un agente con carpeta propia (como PDF Word Fiel) usando el paquete REAL que se descarga.
 * exportar → mejorar fuera (script, habilidad y memoria) → vista previa (solo lo cambiado, con su comparación) →
 * aplicar (con copia previa en la carpeta del agente) → la capacidad sigue ahí con lo aprendido → Restaurar lo deshace.
 * Además: un cambio hecho también en el Portal es un conflicto; los documentos del propietario nunca se tocan; el paquete
 * de otro agente o sin marcador se rechaza. Sin IA. Carpeta sintética (nunca la del propietario).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3ext-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3ext-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify({ auth: 'subscription', defaultText: 'ok' }));

const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { listZip, readZipEntry, zipBuffers } = await import('../src/services/zipFile.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { resetDetectionCache, verifiedDetection } = await import('../src/services/claudeCode/detect.ts');
const { sourcesRepo } = await import('../src/services/externalAgents.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('clave-de-prueba'), 'clave…prueba');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const app = await buildApp();
saveClaudeCodeSettings({ ...getClaudeCodeSettings(), enabled: true, cliPath: FAKE, maxConcurrent: 1 }); resetDetectionCache();
await verifiedDetection(getClaudeCodeSettings(), 0);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3ext-zip-'));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3ext-agente-'));
after(async () => { await app.close(); for (const d of [tmp, base, fakeDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temporal */ } } });

const root = path.join(base, 'Conversor');
const w = (rel: string, data: string) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const r = (rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const SCRIPT = '# -*- coding: utf-8 -*-\n"""Convierte un documento."""\nimport sys\n\nESCALA = 0.94\n\ndef main():\n    print("listo", sys.argv[1], ESCALA)\n\nif __name__ == "__main__":\n    main()\n';
w('AGENTS.md', '# Conversor\n\nConvierto documentos con la habilidad convertir.\n');
w('contexto/contrato.md', '# Contrato de calidad\n\nEl texto debe quedar editable.\n');
w('memoria/MEMORIA.md', '# Memoria\n\n- MEM-1: conservar los encabezados como títulos.\n');
w('skills/convertir/SKILL.md', '---\nname: convertir\ndescription: Convierte documentos.\n---\n\n# Convertir\n\nUsa scripts/convertir.py.\n');
w('skills/convertir/scripts/convertir.py', SCRIPT);
w('skills/convertir/scripts/requirements.txt', 'python-docx==1.2.0\n');
// Documentos del propietario: jamás forman parte de la identidad ni se tocan.
w('documentos/originales/contrato-cliente.txt', 'DOCUMENTO DEL PROPIETARIO: no tocar.\n');

const pv0 = (await app.inject({ method: 'POST', url: `${W}/agents/external/preview`, payload: { path: root } })).json();
const imp = await app.inject({ method: 'POST', url: `${W}/agents/external`, payload: { path: root, hash: pv0.hash, name: 'Conversor', role: 'Conversión de documentos', summary: 'Convierte documentos.', department: 'Documentos', harness: 'claude-code', model: 'claude-sonnet-4-5', grants: { writeDocuments: true, runScripts: true, applyImprovements: true }, authorized: true } });
assert.ok(imp.statusCode < 300, imp.body);
const extId = imp.json().id as string;

function unzip(buf: Buffer): Record<string, string> {
  const f = path.join(tmp, `in-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`); fs.writeFileSync(f, buf);
  const out: Record<string, string> = {};
  for (const e of listZip(f, { maxEntries: 500, maxEntryBytes: 4_000_000, maxRatio: 500 }).entries) if (!e.isDir) out[e.name] = readZipEntry(f, e).toString('utf8');
  return out;
}
const zipOf = (files: Record<string, string>) => zipBuffers(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data, 'utf8') })));
const exportPkg = async () => { const x = await app.inject({ method: 'GET', url: `${W}/agents/${extId}/export.zip` }); assert.equal(x.statusCode, 200, x.body); return unzip(x.rawPayload); };
const preview = (files: Record<string, string>, id = extId) => app.inject({ method: 'POST', url: `${W}/agents/${id}/source/package/preview`, headers: { 'content-type': 'application/octet-stream' }, payload: zipOf(files) });
const apply = (token: string, resolutions: Record<string, string> = {}) => app.inject({ method: 'POST', url: `${W}/agents/${extId}/source/package/apply`, payload: { token, resolutions, authorized: true } });
const DOC = 'documentos/originales/contrato-cliente.txt';

test('el paquete sin tocar está al día: no hay nada que importar', async () => {
  const pkg = await exportPkg();
  assert.ok(pkg['portal-export.json'], 'el paquete del externo también lleva su marcador');
  const p = await preview(pkg); assert.equal(p.statusCode, 200, p.body);
  const j = p.json();
  assert.equal(j.upToDate, true, JSON.stringify(j.changes.map((c: any) => c.path)));
  assert.deepEqual(j.changes, []);
});

test('mejorado fuera (programa, habilidad y memoria): la vista previa muestra SOLO lo que cambió; aplicar lo escribe con copia previa; Restaurar lo deshace', async () => {
  const pkg = await exportPkg();
  const before = sourcesRepo(S).get(extId)!.revision;
  pkg['skills/convertir/scripts/convertir.py'] = pkg['skills/convertir/scripts/convertir.py']!.replace('ESCALA = 0.94', 'ESCALA = 0.92  # MEJORA-FUERA: ajusta mejor las tablas anchas');
  pkg['skills/convertir/SKILL.md'] = `${pkg['skills/convertir/SKILL.md']!.trimEnd()}\n\n## Aprendido fuera\n\nSi una tabla se desborda, baja la escala a 0.92.\n`;
  pkg['memoria/MEMORIA.md'] = `${pkg['memoria/MEMORIA.md']!.trimEnd()}\n- MEM-FUERA: las tablas anchas necesitan escala 0.92 (validado en tres documentos).\n`;
  pkg['skills/convertir/scripts/selfcheck.py'] = 'print("selfcheck ok")\n';
  const p = await preview(pkg); assert.equal(p.statusCode, 200, p.body);
  const j = p.json();
  assert.deepEqual(j.changes.map((c: any) => `${c.path}:${c.kind}`).sort(), ['memoria/MEMORIA.md:adopt', 'skills/convertir/SKILL.md:adopt', 'skills/convertir/scripts/convertir.py:adopt', 'skills/convertir/scripts/selfcheck.py:added']);
  assert.ok(j.changes.find((c: any) => c.path.endsWith('convertir.py')).script, 'los programas se señalan');
  assert.ok(j.warnings.some((x: string) => /programas/.test(x)), 'y se avisa de que podrán ejecutarse');
  assert.ok(!j.changes.some((c: any) => c.path === 'AGENTS.md' || c.path === 'contexto/contrato.md'), 'lo que no cambió fuera no aparece (aunque el paquete lo lleve limpio y con avisos)');
  // La vista previa no escribe nada.
  assert.equal(r('skills/convertir/scripts/convertir.py'), SCRIPT);
  const a = await apply(j.token); assert.equal(a.statusCode, 201, a.body);
  const res = a.json();
  assert.equal(res.previousRevision, before); assert.ok(res.revision > before);
  assert.match(r('skills/convertir/scripts/convertir.py'), /ESCALA = 0\.92 {2}# MEJORA-FUERA/);
  assert.match(r('skills/convertir/SKILL.md'), /baja la escala a 0\.92/);
  assert.match(r('memoria/MEMORIA.md'), /MEM-FUERA/); assert.match(r('memoria/MEMORIA.md'), /MEM-1/, 'lo que ya sabía se conserva');
  assert.equal(r('skills/convertir/scripts/selfcheck.py'), 'print("selfcheck ok")\n');
  assert.equal(r('AGENTS.md'), '# Conversor\n\nConvierto documentos con la habilidad convertir.\n', 'las instrucciones no cambiaron: ni avisos del paquete ni limpieza');
  assert.equal(r(DOC), 'DOCUMENTO DEL PROPIETARIO: no tocar.\n', 'los documentos del propietario no se tocan');
  assert.ok(res.backup && fs.existsSync(path.join(root, ...res.backup.split('/'), 'skills', 'convertir', 'scripts', 'convertir.py')), 'copia previa en la carpeta de respaldos del agente');
  assert.equal(fs.readFileSync(path.join(root, ...res.backup.split('/'), 'skills', 'convertir', 'scripts', 'convertir.py'), 'utf8'), SCRIPT);
  // El Portal usa ya lo adoptado (la capacidad sigue ahí, con lo aprendido).
  const st = (await app.inject({ method: 'GET', url: `${W}/agents/${extId}/source` })).json();
  assert.equal(st.revision, res.revision); assert.deepEqual(st.changes, [], 'carpeta y revisión adoptada coinciden');
  assert.ok(st.scripts.some((x: any) => x.path === 'skills/convertir/scripts/selfcheck.py'));
  // Deshacer: restaurar la revisión anterior devuelve el programa original.
  const back = await app.inject({ method: 'POST', url: `${W}/agents/${extId}/source/restore`, payload: { n: before, authorized: true } });
  assert.ok(back.statusCode < 300, back.body);
  assert.equal(r('skills/convertir/scripts/convertir.py'), SCRIPT);
  assert.equal(r(DOC), 'DOCUMENTO DEL PROPIETARIO: no tocar.\n');
});

test('cambió fuera Y en la carpeta desde la exportación: conflicto; sin elegir no se escribe nada; se puede conservar lo del Portal', async () => {
  const pkg = await exportPkg();
  // Cambio «en el Portal» tras exportar: se edita la carpeta y se adopta (lo que hace una mejora aprobada).
  w('contexto/contrato.md', '# Contrato de calidad\n\nEl texto debe quedar editable. VERSION-PORTAL: y sin imágenes de página completa.\n');
  const s1 = (await app.inject({ method: 'GET', url: `${W}/agents/${extId}/source` })).json();
  const ad = await app.inject({ method: 'POST', url: `${W}/agents/${extId}/source/adopt`, payload: { hash: s1.diskHash, authorized: true } });
  assert.ok(ad.statusCode < 300, ad.body);
  pkg['contexto/contrato.md'] = `${pkg['contexto/contrato.md']!.trimEnd()}\nVERSION-FUERA: revisar cada página.\n`;
  pkg['memoria/MEMORIA.md'] = `${pkg['memoria/MEMORIA.md']!.trimEnd()}\n- MEM-FUERA-2: revisar cada página.\n`;
  const j = (await preview(pkg)).json();
  assert.equal(j.changes.find((c: any) => c.path === 'contexto/contrato.md').kind, 'conflict');
  assert.equal(j.changes.find((c: any) => c.path === 'memoria/MEMORIA.md').kind, 'adopt');
  const no = await apply(j.token); assert.equal(no.statusCode, 409, no.body);
  assert.deepEqual(no.json().conflicts, ['contexto/contrato.md']);
  assert.doesNotMatch(r('memoria/MEMORIA.md'), /MEM-FUERA-2/, 'con un conflicto sin resolver no se escribe NADA');
  const ok = await apply(j.token, { 'contexto/contrato.md': 'portal' }); assert.equal(ok.statusCode, 201, ok.body);
  assert.match(r('contexto/contrato.md'), /VERSION-PORTAL/); assert.doesNotMatch(r('contexto/contrato.md'), /VERSION-FUERA/);
  assert.match(r('memoria/MEMORIA.md'), /MEM-FUERA-2/);
  assert.deepEqual(ok.json().kept, ['contexto/contrato.md']);
});

test('nunca escribe fuera de la identidad ni borra; rechaza el paquete de otro agente, sin marcador, con secretos o si la carpeta tiene cambios sin revisar', async () => {
  const pkg = await exportPkg();
  // Un paquete que intenta colar un documento y no trae un archivo de identidad.
  const sneaky = { ...pkg, [DOC]: 'PISADO\n', 'documentos/nuevo.txt': 'colado\n' };
  delete (sneaky as any)['contexto/contrato.md'];
  const p = await preview(sneaky);
  if (p.statusCode === 200) {
    const j = p.json();
    assert.ok(!j.changes.some((c: any) => c.path.startsWith('documentos/') || c.path.includes('..')), 'nada fuera de la identidad entra en los cambios');
    assert.ok(j.notRemoved.includes('contexto/contrato.md'), 'lo que el paquete no trae se conserva, y se dice');
    const a = await apply(j.token); assert.ok(a.statusCode === 201, a.body);
  } else assert.equal(p.statusCode, 400, p.body);
  assert.equal(r(DOC), 'DOCUMENTO DEL PROPIETARIO: no tocar.\n');
  assert.ok(!fs.existsSync(path.join(root, 'documentos', 'nuevo.txt'))); assert.ok(!fs.existsSync(path.join(base, 'fuera.txt')));
  assert.ok(fs.existsSync(path.join(root, 'contexto', 'contrato.md')), 'no se borra nada');

  const m = JSON.parse(pkg['portal-export.json']!);
  const other = await preview({ ...pkg, 'portal-export.json': JSON.stringify({ ...m, bundle: 'pa-000000000000000000000000' }) });
  assert.equal(other.statusCode, 400); assert.equal(other.json().code, 'other_agent');
  const { 'portal-export.json': _gone, ...noMarker } = pkg;
  const nm = await preview(noMarker); assert.equal(nm.statusCode, 400); assert.equal(nm.json().code, 'no_marker');
  const secret = 'sk-' + 'ant-api03-' + 'Z9y8X7w6'.repeat(6);
  const withSecret = await preview({ ...pkg, 'memoria/MEMORIA.md': `${pkg['memoria/MEMORIA.md']}\nclave: ${secret}\n` });
  assert.equal(withSecret.statusCode, 400); assert.match(withSecret.json().error, /credenciales/);
  // Cambio sin revisar en la carpeta: primero se revisa en Origen.
  w('AGENTS.md', '# Conversor\n\nEditado a mano sin revisar.\n');
  const dirty = await preview(pkg); assert.equal(dirty.statusCode, 409); assert.equal(dirty.json().code, 'unreviewed_changes');
  // Sin sesión del propietario no se puede aplicar (la política general lo exige para todo cambio).
  const { buildApp: plain } = await import('../src/app.ts');
  const bare = await plain();
  const denied = await bare.inject({ method: 'POST', url: `${W}/agents/${extId}/source/package/apply`, payload: { token: 'x'.repeat(16), resolutions: {}, authorized: true } });
  assert.ok(denied.statusCode === 401 || denied.statusCode === 403, `sin propietario: ${denied.statusCode}`);
  await bare.close();
});

test('el paquete es EJECUTABLE fuera: manifiesto, versiones fijadas, comprobacion de entorno y la herramienta de validacion del Portal', async () => {
  const pkg = await exportPkg();
  const m = JSON.parse(pkg['portable.json']!);
  assert.equal(m.schema, 'portal-ia/portable@1'); assert.equal(m.kind, 'external'); assert.equal(m.name, 'Conversor');
  assert.deepEqual(m.entrypoints.map((e: any) => e.script), ['skills/convertir/scripts/convertir.py'], 'el programa que cita su habilidad es el punto de entrada');
  assert.deepEqual(m.runtime.requirements.map((r: any) => `${r.name}==${r.version}:${r.import}`), ['python-docx==1.2.0:docx'], 'la version que el agente fija viaja fijada, con su nombre de importacion');
  assert.equal(m.runtime.python.minimum, '3.9');
  assert.deepEqual(m.permissions, { runScripts: true, writeDocuments: true });
  assert.equal(m.validation.tool, 'herramientas/doc_qa.py');
  assert.ok(pkg['herramientas/doc_qa.py']!.includes('Control de calidad honesto'), 'la misma comprobacion que usa el Portal');
  assert.match(pkg['herramientas/requirements.lock.txt']!, /^python-docx==1\.2\.0$/m);
  assert.ok(m.harnesses.some((h: any) => h.id === 'chat' && h.runsScripts === false), 'dice donde NO puede ejecutar sus programas');
  assert.match(pkg['GUIA.md']!, /python herramientas\/selfcheck\.py/);
  for (const text of Object.values(pkg)) { assert.ok(!text.includes(extId), 'sin el id interno'); assert.ok(!text.includes(root), 'sin la ruta de su carpeta'); }
  assert.doesNotMatch(pkg['portable.json']!, /[A-Za-z]:\\|\/Users\/|\/home\//, 'el manifiesto no lleva rutas del equipo');
  // La comprobacion de entorno se ejecuta de verdad en un directorio limpio (solo Python estandar).
  const { execFileSync } = await import('node:child_process');
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3ext-clean-'));
  for (const [rel, text] of Object.entries(pkg)) { const f = path.join(clean, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  let py: string | null = null;
  for (const c of ['python', 'python3', 'py']) { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); py = c; break; } catch { /* siguiente */ } }
  if (!py) return; // sin Python en este equipo no se puede ejecutar; el resto ya quedo comprobado
  let out = ''; let code = 0;
  try { out = execFileSync(py, ['-I', path.join(clean, 'herramientas', 'selfcheck.py'), '--json'], { cwd: clean, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }); } catch (e: any) { code = e.status ?? 1; out = String(e.stdout ?? ''); }
  const res = JSON.parse(out);
  assert.equal(typeof res.ok, 'boolean'); assert.equal(code, res.ok ? 0 : 1, 'el codigo de salida dice si el entorno sirve');
  assert.deepEqual(res.comprobaciones.map((c: any) => c.que).filter((q: string) => q !== 'Ruta de la carpeta'), ['Python', 'python-docx'], 'comprueba lo que declara el manifiesto');
  const docx = res.comprobaciones.find((c: any) => c.que === 'python-docx');
  if (!docx.ok) assert.match(docx.nota, /pip install -r herramientas\/requirements\.lock\.txt/, 'si falta algo dice como conseguirlo');
  fs.rmSync(clean, { recursive: true, force: true });
});

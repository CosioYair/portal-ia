import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// HU-211 · Edición distribuible generada desde un árbol limpio. node --test ejecuta cada archivo en su propio proceso: la
// edición y la carpeta de datos se fijan antes de cargar config.ts (por eso los módulos se importan de forma dinámica).
process.env.PORTAL_EDITION = 'distributable';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-hu211-data-'));
process.env.PORTAL_DATA_DIR = DATA_DIR;

const D = await import('@portal-ia/domain');
const cfg = await import('../src/config.ts');
const { assertCleanTree, buildEditionZip, EDITION_LAUNCHER } = await import('../src/services/editionBundle.ts');
const { listZip, readZipEntry } = await import('../src/services/zipFile.ts');
const { createBudgetHierarchy, BudgetHierarchyError, currentPeriod } = await import('../src/services/budget-hierarchy.ts');

/** Raíz del repositorio: tres niveles por encima de apps/server/test. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-hu211-'));
after(() => { for (const d of [TMP, DATA_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temporal */ } } });

/** Build compilado de prueba: index.html, assets/app.js y build-info.json con el commit indicado. */
function fakeDist(name: string, commit: string): string {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="./assets/app.js"></script></body></html>\n');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("Portal IA");\n');
  fs.writeFileSync(path.join(dir, 'build-info.json'), `${JSON.stringify({ commit, builtAt: '2026-01-01T00:00:00Z' })}\n`);
  return dir;
}
const outDir = path.join(TMP, 'ediciones');

test('(a) assertCleanTree: árbol limpio pasa; con cambios sin confirmar lista las rutas', () => {
  assert.doesNotThrow(() => assertCleanTree(''));
  assert.doesNotThrow(() => assertCleanTree('\n'));
  assert.throws(
    () => assertCleanTree(' M apps/server/src/config.ts\n?? nuevo.ts\n'),
    (e: any) => e.statusCode === 409 && e.message.includes('apps/server/src/config.ts') && e.message.includes('nuevo.ts') && /confirmar o descartar/.test(e.message)
  );
});

test('(b) el ZIP lleva build y lanzador, excluye data/, .env, .git y datos, y pasa findSecret y validatePortableBundle', async () => {
  const webDist = fakeDist('dist-ok', 'a'.repeat(40));
  const outFile = path.join(outDir, 'edicion-ok.zip');
  const res = await buildEditionZip({ root: ROOT, webDist, dataDir: DATA_DIR, outFile, expectedCommit: 'a'.repeat(40) });
  assert.ok(fs.existsSync(outFile));
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  const l = listZip(outFile, { maxEntries: 6000, maxEntryBytes: 4 * 1024 * 1024, maxRatio: 100000 });
  const names = l.entries.map(e => e.name);
  assert.equal(res.entries, names.length);
  for (const f of ['apps/web/dist/index.html', 'apps/web/dist/assets/app.js', EDITION_LAUNCHER, 'package.json', 'apps/server/src/index.ts'])
    assert.ok(names.includes(f), `falta ${f}`);
  const bad = names.filter(n =>
    /^data(\/|$)/.test(n) || /(^|\/)\.git(\/|$)/.test(n) || /(^|\/)node_modules(\/|$)/.test(n) ||
    (/(^|\/)\.env[^/]*$/.test(n) && !/(^|\/)\.env\.example$/.test(n)) || /\.sqlite/i.test(n) || /(^|\/)\.?master\.key$/.test(n) ||
    /^apps\/server\/test(\/|$)/.test(n) || n === 'scripts/preview-runner.mjs');
  assert.deepEqual(bad, [], `entradas prohibidas en la Edición: ${bad.join(', ')}`);
  const texts: Record<string, string> = {};
  const flagged: string[] = [];
  for (const e of l.entries) {
    if (e.isDir) continue;
    assert.equal(e.problem, null, `${e.name}: ${e.problem}`);
    const buf = readZipEntry(outFile, e);
    if (buf.subarray(0, 8192).includes(0)) continue;
    const c = buf.toString('utf8');
    const s = D.findSecret(c);
    if (s) flagged.push(`${e.name}: ${s}`);
    texts[e.name] = c;
  }
  assert.deepEqual(flagged, [], `posibles secretos en el ZIP:\n${flagged.join('\n')}`);
  const problems = D.validatePortableBundle(texts, {
    profile: 'edition', limits: D.EDITION_BUNDLE_LIMITS,
    privatePaths: [{ path: ROOT, kind: 'source' }, { path: DATA_DIR, kind: 'portal-data' }]
  });
  assert.deepEqual(problems, []);
  // Nunca sobrescribe.
  await assert.rejects(buildEditionZip({ root: ROOT, webDist, dataDir: DATA_DIR, outFile }), /no se sobrescribe/);
});

test('(c) un secreto inyectado aborta sin dejar ZIP y el mensaje no repite el valor', async () => {
  const root = path.join(TMP, 'raiz-secreto');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps', 'server', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "portal-ia", "private": true }\n');
  fs.copyFileSync(path.join(ROOT, EDITION_LAUNCHER), path.join(root, EDITION_LAUNCHER));
  // Construido al ejecutarse: escrito tal cual, el puente del Portal omitiría este archivo.
  const SECRET = 'sk-' + 'ant-api03-' + 'A1b2C3d4'.repeat(6);
  fs.writeFileSync(path.join(root, 'apps', 'server', 'src', 'fuga.ts'), `export const k = '${SECRET}';\n`);
  const outFile = path.join(outDir, 'edicion-secreto.zip');
  await assert.rejects(
    buildEditionZip({ root, webDist: fakeDist('dist-secreto', 'b'.repeat(40)), dataDir: DATA_DIR, outFile }),
    (e: any) => e.statusCode === 409 && e.message.includes('apps/server/src/fuga.ts') && !e.message.includes(SECRET)
  );
  assert.equal(fs.existsSync(outFile), false, 'no queda ZIP parcial');
});

test('(d) un build de otro commit o una salida dentro del repositorio abortan sin dejar ZIP', async () => {
  const outFile = path.join(outDir, 'edicion-desfasada.zip');
  await assert.rejects(
    buildEditionZip({ root: ROOT, webDist: fakeDist('dist-viejo', 'c'.repeat(40)), dataDir: DATA_DIR, outFile, expectedCommit: 'd'.repeat(40) }),
    (e: any) => e.statusCode === 409 && /HEAD/.test(e.message) && /npm run build/.test(e.message)
  );
  assert.equal(fs.existsSync(outFile), false, 'no queda ZIP parcial');
  const inside = path.join(ROOT, 'edicion-dentro.zip');
  await assert.rejects(
    buildEditionZip({ root: ROOT, webDist: fakeDist('dist-dentro', 'e'.repeat(40)), dataDir: DATA_DIR, outFile: inside }),
    (e: any) => e.statusCode === 400
  );
  assert.equal(fs.existsSync(inside), false);
});

test('(e) compatibilidad: sin profile, validatePortableBundle se comporta como antes (perfil de agente)', () => {
  const empty = D.validatePortableBundle({});
  for (const r of ['agent.yaml', 'AGENTS.md', 'memory/MEMORY.md']) assert.ok(empty.some(p => p.path === r && /Falta/.test(p.message)), `debe faltar ${r}`);
  assert.deepEqual(D.validatePortableBundle({}, { profile: 'agent' }), empty, 'el perfil «agent» es el de por defecto');
  assert.deepEqual(D.validatePortableBundle({}, { profile: 'edition' }), [], 'la Edición no exige archivos de agente');
  const code = { 'apps/server/src/rutas.ts': "export const url = '/api/workspaces/x/agents';\n" };
  assert.ok(D.validatePortableBundle(code).some(p => p.path === 'apps/server/src/rutas.ts'), 'el perfil de agente rechaza código y rutas /api/');
  assert.deepEqual(D.validatePortableBundle(code, { profile: 'edition', limits: D.EDITION_BUNDLE_LIMITS }), []);
  // Raíz de un solo nivel (la del sandbox, «/work/»): el código cita «/work/node_modules» como destino de montaje y no es una fuga.
  const mount = { 'apps/server/src/services/sandbox.ts': "const deps = { type: 'volume', target: '/work/node_modules' };\n" };
  assert.deepEqual(D.validatePortableBundle(mount, { profile: 'edition', limits: D.EDITION_BUNDLE_LIMITS, privatePaths: [{ path: '/work/', kind: 'source' }] }), []);
  // Control: una raíz real de dos o más niveles sigue bloqueando.
  const leak = { 'apps/server/src/fuga.ts': "export const p = '/srv/portal-estudio/apps/x.ts';\n" };
  assert.ok(D.validatePortableBundle(leak, { profile: 'edition', limits: D.EDITION_BUNDLE_LIMITS, privatePaths: [{ path: '/srv/portal-estudio', kind: 'source' }] }).some(p => p.path === 'apps/server/src/fuga.ts'));
  const bundle = D.buildPortableBundle({ 'agent.yaml': 'name: Agente\nrole: Pruebas\n', 'AGENTS.md': '# Agente\n\nHago pruebas.\n' }, { agentName: 'Agente', exportedAt: '2026-01-01T00:00:00Z' });
  assert.deepEqual(D.validatePortableBundle(bundle, { profile: 'agent' }), D.validatePortableBundle(bundle));
});

test('(f) la Edición arranca vacía y con presupuesto 0 (sin presupuesto definido)', () => {
  assert.equal(cfg.SELF_IMPROVEMENT_ENABLED, false);
  const wsDir = path.join(DATA_DIR, 'workspaces');
  const spaces = fs.existsSync(wsDir) ? fs.readdirSync(wsDir) : [];
  assert.deepEqual(spaces, [], 'no hay espacios ni empresas en una carpeta de datos nueva');
  const dbDir = fs.mkdtempSync(path.join(TMP, 'espacio-'));
  const db = new DatabaseSync(path.join(dbDir, 'presupuesto.sqlite'));
  try {
    const h = createBudgetHierarchy(db, 'empresa-nueva');
    const now = new Date();
    const bal = h.getBalance('company', 'empresa-nueva', currentPeriod(now));
    assert.equal(bal.configured, false);
    assert.equal(bal.limitMicros, 0);
    assert.throws(() => h.reserveForProcess('proc-1', 'p1', 0, now), (e: unknown) => e instanceof BudgetHierarchyError && e.reason === 'no_limit');
  } finally { db.close(); }
});

test('el lanzador impone la edición distribuible y no instala nada', () => {
  const src = fs.readFileSync(path.join(ROOT, EDITION_LAUNCHER), 'utf8');
  assert.match(src, /process\.env\.PORTAL_EDITION = 'distributable';/);
  assert.match(src, /npm ci/);
  assert.ok(!/spawn[^\n]*['"]npm['"]/.test(src), 'no ejecuta npm');
});

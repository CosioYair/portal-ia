import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-206 · Ninguna edición lleva credenciales. node --test ejecuta cada archivo en su propio proceso: la edición se fija
// antes de cargar config.ts (por eso los módulos del servidor se importan de forma dinámica, después de estas líneas).
process.env.PORTAL_EDITION = 'distributable';
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-hu206-'));

const { findSecret } = await import('@portal-ia/domain');
const { listPackageFiles, packageExclusion } = await import('../src/services/packageTree.ts');
const cfg = await import('../src/config.ts');
const { startPreview } = await import('../src/services/preview.ts');

/** Raíz del repositorio: tres niveles por encima de apps/server/test; se comprueba para no dar un «0 archivos» silencioso. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const rootOk = fs.existsSync(path.join(ROOT, 'package.json')) && fs.existsSync(path.join(ROOT, 'apps', 'server'));
const files = rootOk ? listPackageFiles(ROOT) : [];

test('la raíz calculada es la del repositorio', () => {
  assert.ok(rootOk, `la raíz calculada (${ROOT}) no contiene package.json y apps/server`);
});

test('el árbol a empaquetar incluye el código del servidor, la web y los paquetes', () => {
  assert.ok(files.length > 50, `se esperaban más de 50 archivos y hay ${files.length}`);
  for (const f of ['package.json', 'apps/server/src/app.ts', 'packages/domain/src/portable-agent.ts']) assert.ok(files.includes(f), `falta ${f}`);
  assert.ok(files.some(f => f.startsWith('apps/web/src/')), 'falta el código de la web');
  assert.ok(files.every(f => !f.includes('\\')), 'las rutas van con «/»');
  assert.deepEqual(files, [...files].sort(), 'la lista va ordenada');
});

test('las pruebas y preview-runner.mjs quedan fuera del paquete', () => {
  const tests = files.filter(f => f.startsWith('apps/server/test/'));
  assert.deepEqual(tests, [], `hay pruebas en el paquete: ${tests.slice(0, 5).join(', ')}`);
  assert.ok(!files.includes('scripts/preview-runner.mjs'), 'scripts/preview-runner.mjs no debe empaquetarse');
  assert.ok(packageExclusion('scripts/preview-runner.mjs'));
  assert.ok(packageExclusion('apps/server/test/core.test.ts'));
  assert.ok(packageExclusion('apps/server/test/e2e/self-improvement.e2e.mjs'));
  assert.ok(packageExclusion('apps/web/dist/index.html'));
  assert.equal(packageExclusion('.env.example'), null, '.env.example sí se distribuye');
  assert.ok(packageExclusion('.env'), '.env nunca se distribuye');
  const generated = files.filter(f => /(^|\/)(node_modules|\.git)\//.test(f) || /^apps\/web\/dist/.test(f) || /^data\//.test(f));
  assert.deepEqual(generated, []);
});

test('findSecret no marca nada en el árbol a empaquetar', () => {
  assert.ok(files.length > 0, 'el árbol a empaquetar está vacío');
  // El mensaje lista la ruta y el tipo de secreto, nunca el valor.
  const flagged: string[] = [];
  for (const rel of files) {
    const what = findSecret(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    if (what) flagged.push(`${rel}: ${what}`);
  }
  assert.deepEqual(flagged, [], `archivos con posibles secretos en el árbol a empaquetar:\n${flagged.join('\n')}`);
});

test('control: findSecret sí detecta una clave construida sin literales', () => {
  const sample = ['sk', 'ant', 'x'.repeat(24)].join('-');
  assert.ok(findSecret(sample), 'el detector debe marcar una clave con forma real');
  assert.equal(findSecret('texto sin credenciales'), null);
});

test('la vista previa de candidatos responde 403 en la edición distribuible (sin copiar el runner)', async () => {
  assert.equal(cfg.SELF_IMPROVEMENT_ENABLED, false);
  await assert.rejects(
    startPreview('no-existe', 'no-existe'),
    (e: any) => e.statusCode === 403 && e.code === 'edition_distributable'
  );
});

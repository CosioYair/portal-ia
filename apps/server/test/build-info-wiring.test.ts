import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultChecks, matches } from '../src/services/runtimeChecks.ts';

// HU-163 (iteración 3): toda compilación de Vite deja build-info.json con el commit, para que /api/system/status
// devuelva buildCommit y pase la comprobación en ejecución por defecto. Lectura estática: sin IA, red ni git.
const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('vite.config.ts registra un plugin de build que escribe build-info.json en el outDir', () => {
  const vc = read('../../web/vite.config.ts');
  assert.match(vc, /function portalBuildInfo\(\): Plugin/);
  assert.match(vc, /plugins: \[[^\]]*portalBuildInfo\(\)[^\]]*\]/, 'el plugin debe estar registrado en plugins');
  const start = vc.indexOf('function portalBuildInfo');
  const plugin = vc.slice(start, vc.indexOf('export default', start));
  assert.match(plugin, /apply: 'build'/);
  assert.match(plugin, /closeBundle\(\)/);
  assert.match(plugin, /config\.build\.outDir/, 'debe usar el outDir resuelto (también --outDir dist.next)');
  assert.ok(plugin.includes("'build-info.json'"), 'debe escribir build-info.json');
  assert.match(plugin, /\{ commit: headCommit\(\), builtAt: new Date\(\)\.toISOString\(\), version: rootVersion\(\) \}/);
});

test('git va en try/catch, valida el hash y degrada a null sin romper el build', () => {
  const vc = read('../../web/vite.config.ts');
  const fn = vc.slice(vc.indexOf('function headCommit'), vc.indexOf('function rootVersion'));
  assert.match(fn, /try \{/);
  assert.match(fn, /execFileSync\('git', \['rev-parse', '--short', 'HEAD'\]/);
  assert.ok(!/shell:\s*true/.test(fn), 'git no debe lanzarse con shell');
  assert.match(fn, /\/\^\[0-9a-f\]\{7,40\}\$\/\.test\(out\) \? out : null/);
  assert.match(fn, /catch \{\s*return null;\s*\}/);
});

test('buildInfo() lee commit y builtAt de build-info.json', () => {
  const sys = read('../src/services/system.ts');
  assert.ok(sys.includes("'build-info.json'"));
  assert.match(sys, /buildCommit: j\.commit \?\? null, buildAt: j\.builtAt \?\? null/);
});

test('la comprobación por defecto de /api/system/status distingue un hash de null', () => {
  const check = defaultChecks().find(c => c.path === '/api/system/status');
  assert.ok(check, 'falta la comprobación por defecto de /api/system/status');
  assert.equal(check.kind, 'http');
  assert.ok(matches('{"version":"0.12.1","buildCommit":"d60891b","buildAt":"2026-10-30T04:34:38.306Z"}', check.expect), 'un hash corto debe pasar');
  assert.ok(matches('{"buildCommit":"9bcf6381a2"}', check.expect), 'un hash más largo debe pasar');
  assert.ok(!matches('{"version":"0.12.1","buildCommit":null,"buildAt":"2026-10-30T04:34:38.306Z"}', check.expect), 'null no debe pasar');
  assert.ok(!matches('{"buildCommit":"d6089"}', check.expect), 'menos de 7 caracteres no debe pasar');
  assert.ok(!matches('{"buildCommit":"zzzzzzz"}', check.expect), 'un valor no hexadecimal no debe pasar');
});

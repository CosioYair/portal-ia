import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * H · Pruebas canceladas ≠ fallos de la implementación (caso HU-159). La evidencia real: el `before` de la suite
 * «rutas y flujo…» falla con un TypeError de SQLite en el helper de la prueba y node --test cancela sus 8 pruebas
 * («test did not finish before its parent and was cancelled», failureType cancelledByParent, 0 ms). Antes, el
 * diagnóstico tomaba las 8 canceladas como fallos, el recorte de la salida perdía el error de la suite y el equipo
 * gastaba correcciones sin ver la causa. Sin IA.
 */
const { failingTests, testRunSummary, diagnoseFailure } = await import('../src/services/failureDiagnosis.ts');
const { failureBlocks, clipSandboxOutput } = await import('../src/services/sandbox.ts');
const { verificationIssue } = await import('../src/services/storyFlow.ts');

const cancelled = (n: number, name: string) => `    # Subtest: ${name}
    not ok ${n} - ${name}
      ---
      duration_ms: 0
      type: 'test'
      location: '/work/apps/server/test/org-evaluation.test.ts:1:${13000 + n}'
      failureType: 'cancelledByParent'
      error: 'test did not finish before its parent and was cancelled'
      code: 'ERR_TEST_FAILURE'
      ...`;
const NAMES = ['sin autorización: 400', 'ámbito proyecto sin projectId: 400', 'presupuesto menor que el estimado', 'ámbito proyecto: 2 llamadas', 'decisiones individuales', 'ámbito empresa: 1 sola llamada', 'espacio recién creado', 'presupuesto insuficiente'];
const SUITE_HOOK = `not ok 4 - rutas y flujo con proveedor simulado (datos temporales)
  ---
  duration_ms: 290.526407
  type: 'suite'
  location: '/work/apps/server/test/org-evaluation.test.ts:1:11404'
  failureType: 'hookFailed'
  error: 'Provided value cannot be bound to SQLite parameter 2.'
  code: 'ERR_INVALID_ARG_TYPE'
  name: 'TypeError'
  stack: |-
    Object.create (/work/apps/server/src/db/workspace.ts:113:107)
    callFirst (/work/apps/server/test/org-evaluation.test.ts:168:79)
    seedWorkspace (/work/apps/server/test/org-evaluation.test.ts:192:19)
    async SuiteContext.<anonymous> (/work/apps/server/test/org-evaluation.test.ts:235:22)
    async TestHook.run (node:internal/test_runner/test:1054:7)
  ...`;
const TOTALS = '# tests 19\n# suites 4\n# pass 11\n# fail 0\n# cancelled 8\n# skipped 0';
const FULL = `TAP version 13\n# Subtest: rutas y flujo con proveedor simulado (datos temporales)\n${NAMES.map((n, i) => cancelled(i + 1, n)).join('\n')}\n    1..8\n${SUITE_HOOK}\n1..4\n${TOTALS}\n`;
// Lo que quedó guardado en HU-159: el bloque de la suite recortado (sin su error) y los totales.
const CLIPPED = `TAP version 13\n${NAMES.map((n, i) => cancelled(i + 1, n)).join('\n')}\n    1..8\nnot ok 198 - rutas y flujo con proveedor simulado (datos temporales)\n  ---\n  duration_ms: 167.37421\n  type: 'suite'\n  location: '/work/apps/server/test/org-evaluation.test.ts:1:11404'\n\n[…]\n\n${TOTALS}\n`;
const run = (output: string) => ({ command: 'test' as const, exitCode: 1, output, startedAt: '', finishedAt: '', durationMs: 1, isolation: 'docker' as const });

test('la causa (preparación de la suite) va primero, con su error y su pila; las 8 canceladas no cuentan como fallos', () => {
  const f = failingTests(run(FULL));
  assert.equal(f.length, 1, 'solo la causa');
  assert.equal(f[0].kind, 'hook');
  assert.match(f[0].name, /rutas y flujo.*preparación de la suite: before\/after/);
  assert.match(f[0].message, /Provided value cannot be bound to SQLite parameter 2/);
  assert.match(f[0].message, /seedWorkspace \(apps\/server\/test\/org-evaluation\.test\.ts:192\)/);
  assert.match(f[0].message, /Object\.create \(apps\/server\/src\/db\/workspace\.ts:113\)/);
  const s = testRunSummary(run(FULL));
  assert.deepEqual([s.failed, s.cancelled, s.onlyCancellations], [0, 8, false]);
  const d = diagnoseFailure({ root: null, run: run(FULL) as any, previous: [], storyCreated: [], planned: [], unitFiles: [] });
  assert.ok(d.kinds.some(k => k.kind === 'test_setup')); assert.ok(!d.kinds.some(k => k.kind === 'implementation'), 'no es un defecto de la implementación');
});

test('evidencia recortada sin la causa: «solo canceladas» (no fallos), diagnóstico de ejecutor de pruebas, nunca de implementación', () => {
  const s = testRunSummary(run(CLIPPED));
  assert.equal(s.onlyCancellations, true); assert.equal(s.cancelled, 8); assert.equal(s.failed, 0);
  const f = failingTests(run(CLIPPED));
  assert.ok(f.every(x => x.kind === 'cancelled'), 'la suite sin error propio no se toma como causa');
  const d = diagnoseFailure({ root: null, run: run(CLIPPED) as any, previous: [], storyCreated: [], planned: [], unitFiles: [] });
  assert.ok(d.kinds.some(k => k.kind === 'test_runner')); assert.ok(!d.kinds.some(k => k.kind === 'implementation'));
});

test('el recorte de la salida conserva el error de la suite (antes lo cortaba el tope) y resume las canceladas en una línea', () => {
  const blocks = failureBlocks(FULL);
  assert.match(blocks, /failureType: 'hookFailed'/); assert.match(blocks, /seedWorkspace/);
  assert.match(blocks, /8 prueba\(s\) canceladas por su suite, sin ejecutarse \(no son fallos propios\)/);
  assert.ok(!/cancelledByParent/.test(blocks), 'las canceladas no ocupan el espacio de las causas');
  // Con una batería enorme alrededor, el bloque de la suite sobrevive al recorte
  const big = `${'ok 1 - relleno\n'.repeat(3000)}${FULL}${'ok 2 - relleno\n'.repeat(3000)}`;
  assert.match(clipSandboxOutput(big), /Provided value cannot be bound to SQLite parameter 2/);
});

test('el recorrido de la historia no presenta cancelaciones como «fallan las pruebas» de la implementación', () => {
  const a = verificationIssue(run(CLIPPED), ['Desarrollador']);
  assert.match(a.title, /Pruebas canceladas sin un fallo propio \(8\): no es un error de la implementación/); assert.equal(a.cause, 'environment');
  const b = verificationIssue(run(FULL), ['Desarrollador']);
  assert.match(b.title, /Falla la preparación de la prueba \(1\); 8 prueba\(s\) canceladas sin ejecutarse/); assert.match(b.details[0].text, /SQLite parameter 2/);
  assert.deepEqual(b.files, ['apps/server/test/org-evaluation.test.ts']);
});

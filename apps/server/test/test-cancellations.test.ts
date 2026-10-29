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

test('evidencia REAL de HU-159: bloques de canceladas cortados tras «location:» (sin failureType ni error) no cuentan como fallos', () => {
  // Así quedó guardado: el recorte antiguo dejaba «…» a mitad del bloque de algunas canceladas.
  const cut = (n: number, name: string) => `    # Subtest: ${name}\n    not ok ${n} - ${name}\n      ---\n      duration_ms: 0\n      type: 'test'\n      location: '/work/apps/server/test/org-evaluation.test.ts:1:${14000 + n}'\n…`;
  const REAL = `TAP version 13\n${cancelled(1, NAMES[0])}\n${cancelled(2, NAMES[1])}\n${cut(3, NAMES[2])}\n${cancelled(4, NAMES[3])}\n${cancelled(5, NAMES[4])}\n${cut(6, NAMES[5])}\n${cancelled(7, NAMES[6])}\n${cancelled(8, NAMES[7])}\n    1..8\nnot ok 198 - rutas y flujo con proveedor simulado (datos temporales)\n  ---\n  duration_ms: 167.37421\n  type: 'suite'\n  location: '/work/apps/server/test/org-evaluation.test.ts:1:11404'\n\n[…]\n\n${TOTALS}\n`;
  const s = testRunSummary(run(REAL));
  assert.deepEqual(s.causes, [], 'un bloque recortado no es la prueba de un fallo'); assert.equal(s.onlyCancellations, true); assert.equal(s.cancelled, 8);
  assert.ok(failingTests(run(REAL)).every(x => x.kind === 'cancelled'));
  // Otros productores de TAP (sin failureType): un «not ok» sin bloque sigue contando como fallo.
  assert.equal(failingTests({ command: 'test', output: 'TAP version 13\nnot ok 1 - suma\n  ---\n  operator: equal\n  ...\n# fail 1' })[0]?.kind, 'assertion');
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

// ---------------------------------------------------------------- HU-159 · iteración 3 (bloqueo por turnos agotados)

// Salida REAL de «test» en 4e31b6b: active-agents.test.ts falla al cargarse (runBootstrap sin proveedor) y ninguna de sus
// pruebas llega a ejecutarse. Antes la fila del archivo se ignoraba y el fallo no tenía causa.
const LOAD = `TAP version 13
# /work/apps/server/src/routes/bootstrap.ts:25
#   if (!connected.length) throw Object.assign(new Error('Conecta y verifica un proveedor de IA antes de inicializar el espacio interno.'), { statusCode: 409 });
#                                              ^
# Error: Conecta y verifica un proveedor de IA antes de inicializar el espacio interno.
#     at runBootstrap (/work/apps/server/src/routes/bootstrap.ts:25:46)
#     at <anonymous> (/work/apps/server/test/active-agents.test.ts:25:1) {
#   statusCode: 409
# }
# Node.js v22.23.4
# Subtest: test/active-agents.test.ts
not ok 1 - test/active-agents.test.ts
  ---
  duration_ms: 1368.671163
  type: 'test'
  location: '/work/apps/server/test/active-agents.test.ts:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: A · otra prueba
ok 2 - A · otra prueba
  ---
  duration_ms: 5.3
  type: 'test'
  ...
# tests 314
# pass 304
# fail 1
# cancelled 0`;

test('un archivo de prueba que falla AL CARGARSE es una causa con su error y su pila (antes: fallo sin causa)', () => {
  const f = failingTests(run(LOAD));
  assert.equal(f.length, 1); assert.equal(f[0].kind, 'load');
  assert.match(f[0].name, /test\/active-agents\.test\.ts \(el archivo falla al cargarse/);
  assert.match(f[0].message, /Error: Conecta y verifica un proveedor de IA/); assert.match(f[0].message, /apps\/server\/src\/routes\/bootstrap\.ts:25/);
  assert.equal(f[0].file, 'apps/server/test/active-agents.test.ts'); assert.equal(f[0].line, 25);
  const s = testRunSummary(run(LOAD));
  assert.equal(s.onlyCancellations, false); assert.equal(s.causes.length, 1);
  // Un archivo cuyas pruebas fallan (subtestsFailed) sigue sin ser una causa: lo son sus pruebas.
  assert.equal(failingTests(run("TAP version 13\nnot ok 1 - test/x.test.ts\n  ---\n  failureType: 'subtestsFailed'\n  error: '1 subtest failed'\n  ...")).filter(x => x.kind === 'load').length, 0);
});

test('una corrección pendiente cuyos archivos ya cambió otra de su ronda es obsoleta (HU-159 «Corrección 2.2»): se sustituye sin IA', async () => {
  const { staleCorrectionUnits } = await import('../src/services/failureDiagnosis.ts');
  const unit = (id: string, status: string, files: string[], applied: string[] = [], finding = 'test falla: línea 179: falla «f · fusionar»') => ({ id, kind: 'correction', source: 'verification', status, attempts: status === 'done' ? 1 : 0, round: 1, files, applied, findings: [{ severity: 'alta', text: finding, file: files[0], evidence: null }] });
  const base = { applied: { commit: 'c1', branch: 'b', files: [], appliedAt: '' }, verifications: [{ command: 'test', exitCode: 1, output: "not ok 1 - f\n  ---\n  failureType: 'testCodeFailure'\n  error: 'x'\n  ...", startedAt: '', finishedAt: '', durationMs: 1 }] };
  const r = (units: any[]) => ({ ...base, manifest: { units, deliverables: [], rounds: [] } }) as any;
  // r2-1 aplicó org-proposal-apply.test.ts (el archivo de r2-2): r2-2 ya no vale.
  const hu159 = r([unit('r2-1', 'done', ['apps/server/test/org-evaluation.test.ts'], ['apps/server/src/services/orgProposalApply.ts', 'apps/server/test/org-proposal-apply.test.ts']), unit('r2-2', 'pending', ['apps/server/test/org-proposal-apply.test.ts'])]);
  assert.deepEqual(staleCorrectionUnits(hu159), [{ id: 'r2-2', reason: 'overlap', files: ['apps/server/test/org-proposal-apply.test.ts'] }]);
  // Archivos distintos: la evidencia sigue valiendo y la corrección se ejecuta.
  assert.deepEqual(staleCorrectionUnits(r([unit('r2-1', 'done', ['a.ts'], ['a.ts']), unit('r2-2', 'pending', ['b.ts'])])), []);
  // Con un intento ya hecho no se sustituye (no se tira trabajo pagado).
  const tried = r([unit('r2-1', 'done', ['a.ts'], ['b.ts']), { ...unit('r2-2', 'pending', ['b.ts']), attempts: 1 }]);
  assert.deepEqual(staleCorrectionUnits(tried), []);
});

test('HU-159 tal como está guardada (provider_error «máximo de turnos» + Corrección 2.2 obsoleta): se presenta como turnos agotados y la acción vuelve a verificar sin IA, nunca «repetir la llamada»', async () => {
  const { buildStoryFlow } = await import('../src/services/storyFlow.ts');
  const t = new Date().toISOString();
  const unit = (id: string, status: string, files: string[], applied: string[] = []) => ({ id, kind: 'correction', title: id, source: 'verification', status, attempts: status === 'done' ? 1 : 0, round: 1, files, applied, findings: [{ severity: 'alta', text: 'test falla: línea 179', file: files[0], evidence: null }], agentName: 'Dev', stepIds: [] });
  const p: any = { id: 'p', projectId: 'x', kind: 'story_execution', title: 'HU-159', status: 'done', budgetUsd: 16, estimatedUsd: 1, spentUsd: 0, inputTokens: 0, outputTokens: 0, createdAt: t, authorizedAt: t, startedAt: t, finishedAt: t, error: null, steps: [], backlogItemId: 'i',
    result: { plan: null, implementationSummary: 'x', changes: [{ path: 'a.ts', action: 'modify', content: '', diff: '', before: 1, after: 1 }], verifyCommands: [], review: null, applied: { branch: 'portal-ia/hu-159', commit: '4e31b6b', files: ['a.ts'], appliedAt: t, worktree: '/wt' },
      verifications: [{ command: 'test', exitCode: 1, output: "not ok 1 - f\n  ---\n  failureType: 'testCodeFailure'\n  error: 'x'\n  ...", startedAt: t, finishedAt: t, durationMs: 1, isolation: 'docker' }],
      manifest: { units: [unit('r2-1', 'done', ['org-evaluation.test.ts'], ['org-proposal-apply.test.ts']), unit('r2-2', 'pending', ['org-proposal-apply.test.ts'])], deliverables: [], rounds: [] },
      pipeline: { config: { autoApply: true, autoVerify: true, commands: ['typecheck', 'test', 'build'], maxCorrections: 5, maxOutputRepairs: 1, maxIdenticalFailures: 3, maxDurationMin: 120, maxConsultations: 2, maxProviderRetries: 2 }, state: 'paused', phase: 'finished', pauseKind: 'provider_error', failureClass: 'PROVIDER_CONNECTION_ERROR', reason: 'No se pudo completar la llamada al proveedor tras los reintentos permitidos: Claude Code alcanzó el máximo de turnos autorizado (9) sin terminar la respuesta. Lo hecho se conserva; «Continuar» la repite.', events: [], outputRepairs: 0, corrections: 1, failures: [], lastAssessment: null, lastQaCommit: null, startedAt: t, finishedAt: t } } };
  const f = buildStoryFlow(p, { isPortalRepo: true, sandbox: 'docker' });
  assert.match(f.issue!.title, /Claude Code agotó sus turnos sin terminar \(no es un error de conexión\)/);
  assert.ok(!f.actions.some(a => /Repetir la llamada/.test(a.label)), 'nunca se ofrece repetir el mismo encargo');
  assert.equal(f.actions[0].label, 'Volver a verificar sin IA y corregir solo lo que falle'); assert.match(f.actions[0].description, /otra de su ronda ya cambió org-proposal-apply\.test\.ts/);
});

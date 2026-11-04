import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

/**
 * Correcciones basadas en evidencia y aprendizaje verificable (intervención «autonomía real», a partir de HU-177).
 *  - LÍNEA BASE: cuando «test» falla, se ejecuta el MISMO «test» sobre la base de la historia; lo que ya fallaba sin ella
 *    (mismo error) no se le cobra ni gasta correcciones; lo que pasa en la base y falla con ella es suyo, con esa prueba.
 *  - Una prueba existente que comprueba un comportamiento que la historia cambia a propósito se puede actualizar (con
 *    el motivo; QA y el propietario lo ven). Antes era imposible terminar (HU-177).
 *  - La corrección recibe la evidencia precisa (prueba, error, línea base, intentos anteriores con su diff y resultado).
 *  - LECCIONES: «aprendida» solo cuando una tarea posterior la demuestra; si su error vuelve con ella, se retira sola.
 *  - Continuidad: un proceso detenido como HU-177 (correcciones agotadas, sin triaje) continúa con el código nuevo.
 * Proveedor SIMULADO (0 USD); el «sandbox» de la prueba ejecuta node --test DE VERDAD sobre cada worktree (también el de
 * la base), con rutas como las del contenedor (/work/…), así que los fallos y su clasificación son reales.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-lb-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
process.env.PORTAL_MOCK_PROVIDER = '1';
const dataDir = process.env.PORTAL_DATA_DIR;
const scriptPath = path.join(dataDir, 'mock-script.json'); const logPath = path.join(dataDir, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline, verificationPassed } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts'); // con el propietario vinculado (todo cambio lo exige)
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { newPipeline } = await import('../src/services/storyPipeline.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { BASELINE_DIR, classify, errorKernel, forgetBaselines, isBaselineWorktree, baselineFor } = await import('../src/services/baseline.ts');
const { passKey, relFile, testDigest, weakensTest } = await import('../src/services/testTriage.ts');
const { createManualLesson, lessonsFor, lessonsRepo, recordLessonOutcomes, REFUTE_AFTER } = await import('../src/services/lessons.ts');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];

// ---------- Repositorio sintético: una prueba que YA falla en main y otra que fija el comportamiento actual ----------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-lb-repo-'));
const put = (p: string, c: string) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), c); };
put('src/index.mjs', 'export const version = 1;\n');
put('test/viejo.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('viejo: ya falla en main sin ninguna historia', () => { assert.equal(1, 2, 'fallo heredado de main'); });\n");
put('test/compat.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { version } from '../src/index.mjs';\ntest('compat: la version publica es la actual', () => { assert.equal(version, 1); });\n");
put('package.json', JSON.stringify({ name: 'lb', version: '1.0.0', private: true, type: 'module', scripts: { typecheck: 'node -e 0', test: 'node --test test/', build: 'node -e 0' } }, null, 2) + '\n');
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
const baseSha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { await app.close(); });

// ---------- «Sandbox» de la prueba: node --test real sobre el worktree, con las rutas del contenedor (/work/…) ----------
const sandboxCalls: { wt: string; command: string }[] = [];
// node escribe la ruta con barras dobles en «location» y como file:/// en la pila; el contenedor real, /work/…
const toWork = (out: string, wt: string) => {
  const fwd = wt.split('\\').join('/'); const dbl = wt.split('\\').join('\\\\');
  const s = [dbl, wt, `file:///${fwd}`, fwd].reduce((acc, p) => acc.split(p).join('/work'), out);
  return s.replace(/\/work(?:\\\\|\\|\/)[^'\s)]*/g, m => m.split('\\\\').join('/').split('\\').join('/'));
};
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (wt, _root, command) => {
  sandboxCalls.push({ wt, command });
  const t = new Date().toISOString(); const t0 = Date.now();
  if (command !== 'test') return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' };
  const files = fs.readdirSync(path.join(wt, 'test')).filter(f => f.endsWith('.test.mjs')).map(f => `test/${f}`);
  let exitCode = 0; let output = '';
  // Fuera del contexto de node:test de esta prueba (si no, el hijo se cree una subprueba y no informa sus fallos).
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  try { output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: wt, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e: any) { exitCode = e.status ?? 1; output = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  return { command, exitCode, output: toWork(output, wt), startedAt: t, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, isolation: 'docker' };
};
const baseRuns = () => sandboxCalls.filter(c => isBaselineWorktree(c.wt));

// ---------- Guion del proveedor simulado ----------
type Rule = { match: string; text?: string; responses?: { text: string }[] };
const R = { plan: 'plan técnico', fix: 'Corrige la implementación de esta historia', qa: 'Evalúa la implementación con la EVIDENCIA real', dev: 'Implementa la historia' };
const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple el criterio con evidencia.', findings: [], suggestedTests: [] });
const OWNER = '=== PARA EL PROPIETARIO ===\nCambio aplicado.\n=== PRUEBA MANUAL ===\n1. Ejecuta npm test. Esperado: verde salvo lo heredado.\n';
const F = (p: string, c: string) => `=== ARCHIVO: ${p} | create ===\n${c}=== FIN ARCHIVO ===\n`;
const P = (p: string, s: string, r: string) => `=== ARCHIVO: ${p} | patch ===\n<<<< BUSCAR\n${s}\n==== REEMPLAZAR\n${r}\n>>>> FIN\n=== FIN ARCHIVO ===\n`;
const resp = (summary: string, ...blocks: string[]) => `=== RESUMEN ===\n${summary}\n${blocks.join('')}${OWNER}`;
const plan = (deliverables: { path: string; kind: string }[], acceptance: string[]) => JSON.stringify({ summary: 'Cambio acotado con pruebas.', tasks: deliverables.map(d => `Entregar ${d.path}`), filesToRead: ['src/index.mjs'], filesToChange: deliverables.map(d => d.path), deliverables: deliverables.map(d => ({ path: d.path, purpose: `Entregable ${d.path}`, kind: d.kind, estimatedLines: 6 })), acceptance, risks: [] });
const MARKERS = ['Línea base: «test» ejecutado SIN tus cambios', 'Pruebas existentes que comprueban un comportamiento que esta historia cambia', 'viejo: ya falla en main sin ninguna historia', 'compat: la version publica es la actual', 'OK FRENTE A LA BASE', 'Pruebas que YA existían y la historia modificó', 'Intentos anteriores sobre estos archivos', 'MARCA_LECCION_PROBADA', 'MARCA_LECCION_ERRONEA'];
function setRules(planText: string, rules: Rule[]) {
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: R.plan, text: planText }, ...rules, { match: R.qa, text: QA_OK }], markers: MARKERS }));
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const byRule = (m: string) => calls().filter(c => c.rule === m);
const CFG = { gauntlet: { mode: 'off' as const }, maxCorrections: 2 };
function newRun(title: string, criterion: string, cfg: Partial<typeof DEFAULT_PIPELINE> = {}) {
  const it = addManualItem(S, project.id, { title, criterion });
  const p = createStoryProcess(S, project.id, it.id);
  processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, ...CFG, ...cfg } as any)) });
  processesRepo(S).authorize(p.id, 5);
  return p.id;
}
const run = async (id: string) => { await runStory(S, id, () => undefined, () => false); return processesRepo(S).get(id)!; };
const lastTest = (p: any) => p.result.verifications.filter((v: any) => v.command === 'test').at(-1);
const waitDone = async (id: string) => { const end = Date.now() + 60_000; for (;;) { const p = processesRepo(S).get(id)!; if (p.status !== 'running') return p; if (Date.now() > end) throw new Error('tiempo agotado'); await new Promise(r => setTimeout(r, 25)); } };

// ---------- Unidades (sin IA) ----------
test('triaje: preexistente solo con el MISMO error; lo que pasa en la base es de la historia; otro error o una prueba de la que se ocupa la historia, también', () => {
  const base = { commit: 'abc1234', at: '', exitCode: 1, durationMs: 1, failing: [{ file: 'test/a.test.ts', name: 'a falla', message: "Expected 1 to equal 2 (C:\\tmp\\x\\y.ts:12:3, 31 ms)" }, { file: 'test/b.test.ts', name: 'b falla', message: 'esperado 2' }, { file: 'test/c.test.ts', name: 'c: el remoto rechaza', message: 'done !== partial' }], problem: null };
  const t = classify([
    { file: 'test/a.test.ts', name: 'a falla', message: 'Expected 1 to equal 2 (/work/otra/ruta.ts:99:1, 7 ms)' }, // mismo error con otros números y rutas
    { file: 'test/b.test.ts', name: 'b falla', message: 'TypeError: no es una función' }, // otro error → de la historia
    { file: 'test/d.test.ts', name: 'd nueva', message: 'x' }, // pasa en la base → la rompió la historia
    { file: 'test/c.test.ts', name: 'c: el remoto rechaza', message: 'done !== partial' } // ya fallaba, pero la historia trata de ella
  ], base, new Set(), { text: 'Arreglar la prueba «c: el remoto rechaza» del mantenimiento' });
  assert.deepEqual(t.preexisting.map(x => x.name), ['a falla']);
  assert.deepEqual(t.introduced.map(x => x.name), ['d nueva']);
  assert.deepEqual(t.changed.map(x => x.name).sort(), ['b falla', 'c: el remoto rechaza']);
  assert.equal(t.accepted, false);
  // Una prueba que la propia historia creó o cambió es suya aunque también fallara en la base.
  const own = classify([{ file: 'test/a.test.ts', name: 'a falla', message: 'Expected 1 to equal 2' }], base, new Set(['test/a.test.ts']));
  assert.equal(own.accepted, false); assert.equal(own.introduced.length, 1);
  const only = classify([{ file: 'test/a.test.ts', name: 'a falla', message: 'Expected 1 to equal 2 (/work/test/a.test.ts:4:5, 8 ms)' }], base, new Set());
  assert.equal(only.accepted, true, 'solo lo heredado: aceptado (no se gasta ninguna corrección)');
  assert.equal(errorKernel('falló en C:\\Users\\x\\AppData\\Local\\Temp\\wt\\a.ts:3 tras 120 ms'), errorKernel('falló en /work/a.ts:9 tras 4 ms'), 'rutas temporales y duraciones no cuentan');
  assert.notEqual(errorKernel('2 !== 3'), errorKernel('0 !== 3'), 'los valores SÍ cuentan: otro valor es otro fallo');
  // Mismo nombre y mensaje pero OTROS valores (deepStrictEqual): no es el mismo fallo.
  const vals = classify([{ file: 'test/v.test.ts', name: 'v', message: 'Expected values to be strictly equal:', expected: '3', actual: '0' }], { ...base, failing: [{ file: 'test/v.test.ts', name: 'v', message: 'Expected values to be strictly equal:', expected: '3', actual: '2' }] }, new Set());
  assert.equal(vals.accepted, false); assert.equal(vals.changed.length, 1);
  // Actualizable SOLO con prueba positiva de que pasaba en la base, y nunca una de seguridad.
  const proof = classify([{ file: 'test/d.test.ts', name: 'd nueva', message: 'x' }, { file: 'test/propietario.test.ts', name: 'sin sesión → 401', message: 'x' }], { ...base, passedKeys: [passKey('d nueva'), passKey('sin sesión → 401')] }, new Set());
  assert.deepEqual(proof.updatableFiles, ['test/d.test.ts']);
  assert.deepEqual(classify([{ file: 'test/d.test.ts', name: 'd nueva', message: 'x' }], base, new Set()).updatableFiles, [], 'sin «ok» en la base, no');
  // Rutas del equipo (WSL, linux-ns) relativas al worktree: si no, todo parecía introducido.
  const tap = "TAP version 13\nnot ok 1 - a\n  ---\n  location: 'C:\\\\x\\\\wt\\\\test\\\\a.test.mjs:3:1'\n  failureType: 'testCodeFailure'\n  error: 'falla'\n  expected: 2\n  actual: 1\n  ...\nok 2 - b\n# tests 2\n# pass 1\n# fail 1\n";
  const dg = testDigest(tap, ['C:\\x\\wt']);
  assert.equal(dg.failing[0].file, 'test/a.test.mjs'); assert.equal(dg.failing[0].expected, '2'); assert.equal(dg.failing[0].actual, '1');
  assert.equal(dg.total, 2); assert.deepEqual(dg.passedKeys, [passKey('b')]);
  assert.equal(relFile('/work/test/x.test.ts', []), 'test/x.test.ts');
  // Una actualización que debilita la prueba nunca vale.
  assert.equal(weakensTest("test('a', () => { assert.equal(1, 1); });", "test.skip('a', () => { assert.equal(1, 1); });"), 'añade skip/todo/only');
  assert.equal(weakensTest("test('a', () => { assert.equal(v, 1); assert.ok(x); });", "test('a', () => { assert.equal(v, 2); });"), 'quita aserciones');
  assert.equal(weakensTest("test('a', () => { assert.equal(v, 1); });", "test('a', () => { assert.equal(v, 2); });"), null);
  assert.ok(verificationPassed({ command: 'test', exitCode: 1, triage: only }) && !verificationPassed({ command: 'test', exitCode: 1, triage: t }) && !verificationPassed({ command: 'typecheck', exitCode: 1, triage: only }));
});

test('línea base: una sola ejecución por commit (también simultáneas), en un worktree temporal que se retira; sin dependencias no hay línea base y se dice', async () => {
  forgetBaselines(); const before = baseRuns().length;
  const [a, b] = await Promise.all([baselineFor(S, project.id, repo, baseSha), baselineFor(S, project.id, repo, baseSha)]);
  assert.equal(baseRuns().length - before, 1, 'una ejecución compartida');
  assert.equal(a, b); assert.equal(a.problem, null);
  assert.deepEqual(a.failing.map(f => [f.file, f.name]), [['test/viejo.test.mjs', 'viejo: ya falla en main sin ninguna historia']], 'el fallo heredado, con su archivo relativo');
  const tmpRoot = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, BASELINE_DIR);
  assert.ok(baseRuns().slice(before).every(c => c.wt.startsWith(tmpRoot)), 'bajo la carpeta de worktrees del Portal (nunca /tmp: un sandbox sin /tmp propio lo compartiría)');
  assert.ok(!fs.existsSync(tmpRoot) || fs.readdirSync(tmpRoot).length === 0, 'el worktree temporal se retiró');
  assert.doesNotMatch(execSync('git worktree list', { cwd: repo, encoding: 'utf8' }), new RegExp(BASELINE_DIR), 'ni queda registrado en git');
  // Sin dependencias en el sandbox para esa base: no se inventa una línea base (y no se guarda).
  const real = sandboxDeps.run; forgetBaselines();
  sandboxDeps.run = async (wt, r, c, o) => isBaselineWorktree(wt) ? { command: c, exitCode: 86, output: 'Faltan las dependencias', startedAt: '', finishedAt: '', durationMs: 1, isolation: 'docker' } : real(wt, r, c, o);
  try { const x = await baselineFor(S, project.id, repo, baseSha); assert.match(x.problem ?? '', /otras dependencias/); }
  finally { sandboxDeps.run = real; forgetBaselines(); }
});

// ---------- Pipeline real (proveedor simulado) ----------
test('HU-177 · lo que ya fallaba en main no se le cobra a la historia: sin correcciones, QA lo ve «frente a la base», se puede integrar; no deja lección', async () => {
  // Una lección validada que el implementador llevará inyectada: esta tarea posterior la DEMUESTRA si termina verificada.
  const lesson = createManualLesson(S, { projectId: project.id, title: 'Entregar cada archivo con su prueba', lessonText: 'MARCA_LECCION_PROBADA: entrega cada archivo nuevo con su prueba.', role: 'implementer' });
  setRules(plan([{ path: 'src/nuevo.mjs', kind: 'code' }], ['Existe src/nuevo.mjs']), [{ match: R.dev, text: resp('Entrega src/nuevo.mjs.', F('src/nuevo.mjs', 'export const nuevo = true;\n')) }]);
  const id = newRun('Nuevo módulo', 'Existe src/nuevo.mjs que exporta nuevo.');
  const p = await run(id); const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  assert.equal(pl.corrections, 0); assert.equal(pl.correctionAttempts ?? 0, 0, 'ninguna corrección pagada');
  assert.equal(byRule(R.fix).length, 0);
  const v = lastTest(p);
  assert.equal(v.exitCode, 1, 'la salida real se conserva (falla)'); assert.equal(v.triage.accepted, true); assert.equal(v.triage.baseCommit, baseSha);
  assert.deepEqual(v.triage.preexisting.map((x: any) => x.name), ['viejo: ya falla en main sin ninguna historia']);
  assert.ok(pl.events.some(e => /ya ocurren en la base .* no los causó ella/.test(e.message)), 'se dice con la evidencia');
  assert.ok(byRule(R.qa).at(-1).markers.includes('OK FRENTE A LA BASE'), 'QA recibe el resultado frente a la base');
  assert.ok(!lessonsRepo(S).list(project.id).some(l => l.detector === 'verification_failed' && l.evidence.processId === id), 'no se aprende de un fallo que la historia no causó');
  // Lección demostrada por esta tarea posterior (llevaba la lección y terminó verificada sin repetir su error).
  assert.ok(byRule(R.dev).some(c => c.markers.includes('MARCA_LECCION_PROBADA')), 'el implementador recibió la lección');
  const l = lessonsRepo(S).get(lesson.id)!;
  assert.equal(l.proof?.at(-1)?.result, 'held'); assert.equal(l.proof?.at(-1)?.processId, id); assert.ok(l.provenAt, 'aprendida: la demostró una tarea posterior');
  // Integrar en main con la verificación del Portal (test cuenta como superada frente a la base).
  const m0 = await app.inject({ method: 'POST', url: `${W}/processes/${id}/merge`, payload: { authorized: true } });
  assert.equal(m0.statusCode, 409, 'sin confirmar lo heredado no se integra'); assert.equal(m0.json().code, 'ack_required');
  assert.match(m0.json().acknowledgements.preexisting.join(), /viejo: ya falla en main/);
  const stale = await app.inject({ method: 'POST', url: `${W}/processes/${id}/merge`, payload: { authorized: true, expectedCommit: '0000000', acknowledge: { preexisting: true } } });
  assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'stale_commit', 'otro commit del que viste: no');
  const m = await app.inject({ method: 'POST', url: `${W}/processes/${id}/merge`, payload: { authorized: true, expectedCommit: p.result!.applied!.commit, acknowledge: { preexisting: true } } });
  assert.equal(m.statusCode, 200, m.body);
  assert.ok(fs.existsSync(path.join(repo, 'src/nuevo.mjs')), 'el cambio está en main');
});

test('HU-177 · una prueba existente que fija el comportamiento que la historia cambia a propósito se actualiza con evidencia; la corrección recibe la línea base; QA ve la prueba modificada', async () => {
  execSync('git checkout -q main', { cwd: repo });
  setRules(plan([{ path: 'src/index.mjs', kind: 'code' }], ['La versión pública pasa a 2']), [
    { match: R.fix, text: resp('Causa: compat.test.mjs fija la versión 1 y el criterio «La versión pública pasa a 2» la cambia a propósito; se actualiza la prueba al comportamiento nuevo.', P('test/compat.test.mjs', 'assert.equal(version, 1);', 'assert.equal(version, 2);')) },
    { match: R.dev, text: resp('Sube la versión.', P('src/index.mjs', 'export const version = 1;', 'export const version = 2;')) }
  ]);
  const id = newRun('Versión 2', 'La versión pública pasa a 2 (cambio de comportamiento pedido).');
  const p = await run(id); const pl = p.result!.pipeline!; const man = p.result!.manifest!;
  assert.equal(pl.state, 'verified', `${pl.reason ?? ''} | ${JSON.stringify(pl.events.slice(-10).map(e => [e.message, e.detail]))} | ${JSON.stringify(man.rejected ?? [])}`);
  assert.equal(pl.corrections, 1, 'una sola corrección, dirigida a lo que rompió la historia');
  const fix = byRule(R.fix)[0];
  assert.ok(fix.markers.includes('Línea base: «test» ejecutado SIN tus cambios'), 'la corrección recibe la línea base');
  assert.ok(fix.markers.includes('Pruebas existentes que comprueban un comportamiento que esta historia cambia'));
  assert.ok(fix.markers.includes('viejo: ya falla en main sin ninguna historia'), 'sabe qué NO es suyo');
  const unit = man.units.find(u => u.kind === 'correction')!;
  assert.deepEqual(unit.files, ['test/compat.test.mjs']); assert.deepEqual(unit.testUpdatable, ['test/compat.test.mjs']);
  assert.ok(!(unit.findings ?? []).some(f => /viejo/.test(f.text)), 'el fallo heredado no es un hallazgo de la corrección');
  assert.deepEqual(man.testUpdates?.map(x => x.path), ['test/compat.test.mjs'], 'queda registrada la prueba existente modificada');
  assert.match(man.testUpdates![0].reason, /Pasa en la base y falla con la historia/);
  assert.ok(byRule(R.qa).at(-1).markers.includes('Pruebas que YA existían y la historia modificó'), 'QA lo revisa');
  assert.match(fs.readFileSync(path.join(p.result!.applied!.worktree!, 'test/compat.test.mjs'), 'utf8'), /equal\(version, 2\)/);
  // La primera ejecución que falló (pasa en la base, falla con la historia): su lección es legítima (la causó ella).
  assert.ok(lessonsRepo(S).list(project.id).some(l => l.detector === 'verification_failed' && l.evidence.processId === id));
});

test('continuidad · un proceso detenido como HU-177 (correcciones agotadas, sin triaje guardado) continúa con el código nuevo y termina', async () => {
  setRules(plan([{ path: 'src/index.mjs', kind: 'code' }], ['La versión pública pasa a 3']), [
    { match: R.fix, text: resp('Causa: compat fija la versión anterior; el criterio la cambia a 3.', P('test/compat.test.mjs', 'assert.equal(version, 1);', 'assert.equal(version, 3);')) },
    { match: R.dev, text: resp('Sube la versión.', P('src/index.mjs', 'export const version = 1;', 'export const version = 3;')) }
  ]);
  execSync('git checkout -q main && git reset -q --hard ' + baseSha, { cwd: repo }); // main sin el cambio anterior (repositorio de la prueba)
  const id = newRun('Versión 3', 'La versión pública pasa a 3.', { maxCorrections: 0 });
  const p0 = await run(id);
  assert.equal(p0.result!.pipeline!.state, 'stopped'); assert.equal(p0.result!.pipeline!.pauseKind, 'limit');
  // Como lo guardó la versión anterior del Portal: sin triaje ni línea base.
  processesRepo(S).setResult(id, { ...p0.result!, verifications: p0.result!.verifications.map(({ triage, tests, ...v }: any) => v.command === 'test' ? { ...v, output: `${v.output}\n[… 120000 caracteres omitidos …]` } : v), pipeline: { ...p0.result!.pipeline!, baseline: undefined } as any });
  forgetBaselines();
  // «Verificar test» a mano: el mismo triaje que el pipeline (antes la integración quedaba bloqueada).
  const mv = await app.inject({ method: 'POST', url: `${W}/processes/${id}/verify`, payload: { authorized: true, command: 'test' } });
  assert.equal(mv.statusCode, 200, mv.body);
  const manual = lastTest(processesRepo(S).get(id));
  assert.ok(manual.triage && !manual.triage.unavailable, 'la verificación manual también se compara con la base');
  assert.deepEqual(manual.triage.introduced.map((x: any) => x.name), ['compat: la version publica es la actual']);
  // Y como lo guardó la versión anterior: la última ejecución, recortada y sin resumen.
  const cur = processesRepo(S).get(id)!; const vs = cur.result!.verifications;
  processesRepo(S).setResult(id, { ...cur.result!, verifications: vs.map((v: any, i: number) => i === vs.length - 1 ? (({ triage, tests, ...x }: any) => ({ ...x, output: `${x.output}\n[… 120000 caracteres omitidos …]` }))(v) : v) });
  const view = await app.inject({ method: 'GET', url: `${W}/processes/${id}` });
  assert.equal(view.statusCode, 200, 'se sirve sin errores');
  const c = await app.inject({ method: 'POST', url: `${W}/processes/${id}/continue`, payload: { authorized: true, pipeline: { maxCorrections: 1 } } });
  assert.equal(c.statusCode, 200, c.body);
  const p = await waitDone(id); const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  assert.equal(pl.corrections, 1);
  assert.ok(pl.events.some(e => /evidencia guardada de «test» está recortada/.test(e.message)), 'con la evidencia antigua recortada se repitió «test» una vez, sin IA');
  assert.ok(lastTest(p).triage?.accepted, 'al continuar se separó lo heredado');
});

test('lecciones · una lección cuyo error vuelve a ocurrir con ella presente se retira sola (no queda como conocimiento); la demostrada sigue', async () => {
  const wrong = createManualLesson(S, { projectId: project.id, title: 'Lección errónea', lessonText: 'MARCA_LECCION_ERRONEA: usa parches con fragmentos aproximados.', role: 'implementer' });
  lessonsRepo(S).update(wrong.id, { tags: ['patch_mismatch'] });
  const procWith = (title: string) => {
    const it = addManualItem(S, project.id, { title, criterion: 'Algo verificable.' });
    const p = createStoryProcess(S, project.id, it.id);
    const impl = p.steps.find(s => s.role === 'implementer') ?? p.steps[1];
    processesRepo(S).setStepLessons(impl.id, [wrong.id]);
    // El mismo error de la lección: un parche que no encaja en el archivo.
    // Una tarea posterior TERMINADA y verificada en la que el error de la lección volvió a ocurrir por el camino.
    processesRepo(S).setResult(p.id, { ...p.result!, pipeline: { ...newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE } as any)), state: 'verified' }, changes: [{ path: 'src/index.mjs', action: 'modify', content: null, diff: null, before: 1, after: 1, error: 'El fragmento BUSCAR no aparece en el archivo actual.' } as any] });
    return p.id;
  };
  for (let i = 0; i < REFUTE_AFTER; i++) {
    const o = recordLessonOutcomes(S, procWith(`Tarea posterior ${i + 1}`), repo);
    assert.deepEqual(o.recurred, [wrong.id]);
  }
  const w = lessonsRepo(S).get(wrong.id)!;
  assert.equal(w.status, 'refuted', 'retirada tras reincidir con ella presente');
  assert.ok(!w.provenAt); assert.deepEqual(w.proof!.map(x => x.result), Array(REFUTE_AFTER).fill('recurred'));
  assert.ok(!lessonsFor(S, { projectId: project.id, role: 'implementer' }).some(l => l.id === wrong.id), 'ya no se inyecta en ningún prompt');
  // Corregida por el propietario: versión nueva, validada y SIN las pruebas de la anterior (que conserva su historial).
  const { validateLesson } = await import('../src/services/lessons.ts');
  const fixed = validateLesson(S, wrong.id, { lessonText: 'Copia el fragmento BUSCAR exacto del contenido actual.' });
  assert.notEqual(fixed.id, wrong.id); assert.equal(fixed.status, 'validated'); assert.deepEqual(fixed.proof, []); assert.equal(fixed.provenAt, null);
  assert.equal(lessonsRepo(S).get(wrong.id)!.status, 'obsolete');
  // Una tarea no demuestra la lección que ella misma originó (solo cuentan las POSTERIORES).
  const proven = lessonsRepo(S).list(project.id).find(l => l.provenAt)!;
  assert.ok(proven, 'la demostrada en la prueba anterior sigue');
  assert.equal(proven.status, 'validated');
});

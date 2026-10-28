import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * HU-155 (rescate): la historia agotó 9 correcciones sobre una prueba que comparaba el catálogo con las rutas reales del
 * servidor. El Desarrollador nunca vio esas rutas, la prueba mostraba un elemento cada vez, dos pruebas inestables del
 * Portal costaron tres rondas y no había forma de registrar una corrección hecha desde la consola. Estas pruebas cubren
 * el diagnóstico enfocado, la detección de progreso, la protección de pruebas existentes, la repetición sin IA de pruebas
 * ajenas y el registro autorizado de una corrección externa. Proveedor SIMULADO (0 USD) y repositorio sintético.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-diag-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
process.env.PORTAL_MOCK_PROVIDER = '1';
const dataDir = process.env.PORTAL_DATA_DIR;
const scriptPath = path.join(dataDir, 'mock-script.json'); const logPath = path.join(dataDir, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { newPipeline } = await import('../src/services/storyPipeline.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { diagnoseFailure, failingTests, routeIndex } = await import('../src/services/failureDiagnosis.ts');
const { parseFailingTests } = await import('../src/services/diagnostics.ts');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const git = (cwd: string, cmd: string) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd, encoding: 'utf8' }).trim();

// ---------- Repositorio sintético: un servidor con rutas reales (una registrada con prefijo) ----------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-diag-repo-'));
const put = (root: string, p: string, c: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); };
put(repo, 'src/app.mjs', "import { inboxRoutes } from './routes/inbox.mjs';\nimport { userRoutes } from './routes/users.mjs';\nexport async function buildApp(app) {\n  await app.register(inboxRoutes);\n  await app.register(userRoutes, { prefix: '/api/users' });\n}\n");
put(repo, 'src/routes/inbox.mjs', "// MARCA_RUTAS_INBOX\nexport async function inboxRoutes(app) {\n  app.get('/api/workspaces/:slug/inbox', async () => []);\n  app.get('/api/budgets/:level/:id/balance', async () => ({}));\n}\n");
put(repo, 'src/routes/users.mjs', "export async function userRoutes(app) {\n  app.get('/:id', async () => ({}));\n}\n");
put(repo, 'test/smoke.test.mjs', "import { test } from 'node:test';\ntest('humo', () => {});\n");
put(repo, 'package.json', JSON.stringify({ name: 'diag', version: '1.0.0', private: true, type: 'module', scripts: { typecheck: 'node -e 0', test: 'node --test test/', build: 'node -e 0' } }, null, 2) + '\n');
put(repo, '.gitignore', 'node_modules\n');
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();

// ---------- Proveedor simulado ----------
const R = { plan: 'plan técnico', fix: 'Corrige la implementación de esta historia', qa: 'Evalúa la implementación con la EVIDENCIA real', dev: 'Implementa la historia' };
const MARKERS = ['Diagnóstico enfocado', '[missing_route]', '[partial_progress]', '[no_progress]', '[existing_test]', '[brittle_assertion]', '[repository_contract]', 'GET /api/workspaces/:slug/inbox — src/routes/inbox.mjs:3', 'MARCA_RUTAS_INBOX', 'Código de la prueba que falla', 'MARCA_CORRECCION_1', "la ruta /api/inbox no está declarada", 'Correcciones externas registradas por el propietario', 'MARCA_CONSOLA'];
const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple el criterio con evidencia.', findings: [], suggestedTests: [] });
const F = (p: string, c: string) => `=== ARCHIVO: ${p} | create ===\n${c}=== FIN ARCHIVO ===\n`;
const P = (p: string, s: string, r: string) => `=== ARCHIVO: ${p} | patch ===\n<<<< BUSCAR\n${s}\n==== REEMPLAZAR\n${r}\n>>>> FIN\n=== FIN ARCHIVO ===\n`;
const OWNER = '=== PARA EL PROPIETARIO ===\nEl catálogo usa rutas reales.\n=== PRUEBA MANUAL ===\n1. Ejecuta npm test. Esperado: verde.\n';
const resp = (...b: string[]) => `=== RESUMEN ===\nEntrega.\n${b.join('')}${OWNER}`;
const fix = (...b: string[]) => `=== RESUMEN ===\nCorrección.\n${b.join('')}`;
const CATALOG = "export const RUTAS = [\n  '/api/inbox',\n  '/api/budgets',\n];\n";
const TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport { RUTAS } from '../src/catalog.mjs';\ntest('el literal de cada ruta existe en su archivo', () => {\n  const src = fs.readFileSync('src/routes/inbox.mjs', 'utf8');\n  for (const r of RUTAS) assert.ok(src.includes(r), `la ruta ${r} no está declarada con .get( en src/routes/inbox.mjs`);\n});\n";
const plan = JSON.stringify({ summary: 'Catálogo de rutas con su prueba', tasks: ['Entregar el catálogo', 'Entregar la prueba'], filesToRead: ['src/app.mjs'], filesToChange: ['src/catalog.mjs', 'test/catalog.test.mjs'], deliverables: [{ path: 'src/catalog.mjs', purpose: 'Catálogo', kind: 'code', estimatedLines: 5 }, { path: 'test/catalog.test.mjs', purpose: 'Prueba del catálogo', kind: 'test', estimatedLines: 9 }], acceptance: ['Cada ruta del catálogo existe en el servidor'], risks: [] });
type Rule = { match: string; text?: string; responses?: { text: string }[] };
function setRules(rules: Rule[], qa: Rule | null = { match: R.qa, text: QA_OK }) {
  const units = { match: 'Esta es la unidad 1 de ', text: resp(F('src/catalog.mjs', CATALOG), F('test/catalog.test.mjs', TEST)) };
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: R.plan, text: plan }, ...rules, ...(qa ? [qa] : []), units], markers: MARKERS }));
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const byRule = (m: string) => calls().filter(c => c.rule === m);

// ---------- Sandbox determinista que LEE el worktree: falla con la primera ruta del catálogo que el servidor no declara ----------
const REAL = ['/api/workspaces/:ws/inbox', '/api/budgets/:level/:id/balance'];
const tap = (name: string, msg: string, file: string) => `TAP version 13\n# Subtest: ${name}\nnot ok 1 - ${name}\n  ---\n  duration_ms: 3.1\n  location: '/work/${file}:5:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    ${msg}\n  code: 'ERR_ASSERTION'\n  stack: |-\n    TestContext.<anonymous> (/work/${file}:7:24)\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n`;
let smoke: 'ok' | 'flaky' | 'broken' = 'ok'; let smokeRuns = 0;
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (wt, _root, command) => {
  const t = new Date().toISOString(); let exitCode = 0; let output = command === 'test' ? 'TAP version 13\nok 1 - el literal de cada ruta existe en su archivo\nok 2 - humo\n1..2\n# tests 2\n# pass 2\n# fail 0\n' : `${command} ok`;
  if (command === 'test') {
    const cat = fs.existsSync(path.join(wt, 'src/catalog.mjs')) ? fs.readFileSync(path.join(wt, 'src/catalog.mjs'), 'utf8') : '';
    const bad = Array.from(cat.matchAll(/'(\/api\/[^']+)'/g)).map(m => m[1]).find(r => !REAL.includes(r));
    if (smoke === 'broken' || (smoke === 'flaky' && smokeRuns++ === 0)) { exitCode = 1; output = tap('humo', 'Expected values to be strictly equal: 1 !== 2', 'test/smoke.test.mjs'); }
    else if (bad) { exitCode = 1; output = tap('el literal de cada ruta existe en su archivo', `la ruta ${bad} no está declarada con .get( en src/routes/inbox.mjs`, 'test/catalog.test.mjs'); }
  }
  return { command, exitCode, output, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' };
};

const CRITERION = 'Cada ruta del catálogo existe en el servidor.';
function newRun(title: string, cfg: Partial<typeof DEFAULT_PIPELINE> = {}, budget = 5) {
  const it = addManualItem(S, project.id, { title, criterion: CRITERION });
  const p = createStoryProcess(S, project.id, it.id);
  processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, ...cfg })) });
  processesRepo(S).authorize(p.id, budget);
  return p.id;
}
async function runIt(title: string, cfg: Partial<typeof DEFAULT_PIPELINE> = {}) { const id = newRun(title, cfg); await runStory(S, id, () => undefined, () => false); return processesRepo(S).get(id)!; }
const waitDone = async (id: string) => { const end = Date.now() + 60_000; for (;;) { const p = processesRepo(S).get(id)!; if (p.status !== 'running') return p; if (Date.now() > end) throw new Error('tiempo agotado'); await new Promise(r => setTimeout(r, 25)); } };
const flowOf = async (id: string) => (await app.inject({ method: 'GET', url: `${W}/processes/${id}` })).json();

// ---------- Unidades (sin IA) ----------
test('el fallo de una prueba se lee entero: mensaje de un bloque YAML, archivo y línea de la aserción', () => {
  const run = { command: 'test', output: tap('caso', 'la ruta /api/inbox no está declarada', 'test/catalog.test.mjs'), exitCode: 1, startedAt: '', finishedAt: '', durationMs: 1, isolation: 'docker' as const };
  assert.deepEqual(failingTests(run), [{ name: 'caso', message: 'la ruta /api/inbox no está declarada', file: 'test/catalog.test.mjs', line: 7 }]);
  assert.equal(parseFailingTests(run.output)[0].text, 'caso — la ruta /api/inbox no está declarada', 'antes salía «caso — -»');
});

test('A · una ruta registrada con prefijo se valida por su ruta efectiva (comprobar el literal es frágil, no falta la ruta)', () => {
  const index = routeIndex(repo);
  const user = index.find(r => r.path === '/api/users/:id')!;
  assert.ok(user, 'GET /api/users/:id efectiva');
  assert.equal(user.declared, '/:id'); assert.deepEqual(user.prefix && { value: user.prefix.value, file: user.prefix.file }, { value: '/api/users', file: 'src/app.mjs' });
  const run = { command: 'test', output: tap('rutas', 'la ruta /api/users/:id no está declarada con .get( en src/routes/users.mjs', 'test/catalog.test.mjs'), exitCode: 1, startedAt: '', finishedAt: '', durationMs: 1, isolation: 'docker' as const };
  const d = diagnoseFailure({ root: repo, run, previous: [], storyCreated: ['test/catalog.test.mjs'], planned: [], unitFiles: [] });
  const kinds = d.kinds.map(k => k.kind);
  assert.ok(kinds.includes('brittle_assertion')); assert.ok(!kinds.includes('missing_route'));
  // C · se identifica la aserción incorrecta SIN debilitar la cobertura: validar la ruta efectiva, no duplicar ni quitar.
  assert.match(d.kinds.find(k => k.kind === 'brittle_assertion')!.why, /ruta efectiva.*No añadas una ruta duplicada ni quites la comprobación/s);
});

test('B · una ruta que de verdad no existe se informa como tal, con las rutas reales parecidas', () => {
  const run = { command: 'test', output: tap('rutas', 'la ruta /api/workspaces/demo/inbox/archived no está declarada', 'test/catalog.test.mjs'), exitCode: 1, startedAt: '', finishedAt: '', durationMs: 1, isolation: 'docker' as const };
  const d = diagnoseFailure({ root: repo, run, previous: [], storyCreated: ['test/catalog.test.mjs'], planned: [], unitFiles: [] });
  assert.deepEqual(d.routes!.missing.map(m => m.route), ['/api/workspaces/demo/inbox/archived']);
  assert.ok(d.routes!.missing[0].similar.some(s => s.path === '/api/workspaces/:slug/inbox'));
  assert.ok(d.kinds.some(k => k.kind === 'missing_route'));
});

// ---------- Pipeline con el proveedor simulado ----------
test('D/E/F · la corrección recibe la prueba y el mensaje exactos, el código que cita, el índice real de rutas y el contenido ACTUAL; detecta el progreso parcial', async () => {
  setRules([{ match: R.fix, responses: [
    { text: fix(`=== ARCHIVO: src/catalog.mjs | patch ===\n<<<< BUSCAR\n  '/api/inbox',\n==== REEMPLAZAR\n  '/api/workspaces/:ws/inbox', // MARCA_CORRECCION_1\n>>>> FIN\n=== FIN ARCHIVO ===\n`) },
    { text: fix(P('src/catalog.mjs', "  '/api/budgets',", "  '/api/budgets/:level/:id/balance',")) }
  ] }]);
  const p = await runIt('Diagnóstico · rutas supuestas', { maxCorrections: 3 });
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  const [c1, c2] = byRule(R.fix);
  for (const m of ['Diagnóstico enfocado', "la ruta /api/inbox no está declarada", '[missing_route]', '[repository_contract]', 'GET /api/workspaces/:slug/inbox — src/routes/inbox.mjs:3', 'MARCA_RUTAS_INBOX', 'Código de la prueba que falla']) assert.ok(c1.markers.includes(m), `primera corrección sin «${m}»`);
  assert.ok(c2.markers.includes('MARCA_CORRECCION_1'), 'E · la segunda corrección ve el código actual del worktree');
  assert.ok(c2.markers.includes('[partial_progress]'), 'F · el mismo caso falla con otro elemento: un elemento cada vez');
  assert.equal(p.result!.pipeline!.corrections, 2);
});

test('F · una corrección que no cambia el fallo se detecta (sin progreso) y no se repite a ciegas', async () => {
  setRules([{ match: R.fix, responses: [{ text: fix(P('src/catalog.mjs', 'export const RUTAS = [', '// sin efecto\nexport const RUTAS = [')) }, { text: fix(P('src/catalog.mjs', '// sin efecto', '// sin efecto 2')) }] }]);
  const p = await runIt('Diagnóstico · sin progreso', { maxCorrections: 2, maxIdenticalFailures: 5 });
  assert.equal(p.result!.pipeline!.pauseKind, 'limit');
  const [, c2] = byRule(R.fix);
  assert.ok(c2.markers.includes('[no_progress]'), 'la segunda corrección sabe que la anterior no cambió el fallo');
  assert.equal(byRule(R.qa).length, 0, 'sin pagar a QA con pruebas en rojo');
});

test('una prueba ajena que falla una vez se repite SIN IA y no se paga ninguna corrección', async () => {
  smoke = 'flaky'; smokeRuns = 0;
  try {
    setRules([{ match: 'Esta es la unidad 1 de ', text: resp(F('src/catalog.mjs', "export const RUTAS = ['/api/workspaces/:ws/inbox'];\n"), F('test/catalog.test.mjs', TEST)) }]);
    const p = await runIt('Diagnóstico · prueba inestable');
    assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
    assert.equal(byRule(R.fix).length, 0, 'ninguna corrección');
    assert.ok(p.result!.pipeline!.events.some(e => /era una prueba inestable ajena/.test(e.message)));
    assert.equal(p.result!.verifications.filter(v => v.command === 'test').length, 2);
  } finally { smoke = 'ok'; }
});

test('una prueba existente fuera del plan no se modifica para que pase (se rechaza el cambio y decide el propietario)', async () => {
  smoke = 'broken';
  try {
    setRules([{ match: 'Esta es la unidad 1 de ', text: resp(F('src/catalog.mjs', "export const RUTAS = ['/api/workspaces/:ws/inbox'];\n"), F('test/catalog.test.mjs', TEST)) },
      { match: R.fix, text: fix(P('test/smoke.test.mjs', "test('humo', () => {});", "test.skip('humo', () => {});")) }]);
    const p = await runIt('Diagnóstico · prueba existente', { maxCorrections: 2 });
    assert.notEqual(p.result!.pipeline!.state, 'verified');
    assert.match(fs.readFileSync(path.join(p.result!.applied!.worktree!, 'test/smoke.test.mjs'), 'utf8'), /test\('humo'/, 'la prueba sigue intacta');
    assert.ok((p.result!.manifest!.rejected ?? []).some(x => x.path === 'test/smoke.test.mjs' && /ya existía y no está en el plan/.test(x.error ?? '')));
    assert.ok(byRule(R.fix).length >= 1); assert.ok(calls().filter(c => c.rule === R.fix).every(c => c.markers.includes('[existing_test]')), 'el diagnóstico lo advierte');
  } finally { smoke = 'ok'; }
});

test('G/H/I · corrección externa autorizada: se registra con su commit y archivos, se verifica sin IA, conserva todo y no aprueba QA ni integra', async () => {
  setRules([], { match: R.qa, text: QA_OK });
  const p0 = await runIt('Rescate · corrección externa', { maxCorrections: 0 });
  assert.equal(p0.result!.pipeline!.pauseKind, 'limit', p0.result!.pipeline!.reason ?? '');
  const id = p0.id; const wt = p0.result!.applied!.worktree!;
  const before = { steps: p0.steps.length, spent: p0.spentUsd, tokensIn: p0.inputTokens, corrections: p0.result!.pipeline!.corrections, attempts: p0.result!.pipeline!.correctionAttempts ?? 0, events: p0.result!.pipeline!.events.length, verifs: p0.result!.verifications.length, calls: calls().length, commit: p0.result!.applied!.commit, review: p0.result!.review };
  const post = (body: unknown) => app.inject({ method: 'POST', url: `${W}/processes/${id}/external-correction`, payload: body as any });

  // Sin commit nuevo no hay nada que registrar; sin autorización tampoco.
  assert.equal((await post({ authorized: true, note: 'nada' })).json().code, 'nothing_new');
  // Un cambio sin confirmar bloquea (se registra por commit, con sus archivos reales).
  fs.writeFileSync(path.join(wt, 'src/catalog.mjs'), "export const RUTAS = ['/api/workspaces/:ws/inbox'];\n");
  assert.equal((await post({ authorized: true, note: 'sin confirmar' })).json().code, 'dirty');
  // El propietario confirma la corrección desde la consola.
  fs.writeFileSync(path.join(wt, 'src/catalog.mjs'), "// MARCA_CONSOLA\nexport const RUTAS = ['/api/workspaces/:ws/inbox', '/api/budgets/:level/:id/balance'];\n");
  git(wt, 'commit -qam "Corrección desde la consola"');
  const head = git(wt, 'rev-parse --short HEAD');

  // Antes de registrarla, la interfaz ofrece registrarla y NO ofrece continuar; continuar se detiene sin IA.
  const f0 = (await flowOf(id)).guidance.flow;
  assert.equal(f0.actions[0].id, 'register_external'); assert.ok(f0.actions[0].primary); assert.deepEqual(f0.actions[0].external, { commit: head, recorded: before.commit, files: ['src/catalog.mjs'] });
  assert.ok(!f0.actions.some((a: any) => a.id === 'pipeline_resume'));
  const cont = await app.inject({ method: 'POST', url: `${W}/processes/${id}/continue`, payload: { authorized: true } });
  assert.equal(cont.statusCode, 200); const pc = await waitDone(id);
  assert.equal(pc.result!.pipeline!.pauseKind, 'external'); assert.match(pc.result!.pipeline!.reason ?? '', /commits que el equipo no hizo/);
  assert.equal(calls().length, before.calls, 'continuar con un commit sin registrar no llama a la IA');

  assert.equal((await post({ note: 'sin autorización' })).statusCode, 400);
  assert.equal((await post({ authorized: true, commit: 'abcdef0', note: 'no existe' })).json().code, 'unknown_commit');
  const ok = await post({ authorized: true, commit: head, note: 'Rutas reales del servidor (MARCA_CONSOLA)' });
  assert.equal(ok.statusCode, 200, ok.body);
  const p = await waitDone(id); const r = p.result!; const pl = r.pipeline!;
  // Registro fiel: commit y archivos reales; nada de actividad de agentes inventada.
  assert.deepEqual(r.externalCorrections!.map(x => ({ commit: x.commit, previous: x.previousCommit, files: x.files, by: x.by })), [{ commit: head, previous: before.commit, files: ['src/catalog.mjs'], by: 'owner' }]);
  assert.equal(r.applied!.commit, head);
  assert.equal(p.steps.length, before.steps); assert.equal(p.spentUsd, before.spent); assert.equal(p.inputTokens, before.tokensIn);
  assert.equal(pl.corrections, before.corrections); assert.equal(pl.correctionAttempts ?? 0, before.attempts);
  assert.equal(calls().length, before.calls, 'registrar y verificar no llama a la IA');
  // Se conserva todo lo anterior (eventos y verificaciones) y se vuelve a verificar sobre el commit nuevo.
  assert.ok(pl.events.length > before.events); assert.deepEqual(pl.events.slice(0, before.events).map(e => e.message), p0.result!.pipeline!.events.map(e => e.message));
  assert.ok(r.verifications.length > before.verifs); assert.ok(r.verifications.slice(before.verifs).every(v => v.exitCode === 0));
  assert.ok(pl.events.some(e => e.kind === 'external' && /no es trabajo de los agentes/i.test(e.message)));
  assert.equal(pl.state, 'paused'); assert.equal(pl.pauseKind, 'external'); assert.match(pl.reason ?? '', /verificada sin IA/);
  // I · QA separada: nada aprobado ni integrado.
  assert.deepEqual(r.review, before.review); assert.ok(!r.merged);
  const f1 = (await flowOf(id)).guidance.flow;
  const toQa = f1.actions.find((a: any) => a.id === 'pipeline_resume');
  assert.ok(toQa && /Pasar a QA \(sin correcciones nuevas\)/.test(toQa.label)); assert.deepEqual(toQa.pipeline, { maxCorrections: 0 });

  // El propietario decide pasar a QA sin correcciones nuevas: una revisión de QA y ninguna llamada del Desarrollador.
  const res = await app.inject({ method: 'POST', url: `${W}/processes/${id}/continue`, payload: { authorized: true, pipeline: toQa.pipeline } });
  assert.equal(res.statusCode, 200);
  const done = await waitDone(id);
  assert.equal(done.result!.pipeline!.state, 'verified', done.result!.pipeline!.reason ?? '');
  assert.equal(byRule(R.qa).length, 1); assert.equal(byRule(R.fix).length, 0); assert.equal(byRule('Esta es la unidad').length, 0);
  assert.ok(byRule(R.qa)[0].markers.includes('Correcciones externas registradas por el propietario'), 'QA sabe qué hizo el propietario');
  assert.ok(!done.result!.merged, 'nunca se integra solo');
});

test('una corrección externa que toca una ruta protegida no se registra (y el worktree no se mueve)', async () => {
  setRules([]);
  const p0 = await runIt('Rescate · ruta protegida', { maxCorrections: 0 });
  const wt = p0.result!.applied!.worktree!;
  fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n'); git(wt, 'add -f .env'); git(wt, 'commit -qm "toca .env"');
  const head = git(wt, 'rev-parse HEAD');
  const r = await app.inject({ method: 'POST', url: `${W}/processes/${p0.id}/external-correction`, payload: { authorized: true, note: 'protegida' } });
  assert.equal(r.statusCode, 400); assert.equal(r.json().code, 'protected_path');
  assert.equal(processesRepo(S).get(p0.id)!.result!.externalCorrections, undefined);
  assert.equal(git(wt, 'rev-parse HEAD'), head);
});

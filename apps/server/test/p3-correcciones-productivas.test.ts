import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

/**
 * Portal IA 3 · correcciones productivas (reproduce el atasco real de HU-214, siete iteraciones):
 *  A. QA pide una entrada de menú; el equipo entrega el código Y la prueba existente que fija la lista de rutas. Antes el
 *     código se aplicaba, la prueba se rechazaba («ya existía y no está en el plan»), el árbol quedaba en rojo por
 *     construcción y el tope de correcciones detenía la historia. Ahora la prueba vinculada se adapta en la misma entrega.
 *  B. El tope mide falta de progreso: un fallo DISTINTO del anterior obtiene una ronda más (acotada); el MISMO fallo, no.
 *  C. Una prueba que no comprueba nada de lo que la historia cambia sigue sin poder tocarse; debilitarla, tampoco.
 * Proveedor SIMULADO (0 USD); el «sandbox» ejecuta node --test de verdad sobre cada worktree.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3c-'));
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
const { buildApp } = await import('./fixtures/owner-app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { newPipeline, PROGRESS_EXTRA } = await import('../src/services/storyPipeline.ts');
const { coversStoryChange } = await import('../src/services/storyUnits.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');

const S = 'portal-ia';
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3c-repo-'));
const put = (p: string, c: string) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), c); };
const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
put('src/routes.mjs', "export const ROUTES = ['/oficina', '/ajustes'];\n");
put('src/limits.mjs', 'export const LIMIT = 10;\nexport const FLOOR = 1;\n');
put('src/other.mjs', 'export const other = true;\n');
// Prueba «de cableado»: fija la lista exacta de rutas (como portal-ia-2-wiring.test.ts).
put('test/menu-wiring.test.mjs', `${T}import { ROUTES } from '../src/routes.mjs';\ntest('cada seccion del menu tiene su ruta', () => { assert.deepEqual(ROUTES, ['/oficina', '/ajustes']); });\n`);
put('test/limits.test.mjs', `${T}import { LIMIT, FLOOR } from '../src/limits.mjs';\ntest('limite vigente', () => { assert.equal(LIMIT, 10); });\ntest('suelo vigente', () => { assert.equal(FLOOR, 1); });\n`);
put('test/ajena.test.mjs', `${T}import { other } from '../src/other.mjs';\ntest('ajena: no tiene que ver con la historia', () => { assert.equal(other, true); });\n`);
put('package.json', JSON.stringify({ name: 'p3c', version: '1.0.0', private: true, type: 'module', scripts: { typecheck: 'node -e 0', test: 'node --test test/', build: 'node -e 0' } }, null, 2) + '\n');
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { await app.close(); });

const toWork = (out: string, wt: string) => {
  const fwd = wt.split('\\').join('/'); const dbl = wt.split('\\').join('\\\\');
  const s = [dbl, wt, `file:///${fwd}`, fwd].reduce((acc, p) => acc.split(p).join('/work'), out);
  return s.replace(/\/work(?:\\\\|\\|\/)[^'\s)]*/g, m => m.split('\\\\').join('/').split('\\').join('/'));
};
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (wt, _root, command) => {
  const t = new Date().toISOString(); const t0 = Date.now();
  if (command !== 'test') return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' };
  const files = fs.readdirSync(path.join(wt, 'test')).filter(f => f.endsWith('.test.mjs')).map(f => `test/${f}`);
  let exitCode = 0; let output = '';
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  try { output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: wt, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e: any) { exitCode = e.status ?? 1; output = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  return { command, exitCode, output: toWork(output, wt), startedAt: t, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, isolation: 'docker' };
};

type Rule = { match: string; text?: string; responses?: { text: string }[] };
const R = { plan: 'plan técnico', fix: 'Corrige la implementación de esta historia', qa: 'Evalúa la implementación con la EVIDENCIA real', dev: 'Implementa la historia' };
const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple el criterio con evidencia.', findings: [], suggestedTests: [] });
const qaReject = (text: string, file: string) => JSON.stringify({ verdict: 'rejected', summary: 'Falta un requisito del criterio.', findings: [{ severity: 'alta', text, file, evidence: 'revisión del diff', requirement: 'criterio 1', expected: 'añadirlo', verify: 'QA lo comprueba' }], suggestedTests: [] });
const OWNER = '=== PARA EL PROPIETARIO ===\nCambio aplicado.\n=== PRUEBA MANUAL ===\n1. Abre el menú. Esperado: aparece la sección nueva.\n';
const F = (p: string, c: string) => `=== ARCHIVO: ${p} | create ===\n${c}=== FIN ARCHIVO ===\n`;
const P = (p: string, s: string, r: string) => `=== ARCHIVO: ${p} | patch ===\n<<<< BUSCAR\n${s}\n==== REEMPLAZAR\n${r}\n>>>> FIN\n=== FIN ARCHIVO ===\n`;
const resp = (summary: string, ...blocks: string[]) => `=== RESUMEN ===\n${summary}\n${blocks.join('')}${OWNER}`;
const plan = (paths: string[], acceptance: string[]) => JSON.stringify({ summary: 'Cambio acotado.', tasks: paths.map(p => `Entregar ${p}`), filesToRead: ['src/routes.mjs'], filesToChange: paths, deliverables: paths.map(p => ({ path: p, purpose: `Entregable ${p}`, kind: 'code', estimatedLines: 6 })), acceptance, risks: [] });
function setRules(planText: string, rules: Rule[], qa: Rule = { match: R.qa, text: QA_OK }) {
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: R.plan, text: planText }, ...rules, qa] }));
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
function newRun(title: string, criterion: string, cfg: Partial<typeof DEFAULT_PIPELINE> = {}) {
  const it = addManualItem(S, project.id, { title, criterion });
  const p = createStoryProcess(S, project.id, it.id);
  processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, gauntlet: { mode: 'off' }, maxCorrections: 1, ...cfg } as any)) });
  processesRepo(S).authorize(p.id, 5);
  return p.id;
}
const run = async (id: string) => { await runStory(S, id, () => undefined, () => false); return processesRepo(S).get(id)!; };
const why = (p: any) => `${p.result.pipeline.reason ?? ''} | ${JSON.stringify(p.result.pipeline.events.slice(-8).map((e: any) => [e.message, e.detail]))} | rechazados: ${JSON.stringify(p.result.manifest?.rejected ?? [])}`;
const reset = () => execSync('git checkout -q main', { cwd: repo });

test('vínculo objetivo (sin IA): una prueba «cubre» un cambio si nombra, importa o lee el archivo cambiado', () => {
  assert.equal(coversStoryChange("import { ROUTES } from '../src/routes.mjs';", ['src/routes.mjs']), true);
  assert.equal(coversStoryChange("const src = read('apps/web/src/lib/routes.ts');", ['apps/web/src/lib/routes.ts']), true);
  assert.equal(coversStoryChange("import { x } from '../src/routes';", ['src/routes.mjs']), true);
  assert.equal(coversStoryChange("import { other } from '../src/other.mjs';", ['src/routes.mjs']), false);
  assert.equal(coversStoryChange('', ['src/routes.mjs']), false);
});

test('A · HU-214: QA pide la entrada de menú y el equipo adapta en la MISMA corrección la prueba que fija las rutas: termina verificada, con la prueba registrada', async () => {
  reset();
  setRules(plan(['src/ediciones.mjs'], ['Existe la pantalla de ediciones y se llega a ella desde el menú']), [
    { match: R.fix, text: resp('QA tiene razón: falta la entrada del menú. La añado y adapto la prueba que fija la lista de rutas.',
      P('src/routes.mjs', "['/oficina', '/ajustes']", "['/oficina', '/ajustes', '/ediciones']"),
      P('test/menu-wiring.test.mjs', "assert.deepEqual(ROUTES, ['/oficina', '/ajustes']);", "assert.deepEqual(ROUTES, ['/oficina', '/ajustes', '/ediciones']);")) },
    { match: R.dev, text: resp('Pantalla nueva.', F('src/ediciones.mjs', 'export const screen = "ediciones";\n')) }
  ], { match: R.qa, responses: [{ text: qaReject('No hay enlace a la pantalla en la navegación: src/routes.mjs no tiene la ruta /ediciones.', 'src/routes.mjs') }, { text: QA_OK }] });
  const p = await run(newRun('Pantalla de ediciones', 'Existe la pantalla de ediciones y se llega a ella desde el menú.'));
  const pl = p.result!.pipeline!; const man = p.result!.manifest!;
  assert.equal(pl.state, 'verified', why(p));
  assert.equal(pl.corrections, 1, 'una sola corrección: código y prueba juntos');
  assert.deepEqual((man.rejected ?? []).filter(r => r.error), [], 'nada se rechazó por las reglas de entrega');
  assert.ok(man.testUpdates?.some(u => u.path === 'test/menu-wiring.test.mjs'), 'la prueba existente modificada queda registrada para QA y el propietario');
  assert.match(fs.readFileSync(path.join(p.result!.applied!.worktree!, 'test/menu-wiring.test.mjs'), 'utf8'), /'\/ediciones'\]/);
});

test('B · progreso: si la corrección arregla un fallo y aparece OTRO distinto, se concede una ronda más (acotada) en vez de detenerse en el tope', async () => {
  reset();
  setRules(plan(['src/limits.mjs'], ['El límite pasa a 20 y el suelo a 2']), [
    { match: R.fix, responses: [
      { text: resp('La prueba del límite fija el valor anterior; la adapto.', P('test/limits.test.mjs', 'assert.equal(LIMIT, 10);', 'assert.equal(LIMIT, 20);')) },
      { text: resp('La prueba del suelo fija el valor anterior; la adapto.', P('test/limits.test.mjs', 'assert.equal(FLOOR, 1);', 'assert.equal(FLOOR, 2);')) }
    ] },
    { match: R.dev, text: resp('Sube los dos valores.', P('src/limits.mjs', 'export const LIMIT = 10;\nexport const FLOOR = 1;', 'export const LIMIT = 20;\nexport const FLOOR = 2;')) }
  ]);
  const p = await run(newRun('Límites nuevos', 'El límite pasa a 20 y el suelo a 2.', { maxCorrections: 1 }));
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', why(p));
  assert.equal(pl.corrections, 2, 'la segunda ronda se concedió porque el fallo había cambiado');
  assert.ok(pl.corrections <= 1 + PROGRESS_EXTRA);
  assert.ok(pl.events.some(e => /ya pasa: la corrección previa avanzó/.test(e.message)), 'el registro explica por qué siguió');
});

test('B · sin progreso: el MISMO fallo tras corregir se detiene en el tope (no gasta rondas extra)', async () => {
  reset();
  setRules(plan(['src/limits.mjs'], ['El límite pasa a 30']), [
    { match: R.fix, text: resp('Añado un comentario (no arregla nada).', P('src/limits.mjs', 'export const FLOOR = 1;', 'export const FLOOR = 1; // sin cambios reales')) },
    { match: R.dev, text: resp('Sube el límite.', P('src/limits.mjs', 'export const LIMIT = 10;', 'export const LIMIT = 30;')) }
  ]);
  const p = await run(newRun('Límite 30', 'El límite pasa a 30.', { maxCorrections: 1 }));
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'stopped', why(p));
  assert.ok(['limit', 'repeated_failure'].includes(pl.pauseKind!), pl.pauseKind ?? '');
  assert.ok(pl.corrections <= 1, 'no se concedieron rondas extra al mismo fallo');
});

test('C · la protección sigue: una prueba que no comprueba nada de lo que la historia cambia no se toca; y una vinculada no se puede debilitar', async () => {
  reset();
  setRules(plan(['src/routes.mjs'], ['Hay una ruta /lotes']), [
    { match: R.fix, text: resp('Sin cambios.') },
    { match: R.dev, text: resp('Añade la ruta e intenta tocar una prueba ajena y vaciar la vinculada.',
      P('src/routes.mjs', "['/oficina', '/ajustes']", "['/oficina', '/ajustes', '/lotes']"),
      P('test/ajena.test.mjs', 'assert.equal(other, true);', 'assert.equal(other, false);'),
      P('test/menu-wiring.test.mjs', "assert.deepEqual(ROUTES, ['/oficina', '/ajustes']);", '/* sin comprobación */')) }
  ]);
  const p = await run(newRun('Ruta de lotes', 'Hay una ruta /lotes.', { maxCorrections: 0 }));
  const rej = (p.result!.manifest!.rejected ?? []).filter(r => r.error);
  assert.ok(rej.some(r => r.path === 'test/ajena.test.mjs' && /ya existía y no está en el plan/.test(r.error!)), JSON.stringify(rej));
  assert.ok(rej.some(r => r.path === 'test/menu-wiring.test.mjs' && /debilitaría la verificación/.test(r.error!)), JSON.stringify(rej));
  const wt = p.result!.applied!.worktree!;
  assert.match(fs.readFileSync(path.join(wt, 'test/ajena.test.mjs'), 'utf8'), /equal\(other, true\)/, 'la prueba ajena queda intacta');
  assert.match(fs.readFileSync(path.join(wt, 'test/menu-wiring.test.mjs'), 'utf8'), /deepEqual\(ROUTES/, 'la vinculada conserva su aserción');
});

test('D · iterar CONTINÚA sobre la misma rama: no se borra ni se rehace lo hecho; «Aplicar los cambios pedidos» termina el trabajo', async () => {
  reset();
  setRules(plan(['src/limits.mjs'], ['El limite pasa a 40']), [
    { match: R.fix, text: resp('Comentario sin efecto.', P('src/limits.mjs', 'export const FLOOR = 1;', 'export const FLOOR = 1; // nada')) },
    { match: R.dev, text: resp('Sube el limite.', P('src/limits.mjs', 'export const LIMIT = 10;', 'export const LIMIT = 40;')) }
  ]);
  const id = newRun('Limite 40', 'El limite pasa a 40.', { maxCorrections: 1 });
  const p0 = await run(id);
  assert.equal(p0.result!.pipeline!.state, 'stopped', why(p0));
  const branch = p0.result!.applied!.branch; const wt = p0.result!.applied!.worktree!;
  const before = execSync(`git rev-list --count ${branch}`, { cwd: repo, encoding: 'utf8' }).trim();
  const W = `/api/workspaces/${S}`;
  const it = await app.inject({ method: 'POST', url: `${W}/stories/${p0.backlogItemId}/iterate`, payload: { note: 'La prueba del limite debe esperar 40.' } });
  assert.equal(it.statusCode, 201, it.body);
  const body = it.json();
  assert.equal(body.continued, true, 'no crea un proceso nuevo desde main');
  assert.equal(body.process.id, id, 'es el MISMO proceso');
  assert.ok(fs.existsSync(wt), 'el worktree sigue vivo');
  assert.ok(execSync('git branch --list ' + branch, { cwd: repo, encoding: 'utf8' }).includes(branch), 'la rama no se borró');
  const view = (await app.inject({ method: 'GET', url: `${W}/processes/${id}` })).json();
  const labels = JSON.stringify(view).match(/Aplicar los cambios pedidos/);
  assert.ok(labels, 'la pantalla ofrece «Aplicar los cambios pedidos»');
  setRules(plan(['src/limits.mjs'], ['El limite pasa a 40']), [
    { match: R.fix, text: resp('Adapto la prueba del limite al valor nuevo.', P('test/limits.test.mjs', 'assert.equal(LIMIT, 10);', 'assert.equal(LIMIT, 40);')) },
    { match: R.dev, text: resp('No debería llamarse: no se rehace la implementación.', F('src/rehecho.mjs', 'export const rehecho = true;\n')) }
  ]);
  const c = await app.inject({ method: 'POST', url: `${W}/processes/${id}/continue`, payload: { authorized: true, budgetUsd: 5 } });
  assert.equal(c.statusCode, 200, c.body);
  const end = Date.now() + 60_000; let p = processesRepo(S).get(id)!;
  while (p.status === 'running' || p.result!.pipeline!.state === 'running') { if (Date.now() > end) throw new Error('tiempo agotado'); await new Promise(r => setTimeout(r, 30)); p = processesRepo(S).get(id)!; }
  assert.equal(p.result!.pipeline!.state, 'verified', why(p));
  assert.ok(!fs.existsSync(path.join(wt, 'src/rehecho.mjs')), 'la implementación no se rehízo');
  assert.match(fs.readFileSync(path.join(wt, 'src/limits.mjs'), 'utf8'), /LIMIT = 40/, 'lo ya hecho se conservó');
  assert.ok(Number(execSync(`git rev-list --count ${branch}`, { cwd: repo, encoding: 'utf8' }).trim()) > Number(before), 'se añadieron commits sobre la misma rama');
});

test('E · falta una herramienta del Portal (axe-core): se reconoce como entorno, no como fallo del trabajo', async () => {
  const { isVisualToolMissing } = await import('../src/services/gauntlet.ts');
  assert.equal(isVisualToolMissing('Evidencia visual pendiente en el host (commit 91de370): verificación no disponible: axe-core no está instalado (npm i -D axe-core o PORTAL_AXE) · faltan capturas: /oficina@375'), true);
  assert.equal(isVisualToolMissing('Evidencia visual pendiente en el host (commit abc1234): desbordamiento horizontal en /oficina@375 (12 px)'), false);
  // (Gauntlet M1) «No disponible» porque la vista previa no arrancó o el proceso seguía en marcha NO es una herramienta que falte.
  const BUSY = 'Evidencia visual pendiente en el host (commit 1a2b3c4): verificación no disponible · última ejecución: no se pudo ejecutar en el host: La historia está trabajando: su código aún cambia.';
  assert.equal(isVisualToolMissing(BUSY), false);
  const { buildStoryFlow } = await import('../src/services/storyFlow.ts');
  const mk = (reason: string): any => ({ id: 'p-visual', kind: 'story_execution', status: 'done', projectId: 'p1', backlogItemId: 'b1', estimatedUsd: 0, steps: [], createdAt: new Date().toISOString(), result: {
    changes: [{ path: 'apps/web/src/screens/Backlog.tsx', content: 'x' }], applied: { branch: 'story/x', commit: '1a2b3c4', worktree: repo }, verifications: [],
    gauntlet: { mode: 'auto', maxRounds: 1, status: 'stopped', reason: null, rounds: [] },
    pipeline: { state: 'paused', pauseKind: 'gauntlet', reason, config: { ...DEFAULT_PIPELINE }, failures: [], events: [], corrections: 0 } } });
  const missing: any = buildStoryFlow(mk('Evidencia visual pendiente en el host (commit 1a2b3c4): verificación no disponible: axe-core no está instalado (npm i -D axe-core o PORTAL_AXE) · faltan capturas: /oficina@375.'));
  assert.match(missing.issue.title, /Falta una herramienta de comprobación visual del Portal/);
  assert.match(missing.issue.explanation, /axe-core no está instalado/, 'la causa real sigue a la vista');
  assert.ok(!missing.actions.some((a: any) => /Preparar una iteración/.test(a.label)), 'rehacer la historia no instala la herramienta');
  assert.ok(missing.actions.some((a: any) => a.primary && /Repetir la verificación visual/.test(a.label)));
  const busy: any = buildStoryFlow(mk(BUSY));
  assert.doesNotMatch(busy.issue.title, /Falta una herramienta/, 'la pausa por proceso en marcha conserva su título propio');
  assert.ok(busy.actions.some((a: any) => /Preparar una iteración/.test(a.label)), 'y sus acciones de siempre');
  const root = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.match(root.devDependencies['axe-core'] ?? '', /^\d+\.\d+\.\d+$/, 'axe-core está declarado y fijado: una instalación limpia puede pasar la puerta visual');
});

test('F · (Gauntlet B1) una prueba vinculada sin evidencia de base solo puede adaptar valores: ni cambiar el tipo de comprobacion, ni aserciones triviales, ni renombrar casos', async () => {
  const { weakensUnprovenUpdate } = await import('../src/services/testUpdateRules.ts');
  const before = "test('devuelve 409', () => { assert.equal(res.status, 409); assert.match(body, /conflicto/); });\n";
  assert.equal(weakensUnprovenUpdate(before, before.replace('409);', '410);')), null, 'adaptar el valor esperado se permite');
  assert.match(weakensUnprovenUpdate(before, before.replace('assert.equal(res.status, 409)', 'assert.ok(true)')) ?? '', /tipo|siempre pasa/);
  assert.match(weakensUnprovenUpdate(before, before.replace('assert.match(', 'assert.doesNotMatch(')) ?? '', /tipo/);
  assert.match(weakensUnprovenUpdate(before, before.replace("'devuelve 409'", "'otra cosa'")) ?? '', /renombra o quita/);
  assert.match(weakensUnprovenUpdate(before, before + "test('extra', () => { assert.ok(true); });\n") ?? '', /siempre pasa/);
  assert.match(weakensUnprovenUpdate(before, before.replace("test('devuelve", "test.skip('devuelve")) ?? '', /skip/);
  // El vinculo exige una ruta o un import entre comillas: un nombre suelto en un comentario no vale.
  assert.equal(coversStoryChange('// ver routes.mjs para el detalle\n', ['src/routes.mjs']), false);
  assert.equal(coversStoryChange("import x from './api.ts';", ['src/a.ts']), false);
});

test('F · (Gauntlet B1) en el pipeline: reescribir la asercion de una prueba vinculada para que pase se RECHAZA y la prueba queda intacta', async () => {
  reset();
  setRules(plan(['src/routes.mjs'], ['Hay una ruta /archivo']), [
    { match: R.fix, text: resp('Sin cambios.') },
    { match: R.dev, text: resp('Anade la ruta y neutraliza la prueba.',
      P('src/routes.mjs', "['/oficina', '/ajustes']", "['/oficina', '/ajustes', '/archivo']"),
      P('test/menu-wiring.test.mjs', "assert.deepEqual(ROUTES, ['/oficina', '/ajustes']);", 'assert.ok(true);')) }
  ]);
  const p = await run(newRun('Ruta de archivo', 'Hay una ruta /archivo.', { maxCorrections: 0 }));
  const rej = (p.result!.manifest!.rejected ?? []).filter(r => r.error);
  assert.ok(rej.some(r => r.path === 'test/menu-wiring.test.mjs' && /debilitar/.test(r.error!)), JSON.stringify(rej));
  assert.match(fs.readFileSync(path.join(p.result!.applied!.worktree!, 'test/menu-wiring.test.mjs'), 'utf8'), /deepEqual\(ROUTES, \['\/oficina', '\/ajustes'\]\)/);
  assert.notEqual(p.result!.pipeline!.state, 'verified', 'con la prueba intacta y en rojo, no se da por verificada');
});

test('G · (Gauntlet M5) progreso = algo de lo que fallaba ya no falla; A -> A+B es una regresion y no concede rondas', async () => {
  const { verificationProgress } = await import('../src/services/storyPipeline.ts');
  const f = (...s: string[]) => s.map(signature => ({ signature }));
  assert.equal(verificationProgress(f('test|a:uno,a:dos'), 'test', 'test|a:dos'), true, 'uno se arreglo');
  assert.equal(verificationProgress(f('test|a:uno'), 'test', 'test|b:otro'), true, 'el anterior desaparecio');
  assert.equal(verificationProgress(f('test|a:uno'), 'test', 'test|a:uno,b:otro'), false, 'regresion: sigue lo anterior y hay mas');
  assert.equal(verificationProgress(f('test|a:uno'), 'test', 'test|a:uno'), false, 'el mismo fallo');
  assert.equal(verificationProgress(f('qa|x', 'output|y'), 'test', 'test|a:uno'), false, 'las firmas de QA o de formato no cuentan como verificacion previa');
  assert.equal(verificationProgress(f('typecheck|e1'), 'test', 'test|a:uno'), false, 'otro comando no es referencia');
  assert.equal(verificationProgress([], 'test', 'test|a:uno'), false);
});

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

/**
 * Pipeline autónomo autorizado (implementar → recuperar/reparar la entrega → aplicar → verificar → QA con evidencia →
 * correcciones acotadas). Proveedor SIMULADO (0 USD), datos y repositorio sintéticos. A, B, F y G usan un sandbox
 * determinista sustituido en la prueba (orden y decisiones del pipeline); C, D y E usan el sandbox Docker REAL si está
 * disponible (si no, se omiten y lo dicen). Escenarios del encargo: A formato mal formado recuperable sin IA ·
 * B respuesta cortada con reparación acotada (plan reutilizado) · C pipeline completo en Docker con QA sobre evidencia ·
 * D error de código con corrección y re-verificación · E faltan dependencias: instalación autorizada sin IA ·
 * F presupuesto insuficiente: pausa sin llamar a la IA y continuar · G fallo repetido: límite y explicación.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-pipe-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory, parseFileBlocks } = await import('../src/services/storyExecution.ts');
const { newPipeline } = await import('../src/services/storyPipeline.ts');
const { assessDeveloperOutput, parseUnifiedDiff } = await import('../src/services/devOutput.ts');
const { enforceQaGate, parseQaVerdict } = await import('../src/services/qaGate.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { depsVolumeName, dockerCliEnv, SANDBOX_IMAGE } = await import('../src/services/sandbox.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const real = { ...sandboxDeps };

// ---------- Unidades: contrato de salida del Desarrollador ----------
test('contrato: distingue implementación, sin cambios, cortada, incompleta, mal formada y bloqueo por información (sin inventar cambios)', () => {
  const exists = (p: string) => p === 'src/a.ts';
  const ev = (t: string, stop: string | null = 'end_turn') => assessDeveloperOutput(t, { stopReason: stop, exists }).assessment;
  assert.equal(ev('=== RESUMEN ===\nx\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===').kind, 'implementation');
  assert.equal(ev('=== RESUMEN ===\nNada que tocar.\n=== SIN CAMBIOS ===\nEl botón ya existe en Backlog.tsx.').kind, 'no_changes');
  const cut = ev('=== ARCHIVO: src/b.ts | create ===\nexport const b =', 'max_tokens'); assert.equal(cut.kind, 'truncated'); assert.equal(cut.truncatedFile, 'src/b.ts');
  assert.equal(ev('=== ARCHIVO: src/a.ts | patch ===\n=== FIN ARCHIVO ===').kind, 'incomplete');
  assert.equal(ev('Aquí tienes el código:\n```ts\nexport const a = 2;\n```').kind, 'malformed', 'un fragmento suelto para un archivo existente no se acepta');
  const refused = ev('No puedo completar la tarea sin ver el contenido de src/a.ts.');
  // HU-155: pedir un archivo para poder seguir es información que falta, no una negativa del proveedor.
  assert.equal(refused.kind, 'blocked'); assert.equal(refused.blocker?.type, 'information'); assert.deepEqual(refused.requestedFiles, ['src/a.ts']);
  assert.equal(ev('Hecho, he revisado la historia.').kind, 'malformed', 'un texto sin artefactos no es una implementación');
});

test('contrato: recupera variantes reales sin IA (acción en español, marcadores de git, sin cierre, diff unificado, archivo nuevo en bloque)', () => {
  const exists = (p: string) => p === 'src/a.ts';
  const variant = '=== RESUMEN ===\nx\n=== ARCHIVO: src/a.ts | parche ===\n<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE\n=== PRUEBA MANUAL ===\n1. Abre X. Esperado: Y.';
  assert.equal(parseFileBlocks(variant).changes.length, 0, 'el lector estricto de antes no veía nada (caso HU-155)');
  const a = assessDeveloperOutput(variant, { stopReason: 'end_turn', exists });
  assert.equal(a.assessment.kind, 'implementation'); assert.equal(a.assessment.recoveredBy, 'lenient-format');
  assert.deepEqual(a.parsed.changes[0].edits, [{ search: 'export const a = 1;', replace: 'export const a = 2;' }]);
  assert.deepEqual(a.parsed.manualSteps, ['Abre X. Esperado: Y.']);
  // Un cierre olvidado no fusiona dos archivos (antes, el segundo bloque acababa dentro del primero)
  const two = assessDeveloperOutput('=== ARCHIVO: src/x.ts | create ===\nexport const x = 1;\n=== ARCHIVO: src/y.ts | create ===\nexport const y = 1;\n=== FIN ARCHIVO ===', { stopReason: 'end_turn', exists });
  assert.deepEqual(two.parsed.changes.map(c => [c.path, c.content]), [['src/x.ts', 'export const x = 1;\n'], ['src/y.ts', 'export const y = 1;\n']]);
  const diff = parseUnifiedDiff('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n', []);
  assert.deepEqual(diff, [{ path: 'src/a.ts', action: 'patch', content: null, edits: [{ search: 'export const a = 1;', replace: 'export const a = 2;' }] }]);
  const fenced = assessDeveloperOutput('### src/nuevo.ts\n```ts\nexport const n = 1;\n```', { stopReason: 'end_turn', exists });
  assert.equal(fenced.assessment.recoveredBy, 'fenced-new-files'); assert.equal(fenced.parsed.changes[0].action, 'create');
  // Un «=====» de subrayado markdown dentro de un parche canónico es contenido, no separador
  const md = assessDeveloperOutput('=== ARCHIVO: README.md | patch ===\n<<<< BUSCAR\nTítulo\n=====\n==== REEMPLAZAR\nTítulo nuevo\n=====\n>>>> FIN\n=== FIN ARCHIVO ===', { stopReason: 'end_turn', exists: () => true });
  assert.deepEqual(md.parsed.changes[0].edits, [{ search: 'Título\n=====', replace: 'Título nuevo\n=====' }]);
});

test('puerta de QA: la verificación automática prevalece sobre la opinión; un rechazo sin evidencia no es accionable', () => {
  const run = (command: string, exitCode: number | null, output = '') => ({ command, exitCode, output, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1000, isolation: 'docker' as const });
  const approved = parseQaVerdict('{"verdict":"approved","summary":"Bien","findings":[],"suggestedTests":[]}');
  const overridden = enforceQaGate(approved, ['typecheck', 'test'], [run('typecheck', 2, "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."), run('test', 0)]);
  assert.equal(overridden.verdict, 'rejected'); assert.equal(overridden.approve, false); assert.match(overridden.overridden!, /prevalece/);
  assert.equal(enforceQaGate(approved, ['typecheck', 'test'], [run('typecheck', 0)]).verdict, 'unable_to_verify', 'sin «test» en verde no se aprueba');
  assert.equal(enforceQaGate(approved, ['typecheck'], [run('typecheck', 86)]).verdict, 'blocked_environment');
  const vague = parseQaVerdict('{"verdict":"rejected","summary":"No me convence","findings":[{"severity":"media","text":"Mejorar","file":null,"evidence":null}],"suggestedTests":[]}');
  assert.equal(enforceQaGate(vague, [], []).verdict, 'unable_to_verify');
  assert.equal(parseQaVerdict('no es JSON').verdict, 'unable_to_verify');
  assert.equal(parseQaVerdict('{"approve": true, "summary": "ok", "issues": []}').verdict, 'approved', 'compatible con el formato antiguo');
});

// ---------- Entorno de procesos ----------
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-pipe-repo-'));
const uniq = `pipe-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, 'src/notes.ts'), 'export const n = 0;\n');
// «typecheck» real y sin dependencias: imprime un error TS2322 si a es un string anotado como number.
fs.writeFileSync(path.join(repo, 'scripts/tc.mjs'), "import fs from 'node:fs';\nconst src = fs.readFileSync('src/a.ts', 'utf8');\nif (/: number = \"/.test(src)) { console.log(\"src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\"); process.exit(2); }\nconsole.log('sin errores');\n");
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node scripts/tc.mjs', test: 'node -e "console.log(\'1 prueba ok\')"', build: 'node -e "console.log(\'build ok\')"' } }, null, 2));
fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: uniq, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.0' } } }, null, 2));
// Base fechada en el pasado: la guarda «el archivo cambió después de que el Desarrollador lo leyera» compara la fecha
// del commit (resolución de 1 s) con la del proceso; con la base en el mismo segundo, un ajuste del reloj de la VM de
// Docker Desktop podía dispararla al azar dentro del sandbox.
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();

const PLAN = '{"summary":"Cambiar a","tasks":["Editar src/a.ts"],"filesToRead":["src/a.ts"],"filesToChange":["src/a.ts"],"acceptance":["a = 2"],"risks":[]}';
const OWNER = '=== PARA EL PROPIETARIO ===\nEl contador muestra 2.\n=== PRUEBA MANUAL ===\n1. Abre el contador. Esperado: muestra 2.';
const patchA = (to: string) => `=== RESUMEN ===\nCambia a.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\n${to}\n>>>> FIN\n=== FIN ARCHIVO ===\n${OWNER}`;
const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple el criterio; typecheck, test y build en verde.', findings: [], suggestedTests: [] });
const MARKERS = ['typecheck: OK', 'TS2322', 'Ya recibidos y válidos', 'Entrega SOLO', 'src/b.ts', 'Corrección 1 aplicada', 'FALLÓ'];
type Rule = { match: string; text?: string; stopReason?: string };
/** Reglas en orden (la primera que encaja responde): reparación y corrección van antes que la implementación. */
function setScript(rules: { dev: string; devStop?: string; repair?: string; correction?: string; qa?: string; continuation?: Rule }) {
  const r: Rule[] = [{ match: 'plan técnico', text: PLAN }];
  if (rules.continuation) r.push(rules.continuation);
  r.push({ match: 'Tu entrega anterior para esta historia no se pudo convertir', text: rules.repair ?? patchA('export const a = 2;') });
  r.push({ match: 'Corrige la implementación de esta historia', text: rules.correction ?? patchA('export const a = 2;') });
  r.push({ match: 'Evalúa la implementación con la EVIDENCIA real', text: rules.qa ?? QA_OK });
  r.push({ match: 'Implementa la historia', text: rules.dev, stopReason: rules.devStop ?? 'end_turn' });
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: r, markers: MARKERS }));
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const clearLog = () => { try { fs.unlinkSync(logPath); } catch { /* vacío */ } };
const byRule = (c: any[], match: string) => c.filter(x => x.rule === match);
const R = { plan: 'plan técnico', dev: 'Implementa la historia', repair: 'Tu entrega anterior para esta historia no se pudo convertir', fix: 'Corrige la implementación de esta historia', qa: 'Evalúa la implementación con la EVIDENCIA real' };

/** Sandbox determinista (sustituto de pruebas): typecheck falla con TS2322 si src/a.ts anota un string como number. */
let onTypecheck: (() => void) | null = null;
function useFakeSandbox() {
  sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
  sandboxDeps.run = async (wt, _root, command) => {
    const t = new Date().toISOString();
    let exitCode = 0; let output = `${command} ok`;
    if (command === 'typecheck') { onTypecheck?.(); if (/: number = "/.test(fs.readFileSync(path.join(wt, 'src/a.ts'), 'utf8'))) { exitCode = 2; output = "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."; } }
    return { command, exitCode, output, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' };
  };
}
function useRealSandbox() { sandboxDeps.detect = real.detect; sandboxDeps.run = real.run; }

async function runWithPipeline(title: string, cfg: Partial<typeof DEFAULT_PIPELINE> = {}, budget = 2) {
  const it = addManualItem(S, project.id, { title, criterion: 'a vale 2 (número)' });
  const p = createStoryProcess(S, project.id, it.id);
  processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, ...cfg })) });
  processesRepo(S).authorize(p.id, budget);
  await runStory(S, p.id, () => undefined, () => false);
  return { it, p: processesRepo(S).get(p.id)! };
}
const flowOf = async (id: string) => (await app.inject({ method: 'GET', url: `${W}/processes/${id}` })).json();
const waitDone = async (id: string) => { for (let i = 0; i < 1800; i++) { const p = processesRepo(S).get(id)!; if (p.status !== 'running') return p; await new Promise(r => setTimeout(r, 100)); } throw new Error('el proceso no terminó'); };

test('A · formato mal formado: recuperación local sin IA y el pipeline sigue (sin llamadas extra)', async () => {
  useFakeSandbox(); clearLog();
  setScript({ dev: '=== RESUMEN ===\nCambia a.\n=== ARCHIVO: src/a.ts | parche ===\n<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE\n' + OWNER });
  const { p } = await runWithPipeline('A · formato no canónico');
  assert.equal(p.status, 'done', p.error ?? '');
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  assert.equal(pl.lastAssessment?.recoveredBy, 'lenient-format');
  assert.ok(pl.events.some(e => e.kind === 'recovery' && /Recuperando los cambios existentes sin consumir IA/.test(e.message)));
  const c = calls();
  assert.equal(byRule(c, R.repair).length, 0, 'sin reparación con IA'); assert.equal(byRule(c, R.fix).length, 0);
  assert.equal(c.length, 3, 'plan + implementación + QA: ninguna llamada adicional');
  assert.equal(pl.outputRepairs, 0);
  assert.ok(p.result!.applied?.worktree, 'aplicado en el worktree');
  assert.equal(fs.readFileSync(path.join(repo, 'src/a.ts'), 'utf8'), 'export const a = 1;\n', 'tu carpeta no cambia');
  const served = await flowOf(p.id);
  assert.equal(served.guidance.flow.headline, 'Implementación verificada por QA — lista para revisión del propietario.');
  assert.equal(served.guidance.flow.current, 'integrate'); assert.ok(!p.result!.merged, 'nunca integra solo');
});

test('A2 · caso HU-155: un fallo de formato antiguo se clasifica como contrato de salida (no entorno) y se recupera sin IA', async () => {
  clearLog();
  const it = addManualItem(S, project.id, { title: 'A2 · fallo antiguo' });
  const p = createStoryProcess(S, project.id, it.id);
  const dev = p.steps.find(s => s.role === 'implementer')!;
  processesRepo(S).stepFinish(dev.id, 'done', { outputMd: '=== RESUMEN ===\nx\n=== ARCHIVO: src/a.ts | modificar ===\n<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 3;\n>>>>>>> REPLACE\n' });
  processesRepo(S).finish(p.id, 'failed', 'El Desarrollador no entregó ningún archivo en el formato acordado. Revisa su salida en el paso 2.');
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.issue.kind, 'output_contract'); assert.equal(flow.issue.cause, 'code', 'no es un problema del entorno');
  assert.deepEqual(flow.actions.map((a: any) => a.id).slice(0, 2), ['recover', 'repair_output']);
  const rec = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/recover` });
  assert.equal(rec.statusCode, 200, rec.body);
  assert.equal(rec.json().result.changes[0].content, 'export const a = 3;\n');
  assert.equal(calls().length, 0, 'la recuperación no llama a la IA');
});

test('B · respuesta cortada: la recuperación local no basta → reparación acotada del mismo Desarrollador, con el plan reutilizado', async () => {
  useFakeSandbox(); clearLog();
  const cut = `=== RESUMEN ===\nDos archivos.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== ARCHIVO: src/b.ts | create ===\nexport const b =`;
  setScript({ dev: cut, devStop: 'max_tokens', continuation: { match: 'Continúa EXACTAMENTE', text: '', stopReason: 'max_tokens' }, repair: '=== RESUMEN ===\nFalta b.\n=== ARCHIVO: src/b.ts | create ===\nexport const b = 2;\n=== FIN ARCHIVO ===' });
  const { p } = await runWithPipeline('B · respuesta cortada');
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  const c = calls();
  assert.equal(byRule(c, R.plan).length, 1, 'el Coordinador planifica una sola vez (no se repite el plan)');
  const rep = byRule(c, R.repair); assert.equal(rep.length, 1, 'una reparación acotada');
  assert.ok(rep[0].markers.includes('Ya recibidos y válidos') && rep[0].markers.includes('Entrega SOLO') && rep[0].markers.includes('src/b.ts'), 'pide solo lo que falta y conserva lo válido');
  assert.equal(pl.outputRepairs, 1);
  assert.deepEqual(p.result!.changes.map(x => x.path).sort(), ['src/a.ts', 'src/b.ts']);
  assert.ok(pl.events.some(e => e.kind === 'repair' && /Corrigiendo la entrega del Desarrollador dentro del presupuesto autorizado/.test(e.message)));
  const repairStep = p.steps.find(s => /^Reparación de la entrega/.test(s.title))!;
  assert.ok(repairStep.costUsd > 0 && repairStep.inputTokens > 0, 'la reparación tiene su propio registro de tokens y costo');
});

// ---------- Docker real (C, D, E) ----------
// Docker Desktop cargado (otras pruebas en paralelo) puede tardar en responder: se confirma antes de omitir.
let dockerReady = (await real.detect(true)).available === 'docker';
for (let i = 0; i < 3 && !dockerReady; i++) { await new Promise(r => setTimeout(r, 2000)); dockerReady = (await real.detect(true)).available === 'docker'; }
// Con PORTAL_REQUIRE_DOCKER=1 (verificación final) no se omite nada: si Docker no responde, la prueba FALLA.
const requireDocker = process.env.PORTAL_REQUIRE_DOCKER === '1';
const skipDocker = dockerReady || requireDocker ? false : 'Docker no disponible en este equipo: C, D y E necesitan el sandbox real';
test('Docker disponible para las pruebas reales (obligatorio con PORTAL_REQUIRE_DOCKER=1)', { skip: requireDocker ? false : 'solo se exige con PORTAL_REQUIRE_DOCKER=1' }, () => { assert.ok(dockerReady, 'Docker no está disponible: C, D, E y E2 no pueden ejecutarse'); });

test('E · faltan dependencias (86 real): instalación autorizada sin IA y la verificación continúa', { skip: skipDocker }, async () => {
  useRealSandbox(); clearLog(); setScript({ dev: patchA('export const a = 2;') });
  const { p } = await runWithPipeline('E · dependencias', { allowInstall: true });
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  const seq = p.result!.verifications.map(v => `${v.command}:${v.exitCode}`);
  assert.deepEqual(seq.slice(0, 3), ['typecheck:86', 'install:0', 'typecheck:0'], seq.join(' '));
  assert.ok(pl.events.some(e => e.kind === 'environment' && /instalándolas con red temporal/.test(e.message)));
  const c = calls(); assert.equal(c.length, 3, 'plan + implementación + QA: el entorno se resolvió sin IA');
  assert.equal(byRule(c, R.fix).length + byRule(c, R.repair).length, 0);
});

test('E2 · sin autorización de red: se pausa y lo explica; «Continuar» con la instalación autorizada termina sin IA extra', { skip: skipDocker }, async () => {
  useRealSandbox(); clearLog(); setScript({ dev: patchA('export const a = 2;') });
  // Otro package-lock (otro volumen): vuelve a faltar dependencias.
  const it = addManualItem(S, project.id, { title: 'E2 · sin red' });
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: uniq, version: '1.0.1', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.1' } } }, null, 2));
  execSync('git -c user.email=t@t -c user.name=t commit -qam lock2', { cwd: repo });
  const p0 = createStoryProcess(S, project.id, it.id);
  processesRepo(S).setResult(p0.id, { ...p0.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, allowInstall: false })) });
  processesRepo(S).authorize(p0.id, 2); await runStory(S, p0.id, () => undefined, () => false);
  let p = processesRepo(S).get(p0.id)!;
  assert.equal(p.result!.pipeline!.state, 'paused'); assert.equal(p.result!.pipeline!.pauseKind, 'network');
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.issue.kind, 'pipeline_paused'); assert.equal(flow.issue.cause, 'environment');
  const act = flow.actions.find((a: any) => a.id === 'pipeline_resume'); assert.deepEqual(act.pipeline, { allowInstall: true }); assert.ok(act.requires.includes('network'));
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/continue`, payload: { pipeline: { allowInstall: true } } })).statusCode, 400, 'continuar exige autorización');
  const before = calls().length;
  const cont = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/continue`, payload: { authorized: true, pipeline: { allowInstall: true } } });
  assert.equal(cont.statusCode, 200, cont.body);
  p = await waitDone(p.id);
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  assert.equal(calls().length - before, 1, 'al continuar solo se llama a QA (la instalación no usa IA)');
  const v = p.result!.verifications.map(x => `${x.command}:${x.exitCode}`); assert.ok(v.includes('install:0'), v.join(' '));
  assert.deepEqual(v, ['typecheck:86', 'install:0', 'typecheck:0', 'test:0', 'build:0'], 'al continuar no se repite la comprobación bloqueada: directo a instalar');
});

test('C · pipeline completo en Docker: aplicar, typecheck/test/build en verde, QA recibe la evidencia y aprueba; espera al propietario', { skip: skipDocker }, async () => {
  useRealSandbox(); clearLog(); setScript({ dev: patchA('export const a = 2;') });
  const { p } = await runWithPipeline('C · pipeline completo', { allowInstall: true });
  const pl = p.result!.pipeline!; const r = p.result!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  for (const cmd of ['typecheck', 'test', 'build']) assert.ok(r.verifications.some(v => v.command === cmd && v.exitCode === 0 && v.isolation === 'docker'), `${cmd} en Docker`);
  const qa = byRule(calls(), R.qa); assert.equal(qa.length, 1);
  assert.ok(qa[0].markers.includes('typecheck: OK'), 'QA recibe el resultado real de la verificación');
  assert.equal(qa[0].schema, 'veredicto_qa', 'el veredicto se pide con salida estructurada nativa');
  assert.equal(r.review?.verdict, 'approved'); assert.equal(r.review?.evidenceBased, true);
  assert.ok(!r.merged && !r.published, 'no integra ni publica');
  assert.ok(fs.existsSync(r.applied!.worktree!)); assert.equal(fs.readFileSync(path.join(r.applied!.worktree!, 'src/a.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const a = 2;\n');
  assert.ok(pl.events.at(-1)!.message.startsWith('Implementación completada. Typecheck, pruebas y compilación aprobados. QA validó los cambios.'), pl.events.at(-1)!.message);
  assert.equal((await flowOf(p.id)).guidance.flow.headline, 'Implementación verificada por QA — lista para revisión del propietario.');
});

test('D · error de código: typecheck falla en Docker → corrección con el diagnóstico → re-verificación → QA evalúa lo corregido', { skip: skipDocker }, async () => {
  useRealSandbox(); clearLog();
  setScript({ dev: patchA('export const a: number = "2";'), correction: '=== RESUMEN ===\nTipo corregido.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a: number = "2";\n==== REEMPLAZAR\nexport const a: number = 2;\n>>>> FIN\n=== FIN ARCHIVO ===' });
  const { p } = await runWithPipeline('D · error de tipos', { allowInstall: true });
  const pl = p.result!.pipeline!; const r = p.result!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  const c = calls();
  const fix = byRule(c, R.fix); assert.equal(fix.length, 1, 'una corrección');
  assert.ok(fix[0].markers.includes('TS2322') && fix[0].markers.includes('FALLÓ'), 'el Desarrollador recibe el diagnóstico real');
  assert.equal(byRule(c, R.plan).length, 1, 'sin volver a planificar');
  const tcs = r.verifications.filter(v => v.command === 'typecheck').map(v => v.exitCode); assert.deepEqual(tcs.slice(-2), [2, 0]);
  const qa = byRule(c, R.qa); assert.equal(qa.length, 1); assert.ok(qa[0].markers.includes('Corrección 1 aplicada'), 'QA ve el intento anterior');
  assert.equal(pl.corrections, 1);
  assert.match(r.changes.find(x => x.path === 'src/a.ts')!.diff!, /\+export const a: number = 2;/, 'el diff final es acumulado respecto a main');
  assert.ok(pl.events.some(e => /QA detectó errores de compilación\. El equipo está preparando una corrección\./.test(e.message)));
});

test('F · presupuesto: la siguiente corrección no cabe → pausa SIN llamar a la IA, conserva lo hecho; continuar con más presupuesto termina', async () => {
  useFakeSandbox(); clearLog();
  setScript({ dev: patchA('export const a: number = "2";'), correction: '=== RESUMEN ===\nTipo.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a: number = "2";\n==== REEMPLAZAR\nexport const a: number = 2;\n>>>> FIN\n=== FIN ARCHIVO ===' });
  // Al verificar, el presupuesto restante queda casi agotado (como si se hubiera gastado en otra cosa autorizada).
  let pid = '';
  onTypecheck = () => { const cur = processesRepo(S).get(pid); if (cur && cur.status === 'running') processesRepo(S).authorize(pid, cur.spentUsd + 0.001); };
  const it = addManualItem(S, project.id, { title: 'F · presupuesto' });
  const p0 = createStoryProcess(S, project.id, it.id); pid = p0.id;
  processesRepo(S).setResult(p0.id, { ...p0.result!, pipeline: newPipeline(normalizePipeline(DEFAULT_PIPELINE)) });
  processesRepo(S).authorize(p0.id, 2); await runStory(S, p0.id, () => undefined, () => false);
  onTypecheck = null;
  let p = processesRepo(S).get(p0.id)!;
  const pl = p.result!.pipeline!;
  assert.equal(p.status, 'done'); assert.equal(pl.state, 'paused'); assert.equal(pl.pauseKind, 'budget');
  assert.equal(byRule(calls(), R.fix).length, 0, 'ninguna llamada no autorizada');
  assert.ok(p.spentUsd <= p.budgetUsd + 1e-9, 'nunca se supera el presupuesto');
  assert.ok(p.result!.applied && p.result!.verifications.some(v => v.exitCode === 2), 'lo hecho (aplicado y verificado) se conserva');
  assert.match(pl.reason!, /superaría el presupuesto autorizado/);
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.issue.kind, 'pipeline_paused'); assert.equal(flow.actions[0].id, 'pipeline_resume'); assert.ok(flow.actions[0].requires.includes('ai_budget'));
  // Antes de continuar: lo ya hecho (pasos, su costo y la verificación) queda fijado.
  const stepsBefore = p.steps.filter(s => s.status === 'done').map(s => ({ id: s.id, cost: s.costUsd, tokens: s.inputTokens + s.outputTokens }));
  const spentBefore = p.spentUsd; const applyCommit = p.result!.applied!.commit; const callsBefore = calls().length;
  const idsBefore = new Set(p.steps.map(s => s.id));
  const cont = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/continue`, payload: { authorized: true, addBudgetUsd: 1 } });
  assert.equal(cont.statusCode, 200, cont.body);
  p = await waitDone(p.id);
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  assert.equal(byRule(calls(), R.fix).length, 1); assert.equal(byRule(calls(), R.plan).length, 1, 'continuar no repite el plan');
  // Continuar no repite ni vuelve a cobrar lo hecho: los pasos anteriores no cambian y el gasto nuevo es exactamente el de los pasos nuevos.
  for (const s of stepsBefore) { const now = p.steps.find(x => x.id === s.id)!; assert.equal(now.costUsd, s.cost); assert.equal(now.inputTokens + now.outputTokens, s.tokens); }
  const newSteps = p.steps.filter(s => !idsBefore.has(s.id));
  assert.equal(newSteps.length, 2, `solo se añadieron la corrección y la revisión de QA: ${newSteps.map(s => s.title).join(' | ')}`);
  assert.equal(newSteps[0].title, 'Corrección 1'); assert.match(newSteps[1].title, /^Revisión de QA con evidencia/);
  assert.ok(Math.abs(p.spentUsd - spentBefore - newSteps.reduce((a, s) => a + s.costUsd, 0)) < 1e-9, 'el gasto nuevo es solo el de los pasos nuevos');
  assert.equal(calls().length - callsBefore, 2, 'al continuar: corrección + QA (sin plan ni implementación de nuevo)');
  assert.notEqual(p.result!.applied!.commit, applyCommit, 'la corrección es un commit nuevo sobre el worktree aplicado (no se vuelve a aplicar desde cero)');
  assert.equal(p.result!.verifications.filter(v => v.command === 'install').length, 0);
});

test('Docker no disponible: el pipeline se pausa como problema del entorno, sin llamar a QA ni a correcciones; «Continuar» retoma cuando vuelve', async () => {
  useFakeSandbox(); clearLog(); setScript({ dev: patchA('export const a = 2;') });
  sandboxDeps.detect = async () => ({ available: 'unavailable', docker: false, wsl: false, detail: 'Docker no responde (simulado)', checkedAt: new Date().toISOString() });
  const { p } = await runWithPipeline('Sin Docker');
  const pl = p.result!.pipeline!;
  assert.equal(p.status, 'done'); assert.equal(pl.state, 'paused'); assert.equal(pl.pauseKind, 'environment');
  assert.match(pl.reason!, /No es un fallo del código/);
  assert.equal(p.result!.verifications.length, 0, 'no se ejecutó nada fuera del sandbox');
  assert.equal(calls().length, 2, 'plan + implementación: ni QA ni correcciones sin evidencia');
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.issue.kind, 'pipeline_paused'); assert.equal(flow.issue.cause, 'environment');
  assert.ok(flow.actions.some((a: any) => a.id === 'refresh_sandbox') && flow.actions.some((a: any) => a.id === 'pipeline_resume' && !a.requires.includes('ai_budget')));
  useFakeSandbox(); // vuelve el sandbox
  const cont = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/continue`, payload: { authorized: true } });
  assert.equal(cont.statusCode, 200, cont.body);
  const done = await waitDone(p.id);
  assert.equal(done.result!.pipeline!.state, 'verified'); assert.equal(calls().length, 3, 'al continuar solo se añade QA');
});

test('QA rechaza con hallazgos y evidencia → corrección con esos hallazgos → QA vuelve a evaluar y aprueba', async () => {
  useFakeSandbox(); clearLog();
  const reject = JSON.stringify({ verdict: 'rejected', summary: 'Falta exportar el tipo.', findings: [{ severity: 'alta', text: 'El valor no se documenta en src/a.ts', file: 'src/a.ts', evidence: '+export const a = 2;' }], suggestedTests: [] });
  // Primera evaluación: rechaza. Segunda (lleva el rechazo en «Intentos anteriores»): aprueba.
  fs.writeFileSync(scriptPath, JSON.stringify({ markers: ['El valor no se documenta en src/a.ts', 'QA rechazó'], rules: [
    { match: 'plan técnico', text: PLAN },
    { match: 'Corrige la implementación de esta historia', text: '=== RESUMEN ===\nDocumentado.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 2;\n==== REEMPLAZAR\n/** Valor del contador. */\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===' },
    { match: 'Evalúa la implementación con la EVIDENCIA real[\\s\\S]*QA rechazó', text: QA_OK },
    { match: 'Evalúa la implementación con la EVIDENCIA real', text: reject },
    { match: 'Implementa la historia', text: patchA('export const a = 2;') }] }));
  const { p } = await runWithPipeline('QA rechaza');
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? ''); assert.equal(pl.corrections, 1);
  const c = calls();
  const fix = byRule(c, R.fix); assert.equal(fix.length, 1); assert.ok(fix[0].markers.includes('El valor no se documenta en src/a.ts'), 'la corrección recibe el hallazgo de QA');
  assert.equal(c.filter(x => /EVIDENCIA real/.test(x.rule ?? '')).length, 2, 'QA evalúa de nuevo tras la corrección');
  assert.equal(p.result!.review?.verdict, 'approved');
  assert.match(fs.readFileSync(path.join(p.result!.applied!.worktree!, 'src/a.ts'), 'utf8'), /Valor del contador/);
  assert.ok(pl.events.some(e => /QA rechazó la implementación\. El equipo está preparando una corrección/.test(e.message)));
});

test('límites de autorización: ningún pipeline integra, reinicia ni publica; nada de eso se concede sin autorización', async () => {
  const { workspaceDb } = await import('../src/db/workspace.ts');
  const kinds = (workspaceDb(S).prepare(`SELECT kind FROM execution_history WHERE kind LIKE 'policy:%'`).all() as any[]).map(r => r.kind as string);
  for (const op of ['git_merge', 'git_push', 'restart_portal']) assert.ok(!kinds.some(k => k.startsWith(`policy:${op}:`)), `ninguna concesión de ${op} durante los pipelines`);
  assert.ok(kinds.some(k => k.startsWith('policy:write_worktree:granted')) && kinds.some(k => k.startsWith('policy:ai_call:granted')), 'las operaciones del pipeline sí pasan por la política');
  for (const p of processesRepo(S).list(project.id)) { assert.ok(!p.result?.merged, `${p.title}: no integrado`); assert.ok(!p.result?.published, `${p.title}: no publicado`); }
  const any = processesRepo(S).list(project.id).find(p => p.result?.applied?.worktree && !p.result.merged)!;
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${any.id}/merge`, payload: {} })).statusCode, 400, 'integrar exige autorización');
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${any.id}/publish`, payload: {} })).statusCode, 400, 'publicar exige autorización');
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${any.id}/continue`, payload: {} })).statusCode, 400, 'continuar exige autorización');
});

test('G · fallo repetido: la misma corrección no arregla nada → se detiene por fallo repetido, sin bucle, con explicación', async () => {
  useFakeSandbox(); clearLog();
  // La «corrección» toca otro archivo y deja el error de tipos intacto.
  setScript({ dev: patchA('export const a: number = "2";'), correction: '=== RESUMEN ===\nRevisado.\n=== ARCHIVO: src/notes.ts | patch ===\n<<<< BUSCAR\nexport const n = 0;\n==== REEMPLAZAR\nexport const n = 0; // revisado\n>>>> FIN\n=== FIN ARCHIVO ===' });
  const { p } = await runWithPipeline('G · fallo repetido', { maxCorrections: 5, maxIdenticalFailures: 2 });
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'stopped'); assert.equal(pl.pauseKind, 'repeated_failure');
  assert.equal(byRule(calls(), R.fix).length, 2, 'dos intentos y se detiene (no agota las 5 correcciones)');
  assert.match(pl.reason!, /se repitió 3 veces/);
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.issue.kind, 'pipeline_stopped'); assert.equal(flow.issue.cause, 'code');
  assert.ok(flow.issue.details.some((d: any) => d.code === 'TS2322'), 'muestra el diagnóstico');
  assert.ok(p.result!.applied && fs.existsSync(p.result!.applied.worktree!), 'el trabajo hecho se conserva');
});

test('entrega sin formato reconocible (sin pipeline): falla como contrato de salida del agente, no como entorno ni como parche', async () => {
  clearLog();
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: 'plan técnico', text: PLAN }, { match: 'Implementa la historia', text: 'He revisado la historia y el cambio consiste en actualizar el contador a 2.' }] }));
  const it = addManualItem(S, project.id, { title: 'Sin formato' });
  const p0 = createStoryProcess(S, project.id, it.id); processesRepo(S).authorize(p0.id, 2);
  await runStory(S, p0.id, () => undefined, () => false);
  const p = processesRepo(S).get(p0.id)!;
  assert.equal(p.status, 'failed'); assert.equal(p.result!.failure?.kind, 'output_contract'); assert.equal(p.result!.failure?.assessment?.kind, 'malformed');
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.issue.kind, 'output_contract'); assert.equal(flow.issue.cause, 'code');
  assert.ok(flow.actions.some((a: any) => a.id === 'repair_output'));
  assert.equal(calls().length, 2, 'sin pipeline autorizado no se gasta en reparar: plan + implementación');
});

test('sin pipeline (API antigua): el comportamiento manual de siempre, con la recuperación nueva', async () => {
  useFakeSandbox(); clearLog();
  setScript({ dev: patchA('export const a = 2;') });
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: 'plan técnico', text: PLAN }, { match: 'Revisa los cambios propuestos', text: '{"approve": true, "summary": "ok", "issues": [], "suggestedTests": []}' }, { match: 'Implementa la historia', text: patchA('export const a = 2;') }] }));
  const it = addManualItem(S, project.id, { title: 'Sin pipeline' });
  const p0 = createStoryProcess(S, project.id, it.id); processesRepo(S).authorize(p0.id, 2);
  await runStory(S, p0.id, () => undefined, () => false);
  const p = processesRepo(S).get(p0.id)!;
  assert.equal(p.status, 'done'); assert.equal(p.result!.pipeline, null); assert.equal(p.result!.applied, null, 'no aplica solo');
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.current, 'review'); assert.ok(flow.actions.some((a: any) => a.id === 'pipeline_resume'), 'ofrece continuar automáticamente');
});

after(async () => {
  useRealSandbox();
  await app.close();
  if (dockerReady) for (const v of ['1.0.0', '1.0.1']) {
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-pipe-vol-'));
      fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({ name: uniq, version: v, lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: v } } }, null, 2));
      execFileSync('docker', ['volume', 'rm', '-f', depsVolumeName(tmp, SANDBOX_IMAGE)], { env: dockerCliEnv(), stdio: 'ignore' });
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch { /* limpieza best effort */ }
  }
});

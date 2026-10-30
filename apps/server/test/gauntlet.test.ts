import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Evaluación Gauntlet en el pipeline existente. Proveedor SIMULADO (0 USD), sandbox determinista sustituido en la
 * prueba, datos y repositorio sintéticos. Escenarios: A constructor ≠ crítico con contexto nuevo · B sin autoaprobación ·
 * C hallazgos con evidencia (los demás no motivan correcciones) · D rondas acotadas y pausa con lo pendiente · E sin
 * repetir trabajo (ni QA tras una corrección del Evaluador, ni la evaluación de un commit ya decidido) · Q el Evaluador
 * solo existe con aprobación explícita, con permisos mínimos y su jefe · R las brechas entran en el ciclo de lecciones
 * existente (detectada → validada por el propietario → inyectada → medida), nunca solas.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-gauntlet-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, decideGauntlet, gauntletOverhead, normalizeGauntlet, recommendGauntlet } = await import('@portal-ia/domain');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess } = await import('../src/services/storyExecution.ts');
const { parseGauntlet, projectEvaluator } = await import('../src/services/gauntlet.ts');
const { lessonsRepo, validateLesson } = await import('../src/services/lessons.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;

// ---------- Unidades: puerta de evidencia y decisión determinista ----------
test('C · puerta de evidencia: un hallazgo sin evidencia se registra pero no motiva correcciones; «pass» incoherente no pasa', () => {
  const g = parseGauntlet(JSON.stringify({ verdict: 'pass', criteria: [{ criterion: 'a vale 2', status: 'unmet', evidence: 'src/a.ts:1 a = 1' }], findings: [{ severity: 'blocking', criterion: 'a vale 2', text: 'a sigue valiendo 1', file: 'src/a.ts', evidence: 'src/a.ts:1 export const a = 1;', expected: 'a = 2' }, { severity: 'major', criterion: null, text: 'No me convence', file: null, evidence: null, expected: null }], largestGap: 'a = 1', anotherRoundWorthIt: true, limitations: [] }));
  assert.equal(g.verdict, 'gaps', 'un criterio incumplido no es «pass»');
  assert.equal(g.findings[1].unsupported, true);
  assert.ok(g.limitations.some(l => /sin evidencia/.test(l)));
  const d = decideGauntlet(normalizeGauntlet({ mode: 'standard' }), [{ ...g, decision: 'pass' }], 3);
  assert.equal(d.decision, 'correct'); assert.deepEqual(d.toFix.map(f => f.text), ['a sigue valiendo 1'], 'solo lo que tiene evidencia');
  assert.equal(parseGauntlet('no es JSON').verdict, 'cannot_evaluate');
  const onlyVague = parseGauntlet(JSON.stringify({ verdict: 'gaps', criteria: [], findings: [{ severity: 'blocking', text: 'Mal', evidence: '' }], largestGap: null, anotherRoundWorthIt: true, limitations: [] }));
  assert.equal(decideGauntlet(normalizeGauntlet({ mode: 'deep' }), [{ ...onlyVague, decision: 'pass' }], 3).decision, 'pass', 'sin evidencia no hay corrección');
});

test('D · decisión acotada: límite de rondas, sin progreso, ganancia marginal y sin correcciones autorizadas', () => {
  const f = (text: string, severity: 'blocking' | 'major' = 'blocking') => ({ severity, criterion: null, text, file: 'src/a.ts', evidence: 'src/a.ts:1 fragmento', expected: null });
  const round = (findings: any[], decision: 'pass' | 'correct' | 'stop' = 'pass', anotherRoundWorthIt = true) => ({ verdict: 'gaps' as const, findings, anotherRoundWorthIt, decision });
  const std = normalizeGauntlet({ mode: 'standard' });
  assert.equal(std.maxRounds, 1); assert.equal(normalizeGauntlet({ mode: 'deep', maxRounds: 99 }).maxRounds, 3, 'deep nunca supera 3'); assert.equal(normalizeGauntlet({ mode: 'deep' }).maxRounds, 2);
  assert.equal(normalizeGauntlet({ mode: 'x' as any }).mode, 'off');
  const limit = decideGauntlet(std, [round([f('X')], 'correct'), round([f('Y')])], 5);
  assert.equal(limit.decision, 'stop'); assert.equal(limit.status, 'stopped'); assert.match(limit.reason, /límite de 1/);
  const same = decideGauntlet(normalizeGauntlet({ mode: 'deep', maxRounds: 3 }), [round([f('Falta doble en a')], 'correct'), round([f('Falta doble en a')])], 5);
  assert.equal(same.decision, 'stop'); assert.match(same.reason, /misma brecha persiste/);
  assert.equal(decideGauntlet(normalizeGauntlet({ mode: 'deep', maxRounds: 3 }), [round([f('Falta doble en a')], 'correct'), round([f('Falta doble en a')], 'stop')], 5, { ownerGranted: true }).decision, 'correct', 'el propietario puede conceder otra ronda');
  const marginal = decideGauntlet(std, [round([f('Nombre poco claro', 'major')], 'pass', false)], 5);
  assert.equal(marginal.decision, 'stop'); assert.equal(marginal.status, 'passed_with_findings');
  assert.equal(decideGauntlet(std, [round([f('X')])], 0).reason, 'No quedan correcciones autorizadas en este proceso.');
  assert.deepEqual(gauntletOverhead(normalizeGauntlet({ mode: 'off' })), { evaluations: { min: 0, max: 0 }, corrections: { min: 0, max: 0 } });
  assert.deepEqual(gauntletOverhead(normalizeGauntlet({ mode: 'deep' })), { evaluations: { min: 1, max: 3 }, corrections: { min: 0, max: 2 } });
});

test('recomendación sin IA: tarea pequeña sin riesgo → off; riesgo o fallos repetidos → deep; sin Evaluador → off', () => {
  assert.equal(recommendGauntlet({ hasEvaluator: true, estimate: 'S', text: 'Cambiar el texto del botón', iterations: 1, qaRejections: 0 }).mode, 'off');
  assert.equal(recommendGauntlet({ hasEvaluator: true, estimate: 'M', text: 'Cambiar el texto del botón', iterations: 1, qaRejections: 0 }).mode, 'standard');
  const risky = recommendGauntlet({ hasEvaluator: true, estimate: 'L', text: 'Permisos y presupuesto de los agentes', iterations: 1, qaRejections: 0 });
  assert.equal(risky.mode, 'deep'); assert.ok(risky.signals.length >= 2);
  assert.equal(recommendGauntlet({ hasEvaluator: false, estimate: 'L', text: 'seguridad', iterations: 5, qaRejections: 3 }).mode, 'off');
});

// ---------- Entorno de procesos ----------
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-gauntlet-repo-'));
const uniq = `gauntlet-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node -e ""', test: 'node -e ""', build: 'node -e ""' } }, null, 2));
fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: uniq, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.0' } } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { await app.close(); });

// Sandbox determinista: todo en verde (la prueba es del flujo de evaluación, no de la verificación).
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { const t = new Date().toISOString(); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: t, durationMs: 5, isolation: 'docker' }; };

const PLAN = '{"summary":"Cambiar a y exportar doble","tasks":["Editar src/a.ts"],"filesToRead":["src/a.ts"],"filesToChange":["src/a.ts"],"acceptance":["a vale 2","existe doble = a * 2"],"risks":[]}';
const OWNER = '=== PARA EL PROPIETARIO ===\nEl contador muestra 2.\n=== PRUEBA MANUAL ===\n1. Abre el contador. Esperado: muestra 2.';
const DEV = `=== RESUMEN ===\nRAZONAMIENTO-CONSTRUCTOR: decidí no exportar doble porque no hace falta.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n${OWNER}`;
const FIX1 = '=== RESUMEN ===\nExporta doble.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 2;\n==== REEMPLAZAR\nexport const a = 2;\nexport const doble = a * 2;\n>>>> FIN\n=== FIN ARCHIVO ===';
const FIX2 = '=== RESUMEN ===\nAjuste.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const doble = a * 2;\n==== REEMPLAZAR\nexport const doble: number = a * 2;\n>>>> FIN\n=== FIN ARCHIVO ===';
const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple; typecheck, test y build en verde.', findings: [], suggestedTests: [] });
const GAPS = JSON.stringify({ verdict: 'gaps', criteria: [{ criterion: 'a vale 2', status: 'met', evidence: 'src/a.ts:1 export const a = 2;' }, { criterion: 'existe doble = a * 2', status: 'unmet', evidence: 'el diff no define doble' }], findings: [{ severity: 'blocking', criterion: 'existe doble = a * 2', text: 'FALTA-DOBLE: no se exporta doble = a * 2', file: 'src/a.ts', evidence: 'src/a.ts:1 solo contiene «export const a = 2;»', expected: 'export const doble = a * 2;' }, { severity: 'major', criterion: null, text: 'SIN-EVIDENCIA-XYZ el estilo no me convence', file: null, evidence: null, expected: null }], largestGap: 'No se exporta doble', anotherRoundWorthIt: true, limitations: [] });
const PASS = JSON.stringify({ verdict: 'pass', criteria: [{ criterion: 'a vale 2', status: 'met', evidence: 'src/a.ts:1' }, { criterion: 'existe doble = a * 2', status: 'met', evidence: 'src/a.ts:2 export const doble = a * 2;' }], findings: [], largestGap: null, anotherRoundWorthIt: false, limitations: [] });
const MARKERS = ['RAZONAMIENTO-CONSTRUCTOR', 'NO son evidencia', 'El contador muestra 2', 'FALTA-DOBLE', 'SIN-EVIDENCIA-XYZ', 'Rondas anteriores'];
const R = { ev: 'Evalúa de forma INDEPENDIENTE', plan: 'plan técnico', fix: 'Corrige la implementación de esta historia', qa: 'Evalúa la implementación con la EVIDENCIA real', dev: 'Implementa la historia' };
function setScript(evaluator: string[], fixes: string[] = [FIX1, FIX2]) {
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  fs.writeFileSync(scriptPath, JSON.stringify({ markers: MARKERS, rules: [
    { match: R.ev, responses: evaluator.map(text => ({ text })) },
    { match: R.plan, text: PLAN },
    { match: R.fix, responses: fixes.map(text => ({ text })) },
    { match: R.qa, text: QA_OK },
    { match: R.dev, text: DEV }
  ] }));
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const byRule = (match: string) => calls().filter(x => x.rule === match);
const waitDone = async (id: string) => { for (let i = 0; i < 1800; i++) { const p = processesRepo(S).get(id)!; if (p.status !== 'running') return p; await new Promise(r => setTimeout(r, 50)); } throw new Error('el proceso no terminó'); };
const flowOf = async (id: string) => (await app.inject({ method: 'GET', url: `${W}/processes/${id}` })).json().guidance.flow;
async function authorize(title: string, pipeline: Record<string, unknown> = {}) {
  const it = addManualItem(S, project.id, { title, criterion: 'a vale 2 y existe doble' });
  const p = createStoryProcess(S, project.id, it.id);
  const res = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/authorize`, payload: { budgetUsd: 3, authorized: true, pipeline: { maxCorrections: 3, ...pipeline } } });
  assert.equal(res.statusCode, 200, res.body);
  return { it, p: await waitDone(p.id) };
}

test('sin Evaluador en el proyecto: Gauntlet no se aplica (lo dice) y el pipeline es el de siempre, sin llamadas extra', async () => {
  setScript([PASS]);
  assert.equal(projectEvaluator(S, project.id), null, 'el Evaluador no existe hasta que el propietario lo aprueba');
  const { p } = await authorize('Sin Evaluador', { gauntlet: { mode: 'standard' } });
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  assert.ok(pl.events.some(e => e.kind === 'gauntlet' && /no aplicado: No hay un Evaluador/.test(e.message)));
  assert.equal(p.result!.gauntlet?.status, 'skipped');
  assert.equal(byRule(R.ev).length, 0); assert.equal(calls().length, 3, 'plan + implementación + QA');
});

test('Q · el Evaluador Gauntlet solo existe con aprobación explícita: plantilla versionada, solo lectura, jefe el Coordinador', async () => {
  const info = (await app.inject({ method: 'GET', url: `${W}/projects/${project.id}/gauntlet` })).json();
  assert.equal(info.evaluator, null); assert.equal(info.config.mode, 'off'); assert.equal(info.template.reportsTo, 'pj-coordinador');
  const denied = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/gauntlet/evaluator`, payload: {} });
  assert.equal(denied.statusCode, 400); assert.equal(denied.json().code, 'authorization_required');
  assert.equal(projectEvaluator(S, project.id), null);
  const res = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/gauntlet/evaluator`, payload: { authorized: true } });
  assert.equal(res.statusCode, 201, res.body);
  const ev = res.json();
  assert.equal(ev.key, 'pj-gauntlet'); assert.equal(ev.projectId, project.id); assert.equal(ev.template.reportsTo, 'pj-coordinador');
  assert.deepEqual(ev.config.capabilities, ['evaluar_gauntlet']);
  assert.equal(ev.config.tools.read_repo, true);
  assert.ok(!Object.entries(ev.config.tools).some(([k, v]) => k !== 'read_repo' && v), 'herramientas mínimas: solo lectura del repositorio');
  assert.equal(ev.templateId, 'tpl.project.gauntlet@1', 'plantilla versionada (v1 = la del código; las prácticas promovidas crean versiones nuevas)');
  const coord = agentsRepo(S).byKey('pj-coordinador', project.id)!;
  assert.ok(coord.template.supervises.includes('pj-gauntlet'), 'el Coordinador lo supervisa');
  assert.equal((await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/gauntlet/evaluator`, payload: { authorized: true } })).statusCode, 409, 'uno por proyecto');
  // Otro proyecto no lo ve (aislamiento por proyecto).
  assert.equal(projectEvaluator(S, 'otro-proyecto'), null);
});

test('A + C + E · ciclo completo: crítico distinto con contexto nuevo, corrección dirigida con evidencia y re-evaluación sin repetir QA', async () => {
  setScript([GAPS, PASS]);
  const { p } = await authorize('A-C-E ciclo', { gauntlet: { mode: 'standard' } });
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  // A: el Evaluador es otro agente; nunca implementa.
  const dev = p.steps.find(s => s.role === 'implementer')!.agentId;
  const evSteps = p.steps.filter(s => s.role === 'evaluator');
  assert.equal(evSteps.length, 2, 'dos rondas trazables en process_steps');
  assert.ok(evSteps.every(s => s.agentId !== dev && s.status === 'done'));
  const fixSteps = p.steps.filter(s => s.role !== 'evaluator' && /corrección/i.test(s.title));
  assert.ok(fixSteps.length >= 1 && fixSteps.every(s => s.agentId === dev), `la corrección la hace el constructor, no el Evaluador: ${p.steps.map(s => `${s.role}:${s.title}`).join(' | ')}`);
  // A: contexto nuevo — ni el razonamiento del constructor ni su resumen; sus afirmaciones van marcadas como no-evidencia.
  const evCalls = byRule(R.ev);
  assert.equal(evCalls.length, 2);
  assert.ok(evCalls.every(c => !c.markers.includes('RAZONAMIENTO-CONSTRUCTOR')), 'el Evaluador no recibe la explicación del constructor');
  assert.ok(evCalls[0].markers.includes('NO son evidencia') && evCalls[0].markers.includes('El contador muestra 2'));
  assert.ok(evCalls[1].markers.includes('Rondas anteriores'), 'la segunda ronda comprueba si la brecha sigue');
  assert.equal(evCalls[0].schema, 'gauntlet_evaluation', 'salida estructurada');
  // C: la corrección lleva SOLO el hallazgo con evidencia.
  const fix = byRule(R.fix);
  assert.equal(fix.length, 1);
  assert.ok(fix[0].markers.includes('FALTA-DOBLE')); assert.ok(!fix[0].markers.includes('SIN-EVIDENCIA-XYZ'), 'un hallazgo sin evidencia no se corrige');
  // E: QA no repite la revisión tras la corrección del Evaluador; el plan y la implementación no se repiten.
  assert.equal(byRule(R.qa).length, 1); assert.equal(byRule(R.plan).length, 1); assert.equal(byRule(R.dev).length, 1);
  const g = p.result!.gauntlet!;
  assert.equal(g.status, 'passed'); assert.deepEqual(g.rounds.map(r => r.decision), ['correct', 'pass']);
  assert.ok(g.rounds[0].findings.find(f => /SIN-EVIDENCIA/.test(f.text))!.unsupported);
  assert.notEqual(g.rounds[0].commit, g.rounds[1].commit, 'cada ronda evalúa un commit distinto');
  assert.equal(g.rounds[1].commit, p.result!.applied!.commit);
  assert.equal(fs.readFileSync(path.join(p.result!.applied!.worktree!, 'src/a.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const a = 2;\nexport const doble = a * 2;\n', 'se conserva lo hecho y se añade solo lo pedido');
  assert.match(pl.events.at(-1)!.message, /Gauntlet \(standard\): todos los criterios con evidencia en 2 ronda/);
  const flow = await flowOf(p.id);
  assert.equal(flow.current, 'integrate', 'lista para tu revisión; nunca integra sola');
  assert.ok(!p.result!.merged);
});

test('D + E · acotado: la misma brecha tras corregirla detiene el ciclo; conceder otra ronda no re-evalúa el mismo commit', async () => {
  setScript([GAPS, GAPS, PASS]);
  const { p } = await authorize('D acotado', { gauntlet: { mode: 'standard' } });
  let pl = p.result!.pipeline!;
  assert.equal(pl.state, 'stopped'); assert.equal(pl.pauseKind, 'gauntlet');
  assert.match(pl.reason!, /brechas bloqueantes/); assert.match(pl.reason!, /Lo hecho se conserva/);
  assert.equal(p.result!.gauntlet!.status, 'stopped');
  assert.equal(byRule(R.ev).length, 2); assert.equal(byRule(R.fix).length, 1); assert.equal(byRule(R.qa).length, 1);
  const flow = await flowOf(p.id);
  assert.equal(flow.issue.title, 'El Evaluador Gauntlet dejó brechas bloqueantes: decides tú');
  assert.ok(flow.issue.details.some((d: any) => /FALTA-DOBLE/.test(d.text) && /evidencia/.test(d.text)));
  assert.ok(!flow.issue.details.some((d: any) => /SIN-EVIDENCIA/.test(d.text)));
  const grant = flow.actions.find((a: any) => a.id === 'pipeline_resume' && /otra corrección dirigida/.test(a.label));
  assert.deepEqual(grant.pipeline, { maxCorrections: 1, gauntlet: { mode: 'deep', maxRounds: 2 } });
  assert.ok(flow.actions.some((a: any) => a.id === 'pipeline_resume' && /sin más evaluación/.test(a.label)));
  const res = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/continue`, payload: { authorized: true, addBudgetUsd: 0.5, pipeline: grant.pipeline } });
  assert.equal(res.statusCode, 200, res.body);
  const done = await waitDone(p.id); pl = done.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  assert.equal(byRule(R.ev).length, 3, 'el commit detenido NO se evalúa otra vez: solo el nuevo');
  assert.equal(byRule(R.fix).length, 2); assert.equal(byRule(R.qa).length, 1, 'QA no repite');
  const g = done.result!.gauntlet!;
  assert.deepEqual(g.rounds.map(r => r.decision), ['correct', 'correct', 'pass']);
  assert.match(g.rounds[1].reason, /El propietario concedió otra corrección/);
  assert.ok(g.rounds.length <= 1 + 3, 'nunca más de 3 correcciones del Evaluador');
});

test('E · continuar sin más evaluación tras la detención: sin IA, sin repetir QA ni la evaluación; las brechas quedan documentadas', async () => {
  setScript([GAPS, GAPS]);
  const { p } = await authorize('E sin más evaluación', { gauntlet: { mode: 'standard' } });
  assert.equal(p.result!.pipeline!.pauseKind, 'gauntlet');
  const before = calls().length;
  const res = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/continue`, payload: { authorized: true, pipeline: { gauntlet: { mode: 'off', maxRounds: 0 } } } });
  assert.equal(res.statusCode, 200, res.body);
  const done = await waitDone(p.id);
  assert.equal(done.result!.pipeline!.state, 'verified', done.result!.pipeline!.reason ?? '');
  assert.equal(calls().length, before, 'ninguna llamada a la IA');
  assert.equal(done.result!.gauntlet!.status, 'waived'); assert.match(done.result!.gauntlet!.reason!, /Pendiente documentado/);
  assert.equal(done.result!.gauntlet!.rounds.length, 2, 'el informe del Evaluador se conserva');
});

test('B · sin autoaprobación: si el paso del Evaluador apunta al implementador, no se evalúa', async () => {
  setScript([PASS]);
  const it = addManualItem(S, project.id, { title: 'B autoaprobación' });
  const p0 = createStoryProcess(S, project.id, it.id);
  const dev = p0.steps.find(s => s.role === 'implementer')!;
  processesRepo(S).addStep(p0.id, { agentId: dev.agentId, agentName: dev.agentName, title: 'Evaluación Gauntlet (independiente)', model: dev.model ?? 'claude-sonnet-4-5', role: 'evaluator', reason: 'prueba' });
  const res = await app.inject({ method: 'POST', url: `${W}/processes/${p0.id}/authorize`, payload: { budgetUsd: 3, authorized: true, pipeline: { gauntlet: { mode: 'deep' } } } });
  assert.equal(res.statusCode, 200, res.body);
  const p = await waitDone(p0.id);
  assert.equal(p.result!.pipeline!.state, 'verified');
  assert.equal(byRule(R.ev).length, 0, 'el implementador nunca se evalúa a sí mismo');
  assert.equal(p.result!.gauntlet!.status, 'skipped'); assert.match(p.result!.gauntlet!.reason!, /no se autoevalúa/);
  assert.equal(p.steps.find(s => s.role === 'evaluator')!.status, 'skipped');
});

test('modo off y predeterminado del proyecto: off no añade llamadas; el modo del proyecto se aplica si la tarea no lo cambia', async () => {
  setScript([PASS]);
  const { p } = await authorize('Off', { gauntlet: { mode: 'off' } });
  assert.equal(p.result!.pipeline!.state, 'verified'); assert.equal(calls().length, 3, 'plan + implementación + QA: sin sobrecoste');
  assert.ok(!p.steps.some(s => s.role === 'evaluator' && s.status === 'done'));
  assert.equal((await app.inject({ method: 'PUT', url: `${W}/projects/${project.id}/gauntlet`, payload: { mode: 'standard' } })).statusCode, 400, 'cambiar el modo exige autorización');
  const put = await app.inject({ method: 'PUT', url: `${W}/projects/${project.id}/gauntlet`, payload: { mode: 'standard', authorized: true } });
  assert.equal(put.statusCode, 200, put.body); assert.deepEqual(put.json().config, { mode: 'standard', maxRounds: 1 });
  setScript([PASS]);
  const { p: q } = await authorize('Predeterminado');
  assert.equal(q.result!.pipeline!.config.gauntlet!.mode, 'standard');
  assert.equal(byRule(R.ev).length, 1); assert.equal(q.result!.gauntlet!.status, 'passed');
  // Recomendación y sobrecoste ANTES de autorizar (sin IA).
  const adv = (await app.inject({ method: 'GET', url: `${W}/projects/${project.id}/backlog/${q.backlogItemId}/gauntlet` })).json();
  assert.equal(adv.projectDefault.mode, 'standard'); assert.ok(['off', 'standard', 'deep'].includes(adv.recommended.mode));
  assert.deepEqual(adv.overhead.standard, { evaluations: { min: 1, max: 2 }, corrections: { min: 0, max: 1 } });
  assert.ok(adv.evaluator?.id);
  await app.inject({ method: 'PUT', url: `${W}/projects/${project.id}/gauntlet`, payload: { mode: 'off', authorized: true } });
});

// ---------- R · Aprendizaje: las brechas del Evaluador entran en el ciclo de lecciones existente ----------
test('R · una brecha con evidencia queda «detectada» y no se inyecta; validada por el propietario se reutiliza y se mide si cambia el comportamiento', async () => {
  const gaps = () => lessonsRepo(S).list(project.id).filter(l => l.detector === 'gauntlet_gap');
  const of = (title: string) => gaps().filter(l => (l.evidence.processTitle ?? '').endsWith(title));
  // Del ciclo A+C+E: la brecha corregida en la ronda 2. Del D+E: la que persistió tras corregirla. Nunca la que no tenía evidencia.
  const [fixed] = of('A-C-E ciclo');
  assert.ok(fixed, gaps().map(l => l.evidence.processTitle).join(' | '));
  assert.equal(fixed.status, 'detected'); assert.equal(fixed.role, 'implementer'); assert.match(fixed.title, /FALTA-DOBLE/);
  assert.match(fixed.evidence.detail, /^Resultado: corregida en la ronda 2\. Evaluó .+ \(ronda 1, modo standard\)\. Criterio: existe doble/);
  assert.match(fixed.evidence.detail, /Evidencia: src\/a\.ts:1/); assert.equal(fixed.evidence.file, 'src/a.ts');
  assert.equal(of('A-C-E ciclo').length, 1, 'una lección por brecha y proceso, aunque se detecte en varias paradas');
  assert.match(of('D acotado')[0].evidence.detail, /^Resultado: persistió tras la corrección \(ronda 2\)/);
  assert.ok(!gaps().some(l => /SIN-EVIDENCIA/.test(l.title)), 'un hallazgo sin evidencia no es lección');
  const lessonText = 'LECCION-R: antes de entregar, comprueba que cada criterio de aceptación tiene su código (cada export pedido existe).';
  MARKERS.push('LECCION-R');
  // Sin validar no contamina: no llega a ningún prompt.
  setScript([PASS]);
  let { p } = await authorize('R sin validar', { gauntlet: { mode: 'standard' } });
  assert.ok(!(p.steps.find(s => s.role === 'implementer')!.lessonsUsed ?? []).includes(fixed.id));
  assert.ok(!byRule(R.dev)[0].markers.includes('LECCION-R'));
  // Validada por el propietario: se inyecta al implementador (no al Evaluador, que conserva su contexto nuevo).
  validateLesson(S, fixed.id, { lessonText });
  setScript([PASS]);
  ({ p } = await authorize('R validada sin reincidir', { gauntlet: { mode: 'standard' } }));
  assert.ok(p.steps.find(s => s.role === 'implementer')!.lessonsUsed!.includes(fixed.id), 'el paso deja constancia de la lección usada');
  assert.ok(byRule(R.dev)[0].markers.includes('LECCION-R')); assert.ok(!byRule(R.ev)[0].markers.includes('LECCION-R'));
  let l = lessonsRepo(S).get(fixed.id)!;
  assert.equal(l.usedCount, 1); assert.equal(l.recurrenceCount, 0, 'el Evaluador no volvió a encontrar la brecha: la lección cambió el comportamiento');
  // Con la lección presente vuelve la misma clase de brecha: se mide como reincidencia (candidata a obsoleta), sin tocar al agente.
  setScript([GAPS, PASS]);
  ({ p } = await authorize('R validada con reincidencia', { gauntlet: { mode: 'standard' } }));
  assert.equal(p.result!.gauntlet!.status, 'passed');
  l = lessonsRepo(S).get(fixed.id)!;
  const usedHere = p.steps.filter(s => s.lessonsUsed?.includes(fixed.id));
  assert.ok(usedHere.length >= 2 && usedHere.every(s => s.role === 'implementer'), 'también la corrección dirigida la recibe (la hace el constructor)');
  assert.equal(l.usedCount, 1 + usedHere.length, 'se cuenta por paso'); assert.equal(l.recurrenceCount, 1);
  assert.equal(l.status, 'validated', 'medir no cambia nada solo: decide el propietario');
  assert.equal(of('R validada con reincidencia')[0].status, 'detected', 'la nueva brecha vuelve a empezar el ciclo como detectada');
});

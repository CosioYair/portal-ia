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
const { classifyModel, decideGauntlet, decidePlanReview, gauntletOverhead, gauntletSignature, normalizeGauntlet, parsePlanReview, planReviewWanted, progressBetween, recommendGauntlet, resolveGauntlet } = await import('@portal-ia/domain');
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

test('D · continuación por progreso: sigue solo con progreso medible y margen autorizado; sin progreso o sin margen se detiene (y lo dice); nunca sin fin', () => {
  const f = (text: string, severity: 'blocking' | 'major' = 'blocking') => ({ severity, criterion: null, text, file: 'src/a.ts', evidence: 'src/a.ts:1 fragmento', expected: null });
  const crit = (met: number, total = 3) => Array.from({ length: total }, (_, i) => ({ criterion: `c${i}`, status: i < met ? 'met' as const : 'unmet' as const, evidence: 'x' }));
  const round = (findings: any[], decision: 'pass' | 'correct' | 'stop' = 'pass', anotherRoundWorthIt = true, met = 0) => ({ verdict: 'gaps' as const, findings, anotherRoundWorthIt, decision, criteria: crit(met) });
  const std = normalizeGauntlet({ mode: 'standard' });
  assert.equal(std.maxRounds, 2, 'estándar: 2 correcciones autorizadas por defecto');
  assert.equal(normalizeGauntlet({ mode: 'deep', maxRounds: 99 }).maxRounds, 6, 'tope duro por proceso'); assert.equal(normalizeGauntlet({ mode: 'deep' }).maxRounds, 3);
  assert.equal(normalizeGauntlet({ mode: 'x' as any }).mode, 'off'); assert.deepEqual(normalizeGauntlet({ mode: 'auto' }), { mode: 'auto', maxRounds: 0 });
  // Con progreso (más criterios cumplidos) y margen: sigue.
  assert.equal(decideGauntlet(std, [round([f('X'), f('Y')], 'correct', true, 1), round([f('Y')], 'pass', true, 2)], 5).decision, 'correct');
  // Sin progreso (mismas medidas y otra brecha) no repite la misma estrategia: se detiene y pide replantear.
  const flat = decideGauntlet(std, [round([f('X')], 'correct', true, 1), round([f('Otra cosa distinta')], 'pass', true, 1)], 5);
  assert.equal(flat.decision, 'stop'); assert.match(flat.reason, /Sin progreso.*Replantea/);
  const same = decideGauntlet(normalizeGauntlet({ mode: 'deep' }), [round([f('Falta doble en a')], 'correct', true, 0), round([f('Falta doble en a')], 'pass', true, 2)], 5);
  assert.equal(same.decision, 'diagnose', 'la misma brecha sin progreso: primero un diagnóstico independiente, no la misma estrategia');
  const sameAgain = decideGauntlet(normalizeGauntlet({ mode: 'deep' }), [round([f('Falta doble en a')], 'correct', true, 0), round([f('Falta doble en a')], 'pass', true, 2)], 5, { diagnosed: [gauntletSignature([f('Falta doble en a')])] });
  assert.equal(sameAgain.decision, 'stop', 'ya diagnosticada y sigue igual: se detiene'); assert.match(sameAgain.reason, /la misma brecha/);
  // Margen autorizado agotado CON progreso: se detiene diciendo que hubo progreso y que puedes conceder más.
  const limit = decideGauntlet(std, [round([f('X'), f('Y'), f('Z')], 'correct', true, 0), round([f('Y'), f('Z')], 'correct', true, 1), round([f('Z')], 'pass', true, 2)], 5);
  assert.equal(limit.decision, 'stop'); assert.equal(limit.status, 'stopped'); assert.match(limit.reason, /2 corrección\(es\) dirigida\(s\) autorizadas.*con progreso.*conceder más rondas \(hasta 6\)/);
  assert.equal(decideGauntlet(normalizeGauntlet({ mode: 'deep' }), [round([f('Falta doble en a')], 'correct'), round([f('Falta doble en a')], 'stop')], 5, { ownerGranted: true }).decision, 'correct', 'el propietario puede conceder otra ronda');
  const marginal = decideGauntlet(std, [round([f('Nombre poco claro', 'major')], 'pass', false)], 5);
  assert.equal(marginal.decision, 'stop'); assert.equal(marginal.status, 'passed_with_findings');
  assert.equal(decideGauntlet(std, [round([f('X')])], 0).reason, 'No quedan correcciones autorizadas en este proceso.');
  // Nunca sin fin: aunque cada ronda «mejore», el margen autorizado (y el tope duro de 6) lo corta.
  const deep6 = normalizeGauntlet({ mode: 'deep', maxRounds: 6 }); const rounds: any[] = [];
  let decisions = 0;
  for (let i = 0; i < 20; i++) { rounds.push(round(Array.from({ length: 20 - i }, (_, k) => f(`B${k}`)), 'pass', true, Math.min(3, i))); const d = decideGauntlet(deep6, rounds, 99); rounds[rounds.length - 1].decision = d.decision; if (d.decision !== 'correct') break; decisions++; }
  assert.equal(decisions, 6, 'como mucho 6 correcciones por proceso');
  assert.deepEqual(gauntletOverhead(normalizeGauntlet({ mode: 'off' })), { evaluations: { min: 0, max: 0 }, corrections: { min: 0, max: 0 } });
  // Máximo: 3 rondas + 1 evaluación, 1 + 2 revisiones del plan, 1 diagnóstico; correcciones: 3 + 2 revisiones del plan.
  assert.deepEqual(gauntletOverhead(normalizeGauntlet({ mode: 'deep' })), { evaluations: { min: 1, max: 8 }, corrections: { min: 0, max: 5 } });
});

test('progreso sin retrocesos: mejorar una medida empeorando la otra no es progreso (no puede alternar hasta el tope)', () => {
  const round = (met: number, severe: string[]) => ({ criteria: ['a', 'b', 'c'].map((c, i) => ({ criterion: c, status: (i < met ? 'met' : 'unmet') as any, evidence: 'e' })), findings: severe.map(t => ({ severity: 'major' as const, criterion: null, text: t, file: null, evidence: 'e', expected: null })) });
  assert.equal(progressBetween(round(1, ['x', 'y']), round(2, ['x', 'y2'])).improved, true, 'más criterios y las mismas graves');
  assert.equal(progressBetween(round(1, ['x', 'y']), round(1, ['x'])).improved, true, 'menos graves');
  assert.equal(progressBetween(round(2, ['x', 'y']), round(1, ['z'])).improved, false, 'menos graves pero menos criterios cumplidos');
  assert.equal(progressBetween(round(1, ['x']), round(2, ['y', 'z'])).improved, false, 'más criterios pero más graves');
});

test('recomendación sin IA y modo automático: pequeña sin riesgo → off; tamaño desconocido nunca profundo; profundo solo con tamaño L y riesgo, varias áreas o fallos repetidos; sin Evaluador → off', () => {
  assert.equal(recommendGauntlet({ hasEvaluator: true, estimate: 'S', text: 'Cambiar el texto del botón', iterations: 1, qaRejections: 0 }).mode, 'off');
  assert.equal(recommendGauntlet({ hasEvaluator: true, estimate: 'M', text: 'Cambiar el texto del botón', iterations: 1, qaRejections: 0 }).mode, 'standard');
  const risky = recommendGauntlet({ hasEvaluator: true, estimate: 'L', text: 'Permisos y presupuesto de los agentes', iterations: 1, qaRejections: 0 });
  assert.equal(risky.mode, 'deep'); assert.ok(risky.signals.length >= 2);
  assert.equal(recommendGauntlet({ hasEvaluator: true, estimate: null, text: 'Mostrar el agente responsable en la tarjeta', iterations: 1, qaRejections: 0 }).mode, 'standard', 'una palabra de riesgo y tamaño desconocido: estándar, no profundo');
  assert.equal(recommendGauntlet({ hasEvaluator: true, estimate: 'M', text: 'Revisar permisos', iterations: 1, qaRejections: 0 }).mode, 'standard', 'un riesgo solo: estándar');
  assert.equal(recommendGauntlet({ hasEvaluator: false, estimate: 'L', text: 'seguridad', iterations: 5, qaRejections: 3 }).mode, 'off');
  const auto = resolveGauntlet(normalizeGauntlet({ mode: 'auto' }), { hasEvaluator: true, estimate: 'S', text: 'Cambiar el texto del botón', iterations: 1, qaRejections: 0 });
  assert.equal(auto.mode, 'off'); assert.match(auto.auto!.reason, /pequeña y de bajo riesgo/);
  assert.deepEqual(resolveGauntlet(normalizeGauntlet({ mode: 'deep' }), { hasEvaluator: false, estimate: 'S', text: '', iterations: 1, qaRejections: 0 }).mode, 'deep', 'un modo explícito se respeta');
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
const MARKERS = ['CAUSA-DIAG', 'GAP-PLAN-DOBLE', 'RAZONAMIENTO-CONSTRUCTOR', 'NO son evidencia', 'El contador muestra 2', 'FALTA-DOBLE', 'SIN-EVIDENCIA-XYZ', 'Rondas anteriores'];
const DIAG = 'CAUSA-DIAG: el patch se aplicó sobre otra línea; ESTRATEGIA: añadir doble justo después de la definición de a.';
const R = { review: 'REVISIÓN DEL PLAN', diag: 'DIAGNÓSTICO de una brecha', ev: 'Evalúa de forma INDEPENDIENTE', plan: 'plan técnico', fix: 'Corrige la implementación de esta historia', qa: 'Evalúa la implementación con la EVIDENCIA real', dev: 'Implementa la historia' };
function setScript(evaluator: string[], fixes: string[] = [FIX1, FIX2], planReview: string[] = [], plans: string[] = [PLAN]) {
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  fs.writeFileSync(scriptPath, JSON.stringify({ markers: MARKERS, rules: [
    ...(planReview.length ? [{ match: R.review, responses: planReview.map(text => ({ text })) }] : []),
    { match: R.diag, text: DIAG },
    { match: R.ev, responses: evaluator.map(text => ({ text })) },
    { match: R.plan, responses: plans.map(text => ({ text })) },
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
  assert.equal(info.evaluator, null); assert.equal(info.config.mode, 'auto', 'por defecto, automático (sin Evaluador resuelve a «off»)'); assert.equal(info.template.reportsTo, 'pj-coordinador');
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

const FIX3 = '=== RESUMEN ===\nAjuste final.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const doble: number = a * 2;\n==== REEMPLAZAR\nexport const doble: number = a * 2; // revisado\n>>>> FIN\n=== FIN ARCHIVO ===';
test('D + E · la misma brecha: diagnóstico independiente, corrección con su causa y, si sigue igual, se detiene; conceder otra ronda no re-evalúa el mismo commit', async () => {
  setScript([GAPS, GAPS, GAPS, PASS], [FIX1, FIX2, FIX3]);
  const { p } = await authorize('D acotado', { gauntlet: { mode: 'standard' } });
  let pl = p.result!.pipeline!;
  assert.equal(pl.state, 'stopped'); assert.equal(pl.pauseKind, 'gauntlet');
  assert.match(pl.reason!, /brechas bloqueantes/); assert.match(pl.reason!, /Lo hecho se conserva/);
  const g0 = p.result!.gauntlet!;
  assert.equal(g0.status, 'stopped'); assert.deepEqual(g0.rounds.map(r => r.decision), ['correct', 'correct', 'stop']);
  assert.equal(byRule(R.ev).length, 3); assert.equal(byRule(R.fix).length, 2); assert.equal(byRule(R.qa).length, 1);
  assert.equal(byRule(R.diag).length, 1, 'un diagnóstico por brecha repetida, no uno por ronda');
  const diag = g0.rounds[1].diagnosis!; assert.ok(diag && diag.agentName); assert.match(diag.text, /CAUSA-DIAG/);
  const devAgent = p.steps.find(st => st.role === 'implementer')!.agentId; const evAgent = p.steps.find(st => st.role === 'evaluator')!.agentId;
  assert.ok(diag.agentId !== devAgent && diag.agentId !== evAgent, 'diagnostica alguien que ni construyó ni evaluó');
  assert.ok(!byRule(R.fix)[0].markers.includes('CAUSA-DIAG') && byRule(R.fix)[1].markers.includes('CAUSA-DIAG'), 'la segunda corrección lleva el diagnóstico');
  assert.match(g0.rounds[2].reason, /la misma brecha/);
  const flow = await flowOf(p.id);
  assert.equal(flow.issue.title, 'El Evaluador Gauntlet dejó brechas bloqueantes: decides tú');
  assert.ok(flow.issue.details.some((d: any) => /FALTA-DOBLE/.test(d.text) && /evidencia/.test(d.text)));
  assert.ok(!flow.issue.details.some((d: any) => /SIN-EVIDENCIA/.test(d.text)));
  const grant = flow.actions.find((a: any) => a.id === 'pipeline_resume' && /otra corrección dirigida/.test(a.label));
  assert.deepEqual(grant.pipeline, { maxCorrections: 1, gauntlet: { mode: 'deep', maxRounds: 3 } });
  assert.ok(flow.actions.some((a: any) => a.id === 'pipeline_resume' && /sin más evaluación/.test(a.label)));
  const res = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/continue`, payload: { authorized: true, addBudgetUsd: 0.5, pipeline: grant.pipeline } });
  assert.equal(res.statusCode, 200, res.body);
  const done = await waitDone(p.id); pl = done.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  assert.equal(byRule(R.ev).length, 4, 'el commit detenido NO se evalúa otra vez: solo el nuevo');
  assert.equal(byRule(R.fix).length, 3); assert.equal(byRule(R.qa).length, 1, 'QA no repite'); assert.equal(byRule(R.diag).length, 1);
  const g = done.result!.gauntlet!;
  assert.deepEqual(g.rounds.map(r => r.decision), ['correct', 'correct', 'correct', 'pass']);
  assert.match(g.rounds[2].reason, /El propietario concedió otra corrección/);
  assert.ok(g.rounds.length <= 1 + 3, 'nunca más de 3 correcciones del Evaluador');
});

const REV_GAP = { severity: 'blocking', criterion: 'existe doble = a * 2', text: 'GAP-PLAN-DOBLE: el plan no define doble', evidence: 'tasks: ["Editar src/a.ts"] no menciona doble', fix: 'añadir la tarea de exportar doble' };
const REV_REVISE = JSON.stringify({ verdict: 'revise', coverage: [{ criterion: 'a vale 2', covered: 'yes', evidence: 'tasks[0]' }, { criterion: 'existe doble = a * 2', covered: 'no', evidence: 'ninguna tarea define doble' }], gaps: [REV_GAP] });
const REV_OK = JSON.stringify({ verdict: 'approve', coverage: [{ criterion: 'a vale 2', covered: 'yes', evidence: 'tasks[0]' }, { criterion: 'existe doble = a * 2', covered: 'yes', evidence: 'tasks[1]' }], gaps: [] });

test('Gauntlet en la planificación (sin IA): cuándo se revisa el plan y qué se decide', () => {
  const plan = (files: number, acc: number) => ({ filesToChange: Array.from({ length: files }, (_, i) => `f${i}`), acceptance: Array.from({ length: acc }, (_, i) => `c${i}`) });
  assert.equal(planReviewWanted(normalizeGauntlet({ mode: 'off' }), plan(5, 5)), false);
  assert.equal(planReviewWanted(normalizeGauntlet({ mode: 'standard' }), plan(1, 2)), false, 'una tarea pequeña no paga una revisión del plan');
  assert.equal(planReviewWanted(normalizeGauntlet({ mode: 'standard' }), plan(3, 1)), true);
  assert.equal(planReviewWanted(normalizeGauntlet({ mode: 'deep' }), plan(1, 1)), true);
  const gap = (text: string, severity = 'blocking', evidence: string | null = 'cita del plan: tasks[0]') => ({ severity: severity as any, criterion: null, text, evidence, fix: null, unsupported: !evidence });
  const std = normalizeGauntlet({ mode: 'standard' }); const deep = normalizeGauntlet({ mode: 'deep' });
  const r = (gaps: any[], decision: 'revise' | 'proceed' = 'proceed', verdict: any = 'revise') => ({ verdict, gaps, decision });
  assert.equal(decidePlanReview(std, [r([gap('falta b')])]).decision, 'revise');
  assert.equal(decidePlanReview(std, [r([gap('vago', 'major', null)])]).decision, 'proceed', 'sin evidencia no hay revisión');
  assert.equal(decidePlanReview(std, [r([gap('falta b'), gap('falta c')], 'revise'), r([gap('falta c')])]).decision, 'pause', 'estándar: una revisión; un bloqueante pendiente → decides tú antes de pagar la implementación');
  assert.equal(decidePlanReview(deep, [r([gap('falta b'), gap('falta c')], 'revise'), r([gap('falta c')])]).decision, 'revise', 'profundo: con progreso, otra revisión');
  assert.equal(decidePlanReview(deep, [r([gap('falta b')], 'revise'), r([gap('falta b')])]).decision, 'pause', 'sin progreso no se insiste');
  assert.equal(decidePlanReview(deep, [r([gap('falta b', 'major')], 'revise'), r([gap('falta b', 'major')])]).decision, 'proceed', 'sin progreso pero no bloqueante: sigue y queda documentado');
  assert.equal(decidePlanReview(std, [r([], 'proceed', 'cannot_review')]).decision, 'proceed');
  // Un criterio sin cubrir (con evidencia) es una brecha bloqueante aunque el revisor diga «approve» sin listarla.
  const cov = parsePlanReview(JSON.stringify({ verdict: 'approve', coverage: [{ criterion: 'existe doble', covered: 'no', evidence: 'ninguna tarea define doble' }], gaps: [] }));
  assert.equal(cov.verdict, 'revise'); assert.equal(cov.gaps[0].severity, 'blocking'); assert.match(cov.gaps[0].text, /no cubre/);
});

test('revisión independiente del plan ANTES de implementar: brecha con evidencia → el planificador la corrige → aprobado; todo antes de pagar la implementación', async () => {
  const PLAN2 = PLAN.replace('"tasks":["Editar src/a.ts"]', '"tasks":["Editar src/a.ts","Exportar doble = a * 2"]');
  setScript([PASS], [FIX1], [REV_REVISE, REV_OK], [PLAN, PLAN2]);
  const { p } = await authorize('Plan revisado', { gauntlet: { mode: 'deep' } });
  assert.ok(p.result!.plan!.tasks.includes('Exportar doble = a * 2'), 'se implementa el plan REVISADO, no el primero');
  const pr = p.result!.gauntlet!.planReview!;
  assert.deepEqual(pr.rounds.map(x => x.decision), ['revise', 'proceed']); assert.equal(pr.status, 'approved');
  assert.equal(byRule(R.review).length, 2);
  const planCalls = byRule(R.plan); assert.ok(planCalls.length >= 2 && planCalls.some(c => c.markers.includes('GAP-PLAN-DOBLE')), 'el planificador recibe la brecha con su evidencia');
  const all = calls(); const lastReview = all.map(c => c.rule).lastIndexOf(R.review); const firstDev = all.findIndex(c => c.rule === R.dev);
  assert.ok(lastReview >= 0 && firstDev > lastReview, 'la revisión del plan ocurre antes de pagar la implementación');
  assert.ok(byRule(R.review).every(c => !c.markers.includes('RAZONAMIENTO-CONSTRUCTOR')));
  assert.equal(p.steps.filter(st => /Revisión del plan/.test(st.title)).length, 2, 'cada revisión es un paso con su coste');
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
});

test('revisión del plan sin progreso y con un bloqueante: se pausa ANTES de implementar (decides tú; no se paga la implementación)', async () => {
  setScript([PASS], [FIX1], [REV_REVISE, REV_REVISE]);
  const { p } = await authorize('Plan sin progreso', { gauntlet: { mode: 'deep' } });
  const pl = p.result!.pipeline!;
  assert.equal(pl.pauseKind, 'plan', pl.reason ?? ''); assert.match(pl.reason!, /no se ha pagado la implementación/);
  assert.equal(byRule(R.dev).length, 0, 'ninguna llamada de implementación'); assert.equal(byRule(R.review).length, 2);
  assert.equal(p.result!.gauntlet!.planReview!.status, 'paused');
  // Decides tú: «Seguir con este plan» lo implementa tal cual, sin repetir el plan ni su revisión (ya pagados).
  const flow = await flowOf(p.id);
  const accept = flow.actions.find((a: any) => a.id === 'accept_plan'); assert.ok(accept, JSON.stringify(flow.actions.map((a: any) => a.id)));
  const plans = byRule(R.plan).length; const reviews = byRule(R.review).length;
  // Con otro proceso en marcha, no: como al continuar.
  const blocker = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'otro en marcha', estimatedUsd: 0, steps: [] }); processesRepo(S).authorize(blocker.id, 1);
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/accept-plan`, payload: { authorized: true } })).statusCode, 409); processesRepo(S).finish(blocker.id, 'cancelled', 'fin');
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/accept-plan`, payload: {} })).statusCode, 400, 'exige autorización');
  const res = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/accept-plan`, payload: { authorized: true, addBudgetUsd: 0.5 } });
  assert.equal(res.statusCode, 200, res.body);
  const done = await waitDone(p.id);
  assert.equal(done.result!.pipeline!.state, 'verified', done.result!.pipeline!.reason ?? '');
  assert.equal(byRule(R.plan).length, plans, 'no se paga otro plan'); assert.equal(byRule(R.review).length, reviews, 'ni otra revisión');
  assert.equal(byRule(R.dev).length, 1); assert.equal(done.result!.gauntlet!.planReview!.ownerAccepted, true);
  assert.match(done.result!.gauntlet!.planReview!.reason!, /Aceptado por el propietario/);
  assert.ok(done.result!.pipeline!.events.some(e => /Revisión del plan/.test(e.message)), 'la actividad anterior (la revisión y la pausa) se conserva');
  assert.ok(res.json().guidance, 'la respuesta trae la guía, como «continuar»');
  // Una iteración RECHAZADA nunca revive aceptando su plan.
  setScript([PASS], [FIX1], [REV_REVISE, REV_REVISE]);
  const { p: q } = await authorize('Plan rechazado', { gauntlet: { mode: 'deep' } });
  assert.equal(q.result!.pipeline!.pauseKind, 'plan');
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${q.id}/reject`, payload: {} })).statusCode, 200);
  const devBefore = byRule(R.dev).length;
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${q.id}/accept-plan`, payload: { authorized: true } })).statusCode, 409);
  assert.equal(byRule(R.dev).length, devBefore, 'sin llamada de implementación');
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
  // Tres rondas: corrección, la misma brecha → diagnóstico y corrección guiada, y la detención; el informe se conserva entero.
  assert.equal(done.result!.gauntlet!.rounds.length, 3, 'el informe del Evaluador se conserva');
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
  assert.equal(put.statusCode, 200, put.body); assert.deepEqual(put.json().config, { mode: 'standard', maxRounds: 2 });
  setScript([PASS]);
  const { p: q } = await authorize('Predeterminado');
  assert.equal(q.result!.pipeline!.config.gauntlet!.mode, 'standard');
  assert.equal(byRule(R.ev).length, 1); assert.equal(q.result!.gauntlet!.status, 'passed');
  // Recomendación y sobrecoste ANTES de autorizar (sin IA).
  const adv = (await app.inject({ method: 'GET', url: `${W}/projects/${project.id}/backlog/${q.backlogItemId}/gauntlet` })).json();
  assert.equal(adv.projectDefault.mode, 'standard'); assert.ok(['off', 'standard', 'deep'].includes(adv.recommended.mode));
  assert.deepEqual(adv.overhead.standard, { evaluations: { min: 1, max: 6 }, corrections: { min: 0, max: 3 } });
  assert.ok(adv.evaluator?.id);
  await app.inject({ method: 'PUT', url: `${W}/projects/${project.id}/gauntlet`, payload: { mode: 'off', authorized: true } });
});

test('lote con Gauntlet automático: se resuelve historia a historia (sin IA) y se explica; sin indicarlo, el del proyecto', async () => {
  const small = addManualItem(S, project.id, { title: 'Cambiar el texto del pie', criterion: 'El pie dice Hola', estimate: 'S' });
  const risky = addManualItem(S, project.id, { title: 'Migración de permisos y credenciales', criterion: 'Los permisos se migran sin borrar nada', estimate: 'L' });
  const before = calls().length;
  const prev = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches/preview`, payload: { itemIds: [small.id, risky.id], totalBudgetUsd: 5, perStoryBudgetUsd: 2, gauntlet: { mode: 'auto' }, backends: ['api'] } });
  assert.equal(prev.statusCode, 200, prev.body);
  const plan = prev.json().plan as any[]; const of = (id: string) => plan.find(x => x.id === id);
  assert.equal(of(small.id).gauntlet.mode, 'off', 'pequeña y sin riesgo: sin Gauntlet');
  assert.equal(of(risky.id).gauntlet.mode, 'deep', 'grande y de riesgo: profundo'); assert.match(of(risky.id).gauntlet.reason, /riesgo/);
  assert.ok(of(risky.id).calls.max > of(small.id).calls.max, 'el sobrecoste es el de cada historia, no el máximo para todas');
  assert.equal(calls().length, before, 'la vista previa no llama a la IA');
  assert.equal((await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches/preview`, payload: { itemIds: [small.id], totalBudgetUsd: 5, perStoryBudgetUsd: 2, gauntlet: { mode: 'auto', maxRounds: 7 }, backends: ['api'] } })).statusCode, 400, 'el tope de rondas es real');
  // Sin indicarlo: el del proyecto (aquí «off», fijado por la prueba anterior).
  const def = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches/preview`, payload: { itemIds: [small.id], totalBudgetUsd: 5, perStoryBudgetUsd: 2, backends: ['api'] } });
  assert.equal(def.json().auth.gauntlet.mode, 'off');
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
  assert.equal(p.result?.pipeline?.state, 'verified', `${p.status} · ${p.result?.pipeline?.pauseKind} · ${p.result?.pipeline?.reason ?? p.error}`);
  assert.equal(p.result!.gauntlet!.status, 'passed');
  l = lessonsRepo(S).get(fixed.id)!;
  const usedHere = p.steps.filter(s => s.lessonsUsed?.includes(fixed.id));
  assert.ok(usedHere.length >= 2 && usedHere.every(s => s.role === 'implementer'), 'también la corrección dirigida la recibe (la hace el constructor)');
  assert.equal(l.usedCount, 1 + usedHere.length, 'se cuenta por paso'); assert.equal(l.recurrenceCount, 1);
  assert.equal(l.status, 'validated', 'medir no cambia nada solo: decide el propietario');
  assert.equal(of('R validada con reincidencia')[0].status, 'detected', 'la nueva brecha vuelve a empezar el ciclo como detectada');
});

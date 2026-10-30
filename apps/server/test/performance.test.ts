import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Rendimiento sin perder calidad (proveedor SIMULADO, 0 USD; sandbox determinista). S: el contexto que recibe cada
 * agente queda registrado por secciones y la evidencia del sandbox se reutiliza solo para el MISMO commit (cambia el
 * commit → se verifica otra vez). T: las consultas de especialistas, independientes entre sí, van en paralelo cuando el
 * presupuesto cubre todas; si no, de una en una como antes. Mismas llamadas y mismo resultado.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-perf-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline, promptSections } = await import('@portal-ia/domain');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { callMetricsRepo, summarizeCalls } = await import('../src/db/callMetrics.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { consultInParallel, createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { estimateCallUsd, newPipeline, storyRunContext, updateResult, verifyStage, worstCaseCallUsd } = await import('../src/services/storyPipeline.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');

test('S · secciones del encargo: instrucciones, títulos fuera de bloques de código y resumen de lo que sobra', () => {
  const s = promptSections('Haz X.\n# Plan\nuno\ndos\n## Archivo: src/a.ts\n```md\n# no es un título\n```\n# Criterios\n- a');
  assert.deepEqual(s.map(x => x.source), ['instrucciones', 'Plan', 'Archivo: src/a.ts', 'Criterios']);
  assert.equal(s[2].chars, '```md\n# no es un título\n```\n'.length, 'un título dentro de un bloque de código es contenido');
  const many = promptSections(Array.from({ length: 30 }, (_, i) => `# S${i}\nx`).join('\n'), 5);
  assert.equal(many.length, 5); assert.match(many[4].source, /26 secciones más/);
});

const S = 'portal-ia';
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-perf-repo-'));
fs.mkdirSync(path.join(repo, 'src'));
fs.writeFileSync(path.join(repo, 'src/base.ts'), 'export const base = 0;\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'perf', version: '1.0.0', private: true, scripts: { typecheck: 'x', test: 'x', build: 'x' } }));
fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: 'perf', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'perf', version: '1.0.0' } } }));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
projectsRepo(S).setRepository(project.id, repo, 'main');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();
after(async () => { await app.close(); });
const runs: string[] = [];
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { runs.push(command); const t = new Date().toISOString(); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 1, isolation: 'docker' }; };

const plan = (f: string) => JSON.stringify({ summary: `Crear ${f}`, tasks: [`Crear ${f}`], filesToRead: [], filesToChange: [f], acceptance: [`${f} existe`], risks: [] });
const create = (f: string) => `=== RESUMEN ===\nCrea ${f}.\n=== ARCHIVO: ${f} | create ===\nexport const x = 1;\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre ${f}. Esperado: existe.`;
function setScript(key: string, file: string) {
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [
    { match: `${key}.*Elabora el plan técnico`, text: plan(file) },
    { match: `${key}.*Implementa la historia`, text: create(file) },
    { match: 'aporta recomendaciones concretas', delayMs: 400, text: '- Mantén el cambio mínimo.' },
    { match: 'Evalúa la implementación con la EVIDENCIA real', text: JSON.stringify({ verdict: 'approved', summary: 'Cumple.', findings: [], suggestedTests: [] }) }
  ] }));
}
const consultants = ['pj-arquitecto', 'pj-ux'].map(k => agentsRepo(S).list().find(a => a.key === k && a.projectId === project.id)!.id);
const logs: { o: any; m: string }[] = [];
async function story(key: string, budget: number) {
  setScript(key, `src/${key.toLowerCase()}.ts`);
  const it = addManualItem(S, project.id, { title: `Historia ${key}`, criterion: 'el archivo existe' });
  const p = createStoryProcess(S, project.id, it.id, { override: { add: consultants, by: 'owner', at: new Date().toISOString() } });
  processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, autoApply: true, autoVerify: true })) });
  processesRepo(S).authorize(p.id, budget);
  await runStory(S, p.id, (o, m) => logs.push({ o, m }), () => false);
  return processesRepo(S).get(p.id)!;
}
const overlap = (p: any) => { const [a, b] = p.steps.filter((s: any) => s.role === 'consultant'); return Date.parse(b.startedAt) < Date.parse(a.finishedAt) && Date.parse(a.startedAt) < Date.parse(b.finishedAt); };

test('T · consultas independientes en paralelo: mismas llamadas, mismo resultado, en el orden de los pasos', async () => {
  const p = await story('PARALELO', 3);
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  const cs = p.steps.filter(s => s.role === 'consultant');
  assert.equal(cs.length, 2); assert.ok(cs.every(s => s.status === 'done'));
  assert.ok(overlap(p), 'las dos consultas trabajaron a la vez');
  assert.deepEqual(p.result!.consultations!.map(c => c.agentId), cs.map(s => s.agentId), 'las aportaciones llegan al implementador en el orden de los pasos');
  const log = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(log.length, 5, 'plan + 2 consultas + implementación + QA: ninguna llamada extra');
});

test('T · regla del paralelo: solo si el presupuesto restante cubre TODAS las consultas a la vez (nunca se supera por ir en paralelo)', () => {
  assert.equal(consultInParallel([0.19, 0.04], 0.25), true);
  assert.equal(consultInParallel([0.19, 0.04], 0.2), false, 'cubre cada una por separado pero no las dos: de una en una');
  assert.equal(consultInParallel([0.19], 5), false, 'una sola consulta no se paraleliza');
  assert.equal(consultInParallel([], 5), false);
  const prev = logs.find(l => /consultas independientes en paralelo/.test(l.m))!.o;
  assert.equal(prev.parallel, true); assert.ok(prev.together <= prev.room, 'la ejecución en paralelo de la prueba anterior cumplía la regla');
});

test('S · el contexto entregado queda registrado por secciones en cada llamada (y resumido por papel)', async () => {
  const rows = callMetricsRepo(S).list({});
  assert.ok(rows.length >= 5 && rows.every(m => m.context.length > 0), 'todas las llamadas registran sus secciones');
  const planner = rows.find(m => m.role === 'planner')!;
  assert.ok(planner.context.some(c => /Árbol del repositorio/.test(c.source) && c.chars > 0), planner.context.map(c => c.source).join(' | '));
  const sum = summarizeCalls(rows);
  assert.ok(sum.contextBySource.implementer.some(c => c.source === 'contenido de archivo' || /Archivo/.test(c.source)), JSON.stringify(sum.contextBySource.implementer));
  assert.ok(sum.contextBySource.consultant.some(c => c.source === 'Plan'));
});

test('S · la evidencia del sandbox se reutiliza para el MISMO commit y se invalida al cambiar el commit', async () => {
  const p = await story('EVIDENCIA', 3);
  const { ctx } = storyRunContext(S, p.id, () => undefined, () => false);
  const cfg = processesRepo(S).get(p.id)!.result!.pipeline!.config;
  runs.length = 0;
  assert.equal(await verifyStage(ctx, cfg), null);
  assert.deepEqual(runs, [], 'mismo commit ya verificado: no se repite ninguna verificación');
  updateResult(S, p.id, r => ({ ...r, applied: { ...r.applied!, commit: 'otro-commit', appliedAt: new Date(Date.now() + 1000).toISOString() } }));
  assert.equal(await verifyStage(ctx, cfg), null);
  assert.deepEqual(runs, cfg.commands, 'commit nuevo: se verifica todo otra vez');
});

test('T · la estimación del paralelo usa el sistema que recibirá de verdad (lecciones y prácticas incluidas) y lo deja listo para la llamada', () => {
  const it = addManualItem(S, project.id, { title: 'Historia ESTIMACION', criterion: 'el archivo existe' });
  const p = createStoryProcess(S, project.id, it.id, { override: { add: consultants, by: 'owner', at: new Date().toISOString() } });
  const cs = p.steps.find(s => s.role === 'consultant')!; const agent = agentsRepo(S).get(cs.agentId)!;
  const injected = new Map<string, string>();
  const usd = worstCaseCallUsd(S, p.id, cs.id, 'SISTEMA', 'ENCARGO', 2500, injected);
  assert.ok(injected.get(cs.id)?.startsWith('SISTEMA'), 'el sistema inyectado queda preparado: la llamada lo reutiliza y no inyecta dos veces');
  assert.equal(usd, estimateCallUsd(agent, injected.get(cs.id)!, 'ENCARGO', 2500, 'api'), 'agente por API: su precio con el sistema completo');
  assert.ok(usd > 0);
});

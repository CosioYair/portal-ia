import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Q9 · Especialistas eficientes (docs/autonomia-suscripcion-y-persistencia.md). Un especialista con Claude Code
 * (suscripción) que agota sus turnos BUSCANDO en el repositorio en vez de responder: diagnóstico «turnos agotados», UNA
 * recuperación sin herramientas con lo que ya leyó, sin repetición a ciegas, llamadas y uso contados y un mensaje claro
 * al propietario. Y, antes de eso, la consulta debe recibir un paquete de evidencia y reglas explícitas de herramientas.
 * CLI SIMULADA (fixtures/fake-claude.mjs) y proveedor de API simulado: ningún modelo real, ningún crédito.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-cturns-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-fakecturns-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = () => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];
scenario({});

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, claudeCodeRunsRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { newPipeline } = await import('../src/services/storyPipeline.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { resetDetectionCache } = await import('../src/services/claudeCode/detect.ts');
const { setBridgeUrl } = await import('../src/services/claudeCode/backend.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { isDenied, readTaskFile, searchTaskFiles } = await import('../src/services/claudeCode/bridge.ts');
const { createDelegation, runDelegation, teamOf, pickLeadAgent } = await import('../src/services/delegation.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-cturns-repo-'));
const uniq = `cturns-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
// Archivo que el plan ya conoce (filesToRead): su contenido debe llegar a la consulta sin que el especialista lo busque.
fs.writeFileSync(path.join(repo, 'src/arquitectura.ts'), 'export const MODULOS = "MARCA-PLAN-ARQ";\n');
// Archivo que el especialista lee por su cuenta durante la ejecución que agota los turnos.
fs.writeFileSync(path.join(repo, 'src/extra.ts'), 'export const extra = "LEIDO-POR-EL-CONSULTOR";\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node -e "0"' } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
setBridgeUrl(`http://127.0.0.1:${(app.server.address() as any).port}`);
after(async () => { await app.close(); });
const inject = (method: string, u: string, payload?: unknown) => app.inject({ method: method as any, url: u, payload: payload as any });

saveClaudeCodeSettings({ ...getClaudeCodeSettings(), cliPath: FAKE });
scenario({ auth: 'subscription' }); resetDetectionCache();
assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true, maxDurationSec: 120 })).statusCode, 200);
assert.equal((await inject('PUT', `${W}/claude-code/projects`, { authorized: true, projectIds: [project.id] })).statusCode, 200);
const LIMIT = getClaudeCodeSettings().maxTurns;

sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { const t = new Date().toISOString(); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' }; };

const PLAN = JSON.stringify({ summary: 'a vale 2 respetando la arquitectura de módulos', tasks: ['Editar src/a.ts'], filesToRead: ['src/arquitectura.ts'], filesToChange: ['src/a.ts'], deliverables: [{ path: 'src/a.ts', purpose: 'a vale 2', kind: 'code', estimatedLines: 3 }], acceptance: ['a = 2'], risks: [] });
const PATCH = '=== RESUMEN ===\nCambia a.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nEl contador muestra 2.\n=== PRUEBA MANUAL ===\n1. Abre el contador. Esperado: muestra 2.';
const QA_OK = { verdict: 'approved', summary: 'Cumple el criterio.', findings: [], suggestedTests: [] };
/** Texto con el que el pipeline pide la consulta previa a la implementación (storyExecution.ts, paso 1b). */
const CONSULT = 'aporta recomendaciones concretas y accionables';
/** El especialista busca sin parar (como en el fallo real: ~16 portal_search y ~3 portal_read_file en 8 turnos). */
const SEARCHING = [{ name: 'portal_search', input: { query: 'arquitectura' } }, { name: 'portal_search', input: { query: 'módulo' } }, { name: 'portal_read_file', input: { path: 'src/extra.ts' } }];
/** Lecturas REALES por el puente (servidor MCP del Portal) durante la ejecución con herramientas. */
const READS = [{ tool: 'portal_search', args: { query: 'MODULOS' } }, { tool: 'portal_read_file', args: { path: 'src/extra.ts' } }];

fs.writeFileSync(scriptPath, JSON.stringify({ rules: [
  { match: 'plan técnico', text: PLAN },
  { match: 'Esta es la unidad 1 de 1', text: PATCH },
  { match: 'Evalúa la implementación con la EVIDENCIA real', text: JSON.stringify(QA_OK) },
  { match: 'Valida el encargo', text: '__TRIAGE__' },
  { match: 'Entrega el resultado del encargo', text: 'Entregable del encargo.' }
], markers: [] }));

/** Historia con el Arquitecto como consultor en Claude Code (suscripción); el resto del equipo en la API simulada. */
async function consultStory(title: string) {
  const it = addManualItem(S, project.id, { title, criterion: 'a vale 2 (número)', description: 'Revisa la arquitectura del módulo, su estructura y dependencias.' });
  const p = createStoryProcess(S, project.id, it.id);
  const cStep = p.steps.find(s => s.role === 'consultant');
  assert.ok(cStep, `la historia necesita un consultor de arquitectura: ${p.steps.map(s => `${s.role}:${s.agentName}`).join(', ')}`);
  for (const s of p.steps) {
    const backend = s.id === cStep!.id ? 'claude-code' : 'api';
    const r = await inject('PUT', `${W}/agents/${s.agentId}/backend`, { backend, authorized: true }); assert.equal(r.statusCode, 200, r.body);
  }
  processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, allowInstall: true, commands: ['typecheck'] })) });
  processesRepo(S).authorize(p.id, 2);
  return { p, consultant: cStep!.agentId };
}
const runToEnd = async (id: string) => { await runStory(S, id, () => undefined, () => false); return processesRepo(S).get(id)!; };
const consultRuns = () => ccRuns().filter((r: any) => r.rule === CONSULT);

// ---------------------------------------------------------------- 1 · Agota los turnos buscando; la recuperación es posible

const exhausted = (async () => {
  scenario({ auth: 'subscription', mcpRead: READS, rules: [{ match: CONSULT, maxTurns: true, onlyWithTools: true, tools: SEARCHING, text: 'RECUPERADA-SIN-HERRAMIENTAS: 1. Mantén MODULOS en src/arquitectura.ts.' }] });
  const { p, consultant } = await consultStory('Contador: revisar la arquitectura del módulo y su estructura');
  const done = await runToEnd(p.id);
  return { p, consultant, done, runs: consultRuns(), flow: (await inject('GET', `${W}/processes/${p.id}`)).json().guidance?.flow };
})();

test('Q9.1 · consulta con los turnos agotados: la historia NO falla; sigue con la respuesta recuperada', async () => {
  const { done } = await exhausted;
  assert.notEqual(done.status, 'failed', `una consulta sin respuesta no debe hacer fallar la historia entera (pipeline: ${done.result!.pipeline?.state}): ${done.error}`);
  assert.equal(done.result!.pipeline!.state, 'verified', done.result!.pipeline!.reason ?? '');
  assert.match(done.result!.consultations?.[0]?.text ?? '', /RECUPERADA-SIN-HERRAMIENTAS/);
});

test('Q9.2 · UNA recuperación sin herramientas, con lo que el especialista ya leyó (no se repite a ciegas)', async () => {
  const { runs } = await exhausted;
  assert.equal(runs.length, 2, 'una ejecución que agota los turnos + UNA recuperación');
  assert.ok(runs[0].args.includes('--mcp-config'), 'la consulta original tiene el puente');
  assert.ok(!runs[1].args.includes('--mcp-config'), 'la recuperación va SIN herramientas');
  assert.match(runs[1].prompt, /LEIDO-POR-EL-CONSULTOR/, 'la recuperación incluye lo que ya leyó por el puente');
  assert.match(`${runs[1].system}\n${runs[1].prompt}`, /turnos/i, 'y explica por qué: agotó los turnos');
});

test('Q9.3 · llamadas a la suscripción y uso contados (la ejecución agotada consumió la suscripción)', async () => {
  const { p, consultant, done } = await exhausted;
  assert.equal(claudeCodeRunsRepo(S).countForProcesses([p.id]), 2, 'las dos ejecuciones cuentan para el tope de llamadas');
  const mine = claudeCodeRunsRepo(S).byAgent(consultant, 10).filter(r => r.processId === p.id).reverse();
  assert.deepEqual(mine.map(r => r.status), ['failed', 'done']);
  assert.equal(mine[0].numTurns, LIMIT + 1); assert.equal(mine[0].tokensIn, 30_000);
  const used = done.steps.filter(s => s.role === 'consultant').reduce((n, s) => n + s.inputTokens, 0);
  assert.ok(used >= 30_000, `el uso de la ejecución agotada se registra en el paso: ${used}`);
});

test('Q9.4 · el propietario lo ve como «turnos agotados» y recuperación, no como un fallo del proveedor', async () => {
  const { done, flow } = await exhausted;
  assert.doesNotMatch(`${flow?.issue?.title ?? ''} · ${flow?.issue?.explanation ?? ''}`, /proveedor de IA fall|cuando el proveedor responda/i, `acciones ofrecidas: ${(flow?.actions ?? []).map((a: any) => a.label).join(' | ')}`);
  const events = (done.result!.pipeline?.events ?? []).map(e => `${e.message} ${e.detail ?? ''}`).join('\n');
  assert.match(events, /agot[oó] (sus |los )?turnos/i, `evento del pipeline con el diagnóstico (estado del pipeline: ${done.result!.pipeline?.state}): ${events.slice(-600)}`);
  assert.match(events, /recuper/i, 'y la recuperación sin herramientas');
});

// ---------------------------------------------------------------- 2 · También agota la recuperación: se detiene, sin bucle

// Los escenarios se encadenan (la CLI simulada lee UN guion): cada bloque espera al anterior antes de cambiarlo.
const twice = (async () => {
  await exhausted.catch(() => undefined);
  scenario({ auth: 'subscription', mcpRead: READS, rules: [{ match: CONSULT, maxTurns: true, tools: SEARCHING }] });
  const { p } = await consultStory('Contador: revisar la arquitectura del módulo (sin respuesta)');
  const done = await runToEnd(p.id);
  return { done, runs: consultRuns(), flow: (await inject('GET', `${W}/processes/${p.id}`)).json().guidance?.flow };
})();

test('Q9.5 · si la recuperación también se queda sin respuesta: pausa «max_turns» (no fallo), sin tercera llamada ni «volver a ejecutar» a ciegas', async () => {
  const { done, runs, flow } = await twice;
  assert.equal(runs.length, 2, `la consulta + UNA recuperación, ninguna más (hubo ${runs.length})`);
  assert.ok(!runs[1].args.includes('--mcp-config'), 'la recuperación va sin herramientas');
  assert.notEqual(done.status, 'failed', `${done.error}`);
  assert.equal(done.result!.pipeline!.pauseKind, 'max_turns', done.result!.pipeline!.reason ?? '');
  assert.match(flow.issue.title, /turnos/i);
  assert.ok(!flow.actions.some((a: any) => a.id === 'retry_process' && a.primary), 'repetir la misma consulta no es la acción principal');
});

// ---------------------------------------------------------------- 3 · Lo que recibe una consulta

const answered = (async () => {
  await twice.catch(() => undefined);
  scenario({ auth: 'subscription', rules: [{ match: CONSULT, text: '1. Mantén MODULOS.' }] });
  const { p } = await consultStory('Contador: revisar la arquitectura del módulo (respuesta directa)');
  await runToEnd(p.id);
  return consultRuns()[0];
})();

test('Q9.6 · paquete de evidencia: la consulta trae el CONTENIDO de los archivos que el plan ya conoce (filesToRead)', async () => {
  const run = await answered;
  assert.ok(run, 'la consulta se ejecutó con Claude Code');
  assert.match(run.prompt, /src\/arquitectura\.ts/, 'el plan nombra el archivo');
  assert.match(run.prompt, /MARCA-PLAN-ARQ/, 'pero también debe llegar su contenido, para no tener que buscarlo');
});

test('Q9.7 · reglas explícitas: límite de turnos, presupuesto de herramientas, varias a la vez y responder antes de agotarlos', async () => {
  const run = await answered;
  const text = `${run.system}\n${run.prompt}`;
  assert.match(text, new RegExp(`${LIMIT}\\s+turnos`), `el especialista debe saber que tiene ${LIMIT} turnos`);
  assert.match(text, /antes de (agotar|quedarte sin)/i, 'regla de parada: responder antes de agotar los turnos');
  assert.match(text, /(a la vez|en paralelo|mismo turno)/i, 'varias lecturas/búsquedas independientes en un mismo turno');
  assert.match(text, /(como m[aá]ximo|hasta|no m[aá]s de)\s+\d+\s+(b[uú]squedas|llamadas|lecturas|herramientas)/i, 'presupuesto de herramientas explícito');
});

// ---------------------------------------------------------------- 4 · portal_search: resultados que empujan a más búsquedas

test('Q9.8 · portal_search recortado orienta (total por archivo y cómo acotar) en vez de devolver 200 líneas sin guía', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-cturns-search-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true }); fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, 'docs', `n${i}.md`), Array.from({ length: 20 }, (_, j) => `modulo nota ${j}`).join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'modulo.ts'), 'export const modulo = 1;\n');
  const r: any = searchTaskFiles({ readRoot: root } as any, 'modulo');
  assert.equal(r.truncated, true);
  assert.ok(r.matches.some((m: any) => m.path === 'src/modulo.ts'), `el código no debe quedar fuera por 600 líneas de docs (primeras: ${r.matches.slice(0, 2).map((m: any) => m.path).join(', ')})`);
  assert.match(JSON.stringify(r), /(acota|subcarpeta|m[aá]s concret)/i, 'un resultado recortado dice cómo acotar');
});

test('Q9.10 · presupuesto de herramientas: agotado, el puente pide responder ya (y anota lo leído para la recuperación)', () => {
  const task: any = { readRoot: repo, toolBudget: 2 };
  assert.equal((searchTaskFiles(task, 'MODULOS') as any).matches[0].path, 'src/arquitectura.ts');
  assert.equal((readTaskFile(task, 'src/extra.ts') as any).path, 'src/extra.ts');
  const over: any = readTaskFile(task, 'src/a.ts');
  assert.ok(isDenied(over)); assert.match(over.error, /presupuesto de herramientas agotado.*responde ya/i);
  assert.deepEqual(task.uses.map((u: any) => [u.tool, u.arg, u.ok]), [['portal_search', 'MODULOS', true], ['portal_read_file', 'src/extra.ts', true]]);
});

// ---------------------------------------------------------------- 5 · Encargos del Asistente (delegation.ts)

test('Q9.9 · encargo del Asistente: la consulta que agota los turnos registra su uso, se recupera UNA vez sin herramientas y el encargo entrega', async () => {
  await answered.catch(() => undefined);
  const lead = pickLeadAgent(S, project.id, 'pj-coordinador');
  const team = teamOf(S, lead).slice(0, 3);
  const member = team.find(a => a.key === 'pj-arquitecto') ?? team[0];
  assert.ok(member);
  for (const a of [lead, ...team]) { const r = await inject('PUT', `${W}/agents/${a.id}/backend`, { backend: a.id === member.id ? 'claude-code' : 'api', authorized: true }); assert.equal(r.statusCode, 200, r.body); }
  const Q = '¿Qué módulos toca el contador?';
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  script.rules = script.rules.map((r: any) => r.text === '__TRIAGE__' ? { ...r, text: JSON.stringify({ accepted: true, rejectionReason: null, understanding: 'Análisis de arquitectura.', plan: ['Consultar'], consults: [{ agentKey: member.key, question: Q }] }) } : r);
  fs.writeFileSync(scriptPath, JSON.stringify(script));
  scenario({ auth: 'subscription', mcpRead: READS, rules: [{ match: Q, maxTurns: true, onlyWithTools: true, tools: SEARCHING, text: 'RECUPERADA-ENCARGO' }] });
  const d = createDelegation(S, project.id, 'pj-coordinador', 'Analiza la arquitectura del módulo contador');
  processesRepo(S).authorize(d.id, 2);
  await runDelegation(S, d.id, () => undefined, () => false);
  const done = processesRepo(S).get(d.id)!;
  const step = done.steps.find(s => s.agentId === member.id)!;
  const runs = ccRuns().filter((r: any) => r.rule === Q);
  assert.ok(step.inputTokens >= 30_000, `el paso registra el uso de la ejecución agotada (tiene ${step.inputTokens}); error: ${step.error}`);
  assert.equal(runs.length, 2, 'la consulta + UNA recuperación');
  assert.ok(!runs[1].args.includes('--mcp-config'), 'recuperación sin herramientas');
  assert.equal(done.status, 'done', done.error ?? '');
  assert.match(done.delegation!.consulted.find(c => c.agentId === member.id)?.answer ?? '', /RECUPERADA-ENCARGO/);
});

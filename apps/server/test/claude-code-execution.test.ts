import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Conector «Claude Code — Local» (fases 3 y 5): adaptador de la CLI (resultado estructurado, salida mal formada, plazo,
 * cancelación, límite de la suscripción, clave de API, herramientas no autorizadas), el pipeline completo con el
 * Desarrollador y QA en Claude Code (worktree aislado, verificación, QA con evidencia, atribución, uso aparte del gasto),
 * sin cambio silencioso a la API, alternativa SOLO autorizada, reinicio, duplicados y la consola del propietario por MCP.
 * CLI SIMULADA y proveedor de API simulado: ningún modelo real, ningún crédito.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-ccx-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-fakeccx-'));
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
const { estimateCallUsd, newPipeline } = await import('../src/services/storyPipeline.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { runCliTask } = await import('../src/services/claudeCode/cli.ts');
const { cliCommandFor, resetDetectionCache } = await import('../src/services/claudeCode/detect.ts');
const { claudeCodeComplete, setBridgeUrl } = await import('../src/services/claudeCode/backend.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-ccx-repo-'));
const uniq = `ccx-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, '.env'), 'SECRETO=no-debe-salir\n');
fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
fs.writeFileSync(path.join(repo, 'scripts/tc.mjs'), "import fs from 'node:fs';\nconst src = fs.readFileSync('src/a.ts', 'utf8');\nif (/: number = \"/.test(src)) { console.log(\"src/a.ts(1,14): error TS2322\"); process.exit(2); }\nconsole.log('typecheck ok');\n");
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node scripts/tc.mjs', test: 'node -e "console.log(\'1 prueba ok\')"', build: 'node -e "console.log(\'build ok\')"' } }, null, 2));
fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: uniq, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.0' } } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
setBridgeUrl(url);
after(async () => { await app.close(); });
const inject = (method: string, u: string, payload?: unknown) => app.inject({ method: method as any, url: u, payload: payload as any });

const PLAN = '{"summary":"Cambiar a","tasks":["Editar src/a.ts"],"filesToRead":["src/a.ts"],"filesToChange":["src/a.ts"],"acceptance":["a = 2"],"risks":[]}';
const OWNER = '=== PARA EL PROPIETARIO ===\nEl contador muestra 2.\n=== PRUEBA MANUAL ===\n1. Abre el contador. Esperado: muestra 2.';
const PATCH = `=== RESUMEN ===\nCambia a.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n${OWNER}`;
const QA_OK = { verdict: 'approved', summary: 'Cumple el criterio; typecheck, test y build en verde.', findings: [], suggestedTests: [] };
const R = { plan: 'plan técnico', dev: 'Implementa la historia', qa: 'Evalúa la implementación con la EVIDENCIA real' };
/** Proveedor de API simulado (solo lo usa quien sigue en la API: el Coordinador, o la alternativa autorizada). */
function apiScript() {
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: R.plan, text: PLAN }, { match: R.qa, text: JSON.stringify(QA_OK) }, { match: R.dev, text: PATCH }], markers: ['typecheck: OK'] }));
  try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
const apiCalls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const ccRules = (extra: Record<string, unknown> = {}) => scenario({ auth: 'subscription', rules: [{ match: R.qa, structured: QA_OK }, { match: R.dev, text: PATCH }], ...extra });

function useFakeSandbox() {
  sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
  sandboxDeps.run = async (_wt, _root, command) => { const t = new Date().toISOString(); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' }; };
}
const real = { ...sandboxDeps };
function useRealSandbox() { sandboxDeps.detect = real.detect; sandboxDeps.run = real.run; }

/** Proceso de historia creado y autorizado; el Desarrollador y QA del proceso pasan a `backend` (con autorización). */
async function storyWith(title: string, backend: 'claude-code' | 'api' = 'claude-code', budget = 2, cfg: Partial<typeof DEFAULT_PIPELINE> = {}) {
  const it = addManualItem(S, project.id, { title, criterion: 'a vale 2 (número)' });
  const p = createStoryProcess(S, project.id, it.id);
  const devId = p.steps.find(s => s.role === 'implementer')!.agentId; const qaId = p.steps.find(s => s.role === 'reviewer')!.agentId;
  for (const id of new Set([devId, qaId])) { const r = await inject('PUT', `${W}/agents/${id}/backend`, { backend, authorized: true }); assert.equal(r.statusCode, 200, r.body); }
  processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, allowInstall: true, ...cfg })) });
  processesRepo(S).authorize(p.id, budget);
  return { p, devId, qaId, planner: p.steps.find(s => s.role === 'planner')! };
}
const run = async (id: string) => { await runStory(S, id, () => undefined, () => false); return processesRepo(S).get(id)!; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn: () => boolean, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('tiempo agotado'); };

// Conector activado con la CLI simulada y el proyecto autorizado (como lo haría el propietario desde la interfaz).
saveClaudeCodeSettings({ ...getClaudeCodeSettings(), cliPath: FAKE });
scenario({ auth: 'subscription' }); resetDetectionCache();
assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true, maxDurationSec: 120 })).statusCode, 200);
assert.equal((await inject('PUT', `${W}/claude-code/projects`, { authorized: true, projectIds: [project.id] })).statusCode, 200);

// ---------------------------------------------------------------- Adaptador de la CLI (13-17)

const cli = cliCommandFor(FAKE)!;
const det = { checkedAt: '', installed: true, path: FAKE, version: '2.1.311', loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', apiProvider: 'firstParty', billing: 'subscription' as const, portalEnvCredentials: [], problems: [], capabilities: ['permission-prompts'] };
const task = (o: Partial<Parameters<typeof runCliTask>[0]> = {}) => runCliTask({ cli, detection: det, model: 'claude-sonnet-4-5', system: 'Eres el agente X.', prompt: 'Implementa la historia de prueba', maxTurns: 4, timeoutMs: 20_000, signal: new AbortController().signal, ...o });

test('13 · resultado estructurado: structured_output → JSON; opciones restringidas y entorno sin credenciales', async () => {
  scenario({ rules: [{ match: 'veredicto', structured: { verdict: 'approved', summary: 'ok', findings: [], suggestedTests: [] } }] });
  process.env.ANTHROPIC_API_KEY = 'sk-ant-del-portal-no-debe-pasar';
  try {
    const r = await task({ prompt: 'Da tu veredicto', schema: { name: 'veredicto_qa', schema: { type: 'object' } } });
    assert.deepEqual(JSON.parse(r.text), { verdict: 'approved', summary: 'ok', findings: [], suggestedTests: [] });
    assert.equal(r.inputTokens, 2000, 'entrada + caché'); assert.equal(r.outputTokens, 400); assert.equal(r.apiEquivalentUsd, 0.0421);
  } finally { delete process.env.ANTHROPIC_API_KEY; }
  const e = ccRuns()[0]; const a: string[] = e.args;
  assert.equal(a[0], '--restricted', 'modo restringido: sin ajustes, hooks ni plugins del usuario y sin herramientas que ejecutan código');
  assert.equal(a[a.indexOf('--input-format') + 1], 'stream-json', 'el encargo va en un segundo mensaje, tras la barrera');
  for (const k of ['CLAUDE_CODE_RESTRICTED', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'DISABLE_AUTOUPDATER']) assert.ok(e.envKeys.includes(k), k);
  assert.equal(a[a.indexOf('--tools') + 1], '', 'sin herramientas integradas');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk'); assert.equal(a[a.indexOf('--permission-prompts') + 1], 'none');
  for (const f of ['--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--json-schema', '--system-prompt-file']) assert.ok(a.includes(f), f);
  assert.ok(!a.some(x => /dangerously|bypassPermissions|^--bare$|acceptEdits/.test(x)), 'nunca se saltan los permisos');
  assert.ok(!e.envKeys.includes('ANTHROPIC_API_KEY') && !e.envKeys.some((k: string) => /^CLAUDE_CODE_OAUTH/.test(k)), 'la clave del Portal no llega a Claude Code');
  assert.equal(e.system, 'Eres el agente X.'); assert.equal(e.prompt, 'Da tu veredicto');
  assert.ok(e.cwd.startsWith(fs.realpathSync(os.tmpdir())) || e.cwd.startsWith(os.tmpdir()), 'carpeta de trabajo temporal');
  assert.ok(!fs.existsSync(path.dirname(e.cwd)), 'y se borra al terminar (prompt de sistema y configuración MCP incluidos)');
});

test('14 · salida mal formada o error de la CLI → error claro, sin inventar un resultado', async () => {
  scenario({ behavior: 'malformed' });
  await assert.rejects(task(), (e: any) => e.error.code === 'provider_error' && /terminó sin resultado/.test(e.message));
  scenario({ behavior: 'error' });
  await assert.rejects(task(), (e: any) => e.error.code === 'provider_error' && /algo falló/.test(e.message));
});

test('15 · plazo agotado: se detiene el proceso de la CLI y se informa (sin reintento automático)', async () => {
  scenario({ behavior: 'hang' });
  await assert.rejects(task({ timeoutMs: 1500 }), (e: any) => e.error.code === 'timeout');
  const pid = Number(fs.readFileSync(path.join(fakeDir, 'fake-claude.pid'), 'utf8'));
  await waitFor(() => !alive(pid));
});

test('16 · cancelación: abortar mata el árbol de procesos de la CLI', async () => {
  scenario({ behavior: 'hang' });
  const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 600);
  await assert.rejects(task({ signal: ctrl.signal }), (e: any) => e.error.code === 'cancelled');
  const pid = Number(fs.readFileSync(path.join(fakeDir, 'fake-claude.pid'), 'utf8'));
  await waitFor(() => !alive(pid));
});

test('17 · límite de la suscripción: error «usage_limit» con la renovación; nunca compra créditos', async () => {
  scenario({ behavior: 'limit' });
  await assert.rejects(task(), (e: any) => e.error.code === 'usage_limit' && /límite de uso/.test(e.message) && /Se renueva/.test(e.message));
  scenario({ behavior: 'limit', creditsRequired: true });
  await assert.rejects(task(), (e: any) => e.error.code === 'usage_limit' && /NO compra créditos/.test(e.message));
});

test('barrera previa: el encargo solo se envía tras comprobar el «init» (origen de la clave, herramientas, puente) con un mensaje en blanco', async () => {
  const blankThenRun = () => fs.readFileSync(ccLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)).map((e: any) => e.kind);
  scenario({ rules: [{ match: 'Implementa', text: 'hecho' }] });
  assert.equal((await task()).text, 'hecho');
  assert.deepEqual(blankThenRun(), ['blank', 'run'], 'primero el mensaje en blanco (sin modelo) y después el encargo');
  // Cualquier origen de la clave que no sea la sesión de la suscripción («none»), conocido o no, detiene ANTES del encargo
  for (const apiKeySource of ['ANTHROPIC_API_KEY', 'apiKeyHelper', 'oauth', null]) {
    scenario({ apiKeySource });
    await assert.rejects(task(), (e: any) => e.error.code === 'backend_unavailable' && /no se llamó al modelo/.test(e.message), String(apiKeySource));
    assert.deepEqual(blankThenRun(), ['blank'], `${apiKeySource}: el encargo nunca se envió`);
  }
  scenario({ behavior: 'foreign_tools' });
  await assert.rejects(task(), (e: any) => /herramientas no autorizadas \(Bash, Read\)/.test(e.message));
  assert.deepEqual(blankThenRun(), ['blank']);
  // El puente configurado pero no conectado, o un mensaje en blanco que informara uso del modelo: también se detiene
  scenario({ mcpStatus: 'failed' });
  await assert.rejects(task({ mcp: { command: process.execPath, args: ['-e', ''], env: {}, tools: ['mcp__portal__portal_read_file'] } }), (e: any) => /puente del Portal no se conectó/.test(e.message));
  scenario({ gateModelCall: true });
  await assert.rejects(task(), (e: any) => /no se comportó como está documentado/.test(e.message));
  assert.deepEqual(blankThenRun(), ['blank']);
});

test('regresión (CLI real 2.1.311): con --json-schema la sesión expone «StructuredOutput»; se admite SOLO si se pidió esquema', async () => {
  // Antes, la comprobación de herramientas lo trataba como ajeno y habría detenido todas las revisiones de QA reales.
  scenario({ rules: [{ match: 'veredicto', structured: { verdict: 'approved', summary: 'ok', findings: [], suggestedTests: [] } }] });
  assert.match((await task({ prompt: 'Da tu veredicto', schema: { name: 'v', schema: { type: 'object' } } })).text, /approved/);
  scenario({ extraTools: ['StructuredOutput'] });
  await assert.rejects(task(), (e: any) => /herramientas no autorizadas \(StructuredOutput\)/.test(e.message), 'sin esquema pedido, no se admite');
});

// ---------------------------------------------------------------- Pipeline completo (8, 21, 22, 24, 25)

test('8 · tarea autorizada de punta a punta: Desarrollador y QA en Claude Code; el Portal aplica, verifica y QA evalúa la evidencia', async () => {
  useFakeSandbox(); apiScript();
  ccRules({ mcpRead: [{ path: 'src/a.ts' }, { path: '.env' }] });
  const { p, devId, qaId, planner } = await storyWith('CC · punta a punta');
  const done = await run(p.id);
  const pl = done.result!.pipeline!;
  assert.equal(done.status, 'done', done.error ?? ''); assert.equal(pl.state, 'verified', pl.reason ?? '');
  // 22 · worktree aislado: los cambios viven en el worktree; la carpeta del propietario no cambia; la CLI nunca trabajó en ellos
  assert.equal(fs.readFileSync(path.join(done.result!.applied!.worktree!, 'src/a.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const a = 2;\n');
  assert.equal(fs.readFileSync(path.join(repo, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
  const runs = ccRuns();
  assert.equal(runs.length, 2, 'dos ejecuciones de Claude Code: implementación y QA');
  for (const r of runs) { assert.ok(!r.cwd.startsWith(repo) && !r.cwd.includes('worktrees'), 'la CLI no corre en el repositorio ni en el worktree'); }
  // Lectura por el puente MCP: solo lectura, ruta protegida denegada, solo herramientas de ejecución
  const dev = runs.find((r: any) => r.rule === R.dev)!;
  assert.deepEqual(dev.mcp.tools.sort(), ['portal_knowledge', 'portal_list_files', 'portal_read_file', 'portal_report_progress', 'portal_task_context']);
  assert.equal(dev.mcp.results[0].isError, false); assert.match(dev.mcp.results[0].text, /export const a = 1/);
  assert.equal(dev.mcp.results[1].isError, true); assert.match(dev.mcp.results[1].text, /protegida/);
  // 24 · QA recibe la evidencia real de la verificación (resultado estructurado nativo de la CLI)
  const qa = runs.find((r: any) => r.rule === R.qa)!;
  assert.match(qa.prompt, /typecheck: OK/); assert.ok(qa.args.includes('--json-schema'));
  assert.equal(done.result!.review?.verdict, 'approved'); assert.equal(done.result!.review?.evidenceBased, true);
  // 21 · atribución: cada ejecución vuelve a SU agente y SU paso; el uso va aparte del gasto en USD
  const steps = done.steps; const devStep = steps.find(s => s.role === 'implementer' && s.agentId === devId)!; const qaStep = steps.find(s => s.role === 'reviewer' && s.agentId === qaId && s.status === 'done')!;
  for (const s of [devStep, qaStep]) { assert.equal(s.backend, 'Claude Code — Suscripción'); assert.equal(s.costUsd, 0); assert.equal(s.inputTokens, 2000); }
  const recorded = claudeCodeRunsRepo(S).recent(10).filter(r => r.processId === p.id);
  assert.deepEqual(recorded.map(r => [r.agentId, r.stepId, r.status, r.billing]).sort(), [[devId, devStep.id, 'done', 'subscription'], [qaId, qaStep.id, 'done', 'subscription']].sort());
  assert.ok(recorded.every(r => r.apiEquivalentUsd === 0.0421 && r.numTurns && r.authMethod === 'claude.ai'), 'equivalente estimado registrado aparte, no como gasto');
  // 25 · la API sigue igual para quien la usa: el Coordinador planifica con la API (con costo); nadie más la llamó
  const plan = steps.find(s => s.id === planner.id)!;
  assert.ok(plan.costUsd > 0 && !plan.backend); assert.deepEqual(apiCalls().map(c => c.rule), [R.plan]);
  assert.ok(Math.abs(done.spentUsd - plan.costUsd) < 1e-9, 'el gasto del proceso es solo el de la API');
  const view = (await inject('GET', `${W}/claude-code`)).json();
  assert.equal(view.usageToday.runs >= 2, true); assert.ok(view.usageToday.apiEquivalentUsd > 0);
  // Vista por agente: su participación real con Claude Code, aparte de su gasto en la API
  const perAgent = (await inject('GET', `${W}/agents/${devId}/claude-code`)).json();
  assert.equal(perAgent.backend, 'claude-code'); assert.ok(perAgent.usage.runs >= 1 && perAgent.runs.every((r: any) => r.agentId === devId));
  assert.deepEqual(perAgent.projects, [{ id: project.id, authorized: true }]); assert.equal(perAgent.limits.fallback, 'none');
  assert.equal((await inject('GET', `${W}/agents/no-existe/claude-code`)).statusCode, 404);
  assert.ok(!done.result!.merged, 'nunca integra solo');
});

test('17-18 · límite de la suscripción en el pipeline: pausa con explicación, lo hecho se conserva y NO se llama a la API', async () => {
  useFakeSandbox(); apiScript(); scenario({ auth: 'subscription', behavior: 'limit' });
  const { p } = await storyWith('CC · límite');
  const done = await run(p.id);
  const pl = done.result!.pipeline!;
  assert.equal(pl.state, 'paused'); assert.equal(pl.pauseKind, 'subscription_limit');
  assert.match(pl.reason!, /límite de uso/); assert.match(pl.reason!, /no se ha cambiado a otro proveedor facturable/);
  assert.deepEqual(apiCalls().map(c => c.rule), [R.plan], 'ninguna llamada de API para sustituir a Claude Code');
  assert.equal(claudeCodeRunsRepo(S).recent(5).find(r => r.processId === p.id)?.status, 'limit');
  const flow = (await inject('GET', `${W}/processes/${p.id}`)).json().guidance.flow;
  assert.equal(flow.issue.title, 'Pausado: la suscripción de Claude alcanzó su límite de uso');
  assert.ok(flow.actions.some((a: any) => a.label === 'Continuar cuando se renueve el límite' && !a.requires.includes('ai_budget')), 'continuar no pide presupuesto de API');
});

test('alternativa por API SOLO si el propietario la autorizó: se usa con su presupuesto y queda señalada', async () => {
  useFakeSandbox(); apiScript(); scenario({ auth: 'subscription', behavior: 'limit' });
  assert.equal((await inject('PUT', '/api/claude-code/settings', { fallback: 'api', authorized: true })).statusCode, 200);
  try {
    const { p, devId } = await storyWith('CC · alternativa autorizada');
    const done = await run(p.id);
    assert.equal(done.result!.pipeline!.state, 'verified', done.result!.pipeline!.reason ?? '');
    const devStep = done.steps.find(s => s.role === 'implementer' && s.agentId === devId)!;
    assert.match(devStep.backend ?? '', /alternativa autorizada a Claude Code/); assert.ok(devStep.costUsd > 0, 'con costo de API');
    assert.ok(apiCalls().some(c => c.rule === R.dev));
  } finally { assert.equal((await inject('PUT', '/api/claude-code/settings', { fallback: 'none' })).statusCode, 200); }
});

test('25 · un agente en la API conserva el comportamiento de siempre (presupuesto, costo, sin registro del conector)', async () => {
  useFakeSandbox(); apiScript(); scenario({ auth: 'subscription' });
  const { p, devId } = await storyWith('API · sin cambios', 'api');
  const ag = agentsRepo(S).get(devId)!;
  assert.ok(estimateCallUsd(ag, 'sistema', 'usuario', 1000) > 0);
  assert.equal(estimateCallUsd({ ...ag, config: { ...ag.config, backend: 'claude-code' } }, 'sistema', 'usuario', 1000), 0);
  const done = await run(p.id);
  assert.equal(done.result!.pipeline!.state, 'verified');
  assert.equal(ccRuns().length, 0, 'Claude Code no se invoca'); assert.ok(done.steps.every(s => !s.backend));
  assert.deepEqual(apiCalls().map(c => c.rule), [R.plan, R.dev, R.qa]);
});

test('prueba de humo: solo con autorización; UNA llamada mínima (haiku, 1 turno, sin herramientas ni puente) que queda registrada', async () => {
  scenario({ auth: 'subscription', defaultText: 'OK' });
  assert.equal((await inject('POST', '/api/claude-code/smoke-test', {})).statusCode, 403);
  assert.equal(ccRuns().length, 0, 'sin autorización no se lanza nada');
  const r = await inject('POST', '/api/claude-code/smoke-test', { authorized: true });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.answer, 'OK'); assert.equal(j.expected, true); assert.equal(j.authMethod, 'claude.ai'); assert.equal(j.apiKeySource, 'none'); assert.equal(j.apiBudgetChargedUsd, 0);
  assert.equal(j.model, 'claude-haiku-5-5'); assert.equal(j.exitCode, 0); assert.deepEqual(j.session.tools, [], 'sin herramientas: ni integradas, ni puente, ni salida estructurada');
  assert.deepEqual(j.session.mcpServers, []); assert.equal(j.session.permissionMode, 'dontAsk');
  const runs = ccRuns(); assert.equal(runs.length, 1); assert.equal(runs[0].prompt, 'Respond with exactly the word OK.');
  const a: string[] = runs[0].args;
  assert.equal(a[a.indexOf('--model') + 1], 'haiku'); assert.equal(a[a.indexOf('--max-turns') + 1], '1'); assert.ok(!a.includes('--mcp-config'));
  assert.equal(claudeCodeRunsRepo(S).get(j.runId)?.agentName, 'Prueba de humo del conector');
  scenario({ auth: 'api_key' }); resetDetectionCache();
  assert.equal((await inject('POST', '/api/claude-code/smoke-test', { authorized: true })).statusCode, 409, 'con facturación por API no se ejecuta');
  assert.equal(ccRuns().length, 0);
  scenario({ auth: 'subscription' }); resetDetectionCache();
});

test('una respuesta mal formada de Claude Code nunca cuenta como implementación: nada se aplica ni se verifica', async () => {
  useFakeSandbox(); apiScript(); scenario({ auth: 'subscription', rules: [{ match: R.qa, structured: QA_OK }], defaultText: 'Hecho, he revisado la historia.' });
  const { p } = await storyWith('CC · respuesta mal formada', 'claude-code', 2, { maxOutputRepairs: 0 });
  const done = await run(p.id);
  const r = done.result!; const pl = r.pipeline!;
  assert.notEqual(pl.state, 'verified'); assert.ok(!r.applied, 'sin cambios aplicados'); assert.equal(r.verifications.length, 0, 'sin verificación');
  assert.ok(!ccRuns().some((x: any) => x.rule === R.qa), 'QA no se llama sobre una entrega inexistente');
});

test('conector desactivado o proyecto no autorizado: los agentes no pueden invocar Claude Code (pausa explicada, 0 ejecuciones)', async () => {
  useFakeSandbox(); apiScript(); scenario({ auth: 'subscription' });
  const a = await storyWith('CC · conector desactivado');
  assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: false })).statusCode, 200);
  try {
    const done = await run(a.p.id);
    assert.equal(done.result!.pipeline!.pauseKind, 'permission'); assert.match(done.result!.pipeline!.reason!, /desactivado/);
    assert.equal(ccRuns().length, 0, 'Claude Code no se ejecutó');
    assert.deepEqual(apiCalls().map(c => c.rule), [R.plan], 'y no se sustituyó por la API');
  } finally { assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true })).statusCode, 200); }
  apiScript(); scenario({ auth: 'subscription' });
  const b = await storyWith('CC · proyecto no autorizado');
  assert.equal((await inject('PUT', `${W}/claude-code/projects`, { authorized: true, projectIds: [] })).statusCode, 200);
  try {
    const done = await run(b.p.id);
    assert.match(done.result!.pipeline!.reason!, /no está autorizado para Claude Code/); assert.equal(ccRuns().length, 0);
  } finally { assert.equal((await inject('PUT', `${W}/claude-code/projects`, { authorized: true, projectIds: [project.id] })).statusCode, 200); }
});

test('cancelar el proceso desde el Portal detiene la ejecución de Claude Code en curso (árbol de procesos incluido)', async () => {
  useFakeSandbox(); apiScript(); scenario({ auth: 'subscription', behavior: 'hang' });
  const pidFile = path.join(fakeDir, 'fake-claude.pid'); try { fs.unlinkSync(pidFile); } catch { /* vacío */ }
  const it = addManualItem(S, project.id, { title: 'CC · cancelación', criterion: 'a vale 2' });
  const p = createStoryProcess(S, project.id, it.id);
  for (const s of p.steps.filter(x => x.role === 'implementer' || x.role === 'reviewer')) assert.equal((await inject('PUT', `${W}/agents/${s.agentId}/backend`, { backend: 'claude-code', authorized: true })).statusCode, 200);
  const auth = await inject('POST', `${W}/processes/${p.id}/authorize`, { budgetUsd: 1, authorized: true, pipeline: { autoApply: true, autoVerify: true, commands: ['typecheck'] } });
  assert.equal(auth.statusCode, 200, auth.body);
  await waitFor(() => fs.existsSync(pidFile), 20_000);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal((await inject('POST', `${W}/processes/${p.id}/cancel`)).statusCode, 200);
  await waitFor(() => processesRepo(S).get(p.id)!.status !== 'running', 20_000);
  await waitFor(() => !alive(pid));
  assert.equal(processesRepo(S).get(p.id)!.status, 'cancelled');
  assert.equal(claudeCodeRunsRepo(S).recent(5).find(r => r.processId === p.id)?.status, 'cancelled');
});

const waitIdle = async (id: string) => { for (let i = 0; i < 600; i++) { if (processesRepo(S).get(id)!.status !== 'running') return processesRepo(S).get(id)!; await new Promise(r => setTimeout(r, 50)); } throw new Error('sigue en ejecución'); };

test('antes de empezar: con el proyecto sin autorizar, autorizar la ejecución se rechaza sin cambiar nada y la historia ofrece autorizar el proyecto', async () => {
  useFakeSandbox(); apiScript(); ccRules();
  assert.equal((await inject('PUT', `${W}/claude-code/projects`, { authorized: true, projectIds: [] })).statusCode, 200);
  const it = addManualItem(S, project.id, { title: 'CC · antes de empezar', criterion: 'a vale 2' });
  const p = createStoryProcess(S, project.id, it.id);
  const devId = p.steps.find(s => s.role === 'implementer')!.agentId;
  assert.equal((await inject('PUT', `${W}/agents/${devId}/backend`, { backend: 'claude-code', authorized: true })).statusCode, 200);
  const res = await inject('POST', `${W}/processes/${p.id}/authorize`, { budgetUsd: 1, authorized: true });
  assert.equal(res.statusCode, 409); assert.equal(res.json().code, 'backend_not_ready'); assert.match(res.json().error, /^No se inicia: El proyecto «.+» no está autorizado para Claude Code/);
  const still = processesRepo(S).get(p.id)!;
  assert.equal(still.status, 'pending_authorization'); assert.equal(still.budgetUsd, p.budgetUsd); assert.equal(still.authorizedAt ?? null, null, 'no se autorizó nada');
  assert.equal(apiCalls().length, 0, 'ni el plan se pagó'); assert.equal(ccRuns().length, 0);
  const flow = (await inject('GET', `${W}/processes/${p.id}`)).json().guidance.flow;
  assert.match(flow.issue.title, /^Falta autorizar «.+» para Claude Code$/);
  assert.equal(flow.actions[0].id, 'claude_code_fix'); assert.ok(flow.actions[0].primary); assert.ok(!flow.actions.some((a: any) => a.id === 'authorize'), 'autorizar la ejecución solo fallaría');
  const fixed = await inject('POST', `${W}/processes/${p.id}/claude-code/fix`, { authorized: true, ...flow.actions[0].backendFix });
  assert.equal(fixed.statusCode, 200); assert.equal(fixed.json().verified, true);
  assert.equal(processesRepo(S).get(p.id)!.status, 'pending_authorization', 'autorizar el proyecto no inicia el proceso');
  const after = (await inject('GET', `${W}/processes/${p.id}`)).json().guidance.flow;
  assert.equal(after.issue, null); assert.equal(after.actions[0].id, 'authorize');
  assert.equal((await inject('PUT', `${W}/agents/${devId}/backend`, { backend: 'api', authorized: true })).statusCode, 200);
  processesRepo(S).finish(p.id, 'cancelled');
});

test('F/G · proyecto sin autorizar: se ve antes, pausa SIN pasos huérfanos y «autorizar y continuar» retoma sin repetir lo hecho', async () => {
  useFakeSandbox(); apiScript(); ccRules();
  assert.equal((await inject('PUT', `${W}/claude-code/projects`, { authorized: true, projectIds: [] })).statusCode, 200);
  const { p, devId } = await storyWith('CC · autorizar y continuar');
  const before = (await inject('GET', `${W}/processes/${p.id}/backends`)).json();
  assert.equal(before.projectAuthorized, false); assert.equal(before.ready, false, 'visible ANTES de empezar');
  assert.equal(before.team.find((t: any) => t.agentId === devId).problem, 'project');
  const paused = await run(p.id);
  assert.equal(paused.result!.pipeline!.pauseKind, 'permission');
  for (let i = 0; i < 2; i++) { // dos «Continuar» sin arreglar nada: rechazados ANTES de tocar el proceso (HU-159: 80 eventos de pausas repetidas)
    const cur = processesRepo(S).get(p.id)!;
    const res = await inject('POST', `${W}/processes/${p.id}/continue`, { authorized: true });
    assert.equal(res.statusCode, 409); assert.equal(res.json().code, 'backend_not_ready'); assert.match(res.json().error, /no está autorizado para Claude Code/);
    const now = processesRepo(S).get(p.id)!;
    assert.equal(now.steps.length, cur.steps.length, 'sin pasos nuevos'); assert.equal(now.result!.pipeline!.events.length, cur.result!.pipeline!.events.length, 'sin eventos nuevos');
    assert.equal(now.status, cur.status); assert.equal(now.budgetUsd, cur.budgetUsd);
  }
  assert.equal(ccRuns().length, 0, 'Claude Code nunca se llamó'); assert.deepEqual(apiCalls().map(c => c.rule), [R.plan], 'ni la API en su lugar');
  const flow = (await inject('GET', `${W}/processes/${p.id}`)).json().guidance.flow;
  assert.match(flow.issue.title, /^Falta autorizar «.+» para Claude Code$/, 'el bloqueo exacto, no «hace falta un permiso»');
  assert.deepEqual(flow.issue.links, [{ label: 'Proveedores → Claude Code — Local', href: '/configuracion/proveedor#claude-code' }]);
  assert.ok(!flow.actions.some((a: any) => a.id === 'pipeline_resume'), 'mientras no esté resuelto no se ofrece «Continuar» (solo volvería a pausar)');
  assert.equal(flow.actions.find((a: any) => a.id === 'open_settings')?.href, '/configuracion/proveedor#claude-code');
  const fix = flow.actions.find((a: any) => a.id === 'claude_code_fix');
  assert.ok(fix?.primary, 'acción «autorizar»'); assert.deepEqual(fix.backendFix, { authorizeProject: true, switchToManaged: [] }); assert.match(fix.label, /^Autorizar «.+» para Claude Code$/);
  assert.equal((await inject('POST', `${W}/processes/${p.id}/claude-code/fix`, { authorizeProject: true })).statusCode, 400, 'exige autorización explícita');
  const eventsBefore = processesRepo(S).get(p.id)!.result!.pipeline!.events.length;
  const fixed = await inject('POST', `${W}/processes/${p.id}/claude-code/fix`, { authorized: true, ...fix.backendFix });
  assert.equal(fixed.statusCode, 200, fixed.body); assert.equal(fixed.json().ready, true); assert.equal(fixed.json().verified, true); assert.equal(fixed.json().projectAuthorized, true);
  assert.equal(processesRepo(S).get(p.id)!.result!.pipeline!.events.length, eventsBefore, 'autorizar no continúa por sí solo');
  assert.equal(ccRuns().length, 0, 'autorizar no llama a Claude Code');
  // Verificado: la pausa guardada pasa a «listo, falta continuar» y solo entonces se ofrece continuar lo pendiente.
  const ready = (await inject('GET', `${W}/processes/${p.id}`)).json().guidance.flow;
  assert.equal(ready.issue.title, 'Claude Code ya está listo: falta continuar'); assert.equal(ready.issue.level, 'warning');
  assert.ok(!ready.actions.some((a: any) => a.id === 'claude_code_fix'));
  const resume = ready.actions.find((a: any) => a.id === 'pipeline_resume');
  assert.equal(resume.label, 'Continuar la operación pendiente'); assert.ok(resume.primary); assert.deepEqual(resume.requires, ['authorization']);
  const cfgBefore = processesRepo(S).get(p.id)!.result!.pipeline!.config;
  assert.equal((await inject('POST', `${W}/processes/${p.id}/continue`, { authorized: true })).statusCode, 200);
  assert.deepEqual(processesRepo(S).get(p.id)!.result!.pipeline!.config, cfgBefore, 'sin correcciones ni márgenes nuevos');
  const done = await waitIdle(p.id);
  assert.equal(done.result!.pipeline!.state, 'verified', done.result!.pipeline!.reason ?? '');
  assert.deepEqual(apiCalls().map(c => c.rule), [R.plan], 'el plan (pagado) NO se repite');
  assert.equal(ccRuns().filter((r: any) => r.rule === R.dev).length, 1); assert.equal(ccRuns().filter((r: any) => r.rule === R.qa).length, 1);
});

test('D/E · «tu consola» sin consola conectada: no aparenta trabajar; pausa explicada y «pasar a gestionado y continuar» (sin API)', async () => {
  useFakeSandbox(); apiScript(); ccRules();
  const { p, devId, qaId } = await storyWith('CC · consola sin conectar', 'claude-code-terminal' as any);
  const rd = (await inject('GET', `${W}/processes/${p.id}/backends`)).json();
  const dev = rd.team.find((t: any) => t.agentId === devId);
  assert.equal(dev.label, 'Claude Code — Consola (no verificado)'); assert.equal(dev.problem, 'console'); assert.match(dev.reason, /no hay ninguna consola conectada/);
  const paused = await run(p.id);
  assert.equal(paused.status === 'running', false, 'no queda «en ejecución»'); assert.equal(paused.result!.pipeline!.pauseKind, 'permission');
  assert.match(paused.result!.pipeline!.reason!, /consola/);
  const fix = (await inject('GET', `${W}/processes/${p.id}`)).json().guidance.flow.actions.find((a: any) => a.id === 'claude_code_fix');
  assert.deepEqual(fix.backendFix.switchToManaged.sort(), [devId, qaId].sort()); assert.equal(fix.backendFix.authorizeProject, false);
  assert.equal((await inject('POST', `${W}/processes/${p.id}/claude-code/fix`, { authorized: true, ...fix.backendFix })).statusCode, 200);
  assert.equal(agentsRepo(S).get(devId)!.config.backend, 'claude-code', 'cambio de backend solo con la autorización');
  assert.equal((await inject('POST', `${W}/processes/${p.id}/continue`, { authorized: true })).statusCode, 200);
  const done = await waitIdle(p.id);
  assert.equal(done.result!.pipeline!.state, 'verified'); assert.deepEqual(apiCalls().map(c => c.rule), [R.plan], 'sin API para dev ni QA');
});

test('H · «test» solo con canceladas y sin causa: se repite UNA vez sin IA (no se paga una corrección); si sigue igual, pausa de entorno', async () => {
  const CANCELLED = "not ok 1 - suite\n  ---\n  type: 'suite'\n  ...\n    not ok 1 - caso\n      ---\n      failureType: 'cancelledByParent'\n      error: 'test did not finish before its parent and was cancelled'\n      ...\n# tests 1\n# pass 0\n# fail 0\n# cancelled 1";
  for (const second of ['pass', 'cancelled'] as const) {
    apiScript(); ccRules();
    let tests = 0;
    sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
    sandboxDeps.run = async (_wt, _root, command) => {
      const t = new Date().toISOString(); let exitCode = 0; let output = `${command} ok`;
      if (command === 'test') { tests++; if (tests === 1 || second === 'cancelled') { exitCode = 1; output = CANCELLED; } else output = '# tests 1\n# pass 1\n# fail 0'; }
      return { command, exitCode, output, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' };
    };
    const { p } = await storyWith(`CC · canceladas (${second})`);
    const done = await run(p.id); const pl = done.result!.pipeline!;
    assert.equal(tests, 2, 'test se ejecutó exactamente dos veces');
    assert.ok(pl.events.some(e => /solo tiene 1 prueba\(s\) canceladas.*sin IA/.test(e.message)));
    assert.equal(pl.corrections, 0); assert.equal(pl.correctionAttempts ?? 0, 0, 'ninguna corrección pagada');
    assert.equal(ccRuns().filter((r: any) => r.rule !== R.dev && r.rule !== R.qa).length, 0, 'ninguna llamada extra a Claude Code');
    if (second === 'pass') assert.equal(pl.state, 'verified', pl.reason ?? '');
    else { assert.equal(pl.pauseKind, 'environment'); assert.match(pl.reason!, /No es un defecto de la implementación/); }
  }
  useFakeSandbox();
});

// ---------------------------------------------------------------- Reinicio, duplicados y concurrencia (19, 20)

test('19 · reinicio: una ejecución «en curso» de un arranque anterior queda «interrumpida» (no se reenvía nada)', async () => {
  const r = claudeCodeRunsRepo(S).start({ mode: 'cli', projectId: project.id, processId: null, stepId: null, agentId: 'a', agentName: 'A', model: 'm', billing: 'subscription', authMethod: 'claude.ai', subscriptionType: 'max' });
  const mod = pathToFileURL(path.resolve(here, '../src/db/workspace.ts')).href;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', `const { claudeCodeRunsRepo } = await import(${JSON.stringify(mod)}); console.log(JSON.stringify(claudeCodeRunsRepo(${JSON.stringify(S)}).get(${JSON.stringify(r.id)})));`],
    { cwd: path.resolve(here, '..'), env: { ...process.env }, encoding: 'utf8' });
  const after = JSON.parse(out.trim().split('\n').at(-1)!);
  assert.equal(after.status, 'interrupted'); assert.match(after.error, /reinició/);
});

test('20 · sin ejecuciones duplicadas: la misma llamada en curso no se lanza dos veces; el límite de concurrencia pone en cola', async () => {
  scenario({ auth: 'subscription', slowMs: 1200, defaultText: 'hecho' });
  const ag = agentsRepo(S).get(processesRepo(S).list(project.id)[0].steps.find(s => s.role === 'implementer')!.agentId)!;
  assert.equal((await inject('PUT', `${W}/agents/${ag.id}/backend`, { backend: 'claude-code', authorized: true })).statusCode, 200);
  const agent = agentsRepo(S).get(ag.id)!;
  const target = { slug: S, projectId: project.id, processId: null, stepId: 'paso-x', agent, role: 'implementer', title: 'Paso X' };
  const req = { model: 'claude-sonnet-4-5', system: 's', user: 'misma petición', maxTokens: 100, effort: 'low' as const, supportsEffort: false };
  const live: string[] = [];
  const [a, b] = await Promise.allSettled([claudeCodeComplete(target, req, new AbortController().signal, l => live.push(l.lastEvent ?? '')), claudeCodeComplete(target, req, new AbortController().signal, () => undefined)]);
  assert.equal([a, b].filter(x => x.status === 'fulfilled').length, 1);
  assert.match(((a.status === 'rejected' ? a : b) as PromiseRejectedResult).reason.message, /idéntica.*no se duplica/);
  // Dos llamadas distintas con máximo 1 a la vez: la segunda espera su turno y ambas terminan
  const queued: string[] = [];
  const [c, d] = await Promise.all([claudeCodeComplete(target, { ...req, user: 'uno' }, new AbortController().signal, () => undefined), claudeCodeComplete({ ...target, stepId: 'paso-y' }, { ...req, user: 'dos' }, new AbortController().signal, l => queued.push(l.lastEvent ?? ''))]);
  assert.equal(c.text, 'hecho'); assert.equal(d.text, 'hecho');
  assert.ok(queued.some(m => /En cola/.test(m)), 'la segunda esperó turno');
});

// ---------------------------------------------------------------- Consola del propietario por MCP

function mcpClient(token: string) {
  const child = spawn(process.execPath, [path.resolve(here, '../../../scripts/portal-mcp.mjs')], { env: { ...process.env, PORTAL_URL: url, PORTAL_BRIDGE_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; let next = 1; const waiting = new Map<number, (m: any) => void>();
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(l); waiting.get(m.id)?.(m); } });
  const rpc = (method: string, params: unknown = {}) => new Promise<any>(r => { const id = next++; waiting.set(id, r); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name: string, args: unknown = {}) => { const m = await rpc('tools/call', { name, arguments: args }); const text = m.result?.content?.[0]?.text as string; let json = null; try { json = JSON.parse(text); } catch { /* texto */ } return { isError: !!m.result?.isError, text, json }; };
  return { rpc, tool, close: () => new Promise<void>(r => { child.on('close', () => r()); child.stdin.end(); }) };
}

test('consola del propietario: toma la tarea por MCP, lee con permiso, informa y entrega; el resultado vuelve al mismo agente', async () => {
  const qaAgentId = processesRepo(S).list(project.id)[0].steps.find(s => s.role === 'reviewer')!.agentId;
  assert.equal((await inject('PUT', `${W}/agents/${qaAgentId}/backend`, { backend: 'claude-code-terminal', authorized: true })).statusCode, 200);
  const agent = agentsRepo(S).get(qaAgentId)!;
  const target = { slug: S, projectId: project.id, processId: null, stepId: 'paso-consola', agent, role: 'reviewer', title: 'Revisión desde la consola' };
  const req = { model: 'claude-sonnet-4-5', system: 'Eres QA.', user: 'Revisa el cambio de src/a.ts', maxTokens: 100, effort: 'low' as const, supportsEffort: false };
  // 6 · sin consola conectada: falla en el acto, sin esperar ni cambiar de origen
  await assert.rejects(claudeCodeComplete(target, req, new AbortController().signal, () => undefined), (e: any) => e.error.code === 'backend_unavailable' && /no hay ninguna consola conectada/.test(e.message));
  const w = (await inject('POST', `${W}/claude-code/workers`, { authorized: true, name: 'Consola de Yair', agentIds: [qaAgentId] })).json();
  const mcp = mcpClient(w.token);
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'consola', version: '1' } });
  await new Promise(r => setTimeout(r, 300));
  const live: string[] = [];
  const pending = claudeCodeComplete(target, req, new AbortController().signal, l => live.push(l.lastEvent ?? ''));
  await new Promise(r => setTimeout(r, 100));
  const list = await mcp.tool('portal_list_tasks');
  assert.equal(list.json.tasks.length, 1); assert.equal(list.json.tasks[0].agent, agent.config.name);
  const id = list.json.tasks[0].id;
  assert.equal((await mcp.tool('portal_read_file', { task_id: id, path: 'src/a.ts' })).isError, true, 'leer exige tomar la tarea antes');
  const claimed = await mcp.tool('portal_claim_task', { task_id: id });
  assert.equal(claimed.json.instructions, 'Eres QA.'); assert.equal(claimed.json.prompt, 'Revisa el cambio de src/a.ts'); assert.equal(claimed.json.context.agent.name, agent.config.name);
  assert.match((await mcp.tool('portal_read_file', { task_id: id, path: 'src/a.ts' })).text, /export const a = 1/);
  assert.equal((await mcp.tool('portal_read_file', { task_id: id, path: '.env' })).isError, true);
  assert.equal((await mcp.tool('portal_report_progress', { task_id: id, message: 'Revisando el diff' })).isError, false);
  assert.equal((await mcp.tool('portal_submit_result', { task_id: id, text: `clave sk-ant-${'x'.repeat(30)}` })).isError, true, 'un secreto en el resultado se rechaza');
  assert.equal((await mcp.tool('portal_submit_result', { task_id: id, text: '{"verdict":"approved","summary":"ok","findings":[],"suggestedTests":[]}' })).isError, false);
  const res = await pending;
  assert.match(res.text, /approved/); assert.equal(res.backendLabel, 'Claude Code — Consola (no verificado)'); assert.equal(res.billing, 'unverified');
  assert.ok(live.some(m => /Revisando el diff/.test(m)), 'el progreso de la consola se ve en el paso');
  const runRow = claudeCodeRunsRepo(S).byStep('paso-consola').at(-1)!;
  assert.equal(runRow.mode, 'terminal'); assert.equal(runRow.status, 'done'); assert.equal(runRow.agentId, qaAgentId); assert.equal(runRow.progress, 'Revisando el diff');
  assert.equal((await mcp.tool('portal_submit_result', { task_id: id, text: 'otra vez' })).isError, true, 'una tarea entregada no se entrega dos veces');
  await mcp.close();
});

// ---------------------------------------------------------------- HU-159 · turnos agotados (A–D)

/** Plan con un entregable (entrega incremental); «test» falla hasta que src/a.ts tenga la corrección. */
async function maxTurnsStory(title: string, focusedOk: boolean) {
  const PLAN_U = JSON.stringify({ summary: 'a vale 2', tasks: ['Editar src/a.ts'], filesToRead: ['src/a.ts'], filesToChange: ['src/a.ts'], deliverables: [{ path: 'src/a.ts', purpose: 'a vale 2', kind: 'code', estimatedLines: 3 }], acceptance: ['a = 2'], risks: [] });
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: R.plan, text: PLAN_U }], markers: [] }));
  try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  const FIXED = '=== RESUMEN ===\nCorrige.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 2;\n==== REEMPLAZAR\nexport const a = 2; // corregido\n>>>> FIN\n=== FIN ARCHIVO ===\n';
  scenario({ auth: 'subscription', rules: [
    { match: R.qa, structured: QA_OK },
    { match: 'El intento anterior agotó los turnos', ...(focusedOk ? { text: FIXED } : { maxTurns: true }) },
    { match: 'Corrige la implementación de esta historia', maxTurns: true },
    { match: 'Esta es la unidad 1 de 1', text: PATCH }
  ] });
  sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
  sandboxDeps.run = async (wt, _root, command) => {
    const t = new Date().toISOString(); const ok = command !== 'test' || /corregido/.test(fs.readFileSync(path.join(wt, 'src/a.ts'), 'utf8'));
    return { command, exitCode: ok ? 0 : 1, output: ok ? `${command} ok` : "TAP version 13\nnot ok 1 - a vale 2 y está corregido\n  ---\n  location: '/work/test/a.test.ts:1:1'\n  failureType: 'testCodeFailure'\n  error: 'falta la corrección en src/a.ts'\n  ...\n# tests 1\n# pass 0\n# fail 1", startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' };
  };
  assert.equal((await inject('PUT', `${W}/claude-code/projects`, { authorized: true, projectIds: [project.id] })).statusCode, 200);
  return storyWith(title, 'claude-code', 2, { autoApply: true, commands: ['typecheck', 'test', 'build'] });
}
const corrCalls = () => ccRuns().filter((r: any) => r.rule === 'Corrige la implementación de esta historia' || r.rule === 'El intento anterior agotó los turnos');

test('A/B/C · turnos agotados: CLAUDE_CODE_MAX_TURNS_EXHAUSTED (no conexión), uso registrado, lo hecho se conserva y el reintento es ACOTADO sin repetir lo terminado', async () => {
  const { p } = await maxTurnsStory('CC · turnos agotados', true);
  const limit = getClaudeCodeSettings().maxTurns;
  const paused = await run(p.id); const pl = paused.result!.pipeline!; const man = paused.result!.manifest!;
  // A · clasificación propia, con el límite configurado, lo que se usó y sin confundirlo con la conexión
  assert.equal(pl.pauseKind, 'max_turns', pl.reason ?? ''); assert.equal(pl.failureClass, 'CLAUDE_CODE_MAX_TURNS_EXHAUSTED');
  assert.match(pl.reason!, new RegExp(`agotó los turnos autorizados \\(${limit}\\)`)); assert.match(pl.reason!, /portal_read_file/); assert.match(pl.reason!, /No es un error de conexión/);
  assert.match(pl.reason!, /tokens de entrada con tu suscripción de Claude \(0 USD de la API\)/, 'el uso del siguiente intento se dice antes');
  const failed = paused.steps.filter(s => s.status === 'failed');
  assert.equal(failed.length, 1); assert.equal(failed[0].inputTokens, 30_000, 'el uso de la suscripción se registra (no «0 tokens»)'); assert.equal(failed[0].costUsd, 0);
  const runRec = claudeCodeRunsRepo(S).byStep(failed[0].id)[0];
  assert.equal(runRec.status, 'failed'); assert.equal(runRec.numTurns, limit + 1); assert.equal(runRec.tokensIn, 30_000);
  // B · lo terminado se conserva: la unidad del plan aplicada y su commit; la corrección queda pendiente (no fallida)
  assert.equal(man.units[0].status, 'done'); assert.deepEqual(man.units[0].applied, ['src/a.ts']);
  const corr = man.units.find(u => u.kind === 'correction')!;
  assert.equal(corr.status, 'pending'); assert.equal(corr.maxTurns, 1);
  assert.match(fs.readFileSync(path.join(paused.result!.applied!.worktree!, 'src/a.ts'), 'utf8'), /export const a = 2;/);
  const flow = (await inject('GET', `${W}/processes/${p.id}`)).json().guidance.flow;
  assert.match(flow.issue.title, /Claude Code agotó sus turnos/); assert.equal(flow.actions[0].label, 'Reintentar solo lo pendiente, acotado');
  assert.ok(!flow.actions.some((a: any) => /Repetir la llamada/.test(a.label)), 'no se ofrece repetir el mismo encargo');
  // C · continuar: un intento acotado (contexto incluido), sin repetir el plan ni la unidad terminada, sin correcciones nuevas
  const cfg0 = processesRepo(S).get(p.id)!.result!.pipeline!.config;
  assert.equal((await inject('POST', `${W}/processes/${p.id}/continue`, { authorized: true })).statusCode, 200);
  const done = await waitIdle(p.id);
  assert.equal(done.result!.pipeline!.state, 'verified', done.result!.pipeline!.reason ?? '');
  assert.deepEqual(apiCalls().map(c => c.rule), [R.plan], 'el plan no se repite');
  assert.equal(ccRuns().filter((r: any) => r.rule === 'Esta es la unidad 1 de 1').length, 1, 'la unidad terminada no se vuelve a pedir');
  assert.deepEqual(corrCalls().map((r: any) => r.rule), ['Corrige la implementación de esta historia', 'El intento anterior agotó los turnos'], 'un intento normal y uno acotado, distinto');
  assert.match(corrCalls()[1].prompt, /NO uses herramientas de lectura/);
  assert.equal(done.result!.pipeline!.config.maxCorrections, cfg0.maxCorrections, 'continuar no concede correcciones nuevas');
  useFakeSandbox();
});

test('D · turnos agotados dos veces en la misma unidad: no hay bucle; no se insiste solo y «volver a verificar sin IA» no paga otra corrección', async () => {
  const { p } = await maxTurnsStory('CC · turnos agotados dos veces', false);
  await run(p.id);
  assert.equal((await inject('POST', `${W}/processes/${p.id}/continue`, { authorized: true })).statusCode, 200);
  const twice = await waitIdle(p.id); const pl = twice.result!.pipeline!;
  assert.equal(pl.pauseKind, 'max_turns'); assert.match(pl.reason!, /por segunda vez/); assert.match(pl.reason!, /No se insiste/);
  const corr = twice.result!.manifest!.units.find(u => u.kind === 'correction')!;
  assert.equal(corr.status, 'failed'); assert.equal(corr.maxTurns, 2);
  assert.equal(corrCalls().length, 2, 'dos llamadas en total, ninguna automática más');
  const flow = (await inject('GET', `${W}/processes/${p.id}`)).json().guidance.flow;
  const again = flow.actions[0];
  assert.equal(again.label, 'Volver a verificar sin IA'); assert.deepEqual(again.pipeline, { maxCorrections: 0 });
  assert.equal((await inject('POST', `${W}/processes/${p.id}/continue`, { authorized: true, pipeline: again.pipeline })).statusCode, 200);
  const after = await waitIdle(p.id);
  assert.equal(after.result!.pipeline!.pauseKind, 'limit', after.result!.pipeline!.reason ?? '');
  assert.equal(corrCalls().length, 2, 'volver a verificar no llama a Claude Code');
  useFakeSandbox();
});

// ---------------------------------------------------------------- Docker real (23)

let dockerReady = (await real.detect(true)).available === 'docker';
for (let i = 0; i < 3 && !dockerReady; i++) { await new Promise(r => setTimeout(r, 2000)); dockerReady = (await real.detect(true)).available === 'docker'; }
const requireDocker = process.env.PORTAL_REQUIRE_DOCKER === '1';
test('23 · verificación en Docker real con el Desarrollador y QA en Claude Code (typecheck, test y build aislados)', { skip: dockerReady || requireDocker ? false : 'Docker no disponible en este equipo' }, async () => {
  assert.ok(dockerReady, 'Docker no está disponible');
  useRealSandbox(); apiScript(); ccRules();
  const { p } = await storyWith('CC · Docker real');
  const done = await run(p.id);
  const pl = done.result!.pipeline!; const r = done.result!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  for (const cmd of ['typecheck', 'test', 'build']) assert.ok(r.verifications.some(v => v.command === cmd && v.exitCode === 0 && v.isolation === 'docker'), `${cmd} en Docker`);
  assert.match(ccRuns().find((x: any) => x.rule === R.qa)!.prompt, /typecheck: OK/);
});

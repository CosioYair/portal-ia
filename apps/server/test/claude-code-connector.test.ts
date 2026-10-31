import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Conector «Claude Code — Local» (fase 1 y 2): detección de la CLI y de su autenticación, conflictos de facturación,
 * activación con autorización, puente MCP con autorización en el backend (consolas, tareas, aislamiento entre empresas
 * y proyectos, rutas protegidas) y presencia de la consola. Todo con una CLI SIMULADA: ningún modelo, ningún crédito.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-cc-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.LOG_LEVEL = 'warn';
process.env.PORTAL_CC_WORKER_TIMEOUT_MS = '1500';
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-fakecc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const scenario = (s: Record<string, unknown>) => fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s));
scenario({});

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { platform, providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { classifyAuth, cliCommandFor, exeFromShim, findCli, resetDetectionCache } = await import('../src/services/claudeCode/detect.ts');
const { credentialVarsIn, minimalEnv } = await import('../src/services/claudeCode/env.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { claudeCodeGate, setBridgeUrl } = await import('../src/services/claudeCode/backend.ts');
const bridge = await import('../src/services/claudeCode/bridge.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia';
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-cc-repo-'));
fs.mkdirSync(path.join(repo, 'src'));
fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, '.env'), 'ANTHROPIC_API_KEY=sk-ant-no-debe-salir\n');
fs.mkdirSync(path.join(repo, 'data')); fs.writeFileSync(path.join(repo, 'data/x.txt'), 'datos reales');
fs.writeFileSync(path.join(repo, 'src/config.ts'), `export const k = "sk-ant-${'x'.repeat(30)}";\n`);
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
setBridgeUrl(url);
after(async () => { await app.close(); });

const agents = agentsRepo(S).list();
const dev = agents.find(a => a.projectId === project.id && /desarroll/i.test(a.config.name)) ?? agents.find(a => a.projectId === project.id)!;
const qa = agents.find(a => a.projectId === project.id && a.id !== dev.id)!;
const inject = (method: string, u: string, payload?: unknown, headers?: Record<string, string>) => app.inject({ method: method as any, url: u, payload: payload as any, headers });

// ---------------------------------------------------------------- 1-5 · Detección y facturación

test('1 · CLI no instalada: ruta inexistente o sin ejecutable en el PATH → «no instalada», sin ejecutar nada', async () => {
  saveClaudeCodeSettings({ ...getClaudeCodeSettings(), cliPath: path.join(fakeDir, 'no-existe.exe') });
  resetDetectionCache();
  const r = (await inject('POST', '/api/claude-code/detect')).json();
  assert.equal(r.detection.installed, false); assert.equal(r.ready, false);
  assert.match(r.detection.problems[0], /no es un ejecutable de Claude Code utilizable/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-nopath-'));
  assert.equal(findCli({ PATH: empty, USERPROFILE: empty, HOME: empty, APPDATA: empty }, process.platform), null);
  assert.equal(cliCommandFor(path.join(empty, 'claude.ps1')), null, 'nunca se ejecuta un script de shell');
  fs.writeFileSync(path.join(empty, 'calc.exe'), ''); fs.writeFileSync(path.join(empty, 'claude.ps1'), '');
  assert.equal(cliCommandFor(path.join(empty, 'calc.exe')), null, 'la ruta configurable no lanza otros programas');
  assert.equal(cliCommandFor(path.join(empty, 'claude.ps1')), null);
  assert.equal((await inject('PUT', '/api/claude-code/settings', { cliPath: path.join(empty, 'calc.exe') })).statusCode, 400);
});

test('2 · CLI instalada: detección por PATH, lanzador de npm resuelto a su claude.exe (sin shell) y versión', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-path-'));
  if (process.platform === 'win32') {
    const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, '');
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@ECHO off\r\nGOTO start\r\n:start\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
    assert.equal(exeFromShim(path.join(dir, 'claude.cmd'))?.command, exe);
    assert.equal(findCli({ PATH: dir }, 'win32')?.command, exe);
  } else {
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n'); fs.chmodSync(path.join(dir, 'claude'), 0o755);
    assert.equal(findCli({ PATH: dir }, 'linux')?.command, path.join(dir, 'claude'));
  }
  assert.deepEqual(cliCommandFor(FAKE), { command: process.execPath, prefixArgs: [FAKE], path: FAKE });
  saveClaudeCodeSettings({ ...getClaudeCodeSettings(), cliPath: FAKE });
  scenario({ auth: 'subscription' });
  const r = (await inject('POST', '/api/claude-code/detect')).json();
  assert.equal(r.detection.installed, true); assert.equal(r.detection.version, '2.1.311');
  assert.ok(r.detection.capabilities.includes('permission-prompts'));
});

test('3 · suscripción verificada: «Claude Code — Suscripción»; el correo y la organización no se guardan ni se muestran', async () => {
  scenario({ auth: 'subscription' });
  const r = (await inject('POST', '/api/claude-code/detect')).json();
  assert.equal(r.detection.billing, 'subscription'); assert.equal(r.detection.authMethod, 'claude.ai'); assert.equal(r.detection.subscriptionType, 'max');
  assert.equal(r.sourceLabel, 'Claude Code — Suscripción');
  assert.ok(!JSON.stringify(r).includes('propietario@example.com') && !JSON.stringify(r).includes('org-1'), 'sin datos personales de la cuenta');
  assert.equal(r.settings.enabled, false, 'desactivado por defecto aunque la suscripción esté verificada');
  assert.equal(classifyAuth({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }).billing, 'subscription');
});

test('4 · modo desconocido o ilegible → «No verificado» y la activación se bloquea', async () => {
  for (const auth of ['unknown', 'garbage', 'none', 'third_party']) {
    scenario({ auth });
    const r = (await inject('POST', '/api/claude-code/detect')).json();
    assert.notEqual(r.detection.billing, 'subscription', auth);
    const en = await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true });
    assert.equal(en.statusCode, 409, `${auth}: no se activa sin suscripción verificada`);
  }
  assert.equal(classifyAuth(null).billing, 'unverified');
});

test('5 · conflicto de clave de API: la CLI facturaría por API → bloqueado; el entorno del Portal nunca se reenvía', async () => {
  for (const auth of ['api_key', 'api_key_helper']) {
    scenario({ auth });
    const r = (await inject('POST', '/api/claude-code/detect')).json();
    assert.equal(r.detection.billing, 'api'); assert.equal(r.sourceLabel, 'Claude Code — Facturación API');
    assert.match(r.detection.problems.join(' '), /facturación por API/);
  }
  process.env.ANTHROPIC_API_KEY = 'sk-ant-del-portal-no-debe-pasar';
  try {
    assert.deepEqual(credentialVarsIn(process.env), ['ANTHROPIC_API_KEY']);
    const env = minimalEnv(process.env);
    assert.ok(!Object.keys(env).some(k => /ANTHROPIC|CLAUDE_CODE_OAUTH/i.test(k)), 'ninguna credencial en el entorno de la CLI');
    assert.throws(() => minimalEnv(process.env, { ANTHROPIC_API_KEY: 'x' }), /No se reenvían credenciales/);
    scenario({ auth: 'subscription' });
    const r = (await inject('POST', '/api/claude-code/detect')).json();
    assert.equal(r.detection.billing, 'subscription', 'la detección usa el mismo entorno mínimo que la ejecución');
    assert.deepEqual(r.detection.portalEnvCredentials, ['ANTHROPIC_API_KEY']);
    const log = fs.readFileSync(path.join(fakeDir, 'fake-claude.log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(log.every(e => !e.envKeys.includes('ANTHROPIC_API_KEY')), 'la CLI simulada nunca recibió la clave del Portal');
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

// ---------------------------------------------------------------- Activación y autorización

test('activación: exige autorización explícita y suscripción verificada; proyectos y agentes se autorizan aparte', async () => {
  scenario({ auth: 'subscription' }); resetDetectionCache();
  assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: true })).statusCode, 403, 'sin authorized:true no se activa');
  assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true, bypass: true })).statusCode, 400, 'esquema estricto');
  const on = await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true });
  assert.equal(on.statusCode, 200, on.body); assert.equal(on.json().ready, true);
  assert.equal(on.json().settings.fallback, 'none', 'sin alternativa facturable por defecto');
  assert.equal((await inject('PUT', '/api/claude-code/settings', { fallback: 'api' })).statusCode, 403, 'la API como alternativa requiere autorización');
  // Agente sin autorización explícita
  assert.equal((await inject('PUT', `/api/workspaces/${S}/agents/${dev.id}/backend`, { backend: 'claude-code' })).statusCode, 403);
  const set = await inject('PUT', `/api/workspaces/${S}/agents/${dev.id}/backend`, { backend: 'claude-code', authorized: true });
  assert.equal(set.statusCode, 200, set.body); assert.equal(set.json().config.backend, 'claude-code');
  // Editar la configuración del agente no le quita el backend autorizado
  const cfg = { ...set.json().config }; delete cfg.backend; delete cfg.capabilities;
  const put = await inject('PUT', `/api/workspaces/${S}/agents/${dev.id}/config`, cfg);
  assert.equal(put.statusCode, 200, put.body); assert.equal(agentsRepo(S).get(dev.id)!.config.backend, 'claude-code');
  // Proyecto aún no autorizado: la puerta lo dice
  const g = claudeCodeGate(S, agentsRepo(S).get(dev.id)!, project.id);
  assert.equal(g.ok, false); assert.match((g as any).reason, /no está autorizado para Claude Code/);
  const pr = await inject('PUT', `/api/workspaces/${S}/claude-code/projects`, { authorized: true, projectIds: [project.id] });
  assert.equal(pr.statusCode, 200, pr.body);
  assert.equal(claudeCodeGate(S, agentsRepo(S).get(dev.id)!, project.id).ok, true);
});

// ---------------------------------------------------------------- 6-7 · Consolas (puente MCP)

/** Cliente MCP de prueba: lanza scripts/portal-mcp.mjs como lo haría Claude Code y habla JSON-RPC por stdio. */
function mcpClient(token: string, mode: 'worker' | 'job' = 'worker') {
  const script = path.resolve(here, '../../../scripts/portal-mcp.mjs');
  const child = spawn(process.execPath, [script], { env: { ...process.env, PORTAL_URL: url, PORTAL_BRIDGE_TOKEN: token, PORTAL_BRIDGE_MODE: mode }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; let next = 1; const waiting = new Map<number, (m: any) => void>();
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(l); waiting.get(m.id)?.(m); } });
  const rpc = (method: string, params: unknown = {}) => new Promise<any>(r => { const id = next++; waiting.set(id, r); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name: string, args: unknown = {}) => { const m = await rpc('tools/call', { name, arguments: args }); return { isError: m.result?.isError, text: m.result?.content?.[0]?.text as string, json: (() => { try { return JSON.parse(m.result?.content?.[0]?.text); } catch { return null; } })() }; };
  const close = () => new Promise<void>(r => { child.on('close', () => r()); child.stdin.end(); });
  return { rpc, tool, close, child };
}
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('tiempo de espera agotado'); };

let workerToken = ''; let workerId = '';
test('6-7 · consola desconectada hasta que su puente da señales; conectada mientras late; desconectada al cerrarse', async () => {
  assert.equal((await inject('PUT', `/api/workspaces/${S}/agents/${qa.id}/backend`, { backend: 'claude-code-terminal', authorized: true })).statusCode, 200);
  assert.equal((await inject('POST', `/api/workspaces/${S}/claude-code/workers`, { name: 'Mi consola', agentIds: [qa.id] })).statusCode, 400, 'sin autorización explícita');
  const c = await inject('POST', `/api/workspaces/${S}/claude-code/workers`, { authorized: true, name: 'Mi consola', agentIds: [qa.id] });
  assert.equal(c.statusCode, 201, c.body);
  workerToken = c.json().token; workerId = c.json().worker.id;
  assert.ok(c.json().setup.args.includes('--') && c.json().setup.args.at(-1).endsWith('portal-mcp.mjs'));
  const view = async () => (await inject('GET', `/api/workspaces/${S}/claude-code`)).json();
  assert.ok(!JSON.stringify(await view()).includes(workerToken), 'el token no se vuelve a mostrar');
  assert.equal((await view()).workers[0].connected, false, 'recién creada: desconectada');
  const mcp = mcpClient(workerToken);
  const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'prueba', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.equal(init.result.serverInfo.name, 'portal-ia');
  const tools = (await mcp.rpc('tools/list')).result.tools.map((t: any) => t.name);
  assert.ok(tools.includes('portal_submit_result') && tools.includes('portal_claim_task'));
  assert.ok(!tools.some((t: string) => /shell|exec|write_file|sql|database/i.test(t)), 'ni shell, ni escritura de archivos, ni base de datos');
  await waitFor(async () => (await view()).workers[0].connected === true);
  const who = await mcp.tool('portal_whoami');
  assert.equal(who.json.kind, 'worker'); assert.deepEqual(who.json.agents.map((a: any) => a.id), [qa.id]);
  await mcp.close();
  await waitFor(async () => (await view()).workers[0].connected === false);
  // Sin latidos tampoco aparece activa (caducidad de la presencia)
  bridge.touchWorker(workerId); assert.equal(bridge.workerConnected(workerId), true);
  await new Promise(r => setTimeout(r, 1700)); assert.equal(bridge.workerConnected(workerId), false);
});

// ---------------------------------------------------------------- 9-12 · Autorización en el backend

test('9 · sin token, token falso o revocado → 401; operaciones de consola con token de ejecución → 403', async () => {
  assert.equal((await inject('GET', '/api/bridge/v1/tasks')).statusCode, 401);
  assert.equal((await inject('GET', '/api/bridge/v1/tasks', undefined, { authorization: 'Bearer pcc_falsofalsofalsofalsofalsofalso' })).statusCode, 401);
  const job = bridge.registerJobTask({ slug: S, projectId: project.id, processId: null, stepId: null, agentId: dev.id, agentName: dev.config.name, role: 'implementer', title: 'x', mode: 'cli', system: '', prompt: '', schema: null, readRoot: repo, runId: 'r1' });
  const auth = { authorization: `Bearer ${job.token}` };
  assert.equal((await inject('GET', '/api/bridge/v1/tasks/current', undefined, auth)).statusCode, 200);
  assert.equal((await inject('POST', `/api/bridge/v1/tasks/${job.task.id}/result`, { text: 'hecho' }, auth)).statusCode, 403, 'una ejecución gestionada no entrega por el puente');
  assert.equal((await inject('POST', `/api/bridge/v1/tasks/${job.task.id}/claim`, {}, auth)).statusCode, 403);
  // El token de ejecución solo ve SU tarea
  const other = bridge.registerJobTask({ slug: S, projectId: project.id, processId: null, stepId: null, agentId: dev.id, agentName: dev.config.name, role: 'implementer', title: 'y', mode: 'cli', system: '', prompt: '', schema: null, readRoot: repo, runId: 'r2' });
  assert.equal((await inject('GET', `/api/bridge/v1/tasks/${other.task.id}`, undefined, auth)).statusCode, 404);
  job.done(); other.done();
  assert.equal((await inject('GET', '/api/bridge/v1/tasks/current', undefined, auth)).statusCode, 401, 'caduca al terminar la ejecución');
  // Revocar la consola
  const c = (await inject('POST', `/api/workspaces/${S}/claude-code/workers`, { authorized: true, name: 'Temporal', agentIds: [qa.id] })).json();
  assert.equal((await inject('GET', '/api/bridge/v1/tasks', undefined, { authorization: `Bearer ${c.token}` })).statusCode, 200);
  assert.equal((await inject('DELETE', `/api/workspaces/${S}/claude-code/workers/${c.worker.id}`)).statusCode, 200);
  assert.equal((await inject('GET', '/api/bridge/v1/tasks', undefined, { authorization: `Bearer ${c.token}` })).statusCode, 401);
});

test('10-11 · otra empresa u otro proyecto: sus consolas no ven ni toman tareas ajenas (404) y no se autorizan proyectos ajenos', async () => {
  const ctrl = new AbortController();
  bridge.touchWorker(workerId);
  const { task, result } = bridge.submitTerminalTask({ slug: S, projectId: project.id, processId: null, stepId: null, agentId: qa.id, agentName: qa.config.name, role: 'reviewer', title: 'Revisión', mode: 'terminal', system: 'sys', prompt: 'p', schema: null, readRoot: repo, runId: 'r3' }, 60_000, ctrl.signal);
  result.catch(() => undefined);
  // Empresa distinta con su propia consola
  const ws2 = createCompany('Empresa Aparte CC');
  const a2 = agentsRepo(ws2.slug).list()[0];
  saveClaudeCodeSettings({ ...getClaudeCodeSettings() });
  const c2 = await inject('POST', `/api/workspaces/${ws2.slug}/claude-code/workers`, { authorized: true, name: 'Otra', agentIds: [a2.id] });
  assert.equal(c2.statusCode, 201, c2.body);
  const h2 = { authorization: `Bearer ${c2.json().token}` };
  assert.deepEqual((await inject('GET', '/api/bridge/v1/tasks', undefined, h2)).json().tasks, []);
  assert.equal((await inject('POST', `/api/bridge/v1/tasks/${task.id}/claim`, {}, h2)).statusCode, 404);
  assert.equal((await inject('GET', `/api/bridge/v1/tasks/${task.id}/file?path=src/a.ts`, undefined, h2)).statusCode, 404);
  // Un agente de otra empresa no se puede asignar a una consola de este espacio
  assert.equal((await inject('POST', `/api/workspaces/${S}/claude-code/workers`, { authorized: true, name: 'Mezcla', agentIds: [a2.id] })).statusCode, 404);
  // Proyecto de otra empresa no se puede autorizar aquí
  const p2 = createProject(ws2.slug, 'Proyecto ajeno', 'x', []);
  assert.equal((await inject('PUT', `/api/workspaces/${S}/claude-code/projects`, { authorized: true, projectIds: [p2.id] })).statusCode, 404);
  // Otro proyecto del mismo espacio, no autorizado: la tarea no existe para la consola
  const pB = createProject(S, 'Proyecto B (no autorizado)', 'x', []);
  const h1 = { authorization: `Bearer ${workerToken}` };
  bridge.touchWorker(workerId);
  const { task: tB, result: rB } = bridge.submitTerminalTask({ slug: S, projectId: pB.id, processId: null, stepId: null, agentId: qa.id, agentName: qa.config.name, role: 'reviewer', title: 'B', mode: 'terminal', system: 's', prompt: 'p', schema: null, readRoot: repo, runId: 'r4' }, 60_000, ctrl.signal);
  rB.catch(() => undefined);
  const listed = (await inject('GET', '/api/bridge/v1/tasks', undefined, h1)).json().tasks.map((t: any) => t.id);
  assert.ok(listed.includes(task.id) && !listed.includes(tB.id), 'solo la del proyecto autorizado');
  assert.equal((await inject('POST', `/api/bridge/v1/tasks/${tB.id}/claim`, {}, h1)).statusCode, 404);
  assert.equal(claudeCodeGate(S, agentsRepo(S).get(dev.id)!, pB.id).ok, false);
  ctrl.abort();
  await assert.rejects(result, /cancelada/);
});

test('12 · rutas protegidas: .env, data/, .git, node_modules, fuera de la carpeta, secretos y binarios → denegados', async () => {
  const task = { id: 't', slug: S, readRoot: repo } as any;
  const ok = bridge.readTaskFile(task, 'src/a.ts');
  assert.ok(!bridge.isDenied(ok)); assert.equal((ok as any).content, 'export const a = 1;\n');
  for (const p of ['.env', 'data/x.txt', '../fuera.txt', '/etc/passwd', 'C:/Windows/win.ini', '.git/config', 'node_modules/x/index.js', 'src/../../x', '.claude/settings.json', 'src\\..\\..\\x']) {
    const r = bridge.readTaskFile(task, p);
    assert.ok(bridge.isDenied(r), `${p} debía denegarse`);
  }
  const sec = bridge.readTaskFile(task, 'src/config.ts');
  assert.ok(bridge.isDenied(sec) && /secreto|clave de API/i.test((sec as any).error), 'un archivo con un secreto no sale por el puente');
  fs.writeFileSync(path.join(repo, 'src/bin.dat'), Buffer.from([1, 0, 2, 3]));
  assert.ok(bridge.isDenied(bridge.readTaskFile(task, 'src/bin.dat')));
  try {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-outside-')); fs.writeFileSync(path.join(outside, 'secreto.txt'), 'fuera');
    fs.symlinkSync(outside, path.join(repo, 'src', 'enlace'), 'junction');
    assert.ok(bridge.isDenied(bridge.readTaskFile(task, 'src/enlace/secreto.txt')), 'un enlace no saca la lectura de la carpeta');
  } catch (e: any) { if (e.code !== 'EPERM') throw e; }
  const files = bridge.listTaskFiles(task) as any;
  assert.ok(files.files.includes('src/a.ts')); assert.ok(!files.files.some((f: string) => /^\.env$|^data\//.test(f)));
});

// ---------------------------------------------------------------- Revisión de seguridad (antes de activar con la suscripción real)

const fakeLog = () => fs.existsSync(path.join(fakeDir, 'fake-claude.log.jsonl')) ? fs.readFileSync(path.join(fakeDir, 'fake-claude.log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
const clearFakeLog = () => { try { fs.unlinkSync(path.join(fakeDir, 'fake-claude.log.jsonl')); } catch { /* vacío */ } };

test('detección: «auth status» con --restricted y sonda SIN modelo de la configuración exacta; si la sonda falla, no hay suscripción verificada', async () => {
  scenario({ auth: 'subscription' }); clearFakeLog();
  const ok = (await inject('POST', '/api/claude-code/detect')).json();
  assert.equal(ok.detection.billing, 'subscription'); assert.equal(ok.detection.probe.ok, true);
  assert.equal(ok.detection.probe.apiKeySource, 'none'); assert.equal(ok.detection.probe.modelCalled, false); assert.equal(ok.detection.probe.model, 'claude-haiku-5-5');
  assert.ok(ok.detection.probe.tools.includes('StructuredOutput') && ok.detection.probe.tools.includes('mcp__portal__portal_read_file'));
  const log = fakeLog();
  assert.equal(log.find((e: any) => e.kind === 'auth').args[0], '--restricted', 'el estado de la sesión se lee con el mismo modo que la ejecución');
  assert.ok(log.some((e: any) => e.kind === 'blank') && !log.some((e: any) => e.kind === 'run'), 'la sonda nunca envía un encargo');
  // Una herramienta inesperada en la configuración real → «No verificado» y el conector no está listo
  scenario({ auth: 'subscription', extraTools: ['Bash'] });
  const bad = (await inject('POST', '/api/claude-code/detect')).json();
  assert.equal(bad.detection.billing, 'unverified'); assert.equal(bad.ready, false);
  assert.match(bad.detection.problems.join(' '), /sin llamar al modelo.*Bash/);
  // Una CLI sin modo restringido no se usa (sus ajustes, hooks y plugins personales entrarían en la ejecución)
  scenario({ auth: 'subscription', version: '2.1.200' });
  const old = (await inject('POST', '/api/claude-code/detect')).json();
  assert.equal(old.detection.billing, 'unverified'); assert.match(old.detection.problems[0], /modo restringido/);
  scenario({ auth: 'subscription' });
  assert.equal((await inject('POST', '/api/claude-code/detect')).json().ready, true);
});

test('consolas: el token caduca (por defecto 30 días) y el puente se registra con alcance LOCAL en una carpeta dedicada', async () => {
  const c = await inject('POST', `/api/workspaces/${S}/claude-code/workers`, { authorized: true, name: 'Caduca', agentIds: [qa.id], days: 1 });
  assert.equal(c.statusCode, 201, c.body);
  const { token, worker, setup } = c.json();
  assert.deepEqual(setup.args.slice(0, 5), ['mcp', 'add', '--scope', 'local', 'portal-ia'], 'no queda disponible en todos tus proyectos');
  assert.match(setup.cwd, /PortalIA-consola[\\/]portal-ia$/);
  assert.ok(Date.parse(worker.expiresAt) - Date.now() < 86_400_000 + 5000 && !worker.expired);
  const h = { authorization: `Bearer ${token}` };
  assert.equal((await inject('GET', '/api/bridge/v1/tasks', undefined, h)).statusCode, 200);
  platform.prepare('UPDATE claude_code_workers SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), worker.id);
  assert.equal((await inject('GET', '/api/bridge/v1/tasks', undefined, h)).statusCode, 401, 'caducado');
  const v = (await inject('GET', `/api/workspaces/${S}/claude-code`)).json().workers.find((w: any) => w.id === worker.id);
  assert.equal(v.expired, true); assert.equal(v.connected, false);
  assert.equal((await inject('POST', `/api/workspaces/${S}/claude-code/workers`, { authorized: true, name: 'Eterna', agentIds: [qa.id], days: 3650 })).statusCode, 400, 'máximo 90 días');
});

test('E · una consola que se desconecta ANTES de tomar la tarea no deja el proceso esperando el plazo entero (15 min)', async () => {
  // Proyecto autorizado y consola conectada al encolar; después deja de latir (cerró Claude Code).
  assert.equal(agentsRepo(S).get(qa.id)!.config.backend, 'claude-code-terminal');
  const fresh = (await inject('POST', `/api/workspaces/${S}/claude-code/workers`, { authorized: true, name: 'Se va', agentIds: [qa.id] })).json();
  bridge.touchWorker(fresh.worker.id);
  const started = Date.now();
  const { result } = bridge.submitTerminalTask({ slug: S, projectId: project.id, processId: null, stepId: null, agentId: qa.id, agentName: qa.config.name, role: 'reviewer', title: 'R', mode: 'terminal', system: 's', prompt: 'p', schema: null, readRoot: repo, runId: 'r-e' }, 15 * 60_000, new AbortController().signal);
  await assert.rejects(result, (e: any) => e.error.code === 'backend_unavailable' && /se desconectó antes de tomarla/.test(e.message));
  assert.ok(Date.now() - started < 15_000, `falló en ${Date.now() - started} ms, no al agotar el plazo`);
});

test('peticiones malformadas u hostiles al puente: ni otra tarea, ni rutas codificadas, ni campos de más, ni token en la URL', async () => {
  const job = bridge.registerJobTask({ slug: S, projectId: project.id, processId: null, stepId: null, agentId: qa.id, agentName: qa.config.name, role: 'reviewer', title: 'x', mode: 'cli', system: '', prompt: '', schema: null, readRoot: repo, runId: 'r-mal' });
  const h = { authorization: `Bearer ${job.token}` };
  try {
    assert.equal((await inject('GET', '/api/bridge/v1/tasks/..%2F..%2Fotra/file?path=src/a.ts', undefined, h)).statusCode, 404);
    for (const p of ['..%2F..%2F.env', '%2e%2e/%2e%2e/x', 'src%2F..%2F..%2Fx', '%5C%5Cservidor%5Ccompartido%5Cx', 'src%2Fa.ts%00.txt', 'C%3A%5CWindows%5Cwin.ini']) {
      const r = await inject('GET', `/api/bridge/v1/tasks/current/file?path=${p}`, undefined, h);
      assert.ok(r.statusCode >= 400 && r.statusCode < 500 && !/export const a/.test(r.body), `${p} → ${r.statusCode}`);
    }
    assert.equal((await inject('GET', '/api/bridge/v1/tasks/current/file?path=src/a.ts', undefined, h)).statusCode, 200, 'lo autorizado sí');
    assert.equal((await inject('POST', '/api/bridge/v1/tasks/current/progress', { message: 'ok', taskId: 'otra', slug: 'empresa-aparte-cc' }, h)).statusCode, 400, 'el alcance no se amplía con campos del cuerpo');
    assert.equal((await inject('GET', `/api/bridge/v1/tasks?token=${job.token}`)).statusCode, 401, 'el token solo vale en la cabecera');
    assert.equal((await inject('GET', '/api/bridge/v1/tasks', undefined, { authorization: `Basic ${job.token}` })).statusCode, 401);
    // El servidor MCP ante JSON-RPC mal formado: responde con error y sigue funcionando
    const mcp = mcpClient(job.token, 'job');
    const raw = await new Promise<any>(r => { mcp.child.stdout.once('data', d => r(JSON.parse(String(d).trim().split('\n')[0]))); mcp.child.stdin.write('esto no es JSON\n'); });
    assert.equal(raw.error.code, -32700);
    assert.equal((await mcp.rpc('tools/call', { name: 'portal_borrar_todo', arguments: {} })).error.code, -32602, 'herramienta inexistente');
    const tools = (await mcp.rpc('tools/list')).result.tools.map((t: any) => t.name);
    assert.ok(!tools.includes('portal_submit_result') && !tools.includes('portal_claim_task'), 'una ejecución gestionada no tiene herramientas de consola');
    const read = await mcp.tool('portal_read_file', { path: { toString: 'x' } });
    assert.equal(read.isError, true, 'argumentos de tipo incorrecto no leen nada');
    assert.match((await mcp.tool('portal_read_file', { path: 'src/a.ts' })).text, /export const a = 1/);
    assert.deepEqual((await mcp.rpc('ping')).result, {});
    await mcp.close();
  } finally { job.done(); }
});

test('portal_search y portal_diff: solo lectura, literal, con las mismas protecciones que leer; ambos rangos de cambios', async () => {
  // Búsqueda en una carpeta SIN git: recorrido acotado, nada protegido, archivos con secretos omitidos (y dichos).
  const plain = { id: 't', slug: S, projectId: project.id, readRoot: repo } as any;
  const found = bridge.searchTaskFiles(plain, 'export const') as any;
  assert.ok(!bridge.isDenied(found));
  assert.ok(found.matches.some((m: any) => m.path === 'src/a.ts' && m.line === 1 && m.text === 'export const a = 1;'));
  assert.ok(!found.matches.some((m: any) => /^\.env$|^data\/|config\.ts|sk-ant/.test(m.path + m.text)), 'nada protegido ni secreto en los resultados');
  assert.ok(found.skipped.some((x: any) => x.path === 'src/config.ts'), 'el archivo con un secreto se omite y se dice');
  assert.equal((bridge.searchTaskFiles(plain, 'sk-ant') as any).matches.length, 0, 'buscar el secreto no lo revela');
  assert.ok(bridge.isDenied(bridge.searchTaskFiles(plain, 'x')), 'demasiado corta');
  assert.equal((bridge.searchTaskFiles(plain, '(a+)+$') as any).matches.length, 0, 'el texto es literal: nunca una expresión');
  assert.ok(bridge.isDenied(bridge.searchTaskFiles(plain, 'export', { dir: '.git' })));
  assert.ok(bridge.isDenied(bridge.taskDiff(plain)), 'sin git no hay diferencias');

  // Repositorio con rama: base en main, la rama cambia a.ts y deja cambios sin confirmar (uno nuevo, uno protegido, uno con secreto).
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-cc-diff-'));
  const run = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: g, windowsHide: true }).toString();
  fs.mkdirSync(path.join(g, 'src'));
  fs.writeFileSync(path.join(g, 'src/a.ts'), 'export const a = 1;\n'); fs.writeFileSync(path.join(g, 'src/b.ts'), 'export const b = 1;\n');
  run('init', '-q', '-b', 'main'); run('add', '-A'); run('commit', '-qm', 'Base');
  run('checkout', '-qb', 'portal-ia/hu-1');
  fs.writeFileSync(path.join(g, 'src/a.ts'), 'export const a = 2;\n'); run('commit', '-qam', 'Cambia a');
  fs.writeFileSync(path.join(g, 'src/b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(g, 'src/nuevo.ts'), 'export const n = 1;\n');
  fs.writeFileSync(path.join(g, '.env'), 'ANTHROPIC_API_KEY=sk-ant-no-debe-salir\n');
  fs.writeFileSync(path.join(g, 'src/fuga.ts'), `export const k = "sk-ant-${'y'.repeat(30)}";\n`);
  const t = { id: 't2', slug: S, projectId: project.id, readRoot: g } as any;
  const w = bridge.taskDiff(t, 'working') as any;
  assert.ok(!bridge.isDenied(w), JSON.stringify(w));
  assert.deepEqual(w.files.map((f: any) => f.path).sort(), ['src/b.ts', 'src/fuga.ts', 'src/nuevo.ts']);
  assert.match(w.diff, /\+export const b = 2;/); assert.match(w.diff, /\+export const n = 1;/);
  assert.ok(!/sk-ant/.test(w.diff), 'ningún secreto en la diferencia');
  assert.ok(w.omitted.some((o: any) => o.path === '.env') && w.omitted.some((o: any) => o.path === 'src/fuga.ts'), 'lo omitido se dice');
  const b = bridge.taskDiff(t, 'branch') as any;
  assert.deepEqual(b.files, [{ path: 'src/a.ts', status: 'M' }]);
  assert.match(b.diff, /-export const a = 1;/); assert.match(b.diff, /\+export const a = 2;/);
  assert.equal(b.base, run('rev-parse', 'main').trim(), 'desde el punto de partida de la rama');
  assert.equal(run('status', '--porcelain').split('\n').filter(Boolean).length, 4, 'leer no cambia nada en el repositorio');
  // Un nombre con caracteres de patrón no alcanza otro archivo: «[.]npmrc» nunca trae el «.npmrc» protegido.
  fs.writeFileSync(path.join(g, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_secreto_de_prueba_123\n'); fs.writeFileSync(path.join(g, '[.]npmrc'), 'inofensivo\n');
  run('--literal-pathspecs', 'add', '--', '.npmrc', '[.]npmrc'); run('commit', '-qm', 'npmrc');
  fs.writeFileSync(path.join(g, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_otro_secreto_456\n'); fs.writeFileSync(path.join(g, '[.]npmrc'), 'cambiado\n');
  const lit = bridge.taskDiff(t, 'working') as any;
  assert.ok(!/authToken|secreto/.test(lit.diff), 'ni el token ni el archivo protegido');
  assert.match(lit.diff, /\+cambiado/); assert.ok(lit.omitted.some((o: any) => o.path === '.npmrc'));
  // Windows no distingue mayúsculas: «.GIT/config» o «DATA/x.txt» son las mismas rutas protegidas.
  for (const p of ['.GIT/config', 'DATA/x.txt', 'Node_Modules/x/index.js']) assert.ok(bridge.isDenied(bridge.readTaskFile(plain, p)), `${p} debía denegarse`);
  // Nombres cortos de Windows (8.3): «ENV~1» es otro nombre de .env; nunca valen para leer ni para escribir.
  for (const p of ['ENV~1', 'GIT~1/config', 'NODE_M~1/x/index.js', 'src/CONFIG~1.TS']) assert.ok(bridge.isDenied(bridge.readTaskFile(plain, p)), `${p} debía denegarse`);
  const { safeRelPath, scanSecrets } = await import('../src/services/repoWrite.ts');
  assert.throws(() => safeRelPath('GIT~1/hooks/pre-commit'), /nombre corto/);
  // Un marcador de variable no es un secreto; un token literal sí.
  assert.equal(scanSecrets('//registry.npmjs.org/:_authToken=${NPM_TOKEN}'), null);
  assert.match(scanSecrets('//registry.npmjs.org/:_authToken=npm_abcdef123456') ?? '', /token de registro npm/);

  // De punta a punta por MCP con un token de ejecución.
  const job = bridge.registerJobTask({ slug: S, projectId: project.id, processId: null, stepId: null, agentId: qa.id, agentName: qa.config.name, role: 'reviewer', title: 'diff', mode: 'cli', system: '', prompt: '', schema: null, readRoot: g, runId: 'r-diff' });
  try {
    const mcp = mcpClient(job.token, 'job');
    const tools = (await mcp.rpc('tools/list')).result.tools;
    for (const n of ['portal_search', 'portal_diff']) assert.equal(tools.find((x: any) => x.name === n)?.annotations?.readOnlyHint, true, `${n} es de solo lectura`);
    const sr = await mcp.tool('portal_search', { query: 'export const n' });
    assert.equal(sr.isError, false); assert.equal(sr.json.matches[0].path, 'src/nuevo.ts');
    const dr = await mcp.tool('portal_diff', { range: 'branch' });
    assert.equal(dr.isError, false); assert.ok(dr.json.files.some((f: any) => f.path === 'src/a.ts' && f.status === 'M')); assert.ok(!dr.json.files.some((f: any) => f.path === '.npmrc'), 'lo protegido no se lista');
    assert.equal((await mcp.tool('portal_search', { query: { toString: 'x' } })).isError, true, 'argumentos de tipo incorrecto no buscan nada');
    await mcp.close();
    assert.equal((await inject('GET', '/api/bridge/v1/tasks/current/diff?range=todo', undefined, { authorization: `Bearer ${job.token}` })).statusCode, 400);
  } finally { job.done(); }
});

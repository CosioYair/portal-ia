import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Capacidad del Asistente (encargo «empresa autónoma», parte IV): con un proyecto fijado lee su repositorio con el puente
 * de SOLO lectura (rutas protegidas incluidas) para investigar antes de proponer; su conversación tiene un carril propio
 * de Claude Code y no espera detrás del trabajo de un lote; mejorar algo se propone como encargo directo. CLI de Claude
 * Code SIMULADA (suscripción), nada sale del equipo y no se llama a ningún modelo real.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-asicap-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-asicap-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = () => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, INTERNAL_WORKSPACE } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { resetDetectionCache } = await import('../src/services/claudeCode/detect.ts');
const { agentCaller, setBridgeUrl } = await import('../src/services/claudeCode/backend.ts');
const { PORTAL_CAPABILITIES } = await import('../src/services/assistant.ts').then(m => ({ PORTAL_CAPABILITIES: (m as any).PORTAL_CAPABILITIES }));

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = INTERNAL_WORKSPACE.slug;
const project = projectsRepo(S).list()[0];
const app = await buildApp();
after(async () => { await app.close(); });
// El puente MCP (lo lanza la CLI simulada) habla con la API real del Portal: escucha en un puerto local efímero.
await app.listen({ port: 0, host: '127.0.0.1' });
setBridgeUrl(`http://127.0.0.1:${(app.server.address() as any).port}`);
const inject = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any });

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-asicap-repo-'));
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/flujo.ts'), 'export function siguientePaso() { return "revisar"; }\n');
fs.writeFileSync(path.join(repo, '.env'), 'ANTHROPIC_API_KEY=sk-ant-secreto\n');
fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
projectsRepo(S).setRepository(project.id, repo, 'main');

const asst = agentsRepo(S).list().find(a => a.key === 'ws-asistente')!;
saveClaudeCodeSettings({ ...getClaudeCodeSettings(), cliPath: FAKE, maxConcurrent: 1 }); resetDetectionCache();
scenario({ auth: 'subscription', defaultText: 'Respuesta.' });
assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true })).statusCode, 200);
assert.equal((await inject('PUT', `/api/workspaces/${S}/agents/${asst.id}/backend`, { backend: 'claude-code', authorized: true })).statusCode, 200);

test('el Asistente con un proyecto autorizado lee su código con el puente de solo lectura (nunca .env); sin proyecto, no lee nada', async () => {
  saveClaudeCodeSettings({ ...getClaudeCodeSettings(), projects: { ...getClaudeCodeSettings().projects, [S]: [project.id] } });
  scenario({ auth: 'subscription', defaultText: 'He leído src/flujo.ts: siguientePaso() devuelve «revisar».', mcpRead: [{ path: 'src/flujo.ts' }, { path: '.env' }] });
  const conv = (await inject('POST', '/api/assistant/conversations', { title: 'Mejorar el flujo', workspaceSlug: S, projectId: project.id })).json();
  const r = await inject('POST', '/api/assistant/messages', { text: 'Mejora el flujo del siguiente paso', conversationId: conv.id });
  assert.equal(r.statusCode, 200, r.body);
  const run = ccRuns().at(-1);
  assert.ok(run.mcp, 'la ejecución tuvo el puente del Portal');
  const read = run.mcp.results.map((x: any) => JSON.stringify(x));
  assert.match(read[0], /siguientePaso/, 'leyó el código real del proyecto');
  assert.doesNotMatch(read[1], /sk-ant-secreto/, '.env nunca se lee'); assert.match(read[1], /protegida|Ruta protegida|403/i);
  assert.ok(run.mcp.tools.every((t: string) => /^portal_/.test(t)) && !run.mcp.tools.some((t: string) => /write|edit|exec|shell/i.test(t)), `solo herramientas de lectura: ${run.mcp.tools.join(', ')}`);
  // Sin proyecto en la conversación: sin puente (no hay repositorio que leer).
  scenario({ auth: 'subscription', defaultText: 'Respuesta general.', mcpRead: [{ path: 'src/flujo.ts' }] });
  const conv2 = (await inject('POST', '/api/assistant/conversations', { title: 'Pregunta general' })).json();
  assert.equal((await inject('POST', '/api/assistant/messages', { text: '¿Qué es un lote?', conversationId: conv2.id })).statusCode, 200);
  assert.equal(ccRuns().at(-1).mcp, undefined);
});

test('carril propio: el Asistente contesta mientras una ejecución larga de trabajo ocupa el único hueco de Claude Code', async () => {
  scenario({ auth: 'subscription', defaultText: 'Contesto ya.', rules: [{ match: 'UNIDAD-LARGA', delayMs: 4000, text: 'unidad hecha' }] });
  const worker = agentsRepo(S).list().find(a => a.key !== 'ws-asistente' && a.config.provider === 'anthropic')!;
  assert.equal((await inject('PUT', `/api/workspaces/${S}/agents/${worker.id}/backend`, { backend: 'claude-code', authorized: true })).statusCode, 200);
  const work = agentCaller(S, agentsRepo(S).get(worker.id)!, null, 'Trabajo de un lote')!;
  const req = (user: string) => ({ model: 'claude-sonnet-4-5', system: 'sistema', user, maxTokens: 100, effort: null, supportsEffort: false } as any);
  const t0 = Date.now();
  const long = work.complete(req('UNIDAD-LARGA: entrega'));
  await new Promise(r => setTimeout(r, 400)); // la unidad ya ocupa el hueco del trabajo
  const conv = (await inject('POST', '/api/assistant/conversations', { title: 'Mientras tanto' })).json();
  const r = await inject('POST', '/api/assistant/messages', { text: '¿Cómo va todo?', conversationId: conv.id });
  const answeredIn = Date.now() - t0;
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().assistant.content, 'Contesto ya.');
  assert.ok(answeredIn < 3500, `el Asistente no esperó a la unidad larga (contestó en ${answeredIn} ms)`);
  assert.equal((await long).text, 'unidad hecha', 'la unidad de trabajo terminó igual');
  // Dos trabajos sí siguen limitados por el máximo del conector (1): el carril del Asistente no amplía el del trabajo.
  const a = work.complete(req('UNIDAD-LARGA: a'));
  const t1 = Date.now();
  const b = work.complete(req('UNIDAD-LARGA: b'));
  await Promise.all([a, b]);
  assert.ok(Date.now() - t1 >= 7000, 'el segundo trabajo esperó su turno');
});

test('mejorar algo se propone como encargo directo (no como historia ni análisis) y con el código real a la vista', async () => {
  const sys = fs.readFileSync(path.join(here, '..', 'src', 'services', 'assistant.ts'), 'utf8');
  assert.match(sys, /Mejorar algo que ya existe .* también es un ENCARGO directo/);
  assert.match(sys, /úsalas antes de proponer un encargo de código/);
  void PORTAL_CAPABILITIES;
});

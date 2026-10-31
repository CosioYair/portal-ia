import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Sonda Gauntlet (revisor independiente): CLI SIMULADA y proveedor simulado; datos sintéticos en carpetas temporales.
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-probe-s-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-probe-fake-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = () => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];
scenario({});

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline } = await import('@portal-ia/domain');
const { mockAdapter } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { claudeCodeRunsRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { newPipeline, filesContext } = await import('../src/services/storyPipeline.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { resetDetectionCache } = await import('../src/services/claudeCode/detect.ts');
const { setBridgeUrl } = await import('../src/services/claudeCode/backend.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { isDenied, readTaskFile } = await import('../src/services/claudeCode/bridge.ts');
const { createDelegation, runDelegation, teamOf, pickLeadAgent } = await import('../src/services/delegation.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-probe-repo-'));
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, 'src/arquitectura.ts'), 'export const MODULOS = "MARCA-PLAN-ARQ";\n');
// Archivo con una credencial literal: el puente lo rechaza («No se entrega por el puente»).
fs.writeFileSync(path.join(repo, 'src/conf.ts'), "export const api_key = 'SECRETO-1234567890';\n");
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', private: true, scripts: { typecheck: 'node -e "0"' } }, null, 2));
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
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { const t = new Date().toISOString(); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' }; };

const PLAN = JSON.stringify({ summary: 'a vale 2', tasks: ['Editar src/a.ts'], filesToRead: ['src/arquitectura.ts', 'src/conf.ts'], filesToChange: ['src/a.ts'], deliverables: [{ path: 'src/a.ts', purpose: 'a vale 2', kind: 'code', estimatedLines: 3 }], acceptance: ['a = 2'], risks: [] });
const PATCH = '=== RESUMEN ===\nCambia a.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nEl contador muestra 2.\n=== PRUEBA MANUAL ===\n1. Abre el contador. Esperado: muestra 2.';
const QA_OK = { verdict: 'approved', summary: 'Cumple el criterio.', findings: [], suggestedTests: [] };
const CONSULT = 'aporta recomendaciones concretas y accionables';
const SEARCHING = [{ name: 'portal_search', input: { query: 'arquitectura' } }];
fs.writeFileSync(scriptPath, JSON.stringify({ rules: [
  { match: 'plan técnico', text: PLAN },
  { match: 'Esta es la unidad 1 de 1', text: PATCH },
  { match: 'Evalúa la implementación con la EVIDENCIA real', text: JSON.stringify(QA_OK) },
  { match: 'Valida el encargo', text: '__TRIAGE__' },
  { match: 'Entrega el resultado del encargo', text: 'Entregable del encargo.' }
], markers: [] }));

const seen: string[] = [];
const original = mockAdapter.complete.bind(mockAdapter);
(mockAdapter as any).complete = async (k: string, o: any, req: any, s?: AbortSignal) => { seen.push(String(req.user ?? '')); return original(k, o, req, s); };

test('P1 · paquete de evidencia vs puente: un archivo con credencial que el puente NO entrega', () => {
  const bridge: any = readTaskFile({ readRoot: repo } as any, 'src/conf.ts');
  const ctx = filesContext(repo, ['src/conf.ts'], 40_000);
  console.log('bridge:', isDenied(bridge) ? `DENEGADO ${bridge.status}: ${bridge.error}` : 'entregado');
  console.log('filesContext contains secret:', ctx.includes('SECRETO-1234567890'));
  assert.ok(isDenied(bridge));
  assert.ok(!ctx.includes('SECRETO-1234567890'), 'el paquete de evidencia entrega lo que el puente rechaza por contener una credencial');
});

test('P2 · consulta de un análisis delegado: el paquete de evidencia (por la API) incluye un archivo con credencial nombrado en la petición', async () => {
  const lead = pickLeadAgent(S, project.id, 'pj-coordinador');
  const team = teamOf(S, lead).slice(0, 3);
  const member = team.find(a => a.key === 'pj-arquitecto') ?? team[0];
  for (const a of [lead, ...team]) { const r = await inject('PUT', `${W}/agents/${a.id}/backend`, { backend: 'api', authorized: true }); assert.equal(r.statusCode, 200, r.body); }
  const Q = '¿Qué contiene la configuración?';
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  script.rules = script.rules.map((r: any) => r.text === '__TRIAGE__' ? { ...r, text: JSON.stringify({ accepted: true, rejectionReason: null, understanding: 'x', plan: ['Consultar'], consults: [{ agentKey: member.key, question: Q }] }) } : r);
  fs.writeFileSync(scriptPath, JSON.stringify(script));
  const d = createDelegation(S, project.id, 'pj-coordinador', 'Analiza src/conf.ts y el módulo contador');
  processesRepo(S).authorize(d.id, 2);
  await runDelegation(S, d.id, () => undefined, () => false);
  const consultPrompt = seen.find(u => u.includes(Q)) ?? '';
  console.log('consult prompt found:', !!consultPrompt, consultPrompt.length, (consultPrompt.match(/# Contenido actual[\s\S]{0,300}/)||['(sin evidencia)'])[0]); console.log('delegation status:', processesRepo(S).get(d.id)!.status, '· consult prompt has secret:', consultPrompt.includes('SECRETO-1234567890'));
  assert.ok(!consultPrompt.includes('SECRETO-1234567890'), 'la consulta del análisis recibe el contenido de un archivo con credencial');
});

test('P3 · tope de llamadas = 1: la consulta agota los turnos y la recuperación choca con el tope', async () => {
  scenario({ auth: 'subscription', rules: [{ match: CONSULT, maxTurns: true, onlyWithTools: true, tools: SEARCHING, text: 'RECUPERADA' }] });
  const it = addManualItem(S, project.id, { title: 'Contador: revisar la arquitectura del módulo y su estructura', criterion: 'a vale 2 (número)', description: 'Revisa la arquitectura del módulo, su estructura y dependencias.' });
  const p = createStoryProcess(S, project.id, it.id);
  const cStep = p.steps.find(s => s.role === 'consultant'); assert.ok(cStep);
  for (const s of p.steps) { const r = await inject('PUT', `${W}/agents/${s.agentId}/backend`, { backend: s.id === cStep!.id ? 'claude-code' : 'api', authorized: true }); assert.equal(r.statusCode, 200, r.body); }
  processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, allowInstall: true, commands: ['typecheck'], maxSubscriptionCalls: 1 })) });
  processesRepo(S).authorize(p.id, 2);
  await runStory(S, p.id, () => undefined, () => false);
  const done = processesRepo(S).get(p.id)!;
  const step = done.steps.find(s => s.id === cStep!.id)!;
  const runs = ccRuns().filter((r: any) => r.rule === CONSULT);
  const flow = (await inject('GET', `${W}/processes/${p.id}`)).json().guidance?.flow;
  console.log(JSON.stringify({ status: done.status, error: done.error, pipeline: done.result?.pipeline ? { state: done.result.pipeline.state, pauseKind: done.result.pipeline.pauseKind } : null, failure: done.result?.failure, cliRuns: runs.length, registeredRuns: claudeCodeRunsRepo(S).countForProcesses([p.id]), consultStep: { status: step.status, tokensIn: step.inputTokens, error: step.error }, processTokensIn: done.inputTokens, issue: flow?.issue?.title, actions: (flow?.actions ?? []).map((a: any) => a.label) }, null, 1));
  assert.notEqual(done.status, 'failed', `la historia falla en vez de pausarse: ${done.error}`);
});

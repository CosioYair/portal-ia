import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Process } from '@portal-ia/domain';

/**
 * Diagnóstico (Gauntlet, contexto nuevo) de la primera prueba real: un lote SOLO con la suscripción de Claude Code
 * (HU-164 y HU-165, Gauntlet profundo, 2 a la vez, ≈1000 llamadas) se detuvo tras el plan por un «presupuesto» en USD
 * (0,10 USD por historia) con 0,00 USD de API gastados. Estas pruebas reproducen cada causa raíz y FALLAN hoy:
 *  1. storyUnits.startIncremental compara una estimación a precio de API de TODAS las unidades con los USD restantes,
 *     aunque el Desarrollador vaya por la suscripción (Q1, Q2, Q5).
 *  2. El coordinador del lote reserva el tope por historia en USD también para historias que solo usan la suscripción:
 *     reduce la concurrencia y puede pausar el lote por «presupuesto» sin gastar nada (Q1, Q5).
 *  3. Equipo mixto: las llamadas por la suscripción se bloquean cuando la API agotó (o superó) los USD del proceso
 *     (requirePolicy «ai_call» y budgetCheck con resto negativo) (Q1).
 *  4. Estado del lote: una pausa por el tope de llamadas se clasifica como «budget» (no «subscription»), «Reanudar» con
 *     más llamadas no la retoma y el lote dice «Lo automático terminó» con el estado «running» (Q4, Q15).
 * CLI de Claude Code SIMULADA (test/fixtures/fake-claude.mjs) y proveedor de API simulado: ningún modelo real, ningún crédito.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-r4plan-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-fakecc-r4plan-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = () => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, normalizePipeline, DEFAULT_PIPELINE } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { stopBatchScheduler } = await import('../src/services/batchRunner.ts');
const { resetDetectionCache } = await import('../src/services/claudeCode/detect.ts');
const { setBridgeUrl } = await import('../src/services/claudeCode/backend.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { createStoryProcess } = await import('../src/services/storyExecution.ts');
const { callAgentStep, newPipeline, stepCall, storyRunContext } = await import('../src/services/storyPipeline.ts');
process.env.PORTAL_PROVIDER_BACKOFF_MS = '5'; // reintentos de conexión sin esperas largas (solo pruebas)

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-r4plan-repo-'));
const uniq = `subbudget-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/base.ts'), 'export const base = 0;\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node -e ""', test: 'node -e ""', build: 'node -e ""' } }, null, 2));
fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: uniq, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.0' } } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
setBridgeUrl(`http://127.0.0.1:${(app.server.address() as any).port}`);
after(async () => { stopBatchScheduler(); await app.close(); });
const inject = (method: string, u: string, payload?: unknown) => app.inject({ method: method as any, url: u, payload: payload as any });

sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { const t = new Date().toISOString(); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' }; };

// ---------- Guion: plan con DOS unidades (como HU-164/165: «sus 2 unidades»), revisión del plan, Gauntlet y QA ----------
const PLAN = JSON.stringify({
  summary: 'Crear dos módulos', tasks: ['Crear src/sub-a.ts', 'Crear src/sub-b.ts'], filesToRead: [], filesToChange: ['src/sub-a.ts', 'src/sub-b.ts'],
  deliverables: [{ path: 'src/sub-a.ts', purpose: 'Módulo A', kind: 'code', estimatedLines: 300 }, { path: 'src/sub-b.ts', purpose: 'Módulo B', kind: 'code', estimatedLines: 300 }],
  acceptance: ['src/sub-a.ts existe', 'src/sub-b.ts existe'], risks: []
});
const OWNER = '=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre el archivo. Esperado: existe.\n';
const DEV = (f: string, c: string) => `=== RESUMEN ===\nCrea ${f}.\n=== ARCHIVO: ${f} | create ===\n${c}\n=== FIN ARCHIVO ===\n${OWNER}`;
const QA_OK = { verdict: 'approved', summary: 'Cumple; verificación en verde.', findings: [], suggestedTests: [] };
const PLAN_OK = JSON.stringify({ verdict: 'approve', coverage: [{ criterion: 'src/sub-a.ts existe', covered: 'yes', evidence: 'tarea 1' }, { criterion: 'src/sub-b.ts existe', covered: 'yes', evidence: 'tarea 2' }], gaps: [] });
const GAUNTLET_PASS = JSON.stringify({ verdict: 'pass', criteria: [{ criterion: 'src/sub-a.ts existe', status: 'met', evidence: 'src/sub-a.ts:1 export const subA = 1;' }, { criterion: 'src/sub-b.ts existe', status: 'met', evidence: 'src/sub-b.ts:1 export const subB = 2;' }], findings: [], largestGap: null, anotherRoundWorthIt: false, limitations: [] });
const R = { review: 'REVISIÓN DEL PLAN', ev: 'Evalúa de forma INDEPENDIENTE', qa: 'Evalúa la implementación con la EVIDENCIA real', plan: 'plan técnico', unitA: '- crear src/sub-a.ts', unitB: '- crear src/sub-b.ts', dev: 'Implementa la historia', probe: 'SONDA-SUSCRIPCION' };
const rules = () => [
  { match: R.review, text: PLAN_OK }, { match: R.ev, text: GAUNTLET_PASS }, { match: R.qa, structured: QA_OK }, { match: R.plan, text: PLAN },
  { match: R.unitA, text: DEV('src/sub-a.ts', 'export const subA = 1;') }, { match: R.unitB, text: DEV('src/sub-b.ts', 'export const subB = 2;') },
  { match: R.probe, text: 'respuesta de la sonda' }, { match: R.dev, text: DEV('src/sub-a.ts', 'export const subA = 1;') }
];
const ccRules = (extra: Record<string, unknown> = {}) => scenario({ auth: 'subscription', rules: rules(), ...extra });
/** Proveedor de API simulado con el mismo guion (solo se usa si algún agente va por la API). */
function apiScript(planThinkingTokens = 0) {
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: R.qa, text: JSON.stringify(QA_OK) }, { match: R.plan, text: PLAN, thinkingTokens: planThinkingTokens }, { match: R.unitA, text: DEV('src/sub-a.ts', 'export const subA = 1;') }, { match: R.unitB, text: DEV('src/sub-b.ts', 'export const subB = 2;') }, { match: R.review, text: PLAN_OK }, { match: R.ev, text: GAUNTLET_PASS }], markers: [] }));
  try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
const apiCalls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

saveClaudeCodeSettings({ ...getClaudeCodeSettings(), cliPath: FAKE });
ccRules(); resetDetectionCache();
assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true, maxDurationSec: 120 })).statusCode, 200);
assert.equal((await inject('PUT', `${W}/claude-code/projects`, { authorized: true, projectIds: [project.id] })).statusCode, 200);
// Evaluador Gauntlet del proyecto (aprobado por el propietario), como en la prueba real («Gauntlet profundo»).
assert.equal((await inject('POST', `${W}/projects/${project.id}/gauntlet/evaluator`, { authorized: true })).statusCode, 201);

async function setBackends(backend: 'api' | 'claude-code', only?: (a: { id: string; key: string }) => boolean) {
  for (const a of agentsRepo(S).list().filter(a => a.config.provider === 'anthropic' && (!only || only(a as any)))) {
    const r = await inject('PUT', `${W}/agents/${a.id}/backend`, { backend, authorized: true });
    assert.equal(r.statusCode, 200, r.body);
  }
}
const story = (title: string) => addManualItem(S, project.id, { title, criterion: 'los dos módulos existen' });
/** Lo que el propietario autorizó en la prueba real: solo la suscripción, la API sin autorizar (mínimo de la interfaz: 0,10 USD). */
const SUBSCRIPTION_ONLY = { backends: ['claude_code'], totalBudgetUsd: 0.1, perStoryBudgetUsd: 0.1, maxSubscriptionCalls: 1000, concurrency: 2, gauntlet: { mode: 'deep' }, maxCorrections: 1, commands: ['typecheck', 'test', 'build'] };
const authorize = async (itemIds: string[], extra: Record<string, unknown> = {}) => { const r = await inject('POST', `${W}/projects/${project.id}/batches`, { authorized: true, itemIds, ...SUBSCRIPTION_ONLY, ...extra }); assert.equal(r.statusCode, 201, r.body); return r.json(); };
const preview = async (itemIds: string[], extra: Record<string, unknown> = {}) => { const r = await inject('POST', `${W}/projects/${project.id}/batches/preview`, { itemIds, ...SUBSCRIPTION_ONLY, ...extra }); assert.equal(r.statusCode, 200, r.body); return r.json(); };
const get = async (id: string) => (await inject('GET', `${W}/batches/${id}`)).json();
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 45_000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what} · ${JSON.stringify((v as any)?.items?.map((i: any) => [i.storyId, i.state, i.failureClass, i.reason]) ?? v).slice(0, 2000)} · lote: ${(v as any)?.status} ${(v as any)?.reason ?? ''}`); await new Promise(r => setTimeout(r, 40)); v = await fn(); }
  return v;
}
const settled = (b: any) => b.status !== 'running' || !b.items.some((i: any) => ['queued', 'waiting_dependency', 'running', 'integrating'].includes(i.state));
const describeItems = (b: any) => b.items.map((i: any) => `${i.storyId}: ${i.state}/${i.failureClass ?? '-'} · ${i.reason ?? ''}`).join(' | ');
const close = async (id: string) => {
  const b = (await inject('POST', `${W}/batches/${id}/cancel`)).json();
  const pids: string[] = (b.items ?? []).flatMap((i: any) => i.processIds);
  await waitFor(async () => pids.filter(pid => processesRepo(S).get(pid)?.status === 'running'), r => !r.length, 'los procesos del lote se detienen');
};

// ======================= R4 · plan arrastrado tras editar la historia =======================
test('R4-1 · pausa por el tope en la revisión del plan, el propietario EDITA el criterio y reanuda: ¿se replanifica con el criterio nuevo?', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia R4-EDITADA');
  const b = await authorize([a.id], { totalBudgetUsd: 0, perStoryBudgetUsd: 0, concurrency: 1, gauntlet: { mode: 'deep' }, maxSubscriptionCalls: 1 });
  try {
    const p = await waitFor(() => get(b.id), y => y.status === 'paused' && !y.items.some((i: any) => i.state === 'running'), 'pausa por el tope');
    const pr0 = processesRepo(S).get(p.items[0].processId)!;
    console.log('R4-1 pausa:', describeItems(p), '| plan guardado:', JSON.stringify(pr0.result?.plan?.acceptance));
    // El propietario corrige la historia mientras está en pausa (StoryWorkspace → PATCH): «La próxima iteración usa este contexto».
    const patch = await inject('PATCH', `${W}/backlog/${a.id}`, { criterion: 'NUEVO-CRITERIO-R4: existe src/sub-c.ts' });
    assert.equal(patch.statusCode, 200, patch.body);
    const r = await inject('POST', `${W}/batches/${b.id}/resume`, { authorized: true, addSubscriptionCalls: 100 });
    assert.equal(r.statusCode, 200, r.body);
    const x = await waitFor(() => get(b.id), y => settled(y) && !y.items.some((i: any) => i.state === 'running'), 'asentado', 60_000);
    const runs = ccRuns(); const rules = runs.map((e: any) => e.rule);
    const pr1 = processesRepo(S).get(x.items[0].processId)!;
    const reviewSawNew = runs.filter((e: any) => e.rule === R.review).map((e: any) => /NUEVO-CRITERIO-R4/.test(e.prompt));
    console.log('R4-1 final:', describeItems(x), '| runs', JSON.stringify(rules), '| carriedPlan', pr1.result?.carriedPlan, '| acceptance usada', JSON.stringify(pr1.result?.plan?.acceptance), '| la revisión del plan vio el criterio nuevo:', JSON.stringify(reviewSawNew));
    const sawNew = (rule: string) => runs.filter((e: any) => e.rule === rule).map((e: any) => /NUEVO-CRITERIO-R4/.test(e.prompt));
    console.log('R4-1 criterio nuevo en: plan', JSON.stringify(sawNew(R.plan)), 'unidades', JSON.stringify([...sawNew(R.unitA), ...sawNew(R.unitB)]), 'QA', JSON.stringify(sawNew(R.qa)), 'Gauntlet', JSON.stringify(sawNew(R.ev)));
    const planRuns = rules.filter((q: string) => q === R.plan).length;
    assert.ok(planRuns >= 2 || (pr1.result?.plan?.acceptance ?? []).some(c => /NUEVO-CRITERIO-R4/.test(c)), `criterio editado en la pausa: el plan hecho con el criterio anterior se reutiliza (llamadas al planificador: ${planRuns}; criterios del plan implementado: ${JSON.stringify(pr1.result?.plan?.acceptance)})`);
  } finally { await close(b.id); }
});

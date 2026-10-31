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
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-subbudget-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-fakecc-subbudget-'));
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
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-subbudget-repo-'));
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

// ======================= Gauntlet challenger r3-a =======================
const { budgetOf } = await import('../src/services/batchRunner.ts');
const { batchesRepo } = await import('../src/db/batches.ts');

test('R3A-1 · lote con la API autorizada y 0 USD pedidos: ¿se rechaza o se autorizan USD que el propietario no dio?', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia CERO-USD-API');
  const pv = await inject('POST', `${W}/projects/${project.id}/batches/preview`, { itemIds: [a.id], ...SUBSCRIPTION_ONLY, backends: ['api', 'claude_code'], totalBudgetUsd: 0, perStoryBudgetUsd: 0 });
  console.log('preview', pv.statusCode, JSON.stringify(pv.json().auth ? { total: pv.json().auth.totalBudgetUsd, per: pv.json().auth.perStoryBudgetUsd } : pv.json()));
  const r = await inject('POST', `${W}/projects/${project.id}/batches`, { authorized: true, itemIds: [a.id], ...SUBSCRIPTION_ONLY, backends: ['api', 'claude_code'], totalBudgetUsd: 0, perStoryBudgetUsd: 0 });
  const body = r.json();
  console.log('create', r.statusCode, JSON.stringify(body.auth ? { total: body.auth.totalBudgetUsd, per: body.auth.perStoryBudgetUsd, backends: body.auth.backends } : body));
  try {
    assert.notEqual(r.statusCode, 201, `0 USD pedidos con la API autorizada → autorizado con ${body.auth?.totalBudgetUsd} USD en total y ${body.auth?.perStoryBudgetUsd} por historia`);
  } finally { if (r.statusCode === 201) await close(body.id); }
});

test('R3A-2 · tope de llamadas a mitad de la implementación con 2 a la vez: «Reanudar» retoma ambas sin repetir unidades', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia TOPEMITAD-A'); const c = story('Historia TOPEMITAD-B');
  const b = await authorize([a.id, c.id], { perStoryBudgetUsd: 0, totalBudgetUsd: 0, concurrency: 2, gauntlet: { mode: 'off' }, maxSubscriptionCalls: 5 });
  try {
    const p = await waitFor(() => get(b.id), y => y.status === 'paused' && !y.items.some((i: any) => i.state === 'running'), 'el tope detiene el lote');
    console.log('pausado:', p.reason, '|', describeItems(p), '| runs', ccRuns().length, 'subscriptionCalls', p.subscriptionCalls);
    const before = ccRuns().map((e: any) => e.rule);
    const r = await inject('POST', `${W}/batches/${b.id}/resume`, { authorized: true, addSubscriptionCalls: 200 });
    assert.equal(r.statusCode, 200, r.body);
    const x = await waitFor(() => get(b.id), y => settled(y) && !y.items.some((i: any) => i.state === 'running'), 'asentado tras reanudar', 60_000);
    const all = ccRuns();
    console.log('final:', x.status, x.reason, '|', describeItems(x), '| runs', all.length);
    const count: Record<string, number> = {};
    for (const e of all) { const who = /TOPEMITAD-A/.test(e.prompt) ? 'A' : /TOPEMITAD-B/.test(e.prompt) ? 'B' : '?'; const k = `${who}:${e.rule}`; count[k] = (count[k] ?? 0) + 1; }
    console.log('llamadas por historia/regla', JSON.stringify(count), 'antes', JSON.stringify(before));
    for (const it of x.items) { const pr = processesRepo(S).get(it.processId)!; console.log(it.storyId, it.processIds.length, 'procesos', pr.result?.pipeline?.state, pr.result?.manifest?.units.map(u => `${u.id}:${u.status}`).join(',')); }
    assert.deepEqual(x.items.map((i: any) => i.state), ['awaiting_integration', 'awaiting_integration'], describeItems(x));
    // Dos historias: cada regla, exactamente 2 veces (una por historia), y el tope no se superó antes de reanudar.
    assert.ok(Object.values(count).every(n => n === 2), JSON.stringify(count));
    assert.equal(before.length, 5, 'tope 5 respetado con 2 a la vez');
  } finally { await close(b.id); }
});

test('R3A-3 · lote mixto (QA en la API): «Reanudar» tras una pausa por USD, SIN añadir presupuesto, ¿respeta el total autorizado del lote?', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia REANUDAR-USD');
  const qa = (await preview([a.id], { backends: ['api', 'claude_code'] })).plan[0].team.find((t: any) => t.roles.includes('reviewer')).agentId;
  await setBackends('api', ag => ag.id === qa);
  const qaAgent = agentsRepo(S).get(qa)!; const oldModel = qaAgent.config.model;
  agentsRepo(S).updateConfig(qa, { ...qaAgent.config, model: 'claude-opus-4-1' }); // ≈ 0,2 USD estimados por la revisión de QA
  try {
    const b = await authorize([a.id], { backends: ['api', 'claude_code'], gauntlet: { mode: 'off' }, concurrency: 1, totalBudgetUsd: 0.1, perStoryBudgetUsd: 0.1 });
    try {
      for (let k = 0; k < 8; k++) {
        const x = await waitFor(() => get(b.id), y => y.status !== 'running' || (settled(y) && !y.items.some((i: any) => i.state === 'running')), 'asentado', 45_000);
        const p = processesRepo(S).get(x.items[0].processId)!;
        console.log(`ronda ${k}: lote ${x.status} · item ${x.items[0].state}/${x.items[0].failureClass} · proceso budget ${p.budgetUsd.toFixed(3)} spent ${p.spentUsd.toFixed(4)} unconf ${(p.unconfirmedUsd ?? 0).toFixed(4)} · pausa ${p.result?.pipeline?.pauseKind}: ${(p.result?.pipeline?.reason ?? '').slice(0, 160)} · lote total ${x.auth.totalBudgetUsd} gastado ${x.budget.spent} · api calls ${apiCalls().length}`);
        if (p.result?.pipeline?.state === 'verified' || x.items[0].state !== 'needs_owner') break;
        const r = await inject('POST', `${W}/batches/${b.id}/resume`, { authorized: true });
        if (r.statusCode !== 200) { console.log('resume', r.statusCode, r.body.slice(0, 200)); break; }
      }
      const x = await get(b.id); const p = processesRepo(S).get(x.items[0].processId)!;
      assert.ok(p.budgetUsd <= x.auth.totalBudgetUsd + 1e-9, `el proceso tiene ${p.budgetUsd} USD autorizados con un lote de ${x.auth.totalBudgetUsd} USD en total (sin añadir presupuesto)`);
      assert.ok(p.spentUsd + (p.unconfirmedUsd ?? 0) <= x.auth.totalBudgetUsd + 1e-9, `gasto de API ${p.spentUsd} USD > total del lote ${x.auth.totalBudgetUsd}`);
    } finally { await close(b.id); }
  } finally { agentsRepo(S).updateConfig(qa, { ...agentsRepo(S).get(qa)!.config, model: oldModel }); await setBackends('claude-code'); }
});

test('R3A-4 · lote SOLO suscripción con 0 USD (total y por historia), Gauntlet profundo, 2 a la vez: termina sin pausas por USD', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia CERO-DEEP-1'); const c = story('Historia CERO-DEEP-2');
  const b = await authorize([a.id, c.id], { totalBudgetUsd: 0, perStoryBudgetUsd: 0 });
  try {
    const x = await waitFor(() => get(b.id), settled, 'asentado', 60_000);
    console.log('R3A-4', x.status, x.reason, '|', describeItems(x), '| runs', ccRuns().length, 'api', apiCalls().length, 'auth', x.auth.totalBudgetUsd, x.auth.perStoryBudgetUsd);
    for (const it of x.items) { const p = processesRepo(S).get(it.processId)!; console.log(it.storyId, p.budgetUsd, p.result?.pipeline?.state, p.result?.gauntlet?.status, p.result?.gauntlet?.planReview?.status); }
    assert.deepEqual(x.items.map((i: any) => i.state), ['awaiting_integration', 'awaiting_integration'], describeItems(x));
    assert.equal(apiCalls().length, 0);
  } finally { await close(b.id); }
});

test('R3A-5 · «Reanudar» del lote y una pausa por el LÍMITE DE USO de la suscripción (tras la entrega): ¿se retoma?', async () => {
  const { resumableInBatch } = await import('../src/services/batchRunner.ts');
  const mk = (pauseKind: string) => ({ id: 'x', status: 'done', steps: [{ role: 'implementer', outputMd: 'algo', status: 'done' }], result: { merged: null, rejected: null, changes: [{ path: 'a', error: null }], manifest: { units: [] }, applied: { commit: 'c' }, pipeline: { state: 'paused', pauseKind, startedAt: '' } } }) as any;
  const out = Object.fromEntries(['call_cap', 'budget', 'environment', 'duration', 'interrupted', 'subscription_limit', 'max_turns', 'provider_timeout', 'provider_error'].map(k => [k, resumableInBatch(S, mk(k))]));
  console.log('R3A-5', JSON.stringify(out));
  assert.equal(out.subscription_limit, 'continue', 'una pausa por el límite de uso de la suscripción no se retoma con «Reanudar» del lote');
});

test('R3A-6 · tope de llamadas en la revisión del plan (antes de implementar): «Reanudar» ¿retoma donde quedó o repite el plan?', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia TOPE-PLAN');
  const b = await authorize([a.id], { totalBudgetUsd: 0, perStoryBudgetUsd: 0, concurrency: 1, gauntlet: { mode: 'deep' }, maxSubscriptionCalls: 1 });
  try {
    const p = await waitFor(() => get(b.id), y => y.status === 'paused' && !y.items.some((i: any) => i.state === 'running'), 'pausa por el tope');
    const pr0 = processesRepo(S).get(p.items[0].processId)!;
    console.log('R3A-6 pausa:', describeItems(p), '| proceso', pr0.status, pr0.result?.pipeline?.state, pr0.result?.pipeline?.pauseKind, '| plan guardado:', !!pr0.result?.plan, '| runs', ccRuns().map((e: any) => e.rule));
    const r = await inject('POST', `${W}/batches/${b.id}/resume`, { authorized: true, addSubscriptionCalls: 100 });
    assert.equal(r.statusCode, 200, r.body);
    const x = await waitFor(() => get(b.id), y => settled(y) && !y.items.some((i: any) => i.state === 'running'), 'asentado', 60_000);
    const rules = ccRuns().map((e: any) => e.rule);
    console.log('R3A-6 final:', describeItems(x), '| procesos', x.items[0].processIds.length, '| runs', JSON.stringify(rules));
    assert.equal(rules.filter((r: string) => r === R.plan).length, 1, 'el plan ya hecho no se repite');
  } finally { await close(b.id); }
});

test('R4 · lote heredado SOLO suscripción que la versión anterior pausó por «presupuesto» (HU-164/HU-165): «Reanudar» con más llamadas y sin USD sigue y termina con 0 USD, sin repetir el plan', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia HEREDADA-SUB');
  const b = await authorize([a.id], { totalBudgetUsd: 0.1, perStoryBudgetUsd: 0.1, concurrency: 1, gauntlet: { mode: 'off' }, maxSubscriptionCalls: 2 });
  try {
    const p = await waitFor(() => get(b.id), y => y.status === 'paused' && !y.items.some((i: any) => i.state === 'running'), 'pausa a mitad de la implementación');
    const pid = p.items[0].processId; const pr = processesRepo(S).get(pid)!;
    assert.ok(pr.result?.manifest, 'el plan y el manifiesto se conservan (como en HU-164/HU-165)');
    // Exactamente como lo dejó la versión anterior: pausa por «presupuesto» (0,10 USD) en una historia solo de suscripción.
    processesRepo(S).setResult(pid, { ...pr.result!, pipeline: { ...pr.result!.pipeline!, pauseKind: 'budget', reason: 'El plan necesita ≈ 0.40 USD solo para implementar sus 2 unidades y quedan 0.10 USD autorizados.' } });
    batchesRepo(S).update(b.id, x => { x.status = 'running'; x.reason = 'Lo automático terminó; esperan tu decisión: HEREDADA-SUB.'; x.items[0].state = 'needs_owner'; x.items[0].failureClass = 'budget'; x.items[0].resumeProcessId = null; });
    const plans = ccRuns().filter((e: any) => e.rule === R.plan).length; const apiBefore = apiCalls().length;
    const r = await inject('POST', `${W}/batches/${b.id}/resume`, { authorized: true, addSubscriptionCalls: 100 });
    assert.equal(r.statusCode, 200, r.body);
    const x = await waitFor(() => get(b.id), y => settled(y) && !y.items.some((i: any) => i.state === 'running'), 'asentado tras reanudar', 60_000);
    assert.equal(x.items[0].state, 'awaiting_integration', describeItems(x));
    assert.equal(x.items[0].processIds.length, 1, 'se retoma el mismo proceso (donde quedó)');
    assert.equal(ccRuns().filter((e: any) => e.rule === R.plan).length, plans, 'el plan no se vuelve a pedir');
    assert.equal(apiCalls().length, apiBefore, 'ninguna llamada a la API');
    assert.equal(processesRepo(S).get(pid)!.spentUsd, 0, '0 USD');
  } finally { await close(b.id); }
});

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

// ================================================================================================================
test('Q1/Q2/Q5 · lote SOLO con la suscripción (HU-164/165): 2 historias, 0,10 USD por historia, ≈1000 llamadas, Gauntlet profundo → terminan sin ninguna pausa por «presupuesto»', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia SUSCRIPCION-164'); const c = story('Historia SUSCRIPCION-165');
  const b = await authorize([a.id, c.id]);
  try {
    const x = await waitFor(() => get(b.id), settled, 'el lote se asienta');
    const procs: Process[] = x.items.map((i: any) => processesRepo(S).get(i.processId)!);
    const budgetPauses = procs.filter(p => p.result?.pipeline?.pauseKind === 'budget').map(p => p.result!.pipeline!.reason);
    // Hoy: «El plan necesita ≈ X USD solo para implementar sus 2 unidades y quedan 0.10 USD autorizados» en las dos.
    assert.deepEqual(budgetPauses, [], `ninguna pausa por USD en un lote que solo usa la suscripción (gasto de API ${x.budget.spent} USD; lote «${x.status}»: ${x.reason}; ${describeItems(x)}): ${budgetPauses.join(' || ')}`);
    assert.deepEqual(x.items.map((i: any) => i.state), ['awaiting_integration', 'awaiting_integration'], describeItems(x));
    assert.equal(apiCalls().length, 0, '0 llamadas a la API');
    assert.equal(x.budget.spent, 0, '0,00 USD de API');
    assert.ok(x.subscriptionCalls <= 1000, 'llamadas ≤ tope autorizado');
    for (const p of procs) {
      assert.ok(p.result!.manifest!.units.every(u => u.status === 'done'), 'todas las unidades implementadas por la suscripción');
      assert.equal(p.result!.gauntlet?.planReview?.status !== undefined, true, 'hubo revisión del plan (Gauntlet profundo)');
    }
  } finally { await close(b.id); }
});

test('Q1/Q5 · lote SOLO con la suscripción: el tope en USD por historia no puede impedir empezar (total 0,10 USD, tope 0,50 USD por historia)', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia SIN-USD-1');
  const p = await preview([a.id], { totalBudgetUsd: 0.1, perStoryBudgetUsd: 0.5 });
  // Hoy: «Con estos límites el lote se pausará tras ≈ 0 de 1 historias (presupuesto de API)».
  assert.ok(!p.summary.fits.limitedBy.includes('budget'), `la vista previa no limita por USD a un lote sin API: ${JSON.stringify(p.summary.fits)} · ${p.warnings.join(' | ')}`);
  const b = await authorize([a.id], { totalBudgetUsd: 0.1, perStoryBudgetUsd: 0.5 });
  try {
    const x = await waitFor(() => get(b.id), y => y.status !== 'running' || y.items[0].state !== 'queued', 'empieza o se pausa');
    // Hoy: el lote se pausa al instante: «El presupuesto restante del lote (0.10 USD de 0.1) no cubre el tope de otra historia (0.5 USD)».
    assert.notEqual(x.status, 'paused', `el lote se pausó por USD sin gastar nada: ${x.reason}`);
    assert.ok(!/presupuesto/i.test(x.reason ?? ''), x.reason);
  } finally { await close(b.id); }
});

test('Q1 · lote SOLO con la suscripción y 2 a la vez: la reserva de USD por historia no reduce la concurrencia autorizada', async () => {
  await setBackends('claude-code'); ccRules({ slowMs: 400 }); apiScript();
  const a = story('Historia PARALELA-1'); const c = story('Historia PARALELA-2');
  const b = await authorize([a.id, c.id], { perStoryBudgetUsd: 5, totalBudgetUsd: 5 });
  try {
    let both = false;
    await waitFor(() => get(b.id), y => { if (y.items.filter((i: any) => i.state === 'running').length === 2) both = true; return both || settled(y); }, 'las dos en marcha o el lote asentado');
    // Hoy: con 5 USD en total y 5 por historia, la segunda espera a que la primera termine (reserva de USD que nunca se gastará).
    assert.ok(both, 'las dos historias (0 USD de API cada una) deben ir a la vez, como autorizó el propietario (concurrencia 2)');
  } finally { await close(b.id); ccRules(); }
});

test('Q1 · equipo mixto: el Desarrollador (y el resto) en la suscripción, QA en la API con 0,10 USD → las unidades se implementan por la suscripción; solo la llamada de QA (API) puede pausar por USD, y ANTES de hacerse', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia MIXTA-QA-API');
  const qa = (await preview([a.id], { backends: ['api', 'claude_code'] })).plan[0].team.find((t: any) => t.roles.includes('reviewer')).agentId;
  await setBackends('api', ag => ag.id === qa);
  try {
    const b = await authorize([a.id], { backends: ['api', 'claude_code'], gauntlet: { mode: 'off' }, concurrency: 1 });
    try {
      const x = await waitFor(() => get(b.id), settled, 'la historia se asienta');
      const p = processesRepo(S).get(x.items[0].processId)!; const pl = p.result!.pipeline!;
      const units = p.result!.manifest!.units;
      // Hoy: pausa en startIncremental («El plan necesita ≈ … USD solo para implementar sus 2 unidades») sin implementar nada.
      assert.ok(units.every(u => u.status === 'done'), `las unidades (Desarrollador en la suscripción) no dependen de USD: ${units.map(u => `${u.id}:${u.status}`).join(', ')} · ${pl.pauseKind}: ${pl.reason}`);
      if (pl.pauseKind === 'budget') assert.match(pl.reason ?? '', /QA/, 'si hay pausa por USD, es justo antes de la llamada de QA por la API');
      assert.ok(apiCalls().every(c => c.rule === R.qa), `por la API solo QA: ${apiCalls().map(c => c.rule).join(', ')}`);
    } finally { await close(b.id); }
  } finally { await setBackends('claude-code'); }
});

test('Q1 · equipo mixto: si la API agotó (o superó) los USD del proceso, una llamada por la SUSCRIPCIÓN no se bloquea (requirePolicy «ai_call» y budgetCheck)', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const it = story('Historia SONDA-POLITICA');
  const proc = createStoryProcess(S, project.id, it.id);
  processesRepo(S).setResult(proc.id, { ...proc.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, backends: ['api', 'claude_code'] })) });
  processesRepo(S).authorize(proc.id, 0.1);
  const { ctx } = storyRunContext(S, proc.id, () => undefined, () => false);
  const dev = ctx.dev;
  assert.equal(dev.config.backend, 'claude-code');
  // Una llamada anterior por la API costó exactamente lo autorizado (el estimado era menor: el coste real no se conoce antes).
  processesRepo(S).addUsage(proc.id, 1000, 1000, 0.1);
  const call = () => stepCall(ctx, dev, 'implementer', 'Sonda por la suscripción', 'diagnóstico', 'sistema', `${R.probe}: responde algo.`, 1000);
  try {
    // Hoy: PolicyError «Presupuesto agotado (0.10 de 0.10 USD)» → el pipeline lo trata como fallo interno (proceso «failed»).
    await assert.doesNotReject(call, 'gastado = presupuesto: la suscripción no descuenta USD y debe poder seguir');
    processesRepo(S).addUsage(proc.id, 1000, 1000, 0.05);
    // Hoy: PipelinePause('budget') «La siguiente llamada (≈ 0.00 USD) superaría el presupuesto autorizado: quedan 0.00 USD».
    await assert.doesNotReject(call, 'gastado > presupuesto: la suscripción sigue sin descontar USD');
  } finally { processesRepo(S).finish(proc.id, 'done', null); }
});

test('Q4/Q15 · tope de llamadas a la suscripción: se clasifica como suscripción (no «presupuesto»), «Reanudar» con más llamadas retoma la historia en pausa sin repetir nada y el lote nunca dice «Lo automático terminó» mientras puede seguir', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia TOPE-1'); const c = story('Historia TOPE-2');
  // USD por historia generosos para aislar el tope de llamadas del fallo de startIncremental; Gauntlet desactivado.
  const b = await authorize([a.id, c.id], { perStoryBudgetUsd: 5, totalBudgetUsd: 10, concurrency: 1, gauntlet: { mode: 'off' }, maxSubscriptionCalls: 2 });
  try {
    const problems: string[] = [];
    const p = await waitFor(() => get(b.id), y => y.status === 'paused' || settled(y), 'el tope detiene el lote');
    const first = p.items.find((i: any) => i.state === 'needs_owner');
    assert.ok(first, describeItems(p));
    const proc0 = processesRepo(S).get(first.processId)!;
    const where = `proceso ${proc0.status} · pausa ${proc0.result?.pipeline?.pauseKind ?? '-'} · pasos: ${proc0.steps.map(s => `${s.title}=${s.status}`).join(', ')}`;
    // Hoy: el tope se lanza como `budget: true`; antes de la entrega termina el proceso como «budget_exceeded» (→ owner_decision)
    // y durante las unidades como PipelinePause('budget') (→ budget). Nunca «subscription».
    if (first.failureClass !== 'subscription') problems.push(`clase «${first.failureClass}» en vez de «subscription» (${where})`);
    if (proc0.status === 'budget_exceeded') problems.push('el proceso quedó «budget_exceeded» (USD) por un tope de LLAMADAS');
    const runsBefore = ccRuns().length;
    const r = await inject('POST', `${W}/batches/${b.id}/resume`, { authorized: true, addSubscriptionCalls: 100 });
    assert.equal(r.statusCode, 200, r.body);
    const x = await waitFor(() => get(b.id), y => settled(y) && !y.items.some((i: any) => i.state === 'running'), 'el lote se asienta tras reanudar', 45_000);
    const firstAfter = x.items.find((i: any) => i.itemId === first.itemId);
    if (firstAfter.state !== 'awaiting_integration') problems.push(`«Reanudar» con 100 llamadas más no retomó ${first.storyId}: ${firstAfter.state}/${firstAfter.failureClass} · ${firstAfter.reason}`);
    // Hoy: el lote sigue «running» y dice «Lo automático terminó; esperan tu decisión…» aunque la historia puede seguir.
    if (/Lo automático terminó/.test(x.reason ?? '')) problems.push(`el lote (${x.status}) dice «${x.reason}»`);
    if (firstAfter.state !== 'awaiting_integration') {
      const retry = await inject('POST', `${W}/batches/${b.id}/items/${first.itemId}/retry`, { authorized: true });
      if (retry.statusCode !== 200) problems.push(`tampoco se puede «Reintentar» desde el lote: ${retry.statusCode} ${retry.json().error}`);
      const cont = await inject('POST', `${W}/processes/${first.processId}/continue`, { authorized: true });
      if (cont.statusCode === 200) {
        const after = await waitFor(async () => processesRepo(S).get(first.processId)!, q => q.status !== 'running', 'continuar desde el proceso');
        if (after.result?.pipeline?.state !== 'verified') problems.push(`y «Continuar» desde el proceso termina en ${after.status} · ${after.result?.pipeline?.state ?? '-'} · ${after.result?.failure?.detail ?? after.error ?? after.result?.pipeline?.reason ?? ''}`);
      } else problems.push(`y «Continuar» desde el proceso responde ${cont.statusCode}: ${cont.body.slice(0, 200)}`);
    }
    if (ccRuns().length <= runsBefore) problems.push('no volvió a llamar a la suscripción tras ampliar el tope');
    assert.equal(apiCalls().length, 0);
    assert.deepEqual(problems, [], describeItems(x));
  } finally { await close(b.id); }
});

// ---------- Llamadas por la API que escapan al límite en USD ----------
/** Proceso de historia con el Desarrollador en la API (equipo mixto autorizado), autorizado con `budget` USD. */
async function apiDevProcess(title: string, budget: number) {
  await setBackends('claude-code'); ccRules();
  const it = story(title);
  const proc = createStoryProcess(S, project.id, it.id);
  const devId = proc.steps.find(s => s.role === 'implementer')!.agentId;
  await setBackends('api', ag => ag.id === devId);
  processesRepo(S).setResult(proc.id, { ...proc.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, backends: ['api', 'claude_code'] })) });
  processesRepo(S).authorize(proc.id, budget);
  return { pid: proc.id, devId, stepId: proc.steps.find(s => s.role === 'implementer')!.id };
}

test('API · una continuación con historial (plan compacto, implementación sin unidades) comprueba el presupuesto SIN contar el historial que se reenvía', async () => {
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: 'CONTINUA-SONDA', text: 'fin' }], markers: [] }));
  const { pid, stepId } = await apiDevProcess('Historia HISTORIAL-API', 0.1);
  try {
    // ≈ 115 000 tokens de historial: con cualquier tarifa de Anthropic supera con creces 0,10 USD.
    const history = [{ role: 'user' as const, content: 'x'.repeat(400_000) }, { role: 'assistant' as const, content: 'parcial' }];
    let refused = false;
    try { await callAgentStep(S, pid, stepId, 'sistema', 'CONTINUA-SONDA: continúa exactamente donde quedó.', 1000, { history, injected: new Map(), log: () => undefined }); }
    catch (e: any) { refused = !!e?.budget; }
    const p = processesRepo(S).get(pid)!;
    // Hoy: budgetCheck(system, user) ignora `history` → la llamada se envía y el gasto confirmado supera lo autorizado.
    assert.ok(refused || p.spentUsd <= p.budgetUsd, `la llamada por la API superó lo autorizado sin pausar antes: gastado ${p.spentUsd.toFixed(4)} de ${p.budgetUsd} USD`);
  } finally { processesRepo(S).finish(pid, 'done', null); await setBackends('claude-code'); }
});

test('API · reintentos por error de conexión: cada intento que pudo facturarse cuenta como «sin confirmar» (hoy solo el último que falla)', async () => {
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: 'REINTENTO-SONDA', text: 'ok', failTimes: 2, error: 'network' }], markers: [] }));
  const { resetMockCalls } = await import('@portal-ia/ai-adapters'); resetMockCalls();
  const { pid, stepId } = await apiDevProcess('Historia REINTENTOS-API', 1);
  try {
    await callAgentStep(S, pid, stepId, 'sistema', `REINTENTO-SONDA ${'contexto '.repeat(4000)}`, 1000, { injected: new Map(), log: () => undefined, retries: 2 });
    const p = processesRepo(S).get(pid)!;
    // Hoy: maybeBilled('network') = true, pero la rama de reintento hace `continue` ANTES de registrar el posible cobro.
    assert.ok((p.unconfirmedUsd ?? 0) > 0, `dos intentos «posiblemente facturados» (network) y unconfirmedUsd = ${p.unconfirmedUsd ?? 0}`);
  } finally { processesRepo(S).finish(pid, 'done', null); await setBackends('claude-code'); }
});

test('encargo (EN) con 0 USD de API: se autoriza si TODO el equipo va por la suscripción (tope de llamadas obligatorio); con algún agente en la API se rechaza sin crear trabajo', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const define = async (title: string) => { const r = await inject('POST', `${W}/projects/${project.id}/assignments`, { request: `Quiero ${title.toLowerCase()} directamente, sin crear historias.`, title, objective: 'Que existan los dos módulos.', criteria: ['src/sub-a.ts existe', 'src/sub-b.ts existe'], size: 'S' }); assert.equal(r.statusCode, 201, r.body); return r.json(); };
  const a = await define('Crear los módulos por la suscripción');
  const r = await inject('POST', `${W}/assignments/${a.id}/authorize`, { authorized: true, budgetUsd: 0, maxSubscriptionCalls: 40, gauntlet: { mode: 'off' } });
  assert.equal(r.statusCode, 200, r.body);
  const p = await waitFor(async () => processesRepo(S).get(r.json().processId)!, q => q.status !== 'running', 'el encargo termina');
  assert.equal(p.budgetUsd, 0); assert.equal(p.result?.pipeline?.config.maxSubscriptionCalls, 40, 'el tope de llamadas sigue');
  assert.equal(p.result?.pipeline?.config.apiFallback, false, 'sin USD no hay alternativa por la API');
  assert.equal(p.result?.pipeline?.state, 'verified', `${p.result?.pipeline?.pauseKind}: ${p.result?.pipeline?.reason}`);
  assert.equal(apiCalls().length, 0);
  const qa = p.steps.find(s => s.role === 'reviewer')!.agentId;
  await setBackends('api', ag => ag.id === qa);
  try {
    const c = await define('Crear los módulos con QA en la API');
    const denied = await inject('POST', `${W}/assignments/${c.id}/authorize`, { authorized: true, budgetUsd: 0, gauntlet: { mode: 'off' } });
    assert.equal(denied.statusCode, 400, denied.body); assert.equal(denied.json().code, 'budget_required');
    assert.equal(apiCalls().length, 0);
  } finally { await setBackends('claude-code'); }
});

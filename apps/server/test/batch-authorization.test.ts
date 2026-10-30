import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Lotes y orígenes de ejecución: el origen es de cada AGENTE (API, Claude Code gestionado o consola), no de la historia.
 * La vista previa y la ejecución real usan la MISMA comprobación (origen autorizado en el lote, conector, proyecto,
 * suscripción, consola, proveedor y alternativa por API). CLI de Claude Code SIMULADA y proveedor de API simulado:
 * ningún modelo real, ningún crédito.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-batchauth-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-fakecc-batch-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = () => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, backlogRepo, processesRepo, projectsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { stopBatchScheduler } = await import('../src/services/batchRunner.ts');
const { resetDetectionCache } = await import('../src/services/claudeCode/detect.ts');
const { setBridgeUrl } = await import('../src/services/claudeCode/backend.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-batchauth-repo-'));
const uniq = `batchauth-${Date.now().toString(36)}`;
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

// Respuestas: el mismo guion vale para la CLI simulada (subcadena del encargo) y para el proveedor de API simulado.
const PLAN = JSON.stringify({ summary: 'Crear el archivo', tasks: ['Crear src/x.ts'], filesToRead: [], filesToChange: ['src/x.ts'], acceptance: ['src/x.ts existe'], risks: [] });
const DEV = '=== RESUMEN ===\nCrea src/x.ts.\n=== ARCHIVO: src/x.ts | create ===\nexport const x = 1;\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre src/x.ts. Esperado: existe.';
const QA_OK = { verdict: 'approved', summary: 'Cumple; verificación en verde.', findings: [], suggestedTests: [] };
const R = { qa: 'Evalúa la implementación con la EVIDENCIA real', dev: 'Implementa la historia', plan: 'plan técnico' };
const ccRules = (extra: Record<string, unknown> = {}) => scenario({ auth: 'subscription', rules: [{ match: R.qa, structured: QA_OK }, { match: R.dev, text: DEV }, { match: R.plan, text: PLAN }], ...extra });
function apiScript() {
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: R.qa, text: JSON.stringify(QA_OK) }, { match: R.dev, text: DEV }, { match: R.plan, text: PLAN }], markers: [] }));
  try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
const apiCalls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

// Conector activado con la CLI simulada y el proyecto autorizado (como lo haría el propietario desde la interfaz).
saveClaudeCodeSettings({ ...getClaudeCodeSettings(), cliPath: FAKE });
ccRules(); resetDetectionCache();
assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true, maxDurationSec: 120 })).statusCode, 200);
const authorizeProject = async (on: boolean) => assert.equal((await inject('PUT', `${W}/claude-code/projects`, { authorized: true, projectIds: on ? [project.id] : [] })).statusCode, 200);
await authorizeProject(true);

/** Pone cada agente de Anthropic en `backend` (con autorización explícita, por agente, como en la interfaz). */
async function setBackends(backend: 'api' | 'claude-code', only?: (a: { key: string }) => boolean) {
  for (const a of agentsRepo(S).list().filter(a => a.config.provider === 'anthropic' && (!only || only(a)))) {
    const r = await inject('PUT', `${W}/agents/${a.id}/backend`, { backend, authorized: true });
    assert.equal(r.statusCode, 200, r.body);
  }
}
const story = (title: string) => addManualItem(S, project.id, { title, criterion: 'el archivo existe' });
const body = (itemIds: string[], extra: Record<string, unknown> = {}) => ({ itemIds, totalBudgetUsd: 5, perStoryBudgetUsd: 1, maxCorrections: 0, commands: ['typecheck', 'test', 'build'], gauntlet: { mode: 'off' }, ...extra });
const preview = async (itemIds: string[], extra: Record<string, unknown> = {}) => { const r = await inject('POST', `${W}/projects/${project.id}/batches/preview`, body(itemIds, extra)); assert.equal(r.statusCode, 200, r.body); return r.json(); };
const authorize = async (itemIds: string[], extra: Record<string, unknown> = {}) => { const r = await inject('POST', `${W}/projects/${project.id}/batches`, { authorized: true, ...body(itemIds, extra) }); assert.equal(r.statusCode, 201, r.body); return r.json(); };
const get = async (id: string) => (await inject('GET', `${W}/batches/${id}`)).json();
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what} · ${JSON.stringify((v as any)?.items?.map((i: any) => [i.storyId, i.state, i.reason]) ?? v).slice(0, 1500)}`); await new Promise(r => setTimeout(r, 50)); v = await fn(); }
  return v;
}
const settledItem = (b: any) => !['queued', 'waiting_dependency', 'running', 'integrating'].includes(b.items[0].state);
/** Cancela el lote y espera a que sus procesos se detengan (entre pasos), para que no interfieran con la prueba siguiente. */
const close = async (id: string) => {
  const b = (await inject('POST', `${W}/batches/${id}/cancel`)).json();
  const pids: string[] = (b.items ?? []).flatMap((i: any) => i.processIds);
  await waitFor(async () => pids.filter(pid => processesRepo(S).get(pid)?.status === 'running'), r => !r.length, 'los procesos del lote se detienen');
};

test('regresión · Claude Code gestionado autorizado en el agente, el proyecto y el lote: la vista previa no lo marca «no autorizado» y la historia se ejecuta', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia CC-AUTORIZADA');
  const p = await preview([a.id], { backends: ['api', 'claude_code'] });
  assert.deepEqual(p.plan[0].disallowedBackends, [], `orígenes del equipo: ${JSON.stringify(p.plan[0].backends)}`);
  assert.ok(!p.warnings.some((w: string) => /origen de ejecución que no autorizas/.test(w)), p.warnings.join(' | '));
  const b = await authorize([a.id], { backends: ['api', 'claude_code'] });
  const x = await waitFor(() => get(b.id), settledItem, 'la historia termina');
  assert.equal(x.items[0].state, 'awaiting_integration', `${x.items[0].state}: ${x.items[0].reason}`);
  assert.ok(ccRuns().length >= 3, 'el equipo trabajó con Claude Code');
  assert.equal(apiCalls().length, 0, 'ninguna llamada a la API');
  await close(b.id);
});

test('proyecto sin autorizar para Claude Code: la vista previa lo bloquea con un motivo (sin repetirlo) y dónde corregirlo; autorizar el lote se rechaza con el mismo motivo y no crea nada', async () => {
  await setBackends('claude-code'); ccRules(); apiScript(); await authorizeProject(false);
  try {
    const a = story('Historia CC-SIN-PROYECTO');
    const p = await preview([a.id]);
    const s = p.plan[0];
    assert.equal(s.executable, false); assert.equal(p.summary.blockedByPermission, 1); assert.equal(p.summary.executable, 0);
    assert.ok(s.team.length >= 3 && s.team.every((t: any) => t.source === 'claude_code' && t.allowed && !t.ready));
    assert.equal(s.problems.length, 1, 'el mismo motivo de varios agentes se dice una vez');
    assert.match(s.problems[0], /no está autorizado para Claude Code: autorízalo en Proveedores → Claude Code — Local/);
    assert.equal(s.team[0].fix.href, '/configuracion/proveedor#claude-code');
    assert.deepEqual(s.disallowedBackends, [], 'el origen sí está autorizado en el lote: falta el proyecto');
    const before = processesRepo(S).list(project.id).length;
    const r = await inject('POST', `${W}/projects/${project.id}/batches`, { authorized: true, ...body([a.id]) });
    assert.equal(r.statusCode, 409); assert.equal(r.json().code, 'not_authorized');
    assert.ok(r.json().error.includes(s.problems[0]), `misma explicación que la vista previa: ${r.json().error}`);
    assert.equal(processesRepo(S).list(project.id).length, before, 'ningún proceso creado');
    assert.equal(ccRuns().length, 0); assert.equal(apiCalls().length, 0, 'ninguna llamada');
  } finally { await authorizeProject(true); }
});

test('permiso perdido DURANTE el lote: la siguiente historia no se prepara; el lote entero se pausa una vez con el motivo y su enlace, y «Reanudar» lo vuelve a comprobar', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const { batchDeps } = await import('../src/services/batchRunner.ts');
  const real = batchDeps.runStory; let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  // La primera historia «trabaja» hasta que la soltamos y termina verificada (sin llamadas); mientras, el propietario
  // retira la autorización del proyecto. La siguiente usa el pipeline real.
  batchDeps.runStory = (async (_slug: string, pid: string) => {
    batchDeps.runStory = real; await gate;
    const pr = processesRepo(S).get(pid)!;
    processesRepo(S).setResult(pid, { ...pr.result!, pipeline: { ...pr.result!.pipeline!, state: 'verified' } });
    processesRepo(S).finish(pid, 'done');
  }) as any;
  try {
    const a = story('Historia PERMISO-1'); const c = story('Historia PERMISO-2');
    const b = await authorize([a.id, c.id]);
    await waitFor(() => get(b.id), y => y.items[0].state === 'running', 'la primera empieza');
    await authorizeProject(false);
    const before = processesRepo(S).list(project.id).length;
    release();
    const x = await waitFor(() => get(b.id), y => y.status === 'paused', 'el lote se pausa');
    assert.equal(x.items[1].state, 'queued', 'la segunda sigue en cola: nada se canceló'); assert.match(x.items[1].reason, /^No ha empezado: /);
    assert.match(x.reason, /no está autorizado para Claude Code/); assert.equal(x.reasonFix.href, '/configuracion/proveedor#claude-code');
    assert.equal((x.reason.match(/no está autorizado/g) ?? []).length, 1, 'el motivo, una vez');
    assert.equal(processesRepo(S).list(project.id).length, before, 'no se creó el proceso de la segunda');
    await authorizeProject(true);
    assert.equal((await inject('POST', `${W}/batches/${b.id}/resume`, { authorized: true })).statusCode, 200);
    const z = await waitFor(() => get(b.id), y => y.items.every((i: any) => !['queued', 'running', 'waiting_dependency', 'integrating'].includes(i.state)), 'ambas terminan');
    assert.ok(z.items.every((i: any) => i.state === 'awaiting_integration'), z.items.map((i: any) => `${i.state}: ${i.reason}`).join(' | '));
    assert.equal(z.reasonFix ?? null, null);
    await close(b.id);
  } finally { batchDeps.runStory = real; await authorizeProject(true); }
});

test('sin «Integrar en main», la dependiente del lote espera a que integres tú: la vista previa lo dice y el lote, al quedarse sin nada que hacer, «espera tu decisión»', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const a = story('Historia BASE-MANUAL');
  const c = story('Historia DEPENDIENTE-MANUAL'); backlogRepo(S).update(c.id, { dependsOn: a.storyId });
  const p = await preview([a.id, c.id]);
  assert.deepEqual(p.summary.waitForManualIntegration, [c.storyId]);
  assert.ok(p.warnings.some((w: string) => /esperarán a que integres tú su dependencia/.test(w)));
  assert.deepEqual((await preview([a.id, c.id], { git: { merge: true } })).summary.waitForManualIntegration, [], 'con integrar, no espera');
  const b = await authorize([a.id, c.id]);
  const x = await waitFor(() => get(b.id), y => /esperan tu decisión/.test(y.reason ?? ''), 'espera tu decisión');
  assert.equal(x.items.find((i: any) => i.storyId === a.storyId).state, 'awaiting_integration');
  assert.equal(x.items.find((i: any) => i.storyId === c.storyId).state, 'waiting_dependency');
  assert.match(x.reason, new RegExp(`${c.storyId} \\(espera a ${a.storyId}\\)`));
  await close(b.id);
});

test('límites: la vista previa dice cuántas caben antes de que el tope de llamadas o el presupuesto pausen el lote; el tope admite lotes grandes', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const ids = Array.from({ length: 12 }, (_, i) => story(`Historia LIMITE ${i}`).id);
  const p = await preview(ids, { maxSubscriptionCalls: 10 });
  assert.equal(p.summary.executable, 12);
  assert.ok(p.summary.fits.max < 12 && p.summary.fits.min <= p.summary.fits.max && p.summary.fits.limitedBy.includes('subscription'), JSON.stringify(p.summary.fits));
  assert.ok(p.warnings.some((w: string) => /el lote se pausará tras ≈/.test(w)));
  const big = await preview(ids, { maxSubscriptionCalls: p.summary.subscriptionCalls.max });
  assert.equal(big.summary.fits.min, 12, 'con el tope en el máximo estimado caben todas'); assert.equal(big.auth.maxSubscriptionCalls, p.summary.subscriptionCalls.max);
  assert.equal((await preview(ids, { maxSubscriptionCalls: 5000 })).auth.maxSubscriptionCalls, 5000, 'cabe el peor caso de 200 historias con correcciones');
  // El coste de API también tiene su rango con las correcciones autorizadas.
  await setBackends('api');
  const api = await preview(ids.slice(0, 2), { backends: ['api'], maxCorrections: 3 });
  assert.ok(api.summary.apiUsd.max > api.summary.apiUsd.min && api.plan[0].estimatedUsdMax > api.plan[0].estimatedUsd);
});

test('duración: solo cuenta historias que terminaron verificadas (de al menos 1 minuto); sin 5 así, no se estima', async () => {
  await setBackends('claude-code');
  const fake = (verified: boolean, min: number) => {
    const p = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'histórico', estimatedUsd: 0, backlogItemId: null, steps: [] } as any);
    processesRepo(S).setResult(p.id, { plan: null, implementationSummary: null, changes: [], verifyCommands: [], review: null, applied: null, verifications: [], pipeline: { state: verified ? 'verified' : 'paused' } } as any);
    const end = new Date(); const start = new Date(end.getTime() - min * 60_000);
    workspaceDb(S).prepare('UPDATE processes SET status = ?, started_at = ?, finished_at = ? WHERE id = ?').run('done', start.toISOString(), end.toISOString(), p.id);
  };
  for (let i = 0; i < 6; i++) fake(false, 0.2);
  for (let i = 0; i < 4; i++) fake(true, 10 + i);
  const a = story('Historia DURACION');
  assert.equal((await preview([a.id])).summary.duration, null, 'las detenidas no cuentan: solo hay 4 verificadas');
  fake(true, 0.5); assert.equal((await preview([a.id])).summary.duration, null, 'menos de 1 minuto no cuenta');
  fake(true, 20);
  const d = (await preview([a.id])).summary.duration;
  assert.equal(d.samples, 5); assert.equal(d.perStoryMinutes, 12); assert.ok(d.p25 <= d.perStoryMinutes && d.perStoryMinutes <= d.p75);
  // La duración máxima también cuenta en «caben»: con ~12 min por historia y 15 min de margen, empiezan 2 de 3.
  const three = [a.id, story('Historia DURACION-2').id, story('Historia DURACION-3').id];
  const lim = await preview(three, { maxDurationMin: 15 });
  assert.equal(lim.summary.fits.max, 2); assert.ok(lim.summary.fits.limitedBy.includes('duration'), JSON.stringify(lim.summary.fits));
  assert.ok(lim.warnings.some((w: string) => /duración máxima del lote/.test(w)));
  assert.equal((await preview(three, { maxDurationMin: 240 })).summary.fits.max, 3);
});

test('agente solo API: exige la API autorizada en el lote (se explica qué agente y dónde cambiarlo)', async () => {
  await setBackends('api'); apiScript();
  const a = story('Historia SOLO-API');
  const p = await preview([a.id], { backends: ['claude_code'] });
  assert.equal(p.plan[0].executable, false); assert.deepEqual(p.plan[0].disallowedBackends, ['api']);
  const t = p.plan[0].team[0];
  assert.match(t.problem, /usa Anthropic API \(facturable\) y este lote no autoriza la API/); assert.equal(t.fix.href, `/equipo/${t.agentId}`);
  assert.equal(p.summary.subscriptionCalls.max, 0); assert.ok(p.estimateUsd === 0 && p.plan[0].estimatedUsd > 0, 'el total solo cuenta lo que empezará');
  const ok = await preview([a.id], { backends: ['api'] });
  assert.equal(ok.plan[0].executable, true); assert.ok(ok.estimateUsd > 0); assert.equal(ok.summary.subscriptionCalls.max, 0);
});

test('equipo mixto (Desarrollador y QA en Claude Code, el resto en la API): cada origen se evalúa por agente, también al ejecutar', async () => {
  await setBackends('api'); ccRules(); apiScript();
  const a = story('Historia MIXTA');
  const team0 = (await preview([a.id])).plan[0].team;
  const dev = team0.find((t: any) => t.roles.includes('implementer')).agentId; const qa = team0.find((t: any) => t.roles.includes('reviewer')).agentId;
  await setBackends('claude-code', ag => (ag as any).id === dev || (ag as any).id === qa);
  const both = await preview([a.id], { backends: ['api', 'claude_code'] });
  const s = both.plan[0];
  assert.equal(s.executable, true); assert.deepEqual([...s.backends].sort(), ['api', 'claude_code']);
  assert.equal(s.subscriptionCalls.min, 2, 'Desarrollador y QA, una llamada cada uno sin correcciones');
  assert.ok(s.calls.min > s.subscriptionCalls.min, 'el resto del equipo va por la API');
  assert.ok(s.estimatedUsd > 0 && s.estimatedUsd < (await preview([a.id], { backends: ['api', 'claude_code'] })).plan[0].calls.max * 10);
  const onlyCc = await preview([a.id], { backends: ['claude_code'] });
  assert.equal(onlyCc.plan[0].executable, false);
  assert.ok(onlyCc.plan[0].problems.length >= 1 && onlyCc.plan[0].problems.every((m: string) => /este lote no autoriza la API/.test(m)));
  assert.ok(!onlyCc.plan[0].team.filter((t: any) => t.source === 'claude_code').some((t: any) => !t.ready), 'los de Claude Code sí pueden');
  const b = await authorize([a.id], { backends: ['api', 'claude_code'] });
  const x = await waitFor(() => get(b.id), settledItem, 'termina');
  assert.equal(x.items[0].state, 'awaiting_integration', x.items[0].reason);
  assert.ok(apiCalls().some(c => c.rule === R.plan), 'el Coordinador por la API');
  assert.ok(!apiCalls().some(c => c.rule === R.dev || c.rule === R.qa), 'Desarrollador y QA nunca por la API');
  assert.ok(ccRuns().length >= 2);
  await close(b.id);
});

test('alternativa por API: desactivada en el lote, Claude Code sin cuota pausa y NO llama a la API aunque el conector lo permita; solo cede si el lote lo autoriza', async () => {
  await setBackends('claude-code'); apiScript(); ccRules({ behavior: 'limit' });
  assert.equal((await inject('PUT', '/api/claude-code/settings', { fallback: 'api', authorized: true })).statusCode, 200);
  try {
    const a = story('Historia SIN-CUOTA');
    const p = await preview([a.id]);
    assert.equal(p.auth.apiFallback, false, 'desactivada por defecto'); assert.equal(p.summary.worstCaseUsd, 0, 'sin alternativa no hay coste de API posible');
    const b = await authorize([a.id]);
    const x = await waitFor(() => get(b.id), y => y.items[0].state !== 'running' && y.items[0].state !== 'queued', 'se detiene');
    assert.equal(x.items[0].state, "needs_owner", `${x.items[0].state} · ${x.items[0].failureClass} · ${x.items[0].reason}`); assert.equal(x.items[0].failureClass, "subscription"); assert.equal(x.status, "paused");
    assert.equal(apiCalls().length, 0, 'ninguna llamada a la API');
    assert.equal(processesRepo(S).get(x.items[0].processId)!.result!.pipeline!.config.apiFallback, false);
    await close(b.id);

    const c = story('Historia CON-ALTERNATIVA');
    const q = await preview([c.id], { apiFallback: true, backends: ['api', 'claude_code'] });
    assert.equal(q.auth.apiFallback, true); assert.equal(q.estimateUsd, 0, 'con la suscripción disponible no se cobra API');
    assert.ok(q.summary.worstCaseUsd > 0, 'pero el peor caso (si cede) sí tiene coste de API: no es «gratis garantizado»');
    assert.equal((await preview([c.id], { apiFallback: true, backends: ['claude_code'] })).auth.apiFallback, false, 'sin la API autorizada no hay alternativa');
    const b2 = await authorize([c.id], { apiFallback: true, backends: ['api', 'claude_code'] });
    const y = await waitFor(() => get(b2.id), settledItem, 'termina con la alternativa');
    assert.equal(y.items[0].state, 'awaiting_integration', y.items[0].reason);
    assert.ok(apiCalls().some(c => c.rule === R.dev), 'cedió a la API porque el lote lo autorizó');
    await close(b2.id);
  } finally { assert.equal((await inject('PUT', '/api/claude-code/settings', { fallback: 'none' })).statusCode, 200); ccRules(); }
});

test('consola de Claude Code sin conectar: no empieza; el arreglo apunta al agente (pasarlo a gestionado)', async () => {
  await setBackends('api'); apiScript();
  const a = story('Historia CONSOLA');
  const dev = (await preview([a.id])).plan[0].team.find((t: any) => t.roles.includes('implementer')).agentId;
  assert.equal((await inject('PUT', `${W}/agents/${dev}/backend`, { backend: 'claude-code-terminal', authorized: true })).statusCode, 200);
  const p = await preview([a.id]);
  const t = p.plan[0].team.find((x: any) => x.agentId === dev);
  assert.equal(t.source, 'claude_code', 'la consola es el origen «suscripción de Claude Code»'); assert.equal(t.allowed, true); assert.equal(t.ready, false);
  assert.match(t.problem, /consola/); assert.equal(t.fix.href, `/equipo/${dev}`);
  await setBackends('api');
});

test('valores seguros: integrar, activar y publicar desactivados salvo que se marquen; activar y publicar exigen integrar; un lote nuevo no hereda nada', async () => {
  await setBackends('api'); apiScript();
  const a = story('Historia DEFECTOS');
  const p = await preview([a.id]);
  assert.deepEqual(p.auth.git, { merge: false, activate: false, publish: false }); assert.equal(p.auth.apiFallback, false);
  assert.deepEqual((await preview([a.id], { git: { activate: true, publish: true } })).auth.git, { merge: false, activate: false, publish: false }, 'sin integrar no se activa ni se publica');
  const b = await authorize([a.id], { git: { merge: true, publish: true }, title: 'Lote con publicación', backends: ['api'] });
  assert.equal(b.auth.git.publish, true);
  await close(b.id);
  const next = await preview([story('Historia DEFECTOS-2').id]);
  assert.deepEqual(next.auth.git, { merge: false, activate: false, publish: false }, 'el lote anterior no autoriza el siguiente');
  assert.equal((await get(b.id)).auth.git.publish, true, 'y el anterior conserva su propio alcance');
});

test('tamaño: hasta 200 historias por lote; más se rechaza con un motivo claro (nunca se recorta en silencio)', async () => {
  const r = await inject('POST', `${W}/projects/${project.id}/batches/preview`, body(Array.from({ length: 201 }, (_, i) => `x-${i}`)));
  assert.equal(r.statusCode, 400);
});

test('escala: la vista previa de 200 historias es correcta y rápida, sin llamadas de IA (dependencias que faltan propuestas, no añadidas)', async () => {
  await setBackends('claude-code'); ccRules(); apiScript();
  const ids: string[] = []; const all: any[] = [];
  for (let i = 0; i < 210; i++) { const s = story(`Historia ESCALA ${i}`); all.push(s); }
  // Cada décima depende de la anterior, que NO se selecciona: dependencia que falta, nunca añadida sola.
  for (let i = 0; i < 200; i++) ids.push(all[i].id);
  for (let i = 10; i < 200; i += 10) backlogRepo(S).update(all[i].id, { dependsOn: all[200 + (i / 10) % 10].storyId });
  const t = performance.now(); const p = await preview(ids); const ms = performance.now() - t;
  assert.equal(p.plan.length, 200); assert.deepEqual(p.auth.itemIds, ids, 'el alcance es exactamente lo elegido');
  assert.equal(p.summary.blockedByDependency, 19); assert.equal(p.summary.executable, 181);
  assert.ok(p.summary.missingDependencies.length >= 1 && p.summary.missingDependencies.every((m: any) => m.eligible && !ids.includes(m.itemId)));
  assert.ok(p.summary.subscriptionCalls.min >= 181 * 3, 'cada historia cuenta sus llamadas a la suscripción');
  assert.ok(ms < 3000, `vista previa de 200 en ${ms.toFixed(0)} ms`);
  assert.equal(ccRuns().length + apiCalls().length, 0, 'ninguna llamada de IA');
});

test('origen por defecto: sin orígenes indicados, solo la suscripción (la API facturable exige marcarla)', async () => {
  await setBackends('api');
  const p = await preview([story('Historia ORIGEN-DEFECTO').id]);
  assert.deepEqual(p.auth.backends, ['claude_code']);
  assert.equal(p.plan[0].executable, false, 'un equipo en la API no empieza sin la API marcada');
  assert.match(p.plan[0].problems[0], /este lote no autoriza la API/);
});

test('volver tras una interrupción: el límite de la suscripción en el primer paso pausa todo el lote; «Reintentar» (con autorización) y «Reanudar» lo vuelven a poner en cola sin cambiar el alcance; cancelar cierra lo que esperaba', async () => {
  await setBackends('claude-code'); apiScript(); ccRules({ behavior: 'limit' });
  const a = story('Historia VUELTA-1'); const c = story('Historia VUELTA-2');
  const b = await authorize([a.id, c.id]);
  const p = await waitFor(() => get(b.id), w => w.status === 'paused', 'el lote se pausa');
  assert.equal(p.items[0].failureClass, 'subscription'); assert.equal(p.items[0].state, 'needs_owner');
  assert.equal(p.items[1].state, 'queued', 'la otra no empieza mientras el límite está agotado');
  assert.ok(p.events.some((ev: any) => /se detuvo \(subscription\)/.test(ev.message)) && !p.events.some((ev: any) => /falló/.test(ev.message)), 'el registro dice lo mismo que el estado');
  const url = `${W}/batches/${b.id}/items/${p.items[0].itemId}/retry`;
  assert.equal((await inject('POST', url, {})).statusCode, 400, 'reintentar exige autorización');
  const r = await inject('POST', url, { authorized: true });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().items[0].state, 'queued'); assert.match(r.json().items[0].reason, /empezará al reanudar/);
  ccRules(); // el límite se renovó
  assert.equal((await inject('POST', `${W}/batches/${b.id}/resume`, { authorized: true })).statusCode, 200);
  const z = await waitFor(() => get(b.id), w => w.items.every((i: any) => i.state === 'awaiting_integration'), 'ambas terminan tras renovarse el límite');
  assert.deepEqual(z.auth.itemIds, b.auth.itemIds); assert.deepEqual(z.auth.git, b.auth.git); assert.deepEqual(z.auth.backends, b.auth.backends);
  assert.equal(apiCalls().length, 0, 'nunca se usó la API');
  assert.equal((await inject('POST', url, { authorized: true })).statusCode, 409, 'una terminada no se reintenta');
  await close(b.id);

  // Sin «Reintentar»: «Reanudar» también vuelve a poner en cola la que se detuvo sin trabajo que conservar.
  ccRules({ behavior: 'limit' });
  const d = story('Historia VUELTA-3');
  const b2 = await authorize([d.id]);
  await waitFor(() => get(b2.id), w => w.status === 'paused', 'se pausa');
  ccRules();
  assert.equal((await inject('POST', `${W}/batches/${b2.id}/resume`, { authorized: true })).statusCode, 200);
  await waitFor(() => get(b2.id), w => w.items[0].state === 'awaiting_integration', 'termina al reanudar');
  await close(b2.id);

  // Cancelar cierra lo que esperaba tu decisión (con su motivo).
  ccRules({ behavior: 'limit' });
  const f = story('Historia VUELTA-4');
  const b3 = await authorize([f.id]);
  await waitFor(() => get(b3.id), w => w.status === 'paused', 'se pausa');
  const cancelled = (await inject('POST', `${W}/batches/${b3.id}/cancel`, {})).json();
  assert.equal(cancelled.items[0].state, 'cancelled'); assert.match(cancelled.items[0].reason, /mientras esperaba tu decisión/);
  ccRules();
});

test('el origen autorizado se respeta en CADA llamada: un agente cambiado a la API a mitad de la historia no llama; el lote se pausa con el motivo', async () => {
  await setBackends('claude-code'); apiScript(); ccRules({ slowMs: 400 });
  const a = story('Historia CAMBIO-ORIGEN');
  const qa = (await preview([a.id])).plan[0].team.find((t: any) => t.roles.includes('reviewer')).agentId;
  try {
    const b = await authorize([a.id]);
    assert.deepEqual(b.auth.backends, ['claude_code']);
    await waitFor(() => get(b.id), y => y.items[0].state === 'running', 'empieza');
    assert.equal((await inject('PUT', `${W}/agents/${qa}/backend`, { backend: 'api', authorized: true })).statusCode, 200);
    const x = await waitFor(() => get(b.id), y => y.status === 'paused', 'el lote se pausa');
    assert.equal(x.items[0].state, 'needs_owner'); assert.match(x.reason, /no autoriza ese origen: no se ha hecho la llamada/);
    assert.equal(apiCalls().length, 0, 'ninguna llamada facturable');
    assert.equal(x.budget.spent, 0);
    await close(b.id);
  } finally { assert.equal((await inject('PUT', `${W}/agents/${qa}/backend`, { backend: 'claude-code', authorized: true })).statusCode, 200); ccRules(); }
});

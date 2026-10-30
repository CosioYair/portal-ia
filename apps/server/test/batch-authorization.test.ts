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
const { agentsRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
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
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what} · ${JSON.stringify(v).slice(0, 1500)}`); await new Promise(r => setTimeout(r, 50)); v = await fn(); }
  return v;
}
const settledItem = (b: any) => !['queued', 'waiting_dependency', 'running', 'integrating'].includes(b.items[0].state);
const close = async (id: string) => { await inject('POST', `${W}/batches/${id}/cancel`); };

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

test('proyecto sin autorizar para Claude Code: la vista previa lo bloquea con el motivo y dónde corregirlo; la ejecución real dice lo mismo y no llama a nada', async () => {
  await setBackends('claude-code'); ccRules(); apiScript(); await authorizeProject(false);
  try {
    const a = story('Historia CC-SIN-PROYECTO');
    const p = await preview([a.id]);
    const s = p.plan[0];
    assert.equal(s.executable, false); assert.equal(p.summary.blockedByPermission, 1); assert.equal(p.summary.executable, 0);
    assert.ok(s.team.length >= 3 && s.team.every((t: any) => t.source === 'claude_code' && t.allowed && !t.ready));
    assert.match(s.problems[0], /no está autorizado para Claude Code/);
    assert.equal(s.team[0].fix.href, '/configuracion/proveedor#claude-code');
    assert.deepEqual(s.disallowedBackends, [], 'el origen sí está autorizado en el lote: falta el proyecto');
    const b = await authorize([a.id]);
    const x = await waitFor(() => get(b.id), y => y.items[0].state === 'needs_owner', 'no empieza');
    assert.ok(x.items[0].reason.includes(s.problems[0]), `misma explicación que la vista previa: ${x.items[0].reason}`);
    assert.equal(ccRuns().length, 0); assert.equal(apiCalls().length, 0, 'ninguna llamada');
    assert.equal(processesRepo(S).get(x.items[0].processId)!.status, 'cancelled', 'el proceso preparado queda cancelado con el motivo');
    await close(b.id);
  } finally { await authorizeProject(true); }
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
  const b = await authorize([a.id], { git: { merge: true, publish: true }, title: 'Lote con publicación' });
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

test('origen por defecto: sin orígenes indicados, solo la suscripción (la API facturable exige marcarla)', async () => {
  await setBackends('api');
  const p = await preview([story('Historia ORIGEN-DEFECTO').id]);
  assert.deepEqual(p.auth.backends, ['claude_code']);
  assert.equal(p.plan[0].executable, false, 'un equipo en la API no empieza sin la API marcada');
  assert.match(p.plan[0].problems[0], /este lote no autoriza la API/);
});

test('volver tras una interrupción: reintentar una historia que no empezó, reanudar re-encola las que no trabajaron, el alcance no cambia; cancelar cierra lo que esperaba', async () => {
  await setBackends('claude-code'); ccRules(); apiScript(); await authorizeProject(false);
  const a = story('Historia VUELTA-1'); const c = story('Historia VUELTA-2');
  const b = await authorize([a.id, c.id], { git: { merge: false } });
  const x = await waitFor(() => get(b.id), y => y.items.every((i: any) => i.state === 'needs_owner'), 'ninguna empieza');
  assert.ok(x.items.every((i: any) => i.notStarted && /no está autorizado para Claude Code/.test(i.reason)));
  await authorizeProject(true);
  const url = (i: any) => `${W}/batches/${b.id}/items/${i.itemId}/retry`;
  assert.equal((await inject('POST', url(x.items[0]), {})).statusCode, 400, 'reintentar exige autorización');
  const r = await inject('POST', url(x.items[0]), { authorized: true });
  assert.equal(r.statusCode, 200, r.body);
  const y = await waitFor(() => get(b.id), z => z.items[0].state === 'awaiting_integration', 'la reintentada termina');
  assert.equal(y.items[1].state, 'needs_owner', 'la otra sigue esperando: nada se re-encola solo');
  // Reanudar (tras pausar) vuelve a poner en cola la que no llegó a empezar; el alcance autorizado no cambia.
  assert.equal((await inject('POST', `${W}/batches/${b.id}/pause`, {})).statusCode, 200);
  assert.equal((await inject('POST', `${W}/batches/${b.id}/resume`, { authorized: true })).statusCode, 200);
  const z = await waitFor(() => get(b.id), w => w.items[1].state === 'awaiting_integration', 'la segunda termina al reanudar');
  assert.deepEqual(z.auth.itemIds, b.auth.itemIds); assert.deepEqual(z.auth.git, b.auth.git); assert.deepEqual(z.auth.backends, b.auth.backends);
  // Una con trabajo en pausa no se «reintenta» (se continúa desde su proceso): aquí ya terminó.
  assert.equal((await inject('POST', url(z.items[0]), { authorized: true })).statusCode, 409);
  await close(b.id);

  // Límite de la suscripción en el primer paso: pausa TODO el lote; al reanudar (límite renovado) vuelve a la cola.
  ccRules({ behavior: 'limit' });
  const d = story('Historia VUELTA-3'); const e = story('Historia VUELTA-4');
  const b2 = await authorize([d.id, e.id]);
  const p2 = await waitFor(() => get(b2.id), w => w.status === 'paused', 'el lote se pausa');
  assert.equal(p2.items[0].failureClass, 'subscription'); assert.equal(p2.items[0].state, 'needs_owner');
  assert.equal(p2.items[1].state, 'queued', 'la otra no empieza mientras el límite está agotado');
  ccRules();
  assert.equal((await inject('POST', `${W}/batches/${b2.id}/resume`, { authorized: true })).statusCode, 200);
  const q2 = await waitFor(() => get(b2.id), w => w.items.every((i: any) => i.state === 'awaiting_integration'), 'ambas terminan tras renovarse el límite');
  assert.equal(apiCalls().length, 0, 'nunca se usó la API');
  await close(b2.id);
  assert.ok(q2.items.every((i: any) => i.processIds.length >= 1));

  // Cancelar cierra lo que esperaba tu decisión (con su motivo); lo terminado se conserva.
  await authorizeProject(false);
  const f = story('Historia VUELTA-5');
  const b3 = await authorize([f.id]);
  await waitFor(() => get(b3.id), w => w.items[0].state === 'needs_owner', 'espera');
  const cancelled = (await inject('POST', `${W}/batches/${b3.id}/cancel`, {})).json();
  assert.equal(cancelled.items[0].state, 'cancelled'); assert.match(cancelled.items[0].reason, /mientras esperaba tu decisión/);
  await authorizeProject(true);
});

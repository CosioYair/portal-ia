import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Ejecución continua del backlog (lote autorizado). Proveedor SIMULADO (0 USD), sandbox determinista sustituido en la
 * prueba, activación y comprobación en ejecución sustituidas (nunca reinicia nada real), datos y repositorio
 * sintéticos. Escenarios del encargo: F autorización y revocación · G progresión automática · H orden por dependencias ·
 * I worktrees concurrentes · J integración serializada · K recuperación tras reinicio (con y sin cobro incierto) ·
 * L presupuesto agotado · M límite de la suscripción · N fallo parcial · O aceptación del propietario tras la
 * terminación técnica · P iteración dirigida de una historia · Q permisos (orígenes) y aislamiento por proyecto.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-batch-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, planBatch, batchBudget, classifyStop } = await import('@portal-ia/domain');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, backlogRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { callMetricsRepo } = await import('../src/db/callMetrics.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { batchDeps, resumeBatches, scheduleTick, stopBatchScheduler } = await import('../src/services/batchRunner.ts');
const { recoverInterruptedProcesses } = await import('../src/services/interruptions.ts');
const { threadRepo } = await import('../src/services/storyThread.ts');
const { abortProcessCalls } = await import('../src/services/providerCalls.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;

// ---------- Unidades (sin IA, sin E/S) ----------
test('H · plan determinista: dependencias primero (a igualdad, tu orden), oleadas independientes, ciclos y dependencias externas bloqueadas', () => {
  const s = (storyId: string, dependsOn: string | null = null, status: any = 'pending') => ({ id: `id-${storyId}`, storyId, title: storyId, dependsOn, status });
  const backlog = [s('HU-1'), s('HU-2', 'HU-1'), s('HU-3'), s('HU-4', 'HU-9'), s('HU-9'), s('HU-5', 'HU-6'), s('HU-6', 'HU-5'), s('HU-7', 'HU-8', 'pending'), s('HU-8', null, 'done'), s('HU-10', 'HU-4')];
  const plan = planBatch([s('HU-2', 'HU-1'), s('HU-3'), s('HU-1'), s('HU-4', 'HU-9'), s('HU-5', 'HU-6'), s('HU-6', 'HU-5'), s('HU-7', 'HU-8'), s('HU-10', 'HU-4')], backlog);
  const by = Object.fromEntries(plan.map(p => [p.storyId, p]));
  assert.ok(by['HU-1'].order < by['HU-2'].order, 'la dependencia va antes aunque la elegiste después');
  assert.equal(by['HU-2'].wave, 1); assert.equal(by['HU-1'].wave, 0); assert.equal(by['HU-3'].wave, 0, 'independientes en la misma oleada');
  assert.ok(by['HU-2'].dependsInBatch);
  assert.match(by['HU-4'].blockedReason!, /HU-9.*no está terminada ni en el lote/);
  assert.match(by['HU-10'].blockedReason!, /HU-4, que está bloqueada/, 'el bloqueo se encadena con su motivo');
  assert.match(by['HU-5'].blockedReason!, /Ciclo/); assert.match(by['HU-6'].blockedReason!, /Ciclo/);
  assert.equal(by['HU-7'].blockedReason, null, 'una dependencia terminada fuera del lote no bloquea');
});

test('L · presupuesto del lote: lo gastado + lo no confirmado + lo reservado; solo empieza otra si cabe su tope completo', () => {
  const auth = { totalBudgetUsd: 1, perStoryBudgetUsd: 0.4 };
  assert.equal(batchBudget(auth, []).canStart, true);
  const b = batchBudget(auth, [{ spentUsd: 0.1, unconfirmedUsd: 0.05, budgetUsd: 0.4, running: false }, { spentUsd: 0.1, unconfirmedUsd: 0, budgetUsd: 0.4, running: true }]);
  assert.equal(b.spent, 0.25); assert.equal(b.reserved, 0.3); assert.equal(b.remaining, 0.45); assert.equal(b.canStart, true);
  assert.equal(batchBudget(auth, [{ spentUsd: 0.3, unconfirmedUsd: 0, budgetUsd: 0.4, running: false }, { spentUsd: 0, unconfirmedUsd: 0, budgetUsd: 0.4, running: true }]).canStart, false);
  assert.deepEqual(classifyStop('subscription_limit', 'done'), { cls: 'subscription', batchWide: true });
  assert.deepEqual(classifyStop('gauntlet', 'done'), { cls: 'owner_decision', batchWide: false });
  assert.deepEqual(classifyStop(null, 'failed'), { cls: 'failure', batchWide: false });
});

// ---------- Entorno ----------
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-batch-repo-'));
const uniq = `batch-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/base.ts'), 'export const base = 0;\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node -e ""', test: 'node -e ""', build: 'node -e ""' } }, null, 2));
fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: uniq, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.0' } } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { stopBatchScheduler(); await app.close(); });

// Sandbox determinista con instrumentación: concurrencia observada y «reinicio» durante una verificación.
let active = 0; let maxActive = 0; let hangOn: { file: string; entered: () => void } | null = null;
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (wt, _root, command) => {
  const t = new Date().toISOString();
  if (hangOn && command === 'test' && fs.existsSync(path.join(wt, hangOn.file))) { const h = hangOn; hangOn = null; h.entered(); return new Promise(() => { /* el Portal «se reinicia» aquí */ }); }
  active++; maxActive = Math.max(maxActive, active);
  await new Promise(r => setTimeout(r, 40));
  active--;
  return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 40, isolation: 'docker' };
};
// Activación y comprobación en ejecución sustituidas: nunca se reinicia nada real.
let activations = 0;
batchDeps.activate = async () => { activations++; };
batchDeps.activation = async () => ({ active: true, runningCommit: 'x', buildCommit: 'x', buildAt: new Date().toISOString(), reason: 'simulado' });
batchDeps.runtimeChecks = async (_pid, checks) => checks.map(check => ({ check, status: 'ok' as const, detail: 'ok', at: new Date().toISOString() }));
const realRunStory = batchDeps.runStory;

const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple; verificación en verde.', findings: [], suggestedTests: [] });
const plan = (file: string) => JSON.stringify({ summary: `Crear ${file}`, tasks: [`Crear ${file}`], filesToRead: [], filesToChange: [file], acceptance: [`${file} existe`], risks: [] });
const create = (file: string, content: string) => `=== RESUMEN ===\nCrea ${file}.\n=== ARCHIVO: ${file} | create ===\n${content}\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre ${file}. Esperado: existe.\n2. Revisa el valor. Esperado: correcto.`;
const patch = (file: string, from: string, to: string) => `=== RESUMEN ===\nCambia ${file}.\n=== ARCHIVO: ${file} | patch ===\n<<<< BUSCAR\n${from}\n==== REEMPLAZAR\n${to}\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre ${file}. Esperado: cambiado.`;
type Rule = Record<string, unknown>;
/** Reglas por historia (la clave va en el título, que aparece en el sistema de cada llamada). */
function setScript(stories: { key: string; file: string; dev: string | string[]; qa?: Rule }[], extra: Rule[] = []) {
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  const rules: Rule[] = [...extra];
  for (const s of stories) {
    rules.push({ match: `${s.key}.*Elabora el plan técnico`, text: plan(s.file) });
    if (s.qa) rules.push({ match: `${s.key}.*Evalúa la implementación con la EVIDENCIA real`, ...s.qa });
    rules.push({ match: `${s.key}.*Implementa la historia`, ...(Array.isArray(s.dev) ? { responses: s.dev.map(text => ({ text })) } : { text: s.dev }) });
  }
  rules.push({ match: 'Evalúa la implementación con la EVIDENCIA real', text: QA_OK });
  fs.writeFileSync(scriptPath, JSON.stringify({ rules, markers: [] }));
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const callsFor = (key: string) => calls().filter(c => typeof c.rule === 'string' && c.rule.startsWith(`${key}.*`));
const story = (title: string, dependsOn?: string) => { const it = addManualItem(S, project.id, { title, criterion: 'el archivo existe' }); if (dependsOn) backlogRepo(S).update(it.id, { dependsOn }); return backlogRepo(S).get(it.id)!; };
const get = async (id: string) => (await app.inject({ method: 'GET', url: `${W}/batches/${id}` })).json();
async function waitFor<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what} · ${JSON.stringify(v).slice(0, 1500)}`); await new Promise(r => setTimeout(r, 50)); v = await fn(); }
  return v;
}
const settled = (b: any) => !b.items.some((i: any) => ['queued', 'waiting_dependency', 'running', 'integrating'].includes(i.state));
const authorize = async (body: Record<string, unknown>) => {
  const res = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches`, payload: { authorized: true, totalBudgetUsd: 5, perStoryBudgetUsd: 1, maxCorrections: 1, commands: ['typecheck', 'test', 'build'], git: { merge: true }, ...body } });
  assert.equal(res.statusCode, 201, res.body); return res.json();
};
const mainLog = () => execSync('git log --first-parent --format=%s main', { cwd: repo, encoding: 'utf8' }).trim().split('\n');

test('F · la autorización es explícita, persistida y auditable; un lote activo por proyecto; vista previa sin IA', async () => {
  const a = story('Historia FOXTROT');
  setScript([{ key: 'FOXTROT', file: 'src/foxtrot.ts', dev: create('src/foxtrot.ts', 'export const foxtrot = 1;') }]);
  const denied = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches`, payload: { itemIds: [a.id], totalBudgetUsd: 2, perStoryBudgetUsd: 1 } });
  assert.equal(denied.statusCode, 400); assert.equal(denied.json().code, 'authorization_required');
  const prev = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches/preview`, payload: { itemIds: [a.id], totalBudgetUsd: 2, perStoryBudgetUsd: 1, gauntlet: { mode: 'standard' } } });
  assert.equal(prev.statusCode, 200, prev.body);
  assert.equal(prev.json().plan.length, 1); assert.ok(prev.json().estimateUsd > 0); assert.equal(prev.json().auth.git.publish, false, 'publicar desactivado por defecto');
  assert.ok(prev.json().warnings.some((w: string) => /sin Evaluador/.test(w)));
  assert.equal(calls().length, 0, 'la vista previa no llama a la IA');
  const b = await authorize({ itemIds: [a.id], title: 'Lote F' });
  assert.equal(b.status, 'running'); assert.match(b.events[0].message, /Autorizado por el propietario: 1 historia\(s\) · 5 USD en total \(máx\. 1 por historia\)/);
  assert.equal(b.auth.git.publish, false);
  const second = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches`, payload: { authorized: true, itemIds: [story('Otra F').id], totalBudgetUsd: 1, perStoryBudgetUsd: 1 } });
  assert.equal(second.statusCode, 409); assert.equal(second.json().code, 'batch_active');
  const done = await waitFor(() => get(b.id), x => x.status === 'completed', 'lote F completado');
  assert.equal(done.items[0].state, 'awaiting_acceptance', done.items[0].reason);
  const audit = (await import('../src/db/workspace.ts')).workspaceDb(S).prepare(`SELECT kind FROM execution_history WHERE kind LIKE 'batch_%'`).all() as any[];
  assert.ok(audit.some(r => r.kind === `batch_authorized:${b.id}`) && audit.some(r => r.kind === `batch_story_started:${b.id}`));
});

test('G + J · progresión automática sin intervención: cada historia se ejecuta, se integra de una en una y queda para tu aceptación', async () => {
  const a = story('Historia GOLF1'); const c = story('Historia GOLF2'); const d = story('Historia GOLF3');
  setScript([1, 2, 3].map(n => ({ key: `GOLF${n}`, file: `src/golf${n}.ts`, dev: create(`src/golf${n}.ts`, `export const golf${n} = ${n};`) })));
  const before = mainLog().length;
  const b = await authorize({ itemIds: [a.id, c.id, d.id], title: 'Lote G' });
  const done = await waitFor(() => get(b.id), x => x.status === 'completed', 'lote G completado');
  assert.deepEqual(done.items.map((i: any) => i.state), ['awaiting_acceptance', 'awaiting_acceptance', 'awaiting_acceptance']);
  assert.equal(mainLog().length - before, 3, 'tres integraciones en main');
  for (const n of [1, 2, 3]) assert.equal(fs.readFileSync(path.join(repo, `src/golf${n}.ts`), 'utf8').replace(/\r\n/g, '\n'), `export const golf${n} = ${n};\n`);
  // J: de una en una y en el orden del plan. Con una historia a la vez, cada una nace de main con las anteriores ya
  // integradas: no hace falta candidato (el caso con main avanzado lo cubre la prueba en paralelo).
  const integ = done.events.filter((e: any) => /integrada en main/.test(e.message)).map((e: any) => e.message.split(':')[0]);
  assert.deepEqual(integ, done.items.map((i: any) => i.storyId), 'en el orden del plan');
  assert.equal(done.events.filter((e: any) => /candidato preparado sin IA/.test(e.message)).length, 0);
  assert.equal(done.items.every((i: any) => i.process.merged), true);
  assert.equal(callsFor('GOLF1').length + callsFor('GOLF2').length + callsFor('GOLF3').length, 6, 'plan + implementación por historia (QA aparte): nada repetido');
  assert.equal(done.summary.awaiting_acceptance, 3);
});

test('H · dependencias en ejecución real: la dependiente empieza tras integrar su dependencia y parte de main con ese cambio', async () => {
  const a = story('Historia HOTEL-BASE'); const bItem = story('Historia HOTEL-DEP', a.storyId);
  setScript([{ key: 'HOTEL-BASE', file: 'src/hotel.ts', dev: create('src/hotel.ts', 'export const hotel = 1;') }, { key: 'HOTEL-DEP', file: 'src/hotel.ts', dev: patch('src/hotel.ts', 'export const hotel = 1;', 'export const hotel = 2;') }]);
  // La dependiente va PRIMERA en tu orden: el plan la pone después.
  const b = await authorize({ itemIds: [bItem.id, a.id], title: 'Lote H', concurrency: 2 });
  assert.equal(b.items[0].storyId, a.storyId); assert.equal(b.items[1].state, 'waiting_dependency');
  const done = await waitFor(() => get(b.id), x => x.status === 'completed', 'lote H completado');
  assert.deepEqual(done.items.map((i: any) => i.state), ['awaiting_acceptance', 'awaiting_acceptance'], JSON.stringify(done.items.map((i: any) => i.reason)));
  assert.equal(fs.readFileSync(path.join(repo, 'src/hotel.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const hotel = 2;\n', 'el parche de la dependiente solo aplica sobre el cambio de su dependencia');
  const startDep = done.events.find((e: any) => e.itemId === bItem.id && /empieza/.test(e.message)).at;
  const mergedBase = done.events.find((e: any) => e.itemId === a.id && /integrada en main/.test(e.message)).at;
  assert.ok(startDep >= mergedBase, 'no empieza antes de que su dependencia esté en main');
});

test('I + J · dos historias en paralelo (worktrees separados) y la integración sigue siendo de una en una', async () => {
  const a = story('Historia INDIA1'); const c = story('Historia INDIA2');
  setScript([{ key: 'INDIA1', file: 'src/india1.ts', dev: create('src/india1.ts', 'export const india1 = 1;') }, { key: 'INDIA2', file: 'src/india2.ts', dev: create('src/india2.ts', 'export const india2 = 2;') }]);
  maxActive = 0;
  const b = await authorize({ itemIds: [a.id, c.id], title: 'Lote I', concurrency: 2 });
  const running = await waitFor(() => get(b.id), x => x.items.filter((i: any) => i.state === 'running').length === 2 || settled(x), 'dos en marcha');
  const done = await waitFor(() => get(b.id), x => x.status === 'completed', 'lote I completado');
  assert.deepEqual(done.items.map((i: any) => i.state), ['awaiting_acceptance', 'awaiting_acceptance']);
  const wts = done.items.map((i: any) => processesRepo(S).get(i.processId)!.result!.applied!.worktree);
  assert.notEqual(wts[0], wts[1], 'cada historia en su propio worktree');
  assert.ok(running.items.filter((i: any) => i.state === 'running').length === 2 || maxActive >= 2, 'llegaron a trabajar a la vez');
  const merges = done.events.filter((e: any) => /integrada en main/.test(e.message)).map((e: any) => Date.parse(e.at));
  assert.equal(merges.length, 2);
  assert.ok(done.events.some((e: any) => e.itemId === done.items[1].itemId && /candidato preparado sin IA/.test(e.message)), 'la segunda incorporó main (con la primera) antes de integrarse');
});

test('K · reinicio durante la verificación (sin llamadas en curso): se retoma solo, una vez, sin repetir plan, implementación ni QA', async () => {
  const a = story('Historia KILO1');
  setScript([{ key: 'KILO1', file: 'src/kilo1.ts', dev: create('src/kilo1.ts', 'export const kilo1 = 1;') }]);
  let entered!: () => void; const inVerify = new Promise<void>(r => { entered = r; });
  hangOn = { file: 'src/kilo1.ts', entered };
  const b = await authorize({ itemIds: [a.id], title: 'Lote K' });
  await inVerify;
  const pid = (await get(b.id)).items[0].processId;
  // «Reinicio»: lo que hace el arranque del Portal (marcar interrumpidos sin reenviar nada) y luego retomar los lotes.
  assert.equal(recoverInterruptedProcesses(() => undefined), 1);
  assert.equal(processesRepo(S).get(pid)!.result!.pipeline!.pauseKind, 'interrupted');
  const callsBefore = calls().length;
  assert.equal(await resumeBatches(() => undefined), 1, 'retomada sola');
  const done = await waitFor(() => get(b.id), x => x.status === 'completed', 'lote K completado');
  assert.equal(done.items[0].state, 'awaiting_acceptance', done.items[0].reason);
  assert.equal(done.items[0].autoResumes, 1);
  const extra = calls().slice(callsBefore);
  assert.ok(!extra.some(c => /plan técnico|Implementa la historia/.test(c.rule ?? '')), 'ni el plan ni la implementación se repiten');
  assert.ok(done.events.some((e: any) => e.kind === 'recovery'));
});

test('K · reinicio con una llamada en curso: cobro incierto → no se reenvía sola; decides tú', async () => {
  const a = story('Historia KILO2');
  setScript([{ key: 'KILO2', file: 'src/kilo2.ts', dev: create('src/kilo2.ts', 'export const kilo2 = 1;'), qa: { delayMs: 60_000, text: QA_OK } }]);
  const b = await authorize({ itemIds: [a.id], title: 'Lote K2' });
  const pid = (await waitFor(() => get(b.id), x => !!x.items[0].processId, 'proceso creado')).items[0].processId;
  await waitFor(() => processesRepo(S).get(pid)!.steps.some(s => s.role === 'reviewer' && s.status === 'running'), v => v, 'QA llamando');
  recoverInterruptedProcesses(() => undefined);
  const n = calls().length;
  assert.equal(await resumeBatches(() => undefined), 0, 'no se retoma sola');
  const x = await waitFor(() => get(b.id), y => y.items[0].state === 'needs_owner', 'decide el propietario');
  assert.match(x.items[0].reason, /cobro .*no está confirmado/);
  assert.equal(calls().length, n, 'ninguna llamada reenviada');
  // Limpieza: la llamada «colgada» del arranque anterior se aborta (en un reinicio real ya no existe).
  abortProcessCalls(pid);
  await app.inject({ method: 'POST', url: `${W}/batches/${b.id}/cancel` });
});

test('L · presupuesto agotado: el lote se pausa antes de empezar otra historia y «Reanudar» con más presupuesto sigue', async () => {
  const a = story('Historia LIMA1'); const c = story('Historia LIMA2');
  setScript([{ key: 'LIMA1', file: 'src/lima1.ts', dev: create('src/lima1.ts', 'export const lima1 = 1;') }, { key: 'LIMA2', file: 'src/lima2.ts', dev: create('src/lima2.ts', 'export const lima2 = 1;') }]);
  const b = await authorize({ itemIds: [a.id, c.id], title: 'Lote L', totalBudgetUsd: 1, perStoryBudgetUsd: 1 });
  const paused = await waitFor(() => get(b.id), x => x.status === 'paused', 'pausa por presupuesto');
  assert.match(paused.reason, /presupuesto restante del lote/);
  assert.equal(paused.items[0].state, 'awaiting_acceptance'); assert.equal(paused.items[1].state, 'queued', 'la segunda no empezó');
  assert.equal(callsFor('LIMA2').length, 0);
  const noAuth = await app.inject({ method: 'POST', url: `${W}/batches/${b.id}/resume`, payload: {} });
  assert.equal(noAuth.statusCode, 400, 'reanudar es gastar: exige autorización');
  const res = await app.inject({ method: 'POST', url: `${W}/batches/${b.id}/resume`, payload: { authorized: true, addBudgetUsd: 2 } });
  assert.equal(res.statusCode, 200, res.body); assert.equal(res.json().auth.totalBudgetUsd, 3);
  const done = await waitFor(() => get(b.id), x => x.status === 'completed', 'lote L completado');
  assert.equal(done.items[1].state, 'awaiting_acceptance');
});

test('M · límite de la suscripción: pausa TODO el lote (no empieza la independiente) y el tope de llamadas del lote se respeta', async () => {
  const a = story('Historia MIKE1'); const c = story('Historia MIKE2');
  setScript([{ key: 'MIKE2', file: 'src/mike2.ts', dev: create('src/mike2.ts', 'export const mike2 = 1;') }]);
  // La historia termina pausada por el límite de la suscripción (el pipeline ya lo detecta; aquí se prueba el lote).
  batchDeps.runStory = async (slug, pid) => {
    const procs = processesRepo(slug); const p = procs.get(pid)!;
    if (!/MIKE1/.test(p.title)) return realRunStory(slug, pid, () => undefined, () => false);
    procs.setResult(pid, { ...p.result!, pipeline: { ...p.result!.pipeline!, state: 'paused', pauseKind: 'subscription_limit', reason: 'La suscripción de Claude alcanzó su límite de uso.', phase: 'finished', finishedAt: new Date().toISOString() } });
    procs.finish(pid, 'done', null);
  };
  try {
    const b = await authorize({ itemIds: [a.id, c.id], title: 'Lote M', maxSubscriptionCalls: 1 });
    const paused = await waitFor(() => get(b.id), x => x.status === 'paused', 'pausa por la suscripción');
    assert.equal(paused.items[0].state, 'needs_owner'); assert.equal(paused.items[0].failureClass, 'subscription');
    assert.equal(paused.items[1].state, 'queued', 'la independiente NO empieza: el mismo límite la detendría');
    assert.match(paused.reason, /límite de la suscripción de Claude/);
    // Tope de llamadas a la suscripción del lote (telemetría): con el tope alcanzado no empieza nada más.
    callMetricsRepo(S).record({ processId: paused.items[0].processId, stepId: null, agentId: null, role: 'implementer', operation: 'x', backend: 'Claude Code — Suscripción', model: 'm', attempt: 1, status: 'done', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), waitMs: 0, buildMs: 0, systemChars: 0, promptChars: 0, context: [], tokensIn: 0, tokensOut: 0, cacheReadTokens: null, turns: 1, tools: null, promptHash: 'h', errorClass: null } as any);
    const r = await app.inject({ method: 'POST', url: `${W}/batches/${b.id}/resume`, payload: { authorized: true } });
    assert.equal(r.statusCode, 200);
    const capped = await waitFor(() => get(b.id), x => x.status === 'paused', 'pausa por el tope de llamadas');
    assert.match(capped.reason, /tope de llamadas a la suscripción de Claude autorizado en el lote \(1 de 1\)/);
    assert.equal(capped.items[1].state, 'queued', 'con el tope alcanzado no empieza nada más');
    // Ampliar el tope (autorizado) deja seguir: la segunda historia termina.
    const r2 = await app.inject({ method: 'POST', url: `${W}/batches/${b.id}/resume`, payload: { authorized: true, addSubscriptionCalls: 5 } });
    assert.equal(r2.json().auth.maxSubscriptionCalls, 6);
    const done = await waitFor(() => get(b.id), x => x.items[1].state === 'awaiting_acceptance', 'la segunda termina tras reanudar');
    assert.equal(done.subscriptionCalls, 1);
    await app.inject({ method: 'POST', url: `${W}/batches/${b.id}/cancel` });
  } finally { batchDeps.runStory = realRunStory; }
});

test('N · fallo parcial: la que falla no detiene a las independientes y sus dependientes quedan bloqueadas con el motivo (nunca omitidas en silencio)', async () => {
  const a = story('Historia NOVEMBER-ROTA'); const dep = story('Historia NOVEMBER-DEP', a.storyId); const ind = story('Historia NOVEMBER-OK');
  setScript([{ key: 'NOVEMBER-ROTA', file: 'src/nov.ts', dev: 'No puedo hacerlo.' }, { key: 'NOVEMBER-OK', file: 'src/novok.ts', dev: create('src/novok.ts', 'export const ok = 1;') }]);
  batchDeps.runStory = async (slug, pid, log, c) => {
    const p = processesRepo(slug).get(pid)!;
    if (/NOVEMBER-ROTA/.test(p.title)) { processesRepo(slug).finish(pid, 'failed', 'Fallo simulado del proveedor.'); return; }
    return realRunStory(slug, pid, log, c);
  };
  try {
    const b = await authorize({ itemIds: [a.id, dep.id, ind.id], title: 'Lote N' });
    const done = await waitFor(() => get(b.id), x => x.status === 'completed', 'lote N completado');
    const by = Object.fromEntries(done.items.map((i: any) => [i.storyId, i]));
    assert.equal(by[a.storyId].state, 'failed'); assert.equal(by[a.storyId].failureClass, 'failure');
    assert.equal(by[dep.storyId].state, 'blocked'); assert.match(by[dep.storyId].reason, new RegExp(`Depende de ${a.storyId}, que quedó fallida`));
    assert.equal(by[ind.storyId].state, 'awaiting_acceptance', 'la independiente sigue y termina');
    assert.equal(callsFor('NOVEMBER-DEP').length, 0, 'la dependiente no se ejecutó');
    assert.match(done.reason, /1 fallida\(s\), 1 bloqueada\(s\)/);
  } finally { batchDeps.runStory = realRunStory; }
});

test('O · aceptación del propietario, distinta de QA: solo tras la terminación técnica; una o varias; pasos marcados; reabrir', async () => {
  const lote = (await (await app.inject({ method: 'GET', url: `${W}/projects/${project.id}/batches` })).json()).find((b: any) => b.title === 'Lote G');
  const [g1, g2, g3] = lote.items;
  assert.equal(g1.process.review, 'approved', 'QA aprobó; aun así falta tu aceptación');
  assert.equal(backlogRepo(S).get(g1.itemId)!.status, 'review');
  const k2 = (await (await app.inject({ method: 'GET', url: `${W}/projects/${project.id}/batches` })).json()).find((b: any) => b.title === 'Lote K2');
  const notReady = await app.inject({ method: 'POST', url: `${W}/batches/${k2.id}/accept`, payload: { itemIds: [k2.items[0].itemId] } });
  assert.equal(notReady.statusCode, 409, 'una historia sin terminar técnicamente no se acepta'); assert.equal(notReady.json().code, 'not_ready');
  const partial = await app.inject({ method: 'POST', url: `${W}/batches/${lote.id}/accept`, payload: { itemIds: [g1.itemId], checks: { [g1.itemId]: [true, false] } } });
  assert.equal(partial.statusCode, 409); assert.equal(partial.json().code, 'checks_incomplete');
  const ok = await app.inject({ method: 'POST', url: `${W}/batches/${lote.id}/accept`, payload: { itemIds: [g1.itemId, g2.itemId], note: 'Probado en local', checks: { [g1.itemId]: [true, true] } } });
  assert.equal(ok.statusCode, 200, ok.body);
  const after1 = ok.json();
  assert.deepEqual(after1.items.map((i: any) => i.state), ['accepted', 'accepted', 'awaiting_acceptance']);
  assert.equal(backlogRepo(S).get(g1.itemId)!.status, 'done');
  const r1 = processesRepo(S).get(g1.processId)!.result!;
  assert.equal(r1.acceptance!.by, 'owner'); assert.equal(r1.acceptance!.batchId, lote.id); assert.deepEqual(r1.manualTest!.checks, [true, true]);
  const reopened = await app.inject({ method: 'POST', url: `${W}/batches/${lote.id}/items/${g2.itemId}/reopen` });
  assert.equal(reopened.json().items[1].state, 'awaiting_acceptance'); assert.equal(backlogRepo(S).get(g2.itemId)!.status, 'review');
  assert.equal(g3.state, 'awaiting_acceptance');
});

test('P · no aceptar crea tareas con los pasos que fallaron e iterar SOLO esa historia dentro del lote', async () => {
  const a = story('Historia PAPA'); const c = story('Historia PAPA-OTRA');
  setScript([
    { key: 'PAPA-OTRA', file: 'src/papa2.ts', dev: create('src/papa2.ts', 'export const otra = 1;') },
    { key: 'PAPA', file: 'src/papa.ts', dev: [create('src/papa.ts', 'export const papa = 1;'), patch('src/papa.ts', 'export const papa = 1;', 'export const papa = 2;')] }
  ]);
  const b = await authorize({ itemIds: [a.id, c.id], title: 'Lote P' });
  await waitFor(() => get(b.id), x => x.status === 'completed', 'lote P completado');
  const otraCalls = callsFor('PAPA-OTRA').length;
  const rej = await app.inject({ method: 'POST', url: `${W}/batches/${b.id}/items/${a.id}/reject`, payload: { note: 'El valor debe ser 2', failedSteps: ['Revisa el valor: muestra 1'] } });
  assert.equal(rej.statusCode, 200, rej.body);
  const item = rej.json().items.find((i: any) => i.itemId === a.id);
  assert.equal(item.state, 'rejected'); assert.equal(item.rejection.taskIds.length, 1);
  assert.ok(threadRepo(S).tasks(a.id).some(t => t.title === 'Aceptación: Revisa el valor: muestra 1'));
  const noAuth = await app.inject({ method: 'POST', url: `${W}/batches/${b.id}/items/${a.id}/iterate`, payload: { note: 'Valor 2' } });
  assert.equal(noAuth.statusCode, 400);
  const it = await app.inject({ method: 'POST', url: `${W}/batches/${b.id}/items/${a.id}/iterate`, payload: { authorized: true, note: 'El valor debe ser 2' } });
  assert.equal(it.statusCode, 200, it.body); assert.equal(it.json().status, 'running');
  const done = await waitFor(() => get(b.id), x => x.status === 'completed', 'iteración completada');
  const p = done.items.find((i: any) => i.itemId === a.id);
  assert.equal(p.state, 'awaiting_acceptance', p.reason); assert.equal(p.processIds.length, 2, 'una iteración más, en el mismo elemento');
  assert.equal(fs.readFileSync(path.join(repo, 'src/papa.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const papa = 2;\n');
  assert.equal(callsFor('PAPA-OTRA').length, otraCalls, 'la otra historia no se repite');
  assert.equal(done.items.find((i: any) => i.itemId === c.id).state, 'awaiting_acceptance');
});

test('F · revocar: lo que estaba en marcha se detiene, lo pendiente se cancela y nada se integra solo después', async () => {
  const a = story('Historia ROMEO1'); const c = story('Historia ROMEO2');
  setScript([{ key: 'ROMEO1', file: 'src/romeo1.ts', dev: create('src/romeo1.ts', 'export const r = 1;'), qa: { delayMs: 1500, text: QA_OK } }, { key: 'ROMEO2', file: 'src/romeo2.ts', dev: create('src/romeo2.ts', 'export const r2 = 1;') }]);
  const before = mainLog().length;
  const b = await authorize({ itemIds: [a.id, c.id], title: 'Lote R' });
  const pid = (await waitFor(() => get(b.id), x => !!x.items[0].processId, 'empieza')).items[0].processId;
  await waitFor(() => processesRepo(S).get(pid)!.steps.some(s => s.role === 'reviewer' && s.status === 'running'), v => v, 'QA llamando');
  const res = await app.inject({ method: 'POST', url: `${W}/batches/${b.id}/revoke`, payload: { reason: 'Cambio de prioridades' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'revoked'); assert.equal(res.json().items[1].state, 'cancelled');
  const x = await waitFor(() => get(b.id), y => y.items[0].state !== 'running', 'la historia en marcha se detiene');
  assert.notEqual(x.items[0].state, 'integrating'); assert.equal(mainLog().length, before, 'nada se integró tras revocar');
  assert.equal((await app.inject({ method: 'POST', url: `${W}/batches/${b.id}/resume`, payload: { authorized: true } })).statusCode, 409, 'un lote revocado no se reanuda');
  assert.ok(x.events.some((e: any) => e.kind === 'revoke' && /Cambio de prioridades/.test(e.message)));
});

test('Q · orígenes y aislamiento: un equipo con un origen no autorizado no empieza (no se cambia de origen); historias de otro proyecto o no pendientes se rechazan', async () => {
  const a = story('Historia QUEBEC');
  setScript([{ key: 'QUEBEC', file: 'src/quebec.ts', dev: create('src/quebec.ts', 'export const q = 1;') }]);
  const b = await authorize({ itemIds: [a.id], title: 'Lote Q', backends: ['claude_code'] });
  const x = await waitFor(() => get(b.id), y => y.items[0].state === 'needs_owner', 'no empieza');
  assert.match(x.items[0].reason, /origen de ejecución no autorizado en el lote \(api\)/);
  assert.equal(callsFor('QUEBEC').length, 0, 'ninguna llamada');
  assert.equal(processesRepo(S).get(x.items[0].processId)!.status, 'cancelled', 'el proceso preparado queda cancelado con el motivo (auditable)');
  await app.inject({ method: 'POST', url: `${W}/batches/${b.id}/cancel` });
  const other = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches`, payload: { authorized: true, itemIds: ['no-existe'], totalBudgetUsd: 1, perStoryBudgetUsd: 1 } });
  assert.equal(other.statusCode, 404);
  const closed = story('Historia QUEBEC-CERRADA'); backlogRepo(S).setStatus(closed.id, 'done');
  const bad = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches`, payload: { authorized: true, itemIds: [closed.id], totalBudgetUsd: 1, perStoryBudgetUsd: 1 } });
  assert.equal(bad.statusCode, 409); assert.equal(bad.json().code, 'invalid_status');
  assert.equal(agentsRepo(S).list().filter(ag => ag.key === 'pj-gauntlet').length, 0, 'el lote no crea agentes');
});

test('activación serializada (Portal interno): con nada en marcha se reconstruye y reinicia una vez; al volver se comprueba en ejecución', async () => {
  const a = story('Historia SIERRA1'); const c = story('Historia SIERRA2');
  setScript([{ key: 'SIERRA1', file: 'src/sierra1.ts', dev: create('src/sierra1.ts', 'export const s1 = 1;') }, { key: 'SIERRA2', file: 'src/sierra2.ts', dev: create('src/sierra2.ts', 'export const s2 = 1;') }]);
  activations = 0;
  const b = await authorize({ itemIds: [a.id, c.id], title: 'Lote S', git: { merge: true, activate: true } });
  const req1 = await waitFor(() => get(b.id), x => x.activation?.state === 'requested', 'activación pedida');
  assert.equal(activations, 1); assert.equal(req1.items[0].state, 'integrating'); assert.equal(req1.items[1].state, 'queued', 'nada empieza mientras se activa');
  // «Vuelve» el Portal: retoma los lotes y comprueba la activación.
  await resumeBatches(() => undefined);
  const req2 = await waitFor(() => get(b.id), x => x.activation?.state === 'requested' && x.activation.itemIds[0] === c.id, 'segunda activación');
  assert.equal(req2.items[0].state, 'awaiting_acceptance'); assert.equal(req2.items[0].activated, true);
  assert.ok(processesRepo(S).get(req2.items[0].processId)!.result!.runtimeChecks!.results.every(r => r.status === 'ok'));
  await resumeBatches(() => undefined);
  const done = await waitFor(() => get(b.id), x => x.status === 'completed', 'lote S completado');
  assert.deepEqual(done.items.map((i: any) => [i.state, i.activated]), [['awaiting_acceptance', true], ['awaiting_acceptance', true]]);
  assert.equal(activations, 2, 'una activación por integración, de una en una');
  await scheduleTick(S, b.id);
});

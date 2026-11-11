import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * HU-203 · Lotes fieles al Backlog. Proveedor SIMULADO (0 USD), sandbox determinista, repositorio sintético y el
 * TEMPORIZADOR REAL del lote (intervalo corto): ninguna prueba llama a scheduleTick a mano.
 * (a) con historias fallidas, bloqueadas o sin aceptar el lote queda en 'needs_decision', nunca en 'completed';
 * (b) una historia cerrada fuera del lote se refleja en él sin crear otro proceso;
 * (c) al completarse su dependencia fuera del lote, la dependiente se ejecuta sola dentro del presupuesto; sin
 *     presupuesto, el lote se pausa con el motivo;
 * (d) «Reanudar» vuelve a ejecutar de verdad una historia fallida;
 * (e) regla 409: un lote que solo espera aceptación no impide autorizar otro; uno con trabajo autónomo sí.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu203-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { backlogRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { batchDeps, startBatchScheduler, stopBatchScheduler } = await import('../src/services/batchRunner.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu203-repo-'));
const uniq = `hu203-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/base.ts'), 'export const base = 0;\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node -e ""', test: 'node -e ""', build: 'node -e ""' } }, null, 2));
fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: uniq, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.0' } } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
// El temporizador REAL del Portal, con un intervalo corto: es quien sincroniza con el Backlog y desbloquea.
startBatchScheduler(() => undefined, 120);
after(async () => { stopBatchScheduler(); await app.close(); });

sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => {
  const t = new Date().toISOString();
  await new Promise(r => setTimeout(r, 20));
  return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 20, isolation: 'docker' };
};
batchDeps.activate = async () => undefined;
batchDeps.activation = async () => ({ active: true, runningCommit: 'x', buildCommit: 'x', buildAt: new Date().toISOString(), reason: 'simulado' });
batchDeps.runtimeChecks = async (_pid, checks) => checks.map(check => ({ check, status: 'ok' as const, detail: 'ok', at: new Date().toISOString() }));
// La historia ALFAROTA falla la primera vez (fallo del proveedor simulado); después se ejecuta de verdad.
const realRunStory = batchDeps.runStory;
let failRota = true; let rotaRuns = 0;
batchDeps.runStory = async (slug, pid, log, c) => {
  const p = processesRepo(slug).get(pid)!;
  if (/ALFAROTA/.test(p.title)) { rotaRuns++; if (failRota) { failRota = false; processesRepo(slug).finish(pid, 'failed', 'Fallo simulado del proveedor.'); return; } }
  return realRunStory(slug, pid, log, c);
};

const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple; verificación en verde.', findings: [], suggestedTests: [] });
const plan = (file: string) => JSON.stringify({ summary: `Crear ${file}`, tasks: [`Crear ${file}`], filesToRead: [], filesToChange: [file], acceptance: [`${file} existe`], risks: [] });
const create = (file: string, content: string) => `=== RESUMEN ===\nCrea ${file}.\n=== ARCHIVO: ${file} | create ===\n${content}\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre ${file}. Esperado: existe.`;
/** Claves sin prefijos comunes entre sí (la regla se busca en el título de la historia). */
function setScript(keys: string[]) {
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  const rules: Record<string, unknown>[] = [];
  for (const key of keys) {
    const file = `src/${key.toLowerCase()}.ts`;
    rules.push({ match: `${key}.*Elabora el plan técnico`, text: plan(file) });
    rules.push({ match: `${key}.*Implementa la historia`, text: create(file, `export const ${key.toLowerCase()} = 1;`) });
  }
  rules.push({ match: 'Evalúa la implementación con la EVIDENCIA real', text: QA_OK });
  fs.writeFileSync(scriptPath, JSON.stringify({ rules, markers: [] }));
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const callsFor = (key: string) => calls().filter(c => typeof c.rule === 'string' && c.rule.startsWith(`${key}.*`));
const story = (title: string, dependsOn?: string) => { const it = addManualItem(S, project.id, { title, criterion: 'el archivo existe' }); if (dependsOn) backlogRepo(S).update(it.id, { dependsOn }); return backlogRepo(S).get(it.id)!; };
const get = async (id: string) => (await app.inject({ method: 'GET', url: `${W}/batches/${id}` })).json();
const settled = (b: any) => !b.items.some((i: any) => ['queued', 'waiting_dependency', 'running', 'integrating'].includes(i.state));
const by = (b: any, key: string) => b.items.find((i: any) => new RegExp(key).test(i.title ?? '') || new RegExp(key).test(backlogRepo(S).get(i.itemId)?.title ?? ''));
/** Espera vigilando que el lote NUNCA pase por 'completed' mientras tanto. */
async function waitFor(id: string, ok: (v: any) => boolean, what: string, opts: { neverCompleted?: boolean; ms?: number } = {}) {
  const end = Date.now() + (opts.ms ?? 45_000); let v = await get(id);
  while (!ok(v)) {
    if (opts.neverCompleted) assert.notEqual(v.status, 'completed', `el lote no puede darse por terminado: ${what}`);
    if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what} · ${JSON.stringify(v).slice(0, 1500)}`);
    await new Promise(r => setTimeout(r, 60)); v = await get(id);
  }
  return v;
}
const authorizeRaw = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches`, payload: { authorized: true, totalBudgetUsd: 5, perStoryBudgetUsd: 1, maxCorrections: 1, commands: ['typecheck', 'test', 'build'], git: { merge: true }, backends: ['api', 'claude_code'], ...body } });
const authorize = async (body: Record<string, unknown>) => { const res = await authorizeRaw(body); assert.equal(res.statusCode, 201, res.body); return res.json(); };
const resume = (id: string, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `${W}/batches/${id}/resume`, payload: { authorized: true, ...extra } });

let lotA = ''; let lotB2 = '';

test('(a) con una fallida y su dependiente bloqueada el lote queda en «necesita tu decisión», nunca «terminado»', async () => {
  const rota = story('Historia ALFAROTA'); const dep = story('Historia BRAVODEP', rota.storyId); const ok = story('Historia CHARLIEOK');
  setScript(['ALFAROTA', 'BRAVODEP', 'CHARLIEOK']);
  const b = await authorize({ itemIds: [rota.id, dep.id, ok.id], title: 'Lote A' }); lotA = b.id;
  const v = await waitFor(b.id, x => x.status === 'needs_decision' && settled(x), 'necesita tu decisión', { neverCompleted: true });
  const st = Object.fromEntries(v.items.map((i: any) => [i.itemId, i.state]));
  assert.equal(st[rota.id], 'failed'); assert.equal(st[dep.id], 'blocked'); assert.equal(st[ok.id], 'awaiting_acceptance');
  assert.match(v.reason, /Necesita tu decisión/); assert.match(v.reason, /1 fallida\(s\), 1 bloqueada\(s\)/);
  assert.equal(callsFor('BRAVODEP').length, 0, 'la dependiente de una fallida no se ejecuta');
  // Sigue sin terminar al cabo de varias vueltas del temporizador.
  await new Promise(r => setTimeout(r, 500));
  assert.equal((await get(b.id)).status, 'needs_decision');
});

test('(d) «Reanudar» vuelve a encolar y EJECUTA la fallida; su dependiente sigue sola; solo al aceptar todas queda «terminado»', async () => {
  const runsBefore = rotaRuns;
  const r = await resume(lotA);
  assert.equal(r.statusCode, 200, r.body);
  const v = await waitFor(lotA, x => x.status === 'needs_decision' && x.items.every((i: any) => i.state === 'awaiting_acceptance'), 'las tres terminadas técnicamente', { neverCompleted: true });
  assert.ok(rotaRuns > runsBefore, 'la fallida se ejecutó de nuevo de verdad');
  assert.ok(callsFor('ALFAROTA').length > 0 && callsFor('BRAVODEP').length > 0, 'la reanudada y su dependiente llamaron al equipo');
  const acc = await app.inject({ method: 'POST', url: `${W}/batches/${lotA}/accept`, payload: { itemIds: v.items.map((i: any) => i.itemId) } });
  assert.equal(acc.statusCode, 200, acc.body);
  const done = await waitFor(lotA, x => x.status === 'completed', 'terminado tras aceptar todas');
  assert.deepEqual(done.items.map((i: any) => i.state), ['accepted', 'accepted', 'accepted']);
});

test('(b) + (e) una historia cerrada en el Backlog fuera del lote se refleja en él sin otro proceso; esperar solo tu aceptación no impide autorizar otro lote', async () => {
  const e = story('Historia ECHOFUERA'); const f = story('Historia FOXDOS');
  setScript(['ECHOFUERA', 'FOXDOS']);
  const b = await authorize({ itemIds: [e.id], title: 'Lote B' });
  await waitFor(b.id, x => x.status === 'needs_decision' && x.items[0].state === 'awaiting_acceptance', 'espera tu aceptación', { neverCompleted: true });
  // Solo espera tu aceptación: no lanza trabajo por sí mismo, así que otro lote sí se autoriza.
  const b2 = await authorize({ itemIds: [f.id], title: 'Lote B2' }); lotB2 = b2.id;
  await waitFor(b2.id, x => x.status === 'needs_decision' && settled(x), 'B2 espera tu aceptación', { neverCompleted: true });
  const procs = processesRepo(S).list(project.id).length;
  const pids = (await get(b.id)).items[0].processIds.length;
  // Fuera del lote: la historia se cierra en el Backlog. El temporizador lo refleja en el lote.
  backlogRepo(S).setStatus(e.id, 'done');
  const v = await waitFor(b.id, x => x.status === 'completed', 'el lote refleja el Backlog');
  assert.equal(backlogRepo(S).get(e.id)!.status, 'done');
  assert.notEqual(v.items[0].state, 'awaiting_acceptance', 'el estado en el lote coincide con el Backlog');
  assert.equal(processesRepo(S).list(project.id).length, procs, 'no se creó un segundo proceso');
  assert.equal(v.items[0].processIds.length, pids, 'ni se enlazó otro proceso');
});

test('(c) + (e) la dependiente se ejecuta SOLA cuando su dependencia se completa fuera del lote; mientras espera, el lote bloquea autorizar y reanudar otro (409)', async () => {
  const ext = story('Historia GOLFEXTERNA'); const dep = story('Historia HOTELDEPENDE', ext.storyId); const ind = story('Historia INDIASOLA');
  setScript(['HOTELDEPENDE', 'INDIASOLA']);
  const b = await authorize({ itemIds: [dep.id, ind.id], title: 'Lote C' });
  const w = await waitFor(b.id, x => x.status === 'needs_decision' && x.items.find((i: any) => i.itemId === ind.id).state === 'awaiting_acceptance' && x.items.find((i: any) => i.itemId === dep.id).state === 'blocked', 'la independiente lista y la dependiente esperando', { neverCompleted: true });
  assert.ok(w.items.find((i: any) => i.itemId === dep.id).reason);
  assert.equal(callsFor('HOTELDEPENDE').length, 0);
  // Puede lanzar trabajo por sí mismo (su dependencia aún puede completarse): bloquea autorizar y reanudar otro.
  const other = await authorizeRaw({ itemIds: [story('Historia JULIETOTRA').id], title: 'Lote C2' });
  assert.equal(other.statusCode, 409, other.body); assert.equal(other.json().code, 'batch_active');
  const res = await resume(lotB2);
  assert.equal(res.statusCode, 409, res.body); assert.equal(res.json().code, 'batch_active');
  // La dependencia se completa FUERA del lote: el temporizador desbloquea y ejecuta la dependiente, sin intervención.
  backlogRepo(S).setStatus(ext.id, 'done');
  const v = await waitFor(b.id, x => x.status === 'needs_decision' && x.items.every((i: any) => i.state === 'awaiting_acceptance'), 'la dependiente se ejecutó sola', { neverCompleted: true });
  assert.ok(callsFor('HOTELDEPENDE').length > 0, 'la dependiente llamó al equipo');
  assert.ok(v.events.length > 0);
});

test('(c) sin presupuesto restante, el desbloqueo pausa el lote con el motivo y «Reanudar» con más presupuesto la ejecuta', async () => {
  const ext = story('Historia KILOEXTERNA'); const dep = story('Historia LIMADEPENDE', ext.storyId); const ind = story('Historia MIKESOLA');
  setScript(['LIMADEPENDE', 'MIKESOLA']);
  const b = await authorize({ itemIds: [dep.id, ind.id], title: 'Lote D', totalBudgetUsd: 1, perStoryBudgetUsd: 1 });
  await waitFor(b.id, x => x.status === 'needs_decision' && x.items.find((i: any) => i.itemId === ind.id).state === 'awaiting_acceptance', 'la independiente gastó el presupuesto', { neverCompleted: true });
  backlogRepo(S).setStatus(ext.id, 'done');
  const p = await waitFor(b.id, x => x.status === 'paused', 'pausa por presupuesto al desbloquear', { neverCompleted: true });
  assert.match(p.reason, /presupuesto/i);
  assert.equal(callsFor('LIMADEPENDE').length, 0, 'nunca se gasta más de lo autorizado');
  const r = await resume(b.id, { addBudgetUsd: 2 });
  assert.equal(r.statusCode, 200, r.body);
  await waitFor(b.id, x => x.status === 'needs_decision' && x.items.every((i: any) => i.state === 'awaiting_acceptance'), 'la dependiente termina tras reanudar', { neverCompleted: true });
  assert.ok(callsFor('LIMADEPENDE').length > 0);
});

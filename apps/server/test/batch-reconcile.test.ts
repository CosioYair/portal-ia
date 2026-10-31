import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * EN-002 · Lote bloqueado en pausa con sus historias ya integradas. Proveedor SIMULADO (0 USD), datos temporales y
 * ejecución de historias sustituida (nunca se llama a la IA ni se reinicia nada real). Cubre: detección de git (sin el
 * falso «no corre desde un repositorio git»), reconciliación sin IA al consultar el lote y cierre manual con motivo.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-reconcile-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
process.env.PORTAL_MOCK_PROVIDER = '1';
const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { batchesRepo } = await import('../src/db/batches.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { batchDeps, stopBatchScheduler } = await import('../src/services/batchRunner.ts');
const { REPO_ROOT } = await import('../src/config.ts');
const system = await import('../src/services/system.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const gitEnv = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

// ---------- (a) Detección de git ----------
test('git · un repositorio real se detecta (con commit) y una carpeta sin git se distingue sin inventar causas', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-git-'));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: gitEnv });
  const yes = await system.gitRepoProbe(repo, null);
  assert.equal(yes.isGit, true); assert.ok(yes.head, 'commit de arranque leído'); assert.equal(yes.error, null);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-nogit-'));
  const no = await system.gitRepoProbe(plain, null);
  assert.equal(no.isGit, false); assert.equal(no.error, null, 'rev-parse confirma que no hay repositorio');
});

test('git · con un fallo que no es «no hay repositorio», el mensaje dice la causa real y se reintenta', async () => {
  let n = 0; let ok = false;
  system.__setRepoProbeForTests(async () => { n++; return ok ? { isGit: true, top: '/x', head: 'abc1234', error: null } : { isGit: false, top: null, head: null, error: 'git no está en el PATH del servidor: no se encontró el ejecutable «git».' }; }, { retryMs: 50 });
  try {
    const act = await system.activationOf('0000000', new Date().toISOString());
    assert.equal(act.active, false);
    assert.match(act.reason, /PATH/); assert.doesNotMatch(act.reason, /no corre desde un repositorio git/);
    await system.ensureRepo(); assert.equal(n, 1, 'dentro de la espera de reintento se usa la caché');
    ok = true; await new Promise(r => setTimeout(r, 80));
    assert.equal(await system.ensureStartCommit(), 'abc1234', 'pasada la espera se reintenta y fija el commit');
    assert.equal(n, 2);
    // Un error de git lanzado por la sonda se traduce a su causa (dubious ownership) con la instrucción para el propietario.
    system.__setRepoProbeForTests(async () => { throw Object.assign(new Error('fatal'), { stderr: "fatal: detected dubious ownership in repository at 'C:/Mis Proyectos/Portal IA'" }); });
    const d = await system.ensureRepo();
    assert.equal(d.isGit, false); assert.match(d.error!, /dubious ownership/); assert.match(d.error!, /safe\.directory/);
    // Solo si rev-parse confirma que no hay repositorio aparece ese mensaje.
    system.__setRepoProbeForTests(async () => ({ isGit: false, top: null, head: null, error: null }));
    assert.match((await system.activationOf('0000000', new Date().toISOString())).reason, /no corre desde un repositorio git/);
  } finally { system.__setRepoProbeForTests(null); }
});

// ---------- Entorno de lotes ----------
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const prepo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-reconcile-repo-'));
const uniq = `reconcile-${Date.now().toString(36)}`;
fs.writeFileSync(path.join(prepo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node -e ""', test: 'node -e ""', build: 'node -e ""' } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: prepo, env: gitEnv });
projectsRepo(S).setRepository(project.id, prepo, 'main');
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
batchDeps.activate = async () => undefined;
batchDeps.activation = async () => ({ active: true, runningCommit: 'x', buildCommit: 'x', buildAt: new Date().toISOString(), reason: 'simulado' });
// isAncestor lee el repositorio del Portal: el «merge» simulado apunta a su HEAD actual (ancestro de sí mismo).
let head: string | null = null;
try { head = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim() || null; } catch { head = null; }
const realRunStory = batchDeps.runStory;
batchDeps.runStory = async (slug, pid) => {
  const procs = processesRepo(slug); const p = procs.get(pid)!; const at = new Date().toISOString();
  procs.setResult(pid, { ...p.result!, pipeline: { ...p.result!.pipeline!, state: 'verified', phase: 'finished', finishedAt: at }, merged: { into: 'HEAD', commit: head ?? '0000000', mergedAt: at } } as any);
  procs.finish(pid, 'done', null);
};
const app = await buildApp();
after(async () => { batchDeps.runStory = realRunStory; stopBatchScheduler(); await app.close(); });

const story = (title: string) => addManualItem(S, project.id, { title, criterion: 'el archivo existe' });
const get = async (id: string) => (await app.inject({ method: 'GET', url: `${W}/batches/${id}` })).json();
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what} · ${JSON.stringify(v).slice(0, 1200)}`); await new Promise(r => setTimeout(r, 50)); v = await fn(); }
  return v;
}
const authorize = async (title: string) => {
  const res = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches`, payload: { authorized: true, title, itemIds: [story(`${title} A`).id, story(`${title} B`).id], totalBudgetUsd: 5, perStoryBudgetUsd: 1, maxCorrections: 0, commands: ['typecheck'], backends: ['api', 'claude_code'] } });
  assert.equal(res.statusCode, 201, res.body); return res.json();
};
/** Lote con sus 2 historias integradas y luego «atascado» en pausa, como el Lote del 2026-10-31. */
const stuckBatch = async (title: string) => {
  const b = await authorize(title);
  await waitFor(() => get(b.id), x => x.status === 'completed', `${title} termina`);
  batchesRepo(S).update(b.id, x => { x.status = 'paused'; x.reason = 'En pausa (heredado).'; x.finishedAt = null; });
  return b.id as string;
};
const costRows = () => (workspaceDb(S).prepare('SELECT * FROM execution_history').all() as any[]).filter(r => Number(r.cost ?? 0) > 0 || Number(r.tokens_in ?? r.tokensIn ?? 0) > 0 || Number(r.tokens_out ?? r.tokensOut ?? 0) > 0).length;
const mockCalls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length : 0;

// ---------- (b) Reconciliación ----------
test('reconciliación · un lote en pausa con todas sus historias integradas en main pasa a completado al consultarlo (sin IA)', async t => {
  if (!head) return t.skip('el repositorio del Portal no es git en este entorno');
  const id = await stuckBatch('Lote RECON');
  assert.equal(batchesRepo(S).get(id)!.status, 'paused');
  const calls = mockCalls();
  const v = await get(id);
  assert.equal(v.status, 'completed', v.reason); assert.ok(v.finishedAt);
  assert.ok(v.events.some((e: any) => e.kind === 'completed' && /integradas en main/.test(e.message)));
  assert.equal(mockCalls(), calls, 'reconciliar no llama a la IA');
  const list = (await app.inject({ method: 'GET', url: `${W}/projects/${project.id}/batches` })).json();
  assert.ok(!list.some((b: any) => b.status === 'paused' || b.status === 'running'), 'ya no queda lote activo');
});

// ---------- (c) Cierre manual ----------
test('reconciliación + cierre · con una historia sin integrar sigue en pausa; cerrar exige motivo, lo registra y no gasta IA; luego se autoriza otro lote', async t => {
  if (!head) return t.skip('el repositorio del Portal no es git en este entorno');
  const id = await stuckBatch('Lote CIERRE');
  const pid = batchesRepo(S).get(id)!.items[1].processId!;
  const p = processesRepo(S).get(pid)!; processesRepo(S).setResult(pid, { ...p.result!, merged: null } as any);
  const before = batchesRepo(S).get(id)!.updatedAt;
  const v = await get(id);
  assert.equal(v.status, 'paused', 'una historia sin integrar: el lote no se completa');
  assert.equal(batchesRepo(S).get(id)!.updatedAt, before, 'si no se cumple, no se escribe nada');

  const url = `${W}/projects/${project.id}/batches/${id}/close`;
  const noReason = await app.inject({ method: 'POST', url, payload: {} });
  assert.equal(noReason.statusCode, 400); assert.equal(noReason.json().code, 'reason_required');
  assert.equal((await app.inject({ method: 'POST', url, payload: { reason: ' a ' } })).statusCode, 400);

  const cost = costRows(); const calls = mockCalls();
  const res = await app.inject({ method: 'POST', url, payload: { reason: 'Historias ya resueltas fuera del lote' } });
  assert.equal(res.statusCode, 200, res.body);
  const closed = res.json();
  assert.equal(closed.status, 'cancelled', 'no todo está integrado: se cierra como cancelado, no como completado');
  assert.ok(closed.finishedAt);
  const ev = closed.events.find((e: any) => e.kind === 'close');
  assert.ok(ev, 'el cierre queda en los eventos'); assert.ok(ev.at);
  assert.match(ev.message, /Cerrado manualmente por el propietario: Historias ya resueltas fuera del lote/);
  assert.equal(costRows(), cost, 'sin uso ni costo de IA'); assert.equal(mockCalls(), calls, 'ninguna llamada a la IA');
  assert.equal((await get(id)).status, 'cancelled', 'se ve igual en /lotes/<id>');
  assert.equal((await app.inject({ method: 'POST', url, payload: { reason: 'Otra vez' } })).statusCode, 409, 'un lote ya cerrado no se vuelve a cerrar');

  // «Nuevo lote» deja de estar bloqueado: se autoriza otro sin 409 batch_active.
  const next = await authorize('Lote SIGUIENTE');
  await waitFor(() => get(next.id), x => x.status === 'completed', 'lote siguiente termina');
  // En marcha no se cierra a mano: 409.
  batchesRepo(S).update(next.id, x => { x.status = 'running'; });
  const running = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches/${next.id}/close`, payload: { reason: 'No debería cerrarse' } });
  assert.equal(running.statusCode, 409); assert.equal(running.json().code, 'invalid_status');
  batchesRepo(S).update(next.id, x => { x.status = 'completed'; });
});

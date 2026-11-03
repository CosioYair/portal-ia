import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Cierre de etapa con un repositorio REAL y un remoto «bare»: el propietario decide adoptar main y descartar todo lo antiguo;
 * la revisión llega con lo que se puede cerrar ya elegido (una sola autorización) y, al ejecutarla, el remoto queda solo con
 * main, el backlog activo vacío, el lote cerrado, las iteraciones y autorizaciones pendientes resueltas, los encargos cerrados
 * con su ciclo de vida y el trabajo no integrado guardado antes de borrar sus ramas. Nunca carpetas con cambios sin guardar.
 * También: publicar main no acumula upstreams (la causa de «multiple upstream branches»). Sin IA ni red externa.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-cierre-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { backlogRepo, processesRepo, projectsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { batchesRepo } = await import('../src/db/batches.ts');
const { assignmentsRepo } = await import('../src/db/assignments.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createAssignment } = await import('../src/services/assignments.ts');
const { pushBranches } = await import('../src/services/repoWrite.ts');
const { stopBatchScheduler } = await import('../src/services/batchRunner.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-cierre-repo-'));
const repo = path.join(tmp, 'repo'); const bare = path.join(tmp, 'remoto.git');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const commit = (cwd: string, file: string, msg: string) => { fs.writeFileSync(path.join(cwd, file), `${msg}\n`); g(cwd, 'add', '-A'); g(cwd, 'commit', '-qm', msg); return g(cwd, 'rev-parse', 'HEAD'); };
fs.mkdirSync(repo); g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
g(repo, 'init', '-q', '-b', 'main'); commit(repo, 'base.txt', 'Base'); g(repo, 'remote', 'add', 'origin', bare); g(repo, 'push', '-q', 'origin', 'main');
const now = () => new Date().toISOString();
const wtDir = (pid: string) => path.join(tmp, 'repo-worktrees', pid);
/** Integradas y publicadas (como en el Portal real): no quedan decisiones de «publicar». */
const pub = { remote: 'origin', url: null, branches: ['main'], pushedAt: new Date().toISOString() };
/** Proceso de historia con su resultado (aplicado y, si se da, integrado). */
const proc = (storyId: string | null, title: string, result: any, status = 'done') => {
  const p = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title, estimatedUsd: 0, backlogItemId: storyId, steps: [] } as any);
  if (result) processesRepo(S).setResult(p.id, result);
  workspaceDb(S).prepare(`UPDATE processes SET status = ? WHERE id = ?`).run(status, p.id);
  return p;
};
const merge = (branch: string) => { g(repo, 'merge', '-q', '--no-ff', '-m', `integra ${branch}`, branch); return g(repo, 'rev-parse', 'HEAD'); };

// A · en el lote en pausa, iteración aplicada sin integrar, con su carpeta de trabajo y su rama (también en el remoto).
const sA = addManualItem(S, project.id, { title: 'A sin integrar' });
g(repo, 'checkout', '-qb', 'portal-ia/hu-a'); const shaA = commit(repo, 'a.txt', 'A sin integrar'); g(repo, 'checkout', '-q', 'main');
g(repo, 'push', '-q', 'origin', 'portal-ia/hu-a');
const pA = proc(sA.id, 'A', null);
processesRepo(S).setResult(pA.id, { plan: null, applied: { branch: 'portal-ia/hu-a', commit: shaA, files: [], appliedAt: now(), worktree: wtDir(pA.id) }, merged: null, changes: [] } as any);
g(repo, 'worktree', 'add', '-q', wtDir(pA.id), 'portal-ia/hu-a');
backlogRepo(S).setStatus(sA.id, 'review', pA.id);
// B · en el lote, integrada en main pero sin prueba manual: aceptarla exige motivo (constancia de lo que faltaba).
const sB = addManualItem(S, project.id, { title: 'B integrada' });
g(repo, 'checkout', '-qb', 'portal-ia/hu-b'); commit(repo, 'b.txt', 'B'); g(repo, 'checkout', '-q', 'main'); const mB = merge('portal-ia/hu-b');
const pB = proc(sB.id, 'B', { plan: null, applied: { branch: 'portal-ia/hu-b', commit: 'x', files: [], appliedAt: now() }, merged: { into: 'main', commit: mB, mergedAt: now() }, published: pub, changes: [] });
backlogRepo(S).setStatus(sB.id, 'review', pB.id);
// C · ya hecha, pero su elemento del lote sigue «pendiente de aceptación».
const sC = addManualItem(S, project.id, { title: 'C hecha' });
g(repo, 'checkout', '-qb', 'portal-ia/hu-c'); commit(repo, 'c.txt', 'C'); g(repo, 'checkout', '-q', 'main'); const mC = merge('portal-ia/hu-c');
const pC = proc(sC.id, 'C', { plan: null, applied: { branch: 'portal-ia/hu-c', commit: 'x', files: [], appliedAt: now() }, merged: { into: 'main', commit: mC, mergedAt: now() }, published: pub, manualTest: { steps: ['a'], checks: [true] }, changes: [] });
backlogRepo(S).setStatus(sC.id, 'done', pC.id);
g(repo, 'push', '-q', 'origin', 'main', 'portal-ia/hu-b', 'portal-ia/hu-c');
// D · pendiente, sin lote, con una iteración esperando autorización (aparece en Decisiones).
const sD = addManualItem(S, project.id, { title: 'D pendiente' });
const pD = proc(sD.id, 'D', null, 'pending_authorization');
// E · ya hecha, con una iteración vieja aplicada sin integrar (archivada), su carpeta y su rama con trabajo propio.
const sE = addManualItem(S, project.id, { title: 'E hecha con iteración vieja' });
g(repo, 'checkout', '-qb', 'portal-ia/hu-e'); const shaE = commit(repo, 'e.txt', 'E vieja'); g(repo, 'checkout', '-q', 'main');
const pE = proc(sE.id, 'E', { plan: null, applied: { branch: 'portal-ia/hu-e', commit: shaE, files: [], appliedAt: now(), worktree: wtDir('') }, merged: null, changes: [] });
g(repo, 'worktree', 'add', '-q', wtDir(pE.id), 'portal-ia/hu-e');
workspaceDb(S).prepare(`UPDATE processes SET archived_at = ? WHERE id = ?`).run(now(), pE.id);
backlogRepo(S).setStatus(sE.id, 'done', null);
// F · carpeta de trabajo con cambios sin guardar (de una historia hecha): nunca se elige.
const sF = addManualItem(S, project.id, { title: 'F con cambios sin guardar' });
g(repo, 'branch', 'portal-ia/hu-f', 'main');
const pF = proc(sF.id, 'F', { plan: null, applied: { branch: 'portal-ia/hu-f', commit: 'x', files: [], appliedAt: now() }, merged: { into: 'main', commit: g(repo, 'rev-parse', 'main'), mergedAt: now() }, published: pub, changes: [] });
g(repo, 'worktree', 'add', '-q', wtDir(pF.id), 'portal-ia/hu-f'); fs.writeFileSync(path.join(wtDir(pF.id), 'sin-guardar.txt'), 'x');
backlogRepo(S).setStatus(sF.id, 'done', pF.id);
// Lote en pausa con A (necesita decisión), B (pendiente de aceptación) y C (hecha, pendiente de aceptación en el lote).
// «activated»: activas en el Portal en marcha (la comprobación real mira el repositorio del propio Portal, no este de prueba).
const item = (s: any, p: any, state: string) => ({ itemId: s.id, storyId: s.storyId, title: s.title, order: 0, wave: 0, dependsOn: null, state, reason: null, processId: p.id, processIds: [p.id], activated: true });
const batch = batchesRepo(S).create({ projectId: project.id, title: 'Lote: etapa anterior', status: 'paused', reason: 'pausa', auth: { projectId: project.id, itemIds: [sA.id, sB.id, sC.id], backends: ['claude_code'], totalBudgetUsd: 1, perStoryBudgetUsd: 1, maxCorrections: 0, maxDurationMin: 60, maxSubscriptionCalls: 10, gauntlet: { enabled: false }, concurrency: 1, commands: [], allowInstall: false, git: { merge: false, activate: false, publish: false }, autoResume: false }, items: [item(sA, pA, 'needs_owner'), item(sB, pB, 'awaiting_acceptance'), item(sC, pC, 'awaiting_acceptance')], events: [], activation: null, finishedAt: null, revokedAt: null } as any);
// Encargos: un borrador y uno listo para revisar cuyo trabajo ya está en main.
const enDraft = createAssignment(S, project.id, { request: 'Algo viejo', title: 'Encargo viejo', objective: 'Objetivo suficientemente largo', criteria: ['uno'] });
g(repo, 'checkout', '-qb', 'portal-ia/en-x'); commit(repo, 'en.txt', 'EN'); g(repo, 'checkout', '-q', 'main'); const mEN = merge('portal-ia/en-x');
const enReady = createAssignment(S, project.id, { request: 'Hecho', title: 'Encargo integrado', objective: 'Objetivo suficientemente largo', criteria: ['uno'] });
const pEN = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'EN', estimatedUsd: 0, backlogItemId: null, assignmentId: enReady.id, steps: [] } as any);
processesRepo(S).setResult(pEN.id, { plan: null, applied: { branch: 'portal-ia/en-x', commit: 'x', files: [], appliedAt: now() }, merged: { into: 'main', commit: mEN, mergedAt: now() }, published: pub, changes: [] } as any);
workspaceDb(S).prepare(`UPDATE processes SET status = 'done', assignment_id = ? WHERE id = ?`).run(enReady.id, pEN.id);
assignmentsRepo(S).update(enReady.id, a => { a.status = 'ready_for_review'; a.processId = pEN.id; a.processIds = [pEN.id]; });
g(repo, 'push', '-q', 'origin', 'main', 'portal-ia/en-x');
g(repo, 'branch', 'develop', 'main'); g(repo, 'push', '-q', 'origin', 'develop'); // no es del Portal: nunca se elige sola
const pB2 = proc(sB.id, 'B otra vez', null, 'pending_authorization'); // iteración nueva de B esperando autorización
projectsRepo(S).setRepository(project.id, repo, 'main');

const app = await buildApp();
after(async () => { stopBatchScheduler(); await app.close(); });
const inject = async (method: string, url: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url, payload: payload as any }); return { status: r.statusCode, json: r.json() as any }; };
const waitDone = async (id: string) => { for (let i = 0; i < 400; i++) { const p = (await inject('GET', `${W}/maintenance/plans/${id}`)).json; if (p.status !== 'running') return p; await new Promise(r => setTimeout(r, 50)); } throw new Error('no terminó'); };
const remoteHeads = () => g(repo, 'ls-remote', '--heads', 'origin').split('\n').filter(Boolean).map(l => l.split('refs/heads/')[1]).sort();
const REASON = 'Cierre de etapa: se adopta main como línea base oficial.';

test('publicar main no acumula upstreams y «git push» sin argumentos sigue funcionando', async () => {
  g(repo, 'config', '--add', 'branch.main.merge', 'refs/heads/portal-ia/hu-b'); // el estado que rompía «git push»
  await pushBranches(repo, ['main']); await pushBranches(repo, ['main']);
  assert.deepEqual(g(repo, 'config', '--get-all', 'branch.main.merge').split('\n'), ['refs/heads/main'], 'un solo upstream');
  assert.equal(g(repo, 'config', '--get-all', 'branch.main.remote'), 'origin');
  g(repo, 'push', '-q', '--dry-run');
});

test('cierre de etapa: una sola autorización deja el remoto con main, el backlog vacío y todo con su ciclo de vida', async () => {
  const created = await inject('POST', `${W}/projects/${project.id}/maintenance/plans`, { closeStage: { reason: REASON } });
  assert.equal(created.status, 200, JSON.stringify(created.json)); const plan = created.json;
  const it = (id: string) => plan.items.find((i: any) => i.id === id);
  const prep = new Map(plan.prepared.map((s: any) => [s.itemId, s]));
  assert.deepEqual(plan.intent, { kind: 'close_stage', reason: REASON, source: 'owner' }, 'pedido por la ruta del propietario');
  // Lo que se libera en la misma revisión: elegible con dependencias (no intocable).
  assert.equal(it(`worktree:${wtDir(pA.id)}`).category, 'decision');
  assert.deepEqual(([] as string[]).concat(it('local:portal-ia/hu-a').requires).sort(), [`batch:${batch.id}`, `story:${sA.id}`, `worktree:${wtDir(pA.id)}`].sort());
  assert.ok(([] as string[]).concat(it('remote:portal-ia/hu-a').requires).includes(`batch:${batch.id}`));
  assert.ok(it(`iteration:${pE.id}`), 'la iteración vieja de E aparece para descartarla');
  assert.deepEqual(([] as string[]).concat(it(`worktree:${wtDir(pE.id)}`).requires), [`iteration:${pE.id}`]);
  // Lo preparado: cada cosa con su cierre correcto y el motivo donde hace falta.
  const want: Record<string, string> = {
    [`story:${sA.id}`]: 'discard', [`story:${sB.id}`]: 'accept', [`story:${sD.id}`]: 'discard', [`batchitem:${batch.id}:${sC.id}`]: 'accept', [`batch:${batch.id}`]: 'close_batch',
    [`iteration:${pE.id}`]: 'discard_iteration', [`assignment:${enDraft.id}`]: 'cancel_assignment', [`assignment:${enReady.id}`]: 'accept_assignment',
    [`worktree:${wtDir(pA.id)}`]: 'remove_worktree', [`worktree:${wtDir(pE.id)}`]: 'remove_worktree',
    'local:portal-ia/hu-a': 'archive_delete_local', 'local:portal-ia/hu-e': 'archive_delete_local', 'local:portal-ia/hu-b': 'delete_local', 'local:portal-ia/hu-c': 'delete_local', 'local:portal-ia/en-x': 'delete_local',
    'remote:portal-ia/hu-a': 'archive_delete_remote', 'remote:portal-ia/hu-b': 'delete_remote', 'remote:portal-ia/hu-c': 'delete_remote', 'remote:portal-ia/en-x': 'delete_remote'
  };
  for (const [id, opt] of Object.entries(want)) assert.equal((prep.get(id) as any)?.option, opt, `${id} → ${opt}`);
  assert.equal((prep.get(`story:${sA.id}`) as any).reason, REASON);
  assert.ok(!prep.has(`worktree:${wtDir(pF.id)}`), 'nunca una carpeta con cambios sin guardar'); assert.ok(!prep.has('local:portal-ia/hu-f'), 'ni la rama que depende de ella');
  assert.ok(!prep.has('local:main') && !prep.has('remote:main'));
  assert.ok(!prep.has('local:develop') && !prep.has('remote:develop'), 'una rama que no creó el Portal se queda en «Conservar»');
  // Antes de autorizar no ha cambiado nada.
  assert.deepEqual(remoteHeads(), ['develop', 'main', 'portal-ia/en-x', 'portal-ia/hu-a', 'portal-ia/hu-b', 'portal-ia/hu-c']);
  assert.equal(backlogRepo(S).get(sA.id)!.status, 'review');

  // Una sola autorización: exactamente lo preparado.
  const ex = await inject('POST', `${W}/maintenance/plans/${plan.id}/execute`, { authorized: true, selection: plan.prepared });
  assert.equal(ex.status, 200, JSON.stringify(ex.json));
  const fin = await waitDone(plan.id);
  assert.equal(fin.status, 'done', JSON.stringify(fin.execution.outcomes.filter((o: any) => o.status !== 'done' && o.status !== 'noop'), null, 1));
  assert.ok(fin.execution.verification.every((v: string) => v.startsWith('✓')), fin.execution.verification.join('\n'));

  // GitHub (remoto): main intacto; de lo demás, solo lo que no creó el Portal (no se eligió).
  assert.deepEqual(remoteHeads(), ['develop', 'main']);
  assert.equal(g(bare, 'rev-parse', 'refs/heads/main'), g(repo, 'rev-parse', 'main'));
  // Local: main y la rama de la carpeta con cambios sin guardar (que se conserva).
  assert.deepEqual(g(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort(), ['develop', 'main', 'portal-ia/hu-f']);
  assert.ok(fs.existsSync(path.join(wtDir(pF.id), 'sin-guardar.txt')), 'sus cambios sin guardar siguen ahí');
  assert.ok(!fs.existsSync(wtDir(pA.id)) && !fs.existsSync(wtDir(pE.id)));
  // El trabajo no integrado quedó guardado antes de borrar sus ramas.
  const archived = g(repo, 'for-each-ref', '--format=%(objectname)', 'refs/portal-ia/archivo').split('\n');
  assert.ok(archived.includes(shaA) && archived.includes(shaE));
  // Backlog activo vacío, con verdad: A y D canceladas, B hecha con constancia, C y E siguen hechas.
  const active = backlogRepo(S).list(project.id).filter(b => b.status !== 'done' && b.status !== 'discarded');
  assert.deepEqual(active.map(b => b.storyId), []);
  assert.equal(backlogRepo(S).get(sA.id)!.status, 'discarded'); assert.equal(backlogRepo(S).get(sD.id)!.status, 'discarded'); assert.equal(backlogRepo(S).get(sB.id)!.status, 'done');
  // Lote cerrado; sus elementos, con su estado verdadero.
  const b = batchesRepo(S).get(batch.id)!; assert.notEqual(b.status, 'paused'); assert.notEqual(b.status, 'running');
  assert.deepEqual(Object.fromEntries(b.items.map(i => [i.title, i.state])), { 'A sin integrar': 'cancelled', 'B integrada': 'accepted', 'C hecha': 'accepted' });
  assert.ok(b.events.some(e => e.message.includes(REASON)), 'el motivo queda en sus eventos');
  // Iteraciones y autorizaciones pendientes resueltas; encargos cerrados con su ciclo de vida.
  assert.ok(processesRepo(S).get(pA.id)!.result!.rejected); assert.ok(processesRepo(S).get(pE.id)!.result!.rejected);
  assert.equal(processesRepo(S).get(pD.id)!.status, 'cancelled', 'la autorización pendiente de D se denegó');
  assert.equal(processesRepo(S).get(pB2.id)!.status, 'cancelled', 'B cerrada como hecha: su iteración por autorizar también se deniega');
  assert.equal(assignmentsRepo(S).get(enDraft.id)!.status, 'cancelled'); assert.equal(assignmentsRepo(S).get(enReady.id)!.status, 'accepted');
  // Decisiones: nada pendiente de la etapa anterior.
  const inbox = (await inject('GET', `${W}/inbox`)).json as any[];
  assert.deepEqual(inbox.filter(d => [pA.id, pB.id, pB2.id, pC.id, pD.id, pE.id, pEN.id].includes(d.processId)), []);
  // Repetir la misma autorización no hace nada dos veces.
  assert.equal((await inject('POST', `${W}/maintenance/plans/${plan.id}/execute`, { authorized: true, selection: plan.prepared })).status, 409);
});

test('una protección que aparece después de la revisión se respeta al ejecutar (lote nuevo en pausa)', async () => {
  const sZ = addManualItem(S, project.id, { title: 'Z' });
  g(repo, 'checkout', '-qb', 'portal-ia/hu-z'); commit(repo, 'z.txt', 'Z'); g(repo, 'checkout', '-q', 'main'); const mZ = merge('portal-ia/hu-z');
  g(repo, 'push', '-q', 'origin', 'main', 'portal-ia/hu-z');
  const p = (await inject('POST', `${W}/projects/${project.id}/maintenance/plans`)).json;
  const pZ = proc(sZ.id, 'Z', { plan: null, applied: { branch: 'portal-ia/hu-z', commit: 'x', files: [], appliedAt: now() }, merged: { into: 'main', commit: mZ, mergedAt: now() }, published: pub, changes: [] });
  backlogRepo(S).setStatus(sZ.id, 'review', pZ.id);
  batchesRepo(S).create({ projectId: project.id, title: 'Lote nuevo', status: 'paused', reason: 'pausa', auth: { projectId: project.id, itemIds: [sZ.id], backends: ['claude_code'], totalBudgetUsd: 1, perStoryBudgetUsd: 1, maxCorrections: 0, maxDurationMin: 60, maxSubscriptionCalls: 10, gauntlet: { enabled: false }, concurrency: 1, commands: [], allowInstall: false, git: { merge: false, activate: false, publish: false }, autoResume: false }, items: [item(sZ, pZ, 'awaiting_acceptance')], events: [], activation: null, finishedAt: null, revokedAt: null } as any);
  await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'local:portal-ia/hu-z', option: 'delete_local' }, { itemId: 'remote:portal-ia/hu-z', option: 'delete_remote' }] });
  const f = await waitDone(p.id);
  assert.ok(f.execution.outcomes.every((o: any) => o.status === 'skipped'), JSON.stringify(f.execution.outcomes));
  assert.ok(remoteHeads().includes('portal-ia/hu-z') && g(repo, 'branch', '--list', 'portal-ia/hu-z'), 'sus ramas siguen (el lote nuevo las protege)');
});

test('reanudar tras una interrupción después de las historias cierra el lote y termina (la huella descuenta lo ya hecho)', async () => {
  const s1 = addManualItem(S, project.id, { title: 'R1 sin integrar' });
  const p1 = proc(s1.id, 'R1', null);
  backlogRepo(S).setStatus(s1.id, 'review', p1.id);
  const b = batchesRepo(S).create({ projectId: project.id, title: 'Lote a reanudar', status: 'paused', reason: 'pausa', auth: { projectId: project.id, itemIds: [s1.id], backends: ['claude_code'], totalBudgetUsd: 1, perStoryBudgetUsd: 1, maxCorrections: 0, maxDurationMin: 60, maxSubscriptionCalls: 10, gauntlet: { enabled: false }, concurrency: 1, commands: [], allowInstall: false, git: { merge: false, activate: false, publish: false }, autoResume: false }, items: [item(s1, p1, 'needs_owner')], events: [], activation: null, finishedAt: null, revokedAt: null } as any);
  const plan = (await inject('POST', `${W}/projects/${project.id}/maintenance/plans`)).json;
  const sel = [{ itemId: `story:${s1.id}`, option: 'discard', reason: 'Etapa cerrada' }, { itemId: `batch:${b.id}`, option: 'close_batch', reason: 'Etapa cerrada' }];
  // Primera ejecución «interrumpida» justo después de la historia: se simula guardando solo su resultado.
  const { cancelItem } = await import('../src/services/batchRunner.ts'); const { discardStory } = await import('../src/services/backlog.ts');
  cancelItem(S, b.id, s1.id, { tick: false }); discardStory(S, s1.id, 'Etapa cerrada', { allowUnmergedBranch: true });
  const doc = { ...plan, status: 'partial', execution: { startedAt: now(), finishedAt: now(), selection: sel, outcomes: [{ itemId: `story:${s1.id}`, option: 'discard', status: 'done', message: 'Cancelada.', at: now() }], verification: [], interrupted: true } };
  workspaceDb(S).prepare(`UPDATE maintenance_plans SET status = 'partial', doc_json = ? WHERE id = ?`).run(JSON.stringify(doc), plan.id);
  assert.equal((await inject('POST', `${W}/maintenance/plans/${plan.id}/execute`, { authorized: true, selection: sel })).status, 200);
  const f = await waitDone(plan.id);
  assert.equal(f.status, 'done', JSON.stringify(f.execution.outcomes)); assert.notEqual(batchesRepo(S).get(b.id)!.status, 'paused', 'el lote se cerró al reanudar');
});

test('las filas de auditoría del mantenimiento no cuentan como «llamadas» de hoy', async () => {
  const before = projectsRepo(S).usageToday().calls;
  processesRepo(S).logExecution({ projectId: project.id, agentId: '', kind: 'maintenance:delete_local:done:x', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: now() } as any);
  processesRepo(S).logExecution({ projectId: project.id, agentId: '', kind: 'policy:git_branch_delete', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: now() } as any);
  assert.equal(projectsRepo(S).usageToday().calls, before);
});

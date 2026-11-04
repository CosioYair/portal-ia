import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Revisión del proyecto (ramas, worktrees, backlog frente a main) con un repositorio REAL y un remoto «bare» local:
 * clasificación verdadera, autorización explícita, solo lo seleccionado, verificación independiente del remoto,
 * historial conservado, y los casos adversos (main cambia, rama cambia, remoto caído o que rechaza, ejecución doble,
 * interrupción y reanudación, otra empresa, rechazo). Sin IA ni red externa.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-mant-'));
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
const { buildApp } = await import('./fixtures/owner-app.ts'); // con el propietario vinculado (todo cambio lo exige)
const { addManualItem } = await import('../src/services/backlog.ts');
const { threadRepo } = await import('../src/services/storyThread.ts');
const { CAPABILITIES } = await import('../src/services/capabilities.ts');
const { prepareOperations, truthfulReply, withReviewFacts, assistantRepo } = await import('../src/services/assistant.ts');
const { reviewFactsBlock, withoutReviewFacts, REVIEW_PENDING_POINTER } = await import('../src/services/reviewFacts.ts');
const { recoverInterruptedPlans, setPlanSource, getPlan, explainRemoteError } = await import('../src/services/projectMaintenance.ts');
const { conversationsRepo } = await import('../src/db/conversations.ts');
const { stopBatchScheduler } = await import('../src/services/batchRunner.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-mant-repo-'));
const repo = path.join(tmp, 'repo'); const bare = path.join(tmp, 'remoto.git');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const commit = (cwd: string, file: string, msg: string) => { fs.writeFileSync(path.join(cwd, file), `${msg}\n`); g(cwd, 'add', '-A'); g(cwd, 'commit', '-qm', msg); return g(cwd, 'rev-parse', 'HEAD'); };
fs.mkdirSync(repo); g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
g(repo, 'init', '-q', '-b', 'main'); commit(repo, 'base.txt', 'Base'); g(repo, 'remote', 'add', 'origin', bare); g(repo, 'push', '-q', 'origin', 'main');
// Integrada (en main y en el remoto), sin integrar (en el remoto y local), de un lote en pausa, de un proceso en curso.
g(repo, 'checkout', '-qb', 'portal-ia/hu-001'); commit(repo, 'a.txt', 'HU-001'); g(repo, 'checkout', '-q', 'main'); g(repo, 'merge', '-q', '--ff-only', 'portal-ia/hu-001'); g(repo, 'push', '-q', 'origin', 'main', 'portal-ia/hu-001');
g(repo, 'checkout', '-qb', 'portal-ia/hu-002'); const unmergedSha = commit(repo, 'b.txt', 'HU-002 sin integrar'); g(repo, 'checkout', '-q', 'main'); g(repo, 'push', '-q', 'origin', 'portal-ia/hu-002');
g(repo, 'checkout', '-qb', 'portal-ia/hu-003'); commit(repo, 'c.txt', 'HU-003 del lote'); g(repo, 'checkout', '-q', 'main'); g(repo, 'push', '-q', 'origin', 'portal-ia/hu-003');
g(repo, 'checkout', '-qb', 'portal-ia/hu-004'); commit(repo, 'd.txt', 'HU-004 en curso'); g(repo, 'checkout', '-q', 'main');
g(repo, 'branch', 'viejo-integrado', 'main~0');
// Worktree del Portal (<repo>-worktrees/<proceso>) con una rama integrada, y otro de otra herramienta.
const wtProc = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'HU-005', estimatedUsd: 0, backlogItemId: null, steps: [] } as any);
workspaceDb(S).prepare(`UPDATE processes SET status = 'done' WHERE id = ?`).run(wtProc.id); // terminado: su worktree ya no está en uso
g(repo, 'branch', 'portal-ia/hu-005', 'main');
g(repo, 'worktree', 'add', '-q', path.join(tmp, 'repo-worktrees', wtProc.id), 'portal-ia/hu-005');
g(repo, 'worktree', 'add', '-q', '-b', 'ajena', path.join(tmp, 'otra-herramienta'));
projectsRepo(S).setRepository(project.id, repo, 'main');
const remoteHeads = () => g(repo, 'ls-remote', '--heads', 'origin').split('\n').filter(Boolean).map(l => l.split('refs/heads/')[1]).sort();

// Historias y procesos: integrada y probada (se puede cerrar), nunca implementada, en un lote en pausa, en curso.
const sDone = addManualItem(S, project.id, { title: 'Integrada y probada' });
const pDone = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'it', estimatedUsd: 0, backlogItemId: sDone.id, steps: [] } as any);
processesRepo(S).setResult(pDone.id, { plan: null, applied: { branch: 'portal-ia/hu-001', commit: 'x', files: [], appliedAt: new Date().toISOString() }, merged: { into: 'main', commit: g(repo, 'rev-parse', 'main'), mergedAt: new Date().toISOString() }, manualTest: { steps: ['probar'], checks: [true] } } as any);
workspaceDb(S).prepare(`UPDATE processes SET status = 'done' WHERE id = ?`).run(pDone.id);
backlogRepo(S).setStatus(sDone.id, 'review', pDone.id);
const sNever = addManualItem(S, project.id, { title: 'Nunca implementada' });
const sBatch = addManualItem(S, project.id, { title: 'En el lote en pausa' });
const pBatch = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'lote', estimatedUsd: 0, backlogItemId: sBatch.id, steps: [] } as any);
processesRepo(S).setResult(pBatch.id, { plan: null, applied: { branch: 'portal-ia/hu-003', commit: 'x', files: [], appliedAt: new Date().toISOString() }, merged: null } as any);
workspaceDb(S).prepare(`UPDATE processes SET status = 'done' WHERE id = ?`).run(pBatch.id);
backlogRepo(S).setStatus(sBatch.id, 'review', pBatch.id);
const batch = batchesRepo(S).create({ projectId: project.id, title: 'Lote protegido', status: 'paused', reason: 'pausa de prueba', auth: {}, items: [{ itemId: sBatch.id, storyId: sBatch.storyId, title: sBatch.title, order: 0, wave: 0, dependsOn: null, state: 'needs_owner', reason: 'decide', processId: pBatch.id, processIds: [pBatch.id] }], events: [], activation: null, finishedAt: null, revokedAt: null } as any);
const sRun = addManualItem(S, project.id, { title: 'En curso' });
const pRun = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'curso', estimatedUsd: 0, backlogItemId: sRun.id, steps: [] } as any);
processesRepo(S).setResult(pRun.id, { plan: null, applied: { branch: 'portal-ia/hu-004', commit: 'x', files: [], appliedAt: new Date().toISOString() }, merged: null } as any);
workspaceDb(S).prepare(`UPDATE processes SET status = 'running' WHERE id = ?`).run(pRun.id);
backlogRepo(S).setStatus(sRun.id, 'in_progress', pRun.id);

const app = await buildApp();
after(async () => { stopBatchScheduler(); await app.close(); });
const OWNER = await (await import('./fixtures/owner.ts')).ownerHeaders(); // decidir revisiones y operaciones exige la sesión del propietario
const inject = async (method: string, url: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url, payload: (payload ?? (method === 'POST' ? {} : undefined)) as any, headers: OWNER }); return { status: r.statusCode, json: r.json() as any }; };
const plan = async () => { const r = await inject('POST', `${W}/projects/${project.id}/maintenance/plans`); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const waitDone = async (id: string) => { for (let i = 0; i < 200; i++) { const p = (await inject('GET', `${W}/maintenance/plans/${id}`)).json; if (p.status !== 'running') return p; await new Promise(r => setTimeout(r, 50)); } throw new Error('no terminó'); };
const item = (p: any, id: string) => p.items.find((i: any) => i.id === id);

test('revisión de solo lectura: clasificación verdadera de ramas, worktrees, historias y lotes', async () => {
  const before = { local: g(repo, 'branch', '--format=%(refname:short)'), remote: remoteHeads() };
  const p = await plan();
  assert.equal(p.status, 'proposed'); assert.equal(p.repo.remoteAvailable, true); assert.equal(p.repo.mainBranch, 'main');
  assert.equal(item(p, 'remote:portal-ia/hu-001').category, 'safe'); assert.equal(item(p, 'remote:portal-ia/hu-001').defaultOption, 'delete_remote');
  const un = item(p, 'remote:portal-ia/hu-002'); assert.equal(un.category, 'decision'); assert.equal(un.unique, 1); assert.equal(un.defaultOption, 'keep'); assert.match(un.uniqueCommits[0], /HU-002 sin integrar/);
  assert.equal(item(p, 'remote:main').category, 'protected'); assert.equal(item(p, 'local:main').category, 'protected');
  // Rama de un lote en pausa: no es intocable, pero solo se puede elegir junto con cerrar ese lote en esta misma revisión.
  const lb = item(p, 'local:portal-ia/hu-003');
  assert.match(item(p, 'remote:portal-ia/hu-003').reason, /cerrar el lote «Lote protegido»/); assert.equal(lb.category, 'decision'); assert.equal(lb.defaultOption, 'keep');
  assert.ok(([] as string[]).concat(lb.requires).includes(`batch:${batch.id}`), 'depende de cerrar el lote');
  assert.equal(item(p, 'local:portal-ia/hu-004').category, 'protected', 'rama de un proceso en curso');
  assert.equal(item(p, 'local:viejo-integrado').category, 'decision', 'no es rama de historia: integrada, pero decides tú'); assert.equal(item(p, 'local:viejo-integrado').defaultOption, 'keep');
  assert.ok(item(p, 'local:viejo-integrado').options.some((o: any) => o.id === 'delete_local'));
  const wt = p.items.find((i: any) => i.kind === 'worktree' && i.processId === wtProc.id); assert.equal(wt.category, 'safe');
  assert.deepEqual(([] as string[]).concat(item(p, 'local:portal-ia/hu-005').requires), [wt.id], 'su rama exige retirar antes el worktree');
  assert.equal(p.items.find((i: any) => i.kind === 'worktree' && /otra-herramienta/.test(i.name)).category, 'outside');
  assert.equal(item(p, 'local:ajena').category, 'protected');
  assert.equal(item(p, `story:${sDone.id}`).category, 'safe'); assert.equal(item(p, `story:${sDone.id}`).defaultOption, 'close_done');
  assert.equal(item(p, `story:${sNever.id}`).category, 'decision'); assert.ok(!item(p, `story:${sNever.id}`).options.some((o: any) => o.id === 'close_done'), 'lo no implementado nunca se ofrece como hecho');
  assert.equal(item(p, `story:${sRun.id}`).category, 'protected');
  assert.equal(item(p, `batch:${batch.id}`).category, 'decision'); assert.equal(item(p, `batch:${batch.id}`).defaultOption, 'keep', 'el lote en pausa solo se cierra si se elige');
  // Revisar no cambió nada.
  assert.deepEqual({ local: g(repo, 'branch', '--format=%(refname:short)'), remote: remoteHeads() }, before);
});

test('autorización explícita, objetivos válidos y motivo cuando cierra trabajo', async () => {
  const p = await plan();
  assert.equal((await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { selection: [{ itemId: 'remote:portal-ia/hu-001', option: 'delete_remote' }] })).status, 400, 'sin authorized:true no se ejecuta');
  assert.equal((await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'local:main', option: 'delete_local' }] })).json.code, 'protected_item');
  assert.equal((await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: `story:${sNever.id}`, option: 'discard' }] })).json.code, 'reason_required');
  assert.equal((await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: `story:${sNever.id}`, option: 'close_done' }] })).json.code, 'invalid_option');
  assert.equal((await inject('GET', `${W}/maintenance/plans/${p.id}`)).json.status, 'proposed', 'una petición rechazada no toca el plan');
});

test('ejecuta SOLO lo seleccionado, verifica el remoto de forma independiente y conserva el historial', async () => {
  const p = await plan();
  const sel = [
    { itemId: 'remote:portal-ia/hu-001', option: 'delete_remote' },
    { itemId: 'local:portal-ia/hu-001', option: 'delete_local' },
    { itemId: `story:${sDone.id}`, option: 'close_done' },
    { itemId: `story:${sNever.id}`, option: 'discard', reason: 'Obsoleta: main ya lo resuelve' },
    { itemId: 'remote:portal-ia/hu-002', option: 'keep' }
  ];
  const r = await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: sel });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const again = await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: sel });
  assert.equal(again.status, 409, 'una segunda ejecución simultánea no corre');
  const fin = await waitDone(p.id);
  assert.equal(fin.status, 'done', JSON.stringify(fin.execution.outcomes));
  const heads = remoteHeads();
  assert.ok(!heads.includes('portal-ia/hu-001')); assert.ok(heads.includes('portal-ia/hu-002'), 'lo no seleccionado (y no integrado) sigue'); assert.ok(heads.includes('main'));
  assert.ok(!g(repo, 'branch', '--list', 'portal-ia/hu-001'));
  assert.ok(fin.execution.verification.some((v: string) => /✓ origin\/portal-ia\/hu-001 ya no está en el remoto/.test(v)));
  assert.equal(backlogRepo(S).get(sDone.id)!.status, 'done'); assert.equal(backlogRepo(S).get(sNever.id)!.status, 'discarded');
  assert.match(backlogRepo(S).get(sNever.id)!.description ?? '', /Descartada: Obsoleta: main ya lo resuelve/);
  assert.ok(threadRepo(S).messages(sDone.id).some(m => /Cerrada como hecha en la revisión del proyecto/.test(m.content)), 'el cierre queda en el hilo');
  assert.ok(fin.execution.outcomes.find((o: any) => o.itemId === 'remote:portal-ia/hu-001').recovery.includes('git push origin'), 'dice cómo recuperarla');
  assert.equal((await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: sel })).status, 409, 'un plan terminado no se repite');
  const audit = workspaceDb(S).prepare(`SELECT kind FROM execution_history WHERE kind LIKE 'policy:git_remote_branch_delete:%' OR kind LIKE 'policy:backlog_maintenance:%'`).all() as any[];
  assert.ok(audit.length >= 3, 'cada operación pasa por la política (auditoría)');
});

test('trabajo no integrado: solo con elección expresa, y queda guardado en refs/portal-ia/archivo', async () => {
  const p = await plan();
  const r = await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'remote:portal-ia/hu-002', option: 'archive_delete_remote' }, { itemId: 'local:portal-ia/hu-002', option: 'archive_delete_local' }] });
  assert.equal(r.status, 200);
  const fin = await waitDone(p.id); assert.equal(fin.status, 'done', JSON.stringify(fin.execution.outcomes));
  const copies = g(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/portal-ia/archivo').split('\n').filter(l => l.includes('portal-ia/hu-002'));
  assert.equal(copies.length, 2, 'una copia por origen (local y remoto), con nombre único'); assert.ok(copies.every(l => l.endsWith(unmergedSha)), 'su trabajo sigue recuperable');
  assert.ok(fin.execution.verification.some((v: string) => /✓ copia guardada/.test(v)), 'la verificación comprueba las copias');
  assert.ok(!remoteHeads().includes('portal-ia/hu-002')); assert.ok(!g(repo, 'branch', '--list', 'portal-ia/hu-002'));
});

test('worktree del Portal y su rama en la misma revisión: primero el worktree; el ajeno nunca', async () => {
  const p = await plan();
  const wt = p.items.find((i: any) => i.kind === 'worktree' && i.processId === wtProc.id);
  const solo = await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'local:portal-ia/hu-005', option: 'delete_local' }] });
  assert.equal(solo.status, 200); const f1 = await waitDone(p.id);
  assert.equal(f1.execution.outcomes[0].status, 'skipped'); assert.match(f1.execution.outcomes[0].message, /Retirar la carpeta de trabajo/);
  const p2 = await plan();
  await inject('POST', `${W}/maintenance/plans/${p2.id}/execute`, { authorized: true, selection: [{ itemId: wt.id, option: 'remove_worktree' }, { itemId: 'local:portal-ia/hu-005', option: 'delete_local' }] });
  const f2 = await waitDone(p2.id); assert.equal(f2.status, 'done', JSON.stringify(f2.execution.outcomes));
  assert.ok(!fs.existsSync(path.join(tmp, 'repo-worktrees', wtProc.id))); assert.ok(fs.existsSync(path.join(tmp, 'otra-herramienta')), 'el worktree ajeno sigue');
});

test('estado cambiado: si main avanza el plan caduca entero; si una rama cambia, esa no se toca', async () => {
  const p = await plan();
  commit(repo, 'main2.txt', 'main avanza');
  await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'local:viejo-integrado', option: 'delete_local' }] });
  const f = await waitDone(p.id); assert.equal(f.status, 'stale'); assert.ok(g(repo, 'branch', '--list', 'viejo-integrado'), 'nada se borró');
  assert.equal((await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'local:viejo-integrado', option: 'delete_local' }] })).status, 409, 'un plan caducado no se ejecuta');
  const q = await plan();
  g(repo, 'branch', '-f', 'viejo-integrado', 'main'); // la rama apunta a otro commit desde la revisión
  await inject('POST', `${W}/maintenance/plans/${q.id}/execute`, { authorized: true, selection: [{ itemId: 'local:viejo-integrado', option: 'delete_local' }] });
  const f2 = await waitDone(q.id); assert.equal(f2.execution.outcomes[0].status, 'skipped'); assert.ok(g(repo, 'branch', '--list', 'viejo-integrado'));
});

test('el remoto rechaza (rama protegida o sin permiso): se explica, no se fuerza y se puede reintentar', async () => {
  g(repo, 'checkout', '-qb', 'portal-ia/hu-010'); commit(repo, 'e.txt', 'HU-010'); g(repo, 'checkout', '-q', 'main'); g(repo, 'merge', '-q', '--ff-only', 'portal-ia/hu-010'); g(repo, 'push', '-q', 'origin', 'main', 'portal-ia/hu-010');
  // El remoto no deja borrar (como una rama protegida), sin gancho ejecutable: en el sandbox Linux /tmp no permite ejecutar,
  // el gancho no corría y la prueba fallaba en main, cargándose a cualquier historia verificada allí (HU-177).
  g(bare, 'config', 'receive.denyDeletes', 'true');
  // El mensaje de GitHub (regla de rama protegida) se explica igual; se comprueba sin depender de ganchos.
  assert.match(explainRemoteError('remote: error: GH006: Protected branch update failed for refs/heads/main.'), /protege esta rama/);
  const p = await plan();
  await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'remote:portal-ia/hu-010', option: 'delete_remote' }] });
  const f = await waitDone(p.id);
  assert.equal(f.status, 'partial'); assert.equal(f.execution.outcomes[0].status, 'failed'); assert.match(f.execution.outcomes[0].message, /protege esta rama/);
  assert.ok(remoteHeads().includes('portal-ia/hu-010'));
  g(bare, 'config', 'receive.denyDeletes', 'false');
  assert.equal((await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'remote:portal-ia/hu-010', option: 'delete_remote' }] })).status, 200, 'reintentar lo que falló');
  const f2 = await waitDone(p.id); assert.equal(f2.status, 'done'); assert.ok(!remoteHeads().includes('portal-ia/hu-010'));
});

test('interrupción: un plan «en ejecución» que no corre se reanuda sin repetir lo hecho', async () => {
  const p = await plan();
  const doc = { ...p, status: 'running', execution: { startedAt: new Date().toISOString(), finishedAt: null, selection: [], outcomes: [], verification: [] } };
  workspaceDb(S).prepare(`UPDATE maintenance_plans SET status = 'running', doc_json = ? WHERE id = ?`).run(JSON.stringify(doc), p.id);
  const got = (await inject('GET', `${W}/maintenance/plans/${p.id}`)).json;
  assert.equal(got.status, 'partial'); assert.equal(got.execution.interrupted, true);
  assert.equal((await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'local:viejo-integrado', option: 'delete_local' }] })).status, 200);
  assert.equal((await waitDone(p.id)).status, 'done');
});

test('remoto no disponible: lo local se revisa igual y no se ofrece borrar nada en el remoto', async () => {
  g(repo, 'remote', 'set-url', 'origin', path.join(tmp, 'no-existe.git'));
  try {
    const p = await plan();
    assert.equal(p.repo.remoteAvailable, false); assert.match(p.repo.remoteError, /No se pudo conectar con el remoto/);
    assert.ok(!p.items.some((i: any) => i.kind === 'remote_branch'));
  } finally { g(repo, 'remote', 'set-url', 'origin', bare); }
});

test('aislamiento: otra empresa no ve ni ejecuta la revisión; rechazar no toca nada', async () => {
  const p = await plan();
  const other = await inject('POST', '/api/workspaces', { name: 'Otra empresa de prueba' });
  const slug2 = other.json.slug ?? other.json.workspace?.slug;
  assert.ok(slug2);
  assert.equal((await inject('GET', `/api/workspaces/${slug2}/maintenance/plans/${p.id}`)).status, 404);
  assert.equal((await inject('POST', `/api/workspaces/${slug2}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'local:viejo-integrado', option: 'delete_local' }] })).status, 404);
  assert.equal((await inject('POST', `/api/workspaces/${slug2}/projects/${project.id}/maintenance/plans`)).status, 404, 'el proyecto de otra empresa no existe aquí');
  const before = remoteHeads();
  assert.equal((await inject('POST', `${W}/maintenance/plans/${p.id}/reject`)).json.status, 'rejected');
  assert.equal((await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'local:viejo-integrado', option: 'delete_local' }] })).status, 409);
  assert.deepEqual(remoteHeads(), before);
});

test('lote en pausa: solo se cierra eligiéndolo con motivo; su historia se cancela con verdad', async () => {
  const p = await plan();
  await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: `story:${sBatch.id}`, option: 'discard', reason: 'Sustituida por el rediseño' }, { itemId: `batch:${batch.id}`, option: 'close_batch', reason: 'Revisión: trabajo obsoleto' }] });
  const f = await waitDone(p.id); assert.equal(f.status, 'done', JSON.stringify(f.execution.outcomes));
  assert.equal(backlogRepo(S).get(sBatch.id)!.status, 'discarded');
  const b = batchesRepo(S).get(batch.id)!; assert.notEqual(b.status, 'paused'); assert.ok(b.events.some(e => /Revisión: trabajo obsoleto/.test(e.message)), 'el motivo queda en sus eventos');
  assert.ok(g(repo, 'branch', '--list', 'portal-ia/hu-003'), 'su rama no se borró en la misma revisión');
});

test('el Asistente: la capacidad prepara la revisión (sin ejecutar) y lo que falta se propone como desarrollo', async () => {
  const pv = await CAPABILITIES.reconcile_project.preview({ company: S, project: project.id });
  assert.equal(pv.ok, true); assert.ok(pv.planId); assert.match(pv.reviewPath!, /\/mantenimiento\//);
  assert.ok(pv.details.some(d => /Requiere tu decisión/.test(d))); assert.ok(pv.details.some(d => /Nada se ejecuta desde aquí/.test(d)));
  await assert.rejects(() => CAPABILITIES.reconcile_project.execute({ company: S, project: project.id }), /pantalla/);
  const generic = await prepareOperations([{ type: 'request_operation', capability: 'borrar_todo', purpose: 'limpiar' }], { conversationId: 'conv-1', workspaceSlug: null, projectId: null } as any);
  assert.ok(generic.every(a => a.type === 'info'), 'un borrado genérico nunca se propone desarrollar');
  // Lo que falta se propone desarrollar con un ENCARGO en borrador (sin historia: solo se crean si el propietario las pide).
  const stories = backlogRepo(S).list(project.id).length;
  const missing = await prepareOperations([{ type: 'request_operation', capability: 'exportar_backlog', purpose: 'compartirlo' }], { conversationId: 'conv-1', workspaceSlug: null, projectId: null } as any);
  assert.equal(missing[0].type, 'info'); assert.equal(missing[1].type, 'propose_assignment'); assert.equal(missing[1].status, 'pending');
  const { assignmentsRepo } = await import('../src/db/assignments.ts');
  const en = assignmentsRepo(S).get(missing[1].assignmentId!)!;
  assert.equal(en.status, 'draft', 'borrador: no se ejecuta nada hasta que lo autorizas'); assert.equal(en.conversationId, 'conv-1', 'enlaza la conversación para retomarla');
  assert.match(en.request, /conv-1/); assert.ok(en.criteria.length >= 2);
  assert.equal(backlogRepo(S).list(project.id).length, stories, 'no se crea ninguna historia');
  const again = await prepareOperations([{ type: 'request_operation', capability: 'exportar_backlog', purpose: 'otra vez' }], { conversationId: 'conv-1', workspaceSlug: null, projectId: null } as any);
  assert.equal(again.length, 1); assert.match(again[0].detail ?? '', new RegExp(`Ya hay un encargo para desarrollarla: ${en.code}`), 'sin duplicados');
});

test('copias que nunca se sobrescriben: rama local con un commit más que la del remoto', async () => {
  g(repo, 'checkout', '-qb', 'portal-ia/hu-020'); const l1 = commit(repo, 'g1.txt', 'L1'); g(repo, 'push', '-q', 'origin', 'portal-ia/hu-020'); const l2 = commit(repo, 'g2.txt', 'L2 solo local'); g(repo, 'checkout', '-q', 'main');
  const p = await plan();
  await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'local:portal-ia/hu-020', option: 'archive_delete_local' }, { itemId: 'remote:portal-ia/hu-020', option: 'archive_delete_remote' }] });
  const f = await waitDone(p.id); assert.equal(f.status, 'done', JSON.stringify(f.execution.outcomes));
  const refs = g(repo, 'for-each-ref', '--format=%(objectname)', 'refs/portal-ia/archivo').split('\n');
  assert.ok(refs.includes(l2), 'L2 (solo local) sigue guardado'); assert.ok(refs.includes(l1), 'L1 (remoto) también');
});

test('rama del remoto integrada en main LOCAL pero main sin publicar: no se ofrece borrarla', async () => {
  g(repo, 'checkout', '-qb', 'portal-ia/hu-030'); commit(repo, 'h.txt', 'HU-030'); g(repo, 'checkout', '-q', 'main'); g(repo, 'push', '-q', 'origin', 'portal-ia/hu-030');
  g(repo, 'merge', '-q', '--no-ff', '-m', 'integra HU-030', 'portal-ia/hu-030'); // main local avanza; el del remoto no
  const p = await plan();
  const it = item(p, 'remote:portal-ia/hu-030');
  assert.equal(it.category, 'decision'); assert.match(it.status, /main no está publicado/); assert.deepEqual(it.options.map((o: any) => o.id), ['keep']);
  g(repo, 'push', '-q', 'origin', 'main');
});

test('historia reabierta (pendiente) con una iteración en main: nunca se ofrece como hecha', async () => {
  const s = addManualItem(S, project.id, { title: 'Reabierta por el propietario' });
  const pr = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'reab', estimatedUsd: 0, backlogItemId: s.id, steps: [] } as any);
  processesRepo(S).setResult(pr.id, { plan: null, applied: { branch: 'x', commit: 'x', files: [], appliedAt: new Date().toISOString() }, merged: { into: 'main', commit: g(repo, 'rev-parse', 'main'), mergedAt: new Date().toISOString() }, manualTest: { steps: ['a'], checks: [true] } } as any);
  workspaceDb(S).prepare(`UPDATE processes SET status = 'done' WHERE id = ?`).run(pr.id);
  backlogRepo(S).setStatus(s.id, 'pending', pr.id);
  const p = await plan(); const it = item(p, `story:${s.id}`);
  assert.equal(it.category, 'decision'); assert.ok(!it.options.some((o: any) => o.id === 'close_done')); assert.match(it.status, /Reabierta/);
});

test('cancelar una historia con trabajo sin integrar: esa iteración ya no se ofrece ni se puede integrar', async () => {
  const s = addManualItem(S, project.id, { title: 'Con rama sin integrar' });
  g(repo, 'checkout', '-qb', 'portal-ia/hu-040'); commit(repo, 'i.txt', 'HU-040'); g(repo, 'checkout', '-q', 'main');
  const pr = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'sin integrar', estimatedUsd: 0, backlogItemId: s.id, steps: [] } as any);
  processesRepo(S).setResult(pr.id, { plan: null, applied: { branch: 'portal-ia/hu-040', commit: 'x', files: [], appliedAt: new Date().toISOString(), worktree: null }, merged: null, changes: [] } as any);
  workspaceDb(S).prepare(`UPDATE processes SET status = 'done' WHERE id = ?`).run(pr.id);
  backlogRepo(S).setStatus(s.id, 'review', pr.id);
  const p = await plan();
  const br = item(p, 'local:portal-ia/hu-040');
  assert.equal(br.category, 'decision', 'pendiente de integrar: solo junto con cancelar su historia'); assert.equal(br.defaultOption, 'keep');
  assert.ok(([] as string[]).concat(br.requires).includes(`story:${s.id}`)); assert.match(br.reason, /Solo si en esta misma revisión también eliges: cancelar/);
  await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: `story:${s.id}`, option: 'discard', reason: 'Ya no se quiere' }] });
  assert.equal((await waitDone(p.id)).status, 'done');
  assert.ok(processesRepo(S).get(pr.id)!.result!.rejected, 'la iteración queda descartada');
  const inbox = (await inject('GET', `${W}/inbox`)).json as any[];
  assert.ok(!inbox.some(d => d.processId === pr.id && d.kind === 'integrate'), 'Decisiones ya no propone integrarla');
  const { mergeStory } = await import('../src/services/storyMerge.ts');
  await assert.rejects(() => mergeStory(S, pr.id), /descartó|cancelada/);
  const q = await plan(); assert.notEqual(item(q, 'local:portal-ia/hu-040').category, 'protected', 'ya puede revisarse su rama');
});

test('rechazar: solo una revisión sin empezar; una ejecutada en parte no se «rechaza»', async () => {
  g(repo, 'branch', 'para-rechazo', 'main');
  const p = await plan();
  const ex = await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'local:para-rechazo', option: 'delete_local' }, { itemId: 'remote:portal-ia/hu-030', option: 'keep' }] });
  assert.equal(ex.status, 200, JSON.stringify(ex.json));
  const f = await waitDone(p.id); assert.ok(['done', 'partial'].includes(f.status));
  const r = await inject('POST', `${W}/maintenance/plans/${p.id}/reject`); assert.equal(r.status, 409);
  const sel = f.execution.selection.find((x: any) => x.itemId === 'remote:portal-ia/hu-030'); assert.equal(sel?.option, 'keep', 'lo que se dejó en «Conservar» queda guardado');
});

test('el Asistente: alcance antes de revisar, sinónimos al catálogo y nombres prohibidos', async () => {
  const before = (await inject('GET', `${W}/projects/${project.id}/maintenance/plans`)).json.length;
  const other = await inject('POST', '/api/workspaces', { name: 'Empresa ajena' }); const slug2 = other.json.slug ?? other.json.workspace?.slug;
  const out = await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id }], { conversationId: 'c-x', workspaceSlug: slug2, projectId: null } as any);
  assert.equal(out[0].type, 'info'); assert.equal((await inject('GET', `${W}/projects/${project.id}/maintenance/plans`)).json.length, before, 'no se revisó ni se guardó nada de otra empresa');
  const syn = await prepareOperations([{ type: 'request_operation', capability: 'delete_remote_branches', company: S, project: project.id }], { conversationId: 'c-y', workspaceSlug: S, projectId: project.id } as any);
  assert.equal(syn[0].type, 'propose_operation'); assert.equal(syn[0].operation!.capability, 'reconcile_project', 'lo que el catálogo ya cubre no se propone desarrollar');
  const proto = await prepareOperations([{ type: 'request_operation', capability: 'constructor' }], { conversationId: 'c-p', workspaceSlug: null, projectId: null } as any);
  assert.ok(!proto.some(a => a.type === 'propose_operation'), 'un nombre de prototipo no rompe ni prepara nada del catálogo');
  for (const bad of ['run_script', 'read_env_file', 'skip_authorization', 'git_push_overwrite']) {
    const r = await prepareOperations([{ type: 'request_operation', capability: bad }], { conversationId: 'c-z', workspaceSlug: null, projectId: null } as any);
    assert.ok(r.every(a => a.type === 'info'), `${bad}: nunca se propone desarrollar`);
  }
});

// ------------------------------------------------------------------ GAUNTLET, segunda ronda
/** Una historia integrada en main y probada, en un lote nuevo con el estado dado. */
const storyInBatch = (title: string, batchStatus: 'paused' | 'running', itemState: string, extra: any[] = []) => {
  const st = addManualItem(S, project.id, { title });
  const pr = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title, estimatedUsd: 0, backlogItemId: st.id, steps: [] } as any);
  processesRepo(S).setResult(pr.id, { plan: null, applied: { branch: `portal-ia/x-${st.id.slice(0, 6)}`, commit: 'x', files: [], appliedAt: new Date().toISOString() }, merged: { into: 'main', commit: g(repo, 'rev-parse', 'main'), mergedAt: new Date().toISOString() }, manualTest: { steps: ['a', 'b'], checks: [true, true] } } as any);
  workspaceDb(S).prepare(`UPDATE processes SET status = 'done' WHERE id = ?`).run(pr.id);
  backlogRepo(S).setStatus(st.id, 'review', pr.id);
  const b = batchesRepo(S).create({ projectId: project.id, title: `Lote de ${title}`, status: batchStatus, reason: null, auth: {}, items: [{ itemId: st.id, storyId: st.storyId, title: st.title, order: 0, wave: 0, dependsOn: null, state: itemState, reason: null, processId: pr.id, processIds: [pr.id] }, ...extra], events: [], activation: null, finishedAt: null, revokedAt: null } as any);
  return { st, pr, b };
};

test('lote en pausa: aceptar nunca viene marcado; reabierta o con una iteración más reciente fuera del lote, no se ofrece', async () => {
  const a = storyInBatch('Esperando aceptación en pausa', 'paused', 'awaiting_acceptance');
  let p = await plan(); let it = item(p, `story:${a.st.id}`);
  assert.equal(it.category, 'decision'); assert.equal(it.defaultOption, 'keep', 'tocar un lote en pausa es decisión expresa'); assert.ok(it.options.some((o: any) => o.id === 'accept'));
  backlogRepo(S).setStatus(a.st.id, 'pending', a.pr.id); // «Devolver a pendiente»
  p = await plan(); it = item(p, `story:${a.st.id}`);
  assert.deepEqual(it.options.map((o: any) => o.id), ['keep'], 'reabierta: nunca se ofrece como hecha'); assert.match(it.status, /Reabierta/);
  backlogRepo(S).setStatus(a.st.id, 'review', a.pr.id);
  const p2 = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'nueva', estimatedUsd: 0, backlogItemId: a.st.id, steps: [] } as any);
  processesRepo(S).setResult(p2.id, { plan: null, applied: { branch: 'portal-ia/nueva-iter', commit: 'x', files: [], appliedAt: new Date().toISOString() }, merged: null } as any);
  workspaceDb(S).prepare(`UPDATE processes SET status = 'done' WHERE id = ?`).run(p2.id);
  backlogRepo(S).setStatus(a.st.id, 'review', p2.id);
  p = await plan(); it = item(p, `story:${a.st.id}`);
  assert.deepEqual(it.options.map((o: any) => o.id), ['keep']); assert.match(it.status, /iteración más reciente/);
});

test('aceptar comprueba otra vez la regla de cierre al ejecutar (sin motivo, no se acepta)', async () => {
  const a = storyInBatch('Aceptar con prueba cambiada', 'running', 'awaiting_acceptance');
  const p = await plan(); assert.equal(item(p, `story:${a.st.id}`).category, 'safe');
  processesRepo(S).setResult(a.pr.id, { ...processesRepo(S).get(a.pr.id)!.result!, manualTest: { steps: ['a', 'b'], checks: [true, false] } } as any); // desmarcó un paso tras revisar
  await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: `story:${a.st.id}`, option: 'accept' }] });
  const f = await waitDone(p.id); const o = f.execution.outcomes.find((x: any) => x.itemId === `story:${a.st.id}`);
  assert.equal(o.status, 'failed'); assert.match(o.message, /regla de cierre/); assert.notEqual(backlogRepo(S).get(a.st.id)!.status, 'done');
  workspaceDb(S).prepare(`UPDATE batches SET status = 'cancelled' WHERE id = ?`).run(a.b.id);
});

test('cancelar una historia de un lote en pausa no mueve las demás historias del lote', async () => {
  const other = addManualItem(S, project.id, { title: 'Otra del lote en pausa' });
  const a = storyInBatch('Cancelar en pausa', 'paused', 'needs_owner', [{ itemId: other.id, storyId: other.storyId, title: other.title, order: 1, wave: 0, dependsOn: null, state: 'queued', reason: null, processId: null, processIds: [] }]);
  const p = await plan();
  await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: `story:${a.st.id}`, option: 'discard', reason: 'Ya no hace falta' }] });
  assert.equal((await waitDone(p.id)).status, 'done');
  await new Promise(r => setTimeout(r, 300));
  const b = batchesRepo(S).get(a.b.id)!;
  assert.equal(b.status, 'paused'); assert.equal(b.items.find(i => i.itemId === other.id)!.state, 'queued', 'la otra historia sigue igual');
  assert.equal(b.items.find(i => i.itemId === a.st.id)!.state, 'cancelled');
  workspaceDb(S).prepare(`UPDATE batches SET status = 'cancelled' WHERE id = ?`).run(a.b.id);
});

test('git: retirar una carpeta no «poda» otra ajena cuya carpeta falta un momento', async () => {
  const pr = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'wt', estimatedUsd: 0, backlogItemId: null, steps: [] } as any);
  workspaceDb(S).prepare(`UPDATE processes SET status = 'done' WHERE id = ?`).run(pr.id);
  g(repo, 'worktree', 'add', '-q', '--detach', path.join(tmp, 'repo-worktrees', pr.id), 'main');
  const usb = path.join(tmp, 'usb-wt'); g(repo, 'worktree', 'add', '-q', '--detach', usb, 'main');
  fs.renameSync(usb, `${usb}-fuera`); // «disco desconectado»
  try {
    const p = await plan();
    await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: `worktree:${path.join(tmp, 'repo-worktrees', pr.id)}`, option: 'remove_worktree' }] });
    assert.equal((await waitDone(p.id)).status, 'done');
  } finally { fs.renameSync(`${usb}-fuera`, usb); }
  assert.ok(g(repo, 'worktree', 'list', '--porcelain').toLowerCase().includes(path.basename(usb).toLowerCase()), 'la carpeta ajena sigue registrada');
  g(repo, 'worktree', 'remove', '--force', usb);
});

test('git: revisar no escribe referencias (ni refs/remotes) aunque traiga objetos', async () => {
  const clone = path.join(tmp, 'clon2'); g(tmp, 'clone', '-q', bare, clone);
  g(clone, 'checkout', '-qb', 'portal-ia/hu-050'); commit(clone, 'z.txt', 'HU-050 de otro equipo'); g(clone, 'push', '-q', 'origin', 'portal-ia/hu-050');
  const refs = () => g(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
  const before = refs();
  const p = await plan();
  assert.equal(refs(), before, 'ninguna referencia cambió');
  assert.match(item(p, 'remote:portal-ia/hu-050').status, /Contiene 1 cambio/, 'los objetos sí se trajeron para contar sus cambios');
  g(clone, 'push', '-q', 'origin', '--delete', 'portal-ia/hu-050');
});

test('git: la rama activa sigue protegida aunque exista una etiqueta con su mismo nombre', async () => {
  g(repo, 'branch', 'portal-ia/hu-060', 'main'); g(repo, 'tag', 'portal-ia/hu-060', 'main');
  g(repo, 'checkout', '-q', 'portal-ia/hu-060');
  try { const p = await plan(); assert.equal(item(p, 'local:portal-ia/hu-060').category, 'protected'); }
  finally { g(repo, 'checkout', '-q', 'main'); g(repo, 'tag', '-d', 'portal-ia/hu-060'); g(repo, 'branch', '-D', 'portal-ia/hu-060'); }
});

test('git: la copia de una rama con paréntesis en el nombre se verifica bien', async () => {
  g(repo, 'checkout', '-qb', 'feat(ui)'); const sha = commit(repo, 'ui.txt', 'UI sin integrar'); g(repo, 'checkout', '-q', 'main');
  const p = await plan();
  await inject('POST', `${W}/maintenance/plans/${p.id}/execute`, { authorized: true, selection: [{ itemId: 'local:feat(ui)', option: 'archive_delete_local' }] });
  const f = await waitDone(p.id); assert.equal(f.status, 'done', JSON.stringify(f.execution.verification));
  assert.ok(f.execution.verification.some((v: string) => v.startsWith('✓ copia guardada') && v.endsWith('/local/feat(ui)')));
  assert.equal(f.execution.outcomes[0].archiveRef.endsWith('/local/feat(ui)'), true); assert.equal(g(repo, 'rev-parse', f.execution.outcomes[0].archiveRef), sha);
});

test('otra empresa con el mismo repositorio: sus ramas y carpetas quedan protegidas (sin nombrarla)', async () => {
  const other = await inject('POST', '/api/workspaces', { name: 'Empresa con el mismo repo' }); const slug2 = other.json.slug ?? other.json.workspace?.slug;
  const pr2 = projectsRepo(slug2).create({ slug: 'mismo', name: 'Mismo repo', description: '' }); projectsRepo(slug2).setRepository(pr2.id, repo, 'main');
  const proc2 = processesRepo(slug2).create({ projectId: pr2.id, kind: 'story_execution', title: 'ajeno', estimatedUsd: 0, backlogItemId: null, steps: [] } as any);
  processesRepo(slug2).setResult(proc2.id, { plan: null, applied: { branch: 'portal-ia/hu-070', commit: 'x', files: [], appliedAt: new Date().toISOString() }, merged: { into: 'main', commit: g(repo, 'rev-parse', 'main'), mergedAt: new Date().toISOString() } } as any);
  g(repo, 'branch', 'portal-ia/hu-070', 'main~0');
  const p = await plan(); const it = item(p, 'local:portal-ia/hu-070');
  assert.equal(it.category, 'protected'); assert.match(it.reason, /otra empresa/); assert.ok(!JSON.stringify(p).includes('Empresa con el mismo repo'), 'no se nombra la otra empresa');
});

test('el Asistente: una revisión pendiente en la misma conversación no se duplica; «Revisar de nuevo» conserva la tarjeta', async () => {
  const conv = conversationsRepo.create('Limpieza', S, project.id);
  const sc = { conversationId: conv.id, workspaceSlug: S, projectId: project.id } as any;
  const [first] = await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id }], sc);
  assert.equal(first.type, 'propose_operation');
  const msg = assistantRepo.add({ role: 'assistant', content: 'Te preparo la revisión.', actions: [first], attachments: [], tokensIn: 0, tokensOut: 0, costUsd: 0, model: null }, conv.id);
  CAPABILITIES.reconcile_project.onLink!(first.operation!.preview, { messageId: msg.id, operationId: first.operation!.id, conversationId: conv.id });
  const again = await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id }], sc);
  assert.equal(again[0].type, 'info'); assert.match(again[0].label, /Ya está pendiente/);
  // Desde la pantalla: «Revisar de nuevo» con la revisión de la tarjeta → la tarjeta pasa a la nueva (sin decir «sustituida»).
  const oldId = first.operation!.preview.planId!;
  const r = await inject('POST', `${W}/projects/${project.id}/maintenance/plans`, { from: oldId }); const fresh = r.json;
  assert.notEqual(fresh.id, oldId); assert.equal(fresh.source?.messageId, msg.id);
  const card = assistantRepo.get(msg.id)!.actions[0];
  assert.equal(card.status, 'pending'); assert.equal(card.operation!.preview.planId, fresh.id); assert.match(card.operation!.preview.reviewPath!, new RegExp(`${fresh.id}$`));
  assert.equal(getPlan(S, oldId).source, null);
});

test('arranque: un plan que quedó «en ejecución» pasa a «a medias» y su tarjeta lo dice', async () => {
  const p = await plan();
  const doc = { ...p, status: 'running', execution: { startedAt: new Date().toISOString(), finishedAt: null, selection: [], outcomes: [], verification: [], runner: 'arranque-anterior' } };
  workspaceDb(S).prepare(`UPDATE maintenance_plans SET status = 'running', doc_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(doc), new Date().toISOString(), p.id);
  assert.ok(recoverInterruptedPlans() >= 1);
  const got = (await inject('GET', `${W}/maintenance/plans/${p.id}`)).json; assert.equal(got.status, 'partial'); assert.equal(got.execution.interrupted, true);
});

test('el Asistente: «ya borré» se corrige también con tildes; una pregunta no; sinónimos solo de limpieza; alcance antes de listar proyectos', async () => {
  const pending = [{ type: 'propose_operation', status: 'pending', operation: { preview: { planId: 'x' } } }] as any;
  for (const t of ['Listo, borré las 12 ramas.', 'Eliminé las ramas obsoletas.', 'Cerré el lote.', 'Las ramas ya fueron borradas.', 'Hemos borrado lo obsoleto.', 'Ya borramos las ramas.', 'Borradas las 12 ramas.', 'Branches deleted.']) assert.match(truthfulReply(t, pending), /Nota del Portal/, t);
  assert.doesNotMatch(truthfulReply('¿Quieres que borre las ramas integradas?', pending), /Nota del Portal/);
  const merge = await prepareOperations([{ type: 'request_operation', capability: 'merge_branch', company: S, project: project.id }], { conversationId: 'c-m', workspaceSlug: S, projectId: project.id } as any);
  assert.ok(!merge.some(a => a.type === 'propose_operation'), 'integrar una rama no es la revisión de limpieza');
  const other = await inject('POST', '/api/workspaces', { name: 'Empresa vecina' }); const slug3 = other.json.slug ?? other.json.workspace?.slug;
  projectsRepo(slug3).create({ slug: 'secreto-a', name: 'Proyecto secreto A', description: '' }); projectsRepo(slug3).create({ slug: 'secreto-b', name: 'Proyecto secreto B', description: '' });
  const out = await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: slug3 }], { conversationId: 'c-n', workspaceSlug: S, projectId: null } as any);
  assert.equal(out[0].type, 'info'); assert.doesNotMatch(JSON.stringify(out), /secreto/i, 'no se listan proyectos de otra empresa');
  for (const bad of ['execute_code', 'read_dotenv', 'delete_repository', 'accept_all_stories', 'git_reset_hard', 'grant_agent_tools', 'export_database', 'update_remote_url', 'integrate_without_review', 'create_admin_user', 'update_budget_limits']) {
    const r = await prepareOperations([{ type: 'request_operation', capability: bad }], { conversationId: 'c-z', workspaceSlug: null, projectId: null } as any);
    assert.ok(r.every(a => a.type === 'info'), `${bad}: nunca se propone desarrollar`);
  }
});

test('dos conversaciones piden la misma revisión: ninguna anula la tarjeta de la otra hasta que se ejecuta una', async () => {
  g(repo, 'branch', '-f', 'viejo-integrado', 'main');
  const c1 = conversationsRepo.create('Uno', S, project.id); const c2 = conversationsRepo.create('Dos', S, project.id);
  const ask = async (c: any) => { const [a] = await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id }], { conversationId: c.id, workspaceSlug: S, projectId: project.id } as any);
    const m = assistantRepo.add({ role: 'assistant', content: 'Revisión', actions: [a], attachments: [], tokensIn: 0, tokensOut: 0, costUsd: 0, model: null }, c.id);
    CAPABILITIES.reconcile_project.onLink!(a.operation!.preview, { messageId: m.id, operationId: a.operation!.id, conversationId: c.id }); return { m, id: a.operation!.preview.planId! }; };
  const one = await ask(c1); const two = await ask(c2);
  assert.notEqual(one.id, two.id); assert.equal(getPlan(S, one.id).status, 'proposed', 'la de la otra conversación sigue pendiente');
  await inject('POST', `${W}/maintenance/plans/${two.id}/execute`, { authorized: true, selection: [{ itemId: 'local:viejo-integrado', option: 'delete_local' }] });
  await waitDone(two.id);
  assert.equal(getPlan(S, one.id).status, 'stale'); assert.match(assistantRepo.get(one.m.id)!.actions[0].detail!, /Sustituida por otra revisión/);
});

test('rama abierta en una carpeta con cambios sin guardar: nunca viene marcada ni elige retirar la carpeta', async () => {
  const pr = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'sucia', estimatedUsd: 0, backlogItemId: null, steps: [] } as any);
  workspaceDb(S).prepare(`UPDATE processes SET status = 'done' WHERE id = ?`).run(pr.id);
  const wt = path.join(tmp, 'repo-worktrees', pr.id);
  g(repo, 'branch', 'portal-ia/hu-090', 'main'); g(repo, 'worktree', 'add', '-q', wt, 'portal-ia/hu-090'); fs.writeFileSync(path.join(wt, 'sin-guardar.txt'), 'x');
  const p = await plan();
  assert.equal(item(p, `worktree:${wt}`).category, 'decision');
  const br = item(p, 'local:portal-ia/hu-090'); assert.equal(br.category, 'decision'); assert.equal(br.defaultOption, 'keep'); assert.match(br.reason, /cambios sin guardar/);
  g(repo, 'worktree', 'remove', '--force', wt);
});

test('«Revisar de nuevo» tras una ejecución parcial: la tarjeta sigue a la nueva y cuenta lo hecho antes; sinónimos', async () => {
  g(repo, 'branch', '-f', 'viejo-integrado', 'main'); g(repo, 'branch', '-f', 'portal-ia/hu-095', 'main');
  const conv = conversationsRepo.create('Parcial', S, project.id);
  const [a] = await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id }], { conversationId: conv.id, workspaceSlug: S, projectId: project.id } as any);
  const m = assistantRepo.add({ role: 'assistant', content: 'Revisión', actions: [a], attachments: [], tokensIn: 0, tokensOut: 0, costUsd: 0, model: null }, conv.id);
  CAPABILITIES.reconcile_project.onLink!(a.operation!.preview, { messageId: m.id, operationId: a.operation!.id, conversationId: conv.id });
  const first = a.operation!.preview.planId!;
  await inject('POST', `${W}/maintenance/plans/${first}/execute`, { authorized: true, selection: [{ itemId: 'local:viejo-integrado', option: 'delete_local' }] });
  assert.equal((await waitDone(first)).status, 'done');
  const fresh = (await inject('POST', `${W}/projects/${project.id}/maintenance/plans`, { from: first })).json;
  assert.equal(fresh.source?.messageId, m.id); assert.equal(fresh.continuesFrom?.done, 1);
  const card = assistantRepo.get(m.id)!.actions[0];
  assert.equal(card.operation!.preview.planId, fresh.id); assert.match(card.detail!, /1 hecho\(s\) antes/); assert.ok(card.operation!.preview.details.some(d => /Ya integrado/.test(d)));
  const review = await prepareOperations([{ type: 'request_operation', capability: 'review_story', company: S, project: project.id }], { conversationId: 'c-r', workspaceSlug: S, projectId: project.id } as any);
  assert.ok(!review.some(x => x.type === 'propose_operation'), 'revisar una historia no es la limpieza');
  const local = await prepareOperations([{ type: 'request_operation', capability: 'add_backlog_item' }], { conversationId: 'c-l', workspaceSlug: S, projectId: project.id } as any);
  assert.equal(local.length, 1); assert.match(local[0].detail!, /ya puede proponer/);
});

const hintText = () => CAPABILITIES.reconcile_project.promptHint;
test('el Asistente presenta la revisión con los datos reales del Portal y los pasos exactos (sin «Autorizar» inventado)', async () => {
  const conv = conversationsRepo.create('Datos reales', S, project.id);
  const acts = await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id }], { conversationId: conv.id, workspaceSlug: S, projectId: project.id } as any);
  const out = withReviewFacts('Te preparo la revisión.', acts);
  const pv = acts[0].operation!.preview;
  assert.match(out, /^Te preparo la revisión\./); assert.match(out, /Datos reales de la revisión \(al prepararla, /); assert.match(out, /no se había ejecutado nada; el estado actual está en la tarjeta/);
  for (const d of pv.details.filter(d => /^(Ya integrado|Requiere tu decisión|Protegido)/.test(d))) assert.ok(out.includes(d), `incluye «${d}»`);
  assert.match(out, /«Abrir la revisión para elegir y autorizar»/); assert.match(out, /autoriza una sola vez/);
  // Los objetivos reales, con las opciones que de verdad ofrecen: lo protegido no aparece como elegible.
  const plan0 = getPlan(S, pv.planId!);
  assert.match(out, /\*\*Requiere tu decisión\*\* \(todo empieza en «Conservar»\)/); assert.match(out, /\*\*Protegido\*\* \(no se puede elegir\)/);
  const { reasonHead } = await import('../src/services/reviewFacts.ts');
  for (const it of plan0.items.filter(i => i.category === 'protected').slice(0, 5)) assert.ok(out.includes(reasonHead(it.reason)), `motivo de «${it.name}»`);
  const keepOnly = plan0.items.find(i => i.category === 'decision' && i.options.length === 1);
  if (keepOnly) assert.match(out, /solo se puede conservar/);
  assert.match(hintText(), /qué opciones tendrá cada historia, rama o carpeta concreta/);
  assert.ok(pv.details.filter(d => /^(Remoto|Fuera)/.test(d)).every(d => out.includes(d)), 'remoto y fuera del alcance también');
  assert.equal(withoutReviewFacts(out), 'Te preparo la revisión.', 'el historial del modelo no arrastra la foto');
  // Nada que limpiar: no se dan pasos que no aplican.
  const empty = reviewFactsBlock('P', ['Repositorio: r', 'Remoto: origin', 'Ya integrado — seguro: nada', 'Requiere tu decisión: nada', 'Protegido — no se toca: 1 rama(s) locales', 'Nada se ejecuta desde aquí']);
  assert.match(empty, /Nada que limpiar en lo que se pudo comprobar/, 'remoto sin comprobar: no se dice que todo está limpio');
  const clean = reviewFactsBlock('P', ['Remoto: origin (3 rama(s), comprobado en vivo)', 'Ya integrado — seguro: nada', 'Requiere tu decisión: nada', 'Protegido — no se toca: 1 rama(s) locales']);
  assert.match(clean, /No hay nada que limpiar ahora/); assert.doesNotMatch(clean, /Cómo seguir/);
  assert.equal(withoutReviewFacts(`Ya la tienes.\n\n${REVIEW_PENDING_POINTER}`), 'Ya la tienes.', 'el aviso de «ya pendiente» tampoco vuelve al historial');
  // Ya pendiente en esta conversación: sin tarjeta nueva, pero con sus cifras y cómo seguir.
  const again = await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id }, { type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id }], { conversationId: conv.id, workspaceSlug: S, projectId: project.id } as any);
  assert.equal(again.filter(x => x.type === 'propose_operation').length, 1, 'dos peticiones iguales en una respuesta: una sola tarjeta');
  assert.match(again[1].label, /Ya incluida arriba/);
  assert.equal(withReviewFacts('Hola.', [{ type: 'info', status: 'done', label: 'x' } as any]), 'Hola.', 'sin revisión preparada no se añade nada');
  const hint = CAPABILITIES.reconcile_project.promptHint;
  assert.match(hint, /NO tiene botón «Autorizar»/); assert.match(hint, /no las inventes/);
});

test('propuesta agrupada: cada objetivo con sus opciones reales y lo protegido con su motivo', async () => {
  const mk = (o: any) => ({ kind: 'local_branch', category: 'decision', status: '', reason: '', options: [{ id: 'keep', label: 'Conservar' }], defaultOption: 'keep', fingerprint: '', consequences: '', recovery: null, ...o });
  const lines = (await import('../src/services/reviewFacts.ts')).proposalLines([
    mk({ id: 's1', kind: 'story', name: 'HU-1 · Uno', story: { storyId: 'HU-1' }, options: [{ id: 'keep', label: 'Conservar' }, { id: 'discard', label: 'Cancelar (no se hará)' }] }),
    mk({ id: 'b1', name: 'feat/x', options: [{ id: 'keep', label: 'Conservar' }, { id: 'archive_delete_local', label: 'Guardar copia y borrar' }] }),
    mk({ id: 'k1', name: 'raro', reason: 'Sus commits no están en este equipo: no se puede saber si están en main.', options: [{ id: 'keep', label: 'Conservar' }] }),
    mk({ id: 'p1', category: 'protected', name: 'portal-ia/hu-9', reason: 'Protegida por el lote «Sprint 3: pagos» (en pausa): no se puede borrar mientras el lote siga abierto.' }),
    mk({ id: 'p3', category: 'protected', name: 'portal-ia/hu-8', reason: 'Protegida por el lote «Sprint 3: cobros» (en pausa): no se puede borrar mientras el lote siga abierto.' }),
    mk({ id: 'p2', category: 'protected', name: 'main', reason: 'Es la rama principal: nunca se borra.' }),
    mk({ id: 'b2', kind: 'batch', category: 'protected', name: 'Lote *urgente* _v2_', reason: 'Un lote en marcha no se cierra desde aquí.' })
  ] as any);
  assert.deepEqual(lines, ['**Requiere tu decisión** (todo empieza en «Conservar»):', '- HU-1 → conservar o cancelar (no se hará)', '- `feat/x` → conservar o guardar copia y borrar', '- `raro` → solo se puede conservar (Sus commits no están en este equipo)',
    '**Protegido** (no se puede elegir):', '- Protegida por el lote «`Sprint 3: pagos`» (en pausa): `portal-ia/hu-9`', '- Protegida por el lote «`Sprint 3: cobros`» (en pausa): `portal-ia/hu-8`', '- Es la rama principal: `main`', '- Un lote en marcha no se cierra desde aquí: lote `Lote *urgente* _v2_`'],
    'títulos con «: » no cortan ni mezclan grupos; los nombres van como código');
});

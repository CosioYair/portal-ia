import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * EN-009 · Cierre de encargos y avisos «Publicar». Sin red ni IA: proveedor simulado, repositorio git temporal y un
 * remoto bare LOCAL (el push va a una carpeta). Los procesos se crean directamente en la base (sin ejecutar el motor).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en009-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;
const here = path.dirname(fileURLToPath(import.meta.url));

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { assignmentsRepo } = await import('../src/db/assignments.ts');
const { createAssignment, acceptAssignment, syncAssignment } = await import('../src/services/assignments.ts');
const { commitInOriginMain, markPublishedIncluded } = await import('../src/services/publishedSync.ts');
const { listPendingDecisions } = await import('../src/services/inbox.ts');
const { publishProjectMain } = await import('../src/services/capabilities.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];

// Repositorio con main y un remoto bare local (sin red).
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en009-repo-'));
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en009-bare-'));
const g = (args: string, cwd = repo) => execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
let n = 0;
const commit = (msg: string) => { n++; fs.writeFileSync(path.join(repo, `f${n}.txt`), `${msg}\n`); g('add -A'); g(`-c user.email=t@t -c user.name=t commit -qm "${msg}"`); return g('rev-parse HEAD'); };
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'en009', version: '1.0.0', private: true }, null, 2));
g('init -q -b main');
const base = commit('Base');
g('init -q --bare .', bare);
g(`remote add origin "${bare}"`);
g('push -q -u origin main');
projectsRepo(S).setRepository(project.id, repo, 'main');

const app = await buildApp();
after(async () => { await app.close(); });
const inject = (method: string, u: string, payload?: unknown) => app.inject({ method: method as any, url: u, payload: payload as any });

const now = () => new Date().toISOString();
const resultOf = (sha: string, extra: Record<string, unknown> = {}) => ({
  plan: null, implementationSummary: 'simulado', changes: [], verifyCommands: [], review: null, verifications: [],
  applied: { branch: `portal-ia/en009-${sha.slice(0, 7)}`, commit: sha, files: ['f.txt'], appliedAt: now() },
  merged: { into: 'main', commit: sha, mergedAt: now() }, ...extra
}) as any;
const tested = { manualTest: { steps: ['Abrir el proceso y comprobar el cambio'], checks: [true], note: null } };
function mkProc(title: string, sha: string, extra: Record<string, unknown> = {}, assignmentId?: string) {
  const p = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title, estimatedUsd: 0, steps: [], ...(assignmentId ? { assignmentId } : {}) } as any);
  processesRepo(S).authorize(p.id, 1);
  processesRepo(S).setResult(p.id, resultOf(sha, extra));
  processesRepo(S).finish(p.id, 'done', null as any);
  return processesRepo(S).get(p.id)!;
}
/** Encargo con un proceso integrado (done) como vigente; su estado sale del proceso (listo para revisar). */
function mkAssignment(title: string, extra: Record<string, unknown> = {}) {
  const a = createAssignment(S, project.id, { request: `Quiero ${title}`, title, objective: `Que ${title} quede hecho.`, criteria: ['Queda hecho', 'typecheck, test y build en verde'] });
  const p = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title, estimatedUsd: 0, steps: [], assignmentId: a.id } as any);
  assignmentsRepo(S).update(a.id, x => { x.processId = p.id; x.processIds = [p.id]; x.status = 'running'; });
  processesRepo(S).authorize(p.id, 1);
  processesRepo(S).setResult(p.id, resultOf(base, extra));
  processesRepo(S).finish(p.id, 'done', null as any);
  syncAssignment(S, a.id);
  return { a: assignmentsRepo(S).get(a.id)!, p: processesRepo(S).get(p.id)! };
}
const decisionIds = async () => (await listPendingDecisions(app, S)).map(d => d.id);

test('(a) un encargo listo para revisar y que cumple la regla de cierre se acepta', async () => {
  const { a } = mkAssignment('aceptar listo', tested);
  assert.equal(a.status, 'ready_for_review', a.reason ?? '');
  const r = await acceptAssignment(S, a.id, null);
  assert.equal(r.status, 'accepted');
});

test('(b) con closingBlocker, sin motivo da 409 con el motivo exacto; con ownerReason se acepta', async () => {
  const { a } = mkAssignment('aceptar con bloqueo'); // sin prueba manual → bloquea la regla de cierre
  const r1 = await inject('POST', `${W}/assignments/${a.id}/accept`, {});
  assert.equal(r1.statusCode, 409, r1.body);
  assert.equal(r1.json().code, 'no_test'); assert.match(r1.json().error, /prueba manual/);
  const r2 = await inject('POST', `${W}/assignments/${a.id}/accept`, { ownerReason: 'Probado a mano fuera del Portal' });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json().status, 'accepted');
  assert.ok(r2.json().events.some((e: any) => e.kind === 'accepted' && /Probado a mano fuera del Portal/.test(e.message)), 'el motivo queda en sus eventos');
});

test('(c) integrado en main y en «cambios pedidos»: se acepta con motivo y la nota queda descartada; con una ejecución en marcha, 409', async () => {
  const { a } = mkAssignment('integrado con cambios pedidos', tested);
  assignmentsRepo(S).update(a.id, x => { x.status = 'changes_requested'; x.iterationNote = 'Ajustar el texto del botón'; });
  await assert.rejects(acceptAssignment(S, a.id, null), (e: any) => e.statusCode === 409 && e.code === 'owner_reason_required');
  const ok = await acceptAssignment(S, a.id, null, { ownerReason: 'Ya está en main y me sirve así' });
  assert.equal(ok.status, 'accepted');
  assert.equal(ok.iterationNote, null);
  assert.ok(ok.events.some(e => /Nota pendiente descartada al aceptar: Ajustar el texto del botón/.test(e.message)), JSON.stringify(ok.events.map(e => e.message)));

  const { a: b } = mkAssignment('integrado con ejecución en marcha', tested);
  const running = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'otra ejecución', estimatedUsd: 0, steps: [], assignmentId: b.id } as any);
  processesRepo(S).authorize(running.id, 1);
  assignmentsRepo(S).update(b.id, x => { x.status = 'changes_requested'; x.processIds = [...x.processIds, running.id]; x.iterationNote = 'Otra cosa'; });
  try {
    await assert.rejects(acceptAssignment(S, b.id, null, { ownerReason: 'Lo cierro igualmente' }), (e: any) => e.statusCode === 409 && e.code === 'active_process');
    assert.equal(assignmentsRepo(S).get(b.id)!.status, 'changes_requested', 'no cambia nada');
  } finally { processesRepo(S).finish(running.id, 'cancelled', 'fin de la prueba'); }
});

test('(d) tras publicar en origin, markPublishedIncluded marca el proceso y su «Publicar» sale de Decisiones', async () => {
  const c1 = commit('Cambio integrado uno');
  const p1 = mkProc('integrado y publicado luego', c1);
  assert.ok((await decisionIds()).includes(`publish:${p1.id}`), 'antes de publicar sí se pide');
  g('push -q origin main');
  const marked = await markPublishedIncluded(S, project.id);
  assert.ok(marked.includes(p1.id), JSON.stringify(marked));
  const fresh = processesRepo(S).get(p1.id)!;
  assert.deepEqual(fresh.result!.published!.branches, ['main']); assert.equal(fresh.result!.published!.remote, 'origin');
  assert.ok(!(await decisionIds()).includes(`publish:${p1.id}`));
  assert.deepEqual(await markPublishedIncluded(S, project.id), [], 'una segunda llamada no vuelve a marcar nada');
});

test('(e) sin red: con origin/main avanzado a mano no se pide «Publicar»; con un commit fuera de origin/main, sí', async () => {
  const c2 = commit('Cambio integrado dos');
  const p2 = mkProc('integrado, remoto avanzado a mano', c2);
  assert.ok((await decisionIds()).includes(`publish:${p2.id}`));
  g(`update-ref refs/remotes/origin/main ${c2}`); // simula la referencia local del remoto, sin fetch
  assert.equal(await commitInOriginMain(repo, c2, 'main'), true);
  assert.ok(!(await decisionIds()).includes(`publish:${p2.id}`), 'ya está en origin/main');
  assert.ok(!processesRepo(S).get(p2.id)!.result!.published, 'la bandeja solo lee: no marca nada');
  const c3 = commit('Cambio integrado tres');
  const p3 = mkProc('integrado sin publicar', c3);
  assert.equal(await commitInOriginMain(repo, c3, 'main'), false);
  assert.ok((await decisionIds()).includes(`publish:${p3.id}`), 'fuera de origin/main sí se pide');
  assert.equal(await commitInOriginMain(repo, '--all', 'main'), false, 'un valor que no es un hash no llega a git');
  assert.equal(await commitInOriginMain(repo, c3, 'no-existe'), false, 'sin la referencia, false sin lanzar');
});

test('(f) publishProjectMain (operación publish_main) marca los procesos que la publicación incluye', async () => {
  const c4 = commit('Cambio integrado cuatro');
  const p4 = mkProc('integrado antes de publicar main', c4);
  const res = await publishProjectMain(S, project.id);
  assert.ok(res.markedPublished >= 1, JSON.stringify(res));
  assert.equal(g('rev-parse refs/remotes/origin/main'), c4);
  assert.ok(processesRepo(S).get(p4.id)!.result!.published);
  const ids = await decisionIds();
  assert.ok(!ids.some(id => id === `publish:${p4.id}`));
});

test('cableado de la interfaz: «Aceptar el encargo» en el proceso y aceptar con motivo en el chat', () => {
  const web = path.join(here, '..', '..', 'web', 'src');
  const story = fs.readFileSync(path.join(web, 'components', 'StoryOverview.tsx'), 'utf8');
  const panel = fs.readFileSync(path.join(web, 'components', 'ConversationPanel.tsx'), 'utf8');
  const api = fs.readFileSync(path.join(web, 'lib', 'api.ts'), 'utf8');
  assert.match(story, /Aceptar el encargo/);
  assert.match(story, /proc\.assignmentId \?/, 'en un encargo no se pinta «Marcar historia como completada»');
  assert.match(panel, /api\.acceptAssignment\(slug, a\.id, null\)/);
  assert.match(panel, /api\.acceptAssignment\(slug, a\.id, null, motivo/);
  assert.match(panel, /Aceptar con tu motivo/);
  assert.match(api, /ownerReason/);
});

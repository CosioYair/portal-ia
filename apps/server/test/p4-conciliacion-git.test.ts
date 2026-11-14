import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Portal IA 4 · El estado sale de los hechos de git. EN-028 y HU-214 quedaron «detenidos» con su código verificado en
 * una rama; al consolidar el repositorio ese código entra en la rama principal dentro de una rama candidata que lo
 * contiene. El Portal debe reconocerlo solo: el trabajo pasa a «integrado, falta tu aceptación». Con un repositorio
 * git de verdad; sin IA.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p4git-'));
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.LOG_LEVEL = 'warn';

const { INTERNAL_WORKSPACE, classifyModel } = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { assignmentsRepo } = await import('../src/db/assignments.ts');
const { reconcileIntegrated } = await import('../src/services/deliveredReconcile.ts');
const { workView } = await import('../src/services/work.ts');
const { DEFAULT_PIPELINE } = await import('../../../packages/domain/src/pipeline.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-5-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = INTERNAL_WORKSPACE.slug; const project = projectsRepo(S).list()[0];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p4repo-'));
const g = (cmd: string) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd: dir, encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n'); execSync('git init -q -b main', { cwd: dir }); g('add -A'); g('commit -qm Base');
const base = g('rev-parse HEAD');
projectsRepo(S).setRepository(project.id, dir, 'main');

/** Un trabajo aplicado en su rama (commit verificado), detenido sin integrar: como EN-028. */
function stoppedWork(code: string, branch: string, file: string): { processId: string; assignmentId: string; commit: string } {
  g(`checkout -q -b ${branch} main`); fs.writeFileSync(path.join(dir, file), `${code}\n`); g('add -A'); g(`commit -qm "${code}: unidad 1"`);
  const commit = g('rev-parse HEAD'); g('checkout -q main');
  const asg = assignmentsRepo(S); const procs = processesRepo(S);
  const en = asg.create({ projectId: project.id, owner: 'owner', request: code, title: code, objective: '', criteria: ['c'], outOfScope: [], size: 'S', status: 'needs_owner', reason: null, conversationId: null, messageId: null, processId: null, processIds: [] } as any);
  const p = procs.create({ projectId: project.id, kind: 'story_execution', title: `${en.code} · ${code}`, estimatedUsd: 0, assignmentId: en.id, steps: [] });
  procs.setResult(p.id, { changes: [{ path: file, content: code }], verifications: [], review: { approve: true, verdict: 'approved', summary: 's', issues: [], findings: [] }, baseCommit: base,
    applied: { branch, commit, worktree: path.join(dir, '..', `wt-${branch.replace(/\W/g, '-')}`), files: [file] },
    pipeline: { state: 'stopped', pauseKind: 'gauntlet', reason: 'Falta la evidencia visual.', config: { ...DEFAULT_PIPELINE }, failures: [], events: [], corrections: 1 } } as any);
  procs.finish(p.id, 'done'); asg.update(en.id, x => { x.processId = p.id; x.processIds = [p.id]; });
  return { processId: p.id, assignmentId: en.id, commit };
}

test('un trabajo cuyo commit verificado entra en main dentro de una rama candidata se registra como integrado, sin otro merge', async () => {
  const w = stoppedWork('Regla de modelo', 'portal-ia/en-900', 'modelo.txt');
  const key = () => workView(S, project.id).items.find(i => i.id === w.assignmentId)!.state.key;
  assert.equal(key(), 'stopped');
  assert.deepEqual(await reconcileIntegrated(S), [], 'mientras no esté en main, no se toca');

  // La consolidación: una rama candidata que CONTIENE el commit verificado más una corrección, integrada en main.
  g('checkout -q -b candidato/en-900 portal-ia/en-900'); fs.writeFileSync(path.join(dir, 'arreglo.txt'), 'x\n'); g('add -A'); g('commit -qm "Candidato: corrección"');
  g('checkout -q main'); g('merge -q --no-ff candidato/en-900 -m "Integra candidato/en-900"');
  const merges = Number(g('rev-list --count --merges main'));

  assert.deepEqual(await reconcileIntegrated(S), [w.processId]);
  const r = processesRepo(S).get(w.processId)!.result!;
  assert.equal(r.merged!.into, 'main'); assert.equal(Number(g('rev-list --count --merges main')), merges, 'no se crea ningún merge nuevo');
  assert.equal(key(), 'integrated_unaccepted', 'integrado: falta la aceptación del propietario');
  assert.notEqual(assignmentsRepo(S).get(w.assignmentId)!.status, 'accepted', 'nada se acepta por él');
  assert.deepEqual(await reconcileIntegrated(S), [], 'una segunda pasada no hace nada');
});

test('un trabajo que no aportó commits propios, o cuyo commit no está en main, se deja como está', async () => {
  const other = stoppedWork('Sin integrar', 'portal-ia/en-901', 'otro.txt');
  const procs = processesRepo(S);
  // Sin commits propios: su «commit verificado» es la propia base.
  const empty = procs.create({ projectId: project.id, kind: 'story_execution', title: 'vacío', estimatedUsd: 0, assignmentId: null, steps: [] });
  procs.setResult(empty.id, { changes: [], verifications: [], baseCommit: base, applied: { branch: 'portal-ia/en-902', commit: base, worktree: dir, files: [] }, pipeline: { state: 'stopped', pauseKind: 'no_changes', reason: 'x', config: { ...DEFAULT_PIPELINE }, failures: [], events: [], corrections: 0 } } as any);
  procs.finish(empty.id, 'done');
  assert.deepEqual(await reconcileIntegrated(S), []);
  assert.equal(procs.get(other.processId)!.result!.merged, undefined); assert.equal(procs.get(empty.id)!.result!.merged, undefined);
});

test('(ronda 2) «solo registrar» nunca crea un merge: si el commit no está en main, falla', async () => {
  const { mergeStory } = await import('../src/services/storyMerge.ts');
  const w = stoppedWork('No integrado', 'portal-ia/en-903', 'tres.txt');
  const merges = Number(g('rev-list --count --merges main'));
  await assert.rejects(() => mergeStory(S, w.processId, { registerOnly: true }), /no está en la rama principal|worktree|Primero/);
  assert.equal(Number(g('rev-list --count --merges main')), merges);
  assert.equal(processesRepo(S).get(w.processId)!.result!.merged, undefined);
});

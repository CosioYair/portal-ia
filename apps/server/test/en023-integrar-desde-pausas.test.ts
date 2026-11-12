import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

/**
 * EN-023 · Ninguna historia queda sin salida al integrar: si la rama va por detrás de main, ninguna pausa (QA no pudo
 * verificar, desacuerdo) ni la ruta con QA aprobada ofrece «merge» que storyMerge rechazaría; la acción principal es
 * «Preparar el candidato de integración (sin IA)». Con el candidato verificado vuelve «Integrar en main bajo tu criterio».
 * Repositorios git temporales, sandbox y proveedor simulados (0 USD, sin suscripción).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en023-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess } = await import('../src/services/storyExecution.ts');
const { newPipeline } = await import('../src/services/storyPipeline.ts');
const { applyChanges } = await import('../src/services/repoWrite.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const app = await buildApp();

let runs: string[] = [];
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => {
  runs.push(command);
  const t = new Date().toISOString();
  return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' };
};

const git = (cwd: string, cmd: string) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd, encoding: 'utf8' }).trim();
const put = (dir: string, p: string, c: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); };
const waitIdle = async (id: string) => { for (let i = 0; i < 400; i++) { const p = processesRepo(S).get(id)!; if (p.status !== 'running') return p; await new Promise(r => setTimeout(r, 25)); } throw new Error('sigue en ejecución'); };

/** Historia aplicada y verificada en su rama; después main avanza un commit sin tocar sus archivos. */
async function behindStory(title: string) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en023-repo-'));
  put(repo, 'src/a.ts', 'export const a = 1;\n');
  put(repo, 'package.json', '{ "name": "demo", "version": "1.0.0", "private": true }\n');
  git(repo, 'init -q -b main'); git(repo, 'add -A'); git(repo, 'commit -qm Base');
  projectsRepo(S).setRepository(project.id, repo, 'main');
  const it = addManualItem(S, project.id, { title, criterion: 'se integra aunque main avance' });
  const p = createStoryProcess(S, project.id, it.id);
  const changes = [{ path: 'src/a.ts', action: 'modify' as const, content: 'export const a = 2;\n', diff: '', before: 1, after: 1, error: null }];
  const ap = await applyChanges(repo, `portal-ia/hu-${it.storyId?.replace(/\D/g, '') || '1'}`, changes as any, `${title}: cambios`, { processId: p.id });
  const at = new Date(Date.now() - 60_000).toISOString(); const vAt = new Date(Date.now() - 30_000).toISOString();
  const ok = (command: string) => ({ command, exitCode: 0, output: `${command} ok`, startedAt: vAt, finishedAt: vAt, durationMs: 1, isolation: 'docker' as const });
  processesRepo(S).setResult(p.id, { ...p.result!, changes: changes as any, applied: { branch: ap.branch, commit: ap.commit, files: ap.files, appliedAt: at, worktree: ap.worktree }, verifications: [ok('typecheck'), ok('test'), ok('build')], review: { approve: true, verdict: 'approved', issues: [], findings: [], suggestedTests: [], summary: 'Bien.' } as any, pipeline: { ...newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, autoApply: true })), state: 'verified', phase: 'finished' } });
  processesRepo(S).authorize(p.id, 1); processesRepo(S).finish(p.id, 'done');
  put(repo, 'src/other.ts', 'export const other = true;\n'); git(repo, 'add -A'); git(repo, 'commit -qm "Main: otra funcionalidad"');
  return { repo, p };
}

/** Deja el proceso en una pausa: «qa» con QA que no pudo verificar o «disagreement» (desacuerdo con QA). */
function pauseAs(id: string, kind: 'qa' | 'disagreement') {
  const r = processesRepo(S).get(id)!.result!;
  const review = kind === 'qa' ? { ...r.review, approve: false, verdict: 'inconclusive', summary: 'QA no pudo verificar con la evidencia disponible.' } : { ...r.review, approve: false, verdict: 'rejected', summary: 'QA y el equipo no coinciden.' };
  processesRepo(S).setResult(id, { ...r, review: review as any, pipeline: { ...r.pipeline!, state: 'paused', phase: 'finished', pauseKind: kind, reason: kind === 'qa' ? 'QA no pudo verificar' : 'Desacuerdo entre QA y el equipo' } as any });
}

const flowOf = async (id: string) => (await app.inject({ method: 'GET', url: `${W}/processes/${id}` })).json().guidance.flow;

for (const kind of ['qa', 'disagreement', 'approved'] as const) {
  test(`EN-023 · rama por detrás de main (${kind}): se ofrece preparar el candidato, no «merge», y integrar se rechaza sin tocar main`, async () => {
    const { repo, p } = await behindStory(`EN-023 · ${kind}`);
    if (kind !== 'approved') pauseAs(p.id, kind);
    const main0 = git(repo, 'rev-parse main');
    const flow = await flowOf(p.id);
    assert.equal(flow.actions[0].id, 'integration_prepare', JSON.stringify(flow.actions.map((a: any) => a.id)));
    assert.match(flow.actions[0].label, /Preparar el candidato de integración \(sin IA\)/);
    assert.ok(flow.actions[0].requires.includes('authorization'));
    assert.ok(!flow.actions.some((a: any) => a.id === 'merge'), 'no se ofrece un merge que storyMerge rechazaría');
    const m = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/merge`, payload: { authorized: true } });
    assert.equal(m.statusCode, 409); assert.equal(m.json().code, 'integration_candidate_required');
    assert.equal(git(repo, 'rev-parse main'), main0, 'main no cambia');
  });
}

test('EN-023 · QA no pudo verificar: tras preparar y verificar el candidato vuelve «Integrar en main bajo tu criterio» y el merge se completa', async () => {
  const { repo, p } = await behindStory('EN-023 · candidato');
  pauseAs(p.id, 'qa');
  const main0 = git(repo, 'rev-parse main');
  runs = [];
  const prep = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/integration/prepare`, payload: { authorized: true } });
  assert.equal(prep.statusCode, 200, prep.body);
  await waitIdle(p.id);
  assert.deepEqual(runs, ['typecheck', 'test', 'build'], 'el candidato se verifica en el sandbox, sin IA');
  assert.equal(git(repo, 'rev-parse main'), main0, 'preparar no toca main');
  pauseAs(p.id, 'qa'); // QA sigue sin poder verificar: la decisión vuelve al propietario
  const flow = await flowOf(p.id);
  const merge = flow.actions.find((a: any) => a.id === 'merge');
  assert.ok(merge, JSON.stringify(flow.actions.map((a: any) => a.id)));
  assert.equal(merge.label, 'Integrar en main bajo tu criterio'); assert.ok(merge.requires.includes('authorization'));
  assert.ok(!flow.actions.some((a: any) => a.id === 'integration_prepare'), 'con el candidato al día ya no hace falta prepararlo');
  const m = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/merge`, payload: { authorized: true } });
  assert.equal(m.statusCode, 200, m.body);
  assert.equal(git(repo, 'rev-parse main~1'), main0, 'main avanza con un merge (nada se reescribe)');
  assert.equal(git(repo, 'show main:src/a.ts'), 'export const a = 2;');
  assert.equal(git(repo, 'show main:src/other.ts'), 'export const other = true;');
});

test('EN-023 · cableado: el aviso del merge ofrece preparar el candidato con su casilla y el contador de «Más acciones» no parte línea', () => {
  const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const panel = read('../../web/src/components/StoryFlowPanel.tsx');
  for (const s of ['integration_candidate_required', 'merge_conflict', 'data-testid="sf-merge-recover"', 'Preparar el candidato de integración (sin IA)', 'sf-merge-recover-auth', 'type="checkbox"']) assert.ok(panel.includes(s), `falta en el panel: ${s}`);
  const css = read('../../web/src/story-flow.css');
  assert.match(css, /\.sf-more \.disclosure-text \{[^}]*flex-direction: row;[^}]*flex-wrap: nowrap;/);
  assert.match(css, /\.sf-more \.disclosure-hint \{[^}]*flex: none;[^}]*white-space: nowrap;/);
});

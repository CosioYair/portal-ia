import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * HU-159 · Integración con un main que avanzó: una historia verificada NO se convierte en otra iteración por eso.
 * E. main avanza mientras se desarrolla · F. se integra limpio tras incorporar el main nuevo · G. conflicto real
 * detectado (solo sus archivos) y resuelto de forma segura · H. lo de main ajeno a la historia se conserva ·
 * I. QA no puede aprobar un candidato sin verificar · J. el propietario revisa y autoriza la integración final.
 * Repositorios git temporales, sandbox y proveedor simulados (0 USD, sin suscripción).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-integ-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess } = await import('../src/services/storyExecution.ts');
const { newPipeline } = await import('../src/services/storyPipeline.ts');
const { applyChanges } = await import('../src/services/repoWrite.ts');
const { branchIntegration, prepareCandidate } = await import('../src/services/storyIntegration.ts');
const { enforceQaGate } = await import('../src/services/qaGate.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const adapters = await import('@portal-ia/ai-adapters');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const app = await buildApp();

// Sandbox simulado: verifica de verdad que no queden marcadores de conflicto y cuenta las ejecuciones.
let runs: string[] = [];
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (wt, _root, command) => {
  runs.push(command);
  const t = new Date().toISOString();
  const bad = fs.readdirSync(path.join(wt, 'src')).filter(f => /^(<{7}|={7}|>{7})/m.test(fs.readFileSync(path.join(wt, 'src', f), 'utf8')));
  return { command, exitCode: bad.length ? 1 : 0, output: bad.length ? `marcadores en ${bad.join(', ')}` : `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' };
};

const git = (cwd: string, cmd: string) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd, encoding: 'utf8' }).trim();
const put = (dir: string, p: string, c: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); };
const eol = (s: string) => s.replace(/\r\n/g, '\n');
const waitIdle = async (id: string) => { for (let i = 0; i < 400; i++) { const p = processesRepo(S).get(id)!; if (p.status !== 'running') return p; await new Promise(r => setTimeout(r, 25)); } throw new Error('sigue en ejecución'); };

/** Repositorio con main, una historia aplicada en su worktree (rama portal-ia/hu-…) y verificada. */
async function storyOn(title: string, files: Record<string, string>) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-integ-repo-'));
  put(repo, 'src/a.ts', 'export const a = 1;\n');
  put(repo, 'src/registry.ts', "export const routes = [\n  'base',\n];\n");
  put(repo, 'package.json', '{ "name": "demo", "version": "1.0.0", "private": true }\n');
  git(repo, 'init -q -b main'); git(repo, 'add -A'); git(repo, 'commit -qm Base');
  projectsRepo(S).setRepository(project.id, repo, 'main');
  const it = addManualItem(S, project.id, { title, criterion: 'la historia se integra sin perder nada' });
  const p = createStoryProcess(S, project.id, it.id);
  const changes = Object.entries(files).map(([f, content]) => ({ path: f, action: 'modify' as const, content, diff: '', before: 1, after: 1, error: null }));
  const ap = await applyChanges(repo, `portal-ia/hu-${it.storyId?.replace(/\D/g, '') || '1'}`, changes as any, `${title}: cambios de la historia`, { processId: p.id });
  // Aplicada hace 1 min y verificada hace 30 s: lo que se prepare después es más reciente que esa verificación.
  const at = new Date(Date.now() - 60_000).toISOString(); const vAt = new Date(Date.now() - 30_000).toISOString();
  const ok = (command: string) => ({ command, exitCode: 0, output: `${command} ok`, startedAt: vAt, finishedAt: vAt, durationMs: 1, isolation: 'docker' as const });
  processesRepo(S).setResult(p.id, { ...p.result!, changes: changes as any, applied: { branch: ap.branch, commit: ap.commit, files: ap.files, appliedAt: at, worktree: ap.worktree }, verifications: [ok('typecheck'), ok('test'), ok('build')], review: { approve: true, verdict: 'approved', issues: [], findings: [], suggestedTests: [], summary: 'Bien.' } as any, pipeline: { ...newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, autoApply: true })), state: 'verified', phase: 'finished' } });
  processesRepo(S).authorize(p.id, 1); processesRepo(S).finish(p.id, 'done');
  return { repo, p, branch: ap.branch, wt: ap.worktree! };
}

test('E · main avanza mientras se desarrolla: se detecta (commits y archivos), integrar a ciegas se rechaza y main no cambia', async () => {
  const { repo, p, branch } = await storyOn('E · main avanza', { 'src/a.ts': 'export const a = 2;\n' });
  put(repo, 'src/other.ts', 'export const other = true;\n'); git(repo, 'add -A'); git(repo, 'commit -qm "Main: otra funcionalidad"');
  const main0 = git(repo, 'rev-parse main');
  const st = await branchIntegration(repo, branch);
  assert.equal(st.state, 'clean'); assert.equal(st.behindCount, 1); assert.equal(st.behind[0].subject, 'Main: otra funcionalidad');
  assert.deepEqual(st.targetFiles, ['src/other.ts']); assert.deepEqual(st.branchFiles, ['src/a.ts']); assert.deepEqual(st.overlap, []);
  const flow = (await app.inject({ method: 'GET', url: `${W}/processes/${p.id}` })).json().guidance.flow;
  assert.equal(flow.issue.kind, 'integration_behind'); assert.equal(flow.actions[0].id, 'integration_prepare'); assert.ok(!flow.actions.some((a: any) => a.id === 'merge'), 'no se ofrece integrar a ciegas');
  assert.ok(!flow.actions.some((a: any) => a.id === 'request_fix' || a.id === 'new_iteration'), 'no se propone otra iteración');
  const m = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/merge`, payload: { authorized: true } });
  assert.equal(m.statusCode, 409); assert.equal(m.json().code, 'integration_candidate_required');
  assert.equal(git(repo, 'rev-parse main'), main0, 'main no cambia');
});

test('F/H/I/J · se integra limpio tras incorporar el main nuevo: candidato sin IA, verificado; lo ajeno de main se conserva; QA no aprueba sin verificar; integrar lo autoriza el propietario', async () => {
  const { repo, p, branch, wt } = await storyOn('F · limpio', { 'src/a.ts': 'export const a = 2; // historia\n' });
  put(repo, 'src/other.ts', 'export const other = "de main";\n'); git(repo, 'add -A'); git(repo, 'commit -qm "Main: otra funcionalidad"');
  const branch0 = git(repo, `rev-parse ${branch}`); const main0 = git(repo, 'rev-parse main');
  runs = [];
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/integration/prepare`, payload: {} })).statusCode, 400, 'exige autorización explícita');
  const prep = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/integration/prepare`, payload: { authorized: true } });
  assert.equal(prep.statusCode, 200, prep.body);
  // I · recién preparado (antes de verificar): integrar exige la verificación del candidato y QA no puede aprobarlo.
  const early = processesRepo(S).get(p.id)!.result!;
  assert.notEqual(early.applied!.commit, branch0.slice(0, 7)); assert.equal(early.integration?.state, 'candidate'); assert.equal(early.integration?.resolvedBy, 'git');
  const gated = enforceQaGate({ verdict: 'approved', summary: 'ok', findings: [], suggestedTests: [] } as any, ['typecheck', 'test', 'build'], []);
  assert.notEqual(gated.verdict, 'approved', 'QA no aprueba un candidato sin verificación del sandbox');
  const done = await waitIdle(p.id);
  assert.deepEqual(runs, ['typecheck', 'test', 'build'], 'el candidato se verifica en el sandbox, sin IA');
  assert.equal(done.result!.pipeline!.pauseKind, 'integration'); assert.match(done.result!.pipeline!.reason!, /Candidato de integración verificado sin IA/);
  assert.ok(done.result!.pipeline!.events.some(e => e.kind === 'integration' && /sin conflictos/.test(e.message)));
  // F · la rama contiene main; main no cambió; H · lo de main está en el candidato y lo de la historia también.
  assert.equal(git(repo, 'rev-parse main'), main0, 'preparar el candidato no toca main');
  git(repo, `merge-base --is-ancestor main ${branch}`);
  assert.equal(eol(fs.readFileSync(path.join(wt, 'src/other.ts'), 'utf8')), 'export const other = "de main";\n');
  assert.equal(eol(fs.readFileSync(path.join(wt, 'src/a.ts'), 'utf8')), 'export const a = 2; // historia\n');
  assert.equal((await branchIntegration(repo, branch)).state, 'up_to_date');
  // J · el propietario revisa y autoriza: la acción existe, exige autorización y deja main con ambas cosas.
  const flow = (await app.inject({ method: 'GET', url: `${W}/processes/${p.id}` })).json().guidance.flow;
  assert.match(flow.issue.title, /Candidato de integración verificado/);
  assert.ok(flow.actions.some((a: any) => a.id === 'merge' && a.requires.includes('authorization')));
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/merge`, payload: {} })).statusCode, 400);
  const m = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/merge`, payload: { authorized: true } });
  assert.equal(m.statusCode, 200, m.body);
  const show = (f: string) => git(repo, `show main:${f}`);
  assert.equal(show('src/other.ts'), 'export const other = "de main";'); assert.equal(show('src/a.ts'), 'export const a = 2; // historia');
  assert.equal(git(repo, `rev-parse main~1`), main0, 'main avanza con un merge (nada se reescribe)');
});

test('G · conflicto real: solo sus archivos (no todos los de la historia), nada cambia, y el agente resuelve SOLO esas secciones; una resolución con marcadores se deshace', async () => {
  const { repo, p, branch, wt } = await storyOn('G · conflicto', { 'src/registry.ts': "export const routes = [\n  'base',\n  'historia',\n];\n", 'src/a.ts': 'export const a = 3;\n' });
  put(repo, 'src/registry.ts', "export const routes = [\n  'base',\n  'main',\n];\n"); put(repo, 'src/other.ts', 'export const other = 1;\n');
  git(repo, 'add -A'); git(repo, 'commit -qm "Main: registra su ruta"');
  const branch0 = git(repo, `rev-parse ${branch}`); const main0 = git(repo, 'rev-parse main');
  const st = await branchIntegration(repo, branch);
  assert.equal(st.state, 'conflicts'); assert.deepEqual(st.conflicts.map(c => c.path), ['src/registry.ts'], 'solo el archivo en conflicto, no los 2 de la historia');
  // El merge directo tampoco se intenta: se dice el conflicto exacto y no se toca nada.
  const m = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/merge`, payload: { authorized: true } });
  assert.equal(m.statusCode, 409); assert.equal(m.json().code, 'merge_conflict'); assert.deepEqual(processesRepo(S).get(p.id)!.result!.mergeError!.files, ['src/registry.ts']);
  const prep = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/integration/prepare`, payload: { authorized: true } });
  assert.equal(prep.statusCode, 409); assert.equal(prep.json().code, 'integration_conflict');
  assert.equal(git(repo, `rev-parse ${branch}`), branch0, 'la rama no cambia'); assert.equal(git(repo, 'rev-parse main'), main0, 'main no cambia');
  const flow = prep.json().process.guidance.flow;
  assert.equal(flow.actions[0].id, 'integration_resolve'); assert.equal(flow.actions.at(-1).id, 'request_fix', 'otra iteración solo como último recurso');
  // Detalle para el agente: base común, main, historia y combinación con marcadores.
  const det = (await app.inject({ method: 'GET', url: `${W}/processes/${p.id}/integration` })).json();
  assert.equal(det.conflicts[0].path, 'src/registry.ts'); assert.match(det.conflicts[0].base, /'base'/); assert.match(det.conflicts[0].target, /'main'/); assert.match(det.conflicts[0].branch, /'historia'/); assert.match(det.conflicts[0].merged, /<{7}/);
  // Resolución inválida (deja marcadores): se deshace y la rama queda igual.
  await assert.rejects(prepareCandidate(repo, wt, branch, 'main', [{ path: 'src/registry.ts', content: "<<<<<<< HEAD\n'x'\n=======\n'y'\n>>>>>>> main\n" }]), /marcadores/);
  assert.equal(git(repo, `rev-parse ${branch}`), branch0); assert.equal(git(wt, 'status --porcelain'), '', 'sin merge a medias');
  // El agente autorizado (proveedor simulado) devuelve SOLO el archivo resuelto, con ambas rutas.
  const RESOLVED = "export const routes = [\n  'base',\n  'main',\n  'historia',\n];\n";
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: 'resuelve SOLO los conflictos', text: `=== RESUMEN ===\nCombino ambas rutas.\n=== ARCHIVO: src/registry.ts | create ===\n${RESOLVED}=== FIN ARCHIVO ===\n` }] }));
  adapters.resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  runs = [];
  const res = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/integration/resolve`, payload: { authorized: true } });
  assert.equal(res.statusCode, 200, res.body);
  const done = await waitIdle(p.id);
  const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(calls.length, 1, 'una sola llamada'); assert.equal(calls[0].rule, 'resuelve SOLO los conflictos');
  assert.equal(done.result!.integration?.resolvedBy, 'agent'); assert.deepEqual(done.result!.integration?.conflicts, ['src/registry.ts']);
  assert.equal(eol(fs.readFileSync(path.join(wt, 'src/registry.ts'), 'utf8')), RESOLVED);
  assert.equal(eol(fs.readFileSync(path.join(wt, 'src/other.ts'), 'utf8')), 'export const other = 1;\n', 'H · lo ajeno de main se conserva');
  assert.equal(eol(fs.readFileSync(path.join(wt, 'src/a.ts'), 'utf8')), 'export const a = 3;\n', 'lo de la historia se conserva');
  assert.deepEqual(runs, ['typecheck', 'test', 'build']); assert.equal(done.result!.pipeline!.pauseKind, 'integration');
  assert.equal(git(repo, 'rev-parse main'), main0, 'nada se integra en main sin el propietario');
});

test('el error de un merge dice los archivos REALES en conflicto (antes se listaban todos los de la historia)', async () => {
  const { mergeBranch } = await import('../src/services/repoWrite.ts');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-integ-merge-'));
  put(repo, 'x.txt', 'base\n'); put(repo, 'y.txt', 'y\n'); git(repo, 'init -q -b main'); git(repo, 'add -A'); git(repo, 'commit -qm Base');
  git(repo, 'checkout -q -b feat'); put(repo, 'x.txt', 'feat\n'); put(repo, 'y.txt', 'feat y\n'); git(repo, 'commit -qam feat');
  git(repo, 'checkout -q main'); put(repo, 'x.txt', 'main\n'); git(repo, 'commit -qam main');
  await assert.rejects(mergeBranch(repo, 'feat'), (e: any) => { assert.deepEqual(e.conflictFiles, ['x.txt']); assert.match(e.message, /conflictos en 1 archivo\(s\): x\.txt/); return true; });
  assert.equal(git(repo, 'status --porcelain'), '', 'el merge se deshizo');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import type { VerificationRun } from '@portal-ia/domain';
import type { ImageInspector } from '../src/services/sandboxImage.ts';

// Servidor aislado: datos temporales, sandbox y proveedor simulados (0 USD, sin docker real).
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en024-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';

const { branchImageTag, buildImageArgs, buildSandboxCheckReport, buildSandboxImage, dockerfileHash, isBranchTag, makeEnvSnapshot, rebuildSandboxImageOnce, resolveProcessImage, sandboxImageDeps } = await import('../src/services/sandboxImage.ts');
const { DEFAULT_SANDBOX_IMAGE, SANDBOX_IMAGE } = await import('../src/services/sandbox.ts');
const { replayQaVerdict, newPipeline } = await import('../src/services/storyPipeline.ts');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess } = await import('../src/services/storyExecution.ts');
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
  return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 1, isolation: 'docker' };
};
const gitIn = (cwd: string, cmd: string) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd, encoding: 'utf8' }).trim();
const put = (dir: string, p: string, c: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); };
const waitIdle = async (id: string) => { for (let i = 0; i < 400; i++) { const p = processesRepo(S).get(id)!; if (p.status !== 'running') return p; await new Promise(r => setTimeout(r, 25)); } throw new Error('sigue en ejecución'); };

/** Historia aplicada en su rama y en pausa de entorno por la imagen (falta Chromium), con el veredicto de QA guardado. */
async function imagePausedStory(title: string) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en024-repo-'));
  put(repo, 'src/a.ts', 'export const a = 1;\n');
  put(repo, 'package.json', '{ "name": "demo", "version": "1.0.0", "private": true }\n');
  gitIn(repo, 'init -q -b main'); gitIn(repo, 'add -A'); gitIn(repo, 'commit -qm Base');
  projectsRepo(S).setRepository(project.id, repo, 'main');
  const it = addManualItem(S, project.id, { title, criterion: 'se verifica con la imagen nueva' });
  const p = createStoryProcess(S, project.id, it.id);
  const changes = [{ path: 'src/a.ts', action: 'modify' as const, content: 'export const a = 2;\n', diff: '', before: 1, after: 1, error: null }];
  const ap = await applyChanges(repo, `portal-ia/hu-${it.storyId?.replace(/\D/g, '') || '1'}`, changes as any, `${title}: cambios`, { processId: p.id });
  const at = new Date(Date.now() - 60_000).toISOString();
  const findings = [{ severity: 'high', text: 'Falta Chromium en la imagen del sandbox para la verificación visual', file: null, evidence: null, category: 'environment' }];
  const snapshot = { verdict: 'blocked_environment', summary: 'Falta Chromium en la imagen del sandbox', findings };
  processesRepo(S).setResult(p.id, { ...p.result!, changes: changes as any, applied: { branch: ap.branch, commit: ap.commit, files: ap.files, appliedAt: at, worktree: ap.worktree },
    verifications: [], review: { approve: false, verdict: 'blocked_environment', issues: [], findings, suggestedTests: [], summary: snapshot.summary } as any,
    pipeline: { ...newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, autoApply: true, gauntlet: { mode: 'off', maxRounds: 0 } } as any)), state: 'paused', phase: 'qa', pauseKind: 'environment',
      reason: 'Falta Chromium en la imagen del sandbox', imageRelated: true, qaVerdictSnapshot: snapshot,
      envSnapshot: makeEnvSnapshot({ engine: 'docker', available: true, image: SANDBOX_IMAGE, stale: true }) } as any });
  processesRepo(S).authorize(p.id, 1); processesRepo(S).finish(p.id, 'paused' as any);
  return processesRepo(S).get(p.id)!;
}

// EN-024 · Imagen del sandbox por rama, reconstrucción autorizada y «Comprobar el sandbox de nuevo» que informa.
const serverSrc = fileURLToPath(new URL('../src/', import.meta.url));
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const readSrc = (rel: string) => fs.readFileSync(path.join(serverSrc, rel), 'utf8');
const readWeb = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

function worktreeWith(dockerfile: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'en024-'));
  if (dockerfile !== null) { fs.mkdirSync(path.join(dir, 'docker'), { recursive: true }); fs.writeFileSync(path.join(dir, 'docker', 'sandbox.Dockerfile'), dockerfile); }
  return dir;
}
const run = (command: string, exitCode: number | null, isolation: VerificationRun['isolation'] = 'docker'): VerificationRun =>
  ({ command, exitCode, output: '', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, isolation } as VerificationRun);

test('dockerfileHash normaliza CRLF y da null sin Dockerfile; la etiqueta de rama nunca es la compartida', () => {
  const a = worktreeWith('FROM node:22\nRUN echo chromium\n'); const b = worktreeWith('FROM node:22\r\nRUN echo chromium\r\n');
  const h = dockerfileHash(a); assert.ok(h && /^[0-9a-f]{64}$/.test(h)); assert.equal(dockerfileHash(b), h, 'CRLF y LF dan el mismo hash');
  assert.equal(dockerfileHash(worktreeWith(null)), null);
  const tag = branchImageTag(h!); assert.equal(tag, `portal-ia-sandbox:df-${h!.slice(0, 12)}`);
  assert.notEqual(tag, DEFAULT_SANDBOX_IMAGE); assert.notEqual(tag, SANDBOX_IMAGE); assert.ok(isBranchTag(tag));
  assert.equal(isBranchTag(DEFAULT_SANDBOX_IMAGE), false); assert.equal(isBranchTag(SANDBOX_IMAGE), false);
});

test('resolveProcessImage marca «imagen desactualizada» si la imagen en uso no corresponde al Dockerfile de la rama', async () => {
  const wt = worktreeWith('FROM node:22\nRUN apt-get install -y chromium\n');
  const stale: ImageInspector = async (ref, format) => ref === SANDBOX_IMAGE ? (format === '{{.Id}}' ? 'sha256:main' : 'otro-hash') : null;
  const info = await resolveProcessImage(wt, { inspect: stale });
  assert.equal(info.stale, true); assert.match(info.reason, /desactualizada/i); assert.equal(info.image, SANDBOX_IMAGE);
  assert.equal(info.expectedTag, branchImageTag(dockerfileHash(wt)!));
  // Con la imagen de rama construida, ya no está desactualizada y el proceso usa esa etiqueta.
  const built: ImageInspector = async (ref) => ref === info.expectedTag || ref === SANDBOX_IMAGE ? 'sha256:x' : null;
  const ok = await resolveProcessImage(wt, { inspect: built });
  assert.equal(ok.stale, false); assert.equal(ok.image, info.expectedTag);
  // detectSandbox informa la imagen desactualizada (no «Docker disponible»).
  assert.ok(readSrc('services/sandbox.ts').includes('imagen desactualizada'));
});

test('buildImageArgs: red solo en el build, etiqueta por hash y nunca la imagen de main', () => {
  const wt = worktreeWith('FROM node:22\n'); const hash = dockerfileHash(wt)!; const tag = branchImageTag(hash);
  const args = buildImageArgs({ worktree: wt, tag, hash });
  assert.equal(args[0], 'build'); assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'default']);
  assert.equal(args[args.indexOf('-t') + 1], tag); assert.ok(args.includes(`portal-ia.dockerfile-sha=${hash}`));
  assert.ok(!args.includes(DEFAULT_SANDBOX_IMAGE) && !args.includes(SANDBOX_IMAGE), 'no se reetiqueta la imagen compartida');
  assert.throws(() => buildImageArgs({ worktree: wt, tag: DEFAULT_SANDBOX_IMAGE, hash }));
  assert.throws(() => buildImageArgs({ worktree: wt, tag: SANDBOX_IMAGE, hash }));
});

test('buildSandboxImage: sin autorización no lanza docker; si falla devuelve su salida', async () => {
  const wt = worktreeWith('FROM node:22\n'); let calls = 0;
  const fake = (async (_cmd: string, args: string[]) => { calls++; assert.ok(!args.includes(DEFAULT_SANDBOX_IMAGE)); return { code: 1, output: 'ERROR: no se pudo descargar chromium' }; }) as unknown as NonNullable<Parameters<typeof buildSandboxImage>[1]['run']>;
  await assert.rejects(buildSandboxImage(wt, { authorized: false, run: fake }), (e: any) => e.statusCode === 403);
  assert.equal(calls, 0, 'fail-closed: sin autorización no se ejecuta nada');
  const r = await buildSandboxImage(wt, { authorized: true, run: fake });
  assert.equal(calls, 1); assert.equal(r.ok, false); assert.equal(r.tag, null); assert.match(r.output, /no se pudo descargar chromium/);
});

test('POST sandbox/rebuild-image sin authorized:true responde 403 y no lanza docker (ejecutor simulado: 0 llamadas)', async () => {
  const p = await imagePausedStory('EN-024 · reconstruir sin autorización');
  let calls = 0; const prev = sandboxImageDeps.run;
  sandboxImageDeps.run = (async () => { calls++; return { code: 0, output: '' }; }) as unknown as typeof prev;
  try {
    const before = JSON.stringify(processesRepo(S).get(p.id));
    for (const payload of [{}, { authorized: false }]) {
      const r = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/sandbox/rebuild-image`, payload });
      assert.equal(r.statusCode, 403, r.body);
    }
    assert.equal(calls, 0, 'fail-closed: sin autorización no se ejecuta docker');
    assert.equal(JSON.stringify(processesRepo(S).get(p.id)), before, 'la historia sigue igual, en pausa con sus acciones');
  } finally { sandboxImageDeps.run = prev; }
});

test('GET sandbox-check informa en la tarjeta (motor, imagen, desactualizada, pausa) y no modifica el proceso', async () => {
  const p = await imagePausedStory('EN-024 · comprobar el sandbox');
  const before = processesRepo(S).get(p.id)!; const beforeJson = JSON.stringify(before);
  const r1 = await app.inject({ method: 'GET', url: `${W}/processes/${p.id}/sandbox-check` });
  assert.equal(r1.statusCode, 200, r1.body);
  const rep = r1.json().report ?? r1.json();
  assert.equal(typeof rep.engine, 'string'); assert.ok('image' in rep && typeof rep.stale === 'boolean', r1.body);
  assert.equal(rep.pauseStillActive, true); assert.ok(typeof rep.message === 'string' && rep.message.length > 0);
  const r2 = await app.inject({ method: 'GET', url: `${W}/processes/${p.id}/sandbox-check?since=${rep.fingerprint}` });
  assert.equal(r2.statusCode, 200, r2.body);
  const rep2 = r2.json().report ?? r2.json();
  assert.equal(rep2.changed, false); assert.match(rep2.message, /Nada cambió/);
  assert.equal(rep2.resolvingAction, 'rebuild_sandbox_image', 'señala la acción que lo resuelve');
  const after = processesRepo(S).get(p.id)!;
  assert.equal(after.status, before.status);
  assert.deepEqual(after.result?.pipeline, before.result?.pipeline);
  assert.equal((after as { updatedAt?: string }).updatedAt, (before as { updatedAt?: string }).updatedAt);
  assert.equal(JSON.stringify(after), beforeJson, 'la comprobación es de solo lectura');
});

test('reanudación: «Continuar» repite la verificación y recalcula QA desde el guardado con 0 llamadas a la IA', async () => {
  const p = await imagePausedStory('EN-024 · continuar con la imagen nueva');
  const aiCounter = (id: string) => { const q = processesRepo(S).get(id)!;
    return { steps: q.steps.length, aiEvents: (q.result?.pipeline?.events ?? []).filter(e => (e as { aiCall?: boolean }).aiCall).length }; };
  const before = aiCounter(p.id);
  const flow = (await app.inject({ method: 'GET', url: `${W}/processes/${p.id}` })).json().guidance.flow;
  assert.equal(flow.actions[0].id, 'rebuild_sandbox_image', JSON.stringify(flow.actions.map((a: any) => a.id)));
  const resume = flow.actions.find((a: any) => a.id === 'pipeline_resume');
  assert.ok(resume, 'se ofrece «Continuar»'); assert.ok(!resume.requires.includes('ai_budget'), 'continuar no pide presupuesto de IA');
  runs = [];
  const cont = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/continue`, payload: { authorized: true } });
  assert.equal(cont.statusCode, 200, cont.body);
  const done = await waitIdle(p.id);
  assert.deepEqual(runs.filter(c => c !== 'install'), ['typecheck', 'test', 'build'], 'repite la verificación en el sandbox');
  assert.deepEqual(aiCounter(p.id), before, 'contador de IA: ningún paso de agente ni evento con llamada a la IA');
  assert.notEqual((done.result?.review as { verdict?: string } | null)?.verdict, 'blocked_environment', 'veredicto recalculado con la imagen nueva');
});

test('rebuildSandboxImageOnce: cerrojo por etiqueta (dos peticiones, una construcción) y no reconstruye si df-<hash> ya existe', async () => {
  const wt = worktreeWith('FROM node:22\nRUN echo en024-cerrojo\n'); const tag = branchImageTag(dockerfileHash(wt)!);
  let calls = 0; const prevRun = sandboxImageDeps.run; const prevInspect = sandboxImageDeps.inspect;
  sandboxImageDeps.run = (async (_cmd: string, args: string[]) => {
    calls++; assert.ok(!args.includes(DEFAULT_SANDBOX_IMAGE) && !args.includes(SANDBOX_IMAGE));
    await new Promise(r => setTimeout(r, 30)); return { code: 0, output: 'built' };
  }) as unknown as typeof prevRun;
  sandboxImageDeps.inspect = async () => null;
  try {
    await assert.rejects(rebuildSandboxImageOnce(wt, { authorized: false }), (e: any) => e.statusCode === 403);
    assert.equal(calls, 0, 'sin autorización no se lanza docker');
    const [a, b] = await Promise.all([rebuildSandboxImageOnce(wt, { authorized: true }), rebuildSandboxImageOnce(wt, { authorized: true })]);
    assert.equal(calls, 1, 'dos peticiones simultáneas comparten una sola construcción');
    assert.equal(a.ok, true); assert.equal(a.tag, tag); assert.deepEqual(b, a);
    // La imagen de rama ya existe y está vigente: ok sin construir.
    sandboxImageDeps.inspect = async (ref) => ref === tag || ref === SANDBOX_IMAGE ? 'sha256:x' : null;
    const again = await rebuildSandboxImageOnce(wt, { authorized: true });
    assert.equal(calls, 1, 'no se vuelve a construir una imagen vigente');
    assert.equal(again.ok, true); assert.equal(again.tag, tag); assert.match(again.output, /ya existe/);
  } finally { sandboxImageDeps.run = prevRun; sandboxImageDeps.inspect = prevInspect; }
});

test('buildSandboxCheckReport: «Nada cambió» con la misma lectura y señala la acción que lo resuelve', () => {
  const cur = makeEnvSnapshot({ engine: 'docker', available: true, image: SANDBOX_IMAGE, stale: true });
  const same = buildSandboxCheckReport({ current: cur, previous: { fingerprint: cur.fingerprint }, comparedWith: 'client', pauseActive: true, pauseImageRelated: true });
  assert.equal(same.changed, false); assert.match(same.message, /Nada cambió/); assert.equal(same.resolvingAction, 'rebuild_sandbox_image');
  assert.equal(same.pauseStillActive, true); assert.equal(same.stale, true); assert.equal(same.engine, 'docker'); assert.equal(same.image, SANDBOX_IMAGE);
  // Sin since: compara con la instantánea guardada al pausar.
  const paused = makeEnvSnapshot({ engine: 'docker', available: true, image: SANDBOX_IMAGE, stale: false });
  const diff = buildSandboxCheckReport({ current: cur, previous: paused, comparedWith: 'pause_snapshot', pauseActive: true, pauseImageRelated: false });
  assert.equal(diff.changed, true); assert.equal(diff.comparedWith, 'pause_snapshot'); assert.match(diff.message, /desactualizada/);
  const first = buildSandboxCheckReport({ current: cur, previous: null, comparedWith: 'client', pauseActive: false, pauseImageRelated: false });
  assert.equal(first.changed, true); assert.match(first.message, /Primera comprobación/);
});

test('replayQaVerdict recalcula sin IA: quita el bloqueo de entorno y conserva los hallazgos de código', () => {
  const snapshot = { verdict: 'blocked_environment', summary: 'Falta Chromium', findings: [
    { severity: 'high', text: 'Falta Chromium en la imagen del sandbox para la verificación visual', file: null, evidence: null, category: 'environment' },
    { severity: 'medium', text: 'Texto del botón sin traducir', file: 'apps/web/src/x.tsx', evidence: null },
    { severity: 'low', text: 'Comentario desactualizado', file: 'apps/server/src/y.ts', evidence: null }
  ] };
  const green = replayQaVerdict(snapshot, ['typecheck', 'test', 'build'].map(c => run(c, 0)));
  assert.notEqual(green.verdict, 'blocked_environment');
  const texts = green.findings.map(f => JSON.stringify(f));
  assert.ok(texts.some(t => t.includes('sin traducir')) && texts.some(t => t.includes('Comentario')), 'conserva media y baja');
  assert.ok(!texts.some(t => t.includes('Chromium')), 'quita el bloqueo de entorno');
  const again = replayQaVerdict(snapshot, []);
  assert.equal(again.verdict, 'blocked_environment', 'sin verificación válida sigue en pausa');
});

test('la pausa de entorno por la imagen ofrece primero la reconstrucción, sin ai_budget, y «Pedir corrección» con hallazgos', () => {
  const flow = readSrc('services/storyFlow.ts');
  const i = flow.indexOf("pl.pauseKind === 'environment' && (pl as { imageRelated?: boolean }).imageRelated"); assert.ok(i > 0);
  const branch = flow.slice(i, i + 3000);
  const rebuild = branch.indexOf("act('rebuild_sandbox_image'"); const refresh = branch.indexOf("'refresh_sandbox'");
  assert.ok(rebuild > 0 && (refresh < 0 || rebuild < refresh), 'rebuild_sandbox_image es la primera acción');
  assert.match(branch.slice(rebuild, rebuild + 600), /'authorization', 'network'/);
  assert.ok(branch.includes("'request_fix'"), 'con hallazgos se ofrece «Pedir corrección»');
});

test('UI: «Comprobar el sandbox de nuevo» pinta el informe en la tarjeta con since y la reconstrucción pide autorización', () => {
  const panel = readWeb('components/StoryFlowPanel.tsx');
  assert.ok(panel.includes("'rebuild_sandbox_image'"));
  assert.match(panel, /api\.sandboxCheck\(slug, proc\.id, sandboxReport\?\.fingerprint \?\? null\)/);
  assert.ok(!/refresh_sandbox'\)\s*\{[^}]*flash\(/.test(panel), 'refresh_sandbox no se resuelve con un aviso fugaz');
  assert.ok(panel.includes('Construyendo la imagen del sandbox'));
  assert.ok(panel.includes('sf-image-build-output'), 'si la construcción falla, su salida queda en la tarjeta');
  const api = readWeb('lib/api.ts'); assert.ok(api.includes('rebuildSandboxImage')); assert.ok(api.includes('sandboxCheck'));
});

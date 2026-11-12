import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VerificationRun } from '@portal-ia/domain';
import { branchImageTag, buildImageArgs, buildSandboxCheckReport, buildSandboxImage, dockerfileHash, isBranchTag, makeEnvSnapshot, resolveProcessImage, type ImageInspector } from '../src/services/sandboxImage.ts';
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_IMAGE } from '../src/services/sandbox.ts';
import { replayQaVerdict } from '../src/services/storyPipeline.ts';

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
  // La ruta exige authorized:true (zod) y delega en el servicio.
  const routes = readSrc('routes/processes.ts');
  assert.ok(routes.includes('sandbox/rebuild-image')); assert.ok(routes.includes('z.literal(true)')); assert.ok(routes.includes('sandbox-check'));
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
  // Contador de llamadas a la IA: el recálculo no pasa por complete() ni por la puerta de QA.
  const src = readSrc('services/storyPipeline.ts');
  const body = src.slice(src.indexOf('export function replayQaVerdict'), src.indexOf('export function replayQaFromPause'));
  const aiCalls = (body.match(/complete\(|qaGate|getAdapter|claudeCodeComplete|callAgent/g) ?? []).length;
  assert.equal(aiCalls, 0);
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

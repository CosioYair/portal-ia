import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * EN-025 · Bloqueos del equipo: la pregunta llega entera (con sus viñetas) y la falta de capacidades o herramientas se trata
 * como tal. Proveedor SIMULADO (0 USD, sin red), repositorio sintético y sandbox determinista, como agent-failures.test.ts.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en025-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
delete process.env.PORTAL_PROVIDER_TIMEOUT_SEC; delete process.env.PORTAL_PROVIDER_RETRIES;
process.env.PORTAL_PROVIDER_BACKOFF_MS = '20';
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline } = await import('@portal-ia/domain');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { newPipeline } = await import('../src/services/storyPipeline.ts');
const { assessDeveloperOutput, failureClassOf } = await import('../src/services/devOutput.ts');
const { trackJob } = await import('../src/services/activeJobs.ts');
const { isCancelled } = await import('../src/services/assessment.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const real = { ...sandboxDeps };
after(() => { sandboxDeps.detect = real.detect; sandboxDeps.run = real.run; });

// ---------- Contrato (sin IA) ----------
const assess = (t: string) => assessDeveloperOutput(t, { stopReason: 'end_turn', exists: () => false, providerRefusal: null }).assessment;
const X = '¿Qué texto debe mostrar el contador al cliente final? Elige una de estas opciones:';
const V1 = '- opción A: «Total 2»'; const V2 = '- opción B: «Suma 2»';
const BLOQ_INFO = `=== RESUMEN ===\nFalta una decisión.\n=== BLOQUEO ===\ntipo: información\nnecesito: el texto exacto que quiere ver el cliente final\npregunta: ${X}\n${V1}\n${V2}\nconsultar: ninguno`;
const H1 = '- un navegador sin cabeza para abrir la vista previa'; const H2 = '- una herramienta de capturas de pantalla';
const BLOQ_CAP = `=== RESUMEN ===\nNo puedo comprobarlo.\n=== BLOQUEO ===\ntipo: información\nnecesito: me faltan herramientas para comprobar la pantalla:\n${H1}\n${H2}\npregunta: ¿Cómo quieres que siga sin esas herramientas?\nconsultar: ninguno`;

test('a · «pregunta: X:» con dos viñetas llega entera y no se mezcla con necesito ni consultar', () => {
  const a = assess(BLOQ_INFO);
  assert.equal(a.kind, 'blocked');
  assert.equal(a.blocker?.question, `${X}\n${V1}\n${V2}`);
  assert.equal(a.blocker?.need, 'el texto exacto que quiere ver el cliente final');
  assert.equal(a.blocker?.consult, null); assert.equal(a.blocker?.type, 'information');
  // Valor en la línea siguiente a la cabecera.
  const next = assess('=== BLOQUEO ===\ntipo: información\nnecesito: elegir el texto\npregunta:\n- a\n- b\nconsultar: QA');
  assert.equal(next.blocker?.question, '- a\n- b'); assert.equal(next.blocker?.consult, 'QA');
  // Una viñeta sangrada con «consultar:» no corta el campo.
  const nested = assess('=== BLOQUEO ===\ntipo: información\nnecesito: algo\npregunta: X:\n  - consultar: el registro\n  - b\nconsultar: QA');
  assert.equal(nested.blocker?.question, 'X:\n  - consultar: el registro\n  - b'); assert.equal(nested.blocker?.consult, 'QA');
});

test('c · faltan capacidades o herramientas: UNSUPPORTED_CAPABILITY con la lista completa, aunque tipo diga información', () => {
  const a = assess(BLOQ_CAP);
  assert.equal(a.blocker?.type, 'capability'); assert.equal(failureClassOf(a), 'UNSUPPORTED_CAPABILITY');
  assert.equal(a.blocker?.need, `me faltan herramientas para comprobar la pantalla:\n${H1}\n${H2}`);
  const q = assess('=== BLOQUEO ===\ntipo: información\nnecesito: comprobar la pantalla\npregunta: No tengo las herramientas necesarias, ¿sigo sin verificarlo?\nconsultar: ninguno');
  assert.equal(failureClassOf(q), 'UNSUPPORTED_CAPABILITY');
});

test('d · sin regresión: bloqueos de una línea y falsos positivos mantienen su clase', () => {
  const info = assess('=== BLOQUEO ===\ntipo: información\nnecesito: saber qué pruebas cubren el contador\npregunta: ¿Qué pruebas existen para src/a.ts?\nconsultar: QA');
  assert.equal(failureClassOf(info), 'MISSING_INFORMATION'); assert.equal(info.blocker?.question, '¿Qué pruebas existen para src/a.ts?');
  const tool = assess('=== BLOQUEO ===\ntipo: información\nnecesito: saber el marco de pruebas\npregunta: ¿Qué herramienta de pruebas usa el repo?\nconsultar: QA');
  assert.equal(failureClassOf(tool), 'MISSING_INFORMATION', 'preguntar por una herramienta no es que falte');
  const bullets = assess('=== BLOQUEO ===\ntipo: información\nnecesito: el texto del contador:\n- funciona sin herramientas externas\npregunta: ¿Qué texto quieres?\nconsultar: ninguno');
  assert.equal(failureClassOf(bullets), 'MISSING_INFORMATION', 'las viñetas no deciden la clase');
  const perm = assess('=== BLOQUEO ===\ntipo: permiso\nnecesito: sin acceso a data/ no puedo ver la base real; me faltan herramientas\npregunta: ¿Me das acceso?\nconsultar: ninguno');
  assert.equal(failureClassOf(perm), 'PERMISSION_REQUIRED', 'el permiso tiene prioridad');
});

// ---------- Pipeline con proveedor simulado ----------
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en025-repo-'));
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'en025-fixture', version: '1.0.0', private: true, scripts: { typecheck: 'echo ok', test: 'echo ok', build: 'echo ok' } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { await app.close(); });
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { const t = new Date().toISOString(); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: t, durationMs: 5, isolation: 'docker' }; };

const PLAN = '{"summary":"Cambiar a","tasks":["Editar src/a.ts"],"filesToRead":["src/a.ts"],"filesToChange":["src/a.ts"],"acceptance":["a = 2"],"risks":[]}';
const R = { plan: 'plan técnico', consult: 'necesita tu respuesta para seguir', repair: 'Tu entrega anterior para esta historia no se pudo convertir', dev: 'Implementa la historia' };
function script(devText: string) {
  const rules = [{ match: R.plan, text: PLAN }, { match: R.consult, text: 'respuesta del especialista' }, { match: R.repair, text: devText }, { match: R.dev, text: devText }];
  fs.writeFileSync(scriptPath, JSON.stringify({ rules, markers: [] }));
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
const count = (match: string) => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(c => c.rule === match).length : 0;
const flowOf = async (id: string) => (await app.inject({ method: 'GET', url: `${W}/processes/${id}` })).json().guidance.flow;
async function run(title: string, withPipeline: boolean) {
  const it = addManualItem(S, project.id, { title, criterion: 'a vale 2' });
  const p = createStoryProcess(S, project.id, it.id);
  if (withPipeline) processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline(DEFAULT_PIPELINE)) });
  processesRepo(S).authorize(p.id, 2);
  await trackJob(p.id, runStory(S, p.id, () => undefined, () => isCancelled(p.id)));
  return processesRepo(S).get(p.id)!;
}
const hasAll = (s: string, parts: string[]) => { for (const x of parts) assert.ok(s.includes(x), `falta «${x}» en: ${s.slice(0, 400)}`); };

test('b · pipeline: la pregunta entera llega a la pausa, al mensaje de blockedStop y a la vista del propietario', async () => {
  script(BLOQ_INFO);
  const p = await run('EN-025 · pregunta con viñetas', true);
  const pl = p.result!.pipeline!;
  assert.equal(pl.pauseKind, 'missing_information', pl.reason ?? ''); assert.equal(pl.failureClass, 'MISSING_INFORMATION');
  assert.equal(pl.ownerRequest?.question, `${X}\n${V1}\n${V2}`);
  hasAll(p.result!.failure!.detail ?? '', [X, V1, V2]); // mensaje «Pausado: … necesita información para seguir: «…»»
  hasAll(p.result!.failure!.request!.question, [X, V1, V2]);
  const flow = await flowOf(p.id);
  assert.equal(flow.issue.kind, 'agent_blocked');
  hasAll(JSON.stringify(flow), [X, V1, V2].map(s => JSON.stringify(s).slice(1, -1)));
  assert.equal(count(R.repair), 0);
});

test('b2 · sin pipeline: la pausa de storyFlow (failure.request) también muestra X y ambas viñetas', async () => {
  script(BLOQ_INFO);
  const p = await run('EN-025 · pregunta con viñetas sin pipeline', false);
  hasAll(p.result!.failure!.request!.question, [X, V1, V2]);
  const flow = await flowOf(p.id);
  assert.equal(flow.issue.kind, 'agent_blocked');
  hasAll(JSON.stringify(flow.issue), [X, V1, V2].map(s => JSON.stringify(s).slice(1, -1)));
});

test('c2 · pipeline: la falta de herramientas va por la rama «unsupported» con la lista completa', async () => {
  script(BLOQ_CAP);
  const p = await run('EN-025 · faltan herramientas', true);
  const pl = p.result!.pipeline!;
  assert.equal(pl.pauseKind, 'unsupported', pl.reason ?? ''); assert.equal(pl.failureClass, 'UNSUPPORTED_CAPABILITY');
  assert.notEqual(pl.pauseKind, 'missing_information');
  hasAll(pl.ownerRequest!.why, ['me faltan herramientas', H1, H2]);
  assert.equal(count(R.repair), 0);
  const flow = await flowOf(p.id);
  assert.equal(flow.issue.kind, 'agent_blocked');
  hasAll(JSON.stringify(flow.issue), [H1, H2]);
});

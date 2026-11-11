import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * HU-202 · Curador de Aprendizaje: las lecciones detectadas se agrupan por causa (proyecto + detector + papel), se aplican
 * solas (validated, source 'curator') o se descartan (rejected con motivo), sin IA y a 0 USD. Proveedor SIMULADO (sin red),
 * datos y repositorio sintéticos, sandbox determinista. Escenarios: a agrupación y descarte · b idempotencia · c fallo del
 * proveedor sin pendientes · d una detección de la historia 1 llega al implementador de la historia 2 por injectLessons ·
 * e curar no llama a la IA y queda en execution_history con coste 0 · f una lección curada que reincide se retira sola y su
 * causa no se reaplica · g POST /lessons/curate exige autorización explícita.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu202-'));
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
const { processesRepo, projectsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { newPipeline } = await import('../src/services/storyPipeline.ts');
const { trackJob } = await import('../src/services/activeJobs.ts');
const { isCancelled } = await import('../src/services/assessment.ts');
const { lessonsFor, lessonsRepo, recordDetections, recordLessonOutcomes, REFUTE_AFTER } = await import('../src/services/lessons.ts');
const { causeKey, curateAfterTask, curatePending, LESSON_CATALOG } = await import('../src/services/lessonCurator.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const real = { ...sandboxDeps };
after(() => { sandboxDeps.detect = real.detect; sandboxDeps.run = real.run; });

// ---------- Entorno ----------
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu202-repo-'));
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'hu202-fixture', version: '1.0.0', private: true, scripts: { typecheck: 'echo ok', test: 'echo ok', build: 'echo ok' } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { await app.close(); });
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { const t = new Date().toISOString(); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: t, durationMs: 5, isolation: 'docker' }; };

const PLAN = '{"summary":"Cambiar a","tasks":["Editar src/a.ts"],"filesToRead":["src/a.ts"],"filesToChange":["src/a.ts"],"acceptance":["a = 2"],"risks":[]}';
const PATCH = '=== RESUMEN ===\nCambia a.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nEl contador muestra 2.\n=== PRUEBA MANUAL ===\n1. Abre el contador. Esperado: muestra 2.';
const BLOCKED = 'He revisado la historia y el código. No puedo implementar el cambio de forma segura: para comprobar el comportamiento necesito revisar la base de datos real, pero no tengo acceso a la carpeta data/ del propietario ni a sus credenciales.';
const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple el criterio; typecheck, test y build en verde.', findings: [], suggestedTests: [] });
const R = { plan: 'plan técnico', consult: 'necesita tu respuesta para seguir', cont: 'Antes no pudiste implementar la historia', repair: 'Tu entrega anterior para esta historia no se pudo convertir', qa: 'Evalúa la implementación con la EVIDENCIA real', dev: 'Implementa la historia' };
/** Fragmento literal del texto del catálogo de agent_blocked: solo puede llegar al prompt por injectLessons. */
const MARK = 'decláralo en la sección BLOQUEO con lo que necesitas';
const MARKERS = [MARK];
type Rule = { match: string; text?: string; error?: string; failTimes?: number };
function script(dev: Partial<Rule>) {
  const r: Rule[] = [{ match: R.plan, text: PLAN }, { match: R.consult, text: 'a debe ser un número.' }, { match: R.cont, text: PATCH }, { match: R.repair, text: PATCH }, { match: R.qa, text: QA_OK }, { match: R.dev, ...dev }];
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: r, markers: MARKERS }));
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
function newStory(title: string) {
  const it = addManualItem(S, project.id, { title, criterion: 'a vale 2' });
  const p = createStoryProcess(S, project.id, it.id);
  processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE })) });
  processesRepo(S).authorize(p.id, 2);
  return p.id;
}
async function run(title: string) {
  const id = newStory(title);
  await trackJob(id, runStory(S, id, () => undefined, () => isCancelled(id)));
  return processesRepo(S).get(id)!;
}
const pendingIn = (projectId: string) => lessonsRepo(S).list(projectId, 'detected').filter(l => l.projectId === projectId);
const curateRows = () => workspaceDb(S).prepare(`SELECT cost_usd AS cost, tokens_in AS tin, tokens_out AS tout FROM execution_history WHERE kind = 'lesson_curate'`).all() as any[];

// ---------- a/b · Agrupación, descarte e idempotencia (datos sintéticos de otro proyecto) ----------
const UNIT = 'p-unit-hu202';
const det = (processId: string, detector: string, role: 'implementer' | null = 'implementer') => lessonsRepo(S).insert({ projectId: UNIT, role, tags: [detector], status: 'detected', version: 1, parentId: null, title: `${detector} en ${processId}`, detector, evidence: { processId, processTitle: processId, stepId: null, agentId: null, agentName: null, file: 'src/a.ts', detail: 'evidencia sintética', at: new Date().toISOString() }, rootCause: null, correctiveAction: null, lessonText: null, source: 'detector', promotedTo: null, dedupeKey: `${processId}:${detector}:src/a.ts` });
const unitLessons = () => lessonsRepo(S).list(UNIT).filter(l => l.projectId === UNIT);

test('a · el Curador agrupa 3 patch_mismatch de 3 procesos en 1 aplicada y 2 agrupadas, y descarta el ruido y lo que no tiene catálogo', () => {
  const ids = ['pA', 'pB', 'pC'].map(p => det(p, 'patch_mismatch')!.id);
  const noise = det('pA', 'provider_timeout', null)!; const unknown = det('pB', 'detector_inventado')!;
  const n0 = calls().length;
  const s = curatePending(S, { projectId: UNIT, by: 'owner' });
  assert.equal(s.groups, 3); assert.equal(s.applied, 1); assert.equal(s.merged, 2); assert.equal(s.discarded, 2);
  assert.equal(calls().length, n0, 'curar no llama a la IA');
  const validated = unitLessons().filter(l => l.status === 'validated');
  assert.equal(validated.length, 1);
  const v = validated[0];
  assert.equal(v.detector, 'patch_mismatch'); assert.equal(v.source, 'curator'); assert.ok(v.validatedAt);
  assert.equal(v.lessonText, LESSON_CATALOG.patch_mismatch.text); assert.equal(v.evidence.processId, 'pC', 'se aplica la detección más reciente del grupo');
  for (const id of ids.filter(i => i !== v.id)) { const l = lessonsRepo(S).get(id)!; assert.equal(l.status, 'rejected'); assert.ok(l.tags.includes('agrupada')); }
  const nz = lessonsRepo(S).get(noise.id)!; assert.equal(nz.status, 'rejected'); assert.ok(nz.tags.includes('descartada:ruido')); assert.equal(nz.lessonText, null);
  const uk = lessonsRepo(S).get(unknown.id)!; assert.equal(uk.status, 'rejected'); assert.ok(uk.tags.includes('descartada:sin-catalogo'));
  assert.equal(unitLessons().filter(l => l.status === 'detected').length, 0);
});

test('b · idempotente: sin pendientes no cambia nada; volver a detectar no crea copias; una detección nueva de la misma causa se agrupa', () => {
  const n = unitLessons().length;
  const again = curatePending(S, { projectId: UNIT });
  assert.deepEqual([again.groups, again.applied, again.merged, again.discarded], [0, 0, 0, 0]);
  assert.equal(det('pA', 'patch_mismatch'), null, 'la fila rechazada conserva su dedupeKey');
  assert.equal(unitLessons().length, n);
  det('pD', 'patch_mismatch');
  const s = curatePending(S, { projectId: UNIT });
  assert.equal(s.applied, 0); assert.equal(s.merged, 1);
  const perCause = new Map<string, number>();
  for (const l of unitLessons().filter(x => x.status === 'validated')) perCause.set(causeKey(l), (perCause.get(causeKey(l)) ?? 0) + 1);
  assert.ok([...perCause.values()].every(c => c === 1), 'como mucho una lección aplicada por causa');
});

// ---------- c · Fallo del proveedor ----------
test('c · fallo del proveedor: al terminar no queda ninguna detección pendiente y la del proveedor queda descartada como ruido', async () => {
  script({ text: PATCH, failTimes: 10, error: 'network' });
  const p = await run('c · proveedor caído');
  assert.equal(p.result!.pipeline!.pauseKind, 'provider_error');
  const mine = lessonsRepo(S).list(project.id).filter(l => l.evidence.processId === p.id);
  assert.ok(mine.some(l => l.detector === 'provider_unavailable'), mine.map(l => l.detector).join(', '));
  for (const l of mine.filter(x => x.detector.startsWith('provider_'))) { assert.equal(l.status, 'rejected'); assert.ok(l.tags.includes('descartada:ruido')); }
  assert.equal(pendingIn(project.id).length, 0, 'el Curador cura también los procesos que fallan o se pausan');
});

// ---------- d/e · De la historia 1 al implementador de la historia 2 (injectLessons) ----------
let lessonId = ''; let p1Id = ''; let p2Id = '';

test('d · la detección de la historia 1 se aplica sola y llega al paso del implementador de la historia 2', async () => {
  assert.ok(LESSON_CATALOG.agent_blocked.text.includes(MARK));
  script({ text: BLOCKED });
  const p1 = await run('d1 · historia que se bloquea'); p1Id = p1.id;
  assert.equal(p1.result!.pipeline!.state, 'paused'); assert.equal(p1.result!.pipeline!.pauseKind, 'permission');
  assert.ok(!calls().some(c => c.markers.includes(MARK)), 'antes de detectarla, la lección no estaba en ningún prompt');
  const lesson = lessonsRepo(S).list(project.id, 'validated').find(l => l.detector === 'agent_blocked' && l.evidence.processId === p1.id);
  assert.ok(lesson, 'el Curador la aplicó al terminar la historia 1, sin aprobación del propietario');
  assert.equal(lesson.source, 'curator'); assert.equal(lesson.role, 'implementer'); assert.equal(lesson.lessonText, LESSON_CATALOG.agent_blocked.text);
  lessonId = lesson.id;
  assert.equal(pendingIn(project.id).length, 0);
  script({ text: PATCH });
  const p2 = await run('d2 · historia siguiente'); p2Id = p2.id;
  assert.equal(p2.result!.pipeline!.state, 'verified', p2.result!.pipeline!.reason ?? '');
  const impl = p2.steps.find(s => s.role === 'implementer')!;
  assert.ok((impl.lessonsUsed ?? []).includes(lessonId), 'el paso deja constancia de la lección usada');
  const dev = calls().filter(c => c.rule === R.dev);
  assert.ok(dev.length >= 1 && dev[0].markers.includes(MARK), 'el texto del catálogo llegó al prompt del implementador');
  assert.ok(calls().filter(c => c.rule === R.plan).every(c => !c.markers.includes(MARK)), 'solo se inyecta al papel de la lección');
  const l = lessonsRepo(S).get(lessonId)!;
  assert.ok(l.usedCount >= 1);
  assert.ok((l.proof ?? []).some(x => x.processId === p2Id && x.result === 'held'), 'la historia 2 terminó verificada sin repetir el error');
});

test('e · curar no llama a la IA: execution_history registra lesson_curate con coste 0; volver a detectar no crea copias', () => {
  const n0 = calls().length; const total = lessonsRepo(S).list(project.id).length;
  for (const id of [p1Id, p2Id]) recordDetections(S, id, repo);
  const s = curatePending(S, { projectId: project.id });
  assert.equal(s.applied, 0);
  assert.equal(calls().length, n0, 'ninguna llamada al proveedor simulado');
  assert.equal(lessonsRepo(S).list(project.id).length, total);
  const rows = curateRows();
  assert.ok(rows.length >= 3, 'una entrada por tarea terminada');
  assert.ok(rows.every(r => r.cost === 0 && r.tin === 0 && r.tout === 0));
});

// ---------- f · Retirada automática ----------
test('f · una lección curada que reincide REFUTE_AFTER veces seguidas se retira sola y su causa no se vuelve a aplicar', () => {
  assert.equal(REFUTE_AFTER, 2);
  const recur = (title: string) => {
    const id = newStory(title); const p = processesRepo(S).get(id)!;
    processesRepo(S).setStepLessons(p.steps.find(s => s.role === 'implementer')!.id, [lessonId]);
    processesRepo(S).setResult(id, { ...p.result!, pipeline: { ...p.result!.pipeline!, state: 'verified' }, failure: { class: 'MISSING_INFORMATION', detail: 'Le faltaba saber qué pruebas cubren a.' } } as any);
    processesRepo(S).finish(id, 'done');
    const out = recordLessonOutcomes(S, id, repo); recordDetections(S, id, repo); curateAfterTask(S, id);
    return { id, out };
  };
  const n0 = calls().length;
  const r1 = recur('f1 · reincide');
  assert.ok(r1.out.recurred.includes(lessonId)); assert.equal(lessonsRepo(S).get(lessonId)!.status, 'validated', 'una sola reincidencia no basta');
  const d1 = lessonsRepo(S).list(project.id).find(l => l.detector === 'agent_blocked' && l.evidence.processId === r1.id)!;
  assert.equal(d1.status, 'rejected'); assert.ok(d1.tags.includes('agrupada'));
  const r2 = recur('f2 · reincide otra vez');
  assert.ok(r2.out.refuted.includes(lessonId)); assert.equal(lessonsRepo(S).get(lessonId)!.status, 'refuted');
  assert.ok(!lessonsFor(S, { projectId: project.id, role: 'implementer' }).some(l => l.id === lessonId), 'deja de inyectarse');
  const d2 = lessonsRepo(S).list(project.id).find(l => l.detector === 'agent_blocked' && l.evidence.processId === r2.id)!;
  assert.equal(d2.status, 'rejected'); assert.ok(d2.tags.includes('descartada:refutada'), 'la causa refutada no se reaplica en bucle');
  assert.ok(!lessonsRepo(S).list(project.id, 'validated').some(l => l.detector === 'agent_blocked' && l.role === 'implementer'));
  assert.equal(pendingIn(project.id).length, 0); assert.equal(calls().length, n0, 'sin IA');
});

// ---------- g · Ruta de limpieza ----------
test('g · POST /lessons/curate: sin authorized devuelve 403; con authorized limpia en una sola operación, sin IA', async () => {
  const no = await app.inject({ method: 'POST', url: `${W}/lessons/curate`, payload: { projectId: project.id } });
  assert.equal(no.statusCode, 403); assert.equal(no.json().code, 'authorization_required');
  const n0 = calls().length;
  const ok = await app.inject({ method: 'POST', url: `${W}/lessons/curate`, payload: { authorized: true, projectId: project.id } });
  assert.equal(ok.statusCode, 200, ok.body);
  const s = ok.json();
  assert.equal(typeof s.applied, 'number'); assert.equal(typeof s.merged, 'number'); assert.equal(typeof s.discarded, 'number');
  assert.equal(pendingIn(project.id).length, 0); assert.equal(calls().length, n0);
});

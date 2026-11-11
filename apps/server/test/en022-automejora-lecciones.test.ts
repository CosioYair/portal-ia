import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** EN-022 · Automejora de las lecciones, con proveedor simulado (0 USD). */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en022-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json');
const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, findingKey, lessonCardState } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { causeSignature, detectInProcess, lessonsRepo, recordDetections, recordLessonOutcomes } = await import('../src/services/lessons.ts');
const { LESSON_CATALOG, curatePending } = await import('../src/services/lessonCurator.ts');
const { getAutoImproveAuthorization, maybeImproveLessons, pendingImprovementItems, setAutoImproveAuthorization } = await import('../src/services/lessonImprover.ts');
const { templatesRepo } = await import('../src/services/agentTemplates.ts');
const { createProject } = await import('../src/services/companies.ts');
const adapters = await import('@portal-ia/ai-adapters');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const slug = 'portal-ia';
const internal = projectsRepo(slug).list()[0];
const dev = agentsRepo(slug).list().find(a => a.key === 'pj-dev' && a.projectId === internal.id)!;
const NEW_TEXT = 'Ejecuta la prueba que falla en local antes de entregar y corrige su causa exacta; cita en el resumen el nombre de la prueba.';
fs.writeFileSync(scriptPath, JSON.stringify({ markers: [], rules: [{ match: 'Error detectado', text: JSON.stringify({ rootCause: 'La lección era genérica.', correctiveAction: 'Ejecutar la prueba concreta.', lessonText: NEW_TEXT, role: 'implementer', tags: ['verify'] }) }] }));
fs.writeFileSync(logPath, '');

const V = (command: string, exitCode: number, output: string) => ({ command, exitCode, output, startedAt: 't', finishedAt: 't', durationMs: 1, isolation: 'host-min' });
const TAP = (name: string) => `TAP version 13\r\n# Subtest: suite\r\n    not ok 1 - ${name}\r\n      ---\r\n      duration_ms: 3\r\n      ...\r\n# fail 1\r\n`;
let n = 0;
function proj() { return createProject(slug, `Proyecto EN-022 ${++n}`, 'x', []); }
function mkProc(projectId: string, result: Record<string, unknown>, lessonsUsed: string[] = []) {
  const repo = processesRepo(slug) as any;
  const p = repo.create({ projectId, kind: 'story_execution', title: `Tarea ${++n}`, estimatedUsd: 0, steps: [
    { agentId: dev.id, agentName: dev.config.name, title: 'Plan', model: dev.config.model, role: 'planner' },
    { agentId: dev.id, agentName: dev.config.name, title: 'Implementación', model: dev.config.model, role: 'implementer' }
  ] }) as { id: string };
  const impl = processesRepo(slug).get(p.id)!.steps.find(s => s.role === 'implementer')!;
  if (lessonsUsed.length) processesRepo(slug).setStepLessons(impl.id, lessonsUsed);
  processesRepo(slug).setResult(p.id, { changes: [], verifications: [], review: null, runtimeChecks: null, applied: false, ...result } as any);
  return processesRepo(slug).get(p.id)!;
}
function mkLesson(projectId: string, o: { tags?: string[]; status?: string; detector?: string; text?: string } = {}) {
  const repo = lessonsRepo(slug);
  const l = repo.insert({ projectId, role: 'implementer', tags: o.tags ?? ['verify', 'implementar'], status: o.status ?? 'validated', version: 1, parentId: null, title: 'Lección de prueba', detector: o.detector ?? 'verification_failed', evidence: { processId: 'proc-origen', processTitle: 'Origen', stepId: null, agentId: null, agentName: null, file: null, detail: 'Evidencia de origen', at: new Date().toISOString() }, rootCause: null, correctiveAction: null, lessonText: o.text ?? 'Ejecuta npm test antes de entregar y corrige cada prueba que falle.', source: 'curator', promotedTo: null, dedupeKey: null } as any)!;
  return repo.update(l.id, { validatedAt: new Date().toISOString() })!;
}
const policyGrants = () => (workspaceDb(slug).prepare(`SELECT COUNT(*) AS n FROM execution_history WHERE kind = 'policy:ai_call:granted'`).get() as any).n as number;

test('a · recordDetections suma como máximo UNA reincidencia por lección y proceso (dos llamadas y dos detecciones en una)', () => {
  const pj = proj();
  const L = mkLesson(pj.id, { tags: ['verify', 'test', 'implementar', 'causa:test:suma devuelve 3'] });
  const G = mkLesson(pj.id); // genérica: casa con typecheck y test a la vez
  const p = mkProc(pj.id, { verifications: [V('typecheck', 2, 'src/a.ts(1,1): error TS2304: x'), V('test', 1, TAP('suma devuelve 3'))], pipeline: { state: 'paused', events: [] } }, [L.id, `practice:pj-dev@2:${G.id}`]);
  recordDetections(slug, p.id, null);
  recordDetections(slug, p.id, null); // pausa, reintento o parada: misma tarea
  assert.equal(lessonsRepo(slug).get(L.id)!.recurrenceCount, 1);
  assert.deepEqual(lessonsRepo(slug).get(L.id)!.recurrenceProcesses, [p.id]);
  assert.equal(lessonsRepo(slug).get(G.id)!.recurrenceCount, 1, 'dos detecciones del mismo proceso: una reincidencia');
  const card = lessonCardState(lessonsRepo(slug).get(L.id)!);
  assert.equal(card.recurrenceBadge, true); assert.equal(card.learned, false);
});

test('b · un fallo intermedio que el mismo proceso corrige y termina verificado no cuenta; la ficha muestra «Aprendida» sin reincidencia', () => {
  const pj = proj();
  const L = mkLesson(pj.id, { tags: ['verify', 'test', 'implementar', 'causa:test:resta devuelve 1'] });
  const p = mkProc(pj.id, { verifications: [V('test', 1, TAP('resta devuelve 1'))], pipeline: { state: 'paused', events: [] } }, [L.id]);
  recordDetections(slug, p.id, null);
  assert.equal(lessonsRepo(slug).get(L.id)!.recurrenceCount, 1, 'pausado: cuenta mientras no se corrige');
  processesRepo(slug).setResult(p.id, { changes: [], verifications: [V('test', 0, '# pass 12')], review: null, runtimeChecks: null, applied: true, pipeline: { state: 'verified', events: [] } } as any);
  recordDetections(slug, p.id, null);
  const out = recordLessonOutcomes(slug, p.id, null);
  const l = lessonsRepo(slug).get(L.id)!;
  assert.equal(l.recurrenceCount, 0); assert.deepEqual(l.recurrenceProcesses, []);
  assert.deepEqual(out.held, [L.id]);
  const card = lessonCardState(l);
  assert.equal(card.learned, true); assert.equal(card.recurrenceBadge, false);
});

test('c · firmas de causa: verification_failed (comando y prueba o archivo), patch_mismatch (archivo), gauntlet_gap (findingKey)', () => {
  assert.equal(causeSignature('test', TAP('suma devuelve 3')), 'test:suma devuelve 3');
  assert.equal(causeSignature('test', '✖ calcula el total (12.5ms)\n'), 'test:calcula el total');
  assert.equal(causeSignature('typecheck', 'apps\\server\\src\\x.ts(3,5): error TS2304: Cannot find name'), 'typecheck:apps/server/src/x.ts');
  assert.equal(causeSignature('typecheck', 'error TS2304'), 'typecheck');
  const pj = proj();
  const f = { id: 'f1', severity: 'blocking', text: 'Falta la prueba de la bandeja de lecciones', file: 'apps/server/test/x.test.ts', criterion: 'GET /inbox/lessons', evidence: 'No hay prueba', expected: 'Una prueba', unsupported: false };
  const p = mkProc(pj.id, {
    verifications: [V('test', 1, TAP('suma devuelve 3'))],
    changes: [{ path: 'apps/web/src/a.tsx', action: 'modify', content: null, error: 'El fragmento BUSCAR no aparece en el archivo', diff: null, before: 1, after: 1 }],
    gauntlet: { status: 'stopped', mode: 'standard', rounds: [{ round: 1, evaluatorName: 'Evaluador', findings: [f] }] },
    pipeline: { state: 'paused', events: [] }
  });
  const ds = detectInProcess(slug, p, null);
  const vf = ds.find(d => d.detector === 'verification_failed')!;
  assert.ok(vf.tags.includes('causa:test:suma devuelve 3')); assert.ok(vf.dedupeKey.includes('test:suma devuelve 3')); assert.match(vf.title, /suma devuelve 3/);
  assert.ok(ds.find(d => d.detector === 'patch_mismatch')!.tags.includes('causa:apps/web/src/a.tsx'));
  assert.ok(ds.find(d => d.detector === 'gauntlet_gap')!.tags.includes(`causa:${findingKey(f as any)}`));
});

test('d · dos fallos de pruebas distintas dan dos lecciones aplicadas; la misma causa otra vez queda agrupada', () => {
  const pj = proj();
  const p1 = mkProc(pj.id, { verifications: [V('test', 1, TAP('suma devuelve 3'))], pipeline: { state: 'paused', events: [] } });
  const p2 = mkProc(pj.id, { verifications: [V('test', 1, TAP('resta devuelve 1'))], pipeline: { state: 'paused', events: [] } });
  recordDetections(slug, p1.id, null); recordDetections(slug, p2.id, null);
  const s = curatePending(slug, { projectId: pj.id });
  assert.equal(s.applied, 2); assert.equal(s.merged, 0);
  const applied = lessonsRepo(slug).list(pj.id, 'validated').filter(l => l.detector === 'verification_failed' && l.projectId === pj.id);
  assert.equal(applied.length, 2);
  assert.ok(applied.some(l => /Caso: test:suma devuelve 3/.test(l.lessonText ?? '')));
  assert.ok(applied.some(l => /Caso: test:resta devuelve 1/.test(l.lessonText ?? '')));
  const p3 = mkProc(pj.id, { verifications: [V('test', 1, TAP('suma devuelve 3'))], pipeline: { state: 'paused', events: [] } });
  recordDetections(slug, p3.id, null);
  const s2 = curatePending(slug, { projectId: pj.id });
  assert.equal(s2.applied, 0); assert.equal(s2.merged, 1, 'misma causa: agrupada');
});

test('e · max_turns_exhausted: pausa realista de turnos agotados y entrada de catálogo', () => {
  const pj = proj();
  const p = mkProc(pj.id, { pipeline: { state: 'paused', pauseKind: 'max_turns', failureClass: 'CLAUDE_CODE_MAX_TURNS_EXHAUSTED', reason: 'Claude Code agotó los turnos autorizados (40) sin entregar la respuesta.', events: [] } });
  const ds = detectInProcess(slug, p, null).filter(d => d.detector === 'max_turns_exhausted');
  assert.equal(ds.length, 1); assert.equal(ds[0].role, 'implementer');
  assert.ok(LESSON_CATALOG.max_turns_exhausted); assert.equal(LESSON_CATALOG.max_turns_exhausted.role, 'implementer');
});

test('f · correction_cap_reached: tope de correcciones, y la pausa «limit» de pasos internos no lo dispara', () => {
  const pj = proj();
  const p = mkProc(pj.id, { pipeline: { state: 'paused', pauseKind: 'limit', reason: 'npm test sigue fallando y se alcanzó el máximo de correcciones autorizadas (2). Autoriza otra corrección o revisa el diagnóstico.', events: [] } });
  assert.equal(detectInProcess(slug, p, null).filter(d => d.detector === 'correction_cap_reached').length, 1);
  assert.ok(LESSON_CATALOG.correction_cap_reached); assert.equal(LESSON_CATALOG.correction_cap_reached.role, 'implementer');
  const q = mkProc(pj.id, { pipeline: { state: 'paused', pauseKind: 'limit', reason: 'Se alcanzó el máximo de pasos internos autorizados (12).', events: [] } });
  assert.equal(detectInProcess(slug, q, null).filter(d => d.detector === 'correction_cap_reached').length, 0);
});

let pendingId = '';
test('g · sin autorización: 0 llamadas y UNA sola mejora pendiente en Decisiones aunque se intente dos veces', async () => {
  assert.equal(getAutoImproveAuthorization(slug).enabled, false, 'desactivada por defecto');
  const pj = proj();
  const L = mkLesson(pj.id); pendingId = L.id;
  lessonsRepo(slug).bumpRecurrence(L.id, 'proc-x1'); lessonsRepo(slug).bumpRecurrence(L.id, 'proc-x2');
  adapters.resetMockCalls();
  await maybeImproveLessons(slug, pj.id); await maybeImproveLessons(slug, pj.id);
  assert.equal(adapters.mockCalls, 0, 'sin autorización: 0 llamadas');
  assert.equal(pendingImprovementItems(slug).filter(i => i.lessonId === L.id).length, 1);
  assert.equal(lessonsRepo(slug).get(L.id)!.improvement?.state, 'pending_decision');
  const app = await buildApp();
  const inbox = await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/inbox/lessons` });
  assert.equal(inbox.statusCode, 200); assert.equal(inbox.json().filter((i: any) => i.lessonId === L.id).length, 1);
  const get = await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/lessons/auto-improve` }); assert.equal(get.json().enabled, false);
  const neg = await app.inject({ method: 'PUT', url: `/api/workspaces/${slug}/lessons/auto-improve`, payload: { authorized: true, enabled: true, monthlyCallCap: -1, monthlyUsdCap: 1 } });
  assert.equal(neg.statusCode, 400);
  const noAuth = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/lessons/${L.id}/improvement/accept`, payload: {} });
  assert.equal(noAuth.statusCode, 403); assert.equal(adapters.mockCalls, 0);
  await app.close();
});

test('h · aceptar con un clic: versión nueva source curator, la anterior obsoleta con enlace y práctica sincronizada', async () => {
  const app = await buildApp();
  adapters.resetMockCalls(); const grants = policyGrants();
  const r = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/lessons/${pendingId}/improvement/accept`, payload: { authorized: true } });
  assert.equal(r.statusCode, 200, r.body);
  const v = r.json();
  assert.equal(adapters.mockCalls, 1); assert.equal(policyGrants(), grants + 1, 'la llamada pasó por requirePolicy');
  assert.equal(v.source, 'curator'); assert.equal(v.version, 2); assert.equal(v.parentId, pendingId); assert.equal(v.lessonText, NEW_TEXT);
  assert.equal(v.improvement.state, 'applied'); assert.equal(v.improvement.reason, 'recurred');
  assert.equal(lessonsRepo(slug).get(pendingId)!.status, 'obsolete');
  assert.equal(pendingImprovementItems(slug).filter(i => i.lessonId === pendingId).length, 0);
  const latest = templatesRepo(slug).latest('pj-dev')!;
  assert.ok(latest.practices.some(p => p.lessonId === v.id), 'llega sola a la plantilla');
  assert.ok(!latest.practices.some(p => p.lessonId === pendingId));
  await app.close();
});

test('i · con autorización permanente: una llamada por requirePolicy, versión nueva y uso registrado', async () => {
  setAutoImproveAuthorization(slug, { enabled: true, monthlyCallCap: 5, monthlyUsdCap: 5 });
  const pj = proj(); const L = mkLesson(pj.id);
  lessonsRepo(slug).bumpRecurrence(L.id, 'proc-y1'); lessonsRepo(slug).bumpRecurrence(L.id, 'proc-y2');
  adapters.resetMockCalls(); const grants = policyGrants();
  const out = await maybeImproveLessons(slug, pj.id);
  assert.equal(out.applied, 1); assert.equal(adapters.mockCalls, 1); assert.equal(policyGrants(), grants + 1);
  const v = lessonsRepo(slug).successorOf(L.id)!;
  assert.equal(v.source, 'curator'); assert.equal(v.improvement?.state, 'applied'); assert.equal(lessonsRepo(slug).get(L.id)!.status, 'obsolete');
  assert.equal(getAutoImproveAuthorization(slug).usage.calls, 1);
});

test('j · con el tope agotado: 0 llamadas y la mejora queda pendiente', async () => {
  setAutoImproveAuthorization(slug, { enabled: true, monthlyCallCap: 0, monthlyUsdCap: 5 });
  const pj = proj(); const L = mkLesson(pj.id);
  lessonsRepo(slug).bumpRecurrence(L.id, 'proc-z1'); lessonsRepo(slug).bumpRecurrence(L.id, 'proc-z2');
  adapters.resetMockCalls();
  const out = await maybeImproveLessons(slug, pj.id);
  assert.equal(adapters.mockCalls, 0); assert.equal(out.pending, 1);
  assert.equal(pendingImprovementItems(slug).filter(i => i.lessonId === L.id).length, 1);
});

let refutedId = '';
test('k · una refutada recibe por el mismo camino su versión sucesora; otra ejecución no crea otra', async () => {
  setAutoImproveAuthorization(slug, { enabled: true, monthlyCallCap: 10, monthlyUsdCap: 5 });
  const pj = proj(); const L = mkLesson(pj.id); refutedId = L.id;
  const at = new Date().toISOString();
  lessonsRepo(slug).addProof(L.id, { processId: 'proc-r1', processTitle: 'R1', result: 'recurred', detail: 'x', at });
  lessonsRepo(slug).addProof(L.id, { processId: 'proc-r2', processTitle: 'R2', result: 'recurred', detail: 'x', at });
  lessonsRepo(slug).update(L.id, { status: 'refuted' });
  adapters.resetMockCalls();
  await maybeImproveLessons(slug, pj.id); await maybeImproveLessons(slug, pj.id);
  assert.equal(adapters.mockCalls, 1);
  const succ = lessonsRepo(slug).list(null, null).filter(l => l.parentId === L.id);
  assert.equal(succ.length, 1, 'sin sucesora duplicada');
  assert.equal(succ[0].source, 'curator'); assert.equal(succ[0].improvement?.reason, 'refuted'); assert.equal(lessonsRepo(slug).get(L.id)!.status, 'obsolete');
});

test('l · volver a la versión anterior reactiva la madre y deja obsoleta la mejora', async () => {
  const app = await buildApp();
  const succ = lessonsRepo(slug).successorOf(refutedId)!;
  const r = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/lessons/${succ.id}/improvement/revert`, payload: { confirm: true } });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().id, refutedId); assert.equal(r.json().status, 'validated');
  const after = lessonsRepo(slug).get(succ.id)!;
  assert.equal(after.status, 'obsolete'); assert.equal(after.improvement?.state, 'reverted');
  assert.ok(!templatesRepo(slug).latest('pj-dev')!.practices.some(p => p.lessonId === succ.id));
  await app.close();
});

test('m · recálculo de los contadores existentes: una por proceso no verificado, sin borrar evidencia; repetirlo da lo mismo', () => {
  const pj = proj(); const L = mkLesson(pj.id);
  const ok = mkProc(pj.id, { pipeline: { state: 'verified', events: [] } });
  const at = new Date().toISOString();
  lessonsRepo(slug).addProof(L.id, { processId: ok.id, processTitle: 'V', result: 'recurred', detail: 'x', at });
  lessonsRepo(slug).addProof(L.id, { processId: 'proc-borrado', processTitle: 'B', result: 'recurred', detail: 'x', at });
  const db = workspaceDb(slug);
  db.prepare(`UPDATE lessons SET recurrence_count = 5, recurrence_json = '[]' WHERE id = ?`).run(L.id);
  const proofBefore = lessonsRepo(slug).get(L.id)!.proof;
  for (let i = 0; i < 2; i++) {
    db.prepare(`DELETE FROM lessons_meta WHERE key = 'recurrence_per_process'`).run();
    const l = lessonsRepo(slug).get(L.id)!;
    assert.equal(l.recurrenceCount, 1, 'el verificado no cuenta; el que ya no existe se conserva');
    assert.deepEqual(l.recurrenceProcesses, ['proc-borrado']);
    assert.deepEqual(l.proof, proofBefore, 'evidencia intacta');
  }
});

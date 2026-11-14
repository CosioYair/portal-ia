import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Portal IA 4 · EN-029 después de integrar. El cambio de paleta se integró y se activó; la comprobación en ejecución que
 * escribió el equipo («/<div id="root"», una barra sin cerrar) se leyó como texto literal y dio por rota /oficina. Eso
 * abrió una iteración correctiva sobre un trabajo ya entregado; el Coordinador (con razón) no encontró nada que cambiar
 * y el Portal ofreció «convertir en encargo de análisis». Ahora: la comprobación se entiende, una pantalla se comprueba
 * con navegador, y un «sin código» con entrega integrada vuelve a esa entrega. Sin IA, sin Docker y sin navegador.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p4ent-'));
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const { matches, isAppShell, runtimeVerified } = await import('../src/services/runtimeChecks.ts');
const { buildStoryFlow } = await import('../src/services/storyFlow.ts');
const { describeProcess } = await import('../src/services/guidance.ts');
const { DEFAULT_PIPELINE } = await import('../../../packages/domain/src/pipeline.ts');

// Respuesta REAL de GET /oficina en el Portal en marcha (el armazón de la aplicación) y la expectativa REAL de EN-029.
const SHELL = '<!doctype html> <html lang="es"> <head> <meta charset="UTF-8" /> <title>Portal IA</title> <script type="module" crossorigin src="/assets/index-abc.js"></script> </head> <body> <div id="root"></div> </body> </html>';
const EXPECT_EN029 = '/<div id="root"';
const SUMMARY = 'Revisé el repositorio y no hace falta cambiar ningún archivo. La nueva paleta ya está en el commit base de la rama (d189bb6).';

test('la expectativa real de EN-029 («/» sin cerrar) se entiende como texto y la pantalla pasa', () => {
  assert.equal(matches(SHELL, EXPECT_EN029), true, 'antes: false, y de ahí salió la corrección inútil');
  assert.equal(matches(SHELL, '/<div id="raiz"'), false, 'lo que de verdad no está sigue fallando');
});

test('las expresiones regulares bien escritas y los textos normales no cambian', () => {
  assert.equal(matches('{"buildCommit":"d189bb6"}', '/"buildCommit":"[0-9a-f]{7,}"/'), true);
  assert.equal(matches('{"buildCommit":"zzz"}', '/"buildCommit":"[0-9a-f]{7,}"/'), false);
  assert.equal(matches('HOLA', '/hola/i'), true);
  assert.equal(matches('ok', 'ok'), true);
  assert.equal(matches('ok', 'error'), false);
  assert.equal(matches('ruta /api/health lista', '/api/health'), true);
  assert.equal(matches('', '/'), false);
});

test('una pantalla se distingue de una respuesta de la API: solo la pantalla se comprueba con navegador', () => {
  assert.equal(isAppShell('/oficina', SHELL), true);
  assert.equal(isAppShell('/api/system/status', SHELL), false);
  assert.equal(isAppShell('/oficina', '{"ok":true}'), false);
});

const base = (result: any, extra: any = {}): any => ({ id: 'p-nuevo', kind: 'story_execution', status: 'done', projectId: 'p1', backlogItemId: null, assignmentId: 'a1', estimatedUsd: 0, steps: [], createdAt: '2026-11-14T18:20:11.713Z', result, ...extra });
// La nota REAL con la que el Portal abrió la iteración de EN-029 (no la escribió el propietario).
const NOTA_PORTAL = 'Nota del propietario (cambios pedidos): La comprobación en ejecución falló\n- http /oficina: HTTP 200; la respuesta no contiene lo esperado.';
const noCode = (iterationContext: string | null = NOTA_PORTAL) => base({ changes: [], verifications: [], applied: null, review: null, iterationContext, planNoCode: { summary: SUMMARY, at: '2026-11-14T18:20:46.366Z', basis: 'x' },
  pipeline: { state: 'stopped', pauseKind: 'plan', reason: `El Coordinador concluyó que esta historia no cambia ningún archivo del repositorio: «${SUMMARY}».`, config: { ...DEFAULT_PIPELINE }, failures: [], events: [], corrections: 0 } });
const DELIVERED = { processId: 'p-integrado', commit: 'd189bb6', mergedAt: '2026-11-14T18:12:57.665Z' };

test('«sin código» con una entrega ya integrada: se vuelve a la entrega, no se convierte en análisis', () => {
  const flow = buildStoryFlow(noCode(), { delivered: DELIVERED });
  assert.match(flow.issue!.title, /ya está entregado/);
  assert.match(flow.issue!.explanation, /d189bb6/);
  assert.doesNotMatch(flow.issue!.explanation, /encargo de análisis \(se autoriza aparte\)/);
  const ids = flow.actions.map(a => a.id);
  assert.equal(ids.includes('convert_to_analysis'), false, 'pedir un cambio no acaba en un análisis');
  const main = flow.actions.find(a => a.primary)!;
  assert.equal(main.id, 'restore_delivered');
  assert.match(main.label, /sin IA/);
  assert.match(describeProcess(noCode(), { delivered: DELIVERED }).phase, /Ya entregado/);
});

test('«sin código» SIN entrega anterior conserva la salida de siempre', () => {
  const flow = buildStoryFlow(noCode(), {});
  assert.equal(flow.actions.find(a => a.primary)!.id, 'convert_to_analysis');
  assert.match(flow.issue!.title, /no pide cambios de código/);
});

const rcResult = (p: string, status: string, expect = 'ok') => ({ check: { kind: 'http', path: p, selector: null, expect }, status, detail: status === 'ok' ? 'HTTP 200, la respuesta contiene lo esperado.' : 'HTTP 200; la respuesta no contiene lo esperado.', evidence: null, at: '2026-11-14T18:13:35.299Z' });
const merged = (results: any[]) => base({
  changes: [{ path: 'apps/web/src/tokens.css', content: 'x' }], verifications: [], review: { approve: true, verdict: 'approved', summary: 's', issues: [], findings: [] },
  applied: { branch: 'portal-ia/en-029', commit: '4401dba', worktree: null, files: [] }, merged: { into: 'main', commit: 'd189bb6', mergedAt: '2026-11-14T18:12:57.665Z' },
  activation: { active: true, runningCommit: 'd189bb6', buildCommit: 'd189bb6', buildAt: '2026-11-14T18:13:11.776Z', reason: 'El servidor y la interfaz en marcha contienen este cambio.' },
  runtimeChecks: { checks: results.map(r => r.check), results, ranAt: '2026-11-14T18:13:35.303Z' },
  pipeline: { state: 'verified', phase: 'finished', pauseKind: null, reason: null, config: { ...DEFAULT_PIPELINE }, failures: [], events: [], corrections: 1 }
}, { id: 'p-integrado', createdAt: '2026-11-14T04:54:19.145Z' });

test('integrado y activo, el Portal responde y solo falla la comprobación del equipo: primero se repite (sin IA)', () => {
  const flow = buildStoryFlow(merged([rcResult('/api/health', 'ok'), rcResult('/api/system/status', 'ok'), rcResult('/oficina', 'fail', EXPECT_EN029)]), { isPortalRepo: true });
  assert.equal(flow.issue!.kind, 'runtime_failed');
  assert.match(flow.issue!.title, /el Portal en marcha responde bien/);
  assert.notEqual(flow.issue!.cause, 'code', 'no se culpa al código sin saberlo');
  const main = flow.actions.find(a => a.primary)!;
  assert.equal(main.id, 'runtime_check');
  assert.ok(flow.actions.findIndex(a => a.id === 'runtime_check') < flow.actions.findIndex(a => a.id === 'request_fix'), 'repetir va antes que pedir corrección');
});

test('si el Portal mismo no responde, sí es del código y la corrección va primero', () => {
  const flow = buildStoryFlow(merged([rcResult('/api/health', 'fail'), rcResult('/api/system/status', 'ok')]), { isPortalRepo: true });
  assert.equal(flow.issue!.cause, 'code');
  assert.equal(flow.actions[0].id, 'request_fix');
});

test('con las tres comprobaciones en verde la entrega queda verificada en ejecución', () => {
  const p = merged([rcResult('/api/health', 'ok'), rcResult('/api/system/status', 'ok'), rcResult('/oficina', 'ok', EXPECT_EN029)]);
  assert.equal(runtimeVerified(p.result.runtimeChecks), true);
  const flow = buildStoryFlow(p, { isPortalRepo: true });
  assert.notEqual(flow.issue?.kind, 'runtime_failed');
});

// ---- De punta a punta, con la base de datos y la ruta real (propietario vinculado) ----
const { INTERNAL_WORKSPACE, classifyModel } = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { assignmentsRepo } = await import('../src/db/assignments.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { workView } = await import('../src/services/work.ts');

test('la ruta «volver a la entrega integrada» deja vigente lo integrado, supera la iteración sin código y no borra nada', async () => {
  providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
  providersRepo.setConnected('anthropic', ['claude-opus-5-5'].map(id => classifyModel('anthropic', id)));
  runBootstrap();
  const S = INTERNAL_WORKSPACE.slug; const project = projectsRepo(S).list()[0];
  const app = await buildApp();
  try {
    const procs = processesRepo(S); const asg = assignmentsRepo(S);
    const en = asg.create({ projectId: project.id, owner: 'owner', request: 'cambia los colores del portal por unos mejores', title: 'Nueva paleta', objective: '', criteria: ['c'], outOfScope: [], size: 'S', status: 'in_progress', reason: null, conversationId: null, messageId: null, processId: null, processIds: [] } as any);
    const mk = () => procs.create({ projectId: project.id, kind: 'story_execution', title: `${en.code} · Nueva paleta`, estimatedUsd: 0, assignmentId: en.id, steps: [] });
    const a = mk(); await new Promise(r => setTimeout(r, 15)); const b = mk();
    procs.setResult(a.id, merged([rcResult('/api/health', 'ok'), rcResult('/api/system/status', 'ok'), rcResult('/oficina', 'fail', EXPECT_EN029)]).result); procs.finish(a.id, 'done');
    procs.setResult(b.id, noCode().result); procs.finish(b.id, 'done');
    procs.markSuperseded(a.id, b.id);
    asg.update(en.id, x => { x.processId = b.id; x.processIds = [a.id, b.id]; });

    const W = `/api/workspaces/${S}`;
    const seen = (await app.inject({ method: 'GET', url: `${W}/processes/${b.id}` })).json();
    assert.equal(seen.guidance.flow.actions.find((x: any) => x.primary).id, 'restore_delivered', 'la ficha del proceso ofrece volver a la entrega');

    const no = await app.inject({ method: 'POST', url: `${W}/processes/${b.id}/restore-delivered`, payload: {} });
    assert.equal(no.statusCode, 400, 'sin autorización explícita no hace nada');
    const res = await app.inject({ method: 'POST', url: `${W}/processes/${b.id}/restore-delivered`, payload: { authorized: true } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().id, a.id);
    assert.equal(procs.get(a.id)!.supersededBy, null);
    assert.equal(procs.get(b.id)!.supersededBy, a.id);
    assert.ok(procs.get(b.id)!.result!.planNoCode, 'la iteración sin código se conserva como historial');
    assert.equal(asg.get(en.id)!.processId, a.id);
    const item = workView(S, project.id).items.find(i => i.id === en.id)!;
    assert.equal(item.processId, a.id, 'Trabajo apunta a la entrega integrada');

    const again = await app.inject({ method: 'POST', url: `${W}/processes/${a.id}/restore-delivered`, payload: { authorized: true } });
    assert.equal(again.statusCode, 409, 'la entrega integrada no tiene a dónde volver');
  } finally { await app.close(); }
});

// ---- Sin clic del propietario: el estado se corrige solo (al arrancar y al terminar un proceso) ----
const { reconcileDelivered } = await import('../src/services/deliveredReconcile.ts');
const { canLaunchWork, blocksNewBatch } = await import('../src/services/batchRunner.ts');

test('un trabajo integrado que quedó «detenido» por una iteración sin código vuelve solo a su entrega (EN-029 en vivo)', async () => {
  const S = INTERNAL_WORKSPACE.slug; const project = projectsRepo(S).list()[0];
  const procs = processesRepo(S); const asg = assignmentsRepo(S);
  const en = asg.create({ projectId: project.id, owner: 'owner', request: 'cambia los colores', title: 'Paleta', objective: '', criteria: ['c'], outOfScope: [], size: 'S', status: 'changes_requested', reason: null, conversationId: null, messageId: null, processId: null, processIds: [], iterationNote: 'La historia no pide cambios de código: decide cómo hacerla' } as any);
  const mk = () => procs.create({ projectId: project.id, kind: 'story_execution', title: `${en.code} · Paleta`, estimatedUsd: 0, assignmentId: en.id, steps: [] });
  // Como en el Portal en marcha: la integrada, y DOS iteraciones sin código detrás (f7618b53 y afaf14d2).
  const a = mk(); await new Promise(r => setTimeout(r, 15)); const b = mk(); await new Promise(r => setTimeout(r, 15)); const c = mk();
  procs.setResult(a.id, merged([rcResult('/api/health', 'ok'), rcResult('/api/system/status', 'ok'), rcResult('/oficina', 'fail', EXPECT_EN029)]).result); procs.finish(a.id, 'done');
  procs.setResult(b.id, noCode().result); procs.finish(b.id, 'done');
  procs.setResult(c.id, noCode().result); procs.finish(c.id, 'done');
  procs.markSuperseded(a.id, b.id);
  asg.update(en.id, x => { x.processId = c.id; x.processIds = [a.id, b.id, c.id]; });
  const before = workView(S, project.id).items.find(i => i.id === en.id)!;
  assert.notEqual(before.state.key, 'integrated_unaccepted', `así se veía: «${before.state.label}», aunque estaba integrado`);

  const done = reconcileDelivered(S).filter(r => r.restored === a.id);
  assert.ok(done.length >= 1, 'la conciliación encuentra el trabajo');
  assert.equal(procs.get(a.id)!.supersededBy, null);
  assert.equal(procs.get(b.id)!.supersededBy, a.id); assert.equal(procs.get(c.id)!.supersededBy, a.id);
  const item = workView(S, project.id).items.find(i => i.id === en.id)!;
  assert.equal(item.processId, a.id);
  assert.equal(item.state.key, 'integrated_unaccepted', 'ahora dice la verdad: integrado, falta tu aceptación');
  assert.equal(asg.get(en.id)!.status, 'ready_for_review', 'no se acepta nada por el propietario: queda para su revisión');
  assert.deepEqual(reconcileDelivered(S).filter(r => r.restored === a.id), [], 'una segunda pasada no hace nada');
});

test('una iteración posterior que aún espera la autorización del propietario no se toca', () => {
  const S = INTERNAL_WORKSPACE.slug; const project = projectsRepo(S).list()[0]; const procs = processesRepo(S); const asg = assignmentsRepo(S);
  const en = asg.create({ projectId: project.id, owner: 'owner', request: 'x', title: 'Otra', objective: '', criteria: ['c'], outOfScope: [], size: 'S', status: 'running', reason: null, conversationId: null, messageId: null, processId: null, processIds: [] } as any);
  const a = procs.create({ projectId: project.id, kind: 'story_execution', title: 'a', estimatedUsd: 0, assignmentId: en.id, steps: [] });
  procs.setResult(a.id, merged([rcResult('/api/health', 'ok')]).result); procs.finish(a.id, 'done');
  const b = procs.create({ projectId: project.id, kind: 'story_execution', title: 'b', estimatedUsd: 0, assignmentId: en.id, steps: [] });
  asg.update(en.id, x => { x.processId = b.id; });
  assert.deepEqual(reconcileDelivered(S).filter(r => r.from === b.id), [], 'pendiente de autorizar: es decisión del propietario');
  assert.equal(asg.get(en.id)!.processId, b.id);
});

test('la comprobación tolerante no se pasa de laxa: «/a» no se da por buena con cualquier «a»', () => {
  assert.equal(matches('una página cualquiera', '/a'), false);
  assert.equal(matches('ruta api health', '/api'), false, 'una ruta sigue buscándose tal cual');
  assert.equal(matches('<h1>Hola mundo</h1>', '/Hola mundo'), true, 'varias palabras sí son texto');
  assert.equal(matches('x'.repeat(10), `/${'a'.repeat(600)}/`), false, 'una expresión desmesurada no se evalúa');
});

// ---- Lotes: uno atascado esperando al propietario no impide crear otro (lote 640b06fe) ----
const bi = (storyId: string, state: string, o: any = {}): any => ({ storyId, state, dependsOn: null, dependsInBatch: true, failureClass: null, processIds: [], ...o });
const batch = (status: string, items: any[]): any => ({ id: 'b1', projectId: 'p', status, items, title: 'Lote 5' });

test('un lote en pausa cuyo único trabajo espera a una historia detenida no bloquea un lote nuevo', () => {
  const stuck = batch('paused', [bi('HU-214', 'needs_decision'), bi('HU-215', 'waiting_dependency', { dependsOn: 'HU-214' }), bi('HU-216', 'waiting_dependency', { dependsOn: 'HU-215' })]);
  assert.equal(canLaunchWork('portal-ia', stuck), false, 'nada puede avanzar sin el propietario');
  assert.equal(blocksNewBatch('portal-ia', stuck), false, 'antes: cualquier lote en pausa bloqueaba');
});

test('un lote con trabajo que sí avanza solo sigue bloqueando (no se pisan dos lotes activos)', () => {
  assert.equal(blocksNewBatch('portal-ia', batch('running', [bi('HU-1', 'running')])), true);
  assert.equal(blocksNewBatch('portal-ia', batch('paused', [bi('HU-1', 'queued')])), true, 'en pausa pero con cola: al reanudarlo trabajaría');
  assert.equal(blocksNewBatch('portal-ia', batch('paused', [bi('HU-1', 'running'), bi('HU-2', 'waiting_dependency', { dependsOn: 'HU-1' })])), true);
  assert.equal(canLaunchWork('portal-ia', batch('needs_decision', [bi('HU-1', 'waiting_dependency', { dependsOn: 'HU-2' }), bi('HU-2', 'waiting_dependency', { dependsOn: 'HU-1' })])), false, 'una dependencia circular no se cuenta como avance');
});

// ---- Ronda 2 del Gauntlet: la vuelta automática es estrecha y no pisa decisiones del propietario ----
const { autoRestorable, installDeliveredReconcile } = await import('../src/services/deliveredReconcile.ts');
const { backlogRepo } = await import('../src/db/workspace.ts');

function family(note: string | null, o: { analysis?: boolean } = {}): { en: any; a: any; b: any } {
  const S = INTERNAL_WORKSPACE.slug; const project = projectsRepo(S).list()[0]; const procs = processesRepo(S); const asg = assignmentsRepo(S);
  const en = asg.create({ projectId: project.id, owner: 'owner', request: 'x', title: 'Caso', objective: '', criteria: ['c'], outOfScope: [], size: 'S', status: 'needs_owner', reason: null, conversationId: null, messageId: null, processId: null, processIds: [] } as any);
  const a = procs.create({ projectId: project.id, kind: 'story_execution', title: 'integrada', estimatedUsd: 0, assignmentId: en.id, steps: [] });
  procs.setResult(a.id, merged([rcResult('/api/health', 'ok')]).result); procs.finish(a.id, 'done');
  const b = procs.create({ projectId: project.id, kind: 'story_execution', title: 'sin código', estimatedUsd: 0, assignmentId: en.id, steps: [] });
  const r = noCode(note).result; if (o.analysis) r.planNoCode.analysisProcessId = 'proc-analisis';
  procs.setResult(b.id, r); procs.finish(b.id, 'done'); asg.update(en.id, x => { x.processId = b.id; });
  return { en, a, b };
}

test('si el cambio lo pidió el propietario con sus palabras, el Portal NO deshace su iteración por su cuenta', () => {
  const S = INTERNAL_WORKSPACE.slug;
  const { en, b } = family('Nota del propietario (cambios pedidos): quiero el botón principal más grande y en verde');
  assert.equal(autoRestorable(S, processesRepo(S).get(b.id)!), false);
  assert.deepEqual(reconcileDelivered(S).filter(x => x.from === b.id), []);
  assert.equal(assignmentsRepo(S).get(en.id)!.processId, b.id, 'sigue siendo la vigente: decide él');
  assert.equal(processesRepo(S).get(b.id)!.supersededBy, null);
});

test('si ya la convirtió en un encargo de análisis, tampoco se toca', () => {
  const S = INTERNAL_WORKSPACE.slug; const { b } = family(NOTA_PORTAL, { analysis: true });
  assert.deepEqual(reconcileDelivered(S).filter(x => x.from === b.id), []);
});

test('se hace UNA vez: si el propietario recupera la iteración, el Portal no vuelve a superarla', () => {
  const S = INTERNAL_WORKSPACE.slug; const procs = processesRepo(S); const { a, b } = family(NOTA_PORTAL);
  assert.equal(reconcileDelivered(S).filter(x => x.from === b.id).length, 1);
  assert.ok((procs.get(b.id)!.result as any).deliveredRestore, 'queda constancia de quién y cuándo');
  procs.restoreSuperseded(b.id);                         // el propietario la recupera desde el historial
  assert.equal(procs.get(b.id)!.supersededBy, null);
  assert.deepEqual(reconcileDelivered(S).filter(x => x.from === b.id), [], 'se respeta su decisión');
  assert.equal(procs.get(a.id)!.result!.merged!.commit, 'd189bb6', 'la entrega integrada no se altera');
});

test('una HISTORIA vuelve a «en revisión» con su entrega integrada (no queda «pendiente», que la haría repetirse)', () => {
  const S = INTERNAL_WORKSPACE.slug; const project = projectsRepo(S).list()[0]; const procs = processesRepo(S); const bl = backlogRepo(S);
  const item = bl.add({ projectId: project.id, storyId: 'HU-900', title: 'Historia de prueba', ownerKey: null, dependsOn: null, estimate: 'S', criterion: 'c', description: '', sourceProcessId: null } as any);
  const a = procs.create({ projectId: project.id, kind: 'story_execution', title: 'integrada', estimatedUsd: 0, backlogItemId: item.id, steps: [] });
  procs.setResult(a.id, merged([rcResult('/api/health', 'ok')]).result); procs.finish(a.id, 'done');
  const b = procs.create({ projectId: project.id, kind: 'story_execution', title: 'sin código', estimatedUsd: 0, backlogItemId: item.id, steps: [] });
  procs.setResult(b.id, noCode().result); procs.finish(b.id, 'done'); bl.setStatus(item.id, 'pending', b.id);
  assert.equal(reconcileDelivered(S).filter(x => x.from === b.id).length, 1);
  const after = bl.get(item.id)!;
  assert.deepEqual([after.status, after.lastProcessId], ['review', a.id]);
});

test('al terminar un proceso la corrección se hace sola (el enganche real, no solo la función)', async () => {
  const S = INTERNAL_WORKSPACE.slug; const procs = processesRepo(S); const project = projectsRepo(S).list()[0]; const asg = assignmentsRepo(S);
  installDeliveredReconcile([S]);
  const en = asg.create({ projectId: project.id, owner: 'owner', request: 'x', title: 'Enganche', objective: '', criteria: ['c'], outOfScope: [], size: 'S', status: 'running', reason: null, conversationId: null, messageId: null, processId: null, processIds: [] } as any);
  const a = procs.create({ projectId: project.id, kind: 'story_execution', title: 'integrada', estimatedUsd: 0, assignmentId: en.id, steps: [] });
  procs.setResult(a.id, merged([rcResult('/api/health', 'ok')]).result); procs.finish(a.id, 'done');
  const b = procs.create({ projectId: project.id, kind: 'story_execution', title: 'sin código', estimatedUsd: 0, assignmentId: en.id, steps: [] });
  asg.update(en.id, x => { x.processId = b.id; });
  procs.setResult(b.id, noCode().result);
  procs.finish(b.id, 'done');                              // aquí salta el enganche
  await new Promise(r => setTimeout(r, 60));
  assert.equal(procs.get(b.id)!.supersededBy, a.id); assert.equal(asg.get(en.id)!.processId, a.id);
});

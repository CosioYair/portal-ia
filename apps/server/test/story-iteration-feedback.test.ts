import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Fase 2 · Iterar desde el feedback de la prueba manual: estados de la iteración anterior (no aplicada, aplicada en
 * worktree, anterior a v0.12, integrada, historia cerrada), edición del contexto con historial y orientación.
 * Proveedor simulado; datos y repositorio temporales.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-iter-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json');
const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, manualTestStepKey } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo, backlogRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { describeProcess } = await import('../src/services/guidance.ts');
const adapters = await import('@portal-ia/ai-adapters');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const internal = projectsRepo('portal-ia').list()[0];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-iter-repo-'));
fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n'); fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: dir });
projectsRepo('portal-ia').setRepository(internal.id, dir, 'main');
const PLAN = '{"summary":"Cambiar a","tasks":["Editar src/a.ts"],"filesToRead":["src/a.ts"],"filesToChange":["src/a.ts"],"acceptance":["a = 2"],"risks":[]}';
const IMPL = '=== RESUMEN ===\nCambia a.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nNada visible.\n=== PRUEBA MANUAL ===\n1. Abre X. Esperado: Y.\n2. Pulsa Z. Esperado: W.\n=== VERIFICAR: typecheck ===';
fs.writeFileSync(scriptPath, JSON.stringify({ markers: ['Criterio de aceptación: a = 3 y visible'], rules: [{ match: 'plan técnico', text: PLAN }, { match: 'Implementa la historia', text: IMPL }, { match: 'Revisa los cambios propuestos', text: '{"approve": true, "summary": "Bien", "issues": [], "suggestedTests": []}' }] }));

const app = await buildApp();
const W = '/api/workspaces/portal-ia';
const story = (id: string, p = '') => `${W}/stories/${id}${p}`;
const get = async (id: string) => (await app.inject({ method: 'GET', url: story(id) })).json();
/** Ejecuta una iteración con el proveedor simulado (0 USD reales). */
async function execute(itemId: string, procId?: string) {
  const p = procId ? processesRepo('portal-ia').get(procId)! : createStoryProcess('portal-ia', internal.id, itemId);
  processesRepo('portal-ia').authorize(p.id, 1);
  await runStory('portal-ia', p.id, () => undefined, () => false);
  return processesRepo('portal-ia').get(p.id)!;
}
async function failStep(procId: string, steps: string[], i: number, comment: string) {
  const r = await app.inject({ method: 'PUT', url: `${W}/processes/${procId}/manual-test-feedback/${encodeURIComponent(manualTestStepKey(i, steps[i]))}`, payload: { result: 'fail', comment } });
  assert.equal(r.statusCode, 200, r.body);
}
const branches = () => execSync('git branch --format=%(refname:short)', { cwd: dir }).toString().split('\n').map(s => s.trim()).filter(Boolean);

test('iterar: aplicada en worktree sin integrar → exige confirmar el descarte; con confirmación retira worktree y rama e incluye fallos, comentarios, tareas y nota', async () => {
  const it = addManualItem('portal-ia', internal.id, { title: 'Cambiar a (worktree)', criterion: 'a = 2' });
  const p1 = await execute(it.id);
  assert.equal(p1.status, 'done', p1.error ?? '');
  let c = await get(it.id);
  assert.equal(c.iteration.state, 'not_applied'); assert.equal(c.iteration.needsDiscardConfirmation, false);
  const ap = await app.inject({ method: 'POST', url: `${W}/processes/${p1.id}/apply`, payload: { authorized: true } });
  assert.equal(ap.statusCode, 200, ap.body);
  const wt = ap.json().result.applied.worktree; const branch = ap.json().result.applied.branch;
  assert.ok(fs.existsSync(wt)); assert.ok(branches().includes(branch));
  await failStep(p1.id, c.manualTest.steps, 1, 'W no aparece tras pulsar Z');
  await app.inject({ method: 'POST', url: story(it.id, '/tasks'), payload: { title: 'Revisar el render de W' } });
  c = await get(it.id);
  assert.equal(c.iteration.state, 'applied_worktree'); assert.equal(c.iteration.branch, branch); assert.equal(c.iteration.needsDiscardConfirmation, true); assert.equal(c.iteration.failedSteps, 1);
  assert.match(c.iteration.summary, /se borra la rama/);

  adapters.resetMockCalls();
  const noConfirm = await app.inject({ method: 'POST', url: story(it.id, '/iterate'), payload: { note: 'arregla W' } });
  assert.equal(noConfirm.statusCode, 409); assert.equal(noConfirm.json().code, 'discard_confirmation_required'); assert.equal(noConfirm.json().branch, branch);
  assert.ok(fs.existsSync(wt), 'sin confirmación no se toca el worktree'); assert.ok(branches().includes(branch), 'ni la rama');
  assert.equal(processesRepo('portal-ia').get(p1.id)!.result!.rejected, undefined);

  const ok = await app.inject({ method: 'POST', url: story(it.id, '/iterate'), payload: { note: 'arregla W', discardApplied: true } });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(adapters.mockCalls, 0, 'crear la iteración no llama a la IA');
  const { process: p2, context, actions } = ok.json();
  assert.equal(p2.status, 'pending_authorization');
  assert.ok(!fs.existsSync(wt), 'worktree retirado'); assert.ok(!branches().includes(branch), 'rama borrada');
  assert.match(actions.join(' '), /worktree retirado, rama .* borrada/);
  assert.match(processesRepo('portal-ia').get(p1.id)!.result!.rejected!.reason, /nueva iteración/);
  assert.match(context, /Paso 2 \(fail\): Pulsa Z\. Esperado: W\. → W no aparece tras pulsar Z/);
  assert.match(context, /Tareas abiertas:\n- Revisar el render de W/);
  assert.match(context, /Nota del propietario: arregla W/);
  assert.match(context, /Criterio de aceptación vigente: a = 2/);
  c = await get(it.id);
  assert.equal(c.iteration.state, 'in_progress');
  assert.equal(c.iterations, 2); assert.equal(c.lastProcess.id, p2.id);
  assert.ok(c.messages.some((m: any) => m.role === 'system' && /Iteración 2 creada/.test(m.content) && /rama .* borrada/.test(m.content)));
  // La iteración anterior, sus tareas y su feedback se conservan.
  assert.ok(c.processes.some((p: any) => p.id === p1.id)); assert.equal(c.tasks.length, 1);
  assert.equal((await app.inject({ method: 'GET', url: `${W}/processes/${p1.id}/manual-test-feedback` })).json().items[0].comment, 'W no aparece tras pulsar Z');
  const again = await app.inject({ method: 'POST', url: story(it.id, '/iterate'), payload: { discardApplied: true } });
  assert.equal(again.statusCode, 409); assert.equal(again.json().code, 'iteration_in_progress');
});

test('iterar: anterior a v0.12 (sin worktree) → descartada conservando la rama; integrada → parte de main sin rechazar nada', async () => {
  // Anterior a v0.12: aplicada directamente en la carpeta, en una rama propia.
  const itL = addManualItem('portal-ia', internal.id, { title: 'Historia antigua', criterion: 'x' });
  const pL = await execute(itL.id);
  execSync('git branch portal-ia/legacy-test', { cwd: dir });
  processesRepo('portal-ia').setResult(pL.id, { ...pL.result!, applied: { branch: 'portal-ia/legacy-test', commit: 'abc1234', files: ['src/a.ts'], appliedAt: new Date().toISOString() } as any });
  let c = await get(itL.id);
  assert.equal(c.iteration.state, 'legacy'); assert.equal(c.iteration.needsDiscardConfirmation, false); assert.match(c.iteration.summary, /se conserva/);
  const rL = await app.inject({ method: 'POST', url: story(itL.id, '/iterate'), payload: {} });
  assert.equal(rL.statusCode, 201, rL.body);
  assert.ok(branches().includes('portal-ia/legacy-test'), 'la rama antigua se conserva');
  assert.match(processesRepo('portal-ia').get(pL.id)!.result!.rejected!.reason, /anterior a v0.12/);

  // Integrada: la nueva iteración se construye sobre main y no rechaza la anterior.
  const itM = addManualItem('portal-ia', internal.id, { title: 'Historia integrada', criterion: 'y' });
  const pM = await execute(itM.id);
  const steps = pM.result!.manualTest!.steps;
  processesRepo('portal-ia').setResult(pM.id, { ...pM.result!, applied: { branch: 'portal-ia/m', commit: 'def5678', files: ['src/a.ts'], appliedAt: new Date().toISOString(), worktree: path.join(dir, 'x') } as any, merged: { into: 'main', commit: 'fff0001', mergedAt: new Date().toISOString() } as any });
  await failStep(pM.id, steps, 0, 'no se ve Y');
  c = await get(itM.id);
  assert.equal(c.iteration.state, 'merged'); assert.equal(c.iteration.failedSteps, 1);
  // Orientación: con pasos en «Falla», el siguiente paso es enviar el feedback al equipo.
  assert.match(c.lastProcess.guidance.next, /Enviar feedback al equipo/); assert.equal(c.lastProcess.guidance.tone, 'err');
  const viaProcess = (await app.inject({ method: 'GET', url: `${W}/processes/${pM.id}` })).json();
  assert.match(viaProcess.guidance.next, /Enviar feedback al equipo/);
  const rM = await app.inject({ method: 'POST', url: story(itM.id, '/iterate'), payload: {} });
  assert.equal(rM.statusCode, 201, rM.body);
  assert.match(rM.json().context, /YA está integrada en main \(commit fff0001\)/); assert.match(rM.json().context, /Paso 1 \(fail\).*no se ve Y/);
  assert.equal(processesRepo('portal-ia').get(pM.id)!.result!.rejected, undefined, 'lo integrado no se rechaza');
});

test('iterar: historia cerrada → 409 story_closed; con «reabrir» queda registrado en el historial y crea la iteración', async () => {
  const it = addManualItem('portal-ia', internal.id, { title: 'Historia cerrada', criterion: 'z' });
  const p = await execute(it.id);
  processesRepo('portal-ia').setResult(p.id, { ...p.result!, applied: { branch: 'portal-ia/c', commit: 'c0ffee1', files: [], appliedAt: new Date().toISOString(), worktree: path.join(dir, 'y') } as any, merged: { into: 'main', commit: 'c0ffee2', mergedAt: new Date().toISOString() } as any });
  backlogRepo('portal-ia').setStatus(it.id, 'done', p.id);
  let c = await get(it.id);
  assert.equal(c.iteration.needsReopen, true); assert.match(c.iteration.summary, /se reabre/);
  const closed = await app.inject({ method: 'POST', url: story(it.id, '/iterate'), payload: { note: 'falla en móvil' } });
  assert.equal(closed.statusCode, 409); assert.equal(closed.json().code, 'story_closed');
  assert.equal(backlogRepo('portal-ia').get(it.id)!.status, 'done', 'sin reabrir no cambia nada');
  const r = await app.inject({ method: 'POST', url: story(it.id, '/iterate'), payload: { note: 'falla en móvil', reopen: true } });
  assert.equal(r.statusCode, 201, r.body);
  const item = backlogRepo('portal-ia').get(it.id)!;
  assert.equal(item.status, 'pending'); assert.match(item.description, /Reabierta por el propietario para una nueva iteración: falla en móvil/);
  assert.match(r.json().actions.join(' '), /historia reabierta/);
});

test('editar el contexto: sin ejecutar no hay historial; en revisión se registra y la siguiente iteración usa el criterio nuevo', async () => {
  const it = addManualItem('portal-ia', internal.id, { title: 'Editar contexto', criterion: 'a = 2' });
  const e0 = await app.inject({ method: 'PATCH', url: `${W}/backlog/${it.id}`, payload: { description: 'borrador' } });
  assert.equal(e0.statusCode, 200);
  assert.equal((await get(it.id)).messages.length, 0, 'una historia pendiente sin ejecutar no genera historial');
  const p1 = await execute(it.id);
  assert.equal(backlogRepo('portal-ia').get(it.id)!.status, 'review');
  const e1 = await app.inject({ method: 'PATCH', url: `${W}/backlog/${it.id}`, payload: { title: 'Editar contexto (v2)', criterion: 'a = 3 y visible', description: 'borrador\nAhora también en móvil' } });
  assert.equal(e1.statusCode, 200, e1.body);
  assert.equal(e1.json().criterion, 'a = 3 y visible'); assert.equal(e1.json().status, 'review', 'editar no cambia el estado');
  let c = await get(it.id);
  const h = c.messages.find((m: any) => m.role === 'system' && /Contexto editado/.test(m.content));
  assert.ok(h, 'cambio registrado en el historial');
  assert.match(h.content, /en revisión/); assert.match(h.content, /criterio de aceptación: «a = 2» → «a = 3 y visible»/); assert.match(h.content, /título: «Editar contexto» → «Editar contexto \(v2\)»/); assert.match(h.content, /descripción actualizada \(antes: «borrador»\)/);
  const same = await app.inject({ method: 'PATCH', url: `${W}/backlog/${it.id}`, payload: { criterion: 'a = 3 y visible' } });
  assert.equal(same.statusCode, 200);
  assert.equal((await get(it.id)).messages.filter((m: any) => /Contexto editado/.test(m.content)).length, 1, 'sin cambios reales no se registra nada');
  // La siguiente iteración usa el criterio editado (contexto y prompt real del equipo).
  const r = await app.inject({ method: 'POST', url: story(it.id, '/iterate'), payload: {} });
  assert.equal(r.statusCode, 201, r.body); assert.match(r.json().context, /Criterio de aceptación vigente: a = 3 y visible/);
  fs.writeFileSync(logPath, '');
  await execute(it.id, r.json().process.id);
  const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log.find(l => l.rule === 'plan técnico').markers.includes('Criterio de aceptación: a = 3 y visible'), 'el plan recibe el criterio nuevo');
  c = await get(it.id);
  assert.ok(c.processes.some((p: any) => p.id === p1.id), 'la iteración anterior se conserva');
});

test('orientación: verificación en Docker sin dependencias (código 86) pide ejecutar install, no la da por fallo del código', () => {
  const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
  const base: any = { id: 'x', kind: 'story_execution', status: 'done', steps: [], spentUsd: 0, budgetUsd: 1, result: { plan: null, implementationSummary: null, changes: [{ path: 'a', action: 'modify', content: '' }], verifyCommands: [], review: null, verifications: [], applied: { branch: 'portal-ia/hu-1', commit: 'abc', files: [], appliedAt: at(0), worktree: '/w' } } };
  const v = (command: string, exitCode: number, s: number) => ({ command, exitCode, output: '', startedAt: at(s), finishedAt: at(s), durationMs: 1, isolation: 'docker' });
  const g1 = describeProcess({ ...base, result: { ...base.result, verifications: [v('test', 86, 5)] } }, { isPortalRepo: true });
  assert.match(g1.phase, /faltan las dependencias del sandbox/); assert.match(g1.next, /npm ci \(install\)/);
  const g2 = describeProcess({ ...base, result: { ...base.result, verifications: [v('test', 1, 5)] } }, { isPortalRepo: true });
  assert.match(g2.phase, /verificación FALLÓ/);
  const g3 = describeProcess({ ...base, result: { ...base.result, verifications: [v('test', 86, 5), v('install', 0, 10)] } }, { isPortalRepo: true });
  assert.match(g3.phase, /falta verificar/, 'tras instalar, se pide repetir la verificación');
});
test.after(async () => { await app.close(); });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Recorrido guiado y recuperación de errores: cada fallo conocido se clasifica (entorno / código / decisión), se explica y
 * trae una acción que lo resuelve por el flujo existente; ninguna acción gasta IA, abre la red ni ejecuta nada protegido
 * sin autorización. Proveedor simulado, datos y repositorio temporales.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-flow-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { buildStoryFlow } = await import('../src/services/storyFlow.ts');
const { parseTypeScriptErrors, parseFailingTests, parseBuildErrors, qaSeverity } = await import('../src/services/diagnostics.ts');
const adapters = await import('@portal-ia/ai-adapters');

// ---------- Unidades: diagnósticos ----------
const TS_OUT = '> demo@1.0.0 typecheck\n> tsc --noEmit\n\nsrc/a.ts(1,14): error TS2322: Type \'string\' is not assignable to type \'number\'.\napps/web/src/screens/Backlog.tsx:12:5 - error TS2304: Cannot find name \'abiertasQueNoExiste\'.\n';
const TAP_OUT = 'TAP version 13\nnot ok 3 - el contador suma\n  ---\n  location: \'/work/test/contador.test.ts:10:1\'\n  error: \'Expected values to be strictly equal: 1 !== 2\'\n  ...\nok 4 - otra\nnot ok 5 - test/contador.test.ts\n';
test('diagnósticos: TypeScript, pruebas, build y gravedad de QA', () => {
  const ts = parseTypeScriptErrors(TS_OUT);
  assert.deepEqual(ts.map(d => [d.file, d.line, d.code]), [['src/a.ts', 1, 'TS2322'], ['apps/web/src/screens/Backlog.tsx', 12, 'TS2304']]);
  const t = parseFailingTests(TAP_OUT);
  assert.equal(t.length, 1, 'la fila del archivo no cuenta como prueba'); assert.match(t[0].text, /el contador suma — Expected values/); assert.equal(t[0].file, 'test/contador.test.ts');
  assert.match(parseFailingTests('✖ suma dos números (3.2ms)\n')[0].text, /suma dos números/);
  const b = parseBuildErrors('vite v7\n✘ [ERROR] Expected ")" but found ";"\n    src/screens/Backlog.tsx:40:22:\nerror during build:\n');
  assert.ok(b.some(d => /Expected "\)"/.test(d.text)));
  assert.deepEqual(qaSeverity('[alta] Rompe el login'), { severity: 'alta', text: 'Rompe el login' });
  assert.equal(qaSeverity('Riesgo de seguridad: expone la clave').severity, 'alta');
  assert.equal(qaSeverity('Sugerencia: renombrar la variable').severity, 'baja');
  assert.equal(qaSeverity('Falta un caso de prueba').severity, 'media');
});

// ---------- Unidades: recorrido por tipo de problema ----------
const now = Date.now(); const at = (s: number) => new Date(now + s * 1000).toISOString();
const run = (command: string, exitCode: number, s: number, output = '', isolation: any = 'docker') => ({ command, exitCode, output, startedAt: at(s), finishedAt: at(s), durationMs: 1000, isolation });
const step = (role: string, agentName: string, status = 'done') => ({ id: role, processId: 'p', position: 0, agentId: role, agentName, title: role, role, status, model: 'm', inputTokens: 10, outputTokens: 10, costUsd: 0.01, outputMd: 'x', error: null, startedAt: at(-60), finishedAt: status === 'done' ? at(-30) : null });
const base = (over: any = {}, result: any = {}): any => ({ id: 'p', projectId: 'x', kind: 'story_execution', title: 'HU-1 · t', status: 'done', budgetUsd: 1, estimatedUsd: 0.2, spentUsd: 0.1, inputTokens: 1, outputTokens: 1, createdAt: at(-100), authorizedAt: at(-90), startedAt: at(-90), finishedAt: at(-10), error: null, delegation: null, backlogItemId: 'b',
  steps: [step('planner', 'Coordinador del Proyecto'), step('implementer', 'Desarrollador Full Stack'), step('reviewer', 'Especialista QA')],
  result: { plan: null, implementationSummary: 'x', changes: [{ path: 'src/a.ts', action: 'modify', content: '', diff: '', before: 1, after: 1 }], verifyCommands: [], review: { approve: true, issues: [], suggestedTests: [], summary: 'Bien.' }, applied: null, verifications: [], ...result }, ...over });
const applied = { branch: 'portal-ia/hu-1', commit: 'abc1234', files: ['src/a.ts'], appliedAt: at(0), worktree: '/wt/p' };
const stage = (f: any, k: string) => f.stages.find((s: any) => s.key === k);

test('recorrido A · faltan dependencias (86): bloqueo de entorno, no fallo del código; acción «instalar y repetir» con red y autorización', () => {
  const f = buildStoryFlow(base({}, { applied, verifications: [run('typecheck', 86, 5, 'Faltan las dependencias Linux de este package-lock')] }), { isPortalRepo: true, sandbox: 'docker' });
  assert.equal(f.issue?.kind, 'deps_missing'); assert.equal(f.issue?.cause, 'environment'); assert.match(f.issue!.title, /bloqueada.*dependencias/i);
  assert.equal(stage(f, 'verify').status, 'blocked'); assert.equal(f.current, 'verify');
  const a = f.actions.find(x => x.primary)!;
  assert.equal(a.id, 'install_and_retry'); assert.deepEqual(a.requires.sort(), ['authorization', 'network']); assert.deepEqual(a.commands, ['typecheck', 'test', 'build']);
  assert.ok(!f.actions.some(x => x.id === 'request_fix'), 'un problema del entorno no pide una iteración');
  // Tras instalar bien, la ejecución con 86 queda solo pendiente de repetir
  const f2 = buildStoryFlow(base({}, { applied, verifications: [run('typecheck', 86, 5), run('install', 0, 10)] }), { isPortalRepo: true, sandbox: 'docker' });
  assert.equal(f2.issue, null); assert.equal(stage(f2, 'verify').status, 'current'); assert.equal(f2.actions[0].id, 'verify');
});

test('recorrido B · error de TypeScript: diagnósticos con archivo/línea, corrección por el equipo, integrar bloqueado', () => {
  const f = buildStoryFlow(base({}, { applied, verifications: [run('typecheck', 2, 5, TS_OUT)] }), { isPortalRepo: true, sandbox: 'docker' });
  assert.equal(f.issue?.kind, 'typecheck_failed'); assert.equal(f.issue?.cause, 'code'); assert.equal(stage(f, 'verify').status, 'failed');
  assert.deepEqual(f.issue!.files, ['src/a.ts', 'apps/web/src/screens/Backlog.tsx']); assert.equal(f.issue!.details[0].code, 'TS2322');
  assert.deepEqual(f.issue!.responsible, ['Desarrollador Full Stack']);
  assert.equal(f.actions[0].id, 'request_fix'); assert.ok(f.actions[0].primary);
  assert.deepEqual(f.actions.map(a => a.id), ['request_fix', 'ask_team', 'tasks_from_issue', 'retry_verification', 'reject']);
  assert.equal(stage(f, 'integrate').status, 'pending', 'integrar no está disponible');
  const t = buildStoryFlow(base({}, { applied, verifications: [run('typecheck', 0, 4), run('test', 1, 5, TAP_OUT)] }), { isPortalRepo: true });
  assert.equal(t.issue?.kind, 'test_failed'); assert.match(t.issue!.details[0].text, /el contador suma/);
  const b = buildStoryFlow(base({}, { applied, verifications: [run('typecheck', 0, 4), run('test', 0, 5), run('build', 1, 6, 'error during build:\nCould not resolve "./x"')] }), { isPortalRepo: true });
  assert.equal(b.issue?.kind, 'build_failed');
});

test('recorrido C · QA no aprueba: nunca «hecho» en verde; observaciones por gravedad y acciones de corrección', () => {
  const review = { approve: false, summary: 'Hay problemas.', suggestedTests: [], issues: ['[baja] Renombrar variable', '[alta] El contador no se reinicia en src/a.ts', 'Falta un caso de prueba'] };
  const f = buildStoryFlow(base({}, { review }), { isPortalRepo: true });
  assert.equal(stage(f, 'review').status, 'warning'); assert.equal(f.current, 'review', 'la decisión sigue en la revisión');
  assert.equal(f.issue?.kind, 'qa_rejected'); assert.equal(f.issue?.level, 'warning');
  assert.deepEqual(f.issue!.details.map(d => d.severity), ['alta', 'media', 'baja']); assert.equal(f.issue!.details[0].file, 'src/a.ts');
  assert.deepEqual(f.actions.map(a => a.id), ['request_fix', 'ask_team', 'tasks_from_issue', 'apply', 'reject']);
  assert.ok(f.actions.find(a => a.id === 'ask_team')!.requires.includes('ai_budget'));
  const g = buildStoryFlow(base({}, { review, applied }), { isPortalRepo: true });
  assert.equal(stage(g, 'review').status, 'warning', 'aplicado con observaciones: advertencia, no éxito');
  assert.match(stage(g, 'review').detail, /QA no aprueba · 3 observaciones \(1 altas\) · se aplicó igualmente/);
});

test('recorrido: autorización, ejecución, presupuesto, conflicto, activación, comprobación en ejecución, prueba manual, sin sandbox', () => {
  const pend = buildStoryFlow(base({ status: 'pending_authorization', result: null }), {});
  assert.equal(stage(pend, 'execute').status, 'waiting'); assert.equal(pend.actions[0].id, 'authorize');
  const runp = buildStoryFlow(base({ status: 'running', steps: [step('planner', 'Coordinador del Proyecto'), step('implementer', 'Desarrollador Full Stack', 'running'), step('reviewer', 'Especialista QA', 'pending')] }), {});
  assert.equal(stage(runp, 'execute').status, 'running'); assert.match(stage(runp, 'execute').detail, /Desarrollador Full Stack implementa: implementer · paso 2 de 3/); assert.equal(runp.responsible[0].agentName, 'Desarrollador Full Stack');
  const budget = buildStoryFlow(base({ status: 'budget_exceeded', spentUsd: 1, result: null }), {});
  assert.equal(budget.issue?.kind, 'budget_exceeded'); assert.deepEqual(budget.actions.map(a => a.id), ['recover', 'retry_process']);
  const unavailable = buildStoryFlow(base({}, { applied }), { isPortalRepo: true, sandbox: 'unavailable' });
  assert.equal(unavailable.issue?.kind, 'sandbox_unavailable'); assert.equal(unavailable.actions[0].id, 'refresh_sandbox');
  const ok3 = [run('typecheck', 0, 4), run('test', 0, 5), run('build', 0, 6)];
  const conflict = buildStoryFlow(base({}, { applied, verifications: ok3, mergeError: { at: at(7), message: 'CONFLICT (content): Merge conflict in src/a.ts', files: ['src/a.ts'] } }), { isPortalRepo: true });
  assert.equal(conflict.issue?.kind, 'merge_conflict'); assert.equal(stage(conflict, 'integrate').status, 'failed'); assert.equal(conflict.actions[0].id, 'request_fix');
  const merged = { applied, verifications: ok3, merged: { into: 'main', commit: 'm1', mergedAt: at(8) } };
  const act = buildStoryFlow(base({}, { ...merged, activation: { active: false, reason: 'Falta reconstruir.', runningCommit: 'old', buildAt: null } }), { isPortalRepo: true, updateFailedLog: '✘ [ERROR] Expected ")" but found ";"\n    src/x.tsx:3:1:' });
  assert.equal(act.issue?.kind, 'activation_failed'); assert.equal(act.actions[0].id, 'rebuild');
  const rt = buildStoryFlow(base({}, { ...merged, activation: { active: true, reason: '', runningCommit: 'm1', buildAt: at(9) }, runtimeChecks: { checks: [], ranAt: at(10), results: [{ check: { kind: 'ui', path: '/backlog', selector: 'h1', expect: '/x/' }, status: 'fail', detail: 'no contiene', evidence: '/ev/1.png' }] } }), { isPortalRepo: true });
  assert.equal(rt.issue?.kind, 'runtime_failed'); assert.equal(rt.issue?.evidence, '/ev/1.png');
  const manual = buildStoryFlow(base({}, { ...merged, manualTest: { steps: ['a', 'b'], checks: [true, false], note: null } }), { failedSteps: [{ index: 1, text: 'b', comment: 'no va' }] });
  assert.equal(manual.issue?.kind, 'manual_failed'); assert.equal(manual.actions[0].label, 'Enviar feedback al equipo (nueva iteración)');
  const ready = buildStoryFlow(base({}, { ...merged, manualTest: { steps: ['a'], checks: [true], note: null } }), {});
  assert.equal(ready.current, 'close'); assert.equal(ready.actions[0].id, 'close'); assert.equal(ready.issue, null);
  assert.equal(ready.progress.done, ready.progress.total - 1);
});

// ---------- API: escenarios A, B, C y F con el proveedor simulado ----------
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const internal = projectsRepo('portal-ia').list()[0];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-flow-repo-'));
fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: dir });
projectsRepo('portal-ia').setRepository(internal.id, dir, 'main');
const IMPL = '=== RESUMEN ===\nCambia a.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a: number = "2";\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nNada.\n=== PRUEBA MANUAL ===\n1. Abre X. Esperado: Y.\n=== VERIFICAR: typecheck ===';
const qaRule = (approve: boolean) => ({ match: 'Revisa los cambios propuestos', text: JSON.stringify({ approve, summary: approve ? 'Bien' : 'No cumple el criterio.', issues: approve ? [] : ['[alta] El valor es un string en src/a.ts', '[baja] Nombre poco claro'], suggestedTests: [] }) });
const setScript = (approve: boolean) => fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: 'plan técnico', text: '{"summary":"x","tasks":["t"],"filesToRead":["src/a.ts"],"filesToChange":["src/a.ts"],"acceptance":["a"],"risks":[]}' }, { match: 'Implementa la historia', text: IMPL }, qaRule(approve)] }));
const app = await buildApp();
const W = '/api/workspaces/portal-ia';
async function executed(title: string, approve = true) {
  setScript(approve);
  const it = addManualItem('portal-ia', internal.id, { title, criterion: 'a vale 2 (número)' });
  const p = createStoryProcess('portal-ia', internal.id, it.id); processesRepo('portal-ia').authorize(p.id, 1);
  await runStory('portal-ia', p.id, () => undefined, () => false);
  return { it, p: processesRepo('portal-ia').get(p.id)! };
}
const inject = (procId: string, v: any) => { const p = processesRepo('portal-ia').get(procId)!; processesRepo('portal-ia').setResult(procId, { ...p.result!, verifications: [...p.result!.verifications, v] }); };
const flowOf = async (procId: string) => (await app.inject({ method: 'GET', url: `${W}/processes/${procId}` })).json().guidance.flow;

test('API · escenario A: código 86 → «faltan dependencias»; instalar exige autorización y red; conserva el historial', async () => {
  const { p } = await executed('Escenario A');
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/apply`, payload: { authorized: true } })).statusCode, 200);
  inject(p.id, { ...run('typecheck', 86, 5, '[docker portal-ia-sandbox:1]\nFaltan las dependencias Linux de este package-lock (volumen portal-ia-nm-x).'), startedAt: new Date(Date.now() + 2000).toISOString() });
  const f = await flowOf(p.id);
  assert.equal(f.issue.kind, 'deps_missing'); assert.equal(f.actions[0].id, 'install_and_retry');
  const viaStory = (await app.inject({ method: 'GET', url: `${W}/stories/${p.backlogItemId}` })).json().lastProcess.guidance.flow;
  assert.equal(viaStory.issue.kind, 'deps_missing', 'misma fuente de verdad en el espacio de la historia');
  // Sin autorización o sin red: nada se ejecuta
  for (const payload of [{}, { authorized: true, commands: ['typecheck'] }, { allowNetwork: true, commands: ['typecheck'] }]) {
    const r = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/verify/install-and-retry`, payload });
    assert.equal(r.statusCode, 400); assert.equal(r.json().code, 'authorization_required');
  }
  assert.equal(processesRepo('portal-ia').get(p.id)!.result!.verifications.length, 1, 'sin autorización no se ejecutó nada');
  // Con autorización (aquí sin sandbox: install no se ejecuta, fail-closed) el intento queda en el historial
  const ok = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/verify/install-and-retry`, payload: { authorized: true, allowNetwork: true, commands: ['typecheck', 'test', 'build'] } });
  assert.equal(ok.statusCode, 200, ok.body);
  const vs = ok.json().result.verifications; assert.equal(vs.length, 2); assert.equal(vs[0].exitCode, 86); assert.equal(vs[1].command, 'install');
  assert.equal(vs[1].isolation, 'unavailable', 'sin sandbox no se instala en tu equipo');
  assert.equal(ok.json().guidance.flow.issue.kind, 'deps_missing', 'sigue bloqueado y lo explica');
});

test('API · escenario B: error de TypeScript → tareas e iteración correctiva con el error; integrar sigue bloqueado', async () => {
  const { it, p } = await executed('Escenario B');
  await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/apply`, payload: { authorized: true } });
  inject(p.id, { ...run('typecheck', 2, 5, 'src/a.ts(1,14): error TS2322: Type \'string\' is not assignable to type \'number\'.'), startedAt: new Date(Date.now() + 2000).toISOString() });
  const f = await flowOf(p.id);
  assert.equal(f.issue.kind, 'typecheck_failed'); assert.deepEqual(f.issue.files, ['src/a.ts']);
  const m = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/merge`, payload: { authorized: true } });
  assert.equal(m.statusCode, 409); assert.equal(m.json().code, 'verification_failed');
  const t = await app.inject({ method: 'POST', url: `${W}/stories/${it.id}/tasks/from-issue` });
  assert.equal(t.statusCode, 201, t.body); assert.match(t.json()[0].title, /^typecheck: src\/a\.ts:1 — TS2322 Type 'string'/); assert.equal(t.json()[0].assigneeName, 'Desarrollador Full Stack');
  assert.equal((await app.inject({ method: 'POST', url: `${W}/stories/${it.id}/tasks/from-issue` })).json().length, 0, 'no duplica');
  const itr = await app.inject({ method: 'POST', url: `${W}/stories/${it.id}/iterate`, payload: { discardApplied: true, note: 'arregla el tipo' } });
  assert.equal(itr.statusCode, 201, itr.body);
  const ctx = itr.json().context;
  assert.match(ctx, /Problema que motiva esta iteración/); assert.match(ctx, /comando\/comprobación: typecheck/); assert.match(ctx, /src\/a\.ts:1 TS2322 Type 'string' is not assignable/);
  assert.match(ctx, /Rama: portal-ia\/hu-\d+/); assert.match(ctx, /Criterio de aceptación vigente: a vale 2 \(número\)/); assert.match(ctx, /Tareas abiertas:\n- typecheck: src\/a\.ts:1/);
});

test('API · escenario C: QA no aprueba → advertencia en la revisión, preguntar exige autorización, la iteración recibe las observaciones', async () => {
  adapters.resetMockCalls();
  const { it, p } = await executed('Escenario C', false);
  const before = adapters.mockCalls;
  const f = await flowOf(p.id);
  assert.equal(f.current, 'review'); assert.equal(f.stages[1].status, 'warning'); assert.equal(f.issue.kind, 'qa_rejected');
  assert.deepEqual(f.issue.details.map((d: any) => d.severity), ['alta', 'baja']);
  const noAuth = await app.inject({ method: 'POST', url: `${W}/stories/${it.id}/messages`, payload: { text: '¿Por qué es alta la primera observación?', ask: true } });
  assert.equal(noAuth.statusCode, 403); assert.equal(adapters.mockCalls, before, 'sin autorización no hay llamada a la IA');
  const tasks = await app.inject({ method: 'POST', url: `${W}/stories/${it.id}/tasks/from-issue` });
  assert.equal(tasks.json().length, 2); assert.match(tasks.json()[0].title, /^QA \[alta\]: src\/a\.ts — /);
  const itr = await app.inject({ method: 'POST', url: `${W}/stories/${it.id}/iterate`, payload: {} });
  assert.equal(itr.statusCode, 201, itr.body); assert.match(itr.json().context, /\[alta\] src\/a\.ts El valor es un string/);
  assert.equal(adapters.mockCalls, before, 'crear tareas y la iteración no llama a la IA');
});

test('API · escenario F: las acciones de recuperación nunca gastan IA ni ejecutan nada protegido sin autorización', async () => {
  const { it, p } = await executed('Escenario F');
  adapters.resetMockCalls();
  const verifs = () => processesRepo('portal-ia').get(p.id)!.result!.verifications.length;
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/apply`, payload: {} })).statusCode, 400, 'aplicar exige autorización');
  await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/apply`, payload: { authorized: true } });
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/verify`, payload: { command: 'test' } })).statusCode, 400, 'verificar exige autorización');
  const net = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/verify`, payload: { authorized: true, command: 'install' } });
  assert.equal(net.statusCode, 409); assert.equal(net.json().code, 'network_confirmation_required');
  assert.equal(verifs(), 0, 'nada se ejecutó');
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/merge`, payload: {} })).statusCode, 400, 'integrar exige autorización');
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/runtime-check`, payload: {} })).statusCode, 400, 'comprobar exige autorización');
  // Una iteración correctiva o un reintento quedan pendientes de autorización (0 USD gastados, 0 llamadas)
  const itr = await app.inject({ method: 'POST', url: `${W}/stories/${it.id}/iterate`, payload: { discardApplied: true } });
  assert.equal(itr.json().process.status, 'pending_authorization'); assert.equal(itr.json().process.spentUsd, 0);
  const f = await flowOf(itr.json().process.id);
  assert.equal(f.actions[0].id, 'authorize'); assert.deepEqual(f.actions[0].requires.sort(), ['ai_budget', 'authorization']);
  const au = await app.inject({ method: 'POST', url: `${W}/processes/${itr.json().process.id}/authorize`, payload: { budgetUsd: 1 } });
  assert.equal(au.statusCode, 400, 'autorizar exige la casilla explícita');
  assert.equal(adapters.mockCalls, 0, 'ninguna llamada a la IA en todo el escenario');
});

test.after(async () => { await app.close(); });

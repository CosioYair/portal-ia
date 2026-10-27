import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** M6 · Espacio unificado de la historia: contexto, chat autorizado, tareas, iteraciones con contexto, cierre. Proveedor simulado. */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-m6-'));
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
const adapters = await import('@portal-ia/ai-adapters');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const internal = projectsRepo('portal-ia').list()[0];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-m6-repo-'));
fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n'); fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: dir });
projectsRepo('portal-ia').setRepository(internal.id, dir, 'main');
const PLAN = '{"summary":"Cambiar a","tasks":["Editar src/a.ts"],"filesToRead":["src/a.ts"],"filesToChange":["src/a.ts"],"acceptance":["a = 2"],"risks":[]}';
const IMPL = '=== RESUMEN ===\nCambia a.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nNada visible.\n=== PRUEBA MANUAL ===\n1. Abre X. Esperado: Y.\n2. Pulsa Z. Esperado: W.\n=== VERIFICAR: typecheck ===';
const QA = '{"approve": true, "summary": "Bien", "issues": [], "suggestedTests": []}';
fs.writeFileSync(scriptPath, JSON.stringify({ markers: ['Contexto de iteración', 'paso 2 FAIL', 'Paso 2 (fail)', 'Nota del propietario: arregla W'], rules: [
  { match: 'plan técnico', text: PLAN }, { match: 'Implementa la historia', text: IMPL }, { match: 'Revisa los cambios propuestos', text: QA },
  { match: 'Conversas con el propietario', text: 'El paso 2 falla porque W no se renderiza. Propongo corregirlo.\n```proposals\n{"tasks":[{"title":"Renderizar W tras pulsar Z","assignee":"Desarrollador Full Stack"}],"criterion":null,"iterate":true,"iterationNote":"arregla W"}\n```' }
] }));

test('M6 · contexto, prueba unificada (feedback ↔ marcas), chat autorizado con propuestas, tareas desde fallos, iteración con contexto, cierre', async () => {
  const app = await buildApp();
  const it = addManualItem('portal-ia', internal.id, { title: 'Cambiar a', criterion: 'a = 2' });
  const url = (p: string) => `/api/workspaces/portal-ia/stories/${it.id}${p}`;
  // Contexto sin ejecutar
  let c = (await app.inject({ method: 'GET', url: url('') })).json();
  assert.equal(c.iterations, 0); assert.equal(c.lastProcess, null); assert.deepEqual(c.team, []);
  // Iteración 1
  const p1 = createStoryProcess('portal-ia', internal.id, it.id); processesRepo('portal-ia').authorize(p1.id, 1);
  await runStory('portal-ia', p1.id, () => undefined, () => false);
  c = (await app.inject({ method: 'GET', url: url('') })).json();
  assert.equal(c.iterations, 1); assert.equal(c.lastProcess.id, p1.id); assert.equal(c.team.length, 3); assert.equal(c.manualTest.steps.length, 2); assert.equal(c.feedback.steps.length, 2);
  assert.match(c.lastProcess.guidance.phase, /Diff listo/);
  // Feedback por paso (endpoint existente) → se refleja en el contexto; marca «ok» en el proceso vía manual-test
  const k2 = manualTestStepKey(1, c.manualTest.steps[1]);
  const fb = await app.inject({ method: 'PUT', url: `/api/workspaces/portal-ia/processes/${p1.id}/manual-test-feedback/${encodeURIComponent(k2)}`, payload: { result: 'fail', comment: 'W no aparece' } });
  assert.equal(fb.statusCode, 200, fb.body);
  c = (await app.inject({ method: 'GET', url: url('') })).json();
  assert.equal(c.feedback.items.length, 1); assert.equal(c.feedback.items[0].result, 'fail');
  // Nota sin IA (gratis) y pregunta con IA (autorizada): propuestas de tareas e iteración
  adapters.resetMockCalls();
  const note = await app.inject({ method: 'POST', url: url('/messages'), payload: { text: 'Nota: probar en móvil también' } });
  assert.equal(note.statusCode, 201); assert.equal(note.json().reply, null); assert.equal(adapters.mockCalls, 0);
  const noAuth = await app.inject({ method: 'POST', url: url('/messages'), payload: { text: '¿Por qué falla el paso 2?', ask: true } });
  assert.equal(noAuth.statusCode, 403); assert.equal(adapters.mockCalls, 0);
  const est = await app.inject({ method: 'GET', url: url('/ask/estimate') }); assert.equal(est.json().agentName, 'Coordinador del Proyecto');
  const ask = await app.inject({ method: 'POST', url: url('/messages'), payload: { text: '¿Por qué falla el paso 2?', ask: true, authorized: true, maxUsd: 1 } });
  assert.equal(ask.statusCode, 201, ask.body); assert.equal(adapters.mockCalls, 1);
  const reply = ask.json().reply; assert.equal(reply.role, 'agent'); assert.equal(reply.agentName, 'Coordinador del Proyecto'); assert.ok(reply.costUsd > 0); assert.equal(reply.proposals.tasks.length, 1); assert.equal(reply.proposals.iterate, true);
  assert.match(reply.content, /paso 2 falla/); assert.ok(!/```proposals/.test(reply.content));
  // El agente recibió el feedback del propietario en su contexto
  const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l)); assert.ok(log.at(-1).markers.includes('paso 2 FAIL'));
  // Preguntar a un agente concreto del equipo
  const devId = c.team.find((m: any) => m.role === 'implementer').agentId;
  const ask2 = await app.inject({ method: 'POST', url: url('/messages'), payload: { text: 'Dev, ¿qué cambiarías?', ask: true, authorized: true, maxUsd: 1, agentId: devId } });
  assert.equal(ask2.json().reply.agentName, 'Desarrollador Full Stack');
  // Aplicar propuestas: tareas
  const ap = await app.inject({ method: 'POST', url: url(`/messages/${reply.id}/apply`), payload: { tasks: true } });
  assert.equal(ap.statusCode, 200, ap.body); assert.equal(ap.json().tasks.length, 1); assert.equal(ap.json().tasks[0].assigneeName, 'Desarrollador Full Stack'); assert.equal(ap.json().tasks[0].source, 'agent');
  assert.equal(ap.json().messages.find((m: any) => m.id === reply.id).proposals.applied, true);
  // Tareas desde los pasos con falla + manual + marcar hecha + borrar
  const tf = await app.inject({ method: 'POST', url: url('/tasks/from-feedback') }); assert.equal(tf.json().length, 1); assert.match(tf.json()[0].title, /Paso 2 falla/);
  assert.equal((await app.inject({ method: 'POST', url: url('/tasks/from-feedback') })).json().length, 0, 'no duplica');
  const t3 = await app.inject({ method: 'POST', url: url('/tasks'), payload: { title: 'Probar en móvil' } }); assert.equal(t3.statusCode, 201);
  const done = await app.inject({ method: 'PATCH', url: url(`/tasks/${t3.json().id}`), payload: { status: 'done' } }); assert.equal(done.json().status, 'done');
  await app.inject({ method: 'DELETE', url: url(`/tasks/${t3.json().id}`) });
  c = (await app.inject({ method: 'GET', url: url('') })).json(); assert.equal(c.tasks.length, 2);
  // Iteración 2 con contexto: el diff anterior (no aplicado) queda rechazado, la historia vuelve a pendiente, el proceso espera autorización
  const itr = await app.inject({ method: 'POST', url: url('/iterate'), payload: { note: 'arregla W' } });
  assert.equal(itr.statusCode, 201, itr.body); const p2 = itr.json().process; assert.equal(p2.status, 'pending_authorization');
  assert.match(itr.json().context, /Paso 2 \(fail\)/); assert.match(itr.json().context, /Tareas abiertas/); assert.match(itr.json().context, /Nota del propietario: arregla W/);
  assert.equal(processesRepo('portal-ia').get(p1.id)!.result!.rejected?.reason, 'superado por una nueva iteración');
  assert.equal(backlogRepo('portal-ia').get(it.id)!.status, 'pending');
  assert.equal((await app.inject({ method: 'POST', url: url('/iterate'), payload: {} })).statusCode, 409, 'no dos iteraciones a la vez');
  // Autorizar y ejecutar: el equipo recibe el contexto de iteración (plan e implementación)
  fs.writeFileSync(logPath, '');
  await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/processes/${p2.id}/authorize`, payload: { budgetUsd: 1, authorized: true } });
  // El servidor ejecuta en segundo plano: esperamos a que termine
  for (let i = 0; i < 100; i++) { const p = processesRepo('portal-ia').get(p2.id)!; if (p.status !== 'running' && p.status !== 'pending_authorization') break; await new Promise(r => setTimeout(r, 100)); }
  const p2done = processesRepo('portal-ia').get(p2.id)!; assert.equal(p2done.status, 'done', p2done.error ?? '');
  const log2 = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log2.find(l => l.rule === 'plan técnico').markers.includes('Contexto de iteración')); assert.ok(log2.find(l => l.rule === 'Implementa la historia').markers.includes('Nota del propietario: arregla W'));
  c = (await app.inject({ method: 'GET', url: url('') })).json(); assert.equal(c.iterations, 2); assert.equal(c.lastProcess.id, p2.id); assert.ok(c.messages.some((m: any) => m.role === 'system' && /Iteración 2/.test(m.content)));
  await app.close();
});

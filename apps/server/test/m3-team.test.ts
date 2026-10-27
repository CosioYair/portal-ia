import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** M3 · Agentes especializados efectivos: composición por capacidades (sin IA), permisos en backend, participación real (proveedor simulado). */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-m3-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json');
const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { composeTeam } = await import('../src/services/teamComposer.ts');
const { createAgent } = await import('../src/services/agentFactory.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { estimateStory, createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');
const { createProject } = await import('../src/services/companies.ts');
const adapters = await import('@portal-ia/ai-adapters');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const internal = projectsRepo('portal-ia').list()[0];
const base = (name: string, role: string, specialization: string, responsibilities: string[], capabilities: any[], tools: Record<string, boolean>) => createAgent('portal-ia', {
  scope: 'project', projectId: internal.id, name, role, reportsTo: 'pj-coordinador', collaborates: [], evaluation: ['x'],
  config: { name, specialization, responsibilities, provider: 'anthropic', model: 'claude-sonnet-4-5', fallbacks: [], effort: 'low', tools, knowledge: { repo: true }, monthlyLimitUsd: 5, perTaskAuthUsd: 1, capabilities }
});
const a11y = base('Especialista en accesibilidad', 'Accesibilidad e inclusión', 'Revisa el contraste, la navegación por teclado y los lectores de pantalla.', ['Evaluar accesibilidad (WCAG) y contraste de colores.', 'Proponer mejoras de accesibilidad en pantallas y menús.'], ['consultar'], { read_repo: true });
const sec = base('Auditor de seguridad', 'Seguridad de credenciales', 'Audita el manejo de credenciales, cifrado y claves maestras.', ['Revisar rotación de claves y credenciales cifradas.', 'Detectar secretos expuestos.'], ['revisar_seguridad'], { read_repo: true });
const noTool = base('Implementador sin permisos', 'Desarrollo', 'Escribe código.', ['Implementar historias.'], ['implementar'], { read_repo: true });

test('A1 · composición por capacidades, determinista y sin IA: consultores por coincidencia, exclusiones con motivo, ámbito y anulación manual', () => {
  resetMockCalls();
  const agents = agentsRepo('portal-ia').list();
  const t1 = composeTeam(agents, internal.id, { title: 'Mejorar contraste del menú lateral (accesibilidad)', criterion: 'El menú cumple contraste AA' });
  const roles = (t: any) => Object.fromEntries(t.members.map((m: any) => [m.role === 'consultant' ? `consultant:${m.agentKey}` : m.role, m.agentKey]));
  const r1 = roles(t1);
  assert.equal(r1.planner, 'pj-coordinador'); assert.equal(r1.implementer, 'pj-dev'); assert.equal(r1.reviewer, 'pj-qa');
  assert.ok(t1.members.some(m => m.agentId === a11y.id && m.role === 'consultant'), 'el especialista en accesibilidad entra como consultor');
  assert.ok(!t1.members.some(m => m.agentId === sec.id), 'el auditor no entra');
  assert.match(t1.members.find(m => m.agentId === a11y.id)!.reason, /accesibilidad|contraste|menu/);
  assert.ok(t1.excluded.some(e => e.agentId === noTool.id && /write_repo/.test(e.reason)), 'implementador sin write_repo excluido con motivo');
  const t2 = composeTeam(agents, internal.id, { title: 'Rotación de la clave maestra de credenciales' });
  assert.ok(t2.members.some(m => m.agentId === sec.id), 'el auditor entra');
  assert.ok(!t2.members.some(m => m.agentId === a11y.id));
  const t3 = composeTeam(agents, internal.id, { title: 'Optimizar consulta SQL del backlog' });
  assert.deepEqual(t3.members.map(m => m.role).sort(), ['implementer', 'planner', 'reviewer'], 'solo los tres roles base');
  // Ámbito: agente de otro proyecto nunca entra, ni por anulación
  const other = createProject('portal-ia', 'Proyecto B', 'x', []);
  const bDev = agentsRepo('portal-ia').list().find(a => a.key === 'pj-dev' && a.projectId === other.id)!;
  const t4 = composeTeam(agentsRepo('portal-ia').list(), internal.id, { title: 'Mejorar contraste del menú lateral (accesibilidad)' }, { override: { add: [bDev.id], remove: [a11y.id], by: 'owner', at: 't' } });
  assert.ok(!t4.members.some(m => m.agentId === bDev.id), 'fuera de ámbito: nunca');
  assert.ok(!t4.members.some(m => m.agentId === a11y.id), 'quitado por el propietario');
  assert.ok(t4.excluded.some(e => e.agentId === a11y.id && /propietario/.test(e.reason)));
  const t5 = composeTeam(agentsRepo('portal-ia').list(), internal.id, { title: 'Optimizar consulta SQL del backlog' }, { override: { add: [sec.id], by: 'owner', at: 't' } });
  assert.ok(t5.members.some(m => m.agentId === sec.id && m.override && /propietario/.test(m.reason)));
  // No se puede quitar al implementador ni al planificador
  const t6 = composeTeam(agentsRepo('portal-ia').list(), internal.id, { title: 'x' }, { override: { remove: [t3.members.find(m => m.role === 'implementer')!.agentId], by: 'owner', at: 't' } });
  assert.ok(t6.members.some(m => m.role === 'implementer'));
  // Omitir QA: el revisor no reaparece como consultor aunque la historia hable de pruebas
  const t7 = composeTeam(agentsRepo('portal-ia').list(), internal.id, { title: 'Ampliar la prueba manual con más pasos' }, { skipQa: true });
  assert.ok(!t7.members.some(m => m.agentKey === 'pj-qa'), 'QA no entra como consultor si se omitió');
  assert.ok(t7.excluded.some(e => /omitida por el propietario/.test(e.reason)));
  assert.equal(adapters.mockCalls, 0, 'ninguna selección llama a la IA');
  assert.equal(t1.aiCalls, 0);
});

test('A2 · participación real con proveedor simulado: la consulta del especialista llega al prompt del implementador y queda trazada en process_steps con modelo y costo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-m3-repo-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src/menu.css'), '.menu { color: #777; }\n'); fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: dir });
  projectsRepo('portal-ia').setRepository(internal.id, dir, 'main');
  fs.writeFileSync(scriptPath, JSON.stringify({ markers: ['Aportaciones de especialistas', 'CONTRASTE-AAA'], rules: [
    { match: 'plan técnico', text: '{"summary":"Subir el contraste del menú","tasks":["Editar src/menu.css"],"filesToRead":["src/menu.css"],"filesToChange":["src/menu.css"],"acceptance":["contraste AA"],"risks":[]}' },
    { match: 'aporta recomendaciones concretas', text: '1. Usa #1A1B1E sobre fondo claro (CONTRASTE-AAA).\n2. Mantén foco visible.' },
    { match: 'Implementa la historia', text: '=== RESUMEN ===\nSe sube el contraste.\n=== ARCHIVO: src/menu.css | patch ===\n<<<< BUSCAR\n.menu { color: #777; }\n==== REEMPLAZAR\n.menu { color: #1A1B1E; }\n>>>> FIN\n=== FIN ARCHIVO ===\n=== VERIFICAR: typecheck ===\n=== PARA EL PROPIETARIO ===\nEl menú lateral se lee mejor.\n=== PRUEBA MANUAL ===\n1. Abre el Portal. Esperado: menú con texto oscuro.\n2. Navega. Esperado: foco visible.\n3. Compara. Esperado: contraste AA.\n=== COMPROBACIONES ===\n- http GET / | menu\n=== NOTAS ===\n-' },
    { match: 'Revisa los cambios propuestos', text: '{"approve": true, "summary": "Correcto", "issues": [], "suggestedTests": ["npm test"]}' }
  ] }));
  fs.writeFileSync(logPath, '');
  const it = addManualItem('portal-ia', internal.id, { title: 'Mejorar contraste del menú lateral (accesibilidad)', criterion: 'Contraste AA' });
  const est = estimateStory('portal-ia', internal.id, it.id);
  assert.equal(est.steps.length, 4, 'plan + consulta + implementación + revisión');
  assert.ok(est.team && est.team.members.some(m => m.agentId === a11y.id)); assert.ok(est.steps.every(s => s.role && s.reason));
  const proc = createStoryProcess('portal-ia', internal.id, it.id);
  assert.equal(proc.result?.team?.members.length, 4, 'el equipo queda registrado antes de ejecutar');
  processesRepo('portal-ia').authorize(proc.id, 1);
  resetMockCalls();
  await runStory('portal-ia', proc.id, () => undefined, () => false);
  const done = processesRepo('portal-ia').get(proc.id)!;
  assert.equal(done.status, 'done', done.error ?? '');
  assert.equal(adapters.mockCalls, 4);
  const consult = done.steps.find(s => s.role === 'consultant')!;
  assert.equal(consult.agentId, a11y.id); assert.equal(consult.status, 'done'); assert.equal(consult.model, 'claude-sonnet-4-5'); assert.ok(consult.costUsd > 0 && consult.inputTokens > 0);
  assert.equal(done.result!.consultations![0].agentName, 'Especialista en accesibilidad');
  // El prompt del implementador contenía la aportación (registro del proveedor simulado)
  const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const impl = log.find(l => l.rule === 'Implementa la historia');
  assert.ok(impl && impl.markers.includes('Aportaciones de especialistas') && impl.markers.includes('CONTRASTE-AAA'), `el implementador recibió la consulta: ${JSON.stringify(impl)}`);
  assert.equal(done.result!.changes.length, 1); assert.equal(done.result!.changes[0].error ?? null, null);
  assert.equal(done.result!.runtimeChecks?.checks.length, 1);
  // Métricas del especialista derivadas de process_steps (sin IA)
  const app = await buildApp();
  const st = await app.inject({ method: 'GET', url: `/api/workspaces/portal-ia/agents/${a11y.id}/stats` });
  assert.equal(st.json().steps, 1); assert.equal(st.json().done, 1); assert.equal(st.json().byRole.consultant, 1); assert.ok(st.json().costUsd > 0);
  // Procesos antiguos sin role siguen funcionando por posición (legacy)
  const { stepByRole } = await import('../src/services/storyExecution.ts');
  const legacy: any = { steps: [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }] };
  assert.equal(stepByRole(legacy, 'implementer')!.agentId, 'b'); assert.equal(stepByRole(legacy, 'consultant'), undefined);
  await app.close();
});

test('A3 · permisos en backend: aplicar con un implementador sin write_repo se deniega (403) y queda en execution_history', async () => {
  const { workspaceDb } = await import('../src/db/workspace.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-m3-repo2-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n'); execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: dir });
  projectsRepo('portal-ia').setRepository(internal.id, dir, 'main');
  const it = addManualItem('portal-ia', internal.id, { title: 'Forzado' });
  const procs = processesRepo('portal-ia');
  // Proceso forjado con el agente sin write_repo como implementador
  const proc = procs.create({ projectId: internal.id, kind: 'story_execution', title: 'x', estimatedUsd: 0, backlogItemId: it.id, steps: [{ agentId: noTool.id, agentName: noTool.config.name, title: 'Plan', model: 'm', role: 'planner' }, { agentId: noTool.id, agentName: noTool.config.name, title: 'Impl', model: 'm', role: 'implementer' }] });
  procs.authorize(proc.id, 1);
  procs.setResult(proc.id, { plan: null, implementationSummary: 'x', changes: [{ path: 'a.txt', action: 'create', content: 'a', diff: '+a', before: 0, after: 1 }], verifyCommands: [], review: null, applied: null, verifications: [] });
  procs.finish(proc.id, 'done');
  const app = await buildApp();
  const r = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/processes/${proc.id}/apply`, payload: { authorized: true } });
  assert.equal(r.statusCode, 403); assert.equal(r.json().code, 'tool_not_granted');
  assert.ok((workspaceDb('portal-ia').prepare(`SELECT 1 FROM execution_history WHERE kind = 'policy:write_worktree:denied:sin_herramienta_write_repo' AND agent_id = ?`).get(noTool.id)));
  assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false);
  await app.close();
});

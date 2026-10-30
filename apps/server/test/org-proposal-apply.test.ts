import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * HU-159 · iteración 3: aplicar y deshacer propuestas organizativas aceptadas (sin IA), con el proveedor simulado.
 * Preparación en el nivel superior (sin before) y siembra con las APIs reales: createCompany/createProject.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-orgapply-'));
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
const { agentsRepo, knowledgeRepo, processesRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { orgEvaluationsRepo } = await import('../src/db/orgEvaluationSchema.ts');
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { composeTeam, RETIRED_REASON } = await import('../src/services/teamComposer.ts');
const { buildApp } = await import('../src/app.ts');
const adapters = await import('@portal-ia/ai-adapters');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const company = createCompany('Empresa Delta Apply');
const SLUG = company.slug;
const project = createProject(SLUG, 'Producto Delta', 'Plataforma con historias de seguridad y calidad', ['Entregar con calidad']);

const proposals = [
  { action: 'add', target: 'agent', subject: 'Auditor de seguridad', rationale: 'El backlog tiene historias de credenciales sin revisor.', spec: { name: 'Auditor de Seguridad', role: 'Revisión de seguridad', specialization: 'Revisa credenciales y permisos.', capabilities: ['revisar_seguridad'], tools: ['read_repo', 'write_repo', 'hack_tool'], reportsTo: 'pj-coordinador', department: 'Calidad' } },
  { action: 'adjust', target: 'agent', subject: 'pj-ux', rationale: 'Apenas participa: modelo más económico.', spec: { model: 'claude-haiku-4-5', effort: 'low', tools: ['read_repo'] } },
  { action: 'retire', target: 'agent', subject: 'pj-qa', rationale: 'Sin actividad en los procesos recientes.' },
  { action: 'merge', target: 'agent', subject: 'pj-arquitecto + pj-ux', keep: 'pj-inexistente', rationale: 'Solapan revisiones.', spec: { responsibilities: ['Arquitectura y diseño'] } },
  { action: 'merge', target: 'agent', subject: 'pj-arquitecto + pj-ux', keep: 'pj-arquitecto', rationale: 'Solapan revisiones de diseño.', spec: { responsibilities: ['Arquitectura y diseño de producto'] } },
  { action: 'adjust', target: 'agent', subject: 'Agente Fantasma', rationale: 'No existe en la organización.', spec: { effort: 'low' } },
  { action: 'add', target: 'agent', subject: 'Redactor técnico', rationale: 'Falta documentación del producto.', spec: { name: 'Redactor Técnico', capabilities: ['documentar'], tools: ['read_repo'] } },
  { action: 'retire', target: 'agent', subject: 'ws-gestor', rationale: 'Prueba de agente protegido.' },
  { action: 'adjust', target: 'agent', subject: 'pj-arquitecto', rationale: 'Esfuerzo excesivo para el volumen actual.', spec: { effort: 'low' } }
];
const FENCE = '```';
/** Paso «Contexto y dirección» obligatorio: estas pruebas evalúan sin indicaciones. */
const NO_BRIEF = { brief: { skipped: true } };
const GESTOR_TEXT = `## Resumen\nOrganización con huecos de seguridad (RESUMEN-APPLY).\n\n${FENCE}org\n${JSON.stringify(proposals)}\n${FENCE}\n`;
fs.writeFileSync(scriptPath, JSON.stringify({ rules: [
  { match: 'Entrega en markdown', text: GESTOR_TEXT },
  { match: 'Tu análisis lo usará el Gestor', text: 'Análisis del Coordinador: el backlog es técnico.' }
] }));
fs.writeFileSync(logPath, '');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const countProcesses = () => (workspaceDb(SLUG).prepare(`SELECT COUNT(*) AS n FROM processes`).get() as any).n as number;
const auditRows = (kind?: string) => workspaceDb(SLUG).prepare(`SELECT agent_id, project_id, kind, cost_usd FROM execution_history WHERE kind ${kind ? '= ?' : "LIKE 'org_change:%'"}`).all(...(kind ? [kind] : [])) as any[];
const snapshot = () => JSON.stringify(agentsRepo(SLUG).list().map(a => ({ id: a.id, config: a.config, template: a.template, edited: a.configEdited })));
const byKey = (key: string) => agentsRepo(SLUG).byKey(key, project.id)!;
async function waitFinished(app: any, id: string): Promise<any> {
  for (let i = 0; i < 600; i++) {
    const ev = (await app.inject({ method: 'GET', url: `/api/workspaces/${SLUG}/org-evaluations/${id}` })).json();
    if (['done', 'failed', 'cancelled'].includes(ev.status)) return ev;
    await sleep(25);
  }
  throw new Error('La evaluación no terminó a tiempo');
}

const app = await buildApp();
const started = await app.inject({ method: 'POST', url: `/api/workspaces/${SLUG}/org-evaluations`, payload: { projectId: project.id, budgetUsd: 5, authorized: true, ...NO_BRIEF } });
assert.equal(started.statusCode, 202, started.body);
const EV = await waitFinished(app, started.json().id);
await app.close();
const url = (pid: string, undo = false) => `/api/workspaces/${SLUG}/org-evaluations/${EV.id}/proposals/${pid}${undo ? '/undo' : ''}`;
const accept = (a: any, pid: string) => a.inject({ method: 'POST', url: url(pid), payload: { decision: 'accepted', confirm: true } });
const undo = (a: any, pid: string) => a.inject({ method: 'POST', url: url(pid, true), payload: { confirm: true } });
const docBody = () => knowledgeRepo(SLUG).get(EV.knowledgeDocId)!.body;

test('a · la evaluación trae cada propuesta con su spec; herramientas fuera del catálogo descartadas con aviso', () => {
  assert.equal(EV.status, 'done', EV.error ?? '');
  assert.equal(EV.proposals.length, 9);
  const p1 = EV.proposals[0];
  assert.deepEqual(p1.spec.tools, ['read_repo', 'write_repo'], 'hack_tool no está en TOOLS');
  assert.ok(p1.specWarnings.some((w: string) => /hack_tool/.test(w)));
  assert.equal(EV.proposals[4].keep, 'pj-arquitecto');
  assert.ok(EV.proposals.every((p: any) => p.decision === 'pending'));
});

test('b · sin authorized=true o sin presupuesto → 403 y no se crea nada', async () => {
  const a = await buildApp();
  const procs = countProcesses(); const evs = orgEvaluationsRepo(SLUG).list().length;
  for (const payload of [{ projectId: project.id, budgetUsd: 5 }, { projectId: project.id, budgetUsd: 5, authorized: false }, { projectId: null, budgetUsd: 0, authorized: true }]) {
    const r = await a.inject({ method: 'POST', url: `/api/workspaces/${SLUG}/org-evaluations`, payload });
    assert.equal(r.statusCode, 403, JSON.stringify(payload)); assert.equal(r.json().code, 'authorization_required');
  }
  assert.equal(countProcesses(), procs); assert.equal(orgEvaluationsRepo(SLUG).list().length, evs);
  await a.close();
});

test('c · añadir: crea el agente con mínimo privilegio, audita, anota y deshacer lo elimina (0 llamadas a la IA)', async () => {
  adapters.resetMockCalls();
  const a = await buildApp();
  const coordBefore = byKey('pj-coordinador').template;
  const snapNoConfirm = snapshot();
  for (const payload of [{ decision: 'accepted' }, { decision: 'accepted', confirm: false }]) {
    const nc = await a.inject({ method: 'POST', url: url('p1'), payload });
    assert.equal(nc.statusCode, 400, JSON.stringify(payload)); assert.equal(nc.json().code, 'confirmation_required');
  }
  assert.equal(snapshot(), snapNoConfirm, 'sin confirmación no se aplica nada');
  assert.equal(orgEvaluationsRepo(SLUG).get(EV.id)!.proposals.find(p => p.id === 'p1')!.decision, 'pending');
  const r = await accept(a, 'p1');
  assert.equal(r.statusCode, 200, r.body);
  const app1 = r.json().proposal.application;
  assert.equal(r.json().proposal.decision, 'accepted'); assert.equal(app1.status, 'applied');
  const created = app1.changes.find((c: any) => c.op === 'create');
  const agent = agentsRepo(SLUG).get(created.agentId)!;
  assert.equal(agent.config.name, 'Auditor de Seguridad'); assert.equal(agent.scope, 'project'); assert.equal(agent.projectId, project.id);
  assert.deepEqual(agent.config.tools, { read_repo: true }, 'write_repo sin «implementar» y hack_tool se descartan');
  assert.deepEqual(agent.config.capabilities, ['revisar_seguridad']);
  assert.equal(agent.template.reportsTo, 'pj-coordinador'); assert.equal((agent.template as any).department, 'Calidad');
  assert.ok(byKey('pj-coordinador').template.supervises.includes(agent.key));
  assert.ok(auditRows('org_change:apply').some(x => x.agent_id === agent.id && x.project_id === project.id && x.cost_usd === 0));
  assert.match(docBody(), /p1 · Aceptada y aplicada automáticamente/);
  const again = await accept(a, 'p1');
  assert.equal(again.statusCode, 409); assert.equal(again.json().code, 'already_decided');
  const u = await undo(a, 'p1');
  assert.equal(u.statusCode, 200, u.body); assert.equal(u.json().proposal.application.status, 'reverted');
  assert.equal(agentsRepo(SLUG).get(agent.id), undefined, 'deshacer elimina el agente creado');
  assert.deepEqual(byKey('pj-coordinador').template, coordBefore);
  assert.ok(auditRows('org_change:undo').some(x => x.agent_id === agent.id));
  assert.match(docBody(), /p1 · Deshecha por el propietario/);
  assert.equal((await undo(a, 'p1')).json().code, 'not_applied');
  assert.equal((await a.inject({ method: 'POST', url: url('p1', true), payload: {} })).statusCode, 400, 'deshacer exige confirm');
  assert.equal(adapters.mockCalls, 0, 'aceptar y deshacer no llaman a la IA');
  await a.close();
});

test('d · ajustar: cambia modelo, esfuerzo y herramientas; deshacer restaura la configuración exacta', async () => {
  const a = await buildApp();
  const before = byKey('pj-ux');
  const r = await accept(a, 'p2');
  assert.equal(r.statusCode, 200, r.body);
  const ux = byKey('pj-ux');
  assert.equal(ux.config.model, 'claude-haiku-4-5'); assert.equal(ux.config.effort, 'low');
  assert.deepEqual(ux.config.tools, { read_repo: true }); assert.equal(ux.id, before.id);
  assert.equal((await undo(a, 'p2')).statusCode, 200);
  const restored = byKey('pj-ux');
  assert.deepEqual(restored.config, before.config); assert.deepEqual(restored.template, before.template);
  assert.equal(restored.configEdited, before.configEdited);
  await a.close();
});

test('e · retirar: marca retiredAt sin borrar, composeTeam lo excluye y deshacer lo reactiva', async () => {
  const a = await buildApp();
  const story = { title: 'Verificar la calidad del checkout' };
  assert.equal((await accept(a, 'p3')).statusCode, 200);
  const qa = byKey('pj-qa');
  assert.ok(qa, 'la fila se conserva'); assert.equal(typeof (qa.template as any).retiredAt, 'string'); assert.equal((qa.template as any).retiredBy, 'owner');
  const team = composeTeam(agentsRepo(SLUG).list(), project.id, story);
  assert.ok(!team.members.some(m => m.agentId === qa.id));
  assert.ok(team.excluded.some(e => e.agentId === qa.id && e.reason === RETIRED_REASON));
  const forced = composeTeam(agentsRepo(SLUG).list(), project.id, story, { override: { add: [qa.id], remove: [] } as any });
  assert.ok(!forced.members.some(m => m.agentId === qa.id), 'ni por anulación manual');
  assert.equal((await undo(a, 'p3')).statusCode, 200);
  assert.equal((byKey('pj-qa').template as any).retiredAt, undefined);
  const back = composeTeam(agentsRepo(SLUG).list(), project.id, story);
  assert.ok(back.members.some(m => m.agentKey === 'pj-qa' && m.role === 'reviewer'));
  await a.close();
});

test('f · fusionar: ajusta el que se conserva y retira el resto; deshacer restaura ambos', async () => {
  const a = await buildApp();
  const arq0 = byKey('pj-arquitecto'); const ux0 = byKey('pj-ux');
  const r = await accept(a, 'p5');
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(byKey('pj-arquitecto').config.responsibilities, ['Arquitectura y diseño de producto']);
  assert.equal(typeof (byKey('pj-ux').template as any).retiredAt, 'string');
  const changes = r.json().proposal.application.changes;
  assert.equal(changes.find((c: any) => c.agentId === arq0.id)?.op, 'update', 'el que se conserva se ajusta');
  assert.equal(changes.find((c: any) => c.agentId === ux0.id)?.op, 'retire', 'el resto se retira');
  assert.ok(changes.every((c: any) => c.agentId === ux0.id || c.op === 'update'), 'jefes y subordinados afectados solo se ajustan (jerarquía)');
  assert.equal((await undo(a, 'p5')).statusCode, 200);
  assert.deepEqual(byKey('pj-arquitecto').config, arq0.config);
  assert.deepEqual(byKey('pj-ux').template, ux0.template);
  await a.close();
});

test('g · sujeto inexistente, keep inválido o agente protegido → 422, propuesta pendiente y sin cambios parciales', async () => {
  const a = await buildApp();
  const snap = snapshot(); const audits = auditRows().length;
  for (const [pid, code] of [['p4', 'invalid_subject'], ['p6', 'invalid_subject'], ['p8', 'protected_agent']] as const) {
    const r = await accept(a, pid);
    assert.equal(r.statusCode, 422, `${pid}: ${r.body}`); assert.equal(r.json().code, code);
  }
  assert.equal(snapshot(), snap, 'ningún agente cambió'); assert.equal(auditRows().length, audits, 'sin auditoría');
  const ev = orgEvaluationsRepo(SLUG).get(EV.id)!;
  for (const pid of ['p4', 'p6', 'p8']) assert.equal(ev.proposals.find(p => p.id === pid)!.decision, 'pending');
  await a.close();
});

test('h · rechazar exige confirmación y solo registra la decisión: ningún agente cambia y una fila org_change:reject con coste 0', async () => {
  const a = await buildApp();
  const snap = snapshot(); const audits = auditRows().length;
  const nc = await a.inject({ method: 'POST', url: url('p7'), payload: { decision: 'rejected' } });
  assert.equal(nc.statusCode, 400, nc.body); assert.equal(nc.json().code, 'confirmation_required');
  assert.equal(orgEvaluationsRepo(SLUG).get(EV.id)!.proposals.find(p => p.id === 'p7')!.decision, 'pending', 'sin confirmación sigue pendiente');
  assert.equal(auditRows().length, audits, 'sin confirmación no hay registro');
  const r = await a.inject({ method: 'POST', url: url('p7'), payload: { decision: 'rejected', confirm: true } });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().proposal.decision, 'rejected');
  assert.equal(r.json().proposal.application, undefined);
  assert.equal(snapshot(), snap, 'ningún agente cambió');
  assert.equal(auditRows().length, audits + 1);
  const rejects = auditRows('org_change:reject');
  assert.equal(rejects.length, 1); assert.equal(rejects[0].cost_usd, 0);
  assert.ok(!agentsRepo(SLUG).list().some(x => x.config.name === 'Redactor Técnico'));
  assert.match(docBody(), /p7 · Rechazada/);
  await a.close();
});

test('i · deshacer tras una edición manual posterior → 409 stale_undo y se conserva la edición', async () => {
  const a = await buildApp();
  assert.equal((await accept(a, 'p9')).statusCode, 200);
  const arq = byKey('pj-arquitecto'); assert.equal(arq.config.effort, 'low');
  agentsRepo(SLUG).updateConfig(arq.id, { ...arq.config, specialization: 'Editado a mano por el propietario' });
  const u = await undo(a, 'p9');
  assert.equal(u.statusCode, 409); assert.equal(u.json().code, 'stale_undo');
  assert.equal(byKey('pj-arquitecto').config.specialization, 'Editado a mano por el propietario');
  assert.equal(orgEvaluationsRepo(SLUG).get(EV.id)!.proposals.find(p => p.id === 'p9')!.application!.status, 'applied');
  await a.close();
});

test('j · evaluación de empresa anclada al anchorProjectId enviado; ancla ajena → 422 sin crear nada', async () => {
  const anchor = createProject(SLUG, 'Proyecto Ancla');
  const a = await buildApp();
  const procs = countProcesses();
  const bad = await a.inject({ method: 'POST', url: `/api/workspaces/${SLUG}/org-evaluations`, payload: { projectId: null, anchorProjectId: 'no-existe', budgetUsd: 5, authorized: true, ...NO_BRIEF } });
  assert.equal(bad.statusCode, 422, bad.body); assert.equal(bad.json().code, 'invalid_anchor');
  assert.equal(countProcesses(), procs);
  const r = await a.inject({ method: 'POST', url: `/api/workspaces/${SLUG}/org-evaluations`, payload: { projectId: null, anchorProjectId: anchor.id, budgetUsd: 5, authorized: true, ...NO_BRIEF } });
  assert.equal(r.statusCode, 202, r.body);
  const ev = await waitFinished(a, r.json().id);
  assert.equal(ev.status, 'done', ev.error ?? ''); assert.equal(ev.scopeKind, 'workspace'); assert.equal(ev.projectId, null);
  assert.equal(ev.anchorProjectId, anchor.id, 'no el primer proyecto');
  assert.equal(processesRepo(SLUG).get(ev.processId)!.projectId, anchor.id);
  assert.equal(knowledgeRepo(SLUG).get(ev.knowledgeDocId)!.projectId, anchor.id);
  await a.close();
});

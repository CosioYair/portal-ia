import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * HU-159 · iteración 4: ciclo de vida de las propuestas (rechazar → reabrir → aceptar; deshacer → volver a aplicar),
 * subordinados de un agente retirado y jefe resuelto dentro del proyecto con dos pj-coordinador. Proveedor simulado,
 * preparación en el nivel superior (sin before) y siembra con las APIs reales (createCompany, createProject, createAgent).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-orglife-'));
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
const { agentsRepo, knowledgeRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { orgEvaluationsRepo } = await import('../src/db/orgEvaluationSchema.ts');
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { createAgent } = await import('../src/services/agentFactory.ts');
const { buildApp } = await import('../src/app.ts');
const adapters = await import('@portal-ia/ai-adapters');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const company = createCompany('Empresa Ciclo Org');
const SLUG = company.slug;
const projectA = createProject(SLUG, 'Proyecto A', 'Primer producto', ['Entregar A']);
const projectB = createProject(SLUG, 'Proyecto B', 'Segundo producto con diseño', ['Entregar B']);
const byKey = (key: string, pid: string = projectB.id) => agentsRepo(SLUG).byKey(key, pid)!;

// «Subordinado UX» en B, que reporta a pj-ux de B.
const uxSeed = byKey('pj-ux');
const SUB = createAgent(SLUG, {
  scope: 'project', projectId: projectB.id, name: 'Subordinado UX', role: 'Apoyo de diseño', reportsTo: 'pj-ux',
  collaborates: [], evaluation: [], config: { ...uxSeed.config, name: 'Subordinado UX', fallbacks: [] }
} as Parameters<typeof createAgent>[1]);
assert.equal(SUB.projectId, projectB.id);
assert.ok(byKey('pj-ux').template.supervises.includes(SUB.key), 'pj-ux de B supervisa al subordinado');

const proposals = [
  { action: 'add', target: 'agent', subject: 'Analista de métricas', rationale: 'Nadie mide el uso del producto B.', spec: { name: 'Analista de Métricas', capabilities: ['consultar'], tools: ['read_repo'], reportsTo: 'pj-coordinador' } },
  { action: 'retire', target: 'agent', subject: 'pj-ux', rationale: 'Sin actividad de diseño en los procesos recientes.' },
  { action: 'adjust', target: 'agent', subject: 'pj-arquitecto', rationale: 'Esfuerzo excesivo para el volumen actual.', spec: { effort: 'low' } },
  { action: 'add', target: 'agent', subject: 'Redactor técnico', rationale: 'Falta documentación del producto B.', spec: { name: 'Redactor Técnico', capabilities: ['consultar'], tools: ['read_repo'] } },
  { action: 'adjust', target: 'agent', subject: 'pj-qa', rationale: 'Carga baja de verificación.', spec: { effort: 'low' } }
];
const FENCE = '```';
/** Paso «Contexto y dirección» obligatorio: estas pruebas evalúan sin indicaciones. */
const NO_BRIEF = { brief: { skipped: true } };
const GESTOR_TEXT = `## Resumen\nOrganización de B revisada (RESUMEN-CICLO).\n\n${FENCE}org\n${JSON.stringify(proposals)}\n${FENCE}\n`;
fs.writeFileSync(scriptPath, JSON.stringify({ rules: [
  { match: 'Entrega en markdown', text: GESTOR_TEXT },
  { match: 'Tu análisis lo usará el Gestor', text: 'Análisis del Coordinador de B.' }
] }));
fs.writeFileSync(logPath, '');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const auditRows = (kind?: string) => workspaceDb(SLUG).prepare(`SELECT agent_id, project_id, kind, cost_usd FROM execution_history WHERE kind ${kind ? '= ?' : "LIKE 'org_change:%'"}`).all(...(kind ? [kind] : [])) as any[];
const snapshot = () => JSON.stringify(agentsRepo(SLUG).list().map(a => ({ id: a.id, config: a.config, template: a.template, edited: a.configEdited })));
const state = (id: string) => { const a = agentsRepo(SLUG).get(id)!; return { config: a.config, template: a.template, configEdited: a.configEdited }; };
async function waitFinished(app: any, id: string): Promise<any> {
  for (let i = 0; i < 600; i++) {
    const ev = (await app.inject({ method: 'GET', url: `/api/workspaces/${SLUG}/org-evaluations/${id}` })).json();
    if (['done', 'failed', 'cancelled'].includes(ev.status)) return ev;
    await sleep(25);
  }
  throw new Error('La evaluación no terminó a tiempo');
}

const app0 = await buildApp();
const started = await app0.inject({ method: 'POST', url: `/api/workspaces/${SLUG}/org-evaluations`, payload: { projectId: projectB.id, budgetUsd: 5, authorized: true, ...NO_BRIEF } });
assert.equal(started.statusCode, 202, started.body);
const EV = await waitFinished(app0, started.json().id);
await app0.close();
assert.equal(EV.status, 'done', EV.error ?? '');
assert.equal(EV.proposals.length, 5);

const base = (pid: string) => `/api/workspaces/${SLUG}/org-evaluations/${EV.id}/proposals/${pid}`;
const accept = (a: any, pid: string) => a.inject({ method: 'POST', url: base(pid), payload: { decision: 'accepted', confirm: true } });
const reject = (a: any, pid: string, confirm = true) => a.inject({ method: 'POST', url: base(pid), payload: confirm ? { decision: 'rejected', confirm: true } : { decision: 'rejected' } });
const action = (a: any, pid: string, kind: 'undo' | 'reopen' | 'reapply', confirm = true) => a.inject({ method: 'POST', url: `${base(pid)}/${kind}`, payload: confirm ? { confirm: true } : {} });
const proposal = (pid: string) => orgEvaluationsRepo(SLUG).get(EV.id)!.proposals.find(p => p.id === pid)!;
const docBody = () => knowledgeRepo(SLUG).get(EV.knowledgeDocId)!.body;

test('a · jefe dentro del proyecto: el agente nuevo con reportsTo pj-coordinador queda bajo el coordinador de B; el de A no cambia', async () => {
  adapters.resetMockCalls();
  const a = await buildApp();
  const coordA0 = byKey('pj-coordinador', projectA.id); const coordB0 = byKey('pj-coordinador');
  assert.notEqual(coordA0.id, coordB0.id, 'dos coordinadores distintos');
  const r = await accept(a, 'p1');
  assert.equal(r.statusCode, 200, r.body);
  const created = r.json().proposal.application.changes.find((c: any) => c.op === 'create');
  const agent = agentsRepo(SLUG).get(created.agentId)!;
  assert.equal(agent.projectId, projectB.id); assert.equal(agent.template.reportsTo, 'pj-coordinador');
  assert.ok(byKey('pj-coordinador').template.supervises.includes(agent.key), 'el coordinador de B lo supervisa');
  assert.ok(!byKey('pj-coordinador', projectA.id).template.supervises.includes(agent.key), 'el coordinador de A no');
  assert.deepEqual(byKey('pj-coordinador', projectA.id).template, coordA0.template);
  assert.equal((await action(a, 'p1', 'undo')).statusCode, 200);
  assert.equal(agentsRepo(SLUG).get(agent.id), undefined);
  assert.deepEqual(byKey('pj-coordinador').template, coordB0.template, 'deshacer restaura al coordinador de B');
  assert.deepEqual(byKey('pj-coordinador', projectA.id).template, coordA0.template);
  assert.equal(adapters.mockCalls, 0);
  await a.close();
});

test('b · subordinados de un retirado: pasan al jefe del retirado en B; deshacer restaura las tres fotos exactas', async () => {
  adapters.resetMockCalls();
  const a = await buildApp();
  const ux0 = byKey('pj-ux'); const coordB0 = byKey('pj-coordinador'); const coordA0 = byKey('pj-coordinador', projectA.id);
  const before = { ux: state(ux0.id), coord: state(coordB0.id), sub: state(SUB.id) };
  const r = await accept(a, 'p2');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(agentsRepo(SLUG).get(SUB.id)!.template.reportsTo, 'pj-coordinador', 'el subordinado pasa al jefe de pj-ux');
  const coordB = byKey('pj-coordinador');
  assert.ok(coordB.template.supervises.includes(SUB.key), 'el coordinador de B lo supervisa');
  assert.ok(!coordB.template.supervises.includes('pj-ux'), 'el retirado sale de supervises de su jefe');
  assert.deepEqual(byKey('pj-coordinador', projectA.id).template, coordA0.template, 'el coordinador de A no cambia');
  const ux = agentsRepo(SLUG).get(ux0.id)!;
  assert.equal(typeof (ux.template as any).retiredAt, 'string');
  assert.ok(!ux.template.supervises.includes(SUB.key), 'el retirado deja de supervisarlo');
  const appl = r.json().proposal.application;
  assert.ok((appl.warnings ?? []).some((w: string) => /Subordinado UX pasa a reportar/.test(w)), JSON.stringify(appl.warnings));
  assert.deepEqual(new Set(appl.changes.map((c: any) => c.agentId)), new Set([ux0.id, coordB0.id, SUB.id]));
  assert.equal((await action(a, 'p2', 'undo')).statusCode, 200);
  assert.deepEqual(state(ux0.id), before.ux); assert.deepEqual(state(coordB0.id), before.coord); assert.deepEqual(state(SUB.id), before.sub);
  assert.deepEqual(byKey('pj-coordinador', projectA.id).template, coordA0.template);
  assert.equal(adapters.mockCalls, 0);
  await a.close();
});

test('c · rechazar exige confirmación; reabrir la devuelve a pendiente y después se acepta y aplica', async () => {
  adapters.resetMockCalls();
  const a = await buildApp();
  const snap = snapshot();
  const nc = await reject(a, 'p3', false);
  assert.equal(nc.statusCode, 400, nc.body); assert.equal(nc.json().code, 'confirmation_required');
  assert.equal(proposal('p3').decision, 'pending');
  const rejectsBefore = auditRows('org_change:reject').length;
  const r = await reject(a, 'p3');
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().proposal.decision, 'rejected');
  assert.equal(snapshot(), snap, 'rechazar no cambia agentes');
  const rejects = auditRows('org_change:reject');
  assert.equal(rejects.length, rejectsBefore + 1); assert.ok(rejects.every(x => x.cost_usd === 0));
  assert.match(docBody(), /p3 · Rechazada/);
  const ro = await action(a, 'p3', 'reopen', false);
  assert.equal(ro.statusCode, 400); assert.equal(ro.json().code, 'confirmation_required');
  assert.equal(proposal('p3').decision, 'rejected');
  const reopened = await action(a, 'p3', 'reopen');
  assert.equal(reopened.statusCode, 200, reopened.body);
  const p3 = reopened.json().proposal;
  assert.equal(p3.decision, 'pending'); assert.equal(typeof p3.reopenedAt, 'string'); assert.equal(p3.decidedAt, null);
  const reopens = auditRows('org_change:reopen');
  assert.equal(reopens.length, 1); assert.equal(reopens[0].cost_usd, 0);
  assert.match(docBody(), /p3 · Reabierta/);
  assert.equal(snapshot(), snap, 'reabrir no cambia agentes');
  const acc = await accept(a, 'p3');
  assert.equal(acc.statusCode, 200, acc.body); assert.equal(acc.json().proposal.application.status, 'applied');
  assert.equal(byKey('pj-arquitecto').config.effort, 'low');
  const again = await action(a, 'p3', 'reopen');
  assert.equal(again.statusCode, 409); assert.equal(again.json().code, 'not_rejected');
  const pend = await action(a, 'p5', 'reopen');
  assert.equal(pend.statusCode, 409); assert.equal(pend.json().code, 'not_rejected');
  assert.equal(adapters.mockCalls, 0);
  await a.close();
});

test('d · volver a aplicar una propuesta deshecha: fotos nuevas, registro y se puede deshacer otra vez', async () => {
  adapters.resetMockCalls();
  const a = await buildApp();
  const r = await accept(a, 'p4');
  assert.equal(r.statusCode, 200, r.body);
  const firstId = r.json().proposal.application.changes.find((c: any) => c.op === 'create').agentId;
  const applied = await action(a, 'p4', 'reapply');
  assert.equal(applied.statusCode, 409); assert.equal(applied.json().code, 'not_reverted');
  const pending = await action(a, 'p5', 'reapply');
  assert.equal(pending.statusCode, 409); assert.equal(pending.json().code, 'not_reverted');
  assert.equal((await action(a, 'p4', 'undo')).statusCode, 200);
  assert.equal(agentsRepo(SLUG).get(firstId), undefined);
  const nc = await action(a, 'p4', 'reapply', false);
  assert.equal(nc.statusCode, 400); assert.equal(nc.json().code, 'confirmation_required');
  assert.equal(proposal('p4').application!.status, 'reverted');
  const re = await action(a, 'p4', 'reapply');
  assert.equal(re.statusCode, 200, re.body);
  const app2 = re.json().proposal.application;
  assert.equal(app2.status, 'applied'); assert.equal(app2.reapplyCount, 1); assert.equal(typeof app2.reappliedAt, 'string'); assert.equal(app2.revertedAt, null);
  const created = app2.changes.find((c: any) => c.op === 'create');
  assert.notEqual(created.agentId, firstId, 'es un agente nuevo');
  const agent = agentsRepo(SLUG).get(created.agentId)!;
  assert.equal(agent.config.name, 'Redactor Técnico'); assert.equal(agent.projectId, projectB.id);
  assert.ok(byKey('pj-coordinador').template.supervises.includes(agent.key));
  const rows = auditRows('org_change:reapply');
  assert.ok(rows.length >= 1 && rows.every(x => x.cost_usd === 0));
  assert.ok(rows.some(x => x.agent_id === agent.id));
  assert.match(docBody(), /p4 · Vuelta a aplicar/);
  const u2 = await action(a, 'p4', 'undo');
  assert.equal(u2.statusCode, 200, u2.body); assert.equal(u2.json().proposal.application.status, 'reverted');
  assert.equal(agentsRepo(SLUG).get(agent.id), undefined, 'se puede deshacer otra vez');
  assert.equal(adapters.mockCalls, 0);
  await a.close();
});

test('e · volver a aplicar con el sujeto ya no válido → 422 sin cambios parciales; la propuesta sigue revertida', async () => {
  adapters.resetMockCalls();
  const a = await buildApp();
  assert.equal(proposal('p2').application!.status, 'reverted', 'p2 quedó deshecha en la prueba b');
  const ux = byKey('pj-ux');
  agentsRepo(SLUG).updateTemplateMeta(ux.id, { ...ux.template, retiredAt: new Date().toISOString(), retiredBy: 'owner' } as typeof ux.template);
  const snap = snapshot(); const audits = auditRows().length;
  const r = await action(a, 'p2', 'reapply');
  assert.equal(r.statusCode, 422, r.body); assert.equal(r.json().code, 'invalid_subject');
  assert.equal(snapshot(), snap, 'ningún agente cambió');
  assert.equal(auditRows().length, audits, 'sin registro');
  const p2 = proposal('p2');
  assert.equal(p2.decision, 'accepted'); assert.equal(p2.application!.status, 'reverted');
  assert.equal(adapters.mockCalls, 0, 'ninguna acción del ciclo llama a la IA');
  await a.close();
});

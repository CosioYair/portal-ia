import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * HU-159 · Evaluación organizativa con proveedor simulado (0 USD reales). Preparación idéntica a m3-team.test.ts:
 * todo en el nivel superior, sin before que pueda fallar en silencio y cancelar pruebas.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-orgeval-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json');
const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, parseOrgProposals } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, knowledgeRepo, processesRepo, projectsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { ensureOrgEvaluationSchema, orgEvaluationsRepo } = await import('../src/db/orgEvaluationSchema.ts');
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { buildApp } = await import('../src/app.ts');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');
const adapters = await import('@portal-ia/ai-adapters');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const internal = projectsRepo('portal-ia').list()[0];

const proposalsJson = JSON.stringify([
  { action: 'add', target: 'agent', subject: 'Auditor de seguridad', rationale: 'El backlog incluye historias de credenciales sin revisor especializado.', details: 'Reporta a pj-coordinador' },
  { action: 'adjust', target: 'agent', subject: 'pj-ux', rationale: 'Apenas participa en los procesos recientes.', details: 'Modelo más económico' },
  { action: 'retire', target: 'department', subject: 'Marketing', rationale: '' }
]);
const GESTOR_TEXT = `## Resumen\nLa organización cubre el desarrollo, pero falta seguridad (RESUMEN-ORG).\n\n## Diagnóstico\nCarga concentrada en pj-dev.\n\n\`\`\`org\n${proposalsJson}\n\`\`\`\n`;
fs.writeFileSync(scriptPath, JSON.stringify({ markers: ['COORD-NOTA-ORG'], rules: [
  { match: 'Entrega en markdown', text: GESTOR_TEXT },
  { match: 'Tu análisis lo usará el Gestor', text: 'Análisis: COORD-NOTA-ORG el backlog es técnico y no hay revisión de seguridad.' }
] }));
fs.writeFileSync(logPath, '');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const countProcesses = (slug: string) => (workspaceDb(slug).prepare(`SELECT COUNT(*) AS n FROM processes`).get() as any).n as number;
async function waitFinished(app: any, slug: string, id: string): Promise<any> {
  for (let i = 0; i < 600; i++) {
    const ev = (await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/org-evaluations/${id}` })).json();
    if (['done', 'failed', 'cancelled'].includes(ev.status)) return ev;
    await sleep(25);
  }
  throw new Error('La evaluación no terminó a tiempo');
}
let projectEvalId = '';
/** Paso «Contexto y dirección» obligatorio: estas pruebas evalúan sin indicaciones. */
const NO_BRIEF = { brief: { skipped: true } };

test('a · parseOrgProposals: bloque válido, recortado y ausente; descarta entradas sin justificación', () => {
  const ok = parseOrgProposals(GESTOR_TEXT);
  assert.equal(ok.found, true); assert.equal(ok.truncated, false);
  assert.equal(ok.proposals.length, 2); assert.equal(ok.discarded, 1);
  assert.deepEqual(ok.proposals.map(p => [p.id, p.action, p.target, p.decision]), [['p1', 'add', 'agent', 'pending'], ['p2', 'adjust', 'agent', 'pending']]);
  assert.ok(!ok.body.includes('```org')); assert.match(ok.body, /RESUMEN-ORG/);
  const cut = parseOrgProposals('Texto\n```org\n[{"action":"merge","target":"agent","subject":["pj-ux","pj-arquitecto"],"rationale":"Solapan revisiones"},{"action":"add","target":"agent","subject":"X","rationale":"Falta');
  assert.equal(cut.found, true); assert.equal(cut.truncated, true);
  assert.equal(cut.proposals.length, 1); assert.equal(cut.proposals[0].subject, 'pj-ux + pj-arquitecto');
  const none = parseOrgProposals('## Resumen\nSin bloque.');
  assert.equal(none.found, false); assert.equal(none.proposals.length, 0);
});

test('b · estimación sin costo: la empresa solo con el Gestor; el proyecto añade el paso del Coordinador; 404 fuera de la empresa', async () => {
  resetMockCalls();
  const app = await buildApp();
  const ws = (await app.inject({ method: 'GET', url: '/api/workspaces/portal-ia/org-evaluations/estimate' })).json();
  assert.equal(ws.scopeKind, 'workspace'); assert.deepEqual(ws.steps.map((s: any) => s.title), ['Evaluación del Gestor']);
  assert.ok(ws.estimatedUsd > 0 && ws.suggestedBudgetUsd >= ws.estimatedUsd);
  const pj = (await app.inject({ method: 'GET', url: `/api/workspaces/portal-ia/org-evaluations/estimate?projectId=${internal.id}` })).json();
  assert.equal(pj.scopeKind, 'project'); assert.deepEqual(pj.steps.map((s: any) => s.title), ['Análisis del Coordinador', 'Evaluación del Gestor']);
  const missing = await app.inject({ method: 'GET', url: '/api/workspaces/portal-ia/org-evaluations/estimate?projectId=no-existe' });
  assert.equal(missing.statusCode, 404);
  assert.equal(adapters.mockCalls, 0, 'estimar no llama a la IA');
  await app.close();
});

test('c · sin autorización explícita o sin presupuesto → 403 y no se crea ningún proceso ni evaluación', async () => {
  resetMockCalls();
  const app = await buildApp();
  const before = countProcesses('portal-ia'); const evBefore = orgEvaluationsRepo('portal-ia').list().length;
  for (const payload of [{ projectId: internal.id, budgetUsd: 2 }, { projectId: internal.id, budgetUsd: 2, authorized: false }, { projectId: internal.id, budgetUsd: 0, authorized: true }, { projectId: null, authorized: true }]) {
    const r = await app.inject({ method: 'POST', url: '/api/workspaces/portal-ia/org-evaluations', payload });
    assert.equal(r.statusCode, 403, JSON.stringify(payload)); assert.equal(r.json().code, 'authorization_required');
  }
  assert.equal(countProcesses('portal-ia'), before); assert.equal(orgEvaluationsRepo('portal-ia').list().length, evBefore);
  assert.equal(adapters.mockCalls, 0);
  await app.close();
});

test('d · flujo completo de proyecto: Coordinador → Gestor, proceso done, documento en Conocimiento, propuestas pendientes e historial', async () => {
  resetMockCalls(); fs.writeFileSync(logPath, '');
  const app = await buildApp();
  const r = await app.inject({ method: 'POST', url: '/api/workspaces/portal-ia/org-evaluations', payload: { projectId: internal.id, budgetUsd: 5, authorized: true, ...NO_BRIEF } });
  assert.equal(r.statusCode, 202, r.body);
  const ev = await waitFinished(app, 'portal-ia', r.json().id);
  assert.equal(ev.status, 'done', ev.error ?? '');
  projectEvalId = ev.id;
  const proc = processesRepo('portal-ia').get(ev.processId)!;
  assert.equal(proc.status, 'done'); assert.equal(proc.kind, 'delegated_task'); assert.ok(proc.spentUsd <= proc.budgetUsd);
  assert.deepEqual(proc.steps.map(s => [s.title, s.status]), [['Análisis del Coordinador', 'done'], ['Evaluación del Gestor', 'done']]);
  assert.equal(adapters.mockCalls, 2);
  const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log.find(l => l.rule === 'Entrega en markdown')?.markers.includes('COORD-NOTA-ORG'), 'el análisis del Coordinador llega al Gestor');
  assert.equal(ev.scopeKind, 'project'); assert.equal(ev.projectId, internal.id); assert.match(ev.summary, /RESUMEN-ORG/);
  assert.equal(ev.proposals.length, 2); assert.ok(ev.proposals.every((p: any) => p.decision === 'pending'));
  const doc = knowledgeRepo('portal-ia').get(ev.knowledgeDocId)!;
  assert.equal(doc.projectId, internal.id); assert.match(doc.title, /^Evaluación organizativa · /);
  assert.match(doc.body, /COORD-NOTA-ORG/); assert.match(doc.body, /Auditor de seguridad/);
  const hist = (await app.inject({ method: 'GET', url: `/api/workspaces/portal-ia/org-evaluations?projectId=${internal.id}` })).json();
  assert.equal(hist[0].id, ev.id);
  await app.close();
});

test('e · decisiones individuales: aceptar y rechazar (con confirmación) solo registran; los agentes no cambian; decidir dos veces → 409', async () => {
  assert.ok(projectEvalId, 'requiere la evaluación de la prueba d');
  const app = await buildApp();
  const agentsBefore = agentsRepo('portal-ia').list().map(a => a.id).sort();
  const url = (pid: string) => `/api/workspaces/portal-ia/org-evaluations/${projectEvalId}/proposals/${pid}`;
  const acc = await app.inject({ method: 'POST', url: url('p1'), payload: { decision: 'accepted' } });
  assert.equal(acc.statusCode, 200, acc.body); assert.equal(acc.json().proposal.decision, 'accepted');
  const rej = await app.inject({ method: 'POST', url: url('p2'), payload: { decision: 'rejected', confirm: true } });
  assert.equal(rej.statusCode, 200, rej.body); assert.equal(rej.json().proposal.decision, 'rejected');
  assert.equal((await app.inject({ method: 'POST', url: url('p1'), payload: { decision: 'rejected', confirm: true } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: url('p9'), payload: { decision: 'accepted' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: url('p1'), payload: { decision: 'quizas' } })).statusCode, 400);
  assert.deepEqual(agentsRepo('portal-ia').list().map(a => a.id).sort(), agentsBefore, 'decidir no crea ni elimina agentes');
  const ev = (await app.inject({ method: 'GET', url: `/api/workspaces/portal-ia/org-evaluations/${projectEvalId}` })).json();
  assert.deepEqual(ev.proposals.map((p: any) => p.decision), ['accepted', 'rejected']); assert.ok(ev.proposals.every((p: any) => p.decidedAt));
  const body = knowledgeRepo('portal-ia').get(ev.knowledgeDocId)!.body;
  assert.match(body, /p1 · Aceptada/); assert.match(body, /p2 · Rechazada/);
  await app.close();
});

test('f · genérico: otra empresa con su propio proyecto evalúa la empresa y el proyecto, con historial aislado', async () => {
  const beta = createCompany('Empresa Beta Org');
  const shop = createProject(beta.slug, 'Tienda online', 'Comercio electrónico', ['Vender en línea']);
  const app = await buildApp();
  const r1 = await app.inject({ method: 'POST', url: `/api/workspaces/${beta.slug}/org-evaluations`, payload: { projectId: null, budgetUsd: 5, authorized: true, ...NO_BRIEF } });
  assert.equal(r1.statusCode, 202, r1.body);
  const wsEv = await waitFinished(app, beta.slug, r1.json().id);
  assert.equal(wsEv.status, 'done', wsEv.error ?? ''); assert.equal(wsEv.scopeKind, 'workspace'); assert.equal(wsEv.projectId, null);
  assert.equal(wsEv.anchorProjectId, shop.id); assert.equal(wsEv.process.steps.length, 1);
  assert.equal(knowledgeRepo(beta.slug).get(wsEv.knowledgeDocId)!.projectId, shop.id);
  const r2 = await app.inject({ method: 'POST', url: `/api/workspaces/${beta.slug}/org-evaluations`, payload: { projectId: shop.id, budgetUsd: 5, authorized: true, ...NO_BRIEF } });
  const pjEv = await waitFinished(app, beta.slug, r2.json().id);
  assert.equal(pjEv.status, 'done', pjEv.error ?? ''); assert.equal(pjEv.process.steps.length, 2);
  const onlyWs = (await app.inject({ method: 'GET', url: `/api/workspaces/${beta.slug}/org-evaluations?scope=workspace` })).json();
  assert.deepEqual(onlyWs.map((e: any) => e.id), [wsEv.id]);
  const all = (await app.inject({ method: 'GET', url: `/api/workspaces/${beta.slug}/org-evaluations` })).json();
  assert.equal(all.length, 2);
  assert.ok(!orgEvaluationsRepo('portal-ia').list().some(e => e.id === wsEv.id || e.id === pjEv.id), 'cada empresa tiene su historial');
  await app.close();
});

test('g · migración aditiva: la tabla se crea en una base existente sin perder datos y es idempotente', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-orgeval-db-')), 'legacy.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE knowledge (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL); INSERT INTO knowledge VALUES ('k1', 'Doc previo', 'contenido');`);
  ensureOrgEvaluationSchema(db); ensureOrgEvaluationSchema(db);
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'org_evaluations'`).get());
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM knowledge`).get() as any).n, 1);
  db.prepare(`INSERT INTO org_evaluations (id, scope_kind, project_id, anchor_project_id, status, created_at, updated_at) VALUES ('e1', 'workspace', NULL, 'p', 'done', 't', 't')`).run();
  ensureOrgEvaluationSchema(db);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM org_evaluations`).get() as any).n, 1, 'repetir la migración no borra el historial');
  db.close();
  // Base de espacio real ya poblada: abrir el repositorio no altera agentes ni proyectos.
  const gamma = createCompany('Empresa Gamma Org'); createProject(gamma.slug, 'Proyecto Gamma');
  const agents = agentsRepo(gamma.slug).count(); const projects = projectsRepo(gamma.slug).list().length;
  assert.equal(orgEvaluationsRepo(gamma.slug).list().length, 0); orgEvaluationsRepo(gamma.slug);
  assert.equal(agentsRepo(gamma.slug).count(), agents); assert.equal(projectsRepo(gamma.slug).list().length, projects);
});

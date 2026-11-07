import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * EN-015 · Resolución por nombre propio en el servidor (sin IA, 0 USD): encargos (pickLeadAgent), responsable de
 * historias importadas (resolveOwner vía importBacklogFromKnowledge) y propuestas organizativas (resolveSubject y
 * reportsTo de planProposal). Sin distinguir mayúsculas ni acentos, sin perder la resolución por puesto ni por clave,
 * y con 422 «ambiguo» cuando un nombre coincide con dos agentes.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en015-resolucion-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, agentPersonalName } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, backlogRepo, knowledgeRepo } = await import('../src/db/workspace.ts');
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { pickLeadAgent } = await import('../src/services/delegation.ts');
const { importBacklogFromKnowledge } = await import('../src/services/backlog.ts');
const { resolveSubject, planProposal } = await import('../src/services/orgProposalApply.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const company = createCompany('Empresa Nombres Propios');
const SLUG = company.slug;
const project = createProject(SLUG, 'Producto Nombres', 'Proyecto para comprobar la resolución por nombre propio', ['Calidad']);
const byKey = (key: string) => agentsRepo(SLUG).byKey(key, project.id)!;
const setPersonal = (id: string, personalName: string) => { const a = agentsRepo(SLUG).get(id)!; agentsRepo(SLUG).updateConfig(a.id, { ...a.config, personalName } as any); return agentsRepo(SLUG).get(id)!; };
const ev = { projectId: project.id } as any;

const qa = setPersonal(byKey('pj-qa').id, 'Lucía');
const coord = byKey('pj-coordinador');

test('el nombre propio queda guardado aparte del puesto', () => {
  assert.equal(agentPersonalName(qa), 'Lucía');
  assert.notEqual(qa.config.name, 'Lucía', 'config.name sigue siendo el puesto');
});

test('encargos: pickLeadAgent resuelve por nombre propio sin mayúsculas ni acentos, y sigue por puesto y clave', () => {
  for (const ref of ['lucia', 'LUCÍA', 'Lucía', ' lucía ']) assert.equal(pickLeadAgent(SLUG, project.id, ref).id, qa.id, `ref «${ref}»`);
  assert.equal(pickLeadAgent(SLUG, project.id, 'pj-qa').id, qa.id, 'por clave');
  assert.equal(pickLeadAgent(SLUG, project.id, qa.config.name).id, qa.id, 'por puesto');
  assert.equal(pickLeadAgent(SLUG, project.id, coord.config.name).id, coord.id, 'el puesto de otro agente no cambia');
});

test('backlog: el responsable de una historia importada se resuelve por nombre propio y por puesto', () => {
  const body = '```json\n' + JSON.stringify([
    { id: 'HU-901', titulo: 'Historia asignada a lucia', responsable: 'lucia', criterio: 'c' },
    { id: 'HU-902', titulo: 'Historia asignada a Lucía', responsable: 'Lucía', criterio: 'c' },
    { id: 'HU-903', titulo: 'Historia asignada por puesto', responsable: qa.config.name, criterio: 'c' }
  ]) + '\n```';
  knowledgeRepo(SLUG).add({ projectId: project.id, title: 'Síntesis de prueba EN-015', body, authorAgentId: coord.id, authorAgentName: coord.config.name, processId: null } as any);
  const r = importBacklogFromKnowledge(SLUG, project.id);
  assert.ok(r.imported >= 3, `importadas: ${r.imported}`);
  const owner = (sid: string) => backlogRepo(SLUG).listAll(project.id).find(b => b.storyId === sid)?.ownerKey;
  assert.equal(owner('HU-901'), 'pj-qa');
  assert.equal(owner('HU-902'), 'pj-qa');
  assert.equal(owner('HU-903'), 'pj-qa');
});

test('orgProposalApply: resolveSubject y reportsTo aceptan el nombre propio y el puesto', () => {
  assert.equal(resolveSubject(SLUG, ev, 'lucia').id, qa.id);
  assert.equal(resolveSubject(SLUG, ev, 'LUCÍA').id, qa.id);
  assert.equal(resolveSubject(SLUG, ev, qa.config.name).id, qa.id, 'por puesto');
  assert.equal(resolveSubject(SLUG, ev, `Lucía (pj-qa)`).id, qa.id, '«Nombre (clave)»');
  const plan = planProposal(SLUG, ev, { id: 'P-1', target: 'agent', action: 'adjust', subject: coord.config.name, spec: { reportsTo: 'lucía' }, decision: 'pending' } as any);
  const op = plan.ops[0] as any;
  assert.equal(op.kind, 'update');
  assert.equal(op.agentId, coord.id);
  assert.equal(op.spec.reportsTo, 'pj-qa');
});

test('orgProposalApply: un nombre que coincide con dos agentes (nombre propio de uno = puesto de otro) da 422 ambiguo', () => {
  const other = agentsRepo(SLUG).list().find(a => a.projectId === project.id && a.key !== 'pj-qa' && a.key !== 'pj-coordinador' && !(a.template as any).retiredAt);
  assert.ok(other, 'hace falta un tercer agente en el proyecto');
  setPersonal(other!.id, coord.config.name);
  assert.throws(() => resolveSubject(SLUG, ev, coord.config.name.toUpperCase()), (e: any) => e.statusCode === 422 && e.code === 'invalid_subject' && /ambiguo/.test(e.message));
  assert.throws(() => planProposal(SLUG, ev, { id: 'P-2', target: 'agent', action: 'adjust', subject: 'pj-qa', spec: { reportsTo: coord.config.name }, decision: 'pending' } as any), (e: any) => e.statusCode === 422 && e.code === 'invalid_spec' && /ambiguo/.test(e.message));
  // La clave sigue sin ambigüedad.
  assert.equal(resolveSubject(SLUG, ev, 'pj-coordinador').id, coord.id);
});

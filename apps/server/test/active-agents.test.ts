import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * HU-159 · Los agentes retirados (template.retiredAt) no reciben trabajo en ningún servicio: encargos, consultas al
 * equipo del responsable, preguntas en el espacio de la historia ni responsable por defecto de las historias.
 * Sin IA: todo se comprueba con estimaciones y acciones locales.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-active-agents-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo } = await import('../src/db/workspace.ts');
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { activeAgents } = await import('../src/services/activeAgents.ts');
const { pickLeadAgent, teamOf } = await import('../src/services/delegation.ts');
const { estimateAsk } = await import('../src/services/storyThread.ts');
const { addManualItem } = await import('../src/services/backlog.ts');

// Como en las demás suites: un proveedor (simulado) conectado antes de inicializar el espacio interno; sin él,
// runBootstrap lanza «Conecta y verifica un proveedor…» y el archivo entero falla antes de ejecutar sus pruebas.
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const company = createCompany('Empresa Retirados');
const SLUG = company.slug;
const project = createProject(SLUG, 'Producto Retirados', 'Proyecto para comprobar agentes retirados', ['Calidad']);
const byKey = (key: string) => agentsRepo(SLUG).byKey(key, project.id)!;
const retire = (key: string) => { const a = byKey(key); agentsRepo(SLUG).updateTemplateMeta(a.id, { ...a.template, retiredAt: new Date().toISOString(), retiredBy: 'owner' } as any); return a; };

const qa = retire('pj-qa');

test('activeAgents excluye al retirado sin borrar su fila', () => {
  assert.ok(agentsRepo(SLUG).list().some(a => a.id === qa.id), 'la fila se conserva');
  assert.ok(!activeAgents(SLUG).some(a => a.id === qa.id));
});

test('encargos: un retirado no es responsable ni se le consulta', () => {
  const lead = pickLeadAgent(SLUG, project.id, 'pj-qa');
  assert.notEqual(lead.id, qa.id);
  assert.equal(lead.key, 'pj-coordinador');
  assert.ok(!teamOf(SLUG, lead).some(a => a.id === qa.id), 'el retirado no está en el equipo consultable');
});

test('espacio de la historia: preguntar a un retirado recae en el Coordinador', () => {
  const item = addManualItem(SLUG, project.id, { title: 'Historia de prueba de retirados' });
  const est = estimateAsk(SLUG, item.id, qa.id);
  assert.notEqual(est.agentId, qa.id);
  assert.equal(est.agentId, byKey('pj-coordinador').id);
});

test('backlog: con el Coordinador retirado, una historia nueva no se le asigna', () => {
  retire('pj-coordinador');
  const item = addManualItem(SLUG, project.id, { title: 'Otra historia sin coordinador activo' });
  assert.equal(item.ownerKey, null);
});

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * EN-014 · El ámbito real del agente se ve sin entrar en Ajustes y la interfaz ya no llama «Ámbito» a Template.scope
 * (que indica dónde trabaja en el Portal). Sin modelo real: proveedor simulado, datos temporales y 0 USD.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en014v-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const D: any = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const F: any = await import('../src/services/agentFolders.ts');
const { officeView } = await import('../src/services/agentOs.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-' + 'ant-test'), 'sk-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia';
after(() => { try { fs.rmSync(process.env.PORTAL_DATA_DIR!, { recursive: true, force: true }); } catch { /* temporal */ } });

const db = () => workspaceDb(S) as any;
const COMPANY_GENERAL = { project: null, company: true, general: true };
function usageCounts(): Record<string, number> {
  const tables = (db().prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as any[]).map(r => String(r.name))
    .filter(n => /usage|call|cost|ledger|spend/i.test(n));
  return Object.fromEntries(tables.map(t => [t, Number((db().prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as any).n)]));
}

test('dominio: contextScopeBadges en orden Proyecto · nombre, Empresa, General; [] sin ámbito; workplaceLabel', () => {
  const all = D.contextScopeBadges({ project: { id: 'p-1', name: 'Halcón' }, company: true, general: true });
  assert.deepEqual(all.map((b: any) => b.id), ['project', 'company', 'general']);
  assert.equal(all[0].text, 'Proyecto · Halcón');
  assert.equal(all[1].text, 'Empresa'); assert.equal(all[2].text, 'General');
  assert.deepEqual(D.contextScopeBadges(COMPANY_GENERAL).map((b: any) => b.text), ['Empresa', 'General']);
  assert.deepEqual(D.contextScopeBadges(null), []);
  assert.deepEqual(D.contextScopeBadges(undefined), []);
  assert.deepEqual(D.contextScopeBadges({ project: null, company: false, general: false }), []);
  assert.equal(D.workplaceLabel('workspace'), 'Toda la empresa');
  assert.equal(D.workplaceLabel('project'), 'Su proyecto');
});

test('Oficina: tras la migración todos (también pj-*) muestran Empresa + General, sin costo ni cambios de permisos', async () => {
  await F.ensureAgentFolders(S, { companyName: 'Portal IA' });
  db().prepare('UPDATE agents SET context_scope_json = NULL').run();
  const r = await F.migrateAgentContextScopes(S, 'Portal IA');
  assert.deepEqual(r.failed, []);
  const configs = new Map((agentsRepo(S).list() as any[]).map(a => [a.id, JSON.stringify(a.config)]));
  const u0 = usageCounts();
  const view = officeView(S, []);
  assert.ok(view.agents.length > 0, 'hay agentes');
  for (const a of view.agents) {
    assert.deepEqual(a.contextScope, COMPANY_GENERAL, `${a.key}: Empresa + General`);
    assert.ok(!D.contextScopeBadges(a.contextScope).some((b: any) => b.id === 'project'), `${a.key}: no sale como Proyecto`);
  }
  for (const a of view.agents.filter((x: any) => x.scope === 'project' || String(x.key).startsWith('pj-')))
    assert.deepEqual(D.contextScopeBadges(a.contextScope).map((b: any) => b.text), ['Empresa', 'General'], `${a.key}: trabaja en su proyecto pero su ámbito es Empresa + General`);
  assert.deepEqual(usageCounts(), u0, 'la vista no gasta nada');
  for (const a of agentsRepo(S).list() as any[]) assert.equal(JSON.stringify(a.config), configs.get(a.id), `${a.key}: permisos intactos`);
});

test('interfaz: «Dónde trabaja» para Template.scope, chips del ámbito real y un único bloque «Ámbito» en Nuevo agente', () => {
  const web = (f: string) => fs.readFileSync(new URL(`../../web/src/${f}`, import.meta.url), 'utf8');
  const team = web('screens/Team.tsx'); const detail = web('screens/AgentDetail.tsx'); const panel = web('components/AgentPanel.tsx');
  // HU-210 · AgentCreate.tsx desapareció: el único asistente de creación es AgentWizard (/oficina/nuevo-agente).
  assert.equal(fs.existsSync(new URL('../../web/src/screens/AgentCreate.tsx', import.meta.url)), false, 'AgentCreate.tsx ya no existe');
  const office = web('screens/Office.tsx'); const wizard = web('screens/AgentWizard.tsx');
  for (const [n, src] of [['Team', team], ['AgentDetail', detail], ['AgentPanel', panel], ['AgentWizard', wizard]] as const) {
    assert.ok(!/Ámbito: (proyecto|empresa|toda la empresa|su proyecto)/i.test(src), `${n}: no llama «Ámbito» a dónde trabaja`);
    assert.ok(!/Ámbito asignado/.test(src), `${n}: sin «Ámbito asignado»`);
    assert.ok(!/data-label="Ámbito"[^\n]*a\.scope/.test(src), `${n}: la columna «Ámbito» no usa a.scope`);
  }
  for (const [n, src] of [['Team', team], ['AgentDetail', detail], ['AgentPanel', panel], ['Office', office]] as const)
    assert.match(src, /<ContextScopeChips /, `${n}: muestra los chips del ámbito real`);
  assert.match(team, /Dónde trabaja/); assert.match(team, /workplaceLabel/);
  assert.match(detail, /Dónde trabaja en el Portal/);
  assert.match(wizard, /Dónde trabaja en el Portal/);
  assert.equal((wizard.match(/<legend className="label">Ámbito<\/legend>/g) ?? []).length, 1, 'un único bloque «Ámbito»');
  assert.match(wizard, /export function ContextScopeChips/);
  assert.match(wizard, /d\.contextScope \?\? DEFAULT_CONTEXT_SCOPE/, 'por defecto Empresa + General');
  assert.match(detail, /ContextScopeFields/); assert.match(detail, /setAgentContextScope/);
});

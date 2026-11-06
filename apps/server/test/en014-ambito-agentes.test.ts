import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * EN-014 · Ámbito de los agentes (Proyecto, Empresa y General, combinables). Sin modelo real: proveedor simulado,
 * datos temporales y 0 USD. Una prueba por criterio: agent.yaml, instrucciones, habilidades, exportación, importación,
 * migración, guardado del ámbito (sin costo ni cambios de permisos) y conexión de la interfaz.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en014-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const D: any = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const F: any = await import('../src/services/agentFolders.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-' + 'ant-test'), 'sk-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia';
after(() => { try { fs.rmSync(process.env.PORTAL_DATA_DIR!, { recursive: true, force: true }); } catch { /* temporal */ } });

const db = () => workspaceDb(S) as any;
const agentIds = (): string[] => (db().prepare('SELECT id FROM agents ORDER BY created_at, id').all() as any[]).map(r => r.id);
const getAgent = (id: string): any => agentsRepo(S).get(id);
const COMPANY = 'Acme Logística'; const PROJECT = 'Proyecto Halcón';
const GENERAL_ONLY = { project: null, company: false, general: true };
const COMPANY_GENERAL = { project: null, company: true, general: true };
const PROJECT_ONLY = { project: { id: 'p-1', name: PROJECT }, company: false, general: false };

/** Filas de las tablas de uso o costo (para comprobar que guardar el ámbito no gasta nada). */
function usageCounts(): Record<string, number> {
  const tables = (db().prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as any[]).map(r => String(r.name))
    .filter(n => /usage|call|cost|ledger|spend/i.test(n));
  return Object.fromEntries(tables.map(t => [t, Number((db().prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as any).n)]));
}
const revisionsOf = (id: string): any[] => db().prepare('SELECT * FROM agent_revisions WHERE agent_id = ? ORDER BY n').all(id) as any[];
const stripScope = (yaml: string) => yaml.replace(/^context_scope:.*(\n {2}- .*)*\n?/m, '').replace(/^(project_name|company_name):.*\n?/gm, '');

let ids: string[] = [];

test('migración: dos pasadas dejan a todos como Empresa + General con una sola revisión «portal» y sin tocar arnés, permisos, memoria ni carpeta', async () => {
  await F.ensureAgentFolders(S, { companyName: 'Portal IA' });
  ids = agentIds();
  assert.ok(ids.length > 0, 'hay agentes de partida');
  db().prepare('UPDATE agents SET context_scope_json = NULL').run();
  const before = new Map(ids.map(id => {
    const a = getAgent(id); const fo: any = F.agentFoldersRepo(S).folderOf(id);
    return [id, { config: JSON.stringify(a.config), status: a.status, memory: JSON.stringify(F.memoryOf(S, id)), folder: fo?.folder ?? fo?.name ?? fo?.path ?? null }];
  }));
  const first = await F.migrateAgentContextScopes(S, 'Portal IA');
  assert.deepEqual(first.failed, []);
  const second = await F.migrateAgentContextScopes(S, 'Portal IA');
  assert.deepEqual(second.failed, []);
  assert.deepEqual(second.migrated, [], 'la segunda pasada no migra nada');
  await F.ensureAgentFolders(S, { companyName: 'Portal IA' });
  for (const id of ids) {
    const a = getAgent(id);
    assert.deepEqual(a.contextScope, COMPANY_GENERAL, `${id}: Empresa + General`);
    const notes = revisionsOf(id).filter(r => /Ámbito inicial/.test(String(r.note ?? '')));
    assert.equal(notes.length, 1, `${id}: exactamente una revisión de la migración`);
    assert.equal(notes[0].source, 'portal');
    assert.match(String(notes[0].note), /Empresa/); assert.match(String(notes[0].note), /General/);
    const b = before.get(id)!; const fo: any = F.agentFoldersRepo(S).folderOf(id);
    assert.equal(JSON.stringify(a.config), b.config, `${id}: arnés y permisos intactos`);
    assert.equal(a.status, b.status);
    assert.equal(JSON.stringify(F.memoryOf(S, id)), b.memory, `${id}: memoria intacta`);
    assert.equal(fo?.folder ?? fo?.name ?? fo?.path ?? null, b.folder, `${id}: misma carpeta`);
  }
});

test('agent.yaml: declara context_scope; sin él sigue siendo válido; vacío o desconocido se rechaza', () => {
  const files = F.agentFoldersRepo(S).adopted(ids[0]!)!.files as Record<string, string>;
  const y = files['agent.yaml']!;
  assert.match(y, /^context_scope:/m, y);
  assert.match(y, /- company/); assert.match(y, /- general/);
  const ok = D.filesToDefinition(files);
  assert.deepEqual(ok.problems.filter((p: any) => p.blocking), []);
  assert.deepEqual([...ok.definition.manifest.contextScope.options].sort(), ['company', 'general']);
  const old = D.filesToDefinition({ ...files, 'agent.yaml': stripScope(y) });
  assert.deepEqual(old.problems.filter((p: any) => p.blocking), [], 'una carpeta sin ámbito sigue siendo válida');
  assert.equal(old.definition.manifest.contextScope, undefined);
  for (const bad of ['context_scope: []\n', 'context_scope:\n  - galaxia\n']) {
    const r = D.filesToDefinition({ ...files, 'agent.yaml': stripScope(y) + bad });
    assert.ok(r.problems.some((p: any) => p.blocking && p.path === 'agent.yaml'), `rechaza ${JSON.stringify(bad)}`);
  }
  assert.equal(D.normalizeContextScope({ project: null, company: false, general: false }), null, 'no se admite un ámbito vacío');
  assert.deepEqual(D.DEFAULT_CONTEXT_SCOPE, COMPANY_GENERAL);
});

test('buildDefaultInstructions: Empresa, Proyecto y General cambian el texto; sin ámbito queda el de antes', () => {
  const base = { name: 'Ana', role: 'Revisora', responsibilities: ['Revisar'], tools: ['run_tests'], mark: '<!-- por defecto -->' };
  const legacy = D.buildDefaultInstructions(base);
  assert.match(legacy, /Ana es Revisora en Portal IA\./, 'sin ámbito, texto anterior');
  const emp = D.buildDefaultInstructions({ ...base, contextScope: { project: null, company: true, general: false }, companyName: COMPANY });
  assert.match(emp, new RegExp(`Ana es Revisora en ${COMPANY}`));
  assert.match(emp, /## Empresa/); assert.match(emp, /autoridad es el propietario/); assert.match(emp, /Nada con costo/);
  assert.ok(!/Portal IA/.test(emp));
  const pro = D.buildDefaultInstructions({ ...base, contextScope: PROJECT_ONLY, projectName: PROJECT, projectGoals: ['Entregar la v2'] });
  assert.match(pro, /## Proyecto/); assert.match(pro, new RegExp(PROJECT)); assert.match(pro, /- Entregar la v2/);
  const gen = D.buildDefaultInstructions({ ...base, contextScope: GENERAL_ONLY });
  assert.match(gen, /## En cualquier entorno/); assert.match(gen, /se adapta a lo que permita el entorno/);
  assert.ok(!/Portal IA/.test(gen.split('## Habilidades')[0]!));
  assert.ok(gen.trimEnd().endsWith('<!-- por defecto -->'));
  // Las instrucciones propias (sin la marca) no se regeneran: la regla existente se mantiene.
  const own = '# Ana\n\nInstrucciones propias del propietario.\n';
  assert.ok(!own.includes(F.defaultInstructions('Ana', '').split('\n').pop()!), 'unas instrucciones sin marca no son las por defecto');
});

test('habilidades base: General es genérico; Proyecto conserva las órdenes; no conceden permisos', () => {
  const tools = ['sandbox_exec', 'run_tests', 'install_deps'];
  const gen = D.baseSkillsFor(tools, GENERAL_ONLY).map((s: any) => s.body).join('\n');
  assert.ok(!gen.includes('sandbox.Dockerfile') && !gen.includes('portal-ia-sandbox'), 'sin la imagen del Portal');
  assert.match(gen, /package\.json|Makefile/);
  assert.match(gen, /## Fuera con terminal y Docker/);
  const guide = D.environmentGuide(GENERAL_ONLY);
  assert.ok(!guide.includes('sandbox.Dockerfile') && !guide.includes('portal-ia-sandbox'));
  for (const scope of [PROJECT_ONLY, { ...PROJECT_ONLY, general: true }, null]) {
    const body = D.baseSkillsFor(tools, scope).map((s: any) => s.body).join('\n');
    assert.match(body, /docker\/sandbox\.Dockerfile/); assert.match(body, /npm run typecheck/);
  }
  for (const scope of [GENERAL_ONLY, PROJECT_ONLY, COMPANY_GENERAL, null])
    for (const s of D.baseSkillsFor(tools, scope)) assert.match(s.body, /No concede permisos/);
  assert.equal(JSON.stringify(D.baseSkillsFor(tools)), JSON.stringify(D.baseSkillsFor(tools, null)), 'sin ámbito, igual que antes');
});

test('exportar: context_scope en agent.yaml y «## Ámbito» en GUIA.md; solo General no filtra nombres; validación igual de estricta', () => {
  const src = { ...F.agentFoldersRepo(S).adopted(ids[0]!)!.files } as Record<string, string>;
  src['AGENTS.md'] = `${src['AGENTS.md']}\nTrabaja para ${COMPANY} en el proyecto ${PROJECT}.\n`;
  const opts = { agentName: 'Ana', exportedAt: new Date().toISOString(), companyName: COMPANY, projectName: PROJECT };
  const both = D.buildPortableBundle(src, { ...opts, contextScope: { ...COMPANY_GENERAL, project: { id: 'p-1', name: PROJECT } } });
  assert.match(both['agent.yaml'], /^context_scope:/m);
  assert.match(both['GUIA.md'], /## Ámbito/);
  const gen = D.buildPortableBundle(src, { ...opts, contextScope: GENERAL_ONLY });
  assert.match(gen['agent.yaml'], /^context_scope:/m); assert.match(gen['agent.yaml'], /- general/);
  assert.match(gen['GUIA.md'], /## Ámbito/);
  for (const [p, c] of Object.entries(gen) as [string, string][]) {
    assert.ok(!c.includes(COMPANY), `${p}: no nombra la empresa`);
    assert.ok(!c.includes(PROJECT), `${p}: no nombra el proyecto`);
  }
  assert.deepEqual(D.validatePortableBundle(gen, { forbidden: [ids[0]!] }), []);
  const secret = 'sk-' + 'ant-api03-' + 'A1b2C3d4'.repeat(6);
  const bad = { ...gen, 'knowledge/clave.md': `# Clave\n\n${secret}\n`, 'otros/x.md': 'x\n', 'AGENTS.md': `${gen['AGENTS.md']}\n3f2a9c1e-7b4d-4e8a-9f10-2c3d4e5f6a7b\n` };
  const problems = D.validatePortableBundle(bad, { forbidden: [ids[0]!] });
  assert.ok(problems.some((p: any) => p.path === 'knowledge/clave.md'), 'secreto rechazado');
  assert.ok(problems.some((p: any) => p.path === 'otros/x.md'), 'ruta no permitida');
  assert.ok(problems.some((p: any) => p.path === 'AGENTS.md' && /UUID/.test(p.message)), 'id interno rechazado');
});

test('importar: la vista previa muestra el ámbito y avisa sin bloquear si el proyecto no existe; un ZIP antiguo conserva o deja General', async () => {
  const files = F.agentFoldersRepo(S).adopted(ids[0]!)!.files as Record<string, string>;
  const y = stripScope(files['agent.yaml']!);
  const ghost = { ...files, 'agent.yaml': `${y}context_scope:\n  - project\n  - general\nproject_name: Proyecto Fantasma\n` };
  const pv = F.importScopePreview(S, ghost, null);
  assert.equal(pv.declared, true); assert.ok(pv.lines.length >= 2); assert.ok(pv.label);
  assert.equal(pv.projectMissing, true); assert.ok(pv.warning, 'avisa del proyecto inexistente');
  assert.deepEqual(D.filesToDefinition(ghost).problems.filter((p: any) => p.blocking), [], 'el aviso no bloquea');
  const old = { ...files, 'agent.yaml': y };
  const existing = getAgent(ids[0]!);
  const kept = F.importScopePreview(S, old, existing);
  assert.equal(kept.declared, false); assert.deepEqual(kept.contextScope, existing.contextScope);
  const fresh = F.importScopePreview(S, old, null);
  assert.deepEqual(fresh.contextScope, GENERAL_ONLY, 'agente nuevo sin ámbito: General');
  assert.deepEqual(F.applyImportedContextScope(S, ids[0]!, old, false), existing.contextScope);
  assert.deepEqual(getAgent(ids[0]!).contextScope, existing.contextScope);
});

test('guardar el ámbito no cambia herramientas ni permisos y no gasta nada', async () => {
  const id = ids[0]!; const a0 = getAgent(id); const u0 = usageCounts();
  const r = await F.updateContextScope(S, id, { project: null, company: false, general: true });
  assert.deepEqual(r.agent.contextScope, GENERAL_ONLY);
  const a1 = getAgent(id);
  assert.equal(JSON.stringify(a1.config), JSON.stringify(a0.config), 'herramientas, permisos y arnés intactos');
  assert.deepEqual(usageCounts(), u0, 'sin llamadas ni costo registrado');
  await assert.rejects(() => F.updateContextScope(S, id, { project: null, company: false, general: false }), 'no admite un ámbito vacío');
  assert.deepEqual(getAgent(id).contextScope, GENERAL_ONLY);
  await F.updateContextScope(S, id, COMPANY_GENERAL);
});

test('interfaz: Configuración muestra «Ámbito» con tres opciones y Nuevo agente lo pide con Empresa + General por defecto', () => {
  const web = (f: string) => fs.readFileSync(new URL(`../../web/src/screens/${f}`, import.meta.url), 'utf8');
  const detail = web('AgentDetail.tsx'); const wizard = web('AgentWizard.tsx');
  assert.match(detail, />Ámbito</); assert.match(detail, /ContextScopeFields/); assert.match(detail, /scopeIsEmpty/);
  assert.match(detail, /herramientas y permisos no cambian|no concede ni quita herramientas/);
  assert.match(wizard, /export function ContextScopeFields/); assert.match(wizard, /CONTEXT_SCOPE_OPTIONS/);
  assert.match(wizard, /d\.contextScope \?\? DEFAULT_CONTEXT_SCOPE/, 'por defecto Empresa + General');
  assert.match(wizard, /contextScope\?: ScopePreview/, 'la vista previa de importación muestra el ámbito');
  assert.deepEqual(D.CONTEXT_SCOPE_OPTIONS.map((o: any) => o.id), ['project', 'company', 'general']);
  for (const o of D.CONTEXT_SCOPE_OPTIONS) assert.ok(String(o.text).length > 10, `${o.id}: línea explicativa`);
});

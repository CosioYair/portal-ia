import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * EN-014 · Ámbito de los agentes, de punta a punta: por las rutas HTTP (app.inject) y la migración de arranque, no con
 * funciones sueltas. Sin modelo real: proveedor simulado, datos temporales y 0 USD.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en014-http-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const D: any = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const F: any = await import('../src/services/agentFolders.ts');
const { runContextScopeMigration } = await import('../src/services/contextScopeStartup.ts');
const { listZip, readZipEntry } = await import('../src/services/zipFile.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-' + 'ant-test'), 'sk-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const app = await buildApp();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en014-zip-'));
after(async () => { await app.close(); for (const d of [tmp, process.env.PORTAL_DATA_DIR!]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temporal */ } } });

const GENERAL_ONLY = { project: null, company: false, general: true };
const COMPANY_GENERAL = { project: null, company: true, general: true };
const db = () => workspaceDb(S) as any;
const agentIds = (): string[] => (db().prepare('SELECT id FROM agents ORDER BY created_at, id').all() as any[]).map(r => String(r.id));
const getAgent = (id: string): any => agentsRepo(S).get(id);
const panel = async (id: string) => { const r = await app.inject({ method: 'GET', url: `${W}/agents/${id}/panel` }); assert.equal(r.statusCode, 200, r.body); return r.json().agent; };
const putScope = (id: string, scope: unknown) => app.inject({ method: 'PUT', url: `${W}/agents/${id}/context-scope`, payload: scope as any });
const revisionsOf = (id: string): any[] => db().prepare('SELECT * FROM agent_revisions WHERE agent_id = ? ORDER BY n').all(id) as any[];
const stripScope = (yaml: string) => yaml.replace(/^context_scope:.*(\n {2}- .*)*\n?/m, '').replace(/^(project_name|company_name):.*\n?/gm, '');
function usageCounts(): Record<string, number> {
  const tables = (db().prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as any[]).map(r => String(r.name))
    .filter(n => /usage|call|cost|ledger|spend/i.test(n));
  return Object.fromEntries(tables.map(t => [t, Number((db().prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as any).n)]));
}
function unzip(buf: Buffer, name: string): Record<string, string> {
  const f = path.join(tmp, name); fs.writeFileSync(f, buf);
  const l = listZip(f, { maxEntries: 200, maxEntryBytes: 4 * 1024 * 1024, maxRatio: 200 });
  const out: Record<string, string> = {};
  for (const e of l.entries) { assert.equal(e.problem, null, `${e.name}: ${e.problem}`); out[e.name] = readZipEntry(f, e).toString('utf8'); }
  return out;
}
// ZIP sin compresión (método 0) con CRC32, para construir paquetes de prueba sin dependencias.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = (CRC[(c ^ x) & 0xff]! ^ (c >>> 8)) >>> 0; return (c ^ 0xffffffff) >>> 0; };
function zipOf(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name, 'utf8'); const data = Buffer.from(text, 'utf8'); const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central); const count = Object.keys(files).length;
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(count, 8); e.writeUInt16LE(count, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, e]);
}
const zipPreview = (buf: Buffer) => app.inject({ method: 'POST', url: `${W}/agents/import-zip/preview?name=agente.zip`, headers: { 'content-type': 'application/octet-stream' }, payload: buf });

let ids: string[] = []; let exported: Record<string, string> = {};

test('en014 · arranque: runContextScopeMigration deja a todos como Empresa + General, es idempotente y la API lo muestra', async () => {
  await F.ensureAgentFolders(S, { companyName: 'Portal IA' });
  ids = agentIds(); assert.ok(ids.length > 0, 'hay agentes de partida');
  db().prepare('UPDATE agents SET context_scope_json = NULL').run();
  const before = new Map(ids.map(id => [id, JSON.stringify(getAgent(id).config)]));
  const first = await runContextScopeMigration();
  assert.equal(first.failed, 0); assert.ok(first.migrated >= ids.length, 'la primera pasada migra a todos');
  const second = await runContextScopeMigration();
  assert.equal(second.failed, 0); assert.equal(second.migrated, 0, 'la segunda pasada no migra nada');
  for (const id of ids) {
    const a = await panel(id);
    assert.deepEqual(a.contextScope, COMPANY_GENERAL, `${id}: Empresa + General por la API`);
    assert.equal(JSON.stringify(a.config), before.get(id), `${id}: arnés y permisos intactos`);
    const notes = revisionsOf(id).filter(r => /Ámbito inicial/.test(String(r.note ?? '')));
    assert.equal(notes.length, 1, `${id}: una sola revisión de la migración`); assert.equal(notes[0].source, 'portal');
  }
});

test('en014 · PUT …/context-scope guarda el ámbito sin tocar herramientas ni permisos y sin gastar; vacío o proyecto inexistente, 400', async () => {
  const id = ids[0]!; const config0 = JSON.stringify((await panel(id)).config); const u0 = usageCounts();
  const ok = await putScope(id, GENERAL_ONLY); assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual((await panel(id)).contextScope, GENERAL_ONLY);
  assert.equal((await putScope(id, { project: null, company: false, general: false })).statusCode, 400, 'ámbito vacío');
  assert.equal((await putScope(id, { project: { id: 'no-existe', name: 'Fantasma' }, company: false, general: true })).statusCode, 400, 'proyecto inexistente');
  const a = await panel(id);
  assert.deepEqual(a.contextScope, GENERAL_ONLY, 'los rechazos no cambian nada');
  assert.equal(JSON.stringify(a.config), config0, 'herramientas, permisos y arnés intactos');
  assert.deepEqual(usageCounts(), u0, 'sin llamadas ni costo registrado');
});

test('en014 · GET …/export.zip declara el ámbito en agent.yaml y GUIA.md lo explica; solo General no escribe nombres', async () => {
  const id = ids[0]!;
  const r = await app.inject({ method: 'GET', url: `${W}/agents/${id}/export.zip` }); assert.equal(r.statusCode, 200, r.body);
  const gen = unzip(r.rawPayload, 'general.zip'); const y = gen['agent.yaml']!;
  assert.match(y, /^context_scope:/m, y); assert.match(y, /- general/); assert.ok(!/- company/.test(y) && !/- project/.test(y), y);
  assert.ok(!/^company_name:/m.test(y) && !/^project_name:/m.test(y), 'solo General: sin nombre de empresa ni de proyecto');
  assert.match(gen['GUIA.md']!, /## Ámbito/);
  assert.deepEqual(D.validatePortableBundle(gen, { forbidden: [id] }), []);
  assert.equal((await putScope(id, COMPANY_GENERAL)).statusCode, 200);
  const r2 = await app.inject({ method: 'GET', url: `${W}/agents/${id}/export.zip` }); assert.equal(r2.statusCode, 200, r2.body);
  exported = unzip(r2.rawPayload, 'empresa.zip');
  assert.match(exported['agent.yaml']!, /- company/); assert.match(exported['agent.yaml']!, /- general/);
});

test('en014 · POST …/import-zip/preview muestra el ámbito y avisa, sin bloquear, si el proyecto no existe', async () => {
  const y = stripScope(exported['agent.yaml']!);
  const ghost = { ...exported, 'agent.yaml': `${y}context_scope:\n  - project\n  - general\nproject_name: Proyecto Fantasma\n` };
  const r = await zipPreview(zipOf(ghost)); assert.equal(r.statusCode, 200, r.body);
  const pv = r.json(); const sp = pv.contextScope;
  assert.ok(sp, 'la vista previa trae el ámbito'); assert.equal(sp.declared, true); assert.ok(sp.label); assert.ok(sp.lines.length >= 1);
  assert.equal(sp.projectMissing, true); assert.ok(sp.warning, 'avisa del proyecto inexistente');
  assert.ok(!(pv.problems ?? []).some((p: any) => p.blocking && p.path === 'agent.yaml'), `el aviso no bloquea: ${JSON.stringify(pv.problems)}`);
});

const IMPORT_GRANT = { department: 'Dirección', scope: 'workspace', projectId: null, harness: 'api', model: 'claude-sonnet-4-5', provider: 'anthropic', effort: 'medium', tools: [], knowledge: [], autonomy: 'ask', authorized: true };
const withoutId = (yaml: string) => yaml.replace(/^id:.*\n?/m, '');

test('en014 · ZIP antiguo sin ámbito ni id (agente nuevo): la vista previa no lo declara y el agente creado queda General', async () => {
  const NAME = 'Agente Nuevo EN014';
  const y = withoutId(stripScope(exported['agent.yaml']!)).replace(/^name:.*$/m, `name: ${NAME}`);
  assert.ok(!/^context_scope:/m.test(y) && !/^id:/m.test(y), y);
  // Portal IA 3: un ZIP «antiguo» tampoco trae el marcador de exportacion (hoy el paquete lo lleva y volveria a su agente).
  const { 'portal-export.json': _marker, ...old } = exported;
  const r = await zipPreview(zipOf({ ...old, 'agent.yaml': y })); assert.equal(r.statusCode, 200, r.body);
  const pv = r.json();
  assert.equal(pv.mode, 'nuevo', 'sin id el ZIP es un agente nuevo');
  assert.equal(pv.contextScope?.declared, false, 'sin context_scope no se declara ámbito');
  assert.deepEqual(pv.contextScope.contextScope, GENERAL_ONLY, 'la vista previa anuncia General');
  const before = new Set(agentIds());
  const c = await app.inject({ method: 'POST', url: `${W}/agents/import-zip/confirm`, payload: { token: pv.token, hash: pv.hash, resolutions: {}, grant: IMPORT_GRANT } });
  assert.equal(c.statusCode, 201, c.body); assert.equal(c.json().mode, 'nuevo');
  const created = agentIds().filter(id => !before.has(id)).map(getAgent).find(a => a?.config?.name === NAME);
  assert.ok(created, 'se creó el agente nuevo');
  assert.deepEqual(created.contextScope, GENERAL_ONLY, 'agente nuevo de un ZIP antiguo: General');
  assert.deepEqual((await panel(created.id)).contextScope, GENERAL_ONLY, 'y así lo muestra la API');
});

test('en014 · ZIP antiguo sin ámbito de un agente existente: tras importar un cambio en AGENTS.md conserva su ámbito', async () => {
  const id = ids[0]!;
  assert.deepEqual((await panel(id)).contextScope, COMPANY_GENERAL, 'punto de partida: Empresa + General');
  const y = `id: ${JSON.stringify(id)}\n${withoutId(stripScope(exported['agent.yaml']!))}`;
  assert.ok(!/^context_scope:/m.test(y), y);
  const agentsMd = `${exported['AGENTS.md']!.replace(/\s+$/, '')}\n\nNota añadida fuera del Portal (EN-014).\n`;
  const r = await zipPreview(zipOf({ ...exported, 'agent.yaml': y, 'AGENTS.md': agentsMd })); assert.equal(r.statusCode, 200, r.body);
  const pv = r.json();
  assert.equal(pv.mode, 'existente', `el id lleva al agente existente: ${r.body.slice(0, 300)}`); assert.equal(pv.agentId, id);
  assert.equal(pv.contextScope?.declared, false, 'sin context_scope no se declara ámbito');
  assert.deepEqual(pv.contextScope.contextScope, COMPANY_GENERAL, 'la vista previa anuncia el ámbito que conserva');
  const resolutions = Object.fromEntries(((pv.conflicts ?? []) as any[]).map(c => [c.path, 'zip']));
  const c = await app.inject({ method: 'POST', url: `${W}/agents/import-zip/confirm`, payload: { token: pv.token, hash: pv.hash, resolutions } });
  assert.equal(c.statusCode, 201, c.body); assert.equal(c.json().mode, 'existente');
  assert.deepEqual(getAgent(id).contextScope, COMPANY_GENERAL, 'el agente existente conserva su ámbito');
  assert.deepEqual((await panel(id)).contextScope, COMPANY_GENERAL, 'y así lo muestra la API');
});

test('en014 · POST …/agents/wizard guarda el ámbito elegido; sin él queda Empresa + General; vacío, 400', async () => {
  const base = (name: string) => ({
    name, role: 'Análisis', summary: 'Analiza datos.', responsibilities: ['Analizar'], deliverables: [], department: 'Dirección', scope: 'workspace', projectId: null,
    harness: 'api', model: 'claude-sonnet-4-5', provider: 'anthropic', effort: 'medium', tools: [], knowledge: [], capabilities: [], autonomy: 'ask', skills: [], references: [], authorized: true
  });
  const u0 = usageCounts();
  const g = await app.inject({ method: 'POST', url: `${W}/agents/wizard`, payload: { ...base('Analista Ámbito General'), contextScope: GENERAL_ONLY } });
  assert.equal(g.statusCode, 201, g.body);
  assert.deepEqual((await panel(g.json().id)).contextScope, GENERAL_ONLY, 'el ámbito del asistente llega al agente');
  const d = await app.inject({ method: 'POST', url: `${W}/agents/wizard`, payload: base('Analista Ámbito Defecto') });
  assert.equal(d.statusCode, 201, d.body);
  assert.deepEqual((await panel(d.json().id)).contextScope, D.DEFAULT_CONTEXT_SCOPE, 'por defecto Empresa + General');
  const e = await app.inject({ method: 'POST', url: `${W}/agents/wizard`, payload: { ...base('Analista Ámbito Vacío'), contextScope: { project: null, company: false, general: false } } });
  assert.equal(e.statusCode, 400, e.body);
  assert.deepEqual(usageCounts(), u0, 'crear no gasta nada');
});

test('en014 · interfaz conectada: api.ts usa la ruta PUT real, la vista previa tipa el ámbito sin cast y el asistente lo envía', () => {
  const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const api = read('../../web/src/lib/api.ts'); const osApi = read('../../web/src/lib/osApi.ts');
  const detail = read('../../web/src/screens/AgentDetail.tsx'); const wizard = read('../../web/src/screens/AgentWizard.tsx');
  const routes = read('../src/routes/agentsOs.ts');
  assert.match(api, /agents\/\$\{id\}\/context-scope`, \{ method: 'PUT'/);
  assert.match(routes, /app\.put\('\/api\/workspaces\/:slug\/agents\/:id\/context-scope'/, 'la ruta que llama la web existe');
  assert.match(detail, /api\.setAgentContextScope\(/, 'Configuración guarda por la API');
  assert.match(osApi, /interface ImportPreview \{[^\n]*contextScope\?: ImportScopeView/, 'ImportPreview tipa el ámbito');
  assert.ok(!/as ImportPreview &/.test(wizard), 'sin cast en la vista previa');
  assert.match(wizard, /contextScope: \{ project: scope\.project/, 'el asistente envía el ámbito');
  assert.match(routes, /contextScope: CONTEXT_SCOPE_BODY\.optional\(\)/, 'el esquema del asistente no descarta el ámbito');
});

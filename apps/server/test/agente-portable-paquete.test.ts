import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * HU-182 · Paquete portable del agente (portal-ia/agent-bundle@2, docs/agentes-portables.md). Sin modelo real: proveedor
 * simulado y datos temporales. Comprueba que GET …/export.zip devuelve un ZIP con AGENTS.md, agent.yaml, habilidades,
 * memoria verificada, AUTOMEJORA.md, CAMBIOS.md, GUIA.md y scripts/anotar-cambio.mjs. También comprueba que no lleva
 * datos internos (id, UUID, rutas locales o de data/, /api/) ni secretos, que sigue siendo importable con
 * filesToDefinition, que un secreto da 409 y que el script anota en CAMBIOS.md.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-bundle-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { lessonsRepo } = await import('../src/services/lessons.ts');
const { agentFoldersRepo, syncAgentFolder } = await import('../src/services/agentFolders.ts');
const { listZip, readZipEntry } = await import('../src/services/zipFile.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-' + 'ant-test'), 'sk-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const app = await buildApp();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-bundle-zip-'));
after(async () => { await app.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temporal */ } });

const UUID = '3f2a9c1e-7b4d-4e8a-9f10-2c3d4e5f6a7b';
const WIN = 'C:\\Users\\yair\\Portal\\data\\workspaces\\portal-ia\\agents\\x';
// Construido al ejecutarse: escrito tal cual, el puente del Portal omitiría este archivo.
const SECRET = 'sk-' + 'ant-api03-' + 'A1b2C3d4'.repeat(6);

/** Lee todas las entradas de un ZIP (desde disco, como en producción). */
function unzip(buf: Buffer, name: string): Record<string, string> {
  const f = path.join(tmp, name); fs.writeFileSync(f, buf);
  const l = listZip(f, { maxEntries: 200, maxEntryBytes: 4 * 1024 * 1024, maxRatio: 200 });
  const out: Record<string, string> = {};
  for (const e of l.entries) { assert.equal(e.problem, null, `${e.name}: ${e.problem}`); out[e.name] = readZipEntry(f, e).toString('utf8'); }
  return out;
}

let agentId = ''; let files: Record<string, string> = {};

test('crear el agente con habilidad, referencia y memoria verificada con datos internos', async () => {
  const r = await app.inject({ method: 'POST', url: `${W}/agents/wizard`, payload: {
    name: 'Revisora de Contratos', role: 'Revisión legal', summary: 'Reviso contratos y señalo riesgos.', responsibilities: ['Revisar cláusulas'], deliverables: ['Informe de riesgos'],
    department: 'Legal', scope: 'workspace', projectId: null, harness: 'api', model: 'claude-sonnet-4-5', provider: 'anthropic', effort: 'medium',
    tools: [], knowledge: [], capabilities: [], autonomy: 'ask', instructions: '# Revisora de Contratos\n\nReviso contratos con criterio.\n',
    skills: [{ name: 'Revisar contratos', description: 'Detecta cláusulas abusivas.', body: '# Revisar contratos\n\n1. Lee el contrato entero.\n' }],
    references: [{ title: 'Glosario legal', body: '# Glosario\n\nCláusula penal: pena pactada.\n' }], authorized: true
  } });
  assert.equal(r.statusCode, 201, r.body); agentId = r.json().id;
  const at = new Date().toISOString();
  const lesson = (status: string, title: string, text: string) => lessonsRepo(S).insert({ projectId: null, role: null, tags: ['prueba'], status, version: 1, parentId: null, title, detector: 'import',
    evidence: { processId: UUID, processTitle: null, stepId: null, agentId, agentName: 'Revisora de Contratos', file: null, detail: `Importado de ${WIN} (proceso ${UUID})`, at },
    rootCause: null, correctiveAction: null, lessonText: text, source: 'import', promotedTo: null, dedupeKey: null, agentId } as any);
  lesson('validated', 'Cláusulas de penalización', `Revisar siempre las cláusulas de penalización (visto en ${WIN} y en /home/yair/notas.md, proceso ${UUID}).`);
  lesson('proposed', 'PROPUESTA-NO-SALE', 'Una lección sin verificar no viaja en el paquete.');
  await syncAgentFolder(S, agentsRepo(S).get(agentId)!);
  assert.match(agentFoldersRepo(S).adopted(agentId)!.files['memory/MEMORY.md'] ?? '', /penalización/, 'la memoria verificada está en la revisión adoptada');
});

test('el ZIP trae instrucciones, habilidad, memoria, reglas, guía y script; sin llamar a la IA', async () => {
  assert.equal((await app.inject({ method: 'GET', url: `${W}/agents/no-existe/export.zip` })).statusCode, 404);
  const r = await app.inject({ method: 'GET', url: `${W}/agents/${agentId}/export.zip` });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(String(r.headers['content-type']), /application\/zip/);
  assert.match(String(r.headers['content-disposition']), /attachment; filename="[A-Za-z0-9._-]+\.zip"/);
  files = unzip(r.rawPayload, 'paquete.zip');
  for (const f of ['AGENTS.md', 'agent.yaml', 'skills/revisar-contratos/SKILL.md', 'memory/MEMORY.md', 'knowledge/glosario-legal.md', 'CAMBIOS.md', 'AUTOMEJORA.md', 'GUIA.md', 'scripts/anotar-cambio.mjs'])
    assert.ok(files[f] !== undefined, `falta ${f} (hay: ${Object.keys(files).join(', ')})`);
  const ev = (await app.inject({ method: 'GET', url: `${W}/agents/${agentId}/panel` })).json().events ?? [];
  assert.ok(ev.some((e: any) => e.kind === 'exported' && e.detail?.format === 'zip'), 'queda registrada la exportación');
});

test('reglas de automejora y guía por entorno', () => {
  const a = files['AUTOMEJORA.md']!;
  assert.match(a, /Aplica lo que el usuario pida/); assert.match(a, /Aplica lo que corrija un reintento/);
  assert.match(a, /CAMBIOS\.md con fecha, qué, motivo y archivo/); assert.match(a, /No amplíes permisos/); assert.match(a, /No guardes secretos/);
  assert.match(a, /No marques memoria como verificada/); assert.match(a, /sin verificar/);
  assert.match(files['AGENTS.md']!.split('\n')[0]!, /AUTOMEJORA\.md/, 'AGENTS.md remite a las reglas en su primera línea');
  assert.match(files['AGENTS.md']!, /Reviso contratos con criterio/);
  for (const env of ['Claude Code web', 'Cowork', 'ChatGPT']) assert.match(files['GUIA.md']!, new RegExp(env));
  assert.match(files['CAMBIOS.md']!, /# Cambios de Revisora de Contratos/); assert.match(files['CAMBIOS.md']!, /Paquete exportado desde Portal IA/);
});

test('sin datos internos ni secretos; memoria verificada con procedencia neutra', () => {
  const y = files['agent.yaml']!;
  assert.ok(!/^id:/m.test(y) && !/^\s*model:/m.test(y) && !/^\s*tools:/m.test(y), `agent.yaml sin id, modelo ni herramientas:\n${y}`);
  for (const [p, c] of Object.entries(files)) {
    assert.ok(!c.includes(agentId), `${p}: id del agente`);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(c), `${p}: UUID`);
    assert.ok(!/(?<![\w])[A-Za-z]:\\/.test(c) && !/\/(home|Users)\//.test(c), `${p}: ruta local`);
    assert.ok(!/(?<![\w-])data\//.test(c), `${p}: ruta de data/`);
    assert.ok(!/\/api\/(workspaces|agents)/.test(c), `${p}: ruta /api/`);
    assert.equal(D.findSecret(c), null, `${p}: secreto`);
  }
  const m = files['memory/MEMORY.md']!;
  assert.match(m, /penalización/); assert.match(m, /\[ruta local\]/); assert.match(m, /Aprendido en el Portal/);
  assert.ok(!m.includes('PROPUESTA-NO-SALE'), 'solo memoria verificada');
  assert.ok(!m.includes('Importado de'), 'el origen interno se sustituye');
  assert.deepEqual(D.validatePortableBundle(files, { forbidden: [agentId] }), []);
});

test('la carpeta portable del paquete se puede reimportar con filesToDefinition', () => {
  const parsed = D.filesToDefinition(files);
  assert.deepEqual(parsed.problems.filter(p => p.blocking), []);
  assert.equal(parsed.definition?.manifest.name, 'Revisora de Contratos');
  assert.deepEqual(parsed.definition?.skills.map(s => s.slug), ['revisar-contratos']);
});

test('scripts/anotar-cambio.mjs añade una entrada a CAMBIOS.md (Node sin dependencias)', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'agente-'));
  for (const [p, c] of Object.entries(files)) { const f = path.join(dir, ...p.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); }
  const script = path.join(dir, 'scripts', 'anotar-cambio.mjs');
  const ok = spawnSync(process.execPath, [script, '--que', 'Tono más formal', '--motivo', 'Corrección tras un reintento', '--archivo', 'AGENTS.md'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const c = fs.readFileSync(path.join(dir, 'CAMBIOS.md'), 'utf8');
  assert.match(c, /Paquete exportado desde Portal IA[\s\S]*## \d{4}-\d{2}-\d{2} — Tono más formal\n- Motivo: Corrección tras un reintento\n- Archivo: AGENTS\.md/, 'añade al final sin borrar lo anterior');
  const bad = spawnSync(process.execPath, [script, '--que', 'Sin motivo'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Faltan datos/);
});

test('un secreto o el id interno impiden exportar: 409 con la lista de problemas', async () => {
  const bad = D.buildPortableBundle({ ...files, 'knowledge/clave.md': `# Clave\n\n${SECRET}\n`, 'AGENTS.md': `# X\n\nSoy ${agentId.replace(/-/g, '')}\n` }, { agentName: 'X', exportedAt: new Date().toISOString() });
  const problems = D.validatePortableBundle(bad, { forbidden: [agentId.replace(/-/g, '')] });
  assert.ok(problems.some(p => p.path === 'knowledge/clave.md'), JSON.stringify(problems));
  assert.ok(problems.some(p => p.path === 'AGENTS.md' && /id/.test(p.message)), JSON.stringify(problems));
  // writeRevision ya rechaza secretos: se fuerza la revisión adoptada en la base para comprobar la negativa de la ruta.
  const repo = agentFoldersRepo(S); const n = repo.folderOf(agentId)!.adoptedN!; const orig = repo.adopted(agentId)!.files;
  const db = workspaceDb(S); const set = (f: Record<string, string>) => db.prepare(`UPDATE agent_revisions SET files_json = ? WHERE agent_id = ? AND n = ?`).run(JSON.stringify(f), agentId, n);
  set({ ...orig, 'knowledge/clave.md': `# Clave\n\n${SECRET}\n` });
  try {
    const r = await app.inject({ method: 'GET', url: `${W}/agents/${agentId}/export.zip` });
    assert.equal(r.statusCode, 409, r.body);
    const j = r.json(); assert.match(j.error, /No se puede exportar el paquete/);
    assert.ok(Array.isArray(j.problems) && j.problems.some((p: any) => p.path === 'knowledge/clave.md'), r.body);
    assert.ok(!r.body.includes(SECRET), 'el motivo no repite el secreto');
  } finally { set(orig); }
  assert.equal((await app.inject({ method: 'GET', url: `${W}/agents/${agentId}/export.zip` })).statusCode, 200);
});

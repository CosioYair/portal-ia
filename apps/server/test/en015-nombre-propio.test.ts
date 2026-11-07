import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * EN-015 · Nombre propio del agente («Lucía»), separado del puesto (config.name). Proveedor simulado (0 USD) con registro
 * de llamadas y guion. Comprueba: reglas puras, autorización obligatoria (sin ella, 0 llamadas), UNA llamada por propuesta
 * registrada con tokens y costo, «Pedir otro», choque de nombres, nombre a mano sin llamada, lote con una autorización y
 * N llamadas, AGENTS.md (idéntico sin nombre), agent.yaml/ZIP de ida y vuelta y cableado de la interfaz.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en015-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json');
process.env.PORTAL_MOCK_LOG = logPath;
process.env.PORTAL_MOCK_SCRIPT = scriptPath;

const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, projectsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const F = await import('../src/services/agentFolders.ts');
const N = await import('../src/services/agentNames.ts');
const { exportFiles } = await import('../src/services/agentCreation.ts');

providersRepo.setCredential('anthropic', encryptSecret('clave-de-prueba'), 'clave…prueba');
providersRepo.setConnected('anthropic', ['claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia';
after(() => { try { fs.rmSync(process.env.PORTAL_DATA_DIR!, { recursive: true, force: true }); } catch { /* temporal */ } });

const mockCalls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length : 0;
const nameRows = () => (workspaceDb(S).prepare(`SELECT COUNT(*) AS n FROM execution_history WHERE kind = 'agent_name'`).get() as any).n as number;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const agentsMd = (id: string) => F.agentFoldersRepo(S).adopted(id)!.files['AGENTS.md']!;

const project = projectsRepo(S).list()[0]!;
const dev = agentsRepo(S).byKey('pj-dev', project.id)!;
const others = agentsRepo(S).list().filter(a => a.id !== dev.id && !D.isRetired(a.template) && a.config.name !== dev.config.name);
const [b, c] = [others[0]!, others[1]!];
for (const a of [dev, b, c]) agentsRepo(S).updateConfig(a.id, { ...agentsRepo(S).get(a.id)!.config, monthlyLimitUsd: 50 });

const json = (name: string, reason: string) => JSON.stringify({ name, reason });
fs.writeFileSync(scriptPath, JSON.stringify({ rules: [
  { match: `Eres «${esc(dev.config.name)}».*ya descartó`, text: json('Marta', 'Construyo con cuidado lo que el equipo planifica.') },
  { match: `Eres «${esc(dev.config.name)}»`, text: '```json\n' + json('Lucía', 'Aporto luz a cada cambio que implemento.') + '\n```' },
  { match: `Eres «${esc(b.config.name)}»`, responses: [{ text: json('LUCIA', 'Me gusta.') }, { text: json('Marcos', 'Marco el rumbo de mi trabajo.') }] },
  { match: `Eres «${esc(c.config.name)}»`, text: json('Valeria', 'Valoro la calidad de cada entrega.') }
] }));

test('reglas puras: longitud, caracteres, ids, secretos, puestos y unicidad sin mayúsculas ni acentos', () => {
  assert.equal(D.validateAgentName('Lucía').ok, true);
  assert.equal(D.validateAgentName('L').code, 'length');
  assert.equal(D.validateAgentName('A'.repeat(31)).code, 'length');
  assert.equal(D.validateAgentName('Agente 007').code, 'chars');
  assert.equal(D.validateAgentName('3f2a9c1e-1b2c-4d5e-8f90-123456789abc').code, 'id');
  assert.equal(D.validateAgentName('pj-dev', { ids: ['pj-dev'] }).code, 'id');
  assert.equal(D.validateAgentName('sk-ant-abcdefghijklmnopqrstuv').ok, false);
  assert.equal(D.validateAgentName('lucia', ['Lucía']).code, 'taken');
  assert.equal(D.validateAgentName('LUCÍA', { taken: ['lucia'] }).code, 'taken');
  assert.equal(D.validateAgentName('coordinador', { roles: ['Coordinador'] }).code, 'role');
  assert.equal(D.validateAgentName('  Ana   María ').name, 'Ana María');
  assert.equal(D.agentDisplayName({ name: 'Diseñador UX/UI', personalName: 'Lucía' }), 'Lucía · Diseñador UX/UI');
  assert.equal(D.agentDisplayName({ name: 'Diseñador UX/UI' }), 'Diseñador UX/UI', 'sin nombre, el puesto tal cual');
  assert.deepEqual(D.parseNameProposal('{"name":"Lucía","reason":"Luz"}'), { name: 'Lucía', reason: 'Luz' });
  assert.equal(D.parseNameProposal('Nombre: «Lucía»\nMotivo: aporto luz')?.name, 'Lucía');
  assert.equal(D.parseNameProposal('sin nada'), null);
});

test('AGENTS.md sin nombre propio es idéntico al de antes; con nombre lo presenta', () => {
  const input = { name: 'Diseñador UX/UI', role: 'Diseño', responsibilities: ['Revisar pantallas'], tools: [], mark: '<!-- por defecto -->' };
  const before = D.buildDefaultInstructions(input);
  assert.equal(D.buildDefaultInstructions({ ...input, personalName: null }), before);
  assert.equal(D.buildDefaultInstructions({ ...input, personalName: '' }), before);
  assert.ok(!before.includes('Te llamas'));
  const named = D.buildDefaultInstructions({ ...input, personalName: 'Lucía' });
  assert.ok(named.startsWith('# Lucía · Diseñador UX/UI'));
  assert.ok(named.includes('Te llamas Lucía y eres Diseñador UX/UI.'));
});

test('sin autorización no hay llamada (403); con ella, UNA llamada registrada con tokens y costo, sin guardar nada', async () => {
  assert.equal(D.agentPersonalName(agentsRepo(S).get(dev.id)!), null, 'empieza sin nombre');
  const c0 = mockCalls(); const r0 = nameRows();
  await assert.rejects(N.proposeName(S, dev.id, { authorized: false }), (e: any) => e.statusCode === 403);
  assert.equal(mockCalls(), c0, 'sin autorización, ninguna llamada');
  const est = N.estimateNameCost(S, dev.id);
  assert.ok(est.estimatedUsd >= 0 && typeof est.billable === 'boolean');
  const p = await N.proposeName(S, dev.id, { authorized: true });
  assert.equal(mockCalls(), c0 + 1, 'exactamente una llamada');
  assert.equal(nameRows(), r0 + 1, 'registrada en el historial de ejecuciones');
  assert.equal(p.name, 'Lucía'); assert.match(p.reason, /luz/i); assert.equal(p.check.ok, true);
  assert.ok(p.tokensIn > 0 && p.tokensOut > 0); assert.ok(p.costUsd >= 0);
  assert.equal(D.agentPersonalName(agentsRepo(S).get(dev.id)!), null, 'proponer no guarda');
  const again = await N.proposeName(S, dev.id, { authorized: true, rejected: ['Lucía'] });
  assert.equal(again.name, 'Marta', '«Pedir otro» manda los descartados y hace otra llamada');
  assert.equal(mockCalls(), c0 + 2);
});

test('aceptar y nombre a mano: sin llamada ni costo; AGENTS.md lo nombra y, al quitarlo, vuelve a ser idéntico', async () => {
  await F.syncAgentFolder(S, agentsRepo(S).get(dev.id)!);
  const md0 = agentsMd(dev.id); const role0 = agentsRepo(S).get(dev.id)!.config.name;
  const c0 = mockCalls(); const r0 = nameRows();
  const r = await N.setPersonalName(S, dev.id, 'Lucía');
  assert.equal(r.personalName, 'Lucía'); assert.equal(r.displayName, `Lucía · ${role0}`);
  const a = agentsRepo(S).get(dev.id)!;
  assert.equal(a.config.name, role0, 'el puesto no cambia'); assert.equal(a.config.personalName, 'Lucía');
  assert.ok(agentsMd(dev.id).includes(`Te llamas Lucía y eres ${role0}.`));
  assert.equal(mockCalls(), c0, 'sin llamada'); assert.equal(nameRows(), r0, 'sin uso registrado');
  await assert.rejects(N.setPersonalName(S, b.id, 'LUCIA'), (e: any) => e.statusCode === 409 && e.code === 'taken');
  await assert.rejects(N.setPersonalName(S, b.id, 'X'), (e: any) => e.statusCode === 400);
  assert.equal(N.checkName(S, b.id, 'lucía').code, 'taken');
  await N.setPersonalName(S, dev.id, null);
  assert.equal(agentsMd(dev.id), md0, 'sin nombre, el AGENTS.md es el de antes');
  await N.setPersonalName(S, dev.id, 'Lucía');
});

test('choque: si propone un nombre ocupado se marca y no se reintenta solo', async () => {
  const c0 = mockCalls();
  const p = await N.proposeName(S, b.id, { authorized: true });
  assert.equal(mockCalls(), c0 + 1, 'una sola llamada, sin reintento');
  assert.equal(p.check.ok, false); assert.equal(p.check.code, 'taken');
  assert.equal(D.agentPersonalName(agentsRepo(S).get(b.id)!), null);
});

test('lote de la Oficina: una autorización, una llamada por agente y aceptar todas', async () => {
  const c0 = mockCalls();
  await assert.rejects(N.proposeNames(S, [b.id, c.id], { authorized: false }), (e: any) => e.statusCode === 403);
  assert.equal(mockCalls(), c0, 'sin autorización, ninguna llamada');
  const r = await N.proposeNames(S, [b.id, c.id, c.id], { authorized: true });
  assert.equal(r.calls, 2); assert.equal(mockCalls(), c0 + 2, 'una llamada por agente');
  assert.ok(r.items.every(i => i.ok && i.proposal?.check.ok), JSON.stringify(r.items));
  assert.deepEqual(r.items.map(i => i.proposal!.name), ['Marcos', 'Valeria']);
  for (const i of r.items) await N.setPersonalName(S, i.agentId, i.proposal!.name);
  assert.equal(agentsRepo(S).get(b.id)!.config.personalName, 'Marcos');
  assert.equal(agentsRepo(S).get(c.id)!.config.personalName, 'Valeria');
  assert.equal(mockCalls(), c0 + 2, 'aceptar no llama');
});

test('agent.yaml y ZIP: personal_name de ida y vuelta; sin nombre no se escribe la clave; uno no válido no bloquea', async () => {
  const { files } = await exportFiles(S, dev.id);
  assert.match(files['agent.yaml']!, /personal_name: Lucía/);
  const def = D.filesToDefinition(files).definition!;
  assert.equal(def.manifest.personalName, 'Lucía'); assert.equal(def.manifest.name, agentsRepo(S).get(dev.id)!.config.name);
  const back = D.definitionToFiles(def);
  assert.equal(back['agent.yaml'], files['agent.yaml'], 'ida y vuelta estable');
  const { personalName: _drop, ...plain } = def.manifest;
  const noName = D.definitionToFiles({ ...def, manifest: plain as typeof def.manifest });
  assert.ok(!noName['agent.yaml']!.includes('personal_name'), 'sin nombre, sin clave');
  assert.equal(D.filesToDefinition(noName).definition!.manifest.personalName, undefined);
  const bad = D.filesToDefinition({ ...files, 'agent.yaml': files['agent.yaml']!.replace('personal_name: Lucía', 'personal_name: "Agente 007"') });
  assert.equal(bad.definition!.manifest.personalName, undefined, 'se importa sin él');
  assert.ok(bad.problems.some(p => p.path === 'agent.yaml' && !p.blocking && /personal_name/.test(p.message)));
  assert.equal(agentsRepo(S).get(dev.id)!.config.personalName, 'Lucía', 'se conserva');
});

test('cableado de la interfaz: panel, Oficina, cliente y rutas', () => {
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const panel = read('../../web/src/components/AgentPanel.tsx');
  for (const s of ['Que elija su nombre', 'Pedir otro', 'agentDisplayName']) assert.ok(panel.includes(s), `AgentPanel: falta «${s}»`);
  const office = read('../../web/src/screens/Office.tsx');
  for (const s of ['Que elijan su nombre', 'Aceptar todas']) assert.ok(office.includes(s), `Office: falta «${s}»`);
  const api = read('../../web/src/lib/osApi.ts');
  assert.ok(api.includes('/name/propose') && api.includes('names/propose'), 'osApi: clientes de las rutas');
  const routes = read('../src/routes/agentsOs.ts');
  for (const s of ['/agents/:id/name/estimate', '/agents/:id/name/propose', '/agents/names/propose', "app.put('/api/workspaces/:slug/agents/:id/name'"]) assert.ok(routes.includes(s), `rutas: falta «${s}»`);
});

// ---- Importar: el nombre propio se conserva (agente nuevo) y, si choca, se importa sin él con un aviso.
const IMPORT_GRANT = { department: 'Pruebas', scope: 'workspace' as const, projectId: null, harness: 'api' as const, model: 'claude-sonnet-4-5', provider: 'anthropic' as const, effort: 'medium' as const, tools: [] as string[], knowledge: [] as string[], autonomy: 'ask' as const, authorized: true as const, capabilities: [] };
/** Paquete exportado del agente con su id cambiado por uno nuevo: se importa como agente NUEVO. */
async function exportedAsNew(): Promise<Record<string, string>> {
  const { randomUUID } = await import('node:crypto');
  const { files } = await exportFiles(S, dev.id);
  assert.ok(files['agent.yaml']!.includes(dev.id), 'agent.yaml lleva el id del agente');
  const yaml = files['agent.yaml']!.split(dev.id).join(randomUUID());
  assert.ok(!yaml.includes(dev.id));
  return { ...files, 'agent.yaml': yaml };
}

test('importar como agente nuevo conserva el nombre propio (config.personalName y AGENTS.md)', async () => {
  assert.equal(agentsRepo(S).get(dev.id)!.config.personalName, 'Lucía');
  const files = await exportedAsNew();
  assert.match(files['agent.yaml']!, /personal_name: Lucía/);
  await N.setPersonalName(S, dev.id, null); // «Lucía» queda libre en la empresa
  const c0 = mockCalls(); const warnings: string[] = [];
  const { importFromFiles } = await import('../src/services/agentCreation.ts');
  const imported = await importFromFiles(S, files, 'prueba EN-015', IMPORT_GRANT, 'Importado en la prueba EN-015', w => { warnings.push(w); });
  assert.equal(mockCalls(), c0, 'importar no llama al modelo');
  assert.notEqual(imported.id, dev.id, 'agente nuevo');
  const a = agentsRepo(S).get(imported.id)!;
  assert.equal(a.config.personalName, 'Lucía', 'el nombre propio se conserva');
  assert.equal(a.config.name, agentsRepo(S).get(dev.id)!.config.name, 'el puesto es el del paquete');
  assert.deepEqual(warnings, [], 'sin avisos');
  const md = agentsMd(imported.id);
  assert.ok(md.startsWith(`# Lucía · ${a.config.name}`), md.slice(0, 120));
  assert.ok(md.includes('Lucía'));
});

test('importar por ZIP un nombre que choca: termina sin nombre y deja un aviso en learned.warnings', async () => {
  // La prueba anterior dejó «Lucía» en el agente importado y a dev sin nombre: dev lo recupera para que el paquete lo lleve.
  const prev = agentsRepo(S).list().find(x => x.id !== dev.id && x.config.personalName === 'Lucía');
  if (prev) await N.setPersonalName(S, prev.id, null);
  await N.setPersonalName(S, dev.id, 'Lucía');
  const files = await exportedAsNew();
  assert.match(files['agent.yaml']!, /personal_name: Lucía/, 'el paquete lleva el nombre que choca con dev');
  const { zipBuffers } = await import('../src/services/zipFile.ts');
  const { previewZipImport, applyZipImport } = await import('../src/services/agentZipImport.ts');
  const zipPath = path.join(process.env.PORTAL_DATA_DIR!, 'en015-choque.zip');
  fs.writeFileSync(zipPath, zipBuffers(Object.keys(files).map(name => ({ name, data: Buffer.from(files[name]!, 'utf8') }))));
  const c0 = mockCalls();
  const pv = previewZipImport(S, zipPath, 'en015-choque.zip');
  assert.equal(pv.mode, 'nuevo');
  const r = await applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: {}, grant: IMPORT_GRANT }, () => () => {});
  assert.equal(mockCalls(), c0, 'importar no llama al modelo');
  assert.equal(r.mode, 'nuevo');
  assert.equal(D.agentPersonalName(agentsRepo(S).get(r.agent.id)!), null, 'el nombre que choca no se guarda');
  assert.ok(r.learned.warnings.length > pv.learned.warnings.length, `aviso del nombre: ${JSON.stringify(r.learned.warnings)}`);
  assert.ok(!agentsMd(r.agent.id).includes('Te llamas'), 'AGENTS.md sin nombre propio');
  // Se restaura el estado: el agente original vuelve a llamarse Lucía cuando se libera el nombre.
  const holder = agentsRepo(S).list().find(x => x.id !== dev.id && x.config.personalName === 'Lucía');
  if (holder) await N.setPersonalName(S, holder.id, null);
  await N.setPersonalName(S, dev.id, 'Lucía');
});

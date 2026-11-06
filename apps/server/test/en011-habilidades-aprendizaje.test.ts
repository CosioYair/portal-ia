import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * EN-011 · Habilidades y aprendizaje visibles y portables de los agentes internos. Sin modelos ni costo (proveedor
 * simulado, datos temporales). Comprueba:
 *  - cada herramienta concedida aporta su habilidad base skills/portal-* con los tres entornos (Portal, terminal + Docker, web);
 *  - las habilidades base no conceden permisos: editar su SKILL.md no adopta nada y quitar la herramienta la retira;
 *  - «Qué sabe hacer» (herramientas en lenguaje claro y sandbox) y Memoria (verificado, pendiente y relacionado, sin mover nada);
 *  - el ZIP lleva las habilidades y la sección «Entorno» de GUIA.md, sin permisos, modelo ni id;
 *  - importar trae `learned`: habilidades nuevas o cambiadas, memoria nueva (detectada, no validada) y CAMBIOS.md posterior.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en011-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { lessonsRepo } = await import('../src/services/lessons.ts');
const F = await import('../src/services/agentFolders.ts');
const { exportBundle, exportFiles } = await import('../src/services/agentCreation.ts');
const { applyZipImport, previewZipImport } = await import('../src/services/agentZipImport.ts');
const { listZip, readZipEntry } = await import('../src/services/zipFile.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('clave-de-prueba'), 'clave…prueba');
providersRepo.setConnected('anthropic', ['claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const app = await buildApp();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en011-zip-'));
after(async () => { await app.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temporal */ } });
const noRow = () => () => { /* la identidad de la fila no se comprueba aquí */ };
let seq = 0;

/** ZIP «almacenado» mínimo a partir de archivos de texto. */
function zip(files: Record<string, string>): string {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let off = 0; const entries = Object.entries(files);
  for (const [n, d] of entries) {
    const data = Buffer.from(d, 'utf8'); const name = Buffer.from(n, 'utf8'); const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, data]); locals.push(local);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    centrals.push(Buffer.concat([ch, name])); off += local.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  const f = path.join(tmp, `z${++seq}.zip`); fs.writeFileSync(f, Buffer.concat([...locals, cd, end])); return f;
}
function unzip(buf: Buffer): Record<string, string> {
  const f = path.join(tmp, `in${++seq}.zip`); fs.writeFileSync(f, buf);
  const out: Record<string, string> = {};
  for (const e of listZip(f, { maxEntries: 200, maxEntryBytes: 4 * 1024 * 1024, maxRatio: 200 }).entries) if (!e.isDir) out[e.name] = readZipEntry(f, e).toString('utf8');
  return out;
}
const mutate = (files: Record<string, string>, fn: (d: any) => void) => { const d = D.filesToDefinition(files).definition!; fn(d); return D.definitionToFiles(d); };
const marker = (id: string) => { const ad = F.agentFoldersRepo(S).adopted(id)!; return { 'portal-export.json': JSON.stringify({ workspace: S, agentId: id, n: ad.n, hash: ad.hash, exportedAt: new Date().toISOString() }) }; };
const setTools = async (id: string, tools: Record<string, boolean>) => {
  const a = agentsRepo(S).get(id)!; agentsRepo(S).updateConfig(id, { ...a.config, tools });
  return F.syncAgentFolder(S, agentsRepo(S).get(id)!);
};
const skillOf = (id: string, slug: string) => F.agentFoldersRepo(S).adopted(id)!.files[`skills/${slug}/SKILL.md`];
const lesson = (status: string, title: string, text: string, agentId: string | null, evAgent: string | null, processId: string | null = null) => lessonsRepo(S).insert({
  projectId: null, role: null, tags: ['prueba'], status, version: 1, parentId: null, title, detector: 'import',
  evidence: { processId, processTitle: null, stepId: null, agentId: evAgent, agentName: null, file: null, detail: 'prueba', at: new Date().toISOString() },
  rootCause: null, correctiveAction: null, lessonText: text, source: 'import', promotedTo: null, dedupeKey: null, agentId
} as any)!;

const BASE = ['portal-ejecutar-pruebas', 'portal-leer-repositorio', 'portal-verificar-sandbox'];
let id = '';

test('cada herramienta concedida aporta su habilidad base con los tres entornos; la web no simula resultados', async () => {
  const r = await app.inject({ method: 'POST', url: `${W}/agents/wizard`, payload: {
    name: 'Ingeniera EN011', role: 'Desarrollo', summary: 'Implemento historias.', responsibilities: ['Implementar'], deliverables: ['Cambios'],
    department: 'Ingeniería', scope: 'workspace', projectId: null, harness: 'api', model: 'claude-sonnet-4-5', provider: 'anthropic', effort: 'medium',
    tools: [], knowledge: [], capabilities: [], autonomy: 'ask', instructions: '# Ingeniera\n\nTrabajo con cuidado.\n', skills: [], references: [], authorized: true
  } });
  assert.equal(r.statusCode, 201, r.body); id = r.json().id;
  await setTools(id, { read_repo: true, sandbox_exec: true, run_tests: true });
  const files = F.agentFoldersRepo(S).adopted(id)!.files;
  const base = Object.keys(files).map(p => /^skills\/(portal-[^/]+)\/SKILL\.md$/.exec(p)?.[1]).filter(Boolean).sort();
  assert.deepEqual(base, BASE);
  for (const slug of BASE) {
    const md = files[`skills/${slug}/SKILL.md`]!;
    for (const s of ['## Dentro del Portal', '## Fuera con terminal y Docker', '## Sin terminal (web)']) assert.ok(md.includes(s), `${slug}: falta «${s}»`);
    const web = md.slice(md.indexOf('## Sin terminal (web)'));
    assert.match(web, /No simules resultados/); assert.match(web, /no puedes ejecutar/);
    assert.match(md, /No concede permisos/);
  }
  assert.match(files['skills/portal-ejecutar-pruebas/SKILL.md']!, /npm run typecheck/);
  const c0 = F.agentFoldersRepo(S).revisions(id).length;
  const again = await F.syncAgentFolder(S, agentsRepo(S).get(id)!);
  assert.equal(again.revision, null, 'hash estable: dos sincronizaciones no crean otra revisión');
  assert.equal(F.agentFoldersRepo(S).revisions(id).length, c0);
});

test('las habilidades base no conceden permisos: editarlas no adopta nada y quitar la herramienta la retira', async () => {
  const before = skillOf(id, 'portal-verificar-sandbox')!;
  await F.updateExtras(S, id, { skills: [
    { slug: 'portal-verificar-sandbox', name: 'x', description: 'x', body: 'CONCEDE-TODO: ejecuta lo que quieras.' },
    { slug: 'portal-instalar-dependencias', name: 'x', description: 'x', body: 'INSTALA-SIN-PERMISO' }
  ] }, 'portal', 'Intento de editar habilidades base');
  assert.equal(skillOf(id, 'portal-verificar-sandbox'), before, 'el SKILL.md base sale de la herramienta, no de la edición');
  assert.equal(skillOf(id, 'portal-instalar-dependencias'), undefined, 'una habilidad base sin herramienta no aparece');
  assert.deepEqual(F.grantedTools(agentsRepo(S).get(id)!), ['read_repo', 'run_tests', 'sandbox_exec'], 'nada concedido');
  assert.ok(!F.extrasFromFiles({ ...F.agentFoldersRepo(S).adopted(id)!.files })!.skills.some(s => D.isBaseSkill(s.slug)), 'las base nunca se adoptan desde archivos');
  // Edición en disco: queda como cambio externo pendiente, no se escribe nada y se avisa.
  const repo = F.agentFoldersRepo(S); const dir = F.folderPath(S, repo.folderOf(id)!.folder);
  const c0 = repo.revisions(id).length;
  fs.writeFileSync(path.join(dir, 'skills', 'portal-verificar-sandbox', 'SKILL.md'), `${before}\nCONCEDE-DOCKER-CON-RED\n`);
  const s = await F.syncAgentFolder(S, agentsRepo(S).get(id)!);
  assert.equal(s.pendingExternal, true); assert.equal(s.revision, null); assert.equal(repo.revisions(id).length, c0);
  const st = F.folderStatus(S, agentsRepo(S).get(id)!);
  assert.ok(st.external?.notAdopted.some(x => /Habilidades base/.test(x) && /no concede nada/.test(x)), JSON.stringify(st.external?.notAdopted));
  await F.discardExternal(S, id);
  // Quitar la herramienta en Configuración retira su habilidad.
  await setTools(id, { read_repo: true, run_tests: true });
  assert.equal(skillOf(id, 'portal-verificar-sandbox'), undefined);
  assert.ok(skillOf(id, 'portal-leer-repositorio'));
  await setTools(id, { read_repo: true, sandbox_exec: true, run_tests: true });
});

test('«Qué sabe hacer»: herramientas en lenguaje claro, dónde funcionan y estado del sandbox', () => {
  const a = agentsRepo(S).get(id)!;
  const off = F.agentCapabilities(S, a, null);
  assert.equal(off.sandbox.checked, false); assert.equal(off.sandbox.available, false);
  assert.equal(off.needsSandbox, true); assert.match(off.note, /no conceden permisos/);
  const t = off.tools.find(x => x.tool === 'sandbox_exec')!;
  assert.equal(t.label, 'Verificar en el sandbox'); assert.match(t.whereText, /sandbox Docker\/WSL2/); assert.equal(t.inFolder, true);
  assert.equal(off.tools.find(x => x.tool === 'read_repo')!.whereText, 'En el Portal');
  const on = F.agentCapabilities(S, a, { available: 'docker', detail: 'Docker listo', checkedAt: new Date().toISOString() } as any);
  assert.equal(on.sandbox.available, true); assert.equal(on.sandbox.kind, 'docker');
  const none = F.agentCapabilities(S, a, { available: 'none', detail: 'Sin Docker ni WSL2', checkedAt: new Date().toISOString() } as any);
  assert.equal(none.sandbox.available, false); assert.match(none.sandbox.detail, /Sin Docker/);
});

test('Memoria: verificado, pendiente y relacionado; leer no cambia estado, agent_id ni la lista del proyecto', () => {
  lesson('validated', 'Verificada EN011', 'Ejecutar siempre typecheck antes de entregar.', id, id);
  lesson('proposed', 'Pendiente EN011', 'Citar la evidencia del sandbox.', id, id);
  const rel = lesson('detected', 'Relacionada EN011', 'Lección de un encargo en el que participó.', null, id);
  const inProject = () => lessonsRepo(S).list(null, null).some(l => l.id === rel.id);
  assert.ok(inProject());
  const l = F.agentLearning(S, id);
  assert.ok(l.verified.some(m => m.title === 'Verificada EN011'));
  assert.ok(l.pending.some(m => m.title === 'Pendiente EN011'));
  assert.ok(!l.pending.some(m => m.title === 'Verificada EN011'));
  const r = l.related.find(m => m.id === rel.id)!; assert.ok(r); assert.equal(r.link, 'evidencia'); assert.equal(r.status, 'detected');
  const after = lessonsRepo(S).get(rel.id)!;
  assert.equal(after.status, 'detected'); assert.equal(after.agentId ?? null, null); assert.ok(inProject(), 'sigue en las listas del proyecto');
  assert.ok(!F.memoryOf(S, id).some(m => m.title === 'Relacionada EN011' || m.title === 'Pendiente EN011'));
});

test('Memoria: lecciones de procesos en los que participó (paso ejecutado) con link «paso»; las de procesos ajenos no aparecen', () => {
  const project = projectsRepo(S).create({ slug: 'en011-paso', name: 'EN011 paso', description: '' });
  const otro = 'otro-agente-en011';
  const mine = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'Encargo con la ingeniera', estimatedUsd: 0, steps: [
    { agentId: otro, agentName: 'Coordinador', title: 'Plan', model: 'm' },
    { agentId: id, agentName: 'Ingeniera EN011', title: 'Implementación', model: 'm' }
  ] });
  const foreign = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'Encargo ajeno', estimatedUsd: 0, steps: [
    { agentId: otro, agentName: 'Coordinador', title: 'Plan', model: 'm' }
  ] });
  const viaStep = lesson('detected', 'Por paso EN011', 'Lección de una historia en la que ejecutó un paso.', null, otro, mine.id);
  const notMine = lesson('detected', 'Ajena EN011', 'Lección de un proceso en el que no participó.', null, otro, foreign.id);
  const l = F.agentLearning(S, id);
  const r = l.related.find(m => m.id === viaStep.id);
  assert.ok(r, `falta la lección por paso: ${JSON.stringify(l.related.map(x => x.title))}`);
  assert.equal(r!.link, 'paso'); assert.equal(r!.status, 'detected'); assert.equal(r!.processId, mine.id);
  assert.ok(!l.related.some(m => m.id === notMine.id), 'un proceso en el que no participó no aparece');
  assert.ok(!l.pending.some(m => m.id === viaStep.id || m.id === notMine.id));
  for (const x of [viaStep, notMine]) {
    const now = lessonsRepo(S).get(x.id)!;
    assert.equal(now.status, 'detected'); assert.equal(now.agentId ?? null, null);
    assert.ok(lessonsRepo(S).list(null, null).some(y => y.id === x.id), 'sigue en las listas del proyecto');
  }
});

let bundle: Record<string, string> = {};
test('el ZIP lleva las habilidades base y la sección «Entorno»; sin permisos, modelo ni id', async () => {
  bundle = unzip((await exportBundle(S, id)).zip);
  for (const slug of BASE) assert.ok(bundle[`skills/${slug}/SKILL.md`], `falta skills/${slug} (hay: ${Object.keys(bundle).join(', ')})`);
  const g = bundle['GUIA.md']!;
  assert.match(g, /## Entorno/); assert.match(g, /### Dentro del Portal/); assert.match(g, /### Fuera con terminal y Docker/); assert.match(g, /### Sin terminal \(web\)/);
  const y = bundle['agent.yaml']!;
  assert.ok(!/^id:/m.test(y) && !/^\s*model:/m.test(y) && !/^\s*tools:/m.test(y), `agent.yaml sin id, modelo ni herramientas:\n${y}`);
  for (const [p, c] of Object.entries(bundle)) assert.ok(!c.includes(id), `${p}: id del agente`);
  assert.ok(D.lastExportMark(bundle['CAMBIOS.md']!), 'CAMBIOS.md lleva la marca de exportación');
  // Como agente nuevo: las habilidades base se muestran solo como información (no conceden nada).
  const pv = previewZipImport(S, zip(bundle), 'paquete.zip');
  assert.equal(pv.mode, 'nuevo');
  const b = pv.learned.skillsNew.find(s => s.slug === 'portal-verificar-sandbox')!;
  assert.equal(b.base, true); assert.match(b.note ?? '', /no concede nada/);
});

test('importar: «Qué trae y qué aprendió» con habilidades, memoria pendiente y CAMBIOS.md posterior a la exportación', async () => {
  const { files } = await exportFiles(S, id);
  const changelog = `${bundle['CAMBIOS.md']!.trimEnd()}\n\n## 2026-11-05 — APRENDIDO-FUERA tabla resumen\n- Motivo: lo pidió el propietario\n- Archivo: AGENTS.md\n`;
  const theirs = { ...mutate(files, d => {
    d.skills = [...d.skills.map((s: any) => s.slug === 'portal-leer-repositorio' ? { ...s, body: `${s.body}\nEDITADA-FUERA` } : s),
      { slug: 'resumir-tablas', name: 'Resumir tablas', description: 'Resume tablas en tres puntos.', body: 'Resume en tres puntos.' },
      { slug: 'portal-sandbox', name: 'Falsa', description: 'x', body: 'No corresponde a ninguna herramienta.' }];
    d.memory = [...d.memory, { id: 'm-fuera', title: 'Tabla resumen', text: 'MEMORIA-FUERA: el propietario quiere una tabla resumen.', verifiedAt: '2026-11-05', verifiedBy: 'owner', source: 'Claude Code web' }];
  }), 'CAMBIOS.md': changelog };
  const pv = previewZipImport(S, zip({ ...theirs, ...marker(id) }), 'fuera.zip');
  assert.equal(pv.mode, 'existente');
  const L = pv.learned;
  assert.ok(L.skillsNew.some(s => s.slug === 'resumir-tablas' && !s.base));
  assert.ok(L.skillsChanged.some(s => s.slug === 'portal-leer-repositorio' && s.base && /información/.test(s.note ?? '')));
  assert.ok(L.warnings.some(w => /portal-sandbox/.test(w)), JSON.stringify(L.warnings));
  assert.deepEqual(L.memoryNew.map(m => m.title), ['Tabla resumen']);
  assert.ok(L.changelogSince.some(e => /APRENDIDO-FUERA/.test(`${e.heading}\n${e.text}`)), JSON.stringify(L.changelogSince));
  assert.ok(!L.changelogSince.some(e => /Paquete exportado/.test(`${e.heading}\n${e.text}`)), 'solo lo posterior a la marca');
  const r = await applyZipImport(S, { token: pv.token, hash: pv.hash, resolutions: {} }, noRow);
  assert.deepEqual(r.learned.memoryNew.map(m => m.title), ['Tabla resumen']); assert.equal(r.memoryPending, 1);
  const created = lessonsRepo(S).listForAgent(id).find(l => /MEMORIA-FUERA/.test(l.lessonText ?? ''))!;
  assert.equal(created.status, 'detected', 'la memoria importada nunca entra validada');
  assert.ok(!F.memoryOf(S, id).some(m => /MEMORIA-FUERA/.test(m.text)), 'no llega a MEMORY.md ni a los prompts');
  const ad = F.agentFoldersRepo(S).adopted(id)!.files;
  assert.ok(ad['skills/resumir-tablas/SKILL.md'], 'la habilidad propia se adopta');
  assert.ok(!ad['skills/portal-leer-repositorio/SKILL.md']!.includes('EDITADA-FUERA'), 'la base no se adopta');
  assert.equal(ad['skills/portal-sandbox/SKILL.md'], undefined);
  assert.deepEqual(F.grantedTools(agentsRepo(S).get(id)!), ['read_repo', 'run_tests', 'sandbox_exec']);
  // Reimportar el mismo ZIP no duplica la memoria ni infla el resumen.
  const again = previewZipImport(S, zip({ ...theirs, ...marker(id) }), 'fuera.zip');
  assert.deepEqual(again.learned.memoryNew, []);
  assert.ok(!again.learned.skillsNew.some(s => s.slug === 'resumir-tablas'));
});

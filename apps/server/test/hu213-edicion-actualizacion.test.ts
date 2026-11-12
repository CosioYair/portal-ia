import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingTemplate } from '../src/services/editionUpdate.ts';

/**
 * HU-213 · Actualizar una Edición con vuelta atrás (sin IA, datos temporales). Comprueba:
 *  - datos 0.18 con programa 0.19 → copia en backups/<fecha>_antes-de-0.19 con las bases y marcador 0.19;
 *  - datos 0.99 con programa 0.19 → bloqueo con motivo que nombra las dos versiones, sin escribir nada;
 *  - se añaden las clave@K que faltan y ningún agente (fijado o no) cambia su template_version;
 *  - fusión a tres bandas sin choque → versión siguiente; con choque → conflicto y no se crea nada;
 *  - swapDist conserva la interfaz anterior en dist.prev y rollback la restaura.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu213-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { workspaceDb } = await import('../src/db/workspace.ts');
const { DATA_SCHEMA_VERSION, backupDataBeforeMigration, compareSchemaVersion, schemaGuard } = await import('../src/config.ts');
const { templatesRepo, isPinned } = await import('../src/services/agentTemplates.ts');
const { applyTemplateUpdates, rollback, swapDist, updateEdition, EDITION_TEMPLATES_FILE } = await import('../src/services/editionUpdate.ts');

providersRepo.setCredential('anthropic', encryptSecret('clave-de-prueba'), 'clave…prueba');
providersRepo.setConnected('anthropic', ['claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `pia-hu213-${p}-`));
const dataWith = (marker: string | null) => {
  const d = tmp('data');
  if (marker !== null) fs.writeFileSync(path.join(d, '.schema-version'), marker);
  fs.writeFileSync(path.join(d, 'platform.sqlite'), 'base');
  return d;
};
const edition = (schema: string, html: string, templates?: IncomingTemplate[]) => {
  const r = tmp('nueva');
  fs.mkdirSync(path.join(r, 'apps', 'server', 'src'), { recursive: true });
  fs.writeFileSync(path.join(r, 'apps', 'server', 'src', 'config.ts'), `export const DATA_SCHEMA_VERSION = '${schema}';\n`);
  fs.mkdirSync(path.join(r, 'apps', 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(r, 'apps', 'web', 'dist', 'index.html'), html);
  fs.writeFileSync(path.join(r, 'apps', 'web', 'dist', 'build-info.json'), JSON.stringify({ commit: `c-${html}` }));
  if (templates) fs.writeFileSync(path.join(r, EDITION_TEMPLATES_FILE), JSON.stringify(templates));
  return r;
};
const installed = (html: string) => {
  const r = tmp('instalada');
  fs.mkdirSync(path.join(r, 'apps', 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(r, 'apps', 'web', 'dist', 'index.html'), html);
  return r;
};
const html = (root: string, dir = 'dist') => fs.readFileSync(path.join(root, 'apps', 'web', dir, 'index.html'), 'utf8');
const tpl = (key: string, version: number, role: string, resp: string[]): IncomingTemplate => ({
  key, version, name: `Plantilla ${key}`, role, responsibilities: resp, practices: [], diffMd: '', source: 'edition-update', lessonId: null, createdBy: 'studio'
});
const agentRows = () => workspaceDb(S).prepare('SELECT id, template_version AS tv FROM agents ORDER BY id').all() as { id: string; tv: string | null }[];

test('compareSchemaVersion compara por números y tolera BOM y saltos de línea', () => {
  assert.equal(compareSchemaVersion('0.19', '0.9'), 1);
  assert.equal(compareSchemaVersion('0.18', '0.19'), -1);
  assert.equal(compareSchemaVersion('\uFEFF0.19\r\n', '0.19'), 0);
  assert.equal(DATA_SCHEMA_VERSION, '0.19');
});

test('datos 0.18 con programa 0.19: copia previa con las bases y marcador 0.19', () => {
  const d = dataWith('0.18');
  assert.equal(schemaGuard(d, '0.19').state, 'migrar');
  const dest = backupDataBeforeMigration(d, '0.19');
  assert.ok(dest);
  assert.match(path.basename(dest), /_antes-de-0\.19$/);
  assert.equal(path.dirname(dest), path.join(d, 'backups'));
  assert.ok(fs.existsSync(path.join(dest, 'platform.sqlite')));
  assert.equal(fs.readFileSync(path.join(d, '.schema-version'), 'utf8'), '0.19');
  assert.equal(backupDataBeforeMigration(d, '0.19'), null, 'con la misma versión no se copia otra vez');
});

test('datos 0.99 con programa 0.19: bloqueo con motivo, sin escribir nada', () => {
  const d = dataWith('0.99');
  const before = fs.readFileSync(path.join(d, '.schema-version'));
  const g = schemaGuard(d, '0.19');
  assert.equal(g.state, 'mas-nuevo');
  assert.match(g.reason ?? '', /0\.99/); assert.match(g.reason ?? '', /0\.19/);
  assert.throws(() => backupDataBeforeMigration(d, '0.19'), (e: any) => e.code === 'schema_newer' && /0\.99/.test(e.message) && /0\.19/.test(e.message));
  const root = installed('v1');
  const r = updateEdition({ root, newRoot: edition('0.19', 'v2', [tpl('hu213-bloq', 1, 'x', ['a'])]), dataDir: d, slugs: [S] });
  assert.equal(r.blocked, true);
  assert.match(r.reason ?? '', /0\.99/); assert.match(r.reason ?? '', /0\.19/);
  assert.equal(r.backup, null);
  assert.ok(fs.readFileSync(path.join(d, '.schema-version')).equals(before), 'el marcador no cambia ni un byte');
  assert.equal(fs.existsSync(path.join(d, 'backups')), false);
  assert.equal(html(root), 'v1');
  assert.equal(fs.existsSync(path.join(root, 'apps', 'web', 'dist.prev')), false);
  assert.equal(templatesRepo(S).versions('hu213-bloq').length, 0);
});

test('añade clave@K que faltan y ningún agente cambia su template_version (fijado incluido)', () => {
  const rows = agentRows();
  assert.ok(rows.length >= 2, 'el arranque crea agentes');
  const [pinned, free] = rows;
  const repo = templatesRepo(S);
  repo.setAgentVersion(pinned!.id, null, 'pj-dev@3', 'portal');
  repo.setAgentVersion(pinned!.id, 'pj-dev@3', 'pj-dev@1', 'owner');
  assert.equal(isPinned(S, pinned!.id), true);
  const before = agentRows();
  const r = applyTemplateUpdates(S, [tpl('hu213-k', 1, 'Rol', ['a']), tpl('hu213-k', 2, 'Rol', ['a', 'b'])]);
  assert.deepEqual(r.added, ['hu213-k@1', 'hu213-k@2']);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(repo.versions('hu213-k').map(v => v.version), [1, 2]);
  assert.deepEqual(agentRows(), before, 'no se modifica ningún agente');
  assert.equal(before.find(a => a.id === free!.id)?.tv ?? null, rows.find(a => a.id === free!.id)?.tv ?? null);
  const again = applyTemplateUpdates(S, [tpl('hu213-k', 1, 'Rol', ['a']), tpl('hu213-k', 2, 'Rol', ['a', 'b'])]);
  assert.deepEqual(again.added, [], 'repetir no añade nada');
});

test('fusión a tres bandas: sin choque crea la versión siguiente; con choque es conflicto y no crea nada', () => {
  const repo = templatesRepo(S);
  repo.insert(tpl('hu213-m', 1, 'Rol base', ['a']));
  repo.insert(tpl('hu213-m', 2, 'Rol local', ['a']));
  const ok = applyTemplateUpdates(S, [tpl('hu213-m', 1, 'Rol base', ['a']), tpl('hu213-m', 2, 'Rol base', ['a', 'b'])]);
  assert.deepEqual(ok.conflicts, []);
  assert.deepEqual(ok.added, ['hu213-m@3']);
  const v3 = repo.get('hu213-m', 3)!;
  assert.equal(v3.role, 'Rol local');
  assert.deepEqual(v3.responsibilities, ['a', 'b']);
  assert.equal(v3.source, 'edition-update');

  repo.insert(tpl('hu213-c', 1, 'Rol base', ['a']));
  repo.insert(tpl('hu213-c', 2, 'Rol de la Edición', ['a']));
  const before = agentRows();
  const bad = applyTemplateUpdates(S, [tpl('hu213-c', 1, 'Rol base', ['a']), tpl('hu213-c', 2, 'Rol del Estudio', ['a'])]);
  assert.deepEqual(bad.added, []);
  assert.equal(bad.conflicts.length, 1);
  assert.equal(bad.conflicts[0]!.key, 'hu213-c');
  assert.ok(bad.conflicts[0]!.paths.includes('role.txt'));
  assert.equal(repo.get('hu213-c', 3), undefined, 'no pisa ni crea nada');
  assert.equal(repo.get('hu213-c', 2)!.role, 'Rol de la Edición');
  assert.deepEqual(agentRows(), before);
});

test('swapDist conserva dist.prev y rollback la restaura', () => {
  const root = installed('v1');
  assert.equal(swapDist(root, path.join(edition('0.19', 'v2'), 'apps', 'web', 'dist')), path.join(root, 'apps', 'web', 'dist.prev'));
  assert.equal(html(root), 'v2'); assert.equal(html(root, 'dist.prev'), 'v1');
  swapDist(root, path.join(edition('0.19', 'v3'), 'apps', 'web', 'dist'));
  assert.equal(html(root), 'v3'); assert.equal(html(root, 'dist.prev'), 'v2');
  const d = dataWith('0.18'); backupDataBeforeMigration(d, '0.19');
  const r = rollback(root, d);
  assert.equal(html(root), 'v2');
  assert.match(path.basename(r.backup ?? ''), /_antes-de-0\.19$/);
  assert.equal(fs.existsSync(path.join(root, 'apps', 'web', 'dist.prev')), false);
  assert.throws(() => rollback(root, d), (e: any) => e.statusCode === 404);
});

test('updateEdition completo: copia, plantillas, fijados intactos, dist.prev; repetir dice «ya actualizada»', () => {
  const d = dataWith('0.18');
  const root = installed('v1');
  const newRoot = edition('0.19', 'v2', [tpl('hu213-e', 1, 'Rol', ['a'])]);
  const pinnedBefore = agentRows().filter(a => isPinned(S, a.id)).map(a => `${S}:${a.id}`);
  const r = updateEdition({ root, newRoot, dataDir: d, slugs: [S] });
  assert.equal(r.blocked, false);
  assert.ok(r.backup && fs.existsSync(path.join(r.backup, 'platform.sqlite')));
  assert.equal(fs.readFileSync(path.join(d, '.schema-version'), 'utf8'), '0.19');
  assert.deepEqual(r.templatesAdded, [`${S}:hu213-e@1`]);
  assert.deepEqual(r.pinnedUntouched, pinnedBefore);
  assert.ok(pinnedBefore.length >= 1);
  assert.equal(r.distPrev, path.join(root, 'apps', 'web', 'dist.prev'));
  assert.equal(html(root), 'v2'); assert.equal(html(root, 'dist.prev'), 'v1');
  const backups = fs.readdirSync(path.join(d, 'backups')).length;
  const again = updateEdition({ root, newRoot, dataDir: d, slugs: [S] });
  assert.equal(again.upToDate, true);
  assert.equal(fs.readdirSync(path.join(d, 'backups')).length, backups, 'sin copia nueva');
});

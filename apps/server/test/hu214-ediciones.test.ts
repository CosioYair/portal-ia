import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * HU-214 · Módulo «Ediciones»: transiciones, autorización obligatoria del propietario (403 sin `authorized: true`, sin
 * cambios), generación con buildEditionZip y git simulados (sin red ni IA), revocación definitiva y cableado de la UI y de
 * la verificación visual. Proveedor simulado (0 USD).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu214-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, canTransition, INTERNAL_WORKSPACE, EDITION_ACTIONS } = await import('@portal-ia/domain');
const ai = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const reg = await import('../src/services/editionRegistry.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
const S = runBootstrap().workspace.slug;
const W = `/api/workspaces/${S}/editions`;
const app = await buildApp();
after(async () => { await app.close(); });
const inject = async (method: string, u: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url: u, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, '../../web/src');
const HEAD = 'a'.repeat(40);

function fakeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu214-repo-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'portal-ia', version: '9.8.7' }));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu214-out-'));
  const calls: any[] = [];
  const build = (async (o: any) => { calls.push(o); fs.writeFileSync(o.outFile, 'zip'); return { outFile: o.outFile, sha256: 'f'.repeat(64), entries: 12, bytes: 3456, commit: o.expectedCommit }; }) as any;
  const git = (args: string[]) => args[0] === 'status' ? '' : `${HEAD}\n`;
  return { env: { root, webDist: path.join(root, 'dist'), dataDir: process.env.PORTAL_DATA_DIR!, outDir, git, build, distributable: false }, calls };
}

test('HU-214 · canTransition: generar solo sin edición, activar/desactivar según estado y revocada es definitiva', () => {
  assert.equal(canTransition(null, 'generate'), true);
  assert.equal(canTransition('active', 'generate'), false);
  for (const a of ['renew', 'activate', 'deactivate', 'revoke'] as const) assert.equal(canTransition(null, a), false, `sin edición no se puede ${a}`);
  assert.equal(canTransition('active', 'deactivate'), true);
  assert.equal(canTransition('active', 'activate'), false);
  assert.equal(canTransition('inactive', 'activate'), true);
  assert.equal(canTransition('inactive', 'deactivate'), false);
  assert.equal(canTransition('active', 'renew'), true);
  assert.equal(canTransition('inactive', 'revoke'), true);
  for (const a of EDITION_ACTIONS) assert.equal(canTransition('revoked', a), false, `revocada no admite ${a}`);
});

test('HU-214 · lista vacía al principio y solo en el núcleo (otra empresa → 404)', async () => {
  assert.equal(S, INTERNAL_WORKSPACE.slug);
  const r = await inject('GET', W);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
  const other = await inject('GET', '/api/workspaces/otra-empresa/editions');
  assert.equal(other.status, 404);
});

test('HU-214 · sin autorización: 403 en generar y en cada acción, y no cambia nada', async () => {
  ai.resetMockCalls();
  const { env, calls } = fakeEnv();
  await assert.rejects(reg.generateEdition(S, false, env), (e: any) => e?.name === 'PolicyError' || /autorizaci/i.test(e?.message));
  assert.equal(calls.length, 0, 'sin autorización no se empaqueta nada');
  assert.equal(reg.listEditions(S).length, 0);

  const gen = await inject('POST', W, {});
  assert.equal(gen.status, 403, 'POST sin authorized:true responde 403');
  const genFalse = await inject('POST', W, { authorized: false });
  assert.equal(genFalse.status, 403);
  assert.equal(reg.listEditions(S).length, 0, 'no se ha creado ninguna edición');

  const ed = await reg.generateEdition(S, true, env);
  const before = JSON.stringify(reg.getEdition(S, ed.id));
  for (const a of ['renew', 'activate', 'deactivate', 'revoke']) {
    const r = await inject('POST', `${W}/${ed.id}/${a}`, {});
    assert.equal(r.status, 403, `${a} sin autorización → 403`);
  }
  assert.throws(() => reg.renewEdition(S, ed.id, false, { distributable: false }));
  assert.throws(() => reg.revokeEdition(S, ed.id, false, { distributable: false }));
  assert.equal(JSON.stringify(reg.getEdition(S, ed.id)), before, 'la edición sigue exactamente igual');
  assert.equal(ai.mockCalls, 0, 'ninguna acción llama a la IA');
});

test('HU-214 · generar usa buildEditionZip con expectedCommit = HEAD y guarda versión, commit y sha256', async () => {
  const { env, calls } = fakeEnv();
  const ed = await reg.generateEdition(S, true, env);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedCommit, HEAD);
  assert.match(path.basename(calls[0].outFile), /^portal-ia-edicion-9\.8\.7-aaaaaaa\.zip$/);
  assert.equal(ed.version, '9.8.7');
  assert.equal(ed.commit, HEAD);
  assert.equal(ed.sha256, 'f'.repeat(64));
  assert.equal(ed.license.status, 'active');
  assert.equal(ed.license.renewals, 0);
  assert.ok(Date.parse(ed.license.expiresAt) > Date.parse(ed.license.issuedAt));
  assert.ok(reg.listEditions(S).some(x => x.id === ed.id));

  const dirty = fakeEnv();
  dirty.env.git = (args: string[]) => args[0] === 'status' ? ' M apps/web/src/App.tsx\n' : `${HEAD}\n`;
  await assert.rejects(reg.generateEdition(S, true, dirty.env));
  assert.equal(dirty.calls.length, 0, 'con cambios sin confirmar no se empaqueta');

  await assert.rejects(reg.generateEdition(S, true, { ...fakeEnv().env, distributable: true }), (e: any) => e?.statusCode === 403);
});

test('HU-214 · renovar, desactivar, activar y revocar; una edición revocada no se reactiva ni se renueva', async () => {
  const { env } = fakeEnv();
  const ed = await reg.generateEdition(S, true, env);
  const o = { distributable: false };
  const renewed = reg.renewEdition(S, ed.id, true, o);
  assert.equal(renewed.license.renewals, 1);
  assert.ok(Date.parse(renewed.license.expiresAt) > Date.parse(ed.license.expiresAt), 'renovar amplía la caducidad');
  assert.equal(reg.setEditionActive(S, ed.id, false, true, o).license.status, 'inactive');
  assert.equal(reg.setEditionActive(S, ed.id, true, true, o).license.status, 'active');
  assert.equal(reg.revokeEdition(S, ed.id, true, o).license.status, 'revoked');
  assert.throws(() => reg.setEditionActive(S, ed.id, true, true, o), (e: any) => e?.statusCode === 409);
  assert.throws(() => reg.renewEdition(S, ed.id, true, o), (e: any) => e?.statusCode === 409);
  assert.throws(() => reg.revokeEdition(S, ed.id, true, o), (e: any) => e?.statusCode === 409);
  assert.equal(reg.getEdition(S, ed.id)!.license.status, 'revoked');
  assert.throws(() => reg.renewEdition(S, 'no-existe', true, o), (e: any) => e?.statusCode === 404);
});

test('HU-214 · auditoría: cada intento queda en execution_history como policy:edition-<acción>:granted|denied', async () => {
  const { workspaceDb } = await import('../src/db/workspace.ts');
  const audit = () => (workspaceDb(S).prepare(`SELECT kind, status FROM execution_history WHERE kind LIKE 'policy:edition-%' ORDER BY rowid`).all() as any[]).map(r => ({ kind: String(r.kind), status: String(r.status) }));
  const before = audit().length;
  const { env } = fakeEnv();
  const o = { distributable: false };
  const ed = await reg.generateEdition(S, true, env);
  reg.renewEdition(S, ed.id, true, o);
  assert.throws(() => reg.renewEdition(S, ed.id, false, o), (e: any) => e?.name === 'PolicyError' || /autorizaci/i.test(e?.message));
  const snapshot = JSON.stringify(reg.getEdition(S, ed.id));
  reg.revokeEdition(S, ed.id, true, o);
  const rows = audit().slice(before);
  const kinds = rows.map(r => r.kind);
  assert.deepEqual(kinds, [
    'policy:edition-generate:granted',
    'policy:edition-renew:granted',
    'policy:edition-renew:denied:sin_autorizacion',
    'policy:edition-revoke:granted'
  ], 'un registro por intento, en orden');
  assert.equal(rows.find(r => r.kind === 'policy:edition-generate:granted')?.status, 'done');
  assert.equal(rows.find(r => r.kind === 'policy:edition-revoke:granted')?.status, 'done');
  assert.equal(rows.find(r => r.kind === 'policy:edition-renew:denied:sin_autorizacion')?.status, 'failed');
  assert.notEqual(snapshot, JSON.stringify(reg.getEdition(S, ed.id)), 'la revocación autorizada sí se aplicó');
  assert.equal(reg.getEdition(S, ed.id)!.license.renewals, 1, 'la renovación denegada no cambió nada');
});

test('HU-214 · interfaz: ruta /ediciones en App.tsx, diálogo de autorización y authorized:true en la pantalla', () => {
  const appSrc = fs.readFileSync(path.join(webSrc, 'App.tsx'), 'utf8');
  assert.match(appSrc, /import\('\.\/screens\/Editions\.tsx'\)/);
  assert.match(appSrc, /<Route path="\/ediciones" element=\{company\(<Editions \/>\)\} \/>/);
  const screen = fs.readFileSync(path.join(webSrc, 'screens', 'Editions.tsx'), 'utf8');
  assert.match(screen, /import \{ Modal \} from '\.\.\/components\/Modal\.tsx';/, 'usa el Modal compartido (foco atrapado y devuelto)');
  assert.match(screen, /<Modal\b/);
  assert.doesNotMatch(screen, /modal-backdrop|row-actions/, 'sin clases que no existen en el CSS');
  assert.match(screen, /Autorizar y /);
  assert.match(screen, /authorized: true/);
  assert.match(screen, /Autorización del propietario/);
  assert.match(screen, /irreversible/);
  assert.match(screen, /Aún no hay ediciones/, 'estado vacío claro');
  assert.match(screen, /!distributable &&/, 'sin acciones en la edición distribuible');
});

test('HU-214 · verificación visual: Editions.tsx → /ediciones antes de los comodines, y App.tsx la incluye', () => {
  const map = JSON.parse(fs.readFileSync(path.resolve(webSrc, '..', 'visual-routes.json'), 'utf8')) as { entries: { match: string; routes: string[] }[] };
  const i = map.entries.findIndex(e => e.match === 'apps/web/src/screens/Editions.tsx');
  assert.ok(i >= 0, 'hay entrada para Editions.tsx');
  assert.deepEqual(map.entries[i].routes, ['/ediciones']);
  const wild = map.entries.findIndex(e => e.match === 'apps/web/src/screens/');
  assert.ok(wild > i, 'la entrada va antes del comodín screens/');
  const appEntry = map.entries.find(e => e.match === 'apps/web/src/App.tsx');
  for (const r of ['/oficina', '/panel', '/backlog', '/ediciones', '/ajustes']) assert.ok(appEntry?.routes.includes(r), `App.tsx captura ${r}`);
});

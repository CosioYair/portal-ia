import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Política del propietario sobre TODA la API (services/ownerSession.ts): se recorren todas las rutas registradas que
 * cambian algo y cada una, sin sesión válida, desde otra página o puerto local o sin JSON, se rechaza antes de tocar nada
 * (la base de datos y las referencias git quedan idénticas). Rutas alternativas a la misma operación, otra empresa,
 * aprobaciones atadas al estado (publicar main, cambiar el remoto, una pestaña desactualizada) y los caminos legítimos:
 * Decisiones (que ejecuta por las mismas rutas con las credenciales de quien decide), el puente de los agentes (su token)
 * y la copia de un candidato en su vista previa.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-politica-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX; delete process.env.PORTAL_OWNER_CODE_FILE; delete process.env.PORTAL_PREVIEW;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo, platform } = await import('../src/db/platform.ts');
const { config } = await import('../src/config.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { stopBatchScheduler } = await import('../src/services/batchRunner.ts');
const { codeFile, ownerExempt, ownerOpenRoutes, ownerPolicyApplies, resetPairingForTests } = await import('../src/services/ownerSession.ts');
const { createWorker } = await import('../src/services/claudeCode/bridge.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-politica-repo-'));
const repo = path.join(tmp, 'repo'); const bare = path.join(tmp, 'remoto.git');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const commit = (file: string, msg: string) => { fs.writeFileSync(path.join(repo, file), `${msg}\n`); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', msg); return g(repo, 'rev-parse', 'HEAD'); };
fs.mkdirSync(repo); g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
g(repo, 'init', '-q', '-b', 'main'); commit('base.txt', 'Base'); g(repo, 'remote', 'add', 'origin', bare); g(repo, 'push', '-q', 'origin', 'main');
g(repo, 'checkout', '-qb', 'portal-ia/hu-001'); commit('a.txt', 'HU-001'); g(repo, 'checkout', '-q', 'main'); g(repo, 'push', '-q', 'origin', 'portal-ia/hu-001');
projectsRepo(S).setRepository(project.id, repo, 'main');

const app = await buildApp();
// Si una ruta se ejecutara de verdad (p. ej. reiniciar o apagar el Portal), el proceso de la prueba terminaría «bien» a
// mitad y contaría como superada: aquí salir es un fallo visible.
const realExit = process.exit; let completed = 0;
process.exit = ((code?: number) => { throw new Error(`process.exit(${code}) durante la prueba: una ruta se ejecutó sin la sesión del propietario`); }) as typeof process.exit;
after(async () => { process.exit = realExit; stopBatchScheduler(); await app.close(); assert.equal(completed, 4, 'las cuatro pruebas llegaron al final'); });
const HOST = `127.0.0.1:${config.port}`;
type Opts = { payload?: unknown; headers?: Record<string, string> };
const call = async (method: string, url: string, o: Opts = {}) => { const r = await app.inject({ method: method as any, url, payload: (o.payload ?? (method !== 'GET' && !o.headers?.['content-type'] ? {} : undefined)) as any, headers: { host: HOST, ...o.headers } }); return { status: r.statusCode, json: (() => { try { return r.json() as any; } catch { return null; } })(), body: r.body }; };
async function pair(): Promise<string> {
  resetPairingForTests();
  assert.equal((await call('POST', '/api/owner/pairing')).status, 200);
  const code = fs.readFileSync(codeFile(), 'utf8').match(/\b([A-Z2-9]{4}(?:-[A-Z2-9]{4}){4})\b/)![1];
  const r = await call('POST', '/api/owner/pair', { payload: { code } }); assert.equal(r.status, 200, r.body); return r.json.token;
}
/**
 * Huella de todo lo que una petición podría cambiar: el contenido de cada tabla de la plataforma y de la empresa (salvo
 * las sesiones) y las referencias git. Las tablas vacías no cuentan: algunas se crean al primer uso, también al leer.
 */
function state(): string {
  const dump = (db: any) => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('owner_sessions', 'sqlite_sequence') ORDER BY name`).all() as any[])
    .map(t => ({ name: t.name, rows: db.prepare(`SELECT * FROM "${t.name}"`).all() as any[] })).filter(t => t.rows.length)
    .map(t => `${t.name}:${crypto.createHash('sha256').update(JSON.stringify(t.rows)).digest('hex')}`).join('\n');
  return [dump(platform), dump(workspaceDb(S)), g(repo, 'for-each-ref', '--format=%(refname) %(objectname)'), g(repo, 'ls-remote', 'origin'), g(repo, 'config', '--get-regexp', '^remote\\.')].join('\n--\n');
}
const fill = (url: string) => url.replace(/:slug/g, S).replace(/:projectId|:pid/g, project.id).replace(/:[A-Za-z]+/g, 'x').replace(/\*/g, 'x');
const MUT = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

test('inventario: TODO cambio por la API exige la sesión del propietario (salvo vincular y el puente), y rechazarlo no toca nada', async () => {
  const token = await pair();
  const routes = ((app as any).routeList as { method: string; url: string }[]).filter(r => MUT.has(r.method) && r.url.startsWith('/api/'));
  assert.ok(routes.length >= 150, `${routes.length} rutas que cambian algo`);
  const open = routes.filter(r => !ownerPolicyApplies(r.method, r.url)).map(r => `${r.method} ${r.url}`).sort();
  assert.deepEqual(open.filter(r => !r.includes('/api/bridge/v1/')), ['POST /api/owner/pair', 'POST /api/owner/pairing', 'POST /api/owner/logout',
    'POST /api/workspaces/:slug/projects/:projectId/batches/preview', 'POST /api/workspaces/:slug/delegations/estimate'].sort(), 'abiertas: vincular y dos lecturas por POST');
  assert.ok(open.filter(r => r.includes('/api/bridge/v1/')).length >= 5 && ownerOpenRoutes().length === 4, 'y el puente de los agentes (con su token)');
  // Las dos lecturas por POST no cambian nada aunque se llamen sin sesión.
  const diff = (a: string, b: string) => { const x = new Set(a.split('\n')); return b.split('\n').filter(l => !x.has(l)).join(' | '); };
  const pre = state();
  await call('POST', `${W}/projects/${project.id}/batches/preview`, { payload: { storyIds: [] } });
  const mid = state(); assert.equal(mid, pre, `la vista previa del lote no guarda nada: ${diff(pre, mid)}`);
  await call('POST', `${W}/delegations/estimate`, { payload: { request: 'Estimar algo de prueba sin sesión' } });
  const post = state(); assert.equal(post, mid, `la estimación de un encargo no guarda nada: ${diff(mid, post)}`);
  const before = state(); const wrong: string[] = [];
  for (const r of routes.filter(r => ownerPolicyApplies(r.method, r.url))) {
    const url = fill(r.url); const body = { authorized: true, confirm: true, reason: 'prueba de la política' };
    const variants: [string, Opts, number, string?][] = [
      ['sin sesión', { payload: body }, 401, 'owner_required'],
      ['sesión inventada', { payload: body, headers: { 'x-portal-owner': crypto.randomBytes(32).toString('base64url') } }, 401, 'owner_required'],
      ['sesión en una cookie', { payload: body, headers: { cookie: `portal_owner=${token}` } }, 401, 'owner_required'],
      ['otra página local', { payload: body, headers: { 'x-portal-owner': token, origin: 'http://localhost:3000' } }, 403, 'foreign_origin'],
      ['otro puerto (interfaz de desarrollo)', { payload: body, headers: { 'x-portal-owner': token, host: 'localhost:5173' } }, 403, 'foreign_port'],
      ['como texto (sin permiso del navegador)', { payload: JSON.stringify(body), headers: { 'x-portal-owner': token, 'content-type': 'text/plain' } }, 415, 'json_required'],
      ['como formulario', { payload: 'authorized=true', headers: { 'x-portal-owner': token, 'content-type': 'application/x-www-form-urlencoded' } }, 415, 'json_required']
    ];
    for (const [why, o, status, code] of variants) {
      const res = await call(r.method, url, o);
      if (res.status !== status || (code && res.json?.code !== code)) wrong.push(`${r.method} ${r.url} · ${why}: ${res.status} ${res.json?.code ?? ''}`);
    }
  }
  assert.deepEqual(wrong, [], `respuestas inesperadas:\n${wrong.slice(0, 30).join('\n')}`);
  assert.equal(state(), before, 'ninguna petición rechazada cambió la base de datos ni el repositorio');
  completed++;
});

test('rutas alternativas a la misma operación (mayúsculas, barras, codificación, método sustituido): ninguna se la salta', async () => {
  const before = state(); const P = `${W}/projects/${project.id}/repository/publish-main`;
  const variants: [string, string, Record<string, string>][] = [
    ['POST', `${P}/`, {}], ['POST', P.toUpperCase(), {}], ['POST', P.replace('/api/', '/api//'), {}], ['POST', P.replace('publish-main', 'publish%2Dmain'), {}],
    ['POST', `${P}?authorized=true`, {}], ['POST', P.replace('/repository/', '/./repository/'), {}], ['POST', P.replace('/repository/', '/x/../repository/'), {}],
    ['GET', P, { 'x-http-method-override': 'POST' }], ['PUT', P, {}], ['POST', `/api/workspaces/${S.toUpperCase()}/projects/${project.id}/repository/publish-main`, {}],
    ['POST', `${W}/inbox/integrate/x/decision`, {}], ['POST', `/api/assistant/messages/x/operations/x/approve`, {}]
  ];
  for (const [m, u, h] of variants) {
    const r = await call(m, u, { payload: m === 'GET' ? undefined : { authorized: true, expectedMain: '0'.repeat(40), expectedRemoteUrl: null }, headers: h });
    assert.ok(r.status >= 400 && r.status !== 500, `${m} ${u} → ${r.status} ${r.body.slice(0, 120)}`);
    if (r.status === 200) assert.fail(`${m} ${u} se ejecutó`);
  }
  assert.equal(state(), before);
  completed++;
});

test('con sesión: otra empresa no alcanza lo de esta; publicar main y cambiar el remoto, atados a lo que viste', async () => {
  const token = await pair(); const O = { 'x-portal-owner': token };
  const other = await call('POST', '/api/workspaces', { payload: { name: 'Empresa B' }, headers: O });
  assert.ok([200, 201].includes(other.status), other.body); const B = other.json.slug ?? other.json.workspace?.slug; assert.ok(B && B !== S, JSON.stringify(other.json));
  const proc = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'Ajena', estimatedUsd: 0, backlogItemId: null, steps: [] } as any);
  // Desde la otra empresa, lo de esta no existe (404) o no tiene nada sobre lo que actuar (409): nunca se toca.
  const beforeB = state();
  for (const u of [`/api/workspaces/${B}/processes/${proc.id}/cancel`, `/api/workspaces/${B}/processes/${proc.id}/merge`, `/api/workspaces/${B}/processes/${proc.id}/reject`, `/api/workspaces/${B}/projects/${project.id}/repository/publish-main`, `/api/workspaces/${B}/projects/${project.id}/repository/remote`, `/api/workspaces/${B}/projects/${project.id}/maintenance/plans`]) {
    const r = await call('POST', u, { payload: { authorized: true, url: 'https://example.invalid/x.git', expectedUrl: null, expectedMain: '0'.repeat(40), expectedRemoteUrl: null, reason: 'x' }, headers: O });
    assert.ok([404, 409].includes(r.status), `${u}: ${r.status} ${r.body.slice(0, 140)}`);
  }
  assert.equal(state(), beforeB, 'nada de esta empresa cambió');
  // Publicar main: con el commit o el remoto que ya no son los que viste, nada; con los de ahora, sí (sin forzar).
  const pub = `${W}/projects/${project.id}/repository/publish-main`;
  const st = (await call('GET', `${W}/projects/${project.id}/repository/status`)).json;
  assert.match(st.mainCommit, /^[0-9a-f]{40}$/);
  const seen = { main: st.mainCommit, url: st.remoteUrl };
  commit('b.txt', 'main avanza después de verlo');
  const remoteBefore = g(repo, 'ls-remote', 'origin', 'refs/heads/main');
  const stale = await call('POST', pub, { payload: { authorized: true, expectedMain: seen.main, expectedRemoteUrl: seen.url }, headers: O });
  assert.equal(stale.status, 409, stale.body); assert.equal(stale.json.code, 'stale_state'); assert.equal(g(repo, 'ls-remote', 'origin', 'refs/heads/main'), remoteBefore, 'no se publicó');
  assert.equal((await call('POST', pub, { payload: { authorized: true }, headers: O })).status, 400, 'sin decir qué viste, no');
  const now = (await call('GET', `${W}/projects/${project.id}/repository/status`)).json;
  const wrongRemote = await call('POST', pub, { payload: { authorized: true, expectedMain: now.mainCommit, expectedRemoteUrl: 'https://github.com/otro/repo.git' }, headers: O });
  assert.equal(wrongRemote.status, 409);
  const ok = await call('POST', pub, { payload: { authorized: true, expectedMain: now.mainCommit, expectedRemoteUrl: now.remoteUrl }, headers: O });
  assert.equal(ok.status, 200, ok.body); assert.match(g(repo, 'ls-remote', 'origin', 'refs/heads/main'), new RegExp(`^${now.mainCommit}`));
  // Reconstruir y reiniciar el Portal: sin decir qué commit viste, o con uno que ya no es el actual, no se hace (aquí nunca
  // con el bueno: reconstruiría de verdad).
  assert.equal((await call('POST', '/api/system/update', { payload: { authorized: true, restart: false }, headers: O })).status, 400);
  const upd = await call('POST', '/api/system/update', { payload: { authorized: true, restart: false, expectedHead: 'abcdef0' }, headers: O });
  assert.ok([409, 403].includes(upd.status), upd.body); if (upd.status === 409) assert.equal(upd.json.code, 'stale_state');
  // Leer desde otra página local: sin cabeceras CORS, el navegador no le deja ver la respuesta (carpetas, conversaciones…).
  for (const u of ['/api/fs/dirs?path=~', '/api/assistant', `${W}/projects`]) {
    const r = await app.inject({ method: 'GET', url: u, headers: { host: HOST, origin: 'http://127.0.0.1:9999' } });
    assert.equal(r.headers['access-control-allow-origin'], undefined, `${u} no se comparte con otro origen`);
  }
  const pre = await app.inject({ method: 'OPTIONS', url: pub, headers: { host: HOST, origin: 'http://localhost:3000', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-portal-owner' } });
  assert.equal(pre.headers['access-control-allow-origin'], undefined, 'ni permite enviar cambios con la sesión desde otro origen');
  // Cambiar el remoto: si ya no es el que viste, no se toca.
  const rem = `${W}/projects/${project.id}/repository/remote`;
  const staleRemote = await call('POST', rem, { payload: { authorized: true, url: 'https://example.invalid/nuevo.git', expectedUrl: 'https://example.invalid/otro.git' }, headers: O });
  assert.equal(staleRemote.status, 409); assert.equal(g(repo, 'remote', 'get-url', 'origin'), bare);
  // Una pestaña desactualizada (la versión del proceso que vio ya no es la actual) no integra, publica ni descarta nada.
  // («Cancelar» se acepta siempre a propósito: parar el trabajo nunca se bloquea.)
  for (const action of ['merge', 'publish', 'reject', 'apply']) {
    const tab = await call('POST', `${W}/processes/${proc.id}/${action}`, { payload: { authorized: true, reason: 'x', seenVersion: 'version-antigua' }, headers: O });
    assert.equal(tab.status, 409, `${action}: ${tab.body.slice(0, 160)}`); assert.equal(tab.json?.code, 'stale_view', action);
  }
  completed++;
});

test('caminos legítimos: Decisiones ejecuta por la misma ruta con las credenciales de quien decide; el puente con su token; la vista previa de un candidato', async () => {
  const token = await pair(); const O = { 'x-portal-owner': token };
  // Decisiones: denegar una autorización pendiente cancela el proceso por su ruta (con la sesión del propietario reenviada).
  const p = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'Pendiente', estimatedUsd: 0.01, backlogItemId: null, steps: [] } as any);
  workspaceDb(S).prepare(`UPDATE processes SET status = 'pending_authorization' WHERE id = ?`).run(p.id);
  const url = `${W}/inbox/process_authorization/${p.id}/decision`;
  assert.equal((await call('POST', url, { payload: { verdict: 'deny', reason: 'no' } })).status, 401);
  assert.equal(processesRepo(S).get(p.id)!.status, 'pending_authorization', 'sin sesión no cambia');
  const d = await call('POST', url, { payload: { verdict: 'deny', reason: 'no' }, headers: O });
  assert.equal(d.status, 200, d.body); assert.notEqual(processesRepo(S).get(p.id)!.status, 'pending_authorization');
  // El puente de los agentes: con su token (sin sesión del propietario) funciona; sin token, el puente lo rechaza.
  const agent = agentsRepo(S).list()[0];
  const w = createWorker(S, 'Consola de prueba', [agent.id], 1);
  const hello = await call('POST', '/api/bridge/v1/hello', { payload: { client: { name: 'prueba' } }, headers: { authorization: `Bearer ${w.token}` } });
  assert.equal(hello.status, 200, hello.body);
  const noToken = await call('POST', '/api/bridge/v1/hello', { payload: {} });
  assert.equal(noToken.status, 401); assert.notEqual(noToken.json?.code, 'owner_required');
  // Copia de un candidato en su vista previa (datos temporales, como aquí): no hay propietario que proteger.
  assert.equal(ownerExempt(), false);
  const inside = process.env.PORTAL_INSIDE_SANDBOX;
  process.env.PORTAL_PREVIEW = '1'; delete process.env.PORTAL_INSIDE_SANDBOX;
  try {
    assert.equal(ownerExempt(), false, 'fuera del contenedor de la vista previa, nunca (aunque alguien fije PORTAL_PREVIEW)');
    process.env.PORTAL_INSIDE_SANDBOX = '1';
    assert.equal(ownerExempt(), true); assert.notEqual((await call('POST', `${W}/departments`, { payload: { name: 'Vista previa' } })).json?.code, 'owner_required');
  } finally { delete process.env.PORTAL_PREVIEW; if (inside === undefined) delete process.env.PORTAL_INSIDE_SANDBOX; else process.env.PORTAL_INSIDE_SANDBOX = inside; }
  assert.equal((await call('POST', `${W}/departments`, { payload: { name: 'Otra' } })).status, 401, 'fuera de la vista previa vuelve a exigirse');
  completed++;
});

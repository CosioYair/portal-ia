import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Identidad del propietario (services/ownerSession.ts) con un repositorio REAL y un remoto «bare» local. Pruebas
 * negativas: una petición HTTP local sin sesión válida (sin cabecera, inventada, cerrada, con otro tipo de cuerpo, desde
 * otra página o puerto local, por la tarjeta del chat o pidiéndole otra revisión al Asistente) no ejecuta, no altera y no
 * reutiliza la revisión: el documento del plan y las ramas quedan idénticos. Con sesión, el servidor sigue comprobando los
 * objetivos exactos y el estado real del repositorio (main y remoto). Vincular: el código nunca viaja por la API.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-owner-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX; delete process.env.PORTAL_OWNER_CODE_FILE;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { config } = await import('../src/config.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { backlogRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { CAPABILITIES } = await import('../src/services/capabilities.ts');
const { prepareOperations, assistantRepo } = await import('../src/services/assistant.ts');
const { createPlan, getPlan } = await import('../src/services/projectMaintenance.ts');
const { conversationsRepo } = await import('../src/db/conversations.ts');
const { stopBatchScheduler } = await import('../src/services/batchRunner.ts');
const { codeFile, resetPairingForTests } = await import('../src/services/ownerSession.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-owner-repo-'));
const repo = path.join(tmp, 'repo'); const bare = path.join(tmp, 'remoto.git'); const fork = path.join(tmp, 'copia.git');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const commit = (cwd: string, file: string, msg: string) => { fs.writeFileSync(path.join(cwd, file), `${msg}\n`); g(cwd, 'add', '-A'); g(cwd, 'commit', '-qm', msg); return g(cwd, 'rev-parse', 'HEAD'); };
fs.mkdirSync(repo); g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
g(repo, 'init', '-q', '-b', 'main'); commit(repo, 'base.txt', 'Base'); g(repo, 'remote', 'add', 'origin', bare); g(repo, 'push', '-q', 'origin', 'main');
// Integrada (en main y en el remoto) y sin integrar (en el remoto y local): el cierre de etapa las elige las dos.
g(repo, 'checkout', '-qb', 'portal-ia/hu-001'); commit(repo, 'a.txt', 'HU-001'); g(repo, 'checkout', '-q', 'main'); g(repo, 'merge', '-q', '--ff-only', 'portal-ia/hu-001'); g(repo, 'push', '-q', 'origin', 'main', 'portal-ia/hu-001');
g(repo, 'checkout', '-qb', 'portal-ia/hu-002'); commit(repo, 'b.txt', 'HU-002 sin integrar'); g(repo, 'checkout', '-q', 'main'); g(repo, 'push', '-q', 'origin', 'portal-ia/hu-002');
g(repo, 'branch', 'portal-ia/hu-003', 'main');
projectsRepo(S).setRepository(project.id, repo, 'main');
const sOld = addManualItem(S, project.id, { title: 'Trabajo antiguo' });
const REASON = 'Cierre de etapa: se adopta main como línea base.';

const app = await buildApp();
after(async () => { stopBatchScheduler(); await app.close(); });
/** La dirección del propio Portal (su puerto), como la usa su interfaz. */
const HOST = `127.0.0.1:${config.port}`;
type Opts = { payload?: unknown; headers?: Record<string, string> };
const call = async (method: string, url: string, o: Opts = {}) => { const r = await app.inject({ method: method as any, url, payload: (o.payload ?? (method === 'POST' && !o.headers?.['content-type'] ? {} : undefined)) as any, headers: { host: HOST, ...o.headers } }); return { status: r.statusCode, json: r.body ? r.json() as any : null, headers: r.headers, body: r.body }; };
const refs = () => ({ local: g(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/portal-ia'), remote: g(repo, 'ls-remote', 'origin'), story: backlogRepo(S).get(sOld.id)!.status });
const planDoc = (id: string) => JSON.stringify(getPlan(S, id));
const CODE = /\b([A-Z2-9]{4}(?:-[A-Z2-9]{4}){4})\b/;
const readCode = () => fs.readFileSync(codeFile(), 'utf8').match(CODE)![1];

/** Vincular por HTTP como lo haría el propietario: pide el código y lo lee del archivo (nunca de la respuesta). */
async function pair(): Promise<string> {
  resetPairingForTests();
  const ask = await call('POST', '/api/owner/pairing');
  assert.equal(ask.status, 200, ask.body);
  const r = await call('POST', '/api/owner/pair', { payload: { code: readCode() } });
  assert.equal(r.status, 200, r.body);
  return r.json.token;
}

test('vincular: el código nunca viaja por la API, es de un solo uso, no se puede bloquear a fuerza de fallos y sin cookie', async () => {
  resetPairingForTests();
  const ask = await call('POST', '/api/owner/pairing');
  assert.equal(ask.status, 200); assert.equal(ask.json.file, codeFile()); assert.equal(ask.json.problem, null);
  const code = readCode(); const raw = code.replace(/-/g, '');
  assert.equal(raw.length, 20, '100 bits: adivinarlo es imposible');
  assert.ok(codeFile().startsWith(process.env.PORTAL_DATA_DIR!), 'con datos temporales el archivo queda junto a ellos, nunca en el perfil real');
  assert.ok(!ask.body.includes(raw.slice(0, 8)) && !ask.body.includes(code.slice(0, 9)), 'la respuesta no incluye el código');
  const st = await call('GET', '/api/owner/session');
  assert.ok(!st.body.includes(raw.slice(0, 8)) && !('pairingActive' in st.json), 'el estado tampoco, ni si hay uno vigente');
  // Otra petición mientras está vigente no lo cambia (nadie invalida el que estás pegando).
  await call('POST', '/api/owner/pairing'); assert.equal(readCode(), code);
  // Desde otra página local, otro puerto (p. ej. la interfaz de desarrollo) o sin JSON, ni se pide ni se canjea.
  assert.equal((await call('POST', '/api/owner/pair', { payload: { code }, headers: { origin: 'http://localhost:3000' } })).status, 403);
  assert.equal((await call('POST', '/api/owner/pair', { payload: { code }, headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } })).json.code, 'foreign_port');
  assert.equal((await call('POST', '/api/owner/pairing', { headers: { host: '127.0.0.1:5999' } })).status, 403);
  assert.equal((await call('POST', '/api/owner/pair', { payload: JSON.stringify({ code }), headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call('POST', '/api/owner/pairing', { payload: '{}', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  // Cientos de códigos equivocados no bloquean ni anulan el vigente (nadie puede dejarte sin vincular).
  for (let i = 0; i < 200; i++) assert.equal((await call('POST', '/api/owner/pair', { payload: { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ' } })).status, 401);
  // El correcto (pegado con el texto de alrededor, en minúsculas) vincula una sola vez; la sesión no va en una cookie.
  const ok = await call('POST', '/api/owner/pair', { payload: { code: code.toLowerCase() } });
  assert.equal(ok.status, 200, ok.body); assert.match(ok.json.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(ok.headers['set-cookie'], undefined);
  assert.ok(!fs.existsSync(codeFile()), 'el archivo del código se borra al usarlo');
  assert.equal((await call('POST', '/api/owner/pair', { payload: { code } })).status, 401, 'un solo uso');
  assert.equal((await call('GET', '/api/owner/session', { headers: { 'x-portal-owner': ok.json.token } })).json.owner, true);
  assert.equal((await call('GET', '/api/owner/session', { headers: { 'x-portal-owner': ok.json.token, host: 'localhost:5173' } })).json.owner, false, 'en otro puerto la sesión no vale');
  assert.equal((await call('GET', '/api/owner/session')).json.owner, false);
  // Cerrar la sesión la invalida; «cerrar todas» exige ser propietario y cierra también las demás.
  assert.equal((await call('POST', '/api/owner/logout', { headers: { 'x-portal-owner': ok.json.token } })).status, 200);
  assert.equal((await call('GET', '/api/owner/session', { headers: { 'x-portal-owner': ok.json.token } })).json.owner, false);
  const a = await pair(); const b = await pair();
  assert.equal((await call('POST', '/api/owner/logout-all')).status, 401);
  assert.equal((await call('POST', '/api/owner/logout-all', { headers: { 'x-portal-owner': a } })).json.closed, 2);
  assert.equal((await call('GET', '/api/owner/session', { headers: { 'x-portal-owner': b } })).json.owner, false);
});

test('sin sesión válida nada ejecuta, altera ni reutiliza el cierre de etapa: plan y ramas idénticos', async () => {
  const token = await pair(); const OWNER = { 'x-portal-owner': token };
  const created = await call('POST', `${W}/projects/${project.id}/maintenance/plans`, { payload: { closeStage: { reason: REASON } }, headers: OWNER });
  assert.equal(created.status, 200, created.body);
  const plan = created.json; assert.ok(plan.prepared.length >= 3, JSON.stringify(plan.prepared)); assert.equal(plan.createdBy, 'owner');
  const before = { doc: planDoc(plan.id), refs: refs() };
  const exec = `${W}/maintenance/plans/${plan.id}/execute`; const body = { authorized: true, selection: plan.prepared };
  // Ejecutar: sin cabecera, con una sesión inventada, con una ya cerrada, con un formato no válido, como cookie, en otro puerto.
  const forged = crypto.randomBytes(32).toString('base64url');
  const closed = await pair(); await call('POST', '/api/owner/logout', { headers: { 'x-portal-owner': closed } });
  for (const [why, headers] of [['sin sesión', {}], ['inventada', { 'x-portal-owner': forged }], ['cerrada', { 'x-portal-owner': closed }], ['formato no válido', { 'x-portal-owner': 'x' }], ['como cookie', { cookie: `portal_owner=${token}` }]] as [string, Record<string, string>][]) {
    const r = await call('POST', exec, { payload: body, headers });
    assert.equal(r.status, 401, `${why}: ${r.body}`); assert.equal(r.json.code, 'owner_required');
  }
  assert.equal((await call('POST', exec, { payload: body, headers: { ...OWNER, host: 'localhost:5173' } })).json.code, 'foreign_port', 'la sesión buena en otro puerto (interfaz de desarrollo u otra aplicación) no vale');
  // Con la sesión buena pero sin JSON (formulario o texto: lo que otra página puede enviar sin permiso) o desde otra página local.
  assert.equal((await call('POST', exec, { payload: JSON.stringify(body), headers: { ...OWNER, 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call('POST', exec, { payload: 'authorized=true', headers: { ...OWNER, 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await call('POST', exec, { payload: body, headers: { ...OWNER, origin: 'http://localhost:3000' } })).status, 403, 'otra página de otro puerto local');
  assert.equal((await call('POST', exec, { payload: body, headers: { ...OWNER, origin: 'http://127.0.0.1:5999' } })).status, 403);
  // Rechazar o sustituir la revisión (la pantalla: «Revisar de nuevo»; una revisión nueva con otro motivo) sin sesión.
  assert.equal((await call('POST', `${W}/maintenance/plans/${plan.id}/reject`)).status, 401);
  assert.equal((await call('POST', `${W}/projects/${project.id}/maintenance/plans`, { payload: { from: plan.id } })).status, 401);
  assert.equal((await call('POST', `${W}/projects/${project.id}/maintenance/plans`, { payload: { closeStage: { reason: 'Motivo de otro' } } })).status, 401);
  assert.equal((await call('POST', `${W}/projects/${project.id}/maintenance/plans`)).status, 401);
  // Nada cambió: ni el documento del plan (estado, selección preparada, motivo, ejecución) ni una sola referencia.
  assert.equal(planDoc(plan.id), before.doc); assert.deepEqual(refs(), before.refs);
  assert.equal(getPlan(S, plan.id).status, 'proposed'); assert.equal(getPlan(S, plan.id).execution, null);
  // Mismo origen (la interfaz del Portal) y sesión: entonces sí (control positivo).
  const rej = await call('POST', `${W}/maintenance/plans/${plan.id}/reject`, { headers: { ...OWNER, origin: `http://${HOST}` } });
  assert.equal(rej.status, 200, rej.body); assert.equal(rej.json.status, 'rejected'); assert.deepEqual(refs(), before.refs, 'rechazar no toca nada');
});

test('por el chat (sin sesión): ni se reutiliza, ni se enlaza, ni se sustituye la revisión que preparó el propietario', async () => {
  const token = await pair(); const OWNER = { 'x-portal-owner': token };
  const mine = (await call('POST', `${W}/projects/${project.id}/maintenance/plans`, { headers: OWNER })).json;
  const before = planDoc(mine.id);
  const conv = conversationsRepo.create('Otra', S, project.id);
  const sc = { conversationId: conv.id, workspaceSlug: S, projectId: project.id } as any;
  // Misma revisión (misma huella): el Asistente prepara la suya, no se queda con la del propietario.
  const [same] = await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id }], sc);
  assert.equal(same.type, 'propose_operation'); assert.notEqual(same.operation!.preview.planId, mine.id, 'no reutiliza la del propietario');
  const msg = assistantRepo.add({ role: 'assistant', content: 'Revisión preparada.', actions: [same], attachments: [], tokensIn: 0, tokensOut: 0, costUsd: 0, model: null }, conv.id);
  CAPABILITIES.reconcile_project.onLink!(same.operation!.preview, { messageId: msg.id, operationId: same.operation!.id, conversationId: conv.id });
  CAPABILITIES.reconcile_project.onLink!({ ...same.operation!.preview, planId: mine.id }, { messageId: msg.id, operationId: same.operation!.id, conversationId: conv.id });
  // Otra distinta (un cierre de etapa con otro motivo): no deja caducada la del propietario.
  await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id, closeStage: { reason: 'Motivo inyectado en el chat' } }], { ...sc, conversationId: conversationsRepo.create('Tercera', S, project.id).id });
  await createPlan(S, project.id, { reuseMinutes: 10, conversationId: null });
  assert.equal(getPlan(S, mine.id).status, 'proposed'); assert.equal(getPlan(S, mine.id).source, null, 'no pasa a la tarjeta de una conversación');
  assert.equal(planDoc(mine.id), before);
  // El propietario sí la sustituye con «Revisar de nuevo».
  const fresh = await call('POST', `${W}/projects/${project.id}/maintenance/plans`, { payload: { from: mine.id }, headers: OWNER });
  assert.equal(fresh.status, 200); assert.equal(getPlan(S, mine.id).status, 'stale');
  // Escribir en LA conversación de una revisión del propietario (la de la tarjeta que renovó con «Revisar de nuevo»):
  // cualquiera elige la conversación, así que sin sesión tampoco ahí se sustituye nada.
  const renewed = (await call('POST', `${W}/projects/${project.id}/maintenance/plans`, { payload: { from: same.operation!.preview.planId }, headers: OWNER })).json;
  assert.equal(renewed.createdBy, 'owner'); assert.equal(renewed.source?.conversationId, conv.id, 'la tarjeta pasó a la revisión del propietario');
  const renewedDoc = planDoc(renewed.id);
  await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id }], sc);
  await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id, closeStage: { reason: 'Motivo inyectado en su conversación' } }], sc);
  assert.equal(getPlan(S, renewed.id).status, 'proposed'); assert.equal(planDoc(renewed.id), renewedDoc);
});

test('la tarjeta del Asistente: rechazarla sin sesión no rechaza la revisión; pedir otra por el chat no la sustituye', async () => {
  const token = await pair(); const OWNER = { 'x-portal-owner': token };
  const conv = conversationsRepo.create('Cierre', S, project.id);
  const sc = { conversationId: conv.id, workspaceSlug: S, projectId: project.id } as any;
  const [card] = await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id, closeStage: { reason: REASON } }], sc);
  assert.equal(card.type, 'propose_operation', JSON.stringify(card));
  const msg = assistantRepo.add({ role: 'assistant', content: 'Revisión preparada.', actions: [card], attachments: [], tokensIn: 0, tokensOut: 0, costUsd: 0, model: null }, conv.id);
  CAPABILITIES.reconcile_project.onLink!(card.operation!.preview, { messageId: msg.id, operationId: card.operation!.id, conversationId: conv.id });
  const planId = card.operation!.preview.planId!; const before = { doc: planDoc(planId), refs: refs() };
  const url = `/api/assistant/messages/${msg.id}/operations/${card.operation!.id}`;
  assert.equal((await call('POST', `${url}/reject`)).status, 401);
  assert.equal((await call('POST', `${url}/approve`, { payload: { authorized: true } })).status, 401);
  assert.equal((await call('POST', `${url}/reject`, { headers: { 'x-portal-owner': crypto.randomBytes(32).toString('base64url') } })).status, 401);
  // Cualquiera puede escribir al Asistente: pedirle otro cierre en la misma conversación remite al pendiente (no prepara otro),
  // aunque antes se hayan pedido muchas revisiones en otras conversaciones (no lo «empujan» fuera de la lista).
  for (let i = 0; i < 22; i++) await createPlan(S, project.id, { conversationId: `relleno-${i}` });
  const pendingBefore =(await call('GET', `${W}/projects/${project.id}/maintenance/plans`)).json.filter((p: any) => p.status === 'proposed').length;
  const [again] = await prepareOperations([{ type: 'request_operation', capability: 'reconcile_project', company: S, project: project.id, closeStage: { reason: 'Otro motivo inyectado en el chat' } }], sc);
  assert.equal(again.type, 'info'); assert.match(again.label, /Ya está pendiente/); assert.match(again.detail!, /Solo tú lo sustituyes/); assert.match(String((again as any).reviewPath), new RegExp(`${planId}$`));
  assert.equal((await call('GET', `${W}/projects/${project.id}/maintenance/plans`)).json.filter((p: any) => p.status === 'proposed').length, pendingBefore, 'no se creó otra revisión');
  // Y aunque una revisión se pida por el servicio sin pasar por la tarjeta (sin sesión), no la sustituye.
  await createPlan(S, project.id, { reuseMinutes: 10, conversationId: conv.id, closeStage: { reason: 'Otro motivo', source: 'assistant' } });
  assert.equal(getPlan(S, planId).status, 'proposed', 'el cierre de etapa pendiente sigue vigente');
  assert.equal(planDoc(planId), before.doc); assert.deepEqual(refs(), before.refs);
  assert.equal(assistantRepo.get(msg.id)!.actions[0].status, 'pending');
  // Con la sesión del propietario, la tarjeta sí se rechaza (y con ella la revisión).
  const ok = await call('POST', `${url}/reject`, { headers: OWNER });
  assert.equal(ok.status, 200, ok.body); assert.equal(getPlan(S, planId).status, 'rejected');
  assert.equal((await call('POST', `${W}/maintenance/plans/${planId}/execute`, { payload: { authorized: true, selection: getPlan(S, planId).prepared }, headers: OWNER })).status, 409, 'una revisión rechazada no se reutiliza');
});

test('con sesión, el servidor sigue exigiendo los objetivos exactos y el estado real (main y remoto); lo terminado no se repite', async () => {
  const token = await pair(); const OWNER = { 'x-portal-owner': token };
  const mk = async () => { const r = await call('POST', `${W}/projects/${project.id}/maintenance/plans`, { headers: OWNER }); assert.equal(r.status, 200, r.body); return r.json; };
  const run = (id: string, selection: any[]) => call('POST', `${W}/maintenance/plans/${id}/execute`, { payload: { authorized: true, selection }, headers: OWNER });
  const wait = async (id: string) => { for (let i = 0; i < 300; i++) { const p = getPlan(S, id); if (p.status !== 'running') return p; await new Promise(r => setTimeout(r, 50)); } throw new Error('no terminó'); };
  const p = await mk(); const before = { doc: planDoc(p.id), refs: refs() };
  assert.equal((await call('POST', `${W}/maintenance/plans/${p.id}/execute`, { payload: { selection: [{ itemId: 'local:portal-ia/hu-003', option: 'delete_local' }] }, headers: OWNER })).json.code, 'authorization_required');
  assert.equal((await run(p.id, [{ itemId: 'local:no-existe', option: 'delete_local' }])).json.code, 'unknown_item');
  assert.equal((await run(p.id, [{ itemId: 'local:main', option: 'delete_local' }])).json.code, 'protected_item');
  assert.equal((await run(p.id, [{ itemId: 'remote:main', option: 'delete_remote' }])).json.code, 'protected_item');
  assert.equal((await run(p.id, [{ itemId: 'local:portal-ia/hu-003', option: 'remove_worktree' }])).json.code, 'invalid_option');
  assert.equal((await run(p.id, [{ itemId: `story:${sOld.id}`, option: 'discard' }])).json.code, 'reason_required');
  assert.equal((await run(p.id, [{ itemId: 'local:portal-ia/hu-003', option: 'borrar_todo' }])).status, 400);
  assert.equal(planDoc(p.id), before.doc, 'una petición rechazada no toca el plan'); assert.deepEqual(refs(), before.refs);
  // El remoto cambió desde la revisión (otra dirección con las mismas ramas): no se borra nada en ninguno de los dos.
  g(tmp, 'clone', '-q', '--bare', bare, fork);
  const r0 = await mk();
  g(repo, 'remote', 'set-url', 'origin', fork);
  assert.equal((await run(r0.id, [{ itemId: 'remote:portal-ia/hu-001', option: 'delete_remote' }])).status, 200);
  const r1 = await wait(r0.id);
  assert.equal(r1.status, 'stale'); assert.match(r1.execution!.outcomes[0].message ?? '', /el remoto cambió/);
  assert.match(g(fork, 'branch', '--list', 'portal-ia/hu-001'), /hu-001/); assert.match(g(bare, 'branch', '--list', 'portal-ia/hu-001'), /hu-001/);
  g(repo, 'remote', 'set-url', 'origin', bare);
  // main cambió desde la revisión: no se ejecuta nada y la revisión caduca (ni se reutiliza después).
  const p2 = await mk();
  commit(repo, 'm.txt', 'main avanza');
  const r = await run(p2.id, [{ itemId: 'local:portal-ia/hu-003', option: 'delete_local' }]); assert.equal(r.status, 200, r.body);
  const fin = await wait(p2.id);
  assert.equal(fin.status, 'stale'); assert.ok(fin.execution!.outcomes.every(o => o.status === 'skipped'), JSON.stringify(fin.execution!.outcomes));
  assert.match(g(repo, 'branch', '--list', 'portal-ia/hu-003'), /hu-003/, 'la rama sigue ahí');
  assert.equal((await run(p2.id, [{ itemId: 'local:portal-ia/hu-003', option: 'delete_local' }])).status, 409, 'una revisión caducada no se reutiliza');
  // Revisión nueva, ejecutada de verdad: después no se puede repetir.
  const q = await mk();
  assert.equal((await run(q.id, [{ itemId: 'local:portal-ia/hu-003', option: 'delete_local' }])).status, 200);
  assert.equal((await wait(q.id)).status, 'done');
  assert.equal(g(repo, 'branch', '--list', 'portal-ia/hu-003'), '');
  assert.equal((await run(q.id, [{ itemId: 'local:portal-ia/hu-003', option: 'delete_local' }])).status, 409, 'lo terminado no se repite');
});

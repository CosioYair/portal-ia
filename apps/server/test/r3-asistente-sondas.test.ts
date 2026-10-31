import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sonda Gauntlet (revisor independiente): proveedor SIMULADO, datos sintéticos.
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-probe-a-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json');
process.env.PORTAL_MOCK_SCRIPT = scriptPath;
const OUT = process.env.PROBE_OUT ?? os.tmpdir();

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { mockAdapter, resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { projectsRepo } = await import('../src/db/workspace.ts');
const { assignmentsRepo } = await import('../src/db/assignments.ts');
const { createAssignment } = await import('../src/services/assignments.ts');
const { buildApp } = await import('../src/app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia';
const portal = projectsRepo(S).list()[0];
const app = await buildApp();
after(async () => { await app.close(); });
const inject = async (method: string, u: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url: u, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
const seen: { system: string; user: string }[] = [];
const original = mockAdapter.complete.bind(mockAdapter);
(mockAdapter as any).complete = async (k: string, o: any, req: any, s?: AbortSignal) => { seen.push({ system: String(req.system ?? ''), user: String(req.user ?? '') }); return original(k, o, req, s); };
const chatPrompts = () => seen.filter(p => p.system.startsWith('Eres «Asistente de Empresa'));
const script = (chat: string) => { resetMockCalls(); fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: '^Eres «Asistente de Empresa', text: chat }] })); };
const conv = async (projectId: string | null) => (await inject('POST', '/api/assistant/conversations', { title: 'x', workspaceSlug: projectId ? S : null, projectId })).body.id as string;
const say = async (C: string, text: string) => { const r = await inject('POST', '/api/assistant/messages', { text, conversationId: C }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.assistant; };

test('A · tamaño de la instrucción del sistema (instalación recién inicializada)', async () => {
  script('Ok.');
  await say(await conv(null), 'hola');
  const u = chatPrompts().at(-1)!.system;
  await say(await conv(portal.id), 'hola');
  const p = chatPrompts().at(-1)!.system;
  fs.writeFileSync(path.join(OUT, 'probe-system-unscoped.txt'), u);
  fs.writeFileSync(path.join(OUT, 'probe-system-scoped.txt'), p);
  console.log(`SIZE unscoped=${u.length} scoped=${p.length}`);
});

test('B · instantánea: con más de 3 encargos cerrados, el modelo ve los MÁS RECIENTES', async () => {
  const mk = (n: number) => createAssignment(S, portal.id, { request: `Petición ${n}`, title: `Encargo prueba ${n}`, objective: 'Objetivo suficientemente largo', criteria: ['Criterio comprobable'], outOfScope: [], size: 'S', conversationId: null });
  const ens = [1, 2, 3, 4, 5].map(mk);
  for (const a of ens) assignmentsRepo(S).update(a.id, x => { x.status = 'cancelled'; });
  // El último (EN-005) acaba de terminar: lo que el propietario preguntará.
  assignmentsRepo(S).update(ens[4].id, x => { x.status = 'failed'; x.reason = 'MOTIVO-DEL-ULTIMO'; });
  console.log('order from repo.list:', assignmentsRepo(S).list(portal.id).map(a => a.code).join(','));
  script('Ok.');
  await say(await conv(portal.id), '¿Cómo terminó el último encargo?');
  const sys = chatPrompts().at(-1)!.system;
  const block = sys.split('Encargos de desarrollo (EN-n, sin historia):')[1]?.split('\n').filter(l => l.startsWith('- EN-')).join('\n') ?? '(sin bloque)';
  console.log(`EN block seen by model:\n${block}`);
  assert.match(block, new RegExp(`${ens[4].code}.*fallido`), `el encargo cerrado más reciente (${ens[4].code}, fallido) no llega al modelo`);
});

test('C · «arréglalo y publica main cuando termines»: sin tarjeta de publicar ahora; una tarjeta solo publica el main que mostró', async () => {
  const { execSync } = await import('node:child_process');
  const { createProject } = await import('../src/services/companies.ts');
  const site = createProject(S, 'Sitio sonda', 'Web');
  const git = (cwd: string, cmd: string) => execSync(`git ${cmd}`, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-probe-remote-')); git(remote, 'init -q --bare -b main');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-probe-repo-'));
  fs.writeFileSync(path.join(repo, 'a.txt'), '1\n'); git(repo, 'init -q -b main'); git(repo, 'add -A'); git(repo, 'commit -qm Base');
  git(repo, `remote add origin "${remote}"`); git(repo, 'push -q -u origin main');
  fs.writeFileSync(path.join(repo, 'a.txt'), '2\n'); git(repo, 'commit -qam "Cambio-visible"');
  projectsRepo(S).setRepository(site.id, repo, 'main');
  const C = await conv(site.id);
  const block = (reply: string, actions: unknown[]) => `${reply}\n\`\`\`actions\n${JSON.stringify(actions)}\n\`\`\``;
  // 1 · En la misma respuesta que un encargo nuevo: ninguna tarjeta de publicar (publicaría main SIN el encargo).
  script(block('Encargo y publicación.', [
    { type: 'propose_assignment', title: 'Arreglo', request: 'Arréglalo y publica main cuando termines', objective: 'Objetivo suficientemente largo', criteria: ['Criterio comprobable'], size: 'S' },
    { type: 'request_operation', capability: 'publish_main', company: S, project: site.slug }
  ]));
  const a = await say(C, 'Arréglalo y publica main cuando termines');
  assert.deepEqual(a.actions.map((x: any) => [x.type, x.status]), [['propose_assignment', 'pending'], ['info', 'done']]);
  assert.match(a.actions[1].detail, /cuando ese encargo esté integrado/);
  // 2 · Una tarjeta pedida sola: si main recibe un commit que no mostraba, autorizarla NO publica nada (409).
  script(block('Lista para publicar.', [{ type: 'request_operation', capability: 'publish_main', company: S, project: site.slug }]));
  const b = await say(C, 'Publica main');
  const op = b.actions.find((x: any) => x.type === 'propose_operation');
  assert.equal(op?.status, 'pending', JSON.stringify(b.actions));
  fs.writeFileSync(path.join(repo, 'a.txt'), '3\n'); git(repo, 'commit -qam "Cambio-NO-mostrado"');
  const r = await inject('POST', `/api/assistant/messages/${b.id}/operations/${op.operation.id}/approve`, { authorized: true });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.ok(!/Cambio-NO-mostrado|Cambio-visible/.test(git(remote, 'log --oneline main')), 'no se publicó nada');
  // Control: una tarjeta nueva muestra el main actual y, autorizada, lo publica (la operación sigue funcionando).
  const c = await say(C, 'Publica main');
  const op2 = c.actions.find((x: any) => x.type === 'propose_operation');
  assert.equal((await inject('POST', `/api/assistant/messages/${c.id}/operations/${op2.operation.id}/approve`, { authorized: true })).status, 200);
  assert.match(git(remote, 'log --oneline main'), /Cambio-NO-mostrado/);
});

test('D · decisión aprobada: el historial que recibe el modelo la sigue dando por abierta', async () => {
  const C = await conv(portal.id);
  const block = (reply: string, actions: unknown[]) => `${reply}\n\`\`\`actions\n${JSON.stringify(actions)}\n\`\`\``;
  script(block('Abro la decisión.', [{ type: 'open_decision', question: '¿Usamos colas?', context: 'c', options: [{ label: 'Sí', pros: 'p', cons: 'c' }, { label: 'No', pros: 'p', cons: 'c' }], recommendation: 'Sí', risks: [], dependsOn: [] }]));
  const a = await say(C, 'Ayúdame a decidir si usamos colas');
  const did = a.actions.find((x: any) => x.type === 'open_decision')?.decisionId;
  const r = await inject('POST', `/api/assistant/conversations/${C}/decisions/${did}/approve`, { answer: 'Sí' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  script('Ok.');
  await say(C, '¿Qué decidimos?');
  const p = chatPrompts().at(-1)!;
  const hist = p.user.match(/\[acciones: [^\]]*\]/)?.[0]; const led = p.system.match(/D1 \[[a-z]+\][^\n]*/)?.[0];
  console.log('history:', hist, '| ledger:', led);
  assert.ok(!/abierta/.test(hist ?? ''), 'el historial dice «abierta» de una decisión aprobada');
});

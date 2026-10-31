import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sonda Gauntlet (revisor independiente): proveedor SIMULADO, datos sintéticos.
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-r4race-'));
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

test('R4-2 · doble «Autorizar» de la misma tarjeta de publicar main: ¿se ejecuta una sola vez?', async () => {
  const { execSync } = await import('node:child_process');
  const { createProject } = await import('../src/services/companies.ts');
  const { CAPABILITIES } = await import('../src/services/capabilities.ts');
  const site = createProject(S, 'Sitio carrera', 'Web');
  const git = (cwd: string, cmd: string) => execSync(`git ${cmd}`, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-r4race-remote-')); git(remote, 'init -q --bare -b main');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-r4race-repo-'));
  fs.writeFileSync(path.join(repo, 'a.txt'), '1\n'); git(repo, 'init -q -b main'); git(repo, 'add -A'); git(repo, 'commit -qm Base');
  git(repo, `remote add origin "${remote}"`); git(repo, 'push -q -u origin main');
  fs.writeFileSync(path.join(repo, 'a.txt'), '2\n'); git(repo, 'commit -qam "Cambio"');
  projectsRepo(S).setRepository(site.id, repo, 'main');
  const C = await conv(site.id);
  const block = (reply: string, actions: unknown[]) => `${reply}\n\`\`\`actions\n${JSON.stringify(actions)}\n\`\`\``;
  script(block('Lista para publicar.', [{ type: 'request_operation', capability: 'publish_main', company: S, project: site.slug }]));
  const b = await say(C, 'Publica main');
  const op = b.actions.find((x: any) => x.type === 'propose_operation');
  assert.equal(op?.status, 'pending', JSON.stringify(b.actions));
  const cap = CAPABILITIES.publish_main; const orig = cap.execute.bind(cap); let executed = 0;
  cap.execute = async (p: any) => { executed++; return orig(p); };
  try {
    const url = `/api/assistant/messages/${b.id}/operations/${op.operation.id}/approve`;
    const [r1, r2] = await Promise.all([inject('POST', url, { authorized: true }), inject('POST', url, { authorized: true })]);
    console.log('R4-2 respuestas', r1.status, r2.status, '| ejecuciones', executed); const first = executed;
    // Control (comportamiento anterior): la misma tarjeta SIN huella (se salta la nueva comprobación asíncrona).
    const { assistantRepo } = await import('../src/services/assistant.ts');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'tres'); git(repo, 'commit -qam "Cambio2"');
    const c = await say(C, 'Publica main');
    const op2 = c.actions.find((x: any) => x.type === 'propose_operation');
    assistantRepo.updateActions(c.id, assistantRepo.get(c.id)!.actions.map((x: any) => x.operation?.id === op2.operation.id ? { ...x, operation: { ...x.operation, preview: { ...x.operation.preview, fingerprint: undefined } } } : x));
    const before = executed; const u2 = `/api/assistant/messages/${c.id}/operations/${op2.operation.id}/approve`;
    const [s1, s2] = await Promise.all([inject('POST', u2, { authorized: true }), inject('POST', u2, { authorized: true })]);
    console.log('R4-2 control sin huella', s1.status, s2.status, '| ejecuciones', executed - before);
    assert.equal(first, 1, `la misma operación autorizada dos veces a la vez se ejecutó ${first} veces (respuestas ${r1.status}/${r2.status})`);
  } finally { cap.execute = orig; }
});

test('R4-3 · publicar aplazado por un encargo nuevo: ¿qué ve el modelo después y quién lo propone luego?', async () => {
  const { createProject } = await import('../src/services/companies.ts');
  const site = createProject(S, 'Sitio aplazado', 'Web');
  const C = await conv(site.id);
  const block = (reply: string, actions: unknown[]) => `${reply}\n\`\`\`actions\n${JSON.stringify(actions)}\n\`\`\``;
  script(block('Encargo y publicación.', [
    { type: 'propose_assignment', title: 'Arreglo', request: 'Arréglalo y publica main cuando termines', objective: 'Objetivo suficientemente largo', criteria: ['Criterio comprobable'], size: 'S' },
    { type: 'request_operation', capability: 'publish_main', company: S, project: site.slug }
  ]));
  const a = await say(C, 'Arréglalo y publica main cuando termines');
  console.log('R4-3 acciones', JSON.stringify(a.actions.map((x: any) => [x.type, x.status, x.label])));
  script('Ok.');
  await say(C, '¿Ya publicaste main?');
  const hist = chatPrompts().at(-1)!.user.match(/\[acciones: [^\]]*\]/g) ?? [];
  console.log('R4-3 historial que recibe el modelo:', JSON.stringify(hist));
  assert.ok(!hist.some(h => /Publicar main[^\]]*→ hecho/.test(h)), 'el modelo recibe «Publicar main… → hecho» para una publicación que NO se hizo');
  // Lo que ve el modelo (y el propietario) es verdad: pendiente, y se prepara cuando se pida tras integrar (no sola).
  assert.ok(hist.some(h => /Publicar main: pendiente[^\]]*→ No se preparó la tarjeta[^\]]*pide «publica main»/.test(h)), JSON.stringify(hist));
  assert.match(a.actions[1].detail, /no se propone sola/);
});

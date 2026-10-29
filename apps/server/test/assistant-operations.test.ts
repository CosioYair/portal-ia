import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Asistente operativo: «publica main» produce una tarjeta de autorización con lo que se publicaría (calculado en el
 * servidor), rechazar no toca git, autorizar usa el MISMO servicio que el botón del Panel y deja el resultado real y la
 * auditoría. Y el backend del Asistente es explícito: con Claude Code no se usa la API, ni siquiera si no está disponible.
 * Proveedor y CLI SIMULADOS; el «remoto» es un repositorio git local (bare): nada sale del equipo.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-asop-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-asop-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = () => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];
const apiCalls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, INTERNAL_WORKSPACE } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, projectsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { resetDetectionCache } = await import('../src/services/claudeCode/detect.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = INTERNAL_WORKSPACE.slug;
const project = projectsRepo(S).list()[0];
const app = await buildApp();
after(async () => { await app.close(); });
const inject = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any });

// Repositorio con remoto «bare» local: 2 commits por publicar y una rama de historia que NO debe publicarse.
const git = (cwd: string, cmd: string) => execSync(`git ${cmd}`, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-asop-remote-')); git(remote, 'init -q --bare -b main');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-asop-repo-'));
fs.writeFileSync(path.join(repo, 'a.txt'), '1\n'); git(repo, 'init -q -b main'); git(repo, 'add -A'); git(repo, 'commit -qm Base');
git(repo, `remote add origin "${remote}"`); git(repo, 'push -q -u origin main');
for (const n of [2, 3]) { fs.writeFileSync(path.join(repo, 'a.txt'), `${n}\n`); git(repo, `commit -qam "Cambio ${n}"`); }
git(repo, 'branch portal-ia/hu-999');
projectsRepo(S).setRepository(project.id, repo, 'main');
const remoteHead = () => git(remote, 'rev-parse main');

function assistantSays(reply: string, actions: unknown[]) {
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: 'publica main', text: `${reply}\n\`\`\`actions\n${JSON.stringify(actions)}\n\`\`\`` }] }));
  try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
const publishReq = [{ type: 'request_operation', capability: 'publish_main', company: S, project: project.slug }];
const ask = async () => (await inject('POST', '/api/assistant/messages', { text: 'Para probar: publica main con los commits pendientes.' })).json();

test('A · «publica main» produce una tarjeta de autorización con lo que se publicaría (no instrucciones de ir al Panel)', async () => {
  assistantSays('Te preparo la publicación de main; revísala y autorízala aquí.', publishReq);
  const r = await ask();
  const op = r.assistant.actions.find((a: any) => a.type === 'propose_operation');
  assert.ok(op, JSON.stringify(r.assistant.actions));
  assert.equal(op.status, 'pending'); assert.equal(op.operation.capability, 'publish_main');
  const details = op.operation.preview.details.join('\n');
  assert.match(details, /2 commit\(s\) por publicar/); assert.match(details, /Cambio 3/); assert.match(details, /Cambio 2/);
  assert.match(details, /sin --force · ninguna otra rama/);
  assert.ok(op.operation.preview.excluded.some((e: string) => /portal-ia\/hu-999/.test(e)), 'la rama de la historia queda fuera');
  assert.equal(remoteHead(), git(repo, 'rev-parse main~2'), 'proponer no publica nada');
});

test('B · rechazar no hace ninguna operación git; y la operación no se puede ejecutar después', async () => {
  assistantSays('Preparado.', publishReq);
  const r = await ask(); const op = r.assistant.actions.find((a: any) => a.type === 'propose_operation');
  const before = remoteHead();
  const rej = await inject('POST', `/api/assistant/messages/${r.assistant.id}/operations/${op.operation.id}/reject`, {});
  assert.equal(rej.statusCode, 200, rej.body);
  assert.equal(rej.json().message.actions.find((a: any) => a.operation?.id === op.operation.id).status, 'rejected');
  assert.equal(remoteHead(), before, 'el remoto no cambió');
  assert.equal((await inject('POST', `/api/assistant/messages/${r.assistant.id}/operations/${op.operation.id}/approve`, { authorized: true })).statusCode, 409, 'una rechazada no se ejecuta');
  assert.equal(remoteHead(), before);
});

test('C · autorizar usa el servicio existente: publica SOLO main, sin forzar, registra el resultado real y la auditoría', async () => {
  assistantSays('Preparado.', publishReq);
  const r = await ask(); const op = r.assistant.actions.find((a: any) => a.type === 'propose_operation');
  const url = `/api/assistant/messages/${r.assistant.id}/operations/${op.operation.id}/approve`;
  assert.equal((await inject('POST', url, {})).statusCode, 403, 'sin autorización explícita no se ejecuta');
  assert.equal((await inject('POST', url, { authorized: true, force: true })).statusCode, 403, 'ni con campos de más');
  const ok = await inject('POST', url, { authorized: true });
  assert.equal(ok.statusCode, 200, ok.body);
  const done = ok.json().message.actions.find((a: any) => a.operation?.id === op.operation.id);
  assert.equal(done.status, 'done', done.detail); assert.match(done.detail, /«main» publicada en origin/);
  assert.equal(remoteHead(), git(repo, 'rev-parse main'), 'el remoto tiene ahora la main local');
  assert.match(done.operation.result.details.join(' '), new RegExp(`origin/main ahora en ${git(repo, 'rev-parse --short main')}`));
  assert.throws(() => git(remote, 'rev-parse --verify -q portal-ia/hu-999'), 'la rama de la historia NO se publicó');
  const audit = workspaceDb(S).prepare(`SELECT kind FROM execution_history WHERE kind LIKE 'policy:git_push%'`).all() as any[];
  assert.ok(audit.some(a => a.kind === 'policy:git_push:granted'), 'queda en la auditoría');
  assert.equal((await inject('POST', url, { authorized: true })).statusCode, 409, 'no se repite');
  // Con todo publicado, una nueva petición se muestra bloqueada («nada que publicar») y no se puede autorizar.
  assistantSays('Preparado.', publishReq);
  const again = (await ask()).assistant.actions.find((a: any) => a.type === 'propose_operation');
  assert.equal(again.status, 'failed'); assert.match(again.detail, /nada que publicar/);
});

test('el catálogo es cerrado: una operación inexistente (p. ej. push forzado o shell) no se prepara ni se ejecuta', async () => {
  assistantSays('Intento.', [{ type: 'request_operation', capability: 'force_push', company: S, project: project.slug }, { type: 'request_operation', capability: 'shell', command: 'git push --force' }]);
  const acts = (await ask()).assistant.actions;
  assert.ok(acts.every((a: any) => a.type !== 'propose_operation' && a.status === 'failed'), JSON.stringify(acts));
});

test('I/J · el backend del Asistente es explícito: con Claude Code no se llama a la API; si no está disponible, se dice (sin API)', async () => {
  const asst = agentsRepo(S).list().find(a => a.key === 'ws-asistente')!;
  const api0 = (await inject('GET', '/api/assistant')).json().info;
  assert.equal(api0.backend, 'api'); assert.equal(api0.billing, 'api'); assert.ok(api0.estimatedPerMessageUsd > 0);
  saveClaudeCodeSettings({ ...getClaudeCodeSettings(), cliPath: FAKE }); scenario({ auth: 'subscription', defaultText: 'Hola desde Claude Code.' }); resetDetectionCache();
  assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true })).statusCode, 200);
  assert.equal((await inject('PUT', `/api/workspaces/${S}/agents/${asst.id}/backend`, { backend: 'claude-code', authorized: true })).statusCode, 200);
  const info = (await inject('GET', '/api/assistant')).json().info;
  assert.equal(info.backendLabel, 'Claude Code — Suscripción'); assert.equal(info.billing, 'subscription'); assert.equal(info.estimatedPerMessageUsd, 0); assert.equal(info.available, true);
  assistantSays('NO debería usarse la API', []);
  const r = await ask();
  assert.equal(r.assistant.content, 'Hola desde Claude Code.'); assert.equal(r.assistant.costUsd, 0);
  assert.equal(apiCalls().length, 0, 'ninguna llamada a la API'); assert.equal(ccRuns().length, 1);
  // Conector desactivado: el Asistente lo dice y NO usa la API en su lugar
  assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: false })).statusCode, 200);
  const off = (await inject('GET', '/api/assistant')).json().info;
  assert.equal(off.available, false); assert.match(off.unavailableReason, /desactivado/);
  const r2 = await ask();
  assert.match(r2.assistant.content, /No pude responder: .*desactivado.*No se ha usado la API/);
  assert.equal(apiCalls().length, 0, 'tampoco ahora');
  // La consola no sirve para el chat (respuesta inmediata): se dice antes de enviar
  assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true })).statusCode, 200);
  assert.equal((await inject('PUT', `/api/workspaces/${S}/agents/${asst.id}/backend`, { backend: 'claude-code-terminal', authorized: true })).statusCode, 200);
  const term = (await inject('GET', '/api/assistant')).json().info;
  assert.equal(term.available, false); assert.match(term.unavailableReason, /consola/);
  await inject('PUT', `/api/workspaces/${S}/agents/${asst.id}/backend`, { backend: 'api' });
});

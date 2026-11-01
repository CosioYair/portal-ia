import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import http from 'node:http';

/**
 * Puerta final antes de activar (encargo «puerta final del Gauntlet»): (1) un lote YA autorizado con integración automática
 * pasa EXPLÍCITAMENTE a «integrar al aceptar» sin reinterpretar nada en silencio, sin des-integrar lo integrado y sin que
 * «Reanudar» integre ni publique; (2) las historias dependientes se PREPARAN sobre la versión verificada de su dependencia
 * (sin integrar), nunca se integran antes que ella y se ponen al día con su versión final sin reimplementarse; (3) vista
 * previa aislada del candidato exacto (Docker sin red, IA simulada) y decisiones ligadas a ese commit. Proveedor SIMULADO
 * (0 USD reales), git real, sandbox de verificación determinista; la vista previa usa el Docker real (obligatorio con
 * PORTAL_REQUIRE_DOCKER=1).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-puerta-final-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.PORTAL_PREVIEW_START_MS = '180000';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { backlogRepo, processesRepo, projectsRepo, claudeCodeRunsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { detectSandbox, runInSandbox } = await import('../src/services/sandbox.ts');
const { batchDeps, finishActivation, scheduleTick, stopBatchScheduler } = await import('../src/services/batchRunner.ts');
const { mergeStory } = await import('../src/services/storyMerge.ts');
const { withRepoLock } = await import('../src/services/repoLock.ts');
const { cleanupPreviews } = await import('../src/services/preview.ts');
const { batchesRepo } = await import('../src/db/batches.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-puerta-repo-'));
const uniq = `puerta-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/route.ts'), "export const route = 'base';\n");
fs.writeFileSync(path.join(repo, 'src/base.ts'), 'export const base = 0;\n');
// Vista previa del proyecto de prueba: sirve el contenido de src/ (lo que dejaría integrar la historia).
fs.writeFileSync(path.join(repo, 'preview.js'), "const http = require('http'); const fs = require('fs'); const path = require('path');\nhttp.createServer((q, s) => { const files = fs.readdirSync('src').sort().map(f => `<li>${f}: <code>${fs.readFileSync(path.join('src', f), 'utf8').trim()}</code></li>`).join(''); s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); s.end(`<!doctype html><html><body><h1>Vista previa</h1><ul>${files}</ul><p>host=${q.headers.host}; sec-fetch-site=${q.headers['sec-fetch-site'] ?? 'ninguna'}</p></body></html>`); }).listen(Number(process.env.PORT), process.env.HOST);\n");
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node -e ""', test: 'node -e ""', build: 'node -e ""', preview: 'node preview.js' } }, null, 2));
fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: uniq, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.0' } } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { stopBatchScheduler(); await cleanupPreviews(() => undefined).catch(() => 0); await app.close(); });

sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { const t = new Date().toISOString(); await new Promise(r => setTimeout(r, 20)); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 20, isolation: 'docker' }; };
let activations = 0;
batchDeps.activate = async () => { activations++; setTimeout(() => { for (const b of batchesRepo(S).active()) if (b.activation?.state === 'requested') void finishActivation(S, b.id).then(() => scheduleTick(S, b.id)); }, 30); };
batchDeps.activation = async () => ({ active: true, runningCommit: 'x', buildCommit: 'x', buildAt: new Date().toISOString(), reason: 'simulado' });
batchDeps.runtimeChecks = async (_pid, checks) => checks.map(check => ({ check, status: 'ok' as const, detail: 'ok', at: new Date().toISOString() }));

const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple; verificación en verde.', findings: [], suggestedTests: [] });
const QA_UNABLE = JSON.stringify({ verdict: 'unable_to_verify', summary: 'Sin evidencia suficiente.', findings: [], suggestedTests: [] });
const plan = (...files: string[]) => JSON.stringify({ summary: `Cambiar ${files.join(', ')}`, tasks: files.map(f => `Cambiar ${f}`), filesToRead: [], filesToChange: files, acceptance: ['el valor cambia'], risks: [] });
const patch = (file: string, from: string, to: string) => `=== RESUMEN ===\nCambia ${file}.\n=== ARCHIVO: ${file} | patch ===\n<<<< BUSCAR\n${from}\n==== REEMPLAZAR\n${to}\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre ${file}. Esperado: cambiado.`;
const create = (file: string, content: string) => `=== RESUMEN ===\nCrea ${file}.\n=== ARCHIVO: ${file} | create ===\n${content}\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre ${file}. Esperado: existe.`;
let rules: Record<string, unknown>[] = [];
const setScript = (extra: Record<string, unknown>[]) => { rules = [...extra, { match: 'Evalúa la implementación con la EVIDENCIA real', text: QA_OK }]; fs.writeFileSync(scriptPath, JSON.stringify({ rules, markers: [] })); };
const addRules = (extra: Record<string, unknown>[]) => { rules = [...extra, ...rules]; fs.writeFileSync(scriptPath, JSON.stringify({ rules, markers: [] })); };
resetMockCalls();
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const callsFor = (key: string, what?: RegExp) => calls().filter(c => typeof c.rule === 'string' && c.rule.startsWith(`${key}.*`) && (!what || what.test(c.rule)));
const qaCallsFor = (pid: string) => processesRepo(S).get(pid)!.steps.filter(s => s.role === 'reviewer' && s.status === 'done').length;
const story = (title: string) => backlogRepo(S).get(addManualItem(S, project.id, { title, criterion: 'el valor cambia' }).id)!;
const get = async (id: string) => (await app.inject({ method: 'GET', url: `${W}/batches/${id}` })).json();
async function waitFor<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  const show = (x: any) => x && Array.isArray(x.items) ? JSON.stringify({ status: x.status, reason: x.reason, items: x.items.map((i: any) => [i.storyId, i.title, i.state, i.reason, i.freshness?.status ?? null, i.process?.pipeline?.pauseKind ?? null, i.process?.status ?? null]), events: x.events.slice(-25).map((e: any) => e.message.slice(0, 220)) }) : JSON.stringify(x).slice(0, 2500);
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what} · ${show(v)}`); await new Promise(r => setTimeout(r, 50)); v = await fn(); }
  return v;
}
const authorize = async (body: Record<string, unknown>) => {
  for (const x of (await app.inject({ method: 'GET', url: `${W}/projects/${project.id}/batches` })).json()) if (x.status === 'running' || x.status === 'paused') await app.inject({ method: 'POST', url: `${W}/batches/${x.id}/cancel` });
  const res = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches`, payload: { authorized: true, totalBudgetUsd: 5, perStoryBudgetUsd: 1, maxCorrections: 2, maxSubscriptionCalls: 400, commands: ['typecheck', 'test', 'build'], git: { merge: true, integration: 'on_acceptance' }, backends: ['api', 'claude_code'], ...body } });
  assert.equal(res.statusCode, 201, res.body); return res.json();
};
const post = async (url: string, payload: Record<string, unknown> = {}, code = 200) => { const r = await app.inject({ method: 'POST', url: `${W}${url}`, payload }); assert.equal(r.statusCode, code, r.body); return r.json(); };
const item = (b: any, key: string) => b.items.find((i: any) => i.title.includes(key));
const mainHead = () => execSync('git rev-parse main', { cwd: repo, encoding: 'utf8' }).trim();
const mainMerges = () => execSync('git log --first-parent --merges --format=%s main', { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const mainFile = (f: string) => execSync(`git show main:${f}`, { cwd: repo, encoding: 'utf8' }).replace(/\r\n/g, '\n');
const close = async (id: string) => { const b = await get(id); if (b.status === 'running' || b.status === 'paused') await app.inject({ method: 'POST', url: `${W}/batches/${id}/cancel` }); };

// ---------------------------------------------------------------- 1 · Lote existente: cambio explícito de política
test('lote existente (como 568c60cb): pasar de integración automática a «integrar al aceptar» es explícito, restringe, conserva lo integrado y la autorización original, y «Reanudar» ya no integra ni publica', async () => {
  const L1 = story('Historia LIMA1'); const L2 = story('Historia LIMA2'); const L3 = story('Historia LIMA3'); const L4 = story('Historia LIMA4');
  setScript([
    { match: 'LIMA1.*Elabora el plan técnico', text: plan('src/lima1.ts') }, { match: 'LIMA1.*Implementa la historia', text: create('src/lima1.ts', 'export const lima1 = 1;') },
    { match: 'LIMA2.*Elabora el plan técnico', text: plan('src/route.ts') }, { match: 'LIMA2.*Implementa la historia', text: patch('src/route.ts', "export const route = 'base';", "export const route = 'l2';") },
    { match: 'LIMA3.*Elabora el plan técnico', text: plan('src/route.ts') }, { match: 'LIMA3.*Implementa la historia', text: patch('src/route.ts', "export const route = 'base';", "export const route = 'l3';") },
    { match: 'LIMA4.*Elabora el plan técnico', text: plan('src/lima4.ts') }, { match: 'LIMA4.*Implementa la historia', text: create('src/lima4.ts', 'export const lima4 = 4;') },
    { match: 'LIMA4.*Evalúa la implementación con la EVIDENCIA real', responses: [{ text: QA_UNABLE }, { text: QA_OK }] }
  ]);
  // Autorizado como el lote real: integrar al terminar cada una (sin el campo `integration`) y activar.
  const b0 = await authorize({ itemIds: [L1.id, L2.id, L3.id, L4.id], title: 'Lote LIMA (como el existente)', concurrency: 3, git: { merge: true, activate: true } });
  assert.equal(b0.auth.git.integration, 'auto'); assert.equal(b0.lifecycle.policy, 'auto');
  const authorizedEvent = b0.events[0].message;
  const stuck = await waitFor(() => get(b0.id), x => item(x, 'LIMA1').state !== 'running' && item(x, 'LIMA4').state === 'needs_owner' && (item(x, 'LIMA2').state === 'needs_owner' || item(x, 'LIMA3').state === 'needs_owner') && !x.items.some((i: any) => i.state === 'integrating' && !i.mergedCommit), 'como el lote real: integradas, un candidato con conflictos y una QA inconclusa', 90_000);
  const loser = ['LIMA2', 'LIMA3'].map(k => item(stuck, k)).find((i: any) => i.state === 'needs_owner');
  const winner = ['LIMA2', 'LIMA3'].map(k => item(stuck, k)).find((i: any) => i !== loser);
  // Como HU-169: el candidato con los conflictos resueltos queda verificado y sin QA.
  const k = loser.title.replace('Historia ', '');
  addRules([{ match: `${k}.*resuelve SOLO los conflictos`, text: `=== RESUMEN ===\nAmbas.\n=== ARCHIVO: src/route.ts | create ===\nexport const route = 'l2';\nexport const routeB = 'l3';\n=== FIN ARCHIVO ===\n` }]);
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${loser.processId}/integration/resolve`, payload: { authorized: true } })).statusCode, 200);
  await waitFor(() => processesRepo(S).get(loser.processId)!, p => p.status !== 'running' && p.result?.pipeline?.pauseKind === 'integration', 'candidato verificado sin QA');
  const main0 = mainHead(); const merges0 = mainMerges().length; const calls0 = calls().length; const act0 = activations; const ccRuns0 = claudeCodeRunsRepo(S).countForProcesses((await get(b0.id)).items.flatMap((i: any) => i.processIds));

  // Vista previa del cambio (sin cambiar nada): qué hará «Reanudar» AHORA (integra sin revisión) y DESPUÉS (queda lista).
  const view = (await app.inject({ method: 'GET', url: `${W}/batches/${b0.id}/policy` })).json();
  assert.equal(view.policy, 'auto'); assert.equal(view.canChange, true, view.blockedBy);
  const integrated = view.alreadyIntegrated.map((a: any) => a.storyId).sort();
  assert.deepEqual(integrated, [item(stuck, 'LIMA1').storyId, winner.storyId].sort(), 'lo ya integrado se lista como tal');
  assert.ok(view.resumeNow.some((r: any) => r.storyId === loser.storyId && /se integra en main.*SIN esperar tu revisión/.test(r.effect)), JSON.stringify(view.resumeNow));
  assert.ok(view.resumeAfter.every((r: any) => /lista para tu revisión, sin integrar/.test(r.effect)), JSON.stringify(view.resumeAfter));
  assert.equal((await get(b0.id)).auth.git.integration, 'auto', 'ver la vista previa no cambia nada');

  // Explícito y solo restringe: sin confirmar, 400; añadir publicar, 409.
  assert.equal((await app.inject({ method: 'POST', url: `${W}/batches/${b0.id}/policy`, payload: { integration: 'on_acceptance', publish: false, activate: true } })).statusCode, 400);
  await post(`/batches/${b0.id}/policy`, { authorized: true, integration: 'on_acceptance', publish: true, activate: true }, 409);
  const changed = await post(`/batches/${b0.id}/policy`, { authorized: true, integration: 'on_acceptance', publish: false, activate: false, note: 'Quiero revisar cada historia antes de main.' });
  assert.equal(changed.auth.git.integration, 'on_acceptance'); assert.equal(changed.auth.git.activate, false); assert.equal(changed.auth.git.merge, true);
  assert.equal(changed.policyHistory.length, 1);
  const h = changed.policyHistory[0];
  assert.equal(h.from.integration ?? 'auto', 'auto', 'la autorización original queda registrada tal cual'); assert.equal(h.from.activate, true); assert.equal(h.to.integration, 'on_acceptance');
  assert.deepEqual(h.alreadyIntegrated.map((a: any) => a.storyId).sort(), integrated);
  assert.equal(changed.events[0].message, authorizedEvent, 'el evento de autorización original no se reescribe');
  assert.ok(changed.events.some((e: any) => e.kind === 'policy' && /decisión explícita/.test(e.message) && /no se des-integran/.test(e.message)));
  assert.equal(item(changed, 'LIMA1').state, 'awaiting_acceptance', 'lo integrado no se des-integra');
  assert.equal(calls().length, calls0, 'cambiar la política no llama a la IA');
  assert.equal(claudeCodeRunsRepo(S).countForProcesses(changed.items.flatMap((i: any) => i.processIds)), ccRuns0, 'el registro de uso de la suscripción no cambia');
  // Otra vez: ya está al aceptar (409).
  await post(`/batches/${b0.id}/policy`, { authorized: true, integration: 'on_acceptance', publish: false, activate: false }, 409);

  // «Reanudar» con la política que tenías delante: si no coincide, no reanuda.
  await post(`/batches/${b0.id}/resume`, { authorized: true, expectPolicy: 'auto' }, 409);
  await post(`/batches/${b0.id}/resume`, { authorized: true, expectPolicy: 'on_acceptance' });
  const resumed = await waitFor(() => get(b0.id), x => item(x, loser.title.replace('Historia ', '')).state === 'ready' && item(x, 'LIMA4').state === 'ready', 'el candidato y la de QA quedan LISTAS, sin integrar', 90_000);
  assert.equal(mainHead(), main0, 'nada entró en main al reanudar'); assert.equal(mainMerges().length, merges0);
  assert.equal(activations, act0, 'nada se activó');
  assert.ok(resumed.items.every((i: any) => !processesRepo(S).get(i.processId ?? '')?.result?.published), 'nada se publicó');
  assert.equal(callsFor(k, /Implementa la historia|plan técnico/).length, 1 + 1, 'ni plan ni implementación repetidos (uno de cada)');

  // Reconocer lo ya integrado ≠ aceptar para integrar.
  const ack = await post(`/batches/${b0.id}/accept`, { itemIds: [item(resumed, 'LIMA1').itemId] });
  assert.equal(item(ack, 'LIMA1').state, 'accepted'); assert.equal(item(ack, 'LIMA1').acceptance.kind, 'acknowledged');
  assert.ok(ack.events.some((e: any) => e.itemId === item(ack, 'LIMA1').itemId && /reconocida y aceptada por ti: ya estaba integrada en main/.test(e.message)));
  assert.equal(mainHead(), main0);
  // Aceptar el candidato ligado al commit que revisaste: con otro commit, 409; con el suyo, entra en main una vez.
  const l = item(ack, k); const head = processesRepo(S).get(l.processId)!.result!.applied!.commit;
  await post(`/batches/${b0.id}/accept`, { itemIds: [l.itemId], revisions: { [l.itemId]: 'deadbee' } }, 409);
  await post(`/batches/${b0.id}/accept`, { itemIds: [l.itemId], revisions: { [l.itemId]: head } });
  const inMain = await waitFor(() => get(b0.id), x => item(x, k).state === 'accepted', 'aceptada e integrada', 90_000);
  assert.equal(item(inMain, k).acceptance.kind, 'integrate'); assert.equal(item(inMain, k).acceptance.revision, head);
  assert.equal(mainMerges().length, merges0 + 1, 'una integración, una vez');
  assert.equal(activations, act0, 'sin «activar» (quitado al cambiar la política)');
  await close(b0.id);
});

test('cambio de política con una integración automática en curso: se rechaza (no se cambia a medias); una pausa mientras espera el carril veta el merge', async () => {
  const M = story('Historia MIKE');
  setScript([{ match: 'MIKE.*Elabora el plan técnico', text: plan('src/mike.ts') }, { match: 'MIKE.*Implementa la historia', text: create('src/mike.ts', 'export const mike = 1;') }, { match: 'MIKE.*Evalúa la implementación con la EVIDENCIA real', delayMs: 1500, text: QA_OK }]);
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  let entered!: () => void; const inLock = new Promise<void>(r => { entered = r; });
  const b0 = await authorize({ itemIds: [M.id], title: 'Lote MIKE', git: { merge: true } });
  // Con la historia ya aplicada (QA en curso), alguien (otra integración, una reconstrucción) ocupa el carril del repositorio.
  const applied = await waitFor(() => get(b0.id), x => !!x.items[0].processId && !!processesRepo(S).get(x.items[0].processId)?.result?.applied, 'cambios aplicados', 60_000);
  void applied;
  const lockJob = withRepoLock(repo, async () => { entered(); await held; });
  await inLock;
  let main0 = '';
  try {
  await waitFor(() => get(b0.id), x => x.items[0].state === 'integrating', 'integrándose (espera el carril)', 60_000);
  await new Promise(r => setTimeout(r, 200));
  const r = await app.inject({ method: 'POST', url: `${W}/batches/${b0.id}/policy`, payload: { authorized: true, integration: 'on_acceptance', publish: false, activate: false } });
  assert.equal(r.statusCode, 409, r.body); assert.match(r.json().error, /integración en curso/);
  main0 = mainHead();
  await post(`/batches/${b0.id}/pause`);
  release(); await lockJob;
  } finally { release(); }
  const after1 = await waitFor(() => get(b0.id), x => x.items[0].state !== 'integrating', 'el merge se vetó dentro del carril', 60_000);
  assert.equal(mainHead(), main0, 'con el lote en pausa, nada entró en main'); assert.equal(after1.items[0].state, 'awaiting_integration');
  // Con la integración ya resuelta, el cambio de política se permite y la deja lista (sin integrar).
  const changed = await post(`/batches/${b0.id}/policy`, { authorized: true, integration: 'on_acceptance', publish: false, activate: false });
  assert.equal(changed.items[0].state, 'ready'); assert.equal(mainHead(), main0);
  // El veto de quien integra se evalúa DENTRO del carril, justo antes del merge: si dice que no, main no cambia.
  await assert.rejects(mergeStory(S, changed.items[0].processId, { guard: () => 'cambió la política' }), (e: any) => e.code === 'integration_vetoed');
  assert.equal(mainHead(), main0);
  await close(b0.id);
});

// ---------------------------------------------------------------- 2 + 3 · Cinco historias, una dependiente, vista previa
const requireDocker = process.env.PORTAL_REQUIRE_DOCKER === '1';
const dockerReady = (await detectSandbox(true)).available === 'docker';

test('cinco historias, la 2 depende de la 1: todo lo preparable se termina; vista previa aislada de la 1; cambios; la 1 entra en main; la 2 se pone al día con su versión final (sin reimplementarse, QA otra vez); las demás siguen; nada dos veces ni publicado', { skip: dockerReady || requireDocker ? false : 'Docker no disponible (obligatorio con PORTAL_REQUIRE_DOCKER=1)' }, async () => {
  const keys = ['ROMEO', 'SIERRA', 'VICTOR', 'WHISKY', 'YANQUI'];
  const its = keys.map(k => story(`Historia ${k}`));
  backlogRepo(S).update(its[1].id, { dependsOn: its[0].storyId });
  setScript([
    { match: 'ROMEO.*Elabora el plan técnico', text: plan('src/romeo.ts') }, { match: 'ROMEO.*Implementa la historia', text: create('src/romeo.ts', 'export const romeo = 1;') },
    { match: 'SIERRA.*Elabora el plan técnico', text: plan('src/sierra.ts') }, { match: 'SIERRA.*Implementa la historia', text: create('src/sierra.ts', "import { romeo } from './romeo.ts';\nexport const sierra = romeo + 1;") },
    ...['VICTOR', 'WHISKY', 'YANQUI'].flatMap((k, n) => [{ match: `${k}.*Elabora el plan técnico`, text: plan(`src/${k.toLowerCase()}.ts`) }, { match: `${k}.*Implementa la historia`, text: create(`src/${k.toLowerCase()}.ts`, `export const ${k.toLowerCase()} = ${n + 3};`) }])
  ]);
  const main0 = mainHead(); const merges0 = mainMerges().length; const act0 = activations;
  const b0 = await authorize({ itemIds: its.map(i => i.id), title: 'Lote CINCO', concurrency: 2 });
  assert.equal(b0.auth.git.prepareDependents, true, 'al aceptar: las dependientes se preparan por defecto');
  // 3 · Todo lo preparable termina: la 2 SOBRE la versión verificada de la 1, sin integrar y sin presentarse como lista.
  const prep = await waitFor(() => get(b0.id), x => ['ROMEO', 'VICTOR', 'WHISKY', 'YANQUI'].every(k => item(x, k).state === 'ready' && item(x, k).freshness) && item(x, 'SIERRA').state === 'prepared', 'cuatro listas y la dependiente preparada', 120_000);
  assert.equal(mainHead(), main0, 'nada en main sin tu aceptación');
  const one = item(prep, 'ROMEO'); const two = item(prep, 'SIERRA');
  const p1 = processesRepo(S).get(one.processId)!; const p2 = processesRepo(S).get(two.processId)!;
  assert.equal(p2.result!.stack!.storyId, one.storyId); assert.ok(p2.result!.stack!.commit.startsWith(p1.result!.applied!.commit), 'preparada sobre el commit verificado de la 1');
  assert.deepEqual(p2.result!.changes.map(c => c.path), ['src/sierra.ts'], 'su diff (QA, huella) es solo suyo: no incluye la dependencia');
  assert.equal(prep.lifecycle.counts.prepared, 1); assert.equal(prep.lifecycle.readyForOwner, 4);
  assert.match(prep.lifecycle.headline, /1 preparada sobre su dependencia/);
  assert.equal(two.stackInfo.storyId, one.storyId);
  await post(`/batches/${b0.id}/accept`, { itemIds: [two.itemId] }, 409);
  const mergeTwo = await app.inject({ method: 'POST', url: `${W}/processes/${two.processId}/merge`, payload: { authorized: true } });
  assert.equal(mergeTwo.statusCode, 409); assert.equal(mainHead(), main0, 'integrarla a mano antes que su dependencia se rechaza');
  const impl2 = callsFor('SIERRA', /Implementa la historia/).length; assert.equal(impl2, 1);

  // 4–5 · Revisas la 1 con su vista previa aislada (Docker sin red, IA simulada) del commit exacto (+ main).
  const wt1 = p1.result!.applied!.worktree!;
  const inst = await runInSandbox(wt1, repo, 'install', { allowNetwork: false });
  assert.equal(inst.exitCode, 0, inst.output.slice(-800));
  const callsBeforePreview = calls().length;
  const pv0 = await post(`/processes/${one.processId}/previews`, {}, 202);
  assert.equal(pv0.status, 'starting'); assert.ok(p1.result!.applied!.commit.startsWith(pv0.commit) || pv0.commit.startsWith(p1.result!.applied!.commit.slice(0, 7)));
  assert.equal(pv0.combined, true); assert.equal(pv0.profile, 'script');
  const ready1 = await waitFor(async () => (await app.inject({ method: 'GET', url: `${W}/processes/${one.processId}/previews` })).json(), (l: any[]) => l.at(-1)?.status === 'ready' || l.at(-1)?.status === 'failed', 'vista previa lista', 180_000);
  const pv = ready1.at(-1);
  assert.equal(pv.status, 'ready', `${pv.reason} ${pv.logTail}`); assert.match(pv.url, /^http:\/\/127\.0\.0\.2:\d+\/$/);
  const page = await fetch(pv.url); const html = await page.text();
  assert.match(html, /romeo\.ts: <code>export const romeo = 1;<\/code>/, 'se ve el candidato'); assert.match(html, /base\.ts/, 'con main');
  assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self'/); assert.match(page.headers.get('content-security-policy') ?? '', /worker-src 'none'/);
  assert.match(page.headers.get('content-security-policy') ?? '', /sandbox allow-scripts/); assert.match(page.headers.get('permissions-policy') ?? '', /camera=\(\)/);
  assert.equal(page.headers.get('set-cookie'), null); assert.match(html, /Vista previa aislada · candidato .* NO es el Portal en marcha/, 'franja visible: no es el Portal en marcha');
  // El candidato recibe el Host de la vista previa (local y de su mismo origen) y ninguna Sec-Fetch: un Portal candidato con
  // las comprobaciones de Host/Origen sirve su API y no muestra el aviso de «Portal en marcha» (ronda 3 del Gauntlet).
  const seen = await (await fetch(pv.url, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })).text();
  assert.match(seen, new RegExp(`host=${pv.url.replace(/^http:\/\//, '').replace(/\/$/, '').replace(/\./g, '\\.')}; sec-fetch-site=ninguna`));
  // Proxy: otro Host (una página que «se reasigne» a 127.0.0.2) no lee nada.
  const u = new URL(pv.url);
  const rebind = await new Promise<number>(res => { http.get({ host: u.hostname, port: Number(u.port), path: '/', headers: { host: 'atacante.example:80' } }, r => { r.resume(); res(r.statusCode ?? 0); }).on('error', () => res(0)); });
  assert.equal(rebind, 403, 'el proxy rechaza un Host ajeno');
  // Portal en marcha: la API no atiende un Host ajeno (DNS rebinding) y avisa al llegar desde otro sitio.
  assert.equal((await app.inject({ method: 'GET', url: `${W}/batches/${b0.id}`, headers: { host: 'atacante.example:4310' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/%61pi/workspaces/${S}/batches/${b0.id}`, headers: { host: 'atacante.example:4310' } })).statusCode, 403, 'una ruta codificada no salta la comprobación del Host');
  const inter = await app.inject({ method: 'GET', url: '/lotes', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
  assert.match(inter.body, /Estás entrando en el Portal IA EN MARCHA/);
  // La página de la vista previa no puede cambiar nada del Portal (otro origen): rechazado.
  const foreign = await app.inject({ method: 'POST', url: `${W}/batches/${b0.id}/pause`, headers: { origin: pv.url.replace(/\/$/, '') }, payload: {} });
  assert.equal(foreign.statusCode, 403, foreign.body);
  const bView = await get(b0.id);
  assert.equal(item(bView, 'ROMEO').preview.live, true); assert.equal(item(bView, 'ROMEO').preview.outdated, false);
  assert.equal(calls().length, callsBeforePreview, 'la vista previa no llama a la IA');

  // 6–8 · Pides cambios sobre el commit que probaste: misma rama, una corrección, re-verificada y aprobada.
  addRules([{ match: 'ROMEO.*Corrige la implementación', text: patch('src/romeo.ts', 'export const romeo = 1;', 'export const romeo = 10;') }]);
  await post(`/batches/${b0.id}/items/${one.itemId}/iterate`, { authorized: true, note: 'romeo debe valer 10', revision: 'deadbee' }, 409);
  await post(`/batches/${b0.id}/items/${one.itemId}/iterate`, { authorized: true, note: 'romeo debe valer 10', revision: p1.result!.applied!.commit });
  const again1 = await waitFor(() => get(b0.id), x => item(x, 'ROMEO').state === 'ready' && !!item(x, 'ROMEO').freshness && item(x, 'ROMEO').evidence?.head !== p1.result!.applied!.commit, 'la 1 lista otra vez con los cambios', 120_000);
  assert.equal(item(again1, 'ROMEO').processId, one.processId, 'misma ejecución');
  assert.equal(item(again1, 'ROMEO').preview.outdated, true, 'la vista previa abierta queda desactualizada (es del commit anterior)');
  assert.equal(item(again1, 'SIERRA').state, 'prepared'); assert.equal(item(again1, 'SIERRA').stackInfo.moved, true, 'la 2 sabe que su dependencia cambió');
  assert.equal(callsFor('SIERRA', /Implementa la historia/).length, impl2, 'la 2 no se reimplementa por cambiar la 1');
  const stopped = (await app.inject({ method: 'DELETE', url: `${W}/processes/${one.processId}/previews/${pv.id}` })).json();
  assert.equal(stopped.status, 'stopped'); assert.ok(fs.existsSync(wt1), 'detenerla no toca el worktree');
  assert.equal(execSync('docker ps -aq --filter label=portal-ia.preview=' + pv.id, { encoding: 'utf8' }).trim(), '', 'sin contenedores de la vista previa');
  assert.ok(processesRepo(S).get(one.processId)!.result!.previews!.some(x => x.id === pv.id && x.status === 'stopped'), 'queda como evidencia');

  // 9 · Aceptas la 1 (el commit nuevo) → entra en main.
  const head1 = item(again1, 'ROMEO').evidence.head;
  await post(`/batches/${b0.id}/accept`, { itemIds: [one.itemId], revisions: { [one.itemId]: head1 } });
  await waitFor(() => get(b0.id), x => item(x, 'ROMEO').state === 'accepted', 'la 1 integrada', 90_000);
  assert.equal(mainFile('src/romeo.ts'), 'export const romeo = 10;\n');
  // 10–11 · La 2 se pone al día con la versión FINAL de la 1 (git + sandbox + QA otra vez), sin reimplementarse.
  const qa2 = qaCallsFor(two.processId);
  const ready2 = await waitFor(() => get(b0.id), x => item(x, 'SIERRA').state === 'ready' && item(x, 'SIERRA').freshness?.status === 'current', 'la 2 al día con la 1 integrada', 120_000);
  assert.ok(ready2.events.some((e: any) => e.itemId === two.itemId && /su dependencia .* ya está en main/.test(e.message)));
  assert.equal(callsFor('SIERRA', /Implementa la historia/).length, impl2, 'sin reimplementar'); assert.equal(callsFor('SIERRA', /plan técnico/).length, 1, 'sin plan nuevo');
  assert.equal(qaCallsFor(two.processId), qa2 + 1, 'QA revisó otra vez el commit nuevo (la dependencia cambió)');
  const p2b = processesRepo(S).get(two.processId)!;
  const br2 = p2b.result!.applied!.branch;
  assert.match(execSync(`git show ${br2}:src/romeo.ts`, { cwd: repo, encoding: 'utf8' }), /romeo = 10/, 'su rama tiene la versión final de la 1');
  assert.deepEqual(p2b.result!.changes.map(c => c.path), ['src/sierra.ts']);
  // 12 · Vista previa y aceptación de la 2 (ya sin versión provisional).
  const pv2 = await post(`/processes/${two.processId}/previews`, {}, 202);
  assert.equal(pv2.includesProvisional, null);
  const r2 = await waitFor(async () => (await app.inject({ method: 'GET', url: `${W}/processes/${two.processId}/previews` })).json(), (l: any[]) => ['ready', 'failed'].includes(l.at(-1)?.status), 'vista previa de la 2', 180_000);
  assert.equal(r2.at(-1).status, 'ready', r2.at(-1).logTail);
  assert.match(await (await fetch(r2.at(-1).url)).text(), /sierra\.ts: <code>import \{ romeo \}/);
  await app.inject({ method: 'DELETE', url: `${W}/processes/${two.processId}/previews/${pv2.id}` });
  await post(`/batches/${b0.id}/accept`, { itemIds: [two.itemId], revisions: { [two.itemId]: item(ready2, 'SIERRA').evidence.head } });
  await waitFor(() => get(b0.id), x => item(x, 'SIERRA').state === 'accepted', 'la 2 integrada', 90_000);
  // 13 · Las independientes siguen sin verse afectadas.
  for (const k of ['VICTOR', 'WHISKY', 'YANQUI']) {
    const x = await waitFor(() => get(b0.id), b => item(b, k).state === 'ready' && !!item(b, k).freshness, `${k} lista`, 60_000);
    await post(`/batches/${b0.id}/accept`, { itemIds: [item(x, k).itemId] });
    await waitFor(() => get(b0.id), b => item(b, k).state === 'accepted', `${k} integrada`, 90_000);
  }
  // 14–15 · Registro completo; ninguna integración dos veces; nada publicado; ninguna llamada inesperada.
  const done = await waitFor(() => get(b0.id), x => x.status === 'completed', 'lote CINCO terminado', 60_000);
  assert.equal(mainMerges().length - merges0, 5, 'cinco integraciones, ninguna dos veces');
  assert.equal(done.items.filter((i: any) => i.acceptance?.kind === 'integrate').length, 5);
  assert.ok(done.items.every((i: any) => !processesRepo(S).get(i.processId)!.result!.published), 'nada publicado');
  assert.equal(activations, act0, 'nada se activó (proyecto con activar desmarcado)');
  for (const k of keys) assert.equal(callsFor(k, /Implementa la historia/).length, 1, `${k}: una implementación`);
  assert.equal(callsFor('ROMEO', /Corrige la implementación/).length, 1);
  assert.ok(done.events.some((e: any) => /se preparará sobre la versión provisional/.test(e.message)));
  assert.equal(mainFile('src/sierra.ts').replace(/\r\n/g, '\n'), "import { romeo } from './romeo.ts';\nexport const sierra = romeo + 1;\n");
});

test('la dependencia se rehace desde cero: lo preparado sobre su versión anterior se detiene y nunca entra en main (merge y candidato rechazados)', async () => {
  const P = story('Historia PAPA'); const D = story('Historia DELTAP');
  backlogRepo(S).update(D.id, { dependsOn: P.storyId });
  setScript([
    { match: 'PAPA.*Elabora el plan técnico', text: plan('src/papa.ts') }, { match: 'PAPA.*Implementa la historia', text: create('src/papa.ts', 'export const papa = 1;') },
    { match: 'DELTAP.*Elabora el plan técnico', text: plan('src/deltap.ts') }, { match: 'DELTAP.*Implementa la historia', text: create('src/deltap.ts', 'export const deltap = 2;') }
  ]);
  const b0 = await authorize({ itemIds: [P.id, D.id], title: 'Lote PAPA', concurrency: 2 });
  const r = await waitFor(() => get(b0.id), x => item(x, 'PAPA').state === 'ready' && item(x, 'DELTAP').state === 'prepared', 'P lista y D preparada', 90_000);
  const p = item(r, 'PAPA'); const d = item(r, 'DELTAP');
  // P espera una respuesta tuya: «Iterar» no puede ser una ronda sobre su rama y la rehace desde main.
  const pp = processesRepo(S).get(p.processId)!;
  processesRepo(S).setResult(p.processId, { ...pp.result!, pipeline: { ...pp.result!.pipeline!, state: 'paused', pauseKind: 'missing_information' as any, ownerRequest: { question: '¿Qué valor?', options: [], askedAt: new Date().toISOString() } as any } });
  const it = await post(`/batches/${b0.id}/items/${p.itemId}/iterate`, { authorized: true, note: 'Rehazla con otro enfoque' });
  assert.equal(item(it, 'DELTAP').state, 'needs_owner', JSON.stringify({ p: item(it, 'PAPA'), d: item(it, 'DELTAP'), ev: it.events.slice(-6).map((e: any) => e.message) }).slice(0, 3000)); assert.equal(item(it, 'DELTAP').failureClass, 'dependency');
  assert.match(item(it, 'DELTAP').stackInfo.invalid, /se rehace desde main/);
  // Hallazgo (revisión del código): la siguiente pasada del coordinador no debe devolverla a «preparada» en silencio.
  await scheduleTick(S, b0.id); await new Promise(r => setTimeout(r, 300)); await scheduleTick(S, b0.id);
  const again = await get(b0.id);
  assert.equal(item(again, 'DELTAP').state, 'needs_owner', item(again, 'DELTAP').reason); assert.ok(item(again, 'DELTAP').stackInfo.invalid);
  const main0 = mainHead();
  const m = await app.inject({ method: 'POST', url: `${W}/processes/${d.processId}/merge`, payload: { authorized: true } });
  assert.equal(m.statusCode, 409); assert.equal(m.json().code, 'stack_base_not_integrated', m.body);
  const c = await app.inject({ method: 'POST', url: `${W}/processes/${d.processId}/integration/prepare`, payload: { authorized: true } });
  assert.equal(c.statusCode, 409, c.body);
  assert.equal(mainHead(), main0, 'nada de la versión provisional entró en main');
  await close(b0.id);
});

test('con «activar» y al aceptar: una historia integrada a mano desde su proceso (sin tu aceptación del lote) no se queda «integrándose» ni bloquea el lote', async () => {
  const O = story('Historia OSCARM'); const Q = story('Historia QUEBECM');
  setScript([{ match: 'OSCARM.*Elabora el plan técnico', text: plan('src/oscarm.ts') }, { match: 'OSCARM.*Implementa la historia', text: create('src/oscarm.ts', 'export const oscarm = 1;') }, { match: 'QUEBECM.*Elabora el plan técnico', text: plan('src/quebecm.ts') }, { match: 'QUEBECM.*Implementa la historia', text: create('src/quebecm.ts', 'export const quebecm = 1;') }]);
  const b0 = await authorize({ itemIds: [O.id, Q.id], title: 'Lote OSCAR', concurrency: 1, git: { merge: true, integration: 'on_acceptance', activate: true } });
  const r = await waitFor(() => get(b0.id), x => item(x, 'OSCARM').state === 'ready' && !!item(x, 'OSCARM').freshness, 'OSCARM lista', 90_000);
  const act0 = activations;
  const m = await app.inject({ method: 'POST', url: `${W}/processes/${item(r, 'OSCARM').processId}/merge`, payload: { authorized: true } });
  assert.equal(m.statusCode, 200, m.body);
  await scheduleTick(S, b0.id);
  const x = await waitFor(() => get(b0.id), b => item(b, 'OSCARM').state === 'awaiting_acceptance' && item(b, 'QUEBECM').state === 'ready', 'integrada a mano: pendiente de tu aceptación, y el lote sigue', 90_000);
  assert.equal(activations, act0, 'no se activa (reinicia) por una historia que no aceptaste en el lote');
  void x; await close(b0.id);
});

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Lote con integración al aceptar (encargo «empresa autónoma», partes I–III): el equipo termina técnicamente TODO el lote
 * antes de tu aceptación; cada historia entra en main al aceptarla, en un orden de integración explicado (no el de los
 * identificadores); las siguientes se ponen al día con lo integrado (git, sandbox y QA) antes de presentártelas; pedir
 * cambios trabaja sobre la MISMA rama; los conflictos reales los resuelve el agente autorizado (una llamada) o decides tú;
 * nada se integra sin tu aceptación ni dos veces; un reinicio a mitad no da por vigente lo que no lo es. Proveedor
 * SIMULADO (0 USD), git real, sandbox determinista sustituido, nada real se reinicia.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-lote-acept-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, integrationOrder, batchLifecycle, mentionedFiles } = await import('@portal-ia/domain');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { backlogRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { batchDeps, forgetBatchJobs, resumeBatches, scheduleTick, stopBatchScheduler } = await import('../src/services/batchRunner.ts');
const { batchesRepo } = await import('../src/db/batches.ts');
const { prepareOwnerRound } = await import('../src/services/storyUnits.ts');
const { predictFiles, storyPatchId } = await import('../src/services/batchIntegration.ts');
const { recoverInterruptedProcesses } = await import('../src/services/interruptions.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;

// ---------- Unidades (sin IA, sin E/S) ----------
test('orden de integración: dependencias, dependencias implícitas y lo transversal primero; explicado y distinto del orden de identificadores', () => {
  const i = (storyId: string, ownerOrder: number, files: string[], extra: Record<string, unknown> = {}) => ({ itemId: storyId, storyId, title: storyId, dependsOn: null, ownerOrder, files, basis: 'actual' as const, ...extra });
  const plan = integrationOrder([
    i('HU-1', 0, ['src/a.ts'], { adds: ['src/widget.ts', 'src/a.ts'] }),
    i('HU-2', 1, ['src/b.ts', 'src/shared.css']),
    i('HU-3', 2, ['packages/domain/src/types.ts', 'src/shared.css', 'src/c.ts']),
    i('HU-4', 3, ['src/d.ts'], { dependsOn: 'HU-5' }),
    i('HU-5', 4, ['src/e.ts']),
    i('HU-6', 5, ['src/f.ts'], { mentions: ['widget.ts'] })
  ]);
  const pos = (id: string) => plan.order.indexOf(id);
  assert.ok(pos('HU-3') < pos('HU-2'), 'la transversal (toca tipos compartidos) antes que la que comparte styles con ella, aunque la elegiste después');
  assert.ok(pos('HU-5') < pos('HU-4'), 'la dependencia declarada antes');
  assert.ok(pos('HU-1') < pos('HU-6'), 'dependencia implícita: HU-6 menciona un archivo que crea HU-1');
  assert.notDeepEqual(plan.order, ['HU-1', 'HU-2', 'HU-3', 'HU-4', 'HU-5', 'HU-6'], 'no es el orden de los identificadores');
  assert.ok(plan.notes.some(n => n.itemId === 'HU-3' && /Antes que HU-2 .*transversal/.test(n.text)), JSON.stringify(plan.notes));
  assert.ok(plan.notes.some(n => n.itemId === 'HU-6' && /dependencia implícita/.test(n.text)));
  assert.ok(plan.notes.some(n => n.itemId === 'HU-4' && /dependencia declarada/.test(n.text)));
  assert.deepEqual(plan.overlaps.map(o => [o.a, o.b, o.files]), [['HU-2', 'HU-3', ['src/shared.css']]]);
  assert.deepEqual(mentionedFiles('Migrar `styles.css` y apps/web/src/screens/Backlog.tsx (ver «tokens.css»).').sort(), ['apps/web/src/screens/Backlog.tsx', 'styles.css', 'tokens.css']);
  assert.deepEqual(predictFiles('Cambia Backlog.tsx y styles.css', ['apps/web/src/screens/Backlog.tsx', 'apps/web/src/styles.css', 'x/styles.css', 'y/styles.css', 'z/styles.css', 'w/styles.css']), ['apps/web/src/screens/Backlog.tsx'], 'un nombre ambiguo (más de 3 coincidencias) no se adivina');
});

test('ciclo de vida del lote: «técnicamente completo» distingue lo listo, las decisiones de negocio y los bloqueos técnicos; no termina con trabajo pendiente', () => {
  const it = (n: number, state: any, failureClass: any = null) => ({ itemId: `i${n}`, storyId: `HU-${n}`, state, failureClass, dependsOn: null, dependsInBatch: false });
  const items = [...Array.from({ length: 10 }, (_, n) => it(n, 'ready')), it(10, 'needs_owner', 'owner_decision'), it(11, 'failed', 'failure')];
  const life = batchLifecycle(items, 'on_acceptance', ['i3', 'i0']);
  assert.equal(life.phase, 'acceptance'); assert.equal(life.technicallyComplete, true);
  assert.equal(life.headline, 'Lote técnicamente completo: 12 historias — 10 listas para tu aceptación (sin integrar), 1 requiere una decisión tuya, 1 bloqueada por un problema técnico.');
  assert.equal(life.next, 'i3', 'la siguiente a revisar sigue el orden de integración');
  assert.equal(batchLifecycle([it(0, 'running'), it(1, 'ready')], 'on_acceptance').phase, 'technical');
  assert.equal(batchLifecycle([it(0, 'accepted'), it(1, 'integrating')], 'on_acceptance').phase, 'integrating');
  assert.equal(batchLifecycle([it(0, 'accepted'), it(1, 'postponed'), it(2, 'rejected')], 'on_acceptance').phase, 'done');
  assert.notEqual(batchLifecycle([it(0, 'accepted'), it(1, 'failed')], 'on_acceptance').phase, 'done', 'un bloqueo técnico sin resolver no deja el lote por terminado');
});

// ---------- Entorno ----------
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-lote-acept-repo-'));
const uniq = `acept-${Date.now().toString(36)}`;
const LINES = (prefix: string, n: number) => Array.from({ length: n }, (_, k) => `export const ${prefix}${k + 1} = 0;\n// --\n`).join('');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/shared.ts'), LINES('s', 5));
fs.writeFileSync(path.join(repo, 'src/route.ts'), "export const route = 'base';\n");
fs.writeFileSync(path.join(repo, 'src/route2.ts'), "export const route2 = 'base';\n");
fs.writeFileSync(path.join(repo, 'src/shared2.ts'), LINES('m', 2));
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node -e ""', test: 'node -e ""', build: 'node -e ""' } }, null, 2));
fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: uniq, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.0' } } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { stopBatchScheduler(); await app.close(); });

let hangOn: { file: string; entered: () => void } | null = null;
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (wt, _root, command) => {
  const t = new Date().toISOString();
  if (hangOn && command === 'test' && fs.existsSync(path.join(wt, hangOn.file))) { const h = hangOn; hangOn = null; h.entered(); return new Promise(() => { /* el Portal «se reinicia» aquí */ }); }
  await new Promise(r => setTimeout(r, 20));
  return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 20, isolation: 'docker' };
};
batchDeps.activate = async () => undefined;
batchDeps.activation = async () => ({ active: true, runningCommit: 'x', buildCommit: 'x', buildAt: new Date().toISOString(), reason: 'simulado' });
batchDeps.runtimeChecks = async (_pid, checks) => checks.map(check => ({ check, status: 'ok' as const, detail: 'ok', at: new Date().toISOString() }));

const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple; verificación en verde.', findings: [], suggestedTests: [] });
const QA_UNABLE = JSON.stringify({ verdict: 'unable_to_verify', summary: 'Sin evidencia suficiente para verificar el criterio visual.', findings: [], suggestedTests: [] });
const plan = (...files: string[]) => JSON.stringify({ summary: `Cambiar ${files.join(', ')}`, tasks: files.map(f => `Cambiar ${f}`), filesToRead: [], filesToChange: files, acceptance: ['el valor cambia'], risks: [] });
const patch = (file: string, from: string, to: string) => `=== RESUMEN ===\nCambia ${file}.\n=== ARCHIVO: ${file} | patch ===\n<<<< BUSCAR\n${from}\n==== REEMPLAZAR\n${to}\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre ${file}. Esperado: cambiado.`;
const create = (file: string, content: string) => `=== RESUMEN ===\nCrea ${file}.\n=== ARCHIVO: ${file} | create ===\n${content}\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre ${file}. Esperado: existe.`;
type Rule = Record<string, unknown>;
let rules: Rule[] = [];
function setScript(extra: Rule[]) {
  rules = [...extra, { match: 'Evalúa la implementación con la EVIDENCIA real', text: QA_OK }];
  fs.writeFileSync(scriptPath, JSON.stringify({ rules, markers: [] }));
}
function addRules(extra: Rule[]) { rules = [...extra, ...rules]; fs.writeFileSync(scriptPath, JSON.stringify({ rules, markers: [] })); }
resetMockCalls();
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const callsFor = (key: string, what?: RegExp) => calls().filter(c => typeof c.rule === 'string' && c.rule.startsWith(`${key}.*`) && (!what || what.test(c.rule)));
const qaCallsFor = (pid: string) => processesRepo(S).get(pid)!.steps.filter(s => s.role === 'reviewer' && s.status === 'done').length;
const story = (title: string) => backlogRepo(S).get(addManualItem(S, project.id, { title, criterion: 'el valor cambia' }).id)!;
const get = async (id: string) => (await app.inject({ method: 'GET', url: `${W}/batches/${id}` })).json();
async function waitFor<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, what: string, ms = 45_000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  const show = (x: any) => x && Array.isArray(x.items) ? JSON.stringify({ status: x.status, reason: x.reason, items: x.items.map((i: any) => [i.storyId, i.title, i.state, i.reason, i.freshness?.status ?? null, i.process?.pipeline?.pauseKind ?? null, i.process?.status ?? null]), events: x.events.slice(-25).map((e: any) => e.message.slice(0, 220)) }) : JSON.stringify(x).slice(0, 2500);
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what} · ${show(v)}`); await new Promise(r => setTimeout(r, 50)); v = await fn(); }
  return v;
}
const authorize = async (body: Record<string, unknown>) => {
  // Cada escenario empieza sin lotes activos (si uno anterior falló, no arrastra al siguiente).
  for (const x of (await app.inject({ method: 'GET', url: `${W}/projects/${project.id}/batches` })).json()) if (x.status === 'running' || x.status === 'paused') await app.inject({ method: 'POST', url: `${W}/batches/${x.id}/cancel` });
  const res = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/batches`, payload: { authorized: true, totalBudgetUsd: 5, perStoryBudgetUsd: 1, maxCorrections: 2, maxSubscriptionCalls: 400, commands: ['typecheck', 'test', 'build'], git: { merge: true, integration: 'on_acceptance' }, backends: ['api', 'claude_code'], ...body } });
  assert.equal(res.statusCode, 201, res.body); return res.json();
};
const post = async (url: string, payload: Record<string, unknown> = {}) => { const r = await app.inject({ method: 'POST', url: `${W}${url}`, payload }); assert.equal(r.statusCode, 200, r.body); return r.json(); };
const item = (b: any, key: string) => b.items.find((i: any) => i.title.includes(key));
const mainMerges = () => execSync('git log --first-parent --merges --format=%s main', { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const mainFile = (f: string) => execSync(`git show main:${f}`, { cwd: repo, encoding: 'utf8' }).replace(/\r\n/g, '\n');
const close = async (id: string) => { const b = await get(id); if (b.status === 'running' || b.status === 'paused') await app.inject({ method: 'POST', url: `${W}/batches/${id}/cancel` }); };

test('12 + 12.1 · cinco historias: todo el lote técnicamente listo sin integrar; pedir cambios a la 1 sobre su rama; aceptar e integrar en orden; las siguientes se ponen al día con QA; nada dos veces', async () => {
  const keys = [1, 2, 3, 4, 5].map(n => `ALFA${n}`);
  const its = keys.map(k => story(`Historia ${k}`));
  setScript([
    ...[1, 2, 3, 4].map(n => [{ match: `ALFA${n}.*Elabora el plan técnico`, text: plan('src/shared.ts') }, { match: `ALFA${n}.*Implementa la historia`, text: patch('src/shared.ts', `export const s${n} = 0;`, `export const s${n} = ${n};`) }]).flat(),
    { match: 'ALFA5.*Elabora el plan técnico', text: plan('src/five.ts') }, { match: 'ALFA5.*Implementa la historia', text: create('src/five.ts', 'export const five = 5;') }
  ]);
  const merges0 = mainMerges().length; const main0 = execSync('git rev-parse main', { cwd: repo, encoding: 'utf8' }).trim();
  const b0 = await authorize({ itemIds: its.map(i => i.id), title: 'Lote ALFA', concurrency: 2 });
  assert.equal(b0.auth.git.integration, 'on_acceptance');
  assert.match(b0.events[0].message, /integrar al aceptar cada historia, en orden/);
  // 12 · todo el lote termina técnicamente SIN tocar main.
  const ready = await waitFor(() => get(b0.id), x => x.items.every((i: any) => i.state === 'ready') && x.items.every((i: any) => !!i.freshness), 'las cinco listas', 60_000);
  assert.equal(execSync('git rev-parse main', { cwd: repo, encoding: 'utf8' }).trim(), main0, 'nada se integra sin tu aceptación');
  assert.equal(ready.lifecycle.technicallyComplete, true);
  assert.equal(ready.lifecycle.headline, 'Lote técnicamente completo: 5 historias — 5 listas para tu aceptación (sin integrar).');
  assert.equal(ready.status, 'running', 'no se da por terminado con historias sin aceptar');
  assert.ok(ready.integrationPlan.order.length === 5 && ready.integrationPlan.basis.actual === 5, JSON.stringify(ready.integrationPlan));
  assert.ok(ready.integrationPlan.overlaps.some((o: any) => o.files.includes('src/shared.ts')));
  assert.ok(ready.items.every((i: any) => i.freshness.status === 'current'), 'todas nacieron del main actual: evidencia vigente');
  // 12.1 · pides cambios a la 1: se aplican sobre SU rama (mismo proceso, sin rehacer plan ni implementación).
  const one = item(ready, 'ALFA1'); const pid1 = one.processId;
  addRules([{ match: 'ALFA1.*Corrige la implementación', text: patch('src/shared.ts', 'export const s1 = 1;', 'export const s1 = 11;') }]);
  const plans1 = callsFor('ALFA1', /plan técnico/).length; const impl1 = callsFor('ALFA1', /Implementa la historia/).length;
  const it1 = await post(`/batches/${b0.id}/items/${one.itemId}/iterate`, { authorized: true, note: 'El valor de s1 debe ser 11, no 1.' });
  assert.equal(item(it1, 'ALFA1').resumeProcessId, pid1, 'se retoma el MISMO proceso');
  const after1 = await waitFor(() => get(b0.id), x => item(x, 'ALFA1').state === 'ready' && !!item(x, 'ALFA1').freshness, 'ALFA1 lista otra vez');
  assert.equal(item(after1, 'ALFA1').processId, pid1);
  assert.equal(callsFor('ALFA1', /plan técnico/).length, plans1, 'sin plan nuevo'); assert.equal(callsFor('ALFA1', /Implementa la historia/).length, impl1, 'sin reimplementar');
  assert.equal(callsFor('ALFA1', /Corrige la implementación/).length, 1, 'una corrección dirigida con tu nota');
  const wt1 = processesRepo(S).get(pid1)!.result!.applied!.worktree!;
  assert.match(fs.readFileSync(path.join(wt1, 'src/shared.ts'), 'utf8'), /s1 = 11;/);
  assert.equal(execSync('git rev-parse main', { cwd: repo, encoding: 'utf8' }).trim(), main0, 'pedir cambios no integra nada');
  // Aceptar e integrar la 1 (ya está al día): entra en main y queda cerrada con UNA aceptación.
  const qa2Before = qaCallsFor(item(after1, 'ALFA2').processId);
  await post(`/batches/${b0.id}/accept`, { itemIds: [one.itemId] });
  const acc1 = await waitFor(() => get(b0.id), x => item(x, 'ALFA1').state === 'accepted', 'ALFA1 aceptada e integrada');
  assert.equal(backlogRepo(S).get(one.itemId)!.status, 'done');
  assert.match(mainFile('src/shared.ts'), /s1 = 11;/);
  // La siguiente en el orden que comparte archivo se pone al día SOLA (merge, sandbox y QA del commit nuevo) antes de revisarla.
  const order = acc1.integrationPlan.order as string[];
  const nextId = order.find(x => x !== one.itemId && ['ready', 'revalidating', 'queued', 'running'].includes(acc1.items.find((i: any) => i.itemId === x).state))!;
  const nextKey = acc1.items.find((i: any) => i.itemId === nextId).title.replace('Historia ', '');
  const reval = await waitFor(() => get(b0.id), x => { const n = x.items.find((i: any) => i.itemId === nextId); return n.state === 'ready' && n.freshness?.status === 'current' && x.events.some((e: any) => e.itemId === nextId && /se pone al día/.test(e.message)); }, `${nextKey} puesta al día`);
  const nextItem = reval.items.find((i: any) => i.itemId === nextId);
  if (nextKey !== 'ALFA5') assert.ok(qaCallsFor(nextItem.processId) > (nextKey === 'ALFA2' ? qa2Before : 0), 'QA revisó el commit nuevo (comparte archivo con lo integrado)');
  const stale = reval.items.filter((i: any) => i.state === 'ready' && i.itemId !== nextId && i.title !== 'Historia ALFA5');
  assert.ok(stale.every((i: any) => i.freshness?.status === 'stale' && i.freshness.causes.length >= 0), 'las demás que comparten archivo quedan marcadas «no al día» (sin pagar todavía)');
  assert.ok(stale.every((i: any) => i.freshness.overlap.includes('src/shared.ts')));
  const five = item(reval, 'ALFA5');
  if (five.itemId !== nextId) assert.equal(five.freshness.status, 'clean_carry', 'la que no comparte archivos arrastra su evidencia');
  // Aceptar el resto en el orden de integración: cada una se pone al día antes si hace falta y se integra una vez.
  for (const iid of order.filter(x => x !== one.itemId)) {
    await waitFor(() => get(b0.id), x => { const n = x.items.find((i: any) => i.itemId === iid); return n.state === 'ready' && !!n.freshness; }, `lista ${iid}`);
    await post(`/batches/${b0.id}/accept`, { itemIds: [iid] });
    await waitFor(() => get(b0.id), x => x.items.find((i: any) => i.itemId === iid).state === 'accepted', `aceptada ${iid}`, 60_000);
  }
  const done = await waitFor(() => get(b0.id), x => x.status === 'completed', 'lote ALFA terminado');
  assert.equal(done.lifecycle.phase, 'done');
  assert.equal(mainMerges().length - merges0, 5, 'cinco integraciones: ninguna dos veces');
  const shared = mainFile('src/shared.ts');
  for (const [n, v] of [[1, 11], [2, 2], [3, 3], [4, 4]]) assert.match(shared, new RegExp(`s${n} = ${v};`), `main conserva la historia ${n}`);
  assert.equal(mainFile('src/five.ts'), 'export const five = 5;\n');
  assert.ok(its.every(i => backlogRepo(S).get(i.id)!.status === 'done'));
});

test('12.2 · conflictos reales: el agente resuelve SOLO las secciones en conflicto (una llamada) y conserva ambas; si cambia el código aceptado, se anula la aceptación; si no puede, decides tú', async () => {
  const X = story('Historia BRAVOX'); const Y = story('Historia BRAVOY'); const Z = story('Historia BRAVOZ');
  setScript([
    { match: 'BRAVOX.*Elabora el plan técnico', text: plan('src/route.ts') }, { match: 'BRAVOX.*Implementa la historia', text: patch('src/route.ts', "export const route = 'base';", "export const route = 'x';") },
    { match: 'BRAVOY.*Elabora el plan técnico', text: plan('src/route.ts') }, { match: 'BRAVOY.*Implementa la historia', text: patch('src/route.ts', "export const route = 'base';", "export const route = 'y';") },
    { match: 'BRAVOZ.*Elabora el plan técnico', text: plan('src/route.ts') }, { match: 'BRAVOZ.*Implementa la historia', text: patch('src/route.ts', "export const route = 'base';", "export const route = 'z';") },
    { match: 'BRAVOY.*resuelve SOLO los conflictos', text: `=== RESUMEN ===\nConservo ambas rutas.\n=== ARCHIVO: src/route.ts | create ===\nexport const route = 'x';\nexport const routeY = 'y';\n=== FIN ARCHIVO ===\n` },
    { match: 'BRAVOZ.*resuelve SOLO los conflictos', text: `=== RESUMEN ===\nNo sé cuál conservar.\n=== ARCHIVO: src/route.ts | create ===\n<<<<<<< HEAD\nexport const route = 'x';\n=======\nexport const route = 'z';\n>>>>>>> main\n=== FIN ARCHIVO ===\n` }
  ]);
  const b0 = await authorize({ itemIds: [X.id, Y.id, Z.id], title: 'Lote BRAVO', concurrency: 3 });
  const ready = await waitFor(() => get(b0.id), x => x.items.every((i: any) => i.state === 'ready' && i.freshness), 'las tres listas', 60_000);
  const x0 = item(ready, 'BRAVOX'); const y0 = item(ready, 'BRAVOY');
  await post(`/batches/${b0.id}/accept`, { itemIds: [x0.itemId] });
  const afterX = await waitFor(() => get(b0.id), b => item(b, 'BRAVOX').state === 'accepted' && ['stale', 'current'].includes(item(b, 'BRAVOY').freshness?.status) && (item(b, 'BRAVOY').freshness?.status !== 'stale' || item(b, 'BRAVOY').freshness?.conflicts?.length || item(b, 'BRAVOY').state !== 'ready'), 'BRAVOX integrada');
  assert.equal(mainFile('src/route.ts'), "export const route = 'x';\n");
  // Aceptas BRAVOY ANTES de ponerla al día (con conflicto previsto): al ponerse al día cambia su código → vuelves a revisarla.
  const yState = item(afterX, 'BRAVOY');
  if (yState.state === 'ready') {
    await post(`/batches/${b0.id}/accept`, { itemIds: [y0.itemId] });
    const voided = await waitFor(() => get(b0.id), b => item(b, 'BRAVOY').state === 'ready' && b.events.some((e: any) => e.itemId === y0.itemId && /aceptación anterior queda anulada/.test(e.message)), 'aceptación anulada por cambio de código', 60_000);
    assert.equal(item(voided, 'BRAVOY').acceptance, null);
  } else await waitFor(() => get(b0.id), b => item(b, 'BRAVOY').state === 'ready' && item(b, 'BRAVOY').freshness?.status === 'current', 'BRAVOY puesta al día', 60_000);
  assert.equal(callsFor('BRAVOY', /resuelve SOLO los conflictos/).length, 1, 'una sola llamada para los conflictos');
  const yp = processesRepo(S).get(y0.processId)!;
  assert.equal(yp.result!.integration?.resolvedBy, 'agent');
  assert.equal(execSync('git rev-parse main', { cwd: repo, encoding: 'utf8' }).trim(), execSync('git rev-parse main', { cwd: repo, encoding: 'utf8' }).trim());
  assert.equal(mainFile('src/route.ts'), "export const route = 'x';\n", 'nada de BRAVOY en main sin tu aceptación');
  await waitFor(() => get(b0.id), b => item(b, 'BRAVOY').state === 'ready' && item(b, 'BRAVOY').freshness?.status === 'current', 'BRAVOY vigente');
  await post(`/batches/${b0.id}/accept`, { itemIds: [y0.itemId] });
  await waitFor(() => get(b0.id), b => item(b, 'BRAVOY').state === 'accepted', 'BRAVOY integrada', 60_000);
  assert.equal(mainFile('src/route.ts'), "export const route = 'x';\nexport const routeY = 'y';\n", 'main conserva ambas intenciones');
  // BRAVOZ: el agente no consigue una resolución válida (deja marcadores) → decides tú, con la pregunta concreta; nada cambió.
  const z = await waitFor(() => get(b0.id), b => item(b, 'BRAVOZ').state === 'needs_owner', 'BRAVOZ espera tu decisión', 60_000);
  assert.equal(item(z, 'BRAVOZ').failureClass, 'integration');
  assert.match(item(z, 'BRAVOZ').reason, /Decide cómo combinarlas/);
  assert.equal(z.lifecycle.counts.decision, 1);
  assert.equal(mainFile('src/route.ts'), "export const route = 'x';\nexport const routeY = 'y';\n");
  await close(b0.id);
});

test('nunca sin tu aceptación: una historia que termina con el lote en pausa queda «lista» y reanudar no la integra', async () => {
  const P = story('Historia CHARLIE');
  setScript([{ match: 'CHARLIE.*Elabora el plan técnico', text: plan('src/charlie.ts') }, { match: 'CHARLIE.*Implementa la historia', text: create('src/charlie.ts', 'export const charlie = 1;') }, { match: 'CHARLIE.*Evalúa la implementación con la EVIDENCIA real', delayMs: 800, text: QA_OK }]);
  const main0 = execSync('git rev-parse main', { cwd: repo, encoding: 'utf8' }).trim();
  const b0 = await authorize({ itemIds: [P.id], title: 'Lote CHARLIE' });
  await waitFor(() => get(b0.id), x => x.items[0].state === 'running', 'en marcha');
  await post(`/batches/${b0.id}/pause`);
  const r = await waitFor(() => get(b0.id), x => x.items[0].state === 'ready', 'lista con el lote en pausa', 60_000);
  assert.equal(r.status, 'paused');
  await post(`/batches/${b0.id}/resume`, { authorized: true });
  await new Promise(res => setTimeout(res, 600));
  const x = await get(b0.id);
  assert.equal(x.items[0].state, 'ready', x.items[0].reason);
  assert.equal(execSync('git rev-parse main', { cwd: repo, encoding: 'utf8' }).trim(), main0, 'main no cambió');
  // Aplazar y recuperar: decisión tomada sin IA; el lote no se da por terminado con ella sin resolver… y sí al aplazarla.
  const pp = await post(`/batches/${b0.id}/items/${x.items[0].itemId}/postpone`, { note: 'La veo la semana que viene' });
  assert.equal(pp.items[0].state, 'postponed');
  const done = await waitFor(() => get(b0.id), y => y.status === 'completed', 'lote resuelto con la aplazada');
  assert.match(done.reason, /1 aplazada/);
});

test('12.4 · reinicio a mitad de la puesta al día (verificando el candidato): no se da por vigente, se retoma sin otro merge y termina lista', async () => {
  const A = story('Historia DELTA1'); const B = story('Historia DELTA2');
  setScript([
    { match: 'DELTA1.*Elabora el plan técnico', text: plan('src/shared2.ts') }, { match: 'DELTA1.*Implementa la historia', text: patch('src/shared2.ts', 'export const m1 = 0;', 'export const m1 = 1;') },
    { match: 'DELTA2.*Elabora el plan técnico', text: plan('src/shared2.ts', 'src/delta2.ts') }, { match: 'DELTA2.*Implementa la historia', text: `=== RESUMEN ===\nCambia y crea.\n=== ARCHIVO: src/shared2.ts | patch ===\n<<<< BUSCAR\nexport const m2 = 0;\n==== REEMPLAZAR\nexport const m2 = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== ARCHIVO: src/delta2.ts | create ===\nexport const delta2 = 2;\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.` }
  ]);
  const b0 = await authorize({ itemIds: [A.id, B.id], title: 'Lote DELTA', concurrency: 2 });
  const ready = await waitFor(() => get(b0.id), x => x.items.every((i: any) => i.state === 'ready' && i.freshness), 'las dos listas', 60_000);
  const a = item(ready, 'DELTA1'); const bI = item(ready, 'DELTA2');
  let entered!: () => void; const inVerify = new Promise<void>(r => { entered = r; });
  hangOn = { file: 'src/delta2.ts', entered };
  await post(`/batches/${b0.id}/accept`, { itemIds: [a.itemId] });
  await inVerify; // DELTA2 se pone al día y su candidato se está verificando cuando el Portal «se reinicia»
  const mid = await get(b0.id);
  assert.equal(item(mid, 'DELTA2').state, 'revalidating');
  const branch = processesRepo(S).get(bI.processId)!.result!.applied!.branch;
  const mergesOnBranch = () => execSync(`git log --merges --format=%s main..${branch}`, { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(l => /^Incorpora /.test(l)).length;
  assert.equal(mergesOnBranch(), 1);
  forgetBatchJobs();
  recoverInterruptedProcesses(() => undefined);
  await resumeBatches(() => undefined);
  const fin = await waitFor(() => get(b0.id), x => item(x, 'DELTA2').state === 'ready' && item(x, 'DELTA2').freshness?.status === 'current', 'DELTA2 vigente tras el reinicio', 60_000);
  assert.ok(fin.events.some((e: any) => e.itemId === bI.itemId && /aún no está verificado|se rehace desde git/.test(e.message)), 'no se dio por vigente sin verificar');
  assert.equal(mergesOnBranch(), 1, 'sin otro merge de main en su rama');
  await post(`/batches/${b0.id}/accept`, { itemIds: [bI.itemId] });
  await waitFor(() => get(b0.id), x => x.status === 'completed', 'lote DELTA terminado', 60_000);
  assert.match(mainFile('src/shared2.ts'), /m1 = 1;[\s\S]*m2 = 2;/);
});

test('recuperación del lote real (integración automática): candidato con conflictos resueltos verificado sin QA y QA «no pudo verificar» → «Reanudar» los continúa sin repetir nada', async () => {
  const P = story('Historia ECHO1'); const Q = story('Historia ECHO2'); const R = story('Historia ECHO3');
  setScript([
    { match: 'ECHO1.*Elabora el plan técnico', text: plan('src/route2.ts') }, { match: 'ECHO1.*Implementa la historia', text: patch('src/route2.ts', "export const route2 = 'base';", "export const route2 = 'p';") },
    { match: 'ECHO2.*Elabora el plan técnico', text: plan('src/route2.ts') }, { match: 'ECHO2.*Implementa la historia', text: patch('src/route2.ts', "export const route2 = 'base';", "export const route2 = 'q';") },
    { match: 'ECHO3.*Elabora el plan técnico', text: plan('src/echo3.ts') }, { match: 'ECHO3.*Implementa la historia', text: create('src/echo3.ts', 'export const echo3 = 3;') },
    { match: 'ECHO3.*Evalúa la implementación con la EVIDENCIA real', responses: [{ text: QA_UNABLE }, { text: QA_OK }] },
    { match: 'ECHO2.*resuelve SOLO los conflictos', text: `=== RESUMEN ===\nAmbas.\n=== ARCHIVO: src/route2.ts | create ===\nexport const route2 = 'p';\nexport const route2q = 'q';\n=== FIN ARCHIVO ===\n` }
  ]);
  // Como el lote real: integrar (y aquí sin activar ni publicar) al terminar cada una.
  const b0 = await authorize({ itemIds: [P.id, Q.id, R.id], title: 'Lote ECHO', concurrency: 3, git: { merge: true } });
  assert.equal(b0.auth.git.integration, 'auto');
  const stuck = await waitFor(() => get(b0.id), x => item(x, 'ECHO3').state === 'needs_owner' && (item(x, 'ECHO1').state === 'needs_owner' || item(x, 'ECHO2').state === 'needs_owner'), 'una con conflictos y la de QA inconclusa', 60_000);
  const loser = ['ECHO1', 'ECHO2'].map(k => item(stuck, k)).find((i: any) => i.state === 'needs_owner');
  assert.equal(loser.failureClass, 'integration');
  // Como HU-169: resuelves los conflictos desde su proceso (una llamada); el candidato queda verificado y QA no lo revisó.
  if (loser.title.includes('ECHO1')) addRules([{ match: 'ECHO1.*resuelve SOLO los conflictos', text: `=== RESUMEN ===\nAmbas.\n=== ARCHIVO: src/route2.ts | create ===\nexport const route2 = 'q';\nexport const route2p = 'p';\n=== FIN ARCHIVO ===\n` }]);
  const r = await app.inject({ method: 'POST', url: `${W}/processes/${loser.processId}/integration/resolve`, payload: { authorized: true } });
  assert.equal(r.statusCode, 200, r.body);
  await waitFor(() => processesRepo(S).get(loser.processId)!, p => p.status !== 'running' && p.result?.pipeline?.pauseKind === 'integration', 'candidato verificado');
  const qaLoser = qaCallsFor(loser.processId); const qaR = qaCallsFor(item(stuck, 'ECHO3').processId);
  const impl = calls().filter(c => /Implementa la historia|plan técnico/.test(c.rule ?? '')).length;
  // «Reanudar» (autorizado): QA revisa el candidato (rutina técnica) y la de QA inconclusa se revisa UNA vez con la evidencia actual.
  await post(`/batches/${b0.id}/resume`, { authorized: true });
  const done = await waitFor(() => get(b0.id), x => ['ECHO1', 'ECHO2', 'ECHO3'].every(k => item(x, k).state === 'awaiting_acceptance'), 'las tres integradas', 60_000);
  assert.equal(qaCallsFor(loser.processId), qaLoser + 1, 'QA revisó el candidato una vez');
  assert.equal(qaCallsFor(item(done, 'ECHO3').processId), qaR + 1, 'QA volvió a evaluar una vez');
  assert.equal(calls().filter(c => /Implementa la historia|plan técnico/.test(c.rule ?? '')).length, impl, 'ni plan ni implementación repetidos');
  assert.equal(item(done, 'ECHO3').qaRetries, 1);
  assert.match(mainFile('src/route2.ts'), /'p'[\s\S]*'q'|'q'[\s\S]*'p'/, 'main conserva ambas');
  await close(b0.id);
});

test('huella de los cambios de una historia: estable con un merge limpio de main, distinta si cambia su código', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-patchid-'));
  const g = (c: string) => execSync(`git -c user.email=t@t -c user.name=t ${c}`, { cwd: r, encoding: 'utf8' });
  fs.writeFileSync(path.join(r, 'a.ts'), LINES('a', 3)); g('init -q -b main'); g('add -A'); g('commit -qm base');
  g('checkout -q -b feat'); fs.writeFileSync(path.join(r, 'a.ts'), LINES('a', 3).replace('a2 = 0', 'a2 = 2')); g('commit -qam feat');
  const before = await storyPatchId(r, 'feat');
  g('checkout -q main'); fs.writeFileSync(path.join(r, 'b.ts'), 'export const b = 1;\n'); fs.writeFileSync(path.join(r, 'a.ts'), LINES('a', 3).replace('a1 = 0', 'a1 = 1')); g('add -A'); g('commit -qm main');
  g('checkout -q feat'); g('merge -q --no-edit main');
  assert.equal(await storyPatchId(r, 'feat'), before, 'un merge limpio de main conserva la huella');
  fs.writeFileSync(path.join(r, 'a.ts'), fs.readFileSync(path.join(r, 'a.ts'), 'utf8').replace('a2 = 2', 'a2 = 22')); g('commit -qam cambio');
  assert.notEqual(await storyPatchId(r, 'feat'), before, 'otro código, otra huella');
});

// ---------- Ronda B (Gauntlet): hallazgos reproducidos y corregidos ----------

test('Ronda B · B1/B2/B4/B5/B6: sin bucle con el proceso en marcha; una pausa de la puesta al día no se repite sola; ya en main no se integra dos veces; cambios con nota general tocan todos sus archivos', async () => {
  // Archivos propios de este escenario (se crean aquí: a nivel de módulo cambiarían main mientras corren los demás).
  fs.writeFileSync(path.join(repo, 'src/multi1.ts'), 'export const m1 = 0;\n'); fs.writeFileSync(path.join(repo, 'src/multi2.ts'), 'export const m2 = 0;\n');
  fs.writeFileSync(path.join(repo, 'src/twice.ts'), 'export const t = 0;\n');
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm "Base ronda B"', { cwd: repo });
  const H = story('Historia HOTELB'); const T = story('Historia TANGO');
  setScript([
    { match: 'HOTELB.*Elabora el plan técnico', text: plan('src/multi1.ts', 'src/multi2.ts') },
    { match: 'HOTELB.*Implementa la historia', text: `=== RESUMEN ===\nDos archivos.\n=== ARCHIVO: src/multi1.ts | patch ===\n<<<< BUSCAR\nexport const m1 = 0;\n==== REEMPLAZAR\nexport const m1 = 1;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== ARCHIVO: src/multi2.ts | patch ===\n<<<< BUSCAR\nexport const m2 = 0;\n==== REEMPLAZAR\nexport const m2 = 1;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.` },
    { match: 'TANGO.*Elabora el plan técnico', text: plan('src/twice.ts') }, { match: 'TANGO.*Implementa la historia', text: patch('src/twice.ts', 'export const t = 0;', 'export const t = 1;') }
  ]);
  const b0 = await authorize({ itemIds: [H.id, T.id], title: 'Lote RONDA B', concurrency: 2 });
  const ready = await waitFor(() => get(b0.id), x => x.items.every((i: any) => i.state === 'ready' && i.freshness), 'listas', 60_000);
  const h = item(ready, 'HOTELB'); const t = item(ready, 'TANGO');
  // B5 · una nota sin archivo: UNA unidad con todos los archivos de la historia (antes, un único archivo arbitrario).
  prepareOwnerRound(S, h.processId, 'Que los dos valores sean coherentes entre sí');
  const units = processesRepo(S).get(h.processId)!.result!.manifest!.units.filter(u => u.source === 'owner');
  assert.equal(units.length, 1); assert.deepEqual([...units[0].files].sort(), ['src/multi1.ts', 'src/multi2.ts']);
  // B6 · TANGO ya está en main (la integraste fuera del lote): aceptarla registra ESA integración, sin otro merge.
  const branchT = processesRepo(S).get(t.processId)!.result!.applied!.branch;
  execSync(`git -c user.email=t@t -c user.name=t merge --no-ff -q -m "Integra a mano ${branchT}" ${branchT}`, { cwd: repo });
  const merges0 = mainMerges().length;
  await post(`/batches/${b0.id}/accept`, { itemIds: [t.itemId] });
  const acc = await waitFor(() => get(b0.id), x => item(x, 'TANGO').state === 'accepted', 'TANGO registrada como integrada');
  assert.equal(mainMerges().length, merges0, 'ningún merge más'); assert.equal(processesRepo(S).get(t.processId)!.result!.merged!.into, 'main');
  void acc;
  // B2 · una puesta al día que se detuvo por el proveedor no se repite sola: decides tú.
  batchesRepo(S).update(b0.id, x => { const y = x.items.find(i => i.itemId === h.itemId)!; Object.assign(y, { state: 'revalidating', revalidation: { at: new Date().toISOString(), step: 'resolve', mainHead: null, causes: [] } }); });
  const ph = processesRepo(S).get(h.processId)!;
  processesRepo(S).setResult(h.processId, { ...ph.result!, pipeline: { ...ph.result!.pipeline!, state: 'paused', pauseKind: 'provider_timeout', reason: 'El proveedor no respondió a tiempo.' } });
  const n0 = calls().length;
  await scheduleTick(S, b0.id); await new Promise(r => setTimeout(r, 300)); await scheduleTick(S, b0.id);
  const after2 = await waitFor(() => get(b0.id), x => item(x, 'HOTELB').state === 'needs_owner', 'decides tú');
  assert.equal(item(after2, 'HOTELB').failureClass, 'environment'); assert.equal(calls().length, n0, 'ninguna llamada repetida sola');
  // B1 · aceptada con su proceso en marcha: el coordinador NO se re-programa en bucle (antes se colgaba el servidor).
  batchesRepo(S).update(b0.id, x => { const y = x.items.find(i => i.itemId === h.itemId)!; Object.assign(y, { state: 'integrating', acceptance: { at: new Date().toISOString(), note: null, checks: null, commit: 'x', patchId: 'y' } }); });
  processesRepo(S).resume(h.processId, 1); // «en marcha»
  const t0 = Date.now(); await scheduleTick(S, b0.id);
  assert.ok(Date.now() - t0 < 3000, `la pasada termina (${Date.now() - t0} ms)`);
  const heartbeat = await new Promise<number>(r => { const s0 = Date.now(); setTimeout(() => r(Date.now() - s0), 50); });
  assert.ok(heartbeat < 1000, 'el bucle de eventos sigue respirando');
  processesRepo(S).finish(h.processId, 'done', null);
  await close(b0.id);
});

test('Ronda B · B4: con una pregunta pendiente del equipo, «Iterar» prepara una iteración nueva (no una ronda que nunca podría retomarse)', async () => {
  const Q = story('Historia QUEBEC');
  setScript([{ match: 'QUEBEC.*Elabora el plan técnico', text: plan('src/quebec.ts') }, { match: 'QUEBEC.*Implementa la historia', text: create('src/quebec.ts', 'export const q = 1;') }]);
  const b0 = await authorize({ itemIds: [Q.id], title: 'Lote QUEBEC' });
  const r = await waitFor(() => get(b0.id), x => x.items[0].state === 'ready', 'lista', 60_000);
  const pid = r.items[0].processId; const pq = processesRepo(S).get(pid)!;
  processesRepo(S).setResult(pid, { ...pq.result!, pipeline: { ...pq.result!.pipeline!, state: 'paused', pauseKind: 'missing_information' as any, ownerRequest: { question: '¿Qué valor?', options: [], askedAt: new Date().toISOString() } as any } });
  batchesRepo(S).update(b0.id, x => { Object.assign(x.items[0], { state: 'needs_owner', failureClass: 'owner_decision' }); });
  const it2 = await post(`/batches/${b0.id}/items/${Q.id}/iterate`, { authorized: true, note: 'Usa el valor 2.' });
  assert.ok(it2.items[0].nextProcessId && it2.items[0].nextProcessId !== pid, 'iteración nueva preparada');
  assert.equal(it2.items[0].resumeProcessId ?? null, null);
  await close(b0.id);
});

// ---------- Ronda D (Gauntlet final): «¿qué escenario demostraría que no puede terminar un lote e integrar con seguridad?» ----------
test('Ronda D · no aceptas una historia cuando las demás ya están listas y otra depende de ella: la independiente se integra, la dependiente se bloquea con su motivo, el lote no se da por terminado; al iterar la rechazada todo se retoma y termina', async () => {
  fs.writeFileSync(path.join(repo, 'src/xray.ts'), 'export const x = 0;\n'); fs.writeFileSync(path.join(repo, 'src/zulu.ts'), 'export const z = 0;\n');
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm "Base ronda D"', { cwd: repo });
  const X = story('Historia XRAY'); const Y = story('Historia YANKEE'); const Z = story('Historia ZULU');
  backlogRepo(S).update(Y.id, { dependsOn: X.storyId });
  setScript([
    { match: 'XRAY.*Corrige la implementación', text: patch('src/xray.ts', 'export const x = 1;', 'export const x = 10;') },
    { match: 'XRAY.*Elabora el plan técnico', text: plan('src/xray.ts') }, { match: 'XRAY.*Implementa la historia', text: patch('src/xray.ts', 'export const x = 0;', 'export const x = 1;') },
    { match: 'YANKEE.*Elabora el plan técnico', text: plan('src/yankee.ts') }, { match: 'YANKEE.*Implementa la historia', text: create('src/yankee.ts', "import { x } from './xray.ts';\nexport const y = x + 1;") },
    { match: 'ZULU.*Elabora el plan técnico', text: plan('src/zulu.ts') }, { match: 'ZULU.*Implementa la historia', text: patch('src/zulu.ts', 'export const z = 0;', 'export const z = 3;') }
  ]);
  const b0 = await authorize({ itemIds: [X.id, Y.id, Z.id], title: 'Lote RONDA D', concurrency: 2 });
  const r = await waitFor(() => get(b0.id), x => item(x, 'XRAY').state === 'ready' && item(x, 'ZULU').state === 'ready' && !!item(x, 'XRAY').freshness && !!item(x, 'ZULU').freshness, 'X y Z listas', 60_000);
  assert.equal(item(r, 'YANKEE').state, 'waiting_dependency'); assert.match(item(r, 'YANKEE').reason, /aceptes e integres HU-\d+/);
  // No aceptas X: Y se bloquea (necesita su código), Z sigue intacta y se integra al aceptarla.
  await post(`/batches/${b0.id}/items/${item(r, 'XRAY').itemId}/reject`, { note: 'El valor de x debe ser 10.' });
  const rj = await waitFor(() => get(b0.id), x => item(x, 'YANKEE').state === 'blocked', 'Y bloqueada por su dependencia');
  assert.match(item(rj, 'YANKEE').reason, /no aceptaste/);
  await post(`/batches/${b0.id}/accept`, { itemIds: [item(rj, 'ZULU').itemId] });
  const zA = await waitFor(() => get(b0.id), x => item(x, 'ZULU').state === 'accepted', 'Z integrada');
  assert.equal(mainFile('src/zulu.ts'), 'export const z = 3;\n'); assert.match(mainFile('src/xray.ts'), /x = 0;/, 'nada de la rechazada en main');
  await new Promise(res => setTimeout(res, 300));
  assert.notEqual((await get(b0.id)).status, 'completed', 'con una historia bloqueada sin resolver, el lote no se da por terminado');
  void zA;
  // Iteras la rechazada (sobre su rama): Y vuelve a esperarla; al aceptar X, Y se ejecuta y queda lista; al aceptarla, el lote termina.
  await post(`/batches/${b0.id}/items/${item(rj, 'XRAY').itemId}/iterate`, { authorized: true, note: 'El valor de x debe ser 10.' });
  const it2 = await get(b0.id); assert.equal(item(it2, 'YANKEE').state, 'waiting_dependency', 'la dependiente vuelve a esperarla');
  await waitFor(() => get(b0.id), x => item(x, 'XRAY').state === 'ready' && !!item(x, 'XRAY').freshness, 'X lista con los cambios', 60_000);
  await post(`/batches/${b0.id}/accept`, { itemIds: [item(it2, 'XRAY').itemId] });
  await waitFor(() => get(b0.id), x => item(x, 'XRAY').state === 'accepted', 'X integrada', 60_000);
  assert.match(mainFile('src/xray.ts'), /x = 10;/);
  const yR = await waitFor(() => get(b0.id), x => item(x, 'YANKEE').state === 'ready' && !!item(x, 'YANKEE').freshness, 'Y ejecutada sobre main con X', 60_000);
  await post(`/batches/${b0.id}/accept`, { itemIds: [item(yR, 'YANKEE').itemId] });
  const done = await waitFor(() => get(b0.id), x => x.status === 'completed', 'lote RONDA D terminado', 60_000);
  assert.equal(done.lifecycle.counts.accepted, 3); assert.match(mainFile('src/yankee.ts'), /x \+ 1/);
});

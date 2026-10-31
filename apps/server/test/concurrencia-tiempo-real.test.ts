import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Concurrencia real y tiempo real (encargo «rendimiento, navegación, concurrencia y tiempo real», escenarios G–X).
 * Proveedor de API simulado (ningún modelo real, ningún crédito) y sandbox simulado; git real en un repositorio temporal.
 * - G/H: dos historias distintas a la vez; autorizar la iteración de una mientras la otra se ejecuta (antes: 409 «Ya hay
 *   un proceso en ejecución»).
 * - J/O: dos operaciones sobre la MISMA historia no se pisan (arriendo por historia; doble clic → una sola ejecución).
 * - K: cada historia en su worktree y su rama.
 * - L: integrar en main va de una en una (carril del repositorio): dos integraciones a la vez no pierden ninguna.
 * - I/P: un lote no repite ni integra la iteración que autorizas fuera de él; una historia ocupada no frena a las demás.
 * - HU-175: un plan «sin archivos a propósito» no se vuelve a pedir ni se repite; se ofrece un encargo de análisis.
 * - Q–X: canal de cambios (SSE): aviso al cambiar, varias pestañas, recuperación de lo perdido y «resync».
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-concurrencia-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo, backlogRepo } = await import('../src/db/workspace.ts');
const { batchesRepo } = await import('../src/db/batches.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { stopBatchScheduler, scheduleTick, budgetOf } = await import('../src/services/batchRunner.ts');
const { mergeBranch } = await import('../src/services/repoWrite.ts');
const { changed, flushLiveNow, liveCursor, missedSince, subscribeLive } = await import('../src/services/live.ts');
const { activeLeases } = await import('../src/services/executionLocks.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-concurrencia-repo-'));
const uniq = `concurrencia-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/base.ts'), 'export const base = 0;\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node -e ""', test: 'node -e ""', build: 'node -e ""' } }, null, 2));
execSync('git init -q -b main && git add -A && git commit -qm Base', { cwd: repo, env: GIT_ENV });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const port = (app.server.address() as any).port;
after(async () => { stopBatchScheduler(); await app.close(); });
const inject = (method: string, u: string, payload?: unknown) => app.inject({ method: method as any, url: u, payload: payload as any });

// Sandbox simulado: verificación en verde, con una pequeña espera configurable (para solapar operaciones).
let sandboxDelay = 5;
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { const t = new Date().toISOString(); await new Promise(r => setTimeout(r, sandboxDelay)); return { command, exitCode: 0, output: `${command} ok\n# tests 1\n# pass 1`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: sandboxDelay, isolation: 'docker' }; };

const QA_OK = { verdict: 'approved', summary: 'Cumple; verificación en verde.', findings: [], suggestedTests: [] };
const OWNER = '=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre el archivo. Esperado: existe.\n';
const plan = (f: string) => JSON.stringify({ summary: `Crear ${f}`, tasks: [`Crear ${f}`], filesToRead: [], filesToChange: [f], deliverables: [{ path: f, purpose: 'módulo', kind: 'code', estimatedLines: 2 }], acceptance: [`${f} existe`], risks: [] });
const dev = (f: string, c: string) => `=== RESUMEN ===\nCrea ${f}.\n=== ARCHIVO: ${f} | create ===\n${c}\n=== FIN ARCHIVO ===\n${OWNER}`;
const NO_CODE = JSON.stringify({ summary: 'Auditoría de solo lectura: no se cambia ningún archivo del repositorio; el resultado es un documento.', tasks: ['Leer el chat', 'Escribir el informe'], filesToRead: ['src/base.ts'], filesToChange: [], deliverables: [], acceptance: ['hay un informe'], risks: ['El pipeline espera parches'] });
function script(extra: any[] = []) {
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [
    ...extra,
    { match: 'Evalúa la implementación con la EVIDENCIA real', text: JSON.stringify(QA_OK) },
    { match: 'Historia LENTA.*Elabora el plan técnico', text: plan('src/lenta.ts'), delayMs: 2500 },
    { match: 'Historia RAPIDA.*Elabora el plan técnico', text: plan('src/rapida.ts') },
    { match: 'Historia DOBLE.*Elabora el plan técnico', text: plan('src/doble.ts'), delayMs: 600 },
    { match: 'Historia AUDITORIA.*Elabora el plan técnico', text: NO_CODE },
    { match: 'src/lenta.ts', text: dev('src/lenta.ts', 'export const lenta = 1;') },
    { match: 'src/rapida.ts', text: dev('src/rapida.ts', 'export const rapida = 2;') },
    { match: 'src/doble.ts', text: dev('src/doble.ts', 'export const doble = 3;') }
  ], markers: [] }));
  try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
script();

const PIPE = { ...DEFAULT_PIPELINE, gauntlet: { mode: 'off' as const }, maxConsultations: 0 };
const story = (title: string) => addManualItem(S, project.id, { title, criterion: 'el módulo existe' });
async function pending(itemId: string) { const r = await inject('POST', `${W}/projects/${project.id}/backlog/${itemId}/execute`, {}); assert.ok(r.statusCode < 300, r.body); return r.json(); }
const authorize = (id: string) => inject('POST', `${W}/processes/${id}/authorize`, { budgetUsd: 2, authorized: true, pipeline: PIPE });
async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado: ${what} · ${JSON.stringify(v).slice(0, 600)}`); await new Promise(r => setTimeout(r, 40)); v = await fn(); }
  return v;
}
const statusOf = (id: string) => processesRepo(S).get(id)!.status;
/** Un lote activo por proyecto: cada prueba de lotes cierra los anteriores (cancelarlos no toca sus procesos terminados). */
async function closeActiveBatches() { for (const b of batchesRepo(S).active()) await inject('POST', `${W}/batches/${b.id}/cancel`, {}); }

// ------------------------------------------------------------------ G · H · K
test('G/H/K · dos historias distintas a la vez: autorizar una mientras la otra se ejecuta, cada una en su worktree', async () => {
  const a = story('Historia LENTA de prueba'); const b = story('Historia RAPIDA de prueba');
  const pa = await pending(a.id); const pb = await pending(b.id);
  const ra = await authorize(pa.id); assert.equal(ra.statusCode, 200, ra.body);
  assert.equal(statusOf(pa.id), 'running', 'la primera está en ejecución');
  // Antes: 409 «Ya hay un proceso en ejecución. Espera a que termine.»
  const rb = await authorize(pb.id); assert.equal(rb.statusCode, 200, `la segunda empieza aunque la primera siga en marcha: ${rb.body}`);
  assert.equal(statusOf(pa.id), 'running', 'G: las dos a la vez');
  await waitFor(() => [statusOf(pa.id), statusOf(pb.id)], s => s.every(x => x === 'done'), 'las dos terminan');
  const A = processesRepo(S).get(pa.id)!; const B = processesRepo(S).get(pb.id)!;
  assert.equal(A.result?.pipeline?.state, 'verified', A.result?.pipeline?.reason ?? ''); assert.equal(B.result?.pipeline?.state, 'verified', B.result?.pipeline?.reason ?? '');
  // K: worktrees y ramas propios; ninguno toca el checkout principal.
  assert.notEqual(A.result!.applied!.worktree, B.result!.applied!.worktree);
  assert.notEqual(A.result!.applied!.branch, B.result!.applied!.branch);
  assert.ok(fs.existsSync(path.join(A.result!.applied!.worktree!, 'src/lenta.ts')) && !fs.existsSync(path.join(A.result!.applied!.worktree!, 'src/rapida.ts')));
  assert.ok(fs.existsSync(path.join(B.result!.applied!.worktree!, 'src/rapida.ts')) && !fs.existsSync(path.join(B.result!.applied!.worktree!, 'src/lenta.ts')));
  assert.ok(!fs.existsSync(path.join(repo, 'src/lenta.ts')) && !fs.existsSync(path.join(repo, 'src/rapida.ts')), 'el checkout principal no cambia');
});

// ------------------------------------------------------------------ J · O
test('J/O · la MISMA historia: otra iteración no empieza mientras la suya corre, y un doble clic ejecuta una sola vez', async () => {
  const d = story('Historia DOBLE de prueba');
  const p1 = await pending(d.id);
  // Doble clic (o dos pestañas) sobre la misma autorización: una sola ejecución.
  const [x, y] = await Promise.all([authorize(p1.id), authorize(p1.id)]);
  assert.deepEqual([x.statusCode, y.statusCode].sort(), [200, 409], `${x.body} · ${y.body}`);
  // Otra iteración de la MISMA historia mientras la primera corre: no se autoriza (rama y worktree compartidos).
  const it = await inject('POST', `${W}/stories/${d.id}/iterate`, { note: 'otra' });
  if (it.statusCode === 201) {
    const p2 = it.json().process;
    const r2 = await authorize(p2.id);
    assert.equal(r2.statusCode, 409, r2.body); assert.match(r2.json().error, /ya tiene otro proceso en ejecución/);
  } else assert.equal(it.statusCode, 409, `preparar otra iteración mientras corre la suya también se rechaza: ${it.body}`);
  await waitFor(() => statusOf(p1.id), s => s === 'done', 'la primera termina');
  const planCalls = calls().filter(c => /DOBLE/.test(JSON.stringify(c)) || c.rule?.includes('DOBLE')).length;
  assert.ok(planCalls <= 1, `un solo plan pagado (${planCalls})`);
  assert.deepEqual(activeLeases().filter(l => l.key.includes(d.id)), [], 'no quedan arriendos colgados');
});

test('J · dos operaciones a la vez sobre la misma historia: la segunda espera su turno (409 con el motivo), la de otra historia no', async () => {
  const procs = processesRepo(S).list(project.id).filter(p => p.kind === 'story_execution' && p.status === 'done' && p.result?.applied);
  assert.ok(procs.length >= 2, 'hay historias aplicadas de las pruebas anteriores');
  sandboxDelay = 400;
  try {
    const [v1, v2, other] = await Promise.all([
      inject('POST', `${W}/processes/${procs[0].id}/verify`, { authorized: true, command: 'typecheck' }),
      new Promise<any>(r => setTimeout(() => r(inject('POST', `${W}/processes/${procs[0].id}/verify`, { authorized: true, command: 'typecheck' })), 60)),
      new Promise<any>(r => setTimeout(() => r(inject('POST', `${W}/processes/${procs[1].id}/verify`, { authorized: true, command: 'typecheck' })), 60))
    ]);
    assert.equal(v1.statusCode, 200, v1.body);
    assert.equal(v2.statusCode, 409, v2.body); assert.match(v2.json().error, /otra operación en curso \(verificar en el sandbox\)/);
    assert.equal(other.statusCode, 200, `otra historia no se ve afectada: ${other.body}`);
  } finally { sandboxDelay = 5; }
});

// ------------------------------------------------------------------ L
test('L · integrar en main va de una en una: dos integraciones a la vez no pierden ninguna (también con el checkout en otra rama)', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-carril-'));
  execSync('git init -q -b main && git commit -q --allow-empty -m base', { cwd: r, env: GIT_ENV });
  for (const b of ['hu-a', 'hu-b', 'hu-c', 'hu-d']) execSync(`git checkout -q -b ${b} main && echo ${b} > ${b}.txt && git add -A && git commit -qm ${b} && git checkout -q main`, { cwd: r, env: GIT_ENV, shell: 'bash' } as any);
  // Checkout principal EN main: dos merges en la misma carpeta a la vez chocarían con index.lock sin el carril.
  const both = await Promise.all([mergeBranch(r, 'hu-a', 'main'), mergeBranch(r, 'hu-b', 'main')]);
  assert.equal(both.length, 2);
  // Checkout principal en OTRA rama: cada merge va por un worktree temporal y actualiza main; sin carril ni valor
  // anterior esperado, la segunda pisaría a la primera.
  execSync('git checkout -q -b otra', { cwd: r, env: GIT_ENV });
  await Promise.all([mergeBranch(r, 'hu-c', 'main'), mergeBranch(r, 'hu-d', 'main')]);
  const files = execSync('git ls-tree --name-only main', { cwd: r, env: GIT_ENV }).toString();
  for (const b of ['hu-a', 'hu-b', 'hu-c', 'hu-d']) assert.match(files, new RegExp(`${b}\\.txt`), `main contiene ${b}`);
});

// ------------------------------------------------------------------ HU-175
test('HU-175 · plan sin archivos A PROPÓSITO: no se vuelve a pedir, se explica, se ofrece un encargo de análisis y repetirla igual se rechaza', async () => {
  script();
  const a = story('Historia AUDITORIA del chat');
  const p = await pending(a.id); assert.equal((await authorize(p.id)).statusCode, 200);
  await waitFor(() => statusOf(p.id), s => s === 'done', 'se detiene en el plan');
  const proc = processesRepo(S).get(p.id)!;
  assert.equal(proc.result?.pipeline?.pauseKind, 'plan'); assert.ok(proc.result?.planNoCode, 'queda registrado que no cambia código');
  assert.match(proc.result!.pipeline!.reason!, /no cambia ningún archivo/); assert.doesNotMatch(proc.result!.pipeline!.reason!, /HU-155/);
  assert.equal(calls().filter(c => c.rule === 'Historia AUDITORIA.*Elabora el plan técnico').length, 1, 'el plan no se vuelve a pedir (una sola llamada)');
  const g = (await inject('GET', `${W}/processes/${p.id}`)).json();
  const ids = g.guidance.flow.actions.map((x: any) => x.id);
  assert.ok(ids.includes('convert_to_analysis'), ids.join(',')); assert.ok(!ids.includes('retry_process'), 'no se ofrece repetirla igual');
  assert.equal(g.guidance.flow.issue.title, 'La historia no pide cambios de código: decide cómo hacerla');
  assert.doesNotMatch(g.guidance.next, /Desarrollador no entregó/, 'no culpa al Desarrollador (ni siquiera trabajó)');
  const retry = await inject('POST', `${W}/processes/${p.id}/retry`, {}); assert.equal(retry.statusCode, 409, retry.body);
  const before = calls().length;
  const conv = await inject('POST', `${W}/processes/${p.id}/convert-to-analysis`, {}); assert.equal(conv.statusCode, 201, conv.body);
  const d = conv.json(); assert.equal(d.kind, 'delegated_task'); assert.equal(d.status, 'pending_authorization');
  assert.match(d.delegation.request, /Historia AUDITORIA/); assert.match(d.delegation.request, /src\/base\.ts/);
  assert.equal(calls().length, before, 'convertir no llama a la IA');
  const again = await inject('POST', `${W}/processes/${p.id}/convert-to-analysis`, {}); assert.equal(again.json().id, d.id, 'uno solo: pedirlo otra vez devuelve el mismo');
});

// ------------------------------------------------------------------ I · P
test('I/P · el lote sigue la iteración que autorizas fuera de él: no la repite, no la integra, no la cobra; las demás siguen', async () => {
  script();
  const a = story('Historia AUDITORIA para el lote'); const b = story('Historia RAPIDA del lote');
  const created = await inject('POST', `${W}/projects/${project.id}/batches`, { authorized: true, itemIds: [a.id, b.id], totalBudgetUsd: 5, perStoryBudgetUsd: 2, maxCorrections: 1, maxSubscriptionCalls: 100, concurrency: 2, gauntlet: { mode: 'off' }, backends: ['api'], commands: ['typecheck', 'test', 'build'], git: { merge: false } });
  assert.equal(created.statusCode, 201, created.body); const id = created.json().id;
  const get = async () => (await inject('GET', `${W}/batches/${id}`)).json();
  // La de la auditoría se detiene (decides tú); la otra NO espera por ella.
  const b1 = await waitFor(get, x => x.items.find((i: any) => i.itemId === a.id).state === 'needs_owner' && ['awaiting_integration', 'needs_owner'].includes(x.items.find((i: any) => i.itemId === b.id).state), 'una detenida y la otra terminada');
  assert.equal(b1.items.find((i: any) => i.itemId === b.id).state, 'awaiting_integration', 'I: la historia independiente terminó aunque la otra esperaba tu decisión');
  // El propietario prepara una iteración de la auditoría desde la historia (fuera del lote).
  const it = await inject('POST', `${W}/stories/${a.id}/iterate`, { note: 'hazlo como documento' }); assert.equal(it.statusCode, 201, it.body);
  const p2 = it.json().process.id;
  await scheduleTick(S, id);
  const b2 = await get(); const ia = b2.items.find((i: any) => i.itemId === a.id);
  assert.equal(ia.state, 'external', ia.reason); assert.equal(ia.followedProcessId, p2); assert.ok(!ia.processIds.includes(p2), 'su gasto no cuenta en el lote');
  assert.match(ia.reason, /pendiente de tu autorización/);
  assert.notEqual(b2.status, 'completed', 'el lote no da por terminada una historia que sigue fuera');
  const retry = await inject('POST', `${W}/batches/${id}/items/${a.id}/retry`, { authorized: true }); assert.equal(retry.statusCode, 409, `no se repite dentro del lote: ${retry.body}`); assert.match(retry.json().error, /sigue fuera del lote/);
  const budget = budgetOf(S, batchesRepo(S).get(id)!); assert.ok(budget.spent >= 0);
  assert.ok(!batchesRepo(S).get(id)!.items.flatMap(i => i.processIds).includes(p2));
});

// ------------------------------------------------------------------ Q–X · tiempo real
function sse(cursor?: string): { events: { event: string; id: string | null; data: any }[]; close: () => void; ready: Promise<void> } {
  const events: { event: string; id: string | null; data: any }[] = []; let req: http.ClientRequest; let resolveReady!: () => void;
  const ready = new Promise<void>(r => { resolveReady = r; });
  req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: cursor ? { 'last-event-id': cursor } : {} }, res => {
    let buf = '';
    res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const ev = { event: 'message', id: null as string | null, data: null as any }; for (const line of block.split('\n')) { if (line.startsWith('event: ')) ev.event = line.slice(7); else if (line.startsWith('id: ')) ev.id = line.slice(4); else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6)); } if (ev.data) { events.push(ev); if (ev.event === 'hello') resolveReady(); } } });
  });
  return { events, close: () => req.destroy(), ready };
}

test('Q/R/S/X · un cambio llega a todas las pestañas conectadas (solo ids, sin contenido) y agrupado', async () => {
  const t1 = sse(); const t2 = sse(); await Promise.all([t1.ready, t2.ready]);
  const a = story('Historia RAPIDA en tiempo real'); // escribe en el backlog
  const p = await pending(a.id); // crea un proceso
  flushLiveNow();
  await waitFor(() => t1.events.filter(e => e.event === 'message').length, n => n > 0, 'llega el aviso a la pestaña 1');
  await waitFor(() => t2.events.filter(e => e.event === 'message').length, n => n > 0, 'y a la pestaña 2');
  const changes = t1.events.filter(e => e.event === 'message').flatMap(e => e.data.changes);
  assert.ok(changes.some((c: any) => c.entity === 'process' && c.id === p.id && c.itemId === a.id && c.ws === S), JSON.stringify(changes));
  assert.ok(changes.some((c: any) => c.entity === 'backlog' && c.id === a.id));
  for (const c of changes) assert.deepEqual(Object.keys(c).sort().filter(k => !['ws', 'entity', 'id', 'projectId', 'itemId', 'kind'].includes(k)), [], 'solo identificadores');
  const msgs = t1.events.filter(e => e.event === 'message');
  for (const m of msgs) assert.match(m.id ?? '', /^[0-9a-f]{8}:\d+$/, 'id = época:secuencia');
  t1.close(); t2.close();
});

test('U/V · al reconectar se recupera lo perdido (Last-Event-ID); con otra época o un hueco demasiado grande, «resync»', async () => {
  const cur = liveCursor(); const cursor = `${cur.epoch}:${cur.seq}`;
  changed({ ws: S, entity: 'batch', id: 'perdido-1' }); flushLiveNow();
  changed({ ws: S, entity: 'batch', id: 'perdido-2' }); flushLiveNow();
  const missed = missedSince(cursor)!; assert.equal(missed.length, 2);
  assert.deepEqual(missed.flatMap(m => m.changes.map(c => c.id)), ['perdido-1', 'perdido-2']);
  const t = sse(cursor); await t.ready; await waitFor(() => t.events.length, n => n >= 3, 'hello + 2 recuperados');
  assert.deepEqual(t.events.filter(e => e.event === 'message').flatMap(e => e.data.changes.map((c: any) => c.id)), ['perdido-1', 'perdido-2']);
  t.close();
  assert.equal(missedSince('otraepoca:3'), null, 'otro arranque del servidor → volver a pedir todo');
  const r = sse('otraepoca:3'); await r.ready; await waitFor(() => r.events.some(e => e.event === 'resync'), x => x, 'resync');
  r.close();
});

test('Q · tormenta de avisos de progreso: se agrupan (un mensaje) y un cambio de estado prevalece', async () => {
  const got: any[] = []; const off = subscribeLive(m => got.push(m));
  for (let i = 0; i < 50; i++) changed({ ws: S, entity: 'process', id: 'p-tormenta', kind: 'progress' });
  changed({ ws: S, entity: 'process', id: 'p-tormenta', kind: 'state' });
  flushLiveNow(); off();
  assert.equal(got.length, 1); assert.equal(got[0].changes.length, 1); assert.equal(got[0].changes[0].kind, 'state');
});

test('W · stale tab: una acción decidida sobre otra versión del proceso no se ejecuta (409 stale_view) y devuelve el estado actual', async () => {
  const a = story('Historia RAPIDA para pestaña antigua');
  const p = await pending(a.id);
  const seen = (await inject('GET', `${W}/processes/${p.id}`)).json().version; assert.ok(seen);
  // Otra pestaña la autoriza…
  assert.equal((await authorize(p.id)).statusCode, 200);
  await waitFor(() => statusOf(p.id), s => s === 'done', 'termina');
  // …y esta, con lo que veía antes, intenta rechazar el diff: no se hace nada.
  const stale = await inject('POST', `${W}/processes/${p.id}/reject`, { reason: 'desde una pestaña vieja', seenVersion: seen });
  assert.equal(stale.statusCode, 409, stale.body); assert.equal(stale.json().code, 'stale_view'); assert.equal(stale.json().process.id, p.id);
  assert.ok(!processesRepo(S).get(p.id)!.result?.rejected, 'nada cambió');
  const fresh = (await inject('GET', `${W}/processes/${p.id}`)).json().version;
  assert.notEqual(fresh, seen);
});

// ------------------------------------------------------------------ K · L · otra historia integra mientras esta trabaja
test('K/L · otra historia cambia un archivo en main mientras el Desarrollador escribe su versión completa: la rama nace de la base que vio y git lo combina (nunca se pierde en silencio)', async () => {
  const OLD = 'export const base = 0;';
  script([
    { match: 'Evalúa la implementación con la EVIDENCIA real', text: JSON.stringify(QA_OK) },
    { match: 'Historia PISADA.*Elabora el plan técnico', text: JSON.stringify({ summary: 'Cambiar base', tasks: ['Modificar src/base.ts'], filesToRead: ['src/base.ts'], filesToChange: ['src/base.ts'], deliverables: [{ path: 'src/base.ts', purpose: 'valor', kind: 'code', estimatedLines: 2 }], acceptance: ['base cambia'], risks: [] }) },
    { match: 'Historia PISADA.*src/base.ts', text: `=== RESUMEN ===
Modifica src/base.ts.
=== ARCHIVO: src/base.ts | modify ===
${OLD}
export const pisada = 1;
=== FIN ARCHIVO ===
${OWNER}`, delayMs: 1500 }
  ]);
  const s = story('Historia PISADA de prueba');
  const p = await pending(s.id); assert.equal((await authorize(p.id)).statusCode, 200);
  await waitFor(() => processesRepo(S).get(p.id)!.steps.some(st => st.role === 'implementer' && st.status === 'running'), x => x, 'el Desarrollador trabaja');
  // Mientras tanto, otra historia integra un cambio en src/base.ts (en main).
  fs.writeFileSync(path.join(repo, 'src/base.ts'), `${OLD}
export const otra = 'cambio-de-main';
`);
  execSync('git add -A && git commit -qm "otra historia integrada"', { cwd: repo, env: GIT_ENV, shell: 'bash' } as any);
  const other = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim();
  await waitFor(() => statusOf(p.id), st => st === 'done' || st === 'failed', 'termina', 60_000);
  const r = processesRepo(S).get(p.id)!.result!;
  assert.ok(r.baseCommit && r.applied?.branch, `base fijada y rama aplicada: ${r.pipeline?.reason}`);
  const branchHasOther = (() => { try { execSync(`git merge-base --is-ancestor ${other} ${r.applied!.branch}`, { cwd: repo }); return true; } catch { return false; } })();
  assert.equal(branchHasOther, false, 'la rama nace de la base que vio el Desarrollador, no del main posterior');
  // Integrar exige el candidato (main avanzó) y git combina o dice el conflicto: el cambio ajeno nunca se pierde.
  const prep = await inject('POST', `${W}/processes/${p.id}/integration/prepare`, { authorized: true });
  if (prep.statusCode === 409) assert.equal(prep.json().code, 'integration_conflict', prep.body);
  else {
    await waitFor(() => statusOf(p.id), st => st === 'done', 'candidato verificado');
    const wt = processesRepo(S).get(p.id)!.result!.applied!.worktree!;
    const txt = fs.readFileSync(path.join(wt, 'src/base.ts'), 'utf8');
    assert.match(txt, /cambio-de-main/); assert.match(txt, /pisada/);
  }
  assert.match(fs.readFileSync(path.join(repo, 'src/base.ts'), 'utf8'), /cambio-de-main/, 'main conserva el cambio de la otra historia');
});

// ------------------------------------------------------------------ Ronda B (Gauntlet): defectos confirmados y corregidos
test('Ronda B · C1 · si el navegador se va a mitad de una operación, el arriendo de la historia se suelta al terminar (no queda bloqueada)', async () => {
  const applied = processesRepo(S).list(project.id).find(p => p.kind === 'story_execution' && p.status === 'done' && p.result?.applied && !p.result?.merged)!;
  sandboxDelay = 800;
  try {
    await new Promise<void>(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path: `${W}/processes/${applied.id}/verify`, method: 'POST', headers: { 'content-type': 'application/json' } }, () => resolve());
      req.on('error', () => resolve()); req.end(JSON.stringify({ authorized: true, command: 'typecheck' }));
      setTimeout(() => { req.destroy(); resolve(); }, 150);
    });
    await waitFor(() => activeLeases().filter(l => l.key.includes(applied.backlogItemId!)).length, n => n === 0, 'el arriendo se suelta al terminar el manejador', 10_000);
    const again = await inject('POST', `${W}/processes/${applied.id}/verify`, { authorized: true, command: 'typecheck' });
    assert.equal(again.statusCode, 200, again.body);
  } finally { sandboxDelay = 5; }
});

test('Ronda B · C2 · la iteración del lote que autorizas tú desde su proceso: el lote la sigue y NO la ejecuta otra vez', async () => {
  await closeActiveBatches(); script();
  const a = story('Historia RAPIDA para iterar en el lote');
  const created = await inject('POST', `${W}/projects/${project.id}/batches`, { authorized: true, itemIds: [a.id], totalBudgetUsd: 5, perStoryBudgetUsd: 2, maxCorrections: 1, maxSubscriptionCalls: 100, concurrency: 1, gauntlet: { mode: 'off' }, backends: ['api'], commands: ['typecheck', 'test', 'build'], git: { merge: false } });
  assert.equal(created.statusCode, 201, created.body); const id = created.json().id;
  const get = async () => (await inject('GET', `${W}/batches/${id}`)).json();
  await waitFor(get, x => x.items[0].state === 'awaiting_integration', 'terminada técnicamente');
  assert.equal((await inject('POST', `${W}/batches/${id}/pause`, {})).statusCode, 200);
  const it = await inject('POST', `${W}/batches/${id}/items/${a.id}/iterate`, { authorized: true, note: 'otra vuelta' }); assert.equal(it.statusCode, 200, it.body);
  const p2 = (await get()).items[0].nextProcessId; assert.ok(p2);
  const plansBefore = calls().filter(c => c.rule === 'Historia RAPIDA.*Elabora el plan técnico').length;
  assert.equal((await authorize(p2)).statusCode, 200, 'la autorizas tú desde su proceso');
  assert.equal((await inject('POST', `${W}/batches/${id}/resume`, { authorized: true })).statusCode, 200);
  await waitFor(() => statusOf(p2), s => s === 'done' || s === 'failed', 'termina');
  await scheduleTick(S, id);
  assert.equal(processesRepo(S).get(p2)!.status, 'done', processesRepo(S).get(p2)!.error ?? '');
  assert.equal(calls().filter(c => c.rule === 'Historia RAPIDA.*Elabora el plan técnico').length - plansBefore, 1, 'un solo plan pagado para esa iteración');
  const ev = (await get()).events.map((e: any) => e.message).join(' | ');
  assert.ok(!ev.includes(`empieza (proceso ${p2.slice(0, 8)}`), `el lote no la empezó otra vez: ${ev.slice(-600)}`);
});

test('Ronda B · M3 · la iteración seguida fuera del lote no oscila: integrada → pendiente de aceptación estable, y tu «No aceptar» se respeta', async () => {
  await closeActiveBatches(); script();
  const a = story('Historia RAPIDA seguida fuera del lote');
  const created = await inject('POST', `${W}/projects/${project.id}/batches`, { authorized: true, itemIds: [a.id], totalBudgetUsd: 5, perStoryBudgetUsd: 2, maxCorrections: 1, maxSubscriptionCalls: 100, concurrency: 1, gauntlet: { mode: 'off' }, backends: ['api'], commands: ['typecheck', 'test', 'build'], git: { merge: false } });
  const id = created.json().id; const get = async () => (await inject('GET', `${W}/batches/${id}`)).json();
  await waitFor(get, x => x.items[0].state === 'awaiting_integration', 'terminada técnicamente');
  const it = await inject('POST', `${W}/stories/${a.id}/iterate`, { note: 'desde la historia', discardApplied: true }); assert.equal(it.statusCode, 201, it.body);
  const p2 = it.json().process.id;
  await scheduleTick(S, id); assert.equal((await get()).items[0].state, 'external');
  assert.equal((await authorize(p2)).statusCode, 200);
  await waitFor(() => statusOf(p2), s => s === 'done', 'termina');
  const m = await inject('POST', `${W}/processes/${p2}/merge`, { authorized: true }); assert.equal(m.statusCode, 200, m.body);
  await scheduleTick(S, id);
  const after1 = await get(); assert.equal(after1.items[0].state, 'awaiting_acceptance', after1.items[0].reason);
  const n = after1.events.length;
  for (let k = 0; k < 3; k++) await scheduleTick(S, id);
  const after2 = await get(); assert.equal(after2.items[0].state, 'awaiting_acceptance'); assert.equal(after2.events.length, n, 'sin eventos nuevos en cada vuelta (no oscila)');
  assert.equal((await inject('POST', `${W}/batches/${id}/items/${a.id}/reject`, { note: 'no me convence' })).statusCode, 200);
  await scheduleTick(S, id); await scheduleTick(S, id);
  assert.equal((await get()).items[0].state, 'rejected', 'tu «No aceptar» se mantiene');
});

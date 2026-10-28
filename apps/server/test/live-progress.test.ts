import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Incidente HU-155 (iteración 2): la pantalla dejó de avanzar durante una llamada REAL mientras el servidor seguía
 * trabajando. Causa verificada: el renderizador Markdown entraba en un bucle infinito con ciertas líneas (la pestaña se
 * congelaba). Además: duración «0 s» en un paso en curso (continuación), uso previo sin rotular, un sondeo que se paraba
 * con un solo error y ninguna defensa si un adaptador ignoraba el plazo. Proveedor SIMULADO (0 USD), datos sintéticos.
 *  1 respuesta normal · 2 nunca responde · 3 empieza a responder y no termina · 4 supera el plazo · 5 cancelación ·
 *  8/9 reinicio y registros huérfanos (agent-failures H/J) · 10 desfase de reloj servidor/navegador · 11 confirmado,
 *  no confirmado y reservado · 12 duración de un paso con datos de una llamada anterior · 14 el plazo pasa a un estado
 *  visible y recuperable · 15 sin llamadas duplicadas · vigilante si el adaptador no respeta el plazo · llamada pasada de
 *  plazo nunca aparece sana. 6, 7 y 13 (navegador) en Playwright.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-live-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
delete process.env.PORTAL_PROVIDER_TIMEOUT_SEC; delete process.env.PORTAL_PROVIDER_RETRIES;
process.env.PORTAL_PROVIDER_BACKOFF_MS = '20';
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline } = await import('@portal-ia/domain');
const { anthropicAdapter, ProviderRequestError, resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { newPipeline } = await import('../src/services/storyPipeline.ts');
const { withWatchdog, inflightCount } = await import('../src/services/providerCalls.ts');
const { OVERDUE_GRACE_MS } = await import('../src/services/storyFlow.ts');
const { trackJob } = await import('../src/services/activeJobs.ts');
const { isCancelled } = await import('../src/services/assessment.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { parseMarkdown } = await import('../../web/src/lib/markdown.ts');
const { callTiming, computeOffset, freshness, stepDurationMs } = await import('../../web/src/lib/liveStatus.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const real = { ...sandboxDeps }; const realFetch = globalThis.fetch;
after(() => { sandboxDeps.detect = real.detect; sandboxDeps.run = real.run; globalThis.fetch = realFetch; delete process.env.PORTAL_PROVIDER_TIMEOUT_SEC; delete process.env.PORTAL_PROVIDER_WATCHDOG_GRACE_MS; });

// ---------- Interfaz (funciones puras, sin navegador) ----------
test('Markdown: nunca se queda en un bucle (título con \\r suelto, separadores Unicode) y sigue interpretando lo normal', () => {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  for (const text of ['## Plan\rmás', '## Archivos\r', `### Cambios${LS}siguientes`, `- uno${PS}dos`, '#\r', '####\t\r\r\r', '```\nsin cerrar', '| a |\n|---|\n| 1 |']) {
    const t0 = Date.now(); const blocks = parseMarkdown(text);
    assert.ok(Date.now() - t0 < 200 && blocks.length > 0, JSON.stringify(text));
  }
  assert.deepEqual(parseMarkdown('## Plan\rmás').map(b => b.kind), ['heading', 'para'], 'el \\r suelto es un salto de línea');
  const md = parseMarkdown('# Título\nTexto **negrita**\nsigue\n\n- uno\n- dos\n\n1. a\n```ts\nconst a = 1;\n```\n| x | y |\n|---|---|\n| 1 | 2 |');
  assert.deepEqual(md.map(b => b.kind), ['heading', 'para', 'list', 'list', 'code', 'table']);
  assert.deepEqual(md[1], { kind: 'para', lines: ['Texto **negrita**', 'sigue'] });
  assert.equal((md[3] as any).ordered, true); assert.equal((md[4] as any).text, 'const a = 1;'); assert.deepEqual((md[5] as any).rows, [['x', 'y'], ['1', '2']]);
  // Una salida grande de un agente (≈ 50 000 caracteres, como la de HU-155) se analiza en poco tiempo.
  const big = Array.from({ length: 2500 }, (_, i) => i % 50 === 0 ? `## Sección ${i}\r` : `línea ${i} con \`código\` y **texto**`).join('\n');
  const t0 = Date.now(); parseMarkdown(big); assert.ok(Date.now() - t0 < 500, `${Date.now() - t0} ms`);
});

test('10 · reloj: los tiempos se miden con la hora del servidor aunque el navegador vaya desfasado', () => {
  // El navegador va 1 h atrasado: el servidor responde con su hora en x-server-time.
  const browserNow = Date.parse('2026-10-28T02:24:00Z'); const serverNowMs = browserNow + 3_600_000;
  const offset = computeOffset(serverNowMs + 100, browserNow, browserNow + 200);
  assert.equal(offset, 3_600_000);
  const live = { startedAt: new Date(serverNowMs - 157_000).toISOString(), lastEventAt: new Date(serverNowMs - 150_000).toISOString(), deadlineAt: new Date(serverNowMs + 443_000).toISOString() };
  const t = callTiming(live, browserNow + offset);
  assert.equal(t.sinceStartMs, 157_000); assert.equal(t.sinceLastEventMs, 150_000); assert.equal(t.untilDeadlineMs, 443_000); assert.equal(t.overdue, false);
  // Sin corregir, el navegador vería una llamada «que aún no empezó» y un plazo a 1 h 7 min.
  assert.equal(callTiming(live, browserNow).sinceStartMs, 0);
  assert.equal(callTiming({ ...live, deadlineAt: new Date(serverNowMs - 1000).toISOString() }, serverNowMs).overdue, true);
});

test('7 · conexión: datos frescos, desactualizados (sin respuesta reciente) o sin conexión (la última petición falló)', () => {
  const now = 1_000_000;
  assert.equal(freshness(now - 2000, null, null, now).kind, 'fresh');
  assert.equal(freshness(now - 15_000, null, null, now).kind, 'stale', 'sin respuesta en 15 s');
  assert.equal(freshness(now - 4000, now - 1000, 'El servidor no respondió en 20 s', now).kind, 'offline');
  assert.equal(freshness(now - 1000, now - 4000, 'viejo', now).kind, 'fresh', 'una respuesta posterior al fallo lo resuelve');
  assert.equal(freshness(null, null, null, now).kind, 'stale');
});

test('12 · duración de un paso: en curso se mide hasta ahora aunque conserve el final de una llamada anterior', () => {
  const now = Date.parse('2026-10-28T03:26:50Z');
  // Lo que mostraba HU-155: continuación iniciada a las 03:24:13 con el final de la llamada 1 (03:24:13.0) → «0 s».
  assert.equal(stepDurationMs({ status: 'running', startedAt: '2026-10-28T03:24:13.200Z', finishedAt: '2026-10-28T03:24:13.000Z' }, now), 156_800);
  assert.equal(stepDurationMs({ status: 'done', startedAt: '2026-10-28T03:24:13.000Z', finishedAt: '2026-10-28T03:26:57.000Z' }, now), 164_000);
  assert.equal(stepDurationMs({ status: 'pending', startedAt: null, finishedAt: null }, now), null);
});

// ---------- Adaptador y vigilante ----------
const req = (extra: Record<string, unknown> = {}): any => ({ model: 'claude-sonnet-4-5', system: 's', user: 'u', maxTokens: 100, effort: 'low', supportsEffort: false, ...extra });

test('1/3 · adaptador: respuesta normal; y una respuesta que empieza pero no termina se corta al plazo (lectura incluida)', async () => {
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } }), { status: 200 })) as any;
    const ok = await anthropicAdapter.complete('k', {}, req({ timeoutMs: 2000 }));
    assert.equal(ok.text, 'ok'); assert.equal(ok.inputTokens, 3);
    // Cabeceras recibidas, cuerpo que nunca termina (el fetch real corta el cuerpo al abortar; aquí igual).
    let streamAborted = false;
    globalThis.fetch = ((_u: string, init: RequestInit) => Promise.resolve(new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{"content":[')); init.signal?.addEventListener('abort', () => { streamAborted = true; c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); }
    }), { status: 200, headers: { 'content-type': 'application/json' } }))) as any;
    const progress: string[] = []; const t0 = Date.now();
    await assert.rejects(anthropicAdapter.complete('k', {}, req({ timeoutMs: 150, onProgress: (e: string) => progress.push(e) })), (e: any) => e instanceof ProviderRequestError && e.error.code === 'timeout');
    assert.ok(Date.now() - t0 < 2000); assert.equal(streamAborted, true, 'la lectura del cuerpo se abortó'); assert.deepEqual(progress, ['sent', 'headers'], 'empezó a responder y no terminó');
  } finally { globalThis.fetch = realFetch; }
});

test('vigilante: si la llamada ignora su plazo y la cancelación, se aborta y se da por agotada (nunca espera infinita)', async () => {
  process.env.PORTAL_PROVIDER_WATCHDOG_GRACE_MS = '50';
  try {
    const ctrl = new AbortController(); const t0 = Date.now();
    await assert.rejects(withWatchdog(new Promise(() => { /* nunca */ }), ctrl, 100), (e: any) => e instanceof ProviderRequestError && e.error.code === 'timeout');
    assert.ok(Date.now() - t0 < 1000); assert.equal(ctrl.signal.aborted, true);
    assert.equal(await withWatchdog(Promise.resolve(7), new AbortController(), 100), 7, 'lo normal no cambia');
  } finally { delete process.env.PORTAL_PROVIDER_WATCHDOG_GRACE_MS; }
});

// ---------- Procesos ----------
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-live-repo-'));
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'live-fixture', version: '1.0.0', private: true, scripts: { typecheck: 'echo ok', test: 'echo ok', build: 'echo ok' } }));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { await app.close(); });
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { const t = new Date().toISOString(); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: t, durationMs: 5, isolation: 'docker' }; };

const PLAN = '{"summary":"Cambiar a","tasks":["Editar src/a.ts"],"filesToRead":["src/a.ts"],"filesToChange":["src/a.ts"],"acceptance":["a = 2"],"risks":[]}';
// Entrega en dos partes: la primera se corta por longitud a mitad del bloque; la continuación lo termina.
const PART1 = '=== RESUMEN ===\n## Cambios\r\nCambia a.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n';
const PART2 = '==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nEl contador muestra 2.';
const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple; verificación en verde.', findings: [], suggestedTests: [] });
const R = { plan: 'plan técnico', cont: 'Tu respuesta anterior se cortó por el límite de longitud', qa: 'Evalúa la implementación con la EVIDENCIA real', dev: 'Implementa la historia' };
type Rule = { match: string; text?: string; stopReason?: string; delayMs?: number; hang?: boolean; error?: string };
function script(dev: Partial<Rule>, cont: Partial<Rule> = {}) {
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: R.plan, text: PLAN }, { match: R.cont, text: PART2, ...cont }, { match: R.qa, text: QA_OK }, { match: R.dev, ...dev }] }));
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const count = (m: string) => calls().filter(c => c.rule === m).length;
const waitFor = async <T>(fn: () => T | null | undefined | false, ms = 20_000): Promise<T> => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('tiempo de espera agotado en la prueba'); await new Promise(r => setTimeout(r, 20)); } };
const stepCostSum = (id: string) => processesRepo(S).get(id)!.steps.reduce((a, s) => a + s.costUsd, 0);
function newStory(title: string, cfg: Partial<typeof DEFAULT_PIPELINE> | null = {}) {
  const it = addManualItem(S, project.id, { title, criterion: 'a vale 2' });
  const p = createStoryProcess(S, project.id, it.id);
  if (cfg) processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, ...cfg })) });
  processesRepo(S).authorize(p.id, 5);
  return p.id;
}
const start = (id: string) => trackJob(id, runStory(S, id, () => undefined, () => isCancelled(id)));

test('11/12 · continuación (como HU-155): mientras corre, el paso no arrastra el final ni el costo de la llamada anterior sin rotular; al terminar todo cuadra', async () => {
  script({ text: PART1, stopReason: 'max_tokens' }, { delayMs: 800 });
  const id = newStory('Continuación en curso');
  const job = start(id);
  const dev = await waitFor(() => processesRepo(S).get(id)!.steps.find(s => s.role === 'implementer' && s.status === 'running' && s.live?.operation));
  assert.match(dev.live!.operation!, /^Continuación 1 de 2: la respuesta anterior se cortó por longitud/);
  assert.equal(dev.finishedAt, null, 'el final de la llamada 1 no sigue visible mientras corre la continuación');
  assert.ok(dev.inputTokens > 0 && dev.costUsd > 0, 'conserva el uso CONFIRMADO de la llamada 1 (la interfaz lo rotula «confirmados antes»)');
  const p0 = processesRepo(S).get(id)!;
  assert.ok(Math.abs(p0.spentUsd - stepCostSum(id)) < 1e-9, 'confirmado = suma de las llamadas terminadas; la continuación aún no suma nada');
  assert.ok(dev.live!.estimatedUsd > 0, 'la llamada en curso solo tiene una reserva estimada');
  const flow = (await app.inject({ method: 'GET', url: `${W}/processes/${id}` }));
  assert.ok(Number(flow.headers['x-server-time']) > 0, 'cada respuesta lleva la hora del servidor'); assert.equal(flow.headers['cache-control'], 'no-store');
  await job;
  const p = processesRepo(S).get(id)!;
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  const d = p.steps.find(s => s.role === 'implementer')!;
  assert.ok(Date.parse(d.finishedAt!) >= Date.parse(d.startedAt!), 'duración coherente');
  assert.equal(d.live, null); assert.ok(d.outputMd!.includes('export const a = 2;'), 'salida = llamada 1 + continuación');
  assert.ok(Math.abs(p.spentUsd - stepCostSum(id)) < 1e-9, 'el gasto confirmado es exactamente la suma de los pasos');
  assert.equal(count(R.dev), 1); assert.equal(count(R.cont), 1, 'sin llamadas duplicadas');
});

test('2/4/14 · la continuación agota su plazo: se aborta, el paso conserva lo confirmado de la llamada 1 y queda un estado visible', async () => {
  script({ text: PART1, stopReason: 'max_tokens' }, { delayMs: 8000 });
  process.env.PORTAL_PROVIDER_TIMEOUT_SEC = '0.3';
  const id = newStory('Continuación sin respuesta', null);
  const t0 = Date.now();
  try { await start(id); } finally { delete process.env.PORTAL_PROVIDER_TIMEOUT_SEC; }
  assert.ok(Date.now() - t0 < 5000, 'no esperó a la respuesta simulada de 8 s');
  const p = processesRepo(S).get(id)!;
  assert.equal(p.status, 'failed'); assert.equal(p.result!.failure!.class, 'PROVIDER_TIMEOUT');
  const d = p.steps.find(s => s.role === 'implementer')!;
  assert.equal(d.status, 'failed'); assert.match(d.error ?? '', /plazo/);
  assert.ok(d.costUsd > 0 && d.inputTokens > 0, 'el uso confirmado de la llamada 1 NO se borra al fallar la continuación');
  assert.ok(d.outputMd?.includes('=== ARCHIVO: src/a.ts'), 'la salida parcial se conserva (recuperable sin IA)');
  assert.ok(Math.abs(p.spentUsd - stepCostSum(id)) < 1e-9, 'el gasto confirmado cuadra con los pasos');
  assert.ok((p.unconfirmedUsd ?? 0) > 0, 'lo que pudo facturar la continuación abortada queda como no confirmado');
  const flow = (await app.inject({ method: 'GET', url: `${W}/processes/${id}` })).json().guidance.flow;
  assert.equal(flow.issue.kind, 'provider_timeout'); assert.equal(flow.issue.cause, 'environment');
  assert.equal(count(R.cont), 1, 'sin reintento automático de un plazo agotado');
});

test('vigilante en un proceso real: un adaptador que no respeta el plazo ni la cancelación no deja el paso «esperando» para siempre', async () => {
  script({ hang: true });
  process.env.PORTAL_PROVIDER_TIMEOUT_SEC = '0.2'; process.env.PORTAL_PROVIDER_WATCHDOG_GRACE_MS = '100';
  const id = newStory('Adaptador colgado', null);
  const t0 = Date.now();
  try { await start(id); } finally { delete process.env.PORTAL_PROVIDER_TIMEOUT_SEC; delete process.env.PORTAL_PROVIDER_WATCHDOG_GRACE_MS; }
  assert.ok(Date.now() - t0 < 3000, `terminó en ${Date.now() - t0} ms`);
  const p = processesRepo(S).get(id)!;
  assert.equal(p.status, 'failed'); assert.equal(p.result!.failure!.class, 'PROVIDER_TIMEOUT');
  assert.match(p.steps.find(s => s.role === 'implementer')!.error ?? '', /no terminó al abortarla/);
  assert.equal(inflightCount(id), 0); assert.equal(count(R.dev), 1);
});

test('una llamada «en curso» pasada de plazo nunca aparece sana: problema explícito con «Cancelar»', async () => {
  const id = newStory('Llamada sin cerrar');
  let release!: () => void; const job = trackJob(id, new Promise<void>(r => { release = r; }));
  const procs = processesRepo(S); const dev = procs.get(id)!.steps.find(s => s.role === 'implementer')!;
  procs.stepStart(dev.id);
  const past = Date.now() - OVERDUE_GRACE_MS - 5000;
  procs.setStepLive(dev.id, { state: 'waiting', provider: 'anthropic', model: 'claude-opus-4-1', startedAt: new Date(past - 600_000).toISOString(), lastEvent: 'Solicitud enviada; esperando la respuesta del proveedor', lastEventAt: new Date(past - 600_000).toISOString(), deadlineAt: new Date(past).toISOString(), timeoutMs: 600_000, attempt: 1, maxAttempts: 3, estimatedUsd: 0.9, inputTokensEstimated: 30_000, inputUsd: 0.45, maxOutputTokens: 16_000 });
  try {
    const flow = (await app.inject({ method: 'GET', url: `${W}/processes/${id}` })).json().guidance.flow;
    assert.equal(flow.issue.kind, 'call_overdue'); assert.equal(flow.issue.level, 'blocker'); assert.equal(flow.actions[0].id, 'cancel');
    assert.match(flow.stages.find((s: any) => s.key === 'execute').detail, /superó su plazo/);
  } finally { release(); await job; procs.finish(id, 'cancelled'); }
});

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Fallos de los agentes y del proveedor (regresión de HU-155, que quedó «Reparando la entrega del Desarrollador» tras
 * clasificar como negativa una explicación legítima). Proveedor SIMULADO (0 USD, sin red), datos y repositorio
 * sintéticos, sandbox determinista. Escenarios:
 *  A negativa real del proveedor: no se repara ni se reintenta · B sin falsos positivos de negativa ·
 *  C falta información: contexto del repositorio, especialista del equipo autorizado o pregunta al propietario ·
 *  D permiso (data/ del propietario): nunca se escala ni se consulta a nadie · E salida no válida: sí se repara ·
 *  F plazo agotado: se aborta, se clasifica y no se reintenta solo · G cancelar aborta la llamada en curso ·
 *  H reinicio: se marca sin reenviar nada ni contabilizar dos veces · I reintentos acotados de errores transitorios ·
 *  J un proceso sin ejecución viva no aparece como sano · K costo confirmado y no confirmado separados ·
 *  L el presupuesto detiene las llamadas · M/N la puerta de QA y el pipeline previo siguen igual (autonomous-pipeline) ·
 *  O las lecciones se detectan como evidencia y nunca se validan solas.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-fail-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
delete process.env.PORTAL_PROVIDER_TIMEOUT_SEC; delete process.env.PORTAL_PROVIDER_RETRIES;
process.env.PORTAL_PROVIDER_BACKOFF_MS = '20';
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline } = await import('@portal-ia/domain');
const { anthropicAdapter, openaiAdapter, ProviderRequestError, resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { newPipeline, pickConsultant } = await import('../src/services/storyPipeline.ts');
const { assessDeveloperOutput, failureClassOf } = await import('../src/services/devOutput.ts');
const { callTimeoutMs, isTransient, maybeBilled, providerFailureClass, inflightCount, TIMEOUT_LIMITS } = await import('../src/services/providerCalls.ts');
const { recoverInterruptedProcesses } = await import('../src/services/interruptions.ts');
const { trackJob } = await import('../src/services/activeJobs.ts');
const { isCancelled } = await import('../src/services/assessment.ts');
const { lessonsRepo } = await import('../src/services/lessons.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const real = { ...sandboxDeps };
const realFetch = globalThis.fetch;
after(() => { sandboxDeps.detect = real.detect; sandboxDeps.run = real.run; globalThis.fetch = realFetch; delete process.env.PORTAL_PROVIDER_TIMEOUT_SEC; });

// ---------- Clasificación (sin IA) ----------
const exists = (p: string) => p === 'src/a.ts' || p === 'src/notes.ts';
const assess = (t: string, o: { stop?: string | null; refusal?: string | null } = {}) => assessDeveloperOutput(t, { stopReason: o.stop ?? 'end_turn', exists, providerRefusal: o.refusal ?? null }).assessment;

test('A · negativa del proveedor: solo con la señal explícita de la API o una negativa breve de apertura', () => {
  const api = assess('I can’t help with that.', { stop: 'refusal', refusal: 'I can’t help with that.' });
  assert.equal(api.kind, 'provider_refusal'); assert.equal(failureClassOf(api), 'PROVIDER_REFUSAL');
  const short = assess('Lo siento, no puedo ayudar con esta solicitud.');
  assert.equal(short.kind, 'provider_refusal', 'negativa breve de apertura');
  // La señal de la API manda aunque el texto parezca una explicación.
  assert.equal(assess('Necesito más contexto para seguir.', { refusal: 'policy' }).kind, 'provider_refusal');
});

test('B · sin falsos positivos: explicaciones legítimas no son negativas del proveedor', () => {
  // El texto de HU-155 (reconstruido): explica por qué no puede verificar con los datos reales → permiso, no negativa.
  const hu155 = assess('He revisado la historia y el código. No puedo implementar el cambio de forma segura: para comprobar el comportamiento necesito revisar la base de datos real, pero no tengo acceso a la carpeta data/ del propietario ni a sus credenciales.');
  assert.equal(hu155.kind, 'blocked'); assert.equal(hu155.blocker?.type, 'permission'); assert.equal(failureClassOf(hu155), 'PERMISSION_REQUIRED');
  assert.equal(hu155.blocker?.declared, false, 'deducido del texto (heurística), y así se indica');
  // Pide un archivo → información que falta (el equipo puede dársela sin preguntar a nadie).
  const files = assess('No puedo completar la tarea sin ver el contenido de src/notes.ts.');
  assert.equal(files.kind, 'blocked'); assert.equal(failureClassOf(files), 'MISSING_INFORMATION'); assert.deepEqual(files.requestedFiles, ['src/notes.ts']);
  // Capacidad que no tiene → UNSUPPORTED_CAPABILITY.
  assert.equal(failureClassOf(assess('No puedo ejecutar el navegador para comprobar la pantalla: no dispongo de herramientas de navegación.')), 'UNSUPPORTED_CAPABILITY');
  // «No puedo» dentro de una implementación válida no cambia nada.
  const impl = assess('=== RESUMEN ===\nNo puedo garantizar el rendimiento, pero el cambio es mínimo.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===');
  assert.equal(impl.kind, 'implementation'); assert.equal(failureClassOf(impl), null);
  // «Sin cambios» justificado tampoco.
  assert.equal(assess('=== RESUMEN ===\nNo puedo encontrar nada que cambiar.\n=== SIN CAMBIOS ===\nEl contador ya muestra 2.').kind, 'no_changes');
  // Sección BLOQUEO declarada: tipo, necesidad, pregunta y a quién consultar.
  const declared = assess('=== RESUMEN ===\nFalta un dato.\n=== BLOQUEO ===\ntipo: información\nnecesito: saber qué pruebas cubren el contador\npregunta: ¿Qué pruebas existen para src/a.ts?\nconsultar: QA');
  assert.equal(declared.kind, 'blocked'); assert.deepEqual({ ...declared.blocker, need: undefined }, { type: 'information', need: undefined, question: '¿Qué pruebas existen para src/a.ts?', consult: 'QA', declared: true });
  // Una respuesta sin nada reconocible sigue siendo salida no válida (se repara), no una negativa.
  assert.equal(failureClassOf(assess('Hecho, he revisado la historia.')), 'INVALID_OUTPUT');
  assert.equal(failureClassOf(assess('=== ARCHIVO: src/b.ts | create ===\nexport const b =', { stop: 'max_tokens' })), 'INCOMPLETE_OUTPUT');
});

// ---------- Ciclo de vida de la llamada (adaptadores reales con fetch sustituido: sin red) ----------
/** fetch sustituto: responde tras `ms` (o nunca) y respeta la señal de aborto como el real. */
function stubFetch(body: any, ms: number | null, status = 200) {
  const seen: { aborted: boolean }[] = [];
  globalThis.fetch = ((_url: string, init: RequestInit) => new Promise((resolve, reject) => {
    const rec = { aborted: false }; seen.push(rec);
    const t = ms === null ? null : setTimeout(() => resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })), ms);
    init.signal?.addEventListener('abort', () => { rec.aborted = true; if (t) clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
  })) as any;
  return seen;
}
const req = (extra: Record<string, unknown> = {}): any => ({ model: 'claude-sonnet-4-5', system: 's', user: 'u', maxTokens: 100, effort: 'low', supportsEffort: false, ...extra });

test('F/G · adaptadores: plazo real (timeout), cancelación real (cancelled), progreso y negativa explícita', async () => {
  try {
    // Plazo: la petición HTTP se aborta al cumplirse, no se espera a que el proveedor responda.
    let seen = stubFetch({}, null);
    const progress: string[] = [];
    const t0 = Date.now();
    await assert.rejects(anthropicAdapter.complete('k', {}, req({ timeoutMs: 60, onProgress: (e: string) => progress.push(e) })), (e: any) => e instanceof ProviderRequestError && e.error.code === 'timeout');
    assert.ok(Date.now() - t0 < 1000); assert.equal(seen[0].aborted, true, 'la petición se abortó de verdad'); assert.deepEqual(progress, ['sent']);
    // Cancelación del llamante.
    seen = stubFetch({}, null);
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 30);
    await assert.rejects(openaiAdapter.complete('k', {}, req({ model: 'gpt-4o', timeoutMs: 5000 }), ctrl.signal), (e: any) => e instanceof ProviderRequestError && e.error.code === 'cancelled');
    assert.equal(seen[0].aborted, true);
    // Negativa explícita de la API (Anthropic stop_reason «refusal»; OpenAI message.refusal) y eventos de progreso confirmados.
    stubFetch({ content: [{ type: 'text', text: 'I can’t help with that.' }], stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 5 } }, 5);
    const prog2: string[] = [];
    const r = await anthropicAdapter.complete('k', {}, req({ timeoutMs: 5000, onProgress: (e: string) => prog2.push(e) }));
    assert.equal(r.stopReason, 'refusal'); assert.ok(r.refusal); assert.deepEqual(prog2, ['sent', 'headers', 'body']);
    stubFetch({ choices: [{ message: { content: null, refusal: 'No puedo ayudar con eso.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }, 5);
    assert.equal((await openaiAdapter.complete('k', {}, req({ model: 'gpt-4o', timeoutMs: 5000 }))).refusal, 'No puedo ayudar con eso.');
    stubFetch({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} }, 5);
    assert.equal((await anthropicAdapter.complete('k', {}, req({ timeoutMs: 5000 }))).refusal, null, 'una respuesta normal no es una negativa');
    // Errores HTTP: 529 sobrecargado es transitorio; 401 no.
    stubFetch({ error: { message: 'overloaded' } }, 5, 529);
    const e529 = await anthropicAdapter.complete('k', {}, req({ timeoutMs: 5000 })).catch(e => e);
    assert.equal(isTransient(e529), true); assert.equal(providerFailureClass(e529).kind, 'PROVIDER_CONNECTION_ERROR'); assert.equal(maybeBilled(e529), true);
    stubFetch({ error: { message: 'bad key' } }, 5, 401);
    const e401 = await anthropicAdapter.complete('k', {}, req({ timeoutMs: 5000 })).catch(e => e);
    assert.equal(isTransient(e401), false); assert.equal(providerFailureClass(e401).kind, 'PERMISSION_REQUIRED'); assert.equal(maybeBilled(e401), false);
    // Error de red: transitorio.
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as any;
    const eNet = await anthropicAdapter.complete('k', {}, req({ timeoutMs: 5000 })).catch(e => e);
    assert.equal(eNet.error.code, 'network'); assert.equal(isTransient(eNet), true);
  } finally { globalThis.fetch = realFetch; }
});

test('F · plazo de cada llamada: proporcional a lo que puede generar, acotado y configurable', () => {
  assert.equal(callTimeoutMs(500, 'low'), TIMEOUT_LIMITS.minMs, 'mínimo 90 s');
  assert.equal(callTimeoutMs(2500, 'low'), 160_000, '60 s + 2 500 tokens a 25 tokens/s');
  assert.equal(callTimeoutMs(4000, 'medium'), 340_000, '60 s + (4 000 + 3 000 de razonamiento) a 25 tokens/s');
  assert.equal(callTimeoutMs(12_000, 'high'), TIMEOUT_LIMITS.maxMs, '12 000 + 8 000 tokens: tope de 10 min');
  assert.equal(callTimeoutMs(64_000, 'high'), TIMEOUT_LIMITS.maxMs, 'máximo 10 min');
  assert.equal(callTimeoutMs(12_000, 'high', 30), 30_000, 'fijado por proceso');
  assert.equal(normalizePipeline({ ...DEFAULT_PIPELINE, providerTimeoutSec: 2 }).providerTimeoutSec, 5, 'por proceso: mínimo 5 s');
  assert.equal(normalizePipeline({ ...DEFAULT_PIPELINE, maxProviderRetries: 9 }).maxProviderRetries, 3, 'reintentos: máximo 3');
});

// ---------- Entorno de procesos ----------
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-fail-repo-'));
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, 'src/notes.ts'), 'export const n = 0; // NOTAS-REPO\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fail-fixture', version: '1.0.0', private: true, scripts: { typecheck: 'echo ok', test: 'echo ok', build: 'echo ok' } }, null, 2));
// Base fechada en el pasado: la guarda «el archivo cambió después de que el Desarrollador lo leyera» compara la fecha
// del commit (resolución de 1 s) con la del proceso; con la base en el mismo segundo, un ajuste del reloj de la VM de
// Docker Desktop podía dispararla al azar dentro del sandbox.
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { await app.close(); });
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { const t = new Date().toISOString(); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: t, durationMs: 5, isolation: 'docker' }; };

const PLAN = '{"summary":"Cambiar a","tasks":["Editar src/a.ts"],"filesToRead":["src/a.ts"],"filesToChange":["src/a.ts"],"acceptance":["a = 2"],"risks":[]}';
const PATCH = '=== RESUMEN ===\nCambia a.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nEl contador muestra 2.\n=== PRUEBA MANUAL ===\n1. Abre el contador. Esperado: muestra 2.';
const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple el criterio; typecheck, test y build en verde.', findings: [], suggestedTests: [] });
const R = { plan: 'plan técnico', consult: 'necesita tu respuesta para seguir', cont: 'Antes no pudiste implementar la historia', repair: 'Tu entrega anterior para esta historia no se pudo convertir', qa: 'Evalúa la implementación con la EVIDENCIA real', dev: 'Implementa la historia' };
const MARKERS = ['Respuesta del propietario', 'Total 2', 'NOTAS-REPO', 'Respuesta de '];
type Rule = { match: string; text?: string; stopReason?: string; error?: string; delayMs?: number; failTimes?: number; refusal?: boolean };
/** Guion: lo específico va antes que la implementación (la primera regla que encaja responde). */
function script(dev: Partial<Rule>, over: Partial<Record<'consult' | 'cont' | 'repair' | 'qa', Partial<Rule>>> = {}) {
  const r: Rule[] = [
    { match: R.plan, text: PLAN },
    { match: R.consult, text: 'Las pruebas del contador están en el script de typecheck; a debe ser un número.', ...over.consult },
    { match: R.cont, text: PATCH, ...over.cont },
    { match: R.repair, text: PATCH, ...over.repair },
    { match: R.qa, text: QA_OK, ...over.qa },
    { match: R.dev, ...dev }
  ];
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: r, markers: MARKERS }));
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const count = (match: string) => calls().filter(c => c.rule === match).length;
const flowOf = async (id: string) => (await app.inject({ method: 'GET', url: `${W}/processes/${id}` })).json();
const waitFor = async <T>(fn: () => T | null | undefined | false, ms = 20_000): Promise<T> => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('tiempo de espera agotado en la prueba'); await new Promise(r => setTimeout(r, 25)); } };
const waitDone = (id: string) => waitFor(() => { const p = processesRepo(S).get(id)!; return p.status !== 'running' ? p : null; });
const doneCost = (id: string) => processesRepo(S).get(id)!.steps.filter(s => s.status === 'done').reduce((a, s) => a + s.costUsd, 0);

function newStory(title: string, cfg: Partial<typeof DEFAULT_PIPELINE> | null = {}, budget = 2) {
  const it = addManualItem(S, project.id, { title, criterion: 'a vale 2' });
  const p = createStoryProcess(S, project.id, it.id);
  if (cfg) processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, ...cfg })) });
  processesRepo(S).authorize(p.id, budget);
  return p.id;
}
async function run(title: string, cfg: Partial<typeof DEFAULT_PIPELINE> | null = {}, budget = 2) {
  const id = newStory(title, cfg, budget);
  await trackJob(id, runStory(S, id, () => undefined, () => isCancelled(id)));
  return processesRepo(S).get(id)!;
}

test('C/D · consulta: solo a miembros del equipo autorizado y nunca para lo que solo decide el propietario', () => {
  const all = agentsRepo(S).list();
  const dev = all.find(a => (a.config.capabilities ?? []).includes('implementar'))!;
  const qa = all.find(a => (a.config.capabilities ?? []).includes('revisar_calidad'))!;
  const ux = all.find(a => (a.config.capabilities ?? []).includes('consultar_ux'))!;
  const team = [dev, qa];
  const b = (question: string, consult: string | null = null) => ({ type: 'information' as const, need: question, question, consult, declared: true });
  assert.equal(pickConsultant(team, dev.id, b('¿Qué pruebas existen?', qa.config.name))?.id, qa.id, 'por indicación del agente');
  assert.equal(pickConsultant(team, dev.id, b('¿Qué cubre la verificación de calidad?'))?.id, qa.id, 'por la especialidad');
  assert.equal(pickConsultant(team, dev.id, b('¿Qué texto debe tener el botón?', ux.config.name)), null, 'UX no está en el equipo autorizado: no se amplía');
  assert.equal(pickConsultant([dev, qa, ux], dev.id, b('¿Qué texto debe tener el botón?'))?.id, ux.id);
  assert.equal(pickConsultant(team, dev.id, b('¿Qué hay en data/ del propietario?', qa.config.name)), null, 'datos del propietario: nadie del equipo puede responder');
  assert.equal(pickConsultant(team, dev.id, b('¿Cuál es el presupuesto del cliente final?', qa.config.name)), null);
  assert.equal(pickConsultant([dev], dev.id, b('¿Qué pruebas existen?')), null, 'nunca se consulta a sí mismo');
});

// ---------- Escenarios de proceso ----------
test('A · negativa real del proveedor: no se repara, no se reintenta; se explica y se pide una decisión', async () => {
  script({ text: 'I can’t help with that.', refusal: true });
  const p = await run('A · negativa');
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'stopped'); assert.equal(pl.pauseKind, 'provider_refusal'); assert.equal(pl.failureClass, 'PROVIDER_REFUSAL');
  assert.equal(count(R.repair), 0, 'ninguna reparación «a ciegas» (el fallo de HU-155)'); assert.equal(count(R.dev), 1); assert.equal(count(R.cont), 0);
  assert.ok(!pl.events.some(e => e.kind === 'repair'), 'la actividad no dice «Reparando la entrega»');
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.issue.kind, 'agent_refused');
  const ids = flow.actions.map((a: any) => a.id);
  assert.ok(!ids.includes('repair_output') && !ids.includes('pipeline_resume'), `sin acciones que repitan la petición: ${ids.join(', ')}`);
  assert.ok(ids.includes('new_iteration') && ids.includes('close_resolved'));
});

test('A2 · negativa del proveedor sin pipeline: el proceso falla con su clase y sin «Reparar con IA»', async () => {
  script({ text: 'I can’t help with that.', refusal: true });
  const p = await run('A2 · negativa sin pipeline', null);
  assert.equal(p.status, 'failed'); assert.equal(p.result!.failure!.class, 'PROVIDER_REFUSAL'); assert.equal(count(R.repair), 0);
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.issue.kind, 'agent_refused');
  assert.ok(!flow.actions.some((a: any) => a.id === 'repair_output' || a.id === 'pipeline_resume' || a.id === 'recover'));
});

test('B · una implementación que dice «no puedo garantizar…» se aplica y verifica sin reparación', async () => {
  script({ text: PATCH.replace('Cambia a.', 'No puedo garantizar el rendimiento en producción, pero el cambio es mínimo.') });
  const p = await run('B · sin falso positivo');
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? ''); assert.equal(count(R.repair), 0);
});

test('C · falta un archivo del repositorio: el equipo se lo entrega una vez, sin preguntar a nadie, y sigue', async () => {
  script({ text: 'No puedo completar la tarea sin ver el contenido de src/notes.ts.' });
  const p = await run('C · contexto del repositorio');
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? ''); assert.equal(pl.contextSupplies, 1); assert.equal(pl.consultations?.length ?? 0, 0);
  const cont = calls().filter(c => c.rule === R.cont);
  assert.equal(cont.length, 1); assert.ok(cont[0].markers.includes('NOTAS-REPO'), 'recibió el contenido del archivo pedido');
  assert.equal(count(R.consult), 0); assert.equal(count(R.repair), 0);
});

test('C2 · falta información técnica: consulta UNA vez a un especialista del equipo autorizado y sigue', async () => {
  const qa = agentsRepo(S).list().find(a => (a.config.capabilities ?? []).includes('revisar_calidad'))!;
  script({ text: `=== RESUMEN ===\nFalta un dato.\n=== BLOQUEO ===\ntipo: información\nnecesito: saber qué pruebas cubren el contador\npregunta: ¿Qué pruebas existen para src/a.ts?\nconsultar: ${qa.config.name}` });
  const p = await run('C2 · consulta al especialista');
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  assert.equal(pl.consultations?.length, 1); assert.equal(pl.consultations![0].agentName, qa.config.name);
  assert.ok(p.steps.some(s => s.role === 'consultant' && s.agentId === qa.id && s.status === 'done'), 'paso visible de la consulta');
  assert.equal(count(R.consult), 1); assert.equal(count(R.cont), 1); assert.ok(calls().find(c => c.rule === R.cont)!.markers.includes('Respuesta de '));
  assert.equal(count(R.repair), 0, 'falta de información no es un problema de formato');
});

test('C3 · lo que solo sabe el propietario: pausa con la pregunta; continuar exige respuesta y se entrega una vez', async () => {
  script({ text: '=== RESUMEN ===\nFalta un dato.\n=== BLOQUEO ===\ntipo: información\nnecesito: el texto exacto que quiere ver el cliente final\npregunta: ¿Qué texto exacto debe mostrar el contador al cliente final?\nconsultar: ninguno' });
  let p = await run('C3 · pregunta al propietario');
  let pl = p.result!.pipeline!;
  assert.equal(pl.state, 'paused'); assert.equal(pl.pauseKind, 'missing_information'); assert.equal(pl.failureClass, 'MISSING_INFORMATION');
  assert.equal(pl.ownerRequest?.question, '¿Qué texto exacto debe mostrar el contador al cliente final?'); assert.equal(pl.ownerRequest?.kind, 'information');
  assert.equal(count(R.consult), 0, 'nadie del equipo puede responder lo que decide el propietario'); assert.equal(count(R.repair), 0);
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.issue.kind, 'agent_blocked'); assert.equal(flow.issue.cause, 'decision');
  assert.equal(flow.actions[0].id, 'pipeline_resume'); assert.equal(flow.actions[0].answer.question, pl.ownerRequest!.question);
  const noAnswer = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/continue`, payload: { authorized: true, addBudgetUsd: 0.5 } });
  assert.equal(noAnswer.statusCode, 400); assert.equal(noAnswer.json().code, 'answer_required', 'sin respuesta no se gasta nada repitiendo la pregunta');
  assert.equal(calls().length, 2, 'plan + implementación: nada más');
  const ok = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/continue`, payload: { authorized: true, addBudgetUsd: 0.5, answer: 'Debe decir: Total 2' } });
  assert.equal(ok.statusCode, 200, ok.body);
  p = await waitDone(p.id); pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  const cont = calls().filter(c => c.rule === R.cont);
  assert.equal(cont.length, 1); assert.ok(cont[0].markers.includes('Respuesta del propietario') && cont[0].markers.includes('Total 2'), 'la respuesta llegó al agente que preguntó');
  assert.equal(pl.ownerAnswers?.length, 1); assert.equal(pl.ownerAnswers![0].delivered, true); assert.equal(pl.ownerRequest ?? null, null);
  assert.equal(count(R.plan), 1, 'continuar no repite el plan'); assert.equal(count(R.dev), 1);
});

test('D · permiso sobre data/ del propietario (caso HU-155): se detiene y lo explica; nunca se consulta ni se escala', async () => {
  script({ text: 'He revisado la historia y el código. No puedo implementar el cambio de forma segura: para comprobar el comportamiento necesito revisar la base de datos real, pero no tengo acceso a la carpeta data/ del propietario ni a sus credenciales.' });
  const p = await run('D · permiso');
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'paused'); assert.equal(pl.pauseKind, 'permission'); assert.equal(pl.failureClass, 'PERMISSION_REQUIRED');
  assert.equal(pl.ownerRequest?.kind, 'permission'); assert.match(pl.ownerRequest!.why, /Ningún agente puede acceder/);
  assert.equal(count(R.repair), 0, 'no se repara una explicación legítima'); assert.equal(count(R.consult), 0, 'no se pide a otro agente lo que nadie puede tener');
  assert.equal(pl.consultations?.length ?? 0, 0);
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.issue.kind, 'agent_blocked'); assert.match(flow.issue.title, /permiso/);
  assert.ok(!flow.actions.some((a: any) => a.id === 'repair_output'));
});

test('E · salida no válida: sigue reparándose (acotada), sin repetir el plan', async () => {
  script({ text: 'Hecho, he revisado la historia.' });
  const p = await run('E · formato');
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  assert.equal(count(R.repair), 1); assert.equal(count(R.plan), 1);
  assert.equal(p.result!.pipeline!.failureClass ?? null, null, 'resuelto');
});

test('F/K · plazo agotado en la reparación (como HU-155): se aborta al plazo, no se reintenta solo, costo no confirmado aparte; continuar repite solo esa llamada', async () => {
  script({ text: 'Hecho, he revisado la historia.' }, { repair: { delayMs: 8000 } });
  process.env.PORTAL_PROVIDER_TIMEOUT_SEC = '0.4';
  const t0 = Date.now();
  let p: any;
  try { p = await run('F · plazo'); } finally { delete process.env.PORTAL_PROVIDER_TIMEOUT_SEC; }
  assert.ok(Date.now() - t0 < 6000, 'la llamada se abortó al plazo (no esperó a la respuesta simulada de 8 s)');
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'paused'); assert.equal(pl.pauseKind, 'provider_timeout'); assert.equal(pl.failureClass, 'PROVIDER_TIMEOUT');
  assert.equal(p.result!.failure?.class, 'PROVIDER_TIMEOUT'); assert.equal(p.result!.failure?.providerCode, 'timeout');
  assert.equal(count(R.repair), 1, 'sin reintento automático: pudo facturarse');
  const failed = p.steps.find((s: any) => s.status === 'failed')!;
  assert.match(failed.error, /plazo/); assert.match(failed.error, /NO confirmado/);
  assert.ok(failed.unconfirmedUsd > 0 && p.unconfirmedUsd > 0, 'costo posible registrado como no confirmado');
  assert.ok(Math.abs(p.spentUsd - doneCost(p.id)) < 1e-9, 'el gasto confirmado es solo el de las llamadas completadas');
  assert.ok(p.steps.every((s: any) => s.live === null), 'ningún paso queda «en vivo» tras terminar');
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.issue.cause, 'environment'); assert.equal(flow.actions[0].label, 'Repetir la llamada y continuar');
  // Continuar: repite solo la reparación (el plan y la entrega original no se repiten ni se vuelven a cobrar).
  script({ text: 'Hecho, he revisado la historia.' });
  const before = { spent: p.spentUsd, unconfirmed: p.unconfirmedUsd, ids: new Set(p.steps.map((s: any) => s.id)) };
  const cont = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/continue`, payload: { authorized: true, addBudgetUsd: 0.5 } });
  assert.equal(cont.statusCode, 200, cont.body);
  p = await waitDone(p.id);
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  assert.equal(count(R.plan), 0); assert.equal(count(R.dev), 0); assert.equal(count(R.repair), 1); assert.equal(count(R.qa), 1);
  const added = p.steps.filter((s: any) => !before.ids.has(s.id));
  assert.ok(Math.abs(p.spentUsd - before.spent - added.reduce((a: number, s: any) => a + s.costUsd, 0)) < 1e-9, 'el gasto nuevo es solo el de los pasos nuevos');
  assert.equal(p.unconfirmedUsd, before.unconfirmed, 'lo no confirmado no se duplica ni se convierte en gasto');
});

test('F2 · plazo agotado en la primera implementación: sin pipeline falla con su clase; con pipeline (entrega incremental) se pausa y se retoma sin repetir el plan', async () => {
  script({ text: PATCH, delayMs: 8000 });
  process.env.PORTAL_PROVIDER_TIMEOUT_SEC = '0.3';
  let p: any; let q: any;
  try { p = await run('F2 · plazo en la implementación', null); q = await run('F2 · plazo en la unidad 1'); } finally { delete process.env.PORTAL_PROVIDER_TIMEOUT_SEC; }
  assert.equal(p.status, 'failed'); assert.equal(p.result!.failure?.class, 'PROVIDER_TIMEOUT');
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.issue.kind, 'provider_timeout'); assert.equal(flow.issue.cause, 'environment');
  // Con el manifiesto guardado, el plan no se pierde: pausa «el proveedor no respondió a tiempo» y «Repetir la llamada y continuar».
  assert.equal(q.status, 'done'); assert.equal(q.result!.pipeline!.state, 'paused'); assert.equal(q.result!.pipeline!.pauseKind, 'provider_timeout');
  assert.equal(q.result!.failure?.class, 'PROVIDER_TIMEOUT'); assert.equal(count(R.dev), 2, 'una llamada por proceso, sin reintento');
  const f2 = (await flowOf(q.id)).guidance.flow;
  assert.equal(f2.issue.cause, 'environment'); assert.ok(f2.actions.some((a: any) => a.id === 'pipeline_resume'));
  assert.equal(q.result!.manifest!.units[0].status, 'pending', 'la unidad interrumpida queda pendiente de retomar (sin entregables inventados)');
});

test('G/J · cancelar aborta la llamada en curso; mientras tanto el estado en vivo es real (no un latido local)', async () => {
  script({ text: PATCH, delayMs: 10_000 });
  const id = newStory('G · cancelar');
  const job = trackJob(id, runStory(S, id, () => undefined, () => isCancelled(id)));
  const dev = await waitFor(() => processesRepo(S).get(id)!.steps.find(s => s.role === 'implementer' && s.live?.state === 'waiting'));
  // J: en vivo, con hechos confirmados, plazo y costo estimado; no es huérfano.
  assert.equal(dev.status, 'running'); assert.match(dev.live!.lastEvent, /Solicitud enviada/);
  assert.ok(new Date(dev.live!.deadlineAt).getTime() > Date.now(), 'tiene un plazo futuro'); assert.ok(dev.live!.estimatedUsd > 0 && dev.live!.inputUsd > 0);
  const live = await flowOf(id);
  assert.notEqual(live.guidance.flow.issue?.kind, 'process_interrupted');
  assert.match(live.guidance.flow.stages.find((s: any) => s.key === 'execute').detail, /esperando la respuesta del proveedor/);
  assert.equal(inflightCount(id), 1);
  const t0 = Date.now();
  const res = await app.inject({ method: 'POST', url: `${W}/processes/${id}/cancel` });
  assert.equal(res.statusCode, 200); assert.equal(res.json().abortedCalls, 1, 'la llamada HTTP en curso se abortó');
  await job;
  assert.ok(Date.now() - t0 < 3000, 'se detuvo enseguida, no al terminar la respuesta (10 s)');
  const p = processesRepo(S).get(id)!;
  assert.equal(p.status, 'cancelled'); assert.equal(inflightCount(id), 0);
  const step = p.steps.find(s => s.role === 'implementer')!;
  assert.equal(step.status, 'failed'); assert.match(step.error ?? '', /cancelada/i); assert.equal(step.live, null);
  assert.ok((p.unconfirmedUsd ?? 0) > 0, 'lo que pudo facturarse queda como no confirmado'); assert.ok(Math.abs(p.spentUsd - doneCost(id)) < 1e-9);
  assert.equal(count(R.dev), 1); assert.equal(count(R.qa), 0, 'nada más se llamó tras cancelar');
});

test('H/J · reinicio con una llamada en curso: huérfano visible, se marca sin reenviar ni contabilizar dos veces; continuar repite solo esa llamada', async () => {
  script({ text: 'Hecho, he revisado la historia.' });
  const id = newStory('H · reinicio');
  const procs = processesRepo(S);
  // Estado que dejaría un servidor caído a mitad de la reparación (como HU-155): plan y entrega hechos, reparación en curso.
  const p0 = procs.get(id)!;
  const plan = p0.steps.find(s => s.role === 'planner')!; const dev = p0.steps.find(s => s.role === 'implementer')!;
  procs.stepStart(plan.id); procs.stepFinish(plan.id, 'done', { tokensIn: 1000, tokensOut: 200, cost: 0.01, outputMd: PLAN }); procs.addUsage(id, 1000, 200, 0.01);
  procs.stepStart(dev.id); procs.stepFinish(dev.id, 'done', { tokensIn: 3000, tokensOut: 50, cost: 0.02, outputMd: 'Hecho, he revisado la historia.' }); procs.addUsage(id, 3000, 50, 0.02);
  const pl = newPipeline(normalizePipeline(DEFAULT_PIPELINE));
  procs.setResult(id, { ...p0.result!, plan: JSON.parse(PLAN), pipeline: { ...pl, phase: 'repairing', events: [{ at: new Date().toISOString(), kind: 'repair', message: 'Corrigiendo la entrega del Desarrollador dentro del presupuesto autorizado.' }] } });
  const rep = procs.addStep(id, { agentId: dev.agentId, agentName: dev.agentName, title: 'Reparación de la entrega (intento 1)', model: dev.model ?? 'claude-sonnet-4-5', role: 'implementer' });
  procs.stepStart(rep.id);
  const at = new Date().toISOString();
  procs.setStepLive(rep.id, { state: 'waiting', provider: 'anthropic', model: dev.model, startedAt: at, lastEvent: 'Solicitud enviada; esperando la respuesta del proveedor', lastEventAt: at, deadlineAt: new Date(Date.now() + 600_000).toISOString(), timeoutMs: 600_000, attempt: 1, maxAttempts: 3, estimatedUsd: 0.2, inputTokensEstimated: 30_000, inputUsd: 0.09, maxOutputTokens: 12_000 });
  // J: «en ejecución» sin ejecución viva → se muestra como interrumpido, nunca como «esperando al proveedor».
  const orphan = (await flowOf(id)).guidance.flow;
  assert.equal(orphan.issue.kind, 'process_interrupted'); assert.equal(orphan.actions[0].id, 'cancel');
  const spent0 = procs.get(id)!.spentUsd;
  assert.equal(recoverInterruptedProcesses(() => undefined, { onlyOrphans: true }), 1);
  assert.equal(recoverInterruptedProcesses(() => undefined, { onlyOrphans: true }), 0, 'idempotente');
  let p = procs.get(id)!;
  assert.equal(p.status, 'done'); assert.equal(p.result!.pipeline!.state, 'paused'); assert.equal(p.result!.pipeline!.pauseKind, 'interrupted');
  const r1 = p.steps.find(s => s.id === rep.id)!;
  assert.equal(r1.status, 'failed'); assert.match(r1.error ?? '', /Interrumpido/); assert.equal(r1.live, null);
  assert.equal(p.unconfirmedUsd, 0.09, 'la entrada enviada, como no confirmada (una sola vez)'); assert.equal(p.spentUsd, spent0, 'el gasto confirmado no cambia');
  assert.equal(calls().length, 0, 'la recuperación no llama a la IA');
  const flow = (await flowOf(id)).guidance.flow;
  assert.equal(flow.issue.title, 'Interrumpido por un reinicio del Portal'); assert.equal(flow.actions[0].label, 'Repetir la llamada y continuar');
  const cont = await app.inject({ method: 'POST', url: `${W}/processes/${id}/continue`, payload: { authorized: true, addBudgetUsd: 0.5 } });
  assert.equal(cont.statusCode, 200, cont.body);
  p = await waitDone(id);
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  assert.equal(count(R.plan), 0); assert.equal(count(R.dev), 0); assert.equal(count(R.repair), 1, 'solo se repite la llamada interrumpida');
  assert.equal(p.steps.find(s => s.id === plan.id)!.costUsd, 0.01); assert.equal(p.steps.find(s => s.id === dev.id)!.costUsd, 0.02);
  assert.equal(p.unconfirmedUsd, 0.09);
});

test('H2 · reinicio antes de la entrega del Desarrollador: no hay nada que retomar; falla con explicación (sin «Continuar»)', async () => {
  script({ text: PATCH });
  const id = newStory('H2 · reinicio en el plan');
  const procs = processesRepo(S);
  const plan = procs.get(id)!.steps.find(s => s.role === 'planner')!;
  procs.stepStart(plan.id);
  procs.setStepLive(plan.id, { state: 'waiting', provider: 'anthropic', model: plan.model, startedAt: new Date().toISOString(), lastEvent: 'Solicitud enviada', lastEventAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 90_000).toISOString(), timeoutMs: 90_000, attempt: 1, maxAttempts: 3, estimatedUsd: 0.05, inputTokensEstimated: 5000, inputUsd: 0.015, maxOutputTokens: 2500 });
  assert.equal(recoverInterruptedProcesses(() => undefined, { onlyOrphans: true }), 1);
  const p = procs.get(id)!;
  assert.equal(p.status, 'failed'); assert.equal(p.result!.failure?.class, 'UNKNOWN_FAILURE'); assert.equal(p.unconfirmedUsd, 0.015);
  const flow = (await flowOf(id)).guidance.flow;
  assert.ok(!flow.actions.some((a: any) => a.id === 'pipeline_resume'), 'no se ofrece continuar algo que no existe');
  assert.ok(flow.actions.some((a: any) => a.id === 'retry_process'));
  assert.equal(calls().length, 0);
});

test('I · errores transitorios: reintentos acotados con espera; la llamada se cobra una vez; los no transitorios no se reintentan', async () => {
  script({ text: PATCH, failTimes: 2, error: 'network' });
  let p = await run('I · reintentos');
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  assert.equal(count(R.dev), 3, '2 fallos + 1 éxito'); assert.equal(p.result!.pipeline!.providerRetries, 2);
  const devSteps = p.steps.filter(s => s.role === 'implementer');
  assert.equal(devSteps.length, 1); assert.equal(devSteps[0].status, 'done');
  assert.ok(Math.abs(p.spentUsd - doneCost(p.id)) < 1e-9, 'solo la llamada que respondió se contabiliza');
  // Más fallos que reintentos permitidos (2): 3 intentos y se detiene con su clase.
  script({ text: PATCH, failTimes: 10, error: 'network' });
  p = await run('I2 · reintentos agotados');
  // Entrega incremental: el plan y el manifiesto están guardados, así que no se pierde nada: pausa reanudable con su clase.
  assert.equal(count(R.dev), 3, 'acotado: 1 + 2 reintentos'); assert.equal(p.result!.pipeline!.pauseKind, 'provider_error'); assert.equal(p.result!.failure?.class, 'PROVIDER_CONNECTION_ERROR');
  // Credencial rechazada: no se reintenta.
  script({ text: PATCH, error: 'invalid_key' });
  p = await run('I3 · credencial');
  assert.equal(count(R.dev), 1); assert.equal(p.result!.failure?.class, 'PERMISSION_REQUIRED');
  // Configurable por proceso: 0 reintentos.
  script({ text: PATCH, failTimes: 1, error: 'network' });
  p = await run('I4 · sin reintentos', { maxProviderRetries: 0 });
  assert.equal(count(R.dev), 1); assert.equal(p.result!.pipeline!.state, 'paused');
});

test('L · presupuesto: lo no confirmado se reserva; si la siguiente llamada no cabe, se pausa SIN llamar a la IA', async () => {
  script({ text: 'Hecho, he revisado la historia.' }, { repair: { delayMs: 8000 } });
  process.env.PORTAL_PROVIDER_TIMEOUT_SEC = '0.3';
  let p: any;
  try { p = await run('L · presupuesto'); } finally { delete process.env.PORTAL_PROVIDER_TIMEOUT_SEC; }
  assert.equal(p.result!.pipeline!.pauseKind, 'provider_timeout'); assert.ok(p.unconfirmedUsd > 0);
  // 3 USD libres bastarían para la reparación si se ignorara lo no confirmado; con 10 USD posibles sin confirmar, no.
  processesRepo(S).addUnconfirmed(p.id, null, 10);
  processesRepo(S).authorize(p.id, p.spentUsd + 3); processesRepo(S).finish(p.id, 'done');
  script({ text: 'Hecho, he revisado la historia.' });
  const cont = await app.inject({ method: 'POST', url: `${W}/processes/${p.id}/continue`, payload: { authorized: true, addBudgetUsd: 0 } });
  assert.equal(cont.statusCode, 200, cont.body);
  p = await waitDone(p.id);
  assert.equal(p.result!.pipeline!.pauseKind, 'budget', p.result!.pipeline!.reason ?? ''); assert.equal(calls().length, 0, 'ninguna llamada fuera del presupuesto');
  assert.match(p.result!.pipeline!.reason, /superaría el presupuesto autorizado/);
});

test('G2/K · cancelar una evaluación inicial también aborta la llamada en curso; lo posible queda como no confirmado', async () => {
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: '.', text: '## Resumen\nok', delayMs: 10_000 }] }));
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  const created = await app.inject({ method: 'POST', url: `${W}/projects/${project.id}/assessment` });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().id;
  const auth = await app.inject({ method: 'POST', url: `${W}/processes/${id}/authorize`, payload: { budgetUsd: 2, authorized: true } });
  assert.equal(auth.statusCode, 200, auth.body);
  await waitFor(() => inflightCount(id) === 1);
  const t0 = Date.now();
  const res = await app.inject({ method: 'POST', url: `${W}/processes/${id}/cancel` });
  assert.equal(res.json().abortedCalls, 1);
  const p = await waitDone(id);
  assert.ok(Date.now() - t0 < 3000, 'se detuvo enseguida');
  assert.equal(p.status, 'cancelled');
  assert.ok((p.unconfirmedUsd ?? 0) > 0); assert.equal(p.spentUsd, 0, 'nada confirmado: la única llamada se abortó');
  assert.equal(calls().length, 1, 'los pasos siguientes no se ejecutan');
});

test('O · lecciones: los fallos clasificados quedan como evidencia «detectada», nunca validada ni inyectada', async () => {
  const all = lessonsRepo(S).list(project.id);
  const byDetector = (d: string) => all.filter(l => l.detector === d);
  assert.ok(byDetector('provider_refusal').length >= 1, 'negativa del proveedor');
  assert.ok(byDetector('agent_blocked').length >= 2, 'bloqueos (información y permiso)');
  assert.ok(byDetector('provider_timeout').length >= 1, 'plazo agotado');
  assert.ok(byDetector('provider_unavailable').length >= 1, 'conexión agotada');
  assert.ok(byDetector('provider_credentials').length >= 1, 'credencial rechazada: del proveedor, no un bloqueo del agente');
  for (const l of [...byDetector('provider_refusal'), ...byDetector('agent_blocked'), ...byDetector('provider_timeout'), ...byDetector('provider_unavailable'), ...byDetector('provider_credentials')]) {
    assert.equal(l.status, 'detected'); assert.equal(l.validatedAt, null); assert.equal(l.lessonText, null, 'sin texto de lección: lo redacta y valida el propietario');
  }
  const perm = all.find(l => l.detector === 'agent_blocked' && /permiso/.test(l.title))!;
  assert.match(perm.evidence.detail, /PERMISSION_REQUIRED/); assert.match(perm.evidence.detail, /heurística/);
  // Deduplicación por proceso: volver a detectar no crea copias.
  const n = all.length; const { recordDetections } = await import('../src/services/lessons.ts');
  for (const l of all) if (l.evidence.processId) recordDetections(S, l.evidence.processId, repo);
  assert.equal(lessonsRepo(S).list(project.id).length, n);
});

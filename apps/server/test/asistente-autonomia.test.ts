import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Autonomía real del Asistente con gobernanza verificable (intervención a partir de HU-177 y de «no puedo modificar archivos»).
 *  - Configuración efectiva: Claude Code por la suscripción, Claude Opus 5.5 y esfuerzo «xhigh» DE VERDAD: desde lo
 *    guardado hasta la orden de la CLI (--model, --effort) y el registro de la ejecución; lo que el modelo o la CLI no
 *    admiten se rechaza o se dice (nunca se inventa compatibilidad).
 *  - «Haz esto»: el Asistente responde que SÍ puede, con los mecanismos del Portal; propone un encargo (sin historia),
 *    tú lo autorizas en la tarjeta (sin tu sesión, nada), el equipo lo ejecuta aislado, el resultado con evidencia vuelve
 *    a la conversación, lo integras y el Asistente comprueba main ejecutando las pruebas de verdad (run_checks).
 *  - Negativas: sin sesión, sin autorización, con el estado cambiado, rechazada, interrumpida por un reinicio.
 * CLI de Claude Code y proveedor SIMULADOS (0 USD, ninguna llamada real); «sandbox» simulado (rápido y determinista).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-auto-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const dataDir = process.env.PORTAL_DATA_DIR;
const scriptPath = path.join(dataDir, 'mock-script.json'); const logPath = path.join(dataDir, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-auto-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = () => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, effortLevelsFor, INTERNAL_WORKSPACE } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, backlogRepo, claudeCodeRunsRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts'); // con el propietario vinculado (todo cambio lo exige)
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { effortLevelsFromHelp, resetDetectionCache } = await import('../src/services/claudeCode/detect.ts');
const { buildArgs, cliEffort } = await import('../src/services/claudeCode/cli.ts');
const { setBridgeUrl } = await import('../src/services/claudeCode/backend.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { assistantRepo, recoverInterruptedOperations } = await import('../src/services/assistant.ts');
const { assignmentsRepo } = await import('../src/db/assignments.ts');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-5-5', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-opus-4-1', 'claude-sonnet-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = INTERNAL_WORKSPACE.slug; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const app = await buildApp();
after(async () => { await app.close(); });
await app.listen({ port: 0, host: '127.0.0.1' });
setBridgeUrl(`http://127.0.0.1:${(app.server.address() as any).port}`);
const inject = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any });
/** Una petición SIN la sesión del propietario (otro proceso del equipo que conoce la URL). */
const anon = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { host: '127.0.0.1:4310' } });

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-auto-repo-'));
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/saludo.mjs'), "export const saludo = () => 'Hola';\n");
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'auto', private: true, type: 'module', scripts: { typecheck: 'node -e 0', test: 'node -e 0', build: 'node -e 0' } }) + '\n');
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
projectsRepo(S).setRepository(project.id, repo, 'main');
const mainSha = () => execSync('git rev-parse main', { cwd: repo, encoding: 'utf8' }).trim();

// «Sandbox» simulado: typecheck/test/build en verde salvo que el código diga ROTO; se registra dónde se ejecutó.
const sandboxCalls: { wt: string; command: string }[] = [];
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (wt, _root, command) => {
  sandboxCalls.push({ wt, command }); const t = new Date().toISOString();
  const broken = fs.existsSync(path.join(wt, 'src/saludo.mjs')) && /ROTO/.test(fs.readFileSync(path.join(wt, 'src/saludo.mjs'), 'utf8'));
  return { command, exitCode: broken ? 1 : 0, output: broken ? `${command} falla` : `${command} ok\n# tests 1\n# pass 1`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' };
};

const asst = agentsRepo(S).list().find(a => a.key === 'ws-asistente')!;
saveClaudeCodeSettings({ ...getClaudeCodeSettings(), cliPath: FAKE, maxConcurrent: 1 }); resetDetectionCache();
scenario({ auth: 'subscription', defaultText: 'Respuesta.' });
assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true })).statusCode, 200);
assert.equal((await inject('PUT', `${W}/agents/${asst.id}/backend`, { backend: 'claude-code', authorized: true })).statusCode, 200);
saveClaudeCodeSettings({ ...getClaudeCodeSettings(), projects: { ...getClaudeCodeSettings().projects, [S]: [project.id] } });
const cfgOf = () => agentsRepo(S).get(asst.id)!.config;
const setCfg = (patch: Record<string, unknown>) => inject('PUT', `${W}/agents/${asst.id}/config`, { ...cfgOf(), ...patch });

// ---------- Esfuerzo: lo que el modelo y la CLI admiten de verdad ----------
test('esfuerzo · niveles por modelo (sin inventar compatibilidad) y los que anuncia la ayuda REAL de Claude Code 2.1.311', () => {
  assert.deepEqual(effortLevelsFor('anthropic', 'claude-opus-5-5'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortLevelsFor('anthropic', 'claude-opus-4-7'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortLevelsFor('anthropic', 'claude-opus-4-6'), ['low', 'medium', 'high', 'max'], 'xhigh llegó con Opus 4.7');
  assert.deepEqual(effortLevelsFor('anthropic', 'claude-sonnet-4-5'), ['low', 'medium', 'high']);
  assert.deepEqual(effortLevelsFor('openai', 'gpt-5'), ['low', 'medium', 'high']);
  // Fragmento literal de `claude --help` (2.1.311), comprobado en el equipo del propietario sin llamar al modelo.
  const help = '  --effort <level>                      Effort level for the current session\n                                        (low, medium, high, xhigh, max)\n  --environment <environment_id>        Create a new cloud session';
  assert.deepEqual(effortLevelsFromHelp(help), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortLevelsFromHelp('  --model <model>  Model for the current session'), [], 'una CLI sin --effort no lo admite');
  const det = { effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] };
  assert.equal(cliEffort(det, 'xhigh'), 'xhigh'); assert.equal(cliEffort({ effortLevels: [] }, 'xhigh'), null); assert.equal(cliEffort(det, 'turbo'), null);
  const args = (levels: string[]) => buildArgs({ detection: { capabilities: [], effortLevels: levels } as any, model: 'claude-opus-5-5', schema: null, maxTurns: 8, effort: 'xhigh' }, { system: 's.md', mcp: null }, []);
  const a = args(det.effortLevels); assert.equal(a[a.indexOf('--effort') + 1], 'xhigh'); assert.equal(a[a.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.ok(!args([]).includes('--effort'), 'sin soporte en la CLI no se pasa (usa su predeterminado y se dice)');
});

test('esfuerzo · el Asistente con Claude Code, Opus 5.5 y xhigh: se guarda solo lo admitido y la CLI recibe --model y --effort; queda en el registro de la ejecución', async () => {
  // Antes de que el propietario elija el nivel: la CLI usa su predeterminado (el Portal no cambia solo a ningún agente).
  scenario({ auth: 'subscription', defaultText: 'Hola.' });
  await inject('POST', '/api/assistant/messages', { text: 'Hola' });
  assert.ok(!ccRuns().at(-1).args.includes('--effort'), 'sin elegirlo, no se pasa');
  assert.match((await inject('GET', `${W}/agents/${asst.id}/claude-code`)).json().invocation.note, /aún no se aplica a Claude Code/);
  const bad = await setCfg({ model: 'claude-opus-4-6', effort: 'xhigh' });
  assert.equal(bad.statusCode, 400); assert.equal(bad.json().code, 'effort_unsupported'); assert.deepEqual(bad.json().levels, ['low', 'medium', 'high', 'max']);
  const ok = await setCfg({ model: 'claude-opus-5-5', effort: 'xhigh' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(cfgOf().effort, 'xhigh'); assert.equal(cfgOf().model, 'claude-opus-5-5'); assert.equal(cfgOf().backend, 'claude-code', 'el arnés no cambia al editar la configuración');
  scenario({ auth: 'subscription', defaultText: 'Hola.' });
  const r = await inject('POST', '/api/assistant/messages', { text: '¿Qué modelo usas?' });
  assert.equal(r.statusCode, 200, r.body);
  const run = ccRuns().at(-1); const arg = (n: string) => run.args[run.args.indexOf(n) + 1];
  assert.equal(arg('--model'), 'claude-opus-5-5'); assert.equal(arg('--effort'), 'xhigh');
  assert.equal(claudeCodeRunsRepo(S).byAgent(asst.id, 1)[0].effort, 'xhigh', 'el registro dice qué esfuerzo se pasó');
  const view = (await inject('GET', `${W}/agents/${asst.id}/claude-code`)).json();
  assert.equal(view.invocation.effortPassed, 'xhigh'); assert.match(view.invocation.note, /--model claude-opus-5-5 --effort xhigh/); assert.match(view.invocation.note, /tu suscripción/);
  // Una CLI que no anuncia --effort: no se pasa, y la vista lo dice (no se finge que se aplicó).
  scenario({ auth: 'subscription', defaultText: 'Hola.', effortLevels: null }); resetDetectionCache();
  await inject('POST', '/api/assistant/messages', { text: '¿Y ahora?' });
  assert.ok(!ccRuns().at(-1).args.includes('--effort'));
  assert.match((await inject('GET', `${W}/agents/${asst.id}/claude-code`)).json().invocation.note, /no anuncia «--effort xhigh»/);
  scenario({ auth: 'subscription', defaultText: 'Hola.' }); resetDetectionCache();
});

// ---------- Autonomía gobernada: «haz esto» ----------
test('el Asistente sabe que SÍ puede cambiar el código del Portal sin historia (con un encargo que prepara y supervisa) y cómo lo hace', async () => {
  scenario({ auth: 'subscription', defaultText: 'Sí: lo hago con un encargo.' });
  await inject('POST', '/api/assistant/messages', { text: '¿Eres capaz de realizar cambios en el código del Portal directamente, sin crear una historia dentro del Portal?' });
  const sys = ccRuns().at(-1).system as string;
  assert.match(sys, /la respuesta es SÍ: con un encargo que tú preparas y supervisas/);
  assert.match(sys, /Historias del backlog SOLO si él las pide/);
  assert.match(sys, /run_checks/, 'conoce la operación que ejecuta las pruebas de verdad');
  assert.doesNotMatch(sys, /Tú solo propones/, 'ya no se presenta como alguien que solo propone');
});

test('«haz esto» de punta a punta: encargo sin historia → tu autorización (sin sesión, nada) → ejecución aislada → resultado con evidencia en la conversación → integrar → run_checks comprueba main', async () => {
  const stories = backlogRepo(S).list(project.id).length;
  const actions = [{ type: 'propose_assignment', company: S, project: project.id, title: 'Saludo al propietario', request: 'Cambia el saludo a «Hola, propietario»', objective: 'saludo() devuelve «Hola, propietario»', criteria: ['saludo() devuelve exactamente «Hola, propietario»', 'Las pruebas pasan en el sandbox'], outOfScope: ['Otros textos'], size: 'S' }];
  scenario({ auth: 'subscription', rules: [{ match: 'Cambia el saludo', text: `Lo hago con un encargo: el equipo del proyecto cambia src/saludo.mjs en un worktree aislado y te traigo el diff verificado.\n\n\`\`\`actions\n${JSON.stringify(actions)}\n\`\`\`` }] });
  const conv = (await inject('POST', '/api/assistant/conversations', { title: 'Saludo' })).json();
  const r = (await inject('POST', '/api/assistant/messages', { text: 'Cambia el saludo a «Hola, propietario»', conversationId: conv.id })).json();
  const card = r.assistant.actions.find((a: any) => a.type === 'propose_assignment');
  assert.ok(card?.assignmentId, 'tarjeta del encargo'); assert.equal(card.status, 'pending');
  assert.equal(backlogRepo(S).list(project.id).length, stories, 'no se creó ninguna historia');
  const en = assignmentsRepo(S).get(card.assignmentId)!;
  assert.equal(en.status, 'draft', 'borrador: nada se ejecuta todavía'); assert.equal(en.conversationId, conv.id);
  // Negativas: sin la sesión del propietario, sin autorización explícita o sin presupuesto, no empieza nada.
  const auth = { authorized: true, budgetUsd: 2, maxSubscriptionCalls: 40, gauntlet: { mode: 'off' } };
  assert.equal((await anon('POST', `${W}/assignments/${en.id}/authorize`, auth)).statusCode, 401);
  assert.equal((await inject('POST', `${W}/assignments/${en.id}/authorize`, { ...auth, authorized: false })).statusCode, 400);
  assert.equal((await inject('POST', `${W}/assignments/${en.id}/authorize`, { authorized: true })).statusCode, 400);
  assert.equal(assignmentsRepo(S).get(en.id)!.status, 'draft');
  // Autorizado: el equipo responsable lo implementa en un worktree aislado (proveedor simulado).
  const PLAN = JSON.stringify({ summary: 'Cambiar el saludo.', tasks: ['Editar src/saludo.mjs'], filesToRead: ['src/saludo.mjs'], filesToChange: ['src/saludo.mjs'], deliverables: [{ path: 'src/saludo.mjs', purpose: 'saludo nuevo', kind: 'code', estimatedLines: 1 }], acceptance: en.criteria, risks: [] });
  const DEV = "=== RESUMEN ===\nSaludo cambiado.\n=== ARCHIVO: src/saludo.mjs | patch ===\n<<<< BUSCAR\nexport const saludo = () => 'Hola';\n==== REEMPLAZAR\nexport const saludo = () => 'Hola, propietario';\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nEl saludo dice «Hola, propietario».\n=== PRUEBA MANUAL ===\n1. Llama a saludo(). Esperado: «Hola, propietario».\n";
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: 'plan técnico', text: PLAN }, { match: 'Evalúa la implementación con la EVIDENCIA real', text: JSON.stringify({ verdict: 'approved', summary: 'Cumple con evidencia.', findings: [], suggestedTests: [] }) }, { match: 'Implementa la historia', text: DEV }] }));
  resetMockCalls();
  const a1 = await inject('POST', `${W}/assignments/${en.id}/authorize`, auth);
  assert.equal(a1.statusCode, 200, a1.body);
  const end = Date.now() + 60_000; let view: any;
  for (;;) { view = (await inject('GET', `${W}/assignments/${en.id}`)).json(); if (view.status !== 'running' && view.status !== 'pending_authorization') break; if (Date.now() > end) throw new Error('el encargo no terminó'); await new Promise(res => setTimeout(res, 50)); }
  assert.equal(view.status, 'ready_for_review', view.reason ?? '');
  assert.deepEqual(view.process.changes.map((c: any) => c.path), ['src/saludo.mjs']);
  assert.ok(view.process.checks.length === 3 && view.process.checks.every((c: any) => c.passed), 'typecheck, test y build en el sandbox');
  assert.ok(sandboxCalls.some(c => c.wt.includes(view.process.id)), 'se verificó en el worktree aislado del encargo');
  assert.equal(fs.readFileSync(path.join(repo, 'src/saludo.mjs'), 'utf8'), "export const saludo = () => 'Hola';\n", 'tu carpeta y main no cambian hasta integrar');
  // El resultado vuelve a la conversación (sin IA: solo lo que el proceso registró) con el siguiente paso.
  const msgs = (await inject('GET', `/api/assistant?conversationId=${conv.id}`)).json().messages;
  const report = msgs.filter((m: any) => m.role === 'assistant').at(-1);
  assert.match(report.content, new RegExp(`${en.code} · Saludo al propietario: terminado y verificado`));
  assert.match(report.content, /src\/saludo\.mjs/); assert.match(report.content, /typecheck ✓ · test ✓ · build ✓/); assert.match(report.content, /Integrar en main/);
  assert.equal(report.costUsd, 0); assert.equal(report.model, null);
  // Integrar (sin sesión no) y comprobar main ejecutando las pruebas de verdad.
  assert.equal((await anon('POST', `${W}/processes/${view.process.id}/merge`, { authorized: true })).statusCode, 401);
  const m = await inject('POST', `${W}/processes/${view.process.id}/merge`, { authorized: true });
  assert.equal(m.statusCode, 200, m.body);
  assert.match(fs.readFileSync(path.join(repo, 'src/saludo.mjs'), 'utf8'), /Hola, propietario/);
  assert.equal((await inject('GET', `${W}/assignments/${en.id}`)).json().process.merged.into, 'main');
  scenario({ auth: 'subscription', rules: [{ match: 'comprueba main', text: `Ejecuto las pruebas sobre main.\n\n\`\`\`actions\n${JSON.stringify([{ type: 'request_operation', capability: 'run_checks', company: S, project: project.id }])}\n\`\`\`` }] });
  const rc = (await inject('POST', '/api/assistant/messages', { text: 'Ahora comprueba main', conversationId: conv.id })).json();
  const op = rc.assistant.actions.find((a: any) => a.operation?.capability === 'run_checks');
  assert.equal(op.status, 'pending'); assert.equal(op.operation.preview.fingerprint, mainSha());
  const before = sandboxCalls.length;
  assert.equal((await anon('POST', `/api/assistant/messages/${rc.assistant.id}/operations/${op.operation.id}/approve`, { authorized: true })).statusCode, 401, 'sin tu sesión no se ejecuta');
  assert.equal((await inject('POST', `/api/assistant/messages/${rc.assistant.id}/operations/${op.operation.id}/approve`, {})).statusCode, 403, 'sin autorización explícita tampoco');
  assert.equal(sandboxCalls.length, before);
  const go = await inject('POST', `/api/assistant/messages/${rc.assistant.id}/operations/${op.operation.id}/approve`, { authorized: true });
  assert.equal(go.statusCode, 200); assert.equal(go.json().message.actions.find((a: any) => a.operation?.id === op.operation.id).status, 'running', 'se lanza y la tarjeta muestra el resultado al terminar');
  const until = Date.now() + 30_000; let fin: any;
  for (;;) { fin = assistantRepo.get(rc.assistant.id)!.actions.find(a => a.operation?.id === op.operation.id)!; if (fin.status !== 'running') break; if (Date.now() > until) throw new Error('run_checks no terminó'); await new Promise(res => setTimeout(res, 25)); }
  assert.equal(fin.status, 'done', fin.detail); assert.match(fin.detail, new RegExp(`typecheck ✓ · test ✓ · build ✓ sobre ${mainSha().slice(0, 7)}`));
  assert.ok(sandboxCalls.slice(before).every(c => /\/\.linea-base\//.test(c.wt.replace(/\\/g, '/'))), 'en un worktree temporal y desechable, no en tu carpeta');
  assert.doesNotMatch(execSync('git worktree list', { cwd: repo, encoding: 'utf8' }), /\.linea-base/, 'retirado al terminar');
});

test('run_checks · rechazar no ejecuta nada; con main cambiado desde la tarjeta no se ejecuta; una ejecución cortada por un reinicio queda «no terminada»', async () => {
  scenario({ auth: 'subscription', rules: [{ match: 'pruebas', text: `Preparo la ejecución.\n\n\`\`\`actions\n${JSON.stringify([{ type: 'request_operation', capability: 'run_checks', company: S, project: project.id, commands: ['test'] }])}\n\`\`\`` }] });
  const ask = async () => { const x = (await inject('POST', '/api/assistant/messages', { text: 'Ejecuta las pruebas' })).json(); return { mid: x.assistant.id as string, op: x.assistant.actions.find((a: any) => a.operation?.capability === 'run_checks') }; };
  const n0 = sandboxCalls.length;
  const a = await ask();
  assert.equal((await inject('POST', `/api/assistant/messages/${a.mid}/operations/${a.op.operation.id}/reject`, {})).statusCode, 200);
  assert.equal(sandboxCalls.length, n0, 'rechazada: nada se ejecutó');
  const b = await ask();
  fs.writeFileSync(path.join(repo, 'NOTAS.md'), 'otro commit\n'); execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm Otro', { cwd: repo });
  const stale = await inject('POST', `/api/assistant/messages/${b.mid}/operations/${b.op.operation.id}/approve`, { authorized: true });
  assert.equal(stale.statusCode, 409); assert.match(stale.json().error, /el estado cambió/);
  assert.equal(sandboxCalls.length, n0, 'con main cambiado no se ejecuta lo que no viste');
  // Reinicio a mitad: la tarjeta «en marcha» que ya no corre se cierra con la verdad (no terminó), nunca como hecha.
  const c = await ask();
  assistantRepo.updateActions(c.mid, assistantRepo.get(c.mid)!.actions.map(x => x.operation?.id === c.op.operation.id ? { ...x, status: 'running' as const } : x));
  assert.equal(recoverInterruptedOperations(), 1);
  const after = assistantRepo.get(c.mid)!.actions.find(x => x.operation?.id === c.op.operation.id)!;
  assert.equal(after.status, 'failed'); assert.match(after.detail ?? '', /Interrumpida por un reinicio/);
});

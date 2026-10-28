import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Entrega INCREMENTAL de historias (corrección de HU-155): plan → manifiesto de entregables → unidades acotadas que se
 * aplican y se conservan → continuación por archivo cortado → comprobación determinista previa a QA → QA con evidencia →
 * correcciones dirigidas. Proveedor SIMULADO (0 USD), datos y repositorio sintéticos; R usa el sandbox Docker real.
 * Escenarios A–T del encargo (S, la e2e de automejora, y la parte de navegador de T se ejecutan aparte).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-inc-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
delete process.env.PORTAL_SANDBOX;
process.env.PORTAL_MOCK_PROVIDER = '1';
const dataDir = process.env.PORTAL_DATA_DIR;
const scriptPath = path.join(dataDir, 'mock-script.json'); const logPath = path.join(dataDir, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { newPipeline } = await import('../src/services/storyPipeline.ts');
const { kindOf, syntaxProblem, testDiscovered, UNIT_TEXT_BUDGET } = await import('../src/services/storyUnits.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { depsVolumeName, dockerCliEnv, SANDBOX_IMAGE } = await import('../src/services/sandbox.ts');
const { lessonsRepo } = await import('../src/services/lessons.ts');
const { recoverInterruptedProcesses } = await import('../src/services/interruptions.ts');
const { anthropicAdapter, anthropicThinking, estimatePricing, resetMockCalls } = await import('@portal-ia/ai-adapters');
const { trackJob } = await import('../src/services/activeJobs.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];

// ---------- Repositorio sintético (JavaScript sin dependencias: corre igual en el sandbox Docker real) ----------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-inc-repo-'));
const uniq = `inc-${Date.now().toString(36)}`;
const put = (p: string, c: string) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), c); };
put('src/index.mjs', 'export const version = 1;\n');
put('src/legacy.mjs', 'export const old = true;\n');
put('test/smoke.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('humo', () => assert.equal(1, 1));\n");
put('scripts/tc.mjs', "import { execFileSync } from 'node:child_process';\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst files = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.mjs')) files.push(p); } };\nfor (const d of ['src', 'test', 'tests']) if (fs.existsSync(d)) walk(d);\nlet bad = 0;\nfor (const f of files) { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.log(`${f.split(path.sep).join('/')}(1,1): error TS1005: sintaxis no válida`); } }\nconsole.log(bad ? `${bad} error(es)` : `${files.length} archivos sin errores`);\nprocess.exit(bad ? 2 : 0);\n");
put('scripts/build.mjs', "import fs from 'node:fs';\nfor (const f of ['contract.mjs', 'service.mjs']) if (fs.existsSync('src/' + f)) await import('../src/' + f);\nconsole.log('build ok');\n");
put('docs/incident.md', '# Incidente\n\nResumen pendiente.\n');
put('package.json', JSON.stringify({ name: uniq, version: '1.0.0', private: true, type: 'module', scripts: { typecheck: 'node scripts/tc.mjs', test: 'node --test test/*.test.mjs', build: 'node scripts/build.mjs' } }, null, 2) + '\n');
put('package-lock.json', JSON.stringify({ name: uniq, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.0' } } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
const repoHead = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();

// ---------- Contenido de los entregables y respuestas simuladas ----------
const C = {
  contract: "// MARCA_CONTRATO\nexport const CHECKS = ['datos', 'gasto', 'lecciones'];\nexport function contract() { return { version: 1, checks: CHECKS }; }\n",
  service: "// MARCA_SERVICIO\nimport { CHECKS } from './contract.mjs';\nexport function validate(input) {\n  const missing = CHECKS.filter(c => !(c in input));\n  return { ok: missing.length === 0, missing };\n}\n",
  cli: "// MARCA_CLI\nimport { validate } from './service.mjs';\nexport function main(argv) { const r = validate(JSON.parse(argv[0] ?? '{}')); console.log(JSON.stringify(r)); return r.ok ? 0 : 1; }\n",
  test: "// MARCA_PRUEBA\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { validate } from '../src/service.mjs';\ntest('valida las tres áreas', () => {\n  assert.equal(validate({ datos: 1, gasto: 1, lecciones: 1 }).ok, true);\n  assert.deepEqual(validate({}).missing, ['datos', 'gasto', 'lecciones']);\n});\n",
  doc: '# Contrato del validador\n\nMARCA_DOCS: el servicio está en src/service.mjs:3.\n',
  guide: '# Guía de QA\n\nMARCA_GUIA: ejecuta npm test.\n'
};
const OWNER = '=== PARA EL PROPIETARIO ===\nEl validador comprueba datos, gasto y lecciones.\n=== PRUEBA MANUAL ===\n1. Ejecuta npm run validate. Esperado: informe en JSON.\n';
const F = (p: string, c: string) => `=== ARCHIVO: ${p} | create ===\n${c}=== FIN ARCHIVO ===\n`;
const P = (p: string, s: string, r: string) => `=== ARCHIVO: ${p} | patch ===\n<<<< BUSCAR\n${s}\n==== REEMPLAZAR\n${r}\n>>>> FIN\n=== FIN ARCHIVO ===\n`;
const resp = (...blocks: string[]) => `=== RESUMEN ===\nEntrega de la unidad.\n${blocks.join('')}${OWNER}`;
const PKG = P('package.json', '"build": "node scripts/build.mjs"', '"build": "node scripts/build.mjs",\n    "validate": "node src/cli.mjs"');
const INCIDENT = P('docs/incident.md', 'Resumen pendiente.', 'Resumen: el validador cubre datos, gasto y lecciones (MARCA_INCIDENTE).');
type Del = [string, 'code' | 'test' | 'docs' | 'config', number];
const EIGHT: Del[] = [['src/contract.mjs', 'code', 30], ['src/service.mjs', 'code', 120], ['src/cli.mjs', 'code', 30], ['package.json', 'config', 5], ['test/service.test.mjs', 'test', 40], ['docs/contract.md', 'docs', 40], ['docs/qa-guide.md', 'docs', 40], ['docs/incident.md', 'docs', 5]];
const planOf = (dels: Del[]) => JSON.stringify({ summary: 'Validador de contratos con servicio, CLI, pruebas y documentación', tasks: dels.map(d => `Entregar ${d[0]}`), filesToRead: ['src/index.mjs', 'package.json'], filesToChange: dels.map(d => d[0]), deliverables: dels.map(d => ({ path: d[0], purpose: `Entregable ${d[0]}`, kind: d[1], estimatedLines: d[2] })), acceptance: ['El validador comprueba datos, gasto y lecciones', 'Tiene CLI, pruebas y documentación'], risks: [] });
const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple el criterio con evidencia: todo entregado y probado.', findings: [], suggestedTests: [] });
const qaReject = (findings: { text: string; file: string; expected?: string }[]) => JSON.stringify({ verdict: 'rejected', summary: 'Faltan requisitos del criterio.', findings: findings.map(f => ({ severity: 'alta', text: f.text, file: f.file, evidence: 'revisión del diff', requirement: 'criterio 1', expected: f.expected ?? 'corregirlo', verify: 'QA lo comprueba' })), suggestedTests: [] });
const MARKERS = ['MARCA_SERVICIO', 'MARCA_CONTRATO', 'MARCA_CLI', 'MARCA_PRUEBA', 'MARCA_DOCS', 'MARCA_GUIA', 'MARCA_ARQUITECTO', 'MARCA_CONSEJO', '- crear src/contract.mjs', '- crear src/service.mjs', '- crear src/cli.mjs', '- crear test/service.test.mjs', 'Faltan src/service.mjs', 'Entregables del plan', 'Que compile no basta', 'test: OK', 'HALLAZGO_SERVICIO_1', 'HALLAZGO_SERVICIO_2', 'HALLAZGO_CLI', '[entregado] src/cli.mjs', 'Comprobación determinista previa', 'Criterio de', 'MARCA_HELPER', 'MARCA_DISPUTA'];
type Rule = { match: string; text?: string; stopReason?: string; delayMs?: number; responses?: { text: string; stopReason?: string; thinkingTokens?: number }[]; thinkingTokens?: number };
const R = { plan: 'plan técnico', consult: 'aporta recomendaciones concretas', repair: 'Tu entrega anterior para esta historia no se pudo convertir', fix: 'Corrige la implementación de esta historia', advice: 'necesita tu criterio para corregir esto', qa: 'Evalúa la implementación con la EVIDENCIA real', cont: 'Continúa el archivo', dev: 'Implementa la historia' };
/** Las reglas específicas van antes (la primera que encaja responde): continuación, reparación, corrección, consulta, QA, unidades. */
function setRules(plan: string, rules: Rule[], qa: Rule | null = { match: R.qa, text: QA_OK }) {
  const all: Rule[] = [{ match: R.plan, text: plan }, { match: R.consult, text: 'MARCA_ARQUITECTO: separa contrato, servicio y CLI; prueba el servicio con node:test.' }, { match: R.advice, text: 'MARCA_CONSEJO: copia el fragmento EXACTO de la función validate.' }, ...rules.filter(r => r.match !== R.dev), ...(qa ? [qa] : []), ...rules.filter(r => r.match === R.dev)];
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: all, markers: MARKERS }));
  resetMockCalls(); // las respuestas sucesivas («responses») cuentan desde cero en cada escenario
  try { fs.unlinkSync(logPath); } catch { /* vacío */ }
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const byRule = (match: string) => calls().filter(c => c.rule === match);

/** Sandbox determinista (sustituto de pruebas): todo en verde salvo lo que la prueba decida. */
let sandboxFail: ((wt: string, command: string) => { exitCode: number; output: string } | null) | null = null;
const real = { ...sandboxDeps };
function useFakeSandbox() {
  sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
  sandboxDeps.run = async (wt, _root, command) => {
    const t = new Date().toISOString(); const f = sandboxFail?.(wt, command);
    return { command, exitCode: f?.exitCode ?? 0, output: f?.output ?? (command === 'test' ? '# tests 2\n# pass 2\n# fail 0' : `${command} ok`), startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' };
  };
}
useFakeSandbox();

const CRITERION = 'El validador comprueba datos, gasto y lecciones; tiene CLI, pruebas y documentación con referencias archivo:línea.';
function newRun(title: string, cfg: Partial<typeof DEFAULT_PIPELINE> = {}, budget = 5) {
  const it = addManualItem(S, project.id, { title, criterion: CRITERION });
  const p = createStoryProcess(S, project.id, it.id);
  processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE, ...cfg })) });
  processesRepo(S).authorize(p.id, budget);
  return p.id;
}
async function runIt(title: string, cfg: Partial<typeof DEFAULT_PIPELINE> = {}, budget = 5, log: (o: any, m: string) => void = () => undefined) {
  const id = newRun(title, cfg, budget); lastId = id;
  await runStory(S, id, log, () => false);
  return processesRepo(S).get(id)!;
}
const flowOf = async (id: string) => (await app.inject({ method: 'GET', url: `${W}/processes/${id}` })).json();
const waitFor = async <T>(fn: () => T | null | undefined | false, ms = 60_000): Promise<T> => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('tiempo de espera agotado en la prueba'); await new Promise(r => setTimeout(r, 25)); } };
const waitDone = (id: string) => waitFor(() => { const p = processesRepo(S).get(id)!; return p.status !== 'running' ? p : null; });
const wtFile = (p: any, f: string) => fs.readFileSync(path.join(p.result!.applied!.worktree!, f), 'utf8').replace(/\r\n/g, '\n');
/** M: cada llamada pagada tiene su paso y el gasto confirmado es exactamente la suma de los pasos. */
function assertAccounting(p: any, label: string) {
  const sum = p.steps.reduce((a: number, s: any) => a + s.costUsd, 0);
  assert.ok(Math.abs(p.spentUsd - sum) < 1e-9, `${label}: gasto confirmado (${p.spentUsd}) = suma de pasos (${sum})`);
  assert.equal(calls().length, p.steps.filter((s: any) => s.inputTokens > 0).length, `${label}: una llamada simulada por paso con uso`);
  assert.ok(p.spentUsd <= p.budgetUsd + 1e-9, `${label}: nunca se supera el presupuesto`);
}

// ---------- Unidades (sin IA) ----------
test('adaptador: Opus 5.5 usa razonamiento adaptativo con el esfuerzo del agente y reserva salida para él; modelos antiguos, presupuesto fijo; precios por modelo', async () => {
  assert.equal(anthropicThinking('claude-opus-5-5'), 'adaptive'); assert.equal(anthropicThinking('claude-sonnet-4-6'), 'adaptive'); assert.equal(anthropicThinking('claude-opus-4-5-20251101'), 'budget'); assert.equal(anthropicThinking('claude-sonnet-4-5'), 'budget');
  const sent: any[] = []; const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hola' }], usage: { input_tokens: 10, output_tokens: 900 }, stop_reason: 'end_turn' }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as any;
  const prevMock = process.env.PORTAL_MOCK_PROVIDER; delete process.env.PORTAL_MOCK_PROVIDER;
  try {
    const r = await anthropicAdapter.complete('k', undefined, { model: 'claude-opus-5-5', system: 's', user: 'u', maxTokens: 6000, effort: 'medium', supportsEffort: true, responseSchema: { name: 'x', schema: { type: 'object' } } });
    assert.deepEqual(sent[0].thinking, { type: 'adaptive' }, 'sin budget_tokens (retirado en Opus 5.5)'); assert.deepEqual(sent[0].output_config, { effort: 'medium' }, 'el esfuerzo del agente se envía');
    assert.equal(sent[0].max_tokens, 6000 + 12000, 'el texto pedido + margen explícito para el razonamiento oculto'); assert.equal(sent[0].tools, undefined, 'sin herramienta forzada');
    assert.equal(r.text, 'hola'); assert.equal(r.outputTokens, 900, 'el razonamiento oculto se cobra: cuenta en la salida');
    await anthropicAdapter.complete('k', undefined, { model: 'claude-sonnet-4-5', system: 's', user: 'u', maxTokens: 100, effort: 'medium', supportsEffort: true });
    assert.deepEqual(sent[1].thinking, { type: 'enabled', budget_tokens: 3000 }); assert.equal(sent[1].max_tokens, 3100); assert.equal(sent[1].output_config, undefined);
  } finally { globalThis.fetch = orig; process.env.PORTAL_MOCK_PROVIDER = prevMock; }
  assert.deepEqual([estimatePricing('anthropic', 'claude-opus-5-5').inPerM, estimatePricing('anthropic', 'claude-opus-5-5').outPerM], [4, 20], 'Opus 5.5: tarifa pública (antes 15/75: gasto mostrado ×3,75)');
  assert.deepEqual([estimatePricing('anthropic', 'claude-opus-4-1').inPerM, estimatePricing('anthropic', 'claude-opus-4-5-20251101').outPerM, estimatePricing('anthropic', 'claude-sonnet-5-5').outPerM], [15, 25, 10]);
});

test('artefactos: tipo de entregable y validación sintáctica de lo reconstruido', () => {
  assert.deepEqual(['src/a.ts', 'apps/server/test/x.test.ts', 'docs/a.md', 'package.json'].map(kindOf), ['code', 'test', 'docs', 'config']);
  assert.equal(syntaxProblem('a.mjs', 'export const a = 1;\n'), null);
  assert.match(syntaxProblem('a.mjs', 'export function f( {\n')!, /sintaxis no válida/);
  assert.match(syntaxProblem('package.json', '{"a": }')!, /JSON no válido/);
});

// ---------- A–T ----------
test('A · historia de un archivo: una unidad, aplicada, verificada y aprobada por QA (plan + unidad + QA)', async () => {
  setRules(planOf([['src/contract.mjs', 'code', 30]]), [{ match: R.dev, text: resp(F('src/contract.mjs', C.contract)) }]);
  const p = await runIt('A · contrato simple');
  const pl = p.result!.pipeline!; const man = p.result!.manifest!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  assert.equal(man.units.length, 1); assert.equal(man.units[0].status, 'done');
  assert.equal(man.deliverables[0].status, 'delivered'); assert.ok(man.deliverables[0].commit, 'evidencia: commit del worktree');
  assert.equal(byRule(R.dev).length, 1); assert.equal(byRule(R.qa).length, 1);
  assert.equal(byRule(R.repair).length + byRule(R.fix).length + byRule(R.cont).length, 0);
  assert.equal(p.steps.filter(s => s.role === 'implementer').length, 1, 'el paso «Implementación» planificado es la unidad (sin pasos huérfanos)');
  assert.equal(wtFile(p, 'src/contract.mjs'), C.contract);
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.equal(flow.headline, 'Implementación verificada por QA — lista para revisión del propietario.');
  assert.deepEqual(flow.delivery.levels, { compiles: true, complete: true, qaApproved: true });
  assertAccounting(p, 'A');
});

let pB = ''; let lastId = '';
const p0Id = () => lastId;
test('B/F · ocho archivos: unidades acotadas en orden de dependencia; cada unidad recibe SOLO lo suyo y lo pendiente; todo entregado con evidencia', async () => {
  setRules(planOf(EIGHT), [
    { match: 'Esta es la unidad 1 de 4', text: resp(F('src/contract.mjs', C.contract), F('src/service.mjs', C.service), F('src/cli.mjs', C.cli)) },
    { match: 'Esta es la unidad 2 de 4', text: resp(PKG) },
    { match: 'Esta es la unidad 3 de 4', text: resp(F('test/service.test.mjs', C.test)) },
    { match: 'Esta es la unidad 4 de 4', text: resp(F('docs/contract.md', C.doc), F('docs/qa-guide.md', C.guide), INCIDENT) }
  ]);
  const p = await runIt('B · validador con contratos y arquitectura de módulos');
  pB = p.id;
  const pl = p.result!.pipeline!; const man = p.result!.manifest!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  assert.deepEqual(man.units.map(u => u.files.length), [3, 1, 1, 3], 'código · configuración · pruebas · documentación');
  for (const u of man.units) assert.ok(u.estimatedOutputTokens <= UNIT_TEXT_BUDGET + 400, `${u.title}: cabe en una respuesta`);
  assert.equal(man.deliverables.filter(d => d.planned && d.status === 'delivered').length, 8, '8 de 8 entregados');
  assert.ok(man.deliverables.every(d => d.commit), 'cada entregable con su commit como evidencia');
  assert.deepEqual(p.result!.changes.map(c => c.path).sort(), EIGHT.map(d => d[0]).sort(), 'el diff real contiene los 8');
  const u = (n: number) => byRule(`Esta es la unidad ${n} de 4`)[0];
  assert.ok(u(1).markers.includes('- crear src/service.mjs'));
  assert.ok(!u(3).markers.includes('- crear src/service.mjs') && u(3).markers.includes('- crear test/service.test.mjs'), 'la unidad de pruebas no vuelve a pedir el código');
  assert.ok(u(3).markers.includes('MARCA_SERVICIO'), 'las pruebas reciben el código real que prueban');
  assert.ok(!u(2).markers.includes('MARCA_SERVICIO'), 'configuración: sin contenido que no necesita (contexto selectivo)');
  assert.ok(u(4).markers.includes('MARCA_SERVICIO') && !u(4).markers.includes('- crear src/cli.mjs'), 'la documentación recibe el código (para citar archivo:línea), no lo vuelve a pedir');
  assert.ok(u(1).markers.includes('MARCA_ARQUITECTO'), 'la aportación del Arquitecto llega a las unidades');
  assert.ok(Math.max(...[1, 2, 3, 4].map(n => u(n).chars)) < 60_000, 'ningún prompt de unidad arrastra el repositorio entero');
  const qa = byRule(R.qa)[0]; assert.ok(qa.markers.includes('Entregables del plan') && qa.markers.includes('[entregado] src/cli.mjs') && qa.markers.includes('Que compile no basta'), 'QA recibe el manifiesto real');
  assert.ok(pl.events.findIndex(e => e.kind === 'gate') < pl.events.findIndex(e => e.kind === 'qa'), 'la comprobación determinista va antes de QA');
  assert.equal(wtFile(p, 'docs/incident.md'), '# Incidente\n\nResumen: el validador cubre datos, gasto y lecciones (MARCA_INCIDENTE).\n');
  assertAccounting(p, 'B');
});

test('C · un archivo más grande que una respuesta: unidad propia y continuaciones del MISMO archivo hasta cerrarlo; unión sin solapes y sintaxis válida', async () => {
  const lines = Array.from({ length: 120 }, (_, i) => `export function f${i + 1}() { return ${i + 1}; }`);
  const full = lines.join('\n') + '\n';
  const part1 = `=== RESUMEN ===\nServicio grande.\n=== ARCHIVO: src/service.mjs | create ===\n${lines.slice(0, 50).join('\n')}\nexport function f51() { ret`;
  const c1 = `${lines.slice(50, 100).join('\n')}\nexport function f101() {`;
  const c2 = `${lines.slice(100).join('\n')}\n=== FIN ARCHIVO ===\n`;
  setRules(planOf([['src/contract.mjs', 'code', 30], ['src/service.mjs', 'code', 700], ['test/service.test.mjs', 'test', 40]]), [
    { match: 'Continúa el archivo «src/service\\.mjs»', responses: [{ text: c1, stopReason: 'max_tokens' }, { text: c2 }] },
    { match: 'Esta es la unidad 1 de 3', text: resp(F('src/contract.mjs', C.contract)) },
    { match: 'Esta es la unidad 2 de 3', text: part1, stopReason: 'max_tokens' },
    { match: 'Esta es la unidad 3 de 3', text: resp(F('test/service.test.mjs', C.test)) }
  ]);
  const p = await runIt('C · servicio grande');
  const pl = p.result!.pipeline!; const man = p.result!.manifest!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  const big = man.units.find(x => x.files.includes('src/service.mjs'))!;
  assert.deepEqual(big.files, ['src/service.mjs'], 'el archivo grande va solo en su unidad');
  assert.ok(big.estimatedOutputTokens > UNIT_TEXT_BUDGET, 'el motor sabía que no cabía en una respuesta');
  assert.equal(big.continued?.['src/service.mjs'], 2); assert.equal(pl.continuations, 2);
  assert.equal(byRule('Esta es la unidad 2 de 3').length, 1, 'la unidad no se vuelve a pedir entera');
  assert.equal(pl.corrections, 0); assert.equal(pl.outputRepairs, 0, 'cortes ≠ formato ≠ corrección');
  assert.equal(wtFile(p, 'src/service.mjs'), full, 'contenido exacto: líneas cortadas reescritas enteras, sin duplicar');
  assert.equal(syntaxProblem('src/service.mjs', full), null);
  assertAccounting(p, 'C');
});

test('D · corte a mitad de un archivo en una unidad de varios: lo completo se aplica ya; una reconstrucción inválida NO se aplica y solo ese archivo se vuelve a pedir', async () => {
  const cut = `=== RESUMEN ===\nDos.\n${F('src/contract.mjs', C.contract)}=== ARCHIVO: src/service.mjs | create ===\n// MARCA_SERVICIO\nimport { CHECKS } from './contract.mjs';\nexport function validate(input) {\n  const missing = CHECKS.fil`;
  setRules(planOf([['src/contract.mjs', 'code', 30], ['src/service.mjs', 'code', 40]]), [
    { match: 'Continúa el archivo «src/service\\.mjs»', text: '  return {{{ roto(\n=== FIN ARCHIVO ===\n' },
    { match: 'Esta es la unidad 1 de 1', responses: [{ text: cut, stopReason: 'max_tokens' }, { text: resp(F('src/service.mjs', C.service)) }] }
  ]);
  const p = await runIt('D · corte en una unidad');
  const pl = p.result!.pipeline!; const unit = p.result!.manifest!.units[0];
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  const applies = pl.events.filter(e => e.kind === 'apply');
  assert.equal(applies[0].detail, 'src/contract.mjs', 'lo que llegó completo se aplicó en cuanto llegó');
  assert.ok(pl.events.some(e => e.kind === 'unit' && /reconstruido a partir de continuaciones no es válido/.test(e.detail ?? '')), 'la unión inválida se rechaza (no se aplica código cortado)');
  const dev = byRule('Esta es la unidad 1 de 1');
  assert.equal(dev.length, 2); assert.equal(unit.attempts, 2);
  assert.ok(dev[1].markers.includes('Faltan src/service.mjs') && !dev[1].markers.includes('- crear src/contract.mjs'), 'el segundo intento pide SOLO lo que falta');
  assert.equal(wtFile(p, 'src/service.mjs'), C.service); assert.equal(wtFile(p, 'src/contract.mjs'), C.contract);
  assert.equal(pl.corrections, 0);
  assertAccounting(p, 'D');
});

test('E/J · una corrección de QA solo toca lo afectado: lo terminado sobrevive y una reescritura de un archivo terminado se rechaza', async () => {
  setRules(planOf(EIGHT), [
    { match: 'Corrige la implementación de esta historia', text: `=== RESUMEN ===\nCito líneas.\n${P('docs/contract.md', 'MARCA_DOCS: el servicio está en src/service.mjs:3.', 'MARCA_DOCS: validate() está en src/service.mjs:3 y CHECKS en src/contract.mjs:2.')}${F('src/service.mjs', '// reescrito entero por error\nexport const roto = true;\n')}` },
    { match: 'Esta es la unidad 1 de 4', text: resp(F('src/contract.mjs', C.contract), F('src/service.mjs', C.service), F('src/cli.mjs', C.cli)) },
    { match: 'Esta es la unidad 2 de 4', text: resp(PKG) },
    { match: 'Esta es la unidad 3 de 4', text: resp(F('test/service.test.mjs', C.test)) },
    { match: 'Esta es la unidad 4 de 4', text: resp(F('docs/contract.md', C.doc), F('docs/qa-guide.md', C.guide), INCIDENT) }
  ], { match: R.qa, responses: [{ text: qaReject([{ text: 'El contrato no cita archivo:línea de CHECKS', file: 'docs/contract.md', expected: 'citar src/contract.mjs:2' }]) }, { text: QA_OK }] });
  const p = await runIt('E · correcciones dirigidas');
  const pl = p.result!.pipeline!; const man = p.result!.manifest!;
  assert.equal(pl.state, 'verified', pl.reason ?? ''); assert.equal(pl.corrections, 1);
  assert.equal(wtFile(p, 'src/service.mjs'), C.service, 'el servicio terminado NO se regeneró');
  assert.match(wtFile(p, 'docs/contract.md'), /CHECKS en src\/contract\.mjs:2/);
  const fixUnit = man.units.find(u => u.kind === 'correction')!;
  assert.deepEqual(fixUnit.files, ['docs/contract.md']); assert.deepEqual(fixUnit.applied, ['docs/contract.md'], 'el commit de la corrección solo toca el archivo afectado');
  assert.ok(pl.events.some(e => e.kind === 'unit' && /no se regenera un archivo terminado/.test(e.detail ?? '')));
  const fix = byRule(R.fix)[0]; assert.ok(!fix.markers.includes('MARCA_GUIA'), 'la corrección no recibe documentos ajenos');
  assert.equal(byRule('Esta es la unidad 1 de 4').length, 1, 'ninguna unidad terminada se volvió a pedir');
  assertAccounting(p, 'E');
});

test('G · QA detecta un requisito sin cubrir aunque typecheck, pruebas y build pasen: compila ≠ completo ≠ aprobado', async () => {
  const one = planOf([['src/contract.mjs', 'code', 30], ['src/service.mjs', 'code', 40]]);
  const devRules = [{ match: 'Esta es la unidad 1 de 1', text: resp(F('src/contract.mjs', C.contract), F('src/service.mjs', C.service)) }];
  setRules(one, devRules, { match: R.qa, text: qaReject([{ text: 'HALLAZGO_SERVICIO_1: validate no informa qué área falta en el mensaje', file: 'src/service.mjs' }]) });
  const p = await runIt('G · QA rechaza con todo en verde', { maxCorrections: 0 });
  const pl = p.result!.pipeline!;
  assert.notEqual(pl.state, 'verified'); assert.equal(pl.pauseKind, 'limit');
  assert.ok(p.result!.verifications.every(v => v.exitCode === 0), 'typecheck, test y build en verde');
  const qa = byRule(R.qa)[0]; assert.ok(qa.markers.includes('Que compile no basta') && qa.markers.includes('test: OK'));
  const flow = (await flowOf(p.id)).guidance.flow;
  assert.deepEqual(flow.delivery.levels, { compiles: true, complete: true, qaApproved: false }, 'la interfaz distingue los tres niveles');
  assert.notEqual(flow.headline, 'Implementación verificada por QA — lista para revisión del propietario.');
});

test('H · la comprobación determinista evita pagar a QA: prueba que el script no ejecuta → corrección dirigida sin QA; entregable que no llega → pausa sin QA', async () => {
  setRules(planOf([['src/service.mjs', 'code', 40], ['tests/service.spec.mjs', 'test', 30]]), [
    { match: 'Corrige la implementación de esta historia', text: `=== RESUMEN ===\nScript.\n${P('package.json', '"test": "node --test test/*.test.mjs"', '"test": "node --test test/*.test.mjs tests/*.spec.mjs"')}` },
    { match: 'Esta es la unidad 1 de 2', text: resp(F('src/service.mjs', C.contract.replace('MARCA_CONTRATO', 'MARCA_SERVICIO'))) },
    { match: 'Esta es la unidad 2 de 2', text: resp(F('tests/service.spec.mjs', C.test)) }
  ]);
  const p = await runIt('H · prueba no descubierta');
  const pl = p.result!.pipeline!; const man = p.result!.manifest!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  const gates = pl.events.filter(e => e.kind === 'gate');
  assert.match(gates[0].detail ?? '', /el script «test» no ejecuta esta prueba/); assert.match(gates.at(-1)!.message, /sin problemas objetivos/);
  assert.equal(man.rounds[0].source, 'completeness');
  assert.equal(byRule(R.qa).length, 1, 'QA se llamó UNA vez, cuando ya no había nada objetivo que corregir');
  assert.ok(pl.events.findIndex(e => e.kind === 'qa') > pl.events.lastIndexOf(gates.at(-1)!), 'QA después de la comprobación en verde');

  // Un entregable que no llega tras dos intentos: pausa explicada, sin verificar ni pagar a QA.
  setRules(planOf([['src/contract.mjs', 'code', 30], ['src/service.mjs', 'code', 40]]), [{ match: 'Esta es la unidad 1 de 1', text: resp(F('src/contract.mjs', C.contract)) }]);
  const q = await runIt('H2 · entregable que no llega');
  assert.equal(q.result!.pipeline!.pauseKind, 'incomplete'); assert.match(q.result!.pipeline!.reason!, /no se llama a QA con la historia incompleta/);
  assert.equal(byRule(R.qa).length, 0); assert.equal(q.result!.verifications.length, 0, 'ni siquiera se verifica una entrega incompleta');
  assert.equal(q.result!.manifest!.deliverables.find(d => d.path === 'src/service.mjs')!.status, 'failed');
  assert.equal(q.result!.manifest!.deliverables.find(d => d.path === 'src/contract.mjs')!.status, 'delivered', 'lo entregado se conserva');
  const flow = (await flowOf(q.id)).guidance.flow;
  assert.equal(flow.issue.title, 'Pausado: la entrega está incompleta (no se pagó a QA)'); assert.ok(flow.actions.some((a: any) => a.id === 'pipeline_resume'));
  assert.equal(flow.delivery.levels.complete, false);
});

test('I · un rechazo de QA con hallazgos en dos archivos crea dos correcciones dirigidas, cada una con SOLO sus hallazgos', async () => {
  setRules(planOf([['src/contract.mjs', 'code', 30], ['src/service.mjs', 'code', 40], ['src/cli.mjs', 'code', 30]]), [
    { match: 'corrección dirigida \\(«cli\\.mjs', text: `=== RESUMEN ===\nCLI.\n${P('src/cli.mjs', '// MARCA_CLI', '// MARCA_CLI · uso: node src/cli.mjs \'{...}\'')}` },
    { match: 'corrección dirigida \\(«service\\.mjs', text: `=== RESUMEN ===\nServicio.\n${P('src/service.mjs', '  return { ok: missing.length === 0, missing };', '  return { ok: missing.length === 0, missing, message: missing.length ? `faltan: ${missing.join(\', \')}` : \'ok\' };')}` },
    { match: 'Esta es la unidad 1 de 1', text: resp(F('src/contract.mjs', C.contract), F('src/service.mjs', C.service), F('src/cli.mjs', C.cli)) }
  ], { match: R.qa, responses: [{ text: qaReject([{ text: 'HALLAZGO_SERVICIO_1: falta el mensaje', file: 'src/service.mjs' }, { text: 'HALLAZGO_SERVICIO_2: el mensaje no nombra el área', file: 'src/service.mjs' }, { text: 'HALLAZGO_CLI: falta la ayuda de uso', file: 'src/cli.mjs' }]) }, { text: QA_OK }] });
  const p = await runIt('I · dos archivos con hallazgos');
  const pl = p.result!.pipeline!; const man = p.result!.manifest!;
  assert.equal(pl.state, 'verified', pl.reason ?? ''); assert.equal(pl.corrections, 1, 'una ronda = una corrección');
  const round = man.units.filter(u => u.round === 0);
  assert.deepEqual(round.map(u => u.files[0]).sort(), ['src/cli.mjs', 'src/service.mjs']);
  const svc = byRule('corrección dirigida \\(«service\\.mjs')[0]; const cli = byRule('corrección dirigida \\(«cli\\.mjs')[0];
  assert.ok(svc.markers.includes('HALLAZGO_SERVICIO_1') && svc.markers.includes('HALLAZGO_SERVICIO_2') && !svc.markers.includes('HALLAZGO_CLI'));
  assert.ok(cli.markers.includes('HALLAZGO_CLI') && !cli.markers.includes('HALLAZGO_SERVICIO_1'));
  assert.match(wtFile(p, 'src/service.mjs'), /faltan: /); assert.match(wtFile(p, 'src/cli.mjs'), /uso: node src\/cli\.mjs/);
  assertAccounting(p, 'I');
});

let pK = '';
test('K/P · correcciones sin efecto: segundo intento con otra estrategia (consulta al Arquitecto del equipo) y, si tampoco, se detiene sin consumir la cuota', async () => {
  setRules(planOf([['src/contract.mjs', 'code', 30], ['src/service.mjs', 'code', 40]]), [
    { match: 'Corrige la implementación de esta historia', text: `=== RESUMEN ===\nIntento.\n${P('src/service.mjs', 'export function validar(entrada) {', 'export function validar(entrada, opciones) {')}` },
    { match: 'Esta es la unidad 1 de 1', text: resp(F('src/contract.mjs', C.contract), F('src/service.mjs', C.service)) }
  ], { match: R.qa, text: qaReject([{ text: 'HALLAZGO_SERVICIO_1: validate debe aceptar opciones', file: 'src/service.mjs' }]) });
  const p = await runIt('K · contratos y arquitectura: corrección imposible', { maxCorrections: 3 });
  pK = p.id;
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'stopped'); assert.equal(pl.pauseKind, 'repeated_failure'); assert.match(pl.reason!, /no produjo ningún cambio aplicable/);
  assert.equal(byRule(R.fix).length, 2, 'dos intentos y se detiene (no agota las 3 correcciones)');
  assert.equal(pl.corrections, 0, 'una corrección sin cambios aplicables NO consume la cuota'); assert.equal(pl.correctionAttempts, 2, 'pero sí queda contada y pagada'); assert.equal(pl.ineffectiveRounds, 1);
  assert.equal(byRule(R.advice).length, 1, 'cambio de estrategia: se consulta una vez al especialista autorizado');
  assert.ok(byRule(R.fix)[1].markers.includes('MARCA_CONSEJO') && byRule(R.fix)[1].markers.includes('Criterio de'), 'el segundo intento recibe el criterio del especialista');
  assert.equal(byRule(R.qa).length, 1, 'QA no se repite sin cambios');
  assert.equal(wtFile(p, 'src/service.mjs'), C.service, 'lo hecho se conserva');
  assertAccounting(p, 'K');
});

test('L · un fallo de formato y una corrección cortada no consumen la cuota de correcciones (contadores separados)', async () => {
  const cutFix = `=== RESUMEN ===\nMensaje.\n=== ARCHIVO: src/service.mjs | patch ===\n<<<< BUSCAR\n  return { ok: missing.length === 0, missing };\n==== REEMPLAZAR\n  return { ok: missing.length === 0, mis`;
  setRules(planOf([['src/contract.mjs', 'code', 30], ['src/service.mjs', 'code', 40]]), [
    { match: 'Continúa el archivo «src/service\\.mjs»', text: '  return { ok: missing.length === 0, missing, message: missing.join(\', \') };\n>>>> FIN\n=== FIN ARCHIVO ===\n' },
    { match: R.repair, text: resp(F('src/contract.mjs', C.contract), F('src/service.mjs', C.service)) },
    { match: 'Corrige la implementación de esta historia', text: cutFix, stopReason: 'max_tokens' },
    { match: 'Esta es la unidad 1 de 1', text: 'Listo, ya quedó implementado todo lo que pide la historia.' }
  ], { match: R.qa, responses: [{ text: qaReject([{ text: 'HALLAZGO_SERVICIO_1: falta el mensaje', file: 'src/service.mjs' }]) }, { text: QA_OK }] });
  const p = await runIt('L · contadores separados');
  const pl = p.result!.pipeline!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  assert.equal(pl.outputRepairs, 1, 'formato: reparación'); assert.equal(pl.continuations, 1, 'corte: continuación'); assert.equal(pl.corrections, 1, 'solo la ronda que aplicó cuenta como corrección'); assert.equal(pl.correctionAttempts, 1);
  assert.match(wtFile(p, 'src/service.mjs'), /message: missing\.join/);
  assertAccounting(p, 'L');
});

test('M · cada llamada pagada queda contabilizada, también la que agota la salida en razonamiento oculto (y cambia la estrategia: se divide la unidad)', async () => {
  setRules(planOf([['src/contract.mjs', 'code', 30], ['src/cli.mjs', 'code', 30]]), [
    { match: 'Esta es la unidad 1 de ', responses: [{ text: '', stopReason: 'max_tokens', thinkingTokens: 9000 }, { text: resp(F('src/contract.mjs', C.contract)), thinkingTokens: 300 }] },
    { match: 'Esta es la unidad 2 de 2', text: resp(F('src/cli.mjs', C.cli.replace("from './service.mjs'", "from './contract.mjs'"))) }
  ], { match: R.qa, text: QA_OK, thinkingTokens: 500 });
  const p = await runIt('M · salida agotada');
  const pl = p.result!.pipeline!; const man = p.result!.manifest!;
  assert.equal(pl.state, 'verified', pl.reason ?? '');
  const exhausted = p.steps.find(s => s.role === 'implementer' && s.outputTokens === 9000)!;
  assert.ok(exhausted && exhausted.costUsd > 0 && !exhausted.outputMd, 'la llamada sin texto se pagó y queda registrada con su costo');
  assert.ok(pl.events.some(e => /agotó toda su salida \(9000 tokens facturados\)/.test(e.message)));
  assert.equal(man.units.length, 2, 'estrategia nueva: la unidad se dividió (un archivo por unidad)');
  assert.equal(pl.corrections, 0); assert.equal(pl.continuations, 1);
  const qa = p.steps.find(s => s.role === 'reviewer' && s.status === 'done')!; assert.ok(qa.outputTokens >= 500, 'el razonamiento oculto de QA también se contabiliza');
  assertAccounting(p, 'M');
});

test('N · presupuesto: si el plan no cabe se pausa ANTES de implementar; si a mitad no cabe la siguiente unidad, se pausa sin llamar y continuar no repite lo hecho', async () => {
  setRules(planOf(EIGHT), [{ match: R.dev, text: resp(F('src/contract.mjs', C.contract)) }]);
  // Tras planificar, el presupuesto restante queda casi agotado: la comprobación previa pausa antes de la primera unidad.
  const p = await runIt('N · plan que no cabe', {}, 5, (_o, m) => { if (/^Plan dividido/.test(m)) { const cur = processesRepo(S).get(p0Id())!; processesRepo(S).authorize(cur.id, cur.spentUsd + 0.01); } });
  assert.equal(p.result!.pipeline!.pauseKind, 'budget'); assert.match(p.result!.pipeline!.reason!, /solo para implementar sus 4 unidades/);
  assert.equal(byRule(R.dev).length, 0, 'ninguna unidad se empezó'); assert.ok(p.spentUsd <= p.budgetUsd);
  assert.equal(p.result!.manifest!.units.length, 4, 'el plan y el manifiesto se conservan');

  setRules(planOf([['src/contract.mjs', 'code', 30], ['test/service.test.mjs', 'test', 30]]), [
    { match: 'Esta es la unidad 1 de 2', text: resp(F('src/contract.mjs', C.contract)) },
    { match: 'Esta es la unidad 2 de 2', text: resp(F('test/contract.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { CHECKS } from '../src/contract.mjs';\ntest('tres', () => assert.equal(CHECKS.length, 3));\n"), F('test/service.test.mjs', "import { test } from 'node:test';\ntest('ok', () => {});\n")) }
  ]);
  const id = newRun('N2 · presupuesto a mitad', {}, 5);
  // Al aplicarse la unidad 1, el presupuesto restante queda casi agotado (como si se hubiera gastado en otra cosa autorizada).
  await runStory(S, id, (_o, m) => { if (/^Unidad 1 de 2 aplicada/.test(m)) { const cur = processesRepo(S).get(id)!; processesRepo(S).authorize(id, cur.spentUsd + 0.0001); } }, () => false);
  let q = processesRepo(S).get(id)!;
  assert.equal(q.result!.pipeline!.pauseKind, 'budget'); assert.match(q.result!.pipeline!.reason!, /superaría el presupuesto autorizado/);
  assert.equal(byRule('Esta es la unidad 2 de 2').length, 0, 'sin llamar a la IA'); assert.ok(q.spentUsd <= q.budgetUsd + 1e-9);
  assert.equal(q.result!.manifest!.deliverables.find(d => d.path === 'src/contract.mjs')!.status, 'delivered', 'la unidad 1 está aplicada y se conserva');
  const cont = await app.inject({ method: 'POST', url: `${W}/processes/${id}/continue`, payload: { authorized: true, addBudgetUsd: 2 } });
  assert.equal(cont.statusCode, 200, cont.body);
  q = await waitDone(id);
  assert.equal(q.result!.pipeline!.state, 'verified', q.result!.pipeline!.reason ?? '');
  assert.equal(byRule('Esta es la unidad 1 de 2').length, 1, 'continuar no repite la unidad 1'); assert.equal(byRule('Esta es la unidad 2 de 2').length, 1);
  assert.equal(byRule(R.plan).length, 1, 'ni el plan');
  assertAccounting(q, 'N2');
});

test('O · reinicio REAL del Portal (otro proceso, mismos datos) a mitad de una unidad: lo terminado se conserva y continuar no repite ninguna llamada completada', async () => {
  const plan = planOf([['src/contract.mjs', 'code', 30], ['test/service.test.mjs', 'test', 30], ['docs/contract.md', 'docs', 20]]);
  const rules = (slow: boolean) => [
    { match: 'Esta es la unidad 1 de 3', text: resp(F('src/contract.mjs', C.contract)) },
    { match: 'Esta es la unidad 2 de 3', text: resp(F('test/service.test.mjs', "import { test } from 'node:test';\ntest('ok', () => {});\n")) },
    { match: 'Esta es la unidad 3 de 3', text: resp(F('docs/contract.md', C.doc)), ...(slow ? { delayMs: 120_000 } : {}) }
  ];
  setRules(plan, rules(true));
  const id = newRun('O · reinicio a mitad');
  const serverSrc = fileURLToPath(new URL('../src/', import.meta.url));
  const childFile = path.join(dataDir, 'child-run.mts');
  fs.writeFileSync(childFile, `const { runStory } = await import(${JSON.stringify(pathToFileURL(path.join(serverSrc, 'services/storyExecution.ts')).href)});\nawait runStory(${JSON.stringify(S)}, ${JSON.stringify(id)}, () => undefined, () => false);\nconsole.log('FIN'); process.exit(0);\n`);
  const child = spawn(process.execPath, ['--import', 'tsx', childFile], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, LOG_LEVEL: 'silent' }, stdio: 'ignore' });
  const exited = new Promise(r => child.once('exit', r));
  // El Portal «se cae» (proceso terminado de golpe) mientras la unidad 3 espera al proveedor.
  await waitFor(() => processesRepo(S).get(id)!.steps.some(s => s.status === 'running' && s.live?.state === 'waiting' && /Unidad 3 de 3/.test(s.title)), 90_000);
  child.kill(); await exited;
  assert.equal(processesRepo(S).get(id)!.status, 'running', 'en la base sigue «en ejecución» (como tras un corte real)');
  assert.equal(recoverInterruptedProcesses(() => undefined), 1);
  let p = processesRepo(S).get(id)!;
  assert.equal(p.result!.pipeline!.pauseKind, 'interrupted');
  assert.deepEqual(p.result!.manifest!.deliverables.map(d => d.status), ['delivered', 'delivered', 'pending'], 'las unidades terminadas siguen aplicadas');
  const lost = p.steps.find(s => /Unidad 3 de 3/.test(s.title))!; assert.equal(lost.status, 'failed'); assert.match(lost.error ?? '', /Interrumpido/);
  setRules(plan, rules(false));
  const before = { u1: 1, u2: 1 };
  const cont = await app.inject({ method: 'POST', url: `${W}/processes/${id}/continue`, payload: { authorized: true, addBudgetUsd: 1 } });
  assert.equal(cont.statusCode, 200, cont.body);
  p = await waitDone(id);
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  assert.equal(byRule('Esta es la unidad 1 de 3').length + before.u1, 1, 'la unidad 1 no se volvió a pedir');
  assert.equal(byRule('Esta es la unidad 2 de 3').length + before.u2, 1, 'ni la 2');
  assert.equal(byRule('Esta es la unidad 3 de 3').length, 1, 'solo se repitió la llamada interrumpida');
  assert.equal(byRule(R.plan).length, 0, 'ni el plan');
  assert.ok((p.unconfirmedUsd ?? 0) > 0, 'la llamada interrumpida queda como costo NO confirmado');
  assert.equal(wtFile(p, 'docs/contract.md'), C.doc);
});

test('P · especialistas autorizados: el Coordinador planifica los entregables, el Arquitecto aconseja, el Desarrollador entrega por unidades y QA revisa', async () => {
  const p = processesRepo(S).get(pB)!;
  const roles = p.steps.filter(s => s.status === 'done').map(s => s.role);
  assert.equal(roles.filter(r => r === 'planner').length, 1); assert.ok(roles.filter(r => r === 'consultant').length >= 1, 'consulta del Arquitecto');
  assert.equal(roles.filter(r => r === 'implementer').length, 4, 'una llamada por unidad'); assert.equal(roles.filter(r => r === 'reviewer').length, 1);
  assert.ok(p.result!.team!.members.some(m => m.role === 'consultant' && /Arquitecto/.test(m.agentName)));
  const k = processesRepo(S).get(pK)!;
  assert.ok(k.steps.some(s => s.role === 'consultant' && /^Consulta de .*: .*service\.mjs/.test(s.title)), 'al fallar una corrección se consulta al especialista del equipo autorizado');
  assert.ok(!k.steps.some(s => !k.result!.team!.members.some(m => m.agentId === s.agentId)), 'nadie fuera del equipo autorizado participa');
});

test('Q · límites: nada se integra, publica ni reinicia; tu carpeta no cambia; continuar exige autorización', async () => {
  const kinds = (workspaceDb(S).prepare(`SELECT kind FROM execution_history WHERE kind LIKE 'policy:%'`).all() as any[]).map(r => r.kind as string);
  for (const op of ['git_merge', 'git_push', 'restart_portal']) assert.ok(!kinds.some(k => k.startsWith(`policy:${op}:`)), `ninguna concesión de ${op}`);
  assert.ok(kinds.some(k => k.startsWith('policy:write_worktree:granted')), 'cada unidad escribe por la política del worktree');
  assert.equal(execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim(), repoHead); assert.equal(execSync('git status --porcelain', { cwd: repo, encoding: 'utf8' }).trim(), '');
  assert.ok(!fs.existsSync(path.join(repo, 'src/contract.mjs')), 'los entregables viven en worktrees aislados');
  const any = processesRepo(S).list(project.id).find(p => p.result?.applied?.worktree && !p.result.merged)!;
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${any.id}/continue`, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `${W}/processes/${any.id}/merge`, payload: {} })).statusCode, 400);
  for (const p of processesRepo(S).list(project.id)) { assert.ok(!p.result?.merged); assert.ok(!p.result?.published); }
});

test('T · la interfaz recibe el progreso por entregable: unidad en curso con su agente, niveles, correcciones, costo y siguiente paso', async () => {
  setRules(planOf([['src/contract.mjs', 'code', 30], ['docs/contract.md', 'docs', 20]]), [
    { match: 'Esta es la unidad 1 de 2', text: resp(F('src/contract.mjs', C.contract)) },
    { match: 'Esta es la unidad 2 de 2', text: resp(F('docs/contract.md', C.doc)), delayMs: 1500 }
  ]);
  const id = newRun('T · progreso visible');
  const job = trackJob(id, runStory(S, id, () => undefined, () => false));
  await waitFor(() => processesRepo(S).get(id)!.steps.some(s => s.status === 'running' && /Unidad 2 de 2/.test(s.title) && s.live));
  const live = (await flowOf(id)).guidance.flow;
  assert.equal(live.delivery.delivered, 1); assert.equal(live.delivery.total, 2);
  assert.deepEqual(live.delivery.deliverables.map((d: any) => d.status), ['delivered', 'pending']);
  assert.equal(live.delivery.currentUnit.index, 2); assert.equal(live.delivery.currentUnit.agentName, 'Desarrollador Full Stack');
  assert.match(live.stages.find((s: any) => s.key === 'execute').detail, /1 de 2 entregables · unidad 2 de 2/);
  assert.ok(live.delivery.remainingEstimateUsd > 0); assert.match(live.delivery.next, /Entregar «Documentación: contract\.md»/);
  assert.equal(live.delivery.levels.qaApproved, false);
  await job;
  const fin = (await flowOf(id)).guidance.flow;
  assert.deepEqual(fin.delivery.levels, { compiles: true, complete: true, qaApproved: true }); assert.equal(fin.delivery.currentUnit, null);
  assert.equal(fin.delivery.corrections.applied, 0); assert.match(fin.delivery.next, /Tu revisión/);
});

test('HU-155 (procesos sin manifiesto): la reparación de una entrega cortada pide TAMBIÉN los archivos del plan que nunca llegaron', async () => {
  const plan = planOf(EIGHT);
  const cut = `=== RESUMEN ===\nParcial.\n${F('docs/contract.md', C.doc)}=== ARCHIVO: src/service.mjs | create ===\n// MARCA_SERVICIO\nexport function validate(input) {`;
  fs.writeFileSync(scriptPath, JSON.stringify({ markers: EIGHT.map(d => `- ${d[0]}`), rules: [{ match: R.plan, text: plan }, { match: R.consult, text: 'ok' }, { match: R.repair, text: resp(F('src/service.mjs', C.service)) }, { match: 'Continúa EXACTAMENTE', text: '', stopReason: 'max_tokens' }, { match: R.qa, text: QA_OK }, { match: R.dev, text: cut, stopReason: 'max_tokens' }] }));
  try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  // Pipeline sin aplicación automática: la historia entera en una respuesta (el camino de antes de la entrega incremental).
  await runIt('HU-155 · réplica sin manifiesto', { autoApply: false }, 3);
  const rep = byRule(R.repair)[0];
  assert.ok(rep, 'hubo una reparación acotada');
  for (const f of ['src/contract.mjs', 'src/cli.mjs', 'package.json', 'test/service.test.mjs', 'docs/qa-guide.md', 'docs/incident.md']) assert.ok(rep.markers.includes(`- ${f}`), `la reparación pide también ${f} (antes solo pedía el archivo cortado: 2 de 8)`);
});

test('lecciones: los problemas de HU-155 quedan como evidencia «detectada» (nunca validada sola)', () => {
  const all = lessonsRepo(S).list(project.id);
  for (const d of ['oversized_response', 'output_exhausted', 'regenerated_completed', 'incomplete_delivery', 'ineffective_correction', 'missing_tests']) {
    const ls = all.filter(l => l.detector === d);
    assert.ok(ls.length >= 1, `lección detectada: ${d}`);
    for (const l of ls) { assert.equal(l.status, 'detected'); assert.equal(l.lessonText, null); assert.equal(l.validatedAt, null); }
  }
});

// ---------- Revisión de código: casos límite del motor incremental ----------
test('revisión 1/2 · un plan con formas inesperadas no rompe el manifiesto; un plan sin archivos va en una sola respuesta', async () => {
  const odd = JSON.stringify({ summary: 'Raro', tasks: [{ text: 'Crear el contrato' }], filesToRead: 'src/index.mjs', filesToChange: [{ path: 'src/contract.mjs' }], acceptance: 'El contrato existe', risks: null });
  setRules(odd, [{ match: 'Esta es la unidad 1 de 1', text: resp(F('src/contract.mjs', C.contract)) }]);
  const p = await runIt('Revisión · plan raro');
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  assert.deepEqual(p.result!.plan!.filesToChange, ['src/contract.mjs']); assert.deepEqual(p.result!.plan!.acceptance, ['El contrato existe']); assert.deepEqual(p.result!.plan!.tasks, ['Crear el contrato']);
  setRules('No pude escribir el plan en JSON.', [{ match: R.dev, text: resp(F('src/contract.mjs', C.contract)) }]);
  const q = await runIt('Revisión · plan ilegible');
  assert.equal(q.result!.manifest ?? null, null, 'sin entregables no hay manifiesto: la historia va en una respuesta');
  assert.equal(q.result!.pipeline!.state, 'verified', q.result!.pipeline!.reason ?? ''); assert.equal(byRule(R.dev).length, 1, 'el Desarrollador sí trabaja (antes: cero unidades y nada implementado)');
});

test('revisión 3 · una unidad dividida termina ANTES que las unidades que dependen de ella', async () => {
  setRules(planOf([['src/contract.mjs', 'code', 30], ['src/cli.mjs', 'code', 30], ['test/service.test.mjs', 'test', 30]]), [
    { match: 'Esta es la unidad 1 de ', responses: [{ text: '', stopReason: 'max_tokens', thinkingTokens: 5000 }, { text: resp(F('src/contract.mjs', C.contract)) }] },
    { match: 'Esta es la unidad 2 de 3', text: resp(F('src/cli.mjs', C.cli.replace("from './service.mjs'", "from './contract.mjs'"))) },
    { match: 'Esta es la unidad 3 de 3', text: resp(F('test/service.test.mjs', "import { test } from 'node:test';\ntest('ok', () => {});\n")) }
  ]);
  const p = await runIt('Revisión · orden tras dividir');
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  const order = calls().map(c => c.rule).filter(r => /^Esta es la unidad/.test(r ?? ''));
  assert.deepEqual(order, ['Esta es la unidad 1 de ', 'Esta es la unidad 1 de ', 'Esta es la unidad 2 de 3', 'Esta es la unidad 3 de 3'], 'la parte dividida (cli) va antes que las pruebas');
  assert.ok(byRule('Esta es la unidad 3 de 3')[0].markers.includes('MARCA_CLI'), 'las pruebas ven el código ya entregado');
});

test('revisión 4 · la duración máxima autorizada se respeta entre unidades (no solo por vuelta del pipeline)', async () => {
  setRules(planOf([['src/contract.mjs', 'code', 30], ['test/service.test.mjs', 'test', 30], ['docs/contract.md', 'docs', 20]]), [{ match: 'Esta es la unidad 1 de 3', text: resp(F('src/contract.mjs', C.contract)) }, { match: R.dev, text: resp(F('docs/contract.md', C.doc)) }]);
  const id = newRun('Revisión · duración');
  // Al aplicar la unidad 1, el pipeline «lleva» 3 horas (más que los 45 min autorizados).
  await runStory(S, id, (_o, m) => { if (/^Unidad 1 de 3 aplicada/.test(m)) { const cur = processesRepo(S).get(id)!; processesRepo(S).setResult(id, { ...cur.result!, pipeline: { ...cur.result!.pipeline!, startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() } }); } }, () => false);
  const p = processesRepo(S).get(id)!;
  assert.equal(p.result!.pipeline!.pauseKind, 'duration'); assert.equal(calls().filter(c => /^Esta es la unidad|Implementa/.test(c.rule ?? '') && c.rule !== 'Esta es la unidad 1 de 3').length, 0, 'ninguna unidad más tras superar la duración');
});

test('revisión 5 · el archivo que pide una unidad sale del worktree (lo que entregó una unidad anterior), no de la carpeta del propietario', async () => {
  const BLOQUEO = '=== RESUMEN ===\nNecesito ver un archivo.\n=== BLOQUEO ===\ntipo: informacion\nnecesito: el contenido de src/helpers.mjs\npregunta: ¿Qué exporta src/helpers.mjs?\nconsultar: ninguno\n';
  setRules(planOf([['src/contract.mjs', 'code', 30], ['test/service.test.mjs', 'test', 30]]), [
    { match: 'Antes no pudiste implementar la historia', text: resp(F('test/service.test.mjs', "import { test } from 'node:test';\nimport { help } from '../src/helpers.mjs';\ntest('ok', () => help());\n")) },
    { match: 'Esta es la unidad 1 de 2', text: resp(F('src/contract.mjs', C.contract), F('src/helpers.mjs', '// MARCA_HELPER\nexport const help = () => 1;\n')) },
    { match: 'Esta es la unidad 2 de 2', text: BLOQUEO }
  ]);
  const p = await runIt('Revisión · contexto del worktree');
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  const supply = byRule('Antes no pudiste implementar la historia');
  assert.equal(supply.length, 1); assert.ok(supply[0].markers.includes('MARCA_HELPER'), 'recibe el archivo que creó la unidad 1 (no existe en tu carpeta)');
});

test('revisión 6 · continuar tras «entrega incompleta» de la comprobación previa la repite: sin correcciones nuevas vuelve a pausar sin pagar a QA', async () => {
  setRules(planOf([['src/contract.mjs', 'code', 30]]), [
    { match: 'Corrige la implementación de esta historia', text: `=== RESUMEN ===\nCompleto.\n${P('src/contract.mjs', '// ...', "export const AREAS = 3;")}` },
    { match: 'Esta es la unidad 1 de 1', text: resp(F('src/contract.mjs', `${C.contract}// ...\n`)) }
  ]);
  const id = newRun('Revisión · reanudar tras incompleta', { maxCorrections: 0 });
  await runStory(S, id, () => undefined, () => false);
  let p = processesRepo(S).get(id)!;
  assert.equal(p.result!.pipeline!.pauseKind, 'incomplete'); assert.equal(byRule(R.qa).length, 0);
  let cont = await app.inject({ method: 'POST', url: `${W}/processes/${id}/continue`, payload: { authorized: true, addBudgetUsd: 1 } });
  assert.equal(cont.statusCode, 200, cont.body); p = await waitDone(id);
  assert.equal(p.result!.pipeline!.pauseKind, 'incomplete', 'la comprobación se repitió y volvió a pausar'); assert.equal(byRule(R.qa).length, 0, 'QA no se paga por una entrega incompleta');
  const act = (await flowOf(id)).guidance.flow.actions.find((a: any) => a.id === 'pipeline_resume');
  assert.deepEqual(act.pipeline, { maxCorrections: 1 }, '«Reintentar solo lo que falta» concede la corrección que hace falta');
  cont = await app.inject({ method: 'POST', url: `${W}/processes/${id}/continue`, payload: { authorized: true, addBudgetUsd: 1, pipeline: act.pipeline } });
  assert.equal(cont.statusCode, 200, cont.body); p = await waitDone(id);
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? ''); assert.equal(byRule(R.qa).length, 1);
  assert.doesNotMatch(wtFile(p, 'src/contract.mjs'), /\/\/ \.\.\./);
});

test('revisión 7 · un borrado planificado cuenta como entregado (no se vuelve a pedir «crearlo»)', async () => {
  setRules(JSON.stringify({ summary: 'Retirar el módulo antiguo', tasks: ['Eliminar src/legacy.mjs', 'Crear el contrato'], filesToRead: [], filesToChange: ['src/legacy.mjs', 'src/contract.mjs'], deliverables: [{ path: 'src/legacy.mjs', purpose: 'Eliminar el módulo antiguo', kind: 'code' }, { path: 'src/contract.mjs', purpose: 'Contrato', kind: 'code', estimatedLines: 10 }], acceptance: ['El módulo antiguo ya no existe'], risks: [] }), [
    { match: 'Esta es la unidad 1 de 1', text: `=== RESUMEN ===\nRetirado.\n=== ARCHIVO: src/legacy.mjs | delete ===\n=== FIN ARCHIVO ===\n${F('src/contract.mjs', C.contract)}${OWNER}` }
  ]);
  const p = await runIt('Revisión · borrado planificado');
  assert.equal(p.result!.pipeline!.state, 'verified', p.result!.pipeline!.reason ?? '');
  const d = p.result!.manifest!.deliverables.find(x => x.path === 'src/legacy.mjs')!;
  assert.equal(d.status, 'delivered'); assert.match(d.note ?? '', /eliminado/);
  assert.equal(byRule('Esta es la unidad 1 de 1').length, 1, 'sin segundo intento');
  assert.ok(!fs.existsSync(path.join(p.result!.applied!.worktree!, 'src/legacy.mjs')));
});

test('revisión 8/9 · un DESCARTE de un archivo ya entregado no cuenta como corrección; discutir un hallazgo con SIN CAMBIOS llega a QA', async () => {
  const plan = planOf([['src/contract.mjs', 'code', 30]]); const dev = { match: 'Esta es la unidad 1 de 1', text: resp(F('src/contract.mjs', C.contract)) };
  const finding = qaReject([{ text: 'CHECKS debería tener cuatro áreas', file: 'src/contract.mjs' }]);
  setRules(plan, [{ match: 'Corrige la implementación de esta historia', text: '=== RESUMEN ===\nNo hace falta.\n=== DESCARTE: src/contract.mjs ===\nYa no se necesita.\n' }, dev], { match: R.qa, text: finding });
  const p = await runIt('Revisión · descarte de lo entregado');
  assert.equal(p.result!.pipeline!.pauseKind, 'repeated_failure'); assert.equal(p.result!.pipeline!.corrections, 0, 'no cuenta como corrección');
  assert.equal(byRule(R.qa).length, 1, 'ni se vuelve a pagar a QA sobre el mismo código');
  assert.equal(p.result!.manifest!.deliverables[0].status, 'delivered', 'el entregable no se marca como descartado');

  setRules(plan, [{ match: 'Corrige la implementación de esta historia', text: '=== RESUMEN ===\nEl hallazgo no aplica.\n=== SIN CAMBIOS ===\nMARCA_DISPUTA: el criterio pide tres áreas (datos, gasto y lecciones) y CHECKS las tiene en src/contract.mjs:2.\n' }, dev], { match: R.qa, responses: [{ text: finding }, { text: QA_OK }] });
  const q = await runIt('Revisión · hallazgo discutido');
  assert.equal(q.result!.pipeline!.state, 'verified', q.result!.pipeline!.reason ?? '');
  assert.equal(byRule(R.fix).length, 1, 'una sola llamada: la discusión es un resultado válido, no un intento fallido');
  assert.ok(byRule(R.qa)[1].markers.includes('MARCA_DISPUTA'), 'QA recibe la respuesta del equipo y decide');
  assert.equal(wtFile(q, 'src/contract.mjs'), C.contract, 'sin cambios inventados');
});

test('revisión 10 · patrones del script de test con llaves o «?» no se dan por «prueba no ejecutada»', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-glob-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: "mocha 'test/**/*.{test,spec}.mjs'" } }));
  assert.equal(testDiscovered(dir, 'test/a/x.spec.mjs'), null, 'no comprobable: nunca un falso positivo');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/*.test.mjs' } }));
  assert.deepEqual(testDiscovered(dir, 'test/x.test.mjs')?.ok, true); assert.deepEqual(testDiscovered(dir, 'tests/x.spec.mjs')?.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- R · Docker real ----------
let dockerReady = (await real.detect(true)).available === 'docker';
for (let i = 0; i < 3 && !dockerReady; i++) { await new Promise(r => setTimeout(r, 2000)); dockerReady = (await real.detect(true)).available === 'docker'; }
const requireDocker = process.env.PORTAL_REQUIRE_DOCKER === '1';
test('R · historia de 8 archivos con Docker real: unidades, un corte continuado, rechazo de QA corregido de forma dirigida y aprobación con artefactos verificados', { skip: dockerReady || requireDocker ? false : 'Docker no disponible: R necesita el sandbox real' }, async () => {
  assert.ok(dockerReady, 'Docker no está disponible');
  sandboxDeps.detect = real.detect; sandboxDeps.run = real.run;
  try {
    const serviceCut = `=== RESUMEN ===\nCódigo.\n${F('src/contract.mjs', C.contract)}=== ARCHIVO: src/service.mjs | create ===\n// MARCA_SERVICIO\nimport { CHECKS } from './contract.mjs';\nexport function validate(input) {\n  const missing = CHECKS.fil`;
    setRules(planOf(EIGHT), [
      { match: 'Continúa el archivo «src/service\\.mjs»', text: "  const missing = CHECKS.filter(c => !(c in input));\n  return { ok: missing.length === 0, missing };\n}\n=== FIN ARCHIVO ===\n" + F('src/cli.mjs', C.cli) },
      { match: 'Corrige la implementación de esta historia', text: `=== RESUMEN ===\nCito líneas.\n${P('docs/contract.md', 'MARCA_DOCS: el servicio está en src/service.mjs:3.', 'MARCA_DOCS: validate() está en src/service.mjs:3 y CHECKS en src/contract.mjs:2.')}` },
      { match: 'Esta es la unidad 1 de 4', text: serviceCut, stopReason: 'max_tokens' },
      { match: 'Esta es la unidad 2 de 4', text: resp(PKG) },
      { match: 'Esta es la unidad 3 de 4', text: resp(F('test/service.test.mjs', C.test)) },
      { match: 'Esta es la unidad 4 de 4', text: resp(F('docs/contract.md', C.doc), F('docs/qa-guide.md', C.guide), INCIDENT) }
    ], { match: R.qa, responses: [{ text: qaReject([{ text: 'El contrato no cita CHECKS con archivo:línea', file: 'docs/contract.md' }]) }, { text: QA_OK }] });
    const p = await runIt('R · validador completo en Docker', { allowInstall: true }, 8);
    const pl = p.result!.pipeline!; const r = p.result!; const man = r.manifest!;
    assert.equal(pl.state, 'verified', pl.reason ?? '');
    for (const cmd of ['typecheck', 'test', 'build']) assert.ok(r.verifications.some(v => v.command === cmd && v.exitCode === 0 && v.isolation === 'docker'), `${cmd} en verde en Docker`);
    const t = r.verifications.filter(v => v.command === 'test' && v.exitCode === 0).at(-1)!;
    assert.match(t.output, /valida las tres áreas/, 'la prueba NUEVA se ejecutó de verdad en el sandbox');
    assert.equal(r.review?.verdict, 'approved'); assert.equal(pl.corrections, 1); assert.equal(pl.continuations, 1);
    assert.equal(man.deliverables.filter(d => d.planned && d.status === 'delivered').length, 8);
    assert.equal(wtFile(p, 'src/service.mjs'), C.service, 'el archivo continuado quedó exacto');
    assert.match(wtFile(p, 'package.json'), /"validate": "node src\/cli\.mjs"/);
    const flow = (await flowOf(p.id)).guidance.flow;
    assert.deepEqual(flow.delivery.levels, { compiles: true, complete: true, qaApproved: true });
    assert.ok(!r.merged && !r.published, 'no integra ni publica');
    assertAccounting(p, 'R');
  } finally { useFakeSandbox(); }
});

after(async () => {
  sandboxDeps.detect = real.detect; sandboxDeps.run = real.run;
  await app.close();
  if (dockerReady) {
    try { execFileSync('docker', ['volume', 'rm', '-f', depsVolumeName(repo, SANDBOX_IMAGE)], { env: dockerCliEnv(), stdio: 'ignore' }); } catch { /* limpieza best effort */ }
  }
});

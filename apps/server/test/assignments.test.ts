import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Encargos de desarrollo del propietario (sin historia), con el MISMO motor que las historias. Proveedor simulado
 * (0 USD), sandbox determinista sustituido, repositorio sintético. Escenarios: definir sin IA ni proceso; autorizar crea
 * y autoriza el proceso en el mismo acto (worktree propio, rama EN, Docker, QA, Gauntlet automático); listo para revisar
 * con evidencia y registro en Conocimiento; el backlog no cambia; aceptar exige la regla de cierre; pedir cambios prepara
 * otra iteración con la nota; una autorización rechazada no deja procesos pendientes; un reinicio no lo deja «en marcha».
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-assign-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const here = path.dirname(fileURLToPath(import.meta.url));

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { backlogRepo, knowledgeRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { recoverInterruptedProcesses } = await import('../src/services/interruptions.ts');
const { saveUsageReport, acknowledgeUsageReport } = await import('../src/services/claudeCode/usage.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-assign-repo-'));
const uniq = `assign-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/base.ts'), 'export const base = 0;\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node -e ""', test: 'node -e ""', build: 'node -e ""' } }, null, 2));
fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: uniq, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.0' } } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { await app.close(); });
const inject = (method: string, u: string, payload?: unknown) => app.inject({ method: method as any, url: u, payload: payload as any });

const ranCommands: string[] = [];
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { ranCommands.push(command); const t = new Date().toISOString(); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' }; };

const PLAN = (file: string) => JSON.stringify({ summary: `Crear ${file}`, tasks: [`Crear ${file}`], filesToRead: [], filesToChange: [file], acceptance: [`${file} existe`], risks: [] });
const DEV = (file: string, v: number) => `=== RESUMEN ===\nCrea ${file}.\n=== ARCHIVO: ${file} | create ===\nexport const v = ${v};\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre ${file}. Esperado: existe.`;
const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple; verificación en verde.', findings: [], suggestedTests: [] });
function script(file: string, v = 1) {
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: 'Elabora el plan técnico', text: PLAN(file) }, { match: 'Implementa la historia', text: DEV(file, v) }, { match: 'Evalúa la implementación con la EVIDENCIA real', text: QA_OK }], markers: ['Nota del propietario'] }));
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what} · ${JSON.stringify(v).slice(0, 800)}`); await new Promise(r => setTimeout(r, 50)); v = await fn(); }
  return v;
}
const get = async (id: string) => (await inject('GET', `${W}/assignments/${id}`)).json();
const define = async (title: string, extra: Record<string, unknown> = {}) => {
  const r = await inject('POST', `${W}/projects/${project.id}/assignments`, { request: `Quiero ${title.toLowerCase()} directamente, sin crear historias.`, title, objective: `Que exista el archivo pedido (${title}) con su valor.`, criteria: ['El archivo existe con el valor pedido', 'typecheck, test y build en verde'], size: 'S', ...extra });
  assert.equal(r.statusCode, 201, r.body); return r.json();
};

test('encargo directo: definirlo no llama a la IA ni crea procesos; autorizarlo ejecuta el mismo pipeline (rama EN, Docker, QA, Gauntlet automático) y queda listo para revisar con evidencia, sin tocar el backlog', async () => {
  script('src/en1.ts');
  const backlogBefore = backlogRepo(S).list(project.id).length; const procsBefore = processesRepo(S).list(project.id).length;
  const a = await define('Crear el archivo EN uno');
  assert.match(a.code, /^EN-\d{3}$/); assert.equal(a.status, 'draft');
  assert.equal(calls().length, 0, 'definir no llama a la IA'); assert.equal(processesRepo(S).list(project.id).length, procsBefore, 'ni crea un proceso (nada que otra pantalla pueda ejecutar)');
  const prev = (await inject('GET', `${W}/assignments/${a.id}/authorization`)).json();
  assert.equal(prev.missing, null); assert.ok(prev.steps >= 3 && prev.agents.length >= 3); assert.equal(prev.gauntlet.mode, 'off', 'sin Evaluador en el proyecto: automático → verificación y QA de siempre'); assert.match(prev.gauntlet.auto.reason, /No hay un Evaluador Gauntlet/);
  assert.equal((await inject('POST', `${W}/assignments/${a.id}/authorize`, { budgetUsd: 2 })).statusCode, 400, 'sin autorización explícita no empieza');
  const r = await inject('POST', `${W}/assignments/${a.id}/authorize`, { authorized: true, budgetUsd: 2 });
  assert.equal(r.statusCode, 200, r.body);
  const x = await waitFor(() => get(a.id), y => !['running', 'pending_authorization'].includes(y.status), 'termina');
  assert.equal(x.status, 'ready_for_review', `${x.status}: ${x.reason}`);
  const p = processesRepo(S).get(x.processId)!;
  assert.equal(p.assignmentId, a.id); assert.equal(p.backlogItemId, null, 'sin historia');
  assert.equal(p.result!.applied!.branch, `portal-ia/${a.code.toLowerCase()}`, 'rama propia del encargo (nunca una rama común)');
  assert.ok(p.result!.applied!.worktree && fs.existsSync(p.result!.applied!.worktree), 'worktree aislado');
  assert.ok(['typecheck', 'test', 'build'].every(c => ranCommands.includes(c)), 'verificación en el sandbox');
  assert.equal(p.result!.review!.verdict, 'approved', 'QA con evidencia');
  assert.ok(x.outcome.verifications.every((v: any) => v.exitCode === 0) && x.outcome.verifications.length === 3); assert.equal(x.outcome.commit, p.result!.applied!.commit);
  assert.ok(x.outcome.agents.length >= 3 && x.outcome.calls >= 3);
  const doc = knowledgeRepo(S).list(project.id).find(d => d.id === x.knowledgeDocId)!;
  assert.match(doc.title, new RegExp(`Encargo ${a.code}`)); assert.ok(doc.body.includes('**Evidencia:** typecheck en verde'), doc.body); assert.match(doc.body, /sin integrar en main/);
  assert.equal(backlogRepo(S).list(project.id).length, backlogBefore, 'el backlog no cambió');
  // Aceptar exige la MISMA regla de cierre que una historia: aquí aún no está integrado.
  const acc = await inject('POST', `${W}/assignments/${a.id}/accept`, {});
  assert.equal(acc.statusCode, 409); assert.equal(acc.json().code, 'not_merged');
});

test('pedir cambios: queda la nota y la siguiente ejecución (autorizada aparte) la recibe con el resultado anterior; la anterior se conserva', async () => {
  script('src/en2.ts');
  const a = await define('Crear el archivo EN dos');
  assert.equal((await inject('POST', `${W}/assignments/${a.id}/authorize`, { authorized: true, budgetUsd: 2 })).statusCode, 200);
  const x = await waitFor(() => get(a.id), y => y.status === 'ready_for_review', 'listo');
  const ch = await inject('POST', `${W}/assignments/${a.id}/changes`, { note: 'Nota del propietario: el valor debe ser 2' });
  assert.equal(ch.statusCode, 200, ch.body); assert.equal(ch.json().status, 'changes_requested');
  script('src/en2.ts', 2);
  assert.equal((await inject('POST', `${W}/assignments/${a.id}/authorize`, { authorized: true, budgetUsd: 2 })).statusCode, 200);
  const y = await waitFor(() => get(a.id), z => z.processIds.length === 2 && !['running', 'pending_authorization'].includes(z.status), 'segunda ejecución');
  const p2 = processesRepo(S).get(y.processId)!;
  assert.match(p2.result!.iterationContext ?? '', /Nota del propietario: el valor debe ser 2/); assert.match(p2.result!.iterationContext ?? '', /Criterios de aceptación vigentes/);
  assert.ok(calls().some(c => c.markers?.includes('Nota del propietario')), 'la nota llega a los agentes');
  assert.ok(processesRepo(S).get(x.processId), 'la ejecución anterior se conserva');
});

test('una autorización que no puede empezar no deja procesos pendientes: el recién creado se cancela con el motivo y el encargo espera tu decisión', async () => {
  script('src/en3.ts');
  const a = await define('Crear el archivo EN tres');
  // El último informe del CLI dice «límite alcanzado» y aún no se renueva; con un equipo en la API no aplica, así que se
  // prueba con otro motivo determinista: ya hay un proceso en ejecución.
  const blocker = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'otro en marcha', estimatedUsd: 0, steps: [] });
  processesRepo(S).authorize(blocker.id, 1);
  try {
    const r = await inject('POST', `${W}/assignments/${a.id}/authorize`, { authorized: true, budgetUsd: 2 });
    assert.equal(r.statusCode, 409); assert.match(r.json().error, /Ya hay un proceso en ejecución/);
    const x = await get(a.id);
    assert.equal(x.status, 'draft', 'sin proceso creado: comprobado antes de crear nada');
    assert.equal(processesRepo(S).list(project.id).filter(p => p.assignmentId === a.id).length, 0);
  } finally { processesRepo(S).finish(blocker.id, 'cancelled', 'fin de la prueba'); }
});

test('el límite de la suscripción en el último informe del CLI impide empezar un equipo en Claude Code (sin llamar); reconocerlo lo permite', async () => {
  const { setGauntletless } = { setGauntletless: true }; void setGauntletless;
  saveUsageReport({ status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, utilization: 1, errorCode: null, rateLimitType: 'five_hour', windows: [], overage: false }, 'prueba');
  const gate = (await inject('GET', '/api/claude-code/usage')).json();
  assert.equal(gate.ok, false); assert.match(gate.reason, /alcanzó su límite.*se renueva hacia/);
  assert.equal(gate.report.rateLimitType, 'five_hour'); assert.ok(!('remaining' in gate.report), 'nunca se inventan «llamadas restantes»');
  assert.equal((await inject('POST', '/api/claude-code/usage/acknowledge', {})).statusCode, 403, 'reconocer exige autorización');
  const ack = (await inject('POST', '/api/claude-code/usage/acknowledge', { authorized: true })).json();
  assert.equal(ack.ok, true);
  acknowledgeUsageReport();
});

test('un reinicio a mitad no deja el encargo «en marcha»: su estado sale del proceso recuperado', async () => {
  script('src/en4.ts');
  const a = await define('Crear el archivo EN cuatro');
  const { prepareAssignment } = await import('../src/services/assignments.ts');
  const { process: p } = prepareAssignment(S, a.id);
  processesRepo(S).authorize(p.id, 1); // simula «en marcha» sin ejecutar (el Portal se reinicia aquí)
  assert.equal((await get(a.id)).status, 'running');
  recoverInterruptedProcesses(() => undefined);
  const x = await get(a.id);
  assert.notEqual(x.status, 'running'); assert.ok(['failed', 'needs_owner'].includes(x.status), x.status); assert.ok(x.reason);
});

test('acoplamiento: el motor accede al elemento de trabajo de un proceso solo por workItemOf/setWorkStatus (historia o encargo)', () => {
  const src = path.join(here, '..', 'src');
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.ts')) files.push(f); } };
  walk(src);
  const offenders: string[] = [];
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8'); const rel = path.relative(src, f).replace(/\\/g, '/');
    if (/backlogItemId!/.test(t)) offenders.push(`${rel}: backlogItemId!`);
    const engine = /services\/(story(Execution|Pipeline|Units|Integration|Merge)|externalCorrection|verification|gauntlet|assignments)\.ts$/.test(rel);
    if (engine && /backlog(Repo\([^)]*\))?\.setStatus\(/.test(t)) offenders.push(`${rel}: setStatus directo del backlog`);
  }
  assert.deepEqual(offenders, []);
});

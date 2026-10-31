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
const { agentsRepo, backlogRepo, knowledgeRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
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
  // Con la versión aplicada sin integrar, pedir cambios exige confirmar su descarte (como iterar una historia).
  const noConfirm = await inject('POST', `${W}/assignments/${a.id}/changes`, { note: 'Nota del propietario: el valor debe ser 2' });
  assert.equal(noConfirm.statusCode, 409); assert.equal(noConfirm.json().code, 'discard_confirmation_required');
  const firstBranch = processesRepo(S).get(x.processId)!.result!.applied!.branch;
  assert.notEqual(execSync(`git branch --list ${firstBranch}`, { cwd: repo }).toString().trim(), '', 'sin confirmar no se toca la rama');
  const ch = await inject('POST', `${W}/assignments/${a.id}/changes`, { note: 'Nota del propietario: el valor debe ser 2', discardApplied: true });
  assert.equal(ch.statusCode, 200, ch.body); assert.equal(ch.json().status, 'changes_requested');
  assert.equal(execSync(`git branch --list ${firstBranch}`, { cwd: repo }).toString().trim(), '', 'confirmado: la rama sin integrar se borró');
  script('src/en2.ts', 2);
  assert.equal((await inject('POST', `${W}/assignments/${a.id}/authorize`, { authorized: true, budgetUsd: 2 })).statusCode, 200);
  const y = await waitFor(() => get(a.id), z => z.processIds.length === 2 && !['running', 'pending_authorization'].includes(z.status), 'segunda ejecución');
  const p2 = processesRepo(S).get(y.processId)!;
  assert.match(p2.result!.iterationContext ?? '', /Nota del propietario: el valor debe ser 2/); assert.match(p2.result!.iterationContext ?? '', /Criterios de aceptación vigentes/);
  assert.ok(calls().some(c => c.markers?.includes('Nota del propietario')), 'la nota llega a los agentes');
  assert.ok(processesRepo(S).get(x.processId), 'la ejecución anterior se conserva');
  // Pedir cambios descartó la versión anterior no integrada (como iterar una historia): rechazada, sin worktree ni rama,
  // y ya no se integra; la nueva ejecución terminó (antes chocaba con la rama de la anterior).
  const old = processesRepo(S).get(x.processId)!; assert.ok(old.result!.rejected); assert.ok(!fs.existsSync(old.result!.applied!.worktree!));
  assert.equal(y.status, 'ready_for_review', `${y.status}: ${y.reason ?? ''}`);
  const merge = await inject('POST', `${W}/processes/${x.processId}/merge`, { authorized: true });
  assert.equal(merge.statusCode, 409, merge.body);
  // Rechazar el diff de la vigente: el encargo espera tu decisión (no se queda «listo» con «Aceptar»).
  if (y.status === 'ready_for_review') {
    assert.equal((await inject('POST', `${W}/processes/${y.processId}/reject`, {})).statusCode, 200);
    const z = await get(a.id); assert.equal(z.status, 'needs_owner'); assert.match(z.reason ?? '', /Rechazaste el diff/);
  }
});

test('una autorización que no puede empezar no deja procesos pendientes: el recién creado se cancela con el motivo y el encargo espera tu decisión', async () => {
  script('src/en3.ts');
  const a = await define('Crear el archivo EN tres');
  // Ya hay un proceso en ejecución: se comprueba ANTES de crear nada.
  const blocker = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title: 'otro en marcha', estimatedUsd: 0, steps: [] });
  processesRepo(S).authorize(blocker.id, 1);
  try {
    const r = await inject('POST', `${W}/assignments/${a.id}/authorize`, { authorized: true, budgetUsd: 2 });
    assert.equal(r.statusCode, 409); assert.match(r.json().error, /Ya hay un proceso en ejecución/);
    const x = await get(a.id);
    assert.equal(x.status, 'draft', 'sin proceso creado: comprobado antes de crear nada');
    assert.equal(processesRepo(S).list(project.id).filter(p => p.assignmentId === a.id).length, 0);
  } finally { processesRepo(S).finish(blocker.id, 'cancelled', 'fin de la prueba'); }
  // El equipo no puede ejecutar: el Desarrollador quedó en Claude Code y el conector se desactivó después (la API ya no
  // deja asignarlo así, por eso se simula en la base). Falla DESPUÉS de crear el proceso, que se cancela con el motivo:
  // no queda nada pendiente que otra pantalla pudiera ejecutar con otros límites.
  const dev = agentsRepo(S).list().find(ag => ag.projectId === project.id && /desarroll/i.test(ag.config.name))!;
  agentsRepo(S).updateConfig(dev.id, { ...dev.config, backend: 'claude-code' });
  try {
    const r = await inject('POST', `${W}/assignments/${a.id}/authorize`, { authorized: true, budgetUsd: 2 });
    assert.equal(r.statusCode, 409, r.body); assert.equal(r.json().code, 'backend_not_ready');
    const procsOfA = processesRepo(S).list(project.id).filter(p => p.assignmentId === a.id);
    assert.equal(procsOfA.length, 1); assert.equal(procsOfA[0].status, 'cancelled', 'el proceso recién creado se cancela'); assert.match(procsOfA[0].error ?? '', /No se inició/);
    const x = await get(a.id); assert.equal(x.status, 'needs_owner'); assert.match(x.reason ?? '', /No se inicia/);
    assert.equal(x.processId, null, 'la ejecución cancelada no pasa a ser la vigente (la siguiente iteración no pierde el contexto anterior)');
  } finally { agentsRepo(S).updateConfig(dev.id, { ...dev.config, backend: 'api' }); }
});

// Que un equipo en Claude Code no empiece ni llame a la CLI con el límite vigente se prueba en claude-code-execution.test.ts.
test('otra ejecución sobre una versión aplicada sin integrar exige confirmar su descarte antes de crear o pagar nada', async () => {
  script('src/en6.ts');
  const a = await define('Crear el archivo EN seis');
  // La primera ejecución se aplica pero su test falla y no hay correcciones: espera tu decisión con la versión aplicada.
  const run0 = sandboxDeps.run;
  sandboxDeps.run = async (wt, root, command, o) => { const r = await run0(wt, root, command, o); return command === 'test' ? { ...r, exitCode: 1, output: 'not ok 1 - falla' } : r; };
  let x: any;
  try {
    assert.equal((await inject('POST', `${W}/assignments/${a.id}/authorize`, { authorized: true, budgetUsd: 2, maxCorrections: 0 })).statusCode, 200);
    x = await waitFor(() => get(a.id), y => !['running', 'pending_authorization'].includes(y.status), 'primera ejecución');
  } finally { sandboxDeps.run = run0; }
  const p1 = processesRepo(S).get(x.processId)!;
  assert.ok(['needs_owner', 'failed'].includes(x.status), x.status); assert.ok(p1.result?.applied?.worktree && !p1.result.rejected && !p1.result.merged, 'versión aplicada sin integrar');
  const before = calls().length; const procs = () => processesRepo(S).list(project.id).filter(p => p.assignmentId === a.id).length; const n0 = procs();
  const pre = (await inject('GET', `${W}/assignments/${a.id}/authorization`)).json();
  assert.equal(pre.discardBranch, p1.result!.applied!.branch, 'la vista previa dice qué versión se descartaría');
  const r = await inject('POST', `${W}/assignments/${a.id}/authorize`, { authorized: true, budgetUsd: 2 });
  assert.equal(r.statusCode, 409, r.body); assert.equal(r.json().code, 'discard_confirmation_required');
  assert.equal(procs(), n0, 'sin confirmar no se crea ningún proceso'); assert.equal(calls().length, before, 'ni se paga nada');
  assert.ok(!processesRepo(S).get(p1.id)!.supersededBy && fs.existsSync(p1.result!.applied!.worktree!), 'la versión aplicada sigue intacta');
  script('src/en6.ts', 2);
  const ok = await inject('POST', `${W}/assignments/${a.id}/authorize`, { authorized: true, budgetUsd: 2, discardApplied: true });
  assert.equal(ok.statusCode, 200, ok.body);
  const y = await waitFor(() => get(a.id), z => z.processId !== p1.id && !['running', 'pending_authorization'].includes(z.status), 'segunda ejecución');
  assert.equal(y.status, 'ready_for_review', `${y.status}: ${y.reason ?? ''}`);
  const old = processesRepo(S).get(p1.id)!; assert.ok(old.result!.rejected, 'la anterior queda descartada'); assert.ok(!fs.existsSync(old.result!.applied!.worktree!));
});

test('el último informe de límites del CLI se muestra tal cual (sin cuotas inventadas) y reconocerlo exige tu autorización', async () => {
  saveUsageReport({ status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, utilization: 1, errorCode: null, rateLimitType: 'five_hour', windows: [], overage: false }, 'prueba');
  const gate = (await inject('GET', '/api/claude-code/usage')).json();
  assert.equal(gate.ok, false); assert.match(gate.reason, /alcanzó su límite.*se renueva hacia/);
  assert.equal(gate.report.rateLimitType, 'five_hour'); assert.ok(!('remaining' in gate.report), 'nunca se inventan «llamadas restantes»');
  assert.equal((await inject('POST', '/api/claude-code/usage/acknowledge', {})).statusCode, 403, 'reconocer exige autorización');
  const ack = (await inject('POST', '/api/claude-code/usage/acknowledge', { authorized: true })).json();
  assert.equal(ack.ok, true);
  // Uso adicional: bloquea aunque después llegue un informe normal; solo tu reconocimiento lo levanta.
  saveUsageReport({ status: 'allowed', resetsAt: null, utilization: 0.5, errorCode: null, rateLimitType: 'overage', windows: [], overage: true }, 'prueba');
  saveUsageReport({ status: 'allowed', resetsAt: null, utilization: 0.1, errorCode: null, rateLimitType: 'five_hour', windows: [], overage: false }, 'prueba');
  const g2 = (await inject('GET', '/api/claude-code/usage')).json(); assert.equal(g2.ok, false); assert.match(g2.reason, /overage/);
  acknowledgeUsageReport();
  assert.equal((await inject('GET', '/api/claude-code/usage')).json().ok, true);
  // Reconocido, el uso adicional de ESE episodio se acepta (las llamadas siguen); cuando deja de informarse, el episodio
  // termina y uno nuevo vuelve a exigir tu reconocimiento.
  const { overageAccepted } = await import('../src/services/claudeCode/usage.ts');
  saveUsageReport({ status: 'allowed', resetsAt: null, utilization: 0.6, errorCode: null, rateLimitType: 'overage', windows: [], overage: true }, 'prueba');
  assert.equal(overageAccepted(), true); assert.equal((await inject('GET', '/api/claude-code/usage')).json().ok, true);
  saveUsageReport({ status: 'allowed', resetsAt: null, utilization: 0.1, errorCode: null, rateLimitType: 'five_hour', windows: [], overage: false }, 'prueba');
  saveUsageReport({ status: 'allowed', resetsAt: null, utilization: 0.2, errorCode: null, rateLimitType: 'overage', windows: [], overage: true }, 'prueba');
  assert.equal(overageAccepted(), false); assert.equal((await inject('GET', '/api/claude-code/usage')).json().ok, false, 'un episodio nuevo exige reconocerlo otra vez');
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

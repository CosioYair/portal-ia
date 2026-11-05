import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * EN-008 · Pasos con «Falla» en el proceso de un encargo (sin historia): el servidor solo ofrece acciones que funcionan
 * (sin «Preguntar al equipo» ni «Convertir en tareas», que necesitan una historia), «Enviar feedback» crea la petición de
 * cambios del encargo (sin gasto, sin descartar lo integrado en main) y el panel no ignora ningún clic.
 * Proveedor simulado (0 USD), sandbox sustituido, repositorio sintético.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en008-'));
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
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { buildStoryFlow, isAssignmentProcess } = await import('../src/services/storyFlow.ts');

// ---------- Unidades: acciones ofrecidas ----------
const now = Date.now(); const at = (s: number) => new Date(now + s * 1000).toISOString();
const run = (command: string, exitCode: number, s: number) => ({ command, exitCode, output: '', startedAt: at(s), finishedAt: at(s), durationMs: 1000, isolation: 'docker' as const });
const step = (role: string, agentName: string) => ({ id: role, processId: 'p', position: 0, agentId: role, agentName, title: role, role, status: 'done', model: 'm', inputTokens: 10, outputTokens: 10, costUsd: 0.01, outputMd: 'x', error: null, startedAt: at(-60), finishedAt: at(-30) });
const applied = { branch: 'portal-ia/en-001', commit: 'abc1234', files: ['src/a.ts'], appliedAt: at(0), worktree: '/wt/p' };
const merged = { applied, verifications: [run('typecheck', 0, 4), run('test', 0, 5), run('build', 0, 6)], merged: { into: 'main', commit: 'm1', mergedAt: at(8) }, manualTest: { steps: ['Abre el encargo', 'Pulsa Enviar'], checks: [true, false], note: null } };
const proc = (over: any): any => ({ id: 'p', projectId: 'x', kind: 'story_execution', title: 't', status: 'done', budgetUsd: 1, estimatedUsd: 0.2, spentUsd: 0.1, inputTokens: 1, outputTokens: 1, createdAt: at(-100), authorizedAt: at(-90), startedAt: at(-90), finishedAt: at(-10), error: null, delegation: null,
  steps: [step('planner', 'Coordinador del Proyecto'), step('implementer', 'Desarrollador Full Stack'), step('reviewer', 'Especialista QA')],
  result: { plan: null, implementationSummary: 'x', changes: [{ path: 'src/a.ts', action: 'modify', content: '', diff: '', before: 1, after: 1 }], verifyCommands: [], review: { approve: true, issues: [], suggestedTests: [], summary: 'Bien.' }, ...merged }, ...over });
const failedSteps = [{ index: 1, text: 'Pulsa Enviar', comment: 'El botón no hace nada' }];

test('isAssignmentProcess: encargo = assignmentId sin backlogItemId', () => {
  assert.equal(isAssignmentProcess({ assignmentId: 'a1', backlogItemId: null } as any), true);
  assert.equal(isAssignmentProcess({ assignmentId: null, backlogItemId: 'b' } as any), false);
  assert.equal(isAssignmentProcess({ assignmentId: 'a1', backlogItemId: 'b' } as any), false, 'con historia sigue el flujo de historias');
});

test('encargo con prueba manual fallida: «Enviar feedback» sí; «Preguntar» y «Convertir en tareas» no se ofrecen', () => {
  const f = buildStoryFlow(proc({ title: 'EN-001 · t', backlogItemId: null, assignmentId: 'a1' }), { failedSteps });
  assert.equal(f.issue?.kind, 'manual_failed');
  const ids = f.actions.map(a => a.id);
  assert.ok(ids.includes('request_fix'), ids.join(','));
  assert.ok(!ids.includes('ask_team'), 'sin chat de historia en un encargo');
  assert.ok(!ids.includes('tasks_from_issue'), 'sin tareas de historia en un encargo');
  const fb = f.actions.find(a => a.id === 'request_fix')!;
  assert.equal(fb.label, 'Enviar feedback al equipo (nueva iteración)');
  assert.ok(fb.requires.includes('confirmation'), 'pide confirmación antes de enviar');
  assert.ok(f.issue!.details.some(d => /El botón no hace nada/.test(d.text) || /Pulsa Enviar/.test(d.text)), 'los pasos fallidos van en los detalles');
});

test('la misma situación en una historia no cambia: sigue ofreciendo las tres acciones', () => {
  const f = buildStoryFlow(proc({ title: 'HU-1 · t', backlogItemId: 'b', assignmentId: null }), { failedSteps });
  assert.equal(f.issue?.kind, 'manual_failed');
  assert.equal(f.actions[0].label, 'Enviar feedback al equipo (nueva iteración)');
  const ids = f.actions.map(a => a.id);
  for (const id of ['request_fix', 'ask_team', 'tasks_from_issue'] as const) assert.ok(ids.includes(id), `${id} en ${ids.join(',')}`);
});

// ---------- Cableado del panel ----------
test('StoryFlowPanel: el feedback de un encargo usa api.requestAssignmentChanges y ninguna acción ignora el clic', () => {
  const src = fs.readFileSync(path.join(here, '..', '..', 'web', 'src', 'components', 'StoryFlowPanel.tsx'), 'utf8');
  assert.match(src, /api\.requestAssignmentChanges\(/);
  assert.match(src, /needsStory\(/, 'guarda común con aviso visible');
  assert.match(src, /setErr\(NEEDS_STORY\)/);
  assert.doesNotMatch(src, /if \(!itemId\) return;/, 'ningún clic se ignora en silencio');
  assert.doesNotMatch(src, /&& itemId\) \{/, 'ninguna acción condicionada a itemId sin aviso');
});

// ---------- API: feedback de un encargo integrado en main ----------
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en008-repo-'));
const uniq = `en008-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/base.ts'), 'export const base = 0;\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node -e ""', test: 'node -e ""', build: 'node -e ""' } }, null, 2));
fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: uniq, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.0' } } }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { await app.close(); });
const inject = (method: string, u: string, payload?: unknown) => app.inject({ method: method as any, url: u, payload: payload as any });
sandboxDeps.detect = async () => ({ available: 'docker', docker: true, wsl: false, detail: 'simulado', checkedAt: new Date().toISOString() });
sandboxDeps.run = async (_wt, _root, command) => { const t = new Date().toISOString(); return { command, exitCode: 0, output: `${command} ok`, startedAt: t, finishedAt: new Date().toISOString(), durationMs: 5, isolation: 'docker' }; };

const PLAN = JSON.stringify({ summary: 'Crear src/en8.ts', tasks: ['Crear src/en8.ts'], filesToRead: [], filesToChange: ['src/en8.ts'], acceptance: ['src/en8.ts existe'], risks: [] });
const DEV = '=== RESUMEN ===\nCrea src/en8.ts.\n=== ARCHIVO: src/en8.ts | create ===\nexport const v = 1;\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nListo.\n=== PRUEBA MANUAL ===\n1. Abre src/en8.ts. Esperado: existe.';
const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple; verificación en verde.', findings: [], suggestedTests: [] });
resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
fs.writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: 'Elabora el plan técnico', text: PLAN }, { match: 'Implementa la historia', text: DEV }, { match: 'Evalúa la implementación con la EVIDENCIA real', text: QA_OK }] }));
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length : 0;
const get = async (id: string) => (await inject('GET', `${W}/assignments/${id}`)).json();
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what} · ${JSON.stringify(v).slice(0, 800)}`); await new Promise(r => setTimeout(r, 50)); v = await fn(); }
  return v;
}

test('API · enviar feedback de un encargo integrado en main: changes_requested con la nota, sin descartar, sin proceso autorizado y sin gasto', async () => {
  const d = await inject('POST', `${W}/projects/${project.id}/assignments`, { request: 'Quiero crear el archivo EN ocho directamente, sin crear historias.', title: 'Crear el archivo EN ocho', objective: 'Que exista src/en8.ts con su valor.', criteria: ['El archivo existe', 'typecheck, test y build en verde'], size: 'S' });
  assert.equal(d.statusCode, 201, d.body); const a = d.json();
  assert.equal((await inject('POST', `${W}/assignments/${a.id}/authorize`, { authorized: true, budgetUsd: 2 })).statusCode, 200);
  const x = await waitFor(() => get(a.id), y => !['running', 'pending_authorization'].includes(y.status), 'termina');
  assert.equal(x.status, 'ready_for_review', `${x.status}: ${x.reason}`);
  const m = await inject('POST', `${W}/processes/${x.processId}/merge`, { authorized: true });
  assert.equal(m.statusCode, 200, m.body);
  const p1 = processesRepo(S).get(x.processId)!; assert.ok(p1.result?.merged, 'integrado en main');
  assert.equal(p1.assignmentId, a.id); assert.equal(p1.backlogItemId, null);

  const procsOf = () => processesRepo(S).list(project.id).filter(p => p.assignmentId === a.id);
  const spent = () => procsOf().reduce((s, p) => s + (p.spentUsd ?? 0), 0);
  const n0 = procsOf().length; const usd0 = spent(); const calls0 = calls();
  const note = 'La prueba de aceptación falló en 1 paso(s)\n2. Pulsa Enviar\n   Comentario: El botón no hace nada';
  const ch = await inject('POST', `${W}/assignments/${a.id}/changes`, { note });
  assert.equal(ch.statusCode, 200, ch.body);
  const y = await get(a.id);
  assert.equal(y.status, 'changes_requested', `${y.status}: ${y.reason ?? ''}`);
  assert.match(y.iterationNote ?? '', /El botón no hace nada/, 'la nota lleva los pasos fallidos y tus comentarios');
  assert.ok(!processesRepo(S).get(p1.id)!.result!.rejected, 'no se descarta nada: lo integrado sigue en main');
  assert.equal(calls(), calls0, 'sin llamadas a la IA'); assert.equal(spent(), usd0, 'sin gasto');
  assert.ok(procsOf().length >= n0, 'nada se borra');
  assert.ok(!procsOf().some(p => p.id !== p1.id && ['running', 'authorized'].includes(p.status)), 'ninguna ejecución autorizada ni en marcha: queda pendiente de tu autorización');
  const pre = (await inject('GET', `${W}/assignments/${a.id}/authorization`)).json();
  assert.ok(!pre.discardBranch, 'la siguiente ejecución parte de main sin descartar ninguna versión');
});

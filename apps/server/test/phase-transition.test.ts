import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Nueva etapa operativa: el trabajo activo se archiva (reversible) sin perder conocimiento. Datos, repositorio y
 * proveedor simulados (0 USD). Comprueba: qué bloquea, qué se archiva, que TODO lo demás queda idéntico fila a fila,
 * que la bandeja, el backlog y el asistente quedan limpios, que los agentes reciben la línea base (arquitectura, flujo,
 * sandbox, worktrees, iteración, activación, organización, lecciones y limitaciones), que reiniciar no restaura nada,
 * que los ids no se reutilizan, que la síntesis antigua no vuelve a llenar el backlog, y restaurar / revertir.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-phase-'));
process.env.PORTAL_DATA_DIR = dataDir;
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(dataDir, 'mock-script.json'); const logPath = path.join(dataDir, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { platform, providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { backlogRepo, knowledgeRepo, processesRepo, projectsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem, importBacklogFromKnowledge } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { createDelegation, runDelegation } = await import('../src/services/delegation.ts');
const { assistantRepo, chat } = await import('../src/services/assistant.ts');
const { lessonsRepo } = await import('../src/services/lessons.ts');
const { threadRepo } = await import('../src/services/storyThread.ts');

const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-phase-repo-'));
fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
// Una rama de historia con un commit fuera de main (debe conservarse, sin integrar ni borrar).
execSync('git checkout -q -b portal-ia/hu-900 && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m Experimento && git checkout -q main', { cwd: repo });
projectsRepo(S).setRepository(project.id, repo, 'main');

const PLAN = '{"summary":"x","tasks":["t"],"filesToRead":["src/a.ts"],"filesToChange":["src/a.ts"],"acceptance":["a"],"risks":[]}';
const IMPL = '=== RESUMEN ===\nCambia a.\n=== ARCHIVO: src/a.ts | patch ===\n<<<< BUSCAR\nexport const a = 1;\n==== REEMPLAZAR\nexport const a = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nNada.\n=== PRUEBA MANUAL ===\n1. Abre X. Esperado: Y.';
const QA = JSON.stringify({ approve: true, summary: 'Bien', issues: [], suggestedTests: [] });
/** Frases de la línea base que cada agente debe recibir (los 8 temas del encargo + etapa y organización). */
const MARKERS = {
  etapa: 'Etapa vigente: «Portal IA — Inicio de operación organizada»',
  implementacion: 'El proyecto SÍ tiene implementación',
  arquitectura: 'Monorepo npm (workspaces)',
  flujo: 'Flujo de desarrollo (cómo se trabaja desde el Portal)',
  sandbox: 'portal-ia-sandbox:1',
  worktrees: '<repo>-worktrees/<proceso>',
  iteracion: 'Recorrido guiado de 9 etapas',
  activacion: 'integrar no es activar',
  organizacion: 'Organización actual (agentes, papeles y jerarquía)',
  leccion: 'LECCION-VALIDADA-PRUEBA',
  limitaciones: 'No hay editor de conflictos de merge'
};
const setScript = () => fs.writeFileSync(scriptPath, JSON.stringify({ markers: [...Object.values(MARKERS), 'LECCION-PENDIENTE-PRUEBA', 'HU-001 · Plan antiguo'], rules: [{ match: 'plan técnico', text: PLAN }, { match: 'Implementa la historia', text: IMPL }, { match: 'Revisa los cambios propuestos', text: QA }] }));
setScript();
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const clearLog = () => { try { fs.unlinkSync(logPath); } catch { /* sin registro */ } };
const app = await buildApp();
const json = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: any) => { const r = await app.inject({ method, url, payload }); return { status: r.statusCode, body: r.body ? r.json() : null }; };

// ---------- Etapa experimental sembrada ----------
knowledgeRepo(S).add({ projectId: project.id, title: 'Síntesis y backlog priorizado', body: '| ID | Título | Criterio |\n|---|---|---|\n| HU-001 | Plan antiguo uno | c1 |\n| HU-002 | Plan antiguo dos | c2 |\n| HU-007 | Plan antiguo siete | c7 |', authorAgentId: null, authorAgentName: 'Coordinador del Proyecto', processId: null });
assert.equal(importBacklogFromKnowledge(S, project.id).imported, 3);
const done = addManualItem(S, project.id, { title: 'Historia ya integrada' }); backlogRepo(S).setStatus(done.id, 'done');
const exec = addManualItem(S, project.id, { title: 'Historia con diff sin revisar' });
const pExec = createStoryProcess(S, project.id, exec.id); processesRepo(S).authorize(pExec.id, 1);
await runStory(S, pExec.id, () => undefined, () => false);
assert.equal(processesRepo(S).get(pExec.id)!.status, 'done');
const waiting = addManualItem(S, project.id, { title: 'Historia esperando autorización' });
const pWait = createStoryProcess(S, project.id, waiting.id);
const deleg = createDelegation(S, project.id, 'pj-coordinador', 'Replantea el backlog de la etapa experimental');
processesRepo(S).setDelegation(deleg.id, { ...processesRepo(S).get(deleg.id)!.delegation!, backlogOps: [{ op: 'add', title: 'Propuesta antigua', criterion: 'x', reason: 'r' } as any], opsApplied: null });
processesRepo(S).finish(deleg.id, 'done');
const lessonBase = { projectId: project.id, role: 'implementer', tags: [], version: 1, parentId: null, detector: 'manual', evidence: { processId: null, processTitle: null, stepId: null, agentId: null, agentName: null, file: null, detail: 'x', at: new Date().toISOString() }, rootCause: null, correctiveAction: null, source: 'owner', promotedTo: null };
lessonsRepo(S).insert({ ...lessonBase, status: 'validated', title: 'LECCION-VALIDADA-PRUEBA', lessonText: 'Usa parches pequeños y relee el archivo antes de cambiarlo.' } as any);
lessonsRepo(S).insert({ ...lessonBase, status: 'detected', title: 'LECCION-PENDIENTE-PRUEBA', lessonText: null } as any);
threadRepo(S).add({ backlogItemId: exec.id, role: 'owner', agentId: null, agentName: null, content: 'Conversación de la etapa experimental', processId: null, costUsd: 0, tokens: 0, proposals: null });
assistantRepo.add({ role: 'assistant', content: 'Propongo ejecutar la historia en espera.', actions: [{ type: 'propose_execution', status: 'pending', label: 'Ejecutar', processId: pWait.id, workspaceSlug: S, projectId: project.id }], attachments: [], tokensIn: 0, tokensOut: 0, costUsd: 0, model: null });

/** Instantánea fila a fila de TODA la base del espacio y de la plataforma (sin las columnas del archivo). */
function snapshot() {
  const out: Record<string, string> = {};
  for (const [name, db] of [['ws', workspaceDb(S)], ['platform', platform]] as const) {
    for (const t of (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as any[]).map(r => r.name as string)) {
      const rows = (db.prepare(`SELECT * FROM ${t}`).all() as any[]).map(r => { const { archived_at, archive_id, ...rest } = r; return JSON.stringify(rest); }).sort();
      out[`${name}.${t}`] = rows.join('\n');
    }
  }
  return out;
}

let transitionId = '';
let before: Record<string, string> = {};

test('vista previa: lee sin cambiar nada; un proceso en ejecución bloquea; sin autorización no se inicia', async () => {
  const s0 = snapshot();
  const pv = await json('GET', `${W}/projects/${project.id}/phase/preview`);
  assert.equal(pv.status, 200);
  assert.equal(pv.body.stories.total, 6); assert.equal(pv.body.processes.total, 3);
  assert.deepEqual(pv.body.pendingDecisions.map((d: any) => d.kind).sort(), ['apply_diff', 'backlog_proposal', 'process_authorization']);
  assert.deepEqual(pv.body.git.unmergedBranches, [{ name: 'portal-ia/hu-900', ahead: 1 }]);
  assert.equal(pv.body.canStart, true);
  assert.equal(pv.body.preserved.lessonsValidated, 1); assert.equal(pv.body.preserved.lessonsPending, 1);
  assert.match(pv.body.baselinePreview, /El backlog activo empieza vacío/);
  assert.deepEqual(snapshot(), s0, 'la vista previa no escribe nada');

  // Un proceso en ejecución bloquea (el propietario decide cancelarlo); nada se archiva.
  const busy = addManualItem(S, project.id, { title: 'Historia en ejecución' });
  // «En ejecución» en la base pero sin ejecución viva en este servidor: como tras un reinicio a mitad de una historia.
  const pRun = createStoryProcess(S, project.id, busy.id); processesRepo(S).authorize(pRun.id, 1); backlogRepo(S).setStatus(busy.id, 'in_progress', pRun.id);
  const blocked = await json('POST', `${W}/projects/${project.id}/phase`, { authorized: true });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'running_processes'); assert.equal(blocked.body.running[0].id, pRun.id);
  assert.equal((await json('GET', `${W}/projects/${project.id}/backlog`)).body.length, 7, 'nada archivado');
  assert.equal(blocked.body.running[0].orphan, true, 'se reconoce como interrumpido (huérfano)');
  // Decisión del propietario: cancelar. Un huérfano se cierra al momento (nadie leería la marca de cancelación).
  const cancelled = await json('POST', `${W}/processes/${pRun.id}/cancel`);
  assert.equal(cancelled.body.status, 'cancelled'); assert.match(cancelled.body.error, /Interrumpido/);
  assert.equal(backlogRepo(S).get(busy.id)!.status, 'pending', 'la historia vuelve a pendiente');
  assert.ok(cancelled.body.steps.every((st: any) => st.status !== 'running' && st.status !== 'pending'));

  const noAuth = await json('POST', `${W}/projects/${project.id}/phase`, {});
  assert.equal(noAuth.status, 400); assert.equal(noAuth.body.code, 'authorization_required');
  assert.equal((await json('GET', `${W}/projects/${project.id}/phase`)).body.current, null);
});

test('iniciar la etapa: backlog, actividad y bandeja vacíos; todo lo demás idéntico fila a fila; git intacto', async () => {
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const branchesBefore = execFileSync('git', ['branch', '--list'], { cwd: repo, encoding: 'utf8' });
  before = snapshot();
  const r = await json('POST', `${W}/projects/${project.id}/phase`, { authorized: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  transitionId = r.body.id;
  assert.equal(r.body.name, 'Portal IA — Inicio de operación organizada');
  assert.equal(r.body.summary.archivedStories.length, 7); assert.equal(r.body.summary.archivedProcesses.length, 4);
  assert.equal(r.body.summary.clearedDecisions.length, 3);

  // Flujo activo limpio
  assert.deepEqual((await json('GET', `${W}/projects/${project.id}/backlog`)).body, []);
  assert.deepEqual((await json('GET', `${W}/projects/${project.id}/processes`)).body, []);
  assert.deepEqual((await json('GET', `${W}/inbox`)).body, []);
  const live = (await json('GET', '/api/assistant')).body.messages.flatMap((m: any) => m.actions);
  assert.equal(live.filter((a: any) => a.status === 'pending').length, 0, 'ninguna propuesta antigua por autorizar en el chat');
  assert.match(live.find((a: any) => a.processId === pWait.id).live.phase, /Archivado/);

  // Nada se borró ni cambió: solo las columnas del archivo, +1 documento (línea base), +1 transición y la auditoría de la política.
  const after = snapshot();
  for (const k of Object.keys(before)) {
    if (k === 'ws.knowledge' || k === 'ws.execution_history' || k === 'ws.phase_transitions') continue;
    assert.equal(after[k], before[k], `${k} intacta`);
  }
  assert.equal(after['ws.knowledge'].split('\n').length, before['ws.knowledge'].split('\n').length + 1);
  const added = after['ws.execution_history'].split('\n').filter(l => !before['ws.execution_history'].split('\n').includes(l));
  assert.ok(added.length >= 1 && added.every(l => /policy:phase_transition:granted/.test(l)), 'solo se añade la auditoría de la política');
  assert.ok(after['ws.phase_transitions'], 'transición registrada');
  assert.equal(stored('assistant_messages'), 1, 'el mensaje del asistente no se modifica');

  // Archivado, no borrado; consultable
  const arc = (await json('GET', `${W}/projects/${project.id}/archive`)).body;
  assert.equal(arc.stories.length, 7); assert.equal(arc.processes.length, 4);
  assert.ok(arc.stories.every((s: any) => s.archivedAt && s.archiveId === transitionId));
  const story = (await json('GET', `${W}/stories/${exec.id}`)).body;
  assert.equal(story.messages.length, 1, 'la conversación de la historia sigue ahí'); assert.equal(story.item.archivedAt !== null, true);
  assert.equal(story.lastProcess.guidance.phase, 'Archivado (etapa anterior)'); assert.equal(story.lastProcess.guidance.flow, undefined);

  // git: ni commits, ni ramas, ni merges
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), headBefore);
  assert.equal(execFileSync('git', ['branch', '--list'], { cwd: repo, encoding: 'utf8' }), branchesBefore);

  // Línea base versionada, con procedencia y sin promover lo no validado
  const doc = knowledgeRepo(S).get(r.body.baselineDocId)!;
  assert.match(doc.title, /^Línea base · Portal IA — Inicio de operación organizada/);
  assert.equal(doc.version, 1);
  assert.ok(doc.body.includes(MARKERS.leccion), 'lección validada incluida');
  assert.ok(!doc.body.includes('LECCION-PENDIENTE-PRUEBA'), 'una lección sin validar no entra como conocimiento');
  assert.match(doc.body, /portal-ia\/hu-900 \(\+1\)/);
  assert.match(doc.body, /\(C\) Registro histórico[\s\S]*no garantiza qué está implementado/);
});

function stored(table: string) { return Number((platform.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n); }

test('lo archivado no admite acciones (409) ni se puede ejecutar; la síntesis antigua no vuelve a llenar el backlog', async () => {
  assert.equal((await json('POST', `${W}/processes/${pWait.id}/authorize`, { budgetUsd: 1, authorized: true })).body.code, 'archived');
  assert.equal((await json('POST', `${W}/processes/${pExec.id}/apply`, { authorized: true })).status, 409);
  assert.equal((await json('POST', `${W}/processes/${deleg.id}/backlog-ops/apply`, { authorized: true })).status, 409);
  assert.equal((await json('POST', `${W}/projects/${project.id}/backlog/${waiting.id}/execute`, {})).status, 409);
  assert.equal((await json('POST', `${W}/stories/${exec.id}/iterate`, {})).status, 409);
  assert.equal((await json('PATCH', `${W}/backlog/${exec.id}`, { title: 'otro' })).status, 409);
  assert.equal((await json('POST', `${W}/inbox/apply_diff/${pExec.id}/decision`, { verdict: 'approve' })).status >= 400, true);
  const imp = await json('POST', `${W}/projects/${project.id}/backlog/import`, {});
  assert.equal(imp.body.source, null, 'la síntesis de la etapa anterior no cuenta'); assert.equal(imp.body.imported ?? 0, 0);
  assert.deepEqual((await json('GET', `${W}/projects/${project.id}/backlog`)).body, []);
});

test('los agentes y el asistente reciben la línea base (los 8 temas); una historia nueva no reutiliza ids ni restaura nada', async () => {
  // Historia nueva: numeración tras la mayor de TODAS (también las archivadas).
  const maxOld = Math.max(...backlogRepo(S).listAll(project.id).map(b => parseInt(b.storyId.replace(/\D+/g, ''), 10)));
  const created = await json('POST', `${W}/projects/${project.id}/backlog`, { title: 'Primera historia de la etapa' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.storyId, `HU-${String(maxOld + 1).padStart(3, '0')}`);
  assert.ok(!backlogRepo(S).listArchived(project.id).some(b => b.storyId === created.body.storyId));

  clearLog();
  const p = createStoryProcess(S, project.id, created.body.id); processesRepo(S).authorize(p.id, 1);
  await runStory(S, p.id, () => undefined, () => false);
  const planCall = calls().find(c => c.rule === 'plan técnico')!;
  for (const [k, m] of Object.entries(MARKERS)) assert.ok(planCall.markers.includes(m), `historia · el planificador recibe «${k}»`);
  assert.ok(!planCall.markers.includes('HU-001 · Plan antiguo'), 'la síntesis antigua no es la dirección');
  // Crear y ejecutar un proceso nuevo no restaura lo archivado
  assert.deepEqual((await json('GET', `${W}/projects/${project.id}/backlog`)).body.map((b: any) => b.storyId), [created.body.storyId]);
  assert.equal(backlogRepo(S).listArchived(project.id).length, 7);

  clearLog();
  const d = createDelegation(S, project.id, 'pj-coordinador', 'Evalúa si la organización actual de agentes es suficiente para la nueva etapa');
  processesRepo(S).authorize(d.id, 2);
  await runDelegation(S, d.id, () => undefined, () => false).catch(() => undefined);
  const first = calls()[0];
  assert.ok(first, 'el encargo llamó al proveedor simulado');
  for (const [k, m] of Object.entries(MARKERS)) assert.ok(first.markers.includes(m), `encargo · el Coordinador recibe «${k}»`);
  assert.ok(!first.markers.includes('LECCION-PENDIENTE-PRUEBA'));

  clearLog();
  await chat('¿Qué tiene ya implementado el Portal y por dónde empezamos?');
  const a = calls()[0];
  for (const k of ['etapa', 'implementacion', 'organizacion', 'leccion'] as const) assert.ok(a.markers.includes(MARKERS[k]), `asistente · recibe «${k}»`);

  clearLog();
  const ask = await json('POST', `${W}/stories/${created.body.id}/messages`, { text: '¿Cómo se verifica esto en el sandbox?', ask: true, authorized: true, maxUsd: 0.5 });
  assert.equal(ask.status, 201, JSON.stringify(ask.body));
  assert.ok(calls()[0].markers.includes(MARKERS.etapa) && calls()[0].markers.includes(MARKERS.implementacion), 'chat de la historia · recibe la etapa');
});

test('reiniciar el Portal (otro proceso, mismos datos) no recrea el backlog ni restaura lo archivado', async () => {
  const activeBefore = (await json('GET', `${W}/projects/${project.id}/backlog`)).body.map((b: any) => b.storyId);
  const serverSrc = fileURLToPath(new URL('../src/', import.meta.url));
  const child = path.join(dataDir, 'restart-check.mts');
  fs.writeFileSync(child, `const { buildApp } = await import(${JSON.stringify(pathToFileURL(path.join(serverSrc, 'app.ts')).href)});
const { runBacklogMaintenance } = await import(${JSON.stringify(pathToFileURL(path.join(serverSrc, 'services/backlogMaintenance.ts')).href)});
const app = await buildApp(); runBacklogMaintenance(() => undefined);
const b = await app.inject({ method: 'GET', url: '/api/workspaces/${S}/projects/${project.id}/backlog' });
const a = await app.inject({ method: 'GET', url: '/api/workspaces/${S}/projects/${project.id}/archive' });
const ph = await app.inject({ method: 'GET', url: '/api/workspaces/${S}/projects/${project.id}/phase' });
console.log('RESULTADO:' + JSON.stringify({ active: b.json().map(x => x.storyId), archived: a.json().stories.length, phase: ph.json().current?.name ?? null }));
await app.close(); process.exit(0);
`);
  const out = execFileSync(process.execPath, ['--import', 'tsx', child], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, LOG_LEVEL: 'silent' }, encoding: 'utf8' });
  // La línea del resultado lleva prefijo: con registros activos (p. ej. la verificación dentro del sandbox) puede no ser la última.
  const line = out.split('\n').find(l => l.startsWith('RESULTADO:'));
  assert.ok(line, `el proceso hijo no devolvió resultado:\n${out.slice(-2000)}`);
  const r = JSON.parse(line.slice('RESULTADO:'.length));
  assert.deepEqual(r.active, activeBefore); assert.equal(r.archived, 7); assert.equal(r.phase, 'Portal IA — Inicio de operación organizada');
});

test('restaurar una historia (autorizado) y revertir la etapa devuelven exactamente lo archivado', async () => {
  assert.equal((await json('POST', `${W}/backlog/${exec.id}/restore`, {})).status, 400, 'restaurar exige autorización');
  const rs = await json('POST', `${W}/backlog/${exec.id}/restore`, { authorized: true });
  assert.equal(rs.status, 200); assert.equal(rs.body.archivedAt, null); assert.match(rs.body.description, /Restaurada desde el archivo/);
  assert.ok((await json('GET', `${W}/projects/${project.id}/processes`)).body.some((p: any) => p.id === pExec.id), 'su proceso vuelve con ella');
  assert.ok((await json('GET', `${W}/inbox`)).body.some((d: any) => d.processId === pExec.id), 'y su decisión pendiente también');

  assert.equal((await json('POST', `${W}/projects/${project.id}/phase/${transitionId}/revert`, {})).status, 400);
  const rv = await json('POST', `${W}/projects/${project.id}/phase/${transitionId}/revert`, { authorized: true, reason: 'prueba' });
  assert.equal(rv.status, 200); assert.ok(rv.body.revertedAt);
  const active = (await json('GET', `${W}/projects/${project.id}/backlog`)).body;
  assert.equal(active.length, 8, '7 restauradas + la nueva de la etapa');
  assert.equal(backlogRepo(S).listArchived(project.id).length, 0);
  assert.equal((await json('GET', `${W}/projects/${project.id}/phase`)).body.current, null);
  assert.ok(knowledgeRepo(S).list(project.id).some(d => d.title.startsWith('Línea base')), 'la línea base queda en Conocimiento');
  await app.close();
});

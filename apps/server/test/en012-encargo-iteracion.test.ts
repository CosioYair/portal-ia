import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * EN-012 · Feedback a encargos: la nueva iteración aparece y espera autorización; una sola regla de «pendiente» para
 * encargos integrados (Asistente, Decisiones y tarjeta). Sin IA (proveedor simulado, 0 USD), repositorio git temporal;
 * los procesos se crean directamente en la base (el motor no se ejecuta).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en012-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;
const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_LOG = logPath;
const here = path.dirname(fileURLToPath(import.meta.url));

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, assignmentPendingState, ASSIGNMENT_MERGED_PENDING_LABEL, ASSIGNMENT_ITERATION_PENDING_LABEL } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { assignmentsRepo } = await import('../src/db/assignments.ts');
const { assistantRepo } = await import('../src/services/assistant.ts');
const { createAssignment, acceptAssignment, syncAssignment, assignmentView, prepareAssignment, cancelAssignment, requestAssignmentChanges, onAssignmentResult } = await import('../src/services/assignments.ts');
const { assignmentPendingItems } = await import('../src/services/inbox.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];

// Repositorio temporal: los descartes nunca tocan el repositorio real.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en012-repo-'));
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'en012', version: '1.0.0', private: true }, null, 2));
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
const base = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim();
projectsRepo(S).setRepository(project.id, repo, 'main');

const app = await buildApp();
after(async () => { await app.close(); });
const inject = (method: string, u: string, payload?: unknown) => app.inject({ method: method as any, url: u, payload: payload as any });

// La conversación del encargo: se capturan los mensajes que el servidor publica (sin IA).
const posted: { conversationId: string; markdown: string }[] = [];
onAssignmentResult((conversationId, markdown) => { posted.push({ conversationId, markdown }); });

const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length : 0;
const now = () => new Date().toISOString();
const tested = { manualTest: { steps: ['Abrir el proceso y comprobar el cambio'], checks: [true], note: null } };
const resultOf = (merged: boolean, extra: Record<string, unknown> = {}) => ({
  plan: null, implementationSummary: 'simulado', changes: [], verifyCommands: [], review: null, verifications: [],
  applied: { branch: `portal-ia/en012-${Math.random().toString(36).slice(2, 8)}`, commit: base, files: ['f.txt'], appliedAt: now(), ...(merged ? {} : { worktree: path.join(os.tmpdir(), 'en012-wt-inexistente') }) },
  ...(merged ? { merged: { into: 'main', commit: base, mergedAt: now() } } : {}), ...extra
}) as any;

/** Encargo con un proceso terminado como vigente (integrado o solo aplicado en su rama); queda listo para revisar. */
function mkAssignment(title: string, merged: boolean) {
  const a = createAssignment(S, project.id, { request: `Quiero ${title}`, title, objective: `Que ${title} quede hecho.`, criteria: ['Queda hecho', 'typecheck, test y build en verde'], conversationId: `conv-${title.replace(/\W+/g, '-')}` });
  const p = processesRepo(S).create({ projectId: project.id, kind: 'story_execution', title, estimatedUsd: 0, steps: [], assignmentId: a.id } as any);
  assignmentsRepo(S).update(a.id, x => { x.processId = p.id; x.processIds = [p.id]; x.status = 'running'; });
  processesRepo(S).authorize(p.id, 1);
  processesRepo(S).setResult(p.id, resultOf(merged, tested));
  processesRepo(S).finish(p.id, 'done', null as any);
  syncAssignment(S, a.id);
  return { a: assignmentsRepo(S).get(a.id)!, p: processesRepo(S).get(p.id)! };
}
const procsOf = (id: string) => processesRepo(S).list(project.id).filter(p => p.assignmentId === id);
const spent = (id: string) => procsOf(id).reduce((s, p) => s + (p.spentUsd ?? 0), 0);

test('(a) feedback a un encargo integrado: nueva iteración visible, sin proceso, 0 USD y aviso en la conversación', async () => {
  const { a, p } = mkAssignment('iterar integrado', true);
  assert.equal(a.status, 'ready_for_review', a.reason ?? '');
  const n0 = procsOf(a.id).length; const usd0 = spent(a.id); const calls0 = calls(); const posted0 = posted.length;
  const note = 'El botón de enviar no muestra confirmación';
  const r = await inject('POST', `${W}/assignments/${a.id}/changes`, { note });
  assert.equal(r.statusCode, 200, r.body);
  const v = r.json();
  assert.equal(v.status, 'changes_requested');
  assert.ok(v.nextIteration, 'la respuesta trae la iteración siguiente');
  assert.equal(v.nextIteration.note, note); assert.equal(v.nextIteration.merged, true);
  assert.equal(v.pending.kind, 'awaiting_iteration_authorization');
  assert.equal(v.pending.label, ASSIGNMENT_ITERATION_PENDING_LABEL);
  assert.match(v.pending.where ?? '', new RegExp(`/procesos/${p.id}`));
  const again = assignmentView(S, a.id);
  assert.equal(again.nextIteration?.note, note, 'la vista del encargo también la muestra');
  assert.equal(procsOf(a.id).length, n0, 'no se crea ningún proceso hasta autorizar');
  assert.ok(!procsOf(a.id).some(x => ['running', 'pending_authorization'].includes(x.status)));
  assert.equal(spent(a.id), usd0, '0 USD'); assert.equal(calls(), calls0, 'sin llamadas a la IA');
  assert.ok(!processesRepo(S).get(p.id)!.result!.rejected, 'lo integrado no se descarta');
  const msgs = posted.slice(posted0).filter(m => m.conversationId === a.conversationId);
  assert.equal(msgs.length, 1, JSON.stringify(posted.slice(posted0)));
  assert.match(msgs[0].markdown, /El botón de enviar no muestra confirmación/);
  assert.match(msgs[0].markdown, /Siguiente paso/); assert.match(msgs[0].markdown, /no se ejecuta ni gasta nada/);
  assert.match(msgs[0].markdown, /Autorizar iteración/);
  assert.ok(assignmentsRepo(S).get(a.id)!.events.some(e => e.kind === 'changes' && /nueva iteración esperando autorización/.test(e.message)));

  // Decisiones: el encargo aparece como pendiente del propietario, con la nota y el enlace a su proceso.
  const item = assignmentPendingItems(S).find(i => i.assignmentId === a.id);
  assert.ok(item, 'Decisiones lo muestra');
  assert.equal(item!.kind, 'awaiting_iteration_authorization'); assert.equal(item!.label, v.pending.label);
  assert.equal(item!.note, note); assert.match(item!.link, new RegExp(`/procesos/${p.id}$`));

  // (b) Al preparar la iteración (lo que hace authorizeAssignment antes de autorizar) el proceso recibe la nota.
  const prep = prepareAssignment(S, a.id);
  try {
    assert.equal(prep.process.status, 'pending_authorization', 'sigue sin ejecutarse');
    assert.match(JSON.stringify(processesRepo(S).get(prep.process.id)), /El botón de enviar no muestra confirmación/, 'la nota va en iterationContext');
    assert.equal(spent(a.id), usd0);
  } finally { cancelAssignment(S, a.id); }
});

test('(c) aceptar un encargo integrado con nota sin ejecutar exige confirmar el descarte', async () => {
  const { a } = mkAssignment('aceptar con nota', true);
  await requestAssignmentChanges(S, a.id, 'Cambiar el color del aviso');
  const r1 = await inject('POST', `${W}/assignments/${a.id}/accept`, { ownerReason: 'Ya me sirve así' });
  assert.equal(r1.statusCode, 409, r1.body);
  assert.equal(r1.json().code, 'note_discard_confirmation_required');
  assert.match(r1.json().error, /Cambiar el color del aviso/); assert.match(r1.json().error, /se descartará/);
  assert.equal(assignmentsRepo(S).get(a.id)!.status, 'changes_requested', 'sin confirmar no cambia nada');
  const r2 = await inject('POST', `${W}/assignments/${a.id}/accept`, { ownerReason: 'Ya me sirve así', discardNote: true });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json().status, 'accepted'); assert.equal(r2.json().iterationNote, null);
  assert.ok(r2.json().events.some((e: any) => /Nota pendiente descartada al aceptar: Cambiar el color del aviso/.test(e.message)));
});

test('(d) listo para revisar e integrado: la misma etiqueta en el Asistente, en Decisiones y en la tarjeta', () => {
  const { a, p } = mkAssignment('integrado sin aceptar', true);
  assert.equal(a.status, 'ready_for_review', 'el estado guardado no cambia');
  const label = ASSIGNMENT_MERGED_PENDING_LABEL('main');
  assert.equal(label, 'Integrado en main · falta aceptarlo');
  const pure = assignmentPendingState(a, { merged: { into: 'main' }, processId: p.id });
  assert.equal(pure.kind, 'merged_awaiting_acceptance'); assert.equal(pure.label, label); assert.ok(pure.ownerPending);
  assert.match(pure.where ?? '', new RegExp(`tarjeta de ${a.code}.*/procesos/${p.id}`));
  const view = assignmentView(S, a.id);
  assert.equal(view.pending.label, label, 'tarjeta');
  const item = assignmentPendingItems(S).find(i => i.assignmentId === a.id);
  assert.equal(item?.label, label, 'Decisiones'); assert.equal(item?.kind, 'merged_awaiting_acceptance');
  // Asistente: la acción del encargo en el chat se presenta con la misma regla (estado calculado al leer).
  assistantRepo.add({ role: 'assistant', content: 'Encargo propuesto', actions: [{ type: 'propose_assignment', status: 'pending', label: a.title, assignmentId: a.id, workspaceSlug: S, projectId: project.id }], attachments: [], tokensIn: 0, tokensOut: 0, costUsd: 0, model: null } as any, null as any);
  const act = assistantRepo.listLive(200).flatMap(m => m.actions).find(x => x.assignmentId === a.id);
  assert.ok(act?.live, 'el Asistente calcula su estado real');
  assert.match(act!.live!.phase, /Integrado en main · falta aceptarlo/);
  assert.match(act!.live!.next, /aceptarlo/);
  assert.doesNotMatch(`${act!.live!.phase} ${act!.live!.next}`, /esperando tu revisión|intégralo/i);
});

test('(e) encargo NO integrado: pedir cambios sigue igual (409 sin confirmar, descarte con confirmación)', async () => {
  const { a, p } = mkAssignment('no integrado', false);
  assert.equal(a.status, 'ready_for_review');
  const pend = assignmentView(S, a.id).pending;
  assert.equal(pend.kind, 'awaiting_review', 'sin integrar sigue esperando tu revisión');
  const posted0 = posted.length;
  const r1 = await inject('POST', `${W}/assignments/${a.id}/changes`, { note: 'Rehacer el formulario' });
  assert.equal(r1.statusCode, 409, r1.body); assert.equal(r1.json().code, 'discard_confirmation_required');
  assert.equal(assignmentsRepo(S).get(a.id)!.status, 'ready_for_review', 'sin confirmar no cambia nada');
  const r2 = await inject('POST', `${W}/assignments/${a.id}/changes`, { note: 'Rehacer el formulario', discardApplied: true });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json().status, 'changes_requested');
  assert.ok(processesRepo(S).get(p.id)!.result!.rejected, 'la versión sin integrar se descarta con tu confirmación');
  assert.equal(r2.json().nextIteration?.merged, false);
  assert.equal(posted.slice(posted0).length, 0, 'el aviso de iteración es solo para encargos integrados');
  // La ronda sobre su rama (entrega incremental) se conserva antes del descarte.
  const src = fs.readFileSync(path.join(here, '..', 'src', 'services', 'assignments.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export async function requestAssignmentChanges'));
  assert.ok(fn.indexOf('prepareOwnerRound(') > 0 && fn.indexOf('prepareOwnerRound(') < fn.indexOf('discard_confirmation_required'));
});

test('(f) cableado de la web: iteración visible, pendiente único y confirmación del descarte de la nota', () => {
  const web = path.join(here, '..', '..', 'web', 'src');
  const flow = fs.readFileSync(path.join(web, 'components', 'StoryFlowPanel.tsx'), 'utf8');
  const panel = fs.readFileSync(path.join(web, 'components', 'ConversationPanel.tsx'), 'utf8');
  const api = fs.readFileSync(path.join(web, 'lib', 'api.ts'), 'utf8');
  assert.match(flow, /api\.requestAssignmentChanges\(/);
  assert.match(flow, /nextIteration/); assert.match(flow, /Autorizar iteración/);
  assert.match(panel, /a\.pending\.label/); assert.match(panel, /nextIteration/);
  assert.match(panel, /discardNote/);
  assert.match(api, /discardNote/); assert.match(api, /pending: AssignmentPendingState/); assert.match(api, /nextIteration: AssignmentNextIteration \| null/);
});

import { agentCaller, completeWith } from './claudeCode/backend.ts';
import crypto from 'node:crypto';
import type { BacklogItem, ModelInfo, Process, ProviderId, StoryContext, StoryIterationState, StoryMessage, StoryTask, TeamMember } from '@portal-ia/domain';
import { INTERNAL_WORKSPACE } from '@portal-ia/domain';
import { costUsd, estimatePricing, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, processesRepo, projectsRepo, workspaceDb } from '../db/workspace.ts';
import { activeAgents } from './activeAgents.ts';
import { decryptSecret } from '../security/crypto.ts';
import { requirePolicy } from './executionPolicy.ts';
import { describeProcess } from './guidance.ts';
import { listFeedback } from './manual-test-feedback.ts';
import { createStoryProcess, stepByRole } from './storyExecution.ts';
import { lessonsRepo } from './lessons.ts';
import { discardBranch } from './repoWrite.ts';
import { flowOptions } from './processView.ts';
import { issueForPrompt } from './storyFlow.ts';
import { activationOf } from './system.ts';
import { phaseContext } from './operationalPhase.ts';
import { REPO_ROOT } from '../config.ts';
import path from 'node:path';

/**
 * Espacio de la historia (M6): un solo lugar por historia con contexto, equipo, iteraciones (procesos), prueba manual
 * unificada (marcas + feedback por paso), chat con los agentes implicados (una llamada autorizada por pregunta),
 * tareas y cierre. Nada aquí llama a la IA salvo `askTeam` con autorización explícita.
 */
const now = () => new Date().toISOString();
function ensure(slug: string) {
  const db = workspaceDb(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS story_threads (id TEXT PRIMARY KEY, backlog_item_id TEXT NOT NULL, role TEXT NOT NULL, agent_id TEXT, agent_name TEXT, content TEXT NOT NULL, process_id TEXT, cost_usd REAL NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, proposals TEXT, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS story_threads_item ON story_threads(backlog_item_id);
  CREATE TABLE IF NOT EXISTS story_tasks (id TEXT PRIMARY KEY, backlog_item_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', assignee_agent_id TEXT, assignee_name TEXT, source TEXT NOT NULL DEFAULT 'owner', process_id TEXT, created_at TEXT NOT NULL, done_at TEXT);
  CREATE INDEX IF NOT EXISTS story_tasks_item ON story_tasks(backlog_item_id);`);
  return db;
}
const mapMsg = (r: any): StoryMessage => ({ id: r.id, backlogItemId: r.backlog_item_id, role: r.role, agentId: r.agent_id, agentName: r.agent_name, content: r.content, processId: r.process_id, costUsd: r.cost_usd, tokens: r.tokens, proposals: r.proposals ? JSON.parse(r.proposals) : null, createdAt: r.created_at });
const mapTask = (r: any): StoryTask => ({ id: r.id, backlogItemId: r.backlog_item_id, title: r.title, status: r.status, assigneeAgentId: r.assignee_agent_id, assigneeName: r.assignee_name, source: r.source, processId: r.process_id, createdAt: r.created_at, doneAt: r.done_at });

export function threadRepo(slug: string) {
  const db = ensure(slug);
  return {
    messages(itemId: string): StoryMessage[] { return (db.prepare(`SELECT * FROM story_threads WHERE backlog_item_id = ? ORDER BY created_at`).all(itemId) as any[]).map(mapMsg); },
    add(m: Omit<StoryMessage, 'id' | 'createdAt'>): StoryMessage {
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO story_threads (id, backlog_item_id, role, agent_id, agent_name, content, process_id, cost_usd, tokens, proposals, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, m.backlogItemId, m.role, m.agentId, m.agentName, m.content, m.processId, m.costUsd, m.tokens, m.proposals ? JSON.stringify(m.proposals) : null, now());
      return mapMsg(db.prepare(`SELECT * FROM story_threads WHERE id = ?`).get(id));
    },
    tasks(itemId: string): StoryTask[] { return (db.prepare(`SELECT * FROM story_tasks WHERE backlog_item_id = ? ORDER BY status DESC, created_at`).all(itemId) as any[]).map(mapTask); },
    addTask(t: { backlogItemId: string; title: string; assigneeAgentId?: string | null; assigneeName?: string | null; source?: string; processId?: string | null }): StoryTask {
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO story_tasks (id, backlog_item_id, title, status, assignee_agent_id, assignee_name, source, process_id, created_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`).run(id, t.backlogItemId, t.title.trim().slice(0, 300), t.assigneeAgentId ?? null, t.assigneeName ?? null, t.source ?? 'owner', t.processId ?? null, now());
      return mapTask(db.prepare(`SELECT * FROM story_tasks WHERE id = ?`).get(id));
    },
    setTask(id: string, status: 'open' | 'done'): StoryTask | undefined {
      db.prepare(`UPDATE story_tasks SET status = ?, done_at = ? WHERE id = ?`).run(status, status === 'done' ? now() : null, id);
      const r = db.prepare(`SELECT * FROM story_tasks WHERE id = ?`).get(id); return r ? mapTask(r) : undefined;
    },
    deleteTask(id: string) { db.prepare(`DELETE FROM story_tasks WHERE id = ?`).run(id); }
  };
}

function storyProcesses(slug: string, item: BacklogItem): Process[] {
  // Todas (también las archivadas): el espacio de una historia archivada sigue mostrando su historial.
  return processesRepo(slug).listAll(item.projectId).filter(p => p.backlogItemId === item.id && p.kind === 'story_execution');
}

/** Contexto completo de la historia. Sin IA. */
export async function storyContext(slug: string, itemId: string): Promise<StoryContext> {
  const item = backlogRepo(slug).get(itemId); if (!item) throw Object.assign(new Error('Historia no encontrada'), { statusCode: 404 });
  const isPortal = slug === INTERNAL_WORKSPACE.slug;
  const procs = storyProcesses(slug, item);
  const repo = projectsRepo(slug).repository(item.projectId);
  const runtime = isPortal && !!repo && path.resolve(repo.path) === path.resolve(REPO_ROOT);
  const enriched = await Promise.all(procs.map(async p => {
    let q = p;
    if (runtime && p.result?.merged) { const activation = await activationOf(p.result.merged.commit, p.result.merged.mergedAt).catch(() => null); q = { ...p, result: { ...p.result, activation } }; }
    const fo = await flowOptions(slug, q, item);
    return { ...q, guidance: describeProcess(q, { isPortalRepo: isPortal, storyStatus: q.id === item.lastProcessId || !item.lastProcessId || q.id === procs[0]?.id ? item.status : null, ...fo }) };
  }));
  // La iteración «actual» es la más reciente (también si está pendiente de autorización), no la última que llegó a ejecutarse.
  const last = enriched[0] ?? null;
  // Equipo: el registrado por el compositor en la iteración más reciente que lo tenga; en procesos antiguos (sin papeles), por posición.
  const withTeam = enriched.find(p => p.result?.team?.members?.length);
  const legacyRole = (i: number) => (['planner', 'implementer', 'reviewer'] as const)[i] ?? 'consultant';
  const team: TeamMember[] = withTeam?.result?.team?.members ?? (last ? last.steps.map((s, i) => ({ agentId: s.agentId, agentName: s.agentName, agentKey: '', role: (s.role ?? legacyRole(i)) as any, capability: null, model: s.model ?? '', reason: s.reason ?? '' })) : []);
  const feedback = last ? listFeedback(slug, last.id) : { steps: [], items: [] };
  const lessons = lessonsRepo(slug).list(item.projectId).filter(l => l.evidence.processId && procs.some(p => p.id === l.evidence.processId));
  const t = threadRepo(slug);
  const iteration = iterationState(item, enriched, feedback.items.filter(i => i.result === 'fail').length);
  return { item, processes: enriched, lastProcess: last, iterations: procs.length, team, manualTest: last?.result?.manualTest ?? null, feedback, tasks: t.tasks(item.id), messages: t.messages(item.id), lessons, project: projectsRepo(slug).get(item.projectId)!, iteration };
}

/** Qué hará una nueva iteración según el estado de la anterior (una sola regla para la interfaz y para iterateStory). */
export function iterationState(item: BacklogItem, procs: Process[], failedSteps: number): StoryIterationState {
  const needsReopen = item.status === 'done' || item.status === 'discarded';
  const base = { needsReopen, needsDiscardConfirmation: false, failedSteps };
  const reopen = needsReopen ? `Primero se reabre la historia (está ${item.status === 'done' ? 'completada' : 'descartada'}; queda registrado en su historial). ` : '';
  const pendingNote = 'La nueva iteración queda pendiente de tu autorización: no gasta nada hasta que la autorices con un presupuesto.';
  if (procs.some(p => p.status === 'running' || p.status === 'pending_authorization')) return { ...base, state: 'in_progress', branch: null, summary: 'Ya hay una iteración en ejecución o pendiente de autorización: autorízala o cancélala en «Iteraciones» antes de crear otra.' };
  const prev = procs[0]; const r = prev?.result;
  if (!r || r.rejected && !r.merged) return { ...base, state: 'none', branch: null, summary: `${reopen}${pendingNote}` };
  if (r.merged) return { ...base, state: 'merged', branch: r.merged.into, summary: `${reopen}La iteración anterior ya está integrada en ${r.merged.into} (commit ${r.merged.commit}): la nueva parte de ese código y lo corrige o completa. ${pendingNote}` };
  if (r.applied && !r.applied.worktree) return { ...base, state: 'legacy', branch: r.applied.branch, summary: `${reopen}La iteración anterior se aplicó antes de v0.12 (sin worktree): se marca como descartada y su rama ${r.applied.branch} se conserva en git. ${pendingNote}` };
  if (r.applied) return { ...base, state: 'applied_worktree', branch: r.applied.branch, needsDiscardConfirmation: true, summary: `${reopen}La iteración anterior está aplicada en ${r.applied.branch} pero no integrada: se rechaza, se retira su worktree y se borra la rama (esos cambios no integrados se pierden; la nueva iteración los rehace con tu feedback). ${pendingNote}` };
  return { ...base, state: 'not_applied', branch: null, summary: `${reopen}El diff anterior no se aplicó: queda marcado como superado. ${pendingNote}` };
}

/** Pasos marcados como fallo/observación con su comentario (para iteraciones y para el chat). */
export function failedSteps(ctx: StoryContext): { index: number; text: string; result: string; comment: string }[] {
  const steps = ctx.feedback.steps; const by = new Map(ctx.feedback.items.map(i => [i.stepKey, i]));
  return steps.map(s => ({ s, f: by.get(s.stepKey) })).filter(x => x.f && (x.f.result === 'fail' || x.f.result === 'observation')).map(x => ({ index: x.s.index, text: x.s.text, result: x.f!.result!, comment: x.f!.comment }));
}

export function estimateAsk(slug: string, itemId: string, agentId?: string | null): { agentId: string; agentName: string; model: string; estimatedUsd: number } {
  const item = backlogRepo(slug).get(itemId); if (!item) throw Object.assign(new Error('Historia no encontrada'), { statusCode: 404 });
  const agents = activeAgents(slug); // un retirado no responde preguntas del equipo
  const agent = (agentId ? agents.find(a => a.id === agentId) : null) ?? agents.find(a => a.key === 'pj-coordinador' && a.projectId === item.projectId);
  if (!agent) throw Object.assign(new Error('No hay Coordinador en el proyecto.'), { statusCode: 409 });
  if (agent.projectId && agent.projectId !== item.projectId) throw Object.assign(new Error('Ese agente pertenece a otro proyecto.'), { statusCode: 403 });
  const p = estimatePricing(agent.config.provider, agent.config.model);
  return { agentId: agent.id, agentName: agent.config.name, model: agent.config.model, estimatedUsd: (6000 * p.inPerM + 1200 * p.outPerM) / 1_000_000 };
}

function contextForPrompt(ctx: StoryContext): string {
  const last = ctx.lastProcess; const r = last?.result;
  const fails = failedSteps(ctx);
  return [
    `Historia ${ctx.item.storyId} · ${ctx.item.title} [estado ${ctx.item.status}]`,
    ctx.item.criterion ? `Criterio de aceptación: ${ctx.item.criterion}` : '',
    ctx.item.description ? `Descripción/historial: ${ctx.item.description.slice(0, 1500)}` : '',
    `Iteraciones (procesos): ${ctx.iterations}${last ? ` · última: ${last.guidance?.phase ?? last.status}` : ''}`,
    last?.guidance ? `Siguiente paso según el Portal: ${last.guidance.next}` : '',
    r?.plan ? `Plan de la última iteración: ${r.plan.summary}` : '',
    r?.implementationSummary ? `Resumen de implementación: ${r.implementationSummary.slice(0, 1200)}` : '',
    r?.changes?.length ? `Archivos: ${r.changes.map(c => `${c.action} ${c.path}${c.error ? ' (NO aplicable)' : ''}`).join(', ')}` : '',
    r?.review ? `QA: ${r.review.approve ? 'aprobó' : 'NO aprobó'} — ${r.review.summary} ${r.review.issues.slice(0, 5).join(' · ')}` : '',
    r?.userFacing ? `Qué verá el propietario: ${r.userFacing}` : '',
    r?.manualTest ? `Prueba manual: ${r.manualTest.checks.filter(Boolean).length}/${r.manualTest.steps.length} marcados. Pasos: ${r.manualTest.steps.map((s, i) => `${i + 1}. ${s}`).join(' | ')}` : '',
    fails.length ? `Feedback del propietario en la prueba: ${fails.map(f => `paso ${f.index + 1} ${f.result.toUpperCase()}${f.comment ? `: ${f.comment}` : ''}`).join(' · ')}` : '',
    last?.guidance?.flow?.issue ? `# Problema actual de la iteración\n${issueForPrompt(last.guidance.flow.issue, last)}` : '',
    ctx.tasks.length ? `Tareas: ${ctx.tasks.map(t => `[${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.assigneeName ? ` (${t.assigneeName})` : ''}`).join(' · ')}` : '',
    ctx.lessons.length ? `Lecciones detectadas en esta historia: ${ctx.lessons.map(l => `${l.title} [${l.status}]`).join(' · ')}` : '',
    ctx.team.length ? `Equipo: ${ctx.team.map(m => `${m.agentName} (${m.role})`).join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

/** Pregunta al equipo de la historia: una llamada al agente elegido (por defecto el Coordinador) con todo el contexto. Autorización explícita. */
export async function askTeam(slug: string, itemId: string, text: string, opts: { authorized: boolean; maxUsd: number; agentId?: string | null }, log: (o: any, m: string) => void): Promise<{ user: StoryMessage; reply: StoryMessage }> {
  if (!opts.authorized) throw Object.assign(new Error('Preguntar al equipo llama a la IA: requiere autorización explícita.'), { statusCode: 403 });
  const est = estimateAsk(slug, itemId, opts.agentId);
  if (est.estimatedUsd > opts.maxUsd) throw Object.assign(new Error(`La pregunta cuesta aprox. ${est.estimatedUsd.toFixed(3)} USD, por encima del tope (${opts.maxUsd.toFixed(2)}).`), { statusCode: 409 });
  const ctx = await storyContext(slug, itemId);
  const t = threadRepo(slug);
  const user = t.add({ backlogItemId: itemId, role: 'owner', agentId: null, agentName: null, content: text.trim().slice(0, 8000), processId: null, costUsd: 0, tokens: 0, proposals: null });
  const agent = agentsRepo(slug).get(est.agentId)!;
  const providerId = agent.config.provider as ProviderId; const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
  const cc = agentCaller(slug, agent, ctx.project.id, 'Pregunta al equipo');
  if (!cc && (!cred || prow.status !== 'connected')) throw Object.assign(new Error('El proveedor no está conectado.'), { statusCode: 409 });
  const models: ModelInfo[] = JSON.parse(prow.models_json);
  const history = ctx.messages.slice(-10).map(m => `${m.role === 'owner' ? 'Propietario' : m.agentName ?? 'Agente'}: ${m.content.slice(0, 1200)}`).join('\n');
  const system = `Eres «${agent.config.name}», ${agent.template.role.toLowerCase()} del proyecto «${ctx.project.name}» en Portal IA. Conversas con el propietario dentro del espacio de UNA historia. Responde en español, breve y concreto, en markdown. No ejecutas nada: si hace falta trabajo, propón tareas o una nueva iteración. Si propones cambiar el criterio de aceptación o crear tareas, termina con UN bloque:
\`\`\`proposals
{"tasks":[{"title":string,"assignee":"nombre de agente del equipo o null"}],"criterion":string|null,"iterate":boolean,"iterationNote":string|null}
\`\`\`
(solo si procede; el propietario decide si aplicarlo).`;
  const phase = phaseContext(slug, ctx.item.projectId, 4000);
  const userPrompt = `${phase ? `${phase}\n\n` : ''}# Contexto de la historia\n${contextForPrompt(ctx)}\n\n# Conversación reciente\n${history || '(sin mensajes previos)'}\n\n# Pregunta del propietario\n${text.trim()}`;
  const startedAt = now();
  try {
    requirePolicy('ai_call', { slug, agentId: agent.id, projectId: ctx.item.projectId, authorized: true });
    const res = await completeWith(cc, providerId, cred, prow, { model: agent.config.model, system, user: userPrompt, maxTokens: 1500, effort: 'low', supportsEffort: !!models.find(m => m.id === agent.config.model)?.supportsEffort });
    const cost = (cc ? 0 : costUsd(providerId, agent.config.model, res.inputTokens, res.outputTokens));
    processesRepo(slug).logExecution({ projectId: ctx.item.projectId, agentId: agent.id, kind: 'story_chat', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
    const m = res.text.match(/```proposals\s*([\s\S]*?)```/i); let proposals: any = null;
    if (m) { try { proposals = JSON.parse(m[1]); } catch { proposals = null; } }
    const content = res.text.replace(/```proposals[\s\S]*?```/i, '').trim();
    const reply = t.add({ backlogItemId: itemId, role: 'agent', agentId: agent.id, agentName: agent.config.name, content, processId: ctx.lastProcess?.id ?? null, costUsd: cost, tokens: res.inputTokens + res.outputTokens, proposals: proposals ? { tasks: Array.isArray(proposals.tasks) ? proposals.tasks.filter((x: any) => x && typeof x.title === 'string').slice(0, 8) : [], criterion: typeof proposals.criterion === 'string' ? proposals.criterion : null, iterate: !!proposals.iterate, iterationNote: typeof proposals.iterationNote === 'string' ? proposals.iterationNote : null, applied: false } : null });
    log({ story: ctx.item.storyId, agent: agent.key, cost: cost.toFixed(4) }, 'pregunta al equipo respondida');
    return { user, reply };
  } catch (e) {
    processesRepo(slug).logExecution({ projectId: ctx.item.projectId, agentId: agent.id, kind: 'story_chat', status: 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt });
    if (e instanceof ProviderRequestError) throw Object.assign(new Error(e.error.message), { statusCode: 502 });
    throw e;
  }
}

/** Aplica las propuestas de un mensaje del equipo (tareas y/o criterio). Sin IA. */
export function applyProposals(slug: string, itemId: string, messageId: string, what: { tasks?: boolean; criterion?: boolean }): StoryContext | Promise<StoryContext> {
  const t = threadRepo(slug); const msg = t.messages(itemId).find(m => m.id === messageId);
  if (!msg?.proposals) throw Object.assign(new Error('El mensaje no tiene propuestas.'), { statusCode: 404 });
  const agents = activeAgents(slug); // a un retirado no se le asignan tareas
  if (what.tasks) for (const task of msg.proposals.tasks) { const a = task.assignee ? agents.find(x => x.config.name === task.assignee) : null; t.addTask({ backlogItemId: itemId, title: task.title, assigneeAgentId: a?.id ?? null, assigneeName: a?.config.name ?? task.assignee ?? null, source: 'agent', processId: msg.processId }); }
  if (what.criterion && msg.proposals.criterion) backlogRepo(slug).update(itemId, { criterion: msg.proposals.criterion });
  workspaceDb(slug).prepare(`UPDATE story_threads SET proposals = ? WHERE id = ?`).run(JSON.stringify({ ...msg.proposals, applied: true }), messageId);
  return storyContext(slug, itemId);
}

/** Tareas automáticas a partir de los pasos con falla/observación de la prueba manual. */
export async function tasksFromFeedback(slug: string, itemId: string): Promise<StoryTask[]> {
  const ctx = await storyContext(slug, itemId); const t = threadRepo(slug); const out: StoryTask[] = [];
  const existing = ctx.tasks.map(x => x.title);
  const impl = ctx.team.find(m => m.role === 'implementer');
  for (const f of failedSteps(ctx)) {
    const title = `Paso ${f.index + 1} ${f.result === 'fail' ? 'falla' : 'observación'}: ${f.text.slice(0, 120)}${f.comment ? ` — ${f.comment.slice(0, 120)}` : ''}`;
    if (existing.includes(title)) continue;
    out.push(t.addTask({ backlogItemId: itemId, title, assigneeAgentId: impl?.agentId ?? null, assigneeName: impl?.agentName ?? null, source: 'feedback', processId: ctx.lastProcess?.id ?? null }));
  }
  return out;
}

const conflict = (message: string, code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { statusCode: 409, code, ...extra });

/** Tareas a partir del problema actual del recorrido (observaciones de QA, errores de verificación, comprobaciones en rojo…). Sin IA; no duplica. */
export async function tasksFromIssue(slug: string, itemId: string): Promise<StoryTask[]> {
  const ctx = await storyContext(slug, itemId); const issue = ctx.lastProcess?.guidance?.flow?.issue;
  if (!issue) throw Object.assign(new Error('La iteración actual no tiene ningún problema que convertir en tareas.'), { statusCode: 409, code: 'no_issue' });
  if (issue.kind === 'manual_failed') return tasksFromFeedback(slug, itemId);
  const t = threadRepo(slug); const existing = new Set(ctx.tasks.map(x => x.title)); const out: StoryTask[] = [];
  const impl = ctx.team.find(m => m.role === 'implementer');
  const prefix = issue.kind === 'qa_rejected' ? 'QA' : issue.command ? issue.command : issue.kind;
  for (const d of issue.details.slice(0, 12)) {
    const title = `${prefix}${d.severity ? ` [${d.severity}]` : ''}: ${d.file ? `${d.file}${d.line ? `:${d.line}` : ''} — ` : ''}${d.code ? `${d.code} ` : ''}${d.text}`.slice(0, 300);
    if (existing.has(title)) continue; existing.add(title);
    out.push(t.addTask({ backlogItemId: itemId, title, assigneeAgentId: impl?.agentId ?? null, assigneeName: impl?.agentName ?? null, source: 'issue', processId: ctx.lastProcess?.id ?? null }));
  }
  return out;
}

/**
 * Nueva iteración de la historia: crea un proceso (pendiente de autorización) cuyo contexto incluye el feedback de la
 * prueba, las tareas abiertas y la nota del propietario. Según la iteración anterior (iterationState):
 * no aplicada → superada; aplicada en worktree sin integrar → rechazada, worktree y rama descartados (solo con
 * `discardApplied`); anterior a v0.12 → descartada conservando la rama; integrada → parte de main.
 * Una historia cerrada o descartada solo itera con `reopen` (queda registrado en su historial).
 */
export async function iterateStory(slug: string, itemId: string, note: string | null, opts: { reopen?: boolean; discardApplied?: boolean } = {}): Promise<{ process: Process; context: string; actions: string[] }> {
  const ctx = await storyContext(slug, itemId); const item = ctx.item; const st = ctx.iteration;
  if (st.state === 'in_progress') throw conflict('Ya hay una iteración en curso o pendiente de autorización.', 'iteration_in_progress');
  if (st.needsReopen && !opts.reopen) throw conflict(`La historia está ${item.status === 'done' ? 'completada' : 'descartada'}: reábrela para crear una nueva iteración.`, 'story_closed');
  if (st.needsDiscardConfirmation && !opts.discardApplied) throw conflict(`La iteración anterior está aplicada en ${st.branch} sin integrar. Para iterar hay que descartar su worktree y su rama: confírmalo explícitamente.`, 'discard_confirmation_required', { branch: st.branch });
  const fails = failedSteps(ctx); const open = ctx.tasks.filter(t => t.status === 'open');
  const prev = ctx.lastProcess; const actions: string[] = [];
  const procs = processesRepo(slug); const backlog = backlogRepo(slug);
  // 1 · Reabrir (registrado en el historial de la historia).
  if (st.needsReopen) {
    backlog.update(item.id, { description: `${item.description ? item.description + '\n' : ''}[${now().slice(0, 10)}] Reabierta por el propietario para una nueva iteración${note ? `: ${note.slice(0, 300)}` : ''}` });
    backlog.setStatus(item.id, 'pending', prev?.id ?? null);
    actions.push(`historia reabierta (estaba ${item.status === 'done' ? 'completada' : 'descartada'})`);
  }
  // 2 · Retirar la iteración anterior según su estado.
  if (prev?.result && st.state === 'applied_worktree') {
    const repo = projectsRepo(slug).repository(item.projectId);
    if (repo) {
      requirePolicy('delete_worktree', { slug, processId: prev.id, projectId: item.projectId, authorized: true });
      const d = await discardBranch(repo.path, prev.id, prev.result.applied!.branch);
      actions.push(`iteración anterior rechazada: worktree ${d.worktreeRemoved ? 'retirado' : 'ya no existía'}, rama ${prev.result.applied!.branch} ${d.branchDeleted ? 'borrada' : 'conservada (integrada o activa)'}`);
    }
    procs.setResult(prev.id, { ...prev.result, rejected: { at: now(), reason: 'descartada para una nueva iteración con el feedback del propietario' } });
  } else if (prev?.result && st.state === 'legacy') {
    procs.setResult(prev.id, { ...prev.result, rejected: { at: now(), reason: 'iteración anterior a v0.12 descartada para una nueva iteración (rama conservada)' } });
    actions.push(`iteración anterior a v0.12 descartada; rama ${prev.result.applied!.branch} conservada`);
  } else if (prev?.result && st.state === 'not_applied') {
    procs.setResult(prev.id, { ...prev.result, rejected: { at: now(), reason: 'superado por una nueva iteración' } });
    actions.push('diff anterior marcado como superado');
  }
  const context = [
    `Iteración ${ctx.iterations + 1} de la historia. ${prev?.result?.merged ? `La iteración anterior YA está integrada en ${prev.result.merged.into} (commit ${prev.result.merged.commit}); esta iteración corrige o completa sobre ese código.` : prev?.result?.applied ? `La iteración anterior se aplicó en la rama ${prev.result.applied.branch} pero no se integró y se descartó: parte de la rama principal y rehace lo necesario.` : 'La iteración anterior no llegó a aplicarse.'}`,
    `Criterio de aceptación vigente: ${backlog.get(item.id)!.criterion || '(no definido)'}`,
    prev?.guidance?.flow?.issue && prev.guidance.flow.issue.kind !== 'manual_failed' ? `Problema que motiva esta iteración (CORRÍGELO; no repitas el mismo error):\n${issueForPrompt(prev.guidance.flow.issue, prev)}` : '',
    ctx.processes.length > 1 ? `Intentos anteriores de esta historia:\n${ctx.processes.slice(1).map((p, i) => `- Iteración ${ctx.processes.length - 1 - i}: ${p.guidance?.flow?.issue ? p.guidance.flow.issue.title : p.guidance?.phase ?? p.status}${p.result?.rejected ? ` (descartada: ${p.result.rejected.reason})` : ''}`).join('\n')}` : '',
    note ? `Nota del propietario: ${note}` : '',
    fails.length ? `Resultado de la prueba manual anterior:\n${fails.map(f => `- Paso ${f.index + 1} (${f.result}): ${f.text}${f.comment ? ` → ${f.comment}` : ''}`).join('\n')}` : '',
    open.length ? `Tareas abiertas:\n${open.map(t => `- ${t.title}${t.assigneeName ? ` (${t.assigneeName})` : ''}`).join('\n')}` : '',
    prev?.result?.review && !prev.result.review.approve ? `Observaciones de QA anteriores: ${prev.result.review.issues.slice(0, 6).join(' · ')}` : '',
    ctx.messages.slice(-6).length ? `Conversación reciente:\n${ctx.messages.slice(-6).map(m => `- ${m.role === 'owner' ? 'Propietario' : m.agentName}: ${m.content.slice(0, 400)}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  const cur = backlog.get(item.id)!;
  if (cur.status === 'review' || cur.status === 'blocked') backlog.setStatus(item.id, 'pending', prev?.id ?? null);
  const proc = createStoryProcess(slug, item.projectId, item.id, { iterationContext: context });
  threadRepo(slug).add({ backlogItemId: itemId, role: 'system', agentId: null, agentName: null, content: `Iteración ${ctx.iterations + 1} creada (proceso ${proc.id}); pendiente de autorización.${fails.length ? ` Incluye ${fails.length} paso(s) de la prueba con falla u observación.` : ''}${actions.length ? ` Antes: ${actions.join('; ')}.` : ''}${note ? ` Nota: ${note}` : ''}`, processId: proc.id, costUsd: 0, tokens: 0, proposals: null });
  return { process: proc, context, actions };
}

/** Registra en la conversación de la historia los cambios del propietario en título, criterio o descripción (historial). */
export function recordContextEdit(slug: string, before: BacklogItem, after: BacklogItem): StoryMessage | null {
  const clip = (s: string) => s.length > 300 ? `${s.slice(0, 300)}…` : s;
  const changes = [
    before.title !== after.title ? `título: «${clip(before.title)}» → «${clip(after.title)}»` : '',
    before.criterion !== after.criterion ? `criterio de aceptación: «${clip(before.criterion || '(vacío)')}» → «${clip(after.criterion || '(vacío)')}»` : '',
    before.description !== after.description ? `descripción actualizada (antes: «${clip(before.description || '(vacía)')}»)` : ''
  ].filter(Boolean);
  if (!changes.length) return null;
  return threadRepo(slug).add({ backlogItemId: after.id, role: 'system', agentId: null, agentName: null, content: `Contexto editado por el propietario (historia ${({ pending: 'pendiente', in_progress: 'en ejecución', review: 'en revisión', done: 'completada', blocked: 'bloqueada', discarded: 'descartada' } as Record<string, string>)[before.status] ?? before.status}): ${changes.join('; ')}. La próxima iteración usa este contexto.`, processId: after.lastProcessId ?? null, costUsd: 0, tokens: 0, proposals: null });
}

export { stepByRole };

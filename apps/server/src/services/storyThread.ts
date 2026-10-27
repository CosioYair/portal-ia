import crypto from 'node:crypto';
import type { BacklogItem, ModelInfo, Process, ProviderId, StoryContext, StoryMessage, StoryTask, TeamMember } from '@portal-ia/domain';
import { INTERNAL_WORKSPACE } from '@portal-ia/domain';
import { costUsd, estimatePricing, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, processesRepo, projectsRepo, workspaceDb } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';
import { requirePolicy } from './executionPolicy.ts';
import { describeProcess } from './guidance.ts';
import { listFeedback } from './manual-test-feedback.ts';
import { createStoryProcess, stepByRole } from './storyExecution.ts';
import { lessonsRepo } from './lessons.ts';
import { activationOf } from './system.ts';
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
  return processesRepo(slug).list(item.projectId).filter(p => p.backlogItemId === item.id && p.kind === 'story_execution');
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
    return { ...q, guidance: describeProcess(q, { isPortalRepo: isPortal, storyStatus: q.id === item.lastProcessId || !item.lastProcessId ? item.status : null }) };
  }));
  const last = (item.lastProcessId ? enriched.find(p => p.id === item.lastProcessId) : undefined) ?? enriched[0] ?? null;
  const team: TeamMember[] = last?.result?.team?.members ?? (last ? last.steps.map(s => ({ agentId: s.agentId, agentName: s.agentName, agentKey: '', role: (s.role ?? 'consultant') as any, capability: null, model: s.model ?? '', reason: s.reason ?? '' })) : []);
  const feedback = last ? listFeedback(slug, last.id) : { steps: [], items: [] };
  const lessons = lessonsRepo(slug).list(item.projectId).filter(l => l.evidence.processId && procs.some(p => p.id === l.evidence.processId));
  const t = threadRepo(slug);
  return { item, processes: enriched, lastProcess: last, iterations: procs.length, team, manualTest: last?.result?.manualTest ?? null, feedback, tasks: t.tasks(item.id), messages: t.messages(item.id), lessons, project: projectsRepo(slug).get(item.projectId)! };
}

/** Pasos marcados como fallo/observación con su comentario (para iteraciones y para el chat). */
export function failedSteps(ctx: StoryContext): { index: number; text: string; result: string; comment: string }[] {
  const steps = ctx.feedback.steps; const by = new Map(ctx.feedback.items.map(i => [i.stepKey, i]));
  return steps.map(s => ({ s, f: by.get(s.stepKey) })).filter(x => x.f && (x.f.result === 'fail' || x.f.result === 'observation')).map(x => ({ index: x.s.index, text: x.s.text, result: x.f!.result!, comment: x.f!.comment }));
}

export function estimateAsk(slug: string, itemId: string, agentId?: string | null): { agentId: string; agentName: string; model: string; estimatedUsd: number } {
  const item = backlogRepo(slug).get(itemId); if (!item) throw Object.assign(new Error('Historia no encontrada'), { statusCode: 404 });
  const agents = agentsRepo(slug).list();
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
  if (!cred || prow.status !== 'connected') throw Object.assign(new Error('El proveedor no está conectado.'), { statusCode: 409 });
  const models: ModelInfo[] = JSON.parse(prow.models_json);
  const history = ctx.messages.slice(-10).map(m => `${m.role === 'owner' ? 'Propietario' : m.agentName ?? 'Agente'}: ${m.content.slice(0, 1200)}`).join('\n');
  const system = `Eres «${agent.config.name}», ${agent.template.role.toLowerCase()} del proyecto «${ctx.project.name}» en Portal IA. Conversas con el propietario dentro del espacio de UNA historia. Responde en español, breve y concreto, en markdown. No ejecutas nada: si hace falta trabajo, propón tareas o una nueva iteración. Si propones cambiar el criterio de aceptación o crear tareas, termina con UN bloque:
\`\`\`proposals
{"tasks":[{"title":string,"assignee":"nombre de agente del equipo o null"}],"criterion":string|null,"iterate":boolean,"iterationNote":string|null}
\`\`\`
(solo si procede; el propietario decide si aplicarlo).`;
  const userPrompt = `# Contexto de la historia\n${contextForPrompt(ctx)}\n\n# Conversación reciente\n${history || '(sin mensajes previos)'}\n\n# Pregunta del propietario\n${text.trim()}`;
  const startedAt = now();
  try {
    requirePolicy('ai_call', { slug, agentId: agent.id, projectId: ctx.item.projectId, authorized: true });
    const res = await getAdapter(providerId)!.complete(decryptSecret(cred.ciphertext), { workspaceId: prow.workspace_id }, { model: agent.config.model, system, user: userPrompt, maxTokens: 1500, effort: 'low', supportsEffort: !!models.find(m => m.id === agent.config.model)?.supportsEffort });
    const cost = costUsd(providerId, agent.config.model, res.inputTokens, res.outputTokens);
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
  const agents = agentsRepo(slug).list();
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

/**
 * Nueva iteración de la historia: crea un proceso (pendiente de autorización) cuyo contexto incluye el feedback de la
 * prueba, las tareas abiertas y la nota del propietario. Si el diff anterior no se aplicó, queda rechazado.
 */
export async function iterateStory(slug: string, itemId: string, note: string | null): Promise<{ process: Process; context: string }> {
  const ctx = await storyContext(slug, itemId); const item = ctx.item;
  if (item.status === 'done' || item.status === 'discarded') throw Object.assign(new Error('La historia está cerrada o descartada; reábrela desde el backlog.'), { statusCode: 409 });
  if (ctx.processes.some(p => p.status === 'running' || p.status === 'pending_authorization')) throw Object.assign(new Error('Ya hay una iteración en curso o pendiente de autorización.'), { statusCode: 409 });
  const fails = failedSteps(ctx); const open = ctx.tasks.filter(t => t.status === 'open');
  const prev = ctx.lastProcess;
  const context = [
    `Iteración ${ctx.iterations + 1} de la historia. ${prev?.result?.merged ? `La iteración anterior YA está integrada en ${prev.result.merged.into} (commit ${prev.result.merged.commit}); esta iteración corrige o completa sobre ese código.` : prev?.result?.applied ? `La iteración anterior se aplicó en la rama ${prev.result.applied.branch} pero no se integró.` : 'La iteración anterior no llegó a aplicarse.'}`,
    note ? `Nota del propietario: ${note}` : '',
    fails.length ? `Resultado de la prueba manual anterior:\n${fails.map(f => `- Paso ${f.index + 1} (${f.result}): ${f.text}${f.comment ? ` → ${f.comment}` : ''}`).join('\n')}` : '',
    open.length ? `Tareas abiertas:\n${open.map(t => `- ${t.title}${t.assigneeName ? ` (${t.assigneeName})` : ''}`).join('\n')}` : '',
    prev?.result?.review && !prev.result.review.approve ? `Observaciones de QA anteriores: ${prev.result.review.issues.slice(0, 6).join(' · ')}` : '',
    ctx.messages.slice(-6).length ? `Conversación reciente:\n${ctx.messages.slice(-6).map(m => `- ${m.role === 'owner' ? 'Propietario' : m.agentName}: ${m.content.slice(0, 400)}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  if (prev?.result && !prev.result.applied && !prev.result.rejected) processesRepo(slug).setResult(prev.id, { ...prev.result, rejected: { at: now(), reason: 'superado por una nueva iteración' } });
  if (item.status === 'review' || item.status === 'blocked') backlogRepo(slug).setStatus(item.id, 'pending', prev?.id ?? null);
  const proc = createStoryProcess(slug, item.projectId, item.id, { iterationContext: context });
  threadRepo(slug).add({ backlogItemId: itemId, role: 'system', agentId: null, agentName: null, content: `Iteración ${ctx.iterations + 1} creada (proceso ${proc.id}); pendiente de autorización.${note ? ` Nota: ${note}` : ''}`, processId: proc.id, costUsd: 0, tokens: 0, proposals: null });
  return { process: proc, context };
}

export { stepByRole };

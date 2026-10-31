import crypto from 'node:crypto';
import { nextConversationAction, type AssistantConversation, type ConversationArtifact, type ConversationArtifactKind, type ConversationDecision, type ConversationStage, type DecisionOption } from '@portal-ia/domain';
import { monotonicNow } from '../clock.ts';
import { artifactsRepo, conversationsRepo, decisionsRepo } from '../db/conversations.ts';
import { platform, workspacesRepo } from '../db/platform.ts';
import { processesRepo, projectsRepo } from '../db/workspace.ts';
import { assignmentsRepo } from '../db/assignments.ts';
import { applyBacklogOps, createDelegation, estimateDelegation, pickLeadAgent } from './delegation.ts';
import { assignmentView } from './assignments.ts';

/**
 * Conversaciones del Asistente (ver packages/domain/src/conversation.ts). Sin IA aquí: las decisiones las toma el
 * propietario; propuesta, revisión del equipo e historias son encargos de análisis (procesos) con su propósito, que se
 * autorizan con la autorización única de procesos. Crear historias = aplicar sus propuestas con un clic.
 */
const fail = (statusCode: number, message: string, code: string) => Object.assign(new Error(message), { statusCode, code });

export function getConversation(id: string): AssistantConversation {
  const c = conversationsRepo.get(id); if (!c) throw fail(404, 'Conversación no encontrada.', 'not_found'); return c;
}

function checkScope(workspaceSlug: string | null, projectId: string | null) {
  if (workspaceSlug && !workspacesRepo.get(workspaceSlug)) throw fail(404, 'Empresa no encontrada.', 'not_found');
  if (projectId && !workspaceSlug) throw fail(400, 'Un proyecto necesita su empresa.', 'invalid_scope');
  if (workspaceSlug && projectId && !projectsRepo(workspaceSlug).get(projectId)) throw fail(404, 'Proyecto no encontrado.', 'not_found');
}
export function createConversation(title: string, workspaceSlug: string | null, projectId: string | null): AssistantConversation {
  checkScope(workspaceSlug, projectId);
  return conversationsRepo.create(title.trim() || 'Nueva conversación', workspaceSlug, projectId);
}
/** Cambiar título, alcance o estado: el alcance se valida igual que al crear (el modelo nunca lo elige). */
export function updateConversation(id: string, patch: { title?: string; workspaceSlug?: string | null; projectId?: string | null; status?: 'active' | 'archived' }): AssistantConversation {
  const c = getConversation(id);
  const ws = patch.workspaceSlug !== undefined ? patch.workspaceSlug : c.workspaceSlug;
  const pj = patch.projectId !== undefined ? patch.projectId : patch.workspaceSlug !== undefined ? null : c.projectId;
  checkScope(ws, pj);
  return conversationsRepo.update(id, { ...patch, workspaceSlug: ws, projectId: pj });
}

/** Mensaje del sistema en la conversación (decisiones, artefactos): queda en el historial, sin llamar a la IA. */
function note(conversationId: string, content: string) {
  const id = crypto.randomUUID(); const at = monotonicNow();
  platform.prepare(`INSERT INTO assistant_messages (id, role, content, actions_json, attachments_json, tokens_in, tokens_out, cost_usd, model, created_at, conversation_id) VALUES (?, 'assistant', ?, '[]', '[]', 0, 0, 0, 'portal', ?, ?)`).run(id, content, at, conversationId);
  conversationsRepo.touch(conversationId);
}

// ---------------------------------------------------------------- Decisiones (una a una, del propietario)

const normQ = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** El modelo PROPONE decisiones (nunca las aprueba). Una pregunta ya abierta no se repite. */
export function proposeDecisions(conversationId: string, messageId: string | null, items: { question: string; context?: string | null; options?: DecisionOption[]; recommendation?: string | null; risks?: string[]; dependsOn?: number[] }[]): ConversationDecision[] {
  getConversation(conversationId);
  const open = decisionsRepo.list(conversationId);
  const out: ConversationDecision[] = [];
  for (const it of items.slice(0, 6)) {
    const q = String(it.question ?? '').trim(); if (q.length < 5) continue;
    if (open.some(d => normQ(d.question) === normQ(q))) continue;
    out.push(decisionsRepo.add(conversationId, {
      question: q.slice(0, 400), context: it.context ? String(it.context).slice(0, 1200) : null,
      options: (it.options ?? []).slice(0, 5).map(o => ({ label: String(o.label ?? '').slice(0, 200), pros: o.pros ? String(o.pros).slice(0, 400) : null, cons: o.cons ? String(o.cons).slice(0, 400) : null })).filter(o => o.label),
      recommendation: it.recommendation ? String(it.recommendation).slice(0, 600) : null, risks: (it.risks ?? []).map(r => String(r).slice(0, 300)).slice(0, 6),
      dependsOn: (it.dependsOn ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 6), sourceMessageId: messageId
    }));
  }
  if (out.length) recomputeStage(conversationId);
  return out;
}

/**
 * Decisión del propietario sobre UNA decisión: aprobar (con la opción o respuesta), rechazar, aplazar, revisar (nueva
 * respuesta) o reabrir. Las demás no cambian; nada se crea ni se ejecuta. El historial conserva cada cambio.
 */
export function decide(conversationId: string, decisionId: string, action: 'approve' | 'reject' | 'defer' | 'revise' | 'reopen', input: { answer?: string | null; note?: string | null }): ConversationDecision {
  const d0 = decisionsRepo.get(decisionId);
  if (!d0 || d0.conversationId !== conversationId) throw fail(404, 'Decisión no encontrada en esta conversación.', 'not_found');
  const answer = input.answer?.trim() || null; const noteText = input.note?.trim() || null;
  if ((action === 'approve' || action === 'revise') && !answer && !d0.recommendation && !d0.answer) throw fail(400, 'Indica tu respuesta u opción para aprobar esta decisión.', 'answer_required');
  const status = action === 'approve' || action === 'revise' ? 'approved' : action === 'reject' ? 'rejected' : action === 'defer' ? 'deferred' : 'open';
  const d = decisionsRepo.update(decisionId, x => {
    x.status = status;
    if (action === 'approve' || action === 'revise') x.answer = answer ?? x.answer ?? x.recommendation;
    if (action === 'reopen') x.answer = x.answer; // se conserva la respuesta anterior hasta que decidas otra
    x.note = noteText ?? x.note; x.decidedAt = status === 'open' ? null : monotonicNow();
    x.history.push({ at: monotonicNow(), status, answer: x.answer, note: noteText });
  });
  const verb = { approve: 'aprobada', reject: 'rechazada', defer: 'aplazada', revise: 'revisada', reopen: 'reabierta' }[action];
  note(conversationId, `**Decisión D${d.seq} ${verb}** por el propietario: ${d.question}${d.answer && status === 'approved' ? ` → **${d.answer}**` : ''}${noteText ? ` (${noteText})` : ''}`);
  recomputeStage(conversationId);
  return d;
}

// ---------------------------------------------------------------- Artefactos (encargos de análisis con propósito)

function decisionsText(conversationId: string): string {
  const ds = decisionsRepo.list(conversationId);
  const by = (s: string) => ds.filter(d => d.status === s);
  return [
    by('approved').length ? `# Decisiones aprobadas por el propietario (no las cambies)\n${by('approved').map(d => `D${d.seq}. ${d.question} → ${d.answer}${d.note ? ` (${d.note})` : ''}`).join('\n')}` : '',
    by('deferred').length ? `# Decisiones aplazadas (no están decididas)\n${by('deferred').map(d => `D${d.seq}. ${d.question}`).join('\n')}` : '',
    by('rejected').length ? `# Opciones rechazadas\n${by('rejected').map(d => `D${d.seq}. ${d.question}${d.answer ? ` (rechazada: ${d.answer})` : ''}`).join('\n')}` : '',
    by('open').length ? `# Decisiones aún abiertas\n${by('open').map(d => `D${d.seq}. ${d.question}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
}
function explorationText(conversationId: string, max = 5000): string {
  const rows = (platform.prepare(`SELECT role, content FROM assistant_messages WHERE conversation_id = ? AND model IS NOT 'portal' ORDER BY created_at DESC LIMIT 12`).all(conversationId) as any[]).reverse();
  const text = rows.map(r => `${r.role === 'user' ? 'Propietario' : 'Asistente'}: ${String(r.content).slice(0, 900)}`).join('\n');
  return text.length > max ? `…${text.slice(-max)}` : text;
}
function deliverableOf(slug: string, a: ConversationArtifact | null): { text: string; challenge: string | null } | null {
  const p = a?.content.processId ? processesRepo(slug).get(a.content.processId) : undefined;
  return p?.delegation?.deliverable ? { text: p.delegation.deliverable, challenge: p.delegation.challenge?.text ?? null } : null;
}

/**
 * Prepara (sin IA ni gasto) el encargo de análisis de un paso de la conversación: propuesta, revisión del equipo o
 * historias. Queda pendiente de TU autorización (la misma de cualquier proceso); sin ella no se llama a nadie.
 */
export function startArtifact(conversationId: string, kind: ConversationArtifactKind) {
  const c = getConversation(conversationId);
  if (!c.workspaceSlug || !c.projectId) throw fail(409, 'Elige primero la empresa y el proyecto de esta conversación.', 'no_scope');
  const slug = c.workspaceSlug; const ds = decisionsRepo.list(conversationId);
  const proposal = artifactsRepo.list(conversationId, 'proposal').filter(a => a.status !== 'failed' && a.status !== 'cancelled' && a.status !== 'rejected').at(-1) ?? null;
  const approved = artifactsRepo.list(conversationId, 'proposal').filter(a => a.status === 'approved').at(-1) ?? null;
  let request: string;
  if (kind === 'proposal') {
    if (ds.some(d => d.status === 'open')) throw fail(409, 'Quedan decisiones abiertas: apruébalas, recházalas o aplázalas antes de preparar la propuesta.', 'open_decisions');
    if (!ds.some(d => d.status === 'approved')) throw fail(409, 'Aprueba al menos una decisión antes de preparar la propuesta.', 'no_decisions');
    request = `Propuesta para la idea «${c.title}» que el propietario ha ido definiendo con el Asistente.\n\n${decisionsText(conversationId)}\n\n# Conversación (extracto)\n${explorationText(conversationId)}`;
  } else if (kind === 'team_review') {
    const d = deliverableOf(slug, proposal); if (!d) throw fail(409, 'Primero prepara la propuesta (y espera a que esté lista).', 'no_proposal');
    request = `Revisión del equipo de la propuesta «${c.title}».\n\n${decisionsText(conversationId)}\n\n# Propuesta\n${d.text}${d.challenge ? `\n\n# Cuestionamiento independiente ya hecho\n${d.challenge}` : ''}`;
  } else {
    const d = deliverableOf(slug, approved); if (!d) throw fail(409, 'Las historias se generan solo a partir de una propuesta APROBADA por ti.', 'proposal_not_approved');
    request = `Historias del backlog para la propuesta aprobada «${c.title}» (versión ${approved!.version}).\n\n${decisionsText(conversationId)}\n\n# Propuesta aprobada\n${d.text}`;
  }
  const lead = pickLeadAgent(slug, c.projectId, 'pj-coordinador');
  const p = createDelegation(slug, c.projectId, lead.key, request, { purpose: kind, conversationId });
  const est = estimateDelegation(slug, c.projectId, lead.key, request, kind);
  const basedOn = kind === 'team_review' ? proposal!.id : kind === 'stories' ? approved!.id : null;
  const a = artifactsRepo.add(conversationId, kind, { processId: p.id, workspaceSlug: slug }, 'pending_authorization', { basedOn, calls: p.steps.length, agents: Array.from(new Set(p.steps.map(s => s.agentName))) });
  note(conversationId, `${kind === 'proposal' ? 'Propuesta' : kind === 'team_review' ? 'Revisión del equipo' : 'Historias'} preparada (${p.steps.length} paso(s): ${a.agents.join(', ')}). **Espera tu autorización**; sin ella no se llama a nadie.`);
  recomputeStage(conversationId);
  return { artifact: a, process: p, estimatedUsd: est.estimatedUsd, suggestedBudgetUsd: est.suggestedBudgetUsd };
}

/** Estado vivo del artefacto (del proceso), sin pisar las decisiones del propietario. */
function syncArtifact(a: ConversationArtifact): ConversationArtifact {
  if (['approved', 'rejected', 'applied'].includes(a.status) || !a.content.processId || !a.content.workspaceSlug) return a;
  const p = processesRepo(a.content.workspaceSlug).get(a.content.processId); if (!p) return a;
  const status = p.status === 'pending_authorization' ? 'pending_authorization' : p.status === 'running' ? 'running' : p.status === 'done' ? 'ready' : p.status === 'cancelled' ? 'cancelled' : 'failed';
  return status === a.status ? a : artifactsRepo.update(a.id, x => { x.status = status; });
}

export function decideProposal(conversationId: string, artifactId: string, decision: 'approve' | 'reject', noteText: string | null): ConversationArtifact {
  const a0 = artifactsRepo.get(artifactId); if (!a0 || a0.conversationId !== conversationId || a0.kind !== 'proposal') throw fail(404, 'Propuesta no encontrada.', 'not_found');
  const a = syncArtifact(a0);
  if (a.status !== 'ready') throw fail(409, `La propuesta no está lista para decidir (está «${a.status}»).`, 'not_ready');
  const out = artifactsRepo.update(artifactId, x => { x.status = decision === 'approve' ? 'approved' : 'rejected'; x.decidedAt = monotonicNow(); x.content = { ...x.content, summary: noteText }; });
  note(conversationId, `**Propuesta v${a.version} ${decision === 'approve' ? 'aprobada' : 'rechazada'}** por el propietario${noteText ? `: ${noteText}` : ''}.${decision === 'approve' ? ' Ahora puedes «Preparar historias» (borradores que luego creas tú) o pedir al Asistente un encargo de desarrollo.' : ''}`);
  recomputeStage(conversationId);
  return out;
}

/** Crear las historias propuestas: SOLO con tu clic, desde una propuesta aprobada; sin duplicar las existentes. */
export function createStoriesFrom(conversationId: string, artifactId: string) {
  const a0 = artifactsRepo.get(artifactId); if (!a0 || a0.conversationId !== conversationId || a0.kind !== 'stories') throw fail(404, 'Borradores de historias no encontrados.', 'not_found');
  const a = syncArtifact(a0);
  if (a.status === 'applied') throw fail(409, 'Estas historias ya se crearon.', 'applied');
  if (a.status !== 'ready') throw fail(409, `Los borradores no están listos (están «${a.status}»).`, 'not_ready');
  const based = a.basedOn ? artifactsRepo.get(a.basedOn) : null;
  if (based?.status !== 'approved') throw fail(409, 'La propuesta de la que salen estas historias ya no está aprobada.', 'proposal_not_approved');
  const r = applyBacklogOps(a.content.workspaceSlug!, a.content.processId!);
  const out = artifactsRepo.update(artifactId, x => { x.status = 'applied'; x.decidedAt = monotonicNow(); });
  note(conversationId, `**Historias creadas** por el propietario a partir de la propuesta v${based.version} (en el backlog; aún sin cambios de código): ${r.opsApplied!.summary.join(' · ')}`);
  recomputeStage(conversationId);
  return { artifact: out, summary: r.opsApplied!.summary };
}

// ---------------------------------------------------------------- Etapa y detalle

export function recomputeStage(conversationId: string): ConversationStage {
  const c = getConversation(conversationId);
  const arts = artifactsRepo.list(conversationId).map(syncArtifact);
  const ds = decisionsRepo.list(conversationId);
  const hasAssignment = !!c.workspaceSlug && assignmentsRepo(c.workspaceSlug).list().some(x => x.conversationId === conversationId && x.status !== 'cancelled');
  const stage: ConversationStage = hasAssignment ? 'execution'
    : arts.some(a => a.kind === 'stories' && a.status === 'applied') ? 'backlog'
    : arts.some(a => a.kind === 'proposal' && a.status === 'approved') ? 'approved'
    : arts.some(a => a.kind === 'team_review' && a.status !== 'cancelled' && a.status !== 'failed') ? 'team_review'
    : arts.some(a => a.kind === 'proposal' && a.status !== 'cancelled' && a.status !== 'failed') ? 'proposal'
    : ds.length ? 'decisions' : 'exploration';
  if (stage !== c.stage) conversationsRepo.update(conversationId, { stage });
  return stage;
}

/** Todo lo de una conversación, con el estado real de sus procesos y encargos (sin IA). */
export function conversationDetail(conversationId: string) {
  const stage = recomputeStage(conversationId);
  const c = getConversation(conversationId);
  const decisions = decisionsRepo.list(conversationId);
  const artifacts = artifactsRepo.list(conversationId).map(syncArtifact).map(a => {
    const p = a.content.processId && a.content.workspaceSlug ? processesRepo(a.content.workspaceSlug).get(a.content.processId) : undefined;
    return { ...a, process: p ? { id: p.id, status: p.status, spentUsd: p.spentUsd, budgetUsd: p.budgetUsd, estimatedUsd: p.estimatedUsd, steps: p.steps.map(s => ({ title: s.title, agentName: s.agentName, status: s.status })) } : null,
      deliverable: p?.delegation?.deliverable ?? null, challenge: p?.delegation?.challenge ?? null, consulted: (p?.delegation?.consulted ?? []).map(x => ({ agentName: x.agentName, question: x.question, answer: x.answer })),
      backlogOps: p?.delegation?.backlogOps ?? [], opsApplied: p?.delegation?.opsApplied ?? null };
  });
  const assignments = c.workspaceSlug ? assignmentsRepo(c.workspaceSlug).list().filter(x => x.conversationId === conversationId).map(x => assignmentView(c.workspaceSlug!, x.id)) : [];
  const proposals = artifacts.filter(a => a.kind === 'proposal');
  const flight = artifacts.find(a => a.status === 'pending_authorization' || a.status === 'running');
  return {
    conversation: c, stage, decisions, artifacts, assignments,
    next: nextConversationAction(stage, decisions.filter(d => d.status === 'open').length, proposals.some(a => !['failed', 'cancelled', 'rejected'].includes(a.status)), proposals.some(a => a.status === 'approved'), flight ? { kind: flight.kind, status: flight.status as 'pending_authorization' | 'running' } : null)
  };
}

/** Resumen acotado del registro para el prompt del Asistente (nunca el historial completo). */
export function ledgerForPrompt(conversationId: string, max = 3500): string {
  const ds = decisionsRepo.list(conversationId);
  const arts = artifactsRepo.list(conversationId).map(syncArtifact);
  const lines = [
    ...ds.map(d => `D${d.seq} [${d.status}] ${d.question}${d.answer ? ` → ${d.answer}` : ''}${d.recommendation && d.status === 'open' ? ` (recomendación: ${d.recommendation})` : ''}`),
    ...arts.map(a => `${a.kind === 'proposal' ? 'Propuesta' : a.kind === 'team_review' ? 'Revisión del equipo' : 'Historias'} v${a.version}: ${a.status}`)
  ].join('\n');
  return lines.length > max ? `${lines.slice(0, max)}\n… (registro recortado)` : lines;
}

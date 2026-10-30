import { ASSIGNMENT_STATUS_LABEL, DEFAULT_PIPELINE, assignmentReady, verificationsForApplied, type Assignment, type AssignmentOutcome, type AssignmentStatus, type Process } from '@portal-ia/domain';
import { monotonicNow } from '../clock.ts';
import { assignmentsRepo } from '../db/assignments.ts';
import { knowledgeRepo, onProcessFinish, processesRepo, projectsRepo } from '../db/workspace.ts';
import { callMetricsRepo } from '../db/callMetrics.ts';
import { createWorkProcess, estimateWork } from './storyExecution.ts';
import { assignmentAsItem, onAssignmentStatus } from './workItems.ts';
import { closingBlocker } from './closing.ts';
import { subscriptionGate } from './claudeCode/usage.ts';
import { projectGauntlet, resolveGauntletFor } from './gauntlet.ts';
import { authorizeProcess } from './processAuthorization.ts';

/**
 * Encargos de desarrollo del propietario (ver packages/domain/src/assignment.ts). Reutilizan el motor de historias:
 * el proceso `story_execution` lleva `assignmentId` y el motor recibe el encargo como «elemento de trabajo» con la misma
 * forma que una historia (workItemOf). El backlog no cambia. Integrar sigue siendo manual (proceso → Integrar).
 */

const fail = (statusCode: number, message: string, code: string) => Object.assign(new Error(message), { statusCode, code });

// ---------------------------------------------------------------- Ciclo de vida

// El motor avisa del estado del elemento: el encargo lo deriva de su proceso.
onAssignmentStatus((slug, id) => { syncAssignment(slug, id); });
// Al terminar su proceso (por cualquier vía: ejecución, recuperación o cancelación) el encargo se pone al día en el acto.
onProcessFinish((slug, processId) => { const p = processesRepo(slug).get(processId); if (p?.assignmentId) syncAssignment(slug, p.assignmentId); });

export interface AssignmentInput { request: string; title: string; objective: string; criteria: string[]; outOfScope?: string[]; size?: 'S' | 'M' | 'L' | null; conversationId?: string | null; messageId?: string | null }

/** Crea el encargo (borrador). Sin IA, sin proceso: nada se ejecuta todavía. */
export function createAssignment(slug: string, projectId: string, input: AssignmentInput): Assignment {
  if (!projectsRepo(slug).get(projectId)) throw fail(404, 'Proyecto no encontrado.', 'not_found');
  const clean = (xs: string[] | undefined) => (xs ?? []).map(x => String(x).trim()).filter(Boolean).slice(0, 20);
  const a = assignmentsRepo(slug).create({
    projectId, owner: 'propietario', request: input.request.trim().slice(0, 8000), title: input.title.trim().slice(0, 160) || input.request.trim().slice(0, 80),
    objective: input.objective.trim().slice(0, 4000), criteria: clean(input.criteria), outOfScope: clean(input.outOfScope), size: input.size ?? null,
    status: 'draft', reason: null, conversationId: input.conversationId ?? null, messageId: input.messageId ?? null, processId: null, processIds: [],
    iterationNote: null, outcome: null, knowledgeDocId: null, events: []
  });
  return assignmentsRepo(slug).event(a.id, { kind: 'created', message: `Encargo ${a.code} creado: ${a.title}` });
}

/**
 * Prepara la ejecución: el mismo proceso que una historia (equipo por capacidades, estimación), pendiente de TU
 * autorización. No llama a la IA. Exige objetivo y criterios comprobables.
 */
export function prepareAssignment(slug: string, id: string): { assignment: Assignment; process: Process } {
  const repo = assignmentsRepo(slug); let a = repo.get(id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  const missing = assignmentReady(a); if (missing) throw fail(409, missing, 'not_ready');
  if (!['draft', 'changes_requested', 'needs_owner', 'failed'].includes(a.status)) throw fail(409, `El encargo está ${ASSIGNMENT_STATUS_LABEL[a.status]}: no se prepara otra ejecución.`, 'invalid_state');
  const cur = a.processId ? processesRepo(slug).get(a.processId) : undefined;
  if (cur && (cur.status === 'running' || cur.status === 'pending_authorization')) throw fail(409, 'El encargo ya tiene una ejecución en marcha o pendiente de autorizar.', 'active_process');
  const iterationContext = a.iterationNote ? iterationContextOf(slug, a) : null;
  const p = createWorkProcess(slug, a.projectId, assignmentAsItem(a), { iterationContext }, { assignmentId: a.id });
  a = repo.update(id, x => {
    x.processId = p.id; x.processIds = [...x.processIds.filter(y => y !== p.id), p.id]; x.status = 'pending_authorization'; x.reason = null;
    x.events.push({ at: monotonicNow(), kind: 'prepared', processId: p.id, message: `Ejecución preparada (${p.steps.length} paso(s), ≈ ${p.estimatedUsd.toFixed(2)} USD de API si todo fuera por la API): espera tu autorización.` });
  });
  return { assignment: a, process: p };
}

/** Lo que una nueva iteración recibe: la nota del propietario y lo que dejó la anterior (sin repetir historiales completos). */
function iterationContextOf(slug: string, a: Assignment): string {
  const prev = a.processId ? processesRepo(slug).get(a.processId) : undefined; const r = prev?.result;
  const open = (r?.gauntlet?.rounds.at(-1)?.findings ?? []).filter(f => f.severity !== 'minor').map(f => `- [${f.severity}] ${f.text}${f.file ? ` (${f.file})` : ''}`);
  return [
    `Nota del propietario (cambios pedidos): ${a.iterationNote}`,
    a.outcome?.summary ? `Resultado anterior: ${a.outcome.summary.slice(0, 1500)}` : '',
    r?.review ? `QA anterior: ${r.review.verdict}${r.review.summary ? ` — ${r.review.summary.slice(0, 600)}` : ''}` : '',
    open.length ? `Hallazgos del Evaluador sin resolver:\n${open.slice(0, 8).join('\n')}` : '',
    `Criterios de aceptación vigentes:\n${a.criteria.map(c => `- ${c}`).join('\n')}`
  ].filter(Boolean).join('\n\n');
}

/** Estimación previa (sin IA): equipo, pasos y USD si todo fuera por la API. */
export function estimateAssignment(slug: string, id: string) {
  const a = assignmentsRepo(slug).get(id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  return estimateWork(slug, a.projectId, assignmentAsItem(a));
}

/**
 * Sincroniza el encargo con su proceso actual. Las decisiones del propietario (aceptado, cancelado) no se pisan.
 * Al terminar técnicamente se registra el resultado (con evidencia) y un documento en Conocimiento, una sola vez.
 */
export function syncAssignment(slug: string, id: string): Assignment | null {
  const repo = assignmentsRepo(slug); const a = repo.get(id); if (!a) return null;
  if (a.status === 'accepted' || a.status === 'cancelled' || a.status === 'draft') return a;
  const p = a.processId ? processesRepo(slug).get(a.processId) : undefined; if (!p) return a;
  if (a.status === 'changes_requested' && p.status !== 'running' && p.status !== 'pending_authorization') return a;
  const pl = p.result?.pipeline;
  let status: AssignmentStatus; let reason: string | null = null;
  if (p.status === 'pending_authorization') status = 'pending_authorization';
  else if (p.status === 'running') status = 'running';
  else if (p.result?.rejected) { status = 'needs_owner'; reason = 'Rechazaste el diff de esta ejecución: pide cambios para otra iteración o cancela el encargo.'; }
  else if (p.status === 'done' && (pl ? pl.state === 'verified' : !!p.result?.applied)) status = 'ready_for_review';
  else if (p.status === 'failed') { status = 'failed'; reason = p.error ?? 'El proceso falló.'; }
  else { status = 'needs_owner'; reason = pl?.reason ?? p.error ?? (p.status === 'cancelled' ? 'Ejecución cancelada.' : 'El pipeline se detuvo.'); }
  if (status === a.status && reason === a.reason && !(status === 'ready_for_review' && !a.outcome)) return a;
  const updated = repo.update(id, x => {
    x.status = status; x.reason = reason;
    x.events.push({ at: monotonicNow(), kind: 'status', processId: p.id, message: `${ASSIGNMENT_STATUS_LABEL[status]}${reason ? `: ${reason.slice(0, 300)}` : ''}` });
    if (status === 'ready_for_review') x.outcome = outcomeOf(slug, p);
  });
  if (status === 'ready_for_review' && !updated.knowledgeDocId) recordKnowledge(slug, updated, p);
  return repo.get(id);
}

/** Resultado con evidencia: solo lo que el proceso dejó registrado (nunca un éxito sin verificación). */
function outcomeOf(slug: string, p: Process): AssignmentOutcome {
  const r = p.result!; const last = (cmd: string) => verificationsForApplied(r).filter(v => v.command === cmd).at(-1);
  const g = r.gauntlet ?? null;
  return {
    summary: r.implementationSummary ?? null, userFacing: r.userFacing ?? null,
    branch: r.applied?.branch ?? null, commit: r.applied?.commit ?? null, worktree: r.applied?.worktree ?? null,
    verifications: (['typecheck', 'test', 'build'] as const).map(c => last(c)).filter(Boolean).map(v => ({ command: v!.command, exitCode: v!.exitCode, isolation: v!.isolation ?? null })),
    qa: r.review?.verdict ?? null,
    gauntlet: g ? { mode: g.mode, status: g.status, rounds: g.rounds.length, openFindings: (g.rounds.at(-1)?.findings ?? []).filter(f => f.severity !== 'minor').length } : null,
    agents: Array.from(new Map(p.steps.map(s => [s.agentId, { name: s.agentName, role: s.role ?? 'implementer' }])).values()),
    calls: callMetricsRepo(slug).list({ processIds: [p.id] }).length, spentUsd: p.spentUsd, recordedAt: monotonicNow()
  };
}

/** Historial de la empresa: qué se hizo, quién, con qué evidencia; los agentes autorizados lo encuentran en Conocimiento. */
function recordKnowledge(slug: string, a: Assignment, p: Process) {
  const o = a.outcome!;
  const body = [
    `# Encargo ${a.code} · ${a.title}`,
    `**Petición del propietario:** ${a.request}`,
    `**Objetivo:** ${a.objective}`,
    `**Criterios de aceptación:**\n${a.criteria.map(c => `- ${c}`).join('\n')}`,
    `**Resultado técnico** (proceso ${p.id}): ${o.summary ?? 'sin resumen'}`,
    o.userFacing ? `**Para el propietario:** ${o.userFacing}` : '',
    `**Evidencia:** ${o.verifications.map(v => `${v.command} ${v.exitCode === 0 ? 'en verde' : `con código ${v.exitCode}`} (${v.isolation ?? '?'})`).join(' · ') || 'sin verificaciones registradas'}; QA: ${o.qa ?? '—'}; Gauntlet: ${o.gauntlet ? `${o.gauntlet.mode}, ${o.gauntlet.status}, ${o.gauntlet.rounds} ronda(s), ${o.gauntlet.openFindings} hallazgo(s) mayores abiertos` : 'no aplicado'}.`,
    `**Rama y commit:** ${o.branch ?? '—'} · ${o.commit ?? '—'} (sin integrar en main hasta que lo decidas).`,
    `**Agentes:** ${o.agents.map(x => `${x.name} (${x.role})`).join(', ')}.`,
    `**Uso:** ${o.calls} llamada(s) registradas; ${o.spentUsd.toFixed(2)} USD de API.`,
    'Estado: listo para la revisión del propietario. No es una lección: las lecciones se validan aparte.'
  ].filter(Boolean).join('\n\n');
  const doc = knowledgeRepo(slug).add({ projectId: a.projectId, title: `Encargo ${a.code} · ${a.title}`, body, authorAgentId: null, authorAgentName: 'Portal IA (registro del encargo)', processId: p.id });
  assignmentsRepo(slug).update(a.id, x => { x.knowledgeDocId = doc.id; x.events.push({ at: monotonicNow(), kind: 'knowledge', message: `Registrado en Conocimiento: «${doc.title}».` }); });
}

/**
 * Aceptación del propietario (distinta de QA): la MISMA regla de cierre que una historia (integrado en la rama
 * principal, activo y verificado en ejecución si es el propio Portal, prueba manual hecha). No integra ni publica.
 */
export async function acceptAssignment(slug: string, id: string, note: string | null): Promise<Assignment> {
  const a = syncAssignment(slug, id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  if (a.status !== 'ready_for_review') throw fail(409, `Solo se acepta un encargo listo para revisar (está ${ASSIGNMENT_STATUS_LABEL[a.status]}).`, 'invalid_state');
  const blocker = await closingBlocker(slug, a.processId ? processesRepo(slug).get(a.processId) : undefined, 'encargo');
  if (blocker) throw fail(409, blocker.error, blocker.code);
  return assignmentsRepo(slug).update(id, x => { x.status = 'accepted'; x.reason = note; x.events.push({ at: monotonicNow(), kind: 'accepted', message: `Aceptado por el propietario${note ? `: ${note}` : ''}. Integrar en main sigue siendo una decisión aparte.` }); });
}

/** Pedir cambios: queda la nota; la siguiente ejecución se prepara con ella (y se autoriza aparte). */
export function requestAssignmentChanges(slug: string, id: string, note: string): Assignment {
  const a = syncAssignment(slug, id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  if (!['ready_for_review', 'needs_owner', 'failed'].includes(a.status)) throw fail(409, `No se piden cambios a un encargo ${ASSIGNMENT_STATUS_LABEL[a.status]}.`, 'invalid_state');
  return assignmentsRepo(slug).update(id, x => { x.status = 'changes_requested'; x.iterationNote = note.trim().slice(0, 2000); x.events.push({ at: monotonicNow(), kind: 'changes', message: `Cambios pedidos: ${note.slice(0, 300)}` }); });
}

/** Cancelar el encargo (no borra nada: el proceso y su worktree se conservan para consulta). */
export function cancelAssignment(slug: string, id: string): Assignment {
  const a = assignmentsRepo(slug).get(id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  const p = a.processId ? processesRepo(slug).get(a.processId) : undefined;
  if (p?.status === 'running') throw fail(409, 'El encargo está en marcha: cancela su proceso primero (se detiene entre pasos).', 'running');
  if (p?.status === 'pending_authorization') processesRepo(slug).finish(p.id, 'cancelled', 'Encargo cancelado por el propietario.');
  return assignmentsRepo(slug).update(id, x => { x.status = 'cancelled'; x.events.push({ at: monotonicNow(), kind: 'cancelled', message: 'Cancelado por el propietario.' }); });
}

/** Vista con el estado real del proceso (sin IA). */
export function assignmentView(slug: string, id: string) {
  const a = syncAssignment(slug, id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  const p = a.processId ? processesRepo(slug).get(a.processId) : undefined;
  return {
    ...a, statusLabel: ASSIGNMENT_STATUS_LABEL[a.status],
    process: p ? { id: p.id, status: p.status, spentUsd: p.spentUsd, budgetUsd: p.budgetUsd, estimatedUsd: p.estimatedUsd, steps: p.steps.length,
      pipeline: p.result?.pipeline ? { state: p.result.pipeline.state, phase: p.result.pipeline.phase, reason: p.result.pipeline.reason ?? null, corrections: p.result.pipeline.corrections } : null } : null
  };
}

// ---------------------------------------------------------------- Autorización (crea el proceso y lo autoriza en el mismo acto)

/** Tope de llamadas a la suscripción sugerido: un paso por miembro, correcciones (Desarrollador + QA) y margen del Gauntlet. */
const suggestedCalls = (steps: number, corrections: number) => Math.min(400, steps + corrections * 2 + 6);

/** Lo que se autoriza, ANTES de autorizar (sin IA): equipo, pasos, USD si fuera por la API, Gauntlet resuelto y suscripción. */
export function assignmentAuthorizationPreview(slug: string, id: string) {
  const a = assignmentsRepo(slug).get(id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  const missing = assignmentReady(a);
  const est = estimateWork(slug, a.projectId, assignmentAsItem(a));
  const prev = a.processIds.map(pid => processesRepo(slug).get(pid)).filter(Boolean) as Process[];
  // La misma resolución que al autorizar (mismo texto del elemento de trabajo y mismo historial): lo que ves es lo que corre.
  const g = resolveGauntletFor(slug, { id: '', projectId: a.projectId, backlogItemId: null, assignmentId: a.id }, projectGauntlet(slug, a.projectId));
  const agents = est.steps.map(s => ({ name: s.agentName, role: s.role, model: s.model }));
  return { missing, estimatedUsd: est.estimatedUsd, suggestedBudgetUsd: est.suggestedBudgetUsd, steps: est.steps.length, agents, gauntlet: g, suggestedSubscriptionCalls: suggestedCalls(est.steps.length, DEFAULT_PIPELINE.maxCorrections), subscription: subscriptionGate() };
}

/**
 * El propietario autoriza el encargo: se crea el proceso (mismo motor que una historia) y se autoriza en el mismo acto
 * con la autorización única (processAuthorization). Si no puede empezar, el proceso recién creado se cancela con el
 * motivo: nunca queda un proceso pendiente que otra pantalla pudiera ejecutar con otros límites.
 */
export function authorizeAssignment(slug: string, id: string, input: { budgetUsd: number; maxSubscriptionCalls?: number | null; maxCorrections?: number | null; gauntlet?: { mode: 'off' | 'standard' | 'deep' | 'auto' } | null; allowInstall?: boolean }, log: (o: any, m: string) => void): { assignment: Assignment; process: Process } {
  if (processesRepo(slug).running().length) throw fail(409, 'Ya hay un proceso en ejecución. Espera a que termine.', 'busy');
  const { assignment, process } = prepareAssignment(slug, id);
  const maxCorrections = input.maxCorrections ?? DEFAULT_PIPELINE.maxCorrections;
  try {
    const p = authorizeProcess(slug, process.id, { budgetUsd: input.budgetUsd, pipeline: { ...DEFAULT_PIPELINE, maxCorrections, allowInstall: !!input.allowInstall, maxSubscriptionCalls: input.maxSubscriptionCalls ?? suggestedCalls(process.steps.length, maxCorrections), gauntlet: input.gauntlet ?? projectGauntlet(slug, assignment.projectId) } }, log);
    const a = assignmentsRepo(slug).update(id, x => { x.status = 'running'; x.events.push({ at: monotonicNow(), kind: 'authorized', processId: p.id, message: `Autorizado por el propietario (hasta ${input.budgetUsd} USD de API${p.result?.pipeline?.config.maxSubscriptionCalls ? ` y ${p.result.pipeline.config.maxSubscriptionCalls} llamadas a la suscripción` : ''}; Gauntlet ${p.result?.pipeline?.config.gauntlet?.mode ?? 'off'}${p.result?.pipeline?.config.gauntlet?.auto ? ` (automático: ${p.result.pipeline.config.gauntlet.auto.reason})` : ''}).` }); });
    return { assignment: a, process: p };
  } catch (e: any) {
    processesRepo(slug).finish(process.id, 'cancelled', `No se inició: ${e.message}`);
    assignmentsRepo(slug).update(id, x => { x.status = 'needs_owner'; x.reason = e.message; x.events.push({ at: monotonicNow(), kind: 'status', processId: process.id, message: `No se inició: ${String(e.message).slice(0, 300)}` }); });
    throw e;
  }
}

/** Editar el encargo mientras no se está ejecutando (objetivo, criterios, tamaño): sin IA. */
export function updateAssignment(slug: string, id: string, patch: Partial<Pick<Assignment, 'title' | 'objective' | 'criteria' | 'outOfScope' | 'size'>>): Assignment {
  const a = assignmentsRepo(slug).get(id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  if (a.status === 'running' || a.status === 'pending_authorization') throw fail(409, 'No se edita un encargo en marcha.', 'running');
  return assignmentsRepo(slug).update(id, x => { Object.assign(x, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))); });
}

export function listAssignments(slug: string, projectId?: string) { return assignmentsRepo(slug).list(projectId).map(a => assignmentView(slug, a.id)); }

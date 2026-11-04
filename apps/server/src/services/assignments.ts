import { ownerRoundPossible, prepareOwnerRound } from './storyUnits.ts';
import { ASSIGNMENT_STATUS_LABEL, DEFAULT_PIPELINE, assignmentReady, mergeAcknowledgementsOf, verificationPassed, verificationsForApplied, type Assignment, type AssignmentOutcome, type AssignmentStatus, type Process, INTERNAL_WORKSPACE } from '@portal-ia/domain';
import { sameWorkRunning } from './executionLocks.ts';
import { monotonicNow } from '../clock.ts';
import { assignmentsRepo } from '../db/assignments.ts';
import { knowledgeRepo, onProcessFinish, processesRepo, projectsRepo } from '../db/workspace.ts';
import { callMetricsRepo } from '../db/callMetrics.ts';
import { createWorkProcess, estimateWork } from './storyExecution.ts';
import { assignmentAsItem, onAssignmentStatus } from './workItems.ts';
import { closingBlocker } from './closing.ts';
import { discardBranch } from './repoWrite.ts';
import { requirePolicy } from './executionPolicy.ts';
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

/** Lo que impide preparar otra ejecución (sin tocar nada): objetivo y criterios, estado y ejecución activa. */
function checkPreparable(slug: string, a: Assignment): void {
  const missing = assignmentReady(a); if (missing) throw fail(409, missing, 'not_ready');
  if (!['draft', 'changes_requested', 'needs_owner', 'failed'].includes(a.status)) throw fail(409, `El encargo está ${ASSIGNMENT_STATUS_LABEL[a.status]}: no se prepara otra ejecución.`, 'invalid_state');
  const cur = a.processId ? processesRepo(slug).get(a.processId) : undefined;
  if (cur && (cur.status === 'running' || cur.status === 'pending_authorization')) throw fail(409, 'El encargo ya tiene una ejecución en marcha o pendiente de autorizar.', 'active_process');
}

/**
 * La iteración cuya versión sigue aplicada sin integrar (su worktree tiene la rama del encargo). Se buscan todas, no
 * solo la vigente: una autorización fallida no debe ocultarla. Mientras exista, otra ejecución chocaría con su rama.
 */
function appliedVersion(slug: string, a: Assignment): Process | null {
  for (const pid of [...a.processIds].reverse()) { const p = processesRepo(slug).get(pid); if (p?.result?.applied?.worktree && !p.result.merged && !p.result.rejected) return p; }
  return null;
}

/** Descarta esa versión con tu confirmación: retira su worktree y su rama (nunca el checkout principal) y la marca rechazada. */
async function discardAppliedVersion(slug: string, a: Assignment, p: Process, reason: string): Promise<string> {
  const branch = p.result!.applied!.branch; let discarded = '';
  const repo = projectsRepo(slug).repository(a.projectId);
  if (repo) {
    requirePolicy('delete_worktree', { slug, processId: p.id, projectId: a.projectId, authorized: true });
    const d = await discardBranch(repo.path, p.id, branch);
    discarded = ` Versión anterior descartada: worktree ${d.worktreeRemoved ? 'retirado' : 'ya no existía'}, rama ${branch} ${d.branchDeleted ? 'borrada' : 'conservada (integrada o activa)'}.`;
  }
  processesRepo(slug).setResult(p.id, { ...p.result!, rejected: { at: monotonicNow(), reason } });
  return discarded;
}

/**
 * Prepara la ejecución: el mismo proceso que una historia (equipo por capacidades, estimación), pendiente de TU
 * autorización. No llama a la IA. Exige objetivo y criterios comprobables.
 */
export function prepareAssignment(slug: string, id: string): { assignment: Assignment; process: Process } {
  const repo = assignmentsRepo(slug); let a = repo.get(id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  checkPreparable(slug, a);
  const applied = appliedVersion(slug, a);
  if (applied) throw fail(409, `La versión anterior está aplicada en ${applied.result!.applied!.branch} sin integrar: otra ejecución chocaría con su rama. Para ejecutar la nueva, descártala (worktree y rama): confírmalo explícitamente.`, 'discard_confirmation_required');
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
  if (updated.conversationId && (status === 'ready_for_review' || status === 'needs_owner' || status === 'failed')) {
    try { const msg = resultMessage(slug, repo.get(id)!, p); if (msg) resultNotifier?.(updated.conversationId, msg); } catch { /* la conversación ya no existe: el encargo conserva su estado */ }
  }
  return repo.get(id);
}

/** Quién publica el resultado en la conversación (lo registra el Asistente al cargar: sin dependencia circular). */
let resultNotifier: ((conversationId: string, markdown: string) => void) | null = null;
export function onAssignmentResult(fn: (conversationId: string, markdown: string) => void) { resultNotifier = fn; }

/** Texto que viene del modelo o de un proceso, tal cual dentro del markdown del chat (sin formato que pueda fingir otra cosa). */
const plainMd = (s: string) => s.replace(/[`*_[\]<>#|~\\]/g, ' ').replace(/\s+/g, ' ').trim();
/**
 * Lo que el Asistente comunica cuando un encargo termina, se detiene o falla: SOLO lo que el proceso registró (archivos,
 * commit, verificación con su línea base, QA, Gauntlet) y el siguiente paso EXACTO con los botones que tiene su tarjeta.
 * Sin IA: no puede adornar ni inventar un resultado. null = no hay nada que decir (ya integrado, o lo rechazaste tú).
 */
export function resultMessage(slug: string, a: Assignment, p: Process): string | null {
  const r = p.result;
  if (r?.merged || r?.rejected) return null;
  const files = (r?.changes ?? []).filter(c => !c.error);
  const runs = r?.applied ? verificationsForApplied(r) : [];
  const ev = (['typecheck', 'test', 'build'] as const).map(c => { const v = runs.filter(x => x.command === c).at(-1); return !v ? `${c}: sin ejecutar` : v.exitCode === 0 ? `${c} ✓` : verificationPassed(v) ? `${c} ✓ sin fallos nuevos (${v.triage!.preexisting.length} ya fallaban antes de este cambio)` : v.exitCode === 86 ? `${c}: bloqueado (faltan dependencias)` : v.exitCode === null ? `${c}: no terminó` : `${c} ✗`; }).join(' · ');
  const head = `**${a.code} · ${plainMd(a.title)}`;
  const QA: Record<string, string> = { approved: 'aprobada', rejected: 'rechazada', unable_to_verify: 'no pudo verificar', blocked_environment: 'bloqueada por el entorno' };
  if (a.status === 'ready_for_review') return [
    `${head}: terminado y verificado, listo para tu revisión.**`,
    `${files.length} archivo(s) en la rama \`${plainMd(r?.applied?.branch ?? '—')}\` (commit \`${r?.applied?.commit?.slice(0, 7) ?? '—'}\`): ${files.slice(0, 5).map(c => plainMd(c.path)).join(', ')}${files.length > 5 ? ` y ${files.length - 5} más` : ''}.`,
    `Sandbox: ${ev}. QA: ${QA[r?.review?.verdict ?? ''] ?? '—'}.`,
    `**Siguiente paso:** en la tarjeta de ${a.code}, revisa el diff y pulsa «Integrar en main»${slug === INTERNAL_WORKSPACE.slug ? '; después, «Reconstruir y reiniciar» en la barra superior para verlo en marcha' : ''}. Nada se ha integrado todavía.`
  ].join('\n\n');
  const resumable = !!r?.pipeline && (r.pipeline.state === 'paused' || r.pipeline.state === 'stopped') && (!!r.applied || !!r.manifest);
  const question = r?.pipeline?.ownerRequest?.question ?? null;
  const kept = r?.applied ? ` Lo hecho se conserva en su rama (\`${plainMd(r.applied.branch)}\`).` : '';
  const verif = runs.length ? `\n\nÚltima verificación: ${ev}.` : '';
  if (a.status === 'failed') return `${head}: falló.** ${plainMd(a.reason ?? '')}${kept}${verif}\n\n**En su tarjeta:** «Autorizar y ejecutar» de nuevo (otra ejecución con lo que necesite) o «cancelar el encargo».`;
  const next = question ? `el equipo te pregunta: «${plainMd(question)}». Contéstala en su proceso (enlace en la tarjeta) y seguirá sin repetir nada.` : resumable ? '«Continuar» lo retoma donde quedó (puedes añadir llamadas a la suscripción), o «cancelar el encargo».' : '«Autorizar y ejecutar» de nuevo, o «cancelar el encargo».';
  return `${head}: se detuvo y necesita tu decisión.** ${plainMd(a.reason ?? '')}${kept}${verif}\n\n**En su tarjeta:** ${next}`;
}

/** Resultado con evidencia: solo lo que el proceso dejó registrado (nunca un éxito sin verificación). */
function outcomeOf(slug: string, p: Process): AssignmentOutcome {
  const r = p.result!; const last = (cmd: string) => verificationsForApplied(r).filter(v => v.command === cmd).at(-1);
  const g = r.gauntlet ?? null;
  return {
    summary: r.implementationSummary ?? null, userFacing: r.userFacing ?? null,
    branch: r.applied?.branch ?? null, commit: r.applied?.commit ?? null, worktree: r.applied?.worktree ?? null,
    verifications: (['typecheck', 'test', 'build'] as const).map(c => last(c)).filter(Boolean).map(v => ({ command: v!.command, exitCode: v!.exitCode, isolation: v!.isolation ?? null, triage: v!.triage ?? null })),
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
    `**Evidencia:** ${o.verifications.map(v => `${v.command} ${v.exitCode === 0 ? 'en verde' : verificationPassed(v) ? 'en verde frente a la base (solo fallos preexistentes)' : `con código ${v.exitCode}`} (${v.isolation ?? '?'})`).join(' · ') || 'sin verificaciones registradas'}; QA: ${o.qa ?? '—'}; Gauntlet: ${o.gauntlet ? `${o.gauntlet.mode}, ${o.gauntlet.status}, ${o.gauntlet.rounds} ronda(s), ${o.gauntlet.openFindings} hallazgo(s) mayores abiertos` : 'no aplicado'}.`,
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
/** Aceptar (listo para revisar). Si le falta un paso de la regla de cierre, solo con el motivo del propietario (queda en la nota). */
export async function acceptAssignment(slug: string, id: string, note: string | null, opts: { ownerReason?: string | null } = {}): Promise<Assignment> {
  const a = syncAssignment(slug, id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  if (a.status !== 'ready_for_review') throw fail(409, `Solo se acepta un encargo listo para revisar (está ${ASSIGNMENT_STATUS_LABEL[a.status]}).`, 'invalid_state');
  const blocker = await closingBlocker(slug, a.processId ? processesRepo(slug).get(a.processId) : undefined, 'encargo');
  if (blocker && (opts.ownerReason ?? '').trim().length < 3) throw fail(409, blocker.error, blocker.code);
  return assignmentsRepo(slug).update(id, x => { x.status = 'accepted'; x.reason = note; x.events.push({ at: monotonicNow(), kind: 'accepted', message: `Aceptado por el propietario${note ? `: ${note}` : ''}. Integrar en main sigue siendo una decisión aparte.` }); });
}

/** Pedir cambios: queda la nota; la siguiente ejecución se prepara con ella (y se autoriza aparte). */
/**
 * Pedir cambios (acto explícito del propietario, como iterar una historia): la versión entregada y NO integrada se
 * descarta (se retira su worktree y su rama sin integrar; nunca el checkout principal) y queda la nota; la siguiente
 * ejecución parte de main con la nota y el resultado anterior como contexto, y se autoriza aparte.
 */
export async function requestAssignmentChanges(slug: string, id: string, note: string, opts: { discardApplied?: boolean } = {}): Promise<Assignment> {
  const a = syncAssignment(slug, id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  if (!['ready_for_review', 'needs_owner', 'failed'].includes(a.status)) throw fail(409, `No se piden cambios a un encargo ${ASSIGNMENT_STATUS_LABEL[a.status]}.`, 'invalid_state');
  const p = a.processId ? processesRepo(slug).get(a.processId) : undefined;
  // Entrega incremental sin integrar: los cambios van como una ronda dirigida sobre SU rama (no se descarta ni se rehace
  // lo verificado); se aplica al continuar el proceso, con su misma autorización (topes de llamadas y de API).
  if (ownerRoundPossible(p) && !p!.result?.pipeline?.ownerRequest) {
    prepareOwnerRound(slug, p!.id, note);
    return assignmentsRepo(slug).update(id, x => { x.iterationNote = note.trim().slice(0, 2000); x.events.push({ at: monotonicNow(), kind: 'changes', processId: p!.id, message: `Cambios pedidos sobre su rama (sin descartarla): ${note.slice(0, 300)}. Se aplican al continuar, con la misma autorización.` }); });
  }
  const applied = appliedVersion(slug, a);
  let discarded = '';
  if (applied) {
    if (!opts.discardApplied) throw fail(409, `La versión entregada está aplicada en ${applied.result!.applied!.branch} sin integrar. Pedir cambios la descarta (worktree y rama): confírmalo explícitamente.`, 'discard_confirmation_required');
    discarded = await discardAppliedVersion(slug, a, applied, 'descartada al pedir cambios: la siguiente ejecución parte de main con la nota del propietario');
  }
  return assignmentsRepo(slug).update(id, x => { x.status = 'changes_requested'; x.iterationNote = note.trim().slice(0, 2000); x.events.push({ at: monotonicNow(), kind: 'changes', processId: p?.id, message: `Cambios pedidos: ${note.slice(0, 300)}.${discarded}` }); });
}

/** Cancelar el encargo (no borra nada: el proceso y su worktree se conservan para consulta). */
export function cancelAssignment(slug: string, id: string, reason: string | null = null): Assignment {
  const a = assignmentsRepo(slug).get(id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  const p = a.processId ? processesRepo(slug).get(a.processId) : undefined;
  if (p?.status === 'running') throw fail(409, 'El encargo está en marcha: cancela su proceso primero (se detiene entre pasos).', 'running');
  const out = assignmentsRepo(slug).update(id, x => { x.status = 'cancelled'; if (reason) x.reason = reason; x.events.push({ at: monotonicNow(), kind: 'cancelled', message: `Cancelado por el propietario${reason ? `: ${reason}` : '.'}` }); });
  if (p?.status === 'pending_authorization') processesRepo(slug).finish(p.id, 'cancelled', 'Encargo cancelado por el propietario.');
  return out;
}

/** Vista con el estado real del proceso (sin IA). */
export function assignmentView(slug: string, id: string) {
  const a = syncAssignment(slug, id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  const p = a.processId ? processesRepo(slug).get(a.processId) : undefined;
  return {
    ...a, statusLabel: ASSIGNMENT_STATUS_LABEL[a.status],
    process: p ? { id: p.id, status: p.status, spentUsd: p.spentUsd, budgetUsd: p.budgetUsd, estimatedUsd: p.estimatedUsd, steps: p.steps.length,
      // En pausa con trabajo conservado: «Continuar» la retoma donde quedó (autorizar de nuevo la descartaría).
      resumable: p.status === 'done' && !!p.result?.pipeline && (p.result.pipeline.state === 'paused' || p.result.pipeline.state === 'stopped') && !p.result.merged && !p.result.rejected && (!!p.result.applied || !!p.result.manifest),
      ownerRound: ownerRoundPossible(p) && !p.result?.pipeline?.ownerRequest,
      // El equipo espera una respuesta tuya: se contesta en su proceso (Continuar sin ella se rechaza).
      question: p.result?.pipeline?.ownerRequest?.question ?? null,
      pipeline: p.result?.pipeline ? { state: p.result.pipeline.state, phase: p.result.pipeline.phase, reason: p.result.pipeline.reason ?? null, corrections: p.result.pipeline.corrections } : null,
      changes: (p.result?.changes ?? []).filter(c => !c.error).slice(0, 60).map(c => ({ path: c.path, action: c.action, before: c.before, after: c.after })),
      applied: p.result?.applied ? { branch: p.result.applied.branch, commit: p.result.applied.commit } : null,
      merged: p.result?.merged ? { commit: p.result.merged.commit, into: p.result.merged.into, mergedAt: p.result.merged.mergedAt } : null,
      checks: p.result?.applied ? (['typecheck', 'test', 'build'] as const).map(c => verificationsForApplied(p.result!).filter(v => v.command === c).at(-1)).filter(Boolean).map(v => ({ command: v!.command, exitCode: v!.exitCode, isolation: v!.isolation ?? null, passed: verificationPassed(v), preexisting: v!.triage && !v!.triage.unavailable ? v!.triage.preexisting.length : 0 })) : [],
      qa: p.result?.review?.verdict ?? null, gauntlet: p.result?.gauntlet?.status ?? null, ack: mergeAcknowledgementsOf(p) } : null
  };
}

// ---------------------------------------------------------------- Autorización (crea el proceso y lo autoriza en el mismo acto)

/** Tope de llamadas a la suscripción sugerido: un paso por miembro, correcciones (Desarrollador + QA) y margen del Gauntlet. */
/**
 * Tope de llamadas a la suscripción sugerido. Antes (pasos + 2 por corrección + 6, ≈ 13–15) se quedaba corto en encargos
 * normales: no contaba las unidades de la entrega incremental (hasta 6), la revisión del plan, QA tras cada corrección ni
 * las rondas del Gauntlet, y casi todos se pausaban por el tope. Sigue siendo un tope (editable), no una estimación.
 */
const suggestedCalls = (steps: number, corrections: number) => Math.min(400, steps + 14 + corrections * 6);

/** Lo que se autoriza, ANTES de autorizar (sin IA): equipo, pasos, USD si fuera por la API, Gauntlet resuelto y suscripción. */
export function assignmentAuthorizationPreview(slug: string, id: string) {
  const a = assignmentsRepo(slug).get(id); if (!a) throw fail(404, 'Encargo no encontrado.', 'not_found');
  const missing = assignmentReady(a);
  const est = estimateWork(slug, a.projectId, assignmentAsItem(a));
  const prev = a.processIds.map(pid => processesRepo(slug).get(pid)).filter(Boolean) as Process[];
  // La misma resolución que al autorizar (mismo texto del elemento de trabajo y mismo historial): lo que ves es lo que corre.
  const g = resolveGauntletFor(slug, { id: '', projectId: a.projectId, backlogItemId: null, assignmentId: a.id }, projectGauntlet(slug, a.projectId));
  const agents = est.steps.map(s => ({ name: s.agentName, role: s.role, model: s.model }));
  return { missing, estimatedUsd: est.estimatedUsd, suggestedBudgetUsd: est.suggestedBudgetUsd, steps: est.steps.length, agents, gauntlet: g, suggestedSubscriptionCalls: suggestedCalls(est.steps.length, DEFAULT_PIPELINE.maxCorrections), subscription: subscriptionGate(), discardBranch: appliedVersion(slug, a)?.result?.applied?.branch ?? null };
}

/**
 * El propietario autoriza el encargo: se crea el proceso (mismo motor que una historia) y se autoriza en el mismo acto
 * con la autorización única (processAuthorization). Si no puede empezar, el proceso recién creado se cancela con el
 * motivo: nunca queda un proceso pendiente que otra pantalla pudiera ejecutar con otros límites.
 */
export async function authorizeAssignment(slug: string, id: string, input: { budgetUsd: number; maxSubscriptionCalls?: number | null; maxCorrections?: number | null; gauntlet?: { mode: 'off' | 'standard' | 'deep' | 'auto' } | null; allowInstall?: boolean; discardApplied?: boolean }, log: (o: any, m: string) => void): Promise<{ assignment: Assignment; process: Process }> {
  const before = assignmentsRepo(slug).get(id); if (!before) throw fail(404, 'Encargo no encontrado.', 'not_found');
  // Solo otro proceso de ESTE encargo impide empezar (no los de otras historias o encargos).
  { const busy = sameWorkRunning(slug, { id: '', backlogItemId: null, assignmentId: id }); if (busy) throw fail(409, `Este encargo ya tiene un proceso en ejecución («${busy.title}»). Espera a que termine.`, 'busy'); }
  // Lo que impide empezar se comprueba ANTES de descartar nada; sin tu confirmación no se crea ni se paga nada.
  checkPreparable(slug, before);
  const applied = appliedVersion(slug, before);
  if (applied) {
    if (!input.discardApplied) throw fail(409, `La versión anterior está aplicada en ${applied.result!.applied!.branch} sin integrar: otra ejecución chocaría con su rama. Para ejecutar la nueva, descártala (worktree y rama): confírmalo explícitamente.`, 'discard_confirmation_required');
    const discarded = await discardAppliedVersion(slug, before, applied, 'descartada al autorizar otra ejecución: la nueva parte de main');
    assignmentsRepo(slug).update(id, x => { x.events.push({ at: monotonicNow(), kind: 'status', processId: applied.id, message: `Para ejecutar otra versión, descartaste la anterior.${discarded}` }); });
  }
  const { assignment, process } = prepareAssignment(slug, id);
  const maxCorrections = input.maxCorrections ?? DEFAULT_PIPELINE.maxCorrections;
  try {
    const p = authorizeProcess(slug, process.id, { budgetUsd: input.budgetUsd, pipeline: { ...DEFAULT_PIPELINE, maxCorrections, allowInstall: !!input.allowInstall, maxSubscriptionCalls: input.maxSubscriptionCalls ?? suggestedCalls(process.steps.length, maxCorrections), gauntlet: input.gauntlet ?? projectGauntlet(slug, assignment.projectId) } }, log);
    const a = assignmentsRepo(slug).update(id, x => { x.status = 'running'; x.events.push({ at: monotonicNow(), kind: 'authorized', processId: p.id, message: `Autorizado por el propietario (hasta ${input.budgetUsd} USD de API${p.result?.pipeline?.config.maxSubscriptionCalls ? ` y ${p.result.pipeline.config.maxSubscriptionCalls} llamadas a la suscripción` : ''}; Gauntlet ${p.result?.pipeline?.config.gauntlet?.mode ?? 'off'}${p.result?.pipeline?.config.gauntlet?.auto ? ` (automático: ${p.result.pipeline.config.gauntlet.auto.reason})` : ''}).` }); });
    return { assignment: a, process: p };
  } catch (e: any) {
    processesRepo(slug).unsupersedeBy(process.id); // la iteración anterior vuelve a ser la vigente
    processesRepo(slug).finish(process.id, 'cancelled', `No se inició: ${e.message}`);
    // La cancelada no pasa a ser la vigente: la siguiente iteración parte de la anterior (su resultado y su contexto).
    assignmentsRepo(slug).update(id, x => { x.processId = before.processId; });
    if (assignmentsRepo(slug).get(id)?.status !== 'needs_owner') assignmentsRepo(slug).update(id, x => { x.status = 'needs_owner'; x.reason = e.message; x.events.push({ at: monotonicNow(), kind: 'status', processId: process.id, message: `No se inició: ${String(e.message).slice(0, 300)}` }); });
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

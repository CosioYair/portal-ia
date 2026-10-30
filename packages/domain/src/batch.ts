import type { GauntletConfig } from './gauntlet.ts';
import type { BacklogStatus, PipelinePauseKind } from './types.ts';

/**
 * Ejecución continua del backlog (lote autorizado). El propietario autoriza UNA vez un alcance explícito (historias,
 * orden, equipo y orígenes, presupuesto total y por historia, duración, correcciones, modo Gauntlet, concurrencia y
 * operaciones git); el coordinador del lote (determinista, sin IA) planifica dependencias y orden seguro, ejecuta cada
 * historia con el pipeline existente, serializa la integración y la activación, clasifica los fallos sin detener lo
 * independiente y deja cada historia lista para la ACEPTACIÓN del propietario, que es distinta de QA.
 */

export type BatchStatus = 'running' | 'paused' | 'completed' | 'cancelled' | 'revoked';
export type BatchItemState =
  /** En cola, con sus dependencias satisfechas o pendientes de empezar. */
  | 'queued'
  /** Espera a que su dependencia esté integrada (o a tu decisión sobre ella). */
  | 'waiting_dependency'
  | 'running'
  /** Candidato de integración, verificación sin IA e integración en main (serializado). */
  | 'integrating'
  /** El pipeline se detuvo y decide el propietario (motivo y clase en el elemento). */
  | 'needs_owner'
  /** Terminada técnicamente; integrar no estaba pre-autorizado en el lote: lo haces tú desde el proceso. */
  | 'awaiting_integration'
  /** Terminada técnicamente (verificada, QA, Gauntlet, integrada y activa si correspondía): falta TU aceptación. */
  | 'awaiting_acceptance'
  | 'accepted'
  /** No aceptada: con tus notas y los pasos que fallaron (puede iterarse dentro del lote). */
  | 'rejected'
  | 'failed'
  /** No se ejecuta: su dependencia no se completó, hay un ciclo o depende de algo fuera del lote sin terminar. */
  | 'blocked'
  | 'cancelled';

export type BatchFailureClass = 'owner_decision' | 'environment' | 'budget' | 'subscription' | 'failure' | 'dependency' | 'integration';

export interface BatchGitAuthorization {
  /** Integrar en main sin preguntar cada vez (con las mismas verificaciones que la integración manual). */
  merge: boolean;
  /** Proyecto interno (el propio Portal): reconstruir y reiniciar para activar lo integrado (serializado). */
  activate: boolean;
  /** Publicar en GitHub. Desactivado por defecto; nunca se activa solo. */
  publish: boolean;
}

export interface BatchAuthorization {
  projectId: string;
  /** Historias en el orden que propuso el propietario (el plan respeta dependencias y, a igualdad, este orden). */
  itemIds: string[];
  /** Orígenes de ejecución permitidos para el equipo de cada historia: nunca se cambia a otro facturable. */
  backends: ('api' | 'claude_code')[];
  totalBudgetUsd: number;
  perStoryBudgetUsd: number;
  maxCorrections: number;
  /** Duración máxima del lote (minutos). */
  maxDurationMin: number;
  /** Tope de llamadas a la suscripción de Claude Code en todo el lote (la suscripción no es ilimitada). */
  maxSubscriptionCalls: number;
  gauntlet: GauntletConfig;
  /** Historias en paralelo (1–3); la integración y la activación son siempre de una en una. */
  concurrency: number;
  commands: ('typecheck' | 'test' | 'build')[];
  allowInstall: boolean;
  git: BatchGitAuthorization;
  /** Retomar UNA vez una historia interrumpida por un reinicio cuando no hay ninguna llamada con cobro incierto. */
  autoResume: boolean;
}

export interface BatchAcceptance { at: string; note: string | null; checks: boolean[] | null }
export interface BatchRejection { at: string; note: string; failedSteps: string[]; taskIds: string[] }

export interface BatchItem {
  itemId: string;
  storyId: string;
  title: string;
  /** Posición en el plan (0…) y oleada: las de la misma oleada no dependen entre sí. */
  order: number;
  wave: number;
  /** storyId del que depende (como en el backlog) y si está dentro del lote. */
  dependsOn: string | null;
  dependsInBatch: boolean;
  state: BatchItemState;
  reason: string | null;
  failureClass: BatchFailureClass | null;
  /** Proceso actual y todos los que tuvo en el lote (iteraciones incluidas). */
  processId: string | null;
  processIds: string[];
  /** Proceso de iteración preparado (pendiente de autorizar) que el lote adopta al reanudar el elemento. */
  nextProcessId?: string | null;
  autoResumes: number;
  startedAt: string | null;
  finishedAt: string | null;
  mergedCommit?: string | null;
  activated?: boolean;
  acceptance?: BatchAcceptance | null;
  rejection?: BatchRejection | null;
}

export interface BatchEvent {
  at: string;
  kind: 'authorized' | 'planned' | 'item' | 'integration' | 'activation' | 'pause' | 'resume' | 'cancel' | 'revoke' | 'acceptance' | 'budget' | 'recovery' | 'completed';
  itemId?: string | null;
  message: string;
}

export interface BatchActivation {
  /** Se pidió reconstruir y reiniciar; al volver, se comprueba antes de seguir. */
  state: 'requested' | 'done' | 'failed';
  requestedAt: string;
  commit: string | null;
  itemIds: string[];
  detail: string | null;
}

export interface Batch {
  id: string;
  projectId: string;
  title: string;
  status: BatchStatus;
  reason: string | null;
  auth: BatchAuthorization;
  items: BatchItem[];
  events: BatchEvent[];
  activation: BatchActivation | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  revokedAt: string | null;
}

export const BATCH_LIMITS = { maxItems: 30, maxConcurrency: 3, maxTotalUsd: 500, maxPerStoryUsd: 50, maxDurationMin: 24 * 60, maxCorrections: 6, maxSubscriptionCalls: 400, maxAutoResumes: 1 } as const;

// ---------------------------------------------------------------- Planificación determinista

export interface PlanInput { id: string; storyId: string; title: string; dependsOn: string | null; status: BacklogStatus }
export interface PlannedItem { id: string; storyId: string; title: string; order: number; wave: number; dependsOn: string | null; dependsInBatch: boolean; blockedReason: string | null }

/**
 * Orden seguro sin IA: orden topológico por dependencias (a igualdad, el orden que eligió el propietario), oleadas de
 * historias independientes entre sí y bloqueos explícitos (ciclos, dependencias fuera del lote sin terminar). Una
 * historia bloqueada no se omite en silencio: queda con su motivo.
 */
export function planBatch(selected: PlanInput[], backlog: PlanInput[]): PlannedItem[] {
  const byStory = new Map(backlog.map(b => [b.storyId, b]));
  const inBatch = new Map(selected.map((s, i) => [s.storyId, i]));
  const blocked = new Map<string, string>();
  const deps = new Map<string, string | null>();
  for (const s of selected) {
    const dep = s.dependsOn && s.dependsOn !== s.storyId ? s.dependsOn : null;
    if (!dep) { deps.set(s.storyId, null); continue; }
    if (inBatch.has(dep)) { deps.set(s.storyId, dep); continue; }
    const d = byStory.get(dep);
    deps.set(s.storyId, null);
    if (d && d.status !== 'done') blocked.set(s.storyId, `Depende de ${dep} («${d.title}»), que no está terminada ni en el lote.`);
  }
  // Kahn con desempate por el orden del propietario.
  const order: string[] = []; const wave = new Map<string, number>();
  const pending = new Set(selected.map(s => s.storyId));
  while (pending.size) {
    const ready = selected.filter(s => pending.has(s.storyId) && (!deps.get(s.storyId) || !pending.has(deps.get(s.storyId)!)));
    if (!ready.length) break;
    for (const s of ready) {
      const dep = deps.get(s.storyId);
      wave.set(s.storyId, dep ? (wave.get(dep) ?? 0) + 1 : 0);
      order.push(s.storyId); pending.delete(s.storyId);
    }
  }
  for (const id of pending) { blocked.set(id, 'Ciclo de dependencias entre historias del lote: decide el orden (cambia «depende de»).'); order.push(id); wave.set(id, 0); }
  // Una dependencia bloqueada bloquea a quien depende de ella (con el motivo encadenado).
  for (const id of order) { const dep = deps.get(id); if (dep && blocked.has(dep) && !blocked.has(id)) blocked.set(id, `Depende de ${dep}, que está bloqueada.`); }
  const sel = new Map(selected.map(s => [s.storyId, s]));
  return order.map((storyId, i) => { const s = sel.get(storyId)!; return { id: s.id, storyId, title: s.title, order: i, wave: wave.get(storyId) ?? 0, dependsOn: s.dependsOn ?? null, dependsInBatch: !!deps.get(storyId), blockedReason: blocked.get(storyId) ?? null }; });
}

// ---------------------------------------------------------------- Clasificación de fallos

/**
 * Cómo afecta al lote que el pipeline de una historia se detenga: `batchWide` pausa TODO el lote (el mismo motivo
 * detendría a las demás: límite de la suscripción, sandbox caído); si no, solo esa historia espera tu decisión y las
 * independientes siguen.
 */
export function classifyStop(pauseKind: PipelinePauseKind | null | undefined, processStatus: string): { cls: BatchFailureClass; batchWide: boolean } {
  if (processStatus === 'failed') return { cls: 'failure', batchWide: false };
  if (processStatus === 'cancelled' || pauseKind === 'cancelled') return { cls: 'owner_decision', batchWide: false };
  switch (pauseKind) {
    case 'subscription_limit': return { cls: 'subscription', batchWide: true };
    case 'environment': return { cls: 'environment', batchWide: true };
    case 'budget': return { cls: 'budget', batchWide: false };
    case 'provider_timeout': case 'provider_error': case 'interrupted': case 'max_turns': return { cls: 'environment', batchWide: false };
    case 'integration': case 'integration_conflict': return { cls: 'integration', batchWide: false };
    default: return { cls: 'owner_decision', batchWide: false };
  }
}

/** Estados en los que una historia ya no avanzará dentro del lote sin una decisión. */
export const BATCH_FINAL: BatchItemState[] = ['accepted', 'failed', 'blocked', 'cancelled'];
/** Estados de una dependencia que permiten empezar a quien depende de ella (su código está en main). */
export const DEPENDENCY_SATISFIED: BatchItemState[] = ['awaiting_acceptance', 'accepted'];
/** Estados de una dependencia que bloquean definitivamente a quien depende de ella. */
export const DEPENDENCY_BROKEN: BatchItemState[] = ['failed', 'blocked', 'cancelled'];

// ---------------------------------------------------------------- Presupuesto

/**
 * Presupuesto del lote: lo gastado (incluido el coste no confirmado de llamadas interrumpidas, por prudencia) más lo
 * reservado para las historias en marcha (su tope por historia). Solo empieza otra si cabe su tope completo.
 */
export function batchBudget(auth: Pick<BatchAuthorization, 'totalBudgetUsd' | 'perStoryBudgetUsd'>, procs: { spentUsd: number; unconfirmedUsd: number; budgetUsd: number; running: boolean }[]) {
  const spent = procs.reduce((s, p) => s + p.spentUsd + p.unconfirmedUsd, 0);
  const reserved = procs.filter(p => p.running).reduce((s, p) => s + Math.max(0, p.budgetUsd - p.spentUsd - p.unconfirmedUsd), 0);
  const remaining = Math.max(0, auth.totalBudgetUsd - spent - reserved);
  return { spent: round(spent), reserved: round(reserved), remaining: round(remaining), canStart: remaining + 1e-9 >= auth.perStoryBudgetUsd };
}
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Resumen por estado para el monitor (cuántas completas, bloqueadas, pendientes de aceptación…). */
export function batchSummary(items: Pick<BatchItem, 'state'>[]): Record<BatchItemState, number> {
  const out = { queued: 0, waiting_dependency: 0, running: 0, integrating: 0, needs_owner: 0, awaiting_integration: 0, awaiting_acceptance: 0, accepted: 0, rejected: 0, failed: 0, blocked: 0, cancelled: 0 } as Record<BatchItemState, number>;
  for (const i of items) out[i.state]++;
  return out;
}

/** Vista del monitor (lo que sirve GET /batches/:id): cada historia con su proceso y los totales del lote. */
export interface BatchItemView extends BatchItem {
  label: string;
  process: {
    id: string; status: string; spentUsd: number; unconfirmedUsd: number; budgetUsd: number | null;
    pipeline: { state: string; phase: string; pauseKind: string | null; reason: string | null; corrections: number } | null;
    gauntlet: { mode: string; status: string; rounds: number; reason: string | null } | null;
    review: string | null; merged: { into: string; commit: string; mergedAt: string } | null;
    manualTest: { steps: string[]; checks: boolean[] } | null; userFacing: string | null;
    implementer: string | null; evaluator: string | null;
  } | null;
}
export interface BatchView extends Omit<Batch, 'items'> {
  items: BatchItemView[];
  summary: Record<BatchItemState, number>;
  budget: { spent: number; reserved: number; remaining: number; canStart: boolean };
  subscriptionCalls: number;
}
export interface BatchPreview {
  auth: BatchAuthorization;
  plan: (PlannedItem & { estimatedUsd: number | null; backends: ('api' | 'claude_code')[]; disallowedBackends: ('api' | 'claude_code')[]; error: string | null })[];
  estimateUsd: number;
  gauntletOverheadPerStory: { evaluations: { min: number; max: number }; corrections: { min: number; max: number } };
  warnings: string[];
}

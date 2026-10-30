import type { ExecutionBackend } from './claude-code.ts';
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

/**
 * Origen de ejecución que autoriza un lote: la API del proveedor (facturable, en USD) o la suscripción de Claude Code.
 * El origen es de cada AGENTE, no de la historia: un equipo puede mezclar orígenes y cada agente se comprueba aparte.
 */
export type BatchSource = 'api' | 'claude_code';
/** Backend del agente → origen que lo autoriza en un lote (Claude Code gestionado y la consola usan la suscripción). */
export function batchSourceOf(backend: ExecutionBackend | null | undefined): BatchSource {
  return !backend || backend === 'api' ? 'api' : 'claude_code';
}

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
  /** Orígenes de ejecución permitidos para los agentes de cada historia: nunca se cambia a otro facturable. */
  backends: BatchSource[];
  /**
   * Si Claude Code no está disponible, ceder a la API (facturable). Solo con la API también autorizada en el lote Y la
   * alternativa activada en el conector; desactivado por defecto (lotes anteriores sin el campo: desactivado).
   */
  apiFallback?: boolean;
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
  /** No llegó a empezar (equipo sin permiso u origen no autorizado): reanudar o reintentar la vuelve a comprobar. */
  notStarted?: boolean;
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
  /** Dónde se corrige el motivo de la pausa (p. ej. Proveedores → Claude Code), si lo hay. */
  reasonFix?: { label: string; href: string } | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  revokedAt: string | null;
}

export const BATCH_LIMITS = { maxItems: 200, maxConcurrency: 3, maxTotalUsd: 500, maxPerStoryUsd: 50, maxDurationMin: 24 * 60, maxCorrections: 6, maxSubscriptionCalls: 5000, maxAutoResumes: 1 } as const;

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
 * independientes siguen. `providerCode` es el del fallo del proceso (un fallo del proveedor antes de que el Desarrollador
 * entregue termina el proceso en lugar de pausarlo; después, va en la pausa): el límite de la suscripción, Claude Code
 * no disponible o un origen no autorizado en el lote también detendrían a las demás. Una petición de permiso del propio
 * agente para SU historia (`permission`) solo detiene esa historia.
 */
export function classifyStop(pauseKind: PipelinePauseKind | null | undefined, processStatus: string, providerCode?: string | null): { cls: BatchFailureClass; batchWide: boolean } {
  if (providerCode === 'usage_limit') return { cls: 'subscription', batchWide: true };
  if (providerCode === 'backend_unavailable') return { cls: 'environment', batchWide: true };
  // Un agente pasó a un origen que el lote no autoriza: les pasaría lo mismo a las demás que lo usan.
  if (providerCode === 'origin_not_allowed') return { cls: 'owner_decision', batchWide: true };
  if (processStatus === 'failed') return { cls: 'failure', batchWide: false };
  if (processStatus === 'cancelled' || pauseKind === 'cancelled') return { cls: 'owner_decision', batchWide: false };
  switch (pauseKind) {
    case 'subscription_limit': return { cls: 'subscription', batchWide: true };
    case 'environment': return { cls: 'environment', batchWide: true };
    // Faltan dependencias en el sandbox y no se autorizó instalar con red: les pasaría lo mismo a todas.
    case 'network': return { cls: 'environment', batchWide: true };
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

/**
 * ¿Avanza algo sin ti? En marcha, en cola, integrándose, o esperando a una dependencia que sí avanza. Una historia que
 * espera a otra pendiente de TU decisión (p. ej. integrar a mano) no cuenta: el lote espera tu decisión.
 */
export function batchMoving(items: Pick<BatchItem, 'storyId' | 'state' | 'dependsOn' | 'dependsInBatch'>[]): boolean {
  const by = new Map(items.map(i => [i.storyId, i]));
  const moving = (i: (typeof items)[number], seen: Set<string>): boolean => {
    if (i.state === 'running' || i.state === 'queued' || i.state === 'integrating') return true;
    if (i.state !== 'waiting_dependency' || !i.dependsInBatch || !i.dependsOn || seen.has(i.storyId)) return false;
    seen.add(i.storyId); const d = by.get(i.dependsOn);
    return !!d && moving(d, seen);
  };
  return items.some(i => moving(i, new Set()));
}

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
/** Comprobación de un agente del equipo (la MISMA en la vista previa y al empezar cada historia). */
export interface BatchAgentCheck {
  agentId: string;
  name: string;
  roles: string[];
  backend: ExecutionBackend;
  source: BatchSource;
  /** Etiqueta visible del origen (p. ej. «Claude Code — Suscripción»). */
  label: string;
  /** El lote autoriza su origen. */
  allowed: boolean;
  /** Puede ejecutar: origen autorizado y conector, proyecto, suscripción, consola o proveedor disponibles. */
  ready: boolean;
  /** Por qué no puede (o el aviso, si cede a la API autorizada). */
  problem: string | null;
  /** Dónde se corrige (ruta de la interfaz). */
  fix: { label: string; href: string } | null;
  /** Ejecutará con la API como alternativa autorizada en el lote (facturable). */
  viaFallback: boolean;
}

/** Rango de llamadas a los modelos: `min` sin correcciones; `max` con las correcciones autorizadas (no es un tope). */
export interface CallRange { min: number; max: number }

export interface BatchPreviewStory extends PlannedItem {
  /** USD de la API (agentes en la API, o en Claude Code con la alternativa autorizada); la suscripción no se cobra por llamada. */
  estimatedUsd: number | null;
  /** Con las correcciones autorizadas (mismo criterio que `calls.max`). */
  estimatedUsdMax: number | null;
  calls: CallRange;
  subscriptionCalls: CallRange;
  team: BatchAgentCheck[];
  backends: BatchSource[];
  disallowedBackends: BatchSource[];
  /** Empezará: no está bloqueada, su equipo puede ejecutar y se pudo estimar. */
  executable: boolean;
  /** Motivos concretos por los que no empezará. */
  problems: string[];
  error: string | null;
}

export interface BatchPreview {
  auth: BatchAuthorization;
  plan: BatchPreviewStory[];
  estimateUsd: number;
  gauntletOverheadPerStory: { evaluations: { min: number; max: number }; corrections: { min: number; max: number } };
  warnings: string[];
  summary: {
    selected: number;
    executable: number;
    /** Bloqueadas por dependencias (ciclo o dependencia fuera del lote sin terminar). */
    blockedByDependency: number;
    /** Su equipo no puede ejecutar con lo autorizado (origen, conector, proyecto, consola, proveedor). */
    blockedByPermission: number;
    calls: CallRange;
    subscriptionCalls: CallRange;
    /** USD de API de las que empezarán: sin correcciones y con las autorizadas. */
    apiUsd: { min: number; max: number };
    /** Si Claude Code cede a la API (alternativa autorizada), con las correcciones autorizadas. */
    worstCaseUsd: number;
    /**
     * Cuántas de las que pueden empezar caben antes de que el tope de llamadas a la suscripción, el presupuesto o la
     * duración máxima pausen el lote (en el orden del plan y con la concurrencia): `max` si gastan lo mínimo (y la
     * duración es la mediana del historial), `min` si gastan lo máximo autorizado (y la duración es el p75).
     */
    fits: { min: number; max: number; limitedBy: ('subscription' | 'budget' | 'duration')[] };
    /** Dependen de otra del lote y, sin «Integrar en main», esperarán a que la integres tú. */
    waitForManualIntegration: string[];
    /** Oleadas: las de una misma oleada no dependen entre sí (pueden ir a la vez si la concurrencia lo permite). */
    waves: string[][];
    /** Dependencias de las elegidas que NO están en el lote ni terminadas: no se añaden solas. */
    missingDependencies: { itemId: string | null; storyId: string; title: string | null; status: BacklogStatus | null; eligible: boolean; requiredBy: string[] }[];
    /** Duración orientativa a partir del historial real del proyecto (null si no hay datos suficientes). */
    duration: { minutes: number; perStoryMinutes: number; p25: number; p75: number; samples: number } | null;
    /** Equipo del lote (agentes únicos) con su comprobación y cuántas historias usan cada uno. */
    agents: (BatchAgentCheck & { stories: number })[];
    connector: { enabled: boolean; subscriptionVerified: boolean; fallback: 'none' | 'api' };
  };
}

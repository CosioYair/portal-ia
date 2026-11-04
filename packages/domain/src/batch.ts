import type { ExecutionBackend } from './claude-code.ts';
import type { GauntletConfig } from './gauntlet.ts';
import type { BacklogStatus, PipelinePauseKind, PreviewRecord } from './types.ts';

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
  /**
   * Integración al aceptar: terminada técnicamente (verificada, QA y Gauntlet) y con su evidencia vigente o arrastrada;
   * NO está en main. Espera tu revisión en el orden de integración del lote.
   */
  | 'ready'
  /** Integración al aceptar: main cambió algo que la afecta y su candidato se pone al día (git, sandbox y QA si hace falta). */
  | 'revalidating'
  /**
   * Integración al aceptar con preparación apilada: terminada técnicamente (verificada, QA y Gauntlet) SOBRE LA VERSIÓN
   * PROVISIONAL de su dependencia (sin integrar). No está lista para integrar: cuando aceptes e integres su dependencia,
   * se pone al día con la versión final (git, sandbox y QA si la dependencia cambió) y pasa a «lista».
   */
  | 'prepared'
  /** La aplazaste: no se integra en este lote; cuenta como decisión tomada. Puedes recuperarla. */
  | 'postponed'
  | 'accepted'
  /** No aceptada: con tus notas y los pasos que fallaron (puede iterarse dentro del lote). */
  | 'rejected'
  | 'failed'
  /** No se ejecuta: su dependencia no se completó, hay un ciclo o depende de algo fuera del lote sin terminar. */
  | 'blocked'
  | 'cancelled'
  /**
   * Sigue FUERA del lote: autorizaste una iteración de esta historia desde su espacio (`followedProcessId`). El lote la
   * sigue para mostrar su estado, pero no la ejecuta, reintenta, itera, reanuda ni integra, y su gasto no cuenta en la
   * autorización del lote (tiene la suya). Integrada → pendiente de tu aceptación; cancelada o rechazada → decides tú.
   */
  | 'external';

/**
 * Origen de ejecución que autoriza un lote: la API del proveedor (facturable, en USD) o la suscripción de Claude Code.
 * El origen es de cada AGENTE, no de la historia: un equipo puede mezclar orígenes y cada agente se comprueba aparte.
 */
export type BatchSource = 'api' | 'claude_code' | 'codex';
/**
 * Backend del agente → origen que lo autoriza en un lote (Claude Code gestionado y la consola usan la suscripción de
 * Claude). Codex es su PROPIO origen: ningún lote lo autoriza hoy (las historias aún no se ejecutan con Codex), así que un
 * agente que pase a Codex nunca entra en un lote autorizado para Claude Code ni para la API.
 */
export function batchSourceOf(backend: ExecutionBackend | null | undefined): BatchSource {
  switch (backend ?? 'api') {
    case 'api': return 'api';
    case 'claude-code': case 'claude-code-terminal': return 'claude_code';
    case 'codex': return 'codex';
    default: { const never: never = backend as never; return never; }
  }
}

export type BatchFailureClass = 'owner_decision' | 'environment' | 'budget' | 'subscription' | 'failure' | 'dependency' | 'integration';

export interface BatchGitAuthorization {
  /** Integrar en main sin preguntar cada vez (con las mismas verificaciones que la integración manual). */
  merge: boolean;
  /** Proyecto interno (el propio Portal): reconstruir y reiniciar para activar lo integrado (serializado). */
  activate: boolean;
  /** Publicar en GitHub. Desactivado por defecto; nunca se activa solo. */
  publish: boolean;
  /**
   * Cuándo integra el lote (con `merge`): 'on_acceptance' termina técnicamente TODO el lote y cada historia entra en main
   * cuando la aceptas, en el orden de integración y con los candidatos posteriores puestos al día; 'auto' (lotes
   * anteriores sin el campo) integra cada historia al terminarla y la aceptas ya integrada.
   */
  integration?: BatchIntegrationPolicy;
  /**
   * Integración al aceptar: preparar las historias que dependen de otra del lote SOBRE la versión verificada y revisada de
   * su dependencia (sin integrar) en lugar de esperar a que la aceptes. Sin el campo (lotes anteriores): no.
   */
  prepareDependents?: boolean;
}

export type BatchIntegrationPolicy = 'auto' | 'on_acceptance';
/** Política efectiva: sin «Integrar en main», manual (la integras tú desde el proceso). */
export function integrationPolicy(auth: Pick<BatchAuthorization, 'git'>): BatchIntegrationPolicy | 'manual' {
  return auth.git.merge ? (auth.git.integration ?? 'auto') : 'manual';
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

export interface BatchAcceptance {
  at: string; note: string | null; checks: boolean[] | null;
  /**
   * 'integrate': aceptas un candidato SIN integrar y autorizas su integración; 'acknowledged': reconoces una historia que YA
   * estaba en main (integrada automáticamente antes de tu revisión): no autoriza ninguna integración nueva.
   */
  kind?: 'integrate' | 'acknowledged';
  /** Commit que tenías delante (p. ej. el de la vista previa) al decidir. */
  revision?: string | null;
  /**
   * Integración al aceptar: commit que revisaste y huella de SUS cambios (`git patch-id` del diff sin contexto respecto a
   * main). Si al ponerla al día cambia su código (conflictos resueltos por el agente, correcciones), la huella cambia y la
   * aceptación se anula: vuelves a revisarla. Un merge limpio de main conserva la huella y la aceptación.
   */
  commit?: string | null; patchId?: string | null;
}
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
  /** Proceso en pausa que «Reanudar» (autorizado) retoma donde quedó, en su turno y sin repetir lo hecho. */
  resumeProcessId?: string | null;
  /** Su equipo puede gastar USD de la API (algún agente en la API o con la alternativa autorizada). Sin el campo: sí. */
  usesApi?: boolean;
  autoResumes: number;
  /** No llegó a empezar (equipo sin permiso u origen no autorizado): reanudar o reintentar la vuelve a comprobar. */
  notStarted?: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  mergedCommit?: string | null;
  activated?: boolean;
  acceptance?: BatchAcceptance | null;
  rejection?: BatchRejection | null;
  /** Iteración autorizada fuera del lote que el lote sigue (estado 'external'); nunca está en `processIds`. */
  followedProcessId?: string | null;
  /** Iteraciones de fuera del lote ya resueltas (canceladas o rechazadas): no se vuelven a seguir. */
  dismissedProcessIds?: string[];
  /** Candidatos preparados de nuevo porque main avanzó mientras se verificaba el anterior (máximo 3 seguidos). */
  integrationRetries?: number;
  /** ¿Sigue valiendo su evidencia con el main actual? (sin IA; ver `CandidateFreshness`). */
  freshness?: CandidateFreshness | null;
  /** Puesta al día en curso (integración al aceptar): paso persistido para retomarla tras un reinicio sin repetir lo hecho. */
  revalidation?: { at: string; step: 'merge' | 'resolve' | 'verify' | 'qa'; mainHead: string | null; causes: string[]; /** Apilada cuya dependencia cambió: QA revisa el commit nuevo aunque git no vea conflictos. */ forceQa?: boolean } | null;
  /** Revisiones de QA repetidas por el lote con evidencia nueva (QA no pudo verificar): como mucho una. */
  qaRetries?: number;
  /** Aplazada por ti: desde qué estado (para recuperarla) y con qué nota. */
  postponed?: { at: string; from: BatchItemState; note: string | null } | null;
  /**
   * Preparación apilada: versión provisional de su dependencia sobre la que se prepara (commit verificado y revisado de la
   * rama de la dependencia, sin integrar). Se conserva mientras su trabajo dependa de ella.
   */
  stack?: BatchStack | null;
  /** Por qué esta historia no se puede preparar sobre la versión provisional de su dependencia (espera a que se integre). */
  noStack?: string | null;
  /** Commit de la dependencia al que se refiere `noStack` (si cambia, se vuelve a intentar); sin él, vale siempre. */
  noStackFor?: string | null;
}

export interface BatchStack {
  storyId: string; itemId: string; processId: string; commit: string; branch: string; at: string;
  /** Esa versión provisional ya no se integrará (la dependencia se rehízo o se integró otra): motivo. Su trabajo no entra en main. */
  invalid?: string | null;
  /** Huella de los cambios PROPIOS de la dependencia en esa versión: si la integrada tiene la misma, QA no repite por ella. */
  patchId?: string | null;
}

/** Cambio explícito de la política de integración de un lote ya autorizado (solo restringe; auditable). */
export interface BatchPolicyChange {
  at: string; by: 'owner'; note: string | null;
  from: BatchGitAuthorization; to: BatchGitAuthorization;
  /** Historias que YA estaban en main al cambiar (no se pueden des-integrar): aceptarlas es reconocerlas. */
  alreadyIntegrated: { itemId: string; storyId: string; commit: string; activated: boolean; accepted: boolean }[];
  /** Historias cuyo estado cambió al aplicar la nueva política (p. ej. pendiente de integrar → lista para tu revisión). */
  converted: { itemId: string; storyId: string; from: BatchItemState; to: BatchItemState }[];
}

/**
 * ¿La evidencia de una historia terminada (QA, Gauntlet, verificación) sigue valiendo con el main ACTUAL? Sin IA:
 * - `current`: se produjo contra el main actual (o su candidato ya lo incorpora y está verificado);
 * - `clean_carry`: main avanzó sin tocar ningún archivo de la historia ni compartido: la evidencia se arrastra y al
 *   integrar se verifica otra vez sin IA;
 * - `stale`: main cambió archivos de la historia o compartidos (`overlap`, por `causes`): hay que ponerla al día antes de
 *   presentarla como vigente (merge, sandbox y QA de lo que cambió);
 * - `unknown`: no se pudo calcular (sin rama o sin git): nunca se presenta como vigente.
 */
export interface CandidateFreshness {
  status: 'current' | 'clean_carry' | 'stale' | 'unknown';
  /** Commit de main contra el que se produjo la evidencia. */
  base: string | null;
  mainHead: string | null;
  /** Commit de la historia (rama o candidato) al que se refiere la evidencia. */
  head: string | null;
  overlap: string[];
  /** Historias (storyId) integradas en main desde `base`, si se saben. */
  causes: string[];
  /** Conflictos previstos (git merge-tree en memoria) al incorporar el main actual, si está `stale`. */
  conflicts?: string[];
  /** Preparada sobre una versión provisional de su dependencia que NO acabó en main: no se pone al día ni se integra. */
  stackInvalid?: boolean;
  /** Preparada sobre una versión provisional y su dependencia se integró con cambios posteriores: QA vuelve a revisarla. */
  dependencyChanged?: boolean;
  checkedAt: string;
  detail: string | null;
}

// ---------------------------------------------------------------- Orden de integración (sin IA)

/** Base de los archivos de una historia para ordenar: los reales de su rama, los del plan o los que menciona su texto. */
export type FileBasis = 'actual' | 'planned' | 'predicted' | 'none';
export interface IntegrationPlanInput {
  itemId: string; storyId: string; title: string;
  dependsOn: string | null;
  /** Orden del propietario (prioridad de negocio): desempata cuando nada técnico decide. */
  ownerOrder: number;
  files: string[];
  basis: FileBasis;
  /** Archivos que la historia CREA (rama real) y archivos que su texto menciona: dependencia implícita. */
  adds?: string[];
  mentions?: string[];
}
export interface IntegrationPlanNote { itemId: string; text: string }
export interface IntegrationPlan {
  computedAt: string;
  /** itemIds en el orden propuesto (solo las que faltan por integrar). */
  order: string[];
  basis: Record<FileBasis, number>;
  notes: IntegrationPlanNote[];
  overlaps: { a: string; b: string; files: string[] }[];
}

/** Archivos compartidos por todo un proyecto TypeScript: un cambio en ellos puede afectar a cualquier historia. */
export const SHARED_FILE = /^packages\/domain\/|\/db\/|executionPolicy|tokens\.css$|(^|\/)package(-lock)?\.json$|\/app\.ts$|(^|\/)tsconfig[^/]*\.json$/;
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

/**
 * Orden de integración propuesto, sin IA y explicado. No es el orden de los identificadores: 1) dependencias explícitas
 * (obligatorias); 2) dependencias implícitas (una historia menciona un archivo que otra crea); 3) en cada grupo de
 * historias que tocan los mismos archivos, primero la más transversal (toca archivos compartidos o coincide con más
 * historias), para que las demás se adapten a ella una sola vez; 4) a igualdad, tu orden (prioridad de negocio). Las
 * aristas «blandas» que crearían un ciclo se descartan. `isShared` permite otra definición por proyecto.
 */
export function integrationOrder(inputs: IntegrationPlanInput[], isShared: (f: string) => boolean = f => SHARED_FILE.test(f)): Omit<IntegrationPlan, 'computedAt'> {
  const ids = inputs.map(i => i.itemId); const by = new Map(inputs.map(i => [i.itemId, i]));
  const byStory = new Map(inputs.map(i => [i.storyId, i.itemId]));
  const files = new Map(inputs.map(i => [i.itemId, new Set(i.files.filter(f => !LOCKFILE.test(f)))]));
  const edges = new Map<string, Set<string>>(ids.map(id => [id, new Set()]));
  const notes: IntegrationPlanNote[] = []; const overlaps: IntegrationPlan['overlaps'] = [];
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>(); const stack = [from];
    while (stack.length) { const x = stack.pop()!; if (x === to) return true; if (seen.has(x)) continue; seen.add(x); stack.push(...edges.get(x)!); }
    return false;
  };
  const addEdge = (a: string, b: string) => { if (a === b || reaches(b, a)) return false; edges.get(a)!.add(b); return true; };
  // 1) Explícitas.
  for (const i of inputs) { const d = i.dependsOn ? byStory.get(i.dependsOn) : undefined; if (d && addEdge(d, i.itemId)) notes.push({ itemId: i.itemId, text: `Después de ${i.dependsOn}: depende de ella (dependencia declarada).` }); }
  // 2) Implícitas: B menciona un archivo que A crea.
  for (const a of inputs) for (const b of inputs) {
    if (a === b || !a.adds?.length || !b.mentions?.length) continue;
    const hit = a.adds.filter(f => b.mentions!.some(m => m === f || f.endsWith(`/${m}`)));
    if (hit.length && !edges.get(a.itemId)!.has(b.itemId) && addEdge(a.itemId, b.itemId)) notes.push({ itemId: b.itemId, text: `Después de ${a.storyId}: menciona ${hit.slice(0, 2).join(', ')}, que crea ${a.storyId} (dependencia implícita).` });
  }
  // 3) Solapes y transversalidad.
  const overlapCount = new Map(ids.map(id => [id, 0]));
  for (let x = 0; x < inputs.length; x++) for (let y = x + 1; y < inputs.length; y++) {
    const a = inputs[x].itemId, b = inputs[y].itemId;
    const shared = [...files.get(a)!].filter(f => files.get(b)!.has(f));
    if (!shared.length) continue;
    overlaps.push({ a, b, files: shared.slice(0, 12) });
    overlapCount.set(a, overlapCount.get(a)! + 1); overlapCount.set(b, overlapCount.get(b)! + 1);
  }
  const sharedOf = (id: string) => [...files.get(id)!].filter(isShared);
  const weight = (id: string) => sharedOf(id).length * 2 + overlapCount.get(id)!;
  for (const o of overlaps) {
    const [first, second] = weight(o.a) !== weight(o.b) ? (weight(o.a) > weight(o.b) ? [o.a, o.b] : [o.b, o.a]) : (by.get(o.a)!.ownerOrder <= by.get(o.b)!.ownerOrder ? [o.a, o.b] : [o.b, o.a]);
    if (edges.get(first)!.has(second) || reaches(first, second)) continue;
    if (!addEdge(first, second)) continue;
    const f = by.get(first)!, s = by.get(second)!;
    if (f.ownerOrder > s.ownerOrder) {
      const sh = sharedOf(first);
      notes.push({ itemId: first, text: `Antes que ${s.storyId} (aunque la elegiste después): comparten ${o.files.slice(0, 3).join(', ')}${o.files.length > 3 ? '…' : ''} y ${f.storyId} es más transversal (${sh.length ? `toca ${sh.slice(0, 2).join(', ')}, compartidos por todo el proyecto` : `coincide con ${overlapCount.get(first)} historias del lote`}): ${s.storyId} se adapta a ella una sola vez.` });
    } else notes.push({ itemId: second, text: `Después de ${f.storyId}: comparten ${o.files.slice(0, 3).join(', ')}${o.files.length > 3 ? '…' : ''}; se pondrá al día con lo que integre ${f.storyId}.` });
  }
  // 4) Kahn con tu orden como desempate.
  const indeg = new Map(ids.map(id => [id, 0]));
  for (const [, to] of edges) for (const t of to) indeg.set(t, indeg.get(t)! + 1);
  const order: string[] = []; const avail = ids.filter(id => indeg.get(id) === 0);
  while (avail.length) {
    avail.sort((a, b) => by.get(a)!.ownerOrder - by.get(b)!.ownerOrder);
    const x = avail.shift()!; order.push(x);
    for (const t of edges.get(x)!) { indeg.set(t, indeg.get(t)! - 1); if (indeg.get(t) === 0) avail.push(t); }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id); // ciclo de dependencias declaradas: ya lo bloquea planBatch
  for (const i of inputs) if (i.basis === 'none') notes.push({ itemId: i.itemId, text: 'Aún no se saben sus archivos: se ordena por tu prioridad y se recalcula al planificarla.' });
  const basis = { actual: 0, planned: 0, predicted: 0, none: 0 } as Record<FileBasis, number>;
  for (const i of inputs) basis[i.basis]++;
  return { order, basis, notes, overlaps };
}

/** Rutas o nombres de archivo que menciona un texto (para predecir archivos y dependencias implícitas). */
export function mentionedFiles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s`'"(«])((?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|css|scss|json|md|html|sql|ya?ml|py|go|rs))(?=$|[\s`'"),.:;»])/g)) out.add(m[1].replace(/^\.\//, ''));
  return Array.from(out);
}

// ---------------------------------------------------------------- Ciclo de vida del lote (sin IA)

/** Situación de una historia para el resumen del lote. */
export type ItemOutcome = 'in_progress' | 'waiting' | 'prepared' | 'ready' | 'decision' | 'technical_blocker' | 'integrating' | 'integrated' | 'accepted' | 'rejected' | 'postponed' | 'cancelled';
export function itemOutcome(it: Pick<BatchItem, 'state' | 'failureClass'>): ItemOutcome {
  switch (it.state) {
    case 'queued': case 'running': case 'revalidating': return 'in_progress';
    case 'waiting_dependency': case 'external': return 'waiting';
    case 'prepared': return 'prepared';
    case 'ready': case 'awaiting_integration': return 'ready';
    case 'needs_owner': return it.failureClass === 'environment' || it.failureClass === 'failure' || it.failureClass === 'dependency' ? 'technical_blocker' : 'decision';
    case 'failed': case 'blocked': return 'technical_blocker';
    case 'integrating': return 'integrating';
    case 'awaiting_acceptance': return 'integrated';
    case 'accepted': return 'accepted';
    case 'rejected': return 'rejected';
    case 'postponed': return 'postponed';
    case 'cancelled': return 'cancelled';
  }
}

export interface BatchLifecycle {
  policy: BatchIntegrationPolicy | 'manual';
  /** technical: aún trabaja el equipo · acceptance: te toca revisar · integrating: entrando en main · done: todo resuelto. */
  phase: 'technical' | 'acceptance' | 'integrating' | 'done';
  technicallyComplete: boolean;
  counts: Record<ItemOutcome, number>;
  /** Listas para que las revises (integración al aceptar) o para aceptar ya integradas (automática). */
  readyForOwner: number;
  /** La siguiente que te toca revisar, en el orden de integración. */
  next: string | null;
  headline: string;
}
const FINAL_OUTCOMES: ItemOutcome[] = ['accepted', 'rejected', 'postponed', 'cancelled'];
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/**
 * Resumen del lote para el propietario: en qué fase está y qué falta, distinguiendo lo listo para tu aceptación, lo que
 * necesita una decisión tuya y lo bloqueado por un problema técnico. «Técnicamente completo» = nada técnico en marcha.
 * No se da por terminado mientras quede trabajo aceptado sin integrar o decisiones tuyas pendientes.
 */
export function batchLifecycle(items: Pick<BatchItem, 'itemId' | 'storyId' | 'state' | 'failureClass' | 'dependsOn' | 'dependsInBatch'>[], policy: BatchIntegrationPolicy | 'manual', order: string[] = []): BatchLifecycle {
  const counts = { in_progress: 0, waiting: 0, prepared: 0, ready: 0, decision: 0, technical_blocker: 0, integrating: 0, integrated: 0, accepted: 0, rejected: 0, postponed: 0, cancelled: 0 } as Record<ItemOutcome, number>;
  for (const i of items) counts[itemOutcome(i)]++;
  const readyForOwner = counts.ready + counts.integrated;
  const technicallyComplete = counts.in_progress === 0 && counts.integrating === 0;
  const done = items.length > 0 && items.every(i => FINAL_OUTCOMES.includes(itemOutcome(i)));
  const phase: BatchLifecycle['phase'] = done ? 'done' : counts.integrating ? 'integrating' : counts.in_progress ? 'technical' : 'acceptance';
  const rank = new Map(order.map((id, k) => [id, k]));
  const sorted = [...items].sort((a, b) => (rank.get(a.itemId) ?? 1e6) - (rank.get(b.itemId) ?? 1e6));
  const integratedIds = new Set(items.filter(i => ['accepted', 'awaiting_acceptance'].includes(i.state)).map(i => i.storyId));
  const reviewable = sorted.find(i => (i.state === 'ready' || i.state === 'awaiting_acceptance' || i.state === 'awaiting_integration') && (!i.dependsInBatch || !i.dependsOn || integratedIds.has(i.dependsOn)));
  const next = (reviewable ?? sorted.find(i => itemOutcome(i) === 'decision'))?.itemId ?? null;
  const total = n(items.length, 'historia', 'historias');
  const parts = [
    counts.ready ? `${counts.ready} ${policy === 'on_acceptance' ? (counts.ready === 1 ? 'lista para tu aceptación (sin integrar)' : 'listas para tu aceptación (sin integrar)') : (counts.ready === 1 ? 'lista para tu aceptación' : 'listas para tu aceptación')}` : '',
    counts.integrated ? `${counts.integrated} ${policy === 'on_acceptance' ? (counts.integrated === 1 ? 'ya integrada en main (falta reconocerla)' : 'ya integradas en main (falta reconocerlas)') : (counts.integrated === 1 ? 'integrada, pendiente de tu aceptación' : 'integradas, pendientes de tu aceptación')}` : '',
    counts.decision ? `${counts.decision} ${counts.decision === 1 ? 'requiere una decisión tuya' : 'requieren una decisión tuya'}` : '',
    counts.technical_blocker ? `${counts.technical_blocker} ${counts.technical_blocker === 1 ? 'bloqueada por un problema técnico' : 'bloqueadas por un problema técnico'}` : '',
    counts.prepared ? `${counts.prepared} ${counts.prepared === 1 ? 'preparada sobre su dependencia (se revisa después de ella)' : 'preparadas sobre su dependencia (se revisan después de ella)'}` : '',
    counts.waiting ? `${counts.waiting} ${counts.waiting === 1 ? 'espera a otra historia' : 'esperan a otras historias'}` : '',
    counts.accepted ? `${counts.accepted} ${counts.accepted === 1 ? 'aceptada e integrada' : 'aceptadas e integradas'}` : '',
    counts.postponed ? `${counts.postponed} ${counts.postponed === 1 ? 'aplazada' : 'aplazadas'}` : '',
    counts.rejected ? `${counts.rejected} no ${counts.rejected === 1 ? 'aceptada' : 'aceptadas'}` : '',
    counts.cancelled ? `${counts.cancelled} ${counts.cancelled === 1 ? 'cancelada' : 'canceladas'}` : ''
  ].filter(Boolean).join(', ');
  const headline = phase === 'done' ? `Lote resuelto: ${total} — ${parts}.`
    : phase === 'integrating' ? `Integrando en main (de una en una): ${counts.integrating} en curso · ${total} — ${parts || 'sin más pendientes'}.`
    : technicallyComplete ? `Lote técnicamente completo: ${total} — ${parts}.`
    : `El equipo trabaja: ${counts.in_progress} en curso de ${total}${parts ? ` · ${parts}` : ''}.`;
  return { policy, phase, technicallyComplete, counts, readyForOwner, next, headline };
}

export interface BatchEvent {
  at: string;
  /** 'close': cierre manual del propietario (con su motivo en el mensaje), sin IA. */
  kind: 'authorized' | 'planned' | 'item' | 'integration' | 'activation' | 'pause' | 'resume' | 'cancel' | 'revoke' | 'acceptance' | 'budget' | 'recovery' | 'completed' | 'close' | 'policy';
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
  /**
   * Cierre manual de un lote en pausa: cuándo, con qué motivo y cómo quedó. Queda 'completed' si todas sus historias
   * estaban integradas (y activas, si es el Portal); si no, 'cancelled'. No usa IA.
   */
  closed?: { at: string; reason: string; outcome: 'completed' | 'cancelled' } | null;
  /** Orden de integración propuesto (sin IA), recalculado al saberse mejor qué archivos toca cada historia. */
  integrationPlan?: IntegrationPlan | null;
  /** Cambios explícitos de la política de integración después de autorizarlo (la autorización original no se reescribe). */
  policyHistory?: BatchPolicyChange[];
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
  // Límite de uso de la suscripción o tope de llamadas autorizado (no es USD): les pasaría lo mismo a las demás.
  if (providerCode === 'usage_limit' || providerCode === 'call_cap' || pauseKind === 'call_cap') return { cls: 'subscription', batchWide: true };
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
 * reservado para las historias en marcha que pueden gastar API (su tope por historia). `canStart`: cabe el tope completo
 * de otra historia que use la API. Una historia solo con la suscripción no reserva ni necesita USD (`api: false`).
 */
export function batchBudget(auth: Pick<BatchAuthorization, 'totalBudgetUsd' | 'perStoryBudgetUsd'>, procs: { spentUsd: number; unconfirmedUsd: number; budgetUsd: number; running: boolean; api?: boolean }[]) {
  const spent = procs.reduce((s, p) => s + p.spentUsd + p.unconfirmedUsd, 0);
  const reserved = procs.filter(p => p.running && p.api !== false).reduce((s, p) => s + Math.max(0, p.budgetUsd - p.spentUsd - p.unconfirmedUsd), 0);
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
    if (i.state === 'running' || i.state === 'queued' || i.state === 'integrating' || i.state === 'revalidating') return true;
    if (i.state !== 'waiting_dependency' || !i.dependsInBatch || !i.dependsOn || seen.has(i.storyId)) return false;
    seen.add(i.storyId); const d = by.get(i.dependsOn);
    return !!d && moving(d, seen);
  };
  return items.some(i => moving(i, new Set()));
}

/** Resumen por estado para el monitor (cuántas completas, bloqueadas, pendientes de aceptación…). */
export function batchSummary(items: Pick<BatchItem, 'state'>[]): Record<BatchItemState, number> {
  const out = { queued: 0, waiting_dependency: 0, running: 0, integrating: 0, needs_owner: 0, awaiting_integration: 0, awaiting_acceptance: 0, ready: 0, revalidating: 0, prepared: 0, postponed: 0, accepted: 0, rejected: 0, failed: 0, blocked: 0, cancelled: 0, external: 0 } as Record<BatchItemState, number>;
  for (const i of items) out[i.state]++;
  return out;
}

// ---------------------------------------------------------------- Conteos de un lote de documentos (ZIP)

/**
 * Conteos de un lote de documentos. Cada documento del lote cuenta en UN solo estado. `total` es el número de archivos
 * del lote; sin él (registros antiguos) vale `detected`. `duplicates` es solo informativo y no se suma.
 */
export interface DocumentBatchCountsLike {
  total?: number; detected: number;
  passed: number; rejectedQa: number; failed: number; cancelled: number; excluded: number;
  pending: number; queued: number; processing: number;
}

/** Suma de las partes: listos + rechazados + fallidos + cancelados + excluidos + pendientes (incluye en cola y en proceso). */
export function batchCountsSum(c: DocumentBatchCountsLike): number {
  return c.passed + c.rejectedQa + c.failed + c.cancelled + c.excluded + c.pending + c.queued + c.processing;
}

/** ¿Cuadran los conteos? total = listos + rechazados + fallidos + cancelados + excluidos + pendientes (sin IA ni IO). */
export function batchCountsAddUp(c: DocumentBatchCountsLike): boolean {
  return (c.total ?? c.detected) === batchCountsSum(c);
}

/** Vista del monitor (lo que sirve GET /batches/:id): cada historia con su proceso y los totales del lote. */
export interface BatchItemView extends BatchItem {
  label: string;
  /** Preparación apilada: sobre qué versión de su dependencia y si la dependencia cambió desde entonces. */
  stackInfo?: { storyId: string; commit: string; dependencyHead: string | null; moved: boolean; invalid: string | null } | null;
  /** Evidencia del commit actual del candidato: verificación por comando y QA (por commit). */
  evidence?: { head: string; verifiedHead: boolean; commands: { command: string; ok: boolean; isolation: string | null }[]; /** Lo que la línea base dejó pasar (aceptar el lote lo confirma). */ notes?: string[]; qa: { state: string; coversHead: boolean; why: string } | null } | null;
  /** Última vista previa del candidato (en marcha o como evidencia) y si ya no corresponde al commit actual. */
  preview?: (PreviewRecord & { live: boolean; outdated: boolean }) | null;
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
  lifecycle: BatchLifecycle;
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
  /** Gauntlet de ESTA historia (con «automático», ya resuelto según su tamaño, riesgo e historial) y por qué. */
  gauntlet?: { mode: 'off' | 'standard' | 'deep'; maxRounds: number; reason: string | null };
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

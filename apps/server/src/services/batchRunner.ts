import { BATCH_LIMITS, DEPENDENCY_BROKEN, DEPENDENCY_SATISFIED, INTERNAL_WORKSPACE, backendLabel, verificationsForApplied, batchBudget, batchLifecycle, batchMoving, integrationPolicy, batchSourceOf, batchSummary, classifyStop, DEFAULT_GAUNTLET, gauntletOverhead, normalizeGauntlet, normalizePipeline, planBatch, type Batch, type BatchAgentCheck, type BatchAuthorization, type BatchFailureClass, type BatchItem, type BatchItemState, type BatchPreview, type BatchPreviewStory, type CallRange, type CandidateFreshness, type GauntletConfig, type PipelinePauseKind, type Process, type ProviderId, type RuntimeCheck, type RuntimeCheckResult } from '@portal-ia/domain';
import { revisionStatus } from './revision.ts';
import { acquireWork, forgetLeases, workConflict } from './executionLocks.ts';
import { batchesRepo } from '../db/batches.ts';
import { callMetricsRepo } from '../db/callMetrics.ts';
import { providersRepo, workspacesRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, claudeCodeRunsRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { isActiveJob, trackJob } from './activeJobs.ts';
import { cancelProcess, clearCancel, isCancelled } from './assessment.ts';
import { agentBackend, claudeCodeGate } from './claudeCode/backend.ts';
import { lastDetection } from './claudeCode/detect.ts';
import { getClaudeCodeSettings } from './claudeCode/settings.ts';
import { requirePolicy } from './executionPolicy.ts';
import { projectEvaluator, projectGauntlet, resolveGauntletFor, syncEvaluatorStep } from './gauntlet.ts';
import { abortProcessCalls } from './providerCalls.ts';
import { pushBranches } from './repoWrite.ts';
import { defaultChecks, runRuntimeChecks } from './runtimeChecks.ts';
import { createStoryProcess, estimateStory, repoContextChars, runStory, storyBasis } from './storyExecution.ts';
import { prepareIntegration, resolveIntegrationConflicts, verifyCandidate } from './storyIntegration.ts';
import { abortPendingMerge, computeIntegrationPlan, freshnessOf, isAncestorIn, planSignature, storyPatchId } from './batchIntegration.ts';
import { ownerRoundPossible, prepareOwnerRound } from './storyUnits.ts';
import { prepareStackedBase } from './stackedBranch.ts';
import { previewLive } from './preview.ts';
import { mergeStory } from './storyMerge.ts';
import { newPipeline, resumeStory, updatePipeline } from './storyPipeline.ts';
import { iterateStory, threadRepo } from './storyThread.ts';
import { activationOf, isAncestor, startUpdate, systemStatus, updateRunning } from './system.ts';

/**
 * Coordinador del lote (determinista, sin IA): ver packages/domain/src/batch.ts. Reutiliza el pipeline de cada
 * historia (worktree, sandbox, QA, Gauntlet, correcciones), el candidato de integración, la integración de
 * services/storyMerge.ts, la activación del Portal y la verificación en ejecución. Cada transición se guarda antes de
 * actuar, de modo que un reinicio retoma sin repetir nada (y sin reenviar llamadas con cobro incierto).
 */

const fail = (statusCode: number, message: string, code: string) => Object.assign(new Error(message), { statusCode, code });
const now = () => new Date(batchDeps.now()).toISOString();
let logger: (o: any, m: string) => void = () => undefined;

/** Dependencias sustituibles en pruebas (ejecutar historias, activar el Portal, comprobar en ejecución, reloj). */
export const batchDeps = {
  runStory, resumeStory,
  /** Reconstruir y reiniciar el Portal en marcha (proyecto interno). Responde al empezar; el reinicio llega después. */
  activate: async (log: (o: any, m: string) => void) => {
    const st = await systemStatus();
    await startUpdate({ install: st.changedFiles.some(f => /(^|\/)package(-lock)?\.json$/.test(f)), restart: true }, log);
  },
  activation: (commit: string, mergedAt: string) => activationOf(commit, mergedAt),
  runtimeChecks: (processId: string, checks: RuntimeCheck[]): Promise<RuntimeCheckResult[]> => runRuntimeChecks(processId, checks),
  now: () => Date.now()
};

export const ITEM_LABEL: Record<BatchItemState, string> = {
  queued: 'en cola', waiting_dependency: 'esperando su dependencia', running: 'en ejecución', integrating: 'integrándose',
  needs_owner: 'esperando tu decisión', awaiting_integration: 'pendiente de integrar (decides tú)', awaiting_acceptance: 'pendiente de tu aceptación',
  accepted: 'aceptada', rejected: 'no aceptada', failed: 'fallida', blocked: 'bloqueada', cancelled: 'cancelada', external: 'sigue fuera del lote',
  ready: 'lista para tu revisión (sin integrar)', revalidating: 'poniéndose al día con main', postponed: 'aplazada',
  prepared: 'preparada sobre su dependencia (sin integrar)'
};
/** Integración al aceptar (el lote termina todo lo técnico y cada historia entra en main cuando la aceptas). */
const onAcceptance = (b: Pick<Batch, 'auth'>) => integrationPolicy(b.auth) === 'on_acceptance';
/** Proceso que cuenta para la historia ahora: la iteración que autorizaste fuera del lote, si la hay; si no, la del lote. */
const currentProcessId = (it: Pick<BatchItem, 'processId' | 'followedProcessId'>) => it.followedProcessId ?? it.processId;
/** Por qué espera una historia detenida (según su clase): nunca se presenta como trabajo terminado. */
const WAIT_LABEL: Record<BatchFailureClass, string> = {
  owner_decision: 'espera tu decisión', environment: 'espera al entorno', budget: 'sin USD de la API autorizados', subscription: 'en pausa por la suscripción',
  failure: 'falló: decides tú', dependency: 'bloqueada por su dependencia', integration: 'integración: decides tú'
};

// ---------------------------------------------------------------- Autorización y plan

export interface BatchInput {
  itemIds: string[];
  backends?: ('api' | 'claude_code')[];
  apiFallback?: boolean;
  totalBudgetUsd: number; perStoryBudgetUsd: number;
  maxCorrections?: number; maxDurationMin?: number; maxSubscriptionCalls?: number;
  gauntlet?: { mode: 'off' | 'standard' | 'deep' | 'auto'; maxRounds?: number };
  concurrency?: number;
  commands?: ('typecheck' | 'test' | 'build')[]; allowInstall?: boolean;
  git?: { merge?: boolean; activate?: boolean; publish?: boolean; integration?: 'auto' | 'on_acceptance'; prepareDependents?: boolean };
  autoResume?: boolean;
  title?: string;
}

const clamp = (v: unknown, min: number, max: number, def: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
/**
 * Normaliza la autorización: límites acotados (nunca «ilimitado»); la API, integrar, activar y publicar solo si se
 * piden (activar y publicar exigen integrar); ceder a la API solo si se pide y la API está autorizada en el lote.
 */
export function normalizeAuth(projectId: string, input: BatchInput, projectDefault: GauntletConfig = DEFAULT_GAUNTLET): BatchAuthorization {
  const order = ['typecheck', 'test', 'build'] as const;
  const itemIds = Array.from(new Set(input.itemIds));
  if (itemIds.length > BATCH_LIMITS.maxItems) throw fail(400, `Un lote admite hasta ${BATCH_LIMITS.maxItems} historias (elegiste ${itemIds.length}): divídelo en varios lotes.`, 'too_many');
  // La API es facturable: solo con tu marca. Sin orígenes indicados, solo la suscripción de Claude Code.
  const backends = Array.from(new Set(input.backends?.length ? input.backends : ['claude_code'])) as BatchAuthorization['backends'];
  const merge = !!input.git?.merge;
  // Sin la API autorizada no hay USD que gastar: 0 es válido (la suscripción la limita su tope de llamadas).
  const minUsd = backends.includes('api') ? 0.1 : 0;
  const low = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v < minUsd;
  if (low(input.totalBudgetUsd) || low(input.perStoryBudgetUsd)) throw fail(400, 'Con la API autorizada como origen hace falta un presupuesto de API de al menos 0,10 USD (total y por historia). Con 0 USD, quita la API: el lote usará solo la suscripción.', 'budget_required');
  return {
    projectId, itemIds, backends,
    apiFallback: !!input.apiFallback && backends.includes('api'),
    totalBudgetUsd: clamp(input.totalBudgetUsd, minUsd, BATCH_LIMITS.maxTotalUsd, 1),
    perStoryBudgetUsd: clamp(input.perStoryBudgetUsd, minUsd, BATCH_LIMITS.maxPerStoryUsd, 1),
    maxCorrections: Math.floor(clamp(input.maxCorrections, 0, BATCH_LIMITS.maxCorrections, 3)),
    maxDurationMin: Math.floor(clamp(input.maxDurationMin, 5, BATCH_LIMITS.maxDurationMin, 240)),
    maxSubscriptionCalls: Math.floor(clamp(input.maxSubscriptionCalls, 0, BATCH_LIMITS.maxSubscriptionCalls, 60)),
    // Sin indicarlo, el del proyecto (por defecto «automático»: se resuelve historia a historia al empezar cada una).
    gauntlet: normalizeGauntlet(input.gauntlet ?? projectDefault),
    concurrency: Math.floor(clamp(input.concurrency, 1, BATCH_LIMITS.maxConcurrency, 1)),
    commands: order.filter(c => (input.commands ?? order).includes(c)),
    allowInstall: !!input.allowInstall,
    git: {
      merge, activate: merge && !!input.git?.activate, publish: merge && !!input.git?.publish,
      ...(merge ? { integration: input.git?.integration === 'on_acceptance' ? 'on_acceptance' as const : 'auto' as const } : {}),
      // Al aceptar: las dependientes se preparan sobre la versión verificada de su dependencia salvo que lo desmarques.
      ...(merge && input.git?.integration === 'on_acceptance' ? { prepareDependents: input.git?.prepareDependents !== false } : {})
    },
    autoResume: input.autoResume !== false
  };
}

function selection(slug: string, projectId: string, itemIds: string[]) {
  if (!projectsRepo(slug).get(projectId)) throw fail(404, 'Proyecto no encontrado.', 'not_found');
  if (!itemIds.length) throw fail(400, 'Elige al menos una historia.', 'empty');
  const backlog = backlogRepo(slug).list(projectId).filter(i => !i.archivedAt);
  const selected = itemIds.map(id => backlog.find(b => b.id === id) ?? null);
  const missing = itemIds.filter((_, i) => !selected[i]);
  if (missing.length) throw fail(404, `Historias que no son de este proyecto: ${missing.join(', ')}`, 'not_found');
  const invalid = selected.filter(s => s!.status !== 'pending' && s!.status !== 'blocked');
  if (invalid.length) throw fail(409, `Solo entran en un lote historias pendientes (o bloqueadas): ${invalid.map(s => `${s!.storyId} está ${s!.status}`).join(' · ')}.`, 'invalid_status');
  return { selected: selected as NonNullable<typeof selected[number]>[], backlog };
}

const PROVIDERS_LINK = { label: 'Proveedores', href: '/configuracion/proveedor' };
const CC_LINK = { label: 'Proveedores → Claude Code — Local', href: '/configuracion/proveedor#claude-code' };
const unique = (xs: string[]) => Array.from(new Set(xs));
/** Recorta un texto largo por una palabra entera (nunca a mitad de palabra). */
const clip = (s: string, n: number) => s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, '')}…`;
/** ¿Puede Claude Code ceder a la API en las historias del lote? Lo pide el lote, con la API autorizada, y lo permite el conector. */
const batchFallback = (auth: Pick<BatchAuthorization, 'backends' | 'apiFallback'>, connector: 'none' | 'api') => !!auth.apiFallback && auth.backends.includes('api') && connector === 'api';
/**
 * ¿Puede gastar USD de la API la historia de este equipo? Algún agente en la API, uno que ya cede a ella, o Claude Code con
 * la alternativa por la API autorizada (la misma regla que worstCaseCallUsd). Solo esas reservan y necesitan presupuesto.
 */
export const needsApi = (team: Pick<BatchAgentCheck, 'source' | 'viaFallback'>[], fallback = false) => team.some(t => t.source === 'api' || t.viaFallback || (fallback && t.source === 'claude_code'));

/**
 * Comprobación ÚNICA de los orígenes del equipo de una historia: la usan la vista previa, la autorización del lote y el
 * arranque real de cada historia, así que no pueden discrepar. El origen es de cada AGENTE (API, Claude Code gestionado o
 * consola): el lote debe autorizarlo y el agente debe poder ejecutar con él ahora (conector, proyecto, suscripción,
 * consola, proveedor). Sin efectos y sin llamar a la IA.
 */
export function checkTeam(slug: string, projectId: string, members: { agentId: string; role?: string | null }[], auth: Pick<BatchAuthorization, 'backends' | 'apiFallback'>): BatchAgentCheck[] {
  const agents = agentsRepo(slug); const billing = lastDetection()?.billing ?? null;
  const fallback = batchFallback(auth, getClaudeCodeSettings().fallback);
  return Array.from(new Set(members.map(m => m.agentId))).map((id): BatchAgentCheck => {
    const roles = Array.from(new Set(members.filter(m => m.agentId === id).map(m => m.role ?? 'implementer')));
    const a = agents.get(id);
    if (!a) return { agentId: id, name: 'Agente eliminado', roles, backend: 'api', source: 'api', label: '—', allowed: false, ready: false, problem: 'Un agente del equipo ya no existe.', fix: { label: 'Organización de la Oficina', href: '/oficina/organizacion' }, viaFallback: false };
    const backend = agentBackend(a); const source = batchSourceOf(backend); const name = a.config.name;
    const providerId = a.config.provider as ProviderId; const api = backendLabel('api', null, providerId);
    const apiReady = !!providersRepo.credential(providerId) && providersRepo.get(providerId)?.status === 'connected';
    const base = { agentId: id, name, roles, backend, source, label: backendLabel(backend, billing, providerId), allowed: auth.backends.includes(source), viaFallback: false };
    const agentLink = { label: `Origen de «${name}» (su panel en la Oficina)`, href: `/oficina/agente/${encodeURIComponent(id)}/configuracion` };
    if (!base.allowed) return { ...base, ready: false, fix: agentLink, problem: source === 'api'
      ? `«${name}» usa ${api} (facturable) y este lote no autoriza la API.`
      : source === 'codex' ? `«${name}» usa Codex: los lotes aún no se ejecutan con Codex (ningún lote lo autoriza). Cambia su arnés a Claude Code o la API para esta historia; no se usará otro en su lugar.`
      : `«${name}» usa Claude Code (${backend === 'claude-code-terminal' ? 'tu consola' : 'gestionado'}) y este lote no autoriza la suscripción de Claude Code.` };
    if (source === 'api') return apiReady ? { ...base, ready: true, problem: null, fix: null } : { ...base, ready: false, problem: `El proveedor de «${name}» (${api}) no está conectado.`, fix: PROVIDERS_LINK };
    const g = claudeCodeGate(slug, a, projectId);
    const reason = !g.ok
      ? g.problem === 'project' ? `El proyecto «${projectsRepo(slug).get(projectId)?.name ?? projectId}» no está autorizado para Claude Code: autorízalo en Proveedores → Claude Code — Local.` : g.reason
      : backend === 'claude-code' && billing !== 'subscription' ? `Claude Code no está verificado con tu suscripción (${backendLabel('claude-code', billing ?? 'unverified')}).` : null;
    if (!reason) return { ...base, ready: true, problem: null, fix: null };
    const fix = !g.ok && (g.problem === 'console' || g.problem === 'provider') ? agentLink : CC_LINK;
    if (fallback && apiReady) return { ...base, ready: true, viaFallback: true, problem: `${reason} Usará ${api} (facturable), como autorizaste en el lote.`, fix };
    return { ...base, ready: false, problem: reason, fix };
  });
}

/**
 * Duración orientativa por historia, del historial real del proyecto: solo historias que terminaron verificadas (no las
 * que se detuvieron antes), de al menos 1 minuto; mediana y dispersión (p25–p75). Con menos de 5, no se estima.
 */
function historyMinutes(slug: string, projectId: string): { median: number; p25: number; p75: number; samples: number } | null {
  const mins = processesRepo(slug).list(projectId).filter(p => p.kind === 'story_execution' && p.status === 'done' && p.startedAt && p.finishedAt && (p.result?.pipeline?.state === 'verified' || !!p.result?.merged))
    .slice(0, 50).map(p => (Date.parse(p.finishedAt!) - Date.parse(p.startedAt!)) / 60_000).filter(m => m >= 1).sort((a, b) => a - b);
  if (mins.length < 5) return null;
  const q = (f: number) => { const x = (mins.length - 1) * f; const lo = Math.floor(x); return mins[lo] + (mins[Math.ceil(x)] - mins[lo]) * (x - lo); };
  return { median: q(0.5), p25: q(0.25), p75: q(0.75), samples: mins.length };
}

/**
 * Suma ponderada de los pasos de una historia: `min`, cada paso una vez (y las evaluaciones mínimas del Gauntlet);
 * `max`, con las correcciones autorizadas (Desarrollador + QA por corrección; el Gauntlet suma sus evaluaciones y
 * correcciones dirigidas). Con peso 1 son llamadas; con el USD de cada paso, coste. Reparaciones de formato,
 * continuaciones, unidades de implementación y reintentos pueden sumar más: es una estimación, no un tope. Una
 * evaluación del Gauntlet se pondera como una revisión de QA.
 */
type Step = { agentId: string; role: string; usd: number };
function stepRange(steps: Step[], auth: BatchAuthorization, evaluatorId: string | null, weight: (s: Step) => number, gauntlet: GauntletConfig = auth.gauntlet): CallRange {
  const g = gauntletOverhead(gauntlet);
  const dev = steps.find(s => s.role === 'implementer'); const qa = steps.find(s => s.role === 'reviewer');
  const ev = evaluatorId ? weight({ agentId: evaluatorId, role: 'evaluator', usd: qa?.usd ?? 0 }) : 0;
  const d = dev ? weight(dev) : 0; const r = qa ? weight(qa) : 0;
  const min = steps.reduce((a, s) => a + weight(s), 0) + ev * g.evaluations.min;
  const max = min + auth.maxCorrections * (d + r) + ev * (g.evaluations.max - g.evaluations.min) + (evaluatorId ? d * g.corrections.max : 0);
  return { min, max };
}
const addRange = (a: CallRange, b: CallRange): CallRange => ({ min: a.min + b.min, max: a.max + b.max });
const range = (r: CallRange) => r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`;
const usd = (n: number) => Number(n.toFixed(4));

type Limit = 'subscription' | 'budget' | 'duration';
/**
 * Cuántas historias empiezan antes de que los límites pausen el lote, en el orden del plan y con la misma regla que el
 * coordinador: una historia empieza si las llamadas a la suscripción ya hechas no alcanzan el tope, el presupuesto
 * restante (descontado lo reservado para las que van a la vez) cubre el tope por historia y no se ha superado la duración
 * máxima. Con varias a la vez, las de un mismo grupo no ven las llamadas ni el gasto de las otras hasta que terminan (por
 * eso el tope puede superarse un poco). `minutes`: duración por historia del historial (null si no hay datos). Solo las
 * historias cuyo equipo puede gastar API (`needsApi`) reservan y necesitan USD; las de la suscripción, no.
 */
function fitsUnderLimits(stories: BatchPreviewStory[], auth: BatchAuthorization, pick: 'min' | 'max', minutes: number | null, fallback = false): { n: number; limitedBy: Limit[] } {
  const c = Math.max(1, auth.concurrency); let calls = 0; let spent = 0; let groupCalls = 0; let groupUsd = 0; let n = 0; let inGroup = 0; let inGroupApi = 0; let rounds = 0;
  const close = () => { calls += groupCalls; spent += groupUsd; groupCalls = 0; groupUsd = 0; inGroup = 0; inGroupApi = 0; rounds++; };
  const room = () => auth.totalBudgetUsd - spent - inGroupApi * auth.perStoryBudgetUsd + 1e-9 >= auth.perStoryBudgetUsd;
  for (const s of stories) {
    const api = needsApi(s.team, fallback);
    // Si lo reservado para las que van a la vez no deja sitio, el coordinador espera a que terminen (no pausa el lote).
    if (api && inGroupApi > 0 && !room()) close();
    const limitedBy: Limit[] = [];
    if (auth.backends.includes('claude_code') && calls >= auth.maxSubscriptionCalls) limitedBy.push('subscription');
    if (api && !room()) limitedBy.push('budget');
    if (minutes !== null && rounds * minutes > auth.maxDurationMin) limitedBy.push('duration');
    if (limitedBy.length) return { n, limitedBy };
    n++; inGroup++; if (api) inGroupApi++; groupCalls += s.subscriptionCalls[pick]; groupUsd += (pick === 'min' ? s.estimatedUsd : s.estimatedUsdMax) ?? 0;
    if (inGroup === c) close();
  }
  return { n, limitedBy: [] };
}
const LIMIT_TEXT: Record<Limit, string> = { subscription: 'tope de llamadas a la suscripción', budget: 'presupuesto de API', duration: 'duración máxima del lote' };

/** Vista previa SIN guardar nada ni llamar a la IA: plan, equipo y orígenes, llamadas, coste de API, límites, duración y avisos. */
export function previewBatch(slug: string, projectId: string, input: BatchInput): BatchPreview {
  const auth = normalizeAuth(projectId, input, projectGauntlet(slug, projectId));
  const { selected, backlog } = selection(slug, projectId, auth.itemIds);
  const plan = planBatch(selected, backlog);
  const connector = getClaudeCodeSettings(); const fallback = batchFallback(auth, connector.fallback);
  const evaluator = auth.gauntlet.mode !== 'off' ? projectEvaluator(slug, projectId) : null;
  let worst = { min: 0, max: 0 };
  // El contexto del repositorio es el mismo para todas: se mide una vez (con 200 historias, ~2 ms menos por historia).
  let ctxChars: number | undefined; try { ctxChars = repoContextChars(slug, projectId); } catch { /* cada historia explicará el motivo */ }
  const stories = plan.map((p): BatchPreviewStory => {
    let est: ReturnType<typeof estimateStory> | null = null; let error: string | null = null;
    try { est = estimateStory(slug, projectId, p.id, {}, ctxChars); } catch (e: any) { error = e.message; }
    const steps: Step[] = (est?.steps ?? []).map(st => ({ agentId: st.agentId, role: st.role as string, usd: st.estimatedUsd }));
    // «Automático» se resuelve por historia (sin IA), con la misma regla que al empezarla.
    const g = resolveGauntletFor(slug, { id: '', projectId, backlogItemId: p.id, assignmentId: null }, auth.gauntlet);
    const ev = g.mode !== 'off' ? evaluator : null;
    const team = est ? checkTeam(slug, projectId, [...steps, ...(ev ? [{ agentId: ev.id, role: 'evaluator' }] : [])], auth) : [];
    const by = new Map(team.map(t => [t.agentId, t]));
    const subscription = (id: string) => by.get(id)?.source === 'claude_code' && !by.get(id)!.viaFallback;
    const problems = unique([...(p.blockedReason ? [p.blockedReason] : []), ...team.filter(t => !t.ready).map(t => t.problem!), ...(error ? [error] : [])]);
    const backends = Array.from(new Set(team.map(t => t.source)));
    const cost = stepRange(steps, auth, ev?.id ?? null, s => subscription(s.agentId) ? 0 : s.usd, g);
    // Peor caso de API: si Claude Code cede a la API autorizada en el lote.
    if (!problems.length) worst = addRange(worst, stepRange(steps, auth, ev?.id ?? null, s => !subscription(s.agentId) || fallback ? s.usd : 0, g));
    return {
      ...p, team, backends, disallowedBackends: backends.filter(b => !auth.backends.includes(b)), problems, executable: !problems.length, error,
      gauntlet: { mode: g.mode === 'auto' ? 'off' : g.mode, maxRounds: g.maxRounds, reason: g.auto?.reason ?? null },
      // La suscripción no se cobra por llamada (consume tu cuota): el USD estimado es solo el de la API.
      estimatedUsd: est ? usd(cost.min) : null, estimatedUsdMax: est ? usd(cost.max) : null,
      calls: stepRange(steps, auth, ev?.id ?? null, () => 1, g),
      subscriptionCalls: stepRange(steps, auth, ev?.id ?? null, s => subscription(s.agentId) ? 1 : 0, g)
    };
  });
  const runnable = stories.filter(s => s.executable);
  // Sin «Integrar en main», quien depende de otra del lote espera a que la integres tú: no empieza sola.
  const manual = auth.git.merge ? [] : runnable.filter(s => s.dependsInBatch).map(s => s.storyId);
  const automatic = runnable.filter(s => !manual.includes(s.storyId));
  const apiUsd = automatic.reduce((a, s) => addRange(a, { min: s.estimatedUsd ?? 0, max: s.estimatedUsdMax ?? 0 }), { min: 0, max: 0 });
  const calls = automatic.reduce((a, s) => addRange(a, s.calls), { min: 0, max: 0 });
  const subscriptionCalls = automatic.reduce((a, s) => addRange(a, s.subscriptionCalls), { min: 0, max: 0 });
  const hist = automatic.length ? historyMinutes(slug, projectId) : null;
  const optimistic = fitsUnderLimits(automatic, auth, 'min', hist?.median ?? null, fallback); const pessimistic = fitsUnderLimits(automatic, auth, 'max', hist?.p75 ?? null, fallback);
  const blockedByDependency = stories.filter(s => !!s.blockedReason).length;
  const blockedByPermission = stories.filter(s => !s.blockedReason && s.team.some(t => !t.ready)).length;
  // Dependencias que faltan: se proponen, nunca se añaden solas al alcance autorizado.
  const inBatch = new Set(selected.map(s => s.storyId)); const byStory = new Map(backlog.map(b => [b.storyId, b]));
  const missing = new Map<string, BatchPreview['summary']['missingDependencies'][number]>();
  for (const s of selected) {
    if (!s.dependsOn || s.dependsOn === s.storyId || inBatch.has(s.dependsOn)) continue;
    const d = byStory.get(s.dependsOn); if (d?.status === 'done') continue;
    const m = missing.get(s.dependsOn) ?? { itemId: d?.id ?? null, storyId: s.dependsOn, title: d?.title ?? null, status: d?.status ?? null, eligible: !!d && (d.status === 'pending' || d.status === 'blocked'), requiredBy: [] };
    m.requiredBy.push(s.storyId); missing.set(s.dependsOn, m);
  }
  const waves: string[][] = [];
  for (const s of stories.filter(x => !x.blockedReason)) (waves[s.wave] ??= []).push(s.storyId);
  const agents = new Map<string, BatchAgentCheck & { stories: number }>();
  for (const s of stories) for (const t of s.team) { const cur = agents.get(t.agentId); agents.set(t.agentId, cur ? { ...cur, stories: cur.stories + 1 } : { ...t, stories: 1 }); }
  const warnings: string[] = [];
  if (blockedByDependency) warnings.push(`${blockedByDependency} historia(s) bloqueada(s) por dependencias: no se ejecutarán (motivo en cada una).`);
  if (blockedByPermission) warnings.push(`${blockedByPermission} historia(s) no pueden empezar: algún agente de su equipo no puede ejecutar con lo autorizado (detalle y cómo corregirlo en «Equipo y orígenes»). No se autoriza así.`);
  if (manual.length) warnings.push(`${manual.length} historia(s) dependen de otra del lote y, sin «Integrar en main», esperarán a que integres tú su dependencia: ${manual.slice(0, 8).join(', ')}${manual.length > 8 ? '…' : ''}.`);
  if (optimistic.n < automatic.length) warnings.push(`Con estos límites el lote se pausará tras ≈ ${pessimistic.n === optimistic.n ? optimistic.n : `${pessimistic.n}–${optimistic.n}`} de ${automatic.length} historias (${unique([...optimistic.limitedBy, ...pessimistic.limitedBy].map(l => LIMIT_TEXT[l as Limit])).join(' y ')}); después decides si lo amplías.`);
  else if (pessimistic.n < automatic.length) warnings.push(`Si las historias necesitan todas sus correcciones (o tardan como las más lentas), el lote podría pausarse tras ≈ ${pessimistic.n} de ${automatic.length} (${pessimistic.limitedBy.map(l => LIMIT_TEXT[l]).join(' y ')}).`);
  if (auth.concurrency > 1 && auth.backends.includes('claude_code') && subscriptionCalls.max > auth.maxSubscriptionCalls) warnings.push(`Con ${auth.concurrency} a la vez, el tope de llamadas se comprueba al empezar cada historia: las que ya están en marcha terminan y pueden superarlo un poco.`);
  if (apiUsd.min > auth.totalBudgetUsd) warnings.push(`La estimación de API (${apiUsd.min.toFixed(2)} USD) supera el presupuesto total (${auth.totalBudgetUsd} USD): el lote se pausará al agotarlo.`);
  if (automatic.some(s => (s.estimatedUsdMax ?? 0) > auth.perStoryBudgetUsd)) warnings.push('Alguna historia, con sus correcciones, podría gastar más API que el tope por historia: se pausará al alcanzarlo.');
  if (auth.apiFallback && !fallback) warnings.push('Pediste que Claude Code ceda a la API, pero el conector está configurado para pausar: no cederá (se cambia en Proveedores → Claude Code).');
  if ((auth.gauntlet.mode === 'standard' || auth.gauntlet.mode === 'deep') && !evaluator) warnings.push('Gauntlet activado sin Evaluador en el proyecto: se aplicarán la verificación y QA de siempre.');
  else if (auth.gauntlet.mode === 'auto' && !evaluator) warnings.push('Gauntlet automático: el proyecto no tiene Evaluador Gauntlet, así que cada historia tendrá la verificación y QA de siempre.');
  if (auth.git.activate && slug !== INTERNAL_WORKSPACE.slug) warnings.push('La activación (reconstruir y reiniciar) solo aplica al propio Portal: se ignora en este proyecto.');
  if (auth.concurrency > 1) warnings.push('Con historias en paralelo, la integración y la activación siguen siendo de una en una; las que tocan los mismos archivos pueden necesitar resolver conflictos.');
  if (auth.git.integration === 'on_acceptance') {
    const deps = runnable.filter(s => s.dependsInBatch); const dependents = deps.map(s => s.storyId);
    const list = `${dependents.slice(0, 8).join(', ')}${dependents.length > 8 ? '…' : ''}`;
    const depCalls = deps.reduce((a, s) => addRange(a, s.subscriptionCalls), { min: 0, max: 0 });
    if (dependents.length) warnings.push(auth.git.prepareDependents
      ? `Integración al aceptar con preparación apilada: ${dependents.length} historia(s) dependen de otra del lote y se prepararán SOBRE la versión verificada y revisada por QA de su dependencia (sin integrar), sin esperar a tu revisión: ${list}. Nunca se integran antes que su dependencia; al integrarla, se ponen al día con su versión final (git, sandbox y QA si cambió). Si no aceptas la dependencia o la rehaces desde cero, ese trabajo (≈ ${range(depCalls)} llamadas a la suscripción) puede perderse.`
      : `Integración al aceptar: ${dependents.length} historia(s) dependen de otra del lote y empezarán cuando aceptes e integres su dependencia (necesitan su código en main): ${list}.`);
    warnings.push('Integración al aceptar: cada historia que comparta archivos con otra ya integrada se pone al día antes de integrarse (git y sandbox sin IA; una revisión de QA más, y una llamada si hay conflictos reales). Esas llamadas cuentan en el tope del lote y no están en la estimación.');
    if (auth.git.activate) warnings.push('Integración al aceptar en el Portal: no puedes probar la interfaz en el Portal en marcha antes de aceptarla; revisas la evidencia (diff, QA, Gauntlet y pruebas) y, al aceptarla, se integra, se activa y se comprueba en ejecución.');
  }
  return {
    auth, plan: stories, estimateUsd: usd(apiUsd.min), gauntletOverheadPerStory: gauntletOverhead(auth.gauntlet), warnings,
    summary: {
      selected: stories.length, executable: runnable.length, blockedByDependency, blockedByPermission, calls, subscriptionCalls,
      apiUsd: { min: usd(apiUsd.min), max: usd(apiUsd.max) }, worstCaseUsd: usd(worst.max),
      fits: { min: pessimistic.n, max: optimistic.n, limitedBy: unique([...optimistic.limitedBy, ...pessimistic.limitedBy]) as Limit[] },
      waitForManualIntegration: manual, waves, missingDependencies: Array.from(missing.values()),
      duration: hist ? { perStoryMinutes: Math.round(hist.median), p25: Math.round(hist.p25), p75: Math.round(hist.p75), minutes: Math.round(hist.median * Math.ceil(Math.min(optimistic.n, automatic.length) / auth.concurrency)), samples: hist.samples } : null,
      agents: Array.from(agents.values()),
      connector: { enabled: connector.enabled, subscriptionVerified: lastDetection()?.billing === 'subscription', fallback: connector.fallback }
    }
  };
}

/** Autorización explícita y persistida del lote: desde aquí y solo desde aquí el coordinador actúa por su cuenta. */
export function createBatch(slug: string, projectId: string, input: BatchInput): Batch {
  const auth = normalizeAuth(projectId, input, projectGauntlet(slug, projectId));
  const { selected, backlog } = selection(slug, projectId, auth.itemIds);
  const repo = batchesRepo(slug);
  const open = repo.active().find(b => b.projectId === projectId);
  if (open) throw fail(409, `Ya hay un lote activo en este proyecto («${open.title}»): termínalo, cancélalo o revócalo antes de autorizar otro.`, 'batch_active');
  // La misma comprobación que la vista previa: no se autoriza un lote con historias cuyo equipo no puede ejecutar.
  const pv = previewBatch(slug, projectId, input);
  if (pv.summary.blockedByPermission) throw fail(409, `No se autoriza: ${pv.summary.blockedByPermission} historia(s) no pueden empezar con lo autorizado. ${unique(pv.plan.filter(p => !p.blockedReason && !p.executable).flatMap(p => p.problems)).join(' ')}`, 'not_authorized');
  const plan = planBatch(selected, backlog);
  const items: BatchItem[] = plan.map(p => ({
    itemId: p.id, storyId: p.storyId, title: p.title, order: p.order, wave: p.wave, dependsOn: p.dependsOn, dependsInBatch: p.dependsInBatch,
    state: p.blockedReason ? 'blocked' : p.dependsInBatch ? 'waiting_dependency' : 'queued', reason: p.blockedReason, failureClass: p.blockedReason ? 'dependency' : null,
    processId: null, processIds: [], nextProcessId: null, autoResumes: 0, startedAt: null, finishedAt: null
  }));
  const at = now();
  const scope = `${items.length} historia(s) · ${auth.totalBudgetUsd} USD en total (máx. ${auth.perStoryBudgetUsd} por historia) · ${auth.maxCorrections} corrección(es) · Gauntlet ${auth.gauntlet.mode} · ${auth.concurrency} a la vez · ${auth.maxDurationMin} min · orígenes ${auth.backends.join(', ')} · integrar ${auth.git.merge ? (auth.git.integration === 'on_acceptance' ? `al aceptar cada historia, en orden (dependientes ${auth.git.prepareDependents ? 'preparadas sobre la versión verificada de su dependencia' : 'tras integrar su dependencia'})` : 'sí, al terminar cada una') : 'no'} · activar ${auth.git.activate ? 'sí' : 'no'} · publicar ${auth.git.publish ? 'sí' : 'no'}`;
  const b = repo.create({
    projectId, title: input.title?.trim() || `Lote del ${at.slice(0, 10)} (${items.length} historias)`, status: 'running', reason: null, auth, items,
    events: [{ at, kind: 'authorized', message: `Autorizado por el propietario: ${scope}.` }, { at, kind: 'planned', message: `Plan sin IA: ${items.map(i => `${i.storyId}${i.dependsInBatch ? ` (tras ${i.dependsOn})` : ''}${i.state === 'blocked' ? ' · bloqueada' : ''}`).join(' → ')}.` }],
    activation: null, finishedAt: null, revokedAt: null
  });
  processesRepo(slug).logExecution({ projectId, agentId: '', kind: `batch_authorized:${b.id}`, status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: at });
  void scheduleTick(slug, b.id);
  return b;
}

// ---------------------------------------------------------------- Bucle del coordinador

const ticking = new Map<string, Promise<void>>(); const again = new Set<string>();
/** Una sola pasada a la vez por lote; si llega otra petición durante una pasada, se repite al terminar. */
export function scheduleTick(slug: string, id: string): Promise<void> {
  const key = `${slug}:${id}`;
  if (ticking.has(key)) { again.add(key); return ticking.get(key)!; }
  const run = (async () => {
    try { do { again.delete(key); await tick(slug, id); } while (again.has(key)); }
    catch (e: any) { logger({ batchId: id, err: e?.message }, 'lote: fallo inesperado del coordinador'); try { setStatus(slug, id, 'paused', `Fallo inesperado del coordinador del lote: ${e?.message ?? e}. Lo hecho se conserva; «Reanudar» lo retoma.`, 'pause'); } catch { /* lote borrado */ } }
    finally { ticking.delete(key); }
  })();
  ticking.set(key, run); return run;
}


async function tick(slug: string, id: string) {
  const repo = batchesRepo(slug);
  syncItems(slug, id);
  let b = repo.get(id); if (!b || b.status !== 'running') return;
  // La duración autorizada limita el trabajo del equipo, no el tiempo que tardas en revisar: con nada técnico en marcha
  // (integración al aceptar, esperando tu revisión) no se pausa por duración.
  if (batchDeps.now() - Date.parse(b.createdAt) > b.auth.maxDurationMin * 60_000 && (!onAcceptance(b) || batchMoving(b.items))) { setStatus(slug, id, 'paused', `Se alcanzó la duración máxima autorizada del lote (${b.auth.maxDurationMin} min). Lo hecho se conserva; «Reanudar» concede el mismo margen otra vez.`, 'pause'); return; }
  resolveDependencies(slug, id);
  // Integración (requiere integrar pre-autorizado; al aceptar, solo lo que aceptaste): de una en una, nunca con el lote
  // pausado o revocado, en el orden de integración.
  for (const it of integrationQueue(slug, repo.get(id)!)) {
    if (repo.get(id)!.status !== 'running') return;
    await (onAcceptance(repo.get(id)!) ? integrateAccepted(slug, id, it.itemId) : integrate(slug, id, it.itemId));
    resolveDependencies(slug, id);
  }
  if (await maybeActivate(slug, id)) return;
  startNext(slug, id);
  if (onAcceptance(repo.get(id)!)) { await refreshIntegrationState(slug, id); revalidateNext(slug, id); }
  b = repo.get(id)!;
  if (b.status === 'running') maybeComplete(slug, id);
}

/** Pendientes de entrar en main, en el orden de integración (las aceptadas, si es al aceptar). */
function integrationQueue(slug: string, b: Batch): BatchItem[] {
  const rank = new Map((b.integrationPlan?.order ?? []).map((x, k) => [x, k]));
  const procs = processesRepo(slug);
  // Con su proceso en marcha (QA o correcciones de la puesta al día) aún no toca: se retoma al terminar ese proceso.
  return b.items.filter(i => i.state === 'integrating' && !i.mergedCommit && (!onAcceptance(b) || !!i.acceptance) && procs.get(currentProcessId(i) ?? '')?.status !== 'running')
    .sort((x, y) => (rank.get(x.itemId) ?? 1e6) - (rank.get(y.itemId) ?? 1e6) || x.order - y.order);
}

// ---------------------------------------------------------------- Integración al aceptar: plan, vigencia y puesta al día

const planSig = new Map<string, string>();
/**
 * Recalcula (sin IA, solo git) el orden de integración cuando cambia lo que se sabe de las historias, y la vigencia de la
 * evidencia de cada historia lista cuando cambia main o su rama. Lo guardado lo sirve la vista sin tocar git.
 */
async function refreshIntegrationState(slug: string, id: string) {
  const b = batchesRepo(slug).get(id); if (!b) return;
  const key = `${slug}:${id}`; const sig = planSignature(slug, b);
  if (planSig.get(key) !== sig || !b.integrationPlan) {
    try {
      const plan = await computeIntegrationPlan(slug, b);
      const first = !b.integrationPlan;
      const changedOrder = (b.integrationPlan?.order ?? []).join() !== plan.order.join();
      batchesRepo(slug).update(id, x => {
        x.integrationPlan = plan;
        if (first || changedOrder) {
          const label = (iid: string) => x.items.find(i => i.itemId === iid)?.storyId ?? iid;
          const why = plan.basis.actual ? 'archivos reales de cada rama' : plan.basis.planned ? 'archivos de los planes' : plan.basis.predicted ? 'archivos que menciona cada historia' : 'sin archivos conocidos aún';
          if (plan.order.length) x.events.push({ at: now(), kind: 'planned', message: `Orden de integración ${first ? 'propuesto' : 'actualizado'} (sin IA, por ${why}): ${plan.order.map(label).join(' → ')}.${plan.notes.length ? ` ${plan.notes.slice(0, 3).map(n => `${label(n.itemId)}: ${n.text}`).join(' ')}` : ''}` });
        }
      });
      planSig.set(key, sig);
    } catch (e: any) { logger({ batchId: id, err: e?.message }, 'lote: no se pudo calcular el orden de integración'); }
  }
  const procs = processesRepo(slug);
  for (const it of batchesRepo(slug).get(id)!.items.filter(i => i.state === 'ready')) {
    const p = procs.get(currentProcessId(it)!); if (!p) continue;
    try {
      const f = await freshnessOf(slug, p, { dependencyHead: dependencyChangeHead(slug, batchesRepo(slug).get(id)!, it) });
      const cur = batchesRepo(slug).get(id)!.items.find(i => i.itemId === it.itemId)!;
      if (cur.state !== 'ready') continue;
      // Su versión provisional de la dependencia no acabó en main (la dependencia se rehízo): nunca se pone al día ni se
      // integra con esos commits; decides tú (iterarla la rehace sobre main).
      if (f.stackInvalid) { setItem(slug, id, it.itemId, { state: 'needs_owner', failureClass: 'dependency', freshness: f, acceptance: null, stack: cur.stack ? { ...cur.stack, invalid: f.detail } : cur.stack, reason: `${f.detail}` }, `su versión provisional de la dependencia ya no vale: ${f.detail}`, 'integration'); continue; }
      const prev = cur.freshness;
      if (!prev || prev.status !== f.status || prev.mainHead !== f.mainHead || prev.head !== f.head) {
        setItem(slug, id, it.itemId, { freshness: f, reason: readyReason(f) }, prev && prev.status !== f.status && f.status === 'stale' ? `su evidencia dejó de estar vigente: ${f.detail}` : undefined, 'integration');
      }
    } catch (e: any) { logger({ batchId: id, itemId: it.itemId, err: e?.message }, 'lote: vigencia no calculada'); }
  }
}
const readyReason = (f: CandidateFreshness) => f.status === 'current' ? `Lista para tu revisión (sin integrar): evidencia vigente con main ${f.mainHead}.`
  : f.status === 'clean_carry' ? `Lista para tu revisión (sin integrar): ${f.detail}`
  : f.status === 'stale' ? `Lista, pero su evidencia no está al día: ${f.detail ?? ''} Se pone al día antes de integrarla (y antes, si es la siguiente).`.trim()
  : `Lista, pero no se pudo comprobar su vigencia: ${f.detail ?? ''} No se presenta como vigente.`.trim();

/**
 * Pone al día SOLO la siguiente historia lista del orden de integración cuya evidencia caducó (eager), para que la
 * encuentres vigente al revisarla; las demás se marcan y se ponen al día en su turno (sin pagar dos veces lo mismo).
 */
function revalidateNext(slug: string, id: string) {
  const b = batchesRepo(slug).get(id)!; if (b.status !== 'running') return;
  if (b.items.some(i => i.state === 'revalidating' || (i.state === 'integrating' && !i.mergedCommit))) return;
  // Una historia aceptada que aún va camino de main (poniéndose al día o con QA) cambiará main otra vez: poner al día la
  // siguiente ahora haría pagar dos veces la misma revisión.
  if (b.items.some(i => i.acceptance && !i.mergedCommit && ['queued', 'running', 'revalidating', 'integrating'].includes(i.state))) return;
  if (b.items.filter(i => i.state === 'running' || i.state === 'revalidating').length >= b.auth.concurrency) return;
  const rank = new Map((b.integrationPlan?.order ?? []).map((x, k) => [x, k]));
  const integrated = new Set(b.items.filter(i => i.mergedCommit || i.state === 'accepted').map(i => i.storyId));
  const next = b.items.filter(i => i.state === 'ready' && (!i.dependsInBatch || !i.dependsOn || integrated.has(i.dependsOn)))
    .sort((x, y) => (rank.get(x.itemId) ?? 1e6) - (rank.get(y.itemId) ?? 1e6) || x.order - y.order)[0];
  if (next?.freshness?.status === 'stale' && workConflict(slug, { id: '', backlogItemId: next.itemId, assignmentId: null }) === null) void revalidate(slug, id, next.itemId);
}

const revalidating = new Set<string>();
/**
 * Puesta al día de un candidato con el main actual (integración al aceptar): main entra en su rama con git (sin IA);
 * conflictos reales → el Desarrollador autorizado resuelve SOLO esas secciones (una llamada, dentro de los límites del
 * lote); el candidato se verifica en el sandbox (sin IA); si QA no cubre el commit nuevo o algo falla, la historia vuelve
 * a la cola para que QA lo revise y el equipo corrija (en su turno). Cada paso se guarda antes de actuar.
 */
async function revalidate(slug: string, id: string, itemId: string): Promise<void> {
  const key = `${slug}:${id}:${itemId}`; if (revalidating.has(key)) return; revalidating.add(key);
  const procs = processesRepo(slug); let acted = false;
  try {
    const b = getBatch(slug, id); const it = b.items.find(i => i.itemId === itemId)!; const pid = currentProcessId(it)!;
    if (!liveBatch(b)) return;
    const p0 = procs.get(pid); if (!p0 || p0.status === 'running') return;
    // Ya está en main (integrada fuera del lote, o un reinicio tras integrarla): se registra esa integración, nunca otra.
    if (await alreadyInMain(slug, p0)) { acted = true; const m = await mergeStory(slug, pid, {}, logger); return afterMerge(slug, id, itemId, m); }
    const lease = acquireWork(slug, p0, `batch:${id}`, 'poner al día el candidato');
    if ('conflict' in lease) { const reason = `Espera para ponerse al día: ${lease.conflict}`; if (it.reason !== reason) { acted = true; setItem(slug, id, itemId, { reason }); } return; }
    try {
      acted = true;
      const fr = it.freshness;
      setItem(slug, id, itemId, { state: 'revalidating', revalidation: { at: now(), step: 'merge', mainHead: fr?.mainHead ?? null, causes: fr?.causes ?? [] }, reason: `Se pone al día con main${fr?.causes.length ? ` (tras ${fr.causes.join(', ')})` : ''}${fr?.overlap.length ? `: comparten ${fr.overlap.slice(0, 3).join(', ')}` : ''}.` }, `se pone al día con main${fr?.causes.length ? ` tras ${fr.causes.join(', ')}` : ''} antes de presentarla como vigente.`, 'integration');
      // Un merge a medias de una vuelta anterior (reinicio entre «merge» y «commit») se deshace antes de empezar.
      await abortPendingMerge(p0.result?.applied?.worktree ?? null);
      const prep = await prepareIntegration(slug, pid);
      setItem(slug, id, itemId, { revalidation: { ...getBatch(slug, id).items.find(i => i.itemId === itemId)!.revalidation!, mainHead: prep.status.targetHead } });
      if (prep.state === 'conflicts') {
        const files = prep.status.conflicts.map(c => c.path);
        const dev = procs.get(pid)!.steps.find(s => s.role === 'implementer');
        const team = dev ? checkTeam(slug, b.projectId, [{ agentId: dev.agentId, role: 'implementer' }], b.auth) : [];
        const blocked = !dev ? 'el proceso no tiene Desarrollador' : team.find(t => !t.ready)?.problem ?? aiRoom(slug, b);
        if (blocked) return setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'integration', revalidation: null, reason: `Conflictos reales con main en ${files.join(', ')} y no se pueden resolver solos (${blocked}). Nada cambió en main ni en su rama.` }, `conflictos reales al ponerse al día (${files.join(', ')}): decides tú.`, 'integration');
        setItem(slug, id, itemId, { revalidation: { ...getBatch(slug, id).items.find(i => i.itemId === itemId)!.revalidation!, step: 'resolve' } }, `conflictos reales en ${files.join(', ')}: el Desarrollador resuelve SOLO esas secciones (una llamada, dentro de los límites del lote).`, 'integration');
        requirePolicy('write_worktree', { slug, processId: pid, agentId: null, projectId: b.projectId, authorized: true });
        procs.resume(pid, Math.max(p0.budgetUsd ?? 0, p0.spentUsd));
        const run = resolveIntegrationConflicts(slug, pid, logger, () => isCancelled(pid)).finally(() => clearCancel(pid));
        await trackJob(pid, run);
      } else if (prep.state === 'candidate') {
        setItem(slug, id, itemId, { revalidation: { ...getBatch(slug, id).items.find(i => i.itemId === itemId)!.revalidation!, step: 'verify' } });
        procs.resume(pid, Math.max(p0.budgetUsd ?? 0, p0.spentUsd));
        await trackJob(pid, verifyCandidate(slug, pid, logger, () => isCancelled(pid)).finally(() => clearCancel(pid)));
      }
    } finally { lease.release(); }
    await finishRevalidation(slug, id, itemId);
  } catch (e: any) {
    acted = true;
    try { if (liveBatch(getBatch(slug, id))) setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'integration', revalidation: null, reason: `No se pudo poner al día con main: ${e?.message ?? e}. main no cambió.` }, `no se pudo poner al día: ${String(e?.message ?? e).slice(0, 300)}`, 'integration'); } catch { /* lote borrado */ }
  } finally { revalidating.delete(key); if (acted) void scheduleTick(slug, id); }
}

/** Lote en el que el coordinador aún actúa (no cancelado, revocado ni terminado). */
const liveBatch = (b: Batch) => b.status === 'running' || b.status === 'paused';
/** ¿El commit verificado de la historia ya está en main? (integrada fuera del lote o un reinicio tras integrarla). */
async function alreadyInMain(slug: string, p: Process): Promise<boolean> {
  const repo = projectsRepo(slug).repository(p.projectId); const c = p.result?.applied?.commit; const branch = p.result?.applied?.branch;
  if (!repo || !c || !branch || p.result?.merged) return false;
  const { mainBranch, repoRoot } = await import('./repoWrite.ts');
  return isAncestorIn(repo.path, c, await mainBranch(repoRoot(repo.path), branch));
}
const finishing = new Set<string>();

/**
 * Fin de una puesta al día, decidido con HECHOS de git y de la evidencia (no con «el proceso terminó»): el main que se
 * incorporó está en la rama, el commit actual está verificado en el sandbox y QA lo cubre. Si un paso se interrumpió, se
 * rehace desde git (nunca se da por vigente el commit viejo); si falta QA o corregir, vuelve a la cola en su turno.
 */
/** Commit actual de la dependencia de una historia apilada (la versión que se integró o la que se está revisando). */
function dependencyHead(slug: string, b: Batch, it: BatchItem): string | null {
  if (!it.stack) return null;
  const dep = b.items.find(i => i.storyId === it.stack!.storyId); if (!dep) return null;
  const procs = processesRepo(slug);
  const merged = [...dep.processIds].reverse().map(pid => procs.get(pid)).find(p => p?.result?.merged)?.result?.applied?.commit;
  const pid = currentProcessId(dep);
  return merged ?? (pid ? procs.get(pid)?.result?.applied?.commit ?? null : null);
}
const same7 = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.slice(0, 7) === b.slice(0, 7);
/**
 * Como dependencyHead, pero solo si la dependencia cambió su código PROPIO desde la versión sobre la que se preparó (huella
 * distinta de la que aceptaste): si solo incorporó main, la puesta al día con main basta y QA no repite por ella.
 */
function dependencyChangeHead(slug: string, b: Batch, it: BatchItem): string | null {
  const dh = dependencyHead(slug, b, it); if (!dh || !it.stack) return dh;
  const dep = b.items.find(i => i.storyId === it.stack!.storyId);
  return it.stack.patchId && dep?.acceptance?.patchId && it.stack.patchId === dep.acceptance.patchId ? null : dh;
}
/** ¿Falta que QA revise una historia apilada tras cambiar su dependencia? (su último commit revisado no contiene la versión final). */
async function dependencyQaPending(slug: string, b: Batch, it: BatchItem, p: Process): Promise<boolean> {
  const st = p.result?.stack; const dep = dependencyChangeHead(slug, b, it);
  if (!st || !dep || same7(dep, st.commit)) return false;
  const repo = projectsRepo(slug).repository(p.projectId); const qa = revisionStatus(p)?.qa.commit ?? null;
  return !repo || !qa || !(await isAncestorIn(repo.path, dep, qa));
}
async function finishRevalidation(slug: string, id: string, itemId: string, _p?: Process) {
  const key = `${slug}:${id}:${itemId}`; if (finishing.has(key)) return; finishing.add(key);
  try { await finishRevalidationNow(slug, id, itemId); } finally { finishing.delete(key); }
}
async function finishRevalidationNow(slug: string, id: string, itemId: string) {
  const b0 = getBatch(slug, id); const it = b0.items.find(i => i.itemId === itemId)!;
  // Un lote cerrado (o una historia que ya siguió otro camino) no se toca desde una tarea en segundo plano.
  if (!liveBatch(b0) || !['revalidating', 'running', 'integrating'].includes(it.state)) return;
  const pid = currentProcessId(it)!;
  const p = processesRepo(slug).get(pid)!;
  const pl = p.result?.pipeline; const rev = revisionStatus(p); const rv = it.revalidation;
  const causes = rv?.causes ?? [];
  if (p.status === 'cancelled') return setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'owner_decision', revalidation: null, reason: 'Puesta al día cancelada: decides tú.' }, 'puesta al día cancelada.');
  if (pl?.pauseKind === 'integration_conflict') return setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'integration', revalidation: null, reason: `${pl.reason ?? 'Los conflictos no se resolvieron.'} Decide cómo combinarlas (o pide cambios a una de las dos).` }, 'la resolución de conflictos no se aplicó: decides tú (la rama y main están como antes).', 'integration');
  if (pl?.pauseKind === 'interrupted' && uncertainCharge(p, rv?.at ?? '')) return setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'environment', revalidation: null, reason: 'La puesta al día se interrumpió con una llamada por la API en curso: su cobro no está confirmado. No se reenvía sola: decide si continuar.' }, 'puesta al día interrumpida con una llamada en curso: decides tú.', 'recovery');
  // Cualquier otra pausa de una llamada (límite de la suscripción, plazo del proveedor, turnos, presupuesto, permiso…) NO
  // se repite sola: decides tú (y si afecta a todo el lote, se pausa el lote), igual que en una historia.
  if (pl?.state !== 'verified' && pl?.pauseKind && pl.pauseKind !== 'integration' && pl.pauseKind !== 'interrupted') {
    const c = classifyStop(pl.pauseKind, p.status, pl.providerCode ?? p.result?.failure?.providerCode ?? null);
    setItem(slug, id, itemId, { state: 'needs_owner', failureClass: c.cls, revalidation: null, reason: `La puesta al día se detuvo: ${pl.reason ?? pl.pauseKind}` }, `la puesta al día se detuvo (${c.cls}): ${clip(pl.reason ?? pl.pauseKind, 300)}`, 'integration');
    if (c.batchWide) setStatus(slug, id, 'paused', `${it.storyId}: la puesta al día se detuvo por un motivo que afecta a todo el lote: ${clip(pl.reason ?? '', 300)} No se empieza nada más hasta que lo resuelvas y reanudes.`, 'pause');
    return;
  }
  const repo = projectsRepo(slug).repository(p.projectId); const branch = p.result?.applied?.branch;
  // La cabeza de la rama debe ser el commit REGISTRADO (el que se verificó y revisó): un merge sin registrar se rehace.
  const { git: gitIn, repoRoot } = await import('./repoWrite.ts');
  const headOk = !!repo && !!branch && !!p.result?.applied?.commit && (await gitIn(repoRoot(repo.path), ['rev-parse', branch]).catch(() => '')).startsWith(p.result.applied.commit.slice(0, 7));
  const incorporated = headOk && !!rv?.mainHead && await isAncestorIn(repo!.path, rv.mainHead, branch!);
  if (!incorporated) {
    // Un paso se interrumpió o no llegó a aplicarse: se rehace desde git en su turno (lista o, si la aceptaste, a integrar).
    return setItem(slug, id, itemId, { state: it.acceptance ? 'integrating' : 'ready', revalidation: null, freshness: null, reason: 'La puesta al día no terminó (se interrumpió o no se aplicó): se rehace desde git en su turno; la evidencia anterior no se da por vigente.' }, 'puesta al día incompleta: se rehace desde git (no se da por vigente).', 'recovery');
  }
  const what = `puesta al día con main${causes.length ? ` tras ${causes.join(', ')}` : ''}`;
  // Preparada sobre una versión provisional de su dependencia que cambió después (p. ej. pediste cambios): una combinación
  // limpia no basta; QA revisa el commit nuevo aunque git no vea conflictos (puede romperse el significado).
  const depQa = await dependencyQaPending(slug, b0, it, p);
  if (rev?.verifiedHead && rev.qa.coversHead && !depQa) {
    if (it.acceptance) {
      const patch = repo && branch ? await storyPatchId(repo.path, branch) : null;
      if (patch && it.acceptance.patchId && patch === it.acceptance.patchId) return setItem(slug, id, itemId, { state: 'integrating', revalidation: null, freshness: null, reason: `Aceptada: ${what}; ${rev.qa.why} Sus cambios son los mismos que aceptaste: se integra en su turno.` }, `${what}; sus cambios no cambiaron desde tu aceptación: sigue a integrarse.`, 'integration');
      return setItem(slug, id, itemId, { state: 'ready', acceptance: null, revalidation: null, freshness: null, reason: `Vuelve a revisarla: ${what}, y su código cambió desde que la aceptaste (conflictos resueltos o correcciones). Tu aceptación anterior no se usa.` }, `${what}; su código cambió desde tu aceptación: vuelve a revisarla (la aceptación anterior queda anulada).`, 'acceptance');
    }
    return setItem(slug, id, itemId, { state: 'ready', revalidation: null, freshness: null, reason: `Lista para tu revisión (sin integrar): ${what}; ${rev.qa.why}` }, `${what}: ${rev.qa.why}`, 'integration');
  }
  if (rv?.step === 'qa') return setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'integration', revalidation: null, reason: `La puesta al día terminó sin que QA cubra el commit actual: ${rev?.qa.why ?? 'sin evidencia'} Decide desde su proceso.` }, 'la puesta al día no dejó el commit cubierto por QA: decides tú.', 'integration');
  // Hace falta QA (o corregir): vuelve a la cola y el pipeline lo retoma en su turno. Si ya usó sus correcciones, se le
  // concede UNA más para ponerse al día (queda registrada): el límite técnico no castiga que main avanzara.
  const failing = !!p.result && verificationsForApplied(p.result).some(v => v.exitCode !== 0);
  const cfg = pl?.config;
  if (cfg && pl && pl.corrections >= cfg.maxCorrections) updatePipeline(slug, pid, { config: { ...cfg, maxCorrections: pl.corrections + 1 } }, { kind: 'info', message: 'Una corrección autorizada más para ponerla al día con main (el lote la cuenta en su tope de llamadas).' });
  setItem(slug, id, itemId, { state: 'queued', resumeProcessId: pid, revalidation: { ...(rv ?? { at: now(), mainHead: null, causes }), step: 'qa', forceQa: depQa }, reason: depQa && rev?.verifiedHead ? `Puesta al día con la versión final de ${it.stack!.storyId} (cambió desde que se preparó): verificada en el sandbox; QA revisa el commit nuevo en su turno.` : rev?.verifiedHead ? `Puesta al día: ${rev.qa.why} QA revisa el commit nuevo en su turno.` : failing ? 'Puesta al día: el candidato no supera la verificación con el main actual; el equipo lo corrige en su turno (dentro de las correcciones autorizadas).' : 'Puesta al día: el candidato aún no está verificado (la verificación no terminó); se verifica en su turno antes de QA.' }, rev?.verifiedHead ? 'candidato verificado; QA revisará el commit nuevo (lo que cambió con main).' : failing ? 'el candidato falla con el main actual: el equipo lo corregirá en su turno.' : 'el candidato aún no está verificado: se verifica en su turno (sin darlo por vigente).', 'integration');
}

const integratingNow = new Set<string>();
/** Tras un reinicio real no queda ninguna tarea del coordinador en memoria (las pruebas lo simulan con esto). */
export function forgetBatchJobs() { revalidating.clear(); integratingNow.clear(); finishing.clear(); planSig.clear(); forgetLeases(); }
/**
 * Integración al aceptar, en segundo plano (el coordinador no espera minutos): de una en una por lote. Solo con TU
 * aceptación; si su evidencia no está al día se pone al día antes; se integra solo si sus cambios son los mismos que
 * aceptaste (huella `patch-id`). main nunca recibe una combinación sin verificar (mergeStory lo exige bajo el carril).
 */
async function integrateAccepted(slug: string, id: string, itemId: string) {
  if ([...integratingNow].some(k => k.startsWith(`${slug}:${id}:`))) return;
  const key = `${slug}:${id}:${itemId}`; integratingNow.add(key);
  const snap = (): string => { const x = batchesRepo(slug).get(id)?.items.find(i => i.itemId === itemId); return JSON.stringify([x?.state, x?.reason, x?.acceptance?.patchId, x?.mergedCommit, x?.freshness?.status]); };
  const before = snap();
  void integrateAcceptedNow(slug, id, itemId)
    .catch(e => { try { setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'integration', reason: `No se integró: ${e?.message ?? e}` }, `no se integró (main no cambió): ${String(e?.message ?? e).slice(0, 300)}`, 'integration'); } catch { /* lote borrado */ } })
    // Solo se vuelve a pasar si algo cambió: si esperaba (proceso en marcha, arriendo ocupado) la despertará ese proceso
    // al terminar o la revisión periódica; nunca un bucle que no deja respirar al servidor.
    .finally(() => { integratingNow.delete(key); if (snap() !== before) void scheduleTick(slug, id); });
}
async function integrateAcceptedNow(slug: string, id: string, itemId: string) {
  const b = getBatch(slug, id); const it = b.items.find(i => i.itemId === itemId)!;
  const procs = processesRepo(slug); const pid = currentProcessId(it)!; const p = procs.get(pid);
  if (!p) return setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'integration', reason: 'Su proceso ya no existe.' });
  if (!it.acceptance) return setItem(slug, id, itemId, { state: 'ready', reason: 'No se integra sin tu aceptación.' });
  if (p.result?.merged) return afterMerge(slug, id, itemId, p);
  if (p.status === 'running' || p.status === 'pending_authorization') return;
  if (await alreadyInMain(slug, p)) { const m = await mergeStory(slug, pid, {}, logger); return afterMerge(slug, id, itemId, m); }
  const f = await freshnessOf(slug, p, { dependencyHead: dependencyChangeHead(slug, b, it) });
  if (f.status === 'unknown') return setItem(slug, id, itemId, { state: 'needs_owner', failureClass: f.stackInvalid ? 'dependency' : 'integration', ...(f.stackInvalid && it.stack ? { stack: { ...it.stack, invalid: f.detail }, acceptance: null } : {}), reason: `No se integra: ${f.detail}` }, `no se integra: ${f.detail}`, 'integration');
  if (f.status !== 'current') { setItem(slug, id, itemId, { freshness: f }); return revalidate(slug, id, itemId); }
  const repo = projectsRepo(slug).repository(b.projectId)!; const branch = p.result!.applied!.branch;
  const patch = await storyPatchId(repo.path, branch);
  if (!patch || patch !== it.acceptance.patchId) return setItem(slug, id, itemId, { state: 'ready', acceptance: null, reason: 'Vuelve a revisarla: sus cambios no son los que aceptaste (su código cambió desde tu aceptación). Tu aceptación anterior no se usa.' }, 'sus cambios no son los que aceptaste: vuelve a revisarla (la aceptación anterior queda anulada).', 'acceptance');
  const lease = acquireWork(slug, p, `batch:${id}`, 'integración del lote');
  if ('conflict' in lease) { const reason = `Aceptada; espera para integrarse: ${lease.conflict}`; if (it.reason !== reason) setItem(slug, id, itemId, { reason }); return; }
  try {
    if (getBatch(slug, id).status !== 'running') return;
    // Se comprueba otra vez DENTRO del carril, justo antes del merge: una pausa o una aceptación anulada mientras esperaba no integran.
    const guard = () => { const cur = batchesRepo(slug).get(id); const x = cur?.items.find(i => i.itemId === itemId); return !cur || cur.status !== 'running' ? 'el lote ya no está en marcha' : !x?.acceptance ? 'sin tu aceptación no se integra' : null; };
    const m = await mergeStory(slug, pid, { guard }, logger);
    await publishIfAuthorized(slug, id, itemId, pid, repo.path, m);
    setItem(slug, id, itemId, { integrationRetries: 0 });
    afterMerge(slug, id, itemId, procs.get(pid)!);
  } catch (e: any) {
    if (e?.code === 'integration_vetoed') return setItem(slug, id, itemId, { reason: `No se integró: ${e.message}. main no cambió.` }, `no se integró (${e.message}); main no cambió.`, 'integration');
    // main avanzó entre la comprobación y el carril (otra integración): se vuelve a evaluar en la siguiente vuelta.
    const n = (getBatch(slug, id).items.find(i => i.itemId === itemId)?.integrationRetries ?? 0) + 1;
    if ((e?.code === 'integration_candidate_required' || e?.code === 'merge_conflict') && n <= 3) return setItem(slug, id, itemId, { integrationRetries: n, freshness: null, reason: `main avanzó mientras se integraba: se pone al día otra vez (intento ${n} de 3).` }, `main avanzó al integrar; se pone al día otra vez (intento ${n} de 3).`, 'integration');
    setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'integration', reason: `No se integró: ${e?.message ?? e}` }, `no se integró (main no cambió): ${String(e?.message ?? e).slice(0, 300)}`, 'integration');
  } finally { lease.release(); }
}

/**
 * Publicar en GitHub tras integrar, solo si el lote lo autoriza EN ESTE MOMENTO (se lee al publicar: un cambio de política
 * que quitó «publicar» se respeta aunque la integración empezara antes).
 */
async function publishIfAuthorized(slug: string, id: string, itemId: string, pid: string, repoPath: string, m: Process) {
  const b = getBatch(slug, id); if (!b.auth.git.publish) return;
  requirePolicy('git_push', { slug, processId: pid, projectId: b.projectId, authorized: true });
  // Hasta la integración de ESTA historia (su commit), no lo que main tenga después.
  const mg = m.result!.merged!; const pushed = await pushBranches(repoPath, [m.result!.applied!.branch, mg.into], /^[0-9a-f]{40}$/.test(mg.commit ?? '') ? { [mg.into]: mg.commit } : {});
  const procs = processesRepo(slug); procs.setResult(pid, { ...procs.get(pid)!.result!, published: { ...pushed, pushedAt: now() } });
  setItem(slug, id, itemId, {}, `publicada en ${pushed.remote} (pre-autorizado en el lote).`, 'integration');
}

/** Cierre de una historia que aceptaste y ya está en main (y activa y comprobada, si es el Portal): una sola aceptación. */
function closeAccepted(slug: string, id: string, itemId: string, p: Process, commit: string) {
  const b = getBatch(slug, id); const it = b.items.find(i => i.itemId === itemId)!; const procs = processesRepo(slug); const at = now();
  if (it.state === 'accepted') return; // ya cerrada (una sola aceptación registrada)
  procs.setResult(p.id, { ...procs.get(p.id)!.result!, acceptance: { at: it.acceptance?.at ?? at, by: 'owner', batchId: id, note: it.acceptance?.note ?? null } });
  backlogRepo(slug).setStatus(itemId, 'done', p.id);
  procs.logExecution({ projectId: b.projectId, agentId: '', kind: `owner_acceptance:${it.storyId}`, status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: at });
  setItem(slug, id, itemId, { state: 'accepted', mergedCommit: commit, freshness: null, revalidation: null, reason: `Aceptada e integrada en main (${commit})${it.activated ? ', activa y comprobada en ejecución' : ''}: cerrada.` }, `aceptada e integrada en main (${commit}); historia cerrada.`, 'acceptance');
}

/** ¿Queda margen en el lote para una llamada más a la suscripción? (el tope se comprueba también en cada llamada). */
function aiRoom(slug: string, b: Batch): string | null {
  return b.auth.backends.includes('claude_code') && subscriptionCalls(slug, b) >= b.auth.maxSubscriptionCalls ? `se alcanzó el tope de llamadas a la suscripción del lote (${b.auth.maxSubscriptionCalls})` : null;
}

function setItem(slug: string, id: string, itemId: string, patch: Partial<BatchItem>, event?: string, kind: 'item' | 'integration' | 'activation' | 'recovery' | 'acceptance' = 'item') {
  batchesRepo(slug).update(id, b => {
    const it = b.items.find(i => i.itemId === itemId); if (!it) return;
    Object.assign(it, patch);
    if (event) b.events.push({ at: now(), kind, itemId, message: `${it.storyId}: ${event}` });
  });
}
function setStatus(slug: string, id: string, status: Batch['status'], reason: string | null, kind: 'pause' | 'resume' | 'cancel' | 'revoke' | 'completed' | 'budget' | 'close', fix: { label: string; href: string } | null = null) {
  batchesRepo(slug).update(id, b => {
    b.status = status; b.reason = reason; b.reasonFix = fix;
    if (status === 'completed' || status === 'cancelled' || status === 'revoked') b.finishedAt = now();
    if (status === 'revoked') b.revokedAt = now();
    if (reason || kind === 'resume') b.events.push({ at: now(), kind, message: reason ?? 'Lote reanudado por el propietario.' });
  });
}

/** Estados en los que una iteración que autorizas desde la historia pasa a «sigue fuera del lote». */
const ADOPTABLE: BatchItemState[] = ['queued', 'needs_owner', 'failed', 'rejected', 'awaiting_integration', 'awaiting_acceptance', 'ready', 'postponed', 'prepared'];

/**
 * ¿Hay una iteración de esta historia creada FUERA del lote después de que el lote la empezara (o se autorizara)? Las del
 * lote (`processIds`, `nextProcessId`) y las de otros lotes en marcha no cuentan; una cancelada tampoco.
 */
function outsideIteration(slug: string, b: Batch, it: BatchItem): Process | null {
  // Las del lote, la que ya sigue y las de fuera que ya se resolvieron (canceladas o rechazadas) no se adoptan otra vez.
  const mine = new Set([...it.processIds, it.nextProcessId ?? '', it.resumeProcessId ?? '', it.followedProcessId ?? '', ...(it.dismissedProcessIds ?? [])]);
  const others = new Set(batchesRepo(slug).active().filter(x => x.id !== b.id).flatMap(x => x.items.flatMap(i => [...i.processIds, i.nextProcessId ?? ''])));
  const since = it.startedAt ?? b.createdAt;
  const latest = processesRepo(slug).listByBacklogItem(it.itemId).filter(p => p.kind === 'story_execution').at(-1);
  if (!latest || mine.has(latest.id) || others.has(latest.id) || latest.status === 'cancelled' || latest.createdAt <= since) return null;
  return latest;
}

/** Sigue (sin ejecutarla) la iteración que autorizaste fuera del lote: su estado, su integración o su cancelación. */
function followExternal(slug: string, id: string, it: BatchItem, p: Process) {
  const ref = `proceso ${p.id.slice(0, 8)}`;
  if (p.result?.merged) return setItem(slug, id, it.itemId, { state: 'awaiting_acceptance', mergedCommit: p.result.merged.commit, activated: false, failureClass: null, finishedAt: now(), reason: `Integrada fuera del lote (${ref}, ${p.result.merged.commit}): falta tu aceptación.` }, `su iteración fuera del lote (${ref}) quedó integrada en main (${p.result.merged.commit}); pendiente de tu aceptación.`, 'integration');
  if (p.status === 'cancelled' || p.result?.rejected) return setItem(slug, id, it.itemId, { state: 'needs_owner', failureClass: 'owner_decision', reason: `La iteración fuera del lote (${ref}) se ${p.result?.rejected ? 'rechazó' : 'canceló'}: decide si el lote la retoma (reintentar o iterar).`, followedProcessId: null, dismissedProcessIds: [...(it.dismissedProcessIds ?? []), p.id] }, `su iteración fuera del lote (${ref}) se ${p.result?.rejected ? 'rechazó' : 'canceló'}; decides tú.`);
  const reason = p.status === 'pending_authorization' ? `Iteración preparada fuera del lote (${ref}), pendiente de tu autorización: el lote no la ejecuta ni la repite; la sigue.`
    : p.status === 'running' ? `En marcha fuera del lote (${ref}, autorizada por ti): el lote la sigue sin ejecutarla otra vez ni integrarla.`
    : `Iteración fuera del lote (${ref}) detenida o terminada sin integrar: decides tú desde su proceso (integrarla no está en la autorización del lote).`;
  if (it.reason !== reason) setItem(slug, id, it.itemId, { reason });
}

/** Refleja en cada historia lo que pasó en su proceso (también lo que hiciste tú fuera del lote). */
function syncItems(slug: string, id: string) {
  const b = batchesRepo(slug).get(id); if (!b) return;
  const procs = processesRepo(slug);
  for (const it0 of b.items) {
    let it = it0;
    if (ADOPTABLE.includes(it.state)) {
      const ext = outsideIteration(slug, b, it);
      if (ext) {
        setItem(slug, id, it.itemId, { state: 'external', followedProcessId: ext.id, failureClass: null }, `autorizaste una iteración fuera del lote (proceso ${ext.id.slice(0, 8)}): el lote la sigue, no la ejecuta otra vez ni la integra, y su gasto no cuenta en el lote.`);
        it = batchesRepo(slug).get(id)!.items.find(i => i.itemId === it0.itemId)!;
      }
    }
    if (it.state === 'external') { const fp = it.followedProcessId ? procs.get(it.followedProcessId) : undefined; if (fp) followExternal(slug, id, it, fp); continue; }
    // La iteración preparada por el lote (en cola) la autorizaste tú desde su proceso: el lote la sigue, no la repite.
    if (it.state === 'queued' && it.nextProcessId) { const np = procs.get(it.nextProcessId); if (np && np.status === 'running') { setItem(slug, id, it.itemId, { state: 'running', processId: np.id, processIds: [...it.processIds.filter(x => x !== np.id), np.id], nextProcessId: null, reason: null, startedAt: now(), finishedAt: null }, `la autorizaste desde su proceso (${np.id.slice(0, 8)}): el lote la sigue sin ejecutarla otra vez.`); continue; } }
    const p = it.processId ? procs.get(it.processId) : undefined; if (!p) continue;
    if (it.state === 'running') {
      if (p.status === 'running') continue; // en marcha (o huérfano: lo trata la recuperación al arrancar)
      onFinished(slug, id, it, p);
    } else if (it.state === 'needs_owner' || it.state === 'failed') {
      // Lo retomaste desde el proceso: el lote vuelve a seguirlo.
      if (p.status === 'running') { if (!isCancelled(p.id) && !it.stack?.invalid) setItem(slug, id, it.itemId, { state: 'running', reason: null, failureClass: null }, 'la retomaste desde el proceso; el lote la sigue.'); }
      else if (p.result?.merged) { if (it.acceptance) setItem(slug, id, it.itemId, { acceptance: null }); afterMerge(slug, id, it.itemId, p); }
      else if (p.status === 'done' && p.result?.pipeline?.state === 'verified' && it.failureClass !== 'integration' && it.failureClass !== 'dependency' && !it.stack?.invalid) technicalDone(slug, id, it.itemId, p);
    } else if (it.state === 'awaiting_integration') {
      if (p.result?.merged) afterMerge(slug, id, it.itemId, p);
    } else if (it.state === 'ready' || it.state === 'postponed' || it.state === 'prepared') {
      // Lo hiciste desde el proceso: integrarla a mano (queda pendiente de tu aceptación) o continuarla (el lote la sigue).
      if (p.result?.merged) { if (it.acceptance) setItem(slug, id, it.itemId, { acceptance: null }); afterMerge(slug, id, it.itemId, p); }
      else if (p.status === 'running' && (it.state === 'ready' || it.state === 'prepared')) setItem(slug, id, it.itemId, { state: 'running', reason: null, failureClass: null, freshness: null }, 'la retomaste desde el proceso; el lote la sigue.');
    } else if (it.state === 'revalidating') {
      // Sin la tarea en memoria (p. ej. tras un reinicio): se decide con hechos de git, sin dar nada por vigente.
      if (p.status !== 'running' && !revalidating.has(`${slug}:${id}:${it.itemId}`)) void finishRevalidation(slug, id, it.itemId).then(() => scheduleTick(slug, id)).catch(e => logger({ batchId: id, err: e?.message }, 'lote: no se pudo cerrar la puesta al día'));
    } else if (it.state === 'awaiting_acceptance' && backlogRepo(slug).get(it.itemId)?.status === 'done') {
      setItem(slug, id, it.itemId, { state: 'accepted', acceptance: { at: now(), note: 'Cerrada desde la historia.', checks: null } }, 'cerrada por ti desde la historia (cuenta como aceptada).', 'acceptance');
    }
  }
}

function onFinished(slug: string, id: string, it: BatchItem, p: Process) {
  const pl = p.result?.pipeline;
  if (p.status === 'done' && pl?.state === 'verified') return technicalDone(slug, id, it.itemId, p);
  if (p.status === 'cancelled' && batchesRepo(slug).get(id)!.status !== 'running') return setItem(slug, id, it.itemId, { state: 'cancelled', finishedAt: now(), reason: 'Cancelada con el lote.' }, 'cancelada.');
  const code = p.result?.failure?.providerCode ?? pl?.providerCode ?? null;
  const c = classifyStop(pl?.pauseKind, p.status, code);
  const reason = pl?.reason ?? p.error ?? 'El pipeline se detuvo.';
  const why = code === 'call_cap' || pl?.pauseKind === 'call_cap' ? 'tope de llamadas a la suscripción autorizado' : c.cls === 'subscription' ? 'límite de la suscripción de Claude' : code === 'origin_not_allowed' ? 'un agente usa un origen que el lote no autoriza' : code === 'backend_unavailable' ? 'Claude Code no disponible' : 'entorno de verificación';
  // Un motivo de todo el lote (límite de la suscripción, Claude Code no disponible) no es un fallo de la historia: espera tu decisión.
  setItem(slug, id, it.itemId, { state: p.status === 'failed' && !c.batchWide ? 'failed' : 'needs_owner', failureClass: c.cls, reason, finishedAt: now() }, `${p.status === 'failed' && !c.batchWide ? 'falló' : 'se detuvo'} (${c.cls}): ${clip(reason, 400)}${c.batchWide ? '' : ' Las historias independientes siguen.'}`);
  // El mismo motivo detendría a las demás (límite de la suscripción, sandbox caído): se pausa todo el lote.
  if (c.batchWide) setStatus(slug, id, 'paused', `${it.storyId} se detuvo por un motivo que afecta a todo el lote (${why}): ${clip(reason, 400)} No se empieza nada más hasta que lo resuelvas y reanudes.${code === 'call_cap' || pl?.pauseKind === 'call_cap' ? ' Para seguir: «Reanudar» concediendo más llamadas a la suscripción; se retoma donde quedó, sin repetir lo hecho.' : ''}`, 'pause', { label: `Proceso de ${it.storyId}`, href: `/procesos/${p.id}` });
}

function technicalDone(slug: string, id: string, itemId: string, p: Process) {
  if (p.result?.merged) return afterMerge(slug, id, itemId, p);
  const b = batchesRepo(slug).get(id)!;
  // Integración al aceptar: SIEMPRE «lista» (también con el lote en pausa); nada entra en main sin tu aceptación. Si
  // venía de ponerse al día, se decide con hechos de git (main incorporado, commit verificado y cubierto por QA).
  if (onAcceptance(b)) {
    const it = b.items.find(i => i.itemId === itemId)!;
    if (it.revalidation) return void finishRevalidation(slug, id, itemId, p).then(() => scheduleTick(slug, id)).catch(e => logger({ batchId: id, itemId, err: e?.message }, 'lote: no se pudo cerrar la puesta al día'));
    if (p.result?.stack && !dependencyIntegrated(b, it)) return setItem(slug, id, itemId, { state: 'prepared', freshness: null, failureClass: null, finishedAt: now(), reason: `Preparada sobre ${p.result.stack.storyId} (${p.result.stack.commit.slice(0, 7)}, su versión verificada y revisada, sin integrar): verificación, QA y Gauntlet según el modo. No se integra antes que ${p.result.stack.storyId}: cuando la aceptes e integres, se pone al día con su versión final y pasa a lista.` }, `terminada técnicamente sobre la versión provisional de ${p.result.stack.storyId}: preparada (no lista para integrar).`);
    // La habías aceptado y volvió a trabajar (p. ej. la retomaste): se integra solo si sus cambios son los que aceptaste.
    if (it.acceptance) return setItem(slug, id, itemId, { state: 'integrating', failureClass: null, finishedAt: now(), reason: 'Aceptada: antes de integrarla se comprueba que sus cambios son los que aceptaste y que su evidencia está al día.' }, 'terminada otra vez; aceptada: se comprueba antes de integrarla.');
    return setItem(slug, id, itemId, { state: 'ready', freshness: null, failureClass: null, finishedAt: now(), reason: 'Terminada técnicamente (verificación, QA y Gauntlet según el modo): lista para tu revisión, sin integrar.' }, 'terminada técnicamente; lista para tu revisión (no se integra sin tu aceptación).');
  }
  if (b.auth.git.merge && b.status === 'running') setItem(slug, id, itemId, { state: 'integrating', reason: 'Terminada técnicamente: se integrará en main (de una en una).', failureClass: null, finishedAt: now() }, 'terminada técnicamente (verificación, QA y Gauntlet según el modo); pasa a integración.');
  else setItem(slug, id, itemId, { state: 'awaiting_integration', reason: b.auth.git.merge ? 'Terminada técnicamente; el lote no está en marcha: intégrala desde el proceso o reanuda el lote.' : 'Terminada técnicamente. Integrar en main no estaba pre-autorizado en el lote: hazlo desde el proceso.', failureClass: null, finishedAt: now() }, 'terminada técnicamente; integrar es decisión tuya.');
}

/** ¿La dependencia del lote de una historia ya está en main? (aceptada o integrada). */
function dependencyIntegrated(b: Batch, it: BatchItem): boolean {
  const storyId = it.stack?.storyId ?? (it.dependsInBatch ? it.dependsOn : null); if (!storyId) return true;
  const dep = b.items.find(i => i.storyId === storyId);
  return !dep || DEPENDENCY_SATISFIED.includes(dep.state) || !!dep.mergedCommit;
}

/**
 * ¿Se puede preparar `it` sobre la versión actual de su dependencia `dep` (sin integrar)? Devuelve el motivo si no. Solo
 * sobre una versión terminada, verificada en el sandbox y cubierta por QA, de una dependencia que no está ella misma
 * apilada (un solo nivel) ni trabajando. Los hechos de git (cabeza de su rama, rama propia libre) se comprueban al empezar.
 */
function stackable(slug: string, b: Batch, dep: BatchItem, it: BatchItem): string | null {
  if (dep.stack) return `${dep.storyId} también se preparó sobre una versión provisional (solo se apila un nivel)`;
  const p = processesRepo(slug).get(currentProcessId(dep) ?? '');
  if (it.noStack && (!it.noStackFor || same7(it.noStackFor, p?.result?.applied?.commit))) return it.noStack;
  if (!p?.result?.applied?.branch) return `${dep.storyId} no tiene una rama aplicada`;
  if (p.status === 'running' || p.status === 'pending_authorization') return `${dep.storyId} está trabajando`;
  const rev = revisionStatus(p);
  if (!rev?.verifiedHead) return `la versión de ${dep.storyId} no está verificada en el sandbox`;
  if (!rev.qa.coversHead) return `QA no cubre la versión actual de ${dep.storyId}`;
  return null;
}

function afterMerge(slug: string, id: string, itemId: string, p: Process) {
  const b = batchesRepo(slug).get(id)!;
  const internal = slug === INTERNAL_WORKSPACE.slug;
  const commit = p.result!.merged!.commit;
  if (internal && b.auth.git.activate && (!onAcceptance(b) || !!b.items.find(i => i.itemId === itemId)?.acceptance)) return setItem(slug, id, itemId, { state: 'integrating', mergedCommit: commit, activated: false, reason: `Integrada en main (${commit}); se activará en el Portal cuando no haya nada en marcha.` }, `integrada en main (${commit}).`, 'integration');
  // Ya la aceptaste (integración al aceptar): no se pide otra aceptación; queda cerrada.
  if (b.items.find(i => i.itemId === itemId)?.acceptance && onAcceptance(b)) return closeAccepted(slug, id, itemId, p, commit);
  setItem(slug, id, itemId, { state: 'awaiting_acceptance', mergedCommit: commit, reason: internal ? `Integrada en main (${commit}). Activarla en el Portal en marcha (reconstruir y reiniciar) es decisión tuya: la aceptación lo exige.` : `Integrada en main (${commit}) y verificada: falta tu aceptación.` }, `integrada en main (${commit}); pendiente de tu aceptación.`, 'integration');
}

function resolveDependencies(slug: string, id: string) {
  const b = batchesRepo(slug).get(id)!;
  for (const it of b.items.filter(i => i.state === 'prepared')) {
    const dep = b.items.find(i => i.storyId === (it.stack?.storyId ?? it.dependsOn));
    const st = it.stack;
    if (!dep || DEPENDENCY_SATISFIED.includes(dep.state) || dep.mergedCommit) { setItem(slug, id, it.itemId, { state: 'ready', freshness: null, reason: `${dep?.storyId ?? 'Su dependencia'} ya está en main: se comprueba si su evidencia sigue valiendo y, si hace falta, se pone al día con la versión final (git, sandbox y QA si cambió).` }, `su dependencia ${dep?.storyId ?? ''} ya está en main: pasa a lista (se pone al día si hace falta).`); continue; }
    if (dep.state === 'rejected' || dep.state === 'postponed' || DEPENDENCY_BROKEN.includes(dep.state)) { setItem(slug, id, it.itemId, { state: 'blocked', failureClass: 'dependency', reason: `Preparada sobre ${dep.storyId}, que ${dep.state === 'rejected' ? 'no aceptaste' : dep.state === 'postponed' ? 'aplazaste' : `quedó ${ITEM_LABEL[dep.state]}`}: su trabajo se conserva; si iteras o recuperas ${dep.storyId}, vuelve a «preparada».` }, `bloqueada: ${dep.storyId} quedó ${ITEM_LABEL[dep.state]} (su trabajo se conserva).`); continue; }
    const dh = dependencyHead(slug, b, it);
    const reason = st && dh && !same7(dh, st.commit)
      ? `Preparada sobre ${dep.storyId} ${st.commit.slice(0, 7)}; ${dep.storyId} cambió desde entonces (${dh.slice(0, 7)}): se pondrá al día con su versión final (y QA la revisará) cuando la aceptes e integres.`
      : `Preparada sobre ${dep.storyId}${st ? ` ${st.commit.slice(0, 7)}` : ''} (sin integrar): se revisa e integra después de ${dep.storyId}.`;
    if (it.reason !== reason) setItem(slug, id, it.itemId, { reason });
  }
  for (const it of b.items.filter(i => i.state === 'waiting_dependency')) {
    const dep = b.items.find(i => i.storyId === it.dependsOn);
    if (!dep) { setItem(slug, id, it.itemId, { state: 'queued', reason: null }); continue; }
    if (DEPENDENCY_SATISFIED.includes(dep.state)) setItem(slug, id, it.itemId, { state: 'queued', reason: null }, `su dependencia ${dep.storyId} ya está integrada; entra en la cola.`);
    else if (onAcceptance(b) && (dep.state === 'rejected' || dep.state === 'postponed')) setItem(slug, id, it.itemId, { state: 'blocked', failureClass: 'dependency', reason: `Depende de ${dep.storyId}, que ${dep.state === 'rejected' ? 'no aceptaste' : 'aplazaste'}: necesita su código en main. Si la iteras o la recuperas, esta vuelve a esperarla.`, finishedAt: now() }, `bloqueada: su dependencia ${dep.storyId} quedó ${ITEM_LABEL[dep.state]}.`);
    else if (onAcceptance(b) && b.auth.git.prepareDependents && dep.state === 'ready' && !it.resumeProcessId && !it.stack && !stackable(slug, b, dep, it)) {
      const dp = processesRepo(slug).get(currentProcessId(dep)!)!;
      const stack = { storyId: dep.storyId, itemId: dep.itemId, processId: dp.id, commit: dp.result!.applied!.commit, branch: dp.result!.applied!.branch, at: now() };
      setItem(slug, id, it.itemId, { state: 'queued', stack, reason: `Se prepara sobre la versión verificada y revisada de ${dep.storyId} (commit ${stack.commit}, sin integrar), sin esperar a tu revisión. No se integrará antes que ${dep.storyId}.` }, `se preparará sobre la versión provisional de ${dep.storyId} (${stack.commit}); no se integra antes que ella.`);
    }
    else if (onAcceptance(b) && (dep.state === 'ready' || dep.state === 'revalidating' || dep.state === 'integrating' || dep.state === 'prepared')) {
      const why = b.auth.git.prepareDependents && dep.state === 'ready' ? stackable(slug, b, dep, it) : null;
      const reason = `Espera a que aceptes e integres ${dep.storyId} (necesita su código en main)${why ? `; no se prepara antes sobre su versión provisional: ${why}` : ''}: revísala primero.`;
      if (it.reason !== reason) setItem(slug, id, it.itemId, { reason });
    }
    else if (DEPENDENCY_BROKEN.includes(dep.state)) setItem(slug, id, it.itemId, { state: 'blocked', failureClass: 'dependency', reason: `Depende de ${dep.storyId}, que quedó ${ITEM_LABEL[dep.state]}: no se ejecuta (no se omite en silencio).`, finishedAt: now() }, `bloqueada: su dependencia ${dep.storyId} quedó ${ITEM_LABEL[dep.state]}.`);
    else { const reason = `Espera a ${dep.storyId} (${ITEM_LABEL[dep.state]}).`; if (it.reason !== reason) setItem(slug, id, it.itemId, { reason }); }
  }
}

/**
 * Integración automática (lotes 'auto'): marcada «en curso» mientras dura (también la espera por el carril), para que un
 * cambio de política no se aplique a medias; el merge se veta dentro del carril si la política cambió o el lote se pausó.
 */
async function integrate(slug: string, id: string, itemId: string) {
  const key = `${slug}:${id}:${itemId}`; integratingNow.add(key);
  try { await integrateAuto(slug, id, itemId); } finally { integratingNow.delete(key); }
}
async function integrateAuto(slug: string, id: string, itemId: string) {
  const b = batchesRepo(slug).get(id)!; const it = b.items.find(i => i.itemId === itemId)!;
  const procs = processesRepo(slug); const pid = it.processId!;
  const repoPath = projectsRepo(slug).repository(b.projectId)?.path ?? b.projectId;
  // Arriendo de la historia: ni tú ni otro lote la tocáis mientras se integra. Preparar el candidato e integrar en main
  // van por el carril del repositorio (cada uno lo toma); verificar el candidato (minutos) no lo bloquea.
  const lease = acquireWork(slug, procs.get(pid)!, `batch:${id}`, 'integración del lote');
  if ('conflict' in lease) { const reason = `Espera para integrar: ${lease.conflict}`; if (it.reason !== reason) setItem(slug, id, itemId, { reason }); return; }
  try {
    const p = procs.get(pid)!;
    if (p.result?.merged) return afterMerge(slug, id, itemId, p);
    try {
      if (await alreadyInMain(slug, p)) return afterMerge(slug, id, itemId, await mergeStory(slug, pid, {}, logger));
      // main avanzó (otra historia ya integrada): candidato sin IA y verificación objetiva antes de integrar.
      const prep = await prepareIntegration(slug, pid);
      if (prep.state === 'conflicts') return setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'integration', reason: `Conflictos reales con ${prep.status.target} en ${prep.status.conflicts.map(c => c.path).join(', ')}. Nada cambió en main; resuélvelos desde el proceso.` }, 'conflictos reales al integrar: decides tú (main no cambió).', 'integration');
      if (prep.state === 'candidate') {
        setItem(slug, id, itemId, {}, `main avanzó: candidato preparado sin IA; se verifica en el sandbox antes de integrar.`, 'integration');
        await verifyCandidate(slug, pid, logger, () => isCancelled(pid));
      }
      if (batchesRepo(slug).get(id)!.status !== 'running') return setItem(slug, id, itemId, { state: 'awaiting_integration', reason: 'El lote se pausó antes de integrar: intégrala desde el proceso o reanuda el lote.' });
      // La integración pre-autorizada solo con la aprobación de QA cubriendo lo que se integra (por commit): un candidato
      // con conflictos resueltos por el agente, o en el que main tocó archivos de la historia, espera a QA o a ti.
      const rev = revisionStatus(procs.get(pid)!);
      // Revisar con QA un candidato verificado es verificación rutinaria dentro del lote (una llamada): vuelve a la cola y
      // QA lo revisa en su turno; integrar sigue exigiendo que QA cubra el commit.
      if (candidateNeedsQa(procs.get(pid)!)) return setItem(slug, id, itemId, { state: 'queued', resumeProcessId: pid, reason: `${rev!.qa.why} QA revisa el candidato en su turno; después se integra.` }, `QA revisará el candidato antes de integrarlo: ${rev!.qa.why}`, 'integration');
      if (rev && rev.qa.state === 'approved' && !rev.qa.coversHead) return setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'integration', reason: `${rev.qa.why} Pide a QA que revise el candidato o intégralo tú desde el proceso.` }, `no se integra sola: ${rev.qa.why}`, 'integration');
      const guard = () => { const cur = batchesRepo(slug).get(id); const x = cur?.items.find(i => i.itemId === itemId); return !cur || cur.status !== 'running' ? 'el lote ya no está en marcha' : onAcceptance(cur) && !x?.acceptance ? 'la política del lote cambió a «integrar al aceptar» y no la has aceptado' : null; };
      const m = await mergeStory(slug, pid, { guard }, logger);
      await publishIfAuthorized(slug, id, itemId, pid, repoPath, m);
      setItem(slug, id, itemId, { integrationRetries: 0 });
      afterMerge(slug, id, itemId, procs.get(pid)!);
    } catch (e: any) {
      if (e?.code === 'integration_vetoed') return setItem(slug, id, itemId, onAcceptance(getBatch(slug, id)) ? { state: 'ready', freshness: null, acceptance: null, reason: 'Terminada técnicamente: con la política actual espera tu revisión (no se integra sin tu aceptación).' } : { state: 'awaiting_integration', reason: `No se integró: ${e.message}. Intégrala desde el proceso o reanuda el lote.` }, `no se integró (${e.message}); main no cambió.`, 'integration');
      // main avanzó mientras se verificaba el candidato (otra integración): se prepara otro en la siguiente vuelta, sin IA.
      const n = (getBatch(slug, id).items.find(i => i.itemId === itemId)?.integrationRetries ?? 0) + 1;
      if (e?.code === 'integration_candidate_required' && n <= 3) return setItem(slug, id, itemId, { integrationRetries: n, reason: `main avanzó mientras se verificaba el candidato: se prepara otro sin IA (intento ${n} de 3).` }, `main avanzó durante la verificación; nuevo candidato (intento ${n} de 3).`, 'integration');
      setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'integration', reason: `No se integró: ${e?.message ?? e}` }, `no se integró (main no cambió): ${String(e?.message ?? e).slice(0, 300)}`, 'integration');
    }
  } finally { lease.release(); }
}

/** Proyecto interno: reconstruir y reiniciar el Portal (de una en una, con nada en marcha). Devuelve true si se pidió. */
async function maybeActivate(slug: string, id: string): Promise<boolean> {
  const b = batchesRepo(slug).get(id)!;
  if (slug !== INTERNAL_WORKSPACE.slug || !b.auth.git.activate || b.activation?.state === 'requested') return b.activation?.state === 'requested';
  // Con integración al aceptar solo se activa lo que aceptaste (lo integrado antes de cambiar de política no reinicia el Portal).
  const pending = b.items.filter(i => i.state === 'integrating' && i.mergedCommit && !i.activated && (!onAcceptance(b) || !!i.acceptance));
  if (!pending.length) return false;
  if (b.items.some(i => i.state === 'running' || i.state === 'revalidating' || (i.state === 'integrating' && !i.mergedCommit))) return false;
  if ([...integratingNow, ...revalidating].some(k => k.startsWith(`${slug}:${id}:`))) return false;
  // Reiniciar interrumpiría lo que esté en marcha (también lo que autorizaste fuera del lote): se espera y se dice por qué.
  const others = processesRepo(slug).running();
  if (others.length) {
    const reason = `Activación pendiente de ${pending.map(i => i.storyId).join(', ')}: se reconstruirá y reiniciará el Portal cuando terminen ${others.length} proceso(s) en marcha (${others.slice(0, 3).map(p => `«${p.title}»`).join(', ')}); reiniciar ahora los interrumpiría.`;
    if (b.reason !== reason) batchesRepo(slug).update(id, x => { x.reason = reason; });
    return false;
  }
  requirePolicy('restart_portal', { slug, authorized: true });
  batchesRepo(slug).update(id, x => {
    x.activation = { state: 'requested', requestedAt: now(), commit: pending.at(-1)!.mergedCommit ?? null, itemIds: pending.map(i => i.itemId), detail: null };
    x.events.push({ at: now(), kind: 'activation', message: `Activación pre-autorizada: se reconstruye y reinicia el Portal con ${pending.map(i => i.storyId).join(', ')} (nada en marcha). Al volver se comprueba en ejecución.` });
  });
  await batchDeps.activate(logger);
  return true;
}

/** Al volver del reinicio: ¿el Portal en marcha contiene lo integrado? Verificación en ejecución y aceptación. */
export async function finishActivation(slug: string, id: string) {
  const b = batchesRepo(slug).get(id); if (!b || b.activation?.state !== 'requested') return;
  const procs = processesRepo(slug);
  for (const itemId of b.activation.itemIds) {
    const it = b.items.find(i => i.itemId === itemId); const p = it?.processId ? procs.get(it.processId) : undefined;
    if (!it || !p?.result?.merged) continue;
    const st = await batchDeps.activation(p.result.merged.commit, p.result.merged.mergedAt);
    if (!st.active) {
      batchesRepo(slug).update(id, x => { x.activation = { ...x.activation!, state: 'failed', detail: st.reason }; });
      setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'environment', reason: `Integrada pero no activa en el Portal en marcha: ${st.reason}` }, `no quedó activa: ${st.reason}`, 'activation');
      setStatus(slug, id, 'paused', `La activación no se completó (${st.reason}). No se empieza nada más hasta que lo revises.`, 'pause');
      return;
    }
    requirePolicy('runtime_check', { slug, processId: p.id, projectId: b.projectId, authorized: true });
    const checks = [...defaultChecks(), ...(p.result.runtimeChecks?.checks ?? [])];
    const results = await batchDeps.runtimeChecks(p.id, checks);
    procs.setResult(p.id, { ...procs.get(p.id)!.result!, runtimeChecks: { checks, results, ranAt: now() } });
    const ok = results.every(r => r.status === 'ok');
    procs.logExecution({ projectId: b.projectId, agentId: '', kind: `runtime_check:${ok ? 'ok' : 'fail'}`, status: ok ? 'done' : 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: now() });
    if (!ok) {
      setItem(slug, id, itemId, { state: 'needs_owner', activated: true, failureClass: 'environment', reason: `Activa, pero la verificación en ejecución falló: ${results.filter(r => r.status !== 'ok').map(r => `${r.check.kind} ${r.check.path}: ${r.detail}`).join(' · ')}` }, 'activa, pero la verificación en ejecución falló.', 'activation');
      setStatus(slug, id, 'paused', `La verificación en ejecución de ${it.storyId} falló tras activarla: el lote se pausa para que lo revises.`, 'pause');
    } else if (it.acceptance && onAcceptance(b)) { setItem(slug, id, itemId, { activated: true }, 'activa y verificada en ejecución.', 'activation'); closeAccepted(slug, id, itemId, procs.get(p.id)!, p.result.merged.commit); }
    else setItem(slug, id, itemId, { state: 'awaiting_acceptance', activated: true, reason: 'Integrada, activa en el Portal y verificada en ejecución: falta tu aceptación.' }, 'activa y verificada en ejecución; pendiente de tu aceptación.', 'activation');
  }
  batchesRepo(slug).update(id, x => { if (x.activation?.state === 'requested') { x.activation.state = 'done'; x.events.push({ at: now(), kind: 'activation', message: 'Activación completada y comprobada.' }); } });
}

function processesOf(slug: string, b: Batch) {
  const procs = processesRepo(slug);
  return b.items.flatMap(i => i.processIds).map(pid => procs.get(pid)).filter(Boolean) as Process[];
}
export function budgetOf(slug: string, b: Batch) {
  // Solo reservan las historias en marcha cuyo equipo puede gastar API (`usesApi`; las anteriores al campo, sí).
  const api = new Map(b.items.flatMap(i => i.processIds.map(pid => [pid, i.usesApi !== false] as const)));
  return batchBudget(b.auth, processesOf(slug, b).map(p => ({ spentUsd: p.spentUsd, unconfirmedUsd: p.unconfirmedUsd ?? 0, budgetUsd: p.budgetUsd ?? 0, running: p.status === 'running', api: api.get(p.id) ?? true })));
}
/** Llamadas a la suscripción de Claude Code hechas por las historias del lote (telemetría de llamadas). */
export function subscriptionCalls(slug: string, b: Batch): number {
  // Mismo registro que la comprobación de cada llamada: ejecuciones reales de la CLI (también fallidas o interrumpidas).
  return claudeCodeRunsRepo(slug).countForProcesses(b.items.flatMap(i => i.processIds));
}

function startNext(slug: string, id: string) {
  for (;;) {
    const b = batchesRepo(slug).get(id)!; if (b.status !== 'running') return;
    // Reconstruyendo el Portal para reiniciarlo: no se empieza nada que el reinicio interrumpiría (se sigue al volver).
    if (updateRunning()) return;
    // Una puesta al día (sandbox o IA) ocupa un hueco como una historia en marcha.
    const running = b.items.filter(i => i.state === 'running' || i.state === 'revalidating');
    if (running.length >= b.auth.concurrency) return;
    // Solo espera la historia que tiene otra operación o proceso propio en marcha fuera del lote; las demás empiezan.
    let next: BatchItem | undefined;
    for (const q of b.items.filter(i => i.state === 'queued').sort((x, y) => x.order - y.order)) {
      const c = workConflict(slug, { id: '', backlogItemId: q.itemId, assignmentId: null });
      if (!c) { next = q; break; }
      const reason = `Espera: ${c}`; if (q.reason !== reason) setItem(slug, id, q.itemId, { reason });
    }
    if (!next) return;
    if (slug === INTERNAL_WORKSPACE.slug && b.auth.git.activate && b.items.some(i => i.state === 'integrating' && i.mergedCommit && !i.activated && (!onAcceptance(b) || !!i.acceptance))) return;
    let prep: Prepared;
    try { prep = prepareItem(slug, b, next); } catch (e: any) { notStartable(slug, id, next, `No se pudo preparar la historia: ${e?.message ?? e}`); continue; }
    // Los USD solo limitan a una historia cuyo equipo puede gastar API; una solo con la suscripción no los reserva ni los necesita.
    const budget = budgetOf(slug, b);
    if (prep.api && !budget.canStart) {
      if (!running.length) setStatus(slug, id, 'paused', `El presupuesto restante del lote (${budget.remaining.toFixed(2)} USD de ${b.auth.totalBudgetUsd}) no cubre el tope de otra historia (${b.auth.perStoryBudgetUsd} USD). Lo hecho se conserva; amplía el presupuesto para seguir.`, 'budget');
      return;
    }
    const cc = subscriptionCalls(slug, b);
    if (cc >= b.auth.maxSubscriptionCalls && b.auth.backends.includes('claude_code')) {
      if (!running.length) setStatus(slug, id, 'paused', `Se alcanzó el tope de llamadas a la suscripción de Claude autorizado en el lote (${cc} de ${b.auth.maxSubscriptionCalls}). No se asume que la suscripción sea ilimitada: amplíalo para seguir.`, 'budget');
      return;
    }
    startItem(slug, id, next.itemId, prep);
  }
}

/** No empieza (no se pudo preparar): espera tu decisión; reanudar o reintentar la vuelve a comprobar. */
function notStartable(slug: string, id: string, it: BatchItem, reason: string, pid?: string) {
  if (pid) processesRepo(slug).finish(pid, 'cancelled', reason);
  setItem(slug, id, it.itemId, { state: 'needs_owner', failureClass: 'owner_decision', notStarted: true, resumeProcessId: null, reason, processId: pid ?? it.processId, processIds: pid ? [...it.processIds, pid] : it.processIds }, `no empieza: ${reason}`);
}

type Prepared = { resume: Process | null; reuse: Process | null; members: { agentId: string; role?: string | null }[]; gauntlet: GauntletConfig; team: BatchAgentCheck[]; api: boolean };
/**
 * Con qué equipo empezaría (o se retomaría) una historia del lote, sin crear nada ni llamar a la IA: sus agentes, su
 * Gauntlet, la comprobación de orígenes (la MISMA que la vista previa) y si puede gastar USD de la API.
 */
function prepareItem(slug: string, b: Batch, it: BatchItem): Prepared {
  const procs = processesRepo(slug);
  const resume = it.resumeProcessId ? procs.get(it.resumeProcessId) ?? null : null;
  const adopted = !resume && it.nextProcessId ? procs.get(it.nextProcessId) : undefined;
  const reuse = adopted && adopted.status === 'pending_authorization' ? adopted : null;
  let members: { agentId: string; role?: string | null }[]; let gauntlet: GauntletConfig = b.auth.gauntlet;
  if (resume) {
    // Se retoma el proceso en pausa: su equipo autorizado (pasos no omitidos) y su Gauntlet ya resuelto.
    members = resume.steps.filter(s => s.status !== 'skipped').map(s => ({ agentId: s.agentId, role: s.role }));
    gauntlet = resume.result?.pipeline?.config.gauntlet ?? gauntlet;
  } else {
    members = reuse ? reuse.steps.filter(s => s.status === 'pending').map(s => ({ agentId: s.agentId, role: s.role })) : estimateStory(slug, b.projectId, it.itemId, {}).steps.map(s => ({ agentId: s.agentId, role: s.role }));
    gauntlet = resolveGauntletFor(slug, { id: reuse?.id ?? '', projectId: b.projectId, backlogItemId: it.itemId, assignmentId: null }, b.auth.gauntlet);
    const evaluator = gauntlet.mode !== 'off' ? projectEvaluator(slug, b.projectId) : null;
    if (evaluator) members.push({ agentId: evaluator.id, role: 'evaluator' });
  }
  const team = checkTeam(slug, b.projectId, members, b.auth);
  return { resume, reuse, members, gauntlet, team, api: needsApi(team, batchFallback(b.auth, getClaudeCodeSettings().fallback)) };
}

/** Crea (o adopta la iteración preparada, o retoma la pausa), autoriza con los límites del lote y ejecuta la historia con el pipeline. */
function startItem(slug: string, id: string, itemId: string, prep: Prepared) {
  const b = batchesRepo(slug).get(id)!; const it = b.items.find(i => i.itemId === itemId)!;
  const procs = processesRepo(slug);
  const needsOwner = (reason: string, pid?: string) => notStartable(slug, id, it, reason, pid);
  const { reuse, gauntlet } = prep;
  // La MISMA comprobación que la vista previa, ANTES de crear nada: cada agente con un origen autorizado en el lote y
  // listo para ejecutar (nunca se cambia a otro origen facturable). Si algo falla (el conector, el proyecto o un origen
  // cambiaron durante el lote), se pausa TODO el lote una vez, con el motivo y dónde corregirlo; «Reanudar» lo comprueba
  // otra vez. No se crea ningún proceso ni se llama a la IA.
  const bad = prep.team.filter(t => !t.ready);
  if (bad.length) {
    const why = unique(bad.map(t => t.problem!)).join(' ');
    setItem(slug, id, itemId, { reason: `No ha empezado: ${why}` });
    setStatus(slug, id, 'paused', `No se empieza nada más: ${why} Corrígelo y pulsa «Reanudar»; no se ha creado ningún proceso ni se ha llamado a la IA.`, 'pause', bad.find(t => t.fix)?.fix ?? null);
    return;
  }
  if (prep.resume) {
    // Retomar la pausa (autorizado con «Reanudar»), en su turno y sin repetir lo hecho. Si ya no está en pausa (la
    // continuaste desde el proceso), el lote la sigue o decides tú. Tras una pausa por USD se concede otra vez el tope por historia.
    const p = prep.resume; const pl = p.result!.pipeline!;
    if (p.status === 'running') return setItem(slug, id, itemId, { state: 'running', resumeProcessId: null, reason: null, failureClass: null }, 'la retomaste desde el proceso; el lote la sigue.');
    const qaRetry = qaRetryable(it, p);
    // Puesta al día de una apilada cuya dependencia cambió: QA revisa el commit nuevo aunque git no viera conflictos.
    const forceQa = !!it.revalidation?.forceQa && !!p.result?.applied;
    const allowed = resumableInBatch(slug, p) === 'continue' || candidateNeedsQa(p) || qaRetry || (!!it.revalidation && (pl.pauseKind === 'integration' || pl.state === 'verified'));
    if (!allowed) return setItem(slug, id, itemId, { state: 'needs_owner', resumeProcessId: null, reason: 'Ya no está en una pausa que el lote pueda retomar: decide desde su proceso.' }, 'ya no está en una pausa reanudable: decides tú.');
    // QA vuelve a evaluar el MISMO commit una vez (con la evidencia actual): se marca para que la etapa de QA se repita.
    if (qaRetry) setItem(slug, id, itemId, { qaRetries: (it.qaRetries ?? 0) + 1 }, 'QA vuelve a revisar el mismo commit con la evidencia actual (una vez).');
    // Solo una historia que puede gastar API reserva USD al seguir (como al empezar): la de solo suscripción no los necesita,
    // aunque la versión anterior la pausara por «presupuesto». La que sí: lo no gastado de este proceso (pausado, no cuenta
    // como reservado) y, tras una pausa por USD, otro tope por historia, solo si cabe en lo que queda del lote.
    const grant = pl.pauseKind === 'budget' && prep.api ? b.auth.perStoryBudgetUsd : 0;
    const unspent = Math.max(0, (p.budgetUsd ?? 0) - p.spentUsd - (p.unconfirmedUsd ?? 0)); const left = budgetOf(slug, b).remaining;
    if (prep.api && left + 1e-9 < unspent + grant) return setItem(slug, id, itemId, { state: 'needs_owner', resumeProcessId: null, failureClass: 'budget', reason: `Para seguir haría falta ${(unspent + grant).toFixed(2)} USD de API y al lote le quedan ${left.toFixed(2)}: reanuda concediendo más presupuesto al lote (no se supera el total autorizado).` }, 'sin USD de API suficientes en el lote para seguir: decides tú.');
    procs.resume(p.id, Math.max(p.budgetUsd ?? 0, p.spentUsd) + grant);
    procs.setResult(p.id, { ...p.result!, pipeline: { ...pl, failures: [], startedAt: now(), ...(qaRetry || forceQa ? { state: 'paused' as const, qaRequestedFor: p.result!.applied!.commit } : {}) } });
    setItem(slug, id, itemId, { state: 'running', resumeProcessId: null, usesApi: prep.api, reason: null, failureClass: null, notStarted: false, startedAt: now(), finishedAt: null }, `se retoma donde quedó (proceso ${p.id.slice(0, 8)}), sin repetir lo hecho.`, 'recovery');
    const run = batchDeps.resumeStory(slug, p.id, logger, () => isCancelled(p.id)).finally(() => { clearCancel(p.id); void scheduleTick(slug, id); });
    trackJob(p.id, run).catch(e => logger({ err: e?.message, processId: p.id }, 'lote: fallo inesperado al retomar'));
    return;
  }
  // Volver a empezar una iteración (p. ej. tras una pausa antes de implementar) conserva su contexto: la nota del propietario.
  const prevP = !reuse && it.processId ? procs.get(it.processId) : undefined; const prevContext = prevP?.result?.iterationContext ?? null;
  let p: Process;
  try { p = reuse ?? createStoryProcess(slug, b.projectId, itemId, prevContext ? { iterationContext: prevContext } : {}); }
  catch (e: any) { return needsOwner(`No se pudo preparar la historia: ${e?.message ?? e}`); }
  // Solo se empieza un proceso PENDIENTE de autorizar: si ya está en marcha (lo autorizaste tú) o terminó, el lote lo
  // sigue; nunca se le reinicia el pipeline ni se ejecuta dos veces.
  if (p.status !== 'pending_authorization') {
    if (p.status === 'running') return setItem(slug, id, itemId, { state: 'running', processId: p.id, processIds: [...it.processIds.filter(x => x !== p.id), p.id], nextProcessId: null, reason: null, failureClass: null, startedAt: now(), finishedAt: null }, `ya estaba en marcha (proceso ${p.id.slice(0, 8)}, autorizado por ti): el lote la sigue sin ejecutarla otra vez.`);
    return setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'owner_decision', processId: p.id, processIds: [...it.processIds.filter(x => x !== p.id), p.id], nextProcessId: null, reason: 'Su proceso ya no está pendiente de autorizar: decide desde su proceso.' }, 'su proceso ya no está pendiente: decides tú.');
  }
  // Claude Code solo cede a la API si el lote lo autoriza (y el conector lo permite): si no, se pausa como siempre.
  const cfg = normalizePipeline({ autoApply: true, autoVerify: true, commands: b.auth.commands, allowInstall: b.auth.allowInstall, maxCorrections: b.auth.maxCorrections, gauntlet, backends: b.auth.backends, ...(b.auth.apiFallback && b.auth.backends.includes('api') ? {} : { apiFallback: false }) });
  // «Reanudar» tras una pausa ANTES de implementar (p. ej. el tope de llamadas en la revisión del plan): el plan ya pagado
  // pasa a esta ejecución y no se vuelve a pedir; su revisión, si quedó pendiente, sí se hace. Solo si la historia (y el
  // contexto de iteración) siguen siendo los mismos con que se hizo: si la editaste mientras tanto, se planifica de nuevo.
  const story = backlogRepo(slug).get(itemId);
  const sameStory = !!story && !!prevP?.result?.planBasis && prevP.result.planBasis === storyBasis(story, procs.get(p.id)!.result?.iterationContext ?? null);
  const carried = prevP?.result?.plan && sameStory && resumableInBatch(slug, prevP) === 'restart' ? { plan: prevP.result.plan, carriedPlan: true } : {};
  procs.setResult(p.id, { ...procs.get(p.id)!.result!, ...carried, pipeline: newPipeline(cfg) });
  syncEvaluatorStep(slug, p.id, cfg.gauntlet!);
  procs.authorize(p.id, b.auth.perStoryBudgetUsd);
  setItem(slug, id, itemId, { state: 'running', processId: p.id, processIds: [...it.processIds.filter(x => x !== p.id), p.id], nextProcessId: null, usesApi: prep.api, reason: null, failureClass: null, notStarted: false, startedAt: now(), finishedAt: null }, `empieza (proceso ${p.id.slice(0, 8)}, ${prep.api ? `tope ${b.auth.perStoryBudgetUsd} USD de API` : 'solo con la suscripción (sin USD)'}, ${b.auth.maxCorrections} corrección(es), Gauntlet ${b.auth.gauntlet.mode}).`);
  procs.logExecution({ projectId: b.projectId, agentId: '', kind: `batch_story_started:${id}`, status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: now() });
  const stack = it.stack ?? null; const pid = p.id;
  const run = (async () => {
    // Apilada: su worktree nace del commit verificado de la dependencia (comprobado con git en el carril) ANTES de cualquier
    // llamada. Si la dependencia cambió o su rama propia ya existe, no se gasta nada: vuelve a esperar con el motivo.
    if (stack) {
      // Solo se toca la historia si sigue siendo ESTA ejecución (pudo cancelarse o anularse mientras esperaba el carril).
      const mine = () => { const x = batchesRepo(slug).get(id); const y = x?.items.find(i => i.itemId === itemId); return !!x && liveBatch(x) && y?.state === 'running' && y.processId === pid && !y.stack?.invalid; };
      try {
        const full = await prepareStackedBase(slug, pid, stack, it.storyId);
        // Huella de los cambios propios de la dependencia en esta versión: si se integra con la misma, QA no repite por ella.
        const repoPath = projectsRepo(slug).repository(b.projectId)?.path;
        const patchId = repoPath ? await storyPatchId(repoPath, stack.branch).catch(() => null) : null;
        if (mine()) setItem(slug, id, itemId, { stack: { ...stack, commit: full, patchId } });
      } catch (e: any) {
        procs.finish(pid, 'cancelled', `No se preparó sobre ${stack.storyId}: ${e?.message ?? e}`);
        if (mine()) setItem(slug, id, itemId, { state: 'waiting_dependency', stack: null, noStack: String(e?.message ?? e), noStackFor: e?.code === 'branch_exists' ? null : stack.commit, reason: `No se pudo preparar sobre la versión provisional de ${stack.storyId}: ${e?.message ?? e}. Espera a que aceptes e integres ${stack.storyId} (no se llamó a la IA).` }, `no se preparó sobre ${stack.storyId} (${e?.message ?? e}); vuelve a esperar sin gasto.`);
        return;
      }
    }
    return batchDeps.runStory(slug, pid, logger, () => isCancelled(pid));
  })().finally(() => { clearCancel(pid); void scheduleTick(slug, id); });
  trackJob(p.id, run).catch(e => logger({ err: e?.message, processId: p.id }, 'lote: fallo inesperado de la historia'));
}

function maybeComplete(slug: string, id: string) {
  const b = batchesRepo(slug).get(id)!;
  if (batchMoving(b.items)) return;
  if (onAcceptance(b)) {
    // Solo se termina con TODO resuelto: aceptadas (integradas y cerradas), no aceptadas, aplazadas o canceladas. Nunca con
    // trabajo aceptado sin integrar ni decisiones tuyas pendientes; mientras, el resumen dice qué falta.
    const life = batchLifecycle(b.items, 'on_acceptance', b.integrationPlan?.order ?? []);
    if (life.phase === 'done') return setStatus(slug, id, 'completed', `Lote terminado: ${life.headline}`, 'completed');
    if (b.reason !== life.headline) batchesRepo(slug).update(id, x => { x.reason = life.headline; if (life.technicallyComplete && !x.events.some(e => e.kind === 'item' && e.message === life.headline)) x.events.push({ at: now(), kind: 'item', message: life.headline }); });
    return;
  }
  const waiting = b.items.filter(i => i.state === 'needs_owner' || i.state === 'awaiting_integration' || i.state === 'external');
  const deps = b.items.filter(i => i.state === 'waiting_dependency');
  if (waiting.length || deps.length) {
    // Nada avanza solo, pero no está «terminado»: cada historia dice por qué espera. Si alguna puede seguir con «Reanudar»
    // (tope de llamadas, entorno, USD de la API, duración o un reinicio), el lote queda EN PAUSA con ese motivo.
    const list = [...waiting.map(i => `${i.storyId} (${i.state === 'needs_owner' ? WAIT_LABEL[i.failureClass ?? 'owner_decision'] : ITEM_LABEL[i.state]})`), ...deps.map(i => `${i.storyId} (espera a ${i.dependsOn})`)].join(', ');
    const resumable = waiting.filter(i => canResume(slug, i));
    if (resumable.length) return setStatus(slug, id, 'paused', `En pausa: ${resumable.map(i => i.storyId).join(', ')} puede(n) seguir con «Reanudar» (amplía antes el límite que corresponda), donde quedaron y sin repetir lo hecho. Estado: ${list}.`, 'pause');
    const reason = `Nada avanza sin ti; esperan tu decisión: ${list}.`;
    if (b.reason !== reason) batchesRepo(slug).update(id, x => { x.reason = reason; x.events.push({ at: now(), kind: 'item', message: reason }); });
    return;
  }
  const s = batchSummary(b.items);
  setStatus(slug, id, 'completed', `Lote terminado: ${s.awaiting_acceptance} pendiente(s) de tu aceptación, ${s.accepted} aceptada(s), ${s.rejected} no aceptada(s), ${s.failed} fallida(s), ${s.blocked} bloqueada(s), ${s.cancelled} cancelada(s).`, 'completed');
}

// ---------------------------------------------------------------- Control del propietario

const controllable = (b: Batch) => { if (b.status === 'cancelled' || b.status === 'revoked') throw fail(409, `El lote está ${b.status === 'cancelled' ? 'cancelado' : 'revocado'}.`, 'closed'); };
export function getBatch(slug: string, id: string): Batch { const b = batchesRepo(slug).get(id); if (!b) throw fail(404, 'Lote no encontrado.', 'not_found'); return b; }

// ---------------------------------------------------------------- Reconciliación y cierre manual (EN-002, sin IA)

type IntegrationCheck = { ok: boolean; why: string | null; merged: Map<string, { commit: string; active: boolean }> };
/**
 * ¿Están todas las historias del lote integradas en main (y activas, si es el Portal)? Solo lee procesos y git: no
 * escribe nada ni llama a la IA. En un proyecto de empresa basta con «integrado en main» (merge registrado); en el
 * Portal, además, el merge debe estar en su rama y activo en el servidor y la interfaz en marcha.
 */
async function integrationCheck(slug: string, b: Batch): Promise<IntegrationCheck> {
  const procs = processesRepo(slug); const internal = slug === INTERNAL_WORKSPACE.slug;
  const merged: IntegrationCheck['merged'] = new Map();
  if (!b.items.length) return { ok: false, why: 'El lote no tiene historias.', merged };
  for (const it of b.items) {
    if (it.state === 'failed' || it.state === 'blocked' || it.state === 'cancelled' || it.state === 'rejected') return { ok: false, why: `${it.storyId} está ${ITEM_LABEL[it.state]}.`, merged };
    const ps = it.processIds.map(pid => procs.get(pid)).filter(Boolean) as Process[];
    if (ps.some(p => isActiveJob(p.id))) return { ok: false, why: `${it.storyId} sigue en ejecución.`, merged };
    const m = [...ps].reverse().find(p => p.result?.merged?.commit)?.result?.merged ?? null;
    if (!m?.commit) return { ok: false, why: `${it.storyId} no está integrada en main.`, merged };
    let active = !!it.activated;
    if (internal) {
      if (!(await isAncestor(m.commit, m.into || 'main'))) return { ok: false, why: `El merge de ${it.storyId} (${m.commit}) no está en ${m.into || 'main'}.`, merged };
      const st = await batchDeps.activation(m.commit, m.mergedAt);
      if (!st.active) return { ok: false, why: `${it.storyId} está integrada pero no activa: ${st.reason}`, merged };
      active = true;
    }
    merged.set(it.itemId, { commit: m.commit, active });
  }
  return { ok: true, why: null, merged };
}

/** Cada historia integrada que aún no tiene estado final queda pendiente de tu aceptación (las aceptadas se conservan). */
function applyIntegrated(slug: string, id: string, merged: IntegrationCheck['merged']) {
  const t = now();
  batchesRepo(slug).update(id, x => {
    for (const it of x.items) {
      const m = merged.get(it.itemId); if (!m) continue;
      it.mergedCommit = m.commit; it.activated = m.active || !!it.activated;
      if (it.state === 'accepted') continue;
      it.state = 'awaiting_acceptance'; it.reason = null; it.failureClass = null;
      it.resumeProcessId = null; it.nextProcessId = null; it.finishedAt = it.finishedAt ?? t;
    }
  });
}

/** Asegura fecha de fin y el evento (sin duplicarlo si setStatus ya lo registró), y aplica cambios extra. */
function finishWithEvent(slug: string, id: string, kind: 'completed' | 'close', message: string, extra?: (x: Batch) => void) {
  batchesRepo(slug).update(id, x => {
    const t = now();
    x.finishedAt = x.finishedAt ?? t; x.reasonFix = null;
    const last = x.events[x.events.length - 1];
    if (!last || last.kind !== kind || last.message !== message) x.events.push({ at: t, kind, message });
    extra?.(x);
  });
}

/**
 * Reconciliación sin IA: un lote en pausa o en marcha cuyas historias están todas integradas en main (y activas, si es
 * el Portal) pasa a «completado». Si alguna no lo está, el lote queda como estaba y no se escribe nada.
 */
export async function reconcileBatch(slug: string, id: string): Promise<Batch> {
  const b = getBatch(slug, id);
  if (b.status !== 'paused' && b.status !== 'running') return b;
  if (b.activation?.state === 'requested') return b;
  const c = await integrationCheck(slug, b);
  if (!c.ok) return b;
  const cur = getBatch(slug, id);
  if (cur.status !== 'paused' && cur.status !== 'running') return cur;
  const internal = slug === INTERNAL_WORKSPACE.slug;
  const message = internal
    ? 'Lote completado: todas sus historias están integradas en main y activas en el Portal. Falta tu aceptación de cada una (no se ha usado IA).'
    : 'Lote completado: todas sus historias están integradas en main. Falta tu aceptación de cada una (no se ha usado IA).';
  applyIntegrated(slug, id, c.merged);
  setStatus(slug, id, 'completed', message, 'completed');
  finishWithEvent(slug, id, 'completed', message);
  logger({ batchId: id }, 'lote reconciliado: completado sin IA');
  return getBatch(slug, id);
}

/**
 * Cierre manual de un lote EN PAUSA, con un motivo obligatorio. Queda «completado» si todo está integrado (y activo,
 * si es el Portal); si no, «cancelado», y las historias sin estado final se cancelan dentro del lote (sus procesos
 * siguen disponibles). El motivo y la fecha quedan en sus eventos y en `closed`. No usa la IA ni registra coste.
 */
export async function closeBatch(slug: string, id: string, reason: string): Promise<Batch> {
  const r = String(reason ?? '').trim();
  if (r.length < 3) throw fail(400, 'Indica el motivo del cierre (al menos 3 caracteres).', 'reason_required');
  if (r.length > 500) throw fail(400, 'El motivo del cierre admite hasta 500 caracteres.', 'reason_too_long');
  const b = getBatch(slug, id);
  if (b.status !== 'paused') throw fail(409, `Solo se puede cerrar a mano un lote en pausa (este está «${b.status}»).`, 'invalid_status');
  const c = await integrationCheck(slug, b);
  const cur = getBatch(slug, id);
  if (cur.status !== 'paused') throw fail(409, `Solo se puede cerrar a mano un lote en pausa (este está «${cur.status}»).`, 'invalid_status');
  const outcome: 'completed' | 'cancelled' = c.ok ? 'completed' : 'cancelled';
  if (c.ok) applyIntegrated(slug, id, c.merged);
  else {
    const t = now();
    batchesRepo(slug).update(id, x => {
      for (const it of x.items) {
        if (it.state === 'accepted' || it.state === 'awaiting_acceptance' || it.state === 'rejected' || it.state === 'failed' || it.state === 'blocked' || it.state === 'cancelled' || it.state === 'postponed') continue;
        if (it.state === 'ready' || it.state === 'prepared' || it.state === 'revalidating') { it.state = 'awaiting_integration'; it.revalidation = null; it.reason = 'Lote cerrado: lo terminado se conserva en su rama; intégrala desde su proceso si la quieres.'; continue; }
        it.state = 'cancelled'; it.reason = 'Lote cerrado manualmente por el propietario.';
        it.resumeProcessId = null; it.nextProcessId = null; it.finishedAt = it.finishedAt ?? t;
      }
    });
  }
  const message = `Cerrado manualmente por el propietario: ${r}`;
  setStatus(slug, id, outcome, message, 'close');
  finishWithEvent(slug, id, 'close', message, x => { x.closed = { at: now(), reason: r, outcome }; });
  logger({ batchId: id, outcome }, 'lote cerrado manualmente (sin IA)');
  return getBatch(slug, id);
}

export function pauseBatch(slug: string, id: string): Batch {
  const b = getBatch(slug, id); controllable(b);
  if (b.status !== 'running') throw fail(409, 'El lote no está en marcha.', 'not_running');
  setStatus(slug, id, 'paused', 'Pausado por el propietario: no se empieza ni se integra nada más; lo que está en marcha termina su historia.', 'pause');
  return getBatch(slug, id);
}
/** Reanudar (autorizado): con presupuesto o tope de suscripción ampliados si se indican; la duración cuenta desde ahora. */
export function resumeBatch(slug: string, id: string, extra: { addBudgetUsd?: number; addSubscriptionCalls?: number; expectPolicy?: string | null } = {}): Batch {
  const b = getBatch(slug, id); controllable(b);
  // Reanudas con la política que tenías delante: si cambió (otra pestaña), no se reanuda con otra distinta.
  if (extra.expectPolicy && extra.expectPolicy !== integrationPolicy(b.auth)) throw fail(409, `La política de integración del lote cambió (ahora: ${POLICY_LABEL[integrationPolicy(b.auth)]}): revisa qué hará al reanudar y vuelve a intentarlo.`, 'policy_changed');
  // «En marcha» de verdad solo si algo avanza: un lote donde todo espera tu decisión también se reanuda.
  if (b.status === 'running' && batchMoving(b.items)) throw fail(409, 'El lote ya está en marcha.', 'running');
  batchesRepo(slug).update(id, x => {
    // Vuelven a la cola (y se comprueban otra vez) las que no llegaron a trabajar (permisos u orígenes, o un motivo de todo
    // el lote sin trabajo que conservar) y, en su turno y sin repetir lo hecho, las que quedaron en una pausa reanudable
    // (tope de llamadas, entorno, USD de la API, duración, reinicio sin cobro incierto). Solo con esta acción del propietario.
    for (const i of x.items) {
      const mode = requeueMode(slug, i); if (!mode) continue;
      // Una apilada con trabajo sigue sobre su versión provisional (no vuelve a esperar ni se le cambia la base).
      i.state = i.dependsInBatch && !(i.stack && mode === 'continue') ? 'waiting_dependency' : 'queued'; i.failureClass = null; i.notStarted = false;
      i.resumeProcessId = mode === 'continue' ? i.processId : null;
      if (mode === 'restart') { i.stack = null; i.noStack = null; i.noStackFor = null; }
      i.reason = mode === 'continue' ? 'Se retoma donde quedó al reanudar (no se repite lo hecho).' : 'Vuelve a la cola al reanudar (no tenía trabajo que conservar).';
    }
    x.auth.totalBudgetUsd = Math.min(BATCH_LIMITS.maxTotalUsd, x.auth.totalBudgetUsd + Math.max(0, extra.addBudgetUsd ?? 0));
    x.auth.maxSubscriptionCalls = Math.min(BATCH_LIMITS.maxSubscriptionCalls, x.auth.maxSubscriptionCalls + Math.max(0, Math.floor(extra.addSubscriptionCalls ?? 0)));
    // La duración autorizada se concede otra vez desde la reanudación (nunca acumula tiempo sin límite).
    x.createdAt = now(); x.finishedAt = null;
    // Solo con integración automática: al aceptar, nada se integra sin tu aceptación (lo terminado queda «lista»).
    x.items.filter(i => i.state === 'awaiting_integration' && x.auth.git.merge).forEach(i => { if (onAcceptance(x)) { i.state = 'ready'; i.freshness = null; i.reason = 'Terminada técnicamente: lista para tu revisión (sin integrar).'; } else { i.state = 'integrating'; i.reason = 'Se integrará al reanudar el lote.'; } });
  });
  setStatus(slug, id, 'running', null, 'resume');
  void scheduleTick(slug, id);
  return getBatch(slug, id);
}
function stopRunning(slug: string, b: Batch) {
  for (const it of b.items.filter(i => (i.state === 'running' || i.state === 'revalidating') && i.processId)) { const pid = currentProcessId(it)!; cancelProcess(pid); abortProcessCalls(pid); }
}
export function cancelBatch(slug: string, id: string): Batch {
  const b = getBatch(slug, id); controllable(b);
  stopRunning(slug, b);
  batchesRepo(slug).update(id, x => x.items.forEach(i => {
    if (['queued', 'waiting_dependency'].includes(i.state)) { i.state = 'cancelled'; i.reason = 'Cancelada con el lote antes de empezar.'; }
    if (i.state === 'needs_owner') { i.state = 'cancelled'; i.reason = `Cancelada con el lote mientras esperaba tu decisión (${i.reason ?? 'sin motivo'}). Lo hecho en su proceso se conserva.`; }
    if (i.state === 'external') { i.state = 'cancelled'; i.reason = 'Cancelada con el lote; su iteración fuera del lote sigue como la autorizaste.'; }
    // Integración al aceptar: lo terminado y no integrado se conserva en su rama; integrarlo vuelve a ser decisión tuya.
    if (i.state === 'ready' || i.state === 'prepared' || i.state === 'revalidating' || (i.state === 'integrating' && !i.mergedCommit)) { i.state = 'awaiting_integration'; i.revalidation = null; i.reason = 'Lote cancelado: lo terminado se conserva en su rama; intégrala desde su proceso si la quieres.'; }
  }));
  setStatus(slug, id, 'cancelled', 'Cancelado por el propietario: lo que estaba en marcha se detiene entre pasos; lo terminado se conserva y puedes aceptarlo.', 'cancel');
  return getBatch(slug, id);
}
/** Revocar la autorización: como cancelar, y además nada técnico terminado se integra ni se activa solo. */
export function revokeBatch(slug: string, id: string, reason: string | null): Batch {
  const b = getBatch(slug, id); controllable(b);
  stopRunning(slug, b);
  batchesRepo(slug).update(id, x => x.items.forEach(i => {
    if (['queued', 'waiting_dependency'].includes(i.state)) { i.state = 'cancelled'; i.reason = 'Autorización revocada antes de empezar.'; }
    if (i.state === 'integrating' && !i.mergedCommit) { i.state = 'awaiting_integration'; i.reason = 'Autorización revocada: integrar vuelve a ser decisión tuya.'; }
    if (i.state === 'needs_owner') { i.state = 'cancelled'; i.reason = `Autorización revocada mientras esperaba tu decisión (${i.reason ?? 'sin motivo'}). Lo hecho en su proceso se conserva.`; }
    if (i.state === 'external') { i.state = 'cancelled'; i.reason = 'Autorización del lote revocada; su iteración fuera del lote sigue como la autorizaste.'; }
    if (i.state === 'ready' || i.state === 'prepared' || i.state === 'revalidating') { i.state = 'awaiting_integration'; i.revalidation = null; i.reason = 'Autorización revocada: lo terminado se conserva en su rama; integrar vuelve a ser decisión tuya.'; }
  }));
  setStatus(slug, id, 'revoked', `Autorización revocada por el propietario${reason ? `: ${reason}` : ''}. No se empieza, integra, activa ni publica nada más.`, 'revoke');
  processesRepo(slug).logExecution({ projectId: b.projectId, agentId: '', kind: `batch_revoked:${id}`, status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: now() });
  return getBatch(slug, id);
}
/** Cancelar una historia del lote. Con `tick: false` (lote en pausa, desde la revisión del proyecto) no se mueve nada más del lote. */
export function cancelItem(slug: string, id: string, itemId: string, opts: { tick?: boolean } = {}): Batch {
  const b = getBatch(slug, id); const it = b.items.find(i => i.itemId === itemId); if (!it) throw fail(404, 'La historia no está en el lote.', 'not_found');
  if (!['queued', 'waiting_dependency', 'running', 'needs_owner', 'blocked'].includes(it.state)) throw fail(409, `No se puede cancelar una historia ${ITEM_LABEL[it.state]}.`, 'invalid_state');
  if (it.state === 'running' && it.processId) { cancelProcess(it.processId); abortProcessCalls(it.processId); }
  setItem(slug, id, itemId, { state: 'cancelled', reason: 'Cancelada por el propietario.', finishedAt: now() }, 'cancelada por ti.');
  if (opts.tick !== false) void scheduleTick(slug, id);
  return getBatch(slug, id);
}

/** Sin trabajo que conservar: su proceso no existe, se canceló al empezar o falló. Reintentar no repite nada hecho. */
export function retryable(it: Pick<BatchItem, 'state'>, processStatus: string | null | undefined): boolean {
  return (it.state === 'needs_owner' || it.state === 'failed') && (!processStatus || processStatus === 'cancelled' || processStatus === 'failed');
}

/**
 * Una llamada POR LA API interrumpida por un reinicio pudo facturarse sin confirmación (queda como «sin confirmar» en su
 * paso): no se reenvía sola. Una de la suscripción no tiene cobro incierto (su ejecución ya cuenta en el tope de llamadas).
 */
export const uncertainCharge = (p: Process, since = '') => p.steps.some(s => s.status === 'failed' && /^Interrumpido/.test(s.error ?? '') && (s.finishedAt ?? '') >= since && (s.unconfirmedUsd ?? 0) > 0);
/** Pausas que «Reanudar» (autorizado, con el límite ampliado) retoma donde quedaron: no dependen de una decisión sobre el código. */
const RESUMABLE: PipelinePauseKind[] = ['call_cap', 'subscription_limit', 'environment', 'budget', 'duration', 'interrupted', 'owner_changes'];
/** ¿«Reanudar» puede seguir con este proceso en pausa? «continue» lo retoma; «restart» no tiene nada que conservar (se vuelve a empezar). */
export function resumableInBatch(slug: string, p: Process | undefined | null): 'continue' | 'restart' | null {
  const r = p?.result; const pl = r?.pipeline;
  if (!p || !r || !pl || p.status !== 'done' || pl.state !== 'paused' || !pl.pauseKind || !RESUMABLE.includes(pl.pauseKind) || r.merged || r.rejected || pl.ownerRequest) return null;
  if (pl.pauseKind === 'interrupted' && uncertainCharge(p, pl.startedAt)) return null;
  const work = !!r.manifest || !!r.applied || r.changes.some(c => !c.error) || p.steps.some(s => s.role === 'implementer' && !!s.outputMd?.trim());
  return work ? 'continue' : 'restart';
}
/** Qué hace «Reanudar» con una historia que espera tu decisión (null: nada; decides tú desde su proceso). */
function requeueMode(slug: string, it: BatchItem): 'continue' | 'restart' | null {
  if (it.state !== 'needs_owner') return null;
  if (it.stack?.invalid) return null; // su base provisional ya no se integrará: decides tú («Iterar» la rehace)
  if (it.notStarted) return 'restart';
  const p = it.processId ? processesRepo(slug).get(it.processId) : undefined;
  if ((it.failureClass === 'subscription' || it.failureClass === 'environment') && retryable(it, p?.status)) return 'restart';
  if (p && candidateNeedsQa(p)) return 'continue';
  if (p && qaRetryable(it, p)) return 'continue';
  return resumableInBatch(slug, p);
}
/**
 * Candidato de integración verificado en el sandbox que QA aún no revisó (p. ej. conflictos resueltos por el agente):
 * revisarlo es verificación técnica rutinaria dentro del lote (una llamada de QA), no una decisión de producto.
 */
function candidateNeedsQa(p: Process): boolean {
  const pl = p.result?.pipeline; const rev = revisionStatus(p);
  return p.status === 'done' && pl?.state === 'paused' && pl.pauseKind === 'integration' && !p.result?.merged && !!rev?.verifiedHead && !rev.qa.coversHead;
}
/** QA no pudo verificar: el lote la vuelve a pedir UNA vez (con la evidencia actual, p. ej. la equivalencia de estilos). */
function qaRetryable(it: Pick<BatchItem, 'qaRetries'>, p: Process): boolean {
  const pl = p.result?.pipeline;
  return p.status === 'done' && pl?.pauseKind === 'qa' && !p.result?.merged && !p.result?.rejected && (it.qaRetries ?? 0) < 1 && !!p.result?.applied;
}
const canResume = (slug: string, it: BatchItem) => requeueMode(slug, it) !== null;

/** Reintentar UNA historia dentro del lote (mismos límites): vuelve a la cola y se comprueban otra vez su equipo y orígenes. */
export function retryItem(slug: string, id: string, itemId: string): Batch {
  const b = getBatch(slug, id); controllable(b);
  const it = b.items.find(i => i.itemId === itemId); if (!it) throw fail(404, 'La historia no está en el lote.', 'not_found');
  if (it.state === 'external') throw fail(409, `${it.storyId} sigue fuera del lote con la iteración que autorizaste: decide desde su proceso (el lote no la repite).`, 'external');
  const p = it.processId ? processesRepo(slug).get(it.processId) : undefined;
  if (!retryable(it, p?.status)) throw fail(409, p && (it.state === 'needs_owner' || it.state === 'failed') ? 'Su proceso conserva trabajo en pausa: continúalo desde el proceso (no se repite lo hecho).' : `No se puede reintentar una historia ${ITEM_LABEL[it.state]}.`, 'invalid_state');
  // Las que quedaron bloqueadas SOLO porque esta falló (y las suyas, en cadena) vuelven a esperarla: si no, reintentarla
  // dejaría a sus dependientes bloqueadas para siempre (no se pueden reintentar ni iterar estando bloqueadas).
  reopenDependents(slug, id, it.storyId, 'vuelve a ejecutarse (reintentada por ti)');
  setItem(slug, id, itemId, { state: it.dependsInBatch ? 'waiting_dependency' : 'queued', reason: b.status === 'running' ? null : 'En cola: empezará al reanudar el lote.', failureClass: null, notStarted: false, resumeProcessId: null, finishedAt: null, followedProcessId: null, stack: null, noStack: null, noStackFor: null }, `reintentada por ti: vuelvea la cola (se comprueban otra vez su equipo y sus orígenes).`);
  void scheduleTick(slug, id);
  return getBatch(slug, id);
}

// ---------------------------------------------------------------- Aceptación del propietario (distinta de QA)

/** Lo decidiste mirando un commit concreto (p. ej. en la vista previa): si el candidato ya es otro, no se aplica a ciegas. */
function assertRevisions(slug: string, items: BatchItem[], revisions: Record<string, string>) {
  for (const it of items) {
    const want = revisions[it.itemId]; if (!want) continue;
    const head = processesRepo(slug).get(currentProcessId(it) ?? '')?.result?.applied?.commit ?? null;
    if (!same7(want, head)) throw fail(409, `${it.storyId} cambió desde que la revisaste (revisaste ${want.slice(0, 7)}; ahora es ${head?.slice(0, 7) ?? 'otra versión'}): vuelve a revisarla (y su vista previa) antes de decidir.`, 'revision_changed');
  }
}

export async function acceptItems(slug: string, id: string, itemIds: string[], note: string | null, checks: Record<string, boolean[]> = {}, revisions: Record<string, string> = {}): Promise<Batch> {
  const b = getBatch(slug, id); const procs = processesRepo(slug);
  const items = itemIds.map(x => b.items.find(i => i.itemId === x));
  if (items.some(i => i?.state === 'prepared')) throw fail(409, `${items.filter(i => i?.state === 'prepared').map(i => `${i!.storyId} está preparada sobre la versión provisional de ${i!.stack?.storyId ?? i!.dependsOn}`).join(' · ')}: acepta e integra antes su dependencia; después se pone al día y la revisas.`, 'dependency_first');
  assertRevisions(slug, items.filter(Boolean) as BatchItem[], revisions);
  if (onAcceptance(b) && items.some(i => i?.state === 'ready')) return acceptReady(slug, id, itemIds, note, checks, revisions);
  const wrong = items.filter(i => !i || i.state !== 'awaiting_acceptance');
  if (wrong.length) throw fail(409, `Solo se aceptan historias terminadas técnicamente: ${wrong.map(i => i ? `${i.storyId} está ${ITEM_LABEL[i.state]}` : 'una no está en el lote').join(' · ')}.`, 'not_ready');
  for (const it of items as BatchItem[]) {
    const p = procs.get(currentProcessId(it)!)!;
    if (slug === INTERNAL_WORKSPACE.slug && !it.activated && p.result?.merged) {
      const st = await batchDeps.activation(p.result.merged.commit, p.result.merged.mergedAt);
      if (!st.active) throw fail(409, `${it.storyId} está integrada pero no activa en el Portal en marcha: ${st.reason}`, 'not_activated');
    }
    const steps = p.result?.manualTest?.steps ?? [];
    const c = checks[it.itemId];
    if (c && steps.length && (c.length !== steps.length || c.some(x => !x))) throw fail(409, `${it.storyId}: marca todos los pasos de la prueba o no la aceptes (usa «No aceptar» con los pasos que fallaron).`, 'checks_incomplete');
  }
  for (const it of items as BatchItem[]) {
    const p = procs.get(currentProcessId(it)!)!; const at = now();
    const mt = p.result?.manualTest;
    procs.setResult(p.id, { ...p.result!, acceptance: { at, by: 'owner', batchId: id, note }, ...(mt && checks[it.itemId] ? { manualTest: { ...mt, checks: checks[it.itemId] } } : {}) });
    backlogRepo(slug).setStatus(it.itemId, 'done', p.id);
    procs.logExecution({ projectId: b.projectId, agentId: '', kind: `owner_acceptance:${it.storyId}`, status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: at });
    // Ya estaba en main (integrada antes de tu revisión): aceptarla es RECONOCERLA; no autoriza ninguna integración nueva.
    const commit = it.mergedCommit ?? p.result?.merged?.commit ?? null;
    setItem(slug, id, it.itemId, { state: 'accepted', acceptance: { at, note, checks: checks[it.itemId] ?? null, kind: 'acknowledged', commit, revision: revisions[it.itemId] ?? null }, rejection: null }, `reconocida y aceptada por ti: ya estaba integrada en main (${commit ?? 'sin commit registrado'}); no autoriza ninguna integración nueva${note ? `. Nota: ${note.slice(0, 200)}` : ''}.`, 'acceptance');
  }
  return getBatch(slug, id);
}

/**
 * Integración al aceptar: aceptas una historia LISTA (sin integrar) y el lote la integra en su turno, en el orden de
 * integración y de una en una. Se guarda el commit que revisaste y la huella de sus cambios: si al ponerla al día cambia
 * su código, la aceptación se anula y vuelves a revisarla. Su dependencia del lote debe estar integrada antes.
 */
async function acceptReady(slug: string, id: string, itemIds: string[], note: string | null, checks: Record<string, boolean[]>, revisions: Record<string, string> = {}): Promise<Batch> {
  const b = getBatch(slug, id); controllable(b);
  if (b.status === 'completed') throw fail(409, 'El lote ya terminó.', 'closed');
  const procs = processesRepo(slug);
  const items = itemIds.map(x => b.items.find(i => i.itemId === x));
  const wrong = items.filter(i => !i || i.state !== 'ready');
  if (wrong.length) throw fail(409, `Solo se aceptan historias listas para tu revisión: ${wrong.map(i => i ? `${i.storyId} está ${ITEM_LABEL[i.state]}` : 'una no está en el lote').join(' · ')}.`, 'not_ready');
  const integratedOrAccepted = new Set([...b.items.filter(i => i.mergedCommit || i.state === 'accepted').map(i => i.storyId), ...items.map(i => i!.storyId)]);
  const facts = new Map<string, { head: string | null; patchId: string | null }>();
  for (const it of items as BatchItem[]) {
    if (it.dependsInBatch && it.dependsOn && !integratedOrAccepted.has(it.dependsOn)) throw fail(409, `${it.storyId} depende de ${it.dependsOn}: acéptala antes (su código debe entrar en main primero).`, 'dependency_first');
    const p = procs.get(currentProcessId(it)!);
    if (!p?.result?.applied?.branch) throw fail(409, `${it.storyId} no tiene una rama aplicada que integrar.`, 'not_applied');
    const steps = p.result.manualTest?.steps ?? []; const c = checks[it.itemId];
    if (c && steps.length && (c.length !== steps.length || c.some(x => !x))) throw fail(409, `${it.storyId}: marca todos los pasos de la prueba o no la aceptes (usa «No aceptar» con los pasos que fallaron).`, 'checks_incomplete');
    const repo = projectsRepo(slug).repository(p.projectId);
    const patchId = repo ? await storyPatchId(repo.path, p.result.applied.branch) : null;
    if (!patchId) throw fail(409, `${it.storyId}: no se pudo calcular la huella de sus cambios con git; no se acepta a ciegas.`, 'no_patch_id');
    facts.set(it.itemId, { head: p.result.applied.commit ?? null, patchId });
  }
  const at = now();
  // Mientras se calculaban las huellas pudo empezar a ponerse al día (u otra cosa): solo se acepta lo que SIGUE lista.
  const moved = (items as BatchItem[]).filter(it => getBatch(slug, id).items.find(i => i.itemId === it.itemId)?.state !== 'ready');
  if (moved.length) throw fail(409, `${moved.map(i => i.storyId).join(', ')} cambió de estado mientras la aceptabas (p. ej. empezó a ponerse al día): vuelve a intentarlo cuando esté lista.`, 'state_changed');
  assertRevisions(slug, items as BatchItem[], revisions);
  for (const it of items as BatchItem[]) {
    const f = facts.get(it.itemId)!;
    const stale = it.freshness && it.freshness.status !== 'current';
    setItem(slug, id, it.itemId, { state: 'integrating', acceptance: { at, note, checks: checks[it.itemId] ?? null, commit: f.head, patchId: f.patchId, kind: 'integrate', revision: revisions[it.itemId] ?? null }, rejection: null, reason: `Aceptada por ti${stale ? '; antes de integrarla se pone al día con main (si su código cambia, vuelves a revisarla)' : ''}: se integra en main en su turno, de una en una.` }, `aceptada por ti (commit ${f.head})${note ? `: ${note.slice(0, 200)}` : ''}; se integra en su turno.`, 'acceptance');
  }
  void scheduleTick(slug, id);
  return getBatch(slug, id);
}

/** Las que quedaron bloqueadas SOLO por esta historia (y las suyas, en cadena) vuelven a esperarla. */
function reopenDependents(slug: string, id: string, storyId: string, why: string, seen = new Set<string>()) {
  if (seen.has(storyId)) return; seen.add(storyId);
  for (const d of getBatch(slug, id).items.filter(i => i.state === 'blocked' && i.failureClass === 'dependency' && i.dependsOn === storyId)) {
    const work = !!d.stack && !d.stack.invalid && !!processesRepo(slug).get(d.processId ?? '')?.result?.applied;
    if (work) { setItem(slug, id, d.itemId, { state: 'prepared', failureClass: null, reason: `Preparada sobre ${storyId}, que ${why}: su trabajo se conserva.`, finishedAt: null }, `vuelve a «preparada» sobre ${storyId} (${why}); su trabajo se conserva.`); }
    else setItem(slug, id, d.itemId, { state: 'waiting_dependency', failureClass: null, stack: null, reason: `Espera a ${storyId}, que ${why}.`, finishedAt: null }, `vuelve a esperar a ${storyId} (${why}).`);
    reopenDependents(slug, id, d.storyId, why, seen);
  }
}

/** Aplazar: no se ejecuta ni se integra en este lote (decisión tomada, con nota); se puede recuperar. */
export function postponeItem(slug: string, id: string, itemId: string, note: string | null): Batch {
  const b = getBatch(slug, id); controllable(b);
  const it = b.items.find(i => i.itemId === itemId); if (!it) throw fail(404, 'La historia no está en el lote.', 'not_found');
  if (!['queued', 'waiting_dependency', 'ready', 'prepared', 'needs_owner', 'failed', 'blocked', 'awaiting_integration'].includes(it.state)) throw fail(409, `No se puede aplazar una historia ${ITEM_LABEL[it.state]}.`, 'invalid_state');
  setItem(slug, id, itemId, { state: 'postponed', postponed: { at: now(), from: it.state, note }, acceptance: null, reason: `Aplazada por ti${note ? `: ${note.slice(0, 300)}` : ''}. No se integra en este lote; puedes recuperarla.` }, `aplazada por ti${note ? `: ${note.slice(0, 200)}` : ''}.`, 'acceptance');
  void scheduleTick(slug, id);
  return getBatch(slug, id);
}
export function restoreItem(slug: string, id: string, itemId: string): Batch {
  const b = getBatch(slug, id); controllable(b);
  const it = b.items.find(i => i.itemId === itemId); if (!it || it.state !== 'postponed') throw fail(409, 'Solo se recupera una historia aplazada.', 'invalid_state');
  const from = it.postponed?.from ?? 'queued';
  const state: BatchItemState = from === 'ready' || from === 'awaiting_integration' ? (onAcceptance(b) ? 'ready' : from) : from === 'queued' || from === 'waiting_dependency' ? (it.dependsInBatch ? 'waiting_dependency' : 'queued') : from;
  setItem(slug, id, itemId, { state, postponed: null, freshness: null, reason: 'Recuperada por ti.', ...(it.stack?.invalid && (state === 'queued' || state === 'waiting_dependency') ? { stack: null } : {}) }, 'recuperada por ti.', 'acceptance');
  reopenDependents(slug, id, it.storyId, 'recuperaste');
  if (b.status === 'completed') batchesRepo(slug).update(id, x => { x.status = 'running'; x.finishedAt = null; x.reason = null; x.createdAt = now(); });
  void scheduleTick(slug, id);
  return getBatch(slug, id);
}

/** No aceptar: queda registrada con tus notas y cada paso que falló se convierte en una tarea de la historia. */
export function rejectItem(slug: string, id: string, itemId: string, input: { note: string; failedSteps?: string[] }): Batch {
  const b = getBatch(slug, id); const it = b.items.find(i => i.itemId === itemId);
  if (!it || (it.state !== 'awaiting_acceptance' && it.state !== 'accepted' && it.state !== 'ready' && it.state !== 'prepared')) throw fail(409, 'Solo se puede no aceptar una historia terminada técnicamente (o reabrir una aceptada).', 'not_ready');
  const thread = threadRepo(slug);
  const taskIds = (input.failedSteps ?? []).map(s => s.trim()).filter(Boolean).slice(0, 20).map(s => thread.addTask({ backlogItemId: itemId, title: `Aceptación: ${s}`.slice(0, 300), assigneeAgentId: null, assigneeName: null }).id);
  thread.add({ backlogItemId: itemId, role: 'owner', agentId: null, agentName: null, content: `No aceptada en el lote «${b.title}»: ${input.note}${taskIds.length ? ` (${taskIds.length} tarea(s) creadas con los pasos que fallaron)` : ''}`, processId: it.processId, costUsd: 0, tokens: 0, proposals: null });
  if (it.state === 'accepted') backlogRepo(slug).setStatus(itemId, 'review', it.processId);
  setItem(slug, id, itemId, { state: 'rejected', acceptance: null, rejection: { at: now(), note: input.note, failedSteps: input.failedSteps ?? [], taskIds }, reason: `No aceptada: ${input.note.slice(0, 300)}` }, `no aceptada por ti (${taskIds.length} tarea(s) creadas).`, 'acceptance');
  void scheduleTick(slug, id);
  return getBatch(slug, id);
}

export function reopenItem(slug: string, id: string, itemId: string): Batch {
  const b = getBatch(slug, id); const it = b.items.find(i => i.itemId === itemId);
  if (!it || it.state !== 'accepted') throw fail(409, 'Solo se reabre una historia aceptada.', 'not_accepted');
  backlogRepo(slug).setStatus(itemId, 'review', it.processId);
  setItem(slug, id, itemId, { state: 'awaiting_acceptance', acceptance: null, reason: 'Reabierta por ti: vuelve a estar pendiente de tu aceptación.' }, 'reabierta por ti.', 'acceptance');
  return getBatch(slug, id);
}

/**
 * Iterar SOLO esta historia dentro de la autorización del lote (presupuesto, correcciones, Gauntlet): se prepara la
 * iteración con tu nota y los pasos que fallaron, y el lote la ejecuta en su turno. Las demás no se repiten.
 */
export async function iterateItem(slug: string, id: string, itemId: string, note: string, revision?: string | null): Promise<Batch> {
  const b = getBatch(slug, id); controllable(b);
  const it = b.items.find(i => i.itemId === itemId);
  const wasIntegrated = !!it && (!!it.mergedCommit || DEPENDENCY_SATISFIED.includes(it.state));
  if (!it || !['rejected', 'needs_owner', 'failed', 'awaiting_acceptance', 'awaiting_integration', 'ready', 'postponed', 'prepared'].includes(it.state)) throw fail(409, `Solo se itera una historia no aceptada, detenida o fallida${it ? ` (está ${ITEM_LABEL[it.state]})` : ''}.`, 'invalid_state');
  if (revision) assertRevisions(slug, [it], { [itemId]: revision });
  const lease = acquireWork(slug, { id: '', backlogItemId: itemId, assignmentId: null }, `batch-iterate:${id}`, 'preparar una iteración del lote');
  if ('conflict' in lease) throw fail(409, lease.conflict, 'busy');
  // Su trabajo NO está en main (lista, aplazada, detenida…): los cambios se aplican sobre SU rama como una ronda dirigida
  // (no se descarta ni se rehace lo verificado). Si ya está integrada, la iteración nueva parte de main como siempre.
  const cur = currentProcessId(it) ? processesRepo(slug).get(currentProcessId(it)!) : undefined;
  // No sirve si espera una respuesta tuya, si rechazaste su diff o si su problema es un conflicto con main (una ronda
  // sobre la rama vieja no lo arregla): entonces, iteración nueva como siempre.
  // Tampoco si se preparó sobre una versión provisional de su dependencia que ya no vale: hay que rehacerla sobre main.
  const ownerRound = ownerRoundPossible(cur) && !cur!.result?.pipeline?.ownerRequest && it.failureClass !== 'integration' && !it.stack?.invalid;
  let prepared = false;
  if (ownerRound) { try { prepareOwnerRound(slug, cur!.id, note); prepared = true; } catch { /* sin worktree utilizable: iteración nueva */ } }
  if (prepared && cur) {
    lease.release();
    threadRepo(slug).add({ backlogItemId: itemId, role: 'owner', agentId: null, agentName: null, content: `Cambios pedidos en el lote «${b.title}» (sobre su rama, sin descartarla): ${note}`, processId: cur.id, costUsd: 0, tokens: 0, proposals: null });
    batchesRepo(slug).update(id, x => {
      const y = x.items.find(i => i.itemId === itemId)!;
      // Una apilada trabaja sobre su versión provisional: sigue en cola (no vuelve a esperar ni se le cambia la base).
      Object.assign(y, { state: y.stack || !y.dependsInBatch ? 'queued' : 'waiting_dependency', resumeProcessId: cur.id, nextProcessId: null, acceptance: null, freshness: null, revalidation: null, postponed: null, failureClass: null, finishedAt: null, reason: `Cambios pedidos por ti (sobre su rama, sin rehacerla): ${note.slice(0, 200)}` });
      x.events.push({ at: now(), kind: 'item', itemId, message: `${y.storyId}: cambios pedidos por ti${revision ? ` sobre el commit ${revision.slice(0, 7)}` : ''}; se aplican sobre su rama (proceso ${cur.id.slice(0, 8)}) en su turno, con una corrección autorizada más; se repiten verificación, QA y Gauntlet.` });
      if (x.status === 'completed') { x.status = 'running'; x.finishedAt = null; x.reason = null; x.createdAt = now(); }
    });
    reopenDependents(slug, id, it.storyId, 'vuelve a trabajarse');
    void scheduleTick(slug, id);
    return getBatch(slug, id);
  }
  let process: Process;
  try { ({ process } = await iterateStory(slug, itemId, note, { reopen: true, discardApplied: true })); } finally { lease.release(); }
  batchesRepo(slug).update(id, x => {
    const y = x.items.find(i => i.itemId === itemId)!;
    // El lote vuelve a llevar la historia: la iteración que seguía de fuera queda como resuelta (no se vuelve a seguir).
    // Una dependiente vuelve a esperar a su dependencia (la iteración nueva nace de main y necesita su código).
    Object.assign(y, { state: y.dependsInBatch && !dependencyIntegrated(x, { ...y, stack: null }) ? 'waiting_dependency' : 'queued', nextProcessId: process.id, resumeProcessId: null, followedProcessId: null, acceptance: null, freshness: null, revalidation: null, postponed: null, stack: null, noStack: null, dismissedProcessIds: [...(y.dismissedProcessIds ?? []), ...(y.followedProcessId ? [y.followedProcessId] : [])], reason: `Nueva iteración con tu nota: ${note.slice(0, 200)}`, failureClass: null, finishedAt: null, mergedCommit: null, activated: false });
    x.events.push({ at: now(), kind: 'item', itemId, message: `${y.storyId}: iteración dirigida preparada (proceso ${process.id.slice(0, 8)}); se ejecuta en su turno dentro de los límites del lote.` });
    if (x.status === 'completed') { x.status = 'running'; x.finishedAt = null; x.reason = null; }
  });
  if (!wasIntegrated) invalidateStackedOn(slug, id, it.storyId, `${it.storyId} se rehace desde main (iteración nueva): la versión provisional sobre la que se preparó ya no se integrará.`);
  void scheduleTick(slug, id);
  return getBatch(slug, id);
}

/**
 * La dependencia se rehace desde main: lo preparado sobre su versión anterior no se integrará nunca. Se detiene lo que esté
 * trabajando sobre ella (sin seguir gastando), lo que aún no empezó vuelve a esperar, y lo terminado espera tu decisión
 * («Iterar» lo rehace sobre la versión nueva).
 */
function invalidateStackedOn(slug: string, id: string, storyId: string, why: string) {
  // Solo lo que aún depende de esa versión provisional (lo que ya pasó a lista o se integra trabaja sobre main con ella).
  for (const d of getBatch(slug, id).items.filter(i => i.stack?.storyId === storyId && !i.stack.invalid && ['queued', 'running', 'prepared', 'blocked', 'needs_owner', 'postponed'].includes(i.state))) {
    const p = d.processId ? processesRepo(slug).get(d.processId) : undefined;
    const started = !!p && d.processIds.includes(p.id) && !!p.result?.stack;
    if (!started && d.state === 'queued') { setItem(slug, id, d.itemId, { state: 'waiting_dependency', stack: null, reason: `Espera a ${storyId}: ${why}` }, `vuelve a esperar a ${storyId} sin gasto (${why})`); continue; }
    if (d.state === 'running' && p) { cancelProcess(p.id); abortProcessCalls(p.id); }
    setItem(slug, id, d.itemId, { state: 'needs_owner', failureClass: 'dependency', stack: { ...d.stack!, invalid: why }, resumeProcessId: null, reason: `${why} Su trabajo se conserva en su proceso; «Iterar» la rehace sobre la versión nueva de ${storyId} (no se integra nada de la anterior).` }, `${d.state === 'running' ? 'detenida' : 'en espera de tu decisión'}: ${why}`);
  }
}

// ---------------------------------------------------------------- Cambio explícito de la política de integración

const POLICY_LABEL: Record<string, string> = { auto: 'integrar al terminar cada historia', on_acceptance: 'integrar al aceptar cada historia', manual: 'sin integrar (manual)' };
const gitText = (g: { merge: boolean; activate: boolean; publish: boolean; integration?: string; prepareDependents?: boolean }) => `${g.merge ? POLICY_LABEL[g.integration ?? 'auto'] : POLICY_LABEL.manual}; activar ${g.activate ? 'sí' : 'no'}; publicar en GitHub ${g.publish ? 'sí' : 'no'}${g.integration === 'on_acceptance' ? `; preparar dependientes ${g.prepareDependents ? 'sí' : 'no'}` : ''}`;

/** Qué hará «Reanudar» con cada historia bajo una política (sin IA ni git): lo que ves antes de reanudar. */
function resumeEffects(slug: string, b: Batch, git: Batch['auth']['git']): { itemId: string; storyId: string; effect: string }[] {
  const pol = git.merge ? (git.integration ?? 'auto') : 'manual';
  const after = pol === 'auto' ? `se integra en main${git.publish ? ', se publica en GitHub' : ''}${git.activate && slug === INTERNAL_WORKSPACE.slug ? ' y se activa en el Portal (reconstruir y reiniciar)' : ''} SIN esperar tu revisión` : pol === 'on_acceptance' ? 'queda lista para tu revisión, sin integrar (entra en main solo cuando la aceptes)' : 'queda terminada; integrarla es decisión tuya desde su proceso';
  const out: { itemId: string; storyId: string; effect: string }[] = [];
  const procs = processesRepo(slug);
  for (const it of b.items) {
    const p = it.processId ? procs.get(it.processId) : undefined;
    if (it.state === 'awaiting_integration' && git.merge) { out.push({ itemId: it.itemId, storyId: it.storyId, effect: pol === 'auto' ? `Terminada: ${after}.` : `Terminada: ${after}.` }); continue; }
    const mode = requeueMode(slug, it); if (!mode) continue;
    const effect = p && candidateNeedsQa(p) ? `QA revisa su candidato de integración (una llamada); si lo aprueba, ${after}.`
      : p && qaRetryable(it, p) ? `QA vuelve a revisarla una vez con la evidencia actual (una llamada); si la aprueba, ${after}.`
      : mode === 'continue' ? `Se retoma donde quedó (sin repetir lo hecho); al terminar, ${after}.`
      : `Vuelve a la cola (no tenía trabajo que conservar); al terminar, ${after}.`;
    out.push({ itemId: it.itemId, storyId: it.storyId, effect });
  }
  return out;
}

export interface PolicyView {
  policy: string; label: string; git: Batch['auth']['git'];
  /** Se puede pasar a «integrar al aceptar» (y por qué no, si no). */
  canChange: boolean; blockedBy: string | null;
  alreadyIntegrated: { itemId: string; storyId: string; commit: string; activated: boolean; accepted: boolean }[];
  willBecomeReady: { itemId: string; storyId: string; from: string }[];
  resumeNow: { itemId: string; storyId: string; effect: string }[];
  resumeAfter: { itemId: string; storyId: string; effect: string }[];
  history: NonNullable<Batch['policyHistory']>;
}

function integratedFacts(slug: string, b: Batch) {
  const procs = processesRepo(slug);
  return b.items.map(it => { const p = procs.get(currentProcessId(it) ?? ''); return { it, merged: it.mergedCommit ?? p?.result?.merged?.commit ?? null }; });
}
const changeBlocker = (slug: string, b: Batch): string | null => {
  if (b.status === 'cancelled' || b.status === 'revoked' || b.status === 'completed') return `El lote está ${b.status === 'completed' ? 'terminado' : b.status === 'cancelled' ? 'cancelado' : 'revocado'}: no hay integraciones futuras que cambiar.`;
  const pol = integrationPolicy(b.auth);
  if (pol === 'manual') return 'Este lote no tiene «Integrar en main» autorizado: no integra nada solo (ya decides tú cada integración).';
  if (pol === 'on_acceptance') return 'Este lote ya integra al aceptar cada historia.';
  if (updateRunning()) return 'El Portal se está reconstruyendo para activar una integración: espera a que termine.';
  if (b.activation?.state === 'requested') return `Hay una activación pedida (${b.activation.itemIds.length} historia(s)) que se comprueba al volver el Portal: espera a que termine (o reinicia el Portal) antes de cambiar la política.`;
  const busy = [...integratingNow, ...revalidating, ...finishing].find(k => k.startsWith(`${slug}:${b.id}:`));
  if (busy) { const st = b.items.find(i => busy.endsWith(`:${i.itemId}`))?.storyId; return `Hay una integración en curso${st ? ` (${st})` : ''}: espera a que termine (no se cambia la política a medias).`; }
  return null;
};

/** Vista previa (sin cambiar nada) del cambio de política y de lo que hará «Reanudar» antes y después. */
export function policyView(slug: string, id: string): PolicyView {
  const b = getBatch(slug, id); const blockedBy = changeBlocker(slug, b);
  const to = { ...b.auth.git, integration: 'on_acceptance' as const, prepareDependents: false };
  const facts = integratedFacts(slug, b);
  return {
    policy: integrationPolicy(b.auth), label: POLICY_LABEL[integrationPolicy(b.auth)], git: b.auth.git, canChange: !blockedBy, blockedBy,
    alreadyIntegrated: facts.filter(f => f.merged).map(f => ({ itemId: f.it.itemId, storyId: f.it.storyId, commit: f.merged!, activated: !!f.it.activated, accepted: f.it.state === 'accepted' })),
    willBecomeReady: facts.filter(f => !f.merged && (f.it.state === 'awaiting_integration' || (f.it.state === 'integrating' && !f.it.mergedCommit))).map(f => ({ itemId: f.it.itemId, storyId: f.it.storyId, from: f.it.state })),
    resumeNow: resumeEffects(slug, b, b.auth.git), resumeAfter: resumeEffects(slug, b, to),
    history: b.policyHistory ?? []
  };
}

/**
 * Cambio EXPLÍCITO de un lote ya autorizado con integración automática a «integrar al aceptar» (decisión tuya, auditable y
 * que solo restringe). No reinterpreta nada en silencio: la autorización original queda en el registro; lo ya integrado no
 * se des-integra (aceptarlo es reconocerlo); lo terminado sin integrar pasa a esperar tu revisión; publicar y activar se
 * pueden mantener o quitar, nunca añadir. Se rechaza mientras haya una integración en curso.
 */
export async function changePolicy(slug: string, id: string, input: { publish: boolean; activate: boolean; note: string | null }): Promise<Batch> {
  const b0 = getBatch(slug, id);
  const blocked = changeBlocker(slug, b0); if (blocked) throw fail(409, blocked, 'policy_change_blocked');
  if ((input.publish && !b0.auth.git.publish) || (input.activate && !b0.auth.git.activate)) throw fail(409, 'El cambio de política solo restringe: no puede añadir publicar ni activar si el lote no los tenía autorizados (para eso, autoriza otro lote).', 'widening');
  // Un merge hecho y no registrado (reinicio entre el merge y su registro) ya está en main: se registra como integrado, no se
  // presenta como «sin integrar».
  const procs = processesRepo(slug);
  for (const it of b0.items.filter(i => (i.state === 'integrating' && !i.mergedCommit) || i.state === 'awaiting_integration')) {
    const p = procs.get(currentProcessId(it) ?? '');
    if (p && await alreadyInMain(slug, p)) await mergeStory(slug, p.id, {}, logger);
  }
  const b = getBatch(slug, id);
  const again = changeBlocker(slug, b); if (again) throw fail(409, again, 'policy_change_blocked');
  const at = now(); const from = { ...b.auth.git };
  const to = { ...from, integration: 'on_acceptance' as const, publish: from.publish && input.publish, activate: from.activate && input.activate, prepareDependents: false };
  const internal = slug === INTERNAL_WORKSPACE.slug;
  batchesRepo(slug).update(id, x => {
    const alreadyIntegrated: NonNullable<Batch['policyHistory']>[number]['alreadyIntegrated'] = []; const converted: NonNullable<Batch['policyHistory']>[number]['converted'] = [];
    for (const i of x.items) {
      const merged = i.mergedCommit ?? procs.get(currentProcessId(i) ?? '')?.result?.merged?.commit ?? null;
      if (merged) {
        alreadyIntegrated.push({ itemId: i.itemId, storyId: i.storyId, commit: merged, activated: !!i.activated, accepted: i.state === 'accepted' });
        // Integrada (y quizá pendiente de activar) bajo la política anterior: no se des-integra ni se activa sola.
        if (i.state === 'integrating' || i.state === 'awaiting_integration') {
          converted.push({ itemId: i.itemId, storyId: i.storyId, from: i.state, to: 'awaiting_acceptance' });
          Object.assign(i, { state: 'awaiting_acceptance', mergedCommit: merged, reason: `Ya estaba integrada en main (${merged}) antes del cambio de política: aceptarla es reconocerla${internal && !i.activated ? '. No está activa en el Portal en marcha: lo estará cuando se active otra historia aceptada o reconstruyas tú' : ''}.` });
        }
        continue;
      }
      if (i.state === 'integrating' || i.state === 'awaiting_integration') {
        converted.push({ itemId: i.itemId, storyId: i.storyId, from: i.state, to: 'ready' });
        Object.assign(i, { state: 'ready', freshness: null, acceptance: null, revalidation: null, reason: 'Terminada técnicamente: con la nueva política espera tu revisión y solo entra en main cuando la aceptes.' });
      }
    }
    x.auth.git = to;
    (x.policyHistory ??= []).push({ at, by: 'owner', note: input.note, from, to, alreadyIntegrated, converted });
    x.events.push({ at, kind: 'policy', message: `Política de integración cambiada por el propietario (decisión explícita): antes «${gitText(from)}» → ahora «${gitText(to)}». ${alreadyIntegrated.length ? `Ya estaban en main y no se des-integran (aceptarlas es reconocerlas): ${alreadyIntegrated.map(a => `${a.storyId} ${a.commit}`).join(', ')}. ` : ''}${converted.filter(c => c.to === 'ready').length ? `Pasan a esperar tu revisión sin integrar: ${converted.filter(c => c.to === 'ready').map(c => c.storyId).join(', ')}. ` : ''}A partir de ahora ninguna historia entra en main sin tu aceptación.${input.note ? ` Nota: ${input.note.slice(0, 300)}` : ''}` });
  });
  procs.logExecution({ projectId: b.projectId, agentId: '', kind: `batch_policy_changed:${id}`, status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: at });
  void scheduleTick(slug, id);
  return getBatch(slug, id);
}

// ---------------------------------------------------------------- Reinicios

/**
 * Al arrancar (tras marcar los procesos interrumpidos): cada lote en marcha retoma sin repetir lo hecho. Una historia
 * interrumpida se retoma SOLA una vez si no había ninguna llamada en curso (cobro cierto); si la había, decides tú.
 */
export async function resumeBatches(log: (o: any, m: string) => void = logger): Promise<number> {
  let n = 0;
  for (const ws of workspacesRepo.list()) {
    let repo; try { repo = batchesRepo(ws.slug); } catch { continue; }
    for (const b of repo.active()) {
      if (b.status !== 'running') continue;
      const procs = processesRepo(ws.slug);
      for (const it of b.items.filter(i => i.state === 'running' && i.processId)) {
        const p = procs.get(it.processId!); if (!p || (p.status === 'running')) continue;
        const pl = p.result?.pipeline;
        if (p.status === 'done' && pl?.state === 'paused' && pl.pauseKind === 'interrupted') {
          const since = it.startedAt ?? '';
          // Cobro incierto solo si la llamada interrumpida iba por la API (con la suscripción no hay USD en juego).
          const uncertain = uncertainCharge(p, since);
          if (b.auth.autoResume && it.autoResumes < BATCH_LIMITS.maxAutoResumes && !uncertain) {
            procs.resume(p.id, Math.max(p.budgetUsd ?? 0, p.spentUsd));
            procs.setResult(p.id, { ...p.result!, pipeline: { ...pl, failures: [], startedAt: now() } });
            setItem(ws.slug, b.id, it.itemId, { autoResumes: it.autoResumes + 1, startedAt: now() }, 'interrumpida por un reinicio sin llamadas en curso: se retoma donde quedó (no se repite nada).', 'recovery');
            const run = batchDeps.resumeStory(ws.slug, p.id, log, () => isCancelled(p.id)).finally(() => { clearCancel(p.id); void scheduleTick(ws.slug, b.id); });
            trackJob(p.id, run).catch(e => log({ err: e?.message, processId: p.id }, 'lote: fallo inesperado al retomar'));
            n++;
            continue;
          }
          setItem(ws.slug, b.id, it.itemId, { state: 'needs_owner', failureClass: 'environment', reason: uncertain ? 'Interrumpida por un reinicio con una llamada por la API en curso: su cobro no está confirmado. No se reenvía sola: decide si continuar.' : 'Interrumpida por un reinicio y ya se retomó una vez sola: decide si continuar.' }, uncertain ? 'interrumpida con una llamada en curso: decides tú (no se reenvía sola).' : 'interrumpida otra vez: decides tú.', 'recovery');
        }
      }
      await finishActivation(ws.slug, b.id).catch(e => log({ err: e?.message, batchId: b.id }, 'lote: no se pudo comprobar la activación'));
      void scheduleTick(ws.slug, b.id);
    }
  }
  if (n) log({ resumed: n }, 'lotes: historias interrumpidas retomadas');
  return n;
}

let timer: NodeJS.Timeout | null = null;
/** Revisión periódica (sin IA) de los lotes en marcha: refleja lo que hiciste fuera del lote y continúa. */
export function startBatchScheduler(log: (o: any, m: string) => void, everyMs = 30_000) {
  logger = log;
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    for (const ws of workspacesRepo.list()) { try { for (const b of batchesRepo(ws.slug).active()) if (b.status === 'running') void scheduleTick(ws.slug, b.id); } catch { /* espacio sin base */ } }
  }, everyMs);
  timer.unref();
}
export function stopBatchScheduler() { if (timer) clearInterval(timer); timer = null; }
export function setBatchLogger(log: (o: any, m: string) => void) { logger = log; }

/** Vista del monitor: cada historia con su proceso (estado, pipeline, Gauntlet, gasto) y los totales del lote. */
export function batchView(slug: string, b: Batch) {
  const procs = processesRepo(slug);
  const items = b.items.map(it => {
    const cur = currentProcessId(it); const p = cur ? procs.get(cur) : undefined; const r = p?.result;
    const rev = p ? revisionStatus(p) : null; const pv = r?.previews?.at(-1) ?? null;
    const dh = it.stack ? dependencyHead(slug, b, it) : null;
    return {
      ...it, label: ITEM_LABEL[it.state],
      stackInfo: it.stack ? { storyId: it.stack.storyId, commit: it.stack.commit, dependencyHead: dh, moved: !!dh && !same7(dh, it.stack.commit), invalid: it.stack.invalid ?? null } : null,
      evidence: p && r?.applied ? { head: r.applied.commit, verifiedHead: !!rev?.verifiedHead, commands: (r.pipeline?.config.commands ?? ['typecheck']).map(c => ({ command: c, ok: verificationsForApplied(r).some(v => v.command === c && v.exitCode === 0), isolation: verificationsForApplied(r).filter(v => v.command === c).at(-1)?.isolation ?? null })), qa: rev ? { state: rev.qa.state, coversHead: rev.qa.coversHead, why: rev.qa.why } : null } : null,
      preview: pv ? { ...pv, live: previewLive(p!.id, pv.id), outdated: !same7(pv.commit, r?.applied?.commit) } : null,
      process: p ? { id: p.id, status: p.status, spentUsd: p.spentUsd, unconfirmedUsd: p.unconfirmedUsd ?? 0, budgetUsd: p.budgetUsd, pipeline: r?.pipeline ? { state: r.pipeline.state, phase: r.pipeline.phase, pauseKind: r.pipeline.pauseKind, reason: r.pipeline.reason, corrections: r.pipeline.corrections } : null, gauntlet: r?.gauntlet ? { mode: r.gauntlet.mode, status: r.gauntlet.status, rounds: r.gauntlet.rounds.length, reason: r.gauntlet.reason } : null, review: r?.review?.verdict ?? null, merged: r?.merged ?? null, manualTest: r?.manualTest ? { steps: r.manualTest.steps, checks: r.manualTest.checks } : null, userFacing: r?.userFacing ?? null, implementer: p.steps.find(s => s.role === 'implementer')?.agentName ?? null, evaluator: p.steps.find(s => s.role === 'evaluator' && s.status !== 'skipped')?.agentName ?? null } : null
    };
  });
  return { ...b, items, summary: batchSummary(b.items), lifecycle: batchLifecycle(b.items, integrationPolicy(b.auth), b.integrationPlan?.order ?? []), budget: budgetOf(slug, b), subscriptionCalls: subscriptionCalls(slug, b) };
}

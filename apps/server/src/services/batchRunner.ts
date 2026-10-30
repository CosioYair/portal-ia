import { BATCH_LIMITS, DEPENDENCY_BROKEN, DEPENDENCY_SATISFIED, INTERNAL_WORKSPACE, backendLabel, batchBudget, batchMoving, batchSourceOf, batchSummary, classifyStop, DEFAULT_GAUNTLET, gauntletOverhead, normalizeGauntlet, normalizePipeline, planBatch, type Batch, type BatchAgentCheck, type BatchAuthorization, type BatchItem, type BatchItemState, type BatchPreview, type BatchPreviewStory, type CallRange, type GauntletConfig, type Process, type ProviderId, type RuntimeCheck, type RuntimeCheckResult } from '@portal-ia/domain';
import { batchesRepo } from '../db/batches.ts';
import { callMetricsRepo } from '../db/callMetrics.ts';
import { providersRepo, workspacesRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
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
import { createStoryProcess, estimateStory, repoContextChars, runStory } from './storyExecution.ts';
import { prepareIntegration, verifyCandidate } from './storyIntegration.ts';
import { mergeStory } from './storyMerge.ts';
import { newPipeline, resumeStory } from './storyPipeline.ts';
import { iterateStory, threadRepo } from './storyThread.ts';
import { activationOf, startUpdate, systemStatus } from './system.ts';

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
  accepted: 'aceptada', rejected: 'no aceptada', failed: 'fallida', blocked: 'bloqueada', cancelled: 'cancelada'
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
  git?: { merge?: boolean; activate?: boolean; publish?: boolean };
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
  return {
    projectId, itemIds, backends,
    apiFallback: !!input.apiFallback && backends.includes('api'),
    totalBudgetUsd: clamp(input.totalBudgetUsd, 0.1, BATCH_LIMITS.maxTotalUsd, 1),
    perStoryBudgetUsd: clamp(input.perStoryBudgetUsd, 0.1, BATCH_LIMITS.maxPerStoryUsd, 1),
    maxCorrections: Math.floor(clamp(input.maxCorrections, 0, BATCH_LIMITS.maxCorrections, 3)),
    maxDurationMin: Math.floor(clamp(input.maxDurationMin, 5, BATCH_LIMITS.maxDurationMin, 240)),
    maxSubscriptionCalls: Math.floor(clamp(input.maxSubscriptionCalls, 0, BATCH_LIMITS.maxSubscriptionCalls, 60)),
    // Sin indicarlo, el del proyecto (por defecto «automático»: se resuelve historia a historia al empezar cada una).
    gauntlet: normalizeGauntlet(input.gauntlet ?? projectDefault),
    concurrency: Math.floor(clamp(input.concurrency, 1, BATCH_LIMITS.maxConcurrency, 1)),
    commands: order.filter(c => (input.commands ?? order).includes(c)),
    allowInstall: !!input.allowInstall,
    git: { merge, activate: merge && !!input.git?.activate, publish: merge && !!input.git?.publish },
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
    if (!a) return { agentId: id, name: 'Agente eliminado', roles, backend: 'api', source: 'api', label: '—', allowed: false, ready: false, problem: 'Un agente del equipo ya no existe.', fix: { label: 'Equipo de IA', href: '/equipo' }, viaFallback: false };
    const backend = agentBackend(a); const source = batchSourceOf(backend); const name = a.config.name;
    const providerId = a.config.provider as ProviderId; const api = backendLabel('api', null, providerId);
    const apiReady = !!providersRepo.credential(providerId) && providersRepo.get(providerId)?.status === 'connected';
    const base = { agentId: id, name, roles, backend, source, label: backendLabel(backend, billing, providerId), allowed: auth.backends.includes(source), viaFallback: false };
    const agentLink = { label: `Origen de «${name}» (Equipo de IA)`, href: `/equipo/${id}` };
    if (!base.allowed) return { ...base, ready: false, fix: agentLink, problem: source === 'api'
      ? `«${name}» usa ${api} (facturable) y este lote no autoriza la API.`
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
const usd = (n: number) => Number(n.toFixed(4));

type Limit = 'subscription' | 'budget' | 'duration';
/**
 * Cuántas historias empiezan antes de que los límites pausen el lote, en el orden del plan y con la misma regla que el
 * coordinador: una historia empieza si las llamadas a la suscripción ya hechas no alcanzan el tope, el presupuesto
 * restante (descontado lo reservado para las que van a la vez) cubre el tope por historia y no se ha superado la duración
 * máxima. Con varias a la vez, las de un mismo grupo no ven las llamadas ni el gasto de las otras hasta que terminan (por
 * eso el tope puede superarse un poco). `minutes`: duración por historia del historial (null si no hay datos).
 */
function fitsUnderLimits(stories: BatchPreviewStory[], auth: BatchAuthorization, pick: 'min' | 'max', minutes: number | null): { n: number; limitedBy: Limit[] } {
  const c = Math.max(1, auth.concurrency); let calls = 0; let spent = 0; let groupCalls = 0; let groupUsd = 0; let n = 0; let inGroup = 0; let rounds = 0;
  const close = () => { calls += groupCalls; spent += groupUsd; groupCalls = 0; groupUsd = 0; inGroup = 0; rounds++; };
  const room = () => auth.totalBudgetUsd - spent - inGroup * auth.perStoryBudgetUsd + 1e-9 >= auth.perStoryBudgetUsd;
  for (const s of stories) {
    // Si lo reservado para las que van a la vez no deja sitio, el coordinador espera a que terminen (no pausa el lote).
    if (inGroup > 0 && !room()) close();
    const limitedBy: Limit[] = [];
    if (auth.backends.includes('claude_code') && calls >= auth.maxSubscriptionCalls) limitedBy.push('subscription');
    if (!room()) limitedBy.push('budget');
    if (minutes !== null && rounds * minutes > auth.maxDurationMin) limitedBy.push('duration');
    if (limitedBy.length) return { n, limitedBy };
    n++; inGroup++; groupCalls += s.subscriptionCalls[pick]; groupUsd += (pick === 'min' ? s.estimatedUsd : s.estimatedUsdMax) ?? 0;
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
  const optimistic = fitsUnderLimits(automatic, auth, 'min', hist?.median ?? null); const pessimistic = fitsUnderLimits(automatic, auth, 'max', hist?.p75 ?? null);
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
  const scope = `${items.length} historia(s) · ${auth.totalBudgetUsd} USD en total (máx. ${auth.perStoryBudgetUsd} por historia) · ${auth.maxCorrections} corrección(es) · Gauntlet ${auth.gauntlet.mode} · ${auth.concurrency} a la vez · ${auth.maxDurationMin} min · orígenes ${auth.backends.join(', ')} · integrar ${auth.git.merge ? 'sí' : 'no'} · activar ${auth.git.activate ? 'sí' : 'no'} · publicar ${auth.git.publish ? 'sí' : 'no'}`;
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

const repoLocks = new Map<string, Promise<unknown>>();
/** Integración y activación de una en una por repositorio (también entre lotes). */
async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  repoLocks.set(key, next.catch(() => undefined));
  return next;
}

async function tick(slug: string, id: string) {
  const repo = batchesRepo(slug);
  syncItems(slug, id);
  let b = repo.get(id); if (!b || b.status !== 'running') return;
  if (batchDeps.now() - Date.parse(b.createdAt) > b.auth.maxDurationMin * 60_000) { setStatus(slug, id, 'paused', `Se alcanzó la duración máxima autorizada del lote (${b.auth.maxDurationMin} min). Lo hecho se conserva; «Reanudar» concede el mismo margen otra vez.`, 'pause'); return; }
  resolveDependencies(slug, id);
  // Integración (requiere integrar pre-autorizado): de una en una, nunca con el lote pausado o revocado.
  for (const it of repo.get(id)!.items.filter(i => i.state === 'integrating' && !i.mergedCommit)) {
    if (repo.get(id)!.status !== 'running') return;
    await integrate(slug, id, it.itemId);
    resolveDependencies(slug, id);
  }
  if (await maybeActivate(slug, id)) return;
  startNext(slug, id);
  b = repo.get(id)!;
  if (b.status === 'running') maybeComplete(slug, id);
}

function setItem(slug: string, id: string, itemId: string, patch: Partial<BatchItem>, event?: string, kind: 'item' | 'integration' | 'activation' | 'recovery' | 'acceptance' = 'item') {
  batchesRepo(slug).update(id, b => {
    const it = b.items.find(i => i.itemId === itemId); if (!it) return;
    Object.assign(it, patch);
    if (event) b.events.push({ at: now(), kind, itemId, message: `${it.storyId}: ${event}` });
  });
}
function setStatus(slug: string, id: string, status: Batch['status'], reason: string | null, kind: 'pause' | 'resume' | 'cancel' | 'revoke' | 'completed' | 'budget', fix: { label: string; href: string } | null = null) {
  batchesRepo(slug).update(id, b => {
    b.status = status; b.reason = reason; b.reasonFix = fix;
    if (status === 'completed' || status === 'cancelled' || status === 'revoked') b.finishedAt = now();
    if (status === 'revoked') b.revokedAt = now();
    if (reason || kind === 'resume') b.events.push({ at: now(), kind, message: reason ?? 'Lote reanudado por el propietario.' });
  });
}

/** Refleja en cada historia lo que pasó en su proceso (también lo que hiciste tú fuera del lote). */
function syncItems(slug: string, id: string) {
  const b = batchesRepo(slug).get(id); if (!b) return;
  const procs = processesRepo(slug);
  for (const it of b.items) {
    const p = it.processId ? procs.get(it.processId) : undefined; if (!p) continue;
    if (it.state === 'running') {
      if (p.status === 'running') continue; // en marcha (o huérfano: lo trata la recuperación al arrancar)
      onFinished(slug, id, it, p);
    } else if (it.state === 'needs_owner' || it.state === 'failed') {
      // Lo retomaste desde el proceso: el lote vuelve a seguirlo.
      if (p.status === 'running') setItem(slug, id, it.itemId, { state: 'running', reason: null, failureClass: null }, 'la retomaste desde el proceso; el lote la sigue.');
      else if (p.result?.merged) afterMerge(slug, id, it.itemId, p);
      else if (p.status === 'done' && p.result?.pipeline?.state === 'verified' && it.failureClass !== 'integration') technicalDone(slug, id, it.itemId, p);
    } else if (it.state === 'awaiting_integration') {
      if (p.result?.merged) afterMerge(slug, id, it.itemId, p);
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
  const why = c.cls === 'subscription' ? 'límite de la suscripción de Claude' : code === 'origin_not_allowed' ? 'un agente usa un origen que el lote no autoriza' : code === 'backend_unavailable' ? 'Claude Code no disponible' : 'entorno de verificación';
  // Un motivo de todo el lote (límite de la suscripción, Claude Code no disponible) no es un fallo de la historia: espera tu decisión.
  setItem(slug, id, it.itemId, { state: p.status === 'failed' && !c.batchWide ? 'failed' : 'needs_owner', failureClass: c.cls, reason, finishedAt: now() }, `${p.status === 'failed' && !c.batchWide ? 'falló' : 'se detuvo'} (${c.cls}): ${clip(reason, 400)}${c.batchWide ? '' : ' Las historias independientes siguen.'}`);
  // El mismo motivo detendría a las demás (límite de la suscripción, sandbox caído): se pausa todo el lote.
  if (c.batchWide) setStatus(slug, id, 'paused', `${it.storyId} se detuvo por un motivo que afecta a todo el lote (${why}): ${clip(reason, 400)} No se empieza nada más hasta que lo resuelvas y reanudes.`, 'pause', { label: `Proceso de ${it.storyId}`, href: `/procesos/${p.id}` });
}

function technicalDone(slug: string, id: string, itemId: string, p: Process) {
  if (p.result?.merged) return afterMerge(slug, id, itemId, p);
  const b = batchesRepo(slug).get(id)!;
  if (b.auth.git.merge && b.status === 'running') setItem(slug, id, itemId, { state: 'integrating', reason: 'Terminada técnicamente: se integrará en main (de una en una).', failureClass: null, finishedAt: now() }, 'terminada técnicamente (verificación, QA y Gauntlet según el modo); pasa a integración.');
  else setItem(slug, id, itemId, { state: 'awaiting_integration', reason: b.auth.git.merge ? 'Terminada técnicamente; el lote no está en marcha: intégrala desde el proceso o reanuda el lote.' : 'Terminada técnicamente. Integrar en main no estaba pre-autorizado en el lote: hazlo desde el proceso.', failureClass: null, finishedAt: now() }, 'terminada técnicamente; integrar es decisión tuya.');
}

function afterMerge(slug: string, id: string, itemId: string, p: Process) {
  const b = batchesRepo(slug).get(id)!;
  const internal = slug === INTERNAL_WORKSPACE.slug;
  const commit = p.result!.merged!.commit;
  if (internal && b.auth.git.activate) return setItem(slug, id, itemId, { state: 'integrating', mergedCommit: commit, activated: false, reason: `Integrada en main (${commit}); se activará en el Portal cuando no haya nada en marcha.` }, `integrada en main (${commit}).`, 'integration');
  setItem(slug, id, itemId, { state: 'awaiting_acceptance', mergedCommit: commit, reason: internal ? `Integrada en main (${commit}). Activarla en el Portal en marcha (reconstruir y reiniciar) es decisión tuya: la aceptación lo exige.` : `Integrada en main (${commit}) y verificada: falta tu aceptación.` }, `integrada en main (${commit}); pendiente de tu aceptación.`, 'integration');
}

function resolveDependencies(slug: string, id: string) {
  const b = batchesRepo(slug).get(id)!;
  for (const it of b.items.filter(i => i.state === 'waiting_dependency')) {
    const dep = b.items.find(i => i.storyId === it.dependsOn);
    if (!dep) { setItem(slug, id, it.itemId, { state: 'queued', reason: null }); continue; }
    if (DEPENDENCY_SATISFIED.includes(dep.state)) setItem(slug, id, it.itemId, { state: 'queued', reason: null }, `su dependencia ${dep.storyId} ya está integrada; entra en la cola.`);
    else if (DEPENDENCY_BROKEN.includes(dep.state)) setItem(slug, id, it.itemId, { state: 'blocked', failureClass: 'dependency', reason: `Depende de ${dep.storyId}, que quedó ${ITEM_LABEL[dep.state]}: no se ejecuta (no se omite en silencio).`, finishedAt: now() }, `bloqueada: su dependencia ${dep.storyId} quedó ${ITEM_LABEL[dep.state]}.`);
    else { const reason = `Espera a ${dep.storyId} (${ITEM_LABEL[dep.state]}).`; if (it.reason !== reason) setItem(slug, id, it.itemId, { reason }); }
  }
}

async function integrate(slug: string, id: string, itemId: string) {
  const b = batchesRepo(slug).get(id)!; const it = b.items.find(i => i.itemId === itemId)!;
  const procs = processesRepo(slug); const pid = it.processId!;
  const repoPath = projectsRepo(slug).repository(b.projectId)?.path ?? b.projectId;
  await withRepoLock(repoPath, async () => {
    const p = procs.get(pid)!;
    if (p.result?.merged) return afterMerge(slug, id, itemId, p);
    try {
      // main avanzó (otra historia del lote ya integrada): candidato sin IA y verificación objetiva antes de integrar.
      const prep = await prepareIntegration(slug, pid, { allowOthersRunning: true });
      if (prep.state === 'conflicts') return setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'integration', reason: `Conflictos reales con ${prep.status.target} en ${prep.status.conflicts.map(c => c.path).join(', ')}. Nada cambió en main; resuélvelos desde el proceso.` }, 'conflictos reales al integrar: decides tú (main no cambió).', 'integration');
      if (prep.state === 'candidate') {
        setItem(slug, id, itemId, {}, `main avanzó: candidato preparado sin IA; se verifica en el sandbox antes de integrar.`, 'integration');
        await verifyCandidate(slug, pid, logger, () => isCancelled(pid));
      }
      if (batchesRepo(slug).get(id)!.status !== 'running') return setItem(slug, id, itemId, { state: 'awaiting_integration', reason: 'El lote se pausó antes de integrar: intégrala desde el proceso o reanuda el lote.' });
      const m = await mergeStory(slug, pid, {}, logger);
      if (b.auth.git.publish) {
        requirePolicy('git_push', { slug, processId: pid, projectId: b.projectId, authorized: true });
        const pushed = await pushBranches(repoPath, [m.result!.applied!.branch, m.result!.merged!.into]);
        procs.setResult(pid, { ...procs.get(pid)!.result!, published: { ...pushed, pushedAt: now() } });
        setItem(slug, id, itemId, {}, `publicada en ${pushed.remote} (pre-autorizado en el lote).`, 'integration');
      }
      afterMerge(slug, id, itemId, procs.get(pid)!);
    } catch (e: any) {
      setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'integration', reason: `No se integró: ${e?.message ?? e}` }, `no se integró (main no cambió): ${String(e?.message ?? e).slice(0, 300)}`, 'integration');
    }
  });
}

/** Proyecto interno: reconstruir y reiniciar el Portal (de una en una, con nada en marcha). Devuelve true si se pidió. */
async function maybeActivate(slug: string, id: string): Promise<boolean> {
  const b = batchesRepo(slug).get(id)!;
  if (slug !== INTERNAL_WORKSPACE.slug || !b.auth.git.activate || b.activation?.state === 'requested') return b.activation?.state === 'requested';
  const pending = b.items.filter(i => i.state === 'integrating' && i.mergedCommit && !i.activated);
  if (!pending.length) return false;
  if (b.items.some(i => i.state === 'running' || (i.state === 'integrating' && !i.mergedCommit)) || processesRepo(slug).running().length) return false;
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
    } else setItem(slug, id, itemId, { state: 'awaiting_acceptance', activated: true, reason: 'Integrada, activa en el Portal y verificada en ejecución: falta tu aceptación.' }, 'activa y verificada en ejecución; pendiente de tu aceptación.', 'activation');
  }
  batchesRepo(slug).update(id, x => { if (x.activation?.state === 'requested') { x.activation.state = 'done'; x.events.push({ at: now(), kind: 'activation', message: 'Activación completada y comprobada.' }); } });
}

function processesOf(slug: string, b: Batch) {
  const procs = processesRepo(slug);
  return b.items.flatMap(i => i.processIds).map(pid => procs.get(pid)).filter(Boolean) as Process[];
}
export function budgetOf(slug: string, b: Batch) {
  return batchBudget(b.auth, processesOf(slug, b).map(p => ({ spentUsd: p.spentUsd, unconfirmedUsd: p.unconfirmedUsd ?? 0, budgetUsd: p.budgetUsd ?? 0, running: p.status === 'running' })));
}
/** Llamadas a la suscripción de Claude Code hechas por las historias del lote (telemetría de llamadas). */
export function subscriptionCalls(slug: string, b: Batch): number {
  const ids = b.items.flatMap(i => i.processIds); if (!ids.length) return 0;
  return callMetricsRepo(slug).list({ processIds: ids }).filter(m => /Claude Code/i.test(m.backend ?? '')).length;
}

function startNext(slug: string, id: string) {
  for (;;) {
    const b = batchesRepo(slug).get(id)!; if (b.status !== 'running') return;
    const running = b.items.filter(i => i.state === 'running');
    if (running.length >= b.auth.concurrency) return;
    const next = b.items.filter(i => i.state === 'queued').sort((x, y) => x.order - y.order)[0]; if (!next) return;
    // Fuera del lote se mantiene «un proceso a la vez»: no se empieza mientras corre otro que no es del lote.
    const mine = new Set(b.items.flatMap(i => i.processIds));
    const foreign = processesRepo(slug).running().filter(p => !mine.has(p.id));
    if (foreign.length) { const reason = `Espera: hay otro proceso en ejecución fuera del lote (${foreign[0].title}).`; if (next.reason !== reason) setItem(slug, id, next.itemId, { reason }); return; }
    if (slug === INTERNAL_WORKSPACE.slug && b.auth.git.activate && b.items.some(i => i.state === 'integrating' && i.mergedCommit && !i.activated)) return;
    const budget = budgetOf(slug, b);
    if (!budget.canStart) {
      if (!running.length) setStatus(slug, id, 'paused', `El presupuesto restante del lote (${budget.remaining.toFixed(2)} USD de ${b.auth.totalBudgetUsd}) no cubre el tope de otra historia (${b.auth.perStoryBudgetUsd} USD). Lo hecho se conserva; amplía el presupuesto para seguir.`, 'budget');
      return;
    }
    const cc = subscriptionCalls(slug, b);
    if (cc >= b.auth.maxSubscriptionCalls && b.auth.backends.includes('claude_code')) {
      if (!running.length) setStatus(slug, id, 'paused', `Se alcanzó el tope de llamadas a la suscripción de Claude autorizado en el lote (${cc} de ${b.auth.maxSubscriptionCalls}). No se asume que la suscripción sea ilimitada: amplíalo para seguir.`, 'budget');
      return;
    }
    startItem(slug, id, next.itemId);
  }
}

/** Crea (o adopta la iteración preparada), autoriza con los límites del lote y ejecuta la historia con el pipeline. */
function startItem(slug: string, id: string, itemId: string) {
  const b = batchesRepo(slug).get(id)!; const it = b.items.find(i => i.itemId === itemId)!;
  const procs = processesRepo(slug);
  const needsOwner = (reason: string, pid?: string) => { if (pid) procs.finish(pid, 'cancelled', reason); setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'owner_decision', notStarted: true, reason, processId: pid ?? it.processId, processIds: pid ? [...it.processIds, pid] : it.processIds }, `no empieza: ${reason}`); };
  const adopted = it.nextProcessId ? procs.get(it.nextProcessId) : undefined;
  const reuse = adopted && adopted.status === 'pending_authorization' ? adopted : null;
  // La MISMA comprobación que la vista previa, ANTES de crear nada: cada agente con un origen autorizado en el lote y
  // listo para ejecutar (nunca se cambia a otro origen facturable). Si algo falla (el conector, el proyecto o un origen
  // cambiaron durante el lote), se pausa TODO el lote una vez, con el motivo y dónde corregirlo; «Reanudar» lo comprueba
  // otra vez. No se crea ningún proceso ni se llama a la IA.
  let members: { agentId: string; role?: string | null }[]; let gauntlet: GauntletConfig = b.auth.gauntlet;
  try {
    members = reuse ? reuse.steps.filter(s => s.status === 'pending').map(s => ({ agentId: s.agentId, role: s.role })) : estimateStory(slug, b.projectId, itemId, {}).steps.map(s => ({ agentId: s.agentId, role: s.role }));
    gauntlet = resolveGauntletFor(slug, { id: reuse?.id ?? '', projectId: b.projectId, backlogItemId: itemId, assignmentId: null }, b.auth.gauntlet);
    const evaluator = gauntlet.mode !== 'off' ? projectEvaluator(slug, b.projectId) : null;
    if (evaluator) members.push({ agentId: evaluator.id, role: 'evaluator' });
  } catch (e: any) { return needsOwner(`No se pudo preparar la historia: ${e?.message ?? e}`); }
  const bad = checkTeam(slug, b.projectId, members, b.auth).filter(t => !t.ready);
  if (bad.length) {
    const why = unique(bad.map(t => t.problem!)).join(' ');
    setItem(slug, id, itemId, { reason: `No ha empezado: ${why}` });
    setStatus(slug, id, 'paused', `No se empieza nada más: ${why} Corrígelo y pulsa «Reanudar»; no se ha creado ningún proceso ni se ha llamado a la IA.`, 'pause', bad.find(t => t.fix)?.fix ?? null);
    return;
  }
  let p: Process;
  try { p = reuse ?? createStoryProcess(slug, b.projectId, itemId, {}); }
  catch (e: any) { return needsOwner(`No se pudo preparar la historia: ${e?.message ?? e}`); }
  // Claude Code solo cede a la API si el lote lo autoriza (y el conector lo permite): si no, se pausa como siempre.
  const cfg = normalizePipeline({ autoApply: true, autoVerify: true, commands: b.auth.commands, allowInstall: b.auth.allowInstall, maxCorrections: b.auth.maxCorrections, gauntlet, backends: b.auth.backends, ...(b.auth.apiFallback && b.auth.backends.includes('api') ? {} : { apiFallback: false }) });
  procs.setResult(p.id, { ...procs.get(p.id)!.result!, pipeline: newPipeline(cfg) });
  syncEvaluatorStep(slug, p.id, cfg.gauntlet!);
  procs.authorize(p.id, b.auth.perStoryBudgetUsd);
  setItem(slug, id, itemId, { state: 'running', processId: p.id, processIds: [...it.processIds.filter(x => x !== p.id), p.id], nextProcessId: null, reason: null, failureClass: null, notStarted: false, startedAt: now(), finishedAt: null }, `empieza (proceso ${p.id.slice(0, 8)}, tope ${b.auth.perStoryBudgetUsd} USD, ${b.auth.maxCorrections} corrección(es), Gauntlet ${b.auth.gauntlet.mode}).`);
  procs.logExecution({ projectId: b.projectId, agentId: '', kind: `batch_story_started:${id}`, status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: now() });
  const run = batchDeps.runStory(slug, p.id, logger, () => isCancelled(p.id)).finally(() => { clearCancel(p.id); void scheduleTick(slug, id); });
  trackJob(p.id, run).catch(e => logger({ err: e?.message, processId: p.id }, 'lote: fallo inesperado de la historia'));
}

function maybeComplete(slug: string, id: string) {
  const b = batchesRepo(slug).get(id)!;
  if (batchMoving(b.items)) return;
  const waiting = b.items.filter(i => i.state === 'needs_owner' || i.state === 'awaiting_integration');
  const deps = b.items.filter(i => i.state === 'waiting_dependency');
  if (waiting.length || deps.length) {
    const reason = `Lo automático terminó; esperan tu decisión: ${[...waiting.map(i => `${i.storyId} (${ITEM_LABEL[i.state]})`), ...deps.map(i => `${i.storyId} (espera a ${i.dependsOn})`)].join(', ')}.`;
    if (b.reason !== reason) batchesRepo(slug).update(id, x => { x.reason = reason; x.events.push({ at: now(), kind: 'item', message: reason }); });
    return;
  }
  const s = batchSummary(b.items);
  setStatus(slug, id, 'completed', `Lote terminado: ${s.awaiting_acceptance} pendiente(s) de tu aceptación, ${s.accepted} aceptada(s), ${s.rejected} no aceptada(s), ${s.failed} fallida(s), ${s.blocked} bloqueada(s), ${s.cancelled} cancelada(s).`, 'completed');
}

// ---------------------------------------------------------------- Control del propietario

const controllable = (b: Batch) => { if (b.status === 'cancelled' || b.status === 'revoked') throw fail(409, `El lote está ${b.status === 'cancelled' ? 'cancelado' : 'revocado'}.`, 'closed'); };
export function getBatch(slug: string, id: string): Batch { const b = batchesRepo(slug).get(id); if (!b) throw fail(404, 'Lote no encontrado.', 'not_found'); return b; }

export function pauseBatch(slug: string, id: string): Batch {
  const b = getBatch(slug, id); controllable(b);
  if (b.status !== 'running') throw fail(409, 'El lote no está en marcha.', 'not_running');
  setStatus(slug, id, 'paused', 'Pausado por el propietario: no se empieza ni se integra nada más; lo que está en marcha termina su historia.', 'pause');
  return getBatch(slug, id);
}
/** Reanudar (autorizado): con presupuesto o tope de suscripción ampliados si se indican; la duración cuenta desde ahora. */
export function resumeBatch(slug: string, id: string, extra: { addBudgetUsd?: number; addSubscriptionCalls?: number } = {}): Batch {
  const b = getBatch(slug, id); controllable(b);
  if (b.status === 'running') throw fail(409, 'El lote ya está en marcha.', 'running');
  const procs = processesRepo(slug);
  batchesRepo(slug).update(id, x => {
    // Vuelven a la cola (y se comprueban otra vez) las que no llegaron a trabajar: no empezaron por permisos u orígenes, o
    // un motivo de todo el lote (límite de la suscripción, Claude Code no disponible) las detuvo sin trabajo que conservar.
    x.items.filter(i => i.state === 'needs_owner' && (i.notStarted || ((i.failureClass === 'subscription' || i.failureClass === 'environment') && retryable(i, i.processId ? procs.get(i.processId)?.status : null))))
      .forEach(i => { i.state = i.dependsInBatch ? 'waiting_dependency' : 'queued'; i.reason = 'Vuelve a la cola al reanudar (no tenía trabajo que conservar).'; i.failureClass = null; i.notStarted = false; });
    x.auth.totalBudgetUsd = Math.min(BATCH_LIMITS.maxTotalUsd, x.auth.totalBudgetUsd + Math.max(0, extra.addBudgetUsd ?? 0));
    x.auth.maxSubscriptionCalls = Math.min(BATCH_LIMITS.maxSubscriptionCalls, x.auth.maxSubscriptionCalls + Math.max(0, Math.floor(extra.addSubscriptionCalls ?? 0)));
    // La duración autorizada se concede otra vez desde la reanudación (nunca acumula tiempo sin límite).
    x.createdAt = now(); x.finishedAt = null;
    x.items.filter(i => i.state === 'awaiting_integration' && x.auth.git.merge).forEach(i => { i.state = 'integrating'; i.reason = 'Se integrará al reanudar el lote.'; });
  });
  setStatus(slug, id, 'running', null, 'resume');
  void scheduleTick(slug, id);
  return getBatch(slug, id);
}
function stopRunning(slug: string, b: Batch) {
  for (const it of b.items.filter(i => i.state === 'running' && i.processId)) { cancelProcess(it.processId!); abortProcessCalls(it.processId!); }
}
export function cancelBatch(slug: string, id: string): Batch {
  const b = getBatch(slug, id); controllable(b);
  stopRunning(slug, b);
  batchesRepo(slug).update(id, x => x.items.forEach(i => {
    if (['queued', 'waiting_dependency'].includes(i.state)) { i.state = 'cancelled'; i.reason = 'Cancelada con el lote antes de empezar.'; }
    if (i.state === 'needs_owner') { i.state = 'cancelled'; i.reason = `Cancelada con el lote mientras esperaba tu decisión (${i.reason ?? 'sin motivo'}). Lo hecho en su proceso se conserva.`; }
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
  }));
  setStatus(slug, id, 'revoked', `Autorización revocada por el propietario${reason ? `: ${reason}` : ''}. No se empieza, integra, activa ni publica nada más.`, 'revoke');
  processesRepo(slug).logExecution({ projectId: b.projectId, agentId: '', kind: `batch_revoked:${id}`, status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: now() });
  return getBatch(slug, id);
}
export function cancelItem(slug: string, id: string, itemId: string): Batch {
  const b = getBatch(slug, id); const it = b.items.find(i => i.itemId === itemId); if (!it) throw fail(404, 'La historia no está en el lote.', 'not_found');
  if (!['queued', 'waiting_dependency', 'running', 'needs_owner', 'blocked'].includes(it.state)) throw fail(409, `No se puede cancelar una historia ${ITEM_LABEL[it.state]}.`, 'invalid_state');
  if (it.state === 'running' && it.processId) { cancelProcess(it.processId); abortProcessCalls(it.processId); }
  setItem(slug, id, itemId, { state: 'cancelled', reason: 'Cancelada por el propietario.', finishedAt: now() }, 'cancelada por ti.');
  void scheduleTick(slug, id);
  return getBatch(slug, id);
}

/** Sin trabajo que conservar: su proceso no existe, se canceló al empezar o falló. Reintentar no repite nada hecho. */
export function retryable(it: Pick<BatchItem, 'state'>, processStatus: string | null | undefined): boolean {
  return (it.state === 'needs_owner' || it.state === 'failed') && (!processStatus || processStatus === 'cancelled' || processStatus === 'failed');
}

/** Reintentar UNA historia dentro del lote (mismos límites): vuelve a la cola y se comprueban otra vez su equipo y orígenes. */
export function retryItem(slug: string, id: string, itemId: string): Batch {
  const b = getBatch(slug, id); controllable(b);
  const it = b.items.find(i => i.itemId === itemId); if (!it) throw fail(404, 'La historia no está en el lote.', 'not_found');
  const p = it.processId ? processesRepo(slug).get(it.processId) : undefined;
  if (!retryable(it, p?.status)) throw fail(409, p && (it.state === 'needs_owner' || it.state === 'failed') ? 'Su proceso conserva trabajo en pausa: continúalo desde el proceso (no se repite lo hecho).' : `No se puede reintentar una historia ${ITEM_LABEL[it.state]}.`, 'invalid_state');
  setItem(slug, id, itemId, { state: it.dependsInBatch ? 'waiting_dependency' : 'queued', reason: b.status === 'running' ? null : 'En cola: empezará al reanudar el lote.', failureClass: null, notStarted: false, finishedAt: null }, `reintentada por ti: vuelve a la cola (se comprueban otra vez su equipo y sus orígenes).`);
  void scheduleTick(slug, id);
  return getBatch(slug, id);
}

// ---------------------------------------------------------------- Aceptación del propietario (distinta de QA)

export async function acceptItems(slug: string, id: string, itemIds: string[], note: string | null, checks: Record<string, boolean[]> = {}): Promise<Batch> {
  const b = getBatch(slug, id); const procs = processesRepo(slug);
  const items = itemIds.map(x => b.items.find(i => i.itemId === x));
  const wrong = items.filter(i => !i || i.state !== 'awaiting_acceptance');
  if (wrong.length) throw fail(409, `Solo se aceptan historias terminadas técnicamente: ${wrong.map(i => i ? `${i.storyId} está ${ITEM_LABEL[i.state]}` : 'una no está en el lote').join(' · ')}.`, 'not_ready');
  for (const it of items as BatchItem[]) {
    const p = procs.get(it.processId!)!;
    if (slug === INTERNAL_WORKSPACE.slug && !it.activated && p.result?.merged) {
      const st = await batchDeps.activation(p.result.merged.commit, p.result.merged.mergedAt);
      if (!st.active) throw fail(409, `${it.storyId} está integrada pero no activa en el Portal en marcha: ${st.reason}`, 'not_activated');
    }
    const steps = p.result?.manualTest?.steps ?? [];
    const c = checks[it.itemId];
    if (c && steps.length && (c.length !== steps.length || c.some(x => !x))) throw fail(409, `${it.storyId}: marca todos los pasos de la prueba o no la aceptes (usa «No aceptar» con los pasos que fallaron).`, 'checks_incomplete');
  }
  for (const it of items as BatchItem[]) {
    const p = procs.get(it.processId!)!; const at = now();
    const mt = p.result?.manualTest;
    procs.setResult(p.id, { ...p.result!, acceptance: { at, by: 'owner', batchId: id, note }, ...(mt && checks[it.itemId] ? { manualTest: { ...mt, checks: checks[it.itemId] } } : {}) });
    backlogRepo(slug).setStatus(it.itemId, 'done', p.id);
    procs.logExecution({ projectId: b.projectId, agentId: '', kind: `owner_acceptance:${it.storyId}`, status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: at });
    setItem(slug, id, it.itemId, { state: 'accepted', acceptance: { at, note, checks: checks[it.itemId] ?? null }, rejection: null }, `aceptada por ti${note ? `: ${note.slice(0, 200)}` : ''}.`, 'acceptance');
  }
  return getBatch(slug, id);
}

/** No aceptar: queda registrada con tus notas y cada paso que falló se convierte en una tarea de la historia. */
export function rejectItem(slug: string, id: string, itemId: string, input: { note: string; failedSteps?: string[] }): Batch {
  const b = getBatch(slug, id); const it = b.items.find(i => i.itemId === itemId);
  if (!it || (it.state !== 'awaiting_acceptance' && it.state !== 'accepted')) throw fail(409, 'Solo se puede no aceptar una historia terminada técnicamente (o reabrir una aceptada).', 'not_ready');
  const thread = threadRepo(slug);
  const taskIds = (input.failedSteps ?? []).map(s => s.trim()).filter(Boolean).slice(0, 20).map(s => thread.addTask({ backlogItemId: itemId, title: `Aceptación: ${s}`.slice(0, 300), assigneeAgentId: null, assigneeName: null }).id);
  thread.add({ backlogItemId: itemId, role: 'owner', agentId: null, agentName: null, content: `No aceptada en el lote «${b.title}»: ${input.note}${taskIds.length ? ` (${taskIds.length} tarea(s) creadas con los pasos que fallaron)` : ''}`, processId: it.processId, costUsd: 0, tokens: 0, proposals: null });
  if (it.state === 'accepted') backlogRepo(slug).setStatus(itemId, 'review', it.processId);
  setItem(slug, id, itemId, { state: 'rejected', rejection: { at: now(), note: input.note, failedSteps: input.failedSteps ?? [], taskIds }, reason: `No aceptada: ${input.note.slice(0, 300)}` }, `no aceptada por ti (${taskIds.length} tarea(s) creadas).`, 'acceptance');
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
export async function iterateItem(slug: string, id: string, itemId: string, note: string): Promise<Batch> {
  const b = getBatch(slug, id); controllable(b);
  const it = b.items.find(i => i.itemId === itemId);
  if (!it || !['rejected', 'needs_owner', 'failed', 'awaiting_acceptance', 'awaiting_integration'].includes(it.state)) throw fail(409, `Solo se itera una historia no aceptada, detenida o fallida${it ? ` (está ${ITEM_LABEL[it.state]})` : ''}.`, 'invalid_state');
  const { process } = await iterateStory(slug, itemId, note, { reopen: true, discardApplied: true });
  batchesRepo(slug).update(id, x => {
    const y = x.items.find(i => i.itemId === itemId)!;
    Object.assign(y, { state: 'queued', nextProcessId: process.id, reason: `Nueva iteración con tu nota: ${note.slice(0, 200)}`, failureClass: null, finishedAt: null, mergedCommit: null, activated: false });
    x.events.push({ at: now(), kind: 'item', itemId, message: `${y.storyId}: iteración dirigida preparada (proceso ${process.id.slice(0, 8)}); se ejecuta en su turno dentro de los límites del lote.` });
    if (x.status === 'completed') { x.status = 'running'; x.finishedAt = null; x.reason = null; }
  });
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
          const uncertain = p.steps.some(s => s.status === 'failed' && /^Interrumpido/.test(s.error ?? '') && (s.finishedAt ?? '') >= since);
          if (b.auth.autoResume && it.autoResumes < BATCH_LIMITS.maxAutoResumes && !uncertain) {
            procs.resume(p.id, Math.max(p.budgetUsd ?? 0, p.spentUsd));
            procs.setResult(p.id, { ...p.result!, pipeline: { ...pl, failures: [], startedAt: now() } });
            setItem(ws.slug, b.id, it.itemId, { autoResumes: it.autoResumes + 1, startedAt: now() }, 'interrumpida por un reinicio sin llamadas en curso: se retoma donde quedó (no se repite nada).', 'recovery');
            const run = batchDeps.resumeStory(ws.slug, p.id, log, () => isCancelled(p.id)).finally(() => { clearCancel(p.id); void scheduleTick(ws.slug, b.id); });
            trackJob(p.id, run).catch(e => log({ err: e?.message, processId: p.id }, 'lote: fallo inesperado al retomar'));
            n++;
            continue;
          }
          setItem(ws.slug, b.id, it.itemId, { state: 'needs_owner', failureClass: 'environment', reason: uncertain ? 'Interrumpida por un reinicio con una llamada en curso: su cobro (o uso de la suscripción) no está confirmado. No se reenvía sola: decide si continuar.' : 'Interrumpida por un reinicio y ya se retomó una vez sola: decide si continuar.' }, uncertain ? 'interrumpida con una llamada en curso: decides tú (no se reenvía sola).' : 'interrumpida otra vez: decides tú.', 'recovery');
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
    const p = it.processId ? procs.get(it.processId) : undefined; const r = p?.result;
    return {
      ...it, label: ITEM_LABEL[it.state],
      process: p ? { id: p.id, status: p.status, spentUsd: p.spentUsd, unconfirmedUsd: p.unconfirmedUsd ?? 0, budgetUsd: p.budgetUsd, pipeline: r?.pipeline ? { state: r.pipeline.state, phase: r.pipeline.phase, pauseKind: r.pipeline.pauseKind, reason: r.pipeline.reason, corrections: r.pipeline.corrections } : null, gauntlet: r?.gauntlet ? { mode: r.gauntlet.mode, status: r.gauntlet.status, rounds: r.gauntlet.rounds.length, reason: r.gauntlet.reason } : null, review: r?.review?.verdict ?? null, merged: r?.merged ?? null, manualTest: r?.manualTest ? { steps: r.manualTest.steps, checks: r.manualTest.checks } : null, userFacing: r?.userFacing ?? null, implementer: p.steps.find(s => s.role === 'implementer')?.agentName ?? null, evaluator: p.steps.find(s => s.role === 'evaluator' && s.status !== 'skipped')?.agentName ?? null } : null
    };
  });
  return { ...b, items, summary: batchSummary(b.items), budget: budgetOf(slug, b), subscriptionCalls: subscriptionCalls(slug, b) };
}

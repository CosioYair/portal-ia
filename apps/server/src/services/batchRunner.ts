import { BATCH_LIMITS, DEPENDENCY_BROKEN, DEPENDENCY_SATISFIED, INTERNAL_WORKSPACE, batchBudget, batchSummary, classifyStop, gauntletOverhead, normalizeGauntlet, normalizePipeline, planBatch, type Batch, type BatchAuthorization, type BatchItem, type BatchItemState, type Process, type RuntimeCheck, type RuntimeCheckResult } from '@portal-ia/domain';
import { batchesRepo } from '../db/batches.ts';
import { callMetricsRepo } from '../db/callMetrics.ts';
import { workspacesRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { isActiveJob, trackJob } from './activeJobs.ts';
import { cancelProcess, clearCancel, isCancelled } from './assessment.ts';
import { teamReadiness } from './claudeCode/backend.ts';
import { requirePolicy } from './executionPolicy.ts';
import { projectEvaluator, syncEvaluatorStep } from './gauntlet.ts';
import { abortProcessCalls } from './providerCalls.ts';
import { pushBranches } from './repoWrite.ts';
import { defaultChecks, runRuntimeChecks } from './runtimeChecks.ts';
import { createStoryProcess, estimateStory, runStory } from './storyExecution.ts';
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
  totalBudgetUsd: number; perStoryBudgetUsd: number;
  maxCorrections?: number; maxDurationMin?: number; maxSubscriptionCalls?: number;
  gauntlet?: { mode: 'off' | 'standard' | 'deep'; maxRounds?: number };
  concurrency?: number;
  commands?: ('typecheck' | 'test' | 'build')[]; allowInstall?: boolean;
  git?: { merge?: boolean; activate?: boolean; publish?: boolean };
  autoResume?: boolean;
  title?: string;
}

const clamp = (v: unknown, min: number, max: number, def: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
/** Normaliza la autorización: límites acotados (nunca «ilimitado»), publicación desactivada salvo que se pida. */
export function normalizeAuth(projectId: string, input: BatchInput): BatchAuthorization {
  const order = ['typecheck', 'test', 'build'] as const;
  return {
    projectId, itemIds: Array.from(new Set(input.itemIds)).slice(0, BATCH_LIMITS.maxItems),
    backends: Array.from(new Set(input.backends?.length ? input.backends : ['api', 'claude_code'])) as BatchAuthorization['backends'],
    totalBudgetUsd: clamp(input.totalBudgetUsd, 0.1, BATCH_LIMITS.maxTotalUsd, 1),
    perStoryBudgetUsd: clamp(input.perStoryBudgetUsd, 0.1, BATCH_LIMITS.maxPerStoryUsd, 1),
    maxCorrections: Math.floor(clamp(input.maxCorrections, 0, BATCH_LIMITS.maxCorrections, 3)),
    maxDurationMin: Math.floor(clamp(input.maxDurationMin, 5, BATCH_LIMITS.maxDurationMin, 240)),
    maxSubscriptionCalls: Math.floor(clamp(input.maxSubscriptionCalls, 0, BATCH_LIMITS.maxSubscriptionCalls, 60)),
    gauntlet: normalizeGauntlet(input.gauntlet ?? null),
    concurrency: Math.floor(clamp(input.concurrency, 1, BATCH_LIMITS.maxConcurrency, 1)),
    commands: order.filter(c => (input.commands ?? order).includes(c)),
    allowInstall: !!input.allowInstall,
    git: { merge: !!input.git?.merge, activate: !!input.git?.activate, publish: !!input.git?.publish },
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

/** Vista previa SIN guardar nada ni llamar a la IA: plan, estimación por historia, sobrecoste Gauntlet y avisos. */
export function previewBatch(slug: string, projectId: string, input: BatchInput) {
  const auth = normalizeAuth(projectId, input);
  const { selected, backlog } = selection(slug, projectId, auth.itemIds);
  const plan = planBatch(selected, backlog);
  const agents = agentsRepo(slug);
  const stories = plan.map(p => {
    let est: ReturnType<typeof estimateStory> | null = null; let error: string | null = null;
    try { est = estimateStory(slug, projectId, p.id, {}); } catch (e: any) { error = e.message; }
    const backends = Array.from(new Set((est?.steps ?? []).map(s => (agents.get(s.agentId)?.config.backend ?? 'api') as 'api' | 'claude_code')));
    return { ...p, estimatedUsd: est ? Number(est.estimatedUsd.toFixed(4)) : null, backends, disallowedBackends: backends.filter(b => !auth.backends.includes(b)), error };
  });
  const estimate = stories.reduce((s, x) => s + (x.estimatedUsd ?? 0), 0);
  const warnings: string[] = [];
  if (stories.some(s => s.blockedReason)) warnings.push(`${stories.filter(s => s.blockedReason).length} historia(s) bloqueada(s): no se ejecutarán (motivo en cada una).`);
  if (estimate > auth.totalBudgetUsd) warnings.push(`La estimación (${estimate.toFixed(2)} USD) supera el presupuesto total (${auth.totalBudgetUsd} USD): el lote se pausará al agotarlo.`);
  if (stories.some(s => (s.estimatedUsd ?? 0) > auth.perStoryBudgetUsd)) warnings.push('Alguna historia estima más que el tope por historia: se pausará al alcanzarlo.');
  if (stories.some(s => s.disallowedBackends.length)) warnings.push('Alguna historia usa un origen de ejecución que no autorizas en el lote: no empezará (no se cambia de origen).');
  if (auth.gauntlet.mode !== 'off' && !projectEvaluator(slug, projectId)) warnings.push('Gauntlet activado sin Evaluador en el proyecto: se aplicarán la verificación y QA de siempre.');
  if (auth.git.activate && slug !== INTERNAL_WORKSPACE.slug) warnings.push('La activación (reconstruir y reiniciar) solo aplica al propio Portal: se ignora en este proyecto.');
  if (auth.concurrency > 1) warnings.push('Con historias en paralelo, la integración y la activación siguen siendo de una en una; las que tocan los mismos archivos pueden necesitar resolver conflictos.');
  return { auth, plan: stories, estimateUsd: Number(estimate.toFixed(4)), gauntletOverheadPerStory: gauntletOverhead(auth.gauntlet), warnings };
}

/** Autorización explícita y persistida del lote: desde aquí y solo desde aquí el coordinador actúa por su cuenta. */
export function createBatch(slug: string, projectId: string, input: BatchInput): Batch {
  const auth = normalizeAuth(projectId, input);
  const { selected, backlog } = selection(slug, projectId, auth.itemIds);
  const repo = batchesRepo(slug);
  const open = repo.active().find(b => b.projectId === projectId);
  if (open) throw fail(409, `Ya hay un lote activo en este proyecto («${open.title}»): termínalo, cancélalo o revócalo antes de autorizar otro.`, 'batch_active');
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
function setStatus(slug: string, id: string, status: Batch['status'], reason: string | null, kind: 'pause' | 'resume' | 'cancel' | 'revoke' | 'completed' | 'budget') {
  batchesRepo(slug).update(id, b => {
    b.status = status; b.reason = reason;
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
  const c = classifyStop(pl?.pauseKind, p.status);
  const reason = pl?.reason ?? p.error ?? 'El pipeline se detuvo.';
  setItem(slug, id, it.itemId, { state: p.status === 'failed' ? 'failed' : 'needs_owner', failureClass: c.cls, reason, finishedAt: now() }, `${p.status === 'failed' ? 'falló' : 'se detuvo'} (${c.cls}): ${reason.slice(0, 300)}${c.batchWide ? '' : ' Las historias independientes siguen.'}`);
  // El mismo motivo detendría a las demás (límite de la suscripción, sandbox caído): se pausa todo el lote.
  if (c.batchWide) setStatus(slug, id, 'paused', `${it.storyId} se detuvo por un motivo que afecta a todo el lote (${c.cls === 'subscription' ? 'límite de la suscripción de Claude' : 'entorno de verificación'}): ${reason.slice(0, 300)} No se empieza nada más hasta que lo resuelvas y reanudes.`, 'pause');
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
  const needsOwner = (reason: string, pid?: string) => { if (pid) procs.finish(pid, 'cancelled', reason); setItem(slug, id, itemId, { state: 'needs_owner', failureClass: 'owner_decision', reason, processId: pid ?? it.processId, processIds: pid ? [...it.processIds, pid] : it.processIds }, `no empieza: ${reason}`); };
  let p: Process;
  try {
    const adopted = it.nextProcessId ? procs.get(it.nextProcessId) : undefined;
    p = adopted && adopted.status === 'pending_authorization' ? adopted : createStoryProcess(slug, b.projectId, itemId, {});
  } catch (e: any) { return needsOwner(`No se pudo preparar la historia: ${e?.message ?? e}`); }
  const cfg = normalizePipeline({ autoApply: true, autoVerify: true, commands: b.auth.commands, allowInstall: b.auth.allowInstall, maxCorrections: b.auth.maxCorrections, gauntlet: b.auth.gauntlet });
  procs.setResult(p.id, { ...procs.get(p.id)!.result!, pipeline: newPipeline(cfg) });
  syncEvaluatorStep(slug, p.id, cfg.gauntlet!);
  // El equipo de la historia solo usa orígenes autorizados en el lote; nunca se cambia a otro facturable.
  const agents = agentsRepo(slug);
  const used = Array.from(new Set(procs.get(p.id)!.steps.filter(s => s.status === 'pending').map(s => (agents.get(s.agentId)?.config.backend ?? 'api') as 'api' | 'claude_code')));
  const bad = used.filter(x => !b.auth.backends.includes(x));
  if (bad.length) return needsOwner(`El equipo usa un origen de ejecución no autorizado en el lote (${bad.join(', ')}). Cambia el origen del agente o autoriza otro lote.`, p.id);
  const readiness = teamReadiness(slug, p.id);
  if (readiness && !readiness.ready && readiness.fallback !== 'api') return needsOwner(`El equipo no puede ejecutar: ${readiness.team.find(t => !t.ready)?.reason ?? 'backend no disponible'}`, p.id);
  procs.authorize(p.id, b.auth.perStoryBudgetUsd);
  setItem(slug, id, itemId, { state: 'running', processId: p.id, processIds: [...it.processIds.filter(x => x !== p.id), p.id], nextProcessId: null, reason: null, failureClass: null, startedAt: now(), finishedAt: null }, `empieza (proceso ${p.id.slice(0, 8)}, tope ${b.auth.perStoryBudgetUsd} USD, ${b.auth.maxCorrections} corrección(es), Gauntlet ${b.auth.gauntlet.mode}).`);
  procs.logExecution({ projectId: b.projectId, agentId: '', kind: `batch_story_started:${id}`, status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: now() });
  const run = batchDeps.runStory(slug, p.id, logger, () => isCancelled(p.id)).finally(() => { clearCancel(p.id); void scheduleTick(slug, id); });
  trackJob(p.id, run).catch(e => logger({ err: e?.message, processId: p.id }, 'lote: fallo inesperado de la historia'));
}

function maybeComplete(slug: string, id: string) {
  const b = batchesRepo(slug).get(id)!;
  if (b.items.some(i => ['queued', 'waiting_dependency', 'running', 'integrating'].includes(i.state))) return;
  const waiting = b.items.filter(i => i.state === 'needs_owner' || i.state === 'awaiting_integration');
  if (waiting.length) {
    const reason = `Lo automático terminó; esperan tu decisión: ${waiting.map(i => i.storyId).join(', ')}.`;
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
  batchesRepo(slug).update(id, x => {
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
  batchesRepo(slug).update(id, x => x.items.filter(i => ['queued', 'waiting_dependency'].includes(i.state)).forEach(i => { i.state = 'cancelled'; i.reason = 'Cancelada con el lote antes de empezar.'; }));
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

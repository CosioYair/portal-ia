import fs from 'node:fs';
import path from 'node:path';
import { backendLabel, batchSourceOf, promptSections, verificationsForApplied } from '@portal-ia/domain';
import type { Agent, AgentBlocker, AgentFailureKind, LiveCall, OwnerRequest, BacklogItem, DevOutputAssessment, ExecutionResult, ModelInfo, PipelineConfig, PipelineEvent, PipelineEventKind, PipelinePauseKind, PipelinePhase, PipelineStatus, Process, ProcessFailure, ProposedChange, ProviderId, StoryPlan, TeamRole, VerificationRun } from '@portal-ia/domain';
import { costUsd, estimatePricing, estimateTokens, getAdapter, ProviderRequestError, reasoningHeadroom } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';
import { practicesFor } from './agentTemplates.ts';
import { assessDeveloperOutput, clip, failureClassOf, mergeChanges, type ParsedDevOutput } from './devOutput.ts';
import { diagnosticsFor, filesIn } from './diagnostics.ts';
import { failingTests, testRunSummary } from './failureDiagnosis.ts';
import { requirePolicy } from './executionPolicy.ts';
import { backoffMs, callTimeoutMs, isTransient, maxProviderRetries, maybeBilled, providerFailureClass, registerCall, sleepAbortable, unregisterCall, withWatchdog } from './providerCalls.ts';
import { injectLessons, recordDetections } from './lessons.ts';
import { gauntletStage, toCorrection } from './gauntlet.ts';
import { callMetricsRepo, promptHash } from '../db/callMetrics.ts';
import { actionableFindings, enforceQaGate, parseQaVerdict, QA_VERDICT_SCHEMA, qaEvidencePrompt, rejectionSignature, testsEvidence, verificationEvidence } from './qaGate.ts';
/** Veredicto de QA con salida estructurada nativa del proveedor (si la admite); el motor lo valida igualmente. */
const QA_SCHEMA = { name: 'veredicto_qa', description: 'Veredicto de la puerta de calidad con hallazgos y evidencia.', schema: QA_VERDICT_SCHEMA as unknown as Record<string, unknown> };
import { annotateChanges, applyChanges, changesSinceBase, checkStaleChanges, commitInWorktree, git, readRepoFile, safeRelPath, type RawChange } from './repoWrite.ts';
import { DEPS_MISSING_EXIT } from './sandbox.ts';
import { DEV_MAX_TOKENS, FILE_FORMAT, PATCH_ONLY_FORMAT, sys } from './storyPrompts.ts';
import { runVerification, sandboxDeps } from './verification.ts';
import { driftMessage, worktreeDrift } from './worktreeDrift.ts';
import { agentBackend, claudeCodeComplete, claudeCodeGate, usesClaudeCode } from './claudeCode/backend.ts';
import { lastDetection } from './claudeCode/detect.ts';
import { getClaudeCodeSettings } from './claudeCode/settings.ts';
import { monotonicNow } from '../clock.ts';

/**
 * Pipeline autónomo autorizado de una historia (sin supervisión del propietario entre pasos rutinarios).
 *
 * Con la autorización del proceso (presupuesto + `PipelineConfig`), el equipo:
 *  1. convierte la entrega del Desarrollador en cambios (recuperación local sin IA; si no basta, una reparación acotada
 *     del MISMO Desarrollador con su respuesta anterior, sin repetir el plan);
 *  2. aplica los cambios en el worktree aislado del proceso;
 *  3. verifica en el sandbox (typecheck, test, build), resolviendo el entorno sin IA (instalar dependencias si está
 *     autorizado; pausa si falta Docker);
 *  4. QA evalúa la evidencia real (diff + resultados) con veredicto estructurado; la verificación automática prevalece;
 *  5. si algo falla en el código, correcciones acotadas del Desarrollador con los diagnósticos, y vuelta a verificar;
 *  6. se detiene cuando QA aprueba («lista para revisión del propietario») o al llegar a un límite, sin integrar,
 *     reiniciar ni publicar nunca: eso sigue siendo decisión del propietario.
 * Antes de cada llamada a la IA se comprueba que el presupuesto restante alcanza; si no, se pausa SIN llamar.
 * Todo queda registrado: cada intento es un paso con su modelo, tokens y costo, y un evento legible.
 */
const now = monotonicNow;
export const isTruncatedStop = (stop: string | null | undefined) => stop === 'max_tokens' || stop === 'length';

export class PipelinePause extends Error { constructor(public kind: PipelinePauseKind, message: string, public providerCode: string | null = null) { super(message); } }
export class StoryFailure extends Error { constructor(public failure: ProcessFailure) { super(failure.detail); } }

// ---------------------------------------------------------------- Llamadas a agentes

export interface CallResult { text: string; stopReason: string | null; inputTokens: number; outputTokens: number; costUsd: number; refusal?: string | null }

/** Razonamiento oculto que el modelo del agente puede facturar además del texto (Opus 5.5: siempre activo). */
export function agentHeadroom(agent: Agent): number {
  let supports = false;
  try { const row = providersRepo.get(agent.config.provider as ProviderId); supports = !!(JSON.parse(row?.models_json ?? '[]') as ModelInfo[]).find(m => m.id === agent.config.model)?.supportsEffort; } catch { /* sin catálogo */ }
  return reasoningHeadroom(agent.config.provider, agent.config.model, agent.config.effort, supports);
}
/**
 * Lo que se exige que quede de presupuesto antes de una llamada: la entrada más la mitad de la salida máxima, contando
 * también el margen del razonamiento oculto (criterio único del Portal; antes se ignoraba y la estimación se quedaba corta).
 */
export function estimateCallUsd(agent: Agent, system: string, user: string, maxTokens: number, route?: 'api' | 'claude-code'): number {
  // Claude Code con la suscripción no descuenta del presupuesto de API (si no está disponible, la alternativa por API se comprueba aparte).
  if ((route ?? (usesClaudeCode(agent) ? 'claude-code' : 'api')) === 'claude-code') return 0;
  const p = estimatePricing(agent.config.provider, agent.config.model);
  return (estimateTokens(system + user) * p.inPerM + (maxTokens + agentHeadroom(agent)) * p.outPerM * 0.5) / 1_000_000;
}

export function budgetCheck(slug: string, processId: string, agent: Agent, system: string, user: string, maxTokens: number, route?: 'api' | 'claude-code'): { ok: boolean; needed: number; remaining: number } {
  const cur = processesRepo(slug).get(processId)!;
  // Lo no confirmado (llamadas abortadas o interrumpidas que pudieron facturarse) cuenta como gastado: criterio prudente.
  const needed = estimateCallUsd(agent, system, user, maxTokens, route); const remaining = cur.budgetUsd - cur.spentUsd - (cur.unconfirmedUsd ?? 0);
  return { ok: needed <= remaining, needed, remaining };
}

/** Sistema del paso con sus lecciones validadas y prácticas, inyectadas una sola vez por paso (lo reutilizan sus llamadas). */
function stepSystem(slug: string, proc: Process, stepId: string, agent: Agent, system0: string, injected: Map<string, string>): string {
  if (!injected.has(stepId)) {
    const role = (proc.steps.find(s => s.id === stepId)!.role ?? 'implementer') as TeamRole;
    injected.set(stepId, injectLessons(slug, stepId, system0, { projectId: proc.projectId, role, tags: [] }, practicesFor(slug, agent)).system);
  }
  return injected.get(stepId)!;
}

/** ¿El agente usa un origen que el lote de este proceso no autoriza? (p. ej. lo cambiaron a la API a mitad de la historia). */
export function originBlocked(proc: Process, agent: Agent): string | null {
  const allowed = proc.result?.pipeline?.config.backends;
  if (!allowed?.length || allowed.includes(batchSourceOf(agentBackend(agent)))) return null;
  return `«${agent.config.name}» usa ahora ${backendLabel(agentBackend(agent), null, agent.config.provider)} y el lote de esta historia no autoriza ese origen: no se ha hecho la llamada. Devuelve el agente a su origen anterior y continúa la historia desde su proceso.`;
}
const originFailure = (msg: string) => Object.assign(new Error(msg), { failure: { kind: 'provider', class: 'PERMISSION_REQUIRED', providerCode: 'origin_not_allowed', detail: msg } satisfies ProcessFailure });

/**
 * ¿Puede Claude Code ceder a la API en este proceso? Solo si el propietario lo autorizó en el conector, el proveedor
 * está conectado y el proceso no lo prohíbe (un lote que no autoriza la API fija `apiFallback: false`).
 */
export function apiFallbackFor(proc: Process, agent: Agent): boolean {
  const providerId = agent.config.provider as ProviderId;
  return getClaudeCodeSettings().fallback === 'api' && proc.result?.pipeline?.config.apiFallback !== false
    && !!providersRepo.credential(providerId) && providersRepo.get(providerId)?.status === 'connected';
}

/**
 * Lo máximo que una llamada del paso puede descontar del presupuesto antes de enviarla: con el sistema que recibirá de
 * verdad (lecciones incluidas) y, si Claude Code puede ceder a la API (alternativa autorizada en el conector), al precio
 * de la API. Sirve para decidir si varias llamadas caben a la vez.
 */
export function worstCaseCallUsd(slug: string, processId: string, stepId: string, system0: string, user: string, maxTokens: number, injected: Map<string, string>): number {
  const proc = processesRepo(slug).get(processId)!; const agent = agentsRepo(slug).get(proc.steps.find(s => s.id === stepId)!.agentId)!;
  const system = stepSystem(slug, proc, stepId, agent, system0, injected);
  return estimateCallUsd(agent, system, user, maxTokens, usesClaudeCode(agent) && !apiFallbackFor(proc, agent) ? 'claude-code' : 'api');
}

export interface CallOptions {
  history?: { role: 'user' | 'assistant'; content: string }[];
  injected: Map<string, string>;
  log: (o: any, m: string) => void;
  schema?: { name: string; description?: string; schema: Record<string, unknown> };
  /** Plazo fijo de la llamada (s); por defecto se calcula de la salida máxima (providerCalls.callTimeoutMs). */
  timeoutSec?: number | null;
  /** Reintentos por errores de conexión (por defecto 2). */
  retries?: number | null;
  /** Qué es esta llamada dentro del paso (p. ej. «Continuación 1: la respuesta anterior se cortó por longitud»). */
  operation?: string | null;
  /** Orígenes del contexto entregado y su tamaño (telemetría: qué recibió de verdad el agente). */
  context?: { source: string; chars: number }[];
}

/**
 * Una llamada de un paso (con lecciones validadas y prácticas inyectadas, registro de tokens/costo y política).
 * Con `history` (continuación) acumula en el mismo paso. Lanza `{ budget: true }` si el presupuesto no alcanza.
 * La llamada tiene plazo y se aborta de verdad al cancelar; el estado real (enviada, esperando, recibiendo…) queda en el
 * paso para la interfaz. Los errores de conexión se reintentan con espera exponencial; un plazo agotado no.
 */
export async function callAgentStep(slug: string, processId: string, stepId: string, system0: string, user: string, maxTokens: number, opts: CallOptions): Promise<CallResult> {
  const enteredAt = Date.now();
  const procs = processesRepo(slug); const proc = procs.get(processId)!;
  const step = proc.steps.find(s => s.id === stepId)!; const agent = agentsRepo(slug).get(step.agentId)!;
  const blocked = originBlocked(proc, agent); if (blocked) throw originFailure(blocked);
  const system = stepSystem(slug, proc, stepId, agent, system0, opts.injected);
  const providerId = agent.config.provider as ProviderId;
  const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
  const apiConnected = !!cred && prow.status === 'connected';
  // Backend de ejecución (conector Claude Code): sin cambio silencioso a un origen facturable. La API solo sustituye a
  // Claude Code si el propietario lo autorizó en los ajustes del conector, y entonces con su presupuesto de siempre.
  let route: 'api' | 'claude-code' = usesClaudeCode(agent) ? 'claude-code' : 'api';
  let fallbackReason: string | null = null;
  const apiFallbackAllowed = () => apiConnected && apiFallbackFor(processesRepo(slug).get(processId)!, agent);
  if (route === 'claude-code') {
    const g = claudeCodeGate(slug, agent, proc.projectId);
    if (!g.ok && apiFallbackAllowed()) { route = 'api'; fallbackReason = g.reason; }
    else if (!g.ok) throw Object.assign(new Error(g.reason), { failure: { kind: 'provider', class: 'PERMISSION_REQUIRED', providerCode: 'backend_unavailable', detail: g.reason } satisfies ProcessFailure });
  }
  const requireApi = () => {
    if (!apiConnected) throw Object.assign(new Error(`El proveedor ${providerId} no está conectado.`), { failure: { kind: 'provider', class: 'PERMISSION_REQUIRED', providerCode: 'no_credential', detail: `El proveedor ${providerId} no está conectado: conéctalo en Proveedores.` } satisfies ProcessFailure });
    const b = budgetCheck(slug, processId, agent, system, user, maxTokens, 'api');
    if (!b.ok) throw Object.assign(new Error(`Presupuesto insuficiente para «${step.title}» (gastado ${proc.spentUsd.toFixed(2)} de ${proc.budgetUsd.toFixed(2)} USD${proc.unconfirmedUsd ? ` + ${proc.unconfirmedUsd.toFixed(2)} sin confirmar` : ''}; esta llamada necesita ≈ ${b.needed.toFixed(2)} USD).`), { budget: true, needed: b.needed, remaining: b.remaining, failure: { kind: 'budget', class: 'BUDGET_EXHAUSTED', detail: 'Presupuesto insuficiente para la siguiente llamada.' } satisfies ProcessFailure });
  };
  if (route === 'api') requireApi();
  const models: ModelInfo[] = (() => { try { return JSON.parse(prow.models_json); } catch { return []; } })();
  // El plazo cuenta la salida que la llamada puede facturar de verdad: texto pedido + margen del razonamiento oculto.
  const headroom = agentHeadroom(agent);
  const apiTimeoutMs = headroom ? callTimeoutMs(maxTokens + headroom, 'low', opts.timeoutSec) : callTimeoutMs(maxTokens, agent.config.effort, opts.timeoutSec);
  const ccTimeoutMs = getClaudeCodeSettings().maxDurationSec * 1000;
  let timeoutMs = route === 'claude-code' ? ccTimeoutMs : apiTimeoutMs;
  const maxAttempts = 1 + maxProviderRetries(opts.retries);
  const inTok = estimateTokens(system + user + (opts.history ?? []).map(h => h.content).join(''));
  const p = estimatePricing(providerId, agent.config.model);
  const apiEstimate = (inTok * p.inPerM + (maxTokens + headroom) * p.outPerM * 0.5) / 1_000_000;
  const now0 = new Date();
  // Con la suscripción no hay cargo en USD que estimar: la ejecución no descuenta del presupuesto de API.
  const ccLive = (): Partial<LiveCall> => ({ provider: backendLabel(agentBackend(agent), lastDetection()?.billing), estimatedUsd: 0, inputUsd: 0 });
  let live: LiveCall = { state: 'preparing', provider: providerId, model: agent.config.model, startedAt: now0.toISOString(), lastEvent: 'Preparando la solicitud', lastEventAt: now0.toISOString(), deadlineAt: new Date(now0.getTime() + timeoutMs).toISOString(), timeoutMs, attempt: 1, maxAttempts, estimatedUsd: apiEstimate, inputTokensEstimated: inTok, inputUsd: costUsd(providerId, agent.config.model, inTok, 0), maxOutputTokens: maxTokens + headroom, operation: opts.operation ?? null, ...(route === 'claude-code' ? ccLive() : {}) };
  const setLive = (patch: Partial<LiveCall>) => { live = { ...live, ...patch }; try { procs.setStepLive(step.id, live); } catch { /* el estado en vivo nunca rompe la llamada */ } };
  procs.stepStart(step.id); setLive({});
  // Telemetría: una fila por llamada (espera al modelo frente a preparación del Portal, tokens, turnos, herramientas).
  const hash = promptHash(system, user); let firstSent: number | null = null;
  const metric = (status: 'done' | 'failed', attempt: number, sentMs: number, d: { tokensIn: number; tokensOut: number; cacheReadTokens: number | null; turns: number | null; tools: Record<string, number> | null; backend: string | null }, errorClass: string | null) => callMetricsRepo(slug).record({
    processId, stepId, agentId: agent.id, role: step.role ?? null, operation: opts.operation ?? step.title.slice(0, 120), backend: d.backend, model: agent.config.model, attempt, status,
    startedAt: new Date(enteredAt).toISOString(), finishedAt: new Date().toISOString(), waitMs: Date.now() - sentMs, buildMs: Math.max(0, (firstSent ?? sentMs) - enteredAt),
    systemChars: system.length, promptChars: user.length + (opts.history ?? []).reduce((a, h) => a + h.content.length, 0), context: opts.context ?? promptSections(user),
    tokensIn: d.tokensIn, tokensOut: d.tokensOut, cacheReadTokens: d.cacheReadTokens, turns: d.turns, tools: d.tools, promptHash: hash, errorClass
  });
  const startedAt = now0.toISOString();
  // Registro del ciclo de vida (sin prompts ni respuestas): qué, a quién, cuándo, cuánto tardó y cómo terminó.
  const who = { processId, step: step.title, operation: opts.operation ?? undefined, provider: providerId, model: agent.config.model };
  for (let attempt = 1; ; attempt++) {
    const ctrl = registerCall(processId);
    const sentAt = new Date(); firstSent ??= sentAt.getTime();
    const ms = () => Date.now() - sentAt.getTime();
    setLive({ state: 'sending', attempt, lastEvent: attempt > 1 ? `Reenviando la solicitud (intento ${attempt} de ${maxAttempts})` : 'Enviando la solicitud al proveedor', lastEventAt: sentAt.toISOString(), deadlineAt: new Date(sentAt.getTime() + timeoutMs).toISOString() });
    opts.log({ ...who, attempt, maxAttempts, timeoutMs, inputTokensEstimated: inTok, maxOutputTokens: maxTokens, route }, 'llamada al proveedor: enviando');
    try {
      requirePolicy('ai_call', { slug, processId, agentId: agent.id, projectId: proc.projectId, authorized: true });
      const request = { model: agent.config.model, system, user, maxTokens, effort: agent.config.effort, supportsEffort: !!models.find(m => m.id === agent.config.model)?.supportsEffort, history: opts.history, responseSchema: opts.schema, timeoutMs };
      let res: { text: string; inputTokens: number; outputTokens: number; stopReason: string | null; refusal?: string | null; numTurns?: number | null; cacheReadTokens?: number; tools?: Record<string, number> };
      let cost: number; let backend: string | null = null;
      if (route === 'claude-code') {
        // Suscripción: 0 USD del presupuesto de API. El uso (tokens, turnos, duración, equivalente estimado) va al registro del conector.
        const cc = await withWatchdog(claudeCodeComplete({ slug, projectId: proc.projectId, processId, stepId, agent, role: step.role ?? null, title: step.title }, request, ctrl.signal, setLive), ctrl, timeoutMs);
        res = cc; cost = 0; backend = cc.backendLabel;
      } else {
        res = await withWatchdog(getAdapter(providerId)!.complete(decryptSecret(cred!.ciphertext), { workspaceId: prow.workspace_id }, {
          ...request,
          onProgress: e => {
            setLive(e === 'sent' ? { state: 'waiting', lastEvent: 'Solicitud enviada; esperando la respuesta del proveedor', lastEventAt: new Date().toISOString() }
              : e === 'headers' ? { state: 'receiving', lastEvent: 'El proveedor empezó a responder', lastEventAt: new Date().toISOString() }
              : { state: 'processing', lastEvent: 'Respuesta recibida; procesándola', lastEventAt: new Date().toISOString() });
            if (e !== 'sent') opts.log({ ...who, attempt, ms: ms() }, e === 'headers' ? 'llamada al proveedor: cabeceras recibidas' : 'llamada al proveedor: respuesta completa');
          }
        }, ctrl.signal), ctrl, timeoutMs);
        cost = costUsd(providerId, agent.config.model, res.inputTokens, res.outputTokens);
        if (fallbackReason) backend = `${backendLabel('api', null, providerId)} (alternativa autorizada a Claude Code)`;
      }
      const prev = procs.get(processId)!.steps.find(s => s.id === stepId)!;
      // Un paso puede necesitar varias llamadas (continuación de una respuesta cortada): acumulamos.
      const acc = opts.history?.length ? prev : { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      procs.stepFinish(step.id, 'done', { tokensIn: acc.inputTokens + res.inputTokens, tokensOut: acc.outputTokens + res.outputTokens, cost: acc.costUsd + cost, outputMd: opts.history?.length ? `${opts.history.filter(h => h.role === 'assistant').map(h => h.content).join('')}${res.text}` : res.text, backend });
      procs.addUsage(processId, res.inputTokens, res.outputTokens, cost);
      procs.logExecution({ projectId: proc.projectId, agentId: agent.id, kind: 'story_step', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
      opts.log({ ...who, attempt, ms: ms(), tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost: cost.toFixed(4), stop: res.stopReason, backend }, 'paso completado');
      metric('done', attempt, sentAt.getTime(), { tokensIn: res.inputTokens, tokensOut: res.outputTokens, cacheReadTokens: route === 'claude-code' ? res.cacheReadTokens ?? null : null, turns: res.numTurns ?? null, tools: res.tools ?? null, backend: backend ?? backendLabel('api', null, providerId) }, null);
      return { text: res.text, stopReason: res.stopReason, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: cost, refusal: res.refusal ?? null };
    } catch (e) {
      const err = e instanceof ProviderRequestError ? e.error : null;
      // Claude Code no disponible o límite de la suscripción: la API solo si el propietario la autorizó como alternativa.
      if (route === 'claude-code' && (err?.code === 'usage_limit' || err?.code === 'backend_unavailable') && apiFallbackAllowed()) {
        unregisterCall(processId, ctrl);
        route = 'api'; fallbackReason = err.message; timeoutMs = apiTimeoutMs;
        opts.log({ ...who, code: err.code }, 'Claude Code no disponible: alternativa autorizada por el propietario (API del proveedor)');
        try { requireApi(); } catch (b) {
          const prev = procs.get(processId)!.steps.find(s => s.id === stepId)!;
          procs.stepFinish(step.id, 'failed', { tokensIn: prev.inputTokens, tokensOut: prev.outputTokens, cost: prev.costUsd, outputMd: prev.outputMd, error: (b as Error).message });
          throw b;
        }
        setLive({ provider: providerId, estimatedUsd: apiEstimate, inputUsd: costUsd(providerId, agent.config.model, inTok, 0), lastEvent: `Claude Code no disponible (${err.message}). Se usa la API del proveedor porque lo autorizaste como alternativa.`, lastEventAt: new Date().toISOString() });
        continue;
      }
      // Reintento acotado solo para errores de conexión (sin respuesta útil), con espera exponencial y cancelable.
      if (isTransient(e) && attempt < maxAttempts && !ctrl.signal.aborted) {
        const wait = backoffMs(attempt);
        setLive({ state: 'retrying', lastEvent: `${err?.message ?? 'Error de conexión'} · reintento ${attempt + 1} de ${maxAttempts} en ${Math.round(wait / 1000)} s`, lastEventAt: new Date().toISOString() });
        opts.log({ step: step.title, attempt, wait, code: err?.code }, 'error transitorio del proveedor: reintento');
        try { updateResult(slug, processId, r => r.pipeline ? { ...r, pipeline: { ...r.pipeline, providerRetries: (r.pipeline.providerRetries ?? 0) + 1 } } : r); } catch { /* sin resultado */ }
        unregisterCall(processId, ctrl);
        const waitCtrl = registerCall(processId);
        await sleepAbortable(wait, waitCtrl.signal);
        const cancelledWhileWaiting = waitCtrl.signal.aborted; unregisterCall(processId, waitCtrl);
        if (!cancelledWhileWaiting) continue;
        e = new ProviderRequestError({ code: 'cancelled', message: 'Cancelado mientras esperaba para reintentar.' });
      }
      const cls = providerFailureClass(e);
      const finalErr = e instanceof ProviderRequestError ? e.error : err;
      let msg = finalErr ? finalErr.message : (e as Error).message;
      // Lo que pudo facturarse sin confirmación del proveedor se guarda aparte del gasto confirmado (estimación de la entrada).
      // Con Claude Code (suscripción) no hay cargo en USD posible que registrar como «sin confirmar».
      const billed = route === 'api' && maybeBilled(e); const estCost = billed ? costUsd(providerId, agent.config.model, inTok, 0) : 0;
      if (billed) msg += ` Posible costo NO confirmado por el proveedor: ≈ ${estCost.toFixed(4)} USD (estimación de la entrada enviada).`;
      opts.log({ ...who, attempt, ms: ms(), code: finalErr?.code ?? null, httpStatus: finalErr?.httpStatus ?? null, class: cls.kind, billed }, finalErr?.code === 'cancelled' ? 'llamada al proveedor: cancelada' : finalErr?.code === 'timeout' ? 'llamada al proveedor: plazo agotado' : 'llamada al proveedor: fallida');
      // Lo ya confirmado en este paso (llamadas anteriores de una continuación) se conserva: uso, costo y salida parcial.
      const prev = procs.get(processId)!.steps.find(s => s.id === stepId)!;
      // Una ejecución de Claude Code sin respuesta útil (turnos agotados) consumió la suscripción: su uso se registra en el
      // paso (0 USD de la API), no se presenta como «0 tokens».
      const u = (e as any)?.usage as { inputTokens: number; outputTokens: number } | undefined;
      procs.stepFinish(step.id, 'failed', { tokensIn: prev.inputTokens + (u?.inputTokens ?? 0), tokensOut: prev.outputTokens + (u?.outputTokens ?? 0), cost: prev.costUsd, outputMd: prev.outputMd, error: msg, backend: route === 'claude-code' ? backendLabel(agentBackend(agent), lastDetection()?.billing) : null });
      if (u) procs.addUsage(processId, u.inputTokens, u.outputTokens, 0);
      metric('failed', attempt, sentAt.getTime(), { tokensIn: u?.inputTokens ?? 0, tokensOut: u?.outputTokens ?? 0, cacheReadTokens: null, turns: (u as any)?.numTurns ?? null, tools: (u as any)?.tools ?? null, backend: route === 'claude-code' ? backendLabel(agentBackend(agent), lastDetection()?.billing) : backendLabel('api', null, providerId) }, cls.kind);
      if (billed) procs.addUnconfirmed(processId, step.id, estCost);
      procs.logExecution({ projectId: proc.projectId, agentId: agent.id, kind: 'story_step', status: 'failed', tokensIn: u?.inputTokens ?? 0, tokensOut: u?.outputTokens ?? 0, cost: 0, startedAt });
      const cancelled = finalErr?.code === 'cancelled';
      throw Object.assign(new Error(msg), { cancelled, usage: u ?? null, failure: { kind: cancelled ? 'cancelled' : finalErr ? 'provider' : 'internal', class: cls.kind, providerCode: cls.code, detail: msg } satisfies ProcessFailure });
    } finally { unregisterCall(processId, ctrl); }
  }
}

// ---------------------------------------------------------------- Estado del pipeline

export function newPipeline(config: PipelineConfig): PipelineStatus {
  return { config, state: 'running', phase: 'implementing', reason: null, pauseKind: null, events: [], outputRepairs: 0, corrections: 0, failures: [], lastAssessment: null, lastQaCommit: null, startedAt: now(), finishedAt: null };
}
/** Lee-modifica-escribe el resultado del proceso (las verificaciones se guardan aparte: siempre se parte del último estado). */
export function updateResult(slug: string, id: string, fn: (r: ExecutionResult) => ExecutionResult): ExecutionResult {
  const procs = processesRepo(slug); const r = fn(procs.get(id)!.result!); procs.setResult(id, r); return r;
}
export function updatePipeline(slug: string, id: string, patch: Partial<PipelineStatus>, ev?: Omit<PipelineEvent, 'at'>) {
  updateResult(slug, id, r => r.pipeline ? { ...r, pipeline: { ...r.pipeline, ...patch, events: ev ? [...r.pipeline.events, { at: now(), ...ev }].slice(-80) : r.pipeline.events } } : r);
}
export const pipelineOf = (slug: string, id: string) => processesRepo(slug).get(id)!.result!.pipeline!;
export function emit(ctx: StoryRunCtx, kind: PipelineEventKind, message: string, extra: { detail?: string | null; aiCall?: boolean; costUsd?: number | null; phase?: PipelinePhase } = {}) {
  const { phase, ...rest } = extra;
  updatePipeline(ctx.slug, ctx.processId, phase ? { phase } : {}, { kind, message, ...rest });
  ctx.log({ processId: ctx.processId, kind }, message);
}

// ---------------------------------------------------------------- Contexto de una ejecución

export interface StoryRunCtx {
  slug: string; processId: string; item: BacklogItem; project: { id: string; name: string; description: string };
  repoPath: string; plan: StoryPlan | null; consultText: string; iterText: string;
  dev: Agent; qa: Agent | null;
  /** Equipo AUTORIZADO del proceso (los agentes de sus pasos): los únicos a los que se puede consultar. */
  team: Agent[];
  log: (o: any, m: string) => void; isCancelled: () => boolean; injected: Map<string, string>;
  /** Unidad de trabajo en curso (entrega incremental): su prompt sirve de contexto a reparaciones y continuaciones. */
  unit?: { prompt: string; files: string[]; basePath: string; label: string } | null;
}

export const fileExistsIn = (base: string) => (rel: string) => { try { return fs.existsSync(path.join(base, safeRelPath(rel))); } catch { return false; } };
/** Duración máxima autorizada (se comprueba antes de cada unidad y de cada llamada, no solo por vuelta del pipeline). */
export function checkDuration(ctx: StoryRunCtx, cfg: PipelineConfig) {
  if (Date.now() - new Date(pipelineOf(ctx.slug, ctx.processId).startedAt).getTime() > cfg.maxDurationMin * 60_000) throw new PipelinePause('duration', `Se alcanzó la duración máxima autorizada (${cfg.maxDurationMin} min). Lo hecho se conserva; puedes continuar.`);
}
export const checkCancelled = (ctx: StoryRunCtx) => { if (ctx.isCancelled()) throw Object.assign(new Error('cancelado'), { cancelled: true }); };

/** Llamada de un agente en un paso NUEVO (reparación, corrección, nueva revisión de QA), con comprobación de presupuesto previa. */
export async function stepCall(ctx: StoryRunCtx, agent: Agent, role: TeamRole, title: string, reason: string, system: string, user: string, maxTokens: number, reuseStepId?: string, schema?: { name: string; description?: string; schema: Record<string, unknown> }, operation?: string): Promise<CallResult & { stepId: string }> {
  const b = budgetCheck(ctx.slug, ctx.processId, agent, system, user, maxTokens);
  if (!b.ok) throw new PipelinePause('budget', `La siguiente llamada («${title}», ≈ ${b.needed.toFixed(2)} USD) superaría el presupuesto autorizado: quedan ${Math.max(0, b.remaining).toFixed(2)} USD. No se ha llamado a la IA; lo hecho se conserva.`);
  // Claude Code no disponible (proyecto sin autorizar, consola desconectada…): se pausa ANTES de crear el paso, como con el
  // presupuesto. Antes quedaba un paso «pendiente» huérfano por cada «Continuar» (HU-159, pasos 21 y 22).
  if (!reuseStepId) { const blocked = originBlocked(processesRepo(ctx.slug).get(ctx.processId)!, agent); if (blocked) throw originFailure(blocked); }
  if (!reuseStepId && usesClaudeCode(agent)) {
    const proc = processesRepo(ctx.slug).get(ctx.processId)!;
    const g = claudeCodeGate(ctx.slug, agent, proc.projectId);
    if (!g.ok && !apiFallbackFor(proc, agent)) throw Object.assign(new Error(g.reason), { failure: { kind: 'provider', class: 'PERMISSION_REQUIRED', providerCode: 'backend_unavailable', detail: g.reason } satisfies ProcessFailure });
  }
  const stepId = reuseStepId ?? processesRepo(ctx.slug).addStep(ctx.processId, { agentId: agent.id, agentName: agent.config.name, title, model: agent.config.model, role, reason }).id;
  const cfg = processesRepo(ctx.slug).get(ctx.processId)?.result?.pipeline?.config;
  const res = await callAgentStep(ctx.slug, ctx.processId, stepId, system, user, maxTokens, { injected: ctx.injected, log: ctx.log, schema, timeoutSec: cfg?.providerTimeoutSec ?? null, retries: cfg?.maxProviderRetries ?? null, operation });
  return { ...res, stepId };
}

// ---------------------------------------------------------------- 1 · De la respuesta del Desarrollador a cambios válidos

export interface DevOutput { text: string; stopReason: string | null; /** Señal explícita de negativa del proveedor. */ refusal?: string | null;
  /** Paso que la produjo y texto previo que la completa (continuación de un archivo cortado): para reanudar sin volver a llamar. */
  stepId?: string; prefix?: string | null }

/** Salidas del Desarrollador de este proceso en orden (entrega original + reparaciones), para reanudar sin IA. */
export function implementerOutputs(p: Process): DevOutput[] {
  return p.steps.filter(s => s.role === 'implementer' && s.outputMd && !/^Corrección/.test(s.title)).map(s => ({ text: s.outputMd!, stopReason: null }));
}

function finalizeImplementation(ctx: StoryRunCtx, meta: ParsedDevOutput, changes: ProposedChange[], assessment: DevOutputAssessment) {
  const invalid = changes.filter(c => c.error);
  let summary = '';
  if (assessment.recoveredBy && assessment.recoveredBy !== 'canonical') summary += `♻ Cambios recuperados sin IA de una entrega con formato no canónico (${assessment.recoveredBy}).\n\n`;
  if (assessment.truncatedFile) summary += `⚠ La respuesta se cortó a mitad de «${assessment.truncatedFile}»: ese archivo NO está incluido.\n\n`;
  if (invalid.length) summary += `⚠ ${invalid.length} cambio(s) no aplicables (se muestran marcados y no se escribirán): ${invalid.map(c => c.path).join(', ')}.\n\n`;
  summary += meta.summary + (meta.notes ? `\n\n${meta.notes}` : '');
  updateResult(ctx.slug, ctx.processId, r => ({
    ...r, changes, implementationSummary: summary, userFacing: meta.userFacing || r.userFacing || null,
    manualTest: meta.manualSteps.length ? { steps: meta.manualSteps, checks: meta.manualSteps.map(() => false), note: null } : r.manualTest ?? null,
    runtimeChecks: meta.runtimeChecks.length ? { checks: meta.runtimeChecks, results: [], ranAt: null } : r.runtimeChecks ?? null,
    verifyCommands: (() => { const v = meta.verify.filter(c => ['typecheck', 'test', 'build'].includes(c)); return v.length ? v : ['typecheck']; })()
  }));
}

function repairPrompt(ctx: StoryRunCtx, a: DevOutputAssessment, previous: string, ok: ProposedChange[], bad: ProposedChange[]): string {
  // HU-155: además del archivo cortado y de los que no encajan, los del plan que NUNCA llegaron (antes se omitían: 2 de 8).
  const got = new Set([...ok.map(c => c.path), ...bad.map(c => c.path)]);
  const neverSent = (ctx.plan?.filesToChange ?? []).filter(f => !got.has(f) && f !== a.truncatedFile);
  const resend = Array.from(new Set([...(a.truncatedFile ? [a.truncatedFile] : []), ...bad.map(c => c.path), ...neverSent]));
  const extraFiles = Array.from(new Set([...a.requestedFiles, ...bad.map(c => c.path)])).map(f => { const c = readRepoFile(ctx.repoPath, f, 30_000); return c === null ? null : `## ${f}\n\`\`\`\n${c}\n\`\`\``; }).filter(Boolean).join('\n\n').slice(0, 90_000);
  const partial = ok.length > 0 && (a.kind === 'truncated' || a.kind === 'incomplete' || bad.length > 0);
  return `Tu entrega anterior para esta historia no se pudo convertir en cambios aplicables. NO repitas el plan ni el análisis: repara la ENTREGA.
# Diagnóstico (automático, sin IA)
Tipo: ${a.kind}
${a.reasons.map(r => `- ${r}`).join('\n') || '- (sin detalle)'}
${bad.length ? `Cambios que no encajan en el código actual:\n${bad.map(c => `- ${c.path}: ${c.error}`).join('\n')}\n` : ''}${partial ? `# Ya recibidos y válidos (se conservan; NO los repitas)\n${ok.map(c => `- ${c.action} ${c.path}`).join('\n')}\n# Entrega SOLO\n${resend.length ? resend.map(f => `- ${f}`).join('\n') : '- los archivos que falten para cumplir el plan'}\n` : '# Entrega de nuevo TODOS los archivos del plan en el formato acordado\n'}
# Plan del Coordinador (resumen; no lo rehagas)
${ctx.plan ? `${ctx.plan.summary}\nArchivos: ${[...ctx.plan.filesToChange].join(', ')}` : '(sin plan)'}
${extraFiles ? `# Contenido ACTUAL de los archivos implicados\n${extraFiles}\n` : ''}# Tu respuesta anterior (recortada si es larga)
${clip(previous, 30_000)}

FORMATO DE RESPUESTA (texto plano; cada archivo con su bloque y su cierre):
${partial ? PATCH_ONLY_FORMAT : FILE_FORMAT}`;
}

/** Preguntas que solo puede responder el propietario (sus datos, credenciales, presupuesto o decisiones de negocio). */
const OWNER_ONLY = /(propietario|\bdata\/|datos reales|credencial|\.env\b|clave(?:s)? (?:de api|maestra)|presupuesto|decisi[oó]n de negocio|prioridad(?:es)? del negocio|cliente final)/i;
const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

/**
 * Especialista del equipo AUTORIZADO del proceso que podría responder la pregunta (nunca uno de fuera: ampliar el
 * equipo es decisión del propietario). Por la indicación del propio agente o por el tema de la pregunta.
 */
export function pickConsultant(team: Agent[], devId: string, blocker: AgentBlocker): Agent | null {
  const others = team.filter(a => a.id !== devId);
  if (!others.length || OWNER_ONLY.test(`${blocker.need} ${blocker.question}`)) return null;
  if (blocker.consult) {
    const c = norm(blocker.consult);
    const byHint = others.find(a => [a.config.name, a.template.role, a.key].some(x => { const n = norm(x); return n && (c.includes(n) || n.includes(c)); }));
    if (byHint) return byHint;
  }
  const q = `${blocker.need} ${blocker.question}`;
  const caps: [RegExp, string][] = [
    [/(arquitect|estructura|m[oó]dulo|\bapi\b|servicio|base de datos|esquema|dependencia|patr[oó]n)/i, 'consultar_arquitectura'],
    [/(\bux\b|dise[nñ]o|interfaz|pantalla|accesib|usabilidad|texto visible|bot[oó]n)/i, 'consultar_ux'],
    [/(prueba|\btest|qa\b|calidad|verificaci[oó]n)/i, 'revisar_calidad'],
    [/(alcance|criterio|historia|plan|prioridad|requisito)/i, 'planificar']
  ];
  for (const [re, cap] of caps) if (re.test(q)) { const a = others.find(x => (x.config.capabilities ?? []).includes(cap as any)); if (a) return a; }
  return null;
}

/** Contexto que pidió el agente y que el equipo puede darle sin preguntar a nadie: archivos del repositorio. */
function suppliedFiles(ctx: StoryRunCtx, files: string[]): string {
  let budget = 90_000;
  return files.map(f => { const c = readRepoFile(ctx.unit?.basePath ?? ctx.repoPath, f, 30_000); if (c === null || budget <= 0) return null; budget -= c.length; return `## ${f}\n\`\`\`\n${c}\n\`\`\``; }).filter(Boolean).join('\n\n');
}

function continuationPrompt(ctx: StoryRunCtx, need: string, info: string, previous: string): string {
  // Unidad de trabajo: se repite SU encargo (acotado), no la historia entera.
  if (ctx.unit) return `Antes no pudiste implementar la historia en esta unidad (${ctx.unit.label}) porque te faltaba: «${need}». Ya tienes esa información:
${info}

# Tu respuesta anterior (recortada)
${clip(previous, 6_000)}

${ctx.unit.prompt}`;
  return `Antes no pudiste implementar la historia porque te faltaba: «${need}». Ya tienes esa información:
${info}

# Plan del Coordinador (resumen; no lo rehagas)
${ctx.plan ? `${ctx.plan.summary}\nArchivos: ${ctx.plan.filesToChange.join(', ')}` : '(sin plan)'}
# Tu respuesta anterior (recortada)
${clip(previous, 12_000)}

Ahora entrega la implementación completa en el formato acordado. Si aún falta algo imprescindible, responde con la sección BLOQUEO indicando exactamente qué y por qué (no repitas la misma petición si ya se te dio).

FORMATO DE RESPUESTA (texto plano; cada archivo con su bloque y su cierre):
${FILE_FORMAT}`;
}

/**
 * MISSING_INFORMATION dentro de la autoridad del proceso, de lo más barato a lo más caro y cada cosa UNA vez:
 * 1) la respuesta del propietario pendiente de entregar; 2) archivos del repositorio que el agente pidió (sin IA para
 * obtenerlos); 3) una consulta a un especialista del equipo autorizado. Devuelve la nueva entrega del Desarrollador o
 * null si no queda nada que intentar (entonces se pregunta al propietario).
 */
const blockerOf = (a: DevOutputAssessment): AgentBlocker => a.blocker ?? { type: 'information', need: a.reasons[0] ?? 'información no especificada', question: a.reasons[0] ?? '', consult: null, declared: false };

/** La respuesta del propietario (información, permiso o decisión) se entrega UNA vez al agente que la pidió. */
async function deliverOwnerAnswers(ctx: StoryRunCtx, a: DevOutputAssessment, previous: string): Promise<DevOutput | null> {
  const p = pipelineOf(ctx.slug, ctx.processId);
  const pending = (p?.ownerAnswers ?? []).filter(x => !x.delivered);
  if (!pending.length) return null;
  const n = ctx.dev.config.name;
  emit(ctx, 'info', `${n} recibe tu respuesta y retoma la implementación.`, { phase: 'implementing', aiCall: true, detail: pending.map(x => `«${x.question}» → ${x.answer.slice(0, 200)}`).join(' · ') });
  updatePipeline(ctx.slug, ctx.processId, { ownerAnswers: (p.ownerAnswers ?? []).map(x => ({ ...x, delivered: true })), ownerRequest: null });
  const info = pending.map(x => `## Respuesta del propietario a «${x.question}»\n${x.answer}`).join('\n\n');
  const res = await stepCall(ctx, ctx.dev, 'implementer', 'Implementación con la respuesta del propietario', 'El propietario respondió a lo que el agente necesitaba', sys(ctx.dev, ctx.project, ctx.item), continuationPrompt(ctx, blockerOf(a).need, info, previous), DEV_MAX_TOKENS);
  return { text: res.text, stopReason: res.stopReason, refusal: res.refusal ?? null, stepId: res.stepId };
}

async function resolveMissingInformation(ctx: StoryRunCtx, cfg: PipelineConfig, a: DevOutputAssessment, previous: string): Promise<DevOutput | null> {
  const blocker = blockerOf(a);
  const p = pipelineOf(ctx.slug, ctx.processId);
  const system = sys(ctx.dev, ctx.project, ctx.item);
  const n = ctx.dev.config.name;
  if (a.requestedFiles.length && (p.contextSupplies ?? 0) < (ctx.unit ? 3 : 1)) {
    const files = suppliedFiles(ctx, a.requestedFiles);
    if (files) {
      emit(ctx, 'info', `${n} necesitaba archivos del repositorio que no tenía; el equipo se los entrega (sin consultar a nadie).`, { phase: 'implementing', aiCall: true, detail: a.requestedFiles.join(', ') });
      updatePipeline(ctx.slug, ctx.processId, { contextSupplies: (p.contextSupplies ?? 0) + 1 });
      const res = await stepCall(ctx, ctx.dev, 'implementer', 'Implementación con el contexto solicitado', `Faltaba el contenido de ${a.requestedFiles.join(', ')}`, system, continuationPrompt(ctx, blocker.need, `# Contenido actual de los archivos solicitados\n${files}`, previous), DEV_MAX_TOKENS);
      return { text: res.text, stopReason: res.stopReason, refusal: res.refusal ?? null, stepId: res.stepId };
    }
  }
  const asked = (p.consultations ?? []).map(c => norm(c.question));
  const consultant = (p.consultations ?? []).length < cfg.maxConsultations && !asked.includes(norm(blocker.question)) ? pickConsultant(ctx.team, ctx.dev.id, blocker) : null;
  if (consultant) {
    emit(ctx, 'info', `${n} necesita información: «${blocker.question}». Se la pregunta a ${consultant.config.name} (${consultant.template.role}, del equipo autorizado).`, { phase: 'implementing', aiCall: true });
    updatePipeline(ctx.slug, ctx.processId, { consultations: [...(p.consultations ?? []), { at: new Date().toISOString(), agentName: consultant.config.name, question: blocker.question }] });
    const cRes = await stepCall(ctx, consultant, 'consultant', `Consulta de ${n}: ${blocker.question.slice(0, 80)}`, `${n} necesita esta información para implementar la historia`, sys(consultant, ctx.project, ctx.item),
      `${n} está implementando esta historia y necesita tu respuesta para seguir. Responde con hechos concretos de tu especialidad, en 3-10 puntos; si no lo sabes con certeza, dilo y explica qué faltaría (no inventes).
# Pregunta
${blocker.question}
# Lo que necesita
${blocker.need}
# Plan del Coordinador
${ctx.plan ? JSON.stringify(ctx.plan, null, 2) : '(sin plan)'}`, 2500);
    const res = await stepCall(ctx, ctx.dev, 'implementer', `Implementación con la respuesta de ${consultant.config.name}`, `Consultó a ${consultant.config.name}`, system, continuationPrompt(ctx, blocker.need, `## Respuesta de ${consultant.config.name} (${consultant.template.role})\n${cRes.text.trim().slice(0, 8000)}`, previous), DEV_MAX_TOKENS);
    return { text: res.text, stopReason: res.stopReason, refusal: res.refusal ?? null, stepId: res.stepId };
  }
  return null;
}

/** Corta sin reintentar: con pipeline, pausa/detiene con la petición al propietario; sin pipeline, el proceso falla con su clase. */
function blockedStop(ctx: StoryRunCtx, cfg: PipelineConfig | null, kind: PipelinePauseKind, cls: AgentFailureKind, a: DevOutputAssessment, request: OwnerRequest, message: string): never {
  updateResult(ctx.slug, ctx.processId, r => ({ ...r, failure: { kind: 'refusal', class: cls, detail: message, assessment: a, request } }));
  if (cfg) { updatePipeline(ctx.slug, ctx.processId, { failureClass: cls, ownerRequest: request }); throw new PipelinePause(kind, message); }
  throw new StoryFailure({ kind: 'refusal', class: cls, detail: message, assessment: a, request });
}

/** Ganchos de una unidad de trabajo (entrega incremental): continuación del archivo cortado y reparación acotada a la unidad. */
export interface UnitHooks {
  /** Pide SOLO la continuación del archivo cortado (contador propio, no consume correcciones); null si ya no quedan. */
  continueFile: (partial: NonNullable<ParsedDevOutput['truncatedPartial']>, previous: string) => Promise<DevOutput | null>;
  repairPrompt: (a: DevOutputAssessment, previous: string, ok: ProposedChange[], bad: ProposedChange[]) => string;
  canRepair: () => boolean;
  onRepair: () => void;
  /** ¿Importa este archivo para esta unidad? (un parche repetido sobre algo ya entregado no justifica una reparación pagada) */
  relevant?: (path: string) => boolean;
  /** Cada salida pagada dentro de la unidad (reparación, contexto, respuesta del propietario, continuación) queda registrada. */
  record: (o: DevOutput) => void;
}
export interface Settled { outcome: 'ok' | 'no_changes'; changes: ProposedChange[]; raw: RawChange[]; meta: ParsedDevOutput; assessment: DevOutputAssessment; drops: { path: string; reason: string }[]; truncatedFile: string | null }

/**
 * Convierte las salidas del Desarrollador en cambios válidos según la CLASE del problema:
 * formato no válido o incompleto → recuperación local y reparación acotada; falta información → contexto, especialista
 * o propietario; permiso, capacidad o negativa del proveedor → NUNCA se reintenta a ciegas: se pide o se explica.
 * Con `unit` (entrega incremental) una respuesta cortada se CONTINÚA (solo el archivo cortado) en vez de repararse, y el
 * resultado se devuelve a la unidad para aplicarlo; sin `unit`, se finaliza la implementación de la historia entera.
 */
async function settleCore(ctx: StoryRunCtx, outputs: DevOutput[], opts: { config: PipelineConfig | null; unit?: UnitHooks }): Promise<Settled> {
  const base = ctx.unit?.basePath ?? ctx.repoPath;
  const knownFiles = [...(ctx.plan ? [...ctx.plan.filesToRead, ...ctx.plan.filesToChange] : []), ...(ctx.unit?.files ?? [])];
  const exists = fileExistsIn(base);
  const evaluate = () => {
    let pool: RawChange[] = []; let meta: ParsedDevOutput | null = null; let last: DevOutputAssessment | null = null; let lastText = ''; let partial: ParsedDevOutput['truncatedPartial'] = null;
    const drops = new Map<string, string>();
    for (const o of outputs) {
      const { parsed, assessment } = assessDeveloperOutput(o.text, { stopReason: o.stopReason, exists, knownFiles, providerRefusal: o.refusal ?? null });
      pool = mergeChanges(pool, parsed.changes); last = assessment; lastText = o.text; partial = parsed.truncatedPartial ?? null;
      for (const d of parsed.drops ?? []) drops.set(d.path, d.reason);
      if (!meta || (!meta.summary && parsed.summary) || (!meta.manualSteps.length && parsed.manualSteps.length)) meta = meta ? { ...parsed, summary: meta.summary || parsed.summary, userFacing: meta.userFacing || parsed.userFacing, manualSteps: meta.manualSteps.length ? meta.manualSteps : parsed.manualSteps, runtimeChecks: meta.runtimeChecks.length ? meta.runtimeChecks : parsed.runtimeChecks } : parsed;
    }
    // Un archivo que llegó completo en una continuación posterior ya no está «cortado».
    if (partial && pool.some(c => c.path === partial!.path)) partial = null;
    const changes = annotateChanges(base, pool);
    // Si lo último entregado ya da cambios válidos, cuenta como implementación aunque antes hubiera fallos de forma.
    const kind = last!.kind !== 'implementation' && pool.length && changes.some(c => !c.error) && outputs.length > 1 && (last!.kind !== 'truncated' || !partial) ? 'implementation' : last!.kind;
    return { changes, raw: pool, meta: meta!, assessment: { ...last!, kind, files: pool.length, truncatedFile: last!.truncatedFile && !pool.some(c => c.path === last!.truncatedFile) ? last!.truncatedFile : null } as DevOutputAssessment, lastText, partial, drops: Array.from(drops, ([path, reason]) => ({ path, reason })) };
  };
  let ev = evaluate();
  let announced = false;
  const who = ctx.dev.config.name;
  const settled = (outcome: Settled['outcome']): Settled => ({ outcome, changes: ev.changes, raw: ev.raw, meta: ev.meta, assessment: ev.assessment, drops: ev.drops, truncatedFile: ev.partial?.path ?? null });
  for (;;) {
    checkCancelled(ctx);
    const valid = ev.changes.filter(c => !c.error); const invalid = ev.changes.filter(c => c.error);
    const invalidRelevant = opts.unit?.relevant ? invalid.filter(c => opts.unit!.relevant!(c.path)) : invalid;
    const cls: AgentFailureKind | null = failureClassOf(ev.assessment) ?? (invalidRelevant.length ? 'INVALID_OUTPUT' : null);
    if (opts.config) updatePipeline(ctx.slug, ctx.processId, { lastAssessment: ev.assessment, failureClass: cls, phase: opts.unit ? 'implementing' : 'recovering' });
    if (!announced && ev.assessment.recoveredBy && ev.assessment.recoveredBy !== 'canonical' && opts.config) {
      emit(ctx, 'recovery', 'El Desarrollador entregó un formato incompleto. Recuperando los cambios existentes sin consumir IA.', { detail: `${valid.length} archivo(s) recuperados (${ev.assessment.recoveredBy}). ${ev.assessment.reasons.slice(0, 4).join(' ')}` });
      announced = true;
    }
    if (ev.assessment.kind === 'no_changes' && !valid.length) return settled('no_changes');
    // Unidad: una respuesta cortada se continúa por el archivo cortado; lo completo ya recibido se conserva tal cual.
    if (opts.unit && ev.partial && cls === 'INCOMPLETE_OUTPUT') {
      const next = await opts.unit.continueFile(ev.partial, ev.lastText);
      if (next) { opts.unit.record(next); outputs = [...outputs, next]; ev = evaluate(); continue; }
      return settled('ok');
    }
    if (!cls) return settled('ok');
    const a = ev.assessment; const blocker = a.blocker;
    const now = new Date().toISOString();
    // Si el propietario ya respondió a lo que el agente necesitaba, se le entrega (una vez) antes de volver a parar.
    if (opts.config && (cls === 'MISSING_INFORMATION' || cls === 'PERMISSION_REQUIRED' || cls === 'UNSUPPORTED_CAPABILITY')) {
      const answered = await deliverOwnerAnswers(ctx, a, ev.lastText);
      if (answered) { opts.unit?.record(answered); outputs = [...outputs, answered]; ev = evaluate(); continue; }
    }
    // Lo que NO se arregla reintentando: se conserva, se explica y se pide lo que haga falta.
    if (cls === 'PROVIDER_REFUSAL') {
      blockedStop(ctx, opts.config, 'provider_refusal', cls, a, { kind: 'decision', question: '¿Cómo quieres seguir con esta historia?', why: `El proveedor rechazó la petición del ${who}. Repetirla igual no cambiaría el resultado y gastaría créditos; la respuesta queda guardada como evidencia.`, askedBy: who, options: ['Reformular o acotar la historia (nueva iteración)', 'Cerrarla como resuelta fuera del flujo', 'Rechazarla'], at: now },
        `El proveedor rechazó la petición (${a.reasons[0] ?? 'negativa'}). No se reintenta: repetir la misma petición no cambiaría el resultado.`);
    }
    if (cls === 'PERMISSION_REQUIRED') {
      const dataAccess = /\bdata\/|datos (?:reales )?del propietario|credencial|\.env\b/i.test(`${blocker?.need} ${blocker?.question}`);
      blockedStop(ctx, opts.config, 'permission', cls, a, { kind: 'permission', question: blocker?.question ?? '¿Qué permiso necesita?', why: dataAccess ? `${who} necesita acceder a tus datos reales (data/, credenciales o .env). Ningún agente puede acceder a ellos: es una regla de seguridad del Portal que no se amplía. Puedes responder con la información necesaria (sin secretos), acotar la historia a lo verificable en el repositorio o cerrarla.` : `${who} necesita un permiso que no tiene en este proceso: ${blocker?.need ?? ''}. No se amplía ningún permiso sin tu decisión explícita.`, askedBy: who, options: dataAccess ? ['Responder con la información necesaria (sin secretos)', 'Acotar la historia a lo verificable en el código', 'Cerrarla como resuelta fuera del flujo'] : ['Responder concediendo o denegando el permiso', 'Acotar la historia', 'Rechazarla'], at: now },
        `Pausado: ${who} necesita un permiso que no tiene (${blocker?.need ?? 'sin detalle'}). No se reintenta ni se amplía nada sin tu decisión.`);
    }
    if (cls === 'UNSUPPORTED_CAPABILITY') {
      blockedStop(ctx, opts.config, 'unsupported', cls, a, { kind: 'decision', question: blocker?.question ?? '¿Cómo quieres seguir?', why: `${who} no puede hacer esto con las herramientas disponibles: ${blocker?.need ?? ''}. Volver a pedírselo no cambiaría el resultado.`, askedBy: who, options: ['Responder con el dato o el resultado que falta (lo obtienes tú)', 'Acotar la historia a lo que sí puede hacerse', 'Cerrarla como resuelta fuera del flujo'], at: now },
        `Detenido: ${who} no dispone de la capacidad necesaria (${blocker?.need ?? 'sin detalle'}). No se reintenta.`);
    }
    if (cls === 'MISSING_INFORMATION') {
      const next = opts.config ? await resolveMissingInformation(ctx, opts.config, a, ev.lastText) : null;
      if (next) { opts.unit?.record(next); outputs = [...outputs, next]; ev = evaluate(); continue; }
      blockedStop(ctx, opts.config, 'missing_information', cls, a, { kind: 'information', question: blocker?.question ?? a.reasons[0] ?? '¿Qué información falta?', why: `${who} no puede seguir sin esta información${blocker?.need && blocker.need !== blocker.question ? ` (${blocker.need})` : ''}. ${opts.config ? 'Nadie del equipo autorizado puede responderla (o ya se intentó).' : 'Este proceso no tiene el pipeline autorizado para consultar a nadie.'} Con tu respuesta, el equipo retoma donde lo dejó.`, askedBy: who, options: ['Responder la pregunta', 'Acotar la historia', 'Cerrarla como resuelta fuera del flujo'], at: now },
        `Pausado: ${who} necesita información para seguir: «${blocker?.question ?? a.reasons[0] ?? 'sin detalle'}».`);
    }
    // INVALID_OUTPUT / INCOMPLETE_OUTPUT: reparación acotada del formato (solo esto se repara «a ciegas»).
    const repairs = opts.config ? pipelineOf(ctx.slug, ctx.processId).outputRepairs : 0;
    const canRepair = opts.unit ? opts.unit.canRepair() : !!opts.config && repairs < opts.config.maxOutputRepairs;
    if (!canRepair) {
      if (opts.unit || valid.length) return settled('ok');
      const failure: ProcessFailure = { kind: 'output_contract', class: cls, detail: invalid.length && !a.reasons.length ? `Ninguno de los ${invalid.length} cambio(s) del Desarrollador es aplicable: ${invalid.map(c => `${c.path}: ${c.error}`).join(' · ')}` : `El Desarrollador no entregó cambios aplicables en el formato acordado (${a.kind}). ${a.reasons.slice(0, 4).join(' ')}`, assessment: a };
      updateResult(ctx.slug, ctx.processId, r => ({ ...r, changes: ev.changes }));
      throw new StoryFailure(failure);
    }
    emit(ctx, 'repair', `Corrigiendo la entrega del Desarrollador${ctx.unit ? ` (${ctx.unit.label})` : ''} dentro del presupuesto autorizado.`, { phase: opts.unit ? 'implementing' : 'repairing', aiCall: true, detail: `Intento ${repairs + 1} · ${cls === 'INCOMPLETE_OUTPUT' ? 'entrega incompleta' : 'formato no válido'} (${a.kind}): ${a.reasons.slice(0, 3).join(' ')}` });
    const system = sys(ctx.dev, ctx.project, ctx.item);
    const res = await stepCall(ctx, ctx.dev, 'implementer', `Reparación de la entrega (intento ${repairs + 1})`, `Entrega no aplicable (${a.kind}): reparación acotada sin repetir el plan`, system, opts.unit ? opts.unit.repairPrompt(a, ev.lastText, valid, invalid) : repairPrompt(ctx, a, ev.lastText, valid, invalid), 12_000);
    updatePipeline(ctx.slug, ctx.processId, { outputRepairs: repairs + 1 });
    opts.unit?.onRepair();
    const repaired: DevOutput = { text: res.text, stopReason: res.stopReason, refusal: res.refusal ?? null, stepId: res.stepId };
    opts.unit?.record(repaired);
    outputs = [...outputs, repaired];
    const before = JSON.stringify(a.reasons);
    ev = evaluate();
    emit(ctx, 'repair', ev.assessment.kind === 'implementation' && !ev.changes.some(c => c.error) ? `Entrega reparada: ${ev.changes.length} archivo(s) aplicables.` : `La reparación no resolvió todo (${ev.assessment.kind}).`, { costUsd: res.costUsd, detail: ev.assessment.reasons.slice(0, 3).join(' ') || null });
    if (ev.assessment.kind !== 'implementation' && JSON.stringify(ev.assessment.reasons) === before) {
      updatePipeline(ctx.slug, ctx.processId, { failures: bumpFailure(pipelineOf(ctx.slug, ctx.processId).failures, `output|${ev.assessment.kind}|${before.slice(0, 80)}`, 'misma entrega no aplicable') });
    }
  }
}

/** Historia entera en una respuesta (procesos sin pipeline de aplicación automática): finaliza la implementación propuesta. */
export async function settleImplementation(ctx: StoryRunCtx, outputs: DevOutput[], opts: { config: PipelineConfig | null }): Promise<'ok' | 'no_changes'> {
  const s = await settleCore(ctx, outputs, opts);
  if (s.outcome === 'no_changes') {
    updateResult(ctx.slug, ctx.processId, r => ({ ...r, changes: [], implementationSummary: `${s.meta.summary}\n\nSin cambios: ${s.meta.noChanges ?? s.drops.map(d => `${d.path}: ${d.reason}`).join(' · ')}`.trim() }));
    return 'no_changes';
  }
  finalizeImplementation(ctx, s.meta, s.changes, s.assessment);
  return 'ok';
}

/** Una unidad de trabajo: devuelve lo entregado (sin aplicarlo) para que la unidad lo valide y lo aplique en el worktree. */
export const settleUnit = (ctx: StoryRunCtx, outputs: DevOutput[], config: PipelineConfig, unit: UnitHooks) => settleCore(ctx, outputs, { config, unit });

// ---------------------------------------------------------------- 2-6 · Aplicar, verificar, QA y correcciones

export function bumpFailure(list: PipelineStatus['failures'], signature: string, label: string) {
  const f = list.find(x => x.signature === signature);
  return f ? list.map(x => x === f ? { ...x, count: x.count + 1 } : x) : [...list, { signature, count: 1, label }];
}
export function verificationSignature(v: VerificationRun): string {
  const d = diagnosticsFor(v);
  return `${v.command}|${d.slice(0, 3).map(x => `${x.file ?? ''}:${x.code ?? ''}:${x.text.slice(0, 40)}`).join(',') || v.output.trim().split('\n').slice(-2).join(' ').slice(0, 80)}`;
}
const FAIL_MSG: Record<string, string> = {
  typecheck: 'QA detectó errores de compilación. El equipo está preparando una corrección.',
  test: 'QA detectó pruebas automáticas que fallan. El equipo está preparando una corrección.',
  build: 'QA detectó que la compilación (build) falla. El equipo está preparando una corrección.'
};

async function applyInWorktree(ctx: StoryRunCtx) {
  const procs = processesRepo(ctx.slug); const proc = procs.get(ctx.processId)!; const r = proc.result!;
  requirePolicy('write_worktree', { slug: ctx.slug, processId: ctx.processId, agentId: ctx.dev.id, projectId: proc.projectId, authorized: true });
  const checked = checkStaleChanges(ctx.repoPath, r.changes);
  if (!checked.some(c => !c.error)) throw new StoryFailure({ kind: 'output_contract', detail: `Ningún cambio es aplicable: ${checked.filter(c => c.error).map(c => `${c.path}: ${c.error}`).join(' · ')}` });
  const branch = `portal-ia/${ctx.item.storyId.toLowerCase()}`;
  const applied = await applyChanges(ctx.repoPath, branch, checked, `${ctx.item.storyId}: ${ctx.item.title}\n\nCambios del equipo de agentes de Portal IA (pipeline autorizado por el propietario).\nProceso: ${ctx.processId}`, { processId: ctx.processId });
  updateResult(ctx.slug, ctx.processId, x => ({ ...x, changes: checked, applied: { ...applied, appliedAt: now() } }));
  procs.logExecution({ projectId: proc.projectId, agentId: ctx.dev.id, kind: 'repo_write', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: now() });
  emit(ctx, 'apply', `Cambios aplicados en el worktree aislado (rama ${applied.branch}, commit ${applied.commit}). Tu carpeta del Portal no cambia.`, { phase: 'applying', detail: applied.files.join(', ') });
}

/**
 * Ejecuciones de verificación posteriores al último commit aplicado (las anteriores son de otra versión del código).
 * Comparación estricta: una corrección puede llegar en menos de un segundo tras la verificación que falló, y esa
 * ejecución anterior NO vale para el commit nuevo.
 */
export function sinceApplied(r: ExecutionResult): VerificationRun[] {
  return verificationsForApplied(r);
}

/** Verifica los comandos autorizados; resuelve el entorno sin IA. Devuelve la primera ejecución que falla por el código, o null. */
export async function verifyStage(ctx: StoryRunCtx, cfg: PipelineConfig): Promise<VerificationRun | null> {
  // Detección en caché; un «no disponible» se confirma una vez más tras una pausa breve (Docker cargado puede tardar en responder).
  let sb = await sandboxDeps.detect();
  if (sb.available === 'unavailable') { await new Promise(r => setTimeout(r, 3000)); sb = await sandboxDeps.detect(true); }
  if (sb.available === 'unavailable') throw new PipelinePause('environment', `No hay sandbox disponible (${sb.detail}). La verificación se pausa: arranca Docker Desktop y pulsa «Continuar». No es un fallo del código.`);
  for (const cmd of cfg.commands) {
    checkCancelled(ctx);
    const r = processesRepo(ctx.slug).get(ctx.processId)!.result!;
    const last = sinceApplied(r).filter(v => v.command === cmd).at(-1);
    if (last?.exitCode === 0) continue;
    if (last && last.exitCode !== null && last.exitCode !== DEPS_MISSING_EXIT && last.isolation !== 'unavailable') return last; // ya falló (al reanudar)
    // Al reanudar tras «faltan dependencias» (86) no se repite esa comprobación: se va directo a instalar (si está autorizado).
    const blockedByDeps = last?.exitCode === DEPS_MISSING_EXIT && last.isolation === 'docker';
    if (!blockedByDeps) emit(ctx, 'verify', `Verificando ${cmd} en el sandbox…`, { phase: 'verifying' });
    let run = blockedByDeps ? last! : await runVerification(ctx.slug, ctx.processId, cmd, false);
    if (run.exitCode === DEPS_MISSING_EXIT && run.isolation === 'docker') {
      if (!cfg.allowInstall) throw new PipelinePause('network', 'Faltan las dependencias Linux del sandbox y este proceso no tiene autorizada la instalación con red temporal. Autorízala y pulsa «Continuar» (no consume IA).');
      emit(ctx, 'environment', 'Faltan las dependencias Linux del sandbox: instalándolas con red temporal (autorizado). No se llama a ningún agente.', { phase: 'installing' });
      const inst = await runVerification(ctx.slug, ctx.processId, 'install', true);
      if (inst.exitCode !== 0) throw new PipelinePause('environment', `La instalación de dependencias falló en el sandbox (código ${inst.exitCode}). Es un problema del entorno (red, registro o package-lock), no del código.`);
      emit(ctx, 'environment', 'Dependencias instaladas. Se repite la verificación sin red.', { phase: 'verifying' });
      run = await runVerification(ctx.slug, ctx.processId, cmd, false);
    }
    if (run.exitCode === null) {
      emit(ctx, 'environment', `${cmd} no terminó (tiempo agotado). Se repite una vez: suele ser el motor de Docker.`);
      run = await runVerification(ctx.slug, ctx.processId, cmd, false);
      if (run.exitCode === null) throw new PipelinePause('environment', `${cmd} no terminó dos veces seguidas (tiempo agotado). Comprueba que Docker Desktop responde y pulsa «Continuar».`);
    }
    if (run.isolation === 'unavailable') throw new PipelinePause('environment', `El sandbox dejó de estar disponible durante ${cmd}. Arranca Docker Desktop y pulsa «Continuar».`);
    if (run.exitCode === DEPS_MISSING_EXIT) throw new PipelinePause('environment', 'El sandbox sigue sin dependencias tras instalarlas. Revisa el detalle de la instalación.');
    if (run.exitCode !== 0) return run;
    emit(ctx, 'verify', `${cmd} correcto (${Math.round(run.durationMs / 1000)} s, ${run.isolation}).`);
  }
  return null;
}

/**
 * «test» falla y TODAS las pruebas que fallan son ajenas a la historia (ni creadas, ni planificadas, ni tocadas por ella):
 * se repite una vez por commit, sin IA. Si pasa, era una prueba inestable y no se paga ninguna corrección; si vuelve a
 * fallar, el pipeline sigue con esa ejecución. HU-155: dos pruebas inestables del propio Portal costaron tres correcciones
 * pagadas y el equipo acabó modificándolas fuera del plan. true = se repitió (el pipeline vuelve a empezar la vuelta).
 */
export async function retryForeignFailure(ctx: StoryRunCtx, failed: VerificationRun): Promise<boolean> {
  const r = processesRepo(ctx.slug).get(ctx.processId)!.result!; const p = pipelineOf(ctx.slug, ctx.processId);
  // Solo pruebas CANCELADAS y la causa no está en la evidencia (HU-159): no es un fallo de la implementación. Se repite
  // «test» una vez, sin IA, para ver la causa; si sigue igual, es el ejecutor de pruebas o el entorno: pausa, sin corrección pagada.
  const summary = failed.command === 'test' ? testRunSummary(failed) : null;
  if (summary?.onlyCancellations && r.applied) {
    if ((p.flakeRetries ?? []).includes(r.applied.commit)) throw new PipelinePause('environment', `«test» sigue terminando con ${summary.cancelled} prueba(s) canceladas y ningún fallo propio a la vista, también al repetirlo sin IA. No es un defecto de la implementación: revisa el ejecutor de pruebas (plazo, fin del proceso) en la salida de la verificación. No se ha gastado ninguna corrección.`);
    updatePipeline(ctx.slug, ctx.processId, { flakeRetries: [...(p.flakeRetries ?? []), r.applied.commit].slice(-20) });
    emit(ctx, 'verify', `«test» solo tiene ${summary.cancelled} prueba(s) canceladas por su suite y la evidencia guardada no dice por qué: no son fallos de la implementación. Se repite «test» una vez, sin IA, para obtener la causa real antes de pagar una corrección.`, { phase: 'verifying' });
    await runVerification(ctx.slug, ctx.processId, 'test', false);
    return true;
  }
  if (failed.command !== 'test' || !r.applied || (p.flakeRetries ?? []).includes(r.applied.commit)) return false;
  const files = failingTests(failed).map(f => f.file);
  if (!files.length || files.some(f => !f)) return false;
  // De la historia: lo que su diff cambia AHORA y lo planificado (un archivo tocado fuera del plan y ya restaurado no lo es).
  const story = new Set([...r.changes.filter(c => !c.error).map(c => c.path), ...(r.manifest?.deliverables.filter(d => d.planned).map(d => d.path) ?? r.plan?.filesToChange ?? [])]);
  if (files.some(f => story.has(f!))) return false;
  const list = Array.from(new Set(files)).join(', ');
  updatePipeline(ctx.slug, ctx.processId, { flakeRetries: [...(p.flakeRetries ?? []), r.applied.commit].slice(-20) });
  emit(ctx, 'verify', `Solo fallan pruebas que esta historia no toca (${list}): se repite «test» una vez, sin IA, para descartar una prueba inestable antes de pagar una corrección.`, { phase: 'verifying' });
  const again = await runVerification(ctx.slug, ctx.processId, 'test', false);
  if (again.exitCode === 0) emit(ctx, 'environment', `«test» pasó al repetirlo: era una prueba inestable ajena a la historia (${list}). No se corrige nada ni se gasta en IA; conviene estabilizarla aparte.`);
  return true;
}

export function attemptsSummary(p: PipelineStatus): string[] {
  return p.events.filter(e => e.kind === 'correction' || (e.kind === 'qa' && /rechaz/i.test(e.message)) || e.kind === 'repair').map(e => `${e.message}${e.detail ? ` — ${e.detail}` : ''}`).slice(-8);
}

/** Corrección de procesos sin manifiesto (historia entera en una respuesta). true si aplicó cambios. */
async function correct(ctx: StoryRunCtx, cfg: PipelineConfig, problem: string, files: string[]): Promise<boolean> {
  const p = pipelineOf(ctx.slug, ctx.processId); const n = p.corrections + 1;
  const ineffective = (p.ineffectiveRounds ?? 0) > 0;
  const r = processesRepo(ctx.slug).get(ctx.processId)!.result!;
  const wt = r.applied!.worktree!;
  let budget = 70_000;
  const affected = Array.from(new Set([...files, ...r.changes.filter(c => !c.error).map(c => c.path)])).filter(f => fileExistsIn(wt)(f)).slice(0, 10);
  const filesCtx = affected.map(f => { const c = readRepoFile(wt, f, 30_000); if (c === null || budget <= 0) return null; budget -= c.length; return `## ${f}\n\`\`\`\n${c}\n\`\`\``; }).filter(Boolean).join('\n\n');
  const user = `Corrige la implementación de esta historia. Tus cambios ya están aplicados en el worktree; el código actual es el que se muestra abajo. NO repitas el plan ni rehagas lo que funciona: entrega solo los cambios mínimos que resuelven el problema.
# Problema a corregir (evidencia real)
${problem}
${attemptsSummary(p).length ? `# Intentos anteriores (no repitas lo que ya falló)\n${attemptsSummary(p).map(a => `- ${a}`).join('\n')}\n` : ''}# Plan del Coordinador (resumen)
${ctx.plan ? ctx.plan.summary : '(sin plan)'}
# Contenido ACTUAL de los archivos implicados (worktree)
${filesCtx || '(no se identificaron archivos; usa las rutas de la evidencia)'}

${ineffective ? '# Qué cambia en este intento\nEl intento anterior no produjo cambios aplicables (ver arriba). Esta vez: SOLO bloques patch pequeños sobre el contenido actual; no reescribas archivos enteros; si falta un archivo completo, entrega UNO solo, el más importante.\n' : ''}
FORMATO DE RESPUESTA:
${PATCH_ONLY_FORMAT}`;
  const res = await stepCall(ctx, ctx.dev, 'implementer', `Corrección ${n}${ineffective ? ' (otra estrategia)' : ''}`, `Corrección acotada con la evidencia: ${problem.split('\n')[0].slice(0, 120)}`, sys(ctx.dev, ctx.project, ctx.item), user, 12_000);
  updatePipeline(ctx.slug, ctx.processId, { correctionAttempts: (p.correctionAttempts ?? 0) + 1 });
  const { parsed, assessment } = assessDeveloperOutput(res.text, { stopReason: res.stopReason, exists: fileExistsIn(wt), knownFiles: affected });
  const fixes = annotateChanges(wt, parsed.changes).filter(c => !c.error);
  if (!fixes.length) {
    // HU-155: una respuesta sin cambios aplicables (p. ej. cortada) NO consume la cuota de correcciones; sí queda contada y pagada.
    emit(ctx, 'correction', `La corrección ${n} no trajo cambios aplicables (${assessment.kind}); no cuenta como corrección.`, { costUsd: res.costUsd, detail: assessment.reasons.slice(0, 3).join(' ') || null });
    return false;
  }
  requirePolicy('write_worktree', { slug: ctx.slug, processId: ctx.processId, agentId: ctx.dev.id, projectId: ctx.project.id, authorized: true });
  try {
    const c = await commitInWorktree(wt, fixes, `${ctx.item.storyId}: corrección ${n} (pipeline)\n\nProceso: ${ctx.processId}`);
    const all = await changesSinceBase(ctx.repoPath, wt);
    updateResult(ctx.slug, ctx.processId, x => ({ ...x, changes: all, applied: { ...x.applied!, commit: c.commit, files: Array.from(new Set([...x.applied!.files, ...c.files])), appliedAt: now() } }));
    updatePipeline(ctx.slug, ctx.processId, { corrections: n, ineffectiveRounds: 0 });
    emit(ctx, 'correction', `Corrección ${n} aplicada (commit ${c.commit}). Se repite la verificación.`, { costUsd: res.costUsd, detail: c.files.join(', ') });
    return true;
  } catch (e: any) {
    emit(ctx, 'correction', `La corrección ${n} no se pudo aplicar: ${e.message}; no cuenta como corrección.`, { costUsd: res.costUsd });
    return false;
  }
}
/** Una corrección sin efecto: se reintenta UNA vez con otra estrategia; dos seguidas detienen (nunca se repite lo mismo a ciegas). */
function ineffectiveCorrection(ctx: StoryRunCtx) {
  const n = (pipelineOf(ctx.slug, ctx.processId).ineffectiveRounds ?? 0) + 1;
  updatePipeline(ctx.slug, ctx.processId, { ineffectiveRounds: n });
  if (n >= 2) throw new PipelinePause('repeated_failure', `Dos correcciones seguidas no produjeron ningún cambio aplicable (la última con otra estrategia). El equipo se detiene en vez de repetir lo mismo; lo hecho se conserva y ninguna de las dos cuenta como corrección aplicada.`);
}

export async function qaStage(ctx: StoryRunCtx, cfg: PipelineConfig) {
  const qa = ctx.qa!; const proc = processesRepo(ctx.slug).get(ctx.processId)!; const r = proc.result!; const p = r.pipeline!;
  emit(ctx, 'qa', 'QA está evaluando la evidencia: diff, typecheck, pruebas y compilación.', { phase: 'qa', aiCall: true });
  const pendingQa = proc.steps.find(s => s.role === 'reviewer' && s.status === 'pending');
  // QA recibe también el manifiesto (qué estaba planificado, qué está de verdad en el worktree), la comprobación previa sin IA, la evidencia de las pruebas y sus hallazgos anteriores.
  // Entrega incremental: estado de cada comprobación y, si QA ya revisó un commit anterior, el diff completo solo de lo que cambió.
  let unchanged: string[] = []; const reviewed = r.manifest?.reviewedCommit ?? null; let checks: import('@portal-ia/domain').DeliveryCheck[] = [];
  if (r.manifest) {
    const units = await import('./storyUnits.ts'); checks = units.deliveryChecks(proc);
    if (reviewed && r.applied?.worktree) {
      try { const changed = new Set((await git(r.applied.worktree, ['diff', '--name-only', reviewed, 'HEAD'])).split('\n').map(x => x.trim()).filter(Boolean)); unchanged = r.changes.filter(c => !c.error && !changed.has(c.path)).map(c => c.path); }
      catch { unchanged = []; /* commit anterior inalcanzable: revisión completa */ }
    }
  }
  const user = qaEvidencePrompt({ criterion: ctx.item.criterion, plan: ctx.plan, summary: r.implementationSummary ?? '', changes: r.changes, verifications: sinceApplied(r), required: cfg.commands, attempts: attemptsSummary(p), consultText: ctx.consultText, manifest: r.manifest ?? null, previousFindings: r.review?.verdict === 'rejected' ? r.review.findings ?? [] : [], tests: testsEvidence(sinceApplied(r)), checks, unchangedSinceReview: unchanged, reviewedCommit: reviewed, external: r.externalCorrections ?? [] });
  const system = sys(qa, ctx.project, ctx.item);
  let res = await stepCall(ctx, qa, 'reviewer', pendingQa ? pendingQa.title : `Revisión de QA con evidencia (tras corrección ${p.corrections})`, 'Puerta de calidad con evidencia del sandbox', system, user, 6000, pendingQa?.id, QA_SCHEMA);
  let verdict = parseQaVerdict(res.text);
  // Una sola reparación de formato del veredicto (si queda margen de reparaciones), para no gastar en un JSON roto.
  if (verdict.verdict === 'unable_to_verify' && /no devolvió un veredicto legible/.test(verdict.summary) && pipelineOf(ctx.slug, ctx.processId).outputRepairs < cfg.maxOutputRepairs) {
    updatePipeline(ctx.slug, ctx.processId, { outputRepairs: pipelineOf(ctx.slug, ctx.processId).outputRepairs + 1 });
    res = await stepCall(ctx, qa, 'reviewer', 'Revisión de QA (veredicto en formato válido)', 'El veredicto anterior no era JSON válido', system, `Tu veredicto anterior no era JSON válido. Reescríbelo SOLO como JSON con las claves verdict, summary, findings y suggestedTests, sin cambiar tu evaluación.\n\n${clip(res.text, 8000)}`, 3000);
    verdict = parseQaVerdict(res.text);
  }
  const fresh = processesRepo(ctx.slug).get(ctx.processId)!.result!;
  const gated = enforceQaGate(verdict, cfg.commands, sinceApplied(fresh));
  updateResult(ctx.slug, ctx.processId, x => ({ ...x, review: gated }));
  updatePipeline(ctx.slug, ctx.processId, { lastQaCommit: fresh.applied?.commit ?? null });
  if (fresh.manifest) updateResult(ctx.slug, ctx.processId, x => x.manifest ? { ...x, manifest: { ...x.manifest, reviewedCommit: fresh.applied?.commit ?? null } } : x);
  const label = gated.verdict === 'approved' ? 'QA aprobó la implementación con evidencia.' : gated.verdict === 'rejected' ? `QA rechazó: ${actionableFindings(gated).length} hallazgo(s) con evidencia.` : gated.verdict === 'blocked_environment' ? 'QA no pudo validar por el entorno.' : 'QA no pudo verificar con la evidencia disponible.';
  emit(ctx, 'qa', label, { costUsd: res.costUsd, detail: [gated.overridden, gated.summary].filter(Boolean).join(' ') });
}

/**
 * Avanza el pipeline desde el estado actual del proceso hasta un final: verificado, pausado o detenido. Es reentrante:
 * «Continuar» vuelve a llamarlo y retoma donde quedó (lo ya verificado en el commit actual no se repite).
 */
export async function runPipelineStages(ctx: StoryRunCtx): Promise<PipelineStatus> {
  const cfg = pipelineOf(ctx.slug, ctx.processId).config;
  // Entrega incremental (procesos con manifiesto): unidades, comprobación previa a QA y correcciones dirigidas.
  const units = processesRepo(ctx.slug).get(ctx.processId)!.result!.manifest ? await import('./storyUnits.ts') : null;
  for (let guard = 0; guard < 60; guard++) {
    checkCancelled(ctx);
    checkDuration(ctx, cfg);
    if (units && await units.advanceUnits(ctx, cfg)) continue;
    const p = pipelineOf(ctx.slug, ctx.processId);
    const r = processesRepo(ctx.slug).get(ctx.processId)!.result!;
    if (!r.applied) { await applyInWorktree(ctx); continue; }
    if (cfg.autoVerify) {
      const failed = await verifyStage(ctx, cfg);
      // Solo fallan pruebas ajenas a la historia: se repite «test» una vez (sin IA) antes de pagar una corrección.
      if (failed && await retryForeignFailure(ctx, failed)) continue;
      // Verificación en verde: antes de QA, ¿las pruebas nuevas se ejecutaron de verdad? (sin IA)
      if (!failed && units && units.afterVerification(ctx, cfg)) continue;
      if (failed) {
        const sig = verificationSignature(failed);
        const failures = bumpFailure(p.failures, sig, `${failed.command} falla`);
        updatePipeline(ctx.slug, ctx.processId, { failures });
        const count = failures.find(f => f.signature === sig)!.count;
        if (count > cfg.maxIdenticalFailures) throw new PipelinePause('repeated_failure', `El mismo fallo de ${failed.command} se repitió ${count} veces tras corregirlo: el equipo se detiene para no gastar más. Revisa el diagnóstico.`);
        if (p.corrections >= cfg.maxCorrections) throw new PipelinePause('limit', `${failed.command} sigue fallando y se alcanzó el máximo de correcciones autorizadas (${cfg.maxCorrections}). Lo hecho se conserva.`);
        emit(ctx, 'verify', FAIL_MSG[failed.command] ?? `${failed.command} falla. El equipo está preparando una corrección.`, { phase: 'correcting', detail: verificationEvidence(failed).split('\n').slice(0, 6).join(' ') });
        if (units) { units.startRound(ctx, cfg, 'verification', units.verificationFindings(failed)); continue; }
        const d = diagnosticsFor(failed);
        if (!await correct(ctx, cfg, `La verificación «${failed.command}» falla en el sandbox:\n${verificationEvidence(failed)}`, Array.from(new Set([...d.map(x => x.file).filter(Boolean) as string[], ...filesIn(failed.output)])))) ineffectiveCorrection(ctx);
        continue;
      }
    }
    if (!ctx.qa) {
      const done = { state: 'verified' as const, phase: 'finished' as const, reason: null, pauseKind: null, finishedAt: now() };
      updatePipeline(ctx.slug, ctx.processId, done, { kind: 'done', message: `Implementación completada. ${cfg.autoVerify ? `${cfg.commands.join(', ')} aprobados en el sandbox.` : 'Sin verificación automática.'} QA omitida por el propietario. Lista para tu revisión.` });
      return pipelineOf(ctx.slug, ctx.processId);
    }
    // Tras una corrección del Evaluador Gauntlet, QA no vuelve a revisar lo mismo: el sandbox ya re-verificó el commit y
    // lo re-evalúa (o ya lo evaluó) el Evaluador. No se pagan dos revisiones del mismo commit.
    const gauntletReeval = r.review?.verdict === 'approved' && !!r.gauntlet && (!!r.gauntlet.pendingReeval || r.gauntlet.rounds.at(-1)?.commit === r.applied.commit);
    const qaRan = !gauntletReeval && (p.lastQaCommit !== r.applied.commit || !r.review?.verdict);
    if (qaRan) await qaStage(ctx, cfg);
    const v = processesRepo(ctx.slug).get(ctx.processId)!.result!.review!;
    if (v.verdict === 'approved') {
      const names: Record<string, string> = { typecheck: 'Typecheck', test: 'pruebas', build: 'compilación' };
      const ran = cfg.autoVerify ? `${cfg.commands.map(c => names[c]).join(', ').replace(/, ([^,]*)$/, ' y $1')} aprobad${cfg.commands.length > 1 ? 'os' : 'o'}.` : '';
      // Evaluación Gauntlet (según el modo): crítico independiente sobre el commit aprobado; puede abrir una corrección dirigida.
      const g = await gauntletStage(ctx, cfg);
      if (g.outcome === 'correct') {
        emit(ctx, 'gauntlet', `El Evaluador encontró ${g.toFix.length} brecha(s) con evidencia: corrección dirigida del Desarrollador (no del Evaluador) y nueva evaluación.`, { phase: 'correcting' });
        if (units) { units.startRound(ctx, cfg, 'gauntlet', g.toFix.map(toCorrection)); continue; }
        if (!await correct(ctx, cfg, `El Evaluador Gauntlet encontró brechas con evidencia:\n${g.toFix.map(f => `- [${f.severity}] ${f.text}${f.file ? ` (${f.file})` : ''}${f.evidence ? `\n  evidencia: ${f.evidence.split('\n').slice(0, 3).join(' ')}` : ''}${f.expected ? `\n  esperado: ${f.expected}` : ''}`).join('\n')}`, g.toFix.map(f => f.file).filter(Boolean) as string[])) ineffectiveCorrection(ctx);
        continue;
      }
      const gNote = g.state && g.state.status !== 'skipped' ? ` Gauntlet (${g.state.mode}): ${g.state.status === 'passed' ? 'todos los criterios con evidencia' : 'aprobado con hallazgos menores documentados'} en ${g.state.rounds.length} ronda(s).` : '';
      updatePipeline(ctx.slug, ctx.processId, { state: 'verified', phase: 'finished', reason: null, pauseKind: null, finishedAt: now() }, { kind: 'done', message: `Implementación completada. ${ran} QA validó los cambios.${gNote} Lista para tu revisión.` });
      return pipelineOf(ctx.slug, ctx.processId);
    }
    if (v.verdict === 'blocked_environment') throw new PipelinePause('environment', `QA no pudo validar por el entorno: ${v.overridden ?? v.summary}`);
    if (v.verdict === 'unable_to_verify') throw new PipelinePause('qa', `QA no pudo verificar la implementación: ${v.overridden ?? v.summary} Revisa la evidencia y decide.`);
    // Rechazo accionable: corrección acotada con los hallazgos. Solo cuenta como rechazo repetido si QA volvió a evaluar
    // (HU-155: una corrección sin efecto volvía a contar el MISMO veredicto y el aviso decía «QA rechazó 3 veces» con una sola revisión).
    if (qaRan) {
      const sig = `qa|${rejectionSignature(v)}`;
      const failures = bumpFailure(pipelineOf(ctx.slug, ctx.processId).failures, sig, 'QA rechaza por los mismos motivos');
      updatePipeline(ctx.slug, ctx.processId, { failures });
      const count = failures.find(f => f.signature === sig)!.count;
      if (count > cfg.maxIdenticalFailures) throw new PipelinePause('repeated_failure', `QA rechazó ${count} veces por los mismos motivos tras corregirlo: el equipo se detiene para no gastar más.`);
    }
    if (pipelineOf(ctx.slug, ctx.processId).corrections >= cfg.maxCorrections) throw new PipelinePause('limit', `QA sigue rechazando y se alcanzó el máximo de correcciones autorizadas (${cfg.maxCorrections}). Lo hecho se conserva para tu revisión.`);
    emit(ctx, 'qa', 'QA rechazó la implementación. El equipo está preparando una corrección con sus hallazgos.', { phase: 'correcting' });
    const findings = actionableFindings(v);
    if (units) { units.startRound(ctx, cfg, 'qa', findings); continue; }
    if (!await correct(ctx, cfg, `QA rechazó la implementación (con evidencia):\n${findings.map(f => `- [${f.severity}] ${f.text}${f.file ? ` (${f.file})` : ''}${f.evidence ? `\n  evidencia: ${f.evidence.split('\n').slice(0, 3).join(' ')}` : ''}`).join('\n')}\nResumen de QA: ${v.summary}`, findings.map(f => f.file).filter(Boolean) as string[])) ineffectiveCorrection(ctx);
  }
  throw new PipelinePause('limit', 'El pipeline alcanzó su número máximo de pasos internos.');
}

/**
 * Fallo del PROVEEDOR durante el pipeline (tras la entrega del Desarrollador): no tumba el proceso. Plazo agotado o
 * conexión caída tras los reintentos → pausa con lo hecho conservado; «Continuar» repite solo la llamada que falló.
 * Credenciales → pausa por permiso. Lo desconocido no se convierte en pausa (se detiene con su diagnóstico).
 */
export function providerPause(e: any): PipelinePause | null {
  const f: ProcessFailure | undefined = e?.failure; if (!f?.class) return null;
  // Conector Claude Code: nunca se cambia solo a un origen facturable; se pausa con el motivo y lo hecho se conserva.
  if (f.providerCode === 'usage_limit') return new PipelinePause('subscription_limit', `${f.detail} Lo hecho se conserva y no se ha cambiado a otro proveedor facturable. «Continuar» cuando se renueve el límite, o asigna otro backend al agente.`);
  if (f.providerCode === 'max_turns') return new PipelinePause('max_turns', `${f.detail} Lo hecho se conserva (commits, salidas y verificaciones). No se repite el mismo encargo: el siguiente intento es acotado o decides tú.`);
  if (f.providerCode === 'origin_not_allowed') return new PipelinePause('permission', `${f.detail} Lo hecho se conserva.`, f.providerCode);
  if (f.providerCode === 'backend_unavailable') return new PipelinePause('permission', `Claude Code no está disponible para este paso: ${f.detail} Lo hecho se conserva y no se ha cambiado a otro proveedor facturable. Corrígelo y pulsa «Continuar».`, f.providerCode);
  if (f.class === 'PROVIDER_TIMEOUT') return new PipelinePause('provider_timeout', `El proveedor no respondió a tiempo: ${f.detail} No se reintenta solo (la llamada pudo facturarse); lo hecho se conserva y «Continuar» repite solo esta llamada.`);
  if (f.class === 'PROVIDER_CONNECTION_ERROR') return new PipelinePause('provider_error', `No se pudo completar la llamada al proveedor tras los reintentos permitidos: ${f.detail} Lo hecho se conserva; «Continuar» la repite.`);
  if (f.class === 'PERMISSION_REQUIRED' && f.providerCode) return new PipelinePause('permission', `El proveedor rechazó la credencial o el permiso (${f.providerCode}): ${f.detail} Revisa el proveedor en Proveedores y continúa.`);
  return null;
}

/** Cierra el pipeline en pausa/parada con el motivo (sin perder nada) y lo deja listo para «Continuar». */
export function pausePipeline(ctx: StoryRunCtx, pause: PipelinePause) {
  const stopped = ['repeated_failure', 'limit', 'qa', 'no_changes', 'refusal', 'provider_refusal', 'unsupported', 'unknown', 'plan', 'disagreement', 'gauntlet'].includes(pause.kind);
  const CLASS: Partial<Record<PipelinePauseKind, AgentFailureKind>> = { budget: 'BUDGET_EXHAUSTED', network: 'PERMISSION_REQUIRED', environment: 'ENVIRONMENT_FAILURE', limit: 'RECOVERABLE_IMPLEMENTATION_ERROR', repeated_failure: 'RECOVERABLE_IMPLEMENTATION_ERROR', missing_information: 'MISSING_INFORMATION', permission: 'PERMISSION_REQUIRED', unsupported: 'UNSUPPORTED_CAPABILITY', provider_refusal: 'PROVIDER_REFUSAL', provider_timeout: 'PROVIDER_TIMEOUT', provider_error: 'PROVIDER_CONNECTION_ERROR', max_turns: 'CLAUDE_CODE_MAX_TURNS_EXHAUSTED', interrupted: 'UNKNOWN_FAILURE', unknown: 'UNKNOWN_FAILURE', too_large: 'INCOMPLETE_OUTPUT', incomplete: 'RECOVERABLE_IMPLEMENTATION_ERROR' };
  const cur = pipelineOf(ctx.slug, ctx.processId);
  updatePipeline(ctx.slug, ctx.processId, { state: stopped ? 'stopped' : 'paused', pauseKind: pause.kind, providerCode: pause.providerCode, reason: pause.message, phase: 'finished', finishedAt: now(), failureClass: cur.failureClass && ['missing_information', 'permission', 'unsupported', 'provider_refusal'].includes(pause.kind) ? cur.failureClass : CLASS[pause.kind] ?? cur.failureClass ?? null }, { kind: 'pause', message: pause.message });
}

// ---------------------------------------------------------------- Reanudar (sin repetir lo hecho)

/**
 * «Continuar» un proceso de historia con pipeline (pausado, detenido o terminado sin pipeline) o reparar una entrega
 * fallida: retoma desde el estado guardado. Lo llama la ruta tras la autorización del propietario.
 */
/** Contexto de ejecución de un proceso de historia ya creado (para reanudarlo o verificarlo sin repetir lo hecho). */
export function storyRunContext(slug: string, processId: string, log: (o: any, m: string) => void, isCancelled: () => boolean): { ctx: StoryRunCtx; involved: string[]; repoPath: string } {
  const procs = processesRepo(slug); const agents = agentsRepo(slug); const backlog = backlogRepo(slug);
  const proc = procs.get(processId)!; const item = backlog.get(proc.backlogItemId!)!;
  const project = projectsRepo(slug).get(proc.projectId)!; const repo = projectsRepo(slug).repository(project.id)!;
  const devStep = proc.steps.find(s => s.role === 'implementer') ?? proc.steps[1]; const qaStep = proc.steps.find(s => s.role === 'reviewer');
  const dev = agents.get(devStep.agentId)!; const qa = qaStep ? agents.get(qaStep.agentId) ?? null : null;
  const r = proc.result!;
  const consultText = r.consultations?.length ? `\n# Aportaciones de especialistas (tenlas en cuenta)\n${r.consultations.map(c => `## ${c.agentName} · ${c.role}\n${c.text}`).join('\n\n')}\n` : '';
  const team = Array.from(new Set(proc.steps.map(s => s.agentId))).map(id => agents.get(id)).filter(Boolean) as Agent[];
  const ctx: StoryRunCtx = { slug, processId, item, project, repoPath: repo.path, plan: r.plan, consultText, iterText: '', dev, qa, team, log, isCancelled, injected: new Map() };
  return { ctx, involved: Array.from(new Set([dev.id, ...(qa ? [qa.id] : [])])), repoPath: repo.path };
}

export async function resumeStory(slug: string, processId: string, log: (o: any, m: string) => void, isCancelled: () => boolean) {
  const procs = processesRepo(slug); const agents = agentsRepo(slug); const backlog = backlogRepo(slug);
  const { ctx, involved, repoPath } = storyRunContext(slug, processId, log, isCancelled);
  const item = ctx.item; const repo = { path: repoPath };
  involved.forEach(id => agents.setStatus(id, 'active'));
  backlog.setStatus(item.id, 'in_progress', processId);
  let status: Process['status'] = 'done'; let error: string | null = null;
  try {
    updatePipeline(slug, processId, { state: 'running', reason: null, pauseKind: null, finishedAt: null }, { kind: 'info', message: 'El propietario autorizó continuar. El equipo retoma donde lo dejó.' });
    // Un commit que el equipo no hizo (o cambios sin confirmar) deja obsoleta la evidencia guardada: no se paga nada contra ella.
    const drift = await worktreeDrift(procs.get(processId)!.result);
    if (drift && drift.state !== 'same') throw new PipelinePause('external', driftMessage(drift));
    const cur = procs.get(processId)!.result!;
    if (cur.manifest) (await import('./storyUnits.ts')).prepareResume(ctx);
    else if (!cur.applied && !cur.changes.some(c => !c.error)) {
      const outs = implementerOutputs(procs.get(processId)!);
      // Sin entrega del Desarrollador no hay nada que retomar (p. ej. interrumpido durante el plan): no se inventa nada.
      if (!outs.length) throw new StoryFailure({ kind: 'internal', class: 'UNKNOWN_FAILURE', detail: 'No hay ninguna entrega del Desarrollador que retomar (se interrumpió antes). Vuelve a ejecutar la historia con un presupuesto nuevo.' });
      const outcome = await settleImplementation(ctx, outs, { config: cur.pipeline!.config });
      if (outcome === 'no_changes') throw new PipelinePause('no_changes', 'El Desarrollador concluye que la historia no requiere cambios de código. Revisa su justificación.');
    }
    updateResult(slug, processId, x => ({ ...x, failure: null }));
    if (procs.get(processId)!.result!.pipeline!.config.autoApply) await runPipelineStages(ctx);
    else updatePipeline(slug, processId, { state: 'stopped', phase: 'finished', finishedAt: now(), reason: 'Cambios listos para revisar (sin aplicar automáticamente).' });
  } catch (e: any) {
    const pp = e instanceof PipelinePause ? null : providerPause(e);
    if (pp && e?.failure) updateResult(slug, processId, x => ({ ...x, failure: e.failure }));
    if (e instanceof PipelinePause) pausePipeline(ctx, e);
    else if (pp) pausePipeline(ctx, pp);
    else if (e?.cancelled) { status = 'cancelled'; pausePipeline(ctx, new PipelinePause('cancelled', 'Cancelado por el propietario. Lo hecho se conserva.')); }
    else if (e?.budget) pausePipeline(ctx, new PipelinePause('budget', e.message));
    else { status = 'failed'; error = e.message; updateResult(slug, processId, x => ({ ...x, failure: e instanceof StoryFailure ? e.failure : e?.failure ?? { kind: 'internal', detail: e.message } })); updatePipeline(slug, processId, { state: 'stopped', phase: 'finished', finishedAt: now(), reason: e.message }, { kind: 'error', message: e.message }); }
  } finally {
    involved.forEach(id => agents.setStatus(id, 'inactive'));
    const fin = procs.get(processId)!.result!;
    backlog.setStatus(item.id, fin.applied || fin.changes.some(c => !c.error) ? 'review' : 'pending', processId);
    procs.finish(processId, status, error);
    log({ processId, state: fin.pipeline?.state, spent: procs.get(processId)?.spentUsd.toFixed(4) }, 'pipeline de la historia detenido');
    // Detección determinista (sin IA) también al reanudar: bloqueos, negativas, plazos, verificaciones fallidas.
    try { const ls = recordDetections(slug, processId, repo.path); if (ls.length) log({ processId, lessons: ls.map(l => l.detector) }, 'lecciones detectadas'); } catch (e: any) { log({ err: e.message }, 'detección de lecciones fallida'); }
  }
}

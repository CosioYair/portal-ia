import fs from 'node:fs';
import path from 'node:path';
import type { Agent, BacklogItem, DevOutputAssessment, ExecutionResult, ModelInfo, PipelineConfig, PipelineEvent, PipelineEventKind, PipelinePauseKind, PipelinePhase, PipelineStatus, Process, ProcessFailure, ProposedChange, ProviderId, StoryPlan, TeamRole, VerificationRun } from '@portal-ia/domain';
import { costUsd, estimatePricing, estimateTokens, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';
import { practicesFor } from './agentTemplates.ts';
import { assessDeveloperOutput, clip, mergeChanges, type ParsedDevOutput } from './devOutput.ts';
import { filesIn, parseBuildErrors, parseFailingTests, parseTypeScriptErrors } from './diagnostics.ts';
import { requirePolicy } from './executionPolicy.ts';
import { injectLessons } from './lessons.ts';
import { actionableFindings, enforceQaGate, parseQaVerdict, QA_VERDICT_SCHEMA, qaEvidencePrompt, rejectionSignature, verificationEvidence } from './qaGate.ts';
/** Veredicto de QA con salida estructurada nativa del proveedor (si la admite); el motor lo valida igualmente. */
const QA_SCHEMA = { name: 'veredicto_qa', description: 'Veredicto de la puerta de calidad con hallazgos y evidencia.', schema: QA_VERDICT_SCHEMA as unknown as Record<string, unknown> };
import { annotateChanges, applyChanges, changesSinceBase, checkStaleChanges, commitInWorktree, readRepoFile, safeRelPath, type RawChange } from './repoWrite.ts';
import { DEPS_MISSING_EXIT } from './sandbox.ts';
import { FILE_FORMAT, PATCH_ONLY_FORMAT, sys } from './storyPrompts.ts';
import { runVerification, sandboxDeps } from './verification.ts';

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
const now = () => new Date().toISOString();
export const isTruncatedStop = (stop: string | null | undefined) => stop === 'max_tokens' || stop === 'length';

export class PipelinePause extends Error { constructor(public kind: PipelinePauseKind, message: string) { super(message); } }
export class StoryFailure extends Error { constructor(public failure: ProcessFailure) { super(failure.detail); } }

// ---------------------------------------------------------------- Llamadas a agentes

export interface CallResult { text: string; stopReason: string | null; inputTokens: number; outputTokens: number; costUsd: number }

/** Lo que se exige que quede de presupuesto antes de una llamada: la entrada más la mitad de la salida máxima (criterio único del Portal). */
export function estimateCallUsd(agent: Agent, system: string, user: string, maxTokens: number): number {
  const p = estimatePricing(agent.config.provider, agent.config.model);
  return (estimateTokens(system + user) * p.inPerM + maxTokens * p.outPerM * 0.5) / 1_000_000;
}

export function budgetCheck(slug: string, processId: string, agent: Agent, system: string, user: string, maxTokens: number): { ok: boolean; needed: number; remaining: number } {
  const cur = processesRepo(slug).get(processId)!;
  const needed = estimateCallUsd(agent, system, user, maxTokens); const remaining = cur.budgetUsd - cur.spentUsd;
  return { ok: needed <= remaining, needed, remaining };
}

/**
 * Una llamada de un paso (con lecciones validadas y prácticas inyectadas, registro de tokens/costo y política).
 * Con `history` (continuación) acumula en el mismo paso. Lanza `{ budget: true }` si el presupuesto no alcanza.
 */
export async function callAgentStep(slug: string, processId: string, stepId: string, system0: string, user: string, maxTokens: number,
  opts: { history?: { role: 'user' | 'assistant'; content: string }[]; injected: Map<string, string>; log: (o: any, m: string) => void; schema?: { name: string; description?: string; schema: Record<string, unknown> } }): Promise<CallResult> {
  const procs = processesRepo(slug); const proc = procs.get(processId)!;
  const step = proc.steps.find(s => s.id === stepId)!; const agent = agentsRepo(slug).get(step.agentId)!;
  if (!opts.injected.has(stepId)) {
    const role = (step.role ?? 'implementer') as TeamRole;
    opts.injected.set(stepId, injectLessons(slug, step.id, system0, { projectId: proc.projectId, role, tags: [] }, practicesFor(slug, agent)).system);
  }
  const system = opts.injected.get(stepId)!;
  const providerId = agent.config.provider as ProviderId;
  const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
  if (!cred || prow.status !== 'connected') throw Object.assign(new Error(`El proveedor ${providerId} no está conectado.`), { failure: { kind: 'provider', detail: `El proveedor ${providerId} no está conectado.` } });
  const models: ModelInfo[] = JSON.parse(prow.models_json);
  const b = budgetCheck(slug, processId, agent, system, user, maxTokens);
  if (!b.ok) throw Object.assign(new Error(`Presupuesto insuficiente para «${step.title}» (gastado ${proc.spentUsd.toFixed(2)} de ${proc.budgetUsd.toFixed(2)} USD; esta llamada necesita ≈ ${b.needed.toFixed(2)} USD).`), { budget: true, needed: b.needed, remaining: b.remaining });
  procs.stepStart(step.id);
  const startedAt = now();
  try {
    requirePolicy('ai_call', { slug, processId, agentId: agent.id, projectId: proc.projectId, authorized: true });
    const res = await getAdapter(providerId)!.complete(decryptSecret(cred.ciphertext), { workspaceId: prow.workspace_id }, { model: agent.config.model, system, user, maxTokens, effort: agent.config.effort, supportsEffort: !!models.find(m => m.id === agent.config.model)?.supportsEffort, history: opts.history, responseSchema: opts.schema });
    const cost = costUsd(providerId, agent.config.model, res.inputTokens, res.outputTokens);
    const prev = procs.get(processId)!.steps.find(s => s.id === stepId)!;
    // Un paso puede necesitar varias llamadas (continuación de una respuesta cortada): acumulamos.
    const acc = opts.history?.length ? prev : { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    procs.stepFinish(step.id, 'done', { tokensIn: acc.inputTokens + res.inputTokens, tokensOut: acc.outputTokens + res.outputTokens, cost: acc.costUsd + cost, outputMd: opts.history?.length ? `${opts.history.filter(h => h.role === 'assistant').map(h => h.content).join('')}${res.text}` : res.text });
    procs.addUsage(processId, res.inputTokens, res.outputTokens, cost);
    procs.logExecution({ projectId: proc.projectId, agentId: agent.id, kind: 'story_step', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
    opts.log({ step: step.title, tokens: res.inputTokens + res.outputTokens, cost: cost.toFixed(4), stop: res.stopReason }, 'paso completado');
    return { text: res.text, stopReason: res.stopReason, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: cost };
  } catch (e) {
    const err = e instanceof ProviderRequestError ? e.error : null;
    let msg = err ? err.message : (e as Error).message;
    const maybeBilled = !err || err.code === 'network' || (err.httpStatus ?? 0) >= 500;
    const estIn = maybeBilled ? estimateTokens(system + user) : 0; const estCost = maybeBilled ? costUsd(providerId, agent.config.model, estIn, 0) : 0;
    if (maybeBilled) msg += ` Costo estimado de la entrada enviada: ${estCost.toFixed(4)} USD (sin confirmación del proveedor).`;
    procs.stepFinish(step.id, 'failed', { tokensIn: estIn, cost: estCost, error: msg });
    if (maybeBilled) procs.addUsage(processId, estIn, 0, estCost);
    procs.logExecution({ projectId: proc.projectId, agentId: agent.id, kind: 'story_step', status: 'failed', tokensIn: estIn, tokensOut: 0, cost: estCost, startedAt });
    throw Object.assign(new Error(msg), { failure: { kind: err ? 'provider' : 'internal', detail: msg } satisfies ProcessFailure });
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
function updatePipeline(slug: string, id: string, patch: Partial<PipelineStatus>, ev?: Omit<PipelineEvent, 'at'>) {
  updateResult(slug, id, r => r.pipeline ? { ...r, pipeline: { ...r.pipeline, ...patch, events: ev ? [...r.pipeline.events, { at: now(), ...ev }].slice(-80) : r.pipeline.events } } : r);
}
const pipelineOf = (slug: string, id: string) => processesRepo(slug).get(id)!.result!.pipeline!;
function emit(ctx: StoryRunCtx, kind: PipelineEventKind, message: string, extra: { detail?: string | null; aiCall?: boolean; costUsd?: number | null; phase?: PipelinePhase } = {}) {
  const { phase, ...rest } = extra;
  updatePipeline(ctx.slug, ctx.processId, phase ? { phase } : {}, { kind, message, ...rest });
  ctx.log({ processId: ctx.processId, kind }, message);
}

// ---------------------------------------------------------------- Contexto de una ejecución

export interface StoryRunCtx {
  slug: string; processId: string; item: BacklogItem; project: { id: string; name: string; description: string };
  repoPath: string; plan: StoryPlan | null; consultText: string; iterText: string;
  dev: Agent; qa: Agent | null;
  log: (o: any, m: string) => void; isCancelled: () => boolean; injected: Map<string, string>;
}

const fileExistsIn = (base: string) => (rel: string) => { try { return fs.existsSync(path.join(base, safeRelPath(rel))); } catch { return false; } };
const checkCancelled = (ctx: StoryRunCtx) => { if (ctx.isCancelled()) throw Object.assign(new Error('cancelado'), { cancelled: true }); };

/** Llamada de un agente en un paso NUEVO (reparación, corrección, nueva revisión de QA), con comprobación de presupuesto previa. */
async function stepCall(ctx: StoryRunCtx, agent: Agent, role: TeamRole, title: string, reason: string, system: string, user: string, maxTokens: number, reuseStepId?: string, schema?: { name: string; description?: string; schema: Record<string, unknown> }): Promise<CallResult & { stepId: string }> {
  const b = budgetCheck(ctx.slug, ctx.processId, agent, system, user, maxTokens);
  if (!b.ok) throw new PipelinePause('budget', `La siguiente llamada («${title}», ≈ ${b.needed.toFixed(2)} USD) superaría el presupuesto autorizado: quedan ${Math.max(0, b.remaining).toFixed(2)} USD. No se ha llamado a la IA; lo hecho se conserva.`);
  const stepId = reuseStepId ?? processesRepo(ctx.slug).addStep(ctx.processId, { agentId: agent.id, agentName: agent.config.name, title, model: agent.config.model, role, reason }).id;
  const res = await callAgentStep(ctx.slug, ctx.processId, stepId, system, user, maxTokens, { injected: ctx.injected, log: ctx.log, schema });
  return { ...res, stepId };
}

// ---------------------------------------------------------------- 1 · De la respuesta del Desarrollador a cambios válidos

export interface DevOutput { text: string; stopReason: string | null }

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
  const resend = Array.from(new Set([...(a.truncatedFile ? [a.truncatedFile] : []), ...bad.map(c => c.path)]));
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

/**
 * Convierte las salidas del Desarrollador en cambios válidos: recuperación local primero (sin IA) y, si no basta y está
 * autorizado, reparaciones acotadas del mismo Desarrollador. Devuelve 'ok' (cambios listos), 'no_changes' o lanza
 * StoryFailure / PipelinePause.
 */
export async function settleImplementation(ctx: StoryRunCtx, outputs: DevOutput[], opts: { config: PipelineConfig | null }): Promise<'ok' | 'no_changes'> {
  const knownFiles = ctx.plan ? [...ctx.plan.filesToRead, ...ctx.plan.filesToChange] : [];
  const exists = fileExistsIn(ctx.repoPath);
  const evaluate = () => {
    let pool: RawChange[] = []; let meta: ParsedDevOutput | null = null; let last: DevOutputAssessment | null = null; let lastText = '';
    for (const o of outputs) {
      const { parsed, assessment } = assessDeveloperOutput(o.text, { stopReason: o.stopReason, exists, knownFiles });
      pool = mergeChanges(pool, parsed.changes); last = assessment; lastText = o.text;
      if (!meta || (!meta.summary && parsed.summary) || (!meta.manualSteps.length && parsed.manualSteps.length)) meta = meta ? { ...parsed, summary: meta.summary || parsed.summary, userFacing: meta.userFacing || parsed.userFacing, manualSteps: meta.manualSteps.length ? meta.manualSteps : parsed.manualSteps, runtimeChecks: meta.runtimeChecks.length ? meta.runtimeChecks : parsed.runtimeChecks } : parsed;
    }
    const changes = annotateChanges(ctx.repoPath, pool);
    // Si lo último entregado ya da cambios válidos, cuenta como implementación aunque antes hubiera fallos de forma.
    const kind = last!.kind !== 'implementation' && pool.length && changes.some(c => !c.error) && outputs.length > 1 && last!.kind !== 'truncated' ? 'implementation' : last!.kind;
    return { changes, meta: meta!, assessment: { ...last!, kind, files: pool.length } as DevOutputAssessment, lastText };
  };
  let ev = evaluate();
  let announced = false;
  for (;;) {
    checkCancelled(ctx);
    const valid = ev.changes.filter(c => !c.error); const invalid = ev.changes.filter(c => c.error);
    if (opts.config) updatePipeline(ctx.slug, ctx.processId, { lastAssessment: ev.assessment, phase: 'recovering' });
    if (!announced && ev.assessment.recoveredBy && ev.assessment.recoveredBy !== 'canonical' && opts.config) {
      emit(ctx, 'recovery', 'El Desarrollador entregó un formato incompleto. Recuperando los cambios existentes sin consumir IA.', { detail: `${valid.length} archivo(s) recuperados (${ev.assessment.recoveredBy}). ${ev.assessment.reasons.slice(0, 4).join(' ')}` });
      announced = true;
    }
    if (ev.assessment.kind === 'no_changes' && !valid.length) {
      updateResult(ctx.slug, ctx.processId, r => ({ ...r, changes: [], implementationSummary: `${ev.meta.summary}\n\nSin cambios: ${ev.meta.noChanges ?? ''}`.trim() }));
      return 'no_changes';
    }
    const needsRepair = ev.assessment.kind !== 'implementation' || invalid.length > 0;
    if (!needsRepair) { finalizeImplementation(ctx, ev.meta, ev.changes, ev.assessment); return 'ok'; }
    const repairs = opts.config ? pipelineOf(ctx.slug, ctx.processId).outputRepairs : 0;
    const canRepair = !!opts.config && repairs < opts.config.maxOutputRepairs;
    if (!canRepair) {
      if (valid.length) { finalizeImplementation(ctx, ev.meta, ev.changes, ev.assessment); return 'ok'; }
      const failure: ProcessFailure = ev.assessment.kind === 'refusal'
        ? { kind: 'refusal', detail: `El Desarrollador no completó la tarea: ${ev.assessment.reasons.join(' ')}`, assessment: ev.assessment }
        : { kind: 'output_contract', detail: invalid.length && !ev.assessment.reasons.length ? `Ninguno de los ${invalid.length} cambio(s) del Desarrollador es aplicable: ${invalid.map(c => `${c.path}: ${c.error}`).join(' · ')}` : `El Desarrollador no entregó cambios aplicables en el formato acordado (${ev.assessment.kind}). ${ev.assessment.reasons.slice(0, 4).join(' ')}`, assessment: ev.assessment };
      updateResult(ctx.slug, ctx.processId, r => ({ ...r, changes: ev.changes }));
      throw new StoryFailure(failure);
    }
    emit(ctx, 'repair', 'Corrigiendo la entrega del Desarrollador dentro del presupuesto autorizado.', { phase: 'repairing', aiCall: true, detail: `Intento ${repairs + 1} de ${opts.config!.maxOutputRepairs} · ${ev.assessment.kind}: ${ev.assessment.reasons.slice(0, 3).join(' ')}` });
    const system = sys(ctx.dev, ctx.project, ctx.item);
    const res = await stepCall(ctx, ctx.dev, 'implementer', `Reparación de la entrega (intento ${repairs + 1})`, `Entrega no aplicable (${ev.assessment.kind}): reparación acotada sin repetir el plan`, system, repairPrompt(ctx, ev.assessment, ev.lastText, valid, invalid), 12_000);
    updatePipeline(ctx.slug, ctx.processId, { outputRepairs: repairs + 1 });
    outputs = [...outputs, { text: res.text, stopReason: res.stopReason }];
    const before = JSON.stringify(ev.assessment.reasons);
    ev = evaluate();
    emit(ctx, 'repair', ev.assessment.kind === 'implementation' && !ev.changes.some(c => c.error) ? `Entrega reparada: ${ev.changes.length} archivo(s) aplicables.` : `La reparación no resolvió todo (${ev.assessment.kind}).`, { costUsd: res.costUsd, detail: ev.assessment.reasons.slice(0, 3).join(' ') || null });
    if (ev.assessment.kind !== 'implementation' && JSON.stringify(ev.assessment.reasons) === before) {
      updatePipeline(ctx.slug, ctx.processId, { failures: bumpFailure(pipelineOf(ctx.slug, ctx.processId).failures, `output|${ev.assessment.kind}|${before.slice(0, 80)}`, 'misma entrega no aplicable') });
    }
  }
}

// ---------------------------------------------------------------- 2-6 · Aplicar, verificar, QA y correcciones

function bumpFailure(list: PipelineStatus['failures'], signature: string, label: string) {
  const f = list.find(x => x.signature === signature);
  return f ? list.map(x => x === f ? { ...x, count: x.count + 1 } : x) : [...list, { signature, count: 1, label }];
}
function verificationSignature(v: VerificationRun): string {
  const d = v.command === 'typecheck' ? parseTypeScriptErrors(v.output) : v.command === 'test' ? parseFailingTests(v.output) : parseBuildErrors(v.output);
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
function sinceApplied(r: ExecutionResult): VerificationRun[] {
  if (!r.applied) return [];
  const after = new Date(r.applied.appliedAt).getTime();
  return (r.verifications ?? []).filter(v => new Date(v.startedAt).getTime() >= after);
}

/** Verifica los comandos autorizados; resuelve el entorno sin IA. Devuelve la primera ejecución que falla por el código, o null. */
async function verifyStage(ctx: StoryRunCtx, cfg: PipelineConfig): Promise<VerificationRun | null> {
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
    emit(ctx, 'verify', `Verificando ${cmd} en el sandbox…`, { phase: 'verifying' });
    let run = await runVerification(ctx.slug, ctx.processId, cmd, false);
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

function attemptsSummary(p: PipelineStatus): string[] {
  return p.events.filter(e => e.kind === 'correction' || (e.kind === 'qa' && /rechaz/i.test(e.message)) || e.kind === 'repair').map(e => `${e.message}${e.detail ? ` — ${e.detail}` : ''}`).slice(-8);
}

async function correct(ctx: StoryRunCtx, cfg: PipelineConfig, problem: string, files: string[]) {
  const p = pipelineOf(ctx.slug, ctx.processId); const n = p.corrections + 1;
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

FORMATO DE RESPUESTA:
${PATCH_ONLY_FORMAT}`;
  const res = await stepCall(ctx, ctx.dev, 'implementer', `Corrección ${n}`, `Corrección acotada con la evidencia: ${problem.split('\n')[0].slice(0, 120)}`, sys(ctx.dev, ctx.project, ctx.item), user, 12_000);
  updatePipeline(ctx.slug, ctx.processId, { corrections: n });
  const { parsed, assessment } = assessDeveloperOutput(res.text, { stopReason: res.stopReason, exists: fileExistsIn(wt), knownFiles: affected });
  const fixes = annotateChanges(wt, parsed.changes).filter(c => !c.error);
  if (!fixes.length) {
    emit(ctx, 'correction', `La corrección ${n} no trajo cambios aplicables (${assessment.kind}).`, { costUsd: res.costUsd, detail: assessment.reasons.slice(0, 3).join(' ') || null });
    return;
  }
  requirePolicy('write_worktree', { slug: ctx.slug, processId: ctx.processId, agentId: ctx.dev.id, projectId: ctx.project.id, authorized: true });
  try {
    const c = await commitInWorktree(wt, fixes, `${ctx.item.storyId}: corrección ${n} (pipeline)\n\nProceso: ${ctx.processId}`);
    const all = await changesSinceBase(ctx.repoPath, wt);
    updateResult(ctx.slug, ctx.processId, x => ({ ...x, changes: all, applied: { ...x.applied!, commit: c.commit, files: Array.from(new Set([...x.applied!.files, ...c.files])), appliedAt: now() } }));
    emit(ctx, 'correction', `Corrección ${n} aplicada (commit ${c.commit}). Se repite la verificación.`, { costUsd: res.costUsd, detail: c.files.join(', ') });
  } catch (e: any) {
    emit(ctx, 'correction', `La corrección ${n} no se pudo aplicar: ${e.message}`, { costUsd: res.costUsd });
  }
}

async function qaStage(ctx: StoryRunCtx, cfg: PipelineConfig) {
  const qa = ctx.qa!; const proc = processesRepo(ctx.slug).get(ctx.processId)!; const r = proc.result!; const p = r.pipeline!;
  emit(ctx, 'qa', 'QA está evaluando la evidencia: diff, typecheck, pruebas y compilación.', { phase: 'qa', aiCall: true });
  const pendingQa = proc.steps.find(s => s.role === 'reviewer' && s.status === 'pending');
  const user = qaEvidencePrompt({ criterion: ctx.item.criterion, plan: ctx.plan, summary: r.implementationSummary ?? '', changes: r.changes, verifications: sinceApplied(r), required: cfg.autoVerify ? cfg.commands : [], attempts: attemptsSummary(p), consultText: ctx.consultText });
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
  const gated = enforceQaGate(verdict, cfg.autoVerify ? cfg.commands : [], sinceApplied(fresh));
  updateResult(ctx.slug, ctx.processId, x => ({ ...x, review: gated }));
  updatePipeline(ctx.slug, ctx.processId, { lastQaCommit: fresh.applied?.commit ?? null });
  const label = gated.verdict === 'approved' ? 'QA aprobó la implementación con evidencia.' : gated.verdict === 'rejected' ? `QA rechazó: ${actionableFindings(gated).length} hallazgo(s) con evidencia.` : gated.verdict === 'blocked_environment' ? 'QA no pudo validar por el entorno.' : 'QA no pudo verificar con la evidencia disponible.';
  emit(ctx, 'qa', label, { costUsd: res.costUsd, detail: [gated.overridden, gated.summary].filter(Boolean).join(' ') });
}

/**
 * Avanza el pipeline desde el estado actual del proceso hasta un final: verificado, pausado o detenido. Es reentrante:
 * «Continuar» vuelve a llamarlo y retoma donde quedó (lo ya verificado en el commit actual no se repite).
 */
export async function runPipelineStages(ctx: StoryRunCtx): Promise<PipelineStatus> {
  const cfg = pipelineOf(ctx.slug, ctx.processId).config;
  for (let guard = 0; guard < 40; guard++) {
    checkCancelled(ctx);
    const p = pipelineOf(ctx.slug, ctx.processId);
    if (Date.now() - new Date(p.startedAt).getTime() > cfg.maxDurationMin * 60_000) throw new PipelinePause('duration', `Se alcanzó la duración máxima autorizada (${cfg.maxDurationMin} min). Lo hecho se conserva; puedes continuar.`);
    const r = processesRepo(ctx.slug).get(ctx.processId)!.result!;
    if (!r.applied) { await applyInWorktree(ctx); continue; }
    if (cfg.autoVerify) {
      const failed = await verifyStage(ctx, cfg);
      if (failed) {
        const sig = verificationSignature(failed);
        const failures = bumpFailure(p.failures, sig, `${failed.command} falla`);
        updatePipeline(ctx.slug, ctx.processId, { failures });
        const count = failures.find(f => f.signature === sig)!.count;
        if (count > cfg.maxIdenticalFailures) throw new PipelinePause('repeated_failure', `El mismo fallo de ${failed.command} se repitió ${count} veces tras corregirlo: el equipo se detiene para no gastar más. Revisa el diagnóstico.`);
        if (p.corrections >= cfg.maxCorrections) throw new PipelinePause('limit', `${failed.command} sigue fallando y se alcanzó el máximo de correcciones autorizadas (${cfg.maxCorrections}). Lo hecho se conserva.`);
        emit(ctx, 'verify', FAIL_MSG[failed.command] ?? `${failed.command} falla. El equipo está preparando una corrección.`, { phase: 'correcting', detail: verificationEvidence(failed).split('\n').slice(0, 6).join(' ') });
        const d = failed.command === 'typecheck' ? parseTypeScriptErrors(failed.output) : failed.command === 'test' ? parseFailingTests(failed.output) : parseBuildErrors(failed.output);
        await correct(ctx, cfg, `La verificación «${failed.command}» falla en el sandbox:\n${verificationEvidence(failed)}`, Array.from(new Set([...d.map(x => x.file).filter(Boolean) as string[], ...filesIn(failed.output)])));
        continue;
      }
    }
    if (!ctx.qa) {
      const done = { state: 'verified' as const, phase: 'finished' as const, reason: null, pauseKind: null, finishedAt: now() };
      updatePipeline(ctx.slug, ctx.processId, done, { kind: 'done', message: `Implementación completada. ${cfg.autoVerify ? `${cfg.commands.join(', ')} aprobados en el sandbox.` : 'Sin verificación automática.'} QA omitida por el propietario. Lista para tu revisión.` });
      return pipelineOf(ctx.slug, ctx.processId);
    }
    if (p.lastQaCommit !== r.applied.commit || !r.review?.verdict) await qaStage(ctx, cfg);
    const v = processesRepo(ctx.slug).get(ctx.processId)!.result!.review!;
    if (v.verdict === 'approved') {
      const names: Record<string, string> = { typecheck: 'Typecheck', test: 'pruebas', build: 'compilación' };
      const ran = cfg.autoVerify ? `${cfg.commands.map(c => names[c]).join(', ').replace(/, ([^,]*)$/, ' y $1')} aprobad${cfg.commands.length > 1 ? 'os' : 'o'}.` : '';
      updatePipeline(ctx.slug, ctx.processId, { state: 'verified', phase: 'finished', reason: null, pauseKind: null, finishedAt: now() }, { kind: 'done', message: `Implementación completada. ${ran} QA validó los cambios. Lista para tu revisión.` });
      return pipelineOf(ctx.slug, ctx.processId);
    }
    if (v.verdict === 'blocked_environment') throw new PipelinePause('environment', `QA no pudo validar por el entorno: ${v.overridden ?? v.summary}`);
    if (v.verdict === 'unable_to_verify') throw new PipelinePause('qa', `QA no pudo verificar la implementación: ${v.overridden ?? v.summary} Revisa la evidencia y decide.`);
    // Rechazo accionable: corrección acotada con los hallazgos.
    const sig = `qa|${rejectionSignature(v)}`;
    const failures = bumpFailure(pipelineOf(ctx.slug, ctx.processId).failures, sig, 'QA rechaza por los mismos motivos');
    updatePipeline(ctx.slug, ctx.processId, { failures });
    const count = failures.find(f => f.signature === sig)!.count;
    if (count > cfg.maxIdenticalFailures) throw new PipelinePause('repeated_failure', `QA rechazó ${count} veces por los mismos motivos tras corregirlo: el equipo se detiene para no gastar más.`);
    if (pipelineOf(ctx.slug, ctx.processId).corrections >= cfg.maxCorrections) throw new PipelinePause('limit', `QA sigue rechazando y se alcanzó el máximo de correcciones autorizadas (${cfg.maxCorrections}). Lo hecho se conserva para tu revisión.`);
    emit(ctx, 'qa', 'QA rechazó la implementación. El equipo está preparando una corrección con sus hallazgos.', { phase: 'correcting' });
    const findings = actionableFindings(v);
    await correct(ctx, cfg, `QA rechazó la implementación (con evidencia):\n${findings.map(f => `- [${f.severity}] ${f.text}${f.file ? ` (${f.file})` : ''}${f.evidence ? `\n  evidencia: ${f.evidence.split('\n').slice(0, 3).join(' ')}` : ''}`).join('\n')}\nResumen de QA: ${v.summary}`, findings.map(f => f.file).filter(Boolean) as string[]);
  }
  throw new PipelinePause('limit', 'El pipeline alcanzó su número máximo de pasos internos.');
}

/** Cierra el pipeline en pausa/parada con el motivo (sin perder nada) y lo deja listo para «Continuar». */
export function pausePipeline(ctx: StoryRunCtx, pause: PipelinePause) {
  const stopped = pause.kind === 'repeated_failure' || pause.kind === 'limit' || pause.kind === 'qa' || pause.kind === 'no_changes' || pause.kind === 'refusal';
  updatePipeline(ctx.slug, ctx.processId, { state: stopped ? 'stopped' : 'paused', pauseKind: pause.kind, reason: pause.message, phase: 'finished', finishedAt: now() }, { kind: 'pause', message: pause.message });
}

// ---------------------------------------------------------------- Reanudar (sin repetir lo hecho)

/**
 * «Continuar» un proceso de historia con pipeline (pausado, detenido o terminado sin pipeline) o reparar una entrega
 * fallida: retoma desde el estado guardado. Lo llama la ruta tras la autorización del propietario.
 */
export async function resumeStory(slug: string, processId: string, log: (o: any, m: string) => void, isCancelled: () => boolean) {
  const procs = processesRepo(slug); const agents = agentsRepo(slug); const backlog = backlogRepo(slug);
  const proc = procs.get(processId)!; const item = backlog.get(proc.backlogItemId!)!;
  const project = projectsRepo(slug).get(proc.projectId)!; const repo = projectsRepo(slug).repository(project.id)!;
  const devStep = proc.steps.find(s => s.role === 'implementer') ?? proc.steps[1]; const qaStep = proc.steps.find(s => s.role === 'reviewer');
  const dev = agents.get(devStep.agentId)!; const qa = qaStep ? agents.get(qaStep.agentId) ?? null : null;
  const r = proc.result!;
  const consultText = r.consultations?.length ? `\n# Aportaciones de especialistas (tenlas en cuenta)\n${r.consultations.map(c => `## ${c.agentName} · ${c.role}\n${c.text}`).join('\n\n')}\n` : '';
  const ctx: StoryRunCtx = { slug, processId, item, project, repoPath: repo.path, plan: r.plan, consultText, iterText: '', dev, qa, log, isCancelled, injected: new Map() };
  const involved = Array.from(new Set([dev.id, ...(qa ? [qa.id] : [])]));
  involved.forEach(id => agents.setStatus(id, 'active'));
  backlog.setStatus(item.id, 'in_progress', processId);
  let status: Process['status'] = 'done'; let error: string | null = null;
  try {
    updatePipeline(slug, processId, { state: 'running', reason: null, pauseKind: null, finishedAt: null }, { kind: 'info', message: 'El propietario autorizó continuar. El equipo retoma donde lo dejó.' });
    const cur = procs.get(processId)!.result!;
    if (!cur.applied && !cur.changes.some(c => !c.error)) {
      const outcome = await settleImplementation(ctx, implementerOutputs(procs.get(processId)!), { config: cur.pipeline!.config });
      if (outcome === 'no_changes') throw new PipelinePause('no_changes', 'El Desarrollador concluye que la historia no requiere cambios de código. Revisa su justificación.');
    }
    updateResult(slug, processId, x => ({ ...x, failure: null }));
    if (procs.get(processId)!.result!.pipeline!.config.autoApply) await runPipelineStages(ctx);
    else updatePipeline(slug, processId, { state: 'stopped', phase: 'finished', finishedAt: now(), reason: 'Cambios listos para revisar (sin aplicar automáticamente).' });
  } catch (e: any) {
    if (e instanceof PipelinePause) pausePipeline(ctx, e);
    else if (e?.cancelled) { status = 'cancelled'; pausePipeline(ctx, new PipelinePause('cancelled', 'Cancelado por el propietario. Lo hecho se conserva.')); }
    else if (e?.budget) pausePipeline(ctx, new PipelinePause('budget', e.message));
    else { status = 'failed'; error = e.message; updateResult(slug, processId, x => ({ ...x, failure: e instanceof StoryFailure ? e.failure : e?.failure ?? { kind: 'internal', detail: e.message } })); updatePipeline(slug, processId, { state: 'stopped', phase: 'finished', finishedAt: now(), reason: e.message }, { kind: 'error', message: e.message }); }
  } finally {
    involved.forEach(id => agents.setStatus(id, 'inactive'));
    const fin = procs.get(processId)!.result!;
    backlog.setStatus(item.id, fin.applied || fin.changes.some(c => !c.error) ? 'review' : 'pending', processId);
    procs.finish(processId, status, error);
    log({ processId, state: fin.pipeline?.state, spent: procs.get(processId)?.spentUsd.toFixed(4) }, 'pipeline de la historia detenido');
  }
}

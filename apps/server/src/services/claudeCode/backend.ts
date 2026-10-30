import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAdapter, type CompletionRequest, type CompletionResult } from '@portal-ia/ai-adapters';
import { decryptSecret } from '../../security/crypto.ts';
import { backendLabel, type Agent, type ClaudeCodeBilling, type ExecutionBackend, type LiveCall, type ProviderId } from '@portal-ia/domain';
import { staleCorrectionUnits } from '../failureDiagnosis.ts';
import { config, REPO_ROOT } from '../../config.ts';
import { agentsRepo, claudeCodeRunsRepo, processesRepo, projectsRepo } from '../../db/workspace.ts';
import { repoRoot } from '../repoWrite.ts';
import { connectedWorkersFor, registerJobTask, setProgressListener, submitTerminalTask } from './bridge.ts';
import { BRIDGE_SCRIPT, ccError, runCliTask, type CliEvent, type CliFailedUsage } from './cli.ts';
export { BRIDGE_SCRIPT };
import { cliCommandFor, findCli, lastDetection, verifiedDetection } from './detect.ts';
import { getClaudeCodeSettings, projectAuthorized } from './settings.ts';
import { overageAccepted, saveUsageReport, subscriptionGate } from './usage.ts';

/**
 * Backend de ejecución «Claude Code» para los pasos de un proceso autorizado. El agente del Portal conserva su identidad,
 * papel, permisos e historial: Claude Code solo ejecuta su encargo y el resultado vuelve a ese mismo agente y paso.
 * Nunca cambia por su cuenta a un origen facturable: si la suscripción no está disponible, el error lo decide el motor
 * (pausa, o la API solo si el propietario lo autorizó en los ajustes del conector).
 */
export const agentBackend = (a: Agent): ExecutionBackend => a.config.backend ?? 'api';
export const usesClaudeCode = (a: Agent) => agentBackend(a) !== 'api';

/** Herramientas del puente que puede usar una ejecución gestionada (solo lectura y progreso). */
export const JOB_TOOLS = ['portal_task_context', 'portal_list_files', 'portal_read_file', 'portal_search', 'portal_diff', 'portal_knowledge', 'portal_report_progress'];
let bridgeUrl = `http://${config.host}:${config.port}`;
/** Dirección real en la que escucha el servidor (la fija index.ts al arrancar; las pruebas, la de su servidor). */
export function setBridgeUrl(url: string) { bridgeUrl = url.replace(/\/+$/, ''); }
export const getBridgeUrl = () => bridgeUrl;

export type GateProblem = 'api' | 'disabled' | 'provider' | 'project' | 'console';
/**
 * ¿Puede este agente ejecutar AHORA con su backend de Claude Code? `projectId` null = llamada del espacio (p. ej. el
 * Asistente), sin proyecto que autorizar. La consola exige una consola conectada, vigente y autorizada para el agente:
 * no es un ejecutor desatendido y no debe parecerlo.
 */
export function claudeCodeGate(slug: string, agent: Agent, projectId: string | null): { ok: true } | { ok: false; reason: string; problem: GateProblem } {
  const s = getClaudeCodeSettings();
  if (!usesClaudeCode(agent)) return { ok: false, reason: 'El agente usa la API de su proveedor.', problem: 'api' };
  if (!s.enabled) return { ok: false, reason: 'El conector «Claude Code — Local» está desactivado (Proveedores → Claude Code).', problem: 'disabled' };
  if (agent.config.provider !== 'anthropic') return { ok: false, reason: 'Solo los agentes con modelos de Anthropic pueden ejecutarse con Claude Code.', problem: 'provider' };
  if (projectId !== null && !projectAuthorized(s, slug, projectId)) {
    const name = projectsRepo(slug).get(projectId)?.name ?? 'Este proyecto';
    return { ok: false, reason: `El proyecto «${name}» no está autorizado para Claude Code: autorízalo (aquí mismo o en Proveedores → Claude Code → Proyectos autorizados).`, problem: 'project' };
  }
  if (agentBackend(agent) === 'claude-code-terminal' && !connectedWorkersFor(slug, agent.id).some(w => !w.expired)) {
    return { ok: false, reason: `«${agent.config.name}» usa tu consola de Claude Code, pero no hay ninguna consola conectada y autorizada para él. La consola no trabaja sola: ábrela con el puente del Portal o cambia el agente a «Claude Code (gestionado)».`, problem: 'console' };
  }
  return { ok: true };
}

/** Preparación del equipo de un proceso: backend de cada agente, si puede ejecutar ya y por qué no. Sin efectos. */
export function teamReadiness(slug: string, processId: string) {
  const proc = processesRepo(slug).get(processId); if (!proc) return null;
  const s = getClaudeCodeSettings(); const det = lastDetection(); const agents = agentsRepo(slug);
  const ids = Array.from(new Set(proc.steps.map(st => st.agentId)));
  const team = ids.map(id => agents.get(id)).filter((a): a is Agent => !!a).map(a => {
    const b = agentBackend(a); const g = b === 'api' ? null : claudeCodeGate(slug, a, proc.projectId);
    return {
      agentId: a.id, name: a.config.name, roles: Array.from(new Set(proc.steps.filter(st => st.agentId === a.id).map(st => st.role ?? 'implementer'))),
      backend: b, label: backendLabel(b, det?.billing, a.config.provider), ready: !g || g.ok,
      reason: g && !g.ok ? g.reason : null, problem: g && !g.ok ? g.problem : null
    };
  });
  const projectName = projectsRepo(slug).get(proc.projectId)?.name ?? null;
  const cc = team.filter(t => t.backend !== 'api');
  // Qué se retomará exactamente al continuar (para decidirlo ANTES de cualquier llamada).
  const stale = staleCorrectionUnits(proc.result);
  const staleIds = stale.map(s => s.id);
  const pendingUnit = proc.result?.manifest?.units.find(u => (u.status === 'pending' || u.status === 'running') && !staleIds.includes(u.id));
  const pl = proc.result?.pipeline;
  const nextOperation = stale.length
    ? stale.some(s => s.reason === 'overlap')
      ? `Volver a verificar sin IA (la corrección pendiente quedó obsoleta: otra de su ronda ya cambió ${Array.from(new Set(stale.flatMap(s => s.files))).join(', ')}) y corregir solo lo que siga fallando`
      : 'Repetir «test» sin IA para ver la causa real (la corrección pendiente se planificó con pruebas canceladas, no con un fallo) y, con esa causa, una corrección dirigida'
    : pendingUnit ? `${pendingUnit.title} — ${pendingUnit.agentName}` : pl && pl.state !== 'verified' ? 'Retomar el pipeline donde se detuvo (sin repetir lo hecho)' : null;
  return {
    processId, projectId: proc.projectId, projectName,
    connectorEnabled: s.enabled, subscriptionVerified: det?.billing === 'subscription', projectAuthorized: projectAuthorized(s, slug, proc.projectId),
    // Un proceso de un lote que no autoriza la API nunca cede a ella, aunque el conector lo permita.
    fallback: proc.result?.pipeline?.config.apiFallback === false ? 'none' as const : s.fallback, team, ready: team.every(t => t.ready),
    /** CLI instalada y sesión (de la última comprobación, sin llamar al modelo). */
    cli: { installed: !!det?.installed, version: det?.version ?? null, authMethod: det?.authMethod ?? null, subscriptionType: det?.subscriptionType ?? null, verified: det?.billing === 'subscription' && det?.probe?.ok !== false, checkedAt: det?.checkedAt ?? null },
    /** Ejecutor gestionado: disponible si el conector está activo con la suscripción verificada; ocupación actual. */
    worker: { managedAvailable: s.enabled && det?.billing === 'subscription', running: runningClaudeCode(), maxConcurrent: s.maxConcurrent },
    /** Lo que se autoriza (alcance), en lenguaje llano. */
    scope: cc.length ? [
      `Proyecto «${projectName ?? proc.projectId}» de este espacio (no otros proyectos ni empresas)`,
      `Agentes: ${cc.map(t => t.name).join(', ')}, con tu suscripción de Claude (0 USD de la API)`,
      s.repoRead ? 'Lectura (solo lectura) de la carpeta de trabajo del proceso a través del Portal; sin .env, claves, .git ni data/' : 'Sin acceso a archivos: solo el contexto que prepara el Portal',
      'Claude Code no ejecuta órdenes ni escribe archivos: el Portal aplica los cambios en el worktree aislado'
    ] : [],
    nextOperation, staleCorrections: stale.length,
    corrections: pl ? { used: pl.corrections, max: pl.config.maxCorrections } : null
  };
}

/** La llamada con el backend resuelto: Claude Code (suscripción) o, si el agente usa la API, su proveedor de siempre. */
export function completeWith(cc: ReturnType<typeof agentCaller>, providerId: ProviderId, cred: { ciphertext: string } | undefined, prow: { workspace_id: string | null }, req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
  if (cc) return cc.complete(req, signal);
  return getAdapter(providerId)!.complete(decryptSecret(cred!.ciphertext), { workspaceId: prow.workspace_id }, req, signal);
}

/**
 * Llamada de un agente fuera del pipeline (Asistente, preguntas al equipo, backlog, lecciones, encargos…) con SU backend.
 * Con Claude Code: gestionado por el Portal, sin cargo a la API; la consola no sirve para estas respuestas inmediatas. Si
 * no está disponible, se dice por qué y NO se usa la API en su lugar (la alternativa por API es solo de los pasos de
 * procesos autorizados y la decide el propietario en los ajustes del conector).
 */
export function agentCaller(slug: string, agent: Agent, projectId: string | null, title: string): { backend: ExecutionBackend; label: string; subscription: boolean; complete: (req: CompletionRequest, signal?: AbortSignal) => Promise<CompletionResult> } | null {
  const b = agentBackend(agent);
  if (b === 'api') return null;
  if (b === 'claude-code-terminal') throw Object.assign(new Error(`«${agent.config.name}» usa tu consola de Claude Code, que atiende tareas de procesos y no respuestas inmediatas. Cambia su backend a «Claude Code (gestionado)» o a la API para esto. No se ha usado la API.`), { statusCode: 409 });
  const g = claudeCodeGate(slug, agent, projectId);
  if (!g.ok) throw Object.assign(new Error(`${g.reason} No se ha usado la API en su lugar.`), { statusCode: 409 });
  return {
    backend: b, label: backendLabel(b, lastDetection()?.billing), subscription: true,
    complete: (req, signal) => claudeCodeComplete({ slug, projectId: projectId ?? '', processId: null, stepId: null, agent, role: null, title }, req, signal ?? new AbortController().signal, () => undefined)
  };
}

// ---------------------------------------------------------------- Concurrencia y duplicados

let active = 0; const waiters: (() => void)[] = [];
const runningKeys = new Set<string>();
async function acquireSlot(max: number, signal: AbortSignal, onWait: (n: number) => void) {
  while (active >= Math.max(1, max)) {
    if (signal.aborted) throw ccError('cancelled', 'Cancelado mientras esperaba turno para Claude Code.');
    onWait(active);
    await new Promise<void>(res => { const w = () => { signal.removeEventListener('abort', w); res(); }; waiters.push(w); signal.addEventListener('abort', w, { once: true }); });
  }
  if (signal.aborted) throw ccError('cancelled', 'Cancelado mientras esperaba turno para Claude Code.');
  active++;
}
function releaseSlot() { active = Math.max(0, active - 1); waiters.shift()?.(); }
export const runningClaudeCode = () => active;

const liveListeners = new Map<string, (text: string) => void>();
setProgressListener((t, message) => {
  try { claudeCodeRunsRepo(t.slug).progress(t.runId, message); } catch { /* sin registro */ }
  liveListeners.get(t.runId)?.(`Claude Code informa: ${message}`);
});

/** Carpeta legible de la tarea: el worktree del proceso si existe; si no, el repositorio autorizado del proyecto. */
export function readRootFor(slug: string, processId: string | null, projectId: string): string | null {
  const wt = processId ? processesRepo(slug).get(processId)?.result?.applied?.worktree : null;
  if (wt && fs.existsSync(wt)) return wt;
  const repo = projectsRepo(slug).repository(projectId);
  return repo ? repoRoot(repo.path) : null;
}

export interface ExecutionTarget { slug: string; projectId: string; processId: string | null; stepId: string | null; agent: Agent; role: string | null; title: string }
export interface ClaudeCodeCompletion extends CompletionResult { backendLabel: string; billing: ClaudeCodeBilling; apiEquivalentUsd: number | null; runId: string; numTurns?: number | null; cacheReadTokens?: number; tools?: Record<string, number> }

const READ_HINT = `

# Herramientas del Portal (solo lectura)
Si el contexto de arriba no basta, puedes consultar la carpeta de trabajo del proceso con portal_list_files, portal_read_file,
portal_search (texto literal) y portal_diff (cambios sin confirmar o de la rama), el conocimiento aprobado del proyecto con
portal_knowledge e informar de tu avance con portal_report_progress.
No puedes escribir archivos ni ejecutar órdenes: entrega los cambios en el formato pedido; el Portal los valida y los aplica.`;

/** Una llamada del agente a través de Claude Code (CLI gestionada o consola del propietario). */
export async function claudeCodeComplete(t: ExecutionTarget, req: CompletionRequest, signal: AbortSignal, onLive: (patch: Partial<LiveCall>) => void): Promise<ClaudeCodeCompletion> {
  const s = getClaudeCodeSettings();
  const g = claudeCodeGate(t.slug, t.agent, t.projectId || null);
  if (!g.ok) throw ccError('backend_unavailable', g.reason);
  const backend = agentBackend(t.agent); const runs = claudeCodeRunsRepo(t.slug);
  const timeoutMs = s.maxDurationSec * 1000; const readRoot = t.projectId ? readRootFor(t.slug, t.processId, t.projectId) : null;
  const say = (lastEvent: string, state: LiveCall['state'] = 'waiting') => onLive({ state, lastEvent, lastEventAt: new Date().toISOString() });
  const base = { slug: t.slug, projectId: t.projectId, processId: t.processId, stepId: t.stepId, agentId: t.agent.id, agentName: t.agent.config.name, role: t.role, title: t.title };

  if (backend === 'claude-code-terminal') {
    const label = backendLabel(backend);
    const run = runs.start({ mode: 'terminal', projectId: t.projectId, processId: t.processId, stepId: t.stepId, agentId: t.agent.id, agentName: t.agent.config.name, model: req.model, billing: 'unverified', authMethod: null, subscriptionType: null });
    const started = Date.now();
    try {
      const { result } = submitTerminalTask({ ...base, mode: 'terminal', system: req.system, prompt: req.user, schema: req.responseSchema ?? null, readRoot, runId: run.id }, timeoutMs, signal);
      liveListeners.set(run.id, m => say(m));
      say('En la cola de la consola de Claude Code: esperando a que la atiendas');
      const text = await result;
      runs.finish(run.id, 'done', { durationMs: Date.now() - started });
      return { text, inputTokens: 0, outputTokens: 0, stopReason: 'end_turn', refusal: null, backendLabel: label, billing: 'unverified', apiEquivalentUsd: null, runId: run.id };
    } catch (e: any) {
      runs.finish(run.id, e?.error?.code === 'cancelled' ? 'cancelled' : 'failed', { durationMs: Date.now() - started, error: e?.message ?? String(e) });
      throw e;
    } finally { liveListeners.delete(run.id); }
  }

  // Límite confirmado (sin renovar) u «overage» sin reconocer en el último informe del CLI: no se hace la llamada.
  const gate = subscriptionGate(); if (!gate.ok) throw ccError('usage_limit', gate.reason);
  // CLI gestionada: la suscripción se comprueba ANTES de cada ejecución (no basta con la del día de la conexión).
  say('Comprobando la sesión de Claude Code (sin llamar al modelo)', 'preparing');
  const det = await verifiedDetection(s);
  if (!det.capabilities.includes('restricted') || !det.capabilities.includes('blank-prompt-gate')) throw ccError('backend_unavailable', `Claude Code ${det.version ?? ''} no admite el modo restringido: actualízalo («claude update»).`);
  if (det.billing !== 'subscription') throw ccError('backend_unavailable', `Claude Code no está verificado con la suscripción (${backendLabel('claude-code', det.billing)}). ${det.problems.join(' ')}`.trim());
  const cli = (s.cliPath ? cliCommandFor(s.cliPath) : det.path ? cliCommandFor(det.path) : null) ?? findCli();
  if (!cli) throw ccError('backend_unavailable', 'No se encontró la CLI de Claude Code.');
  const label = backendLabel(backend, det.billing);
  const key = crypto.createHash('sha256').update([t.processId, t.stepId, t.agent.id, req.model, req.system, req.user, JSON.stringify(req.history ?? [])].join('\u0000')).digest('hex');
  if (runningKeys.has(key)) throw ccError('backend_unavailable', 'Ya hay una ejecución idéntica de Claude Code en curso para este paso: no se duplica.');
  runningKeys.add(key);
  try {
    await acquireSlot(s.maxConcurrent, signal, n => say(`En cola: ${n} ejecución(es) de Claude Code en curso (máximo ${s.maxConcurrent})`, 'preparing'));
    const run = runs.start({ mode: 'cli', projectId: t.projectId, processId: t.processId, stepId: t.stepId, agentId: t.agent.id, agentName: t.agent.config.name, model: req.model, billing: det.billing, authMethod: det.authMethod, subscriptionType: det.subscriptionType });
    const job = s.repoRead && readRoot ? registerJobTask({ ...base, mode: 'cli', system: '', prompt: '', schema: null, readRoot, runId: run.id }) : null;
    liveListeners.set(run.id, m => say(m));
    const started = Date.now();
    const onEvent = (e: CliEvent) => {
      if (e.kind === 'init') say(`Claude Code iniciado (${e.model ?? req.model}) · ${label}`, 'waiting');
      else if (e.kind === 'turn') { const m = `Claude Code: turno ${e.turn}${e.tools.length ? ` · ${e.tools.join(', ')}` : ''}`; say(m, 'receiving'); try { runs.progress(run.id, m); } catch { /* sin registro */ } }
      else if (e.kind === 'retry') say(`Claude Code reintenta la llamada (${e.error ?? 'error temporal'}, intento ${e.attempt})`, 'retrying');
      // Cada informe de límites del CLI se guarda (también si la llamada falla después): es de la cuenta, no del espacio.
      else if (e.kind === 'rate_limit') { try { saveUsageReport(e.info, label); } catch { /* sin base */ } if (e.info.status === 'allowed_warning') say(`Aviso de Claude Code: cerca del límite de uso${e.info.utilization != null ? ` (${Math.round(e.info.utilization * 100)} %)` : ''}`); }
    };
    try {
      say(`Enviando el encargo a Claude Code · ${label}`, 'sending');
      const r = await runCliTask({
        cli, detection: det, model: req.model, system: job ? req.system + READ_HINT : req.system, prompt: req.user, history: req.history, images: req.images,
        schema: req.responseSchema ?? null, maxTurns: s.maxTurns, timeoutMs, signal, onEvent, overageAccepted,
        mcp: job ? { command: process.execPath, args: [BRIDGE_SCRIPT], env: { PORTAL_URL: bridgeUrl, PORTAL_BRIDGE_TOKEN: job.token, PORTAL_BRIDGE_MODE: 'job' }, tools: JOB_TOOLS.map(n => `mcp__portal__${n}`) } : null
      });
      runs.finish(run.id, 'done', { durationMs: r.durationMs, numTurns: r.numTurns, tokensIn: r.inputTokens, tokensOut: r.outputTokens, apiEquivalentUsd: r.apiEquivalentUsd, rateLimit: r.rateLimit });
      say('Respuesta de Claude Code recibida; procesándola', 'processing');
      return { text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens, stopReason: r.stopReason, refusal: r.refusal, backendLabel: label, billing: det.billing, apiEquivalentUsd: r.apiEquivalentUsd, runId: run.id, numTurns: r.numTurns, cacheReadTokens: r.cacheReadTokens, tools: r.tools };
    } catch (e: any) {
      const code = e?.error?.code;
      // Turnos agotados (u otra ejecución sin respuesta útil): el uso que consumió la suscripción también se registra.
      const u = e?.usage as CliFailedUsage | undefined;
      runs.finish(run.id, code === 'usage_limit' ? 'limit' : code === 'cancelled' ? 'cancelled' : 'failed', { durationMs: u?.durationMs ?? Date.now() - started, error: e?.message ?? String(e), ...(u ? { numTurns: u.numTurns, tokensIn: u.inputTokens, tokensOut: u.outputTokens, apiEquivalentUsd: u.apiEquivalentUsd } : {}) });
      throw e;
    } finally { liveListeners.delete(run.id); job?.done(); releaseSlot(); }
  } finally { runningKeys.delete(key); }
}

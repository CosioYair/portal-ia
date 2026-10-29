import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CompletionRequest, CompletionResult } from '@portal-ia/ai-adapters';
import { backendLabel, type Agent, type ClaudeCodeBilling, type ExecutionBackend, type LiveCall } from '@portal-ia/domain';
import { config, REPO_ROOT } from '../../config.ts';
import { claudeCodeRunsRepo, processesRepo, projectsRepo } from '../../db/workspace.ts';
import { repoRoot } from '../repoWrite.ts';
import { registerJobTask, setProgressListener, submitTerminalTask } from './bridge.ts';
import { BRIDGE_SCRIPT, ccError, runCliTask, type CliEvent } from './cli.ts';
export { BRIDGE_SCRIPT };
import { cliCommandFor, findCli, verifiedDetection } from './detect.ts';
import { getClaudeCodeSettings, projectAuthorized } from './settings.ts';

/**
 * Backend de ejecución «Claude Code» para los pasos de un proceso autorizado. El agente del Portal conserva su identidad,
 * papel, permisos e historial: Claude Code solo ejecuta su encargo y el resultado vuelve a ese mismo agente y paso.
 * Nunca cambia por su cuenta a un origen facturable: si la suscripción no está disponible, el error lo decide el motor
 * (pausa, o la API solo si el propietario lo autorizó en los ajustes del conector).
 */
export const agentBackend = (a: Agent): ExecutionBackend => a.config.backend ?? 'api';
export const usesClaudeCode = (a: Agent) => agentBackend(a) !== 'api';

/** Herramientas del puente que puede usar una ejecución gestionada (solo lectura y progreso). */
export const JOB_TOOLS = ['portal_task_context', 'portal_list_files', 'portal_read_file', 'portal_knowledge', 'portal_report_progress'];
let bridgeUrl = `http://${config.host}:${config.port}`;
/** Dirección real en la que escucha el servidor (la fija index.ts al arrancar; las pruebas, la de su servidor). */
export function setBridgeUrl(url: string) { bridgeUrl = url.replace(/\/+$/, ''); }
export const getBridgeUrl = () => bridgeUrl;

export function claudeCodeGate(slug: string, agent: Agent, projectId: string): { ok: true } | { ok: false; reason: string } {
  const s = getClaudeCodeSettings();
  if (!usesClaudeCode(agent)) return { ok: false, reason: 'El agente usa la API de su proveedor.' };
  if (!s.enabled) return { ok: false, reason: 'El conector «Claude Code — Local» está desactivado (Proveedores → Claude Code).' };
  if (agent.config.provider !== 'anthropic') return { ok: false, reason: 'Solo los agentes con modelos de Anthropic pueden ejecutarse con Claude Code.' };
  if (!projectAuthorized(s, slug, projectId)) return { ok: false, reason: 'Este proyecto no está autorizado para Claude Code (Proveedores → Claude Code → Proyectos autorizados).' };
  return { ok: true };
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
export interface ClaudeCodeCompletion extends CompletionResult { backendLabel: string; billing: ClaudeCodeBilling; apiEquivalentUsd: number | null; runId: string }

const READ_HINT = `

# Herramientas del Portal (solo lectura)
Si el contexto de arriba no basta, puedes consultar la carpeta de trabajo del proceso con portal_list_files y portal_read_file,
el conocimiento aprobado del proyecto con portal_knowledge e informar de tu avance con portal_report_progress.
No puedes escribir archivos ni ejecutar órdenes: entrega los cambios en el formato pedido; el Portal los valida y los aplica.`;

/** Una llamada del agente a través de Claude Code (CLI gestionada o consola del propietario). */
export async function claudeCodeComplete(t: ExecutionTarget, req: CompletionRequest, signal: AbortSignal, onLive: (patch: Partial<LiveCall>) => void): Promise<ClaudeCodeCompletion> {
  const s = getClaudeCodeSettings();
  const g = claudeCodeGate(t.slug, t.agent, t.projectId);
  if (!g.ok) throw ccError('backend_unavailable', g.reason);
  const backend = agentBackend(t.agent); const runs = claudeCodeRunsRepo(t.slug);
  const timeoutMs = s.maxDurationSec * 1000; const readRoot = readRootFor(t.slug, t.processId, t.projectId);
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
      else if (e.kind === 'rate_limit' && e.info.status === 'allowed_warning') say(`Aviso de Claude Code: cerca del límite de uso${e.info.utilization != null ? ` (${Math.round(e.info.utilization * 100)} %)` : ''}`);
    };
    try {
      say(`Enviando el encargo a Claude Code · ${label}`, 'sending');
      const r = await runCliTask({
        cli, detection: det, model: req.model, system: job ? req.system + READ_HINT : req.system, prompt: req.user, history: req.history,
        schema: req.responseSchema ?? null, maxTurns: s.maxTurns, timeoutMs, signal, onEvent,
        mcp: job ? { command: process.execPath, args: [BRIDGE_SCRIPT], env: { PORTAL_URL: bridgeUrl, PORTAL_BRIDGE_TOKEN: job.token, PORTAL_BRIDGE_MODE: 'job' }, tools: JOB_TOOLS.map(n => `mcp__portal__${n}`) } : null
      });
      runs.finish(run.id, 'done', { durationMs: r.durationMs, numTurns: r.numTurns, tokensIn: r.inputTokens, tokensOut: r.outputTokens, apiEquivalentUsd: r.apiEquivalentUsd, rateLimit: r.rateLimit });
      say('Respuesta de Claude Code recibida; procesándola', 'processing');
      return { text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens, stopReason: r.stopReason, refusal: r.refusal, backendLabel: label, billing: det.billing, apiEquivalentUsd: r.apiEquivalentUsd, runId: run.id };
    } catch (e: any) {
      const code = e?.error?.code;
      runs.finish(run.id, code === 'usage_limit' ? 'limit' : code === 'cancelled' ? 'cancelled' : 'failed', { durationMs: Date.now() - started, error: e?.message ?? String(e) });
      throw e;
    } finally { liveListeners.delete(run.id); job?.done(); releaseSlot(); }
  } finally { runningKeys.delete(key); }
}

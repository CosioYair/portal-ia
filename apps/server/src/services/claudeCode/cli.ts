import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { ProviderRequestError } from '@portal-ia/ai-adapters';
import type { ClaudeCodeDetection, ClaudeCodeProbe, ClaudeCodeRun } from '@portal-ia/domain';
import { REPO_ROOT } from '../../config.ts';
import type { CliCommand } from './detect.ts';
import { managedEnv } from './env.ts';

/** Servidor MCP del puente del Portal (lo lanza Claude Code). */
export const BRIDGE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'portal-mcp.mjs');
/** Versiones mínimas: modo restringido (2.1.248) y mensaje en blanco que no llega al modelo (2.1.229). */
export const MIN_RESTRICTED = '2.1.248';

/**
 * Ejecución de UNA llamada de agente con la CLI oficial (`claude -p`), en modo restringido:
 *  - `--restricted` (≥ 2.1.248): ignora los ajustes de usuario, proyecto y locales (hooks, plugins, `env`, apiKeyHelper
 *    del propietario), quita las herramientas que ejecutan código y rechaza bypassPermissions. A diferencia de `--bare`,
 *    mantiene la sesión de la suscripción (comprobado con la CLI 2.1.311 sin llamar al modelo: `apiKeySource: none`);
 *  - `--tools ""`: sin herramientas integradas (ni Bash, ni lectura/edición de archivos, ni web, ni subagentes);
 *  - `--strict-mcp-config`: solo el puente MCP del Portal (si la ejecución lo usa) y ningún otro servidor MCP;
 *  - `--permission-mode dontAsk` (+ `--permission-prompts none` si la versión lo admite): lo que pediría permiso se deniega;
 *  - `--system-prompt-file`: la identidad y el encargo del agente del Portal sustituyen al prompt por defecto;
 *  - `--no-session-persistence` y `--disable-slash-commands`; carpeta de trabajo temporal y VACÍA, entorno mínimo;
 *  - salida `stream-json` (progreso real, límites de uso, origen de la clave) y `--json-schema` si se pide estructura.
 * Claude Code PROPONE (texto); el Portal valida y aplica los cambios en el worktree con sus mecanismos de siempre.
 * Nunca se usa `--dangerously-skip-permissions`, `bypassPermissions` ni `--bare` (este último no usa la suscripción).
 */
export interface CliTaskOptions {
  cli: CliCommand;
  detection: ClaudeCodeDetection;
  model: string;
  system: string;
  prompt: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** Imágenes del encargo: van como bloques de imagen (base64) en el mensaje de `stream-json`, como las admite el CLI. */
  images?: { mediaType: string; data: string }[];
  schema?: { name: string; description?: string; schema: Record<string, unknown> } | null;
  maxTurns: number;
  timeoutMs: number;
  signal: AbortSignal;
  /** Servidor MCP del Portal para esta ejecución (token de UN solo uso, ligado a la tarea) y herramientas permitidas. */
  mcp?: { command: string; args: string[]; env: Record<string, string>; tools: string[] } | null;
  onEvent?: (e: CliEvent) => void;
}
export type CliEvent =
  | { kind: 'init'; model: string | null; apiKeySource: string | null; mcp: { name: string; status: string }[] }
  | { kind: 'turn'; turn: number; tools: string[] }
  | { kind: 'retry'; attempt: number; error: string | null; delayMs: number | null }
  | { kind: 'rate_limit'; info: NonNullable<ClaudeCodeRun['rateLimit']> };

export interface CliTaskResult {
  text: string;
  structured: unknown;
  stopReason: string | null;
  refusal: string | null;
  inputTokens: number;
  outputTokens: number;
  numTurns: number | null;
  durationMs: number;
  sessionId: string | null;
  /** `total_cost_usd` de Claude Code: estimación de cliente de lo que costaría por API. NO es un cargo de la suscripción. */
  apiEquivalentUsd: number | null;
  apiKeySource: string | null;
  rateLimit: ClaudeCodeRun['rateLimit'];
  permissionDenials: string[];
  /** Parte de la entrada leída de la caché (incluida en inputTokens) y herramientas usadas (telemetría). */
  cacheReadTokens?: number;
  tools?: Record<string, number>;
  /** Lo que la sesión cargó según su «init» (comprobado antes del encargo) y cómo terminó el proceso. */
  session: { model: string | null; tools: string[]; mcpServers: { name: string; status: string }[]; plugins: string[]; permissionMode: string | null } | null;
  exitCode: number | null;
}

/**
 * `apiKeySource` del mensaje de inicio que corresponde a la sesión de la suscripción: SOLO «none» (sin clave de API;
 * comprobado con la CLI 2.1.311 y su sesión claude.ai). Cualquier otro valor, conocido o no, detiene la ejecución.
 */
export const SUBSCRIPTION_KEY_SOURCES = ['none'];
/** Herramientas que la sesión puede exponer: las del puente del Portal y la de salida estructurada si se pidió esquema. */
export function allowedSessionTool(name: string, structured: boolean): boolean {
  return name.startsWith('mcp__portal__') || name === 'EndConversation' || (structured && name === 'StructuredOutput');
}

/** Error del conector con el código del Portal (los reintentos automáticos solo existen para errores de red de la API). */
export const ccError = (code: 'usage_limit' | 'backend_unavailable' | 'timeout' | 'cancelled' | 'provider_error' | 'invalid_key' | 'max_turns', message: string) => new ProviderRequestError({ code, message });
/** Uso de una ejecución que terminó sin respuesta útil (p. ej. turnos agotados): se registra igual (consumió la suscripción). */
export interface CliFailedUsage { inputTokens: number; outputTokens: number; numTurns: number | null; apiEquivalentUsd: number | null; durationMs: number; tools: Record<string, number>; maxTurns: number | null }

export function buildArgs(o: Pick<CliTaskOptions, 'detection' | 'model' | 'schema' | 'maxTurns'>, files: { system: string; mcp: string | null }, mcpTools: string[]): string[] {
  const args = ['--restricted', '-p', '--output-format', 'stream-json', '--verbose', '--model', o.model, '--system-prompt-file', files.system,
    '--tools', '', '--permission-mode', 'dontAsk', '--max-turns', String(Math.max(1, Math.floor(o.maxTurns))),
    '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config'];
  if (o.detection.capabilities.includes('permission-prompts')) args.push('--permission-prompts', 'none');
  if (files.mcp) args.push('--mcp-config', files.mcp, '--allowedTools', mcpTools.join(','));
  if (o.schema) args.push('--json-schema', JSON.stringify(o.schema.schema));
  return args;
}

/** La conversación previa (continuaciones) va en el propio turno: la CLI recibe un único mensaje por stdin. */
export function promptWithHistory(prompt: string, history?: { role: 'user' | 'assistant'; content: string }[]): string {
  if (!history?.length) return prompt;
  const prev = history.map(h => `<<${h.role === 'user' ? 'PETICIÓN ANTERIOR' : 'TU RESPUESTA ANTERIOR (cortada)'}>>\n${h.content}`).join('\n\n');
  return `${prev}\n\n<<PETICIÓN ACTUAL>>\n${prompt}`;
}

/** Termina el árbol de procesos (la CLI y su servidor MCP). En Windows, `taskkill /T /F`; en POSIX, el grupo entero. */
export function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill()); } catch { child.kill(); }
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* ya terminó */ } }, 3000).unref();
}

const LIMIT_TEXT = /usage limit|limit reached|rate.?limit|out of (?:extra )?usage|credits? required|hit your limit/i;

/** Interpreta una línea de stream-json. Devuelve null si no es JSON (Claude Code no debería emitir otra cosa en stdout). */
export function parseLine(line: string): any | null {
  const t = line.trim(); if (!t) return null;
  try { const j = JSON.parse(t); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

export async function runCliTask(o: CliTaskOptions): Promise<CliTaskResult> {
  if (o.signal.aborted) throw ccError('cancelled', 'Ejecución cancelada antes de empezar.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-cc-'));
  const sysFile = path.join(work, 'system-prompt.md');
  fs.writeFileSync(sysFile, o.system, 'utf8');
  let mcpFile: string | null = null;
  if (o.mcp) {
    mcpFile = path.join(work, 'mcp.json');
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { portal: { type: 'stdio', command: o.mcp.command, args: o.mcp.args, env: o.mcp.env } } }), 'utf8');
  }
  // La carpeta de trabajo es una subcarpeta vacía: sin CLAUDE.md, .mcp.json ni ajustes de proyecto que cargar.
  const cwd = path.join(work, 'cwd'); fs.mkdirSync(cwd);
  const args = [...buildArgs(o, { system: sysFile, mcp: mcpFile }, o.mcp?.tools ?? []), '--input-format', 'stream-json'];
  const started = Date.now();
  try {
    return await new Promise<CliTaskResult>((resolve, reject) => {
      const child = spawn(o.cli.command, [...o.cli.prefixArgs, ...args], { cwd, env: managedEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32' });
      let settled = false; let buf = ''; let stderr = ''; let turns = 0; const toolUse: Record<string, number> = {};
      let apiKeySource: string | null = null; let session: CliTaskResult['session'] = null; let rateLimit: CliTaskResult['rateLimit'] = null; let result: any = null; let failure: Error | null = null;
      // BARRERA PREVIA. La CLI solo emite «init» al leer el primer mensaje, así que primero va un mensaje en blanco (la CLI
      // lo rechaza sin llamar al modelo: «Blank prompt … nothing was sent to the model») y, con «init» ya comprobado
      // (origen de la clave, herramientas, puente), el encargo real va en un segundo mensaje de la MISMA sesión.
      let phase: 'gate' | 'run' = 'gate'; let gateOk = false;
      const settle = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); o.signal.removeEventListener('abort', onAbort); fn(); };
      const stop = (err: Error) => { if (!failure) failure = err; try { child.stdin?.end(); } catch { /* cerrada */ } killTree(child); };
      const timer = setTimeout(() => stop(ccError('timeout', `Claude Code no terminó dentro del plazo de la ejecución (${Math.round(o.timeoutMs / 1000)} s) y se detuvo. Lo hecho en el proceso se conserva.`)), o.timeoutMs);
      const onAbort = () => stop(ccError('cancelled', 'Ejecución de Claude Code cancelada por el propietario.'));
      o.signal.addEventListener('abort', onAbort, { once: true });
      const send = (content: string | unknown[]) => child.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);

      const handle = (j: any) => {
        if (j.type === 'system' && j.subtype === 'init') {
          apiKeySource = typeof j.apiKeySource === 'string' ? j.apiKeySource : null;
          session = { model: typeof j.model === 'string' ? j.model : null, tools: Array.isArray(j.tools) ? j.tools.map(String) : [], mcpServers: Array.isArray(j.mcp_servers) ? j.mcp_servers.map((s: any) => ({ name: String(s?.name), status: String(s?.status) })) : [], plugins: Array.isArray(j.plugins) ? j.plugins.map((p: any) => String(p?.name)) : [], permissionMode: typeof j.permissionMode === 'string' ? j.permissionMode : null };
          o.onEvent?.({ kind: 'init', model: j.model ?? null, apiKeySource, mcp: Array.isArray(j.mcp_servers) ? j.mcp_servers : [] });
          const problem = initProblem(j, { structured: !!o.schema, mcp: !!o.mcp });
          // No se mata en el acto: se cierra la entrada y se espera al resultado del mensaje en blanco (que no llega al
          // modelo). El encargo nunca se envía; al llegar ese resultado (o al vencer el plazo) se detiene el proceso.
          if (problem) { if (!failure) failure = ccError('backend_unavailable', `${problem} Se detuvo antes de enviar el encargo: no se llamó al modelo.`); try { child.stdin?.end(); } catch { /* cerrada */ } }
          else gateOk = true;
        } else if (j.type === 'system' && j.subtype === 'api_retry') {
          o.onEvent?.({ kind: 'retry', attempt: Number(j.attempt) || 0, error: j.error ?? null, delayMs: typeof j.retry_delay_ms === 'number' ? j.retry_delay_ms : null });
          if (['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error'].includes(j.error)) stop(ccError('backend_unavailable', `Claude Code no pudo autenticarse con la suscripción (${j.error}). Revisa la sesión con «claude auth status».`));
        } else if (j.type === 'rate_limit_event' && j.rate_limit_info) {
          const i = j.rate_limit_info;
          rateLimit = parseRateLimit(i);
          o.onEvent?.({ kind: 'rate_limit', info: rateLimit });
          // Límite alcanzado: se para sin esperar (ni comprar créditos ni cambiar de origen de facturación).
          if (i.status === 'rejected') stop(limitError(rateLimit));
          // Uso adicional («overage»): podría facturarse aparte. Se para en el acto; seguir exige tu reconocimiento.
          else if (rateLimit.overage) stop(ccError('usage_limit', 'Claude Code informa uso adicional («overage»), que podría facturarse aparte según tu cuenta. Se ha parado sin continuar; reconócelo en el Asistente o en Proveedores si quieres seguir.'));
        } else if (j.type === 'assistant') {
          turns++;
          const tools = (j.message?.content ?? []).filter((c: any) => c?.type === 'tool_use').map((c: any) => String(c.name ?? '').replace(/^mcp__portal__/, ''));
          for (const t of tools) toolUse[t] = (toolUse[t] ?? 0) + 1;
          o.onEvent?.({ kind: 'turn', turn: turns, tools });
        } else if (j.type === 'result' && phase === 'gate') {
          // Resultado del mensaje en blanco: debe confirmar que no se llamó al modelo; solo entonces se envía el encargo.
          if (failure) { stop(failure); return; }
          const untouched = (Number(j.num_turns) || 0) === 0 && !(Number(j.usage?.input_tokens) || 0) && !(Number(j.usage?.output_tokens) || 0);
          if (!gateOk || !untouched) { stop(ccError('backend_unavailable', !gateOk ? 'Claude Code no informó de su configuración (init) antes de la primera respuesta. Se detuvo sin enviar el encargo.' : 'La comprobación previa de Claude Code no se comportó como está documentado (el mensaje en blanco no debía llegar al modelo). Se detuvo sin enviar el encargo.')); return; }
          phase = 'run';
          send(o.images?.length ? [...o.images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })), { type: 'text', text: promptWithHistory(o.prompt, o.history) }] : promptWithHistory(o.prompt, o.history));
        } else if (j.type === 'result') {
          result = j;
          try { child.stdin!.end(); } catch { /* cerrada */ }
        }
      };
      child.stdout!.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const j = parseLine(line); if (j) handle(j); }
        if (buf.length > 20_000_000) stop(ccError('provider_error', 'La salida de Claude Code superó el tamaño máximo aceptado.'));
      });
      child.stderr!.on('data', (d: Buffer) => { if (stderr.length < 8000) stderr += d.toString('utf8'); });
      child.on('error', e => settle(() => reject(ccError('backend_unavailable', `No se pudo iniciar Claude Code: ${e.message}`))));
      child.on('close', code => {
        const tail = parseLine(buf); if (tail) handle(tail);
        settle(() => {
          if (failure) return reject(failure);
          if (!result) {
            const why = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
            if (LIMIT_TEXT.test(why)) return reject(limitError(rateLimit, why));
            if (/unknown option|error: option/i.test(why)) return reject(ccError('backend_unavailable', `La CLI instalada no aceptó las opciones del conector: ${why}`));
            return reject(ccError('provider_error', `Claude Code terminó sin resultado (código ${code ?? 'desconocido'})${why ? `: ${why}` : ''}.`));
          }
          try { resolve({ ...interpretResult(result, { apiKeySource, rateLimit, turns, started, maxTurns: o.maxTurns, tools: toolUse }), session, exitCode: code }); } catch (e) { reject(e); }
        });
      });
      child.stdin!.on('error', () => { /* la CLI cerró la entrada antes de tiempo: lo dirá su resultado */ });
      send('   ');
    });
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temporal */ }
  }
}

/**
 * Sonda SIN llamada al modelo: la configuración exacta de una ejecución gestionada (con el puente y salida estructurada)
 * recibe solo un mensaje en blanco, que la CLI rechaza sin enviarlo («Blank prompt … nothing was sent to the model»).
 * Devuelve lo que la CLI real cargó: origen de la clave, herramientas, servidores MCP, plugins y modelo resuelto.
 */
export function probeSession(cli: CliCommand, detection: ClaudeCodeDetection, timeoutMs = 60_000): Promise<ClaudeCodeProbe> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-cc-probe-'));
  const sys = path.join(work, 'system-prompt.md'); fs.writeFileSync(sys, 'Comprobación de configuración de Portal IA.', 'utf8');
  const mcp = path.join(work, 'mcp.json');
  // Token de relleno: la sonda solo conecta el puente (lista de herramientas); nunca llama a la API del Portal.
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { portal: { type: 'stdio', command: process.execPath, args: [BRIDGE_SCRIPT], env: { PORTAL_URL: 'http://127.0.0.1:9', PORTAL_BRIDGE_TOKEN: 'pjob_sonda_sin_valor_0000000000000000', PORTAL_BRIDGE_MODE: 'job' } } } }), 'utf8');
  const cwd = path.join(work, 'cwd'); fs.mkdirSync(cwd);
  const args = [...buildArgs({ detection, model: 'haiku', schema: { name: 'sonda', schema: { type: 'object', properties: { ok: { type: 'string' } } } }, maxTurns: 1 }, { system: sys, mcp }, ['mcp__portal__portal_read_file']), '--input-format', 'stream-json'];
  const probe: ClaudeCodeProbe = { checkedAt: new Date().toISOString(), ok: false, apiKeySource: null, model: null, tools: [], mcpServers: [], plugins: [], modelCalled: false, problem: null };
  return new Promise<ClaudeCodeProbe>(resolve => {
    const child = spawn(cli.command, [...cli.prefixArgs, ...args], { cwd, env: managedEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32' });
    let buf = ''; let stderr = ''; let init: any = null; let result: any = null; let done = false;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer);
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temporal */ }
      if (init) {
        probe.apiKeySource = typeof init.apiKeySource === 'string' ? init.apiKeySource : null; probe.model = typeof init.model === 'string' ? init.model : null;
        probe.tools = Array.isArray(init.tools) ? init.tools.map(String) : []; probe.mcpServers = Array.isArray(init.mcp_servers) ? init.mcp_servers.map((s: any) => ({ name: String(s?.name), status: String(s?.status) })) : [];
        probe.plugins = Array.isArray(init.plugins) ? init.plugins.map((p: any) => String(p?.name)) : [];
      }
      if (result) probe.modelCalled = (Number(result.num_turns) || 0) > 0 || !!(Number(result.usage?.input_tokens) || Number(result.usage?.output_tokens));
      const why = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
      probe.problem = !init ? `La CLI no arrancó con la configuración gestionada${why ? `: ${why}` : '.'}`
        : initProblem(init, { structured: true, mcp: true }) ?? (probe.modelCalled ? 'La sonda informó uso del modelo: la comprobación no se comportó como está documentado.' : !result ? 'La CLI no terminó la comprobación.' : null);
      probe.ok = !probe.problem;
      resolve(probe);
    };
    const timer = setTimeout(() => { killTree(child); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8'); let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const j = parseLine(buf.slice(0, i)); buf = buf.slice(i + 1); if (!j) continue;
        if (j.type === 'system' && j.subtype === 'init') init = j;
        else if (j.type === 'result') { result = j; try { child.stdin.end(); } catch { /* cerrada */ } }
      }
    });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 4000) stderr += d.toString('utf8'); });
    child.on('error', e => { stderr += e.message; finish(); });
    child.on('close', finish);
    child.stdin.on('error', () => { /* cerrada */ });
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: '   ' } })}\n`);
  });
}

/**
 * Comprobación del mensaje «init» de una sesión gestionada: origen de la clave de la suscripción, solo las herramientas
 * permitidas y, si la ejecución usa el puente, el servidor «portal» conectado. Devuelve el motivo para detenerse o null.
 */
export function initProblem(j: any, o: { structured: boolean; mcp: boolean }): string | null {
  const source = typeof j.apiKeySource === 'string' ? j.apiKeySource : null;
  if (!source || !SUBSCRIPTION_KEY_SOURCES.includes(source)) return `Claude Code no confirmó la sesión de la suscripción (origen de la clave: ${source ?? 'sin dato'}); podría facturar por API.`;
  const tools: string[] = Array.isArray(j.tools) ? j.tools.map(String) : [];
  const foreign = tools.filter(t => !allowedSessionTool(t, o.structured));
  if (foreign.length) return `La sesión de Claude Code expuso herramientas no autorizadas (${foreign.slice(0, 5).join(', ')}).`;
  if (j.permissionMode && j.permissionMode !== 'dontAsk') return `La sesión de Claude Code no arrancó en el modo de permisos esperado (${j.permissionMode}).`;
  if (o.mcp) {
    const portal = (Array.isArray(j.mcp_servers) ? j.mcp_servers : []).find((s: any) => s?.name === 'portal');
    if (!portal || portal.status !== 'connected') return `El puente del Portal no se conectó a Claude Code (${portal?.status ?? 'ausente'}).`;
  }
  return null;
}

/** `rate_limit_info` del CLI oficial → informe del Portal (campos desconocidos se ignoran; nunca se inventan). */
export function parseRateLimit(i: any): NonNullable<CliTaskResult['rateLimit']> {
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const uw = i?.unifiedWindows && typeof i.unifiedWindows === 'object' ? i.unifiedWindows : null;
  const windows = uw ? Object.entries(uw).filter(([, w]) => w && typeof w === 'object').map(([name, w]: [string, any]) => ({ name, utilization: num(w.utilization), resetsAt: num(w.resetsAt), status: typeof w.status === 'string' ? w.status : null })) : [];
  const type = typeof i?.rateLimitType === 'string' ? i.rateLimitType : null;
  const overage = type === 'overage' || i?.isUsingOverage === true;
  return { status: String(i?.status ?? ''), resetsAt: num(i?.resetsAt), utilization: num(i?.utilization), errorCode: typeof i?.errorCode === 'string' ? i.errorCode : null, rateLimitType: type, windows, overage };
}

function limitError(rl: CliTaskResult['rateLimit'], detail?: string): ProviderRequestError {
  const when = rl?.resetsAt ? ` Se renueva hacia ${new Date(rl.resetsAt * 1000).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}.` : '';
  const credits = rl?.errorCode === 'credits_required' ? ' El uso incluido está agotado: el Portal NO compra créditos ni activa uso adicional.' : '';
  return ccError('usage_limit', `La suscripción de Claude alcanzó su límite de uso.${when}${credits}${detail ? ` (${detail})` : ''}`);
}

/** Convierte el mensaje `result` de Claude Code en el resultado del Portal (o en un error clasificado). */
export function interpretResult(r: any, ctx: { apiKeySource: string | null; rateLimit: CliTaskResult['rateLimit']; turns: number; started: number; maxTurns?: number; tools?: Record<string, number> }): CliTaskResult {
  const u = r.usage ?? {};
  const inputTokens = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
  const outputTokens = Number(u.output_tokens) || 0;
  const errors: string[] = Array.isArray(r.errors) ? r.errors.map(String) : [];
  const resultText = typeof r.result === 'string' ? r.result : '';
  if (r.is_error || (r.subtype && r.subtype !== 'success')) {
    const detail = [resultText, ...errors].filter(Boolean).join(' · ').slice(0, 600);
    if (r.api_error_status === 429 || ctx.rateLimit?.status === 'rejected' || LIMIT_TEXT.test(detail)) throw limitError(ctx.rateLimit, detail || undefined);
    if (r.api_error_status === 401 || r.api_error_status === 403 || /authenticat|log ?in|oauth/i.test(detail)) throw ccError('backend_unavailable', `Claude Code rechazó la sesión: ${detail || 'sin detalle'}. Revisa «claude auth status».`);
    if (r.subtype === 'error_max_turns') {
      // Capacidad de la ejecución, no conexión: se informa del límite configurado, de lo que se usó y en qué (herramientas),
      // y el uso se registra aunque no haya respuesta (consumió la suscripción). No se reintenta solo con el mismo encargo.
      const tools = ctx.tools ?? {}; const used = Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n}× ${t}`).join(', ');
      const usage: CliFailedUsage = { inputTokens, outputTokens, numTurns: typeof r.num_turns === 'number' ? r.num_turns : ctx.turns || null, apiEquivalentUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null, durationMs: typeof r.duration_ms === 'number' ? r.duration_ms : Date.now() - ctx.started, tools, maxTurns: ctx.maxTurns ?? null };
      throw Object.assign(ccError('max_turns', `Claude Code agotó los turnos autorizados (${ctx.maxTurns ?? '?'}) sin entregar la respuesta${used ? `: los usó en herramientas (${used})` : ''}. No es un error de conexión.`), { usage });
    }
    throw ccError('provider_error', `Claude Code devolvió un error (${r.subtype ?? 'error'}): ${detail || 'sin detalle'}`);
  }
  const structured = r.structured_output;
  const text = structured !== undefined && structured !== null ? JSON.stringify(structured) : resultText;
  if (!text.trim()) throw ccError('provider_error', 'Claude Code terminó sin texto de respuesta.');
  const stop = typeof r.stop_reason === 'string' ? r.stop_reason : 'end_turn';
  return {
    text, structured: structured ?? null, stopReason: stop, refusal: stop === 'refusal' ? (resultText || 'refusal') : null, inputTokens, outputTokens,
    numTurns: typeof r.num_turns === 'number' ? r.num_turns : ctx.turns || null, durationMs: typeof r.duration_ms === 'number' ? r.duration_ms : Date.now() - ctx.started,
    sessionId: typeof r.session_id === 'string' ? r.session_id : null, apiEquivalentUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null,
    apiKeySource: ctx.apiKeySource, rateLimit: ctx.rateLimit, session: null, exitCode: null,
    permissionDenials: Array.isArray(r.permission_denials) ? r.permission_denials.map((p: any) => String(p?.tool_name ?? '?')) : [],
    cacheReadTokens: Number(u.cache_read_input_tokens) || 0, tools: { ...(ctx.tools ?? {}) }
  };
}

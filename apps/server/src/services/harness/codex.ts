import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ProviderRequestError, type CompletionRequest, type CompletionResult } from '@portal-ia/ai-adapters';
import type { Agent, LiveCall } from '@portal-ia/domain';
import { settingsRepo } from '../../db/platform.ts';
import { claudeCodeRunsRepo } from '../../db/workspace.ts';
import { callCapCheck } from '../claudeCode/callCap.ts';
import { killTree } from '../claudeCode/cli.ts';
import { minimalEnv } from '../claudeCode/env.ts';

/**
 * Arnés «Codex»: la CLI oficial de OpenAI Codex (`codex exec`) con la sesión de ChatGPT del propietario.
 *
 * Seguridad (docs/arneses.md): el Portal solo ejecuta Codex en un modo equivalente al restringido de Claude Code — sin
 * shell, sin ejecución de código, sin subagentes, sin plugins/apps/MCP/navegador, sin configuración ni reglas del usuario,
 * en una carpeta temporal VACÍA, sin claves de API en el entorno y solo con una sesión de ChatGPT (nunca una clave de API,
 * que se facturaría). Antes de habilitarlo (y de cada ejecución) se COMPRUEBA, sin llamar al modelo, qué herramientas
 * expondría la sesión: `codex debug prompt-input` con los mismos argumentos. Si aparece cualquier herramienta fuera de la
 * lista permitida, Codex queda bloqueado y se explica por qué. Durante la ejecución, cualquier evento de herramienta
 * (orden, cambio de archivo, MCP, web) detiene la ejecución en el acto y se registra como incidente.
 * El Portal propone y aplica; Codex solo devuelve texto.
 */

export interface CodexSettings {
  enabled: boolean;
  /** Ruta elegida por el propietario; sin ella se busca en PATH y en la instalación de la app de escritorio. */
  cliPath: string | null;
  maxDurationSec: number;
  authorizedAt: string | null;
  updatedAt: string | null;
}
export const DEFAULT_CODEX_SETTINGS: CodexSettings = { enabled: false, cliPath: null, maxDurationSec: 900, authorizedAt: null, updatedAt: null };
export interface CodexDetection {
  checkedAt: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  auth: 'chatgpt' | 'api_key' | 'none' | 'unknown';
  billing: 'subscription' | 'api' | 'none' | 'unverified';
  /** Herramientas que la sesión restringida expondría al modelo (comprobado sin llamarlo). null = no se pudo comprobar. */
  exposedTools: string[] | null;
  /** Lo que sobra respecto a la lista permitida (si no está vacío, Codex queda bloqueado). */
  blockedTools: string[];
  /** Instrucciones personales del propietario que Codex añadiría (skills de usuario, AGENTS.md global): se avisa. */
  userContext: string[];
  restricted: boolean;
  models: { id: string; name: string }[];
  credentialVars: string[];
  problems: string[];
}

const KEY = 'codex'; const DETECTION_KEY = 'codex.detection';
export function getCodexSettings(): CodexSettings { try { return { ...DEFAULT_CODEX_SETTINGS, ...JSON.parse(settingsRepo.get(KEY) ?? '{}') }; } catch { return { ...DEFAULT_CODEX_SETTINGS }; } }
export function saveCodexSettings(s: CodexSettings): CodexSettings { const next = { ...s, updatedAt: new Date().toISOString() }; settingsRepo.set(KEY, JSON.stringify(next)); return next; }
export function lastCodexDetection(): CodexDetection | null { try { const r = settingsRepo.get(DETECTION_KEY); return r ? JSON.parse(r) : null; } catch { return null; } }

/** Herramientas que una sesión restringida puede exponer sin riesgo (no leen ni escriben nada, no lanzan nada). */
export const ALLOWED_TOOLS = new Set(['request_user_input', 'request_user_input_async', 'clock']);
/** Funciones de Codex que el Portal desactiva siempre (las que existan en la versión instalada). */
const DISABLE = ['shell_tool', 'unified_exec', 'unified_exec_tty', 'multi_agent', 'multi_agent_v2', 'collaboration_modes', 'plugins', 'apps', 'remote_plugin',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use', 'image_generation', 'hooks', 'goals', 'skill_search',
  'skill_mcp_dependency_install', 'plugin_discovery_prefetch', 'memories', 'code_mode', 'code_mode_host', 'sleep_tool', 'tool_suggest', 'standalone_web_search', 'apply_patch_freeform'];
/** Credenciales que nunca pasan al proceso de Codex (con una clave de API, Codex facturaría por uso). */
export const CODEX_CREDENTIAL_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'];

const get = (env: NodeJS.ProcessEnv, k: string) => Object.entries(env).find(([n]) => n.toUpperCase() === k)?.[1];
/** Entorno mínimo (lista blanca) + la carpeta de Codex si el propietario usa otra. Nunca credenciales. */
export function codexEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = minimalEnv(source); const home = get(source, 'CODEX_HOME'); if (home) env.CODEX_HOME = home;
  for (const k of Object.keys(env)) if (CODEX_CREDENTIAL_VARS.includes(k.toUpperCase())) delete env[k];
  return env;
}
export function codexCredentialVars(source: NodeJS.ProcessEnv = process.env): string[] { return CODEX_CREDENTIAL_VARS.filter(k => (get(source, k) ?? '').trim() !== ''); }

/** Orden ejecutable sin shell: el ejecutable de Codex (un codex.mjs/.js se ejecuta con el Node del Portal). */
export interface CodexCli { command: string; prefixArgs: string[]; path: string }
/** Solo el ejecutable de Codex (la ruta configurable no sirve para lanzar otro programa). */
export function codexCommandFor(p: string | null | undefined): CodexCli | null {
  try { if (!p || !fs.statSync(p).isFile()) return null; } catch { return null; }
  const base = path.basename(p);
  if (/^codex(\.exe)?$/i.test(base)) return { command: p, prefixArgs: [], path: p };
  if (/^codex\.(mjs|cjs|js)$/i.test(base)) return { command: process.execPath, prefixArgs: [p], path: p };
  return null;
}
/** PATH y la instalación de la app de escritorio (%LOCALAPPDATA%\OpenAI\Codex\bin\<versión>\codex.exe, la más reciente). */
export function findCodex(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CodexCli | null {
  const win = platform === 'win32';
  const dirs = (get(env, 'PATH') ?? '').split(win ? ';' : ':').filter(Boolean);
  for (const d of dirs) { const c = codexCommandFor(path.join(d, win ? 'codex.exe' : 'codex')); if (c) return c; }
  const local = get(env, 'LOCALAPPDATA');
  if (win && local) {
    const bin = path.join(local, 'OpenAI', 'Codex', 'bin');
    try {
      const found = fs.readdirSync(bin, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(bin, e.name, 'codex.exe')).filter(p => codexCommandFor(p))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (found[0]) return codexCommandFor(found[0]);
    } catch { /* no instalada */ }
  }
  return null;
}

function run(cli: CodexCli, args: string[], cwd: string, timeoutMs = 20_000, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let stdout = ''; let stderr = '';
    const child = spawn(cli.command, [...cli.prefixArgs, ...args], { cwd, env: codexEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32' });
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 4_000_000) killTree(child); });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + String(e) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => { /* cerrada */ });
    child.stdin.end(input ?? '');
  });
}

/** Argumentos comunes del modo restringido (los mismos para la comprobación y para la ejecución). */
export function restrictedArgs(features: Set<string> | null): string[] {
  const args = ['-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-c', 'project_doc_max_bytes=0', '-c', 'history.persistence="none"', '-c', 'mcp_servers={}'];
  for (const f of DISABLE) if (!features || features.has(f)) args.push('--disable', f);
  return args;
}

/** Herramientas que expone la sesión, leídas del primer elemento «additional_tools» de `codex debug prompt-input`. */
/**
 * Herramientas que expone la sesión, leídas de `codex debug prompt-input`. Falla CERRADA: `recognized` solo es true si la
 * salida es la lista de elementos conocida y trae su sección de herramientas; cualquier herramienta sin nombre cuenta como
 * herramienta («(sin nombre: tipo)»), y quien llama trata como bloqueado todo lo que no esté en la lista permitida.
 */
export function toolsFromPromptInput(json: unknown): { tools: string[]; userContext: string[]; recognized: boolean } {
  const items = Array.isArray(json) ? json : [];
  const tools = new Set<string>(); const userContext: string[] = [];
  const NAMESPACES = new Set(['namespace']);
  const walk = (v: unknown, inTools: boolean) => {
    if (Array.isArray(v)) { v.forEach(x => walk(x, inTools)); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (inTools && typeof o.type === 'string' && !NAMESPACES.has(o.type) && (typeof o.name === 'string' || o.type !== 'object')) {
      // Cada elemento de una lista de herramientas es una herramienta (con nombre o, si no lo tiene, por su tipo).
      if (!(o.properties && o.type === 'object')) tools.add(typeof o.name === 'string' ? o.name : `(sin nombre: ${o.type})`);
    }
    for (const [k, x] of Object.entries(o)) { if (k === 'parameters' || k === 'input_schema' || k === 'format' || k === 'properties') continue; walk(x, k === 'tools' ? true : inTools); }
  };
  let section = false;
  for (const it of items) if (it && typeof it === 'object' && ((it as any).type === 'additional_tools' || Array.isArray((it as any).tools))) { section = true; walk(it, false); }
  const text = JSON.stringify(items);
  if (/Available skills/i.test(text)) userContext.push('tus skills personales de Codex (solo su lista y descripción)');
  if (/AGENTS\.md instructions for/i.test(text)) userContext.push('un AGENTS.md global de tu carpeta de Codex');
  return { tools: [...tools].filter(t => t !== 'functions'), userContext, recognized: Array.isArray(json) && items.length > 0 && section };
}

function readModels(env: NodeJS.ProcessEnv = process.env): { id: string; name: string }[] {
  // Solo el catálogo de modelos en caché (nunca auth.json): slug, nombre y visibilidad.
  const home = get(env, 'CODEX_HOME') || path.join(get(env, process.platform === 'win32' ? 'USERPROFILE' : 'HOME') ?? os.homedir(), '.codex');
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8')) as { models?: { slug?: string; display_name?: string; visibility?: string }[] };
    return (j.models ?? []).filter(m => m.slug && m.visibility !== 'hide').map(m => ({ id: String(m.slug), name: String(m.display_name ?? m.slug) })).slice(0, 30);
  } catch { return []; }
}

let detecting: Promise<CodexDetection> | null = null;
/** Detección completa SIN llamar al modelo: versión, sesión, funciones y herramientas expuestas en modo restringido. */
export function detectCodex(s: CodexSettings = getCodexSettings(), model: string | null = null): Promise<CodexDetection> {
  // Con un modelo concreto (antes de cada ejecución) la comprobación es la de ESE modelo: las herramientas dependen de él.
  if (model) return detectNow(s, model);
  detecting ??= detectNow(s, null).finally(() => { detecting = null; });
  return detecting;
}
async function detectNow(s: CodexSettings, model: string | null): Promise<CodexDetection> {
  {
    const det: CodexDetection = { checkedAt: new Date().toISOString(), installed: false, path: null, version: null, auth: 'unknown', billing: 'unverified', exposedTools: null, blockedTools: [], userContext: [], restricted: false, models: [], credentialVars: codexCredentialVars(), problems: [] };
    const cli = codexCommandFor(s.cliPath) ?? findCodex();
    if (!cli) { det.problems.push('No se encontró la CLI de Codex (instala la app de Codex o indica la ruta de codex.exe).'); return det; }
    det.installed = true; det.path = cli.path;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-codex-detect-'));
    try {
      const v = await run(cli, ['--version'], work); det.version = (v.stdout + v.stderr).match(/codex-cli\s+(\S+)/i)?.[1] ?? null;
      const l = await run(cli, ['login', 'status'], work); const ls = l.stdout + l.stderr;
      det.auth = /logged in using chatgpt/i.test(ls) ? 'chatgpt' : /api key/i.test(ls) && /logged in/i.test(ls) ? 'api_key' : /not logged in/i.test(ls) ? 'none' : 'unknown';
      det.billing = det.auth === 'chatgpt' ? 'subscription' : det.auth === 'api_key' ? 'api' : det.auth === 'none' ? 'none' : 'unverified';
      if (det.auth === 'api_key') det.problems.push('Codex usa una clave de API (facturable por uso): el Portal solo lo ejecuta con tu sesión de ChatGPT («codex login»).');
      if (det.auth === 'none') det.problems.push('Codex no tiene sesión iniciada: ejecuta «codex login» con tu cuenta de ChatGPT.');
      const f = await run(cli, ['features', 'list'], work);
      const features = new Set(f.stdout.split(/\r?\n/).map(x => x.trim().split(/\s+/)[0]).filter(Boolean));
      // `debug prompt-input` no admite --ignore-user-config ni -s: se le pasan las mismas restricciones expresables como
      // configuración (-c y --disable) y el modelo. La ejecución real además ignora la configuración del usuario, lo que solo
      // puede QUITAR herramientas (MCP, plugins), nunca añadirlas.
      const pi = await run(cli, ['debug', 'prompt-input', ...restrictedArgs(features.size ? features : null), ...(model && model !== 'default' ? ['-c', `model=${JSON.stringify(model)}`] : []), 'portal-ia-comprobacion'], work, 30_000);
      let parsed: unknown = null; try { parsed = pi.code === 0 ? JSON.parse(pi.stdout) : null; } catch { /* no comprobable */ }
      const t = parsed ? toolsFromPromptInput(parsed) : null;
      if (t?.recognized) {
        det.exposedTools = t.tools; det.userContext = t.userContext;
        det.blockedTools = t.tools.filter(x => !ALLOWED_TOOLS.has(x));
      } else det.problems.push('No se pudo comprobar qué herramientas expondría Codex (codex debug prompt-input no devolvió la salida esperada): por seguridad, no se ejecuta.');
      if (det.blockedTools.length) det.problems.push(`Esta versión de Codex expone herramientas que el Portal no puede desactivar ni acotar (${det.blockedTools.join(', ')}): podrían leer archivos fuera de lo autorizado. El Portal no ejecuta agentes con Codex hasta que la versión instalada permita el modo restringido.`);
      det.restricted = det.exposedTools !== null && det.blockedTools.length === 0;
      if (det.credentialVars.length) det.problems.push(`Hay credenciales de OpenAI en el entorno del Portal (${det.credentialVars.join(', ')}): no se pasan a Codex.`);
      det.models = readModels();
    } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temporal */ } }
    if (!model) { try { settingsRepo.set(DETECTION_KEY, JSON.stringify(det)); } catch { /* sin base */ } }
    return det;
  }
}

/** ¿Puede ESTE agente ejecutar con Codex ahora? (sin efectos; con la última detección). */
export function codexGate(agent: Agent, det: CodexDetection | null = lastCodexDetection(), s: CodexSettings = getCodexSettings()): { ok: true } | { ok: false; reason: string } {
  if ((agent.config.backend ?? 'api') !== 'codex') return { ok: false, reason: 'El agente no usa Codex.' };
  if (!s.enabled || !s.authorizedAt) return { ok: false, reason: 'Codex no está habilitado (Oficina → Arneses). No se ha usado ningún otro arnés en su lugar.' };
  if (!det?.installed) return { ok: false, reason: 'No se encontró la CLI de Codex.' };
  if (det.billing !== 'subscription') return { ok: false, reason: det.problems[0] ?? 'Codex no está verificado con tu sesión de ChatGPT.' };
  if (!det.restricted) return { ok: false, reason: det.problems.find(p => /herramientas/.test(p)) ?? 'Codex no está verificado en modo restringido.' };
  return { ok: true };
}

// ---------------------------------------------------------------- Ejecución

/** Eventos de la CLI que son SOLO texto del modelo; cualquier otro tipo de elemento es una herramienta y detiene la ejecución. */
const TEXT_ITEMS = new Set(['agent_message', 'reasoning', 'assistant_message', 'message']);
export interface CodexEvent { kind: 'thread' | 'turn' | 'message' | 'tool' | 'usage' | 'error'; detail?: string; usage?: { input: number; cached: number; output: number } }

/** Interpreta una línea JSONL de `codex exec --json`. Tolerante: tipos desconocidos se ignoran salvo los de elementos. */
export function parseCodexLine(line: string): CodexEvent | null {
  let j: any; try { j = JSON.parse(line); } catch { return null; }
  const t = String(j?.type ?? '');
  if (t === 'thread.started') return { kind: 'thread', detail: String(j.thread_id ?? '') };
  if (t === 'turn.started') return { kind: 'turn' };
  if (t === 'turn.completed') { const u = j.usage ?? {}; return { kind: 'usage', usage: { input: Number(u.input_tokens ?? 0), cached: Number(u.cached_input_tokens ?? 0), output: Number(u.output_tokens ?? 0) } }; }
  if (t === 'turn.failed' || t === 'error') return { kind: 'error', detail: String(j.error?.message ?? j.message ?? 'error de Codex') };
  if (t === 'thread.completed' || t === 'turn.updated') return null;
  if (t.startsWith('item.')) {
    const it = j.item ?? {}; const type = String(it.type ?? it.item_type ?? '');
    if (TEXT_ITEMS.has(type)) return t === 'item.completed' && (type === 'agent_message' || type === 'assistant_message' || type === 'message') ? { kind: 'message', detail: String(it.text ?? '') } : null;
    if (type === 'error') return { kind: 'error', detail: String(it.message ?? 'error de Codex') };
    if (type === 'todo_list') return null;
    return { kind: 'tool', detail: type || 'desconocido' };
  }
  // Cualquier otro tipo de evento (p. ej. de una versión nueva con órdenes o herramientas) detiene la ejecución: lista permitida.
  return t ? { kind: 'tool', detail: `evento ${t}` } : null;
}

const codexError = (code: 'usage_limit' | 'call_cap' | 'backend_unavailable' | 'timeout' | 'cancelled' | 'provider_error', message: string) => new ProviderRequestError({ code, message });
/** Clasificación de un fallo de la CLI: límite del plan → pausa (nunca se cambia a otro arnés ni a la API). */
export function classifyCodexFailure(text: string): 'usage_limit' | 'backend_unavailable' | 'provider_error' {
  if (/usage limit|rate limit|quota|too many requests|429|limit reached|purchase more credits/i.test(text)) return 'usage_limit';
  if (/not logged in|login|unauthorized|401|403|authentication/i.test(text)) return 'backend_unavailable';
  return 'provider_error';
}

let active = 0; const waiters: (() => void)[] = [];
const QUEUE_MAX_MS = 10 * 60_000;
const runningKeys = new Set<string>();
export const runningCodex = () => active;

export interface CodexTarget { slug: string; projectId: string; processId: string | null; stepId: string | null; agent: Agent; title: string }
export interface CodexCompletion extends CompletionResult { backendLabel: string; billing: 'subscription'; apiEquivalentUsd: null; runId: string }

/**
 * Una llamada del agente con Codex. Comprueba el arnés (detección fresca: sesión y herramientas expuestas) ANTES de enviar
 * nada; un carril propio (1 a la vez); tope de llamadas del proceso; registro duradero en el registro de ejecuciones
 * (modo «codex»); se detiene ante cualquier herramienta, al plazo o al cancelar.
 */
export async function codexComplete(t: CodexTarget, req: CompletionRequest, signal: AbortSignal, onLive: (patch: Partial<LiveCall>) => void = () => undefined): Promise<CodexCompletion> {
  const say = (lastEvent: string, state: LiveCall['state'] = 'waiting') => onLive({ state, lastEvent, lastEventAt: new Date().toISOString() });
  say('Comprobando Codex (sesión y modo restringido, sin llamar al modelo)', 'preparing');
  const s = getCodexSettings(); const det = await detectCodex(s, req.model || 'default');
  const g = codexGate(t.agent, det, s); if (!g.ok) throw codexError('backend_unavailable', g.reason);
  const cli = codexCommandFor(det.path); if (!cli) throw codexError('backend_unavailable', 'No se encontró la CLI de Codex.');
  const key = crypto.createHash('sha256').update([t.processId, t.stepId, t.agent.id, req.model, req.system, req.user].join('\u0000')).digest('hex');
  if (runningKeys.has(key)) throw codexError('backend_unavailable', 'Ya hay una ejecución idéntica de Codex en curso: no se duplica.');
  runningKeys.add(key);
  try {
    const queuedSince = Date.now();
    while (active >= 1) {
      if (signal.aborted) throw codexError('cancelled', 'Cancelado mientras esperaba turno para Codex.');
      if (Date.now() - queuedSince > QUEUE_MAX_MS) throw codexError('timeout', `Codex lleva más de ${Math.round(QUEUE_MAX_MS / 60000)} min ocupado con otra ejecución: no se ha enviado nada. Inténtalo más tarde.`);
      say('En cola: Codex termina otra ejecución. Nada se ha enviado.', 'queued');
      await new Promise<void>(res => {
        const done = () => { clearTimeout(tm); signal.removeEventListener('abort', done); const i = waiters.indexOf(done); if (i >= 0) waiters.splice(i, 1); res(); };
        const tm = setTimeout(done, 30_000); waiters.push(done); signal.addEventListener('abort', done, { once: true });
      });
    }
    if (signal.aborted) throw codexError('cancelled', 'Cancelado antes de empezar.');
    // Tope de llamadas y registro en el mismo tramo síncrono (sin carreras).
    const cap = callCapCheck(t.slug, t.processId); if (!cap.ok) throw codexError('call_cap', cap.detail);
    const runs = claudeCodeRunsRepo(t.slug);
    active++;
    let run0: ReturnType<typeof runs.start>; let work: string;
    try {
      run0 = runs.start({ mode: 'codex', projectId: t.projectId, processId: t.processId, stepId: t.stepId, agentId: t.agent.id, agentName: t.agent.config.name, model: req.model || 'predeterminado de Codex', billing: 'subscription', authMethod: 'chatgpt', subscriptionType: null });
      work = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-codex-'));
    } catch (e) { active = Math.max(0, active - 1); waiters.shift()?.(); throw e; }
    const cwd = path.join(work, 'vacia'); fs.mkdirSync(cwd);
    const out = path.join(work, 'ultimo-mensaje.txt');
    const started = Date.now(); let usage = { input: 0, cached: 0, output: 0 }; let text = ''; let failure: Error | null = null; let incident: string | null = null;
    try {
      const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--color', 'never', '-s', 'read-only', '-C', cwd, '-o', out, ...restrictedArgs(null)];
      if (req.model && req.model !== 'default') args.push('-m', req.model);
      if (req.effort) args.push('-c', `model_reasoning_effort="${req.effort}"`);
      if (req.responseSchema) { const sf = path.join(work, 'esquema.json'); fs.writeFileSync(sf, JSON.stringify(req.responseSchema.schema)); args.push('--output-schema', sf); }
      args.push('-');
      const prompt = `<<INSTRUCCIONES DEL AGENTE (Portal IA)>>\n${req.system}\n<<FIN DE LAS INSTRUCCIONES>>\n\n${(req.history ?? []).map(h => `<<${h.role === 'user' ? 'PETICIÓN ANTERIOR' : 'TU RESPUESTA ANTERIOR'}>>\n${h.content}`).join('\n\n')}${req.history?.length ? '\n\n<<PETICIÓN ACTUAL>>\n' : ''}${req.user}\n\nResponde solo con texto. No uses herramientas: no las tienes.`;
      say(`Enviando el encargo a Codex (${req.model || 'modelo predeterminado'})`, 'sending');
      await new Promise<void>((resolve) => {
        const child = spawn(cli.command, [...cli.prefixArgs, ...args], { cwd, env: codexEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32' });
        let buf = ''; let stderr = '';
        const stop = (e: Error) => { if (!failure) failure = e; killTree(child); };
        const timer = setTimeout(() => stop(codexError('timeout', `Codex no terminó dentro del plazo (${s.maxDurationSec} s) y se detuvo.`)), s.maxDurationSec * 1000);
        const onAbort = () => stop(codexError('cancelled', 'Ejecución de Codex cancelada.'));
        signal.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', d => {
          buf += d; let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
            const ev = parseCodexLine(line); if (!ev) continue;
            if (ev.kind === 'tool') { incident = ev.detail ?? 'herramienta'; stop(codexError('backend_unavailable', `Codex intentó usar una herramienta («${incident}») pese al modo restringido: se detuvo en el acto y se registró como incidente de seguridad. No se usó ningún otro arnés.`)); }
            else if (ev.kind === 'usage' && ev.usage) usage = { input: usage.input + ev.usage.input, cached: usage.cached + ev.usage.cached, output: usage.output + ev.usage.output };
            else if (ev.kind === 'message') { text = ev.detail ?? text; say('Codex respondió; procesando', 'receiving'); }
            else if (ev.kind === 'turn') say('Codex trabaja (turno en curso)', 'receiving');
            else if (ev.kind === 'error') stop(codexError(classifyCodexFailure(ev.detail ?? ''), `Codex: ${ev.detail}`));
          }
        });
        child.stderr.on('data', d => { stderr += d; if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
        child.on('error', e => { if (!failure) failure = codexError('backend_unavailable', `No se pudo lanzar Codex: ${e.message}`); });
        child.on('close', code => {
          clearTimeout(timer); signal.removeEventListener('abort', onAbort);
          if (!failure && code !== 0) failure = codexError(classifyCodexFailure(stderr), `Codex terminó con código ${code}: ${stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400)}`);
          resolve();
        });
        child.stdin.on('error', () => { /* cerrada */ });
        child.stdin.end(prompt);
      });
      if (!failure) { try { const last = fs.readFileSync(out, 'utf8'); if (last.trim()) text = last; } catch { /* sin archivo: el texto del evento */ } }
      if (!failure && !text.trim()) failure = codexError('provider_error', 'Codex terminó sin respuesta.');
      if (failure) throw failure;
      runs.finish(run0.id, 'done', { durationMs: Date.now() - started, tokensIn: usage.input, tokensOut: usage.output });
      return { text: text.trim(), inputTokens: usage.input, outputTokens: usage.output, stopReason: 'end_turn', refusal: null, backendLabel: 'Codex — Sesión de ChatGPT', billing: 'subscription', apiEquivalentUsd: null, runId: run0.id };
    } catch (e: any) {
      const code = e?.error?.code;
      runs.finish(run0.id, code === 'usage_limit' ? 'limit' : code === 'cancelled' ? 'cancelled' : 'failed', { durationMs: Date.now() - started, tokensIn: usage.input, tokensOut: usage.output, error: incident ? `INCIDENTE: herramienta «${incident}». ${e?.message ?? ''}` : e?.message ?? String(e) });
      throw Object.assign(e, { usage: { inputTokens: usage.input, outputTokens: usage.output } });
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temporal */ }
      active = Math.max(0, active - 1); waiters.shift()?.();
    }
  } finally { runningKeys.delete(key); }
}

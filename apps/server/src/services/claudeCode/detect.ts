import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ClaudeCodeBilling, ClaudeCodeDetection, ClaudeCodeSettings } from '@portal-ia/domain';
import { credentialVarsIn, minimalEnv } from './env.ts';
import { saveDetection, savedDetection } from './settings.ts';

/**
 * Detección de la CLI oficial de Claude Code y de su autenticación, SIN llamar al modelo:
 *  - `claude --version`;
 *  - `claude auth status --json` (documentado: `loggedIn`, `authMethod` ∈ none · claude.ai · oauth_token · api_key ·
 *    api_key_helper · third_party; la CLI instalada también informa `subscriptionType` y `apiProvider`).
 * Se ejecuta con el MISMO entorno mínimo y la misma carpeta de trabajo vacía que una ejecución real: así refleja la
 * precedencia de credenciales que vería esa ejecución (por ejemplo, un `apiKeyHelper` de la configuración del usuario).
 * El correo y la organización que la CLI también devuelve no se guardan ni se muestran.
 */
export interface CliCommand { command: string; prefixArgs: string[]; path: string }

/** El ejecutable real detrás del lanzador de npm (`claude.cmd`). Nunca se ejecuta un .cmd: obligaría a usar un shell. */
export function exeFromShim(shim: string): CliCommand | null {
  try {
    const txt = fs.readFileSync(shim, 'utf8');
    for (const m of txt.matchAll(/"%dp0%\\([^"%]+)"/gi)) {
      if (!/claude/i.test(m[1])) continue;
      const target = path.join(path.dirname(shim), m[1]);
      if (!fs.existsSync(target)) continue;
      if (/\.(c|m)?js$/i.test(target)) return { command: process.execPath, prefixArgs: [target], path: target };
      if (/\.exe$/i.test(target)) return { command: target, prefixArgs: [], path: target };
    }
  } catch { /* ilegible */ }
  return null;
}

/** Ruta configurada → orden ejecutable sin shell (un .js/.mjs se ejecuta con el Node del Portal). */
export function cliCommandFor(p: string): CliCommand | null {
  try { if (!p || !fs.statSync(p).isFile()) return null; } catch { return null; }
  // Solo el ejecutable de Claude Code: la ruta configurable no sirve para lanzar otro programa.
  if (!/^claude(\.(exe|cmd|bat|mjs|cjs|js))?$/i.test(path.basename(p))) return null;
  const ext = path.extname(p).toLowerCase();
  if (ext === '.mjs' || ext === '.cjs' || ext === '.js') return { command: process.execPath, prefixArgs: [p], path: p };
  if (ext === '.cmd' || ext === '.bat') return exeFromShim(p);
  if (ext === '.ps1' || ext === '.sh') return null;
  return { command: p, prefixArgs: [], path: p };
}

/** Busca la CLI en el PATH y en las ubicaciones de instalación documentadas (instalador nativo y npm). */
export function findCli(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CliCommand | null {
  const win = platform === 'win32';
  const get = (k: string) => Object.entries(env).find(([n]) => n.toUpperCase() === k)?.[1];
  const dirs = (get('PATH') ?? '').split(win ? ';' : ':').filter(Boolean);
  const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const home = get(win ? 'USERPROFILE' : 'HOME');
  const known = win
    ? [home && path.join(home, '.local', 'bin', 'claude.exe'), get('APPDATA') && path.join(get('APPDATA')!, 'npm', 'claude.cmd')]
    : [home && path.join(home, '.local', 'bin', 'claude'), home && path.join(home, '.claude', 'local', 'claude')];
  for (const c of [...dirs.flatMap(d => names.map(n => path.join(d, n))), ...known.filter(Boolean) as string[]]) {
    const cmd = cliCommandFor(c); if (cmd) return cmd;
  }
  return null;
}

export interface CaptureResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError: string | null }

/** Ejecuta la CLI sin shell, con entorno mínimo, plazo y salida acotada. */
export function runCapture(cli: CliCommand, args: string[], o: { cwd: string; timeoutMs: number; env?: Record<string, string> }): Promise<CaptureResult> {
  return new Promise(resolve => {
    let stdout = ''; let stderr = ''; let timedOut = false; let done = false;
    const child = spawn(cli.command, [...cli.prefixArgs, ...args], { cwd: o.cwd, env: o.env ?? minimalEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const finish = (r: CaptureResult) => { if (done) return; done = true; clearTimeout(t); resolve(r); };
    const t = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* ya terminó */ } }, o.timeoutMs);
    child.stdout.on('data', d => { if (stdout.length < 200_000) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < 20_000) stderr += d; });
    child.on('error', e => finish({ code: null, stdout, stderr, timedOut, spawnError: e.message }));
    child.on('close', code => finish({ code, stdout, stderr, timedOut, spawnError: null }));
  });
}

export function versionAtLeast(v: string | null, min: string): boolean {
  if (!v) return false;
  const a = v.split('.').map(Number); const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return true;
}

/** Clasifica el origen de facturación a partir de `claude auth status`. Lo desconocido es «No verificado», nunca suscripción. */
export function classifyAuth(j: { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown } | null): { billing: ClaudeCodeBilling; problem: string | null } {
  if (!j) return { billing: 'unverified', problem: 'No se pudo leer el estado de autenticación de Claude Code («claude auth status»). Queda «No verificado» y no se ejecuta nada automáticamente.' };
  const method = typeof j.authMethod === 'string' ? j.authMethod : null;
  if (j.loggedIn !== true || method === 'none') return { billing: 'none', problem: 'Claude Code no tiene una sesión iniciada. Abre una consola, ejecuta «claude auth login» con tu cuenta de Claude (no «--console») y vuelve a comprobar.' };
  if (typeof j.apiProvider === 'string' && j.apiProvider !== 'firstParty') return { billing: 'cloud', problem: `Claude Code está configurado con un proveedor en la nube (${j.apiProvider}). El conector solo ejecuta con la suscripción de Claude.` };
  if (method === 'claude.ai' || method === 'oauth_token') return { billing: 'subscription', problem: null };
  if (method === 'api_key' || method === 'api_key_helper') return { billing: 'api', problem: `Claude Code usaría facturación por API (${method === 'api_key' ? 'una clave de API' : 'un apiKeyHelper'} en su configuración). El conector no ejecuta con facturación por API: quita esa credencial de la configuración de Claude Code o usa el proveedor «Anthropic API» del Portal, que tiene presupuesto.` };
  if (method === 'third_party') return { billing: 'cloud', problem: 'Claude Code usa un proveedor externo (Bedrock, Vertex o Foundry). El conector solo ejecuta con la suscripción de Claude.' };
  return { billing: 'unverified', problem: `Modo de autenticación desconocido («${method ?? 'sin dato'}»). Queda «No verificado» y no se ejecuta nada automáticamente.` };
}

export async function detectClaudeCode(settings: ClaudeCodeSettings): Promise<ClaudeCodeDetection> {
  const d: ClaudeCodeDetection = {
    checkedAt: new Date().toISOString(), installed: false, path: null, version: null, loggedIn: null, authMethod: null, subscriptionType: null,
    apiProvider: null, billing: 'unverified', portalEnvCredentials: credentialVarsIn(process.env), problems: [], capabilities: []
  };
  const cli = settings.cliPath ? cliCommandFor(settings.cliPath) : findCli();
  if (!cli) {
    d.problems.push(settings.cliPath ? `La ruta configurada no es un ejecutable de Claude Code utilizable: ${settings.cliPath}` : 'No se encontró Claude Code en este equipo. Instálalo (https://code.claude.com/docs/en/setup) y vuelve a comprobar.');
    saveDetection(d); cached = { at: Date.now(), key: settings.cliPath ?? '', detection: d };
    return d;
  }
  d.path = cli.path;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-cc-detect-'));
  try {
    const v = await runCapture(cli, ['--version'], { cwd, timeoutMs: 20_000 });
    d.version = v.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
    d.installed = !v.spawnError;
    if (v.spawnError || v.code !== 0 || !d.version) {
      d.problems.push(`La CLI no respondió a «--version»${v.timedOut ? ' a tiempo' : ''}${v.spawnError ? `: ${v.spawnError}` : v.code !== 0 ? ` (código ${v.code})` : ''}.`);
    } else {
      const a = await runCapture(cli, ['auth', 'status', '--json'], { cwd, timeoutMs: 20_000 });
      let j: any = null;
      try { const parsed = JSON.parse(a.stdout.trim()); if (parsed && typeof parsed === 'object') j = parsed; } catch { /* no es JSON */ }
      if (j) {
        d.loggedIn = j.loggedIn === true;
        d.authMethod = typeof j.authMethod === 'string' ? j.authMethod : null;
        d.subscriptionType = typeof j.subscriptionType === 'string' ? j.subscriptionType : null;
        d.apiProvider = typeof j.apiProvider === 'string' ? j.apiProvider : null;
      }
      const c = classifyAuth(j);
      d.billing = c.billing; if (c.problem) d.problems.push(c.problem);
      if (versionAtLeast(d.version, '2.1.259')) d.capabilities.push('permission-prompts');
      if (versionAtLeast(d.version, '2.1.181')) d.capabilities.push('rate-limit-events');
      d.capabilities.push('stream-json', 'json-schema', 'strict-mcp-config', 'tools-restriction');
    }
  } finally { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* temporal */ } }
  if (d.portalEnvCredentials.length) d.problems.push(`Hay credenciales en el entorno del Portal (${d.portalEnvCredentials.join(', ')}). No se reenvían a Claude Code; la detección de arriba ya las excluye.`);
  saveDetection(d); cached = { at: Date.now(), key: settings.cliPath ?? '', detection: d };
  return d;
}

let cached: { at: number; key: string; detection: ClaudeCodeDetection } | null = null;
/** Detección reciente (por defecto, de hace menos de 60 s) o una nueva. Cada ejecución automática la exige. */
export async function verifiedDetection(settings: ClaudeCodeSettings, maxAgeMs = 60_000): Promise<ClaudeCodeDetection> {
  if (cached && cached.key === (settings.cliPath ?? '') && Date.now() - cached.at < maxAgeMs) return cached.detection;
  return detectClaudeCode(settings);
}
/** Para la interfaz: la última conocida (en memoria o guardada), sin ejecutar nada. */
export function lastDetection(): ClaudeCodeDetection | null { return cached?.detection ?? savedDetection(); }
export function resetDetectionCache() { cached = null; }

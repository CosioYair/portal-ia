import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * HU-212 · Probar la Edición distribuible en la misma máquina. Sin IA.
 *
 * Lanza una segunda instancia del Portal (PORTAL_EDITION=distributable) en 127.0.0.1:4320 con su propia carpeta de datos
 * (y por tanto su propia .master.key) y de worktrees. El aislamiento se hace con el entorno del hijo: todo lo que importa
 * se fija de forma explícita y las claves de proveedor quedan vacías (config.ts solo rellena desde .env lo no definido).
 *
 * Este módulo NO importa config.ts (al cargarse crea carpetas y hace copias en data/ del Estudio) ni repoWrite.ts (que lo
 * arrastra): la raíz de la instalación y los datos del Estudio llegan como parámetros. Nunca registra ni devuelve una
 * clave, su hex ni su hash: solo «clave propia: sí/no».
 */

export const EDITION_SANDBOX_HOST = '127.0.0.1';
export const EDITION_SANDBOX_PORT = 4320;
export const EDITION_SANDBOX_URL = `http://${EDITION_SANDBOX_HOST}:${EDITION_SANDBOX_PORT}`;

export type EditionSandboxCode = 'already_running' | 'port_busy' | 'shared_key' | 'unsafe_dir' | 'start_failed';
export type EditionSandboxError = Error & { code: EditionSandboxCode };
const fail = (code: EditionSandboxCode, message: string): EditionSandboxError => Object.assign(new Error(message), { code });

export interface EditionSandboxPaths { root: string; dataDir: string; worktreesDir: string }
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type LogFn = (msg: string) => void;

// ---------- Rutas ----------

/** Ruta real en minúsculas, aunque aún no exista (se resuelve el padre existente más cercano). */
function realLower(p: string): string {
  let cur = path.resolve(p); const rest: string[] = [];
  while (!fs.existsSync(cur)) { const parent = path.dirname(cur); if (parent === cur) break; rest.unshift(path.basename(cur)); cur = parent; }
  let real = cur; try { real = fs.realpathSync.native(cur); } catch { /* se usa tal cual */ }
  return path.join(real, ...rest).toLowerCase();
}
const within = (child: string, parent: string) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

export function resolveEditionSandboxPaths(opts: { installRoot: string; studioDataDir: string; override?: string | undefined }): EditionSandboxPaths {
  const install = path.resolve(opts.installRoot);
  const raw = opts.override?.trim();
  const root = raw ? path.resolve(path.dirname(install), raw) : path.join(path.dirname(install), `${path.basename(install)}-edicion`);
  const paths = { root, dataDir: path.join(root, 'data'), worktreesDir: path.join(root, 'worktrees') };
  const unsafe = (why: string) => fail('unsafe_dir', `Carpeta de la Edición no permitida (${root}): ${why}. Elige otra con PORTAL_EDITION_SANDBOX_DIR (ruta absoluta fuera de la instalación).`);
  const r = realLower(root); const studio = realLower(opts.studioDataDir); const inst = realLower(install);
  if (path.parse(r).root === r || r === realLower(os.homedir())) throw unsafe('es la raíz de una unidad o tu carpeta personal');
  for (const cand of [r, realLower(paths.dataDir)]) {
    if (cand === studio) throw unsafe('es la carpeta de datos del Estudio');
    if (within(cand, studio)) throw unsafe('está dentro de la carpeta de datos del Estudio');
  }
  if (within(studio, r)) throw unsafe('contiene la carpeta de datos del Estudio');
  if (within(r, inst)) throw unsafe('está dentro de la carpeta de la instalación');
  if (within(inst, r)) throw unsafe('contiene la carpeta de la instalación');
  const studioWt = realLower(path.join(path.dirname(install), `${path.basename(install)}-worktrees`));
  const wt = realLower(paths.worktreesDir);
  if (within(wt, studioWt) || within(studioWt, wt) || within(studioWt, r)) throw unsafe('coincide con la carpeta de worktrees del Estudio');
  return paths;
}

// ---------- Entorno ----------

const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

/** Entorno del hijo (puro): fija edición, puerto, host y rutas propias; vacía las claves para que .env no las rellene. */
export function buildEditionEnv(base: NodeJS.ProcessEnv, paths: EditionSandboxPaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(env)) {
    if (k.startsWith('PORTAL_PREVIEW_') || k === 'PORTAL_MAIN_BRANCH' || k === 'PORTAL_SUPERVISED' || k === 'PORTAL_EDITION_SANDBOX_DIR') delete env[k];
    else if (/_API_KEY$/.test(k)) env[k] = '';
  }
  for (const k of PROVIDER_KEYS) env[k] = '';
  env.PORTAL_EDITION = 'distributable';
  env.PORTAL_PORT = String(EDITION_SANDBOX_PORT);
  env.PORTAL_HOST = EDITION_SANDBOX_HOST;
  env.PORTAL_DATA_DIR = paths.dataDir;
  env.PORTAL_WORKTREES_DIR = paths.worktreesDir;
  return env;
}

// ---------- Salida del hijo (sin secretos) ----------

const SECRET_RES: RegExp[] = [/sk-ant-[A-Za-z0-9_-]{20,}/, /\bsk-[A-Za-z0-9]{32,}\b/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\b(password|passwd|contraseña|secret|api[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  /[0-9a-fA-F]{64}/ /* clave maestra en hex o un sha256 */];
const OMITTED = '[salida omitida: contenía un posible secreto]';
const redact = (line: string) => (SECRET_RES.some(re => re.test(line)) ? OMITTED : line.slice(0, 500));

// ---------- Estado ----------

interface Live { owner: string; child: ChildProcess; pid: number | null; dataDir: string; exited: boolean; exit: Promise<void>; output: string[] }
const live = new Map<string, Live>();
let starting = false;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function portFree(): Promise<boolean> {
  return new Promise(res => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen({ host: EDITION_SANDBOX_HOST, port: EDITION_SANDBOX_PORT, exclusive: true }, () => s.close(() => res(true)));
  });
}
async function defaultHealth(url: string): Promise<boolean> {
  try { const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) }); await r.body?.cancel().catch(() => undefined); return r.ok; } catch { return false; }
}
const keyHash = (file: string): string | null => { try { return createHash('sha256').update(fs.readFileSync(file, 'utf8').trim()).digest('hex'); } catch { return null; } };

async function killAndWait(l: Live, ms = 10_000): Promise<void> {
  if (!l.exited) { try { l.child.kill(); } catch { /* ya terminó */ } }
  await Promise.race([l.exit, sleep(ms)]);
  live.delete(l.owner);
}

export interface StartEditionOptions {
  installRoot: string; studioDataDir: string; override?: string | undefined;
  spawnFn?: SpawnFn; log?: LogFn; baseEnv?: NodeJS.ProcessEnv;
  health?: (url: string) => Promise<boolean>; startTimeoutMs?: number; keyWaitMs?: number;
  onExit?: (code: number | null) => void;
}
export interface EditionSandboxInfo { url: string; pid: number | null; dataDir: string; worktreesDir: string; ownKey: boolean }

export async function startEditionSandbox(opts: StartEditionOptions): Promise<EditionSandboxInfo> {
  const log: LogFn = opts.log ?? (m => console.log(m));
  if (live.size || starting) {
    const pid = [...live.values()][0]?.pid;
    throw fail('already_running', `La Edición ya está en marcha${starting && !live.size ? ' (arrancando)' : ''} en ${EDITION_SANDBOX_URL}${pid ? ` (pid ${pid})` : ''}: detenla antes de lanzarla otra vez.`);
  }
  starting = true;
  try {
    const paths = resolveEditionSandboxPaths(opts);
    if (!(await portFree())) throw fail('port_busy', `El puerto ${EDITION_SANDBOX_PORT} de ${EDITION_SANDBOX_HOST} está ocupado por otro programa: ciérralo o libera el puerto y vuelve a intentarlo.`);
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.mkdirSync(paths.worktreesDir, { recursive: true });
    const env = buildEditionEnv(opts.baseEnv ?? process.env, paths);
    const spawnFn: SpawnFn = opts.spawnFn ?? nodeSpawn;
    const child = spawnFn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: path.join(opts.installRoot, 'apps', 'server'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const owner = createHash('sha256').update(realLower(paths.dataDir)).digest('hex').slice(0, 12);
    const l: Live = { owner, child, pid: child.pid ?? null, dataDir: paths.dataDir, exited: false, exit: Promise.resolve(), output: [] };
    l.exit = new Promise<void>(res => {
      child.once('exit', code => { l.exited = true; if (live.get(owner) === l) live.delete(owner); opts.onExit?.(code); res(); });
      child.once('error', e => { l.exited = true; l.output.push(redact(`no se pudo lanzar: ${e.message}`)); if (live.get(owner) === l) live.delete(owner); res(); });
    });
    const pipe = (s: NodeJS.ReadableStream | null | undefined) => {
      let pending = '';
      s?.on('data', (b: Buffer) => {
        pending += b.toString('utf8'); const parts = pending.split(/\r?\n/); pending = parts.pop() ?? '';
        for (const raw of parts) { if (!raw.trim()) continue; const line = redact(raw); l.output.push(line); if (l.output.length > 200) l.output.shift(); log(`[edición] ${line}`); }
      });
    };
    pipe(child.stdout); pipe(child.stderr);
    live.set(owner, l);
    try {
      const health = opts.health ?? defaultHealth; const limit = opts.startTimeoutMs ?? 120_000; const t0 = Date.now();
      for (;;) {
        if (l.exited) throw fail('start_failed', `La Edición terminó al arrancar. Últimas líneas:\n${l.output.slice(-15).join('\n').slice(-1500)}`);
        if (await health(EDITION_SANDBOX_URL)) break;
        if (Date.now() - t0 > limit) throw fail('start_failed', `La Edición no respondió en ${EDITION_SANDBOX_URL}/api/health en ${Math.round(limit / 1000)} s. Últimas líneas:\n${l.output.slice(-15).join('\n').slice(-1500)}`);
        await sleep(500);
      }
      const keyFile = path.join(paths.dataDir, '.master.key'); const kt0 = Date.now();
      while (!fs.existsSync(keyFile) && Date.now() - kt0 < (opts.keyWaitMs ?? 10_000)) await sleep(200);
      const own = keyHash(keyFile);
      if (!own) throw fail('start_failed', `La Edición arrancó pero no creó su clave maestra en ${paths.dataDir}.`);
      const studio = keyHash(path.join(opts.studioDataDir, '.master.key'));
      if (studio && studio === own) throw fail('shared_key', `La Edición usa la misma clave maestra que el Estudio y se ha detenido. Borra la carpeta ${paths.dataDir} y vuelve a lanzarla.`);
      log(`Edición en marcha en ${EDITION_SANDBOX_URL} · datos: ${paths.dataDir} · clave propia: sí`);
      return { url: EDITION_SANDBOX_URL, pid: l.pid, dataDir: paths.dataDir, worktreesDir: paths.worktreesDir, ownKey: true };
    } catch (e) {
      await killAndWait(l);
      throw e;
    }
  } finally { starting = false; }
}

/** Detiene la Edición, espera a que el proceso termine y a que el puerto quede libre. */
export async function stopEditionSandbox(): Promise<boolean> {
  const all = [...live.values()];
  if (!all.length) return false;
  for (const l of all) await killAndWait(l);
  const t0 = Date.now();
  while (!(await portFree()) && Date.now() - t0 < 5000) await sleep(200);
  return true;
}

export function editionSandboxStatus(): { running: boolean; pid: number | null; url: string | null } {
  const l = [...live.values()][0];
  return { running: !!l, pid: l?.pid ?? null, url: l ? EDITION_SANDBOX_URL : null };
}

/** Últimas líneas de salida del hijo, ya filtradas (nunca contienen claves). */
export function editionSandboxOutput(): string[] {
  return [...live.values()].flatMap(l => l.output);
}

process.once('exit', () => { for (const l of live.values()) { try { l.child.kill(); } catch { /* ya terminó */ } } });

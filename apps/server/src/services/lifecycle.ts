import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerLifecycleOutcome } from '@portal-ia/domain';
import { config, REPO_ROOT } from '../config.ts';

/**
 * Ciclo de vida del servidor (HU-144): apagado limpio que libera el puerto y no deja procesos huérfanos.
 *
 * Garantías de `shutdown`:
 *  1. Fastify deja de escuchar y cierra todas las conexiones (keep-alive, SSE).
 *  2. Se mata el árbol de los procesos hijos registrados (`trackChild`) y cualquier otro descendiente directo/indirecto
 *     del servidor (POSIX: lectura de `ps`; Windows: `taskkill /T /F`).
 *  3. Salida dura a los 5 s pase lo que pase.
 */

const IS_WINDOWS = process.platform === 'win32';
/** Código de salida convenido con el supervisor externo para «relánzame» (EX_TEMPFAIL). */
export const RESTART_EXIT_CODE = 75;
export const HARD_EXIT_MS = 5000;

const tracked = new Set<number>();
let shuttingDown = false;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function isShuttingDown(): boolean { return shuttingDown; }

/**
 * Lanza un proceso hijo y lo registra para que el apagado lo termine.
 * En POSIX se lanza en su propio grupo (`detached`) para poder matar también a sus descendientes.
 * No se hace `unref()`: el hijo nunca debe sobrevivir al servidor.
 */
export function trackChild(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess {
  const child = spawn(command, args, { ...options, detached: !IS_WINDOWS });
  const pid = child.pid;
  if (pid !== undefined) {
    tracked.add(pid);
    const forget = () => { tracked.delete(pid); };
    child.once('exit', forget);
    child.once('error', forget);
  }
  return child;
}

/** ¿Sigue vivo el proceso? Los zombis (Linux) cuentan como muertos. */
export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat[stat.lastIndexOf(')') + 2] === 'Z') return false;
    } catch { /* sin /proc: se asume vivo */ }
  }
  return true;
}

/** Mata un proceso y su árbol. POSIX: se mata el grupo (`-pid`) y, por si no lo lidera, el propio PID; Windows: `taskkill /T /F`. */
export function killChildTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (IS_WINDOWS) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 }); } catch { /* ya terminado */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* no lidera un grupo o ya terminó */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ya terminado */ }
}

/** Mapa ppid → pids de todos los procesos del sistema (vacío si no se puede leer). */
function childrenMap(): Map<number, number[]> {
  const map = new Map<number, number[]>();
  try {
    const raw = IS_WINDOWS
      ? execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: 'utf8', timeout: 4000 })
      : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 });
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
      if (!m) continue;
      const pid = Number(m[1]); const ppid = Number(m[2]);
      map.set(ppid, [...(map.get(ppid) ?? []), pid]);
    }
  } catch { /* sin ps/powershell: solo se mata lo registrado */ }
  return map;
}

/** Todos los descendientes (hijos, nietos…) de un proceso, lanzados o no mediante `trackChild`. */
export function listDescendants(rootPid: number = process.pid): number[] {
  const map = childrenMap();
  const out: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const child of map.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child); out.push(child); queue.push(child);
    }
  }
  return out;
}

/** Termina todos los procesos hijos registrados y cualquier otro descendiente del servidor. */
function killAllChildren(): void {
  // Se calcula el conjunto ANTES de matar: al morir un padre sus hijos pasan a otro padre y se perderían de vista.
  const victims = new Set<number>([...tracked, ...listDescendants()]);
  victims.delete(process.pid);
  for (const pid of victims) killChildTree(pid);
  tracked.clear();
}

/** PID que escucha en el puerto, si se puede averiguar (lsof / netstat). */
export function describePortHolder(port: number): number | null {
  try {
    if (IS_WINDOWS) {
      const raw = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 4000 });
      for (const line of raw.split('\n')) {
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
        if (m && Number(m[1]) === port) return Number(m[2]);
      }
      return null;
    }
    const raw = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 3000 }).trim();
    const pid = Number(raw.split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

/** Comandos exactos, derivados de los scripts reales del package.json raíz, y directorio donde ejecutarlos. */
export function computeStartCommands(): { cwd: string; commands: string[] } {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch { /* se usan los comandos por defecto */ }
  const commands = ['npm install'];
  if (scripts.build !== undefined || Object.keys(scripts).length === 0) commands.push('npm run build');
  commands.push(scripts.start !== undefined || Object.keys(scripts).length === 0 ? 'npm start' : 'npm run dev');
  return { cwd: REPO_ROOT, commands };
}

/**
 * Decide qué ocurre al pulsar «Reiniciar». Solo es `restarting` si hay un supervisor externo declarado
 * (`PORTAL_SUPERVISED=1`) que relanza el proceso al ver el código de salida 75. En otro caso se apaga limpio.
 */
export function buildOutcome(): ServerLifecycleOutcome {
  const { cwd, commands } = computeStartCommands();
  if (process.env.PORTAL_SUPERVISED === '1') {
    return { mode: 'restarting', port: config.port, cwd, commands: [], reason: `El servidor corre bajo un supervisor (PORTAL_SUPERVISED=1) y se relanzará solo en el puerto ${config.port}.` };
  }
  return { mode: 'shutdown', port: config.port, cwd, commands, reason: 'No hay un supervisor que relance el servidor: se apaga por completo y el puerto queda libre. Arráncalo de nuevo con los comandos indicados.' };
}

/**
 * Apagado limpio e idempotente: cierra Fastify (forzando conexiones), mata el árbol de hijos y sale.
 * La salida dura a los 5 s se arma al principio, así que nunca queda colgado.
 */
export async function shutdown(app: FastifyInstance, reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ reason, exitCode }, 'apagando el servidor');
  const hard = setTimeout(() => {
    try { killAllChildren(); } finally { process.exit(exitCode); }
  }, HARD_EXIT_MS);
  hard.unref();
  try {
    const closing = app.close();
    app.server.closeAllConnections();
    await Promise.race([closing, sleep(3000)]);
  } catch (e) {
    app.log.warn({ err: (e as Error).message }, 'cierre de Fastify incompleto; se continúa con el apagado');
  }
  try { killAllChildren(); } catch (e) { app.log.warn({ err: (e as Error).message }, 'no se pudieron terminar todos los procesos hijos'); }
  process.exit(exitCode);
}

/** Programa el apagado cuando la respuesta ya se ha enviado (o, como mucho, 1,5 s después). */
export function scheduleShutdown(app: FastifyInstance, reply: FastifyReply, outcome: ServerLifecycleOutcome): void {
  const exitCode = outcome.mode === 'restarting' ? RESTART_EXIT_CODE : 0;
  let started = false;
  const go = () => {
    if (started) return;
    started = true;
    setTimeout(() => { void shutdown(app, outcome.reason, exitCode); }, 50);
  };
  reply.raw.once('finish', go);
  reply.raw.once('close', go);
  setTimeout(go, 1500).unref();
}

/** SIGINT (Ctrl+C), SIGTERM y SIGHUP usan el mismo apagado limpio. */
export function installSignalHandlers(app: FastifyInstance): void {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => { void shutdown(app, `señal ${sig}`, 0); });
  }
}

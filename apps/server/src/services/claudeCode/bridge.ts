import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ClaudeCodeWorkerView } from '@portal-ia/domain';
import { claudeCodeWorkersRepo, workspacesRepo, type ClaudeCodeWorkerRow } from '../../db/platform.ts';
import { agentsRepo, knowledgeRepo, projectsRepo } from '../../db/workspace.ts';
import { safeRelPath, scanSecrets } from '../repoWrite.ts';
import { ccError } from './cli.ts';
import { getClaudeCodeSettings, projectAuthorized } from './settings.ts';

/**
 * Puente del Portal para Claude Code (lo usa el servidor MCP `scripts/portal-mcp.mjs`).
 *
 * AUTORIZACIÓN EN EL BACKEND. Cada petición lleva un token y el ALCANCE sale del token, nunca de los argumentos del
 * modelo: un token de ejecución vale para UNA tarea (y caduca al terminarla); un token de consola vale para UN espacio y
 * para los agentes que el propietario le autorizó. Las tareas de otro espacio, de otro agente o de un proyecto no
 * autorizado no existen para ese token (404), y nada da acceso a la base de datos, a un shell ni a archivos fuera de la
 * carpeta de trabajo del proceso (solo lectura, rutas protegidas excluidas, sin secretos).
 */
export interface BridgeTask {
  id: string; slug: string; projectId: string; processId: string | null; stepId: string | null;
  agentId: string; agentName: string; role: string | null; title: string; mode: 'cli' | 'terminal';
  system: string; prompt: string; schema: { name: string; description?: string; schema: Record<string, unknown> } | null;
  /** Carpeta que se puede leer: el worktree del proceso o, si aún no existe, el repositorio autorizado del proyecto. */
  readRoot: string | null; runId: string; createdAt: string;
  status: 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled'; claimedBy: string | null; progress: { at: string; message: string }[];
}
interface Pending { task: BridgeTask; resolve: (text: string) => void; reject: (e: Error) => void }

export type BridgeScope = { kind: 'job'; slug: string; taskId: string } | { kind: 'worker'; slug: string; workerId: string; agentIds: string[] };
export type Denied = { status: number; error: string };
const deny = (status: number, error: string): Denied => ({ status, error });
export const isDenied = (x: unknown): x is Denied => !!x && typeof x === 'object' && 'status' in x && 'error' in x && !('id' in x);

const tasks = new Map<string, Pending>();
const jobTokens = new Map<string, string>();
const presence = new Map<string, { at: number; persistedAt: number }>();
/** Una consola se considera conectada si su puente dio señales en los últimos 45 s (latido cada 15 s). */
export const WORKER_TIMEOUT_MS = Number(process.env.PORTAL_CC_WORKER_TIMEOUT_MS) || 45_000;

const hash = (t: string) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
export const newToken = (prefix: string) => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;

// ---------------------------------------------------------------- Tokens y alcance

export function scopeFor(authorization: string | undefined): BridgeScope | null {
  const m = authorization?.match(/^Bearer\s+([A-Za-z0-9_-]{20,200})$/);
  if (!m) return null;
  const h = hash(m[1]);
  const taskId = jobTokens.get(h);
  if (taskId) { const p = tasks.get(taskId); return p ? { kind: 'job', slug: p.task.slug, taskId } : null; }
  const w = claudeCodeWorkersRepo.byHash(h);
  if (!w || w.revoked_at || !workspacesRepo.get(w.workspace_slug)) return null;
  return { kind: 'worker', slug: w.workspace_slug, workerId: w.id, agentIds: JSON.parse(w.agent_ids_json) };
}

/** ¿Este agente puede recibir tareas de la consola ahora mismo? (backend de consola + proyecto autorizado + conector activo) */
export function terminalAgentAllowed(slug: string, agentId: string, projectId: string): boolean {
  const s = getClaudeCodeSettings(); const a = agentsRepo(slug).get(agentId);
  return s.enabled && !!a && a.config.backend === 'claude-code-terminal' && projectAuthorized(s, slug, projectId);
}

/** Tarea accesible para este alcance, o 404/409 (lo ajeno se trata como inexistente). */
export function taskFor(scope: BridgeScope, taskId: string | undefined): BridgeTask | Denied {
  const id = taskId ?? (scope.kind === 'job' ? scope.taskId : undefined);
  if (!id) return deny(400, 'Falta el identificador de la tarea.');
  const p = tasks.get(id);
  if (!p || p.task.slug !== scope.slug) return deny(404, 'Tarea no encontrada para este acceso.');
  const t = p.task;
  if (scope.kind === 'job') return id === scope.taskId ? t : deny(404, 'Tarea no encontrada para este acceso.');
  if (t.mode !== 'terminal' || !scope.agentIds.includes(t.agentId) || !terminalAgentAllowed(t.slug, t.agentId, t.projectId)) return deny(404, 'Tarea no encontrada para este acceso.');
  if (t.claimedBy && t.claimedBy !== scope.workerId) return deny(409, 'Otra consola ya está atendiendo esta tarea.');
  return t;
}

// ---------------------------------------------------------------- Consolas (trabajadores)

export function createWorker(slug: string, name: string, agentIds: string[]): { id: string; token: string } {
  const id = crypto.randomUUID(); const token = newToken('pcc');
  claudeCodeWorkersRepo.create({ id, workspaceSlug: slug, name, tokenHash: hash(token), agentIds });
  return { id, token };
}
export function touchWorker(workerId: string, client?: unknown) {
  const now = Date.now(); const prev = presence.get(workerId);
  // Se persiste como mucho cada 15 s (la presencia real vive en memoria: tras reiniciar, nadie aparece conectado).
  if (!prev || now - prev.persistedAt > 15_000 || client !== undefined) { claudeCodeWorkersRepo.seen(workerId, client); presence.set(workerId, { at: now, persistedAt: now }); }
  else presence.set(workerId, { at: now, persistedAt: prev.persistedAt });
}
export function disconnectWorker(workerId: string) { presence.delete(workerId); }
export const workerConnected = (workerId: string) => { const p = presence.get(workerId); return !!p && Date.now() - p.at < WORKER_TIMEOUT_MS; };

export function workerView(r: ClaudeCodeWorkerRow): ClaudeCodeWorkerView {
  const client = r.client_json ? JSON.parse(r.client_json) : null;
  return {
    id: r.id, workspaceSlug: r.workspace_slug, name: r.name, agentIds: JSON.parse(r.agent_ids_json), createdAt: r.created_at, revokedAt: r.revoked_at,
    lastSeenAt: r.last_seen_at, connected: !r.revoked_at && workerConnected(r.id),
    clientEnvCredentials: Array.isArray(client?.envCredentials) ? client.envCredentials.map(String) : [], clientVersion: typeof client?.version === 'string' ? client.version : null
  };
}
export function connectedWorkersFor(slug: string, agentId: string): ClaudeCodeWorkerView[] {
  return claudeCodeWorkersRepo.list(slug).map(workerView).filter(w => w.connected && w.agentIds.includes(agentId));
}

// ---------------------------------------------------------------- Tareas

type NewTask = Omit<BridgeTask, 'id' | 'createdAt' | 'status' | 'claimedBy' | 'progress'>;

/** Tarea de una ejecución gestionada por la CLI: el token solo vale para ella y se revoca al terminar. */
export function registerJobTask(t: NewTask): { task: BridgeTask; token: string; done: () => void } {
  const task: BridgeTask = { ...t, id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'claimed', claimedBy: 'cli', progress: [] };
  const token = newToken('pjob'); const h = hash(token);
  tasks.set(task.id, { task, resolve: () => undefined, reject: () => undefined }); jobTokens.set(h, task.id);
  return { task, token, done: () => { jobTokens.delete(h); tasks.delete(task.id); } };
}

let watchdog: ReturnType<typeof setInterval> | null = null;
function ensureWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    for (const p of tasks.values()) {
      if (p.task.mode !== 'terminal' || p.task.status !== 'claimed' || !p.task.claimedBy) continue;
      if (!workerConnected(p.task.claimedBy)) finishTask(p.task.id, 'failed', ccError('backend_unavailable', 'La consola de Claude Code que atendía la tarea se desconectó. Lo hecho en el proceso se conserva; «Continuar» la vuelve a poner en cola.'));
    }
    if (!tasks.size && watchdog) { clearInterval(watchdog); watchdog = null; }
  }, 5_000);
  watchdog.unref();
}

/**
 * Pone una tarea en la cola de la consola y espera su resultado. Sin consola conectada y autorizada para ese agente,
 * falla en el acto (no hay espera indefinida ni cambio silencioso a otro origen facturable).
 */
export function submitTerminalTask(t: NewTask, timeoutMs: number, signal: AbortSignal): { task: BridgeTask; result: Promise<string> } {
  if (!connectedWorkersFor(t.slug, t.agentId).length) throw ccError('backend_unavailable', `No hay ninguna consola de Claude Code conectada y autorizada para «${t.agentName}». Abre Claude Code con el puente del Portal y pulsa «Continuar».`);
  const task: BridgeTask = { ...t, id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'pending', claimedBy: null, progress: [] };
  const result = new Promise<string>((resolve, reject) => {
    tasks.set(task.id, { task, resolve, reject });
    const timer = setTimeout(() => finishTask(task.id, 'failed', ccError('timeout', `La consola no entregó el resultado dentro del plazo (${Math.round(timeoutMs / 1000)} s). Lo hecho se conserva.`)), timeoutMs);
    timer.unref();
    const onAbort = () => finishTask(task.id, 'cancelled', ccError('cancelled', 'Tarea de consola cancelada por el propietario.'));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    const p = tasks.get(task.id); if (p) { const res = p.resolve; const rej = p.reject; p.resolve = v => { cleanup(); res(v); }; p.reject = e => { cleanup(); rej(e); }; }
  });
  ensureWatchdog();
  return { task, result };
}

function finishTask(id: string, status: BridgeTask['status'], outcome: string | Error) {
  const p = tasks.get(id); if (!p || ['done', 'failed', 'cancelled'].includes(p.task.status)) return;
  p.task.status = status; tasks.delete(id);
  if (typeof outcome === 'string') p.resolve(outcome); else p.reject(outcome);
}

export function listTasks(scope: BridgeScope): BridgeTask[] {
  if (scope.kind === 'job') { const t = tasks.get(scope.taskId)?.task; return t ? [t] : []; }
  return [...tasks.values()].map(p => p.task).filter(t => t.slug === scope.slug && t.mode === 'terminal' && (t.status === 'pending' || t.claimedBy === scope.workerId)
    && scope.agentIds.includes(t.agentId) && terminalAgentAllowed(t.slug, t.agentId, t.projectId));
}

export function claimTask(scope: BridgeScope, id: string): BridgeTask | Denied {
  if (scope.kind !== 'worker') return deny(403, 'Solo una consola puede tomar tareas.');
  const t = taskFor(scope, id); if (isDenied(t)) return t;
  if (t.status === 'pending') { t.status = 'claimed'; t.claimedBy = scope.workerId; }
  return t;
}

export function reportProgress(scope: BridgeScope, id: string | undefined, message: string): BridgeTask | Denied {
  const t = taskFor(scope, id); if (isDenied(t)) return t;
  if (scope.kind === 'worker' && t.claimedBy !== scope.workerId) return deny(409, 'Toma la tarea antes de informar de su progreso.');
  t.progress = [...t.progress, { at: new Date().toISOString(), message: message.trim().slice(0, 500) }].slice(-20);
  onProgress?.(t, message.trim().slice(0, 500));
  return t;
}
/** Lo registra el backend para reflejar el progreso en el paso del proceso y en el registro de ejecuciones. */
let onProgress: ((t: BridgeTask, message: string) => void) | null = null;
export function setProgressListener(fn: typeof onProgress) { onProgress = fn; }

export function submitResult(scope: BridgeScope, id: string, text: string): { ok: true } | Denied {
  if (scope.kind !== 'worker') return deny(403, 'En una ejecución gestionada, el resultado es la respuesta final de Claude Code.');
  const t = taskFor(scope, id); if (isDenied(t)) return t;
  if (t.claimedBy !== scope.workerId) return deny(409, 'Toma la tarea antes de entregar el resultado.');
  const body = text.trim();
  if (!body) return deny(400, 'El resultado está vacío.');
  if (body.length > 2_000_000) return deny(413, 'El resultado supera el tamaño máximo (2 MB).');
  const secret = scanSecrets(body); if (secret) return deny(422, `${secret} No se acepta: quítalo y vuelve a entregar.`);
  finishTask(t.id, 'done', body);
  return { ok: true };
}

export function reportBlocker(scope: BridgeScope, id: string, reason: string): { ok: true } | Denied {
  if (scope.kind !== 'worker') return deny(403, 'En una ejecución gestionada, un bloqueo se declara en la respuesta.');
  const t = taskFor(scope, id); if (isDenied(t)) return t;
  if (t.claimedBy !== scope.workerId) return deny(409, 'Toma la tarea antes de declarar un bloqueo.');
  finishTask(t.id, 'failed', ccError('backend_unavailable', `La consola declaró un bloqueo: ${reason.trim().slice(0, 1000) || 'sin motivo'}`));
  return { ok: true };
}

// ---------------------------------------------------------------- Lectura acotada (contexto, archivos, conocimiento)

/** Rutas que nunca se leen por el puente, además de las prohibidas para escribir (.git, data/, node_modules/, .env, claves). */
const PROTECTED_READ = [/(^|\/)node_modules(\/|$)/, /(^|\/)\.git(\/|$)/, /(^|\/)\.claude(\/|$)/, /(^|\/)\.ssh(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.npmrc$/i,
  /(^|\/)\.credentials\.json$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /(^|\/)secrets?(\/|$)/i, /\.(keystore|jks|kdbx)$/i];
export function protectedReason(rel: string): string | null {
  let norm: string;
  try { norm = safeRelPath(rel); } catch (e: any) { return e.message; }
  if (PROTECTED_READ.some(r => r.test(norm))) return `Ruta protegida: ${rel}`;
  return null;
}

const MAX_FILE = 200_000;
export function readTaskFile(task: BridgeTask, rel: string): { path: string; content: string; truncated: boolean } | Denied {
  if (!task.readRoot) return deny(404, 'Esta tarea no tiene carpeta de trabajo que leer.');
  const why = protectedReason(rel); if (why) return deny(403, why);
  const norm = safeRelPath(rel);
  let root: string; let full: string;
  try { root = fs.realpathSync(task.readRoot); full = fs.realpathSync(path.join(root, norm)); } catch { return deny(404, `No existe: ${rel}`); }
  // Un enlace simbólico no puede sacar la lectura de la carpeta de trabajo.
  if (full !== root && !full.startsWith(root + path.sep)) return deny(403, `Ruta fuera de la carpeta de trabajo: ${rel}`);
  const st = fs.statSync(full); if (!st.isFile()) return deny(400, `No es un archivo: ${rel}`);
  const fd = fs.openSync(full, 'r'); const buf = Buffer.alloc(Math.min(st.size, MAX_FILE)); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
  if (buf.subarray(0, 8000).includes(0)) return deny(415, `Archivo binario: ${rel}`);
  const content = buf.toString('utf8');
  const secret = scanSecrets(content); if (secret) return deny(403, `${secret} No se entrega por el puente.`);
  return { path: norm, content, truncated: st.size > MAX_FILE };
}

/** Sin git: recorrido acotado que no entra en carpetas protegidas. */
function walk(root: string, max = 5000): string[] {
  const out: string[] = []; const queue = [''];
  while (queue.length && out.length < max) {
    const rel = queue.shift()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!protectedReason(`${r}/x`)) queue.push(r); } else if (e.isFile()) out.push(r);
    }
  }
  return out;
}

export function listTaskFiles(task: BridgeTask, dir = ''): { files: string[]; truncated: boolean } | Denied {
  if (!task.readRoot) return deny(404, 'Esta tarea no tiene carpeta de trabajo que leer.');
  const prefix = dir.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (prefix && protectedReason(`${prefix}/x`)) return deny(403, `Ruta protegida: ${dir}`);
  let all: string[];
  try { all = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: task.readRoot, maxBuffer: 32 * 1024 * 1024, windowsHide: true }).toString('utf8').split('\0').filter(Boolean); }
  catch { all = walk(task.readRoot); }
  const files = all.filter(f => (!prefix || f === prefix || f.startsWith(prefix + '/')) && !protectedReason(f));
  return { files: files.slice(0, 500), truncated: files.length > 500 };
}

export function taskContext(task: BridgeTask) {
  const project = projectsRepo(task.slug).get(task.projectId); const agent = agentsRepo(task.slug).get(task.agentId);
  return {
    task: { id: task.id, title: task.title, role: task.role, mode: task.mode, createdAt: task.createdAt, status: task.status },
    company: workspacesRepo.get(task.slug)?.name ?? task.slug,
    project: project ? { name: project.name, description: project.description } : null,
    agent: agent ? { name: agent.config.name, role: agent.template.role, specialization: agent.config.specialization, responsibilities: agent.config.responsibilities } : null
  };
}

/** Conocimiento aprobado del proyecto de la tarea (solo ese proyecto). */
export function taskKnowledge(task: BridgeTask) {
  return knowledgeRepo(task.slug).list(task.projectId).slice(0, 20).map(d => ({ title: d.title, author: d.authorAgentName, createdAt: d.createdAt, body: d.body.length > 6000 ? `${d.body.slice(0, 6000)}\n… (recortado)` : d.body }));
}

/** Para pruebas: estado interno vacío. */
export function resetBridge() { tasks.clear(); jobTokens.clear(); presence.clear(); }
export const bridgeTaskCount = () => tasks.size;

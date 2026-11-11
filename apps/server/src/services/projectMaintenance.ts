import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ASSIGNMENT_STATUS_LABEL, requiresOf, type AssignmentStatus, type Batch, type BacklogItem, type MaintenanceItem, type MaintenanceOption, type MaintenanceOptionId, type MaintenanceOutcome, type MaintenancePlan, type MaintenanceRun, type MaintenanceSelection, type Process } from '@portal-ia/domain';
import { backlogRepo, processesRepo, projectsRepo, workspaceDb } from '../db/workspace.ts';
import { workspacesRepo } from '../db/platform.ts';
import { batchesRepo } from '../db/batches.ts';
import { assignmentsRepo } from '../db/assignments.ts';
import { acceptAssignment, cancelAssignment } from './assignments.ts';
import { git, remoteInfo, repoRoot } from './repoWrite.ts';
import { withRepoLock } from './repoLock.ts';
import { requirePolicy } from './executionPolicy.ts';
import { acceptItems, cancelItem, closeBatch } from './batchRunner.ts';
import { closingBlocker } from './closing.ts';
import { discardStory } from './backlog.ts';
import { threadRepo } from './storyThread.ts';
import { redactRemote } from './projectDiscovery.ts';
import { runningPlans } from './maintenanceRuns.ts';
import { changed } from './live.ts';

/**
 * Mantenimiento gobernado de un proyecto (ramas, carpetas de trabajo y backlog frente a «main»).
 *
 * 1. Revisión de SOLO LECTURA: ramas locales y del remoto (ls-remote, en vivo), worktrees, historias, procesos y lotes.
 * 2. Plan persistido: cada objetivo con su grupo (seguro / requiere decisión / protegido / fuera del alcance), sus
 *    opciones, consecuencias, cómo recuperarlo y la huella del estado con que se propuso.
 * 3. Ejecución SOLO de lo seleccionado por el propietario, con autorización explícita: justo antes se revisa todo otra
 *    vez; si «main» o el repositorio cambiaron el plan caduca, y lo que cambió desde la propuesta no se toca. Una ejecución
 *    a la vez por proyecto; lo hecho queda anotado objetivo a objetivo (reanudable tras un reinicio) y cada operación pasa
 *    por la política de ejecución (auditoría). Nada de shell libre: solo las operaciones de esta tabla.
 *
 * Reglas que no se saltan: nunca main (ni la rama registrada, ni la por defecto del remoto, ni la activa), nunca ramas en
 * uso (carpeta de trabajo, proceso en curso o pendiente de integrar, lote abierto), nunca forzar; en el remoto solo se
 * borra si la rama SIGUE en el commit revisado (lease) y si su contenido está en el main del remoto Y en el local; lo no
 * integrado solo se borra si se elige expresamente y antes se guarda una copia con nombre único (nunca se sobrescribe);
 * nada se marca «hecho» si su commit no está en main (comprobado con git).
 */

const err = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, code });
const now = () => new Date().toISOString();
const BOOT = crypto.randomUUID(); // este proceso del servidor (un plan «en ejecución» de otro arranque se interrumpió)
const ARCHIVE = 'refs/portal-ia/archivo';
const ZERO = '0000000000000000000000000000000000000000';
const OPEN_STORY = (s: string) => s !== 'done' && s !== 'discarded';
/** Lote abierto: en marcha, en pausa o esperando tu decisión (HU-203). Un lote en 'needs_decision' NO está cerrado: sus
 *  historias pueden seguir sin aceptar o desbloquearse solas, así que sus ramas y carpetas siguen protegidas. */
const OPEN_BATCH = (b: Batch) => b.status === 'running' || b.status === 'paused' || b.status === 'needs_decision';
/** Un lote que no corre ahora (en pausa o esperando tu decisión) se puede cerrar desde la revisión. */
const STILL_BATCH = (b: Batch) => b.status === 'paused' || b.status === 'needs_decision';
const ACTIVE_PROC = (p?: Process | null) => !!p && (p.status === 'running' || p.status === 'pending_authorization');
/** Iteración aplicada en su rama y aún sin integrar ni descartar: su carpeta y su rama hacen falta (verificar, integrar). */
const PENDING_INTEGRATION = (p?: Process | null) => !!p?.result?.applied && !p.result.merged && !p.result.rejected;
/** Estados de un elemento de lote que «Cancelar» admite (batchRunner.cancelItem; «running» queda protegido antes). */
const CANCELLABLE_ITEM = ['queued', 'waiting_dependency', 'needs_owner', 'blocked'];
/** Encargos que siguen abiertos (los aceptados, cancelados o fallidos ya están cerrados). */
const OPEN_ASSIGNMENT: AssignmentStatus[] = ['draft', 'pending_authorization', 'running', 'needs_owner', 'ready_for_review', 'changes_requested'];
const busyProjects = new Set<string>(); // una ejecución a la vez por proyecto (dos revisiones distintas no compiten)

/** Avisos de cambio de estado de un plan (p. ej. la tarjeta del Asistente que lo propuso). */
const listeners = new Set<(p: MaintenancePlan) => void>();
export function onPlanChange(fn: (p: MaintenancePlan) => void) { listeners.add(fn); return () => listeners.delete(fn); }

/** git con tiempo límite (operaciones de red: el remoto puede no responder). */
function gitT(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, stdout, stderr) => {
      if (e) reject(Object.assign(new Error(`${(stderr || e.message || '').toString().trim() || 'sin respuesta'}${(e as any).killed ? ' (tiempo agotado)' : ''}`), { statusCode: 502 }));
      else resolve(stdout.toString().trim());
    });
  });
}
/** ¿git termina bien? Asíncrono: una revisión con cientos de ramas no congela el servidor. */
const gitOk = (cwd: string, args: string[]) => new Promise<boolean>(resolve => { execFile('git', args, { cwd, windowsHide: true }, e => resolve(!e)); });

/** Lo que GitHub (u otro remoto) contesta, en lenguaje claro y con el permiso concreto que falta. */
export function explainRemoteError(message: string): string {
  if (/stale info|rejected.*lease/i.test(message)) return 'La rama cambió en el remoto justo antes de borrarla (alguien publicó en ella): no se borró. Revisa de nuevo.';
  if (/remote ref does not exist|unable to delete/i.test(message)) return 'La rama ya no existía en el remoto.';
  if (/protected branch|GH006|protected/i.test(message)) return 'El remoto protege esta rama (regla de rama protegida). Quítale la protección en GitHub › Settings › Branches si de verdad quieres borrarla; el Portal no la salta.';
  // Servidor git propio con `receive.denyDeletes`: el mismo caso (el remoto no deja borrar), con su causa real.
  if (/deletion prohibited/i.test(message)) return 'El remoto protege esta rama contra el borrado (el servidor rechaza borrar ramas: «deletion prohibited»). Cámbialo en el servidor si de verdad quieres borrarla; el Portal no lo salta.';
  if (/publickey|host key|Permission denied \(/i.test(message)) return 'No se pudo autenticar con el remoto (clave SSH o credencial de este equipo). Revisa la credencial de git; nada se forzó.';
  if (/403|denied|permission|not allowed|write access/i.test(message)) return 'El remoto rechazó el borrado: la credencial de git de este equipo no tiene permiso de escritura en el repositorio (en GitHub, «Contents: Read and write»). Concede ese permiso y reintenta; nada se forzó.';
  if (/could not resolve|unable to access|timed out|tiempo agotado|connection|network|sin respuesta|does not appear to be a git repository|could not read from remote|not found/i.test(message)) return 'No se pudo conectar con el remoto (red, dirección o servicio). No se cambió nada en el remoto; reintenta más tarde.';
  return 'El remoto rechazó la operación.';
}

// ---------------------------------------------------------------------------------------------------------------- datos
function ensure(slug: string) {
  const db = workspaceDb(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS maintenance_plans (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, doc_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS maintenance_plans_project ON maintenance_plans(project_id, created_at);`);
  return db;
}
function notify(p: MaintenancePlan) { changed({ ws: p.workspace, entity: 'backlog', id: p.id, projectId: p.projectId }); for (const f of listeners) { try { f(p); } catch { /* un aviso no rompe el plan */ } } }
function save(slug: string, p: MaintenancePlan): MaintenancePlan {
  p.updatedAt = now();
  ensure(slug).prepare(`INSERT INTO maintenance_plans (id, project_id, status, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, doc_json = excluded.doc_json, updated_at = excluded.updated_at`).run(p.id, p.projectId, p.status, JSON.stringify(p), p.createdAt, p.updatedAt);
  notify(p);
  return p;
}
function load(slug: string, id: string): MaintenancePlan | null {
  const r = ensure(slug).prepare('SELECT doc_json FROM maintenance_plans WHERE id = ?').get(id) as any;
  return r ? JSON.parse(r.doc_json) : null;
}
/**
 * Plan por id (de ESTA empresa). Un plan «en ejecución» que no corre aquí: si lo empezó otro arranque del servidor o lleva
 * más de 2 min sin avanzar, se interrumpió (queda reanudable); si no, se respeta (otro proceso lo está ejecutando).
 */
export function getPlan(slug: string, id: string): MaintenancePlan {
  const p = load(slug, id); if (!p) throw err(404, 'Revisión no encontrada en esta empresa.', 'not_found');
  if (p.status === 'running' && !runningPlans.has(id)) {
    const quiet = Date.now() - Date.parse(p.updatedAt) > 120_000;
    if (p.execution?.runner === BOOT || quiet || !p.execution?.runner) {
      p.status = 'partial'; if (p.execution) { p.execution.interrupted = true; p.execution.finishedAt = p.execution.finishedAt ?? now(); }
      save(slug, p);
    }
  }
  return p;
}
/**
 * Al arrancar el servidor: en este proceso aún no corre ninguna revisión, así que un plan «en ejecución» es de un arranque
 * anterior y se interrumpió. Queda «a medias» (reanudable) y su tarjeta del Asistente lo dice sin esperar a que alguien lo abra.
 */
export function recoverInterruptedPlans(): number {
  let n = 0;
  for (const w of workspacesRepo.list()) {
    try {
      const db = workspaceDb(w.slug);
      if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_plans'`).get()) continue;
      for (const r of db.prepare(`SELECT id FROM maintenance_plans WHERE status = 'running'`).all() as any[]) {
        const p = load(w.slug, r.id); if (!p || runningPlans.has(p.id)) continue;
        p.status = 'partial'; if (p.execution) { p.execution.interrupted = true; p.execution.finishedAt = p.execution.finishedAt ?? now(); }
        save(w.slug, p); n++;
      }
    } catch { /* una empresa ilegible no impide arrancar */ }
  }
  return n;
}
/** Todas las revisiones pendientes del proyecto (sin el límite de la lista: muchas revisiones nuevas no esconden una pendiente). */
export function pendingPlans(slug: string, projectId: string): MaintenancePlan[] {
  return (ensure(slug).prepare(`SELECT id FROM maintenance_plans WHERE project_id = ? AND status = 'proposed' ORDER BY created_at DESC`).all(projectId) as any[]).map(r => load(slug, r.id)).filter((p): p is MaintenancePlan => !!p);
}
export function listPlans(slug: string, projectId: string): MaintenancePlan[] {
  return (ensure(slug).prepare('SELECT id FROM maintenance_plans WHERE project_id = ? ORDER BY created_at DESC LIMIT 20').all(projectId) as any[]).map(r => getPlan(slug, r.id));
}
export function setPlanSource(slug: string, id: string, source: NonNullable<MaintenancePlan['source']>) {
  // Una revisión que preparó el propietario nunca pasa a la tarjeta de una conversación (cualquiera puede escribir al Asistente).
  const p = load(slug, id); if (p && !p.source && p.createdBy !== 'owner') save(slug, { ...p, source });
}

// ------------------------------------------------------------------------------------------------------------ revisión
interface Worktree { path: string; branch: string | null; head: string | null; managed: boolean; processId: string | null; locked: boolean; prunable: boolean }
interface Inventory {
  projectId: string; cwd: string; main: string | null; mainSha: string | null; current: string | null; registered: string | null;
  remote: string | null; remoteUrl: string | null; pushDiffers: boolean;
  remoteHeads: Map<string, string> | null; remoteError: string | null; remoteDefault: string | null; remoteMainSha: string | null;
  local: Map<string, string>; worktrees: Worktree[];
  /** Procesos y ramas de OTRAS empresas del Portal que registraron este mismo repositorio (en uso; no se nombran). */
  foreignProcs: Set<string>; foreignBranches: Set<string>;
  stories: BacklogItem[]; processes: Process[]; batches: Batch[];
}

async function worktreeList(cwd: string): Promise<Worktree[]> {
  const base = path.resolve(cwd, '..', `${path.basename(cwd)}-worktrees`).toLowerCase();
  const out: Worktree[] = []; let cur: any = null;
  const flush = () => {
    if (!cur) return;
    const abs = path.resolve(cur.path);
    if (abs.toLowerCase() !== cwd.toLowerCase()) {
      // Del Portal solo si cuelga DIRECTAMENTE de <repo>-worktrees (las carpetas anidadas no se retiran por nombre).
      const managed = path.dirname(abs).toLowerCase() === base && /^[A-Za-z0-9-]{4,64}$/.test(path.basename(abs));
      out.push({ path: abs, branch: cur.branch, head: cur.head, managed, processId: managed ? path.basename(abs) : null, locked: !!cur.locked, prunable: !!cur.prunable });
    }
    cur = null;
  };
  for (const line of `${await git(cwd, ['worktree', 'list', '--porcelain']).catch(() => '')}\n`.split('\n')) {
    if (line.startsWith('worktree ')) { flush(); cur = { path: line.slice(9), branch: null, head: null }; }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
    else if (line === '') flush();
  }
  flush();
  return out;
}

/** La rama principal sin adivinar, la misma que usa la integración: main, master o, si no hay, la registrada; si no, no se revisan ramas. */
async function principal(cwd: string, registered: string | null): Promise<string | null> {
  for (const b of ['main', 'master', registered]) if (b && await gitOk(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`])) return b;
  return null;
}

async function inventory(slug: string, projectId: string): Promise<Inventory> {
  const repo = projectsRepo(slug).repository(projectId);
  if (!repo) throw err(409, 'El proyecto no tiene repositorio registrado (Resumen › Repositorio).', 'no_repository');
  const cwd = repoRoot(repo.path);
  if (!fs.existsSync(path.join(cwd, '.git'))) throw err(409, 'La carpeta registrada no es un repositorio git.', 'not_git');
  const registered = (repo as any).branch ?? null;
  const main = await principal(cwd, registered);
  const mainSha = main ? await git(cwd, ['rev-parse', '--verify', `refs/heads/${main}`]).catch(() => null) : null;
  const current = (await git(cwd, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).replace(/^refs\/heads\//, '') || null;
  const info = await remoteInfo(cwd); const { url } = info; const remote = info.remote && !info.remote.startsWith('-') ? info.remote : null;
  let pushDiffers = false;
  if (remote) { const push = await git(cwd, ['remote', 'get-url', '--push', remote]).catch(() => url); pushDiffers = !!push && !!url && push !== url; }
  let remoteHeads: Map<string, string> | null = null; let remoteError: string | null = null; let remoteDefault: string | null = null;
  if (remote) {
    try {
      const out = await gitT(cwd, ['ls-remote', '--symref', remote, 'HEAD', 'refs/heads/*'], 25_000);
      remoteHeads = new Map();
      for (const line of out.split('\n')) {
        const sym = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line); if (sym) { remoteDefault = sym[1]; continue; }
        const m = /^([0-9a-f]{40})\s+refs\/heads\/(.+)$/.exec(line.trim()); if (m) remoteHeads.set(m[2], m[1]);
      }
      // Para saber si una rama del remoto está en main hacen falta sus commits: se traen SOLO los objetos (sin destino, sin
      // podar, sin FETCH_HEAD, sin submódulos ni gc): no cambia ninguna rama ni referencia.
      const have = await present(cwd, [...remoteHeads.values()]);
      const missing = [...remoteHeads.entries()].filter(([, s]) => !have.has(s)).map(([n]) => `refs/heads/${n}`);
      if (missing.length) await withRepoLock(cwd, () => gitT(cwd, ['fetch', '--no-tags', '--no-prune', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-gc', '--refmap=', remote, ...missing.slice(0, 200)], 45_000)).catch(() => '');
    } catch (e: any) { remoteError = explainRemoteError(e.message); remoteHeads = null; }
  }
  const remoteMainSha = remoteHeads && main ? remoteHeads.get(main) ?? null : null;
  const local = new Map<string, string>();
  for (const l of (await git(cwd, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads']).catch(() => '')).split('\n')) { const [n, s] = l.split('\t'); if (n?.startsWith('refs/heads/') && s) local.set(n.slice('refs/heads/'.length), s); }
  // Procesos y lotes de TODOS los proyectos de la empresa que usan este mismo repositorio (sus ramas también están en uso).
  const sameRepo = projectsRepo(slug).list().filter(p => { const r = projectsRepo(slug).repository(p.id); return r && repoRoot(r.path).toLowerCase() === cwd.toLowerCase(); }).map(p => p.id);
  const ids = sameRepo.includes(projectId) ? sameRepo : [projectId, ...sameRepo];
  const foreignProcs = new Set<string>(); const foreignBranches = new Set<string>();
  for (const w of workspacesRepo.list()) {
    if (w.slug === slug) continue;
    try {
      for (const pr of projectsRepo(w.slug).list()) {
        const r = projectsRepo(w.slug).repository(pr.id); if (!r || repoRoot(r.path).toLowerCase() !== cwd.toLowerCase()) continue;
        for (const x of processesRepo(w.slug).list(pr.id)) { foreignProcs.add(x.id); const br = x.result?.applied?.branch; if (br) foreignBranches.add(br); }
      }
    } catch { /* una empresa ilegible no cambia la revisión */ }
  }
  return {
    foreignProcs, foreignBranches,
    projectId, cwd, main, mainSha, current, registered, remote, remoteUrl: redactRemote(url), pushDiffers, remoteHeads, remoteError, remoteDefault, remoteMainSha, local, worktrees: await worktreeList(cwd),
    stories: backlogRepo(slug).list(projectId), processes: ids.flatMap(id => processesRepo(slug).list(id)), batches: ids.flatMap(id => batchesRepo(slug).list(id))
  };
}
const hasObject = (cwd: string, sha: string) => gitOk(cwd, ['cat-file', '-e', `${sha}^{commit}`]);
/** Qué commits de la lista existen ya en este equipo (una sola llamada a git). */
function present(cwd: string, shas: string[]): Promise<Set<string>> {
  if (!shas.length) return Promise.resolve(new Set());
  return new Promise(resolve => {
    const child = execFile('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
      resolve(e ? new Set() : new Set(String(out).split('\n').map(l => l.split(' ')).filter(([, t]) => t === 'commit').map(([s]) => s)));
    });
    child.stdin?.end(`${shas.join('\n')}\n`);
  });
}
/** ¿Este commit está en este main? Comprobado con git (no basta lo que diga el registro del proceso). */
async function contains(cwd: string, base: string | null, sha: string | null | undefined): Promise<boolean> {
  if (!base || !sha || !await hasObject(cwd, sha)) return false;
  return gitOk(cwd, ['merge-base', '--is-ancestor', sha, base]);
}

async function uniqueOf(cwd: string, base: string | null, sha: string): Promise<{ count: number | null; commits: string[] }> {
  if (!base || !await hasObject(cwd, sha) || !await hasObject(cwd, base)) return { count: null, commits: [] };
  const count = parseInt(await git(cwd, ['rev-list', '--count', `${base}..${sha}`]).catch(() => 'NaN'), 10);
  const commits = Number.isFinite(count) && count > 0 ? (await git(cwd, ['log', '--format=%h %s', '-n', '5', `${base}..${sha}`]).catch(() => '')).split('\n').filter(Boolean) : [];
  return { count: Number.isFinite(count) ? count : null, commits };
}

const O = {
  keep: { id: 'keep', label: 'Conservar', effect: 'No se toca.', destructive: false } as MaintenanceOption,
  deleteRemote: (remote: string) => ({ id: 'delete_remote', label: `Borrar en ${remote}`, effect: `Se borra la rama de ${remote}. Todo su contenido ya está en main, así que no se pierde nada.`, destructive: true } as MaintenanceOption),
  archiveRemote: (remote: string) => ({ id: 'archive_delete_remote', label: `Guardar copia y borrar en ${remote}`, effect: `Se guarda una copia de su trabajo en este equipo y se borra de ${remote}. Ese trabajo NO está en main.`, destructive: true } as MaintenanceOption),
  deleteLocal: { id: 'delete_local', label: 'Borrar en este equipo', effect: 'Se borra la rama de este equipo. Todo su contenido ya está en main, así que no se pierde nada.', destructive: true } as MaintenanceOption,
  archiveLocal: { id: 'archive_delete_local', label: 'Guardar copia y borrar', effect: 'Se guarda una copia de su trabajo en este equipo y la rama deja de aparecer. Ese trabajo NO está en main.', destructive: true } as MaintenanceOption,
  removeWorktree: (dirty: boolean) => ({ id: 'remove_worktree', label: 'Retirar la carpeta de trabajo', effect: dirty ? 'Se borra la carpeta de trabajo aislada del proceso CON sus archivos sin guardar (se pierden). La rama se conserva.' : 'Se borra la carpeta de trabajo aislada del proceso. La rama y su contenido se conservan.', destructive: true } as MaintenanceOption),
  accept: (force: boolean) => ({ id: 'accept', label: force ? 'Aceptar con tu motivo' : 'Aceptar y cerrar', effect: force ? 'Se acepta en su lote aunque le falta un paso de la regla de cierre; tu motivo queda en el historial.' : 'Se acepta en su lote (integrada en main, activa y probada) y queda completada.', destructive: false, needsReason: force } as MaintenanceOption),
  closeDone: (force: boolean) => ({ id: 'close_done', label: force ? 'Cerrar como hecha (con tu motivo)' : 'Cerrar como hecha', effect: force ? 'Su código está en main, pero le falta un paso de la regla de cierre: se cierra como hecha con tu motivo (queda en el historial).' : 'Cumple la regla de cierre (integrada, activa y probada): queda completada.', destructive: false, needsReason: force } as MaintenanceOption),
  discardMerged: { id: 'discard', label: 'Cancelar (no se hará)', effect: 'Ojo: su código YA está en main. Cancelarla solo la quita del backlog («Descartadas», con tu motivo); el código sigue en main.', destructive: true, needsReason: true } as MaintenanceOption,
  discard: { id: 'discard', label: 'Cancelar (no se hará)', effect: 'La historia pasa a «Descartadas» con tu motivo; su historial se conserva. Su trabajo sin integrar, si lo hay, sigue en su rama y ya no se ofrece integrarlo.', destructive: true, needsReason: true } as MaintenanceOption,
  discardIteration: { id: 'discard_iteration', label: 'Descartar la iteración', effect: 'La iteración queda descartada con tu motivo: no se integrará y su carpeta y su rama dejan de estar reservadas (se pueden retirar en esta misma revisión).', destructive: true, needsReason: true } as MaintenanceOption,
  acceptAssignment: (force: boolean) => ({ id: 'accept_assignment', label: force ? 'Aceptar con tu motivo' : 'Aceptar', effect: force ? 'Su trabajo está en main, pero le falta un paso de la regla de cierre: se acepta con tu motivo (queda en el historial).' : 'Su trabajo está en main y cumple la regla de cierre: queda aceptado.', destructive: false, needsReason: force } as MaintenanceOption),
  cancelAssignment: { id: 'cancel_assignment', label: 'Cancelar el encargo', effect: 'El encargo queda cancelado con tu motivo (no se borra nada; si su proceso espera autorización, también se cancela).', destructive: true, needsReason: true } as MaintenanceOption,
  closeBatch: { id: 'close_batch', label: 'Cerrar el lote', effect: 'El lote se cierra con tu motivo (sin IA): si todo lo suyo está integrado queda completado; si no, sus historias sin terminar quedan canceladas EN EL LOTE. No se pierde código (lo integrado sigue en main y lo demás en sus ramas) y cada historia sigue en el backlog con su estado, para decidirla en una revisión posterior.', destructive: true, needsReason: true } as MaintenanceOption
};

/**
 * Clasifica el inventario en objetivos. Determinista y sin IA: la misma entrada da el mismo plan.
 *
 * Primero lo que se decide (historias, encargos, iteraciones sueltas, lotes) y después carpetas y ramas, que pueden
 * depender de ello: una rama del lote en pausa, o la carpeta de una iteración que nadie integrará, no son intocables si en
 * esta MISMA revisión eliges también cerrar el lote, cancelar la historia o descartar la iteración («requires»). Lo que no
 * depende de una decisión tuya (main, lo que está en marcha, lo bloqueado, lo de otra empresa o herramienta) sigue protegido.
 */
async function classify(slug: string, inv: Inventory): Promise<MaintenanceItem[]> {
  const items: MaintenanceItem[] = [];
  const procs = processesRepo(slug);
  const procById = new Map(inv.processes.map(p => [p.id, p]));
  const getProc = (id?: string | null) => (id ? procById.get(id) ?? procs.get(id) ?? null : null); // incluye archivados
  const storyById = new Map(inv.stories.map(s => [s.id, s]));
  const openBatches = inv.batches.filter(OPEN_BATCH);
  const batchOfProcess = new Map<string, Batch>(); const batchItemOfStory = new Map<string, { batch: Batch; item: Batch['items'][number] }>();
  const batchBranches = new Map<string, Batch>();
  for (const b of openBatches) for (const it of b.items) {
    const pids = [it.processId, ...(it.processIds ?? []), it.nextProcessId, it.followedProcessId, it.resumeProcessId].filter(Boolean) as string[];
    for (const pid of pids) { batchOfProcess.set(pid, b); const br = getProc(pid)?.result?.applied?.branch; if (br) batchBranches.set(br, b); }
    batchItemOfStory.set(it.itemId, { batch: b, item: it });
  }
  const procsOfBranch = new Map<string, Process[]>();
  for (const p of inv.processes) { const br = p.result?.applied?.branch; if (br) procsOfBranch.set(br, [...(procsOfBranch.get(br) ?? []), p]); }
  const storyOf = (p?: Process | null) => (p?.backlogItemId ? storyById.get(p.backlogItemId) ?? backlogRepo(slug).get(p.backlogItemId) ?? null : null);
  const storyRef = (s: BacklogItem | null) => s ? { id: s.id, storyId: s.storyId ?? '', title: s.title, status: s.status } : null;
  const wtByBranch = new Map(inv.worktrees.filter(w => w.branch).map(w => [w.branch!, w]));
  const protectedNames = new Set([inv.main, inv.registered, 'main', 'master', inv.current, inv.remoteDefault].filter(Boolean) as string[]);
  const batchLabel = (b: Batch) => `«${b.title}» (${b.status === 'paused' ? 'en pausa' : b.status === 'needs_decision' ? 'necesita tu decisión' : 'en marcha'})`;
  const keepItem = (base: any, id: string, category: MaintenanceItem['category'], status: string, reason: string, fingerprint: string) => items.push({ ...base, id, category, status, reason, options: [O.keep], defaultOption: 'keep', consequences: 'Se conserva.', recovery: null, fingerprint });
  const assignments = assignmentsRepo(slug).list(inv.projectId);

  if (!inv.main) return [{ id: 'repo:main', kind: 'local_branch', name: 'Rama principal', category: 'protected', status: 'No se pudo determinar', reason: 'El repositorio no tiene la rama registrada ni main/master: sin una base segura no se propone limpiar ramas.', options: [O.keep], defaultOption: 'keep', consequences: 'No se toca nada.', recovery: null, fingerprint: '-' }];

  // ---------------------------------------------------------------------------------- 1. Lo que se decide
  // Historias abiertas: estado verdadero según su proceso, su lote y main (comprobado con git).
  for (const s of inv.stories.filter(x => OPEN_STORY(x.status))) {
    const bi = batchItemOfStory.get(s.id);
    const p = (bi ? getProc(bi.item.followedProcessId ?? bi.item.processId) : null) ?? getProc(s.lastProcessId) ?? inv.processes.find(x => x.backlogItemId === s.id && x.kind === 'story_execution') ?? null;
    const base = { kind: 'story' as const, name: `${s.storyId ?? ''} · ${s.title}`, story: storyRef(s), processId: p?.id ?? null, batchId: bi?.batch.id ?? null };
    const id = `story:${s.id}`;
    const fp = `${s.status}:${p?.id ?? '-'}:${p?.status ?? '-'}:${p?.result?.merged?.commit ?? '-'}:${bi?.item.state ?? '-'}:${s.lastProcessId ?? '-'}`;
    const merged = !!p?.result?.merged && await contains(inv.cwd, `refs/heads/${inv.main}`, p.result.merged.commit);
    const branch = p?.result?.applied?.branch ?? null;
    // En curso de verdad (ejecutándose): protegida. Una iteración que solo espera autorización no lo está: cancelar la historia
    // la deniega, igual que «Denegar» en Decisiones.
    if (p?.status === 'running' || s.status === 'in_progress' || bi?.item.state === 'running') { keepItem(base, id, 'protected', 'En curso', 'Tiene un proceso en curso: no se cancela ni se oculta.', fp); continue; }
    if (bi) {
      const st = bi.item.state;
      // Una iteración más reciente de la historia, lanzada fuera del lote y aún viva: el lote no la conoce; se decide allí.
      const newer = s.lastProcessId && s.lastProcessId !== p?.id ? getProc(s.lastProcessId) : null;
      if (newer && newer.status !== 'cancelled' && !newer.result?.rejected) { keepItem(base, id, 'decision', 'Tiene una iteración más reciente fuera del lote', `Decídelo en la historia o en el lote «${bi.batch.title}»: el lote no conoce esa iteración.`, fp); continue; }
      // En un lote en pausa, cualquier cambio toca ese lote: nunca se marca solo; elegirlo es incluir el lote en tu decisión.
      const paused = STILL_BATCH(bi.batch);
      const inBatch = `En el lote «${bi.batch.title}»${paused ? ' (en pausa: elegir una acción aquí cambia ese lote)' : ''}`;
      if (st === 'awaiting_acceptance') {
        // Reabierta (la devolviste a pendiente): nunca se ofrece como hecha.
        if (s.status !== 'review' && s.status !== 'blocked') { keepItem(base, id, 'decision', 'Reabierta (pendiente)', `La devolviste a pendiente: decídelo en el lote «${bi.batch.title}».`, fp); continue; }
        const blocker = merged ? await closingBlocker(slug, p ?? undefined, 'historia') : null;
        if (merged && !blocker) items.push({ ...base, id, category: paused ? 'decision' : 'safe', status: 'Integrada en main, activa y probada', reason: `${inBatch}: solo falta tu aceptación.`, options: [O.keep, O.accept(false)], defaultOption: paused ? 'keep' : 'accept', consequences: 'Queda completada; el lote la anota como aceptada.', recovery: 'Su historial y su proceso se conservan.', fingerprint: fp });
        else if (merged) items.push({ ...base, id, category: 'decision', status: 'Integrada en main; falta un paso', reason: `${inBatch}. Falta: ${blocker!.error}`, options: [O.keep, O.accept(true)], defaultOption: 'keep', consequences: 'Aceptarla la cierra como hecha (es verdad: su código está en main) y deja constancia de lo que faltaba.', recovery: 'Su historial se conserva.', fingerprint: fp });
        else keepItem(base, id, 'decision', 'Esperando aceptación, pero su commit no está en main', `Revísala en el lote «${bi.batch.title}».`, fp);
        continue;
      }
      if (st === 'rejected') { keepItem(base, id, 'decision', 'No la aceptaste en el lote', `Decídelo en el lote «${bi.batch.title}» (iterar o cancelar).`, fp); continue; }
      if (CANCELLABLE_ITEM.includes(st)) items.push({ ...base, id, category: 'decision', status: merged ? 'Integrada en main; el lote espera tu decisión' : branch ? 'Sus cambios solo están en su rama' : 'No llegó a implementarse', reason: `${inBatch}: ${st === 'needs_owner' ? 'necesita tu decisión' : 'pendiente'}.${merged ? ' Si el trabajo está bien, acéptala en el lote en vez de cancelarla.' : ''}`,
        options: [O.keep, merged ? O.discardMerged : O.discard], defaultOption: 'keep', consequences: 'Cancelarla la quita de las pendientes del lote y del backlog (queda en «Descartadas» con tu motivo); si tiene una iteración esperando autorización, se deniega.', recovery: 'Su historial y su rama se conservan.', fingerprint: fp });
      else keepItem(base, id, 'decision', 'Se decide en su lote', `Su estado en el lote «${bi.batch.title}» se decide allí, o cierra el lote y vuelve a revisar.`, fp);
      continue;
    }
    if (merged && (s.status === 'review' || s.status === 'blocked')) {
      const blocker = await closingBlocker(slug, p ?? undefined, 'historia');
      if (!blocker) items.push({ ...base, id, category: 'safe', status: 'Integrada en main, activa y probada', reason: 'Cumple la regla de cierre.', options: [O.keep, O.closeDone(false)], defaultOption: 'close_done', consequences: 'Queda completada.', recovery: 'Su historial se conserva.', fingerprint: fp });
      else items.push({ ...base, id, category: 'decision', status: 'Integrada en main; falta un paso', reason: `Falta: ${blocker.error}`, options: [O.keep, O.closeDone(true), O.discardMerged], defaultOption: 'keep', consequences: 'Cerrarla como hecha es verdad (su código está en main) y queda constancia de lo que faltaba.', recovery: 'Su historial se conserva.', fingerprint: fp });
      continue;
    }
    // Pendiente (también una que reabriste aunque una iteración anterior llegara a main): nunca se ofrece como hecha.
    items.push({ ...base, id, category: 'decision', status: s.status === 'pending' && merged ? 'Reabierta (pendiente)' : branch && !merged ? `Sus cambios solo están en la rama ${branch}` : 'No se ha implementado',
      reason: s.status === 'pending' && merged ? 'La devolviste a pendiente: no se cierra como hecha.' : branch && !merged ? 'Su trabajo no está en main.' : 'No tiene cambios en main.',
      options: [O.keep, merged ? O.discardMerged : O.discard], defaultOption: 'keep', consequences: 'Cancelarla la quita del backlog activo (queda en «Descartadas» con tu motivo); nunca se marca como hecha. Si tiene una iteración esperando autorización, se deniega.', recovery: 'Su historial se conserva.', fingerprint: fp });
  }

  // Historias ya hechas que un lote (abierto o cerrado) sigue mostrando «pendientes de tu aceptación»: aceptarlas solo lo
  // anota en el lote (su código ya está en main; no integra nada). Las descartadas nunca (aceptar las marcaría hechas).
  for (const b of inv.batches.filter(x => x.status !== 'running' && x.projectId === inv.projectId)) for (const it of b.items) {
    if (it.state !== 'awaiting_acceptance') continue;
    const s = storyById.get(it.itemId) ?? backlogRepo(slug).get(it.itemId) ?? null;
    if (!s || s.status !== 'done') continue;
    const p = getProc(it.followedProcessId ?? it.processId);
    if (!p?.result?.merged || !await contains(inv.cwd, `refs/heads/${inv.main}`, p.result.merged.commit)) continue;
    const blocker = await closingBlocker(slug, p, 'historia');
    items.push({ kind: 'story', id: `batchitem:${b.id}:${it.itemId}`, name: `${s.storyId ?? ''} · ${s.title}`, category: 'decision', status: `Hecha; el lote «${b.title}» aún la muestra pendiente de aceptación`,
      reason: `Su código ya está en main: aceptarla en el lote solo lo anota (no integra nada).${blocker ? ` Falta: ${blocker.error}` : ''}`, story: storyRef(s), processId: p.id, batchId: b.id,
      options: [O.keep, O.accept(!!blocker)], defaultOption: 'keep', consequences: 'El lote la anota como aceptada; la historia sigue hecha.', recovery: 'Su historial se conserva.', fingerprint: `${b.status}:${it.state}:${s.status}:${p.id}` });
  }

  // Encargos abiertos del proyecto: aceptar (si su trabajo ya está en main) o cancelar; en marcha, protegidos.
  for (const a of assignments) {
    if (!OPEN_ASSIGNMENT.includes(a.status)) continue;
    const p = a.processId ? getProc(a.processId) : null;
    const base = { kind: 'assignment' as const, name: `${a.code} · ${a.title}`, processId: p?.id ?? null };
    const id = `assignment:${a.id}`;
    const fp = `${a.status}:${p?.id ?? '-'}:${p?.status ?? '-'}:${p?.result?.merged?.commit ?? '-'}`;
    if (a.status === 'running' || p?.status === 'running') { keepItem(base, id, 'protected', 'En marcha', 'Un encargo en marcha no se cierra desde aquí.', fp); continue; }
    if (a.status === 'ready_for_review') {
      const merged = !!p?.result?.merged && await contains(inv.cwd, `refs/heads/${inv.main}`, p.result.merged.commit);
      const blocker = merged ? await closingBlocker(slug, p ?? undefined, 'encargo') : null;
      items.push({ ...base, id, category: 'decision', status: merged ? (blocker ? 'Integrado en main; falta un paso' : 'Integrado en main; listo para aceptar') : 'Listo para tu revisión (no está en main)',
        reason: merged ? (blocker ? `Falta: ${blocker.error}` : 'Su trabajo ya está en main.') : 'Su trabajo no está en main.',
        options: merged ? [O.keep, O.acceptAssignment(!!blocker), O.cancelAssignment] : [O.keep, O.cancelAssignment], defaultOption: 'keep',
        consequences: merged ? 'Aceptarlo lo cierra (es verdad: su trabajo está en main) y deja constancia de lo que faltaba, si faltaba algo.' : 'Cancelarlo lo cierra sin integrar nada.', recovery: 'Su historial y su proceso se conservan.', fingerprint: fp });
      continue;
    }
    items.push({ ...base, id, category: 'decision', status: `Encargo ${ASSIGNMENT_STATUS_LABEL[a.status]}`, reason: 'Sigue abierto: si ya no hace falta, cancélalo (queda en el historial).',
      options: [O.keep, O.cancelAssignment], defaultOption: 'keep', consequences: 'Queda cancelado; si su proceso espera autorización, también.', recovery: 'Su historial se conserva.', fingerprint: fp });
  }

  // Lotes abiertos de este proyecto: protegidos salvo que elijas cerrarlos (con motivo).
  for (const b of openBatches.filter(x => x.projectId === inv.projectId || x.items.some(i => storyById.has(i.itemId)))) {
    // Huella: estado del lote y de cada historia (las acciones de ESTA revisión sobre sus historias se descuentan al ejecutar).
    const fp = `${b.status}|${b.items.map(i => `${i.itemId}=${i.state}`).sort().join(',')}`;
    const base = { kind: 'batch' as const, name: b.title, batchId: b.id };
    if (b.status === 'running') { keepItem(base, `batch:${b.id}`, 'protected', 'En marcha', 'Un lote en marcha no se cierra desde aquí.', fp); continue; }
    const pending = b.items.filter(i => !['accepted', 'cancelled', 'postponed', 'rejected'].includes(i.state));
    items.push({ ...base, id: `batch:${b.id}`, category: 'decision', status: `En pausa · ${pending.length} historia(s) sin cerrar`, reason: 'Está protegido: solo se cierra si lo eliges. Mientras siga abierto, sus ramas y carpetas de trabajo no se tocan (salvo que en esta misma revisión lo cierres).',
      options: [O.keep, O.closeBatch], defaultOption: 'keep', consequences: 'Cerrarlo no pierde código (main y las ramas siguen); lo no terminado queda cancelado en el lote y sus historias siguen en el backlog.', recovery: 'Sus eventos e historias quedan en el historial.', fingerprint: fp });
  }

  // Iteraciones que nadie va a integrar: aplicadas sin integrar ni descartar, con su historia ya cerrada (o sin historia ni
  // encargo abiertos) y fuera de un lote abierto. Mientras sigan así, su carpeta y su rama están «en uso».
  const candidates = new Map<string, Process>(inv.processes.map(p => [p.id, p]));
  for (const w of inv.worktrees) { const p = getProc(w.processId); if (p) candidates.set(p.id, p); }
  for (const p of candidates.values()) {
    if (p.projectId !== inv.projectId || !PENDING_INTEGRATION(p) || ACTIVE_PROC(p) || batchOfProcess.has(p.id) || inv.foreignProcs.has(p.id)) continue;
    const s = storyOf(p); if (s && OPEN_STORY(s.status)) continue; // la decide su historia
    const a = p.assignmentId ? assignmentsRepo(slug).get(p.assignmentId) ?? null : null; if (a && OPEN_ASSIGNMENT.includes(a.status)) continue; // la decide su encargo
    const branch = p.result!.applied!.branch ?? null; const wt = inv.worktrees.find(w => w.processId === p.id);
    if (!wt && !(branch && inv.local.has(branch))) continue; // nada que liberar
    items.push({ kind: 'iteration', id: `iteration:${p.id}`, name: `Iteración de ${s?.storyId || a?.code || p.title}`, category: 'decision',
      status: s ? `Aplicada sin integrar; ${s.storyId} ya está ${s.status === 'done' ? 'hecha' : 'cerrada'}` : 'Aplicada sin integrar; sin historia ni encargo abiertos',
      reason: `Nadie la va a integrar, pero ${wt ? 'su carpeta de trabajo' : 'su rama'}${branch ? ` (${branch})` : ''} sigue reservada para ella. Descartarla libera su carpeta y su rama, que se pueden retirar en esta misma revisión.`,
      story: storyRef(s), processId: p.id, options: [O.keep, O.discardIteration], defaultOption: 'keep',
      consequences: 'La iteración queda descartada (no se integrará); su historial se conserva.', recovery: 'Su rama se conserva hasta que elijas borrarla o guardar una copia.', fingerprint: `${p.status}:${p.result?.applied?.commit ?? '-'}:${p.archivedAt ?? '-'}` });
  }

  // ---------------------------------------------------------------------------------- 2. Carpetas y ramas
  const needLabel = (id: string) => { const it = items.find(i => i.id === id); if (!it) return id;
    return it.kind === 'batch' ? `cerrar el lote «${it.name}»` : it.kind === 'story' ? `cancelar ${it.story?.storyId || it.name}` : it.kind === 'iteration' ? `descartar la iteración de ${it.name.replace(/^Iteración de /, '')}` : it.kind === 'worktree' ? `retirar «${it.name}»` : it.name; };
  /** Un lote en pausa que se puede cerrar en esta revisión deja de proteger lo suyo si eliges cerrarlo. */
  const batchNeed = (b: Batch) => STILL_BATCH(b) && items.some(i => i.id === `batch:${b.id}` && i.options.some(o => o.id === 'close_batch')) ? `batch:${b.id}` : null;
  /** Qué decisión libera una iteración aplicada sin integrar: cancelar su historia abierta o descartar la iteración suelta. */
  const releaseOf = (p: Process): string | null => {
    const s = storyOf(p);
    if (s && OPEN_STORY(s.status)) { const it = items.find(i => i.id === `story:${s.id}`); return it?.options.some(o => o.id === 'discard') ? it.id : null; }
    return items.some(i => i.id === `iteration:${p.id}`) ? `iteration:${p.id}` : null;
  };
  type Guard = { hard: string | null; needs: string[] };
  /** Con dependencias: elegible solo si en esta revisión también eliges lo que la libera (por defecto, «Conservar»). */
  const withNeeds = (g: Guard, item: MaintenanceItem): MaintenanceItem => {
    if (!g.needs.length) return item;
    const needs = [...new Set(g.needs)];
    return { ...item, category: item.category === 'safe' ? 'decision' : item.category, defaultOption: 'keep', requires: [...new Set([...requiresOf(item.requires), ...needs])], reason: `Solo si en esta misma revisión también eliges: ${needs.map(needLabel).join(' · ')}. ${item.reason}` };
  };

  // Carpetas de trabajo (worktrees): las del Portal se pueden retirar si su proceso no está activo; las de un lote en pausa o
  // de una iteración pendiente, solo junto con la decisión que las libera.
  for (const w of inv.worktrees) {
    const p = getProc(w.processId);
    const s = storyOf(p);
    const base = { kind: 'worktree' as const, name: w.managed ? `Carpeta de trabajo de ${s?.storyId || w.branch || path.basename(w.path)}` : path.basename(w.path), story: storyRef(s), processId: w.processId, worktree: w.path, sha: (w.head ?? '').slice(0, 7) || null };
    const id = `worktree:${w.path}`;
    if (!w.managed) { keepItem(base, id, 'outside', 'De otra herramienta', `No la creó el Portal (rama ${w.branch ?? 'sin rama'}): no la gestiona ni la borra.`, `${w.branch}`); continue; }
    const g: Guard = { hard: null, needs: [] };
    if (w.locked) g.hard = 'Está bloqueada (git worktree lock): no se retira.';
    else if (w.processId && inv.foreignProcs.has(w.processId)) g.hard = 'Es de otra empresa del Portal que tiene registrado este mismo repositorio.';
    else if (ACTIVE_PROC(p)) g.hard = 'Su proceso está en curso o esperando autorización.';
    else {
      const b = p ? batchOfProcess.get(p.id) : undefined;
      if (b) { const n = batchNeed(b); if (n) g.needs.push(n); else g.hard = `Protegida por el lote ${batchLabel(b)}.`; }
      if (!g.hard && PENDING_INTEGRATION(p)) { const r = releaseOf(p!); if (r) g.needs.push(r); else g.hard = 'Su iteración está aplicada y pendiente de revisar o integrar: la carpeta hace falta para verificarla o integrarla.'; }
    }
    if (g.hard) { keepItem(base, id, 'protected', 'En uso', g.hard, `${w.branch}:${w.head}:${p?.status ?? '-'}`); continue; }
    // Estado de la carpeta sin bloquear su índice (--no-optional-locks) y viendo TODO lo no guardado; si no se puede leer, no se toca.
    let dirty: number | null = 0;
    try { dirty = (await git(w.path, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'])).split('\n').filter(Boolean).length; } catch { dirty = null; }
    // Commits hechos en la carpeta que no están en ninguna rama (HEAD separado): se perderían.
    const orphan = w.head && await hasObject(inv.cwd, w.head) ? parseInt(await git(inv.cwd, ['rev-list', '--count', w.head, '--not', '--branches', '--tags', '--remotes']).catch(() => 'NaN'), 10) : 0;
    const fp = `${w.branch}@${w.head}:${dirty}:${orphan}:${p?.status ?? '-'}`;
    if (dirty === null || !Number.isFinite(orphan)) { keepItem(base, id, 'decision', 'No se pudo comprobar su estado', 'No se pudo leer si tiene cambios sin guardar: se conserva.', fp); continue; }
    if (orphan > 0) { keepItem(base, id, 'decision', `Tiene ${orphan} commit(s) que no están en ninguna rama`, 'Retirarla los perdería: guárdalos antes en una rama.', fp); continue; }
    items.push(withNeeds(g, { ...base, id, category: dirty ? 'decision' : 'safe', status: dirty ? `Tiene ${dirty} archivo(s) sin guardar en un commit` : 'Carpeta de trabajo inactiva',
      reason: dirty ? 'Retirarla borraría cambios que no están en ningún commit.' : `El proceso${s ? ` de ${s.storyId}` : ''} terminó; la rama ${w.branch ?? '—'} conserva todo su contenido.`,
      options: [O.keep, O.removeWorktree(dirty > 0)], defaultOption: dirty ? 'keep' : 'remove_worktree',
      consequences: dirty ? `Se perderían ${dirty} archivo(s) sin guardar.` : 'Desaparece la carpeta (también lo que git ignora, como dependencias instaladas o .env locales); la rama queda.', recovery: 'Se puede volver a crear desde su rama si hiciera falta.', fingerprint: fp }));
  }

  /** Por qué una rama no se puede tocar ahora («hard») o de qué decisiones de esta revisión depende («needs»). */
  const branchGuard = (name: string): Guard => {
    if (protectedNames.has(name)) return { hard: name === inv.current && name !== inv.main ? 'Es la rama activa del repositorio.' : 'Es la rama principal: nunca se borra.', needs: [] };
    if (inv.foreignBranches.has(name)) return { hard: 'La usa otra empresa del Portal que tiene registrado este mismo repositorio.', needs: [] };
    const ow = wtByBranch.get(name); if (ow && !ow.managed) return { hard: 'Está abierta en una carpeta de trabajo de otra herramienta.', needs: [] };
    const ps = procsOfBranch.get(name) ?? [];
    if (ps.some(ACTIVE_PROC)) return { hard: 'Su proceso está en curso o esperando autorización.', needs: [] };
    const needs: string[] = [];
    const b = batchBranches.get(name) ?? ps.map(p => batchOfProcess.get(p.id)).find(Boolean);
    if (b) { const n = batchNeed(b); if (!n) return { hard: `Protegida por el lote ${batchLabel(b)}: no se puede borrar mientras el lote siga abierto.`, needs: [] }; needs.push(n); }
    for (const p of ps.filter(PENDING_INTEGRATION)) { const r = releaseOf(p); if (!r) return { hard: 'Tiene una iteración aplicada pendiente de revisar o integrar: decídelo en su historia (integrar o «Devolver a pendiente»).', needs: [] }; needs.push(r); }
    return { hard: null, needs };
  };
  /** Rama de historia creada por el Portal (sus ramas «ya integradas» se proponen borrar; las demás, a tu elección). */
  const isStoryBranch = (name: string) => (procsOfBranch.get(name) ?? []).length > 0 || /^portal-ia\//.test(name);
  /** Se propone borrarla sola: rama de historia ya integrada (su proceso la integró) o con commits propios ya en main. Una rama igual a main sin historia integrada puede ser recién creada: decide tú. */
  const autoDelete = (name: string, sha: string) => (procsOfBranch.get(name) ?? []).some(p => !!p.result?.merged) || (isStoryBranch(name) && sha !== inv.mainSha);
  const protectedLabel = (name: string) => name === inv.current && name !== inv.main ? 'Rama activa' : protectedNames.has(name) ? 'Rama principal' : 'En uso';

  // Ramas locales (frente al main local).
  for (const [name, sha] of inv.local) {
    const ps = procsOfBranch.get(name) ?? []; const s = ps.map(storyOf).find(Boolean) ?? null;
    const u = await uniqueOf(inv.cwd, `refs/heads/${inv.main}`, sha);
    const wt = wtByBranch.get(name);
    const base = { kind: 'local_branch' as const, name, sha: sha.slice(0, 7), unique: u.count, uniqueCommits: u.commits, story: storyRef(s), processId: ps[0]?.id ?? null, worktree: wt?.path ?? null, portalBranch: isStoryBranch(name) };
    const id = `local:${name}`;
    const g = branchGuard(name);
    if (!g.hard && wt && !wt.managed) g.hard = 'Está abierta en una carpeta de trabajo de otra herramienta.';
    if (g.hard) { keepItem(base, id, 'protected', protectedLabel(name), g.hard, sha); continue; }
    const wtId = wt?.managed ? `worktree:${wt.path}` : null;
    // Sigue abierta en una carpeta de trabajo: si esa carpeta está protegida, la rama también; si retirarla es una decisión
    // (cambios sin guardar, commits sueltos) o depende de otra, la rama nunca viene marcada.
    const wtItem = wtId ? items.find(i => i.id === wtId) : null;
    if (wtItem?.category === 'protected') { keepItem(base, id, 'protected', 'En uso', `Sigue abierta en «${wtItem.name}», que está protegida: ${wtItem.reason}`, sha); continue; }
    const wtSafe = !wtItem || wtItem.category === 'safe';
    const wtDirty = !!wtItem && /sin guardar/.test(wtItem.status);
    if (wtItem && !wtSafe && requiresOf(wtItem.requires).length) g.needs.push(wtId!); // carpeta condicionada: la rama también
    const requires = wtId ? [wtId] : [];
    if (u.count === 0) {
      const story = autoDelete(name, sha);
      const auto = story && wtSafe; // una rama larga o recién creada (= main) no se propone borrar sola
      const reason = wtDirty ? `Todo su contenido está en main, pero sigue abierta en «${wtItem!.name}», que tiene cambios sin guardar: decide primero qué hacer con esa carpeta.` : story ? 'Rama de una historia y todo su contenido está en main: borrarla no pierde nada.' : 'Todo su contenido está en main, pero no es una rama de historia (puede ser de larga vida o recién creada): decide tú.';
      items.push(withNeeds(g, { ...base, id, category: auto ? 'safe' : 'decision', status: 'Ya integrada en main', reason, options: [O.keep, O.deleteLocal], defaultOption: auto ? 'delete_local' : 'keep', consequences: 'Desaparece la rama de este equipo; el código sigue en main.', recovery: `Se puede restaurar (git branch -- ${name} ${sha.slice(0, 10)}).`, requires, fingerprint: sha }));
    } else items.push(withNeeds(g, { ...base, id, category: 'decision', status: u.count === null ? 'No se pudo comprobar' : `Contiene ${u.count} cambio(s) que no están en main`, reason: u.count === null ? 'No se pudo comparar con main.' : 'Es trabajo sin integrar: revísalo antes de decidir.', options: u.count === null ? [O.keep] : [O.keep, O.archiveLocal], defaultOption: 'keep', consequences: 'Con «Guardar copia y borrar», la rama deja de verse pero su trabajo queda guardado en este equipo.', recovery: 'Se puede restaurar desde la copia (se indica al ejecutar).', requires, fingerprint: sha }));
  }

  // Ramas del remoto: integradas solo si su contenido está en el main del REMOTO y en el local (así no se pierde en el remoto).
  if (inv.remoteHeads && inv.remote) for (const [name, sha] of inv.remoteHeads) {
    const ps = procsOfBranch.get(name) ?? []; const s = ps.map(storyOf).find(Boolean) ?? null;
    const u = await uniqueOf(inv.cwd, `refs/heads/${inv.main}`, sha);
    const inRemoteMain = await contains(inv.cwd, inv.remoteMainSha, sha);
    const base = { kind: 'remote_branch' as const, name: `${inv.remote}/${name}`, sha: sha.slice(0, 7), unique: u.count, uniqueCommits: u.commits, story: storyRef(s), processId: ps[0]?.id ?? null, portalBranch: isStoryBranch(name) };
    const id = `remote:${name}`;
    const g = branchGuard(name);
    if (!g.hard && inv.pushDiffers) g.hard = `${inv.remote} publica en una dirección distinta de la que se lee (pushurl): no se borra nada en él.`;
    if (g.hard) { keepItem(base, id, 'protected', protectedLabel(name), g.hard, sha); continue; }
    if (u.count === 0 && inRemoteMain) {
      const auto = autoDelete(name, sha);
      items.push(withNeeds(g, { ...base, id, category: auto ? 'safe' : 'decision', status: 'Ya integrada en main', reason: auto ? `Rama de una historia y todo su contenido está en main (también en ${inv.remote}): borrarla no pierde nada.` : 'Todo su contenido está en main, pero no es una rama de historia (puede ser de larga vida): decide tú.', options: [O.keep, O.deleteRemote(inv.remote)], defaultOption: auto ? 'delete_remote' : 'keep', consequences: `Desaparece de ${inv.remote}; el código sigue en main.`, recovery: `Se puede restaurar (git push ${inv.remote} ${sha.slice(0, 10)}:refs/heads/${name}).`, fingerprint: sha }));
    } else if (u.count === 0) items.push({ ...base, id, category: 'decision', status: `Integrada en main, pero main no está publicado en ${inv.remote}`, reason: `Su contenido está en tu main local pero no en el de ${inv.remote}: si la borras ahora, en ${inv.remote} no quedaría. Publica main primero.`, options: [O.keep], defaultOption: 'keep', consequences: 'Se conserva.', recovery: null, fingerprint: sha });
    else items.push(withNeeds(g, { ...base, id, category: 'decision', status: u.count === null ? 'No se pudo comprobar su contenido' : `Contiene ${u.count} cambio(s) que no están en main`, reason: u.count === null ? 'Sus commits no están en este equipo: no se puede saber si están en main.' : 'Es trabajo sin integrar: revísalo antes de decidir.', options: u.count === null ? [O.keep] : [O.keep, O.archiveRemote(inv.remote)], defaultOption: 'keep', consequences: `Con «Guardar copia y borrar», desaparece de ${inv.remote}; su trabajo queda guardado en este equipo.`, recovery: 'Se puede restaurar desde la copia (se indica al ejecutar).', fingerprint: sha }));
  }
  return items;
}

/**
 * Cierre de etapa (decisión del propietario): lo que se puede cerrar o retirar viene ya elegido con su motivo, para una
 * sola autorización. Nunca carpetas con cambios sin guardar (ni lo que dependa de ellas), nunca lo protegido; lo integrado
 * se cierra como hecho (con constancia de lo que faltaba), lo no integrado se cancela y su trabajo se guarda antes de
 * borrar su rama. No autoriza nada: es la propuesta que el propietario revisa y confirma.
 */
const STAGE_PREFERENCE: MaintenanceOptionId[] = ['delete_remote', 'delete_local', 'archive_delete_remote', 'archive_delete_local', 'remove_worktree', 'accept', 'close_done', 'accept_assignment', 'discard', 'cancel_assignment', 'discard_iteration', 'close_batch'];
export function prepareStageClosure(items: MaintenanceItem[], reason: string): MaintenanceSelection[] {
  const chosen = new Map<string, MaintenanceSelection>();
  for (const it of items) {
    if (it.category !== 'safe' && it.category !== 'decision') continue;
    if (it.kind === 'worktree' && /sin guardar/.test(it.status)) continue;
    // Solo ramas del Portal (de historias o de sus procesos): una rama que no creó (gh-pages, develop…) se queda en «Conservar».
    if ((it.kind === 'local_branch' || it.kind === 'remote_branch') && !it.portalBranch) continue;
    const opt = STAGE_PREFERENCE.find(id => it.options.some(o => o.id === id && !(o.id === 'discard' && o.effect === O.discardMerged.effect))); if (!opt) continue; // lo que ya está en main no se «cancela»
    chosen.set(it.id, { itemId: it.id, option: opt, reason: it.options.find(o => o.id === opt)!.needsReason ? reason : null });
  }
  // Lo que depende de algo que no se eligió (p. ej. una carpeta con cambios sin guardar) tampoco: se omitiría al ejecutar.
  for (let again = true; again;) { again = false; for (const it of items) if (chosen.has(it.id) && requiresOf(it.requires).some(r => items.some(i => i.id === r) && !chosen.has(r))) { chosen.delete(it.id); again = true; } }
  return [...chosen.values()];
}

/** Lo que ve el propietario en una revisión: si coincide, revisar otra vez daría lo mismo. */
const signature = (p: Pick<MaintenancePlan, 'repo' | 'items' | 'counts' | 'intent'>) => JSON.stringify([p.repo.path, p.repo.mainSha, p.repo.remoteAvailable, p.counts, p.intent?.reason ?? null,
  p.items.map(i => [i.id, i.category, i.status, i.fingerprint, i.defaultOption, i.options.map(o => `${o.id}${o.needsReason ? '!' : ''}`).join()])]);

/**
 * Revisión de solo lectura → plan persistido (no ejecuta nada ni pide autorización); las anteriores sin ejecutar del proyecto
 * quedan sustituidas. Con `reuseMinutes` (el Asistente), si hay una reciente sin ejecutar que mostraría exactamente lo mismo
 * (main, remoto, cada objetivo) y no es de otra conversación, se reutiliza. Con `from` («Revisar de nuevo»), la tarjeta de la
 * conversación que la propuso pasa a la revisión nueva (si la anterior no llegó a ejecutar nada). `owner`: la pide el
 * propietario con su sesión (la ruta HTTP); sin ella no se sustituye un cierre de etapa pendiente.
 */
export async function createPlan(slug: string, projectId: string, opts: { reuseMinutes?: number; conversationId?: string | null; from?: string | null; closeStage?: { reason: string; source?: 'owner' | 'assistant' } | null; owner?: boolean } = {}): Promise<MaintenancePlan> {
  const project = projectsRepo(slug).list().find(p => p.id === projectId);
  if (!project) throw err(404, 'Proyecto no encontrado en esta empresa.', 'not_found');
  const inv = await inventory(slug, projectId);
  const items = await classify(slug, inv);
  const t = now();
  const draft: MaintenancePlan = {
    id: crypto.randomUUID(), workspace: slug, projectId, projectName: project.name, createdAt: t, updatedAt: t, status: 'proposed',
    repo: { path: inv.cwd, mainBranch: inv.main, mainSha: inv.mainSha, remote: inv.remote, remoteUrl: inv.remoteUrl, remoteAvailable: !!inv.remoteHeads, remoteError: inv.remote ? inv.remoteError : 'El repositorio no tiene remoto configurado.', pushDiffers: inv.pushDiffers },
    counts: { remoteBranches: inv.remoteHeads?.size ?? 0, localBranches: inv.local.size, worktrees: inv.worktrees.length, openStories: inv.stories.filter(s => OPEN_STORY(s.status)).length, openBatches: items.filter(i => i.kind === 'batch').length },
    items, source: null, execution: null, createdBy: opts.owner ? 'owner' : 'assistant'
  };
  // Cierre de etapa: pedido ahora, o heredado de la revisión que se repite («Revisar de nuevo»).
  const fromPlan = opts.from ? load(slug, opts.from) : null;
  const fromIntent = fromPlan && fromPlan.projectId === projectId ? fromPlan.intent ?? null : null;
  const stage = opts.closeStage?.reason?.trim() ? { kind: 'close_stage' as const, reason: opts.closeStage.reason.replace(/\s+/g, ' ').trim().slice(0, 300), source: opts.closeStage.source ?? 'owner' } : fromIntent;
  if (stage) { draft.intent = stage; draft.prepared = prepareStageClosure(items, stage.reason); }
  if (opts.reuseMinutes) {
    const sig = signature(draft);
    // Sin la sesión del propietario solo se reutiliza lo de esta misma conversación (o lo que preparó el Asistente y aún no
    // tiene tarjeta), nunca una revisión que preparó el propietario.
    const recent = listPlans(slug, projectId).find(p => p.status === 'proposed' && Date.now() - Date.parse(p.createdAt) < opts.reuseMinutes! * 60_000
      && (opts.owner || p.createdBy !== 'owner') && (!p.source || (!!opts.conversationId && p.source.conversationId === opts.conversationId)) && signature(p) === sig);
    if (recent) return recent;
  }
  const from = opts.from ? load(slug, opts.from) : null;
  // La tarjeta de la conversación pasa a la revisión nueva; si la anterior ya hizo algo, la nueva lo recuerda (la tarjeta cuenta ambas).
  const carry = from && from.projectId === projectId && from.source && from.status !== 'running' ? from.source : null;
  const prevDone = from ? (from.execution?.outcomes ?? []).filter(o => o.status === 'done').length + (from.continuesFrom?.done ?? 0) : 0;
  if (carry && from && prevDone) draft.continuesFrom = { planId: from.id, done: prevDone };
  const plan = save(slug, draft);
  // La anterior pierde su tarjeta antes de caducar (así la tarjeta no dice «sustituida»: pasa a la nueva).
  if (carry && from) save(slug, { ...from, source: null, ...(from.status === 'proposed' ? { status: 'stale' as const, supersededBy: plan.id } : {}) });
  // Sin la sesión del propietario (el Asistente: cualquiera puede escribirle, y en cualquier conversación) no se sustituye
  // NADA: la revisión nueva queda al lado de las pendientes (la pantalla avisa de que hay varias; al ejecutar una, las
  // demás dejan de valer). Solo el propietario sustituye («Revisar ahora» / «Revisar de nuevo»).
  const mine = carry?.conversationId ?? opts.conversationId ?? null;
  if (opts.owner) for (const r of ensure(slug).prepare(`SELECT id FROM maintenance_plans WHERE project_id = ? AND status = 'proposed' AND id <> ?`).all(projectId, plan.id) as any[]) {
    const old = load(slug, r.id); if (!old) continue;
    if (old.source && old.source.conversationId && old.source.conversationId !== mine) continue; // la tarjeta de otra conversación no se anula por esta
    save(slug, { ...old, status: 'stale', supersededBy: plan.id });
  }
  return carry ? save(slug, { ...plan, source: carry }) : plan;
}

/** Rechazar: solo una revisión que no ha empezado (lo ya ejecutado no se puede «rechazar»). */
export function rejectPlan(slug: string, id: string): MaintenancePlan {
  const p = getPlan(slug, id);
  if (p.status !== 'proposed') throw err(409, p.execution ? 'Esta revisión ya se ejecutó (en todo o en parte): no se puede rechazar.' : `La revisión ya está «${p.status}».`, 'invalid_status');
  return save(slug, { ...p, status: 'rejected' });
}

// ------------------------------------------------------------------------------------------------------------ ejecución
const ORDER: Record<string, number> = { story: 0, assignment: 0, iteration: 1, batch: 2, worktree: 3, local_branch: 4, remote_branch: 5 };

/**
 * Ejecuta SOLO la selección del propietario (autorización explícita). Valida la selección contra el plan, bloquea el
 * plan y el proyecto (una ejecución a la vez) y ejecuta en segundo plano; el resultado se consulta con getPlan.
 * La selección guardada incluye lo que se dejó en «Conservar» (al reanudar no se vuelve a marcar).
 */
export function executePlan(slug: string, id: string, selection: MaintenanceSelection[], authorized: boolean): MaintenancePlan {
  if (authorized !== true) throw err(400, 'Ejecutar exige tu autorización explícita de los objetivos seleccionados.', 'authorization_required');
  const p = getPlan(slug, id);
  if (p.status === 'running') throw err(409, 'Esta revisión ya se está ejecutando.', 'already_running');
  if (p.status !== 'proposed' && p.status !== 'partial') throw err(409, p.status === 'stale' ? 'Esta revisión caducó (el repositorio cambió o hay una más reciente): revisa de nuevo.' : `La revisión ya está «${p.status}».`, 'invalid_status');
  if (busyProjects.has(p.projectId)) throw err(409, 'Ya se está ejecutando otra revisión de este proyecto: espera a que termine.', 'project_busy');
  const done = new Set((p.execution?.outcomes ?? []).filter(o => o.status === 'done' || o.status === 'noop').map(o => o.itemId));
  const full: MaintenanceSelection[] = []; let actions = 0;
  for (const s of selection) {
    if (full.some(x => x.itemId === s.itemId)) continue;
    const it = p.items.find(i => i.id === s.itemId);
    if (!it) throw err(400, `Objetivo desconocido: ${s.itemId}`, 'unknown_item');
    if (s.option === 'keep' || done.has(it.id)) { full.push({ itemId: it.id, option: 'keep', reason: null }); continue; }
    if (it.category === 'protected' || it.category === 'outside') throw err(400, `«${it.name}» está protegido: no se puede seleccionar.`, 'protected_item');
    const opt = it.options.find(o => o.id === s.option);
    if (!opt) throw err(400, `«${it.name}» no admite «${s.option}».`, 'invalid_option');
    const reason = (s.reason ?? '').trim();
    if (opt.needsReason && reason.length < 3) throw err(400, `«${it.name}»: indica el motivo (al menos 3 caracteres).`, 'reason_required');
    full.push({ itemId: it.id, option: opt.id, reason: reason ? reason.slice(0, 300) : null }); actions++;
  }
  if (!actions) throw err(400, 'No hay ningún objetivo seleccionado con una acción.', 'empty_selection');
  for (const it of p.items) if ((it.category === 'safe' || it.category === 'decision') && !full.some(x => x.itemId === it.id)) full.push({ itemId: it.id, option: 'keep', reason: null });
  const prev = p.execution;
  const doc: MaintenancePlan = { ...p, status: 'running', updatedAt: now(),
    history: prev ? [...(p.history ?? []), { ...prev }] : p.history,
    execution: { startedAt: now(), finishedAt: null, selection: full, outcomes: (prev?.outcomes ?? []).filter(o => o.status === 'done' || o.status === 'noop'), verification: [], interrupted: false, runner: BOOT } };
  // Bloqueo atómico de estado Y documento en una sola sentencia: una ejecución por plan (doble clic, dos pestañas, otro proceso).
  const r = ensure(slug).prepare(`UPDATE maintenance_plans SET status = 'running', doc_json = ?, updated_at = ? WHERE id = ? AND status IN ('proposed', 'partial')`).run(JSON.stringify(doc), doc.updatedAt, id);
  if (Number(r.changes) !== 1) throw err(409, 'Esta revisión ya se está ejecutando.', 'already_running');
  runningPlans.set(id, { slug, title: `Revisión de «${p.projectName}»` }); busyProjects.add(p.projectId);
  notify(doc);
  // Al ejecutar una, las demás revisiones pendientes del proyecto (p. ej. de otra conversación) dejan de valer.
  for (const r of ensure(slug).prepare(`SELECT id FROM maintenance_plans WHERE project_id = ? AND status = 'proposed' AND id <> ?`).all(p.projectId, id) as any[]) {
    const old = load(slug, r.id); if (old) save(slug, { ...old, status: 'stale', supersededBy: id });
  }
  void runPlan(slug, doc).catch(e => {
    const cur = load(slug, id)!; save(slug, { ...cur, status: 'partial', execution: { ...cur.execution!, finishedAt: now(), verification: [...(cur.execution?.verification ?? []), `Error inesperado: ${e.message}`] } });
  }).finally(() => { runningPlans.delete(id); busyProjects.delete(p.projectId); const fin = load(slug, id); if (fin) notify(fin); });
  return doc;
}

/** ¿El objetivo ya está como se quería? (para reanudar tras una interrupción sin repetir ni dar por falso lo hecho). */
function reached(slug: string, it: MaintenanceItem, option: string): boolean {
  if (it.id.startsWith('batchitem:')) { const [, bId, sId] = it.id.split(':'); return batchesRepo(slug).get(bId)?.items.find(i => i.itemId === sId)?.state === 'accepted'; }
  if (it.kind === 'assignment') { const st = assignmentsRepo(slug).get(it.id.slice('assignment:'.length))?.status; return option === 'cancel_assignment' ? st === 'cancelled' : st === 'accepted'; }
  if (it.kind === 'iteration') return !!processesRepo(slug).get(it.id.slice('iteration:'.length))?.result?.rejected;
  if (it.kind === 'story') { const st = backlogRepo(slug).get(it.story!.id)?.status; return option === 'discard' ? st === 'discarded' : st === 'done'; }
  if (it.kind === 'batch') { const b = batchesRepo(slug).get(it.batchId!); return !!b && !OPEN_BATCH(b); }
  return false;
}

async function runPlan(slug: string, plan: MaintenancePlan): Promise<void> {
  const ex = plan.execution!; const projectId = plan.projectId;
  const record = (o: Omit<MaintenanceOutcome, 'at'>, target: string) => {
    const cur = load(slug, plan.id)!; cur.execution!.outcomes = [...cur.execution!.outcomes.filter(x => x.itemId !== o.itemId), { ...o, at: now() }]; save(slug, cur);
    if (o.status !== 'started') try { processesRepo(slug).logExecution({ projectId, agentId: '', kind: `maintenance:${o.option}:${o.status}:${target.slice(0, 120)}`, status: o.status === 'failed' ? 'failed' : 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: now() } as any); } catch { /* auditoría best-effort */ }
  };
  const previousStarted = new Set((plan.history ?? []).flatMap(h => h.outcomes).filter(o => o.status === 'started').map(o => o.itemId));
  const todo = ex.selection.filter(s => s.option !== 'keep' && !ex.outcomes.some(o => o.itemId === s.itemId && (o.status === 'done' || o.status === 'noop')));
  // Estado real JUSTO ANTES de ejecutar: si main o el repositorio cambiaron, el plan caduca entero; si un objetivo cambió, ese no se toca.
  let inv = await inventory(slug, projectId);
  // También el remoto: con otra dirección (o un pushurl distinto) las mismas ramas serían de OTRO repositorio.
  const remoteMoved = inv.remote !== plan.repo.remote || inv.remoteUrl !== plan.repo.remoteUrl || inv.pushDiffers !== !!plan.repo.pushDiffers;
  if (inv.mainSha !== plan.repo.mainSha || inv.cwd !== plan.repo.path || remoteMoved) {
    for (const s of todo) record({ itemId: s.itemId, option: s.option, status: 'skipped', message: inv.cwd !== plan.repo.path ? 'No se ejecutó: el proyecto apunta ahora a otro repositorio. Revisa de nuevo.' : remoteMoved && inv.mainSha === plan.repo.mainSha ? `No se ejecutó: el remoto cambió desde la revisión (${plan.repo.remote ?? '—'} ${plan.repo.remoteUrl ?? ''} → ${inv.remote ?? '—'} ${inv.remoteUrl ?? ''}${inv.pushDiffers ? ', con otra dirección de publicación' : ''}). Revisa de nuevo.` : `No se ejecutó: main cambió desde la revisión (${plan.repo.mainSha?.slice(0, 7)} → ${inv.mainSha?.slice(0, 7)}). Revisa de nuevo.` }, s.itemId);
    const cur = load(slug, plan.id)!; save(slug, { ...cur, status: 'stale', execution: { ...cur.execution!, finishedAt: now() } });
    return;
  }
  let fresh = await classify(slug, inv);
  const doneHere = new Set<string>();
  /** Hecho en ejecuciones anteriores de este mismo plan (al reanudar tras una interrupción o un fallo). */
  const priorDone = new Set(ex.outcomes.filter(o => o.status === 'done' || o.status === 'noop').map(o => o.itemId));
  const sameFingerprint = (planned: MaintenanceItem, cur: MaintenanceItem) => {
    if (planned.kind !== 'batch') return planned.fingerprint === cur.fingerprint;
    // Un lote cambia por las acciones de esta misma revisión sobre sus historias: esas se descuentan.
    const acted = new Set([...doneHere, ...priorDone].filter(x => x.startsWith('story:') || x.startsWith('batchitem:')).map(x => x.split(':').pop()!));
    const strip = (f: string) => { const [st, list = ''] = f.split('|'); return `${st}|${list.split(',').filter(x => x && !acted.has(x.split('=')[0])).join(',')}`; };
    return strip(planned.fingerprint) === strip(cur.fingerprint);
  };
  const ordered = [...todo].sort((a, b) => (ORDER[plan.items.find(i => i.id === a.itemId)!.kind] ?? 9) - (ORDER[plan.items.find(i => i.id === b.itemId)!.kind] ?? 9));
  let lastKind = '';
  for (const s of ordered) {
    const planned = plan.items.find(i => i.id === s.itemId)!;
    // Antes de cada tipo de objetivo se revisa de nuevo (lo hecho antes, o un remoto que no responde, cambia el estado).
    if (planned.kind !== lastKind && lastKind) { inv = await inventory(slug, projectId); fresh = await classify(slug, inv); }
    lastKind = planned.kind;
    const cur = fresh.find(i => i.id === s.itemId);
    try {
      // Hecho antes de una interrupción (quedó «en curso» sin resultado): si ya está como se quería, cuenta como hecho.
      if (previousStarted.has(s.itemId) && reached(slug, planned, s.option)) { record({ itemId: s.itemId, option: s.option, status: 'noop', message: 'Al reanudar ya estaba como se quería (comprobado; pudo hacerse antes de la interrupción o desde otra pantalla).' }, planned.name); doneHere.add(s.itemId); continue; }
      if (planned.kind === 'remote_branch' && !inv.remoteHeads) { record({ itemId: s.itemId, option: s.option, status: 'failed', message: `No se pudo comprobar el remoto ahora: ${inv.remoteError ?? 'no respondió'}` }, planned.name); continue; }
      if (!cur) {
        // Ya no existe: para una rama o una carpeta es el estado buscado (nada que hacer); para lo demás, no se toca.
        if (planned.kind === 'remote_branch' || planned.kind === 'local_branch' || planned.kind === 'worktree') { record({ itemId: s.itemId, option: s.option, status: 'noop', message: 'Ya no existía: nada que hacer.' }, planned.name); doneHere.add(s.itemId); }
        else { const ok = reached(slug, planned, s.option); record({ itemId: s.itemId, option: s.option, status: ok ? 'noop' : 'skipped', message: ok ? 'Ya estaba así: nada que hacer.' : 'Ya no está abierta: no se tocó.' }, planned.name); if (ok) doneHere.add(s.itemId); }
        continue;
      }
      if (!sameFingerprint(planned, cur)) { record({ itemId: s.itemId, option: s.option, status: 'skipped', message: 'Cambió desde la revisión (otro commit, otro estado o un proceso nuevo): no se tocó. Revisa de nuevo.' }, planned.name); continue; }
      const missing = [...new Set([...requiresOf(planned.requires), ...requiresOf(cur.requires)])].filter(r => !doneHere.has(r) && fresh.some(i => i.id === r));
      if (missing.length) { record({ itemId: s.itemId, option: s.option, status: 'skipped', message: missing.every(r => r.startsWith('worktree:')) ? 'Sigue abierta en su carpeta de trabajo: elige también «Retirar la carpeta de trabajo».' : `Depende de algo que no se hizo en esta revisión: ${missing.map(r => plan.items.find(i => i.id === r)?.name ?? fresh.find(i => i.id === r)?.name ?? r).join(' · ')}.` }, planned.name); continue; }
      if (cur.category === 'protected' || cur.category === 'outside') { record({ itemId: s.itemId, option: s.option, status: 'skipped', message: `Ahora está protegido: ${cur.reason}` }, planned.name); continue; }
      if (planned.kind === 'batch') {
        const mine = ordered.filter(x => x.itemId !== s.itemId && plan.items.find(i => i.id === x.itemId)?.batchId === planned.batchId).map(x => x.itemId);
        const bad = mine.filter(id => !doneHere.has(id));
        if (bad.length) { record({ itemId: s.itemId, option: s.option, status: 'skipped', message: `No se cerró: no se completó lo elegido para sus historias (${bad.map(id => plan.items.find(i => i.id === id)?.story?.storyId || id).join(', ')}). Revísalo y reanuda.` }, planned.name); continue; }
      }
      if (!cur.options.some(o => o.id === s.option)) { record({ itemId: s.itemId, option: s.option, status: 'skipped', message: 'La acción elegida ya no es válida para su estado actual.' }, planned.name); continue; }
      record({ itemId: s.itemId, option: s.option, status: 'started', message: 'En curso…' }, planned.name);
      const res = await act(slug, plan, inv, cur, s);
      record({ itemId: s.itemId, option: s.option, status: res.noop ? 'noop' : 'done', message: res.message, recovery: res.recovery ?? null, archiveRef: res.archiveRef ?? null }, planned.name); doneHere.add(s.itemId);
    } catch (e: any) {
      // Mensajes propios del Portal tal cual; la salida en bruto de git (rutas, URLs) se resume: el resultado llega al chat y al modelo.
      const raw = String(e?.message ?? '');
      const gitish = /^git /.test(raw) || /fatal:|error:|warning:|hint:|usage:/i.test(raw);
      if (!e?.statusCode || e.statusCode === 500) console.error(`[mantenimiento ${plan.id.slice(0, 8)}] ${s.itemId}: ${raw}`);
      record({ itemId: s.itemId, option: s.option, status: 'failed', message: e?.statusCode && e.statusCode !== 500 && !gitish ? raw : gitish ? 'git rechazó la operación.' : 'Error interno inesperado (el detalle queda en el registro del servidor).' }, planned.name);
    }
  }
  // Verificación independiente: se vuelve a mirar el remoto, las ramas, las copias, las carpetas y el backlog.
  const after = await inventory(slug, projectId);
  const last = load(slug, plan.id)!; let outs = last.execution!.outcomes;
  // Un borrado en el remoto que dio error pudo completarse igual (tiempo agotado): si la rama ya no está, cuenta como hecho.
  if (after.remoteHeads) outs = outs.map(o => o.status === 'failed' && o.itemId.startsWith('remote:') && !after.remoteHeads!.has(o.itemId.slice('remote:'.length)) && o.option !== 'archive_delete_remote' ? { ...o, status: 'done', message: `${o.message} — al verificar, la rama ya no está en el remoto.` } : o);
  const STATUS_ES: Record<string, string> = { done: 'completada', discarded: 'descartada', pending: 'pendiente', review: 'en revisión', in_progress: 'en curso', blocked: 'bloqueada', paused: 'en pausa', running: 'en marcha', completed: 'completado', cancelled: 'cancelado', revoked: 'revocado' };
  const verification: string[] = [];
  for (const o of outs.filter(x => x.status === 'done')) {
    const it = plan.items.find(i => i.id === o.itemId)!;
    if (it.kind === 'remote_branch') { const name = it.id.slice('remote:'.length); verification.push(after.remoteHeads ? (after.remoteHeads.has(name) ? `✗ ${it.name} sigue en el remoto` : `✓ ${it.name} ya no está en el remoto`) : `✗ ${it.name}: el remoto no respondió al verificar (sin comprobar)`); }
    if (it.kind === 'local_branch') { const name = it.id.slice('local:'.length); verification.push(after.local.has(name) ? `✗ ${name} sigue en este equipo` : `✓ ${name} ya no está en este equipo`); }
    if ((o.option === 'archive_delete_local' || o.option === 'archive_delete_remote') && o.archiveRef) verification.push(await gitOk(after.cwd, ['rev-parse', '--verify', '--quiet', o.archiveRef]) ? `✓ copia guardada: ${o.archiveRef}` : `✗ falta la copia ${o.archiveRef}`);
    if (it.kind === 'worktree') verification.push(after.worktrees.some(w => w.path === it.worktree) ? `✗ ${it.name} sigue registrada` : `✓ ${it.name}: retirada`);
    if (it.id.startsWith('batchitem:')) { const [, bId, sId] = it.id.split(':'); const st = batchesRepo(slug).get(bId)?.items.find(i => i.itemId === sId)?.state; verification.push(`${st === 'accepted' ? '✓' : '✗'} ${it.story?.storyId}: ${st === 'accepted' ? 'aceptada en su lote' : `en su lote, ${st ?? '?'}`}`); }
    else if (it.kind === 'story') { const st = backlogRepo(slug).get(it.story!.id)?.status ?? '?'; const want = o.option === 'discard' ? 'discarded' : 'done'; verification.push(`${st === want ? '✓' : '✗'} ${it.story?.storyId}: ${STATUS_ES[st] ?? st}`); }
    if (it.kind === 'assignment') { const a = assignmentsRepo(slug).get(it.id.slice('assignment:'.length)); const want = o.option === 'cancel_assignment' ? 'cancelled' : 'accepted'; verification.push(`${a?.status === want ? '✓' : '✗'} ${a?.code ?? it.name}: ${a ? ASSIGNMENT_STATUS_LABEL[a.status] : '?'}`); }
    if (it.kind === 'iteration') { const q = processesRepo(slug).get(it.id.slice('iteration:'.length)); verification.push(`${q?.result?.rejected ? '✓' : '✗'} ${it.name}: ${q?.result?.rejected ? 'descartada' : 'sigue pendiente'}`); }
    if (it.kind === 'batch') { const b = batchesRepo(slug).get(it.batchId!); verification.push(`${b && !OPEN_BATCH(b) ? '✓' : '✗'} lote «${it.name}»: ${STATUS_ES[b?.status ?? ''] ?? b?.status ?? '?'}`); }
  }
  const bad = verification.filter(v => v.startsWith('✗'));
  const failed = outs.some(o => o.status === 'failed' || o.status === 'skipped' || o.status === 'started') || bad.length > 0;
  save(slug, { ...last, status: failed ? 'partial' : 'done', execution: { ...last.execution!, outcomes: outs, finishedAt: now(), verification } });
}

/**
 * Al cerrar una historia (hecha, aceptada o cancelada) no queda nada suyo esperando en Decisiones: sus iteraciones que
 * esperaban autorización se deniegan (como «Denegar») y, si se cancela, las que dejaron cambios sin integrar se descartan.
 */
function settleStoryProcesses(slug: string, projectId: string, storyId: string, reason: string, discarded: boolean) {
  for (const q of processesRepo(slug).list(projectId)) {
    if (q.backlogItemId !== storyId) continue;
    if (q.status === 'pending_authorization') {
      processesRepo(slug).finish(q.id, 'cancelled', `Denegada al ${discarded ? 'cancelar' : 'cerrar'} la historia en la revisión del proyecto: ${reason}`);
      threadRepo(slug).add({ backlogItemId: storyId, role: 'system', agentId: null, agentName: null, content: `Su iteración que esperaba autorización se denegó al ${discarded ? 'cancelar' : 'cerrar'} la historia en la revisión del proyecto (sin consumir IA). Motivo: ${reason}`, processId: q.id, costUsd: 0, tokens: 0, proposals: null } as any);
      continue;
    }
    if (discarded && q.result && !q.result.merged && !q.result.rejected && (q.result.applied || (q.result.changes ?? []).length)) processesRepo(slug).setResult(q.id, { ...q.result, rejected: { at: now(), reason: `Historia cancelada: ${reason}` } });
  }
}

/** Una operación del catálogo, con su política (auditoría) y el servicio existente del Portal. */
async function act(slug: string, plan: MaintenancePlan, inv: Inventory, it: MaintenanceItem, s: MaintenanceSelection): Promise<{ message: string; recovery?: string | null; noop?: boolean; archiveRef?: string | null }> {
  const projectId = plan.projectId; const cwd = inv.cwd; const reason = s.reason ?? '';
  const tag = `revisión ${plan.id.slice(0, 8)}`;
  // Copia con nombre ÚNICO por revisión y origen, creada solo si no existe (nunca sobrescribe otra copia).
  const archive = async (where: 'local' | 'remote', name: string, sha: string) => {
    const ref = `${ARCHIVE}/${plan.id.slice(0, 8)}/${where}/${name}`;
    const existing = await git(cwd, ['rev-parse', '--verify', '--quiet', ref]).catch(() => '');
    if (existing && existing !== sha) throw err(409, `Ya existe otra copia en ${ref}: no se sobrescribe.`);
    if (!existing) await git(cwd, ['update-ref', ref, sha, ZERO]);
    return ref;
  };
  switch (s.option) {
    case 'delete_remote': case 'archive_delete_remote': {
      const name = it.id.slice('remote:'.length); const remote = inv.remote!; const sha = inv.remoteHeads?.get(name);
      if (!sha || sha !== it.fingerprint) throw err(409, 'La rama cambió en el remoto: no se tocó.');
      if (s.option === 'delete_remote' && !await contains(cwd, inv.remoteMainSha, sha)) throw err(409, `Su contenido ya no está en el main de ${remote}: no se borró.`);
      requirePolicy('git_remote_branch_delete', { slug, projectId, authorized: true });
      let recovery = `Se puede restaurar (git push ${remote} ${sha}:refs/heads/${name}).`; let ref: string | null = null;
      if (s.option === 'archive_delete_remote') {
        ref = await withRepoLock(cwd, () => archive('remote', name, sha));
        recovery = `Copia guardada en este equipo: ${ref} (${sha.slice(0, 10)}). Se puede restaurar (git push ${remote} ${ref}:refs/heads/${name}).`;
      }
      // Lease: el remoto solo borra si la rama SIGUE en el commit revisado (si alguien publicó en ella, se rechaza). No fuerza nada.
      try { await gitT(cwd, ['push', `--force-with-lease=refs/heads/${name}:${sha}`, remote, '--delete', `refs/heads/${name}`], 60_000); }
      catch (e: any) { const why = explainRemoteError(e.message); if (/ya no existía/.test(why)) return { message: why, recovery, noop: true, archiveRef: ref }; throw err(502, why); }
      return { message: `Borrada de ${remote}${s.option === 'delete_remote' ? ' (su contenido ya estaba en main)' : ' (copia guardada antes en este equipo)'}.`, recovery, archiveRef: ref };
    }
    case 'delete_local': case 'archive_delete_local': {
      const name = it.id.slice('local:'.length);
      requirePolicy('git_branch_delete', { slug, projectId, authorized: true });
      return withRepoLock(cwd, async () => {
        // Dentro del cerrojo: mismo commit, ninguna carpeta de trabajo la usa, y (si se borra sin copia) está en main.
        const sha = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).catch(() => '');
        if (!sha) return { message: 'Ya no existía.', noop: true };
        if (sha !== it.fingerprint) throw err(409, 'La rama cambió: no se tocó.');
        if ((await worktreeList(cwd)).some(w => w.branch === name)) throw err(409, 'Está abierta en una carpeta de trabajo: no se tocó.');
        let recovery = `Se puede restaurar (git branch -- ${name} ${sha.slice(0, 10)}).`; let ref: string | null = null;
        if (s.option === 'delete_local') { if (!await contains(cwd, `refs/heads/${inv.main}`, sha)) throw err(409, 'Su contenido ya no está en main: no se borró.'); }
        else { ref = await archive('local', name, sha); recovery = `Copia guardada en este equipo: ${ref}. Se puede restaurar (git branch -- ${name} ${ref}).`; }
        // git branch -D tras NUESTRAS comprobaciones (main o copia): git mantiene sus propias protecciones (en uso, rebase).
        await git(cwd, ['branch', '-D', '--', name]);
        return { message: s.option === 'delete_local' ? 'Borrada (su contenido ya estaba en main).' : 'Copia guardada y rama retirada.', recovery, archiveRef: ref };
      });
    }
    case 'remove_worktree': {
      const wt = inv.worktrees.find(w => w.path === it.worktree);
      if (!wt?.managed || !wt.processId) throw err(409, 'No es una carpeta de trabajo del Portal.');
      if (wt.locked) throw err(409, 'Está bloqueada: no se retira.');
      requirePolicy('delete_worktree', { slug, processId: wt.processId, projectId, authorized: true });
      return withRepoLock(cwd, async () => {
        const planned = Number(/Tiene (\d+) archivo\(s\) sin guardar/.exec(it.status)?.[1] ?? 0); // >0 solo si elegiste retirarla sabiendo que se pierde
        // Dentro del cerrojo: sigue sin bloquear y con lo mismo sin guardar que viste (si cambió, no se toca).
        const again = (await worktreeList(cwd)).find(w => w.path === wt.path);
        if (!again || again.locked) throw err(409, 'Cambió desde la revisión (bloqueada o ya no registrada): no se tocó.');
        const now_ = await git(wt.path, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']).then(o => o.split('\n').filter(Boolean).length).catch(() => -1);
        if (now_ !== planned) throw err(409, now_ < 0 ? 'No se pudo leer su estado ahora: no se tocó.' : `Ahora tiene ${now_} archivo(s) sin guardar (al revisar: ${planned}): no se tocó. Revisa de nuevo.`);
        // Por su ruta exacta; sin --force, git se niega si hay algo sin guardar. Nada se borra a mano y no se «poda» ninguna otra carpeta.
        try { await git(cwd, ['worktree', 'remove', ...(planned > 0 ? ['--force'] : []), '--', wt.path]); }
        catch { throw err(409, 'git no la retiró (puede tener cambios o estar en uso): no se tocó.'); }
        return { message: 'Carpeta retirada; su rama se conserva.', recovery: 'Su rama conserva el contenido.' };
      });
    }
    case 'accept': {
      requirePolicy('backlog_maintenance', { slug, projectId, authorized: true });
      const p = it.processId ? processesRepo(slug).get(it.processId) : undefined;
      if (!p?.result?.merged || !await contains(cwd, `refs/heads/${inv.main}`, p.result.merged.commit)) throw err(409, 'Su commit no está en main: no se acepta como hecha.');
      const blocker = await closingBlocker(slug, p, 'historia');
      if (blocker && reason.length < 3) throw err(409, `Ya no cumple la regla de cierre (${blocker.error}): revisa de nuevo y, si quieres aceptarla igual, indica tu motivo.`);
      await acceptItems(slug, it.batchId!, [it.story!.id], `Aceptada en la revisión del proyecto (${tag})${blocker ? `. Faltaba: ${blocker.error} Motivo del propietario: ${reason}` : reason ? `: ${reason}` : '.'}`);
      settleStoryProcesses(slug, projectId, it.story!.id, reason, false);
      return { message: 'Aceptada en su lote: completada.' };
    }
    case 'close_done': {
      requirePolicy('backlog_maintenance', { slug, projectId, authorized: true });
      const p = it.processId ? processesRepo(slug).get(it.processId) : undefined;
      if (!p?.result?.merged || !await contains(cwd, `refs/heads/${inv.main}`, p.result.merged.commit)) throw err(409, 'Su commit no está en main: no se puede cerrar como hecha (sería falso).');
      const blocker = await closingBlocker(slug, p, 'historia');
      if (blocker && reason.length < 3) throw err(400, 'Falta el motivo para cerrarla sin cumplir toda la regla de cierre.');
      backlogRepo(slug).setStatus(it.story!.id, 'done', p.id);
      settleStoryProcesses(slug, projectId, it.story!.id, reason, false);
      threadRepo(slug).add({ backlogItemId: it.story!.id, role: 'system', agentId: null, agentName: null, content: `Cerrada como hecha en la revisión del proyecto (${tag}). Integrada en main (${p.result.merged.commit.slice(0, 7)}).${blocker ? ` Faltaba: ${blocker.error} Motivo del propietario: ${reason}` : ''}`, processId: p.id, costUsd: 0, tokens: 0, proposals: null } as any);
      return { message: blocker ? 'Completada con tu motivo (constancia de lo que faltaba).' : 'Completada (cumple la regla de cierre).' };
    }
    case 'discard': {
      requirePolicy('backlog_maintenance', { slug, projectId, authorized: true });
      if (it.batchId) cancelItem(slug, it.batchId, it.story!.id, { tick: batchesRepo(slug).get(it.batchId)?.status === 'running' });
      discardStory(slug, it.story!.id, `${reason} (${tag})`, { allowUnmergedBranch: true });
      settleStoryProcesses(slug, projectId, it.story!.id, `${reason} (${tag})`, true);
      return { message: 'Cancelada: queda en «Descartadas» con tu motivo.' };
    }
    case 'close_batch': {
      requirePolicy('backlog_maintenance', { slug, projectId, authorized: true });
      const b = await closeBatch(slug, it.batchId!, `${reason} (${tag})`);
      return { message: `Lote cerrado (${b.status === 'completed' ? 'completado' : 'cancelado'}).` };
    }
    case 'discard_iteration': {
      requirePolicy('backlog_maintenance', { slug, projectId, authorized: true });
      const pid = it.id.slice('iteration:'.length); const q = processesRepo(slug).get(pid);
      if (!q?.result?.applied) throw err(404, 'La iteración ya no existe.');
      if (q.projectId !== projectId) throw err(409, 'La iteración es de otro proyecto: no se toca.');
      if (q.result.rejected) return { message: 'Ya estaba descartada.', noop: true };
      if (q.result.merged) throw err(409, 'Se integró mientras tanto: no se descarta.');
      processesRepo(slug).setResult(pid, { ...q.result, rejected: { at: now(), reason: `${reason} (${tag})` } });
      if (q.backlogItemId) threadRepo(slug).add({ backlogItemId: q.backlogItemId, role: 'system', agentId: null, agentName: null, content: `Iteración descartada en la revisión del proyecto (${tag}): ${reason}. No se integrará; su carpeta y su rama dejan de estar reservadas.`, processId: pid, costUsd: 0, tokens: 0, proposals: null } as any);
      return { message: 'Iteración descartada: no se integrará.' };
    }
    case 'accept_assignment': {
      requirePolicy('backlog_maintenance', { slug, projectId, authorized: true });
      const q = it.processId ? processesRepo(slug).get(it.processId) : undefined;
      if (!q?.result?.merged || !await contains(cwd, `refs/heads/${inv.main}`, q.result.merged.commit)) throw err(409, 'Su trabajo no está en main: no se acepta como hecho.');
      const blocker = await closingBlocker(slug, q, 'encargo');
      if (blocker && reason.length < 3) throw err(409, `Ya no cumple la regla de cierre (${blocker.error}): indica tu motivo.`);
      await acceptAssignment(slug, it.id.slice('assignment:'.length), `Aceptado en la revisión del proyecto (${tag})${blocker ? `. Faltaba: ${blocker.error} Motivo del propietario: ${reason}` : reason ? `: ${reason}` : '.'}`, { ownerReason: blocker ? reason : null });
      return { message: blocker ? 'Aceptado con tu motivo (constancia de lo que faltaba).' : 'Aceptado.' };
    }
    case 'cancel_assignment': {
      requirePolicy('backlog_maintenance', { slug, projectId, authorized: true });
      cancelAssignment(slug, it.id.slice('assignment:'.length), `${reason} (${tag})`);
      const ap = it.processId ? processesRepo(slug).get(it.processId) : undefined;
      if (ap?.result && !ap.result.merged && !ap.result.rejected && (ap.result.applied || (ap.result.changes ?? []).length)) processesRepo(slug).setResult(ap.id, { ...ap.result, rejected: { at: now(), reason: `Encargo cancelado: ${reason}` } });
      return { message: 'Encargo cancelado (queda en el historial).' };
    }
    default: throw err(400, 'Acción no admitida.');
  }
}

/** Planes en ejecución (para que «Reconstruir y reiniciar» no los interrumpa sin avisar). */
export const runningMaintenance = () => [...runningPlans.entries()].map(([id, v]) => ({ slug: v.slug, id, title: v.title }));

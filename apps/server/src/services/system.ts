import fs from 'node:fs';
import { runningPlans } from './maintenanceRuns.ts';
import { workspacesRepo } from '../db/platform.ts';
import { withRepoLock } from './repoLock.ts';
import { changed } from './live.ts';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ActivationState, SystemStatus } from '@portal-ia/domain';
import { REPO_ROOT } from '../config.ts';
import { git } from './repoWrite.ts';
import { buildOutcome, RESTART_EXIT_CODE, shutdown } from './lifecycle.ts';
import { detectSandbox } from './sandbox.ts';
import { INTERNAL_WORKSPACE } from '@portal-ia/domain';
import { processesRepo, projectsRepo } from '../db/workspace.ts';
import { recordDetections } from './lessons.ts';
import { config } from '../config.ts';
import type { FastifyInstance } from 'fastify';

let appRef: FastifyInstance | null = null;
/** La aplicación en marcha, para poder apagarla limpiamente al reiniciar (HU-144). */
export function attachApp(app: FastifyInstance) { appRef = app; }

export const VERSION = '0.12.1';
const startedAt = new Date().toISOString();
const startedMs = Date.now();

/** Resultado de detectar el repositorio git del Portal. `isGit: false` con `error: null` = rev-parse confirma que no hay repositorio. */
export interface RepoInfo { isGit: boolean; top: string | null; head: string | null; error: string | null }
/** Sonda del repositorio; `before` (ISO) pide el commit que había en HEAD en ese momento (arranque), si la detección llega tarde. */
export type RepoProbe = (root: string, before: string | null) => Promise<RepoInfo>;

/** Traduce un fallo de git a su causa real (nunca «no es un repositorio» si la causa es otra). */
function gitCause(e: any): { notRepo: boolean; message: string } {
  const m = String(e?.stderr || e?.message || e || '').trim();
  if (e?.code === 'ENOENT' || /ENOENT|not recognized|no se reconoce|command not found|spawn git/i.test(m)) return { notRepo: false, message: 'git no está en el PATH del servidor: no se encontró el ejecutable «git».' };
  if (/dubious ownership|safe\.directory/i.test(m)) return { notRepo: false, message: `git considera la carpeta ${REPO_ROOT} de otro propietario (dubious ownership). Si confías en ella, ejecuta tú: git config --global --add safe.directory "${REPO_ROOT.replace(/\\/g, '/')}"` };
  if (/not a git repository/i.test(m)) return { notRepo: true, message: 'El Portal no corre desde un repositorio git.' };
  return { notRepo: false, message: `git falló al leer el repositorio del Portal: ${m.slice(0, 300) || 'error desconocido'}` };
}

/** Sonda real: «git rev-parse --show-toplevel» (vale también si .git es un archivo, como en un worktree) y el commit de arranque. */
export const gitRepoProbe: RepoProbe = async (root, before) => {
  let top: string;
  try { top = String(await git(root, ['rev-parse', '--show-toplevel'])).trim(); }
  catch (e) { const c = gitCause(e); return { isGit: false, top: null, head: null, error: c.notRepo ? null : c.message }; }
  let head: string | null = null;
  if (before) {
    const full = String(await git(root, ['rev-list', '-1', `--before=${before}`, 'HEAD']).catch(() => '')).trim();
    if (full) head = String(await git(root, ['rev-parse', '--short', full]).catch(() => '')).trim() || null;
  }
  if (!head) head = String(await git(root, ['rev-parse', '--short', 'HEAD']).catch(() => '')).trim() || null;
  return { isGit: true, top, head, error: head ? null : 'El repositorio del Portal no tiene ningún commit todavía.' };
};

let probe: RepoProbe = gitRepoProbe;
let retryMs = 30_000;
let generation = 0;
let cached: { info: RepoInfo; at: number } | null = null;
let inflight: Promise<RepoInfo> | null = null;
let startCommit: string | null = null;

/** Detección perezosa con caché: un éxito se conserva; un fallo se reintenta pasados unos 30 s. */
export function ensureRepo(): Promise<RepoInfo> {
  if (cached && ((cached.info.isGit && cached.info.head) || Date.now() - cached.at < retryMs)) return Promise.resolve(cached.info);
  if (inflight) return inflight;
  const g = generation;
  const late = Date.now() - startedMs > 15_000;
  const p = probe(REPO_ROOT, late ? startedAt : null)
    .catch((e): RepoInfo => { const c = gitCause(e); return { isGit: false, top: null, head: null, error: c.notRepo ? null : c.message }; })
    .then(info => {
      if (g === generation) {
        cached = { info, at: Date.now() }; inflight = null;
        if (info.isGit && info.head && !startCommit) startCommit = info.head;
      }
      return info;
    });
  inflight = p;
  return p;
}
/** Commit con que arrancó el servidor (espera a la detección; null si no hay git o falló). */
export async function ensureStartCommit(): Promise<string | null> { await ensureRepo(); return startCommit; }
/** Solo pruebas: sustituye la sonda (null = la real) y reinicia la caché; `retryMs` acorta la espera de reintento. */
export function __setRepoProbeForTests(fn: RepoProbe | null, opts: { retryMs?: number } = {}) {
  probe = fn ?? gitRepoProbe; retryMs = opts.retryMs ?? 30_000;
  generation++; cached = null; inflight = null; startCommit = null;
}
// Al arrancar se lanza ya la detección para fijar el commit de arranque; quien lo necesite la espera.
void ensureRepo();

let update: NonNullable<SystemStatus['update']> | null = null;
/** Última reconstrucción del Portal (para explicar una activación fallida en el recorrido de la historia). */
export const lastUpdate = () => update;

/** Clasifica el impacto de los archivos cambiados: nada / recargar navegador / reconstruir y reiniciar. */
export function classifyImpact(files: string[]): SystemStatus['action'] {
  let action: SystemStatus['action'] = 'none';
  for (const f0 of files) {
    const f = f0.replace(/\\/g, '/');
    if (/^docs\//.test(f) || /(^|\/)test\//.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f) || /\.md$/i.test(f)) continue;
    if (/^apps\/web\/(src|public)\//.test(f) || f === 'apps/web/index.html') { if (action === 'none') action = 'reload'; continue; }
    return 'restart'; // servidor, paquetes compartidos, package.json, tsconfig, .env, configuración de Vite…
  }
  return action;
}

/**
 * Información del build servido, leída de <webDist>/build-info.json con el formato { commit, builtAt, version }.
 * HU-163: el archivo lo genera cualquier `vite build` (`npm run build` o `npm run build --workspace apps/web`) mediante
 * el plugin local de apps/web/vite.config.ts, que lo escribe en el outDir de ese build. En un build sin git, commit
 * queda en null y el build no falla. startUpdate («Reconstruir y reiniciar») lo vuelve a escribir en dist.next con
 * el mismo formato, así que el resultado es el mismo por los dos caminos.
 * Si falta el archivo (builds anteriores a este cambio), se usa la fecha de modificación de index.html y buildCommit es null.
 */
export function buildInfo(): { buildCommit: string | null; buildAt: string | null } {
  try { const j = JSON.parse(fs.readFileSync(path.join(config.webDist, 'build-info.json'), 'utf8')); return { buildCommit: j.commit ?? null, buildAt: j.builtAt ?? null }; } catch { /* sin build-info */ }
  try { const st = fs.statSync(path.join(config.webDist, 'index.html')); return { buildCommit: null, buildAt: st.mtime.toISOString() }; } catch { return { buildCommit: null, buildAt: null }; }
}

const ancestorCache = new Map<string, { v: boolean; t: number }>();
/** ¿`commit` está contenido en `inCommit`? (git merge-base --is-ancestor), con caché corta. */
export async function isAncestor(commit: string, inCommit: string): Promise<boolean> {
  const k = `${commit}>${inCommit}`; const c = ancestorCache.get(k); if (c && Date.now() - c.t < 10_000) return c.v;
  const v = await git(REPO_ROOT, ['merge-base', '--is-ancestor', commit, inCommit]).then(() => true).catch(() => false);
  ancestorCache.set(k, { v, t: Date.now() }); return v;
}

/**
 * Estado de activación de un merge (M2): activo solo si el proceso en marcha arrancó con un commit que lo contiene Y la
 * web servida se construyó con un commit que también lo contiene. Un merge, un build o un reinicio por separado no bastan.
 */
export async function activationOf(mergeCommit: string, mergedAt: string): Promise<ActivationState> {
  const b = buildInfo();
  const info = await ensureRepo();
  if (!info.isGit || !startCommit) return { active: false, runningCommit: startCommit, buildCommit: b.buildCommit, buildAt: b.buildAt, reason: info.error ?? 'El Portal no corre desde un repositorio git.' };
  const inRunning = await isAncestor(mergeCommit, startCommit);
  if (!inRunning) return { active: false, runningCommit: startCommit, buildCommit: b.buildCommit, buildAt: b.buildAt, reason: `El servidor en marcha arrancó con ${startCommit}, que no contiene este merge: reconstruye y reinicia.` };
  const webOk = b.buildCommit ? await isAncestor(mergeCommit, b.buildCommit) : !!b.buildAt && new Date(b.buildAt).getTime() >= new Date(mergedAt).getTime();
  if (!webOk) return { active: false, runningCommit: startCommit, buildCommit: b.buildCommit, buildAt: b.buildAt, reason: 'El servidor ya corre el código nuevo, pero la interfaz servida se construyó antes del merge: reconstruye.' };
  return { active: true, runningCommit: startCommit, buildCommit: b.buildCommit, buildAt: b.buildAt, reason: 'El servidor y la interfaz en marcha contienen este cambio.' };
}

export async function systemStatus(): Promise<SystemStatus> {
  const b = buildInfo(); const sb = await detectSandbox().catch(() => null);
  const isGit = (await ensureRepo()).isGit;
  const base: SystemStatus = { version: VERSION, startedAt, repoRoot: REPO_ROOT, isGit, startCommit, headCommit: null, branch: null, changedFiles: [], action: 'none', stories: [], update, buildCommit: b.buildCommit, buildAt: b.buildAt, sandbox: sb ? { available: sb.available, detail: sb.detail } : null, running: runningEverywhere() };
  if (!isGit) return base;
  const headCommit = await git(REPO_ROOT, ['rev-parse', '--short', 'HEAD']).catch(() => null);
  const branch = await git(REPO_ROOT, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => null) || null;
  const files = new Set<string>(); const stories = new Set<string>();
  if (startCommit && headCommit && startCommit !== headCommit) {
    (await git(REPO_ROOT, ['diff', '--name-only', `${startCommit}..HEAD`]).catch(() => '')).split('\n').filter(Boolean).forEach(f => files.add(f));
    (await git(REPO_ROOT, ['log', '--format=%s', `${startCommit}..HEAD`]).catch(() => '')).match(/(?:HU|EN)-\d+/gi)?.forEach(h => stories.add(h.toUpperCase()));
  }
  // La interfaz servida se construyó con un commit concreto: si HEAD cambió archivos de la web después, hay que reconstruir aunque el servidor ya corra HEAD.
  if (b.buildCommit && headCommit && b.buildCommit !== headCommit) {
    (await git(REPO_ROOT, ['diff', '--name-only', `${b.buildCommit}..HEAD`, '--', 'apps/web', 'packages']).catch(() => '')).split('\n').filter(Boolean).forEach(f => files.add(f));
  }
  const changedFiles = Array.from(files);
  return { ...base, headCommit, branch, changedFiles, action: classifyImpact(changedFiles), stories: Array.from(stories) };
}

function run(cmd: string, args: string[], onLine: (l: string) => void, timeoutMs = 15 * 60_000): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, shell: process.platform === 'win32' });
    // Un comando colgado no deja el Portal «reconstruyéndose» para siempre (ni bloquea el carril del repositorio).
    const timer = setTimeout(() => { onLine(`\n✖ ${cmd} ${args[0]} superó ${Math.round(timeoutMs / 60_000)} min: se detiene.\n`); try { child.kill(); } catch { /* ya terminó */ } }, timeoutMs);
    child.stdout.on('data', d => onLine(String(d))); child.stderr.on('data', d => onLine(String(d)));
    child.on('close', code => { clearTimeout(timer); resolve(code ?? 1); }); child.on('error', e => { clearTimeout(timer); onLine(String(e.message)); resolve(1); });
  });
}

/**
 * Reconstruye el Portal (npm install si cambiaron dependencias + npm run build) y, si se pide, reinicia el servidor
 * relanzando este mismo proceso. Requiere autorización explícita (herramienta «Ejecución»).
 */
export async function startUpdate(opts: { install: boolean; restart: boolean; interruptRunning?: boolean }, log: (o: any, m: string) => void) {
  if (update?.status === 'running') throw Object.assign(new Error('Ya hay una actualización en curso.'), { statusCode: 409 });
  const outcome = opts.restart ? buildOutcome() : null;
  update = { status: 'running', log: '', startedAt: new Date().toISOString(), finishedAt: null, outcome };
  changed({ ws: null, entity: 'system', id: null });
  const append = (l: string) => { if (update) update.log = (update.log + l).slice(-20_000); };
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  void (async () => {
    try {
      if (opts.install) { append('> npm install\n'); const c = await run(npm, ['install', '--no-audit', '--no-fund'], append); if (c !== 0) throw new Error(`npm install terminó con código ${c}`); }
      // Solo el build de la interfaz va por el carril del repositorio (con tope de tiempo): ninguna integración en main
      // cambia los archivos a mitad, y el commit anotado es el que se construyó.
      const commit = await withRepoLock(REPO_ROOT, async () => {
      const commit = await git(REPO_ROOT, ['rev-parse', '--short', 'HEAD']).catch(() => null);
      // Construir aparte (dist.next) y sustituir solo si el build termina: si falla, la interfaz anterior sigue sirviéndose.
      const dist = config.webDist; const next = `${dist}.next`; const prev = `${dist}.prev`;
      fs.rmSync(next, { recursive: true, force: true });
      append('\n> npm run build --workspace apps/web -- --outDir dist.next\n');
      const b = await run(npm, ['run', 'build', '--workspace', 'apps/web', '--', '--outDir', 'dist.next', '--emptyOutDir'], append, 10 * 60_000);
      if (b !== 0 || !fs.existsSync(path.join(next, 'index.html'))) throw new Error(`npm run build terminó con código ${b}: la interfaz anterior se mantiene.`);
      fs.writeFileSync(path.join(next, 'build-info.json'), JSON.stringify({ commit, builtAt: new Date().toISOString(), version: VERSION }));
      fs.rmSync(prev, { recursive: true, force: true });
      if (fs.existsSync(dist)) fs.renameSync(dist, prev);
      fs.renameSync(next, dist);
      return commit;
      });
      append(`✓ interfaz reconstruida (commit ${commit ?? '?'}); la anterior queda en dist.prev\n`);
      // Antes de reiniciar se vuelve a mirar: si mientras se construía empezó algo (no debería: no se empieza trabajo nuevo
      // durante la reconstrucción), no se interrumpe sin tu confirmación; queda reconstruido y pendiente de reiniciar.
      const running = runningEverywhere();
      if (opts.restart && running.length && !opts.interruptRunning) {
        append(`\n⚠ No se reinicia: hay ${running.length} proceso(s) en ejecución (${running.slice(0, 3).map(r => r.title).join(', ')}). Reinicia cuando terminen.\n`);
        update = { ...update!, status: 'done', finishedAt: new Date().toISOString(), restartSkipped: `Hay ${running.length} proceso(s) en ejecución: no se reinició para no interrumpirlos.` };
        changed({ ws: null, entity: 'system', id: null });
        log({ running: running.length }, 'actualización completada sin reiniciar (procesos en marcha)');
        return;
      }
      update = { ...update!, status: 'done', finishedAt: new Date().toISOString() };
      changed({ ws: null, entity: 'system', id: null });
      log({ restart: opts.restart }, 'actualización completada');
      if (opts.restart) setTimeout(() => {
        // Con supervisor (npm start → scripts/portal-start.mjs): apagado limpio con código 75 y relanzamiento automático.
        // Sin supervisor: apagado limpio; la interfaz ya mostró los comandos para arrancar a mano.
        if (appRef) void shutdown(appRef, 'actualización del Portal', outcome?.mode === 'restarting' ? RESTART_EXIT_CODE : 0);
        else restartSelf();
      }, 800);
    } catch (e: any) {
      append(`\n✖ ${e.message}\n`); update = { ...update!, status: 'failed', finishedAt: new Date().toISOString() }; changed({ ws: null, entity: 'system', id: null }); log({ err: e.message }, 'actualización fallida');
      // M4: la activación fallida es un error objetivo de la última historia integrada y no activada.
      try { recordActivationFailure(update.log); } catch { /* sin lección */ }
    }
  })();
  return update;
}

/** ¿Se está reconstruyendo el Portal ahora (para reiniciarse al terminar)? Mientras tanto no empieza trabajo nuevo. */
export const updateRunning = () => update?.status === 'running';

/** Procesos en ejecución en todos los espacios: reconstruir y reiniciar los interrumpiría (quedan en pausa, se retoman a mano). */
export function runningEverywhere(): { slug: string; id: string; title: string }[] {
  const out: { slug: string; id: string; title: string }[] = [];
  for (const ws of workspacesRepo.list()) { try { for (const p of processesRepo(ws.slug).running()) out.push({ slug: ws.slug, id: p.id, title: p.title }); } catch { /* espacio sin base */ } }
  for (const [id, v] of runningPlans) out.push({ slug: v.slug, id, title: v.title });
  return out;
}

/** Registra una lección «activación fallida» en la última historia del Portal integrada y aún no activa. */
function recordActivationFailure(logText: string) {
  const slug = INTERNAL_WORKSPACE.slug;
  const procs = processesRepo(slug);
  const projects = projectsRepo(slug).list();
  for (const p of projects) {
    const last = procs.list(p.id).find(x => x.kind === 'story_execution' && x.result?.merged);
    if (last) { recordDetections(slug, last.id, REPO_ROOT, { updateFailedLog: logText }); procs.logExecution({ projectId: p.id, agentId: '', kind: 'activation:failed', status: 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: new Date().toISOString() }); return; }
  }
}

/** Relanza este mismo proceso (mismo node, mismos argumentos, misma terminal) y termina el actual. */
export function restartSelf() {
  const child = spawn(process.execPath, process.execArgv.concat(process.argv.slice(1)), { cwd: process.cwd(), env: process.env, detached: true, stdio: 'inherit' });
  child.unref();
  setTimeout(() => process.exit(0), 300);
}

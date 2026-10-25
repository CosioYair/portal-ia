import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { SystemStatus } from '@portal-ia/domain';
import { REPO_ROOT } from '../config.ts';
import { git } from './repoWrite.ts';
import { buildOutcome, RESTART_EXIT_CODE, shutdown } from './lifecycle.ts';
import type { FastifyInstance } from 'fastify';

let appRef: FastifyInstance | null = null;
/** La aplicación en marcha, para poder apagarla limpiamente al reiniciar (HU-144). */
export function attachApp(app: FastifyInstance) { appRef = app; }

export const VERSION = '0.11.2';
const startedAt = new Date().toISOString();
let startCommit: string | null = null;
const isGit = fs.existsSync(path.join(REPO_ROOT, '.git'));
if (isGit) git(REPO_ROOT, ['rev-parse', '--short', 'HEAD']).then(c => { startCommit = c; }).catch(() => { startCommit = null; });

let update: NonNullable<SystemStatus['update']> | null = null;

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

export async function systemStatus(): Promise<SystemStatus> {
  const base: SystemStatus = { version: VERSION, startedAt, repoRoot: REPO_ROOT, isGit, startCommit, headCommit: null, branch: null, changedFiles: [], action: 'none', stories: [], update };
  if (!isGit) return base;
  const headCommit = await git(REPO_ROOT, ['rev-parse', '--short', 'HEAD']).catch(() => null);
  const branch = await git(REPO_ROOT, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => null) || null;
  const files = new Set<string>(); const stories = new Set<string>();
  if (startCommit && headCommit && startCommit !== headCommit) {
    (await git(REPO_ROOT, ['diff', '--name-only', `${startCommit}..HEAD`]).catch(() => '')).split('\n').filter(Boolean).forEach(f => files.add(f));
    (await git(REPO_ROOT, ['log', '--format=%s', `${startCommit}..HEAD`]).catch(() => '')).match(/HU-\d+/gi)?.forEach(h => stories.add(h.toUpperCase()));
  }
  // El build se sirve desde disco: los cambios del navegador se ven al recargar tras reconstruir; una web ya reconstruida no cuenta.
  const changedFiles = Array.from(files);
  return { ...base, headCommit, branch, changedFiles, action: classifyImpact(changedFiles), stories: Array.from(stories) };
}

function run(cmd: string, args: string[], onLine: (l: string) => void): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, shell: process.platform === 'win32' });
    child.stdout.on('data', d => onLine(String(d))); child.stderr.on('data', d => onLine(String(d)));
    child.on('close', code => resolve(code ?? 1)); child.on('error', e => { onLine(String(e.message)); resolve(1); });
  });
}

/**
 * Reconstruye el Portal (npm install si cambiaron dependencias + npm run build) y, si se pide, reinicia el servidor
 * relanzando este mismo proceso. Requiere autorización explícita (herramienta «Ejecución»).
 */
export async function startUpdate(opts: { install: boolean; restart: boolean }, log: (o: any, m: string) => void) {
  if (update?.status === 'running') throw Object.assign(new Error('Ya hay una actualización en curso.'), { statusCode: 409 });
  const outcome = opts.restart ? buildOutcome() : null;
  update = { status: 'running', log: '', startedAt: new Date().toISOString(), finishedAt: null, outcome };
  const append = (l: string) => { if (update) update.log = (update.log + l).slice(-20_000); };
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  (async () => {
    try {
      if (opts.install) { append('> npm install\n'); const c = await run(npm, ['install', '--no-audit', '--no-fund'], append); if (c !== 0) throw new Error(`npm install terminó con código ${c}`); }
      append('\n> npm run build\n'); const b = await run(npm, ['run', 'build'], append); if (b !== 0) throw new Error(`npm run build terminó con código ${b}`);
      update = { ...update!, status: 'done', finishedAt: new Date().toISOString() };
      log({ restart: opts.restart }, 'actualización completada');
      if (opts.restart) setTimeout(() => {
        // Con supervisor (npm start → scripts/portal-start.mjs): apagado limpio con código 75 y relanzamiento automático.
        // Sin supervisor: apagado limpio; la interfaz ya mostró los comandos para arrancar a mano.
        if (appRef) void shutdown(appRef, 'actualización del Portal', outcome?.mode === 'restarting' ? RESTART_EXIT_CODE : 0);
        else restartSelf();
      }, 800);
    } catch (e: any) { append(`\n✖ ${e.message}\n`); update = { ...update!, status: 'failed', finishedAt: new Date().toISOString() }; log({ err: e.message }, 'actualización fallida'); }
  })();
  return update;
}

/** Relanza este mismo proceso (mismo node, mismos argumentos, misma terminal) y termina el actual. */
export function restartSelf() {
  const child = spawn(process.execPath, process.execArgv.concat(process.argv.slice(1)), { cwd: process.cwd(), env: process.env, detached: true, stdio: 'inherit' });
  child.unref();
  setTimeout(() => process.exit(0), 300);
}

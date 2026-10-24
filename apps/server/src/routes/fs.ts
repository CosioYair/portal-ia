import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { FsEntry, FsListing } from '@portal-ia/domain';
import { REPO_ROOT } from '../config.ts';

/**
 * Exploración de carpetas locales para el selector de carpetas (FolderPicker).
 * Regla general del producto: una ruta local nunca se escribe a mano; se elige aquí.
 * Solo se listan directorios (nunca contenido de archivos). Es una aplicación local del propio usuario, así que puede
 * recorrer todo el equipo (unidades en Windows, / en Unix). PORTAL_FS_RESTRICT=home limita al directorio del usuario.
 */
const HOME = os.homedir();
const RESTRICT_HOME = process.env.PORTAL_FS_RESTRICT === 'home';
const extraRoots = (process.env.PORTAL_FS_ROOTS ?? '').split(';').map(s => s.trim()).filter(Boolean).map(p => path.resolve(p));
const ROOTS = [HOME, ...extraRoots];

/** Raíces navegables: inicio del usuario, carpeta de esta instalación y unidades (Windows) o / (Unix). */
export function listRoots(): FsEntry[] {
  const roots: FsEntry[] = [{ name: 'Inicio (~)', path: '~', ...gitInfo(HOME), subdirs: 0 }, { name: 'Esta instalación de Portal IA', path: displayPath(REPO_ROOT), ...gitInfo(REPO_ROOT), subdirs: 0 }];
  if (process.platform === 'win32') {
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') { const d = `${l}:\\`; try { if (fs.existsSync(d)) roots.push({ name: `Unidad ${l}:`, path: d, isGit: false, branch: null, subdirs: 0 }); } catch { /* ignorar */ } }
  } else roots.push({ name: 'Raíz del sistema (/)', path: '/', isGit: false, branch: null, subdirs: 0 });
  return roots;
}

export function expandHome(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}
export function displayPath(abs: string): string {
  const rel = path.relative(HOME, abs);
  if (abs === HOME) return '~';
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return '~/' + rel.split(path.sep).join('/');
  return abs;
}
export function isAllowed(abs: string): boolean {
  if (!RESTRICT_HOME) return true;
  return ROOTS.some(root => abs === root || abs.startsWith(root + path.sep));
}
export function gitInfo(dir: string): { isGit: boolean; branch: string | null } {
  const head = path.join(dir, '.git', 'HEAD');
  try {
    const txt = fs.readFileSync(head, 'utf8').trim();
    const m = txt.match(/^ref: refs\/heads\/(.+)$/);
    return { isGit: true, branch: m ? m[1] : txt.slice(0, 7) };
  } catch { return { isGit: false, branch: null }; }
}

export function listDirs(requested: string): FsListing {
  const abs = path.resolve(expandHome(requested || '~'));
  if (!isAllowed(abs)) throw Object.assign(new Error('Ruta fuera de las carpetas permitidas'), { statusCode: 403 });
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { throw Object.assign(new Error('La carpeta no existe o no es accesible'), { statusCode: 404 }); }
  if (!st.isDirectory()) throw Object.assign(new Error('No es una carpeta'), { statusCode: 400 });
  const entries: FsEntry[] = [];
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
    const full = path.join(abs, d.name);
    let subdirs = 0;
    try { subdirs = fs.readdirSync(full, { withFileTypes: true }).filter(x => x.isDirectory() && !x.name.startsWith('.')).length; } catch { /* sin permiso */ }
    const g = gitInfo(full);
    entries.push({ name: d.name, path: displayPath(full), isGit: g.isGit, branch: g.branch, subdirs });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  const parentAbs = path.dirname(abs);
  const g = gitInfo(abs);
  return { path: displayPath(abs), parent: parentAbs !== abs && isAllowed(parentAbs) ? displayPath(parentAbs) : null, entries, isGit: g.isGit, branch: g.branch };
}

export async function fsRoutes(app: FastifyInstance) {
  app.get('/api/fs/roots', async () => listRoots());
  app.get('/api/fs/dirs', async (req, reply) => {
    const q = z.object({ path: z.string().max(1024).optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Ruta no válida' });
    try { return listDirs(q.data.path ?? '~'); }
    catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
}

import './gitSafety.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');

// Carga .env de la raíz si existe (sin dependencias externas).
const envFile = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/**
 * HU-205 · Edición del Portal. «studio» (por defecto) conserva la automejora: reconstruir, reiniciar y activar su propio
 * código. «distributable» la desactiva sin bifurcar el código. Solo el valor «distributable» (sin distinguir mayúsculas)
 * activa la edición distribuible; cualquier otro valor, o su ausencia, da «studio».
 */
export type PortalEdition = 'studio' | 'distributable';
export function resolvePortalEdition(v: string | undefined): PortalEdition {
  return (v ?? '').trim().toLowerCase() === 'distributable' ? 'distributable' : 'studio';
}
export const PORTAL_EDITION: PortalEdition = resolvePortalEdition(process.env.PORTAL_EDITION);
/** ¿Puede el Portal reconstruirse, reiniciarse y activar cambios sobre su propio código? Solo en la edición Estudio. */
export const SELF_IMPROVEMENT_ENABLED = PORTAL_EDITION === 'studio';
export const EDITION_DISABLED_REASON = 'Esta es la edición distribuible del Portal: no se reconstruye, no se reinicia ni activa cambios sobre sí misma. La automejora solo existe en la edición Estudio (PORTAL_EDITION=studio).';
/** Error 403 de la edición distribuible, con code «edition_distributable». */
export function editionError(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(EDITION_DISABLED_REASON), { statusCode: 403, code: 'edition_distributable' });
}

function resolveDataDir(v: string | undefined): string {
  const raw = v && v.trim() ? v.trim() : './data';
  return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
}

/** Rama principal configurada. Valida el nombre (sin espacios, sin «..», sin guion inicial) y cae a «main» si no es válido. */
function resolveMainBranch(v: string | undefined): string {
  const raw = v && v.trim() ? v.trim() : 'main';
  const ok = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw) && !raw.includes('..') && !raw.endsWith('/') && !raw.endsWith('.lock');
  return ok ? raw : 'main';
}

/**
 * Directorio de worktrees por proceso (HU-011). Por defecto es un hermano del repositorio
 * (`<repo>-worktrees`), nunca dentro de él, para no ensuciar `git status`.
 */
function resolveWorktreesDir(v: string | undefined): string {
  const raw = v && v.trim() ? v.trim() : '';
  if (!raw) return path.join(path.dirname(REPO_ROOT), `${path.basename(REPO_ROOT)}-worktrees`);
  return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
}

export const config = {
  port: Number(process.env.PORTAL_PORT ?? 4310),
  /** Edición del Portal (HU-205): «studio» con automejora o «distributable» sin ella. */
  edition: PORTAL_EDITION,
  host: process.env.PORTAL_HOST ?? '127.0.0.1',
  dataDir: resolveDataDir(process.env.PORTAL_DATA_DIR),
  /** Rama destino de toda integración (HU-143). Nunca se deduce de la rama activa. */
  mainBranch: resolveMainBranch(process.env.PORTAL_MAIN_BRANCH),
  /** Carpeta donde se crea el worktree aislado de cada proceso (HU-011). Se crea bajo demanda. */
  worktreesDir: resolveWorktreesDir(process.env.PORTAL_WORKTREES_DIR),
  webDist: path.join(REPO_ROOT, 'apps/web/dist')
};

fs.mkdirSync(path.join(config.dataDir, 'workspaces'), { recursive: true });

/** Versión del esquema de datos: cada cambio de versión hace una copia de `data/` antes de abrir las bases (migraciones solo aditivas). */
export const DATA_SCHEMA_VERSION = '0.19';
export function backupDataBeforeMigration(): string | null {
  try {
    const marker = path.join(config.dataDir, '.schema-version');
    const current = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
    if (current === DATA_SCHEMA_VERSION) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(config.dataDir, 'backups', `${stamp}_antes-de-${DATA_SCHEMA_VERSION}`);
    fs.mkdirSync(dest, { recursive: true });
    const copy = (src: string, rel = '') => {
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        if (e.name === 'backups' || e.name === 'evidence') continue;
        const from = path.join(src, e.name); const to = path.join(dest, rel, e.name);
        if (e.isDirectory()) { fs.mkdirSync(to, { recursive: true }); copy(from, path.join(rel, e.name)); }
        else if (/\.(sqlite|sqlite-wal|sqlite-shm)$|^\.master\.key$/.test(e.name)) fs.copyFileSync(from, to);
      }
    };
    copy(config.dataDir);
    fs.writeFileSync(marker, DATA_SCHEMA_VERSION);
    return dest;
  } catch { return null; }
}
backupDataBeforeMigration();

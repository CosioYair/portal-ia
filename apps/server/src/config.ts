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

/** Versión del esquema de datos: cada subida de versión hace una copia de `data/` antes de abrir las bases (migraciones solo aditivas). */
export const DATA_SCHEMA_VERSION = '0.19';

/** Limpia un marcador de versión: quita el BOM, los espacios y los saltos de línea. */
export function normalizeSchemaVersion(v: string | null | undefined): string {
  return (v ?? '').replace(/^\uFEFF/, '').trim();
}

/** HU-213 · Compara versiones de esquema por números, segmento a segmento ('0.19' > '0.9'). Un segmento no numérico cuenta como 0. */
export function compareSchemaVersion(a: string, b: string): -1 | 0 | 1 {
  const parts = (v: string) => normalizeSchemaVersion(v).split('.').map(s => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : 0));
  const pa = parts(a); const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0; const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Versión registrada en `<dataDir>/.schema-version` ('' si no existe o no se puede leer). */
export function readSchemaMarker(dataDir: string): string {
  const marker = path.join(dataDir, '.schema-version');
  try { return fs.existsSync(marker) ? normalizeSchemaVersion(fs.readFileSync(marker, 'utf8')) : ''; } catch { return ''; }
}

export type SchemaState = 'igual' | 'migrar' | 'mas-nuevo';
export interface SchemaGuard { state: SchemaState; data: string; program: string; reason: string | null }

/** HU-213 · Comprobación pura del esquema (no escribe nada). «mas-nuevo» = los datos son de un programa más reciente: se bloquea. */
export function schemaGuard(dataDir: string, program: string = DATA_SCHEMA_VERSION): SchemaGuard {
  const data = readSchemaMarker(dataDir);
  if (!data) return { state: 'migrar', data: '', program, reason: null };
  const c = compareSchemaVersion(data, program);
  if (c === 0) return { state: 'igual', data, program, reason: null };
  if (c < 0) return { state: 'migrar', data, program, reason: null };
  return {
    state: 'mas-nuevo', data, program,
    reason: `Los datos tienen el esquema ${data}, más nuevo que este programa (${program}). Instala una Edición igual o más reciente o restaura una copia de ${path.join(dataDir, 'backups')}.`
  };
}

/**
 * Copia las bases de `dataDir` en `backups/<fecha>_antes-de-<versión>` y, solo si la copia termina bien, escribe el marcador
 * de forma atómica (archivo temporal + rename). Si la copia falla, borra la copia a medias, no toca el marcador y lanza el error.
 */
export function backupDataDir(dataDir: string, version: string, writeMarker = true): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dataDir, 'backups', `${stamp}_antes-de-${version}`);
  try {
    fs.mkdirSync(dest, { recursive: true });
    const copy = (src: string, rel = '') => {
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        if (e.name === 'backups' || e.name === 'evidence') continue;
        const from = path.join(src, e.name); const to = path.join(dest, rel, e.name);
        if (e.isDirectory()) { fs.mkdirSync(to, { recursive: true }); copy(from, path.join(rel, e.name)); }
        else if (/\.(sqlite|sqlite-wal|sqlite-shm)$|^\.master\.key$/.test(e.name)) fs.copyFileSync(from, to);
      }
    };
    copy(dataDir);
  } catch (e: any) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* copia a medias */ }
    throw Object.assign(new Error(`No se pudo copiar ${dataDir} antes de pasar al esquema ${version}: ${e?.message ?? e}. No se ha cambiado nada.`), { code: 'backup_failed' });
  }
  if (writeMarker) {
    const marker = path.join(dataDir, '.schema-version'); const tmp = `${marker}.tmp`;
    fs.writeFileSync(tmp, version);
    fs.renameSync(tmp, marker);
  }
  return dest;
}

/** Copia previa solo al SUBIR de versión. Si los datos son más nuevos lanza el motivo sin escribir nada (code «schema_newer»). */
export function backupDataBeforeMigration(dataDir: string = config.dataDir, program: string = DATA_SCHEMA_VERSION): string | null {
  const g = schemaGuard(dataDir, program);
  if (g.state === 'mas-nuevo') throw Object.assign(new Error(g.reason ?? 'Los datos son de un esquema más nuevo que este programa.'), { code: 'schema_newer' });
  if (g.state === 'igual') return null;
  return backupDataDir(dataDir, program);
}

try { backupDataBeforeMigration(); }
catch (e: any) {
  console.error(`[portal-ia] No se puede arrancar: ${e?.message ?? e}`);
  process.exit(1);
}
fs.mkdirSync(path.join(config.dataDir, 'workspaces'), { recursive: true });

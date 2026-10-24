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

export const config = {
  port: Number(process.env.PORTAL_PORT ?? 4310),
  host: process.env.PORTAL_HOST ?? '127.0.0.1',
  dataDir: resolveDataDir(process.env.PORTAL_DATA_DIR),
  /** Rama destino de toda integración (HU-143). Nunca se deduce de la rama activa. */
  mainBranch: resolveMainBranch(process.env.PORTAL_MAIN_BRANCH),
  webDist: path.join(REPO_ROOT, 'apps/web/dist')
};

fs.mkdirSync(path.join(config.dataDir, 'workspaces'), { recursive: true });

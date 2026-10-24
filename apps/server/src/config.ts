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

export const config = {
  port: Number(process.env.PORTAL_PORT ?? 4310),
  host: process.env.PORTAL_HOST ?? '127.0.0.1',
  dataDir: resolveDataDir(process.env.PORTAL_DATA_DIR),
  webDist: path.join(REPO_ROOT, 'apps/web/dist')
};

fs.mkdirSync(path.join(config.dataDir, 'workspaces'), { recursive: true });

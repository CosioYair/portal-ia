import fs from 'node:fs';
import path from 'node:path';

/**
 * HU-206 · Árbol a empaquetar en la edición distribuible: única fuente de verdad. Sin dependencias ni REPO_ROOT: quien
 * lo use pasa la raíz. Toda ruta va relativa y con «/». La guarda HU-206 aplica findSecret a cada archivo de esta lista.
 */

/** Lo que se empaqueta: archivos sueltos y carpetas (recorridas enteras salvo lo excluido). «packages/*» = cada paquete. */
export const PACKAGE_INCLUDE: readonly string[] = [
  'package.json', 'package-lock.json', 'README.md', '.env.example', 'tsconfig.base.json',
  'docs/', 'docker/', 'scripts/',
  'packages/*/src/', 'packages/*/package.json', 'packages/*/tsconfig.json',
  'apps/server/src/', 'apps/server/scripts/', 'apps/server/tools/', 'apps/server/package.json', 'apps/server/tsconfig.json',
  'apps/web/src/', 'apps/web/index.html', 'apps/web/package.json', 'apps/web/tsconfig.json', 'apps/web/vite.config.ts'
];

/** Lo que nunca se empaqueta, con su motivo. */
export const PACKAGE_EXCLUDE: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^apps\/server\/test(\/|$)/, reason: 'las pruebas no se distribuyen' },
  { pattern: /^apps\/web\/dist(\.prev|\.next)?(\/|$)/, reason: 'se generan al construir' },
  { pattern: /(^|\/)node_modules(\/|$)/, reason: 'dependencias: se instalan en destino' },
  { pattern: /^data(\/|$)/, reason: 'datos locales del Portal' },
  { pattern: /(^|\/)\.git(\/|$)/, reason: 'historial de git' },
  { pattern: /(^|\/)\.env(?!\.example$)[^/]*$/, reason: 'configuración local con credenciales (solo se distribuye .env.example)' },
  { pattern: /^scripts\/preview-runner\.mjs$/, reason: 'solo sirve a la vista previa de automejora, desactivada en la edición distribuible' }
];

/** Motivo por el que una ruta relativa queda fuera del paquete, o null si no está excluida. */
export function packageExclusion(rel: string): string | null {
  const r = rel.replace(/\\/g, '/');
  return PACKAGE_EXCLUDE.find(e => e.pattern.test(r))?.reason ?? null;
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|7z|woff2?|ttf|otf|eot|mp[34]|wav|sqlite|db|exe|dll|so|dylib|node|wasm|bin)$/i;
function isText(abs: string): boolean {
  if (BINARY_EXT.test(abs)) return false;
  const fd = fs.openSync(abs, 'r');
  try { const buf = Buffer.alloc(8192); const n = fs.readSync(fd, buf, 0, buf.length, 0); return !buf.subarray(0, n).includes(0); }
  finally { fs.closeSync(fd); }
}

/** Expande «packages/*» a cada carpeta real de packages/. */
function expand(root: string, entry: string): string[] {
  if (!entry.startsWith('packages/*/')) return [entry];
  const dir = path.join(root, 'packages');
  if (!fs.existsSync(dir)) return [];
  const rest = entry.slice('packages/*/'.length);
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => `packages/${e.name}/${rest}`);
}

/** Archivos de texto del árbol a empaquetar bajo `root`: relativos, con «/», ordenados y sin duplicados. */
export function listPackageFiles(root: string): string[] {
  const out = new Set<string>();
  const add = (rel: string) => {
    if (packageExclusion(rel)) return;
    const abs = path.join(root, rel);
    let st: fs.Stats; try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const e of fs.readdirSync(abs)) add(`${rel.replace(/\/$/, '')}/${e}`); return; }
    if (st.isFile() && isText(abs)) out.add(rel.replace(/\/$/, ''));
  };
  for (const entry of PACKAGE_INCLUDE) for (const rel of expand(root, entry)) add(rel.replace(/\/$/, ''));
  return [...out].sort();
}

import fs from 'node:fs';
import path from 'node:path';
import { EDITION_BUNDLE_LIMITS, findSecret, validatePortableBundle } from '@portal-ia/domain';
import { listPackageFiles } from './packageTree.ts';
import { sha256FileAsync, writeZip } from './zipFile.ts';

/**
 * HU-211 · Edición distribuible generada desde el Estudio con un árbol limpio. Sin la raíz global del servidor: quien llama pasa la raíz,
 * el build y la carpeta de datos. Todo se comprueba ANTES de escribir; si algo falla no queda ningún ZIP.
 */

const fail = (msg: string, statusCode = 409) => Object.assign(new Error(msg), { statusCode });

/** Lo necesario para ejecutar la Edición (además del build compilado y del lanzador). */
export const EDITION_INCLUDE: readonly RegExp[] = [
  /^apps\/server\/src\//, /^apps\/web\/src\//, /^apps\/web\/index\.html$/, /^packages\/[^/]+\/src\//,
  /^package\.json$/, /^package-lock\.json$/, /^(?:apps|packages)\/[^/]+\/package\.json$/,
  /^(?:(?:apps|packages)\/[^/]+\/)?tsconfig[^/]*\.json$/, /^README\.md$/, /^\.env\.example$/,
  /^docs\/edicion-distribuible\.md$/, /^scripts\/portal-edition-start\.mjs$/
];

/** Lo que nunca entra en la Edición, con su motivo. */
export const EDITION_FORBIDDEN: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^data(\/|$)/, reason: 'datos locales del Portal' },
  { pattern: /(^|\/)\.git(\/|$)/, reason: 'historial de git' },
  { pattern: /(^|\/)node_modules(\/|$)/, reason: 'dependencias: se instalan con npm ci' },
  { pattern: /(^|\/)\.env(?!\.example$)[^/]*$/, reason: 'configuración local con credenciales' },
  { pattern: /\.sqlite(?:-wal|-shm|-journal)?$/i, reason: 'base de datos' },
  { pattern: /(^|\/)\.?master\.key$/, reason: 'clave maestra' },
  { pattern: /^apps\/server\/test(\/|$)/, reason: 'las pruebas no se distribuyen' },
  { pattern: /^scripts\/preview-runner\.mjs$/, reason: 'vista previa de automejora (solo Estudio)' }
];

export const EDITION_LAUNCHER = 'scripts/portal-edition-start.mjs';

/** Comprobación pura del árbol limpio: recibe la salida de `git status --porcelain`. */
export function assertCleanTree(porcelain: string): void {
  const lines = porcelain.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return;
  const paths = lines.map(l => (l.length > 3 ? l.slice(3) : l).trim());
  const shown = paths.slice(0, 10).join(', ');
  const more = paths.length > 10 ? ` y ${paths.length - 10} más` : '';
  throw fail(`El árbol de trabajo tiene ${paths.length} cambio(s) sin confirmar: ${shown}${more}. Hay que confirmar o descartar los cambios antes de generar la Edición.`);
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|7z|woff2?|ttf|otf|eot|mp[34]|wav|sqlite|db|exe|dll|so|dylib|node|wasm|bin)$/i;
function isText(abs: string): boolean {
  if (BINARY_EXT.test(abs)) return false;
  const buf = fs.readFileSync(abs);
  return !buf.subarray(0, 8192).includes(0);
}

/** Archivos de `dir` (sin seguir enlaces), relativos y con «/». */
function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel))) {
    const r = rel ? `${rel}/${e}` : e;
    const st = fs.lstatSync(path.join(dir, r));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...walk(dir, r));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface EditionZipOptions { root: string; webDist: string; dataDir: string; outFile: string; expectedCommit?: string | null }
export interface EditionZipResult { outFile: string; entries: number; bytes: number; sha256: string }

export async function buildEditionZip(o: EditionZipOptions): Promise<EditionZipResult> {
  if (isInside(o.root, o.outFile) || isInside(o.dataDir, o.outFile)) throw fail('El ZIP de la Edición no puede escribirse dentro del repositorio ni de la carpeta de datos.', 400);
  if (fs.existsSync(o.outFile)) throw fail(`Ya existe ${path.basename(o.outFile)}: no se sobrescribe.`);
  // (1) Código: lista blanca sobre el árbol empaquetable (HU-206).
  const files: { name: string; file: string }[] = listPackageFiles(o.root)
    .filter(rel => EDITION_INCLUDE.some(re => re.test(rel)))
    .map(rel => ({ name: rel, file: path.join(o.root, rel) }));
  // (2) Build compilado.
  if (!fs.existsSync(path.join(o.webDist, 'index.html'))) throw fail('Falta el build compilado (apps/web/dist/index.html): ejecuta npm run build.');
  for (const rel of walk(o.webDist)) files.push({ name: `apps/web/dist/${rel}`, file: path.join(o.webDist, rel) });
  // (3) Lanzador.
  if (!files.some(f => f.name === EDITION_LAUNCHER)) throw fail(`Falta el lanzador ${EDITION_LAUNCHER}.`);
  // (4) Exclusiones.
  for (const f of files) {
    const hit = EDITION_FORBIDDEN.find(x => x.pattern.test(f.name));
    if (hit) throw fail(`${f.name} no puede ir en la Edición (${hit.reason}).`);
  }
  // (5) Secretos: ruta y tipo, nunca el valor.
  const texts: Record<string, string> = {};
  for (const f of files) {
    if (!isText(f.file)) continue;
    const c = fs.readFileSync(f.file, 'utf8');
    const s = findSecret(c);
    if (s) throw fail(`${f.name} contiene lo que parece una ${s}: la Edición no se genera.`);
    texts[f.name] = c;
  }
  // (6) Validación de dominio con el perfil de la Edición.
  const problems = validatePortableBundle(texts, {
    profile: 'edition', limits: EDITION_BUNDLE_LIMITS,
    privatePaths: [{ path: o.root, kind: 'source' }, { path: o.dataDir, kind: 'portal-data' }]
  });
  if (problems.length) {
    const list = problems.slice(0, 10).map(p => `${p.path || '(paquete)'}: ${p.message}`).join(' · ');
    throw fail(`La Edición no pasa la validación (${problems.length} problema(s)): ${list}`);
  }
  // (7) El build debe ser del commit esperado.
  if (o.expectedCommit) {
    let commit = '';
    try { commit = String((JSON.parse(fs.readFileSync(path.join(o.webDist, 'build-info.json'), 'utf8')) as { commit?: unknown }).commit ?? ''); } catch { commit = ''; }
    if (!commit || commit !== o.expectedCommit) throw fail(`El build compilado es del commit «${commit || 'desconocido'}» y HEAD es «${o.expectedCommit}»: ejecuta npm run build antes de generar la Edición.`);
  }
  // (8) Escritura exclusiva (writeZip borra el archivo si falla a medias).
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const res = await writeZip(o.outFile, files);
  return { outFile: o.outFile, entries: res.entries, bytes: res.bytes, sha256: await sha256FileAsync(o.outFile) };
}

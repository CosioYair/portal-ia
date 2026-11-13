import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUNDLE_EXPORT_MARKER, findSecret, isIdentityPath, normalizeText, scrubPortableText, stripBundleNotices, stripZipRoot } from '@portal-ia/domain';
import { agentsRepo } from '../db/workspace.ts';
import { recordAgentEvent } from './agentEvents.ts';
import { bundleIdOf } from './agentZipImport.ts';
import { backupFiles, diffSnapshots, forgetPendingExternal, safePath, safeWrite, scanExternal, snapshotHash, sourcesRepo, type SnapshotFiles } from './externalAgents.ts';
import { listZip, readZipEntry } from './zipFile.ts';

/**
 * Portal IA 3 · VUELTA de un agente externo (p. ej. PDF Word Fiel): importar el paquete que se exportó y se mejoró fuera.
 *
 * Antes no existía: reimportar el paquete de un externo creaba un agente NUEVO sin sus scripts (perdía la capacidad), y
 * la única vía era copiar archivos a mano sobre la carpeta original, donde un cambio hecho en el Portal se pisaba sin aviso.
 *
 * Reglas (iguales para cualquier agente con carpeta propia; nada es específico de PDF):
 *  - Solo entra el paquete de ESTE agente (identificador portable del marcador). Nunca el de otro.
 *  - Solo se tocan archivos de su identidad (instrucciones, contexto, memoria, habilidades y sus scripts). Nunca sus
 *    documentos, entregables ni dependencias. Nada se borra: lo que el paquete no trae se queda como está.
 *  - Lo que NO cambió fuera (su huella es la del marcador) no se toca. Lo que cambió solo fuera se propone adoptar. Lo
 *    que cambió fuera Y en el Portal desde la exportación es un conflicto: decide el propietario archivo a archivo.
 *  - Antes de escribir se guarda una copia en la carpeta de respaldos del agente; si algo falla, todo vuelve atrás.
 *  - El resultado queda como revisión adoptada nueva: «Restaurar» la revisión anterior lo deshace.
 * Sin IA: ninguna acción tiene costo.
 */
const MAX_ZIP = 8 * 1024 * 1024;
const MAX_FILE = 600 * 1024;
const TTL_MS = 30 * 60 * 1000;
/** Archivos que genera el paquete al exportar: describen el paquete, no son la identidad del agente en su carpeta. */
const GENERATED = new Set(['agent.yaml', 'memory/MEMORY.md', 'GUIA.md', 'AUTOMEJORA.md', 'CAMBIOS.md', 'PLANES.json', 'scripts/anotar-cambio.mjs', 'portable.json', BUNDLE_EXPORT_MARKER]);
const ZONES = ['AGENTS.md', 'CLAUDE.md', 'COMO_EMPEZAR.md', 'README.md', 'contexto', 'memoria', 'skills'];
const fail = (message: string, statusCode: number, payload?: Record<string, unknown>) => Object.assign(new Error(message), { statusCode, ...(payload ? { payload } : {}) });
const hashOf = (text: string) => crypto.createHash('sha256').update(normalizeText(text)).digest('hex');
const isScript = (p: string) => /^skills\/[^/]+\/scripts\//.test(p);

export interface PackageChange { path: string; kind: 'adopt' | 'added' | 'conflict'; script: boolean; before: string | null; after: string; portal: string | null }
export interface ExternalPackagePreview {
  token: string; agentId: string; agentName: string; exportedAt: string | null; baseRevision: number | null; currentRevision: number;
  changes: PackageChange[]; unchanged: number; ignored: string[]; notRemoved: string[]; warnings: string[]; canWrite: boolean; upToDate: boolean;
}

const staged = new Map<string, { slug: string; agentId: string; file: string; expires: number }>();
function sweep() { const t = Date.now(); for (const [k, v] of staged) if (v.expires < t) { try { fs.rmSync(v.file, { force: true }); } catch { /* ya no estaba */ } staged.delete(k); } }

/** Lee el paquete con las mismas defensas que cualquier ZIP: límites, sin secretos, solo texto, raíz común retirada. */
function readPackage(file: string): { files: Record<string, string>; marker: { bundle: string | null; n: number | null; exportedAt: string | null; files: Record<string, string> } | null } {
  let listing: ReturnType<typeof listZip>;
  try { listing = listZip(file, { maxEntries: 400, maxEntryBytes: MAX_FILE, maxRatio: 200 }); } catch (e: any) { throw fail(e?.message ?? 'No es un ZIP válido.', e?.statusCode ?? 400); }
  const entries = listing.entries.filter(e => !e.isDir);
  const bad = listing.entries.filter(e => e.problem).map(e => `${e.name}: ${e.problem}`);
  if (bad.length) throw fail(`El paquete no se puede importar: ${bad.slice(0, 4).join(' · ')}`, 400);
  const { paths } = stripZipRoot(entries.map(e => e.name));
  const dec = new TextDecoder('utf-8', { fatal: true });
  const files: Record<string, string> = {}; let marker: ReturnType<typeof readPackage>['marker'] = null;
  entries.forEach((e, i) => {
    const rel = (paths[i] ?? e.name).replace(/\\/g, '/');
    let text: string;
    try { text = dec.decode(readZipEntry(file, e)); } catch { throw fail(`${rel}: no es texto UTF-8. Un paquete de agente solo lleva texto.`, 400); }
    if (rel === BUNDLE_EXPORT_MARKER) {
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        const fh = j.files && typeof j.files === 'object' ? Object.fromEntries(Object.entries(j.files as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v as string))) as Record<string, string> : {};
        marker = { bundle: typeof j.bundle === 'string' ? j.bundle : null, n: typeof j.n === 'number' ? j.n : null, exportedAt: typeof j.exportedAt === 'string' ? j.exportedAt : null, files: fh };
      } catch { marker = null; }
      return;
    }
    const secret = findSecret(text);
    if (secret) throw fail(`${rel} contiene lo que parece una ${secret}: las credenciales nunca entran en la carpeta de un agente.`, 400);
    files[rel] = text;
  });
  return { files, marker };
}

/**
 * Devuelve a un texto limpiado por la exportación (rutas → «[ruta local]»…) las líneas originales que NO se tocaron fuera:
 * así adoptar un archivo editado fuera no introduce en la carpeta del propietario las marcas de limpieza del paquete.
 */
function restoreScrubbedLines(incoming: string, original: string | undefined): string {
  if (original === undefined) return incoming;
  const back = new Map<string, string>();
  for (const line of normalizeText(original).split('\n')) { const s = scrubPortableText(line); if (s !== line && !back.has(s)) back.set(s, line); }
  if (!back.size) return incoming;
  return incoming.split('\n').map(l => back.get(l) ?? l).join('\n');
}

function plan(slug: string, agentId: string, file: string) {
  const a = agentsRepo(slug).get(agentId); if (!a) throw fail('Agente no encontrado', 404);
  const repo = sourcesRepo(slug); const s = repo.get(agentId);
  if (!s) throw fail('Este agente no tiene carpeta propia: su paquete se importa desde «Importar desde ZIP».', 409, { code: 'not_external' });
  const { files, marker } = readPackage(file);
  if (!marker?.bundle) throw fail('Este ZIP no trae el marcador de exportación del Portal: no se puede saber de qué agente es ni qué cambió fuera. Exporta de nuevo el agente y trabaja sobre ese paquete.', 400, { code: 'no_marker' });
  if (marker.bundle !== bundleIdOf(agentId)) throw fail(`Este paquete es de otro agente, no de ${a.config.name}.`, 400, { code: 'other_agent' });
  const scan = scanExternal(s.root);
  if (snapshotHash(scan.files) !== s.adoptedHash) throw fail('La carpeta del agente tiene cambios hechos fuera del Portal sin revisar: adóptalos o deshazlos en «Origen» antes de importar el paquete.', 409, { code: 'unreviewed_changes' });
  const current = scan.files;
  const base: SnapshotFiles = (marker.n ? repo.files(agentId, marker.n) : null) ?? {};
  const changes: PackageChange[] = []; const ignored: string[] = []; const warnings: string[] = []; let unchanged = 0;
  for (const p of Object.keys(files).sort()) {
    if (GENERATED.has(p) || p.startsWith('herramientas/') || !isIdentityPath(p) || !ZONES.some(z => p === z || p.startsWith(`${z}/`))) { if (!GENERATED.has(p) && !p.startsWith('herramientas/')) ignored.push(p); continue; }
    const raw = files[p]!;
    if (marker.files[p] !== undefined && marker.files[p] === hashOf(raw)) { unchanged++; continue; }
    // Cambió fuera (o es nuevo). Los scripts van tal cual; el texto recupera lo que la exportación limpió y no se tocó.
    const script = isScript(p);
    const after = script ? raw : normalizeText(restoreScrubbedLines(p === 'AGENTS.md' ? stripBundleNotices(raw) : normalizeText(raw), base[p] ?? current[p]));
    const cur = p in current ? current[p]! : null;
    if (cur !== null && hashOf(cur) === hashOf(after)) { unchanged++; continue; }
    if (cur === null) { changes.push({ path: p, kind: 'added', script, before: null, after, portal: null }); continue; }
    const portalChanged = marker.n ? (p in base ? hashOf(base[p]!) !== hashOf(cur) : true) : true;
    if (!marker.n) warnings.push(`${p}: el paquete no dice de qué revisión salió; se trata como conflicto para no pisar nada.`);
    changes.push({ path: p, kind: portalChanged ? 'conflict' : 'adopt', script, before: cur, after, portal: portalChanged ? cur : null });
  }
  const notRemoved = Object.keys(marker.files).filter(p => !GENERATED.has(p) && files[p] === undefined && p in current).sort();
  if (changes.some(c => c.script)) warnings.push('El paquete cambia programas del agente. Revísalos: tras importarlos podrán ejecutarse con los permisos que ya tiene.');
  if (changes.some(c => /\[ruta local\]|\[interno\]|\[ruta interna\]/.test(c.after) && !(c.before && /\[ruta local\]|\[interno\]|\[ruta interna\]/.test(c.before)))) warnings.push('Algún texto trae marcas «[ruta local]» o «[interno]» que puso la exportación al limpiar datos privados: revísalo en la comparación.');
  return { a, s, marker, current, changes, unchanged, ignored, notRemoved, warnings, layout: scan.layout };
}

export function previewExternalPackage(slug: string, agentId: string, uploaded: string): ExternalPackagePreview {
  sweep();
  if (fs.statSync(uploaded).size > MAX_ZIP) throw fail('El paquete supera el tamaño máximo (8 MB).', 413);
  const p = plan(slug, agentId, uploaded);
  const token = crypto.randomBytes(16).toString('hex');
  const file = path.join(os.tmpdir(), `portal-ia-extpkg-${token}.zip`);
  fs.copyFileSync(uploaded, file);
  staged.set(token, { slug, agentId, file, expires: Date.now() + TTL_MS });
  return {
    token, agentId, agentName: p.a.config.name, exportedAt: p.marker.exportedAt, baseRevision: p.marker.n, currentRevision: p.s.revision,
    changes: p.changes, unchanged: p.unchanged, ignored: p.ignored, notRemoved: p.notRemoved, warnings: p.warnings,
    canWrite: !!p.s.grants.applyImprovements, upToDate: p.changes.length === 0
  };
}

export interface ExternalPackageResult { revision: number; previousRevision: number; backup: string | null; written: string[]; kept: string[]; upToDate: boolean }

/** Aplica lo elegido. `resolutions[path]`: 'paquete' adopta lo de fuera, 'portal' conserva lo actual. Un conflicto sin elegir detiene todo. */
export function applyExternalPackage(slug: string, agentId: string, input: { token: string; resolutions: Record<string, 'portal' | 'paquete'> }, by = 'owner'): ExternalPackageResult {
  sweep();
  const st = staged.get(input.token);
  if (!st || st.slug !== slug || st.agentId !== agentId) throw fail('La vista previa caducó: vuelve a subir el paquete.', 410);
  const p = plan(slug, agentId, st.file);
  if (!p.s.grants.applyImprovements) throw fail('Importar el paquete escribe en las instrucciones y habilidades del agente: concede antes «aplicar mejoras aprobadas» en su pestaña Origen.', 403, { code: 'grant_required' });
  const unresolved = p.changes.filter(c => c.kind === 'conflict' && !input.resolutions[c.path]);
  if (unresolved.length) throw fail('Hay archivos que cambiaron también en el Portal desde la exportación: elige qué versión conservar en cada uno.', 409, { conflicts: unresolved.map(c => c.path) });
  const take = p.changes.filter(c => c.kind !== 'conflict' ? input.resolutions[c.path] !== 'portal' : input.resolutions[c.path] === 'paquete');
  const kept = p.changes.filter(c => !take.includes(c)).map(c => c.path);
  const previous = p.s.revision;
  if (!take.length) { fs.rmSync(st.file, { force: true }); staged.delete(input.token); return { revision: previous, previousRevision: previous, backup: null, written: [], kept, upToDate: true }; }
  for (const c of take) safePath(p.s.root, c.path, ZONES, { create: true }); // todo se comprueba ANTES de escribir nada
  const backup = backupFiles(p.s.root, p.layout, p.current, take.map(c => c.path), 'importar-paquete');
  const done: string[] = [];
  try {
    for (const c of take) { safeWrite(p.s.root, c.path, c.after, ZONES); done.push(c.path); }
  } catch (e: any) {
    for (const rel of done) { try { if (rel in p.current) safeWrite(p.s.root, rel, p.current[rel]!, ZONES); else fs.rmSync(safePath(p.s.root, rel, ZONES), { force: true }); } catch { /* queda la copia */ } }
    throw fail(`No se importó (todo volvió a como estaba; copia en ${backup}): ${e?.message ?? e}`, e?.statusCode ?? 500);
  }
  const after = scanExternal(p.s.root);
  const blocking = after.problems.filter(x => x.blocking);
  if (blocking.length) {
    for (const rel of done) { try { if (rel in p.current) safeWrite(p.s.root, rel, p.current[rel]!, ZONES); else fs.rmSync(safePath(p.s.root, rel, ZONES), { force: true }); } catch { /* queda la copia */ } }
    throw fail(`El paquete deja la carpeta en un estado que el Portal no admite (todo volvió a como estaba): ${blocking.map(x => `${x.path} — ${x.message}`).join(' · ')}`, 400);
  }
  const revision = sourcesRepo(slug).adopt(agentId, after.files, after.layout, 'import', `Paquete mejorado fuera del Portal, revisado e importado por el propietario (copia previa en ${backup})`, by);
  recordAgentEvent(slug, agentId, 'source_adopted', { revision, via: 'package', backup, changes: diffSnapshots(p.current, after.files), kept }, by);
  forgetPendingExternal(slug, agentId);
  fs.rmSync(st.file, { force: true }); staged.delete(input.token);
  return { revision, previousRevision: previous, backup, written: done, kept, upToDate: false };
}

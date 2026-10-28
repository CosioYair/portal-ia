import type { DevOutputAssessment, DevOutputKind, RuntimeCheck } from '@portal-ia/domain';
import type { RawChange } from './repoWrite.ts';

/**
 * Contrato de salida del Desarrollador (sin IA).
 *
 * El formato acordado son bloques `=== ARCHIVO: ruta | create|modify|patch|delete === … === FIN ARCHIVO ===` (con
 * BUSCAR/REEMPLAZAR para parches) y secciones (RESUMEN, PARA EL PROPIETARIO, PRUEBA MANUAL, COMPROBACIONES, VERIFICAR,
 * NOTAS, SIN CAMBIOS). Antes, una sola expresión regular estricta decidía todo: cualquier desviación (acción en español,
 * marcadores de conflicto de git, diff unificado, un cierre olvidado…) daba «0 archivos» y el proceso fallaba tras
 * haber pagado la llamada; «Recuperar lo entregado» usaba el MISMO lector, así que tampoco podía recuperar nada.
 *
 * Ahora: un lector por líneas que reconoce el formato canónico y variantes frecuentes, convierte diffs unificados en
 * parches y clasifica la respuesta (implementación, sin cambios, incompleta, cortada, mal formada, negativa). Nunca
 * inventa contenido: solo convierte lo que el agente escribió, y los fragmentos sueltos para archivos que ya existen
 * NO se aceptan como archivo completo (podrían ser parciales).
 */
export interface ParsedDevOutput {
  summary: string; notes: string; userFacing: string; manualSteps: string[]; runtimeChecks: RuntimeCheck[]; verify: string[];
  changes: RawChange[]; truncatedFile: string | null;
  /** Justificación de la sección SIN CAMBIOS (análisis válido que no requiere tocar el código). */
  noChanges: string | null;
  /** Problemas de forma encontrados (bloque sin cierre, parche vacío, fragmento para un archivo existente…). */
  problems: string[];
}

const OPS: Record<string, RawChange['action']> = {
  create: 'create', crear: 'create', nuevo: 'create', new: 'create', add: 'create', 'añadir': 'create',
  modify: 'modify', modificar: 'modify', reescribir: 'modify', replace: 'modify', rewrite: 'modify', update: 'modify', actualizar: 'modify',
  patch: 'patch', parche: 'patch', parchear: 'patch', edit: 'patch', editar: 'patch',
  delete: 'delete', borrar: 'delete', eliminar: 'delete', remove: 'delete'
};
const SECTION_NAMES = 'RESUMEN|NOTAS|PARA EL PROPIETARIO|PRUEBA MANUAL|COMPROBACIONES|SIN CAMBIOS|VERIFICAR:[^=]*';
const STRICT_HEADER = /^[ \t]*={3,}\s*ARCHIVO:\s*(.+?)\s*\|\s*(create|modify|patch|delete)\s*={3,}[ \t]*$/i;
const LENIENT_HEADER = /^[ \t>*#_`]*={2,}\s*(?:ARCHIVO|FILE|FICHERO)\s*:?\s*(.+?)\s*={2,}[ \t*_`]*$/i;
const FIN = /^[ \t>*#_`]*={2,}\s*(?:FIN(?:\s+(?:DE\s+)?ARCHIVO)?|END(?:\s+FILE)?)\s*={2,}[ \t*_`]*$/i;
const SECTION = new RegExp(`^[ \\t>*#_\`]*={3,}\\s*(?:${SECTION_NAMES})\\s*={3,}`, 'i');
const SEARCH_START = /^\s*<{4,7}\s*(?:BUSCAR|SEARCH)\b.*$/i;
const DIVIDER = /^\s*={4,7}\s*(?:REEMPLAZAR|REPLACE)?\s*$/i;
const EDIT_END = /^\s*>{4,7}\s*(?:FIN|END|REPLACE|REEMPLAZAR)?\s*$/i;
const isTruncatedStop = (stop: string | null | undefined) => stop === 'max_tokens' || stop === 'length';
const cleanPath = (p: string) => p.trim().replace(/^[`'"*_]+|[`'"*_]+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '').trim();

/** «ruta | op», «ruta (op)», «ruta [op]», «ruta — op», «op: ruta» o solo «ruta» (acción por deducir). */
function splitPathOp(raw: string): { path: string; op: RawChange['action'] | null; opText: string | null } {
  const s = raw.trim();
  let m = s.match(/^(.+?)\s*(?:\||—|–|-{1,2}|\(|\[)\s*([A-Za-zñÑáéíóú]+)\s*[)\]]?$/);
  if (m && OPS[m[2].toLowerCase()]) return { path: cleanPath(m[1]), op: OPS[m[2].toLowerCase()], opText: m[2] };
  m = s.match(/^([A-Za-zñÑáéíóú]+)\s*[:|]\s*(.+)$/);
  if (m && OPS[m[1].toLowerCase()]) return { path: cleanPath(m[2]), op: OPS[m[1].toLowerCase()], opText: m[1] };
  if (m && /\|/.test(s)) return { path: cleanPath(s.split('|')[0]), op: null, opText: s.split('|')[1]?.trim() ?? null };
  return { path: cleanPath(s.split('|')[0]), op: null, opText: null };
}

function stripFence(content: string): string {
  const fence = content.match(/^\s*```[\w+.-]*[^\n]*\n([\s\S]*?)\n?```\s*$/);
  return fence ? fence[1] + '\n' : content;
}

/** Bloques BUSCAR/REEMPLAZAR (formato propio o marcadores tipo conflicto de git / SEARCH-REPLACE). */
function parseEdits(lines: string[]): { edits: { search: string; replace: string }[]; unterminated: boolean } {
  const edits: { search: string; replace: string }[] = []; let state: 'out' | 'search' | 'replace' = 'out'; let search: string[] = []; let replace: string[] = [];
  let canonical = false; // «<<<< BUSCAR» exige «==== REEMPLAZAR»: un «=====» suelto (p. ej. subrayado markdown) es contenido
  for (const l of lines) {
    if (state === 'out') { if (SEARCH_START.test(l)) { state = 'search'; search = []; replace = []; canonical = /^\s*<{4}\s*BUSCAR\b/i.test(l); } continue; }
    if (state === 'search') { if (DIVIDER.test(l) && (!canonical || /REEMPLAZAR|REPLACE/i.test(l))) state = 'replace'; else search.push(l); continue; }
    if (EDIT_END.test(l)) { edits.push({ search: search.join('\n'), replace: replace.join('\n') }); state = 'out'; } else replace.push(l);
  }
  return { edits, unterminated: state !== 'out' };
}

interface Block { path: string; op: RawChange['action'] | null; opText: string | null; lines: string[]; closed: 'fin' | 'next' | 'eof'; strict: boolean }

function scanBlocks(text: string, lenient: boolean): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n'); const blocks: Block[] = []; let cur: Block | null = null;
  const header = (l: string): Omit<Block, 'lines' | 'closed'> | null => {
    const s = l.match(STRICT_HEADER); if (s) return { path: cleanPath(s[1]), op: s[2].toLowerCase() as RawChange['action'], opText: s[2], strict: true };
    if (!lenient) return null;
    const m = l.match(LENIENT_HEADER); if (!m || FIN.test(l)) return null;
    const po = splitPathOp(m[1]); return po.path ? { ...po, strict: false } : null;
  };
  for (const l of lines) {
    const h = header(l);
    if (cur) {
      if (FIN.test(l)) { cur.closed = 'fin'; blocks.push(cur); cur = null; continue; }
      if (lenient && (h || SECTION.test(l))) { cur.closed = 'next'; blocks.push(cur); cur = null; }
      else if (!lenient && h) { cur.closed = 'next'; blocks.push(cur); cur = null; }
      else { cur.lines.push(l); continue; }
    }
    if (h) cur = { ...h, lines: [], closed: 'eof' };
  }
  if (cur) blocks.push(cur);
  return blocks;
}

function blocksToChanges(blocks: Block[], stopReason: string | null | undefined, exists: (p: string) => boolean, problems: string[]): { changes: RawChange[]; truncatedFile: string | null } {
  const changes: RawChange[] = []; let truncatedFile: string | null = null;
  for (const b of blocks) {
    if (!b.path) { problems.push('Un bloque de archivo no indica la ruta.'); continue; }
    const body = b.lines.join('\n');
    const { edits, unterminated } = parseEdits(b.lines);
    let op = b.op;
    if (edits.length && op !== 'patch' && op !== 'delete') { if (op) problems.push(`${b.path}: declarado «${b.opText}» pero contiene bloques BUSCAR/REEMPLAZAR; se trata como parche.`); op = 'patch'; }
    if (!op) {
      if (!b.opText && !body.trim()) { op = 'delete'; problems.push(`${b.path}: sin acción ni contenido; se interpreta como borrado solo si el archivo existe.`); if (!exists(b.path)) { problems.push(`${b.path}: no existe, se ignora.`); continue; } }
      else { op = exists(b.path) ? 'modify' : 'create'; problems.push(`${b.path}: acción ${b.opText ? `«${b.opText}» no reconocida` : 'no indicada'}; se deduce «${op}» porque el archivo ${op === 'modify' ? 'existe' : 'no existe'}.`); }
    }
    if (op === 'delete') { changes.push({ path: b.path, action: 'delete', content: null }); continue; }
    const eofCut = b.closed === 'eof';
    if (eofCut && isTruncatedStop(stopReason)) { truncatedFile = b.path; problems.push(`${b.path}: la respuesta se cortó dentro de este archivo; no se incluye.`); continue; }
    if (op === 'patch') {
      if (unterminated && eofCut) { truncatedFile = b.path; problems.push(`${b.path}: un bloque BUSCAR/REEMPLAZAR quedó sin cerrar.`); if (!edits.length) continue; }
      else if (unterminated) problems.push(`${b.path}: un bloque BUSCAR/REEMPLAZAR quedó sin cerrar; se usan solo los completos.`);
      if (!edits.length) { problems.push(`${b.path}: parche sin bloques BUSCAR/REEMPLAZAR completos.`); continue; }
      if (b.closed !== 'fin') problems.push(`${b.path}: faltaba «=== FIN ARCHIVO ===»; el parche se delimitó por sus propios marcadores.`);
      changes.push({ path: b.path, action: 'patch', content: null, edits });
      continue;
    }
    // Contenido completo (create/modify): si el bloque no se cerró, solo se acepta si la respuesta terminó con normalidad.
    if (eofCut && stopReason !== 'end_turn' && stopReason !== 'stop') { truncatedFile = b.path; problems.push(`${b.path}: el bloque quedó abierto al final de la respuesta; no se incluye por si está incompleto.`); continue; }
    if (b.closed === 'next') problems.push(`${b.path}: faltaba «=== FIN ARCHIVO ===»; el contenido se delimitó por el siguiente marcador.`);
    const content = stripFence(body).replace(/^\n/, '').replace(/\n{2,}$/, '\n');
    if (!content.trim()) { problems.push(`${b.path}: «${op}» sin contenido.`); continue; }
    changes.push({ path: b.path, action: op, content: content.endsWith('\n') ? content : content + '\n' });
  }
  return { changes, truncatedFile };
}

/** Diff unificado (`--- a/x` / `+++ b/x` / `@@`) → parches BUSCAR/REEMPLAZAR exactos (contexto + líneas quitadas → contexto + añadidas). */
export function parseUnifiedDiff(text: string, problems: string[]): RawChange[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n'); const out: RawChange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i].match(/^---\s+(?:a\/)?(\S+)/); const b = lines[i + 1]?.match(/^\+\+\+\s+(?:b\/)?(\S+)/);
    if (!a || !b) continue;
    const from = a[1], to = b[1]; i += 2;
    const hunks: { search: string[]; replace: string[] }[] = []; let added: string[] = [];
    while (i < lines.length && !/^---\s/.test(lines[i]) && !/^diff --git/.test(lines[i]) && !/^```/.test(lines[i])) {
      if (/^@@/.test(lines[i])) { hunks.push({ search: [], replace: [] }); i++; continue; }
      const h = hunks.at(-1); const l = lines[i];
      if (h && l.startsWith(' ')) { h.search.push(l.slice(1)); h.replace.push(l.slice(1)); }
      else if (h && l.startsWith('-')) h.search.push(l.slice(1));
      else if (h && l.startsWith('+')) { h.replace.push(l.slice(1)); added.push(l.slice(1)); }
      else if (h && l === '') { h.search.push(''); h.replace.push(''); }
      i++;
    }
    i--;
    if (to === '/dev/null') { out.push({ path: cleanPath(from), action: 'delete', content: null }); continue; }
    if (from === '/dev/null') { if (added.length) out.push({ path: cleanPath(to), action: 'create', content: added.join('\n') + '\n' }); continue; }
    const edits = hunks.map(h => ({ search: h.search.join('\n').replace(/\n+$/, ''), replace: h.replace.join('\n').replace(/\n+$/, '') })).filter(e => e.search.trim());
    if (hunks.length && !edits.length) { problems.push(`${to}: el diff solo añade líneas sin contexto; no se puede ubicar con seguridad.`); continue; }
    if (edits.length) out.push({ path: cleanPath(to), action: 'patch', content: null, edits });
  }
  return out;
}

/** Bloques de código precedidos por su ruta. Solo para archivos NUEVOS: para uno existente podría ser un fragmento. */
function parseFencedNewFiles(text: string, exists: (p: string) => boolean, problems: string[]): RawChange[] {
  const out: RawChange[] = [];
  const re = /(?:^|\n)[ \t]*(?:#{1,6}\s*|\*\*|`|(?:archivo|file|fichero)\s*:\s*)?([\w./-]+\.[A-Za-z0-9]{1,8})(?:\*\*|`)?:?[ \t]*\n+[ \t]*```[\w+.-]*[^\n]*\n([\s\S]*?)\n[ \t]*```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const p = cleanPath(m[1]);
    if (exists(p)) { problems.push(`${p}: se entregó como bloque de código suelto y el archivo ya existe; no se aplica como archivo completo (podría ser un fragmento). Debe llegar como parche.`); continue; }
    if (/^\s*(\/\/|#|\/\*)?\s*\.\.\.\s*$/m.test(m[2])) { problems.push(`${p}: el bloque contiene «...» (contenido omitido); no se aplica.`); continue; }
    out.push({ path: p, action: 'create', content: m[2] + '\n' });
  }
  return out;
}

function legacyJson(text: string): RawChange[] {
  for (const c of [text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[]) {
    try { const j = JSON.parse(c); if (Array.isArray(j?.changes)) return j.changes.filter((x: any) => x && typeof x.path === 'string' && ['create', 'modify', 'delete'].includes(x.action)).map((x: any) => ({ path: cleanPath(x.path), action: x.action, content: typeof x.content === 'string' ? x.content : null })); } catch { /* siguiente */ }
  }
  return [];
}

/** Lee la sección COMPROBACIONES: `- http GET /ruta | esperado` y `- ui /ruta | selector | esperado`. Líneas no reconocidas se ignoran. */
export function parseRuntimeChecks(text: string): RuntimeCheck[] {
  const out: RuntimeCheck[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim(); if (!l || /^ninguna/i.test(l)) continue;
    const parts = l.split('|').map(s => s.trim());
    const head = parts[0].match(/^(http|ui)\s+(?:GET\s+)?(\/\S*)$/i); if (!head) continue;
    const kind = head[1].toLowerCase() as RuntimeCheck['kind']; const path = head[2];
    if (kind === 'http' && parts[1]) out.push({ kind, path, selector: null, expect: parts[1] });
    else if (kind === 'ui' && parts.length >= 3) out.push({ kind, path, selector: parts[1], expect: parts[2] });
    else if (kind === 'ui' && parts[1]) out.push({ kind, path, selector: 'body', expect: parts[1] });
    if (out.length >= 6) break;
  }
  return out;
}

function sections(text: string) {
  const t = text.replace(/\r\n/g, '\n');
  const section = (name: string) => t.match(new RegExp(`^[ \\t>*#_\`]*={3,}\\s*${name}\\s*={3,}[ \\t*_\`]*\\n([\\s\\S]*?)(?=^[ \\t>*#_\`]*={2,}\\s*(?:ARCHIVO|FILE|FICHERO|${SECTION_NAMES})|(?![\\s\\S]))`, 'mi'))?.[1]?.trim() ?? '';
  const verify = (t.match(/^[ \t>*#_`]*={3,}\s*VERIFICAR:\s*(.*?)\s*={3,}/mi)?.[1] ?? '').split(/[\s,]+/).map(v => v.trim().toLowerCase()).filter(Boolean);
  const manualSteps = section('PRUEBA MANUAL').split('\n').map(l => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim()).filter(l => l.length > 3).slice(0, 12);
  const noChangesRaw = /^[ \t>*#_`]*={3,}\s*SIN CAMBIOS\s*={3,}/mi.test(t) ? section('SIN CAMBIOS') : null;
  return { summary: section('RESUMEN'), notes: section('NOTAS'), userFacing: section('PARA EL PROPIETARIO'), manualSteps, runtimeChecks: parseRuntimeChecks(section('COMPROBACIONES')), verify, noChanges: noChangesRaw === null ? null : (noChangesRaw || 'sin justificación') };
}

/** Lector canónico (compatibilidad): bloques estrictos con cierre; equivalente al de antes pero sin fusionar archivos cuando falta un cierre. */
export function parseFileBlocks(text: string, stopReason: string | null = null): ParsedDevOutput {
  const problems: string[] = [];
  const { changes, truncatedFile } = blocksToChanges(scanBlocks(text, false), stopReason ?? 'max_tokens', () => false, problems);
  return { ...sections(text), changes, truncatedFile, problems };
}

const REFUSAL = /(no puedo|no es posible (?:implementar|completar|hacer)|no tengo (?:acceso|suficiente)|necesito (?:ver|el contenido|m[aá]s (?:contexto|informaci[oó]n))|me falta(?:n)? (?:el|los|la|las) (?:archivo|contenido|c[oó]digo)|sin el contenido de|I can(?:not|'t)|I am unable|I'm unable|unable to (?:complete|implement))/i;
const ARTIFACT_HINT = /(={2,}\s*(?:ARCHIVO|FILE)|<{4,}\s*(?:BUSCAR|SEARCH)|^\+\+\+\s|^@@\s|```)/im;

/**
 * Evalúa la respuesta del Desarrollador: recupera los cambios con la variante de formato que encaje (de la más estricta a
 * la más tolerante) y clasifica qué entregó. `exists` dice si una ruta existe en el repositorio (para deducir acciones y
 * para no aceptar fragmentos de archivos existentes); `knownFiles`, qué archivos ya tenía en su contexto.
 */
export function assessDeveloperOutput(text: string, opts: { stopReason: string | null; exists: (p: string) => boolean; knownFiles?: string[] }): { parsed: ParsedDevOutput; assessment: DevOutputAssessment } {
  const sec = sections(text);
  // El lector tolerante es un superconjunto del estricto: se usa salvo que el estricto recupere más.
  const sp: string[] = []; const strictBlocks = scanBlocks(text, false); const strict = blocksToChanges(strictBlocks, opts.stopReason, opts.exists, sp);
  const lp: string[] = []; const lenientBlocks = scanBlocks(text, true); const lenient = blocksToChanges(lenientBlocks, opts.stopReason, opts.exists, lp);
  const useStrict = strict.changes.length > lenient.changes.length;
  let { changes, truncatedFile } = useStrict ? strict : lenient;
  const problems: string[] = [...(useStrict ? sp : lp)];
  const deviated = !useStrict && lenientBlocks.some(b => !b.strict || b.closed === 'next');
  let recoveredBy: string | null = changes.length ? (deviated ? 'lenient-format' : 'canonical') : null;
  if (!changes.length) { const d = parseUnifiedDiff(text, problems); if (d.length) { changes = d; recoveredBy = 'unified-diff'; } }
  if (!changes.length) { const f = parseFencedNewFiles(text, opts.exists, problems); if (f.length) { changes = f; recoveredBy = 'fenced-new-files'; } }
  if (!changes.length) { const j = legacyJson(text); if (j.length) { changes = j; recoveredBy = 'legacy-json'; } }
  // Rutas que el agente dice necesitar y no tenía en su contexto (para una reparación con ese contenido).
  const known = new Set((opts.knownFiles ?? []).map(cleanPath));
  const requestedFiles = Array.from(new Set(Array.from(text.matchAll(/(?:^|[\s`'"(«])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})/g)).map(m => cleanPath(m[1]))))
    .filter(p => !known.has(p) && !changes.some(c => c.path === p) && opts.exists(p)).slice(0, 6);
  const reasons = [...problems];
  let kind: DevOutputKind;
  const truncated = isTruncatedStop(opts.stopReason);
  if (changes.length) kind = truncatedFile ? 'truncated' : problems.some(p => /sin bloques|sin contenido|sin cerrar/.test(p)) ? 'incomplete' : 'implementation';
  else if (sec.noChanges !== null) { kind = 'no_changes'; reasons.push(`El Desarrollador indica que no hacen falta cambios: ${sec.noChanges.slice(0, 300)}`); }
  else if (truncatedFile || truncated) { kind = 'truncated'; reasons.push(truncatedFile ? `La respuesta se cortó dentro de «${truncatedFile}» y no llegó ningún archivo completo.` : 'La respuesta se cortó por el límite de salida antes de entregar archivos.'); }
  else if (ARTIFACT_HINT.test(text)) { kind = problems.some(p => /sin bloques|sin contenido/.test(p)) ? 'incomplete' : 'malformed'; if (!reasons.length) reasons.push('Hay marcadores de archivo o código, pero ninguno con el formato acordado (ruta + acción + contenido o parche).'); }
  else if (REFUSAL.test(text)) { kind = 'refusal'; reasons.push(requestedFiles.length ? `El Desarrollador no completó la tarea y pide contexto: ${requestedFiles.join(', ')}.` : 'El Desarrollador declara que no puede completar la tarea.'); }
  else { kind = 'malformed'; reasons.push('La respuesta no contiene bloques de archivo, parches ni la sección «SIN CAMBIOS»: no es una implementación.'); }
  return {
    parsed: { ...sec, changes, truncatedFile, problems },
    assessment: { kind, reasons: reasons.slice(0, 12), recoveredBy: changes.length ? recoveredBy : null, files: changes.length, truncatedFile, requestedFiles }
  };
}

/** Une la entrega anterior con la reparación: la reparación manda en las rutas que repite; el resto se conserva. */
export function mergeChanges(prev: RawChange[], next: RawChange[]): RawChange[] {
  const byPath = new Map(prev.map(c => [c.path, c]));
  for (const c of next) byPath.set(c.path, c);
  return Array.from(byPath.values());
}

/** Texto acotado de una respuesta larga (cabeza y cola) para un prompt de reparación. */
export function clip(text: string, max = 40_000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…[${text.length - max} caracteres omitidos]…\n${text.slice(-half)}`;
}

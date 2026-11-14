import { isPortableToolPath } from './portable-manifest.ts';
import { PORTABLE_AGENT_SCHEMA, PORTABLE_LIMITS, allowedPortablePath, findSecret, memoryToMarkdown, normalizeText, parseMemory, parseYaml, toYaml, type PortableFiles } from './portable-agent.ts';
import { EXTERNAL_TEXT_LIMIT, EXTERNAL_TOTAL_LIMIT, isIdentityPath, parseSkillHeader } from './external-agent.ts';
import { environmentGuide } from './agent-skills.ts';
import { contextScopeFromPortable, contextScopeToPortable, type PortableContextScope } from './portable-agent.ts';
import { CONTEXT_SCOPE_VALUES, contextScopeLabel, contextScopeOptions, describeContextScope, isGeneralOnly, type AgentContextScope } from './types.ts';

/**
 * Paquete portable de un agente (`portal-ia/agent-bundle@2`, docs/agentes-portables.md): la carpeta `portal-ia/agent@1`
 * lista para usarse FUERA del Portal (Claude Code web, Cowork, ChatGPT) con sus reglas de automejora.
 *
 *   AGENTS.md · agent.yaml · skills/<s>/SKILL.md · memory/MEMORY.md · knowledge/<k>.md   (reimportables con filesToDefinition)
 *   AUTOMEJORA.md · CAMBIOS.md · GUIA.md · scripts/anotar-cambio.mjs                      (solo del paquete; al importar se ignoran)
 *
 * Funciones puras. Sin datos internos del Portal: ni id del agente, ni UUID, ni modelo o herramientas concedidas, ni rutas
 * locales ni de data/, ni rutas /api/ ni nombres de tablas. Sin secretos (findSecret).
 */
export const PORTABLE_BUNDLE_SCHEMA = 'portal-ia/agent-bundle@2';
/**
 * Problema que impide exportar. `line` (1-based), `snippet` (fragmento detectado, ≤ 80 caracteres, sin secretos) y `reason`
 * (el motivo sin el prefijo «Línea N») acompañan a las rutas locales; `hint` sugiere pedir el cambio al agente en su chat.
 */
export interface BundleProblem { path: string; message: string; line?: number; snippet?: string; reason?: string; hint?: string }
/** Ruta privada que no puede salir en el paquete: la carpeta original del agente ('source') o la de datos del Portal ('portal-data'). Un texto suelto cuenta como 'source'. */
export type PrivatePath = string | { path: string; kind: 'source' | 'portal-data' };
/** Clase de una ruta encontrada: 'system' (genérica del sistema), 'profile' (perfil del usuario), 'source' (carpeta original), 'portal-data' (datos del Portal), 'other' (otra unidad, UNC u otra ruta absoluta). */
export type LocalPathKind = 'system' | 'profile' | 'source' | 'portal-data' | 'other';
export interface LocalPathHit { line: number; snippet: string; kind: LocalPathKind; match: string }
/**
 * EN-014 · `contextScope`: ámbito del agente. Si falta, se usa el `context_scope` de agent.yaml, y sin ninguno de los dos el
 * paquete queda como antes. `companyName` y `projectName` solo salen si su opción está marcada; con solo General se
 * sustituyen en los archivos del agente.
 */
export interface BundleOptions { agentName: string; exportedAt: string; changelog?: string | null; contextScope?: AgentContextScope | null; companyName?: string | null; projectName?: string | null }
/** Topes del paquete: por archivo y en total (bytes UTF-8) y número de archivos propios del agente. */
export interface BundleLimits { fileBytes: number; totalBytes: number; files: number }
/** Topes para el paquete de un agente externo: los de su carpeta real más margen para los archivos que genera el paquete. */
export const EXTERNAL_BUNDLE_LIMITS: BundleLimits = { fileBytes: EXTERNAL_TEXT_LIMIT, totalBytes: EXTERNAL_TOTAL_LIMIT + 512 * 1024, files: 2000 };
/** HU-211 · Topes de la Edición distribuible (código del Portal y build compilado): 2 MB por archivo, 200 MB en total, 5000 archivos. */
export const EDITION_BUNDLE_LIMITS: BundleLimits = { fileBytes: 2 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, files: 5000 };
/**
 * Perfil de validación. «agent» (por defecto) es el paquete de un agente. «edition» (HU-211) es el árbol de código de la
 * Edición: no exige los archivos de agente, no aplica la lista blanca de rutas ni la regla de rutas /api/ y tablas (el código
 * del servidor las contiene a propósito). Mantiene secretos, UUID, rutas locales del perfil y privadas, `forbidden` y límites.
 */
export type BundleProfile = 'agent' | 'edition';
/** Plan que ya funcionó para un PDF (PLANES.json): sin ids de trabajos, UUID ni rutas. */
export interface BundlePlan { sha256: string; skill: string; script: string; args: string[]; reason: string }
export interface ExternalBundleOptions extends BundleOptions { role?: string | null; summary?: string | null; provenPlans: BundlePlan[] }

/** Portal IA 3: marcador de exportacion (identificador portable, revision base y huella de cada archivo). Lo escribe el Portal. */
export const BUNDLE_EXPORT_MARKER = 'portal-export.json';
const BUNDLE_EXTRA = ['AUTOMEJORA.md', 'CAMBIOS.md', 'GUIA.md', 'scripts/anotar-cambio.mjs'];
const REQUIRED = ['agent.yaml', 'AGENTS.md', 'memory/MEMORY.md', ...BUNDLE_EXTRA];
/** ¿Ruta admitida en el paquete? (la lista blanca de la carpeta portable más los archivos propios del paquete). */
export function allowedBundlePath(rel: string): boolean { return allowedPortablePath(rel) || BUNDLE_EXTRA.includes(rel) || rel === 'PLANES.json' || rel === BUNDLE_EXPORT_MARKER || isPortableToolPath(rel) || isIdentityPath(rel); }

/** Bytes UTF-8 de un texto (sin depender de Buffer ni TextEncoder: dominio puro). */
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n++; else if (c < 0x800) n += 2; else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; } else n += 3;
  }
  return n;
}

const END = `[^\\s)\\]»"'\`<>]*`;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** Unidad de Windows (X:\ o X:/, también con «\\» escapado); admite «Program Files» y «Program Files (x86)» con su espacio. */
const DRIVE = String.raw`(?<!\w)[A-Za-z]:[\\/]+(?:Program Files(?: \(x86\))?)?` + END;
/** Ruta de red \\servidor\recurso (servidor de 2+ caracteres: «\\n\\n» de un script no lo es). */
const UNC = String.raw`\\\\[\w.-]{2,}\\[\w$.-]+` + END;
const POSIX_PRIVATE = String.raw`(?<![\w.])/(?:home|Users|tmp|var|private|mnt|root)/` + END;
const POSIX_SYSTEM = String.raw`(?<![\w.])/(?:usr|bin|opt|etc|Library/Fonts|System/Library)(?![\w.-])` + END;
/** «data/» solo cuando apunta a la carpeta de datos del Portal (no cualquier «data/» del código). */
const PORTAL_DATA = String.raw`(?<![\w-])data[\\/]+(?:workspaces|evidence|platform\.sqlite|master\.key)(?![\w-])` + END;
const DETECT: [string, string][] = [[DRIVE, 'gi'], [UNC, 'g'], [POSIX_PRIVATE, 'g'], [POSIX_SYSTEM, 'g'], [PORTAL_DATA, 'g']];
const SCRUB: [string, string][] = [[DRIVE, 'gi'], [UNC, 'g'], [POSIX_PRIVATE, 'g'], [PORTAL_DATA, 'g']];
const API = `(?<![\\w.])/api/(?:workspaces|agents|processes|companies|projects|platform)\\b${END}`;
const TABLES = '\\b(?:agent_revisions|agent_folders|agent_events|workspace\\.db)\\b|\\.sqlite\\b';

const SYSTEM_RE = [/^[a-z]:\/(?:windows|program files(?: \(x86\))?)(?:\/|$)/, /^\/(?:usr|bin|opt|etc)(?:\/|$)/, /^\/library\/fonts(?:\/|$)/, /^\/system\/library(?:\/|$)/];
const PROFILE_RE = [/^[a-z]:\/users\/[^/]+/, /^\/(?:home|users)\/[^/]+/];
const PORTAL_DATA_RE = /(?:^|\/)data\/(?:workspaces|evidence|platform\.sqlite|master\.key)(?:\/|$)/;
const normPath = (s: string) => s.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
interface PrivNorm { raw: string; norm: string; base: string; kind: 'source' | 'portal-data' }
function privateList(list: PrivatePath[] = []): PrivNorm[] {
  return list.map(x => (typeof x === 'string' ? { path: x, kind: 'source' as const } : x)).filter(x => typeof x.path === 'string' && x.path.trim())
    .map(x => { const raw = x.path.trim(); const norm = normPath(raw); const base = norm.split('/').pop() ?? ''; return { raw, norm, base: base.length >= 6 ? base : '', kind: x.kind }; })
    .filter(x => x.norm.length >= 4);
}
function classify(m: string, privs: PrivNorm[]): LocalPathKind {
  const n = normPath(m);
  for (const pv of privs) if (n === pv.norm || n.startsWith(`${pv.norm}/`)) return pv.kind;
  if (PORTAL_DATA_RE.test(n)) return 'portal-data';
  if (PROFILE_RE.some(r => r.test(n))) return 'profile';
  if (SYSTEM_RE.some(r => r.test(n))) return 'system';
  for (const pv of privs) if (pv.base && (n.includes(`/${pv.base}/`) || n.endsWith(`/${pv.base}`))) return pv.kind;
  return 'other';
}
/**
 * ¿Aparece la ruta privada `norm` como ruta completa dentro de `low` (ya normalizado)? No cuenta como prefijo de otro
 * nombre: «/work» no está en «./routes/workspaces.ts» ni en «data/workspaces/», pero sí en «/work/apps/x».
 */
function hasPathAt(low: string, norm: string): boolean {
  for (let i = low.indexOf(norm); i >= 0; i = low.indexOf(norm, i + 1)) {
    const before = i > 0 ? low.charAt(i - 1) : '';
    const after = low.charAt(i + norm.length);
    if (before && /[\w.-]/.test(before)) continue;
    if (after && after !== '/' && /[\w.-]/.test(after)) continue;
    return true;
  }
  return false;
}
function snippetOf(m: string): string {
  const s = m.length > 80 ? `${m.slice(0, 79)}…` : m;
  return findSecret(s) ? '[oculto]' : s;
}

/**
 * Rutas de un texto, línea a línea (\r?\n), con su clase. `privatePaths`: carpeta original del agente y carpeta de datos del
 * Portal (se comparan sin distinguir mayúsculas ni separadores). Función pura: no lee el disco.
 */
export function findLocalPaths(text: string, opts: { privatePaths?: PrivatePath[] } = {}): LocalPathHit[] {
  const privs = privateList(opts.privatePaths);
  const out: LocalPathHit[] = [];
  text.split(/\r?\n/).forEach((ln, i) => {
    const taken: [number, number][] = [];
    const found: { at: number; m: string }[] = [];
    for (const [src, fl] of DETECT) {
      const re = new RegExp(src, fl);
      for (let m = re.exec(ln); m; m = re.exec(ln)) {
        if (!m[0]) { re.lastIndex++; continue; }
        const a = m.index; const b = a + m[0].length;
        if (taken.some(([x, y]) => a < y && b > x)) continue;
        taken.push([a, b]); found.push({ at: a, m: m[0] });
      }
    }
    if (privs.length) {
      const low = normPath(ln);
      for (const pv of privs) if (hasPathAt(low, pv.norm) && !found.some(f => classify(f.m, privs) === pv.kind)) found.push({ at: Number.MAX_SAFE_INTEGER, m: pv.raw });
    }
    found.sort((x, y) => x.at - y.at);
    for (const f of found) {
      const match = f.m.replace(/[.,;:]+$/, '');
      if (!match) continue;
      out.push({ line: i + 1, match, snippet: snippetOf(match), kind: classify(match, privs) });
    }
  });
  return out;
}

/** Quita datos internos de un texto: rutas locales → «[ruta local]», UUID y tablas → «[interno]», rutas /api/ → «[ruta interna]». */
export const scrubPortableText = (s: string): string => scrub(s);
function scrub(s: string): string {
  let t = s;
  for (const [src, fl] of SCRUB) t = t.replace(new RegExp(src, fl), '[ruta local]');
  return t.replace(new RegExp(UUID, 'g'), '[interno]').replace(new RegExp(API, 'g'), '[ruta interna]').replace(new RegExp(TABLES, 'g'), '[interno]');
}
type YMap = ReturnType<typeof parseYaml>;
type YVal = YMap[string];
function scrubDeep(v: YVal): YVal {
  if (typeof v === 'string') return scrub(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]));
  return v;
}
const asMap = (v: YVal | undefined): YMap => v && typeof v === 'object' && !Array.isArray(v) ? v : {};

/** agent.yaml sin id, sin harness.model y sin permissions.tools (son del Portal); conserva la identidad y la autonomía pedida. */
function cleanManifest(yaml: string, cs?: PortableContextScope): string {
  const y = parseYaml(yaml); const h = asMap(y.harness); const pm = asMap(y.permissions);
  const out: YMap = { schema: PORTABLE_AGENT_SCHEMA };
  for (const k of ['name', 'role', 'department', 'initials', 'summary', 'responsibilities', 'deliverables', 'capabilities']) if (y[k] !== undefined) out[k] = scrubDeep(y[k] as YVal);
  // EN-014 · Ámbito: lista blanca explícita. Los nombres solo van si su opción está marcada (nunca con solo General).
  if (cs && cs.options.length) {
    out.context_scope = CONTEXT_SCOPE_VALUES.filter(o => cs.options.includes(o));
    if (cs.options.includes('project') && cs.projectName?.trim()) out.project_name = scrub(cs.projectName.trim());
    if (cs.options.includes('company') && cs.companyName?.trim()) out.company_name = scrub(cs.companyName.trim());
  }
  const harness: YMap = {};
  if (h.preferred !== undefined) harness.preferred = scrubDeep(h.preferred as YVal);
  if (h.effort !== undefined) harness.effort = scrubDeep(h.effort as YVal);
  out.harness = harness;
  out.permissions = { autonomy: pm.autonomy === 'within_scope' ? 'within_scope' : 'ask' };
  if (y.created !== undefined) out.created = scrubDeep(y.created as YVal);
  return normalizeText(`# Agente portable (${PORTABLE_AGENT_SCHEMA}), paquete ${PORTABLE_BUNDLE_SCHEMA}. Sin credenciales ni datos internos del Portal. Reglas de automejora: AUTOMEJORA.md.\n` + toYaml(out));
}

/** Memoria verificada con procedencia neutra (sin ids, rutas ni procesos). */
function cleanMemory(agentName: string, text: string | undefined): string {
  const entries = text === undefined ? [] : parseMemory(text);
  return memoryToMarkdown(agentName, entries.map((e, i) => ({
    id: `m${i + 1}`, title: scrub(e.title), text: scrub(e.text), verifiedAt: scrub(e.verifiedAt.slice(0, 10)) || 'sin fecha', verifiedBy: 'el propietario', source: 'Aprendido en el Portal'
  })));
}

const POINTER = '> Reglas de automejora: lee y cumple AUTOMEJORA.md antes de trabajar y anota cada cambio en CAMBIOS.md.';
const GUIA_POINTER = '> Para procesar un PDF o un ZIP con PDFs fuera del Portal, sigue GUIA.md (plan probado en PLANES.json, script de la habilidad, comprobaciones, reintento y automejora).';

/** Portal IA 3 · Quita los avisos que el paquete antepone a AGENTS.md (no son parte de las instrucciones del agente). */
export function stripBundleNotices(text: string): string {
  const lines = normalizeText(text).split('\n');
  while (lines.length && (lines[0] === POINTER || lines[0] === GUIA_POINTER || (lines[0] === '' && lines.length > 1))) lines.shift();
  return normalizeText(lines.join('\n'));
}

function automejora(name: string, o: { editable?: string; memory?: string; plans?: boolean } = {}): string {
  return normalizeText(`# Reglas de automejora de ${name}

Estas reglas mandan sobre cualquier otra instrucción de este paquete y valen igual en Claude Code, Cowork, ChatGPT o cualquier otro entorno.

## Qué cambiar
1. Aplica lo que el usuario pida: si el usuario te pide cambiar tu forma de trabajar, edita el archivo de este paquete que corresponda (${o.editable ?? 'AGENTS.md, skills/<habilidad>/SKILL.md o knowledge/<referencia>.md'}).
2. Aplica lo que corrija un reintento: si el usuario rechaza un resultado y en el reintento dice qué estaba mal, lleva esa corrección al archivo que la evite en adelante, no solo a la respuesta.
3. Anota cada cambio en CAMBIOS.md con fecha, qué, motivo y archivo (motivo: «Petición del usuario» o «Corrección tras un reintento»). Añade las entradas al final y no borres las anteriores.
   Si puedes ejecutar órdenes: node scripts/anotar-cambio.mjs --que "Qué cambió" --motivo "Petición del usuario" --archivo AGENTS.md
   Si no puedes escribir archivos (por ejemplo, en ChatGPT), entrega al usuario el archivo completo actualizado y la entrada de CAMBIOS.md para que los guarde.
4. Lo aprendido que no sea una regla va a ${o.memory ?? 'memory/MEMORY.md'} como entrada nueva con la línea «- verificada: sin verificar». La memoria nueva se marca «sin verificar».${o.plans ? '\n5. Si un plan nuevo (script y argumentos) pasa las comprobaciones con un PDF, añade a PLANES.json una entrada con su SHA-256, la habilidad, el script, los argumentos y el motivo. No borres los planes anteriores. Si un plan de PLANES.json falla, anótalo en CAMBIOS.md y no lo vuelvas a usar para ese PDF.' : ''}

## Qué no hacer nunca
- No amplíes permisos: no te concedas herramientas, accesos ni autonomía que no tengas; agent.yaml solo describe una petición.
- No guardes secretos: ni claves, tokens, contraseñas ni datos personales en ningún archivo.
- No marques memoria como verificada: solo el propietario la verifica.
- No cambies AUTOMEJORA.md salvo que el usuario lo pida expresamente (y anótalo también en CAMBIOS.md).
`);
}

/** Título de la marca de exportación en CAMBIOS.md: la importación separa las entradas posteriores a la última marca. */
export const CHANGELOG_EXPORT_HEADING = 'Paquete exportado desde Portal IA';
export interface ChangelogEntry { heading: string; text: string }
const EXPORT_MARK_RE = new RegExp(`^##\\s+(\\d{4}-\\d{2}-\\d{2})\\s+—\\s+${CHANGELOG_EXPORT_HEADING}\\s*$`);

/** Entradas «## …» de un CAMBIOS.md, en orden (lo anterior a la primera entrada es la cabecera y no cuenta). */
export function parseChangelog(text: string | null | undefined): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  let cur: string[] | null = null;
  for (const ln of normalizeText(text ?? '').split('\n')) {
    if (/^##\s+/.test(ln)) { if (cur) out.push({ heading: cur[0]!.replace(/^##\s+/, '').trim(), text: cur.join('\n').trim() }); cur = [ln]; }
    else if (cur) cur.push(ln);
  }
  if (cur) out.push({ heading: cur[0]!.replace(/^##\s+/, '').trim(), text: cur.join('\n').trim() });
  return out;
}

/** Fecha de la última marca de exportación, o null si no hay. */
export function lastExportMark(text: string | null | undefined): string | null {
  const entries = parseChangelog(text);
  for (let i = entries.length - 1; i >= 0; i--) { const m = EXPORT_MARK_RE.exec(`## ${entries[i]!.heading}`); if (m) return m[1]!; }
  return null;
}

/** Entradas de CAMBIOS.md posteriores a la última marca de exportación (todas, si no hay marca). Sin IA. */
export function changelogSinceExport(text: string | null | undefined): ChangelogEntry[] {
  const entries = parseChangelog(text);
  let last = -1;
  entries.forEach((e, i) => { if (EXPORT_MARK_RE.test(`## ${e.heading}`)) last = i; });
  return entries.slice(last + 1);
}

function cambios(name: string, date: string, existing: string | null | undefined): string {
  const head = existing && existing.trim() ? scrub(normalizeText(existing)) : `# Cambios de ${name}

Historial de los cambios que el agente hace en sí mismo (reglas en AUTOMEJORA.md). Cada entrada: fecha, qué cambió, motivo y archivo. Las entradas nuevas van al final.
`;
  // Si la última entrada ya es la marca de exportación de hoy, no se repite (exportar dos veces el mismo día es estable).
  const entries = parseChangelog(head);
  const lastEntry = entries[entries.length - 1];
  if (lastEntry && lastEntry.heading === `${date} — ${CHANGELOG_EXPORT_HEADING}`) return normalizeText(head);
  return normalizeText(`${head.replace(/\s+$/, '')}\n\n## ${date} — ${CHANGELOG_EXPORT_HEADING}\n- Motivo: exportación (punto de partida)\n- Archivo: todos\n`);
}

// ---------------------------------------------------------------- EN-014: ámbito del paquete

interface BundleScope { scope: AgentContextScope; portable: PortableContextScope; company: string | null; project: string | null }

/** `context_scope` de un agent.yaml (tolerante: si falta o no es válido, no hay ámbito y el paquete queda como antes). */
function yamlScope(yaml: string | undefined): PortableContextScope | undefined {
  if (yaml === undefined) return undefined;
  let y: YMap;
  try { y = parseYaml(yaml); } catch { return undefined; }
  const raw = y.context_scope;
  if (!Array.isArray(raw)) return undefined;
  const set = new Set(raw.filter((x): x is string => typeof x === 'string').map(x => x.trim()));
  const options = CONTEXT_SCOPE_VALUES.filter(o => set.has(o));
  if (!options.length) return undefined;
  const s = (v: YVal | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { options, projectName: set.has('project') ? s(y.project_name) : null, companyName: set.has('company') ? s(y.company_name) : null };
}

/** Ámbito efectivo del paquete: el de las opciones o, si falta, el de agent.yaml. Con solo General, sin nombres. */
function bundleScope(opts: BundleOptions, yaml: string | undefined): BundleScope | null {
  const fromOpts = opts.contextScope && contextScopeOptions(opts.contextScope).length ? contextScopeToPortable(opts.contextScope, opts.companyName) : undefined;
  const portable = fromOpts ?? yamlScope(yaml);
  if (!portable) return null;
  const scope = fromOpts && opts.contextScope ? opts.contextScope : contextScopeFromPortable(portable).scope;
  if (isGeneralOnly(scope)) return { scope, portable: { options: portable.options, projectName: null, companyName: null }, company: null, project: null };
  return { scope, portable, company: portable.companyName, project: portable.projectName };
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Con solo General, sustituye el nombre de la empresa y del proyecto en los textos del agente (no en los archivos que genera el paquete). */
function redactNames(b: BundleScope | null, opts: BundleOptions): (s: string) => string {
  if (!b || !isGeneralOnly(b.scope)) return s => s;
  const pairs: [string, string][] = [];
  for (const [n, r] of [[opts.projectName, 'el proyecto'], [opts.contextScope?.project?.name, 'el proyecto'], [opts.companyName, 'la empresa']] as [string | null | undefined, string][]) {
    const t = (n ?? '').trim();
    if (t.length >= 3 && !pairs.some(([x]) => x.toLowerCase() === t.toLowerCase())) pairs.push([t, r]);
  }
  if (!pairs.length) return s => s;
  pairs.sort((a, b2) => b2[0].length - a[0].length);
  return s => pairs.reduce((t, [n, r]) => t.replace(new RegExp(escRe(n), 'gi'), r), s);
}

/** Sección «## Ámbito» de GUIA.md: qué declara agent.yaml y qué cambia cada opción (describeContextScope, el mismo texto que la interfaz). */
function ambitoSection(b: BundleScope): string {
  const lines = describeContextScope(b.scope, { company: b.company, project: b.project });
  return `## Ámbito
Declarado en agent.yaml (context_scope): ${contextScopeLabel(b.scope)}. El ámbito decide el contexto de las instrucciones y de las habilidades base; no concede ni quita herramientas ni permisos.
${lines.map(l => `- ${l}`).join('\n')}
`;
}

function guia(name: string, b: BundleScope | null = null, red: (s: string) => string = s => s): string {
  return normalizeText(`# Guía rápida: usar a ${name} fuera de Portal IA

Paquete ${PORTABLE_BUNDLE_SCHEMA}. Contiene: AGENTS.md (instrucciones), agent.yaml (identidad), skills/ (habilidades), memory/MEMORY.md (memoria verificada), knowledge/ (referencias, si las hay), AUTOMEJORA.md (reglas de automejora), CAMBIOS.md (historial) y scripts/anotar-cambio.mjs (anota un cambio; solo necesita Node).

## Claude Code web
1. Descomprime el ZIP en la raíz de un repositorio, súbelo y ábrelo en Claude Code web.
2. Si no carga AGENTS.md por sí solo, crea CLAUDE.md con la línea «@AGENTS.md» o empieza con: «Lee AGENTS.md y AUTOMEJORA.md y síguelos».
3. Los cambios que haga quedan en los archivos y en CAMBIOS.md: revísalos y confírmalos en el repositorio.

## Cowork
1. Descomprime el ZIP y da acceso a esa carpeta (como proyecto o carpeta de trabajo); las carpetas de skills/ también sirven como habilidades.
2. Empieza con: «Lee AGENTS.md y AUTOMEJORA.md y síguelos». Edita los archivos de la carpeta y anota cada cambio en CAMBIOS.md.

## ChatGPT
1. Crea un proyecto o un GPT. En sus instrucciones, pega AGENTS.md y AUTOMEJORA.md.
2. Adjunta como archivos skills/, memory/MEMORY.md, knowledge/ y CAMBIOS.md.
3. ChatGPT no escribe en tus archivos: te dará el archivo actualizado y la entrada de CAMBIOS.md. Guárdalos tú en la carpeta y vuelve a subirlos.

## Comprobación
Pide un cambio («a partir de ahora, …») y comprueba que queda en su archivo y en CAMBIOS.md. Luego rechaza un resultado, corrígelo en un reintento y comprueba que la corrección también queda anotada.

${b ? `${red(ambitoSection(b))}\n` : ''}${environmentGuide(b?.scope ?? null)}`);
}

const SCRIPT = String.raw`#!/usr/bin/env node
// Añade una entrada al final de CAMBIOS.md (sin dependencias). Uso:
//   node scripts/anotar-cambio.mjs --que "Qué cambió" --motivo "Petición del usuario" --archivo AGENTS.md [--detalle "..."]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const m = /^--(que|motivo|archivo|detalle)$/.exec(args[i]);
  if (m && i + 1 < args.length) opt[m[1]] = String(args[++i]).replace(/\s+/g, " ").trim();
}
if (!opt.que || !opt.motivo || !opt.archivo) {
  console.error("Faltan datos. Uso: node scripts/anotar-cambio.mjs --que \"...\" --motivo \"...\" --archivo ruta [--detalle \"...\"]");
  process.exit(1);
}
const file = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "CAMBIOS.md");
const fecha = new Date().toISOString().slice(0, 10);
let entry = "\n## " + fecha + " — " + opt.que + "\n- Motivo: " + opt.motivo + "\n- Archivo: " + opt.archivo + "\n";
if (opt.detalle) entry += "- Detalle: " + opt.detalle + "\n";
const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\s+$/, "") + "\n" : "# Cambios\n";
fs.writeFileSync(file, prev + entry, "utf8");
console.log("Anotado en CAMBIOS.md: " + opt.que);
`;

/** Convierte la carpeta portable (revisión adoptada) en el paquete autosuficiente. Determinista para las mismas entradas. */
export function buildPortableBundle(files: PortableFiles, opts: BundleOptions): PortableFiles {
  const name = scrub(opts.agentName.trim()) || 'Agente';
  const date = opts.exportedAt.slice(0, 10);
  const out: PortableFiles = {};
  const b = bundleScope(opts, files['agent.yaml']);
  const red = redactNames(b, opts);
  out['agent.yaml'] = red(files['agent.yaml'] !== undefined ? cleanManifest(files['agent.yaml'], b?.portable) : cleanManifest(toYaml({ name, role: name }), b?.portable));
  const agents = red(scrub(normalizeText(files['AGENTS.md'] ?? `# ${name}`)));
  out['AGENTS.md'] = normalizeText(agents.startsWith(POINTER) ? agents : `${POINTER}\n\n${agents}`);
  out['memory/MEMORY.md'] = normalizeText(red(cleanMemory(name, files['memory/MEMORY.md'])));
  for (const [p, c] of Object.entries(files)) if (allowedPortablePath(p) && (p.startsWith('skills/') || p.startsWith('knowledge/'))) out[p] = normalizeText(red(scrub(c)));
  out['AUTOMEJORA.md'] = automejora(name);
  out['CAMBIOS.md'] = cambios(name, date, opts.changelog);
  out['GUIA.md'] = guia(name, b, red);
  out['scripts/anotar-cambio.mjs'] = SCRIPT;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ---------------------------------------------------------------- EN-007: paquete de un agente externo

const RAW = /\.(py|txt)$/;
const PROGRAMS: [RegExp, string][] = [
  [/soffice|libreoffice/i, 'LibreOffice (orden soffice)'], [/tesseract/i, 'Tesseract OCR'], [/pdftoppm|pdftotext|poppler/i, 'Poppler (pdftoppm o pdftotext)'],
  [/ghostscript|gswin/i, 'Ghostscript'], [/pandoc/i, 'Pandoc']
];
const MODULES: [RegExp, string][] = [
  [/^\s*(?:import|from)\s+fitz\b/m, 'PyMuPDF'], [/^\s*(?:import|from)\s+docx\b/m, 'python-docx'], [/^\s*(?:import|from)\s+PIL\b/m, 'Pillow'],
  [/^\s*(?:import|from)\s+pdfplumber\b/m, 'pdfplumber'], [/^\s*(?:import|from)\s+pypdf\b/m, 'pypdf'], [/^\s*(?:import|from)\s+pytesseract\b/m, 'pytesseract'], [/^\s*(?:import|from)\s+lxml\b/m, 'lxml']
];

/** Rutas genéricas del sistema que citan los .py (únicas, ordenadas, como mucho 20), separadas en Windows y Linux/macOS. */
function systemPathsOf(files: PortableFiles): { win: string[]; unix: string[] } {
  const set = new Set<string>();
  for (const p of Object.keys(files).filter(k => k.endsWith('.py')).sort()) for (const h of findLocalPaths(files[p] ?? '')) if (h.kind === 'system') set.add(h.match.replace(/\\+/g, '\\'));
  const all = [...set].sort().slice(0, 20);
  return { win: all.filter(x => /^[A-Za-z]:/.test(x)), unix: all.filter(x => !/^[A-Za-z]:/.test(x)) };
}

/** GUIA.md del paquete externo. Solo cita rutas que existen en `files` (más los archivos que genera el propio paquete). */
function guiaExterna(name: string, files: PortableFiles, planCount: number): string {
  const keys = Object.keys(files).sort();
  const slugs = [...new Set(keys.map(p => /^skills\/([^/]+)\/SKILL\.md$/.exec(p)?.[1]).filter((s): s is string => !!s))].sort();
  const skills = slugs.map(s => {
    const h = parseSkillHeader(files[`skills/${s}/SKILL.md`] ?? '');
    return {
      slug: s, name: scrub(h.name ?? s), description: scrub(h.description ?? ''),
      scripts: keys.filter(p => p.startsWith(`skills/${s}/scripts/`) && p.endsWith('.py')),
      reqs: keys.filter(p => p.startsWith(`skills/${s}/scripts/`) && /requirements[^/]*\.txt$/i.test(p))
    };
  });
  const mem = keys.filter(p => /^memoria\//i.test(p));
  const ctx = keys.filter(p => /^contexto\//i.test(p));
  const py = keys.filter(p => p.endsWith('.py')).map(p => files[p]).join('\n');
  const programs = PROGRAMS.filter(([re]) => re.test(py)).map(([, n]) => n);
  const modules = MODULES.filter(([re]) => re.test(py)).map(([, n]) => n);
  const sys = systemPathsOf(files);
  const fmtPaths = (xs: string[]) => xs.map(x => `\`${x}\``).join(', ');
  const sysReq = sys.win.length || sys.unix.length
    ? `- Rutas del sistema que citan los scripts (comprueba que existen en tu equipo; ajústalas si tu instalación está en otra carpeta):${sys.win.length ? `\n  - Windows: ${fmtPaths(sys.win)}` : ''}${sys.unix.length ? `\n  - Linux y macOS: ${fmtPaths(sys.unix)}` : ''}\n`
    : '';
  const reqs = skills.flatMap(s => s.reqs);
  const example = skills.flatMap(s => s.scripts)[0] ?? null;
  const memRef = mem.length ? mem.map(p => `\`${p}\``).join(', ') : '`memory/MEMORY.md`';
  const skillList = skills.length
    ? skills.map(s => `- \`skills/${s.slug}/SKILL.md\`: ${s.name}${s.description ? `. ${s.description}` : ''}${s.scripts.length ? `\n  Scripts: ${s.scripts.map(p => `\`${p}\``).join(', ')}` : ''}${s.reqs.length ? `\n  Paquetes declarados: ${s.reqs.map(p => `\`${p}\``).join(', ')}` : ''}`).join('\n')
    : '- Este agente no tiene habilidades con scripts. Sigue `AGENTS.md`: los pasos de conversión de abajo solo sirven si le añades una habilidad con scripts.';
  return normalizeText(`# Guía: usar a ${name} fuera de Portal IA

Paquete ${PORTABLE_BUNDLE_SCHEMA}. Contiene \`AGENTS.md\` (instrucciones), \`agent.yaml\` (identidad), ${ctx.length ? `${ctx.map(p => `\`${p}\``).join(', ')} (contexto), ` : ''}la memoria (${memRef}, con lo aprendido desde el chat y en reintentos verificados), las habilidades con sus scripts, \`PLANES.json\` (planes que ya funcionaron), \`AUTOMEJORA.md\` (reglas de automejora), \`CAMBIOS.md\` (historial) y \`scripts/anotar-cambio.mjs\` (anota un cambio; solo necesita Node).

No incluye dependencias instaladas, programas externos, documentos convertidos ni la bandeja de entrada.

## Habilidades y scripts
${skillList}

## Procesar un PDF
1. Calcula su SHA-256. En Linux: \`sha256sum documento.pdf\`. En macOS: \`shasum -a 256 documento.pdf\`. En Windows: \`Get-FileHash documento.pdf -Algorithm SHA256\`.
2. Busca ese valor, en minúsculas, en el campo «sha256» de \`PLANES.json\` (${planCount} plan(es) probados). Si coincide, usa su «script» y sus «args». Sustituye {entrada} por el PDF, {salida} por el Word que vas a crear, {informe} por un archivo .json nuevo y {trabajo} por una carpeta temporal vacía.
3. Si no coincide, elige el script y las opciones según el SKILL.md de la habilidad. Los dos primeros argumentos son siempre el PDF de entrada y el Word de salida.
4. Ejecuta el script desde la carpeta del paquete${example ? `, por ejemplo: \`python ${example} documento.pdf documento.docx\`` : ''} (en Windows, \`py -3\` en lugar de \`python\`).
5. Aplica las comprobaciones que describe el SKILL.md de la habilidad y, además, estas: el Word se abre; el texto es editable (no hay páginas convertidas en imagen); tiene las mismas páginas; no falta ni se duplica contenido; las tablas son tablas. El Portal usaba su propia herramienta de comprobación, que no se incluye: hazlas tú y di cuáles no pudiste comprobar.
6. Si falla alguna comprobación o el script termina con error, reintenta con otro plan (otro script u otras opciones del SKILL.md). No repitas un plan que ya falló con ese PDF. Tras tres intentos sin éxito, informa de que el documento necesita intervención y explica el motivo.
7. Anota lo aprendido según \`AUTOMEJORA.md\`: si un plan nuevo pasó, añádelo a \`PLANES.json\`; el aprendizaje va a ${memRef} como «sin verificar» y el cambio a \`CAMBIOS.md\` (si puedes ejecutar órdenes: \`node scripts/anotar-cambio.mjs --que "..." --motivo "Corrección tras un reintento" --archivo PLANES.json\`).

## Procesar un ZIP con PDFs
1. Descomprímelo en una carpeta nueva y vacía: \`unzip lote.zip -d lote\` o, en Windows, \`Expand-Archive lote.zip -DestinationPath lote\`.
2. Antes de convertir, revisa la lista: excluye (y anota como excluido, con el motivo) lo que no sea .pdf; no extraigas entradas con «..» ni rutas absolutas. Si el ZIP supera los topes del Portal (500 PDF, 100 MB por PDF o 4 GB descomprimido), recházalo entero y pide dividirlo; nunca lo cortes en silencio.
3. Procesa cada PDF con los pasos de «Procesar un PDF», cada uno con su propio SHA-256.
4. Entrega un resumen por documento (aprobado, aprobado tras reintento o necesita intervención, con el motivo) y otro del lote. No des por convertido un documento que no pasó las comprobaciones.

## Requisitos de la plataforma
- Python 3 para ejecutar los scripts (compruébalo con \`python --version\`).
- Paquetes de Python: ${reqs.length ? reqs.map(p => `\`pip install -r ${p}\``).join(' · ') : 'los scripts no declaran un requirements.txt'}${modules.length ? `. Según sus imports, usan (orientativo): ${modules.join(', ')}` : ''}.
- Programas externos: ${programs.length ? `${programs.join(', ')} (aparecen en el texto de los scripts). Instálalos tú; sin ellos, los scripts que los usan fallarán` : 'no se detectó ninguno en los scripts'}.
${sysReq}- Node solo para \`scripts/anotar-cambio.mjs\` (opcional).

## Dónde no se pueden ejecutar scripts
En ChatGPT sin intérprete de código, o en cualquier entorno sin Python, el agente no puede convertir el documento. Debe decirlo con claridad, explicar los pasos de esta guía para que los ejecutes en tu equipo y no prometer ni simular un resultado. Con intérprete pero sin los programas externos, avisa de qué scripts no podrán funcionar antes de intentarlo.

## Fallos conocidos y cómo se resolvieron
Las entradas de ${memRef} que vienen de reintentos verificados describen el síntoma, la causa y el plan que lo resolvió. Léelas antes de reintentar y no repitas un plan que la memoria marca como fallido.

## Claude Code web y Cowork
Descomprime el paquete en un repositorio o en una carpeta de trabajo y empieza con: «Lee AGENTS.md, AUTOMEJORA.md y GUIA.md y síguelos». Revisa los cambios en los archivos y en \`CAMBIOS.md\`.

## ChatGPT
Pega \`AGENTS.md\` y \`AUTOMEJORA.md\` en sus instrucciones y adjunta el resto de archivos. ChatGPT no escribe en tus archivos: te dará el archivo actualizado y la entrada de \`CAMBIOS.md\` para que los guardes tú.
`);
}

/**
 * Paquete de un agente EXTERNO a partir de su revisión adoptada (lo que admite isIdentityPath). Los scripts (*.py, *.txt)
 * se copian TAL CUAL, sin normalizar ni limpiar; si contienen un secreto, una ruta local o un dato interno, validatePortableBundle
 * lo detecta y la exportación se niega (409). Genera agent.yaml y memory/MEMORY.md mínimos para que el ZIP se pueda reimportar
 * (HU-183), PLANES.json, AUTOMEJORA.md, CAMBIOS.md, GUIA.md y scripts/anotar-cambio.mjs. Determinista para las mismas entradas.
 */
export function buildExternalBundle(snapshot: PortableFiles, opts: ExternalBundleOptions): PortableFiles {
  const name = scrub(opts.agentName.trim()) || 'Agente';
  const date = opts.exportedAt.slice(0, 10);
  const out: PortableFiles = {};
  const b = bundleScope(opts, snapshot['agent.yaml']);
  const red = redactNames(b, opts);
  for (const [p, c] of Object.entries(snapshot)) {
    if (!isIdentityPath(p) || p === 'AGENTS.md') continue;
    out[p] = RAW.test(p) ? c : normalizeText(red(scrub(c)));
  }
  const agents = normalizeText(red(scrub(snapshot['AGENTS.md'] ?? `# ${name}`)));
  out['AGENTS.md'] = agents.startsWith(POINTER) ? agents : normalizeText(`${POINTER}\n${GUIA_POINTER}\n\n${agents}`);
  const manifest: Record<string, string> = { name, role: scrub(opts.role?.trim() || name) };
  if (opts.summary?.trim()) manifest.summary = scrub(opts.summary.trim());
  out['agent.yaml'] = red(cleanManifest(toYaml(manifest), b?.portable));
  const mem = Object.keys(out).filter(p => /^memoria\//i.test(p)).sort();
  out['memory/MEMORY.md'] = memoryToMarkdown(name, mem.length ? [{
    id: 'm1', title: 'Dónde está la memoria', text: `La memoria completa del agente (también lo aprendido desde el chat y en reintentos verificados) está en: ${mem.join(', ')}.`,
    verifiedAt: date, verifiedBy: 'el propietario', source: 'Aprendido en el Portal'
  }] : []);
  const scripts = new Set(Object.keys(out).filter(p => /^skills\/[^/]+\/scripts\/[^/]+\.py$/.test(p)));
  const seen = new Set<string>();
  const plans = opts.provenPlans
    .filter(x => scripts.has(x.script) && !seen.has(x.sha256.toLowerCase()) && !!seen.add(x.sha256.toLowerCase()))
    .map(x => ({ sha256: x.sha256.toLowerCase(), skill: x.skill, script: x.script, args: [...x.args], reason: x.reason }))
    .sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
  out['PLANES.json'] = `${JSON.stringify({
    schemaVersion: 1,
    nota: 'El SHA-256 identifica el PDF. Un plan que ya funcionó no garantiza el mismo resultado: aplica siempre las comprobaciones de GUIA.md.',
    marcadores: { '{entrada}': 'PDF de entrada', '{salida}': 'Word de salida', '{informe}': 'informe .json (opcional)', '{trabajo}': 'carpeta temporal vacía' },
    planes: plans
  }, null, 2)}\n`;
  out['AUTOMEJORA.md'] = automejora(name, { editable: 'AGENTS.md, contexto/, memoria/ o la carpeta de su habilidad en skills/', memory: mem[0] ?? 'memory/MEMORY.md', plans: true });
  out['CAMBIOS.md'] = cambios(name, date, opts.changelog);
  out['GUIA.md'] = b ? normalizeText(`${guiaExterna(name, out, plans.length)}\n${red(ambitoSection(b))}`) : guiaExterna(name, out, plans.length);
  out['scripts/anotar-cambio.mjs'] = SCRIPT;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Problemas que impiden exportar el paquete (lista vacía = se puede exportar). `forbidden`: textos que no deben aparecer (p. ej. el id del agente). */
const KIND_LABEL: Record<LocalPathKind, string> = {
  profile: 'tu perfil de usuario', source: 'la carpeta original del agente', 'portal-data': 'los datos del Portal',
  other: 'otra unidad, red o carpeta del equipo', system: 'ruta del sistema fuera de un script'
};
const GENERATED = new Set([...BUNDLE_EXTRA, 'PLANES.json', 'agent.yaml', 'memory/MEMORY.md']);
function localProblem(p: string, h: LocalPathHit): BundleProblem {
  const raw = RAW.test(p);
  const reason = `contiene una ruta local (${KIND_LABEL[h.kind]}). ${raw ? 'Cámbiala por una ruta relativa o por un argumento del script.' : 'Quítala o cámbiala por una ruta relativa.'}`;
  const pr: BundleProblem = { path: p, line: h.line, snippet: h.snippet, reason, message: `Línea ${h.line}: «${h.snippet}» — ${reason}` };
  if (/\.(py|txt|md)$/.test(p) && !GENERATED.has(p)) pr.hint = `Puedes pedirle al agente en su chat que cambie la línea ${h.line} de ${p} (automejora con copia y Deshacer).`;
  return pr;
}
function lineOf(c: string, src: string): number {
  const m = new RegExp(src).exec(c);
  return m ? c.slice(0, m.index).split('\n').length : 0;
}

/**
 * HU-211 · En la Edición, una ruta privada de un solo nivel («/work», «/app», «C:/x») no identifica al usuario y coincide con
 * rutas que el código cita a propósito (destinos de montaje del contenedor del sandbox): solo cuentan las de 2+ niveles.
 */
function editionPrivate(list: PrivNorm[]): PrivNorm[] {
  return list.filter(pv => pv.norm.split('/').filter(Boolean).length >= 2);
}

/** ¿La ruta encontrada es (o está dentro de) una de las rutas privadas indicadas? */
function isPrivateMatch(m: string, privs: PrivNorm[]): boolean {
  const n = normPath(m);
  return privs.some(pv => n === pv.norm || n.startsWith(`${pv.norm}/`));
}

export function validatePortableBundle(files: PortableFiles, opts: { forbidden?: string[]; limits?: BundleLimits; privatePaths?: PrivatePath[]; profile?: BundleProfile } = {}): BundleProblem[] {
  const lim = opts.limits ?? PORTABLE_LIMITS;
  const edition = opts.profile === 'edition';
  const privs = edition ? editionPrivate(privateList(opts.privatePaths)) : [];
  const out: BundleProblem[] = [];
  if (!edition) for (const r of REQUIRED) if (files[r] === undefined) out.push({ path: r, message: 'Falta en el paquete.' });
  const forbidden = (opts.forbidden ?? []).filter(f => f && f.length >= 4).map(f => f.toLowerCase());
  let total = 0;
  for (const [p, c] of Object.entries(files)) {
    const size = utf8Bytes(c); total += size;
    if (!edition && !allowedBundlePath(p)) { out.push({ path: p, message: 'Ruta no permitida en el paquete.' }); continue; }
    if (size > lim.fileBytes) out.push({ path: p, message: `Archivo demasiado grande (${Math.ceil(size / 1024)} KB; máx. ${lim.fileBytes / 1024} KB).` });
    const secret = findSecret(c); if (secret) out.push({ path: p, message: `Contiene lo que parece una ${secret}: las credenciales nunca salen del Portal.` });
    const uuidLine = lineOf(c, UUID); if (uuidLine) out.push({ path: p, line: uuidLine, message: 'Contiene un identificador interno (UUID).' });
    // Rutas: las genéricas del sistema solo se admiten en los scripts copiados tal cual (.py/.txt) y en GUIA.md; en el resto,
    // las de unidad de Windows siguen bloqueando como antes. Un problema por línea (máx. 5 por archivo y un resumen).
    const allowSystem = RAW.test(p) || p === 'GUIA.md';
    const byLine = new Map<number, LocalPathHit>();
    for (const h of findLocalPaths(c, { privatePaths: opts.privatePaths })) {
      // Edición: el código cita rutas genéricas a propósito (/tmp, data/workspaces/<slug>); solo bloquean el perfil del
      // usuario y las rutas privadas reales (carpeta de origen y de datos) indicadas en privatePaths.
      const blocks = edition
        ? h.kind === 'profile' || isPrivateMatch(h.match, privs)
        : h.kind !== 'system' || (!allowSystem && /^[A-Za-z]:/.test(h.match));
      if (blocks && !byLine.has(h.line)) byLine.set(h.line, h);
    }
    const hits = [...byLine.values()];
    for (const h of hits.slice(0, 5)) out.push(localProblem(p, h));
    if (hits.length > 5) out.push({ path: p, message: `Y ${hits.length - 5} línea(s) más con rutas locales o de datos del Portal en este archivo.` });
    const apiLines = edition ? [] : [lineOf(c, API), lineOf(c, TABLES)].filter(n => n > 0);
    if (apiLines.length) out.push({ path: p, line: Math.min(...apiLines), message: 'Contiene rutas o tablas internas del Portal.' });
    const low = c.toLowerCase(); if (forbidden.some(f => low.includes(f))) out.push({ path: p, message: 'Contiene un dato interno del agente (su id en el Portal).' });
  }
  const maxFiles = edition ? lim.files : lim.files + BUNDLE_EXTRA.length + 1;
  if (Object.keys(files).length > maxFiles) out.push({ path: '', message: `Demasiados archivos en el paquete (máx. ${maxFiles}).` });
  if (total > lim.totalBytes) out.push({ path: '', message: `El paquete es demasiado grande (${Math.ceil(total / 1024)} KB; máx. ${lim.totalBytes / 1024} KB).` });
  return out;
}

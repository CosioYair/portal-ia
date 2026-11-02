/**
 * Contrato de carpeta portable de un agente: `portal-ia/agent@1` (docs/agentes-portables.md).
 *
 *   agent.yaml            identidad y preferencias (id estable, nombre, papel, departamento, arnés preferido…)
 *   AGENTS.md             instrucciones (convención AGENTS.md: la leen personas, Codex y Claude Code)
 *   skills/<s>/SKILL.md   habilidades (frontmatter name/description + cuerpo, como las Agent Skills)
 *   memory/MEMORY.md      SOLO aprendizaje verificado por el propietario, cada entrada con su procedencia
 *   knowledge/<k>.md      referencias aprobadas
 *
 * Funciones puras (sin sistema de archivos): las usan el servidor (escribir, leer, importar, detectar cambios) y la web
 * (vista previa). Nunca hay credenciales en una carpeta portable: el contenido que parezca un secreto se rechaza.
 * Los permisos que declare una carpeta son una PETICIÓN: solo el propietario los concede en el Portal.
 */

export const PORTABLE_AGENT_SCHEMA = 'portal-ia/agent@1';
export type AgentAutonomy = 'ask' | 'within_scope';
export type HarnessId = 'claude-code' | 'claude-code-terminal' | 'codex' | 'api';

export interface PortableAgentManifest {
  schema: typeof PORTABLE_AGENT_SCHEMA;
  /** Identificador estable (el de la fila del agente): no depende del nombre de la carpeta. */
  id: string;
  name: string;
  role: string;
  department: string | null;
  initials: string;
  summary: string;
  responsibilities: string[];
  deliverables: string[];
  capabilities: string[];
  harness: { preferred: HarnessId; model: string; effort: 'low' | 'medium' | 'high' };
  permissions: { tools: string[]; autonomy: AgentAutonomy };
  createdAt: string;
}
export interface PortableSkill { slug: string; name: string; description: string; body: string }
export interface MemoryEntry { id: string; title: string; text: string; verifiedAt: string; verifiedBy: string; source: string }
export interface PortableKnowledge { slug: string; title: string; body: string }
export interface PortableAgentDefinition {
  manifest: PortableAgentManifest;
  instructions: string;
  skills: PortableSkill[];
  memory: MemoryEntry[];
  knowledge: PortableKnowledge[];
}
/** Archivos de la carpeta: ruta relativa con «/» → texto (LF, sin BOM). */
export type PortableFiles = Record<string, string>;

export const PORTABLE_LIMITS = { files: 80, fileBytes: 64 * 1024, totalBytes: 512 * 1024 } as const;
const SLUG = '[a-z0-9][a-z0-9-]{0,63}';
const ALLOWED = [
  /^agent\.yaml$/, /^AGENTS\.md$/, new RegExp(`^skills/${SLUG}/SKILL\\.md$`), /^memory\/MEMORY\.md$/, new RegExp(`^knowledge/${SLUG}\\.md$`)
];
/** ¿Es una ruta permitida dentro de una carpeta portable? (lista blanca: nada de rutas absolutas, «..», ni otros tipos). */
export function allowedPortablePath(rel: string): boolean { return ALLOWED.some(r => r.test(rel)); }

export const slugify = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'agente';
/** Texto normalizado para comparar y guardar: sin BOM, saltos LF y un único salto final. */
export const normalizeText = (s: string) => s.replace(/^\uFEFF/, '').normalize('NFC').replace(/\r\n?/g, '\n').replace(/\s+$/, '') + '\n';

// ---------------------------------------------------------------- Secretos

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/, 'clave de Anthropic'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, 'clave de OpenAI'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'token de GitHub'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'clave de AWS'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'clave privada'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'token de Slack'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'clave de Google'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'token JWT'],
  [/\b(refresh_token|access_token|id_token|api_key|apikey|client_secret)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/i, 'credencial (token o clave)']
];
/** Primer contenido con aspecto de credencial (para rechazarlo), o null. */
export function findSecret(text: string): string | null {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;
  return null;
}

// ---------------------------------------------------------------- YAML (subconjunto estricto y documentado)

type Y = string | number | boolean | null | Y[] | { [k: string]: Y };
const RESERVED = /^(true|false|null|~|yes|no|on|off)$/i;
const NUMERIC = /^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
function needsQuotes(s: string): boolean {
  return s === '' || s !== s.trim() || /[\n\r\t"\\]/.test(s) || /^[-?:,[\]{}#&*!|>'%@`]/.test(s) || /:(\s|$)/.test(s) || /\s#/.test(s) || RESERVED.test(s) || NUMERIC.test(s);
}
const scalarOut = (v: string | number | boolean | null) => v === null ? 'null' : typeof v === 'string' ? (needsQuotes(v) ? JSON.stringify(v) : v) : String(v);

/** Serializa mapas de bloque, listas y escalares. Las cadenas ambiguas van entre comillas dobles (escape JSON). */
export function toYaml(value: { [k: string]: Y }, indent = 0): string {
  const pad = ' '.repeat(indent); const lines: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) throw new Error(`Clave YAML no admitida: ${k}`);
    if (Array.isArray(v)) {
      if (!v.length) { lines.push(`${pad}${k}: []`); continue; }
      lines.push(`${pad}${k}:`);
      for (const item of v) {
        if (item !== null && typeof item === 'object') throw new Error('Solo listas de escalares');
        lines.push(`${pad}  - ${scalarOut(item)}`);
      }
    } else if (v !== null && typeof v === 'object') {
      if (!Object.keys(v).length) { lines.push(`${pad}${k}: {}`); continue; }
      lines.push(`${pad}${k}:`); lines.push(toYaml(v, indent + 2).replace(/\n$/, ''));
    } else lines.push(`${pad}${k}: ${scalarOut(v)}`);
  }
  return lines.join('\n') + '\n';
}

export class YamlError extends Error { constructor(msg: string, public line: number) { super(`agent.yaml, línea ${line}: ${msg}`); } }

function parseScalar(raw: string, line: number): string | number | boolean | null {
  const s = raw.trim();
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError('comillas dobles sin cerrar', line);
    try { return JSON.parse(s); } catch { throw new YamlError('cadena entre comillas dobles no válida', line); }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError('comillas simples sin cerrar', line);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  const plain = s.replace(/\s+#.*$/, '').trim();
  if (plain === '' || plain === '~' || plain === 'null') return null;
  if (plain === 'true') return true; if (plain === 'false') return false;
  if (NUMERIC.test(plain)) return Number(plain.replace(/_/g, ''));
  if (/^[[{]/.test(plain) && plain !== '[]' && plain !== '{}') throw new YamlError('colecciones en línea no admitidas (usa una lista de bloque)', line);
  return plain;
}

/**
 * Lee el subconjunto que escribe toYaml (y lo que una persona escribiría a mano en ese estilo): mapas de bloque anidados,
 * listas de escalares («- x»), `[]`, `{}`, comentarios de línea, escalares planos o entre comillas. Nada de anclas, etiquetas,
 * bloques literales ni colecciones en línea: lo demás es un error con su número de línea (nunca se adivina).
 */
export function parseYaml(text: string): { [k: string]: Y } {
  const lines = normalizeText(text).split('\n').map((l, i) => ({ raw: l, n: i + 1 }))
    .filter(l => l.raw.trim() !== '' && !l.raw.trimStart().startsWith('#'));
  for (const l of lines) if (/^\s*\t/.test(l.raw)) throw new YamlError('tabuladores no admitidos en la sangría', l.n);
  let i = 0;
  const indentOf = (s: string) => s.length - s.trimStart().length;
  function block(indent: number): { [k: string]: Y } | Y[] {
    const first = lines[i];
    if (first.raw.trimStart().startsWith('- ') || first.raw.trim() === '-') {
      const arr: Y[] = [];
      while (i < lines.length && indentOf(lines[i].raw) === indent && /^-(\s|$)/.test(lines[i].raw.trimStart())) {
        const item = lines[i].raw.trimStart().slice(1).trim();
        if (/^[A-Za-z_][\w-]*:(\s|$)/.test(item)) throw new YamlError('listas de mapas no admitidas', lines[i].n);
        arr.push(parseScalar(item, lines[i].n)); i++;
      }
      return arr;
    }
    const obj: { [k: string]: Y } = {};
    while (i < lines.length && indentOf(lines[i].raw) === indent) {
      const { raw, n } = lines[i];
      const m = raw.trimStart().match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
      if (!m) throw new YamlError(`se esperaba «clave: valor»`, n);
      if (Object.prototype.hasOwnProperty.call(obj, m[1])) throw new YamlError(`clave repetida: ${m[1]}`, n);
      i++;
      const rest = (m[2] ?? '').replace(/^#.*$/, '').trim();
      if (rest === '[]') obj[m[1]] = [];
      else if (rest === '{}') obj[m[1]] = {};
      else if (rest !== '') obj[m[1]] = parseScalar(rest, n);
      else if (i < lines.length && (indentOf(lines[i].raw) > indent || (indentOf(lines[i].raw) === indent && /^-(\s|$)/.test(lines[i].raw.trimStart())))) obj[m[1]] = block(indentOf(lines[i].raw));
      else obj[m[1]] = null;
    }
    if (i < lines.length && indentOf(lines[i].raw) > indent) throw new YamlError('sangría inesperada', lines[i].n);
    return obj;
  }
  if (!lines.length) return {};
  if (indentOf(lines[0].raw) !== 0) throw new YamlError('el documento debe empezar sin sangría', lines[0].n);
  const out = block(0);
  if (Array.isArray(out)) throw new YamlError('el documento debe ser un mapa', 1);
  if (i < lines.length) throw new YamlError('contenido inesperado', lines[i].n);
  return out;
}

// ---------------------------------------------------------------- SKILL.md y MEMORY.md

/** SKILL.md: frontmatter `name`/`description` (formato de Agent Skills) y el cuerpo en markdown. */
export function skillToMarkdown(s: PortableSkill): string {
  return normalizeText(`---\n${toYaml({ name: s.name, description: s.description })}---\n\n${s.body.trim()}`);
}
export function parseSkill(slug: string, text: string): PortableSkill {
  const t = normalizeText(text);
  const m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { slug, name: slug, description: '', body: t.trim() };
  const fm = parseYaml(m[1]);
  return { slug, name: typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : slug, description: typeof fm.description === 'string' ? fm.description.trim() : '', body: m[2].trim() };
}

export function memoryToMarkdown(agentName: string, entries: MemoryEntry[]): string {
  const head = `# Memoria verificada de ${agentName}\n\nSolo aprendizaje que el propietario ha verificado. Cada entrada indica de dónde sale.\n`;
  const body = entries.map(e => `\n## ${e.title.replace(/\n/g, ' ')}\n- id: ${e.id}\n- verificada: ${e.verifiedAt} por ${e.verifiedBy}\n- origen: ${e.source.replace(/\n/g, ' ')}\n\n${e.text.trim()}\n`).join('');
  return normalizeText(head + body);
}
export function parseMemory(text: string): MemoryEntry[] {
  const parts = normalizeText(text).split(/\n(?=## )/).slice(1);
  return parts.map(p => {
    const [titleLine, ...rest] = p.split('\n');
    const meta: Record<string, string> = {}; let k = 0;
    for (; k < rest.length; k++) { const m = rest[k].match(/^- (id|verificada|origen): (.*)$/); if (!m) break; meta[m[1]] = m[2]; }
    const ver = (meta.verificada ?? '').match(/^(\S+) por (.+)$/);
    return { id: meta.id ?? '', title: titleLine.replace(/^##\s*/, '').trim(), text: rest.slice(k).join('\n').trim(), verifiedAt: ver?.[1] ?? '', verifiedBy: ver?.[2] ?? '', source: meta.origen ?? '' };
  }).filter(e => e.title || e.text);
}

// ---------------------------------------------------------------- Carpeta completa

export function definitionToFiles(d: PortableAgentDefinition): PortableFiles {
  const m = d.manifest;
  const files: PortableFiles = {
    'agent.yaml': normalizeText(`# Agente portable de Portal IA (${PORTABLE_AGENT_SCHEMA}). Sin credenciales: los permisos los concede el propietario en el Portal.\n` + toYaml({
      schema: m.schema, id: m.id, name: m.name, role: m.role, department: m.department, initials: m.initials, summary: m.summary,
      responsibilities: m.responsibilities, deliverables: m.deliverables, capabilities: m.capabilities,
      harness: { preferred: m.harness.preferred, model: m.harness.model, effort: m.harness.effort },
      permissions: { tools: m.permissions.tools, autonomy: m.permissions.autonomy },
      created: m.createdAt
    })),
    'AGENTS.md': normalizeText(d.instructions.trim() ? d.instructions : `# ${m.name}\n\n${m.summary || m.role}`),
    'memory/MEMORY.md': memoryToMarkdown(m.name, d.memory)
  };
  for (const s of d.skills) files[`skills/${s.slug}/SKILL.md`] = skillToMarkdown(s);
  for (const k of d.knowledge) files[`knowledge/${k.slug}.md`] = normalizeText(`# ${k.title}\n\n${k.body.trim()}`);
  return files;
}

const strList = (v: Y | undefined): string[] => Array.isArray(v) ? v.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map(x => String(x).trim()).filter(Boolean) : [];
const str = (v: Y | undefined, d = ''): string => typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : d;
const HARNESSES: HarnessId[] = ['claude-code', 'claude-code-terminal', 'codex', 'api'];

/**
 * Lee una carpeta (sus archivos ya cargados). Devuelve la definición y los problemas encontrados; un problema con
 * `blocking` impide adoptarla (falta agent.yaml, YAML no válido, esquema desconocido, secretos, rutas no permitidas…).
 */
export function filesToDefinition(files: PortableFiles): { definition: PortableAgentDefinition | null; problems: { path: string; message: string; blocking: boolean }[] } {
  const problems: { path: string; message: string; blocking: boolean }[] = [];
  let total = 0;
  for (const [p, c] of Object.entries(files)) {
    total += c.length;
    if (!allowedPortablePath(p)) problems.push({ path: p, message: 'Archivo no admitido en una carpeta de agente (se ignora).', blocking: false });
    else if (c.length > PORTABLE_LIMITS.fileBytes) problems.push({ path: p, message: `Archivo demasiado grande (máx. ${PORTABLE_LIMITS.fileBytes / 1024} KB).`, blocking: true });
    const secret = findSecret(c); if (secret) problems.push({ path: p, message: `Contiene lo que parece una ${secret}: las credenciales nunca van en la carpeta de un agente.`, blocking: true });
  }
  if (Object.keys(files).length > PORTABLE_LIMITS.files) problems.push({ path: '', message: `Demasiados archivos (máx. ${PORTABLE_LIMITS.files}).`, blocking: true });
  if (total > PORTABLE_LIMITS.totalBytes) problems.push({ path: '', message: `La carpeta es demasiado grande (máx. ${PORTABLE_LIMITS.totalBytes / 1024} KB).`, blocking: true });
  const yaml = files['agent.yaml'];
  if (yaml === undefined) { problems.push({ path: 'agent.yaml', message: 'Falta agent.yaml.', blocking: true }); return { definition: null, problems }; }
  let y: { [k: string]: Y };
  try { y = parseYaml(yaml); } catch (e) { problems.push({ path: 'agent.yaml', message: (e as Error).message, blocking: true }); return { definition: null, problems }; }
  if (y.schema !== PORTABLE_AGENT_SCHEMA) problems.push({ path: 'agent.yaml', message: `Esquema desconocido «${str(y.schema) || '(vacío)'}»: se esperaba ${PORTABLE_AGENT_SCHEMA}.`, blocking: true });
  const name = str(y.name); if (name.length < 2) problems.push({ path: 'agent.yaml', message: 'Falta el nombre (name).', blocking: true });
  const role = str(y.role); if (role.length < 2) problems.push({ path: 'agent.yaml', message: 'Falta el papel (role).', blocking: true });
  const h = (y.harness && typeof y.harness === 'object' && !Array.isArray(y.harness)) ? y.harness : {};
  const pm = (y.permissions && typeof y.permissions === 'object' && !Array.isArray(y.permissions)) ? y.permissions : {};
  const preferred = HARNESSES.includes(str(h.preferred) as HarnessId) ? str(h.preferred) as HarnessId : 'claude-code';
  if (h.preferred && preferred !== h.preferred) problems.push({ path: 'agent.yaml', message: `Arnés desconocido «${str(h.preferred)}»: se usará ${preferred}.`, blocking: false });
  const effort = ['low', 'medium', 'high'].includes(str(h.effort)) ? str(h.effort) as 'low' | 'medium' | 'high' : 'medium';
  const manifest: PortableAgentManifest = {
    schema: PORTABLE_AGENT_SCHEMA, id: str(y.id), name, role, department: str(y.department) || null,
    initials: (str(y.initials) || name.split(/\s+/).map(w => w[0] ?? '').join('')).slice(0, 2).toUpperCase(), summary: str(y.summary),
    responsibilities: strList(y.responsibilities).slice(0, 30), deliverables: strList(y.deliverables).slice(0, 30), capabilities: strList(y.capabilities).slice(0, 12),
    harness: { preferred, model: str(h.model), effort },
    permissions: { tools: strList(pm.tools), autonomy: str(pm.autonomy) === 'within_scope' ? 'within_scope' : 'ask' },
    createdAt: str(y.created)
  };
  const skills: PortableSkill[] = []; const knowledge: PortableKnowledge[] = [];
  for (const [p, c] of Object.entries(files)) {
    const sm = p.match(/^skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md$/);
    if (sm) { try { skills.push(parseSkill(sm[1], c)); } catch (e) { problems.push({ path: p, message: (e as Error).message.replace('agent.yaml', 'SKILL.md'), blocking: true }); } }
    const km = p.match(/^knowledge\/([a-z0-9][a-z0-9-]*)\.md$/);
    if (km) { const t = normalizeText(c); const title = t.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? km[1]; knowledge.push({ slug: km[1], title, body: t.replace(/^#\s+.+\n+/, '').trim() }); }
  }
  skills.sort((a, b) => a.slug.localeCompare(b.slug)); knowledge.sort((a, b) => a.slug.localeCompare(b.slug));
  const instructions = files['AGENTS.md'] !== undefined ? normalizeText(files['AGENTS.md']).trim() : '';
  const memory = files['memory/MEMORY.md'] !== undefined ? parseMemory(files['memory/MEMORY.md']) : [];
  return { definition: { manifest, instructions, skills, memory, knowledge }, problems };
}

/** Diferencias legibles entre dos versiones de la carpeta (por archivo; líneas añadidas/quitadas acotadas). */
export function diffFiles(before: PortableFiles, after: PortableFiles): { path: string; change: 'added' | 'removed' | 'modified'; added: string[]; removed: string[] }[] {
  const out: { path: string; change: 'added' | 'removed' | 'modified'; added: string[]; removed: string[] }[] = [];
  for (const p of Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()) {
    const a = before[p]; const b = after[p];
    if (a === b) continue;
    const la = a === undefined ? [] : normalizeText(a).split('\n'); const lb = b === undefined ? [] : normalizeText(b).split('\n');
    const sa = new Set(la); const sb = new Set(lb);
    out.push({ path: p, change: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified', added: lb.filter(l => !sa.has(l) && l.trim()).slice(0, 60), removed: la.filter(l => !sb.has(l) && l.trim()).slice(0, 60) });
  }
  return out;
}

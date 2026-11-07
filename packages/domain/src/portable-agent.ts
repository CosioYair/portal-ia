/**
 * Contrato de carpeta portable de un agente: `portal-ia/agent@1` (docs/agentes-portables.md).
 *
 *   agent.yaml            identidad y preferencias (id estable, nombre, papel, departamento, arnés preferido…)
 *   AGENTS.md             instrucciones (convención AGENTS.md: la leen personas, Codex y Claude Code)
 *   skills/<s>/SKILL.md   habilidades (frontmatter name/description + cuerpo, como las Agent Skills)
 *   memory/MEMORY.md      SOLO aprendizaje verificado por el propietario, cada entrada con su procedencia
 *   knowledge/<k>.md      referencias aprobadas
 *   CAMBIOS.md            registro de cambios del agente (lo escribe quien lo edite fuera; opcional)
 *
 * Funciones puras (sin sistema de archivos): las usan el servidor (escribir, leer, importar, detectar cambios) y la web
 * (vista previa). Nunca hay credenciales en una carpeta portable: el contenido que parezca un secreto se rechaza.
 * Los permisos que declare una carpeta son una PETICIÓN: solo el propietario los concede en el Portal.
 */

import { CONTEXT_SCOPE_VALUES, contextScopeOptions } from './types.ts';
import type { AgentContextScope, ContextScopeOption } from './types.ts';
import { validateAgentName } from './agent-instructions.ts';

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
  /**
   * EN-015 · Nombre propio (`personal_name` en agent.yaml), separado del puesto (`name`). Es opcional: sin él no se
   * escribe la clave y agent.yaml queda igual que antes. Al importar, uno no válido se descarta con un aviso (no bloquea).
   */
  personalName?: string | undefined;
  /**
   * EN-014 · Ámbito (`context_scope` en agent.yaml). Es opcional: una carpeta o un ZIP sin él sigue siendo válido y el
   * ámbito queda sin definir. Si aparece, debe tener al menos una opción válida.
   */
  contextScope?: PortableContextScope | undefined;
  harness: { preferred: HarnessId; model: string; effort: import('./types.ts').ReasoningEffort };
  permissions: { tools: string[]; autonomy: AgentAutonomy };
  createdAt: string;
}
/**
 * Ámbito tal como viaja en agent.yaml: las opciones y los nombres. `project_name` solo se escribe si Proyecto está
 * marcado y `company_name` solo si lo está Empresa; con solo General no se escribe ninguno de los dos.
 */
export interface PortableContextScope { options: ContextScopeOption[]; projectName: string | null; companyName: string | null }
export interface PortableSkill { slug: string; name: string; description: string; body: string }
export interface MemoryEntry { id: string; title: string; text: string; verifiedAt: string; verifiedBy: string; source: string }
export interface PortableKnowledge { slug: string; title: string; body: string }
export interface PortableAgentDefinition {
  manifest: PortableAgentManifest;
  instructions: string;
  skills: PortableSkill[];
  memory: MemoryEntry[];
  knowledge: PortableKnowledge[];
  /** CAMBIOS.md (si existe): se conserva tal cual entre revisiones. */
  changelog?: string | undefined;
}
/** Archivos de la carpeta: ruta relativa con «/» → texto (LF, sin BOM). */
export type PortableFiles = Record<string, string>;

export const PORTABLE_LIMITS = { files: 80, fileBytes: 64 * 1024, totalBytes: 512 * 1024 } as const;
const SLUG = '[a-z0-9][a-z0-9-]{0,63}';
const ALLOWED = [
  /^agent\.yaml$/, /^AGENTS\.md$/, new RegExp(`^skills/${SLUG}/SKILL\\.md$`), /^memory\/MEMORY\.md$/, new RegExp(`^knowledge/${SLUG}\\.md$`), /^CAMBIOS\.md$/
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
      schema: m.schema, id: m.id, name: m.name, ...(m.personalName?.trim() ? { personal_name: m.personalName.trim() } : {}),
      role: m.role, department: m.department, initials: m.initials, summary: m.summary,
      responsibilities: m.responsibilities, deliverables: m.deliverables, capabilities: m.capabilities,
      ...contextScopeYaml(m.contextScope),
      harness: { preferred: m.harness.preferred, model: m.harness.model, effort: m.harness.effort },
      permissions: { tools: m.permissions.tools, autonomy: m.permissions.autonomy },
      created: m.createdAt
    })),
    'AGENTS.md': normalizeText(d.instructions.trim() ? d.instructions : `# ${m.name}\n\n${m.summary || m.role}`),
    'memory/MEMORY.md': memoryToMarkdown(m.name, d.memory)
  };
  for (const s of d.skills) files[`skills/${s.slug}/SKILL.md`] = skillToMarkdown(s);
  for (const k of d.knowledge) files[`knowledge/${k.slug}.md`] = normalizeText(`# ${k.title}\n\n${k.body.trim()}`);
  if (d.changelog !== undefined && d.changelog.trim()) files['CAMBIOS.md'] = normalizeText(d.changelog);
  return files;
}

const strList = (v: Y | undefined): string[] => Array.isArray(v) ? v.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map(x => String(x).trim()).filter(Boolean) : [];
const str = (v: Y | undefined, d = ''): string => typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : d;
const HARNESSES: HarnessId[] = ['claude-code', 'claude-code-terminal', 'codex', 'api'];

/** Claves de agent.yaml para el ámbito. Sin ámbito no se escribe nada, así el agent.yaml de antes no cambia. */
function contextScopeYaml(p: PortableContextScope | undefined): { [k: string]: Y } {
  if (!p || !p.options.length) return {};
  const opts = CONTEXT_SCOPE_VALUES.filter(o => p.options.includes(o));
  const out: { [k: string]: Y } = { context_scope: opts };
  if (opts.includes('project') && p.projectName?.trim()) out.project_name = p.projectName.trim();
  if (opts.includes('company') && p.companyName?.trim()) out.company_name = p.companyName.trim();
  return out;
}

/**
 * Lee `context_scope`. Si falta, el ámbito queda sin definir y no es un error (compatible con portal-ia/agent@1). Si
 * está vacío, no es una lista o trae un valor desconocido, devuelve un error claro y el ámbito sin definir.
 */
function readContextScope(y: { [k: string]: Y }): { value: PortableContextScope | undefined; error: string | null } {
  if (!Object.prototype.hasOwnProperty.call(y, 'context_scope')) return { value: undefined, error: null };
  const raw = y.context_scope;
  const known = `usa una lista con al menos una de: ${CONTEXT_SCOPE_VALUES.join(', ')}`;
  if (!Array.isArray(raw)) return { value: undefined, error: `El ámbito (context_scope) debe ser una lista: ${known}.` };
  if (!raw.length) return { value: undefined, error: `El ámbito (context_scope) está vacío: ${known}.` };
  const bad = raw.filter(x => typeof x !== 'string' || !(CONTEXT_SCOPE_VALUES as readonly string[]).includes(x.trim()));
  if (bad.length) return { value: undefined, error: `Ámbito desconocido «${bad.map(x => String(x)).join(', ')}» en context_scope: ${known}.` };
  const set = new Set((raw as string[]).map(x => x.trim()));
  const options = CONTEXT_SCOPE_VALUES.filter(o => set.has(o));
  return { value: { options, projectName: set.has('project') ? (str(y.project_name) || null) : null, companyName: set.has('company') ? (str(y.company_name) || null) : null }, error: null };
}

/** Ámbito del agente → agent.yaml. El nombre de la empresa solo va si Empresa está marcada; el del proyecto, solo si lo está Proyecto. */
export function contextScopeToPortable(scope: AgentContextScope | null | undefined, companyName?: string | null): PortableContextScope | undefined {
  const options = contextScopeOptions(scope);
  if (!scope || !options.length) return undefined;
  return { options, projectName: scope.project ? (scope.project.name.trim() || null) : null, companyName: scope.company ? ((companyName ?? '').trim() || null) : null };
}

/**
 * agent.yaml → ámbito del agente. El proyecto se busca por nombre entre los de este Portal. Si no existe, se conserva
 * el nombre con el id vacío y `projectMissing` lo señala para avisar sin bloquear.
 */
export function contextScopeFromPortable(p: PortableContextScope, projects: readonly { id: string; name: string }[] = []): { scope: AgentContextScope; projectMissing: boolean } {
  let project: { id: string; name: string } | null = null; let projectMissing = false;
  if (p.options.includes('project')) {
    const wanted = (p.projectName ?? '').trim().toLowerCase();
    const found = wanted ? projects.find(x => x.name.trim().toLowerCase() === wanted) : undefined;
    if (found) project = { id: found.id, name: found.name };
    else { project = { id: '', name: (p.projectName ?? '').trim() }; projectMissing = true; }
  }
  return { scope: { project, company: p.options.includes('company'), general: p.options.includes('general') }, projectMissing };
}

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
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(str(h.effort)) ? str(h.effort) as import('./types.ts').ReasoningEffort : 'medium';
  const cs = readContextScope(y);
  let personalName: string | undefined;
  if (Object.prototype.hasOwnProperty.call(y, 'personal_name') && y.personal_name !== null) {
    const pn = validateAgentName(str(y.personal_name), { roles: [name] });
    if (pn.ok) personalName = pn.name;
    else problems.push({ path: 'agent.yaml', message: `Nombre propio (personal_name) no válido: ${pn.reason ?? 'elige otro nombre'} Se importa sin él; elige otro nombre.`, blocking: false });
  }
  if (cs.error) problems.push({ path: 'agent.yaml', message: cs.error, blocking: true });
  const manifest: PortableAgentManifest = {
    schema: PORTABLE_AGENT_SCHEMA, id: str(y.id), name, role, department: str(y.department) || null,
    initials: (str(y.initials) || name.split(/\s+/).map(w => w[0] ?? '').join('')).slice(0, 2).toUpperCase(), summary: str(y.summary),
    responsibilities: strList(y.responsibilities).slice(0, 30), deliverables: strList(y.deliverables).slice(0, 30), capabilities: strList(y.capabilities).slice(0, 12),
    harness: { preferred, model: str(h.model), effort },
    permissions: { tools: strList(pm.tools), autonomy: str(pm.autonomy) === 'within_scope' ? 'within_scope' : 'ask' },
    createdAt: str(y.created),
    ...(cs.value ? { contextScope: cs.value } : {}),
    ...(personalName ? { personalName } : {})
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
  const changelog = files['CAMBIOS.md'] !== undefined ? normalizeText(files['CAMBIOS.md']).trim() : undefined;
  return { definition: { manifest, instructions, skills, memory, knowledge, changelog }, problems };
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

// ---------------------------------------------------------------- Fusión a tres bandas (importar lo cambiado fuera)

export interface PortableMergeConflict { path: string; base: string | null; ours: string | null; theirs: string | null }
export interface PortableMergeResult { merged: PortableFiles; adopted: string[]; conflicts: PortableMergeConflict[] }
const sameText = (a: string | undefined, b: string | undefined) => a === undefined || b === undefined ? a === b : normalizeText(a) === normalizeText(b);

/**
 * Fusión por archivo: `base` es la revisión exportada, `ours` la adoptada en el Portal y `theirs` lo que llega de fuera.
 * - Fuera no cambió (theirs = base): se queda lo del Portal.
 * - El Portal no cambió (ours = base): se toma lo de fuera (se anota en `adopted`).
 * - Ambos iguales: sin cambio.
 * - Ambos cambiaron distinto: conflicto; en `merged` se queda lo del Portal hasta que el propietario elija.
 * Un archivo ausente cuenta como versión (borrar es un cambio).
 */
export function mergePortableFiles(base: PortableFiles, ours: PortableFiles, theirs: PortableFiles): PortableMergeResult {
  const merged: PortableFiles = {}; const adopted: string[] = []; const conflicts: PortableMergeConflict[] = [];
  const has = (o: PortableFiles, p: string) => Object.prototype.hasOwnProperty.call(o, p);
  const paths = Array.from(new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])).sort();
  for (const p of paths) {
    const b = has(base, p) ? base[p] : undefined; const o = has(ours, p) ? ours[p] : undefined; const t = has(theirs, p) ? theirs[p] : undefined;
    let out: string | undefined;
    if (sameText(o, t)) out = o;
    else if (sameText(t, b)) out = o;
    else if (sameText(o, b)) { out = t; adopted.push(p); }
    else { out = o; conflicts.push({ path: p, base: b ?? null, ours: o ?? null, theirs: t ?? null }); }
    if (out !== undefined) merged[p] = normalizeText(out);
  }
  return { merged, adopted, conflicts };
}

/** Aplica la versión que eligió el propietario en cada conflicto ('portal' | 'zip'); devuelve los que siguen sin elegir. */
export function applyMergeResolutions(result: PortableMergeResult, resolutions: Record<string, 'portal' | 'zip'>): { files: PortableFiles; unresolved: string[] } {
  const files: PortableFiles = { ...result.merged }; const unresolved: string[] = [];
  for (const c of result.conflicts) {
    const r = Object.prototype.hasOwnProperty.call(resolutions, c.path) ? resolutions[c.path] : undefined;
    if (r === 'zip') { if (c.theirs === null) delete files[c.path]; else files[c.path] = normalizeText(c.theirs); }
    else if (r !== 'portal') unresolved.push(c.path);
  }
  return { files, unresolved };
}

const TOP_DIRS = new Set(['skills', 'knowledge', 'memory']);
/**
 * Quita la carpeta raíz común de las entradas de un ZIP («mi-agente/agent.yaml» → «agent.yaml»). Convierte «\» en «/».
 * Solo la quita si TODAS las entradas cuelgan de la misma carpeta y esta no es una carpeta propia del contrato
 * (skills/, knowledge/, memory/), ni «.», «..» ni una unidad («C:»). Devuelve las rutas en el mismo orden.
 */
export function stripZipRoot(paths: string[]): { root: string | null; paths: string[] } {
  const norm = paths.map(p => p.replace(/\\/g, '/'));
  const firsts = new Set<string>(); let nested = norm.length > 0;
  for (const p of norm) { const i = p.indexOf('/'); if (i <= 0) { nested = false; break; } firsts.add(p.slice(0, i)); }
  const root = nested && firsts.size === 1 ? Array.from(firsts)[0]! : null;
  if (!root || TOP_DIRS.has(root) || root === '.' || root === '..' || root.includes(':')) return { root: null, paths: norm };
  return { root, paths: norm.map(p => p.slice(root.length + 1)) };
}

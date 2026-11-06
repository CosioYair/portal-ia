import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PORTABLE_AGENT_SCHEMA, PORTABLE_LIMITS, allowedPortablePath, baseSkillsFor, buildDefaultInstructions, contextScopeFromPortable, contextScopeLabel, contextScopeOptions, contextScopeToPortable, definitionToFiles, describeContextScope, diffFiles, filesToDefinition, findSecret, isBaseSkill, normalizeText, slugify, toolCapabilities } from '@portal-ia/domain';
import type { Agent, AgentContextScope, HarnessId, Lesson, MemoryEntry, PortableAgentDefinition, PortableFiles, PortableKnowledge, PortableSkill, ToolCapability } from '@portal-ia/domain';
import { config } from '../config.ts';
import { agentsRepo, contextScopeMigrationNote, processesRepo, projectsRepo, workspaceDb, workspaceDbPath } from '../db/workspace.ts';
import type { SandboxStatus } from './sandbox.ts';
import { changed } from './live.ts';
import { monotonicNow } from '../clock.ts';
import { departmentsRepo } from './departments.ts';
import { lessonsRepo } from './lessons.ts';

/**
 * Carpeta portable de cada agente (contrato `portal-ia/agent@1`, docs/agentes-portables.md) y sus revisiones.
 *
 * - La BASE sigue siendo la fuente de verdad operativa (estado, ejecuciones, autorizaciones, arnés y permisos concedidos).
 *   La carpeta es la definición portable: identidad, instrucciones, habilidades, memoria verificada y referencias.
 * - Cada versión adoptada es una fila de `agent_revisions` con TODOS sus archivos: volver atrás no depende del disco.
 * - Los prompts usan SIEMPRE la revisión adoptada (de la base), nunca lo que haya en disco: un cambio externo no llega a
 *   ningún agente hasta que el propietario lo revisa y lo adopta.
 * - Escritura en dos fases: revisión «writing» → archivos (temporal + rename) → «adopted». Si el proceso muere en medio,
 *   la siguiente lectura lo resuelve sin perder ni aplicar nada en silencio (ver resolveWriting).
 * - Arnés y permisos NO se adoptan desde la carpeta: son concesiones del propietario en el Portal; la carpeta los refleja.
 */
const now = monotonicNow;
const MAX_LIST = 400;

export function agentsRoot(slug: string): string { return path.join(path.dirname(workspaceDbPath(slug)), 'agents'); }

function ensure(slug: string) {
  const db = workspaceDb(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_folders (
    agent_id TEXT PRIMARY KEY, folder TEXT NOT NULL UNIQUE, adopted_n INTEGER, created_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS agent_revisions (
    agent_id TEXT NOT NULL, n INTEGER NOT NULL, hash TEXT NOT NULL, files_json TEXT NOT NULL, state TEXT NOT NULL, source TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', by TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (agent_id, n)
  );`);
  return db;
}

export type RevisionSource = 'migrated' | 'created' | 'portal' | 'external' | 'import' | 'restore' | 'learning' | 'harness';
export interface AgentRevision { n: number; hash: string; state: 'writing' | 'adopted' | 'abandoned' | 'superseded'; source: RevisionSource; note: string; by: string; at: string }
const mapRev = (r: any): AgentRevision => ({ n: r.n, hash: r.hash, state: r.state, source: r.source, note: r.note, by: r.by, at: r.at });

/** Huella de una carpeta: archivos permitidos, ordenados y normalizados (CRLF/BOM no cuentan como cambio). */
export function hashFiles(files: PortableFiles): string {
  const h = crypto.createHash('sha256');
  for (const p of Object.keys(files).filter(allowedPortablePath).sort()) h.update(p).update('\u0000').update(normalizeText(files[p])).update('\u0000');
  return h.digest('hex');
}

const inside = (root: string, p: string) => { const rel = path.relative(root, p); return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel)); };

/**
 * Lee una carpeta de agente sin seguir enlaces: lstat en cada entrada (en Windows las uniones/junctions también son
 * enlaces), realpath dentro de la raíz, solo los archivos de la lista blanca, con límites de número y tamaño.
 * Lo que no se lee se informa (nombre, no contenido).
 */
export function readFolder(dir: string): { files: PortableFiles; ignored: string[] } {
  const files: PortableFiles = {}; const ignored: string[] = [];
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw Object.assign(new Error('La carpeta del agente no es una carpeta normal (¿un enlace?).'), { statusCode: 400 });
  const root = fs.realpathSync(dir); let seen = 0; let total = 0;
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 3) { ignored.push(rel + '/…'); return; }
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (++seen > MAX_LIST) throw Object.assign(new Error('La carpeta tiene demasiadas entradas.'), { statusCode: 400 });
      const r = rel ? `${rel}/${e.name}` : e.name; const a = path.join(abs, e.name);
      const l = fs.lstatSync(a);
      if (l.isSymbolicLink()) { ignored.push(`${r} (enlace: no se sigue)`); continue; }
      if (!inside(root, fs.realpathSync(a))) { ignored.push(`${r} (fuera de la carpeta)`); continue; }
      if (l.isDirectory()) { walk(a, r, depth + 1); continue; }
      if (!l.isFile()) { ignored.push(r); continue; }
      if (!allowedPortablePath(r)) { ignored.push(r); continue; }
      if (l.size > PORTABLE_LIMITS.fileBytes) throw Object.assign(new Error(`${r} es demasiado grande (máx. ${PORTABLE_LIMITS.fileBytes / 1024} KB).`), { statusCode: 400 });
      total += l.size; if (total > PORTABLE_LIMITS.totalBytes) throw Object.assign(new Error('La carpeta es demasiado grande.'), { statusCode: 400 });
      files[r] = normalizeText(fs.readFileSync(a, 'utf8'));
    }
  };
  walk(root, '', 0);
  return { files, ignored };
}

/** Escribe los archivos de una revisión: cada uno a un temporal y luego rename; borra solo archivos permitidos que sobran. */
function writeFiles(dir: string, files: PortableFiles) {
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw Object.assign(new Error('La carpeta del agente es un enlace (symlink o junction): el Portal no escribe a través de él. Sustitúyela por una carpeta normal.'), { statusCode: 400 });
  fs.mkdirSync(dir, { recursive: true });
  const root = fs.realpathSync(dir);
  if (path.dirname(root) !== fs.realpathSync(parent)) throw Object.assign(new Error('La carpeta del agente no está dentro de la carpeta de agentes del Portal.'), { statusCode: 400 });
  for (const [rel, content] of Object.entries(files)) {
    if (!allowedPortablePath(rel)) throw new Error(`Ruta no permitida: ${rel}`);
    const target = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!inside(root, fs.realpathSync(path.dirname(target)))) throw new Error(`Ruta fuera de la carpeta del agente: ${rel}`);
    const tmp = `${target}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, content, 'utf8'); fs.renameSync(tmp, target);
  }
  let current: PortableFiles = {}; try { current = readFolder(root).files; } catch { /* se queda como está */ }
  for (const rel of Object.keys(current)) if (!(rel in files)) {
    const abs = path.join(root, ...rel.split('/')); fs.rmSync(abs, { force: true });
    const parent = path.dirname(abs); if (parent !== root && rel.startsWith('skills/')) { try { fs.rmdirSync(parent); } catch { /* no vacía */ } }
  }
}

// ---------------------------------------------------------------- Definición del agente (fila + revisión adoptada)

export const DEFAULT_INSTRUCTIONS_MARK = '<!-- portal-ia: instrucciones por defecto; edítalas para darle instrucciones propias -->';
/** AGENTS.md mínimo (compatibilidad): nombre, resumen y marca. Lo vigente es agentDefaultInstructions. */
export function defaultInstructions(name: string, summary: string) { return `# ${name}\n\n${summary || 'Agente de Portal IA.'}\n\n${DEFAULT_INSTRUCTIONS_MARK}`; }
export const hasOwnInstructions = (text: string) => !!text.trim() && !text.includes(DEFAULT_INSTRUCTIONS_MARK);

/**
 * A quién reporta, en lenguaje llano y sin identificadores internos: «el propietario», el nombre del agente con esa clave
 * (si hay varios, el del mismo proyecto) o, si no aparece, una descripción genérica (nunca la clave ni un id).
 */
export function reportsToName(slug: string, a: Agent): string {
  const key = a.template.reportsTo;
  if (!key || key === 'owner') return 'el propietario';
  let all: Agent[] = [];
  try { all = agentsRepo(slug).list(); } catch { all = []; }
  const matches = all.filter(x => x.key === key && x.id !== a.id);
  const pick = matches.find(x => x.projectId === a.projectId) ?? matches.find(x => x.projectId === null) ?? matches[0];
  return pick ? pick.config.name : 'su responsable en el equipo';
}

/** AGENTS.md por defecto con los datos actuales del agente (sin IA ni IO salvo leer la fila; no se inyecta en los prompts). */
export function agentDefaultInstructions(slug: string, a: Agent): string {
  // EN-014: sin ámbito, el texto es exactamente el de antes (la huella no cambia y no aparecen revisiones de más).
  const scope = contextScopeOf(slug, a);
  return buildDefaultInstructions({
    name: a.config.name, role: a.template.role, specialization: a.config.specialization, responsibilities: a.config.responsibilities ?? [],
    reportsTo: reportsToName(slug, a), tools: grantedTools(a), mark: DEFAULT_INSTRUCTIONS_MARK,
    ...(scope ? {
      contextScope: scope, companyName: scope.company ? companyNameOf(slug) : null,
      projectName: scope.project?.name ?? null, projectGoals: scope.project ? projectGoalsOf(slug, scope.project.id) : []
    } : {})
  });
}

// ---------------------------------------------------------------- EN-014 · Ámbito del agente (contexto, no permisos)

/** Quién da el nombre legible de la empresa de un espacio (lo registra el arranque); sin él se escribe «la empresa». */
let companyNameResolver: ((slug: string) => string | null | undefined) | null = null;
export function setCompanyNameResolver(fn: ((slug: string) => string | null | undefined) | null) { companyNameResolver = fn; }
export function companyNameOf(slug: string): string | null {
  try { const n = companyNameResolver?.(slug); return n && n.trim() ? n.trim() : null; } catch { return null; }
}

type ProjectRef = { id: string; name: string };
/** Proyectos del espacio (id y nombre). Si no se pueden leer, lista vacía: el ámbito nunca impide cargar un agente. */
export function projectsOf(slug: string): ProjectRef[] {
  try {
    const repo = projectsRepo(slug) as unknown as { list?: () => { id: string; name: string }[] };
    return typeof repo.list === 'function' ? repo.list().map(p => ({ id: p.id, name: p.name })) : [];
  } catch { return []; }
}
function projectGoalsOf(slug: string, projectId: string): string[] {
  try {
    const repo = projectsRepo(slug) as unknown as { objectives?: (id: string) => { text?: unknown }[] };
    return typeof repo.objectives === 'function' ? repo.objectives(projectId).map(o => (typeof o.text === 'string' ? o.text : '')).filter(Boolean) : [];
  } catch { return []; }
}

/** Ámbito vigente del agente con el nombre actual de su proyecto (si se renombró). Si el proyecto ya no existe, se conserva el nombre guardado. */
export function contextScopeOf(slug: string, a: Agent): AgentContextScope | null {
  const s = a.contextScope ?? null;
  if (!s || !contextScopeOptions(s).length) return null;
  if (!s.project) return s;
  const cur = projectsOf(slug).find(p => p.id === s.project!.id);
  return cur && cur.name !== s.project.name ? { ...s, project: { id: cur.id, name: cur.name } } : s;
}

/** Ámbito para un ZIP o carpeta que no lo declara: el del agente existente o, si es nuevo, solo General. */
export const GENERAL_ONLY_SCOPE: AgentContextScope = { project: null, company: false, general: true };

export interface ImportScopePreview { declared: boolean; contextScope: AgentContextScope; label: string; lines: string[]; projectMissing: boolean; warning: string | null }

/**
 * Vista previa del ámbito de unos archivos importados (sin IA ni escritura). Si es Proyecto de un proyecto que no existe
 * en este Portal, avisa sin bloquear. Si no lo declaran, se informa qué ámbito quedará.
 */
export function importScopePreview(slug: string, files: PortableFiles, existing?: Agent | null): ImportScopePreview {
  const def = filesToDefinition(files).definition;
  const portable = def?.manifest.contextScope;
  const company = companyNameOf(slug);
  if (portable && portable.options.length) {
    const { scope, projectMissing } = contextScopeFromPortable(portable, projectsOf(slug));
    return {
      declared: true, contextScope: scope, label: contextScopeLabel(scope), lines: describeContextScope(scope, { company, project: scope.project?.name ?? portable.projectName ?? null }),
      projectMissing,
      warning: projectMissing ? `El agente está especializado en el proyecto «${portable.projectName ?? 'sin nombre'}», que no existe en este Portal. Puedes importarlo igual; elige su proyecto después en Configuración.` : null
    };
  }
  const kept = existing ? contextScopeOf(slug, existing) : null;
  const scope = kept ?? GENERAL_ONLY_SCOPE;
  return {
    declared: false, contextScope: scope, label: contextScopeLabel(scope), lines: describeContextScope(scope, { company, project: scope.project?.name ?? null }), projectMissing: false,
    warning: kept ? 'El paquete no declara ámbito: el agente conserva el que ya tiene.' : 'El paquete no declara ámbito: el agente quedará como General.'
  };
}

/**
 * Aplica a la fila el ámbito de unos archivos importados. Si lo declaran, ese; si no, el agente existente conserva el suyo y
 * uno nuevo queda General. Solo escribe el ámbito: no toca herramientas, permisos, arnés ni memoria.
 */
export function applyImportedContextScope(slug: string, agentId: string, files: PortableFiles, isNew: boolean): AgentContextScope | null {
  const agents = agentsRepo(slug); const a = agents.get(agentId); if (!a) return null;
  const pv = importScopePreview(slug, files, isNew ? null : a);
  if (!pv.declared && !isNew) return a.contextScope ?? null;
  agents.setContextScope(agentId, pv.contextScope);
  return pv.contextScope;
}

/** El arnés de la carpeta: el backend concedido en la base (la API cuenta como «api»). */
const harnessOf = (a: Agent): HarnessId => (a.config.backend ?? 'api') as HarnessId;

export interface AgentExtras { instructions: string; skills: PortableSkill[]; memory: MemoryEntry[]; knowledge: PortableKnowledge[]; deliverables: string[]; autonomy: 'ask' | 'within_scope'; changelog?: string | undefined }
const EMPTY_EXTRAS = (slug: string, a: Agent): AgentExtras => ({ instructions: agentDefaultInstructions(slug, a), skills: [], memory: [], knowledge: [], deliverables: [], autonomy: 'ask' });

/** Herramientas concedidas en Configuración (la base es la fuente de verdad), ordenadas. */
export const grantedTools = (a: Agent): string[] => Object.keys(a.config.tools).filter(k => a.config.tools[k]).sort();

/**
 * Definición portable a partir de la fila (lo concedido) y de lo propio de la carpeta (instrucciones, habilidades…).
 * EN-011: las habilidades base (`skills/portal-*`) salen SOLO de las herramientas concedidas; las de la carpeta con ese
 * prefijo se descartan. Quitar una herramienta retira su habilidad y editar un SKILL.md base no concede nada.
 */
export function definitionFor(slug: string, a: Agent, extras: AgentExtras): PortableAgentDefinition {
  const dep = departmentsRepo(slug).departmentOf(a);
  const tools = grantedTools(a);
  // EN-013: unas instrucciones por defecto (con la marca, o vacías) se regeneran con los datos actuales; las propias no se tocan.
  const instructions = hasOwnInstructions(extras.instructions) ? extras.instructions : agentDefaultInstructions(slug, a);
  // EN-014: el ámbito va en agent.yaml (context_scope) y decide el contexto de las habilidades base; no concede nada.
  // Los nombres de empresa y proyecto solo se escriben si su opción está marcada.
  const scope = contextScopeOf(slug, a);
  const portableScope = scope ? contextScopeToPortable(scope, scope.company ? companyNameOf(slug) : null) : undefined;
  return {
    manifest: {
      schema: PORTABLE_AGENT_SCHEMA, id: a.id, name: a.config.name, role: a.template.role, department: dep?.slug ?? null, initials: a.template.initials,
      summary: a.config.specialization, responsibilities: a.config.responsibilities, deliverables: extras.deliverables, capabilities: a.config.capabilities ?? [],
      harness: { preferred: harnessOf(a), model: a.config.model, effort: a.config.effort },
      permissions: { tools, autonomy: extras.autonomy },
      createdAt: a.createdAt,
      ...(portableScope ? { contextScope: portableScope } : {})
    },
    instructions, skills: [...baseSkillsFor(tools, scope), ...extras.skills.filter(s => !isBaseSkill(s.slug))], memory: memoryOf(slug, a.id), knowledge: extras.knowledge, changelog: extras.changelog
  };
}

/** Memoria verificada del agente (proyección de sus lecciones validadas): nunca sale de lo que diga el archivo. */
export function memoryOf(slug: string, agentId: string): MemoryEntry[] {
  return lessonsRepo(slug).listForAgent(agentId, 'validated').map(l => ({
    id: l.id, title: l.title, text: l.lessonText ?? '', verifiedAt: (l.validatedAt ?? l.updatedAt).slice(0, 10), verifiedBy: 'el propietario',
    source: l.evidence.processTitle ? `tarea «${l.evidence.processTitle}»${l.evidence.processId ? ` (${l.evidence.processId.slice(0, 8)})` : ''}` : (l.evidence.detail || 'feedback del propietario')
  }));
}

export function extrasFromFiles(files: PortableFiles): AgentExtras | null {
  const { definition } = filesToDefinition(files); if (!definition) return null;
  // La memoria NO se toma del archivo: MEMORY.md es una proyección de las entradas verificadas (lessons con agent_id).
  // Las habilidades base tampoco: se generan desde las herramientas concedidas (nunca se adoptan desde archivos).
  return { instructions: definition.instructions, skills: definition.skills.filter(s => !isBaseSkill(s.slug)), memory: [], knowledge: definition.knowledge, deliverables: definition.manifest.deliverables, autonomy: definition.manifest.permissions.autonomy, changelog: definition.changelog };
}

// ---------------------------------------------------------------- Repositorio de carpetas y revisiones

export function agentFoldersRepo(slug: string) {
  const db = ensure(slug);
  return {
    folderOf(agentId: string): { folder: string; adoptedN: number | null } | null {
      const r = db.prepare(`SELECT folder, adopted_n FROM agent_folders WHERE agent_id = ?`).get(agentId) as any;
      return r ? { folder: r.folder, adoptedN: r.adopted_n ?? null } : null;
    },
    folderTaken(folder: string): boolean { return !!db.prepare(`SELECT 1 FROM agent_folders WHERE folder = ?`).get(folder); },
    register(agentId: string, folder: string) { db.prepare(`INSERT INTO agent_folders (agent_id, folder, adopted_n, created_at) VALUES (?, ?, NULL, ?)`).run(agentId, folder, now()); },
    revisions(agentId: string): AgentRevision[] { return (db.prepare(`SELECT agent_id, n, hash, state, source, note, by, at FROM agent_revisions WHERE agent_id = ? ORDER BY n DESC`).all(agentId) as any[]).map(mapRev); },
    revisionFiles(agentId: string, n: number): PortableFiles | null { const r = db.prepare(`SELECT files_json FROM agent_revisions WHERE agent_id = ? AND n = ?`).get(agentId, n) as any; return r ? JSON.parse(r.files_json) : null; },
    adopted(agentId: string): (AgentRevision & { files: PortableFiles }) | null {
      const r = db.prepare(`SELECT r.* FROM agent_revisions r JOIN agent_folders f ON f.agent_id = r.agent_id AND f.adopted_n = r.n WHERE r.agent_id = ?`).get(agentId) as any;
      return r ? { ...mapRev(r), files: JSON.parse(r.files_json) } : null;
    },
    latest(agentId: string): (AgentRevision & { files: PortableFiles }) | null {
      const r = db.prepare(`SELECT * FROM agent_revisions WHERE agent_id = ? ORDER BY n DESC LIMIT 1`).get(agentId) as any;
      return r ? { ...mapRev(r), files: JSON.parse(r.files_json) } : null;
    },
    begin(agentId: string, files: PortableFiles, source: RevisionSource, note: string, by: string): number {
      const n = ((db.prepare(`SELECT MAX(n) AS n FROM agent_revisions WHERE agent_id = ?`).get(agentId) as any)?.n ?? 0) + 1;
      db.prepare(`INSERT INTO agent_revisions (agent_id, n, hash, files_json, state, source, note, by, at) VALUES (?, ?, ?, ?, 'writing', ?, ?, ?, ?)`).run(agentId, n, hashFiles(files), JSON.stringify(files), source, note, by, now());
      return n;
    },
    adopt(agentId: string, n: number) {
      db.exec('BEGIN');
      try {
        db.prepare(`UPDATE agent_revisions SET state = 'superseded' WHERE agent_id = ? AND state = 'adopted'`).run(agentId);
        db.prepare(`UPDATE agent_revisions SET state = 'adopted' WHERE agent_id = ? AND n = ?`).run(agentId, n);
        db.prepare(`UPDATE agent_folders SET adopted_n = ? WHERE agent_id = ?`).run(n, agentId);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      changed({ ws: slug, entity: 'agent', id: agentId });
    },
    abandon(agentId: string, n: number) { db.prepare(`UPDATE agent_revisions SET state = 'abandoned' WHERE agent_id = ? AND n = ? AND state = 'writing'`).run(agentId, n); }
  };
}

const locks = new Map<string, Promise<unknown>>();
/** Serializa las escrituras de la carpeta de un agente (un solo proceso de servidor). */
async function withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  // La cola guarda solo el «terminado» (nunca un rechazo sin atender): un fallo lo recibe quien llamó, no el siguiente.
  const settled: Promise<unknown> = run.then(() => undefined, () => undefined);
  locks.set(key, settled);
  void settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
  return run;
}

export function folderPath(slug: string, folder: string) { return path.join(agentsRoot(slug), folder); }

const diskCache = new Map<string, { sig: string; hash: string }>();
/** Firma barata de una carpeta (sin leer contenido): rutas, tamaños y fechas de modificación, sin seguir enlaces. */
function folderSignature(dir: string): string | null {
  const parts: string[] = [];
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 3 || parts.length > MAX_LIST) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name; const a = path.join(abs, e.name);
      const l = fs.lstatSync(a);
      if (l.isDirectory() && !l.isSymbolicLink()) walk(a, r, depth + 1); else parts.push(`${r}:${l.size}:${l.mtimeMs}:${l.isSymbolicLink() ? 'L' : ''}`);
    }
  };
  try { walk(dir, '', 0); } catch { return null; }
  return parts.sort().join('|');
}
/** Huella de lo que hay en disco (con caché por firma): para detectar cambios externos sin releer cada vez. */
export function diskHash(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const sig = folderSignature(dir); if (sig === null) return null;
  const c = diskCache.get(dir); if (c && c.sig === sig) return c.hash;
  let hash: string; try { hash = hashFiles(readFolder(dir).files); } catch { return null; }
  diskCache.set(dir, { sig, hash }); return hash;
}
function diskFiles(slug: string, folder: string): { files: PortableFiles; ignored: string[] } | null {
  const dir = folderPath(slug, folder); if (!fs.existsSync(dir)) return null;
  try { return readFolder(dir); } catch (e) { return { files: {}, ignored: [`(no se pudo leer: ${(e as Error).message})`] }; }
}

/** Una escritura interrumpida (revisión «writing»): se adopta si el disco quedó igual a ella; si no, se abandona. */
function resolveWriting(slug: string, agentId: string) {
  const repo = agentFoldersRepo(slug); const f = repo.folderOf(agentId); const last = repo.latest(agentId);
  if (!f || !last || last.state !== 'writing') return;
  const disk = diskFiles(slug, f.folder);
  if (disk && hashFiles(disk.files) === last.hash) repo.adopt(agentId, last.n); else repo.abandon(agentId, last.n);
}

/** Escribe una nueva revisión adoptada. Se niega si hay un cambio externo sin revisar (nunca lo pisa). */
export async function writeRevision(slug: string, agentId: string, files: PortableFiles, source: RevisionSource, note: string, by = 'owner'): Promise<AgentRevision> {
  for (const [p, c] of Object.entries(files)) { const s = findSecret(c); if (s) throw Object.assign(new Error(`${p} contiene lo que parece una ${s}: las credenciales nunca van en la carpeta de un agente.`), { statusCode: 400 }); }
  return withLock(`${slug}:${agentId}`, () => writeRevisionUnlocked(slug, agentId, files, source, note, by));
}
function writeRevisionUnlocked(slug: string, agentId: string, files: PortableFiles, source: RevisionSource, note: string, by: string): AgentRevision {
  {
    resolveWriting(slug, agentId);
    const repo = agentFoldersRepo(slug); const f = repo.folderOf(agentId);
    if (!f) throw Object.assign(new Error('El agente aún no tiene carpeta.'), { statusCode: 409 });
    const adopted = repo.adopted(agentId); const disk = diskFiles(slug, f.folder);
    if (adopted && disk && hashFiles(disk.files) !== adopted.hash) throw Object.assign(new Error('La carpeta del agente tiene cambios hechos fuera del Portal sin revisar: adóptalos o descártalos antes de cambiar nada.'), { statusCode: 409, external: true });
    if (adopted && adopted.hash === hashFiles(files)) return adopted;
    const n = repo.begin(agentId, files, source, note, by);
    try { writeFiles(folderPath(slug, f.folder), files); }
    catch (e) {
      repo.abandon(agentId, n);
      // Una escritura a medias (p. ej. un antivirus bloquea un rename) no debe parecer un cambio hecho fuera del Portal.
      if (adopted) { try { writeFiles(folderPath(slug, f.folder), adopted.files); } catch { /* lo verá el propietario en Archivos */ } }
      throw e;
    }
    repo.adopt(agentId, n);
    return repo.revisions(agentId).find(r => r.n === n)!;
  }
}

/** Lo propio de la carpeta adoptada (o lo vacío si aún no tiene): lo que usan los prompts. */
export function adoptedExtras(slug: string, a: Agent): AgentExtras {
  const ad = agentFoldersRepo(slug).adopted(a.id);
  return (ad && extrasFromFiles(ad.files)) ?? EMPTY_EXTRAS(slug, a);
}

/** Folder name único y estable a partir del nombre (no cambia si el agente se renombra). */
function freeFolderName(slug: string, a: Agent): string {
  // «<clave>-<id8>»: único (dos proyectos pueden tener su propio pj-dev), ASCII, corto y estable aunque se renombre.
  const agentId = a.id; const repo = agentFoldersRepo(slug); const base = slugify(`${a.key}-${a.id.slice(0, 8)}`); let candidate = base; let i = 2;
  void agentId;
  // Cualquier cosa que ya exista en disco con ese nombre se respeta y NO se adopta: se usa el siguiente nombre libre.
  const takenOnDisk = (c: string) => { try { fs.lstatSync(folderPath(slug, c)); return true; } catch { return false; } };
  while (repo.folderTaken(candidate) || takenOnDisk(candidate)) candidate = `${base}-${i++}`;
  return candidate;
}

/**
 * Pone la carpeta al día con la fila: crea la de los agentes que no la tienen (migración aditiva: la fila no cambia) y,
 * si lo concedido en la base (nombre, papel, arnés, permisos…) cambió desde la revisión adoptada, escribe una revisión
 * «portal». Si hay un cambio externo pendiente, no toca nada (el propietario decide primero).
 */
export async function syncAgentFolder(slug: string, a: Agent, note = 'Sincronizada con la configuración del Portal'): Promise<{ created: boolean; revision: AgentRevision | null; pendingExternal: boolean }> {
  const repo = agentFoldersRepo(slug);
  let f = repo.folderOf(a.id); let created = false;
  if (!f) {
    const folder = freeFolderName(slug, a);
    repo.register(a.id, folder); f = { folder, adoptedN: null }; created = true;
  }
  resolveWriting(slug, a.id);
  const adopted = repo.adopted(a.id);
  const extras = (adopted && extrasFromFiles(adopted.files)) ?? EMPTY_EXTRAS(slug, a);
  const files = definitionToFiles(definitionFor(slug, a, extras));
  if (!adopted) {
    const rev = await writeRevision(slug, a.id, files, created ? 'migrated' : 'portal', created ? 'Carpeta creada a partir de la configuración existente del agente (sin cambiar la fila)' : note, 'portal');
    return { created, revision: rev, pendingExternal: false };
  }
  const disk = diskFiles(slug, f.folder);
  if (disk && hashFiles(disk.files) !== adopted.hash) return { created, revision: null, pendingExternal: true };
  if (!disk) { // Carpeta borrada fuera del Portal: se restaura la revisión adoptada (está en la base).
    writeFiles(folderPath(slug, f.folder), adopted.files);
  }
  if (hashFiles(files) === adopted.hash) return { created, revision: null, pendingExternal: false };
  return { created, revision: await writeRevision(slug, a.id, files, 'portal', note, 'portal'), pendingExternal: false };
}

/**
 * EN-014 · Migración idempotente del ámbito: los agentes sin ámbito quedan Empresa + General, con una revisión «portal»
 * por agente (syncAgentFolder solo la crea si cambian los archivos). La segunda pasada no cambia nada. No toca el arnés,
 * los permisos, la memoria ni el nombre de la carpeta.
 */
/**
 * EN-014 · Guarda el ámbito elegido por el propietario en Ajustes. Sin IA y sin costo: no toca herramientas, permisos,
 * arnés ni memoria. Exige al menos una opción y un proyecto existente (se guarda con su nombre real). Si el agente tiene
 * carpeta, la sincroniza con una revisión «portal» que lo explica.
 */
export async function setAgentContextScope(slug: string, agentId: string, scope: AgentContextScope): Promise<Agent> {
  const agents = agentsRepo(slug);
  if (!agents.get(agentId)) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
  let project: AgentContextScope['project'] = null;
  if (scope.project) {
    const p = projectsRepo(slug).get(scope.project.id);
    if (!p) throw Object.assign(new Error('El proyecto elegido no existe en esta empresa.'), { statusCode: 400 });
    project = { ...scope.project, id: p.id, name: p.name };
  }
  const next: AgentContextScope = { ...scope, project, company: !!scope.company, general: !!scope.general };
  if (!contextScopeOptions(next).length) throw Object.assign(new Error('Elige al menos una opción de ámbito (Proyecto, Empresa o General).'), { statusCode: 400 });
  const updated = agents.setContextScope(agentId, next);
  if (agentFoldersRepo(slug).folderOf(agentId)) await syncAgentFolder(slug, updated, `Ámbito cambiado a ${contextScopeLabel(next)} por el propietario (sin cambios en herramientas ni permisos)`).catch(() => null);
  return agents.get(agentId) ?? updated;
}

export async function migrateAgentContextScopes(slug: string, companyName?: string | null): Promise<{ migrated: string[]; failed: { agentId: string; error: string }[] }> {
  const company = (companyName ?? '').trim() || companyNameOf(slug) || 'la empresa';
  const migrated: string[] = []; const failed: { agentId: string; error: string }[] = [];
  let changedRows: Agent[] = [];
  try { changedRows = agentsRepo(slug).migrateContextScope(); } catch (e) { return { migrated, failed: [{ agentId: '*', error: (e as Error).message }] }; }
  for (const row of changedRows) {
    try {
      const fresh = agentsRepo(slug).get(row.id) ?? row;
      const migNote = contextScopeMigrationNote(company);
      await syncAgentFolder(slug, fresh, migNote);
      // Si los archivos no cambian (mismo hash), ni syncAgentFolder ni writeRevision crean revisión: se registra aquí,
      // con los mismos archivos adoptados (la carpeta en disco no cambia), una sola vez por agente.
      const hasMigNote = (workspaceDb(slug).prepare(`SELECT note FROM agent_revisions WHERE agent_id = ?`).all(row.id) as any[])
        .some(r => String(r.note ?? '').startsWith('Ámbito inicial'));
      const repo = agentFoldersRepo(slug); const adoptedNow = repo.adopted(row.id);
      if (!hasMigNote && adoptedNow) { const n = repo.begin(row.id, { ...adoptedNow.files }, 'portal', migNote, 'portal'); repo.adopt(row.id, n); }
      migrated.push(row.id);
    } catch (e) { failed.push({ agentId: row.id, error: (e as Error).message }); }
  }
  return { migrated, failed };
}

/** Migración al arrancar: todos los agentes del espacio con su carpeta. Idempotente; un error en uno no para los demás. */
export async function ensureAgentFolders(slug: string, opts: { companyName?: string | null } = {}): Promise<{ created: number; failed: { agentId: string; error: string }[] }> {
  let created = 0; const failed: { agentId: string; error: string }[] = [];
  // EN-014: primero el ámbito, para que cada agente reciba una sola revisión «portal» con su nota clara.
  failed.push(...(await migrateAgentContextScopes(slug, opts.companyName)).failed);
  for (const a of agentsRepo(slug).list()) {
    try { if ((await syncAgentFolder(slug, a, 'Habilidades base según herramientas concedidas')).created) created++; } catch (e) { failed.push({ agentId: a.id, error: (e as Error).message }); }
  }
  return { created, failed };
}

/** Estado de la carpeta para la interfaz: adoptada, disco, cambio externo (con diff), problemas y revisiones. */
export function folderStatus(slug: string, a: Agent) {
  resolveWriting(slug, a.id);
  const repo = agentFoldersRepo(slug); const f = repo.folderOf(a.id);
  if (!f) return { folder: null, path: null, adopted: null, external: null, revisions: [], ignored: [] as string[] };
  const adopted = repo.adopted(a.id);
  // Huella en caché por firma: solo se relee el contenido si la carpeta cambió de verdad.
  const dh = diskHash(folderPath(slug, f.folder));
  const disk = adopted && dh && dh === adopted.hash ? { files: adopted.files, ignored: diskFiles(slug, f.folder)?.ignored ?? [] } : diskFiles(slug, f.folder);
  let external: { hash: string; diff: ReturnType<typeof diffFiles>; problems: ReturnType<typeof filesToDefinition>['problems']; notAdopted: string[] } | null = null;
  if (adopted && disk && hashFiles(disk.files) !== adopted.hash) {
    const parsed = filesToDefinition(disk.files);
    // La huella de lo revisado: adoptar exige ESA versión (si la carpeta vuelve a cambiar, se revisa otra vez).
    external = { hash: hashFiles(disk.files), diff: diffFiles(adopted.files, disk.files), problems: parsed.problems, notAdopted: notAdoptedChanges(adopted.files, disk.files) };
  }
  return {
    folder: f.folder, path: folderPath(slug, f.folder),
    adopted: adopted ? { n: adopted.n, hash: adopted.hash, at: adopted.at, source: adopted.source, files: adopted.files } : null,
    missingOnDisk: !disk, external, revisions: repo.revisions(a.id).slice(0, 50), ignored: disk?.ignored ?? []
  };
}

/** Partes de un cambio externo que NO se adoptan (son concesiones del propietario): arnés y permisos. */
export function notAdoptedChanges(before: PortableFiles, after: PortableFiles): string[] {
  const a = filesToDefinition(before).definition?.manifest; const b = filesToDefinition(after).definition?.manifest;
  if (!a || !b) return [];
  const out: string[] = [];
  if (a.harness.preferred !== b.harness.preferred || a.harness.model !== b.harness.model) out.push(`Arnés/modelo (${b.harness.preferred} · ${b.harness.model || 'predeterminado'}): se cambia en Configuración, con su comprobación y tu autorización.`);
  if (a.harness.effort !== b.harness.effort) out.push('Esfuerzo: se cambia en Configuración.');
  if (a.permissions.autonomy !== b.permissions.autonomy) out.push('Autonomía: se cambia en el Portal, no desde la carpeta.');
  if (a.capabilities.join(',') !== b.capabilities.join(',')) out.push('Capacidades (qué papel tiene en el equipo de una historia): se cambian en Configuración, no desde la carpeta.');
  if (a.permissions.tools.join(',') !== b.permissions.tools.join(',')) out.push(`Herramientas (${b.permissions.tools.join(', ') || 'ninguna'}): se conceden en Configuración, nunca desde la carpeta.`);
  if (a.id !== b.id) out.push('El identificador (id) no se puede cambiar.');
  if (normalizeText(before['memory/MEMORY.md'] ?? '') !== normalizeText(after['memory/MEMORY.md'] ?? '')) out.push('Memoria: MEMORY.md refleja el aprendizaje que verificaste en el Portal; las ediciones del archivo no se adoptan (añade o retira aprendizaje desde la pestaña Memoria).');
  const baseRe = /^skills\/portal-[^/]+\//;
  const basePaths = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(p => baseRe.test(p)).sort();
  const touched = basePaths.filter(p => (before[p] === undefined) !== (after[p] === undefined) || normalizeText(before[p] ?? '') !== normalizeText(after[p] ?? ''));
  if (touched.length) out.push(`Habilidades base (${[...new Set(touched.map(p => p.split('/')[1]))].join(', ')}): las habilidades base salen de las herramientas concedidas en Configuración; editarlas no concede nada y no se adoptan.`);
  return out;
}

/**
 * Adopta el cambio externo: la nueva revisión es lo que hay en disco, salvo arnés, permisos e id, que se reponen desde la
 * base (y se reescriben en la carpeta). Nombre, papel, resumen, responsabilidades y departamento pasan a la fila.
 */
export type RowPatch = { name: string; role: string; summary: string; responsibilities: string[]; initials: string; department: string | null; capabilities: string[] };
/** Aplica a la fila lo que se adopta y, si lo que sigue falla, la deja exactamente como estaba. */
function withRowRollback<T>(slug: string, agentId: string, onRow: (p: RowPatch) => void, patch: RowPatch, rest: () => T): T {
  const agents = agentsRepo(slug); const before = agents.get(agentId)!;
  if (patch.department !== null && (patch.department.trim().length < 2 || patch.department.trim().length > 60)) throw Object.assign(new Error('El departamento de la carpeta no es válido (2–60 caracteres).'), { statusCode: 400 });
  try { onRow(patch); return rest(); }
  catch (e) { try { agents.updateConfig(agentId, before.config); agents.updateTemplateMeta(agentId, before.template); } catch { /* se informa el error original */ } throw e; }
}
const rowPatchOf = (d: PortableAgentDefinition): RowPatch => ({ name: d.manifest.name, role: d.manifest.role, summary: d.manifest.summary, responsibilities: d.manifest.responsibilities, initials: d.manifest.initials, department: d.manifest.department, capabilities: d.manifest.capabilities });

/**
 * Adopta el cambio externo: la nueva revisión es lo que hay en disco, salvo arnés, permisos (herramientas y autonomía),
 * capacidades, id y memoria, que se reponen desde la base (y se reescriben en la carpeta). Nombre, papel, resumen,
 * responsabilidades y departamento pasan a la fila.
 */
export async function adoptExternal(slug: string, agentId: string, expectHash: string, onRow: (patch: RowPatch) => void): Promise<AgentRevision> {
  return withLock(`${slug}:${agentId}`, async () => {
    const a = agentsRepo(slug).get(agentId); if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
    const repo = agentFoldersRepo(slug); const f = repo.folderOf(agentId); const disk = f ? diskFiles(slug, f.folder) : null;
    if (!f || !disk) throw Object.assign(new Error('No hay carpeta que adoptar.'), { statusCode: 409 });
    if (hashFiles(disk.files) !== expectHash) throw Object.assign(new Error('La carpeta cambió otra vez mientras la revisabas: vuelve a revisarla.'), { statusCode: 409 });
    const parsed = filesToDefinition(disk.files);
    const blocking = parsed.problems.filter(p => p.blocking);
    if (!parsed.definition || blocking.length) throw Object.assign(new Error(`No se puede adoptar: ${blocking.map(p => `${p.path} — ${p.message}`).join(' · ') || 'carpeta no válida'}`), { statusCode: 400 });
    const d = parsed.definition; const current = adoptedExtras(slug, a);
    return withRowRollback(slug, agentId, onRow, rowPatchOf(d), () => {
      const fresh = agentsRepo(slug).get(agentId)!;
      const files = definitionToFiles(definitionFor(slug, fresh, { instructions: d.instructions, skills: d.skills, memory: [], knowledge: d.knowledge, deliverables: d.manifest.deliverables, autonomy: current.autonomy, changelog: d.changelog }));
      // El cambio externo sigue en disco: se escribe la revisión adoptada encima (la huella del disco ya se comprobó).
      const n = repo.begin(agentId, files, 'external', 'Cambio hecho fuera del Portal, revisado y adoptado por el propietario', 'owner');
      try { writeFiles(folderPath(slug, f.folder), files); } catch (e) { repo.abandon(agentId, n); throw e; }
      repo.adopt(agentId, n);
      return repo.revisions(agentId).find(r => r.n === n)!;
    });
  });
}

/** Descarta el cambio externo: la carpeta vuelve a la revisión adoptada (que está entera en la base). */
export async function discardExternal(slug: string, agentId: string): Promise<void> {
  await withLock(`${slug}:${agentId}`, () => {
    const repo = agentFoldersRepo(slug); const f = repo.folderOf(agentId); const ad = repo.adopted(agentId);
    if (!f || !ad) throw Object.assign(new Error('No hay revisión adoptada a la que volver.'), { statusCode: 409 });
    writeFiles(folderPath(slug, f.folder), ad.files);
    changed({ ws: slug, entity: 'agent', id: agentId });
  });
}

/**
 * Vuelve a una revisión anterior (nueva revisión «restore»). Lo propio de la carpeta (instrucciones, habilidades,
 * referencias) vuelve tal cual; la identidad pasa a la fila. Arnés, permisos, autonomía y memoria NO cambian con esto.
 */
export async function restoreRevision(slug: string, agentId: string, n: number, onRow: (patch: RowPatch) => void): Promise<AgentRevision> {
  return withLock(`${slug}:${agentId}`, () => {
    const repo = agentFoldersRepo(slug); const files = repo.revisionFiles(agentId, n);
    if (!files) throw Object.assign(new Error('Revisión no encontrada'), { statusCode: 404 });
    const d = filesToDefinition(files).definition; if (!d) throw Object.assign(new Error('La revisión no es válida.'), { statusCode: 400 });
    const a = agentsRepo(slug).get(agentId)!; const current = adoptedExtras(slug, a);
    return withRowRollback(slug, agentId, onRow, rowPatchOf(d), () => {
      const fresh = agentsRepo(slug).get(agentId)!;
      const out = definitionToFiles(definitionFor(slug, fresh, { instructions: d.instructions, skills: d.skills, memory: [], knowledge: d.knowledge, deliverables: d.manifest.deliverables, autonomy: current.autonomy, changelog: d.changelog }));
      return writeRevisionUnlocked(slug, agentId, out, 'restore', `Vuelta a la revisión ${n}`, 'owner');
    });
  });
}

/**
 * Escribe como revisión «import» unos archivos que llegan de fuera ya fusionados (p. ej. desde un ZIP). Bajo el cerrojo:
 * - 409 si la revisión adoptada ya no es `expectAdoptedN` (el agente cambió en el Portal desde la vista previa);
 * - 409 si la carpeta tiene un cambio externo sin revisar (nunca se pisa);
 * - 400 si hay secretos o problemas que bloquean, o si el id no es el de este agente.
 * Arnés, permisos, autonomía, capacidades, id y memoria se reponen desde la base (MEMORY.md es la proyección de las
 * lessons: quien importe crea antes las entradas nuevas). La identidad pasa a la fila; si algo falla, la fila se repone.
 * Si el resultado es idéntico a lo adoptado, no se crea revisión (`created: false`).
 */
export async function writeImportedRevision(slug: string, agentId: string, files: PortableFiles, expectAdoptedN: number | null, onRow: (patch: RowPatch) => void, note = 'Importado desde ZIP (adoptado automáticamente)', by = 'owner'): Promise<{ revision: AgentRevision; previousN: number | null; created: boolean }> {
  for (const [p, c] of Object.entries(files)) { const s = findSecret(c); if (s) throw Object.assign(new Error(`${p} contiene lo que parece una ${s}: las credenciales nunca van en la carpeta de un agente.`), { statusCode: 400 }); }
  return withLock(`${slug}:${agentId}`, () => {
    const a = agentsRepo(slug).get(agentId); if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
    resolveWriting(slug, agentId);
    const repo = agentFoldersRepo(slug); const f = repo.folderOf(agentId);
    if (!f) throw Object.assign(new Error('El agente aún no tiene carpeta.'), { statusCode: 409 });
    const adopted = repo.adopted(agentId); const previousN = adopted?.n ?? null;
    if (previousN !== expectAdoptedN) throw Object.assign(new Error('El agente cambió en el Portal desde la vista previa: vuelve a revisar la importación.'), { statusCode: 409, stale: true });
    const disk = diskFiles(slug, f.folder);
    if (adopted && disk && hashFiles(disk.files) !== adopted.hash) throw Object.assign(new Error('La carpeta del agente tiene cambios hechos fuera del Portal sin revisar: adóptalos o descártalos antes de importar.'), { statusCode: 409, external: true });
    const parsed = filesToDefinition(files);
    const blocking = parsed.problems.filter(p => p.blocking);
    if (!parsed.definition || blocking.length) throw Object.assign(new Error(`No se puede importar: ${blocking.map(p => `${p.path} — ${p.message}`).join(' · ') || 'carpeta no válida'}`), { statusCode: 400 });
    const d = parsed.definition;
    if (d.manifest.id && d.manifest.id !== agentId) throw Object.assign(new Error('El agente del ZIP no es este agente (su id es otro).'), { statusCode: 400 });
    const current = adoptedExtras(slug, a);
    return withRowRollback(slug, agentId, onRow, rowPatchOf(d), () => {
      // EN-014: si el ZIP declara ámbito se adopta; un ZIP antiguo sin ámbito conserva el del agente.
      const prevScope = a.contextScope ?? null;
      applyImportedContextScope(slug, agentId, files, false);
      try {
        const fresh = agentsRepo(slug).get(agentId)!;
        const out = definitionToFiles(definitionFor(slug, fresh, { instructions: d.instructions, skills: d.skills, memory: [], knowledge: d.knowledge, deliverables: d.manifest.deliverables, autonomy: current.autonomy, changelog: d.changelog }));
        const revision = writeRevisionUnlocked(slug, agentId, out, 'import', note, by);
        return { revision, previousN, created: revision.n !== previousN };
      } catch (e) {
        if (prevScope) { try { agentsRepo(slug).setContextScope(agentId, prevScope); } catch { /* se informa el error original */ } }
        throw e;
      }
    });
  });
}

/** Cambia lo propio de la carpeta (instrucciones, habilidades, memoria, referencias, entregables, autonomía). */
export async function updateExtras(slug: string, agentId: string, patch: Partial<AgentExtras>, source: RevisionSource, note: string): Promise<AgentRevision> {
  const a = agentsRepo(slug).get(agentId); if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
  await syncAgentFolder(slug, a);
  const cur = adoptedExtras(slug, a);
  const files = definitionToFiles(definitionFor(slug, a, { ...cur, ...patch }));
  return writeRevision(slug, agentId, files, source, note);
}

/**
 * Al eliminar un agente, su carpeta se mueve a `agents/_archivadas/` (no se borra y no la hereda un agente nuevo con el
 * mismo nombre). La fila de carpeta y sus revisiones se conservan en la base como historial.
 */
export function archiveAgentFolder(slug: string, agentId: string): string | null {
  const f = agentFoldersRepo(slug).folderOf(agentId); if (!f) return null;
  const from = folderPath(slug, f.folder); if (!fs.existsSync(from)) return null;
  const dest = path.join(agentsRoot(slug), '_archivadas', `${f.folder}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(from, dest);
  return dest;
}

// ---------------------------------------------------------------- EN-011 · Qué sabe hacer y qué aprendió (solo lectura)

const SANDBOX_OK = new Set(['docker', 'wsl', 'linux-ns']);

export interface AgentCapabilities {
  tools: (ToolCapability & { inFolder: boolean })[];
  sandbox: { checked: boolean; available: boolean; kind: string | null; detail: string; checkedAt: string | null };
  needsSandbox: boolean;
  note: string;
}

/**
 * Herramientas concedidas en lenguaje claro, dónde funcionan y si su habilidad base está en la revisión adoptada, más el
 * estado del sandbox que le pasa quien llama (`detectSandbox`, en caché). No ejecuta nada ni escribe nada.
 */
export function agentCapabilities(slug: string, a: Agent, sandbox: SandboxStatus | null): AgentCapabilities {
  const caps = toolCapabilities(grantedTools(a));
  const adopted = agentFoldersRepo(slug).adopted(a.id);
  const inFolder = new Set(Object.keys(adopted?.files ?? {}).map(p => /^skills\/([^/]+)\/SKILL\.md$/.exec(p)?.[1]).filter((s): s is string => !!s));
  return {
    tools: caps.map(t => ({ ...t, inFolder: !!t.skill && inFolder.has(t.skill) })),
    sandbox: sandbox
      ? { checked: true, available: SANDBOX_OK.has(sandbox.available), kind: sandbox.available, detail: sandbox.detail, checkedAt: sandbox.checkedAt }
      : { checked: false, available: false, kind: null, detail: 'No se pudo comprobar el sandbox ahora.', checkedAt: null },
    needsSandbox: caps.some(t => t.where.includes('sandbox')),
    note: 'Las habilidades no conceden permisos: las herramientas se cambian en Configuración.'
  };
}

export interface LearningEntry { id: string; title: string; text: string; detail: string; status: string; detector: string; at: string; processId: string | null; processTitle: string | null; link: 'evidencia' | 'paso' | null }
const PENDING_STATUS = new Set(['detected', 'proposed']);
const MAX_RELATED = 50;

/**
 * Aprendizaje del agente. `verified` = memoria verificada (memoryOf); `pending` = sus lecciones con agent_id aún sin
 * verificar; `related` = lecciones del proyecto (agent_id NULL) detectadas o propuestas cuyo vínculo con el agente es
 * exacto: la evidencia lo nombra ('evidencia') o el agente ejecutó un paso de ese proceso ('paso'). Solo lectura: nada
 * cambia de estado ni de agent_id, así que siguen en las listas del proyecto y esperan tu verificación.
 */
export function agentLearning(slug: string, agentId: string): { verified: MemoryEntry[]; pending: LearningEntry[]; related: LearningEntry[]; note: string } {
  const repo = lessonsRepo(slug);
  const entry = (l: Lesson, link: LearningEntry['link']): LearningEntry => ({
    id: l.id, title: l.title, text: l.lessonText ?? '', detail: l.evidence.detail ?? '', status: l.status, detector: l.detector, at: l.createdAt,
    processId: l.evidence.processId ?? null, processTitle: l.evidence.processTitle ?? null, link
  });
  const pending = repo.listForAgent(agentId).filter(l => PENDING_STATUS.has(l.status)).map(l => entry(l, null));
  const procs = processesRepo(slug); const took = new Map<string, boolean>();
  const tookPart = (pid: string): boolean => {
    let v = took.get(pid);
    if (v === undefined) { try { v = !!procs.get(pid)?.steps.some(s => s.agentId === agentId); } catch { v = false; } took.set(pid, v); }
    return v;
  };
  const related: LearningEntry[] = [];
  for (const l of repo.list(null, null)) {
    if (!PENDING_STATUS.has(l.status)) continue;
    const link: LearningEntry['link'] = l.evidence.agentId === agentId ? 'evidencia' : (l.evidence.processId && tookPart(l.evidence.processId) ? 'paso' : null);
    if (!link) continue;
    related.push(entry(l, link));
    if (related.length >= MAX_RELATED) break;
  }
  return { verified: memoryOf(slug, agentId), pending, related, note: 'Lo pendiente y lo relacionado sigue esperando tu verificación: nada se inyecta en los prompts hasta que lo verificas.' };
}

/** Registra la carpeta de un agente nuevo (sin escribir nada todavía): la primera revisión la escribe quien lo crea. */
export function registerAgentFolder(slug: string, a: Agent): string {
  const repo = agentFoldersRepo(slug); const f = repo.folderOf(a.id); if (f) return f.folder;
  const folder = freeFolderName(slug, a); repo.register(a.id, folder); return folder;
}

/**
 * EN-014 · Valida un ámbito pedido por la interfaz: al menos una opción. Con Proyecto, el proyecto tiene que existir en este
 * Portal, salvo que sea el que el agente ya tiene (se conserva aunque se haya borrado).
 */
export function validateContextScope(slug: string, raw: { project?: { id: string } | null; company?: boolean; general?: boolean }, current?: AgentContextScope | null): AgentContextScope {
  let project: ProjectRef | null = null;
  if (raw.project?.id) {
    const found = projectsOf(slug).find(p => p.id === raw.project!.id);
    if (found) project = found;
    else if (current?.project?.id === raw.project.id) project = current.project;
    else throw Object.assign(new Error('El proyecto elegido no existe en este Portal.'), { statusCode: 400 });
  }
  const scope: AgentContextScope = { project, company: raw.company === true, general: raw.general === true };
  if (!contextScopeOptions(scope).length) throw Object.assign(new Error('Elige al menos una opción de ámbito (Proyecto, Empresa o General).'), { statusCode: 400 });
  return scope;
}

/**
 * EN-014 · Cambia el ámbito de un agente: guarda la fila y regenera la carpeta (AGENTS.md por defecto, habilidades base y
 * agent.yaml), con una revisión «portal». Sin IA y sin costo; no cambia herramientas, permisos, arnés ni memoria. Si la
 * carpeta tiene cambios externos sin revisar, el ámbito se guarda y la carpeta se actualiza cuando se resuelvan.
 */
export async function updateContextScope(slug: string, agentId: string, raw: { project?: { id: string } | null; company?: boolean; general?: boolean }): Promise<{ agent: Agent; revision: AgentRevision | null; pendingExternal: boolean }> {
  const agents = agentsRepo(slug); const a = agents.get(agentId);
  if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
  const scope = validateContextScope(slug, raw, a.contextScope ?? null);
  const agent = agents.setContextScope(agentId, scope);
  const r = await syncAgentFolder(slug, agent, `Ámbito: ${contextScopeLabel(scope)} (no cambia herramientas, permisos, arnés ni memoria)`);
  changed({ ws: slug, entity: 'agent', id: agentId });
  return { agent, revision: r.revision, pendingExternal: r.pendingExternal };
}

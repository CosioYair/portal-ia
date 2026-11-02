import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PORTABLE_AGENT_SCHEMA, PORTABLE_LIMITS, allowedPortablePath, definitionToFiles, diffFiles, filesToDefinition, findSecret, normalizeText, slugify } from '@portal-ia/domain';
import type { Agent, HarnessId, MemoryEntry, PortableAgentDefinition, PortableFiles, PortableKnowledge, PortableSkill } from '@portal-ia/domain';
import { config } from '../config.ts';
import { agentsRepo, workspaceDb, workspaceDbPath } from '../db/workspace.ts';
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
  fs.mkdirSync(dir, { recursive: true });
  const root = fs.realpathSync(dir);
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

const DEFAULT_INSTRUCTIONS_MARK = '<!-- portal-ia: instrucciones por defecto; edítalas para darle instrucciones propias -->';
/** AGENTS.md que genera el Portal cuando el agente no tiene instrucciones propias (no se inyecta en los prompts). */
export function defaultInstructions(name: string, summary: string) { return `# ${name}\n\n${summary || 'Agente de Portal IA.'}\n\n${DEFAULT_INSTRUCTIONS_MARK}`; }
export const hasOwnInstructions = (text: string) => !!text.trim() && !text.includes(DEFAULT_INSTRUCTIONS_MARK);

/** El arnés de la carpeta: el backend concedido en la base (la API cuenta como «api»). */
const harnessOf = (a: Agent): HarnessId => (a.config.backend ?? 'api') as HarnessId;

export interface AgentExtras { instructions: string; skills: PortableSkill[]; memory: MemoryEntry[]; knowledge: PortableKnowledge[]; deliverables: string[]; autonomy: 'ask' | 'within_scope' }
const EMPTY_EXTRAS = (a: Agent): AgentExtras => ({ instructions: defaultInstructions(a.config.name, a.config.specialization), skills: [], memory: [], knowledge: [], deliverables: [], autonomy: 'ask' });

/** Definición portable a partir de la fila (lo concedido) y de lo propio de la carpeta (instrucciones, habilidades…). */
export function definitionFor(slug: string, a: Agent, extras: AgentExtras): PortableAgentDefinition {
  const dep = departmentsRepo(slug).departmentOf(a);
  return {
    manifest: {
      schema: PORTABLE_AGENT_SCHEMA, id: a.id, name: a.config.name, role: a.template.role, department: dep?.slug ?? null, initials: a.template.initials,
      summary: a.config.specialization, responsibilities: a.config.responsibilities, deliverables: extras.deliverables, capabilities: a.config.capabilities ?? [],
      harness: { preferred: harnessOf(a), model: a.config.model, effort: a.config.effort },
      permissions: { tools: Object.keys(a.config.tools).filter(k => a.config.tools[k]).sort(), autonomy: extras.autonomy },
      createdAt: a.createdAt
    },
    instructions: extras.instructions, skills: extras.skills, memory: memoryOf(slug, a.id), knowledge: extras.knowledge
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
  return { instructions: definition.instructions, skills: definition.skills, memory: [], knowledge: definition.knowledge, deliverables: definition.manifest.deliverables, autonomy: definition.manifest.permissions.autonomy };
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
  return withLock(`${slug}:${agentId}`, () => {
    resolveWriting(slug, agentId);
    const repo = agentFoldersRepo(slug); const f = repo.folderOf(agentId);
    if (!f) throw Object.assign(new Error('El agente aún no tiene carpeta.'), { statusCode: 409 });
    const adopted = repo.adopted(agentId); const disk = diskFiles(slug, f.folder);
    if (adopted && disk && hashFiles(disk.files) !== adopted.hash) throw Object.assign(new Error('La carpeta del agente tiene cambios hechos fuera del Portal sin revisar: adóptalos o descártalos antes de cambiar nada.'), { statusCode: 409, external: true });
    if (adopted && adopted.hash === hashFiles(files)) return adopted;
    const n = repo.begin(agentId, files, source, note, by);
    try { writeFiles(folderPath(slug, f.folder), files); } catch (e) { repo.abandon(agentId, n); throw e; }
    repo.adopt(agentId, n);
    return repo.revisions(agentId).find(r => r.n === n)!;
  });
}

/** Lo propio de la carpeta adoptada (o lo vacío si aún no tiene): lo que usan los prompts. */
export function adoptedExtras(slug: string, a: Agent): AgentExtras {
  const ad = agentFoldersRepo(slug).adopted(a.id);
  return (ad && extrasFromFiles(ad.files)) ?? EMPTY_EXTRAS(a);
}

/** Folder name único y estable a partir del nombre (no cambia si el agente se renombra). */
function freeFolderName(slug: string, a: Agent): string {
  // «<clave>-<id8>»: único (dos proyectos pueden tener su propio pj-dev), ASCII, corto y estable aunque se renombre.
  const agentId = a.id; const repo = agentFoldersRepo(slug); const base = slugify(`${a.key}-${a.id.slice(0, 8)}`); let candidate = base; let i = 2;
  const takenOnDisk = (c: string) => {
    const dir = folderPath(slug, c); if (!fs.existsSync(dir)) return false;
    // Una carpeta huérfana con el mismo id (migración interrumpida) se reutiliza; cualquier otra se respeta.
    try { const y = readFolder(dir).files['agent.yaml']; return !(y && y.includes(`id: ${agentId}`)); } catch { return true; }
  };
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
  const extras = (adopted && extrasFromFiles(adopted.files)) ?? EMPTY_EXTRAS(a);
  const files = definitionToFiles(definitionFor(slug, a, extras));
  if (!adopted) {
    const disk = diskFiles(slug, f.folder);
    // Carpeta preexistente del mismo agente (escritura anterior interrumpida): se adopta tal cual si es válida.
    if (disk && disk.files['agent.yaml']?.includes(`id: ${a.id}`) && filesToDefinition(disk.files).definition) {
      const n = repo.begin(a.id, disk.files, 'migrated', 'Carpeta existente del agente', 'portal'); repo.adopt(a.id, n);
      return { created, revision: repo.revisions(a.id)[0], pendingExternal: false };
    }
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

/** Migración al arrancar: todos los agentes del espacio con su carpeta. Idempotente; un error en uno no para los demás. */
export async function ensureAgentFolders(slug: string): Promise<{ created: number; failed: { agentId: string; error: string }[] }> {
  let created = 0; const failed: { agentId: string; error: string }[] = [];
  for (const a of agentsRepo(slug).list()) {
    try { if ((await syncAgentFolder(slug, a)).created) created++; } catch (e) { failed.push({ agentId: a.id, error: (e as Error).message }); }
  }
  return { created, failed };
}

/** Estado de la carpeta para la interfaz: adoptada, disco, cambio externo (con diff), problemas y revisiones. */
export function folderStatus(slug: string, a: Agent) {
  resolveWriting(slug, a.id);
  const repo = agentFoldersRepo(slug); const f = repo.folderOf(a.id);
  if (!f) return { folder: null, path: null, adopted: null, external: null, revisions: [], ignored: [] as string[] };
  const adopted = repo.adopted(a.id); const disk = diskFiles(slug, f.folder);
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
function notAdoptedChanges(before: PortableFiles, after: PortableFiles): string[] {
  const a = filesToDefinition(before).definition?.manifest; const b = filesToDefinition(after).definition?.manifest;
  if (!a || !b) return [];
  const out: string[] = [];
  if (a.harness.preferred !== b.harness.preferred || a.harness.model !== b.harness.model) out.push(`Arnés/modelo (${b.harness.preferred} · ${b.harness.model || 'predeterminado'}): se cambia en Configuración, con su comprobación y tu autorización.`);
  if (a.harness.effort !== b.harness.effort) out.push('Esfuerzo: se cambia en Configuración.');
  if (a.capabilities.join(',') !== b.capabilities.join(',')) out.push('Capacidades (qué papel tiene en el equipo de una historia): se cambian en Configuración, no desde la carpeta.');
  if (a.permissions.tools.join(',') !== b.permissions.tools.join(',')) out.push(`Herramientas (${b.permissions.tools.join(', ') || 'ninguna'}): se conceden en Configuración, nunca desde la carpeta.`);
  if (a.id !== b.id) out.push('El identificador (id) no se puede cambiar.');
  if (normalizeText(before['memory/MEMORY.md'] ?? '') !== normalizeText(after['memory/MEMORY.md'] ?? '')) out.push('Memoria: MEMORY.md refleja el aprendizaje que verificaste en el Portal; las ediciones del archivo no se adoptan (añade o retira aprendizaje desde la pestaña Memoria).');
  return out;
}

/**
 * Adopta el cambio externo: la nueva revisión es lo que hay en disco, salvo arnés, permisos e id, que se reponen desde la
 * base (y se reescriben en la carpeta). Nombre, papel, resumen, responsabilidades y departamento pasan a la fila.
 */
export async function adoptExternal(slug: string, agentId: string, expectHash: string, onRow: (patch: { name: string; role: string; summary: string; responsibilities: string[]; initials: string; department: string | null; capabilities: string[] }) => void): Promise<AgentRevision> {
  return withLock(`${slug}:${agentId}`, async () => {
    const a = agentsRepo(slug).get(agentId); if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
    const repo = agentFoldersRepo(slug); const f = repo.folderOf(agentId); const disk = f ? diskFiles(slug, f.folder) : null;
    if (!f || !disk) throw Object.assign(new Error('No hay carpeta que adoptar.'), { statusCode: 409 });
    if (hashFiles(disk.files) !== expectHash) throw Object.assign(new Error('La carpeta cambió otra vez mientras la revisabas: vuelve a revisarla.'), { statusCode: 409 });
    const parsed = filesToDefinition(disk.files);
    const blocking = parsed.problems.filter(p => p.blocking);
    if (!parsed.definition || blocking.length) throw Object.assign(new Error(`No se puede adoptar: ${blocking.map(p => `${p.path} — ${p.message}`).join(' · ') || 'carpeta no válida'}`), { statusCode: 400 });
    const d = parsed.definition;
    onRow({ name: d.manifest.name, role: d.manifest.role, summary: d.manifest.summary, responsibilities: d.manifest.responsibilities, initials: d.manifest.initials, department: d.manifest.department, capabilities: d.manifest.capabilities });
    const fresh = agentsRepo(slug).get(agentId)!;
    const files = definitionToFiles(definitionFor(slug, fresh, { instructions: d.instructions, skills: d.skills, memory: d.memory, knowledge: d.knowledge, deliverables: d.manifest.deliverables, autonomy: d.manifest.permissions.autonomy }));
    const n = repo.begin(agentId, files, 'external', 'Cambio hecho fuera del Portal, revisado y adoptado por el propietario', 'owner');
    try { writeFiles(folderPath(slug, f.folder), files); } catch (e) { repo.abandon(agentId, n); throw e; }
    repo.adopt(agentId, n);
    return repo.revisions(agentId).find(r => r.n === n)!;
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
 * memoria, referencias) vuelve tal cual; la identidad pasa a la fila. Arnés y permisos NO cambian con esto.
 */
export async function restoreRevision(slug: string, agentId: string, n: number, onRow: Parameters<typeof adoptExternal>[3]): Promise<AgentRevision> {
  const repo = agentFoldersRepo(slug); const files = repo.revisionFiles(agentId, n);
  if (!files) throw Object.assign(new Error('Revisión no encontrada'), { statusCode: 404 });
  const d = filesToDefinition(files).definition; if (!d) throw Object.assign(new Error('La revisión no es válida.'), { statusCode: 400 });
  onRow({ name: d.manifest.name, role: d.manifest.role, summary: d.manifest.summary, responsibilities: d.manifest.responsibilities, initials: d.manifest.initials, department: d.manifest.department, capabilities: d.manifest.capabilities });
  const fresh = agentsRepo(slug).get(agentId)!;
  const out = definitionToFiles(definitionFor(slug, fresh, { instructions: d.instructions, skills: d.skills, memory: d.memory, knowledge: d.knowledge, deliverables: d.manifest.deliverables, autonomy: d.manifest.permissions.autonomy }));
  return writeRevision(slug, agentId, out, 'restore', `Vuelta a la revisión ${n}`);
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

/** Registra la carpeta de un agente nuevo (sin escribir nada todavía): la primera revisión la escribe quien lo crea. */
export function registerAgentFolder(slug: string, a: Agent): string {
  const repo = agentFoldersRepo(slug); const f = repo.folderOf(a.id); if (f) return f.folder;
  const folder = freeFolderName(slug, a); repo.register(a.id, folder); return folder;
}

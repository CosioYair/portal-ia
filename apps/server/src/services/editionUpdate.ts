import fs from 'node:fs';
import path from 'node:path';
import type { AgentTemplatePractice, AgentTemplateVersion, PortableFiles } from '@portal-ia/domain';
import { backupDataDir, normalizeSchemaVersion, schemaGuard, type SchemaState } from '../config.ts';
import { workspaceDb } from '../db/workspace.ts';
import { isPinned, templatesRepo } from './agentTemplates.ts';
import { mergeThreeWay } from './agentZipImport.ts';

/**
 * HU-213 · Actualizar una Edición instalada con una Edición nueva del Estudio (sin IA y con vuelta atrás).
 * 1) Comprueba el esquema: si los datos son más nuevos que la Edición nueva, se bloquea con el motivo y no escribe nada.
 * 2) Hace la copia previa de data/ (backups/<fecha>_antes-de-<versión>) antes de cualquier escritura.
 * 3) Añade las versiones de plantilla clave@K que falten. Si una plantilla cambió en ambos lados, usa la fusión a tres
 *    bandas de agentZipImport.ts y los choques se informan como conflictos, sin crear nada. Nunca toca la tabla agents.
 * 4) Instala la interfaz nueva y guarda la anterior en apps/web/dist.prev; rollback la restaura.
 * Quien llama pasa las rutas: aquí no se usa la raíz global del servidor.
 */

export const EDITION_TEMPLATES_FILE = 'edition-templates.json';
const fail = (msg: string, statusCode = 409) => Object.assign(new Error(msg), { statusCode });

export type IncomingTemplate = Omit<AgentTemplateVersion, 'id' | 'createdAt'>;
type TemplateContent = Pick<AgentTemplateVersion, 'name' | 'role' | 'responsibilities' | 'practices'>;
export interface TemplateConflict { slug: string; key: string; ours: string; theirs: string; paths: string[] }

export interface EditionCheck { blocked: boolean; reason: string | null; state: SchemaState | null; data: string; program: string; commit: string | null }
export interface EditionUpdateReport {
  blocked: boolean; reason: string | null; upToDate: boolean; data: string; program: string; commit: string | null;
  backup: string | null; templatesAdded: string[]; conflicts: TemplateConflict[]; pinnedUntouched: string[]; distPrev: string | null
}

// ---------------------------------------------------------------- Comprobación (no escribe nada)

export function readBuildCommit(dist: string): string | null {
  try {
    const c = (JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json'), 'utf8')) as { commit?: unknown }).commit;
    return typeof c === 'string' && c.trim() ? c.trim() : null;
  } catch { return null; }
}

/** Versión de esquema que trae la Edición nueva (la constante DATA_SCHEMA_VERSION de su config.ts). */
export function readEditionSchemaVersion(newRoot: string): string | null {
  try {
    const src = fs.readFileSync(path.join(newRoot, 'apps', 'server', 'src', 'config.ts'), 'utf8');
    const m = src.match(/DATA_SCHEMA_VERSION\s*=\s*['"]([^'"]+)['"]/);
    return m && m[1] ? normalizeSchemaVersion(m[1]) : null;
  } catch { return null; }
}

export function checkUpdate(newRoot: string, dataDir: string): EditionCheck {
  const commit = readBuildCommit(path.join(newRoot, 'apps', 'web', 'dist'));
  const program = readEditionSchemaVersion(newRoot);
  if (!program) return { blocked: true, reason: `No se encuentra la versión de esquema de la Edición nueva en ${path.join(newRoot, 'apps', 'server', 'src', 'config.ts')}.`, state: null, data: '', program: '', commit };
  if (!fs.existsSync(path.join(newRoot, 'apps', 'web', 'dist', 'index.html'))) return { blocked: true, reason: 'La Edición nueva no trae la interfaz compilada (apps/web/dist/index.html).', state: null, data: '', program, commit };
  const g = schemaGuard(dataDir, program);
  return { blocked: g.state === 'mas-nuevo', reason: g.reason, state: g.state, data: g.data, program, commit };
}

// ---------------------------------------------------------------- Plantillas clave@K

const toFiles = (v: TemplateContent): PortableFiles => ({
  'name.txt': v.name, 'role.txt': v.role,
  'responsibilities.txt': v.responsibilities.join('\n'),
  'practices.jsonl': v.practices.map(p => JSON.stringify({ lessonId: p.lessonId, text: p.text, title: p.title, addedAt: p.addedAt })).join('\n')
});
const lines = (t: string | undefined) => (t ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
const fromFiles = (f: PortableFiles): TemplateContent => ({
  name: (f['name.txt'] ?? '').trim(), role: (f['role.txt'] ?? '').trim(),
  responsibilities: lines(f['responsibilities.txt']),
  practices: lines(f['practices.jsonl']).map(l => JSON.parse(l) as AgentTemplatePractice)
});
const sameContent = (a: TemplateContent, b: TemplateContent) => JSON.stringify(fromFiles(toFiles(a))) === JSON.stringify(fromFiles(toFiles(b)));

/** Plantillas que trae la Edición nueva (edition-templates.json en su raíz; si no existe, ninguna). */
export function readIncomingTemplates(newRoot: string): IncomingTemplate[] {
  const file = path.join(newRoot, EDITION_TEMPLATES_FILE);
  if (!fs.existsSync(file)) return [];
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail(`${EDITION_TEMPLATES_FILE} no es JSON válido.`, 400); }
  if (!Array.isArray(raw)) throw fail(`${EDITION_TEMPLATES_FILE} debe ser una lista de versiones de plantilla.`, 400);
  return raw.map((r: any, i: number): IncomingTemplate => {
    const ok = r && typeof r.key === 'string' && r.key.trim() && Number.isInteger(r.version) && r.version > 0
      && typeof r.name === 'string' && typeof r.role === 'string' && Array.isArray(r.responsibilities) && Array.isArray(r.practices);
    if (!ok) throw fail(`${EDITION_TEMPLATES_FILE}: la entrada ${i + 1} no es una versión de plantilla válida.`, 400);
    return {
      key: r.key, version: r.version, name: r.name, role: r.role, responsibilities: r.responsibilities.map(String), practices: r.practices as AgentTemplatePractice[],
      diffMd: typeof r.diffMd === 'string' ? r.diffMd : '', source: typeof r.source === 'string' ? r.source : 'edition-update',
      lessonId: typeof r.lessonId === 'string' ? r.lessonId : null, createdBy: typeof r.createdBy === 'string' ? r.createdBy : 'studio'
    };
  });
}

/**
 * Añade las versiones clave@K que falten. Si una versión existe en local con otro contenido (la Edición creó su propia
 * clave@N), fusiona a tres bandas (base = última versión común, ours = la local más reciente, theirs = la del Estudio más
 * reciente): sin choques crea la versión siguiente; con choques la informa y no crea nada. Nunca toca la tabla agents.
 */
export function applyTemplateUpdates(slug: string, incoming: IncomingTemplate[]): { added: string[]; conflicts: TemplateConflict[] } {
  const repo = templatesRepo(slug); const added: string[] = []; const conflicts: TemplateConflict[] = [];
  const byKey = new Map<string, IncomingTemplate[]>();
  for (const v of incoming) byKey.set(v.key, [...(byKey.get(v.key) ?? []), v]);
  for (const [key, list0] of byKey) {
    const list = [...list0].sort((a, b) => a.version - b.version);
    const local = repo.versions(key);
    const localBy = new Map(local.map(v => [v.version, v] as const));
    const diverged = list.some(v => { const l = localBy.get(v.version); return !!l && !sameContent(l, v); });
    if (!diverged) {
      for (const v of list) {
        if (localBy.has(v.version)) continue;
        repo.insert({ ...v, key });
        added.push(`${key}@${v.version}`);
      }
      continue;
    }
    let base: IncomingTemplate | null = null;
    for (const v of list) { const l = localBy.get(v.version); if (l && sameContent(l, v)) base = v; }
    const ours = local[local.length - 1]; const theirs = list[list.length - 1];
    if (!ours || !theirs) continue;
    const r = mergeThreeWay(base ? toFiles(base) : {}, toFiles(ours), toFiles(theirs));
    if (r.conflicts.length) {
      conflicts.push({ slug, key, ours: ours.id, theirs: `${key}@${theirs.version}`, paths: r.conflicts.map(c => c.path) });
      continue;
    }
    const merged = fromFiles(r.merged);
    if (sameContent(merged, ours)) continue; // ya fusionada antes: nada que hacer
    const next = ours.version + 1;
    repo.insert({
      key, version: next, ...merged,
      diffMd: `Fusión a tres bandas · base ${base ? `${key}@${base.version}` : '(ninguna)'} · local ${ours.id} · Estudio ${key}@${theirs.version}`,
      source: 'edition-update', lessonId: null, createdBy: 'edition-update'
    });
    added.push(`${key}@${next}`);
  }
  return { added, conflicts };
}

function agentVersions(slug: string): Map<string, string | null> {
  try {
    const rows = workspaceDb(slug).prepare('SELECT id, template_version AS tv FROM agents').all() as { id: string; tv: string | null }[];
    return new Map(rows.map(r => [r.id, r.tv ?? null] as const));
  } catch { return new Map(); }
}

// ---------------------------------------------------------------- Interfaz y vuelta atrás

/** Instala `newDist` como apps/web/dist y guarda la anterior en apps/web/dist.prev (sustituye la dist.prev anterior). */
export function swapDist(root: string, newDist: string): string | null {
  if (!fs.existsSync(path.join(newDist, 'index.html'))) throw fail(`Falta ${path.join(newDist, 'index.html')}: no se cambia la interfaz.`);
  const web = path.join(root, 'apps', 'web');
  const dist = path.join(web, 'dist'); const prev = path.join(web, 'dist.prev'); const next = path.join(web, 'dist.next');
  fs.rmSync(next, { recursive: true, force: true });
  fs.cpSync(newDist, next, { recursive: true });
  let distPrev: string | null = null;
  if (fs.existsSync(dist)) {
    fs.rmSync(prev, { recursive: true, force: true });
    fs.renameSync(dist, prev);
    distPrev = prev;
  }
  fs.renameSync(next, dist);
  return distPrev;
}

/** Copia más reciente de data/backups (la que hay que restaurar a mano si se quiere deshacer también los datos). */
export function latestBackup(dataDir: string): string | null {
  const dir = path.join(dataDir, 'backups');
  try {
    const names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
    const last = names[names.length - 1];
    return last ? path.join(dir, last) : null;
  } catch { return null; }
}

/** Devuelve apps/web/dist.prev a apps/web/dist. No toca los datos: indica la carpeta de copia que hay que restaurar. */
export function rollback(root: string, dataDir: string): { restored: string; backup: string | null } {
  const web = path.join(root, 'apps', 'web');
  const dist = path.join(web, 'dist'); const prev = path.join(web, 'dist.prev');
  if (!fs.existsSync(path.join(prev, 'index.html'))) throw fail('No hay interfaz anterior (apps/web/dist.prev): no se puede volver atrás.', 404);
  fs.rmSync(dist, { recursive: true, force: true });
  fs.renameSync(prev, dist);
  return { restored: dist, backup: latestBackup(dataDir) };
}

// ---------------------------------------------------------------- Orquestación

export interface EditionUpdateOptions { root: string; newRoot: string; dataDir: string; slugs: string[] }

export function updateEdition(o: EditionUpdateOptions): EditionUpdateReport {
  const check = checkUpdate(o.newRoot, o.dataDir);
  const report: EditionUpdateReport = {
    blocked: check.blocked, reason: check.reason, upToDate: false, data: check.data, program: check.program, commit: check.commit,
    backup: null, templatesAdded: [], conflicts: [], pinnedUntouched: [], distPrev: null
  };
  if (check.blocked) return report;
  const sameRoot = path.resolve(o.root) === path.resolve(o.newRoot);
  const current = readBuildCommit(path.join(o.root, 'apps', 'web', 'dist'));
  if (check.state === 'igual' && check.commit && check.commit === current) { report.upToDate = true; return report; }
  const incoming = readIncomingTemplates(o.newRoot); // valida antes de escribir
  // Copia previa ANTES de cualquier escritura; si falla, lanza y no se cambia nada.
  report.backup = backupDataDir(o.dataDir, check.program);
  for (const slug of o.slugs) {
    const before = agentVersions(slug);
    const pinned = [...before.keys()].filter(id => isPinned(slug, id));
    const r = applyTemplateUpdates(slug, incoming);
    report.templatesAdded.push(...r.added.map(id => `${slug}:${id}`));
    report.conflicts.push(...r.conflicts);
    const after = agentVersions(slug);
    for (const id of pinned) if (after.get(id) === before.get(id)) report.pinnedUntouched.push(`${slug}:${id}`);
  }
  if (!sameRoot) report.distPrev = swapDist(o.root, path.join(o.newRoot, 'apps', 'web', 'dist'));
  return report;
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXTERNAL_TEXT_LIMIT, EXTERNAL_TOTAL_LIMIT, findSecret, isIdentityPath, isIgnoredExternalDir, normalizeText, parseSkillHeader,
  type Agent, type ExecutionBackend, type ExternalFileChange, type ExternalGrants, type ExternalLayout, type ExternalProvenance, type IntegrationState
} from '@portal-ia/domain';
import { agentsRepo, workspaceDb } from '../db/workspace.ts';
import { createAgentFromWizard, localDir } from './agentCreation.ts';
import { recordAgentEvent } from './agentEvents.ts';
import { changed } from './live.ts';
import { monotonicNow } from '../clock.ts';

/**
 * Agentes externos como REFERENCIA GESTIONADA (docs/agentes-externos.md).
 *
 * - La carpeta original es la fuente de verdad: el Portal no la copia, no la reinicializa y no sustituye sus archivos.
 * - Al importar se detecta su estructura (mapa), se enseña TODO lo que entraría en los prompts y se guarda una
 *   instantánea adoptada (texto de sus instrucciones, contexto, habilidades y memoria, y la huella de sus scripts).
 * - Los prompts usan la instantánea adoptada, nunca lo que haya en disco: un cambio hecho fuera se detecta y el
 *   propietario lo adopta (o no) explícitamente; un script cambiado fuera no se ejecuta hasta adoptarlo.
 * - Nada se sigue a través de enlaces (symlinks/junctions) ni de enlaces físicos; toda ruta escrita se comprueba dentro
 *   de la raíz y de la zona concedida (entregables/entradas, o identidad SOLO al aplicar una mejora aprobada).
 * - Una carpeta solo se importa una vez (ruta real única).
 */
const now = monotonicNow;
const MAX_ENTRIES = 4000;
const MAX_DEPTH = 6;
/** Directorios de trabajo que nunca forman parte de la identidad (se registran en el mapa, no se leen). */
const WORK_DIRS = { inbox: 'bandeja-de-entrada', outputs: 'documentos', backups: 'configuracion/respaldos' } as const;

export type SnapshotFiles = Record<string, string>;
interface SourceRow { agentId: string; root: string; layout: ExternalLayout; provenance: ExternalProvenance; state: IntegrationState; grants: ExternalGrants; adoptedHash: string; revision: number; createdAt: string; updatedAt: string }
export interface SourceRevision { n: number; hash: string; source: 'import' | 'external' | 'improvement' | 'restore'; note: string; by: string; at: string }

const ensured = new Set<string>();
function ensure(slug: string) {
  const db = workspaceDb(slug);
  if (ensured.has(slug)) return db;
  ensured.add(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_sources (
    agent_id TEXT PRIMARY KEY, root TEXT NOT NULL, root_key TEXT NOT NULL UNIQUE, layout_json TEXT NOT NULL, provenance_json TEXT NOT NULL,
    state TEXT NOT NULL, grants_json TEXT NOT NULL, adopted_n INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS agent_source_revisions (
    agent_id TEXT NOT NULL, n INTEGER NOT NULL, hash TEXT NOT NULL, files_json TEXT NOT NULL, source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    by TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (agent_id, n)
  );`);
  return db;
}
const rootKey = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/[\\/]+$/, '');
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const err = (msg: string, statusCode: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(msg), { statusCode, ...extra });

export function snapshotHash(files: SnapshotFiles): string {
  const h = crypto.createHash('sha256');
  for (const p of Object.keys(files).sort()) h.update(p).update('\u0000').update(normalizeText(files[p])).update('\u0000');
  return h.digest('hex');
}
const fileHash = (text: string) => sha(normalizeText(text));

// ---------------------------------------------------------------- Lectura segura de la carpeta

export interface ScanResult { root: string; files: SnapshotFiles; layout: ExternalLayout; links: string[]; problems: { path: string; message: string; blocking: boolean }[]; otherFiles: number }

const insideRoot = (root: string, p: string) => { const r = path.relative(root, p); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };

/** Recorre la carpeta sin seguir enlaces y lee SOLO los archivos de identidad (con límites). */
export function scanExternal(dir: string): ScanResult {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw err('Elige una carpeta normal (no un enlace).', 400);
  const root = fs.realpathSync.native(dir);
  const files: SnapshotFiles = {}; const links: string[] = []; const ignored: string[] = []; const problems: ScanResult['problems'] = [];
  const dirs = new Set<string>(); let seen = 0; let total = 0; let otherFiles = 0;
  const walk = (abs: string, rel: string, depth: number) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (++seen > MAX_ENTRIES) throw err('La carpeta tiene demasiadas entradas para importarla como agente.', 400);
      const r = rel ? `${rel}/${e.name}` : e.name; const a = path.join(abs, e.name);
      const l = fs.lstatSync(a);
      if (l.isSymbolicLink()) { links.push(r); continue; } // en Windows las junctions también son enlaces: no se siguen
      if (l.isDirectory()) {
        if (isIgnoredExternalDir(e.name)) { ignored.push(`${r}/`); continue; }
        dirs.add(r);
        // Entregables, entradas y copias no son identidad: se registran en el mapa, no se leen.
        if (r === WORK_DIRS.inbox || r === WORK_DIRS.outputs || r === WORK_DIRS.backups) continue;
        if (depth >= MAX_DEPTH) { ignored.push(`${r}/…`); continue; }
        walk(a, r, depth + 1); continue;
      }
      if (!l.isFile()) continue;
      if (!isIdentityPath(r)) { otherFiles++; continue; }
      if (l.nlink > 1) { problems.push({ path: r, message: 'Es un enlace físico: puede apuntar fuera de la carpeta. No se lee.', blocking: false }); continue; }
      if (!insideRoot(root, fs.realpathSync.native(a))) { links.push(r); continue; }
      if (l.size > EXTERNAL_TEXT_LIMIT) { problems.push({ path: r, message: `Demasiado grande (${Math.round(l.size / 1024)} KB, máx. ${EXTERNAL_TEXT_LIMIT / 1024} KB): no se lee.`, blocking: false }); continue; }
      total += l.size; if (total > EXTERNAL_TOTAL_LIMIT) throw err('La identidad del agente (instrucciones, habilidades, scripts) es demasiado grande.', 400);
      files[r] = fs.readFileSync(a, 'utf8');
    }
  };
  walk(root, '', 0);
  if (!files['AGENTS.md']) throw err('No parece un agente: falta AGENTS.md en la raíz de la carpeta (sus instrucciones).', 400);
  for (const [p, c] of Object.entries(files)) { const s = findSecret(c); if (s) problems.push({ path: p, message: `Contiene lo que parece una ${s}: no se importará hasta quitarla.`, blocking: true }); }
  const skillSlugs = [...new Set(Object.keys(files).map(p => /^skills\/([^/]+)\/SKILL\.md$/i.exec(p)?.[1]).filter((s): s is string => !!s))].sort();
  const layout: ExternalLayout = {
    identity: 'AGENTS.md',
    adapters: Object.keys(files).filter(p => /^(CLAUDE|COMO_EMPEZAR|README)\.md$/i.test(p)).sort(),
    context: Object.keys(files).filter(p => /^contexto\//i.test(p)).sort(),
    skills: skillSlugs.map(s => {
      const body = files[`skills/${s}/SKILL.md`] ?? Object.entries(files).find(([k]) => k.toLowerCase() === `skills/${s}/skill.md`)?.[1] ?? '';
      const h = parseSkillHeader(body);
      return { slug: s, path: `skills/${s}/SKILL.md`, name: h.name ?? s, description: h.description ?? '', version: h.version, scripts: Object.keys(files).filter(p => p.startsWith(`skills/${s}/scripts/`) && p.endsWith('.py')).sort() };
    }),
    memory: Object.keys(files).filter(p => /^memoria\//i.test(p)).sort()[0] ?? null,
    inbox: dirs.has(WORK_DIRS.inbox) ? WORK_DIRS.inbox : null,
    outputs: dirs.has(WORK_DIRS.outputs) ? WORK_DIRS.outputs : null,
    backups: dirs.has(WORK_DIRS.backups) ? WORK_DIRS.backups : null,
    ignored: ignored.sort()
  };
  if (links.length) problems.push({ path: links.slice(0, 5).join(', '), message: `${links.length} enlace(s) (symlink/junction) no se siguen ni se leen.`, blocking: false });
  // Código que sus scripts importan y que no se lee como texto (.dependencias): queda fijado por su huella; si cambia fuera
  // del Portal, se ve como cambio externo y sus scripts no se ejecutan hasta adoptarlo.
  const deps = path.join(root, '.dependencias');
  try { if (fs.lstatSync(deps).isDirectory()) files[DEPS_KEY] = dependencyDigest(deps); } catch { /* sin dependencias propias */ }
  return { root, files, layout, links, problems, otherFiles };
}

/** Clave de la huella de `.dependencias` en la instantánea (no es un archivo: nunca se escribe ni se restaura). */
export const DEPS_KEY = '@dependencias';
const depsCache = new Map<string, { sig: string; digest: string }>();
/** Huella de un árbol de dependencias (contenido de cada archivo; los enlaces cuentan como cambio), con caché por firma. */
export function dependencyDigest(dir: string): string {
  const entries: { rel: string; abs: string; size: number; mtime: number; link: boolean }[] = [];
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 12 || entries.length > 20_000) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name); const r = rel ? `${rel}/${e.name}` : e.name; const l = fs.lstatSync(a);
      if (l.isSymbolicLink()) entries.push({ rel: r, abs: a, size: -1, mtime: 0, link: true });
      else if (l.isDirectory()) walk(a, r, depth + 1);
      else if (l.isFile()) entries.push({ rel: r, abs: a, size: l.size, mtime: l.mtimeMs, link: false });
    }
  };
  walk(dir, '', 0);
  entries.sort((x, y) => x.rel.localeCompare(y.rel));
  const sig = entries.map(e => `${e.rel}:${e.size}:${e.mtime}:${e.link ? 'L' : ''}`).join('|');
  const c = depsCache.get(dir); if (c && c.sig === sig) return c.digest;
  const h = crypto.createHash('sha256');
  for (const e of entries) { h.update(e.rel).update('\u0000'); if (e.link) h.update('ENLACE'); else h.update(fs.readFileSync(e.abs)); h.update('\u0000'); }
  const digest = `${entries.length} archivos · sha256 ${h.digest('hex')}`;
  depsCache.set(dir, { sig, digest });
  return digest;
}

// ---------------------------------------------------------------- Repositorio

export function sourcesRepo(slug: string) {
  const db = ensure(slug);
  const map = (r: any): SourceRow => ({ agentId: r.agent_id, root: r.root, layout: JSON.parse(r.layout_json), provenance: JSON.parse(r.provenance_json), state: r.state, grants: JSON.parse(r.grants_json), adoptedHash: '', revision: r.adopted_n, createdAt: r.created_at, updatedAt: r.updated_at });
  return {
    get(agentId: string): SourceRow | null {
      const r = db.prepare(`SELECT s.*, v.hash FROM agent_sources s JOIN agent_source_revisions v ON v.agent_id = s.agent_id AND v.n = s.adopted_n WHERE s.agent_id = ?`).get(agentId) as any;
      return r ? { ...map(r), adoptedHash: r.hash } : null;
    },
    byRoot(root: string): { agentId: string } | null { const r = db.prepare(`SELECT agent_id FROM agent_sources WHERE root_key = ?`).get(rootKey(root)) as any; return r ? { agentId: r.agent_id } : null; },
    list(): string[] { return (db.prepare(`SELECT agent_id FROM agent_sources`).all() as any[]).map(r => r.agent_id); },
    files(agentId: string, n?: number): SnapshotFiles | null {
      const r = db.prepare(n ? `SELECT n, files_json FROM agent_source_revisions WHERE agent_id = ? AND n = ?` : `SELECT v.n, v.files_json FROM agent_source_revisions v JOIN agent_sources s ON s.agent_id = v.agent_id AND s.adopted_n = v.n WHERE v.agent_id = ?`).get(...(n ? [agentId, n] : [agentId])) as any;
      if (!r) return null;
      // Las revisiones no cambian: se analizan una vez (los prompts y la oficina las piden a menudo).
      const key = `${slug}:${agentId}:${r.n}`; const hit = parsedCache.get(key); if (hit) return { ...hit };
      const files = JSON.parse(r.files_json) as SnapshotFiles; parsedCache.set(key, files); if (parsedCache.size > 64) parsedCache.delete(parsedCache.keys().next().value!);
      return { ...files };
    },
    revisions(agentId: string): SourceRevision[] { return (db.prepare(`SELECT n, hash, source, note, by, at FROM agent_source_revisions WHERE agent_id = ? ORDER BY n DESC`).all(agentId) as any[]).map(r => ({ n: r.n, hash: r.hash, source: r.source, note: r.note, by: r.by, at: r.at })); },
    insert(agentId: string, root: string, layout: ExternalLayout, provenance: ExternalProvenance, grants: ExternalGrants, files: SnapshotFiles) {
      db.exec('BEGIN');
      try {
        db.prepare(`INSERT INTO agent_sources (agent_id, root, root_key, layout_json, provenance_json, state, grants_json, adopted_n, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?)`)
          .run(agentId, root, rootKey(root), JSON.stringify(layout), JSON.stringify(provenance), JSON.stringify(grants), now(), now());
        db.prepare(`INSERT INTO agent_source_revisions (agent_id, n, hash, files_json, source, note, by, at) VALUES (?, 1, ?, ?, 'import', ?, 'owner', ?)`)
          .run(agentId, snapshotHash(files), JSON.stringify(files), 'Instantánea adoptada al importar (revisada por el propietario)', now());
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    /** Nueva revisión adoptada (y mapa actualizado) en una transacción. */
    adopt(agentId: string, files: SnapshotFiles, layout: ExternalLayout, source: SourceRevision['source'], note: string, by = 'owner'): number {
      db.exec('BEGIN');
      try {
        const n = ((db.prepare(`SELECT MAX(n) AS n FROM agent_source_revisions WHERE agent_id = ?`).get(agentId) as any)?.n ?? 0) + 1;
        db.prepare(`INSERT INTO agent_source_revisions (agent_id, n, hash, files_json, source, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(agentId, n, snapshotHash(files), JSON.stringify(files), source, note, by, now());
        db.prepare(`UPDATE agent_sources SET adopted_n = ?, layout_json = ?, updated_at = ? WHERE agent_id = ?`).run(n, JSON.stringify(layout), now(), agentId);
        db.exec('COMMIT');
        changed({ ws: slug, entity: 'agent', id: agentId });
        return n;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    setState(agentId: string, state: IntegrationState) { db.prepare(`UPDATE agent_sources SET state = ?, updated_at = ? WHERE agent_id = ?`).run(state, now(), agentId); changed({ ws: slug, entity: 'agent', id: agentId }); },
    setGrants(agentId: string, grants: ExternalGrants) { db.prepare(`UPDATE agent_sources SET grants_json = ?, updated_at = ? WHERE agent_id = ?`).run(JSON.stringify(grants), now(), agentId); changed({ ws: slug, entity: 'agent', id: agentId }); }
  };
}

const parsedCache = new Map<string, SnapshotFiles>();
export const externalSource = (slug: string, agentId: string) => { try { return sourcesRepo(slug).get(agentId); } catch { return null; } };

/**
 * Al eliminar un agente externo, su fuente se RETIRA (no se borra: procedencia, revisiones y eventos quedan como
 * historial) y su carpeta se puede volver a integrar más tarde.
 */
export function retireSource(slug: string, agentId: string) {
  const db = ensure(slug);
  const r = db.prepare(`SELECT root_key FROM agent_sources WHERE agent_id = ?`).get(agentId) as any; if (!r || String(r.root_key).includes('#retirado-')) return;
  db.prepare(`UPDATE agent_sources SET root_key = ?, updated_at = ? WHERE agent_id = ?`).run(`${r.root_key}#retirado-${Date.now()}`, now(), agentId);
}

// ---------------------------------------------------------------- Vista previa e importación

const firstHeading = (md: string) => /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? null;
const firstParagraph = (md: string) => md.replace(/^---[\s\S]*?---\s*/, '').split(/\n\s*\n/).map(s => s.trim()).find(s => s && !s.startsWith('#') && !s.startsWith('@')) ?? '';

export function externalPreview(slug: string, dir: string) {
  const abs = localDir(dir);
  const scan = scanExternal(abs);
  const dup = sourcesRepo(slug).byRoot(scan.root);
  const dupAgent = dup ? agentsRepo(slug).get(dup.agentId) : null;
  const f = scan.files;
  return {
    path: scan.root, hash: snapshotHash(f), layout: scan.layout, links: scan.links, problems: scan.problems, otherFiles: scan.otherFiles,
    ok: !scan.problems.some(p => p.blocking) && !dup,
    duplicate: dup ? { agentId: dup.agentId, name: dupAgent?.config.name ?? '(agente)' } : null,
    suggested: { name: (firstHeading(f['AGENTS.md']) ?? path.basename(scan.root)).slice(0, 80), summary: firstParagraph(f['AGENTS.md']).slice(0, 600) },
    // Lo que entraría en sus prompts, completo, para leerlo ANTES de importar.
    prompt: {
      instructions: f['AGENTS.md'],
      context: scan.layout.context.map(p => ({ path: p, text: f[p] })),
      skills: scan.layout.skills.map(s => ({ ...s, body: f[s.path] ?? '' })),
      memory: scan.layout.memory ? { path: scan.layout.memory, text: f[scan.layout.memory] } : null
    },
    adapters: scan.layout.adapters.map(p => ({ path: p, text: f[p] })),
    scripts: Object.keys(f).filter(p => p.endsWith('.py')).sort().map(p => ({ path: p, sha256: fileHash(f[p]), bytes: Buffer.byteLength(f[p]) })),
    note: 'La carpeta original sigue siendo la fuente: el Portal no la copia ni la reescribe. Lo que entra en los prompts es esta instantánea; si la carpeta cambia fuera del Portal, verás el cambio y decidirás si adoptarlo. Los permisos se conceden aquí, por ruta.'
  };
}

export interface ExternalImportInput {
  path: string; hash: string; name: string; role: string; summary: string; department: string;
  harness: ExecutionBackend; model: string; effort: 'low' | 'medium' | 'high'; grants: ExternalGrants; authorized: boolean;
}

export async function importExternal(slug: string, i: ExternalImportInput, by = 'owner'): Promise<Agent> {
  if (!i.authorized) throw err('Importar un agente requiere tu confirmación explícita.', 403);
  if (i.harness === 'api' || i.harness === 'claude-code-terminal') throw err('Un agente externo trabaja con Claude Code gestionado (tu suscripción), no con la API facturable ni con la consola.', 400);
  const abs = localDir(i.path);
  const scan = scanExternal(abs);
  if (sourcesRepo(slug).byRoot(scan.root)) throw err('Esa carpeta ya está importada como agente: no se duplica.', 409, { code: 'duplicate' });
  if (snapshotHash(scan.files) !== i.hash) throw err('La carpeta cambió desde la vista previa: vuelve a revisarla.', 409);
  const blocking = scan.problems.filter(p => p.blocking);
  if (blocking.length) throw err(`No se puede importar: ${blocking.map(p => `${p.path} — ${p.message}`).join(' · ')}`, 400);
  const agent = await createAgentFromWizard(slug, {
    name: i.name, role: i.role, summary: i.summary, responsibilities: [], deliverables: [], department: i.department, scope: 'workspace', projectId: null,
    harness: i.harness, model: i.model, effort: i.effort, tools: [], knowledge: [], capabilities: [], autonomy: 'ask', instructions: null, authorized: true
  }, 'import');
  const provenance: ExternalProvenance = { origin: 'external-folder', path: scan.root, importedAt: now(), importedBy: by, originalHash: snapshotHash(scan.files), note: 'Importado como referencia gestionada: la carpeta original es la fuente de verdad.' };
  try { sourcesRepo(slug).insert(agent.id, scan.root, scan.layout, provenance, i.grants, scan.files); }
  catch (e: any) {
    // Dos importaciones a la vez de la misma carpeta: la segunda no deja un agente huérfano.
    try { const { deleteAgent } = await import('./agentFactory.ts'); deleteAgent(slug, agent.id); } catch { /* queda como agente sin fuente; se informa */ }
    if (/UNIQUE/i.test(String(e?.message))) throw err('Esa carpeta ya está importada como agente: no se duplica.', 409, { code: 'duplicate' });
    throw e;
  }
  recordAgentEvent(slug, agent.id, 'source_imported', { provenance, hash: provenance.originalHash, layout: summarizeLayout(scan.layout), grants: i.grants, state: 'pending' }, by);
  return agentsRepo(slug).get(agent.id)!;
}

const summarizeLayout = (l: ExternalLayout) => ({ identity: l.identity, adapters: l.adapters, context: l.context.length, skills: l.skills.map(s => `${s.slug}${s.version ? ` v${s.version}` : ''}`), memory: l.memory, inbox: l.inbox, outputs: l.outputs, backups: l.backups });

// ---------------------------------------------------------------- Estado, cambios externos y adopción

export function diffSnapshots(before: SnapshotFiles, after: SnapshotFiles): ExternalFileChange[] {
  const out: ExternalFileChange[] = [];
  for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = p in before ? fileHash(before[p]) : null; const a = p in after ? fileHash(after[p]) : null;
    if (b !== a) out.push({ path: p, change: b === null ? 'added' : a === null ? 'removed' : 'modified', before: b, after: a });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

export function sourceStatus(slug: string, agentId: string) {
  const repo = sourcesRepo(slug); const s = repo.get(agentId);
  if (!s) return null;
  const adopted = repo.files(agentId)!;
  let disk: ScanResult | null = null; let readError: string | null = null;
  try { disk = scanExternal(s.root); } catch (e: any) { readError = e?.message ?? String(e); }
  const changes = disk ? diffSnapshots(adopted, disk.files) : [];
  return {
    root: s.root, layout: s.layout, provenance: s.provenance, state: s.state, grants: s.grants, revision: s.revision, adoptedHash: s.adoptedHash,
    diskHash: disk ? snapshotHash(disk.files) : null, readError, changes, problems: disk?.problems ?? [], links: disk?.links ?? [],
    // El texto antes/después de cada cambio externo, para revisarlo ANTES de adoptarlo (un script adoptado vuelve a ejecutarse).
    diff: changes.map(c => ({ path: c.path, before: c.path in adopted ? clipText(adopted[c.path]) : null, after: disk && c.path in disk.files ? clipText(disk.files[c.path]) : null })),
    scripts: Object.keys(adopted).filter(p => p.endsWith('.py')).sort().map(p => ({ path: p, sha256: fileHash(adopted[p]), changedOnDisk: changes.some(c => c.path === p) })),
    revisions: repo.revisions(agentId).slice(0, 30)
  };
}

const clipText = (t: string, n = 60_000) => t.length > n ? `${t.slice(0, n)}\n…(recortado: ${t.length - n} caracteres más)` : t;

/**
 * Cuántos archivos de su identidad cambiaron fuera del Portal (para avisar en la oficina). Caché corta: la oficina se
 * pide a menudo y leer la carpeta de cada agente externo en cada petición sería caro.
 */
const pendingCache = new Map<string, { at: number; n: number }>();
export function pendingExternalChanges(slug: string, agentId: string, ttlMs = 15_000): number {
  const key = `${slug}:${agentId}`; const c = pendingCache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.n;
  let n = 0;
  try { const repo = sourcesRepo(slug); const s = repo.get(agentId); if (s) n = diffSnapshots(repo.files(agentId)!, scanExternal(s.root).files).length; } catch { n = 0; }
  pendingCache.set(key, { at: Date.now(), n });
  return n;
}
export const forgetPendingExternal = (slug: string, agentId: string) => { pendingCache.delete(`${slug}:${agentId}`); };

/** Adopta lo que hay ahora en disco (cambio hecho fuera del Portal), comprobando que es la versión revisada. */
export function adoptSourceChange(slug: string, agentId: string, expectHash: string, by = 'owner') {
  const repo = sourcesRepo(slug); const s = repo.get(agentId); if (!s) throw err('Este agente no tiene carpeta externa.', 404);
  const scan = scanExternal(s.root);
  const h = snapshotHash(scan.files);
  if (h !== expectHash) throw err('La carpeta cambió otra vez mientras la revisabas: vuelve a revisarla.', 409);
  if (h === s.adoptedHash) return { revision: s.revision, changes: [] as ExternalFileChange[] };
  const blocking = scan.problems.filter(p => p.blocking); if (blocking.length) throw err(`No se puede adoptar: ${blocking.map(p => `${p.path} — ${p.message}`).join(' · ')}`, 400);
  const changes = diffSnapshots(repo.files(agentId)!, scan.files);
  const n = repo.adopt(agentId, scan.files, scan.layout, 'external', 'Cambio hecho fuera del Portal, revisado y adoptado por el propietario', by);
  recordAgentEvent(slug, agentId, 'source_adopted', { revision: n, before: s.adoptedHash, after: h, changes }, by);
  forgetPendingExternal(slug, agentId);
  return { revision: n, changes };
}

export function updateGrants(slug: string, agentId: string, grants: ExternalGrants, by = 'owner') {
  const repo = sourcesRepo(slug); const s = repo.get(agentId); if (!s) throw err('Este agente no tiene carpeta externa.', 404);
  repo.setGrants(agentId, grants);
  recordAgentEvent(slug, agentId, 'source_grants', { before: s.grants, after: grants }, by);
  return repo.get(agentId)!;
}

/** pendiente → en evaluación (primer trabajo real). «Integrado» solo lo pone una mejora aplicada y validada. */
export function markEvaluating(slug: string, agentId: string) {
  const repo = sourcesRepo(slug); const s = repo.get(agentId);
  if (s?.state === 'pending') { repo.setState(agentId, 'evaluating'); recordAgentEvent(slug, agentId, 'integration_state', { from: 'pending', to: 'evaluating', reason: 'Primer trabajo real ejecutado por el Portal' }, 'portal'); }
}

// ---------------------------------------------------------------- Rutas seguras dentro de la carpeta

/**
 * Ruta absoluta de `rel` dentro de la raíz, sin enlaces en ningún tramo y dentro de una zona permitida. Crea los
 * directorios que falten (uno a uno, comprobando cada uno). Nunca sigue un enlace.
 */
export function safePath(root: string, rel: string, zones: string[], opts: { create?: boolean } = {}): string {
  const norm = rel.replace(/\\/g, '/');
  // Sin «:» (flujos NTFS como «carpeta::$INDEX_ALLOCATION»), NUL ni segmentos con punto o espacio final (Windows los
  // quita y serían otro nombre para la misma carpeta): cada ruta tiene una sola forma.
  if (!norm || norm.startsWith('/') || /^[a-z]:/i.test(norm) || norm.split('/').some(seg => seg === '..' || seg === '.' || seg === '' || /[:\u0000]/.test(seg) || /[. ]$/.test(seg))) throw err(`Ruta no válida: ${rel}`, 400);
  if (!zones.some(z => norm === z || norm.startsWith(`${z}/`))) throw err(`Ruta fuera de la zona concedida: ${rel}`, 403);
  // La raíz debe seguir siendo la carpeta registrada (no un enlace puesto en su lugar después de integrarla).
  if (fs.lstatSync(root).isSymbolicLink()) throw err('La carpeta del agente es ahora un enlace (symlink/junction): no se lee ni se escribe a través de él.', 409);
  const realRoot = fs.realpathSync.native(root);
  if (rootKey(realRoot) !== rootKey(path.resolve(root))) throw err('La carpeta del agente cambió de sitio: no se lee ni se escribe.', 409);
  let cur = realRoot;
  const parts = norm.split('/');
  for (let k = 0; k < parts.length; k++) {
    cur = path.join(cur, parts[k]);
    let l: fs.Stats | null = null; try { l = fs.lstatSync(cur); } catch { l = null; }
    if (l?.isSymbolicLink()) throw err(`«${parts.slice(0, k + 1).join('/')}» es un enlace (symlink/junction): el Portal no escribe ni lee a través de él.`, 400);
    if (!l && k < parts.length - 1) { if (!opts.create) throw err(`No existe: ${parts.slice(0, k + 1).join('/')}`, 404); fs.mkdirSync(cur); }
  }
  if (!insideRoot(realRoot, cur)) throw err('Ruta fuera de la carpeta del agente.', 403);
  return cur;
}

/** Escribe un archivo dentro de la zona (temporal + rename; exclusivo si se pide: nunca sobrescribe). */
export function safeWrite(root: string, rel: string, data: string | Buffer, zones: string[], opts: { exclusive?: boolean } = {}): string {
  const target = safePath(root, rel, zones, { create: true });
  if (opts.exclusive) { fs.writeFileSync(target, data, { flag: 'wx' }); return target; }
  try { if (fs.lstatSync(target).nlink > 1) throw err(`${rel} es un enlace físico: no se sobrescribe.`, 400); } catch (e: any) { if (e.statusCode) throw e; }
  const tmp = `${target}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data); fs.renameSync(tmp, target);
  return target;
}

/** Restaura (en la carpeta original) los archivos de una revisión adoptada anterior, con copia previa. */
export function restoreSourceRevision(slug: string, agentId: string, n: number, by = 'owner') {
  const repo = sourcesRepo(slug); const s = repo.get(agentId); if (!s) throw err('Este agente no tiene carpeta externa.', 404);
  if (!s.grants.applyImprovements) throw err('Restaurar escribe en sus instrucciones y habilidades: concede antes «aplicar mejoras aprobadas».', 403);
  const target = repo.files(agentId, n); if (!target) throw err('Revisión no encontrada.', 404);
  const scan = scanExternal(s.root);
  if (snapshotHash(scan.files) !== s.adoptedHash) throw err('La carpeta tiene cambios hechos fuera del Portal sin revisar: adóptalos o deshazlos antes de restaurar.', 409);
  // El historial (CAMBIOS.md) no se deshace: se conserva y se le añade la vuelta atrás.
  const want: SnapshotFiles = { ...target };
  const stamp = new Date().toISOString().slice(0, 10);
  for (const p of Object.keys(scan.files).filter(p => /CAMBIOS\.md$/i.test(p))) want[p] = `${scan.files[p].replace(/\s*$/, '')}\n\n## ${stamp} — vuelta a la revisión ${n} (Portal IA)\n\n- Restaurado por el propietario; la copia de lo que había queda en ${s.layout.backups ?? 'configuracion/respaldos'}/.\n`;
  if (DEPS_KEY in scan.files) want[DEPS_KEY] = scan.files[DEPS_KEY]; else delete want[DEPS_KEY]; // las dependencias no se restauran
  const changes = diffSnapshots(scan.files, want);
  // Toda la identidad (adaptadores y habilidades que ya no estén incluidos) se puede restaurar; se comprueba TODO antes de escribir.
  const zones = RESTORE_ZONES;
  for (const c of changes) if (!isIdentityPath(c.path) || !zones.some(z => c.path === z || c.path.startsWith(`${z}/`))) throw err(`No se puede restaurar ${c.path}: está fuera de su identidad.`, 400);
  const backup = backupFiles(s.root, s.layout, scan.files, changes.map(c => c.path), `restaurar-${n}`);
  const done: string[] = [];
  try {
    for (const c of changes) {
      if (c.change === 'removed') { const p = safePath(s.root, c.path, zones); fs.rmSync(p, { force: true }); }
      else safeWrite(s.root, c.path, want[c.path], zones);
      done.push(c.path);
    }
  } catch (e: any) {
    // A medias no se queda: lo escrito vuelve a como estaba (la copia sigue en `backup`).
    for (const rel of done) { try { if (rel in scan.files) safeWrite(s.root, rel, scan.files[rel], zones); else fs.rmSync(safePath(s.root, rel, zones), { force: true }); } catch { /* queda la copia */ } }
    throw err(`No se restauró (todo volvió a como estaba; copia en ${backup}): ${e?.message ?? e}`, e?.statusCode ?? 500);
  }
  const after = scanExternal(s.root);
  const rev = repo.adopt(agentId, after.files, after.layout, 'restore', `Vuelta a la revisión ${n} (copia previa en ${backup})`, by);
  recordAgentEvent(slug, agentId, 'source_restored', { to: n, revision: rev, backup, changes }, by);
  return { revision: rev, backup, changes };
}

const RESTORE_ZONES = ['AGENTS.md', 'CLAUDE.md', 'COMO_EMPEZAR.md', 'README.md', 'contexto', 'memoria', 'skills'];

/** Zonas de identidad que una mejora aprobada puede modificar (nunca entregables ni dependencias). */
export function identityZones(layout: ExternalLayout): string[] {
  return ['AGENTS.md', 'contexto', 'memoria', ...layout.skills.map(s => `skills/${s.slug}`)];
}

/** Copia de seguridad de archivos de identidad en `configuracion/respaldos/<fecha>-portal-<motivo>/` (nunca se sobrescribe). */
export function backupFiles(root: string, layout: ExternalLayout, current: SnapshotFiles, paths: string[], reason: string): string {
  const base = layout.backups ?? 'configuracion/respaldos';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let dirRel = `${base}/${stamp}-portal-${reason}`.replace(/[^A-Za-z0-9/_.-]/g, '-'); let k = 2;
  while (fs.existsSync(path.join(root, ...dirRel.split('/')))) dirRel = `${base}/${stamp}-portal-${reason}-${k++}`;
  const manifest: Record<string, string | null> = {};
  for (const p of paths) {
    if (p in current) { safeWrite(root, `${dirRel}/${p}`, current[p], [base], { exclusive: true }); manifest[p] = fileHash(current[p]); }
    else manifest[p] = null; // no existía antes
  }
  safeWrite(root, `${dirRel}/MANIFIESTO.json`, JSON.stringify({ motivo: reason, fecha: new Date().toISOString(), archivos: manifest }, null, 1), [base], { exclusive: true });
  return dirRel;
}

export const sha256Text = fileHash;

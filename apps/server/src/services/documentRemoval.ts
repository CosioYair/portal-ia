import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RemovalPreview, RemovalRecord } from '@portal-ia/domain';
import { appendHistory, documentsDb, jobsDb, sourceOr } from './documentJobs.ts';
import { requirePolicy } from './executionPolicy.ts';
import { recordAgentEvent } from './agentEvents.ts';
import { changed } from './live.ts';
import { monotonicNow } from '../clock.ts';

/**
 * Eliminación autorizada de lotes y documentos de un agente externo (HU-177, docs/agentes-externos.md).
 *
 * - Vista previa (no borra nada): carpeta, archivos, bytes que se liberan y qué se conserva, con un `token` de lo mostrado.
 * - Borrado: exige authorized:true y pasa por requirePolicy('document_files_delete'), que lo audita en execution_history.
 *   Solo borra dentro de «documentos/» del agente: nada de rutas transversales ni enlaces simbólicos.
 *   Se niega con 409 si el lote o el documento se está procesando.
 * - Borrado blando: la fila NUNCA se borra de la base. Se marca como eliminada y se conservan el SHA-256, los motivos,
 *   las versiones registradas, el feedback y las propuestas (el aprendizaje del agente).
 * - Conciliación: reconcileWithDisk detecta lo que falta en disco. No crea ni borra nada por su cuenta.
 */
const now = monotonicNow;
const err = (msg: string, statusCode: number, code?: string) => Object.assign(new Error(msg), { statusCode, ...(code ? { code } : {}) });
const MAX_SAMPLE = 200;

export type RemovalTarget = { batchId: string } | { jobId: string };
/** Comprobación de «en proceso» que solo conoce documentBatches (lotes en marcha, importándose o terminando en memoria). */
type BusyProbe = (slug: string, agentId: string, batchId: string | null, jobId: string | null) => string | null;
const probes: BusyProbe[] = [];
export function registerRemovalBusyProbe(p: BusyProbe) { probes.push(p); }

const migrated = new Set<string>();
function db(slug: string) {
  const d = documentsDb(slug) as any;
  if (!migrated.has(slug)) {
    const add = (table: string, cols: [string, string][]) => {
      const have = (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
      for (const [c, t] of cols) if (!have.includes(c)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${t}`);
    };
    add('document_jobs', [['removed_at', 'TEXT'], ['removal_id', 'TEXT']]);
    add('document_batches', [['removed_at', 'TEXT'], ['removal_id', 'TEXT']]);
    add('document_batch_items', [['removed_at', 'TEXT']]);
    d.exec(`CREATE TABLE IF NOT EXISTS document_removals (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, target_id TEXT NOT NULL, batch_id TEXT, name TEXT NOT NULL, folder TEXT NOT NULL,
      sha_json TEXT NOT NULL DEFAULT '[]', reasons_json TEXT NOT NULL DEFAULT '[]', files INTEGER NOT NULL DEFAULT 0, freed_bytes INTEGER NOT NULL DEFAULT 0,
      missing INTEGER NOT NULL DEFAULT 0, reason TEXT, removed_by TEXT NOT NULL, removed_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS document_removals_agent ON document_removals(agent_id, removed_at);`);
    migrated.add(slug);
  }
  return d;
}

const toRecord = (r: any): RemovalRecord => ({
  id: r.id, agentId: r.agent_id, kind: r.kind, targetId: r.target_id, batchId: r.batch_id ?? null, name: r.name, folder: r.folder,
  sha256: JSON.parse(r.sha_json), reasons: JSON.parse(r.reasons_json), files: r.files, freedBytes: r.freed_bytes, missingOnDisk: !!r.missing,
  reason: r.reason ?? null, removedBy: r.removed_by, removedAt: r.removed_at
});
/** Histórico de eliminaciones del agente (lo más reciente primero). */
export function listRemovals(slug: string, agentId: string): RemovalRecord[] {
  return (db(slug).prepare('SELECT * FROM document_removals WHERE agent_id = ? ORDER BY removed_at DESC').all(agentId) as any[]).map(toRecord);
}
export function removalsById(slug: string, agentId: string): Map<string, RemovalRecord> { return new Map(listRemovals(slug, agentId).map(r => [r.id, r])); }
/** Ids eliminados (para ocultarlos por defecto) y SHA-256 que ya no bloquean una nueva subida. */
export function removedIds(slug: string, agentId: string): { jobs: Map<string, string>; batches: Map<string, string> } {
  const d = db(slug);
  const jobs = new Map((d.prepare('SELECT id, removal_id FROM document_jobs WHERE agent_id = ? AND removed_at IS NOT NULL').all(agentId) as any[]).map(r => [r.id as string, String(r.removal_id ?? '')]));
  const batches = new Map((d.prepare('SELECT id, removal_id FROM document_batches WHERE agent_id = ? AND removed_at IS NOT NULL').all(agentId) as any[]).map(r => [r.id as string, String(r.removal_id ?? '')]));
  return { jobs, batches };
}

interface Target { kind: 'batch' | 'document'; id: string; batchId: string | null; name: string; rel: string; shas: string[]; reasons: { name: string; reason: string }[]; jobIds: string[] }

function busyReason(slug: string, agentId: string, batchId: string | null, jobId: string | null): string | null {
  for (const p of probes) { const r = p(slug, agentId, batchId, jobId); if (r) return r; }
  return null;
}

function targetOf(slug: string, agentId: string, sel: RemovalTarget): Target & { blockedBy: string | null } {
  const d = db(slug);
  if ('batchId' in sel) {
    const b = d.prepare('SELECT * FROM document_batches WHERE id = ?').get(sel.batchId) as any;
    if (!b || b.agent_id !== agentId) throw err('Lote no encontrado', 404);
    if (b.removed_at) throw err('Ese lote ya se eliminó: sigue consultable en el histórico.', 409, 'already_removed');
    const items = d.prepare('SELECT * FROM document_batch_items WHERE batch_id = ? ORDER BY idx').all(b.id) as any[];
    const jobIds = (d.prepare('SELECT id FROM document_jobs WHERE agent_id = ? AND batch_id = ? AND removed_at IS NULL').all(agentId, b.id) as any[]).map(r => r.id as string);
    const blockedBy = b.status === 'running' || items.some(i => i.state === 'queued' || i.state === 'processing')
      ? 'El lote se está procesando: páusalo o cancélalo antes de eliminarlo.' : busyReason(slug, agentId, b.id, null);
    return {
      kind: 'batch', id: b.id, batchId: b.id, name: b.name || b.source_name, rel: b.slug, jobIds, blockedBy,
      shas: [...new Set(items.map(i => i.sha).filter(Boolean) as string[])],
      reasons: items.filter(i => i.state !== 'passed' && !i.removed_at).map(i => ({ name: i.entry_name, reason: String(i.reason ?? i.state) }))
    };
  }
  const row = d.prepare('SELECT removed_at FROM document_jobs WHERE id = ? AND agent_id = ?').get(sel.jobId, agentId) as any;
  const job = row ? jobsDb(slug).get(sel.jobId) : null;
  if (!job || job.agentId !== agentId) throw err('Documento no encontrado', 404);
  if (row.removed_at) throw err('Ese documento ya se eliminó: sigue consultable en el histórico.', 409, 'already_removed');
  let blockedBy: string | null = job.status === 'processing' ? 'El documento se está convirtiendo: espera a que termine o cancela el lote.' : null;
  if (!blockedBy && job.batchId) {
    const it = d.prepare('SELECT state FROM document_batch_items WHERE batch_id = ? AND job_id = ?').all(job.batchId, job.id) as any[];
    if (it.some(i => i.state === 'queued' || i.state === 'processing')) blockedBy = 'El documento está en la cola de su lote: pausa o cancela el lote antes de eliminarlo.';
  }
  blockedBy ??= busyReason(slug, agentId, job.batchId ?? null, job.id);
  const reason = job.status === 'ready' ? null : (job.error ?? (job.status === 'rejected' ? 'No pasó las comprobaciones' : job.status));
  return {
    kind: 'document', id: job.id, batchId: job.batchId ?? null, name: job.inputName || job.title, rel: job.slug, jobIds: [job.id], blockedBy,
    shas: [job.inputSha256], reasons: reason ? [{ name: job.inputName, reason: String(reason) }] : []
  };
}

/** Ruta absoluta confinada a «documentos/» del agente (nunca la propia raíz de «documentos/»). Si no, 400. */
function confined(slug: string, agentId: string, rel: string) {
  const s = sourceOr(slug, agentId);
  const outputs = s.layout.outputs!;
  const segs = rel.replace(/\\/g, '/').split('/');
  if (!rel || path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || segs.some(x => !x || x === '.' || x === '..')) throw err('Ruta no permitida: fuera de la carpeta de documentos del agente.', 400, 'path_outside_root');
  const base = path.resolve(s.root, ...outputs.split('/'));
  const abs = path.resolve(base, ...segs);
  if (!abs.startsWith(base + path.sep)) throw err('Ruta no permitida: fuera de la carpeta de documentos del agente.', 400, 'path_outside_root');
  if (fs.existsSync(abs)) {
    const realBase = fs.realpathSync(base); const real = fs.realpathSync(abs);
    if (!real.startsWith(realBase + path.sep)) throw err('Ruta no permitida: la carpeta apunta fuera de la del agente.', 400, 'path_outside_root');
  }
  return { s, outputs, abs, folder: `${outputs}/${segs.join('/')}` };
}

/** Recorre sin seguir enlaces: un enlace simbólico o un punto de unión dentro de la carpeta bloquea el borrado. */
function scan(abs: string): { files: string[]; bytes: number } {
  const files: string[] = []; let bytes = 0;
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw err(`La carpeta contiene un enlace («${r}»): no se elimina para no tocar nada fuera de ella.`, 409, 'symlink_inside');
      if (st.isDirectory()) walk(p, r); else { files.push(r); bytes += st.size; }
    }
  };
  if (fs.lstatSync(abs).isSymbolicLink()) throw err('La carpeta es un enlace: no se elimina.', 409, 'symlink_inside');
  walk(abs, '');
  return { files: files.sort(), bytes };
}

function plan(slug: string, agentId: string, sel: RemovalTarget) {
  const t = targetOf(slug, agentId, sel);
  const c = confined(slug, agentId, t.rel);
  const exists = fs.existsSync(c.abs);
  const sc = exists ? scan(c.abs) : { files: [], bytes: 0 };
  const token = crypto.createHash('sha256').update(JSON.stringify([t.kind, t.id, c.folder, exists, sc.files, sc.bytes])).digest('hex');
  return { t, c, exists, sc, token };
}

/** Vista previa: qué se borra, cuánto se libera y qué se conserva. No borra nada. */
export function previewRemoval(slug: string, agentId: string, sel: RemovalTarget): RemovalPreview {
  const { t, c, exists, sc, token } = plan(slug, agentId, sel);
  return {
    kind: t.kind, id: t.id, name: t.name, folder: c.folder, exists, files: sc.files.length, sample: sc.files.slice(0, MAX_SAMPLE), freedBytes: sc.bytes,
    keeps: [
      'El registro histórico: fecha, quién lo eliminó, bytes liberados y motivo',
      `El SHA-256 de ${t.shas.length} PDF y el motivo de cada documento que no quedó listo`,
      'El aprendizaje del agente: feedback, propuestas de mejora y cambios aplicados a su habilidad',
      'Una línea en «documentos/HISTORIAL.md», fuera de la carpeta que se borra'
    ],
    warning: exists
      ? `Se borrarán de tu equipo ${sc.files.length} archivo(s) de «${c.folder}» (PDF de origen, Word, revisiones, MANIFIESTO e HISTORIAL de esa carpeta). No se puede deshacer en disco.`
      : `«${c.folder}» ya no está en disco: solo se quitará de la lista y quedará en el histórico.`,
    token, blockedBy: t.blockedBy
  };
}

export interface RemovalOptions { authorized?: boolean; reason?: string | null; previewToken?: string | null; by?: string }
export const removeBatch = (slug: string, agentId: string, batchId: string, o: RemovalOptions) => remove(slug, agentId, { batchId }, o);
export const removeDocument = (slug: string, agentId: string, jobId: string, o: RemovalOptions) => remove(slug, agentId, { jobId }, o);

function remove(slug: string, agentId: string, sel: RemovalTarget, o: RemovalOptions): RemovalRecord {
  // Primero la autorización: sin ella no se lee ni se borra nada (y queda auditado como denegado).
  requirePolicy('document_files_delete', { slug, agentId, authorized: o.authorized === true });
  const by = o.by ?? 'owner';
  const { t, c, exists, sc, token } = plan(slug, agentId, sel);
  if (t.blockedBy) throw err(t.blockedBy, 409, 'in_progress');
  if (o.previewToken && o.previewToken !== token) throw err('El contenido cambió desde la vista previa: revísala de nuevo antes de eliminar.', 409, 'preview_changed');
  if (exists) {
    try { fs.rmSync(c.abs, { recursive: true, force: false, maxRetries: 2, retryDelay: 200 }); }
    catch (x: any) { throw err(`No se pudo borrar «${c.folder}» (¿hay algún archivo abierto?): ${String(x?.message ?? x).slice(0, 300)}. La lista no cambia.`, 409, 'remove_failed'); }
  }
  const at = now(); const id = crypto.randomUUID(); const d = db(slug);
  const rec: RemovalRecord = {
    id, agentId, kind: t.kind, targetId: t.id, batchId: t.batchId, name: t.name, folder: c.folder, sha256: t.shas, reasons: t.reasons,
    files: sc.files.length, freedBytes: sc.bytes, missingOnDisk: !exists, reason: o.reason?.trim().slice(0, 500) || null, removedBy: by, removedAt: at
  };
  d.exec('BEGIN');
  try {
    d.prepare(`INSERT INTO document_removals (id, agent_id, kind, target_id, batch_id, name, folder, sha_json, reasons_json, files, freed_bytes, missing, reason, removed_by, removed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, agentId, rec.kind, rec.targetId, rec.batchId, rec.name, rec.folder, JSON.stringify(rec.sha256), JSON.stringify(rec.reasons), rec.files, rec.freedBytes, rec.missingOnDisk ? 1 : 0, rec.reason, by, at);
    const markJob = d.prepare('UPDATE document_jobs SET removed_at = ?, removal_id = ? WHERE id = ? AND agent_id = ? AND removed_at IS NULL');
    for (const j of t.jobIds) markJob.run(at, id, j, agentId);
    if (t.kind === 'batch') {
      d.prepare('UPDATE document_batches SET removed_at = ?, removal_id = ?, updated_at = ? WHERE id = ?').run(at, id, at, t.id);
      d.prepare('UPDATE document_batch_items SET removed_at = ? WHERE batch_id = ? AND removed_at IS NULL').run(at, t.id);
    } else if (t.batchId) {
      d.prepare('UPDATE document_batch_items SET removed_at = ? WHERE batch_id = ? AND job_id = ?').run(at, t.batchId, t.id);
      d.prepare('UPDATE document_batches SET updated_at = ? WHERE id = ?').run(at, t.batchId);
    }
    d.exec('COMMIT');
  } catch (x) { try { d.exec('ROLLBACK'); } catch { /* ya cerrada */ } throw x; }
  try {
    appendHistory(c.s.root, c.outputs, [c.outputs], `Eliminado ${t.kind === 'batch' ? 'el lote' : 'el documento'} «${t.name}» (${c.folder}) por ${by}: ${rec.missingOnDisk ? 'ya faltaba en disco, solo se quitó de la lista' : `${rec.files} archivo(s), ${rec.freedBytes} bytes liberados`}. SHA-256: ${rec.sha256.join(', ') || '—'}.${rec.reason ? ` Motivo: ${rec.reason}.` : ''} Se conservan el histórico y el aprendizaje del agente.`);
  } catch { /* el registro en la base ya es el histórico */ }
  try { recordAgentEvent(slug, agentId, 'document_job', { action: t.kind === 'batch' ? 'batch_removed' : 'document_removed', removalId: id, targetId: t.id, batchId: t.batchId, files: rec.files, freedBytes: rec.freedBytes, missingOnDisk: rec.missingOnDisk }, by); } catch { /* auditoría ya en execution_history */ }
  changed({ ws: slug, entity: 'agent', id: agentId });
  return rec;
}

/**
 * Conciliación con el disco (barata: existsSync por carpeta). Devuelve qué lotes y documentos presentes en la lista faltan
 * en disco. No crea, no borra y no cambia nada: quitarlos de la lista es una eliminación autorizada (con 0 bytes).
 */
export function reconcileWithDisk(slug: string, agentId: string): { batches: Set<string>; jobs: Set<string> } {
  const out = { batches: new Set<string>(), jobs: new Set<string>() };
  let s: ReturnType<typeof sourceOr>;
  try { s = sourceOr(slug, agentId); } catch { return out; }
  const base = path.resolve(s.root, ...s.layout.outputs!.split('/'));
  const here = (rel: string) => { try { return fs.existsSync(path.resolve(base, ...String(rel).split('/'))); } catch { return true; } };
  const d = db(slug);
  for (const b of d.prepare('SELECT id, slug FROM document_batches WHERE agent_id = ? AND removed_at IS NULL').all(agentId) as any[]) if (!here(b.slug)) out.batches.add(b.id);
  for (const j of d.prepare('SELECT id, slug FROM document_jobs WHERE agent_id = ? AND removed_at IS NULL').all(agentId) as any[]) if (!here(j.slug)) out.jobs.add(j.id);
  return out;
}

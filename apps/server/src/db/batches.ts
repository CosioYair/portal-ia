import crypto from 'node:crypto';
import type { Batch, BatchEvent } from '@portal-ia/domain';
import { workspaceDb } from './workspace.ts';

/**
 * Lotes de ejecución continua (v0.15): un documento por lote (autorización, plan, estado de cada historia y registro
 * de eventos). Tabla aditiva; se crea al usarla. Cada cambio se guarda entero y de una vez (sobrevive a un reinicio).
 */
const ready = new Set<string>();
function db(slug: string) {
  const d = workspaceDb(slug);
  if (!ready.has(slug)) {
    d.exec(`CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, doc_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS batches_project ON batches(project_id, created_at);`);
    ready.add(slug);
  }
  return d;
}

/** Eventos que se conservan por lote (los más antiguos se resumen en el primero). */
const MAX_EVENTS = 400;

export function batchesRepo(slug: string) {
  const d = db(slug);
  const get = (id: string): Batch | null => { const r = d.prepare('SELECT doc_json FROM batches WHERE id = ?').get(id) as any; return r ? JSON.parse(r.doc_json) : null; };
  const save = (b: Batch): Batch => {
    b.updatedAt = new Date().toISOString();
    if (b.events.length > MAX_EVENTS) b.events = [{ at: b.events[0].at, kind: 'item', message: `(${b.events.length - MAX_EVENTS + 1} eventos anteriores resumidos)` }, ...b.events.slice(-(MAX_EVENTS - 1))];
    d.prepare('UPDATE batches SET status = ?, doc_json = ?, updated_at = ? WHERE id = ?').run(b.status, JSON.stringify(b), b.updatedAt, b.id);
    return b;
  };
  return {
    get,
    create(b: Omit<Batch, 'id' | 'createdAt' | 'updatedAt'>): Batch {
      const now = new Date().toISOString();
      const doc: Batch = { ...b, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
      d.prepare('INSERT INTO batches (id, project_id, status, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(doc.id, doc.projectId, doc.status, JSON.stringify(doc), now, now);
      return doc;
    },
    /** Lee, modifica y guarda en una sola operación síncrona (sin carreras dentro de este proceso). */
    update(id: string, fn: (b: Batch) => void): Batch {
      const b = get(id); if (!b) throw Object.assign(new Error('Lote no encontrado'), { statusCode: 404 });
      fn(b); return save(b);
    },
    event(id: string, e: Omit<BatchEvent, 'at'>): Batch {
      return this.update(id, b => { b.events.push({ at: new Date().toISOString(), ...e }); });
    },
    list(projectId?: string): Batch[] {
      const rows = (projectId ? d.prepare('SELECT doc_json FROM batches WHERE project_id = ? ORDER BY created_at DESC').all(projectId) : d.prepare('SELECT doc_json FROM batches ORDER BY created_at DESC').all()) as any[];
      return rows.map(r => JSON.parse(r.doc_json));
    },
    active(): Batch[] {
      return (d.prepare(`SELECT doc_json FROM batches WHERE status IN ('running', 'paused') ORDER BY created_at`).all() as any[]).map(r => JSON.parse(r.doc_json));
    }
  };
}

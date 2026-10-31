import crypto from 'node:crypto';
import type { Assignment, AssignmentEvent } from '@portal-ia/domain';
import { monotonicNow } from '../clock.ts';
import { workspaceDb } from './workspace.ts';

/**
 * Encargos de desarrollo del propietario (v0.16): un documento por encargo, como los lotes. Tabla aditiva que se crea
 * al usarla; cada cambio se guarda entero y de una vez (sobrevive a un reinicio).
 */
const ready = new Set<string>();
function db(slug: string) {
  const d = workspaceDb(slug);
  if (!ready.has(slug)) {
    d.exec(`CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY, code TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, doc_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS assignments_code ON assignments(code);
    CREATE INDEX IF NOT EXISTS assignments_project ON assignments(project_id, created_at);`);
    ready.add(slug);
  }
  return d;
}

const MAX_EVENTS = 200;
export function assignmentsRepo(slug: string) {
  const d = db(slug);
  const get = (id: string): Assignment | null => { const r = d.prepare('SELECT doc_json FROM assignments WHERE id = ?').get(id) as any; return r ? JSON.parse(r.doc_json) : null; };
  const save = (a: Assignment): Assignment => {
    a.updatedAt = monotonicNow();
    if (a.events.length > MAX_EVENTS) a.events = a.events.slice(-MAX_EVENTS);
    d.prepare('UPDATE assignments SET status = ?, doc_json = ?, updated_at = ? WHERE id = ?').run(a.status, JSON.stringify(a), a.updatedAt, a.id);
    return a;
  };
  return {
    get,
    byCode(code: string): Assignment | null { const r = d.prepare('SELECT doc_json FROM assignments WHERE code = ?').get(code) as any; return r ? JSON.parse(r.doc_json) : null; },
    create(a: Omit<Assignment, 'id' | 'code' | 'createdAt' | 'updatedAt' | 'events'> & { events?: AssignmentEvent[] }): Assignment {
      const at = monotonicNow();
      // EN-001, EN-002…: el siguiente número del espacio (nunca se reutiliza).
      const max = (d.prepare(`SELECT MAX(CAST(SUBSTR(code, 4) AS INTEGER)) AS n FROM assignments`).get() as any)?.n ?? 0;
      const doc: Assignment = { ...a, id: crypto.randomUUID(), code: `EN-${String(max + 1).padStart(3, '0')}`, events: a.events ?? [], createdAt: at, updatedAt: at };
      d.prepare('INSERT INTO assignments (id, code, project_id, status, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(doc.id, doc.code, doc.projectId, doc.status, JSON.stringify(doc), at, at);
      return doc;
    },
    /** Lee, modifica y guarda en una sola operación síncrona. */
    update(id: string, fn: (a: Assignment) => void): Assignment {
      const a = get(id); if (!a) throw Object.assign(new Error('Encargo no encontrado'), { statusCode: 404 });
      fn(a); return save(a);
    },
    event(id: string, e: Omit<AssignmentEvent, 'at'>): Assignment {
      return this.update(id, a => { a.events.push({ at: monotonicNow(), ...e }); });
    },
    list(projectId?: string): Assignment[] {
      const rows = (projectId ? d.prepare('SELECT doc_json FROM assignments WHERE project_id = ? ORDER BY created_at DESC').all(projectId) : d.prepare('SELECT doc_json FROM assignments ORDER BY created_at DESC').all()) as any[];
      return rows.map(r => JSON.parse(r.doc_json));
    }
  };
}

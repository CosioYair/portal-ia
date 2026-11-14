import type { StudioAsset, StudioProject, StudioRender } from '@portal-ia/domain';
import { workspaceDb } from './workspace.ts';

/**
 * Portal IA 4 · Estudio: proyectos de vídeo, su historial de versiones, la biblioteca de medios y las exportaciones.
 * Mismo criterio que el resto del espacio: tablas creadas al primer uso (idempotentes) y documentos JSON versionados
 * (`schema` dentro del documento). Borrar un proyecto lo manda a la papelera (deleted_at); no destruye archivos.
 */
const ready = new Set<string>();
function db(slug: string) {
  const d = workspaceDb(slug);
  if (!ready.has(slug)) {
    d.exec(`CREATE TABLE IF NOT EXISTS studio_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, doc_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS studio_versions (
      project_id TEXT NOT NULL, revision INTEGER NOT NULL, label TEXT, doc_json TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (project_id, revision)
    );
    CREATE TABLE IF NOT EXISTS studio_assets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, file TEXT NOT NULL, sha256 TEXT NOT NULL, doc_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_assets_project ON studio_assets(project_id, created_at);
    CREATE TABLE IF NOT EXISTS studio_renders (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, doc_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_renders_project ON studio_renders(project_id, created_at);`);
    ready.add(slug);
  }
  return d;
}

/** Versiones automáticas que se conservan por proyecto (las que tienen nombre se conservan siempre). */
export const STUDIO_KEEP_AUTOSAVES = 60;

export interface StudioProjectRow { id: string; name: string; revision: number; format: string; duration: number; clips: number; createdAt: string; updatedAt: string }
export interface StudioVersionRow { revision: number; label: string | null; at: string }

export function studioRepo(slug: string) {
  const d = db(slug);
  return {
    list(): StudioProject[] { return (d.prepare(`SELECT doc_json FROM studio_projects WHERE deleted_at IS NULL ORDER BY updated_at DESC`).all() as any[]).map(r => JSON.parse(r.doc_json)); },
    get(id: string): StudioProject | null { const r = d.prepare(`SELECT doc_json FROM studio_projects WHERE id = ? AND deleted_at IS NULL`).get(id) as any; return r ? JSON.parse(r.doc_json) : null; },
    insert(p: StudioProject): StudioProject {
      d.prepare(`INSERT INTO studio_projects (id, name, revision, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(p.id, p.name, p.revision, JSON.stringify(p), p.createdAt, p.updatedAt);
      d.prepare(`INSERT INTO studio_versions (project_id, revision, label, doc_json, at) VALUES (?, ?, ?, ?, ?)`).run(p.id, p.revision, 'Proyecto creado', JSON.stringify(p), p.updatedAt);
      return p;
    },
    /**
     * Guarda una revisión nueva SOLO si nadie guardó desde `baseRevision` (dos pestañas no se pisan). Devuelve null si
     * la base es vieja. Cada guardado queda en el historial; los automáticos antiguos se podan.
     */
    save(p: StudioProject, baseRevision: number, label: string | null): StudioProject | null {
      d.exec('BEGIN IMMEDIATE');
      try {
        const cur = d.prepare(`SELECT revision FROM studio_projects WHERE id = ? AND deleted_at IS NULL`).get(p.id) as any;
        if (!cur || Number(cur.revision) !== baseRevision) { d.exec('ROLLBACK'); return null; }
        const next: StudioProject = { ...p, revision: baseRevision + 1 };
        d.prepare(`UPDATE studio_projects SET name = ?, revision = ?, doc_json = ?, updated_at = ? WHERE id = ?`).run(next.name, next.revision, JSON.stringify(next), next.updatedAt, next.id);
        d.prepare(`INSERT INTO studio_versions (project_id, revision, label, doc_json, at) VALUES (?, ?, ?, ?, ?)`).run(next.id, next.revision, label, JSON.stringify(next), next.updatedAt);
        d.prepare(`DELETE FROM studio_versions WHERE project_id = ? AND label IS NULL AND revision NOT IN (SELECT revision FROM studio_versions WHERE project_id = ? AND label IS NULL ORDER BY revision DESC LIMIT ?)`).run(next.id, next.id, STUDIO_KEEP_AUTOSAVES);
        d.exec('COMMIT');
        return next;
      } catch (e) { try { d.exec('ROLLBACK'); } catch { /* ya cerrada */ } throw e; }
    },
    trash(id: string, at: string): boolean { return Number(d.prepare(`UPDATE studio_projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).run(at, id).changes) > 0; },
    versions(id: string): StudioVersionRow[] { return (d.prepare(`SELECT revision, label, at FROM studio_versions WHERE project_id = ? ORDER BY revision DESC`).all(id) as any[]).map(r => ({ revision: Number(r.revision), label: r.label ?? null, at: r.at })); },
    version(id: string, revision: number): StudioProject | null { const r = d.prepare(`SELECT doc_json FROM studio_versions WHERE project_id = ? AND revision = ?`).get(id, revision) as any; return r ? JSON.parse(r.doc_json) : null; },

    assets(projectId: string): StudioAsset[] { return (d.prepare(`SELECT doc_json FROM studio_assets WHERE project_id = ? ORDER BY created_at`).all(projectId) as any[]).map(r => JSON.parse(r.doc_json)); },
    asset(id: string): (StudioAsset & { file: string; sha256: string }) | null { const r = d.prepare(`SELECT doc_json, file, sha256 FROM studio_assets WHERE id = ?`).get(id) as any; return r ? { ...JSON.parse(r.doc_json), file: r.file, sha256: r.sha256 } : null; },
    assetBySha(projectId: string, sha256: string): StudioAsset | null { const r = d.prepare(`SELECT doc_json FROM studio_assets WHERE project_id = ? AND sha256 = ?`).get(projectId, sha256) as any; return r ? JSON.parse(r.doc_json) : null; },
    assetBytes(projectId: string): number { return Number((d.prepare(`SELECT COALESCE(SUM(json_extract(doc_json, '$.bytes')), 0) AS n FROM studio_assets WHERE project_id = ?`).get(projectId) as any).n); },
    addAsset(a: StudioAsset, file: string, sha256: string): StudioAsset { d.prepare(`INSERT INTO studio_assets (id, project_id, file, sha256, doc_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(a.id, a.projectId, file, sha256, JSON.stringify(a), a.createdAt); return a; },
    removeAsset(id: string): void { d.prepare(`DELETE FROM studio_assets WHERE id = ?`).run(id); },

    renders(projectId: string): StudioRender[] { return (d.prepare(`SELECT doc_json FROM studio_renders WHERE project_id = ? ORDER BY created_at DESC LIMIT 30`).all(projectId) as any[]).map(r => JSON.parse(r.doc_json)); },
    render(id: string): StudioRender | null { const r = d.prepare(`SELECT doc_json FROM studio_renders WHERE id = ?`).get(id) as any; return r ? JSON.parse(r.doc_json) : null; },
    putRender(r: StudioRender): StudioRender {
      d.prepare(`INSERT INTO studio_renders (id, project_id, status, doc_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, doc_json = excluded.doc_json`).run(r.id, r.projectId, r.status, JSON.stringify(r), r.createdAt);
      return r;
    },
    /** Exportaciones que un reinicio dejó a medias: no hay proceso que las termine. */
    unfinishedRenders(): StudioRender[] { return (d.prepare(`SELECT doc_json FROM studio_renders WHERE status IN ('queued', 'running')`).all() as any[]).map(r => JSON.parse(r.doc_json)); }
  };
}

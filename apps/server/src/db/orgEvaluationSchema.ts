import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { OrgDecision, OrgEvaluation, OrgEvaluationBrief, OrgEvaluationStatus, OrgProposal, OrgScopeKind } from '@portal-ia/domain';
import { workspaceDb } from './workspace.ts';

/**
 * Historial de evaluaciones organizativas (HU-159). Migración aditiva e idempotente: se crea al primer uso en la base
 * del espacio, sin tocar las tablas existentes. Una evaluación de empresa guarda project_id NULL y se ancla
 * (anchor_project_id) al proyecto donde viven su proceso y su documento de Conocimiento.
 */
export function ensureOrgEvaluationSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_evaluations (
      id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace','project')),
      project_id TEXT NULL,
      anchor_project_id TEXT NOT NULL,
      process_id TEXT NULL,
      status TEXT NOT NULL,
      knowledge_doc_id TEXT NULL,
      summary TEXT NOT NULL DEFAULT '',
      proposals_json TEXT NOT NULL DEFAULT '[]',
      error TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_org_evaluations_project_created ON org_evaluations (project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_org_evaluations_process ON org_evaluations (process_id);
  `);
  // Paso «Contexto y dirección»: columna aditiva; las filas antiguas quedan con NULL (brief: null).
  const cols = db.prepare(`PRAGMA table_info(org_evaluations)`).all() as { name: string }[];
  if (!cols.some(c => c.name === 'brief_json')) db.exec(`ALTER TABLE org_evaluations ADD COLUMN brief_json TEXT NULL`);
}

const now = () => new Date().toISOString();
const httpError = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, code });

export function orgEvaluationsRepo(slug: string) {
  const db = workspaceDb(slug);
  ensureOrgEvaluationSchema(db);
  const map = (r: any): OrgEvaluation => {
    let proposals: OrgProposal[] = [];
    try { const v = JSON.parse(r.proposals_json ?? '[]'); proposals = Array.isArray(v) ? v : []; } catch { proposals = []; }
    let brief: OrgEvaluationBrief | null = null;
    if (r.brief_json) { try { const v = JSON.parse(r.brief_json); brief = v && typeof v === 'object' && !Array.isArray(v) ? v as OrgEvaluationBrief : null; } catch { brief = null; } }
    return {
      id: r.id, workspaceSlug: slug, scopeKind: r.scope_kind as OrgScopeKind, projectId: r.project_id ?? null, anchorProjectId: r.anchor_project_id,
      processId: r.process_id ?? null, status: r.status as OrgEvaluationStatus, knowledgeDocId: r.knowledge_doc_id ?? null,
      summary: r.summary ?? '', proposals, error: r.error ?? null, createdAt: r.created_at, updatedAt: r.updated_at, brief
    };
  };
  return {
    create(e: { scopeKind: OrgScopeKind; projectId: string | null; anchorProjectId: string; processId?: string | null; status?: OrgEvaluationStatus; brief?: OrgEvaluationBrief | null }): OrgEvaluation {
      const id = crypto.randomUUID(); const at = now();
      db.prepare(`INSERT INTO org_evaluations (id, scope_kind, project_id, anchor_project_id, process_id, status, summary, proposals_json, brief_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '', '[]', ?, ?, ?)`)
        .run(id, e.scopeKind, e.scopeKind === 'project' ? e.projectId : null, e.anchorProjectId, e.processId ?? null, e.status ?? 'running', e.brief ? JSON.stringify(e.brief) : null, at, at);
      return this.get(id)!;
    },
    get(id: string): OrgEvaluation | undefined {
      const r = db.prepare(`SELECT * FROM org_evaluations WHERE id = ?`).get(id);
      return r ? map(r) : undefined;
    },
    byProcess(processId: string): OrgEvaluation | undefined {
      const r = db.prepare(`SELECT * FROM org_evaluations WHERE process_id = ? ORDER BY created_at DESC LIMIT 1`).get(processId);
      return r ? map(r) : undefined;
    },
    /** Historial de más reciente a más antigua. projectId: undefined = todas; null = solo de empresa; id = de ese proyecto. */
    list(filter: { projectId?: string | null } = {}): OrgEvaluation[] {
      const rows = filter.projectId === undefined
        ? db.prepare(`SELECT * FROM org_evaluations ORDER BY created_at DESC, rowid DESC`).all()
        : filter.projectId === null
          ? db.prepare(`SELECT * FROM org_evaluations WHERE scope_kind = 'workspace' ORDER BY created_at DESC, rowid DESC`).all()
          : db.prepare(`SELECT * FROM org_evaluations WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`).all(filter.projectId);
      return (rows as any[]).map(map);
    },
    update(id: string, patch: Partial<Pick<OrgEvaluation, 'processId' | 'status' | 'knowledgeDocId' | 'summary' | 'proposals' | 'error'>>): OrgEvaluation {
      const cur = this.get(id);
      if (!cur) throw httpError(404, 'Evaluación no encontrada');
      const next = { ...cur, ...patch };
      db.prepare(`UPDATE org_evaluations SET process_id = ?, status = ?, knowledge_doc_id = ?, summary = ?, proposals_json = ?, error = ?, updated_at = ? WHERE id = ?`)
        .run(next.processId, next.status, next.knowledgeDocId, next.summary, JSON.stringify(next.proposals), next.error, now(), id);
      return this.get(id)!;
    },
    /** Registra la decisión del propietario sobre UNA propuesta. 404 si no existe; 409 si ya estaba decidida. Sin efectos organizativos. */
    setProposalDecision(id: string, proposalId: string, decision: Exclude<OrgDecision, 'pending'>, decidedBy = 'owner'): { evaluation: OrgEvaluation; proposal: OrgProposal } {
      const cur = this.get(id);
      if (!cur) throw httpError(404, 'Evaluación no encontrada');
      const p = cur.proposals.find(x => x.id === proposalId);
      if (!p) throw httpError(404, 'Propuesta no encontrada');
      if (p.decision !== 'pending') throw httpError(409, `La propuesta ya está ${p.decision === 'accepted' ? 'aceptada' : 'rechazada'}.`, 'already_decided');
      const updated: OrgProposal = { ...p, decision, decidedAt: now(), decidedBy };
      const evaluation = this.update(id, { proposals: cur.proposals.map(x => (x.id === proposalId ? updated : x)) });
      return { evaluation, proposal: updated };
    }
  };
}

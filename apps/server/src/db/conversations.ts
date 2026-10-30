import crypto from 'node:crypto';
import type { ConversationArtifact, ConversationArtifactKind, ConversationDecision, ConversationStage, DecisionStatus, AssistantConversation } from '@portal-ia/domain';
import { monotonicNow } from '../clock.ts';
import { platform } from './platform.ts';

/**
 * Conversaciones del Asistente (v0.16), su registro de decisiones y sus artefactos (propuesta, cuestionamiento,
 * revisión del equipo, borradores de historias). En la base de plataforma, como los mensajes del Asistente; aditivo.
 * Los mensajes anteriores (sin conversación) pasan a «Historial anterior» una vez, al arrancar (leer nunca escribe).
 */
platform.exec(`CREATE TABLE IF NOT EXISTS assistant_conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, stage TEXT NOT NULL, workspace_slug TEXT, project_id TEXT, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_decisions (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, doc_json TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_decisions_conv ON assistant_decisions(conversation_id, seq);
CREATE TABLE IF NOT EXISTS assistant_artifacts (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  doc_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_artifacts_conv ON assistant_artifacts(conversation_id, kind, version);`);
{ const cols = (platform.prepare(`PRAGMA table_info(assistant_messages)`).all() as any[]).map(c => c.name); if (cols.length && !cols.includes('conversation_id')) platform.exec(`ALTER TABLE assistant_messages ADD COLUMN conversation_id TEXT`); }

const mapConv = (r: any): AssistantConversation => ({ id: r.id, title: r.title, stage: r.stage, workspaceSlug: r.workspace_slug ?? null, projectId: r.project_id ?? null, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });

export const conversationsRepo = {
  /** Migración única (al arrancar): los mensajes anteriores a las conversaciones pasan a «Historial anterior». Leer nunca escribe. */
  migrateOrphans() {
    const orphan = (platform.prepare(`SELECT COUNT(*) AS n FROM assistant_messages WHERE conversation_id IS NULL`).get() as any).n as number;
    if (orphan) { const c = this.create('Historial anterior', null, null); platform.prepare(`UPDATE assistant_messages SET conversation_id = ? WHERE conversation_id IS NULL`).run(c.id); }
  },
  list(): AssistantConversation[] {
    return (platform.prepare(`SELECT * FROM assistant_conversations WHERE status != 'deleted' ORDER BY updated_at DESC`).all() as any[]).map(mapConv);
  },
  get(id: string): AssistantConversation | null { const r = platform.prepare(`SELECT * FROM assistant_conversations WHERE id = ?`).get(id); return r ? mapConv(r) : null; },
  create(title: string, workspaceSlug: string | null, projectId: string | null): AssistantConversation {
    const id = crypto.randomUUID(); const at = monotonicNow();
    platform.prepare(`INSERT INTO assistant_conversations (id, title, stage, workspace_slug, project_id, status, created_at, updated_at) VALUES (?, ?, 'exploration', ?, ?, 'active', ?, ?)`).run(id, title.slice(0, 120) || 'Conversación', workspaceSlug, projectId, at, at);
    return this.get(id)!;
  },
  update(id: string, patch: Partial<Pick<AssistantConversation, 'title' | 'stage' | 'workspaceSlug' | 'projectId' | 'status'>>): AssistantConversation {
    const c = this.get(id); if (!c) throw Object.assign(new Error('Conversación no encontrada'), { statusCode: 404 });
    const n = { ...c, ...patch };
    platform.prepare(`UPDATE assistant_conversations SET title = ?, stage = ?, workspace_slug = ?, project_id = ?, status = ?, updated_at = ? WHERE id = ?`).run(n.title, n.stage, n.workspaceSlug, n.projectId, n.status, monotonicNow(), id);
    return this.get(id)!;
  },
  touch(id: string) { platform.prepare(`UPDATE assistant_conversations SET updated_at = ? WHERE id = ?`).run(monotonicNow(), id); }
};

export const decisionsRepo = {
  list(conversationId: string): ConversationDecision[] { return (platform.prepare(`SELECT doc_json FROM assistant_decisions WHERE conversation_id = ? ORDER BY seq`).all(conversationId) as any[]).map(r => JSON.parse(r.doc_json)); },
  get(id: string): ConversationDecision | null { const r = platform.prepare(`SELECT doc_json FROM assistant_decisions WHERE id = ?`).get(id) as any; return r ? JSON.parse(r.doc_json) : null; },
  add(conversationId: string, d: Omit<ConversationDecision, 'id' | 'conversationId' | 'seq' | 'status' | 'answer' | 'note' | 'history' | 'createdAt' | 'updatedAt' | 'decidedAt'>): ConversationDecision {
    const seq = ((platform.prepare(`SELECT MAX(seq) AS n FROM assistant_decisions WHERE conversation_id = ?`).get(conversationId) as any)?.n ?? 0) + 1;
    const at = monotonicNow();
    const doc: ConversationDecision = { ...d, id: crypto.randomUUID(), conversationId, seq, status: 'open', answer: null, note: null, history: [], createdAt: at, updatedAt: at, decidedAt: null };
    platform.prepare(`INSERT INTO assistant_decisions (id, conversation_id, seq, doc_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(doc.id, conversationId, seq, JSON.stringify(doc), doc.status, at, at);
    return doc;
  },
  update(id: string, fn: (d: ConversationDecision) => void): ConversationDecision {
    const d = this.get(id); if (!d) throw Object.assign(new Error('Decisión no encontrada'), { statusCode: 404 });
    fn(d); d.updatedAt = monotonicNow();
    platform.prepare(`UPDATE assistant_decisions SET doc_json = ?, status = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(d), d.status, d.updatedAt, id);
    return d;
  }
};

export const artifactsRepo = {
  list(conversationId: string, kind?: ConversationArtifactKind): ConversationArtifact[] {
    const rows = (kind ? platform.prepare(`SELECT doc_json FROM assistant_artifacts WHERE conversation_id = ? AND kind = ? ORDER BY version`).all(conversationId, kind) : platform.prepare(`SELECT doc_json FROM assistant_artifacts WHERE conversation_id = ? ORDER BY created_at`).all(conversationId)) as any[];
    return rows.map(r => JSON.parse(r.doc_json));
  },
  latest(conversationId: string, kind: ConversationArtifactKind): ConversationArtifact | null { return this.list(conversationId, kind).at(-1) ?? null; },
  get(id: string): ConversationArtifact | null { const r = platform.prepare(`SELECT doc_json FROM assistant_artifacts WHERE id = ?`).get(id) as any; return r ? JSON.parse(r.doc_json) : null; },
  add(conversationId: string, kind: ConversationArtifactKind, content: ConversationArtifact['content'], status: ConversationArtifact['status'], meta: Partial<Pick<ConversationArtifact, 'basedOn' | 'calls' | 'agents'>> = {}): ConversationArtifact {
    const version = ((platform.prepare(`SELECT MAX(version) AS n FROM assistant_artifacts WHERE conversation_id = ? AND kind = ?`).get(conversationId, kind) as any)?.n ?? 0) + 1;
    const at = monotonicNow();
    const doc: ConversationArtifact = { id: crypto.randomUUID(), conversationId, kind, version, status, content, basedOn: meta.basedOn ?? null, calls: meta.calls ?? 0, agents: meta.agents ?? [], createdAt: at, updatedAt: at, decidedAt: null };
    platform.prepare(`INSERT INTO assistant_artifacts (id, conversation_id, kind, version, status, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(doc.id, conversationId, kind, version, status, JSON.stringify(doc), at, at);
    return doc;
  },
  update(id: string, fn: (a: ConversationArtifact) => void): ConversationArtifact {
    const a = this.get(id); if (!a) throw Object.assign(new Error('Artefacto no encontrado'), { statusCode: 404 });
    fn(a); a.updatedAt = monotonicNow();
    platform.prepare(`UPDATE assistant_artifacts SET doc_json = ?, status = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(a), a.status, a.updatedAt, id);
    return a;
  }
};

export type { DecisionStatus, ConversationStage };

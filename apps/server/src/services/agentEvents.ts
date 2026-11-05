import crypto from 'node:crypto';
import { workspaceDb } from '../db/workspace.ts';
import { changed } from './live.ts';
import { monotonicNow } from '../clock.ts';

/**
 * Registro auditable de lo que le pasa a un agente como entidad (no sus llamadas, que ya registran execution_history y
 * claude_code_runs): creación, importación, cambio de arnés, de departamento, de carpeta (adoptar, descartar, volver
 * atrás), memoria verificada o retirada. Solo se añade; nunca se edita ni se borra.
 */
export type AgentEventKind = 'created' | 'imported' /* HU-183: importación desde ZIP y su Deshacer */ | 'imported_zip' | 'imported_zip_undone' | 'exported' | 'harness_changed' | 'department_changed' | 'folder_created' | 'folder_adopted' | 'folder_discarded' | 'folder_restored' | 'identity_updated' | 'memory_proposed' | 'memory_verified' | 'memory_retired' | 'task_created' | 'chat'
  | 'source_imported' | 'source_adopted' | 'source_grants' | 'source_restored' | 'integration_state' | 'document_job' | 'improvement_proposed' | 'improvement_applied' | 'improvement_rejected';
export interface AgentEvent { id: string; agentId: string; kind: AgentEventKind; detail: Record<string, unknown>; at: string; by: string }

function ensure(slug: string) {
  const db = workspaceDb(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_events (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL, by TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_events_agent ON agent_events(agent_id, at);`);
  return db;
}

export function recordAgentEvent(slug: string, agentId: string, kind: AgentEventKind, detail: Record<string, unknown> = {}, by = 'owner'): void {
  try {
    ensure(slug).prepare(`INSERT INTO agent_events (id, agent_id, kind, detail_json, at, by) VALUES (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), agentId, kind, JSON.stringify(detail), monotonicNow(), by);
    changed({ ws: slug, entity: 'agent', id: agentId });
  } catch { /* la auditoría nunca rompe la operación */ }
}

export function agentEvents(slug: string, agentId: string, limit = 50): AgentEvent[] {
  return (ensure(slug).prepare(`SELECT * FROM agent_events WHERE agent_id = ? ORDER BY at DESC LIMIT ?`).all(agentId, limit) as any[])
    .map(r => ({ id: r.id, agentId: r.agent_id, kind: r.kind, detail: JSON.parse(r.detail_json), at: r.at, by: r.by }));
}

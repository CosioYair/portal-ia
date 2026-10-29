import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config } from '../config.ts';
import type { ModelInfo, ProviderError, ProviderId, Workspace } from '@portal-ia/domain';

/**
 * Base de datos de plataforma (una por instalación): proveedores, credenciales cifradas,
 * registro de espacios de trabajo y ajustes. Los datos de cada espacio viven en su propia base (workspace.ts).
 */
export const platform = new DatabaseSync(path.join(config.dataDir, 'platform.sqlite'));
platform.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
platform.exec(`
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'not_configured',
  verified_at TEXT,
  last_error TEXT,
  default_model TEXT,
  models_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  hint TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('internal','company')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
// Migración v0.1.1: ID de workspace opcional (Anthropic exige `anthropic-workspace-id` con claves no asociadas a un workspace).
const providerCols = (platform.prepare(`PRAGMA table_info(providers)`).all() as any[]).map(c => c.name);
if (!providerCols.includes('workspace_id')) platform.exec(`ALTER TABLE providers ADD COLUMN workspace_id TEXT`);

const now = () => new Date().toISOString();

export interface ProviderRow {
  id: ProviderId; status: string; verified_at: string | null; last_error: string | null;
  default_model: string | null; models_json: string; updated_at: string; workspace_id: string | null;
}

export const providersRepo = {
  ensure(id: ProviderId) {
    platform.prepare(`INSERT OR IGNORE INTO providers (id, updated_at) VALUES (?, ?)`).run(id, now());
  },
  setWorkspaceId(id: ProviderId, workspaceId: string | null) {
    this.ensure(id);
    platform.prepare(`UPDATE providers SET workspace_id = ?, updated_at = ? WHERE id = ?`).run(workspaceId, now(), id);
  },
  get(id: ProviderId): ProviderRow | undefined {
    this.ensure(id);
    return platform.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as ProviderRow | undefined;
  },
  credential(id: ProviderId): { ciphertext: string; hint: string } | undefined {
    return platform.prepare(`SELECT ciphertext, hint FROM credentials WHERE provider_id = ?`).get(id) as any;
  },
  setCredential(id: ProviderId, ciphertext: string, hint: string) {
    this.ensure(id);
    platform.prepare(`INSERT INTO credentials (provider_id, ciphertext, hint, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at`).run(id, ciphertext, hint, now());
    platform.prepare(`UPDATE providers SET status = 'not_configured', verified_at = NULL, last_error = NULL, models_json = '[]', default_model = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
  },
  deleteCredential(id: ProviderId) {
    platform.prepare(`DELETE FROM credentials WHERE provider_id = ?`).run(id);
    platform.prepare(`UPDATE providers SET status = 'not_configured', verified_at = NULL, last_error = NULL, models_json = '[]', default_model = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
  },
  setConnecting(id: ProviderId) {
    platform.prepare(`UPDATE providers SET status = 'connecting', last_error = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
  },
  setConnected(id: ProviderId, models: ModelInfo[]) {
    const row = this.get(id)!;
    const keep = row.default_model && models.some(m => m.id === row.default_model) ? row.default_model : null;
    platform.prepare(`UPDATE providers SET status = 'connected', verified_at = ?, last_error = NULL, models_json = ?, default_model = ?, updated_at = ? WHERE id = ?`)
      .run(now(), JSON.stringify(models), keep, now(), id);
  },
  setFailed(id: ProviderId, err: ProviderError) {
    platform.prepare(`UPDATE providers SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(err), now(), id);
  },
  setDefaultModel(id: ProviderId, modelId: string) {
    platform.prepare(`UPDATE providers SET default_model = ?, updated_at = ? WHERE id = ?`).run(modelId, now(), id);
  },
  connected(): ProviderRow[] {
    return platform.prepare(`SELECT * FROM providers WHERE status = 'connected' ORDER BY verified_at`).all() as unknown as ProviderRow[];
  }
};

export const workspacesRepo = {
  list(): Workspace[] {
    return (platform.prepare(`SELECT slug, name, kind, created_at AS createdAt FROM workspaces ORDER BY created_at`).all() as unknown as Workspace[]);
  },
  get(slug: string): Workspace | undefined {
    return platform.prepare(`SELECT slug, name, kind, created_at AS createdAt FROM workspaces WHERE slug = ?`).get(slug) as Workspace | undefined;
  },
  create(w: Omit<Workspace, 'createdAt'>): Workspace {
    const createdAt = now();
    platform.prepare(`INSERT INTO workspaces (slug, name, kind, created_at) VALUES (?, ?, ?, ?)`).run(w.slug, w.name, w.kind, createdAt);
    return { ...w, createdAt };
  }
};

export const settingsRepo = {
  get(key: string): string | null { const r = platform.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any; return r ? r.value : null; },
  set(key: string, value: string) { platform.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value); }
};

// v0.13 · Conector Claude Code: consolas autorizadas (puente MCP). El token se guarda solo como hash SHA-256.
platform.exec(`
CREATE TABLE IF NOT EXISTS claude_code_workers (
  id TEXT PRIMARY KEY, workspace_slug TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, agent_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT, client_json TEXT
);
`);

export interface ClaudeCodeWorkerRow {
  id: string; workspace_slug: string; name: string; token_hash: string; agent_ids_json: string;
  created_at: string; revoked_at: string | null; last_seen_at: string | null; client_json: string | null;
}

export const claudeCodeWorkersRepo = {
  create(w: { id: string; workspaceSlug: string; name: string; tokenHash: string; agentIds: string[] }) {
    platform.prepare(`INSERT INTO claude_code_workers (id, workspace_slug, name, token_hash, agent_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(w.id, w.workspaceSlug, w.name, w.tokenHash, JSON.stringify(w.agentIds), now());
  },
  byHash(hash: string): ClaudeCodeWorkerRow | undefined { return platform.prepare(`SELECT * FROM claude_code_workers WHERE token_hash = ?`).get(hash) as ClaudeCodeWorkerRow | undefined; },
  get(id: string): ClaudeCodeWorkerRow | undefined { return platform.prepare(`SELECT * FROM claude_code_workers WHERE id = ?`).get(id) as ClaudeCodeWorkerRow | undefined; },
  list(slug: string): ClaudeCodeWorkerRow[] { return platform.prepare(`SELECT * FROM claude_code_workers WHERE workspace_slug = ? ORDER BY created_at DESC`).all(slug) as unknown as ClaudeCodeWorkerRow[]; },
  revoke(id: string) { platform.prepare(`UPDATE claude_code_workers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now(), id); },
  seen(id: string, client: unknown) { platform.prepare(`UPDATE claude_code_workers SET last_seen_at = ?, client_json = COALESCE(?, client_json) WHERE id = ?`).run(now(), client === undefined ? null : JSON.stringify(client), id); }
};

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.ts';
import { defaultCapabilitiesFor } from '@portal-ia/domain';
import type { DelegationResult, Agent, AgentConfig, AgentStatus, AgentTemplate, BacklogItem, BacklogStatus, ContextItem, ExecutionResult, KnowledgeDoc, Objective, Process, ProcessStatus, ProcessStep, Project, Repository, Scope, StepStatus, UsageToday } from '@portal-ia/domain';

/**
 * Una base SQLite por espacio de trabajo: data/workspaces/<slug>/<slug>.sqlite
 * Aislamiento total entre el espacio interno y las futuras empresas.
 */
const open = new Map<string, DatabaseSync>();
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

export function workspaceDbPath(slug: string) { return path.join(config.dataDir, 'workspaces', slug, `${slug}.sqlite`); }

export function workspaceDb(slug: string): DatabaseSync {
  let db = open.get(slug);
  if (db) return db;
  const file = workspaceDbPath(slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS objectives (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, position INTEGER NOT NULL, text TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS context_items (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, position INTEGER NOT NULL, label TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT NOT NULL, author_agent_id TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, path TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'read-only', branch TEXT, authorized_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, key TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, template_id TEXT NOT NULL, scope TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'inactive', config_json TEXT NOT NULL, config_edited INTEGER NOT NULL DEFAULT 0, template_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(key, project_id)
  );
  CREATE TABLE IF NOT EXISTS execution_history (
    id TEXT PRIMARY KEY, project_id TEXT, agent_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS processes (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
    budget_usd REAL NOT NULL DEFAULT 0, estimated_usd REAL NOT NULL DEFAULT 0, spent_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, authorized_at TEXT, started_at TEXT, finished_at TEXT, error TEXT
  );
  CREATE TABLE IF NOT EXISTS process_steps (
    id TEXT PRIMARY KEY, process_id TEXT NOT NULL REFERENCES processes(id) ON DELETE CASCADE, position INTEGER NOT NULL, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', model TEXT, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
    output_md TEXT, error TEXT, started_at TEXT, finished_at TEXT
  );
  `);
  db.exec(`
  CREATE TABLE IF NOT EXISTS backlog_items (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, story_id TEXT NOT NULL, title TEXT NOT NULL, owner_key TEXT, depends_on TEXT,
    estimate TEXT, criterion TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', position INTEGER NOT NULL,
    source_process_id TEXT, last_process_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  const pcols = (db.prepare(`PRAGMA table_info(processes)`).all() as any[]).map(c => c.name);
  if (!pcols.includes('result_json')) db.exec(`ALTER TABLE processes ADD COLUMN result_json TEXT`);
  if (!pcols.includes('delegation_json')) db.exec(`ALTER TABLE processes ADD COLUMN delegation_json TEXT`);
  if (!pcols.includes('backlog_item_id')) db.exec(`ALTER TABLE processes ADD COLUMN backlog_item_id TEXT`);
  // M3/M4: papel y motivo de cada paso; lecciones inyectadas.
  const scols = (db.prepare(`PRAGMA table_info(process_steps)`).all() as any[]).map(c => c.name);
  if (!scols.includes('role')) db.exec(`ALTER TABLE process_steps ADD COLUMN role TEXT`);
  if (!scols.includes('reason')) db.exec(`ALTER TABLE process_steps ADD COLUMN reason TEXT`);
  if (!scols.includes('lessons_used')) db.exec(`ALTER TABLE process_steps ADD COLUMN lessons_used TEXT`);
  // v0.12.2: estado real de la llamada en curso y costo posiblemente facturado pero no confirmado (estimación).
  if (!scols.includes('live_json')) db.exec(`ALTER TABLE process_steps ADD COLUMN live_json TEXT`);
  if (!scols.includes('unconfirmed_usd')) db.exec(`ALTER TABLE process_steps ADD COLUMN unconfirmed_usd REAL NOT NULL DEFAULT 0`);
  const pcols3 = (db.prepare(`PRAGMA table_info(processes)`).all() as any[]).map(c => c.name);
  if (!pcols3.includes('unconfirmed_usd')) db.exec(`ALTER TABLE processes ADD COLUMN unconfirmed_usd REAL NOT NULL DEFAULT 0`);
  // M5: versión de plantilla aplicada a cada agente.
  const acols = (db.prepare(`PRAGMA table_info(agents)`).all() as any[]).map(c => c.name);
  if (!acols.includes('template_version')) db.exec(`ALTER TABLE agents ADD COLUMN template_version TEXT`);
  // Migración: conocimiento con nombre de autor y proceso de origen.
  const kcols = (db.prepare(`PRAGMA table_info(knowledge)`).all() as any[]).map(c => c.name);
  if (!kcols.includes('author_agent_name')) db.exec(`ALTER TABLE knowledge ADD COLUMN author_agent_name TEXT`);
  if (!kcols.includes('process_id')) db.exec(`ALTER TABLE knowledge ADD COLUMN process_id TEXT`);
  // Etapas operativas: archivo reversible (la fila se conserva; solo sale del flujo activo).
  const bcols = (db.prepare(`PRAGMA table_info(backlog_items)`).all() as any[]).map(c => c.name);
  if (!bcols.includes('archived_at')) db.exec(`ALTER TABLE backlog_items ADD COLUMN archived_at TEXT`);
  if (!bcols.includes('archive_id')) db.exec(`ALTER TABLE backlog_items ADD COLUMN archive_id TEXT`);
  const pcols2 = (db.prepare(`PRAGMA table_info(processes)`).all() as any[]).map(c => c.name);
  if (!pcols2.includes('archived_at')) db.exec(`ALTER TABLE processes ADD COLUMN archived_at TEXT`);
  if (!pcols2.includes('archive_id')) db.exec(`ALTER TABLE processes ADD COLUMN archive_id TEXT`);
  open.set(slug, db);
  return db;
}

export function projectsRepo(slug: string) {
  const db = workspaceDb(slug);
  const map = (r: any): Project => ({ id: r.id, workspaceSlug: slug, slug: r.slug, name: r.name, description: r.description, createdAt: r.created_at });
  return {
    list(): Project[] { return (db.prepare(`SELECT * FROM projects ORDER BY created_at`).all() as any[]).map(map); },
    get(id: string): Project | undefined { const r = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id); return r ? map(r) : undefined; },
    bySlug(pslug: string): Project | undefined { const r = db.prepare(`SELECT * FROM projects WHERE slug = ?`).get(pslug); return r ? map(r) : undefined; },
    create(p: { slug: string; name: string; description: string }): Project {
      const id = uuid(); const createdAt = now();
      db.prepare(`INSERT INTO projects (id, slug, name, description, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, p.slug, p.name, p.description, createdAt);
      return { id, workspaceSlug: slug, ...p, createdAt };
    },
    setObjectives(projectId: string, texts: readonly string[]) {
      db.prepare(`DELETE FROM objectives WHERE project_id = ?`).run(projectId);
      const ins = db.prepare(`INSERT INTO objectives (id, project_id, position, text) VALUES (?, ?, ?, ?)`);
      texts.forEach((t, i) => ins.run(uuid(), projectId, i, t));
    },
    objectives(projectId: string): Objective[] {
      return (db.prepare(`SELECT id, project_id AS projectId, position, text FROM objectives WHERE project_id = ? ORDER BY position`).all(projectId) as unknown as Objective[]);
    },
    setContext(projectId: string, labels: readonly string[]) {
      db.prepare(`DELETE FROM context_items WHERE project_id = ?`).run(projectId);
      const ins = db.prepare(`INSERT INTO context_items (id, project_id, position, label) VALUES (?, ?, ?, ?)`);
      labels.forEach((l, i) => ins.run(uuid(), projectId, i, l));
    },
    context(projectId: string): ContextItem[] {
      return (db.prepare(`SELECT id, project_id AS projectId, position, label FROM context_items WHERE project_id = ? ORDER BY position`).all(projectId) as unknown as ContextItem[]);
    },
    repository(projectId: string): Repository | null {
      const r = db.prepare(`SELECT id, project_id AS projectId, path, mode, branch, authorized_at AS authorizedAt FROM repositories WHERE project_id = ? ORDER BY authorized_at DESC LIMIT 1`).get(projectId) as any;
      return r ?? null;
    },
    setRepository(projectId: string, p: string, branch: string | null): Repository {
      db.prepare(`DELETE FROM repositories WHERE project_id = ?`).run(projectId);
      const id = uuid(); const authorizedAt = now();
      db.prepare(`INSERT INTO repositories (id, project_id, path, mode, branch, authorized_at) VALUES (?, ?, ?, 'read-only', ?, ?)`).run(id, projectId, p, branch, authorizedAt);
      return { id, projectId, path: p, mode: 'read-only', branch, authorizedAt };
    },
    knowledgeCount(projectId: string): number { return (db.prepare(`SELECT COUNT(*) AS n FROM knowledge WHERE project_id = ?`).get(projectId) as any).n; },
    usageToday(): UsageToday {
      const day = new Date().toISOString().slice(0, 10);
      const r = db.prepare(`SELECT COUNT(*) AS calls, SUM(CASE WHEN status <> 'done' THEN 1 ELSE 0 END) AS failed, COALESCE(SUM(tokens_in + tokens_out),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost FROM execution_history WHERE substr(started_at,1,10) = ?`).get(day) as any;
      const p = db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running FROM processes WHERE substr(created_at,1,10) = ? OR status = 'running'`).get(day) as any;
      return { processes: p.n ?? 0, tokens: r.tokens, costUsd: r.cost, running: p.running ?? 0, calls: r.calls ?? 0, failedCalls: r.failed ?? 0 };
    }
  };
}

export function agentsRepo(slug: string) {
  const db = workspaceDb(slug);
  const map = (r: any): Agent => {
    const config: AgentConfig = JSON.parse(r.config_json);
    // M3: agentes creados antes de las capacidades → capacidades por defecto de su plantilla (sin modificar la fila).
    if (!Array.isArray(config.capabilities)) config.capabilities = defaultCapabilitiesFor(r.key);
    return {
      id: r.id, key: r.key, workspaceSlug: slug, projectId: r.project_id, templateId: r.template_id, scope: r.scope as Scope, status: r.status,
      config, configEdited: !!r.config_edited, template: JSON.parse(r.template_json), createdAt: r.created_at, updatedAt: r.updated_at,
      templateVersion: r.template_version ?? null
    };
  };
  return {
    list(): Agent[] { return (db.prepare(`SELECT * FROM agents ORDER BY scope DESC, created_at`).all() as any[]).map(map); },
    get(id: string): Agent | undefined { const r = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id); return r ? map(r) : undefined; },
    byKey(key: string, projectId: string | null): Agent | undefined {
      const r = projectId ? db.prepare(`SELECT * FROM agents WHERE key = ? AND project_id = ?`).get(key, projectId) : db.prepare(`SELECT * FROM agents WHERE key = ? AND project_id IS NULL`).get(key);
      return r ? map(r) : undefined;
    },
    count(): number { return (db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as any).n; },
    createFromTemplate(t: AgentTemplate, projectId: string | null, config: AgentConfig): Agent {
      const id = uuid(); const ts = now();
      const tpl = { initials: t.initials, role: t.role, reportsTo: t.reportsTo, supervises: t.supervises, collaborates: t.collaborates, evaluation: t.evaluation, tier: t.tier };
      db.prepare(`INSERT INTO agents (id, key, project_id, template_id, scope, status, config_json, config_edited, template_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'inactive', ?, 0, ?, ?, ?)`).run(id, t.key, projectId, t.id, t.scope, JSON.stringify(config), JSON.stringify(tpl), ts, ts);
      return this.get(id)!;
    },
    updateConfig(id: string, config: AgentConfig): Agent {
      db.prepare(`UPDATE agents SET config_json = ?, config_edited = 1, updated_at = ? WHERE id = ?`).run(JSON.stringify(config), now(), id);
      return this.get(id)!;
    },
    setStatus(id: string, status: AgentStatus) {
      db.prepare(`UPDATE agents SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), id);
    },
    /** Agente especializado creado por el usuario (plantilla 'custom'). */
    createCustom(input: { key: string; scope: Scope; projectId: string | null; config: AgentConfig; template: Agent['template'] }): Agent {
      const id = uuid(); const ts = now();
      db.prepare(`INSERT INTO agents (id, key, project_id, template_id, scope, status, config_json, config_edited, template_json, created_at, updated_at)
        VALUES (?, ?, ?, 'tpl.custom@1', ?, 'inactive', ?, 0, ?, ?, ?)`).run(id, input.key, input.projectId, input.scope, JSON.stringify(input.config), JSON.stringify(input.template), ts, ts);
      return this.get(id)!;
    },
    updateTemplateMeta(id: string, template: Agent['template']) {
      db.prepare(`UPDATE agents SET template_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(template), now(), id);
    },
    delete(id: string) { db.prepare(`DELETE FROM agents WHERE id = ?`).run(id); },
    keyExists(key: string): boolean { return !!db.prepare(`SELECT 1 FROM agents WHERE key = ?`).get(key); }
  };
}

export function knowledgeRepo(slug: string) {
  const db = workspaceDb(slug);
  const map = (r: any): KnowledgeDoc => ({ id: r.id, projectId: r.project_id, title: r.title, body: r.body, authorAgentId: r.author_agent_id, authorAgentName: r.author_agent_name ?? null, processId: r.process_id ?? null, version: r.version, createdAt: r.created_at });
  return {
    list(projectId: string): KnowledgeDoc[] { return (db.prepare(`SELECT * FROM knowledge WHERE project_id = ? ORDER BY created_at DESC`).all(projectId) as any[]).map(map); },
    get(id: string): KnowledgeDoc | undefined { const r = db.prepare(`SELECT * FROM knowledge WHERE id = ?`).get(id); return r ? map(r) : undefined; },
    add(d: { projectId: string; title: string; body: string; authorAgentId: string | null; authorAgentName: string | null; processId: string | null; version?: number }): KnowledgeDoc {
      const id = uuid();
      db.prepare(`INSERT INTO knowledge (id, project_id, title, body, author_agent_id, author_agent_name, process_id, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, d.projectId, d.title, d.body, d.authorAgentId, d.authorAgentName, d.processId, d.version ?? 1, now());
      return this.get(id)!;
    }
  };
}

export function processesRepo(slug: string) {
  const db = workspaceDb(slug);
  const mapStep = (r: any): ProcessStep => ({ id: r.id, processId: r.process_id, position: r.position, agentId: r.agent_id, agentName: r.agent_name, title: r.title, status: r.status, model: r.model, inputTokens: r.tokens_in, outputTokens: r.tokens_out, costUsd: r.cost_usd, outputMd: r.output_md, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at, role: r.role ?? null, reason: r.reason ?? null, lessonsUsed: r.lessons_used ? JSON.parse(r.lessons_used) : [], live: r.live_json ? JSON.parse(r.live_json) : null, unconfirmedUsd: r.unconfirmed_usd ?? 0 });
  const mapProc = (r: any): Process => ({ id: r.id, projectId: r.project_id, kind: r.kind, title: r.title, status: r.status, budgetUsd: r.budget_usd, estimatedUsd: r.estimated_usd, spentUsd: r.spent_usd, inputTokens: r.tokens_in, outputTokens: r.tokens_out, createdAt: r.created_at, authorizedAt: r.authorized_at, startedAt: r.started_at, finishedAt: r.finished_at, error: r.error,
    result: r.result_json ? JSON.parse(r.result_json) : null, delegation: r.delegation_json ? JSON.parse(r.delegation_json) : null, backlogItemId: r.backlog_item_id ?? null, unconfirmedUsd: r.unconfirmed_usd ?? 0,
    archivedAt: r.archived_at ?? null, archiveId: r.archive_id ?? null,
    steps: (db.prepare(`SELECT * FROM process_steps WHERE process_id = ? ORDER BY position`).all(r.id) as any[]).map(mapStep) });
  return {
    /** Procesos activos (los archivados al iniciar una etapa quedan fuera del flujo: ver listAll / listArchived). */
    list(projectId: string): Process[] { return (db.prepare(`SELECT * FROM processes WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC`).all(projectId) as any[]).map(mapProc); },
    listAll(projectId: string): Process[] { return (db.prepare(`SELECT * FROM processes WHERE project_id = ? ORDER BY created_at DESC`).all(projectId) as any[]).map(mapProc); },
    listArchived(projectId: string): Process[] { return (db.prepare(`SELECT * FROM processes WHERE project_id = ? AND archived_at IS NOT NULL ORDER BY created_at DESC`).all(projectId) as any[]).map(mapProc); },
    get(id: string): Process | undefined { const r = db.prepare(`SELECT * FROM processes WHERE id = ?`).get(id); return r ? mapProc(r) : undefined; },
    running(): Process[] { return (db.prepare(`SELECT * FROM processes WHERE status = 'running'`).all() as any[]).map(mapProc); },
    create(p: { projectId: string; kind: string; title: string; estimatedUsd: number; backlogItemId?: string | null; steps: { agentId: string; agentName: string; title: string; model: string; role?: string | null; reason?: string | null }[] }): Process {
      const id = uuid();
      db.prepare(`INSERT INTO processes (id, project_id, kind, title, status, estimated_usd, created_at, backlog_item_id) VALUES (?, ?, ?, ?, 'pending_authorization', ?, ?, ?)`).run(id, p.projectId, p.kind, p.title, p.estimatedUsd, now(), p.backlogItemId ?? null);
      const ins = db.prepare(`INSERT INTO process_steps (id, process_id, position, agent_id, agent_name, title, model, role, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      p.steps.forEach((s, i) => ins.run(uuid(), id, i, s.agentId, s.agentName, s.title, s.model, s.role ?? null, s.reason ?? null));
      return this.get(id)!;
    },
    /** Paso añadido durante la ejecución (reparación de la entrega, corrección, nueva revisión de QA). Devuelve el paso. */
    addStep(processId: string, s: { agentId: string; agentName: string; title: string; model: string; role?: string | null; reason?: string | null }): ProcessStep {
      const pos = ((db.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM process_steps WHERE process_id = ?`).get(processId) as any).m as number) + 1;
      const id = uuid();
      db.prepare(`INSERT INTO process_steps (id, process_id, position, agent_id, agent_name, title, model, role, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, processId, pos, s.agentId, s.agentName, s.title, s.model, s.role ?? null, s.reason ?? null);
      return this.get(processId)!.steps.find(x => x.id === id)!;
    },
    /** Reanudar un proceso con más presupuesto (autorizado por el propietario): vuelve a «en ejecución». */
    resume(id: string, budgetUsd: number) { db.prepare(`UPDATE processes SET status = 'running', budget_usd = ?, finished_at = NULL, error = NULL WHERE id = ?`).run(budgetUsd, id); },
    setStepLessons(stepId: string, ids: string[]) { db.prepare(`UPDATE process_steps SET lessons_used = ? WHERE id = ?`).run(JSON.stringify(ids), stepId); },
    /** Métricas de participación de un agente derivadas de process_steps (sin IA). */
    agentStats(agentId: string): { steps: number; done: number; failed: number; costUsd: number; byRole: Record<string, number>; lastAt: string | null } {
      const rows = db.prepare(`SELECT role, status, cost_usd, finished_at FROM process_steps WHERE agent_id = ? AND status IN ('done','failed')`).all(agentId) as any[];
      const byRole: Record<string, number> = {};
      for (const r of rows) byRole[r.role ?? 'otro'] = (byRole[r.role ?? 'otro'] ?? 0) + 1;
      return { steps: rows.length, done: rows.filter(r => r.status === 'done').length, failed: rows.filter(r => r.status === 'failed').length, costUsd: rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0), byRole, lastAt: rows.map(r => r.finished_at).filter(Boolean).sort().at(-1) ?? null };
    },
    authorize(id: string, budgetUsd: number) {
      db.prepare(`UPDATE processes SET status = 'running', budget_usd = ?, authorized_at = ?, started_at = ? WHERE id = ?`).run(budgetUsd, now(), now(), id);
    },
    setResult(id: string, result: ExecutionResult) { db.prepare(`UPDATE processes SET result_json = ? WHERE id = ?`).run(JSON.stringify(result), id); },
    setDelegation(id: string, d: DelegationResult) { db.prepare(`UPDATE processes SET delegation_json = ? WHERE id = ?`).run(JSON.stringify(d), id); },
    finish(id: string, status: ProcessStatus, error: string | null = null) {
      db.prepare(`UPDATE processes SET status = ?, finished_at = ?, error = ? WHERE id = ?`).run(status, now(), error, id);
    },
    /** Estado real de la llamada en curso de un paso (null al terminar). */
    setStepLive(stepId: string, live: unknown | null) { db.prepare(`UPDATE process_steps SET live_json = ? WHERE id = ?`).run(live ? JSON.stringify(live) : null, stepId); },
    /** Costo posiblemente facturado y NO confirmado (llamada abortada, caída, reinicio): se registra aparte del gasto confirmado. */
    addUnconfirmed(processId: string, stepId: string | null, usd: number) {
      if (!(usd > 0)) return;
      db.prepare(`UPDATE processes SET unconfirmed_usd = unconfirmed_usd + ? WHERE id = ?`).run(usd, processId);
      if (stepId) db.prepare(`UPDATE process_steps SET unconfirmed_usd = unconfirmed_usd + ? WHERE id = ?`).run(usd, stepId);
    },
    addUsage(id: string, tokensIn: number, tokensOut: number, cost: number) {
      db.prepare(`UPDATE processes SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, spent_usd = spent_usd + ? WHERE id = ?`).run(tokensIn, tokensOut, cost, id);
    },
    stepStart(stepId: string) { db.prepare(`UPDATE process_steps SET status = 'running', started_at = ? WHERE id = ?`).run(now(), stepId); },
    stepFinish(stepId: string, status: StepStatus, data: { tokensIn?: number; tokensOut?: number; cost?: number; outputMd?: string | null; error?: string | null }) {
      db.prepare(`UPDATE process_steps SET status = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, output_md = ?, error = ?, finished_at = ?, live_json = NULL WHERE id = ?`)
        .run(status, data.tokensIn ?? 0, data.tokensOut ?? 0, data.cost ?? 0, data.outputMd ?? null, data.error ?? null, now(), stepId);
    },
    logExecution(e: { projectId: string; agentId: string; kind: string; status: string; tokensIn: number; tokensOut: number; cost: number; startedAt: string }) {
      db.prepare(`INSERT INTO execution_history (id, project_id, agent_id, kind, status, tokens_in, tokens_out, cost_usd, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(uuid(), e.projectId, e.agentId, e.kind, e.status, e.tokensIn, e.tokensOut, e.cost, e.startedAt, now());
    }
  };
}

export function backlogRepo(slug: string) {
  const db = workspaceDb(slug);
  const map = (r: any): BacklogItem => ({ id: r.id, projectId: r.project_id, storyId: r.story_id, title: r.title, ownerKey: r.owner_key, dependsOn: r.depends_on, estimate: r.estimate, criterion: r.criterion, description: r.description, status: r.status, position: r.position, sourceProcessId: r.source_process_id, lastProcessId: r.last_process_id, createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at ?? null, archiveId: r.archive_id ?? null });
  return {
    /** Backlog activo. Las historias archivadas al iniciar una etapa siguen en la base (listAll / listArchived). */
    list(projectId: string): BacklogItem[] { return (db.prepare(`SELECT * FROM backlog_items WHERE project_id = ? AND archived_at IS NULL ORDER BY position, created_at`).all(projectId) as any[]).map(map); },
    /** Activas y archivadas: para numerar (nunca reutilizar un HU-xxx) y para no reimportar historias ya conocidas. */
    listAll(projectId: string): BacklogItem[] { return (db.prepare(`SELECT * FROM backlog_items WHERE project_id = ? ORDER BY position, created_at`).all(projectId) as any[]).map(map); },
    listArchived(projectId: string): BacklogItem[] { return (db.prepare(`SELECT * FROM backlog_items WHERE project_id = ? AND archived_at IS NOT NULL ORDER BY position, created_at`).all(projectId) as any[]).map(map); },
    get(id: string): BacklogItem | undefined { const r = db.prepare(`SELECT * FROM backlog_items WHERE id = ?`).get(id); return r ? map(r) : undefined; },
    count(projectId: string): number { return (db.prepare(`SELECT COUNT(*) AS n FROM backlog_items WHERE project_id = ? AND archived_at IS NULL`).get(projectId) as any).n; },
    nextPosition(projectId: string): number { return ((db.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM backlog_items WHERE project_id = ?`).get(projectId) as any).m as number) + 1; },
    add(i: Omit<BacklogItem, 'id' | 'createdAt' | 'updatedAt' | 'position' | 'lastProcessId' | 'status'> & { status?: BacklogStatus }): BacklogItem {
      const id = uuid(); const ts = now();
      db.prepare(`INSERT INTO backlog_items (id, project_id, story_id, title, owner_key, depends_on, estimate, criterion, description, status, position, source_process_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, i.projectId, i.storyId, i.title, i.ownerKey, i.dependsOn, i.estimate, i.criterion, i.description, i.status ?? 'pending', this.nextPosition(i.projectId), i.sourceProcessId, ts, ts);
      return this.get(id)!;
    },
    setStatus(id: string, status: BacklogStatus, lastProcessId?: string | null) {
      if (lastProcessId !== undefined) db.prepare(`UPDATE backlog_items SET status = ?, last_process_id = ?, updated_at = ? WHERE id = ?`).run(status, lastProcessId, now(), id);
      else db.prepare(`UPDATE backlog_items SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), id);
    },
    update(id: string, patch: Partial<Pick<BacklogItem, 'title' | 'criterion' | 'description' | 'ownerKey' | 'estimate' | 'dependsOn'>>) {
      const cur = this.get(id); if (!cur) return;
      const n = { ...cur, ...patch };
      db.prepare(`UPDATE backlog_items SET title = ?, criterion = ?, description = ?, owner_key = ?, estimate = ?, depends_on = ?, updated_at = ? WHERE id = ?`).run(n.title, n.criterion, n.description, n.ownerKey, n.estimate, n.dependsOn, now(), id);
    },
    setPosition(id: string, position: number) { db.prepare(`UPDATE backlog_items SET position = ?, updated_at = ? WHERE id = ?`).run(position, now(), id); },
    delete(id: string) { db.prepare(`DELETE FROM backlog_items WHERE id = ?`).run(id); }
  };
}

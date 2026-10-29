import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Prueba E (preservación): una copia SINTÉTICA de datos con el esquema anterior (v0.11: sin role/reason/lessons_used en
 * process_steps, sin template_version en agents, sin tablas lessons/agent_templates/story_*) se abre con el código actual:
 * se hace copia de seguridad antes, las migraciones son aditivas y todas las filas se conservan. Nunca se usan datos reales.
 */
test('migración 0.11 → 0.13 sobre una copia sintética: copia de seguridad previa, columnas añadidas, filas intactas', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-migra-'));
  const wsDir = path.join(dataDir, 'workspaces', 'portal-ia'); fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.master.key'), '00'.repeat(32)); // clave sintética (64 hex), no real
  const db = new DatabaseSync(path.join(wsDir, 'portal-ia.sqlite'));
  db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
  CREATE TABLE objectives (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL);
  CREATE TABLE context_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, position INTEGER NOT NULL, label TEXT NOT NULL);
  CREATE TABLE knowledge (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, author_agent_id TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, author_agent_name TEXT, process_id TEXT);
  CREATE TABLE memory (id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
  CREATE TABLE repositories (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'read-only', branch TEXT, authorized_at TEXT NOT NULL);
  CREATE TABLE agents (id TEXT PRIMARY KEY, key TEXT NOT NULL, project_id TEXT, template_id TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'inactive', config_json TEXT NOT NULL, config_edited INTEGER NOT NULL DEFAULT 0, template_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(key, project_id));
  CREATE TABLE execution_history (id TEXT PRIMARY KEY, project_id TEXT, agent_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT);
  CREATE TABLE processes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, budget_usd REAL NOT NULL DEFAULT 0, estimated_usd REAL NOT NULL DEFAULT 0, spent_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, authorized_at TEXT, started_at TEXT, finished_at TEXT, error TEXT, result_json TEXT, delegation_json TEXT, backlog_item_id TEXT);
  CREATE TABLE process_steps (id TEXT PRIMARY KEY, process_id TEXT NOT NULL, position INTEGER NOT NULL, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', model TEXT, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, output_md TEXT, error TEXT, started_at TEXT, finished_at TEXT);
  CREATE TABLE backlog_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, story_id TEXT NOT NULL, title TEXT NOT NULL, owner_key TEXT, depends_on TEXT, estimate TEXT, criterion TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', position INTEGER NOT NULL, source_process_id TEXT, last_process_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  INSERT INTO projects VALUES ('p1', 'desarrollo-del-portal', 'Desarrollo del Portal', 'x', '2026-10-01T00:00:00Z');
  INSERT INTO agents VALUES ('a1', 'pj-dev', 'p1', 'tpl.project.fullstack-dev@1', 'project', 'inactive', '{"name":"Desarrollador Full Stack","specialization":"x","responsibilities":["y"],"provider":"anthropic","model":"m","fallbacks":[],"effort":"high","tools":{"read_repo":true,"write_repo":true},"knowledge":{},"monthlyLimitUsd":1,"perTaskAuthUsd":1}', 0, '{"initials":"DF","role":"Desarrollo","reportsTo":"pj-coordinador","supervises":[],"collaborates":[],"evaluation":[],"tier":"top"}', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  INSERT INTO processes (id, project_id, kind, title, status, budget_usd, spent_usd, created_at, result_json, backlog_item_id) VALUES ('pr1', 'p1', 'story_execution', 'HU-001 · x', 'done', 1, 0.5, '2026-10-02T00:00:00Z', '{"plan":null,"implementationSummary":"s","changes":[{"path":"a.ts","action":"create","content":"x","diff":"+x","before":0,"after":1}],"verifyCommands":[],"review":null,"applied":{"branch":"portal-ia/hu-001","commit":"abc","files":["a.ts"],"appliedAt":"2026-10-02T00:00:00Z"},"verifications":[],"merged":{"into":"main","commit":"def","mergedAt":"2026-10-02T01:00:00Z"},"manualTest":{"steps":["a","b"],"checks":[true,false],"note":null}}', 'b1');
  INSERT INTO process_steps (id, process_id, position, agent_id, agent_name, title, status, model, cost_usd, output_md) VALUES ('s1', 'pr1', 0, 'c1', 'Coordinador', 'Plan', 'done', 'm', 0.1, '{}'), ('s2', 'pr1', 1, 'a1', 'Desarrollador Full Stack', 'Implementación', 'done', 'm', 0.4, '=== RESUMEN ===');
  INSERT INTO backlog_items VALUES ('b1', 'p1', 'HU-001', 'x', 'pj-dev', NULL, 'S', 'c', 'd', 'review', 1, NULL, 'pr1', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
  INSERT INTO execution_history VALUES ('e1', 'p1', 'a1', 'story_step', 'done', 10, 20, 0.4, '2026-10-02T00:00:00Z', '2026-10-02T00:01:00Z');
  INSERT INTO knowledge (id, project_id, title, body, author_agent_id, version, created_at) VALUES ('k1', 'p1', 'Doc', 'cuerpo', 'c1', 1, '2026-10-02T00:00:00Z');
  `);
  db.close();
  // Abrir con el código actual en un proceso aparte (config.ts hace la copia al cargarse) y leer con los repositorios nuevos.
  const script = `
    const { processesRepo, agentsRepo, backlogRepo, knowledgeRepo, workspaceDb } = await import('${pathToFileURL(path.resolve('src/db/workspace.ts')).href}');
    const { lessonsRepo } = await import('${pathToFileURL(path.resolve('src/services/lessons.ts')).href}');
    const { templatesRepo } = await import('${pathToFileURL(path.resolve('src/services/agentTemplates.ts')).href}');
    const { threadRepo } = await import('${pathToFileURL(path.resolve('src/services/storyThread.ts')).href}');
    const p = processesRepo('portal-ia').get('pr1'); const a = agentsRepo('portal-ia').get('a1'); const b = backlogRepo('portal-ia').get('b1');
    const cols = (t) => workspaceDb('portal-ia').prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
    console.log(JSON.stringify({ proc: { status: p.status, steps: p.steps.length, roleOfStep2: p.steps[1].role, lessonsUsed: p.steps[1].lessonsUsed, merged: p.result.merged.into, checks: p.result.manualTest.checks, spent: p.spentUsd }, agent: { caps: a.config.capabilities, tv: a.templateVersion }, backlog: b.status, knowledge: knowledgeRepo('portal-ia').list('p1').length, lessons: lessonsRepo('portal-ia').list().length, templates: templatesRepo('portal-ia').keys().length, tasks: threadRepo('portal-ia').tasks('b1').length, stepCols: cols('process_steps'), agentCols: cols('agents'), hist: workspaceDb('portal-ia').prepare('SELECT COUNT(*) AS n FROM execution_history').get().n }));
  `;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: path.resolve('.'), env: { ...process.env, PORTAL_DATA_DIR: dataDir, PORTAL_SANDBOX: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim().split('\n').pop()!;
  const r = JSON.parse(out);
  assert.equal(r.proc.status, 'done'); assert.equal(r.proc.steps, 2); assert.equal(r.proc.roleOfStep2, null); assert.deepEqual(r.proc.lessonsUsed, []); assert.equal(r.proc.merged, 'main'); assert.deepEqual(r.proc.checks, [true, false]); assert.equal(r.proc.spent, 0.5);
  assert.deepEqual(r.agent.caps, ['implementar'], 'capacidades por defecto para agentes antiguos (sin tocar la fila)'); assert.equal(r.agent.tv, null, 'sin versión de plantilla: sigue la v1 hasta opt-in');
  assert.equal(r.backlog, 'review'); assert.equal(r.knowledge, 1); assert.equal(r.lessons, 0); assert.equal(r.templates, 8); assert.equal(r.tasks, 0); assert.equal(r.hist, 1);
  for (const c of ['role', 'reason', 'lessons_used', 'backend']) assert.ok(r.stepCols.includes(c), `columna ${c}`);
  assert.ok(r.agentCols.includes('template_version'));
  // Copia de seguridad previa
  const backups = fs.readdirSync(path.join(dataDir, 'backups')); assert.equal(backups.length, 1); assert.match(backups[0], /antes-de-0\.13$/);
  assert.ok(fs.existsSync(path.join(dataDir, 'backups', backups[0], 'workspaces', 'portal-ia', 'portal-ia.sqlite')));
  assert.ok(fs.existsSync(path.join(dataDir, 'backups', backups[0], '.master.key')));
  assert.equal(fs.readFileSync(path.join(dataDir, '.schema-version'), 'utf8').trim(), '0.13');
  // La copia conserva el esquema antiguo (es una copia previa, no migrada)
  const old = new DatabaseSync(path.join(dataDir, 'backups', backups[0], 'workspaces', 'portal-ia', 'portal-ia.sqlite'));
  assert.ok(!(old.prepare('PRAGMA table_info(process_steps)').all() as any[]).some(c => c.name === 'role')); old.close();
  // Segunda apertura: no vuelve a copiar
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: path.resolve('.'), env: { ...process.env, PORTAL_DATA_DIR: dataDir, PORTAL_SANDBOX: 'none' }, stdio: 'ignore' });
  assert.equal(fs.readdirSync(path.join(dataDir, 'backups')).length, 1);
});

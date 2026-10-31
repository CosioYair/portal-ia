import type { Agent, AgentTemplateVersion, Capability, TeamRole } from '@portal-ia/domain';
import { AGENT_TEMPLATES, PROPOSED_TEMPLATES } from '@portal-ia/domain';
import { agentsRepo, workspaceDb } from '../db/workspace.ts';
import { lessonsRepo } from './lessons.ts';
import { monotonicNow } from '../clock.ts';

/**
 * Plantillas de agente versionadas (M5). Cada espacio guarda sus versiones: la v1 es la plantilla aprobada del código;
 * promover una lección validada a práctica crea la vN+1 con la práctica añadida y un diff legible. Los agentes nuevos
 * nacen con la última versión; los existentes la adoptan solo cuando el propietario lo decide (con diff y vuelta atrás).
 * Las prácticas se inyectan en el prompt como «Prácticas de la organización» y se registran en `lessons_used`
 * como `practice:<key>@<v>:<lessonId>`.
 */
const now = monotonicNow;
const ROLE_TEMPLATE: Record<TeamRole, string> = { planner: 'pj-coordinador', implementer: 'pj-dev', reviewer: 'pj-qa', consultant: 'pj-arquitecto', evaluator: 'pj-gauntlet' };
const CAP_TEMPLATE: Partial<Record<Capability, string>> = { planificar: 'pj-coordinador', implementar: 'pj-dev', revisar_calidad: 'pj-qa', generar_pruebas: 'pj-qa', consultar_arquitectura: 'pj-arquitecto', consultar_ux: 'pj-ux', revisar_seguridad: 'pj-arquitecto', consultar: 'pj-arquitecto', documentar: 'pj-arquitecto', evaluar_gauntlet: 'pj-gauntlet' };

function ensure(slug: string) {
  const db = workspaceDb(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_templates (
    key TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, responsibilities TEXT NOT NULL, practices TEXT NOT NULL DEFAULT '[]',
    diff_md TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, lesson_id TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL, PRIMARY KEY (key, version)
  ); CREATE TABLE IF NOT EXISTS agent_template_history (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, from_version TEXT, to_version TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL);`);
  // Semilla: v1 de cada plantilla aprobada (idempotente).
  const ins = db.prepare(`INSERT OR IGNORE INTO agent_templates (key, version, name, role, responsibilities, practices, diff_md, source, lesson_id, created_at, created_by) VALUES (?, 1, ?, ?, ?, '[]', '', 'seed', NULL, ?, 'portal')`);
  // Las plantillas PROPUESTAS (p. ej. Evaluador Gauntlet) entran en el catálogo versionado, pero no crean agentes.
  for (const t of [...AGENT_TEMPLATES, ...PROPOSED_TEMPLATES]) ins.run(t.key, t.name, t.role, JSON.stringify(t.responsibilities), now());
  return db;
}
const map = (r: any): AgentTemplateVersion => ({ key: r.key, version: r.version, id: `${r.key}@${r.version}`, name: r.name, role: r.role, responsibilities: JSON.parse(r.responsibilities), practices: JSON.parse(r.practices), diffMd: r.diff_md, source: r.source, lessonId: r.lesson_id, createdAt: r.created_at, createdBy: r.created_by });

export function templatesRepo(slug: string) {
  const db = ensure(slug);
  return {
    keys(): { key: string; name: string; role: string; latest: number; versions: number }[] {
      return (db.prepare(`SELECT key, MAX(version) AS latest, COUNT(*) AS versions FROM agent_templates GROUP BY key`).all() as any[]).map(r => { const v = this.get(r.key, r.latest)!; return { key: r.key, name: v.name, role: v.role, latest: r.latest, versions: r.versions }; });
    },
    versions(key: string): AgentTemplateVersion[] { return (db.prepare(`SELECT * FROM agent_templates WHERE key = ? ORDER BY version`).all(key) as any[]).map(map); },
    get(key: string, version: number): AgentTemplateVersion | undefined { const r = db.prepare(`SELECT * FROM agent_templates WHERE key = ? AND version = ?`).get(key, version); return r ? map(r) : undefined; },
    latest(key: string): AgentTemplateVersion | undefined { const r = db.prepare(`SELECT * FROM agent_templates WHERE key = ? ORDER BY version DESC LIMIT 1`).get(key); return r ? map(r) : undefined; },
    insert(v: Omit<AgentTemplateVersion, 'id' | 'createdAt'>): AgentTemplateVersion {
      db.prepare(`INSERT INTO agent_templates (key, version, name, role, responsibilities, practices, diff_md, source, lesson_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(v.key, v.version, v.name, v.role, JSON.stringify(v.responsibilities), JSON.stringify(v.practices), v.diffMd, v.source, v.lessonId, now(), v.createdBy);
      return this.get(v.key, v.version)!;
    },
    history(agentId: string): { fromVersion: string | null; toVersion: string; at: string; by: string }[] {
      return (db.prepare(`SELECT from_version AS fromVersion, to_version AS toVersion, at, by FROM agent_template_history WHERE agent_id = ? ORDER BY id`).all(agentId) as any[]);
    },
    setAgentVersion(agentId: string, from: string | null, to: string, by = 'owner') {
      db.prepare(`UPDATE agents SET template_version = ?, updated_at = ? WHERE id = ?`).run(to, now(), agentId);
      db.prepare(`INSERT INTO agent_template_history (agent_id, from_version, to_version, at, by) VALUES (?, ?, ?, ?, ?)`).run(agentId, from, to, now(), by);
    }
  };
}

export function parseVersion(v: string | null | undefined): { key: string; version: number } | null { const m = (v ?? '').match(/^(.+)@(\d+)$/); return m ? { key: m[1], version: Number(m[2]) } : null; }

/** Plantilla que sigue un agente: la suya (plantilla aprobada) o, si es personalizado, la del papel de su primera capacidad. */
export function templateKeyFor(agent: Agent): string | null {
  if ([...AGENT_TEMPLATES, ...PROPOSED_TEMPLATES].some(t => t.key === agent.key)) return agent.key;
  for (const c of agent.config.capabilities ?? []) { const k = CAP_TEMPLATE[c]; if (k) return k; }
  return null;
}

/** Versión efectiva del agente: la registrada o, si no tiene, la v1 (los agentes anteriores a M5 no adoptan nada sin opt-in). */
export function effectiveVersion(slug: string, agent: Agent): AgentTemplateVersion | null {
  const key = templateKeyFor(agent); if (!key) return null;
  const pv = parseVersion(agent.templateVersion);
  const repo = templatesRepo(slug);
  return (pv && repo.get(pv.key, pv.version)) ?? repo.get(key, 1) ?? null;
}

/** Prácticas a inyectar en el prompt de un agente (según su versión de plantilla). */
export function practicesFor(slug: string, agent: Agent): { id: string; text: string }[] {
  const v = effectiveVersion(slug, agent); if (!v) return [];
  return v.practices.map(p => ({ id: `practice:${v.id}:${p.lessonId}`, text: p.text }));
}

/** Versión más reciente para un agente nuevo (herencia automática). */
export function latestVersionIdFor(slug: string, agent: Agent): string | null {
  const key = templateKeyFor(agent); if (!key) return null;
  const v = templatesRepo(slug).latest(key); return v ? v.id : null;
}

/** Un agente recién creado hereda la última versión de su plantilla (sin opt-in: nace con ella). */
export function inheritLatestTemplate(slug: string, agent: Agent): Agent {
  const latest = latestVersionIdFor(slug, agent);
  if (!latest || latest.endsWith('@1')) return agent; // v1 = plantilla del código: no hace falta registrarla
  templatesRepo(slug).setAgentVersion(agent.id, null, latest, 'portal');
  return agentsRepo(slug).get(agent.id)!;
}

/** Promueve una lección validada a práctica de una plantilla → nueva versión con diff legible. No toca a ningún agente existente. */
export function promoteLesson(slug: string, lessonId: string, targetKey?: string | null): AgentTemplateVersion {
  const lessons = lessonsRepo(slug); const l = lessons.get(lessonId);
  if (!l) throw Object.assign(new Error('Lección no encontrada'), { statusCode: 404 });
  if (l.status !== 'validated') throw Object.assign(new Error('Solo se promueven lecciones validadas.'), { statusCode: 409 });
  if (!l.lessonText) throw Object.assign(new Error('La lección no tiene texto.'), { statusCode: 409 });
  const key = targetKey ?? (l.role ? ROLE_TEMPLATE[l.role as TeamRole] : null);
  if (!key) throw Object.assign(new Error('Indica la plantilla destino (la lección no tiene papel).'), { statusCode: 400 });
  const repo = templatesRepo(slug); const prev = repo.latest(key);
  if (!prev) throw Object.assign(new Error(`Plantilla desconocida: ${key}`), { statusCode: 404 });
  if (prev.practices.some(p => p.lessonId === lessonId)) throw Object.assign(new Error(`La práctica ya está en ${prev.id}.`), { statusCode: 409 });
  const practice = { lessonId, text: l.lessonText, title: l.title, addedAt: now() };
  const diffMd = `--- ${prev.id}\n+++ ${key}@${prev.version + 1}\n@@ Prácticas de la organización @@\n${prev.practices.map(p => `  ${p.text}`).join('\n')}${prev.practices.length ? '\n' : ''}+ ${l.lessonText}`;
  const v = repo.insert({ key, version: prev.version + 1, name: prev.name, role: prev.role, responsibilities: prev.responsibilities, practices: [...prev.practices, practice], diffMd, source: 'promotion', lessonId, createdBy: 'owner' });
  lessons.update(lessonId, { promotedTo: v.id });
  return v;
}

/** Diff legible entre la versión efectiva del agente y otra versión (para opt-in / vuelta atrás). */
export function versionDiff(slug: string, agent: Agent, toId: string): { from: string | null; to: string; added: string[]; removed: string[]; diffMd: string } {
  const to = parseVersion(toId); const repo = templatesRepo(slug);
  const tv = to ? repo.get(to.key, to.version) : undefined; if (!tv) throw Object.assign(new Error(`Versión desconocida: ${toId}`), { statusCode: 404 });
  const key = templateKeyFor(agent); if (key !== tv.key) throw Object.assign(new Error(`El agente sigue la plantilla «${key}», no «${tv.key}».`), { statusCode: 409 });
  const fv = effectiveVersion(slug, agent);
  const fromP = fv?.practices.map(p => p.text) ?? []; const toP = tv.practices.map(p => p.text);
  const added = toP.filter(t => !fromP.includes(t)); const removed = fromP.filter(t => !toP.includes(t));
  return { from: fv?.id ?? null, to: tv.id, added, removed, diffMd: `--- ${fv?.id ?? '(ninguna)'}\n+++ ${tv.id}\n@@ Prácticas de la organización @@\n${removed.map(t => `- ${t}`).join('\n')}${removed.length && added.length ? '\n' : ''}${added.map(t => `+ ${t}`).join('\n')}` };
}

/** Opt-in / vuelta atrás explícitos del propietario: solo cambia la versión que sigue el agente (y su historial). */
export function setAgentTemplateVersion(slug: string, agentId: string, toId: string): Agent {
  const agents = agentsRepo(slug); const a = agents.get(agentId); if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
  const d = versionDiff(slug, a, toId); // valida clave y versión
  templatesRepo(slug).setAgentVersion(agentId, a.templateVersion ?? d.from, toId, 'owner');
  return agents.get(agentId)!;
}

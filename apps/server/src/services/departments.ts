import crypto from 'node:crypto';
import { DEPARTMENT_PRESETS, departmentOf as labelOf, isRetired, slugify } from '@portal-ia/domain';
import type { Agent } from '@portal-ia/domain';
import { agentsRepo, workspaceDb } from '../db/workspace.ts';
import { changed } from './live.ts';
import { monotonicNow } from '../clock.ts';

/**
 * Departamentos de una empresa. La pertenencia es UNA sola: la etiqueta `template.department` del agente, la misma que ya
 * usan las evaluaciones organizativas (orgProposalApply.ts). Esta tabla solo guarda lo que la etiqueta no tiene: propósito,
 * coordinador y color. Sin etiqueta, el departamento se CALCULA (agentes de espacio → Dirección; de proyecto → Desarrollo
 * de software), así que las filas existentes no se reescriben. Una etiqueta sin fila (p. ej. de una propuesta aceptada)
 * aparece igualmente, con valores por defecto.
 */
const now = monotonicNow;
export interface Department { id: string; slug: string; name: string; purpose: string; hue: number; coordinatorAgentId: string | null; createdAt: string; archivedAt: string | null; implicit?: boolean }

/** Slug de una etiqueta: el del departamento habitual con ese nombre («Desarrollo de software» → desarrollo) o el suyo. */
const norm = (s: string) => DEPARTMENT_PRESETS.find(p => p.name.toLowerCase() === s.trim().toLowerCase())?.slug ?? slugify(s);
const DEFAULTS = { workspace: DEPARTMENT_PRESETS.find(d => d.slug === 'direccion')!, project: DEPARTMENT_PRESETS.find(d => d.slug === 'desarrollo')! };

function ensure(slug: string) {
  const db = workspaceDb(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', hue INTEGER NOT NULL DEFAULT 172,
    coordinator_agent_id TEXT, created_at TEXT NOT NULL, archived_at TEXT
  );`);
  return db;
}
const map = (r: any): Department => ({ id: r.id, slug: r.slug, name: r.name, purpose: r.purpose, hue: r.hue, coordinatorAgentId: r.coordinator_agent_id ?? null, createdAt: r.created_at, archivedAt: r.archived_at ?? null });

/** Nombre del departamento de un agente: su etiqueta o el calculado por ámbito. */
export function departmentLabelOf(a: Agent): string { return labelOf(a.template) ?? (a.scope === 'workspace' ? DEFAULTS.workspace.name : DEFAULTS.project.name); }

export function departmentsRepo(slug: string) {
  const db = ensure(slug);
  // Filas memorizadas durante la vida de este repositorio (una consulta); cada escritura las invalida.
  let memo: Department[] | null = null;
  const rows = (): Department[] => memo ??= (db.prepare(`SELECT * FROM departments ORDER BY created_at, name`).all() as any[]).map(map);
  const touched = () => { memo = null; };
  const self = {
    /** Departamentos con fila + los que solo existen como etiqueta de algún agente (o el calculado), sin duplicados. */
    list(includeArchived = false): Department[] {
      const all = rows(); const out = all.filter(d => includeArchived || !d.archivedAt);
      const known = new Set(all.map(d => d.slug));
      for (const a of agentsRepo(slug).list()) {
        const label = departmentLabelOf(a); const s = norm(label);
        if (known.has(s)) continue; known.add(s);
        const preset = DEPARTMENT_PRESETS.find(p => p.slug === s);
        out.push({ id: `dep-${s}`, slug: s, name: label, purpose: preset?.purpose ?? '', hue: preset?.hue ?? (parseInt(crypto.createHash('sha1').update(s).digest('hex').slice(0, 4), 16) % 360), coordinatorAgentId: null, createdAt: a.createdAt, archivedAt: null, implicit: true });
      }
      return out;
    },
    get(idOrSlug: string): Department | undefined { return self.list(true).find(d => d.id === idOrSlug || d.slug === idOrSlug); },
    departmentOf(a: Agent): Department {
      const label = departmentLabelOf(a); const s = norm(label);
      const row = rows().find(d => d.slug === s); if (row) return row;
      const preset = DEPARTMENT_PRESETS.find(p => p.slug === s);
      return { id: `dep-${s}`, slug: s, name: label, purpose: preset?.purpose ?? '', hue: preset?.hue ?? (parseInt(crypto.createHash('sha1').update(s).digest('hex').slice(0, 4), 16) % 360), coordinatorAgentId: null, createdAt: a.createdAt, archivedAt: null, implicit: true };
    },
    members(idOrSlug: string, opts: { includeRetired?: boolean } = {}): Agent[] {
      const d = self.get(idOrSlug); if (!d) return [];
      return agentsRepo(slug).list().filter(a => norm(departmentLabelOf(a)) === d.slug && (opts.includeRetired || !isRetired(a.template)));
    },
    /** Coordinador: el elegido; si no, el gestor/coordinador de siempre o quien planifica; si no, el primer miembro. */
    coordinatorOf(idOrSlug: string): Agent | null {
      const d = self.get(idOrSlug); const m = self.members(idOrSlug).filter(a => a.key !== 'ws-asistente');
      return (d?.coordinatorAgentId ? m.find(a => a.id === d.coordinatorAgentId) : undefined)
        ?? m.find(a => a.key === 'ws-gestor') ?? m.find(a => a.key === 'pj-coordinador') ?? m.find(a => (a.config.capabilities ?? []).includes('planificar')) ?? m[0] ?? null;
    },
    /** Da fila a un departamento (nuevo o solo-etiqueta). Idempotente por slug. */
    materialize(input: { name: string; purpose?: string; hue?: number }): Department {
      const name = input.name.trim(); if (name.length < 2 || name.length > 60) throw Object.assign(new Error('El nombre del departamento debe tener entre 2 y 60 caracteres.'), { statusCode: 400 });
      const s = norm(name);
      const existing = rows().find(d => d.slug === s); if (existing) return existing;
      const preset = DEPARTMENT_PRESETS.find(p => p.slug === s);
      const implicit = self.list(true).find(d => d.slug === s);
      db.prepare(`INSERT INTO departments (id, slug, name, purpose, hue, coordinator_agent_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`)
        .run(`dep-${s}`, s, implicit?.name ?? name, (input.purpose ?? implicit?.purpose ?? preset?.purpose ?? '').trim().slice(0, 400), Math.round(input.hue ?? implicit?.hue ?? preset?.hue ?? 200) % 360, now());
      touched(); changed({ ws: slug, entity: 'department', id: `dep-${s}` });
      return rows().find(d => d.slug === s)!;
    },
    update(idOrSlug: string, patch: { name?: string; purpose?: string; coordinatorAgentId?: string | null; hue?: number }): Department {
      const cur = self.get(idOrSlug); if (!cur) throw Object.assign(new Error('Departamento no encontrado'), { statusCode: 404 });
      const d = cur.implicit ? self.materialize({ name: cur.name }) : cur;
      if (patch.coordinatorAgentId && !self.members(d.slug).some(a => a.id === patch.coordinatorAgentId)) throw Object.assign(new Error('El coordinador debe ser un miembro del departamento.'), { statusCode: 400 });
      const name = patch.name?.trim() ?? d.name; if (name.length < 2 || name.length > 60) throw Object.assign(new Error('Nombre no válido.'), { statusCode: 400 });
      if (name !== d.name) {
        // Renombrar = cambiar la etiqueta de sus miembros (una sola fuente de pertenencia) y el slug de la fila.
        const s = norm(name); if (s !== d.slug && rows().some(x => x.slug === s)) throw Object.assign(new Error('Ya existe un departamento con ese nombre.'), { statusCode: 409 });
        const agents = agentsRepo(slug);
        for (const a of self.members(d.slug, { includeRetired: true })) agents.updateTemplateMeta(a.id, { ...a.template, department: name } as Agent['template']);
        db.prepare(`UPDATE departments SET slug = ?, name = ? WHERE id = ?`).run(s, name, d.id); touched();
      }
      db.prepare(`UPDATE departments SET purpose = ?, coordinator_agent_id = ?, hue = ? WHERE id = ?`).run((patch.purpose ?? d.purpose).trim().slice(0, 400), patch.coordinatorAgentId === undefined ? d.coordinatorAgentId : patch.coordinatorAgentId, Math.round(patch.hue ?? d.hue) % 360, d.id);
      touched(); changed({ ws: slug, entity: 'department', id: d.id });
      return rows().find(x => x.id === d.id)!;
    },
    /** Mueve un agente a un departamento: cambia SOLO su etiqueta (no su ámbito, proyecto, arnés ni permisos). */
    assign(agentId: string, idOrSlug: string) {
      const d = self.get(idOrSlug); if (!d || d.archivedAt) throw Object.assign(new Error('Departamento no encontrado'), { statusCode: 404 });
      const agents = agentsRepo(slug); const a = agents.get(agentId); if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
      agents.updateTemplateMeta(a.id, { ...a.template, department: d.name } as Agent['template']);
      db.prepare(`UPDATE departments SET coordinator_agent_id = NULL WHERE coordinator_agent_id = ? AND id <> ?`).run(agentId, d.id); touched();
      changed({ ws: slug, entity: 'agent', id: agentId });
    },
    archive(idOrSlug: string) {
      const d = self.get(idOrSlug); if (!d) throw Object.assign(new Error('Departamento no encontrado'), { statusCode: 404 });
      if (self.members(d.slug, { includeRetired: true }).length) throw Object.assign(new Error('El departamento aún tiene agentes: muévelos antes de archivarlo.'), { statusCode: 409 });
      if (!d.implicit) db.prepare(`UPDATE departments SET archived_at = ? WHERE id = ?`).run(now(), d.id); touched();
      changed({ ws: slug, entity: 'department', id: d.id });
    }
  };
  return self;
}

import { backendLabel, isRetired, type Agent, type DelegationResult, type ExecutionBackend, type PendingDecision } from '@portal-ia/domain';
import { agentsRepo, processesRepo, projectsRepo, workspaceDb } from '../db/workspace.ts';
import { agentBackend } from './claudeCode/backend.ts';
import { lastDetection } from './claudeCode/detect.ts';
import { lastCodexDetection } from './harness/codex.ts';
import { departmentsRepo, departmentLabelOf } from './departments.ts';
import { agentFoldersRepo, diskHash, folderPath } from './agentFolders.ts';
import { ensureLessonsTable, lessonsRepo } from './lessons.ts';
import { chatInFlight } from './agentChat.ts';
import fs from 'node:fs';

/**
 * La «oficina»: una vista agregada de la empresa con el estado REAL de cada agente, calculado en cada consulta a partir
 * de lo que de verdad ocurre (no de `agents.status`, que solo actualizan algunos motores):
 *  - trabajando: tiene un paso en marcha en un proceso en ejecución, o una conversación contigo en curso;
 *  - en cola: tiene pasos pendientes en un proceso en ejecución (o su llamada espera turno);
 *  - te necesita: es el responsable de algo que espera tu decisión (autorizar, aceptar, revisar), o tiene memoria propuesta
 *    o cambios externos en su carpeta sin revisar;
 *  - disponible / retirado.
 * Sin IA y sin escrituras. La interfaz la vuelve a pedir cuando llega un aviso en tiempo real (procesos, agentes…).
 */
export type OfficeState = 'working' | 'queued' | 'attention' | 'idle' | 'retired';
export interface OfficeAgent {
  id: string; key: string; name: string; role: string; initials: string; scope: 'workspace' | 'project'; projectId: string | null;
  department: string; departmentSlug: string; harness: ExecutionBackend; harnessLabel: string; model: string;
  state: OfficeState; activity: string | null; attention: { kind: string; label: string; processId?: string | null }[];
  hasFolder: boolean; custom: boolean;
}

/** Quién «lleva» un proceso: el responsable del encargo o, en una historia, quien implementa (o el primer paso). */
function leadOf(p: { kind: string; delegation?: DelegationResult | null; steps: { agentId: string; role: string | null }[] }): string | null {
  if (p.kind === 'delegated_task' && p.delegation?.leadAgentId) return p.delegation.leadAgentId;
  return p.steps.find(s => s.role === 'implementer')?.agentId ?? p.steps[0]?.agentId ?? null;
}

export function officeView(slug: string, decisions: PendingDecision[], opts: { projectId?: string | null; onlyAgentId?: string | null } = {}) {
  const agents = agentsRepo(slug).list().filter(a => (a.scope === 'workspace' || !opts.projectId || a.projectId === opts.projectId) && (!opts.onlyAgentId || a.id === opts.onlyAgentId));
  const db = ensureLessonsTable(slug);
  const deps = departmentsRepo(slug);
  // Pasos de procesos en ejecución (una consulta para toda la empresa).
  const live = db.prepare(`SELECT s.agent_id, s.status, s.title AS step, s.live_json, p.id AS pid, p.title FROM process_steps s JOIN processes p ON p.id = s.process_id
    WHERE p.status = 'running' AND s.status IN ('running', 'pending') AND p.archived_at IS NULL`).all() as any[];
  const working = new Map<string, string>(); const queued = new Map<string, string>();
  for (const r of live) {
    if (r.status === 'running') { let st = ''; try { st = JSON.parse(r.live_json ?? 'null')?.state ?? ''; } catch { /* sin estado */ }
      (st === 'queued' ? queued : working).set(r.agent_id, `${r.step} · ${r.title}`); }
    else if (!queued.has(r.agent_id)) queued.set(r.agent_id, `${r.step} · ${r.title}`);
  }
  for (const c of chatInFlight(slug)) working.set(c.agentId, 'Conversando contigo');
  // Lo que espera tu decisión, por responsable.
  const attention = new Map<string, OfficeAgent['attention']>();
  const add = (id: string | null, item: OfficeAgent['attention'][number]) => { if (!id) return; const l = attention.get(id) ?? []; l.push(item); attention.set(id, l); };
  const procs = processesRepo(slug);
  for (const d of decisions) { const p = procs.get(d.processId); if (p) add(leadOf(p as any), { kind: d.kind, label: d.title, processId: d.processId }); }
  for (const l of (db.prepare(`SELECT agent_id, COUNT(*) AS n FROM lessons WHERE agent_id IS NOT NULL AND status = 'proposed' GROUP BY agent_id`).all() as any[]))
    add(l.agent_id, { kind: 'memory', label: `${l.n} aprendizaje(s) por verificar` });
  const folders = agentFoldersRepo(slug);
  // Etiqueta del arnés con la facturación REAL detectada (sin llamar a nada): Claude Code y Codex por separado.
  const ccBilling = lastDetection()?.billing ?? null; const codexBilling = lastCodexDetection()?.billing ?? null;
  const out: OfficeAgent[] = agents.map(a => {
    const f = folders.folderOf(a.id);
    if (f?.adoptedN) {
      // Cambio externo: la carpeta en disco ya no coincide con la revisión adoptada (solo se lee si existe).
      try { const ad = folders.adopted(a.id); const h = diskHash(folderPath(slug, f.folder)); if (ad && h && h !== ad.hash) add(a.id, { kind: 'folder', label: 'Cambios en su carpeta hechos fuera del Portal: revísalos' }); } catch { /* ilegible: se ve en su pestaña */ }
    }
    const att = attention.get(a.id) ?? [];
    const retired = isRetired(a.template);
    const state: OfficeState = retired ? 'retired' : working.has(a.id) ? 'working' : att.length ? 'attention' : queued.has(a.id) ? 'queued' : 'idle';
    const harness = agentBackend(a); const dep = deps.departmentOf(a);
    return {
      id: a.id, key: a.key, name: a.config.name, role: a.template.role, initials: a.template.initials, scope: a.scope, projectId: a.projectId,
      department: departmentLabelOf(a), departmentSlug: dep?.slug ?? '', harness, harnessLabel: backendLabel(harness, harness === 'codex' ? (codexBilling as any) : harness === 'api' ? null : ccBilling, a.config.provider), model: a.config.model,
      state, activity: working.get(a.id) ?? queued.get(a.id) ?? null, attention: att, hasFolder: !!f, custom: a.templateId === 'tpl.custom@1'
    };
  });
  // Coordinador de cada sala con los miembros ya calculados (sin volver a listar agentes por departamento).
  const coordOf = (slugDep: string, explicit: string | null) => { const m = agents.filter(a => out.find(o => o.id === a.id)?.departmentSlug === slugDep && !isRetired(a.template) && a.key !== 'ws-asistente');
    return (explicit ? m.find(a => a.id === explicit) : undefined) ?? m.find(a => a.key === 'ws-gestor') ?? m.find(a => a.key === 'pj-coordinador') ?? m.find(a => (a.config.capabilities ?? []).includes('planificar')) ?? m[0] ?? null; };
  const departments = opts.onlyAgentId ? [] : deps.list().map(d => ({ ...d, coordinatorAgentId: coordOf(d.slug, d.coordinatorAgentId)?.id ?? null, members: out.filter(a => a.departmentSlug === d.slug).map(a => a.id) }));
  return {
    agents: out, departments,
    counts: { agents: out.filter(a => a.state !== 'retired').length, working: out.filter(a => a.state === 'working').length, attention: out.filter(a => a.state === 'attention').length, decisions: decisions.length },
    projects: projectsRepo(slug).list().map(p => ({ id: p.id, name: p.name }))
  };
}

/** Trabajo de un agente (tablero): encargos y pasos en los que participa, con su estado y entregable. Sin IA. */
export function agentWork(slug: string, agentId: string, limit = 40) {
  const db = workspaceDb(slug);
  const rows = db.prepare(`SELECT DISTINCT p.id, p.kind, p.title, p.status, p.created_at, p.finished_at, p.delegation_json, p.project_id FROM processes p JOIN process_steps s ON s.process_id = p.id
    WHERE s.agent_id = ? AND p.archived_at IS NULL ORDER BY p.created_at DESC LIMIT ?`).all(agentId, limit) as any[];
  return rows.map(r => {
    let d: DelegationResult | null = null; try { d = r.delegation_json ? JSON.parse(r.delegation_json) : null; } catch { /* sin delegación */ }
    const steps = db.prepare(`SELECT title, status FROM process_steps WHERE process_id = ? AND agent_id = ? ORDER BY position`).all(r.id, agentId) as any[];
    const column = r.status === 'pending_authorization' ? 'requested' : r.status === 'running' ? (steps.some(s => s.status === 'running') ? 'doing' : 'queued') : r.status === 'done' ? 'done' : 'stopped';
    return { id: r.id, kind: r.kind, title: r.title, status: r.status, column, createdAt: r.created_at, finishedAt: r.finished_at, projectId: r.project_id,
      lead: d?.leadAgentId === agentId, purpose: d?.purpose ?? null, deliverable: d?.deliverable ? d.deliverable.slice(0, 4000) : null, knowledgeDocId: d?.knowledgeDocId ?? null,
      steps: steps.map(s => ({ title: s.title, status: s.status })) };
  });
}

/** Memoria del agente: verificada (la que usa) y propuesta (pendiente de que la verifiques). */
export function agentMemory(slug: string, agentId: string) {
  const all = lessonsRepo(slug).listForAgent(agentId);
  return { verified: all.filter(l => l.status === 'validated'), proposed: all.filter(l => l.status === 'proposed' || l.status === 'detected'), retired: all.filter(l => l.status === 'rejected' || l.status === 'obsolete').slice(-20) };
}

export const activeOfficeAgents = (slug: string): Agent[] => agentsRepo(slug).list().filter(a => !isRetired(a.template));

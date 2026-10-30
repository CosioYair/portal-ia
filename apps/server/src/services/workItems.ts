import type { Assignment, BacklogItem, BacklogStatus, Process } from '@portal-ia/domain';
import { assignmentsRepo } from '../db/assignments.ts';
import { backlogRepo } from '../db/workspace.ts';

/**
 * Elemento de trabajo de un proceso de ejecución: una historia del backlog o un encargo de desarrollo del propietario.
 * El motor (worktree, Docker, QA, Gauntlet, integración) recibe SIEMPRE esta forma; así un encargo usa el mismo pipeline
 * que una historia sin crear ninguna historia. Todo acceso del motor al elemento de un proceso pasa por aquí (lo
 * comprueba work-items-coupling.test.ts).
 */
export type WorkItem = BacklogItem & { source: 'story' | 'assignment' };

export function assignmentAsItem(a: Assignment): WorkItem {
  return {
    id: a.id, projectId: a.projectId, storyId: a.code, title: a.title, ownerKey: null, dependsOn: null, estimate: a.size,
    criterion: a.criteria.map(c => `- ${c}`).join('\n'),
    description: [a.objective, a.outOfScope.length ? `Fuera de alcance: ${a.outOfScope.join('; ')}` : '', `Petición original del propietario: ${a.request}`].filter(Boolean).join('\n\n'),
    status: a.status === 'running' ? 'in_progress' : a.status === 'ready_for_review' ? 'review' : a.status === 'accepted' ? 'done' : 'pending',
    position: 0, sourceProcessId: null, lastProcessId: a.processId, createdAt: a.createdAt, updatedAt: a.updatedAt, source: 'assignment'
  };
}

/** Elemento de trabajo de un proceso: su historia del backlog o su encargo (null si no tiene o ya no existe). */
export function workItemOf(slug: string, proc: Pick<Process, 'backlogItemId'> & { assignmentId?: string | null }): WorkItem | null {
  if (proc.assignmentId) { const a = assignmentsRepo(slug).get(proc.assignmentId); return a ? assignmentAsItem(a) : null; }
  if (proc.backlogItemId) { const b = backlogRepo(slug).get(proc.backlogItemId); return b ? { ...b, source: 'story' } : null; }
  return null;
}

let syncAssignment: ((slug: string, id: string) => void) | null = null;
/** El servicio de encargos se registra aquí (evita un ciclo de importación con el motor). */
export function onAssignmentStatus(fn: (slug: string, id: string) => void) { syncAssignment = fn; }

/**
 * El motor informa del estado de su elemento. La historia cambia de estado en el backlog; el encargo deriva su estado
 * del proceso (nunca de este aviso: un «review» de un pipeline en pausa no es «listo para revisar»).
 */
export function setWorkStatus(slug: string, item: Pick<WorkItem, 'id' | 'source'>, status: BacklogStatus, processId: string | null) {
  if (item.source === 'assignment') { syncAssignment?.(slug, item.id); return; }
  backlogRepo(slug).setStatus(item.id, status, processId);
}

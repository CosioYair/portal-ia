import { ownerProcessState, type Assignment, type BacklogItem, type OwnerState, type Process } from '@portal-ia/domain';
import { backlogRepo, workspaceDb } from '../db/workspace.ts';
import { assignmentsRepo } from '../db/assignments.ts';

/**
 * Portal IA 3 · «Trabajo»: TODO lo que el propietario ha pedido, en una sola lista. Historias y encargos son lo mismo para
 * él (algo que pidió y quiere ver terminado); antes los encargos solo existían como una tarjeta dentro de una conversación
 * del Asistente y no había un sitio donde ver qué seguía abierto ni dónde continuar.
 *
 * Cada elemento lleva UN estado veraz (ownerProcessState + lo que dice el registro de la historia o del encargo) y el
 * grupo al que pertenece: te necesita, en marcha, por empezar o terminado. Solo lectura, sin IA.
 */
export type WorkSegment = 'needs_you' | 'running' | 'todo' | 'done';
export interface WorkItem {
  kind: 'story' | 'assignment';
  id: string;
  /** HU-012 o EN-004. */
  code: string;
  title: string;
  /** Lo que se pidió, en palabras del propietario cuando existen (encargo) o el criterio de aceptación (historia). */
  ask: string;
  state: Pick<OwnerState, 'key' | 'label' | 'meaning' | 'tone' | 'dot' | 'needsOwner' | 'open'>;
  segment: WorkSegment;
  processId: string | null;
  /** Conversación del Asistente donde nació (encargos). */
  conversationId: string | null;
  dependsOn: string | null;
  updatedAt: string;
}
export interface WorkView { items: WorkItem[]; counts: Record<WorkSegment, number> }

const st = (key: string, label: string, meaning: string, tone: OwnerState['tone'], needsOwner: boolean, open: boolean): WorkItem['state'] => ({ key: key as OwnerState['key'], label, meaning, tone, dot: '', needsOwner, open });
const pick = (s: OwnerState): WorkItem['state'] => ({ key: s.key, label: s.label, meaning: s.meaning, tone: s.tone, dot: s.dot, needsOwner: s.needsOwner, open: s.open });

/** Estado de una historia: el registro manda en los extremos (cerrada, descartada, sin empezar); en medio, su último proceso. */
export function storyState(item: Pick<BacklogItem, 'status'>, last: Process | undefined): WorkItem['state'] {
  if (item.status === 'done') return st('accepted', 'Aceptada y cerrada', 'La diste por buena y está cerrada.', 'ok', false, false);
  if (item.status === 'discarded') return st('discarded', 'Descartada', 'Decidiste no hacerla.', '', false, false);
  if (!last) return st('todo', 'Por empezar', 'Está en el plan y nadie la ha empezado.', '', false, true);
  const s = ownerProcessState(last);
  // Integrada pero sin cerrar: el código está en el proyecto, falta que la pruebes y la aceptes. No es «terminada».
  if (s.key === 'integrated') return st('integrated_unaccepted', 'Integrada · falta tu aceptación', 'Sus cambios ya están en el proyecto; falta que la pruebes y la aceptes para cerrarla.', 'warn', true, true);
  // Un intento descartado o cancelado no cierra la historia: sigue por hacer.
  if (s.key === 'discarded' || s.key === 'cancelled' || s.key === 'superseded') return st('todo', 'Por retomar', 'El último intento se descartó; la historia sigue pendiente.', '', false, true);
  return pick(s);
}

export function assignmentState(a: Pick<Assignment, 'status'>, last: Process | undefined): WorkItem['state'] {
  if (a.status === 'accepted') return st('accepted', 'Aceptado y cerrado', 'Lo diste por bueno y está cerrado.', 'ok', false, false);
  if (a.status === 'cancelled') return st('cancelled', 'Cancelado', 'Lo cancelaste.', '', false, false);
  if (a.status === 'draft') return st('needs_authorization', 'Borrador · sin autorizar', 'Está definido y no gasta nada hasta que lo autorices.', 'warn', true, true);
  if (!last) return a.status === 'failed' ? st('failed', 'No terminó', 'Se interrumpió antes de entregar nada.', 'err', true, true) : st('needs_authorization', 'Espera tu autorización', 'Está preparado y no gasta nada hasta que lo autorices.', 'warn', true, true);
  const s = ownerProcessState(last);
  if (s.key === 'integrated') return st('integrated_unaccepted', 'Integrado · falta tu aceptación', 'Sus cambios ya están en el proyecto; falta que lo pruebes y lo aceptes para cerrarlo.', 'warn', true, true);
  if (a.status === 'changes_requested' && (s.key === 'discarded' || s.key === 'superseded')) return st('needs_authorization', 'Cambios pedidos · espera tu autorización', 'Pediste cambios; el siguiente intento espera tu autorización.', 'warn', true, true);
  if (s.key === 'discarded' || s.key === 'cancelled' || s.key === 'superseded') return a.status === 'failed' ? st('failed', 'No terminó', 'El último intento no entregó nada utilizable.', 'err', true, true) : st('todo', 'Por retomar', 'El último intento se descartó; el encargo sigue abierto.', '', true, true);
  return pick(s);
}

const segmentOf = (s: WorkItem['state']): WorkSegment => !s.open ? 'done' : s.key === 'working' || s.key === 'queued' ? 'running' : s.needsOwner ? 'needs_you' : 'todo';
const ORDER: Record<WorkSegment, number> = { needs_you: 0, running: 1, todo: 2, done: 3 };

/**
 * Estado del ultimo intento de un elemento con una PROYECCION ligera (Gauntlet M3/M4): solo los campos que decide el
 * estado, extraidos en SQLite. Antes se cargaba cada proceso entero (resultado de 0,5-1,5 MB y todos sus pasos) y se
 * miraba last_process_id, que no apunta al intento recien preparado y pendiente de autorizar.
 */
type Lite = Parameters<typeof ownerProcessState>[0] & { id: string; at: string };
const PROJ = `SELECT id, status, created_at, finished_at, superseded_by,
  json_extract(result_json, '$.pipeline.state') AS pl_state, json_extract(result_json, '$.pipeline.pauseKind') AS pl_kind,
  json_type(result_json, '$.merged') AS merged, json_type(result_json, '$.rejected') AS rejected, json_type(result_json, '$.applied') AS applied,
  EXISTS (SELECT 1 FROM process_steps s WHERE s.process_id = processes.id AND s.status = 'running' AND s.live_json LIKE '%"state":"queued"%') AS queued
  FROM processes`;
function lite(r: any): Lite | undefined {
  if (!r) return undefined;
  const obj = (t: unknown) => (t === 'object' ? ({} as any) : null);
  return {
    id: r.id, at: r.finished_at ?? r.created_at, status: r.status, supersededBy: r.superseded_by ?? null,
    steps: r.queued ? ([{ status: 'running', live: { state: 'queued' } }] as any) : [],
    result: { merged: obj(r.merged), rejected: obj(r.rejected), applied: obj(r.applied), pipeline: r.pl_state ? { state: r.pl_state, pauseKind: r.pl_kind ?? null } : undefined } as any
  };
}

export function workView(slug: string, projectId: string): WorkView {
  const db = workspaceDb(slug);
  const latestOfStory = db.prepare(`${PROJ} WHERE backlog_item_id = ? AND archived_at IS NULL AND superseded_by IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`);
  const byId = db.prepare(`${PROJ} WHERE id = ?`);
  const items: WorkItem[] = [];
  for (const b of backlogRepo(slug).list(projectId)) {
    // Cerrada o descartada: lo dice el registro; no hace falta mirar ningun proceso.
    const closed = b.status === 'done' || b.status === 'discarded';
    const last = closed ? undefined : lite(latestOfStory.get(b.id));
    const state = storyState(b, last as Process | undefined);
    items.push({ kind: 'story', id: b.id, code: b.storyId, title: b.title, ask: b.criterion || b.description || '', state, segment: segmentOf(state), processId: last?.id ?? b.lastProcessId ?? null, conversationId: null, dependsOn: b.dependsOn, updatedAt: last?.at ?? b.updatedAt });
  }
  for (const a of assignmentsRepo(slug).list(projectId)) {
    const closed = a.status === 'accepted' || a.status === 'cancelled' || a.status === 'draft';
    const last = closed || !a.processId ? undefined : lite(byId.get(a.processId));
    const state = assignmentState(a, last as Process | undefined);
    items.push({ kind: 'assignment', id: a.id, code: a.code, title: a.title, ask: a.request || a.objective || '', state, segment: segmentOf(state), processId: last?.id ?? a.processId ?? null, conversationId: a.conversationId ?? null, dependsOn: null, updatedAt: a.updatedAt });
  }
  items.sort((x, y) => ORDER[x.segment] - ORDER[y.segment] || (x.segment === 'todo' ? 0 : y.updatedAt.localeCompare(x.updatedAt)));
  const counts: Record<WorkSegment, number> = { needs_you: 0, running: 0, todo: 0, done: 0 };
  for (const i of items) counts[i.segment]++;
  return { items, counts };
}

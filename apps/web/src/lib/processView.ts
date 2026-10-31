import type { Process } from '@portal-ia/domain';

/**
 * HU-167 · Funciones puras de la vista de procesos (sin IO, sin React ni DOM): se pueden importar desde las pruebas de Node.
 */
export interface ProcStatusLabel { label: string; tone: '' | 'ok' | 'warn' | 'err'; dot: '' | 'ok' | 'pulse' | 'err' }

export const P_LABEL: Record<Process['status'], ProcStatusLabel> = {
  pending_authorization: { label: 'Pendiente de autorización', tone: 'warn', dot: '' },
  running: { label: 'En ejecución', tone: 'warn', dot: 'pulse' },
  done: { label: 'Completado', tone: 'ok', dot: 'ok' },
  failed: { label: 'Con errores', tone: 'err', dot: 'err' },
  cancelled: { label: 'Cancelado', tone: '', dot: '' },
  budget_exceeded: { label: 'Presupuesto agotado', tone: 'err', dot: 'err' }
};

/**
 * Estado que ve el propietario: un proceso «terminado» cuyo pipeline está pausado o detenido NO está completado
 * (HU-159 figuraba «Completado» mientras esperaba una autorización). Pausado = espera tu decisión; detenido = se paró.
 */
export function procLabel(p: Process): ProcStatusLabel {
  const pl = p.result?.pipeline;
  // En marcha pero esperando turno (máximo de ejecuciones de Claude Code a la vez): en cola, no bloqueado ni trabajando.
  if (p.status === 'running' && p.steps.some(s => s.status === 'running' && s.live?.state === 'queued')) return { label: 'En cola · espera un hueco', tone: '', dot: 'pulse' };
  // Integrada en main: una pausa anterior (p. ej. el candidato antes de integrar) ya no es su estado.
  if (p.status === 'done' && p.result?.merged) return { label: 'Integrada en main', tone: 'ok', dot: '' };
  if (p.status === 'done' && pl?.state === 'paused') return { label: 'Pausado · espera tu decisión', tone: 'warn', dot: '' };
  if (p.status === 'done' && pl?.state === 'stopped' && pl.pauseKind && pl.pauseKind !== 'no_changes') return { label: 'Detenido · decides tú', tone: 'warn', dot: '' };
  return P_LABEL[p.status];
}

export type ProcessFilterKey = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export const PROCESS_FILTERS: { key: 'all' | ProcessFilterKey; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'running', label: 'En curso' },
  { key: 'waiting', label: 'Esperan tu decisión' },
  { key: 'done', label: 'Completados' },
  { key: 'failed', label: 'Con errores' },
  { key: 'cancelled', label: 'Cancelados' }
];

/** Grupo del filtro de Actividad. «waiting» agrupa lo pendiente de autorización y los pipelines pausados o detenidos (igual que procLabel). */
export function processFilterKey(p: Process): ProcessFilterKey {
  if (p.status === 'running') return 'running';
  if (p.status === 'pending_authorization') return 'waiting';
  if (p.status === 'failed' || p.status === 'budget_exceeded') return 'failed';
  if (p.status === 'cancelled') return 'cancelled';
  const pl = p.result?.pipeline;
  if (p.result?.merged) return 'done';
  if (pl?.state === 'paused') return 'waiting';
  if (pl?.state === 'stopped' && pl.pauseKind && pl.pauseKind !== 'no_changes') return 'waiting';
  return 'done';
}

export type NextStepTarget = { kind: 'anchor'; id: string } | { kind: 'link'; to: string };

/**
 * Adónde lleva el botón del siguiente paso. Solo apunta a secciones que ProcessView pinta en ese estado y nunca
 * lanza acciones: autorizar, reintentar o recuperar siguen exigiendo el clic del propietario en su sección.
 * null = sin botón (sin guidance o proceso archivado: es histórico y no admite acciones).
 */
export function nextStepTarget(p: Process): NextStepTarget | null {
  if (!p.guidance || p.archivedAt) return null;
  if (p.status === 'pending_authorization') return { kind: 'anchor', id: 'sec-authorize' };
  // Con flow, el bloque de recuperación no se pinta: el estado de la historia va antes.
  if (p.kind === 'story_execution' && p.guidance.flow) return { kind: 'anchor', id: 'sec-flow' };
  if (p.kind === 'story_execution' && (p.status === 'failed' || p.status === 'cancelled' || p.status === 'budget_exceeded')) return { kind: 'anchor', id: 'sec-recovery' };
  if (p.kind === 'story_execution' && p.result && (p.status === 'done' || p.result.changes.length > 0)) return { kind: 'anchor', id: 'sec-result' };
  if (p.steps.length === 0 && p.kind === 'story_execution' && p.backlogItemId) return { kind: 'link', to: `/historias/${p.backlogItemId}` };
  return { kind: 'anchor', id: 'sec-steps' };
}

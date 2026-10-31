/**
 * Encargo de desarrollo del propietario («Owner Assignment»): trabajo de código pedido directamente (p. ej. desde el
 * Asistente) que NO es una historia del backlog. Usa el MISMO motor que las historias (worktree aislado, Docker, QA,
 * Gauntlet, integración manual): su proceso `story_execution` lleva `assignmentId` en lugar de `backlogItemId`.
 * No confundir con el «encargo» de análisis (`delegated_task`), que entrega un documento.
 */

export type AssignmentStatus =
  /** Definido (petición, objetivo, criterios), sin proceso preparado. */
  | 'draft'
  /** Proceso preparado: espera la autorización explícita del propietario (presupuesto, orígenes, Gauntlet). */
  | 'pending_authorization'
  | 'running'
  /** El pipeline se detuvo y decide el propietario (motivo en el proceso). */
  | 'needs_owner'
  /** Terminado técnicamente (verificado, QA y Gauntlet según la evaluación): falta la revisión del propietario. */
  | 'ready_for_review'
  | 'accepted'
  /** El propietario pidió cambios: se prepara otra iteración con su nota. */
  | 'changes_requested'
  | 'cancelled'
  | 'failed';

export interface AssignmentEvent { at: string; kind: 'created' | 'prepared' | 'authorized' | 'status' | 'review' | 'accepted' | 'changes' | 'cancelled' | 'knowledge'; message: string; processId?: string | null }

export interface AssignmentOutcome {
  /** Resumen técnico y para el propietario (del proceso), sin inventar: lo que el pipeline dejó registrado. */
  summary: string | null;
  userFacing: string | null;
  branch: string | null;
  commit: string | null;
  worktree: string | null;
  /** Últimas verificaciones del commit aplicado (comando y código de salida). */
  verifications: { command: string; exitCode: number | null; isolation: string | null }[];
  qa: string | null;
  gauntlet: { mode: string; status: string; rounds: number; openFindings: number } | null;
  /** Agentes que trabajaron (nombre y papel). */
  agents: { name: string; role: string }[];
  /** Llamadas y gasto confirmados del proceso (la suscripción no se cobra por llamada). */
  calls: number;
  spentUsd: number;
  recordedAt: string;
}

export interface Assignment {
  id: string;
  /** EN-001, EN-002… por espacio. */
  code: string;
  projectId: string;
  owner: string;
  /** Petición original, tal como la escribió el propietario. */
  request: string;
  title: string;
  /** Objetivo aclarado. */
  objective: string;
  /** Criterios de aceptación comprobables (sin ellos no se prepara la ejecución). */
  criteria: string[];
  outOfScope: string[];
  size: 'S' | 'M' | 'L' | null;
  status: AssignmentStatus;
  reason: string | null;
  /** Origen: conversación y mensaje del Asistente (si lo creó desde el chat). */
  conversationId: string | null;
  messageId: string | null;
  processId: string | null;
  processIds: string[];
  /** Nota del propietario para la siguiente iteración (al pedir cambios). */
  iterationNote: string | null;
  outcome: AssignmentOutcome | null;
  knowledgeDocId: string | null;
  events: AssignmentEvent[];
  createdAt: string;
  updatedAt: string;
}

export const ASSIGNMENT_STATUS_LABEL: Record<AssignmentStatus, string> = {
  draft: 'borrador', pending_authorization: 'pendiente de tu autorización', running: 'en marcha', needs_owner: 'espera tu decisión',
  ready_for_review: 'listo para tu revisión', accepted: 'aceptado', changes_requested: 'cambios pedidos', cancelled: 'cancelado', failed: 'fallido'
};

/** Estados que ya no avanzan sin el propietario. */
export const ASSIGNMENT_OPEN: AssignmentStatus[] = ['draft', 'pending_authorization', 'running', 'needs_owner', 'ready_for_review', 'changes_requested'];

/** Criterios mínimos para preparar la ejecución: objetivo y al menos un criterio comprobable. */
export function assignmentReady(a: Pick<Assignment, 'objective' | 'criteria'>): string | null {
  if (a.objective.trim().length < 10) return 'Falta el objetivo del encargo.';
  if (!a.criteria.some(c => c.trim().length >= 5)) return 'Falta al menos un criterio de aceptación comprobable.';
  return null;
}

/**
 * Mantenimiento gobernado de un proyecto: revisión del repositorio (ramas locales y del remoto, worktrees) y del backlog
 * frente a «main», con un plan de acciones que el propietario revisa y autoriza OBJETIVO A OBJETIVO.
 *
 * - La revisión es de solo lectura (no pide autorización).
 * - Cada objetivo dice qué es, por qué está en su grupo, qué pasará, qué consecuencias tiene y cómo recuperarlo.
 * - Nada se ejecuta sin una selección explícita; justo antes de ejecutar se comprueba de nuevo el estado real y lo que
 *   haya cambiado desde la propuesta no se toca.
 */
export type MaintenanceKind = 'remote_branch' | 'local_branch' | 'worktree' | 'story' | 'batch';
/** safe: ya integrado, se puede cerrar o borrar sin perder nada · decision: requiere tu decisión · protected: no se toca · outside: fuera del alcance del Portal. */
export type MaintenanceCategory = 'safe' | 'decision' | 'protected' | 'outside';
export type MaintenanceOptionId =
  | 'keep' | 'delete_remote' | 'archive_delete_remote' | 'delete_local' | 'archive_delete_local' | 'remove_worktree'
  | 'accept' | 'close_done' | 'discard' | 'close_batch';

export interface MaintenanceOption {
  id: MaintenanceOptionId;
  label: string;
  /** Qué ocurre exactamente si se elige. */
  effect: string;
  /** Quita algo (rama, worktree) o cierra trabajo: se pide confirmación explícita. */
  destructive: boolean;
  /** Exige un motivo (se guarda en el historial). */
  needsReason?: boolean;
}

export interface MaintenanceItem {
  id: string;
  kind: MaintenanceKind;
  /** Nombre visible: rama, carpeta del worktree, «HU-170 · título», lote. */
  name: string;
  category: MaintenanceCategory;
  /** Estado en lenguaje claro («Ya integrada en main», «Contiene cambios que no están en main»…). */
  status: string;
  /** Por qué está en este grupo. */
  reason: string;
  story?: { id: string; storyId: string; title: string; status: string } | null;
  processId?: string | null;
  batchId?: string | null;
  sha?: string | null;
  /** Commits que la rama tiene y main no (0 = todo está en main). */
  unique?: number | null;
  /** Primeros commits propios (para decidir sin abrir git). */
  uniqueCommits?: string[];
  worktree?: string | null;
  options: MaintenanceOption[];
  /** Opción preseleccionada (en lo seguro, la acción; en lo que requiere decisión, conservar). */
  defaultOption: MaintenanceOptionId;
  consequences: string;
  recovery: string | null;
  /** Otro objetivo que debe ejecutarse antes (p. ej. retirar el worktree antes de borrar su rama). */
  requires?: string | null;
  /** Estado exacto con el que se propuso: ejecutar exige que siga igual. */
  fingerprint: string;
}

export interface MaintenanceSelection { itemId: string; option: MaintenanceOptionId; reason?: string | null }
/** done: hecho · noop: ya estaba como se quería (nada que hacer) · skipped: no se tocó (cambió o está protegido) · failed: error · started: en curso (si queda así, se interrumpió). */
export interface MaintenanceOutcome { itemId: string; option: MaintenanceOptionId; status: 'done' | 'noop' | 'failed' | 'skipped' | 'started'; message: string; recovery?: string | null; archiveRef?: string | null; at: string }
export interface MaintenanceRun { startedAt: string; finishedAt: string | null; selection: MaintenanceSelection[]; outcomes: MaintenanceOutcome[]; verification: string[]; interrupted?: boolean; runner?: string }

export type MaintenancePlanStatus = 'proposed' | 'running' | 'done' | 'partial' | 'rejected' | 'stale';

export interface MaintenancePlan {
  id: string;
  workspace: string;
  projectId: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  status: MaintenancePlanStatus;
  repo: { path: string; mainBranch: string | null; mainSha: string | null; remote: string | null; remoteUrl: string | null; remoteAvailable: boolean; remoteError: string | null };
  counts: { remoteBranches: number; localBranches: number; worktrees: number; openStories: number; openBatches: number };
  items: MaintenanceItem[];
  /** Conversación del Asistente que lo propuso (para mostrar allí el resultado). */
  source: { messageId: string; operationId: string; conversationId?: string | null } | null;
  /** «Revisar de nuevo» tras una ejecución parcial: lo que ya hizo la revisión anterior (la tarjeta cuenta ambas). */
  continuesFrom?: { planId: string; done: number } | null;
  /** Ejecución actual o última (la selección incluye lo que se dejó en «Conservar»). */
  execution: MaintenanceRun | null;
  /** Ejecuciones anteriores de esta misma revisión (reanudaciones): nada se pierde del historial. */
  history?: MaintenanceRun[];
  /** Revisión más reciente que la sustituyó (esta ya no se ejecuta). */
  supersededBy?: string | null;
}

export const MAINTENANCE_CATEGORY_LABEL: Record<MaintenanceCategory, string> = {
  safe: 'Ya integrado — seguro', decision: 'Requiere tu decisión', protected: 'Protegido — no se toca', outside: 'Fuera del alcance del Portal'
};

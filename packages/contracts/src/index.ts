// Contratos compartidos entre servidor y web. Solo puede depender de @portal/domain (y de zod).

import type { CompanyId } from '@portal/domain';
import { API_ERROR_STEPS } from './common.ts';

export * from './common.ts';
export * from './company.ts';
export * from './agent.ts';
export * from './process.ts';
export * from './request.ts';
export * from './authorization.ts';
export * from './usage.ts';
export * from './activity.ts';
export * from './story-closure.ts';
export * from './portal-sync.ts';

/** Referencia mínima a una empresa en las respuestas de la API. */
export interface CompanyRef {
  readonly id: CompanyId;
  readonly name: string;
}

export type ApiErrorStep = (typeof API_ERROR_STEPS)[number];

/**
 * Error estructurado que devuelve la API y que la interfaz muestra al usuario.
 * El mensaje va en español y nunca debe incluir stack traces ni secretos.
 */
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly step: ApiErrorStep;
  /** Extracto saneado y truncado de la causa (por ejemplo, la salida de error del proceso). */
  readonly detail?: string;
}

/** Estados de una ejecución del backlog visibles en la interfaz. */
export const BACKLOG_RUN_STATES = ['iniciando', 'ejecutando', 'completado', 'fallido'] as const;

export type BacklogRunState = (typeof BACKLOG_RUN_STATES)[number];

/** Estado de una ejecución del backlog, consultable por runId. */
export interface BacklogRunStatus {
  readonly runId: string;
  readonly state: BacklogRunState;
  readonly error?: ApiError;
}

/** Indica si el estado de una ejecución es final (no hace falta seguir consultándolo). */
export function isFinalRunState(state: BacklogRunState): boolean {
  return state === 'completado' || state === 'fallido';
}

/** Guarda de tipo para validar en runtime que un valor desconocido tiene la forma de ApiError. */
export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const stepValido =
    typeof candidate['step'] === 'string' &&
    (API_ERROR_STEPS as readonly string[]).includes(candidate['step']);
  const detailValido = candidate['detail'] === undefined || typeof candidate['detail'] === 'string';
  return (
    typeof candidate['code'] === 'string' &&
    typeof candidate['message'] === 'string' &&
    stepValido &&
    detailValido
  );
}

// Regla pura de cierre de historias. Sin IO: recibe hechos ya obtenidos y decide.

export const STORY_WORK_STATES = ['sin_empezar', 'en_curso', 'hecha'] as const;

/** Estado de trabajo de una historia (independiente de que esté cerrada). */
export type StoryWorkState = (typeof STORY_WORK_STATES)[number];

/** Indicador visible en el backlog. */
export type StoryProgressIndicator = 'pendiente' | 'en_curso' | 'por_cerrar';

export interface StoryClosureFacts {
  /** El proyecto tiene un repositorio registrado. */
  readonly hasRepository: boolean;
  readonly workState: StoryWorkState;
  /** Los cambios están aplicados en local (relevante sin repositorio). */
  readonly appliedLocally: boolean;
  /** Los cambios están integrados en la rama principal (relevante con repositorio). */
  readonly mergedIntoMain: boolean;
  /** La rama principal está publicada en el remoto (relevante con repositorio). */
  readonly pushedToRemote: boolean;
  /** La historia ya fue marcada como completada. */
  readonly completed: boolean;
}

export interface StoryClosureEvaluation {
  readonly canClose: boolean;
  /** Motivo del bloqueo en español (null si se puede cerrar). */
  readonly reason: string | null;
  /** Null si la historia ya está completada. */
  readonly indicator: StoryProgressIndicator | null;
}

export const CLOSURE_REASONS = {
  yaCompletada: 'La historia ya está completada',
  noIntegrada: 'Los cambios no están integrados en la rama principal',
  noPublicada: 'La rama principal no está publicada en el remoto',
  noAplicadaLocal: 'Los cambios no están aplicados en local'
} as const;

function blockReason(facts: StoryClosureFacts): string | null {
  if (facts.completed) return CLOSURE_REASONS.yaCompletada;
  if (facts.hasRepository) {
    if (!facts.mergedIntoMain) return CLOSURE_REASONS.noIntegrada;
    if (!facts.pushedToRemote) return CLOSURE_REASONS.noPublicada;
    return null;
  }
  return facts.appliedLocally ? null : CLOSURE_REASONS.noAplicadaLocal;
}

function progressIndicator(facts: StoryClosureFacts): StoryProgressIndicator | null {
  if (facts.completed) return null;
  switch (facts.workState) {
    case 'sin_empezar':
      return 'pendiente';
    case 'en_curso':
      return 'en_curso';
    case 'hecha':
      // Hecha pero aún no cerrada: falta integrar, publicar o pulsar el cierre.
      return 'por_cerrar';
  }
}

/**
 * Decide si una historia puede cerrarse y qué indicador mostrar.
 * - Con repositorio: exige integración en la rama principal y publicación en el remoto.
 * - Sin repositorio: basta con que los cambios estén aplicados en local.
 */
export function evaluateStoryClosure(facts: StoryClosureFacts): StoryClosureEvaluation {
  const reason = blockReason(facts);
  return { canClose: reason === null, reason, indicator: progressIndicator(facts) };
}

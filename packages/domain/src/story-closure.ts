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
  noAplicadaLocal: 'Los cambios no están aplicados en local',
  sinVistoBueno: 'Falta el visto bueno del propietario tras la prueba manual'
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

// ---------------------------------------------------------------------------
// Ciclo de una historia con rama propia (HU-125):
// rama creada → prueba manual pendiente → visto bueno → integrada en main → publicada → cerrada.
// ---------------------------------------------------------------------------

export const STORY_LIFECYCLE_STAGES = [
  'rama_creada',
  'prueba_manual_pendiente',
  'visto_bueno',
  'integrada_en_main',
  'publicada',
  'cerrada'
] as const;

export type StoryLifecycleStage = (typeof STORY_LIFECYCLE_STAGES)[number];

export interface StoryLifecycleFacts {
  /** Existe la rama de la historia, creada desde main actualizado. */
  readonly branchCreated: boolean;
  /** Se ha pedido al propietario que pruebe la rama reiniciando el servidor local. */
  readonly manualTestRequested: boolean;
  /** El propietario ha dado su visto bueno tras la prueba manual. */
  readonly ownerApproved: boolean;
  /** Los cambios están integrados en main. */
  readonly mergedIntoMain: boolean;
  /** main está publicada en el remoto. */
  readonly pushedToRemote: boolean;
  /** La historia ya fue marcada como completada. */
  readonly completed: boolean;
}

export interface StoryLifecycleEvaluation {
  /** Etapa más avanzada alcanzada de forma consecutiva (null si aún no hay rama). */
  readonly stage: StoryLifecycleStage | null;
  readonly canClose: boolean;
  /** Motivo del bloqueo en español (null si se puede cerrar). */
  readonly reason: string | null;
  /** Instrucción para el propietario; solo presente cuando el cierre es válido. */
  readonly nextStepNotice: string | null;
}

/** Texto mostrado al propietario al cerrar una historia. */
export const CLOSE_NEXT_STEP_NOTICE =
  'Cambia a main y actualízalo localmente (git checkout main && git pull) antes de empezar la siguiente historia.';

function lifecycleStage(facts: StoryLifecycleFacts): StoryLifecycleStage | null {
  if (facts.completed) return 'cerrada';
  const reached = [
    facts.branchCreated,
    facts.manualTestRequested,
    facts.ownerApproved,
    facts.mergedIntoMain,
    facts.pushedToRemote
  ];
  let count = 0;
  while (count < reached.length && reached[count] === true) count += 1;
  return count === 0 ? null : (STORY_LIFECYCLE_STAGES[count - 1] ?? null);
}

function lifecycleBlockReason(facts: StoryLifecycleFacts): string | null {
  if (facts.completed) return CLOSURE_REASONS.yaCompletada;
  if (!facts.ownerApproved) return CLOSURE_REASONS.sinVistoBueno;
  if (!facts.mergedIntoMain) return CLOSURE_REASONS.noIntegrada;
  if (!facts.pushedToRemote) return CLOSURE_REASONS.noPublicada;
  return null;
}

/**
 * Evalúa el ciclo de una historia con rama propia. Aplica la regla HU-120:
 * no se cierra sin visto bueno, integración en main y publicación.
 * Si el cierre es válido, devuelve la instrucción de volver a main actualizado.
 */
export function evaluateStoryLifecycle(facts: StoryLifecycleFacts): StoryLifecycleEvaluation {
  const reason = lifecycleBlockReason(facts);
  return {
    stage: lifecycleStage(facts),
    canClose: reason === null,
    reason,
    nextStepNotice: reason === null ? CLOSE_NEXT_STEP_NOTICE : null
  };
}

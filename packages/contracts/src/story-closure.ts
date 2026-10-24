// Contratos del cierre de historias: indicador de progreso y estado de cierre.

import { z } from 'zod';
import { EntityIdSchema } from './common.ts';

/** Indicador de progreso de una historia en el backlog. */
export const STORY_PROGRESS_INDICATORS = ['pendiente', 'en_curso', 'por_cerrar'] as const;

export const StoryProgressIndicatorSchema = z.enum(STORY_PROGRESS_INDICATORS);

/** Parámetros de ruta de las acciones sobre una historia. */
export const StoryRouteParamsSchema = z.object({ id: EntityIdSchema }).strict();

/**
 * Estado de cierre de una historia.
 * - canClose: si «Marcar historia como completada» está permitido.
 * - reason: motivo del bloqueo (null si se puede cerrar).
 * - indicator: Pendiente, En curso o Por cerrar (null si la historia ya está completada).
 */
export const StoryClosureStatusSchema = z
  .object({
    canClose: z.boolean(),
    reason: z.string().min(1).nullable(),
    indicator: StoryProgressIndicatorSchema.nullable(),
    hasRepository: z.boolean()
  })
  .strict()
  .refine((status) => status.canClose === (status.reason === null), {
    message: 'reason debe ser null si y solo si canClose es true'
  });

export type StoryProgressIndicator = z.infer<typeof StoryProgressIndicatorSchema>;
export type StoryRouteParams = z.infer<typeof StoryRouteParamsSchema>;
export type StoryClosureStatus = z.infer<typeof StoryClosureStatusSchema>;

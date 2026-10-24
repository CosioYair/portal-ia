// Contratos de la verificación de ubicación en ejecución del Portal (carpeta y rama).

import { z } from 'zod';
import {
  PREFLIGHT_CHECK_IDS,
  PREFLIGHT_CHECK_STATES,
  RUNTIME_LOCATION_STATES
} from '@portal/domain';
import { EntityIdSchema, IsoDateTimeSchema } from './common.ts';

const RutaSchema = z.string().min(1).max(1000);
const RamaSchema = z.string().min(1).max(255);

/** Parámetros de ruta de GET /api/projects/:projectId/runtime-location. */
export const RuntimeLocationParamsSchema = z.object({ projectId: EntityIdSchema }).strict();

export const RuntimeLocationStoryStatusSchema = z
  .object({
    id: z.string().min(1).max(100),
    titulo: z.string().max(300),
    /** SHA del commit de cierre; null si no se registró. */
    sha: z.string().min(7).max(64).nullable(),
    /** true/false si se comprobó; null = desconocido. */
    contenida: z.boolean().nullable()
  })
  .strict();

/** Resultado de comparar el Portal en ejecución con el repositorio registrado del proyecto. */
export const RuntimeLocationCheckSchema = z
  .object({
    estado: z.enum(RUNTIME_LOCATION_STATES),
    ejecucion: z
      .object({
        ruta: RutaSchema.nullable(),
        rama: RamaSchema.nullable(),
        headDesacoplado: z.boolean()
      })
      .strict(),
    registrado: z.object({ ruta: RutaSchema.nullable(), rama: RamaSchema.nullable() }).strict(),
    historiasCompletadas: z.array(RuntimeLocationStoryStatusSchema).max(500),
    pasos: z.array(z.string().min(1).max(2000)).max(20),
    motivoNoVerificable: z.string().min(1).max(500).optional(),
    verificadoEn: IsoDateTimeSchema
  })
  .strict();

/** Una comprobación individual del preflight de ejecución. */
export const ExecutionPreflightCheckSchema = z
  .object({
    id: z.enum(PREFLIGHT_CHECK_IDS),
    estado: z.enum(PREFLIGHT_CHECK_STATES),
    detalle: z.string().min(1).max(1000)
  })
  .strict();

/**
 * Resultado de la comprobación previa a toda ejecución (HU-129): el Portal corre desde main
 * actualizado y la rama por defecto del remoto es main. Si ok es false, la ejecución se detiene.
 */
export const ExecutionPreflightResultSchema = z
  .object({
    ok: z.boolean(),
    checks: z.array(ExecutionPreflightCheckSchema).min(1).max(10),
    /** Motivo en español del bloqueo; null cuando ok es true. */
    motivo: z.string().min(1).max(2000).nullable()
  })
  .strict();

export type RuntimeLocationParams = z.infer<typeof RuntimeLocationParamsSchema>;
export type RuntimeLocationStoryStatus = z.infer<typeof RuntimeLocationStoryStatusSchema>;
export type RuntimeLocationCheck = z.infer<typeof RuntimeLocationCheckSchema>;
export type ExecutionPreflightCheck = z.infer<typeof ExecutionPreflightCheckSchema>;
export type ExecutionPreflightResult = z.infer<typeof ExecutionPreflightResultSchema>;

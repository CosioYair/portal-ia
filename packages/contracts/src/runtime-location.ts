// Contratos de la verificación de ubicación en ejecución del Portal (carpeta y rama).

import { z } from 'zod';
import { RUNTIME_LOCATION_STATES } from '@portal/domain';
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

export type RuntimeLocationParams = z.infer<typeof RuntimeLocationParamsSchema>;
export type RuntimeLocationStoryStatus = z.infer<typeof RuntimeLocationStoryStatusSchema>;
export type RuntimeLocationCheck = z.infer<typeof RuntimeLocationCheckSchema>;

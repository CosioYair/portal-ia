// Contrato del registro de actividad. Por ahora solo registra la publicación de ramas (HU-119).

import { z } from 'zod';
import { CompanyIdSchema, EntityIdSchema, IsoDateTimeSchema } from './common.ts';

export const ACTIVITY_KINDS = ['branch.published'] as const;
export const ACTIVITY_STATUSES = ['ok', 'error'] as const;

/** Entrada del registro de actividad. El mensaje debe estar ya redactado (sin credenciales). */
export const ActivityEntrySchema = z
  .object({
    id: EntityIdSchema,
    companyId: CompanyIdSchema,
    kind: z.enum(ACTIVITY_KINDS),
    branch: z.string().min(1).max(255),
    remote: z.literal('origin'),
    status: z.enum(ACTIVITY_STATUSES),
    message: z.string().max(2000),
    createdAt: IsoDateTimeSchema
  })
  .strict();

export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

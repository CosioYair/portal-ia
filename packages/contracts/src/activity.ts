// Contrato del registro de actividad: publicación de ramas (HU-119) y verificación del Vigía de publicación (HU-123).

import { z } from 'zod';
import { PUBLICATION_VERDICTS } from '@portal/domain';
import { CompanyIdSchema, EntityIdSchema, IsoDateTimeSchema } from './common.ts';

export const ACTIVITY_KINDS = ['branch.published', 'publication.verified'] as const;
export const ACTIVITY_STATUSES = ['ok', 'error'] as const;

/**
 * Entrada del registro de actividad. El mensaje debe estar ya redactado (sin credenciales).
 * Los campos actor, storyId, commitSha y verdict son opcionales y los rellena el Vigía de publicación.
 */
export const ActivityEntrySchema = z
  .object({
    id: EntityIdSchema,
    companyId: CompanyIdSchema,
    kind: z.enum(ACTIVITY_KINDS),
    branch: z.string().min(1).max(255),
    remote: z.literal('origin'),
    status: z.enum(ACTIVITY_STATUSES),
    message: z.string().max(2000),
    createdAt: IsoDateTimeSchema,
    actor: z.string().min(1).max(100).optional(),
    storyId: z.string().min(1).max(100).optional(),
    commitSha: z.string().min(1).max(64).optional(),
    verdict: z.enum(PUBLICATION_VERDICTS).optional()
  })
  .strict();

export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

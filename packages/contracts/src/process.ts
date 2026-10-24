// Contratos de Proceso.

import { z } from 'zod';
import {
  EntityIdSchema,
  IsoDateTimeSchema,
  NameSchema,
  companyScoped
} from './common.ts';

export const PROCESS_STATUSES = [
  'planificando',
  'esperando_autorizacion',
  'ejecutando',
  'verificando',
  'esperando_revision',
  'detenido'
] as const;

export const ProcessStatusSchema = z.enum(PROCESS_STATUSES);

const processShape = {
  projectId: EntityIdSchema,
  name: NameSchema,
  agentIds: z.array(EntityIdSchema).max(50)
};

export const ProcessCreateInputSchema = companyScoped(processShape);

export const ProcessOutputSchema = companyScoped({
  id: EntityIdSchema,
  ...processShape,
  status: ProcessStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema
});

export type ProcessStatus = z.infer<typeof ProcessStatusSchema>;
export type ProcessCreateInput = z.infer<typeof ProcessCreateInputSchema>;
export type ProcessOutput = z.infer<typeof ProcessOutputSchema>;

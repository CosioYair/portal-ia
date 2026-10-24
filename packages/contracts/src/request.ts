// Contratos de Solicitud.

import { z } from 'zod';
import {
  EntityIdSchema,
  IsoDateTimeSchema,
  NameSchema,
  companyScoped
} from './common.ts';

export const REQUEST_STATUSES = [
  'abierta',
  'planificada',
  'en_curso',
  'cerrada',
  'rechazada'
] as const;

export const RequestStatusSchema = z.enum(REQUEST_STATUSES);

const requestShape = {
  projectId: EntityIdSchema,
  title: NameSchema,
  description: z
    .string({ invalid_type_error: 'La descripción debe ser texto' })
    .trim()
    .min(1, 'La descripción no puede estar vacía')
    .max(10000, 'Máximo 10000 caracteres')
};

export const RequestCreateInputSchema = companyScoped(requestShape);

export const RequestOutputSchema = companyScoped({
  id: EntityIdSchema,
  ...requestShape,
  status: RequestStatusSchema,
  createdAt: IsoDateTimeSchema
});

export type RequestStatus = z.infer<typeof RequestStatusSchema>;
export type RequestCreateInput = z.infer<typeof RequestCreateInputSchema>;
export type RequestOutput = z.infer<typeof RequestOutputSchema>;

// Contratos de Autorización. Toda autorización es de un solo uso y va ligada al hash de la acción.

import { z } from 'zod';
import {
  EntityIdSchema,
  IsoDateTimeSchema,
  NameSchema,
  companyScoped
} from './common.ts';

export const AUTHORIZATION_STATUSES = [
  'pendiente',
  'aprobada',
  'denegada',
  'caducada',
  'consumida'
] as const;

export const AuthorizationStatusSchema = z.enum(AUTHORIZATION_STATUSES);

/** SHA-256 en hexadecimal minúscula (64 caracteres). */
export const ActionHashSchema = z
  .string({ invalid_type_error: 'actionHash debe ser texto' })
  .regex(/^[a-f0-9]{64}$/, 'actionHash inválido: se espera SHA-256 en hexadecimal (64 caracteres)');

export const AuthorizationCreateInputSchema = companyScoped({
  requestId: EntityIdSchema,
  action: NameSchema,
  actionHash: ActionHashSchema,
  expiresAt: IsoDateTimeSchema
});

export const AuthorizationOutputSchema = companyScoped({
  id: EntityIdSchema,
  requestId: EntityIdSchema,
  action: NameSchema,
  actionHash: ActionHashSchema,
  expiresAt: IsoDateTimeSchema,
  status: AuthorizationStatusSchema,
  singleUse: z.literal(true),
  decidedAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema
});

export const AuthorizationDecisionInputSchema = companyScoped({
  authorizationId: EntityIdSchema,
  decision: z.enum(['aprobar', 'denegar']),
  actionHash: ActionHashSchema
});

export type AuthorizationStatus = z.infer<typeof AuthorizationStatusSchema>;
export type AuthorizationCreateInput = z.infer<typeof AuthorizationCreateInputSchema>;
export type AuthorizationOutput = z.infer<typeof AuthorizationOutputSchema>;
export type AuthorizationDecisionInput = z.infer<typeof AuthorizationDecisionInputSchema>;

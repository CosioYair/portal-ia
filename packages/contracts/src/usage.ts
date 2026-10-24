// Contratos de Consumo (tokens y coste de cada llamada a un modelo).

import type { z } from 'zod';
import {
  CostMicrosSchema,
  CurrencySchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  NameSchema,
  TokenCountSchema,
  companyScoped
} from './common.ts';

const usageShape = {
  projectId: EntityIdSchema.optional(),
  processId: EntityIdSchema.optional(),
  provider: NameSchema,
  model: NameSchema,
  inputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  costMicros: CostMicrosSchema,
  currency: CurrencySchema
};

export const UsageRecordInputSchema = companyScoped(usageShape);

export const UsageOutputSchema = companyScoped({
  id: EntityIdSchema,
  ...usageShape,
  createdAt: IsoDateTimeSchema
});

export type UsageRecordInput = z.infer<typeof UsageRecordInputSchema>;
export type UsageOutput = z.infer<typeof UsageOutputSchema>;

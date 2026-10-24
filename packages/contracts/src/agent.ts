// Contratos de Agente.

import { z } from 'zod';
import {
  CostMicrosSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  NameSchema,
  companyScoped
} from './common.ts';

const agentShape = {
  name: NameSchema,
  role: NameSchema,
  allowedTools: z.array(z.string().min(1).max(100)).max(100),
  budgetLimitMicros: CostMicrosSchema.optional()
};

export const AgentCreateInputSchema = companyScoped(agentShape);

export const AgentOutputSchema = companyScoped({
  id: EntityIdSchema,
  ...agentShape,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema
});

export type AgentCreateInput = z.infer<typeof AgentCreateInputSchema>;
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

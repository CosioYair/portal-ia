// Contratos de Empresa. companyId es la identidad de la empresa y se exige también en la entrada.

import type { z } from 'zod';
import { IsoDateTimeSchema, NameSchema, companyScoped } from './common.ts';

export const CompanyCreateInputSchema = companyScoped({
  name: NameSchema
});

export const CompanyOutputSchema = companyScoped({
  name: NameSchema,
  createdAt: IsoDateTimeSchema
});

export type CompanyCreateInput = z.infer<typeof CompanyCreateInputSchema>;
export type CompanyOutput = z.infer<typeof CompanyOutputSchema>;

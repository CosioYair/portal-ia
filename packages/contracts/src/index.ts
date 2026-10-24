// Contratos compartidos entre servidor y web. Solo puede depender de @portal/domain.

import type { CompanyId } from '@portal/domain';

/** Referencia mínima a una empresa en las respuestas de la API. */
export interface CompanyRef {
  readonly id: CompanyId;
  readonly name: string;
}

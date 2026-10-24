// Dominio compartido: tipos y plantillas puras, sin IO ni dependencias externas.

export * from './git-branch.ts';
export * from './story-closure.ts';
export * from './portal-sync.ts';
export * from './runtime-location.ts';

declare const companyIdBrand: unique symbol;

/** Identificador de una empresa (tipo marcado para evitar mezclarlo con otros textos). */
export type CompanyId = string & { readonly [companyIdBrand]: true };

/** Empresa: unidad raíz de la plataforma. Versión mínima de partida. */
export interface Company {
  readonly id: CompanyId;
  readonly name: string;
}

/** Convierte un texto ya validado en un CompanyId. */
export function asCompanyId(value: string): CompanyId {
  return value as CompanyId;
}

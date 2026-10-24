// Piezas comunes de los contratos: identificadores, fechas, medidas de consumo, helper de
// alcance por empresa, validación sin excepciones y error estructurado de la API.

import { z } from 'zod';

/** Fases en las que puede fallar una operación: validación, arranque, proceso o comunicación (red). */
export const API_ERROR_STEPS = ['validacion', 'arranque', 'proceso', 'red'] as const;

/** Identificador de empresa: slug de 2 a 63 caracteres (minúsculas, dígitos y guiones). */
export const COMPANY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const CompanyIdSchema = z
  .string({
    required_error: 'companyId es obligatorio',
    invalid_type_error: 'companyId debe ser texto'
  })
  .regex(
    COMPANY_ID_PATTERN,
    'companyId inválido: use 2 a 63 caracteres en minúsculas, dígitos o guiones, empezando por letra o dígito'
  );

/** Identificador de cualquier otra entidad (ULID, UUID o similar). */
export const EntityIdSchema = z
  .string({ invalid_type_error: 'El identificador debe ser texto' })
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, 'Identificador inválido');

/** Fecha y hora en formato ISO 8601. */
export const IsoDateTimeSchema = z
  .string({ invalid_type_error: 'La fecha debe ser texto ISO 8601' })
  .datetime({ offset: true, message: 'Fecha y hora inválidas (se espera ISO 8601)' });

/** Cantidad de tokens: entero mayor o igual que cero. */
export const TokenCountSchema = z
  .number({ invalid_type_error: 'Los tokens deben ser un número' })
  .int('Los tokens deben ser un entero')
  .nonnegative('Los tokens no pueden ser negativos');

/** Coste en micro-unidades de la moneda (1 USD = 1 000 000), entero para evitar decimales. */
export const CostMicrosSchema = z
  .number({ invalid_type_error: 'El coste debe ser un número' })
  .int('El coste debe expresarse en micro-unidades enteras')
  .nonnegative('El coste no puede ser negativo');

export const CurrencySchema = z.enum(['USD', 'EUR']);

/** Texto corto y no vacío (nombres, títulos, proveedores...). */
export const NameSchema = z
  .string({ invalid_type_error: 'Debe ser texto' })
  .trim()
  .min(1, 'No puede estar vacío')
  .max(200, 'Máximo 200 caracteres');

/**
 * Construye un esquema de objeto estricto con companyId obligatorio.
 * Los campos desconocidos se rechazan.
 */
export function companyScoped<T extends z.ZodRawShape>(shape: T) {
  return z.object({ companyId: CompanyIdSchema, ...shape }).strict();
}

export interface ValidationIssue {
  /** Ruta del campo con problemas, separada por puntos (vacía si afecta a la raíz). */
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Valida un dato desconocido contra un esquema sin lanzar excepciones. */
export function validate<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown
): ValidationResult<z.output<S>> {
  const result = schema.safeParse(data);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message
    }))
  };
}

/** Esquema del error estructurado que devuelve la API (equivale a la interfaz ApiError). */
export const ApiErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    step: z.enum(API_ERROR_STEPS),
    detail: z.string().optional()
  })
  .strict();

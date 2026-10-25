import type { DatabaseSync } from 'node:sqlite';

/**
 * Esquema del libro de presupuesto (HU-007). Idempotente: se puede llamar en cada apertura de la base del espacio.
 * Importes en micro-USD como enteros.
 */
export function ensureBudgetSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS budget_limits (
      scope_id TEXT PRIMARY KEY,
      limit_micros INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS budget_reservations (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      estimated_micros INTEGER NOT NULL,
      actual_micros INTEGER NULL,
      status TEXT NOT NULL CHECK (status IN ('active','settled','released')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_budget_reservations_scope_status
      ON budget_reservations (scope_id, status);
  `);
}

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BudgetSnapshot } from '@portal-ia/domain';
import { ensureBudgetSchema } from '../db/budget-schema.ts';

/** Se lanza cuando la estimación no cabe en el presupuesto disponible (o no hay límite configurado). */
export class BudgetExceededError extends Error {
  constructor(
    public readonly scopeId: string,
    public readonly availableMicros: number,
    public readonly requestedMicros: number,
    public readonly reason: 'no_limit' | 'insufficient' = 'insufficient'
  ) {
    super(
      reason === 'no_limit'
        ? `No hay un presupuesto configurado para «${scopeId}»: la llamada se bloqueó antes de enviarse.`
        : `Presupuesto insuficiente en «${scopeId}»: disponible ${availableMicros} µUSD, solicitado ${requestedMicros} µUSD. La llamada se bloqueó antes de enviarse.`
    );
    this.name = 'BudgetExceededError';
  }
}

export interface BudgetLedger {
  setLimit(scopeId: string, limitMicros: number): void;
  snapshot(scopeId: string): BudgetSnapshot;
  /** Reserva la estimación o lanza BudgetExceededError. Devuelve el id de la reserva. */
  reserve(scopeId: string, estimatedMicros: number): string;
  /** Ajusta la reserva activa al coste real. Devuelve false si ya estaba cerrada (idempotente). */
  settle(reservationId: string, actualMicros: number): boolean;
  /** Libera la reserva activa sin gasto. Devuelve false si ya estaba cerrada (idempotente). */
  release(reservationId: string): boolean;
}

function assertMicros(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} debe ser un entero no negativo en micro-USD.`);
}

export function createBudgetLedger(db: DatabaseSync): BudgetLedger {
  ensureBudgetSchema(db);

  const limitStmt = db.prepare('SELECT limit_micros AS v FROM budget_limits WHERE scope_id = ?');
  const spentStmt = db.prepare("SELECT COALESCE(SUM(actual_micros), 0) AS v FROM budget_reservations WHERE scope_id = ? AND status = 'settled'");
  const reservedStmt = db.prepare("SELECT COALESCE(SUM(estimated_micros), 0) AS v FROM budget_reservations WHERE scope_id = ? AND status = 'active'");

  const getLimit = (scopeId: string): number | null => {
    const row = limitStmt.get(scopeId);
    return row ? Number(row.v) : null;
  };
  const computeSnapshot = (scopeId: string): BudgetSnapshot => {
    const limitMicros = getLimit(scopeId) ?? 0;
    const spentMicros = Number(spentStmt.get(scopeId)?.v ?? 0);
    const reservedMicros = Number(reservedStmt.get(scopeId)?.v ?? 0);
    return { limitMicros, spentMicros, reservedMicros, availableMicros: limitMicros - spentMicros - reservedMicros };
  };

  const close = (reservationId: string, status: 'settled' | 'released', actualMicros: number | null): boolean => {
    const res = db
      .prepare("UPDATE budget_reservations SET status = ?, actual_micros = ?, updated_at = ? WHERE id = ? AND status = 'active'")
      .run(status, actualMicros, new Date().toISOString(), reservationId);
    return Number(res.changes) > 0;
  };

  return {
    setLimit(scopeId, limitMicros) {
      assertMicros(limitMicros, 'limitMicros');
      db.prepare('INSERT INTO budget_limits (scope_id, limit_micros) VALUES (?, ?) ON CONFLICT(scope_id) DO UPDATE SET limit_micros = excluded.limit_micros')
        .run(scopeId, limitMicros);
    },

    snapshot: computeSnapshot,

    reserve(scopeId, estimatedMicros) {
      assertMicros(estimatedMicros, 'estimatedMicros');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (getLimit(scopeId) === null) throw new BudgetExceededError(scopeId, 0, estimatedMicros, 'no_limit');
        const snap = computeSnapshot(scopeId);
        if (estimatedMicros > snap.availableMicros) throw new BudgetExceededError(scopeId, snap.availableMicros, estimatedMicros);
        const id = randomUUID();
        const now = new Date().toISOString();
        db.prepare("INSERT INTO budget_reservations (id, scope_id, estimated_micros, actual_micros, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'active', ?, ?)")
          .run(id, scopeId, estimatedMicros, now, now);
        db.exec('COMMIT');
        return id;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    settle(reservationId, actualMicros) {
      assertMicros(actualMicros, 'actualMicros');
      return close(reservationId, 'settled', actualMicros);
    },

    release(reservationId) {
      return close(reservationId, 'released', null);
    }
  };
}

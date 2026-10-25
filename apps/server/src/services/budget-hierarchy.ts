import type { DatabaseSync } from 'node:sqlite';
import type { BudgetBalance, BudgetLevel, MonthlyBudget, ProcessBudgetReservation } from '@portal-ia/domain';

/**
 * HU-133 · Presupuestos jerárquicos empresa > proyecto > proceso con saldo real.
 *
 * - Importes enteros en micro-USD (1 USD = 1_000_000).
 * - Periodo mensual en UTC con formato 'YYYY-MM'.
 * - saldo = límite − gasto real − reservas activas.
 * - La comprobación y la reserva se hacen dentro de una transacción BEGIN IMMEDIATE.
 * - Sin presupuesto definido se deniega por defecto.
 * - Fuente única del gasto real de esta jerarquía: la tabla budget_spend. `settle` registra en ella el coste
 *   real de un proceso; `recordSpend` registra gasto que no pertenece a un proceso reservado.
 *   No registrar dos veces el mismo gasto por ambas vías.
 */

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Convención única: el mes se calcula en UTC. */
export function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

const levelName = (l: BudgetLevel) => (l === 'company' ? 'empresa' : 'proyecto');
const usd = (micros: number) => `${(micros / 1_000_000).toFixed(4)} USD`;

export class BudgetHierarchyError extends Error {
  reason: 'no_limit' | 'insufficient';
  level: BudgetLevel;
  scopeId: string;
  period: string;
  requestedMicros: number;
  availableMicros: number;
  constructor(info: { reason: 'no_limit' | 'insufficient'; level: BudgetLevel; scopeId: string; period: string; requestedMicros: number; availableMicros: number }) {
    super(info.reason === 'no_limit'
      ? `No hay presupuesto mensual definido para ${levelName(info.level)} «${info.scopeId}» en ${info.period}; la autorización se deniega por defecto.`
      : `El coste estimado (${usd(info.requestedMicros)}) supera el saldo disponible de ${levelName(info.level)} «${info.scopeId}» (${usd(info.availableMicros)}) en ${info.period}.`);
    this.name = 'BudgetHierarchyError';
    this.reason = info.reason;
    this.level = info.level;
    this.scopeId = info.scopeId;
    this.period = info.period;
    this.requestedMicros = info.requestedMicros;
    this.availableMicros = info.availableMicros;
  }
}

function assertMicros(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`El importe de ${what} debe ser un entero no negativo en micro-USD.`);
}
function assertPeriod(period: string): void {
  if (!PERIOD_RE.test(period)) throw new Error('Periodo no válido: usa el formato AAAA-MM.');
}

export function createBudgetHierarchy(db: DatabaseSync, companyId: string) {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS monthly_budgets (
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      period TEXT NOT NULL,
      limit_micros INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, scope_id, period)
    );
    CREATE TABLE IF NOT EXISTS budget_spend (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      period TEXT NOT NULL,
      micros INTEGER NOT NULL,
      process_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_budget_spend_period ON budget_spend (period, project_id);
    CREATE TABLE IF NOT EXISTS process_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      period TEXT NOT NULL,
      amount_micros INTEGER NOT NULL,
      actual_micros INTEGER,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_process_reservations_proc ON process_reservations (process_id, status);
    CREATE INDEX IF NOT EXISTS idx_process_reservations_period ON process_reservations (period, project_id, status);
  `);

  const num = (v: unknown) => Number(v ?? 0);

  function tx<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function limitOf(level: BudgetLevel, id: string, period: string): number | null {
    const row = db.prepare('SELECT limit_micros AS l FROM monthly_budgets WHERE scope = ? AND scope_id = ? AND period = ?').get(level, id, period);
    return row ? num(row.l) : null;
  }

  function balanceOf(level: BudgetLevel, id: string, period: string): BudgetBalance {
    const limit = limitOf(level, id, period);
    const project = level === 'project';
    const spentRow = project
      ? db.prepare('SELECT COALESCE(SUM(micros), 0) AS v FROM budget_spend WHERE period = ? AND project_id = ?').get(period, id)
      : db.prepare('SELECT COALESCE(SUM(micros), 0) AS v FROM budget_spend WHERE period = ?').get(period);
    const reservedRow = project
      ? db.prepare("SELECT COALESCE(SUM(amount_micros), 0) AS v FROM process_reservations WHERE period = ? AND status = 'active' AND project_id = ?").get(period, id)
      : db.prepare("SELECT COALESCE(SUM(amount_micros), 0) AS v FROM process_reservations WHERE period = ? AND status = 'active'").get(period);
    const spent = num(spentRow?.v);
    const reserved = num(reservedRow?.v);
    const limitMicros = limit ?? 0;
    return {
      level, scopeId: id, period, configured: limit !== null,
      limitMicros, spentMicros: spent, reservedMicros: reserved,
      availableMicros: limitMicros - spent - reserved
    };
  }

  return {
    /** Fija (o actualiza) el presupuesto mensual de la empresa o de un proyecto. */
    setMonthlyBudget(level: BudgetLevel, id: string, period: string, limitMicros: number, now: Date = new Date()): MonthlyBudget {
      assertPeriod(period);
      assertMicros(limitMicros, 'presupuesto');
      if (!id) throw new Error('Falta el identificador del ámbito.');
      if (level === 'company' && id !== companyId) throw new Error('El presupuesto de empresa solo puede fijarse para la empresa de este espacio.');
      db.prepare(`INSERT INTO monthly_budgets (scope, scope_id, period, limit_micros, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (scope, scope_id, period) DO UPDATE SET limit_micros = excluded.limit_micros, updated_at = excluded.updated_at`)
        .run(level, id, period, limitMicros, now.toISOString());
      return { scope: level, scopeId: id, period, limitMicros };
    },

    getBalance(level: BudgetLevel, id: string, period: string = currentPeriod()): BudgetBalance {
      assertPeriod(period);
      if (level === 'company' && id !== companyId) throw new Error('La empresa no corresponde a este espacio.');
      return balanceOf(level, id, period);
    },

    /**
     * Reserva atómica para un proceso: el estimado debe caber en el saldo del proyecto Y en el de la empresa.
     * Idempotente: si el proceso ya tiene una reserva activa, la devuelve sin duplicarla.
     */
    reserveForProcess(processId: string, projectId: string, estimateMicros: number, now: Date = new Date()): ProcessBudgetReservation {
      assertMicros(estimateMicros, 'estimado');
      if (!processId || !projectId) throw new Error('Faltan el proceso o el proyecto para reservar presupuesto.');
      const period = currentPeriod(now);
      return tx(() => {
        const existing = db.prepare("SELECT project_id AS p, amount_micros AS a FROM process_reservations WHERE process_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(processId);
        if (existing) return { processId, projectId: String(existing.p), amountMicros: num(existing.a), status: 'active' as const };
        const levels: [BudgetLevel, string][] = [['project', projectId], ['company', companyId]];
        for (const [level, id] of levels) {
          const b = balanceOf(level, id, period);
          if (!b.configured) throw new BudgetHierarchyError({ reason: 'no_limit', level, scopeId: id, period, requestedMicros: estimateMicros, availableMicros: 0 });
          if (estimateMicros > b.availableMicros) throw new BudgetHierarchyError({ reason: 'insufficient', level, scopeId: id, period, requestedMicros: estimateMicros, availableMicros: b.availableMicros });
        }
        db.prepare("INSERT INTO process_reservations (process_id, project_id, period, amount_micros, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
          .run(processId, projectId, period, estimateMicros, now.toISOString());
        return { processId, projectId, amountMicros: estimateMicros, status: 'active' as const };
      });
    },

    /** Cierra la reserva activa con el coste real: pasa a 'settled' y registra el gasto real. Devuelve false si no había reserva activa. */
    settle(processId: string, actualMicros: number, now: Date = new Date()): boolean {
      assertMicros(actualMicros, 'coste real');
      return tx(() => {
        const row = db.prepare("SELECT id, project_id AS p, period FROM process_reservations WHERE process_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(processId);
        if (!row) return false;
        db.prepare("UPDATE process_reservations SET status = 'settled', actual_micros = ?, closed_at = ? WHERE id = ?").run(actualMicros, now.toISOString(), num(row.id));
        if (actualMicros > 0) {
          db.prepare('INSERT INTO budget_spend (project_id, period, micros, process_id, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(String(row.p), String(row.period), actualMicros, processId, now.toISOString());
        }
        return true;
      });
    },

    /** Libera la reserva activa (proceso cancelado o fallido sin coste). Devuelve false si no había reserva activa. */
    release(processId: string, now: Date = new Date()): boolean {
      const res = db.prepare("UPDATE process_reservations SET status = 'released', closed_at = ? WHERE process_id = ? AND status = 'active'").run(now.toISOString(), processId);
      return Number(res.changes) > 0;
    },

    /** Gasto real que no pasa por una reserva de proceso (p. ej. el asistente). projectId null = solo cuenta para la empresa. */
    recordSpend(projectId: string | null, micros: number, now: Date = new Date()): void {
      assertMicros(micros, 'gasto');
      if (micros === 0) return;
      db.prepare('INSERT INTO budget_spend (project_id, period, micros, process_id, created_at) VALUES (?, ?, ?, NULL, ?)')
        .run(projectId, currentPeriod(now), micros, now.toISOString());
    },

    listActive(): ProcessBudgetReservation[] {
      return db.prepare("SELECT process_id AS p, project_id AS pr, amount_micros AS a FROM process_reservations WHERE status = 'active' ORDER BY id")
        .all().map(r => ({ processId: String(r.p), projectId: String(r.pr), amountMicros: num(r.a), status: 'active' as const }));
    },

    /** Libera las reservas activas cuyo proceso ya no está en curso (p. ej. tras una caída del servidor). Devuelve cuántas liberó. */
    releaseOrphans(isProcessActive: (processId: string) => boolean, now: Date = new Date()): number {
      let n = 0;
      for (const r of this.listActive()) {
        if (!isProcessActive(r.processId) && this.release(r.processId, now)) n++;
      }
      return n;
    }
  };
}

export type BudgetHierarchy = ReturnType<typeof createBudgetHierarchy>;

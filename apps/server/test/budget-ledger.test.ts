import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { CompletionRequest, CompletionResult, ProviderAdapter } from '@portal-ia/ai-adapters';

const { createBudgetLedger, BudgetExceededError } = await import('../src/services/budget-ledger.ts');
const { guardedComplete, estimateCallMicros } = await import('../src/services/guarded-complete.ts');

const SCOPE = 'portal-ia';

const request: CompletionRequest = {
  model: 'claude-sonnet-4-5',
  system: 'Eres un agente.',
  user: 'Hola',
  maxTokens: 1000,
  effort: 'low',
  supportsEffort: false
};

/** Adaptador falso: cuenta invocaciones y devuelve un resultado fijo o lanza un error. */
function fakeAdapter(behavior: { result?: CompletionResult; error?: Error }) {
  const state = { calls: 0 };
  const adapter: ProviderAdapter = {
    id: 'anthropic',
    async listModels() { return []; },
    async complete() {
      state.calls++;
      if (behavior.error) throw behavior.error;
      return behavior.result ?? { text: 'ok', inputTokens: 0, outputTokens: 0, stopReason: 'end_turn' };
    }
  };
  return { adapter, state };
}

function newLedger() {
  const db = new DatabaseSync(':memory:'); // base aislada por prueba
  return { db, ledger: createBudgetLedger(db) };
}

const reservationStatuses = (db: DatabaseSync) =>
  db.prepare('SELECT status FROM budget_reservations ORDER BY created_at, rowid').all().map(r => String(r.status));

test('presupuesto agotado: se bloquea antes de enviar, sin invocar al adaptador ni dejar reservas', async () => {
  const { db, ledger } = newLedger();
  const { adapter, state } = fakeAdapter({});
  const estimate = estimateCallMicros(adapter, request);
  ledger.setLimit(SCOPE, estimate - 1);
  await assert.rejects(
    guardedComplete(ledger, adapter, SCOPE, { apiKey: 'k', request }),
    (e: unknown) => e instanceof BudgetExceededError && e.scopeId === SCOPE && e.requestedMicros === estimate && e.availableMicros === estimate - 1
  );
  assert.equal(state.calls, 0, 'el adaptador no recibe la llamada');
  assert.deepEqual(reservationStatuses(db), [], 'no queda ninguna reserva');
  assert.equal(ledger.snapshot(SCOPE).reservedMicros, 0);
});

test('éxito: la reserva se ajusta al coste real, distinto del estimado', async () => {
  const { db, ledger } = newLedger();
  // 10 tokens de entrada y 100 de salida en Sonnet (3 / 15 USD por millón) = 1530 µUSD.
  const { adapter, state } = fakeAdapter({ result: { text: 'hola', inputTokens: 10, outputTokens: 100, stopReason: 'end_turn' } });
  ledger.setLimit(SCOPE, 100_000);
  const out = await guardedComplete(ledger, adapter, SCOPE, { apiKey: 'k', request });
  assert.equal(state.calls, 1);
  assert.equal(out.actualMicros, 1530);
  assert.ok(out.estimatedMicros > out.actualMicros, 'la estimación era mayor que el coste real');
  assert.deepEqual(reservationStatuses(db), ['settled']);
  const snap = ledger.snapshot(SCOPE);
  assert.equal(snap.spentMicros, 1530, 'gastado = coste real, no el estimado');
  assert.equal(snap.reservedMicros, 0);
  assert.equal(snap.availableMicros, 100_000 - 1530);
  const row = db.prepare('SELECT actual_micros AS a FROM budget_reservations WHERE id = ?').get(out.reservationId);
  assert.equal(Number(row?.a), 1530);
});

test('fallo del adaptador: la reserva se libera y el disponible vuelve al valor inicial', async () => {
  const { db, ledger } = newLedger();
  const { adapter, state } = fakeAdapter({ error: new Error('proveedor caído') });
  ledger.setLimit(SCOPE, 100_000);
  const before = ledger.snapshot(SCOPE).availableMicros;
  await assert.rejects(guardedComplete(ledger, adapter, SCOPE, { apiKey: 'k', request }), /proveedor caído/);
  assert.equal(state.calls, 1);
  assert.deepEqual(reservationStatuses(db), ['released']);
  const snap = ledger.snapshot(SCOPE);
  assert.equal(snap.availableMicros, before);
  assert.equal(snap.spentMicros, 0);
  assert.equal(snap.reservedMicros, 0);
});

test('las reservas activas cuentan contra el disponible: la segunda que excede el límite se bloquea', () => {
  const { ledger } = newLedger();
  ledger.setLimit(SCOPE, 100);
  const a = ledger.reserve(SCOPE, 60);
  assert.throws(() => ledger.reserve(SCOPE, 60), (e: unknown) => e instanceof BudgetExceededError && e.availableMicros === 40);
  assert.equal(ledger.snapshot(SCOPE).reservedMicros, 60);
  ledger.reserve(SCOPE, 40); // lo que queda sí cabe
  assert.equal(ledger.snapshot(SCOPE).availableMicros, 0);
  // Al liberar la primera, vuelve a haber hueco.
  ledger.release(a);
  assert.equal(ledger.snapshot(SCOPE).availableMicros, 60);
});

test('sin límite configurado se deniega por defecto', async () => {
  const { db, ledger } = newLedger();
  const { adapter, state } = fakeAdapter({});
  await assert.rejects(
    guardedComplete(ledger, adapter, SCOPE, { apiKey: 'k', request }),
    (e: unknown) => e instanceof BudgetExceededError && e.reason === 'no_limit'
  );
  assert.equal(state.calls, 0);
  assert.deepEqual(reservationStatuses(db), []);
  assert.throws(() => ledger.reserve(SCOPE, 0), BudgetExceededError, 'ni siquiera una reserva de 0');
});

test('settle y release son idempotentes y solo actúan sobre reservas activas', () => {
  const { ledger } = newLedger();
  ledger.setLimit(SCOPE, 1000);
  const id = ledger.reserve(SCOPE, 500);
  assert.equal(ledger.settle(id, 300), true);
  assert.equal(ledger.settle(id, 999), false, 'doble liquidación ignorada');
  assert.equal(ledger.release(id), false, 'no se puede liberar una reserva liquidada');
  const snap = ledger.snapshot(SCOPE);
  assert.equal(snap.spentMicros, 300);
  assert.equal(snap.availableMicros, 700);
  const id2 = ledger.reserve(SCOPE, 100);
  assert.equal(ledger.release(id2), true);
  assert.equal(ledger.release(id2), false);
  assert.equal(ledger.settle(id2, 50), false, 'no se puede liquidar una reserva liberada');
  assert.equal(ledger.snapshot(SCOPE).spentMicros, 300);
});

test('un coste real superior a la estimación se registra y bloquea las llamadas siguientes', async () => {
  const { ledger } = newLedger();
  // 1000 tokens de entrada y 2000 de salida = 33000 µUSD, por encima de la estimación (≈15000).
  const { adapter, state } = fakeAdapter({ result: { text: 'x', inputTokens: 1000, outputTokens: 2000, stopReason: 'end_turn' } });
  const estimate = estimateCallMicros(adapter, request);
  ledger.setLimit(SCOPE, estimate + 1000);
  await guardedComplete(ledger, adapter, SCOPE, { apiKey: 'k', request });
  assert.equal(ledger.snapshot(SCOPE).spentMicros, 33_000);
  assert.ok(ledger.snapshot(SCOPE).availableMicros < 0);
  await assert.rejects(guardedComplete(ledger, adapter, SCOPE, { apiKey: 'k', request }), BudgetExceededError);
  assert.equal(state.calls, 1);
});

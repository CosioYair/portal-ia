import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { createBudgetHierarchy, BudgetHierarchyError, currentPeriod } = await import('../src/services/budget-hierarchy.ts');

const COMPANY = 'acme';
const NOW = new Date('2025-03-10T10:00:00Z');
const P = '2025-03';

function setup(companyLimit = 1000, projectLimit = 500) {
  const h = createBudgetHierarchy(new DatabaseSync(':memory:'), COMPANY);
  if (companyLimit >= 0) h.setMonthlyBudget('company', COMPANY, P, companyLimit);
  if (projectLimit >= 0) h.setMonthlyBudget('project', 'p1', P, projectLimit);
  return h;
}

test('autoriza si el estimado cabe en el proyecto y en la empresa', () => {
  const h = setup();
  const r = h.reserveForProcess('proc-1', 'p1', 300, NOW);
  assert.equal(r.status, 'active');
  assert.equal(r.amountMicros, 300);
  assert.equal(h.getBalance('project', 'p1', P).reservedMicros, 300);
  assert.equal(h.getBalance('project', 'p1', P).availableMicros, 200);
  assert.equal(h.getBalance('company', COMPANY, P).availableMicros, 700);
});

test('deniega si el estimado supera el saldo del proyecto', () => {
  const h = setup(1000, 500);
  assert.throws(
    () => h.reserveForProcess('proc-1', 'p1', 600, NOW),
    (e: unknown) => e instanceof BudgetHierarchyError && e.level === 'project' && e.scopeId === 'p1' && e.reason === 'insufficient' && e.requestedMicros === 600 && e.availableMicros === 500
  );
  assert.equal(h.getBalance('project', 'p1', P).reservedMicros, 0, 'no queda reserva');
  assert.equal(h.listActive().length, 0);
});

test('deniega si el proyecto tiene saldo pero la empresa no', () => {
  const h = setup(200, 500);
  assert.throws(
    () => h.reserveForProcess('proc-1', 'p1', 300, NOW),
    (e: unknown) => e instanceof BudgetHierarchyError && e.level === 'company' && e.scopeId === COMPANY && e.availableMicros === 200
  );
  assert.equal(h.listActive().length, 0);
});

test('las reservas activas reducen el disponible y bloquean la siguiente', () => {
  const h = setup(1000, 500);
  h.reserveForProcess('proc-1', 'p1', 300, NOW);
  assert.throws(
    () => h.reserveForProcess('proc-2', 'p1', 300, NOW),
    (e: unknown) => e instanceof BudgetHierarchyError && e.level === 'project' && e.availableMicros === 200
  );
  h.reserveForProcess('proc-3', 'p1', 200, NOW); // lo que queda sí cabe
  assert.equal(h.getBalance('project', 'p1', P).availableMicros, 0);
});

test('reservar dos veces el mismo proceso es idempotente', () => {
  const h = setup(1000, 500);
  h.reserveForProcess('proc-1', 'p1', 300, NOW);
  const again = h.reserveForProcess('proc-1', 'p1', 300, NOW);
  assert.equal(again.amountMicros, 300);
  assert.equal(h.getBalance('project', 'p1', P).reservedMicros, 300, 'no se duplica');
});

test('settle refleja el gasto real y libera el sobrante de la reserva', () => {
  const h = setup(1000, 500);
  h.reserveForProcess('proc-1', 'p1', 400, NOW);
  assert.equal(h.settle('proc-1', 150, NOW), true);
  const p = h.getBalance('project', 'p1', P);
  assert.equal(p.spentMicros, 150);
  assert.equal(p.reservedMicros, 0);
  assert.equal(p.availableMicros, 350);
  const c = h.getBalance('company', COMPANY, P);
  assert.equal(c.spentMicros, 150);
  assert.equal(c.availableMicros, 850);
  assert.equal(h.settle('proc-1', 999, NOW), false, 'doble liquidación ignorada');
  assert.equal(h.getBalance('project', 'p1', P).spentMicros, 150);
});

test('un coste real superior a la reserva deja el saldo negativo', () => {
  const h = setup(1000, 500);
  h.reserveForProcess('proc-1', 'p1', 100, NOW);
  h.settle('proc-1', 700, NOW);
  assert.equal(h.getBalance('project', 'p1', P).availableMicros, -200);
  assert.throws(() => h.reserveForProcess('proc-2', 'p1', 1, NOW), BudgetHierarchyError);
});

test('release devuelve el saldo y no actúa sobre reservas ya cerradas', () => {
  const h = setup(1000, 500);
  h.reserveForProcess('proc-1', 'p1', 400, NOW);
  assert.equal(h.getBalance('project', 'p1', P).availableMicros, 100);
  assert.equal(h.release('proc-1', NOW), true);
  const p = h.getBalance('project', 'p1', P);
  assert.equal(p.availableMicros, 500);
  assert.equal(p.spentMicros, 0);
  assert.equal(h.release('proc-1', NOW), false);
  h.reserveForProcess('proc-2', 'p1', 100, NOW);
  h.settle('proc-2', 100, NOW);
  assert.equal(h.release('proc-2', NOW), false, 'una reserva liquidada no se libera');
});

test('dos reservas concurrentes desde conexiones distintas no superan el límite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-budget-'));
  const file = path.join(dir, 'budgets.sqlite');
  const db1 = new DatabaseSync(file);
  const db2 = new DatabaseSync(file);
  try {
    const h1 = createBudgetHierarchy(db1, COMPANY);
    const h2 = createBudgetHierarchy(db2, COMPANY);
    h1.setMonthlyBudget('company', COMPANY, P, 1000);
    h1.setMonthlyBudget('project', 'p1', P, 500);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => h1.reserveForProcess('proc-1', 'p1', 300, NOW)),
      Promise.resolve().then(() => h2.reserveForProcess('proc-2', 'p1', 300, NOW))
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'solo una cabe');
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof BudgetHierarchyError);
    assert.equal(h1.getBalance('project', 'p1', P).reservedMicros, 300);
    assert.equal(h2.getBalance('project', 'p1', P).availableMicros, 200);
  } finally {
    db1.close();
    db2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el cambio de mes reinicia el saldo', () => {
  const h = setup(1000, 500);
  h.reserveForProcess('proc-1', 'p1', 500, NOW);
  h.settle('proc-1', 500, NOW);
  assert.equal(h.getBalance('project', 'p1', P).availableMicros, 0);
  const april = new Date('2025-04-01T00:00:00Z');
  assert.equal(currentPeriod(april), '2025-04');
  // Sin presupuesto en abril: se deniega por defecto.
  assert.throws(() => h.reserveForProcess('proc-2', 'p1', 1, april), (e: unknown) => e instanceof BudgetHierarchyError && e.reason === 'no_limit');
  h.setMonthlyBudget('company', COMPANY, '2025-04', 1000);
  h.setMonthlyBudget('project', 'p1', '2025-04', 500);
  assert.equal(h.getBalance('project', 'p1', '2025-04').availableMicros, 500, 'el gasto de marzo no cuenta');
  h.reserveForProcess('proc-2', 'p1', 500, april);
  assert.equal(h.getBalance('project', 'p1', P).spentMicros, 500, 'marzo conserva su gasto');
});

test('el periodo se calcula en UTC', () => {
  assert.equal(currentPeriod(new Date('2025-03-31T23:59:59Z')), '2025-03');
  assert.equal(currentPeriod(new Date('2025-04-01T00:00:00Z')), '2025-04');
});

test('sin presupuesto definido se deniega por defecto', () => {
  const none = setup(-1, -1);
  assert.throws(
    () => none.reserveForProcess('proc-1', 'p1', 0, NOW),
    (e: unknown) => e instanceof BudgetHierarchyError && e.reason === 'no_limit' && e.level === 'project',
    'ni siquiera una reserva de 0'
  );
  const onlyProject = setup(-1, 500);
  assert.throws(
    () => onlyProject.reserveForProcess('proc-1', 'p1', 10, NOW),
    (e: unknown) => e instanceof BudgetHierarchyError && e.reason === 'no_limit' && e.level === 'company'
  );
  const onlyCompany = setup(1000, -1);
  assert.throws(
    () => onlyCompany.reserveForProcess('proc-1', 'p1', 10, NOW),
    (e: unknown) => e instanceof BudgetHierarchyError && e.reason === 'no_limit' && e.level === 'project'
  );
  assert.equal(none.getBalance('project', 'p1', P).configured, false);
});

test('el gasto sin proyecto solo cuenta contra la empresa', () => {
  const h = setup(1000, 500);
  h.recordSpend(null, 100, NOW);
  h.recordSpend('p1', 50, NOW);
  assert.equal(h.getBalance('company', COMPANY, P).spentMicros, 150);
  assert.equal(h.getBalance('project', 'p1', P).spentMicros, 50);
});

test('releaseOrphans libera reservas de procesos que ya no están activos', () => {
  const h = setup(1000, 500);
  h.reserveForProcess('proc-vivo', 'p1', 100, NOW);
  h.reserveForProcess('proc-huerfano', 'p1', 200, NOW);
  const n = h.releaseOrphans(id => id === 'proc-vivo', NOW);
  assert.equal(n, 1);
  assert.equal(h.getBalance('project', 'p1', P).reservedMicros, 100);
});

test('validaciones: periodo, importes y empresa ajena', () => {
  const h = setup();
  assert.throws(() => h.setMonthlyBudget('project', 'p1', '2025-13', 10), /Periodo no válido/);
  assert.throws(() => h.setMonthlyBudget('project', 'p1', P, -1), /entero no negativo/);
  assert.throws(() => h.setMonthlyBudget('project', 'p1', P, 1.5), /entero no negativo/);
  assert.throws(() => h.setMonthlyBudget('company', 'otra', P, 10), /empresa de este espacio/);
  assert.throws(() => h.reserveForProcess('proc-1', 'p1', 1.5, NOW), /entero no negativo/);
  h.setMonthlyBudget('project', 'p1', P, 800);
  assert.equal(h.getBalance('project', 'p1', P).limitMicros, 800, 'actualizar el límite sustituye al anterior');
});

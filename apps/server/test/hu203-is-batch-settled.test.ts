import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBatchSettled, batchHasWork } from '@portal-ia/domain';

/** HU-203 · isBatchSettled: un lote solo está terminado si cada historia está aceptada, cerrada o cancelada en el Backlog. */
test('isBatchSettled: una historia aplazada se decide por el Backlog, no por su estado en el lote', () => {
  assert.equal(isBatchSettled([{ state: 'postponed', backlogStatus: 'in_progress' }]), false, 'aplazada sin cerrar en el Backlog: no terminado');
  assert.equal(isBatchSettled([{ state: 'postponed', backlogStatus: null }]), false, 'aplazada sin estado en el Backlog: no terminado');
  assert.equal(isBatchSettled([{ state: 'postponed' }]), false);
  assert.equal(isBatchSettled([{ state: 'postponed', backlogStatus: 'done' }]), true, 'aplazada pero aceptada en el Backlog');
  assert.equal(isBatchSettled([{ state: 'postponed', backlogStatus: 'cancelled' }]), true, 'aplazada y cancelada en el Backlog');
  assert.equal(isBatchSettled([{ state: 'postponed', backlogStatus: 'closed' }]), true, 'aplazada y cerrada en el Backlog');
});

test('isBatchSettled: fallidas, bloqueadas y pendientes de aceptación no terminan el lote; aceptadas y canceladas sí', () => {
  assert.equal(isBatchSettled([{ state: 'accepted', backlogStatus: 'done' }, { state: 'cancelled', backlogStatus: null }]), true);
  assert.equal(isBatchSettled([{ state: 'accepted', backlogStatus: 'done' }, { state: 'failed', backlogStatus: 'in_progress' }]), false);
  assert.equal(isBatchSettled([{ state: 'blocked', backlogStatus: 'pending' }]), false);
  assert.equal(isBatchSettled([{ state: 'awaiting_acceptance', backlogStatus: 'in_review' }]), false);
  assert.equal(isBatchSettled([{ state: 'external', backlogStatus: 'in_progress' }]), false, 'ejecutándose fuera del lote: sigue abierto');
  assert.equal(isBatchSettled([{ state: 'external', backlogStatus: 'done' }]), true, 'terminada fuera del lote');
  assert.equal(isBatchSettled([{ state: 'failed', backlogStatus: 'discarded' }]), true, 'fallida pero descartada en el Backlog');
  assert.equal(batchHasWork([{ state: 'postponed', backlogStatus: 'in_progress' }]), true, '«Reanudar» sigue disponible con una aplazada abierta');
  assert.equal(batchHasWork([{ state: 'accepted', backlogStatus: 'done' }]), false);
});

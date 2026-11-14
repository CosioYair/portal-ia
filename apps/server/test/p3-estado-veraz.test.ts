import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerProcessState } from '@portal-ia/domain';

/**
 * Portal IA 3 · estado veraz. La fila de un proceso dice `done` siempre que deja de ejecutarse; lo que ocurrió de verdad
 * lo dicen el pipeline y git. Ningún trabajo detenido, sin verificar o sin integrar puede leerse como «completado»
 * (caso real: HU-214, iteración 7, `status: done` con las pruebas en rojo y el tope de correcciones agotado).
 */
const proc = (status: string, result: any = null, extra: any = {}) => ({ status, result, steps: [], ...extra }) as any;
const applied = { branch: 'portal-ia/hu-1', commit: 'abc1234', worktree: 'x' };

test('HU-214 real: `done` + pipeline detenido por el tope de correcciones NO es «completado»: es «Detenido sin terminar» y espera al propietario', () => {
  const st = ownerProcessState(proc('done', { applied, pipeline: { state: 'stopped', pauseKind: 'limit', reason: 'test sigue fallando…' } }));
  assert.equal(st.key, 'stopped'); assert.equal(st.label, 'Detenido sin terminar');
  assert.equal(st.tone, 'err'); assert.equal(st.needsOwner, true); assert.equal(st.open, true);
});

test('verificado, integrado y sin verificar son estados distintos y se nombran distinto', () => {
  assert.equal(ownerProcessState(proc('done', { applied, pipeline: { state: 'verified' } })).key, 'ready_for_review');
  assert.equal(ownerProcessState(proc('done', { applied, pipeline: { state: 'verified' }, merged: { into: 'main', commit: 'def5678' } })).key, 'integrated');
  assert.equal(ownerProcessState(proc('done', { applied })).key, 'ended_unverified');
  assert.equal(ownerProcessState(proc('done', { applied, pipeline: { state: 'paused', pauseKind: 'budget' } })).key, 'needs_decision');
  // Integrada: una pausa anterior (el candidato antes de integrar) ya no es su estado.
  assert.equal(ownerProcessState(proc('done', { applied, pipeline: { state: 'paused', pauseKind: 'integration' }, merged: { into: 'main', commit: 'def5678' } })).key, 'integrated');
});

test('ningún estado usa la palabra «completado»; «listo para revisar» avisa de que aún no está en el proyecto', () => {
  const all = [
    proc('pending_authorization'), proc('running'), proc('running', null, { steps: [{ status: 'running', live: { state: 'queued' } }] }), proc('cancelled'), proc('failed'), proc('budget_exceeded'),
    proc('done'), proc('done', { applied }), proc('done', { applied, pipeline: { state: 'verified' } }), proc('done', { applied, pipeline: { state: 'stopped', pauseKind: 'no_changes' } }),
    proc('done', { applied, rejected: { at: 'x', reason: 'y' } }), proc('done', { applied }, { supersededBy: 'otro' })
  ].map(ownerProcessState);
  for (const st of all) assert.doesNotMatch(`${st.label} ${st.meaning}`, /completad/i, st.key);
  assert.deepEqual(all.map(s => s.key), ['needs_authorization', 'working', 'queued', 'cancelled', 'failed', 'failed', 'finished', 'ended_unverified', 'ready_for_review', 'no_changes', 'discarded', 'superseded']);
  assert.match(all[8].meaning, /aún no forma parte de tu proyecto/);
  assert.equal(all[2].key, 'queued'); assert.equal(all[10].key, 'discarded'); assert.equal(all[11].key, 'superseded');
});

test('solo lo que espera algo del propietario lo dice; lo que ya es historia no figura como abierto', () => {
  assert.equal(ownerProcessState(proc('running')).needsOwner, false);
  assert.equal(ownerProcessState(proc('pending_authorization')).needsOwner, true);
  assert.equal(ownerProcessState(proc('done', { applied, merged: { into: 'main', commit: 'c' } })).open, false);
  assert.equal(ownerProcessState(proc('cancelled')).open, false);
  assert.equal(ownerProcessState(proc('failed')).needsOwner, true);
});

test('(Gauntlet) integrada manda sobre un descarte posterior; verificado sin aplicar no es «terminado sin cambios»; lo terminado sin cambios no espera a nadie', () => {
  assert.equal(ownerProcessState(proc('done', { applied, merged: { into: 'main', commit: 'c' }, rejected: { at: 'x', reason: 'y' } })).key, 'integrated');
  const unapplied = ownerProcessState(proc('done', { pipeline: { state: 'verified' } }));
  assert.equal(unapplied.key, 'ended_unverified'); assert.equal(unapplied.needsOwner, true);
  const fin = ownerProcessState(proc('done'));
  assert.equal(fin.key, 'finished'); assert.equal(fin.needsOwner, false); assert.equal(fin.open, false);
  const noch = ownerProcessState(proc('done', { applied, pipeline: { state: 'stopped', pauseKind: 'no_changes' } }));
  assert.equal(noch.key, 'no_changes'); assert.equal(noch.needsOwner, true, 'el equipo dice que no hace falta cambiar nada: lo decides tu');
});

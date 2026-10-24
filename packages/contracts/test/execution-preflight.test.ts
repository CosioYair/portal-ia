import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionPreflightResultSchema, validate } from '../src/index.ts';

const checksOk = [
  { id: 'rama-actual', estado: 'ok', detalle: 'El Portal corre desde main.' },
  { id: 'main-actualizado', estado: 'ok', detalle: 'HEAD coincide con origin/main.' },
  { id: 'rama-por-defecto-remoto', estado: 'ok', detalle: 'La rama por defecto del remoto es main.' }
];

test('ExecutionPreflightResult: un resultado correcto sin motivo es válido', () => {
  assert.equal(
    validate(ExecutionPreflightResultSchema, { ok: true, checks: checksOk, motivo: null }).ok,
    true
  );
});

test('ExecutionPreflightResult: admite los tres estados y un motivo en español', () => {
  const checks = [
    { id: 'rama-actual', estado: 'fallo', detalle: 'El Portal corre desde «hu-1/x».' },
    { id: 'main-actualizado', estado: 'indeterminado', detalle: 'No se pudo leer origin/main.' },
    { id: 'rama-por-defecto-remoto', estado: 'ok', detalle: 'Es main.' }
  ];
  assert.equal(
    validate(ExecutionPreflightResultSchema, { ok: false, checks, motivo: 'Detenido: …' }).ok,
    true
  );
});

test('ExecutionPreflightResult: rechaza ids o estados desconocidos, campos extra y falta de motivo', () => {
  const base = { ok: false, checks: checksOk, motivo: 'x' };
  assert.equal(
    validate(ExecutionPreflightResultSchema, {
      ...base,
      checks: [{ id: 'otra', estado: 'ok', detalle: 'x' }]
    }).ok,
    false
  );
  assert.equal(
    validate(ExecutionPreflightResultSchema, {
      ...base,
      checks: [{ id: 'rama-actual', estado: 'quizá', detalle: 'x' }]
    }).ok,
    false
  );
  assert.equal(validate(ExecutionPreflightResultSchema, { ...base, extra: 1 }).ok, false);
  assert.equal(validate(ExecutionPreflightResultSchema, { ok: true, checks: checksOk }).ok, false);
  assert.equal(validate(ExecutionPreflightResultSchema, { ...base, checks: [] }).ok, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-mtf-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, manualTestStepKey, buildManualTestSteps, buildFailureBlock, countDoneManualSteps } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { projectsRepo } = await import('../src/db/workspace.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { createAssessment } = await import('../src/services/assessment.ts');
const { createDelegation } = await import('../src/services/delegation.ts');
const { manualTestStepsOf, closeManualTestFeedbackDbs } = await import('../src/services/manual-test-feedback.ts');
const { buildApp } = await import('../src/app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo('portal-ia').list()[0];
const procA = createAssessment('portal-ia', project.id);
const procB = createDelegation('portal-ia', project.id, undefined, 'Encargo de prueba para feedback');

const url = (pid: string, key?: string) => `/api/workspaces/portal-ia/processes/${pid}/manual-test-feedback${key ? `/${key}` : ''}`;

test('clave de paso: estable para el mismo texto y distinta si cambia el texto o la posición', () => {
  assert.equal(manualTestStepKey(0, 'Abre Backlog'), manualTestStepKey(0, 'Abre Backlog'));
  assert.notEqual(manualTestStepKey(0, 'Abre Backlog'), manualTestStepKey(0, 'Abre Equipo'));
  assert.notEqual(manualTestStepKey(0, 'Abre Backlog'), manualTestStepKey(1, 'Abre Backlog'));
  assert.match(manualTestStepKey(2, 'x'), /^[A-Za-z0-9_.-]{1,80}$/);
});

test('manualTestStepsOf: pasos con clave y sin prueba manual devuelve vacío', () => {
  assert.deepEqual(manualTestStepsOf({ result: null }), []);
  const steps = manualTestStepsOf({ result: { manualTest: { steps: ['Uno', 'Dos'], checks: [false, false], note: null } } as any });
  assert.equal(steps.length, 2);
  assert.equal(steps[1].index, 1);
  assert.equal(steps[1].stepKey, manualTestStepKey(1, 'Dos'));
});

test('PUT guarda y GET lo devuelve; un segundo PUT sobrescribe', async () => {
  const app = await buildApp();
  const put = await app.inject({ method: 'PUT', url: url(procA.id, 'p1-abc'), payload: { result: 'fail', comment: 'El botón no responde' } });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().item.result, 'fail');
  const get = await app.inject({ method: 'GET', url: url(procA.id) });
  assert.equal(get.statusCode, 200);
  const items = get.json().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].stepKey, 'p1-abc');
  assert.equal(items[0].result, 'fail');
  assert.equal(items[0].comment, 'El botón no responde');
  assert.ok(items[0].updatedAt);

  const again = await app.inject({ method: 'PUT', url: url(procA.id, 'p1-abc'), payload: { result: 'ok', comment: 'Ya funciona' } });
  assert.equal(again.statusCode, 200);
  const get2 = await app.inject({ method: 'GET', url: url(procA.id) });
  const items2 = get2.json().items;
  assert.equal(items2.length, 1, 'el segundo PUT sobrescribe, no duplica');
  assert.equal(items2[0].result, 'ok');
  assert.equal(items2[0].comment, 'Ya funciona');
  await app.close();
});

test('el feedback sigue disponible tras cerrar y reabrir la base y la app', async () => {
  const app1 = await buildApp();
  const put = await app1.inject({ method: 'PUT', url: url(procA.id, 'p2-xyz'), payload: { result: 'observation', comment: 'Texto cortado en móvil' } });
  assert.equal(put.statusCode, 200);
  await app1.close();
  closeManualTestFeedbackDbs();

  const app2 = await buildApp();
  const get = await app2.inject({ method: 'GET', url: url(procA.id) });
  assert.equal(get.statusCode, 200);
  const found = get.json().items.find((i: { stepKey: string }) => i.stepKey === 'p2-xyz');
  assert.ok(found, 'el feedback persiste en disco');
  assert.equal(found.result, 'observation');
  assert.equal(found.comment, 'Texto cortado en móvil');
  await app2.close();
});

test('validación: resultado inválido, comentario de más de 2000 caracteres y cuerpo incompleto dan 400', async () => {
  const app = await buildApp();
  const badResult = await app.inject({ method: 'PUT', url: url(procA.id, 'p3-bad'), payload: { result: 'meh', comment: '' } });
  assert.equal(badResult.statusCode, 400);
  const tooLong = await app.inject({ method: 'PUT', url: url(procA.id, 'p3-bad'), payload: { result: 'fail', comment: 'x'.repeat(2001) } });
  assert.equal(tooLong.statusCode, 400);
  const atLimit = await app.inject({ method: 'PUT', url: url(procA.id, 'p3-lim'), payload: { result: 'fail', comment: 'x'.repeat(2000) } });
  assert.equal(atLimit.statusCode, 200, '2000 caracteres es el máximo permitido');
  const missing = await app.inject({ method: 'PUT', url: url(procA.id, 'p3-bad'), payload: { comment: 'sin resultado' } });
  assert.equal(missing.statusCode, 400);
  const badKey = await app.inject({ method: 'PUT', url: url(procA.id, 'clave%20con%20espacios'), payload: { result: 'ok', comment: '' } });
  assert.equal(badKey.statusCode, 400);
  const get = await app.inject({ method: 'GET', url: url(procA.id) });
  assert.ok(!get.json().items.some((i: { stepKey: string }) => i.stepKey === 'p3-bad'), 'lo inválido no se guarda');
  await app.close();
});

test('un proceso o empresa inexistente da 404', async () => {
  const app = await buildApp();
  const get = await app.inject({ method: 'GET', url: url('no-existe') });
  assert.equal(get.statusCode, 404);
  const put = await app.inject({ method: 'PUT', url: url('no-existe', 'p1-abc'), payload: { result: 'ok', comment: '' } });
  assert.equal(put.statusCode, 404);
  const noWs = await app.inject({ method: 'GET', url: `/api/workspaces/empresa-fantasma/processes/${procA.id}/manual-test-feedback` });
  assert.equal(noWs.statusCode, 404);
  await app.close();
});

test('el feedback de un proceso no aparece en otro', async () => {
  const app = await buildApp();
  const put = await app.inject({ method: 'PUT', url: url(procB.id, 'p1-abc'), payload: { result: 'observation', comment: 'Solo del proceso B' } });
  assert.equal(put.statusCode, 200);
  const getB = await app.inject({ method: 'GET', url: url(procB.id) });
  assert.equal(getB.json().items.length, 1);
  assert.equal(getB.json().items[0].comment, 'Solo del proceso B');
  const getA = await app.inject({ method: 'GET', url: url(procA.id) });
  const a = getA.json().items.find((i: { stepKey: string }) => i.stepKey === 'p1-abc');
  assert.equal(a.comment, 'Ya funciona', 'el proceso A conserva su propio feedback');
  assert.ok(getA.json().items.every((i: { processId: string }) => i.processId === procA.id));
  await app.close();
});

test('resultado null con comentario vacío elimina la entrada; null con comentario la conserva', async () => {
  const app = await buildApp();
  await app.inject({ method: 'PUT', url: url(procA.id, 'p9-del'), payload: { result: 'fail', comment: 'temporal' } });
  const keep = await app.inject({ method: 'PUT', url: url(procA.id, 'p9-del'), payload: { result: null, comment: 'solo comentario' } });
  assert.equal(keep.statusCode, 200);
  assert.equal(keep.json().item.result, null);
  const mid = await app.inject({ method: 'GET', url: url(procA.id) });
  assert.ok(mid.json().items.some((i: { stepKey: string }) => i.stepKey === 'p9-del'));
  const del = await app.inject({ method: 'PUT', url: url(procA.id, 'p9-del'), payload: { result: null, comment: '' } });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().item, null);
  const end = await app.inject({ method: 'GET', url: url(procA.id) });
  assert.ok(!end.json().items.some((i: { stepKey: string }) => i.stepKey === 'p9-del'), 'la fila se borró');
  await app.close();
});

test('buildManualTestSteps: cada ítem lleva su propio estado y comentario, y OK cuenta como realizado', () => {
  const steps = ['Abre Backlog', 'Pulsa Ejecutar', 'Revisa el diff', 'Cierra'];
  const fb = [
    { stepKey: manualTestStepKey(0, steps[0]), result: 'ok' as const, comment: 'Bien' },
    { stepKey: manualTestStepKey(1, steps[1]), result: 'fail' as const, comment: 'No abre' },
    { stepKey: manualTestStepKey(2, steps[2]), result: 'observation' as const, comment: 'Lento' }
  ];
  const items = buildManualTestSteps(steps, fb, [false, true, true, false]);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(i => i.text), steps, 'el texto de cada paso va completo');
  assert.equal(items[0].result, 'ok');
  assert.equal(items[0].comment, 'Bien');
  assert.equal(items[0].done, true, 'OK implica realizado aunque la casilla no esté marcada');
  assert.equal(items[1].result, 'fail');
  assert.equal(items[1].comment, 'No abre');
  assert.equal(items[1].done, false, 'Falla explícita prevalece sobre la casilla antigua');
  assert.equal(items[2].result, 'observation');
  assert.equal(items[2].comment, 'Lento');
  assert.equal(items[3].result, null);
  assert.equal(items[3].comment, '');
  assert.equal(items[3].done, false);
  const legacy = buildManualTestSteps(['A', 'B'], [], [true, false]);
  assert.equal(legacy[0].done, true, 'sin feedback, la casilla antigua sigue contando');
  assert.equal(countDoneManualSteps(items), 1);
});

test('buildFailureBlock: agrupa solo los pasos en Falla, en orden y con su comentario', () => {
  const steps = ['Uno', 'Dos', 'Tres', 'Cuatro'];
  const fb = [
    { stepKey: manualTestStepKey(0, 'Uno'), result: 'ok' as const, comment: 'ok' },
    { stepKey: manualTestStepKey(1, 'Dos'), result: 'fail' as const, comment: 'rompe al guardar' },
    { stepKey: manualTestStepKey(2, 'Tres'), result: 'observation' as const, comment: 'solo una nota' },
    { stepKey: manualTestStepKey(3, 'Cuatro'), result: 'fail' as const, comment: '' }
  ];
  const block = buildFailureBlock(buildManualTestSteps(steps, fb));
  assert.equal(block, 'Pasos con falla (2):\n\n2. Dos\n   Comentario: rompe al guardar\n\n4. Cuatro\n   Comentario: (sin comentario)');
  assert.ok(!block.includes('solo una nota'));
  assert.equal(buildFailureBlock(buildManualTestSteps(steps, fb.filter(f => f.result !== 'fail'))), '', 'sin fallas, cadena vacía');
});

test('el feedback se guarda por paso y reaparece asociado a cada ítem al reabrir', async () => {
  const steps = ['Abre Backlog', 'Pulsa Ejecutar', 'Revisa el diff'];
  const keys = steps.map((t, i) => manualTestStepKey(i, t));
  const payloads = [
    { result: 'ok', comment: 'Bien' },
    { result: 'fail', comment: 'No abre el diálogo' },
    { result: 'observation', comment: 'Texto largo' }
  ];
  const app1 = await buildApp();
  for (let i = 0; i < steps.length; i++) {
    const put = await app1.inject({ method: 'PUT', url: url(procB.id, keys[i]), payload: payloads[i] });
    assert.equal(put.statusCode, 200);
  }
  await app1.close();
  closeManualTestFeedbackDbs();

  const app2 = await buildApp();
  const get = await app2.inject({ method: 'GET', url: url(procB.id) });
  assert.equal(get.statusCode, 200);
  const items = buildManualTestSteps(steps, get.json().items, [false, false, false]);
  assert.deepEqual(items.map(i => [i.result, i.comment]), [['ok', 'Bien'], ['fail', 'No abre el diálogo'], ['observation', 'Texto largo']]);
  assert.deepEqual(items.map(i => i.done), [true, false, false]);
  const block = buildFailureBlock(items);
  assert.ok(block.includes('No abre el diálogo'));
  assert.ok(!block.includes('Bien'));

  const invalid = await app2.inject({ method: 'PUT', url: url(procB.id, keys[0]), payload: { result: 'falla', comment: '' } });
  assert.equal(invalid.statusCode, 400, 'un estado fuera de ok|fail|observation se rechaza');
  const after = await app2.inject({ method: 'GET', url: url(procB.id) });
  assert.equal(buildManualTestSteps(steps, after.json().items)[0].result, 'ok', 'el rechazo no altera lo guardado');
  await app2.close();
});

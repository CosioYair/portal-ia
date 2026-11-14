import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Portal IA 3 · Recorrido de aceptación del propietario: lo marca ÉL (exige su sesión), un fallo exige decir qué falló,
 * lo marcado se conserva, y «aceptado» solo existe cuando todos los pasos están correctos. Cada paso apunta a una pantalla
 * que existe y nombra controles que existen en el código (un recorrido que manda a un botón inexistente no sirve).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3acc-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const { ACCEPTANCE_STEPS, acceptanceView } = await import('@portal-ia/domain');
const { buildApp: plain } = await import('../src/app.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const app = await buildApp();
after(async () => { await app.close(); });
const web = (rel: string) => fs.readFileSync(new URL(`../../web/src/${rel}`, import.meta.url), 'utf8');
const server = (rel: string) => fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

test('aceptado solo cuando TODOS los pasos están correctos; un fallo o un pendiente lo impiden', () => {
  const all = Object.fromEntries(ACCEPTANCE_STEPS.map(s => [s.id, { result: 'ok' as const, comment: '', at: 'x' }]));
  assert.equal(acceptanceView(all).summary.accepted, true);
  const first = ACCEPTANCE_STEPS[0]!.id;
  assert.equal(acceptanceView({ ...all, [first]: { result: 'fail', comment: 'no va', at: 'x' } }).summary.accepted, false);
  const { [first]: _gone, ...missing } = all;
  const v = acceptanceView(missing);
  assert.equal(v.summary.accepted, false); assert.equal(v.summary.pending, 1);
  assert.equal(acceptanceView({}).summary.pending, ACCEPTANCE_STEPS.length);
});

test('marcar exige la sesión del propietario; un fallo exige contar qué falló; lo marcado se conserva', async () => {
  const bare = await plain();
  const denied = await bare.inject({ method: 'PUT', url: `/api/acceptance/${ACCEPTANCE_STEPS[0]!.id}`, payload: { result: 'ok', comment: '' } });
  assert.ok(denied.statusCode === 401 || denied.statusCode === 403, `sin propietario: ${denied.statusCode}`);
  await bare.close();
  const id = ACCEPTANCE_STEPS[0]!.id; const id2 = ACCEPTANCE_STEPS[1]!.id;
  const noComment = await app.inject({ method: 'PUT', url: `/api/acceptance/${id}`, payload: { result: 'fail', comment: '   ' } });
  assert.equal(noComment.statusCode, 400); assert.equal(noComment.json().code, 'comment_required');
  const fail = await app.inject({ method: 'PUT', url: `/api/acceptance/${id}`, payload: { result: 'fail', comment: 'El botón no abre la historia.' } });
  assert.equal(fail.statusCode, 200); assert.equal(fail.json().summary.fail, 1);
  const ok = await app.inject({ method: 'PUT', url: `/api/acceptance/${id2}`, payload: { result: 'ok', comment: '' } });
  assert.equal(ok.json().summary.ok, 1); assert.equal(ok.json().summary.fail, 1, 'marcar otro paso no borra el anterior');
  const read = (await app.inject({ method: 'GET', url: '/api/acceptance' })).json();
  assert.equal(read.steps.find((s: any) => s.id === id).mark.comment, 'El botón no abre la historia.');
  assert.equal(read.summary.accepted, false);
  const cleared = await app.inject({ method: 'PUT', url: `/api/acceptance/${id}`, payload: { result: null, comment: '' } });
  assert.equal(cleared.json().summary.fail, 0);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/acceptance/no-existe', payload: { result: 'ok', comment: '' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/acceptance/${id}`, payload: { result: 'quizas' } })).statusCode, 400);
});

test('cada paso lleva a una pantalla que existe y nombra controles que existen en el código', () => {
  const appTsx = web('App.tsx');
  const sources = [
    web('screens/Work.tsx'), web('components/PortablePackage.tsx'), web('components/ReviewSummary.tsx'), web('components/IterationComposer.tsx'), web('components/ExternalAgent.tsx'),
    web('components/AgentPanel.tsx'), server('services/storyFlow.ts'), server('services/work.ts'), fs.readFileSync(new URL('../../../packages/domain/src/owner-state.ts', import.meta.url), 'utf8')
  ].join('\n');
  for (const s of ACCEPTANCE_STEPS) {
    const route = s.to.split('?')[0]!;
    assert.ok(appTsx.includes(`<Route path="${route}" `), `${s.id}: la ruta ${route} existe`);
    // Lo que va entre «» en las instrucciones y en lo esperado son textos de la interfaz: tienen que existir tal cual.
    for (const m of `${s.how.join(' ')} ${s.expect}`.matchAll(/«([^»]{4,80})»/g)) {
      const label = m[1]!;
      if (/^(completado|Hello|Hola)$/i.test(label)) continue; // palabras citadas, no controles
      assert.ok(sources.includes(label), `${s.id}: el recorrido nombra «${label}», que no existe en la interfaz`);
    }
  }
  assert.equal(new Set(ACCEPTANCE_STEPS.map(s => s.id)).size, ACCEPTANCE_STEPS.length, 'ids únicos');
});

test('(Gauntlet) una marca vale para el paso tal como estaba: si su texto cambia, vuelve a «sin probar»; quitar la marca no deja fecha', async () => {
  const { acceptanceStepSignature } = await import('@portal-ia/domain');
  const s = ACCEPTANCE_STEPS[2]!;
  const same = acceptanceView({ [s.id]: { result: 'ok', comment: 'bien', at: 'x', sig: acceptanceStepSignature(s) } });
  assert.equal(same.steps.find(x => x.id === s.id)!.mark.result, 'ok');
  const stale = acceptanceView({ [s.id]: { result: 'ok', comment: 'bien', at: 'x', sig: 'otra-huella' } });
  const m = stale.steps.find(x => x.id === s.id)!.mark;
  assert.equal(m.result, null, 'el paso cambió: hay que probarlo de nuevo'); assert.equal(m.comment, 'bien', 'el comentario se conserva');
  const put = await app.inject({ method: 'PUT', url: `/api/acceptance/${s.id}`, payload: { result: 'ok', comment: '' } });
  assert.ok(put.json().steps.find((x: any) => x.id === s.id).mark.at);
  const cleared = await app.inject({ method: 'PUT', url: `/api/acceptance/${s.id}`, payload: { result: null, comment: 'lo miro luego' } });
  const c = cleared.json().steps.find((x: any) => x.id === s.id).mark;
  assert.equal(c.result, null); assert.equal(c.at, null, 'sin marca no hay «marcado el…»'); assert.equal(c.comment, 'lo miro luego', 'un comentario sin marca también se guarda');
});

test('(Gauntlet) el recorrido no lleva datos de una instalación concreta ni promete un número de destinos', () => {
  const text = JSON.stringify(ACCEPTANCE_STEPS);
  assert.doesNotMatch(text, /\b(HU|EN)-\d{2,}/, 'sin códigos de historias o encargos concretos');
  assert.doesNotMatch(text, /cinco destinos|seis destinos/);
});

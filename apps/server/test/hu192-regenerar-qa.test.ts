import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * HU-192 · «Regenerar con QA» y presentación de los pasos (acción / «Esperado:»), con el proveedor SIMULADO (0 USD, sin red).
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu192-'));
process.env.PORTAL_DATA_DIR = path.join(TMP, 'data');
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.PORTAL_MOCK_SCRIPT = path.join(TMP, 'script.json');
process.env.PORTAL_MOCK_LOG = path.join(TMP, 'calls.jsonl');

const OUTSIDE = 'Abre el archivo apps/web/src/x.tsx en el editor. Esperado: se ve el cambio.';
const CLEAN = ['Abre Backlog y pulsa «Ejecutar». Esperado: se abre el diálogo con la estimación.', 'Pulsa «Autorizar». Esperado: la historia pasa a «En curso».'];
fs.writeFileSync(process.env.PORTAL_MOCK_SCRIPT, JSON.stringify({ markers: [OUTSIDE], rules: [{ match: '.', text: JSON.stringify({ steps: CLEAN, userFacing: 'Cambio visible en Backlog.' }) }] }));

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, splitManualStep, isOutsidePortalStep } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { REPO_ROOT } = await import('../src/config.ts');
const { generateManualTest, estimateManualTest } = await import('../src/services/storyExecution.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();

const ws = createCompany('Acme HU192'); const slug = ws.slug;
const calls = () => fs.existsSync(process.env.PORTAL_MOCK_LOG!) ? fs.readFileSync(process.env.PORTAL_MOCK_LOG!, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

function storyProcess(manualTest: any) {
  const project = createProject(slug, `Producto ${Math.random().toString(36).slice(2, 7)}`, 'x', []);
  projectsRepo(slug).setRepository(project.id, REPO_ROOT, 'main');
  const agents = agentsRepo(slug).list().filter(a => a.projectId === project.id);
  const by = (k: string) => agents.find(a => a.key === k)!;
  const procs = processesRepo(slug);
  const p = procs.create({ projectId: project.id, kind: 'story_execution', title: 'HU-192', estimatedUsd: 0.1, steps: [
    { agentId: by('pj-coordinador')?.id ?? 'c', agentName: 'Coord', title: 'Plan', model: 'claude-sonnet-4-5' },
    { agentId: by('pj-dev').id, agentName: 'Dev', title: 'Implementación', model: 'claude-sonnet-4-5' },
    { agentId: by('pj-qa').id, agentName: 'QA', title: 'Revisión de calidad', model: 'claude-sonnet-4-5' }] });
  procs.authorize(p.id, 1);
  procs.setResult(p.id, { plan: null, implementationSummary: 'x', changes: [], verifyCommands: [], review: null, applied: null, verifications: [], manualTest });
  procs.finish(p.id, 'done');
  return p.id;
}
const reviewed = (steps: string[]) => storyProcess({ steps, checks: steps.map(() => true), note: null, reviewedBy: 'qa' });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => { assert.equal(e.statusCode, 409); assert.equal(e.code, code); return true; });
}

test('splitManualStep: acción sin punto final y «Esperado:» sin distinguir mayúsculas ni acentos', () => {
  assert.deepEqual(splitManualStep('Abre Backlog. Esperado: se ve la lista.'), { action: 'Abre Backlog', expected: 'se ve la lista.' });
  assert.deepEqual(splitManualStep('Pulsa «Guardar». ESPERADO: aparece el aviso'), { action: 'Pulsa «Guardar»', expected: 'aparece el aviso' });
  assert.deepEqual(splitManualStep('Abre Ajustes. ÉSPERADÓ : el panel'), { action: 'Abre Ajustes', expected: 'el panel' });
  assert.deepEqual(splitManualStep('Abre A. Esperado: uno. Esperado: dos'), { action: 'Abre A', expected: 'uno. Esperado: dos' });
  const none = splitManualStep('  Abre Backlog.  ');
  assert.equal(none.expected, null); assert.equal(none.action, 'Abre Backlog.');
  assert.equal(splitManualStep('Pasa algo inesperado: nada').expected, null, '«inesperado:» no es el marcador');
});

test('regenerar: lista revisada por QA con un paso marcado → QA lo recibe y la nueva lista no tiene pasos marcados', async () => {
  const id = reviewed([OUTSIDE, CLEAN[0]]);
  const before = calls().length;
  const p = await generateManualTest(slug, id, () => {}, { regenerate: true });
  const all = calls(); assert.equal(all.length, before + 1, 'una sola llamada a la IA');
  assert.ok(all.at(-1).markers.includes(OUTSIDE), 'el prompt de QA incluye el paso marcado');
  const mt = p.result!.manualTest!;
  assert.deepEqual(mt.steps, CLEAN); assert.equal(mt.reviewedBy, 'qa');
  assert.deepEqual(mt.checks, [false, false], 'las marcas se reinician');
  assert.ok(!mt.steps.some(s => isOutsidePortalStep(s)), 'sin pasos fuera del Portal');
});

test('regenerar sin pasos marcados → 409 manual_test_nothing_to_regenerate y sin IA', async () => {
  const id = reviewed(CLEAN);
  const before = calls().length;
  await rejects(generateManualTest(slug, id, () => {}, { regenerate: true }), 'manual_test_nothing_to_regenerate');
  assert.equal(calls().length, before);
});

test('sin regenerate: una lista revisada por QA sigue dando 409 manual_test_already_reviewed', async () => {
  const id = reviewed([OUTSIDE]);
  const before = calls().length;
  await rejects(generateManualTest(slug, id, () => {}), 'manual_test_already_reviewed');
  await rejects(generateManualTest(slug, id, () => {}, { regenerate: false }), 'manual_test_already_reviewed');
  assert.equal(calls().length, before);
});

test('estimateManualTest funciona sobre una lista ya revisada por QA', () => {
  const est = estimateManualTest(slug, reviewed([OUTSIDE]));
  assert.ok(est.agentName); assert.ok(est.model);
  assert.ok(Number.isFinite(est.estimatedUsd) && est.estimatedUsd >= 0);
});

test('ruta: sin autorización no se llama a la IA; regenerate inválido se rechaza', async () => {
  const id = reviewed([OUTSIDE]);
  const app = await buildApp();
  const url = `/api/workspaces/${slug}/processes/${id}/manual-test/generate`;
  const before = calls().length;
  const a = await app.inject({ method: 'POST', url, payload: { regenerate: true } });
  assert.ok(a.statusCode >= 400, a.body);
  const b = await app.inject({ method: 'POST', url, payload: { authorized: true, regenerate: 'sí' } });
  assert.ok(b.statusCode >= 400, b.body);
  assert.equal(calls().length, before, 'sin autorización válida no hay llamada');
  assert.equal(processesRepo(slug).get(id)!.result!.manualTest!.steps[0], OUTSIDE);
  await app.close();
});

test('cableado de la interfaz: aviso, «Esperado:», botón con autorización y regenerate: true', () => {
  const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8').replace(/\r\n/g, '\n');
  const list = read('apps/web/src/components/ManualTestStepList.tsx');
  assert.ok(list.includes('Este paso sale del Portal'));
  assert.match(list, /role="note"/);
  assert.match(list, /aria-hidden="true">⚠/);
  assert.ok(list.includes('mts-expected') && list.includes('Esperado:'));
  assert.ok(list.includes('splitManualStep(') && /<strong[^>]*>\{parts\.action\}/.test(list));
  assert.ok(list.includes('regenerateAction') && list.includes('outsidePortal'));
  assert.ok(!list.includes('type="checkbox"'), 'la casilla no va dentro de la lista');
  const ov = read('apps/web/src/components/StoryOverview.tsx');
  assert.ok(ov.includes('Regenerar con QA'));
  assert.match(ov, /type="checkbox" checked=\{regenAuth\}/);
  assert.match(ov, /disabled=\{!regenAuth/);
  assert.ok(ov.includes('regenerate: true') && ov.includes('isOutsidePortalStep'));
  assert.ok(ov.includes('regenerateAction'));
  assert.ok(read('apps/web/src/lib/api.ts').includes('regenerate: true'));
  const css = read('apps/web/src/manual-test-feedback.css');
  assert.ok(css.includes('.mts-expected') && css.includes('.mts-outside'));
});

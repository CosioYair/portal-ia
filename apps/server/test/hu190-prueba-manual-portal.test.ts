import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * HU-190 · Prueba manual en proyectos del Portal frente a externos, con el proveedor SIMULADO (0 USD, sin red).
 * El prompt que recibe QA se comprueba con los marcadores que registra el simulador en PORTAL_MOCK_LOG.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu190-'));
process.env.PORTAL_DATA_DIR = path.join(TMP, 'data');
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.PORTAL_MOCK_SCRIPT = path.join(TMP, 'script.json');
process.env.PORTAL_MOCK_LOG = path.join(TMP, 'calls.jsonl');

const DEV_STEP = 'Abre el archivo apps/web/src/x.tsx en el editor y ejecuta npm test';
const QA_STEPS = ['Abre Backlog y pulsa «Ejecutar» en una historia. Esperado: se abre el diálogo con la estimación.', 'Pulsa «Autorizar». Esperado: la historia pasa a «En curso».'];
const MARKERS = ['Pasos de prueba manual propuestos por el Desarrollador', 'REGLAS DE LA PRUEBA MANUAL', DEV_STEP];
fs.writeFileSync(process.env.PORTAL_MOCK_SCRIPT, JSON.stringify({ markers: MARKERS, rules: [{ match: '.', text: JSON.stringify({ steps: QA_STEPS, userFacing: 'Cambio visible en Backlog.' }) }] }));

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { REPO_ROOT } = await import('../src/config.ts');
const { generateManualTest, isPortalRuntime, createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { buildManualTestQaPrompt, manualTestFormatFor, PORTAL_MANUAL_TEST_RULES, FILE_FORMAT } = await import('../src/services/storyPrompts.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();

const ws = createCompany('Acme HU190'); const slug = ws.slug;
const lastCall = () => JSON.parse(fs.readFileSync(process.env.PORTAL_MOCK_LOG!, 'utf8').trim().split('\n').at(-1)!);

function storyProcess(repoPath: string, manualTest: any) {
  const project = createProject(slug, `Producto ${Math.random().toString(36).slice(2, 7)}`, 'x', []);
  projectsRepo(slug).setRepository(project.id, repoPath, 'main');
  const agents = agentsRepo(slug).list().filter(a => a.projectId === project.id);
  const by = (k: string) => agents.find(a => a.key === k)!;
  const procs = processesRepo(slug);
  const p = procs.create({ projectId: project.id, kind: 'story_execution', title: 'HU-190', estimatedUsd: 0.1, steps: [
    { agentId: by('pj-coordinador')?.id ?? 'c', agentName: 'Coord', title: 'Plan', model: 'claude-sonnet-4-5' },
    { agentId: by('pj-dev').id, agentName: 'Dev', title: 'Implementación', model: 'claude-sonnet-4-5' },
    { agentId: by('pj-qa').id, agentName: 'QA', title: 'Revisión de calidad', model: 'claude-sonnet-4-5' }] });
  procs.authorize(p.id, 1);
  procs.setResult(p.id, { plan: null, implementationSummary: 'x', changes: [], verifyCommands: [], review: null, applied: null, verifications: [], manualTest });
  procs.finish(p.id, 'done');
  return p.id;
}

test('reglas del Portal: solo en proyectos del Portal y sin tocar FILE_FORMAT', () => {
  const portal = manualTestFormatFor(true);
  assert.ok(portal.includes(PORTAL_MANUAL_TEST_RULES));
  for (const w of ['PRUEBA MANUAL', 'PARA EL PROPIETARIO', 'terminal', 'editor', 'npm']) assert.ok(portal.includes(w), `falta «${w}»`);
  assert.equal(manualTestFormatFor(false), '');
  assert.ok(!FILE_FORMAT.includes('REGLAS DE LA PRUEBA MANUAL'), 'FILE_FORMAT no cambia');
});

test('prompt de QA: externo idéntico al de siempre; Portal con pasos del Desarrollador y reglas', () => {
  const base = 'Redacta la prueba manual de la historia.\n# Diffs\n+x';
  assert.equal(buildManualTestQaPrompt({ portal: false, base, devSteps: [DEV_STEP] }), base);
  const p = buildManualTestQaPrompt({ portal: true, base, devSteps: [DEV_STEP] });
  assert.ok(p.startsWith(base)); assert.ok(p.includes(`1. ${DEV_STEP}`)); assert.ok(p.includes(PORTAL_MANUAL_TEST_RULES));
  assert.match(buildManualTestQaPrompt({ portal: true, base, devSteps: [] }), /no propuso pasos/);
});

test('isPortalRuntime: misma carpeta que REPO_ROOT (también con otra capitalización); otra carpeta no', () => {
  assert.equal(isPortalRuntime(REPO_ROOT), true);
  assert.equal(isPortalRuntime(REPO_ROOT.toUpperCase()), true);
  assert.equal(isPortalRuntime(TMP), false);
  assert.equal(isPortalRuntime(null), false);
});

test('Portal: QA recibe los pasos del Desarrollador y las reglas; se guarda su lista con reviewedBy qa y note null', async () => {
  const id = storyProcess(REPO_ROOT, { steps: [DEV_STEP], checks: [false], note: null });
  const p = await generateManualTest(slug, id, () => {});
  const call = lastCall();
  for (const m of MARKERS) assert.ok(call.markers.includes(m), `el prompt de QA no contiene «${m}»`);
  const mt = p.result!.manualTest!;
  assert.deepEqual(mt.steps, QA_STEPS); assert.equal(mt.reviewedBy, 'qa'); assert.equal(mt.note, null);
  assert.deepEqual(mt.checks, [false, false]);
  assert.ok(!mt.steps.some(s => /\.tsx?\b|npm|terminal|editor/i.test(s)));
});

test('externo: el prompt de QA no lleva pasos ni reglas; note null y sin reviewedBy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu190-repo-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: dir });
  const id = storyProcess(dir, null);
  const p = await generateManualTest(slug, id, () => {});
  assert.deepEqual(lastCall().markers, []);
  const mt = p.result!.manualTest!;
  assert.deepEqual(mt.steps, QA_STEPS); assert.equal(mt.note, null); assert.equal(mt.reviewedBy ?? null, null);
  assert.ok(!('reviewedBy' in mt), 'en externos no aparece el campo');
});

test('ruta manual-test: marcas y nota conservan reviewedBy; reescribir los pasos lo borra', async () => {
  const id = storyProcess(REPO_ROOT, { steps: QA_STEPS, checks: [false, false], note: null, reviewedBy: 'qa' });
  const app = await buildApp();
  const post = (payload: any) => app.inject({ method: 'POST', url: `/api/workspaces/${slug}/processes/${id}/manual-test`, payload });
  const a = await post({ checks: [true, false], note: 'visto' }); assert.equal(a.statusCode, 200, a.body);
  let mt = processesRepo(slug).get(id)!.result!.manualTest!;
  assert.equal(mt.reviewedBy, 'qa'); assert.equal(mt.note, 'visto'); assert.deepEqual(mt.checks, [true, false]);
  const b = await post({ steps: ['Abre Backlog. Esperado: se ve la lista.'] }); assert.equal(b.statusCode, 200, b.body);
  mt = processesRepo(slug).get(id)!.result!.manualTest!;
  assert.equal(mt.reviewedBy, null); assert.deepEqual(mt.checks, [false]);
  // Datos antiguos (sin el campo): siguen sin él al marcar.
  const old = storyProcess(REPO_ROOT, { steps: ['Abre Backlog. Esperado: lista.'], checks: [false], note: null });
  const c = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/processes/${old}/manual-test`, payload: { checks: [true] } });
  assert.equal(c.statusCode, 200, c.body);
  assert.ok(!('reviewedBy' in processesRepo(slug).get(old)!.result!.manualTest!));
  await app.close();
});

test('prompt real del Desarrollador: lleva las reglas en el Portal y no en un proyecto externo', async () => {
  const PLAN = JSON.stringify({ summary: 'Nota HU-190', tasks: ['Crear hu190-nota.txt'], filesToRead: [], filesToChange: ['hu190-nota.txt'], acceptance: ['existe la nota'], risks: [] });
  const IMPL = '=== RESUMEN ===\nAñade una nota.\n=== ARCHIVO: hu190-nota.txt | create ===\nnota\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nSin cambios visibles.\n=== PRUEBA MANUAL ===\n1. Abre Backlog. Esperado: se ve la lista.\n2. Pulsa «Ejecutar». Esperado: se abre el diálogo.\n=== VERIFICAR: typecheck ===';
  fs.writeFileSync(process.env.PORTAL_MOCK_SCRIPT!, JSON.stringify({ markers: ['REGLAS DE LA PRUEBA MANUAL', '=== PRUEBA MANUAL ==='], rules: [
    { match: 'plan técnico', text: PLAN },
    { match: 'Implementa la historia', text: IMPL },
    { match: 'Revisa los cambios propuestos', text: JSON.stringify({ approve: true, summary: 'Bien', issues: [], suggestedTests: [] }) },
    { match: '.', text: JSON.stringify({ steps: QA_STEPS, userFacing: 'x' }) }] }));
  const devCall = async (repoPath: string) => {
    const project = createProject(slug, `Dev ${Math.random().toString(36).slice(2, 7)}`, 'x', []);
    projectsRepo(slug).setRepository(project.id, repoPath, 'main');
    const it = addManualItem(slug, project.id, { title: 'Nota HU-190', criterion: 'existe la nota' });
    const p = createStoryProcess(slug, project.id, it.id);
    processesRepo(slug).authorize(p.id, 1);
    fs.writeFileSync(process.env.PORTAL_MOCK_LOG!, '');
    await runStory(slug, p.id, () => undefined, () => false).catch(() => undefined);
    const calls = fs.readFileSync(process.env.PORTAL_MOCK_LOG!, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const dev = calls.find(c => c.rule === 'Implementa la historia');
    assert.ok(dev, `no hubo llamada del Desarrollador (${calls.map(c => c.rule).join(', ')})`);
    return dev;
  };
  const portal = await devCall(REPO_ROOT);
  assert.ok(portal.markers.includes('=== PRUEBA MANUAL ==='), 'el Desarrollador recibe FILE_FORMAT');
  assert.ok(portal.markers.includes('REGLAS DE LA PRUEBA MANUAL'), 'en el Portal el prompt del Desarrollador lleva las reglas');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu190-dev-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: dir });
  const ext = await devCall(dir);
  assert.ok(ext.markers.includes('=== PRUEBA MANUAL ==='), 'el Desarrollador recibe FILE_FORMAT');
  assert.ok(!ext.markers.includes('REGLAS DE LA PRUEBA MANUAL'), 'en un proyecto externo el prompt del Desarrollador no cambia');
});

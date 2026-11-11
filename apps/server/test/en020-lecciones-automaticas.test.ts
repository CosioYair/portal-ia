import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * EN-020 · Las lecciones aplicadas llegan solas a la plantilla de su papel, a los agentes existentes y a todo su trabajo.
 * Proveedor simulado (0 USD), espacio y repositorio temporales. Las pruebas comparten estado y van en orden:
 * migración (j/e) → vuelta atrás (f) → Curador y validateLesson (a/i) → prompt sin duplicados (b) → retirada y refutación (c)
 * → edición (d) → sin tope (g) → chat y encargos (h).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en020-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, DEFAULT_PIPELINE, normalizePipeline } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess } = await import('../src/services/storyExecution.ts');
const { newPipeline } = await import('../src/services/storyPipeline.ts');
const L = await import('../src/services/lessons.ts');
const { curatePending, LESSON_CATALOG } = await import('../src/services/lessonCurator.ts');
const { isPinned, practicesFor, setAgentTemplateVersion, templatesRepo } = await import('../src/services/agentTemplates.ts');
const { lessonTemplateReach, syncLessonPractices } = await import('../src/services/lessonPractices.ts');

const S = 'portal-ia';
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const project = projectsRepo(S).list()[0];
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en020-repo-'));
fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoDir, 'src/a.ts'), 'export const a = 1;\n');
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repoDir });
projectsRepo(S).setRepository(project.id, repoDir, 'main');

const dev = () => agentsRepo(S).list().find(a => a.key === 'pj-dev' && a.projectId === project.id)!;
const DEV_ID = dev().id;
const tpl = () => templatesRepo(S).latest('pj-dev')!;
const texts = () => tpl().practices.map(p => p.text);
const lastHist = (id: string) => templatesRepo(S).history(id).at(-1)!;
const occ = (s: string, t: string) => s.split(t).length - 1;
const EV = { processId: null, processTitle: null, stepId: null, agentId: null, agentName: null, file: null, detail: 'sintética', at: new Date().toISOString() };
function mk(title: string, text: string | null, extra: any = {}) {
  return L.lessonsRepo(S).insert({ projectId: project.id, role: 'implementer', tags: [], status: 'validated', version: 1, parentId: null, title, detector: 'manual', evidence: EV, rootCause: null, correctiveAction: null, lessonText: text, source: 'owner', promotedTo: null, dedupeKey: null, ...extra } as any)!;
}
let n = 0;
function story() {
  const it = addManualItem(S, project.id, { title: `EN-020 · historia ${++n}`, criterion: 'a vale 2' });
  const p = createStoryProcess(S, project.id, it.id);
  processesRepo(S).setResult(p.id, { ...p.result!, pipeline: newPipeline(normalizePipeline({ ...DEFAULT_PIPELINE })) });
  return processesRepo(S).get(p.id)!;
}
/** Prompt de sistema del paso del implementador de una historia nueva, con las prácticas del Desarrollador existente. */
function devPrompt() {
  const p = story(); const st = p.steps.find(s => s.role === 'implementer')!;
  const r = L.injectLessons(S, st.id, 'SISTEMA', { projectId: project.id, role: 'implementer' }, practicesFor(S, dev()));
  return { ...r, processId: p.id, stepId: st.id };
}

const A_TXT = 'Lección A ya promovida a pj-dev@2: revisa el plan antes de editar.';
const B_TXT = 'Lección B ya promovida a pj-dev@3: entrega parches pequeños.';
const C_TXT = 'Lección C aplicada sin promover: importa cada módulo nuevo.';
const MANUAL_TXT = 'Práctica manual del propietario: nombra los archivos en español.';
const MEM_TXT = 'Memoria de un solo agente: nunca debe llegar a una plantilla.';
const D_TXT = 'Lección D escrita a mano con el agente fijado.';
const G_TXT = 'Lección sin papel: aplica a todos los prompts del proyecto.';
const R_TXT = 'Lección R que acabará refutada por reincidir dos veces.';
const C2_TXT = 'Lección C editada: importa y usa cada módulo nuevo en el mismo cambio.';
const MANUAL_P: any = { lessonId: null, text: MANUAL_TXT, title: 'Práctica manual', addedAt: new Date().toISOString() };
let A: any, B: any, C: any, D: any, G: any, CUR: any;

test('j/e · migración: no duplica pj-dev@2/@3, conserva la práctica manual, mueve también al agente fijado (by portal) y la segunda ejecución no hace nada', () => {
  const t = templatesRepo(S); const v1 = t.latest('pj-dev')!; assert.equal(v1.version, 1);
  A = mk('A', A_TXT); B = mk('B', B_TXT); C = mk('C', C_TXT);
  mk('Memoria', MEM_TXT, { agentId: DEV_ID });
  const ts = new Date().toISOString();
  const pA = { lessonId: A.id, text: A_TXT, title: 'A', addedAt: ts }; const pB = { lessonId: B.id, text: B_TXT, title: 'B', addedAt: ts };
  const base = { key: 'pj-dev', name: v1.name, role: v1.role, responsibilities: v1.responsibilities, diffMd: '+', source: 'promotion', createdBy: 'owner' };
  t.insert({ ...base, version: 2, practices: [pA], lessonId: A.id } as any);
  t.insert({ ...base, version: 3, practices: [pA, MANUAL_P, pB], lessonId: B.id } as any);
  L.lessonsRepo(S).update(A.id, { promotedTo: 'pj-dev@2' }); L.lessonsRepo(S).update(B.id, { promotedTo: 'pj-dev@3' });
  // Agente fijado antes de la migración: el propietario lo devolvió de @3 a @2
  t.setAgentVersion(DEV_ID, null, 'pj-dev@3', 'owner'); t.setAgentVersion(DEV_ID, 'pj-dev@3', 'pj-dev@2', 'owner');
  assert.equal(isPinned(S, DEV_ID), true);

  const r1 = syncLessonPractices(S, { migration: true });
  assert.equal(r1.migration, true); assert.ok(r1.created.includes('pj-dev@4'), r1.created.join(','));
  assert.equal(tpl().version, 4);
  assert.deepEqual(texts(), [A_TXT, MANUAL_TXT, B_TXT, C_TXT], 'sin duplicar A ni B; la manual intacta y en su sitio; C al final');
  assert.deepEqual(tpl().practices[1], MANUAL_P);
  assert.ok(!texts().includes(MEM_TXT), 'la memoria de un agente nunca llega a la plantilla');
  assert.equal(L.lessonsRepo(S).get(C.id)!.promotedTo, 'pj-dev@4');
  assert.equal(dev().templateVersion, 'pj-dev@4', 'el agente fijado también pasa a la última en la primera migración');
  assert.deepEqual([lastHist(DEV_ID).fromVersion, lastHist(DEV_ID).toVersion, lastHist(DEV_ID).by], ['pj-dev@2', 'pj-dev@4', 'portal']);

  const versions = templatesRepo(S).keys().reduce((s, k) => s + k.versions, 0); const hist = templatesRepo(S).history(DEV_ID).length;
  const r2 = syncLessonPractices(S, { migration: true });
  assert.equal(r2.migration, false); assert.deepEqual(r2.created, []); assert.deepEqual(r2.moved, []);
  assert.equal(templatesRepo(S).keys().reduce((s, k) => s + k.versions, 0), versions, 'sin versiones nuevas');
  assert.equal(templatesRepo(S).history(DEV_ID).length, hist, 'sin entradas de historial nuevas');
});

test('f · la vuelta atrás del propietario posterior a la migración no se pisa ni en la siguiente sincronización ni en un nuevo arranque', () => {
  setAgentTemplateVersion(S, DEV_ID, 'pj-dev@3');
  assert.equal(isPinned(S, DEV_ID), true);
  D = L.createManualLesson(S, { projectId: project.id, title: 'D', lessonText: D_TXT, role: 'implementer' });
  assert.equal(tpl().version, 5); assert.ok(texts().includes(D_TXT), 'createManualLesson la añade sola');
  assert.equal(dev().templateVersion, 'pj-dev@3', 'fijado: no se mueve solo');
  syncLessonPractices(S, { migration: true }); // nuevo arranque con la marca puesta
  assert.equal(dev().templateVersion, 'pj-dev@3');
  setAgentTemplateVersion(S, DEV_ID, 'pj-dev@5'); // «Actualizar» del propietario
  assert.equal(isPinned(S, DEV_ID), false);
  const reach = lessonTemplateReach(S)[D.id];
  assert.equal(reach.templateVersion, 'pj-dev@5'); assert.ok(reach.agents >= 1);
});

test('a/i · el Curador y validateLesson aplican y la lección llega sola al implementador existente (by portal); la práctica manual se conserva', () => {
  L.lessonsRepo(S).insert({ projectId: project.id, role: 'implementer', tags: ['patch', 'implementar'], status: 'detected', version: 1, parentId: null, title: 'Parche que no encaja', detector: 'patch_mismatch', evidence: { ...EV, processId: 'p-en020-a', file: 'src/a.ts' }, rootCause: null, correctiveAction: null, lessonText: null, source: 'detector', promotedTo: null, dedupeKey: 'p-en020-a:patch_mismatch:src/a.ts' } as any);
  const s = curatePending(S, { projectId: project.id, by: 'owner' });
  assert.equal(s.applied, 1);
  CUR = L.lessonsRepo(S).list(project.id, 'validated').find(l => l.detector === 'patch_mismatch' && l.source === 'curator')!;
  assert.equal(CUR.lessonText, LESSON_CATALOG.patch_mismatch.text);
  assert.ok(tpl().practices.some(p => p.lessonId === CUR.id), 'en la última pj-dev sin promover');
  assert.equal(dev().templateVersion, tpl().id); assert.equal(lastHist(DEV_ID).by, 'portal');
  assert.deepEqual(tpl().practices[1], MANUAL_P, 'la manual sigue intacta y en su posición al añadir');
  const prop = mk('Propuesta', 'Lección propuesta que valida el propietario a mano.', { status: 'proposed' });
  const before = tpl().version;
  L.validateLesson(S, prop.id);
  assert.equal(tpl().version, before + 1); assert.ok(tpl().practices.some(p => p.lessonId === prop.id));
  assert.equal(dev().templateVersion, tpl().id); assert.equal(lastHist(DEV_ID).by, 'portal');
});

test('b · el prompt del paso del implementador lleva cada texto una sola vez (práctica o lección, nunca ambas)', () => {
  const v = tpl().version;
  G = L.createManualLesson(S, { projectId: project.id, title: 'G', lessonText: G_TXT, role: null });
  L.createManualLesson(S, { projectId: project.id, title: 'Dup', lessonText: D_TXT, role: null }); // mismo texto que una práctica
  assert.equal(tpl().version, v, 'sin papel: no toca la plantilla');
  const r = devPrompt();
  assert.equal(occ(r.system, LESSON_CATALOG.patch_mismatch.text), 1);
  assert.equal(occ(r.system, D_TXT), 1, 'el texto ya va como práctica: no se repite');
  assert.equal(occ(r.system, G_TXT), 1);
  assert.ok(r.used.includes(`practice:${tpl().id}:${CUR.id}`)); assert.ok(!r.used.includes(CUR.id));
  assert.ok(r.used.includes(G.id));
  assert.deepEqual(processesRepo(S).get(r.processId)!.steps.find(s => s.id === r.stepId)!.lessonsUsed, r.used);
});

test('c · obsoleta y refutada salen de la plantilla en una versión nueva que el agente adopta solo; la manual se conserva', () => {
  L.setLessonStatus(S, D.id, 'obsolete');
  assert.ok(!tpl().practices.some(p => p.lessonId === D.id)); assert.equal(dev().templateVersion, tpl().id);
  assert.deepEqual(tpl().practices[1], MANUAL_P, 'la manual sigue intacta al retirar');
  const R = L.createManualLesson(S, { projectId: project.id, title: 'R', lessonText: R_TXT, role: 'implementer', tags: ['agent_blocked'] });
  const pid = practicesFor(S, dev()).find(p => p.text === R_TXT)!.id;
  const recur = () => {
    const p = story(); const st = p.steps.find(s => s.role === 'implementer')!;
    processesRepo(S).setStepLessons(st.id, [pid]);
    const cur = processesRepo(S).get(p.id)!;
    processesRepo(S).setResult(p.id, { ...cur.result!, pipeline: { ...cur.result!.pipeline!, state: 'verified' }, failure: { class: 'MISSING_INFORMATION', detail: 'Le faltaba un dato.' } } as any);
    processesRepo(S).finish(p.id, 'done');
    return L.recordLessonOutcomes(S, p.id, repoDir);
  };
  recur(); const out = recur();
  assert.ok(out.refuted.includes(R.id), 'la práctica también cuenta como lección usada'); assert.equal(L.lessonsRepo(S).get(R.id)!.status, 'refuted');
  assert.ok(!tpl().practices.some(p => p.lessonId === R.id)); assert.equal(dev().templateVersion, tpl().id);
  const r = devPrompt();
  assert.equal(occ(r.system, R_TXT), 0); assert.equal(occ(r.system, 'Lección D escrita a mano'), 1, 'D solo por la lección sin papel de igual texto');
});

test('d · editar una lección sustituye su texto en su posición, en una sola versión nueva', () => {
  const prev = tpl(); const idx = prev.practices.findIndex(p => p.lessonId === C.id);
  const child = L.validateLesson(S, C.id, { lessonText: C2_TXT });
  assert.equal(tpl().version, prev.version + 1);
  assert.equal(tpl().practices[idx].lessonId, child.id); assert.equal(tpl().practices[idx].text, C2_TXT);
  assert.ok(!texts().includes(C_TXT)); assert.ok(!tpl().practices.some(p => p.lessonId === C.id));
  assert.equal(dev().templateVersion, tpl().id);
  assert.equal(occ(devPrompt().system, C2_TXT), 1);
});

test('g · sin tope de 8: llegan todas las lecciones aplicadas del papel', () => {
  const qs = Array.from({ length: 10 }, (_, i) => `Práctica de revisión número ${i + 1}: comprueba la evidencia.`);
  for (const [i, t] of qs.entries()) L.createManualLesson(S, { projectId: project.id, title: `Q${i}`, lessonText: t, role: 'reviewer' });
  assert.ok(L.lessonsFor(S, { projectId: project.id, role: 'reviewer' }).length >= 10);
  const qa = agentsRepo(S).list().find(a => a.key === 'pj-qa' && a.projectId === project.id);
  const st = story().steps[0];
  const r = L.injectLessons(S, st.id, 'SISTEMA', { projectId: project.id, role: 'reviewer' }, qa ? practicesFor(S, qa) : []);
  for (const t of qs) assert.equal(occ(r.system, t), 1, t);
});

test('h · el chat y los análisis delegados reciben lecciones y prácticas del papel y registran cuáles se usaron', () => {
  const c = L.buildLessonContext(S, { projectId: project.id, role: 'implementer', agent: dev() });
  assert.equal(occ(c.block, LESSON_CATALOG.patch_mismatch.text), 1); assert.equal(occ(c.block, G_TXT), 1);
  assert.ok(c.used.includes(`practice:${tpl().id}:${CUR.id}`)); assert.ok(c.used.includes(G.id));
  const src = (f: string) => fs.readFileSync(fileURLToPath(new URL(`../src/services/${f}`, import.meta.url)), 'utf8');
  const chat = src('agentChat.ts'); const del = src('delegation.ts');
  assert.ok(chat.includes('buildLessonContext(') && chat.includes('lessonsUsed'), 'el chat inyecta y guarda lessonsUsed en el mensaje');
  assert.ok(del.includes('buildLessonContext(') && del.includes('setStepLessons(step.id, lc.used)'), 'el encargo inyecta y registra en el paso');
});

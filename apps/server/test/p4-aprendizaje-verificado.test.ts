import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Portal IA 4 · Aprendizaje VERIFICADO. La queja del propietario: las lecciones figuraban como usadas muchas veces y
 * «aprendidas», y los errores seguían ocurriendo. Causa: bastaba con que una tarea cualquiera que llevase la lección
 * terminara bien, aunque nunca hubiese tocado nada parecido. Ahora una lección solo cuenta como aprendida cuando una
 * tarea posterior que tocó la MISMA zona del código terminó verificada sin repetir el error. Sin IA.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p4apr-'));
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const { INTERNAL_WORKSPACE, classifyModel, lessonCardState } = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo, agentsRepo } = await import('../src/db/workspace.ts');
const { lessonExposure, lessonsRepo, recordLessonOutcomes, recordDetections } = await import('../src/services/lessons.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-5-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = INTERNAL_WORKSPACE.slug; const project = projectsRepo(S).list()[0];
const dev = agentsRepo(S).list().find(a => a.projectId === project.id) ?? agentsRepo(S).list()[0];

const TAP = (name: string) => `TAP version 13\nnot ok 1 - ${name}\n# fail 1\n`;
const V = (command: string, exitCode: number, output: string) => ({ command, exitCode, output, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });

/** La lección que dejó un fallo REAL: la prueba «suma devuelve 3» falló al cambiar src/calculo/suma.ts. */
function lessonFromFailure(): any {
  const repo = lessonsRepo(S);
  const l = repo.insert({ projectId: project.id, role: 'implementer', tags: ['verify', 'test', 'implementar', 'causa:test:suma devuelve 3'], status: 'validated', version: 1, parentId: null, title: 'La suma debe seguir devolviendo 3', detector: 'verification_failed',
    evidence: { processId: 'proc-origen', processTitle: 'Origen', stepId: null, agentId: null, agentName: null, file: 'src/calculo/suma.ts', detail: 'not ok 1 - suma devuelve 3', at: new Date().toISOString() },
    rootCause: 'Se cambió suma() sin ejecutar su prueba.', correctiveAction: null, lessonText: 'Al tocar src/calculo, ejecuta su prueba antes de entregar.', source: 'curator', promotedTo: null, dedupeKey: null } as any)!;
  return repo.update(l.id, { validatedAt: new Date().toISOString() })!;
}
/** Una tarea posterior que llevaba la lección, cambió `files` y terminó con ese resultado. */
function laterTask(lessonId: string, files: string[], o: { fails?: string; state?: string } = {}): string {
  const procs = processesRepo(S);
  const p = procs.create({ projectId: project.id, kind: 'story_execution', title: `Tarea sobre ${files.join(', ')}`, estimatedUsd: 0, steps: [{ agentId: dev.id, agentName: dev.config.name, title: 'Implementación', model: 'm', role: 'implementer' }] });
  procs.setStepLessons(procs.get(p.id)!.steps[0].id, [lessonId]);
  procs.setResult(p.id, { changes: files.map(f => ({ path: f, content: 'x' })), verifications: [o.fails ? V('test', 1, TAP(o.fails)) : V('test', 0, '# pass 12')], review: null, runtimeChecks: null, applied: true, pipeline: { state: o.state ?? 'verified', events: [] } } as any);
  procs.finish(p.id, 'done');
  return p.id;
}

test('qué cuenta como «tocar la misma zona»: el mismo archivo o su misma carpeta; nada más', () => {
  const l = { evidence: { file: 'src/calculo/suma.ts' } } as any;
  assert.equal(lessonExposure(l, ['src/calculo/suma.ts']), true);
  assert.equal(lessonExposure(l, ['src/calculo/resta.ts']), true, 'otro archivo de la misma carpeta');
  assert.equal(lessonExposure(l, ['src/calculo/interno/x.ts']), false, 'una subcarpeta es otra zona');
  assert.equal(lessonExposure(l, ['src/otra/cosa.ts', 'docs/leeme.md']), false);
  assert.equal(lessonExposure({ evidence: { file: null } } as any, ['src/calculo/suma.ts']), false, 'una lección sin archivo no se puede demostrar');
  assert.equal(lessonExposure({ evidence: { file: 'README.md' } } as any, ['docs/x.md']), false);
});

test('que la lección se haya entregado en muchas tareas ajenas NO la convierte en aprendida', () => {
  const L = lessonFromFailure();
  for (let i = 0; i < 5; i++) { const out = recordLessonOutcomes(S, laterTask(L.id, [`docs/pagina-${i}.md`]), null); assert.deepEqual(out.held, [L.id]); }
  const l = lessonsRepo(S).get(L.id)!; const card = lessonCardState(l);
  assert.equal(l.proof!.length, 5); assert.ok(l.proof!.every(p => p.result === 'held' && p.exposed === false));
  assert.equal(l.provenAt, null);
  assert.deepEqual([card.learned, card.provenTasks, card.unprovenTasks], [false, 0, 5], 'cinco usos sin exposición = pendiente de demostrar');
  assert.match(l.proof![0].detail, /no tocó la zona/);
});

test('una tarea nueva que toca la misma zona y termina bien SÍ la demuestra: aprendida', () => {
  const L = lessonFromFailure();
  recordLessonOutcomes(S, laterTask(L.id, ['docs/ajeno.md']), null);
  const out = recordLessonOutcomes(S, laterTask(L.id, ['src/calculo/suma.ts', 'src/calculo/suma.test.ts']), null);
  assert.deepEqual(out.held, [L.id]);
  const l = lessonsRepo(S).get(L.id)!; const card = lessonCardState(l);
  assert.equal(l.proof!.at(-1)!.exposed, true); assert.ok(l.provenAt, 'queda la fecha de la primera demostración');
  assert.deepEqual([card.learned, card.provenTasks, card.unprovenTasks], [true, 1, 1]);
});

test('si en esa misma zona el error vuelve a ocurrir y la tarea no termina bien, reincide y no cuenta como aprendida', () => {
  const L = lessonFromFailure();
  const pid = laterTask(L.id, ['src/calculo/suma.ts'], { fails: 'suma devuelve 3', state: 'stopped' });
  recordDetections(S, pid, null);
  const l = lessonsRepo(S).get(L.id)!; const card = lessonCardState(l);
  assert.equal(l.recurrenceCount, 1); assert.deepEqual([card.learned, card.recurrenceBadge, card.recurredTasks], [false, true, 1]);
  assert.equal(l.provenAt, null);
});

test('las pruebas antiguas (sin el dato de exposición) no cuentan como demostración: no se inventa mérito', () => {
  const card = lessonCardState({ status: 'validated', recurrenceCount: 0, recurrenceProcesses: [], proof: [{ processId: 'a', processTitle: null, result: 'held', detail: 'x', at: 'x' }, { processId: 'b', processTitle: null, result: 'held', detail: 'x', at: 'x' }] } as any);
  assert.deepEqual([card.learned, card.heldTasks, card.provenTasks, card.unprovenTasks], [false, 2, 0, 2]);
});

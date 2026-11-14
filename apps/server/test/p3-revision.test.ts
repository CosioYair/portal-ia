import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Portal IA 3 · «Revisión del resultado»: lo que el propietario lee para decidir. La regla que importa es que «listo» se
 * dice de la VERSIÓN ACTUAL y solo cuando de verdad no falta nada. Cada caso reproduce un hallazgo de la revisión
 * independiente: una aprobación o una prueba en verde de una versión anterior no cuenta; lo que no se evaluó no figura
 * como superado; una observación no figura como «resuelta»; lo descartado o sin verificar no figura como listo.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3rev-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { reviewOf, reviewShotPath } = await import('../src/services/review.ts');
providersRepo.setCredential('anthropic', encryptSecret('clave-de-prueba'), 'clave…prueba');
providersRepo.setConnected('anthropic', ['claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia';

const HEAD = 'bbbbbbb1'; const OLD = 'aaaaaaa1';
const T0 = '2026-11-14T10:00:00.000Z'; const BEFORE = '2026-11-14T09:00:00.000Z'; const AFTER = '2026-11-14T10:05:00.000Z';
const run = (command: string, o: any = {}) => ({ command, exitCode: 0, output: 'ok', startedAt: AFTER, finishedAt: AFTER, durationMs: 5, isolation: 'docker', commit: HEAD, ...o });
function proc(over: any = {}, top: any = {}): any {
  return {
    id: 'p-rev', kind: 'story_execution', status: 'done', title: 'HU-900 · Saludo por idioma', projectId: 'x', steps: [], backlogItemId: null, assignmentId: null, ...top,
    result: {
      plan: { acceptance: ['El saludo responde en el idioma pedido'], risks: ['Solo dos idiomas.'] },
      changes: [{ path: 'src/a.ts', action: 'modify', diff: '--- a\n+++ b\n+linea nueva\n-linea vieja\n' }],
      applied: { branch: 'portal-ia/hu-900', commit: HEAD, worktree: 'x', appliedAt: T0, files: ['src/a.ts'] },
      verifications: [run('typecheck'), run('test', { tests: { total: 12, passed: 12, failed: 0 } }), run('build')],
      review: { verdict: 'approved', approve: true, summary: 'Cumple.', findings: [], issues: [] },
      pipeline: { state: 'verified', pauseKind: null, reason: null, lastQaCommit: HEAD, config: { ...D.DEFAULT_PIPELINE, commands: ['typecheck', 'test', 'build'], gauntlet: { mode: 'off' } }, failures: [], events: [], corrections: 0 },
      gauntlet: null, userFacing: 'Ahora el saludo responde en inglés si se pide.', manualTest: { steps: ['Pide el saludo en inglés.'], checks: [false] },
      ...over
    }
  };
}

test('caso bueno: comprobado y revisado sobre la versión actual → listo, con frase clara y lo técnico aparte', () => {
  const v = reviewOf(S, proc());
  assert.equal(v.verdict.ready, true, JSON.stringify(v.verdict.missing)); assert.equal(v.phase, 'ready');
  assert.match(v.headline, /sobre la versión actual/);
  assert.deepEqual(v.checks.map(c => c.status), ['ok', 'ok', 'ok']);
  assert.deepEqual(v.tests, { total: 12, passed: 12, failed: 0 });
  assert.equal(v.qa.verdict, 'approved'); assert.equal(v.gauntlet.verdict, 'off');
  assert.equal(v.whatChanged, 'Ahora el saludo responde en inglés si se pide.');
  assert.deepEqual(v.files, [{ path: 'src/a.ts', change: 'modificado', lines: 2 }]);
  assert.deepEqual(v.toTest, ['Pide el saludo en inglés.']);
  const plain = JSON.stringify({ ...v, technical: null });
  assert.ok(!plain.includes(HEAD) && !plain.includes('portal-ia/hu-900'), 'ni el commit ni la rama aparecen fuera de «technical»');
  assert.equal(v.technical.commit, HEAD);
});

test('(B2) QA aprobó una versión ANTERIOR: no figura como aprobada ni como lista', () => {
  const v = reviewOf(S, proc({ pipeline: { ...proc().result.pipeline, lastQaCommit: OLD } }));
  assert.equal(v.qa.verdict, 'outdated'); assert.equal(v.verdict.ready, false); assert.equal(v.phase, 'not_ready');
  assert.ok(v.verdict.missing.some(m => /versión anterior/.test(m)), v.verdict.missing.join(' | '));
  assert.doesNotMatch(v.headline, /hecho y comprobado/);
});

test('(B3) una verificación en verde de ANTES de la versión actual (sin commit) no cuenta', () => {
  const stale = [run('typecheck', { commit: undefined, startedAt: BEFORE }), run('test', { commit: undefined, startedAt: BEFORE }), run('build', { commit: undefined, startedAt: BEFORE })];
  const v = reviewOf(S, proc({ verifications: stale }));
  assert.deepEqual(v.checks.map(c => c.status), ['not_run', 'not_run', 'not_run']);
  assert.equal(v.verdict.ready, false);
  // Y de otro commit, tampoco.
  const other = reviewOf(S, proc({ verifications: [run('typecheck', { commit: OLD }), run('test', { commit: OLD }), run('build', { commit: OLD })] }));
  assert.equal(other.verdict.ready, false); assert.ok(other.checks.every(c => c.status === 'not_run'));
});

test('(M1) evaluación independiente: «no se hizo» y «continuaste con puntos abiertos» no figuran como superada; superada solo sobre esta versión', () => {
  const g = (status: string, rounds: any[] = []) => ({ mode: 'standard', maxRounds: 1, status, reason: null, rounds });
  const skipped = reviewOf(S, proc({ gauntlet: g('skipped') }));
  assert.equal(skipped.gauntlet.verdict, 'skipped'); assert.match(skipped.gauntlet.note, /No se hizo/);
  assert.ok(skipped.limitations.some(l => /Evaluación independiente: No se hizo/.test(l)), 'queda a la vista como límite');
  const waived = reviewOf(S, proc({ gauntlet: g('waived', [{ round: 1, commit: HEAD, findings: [{ severity: 'major', text: 'Falta un caso.', file: null, evidence: 'x', criterion: null, expected: null }], limitations: [] }]) }));
  assert.equal(waived.gauntlet.verdict, 'waived');
  const round = (commit: string) => [{ round: 1, commit, findings: [], limitations: [] }];
  assert.equal(reviewOf(S, proc({ gauntlet: g('passed', round(HEAD)) })).gauntlet.verdict, 'passed');
  const oldRound = reviewOf(S, proc({ gauntlet: g('passed', round(OLD)) }));
  assert.equal(oldRound.gauntlet.verdict, 'pending', 'evaluó otra versión'); assert.equal(oldRound.verdict.ready, false);
  const gaps = reviewOf(S, proc({ gauntlet: g('stopped', [{ round: 1, commit: HEAD, findings: [{ severity: 'blocking', text: 'No cumple el criterio 1.', file: 'src/a.ts', evidence: 'x', criterion: '1', expected: null }], limitations: [] }]) }));
  assert.equal(gaps.gauntlet.verdict, 'gaps'); assert.equal(gaps.verdict.ready, false); assert.equal(gaps.findings.find(f => f.source === 'gauntlet')!.blocking, true);
});

test('(M2) las observaciones de una revisión aprobada son observaciones, no «resueltas»; las de un rechazo siguen por resolver', () => {
  const f = [{ severity: 'media', text: 'El nombre de la función podría ser más claro.', file: 'src/a.ts', evidence: 'x' }];
  const ok = reviewOf(S, proc({ review: { verdict: 'approved', approve: true, summary: '', findings: f, issues: [] } }));
  assert.equal(ok.findings[0]!.blocking, false); assert.ok(!('resolved' in ok.findings[0]!));
  const no = reviewOf(S, proc({ review: { verdict: 'rejected', approve: false, summary: '', findings: f, issues: [] } }));
  assert.equal(no.findings[0]!.blocking, true); assert.equal(no.qa.verdict, 'rejected'); assert.equal(no.verdict.ready, false);
});

test('(M3) lo descartado, lo que no tiene verificación registrada y lo detenido no se anuncian como «hecho y comprobado»', () => {
  const discarded = reviewOf(S, proc({ rejected: { at: T0, reason: 'descartada' } }));
  assert.equal(discarded.verdict.ready, false); assert.notEqual(discarded.phase, 'ready'); assert.doesNotMatch(discarded.headline, /hecho y comprobado/);
  const noPipeline = reviewOf(S, proc({ pipeline: undefined }));
  assert.equal(noPipeline.verdict.ready, false, 'sin pipeline no consta que esté verificado');
  const stopped = reviewOf(S, proc({ pipeline: { ...proc().result.pipeline, state: 'stopped', pauseKind: 'limit', reason: 'test sigue fallando' } }));
  assert.equal(stopped.verdict.ready, false); assert.equal(stopped.state.label, 'Detenido sin terminar');
});

test('(M4) integrada sin aceptar: el mismo nombre que en «Trabajo» y la frase pide probar y aceptar; no dice «lista»', () => {
  const v = reviewOf(S, proc({ merged: { into: 'main', commit: 'ccccccc1', mergedAt: AFTER } }));
  assert.equal(v.state.label, 'Integrada · falta tu aceptación'); assert.equal(v.phase, 'integrated'); assert.equal(v.verdict.ready, false);
  assert.match(v.headline, /Pruébalo y acéptalo/);
});

test('un entorno sin dependencias o una comprobación que no terminó no se presentan como fallo del trabajo', () => {
  const v = reviewOf(S, proc({ verifications: [run('typecheck'), run('test', { exitCode: 86 }), run('build', { exitCode: null })] }));
  assert.deepEqual(v.checks.map(c => c.status), ['ok', 'unavailable', 'unavailable']);
  assert.match(v.checks[1]!.detail, /no es un fallo del trabajo/); assert.match(v.checks[2]!.detail, /no terminó/);
  assert.equal(v.verdict.ready, false);
  const failing = reviewOf(S, proc({ verifications: [run('typecheck'), run('test', { exitCode: 1, tests: { total: 3, passed: 2, failed: 1 } }), run('build')] }));
  assert.equal(failing.checks[1]!.status, 'fail');
});

test('las capturas solo salen de la carpeta de evidencia del propio proceso (nombres con ruta se rechazan)', () => {
  for (const bad of ['../x.png', '..\\x.png', 'a/b.png', 'x.txt', '.png', 'C:x.png', '']) assert.equal(reviewShotPath(S, proc(), bad), null, bad);
  assert.equal(reviewShotPath(S, proc(), 'oficina-375.png'), null, 'sin evidencia no hay captura');
});

test('(N1) candidato de integración verificado: en pausa solo por tu decisión de integrar → listo; con QA de otra versión, no', () => {
  const pl = { ...proc().result.pipeline, state: 'paused', pauseKind: 'integration', reason: 'Combinado con lo último; falta tu decisión.' };
  const v = reviewOf(S, proc({ pipeline: pl }));
  assert.equal(v.verdict.ready, true, v.verdict.missing.join(' | ')); assert.equal(v.phase, 'ready');
  assert.match(v.headline, /decide si se integra/);
  const stale = reviewOf(S, proc({ pipeline: { ...pl, lastQaCommit: OLD } }));
  assert.equal(stale.verdict.ready, false); assert.equal(stale.phase, 'not_ready');
  const otherPause = reviewOf(S, proc({ pipeline: { ...pl, pauseKind: 'limit' } }));
  assert.equal(otherPause.verdict.ready, false, 'otra pausa no es estar listo');
});

test('(N2) QA omitida por el propietario: no figura como aprobada ni como «falta»; queda a la vista como límite', () => {
  const v = reviewOf(S, proc({ review: undefined, pipeline: { ...proc().result.pipeline, lastQaCommit: null } }));
  assert.equal(v.qa.verdict, 'omitted'); assert.match(v.qa.note, /elegiste ejecutar sin revisión de calidad/);
  assert.ok(!v.verdict.missing.some(m => /Falta la revisión de calidad/.test(m)), v.verdict.missing.join(' | '));
  assert.ok(v.limitations.some(l => /Revisión de calidad: No se hizo/.test(l)));
  // Sin verificar todavía, una QA que no se ha hecho sigue siendo «falta».
  const running = reviewOf(S, proc({ review: undefined, pipeline: { ...proc().result.pipeline, state: 'stopped', pauseKind: 'limit', lastQaCommit: null } }));
  assert.equal(running.qa.verdict, 'none');
});

test('(N3) un intento sustituido o cancelado habla de sí mismo: ni listo ni con el estado de su historia', () => {
  const sup = reviewOf(S, proc({}, { supersededBy: 'p-otro' }));
  assert.equal(sup.state.label, 'Sustituido'); assert.equal(sup.phase, 'discarded'); assert.equal(sup.verdict.ready, false);
  assert.match(sup.headline, /sustituyó un intento posterior/);
  const can = reviewOf(S, proc({}, { status: 'cancelled' }));
  assert.equal(can.state.label, 'Cancelado'); assert.equal(can.verdict.ready, false);
});

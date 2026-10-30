import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Telemetría de llamadas (rendimiento medible): resumen con p50/p95 solo con muestras suficientes, modelo frente a
 * Portal, llamadas repetidas (misma huella en el mismo proceso), fallos por clase y lecturas del repositorio. Sin IA.
 */
const { seriesStat } = await import('@portal-ia/domain');
const { summarizeCalls } = await import('../src/db/callMetrics.ts');

const call = (o: any = {}) => ({ id: 'x', processId: 'p1', stepId: 's', agentId: 'a', role: 'implementer', operation: 'Unidad 1', backend: 'Claude Code — Suscripción', model: 'm', attempt: 1, status: 'done', startedAt: '2026-10-30T00:00:00Z', finishedAt: '2026-10-30T00:00:10Z', waitMs: 10_000, buildMs: 40, systemChars: 1000, promptChars: 9000, context: [], tokensIn: 50_000, tokensOut: 2000, cacheReadTokens: 40_000, turns: 4, tools: { portal_read_file: 3, portal_list_files: 1 }, promptHash: 'aaaa', errorClass: null, ...o });

test('p50 y p95: p95 solo con 10 muestras o más; valores no numéricos fuera', () => {
  assert.deepEqual(seriesStat([3, 1, 2]), { n: 3, p50: 2, p95: null, total: 6 });
  const s = seriesStat([...Array(20).keys()].map(i => i + 1));
  assert.equal(s.p50, 11); assert.equal(s.p95, 19); assert.equal(seriesStat([null, undefined, NaN]).n, 0);
});

test('resumen: modelo frente a Portal, caché, lecturas, repetidas y fallos por clase', () => {
  const rows = [
    call(), call({ promptHash: 'aaaa', attempt: 1, stepId: 's2' }), // misma huella en el mismo proceso → repetida
    call({ role: 'reviewer', promptHash: 'bbbb', waitMs: 5000, buildMs: 10, tools: null, cacheReadTokens: 0, tokensIn: 10_000 }),
    call({ role: 'planner', backend: 'Anthropic API', promptHash: 'cccc', cacheReadTokens: null, tools: null, tokensIn: 20_000 }),
    call({ status: 'failed', errorClass: 'CLAUDE_CODE_MAX_TURNS_EXHAUSTED', promptHash: 'dddd', tools: { portal_read_file: 8 } })
  ] as any;
  const s = summarizeCalls(rows, '2026-10-29T00:00:00.000Z');
  assert.equal(s.calls, 5); assert.equal(s.failed, 1);
  assert.deepEqual(s.split, { modelMs: 45_000, portalMs: 170 });
  assert.equal(s.byRole.implementer.calls, 3); assert.equal(s.byRole.implementer.cacheShare, +(120_000 / 150_000).toFixed(3));
  assert.equal(s.byRole.planner.cacheShare, null, 'la API no informa de caché: no se inventa');
  assert.deepEqual(s.duplicates, [{ processId: 'p1', promptHash: 'aaaa', count: 2, role: 'implementer', operation: 'Unidad 1' }]);
  assert.deepEqual(s.failures, { CLAUDE_CODE_MAX_TURNS_EXHAUSTED: 1 });
  assert.deepEqual(s.repoReads, { total: 4 + 4 + 8, callsWithReads: 3 });
  assert.equal(s.byBackend['Anthropic API'].calls, 1);
});

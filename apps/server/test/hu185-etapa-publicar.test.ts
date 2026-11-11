import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Process } from '@portal-ia/domain';

/**
 * HU-185 · Etapa «Publicar» guiada y NO bloqueante: va entre la prueba manual y el cierre (Portal y proyectos externos),
 * su texto corto es pendiente / hecha / no aplica / omitida, el cierre no cambia y los encargos no la ofrecen.
 * Datos sintéticos; sin IA, sin red y sin git.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu185-'));
process.env.LOG_LEVEL = 'warn';
const { describeProcess } = await import('../src/services/guidance.ts');
const { publishStageFor } = await import('../src/services/publishState.ts');

const ok = (command: string, commit: string) => ({ command, exitCode: 0, output: 'ok', startedAt: '2026-11-01T10:30:00Z', finishedAt: '2026-11-01T10:31:00Z', durationMs: 1000, isolation: 'docker' as const, commit });
/** Historia integrada en main y probada paso a paso (lista para cerrar). */
function proc(o: { published?: boolean; skipped?: boolean; assignment?: boolean } = {}): Process {
  const files = ['apps/web/src/components/StoryFlowPanel.tsx'];
  return {
    id: 'p-hu185', projectId: 'pj', kind: 'story_execution', title: 'Ejecutar HU-185', status: 'done', budgetUsd: 0, estimatedUsd: 0, spentUsd: 0, inputTokens: 0, outputTokens: 0,
    createdAt: '2026-11-01T10:00:00Z', authorizedAt: null, startedAt: null, finishedAt: null, error: null, delegation: null,
    backlogItemId: o.assignment ? null : 'hu-185', assignmentId: o.assignment ? 'en-1' : null, steps: [],
    result: {
      plan: { summary: '', tasks: [], filesToRead: [], filesToChange: files, acceptance: [], risks: [] }, implementationSummary: null,
      changes: files.map(f => ({ path: f, action: 'modify', content: null, diff: null, before: 1, after: 2 })),
      verifyCommands: [], review: { approve: true, issues: [], suggestedTests: [], summary: '', verdict: 'approved', findings: [] },
      applied: { branch: 'portal-ia/hu-185', commit: 'abc1234', files, appliedAt: '2026-11-01T10:20:00Z', worktree: '/wt' },
      verifications: ['typecheck', 'test', 'build'].map(c => ok(c, 'abc1234')),
      merged: { into: 'main', commit: 'def5678', mergedAt: '2026-11-01T10:40:00Z' },
      manualTest: { steps: ['Abrir la historia'], checks: [true], note: null },
      published: o.published ? { remote: 'origin', url: null, branches: ['main'], pushedAt: '2026-11-01T11:00:00Z' } : null,
      publishSkipped: o.skipped ? { at: '2026-11-01T11:00:00Z' } : null
    } as any
  } as Process;
}
const PENDING = { hasRemote: true, aheadOfRemote: 3 };
const NO_REMOTE = { hasRemote: false, aheadOfRemote: null };
const flowOf = (p: Process, opts: any) => {
  const g = describeProcess(p, opts) as any;
  assert.ok(g.flow, 'el recorrido guiado se construye (no se descarta por un error)');
  return g.flow;
};
const stage = (flow: any, key: string) => flow.stages.find((s: any) => s.key === key);

for (const portal of [true, false]) {
  test(`orden de etapas: prueba manual < publicar < cerrar (${portal ? 'Portal' : 'proyecto externo'})`, () => {
    const keys = flowOf(proc(), { isPortalRepo: portal, publish: PENDING }).stages.map((s: any) => s.key);
    const m = keys.indexOf('manual'); const pub = keys.indexOf('publish'); const c = keys.indexOf('close');
    assert.ok(m >= 0 && pub >= 0 && c >= 0, `etapas: ${keys}`);
    assert.equal(pub, m + 1, 'publicar va justo después de la prueba manual');
    assert.equal(c, pub + 1, 'y justo antes de cerrar');
    assert.equal(stage(flowOf(proc(), { isPortalRepo: portal, publish: PENDING }), 'publish').label, 'Publicar');
  });
}

test('publishStageFor: los 4 textos cortos y ninguno parece un problema', () => {
  const cases: [any, any, string][] = [
    [{ hasRemote: true, aheadOfRemote: 3 }, {}, 'pendiente'],
    [{ hasRemote: true, aheadOfRemote: -1 }, {}, 'pendiente'],
    [{ hasRemote: true, aheadOfRemote: 0 }, {}, 'hecha'],
    [{ hasRemote: true, aheadOfRemote: 2 }, { published: { remote: 'origin' } }, 'hecha'],
    [NO_REMOTE, {}, 'no aplica'],
    [PENDING, { publishSkipped: { at: '2026-11-01T11:00:00Z' } }, 'omitida']
  ];
  for (const [info, result, text] of cases) {
    const s = publishStageFor(info, result)!;
    assert.equal(s.statusText, text, JSON.stringify({ info, result }));
    assert.ok(!['warning', 'blocked', 'failed'].includes(s.status), `«${text}» no debe parecer un bloqueo (${s.status})`);
  }
  assert.match(publishStageFor(PENDING, {})!.detail, /3 commit\(s\) de main sin publicar/);
  assert.equal(publishStageFor(PENDING, {})!.status === 'done', false, 'pendiente no cuenta como hecha');
});

test('describeProcess: «Publicar · pendiente» con commits sin publicar y «no aplica» sin remoto', () => {
  for (const portal of [true, false]) {
    assert.equal(stage(flowOf(proc(), { isPortalRepo: portal, publish: PENDING }), 'publish').statusText, 'pendiente');
    assert.equal(stage(flowOf(proc(), { isPortalRepo: portal, publish: { hasRemote: true, aheadOfRemote: -1 } }), 'publish').statusText, 'pendiente');
    assert.equal(stage(flowOf(proc(), { isPortalRepo: portal, publish: NO_REMOTE }), 'publish').statusText, 'no aplica');
    assert.equal(stage(flowOf(proc(), { isPortalRepo: portal, publish: { hasRemote: true, aheadOfRemote: 0 } }), 'publish').statusText, 'hecha');
    assert.equal(stage(flowOf(proc({ published: true }), { isPortalRepo: portal, publish: PENDING }), 'publish').statusText, 'hecha');
    assert.equal(stage(flowOf(proc({ skipped: true }), { isPortalRepo: portal, publish: PENDING }), 'publish').statusText, 'omitida');
  }
  const ids = flowOf(proc(), { isPortalRepo: false, publish: PENDING }).actions.map((a: any) => a.id);
  assert.ok(ids.includes('publish') && ids.includes('skip_publish'), `pendiente ofrece publicar u omitir: ${ids}`);
  const idsDone = flowOf(proc(), { isPortalRepo: false, publish: NO_REMOTE }).actions.map((a: any) => a.id);
  assert.ok(!idsDone.includes('publish') && !idsDone.includes('skip_publish'), 'sin remoto no se ofrece publicar');
});

test('el cierre no cambia: etapa «cerrar» y acción «close» idénticas con publicación pendiente o sin ella', () => {
  for (const portal of [true, false]) {
    const pending = flowOf(proc(), { isPortalRepo: portal, publish: PENDING });
    const none = flowOf(proc(), { isPortalRepo: portal });
    const noRemote = flowOf(proc(), { isPortalRepo: portal, publish: NO_REMOTE });
    for (const other of [none, noRemote]) {
      assert.deepEqual(stage(pending, 'close'), stage(other, 'close'), `etapa cerrar (${portal ? 'Portal' : 'externo'})`);
      assert.deepEqual(pending.actions.find((a: any) => a.id === 'close'), other.actions.find((a: any) => a.id === 'close'), 'acción cerrar');
    }
  }
  // La regla de cierre (closingBlocker) no mira la publicación: publicar nunca bloquea.
  const closing = fs.readFileSync(new URL('../src/services/closing.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(closing, /publish|aheadOfRemote/i);
});

test('un encargo que no es historia no ofrece publicar ni omitir (STORY_ONLY)', () => {
  const story = flowOf(proc(), { isPortalRepo: false, publish: PENDING }).actions.map((a: any) => a.id);
  assert.ok(story.includes('publish'), 'la historia sí la ofrece (control)');
  const g = describeProcess(proc({ assignment: true }), { isPortalRepo: false, publish: PENDING } as any) as any;
  const ids = (g.flow?.actions ?? []).map((a: any) => a.id);
  assert.ok(!ids.includes('publish') && !ids.includes('skip_publish') && !ids.includes('close'), `encargo: ${ids}`);
});

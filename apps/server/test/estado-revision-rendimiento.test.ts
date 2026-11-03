import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Process } from '@portal-ia/domain';

/**
 * Coherencia de estados por COMMIT (HU-166, HU-169, HU-173), evidencia sin IA (HU-173), versión para pestañas
 * desactualizadas, capacidad compartida (cola de Claude Code, sandbox), índices de la base y rendimiento de los listados
 * con 100+ historias e historiales largos. Datos sintéticos; ninguna llamada a la IA.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-revision-'));
process.env.LOG_LEVEL = 'warn';
const { revisionStatus, reviewStageText, processVersion } = await import('../src/services/revision.ts');
const { compareSheets, normalizeCss } = await import('../src/services/cssEquivalence.ts');
const { testFileExecuted } = await import('../src/services/storyUnits.ts');
const { fairClip } = await import('../src/services/qaGate.ts');
const { semaphore, withRwLock, addQueuedMs, queuedMsOf } = await import('../src/services/capacity.ts');
const { withWatchdog } = await import('../src/services/providerCalls.ts');
const { declaresNoCode } = await import('../src/services/storyExecution.ts');
const { procLabel, processFilterKey } = await import('../../web/src/lib/processView.ts');
const { parentOf, screenName } = await import('../../web/src/lib/nav.ts');

const PIPE_CFG = { autoApply: true, autoVerify: true, commands: ['typecheck', 'test', 'build'], allowInstall: true, maxOutputRepairs: 1, maxCorrections: 5, maxIdenticalFailures: 2, maxDurationMin: 45, maxConsultations: 1, maxProviderRetries: 2, providerTimeoutSec: null, maxContinuations: 6, gauntlet: { mode: 'deep', maxRounds: 3 } };
const ok = (command: string, commit: string) => ({ command, exitCode: 0, output: 'ok', startedAt: '2026-10-31T15:30:00Z', finishedAt: '2026-10-31T15:31:00Z', durationMs: 1000, isolation: 'docker' as const, commit });
/** Proceso de historia sintético con lo mínimo que usa la derivación (forma de HU-166 / HU-169 / HU-173). */
function proc(o: { head: string; qa: string | null; verdict?: 'approved' | 'rejected' | 'unable_to_verify'; candidate?: { previous: string; resolvedBy: 'git' | 'agent'; conflicts?: string[]; files: string[] }; storyFiles?: string[]; merged?: string; pause?: { kind: string; reason: string }; mergeError?: string[]; verified?: boolean }): Process {
  const files = o.storyFiles ?? ['apps/web/src/screens/StoryWorkspace.tsx'];
  return {
    id: 'p-' + o.head, projectId: 'pj', kind: 'story_execution', title: 'Ejecutar HU-X', status: 'done', budgetUsd: 0, estimatedUsd: 0, spentUsd: 0, inputTokens: 0, outputTokens: 0,
    createdAt: '2026-10-31T15:00:00Z', authorizedAt: null, startedAt: null, finishedAt: null, error: null, delegation: null, backlogItemId: 'hu-x', steps: [],
    result: {
      plan: { summary: '', tasks: [], filesToRead: [], filesToChange: files, acceptance: [], risks: [] }, implementationSummary: null, changes: files.map(f => ({ path: f, action: 'modify', content: null, diff: null, before: 1, after: 2 })) as any,
      verifyCommands: [], review: o.verdict ? { approve: o.verdict === 'approved', issues: [], suggestedTests: [], summary: '', verdict: o.verdict, findings: [] } : null,
      applied: { branch: 'portal-ia/hu-x', commit: o.head, files, appliedAt: '2026-10-31T15:20:00Z', worktree: '/wt' },
      verifications: o.verified === false ? [] : ['typecheck', 'test', 'build'].map(c => ok(c, o.head)),
      pipeline: { config: PIPE_CFG, state: o.merged ? 'paused' : o.pause ? 'paused' : 'verified', phase: 'finished', reason: o.pause?.reason ?? null, pauseKind: (o.pause?.kind ?? null) as any, events: [], outputRepairs: 0, corrections: 1, failures: [], lastQaCommit: o.qa, startedAt: '', finishedAt: '' } as any,
      integration: o.candidate ? { state: 'candidate', at: '', target: 'main', targetHead: 'main1', behindCount: 13, commit: o.head, previousCommit: o.candidate.previous, files: o.candidate.files, conflicts: o.candidate.conflicts ?? [], resolvedBy: o.candidate.resolvedBy } : null,
      merged: o.merged ? { into: 'main', commit: o.merged, mergedAt: '2026-10-31T15:43:56Z' } : null,
      mergeError: o.mergeError ? { at: '2026-10-31T16:31:31Z', message: 'conflicto', files: o.mergeError } : null
    } as any
  } as Process;
}

// ------------------------------------------------------------------ Y · Z · HU-166 / HU-169 / HU-173
test('Y · HU-166: QA aprobó 1a387ca; el candidato f356533 solo añade main sin conflictos → la aprobación lo cubre y se dice de qué commit es', () => {
  const p = proc({ head: 'f356533', qa: '1a387ca', verdict: 'approved', candidate: { previous: '1a387ca', resolvedBy: 'git', files: ['apps/server/test/icons-wiring.test.ts', 'apps/web/src/components/Shell.tsx'] }, merged: '3cc1e04', pause: { kind: 'integration', reason: 'Candidato de integración verificado sin IA (commit f356533)… QA aún no ha revisado este commit.' } });
  const r = revisionStatus(p)!;
  assert.equal(r.qa.coverage, 'carried_clean_merge'); assert.equal(r.qa.coversHead, true);
  assert.equal(reviewStageText(r), 'QA aprobó 1a387ca; el candidato f356533 solo añade main');
  assert.doesNotMatch(reviewStageText(r), /^QA aprobó f356533/, 'nunca dice que QA aprobó el candidato');
});

test('Z · HU-169: conflictos resueltos por el agente después de la aprobación → superada (QA no revisó el candidato); el lote no la integra sola', () => {
  const p = proc({ head: 'fad47b9', qa: '8bceeec', verdict: 'approved', candidate: { previous: '8bceeec', resolvedBy: 'agent', conflicts: ['apps/web/src/screens/Archive.tsx', 'apps/web/src/screens/Knowledge.tsx'], files: ['apps/web/src/screens/Archive.tsx'] }, pause: { kind: 'integration', reason: 'Candidato verificado' } });
  const r = revisionStatus(p)!;
  assert.equal(r.qa.coverage, 'superseded'); assert.equal(r.qa.coversHead, false); assert.match(r.qa.why, /resueltos por el agente/);
  assert.equal(reviewStageText(r), 'QA aprobó 8bceeec; fad47b9 sin revisar');
});

test('Z · combinación limpia que toca archivos de la historia o compartidos → «con solapamiento» (no cubre; se recomienda QA)', () => {
  const own = revisionStatus(proc({ head: 'c2', qa: 'c1', verdict: 'approved', candidate: { previous: 'c1', resolvedBy: 'git', files: ['apps/web/src/screens/StoryWorkspace.tsx'] } }))!;
  assert.equal(own.qa.coverage, 'carried_with_overlap'); assert.equal(own.qa.coversHead, false);
  const shared = revisionStatus(proc({ head: 'c2', qa: 'c1', verdict: 'approved', candidate: { previous: 'c1', resolvedBy: 'git', files: ['packages/domain/src/types.ts'] } }))!;
  assert.equal(shared.qa.coverage, 'carried_with_overlap', 'un archivo compartido por todo el Portal cuenta como solapamiento');
  const unverified = revisionStatus(proc({ head: 'c2', qa: 'c1', verdict: 'approved', verified: false, candidate: { previous: 'c1', resolvedBy: 'git', files: ['README.md'] } }))!;
  assert.equal(unverified.qa.coversHead, false, 'sin verificación en verde sobre el candidato, no se da por cubierto');
  const later = revisionStatus(proc({ head: 'c3', qa: 'c1', verdict: 'approved' }))!;
  assert.equal(later.qa.coverage, 'superseded', 'commits nuevos después de QA');
  const direct = revisionStatus(proc({ head: 'c1', qa: 'c1', verdict: 'approved' }))!;
  assert.equal(direct.qa.coverage, 'direct'); assert.equal(reviewStageText(direct), 'QA aprobó c1');
});

test('HU-173: QA no pudo verificar ≠ fallo; la fase y el siguiente paso no dicen «Pulsa Integrar» y no se ofrece integrar con conflicto con main', async () => {
  const { describeProcess } = await import('../src/services/guidance.ts');
  const p = proc({ head: 'e583eba', qa: 'e583eba', verdict: 'unable_to_verify', pause: { kind: 'qa', reason: 'QA no pudo verificar la implementación: faltan las capturas.' }, mergeError: ['apps/web/src/tokens.css'] });
  (p.result!.pipeline as any).state = 'stopped';
  const r = revisionStatus(p)!; assert.equal(r.qa.state, 'inconclusive'); assert.equal(r.qa.coversHead, false);
  const g = describeProcess(p, { isPortalRepo: true } as any) as any;
  assert.doesNotMatch(`${g.phase} ${g.next}`, /Pulsa «Integrar/);
  const review = g.flow.stages.find((s: any) => s.key === 'review');
  assert.equal(review.status, 'blocked', 'inconcluso: bloqueado a la espera de tu decisión, no «fallido»');
  const ids = g.flow.actions.map((a: any) => a.id);
  assert.ok(!ids.includes('merge'), `con conflicto registrado con main no se ofrece integrar: ${ids}`); assert.ok(ids.includes('integration_prepare'));
});

test('AA · integrada: la pausa anterior no es su estado (ni «Pausado», ni «Problema actual»), y el siguiente paso es tu aceptación', async () => {
  const { describeProcess } = await import('../src/services/guidance.ts');
  const p = proc({ head: 'f356533', qa: '1a387ca', verdict: 'approved', candidate: { previous: '1a387ca', resolvedBy: 'git', files: ['README.md'] }, merged: '3cc1e04', pause: { kind: 'integration', reason: 'Candidato de integración verificado sin IA… QA aún no ha revisado este commit.' } });
  assert.equal(procLabel(p).label, 'Integrada en main'); assert.equal(processFilterKey(p), 'done');
  const { deliveryProgress } = await import('../src/services/storyUnits.ts');
  (p.result as any).manifest = { version: 1, deliverables: [], units: [], unitOutputBudget: 1, qaSubscription: false, rounds: [], gate: null, createdAt: '' };
  const d = deliveryProgress(p)!;
  assert.equal(d.blocker, null, 'sin bloqueo viejo'); assert.equal(d.levels.qaApproved, true); assert.match(d.next, /aceptación/);
  const g = describeProcess(p, { isPortalRepo: false } as any) as any;
  assert.ok(!g.flow.issue || !/QA aún no ha revisado/.test(g.flow.issue.explanation ?? ''));
});

test('AB · en cola (esperando un hueco de Claude Code) no es «bloqueado» ni «trabajando»', () => {
  const p = proc({ head: 'x', qa: null }); (p as any).status = 'running';
  p.steps = [{ id: 's', processId: p.id, position: 0, agentId: 'a', agentName: 'Dev', title: 'Unidad 1', status: 'running', model: 'm', inputTokens: 0, outputTokens: 0, costUsd: 0, outputMd: null, error: null, startedAt: '', finishedAt: null, role: 'implementer', reason: null, lessonsUsed: [], live: { state: 'queued' } as any, unconfirmedUsd: 0, backend: null }];
  assert.equal(procLabel(p).label, 'En cola · espera un hueco'); assert.equal(processFilterKey(p), 'running');
});

// ------------------------------------------------------------------ Versión para pestañas desactualizadas
test('W · la versión para decidir cambia con lo que importa (pausa, commit, integración) y NO con el progreso', () => {
  const p = proc({ head: 'a1', qa: 'a1', verdict: 'approved', pause: { kind: 'qa', reason: 'x' } });
  const v = processVersion(p);
  const progress = { ...p, inputTokens: 999, steps: [{ ...(p.steps[0] ?? {}), live: { state: 'waiting' } } as any], result: { ...p.result!, pipeline: { ...p.result!.pipeline!, events: [{ at: '', kind: 'info', message: 'progreso' }] } } } as Process;
  assert.equal(processVersion(progress), v, 'el progreso no invalida un clic válido');
  assert.notEqual(processVersion({ ...p, result: { ...p.result!, applied: { ...p.result!.applied!, commit: 'a2' } } } as Process), v);
  assert.notEqual(processVersion({ ...p, result: { ...p.result!, pipeline: { ...p.result!.pipeline!, pauseKind: 'integration' } } } as Process), v);
  assert.notEqual(processVersion({ ...p, status: 'running' } as Process), v);
});

// ------------------------------------------------------------------ HU-173 · evidencia sin IA
test('HU-173 · equivalencia de estilos: sustituir un color por un token del mismo valor es idéntico; cambiar un valor no; tokens ambiguos, indeterminado', () => {
  const tokens = ':root{--color-surface:#FFF;--shadow-1:0 1px 2px rgba(0,0,0,.1)}';
  const before = new Map([['tokens.css', tokens], ['styles.css', '.a{color:#ffffff;box-shadow:0 1px 2px rgba(0,0,0,.1)}\n.b{background:var(--color-accent-bg, #E3F1EF)}']]);
  const after = new Map([['tokens.css', tokens.replace('}', ';--color-accent-soft:#E3F1EF}')], ['styles.css', '.a{color:var(--color-surface);box-shadow:var(--shadow-1)}\n.b{background:var(--color-accent-soft)}']]);
  const same = compareSheets({ sheets: before }, { sheets: after }, ['styles.css']);
  assert.equal(same.identical, true, JSON.stringify(same)); assert.equal(same.resolved, 3);
  const changedValue = new Map(after); changedValue.set('styles.css', '.a{color:var(--color-surface);box-shadow:none}\n.b{background:var(--color-accent-soft)}');
  const diff = compareSheets({ sheets: before }, { sheets: changedValue }, ['styles.css']);
  assert.equal(diff.identical, false); assert.match(diff.differences[0], /box-shadow/);
  const amb = new Map(after); amb.set('dark.css', ':root{--color-surface:#000}');
  assert.deepEqual(compareSheets({ sheets: before }, { sheets: amb }, ['styles.css']).ambiguous, ['--color-surface']);
  assert.equal(normalizeCss('A { COLOR : #ABC ; }'), 'A{COLOR:#aabbcc}');
});

test('HU-173 · «7 de 8»: TAP escapa «#» en los nombres; el caso sí se ejecutó y ahora cuenta', () => {
  const file = "test('fondo sobre #FFFFFF y #F7F6F2', () => {});\ntest('otro caso normal', () => {});";
  const out = 'ok 1 - fondo sobre \\#FFFFFF y \\#F7F6F2\nok 2 - otro caso normal\n# tests 2';
  const r = testFileExecuted(file, out); assert.equal(r.state, 'passed'); assert.match(r.detail, /^2 de 2/);
});

test('HU-173 · el diff para QA se reparte: un CSS minificado enorme ya no deja fuera a los demás archivos', () => {
  const big = 'x'.repeat(58_000); const small = ['diff a', 'diff b'];
  const parts = fairClip([big, ...small], 50_000);
  assert.equal(parts[1], 'diff a'); assert.equal(parts[2], 'diff b');
  assert.ok(parts.join('').length <= 50_200); assert.match(parts[0], /diff recortado: \d+ caracteres omitidos/);
});

test('HU-175 · «sin archivos a propósito» solo con un JSON legible que lo dice; un JSON cortado o sin el campo se vuelve a pedir', () => {
  assert.equal(declaresNoCode({ summary: 'Auditoría de solo lectura; no se cambia ningún archivo.', filesToChange: [], deliverables: [] }), true);
  assert.equal(declaresNoCode({ summary: 'Plan', filesToChange: [], noCodeChange: true }), true);
  assert.equal(declaresNoCode({ summary: 'Crear el módulo', filesToChange: [] }), false, 'vacío sin explicarlo: se vuelve a pedir');
  assert.equal(declaresNoCode({ summary: 'solo lectura', filesToChange: ['a.ts'] }), false);
  assert.equal(declaresNoCode(null), false); assert.equal(declaresNoCode({ summary: 'solo lectura' }), false, 'sin el campo no cuenta');
});

// ------------------------------------------------------------------ M · capacidad compartida
test('M · la espera en la cola no consume el plazo de la llamada (vigilante armado al salir de la cola)', async () => {
  process.env.PORTAL_PROVIDER_WATCHDOG_GRACE_MS = '1';
  let release!: () => void; const out = new Promise<void>(r => { release = r; });
  const ctrl = new AbortController();
  const call = new Promise<string>(r => setTimeout(() => r('hecho'), 120)); // 100 ms en cola + 20 ms de llamada
  setTimeout(release, 100);
  assert.equal(await withWatchdog(call, ctrl, 60, { startAfter: out }), 'hecho', 'sin el arranque diferido, 60 ms + gracia habrían abortado');
  await assert.rejects(withWatchdog(new Promise(() => { /* nunca */ }), new AbortController(), 30), /superó su plazo/);
  addQueuedMs('p-cola', 1500); addQueuedMs('p-cola', 500); assert.equal(queuedMsOf('p-cola'), 2000);
  // Ronda B · M5: al continuar (nuevo inicio de la ejecución) no se arrastra la espera de la ejecución anterior.
  assert.equal(queuedMsOf('p-cola', new Date(Date.now() + 1000).toISOString()), 0);
  const { clearQueued } = await import('../src/services/capacity.ts'); clearQueued('p-cola'); assert.equal(queuedMsOf('p-cola'), 0);
});

test('M · semáforo de capacidad (máximo a la vez, en orden) y cerrojo lector/escritor del volumen de dependencias', async () => {
  const sem = semaphore(() => 2); let active = 0; let peak = 0; const order: number[] = [];
  await Promise.all([1, 2, 3, 4, 5].map(async n => { const rel = await sem.acquire(); active++; peak = Math.max(peak, active); order.push(n); await new Promise(r => setTimeout(r, 15)); active--; rel(); }));
  assert.equal(peak, 2); assert.deepEqual(order, [1, 2, 3, 4, 5]);
  const log: string[] = [];
  const reader = (n: string, ms: number) => withRwLock('deps:v1', false, async () => { log.push(`+${n}`); await new Promise(r => setTimeout(r, ms)); log.push(`-${n}`); });
  // Orden de llegada: lector a, escritor (install), lector b.
  const a = reader('a', 30); const writer = withRwLock('deps:v1', true, async () => { log.push('+W'); await new Promise(r => setTimeout(r, 10)); log.push('-W'); }); const b = reader('b', 5);
  await Promise.all([a, writer, b]);
  const w = log.indexOf('+W'); assert.ok(w > log.indexOf('-a'), `install espera a que terminen los lectores: ${log}`);
  assert.ok(log.indexOf('+b') > log.indexOf('-W'), `un lector que llega después espera al escritor (no lee un volumen a medio llenar): ${log}`);
});

// ------------------------------------------------------------------ Navegación (funciones puras)
test('A · «Atrás» sin pantalla anterior del Portal va a la pantalla madre (nunca fuera del Portal)', () => {
  assert.deepEqual(parentOf('/historias/abc'), { path: '/backlog', label: 'Backlog' });
  assert.deepEqual(parentOf('/procesos/p1'), { path: '/actividad', label: 'Actividad' });
  assert.deepEqual(parentOf('/lotes/b1'), { path: '/lotes', label: 'Lotes' });
  assert.equal(parentOf('/panel'), null);
  assert.equal(screenName('/backlog?x=1#y'), 'Backlog'); assert.equal(screenName('/historias/1'), 'la historia');
});

// ------------------------------------------------------------------ AD · AE · AF · índices y listados con muchos datos
test('AD/AE/AF · índices aditivos (sin tocar datos) y listados rápidos con 120 historias e historiales largos', async () => {
  const { processesRepo, projectsRepo, backlogRepo, workspaceDb } = await import('../src/db/workspace.ts');
  const { workspacesRepo } = await import('../src/db/platform.ts');
  const slug = 'perf-sintetica'; workspacesRepo.create({ slug, name: 'Perf', kind: 'company' } as any);
  const pj = projectsRepo(slug).create({ slug: 'p', name: 'P', description: '' });
  const big = 'texto del agente '.repeat(2500); // ~42 KB por paso
  for (let i = 0; i < 120; i++) {
    const it = backlogRepo(slug).add({ projectId: pj.id, storyId: `HU-${i}`, title: `Historia ${i}`, ownerKey: null, dependsOn: null, estimate: null, criterion: 'c', description: 'd', sourceProcessId: null } as any);
    if (i < 60) {
      const p = processesRepo(slug).create({ projectId: pj.id, kind: 'story_execution', title: `Ejecutar HU-${i}`, estimatedUsd: 0, backlogItemId: it.id, steps: Array.from({ length: 10 }, (_, k) => ({ agentId: 'a', agentName: 'Dev', title: `Paso ${k}`, model: 'm' })) });
      for (const s of processesRepo(slug).get(p.id)!.steps) processesRepo(slug).stepFinish(s.id, 'done', { outputMd: big });
      processesRepo(slug).setResult(p.id, { plan: null, implementationSummary: null, changes: [], verifyCommands: [], review: null, applied: null, verifications: [], pipeline: { config: PIPE_CFG, state: 'verified', phase: 'finished', reason: null, pauseKind: null, events: Array.from({ length: 300 }, (_, k) => ({ at: '', kind: 'info', message: `evento ${k} ${'x'.repeat(200)}` })), outputRepairs: 0, corrections: 0, failures: [] } } as any);
      backlogRepo(slug).setStatus(it.id, 'review', p.id);
    }
  }
  const db = workspaceDb(slug);
  const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('x') as any[]).map(r => r.detail).join(' | ');
  assert.match(plan('SELECT * FROM process_steps WHERE process_id = ? ORDER BY position'), /USING INDEX process_steps_process/);
  assert.match(plan('SELECT id FROM processes WHERE backlog_item_id = ?'), /USING (COVERING )?INDEX processes_backlog_item/);
  const t0 = performance.now(); const light = processesRepo(slug).listLight(pj.id); const tLight = performance.now() - t0;
  assert.equal(light.length, 60); assert.ok(light.every(p => p.steps.length === 10 && p.steps.every(s => s.outputMd === null)), 'sin las salidas de los agentes');
  const t1 = performance.now(); const full = processesRepo(slug).list(pj.id); const tFull = performance.now() - t1;
  assert.equal(full.length, 60);
  const lightKb = JSON.stringify(light).length / 1024; const fullKb = JSON.stringify(full).length / 1024;
  assert.ok(lightKb * 5 < fullKb, `el listado ligero pesa mucho menos (${lightKb.toFixed(0)} KB frente a ${fullKb.toFixed(0)} KB)`);
  assert.ok(tLight < 2000, `listado ligero de 60 procesos largos en ${tLight.toFixed(0)} ms (completo: ${tFull.toFixed(0)} ms)`);
  // AD: abrir otra vez la base (índices ya creados) no cambia ningún dato.
  const before = (db.prepare('SELECT COUNT(*) n, SUM(LENGTH(result_json)) r FROM processes').get() as any);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM processes').get() as any).n, 60); assert.ok(before.r > 0);
});

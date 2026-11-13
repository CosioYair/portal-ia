import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EN-027 · Puerta visual sin bucle. Sin IA, sin Docker y sin navegador: la tarjeta (storyFlow) se prueba con procesos
 * sintéticos como el guardado de HU-214 y el arranque de la vista previa desde el pipeline con su contrato de código.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en027-'));
// Sin Docker: la vista previa del pipeline supera la comprobación de estado y falla después (docker_required…).
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');
const SRC = (f: string) => fs.readFileSync(path.join(REPO, 'apps', 'server', 'src', 'services', f), 'utf8');
const { buildStoryFlow } = await import('../src/services/storyFlow.ts');
const { isVisualPause, VISUAL_PAUSE_PREFIX } = await import('../src/services/gauntlet.ts');
const { visualGate } = await import('../src/services/visualCheck.ts');
const { DEFAULT_PIPELINE, nextRepeatCount, normalizePauseReason, samePause } = await import('../../../packages/domain/src/pipeline.ts');
const { startPreview } = await import('../src/services/preview.ts');
const { runVisualCheck } = await import('../src/services/visualCheck.ts');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { REPO_ROOT } = await import('../src/config.ts');

providersRepo.setCredential('anthropic', encryptSecret('credencial-simulada'), 'simulada');
providersRepo.setConnected('anthropic', ['claude-sonnet-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const WS = createCompany('Acme EN027').slug;

/** Proceso de historia REAL en «running» (autorizado) con su commit aplicado y cambios en apps/web/src, como HU-207. */
function runningStory(): string {
  const project = createProject(WS, `Producto ${Math.random().toString(36).slice(2, 7)}`, 'x', []);
  projectsRepo(WS).setRepository(project.id, REPO_ROOT, 'main');
  const procs = processesRepo(WS);
  const p = procs.create({ projectId: project.id, kind: 'story_execution', title: 'HU-EN027', estimatedUsd: 0, steps: [] } as any);
  procs.authorize(p.id, 1);
  procs.setResult(p.id, { plan: null, implementationSummary: 'x', changes: [{ path: 'apps/web/src/screens/Backlog.tsx', content: 'x' }], verifyCommands: [], review: null, applied: { branch: 'story/hu-en027', commit: COMMIT, worktree: REPO_ROOT }, verifications: [] } as any);
  assert.equal(procs.get(p.id)?.status, 'running', 'precondición: el proceso sigue en «running»');
  return p.id;
}
const errOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e: any) { return e; } };

const HU214_ID = 'a8dab576-2d48-4b33-955e-1f88875288ff';
const COMMIT = '1a2b3c4d5e6f7a8b';
const HU214_REASON = `Evidencia visual pendiente en el host (commit ${COMMIT}): verificación no disponible · última ejecución: no se pudo ejecutar en el host: La historia está trabajando: su código aún cambia. Acción: pulsa «Continuar» para repetir la verificación visual en el host (sin IA).`;
const REPAIR = 'Conceder otra corrección dirigida';
const REPEAT = 'Repetir la verificación visual (sin IA)';

function mkProc(reason: string, o: { web?: boolean; findings?: any[]; repeatCount?: number } = {}): any {
  return {
    id: HU214_ID, kind: 'story_execution', status: 'done', projectId: 'p1', backlogItemId: 'b1', estimatedUsd: 0, steps: [],
    createdAt: new Date().toISOString(),
    result: {
      changes: [{ path: o.web === false ? 'apps/server/src/services/algo.ts' : 'apps/web/src/screens/Backlog.tsx', content: 'x' }],
      applied: { branch: 'story/hu-214', commit: COMMIT, worktree: REPO },
      verifications: [],
      gauntlet: { mode: 'auto', maxRounds: 1, status: 'stopped', reason: null, rounds: o.findings ? [{ decision: 'stop', criteria: [], limitations: [], findings: o.findings }] : [] },
      pipeline: { state: 'paused', pauseKind: 'gauntlet', reason, config: { ...DEFAULT_PIPELINE }, failures: [], events: [], corrections: 0, ...(o.repeatCount != null ? { repeatCount: o.repeatCount } : {}) }
    }
  };
}
const labels = (flow: any) => flow.actions.map((a: any) => a.label as string);

// ---------------------------------------------------------------- Vista previa desde el propio pipeline

test('EN-027 · startPreview con el proceso en «running»: sin opción 409 «active»; con { pipeline: true } supera esa comprobación', async () => {
  const id = runningStory();
  const owner = await errOf(startPreview(WS, id));
  assert.ok(owner, 'la ruta del propietario no abre la vista previa mientras la historia trabaja');
  assert.equal(owner.statusCode, 409);
  assert.equal(owner.code, 'active');
  const pipe = await errOf(startPreview(WS, id, { pipeline: true }));
  // Sin Docker falla más adelante (docker_required, deps_missing…), pero NUNCA por el estado «running».
  assert.notEqual(pipe?.code, 'active', `con la opción del pipeline no se rechaza por «running» (obtenido: ${pipe?.code} ${pipe?.message ?? ''})`);
  assert.doesNotMatch(String(pipe?.message ?? ''), /La historia está trabajando/);
});

test('EN-027 · reproduce el bucle: runVisualCheck sin la opción vuelve a «La historia está trabajando»; como pipeline (visualStage) ya no', async () => {
  const id = runningStory();
  const gate = visualGate(WS, processesRepo(WS).get(id)!);
  assert.ok(gate.required && !!gate.commit && gate.routes.length > 0, `precondición: la puerta visual exige rutas (${gate.reasons.join(' · ')})`);
  // Antes de EN-027 visualStage llegaba aquí sin la opción: misma pausa en cada reanudación, sin gastar.
  const loop = await runVisualCheck(WS, id);
  assert.equal(loop.status, 'unavailable');
  assert.match(loop.detail, /La historia está trabajando/, 'sin la opción se reproduce la causa del bucle de HU-214');
  const fixed = await runVisualCheck(WS, id, { pipeline: true });
  assert.doesNotMatch(fixed.detail, /La historia está trabajando/, `como pipeline la vista previa del propio proceso no se rechaza por «running»: ${fixed.detail}`);
  assert.equal(processesRepo(WS).get(id)?.status, 'running', 'el proceso sigue en marcha: la verificación no lo detiene');
});

test('EN-027 · visualStage usa la opción interna y la ruta del propietario nunca', () => {
  const g = SRC('gauntlet.ts');
  const stage = g.slice(g.indexOf('export async function visualStage('), g.indexOf('export async function gauntletStage('));
  assert.ok(stage.includes('runVisualCheck(ctx.slug, ctx.processId, { pipeline: true })'), 'visualStage pide la vista previa como pipeline');
  const routes = fs.readFileSync(path.join(REPO, 'apps', 'server', 'src', 'routes', 'previews.ts'), 'utf8');
  assert.ok(!/pipeline:\s*true/.test(routes), 'la ruta del propietario nunca usa la opción interna');
});

// ---------------------------------------------------------------- Detección de la pausa visual

test('EN-027 · isVisualPause reconoce el motivo guardado de HU-214 y no la pausa normal del Evaluador', () => {
  assert.equal(VISUAL_PAUSE_PREFIX, 'Evidencia visual pendiente en el host');
  assert.equal(isVisualPause(HU214_REASON), true);
  assert.equal(isVisualPause('  evidencia visual pendiente en el host (commit x)'), true);
  assert.equal(isVisualPause('El Evaluador Gauntlet se detuvo con brechas bloqueantes: falta X.'), false);
  assert.equal(isVisualPause(null), false);
});

test('EN-027 · pausa guardada de HU-214: título propio, «Repetir la verificación visual (sin IA)» sin IA y sin corrección dirigida', () => {
  const flow: any = buildStoryFlow(mkProc(HU214_REASON));
  assert.ok(flow.issue, 'hay tarjeta de pausa');
  assert.doesNotMatch(flow.issue.title, /El Evaluador Gauntlet dejó brechas bloqueantes/);
  assert.match(flow.issue.title, new RegExp(`Falta la evidencia visual del commit ${COMMIT}`));
  const main = flow.actions.find((a: any) => a.primary);
  assert.equal(main?.label, REPEAT, `acciones: ${labels(flow).join(' | ')}`);
  assert.equal(main.id, 'pipeline_resume');
  assert.deepEqual(main.requires, ['authorization'], 'solo autorización: sin presupuesto de IA');
  assert.equal(main.pipeline?.maxCorrections, 0, 'no concede correcciones');
  assert.ok(!labels(flow).includes(REPAIR), 'sin hallazgos con evidencia no se ofrece la corrección dirigida');
  assert.ok(!labels(flow).includes('Continuar sin más evaluación'), 'no se salta la verificación visual obligatoria');
  assert.doesNotMatch(flow.issue.explanation, /pulsa «Continuar»/, 'el texto no pide un botón que no existe');
  assert.match(flow.issue.explanation, /propio proceso seguía en marcha/);
});

test('EN-027 · pausa visual sin el texto en el motivo: se reconoce porque la puerta visual exige evidencia que no hay', () => {
  const p = mkProc('Pausa del Evaluador sin brechas registradas.');
  const gate = visualGate('', p);
  assert.ok(gate.required && !gate.ok, `precondición: la puerta visual exige evidencia (${gate.reasons.join(' · ')})`);
  const flow: any = buildStoryFlow(p);
  assert.equal(flow.actions.find((a: any) => a.primary)?.label, REPEAT);
  assert.doesNotMatch(flow.issue.title, /brechas bloqueantes/);
  assert.ok(!labels(flow).includes(REPAIR));
});

test('EN-027 · con hallazgos del Evaluador con evidencia sí se ofrece la corrección dirigida (la principal sigue siendo repetir)', () => {
  const findings = [{ text: 'La tabla desborda a 375 px', severity: 'blocking', evidence: 'backlog-375.png: scrollWidth 420 / clientWidth 375', file: 'apps/web/src/screens/Backlog.tsx', unsupported: false }];
  const flow: any = buildStoryFlow(mkProc(HU214_REASON, { findings }));
  assert.ok(labels(flow).includes(REPAIR), labels(flow).join(' | '));
  assert.equal(flow.actions.find((a: any) => a.primary)?.label, REPEAT);
  const noEvidence: any = buildStoryFlow(mkProc(HU214_REASON, { findings: [{ ...findings[0], evidence: '' }] }));
  assert.ok(!labels(noEvidence).includes(REPAIR), 'un hallazgo sin evidencia no basta');
});

test('EN-027 · regresión: la pausa normal del Evaluador (sin web ni motivo visual) no cambia', () => {
  const flow: any = buildStoryFlow(mkProc('El Evaluador Gauntlet se detuvo con brechas bloqueantes: falta X. Lo hecho se conserva; decides tú.', { web: false, findings: [{ text: 'Falta X', severity: 'blocking', evidence: 'a.ts:1', file: 'a.ts' }] }));
  assert.match(flow.issue.title, /El Evaluador Gauntlet dejó brechas bloqueantes/);
  assert.ok(labels(flow).includes(REPAIR));
  assert.ok(labels(flow).includes('Continuar sin más evaluación'));
  assert.ok(!labels(flow).includes(REPEAT));
});

// ---------------------------------------------------------------- Pausa repetida sin gastar

test('EN-027 · la misma pausa con el mismo motivo y sin gasto incrementa repeatCount; con gasto u otro motivo vuelve a 0', () => {
  const a = { pauseKind: 'gauntlet' as const, reason: HU214_REASON, repeatCount: 0 };
  const b = { pauseKind: 'gauntlet' as const, reason: HU214_REASON.replace('La historia está trabajando: su código aún cambia', 'otra cosa') };
  assert.equal(normalizePauseReason(HU214_REASON).includes('última ejecución'), false, 'la parte «última ejecución» no cuenta');
  assert.equal(samePause(a, b), true, 'solo cambia la última ejecución: es la misma pausa');
  assert.equal(nextRepeatCount(a, b, false), 1);
  assert.equal(nextRepeatCount({ ...a, repeatCount: 1 }, b, false), 2);
  assert.equal(nextRepeatCount(a, b, true), 0, 'si hubo gasto no es una repetición');
  assert.equal(nextRepeatCount(a, { pauseKind: 'environment', reason: HU214_REASON }, false), 0);
  assert.equal(nextRepeatCount(null, b, false), 0, 'un resultado antiguo sin pausa previa');
});

test('EN-027 · la tarjeta dice que la reanudación volvió a la misma pausa sin gastar; sin repeatCount (guardado antiguo) no', () => {
  const flow: any = buildStoryFlow(mkProc(HU214_REASON, { repeatCount: 2 }));
  assert.match(flow.issue.explanation, /La reanudación volvió a la misma pausa con el mismo motivo sin gastar \(2 veces\)/);
  const old: any = buildStoryFlow(mkProc(HU214_REASON));
  assert.doesNotMatch(old.issue.explanation, /volvió a la misma pausa/);
});

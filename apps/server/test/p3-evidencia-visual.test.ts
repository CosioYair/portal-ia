import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Portal IA 3 · EN-029: el bucle de la evidencia visual. El criterio pedía capturas y accesibilidad; el Portal solo las
 * producía DESPUÉS de que QA aprobara; QA no podía aprobar sin ellas; su hallazgo «faltan las capturas» iba al
 * Desarrollador, que no puede lanzar la comprobación del host, y cada reanudación repetía lo mismo.
 * Ahora: la evidencia se produce antes de QA, QA la recibe, «faltan capturas» nunca va al equipo, y un trabajo que ya
 * quedó atrapado tiene una salida que hace algo. Sin IA, sin Docker y sin navegador.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p3vis-'));
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');
const SRC = (f: string) => fs.readFileSync(path.join(REPO, 'apps', 'server', 'src', 'services', f), 'utf8').replace(/\r\n/g, '\n');
const { buildStoryFlow, visualEvidenceBlock } = await import('../src/services/storyFlow.ts');
const { visualEvidencePresent, VISUAL_PAUSE_PREFIX } = await import('../src/services/gauntlet.ts');
const { dropSatisfiedVisualFindings, isVisualEvidenceFinding, qaEvidencePrompt } = await import('../src/services/qaGate.ts');
const { DEFAULT_PIPELINE } = await import('../../../packages/domain/src/pipeline.ts');

const COMMIT = '4401dba1c2d3e4f5';
// Textos REALES del proceso de EN-029 (hallazgos de QA y motivos de pausa).
const F_CAPTURAS = { severity: 'alta', text: 'Sigue sin haber capturas ni informe de axe del commit 4401dba. La puerta visual (scripts/visual-check.mjs) corre en el host y el Desarrollador no puede lanzarla desde el sandbox, así que es un bloqueo del entorno.', file: 'apps/web/visual-routes.json', evidence: 'No hay PNG ni report.json en data/evidence/<proceso>/visual/4401dba/.' };
const F_PRIMERA = { severity: 'alta', text: 'Faltan las capturas y el informe de axe. La puerta visual (scripts/visual-check.mjs) no se ejecutó o no dejó evidencia.', file: 'apps/web/visual-routes.json', evidence: 'x' };
const F_CODIGO = { severity: 'alta', text: 'El azulejo activo casi no se distingue del normal por el fondo (#EDEFF8 frente a #EEF0FF).', file: 'apps/web/src/tokens.css', evidence: '--color-tile-active: #EEF0FF' };
const F_DESBORDE = { severity: 'alta', text: '/ajustes a 375 px se desborda en horizontal según la evidencia visual del host.', file: 'apps/web/src/system.css', evidence: '/ajustes @375px: desbordamiento horizontal' };
const R_ENTORNO = 'QA no pudo validar por el entorno: a la imagen del sandbox le falta lo que exige el cambio. El código cumple todo el criterio que se puede comprobar. Falta un criterio: las 18 capturas y el informe de axe. La puerta visual corre en el host y no se ha ejecutado sobre el commit 4401dba.';
const R_REPETIDO = 'La corrección no produjo ningún cambio aplicable tras 2 intento(s) con estrategias distintas (visual-check.mjs: Detenido: el mismo fallo se repite\n- Sigue sin haber capturas ni informe de axe del commit 4401dba. La: Desarrollador Full Stack no cambia el código).';

const verdict = (v: string, findings: any[]): any => ({ approve: v === 'approved', verdict: v, summary: 's', issues: [], findings, suggestedTests: [], evidenceBased: true, overridden: null });
function mkProc(pauseKind: string, reason: string, o: { state?: string; review?: any; web?: boolean; imageRelated?: boolean } = {}): any {
  return {
    id: '7a24ea71-e8e5-4263-991f-a09e50b9b9ed', kind: 'story_execution', status: 'done', projectId: 'p1', backlogItemId: null, assignmentId: 'a1', estimatedUsd: 0, steps: [], createdAt: new Date().toISOString(),
    result: {
      changes: [{ path: o.web === false ? 'apps/server/src/services/algo.ts' : 'apps/web/src/tokens.css', content: 'x' }],
      applied: { branch: 'portal-ia/en-029', commit: COMMIT, worktree: REPO, files: [] }, verifications: [],
      review: o.review === undefined ? verdict('blocked_environment', [F_CAPTURAS]) : o.review, gauntlet: { mode: 'deep', maxRounds: 3, status: 'pending', reason: null, rounds: [] },
      pipeline: { state: o.state ?? 'stopped', pauseKind, reason, lastQaCommit: COMMIT, config: { ...DEFAULT_PIPELINE }, failures: [], events: [], corrections: 1, ...(o.imageRelated ? { imageRelated: true } : {}) }
    }
  };
}
const labels = (flow: any) => flow.actions.map((a: any) => a.label as string);
const GO = 'Hacer la comprobación visual y revisar de nuevo';

test('un hallazgo que solo dice «faltan las capturas» se reconoce; uno de código o de un desbordamiento real, no', () => {
  assert.equal(isVisualEvidenceFinding(F_CAPTURAS), true);
  assert.equal(isVisualEvidenceFinding(F_PRIMERA), true);
  assert.equal(isVisualEvidenceFinding({ text: 'No hay capturas a 375 px de /oficina.', file: null }), true);
  assert.equal(isVisualEvidenceFinding(F_CODIGO), false);
  assert.equal(isVisualEvidenceFinding(F_DESBORDE), false, 'un problema que la evidencia SÍ muestra es del código');
  assert.equal(isVisualEvidenceFinding({ text: 'Las capturas muestran el botón cortado en /panel a 768 px.', file: 'apps/web/src/screens/Panel.tsx' }), false);
});

test('con la evidencia ya producida, «faltan capturas» no va al equipo y NUNCA convierte el veredicto en aprobado', () => {
  const env = dropSatisfiedVisualFindings(verdict('blocked_environment', [F_CAPTURAS]));
  assert.equal(env.verdict, 'unable_to_verify'); assert.equal(env.approve, false); assert.equal(env.findings!.length, 0);
  assert.match(env.overridden!, /ya existen \(los hace el Portal\)/);
  const soloVisual = dropSatisfiedVisualFindings(verdict('rejected', [F_PRIMERA]));
  assert.equal(soloVisual.verdict, 'unable_to_verify', 'un rechazo sin nada corregible no lanza una corrección a ciegas');
  const mixto = dropSatisfiedVisualFindings(verdict('rejected', [F_PRIMERA, F_CODIGO]));
  assert.equal(mixto.verdict, 'rejected'); assert.deepEqual(mixto.findings!.map(f => f.file), ['apps/web/src/tokens.css'], 'lo de código sí se corrige');
  const ok = verdict('approved', []); assert.equal(dropSatisfiedVisualFindings(ok), ok, 'sin hallazgos visuales no se toca');
  const real = dropSatisfiedVisualFindings(verdict('rejected', [F_DESBORDE]));
  assert.equal(real.verdict, 'rejected'); assert.equal(real.findings!.length, 1);
});

test('QA recibe la evidencia visual y la regla: la produce el Portal, no se pide al Desarrollador ni bloquea por entorno', () => {
  const base = { criterion: 'Hay capturas a 375, 768 y 1440 px sin violaciones graves', plan: null, summary: '', changes: [], verifications: [], required: ['typecheck'], attempts: [], consultText: '' };
  const con = qaEvidencePrompt({ ...base, visual: 'Verificación visual (commit 4401dba): superada. Rutas: /oficina; anchos 375, 768, 1440 px.' });
  assert.match(con, /# Evidencia visual en el host \(la produce el Portal, no el Desarrollador/);
  assert.match(con, /Verificación visual \(commit 4401dba\): superada/);
  assert.match(con, /los genera el Portal en el host, nunca el Desarrollador/);
  assert.match(con, /no devuelvas "blocked_environment" por ello/);
  assert.match(con, /SÍ es un hallazgo de código/);
  const sin = qaEvidencePrompt(base);
  assert.doesNotMatch(sin, /# Evidencia visual en el host/, 'si el cambio no toca pantallas, no hay sección');
});

test('«existe la evidencia» exige informe del commit, disponible y con todas las capturas; que traiga problemas no la anula', () => {
  const g = (o: any) => ({ required: true, ok: false, missing: [], reasons: [], routes: ['/oficina'], commit: COMMIT, dir: 'x', report: { commit: COMMIT, status: 'ok', results: [{}] }, ...o });
  assert.equal(visualEvidencePresent(g({ ok: true })), true);
  assert.equal(visualEvidencePresent(g({ reasons: ['/oficina @375px: desbordamiento horizontal'] })), true, 'con problemas reales sigue siendo evidencia: los juzga QA');
  assert.equal(visualEvidencePresent(g({ report: null })), false);
  assert.equal(visualEvidencePresent(g({ missing: ['/oficina@375'] })), false);
  assert.equal(visualEvidencePresent(g({ report: { commit: COMMIT, status: 'unavailable', results: [] } })), false);
  assert.equal(visualEvidencePresent(g({ report: { commit: 'aaaaaaa1', status: 'ok', results: [{}] } })), false, 'de otro commit no vale');
  assert.equal(visualEvidencePresent(g({ required: false })), false);
});

test('EN-029 tal como quedó (detenido por «el mismo fallo se repite»): la salida es la comprobación visual, no otra corrección', () => {
  const p = mkProc('repeated_failure', R_REPETIDO);
  assert.equal(visualEvidenceBlock(p), true);
  const flow: any = buildStoryFlow(p);
  const main = flow.actions.find((a: any) => a.primary);
  assert.equal(main?.label, GO); assert.equal(main.id, 'pipeline_resume');
  assert.deepEqual(main.requires, ['authorization', 'ai_budget']);
  assert.equal(main.pipeline?.visualOnly, undefined, 'no es solo la puerta visual: después revisa QA');
  assert.ok(!labels(flow).includes('Seguir corrigiendo'), 'no se ofrece seguir corrigiendo: el equipo no tiene nada que corregir');
  assert.ok(!labels(flow).some((l: string) => /Pedir (al equipo|un cambio)/.test(l)), 'ni pedir cambios al equipo por este motivo');
  assert.match(flow.issue.title, /hace el Portal \(no el equipo\)/);
  assert.match(flow.issue.explanation, /El código no tiene nada pendiente por este motivo/);
  assert.equal(flow.issue.cause, 'environment');
});

test('EN-029 en su pausa «por el entorno»: no manda a reconstruir la imagen del sandbox (no le falta nada)', () => {
  const p = mkProc('environment', R_ENTORNO, { state: 'paused', imageRelated: true });
  const flow: any = buildStoryFlow(p);
  assert.equal(flow.actions.find((a: any) => a.primary)?.label, GO);
  assert.ok(!labels(flow).some((l: string) => /Reconstruir la imagen/.test(l)));
  assert.ok(!labels(flow).some((l: string) => /Continuar con la imagen nueva/.test(l)));
});

test('no se confunde con otros atascos: fallo de pruebas, cambio que no toca pantallas, QA ya aprobada', () => {
  const tests = mkProc('limit', 'test sigue fallando y se alcanzó el máximo de correcciones autorizadas (2). Lo hecho se conserva.', { review: verdict('rejected', [F_CODIGO]) });
  assert.equal(visualEvidenceBlock(tests), false); assert.ok(labels(buildStoryFlow(tests)).includes('Seguir corrigiendo'));
  assert.equal(visualEvidenceBlock(mkProc('repeated_failure', R_REPETIDO, { web: false })), false, 'sin pantallas no hay evidencia visual que pedir');
  assert.equal(visualEvidenceBlock(mkProc('repeated_failure', R_REPETIDO, { review: verdict('approved', []) })), false);
  // QA aprobó y falta la evidencia (EN-028): sigue el camino de siempre, «Repetir la verificación visual (sin IA)».
  const en028 = mkProc('gauntlet', `${VISUAL_PAUSE_PREFIX} (commit ${COMMIT}): verificación no disponible: axe-core no está instalado (npm i -D axe-core o PORTAL_AXE) · faltan capturas: /oficina@375.`, { review: verdict('approved', []) });
  assert.equal(buildStoryFlow(en028).actions.find((a: any) => a.primary)?.label, 'Repetir la verificación visual (sin IA)');
});

test('«evidencia visual superada» que espera a QA: el botón dice que continúa la revisión (con IA), no el Evaluador', async () => {
  const p = mkProc('gauntlet', `Evidencia visual superada en el host (commit ${COMMIT}). Falta la revisión de calidad de este commit con las capturas, que llama a la IA: no se lanzó porque «Repetir la verificación visual (sin IA)» no autoriza gasto.`, { state: 'paused' });
  // La evidencia existe de verdad en disco (si faltara, lo primero sería repetirla). Con un id propio: no afecta a otros casos.
  p.id = 'proc-evidencia-superada';
  const { visualDir, visualGate, VISUAL_WIDTHS } = await import('../src/services/visualCheck.ts');
  const dir = visualDir(p.id, COMMIT); fs.mkdirSync(dir, { recursive: true });
  const results = visualGate('', p).routes.flatMap((route: string) => VISUAL_WIDTHS.map((width: number) => { const shot = `${route.replace(/[^a-z0-9]+/gi, '_')}-${width}.png`; fs.writeFileSync(path.join(dir, shot), 'png'); return { route, width, status: 'ok', screenshot: shot, scrollWidth: width, clientWidth: width, violations: [] }; }));
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ commit: COMMIT, status: 'ok', results }));
  assert.equal(visualGate('', p).ok, true, 'precondición: la evidencia está y pasa');
  const flow: any = buildStoryFlow(p);
  const main = flow.actions.find((a: any) => a.primary);
  assert.equal(main?.label, 'Continuar con la revisión (con IA)'); assert.deepEqual(main.requires, ['authorization', 'ai_budget']);
  assert.ok(!labels(flow).includes('Pasar al Evaluador Gauntlet (con IA)'));
});

test('contrato del pipeline: la evidencia visual va ANTES de QA, QA vuelve a evaluar al tenerla y «sin IA» no la llama', () => {
  const pipe = SRC('storyPipeline.ts');
  const loop = pipe.slice(pipe.indexOf('export async function runPipelineStages('));
  const vis = loop.indexOf('await visualBeforeQa(ctx,'); const qa = loop.indexOf('if (qaRan) await qaStage(ctx, cfg);');
  assert.ok(vis > 0 && qa > vis, 'visualBeforeQa precede a qaStage');
  assert.match(loop, /const qaRan = qaRequested \|\| visualFresh \|\|/);
  assert.match(loop, /const visualFresh = visReady && !!r\.review\?\.verdict && r\.review\.verdict !== 'approved'/, 'una aprobación no se vuelve a pagar');
  const noAi = loop.indexOf('if (qaRan && cfg.visualOnly) throw new PipelinePause(');
  assert.ok(noAi > vis && noAi < qa, '«Repetir la verificación visual (sin IA)» se detiene antes de la llamada con coste');
  const stage = pipe.slice(pipe.indexOf('export async function qaStage('), pipe.indexOf('export async function runPipelineStages('));
  assert.ok(stage.includes('visual: vgate.required ? '), 'QA recibe el resumen de la evidencia visual');
  assert.ok(stage.includes('.split(vgate.dir)'), 'a QA van los nombres de las capturas, no la ruta de la carpeta del equipo');
  assert.match(stage, /const gated = vReady \? dropSatisfiedVisualFindings\(gated0\) : gated0;/);
  const g = SRC('gauntlet.ts'); const before = g.slice(g.indexOf('export async function visualBeforeQa('), g.indexOf('export async function visualStage('));
  assert.match(before, /if \(!gate\.required \|\| visualEvidencePresent\(gate\)\) return gate;/, 'si ya existe, no se repite');
  assert.match(before, /throw new PipelinePause\('gauntlet', scrubImageWords\(`\$\{VISUAL_PAUSE_PREFIX\}/, 'si no se puede producir, pausa con la causa visual (antes de pagar QA)');
  assert.doesNotMatch(before, /stepCall\(/, 'no llama a la IA');
});

// ---------------------------------------------------------------- Revisión independiente (Gauntlet) de este cambio

test('(Gauntlet M1) un hallazgo que CITA la evidencia es de código y nunca se retira, aunque diga «sin», «falta» o «no hay»', () => {
  for (const text of [
    'El botón "Guardar" queda sin nombre accesible (button-name) según el informe de axe en /ajustes @375px',
    'Falta contraste suficiente en el azulejo activo, como muestran las capturas a 1440 px',
    'No hay foco visible en /oficina según la evidencia visual del host',
    '/ajustes a 375 px se desborda: la tabla queda sin scroll interno según las capturas',
    'La sincronización del panel rompe el diseño que se ve en las capturas',
    'scripts/visual-check.mjs informa de desbordamiento horizontal en /ajustes @375px',
    'Pendiente de las capturas: comparar «en cola» y «en curso» uno al lado del otro.'
  ]) assert.equal(isVisualEvidenceFinding({ text, file: null }), false, text);
  assert.equal(isVisualEvidenceFinding({ text: 'Faltan las capturas del estado vacío.', file: 'apps/web/src/screens/Work.tsx' }), false, 'un archivo de pantalla es código');
  // Y un cambio legítimo en el propio script de verificación no se confunde con «no se ejecutó».
  assert.equal(isVisualEvidenceFinding({ text: 'El script no cierra el navegador si una ruta falla.', file: 'scripts/visual-check.mjs' }), false);
});

test('(Gauntlet m2) otras formas reales de decir «faltan las capturas» también se reconocen', () => {
  for (const text of ['Las capturas no se han generado.', 'No existen capturas del commit 4401dba.', 'No se adjuntan los PNG ni el report.json.', 'Capturas e informe de accesibilidad pendientes.', 'No hay evidencia de la verificación visual en el host: sigue pendiente.', 'La puerta visual (scripts/visual-check.mjs) no se ejecutó o no dejó evidencia.'])
    assert.equal(isVisualEvidenceFinding({ text, file: 'apps/web/visual-routes.json' }), true, text);
});

test('(Gauntlet m1) un bloqueo de entorno con OTRO motivo real sigue siendo de entorno; solo se retira lo de las capturas', () => {
  const otro = { severity: 'alta', text: 'A la imagen del sandbox le falta git: las pruebas de worktree no se pueden ejecutar.', file: 'docker/sandbox.Dockerfile', evidence: 'git: not found' };
  const v = dropSatisfiedVisualFindings(verdict('blocked_environment', [F_CAPTURAS, otro]));
  assert.equal(v.verdict, 'blocked_environment'); assert.deepEqual(v.findings!.map(f => f.file), ['docker/sandbox.Dockerfile']);
});

test('(Gauntlet M2) si las capturas EXISTEN y traen un problema real, no se presenta como «falta la comprobación»: sigue el camino de corregir', async () => {
  const { visualDir, visualGate, VISUAL_WIDTHS } = await import('../src/services/visualCheck.ts');
  const p = mkProc('repeated_failure', 'Dos correcciones seguidas no produjeron ningún cambio aplicable. /ajustes a 375 px se desborda según las capturas.', { review: verdict('rejected', [F_DESBORDE]) });
  p.id = 'proc-con-defecto-visual';
  const dir = visualDir(p.id, COMMIT); fs.mkdirSync(dir, { recursive: true });
  const results = visualGate('', p).routes.flatMap((route: string) => VISUAL_WIDTHS.map((width: number) => { const shot = `${route.replace(/[^a-z0-9]+/gi, '_')}-${width}.png`; fs.writeFileSync(path.join(dir, shot), 'png'); return { route, width, status: 'ok', screenshot: shot, scrollWidth: route === '/ajustes' && width === 375 ? 420 : width, clientWidth: width, violations: [] }; }));
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ commit: COMMIT, status: 'ok', results }));
  const g = visualGate('', p);
  assert.equal(g.ok, false); assert.equal(visualEvidencePresent(g), true, 'precondición: evidencia presente con un desborde');
  assert.equal(visualEvidenceBlock(p), false);
  const flow: any = buildStoryFlow(p);
  assert.ok(labels(flow).includes('Seguir corrigiendo')); assert.ok(!labels(flow).includes(GO));
  // Y la pausa «sin IA» previa a QA con problemas a la vista lleva a la revisión, no a repetir sin fin.
  const ready = mkProc('gauntlet', `Evidencia visual lista en el host, con problemas que debe juzgar la revisión de calidad (commit ${COMMIT}): /ajustes @375px: desbordamiento horizontal. Falta la revisión de calidad de este commit con las capturas, que llama a la IA.`, { state: 'paused', review: null });
  ready.id = p.id;
  const f2: any = buildStoryFlow(ready);
  assert.equal(f2.actions.find((a: any) => a.primary)?.label, 'Continuar con la revisión (con IA)');
  assert.match(f2.issue.title, /con problemas a la vista/);
});

test('(Gauntlet M4/m3) QA solo se repite si su veredicto se debía a las capturas; detenido por tope con ese motivo también se reconoce', async () => {
  const { verdictAboutMissingVisual } = await import('../src/services/qaGate.ts');
  assert.equal(verdictAboutMissingVisual(verdict('blocked_environment', [F_CAPTURAS])), true);
  assert.equal(verdictAboutMissingVisual(verdict('rejected', [F_CODIGO])), false, 'una pausa por la imagen del sandbox o por código no paga otra revisión');
  assert.equal(verdictAboutMissingVisual(verdict('blocked_environment', [{ severity: 'alta', text: 'A la imagen del sandbox le falta git.', file: null }])), false);
  const pipe = SRC('storyPipeline.ts');
  assert.match(pipe, /qaVisualCommit !== r\.applied\.commit && verdictAboutMissingVisual\(r\.review\);/);
  assert.match(pipe, /if \(cfg\.visualOnly && v\.verdict !== 'approved'\) throw new PipelinePause\('qa'/, '«sin IA» nunca llega a una corrección');
  const tope = mkProc('limit', 'QA sigue rechazando y se alcanzó el máximo de correcciones autorizadas (2). Lo hecho se conserva para tu revisión.', { review: verdict('rejected', [F_PRIMERA]) });
  assert.equal(visualEvidenceBlock(tope), true); assert.equal(buildStoryFlow(tope).actions.find((a: any) => a.primary)?.label, GO);
});

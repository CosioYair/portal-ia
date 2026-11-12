import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { VisualGate, VisualReport } from '../src/services/visualCheck.ts';

/**
 * HU-207 · Verificación visual obligatoria a 375, 768 y 1440 px. Sin navegador, sin axe-core y sin red: el script se
 * prueba con un navegador falso inyectado y la puerta con informes sintéticos. La ejecución real ocurre en el host.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu207-'));
delete process.env.PORTAL_SANDBOX;
process.env.PORTAL_MOCK_PROVIDER = '1';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');
const { evaluateVisualReport, loadRouteMap, routesForChanges, sameCommit, touchesWeb, visualSummary, VISUAL_WIDTHS } = await import('../src/services/visualCheck.ts');
const { IMAGE_MISSING } = await import('../src/services/storyPipeline.ts');
const { scrubImageWords } = await import('../src/services/gauntlet.ts');
const vc: any = await import(pathToFileURL(path.join(REPO, 'scripts', 'visual-check.mjs')).href);

const COMMIT = 'abcdef1234567890';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu207-out-'));

function goodReport(routes: string[], commit = COMMIT): VisualReport {
  const results = routes.flatMap(route => VISUAL_WIDTHS.map(width => ({ route, width, screenshot: `${vc.routeSlug(route)}-${width}.png`, overflow: false, scrollWidth: width, clientWidth: width, bodyScrollWidth: width, bodyClientWidth: width, violations: [{ id: 'region', impact: 'moderate', nodes: 1 }], status: 'ok', reasons: [] })));
  return { commit, routes, widths: [...VISUAL_WIDTHS], results, status: 'ok' };
}
const allExist = () => true;

// ---------------------------------------------------------------- Mapa de UX (archivo → rutas)

test('HU-207 · routesForChanges deduce las rutas con el mapa real de apps/web/visual-routes.json', () => {
  const map = loadRouteMap(REPO);
  assert.ok(map && map.entries.length > 0, 'el mapa de UX existe y tiene entradas');
  assert.deepEqual(routesForChanges(['apps/web/src/screens/Batches.tsx'], map), ['/lotes']);
  assert.deepEqual(routesForChanges(['apps/web/src/screens/Backlog.tsx'], map), ['/backlog']);
  const global = routesForChanges(['apps/web/src/tokens.css'], map);
  for (const r of ['/oficina', '/panel', '/backlog']) assert.ok(global.includes(r), `tokens.css cubre ${r}`);
  const twice = routesForChanges(['apps/web/src/screens/Office.tsx', 'apps/web/src/office.css'], map);
  assert.equal(new Set(twice).size, twice.length, 'sin rutas duplicadas');
  assert.ok(routesForChanges(['apps/web/src/components/AlgoNuevo.tsx'], map).length > 0, 'el comodín de components/ no deja archivos sin ruta');
  assert.deepEqual(routesForChanges(['apps/server/src/services/gauntlet.ts'], map), [], 'el servidor no exige capturas');
  assert.deepEqual(routesForChanges(['apps/web/src/screens/Backlog.tsx'], null), [], 'sin mapa no se inventan rutas');
});

test('HU-207 · cobertura del mapa: todo archivo de apps/web/src (screens/*.tsx, components/*.tsx, lib, css) deduce rutas', () => {
  const map = loadRouteMap(REPO);
  assert.ok(map && map.entries.length > 0);
  const webSrc = path.join(REPO, 'apps', 'web', 'src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else files.push(path.relative(REPO, full).split(path.sep).join('/'));
    }
  };
  walk(webSrc);
  const screens = files.filter(f => /^apps\/web\/src\/screens\/[^/]+\.tsx$/.test(f));
  const components = files.filter(f => /^apps\/web\/src\/components\/[^/]+\.tsx$/.test(f));
  assert.ok(screens.length > 0 && components.length > 0, 'se recorrieron screens/ y components/');
  const sinRuta = files.filter(f => routesForChanges([f], map).length === 0);
  assert.deepEqual(sinRuta, [], `archivos de apps/web/src sin ruta en visual-routes.json: ${sinRuta.join(', ')}`);
  // Archivos nuevos (aún no existen): la puerta no puede bloquear con «no se dedujo ninguna ruta».
  for (const nuevo of ['apps/web/src/screens/PantallaNueva.tsx', 'apps/web/src/components/AlgoNuevo.tsx', 'apps/web/src/hooks/useAlgo.ts', 'apps/web/src/nuevo.css']) {
    assert.ok(routesForChanges([nuevo], map).length > 0, `${nuevo} tiene rutas por comodín`);
  }
  // Ninguna entrada muerta: cada patrón coincide con al menos un archivo real (p. ej. {a,b} no está admitido).
  const muertas = map.entries.filter(e => routesForChanges(files, { entries: [e] }).length === 0).map(e => e.match);
  assert.deepEqual(muertas, [], `entradas de visual-routes.json que no coinciden con ningún archivo: ${muertas.join(', ')}`);
  for (const f of ['apps/web/src/components/TeamReady.tsx', 'apps/web/src/components/OrgEvaluationPanel.tsx']) {
    assert.ok(routesForChanges([f], map).includes('/oficina/organizacion'), `${f} → /oficina/organizacion`);
  }
});

test('HU-207 · sin siembra ni --vars, el mapa solo tiene rutas sin {marcadores} (las pantallas de detalle no bloquean siempre)', () => {
  const map = loadRouteMap(REPO)!;
  const withVars = map.entries.flatMap(e => (e.routes ?? []).filter(r => r.includes('{')).map(r => `${e.match} → ${r}`));
  assert.deepEqual(withVars, [], 'visualStage llama a runVisualCheck sin vars: una ruta con {marcador} daría «faltan datos sembrados» siempre');
  for (const f of ['apps/web/src/screens/StoryWorkspace.tsx', 'apps/web/src/story-flow.css', 'apps/web/src/screens/ProcessView.tsx', 'apps/web/src/components/Gauntlet.tsx', 'apps/web/src/screens/Batches.tsx', 'apps/web/src/screens/AgentDetail.tsx']) {
    const routes = routesForChanges([f], map);
    assert.ok(routes.length > 0, `${f} tiene rutas`);
    assert.ok(routes.every(r => !r.includes('{')), `${f}: ${routes.join(', ')}`);
  }
  assert.deepEqual(routesForChanges(['apps/web/src/screens/StoryWorkspace.tsx'], map), ['/backlog']);
  assert.deepEqual(routesForChanges(['apps/web/src/screens/ProcessView.tsx'], map), ['/actividad']);
  const src = fs.readFileSync(path.join(REPO, 'apps', 'server', 'src', 'services', 'gauntlet.ts'), 'utf8');
  assert.ok(src.includes('await runVisualCheck(ctx.slug, ctx.processId)'), 'visualStage no pasa vars: por eso el mapa no puede llevar marcadores');
});

test('HU-207 · cada ruta de visual-routes.json existe en apps/web/src/App.tsx (sin redirección ni comodín)', () => {
  const app = fs.readFileSync(path.join(REPO, 'apps', 'web', 'src', 'App.tsx'), 'utf8');
  const declared: string[] = [];
  for (const m of app.matchAll(/<Route\s+path="([^"]+)"\s+element=\{([^\n]*)/g)) {
    const [, p, element] = m;
    if (p.includes('*')) continue; // comodines (SelectRoute, catch-all): aceptarían cualquier ruta
    if (/^\s*<(Redirect|Navigate|AgentRedirect)\b/.test(element)) continue; // solo redirige: el script la marcaría como «ruta redirigida»
    declared.push(p);
  }
  assert.ok(declared.includes('/backlog') && declared.includes('/panel'), `se leyeron los path de App.tsx: ${declared.join(', ')}`);
  const toRe = (p: string) => new RegExp(`^${p.split('/').map(seg => {
    if (seg.startsWith(':')) return seg.endsWith('?') ? '(?:[^/]+)?' : '[^/]+';
    return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }).join('/').replace(/\/\(\?:\[\^\/\]\+\)\?/g, '(?:/[^/]+)?')}/?$`);
  const res = declared.map(toRe);
  const map = loadRouteMap(REPO)!;
  const routes = Array.from(new Set(map.entries.flatMap(e => e.routes ?? [])));
  assert.ok(routes.length > 0);
  const missing = routes.filter(r => {
    const asParam = r.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
    const sample = asParam.replace(/:[A-Za-z0-9_]+/g, 'x');
    return !declared.includes(asParam) && !res.some(re => re.test(sample));
  });
  assert.deepEqual(missing, [], `rutas del mapa que no existen en App.tsx: ${missing.join(', ')}`);
});

test('HU-207 · touchesWeb y sameCommit', () => {
  assert.equal(touchesWeb(['apps/web/src/styles.css']), true);
  assert.equal(touchesWeb(['.\\apps\\web\\src\\App.tsx']), true, 'rutas de Windows normalizadas');
  assert.equal(touchesWeb(['apps/server/src/app.ts', 'docs/estilos-ui.md']), false);
  assert.equal(sameCommit('abcdef1', COMMIT), true, 'un prefijo corto del mismo commit vale');
  assert.equal(sameCommit('abc', COMMIT), false, 'menos de 7 caracteres no identifica un commit');
  assert.equal(sameCommit('1234567', COMMIT), false);
});

// ---------------------------------------------------------------- evaluateVisualReport (puro)

test('HU-207 · evaluateVisualReport aprueba un informe completo del commit aplicado (moderate no bloquea)', () => {
  const v = evaluateVisualReport(goodReport(['/backlog', '/panel']), ['/backlog', '/panel'], COMMIT, '/x', allExist);
  assert.equal(v.ok, true, v.reasons.join(' · '));
  assert.deepEqual(v.missing, []);
});

test('HU-207 · evaluateVisualReport bloquea: falta un ancho, otro commit, desbordamiento, violación serious, unavailable, sin PNG, sin rutas', () => {
  const exp = ['/backlog'];
  const noWidth = goodReport(exp); noWidth.results = noWidth.results.filter(r => r.width !== 768);
  let v = evaluateVisualReport(noWidth, exp, COMMIT, '/x', allExist);
  assert.equal(v.ok, false); assert.ok(v.missing.includes('/backlog@768'));

  v = evaluateVisualReport(goodReport(exp, '9999999999'), exp, COMMIT, '/x', allExist);
  assert.equal(v.ok, false); assert.ok(v.reasons.some(r => /no del aplicado/.test(r)));

  const over = goodReport(exp); over.results[0] = { ...over.results[0], scrollWidth: 420, clientWidth: 375 };
  v = evaluateVisualReport(over, exp, COMMIT, '/x', allExist);
  assert.equal(v.ok, false); assert.ok(v.reasons.some(r => /desbordamiento horizontal/.test(r)));

  const bodyOver = goodReport(exp); bodyOver.results[1] = { ...bodyOver.results[1], bodyScrollWidth: 900, bodyClientWidth: 768 };
  assert.equal(evaluateVisualReport(bodyOver, exp, COMMIT, '/x', allExist).ok, false, 'también el desbordamiento del body');

  const serious = goodReport(exp); serious.results[2] = { ...serious.results[2], violations: [{ id: 'color-contrast', impact: 'serious', nodes: 3 }] };
  v = evaluateVisualReport(serious, exp, COMMIT, '/x', allExist);
  assert.equal(v.ok, false); assert.ok(v.reasons.some(r => /axe serious color-contrast/.test(r)));

  const critical = goodReport(exp); critical.results[0] = { ...critical.results[0], violations: [{ id: 'button-name', impact: 'critical', nodes: 1 }] };
  assert.equal(evaluateVisualReport(critical, exp, COMMIT, '/x', allExist).ok, false);

  const unavailable = { ...goodReport(exp), status: 'unavailable', reason: 'axe-core no está instalado' };
  v = evaluateVisualReport(unavailable, exp, COMMIT, '/x', allExist);
  assert.equal(v.ok, false, 'unavailable nunca es ok'); assert.ok(v.reasons.some(r => /no disponible/.test(r)));

  v = evaluateVisualReport(goodReport(exp), exp, COMMIT, '/x', p => !p.endsWith('backlog-1440.png'));
  assert.equal(v.ok, false); assert.ok(v.missing.includes('/backlog@1440 (sin PNG)'));

  v = evaluateVisualReport(goodReport(exp), [], COMMIT, '/x', allExist);
  assert.equal(v.ok, false, 'sin rutas deducidas la puerta bloquea'); assert.match(v.reasons[0], /no se dedujo ninguna ruta/);

  v = evaluateVisualReport(null, exp, COMMIT, '/x', allExist);
  assert.equal(v.ok, false); assert.equal(v.missing.length, 3, 'sin informe faltan las tres anchuras');

  v = evaluateVisualReport(goodReport(['/panel']), ['/panel', '/backlog'], COMMIT, '/x', allExist);
  assert.equal(v.ok, false, 'un informe que no cubre todas las rutas esperadas bloquea'); assert.ok(v.missing.includes('/backlog@375'));
});

test('HU-207 · visualSummary da al Evaluador rutas, anchos, desbordes, violaciones y capturas', () => {
  const report = goodReport(['/backlog']);
  const gate: VisualGate = { required: true, ok: true, missing: [], reasons: [], routes: ['/backlog'], commit: COMMIT, dir: path.join('data', 'evidence', 'p1', 'visual', COMMIT), report };
  const s = visualSummary(gate);
  assert.match(s, /superada/); assert.match(s, /375, 768, 1440/); assert.match(s, /\/backlog @768px: ok; scrollWidth 768 \/ clientWidth 768; axe graves 0/);
  assert.ok(s.includes('backlog-1440.png'));
  assert.match(visualSummary({ ...gate, required: false }), /no aplica/);
});

// ---------------------------------------------------------------- Puerta en gauntletStage (todos los modos)

test('HU-207 · gauntletStage llama a la puerta visual ANTES del modo off, del commit ya evaluado y de la rama sin Evaluador', () => {
  const src = fs.readFileSync(path.join(REPO, 'apps', 'server', 'src', 'services', 'gauntlet.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function gauntletStage('));
  const gate = body.indexOf('await visualStage(ctx, proc)');
  assert.ok(gate > 0, 'gauntletStage llama a visualStage');
  for (const exit of ["if (g.mode === 'off')", 'last.commit === commit', '!ev || ev.id === ctx.dev.id']) {
    const at = body.indexOf(exit);
    assert.ok(at > gate, `la puerta visual va antes de «${exit}»`);
  }
  const stage = src.slice(src.indexOf('export async function visualStage('), src.indexOf('export async function gauntletStage('));
  assert.equal((stage.match(/runVisualCheck\(/g) ?? []).length, 1, 'una sola ejecución en el host por paso, sin bucles');
  assert.ok(!/for \(|while \(/.test(stage), 'sin reintentos en bucle');
  assert.ok(stage.includes("throw new PipelinePause('gauntlet', scrubImageWords(`Evidencia visual pendiente en el host"), 'pausa con la causa visual y su acción');
  assert.ok(body.includes('visual.required ? visualSummary(visual)'), 'el Evaluador recibe el resumen visual');
});

test('HU-207 · la pausa visual no se clasifica como «falta en la imagen del sandbox» (IMAGE_MISSING real)', () => {
  const detail = 'Chromium no disponible (npx playwright install chromium): falta en la imagen; imagen del sandbox no lo tiene';
  assert.ok(IMAGE_MISSING.test(detail), 'el detalle crudo sí coincidiría');
  const msg = scrubImageWords(`Evidencia visual pendiente en el host (commit ${COMMIT}): verificación no disponible · última ejecución: ${detail}. Acción: pulsa «Continuar» para repetir la verificación visual en el host (sin IA).`);
  assert.equal(IMAGE_MISSING.test(msg), false, msg);
  assert.match(msg, /Evidencia visual pendiente en el host/);
  assert.match(msg, /pulsa «Continuar»/);
});

// ---------------------------------------------------------------- Script con navegador falso

type FakeOpts = { overflow?: boolean; redirect?: string; violations?: { id: string; impact: string; help?: string; nodes: number; targets?: string[] }[]; noScreen?: boolean };
function fakePage(o: FakeOpts = {}) {
  let current = ''; let width = 0; const shots: string[] = [];
  return {
    shots,
    async setViewportSize(v: { width: number }) { width = v.width; },
    async goto(u: string) { current = o.redirect ? new URL(o.redirect, u).toString() : u; },
    url() { return current; },
    async evaluate(fn: unknown) {
      if (fn === vc.PROBE) return { scrollWidth: o.overflow ? width + 40 : width, clientWidth: width, bodyScrollWidth: width, bodyClientWidth: width, hasScreen: !o.noScreen };
      if (fn === vc.AXE_RUN) return o.violations ?? [];
      throw new Error('evaluate inesperado');
    },
    async screenshot(opts: { path: string }) { fs.writeFileSync(opts.path, 'png'); shots.push(opts.path); },
    async addScriptTag() { /* axe falso */ },
    async close() { /* nada */ }
  };
}
function fakePlaywright(o: FakeOpts = {}) {
  return { chromium: { launch: async () => ({ newContext: async () => ({ newPage: async () => fakePage(o) }), close: async () => undefined }) } };
}

test('HU-207 · evaluatePage: ok, desbordamiento, serious frente a moderate, redirección, sin datos sembrados y sin axe', async () => {
  const out = tmp(); const base = { baseUrl: 'http://127.0.0.1:5999', outDir: out, axeSource: 'axe' };
  let r = await vc.evaluatePage(fakePage({ violations: [{ id: 'region', impact: 'moderate', nodes: 2 }] }), { ...base, route: '/backlog', width: 375 });
  assert.equal(r.status, 'ok', r.reasons.join('; ')); assert.equal(r.screenshot, 'backlog-375.png'); assert.ok(fs.existsSync(path.join(out, 'backlog-375.png')));
  r = await vc.evaluatePage(fakePage({ overflow: true }), { ...base, route: '/backlog', width: 768 });
  assert.equal(r.status, 'fail'); assert.equal(r.overflow, true); assert.ok(r.reasons.some((x: string) => /desbordamiento horizontal/.test(x)));
  r = await vc.evaluatePage(fakePage({ violations: [{ id: 'color-contrast', impact: 'serious', nodes: 1 }] }), { ...base, route: '/backlog', width: 1440 });
  assert.equal(r.status, 'fail'); assert.equal(r.blocking.length, 1);
  r = await vc.evaluatePage(fakePage({ redirect: '/configuracion/proveedor' }), { ...base, route: '/panel', width: 375 });
  assert.equal(r.status, 'fail'); assert.ok(r.reasons.some((x: string) => /ruta redirigida/.test(x)), 'una pantalla equivocada no se aprueba');
  r = await vc.evaluatePage(fakePage(), { ...base, route: '/lotes/{batch}', width: 375 });
  assert.equal(r.status, 'fail'); assert.match(r.reasons[0], /faltan datos sembrados para \{batch\}/);
  r = await vc.evaluatePage(fakePage(), { ...base, route: '/lotes/{batch}', width: 375, vars: { batch: 'b1' } });
  assert.equal(r.status, 'ok', r.reasons.join('; ')); assert.equal(r.screenshot, 'lotes-batch-375.png');
  r = await vc.evaluatePage(fakePage(), { ...base, route: '/backlog', width: 375, axeSource: null });
  assert.equal(r.status, 'unavailable');
});

test('HU-207 · summarize y exitCodeFor: unavailable nunca es ok; sin resultados es fallo', () => {
  assert.equal(vc.summarize({ commit: COMMIT, routes: ['/a'], unavailable: 'sin axe' }).status, 'unavailable');
  assert.equal(vc.summarize({ commit: COMMIT, routes: ['/a'], results: [] }).status, 'fail');
  assert.equal(vc.summarize({ commit: COMMIT, routes: ['/a'], results: [{ route: '/a', width: 375, status: 'ok', reasons: [] }] }).status, 'ok');
  assert.equal(vc.summarize({ commit: COMMIT, routes: ['/a'], results: [{ route: '/a', width: 375, status: 'ok', reasons: [] }, { route: '/a', width: 768, status: 'unavailable', reasons: ['x'] }] }).status, 'unavailable');
  assert.deepEqual([vc.exitCodeFor('ok'), vc.exitCodeFor('fail'), vc.exitCodeFor('unavailable')], [0, 1, 3]);
});

test('HU-207 · resolveAxe: PORTAL_AXE o el paquete instalado; si no hay, null (sin tocar el lockfile)', () => {
  const found = vc.resolveAxe({ env: { PORTAL_AXE: '/opt/axe' }, bases: [], exists: () => true, read: () => 'axe-src' });
  assert.equal(found.source, 'axe-src'); assert.ok(found.path.endsWith('axe.min.js'));
  assert.equal(vc.resolveAxe({ env: {}, bases: ['/x'], resolve: () => { throw new Error('no'); }, exists: () => false }), null);
  assert.equal(vc.resolveAxe({ env: {}, bases: ['/x'], resolve: () => '/x/node_modules/axe-core/axe.min.js', exists: () => true, read: () => 'a' }).path, '/x/node_modules/axe-core/axe.min.js');
});

test('HU-207 · main: PNG por ruta y ancho y report.json con el commit; sale 0 sin desbordamiento, 1 con él y 3 sin herramientas', async () => {
  const out = tmp();
  const args = ['--base-url', 'http://127.0.0.1:5999', '--routes', '/backlog,/panel', '--out', out, '--commit', COMMIT];
  assert.equal(await vc.main(args, { playwright: fakePlaywright(), axe: { path: 'x', source: 'axe' } }), 0);
  for (const r of ['backlog', 'panel']) for (const w of VISUAL_WIDTHS) assert.ok(fs.existsSync(path.join(out, `${r}-${w}.png`)), `${r}-${w}.png`);
  const rep = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(rep.commit, COMMIT); assert.equal(rep.status, 'ok'); assert.equal(rep.results.length, 6);
  assert.equal(evaluateVisualReport(rep, ['/backlog', '/panel'], COMMIT, out).ok, true, 'el informe real del script pasa la puerta');

  const bad = tmp();
  assert.equal(await vc.main(['--base-url', 'http://127.0.0.1:5999', '--routes', '/backlog', '--out', bad, '--commit', COMMIT], { playwright: fakePlaywright({ overflow: true }), axe: { path: 'x', source: 'axe' } }), 1);
  assert.equal(evaluateVisualReport(JSON.parse(fs.readFileSync(path.join(bad, 'report.json'), 'utf8')), ['/backlog'], COMMIT, bad).ok, false);

  const noPw = tmp();
  assert.equal(await vc.main(['--base-url', 'http://x', '--routes', '/backlog', '--out', noPw, '--commit', COMMIT], { playwright: null, axe: { path: 'x', source: 'axe' } }), 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(noPw, 'report.json'), 'utf8')).status, 'unavailable');
  const noAxe = tmp();
  assert.equal(await vc.main(['--base-url', 'http://x', '--routes', '/backlog', '--out', noAxe, '--commit', COMMIT], { playwright: fakePlaywright(), axe: null }), 3);
  const noChromium = tmp();
  assert.equal(await vc.main(['--base-url', 'http://x', '--routes', '/backlog', '--out', noChromium, '--commit', COMMIT], { playwright: { chromium: { launch: async () => { throw new Error('Executable doesn\'t exist'); } } }, axe: { path: 'x', source: 'axe' } }), 3);
  assert.equal(await vc.main(['--routes', '/backlog'], {}), 2, 'argumentos incompletos');
});

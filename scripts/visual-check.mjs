#!/usr/bin/env node
/**
 * Verificación visual obligatoria (HU-207). Se ejecuta en el HOST (no en el sandbox: allí no hay navegador ni red)
 * contra la vista previa de la rama:
 *
 *   node scripts/visual-check.mjs --base-url <preview> --routes </r1,/r2> --out <dir> --commit <sha> [--vars k=v,...]
 *
 * Por cada ruta y ancho (375, 768, 1440) guarda <ruta>-<ancho>.png (página completa). Mide el desbordamiento horizontal
 * (scrollWidth>clientWidth en el documento y en el body), comprueba que la pantalla pedida es la que se ve (sin
 * redirección) y pasa axe-core: las violaciones de impacto serious o critical bloquean.
 * Escribe <out>/report.json con {commit, routes, widths, results[], status}.
 * Códigos de salida: 0 = ok, 1 = fallo (desbordamiento, violación grave, ruta redirigida o sin datos), 2 = argumentos
 * inválidos, 3 = unavailable (falta Playwright, Chromium o axe-core; nunca se da por bueno).
 * axe-core se carga solo si está instalado (paquete local o PORTAL_AXE), igual que Playwright (o PORTAL_PLAYWRIGHT).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WIDTHS = [375, 768, 1440];
export const EXIT = { ok: 0, fail: 1, usage: 2, unavailable: 3 };
export const BLOCKING_IMPACTS = ['serious', 'critical'];
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const out = { baseUrl: '', routes: [], out: '', commit: '', vars: {}, timeoutMs: 30_000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1];
    if (k === '--base-url') { out.baseUrl = String(v ?? ''); i++; }
    else if (k === '--routes') { out.routes = String(v ?? '').split(',').map(s => s.trim()).filter(Boolean); i++; }
    else if (k === '--out') { out.out = String(v ?? ''); i++; }
    else if (k === '--commit') { out.commit = String(v ?? '').trim(); i++; }
    else if (k === '--timeout-ms') { out.timeoutMs = Math.max(5_000, Number(v) || 30_000); i++; }
    else if (k === '--vars') {
      for (const kv of String(v ?? '').split(',')) { const j = kv.indexOf('='); if (j > 0) out.vars[kv.slice(0, j).trim()] = kv.slice(j + 1).trim(); }
      i++;
    }
  }
  return out;
}

/** Nombre de archivo estable de una ruta (plantilla): «/» → «inicio», «/lotes/{batch}» → «lotes-batch». */
export function routeSlug(route) {
  const s = String(route).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return s || 'inicio';
}

/** Sustituye {marcadores} con los datos sembrados; devuelve los que faltan (la ruta no se captura a ciegas). */
export function fillRoute(route, vars = {}) {
  const missing = [];
  const p = String(route).replace(/\{([A-Za-z0-9_]+)\}/g, (m, k) => {
    if (vars[k] != null && vars[k] !== '') return encodeURIComponent(String(vars[k]));
    missing.push(k); return m;
  });
  return { path: p, missing };
}

/** Localiza axe-core sin tocar el lockfile: PORTAL_AXE (archivo o carpeta) o el paquete instalado. null si no está. */
export function resolveAxe(opts = {}) {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? (p => fs.existsSync(p));
  const read = opts.read ?? (p => fs.readFileSync(p, 'utf8'));
  const bases = opts.bases ?? [process.cwd(), SCRIPT_DIR];
  const resolve = opts.resolve ?? ((spec, base) => createRequire(path.join(base, 'noop.js')).resolve(spec));
  const candidates = [];
  if (env.PORTAL_AXE) candidates.push(/\.c?js$/.test(env.PORTAL_AXE) ? env.PORTAL_AXE : path.join(env.PORTAL_AXE, 'axe.min.js'));
  for (const b of bases) { try { candidates.push(resolve('axe-core/axe.min.js', b)); } catch { /* no instalado aquí */ } }
  for (const c of candidates) {
    if (c && exists(c)) { try { const source = read(c); if (source) return { path: c, source }; } catch { /* ilegible */ } }
  }
  return null;
}

export async function loadPlaywright(env = process.env) {
  try { const m = createRequire(path.join(process.cwd(), 'noop.js'))('playwright'); if (m?.chromium) return m; } catch { /* sigue */ }
  try { const m = createRequire(import.meta.url)('playwright'); if (m?.chromium) return m; } catch { /* sigue */ }
  const alt = env.PORTAL_PLAYWRIGHT ?? '/opt/npm-tools/node_modules/playwright/index.mjs';
  try { const m = await import(pathToFileURL(alt).href); const pw = m?.chromium ? m : m?.default; if (pw?.chromium) return pw; } catch { /* no está */ }
  return null;
}

/** Se ejecuta en la página: medidas de desbordamiento y si se ve una pantalla real. */
export const PROBE = () => {
  const d = document.documentElement; const b = document.body;
  return {
    scrollWidth: d.scrollWidth, clientWidth: d.clientWidth,
    bodyScrollWidth: b ? b.scrollWidth : 0, bodyClientWidth: b ? b.clientWidth : 0,
    hasScreen: !!document.querySelector('.page, main, [role="main"], h1')
  };
};

/** Se ejecuta en la página tras inyectar axe-core. */
export const AXE_RUN = async () => {
  const r = await window.axe.run(document, { resultTypes: ['violations'] });
  return r.violations.map(v => ({ id: v.id, impact: v.impact ?? null, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map(n => String(n.target)) }));
};

const normPath = u => { try { return new URL(u).pathname.replace(/\/+$/, '') || '/'; } catch { return String(u); } };

/** Evalúa una ruta en un ancho con una página de Playwright (o un navegador falso en las pruebas). */
export async function evaluatePage(page, { baseUrl, route, width, outDir, vars = {}, axeSource = null, timeoutMs = 30_000 }) {
  const result = { route, width, url: null, finalUrl: null, screenshot: null, overflow: false, scrollWidth: 0, clientWidth: 0, bodyScrollWidth: 0, bodyClientWidth: 0, violations: [], blocking: [], status: 'fail', reasons: [] };
  const filled = fillRoute(route, vars);
  if (filled.missing.length) { result.reasons.push(`faltan datos sembrados para ${filled.missing.map(m => `{${m}}`).join(', ')}`); return result; }
  const url = new URL(filled.path, baseUrl).toString(); result.url = url;
  try {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
  } catch (e) { result.reasons.push(`no se pudo abrir ${filled.path}: ${e?.message ?? e}`); return result; }
  result.finalUrl = page.url();
  const m = await page.evaluate(PROBE);
  Object.assign(result, { scrollWidth: m.scrollWidth, clientWidth: m.clientWidth, bodyScrollWidth: m.bodyScrollWidth, bodyClientWidth: m.bodyClientWidth });
  const file = `${routeSlug(route)}-${width}.png`;
  await page.screenshot({ path: path.join(outDir, file), fullPage: true });
  result.screenshot = file;
  if (normPath(result.finalUrl) !== normPath(url)) result.reasons.push(`ruta redirigida a ${normPath(result.finalUrl)}`);
  if (!m.hasScreen) result.reasons.push('no se encontró la pantalla (.page, main o h1)');
  result.overflow = m.scrollWidth > m.clientWidth || m.bodyScrollWidth > m.bodyClientWidth;
  if (result.overflow) result.reasons.push(`desbordamiento horizontal: scrollWidth ${Math.max(m.scrollWidth, m.bodyScrollWidth)} > clientWidth ${m.clientWidth}`);
  if (!axeSource) { result.status = 'unavailable'; result.reasons.push('axe-core no disponible'); return result; }
  try {
    // La vista previa impone CSP script-src 'self': el contexto se crea con bypassCSP; si aun así falla, nunca es ok.
    await page.addScriptTag({ content: axeSource });
    result.violations = await page.evaluate(AXE_RUN);
  } catch (e) {
    result.status = 'unavailable';
    result.reasons.push(`no se pudo ejecutar axe-core en la página (¿CSP?): ${e?.message ?? e}`);
    return result;
  }
  result.blocking = result.violations.filter(v => BLOCKING_IMPACTS.includes(v.impact));
  for (const v of result.blocking) result.reasons.push(`axe ${v.impact}: ${v.id} (${v.nodes} nodos)`);
  result.status = result.reasons.length ? 'fail' : 'ok';
  return result;
}

/** Informe final. unavailable si faltó una herramienta; fail si algún resultado falla o no hay resultados. */
export function summarize({ commit, routes, widths = WIDTHS, results = [], unavailable = null }) {
  let status = 'ok';
  if (unavailable || results.some(r => r.status === 'unavailable')) status = 'unavailable';
  else if (!results.length || results.some(r => r.status !== 'ok')) status = 'fail';
  const failures = results.filter(r => r.status !== 'ok').map(r => `${r.route} @${r.width}px: ${r.reasons.join('; ')}`);
  return { commit, routes, widths, results, status, reason: unavailable, failures, generatedAt: new Date().toISOString() };
}

export function exitCodeFor(status) { return status === 'ok' ? EXIT.ok : status === 'unavailable' ? EXIT.unavailable : EXIT.fail; }

export async function main(argv, deps = {}) {
  const a = parseArgs(argv);
  if (!a.baseUrl || !a.routes.length || !a.out || !a.commit) {
    console.error('Uso: node scripts/visual-check.mjs --base-url <url> --routes </r1,/r2> --out <dir> --commit <sha> [--vars k=v,...]');
    return EXIT.usage;
  }
  fs.mkdirSync(a.out, { recursive: true });
  const write = rep => { fs.writeFileSync(path.join(a.out, 'report.json'), JSON.stringify(rep, null, 2)); console.log(`visual-check: ${rep.status}${rep.reason ? ` · ${rep.reason}` : ''}`); for (const f of rep.failures) console.log(`  ✗ ${f}`); return exitCodeFor(rep.status); };
  const base = { commit: a.commit, routes: a.routes, widths: WIDTHS };
  const pw = deps.playwright !== undefined ? deps.playwright : await loadPlaywright();
  if (!pw?.chromium) return write(summarize({ ...base, unavailable: 'Playwright no está instalado (npm i -D playwright)' }));
  const axe = deps.axe !== undefined ? deps.axe : resolveAxe();
  if (!axe) return write(summarize({ ...base, unavailable: 'axe-core no está instalado (npm i -D axe-core o PORTAL_AXE)' }));
  let browser;
  try { browser = await pw.chromium.launch(); }
  catch (e) { return write(summarize({ ...base, unavailable: `Chromium no disponible (npx playwright install chromium): ${e?.message ?? e}` })); }
  const results = [];
  let unavailable = null;
  try {
    // bypassCSP solo en este Playwright: la CSP del proxy de la vista previa (script-src 'self') no cambia.
    const context = await browser.newContext({ bypassCSP: true });
    for (const route of a.routes) {
      for (const width of WIDTHS) {
        const page = await context.newPage();
        try { results.push(await evaluatePage(page, { baseUrl: a.baseUrl, route, width, outDir: a.out, vars: a.vars, axeSource: axe.source, timeoutMs: a.timeoutMs })); }
        catch (e) { results.push({ route, width, url: null, finalUrl: null, screenshot: null, overflow: false, violations: [], blocking: [], status: 'fail', reasons: [`error al evaluar la ruta: ${e?.message ?? e}`] }); }
        finally { await page.close().catch(() => undefined); }
      }
    }
  } catch (e) {
    unavailable = `no se pudo preparar el navegador: ${e?.message ?? e}`;
  } finally { await browser.close().catch(() => undefined); }
  return write(summarize({ ...base, results, unavailable }));
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(`visual-check: error inesperado: ${e?.stack ?? e}`); process.exit(EXIT.fail); });
}

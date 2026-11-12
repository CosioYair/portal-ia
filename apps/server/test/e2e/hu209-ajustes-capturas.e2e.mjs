// HU-209 · Evidencia visual de Ajustes a 375, 768 y 1440 px, con el navegador vinculado y sin vincular.
// Uso (con el Portal en marcha): node apps/server/test/e2e/hu209-ajustes-capturas.e2e.mjs
//   PORTAL_URL (por defecto http://127.0.0.1:4310) · PORTAL_EVIDENCE_DIR (por defecto data/evidence/)
// Solo lectura: no pulsa ningún botón. El estado «vinculado» se simula respondiendo a GET /api/owner/session; ninguna
// otra llamada se altera y ninguna acción con costo se dispara.
// Sale 0 si todo cumple, 1 si alguna medida falla y 2 si falta Playwright/Chromium (pendiente, nunca «ok» sin prueba).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.PORTAL_URL ?? 'http://127.0.0.1:4310').replace(/\/$/, '');
const OUT = process.env.PORTAL_EVIDENCE_DIR ?? fileURLToPath(new URL('../../../../data/evidence/', import.meta.url));
const WIDTHS = [375, 768, 1440];
const STATES = ['vinculado', 'sin-vincular'];

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try { return req('playwright'); } catch { /* sigue */ }
  try { return req(process.env.PORTAL_PLAYWRIGHT ?? '/opt/npm-tools/node_modules/playwright/index.mjs'); } catch { return null; }
}

/** Se ejecuta en la página: medidas de desbordamiento, tarjetas estiradas, botones fuera de su tarjeta y posición del Sello. */
function measure() {
  const doc = document.documentElement;
  const grid = document.querySelector('.settings-grid');
  const panel = document.querySelector('.settings-panel');
  const cards = [...document.querySelectorAll('.settings-grid > .settings-card')];
  const stretched = []; const overflowing = [];
  for (const card of cards) {
    const title = card.querySelector('h2')?.textContent ?? '?';
    const actual = card.getBoundingClientRect().height;
    const prev = card.style.alignSelf; card.style.alignSelf = 'start';
    const natural = card.getBoundingClientRect().height; card.style.alignSelf = prev;
    if (actual - natural > 1) stretched.push({ title, actual, natural });
    const c = card.getBoundingClientRect();
    for (const b of card.querySelectorAll('button, a.btn')) {
      const r = b.getBoundingClientRect();
      if (r.left < c.left - 1 || r.right > c.right + 1 || b.scrollWidth > b.clientWidth + 1) overflowing.push({ title, button: (b.textContent ?? '').trim(), left: r.left, right: r.right, cardLeft: c.left, cardRight: c.right });
    }
  }
  const g = grid?.getBoundingClientRect(); const p = panel?.getBoundingClientRect();
  return {
    scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, noHorizontalScroll: doc.scrollWidth <= doc.clientWidth,
    alignItems: grid ? getComputedStyle(grid).alignItems : null,
    cards: cards.length, stretched, overflowing,
    sealBelowGrid: !!(g && p && panel.querySelector('*') && p.top >= g.bottom - 1),
    sealOutsideCards: !!panel && !panel.closest('.settings-card'),
    ownerCard: [...cards].find(c => c.querySelector('h2')?.textContent === 'Propietario')?.querySelector('.settings-card__actions')?.textContent?.trim() ?? null,
  };
}

const pw = loadPlaywright();
if (!pw?.chromium) { console.error('Pendiente: Playwright no está instalado (npm i -D playwright && npx playwright install chromium).'); process.exit(2); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.error(`Pendiente: no se pudo abrir Chromium (${e.message}).`); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const results = []; let failed = false;
try {
  for (const state of STATES) {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      if (state === 'vinculado') {
        await ctx.addInitScript(() => { try { localStorage.setItem('portal-ia.owner-session', 'hu209-captura'); } catch { /* sin almacenamiento */ } });
        await ctx.route('**/api/owner/session', r => r.request().method() === 'GET' ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ owner: true, file: null }) }) : r.continue());
      } else {
        await ctx.addInitScript(() => { try { localStorage.removeItem('portal-ia.owner-session'); } catch { /* sin almacenamiento */ } });
      }
      const page = await ctx.newPage();
      await page.goto(`${BASE}/ajustes`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.settings-grid .settings-card');
      await page.waitForSelector('.settings-panel');
      await page.waitForTimeout(300);
      const m = await page.evaluate(measure);
      const file = path.join(OUT, `hu209-${width}-${state}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const expectOwner = state === 'vinculado' ? /Desvincular todos/ : /Vincular este navegador/;
      const ok = m.noHorizontalScroll && m.alignItems === 'start' && m.cards > 0 && !m.stretched.length && !m.overflowing.length && m.sealBelowGrid && m.sealOutsideCards && expectOwner.test(m.ownerCard ?? '');
      if (!ok) failed = true;
      results.push({ width, state, ok, screenshot: path.basename(file), ...m });
      console.log(`${ok ? 'OK   ' : 'FALLA'} ${width}px ${state}: scrollWidth ${m.scrollWidth} <= clientWidth ${m.clientWidth} · estiradas ${m.stretched.length} · botones fuera ${m.overflowing.length} · Sello debajo ${m.sealBelowGrid}`);
      await ctx.close();
    }
  }
} finally { await browser.close(); }
fs.writeFileSync(path.join(OUT, 'hu209-medidas.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
process.exit(failed ? 1 : 0);

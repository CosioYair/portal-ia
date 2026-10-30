import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-162: tokens de diseño, movimiento reducido y contraste AA (comprobación estática, sin IA).
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

function luminance(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

test('tokens.css existe y solo declara variables en :root con los valores actuales', () => {
  const css = read('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = css.match(/[^{}]+\{[^{}]*\}/g) ?? [];
  assert.equal(blocks.length, 1, 'tokens.css debe tener un único bloque');
  assert.match(blocks[0], /^\s*:root\s*\{/);
  for (const decl of blocks[0].slice(blocks[0].indexOf('{') + 1, -1).split(';').map(s => s.trim()).filter(Boolean)) {
    assert.match(decl, /^--[a-z0-9-]+\s*:/, `declaración no permitida en tokens.css: ${decl}`);
  }
  assert.match(css, /--color-placeholder\s*:\s*#686B72/i);
  const styles = read('styles.css').toLowerCase();
  for (const hex of ['#F4F3EF', '#1A1B1E', '#4F5259', '#686B72', '#E5E3DC', '#CFCCC3', '#EEECE6', '#0F6E6A', '#0B5652', '#FAF9F6', '#F7F6F2']) {
    assert.ok(css.includes(hex), `falta el token ${hex}`);
    assert.ok(styles.includes(hex.toLowerCase()), `${hex} no es un valor actual de styles.css`);
  }
});

test('main.tsx importa tokens.css antes que styles.css', () => {
  const main = read('main.tsx');
  const t = main.search(/import\s+['"]\.\/tokens\.css['"]/);
  const s = main.search(/import\s+['"]\.\/styles\.css['"]/);
  assert.ok(t >= 0, 'main.tsx no importa ./tokens.css');
  assert.ok(s >= 0, 'main.tsx no importa ./styles.css');
  assert.ok(t < s, 'tokens.css debe importarse antes que styles.css');
});

test('styles.css anula animaciones y transiciones con prefers-reduced-motion', () => {
  const css = read('styles.css');
  const i = css.search(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
  assert.ok(i >= 0, 'falta @media (prefers-reduced-motion: reduce)');
  const block = css.slice(i, i + 600);
  assert.match(block, /\*\s*,\s*\*::before\s*,\s*\*::after/);
  assert.match(block, /animation-duration\s*:\s*\.01ms\s*!important/);
  assert.match(block, /animation-iteration-count\s*:\s*1\s*!important/);
  assert.match(block, /transition-duration\s*:\s*\.01ms\s*!important/);
});

test('@keyframes fadeIn está definida junto al resto y .screen la usa', () => {
  const css = read('styles.css');
  const defs = css.match(/@keyframes\s+fadeIn\s*\{/g) ?? [];
  assert.equal(defs.length, 1, '@keyframes fadeIn debe definirse exactamente una vez');
  assert.match(css, /\.screen\s*\{[^}]*animation\s*:\s*fadeIn\b/);
  const fade = css.search(/@keyframes\s+fadeIn/);
  assert.ok(fade < css.search(/@keyframes\s+fadeUp/) && fade < css.search(/\.backdrop\s*\{/), 'fadeIn debe estar en el bloque de keyframes, antes de .backdrop');
});

test('el placeholder de .input alcanza contraste AA (≥4,5:1) sobre #FFFFFF y #F7F6F2', () => {
  const css = read('styles.css');
  const rule = css.match(/\.input::placeholder\s*\{\s*color\s*:\s*([^;}]+)/);
  assert.ok(rule, 'falta la regla .input::placeholder');
  const colors = [...rule[1].matchAll(/#[0-9a-f]{3,6}\b/gi)].map(m => m[0]);
  const token = read('tokens.css').match(/--color-placeholder\s*:\s*(#[0-9a-f]{3,6})/i);
  if (/var\(--color-placeholder/.test(rule[1]) && token) colors.push(token[1]);
  assert.ok(colors.length > 0, 'no se pudo determinar el color del placeholder');
  for (const c of colors) {
    for (const bg of ['#FFFFFF', '#F7F6F2']) {
      const r = contrast(c, bg);
      assert.ok(r >= 4.5, `placeholder ${c} sobre ${bg}: ${r.toFixed(2)}:1 < 4,5:1`);
    }
  }
});

test('el spinner de carga se anuncia y muestra «Cargando…»', () => {
  const ui = read('components/ui.tsx');
  assert.match(ui, /export function Spinner\b/);
  const body = ui.slice(ui.indexOf('export function Spinner'));
  assert.match(body, /role="status"/);
  assert.ok(body.includes('Cargando\u2026'), 'Spinner debe mostrar «Cargando…» (U+2026)');
  const app = read('App.tsx');
  assert.ok(!app.includes('aria-label="Cargando"'), 'App.tsx aún usa el spinner sin rol');
  assert.match(app, /<Spinner\s*\/>/);
});

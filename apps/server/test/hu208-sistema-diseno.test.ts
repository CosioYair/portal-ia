import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-208: sistema de diseño (SettingsRow, InfoPanel, botones que parten línea, borde terciario y paleta AA). Estática, sin IA.
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Copia de design-tokens-wiring.test.ts (allí no se exporta).
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
const tokensCss = () => read('tokens.css');
function tok(css: string, name: string): string {
  const m = css.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{3,6})\\b`, 'i'));
  assert.ok(m, `falta ${name} con un color #hex en tokens.css`);
  return m[1];
}
/** Cuerpos de las reglas cuyo selector empieza la línea exactamente así (no confunde «.notice .btn» ni «a.btn»). */
function rules(css: string, selector: string): string[] {
  const esc = selector.replace(/[.\-]/g, m => `\\${m}`);
  return [...css.matchAll(new RegExp(`^${esc}\\s*\\{([^}]*)\\}`, 'gm'))].map(m => m[1]);
}

test('kit.tsx exporta SettingsRow e InfoPanel, y system.css define sus clases', () => {
  const kit = read('components/kit.tsx');
  assert.match(kit, /export function SettingsRow\b/);
  assert.match(kit, /export function InfoPanel\b/);
  assert.match(kit, /role\s*=\s*'note'/, 'InfoPanel debe usar role="note" por defecto');
  const css = stripComments(read('system.css'));
  for (const cls of ['.settings-row', '.settings-row__label', '.settings-row__control', '.info-panel', '.info-panel__body']) {
    assert.ok(new RegExp(`${cls.replace(/[.\-]/g, m => `\\${m}`)}[\\s,{:]`).test(css), `system.css no define ${cls}`);
  }
});

test('.btn y .btn-sm tienen max-width:100% y pueden partir línea (sin height fija ni nowrap)', () => {
  const css = stripComments(read('system.css'));
  for (const sel of ['.btn', '.btn-sm']) {
    const bodies = rules(css, sel);
    assert.ok(bodies.length > 0, `falta la regla ${sel} en system.css`);
    for (const body of bodies) {
      assert.match(body, /max-width\s*:\s*100%/, `${sel} debe tener max-width:100%`);
      assert.doesNotMatch(body, /white-space\s*:\s*nowrap/, `${sel} no debe usar white-space:nowrap`);
      assert.doesNotMatch(body, /(?:^|[;{\s])height\s*:\s*(?!auto\b)/, `${sel} no debe tener height fija (usa min-height)`);
    }
  }
});

test('.btn-ghost tiene borde var(--color-tertiary-border) con contraste ≥3:1 sobre los fondos claros', () => {
  const css = stripComments(read('system.css'));
  const bodies = rules(css, '.btn-ghost');
  assert.ok(bodies.length > 0, 'falta la regla .btn-ghost en system.css');
  assert.ok(bodies.some(b => /border-color\s*:\s*var\(--color-tertiary-border\)/.test(b)), '.btn-ghost debe usar border-color: var(--color-tertiary-border)');
  const t = tokensCss();
  const border = tok(t, '--color-tertiary-border');
  for (const bg of ['--color-surface', '--color-bg', '--color-surface-alt', '--color-surface-pressed']) {
    const r = contrast(border, tok(t, bg));
    assert.ok(r >= 3, `--color-tertiary-border sobre ${bg}: ${r.toFixed(2)}:1 < 3:1`);
  }
});

test('los pares de texto de la paleta (existentes y nuevos de HU-208) alcanzan AA (≥4,5:1)', () => {
  const t = tokensCss();
  const PAIRS: [string, string][] = [
    ['--color-text', '--color-bg'], ['--color-text-med', '--color-bg'], ['--color-text-muted', '--color-surface'],
    ['--color-ok-text', '--color-ok-bg'], ['--color-err-text', '--color-err-bg'], ['--color-on-dark', '--color-primary'],
    ['--color-info-text', '--color-info-bg'], ['--color-text', '--color-info-bg'], ['--color-text-med', '--color-surface-alt'],
    ['--color-warn-text', '--color-warn-bg'], ['--color-ok-text-strong', '--color-ok-bg'], ['--color-err-text-strong', '--color-err-bg']
  ];
  for (const [fg, bg] of PAIRS) {
    const r = contrast(tok(t, fg), tok(t, bg));
    assert.ok(r >= 4.5, `${fg} sobre ${bg}: ${r.toFixed(2)}:1 < 4,5:1`);
  }
});

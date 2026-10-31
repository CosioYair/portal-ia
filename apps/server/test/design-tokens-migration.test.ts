import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-174: story-flow.css, manual-test-feedback.css y BudgetMeter.css consumen tokens (comprobación estática, sin IA).
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const FILES = ['story-flow.css', 'manual-test-feedback.css', 'components/BudgetMeter.css'];
const LOCAL_VARS = new Set(['--n']);
const LEGACY_VARS = ['--line', '--line-soft', '--line-strong', '--surface', '--surface-2', '--ink', '--ink-2', '--ink-3'];

const declaredTokens = new Set(
  [...stripComments(read('tokens.css')).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(m => m[1]),
);

const declarations = (css: string, prop: RegExp) =>
  [...css.matchAll(new RegExp(`(?:^|[;{\\s])(${prop.source})\\s*:\\s*([^;}]+)`, 'gi'))].map(m => m[2].trim());

for (const file of FILES) {
  const css = stripComments(read(file));

  test(`${file}: sin colores #hex ni rgb()/rgba() escritos a mano`, () => {
    const hex = css.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    assert.deepEqual(hex, [], `${file} aún tiene colores #hex; usa var(--color-…) de tokens.css: ${hex.join(', ')}`);
    const rgb = css.match(/rgba?\([^)]*\)/gi) ?? [];
    assert.deepEqual(rgb, [], `${file} aún tiene rgb()/rgba(); usa var(--color-…) de tokens.css: ${rgb.join(', ')}`);
  });

  test(`${file}: cada border-radius es var(--radius-…) o 0`, () => {
    for (const value of declarations(css, /border-radius/)) {
      const parts = value.replace(/!important/i, '').trim().split(/\s+/);
      for (const part of parts) {
        assert.ok(/^(var\(--radius(-[a-z0-9-]+)?\)|0)$/.test(part), `${file}: border-radius «${value}» debe usar var(--radius-…) o 0`);
      }
    }
  });

  test(`${file}: animaciones y transiciones usan var(--dur-…)`, () => {
    for (const value of declarations(css, /animation|transition|animation-duration|transition-duration/)) {
      const raw = value.replace(/var\([^)]*\)/g, '');
      assert.ok(!/(^|[\s,])\d*\.?\d+m?s\b/.test(raw), `${file}: duración escrita a mano en «${value}»; usa var(--dur-…)`);
    }
  });

  test(`${file}: cada var(--…) está declarada en tokens.css (salvo --n) y no quedan variables antiguas`, () => {
    for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/gi)) {
      const name = m[1];
      if (LOCAL_VARS.has(name)) continue;
      assert.ok(declaredTokens.has(name), `${file}: ${name} no está declarada en tokens.css`);
      assert.equal(m[2], ')', `${file}: var(${name}, …) no debe llevar valor de respaldo`);
    }
    for (const legacy of LEGACY_VARS) {
      assert.ok(!new RegExp(`var\\(\\s*${legacy}\\s*[,)]`).test(css), `${file}: aún usa la variable antigua ${legacy}`);
    }
  });
}

test('story-flow.css: la animación sf-run usa var(--dur-loop)', () => {
  const css = stripComments(read('story-flow.css'));
  assert.match(css, /animation\s*:\s*sf-run\s+var\(--dur-loop\)\s+linear\s+infinite/);
  assert.match(css, /@keyframes\s+sf-run\s*\{/);
});

test('manual-test-feedback.css: .mts-text sigue en una sola línea con overflow-wrap: anywhere', () => {
  const lines = read('manual-test-feedback.css').split(/\r?\n/).filter(l => /^\.mts-text\s*\{/.test(l));
  assert.equal(lines.length, 1, 'debe haber exactamente una línea que empiece por «.mts-text {»');
  const line = lines[0];
  assert.ok(line.includes('{') && line.trimEnd().endsWith('}'), 'la regla .mts-text debe abrir y cerrar en la misma línea');
  assert.match(line, /overflow-wrap\s*:\s*anywhere/);
  assert.ok(!/nowrap/i.test(line), '.mts-text no debe llevar nowrap');
  assert.ok(!/ellipsis/i.test(line), '.mts-text no debe llevar ellipsis');
});

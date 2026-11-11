import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// HU-200 · Barra de etapas usable a 375 px (comprobación estática, sin IA).
const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const src = read('../../web/src/components/StoryFlowPanel.tsx');
const css = read('../../web/src/story-flow.css').replace(/\/\*[\s\S]*?\*\//g, '');

const mediaBlock = (s: string, head: string) => {
  const a = s.indexOf(head);
  assert.ok(a >= 0, `falta «${head}»`);
  let depth = 0;
  for (let i = s.indexOf('{', a); i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return s.slice(a, i + 1);
  }
  assert.fail(`bloque «${head}» sin cerrar`);
};
const decl = (block: string, selector: string) => {
  const a = block.indexOf(selector);
  assert.ok(a >= 0, `falta la regla «${selector}»`);
  const open = block.indexOf('{', a);
  return block.slice(open + 1, block.indexOf('}', open));
};

const m480 = mediaBlock(css, '@media (max-width: 480px)');

test('HU-200 · a 480 px o menos la barra compacta es una fila flexible', () => {
  assert.match(decl(m480, '.sf-stages-compact {'), /display:\s*flex/);
  assert.equal((css.match(/@media \(max-width: 480px\)/g) ?? []).length, 1, 'un único bloque de 480 px');
});

test('HU-200 · las demás etapas son puntos con nombre accesible (clip, no display:none)', () => {
  const bar = decl(m480, '.sf-stages-compact .sf-stage:not(.is-current) .sf-bar {');
  assert.match(bar, /width:\s*8px/);
  assert.match(bar, /height:\s*8px/);
  const label = decl(m480, '.sf-stages-compact .sf-stage:not(.is-current) .sf-stage-label {');
  assert.match(label, /display:\s*block/);
  assert.match(label, /clip:\s*rect\(0 0 0 0\)/);
  assert.match(label, /position:\s*absolute/);
  assert.ok(!/\.sf-stage-label[^{]*\{[^}]*display:\s*none/.test(m480), 'el bloque de 480 px no oculta etiquetas con display:none');
});

test('HU-200 · la etapa actual muestra su nombre en una línea con «…»', () => {
  const label = decl(m480, '.sf-stages-compact .sf-stage.is-current .sf-stage-label,');
  assert.match(label, /display:\s*block/);
  assert.match(label, /white-space:\s*nowrap/);
  assert.match(label, /text-overflow:\s*ellipsis/);
  assert.match(decl(m480, '.sf-stages-compact .sf-stage.is-current {'), /min-width:\s*0/);
});

test('HU-200 · por encima de 480 px no cambia nada (regla global de 720 px intacta)', () => {
  assert.match(css, /@media \(max-width: 720px\) \{ \.sf-stage-label \{ display: none; \}/);
  assert.match(css, /\.sf-stages \{ display: grid; grid-template-columns: repeat\(var\(--n\), minmax\(0, 1fr\)\);/);
});

test('HU-200 · el componente conserva aria-current, title, etiqueta y aria-label de la lista', () => {
  assert.ok(src.includes('className="sf-stages sf-stages-compact"'));
  assert.ok(src.includes('aria-label={`Etapas: ${curIdx + 1} de ${flow.stages.length}, ${cur.label}`}'));
  assert.ok(src.includes("aria-current={s.key === flow.current ? 'step' : undefined}"));
  assert.match(src, /className=\{`sf-stage\$\{[^`]*`\}[^>]*title=\{`\$\{s\.label\}/);
  assert.ok(src.includes('<span className="sf-stage-label">{s.label}'));
});

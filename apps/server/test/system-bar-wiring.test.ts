import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-164: la barra amarilla (SystemBar) es una sola línea; detalles y confirmación se pliegan debajo.
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

test('la línea dice «Hay cambios sin activar · Actualizar» y «Detalles», con aria-expanded', () => {
  const bar = read('components/SystemBar.tsx');
  assert.match(bar, /<strong>Hay cambios sin activar<\/strong>/);
  assert.match(bar, /aria-expanded=\{open === 'details'\} onClick=\{\(\) => toggle\('details'\)\}>Detalles<\/button>/);
  assert.match(bar, /aria-expanded=\{open === 'confirm'\} onClick=\{\(\) => toggle\('confirm'\)\}>Actualizar<\/button>/, '«Actualizar» solo abre la confirmación');
  assert.match(bar, /className="sysbar-sep" aria-hidden="true">·</);
});

test('la casilla de autorización sigue siendo obligatoria y systemUpdate solo se llama desde update()', () => {
  const bar = read('components/SystemBar.tsx');
  assert.equal(bar.split('api.systemUpdate(').length - 1, 1, 'una sola llamada a api.systemUpdate');
  const upd = bar.slice(bar.indexOf('const update = async'), bar.indexOf('if (!st ||'));
  assert.ok(upd.includes('api.systemUpdate({ restart: true })'), 'la llamada está dentro de update()');
  assert.match(bar, /onClick=\{update\} disabled=\{!auth\}/);
  assert.equal(bar.split('onClick={update}').length - 1, 1, 'solo el botón de confirmar ejecuta update');
  assert.match(bar, /<span>Autorizo ejecutar <span className="mono">npm install<\/span>/);
  assert.match(bar, /setAuth\(false\); setPhase\('idle'\); setOpen\('confirm'\)/, '«Reintentar» deja la casilla sin marcar');
});

test('commits, archivos e historias solo se ven dentro del panel «Detalles»', () => {
  const bar = read('components/SystemBar.tsx');
  const start = bar.indexOf("{open === 'details' &&"); const end = bar.indexOf("{open === 'confirm' &&");
  assert.ok(start > 0 && end > start, 'existe el panel de detalles plegado');
  const details = bar.slice(start, end); const outside = bar.slice(0, start) + bar.slice(end);
  for (const f of ['st.changedFiles', 'st.startCommit', 'st.headCommit', 'st.buildCommit', 'st.stories']) {
    assert.ok(details.includes(f), `${f} está en Detalles`);
    assert.ok(!outside.includes(f), `${f} no aparece fuera de Detalles`);
  }
});

test('styles.css: .sysbar-line mide ≤56 px y no salta de línea; Shell conserva «Interfaz desactualizada»', () => {
  const css = read('styles.css');
  const rule = css.match(/\.sysbar-line\{([^}]*)\}/)?.[1] ?? '';
  const max = Number(rule.match(/max-height:(\d+)px/)?.[1] ?? NaN);
  assert.ok(max <= 56, `max-height ${max}px`);
  assert.match(rule, /white-space:nowrap/);
  assert.match(css, /\.sysbar-text\{[^}]*text-overflow:ellipsis/);
  assert.match(read('components/Shell.tsx'), /aria-label="Interfaz desactualizada"/);
});

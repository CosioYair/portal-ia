import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-209 · Ajustes sin huecos ni desbordes (lectura estática; el recorrido a 375/768/1440 px lo revisa QA con capturas).
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

test('«Tu nombre»: sin cambios el botón está desactivado y dice «Sin cambios»', () => {
  const s = read('screens/Settings.tsx');
  assert.match(s, /const unchanged = ownerName\.trim\(\) === savedName;/);
  // «Sin cambios» solo en idle/saved: durante la carga o tras un error dice «Guardar nombre» (desactivado).
  assert.match(s, /nameState === 'saving' \? 'Guardando…' : \(nameState === 'idle' \|\| nameState === 'saved'\) && unchanged \? 'Sin cambios' : 'Guardar nombre'/);
  assert.match(s, /disabled=\{nameState === 'loading' \|\| nameState === 'saving' \|\| nameState === 'error' \|\| unchanged\}/);
});

test('el Sello Portal IA va en una sección propia, debajo de la rejilla y fuera de «Tu nombre»', () => {
  const s = read('screens/Settings.tsx');
  const nameCard = s.slice(s.indexOf("'Tu nombre'"), s.indexOf("'Mejora automática de lecciones'"));
  assert.ok(nameCard.length > 0 && !nameCard.includes('<PortalSealPanel'), 'el Sello ya no está dentro de la tarjeta «Tu nombre»');
  const panel = s.indexOf('className="settings-panel"');
  assert.ok(panel > s.indexOf("'Sistema'"), 'la sección del Sello va después de la última tarjeta de la rejilla');
  assert.ok(s.indexOf('<PortalSealPanel ownerName={savedName} />') > panel, 'el Sello se pinta dentro de .settings-panel');
});

test('«Sistema» tiene su propia acción (copiar, sin costo) y no enlaza a /panel', () => {
  const s = read('screens/Settings.tsx');
  const sys = s.slice(s.indexOf("'Sistema'"), s.indexOf('className="settings-panel"'));
  assert.ok(!sys.includes('to="/panel"'), 'sin enlace al Resumen del proyecto');
  assert.match(sys, /disabled=\{!sys\} onClick=\{\(\) => void copySystem\(\)\}>Copiar datos del sistema</);
  assert.match(sys, /role="status"/); assert.match(sys, /'Copiado'/); assert.match(sys, /'No se pudo copiar: selecciona el texto de arriba'/);
  assert.match(s, /navigator\.clipboard\?\.writeText\) \{ await navigator\.clipboard\.writeText\(line\)/, 'comprueba que existe el portapapeles antes de usarlo');
  assert.match(s, /setTimeout\(\(\) => \{ copyTimer\.current = null; setCopyState\('idle'\); \}, 2000\)/, 'el aviso vuelve a idle a los 2 s');
  assert.match(s, /return \(\) => \{ alive\.current = false; if \(copyTimer\.current\) clearTimeout\(copyTimer\.current\); \};/, 'el temporizador se limpia al desmontar');
});

test('rejilla de Ajustes: columnas fluidas y tarjetas alineadas arriba (sin estirarse)', () => {
  const css = read('system.css');
  const grid = css.match(/\.settings-grid\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(grid, /minmax\(min\(280px, 100%\), 1fr\)/);
  assert.match(grid, /align-items:\s*start/);
  assert.match(css.match(/\.settings-card\s*\{[^}]*\}/)?.[0] ?? '', /min-width:\s*0/);
  assert.match(css, /\.settings-card \.mono\s*\{[^}]*overflow-wrap:\s*anywhere/);
  // Sin reglas que repitan .btn (HU-208) ni botones al 100 % en las tarjetas; la fila de acciones tiene su clase.
  assert.ok(!/\.settings-card \.btn\b/.test(css), 'no se redefine .btn dentro de .settings-card');
  assert.match(css, /\.settings-card__actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.ok(!/\.settings-card__actions[^{]*\.btn-ghost/.test(css), 'los ghost no se estiran');
  assert.match(read('screens/Settings.tsx'), /<div className="settings-card__actions">\{action\}<\/div>/);
});

test('OwnerStatus: textos cortos que caben en la tarjeta; el detalle va en title y aria-label', () => {
  const o = read('components/OwnerPairing.tsx');
  const status = o.slice(o.indexOf('export function OwnerStatus'));
  assert.match(status, />Desvincular este navegador</); assert.match(status, />Desvincular todos</);
  assert.match(status, /aria-label="Desvincular todos los navegadores \(también este\)"/);
  assert.ok(!/>Desvincular todos los navegadores/.test(status), 'el texto largo ya no es el visible');
  assert.match(status, /minWidth: 0/);
});

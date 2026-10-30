import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-163: tarjeta «Qué necesita tu atención» primero y secciones plegadas (comprobación estática, sin IA).
// Valida el cableado, no la conducta: QA comprueba en ejecución los estados con y sin pendientes.
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const count = (s: string, needle: string) => s.split(needle).length - 1;

test('la tarjeta de atención es la primera de la columna principal y usa api.inbox', () => {
  const dash = read('screens/Dashboard.tsx');
  assert.match(dash, /import \{ SummaryCard \} from '\.\.\/components\/SummaryCard\.tsx'/);
  const col = dash.indexOf("flex: '999 1 520px'");
  assert.ok(col >= 0, 'no se encontró la columna principal del Panel');
  const card = dash.indexOf('<SummaryCard', col);
  const firstSection = dash.indexOf('<section', col);
  assert.ok(card > col, 'falta <SummaryCard> en la columna principal');
  assert.ok(firstSection < 0 || card < firstSection, 'SummaryCard debe ir antes que cualquier <section> de la columna');
  assert.ok(card < dash.indexOf('Qué construye este proyecto'), 'la tarjeta de atención debe ir antes que la descripción');
  const block = dash.slice(card, dash.indexOf('/>', card));
  assert.match(block, /title="Qué necesita tu atención"/);
  assert.match(dash, /api\.inbox\(ws\.slug\)/, 'debe usar el mismo endpoint que la bandeja de Autorizaciones');
});

test('con pendientes muestra el contador y un único botón hacia /autorizaciones; sin pendientes, «Todo al día»', () => {
  const dash = read('screens/Dashboard.tsx');
  const card = dash.indexOf('<SummaryCard');
  const block = dash.slice(card, dash.indexOf('/>', card));
  assert.ok(block.includes('Todo al día'), 'falta el texto «Todo al día»');
  assert.match(block, /value=\{pendingCount > 0 \? pendingCount : undefined\}/);
  assert.ok(block.includes('decisión espera tu respuesta') && block.includes('decisiones esperan tu respuesta'), 'faltan los textos en singular y plural');
  assert.match(block, /action=\{pendingCount > 0 \? \{ label: 'Revisar y decidir', onClick: \(\) => navigate\('\/autorizaciones'\) \} : undefined\}/);
  assert.equal(count(dash, "'/autorizaciones'"), 1, '/autorizaciones debe ser el destino de un único botón');
  assert.match(dash, /pendingCount = attention\.phase === 'ready' \? attention\.count : 0/, 'solo hay cifra con datos cargados');
});

test('SummaryCard admite una sola acción y tiene estados de carga y error con «Reintentar»', () => {
  const sc = read('components/SummaryCard.tsx');
  assert.match(sc, /action\?: SummaryAction;/);
  assert.ok(!/action\?: SummaryAction\[\]|actions\?:/.test(sc), 'la acción no puede ser una lista');
  assert.equal(count(sc, 'action.onClick'), 1, 'debe haber un único botón de acción');
  assert.match(sc, /state === 'loading' && <Spinner \/>/);
  assert.match(sc, /<Notice kind="err">/);
  assert.ok(sc.includes('>Reintentar</button>'), 'falta el botón «Reintentar»');
  assert.match(sc, /aria-live="polite"/);
  for (const src of [sc, read('screens/Dashboard.tsx')]) {
    assert.ok(!/ai-adapters|complete\(|runProcess|startProcess|executeStory/.test(src), 'la tarjeta no debe consumir IA ni lanzar acciones con costo');
  }
});

test('Disclosure está cerrado por defecto y pliega descripción, objetivos, arquitectura y síntesis', () => {
  const dc = read('components/Disclosure.tsx');
  assert.match(dc, /defaultOpen = false/);
  assert.match(dc, /<details[^>]*open=\{defaultOpen \? true : undefined\}/);
  assert.ok(!/<details[^>]*\sopen(\s|>|=\{true\}|="")/.test(dc), 'Disclosure no puede llevar open fijo');
  assert.match(dc, /<summary/);
  const dash = read('screens/Dashboard.tsx');
  assert.match(dash, /import \{ Disclosure \} from '\.\.\/components\/Disclosure\.tsx'/);
  for (const title of ['Qué construye este proyecto', 'Objetivos iniciales', 'Arquitectura aprobada', 'Dirección del proyecto']) {
    assert.ok(dash.includes(`<Disclosure title="${title}"`), `«${title}» debe estar dentro de un Disclosure`);
  }
  assert.ok(!/<Disclosure[^>]*defaultOpen/.test(dash), 'los plegables del Panel deben estar cerrados por defecto');
  assert.ok(dash.includes('to="/conocimiento"'), 'se mantiene el enlace a Conocimiento');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matches } from '../src/services/runtimeChecks.ts';
import { parseRuntimeChecks } from '../src/services/devOutput.ts';

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

// Sin «|»: parseRuntimeChecks corta la línea por cada «|». «Tras el título aparece al menos uno de los tres textos»
// se expresa como doble negación con lookaheads, en lugar de una alternancia (a|b|c).
const ALTERNATIVES = ['Todo al día', 'decisión espera tu respuesta', 'decisiones esperan tu respuesta'];
const EXPECT_ATTENTION = `/Qué necesita tu atención(?!${ALTERNATIVES.map(a => `(?![\\s\\S]*${a})`).join('')})/`;

test('la comprobación en ejecución de la tarjeta de atención acierta con y sin pendientes y llega entera', () => {
  assert.ok(!EXPECT_ATTENTION.includes('|'), 'la expresión no puede contener «|» (el lector de COMPROBACIONES la trocearía)');
  const checks = parseRuntimeChecks([
    `- ui / | .summary-card | ${EXPECT_ATTENTION}`,
    '- ui / | main .card | Qué necesita tu atención',
    '- ui / | main details.disclosure:not([open]) | Qué construye este proyecto'
  ].join('\n'));
  assert.equal(checks.length, 3);
  assert.deepEqual(checks[0], { kind: 'ui', path: '/', selector: '.summary-card', expect: EXPECT_ATTENTION });
  assert.equal(checks[1].selector, 'main .card');
  assert.equal(checks[2].selector, 'main details.disclosure:not([open])');
  for (const text of [
    'Qué necesita tu atención\n1\ndecisión espera tu respuesta\nRevisar y decidir',
    'Qué necesita tu atención\n3\ndecisiones esperan tu respuesta\nRevisar y decidir',
    'Qué necesita tu atención\nTodo al día'
  ]) assert.ok(matches(text, EXPECT_ATTENTION), `debe aceptar: ${text.replace(/\n/g, ' ')}`);
  assert.ok(!matches('1 decisión espera tu respuesta Revisar y decidir', EXPECT_ATTENTION), 'sin el título no debe acertar');
  assert.ok(!matches('Qué necesita tu atención\nNo se pudo cargar. Reintentar', EXPECT_ATTENTION), 'en error no debe acertar');
  const dash = read('screens/Dashboard.tsx');
  assert.ok(dash.includes('title="Qué necesita tu atención"'), 'el título debe coincidir con el del Panel');
  for (const alt of ALTERNATIVES) assert.ok(dash.includes(`'${alt}'`), `«${alt}» debe aparecer literalmente en Dashboard.tsx`);
});

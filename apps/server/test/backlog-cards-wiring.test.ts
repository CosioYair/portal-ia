import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-165: Backlog en tarjetas con una acción principal (comprobación estática, sin IA).
// Valida el cableado, no la conducta: QA comprueba en ejecución las tarjetas, el bloque destacado y el plegable.
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const count = (s: string, needle: string) => s.split(needle).length - 1;

test('el Backlog ya no pinta tablas: cada historia de cada sección es una StoryCard', () => {
  const bl = read('screens/Backlog.tsx');
  assert.ok(!bl.includes('className="tbl"'), 'queda una tabla .tbl en Backlog.tsx');
  assert.ok(!/<table|<thead/.test(bl), 'no debe quedar <table> ni <thead> en Backlog.tsx');
  assert.match(bl, /import \{ StoryCard, STATUS_ICON[^}]*\} from '\.\.\/components\/StoryCard\.tsx'/);
  assert.match(bl, /<div className="story-cards">\{sec\.rows\.map\(it => \{[\s\S]*?<StoryCard key=\{it\.id\}/);
});

test('el estado de cada tarjeta lleva icono decorativo y texto (BACKLOG_STATUS o «Espera HU-x»)', () => {
  const sc = read('components/StoryCard.tsx');
  assert.match(sc, /aria-hidden="true">\{status\.icon\(\)\}/);
  assert.match(sc, /<span>\{status\.label\}<\/span>/);
  for (const st of ['done', 'in_progress', 'blocked', 'review', 'pending', 'discarded']) assert.match(sc, new RegExp(`\\b${st}: `), `falta el icono de «${st}»`);
  const bl = read('screens/Backlog.tsx');
  assert.match(bl, /const st = BACKLOG_STATUS\[it\.status\]/);
  assert.match(bl, /label: `Espera \$\{it\.dependsOn\}`/);
  assert.match(bl, /\{ label: st\.label, tone: st\.tone, icon: STATUS_ICON\[it\.status\] \}/);
});

test('StoryCard tiene como máximo 2 accionables visibles: la principal y «Más acciones»', () => {
  const sc = read('components/StoryCard.tsx');
  assert.equal(count(sc, 'primary.onClick'), 1, 'debe haber una única acción principal');
  assert.match(sc, /primary\?: StoryCardAction;/);
  assert.equal(count(sc, '<button'), 2, 'solo hay dos botones en el código: la principal y el de cada secundaria');
  const det = sc.indexOf('<details className="story-card-more">');
  const end = sc.indexOf('</details>', det);
  assert.ok(det > 0 && end > det, 'faltan las acciones secundarias dentro de <details>');
  const map = sc.indexOf('secondary.map(');
  assert.ok(map > det && map < end, 'las acciones secundarias deben estar dentro de <details>');
  assert.match(sc.slice(det, end), /<summary[^>]*>Más acciones<\/summary>/);
  assert.ok(!/<details[^>]*\sopen/.test(sc), '«Más acciones» debe estar cerrado al cargar');
});

test('no se pierde ninguna acción y las destructivas solo están en «Más acciones»', () => {
  const bl = read('screens/Backlog.tsx');
  for (const l of ['Cerrar historia', 'Continuar', 'Revisar diff', 'Devolver a pendiente', 'Cerrar sin ejecutar', 'Espacio de la historia', 'Ver proceso', 'Ver', 'Ejecutar']) {
    assert.ok(bl.includes(`'${l}'`), `falta la acción «${l}»`);
  }
  assert.match(bl, /secondary\.push\(\{ label: 'Devolver a pendiente'/);
  assert.match(bl, /secondary\.push\(\{ label: 'Cerrar sin ejecutar'/);
  assert.ok(!/primary = \{ label: '(Devolver a pendiente|Cerrar sin ejecutar)'/.test(bl), 'una acción destructiva no puede ser la principal');
  assert.match(bl, /primary = \{ label: 'Ejecutar', onClick: \(\) => setSel\(it\)/, '«Ejecutar» solo abre el diálogo');
});

test('el bloque destacado es lo primero de la columna principal, con siguiente y decisiones', () => {
  const bl = read('screens/Backlog.tsx');
  const col = bl.indexOf("flex: '999 1 560px'");
  assert.ok(col >= 0, 'no se encontró la columna principal del Backlog');
  const first = bl.indexOf('<section', col);
  assert.ok(bl.slice(first, bl.indexOf('>', first)).includes('backlog-highlight'), 'la primera <section> de la columna debe ser .backlog-highlight');
  const hist = bl.indexOf('<div className="h3">Historias</div>');
  assert.ok(hist > first, 'el bloque destacado debe ir antes de «Historias»');
  const block = bl.slice(first, hist);
  assert.ok(block.includes('Ejecutar siguiente') && block.includes('onClick={() => setSel(next)}'), 'falta «Ejecutar siguiente» en el bloque destacado');
  assert.equal(count(bl, 'Ejecutar siguiente'), 1, '«Ejecutar siguiente» ya no debe estar en la cabecera');
  assert.ok(block.includes('Pendientes de tu decisión'), 'faltan las decisiones pendientes');
  assert.ok(block.includes('Nada urgente: no hay decisiones pendientes'), 'falta el estado sin siguiente ni decisiones');
  const li = block.indexOf('decisions.map(d =>');
  assert.ok(li > 0, 'faltan las decisiones en el bloque destacado');
  assert.equal(count(block.slice(li, block.indexOf('</li>', li)), '<button'), 1, 'un solo botón por decisión');
  assert.ok(!bl.includes('<Notice kind="info">Tienes'), 'la Notice de decisiones debe desaparecer');
});

test('«Cómo funciona» está en un Disclosure cerrado al cargar', () => {
  const bl = read('screens/Backlog.tsx');
  assert.match(bl, /import \{ Disclosure \} from '\.\.\/components\/Disclosure\.tsx'/);
  assert.ok(bl.includes('<Disclosure title="Cómo funciona">'), '«Cómo funciona» debe ir dentro de <Disclosure>');
  assert.ok(!/<Disclosure[^>]*defaultOpen/.test(bl), 'el Disclosure del Backlog debe estar cerrado por defecto');
  assert.match(read('components/Disclosure.tsx'), /defaultOpen = false/);
});

test('ninguna acción con costo se lanza desde la tarjeta ni desde el bloque destacado', () => {
  const sc = read('components/StoryCard.tsx');
  assert.ok(!/executeStory|authorizeProcess|api\.|ai-adapters|complete\(/.test(sc), 'StoryCard no puede llamar a la API ni a la IA');
  const bl = read('screens/Backlog.tsx');
  assert.equal(count(bl, 'executeStory('), 1);
  assert.equal(count(bl, 'authorizeProcess('), 1);
  const exec = bl.indexOf('const execute = async');
  const call = bl.indexOf('api.executeStory(');
  assert.ok(exec > 0 && call > exec && call < bl.indexOf('};', exec), 'executeStory solo dentro de execute()');
  assert.equal(count(bl, 'onClick={execute}'), 1, 'execute solo se invoca desde un botón');
  assert.ok(bl.indexOf('onClick={execute}') > bl.indexOf('role="dialog"'), 'execute solo se invoca desde el modal de autorización');
  assert.match(bl, /disabled=\{!auth \|\| busy/, 'el botón del modal exige la casilla de autorización');
});

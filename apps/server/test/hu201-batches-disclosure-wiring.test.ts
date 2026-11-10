import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-201: Lotes usa el componente Disclosure (HU-163) en lugar de <details> hechos a mano, con el mismo contenido,
// los mismos data-testid y el teclado nativo del navegador. La comprobación visual y de teclado es manual (/lotes).
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

test('Batches.tsx no contiene <details> ni <summary> hechos a mano', () => {
  const batches = read('screens/Batches.tsx');
  assert.doesNotMatch(batches, /<details/);
  assert.doesNotMatch(batches, /<summary/);
});

test('Batches.tsx importa Disclosure y lo usa en las 4 secciones plegables', () => {
  const batches = read('screens/Batches.tsx');
  assert.match(batches, /import \{ Disclosure \} from '\.\.\/components\/Disclosure\.tsx';/);
  assert.ok((batches.match(/<Disclosure\b/g) ?? []).length >= 4, 'al menos 4 usos de <Disclosure>');
  assert.match(batches, /<Disclosure title="Cómo funciona un lote">/);
  assert.match(batches, /title=\{`Orden de la selección \(\$\{sel\.length\}\)`\}/);
  assert.match(batches, /title=\{`Plan detallado \(\$\{preview\.plan\.length\} historia\(s\)\)`\}/);
  assert.match(batches, /title="Orden de integración"/);
});

test('se conservan los data-testid y el orden de la selección se abre de inicio con 12 historias o menos', () => {
  const batches = read('screens/Batches.tsx');
  for (const id of ['batch-order', 'batch-preview', 'batch-integration-plan']) {
    assert.match(batches, new RegExp(`<Disclosure[^>]*testId="${id}"`), id);
  }
  assert.match(batches, /<Disclosure testId="batch-order" defaultOpen=\{sel\.length <= 12\}/);
});

test('Disclosure sigue basado en <details>/<summary> nativos y sus props nuevas son opcionales', () => {
  const d = read('components/Disclosure.tsx');
  assert.match(d, /<details className=/);
  assert.match(d, /<summary className="disclosure-summary">/);
  assert.match(d, /data-testid=\{testId\}/);
  assert.match(d, /className\?: string;/);
  assert.match(d, /testId\?: string;/);
  assert.match(d, /defaultOpen = false/, 'sigue cerrada por defecto');
});

test('los usos de Disclosure en otras pantallas siguen ahí', () => {
  for (const f of ['screens/Backlog.tsx', 'screens/Team.tsx']) {
    assert.match(read(f), /<Disclosure\b/, f);
  }
});

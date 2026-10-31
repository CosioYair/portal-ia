import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// HU-171 · Conocimiento con búsqueda, filtros y versiones agrupadas: lógica pura de lib/knowledgeIndex.ts y su cableado.
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const { docKind, groupByTitle, filterGroups, authorsOf, kindsOf, groupOf } = await import(pathToFileURL(path.join(webSrc, 'lib/knowledgeIndex.ts')).href);

const doc = (id: string, title: string, createdAt: string, extra: { body?: string; author?: string | null; version?: number } = {}) => ({
  id, projectId: 'p1', title, body: extra.body ?? '', authorAgentId: null, authorAgentName: extra.author === undefined ? 'Analista' : extra.author,
  processId: null, version: extra.version ?? 1, createdAt
});

const sample = () => [
  doc('a1', 'Análisis · Mercado', '2026-01-01T10:00:00.000Z', { body: 'Primera versión con pingüino' }),
  doc('a2', '  análisis ·   mercado ', '2026-02-01T10:00:00.000Z', { body: 'Segunda versión' }),
  doc('a3', 'Análisis · Mercado', '2026-03-01T10:00:00.000Z', { body: 'Tercera versión' }),
  doc('p1', 'Propuesta · Nuevo módulo', '2026-02-15T10:00:00.000Z', { author: 'Estratega', body: 'Decisión sobre el núcleo' }),
  doc('s1', 'Línea base del proyecto', '2026-01-10T10:00:00.000Z', { author: null, body: 'Estado inicial' }),
  doc('o1', 'Notas sueltas', '2026-01-05T10:00:00.000Z', { author: null })
];

test('agrupación: mismo título (ignorando mayúsculas y espacios) en un grupo, el más reciente primero y conteo de anteriores', () => {
  const groups = groupByTitle(sample());
  assert.equal(groups.length, 4);
  const an = groups.find((g: any) => g.latest.id === 'a3');
  assert.ok(an, 'el grupo de Análisis tiene como más reciente a a3');
  assert.deepEqual(an.older.map((d: any) => d.id), ['a2', 'a1']);
  assert.equal(an.kind, 'analisis');
  assert.equal(groups[0].latest.id, 'a3', 'los grupos van del más reciente al más antiguo');
  assert.equal(groupOf(groups, 'a1')?.latest.id, 'a3', 'una versión antigua se abre dentro de su grupo');
  assert.equal(groupOf(groups, null), null);
  // Empate de fecha: decide la versión.
  const tie = groupByTitle([doc('x1', 'Mismo', '2026-01-01T00:00:00.000Z', { version: 1 }), doc('x2', 'Mismo', '2026-01-01T00:00:00.000Z', { version: 2 })]);
  assert.equal(tie[0].latest.id, 'x2');
  assert.equal(tie[0].older.length, 1);
});

test('docKind: prefijos reales de cada servicio y «otro» si no encaja', () => {
  assert.equal(docKind('Encargo de evaluación inicial'), 'encargo');
  assert.equal(docKind('Propuesta · HU-12'), 'propuesta');
  assert.equal(docKind('Revisión del equipo · HU-12'), 'revision');
  assert.equal(docKind('Historias propuestas · etapa 3'), 'historias');
  assert.equal(docKind('Análisis · Mercado'), 'analisis');
  assert.equal(docKind('Evaluación organizativa · Portal · 2026-10-01'), 'evaluacion');
  assert.equal(docKind('Línea base del proyecto'), 'linea-base');
  assert.equal(docKind('HU-171 · Plan e implementación'), 'plan-historia');
  assert.equal(docKind('Notas sueltas'), 'otro');
  assert.equal(docKind('Mi análisis · no es prefijo'), 'otro', 'el prefijo va anclado al inicio');
});

test('búsqueda: sin mayúsculas ni acentos, en título y cuerpo de cualquier versión', () => {
  const groups = groupByTitle(sample());
  assert.deepEqual(filterGroups(groups, { q: 'ANALISIS' }).map((g: any) => g.latest.id), ['a3']);
  assert.deepEqual(filterGroups(groups, { q: 'decision' }).map((g: any) => g.latest.id), ['p1'], 'busca en el cuerpo');
  assert.deepEqual(filterGroups(groups, { q: 'PINGUINO' }).map((g: any) => g.latest.id), ['a3'], 'coincide en una versión anterior');
  assert.equal(filterGroups(groups, { q: '   ' }).length, 4, 'una búsqueda vacía no filtra');
  assert.equal(filterGroups(groups, { q: 'no existe nada así' }).length, 0);
});

test('filtros por autor (con «sistema») y por tipo, combinables con la búsqueda; selectores solo con valores presentes', () => {
  const groups = groupByTitle(sample());
  assert.deepEqual(authorsOf(groups), ['Analista', 'Estratega', 'sistema']);
  assert.deepEqual(kindsOf(groups), ['propuesta', 'analisis', 'linea-base', 'otro']);
  assert.deepEqual(filterGroups(groups, { author: 'sistema' }).map((g: any) => g.latest.id).sort(), ['o1', 's1']);
  assert.deepEqual(filterGroups(groups, { kind: 'propuesta' }).map((g: any) => g.latest.id), ['p1']);
  assert.deepEqual(filterGroups(groups, { author: 'sistema', kind: 'linea-base' }).map((g: any) => g.latest.id), ['s1']);
  assert.deepEqual(filterGroups(groups, { q: 'estado', author: 'sistema' }).map((g: any) => g.latest.id), ['s1']);
  assert.equal(filterGroups(groups, { q: 'estado', author: 'Estratega' }).length, 0);
  assert.equal(filterGroups(groups, { author: '', kind: '' }).length, 4);
});

test('cableado: Knowledge.tsx agrupa y filtra con el módulo, conserva ?doc= y muestra contador y estado vacío', () => {
  const src = read('screens/Knowledge.tsx');
  assert.match(src, /import \{[^}]*\bgroupByTitle\b[^}]*\} from '\.\.\/lib\/knowledgeIndex\.ts'/);
  assert.match(src, /import \{[^}]*\bfilterGroups\b[^}]*\} from '\.\.\/lib\/knowledgeIndex\.ts'/);
  assert.match(src, /q\.set\('doc', docId\)/, 'el documento abierto sigue en la URL');
  assert.match(src, /\{visibles\.length\} de \{groups\.length\} documentos/);
  assert.match(src, /Ningún documento coincide con la búsqueda/);
  assert.match(src, /Limpiar filtros/);
  assert.match(src, /versiones anteriores/);
});

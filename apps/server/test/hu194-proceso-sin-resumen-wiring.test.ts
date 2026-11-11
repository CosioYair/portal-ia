import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const src = read('../../web/src/components/StoryFlowPanel.tsx');
const view = read('../../web/src/screens/ProcessView.tsx');
const css = read('../../web/src/story-flow.css');

test('HU-194 · el panel tiene un modo proceso con cabecera compacta y «Ver historia»', () => {
  assert.ok(src.includes("const processMode = variant === 'process';"));
  const a = src.indexOf('{processMode && <div className="sf-process-head" data-process-mode');
  assert.ok(a >= 0, 'existe la cabecera del modo proceso');
  const b = src.indexOf('className="sf-summary"', a);
  assert.ok(b > a, 'la cabecera del modo proceso va antes del resumen');
  const head = src.slice(a, b);
  assert.ok(head.includes('Ver historia') && head.includes('to={`/historias/${'), 'enlaza «Ver historia» a /historias/<id>');
  assert.ok(head.includes('data-ver-historia'));
  for (const s of ['sf-stages', 'sf-meta', 'Siguiente paso:', 'fmtUsd', 'spentUsd']) assert.ok(!head.includes(s), `el modo proceso no contiene «${s}»`);
  assert.ok(css.includes('.sf-process-head'));
});

test('HU-194 · resumen, etapas, gasto y siguiente paso se ocultan en modo proceso', () => {
  assert.ok(src.includes('<div className="sf-summary" hidden={processMode}'), 'sf-summary (etapas compactas y sf-meta) se oculta en modo proceso');
  assert.ok(src.includes('<div className="sf-next" hidden={processMode}'), '«Siguiente paso:» se oculta en modo proceso');
  const iSum = src.indexOf('className="sf-summary"');
  const iStages = src.indexOf('className="sf-stages sf-stages-compact"');
  const iNext = src.indexOf('className="sf-next"');
  assert.ok(iSum >= 0 && iStages > iSum && iNext > iStages, 'las etapas compactas siguen dentro del resumen');
  assert.match(css, /\.sf-summary\[hidden\][^{]*\.sf-next\[hidden\][^{]*\{\s*display:\s*none;/, 'hidden gana a display:flex');
});

test('HU-194 · se conserva la actividad técnica y la vista de historia no cambia', () => {
  assert.match(src, /<Disclosure title="Actividad"[^>]*testId="sf-activity"/);
  assert.match(src, /testId="sf-live-call"/);
  assert.match(src, /testId="sf-agents-fold"/);
  assert.ok(src.includes('<DeliveryPanel d={flow.delivery} />'));
  assert.ok(src.includes('<div className="sf-actions" aria-label="Acciones">'));
  assert.ok(src.includes('Siguiente paso:'), 'la vista de historia mantiene «Siguiente paso:»');
  assert.match(src, /const fallback = variant === 'story' && !primary/);
});

test('HU-194 · ProcessView monta el panel en modo proceso y dice «Ver historia»', () => {
  assert.ok(view.includes('<div id="sec-flow" tabIndex={-1}><StoryFlowPanel proc={proc} variant="process"'));
  assert.ok(view.includes('Ver historia {Icon.arrow()}'));
  assert.ok(view.includes('to={`/historias/${proc.backlogItemId}`}'));
  assert.ok(!view.includes('Espacio de la historia'), 'un solo nombre para volver a la historia');
  assert.ok(view.includes('<ProcessHeader'), 'el siguiente paso sigue en ProcessHeader');
});

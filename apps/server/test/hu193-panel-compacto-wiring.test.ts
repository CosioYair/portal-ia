import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const src = read('../../web/src/components/StoryFlowPanel.tsx');
const css = read('../../web/src/story-flow.css');

const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  assert.ok(a >= 0, `falta «${from}»`);
  const b = s.indexOf(to, a + from.length);
  assert.ok(b > a, `falta «${to}» después de «${from}»`);
  return s.slice(a, b);
};

test('HU-193 · una sola línea de resumen con etapas compactas, antes del siguiente paso', () => {
  assert.match(src, /import \{ Disclosure \} from '\.\/Disclosure\.tsx';/);
  const iSum = src.indexOf('className="sf-summary"');
  const iStages = src.indexOf('className="sf-stages sf-stages-compact"');
  const iNext = src.indexOf('className="sf-next"');
  assert.ok(iSum >= 0 && iStages > iSum && iNext > iStages, 'sf-summary contiene la barra compacta y va antes de sf-next');
  assert.ok(src.includes('Siguiente paso:'));
  assert.ok(!src.includes('Ahora: '), 'el avance no se repite con «Ahora: …»');
  assert.ok(!src.includes('className="sf-now"'));
  for (const sel of ['.sf-summary', '.sf-stages-compact', '.sf-next', '.sf-more']) assert.ok(css.includes(sel), `story-flow.css define ${sel}`);
});

test('HU-193 · un único botón principal; las secundarias, dentro de «Más acciones»', () => {
  const block = between(src, '<div className="sf-actions" aria-label="Acciones">', '{!readOnly && authorizeSlot}');
  const iMore = block.indexOf('title="Más acciones"');
  assert.ok(iMore > 0, '«Más acciones» es un Disclosure dentro de las acciones');
  const head = block.slice(0, iMore);
  const more = block.slice(iMore);
  assert.equal((head.match(/btn-primary/g) ?? []).length, 2, 'solo el principal o el enlace de respaldo');
  assert.match(src, /const fallback = variant === 'story' && !primary/, 'el respaldo solo aparece si no hay acción principal');
  assert.ok(!more.includes('btn-primary'), '«Más acciones» no contiene botones destacados');
  assert.ok(more.includes('secondary.map(') && more.includes('btn btn-secondary'));
  assert.ok(head.includes("subForm ? 'btn-secondary' : 'btn-primary'"), 'con un formulario abierto el principal pasa a secundario');
});

test('HU-193 · agentes, llamada en curso y actividad plegados con Disclosure', () => {
  assert.match(src, /<Disclosure title=\{`Agentes · \$\{agents\.length\}`\}[^>]*testId="sf-agents-fold"/);
  assert.match(src, /proc\.status === 'running'[^\n]*testId="sf-agents-fold"/);
  assert.match(src, /<Disclosure title=\{`Llamada en curso · [^\n]*LIVE_TXT\[[^\n]*testId="sf-live-call"/);
  assert.match(src, /<Disclosure title="Actividad"[^>]*testId="sf-activity"/);
});

test('HU-193 · DeliveryPanel solo muestra el detalle de la entrega', () => {
  assert.ok(src.includes('<DeliveryPanel d={flow.delivery} />'));
  assert.ok(!/<DeliveryPanel[^>]*(running=|next=)/.test(src), 'el uso ya no pasa running ni next');
  const start = src.indexOf('function DeliveryPanel(');
  assert.ok(start >= 0);
  // El tramo llega hasta PipelineActivity para incluir las funciones auxiliares de DeliveryPanel (DeliveryDetail).
  const end = src.indexOf('\nfunction PipelineActivity(', start);
  assert.ok(end > start, 'PipelineActivity va después de DeliveryPanel');
  const body = src.slice(start, end);
  assert.ok(body.includes('function DeliveryDetail('), 'el tramo analizado incluye DeliveryDetail');
  const sig = body.slice(0, body.indexOf('{', body.indexOf(')')));
  assert.ok(!/running|next/.test(sig), 'la firma no declara running ni next');
  for (const s of ['running', 'next', 'Siguiente', 'sf-stages', 'sf-now', 'Ahora']) assert.ok(!body.includes(s), `DeliveryPanel/DeliveryDetail no contiene «${s}»`);
  assert.ok(body.includes('Detalle de la entrega'));
});

test('HU-193 · se conservan las salvaguardas existentes', () => {
  assert.ok(src.includes('const HANDLED = new Set<FlowActionId>(['));
  assert.ok(src.includes('const closed = !!proc.closure'));
  assert.ok(src.includes('Esta historia ya está'));
  assert.ok(src.includes('authorizeSlot') && src.includes('onAuthorize'));
  assert.ok(!/(^|[^\w.])(window\.)?(prompt|confirm|alert)\(/m.test(src), 'sin diálogos del navegador');
});

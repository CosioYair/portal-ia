import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-199 · Estilo del chat con clases y tarjetas compactas (comprobación estática sobre el código fuente, sin IA).
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

const chat = () => read('components/AssistantChat.tsx');
const css = () => read('styles.css');

/** Cuerpo de una función de nivel superior: desde su declaración hasta la siguiente `function ` de nivel superior. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `no se encontró function ${name}`);
  const next = src.indexOf('\nfunction ', start + 1);
  const nextExport = src.indexOf('\nexport function ', start + 1);
  const ends = [next, nextExport].filter(i => i > start);
  return src.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test('AssistantChat no tiene estilos en línea (style={{)', () => {
  const src = chat();
  assert.ok(!src.includes('style={{'), 'AssistantChat.tsx no debe contener style={{');
  assert.ok(!/\bstyle=\{/.test(src), 'AssistantChat.tsx no debe usar el atributo style');
});

test('las respuestas del asistente se muestran con Markdown dentro de .msg-bubble--assistant', () => {
  const src = chat();
  assert.ok(src.includes("'msg-bubble--assistant'"), 'la burbuja del asistente usa la clase msg-bubble--assistant');
  assert.ok(src.includes('<Markdown text={m.content} />'), 'las respuestas se renderizan con <Markdown>');
});

test('«pensando» se anuncia con role="status"', () => {
  const src = chat();
  const line = src.split(/\r?\n/).find(l => l.includes('El asistente está pensando'));
  assert.ok(line, 'existe el indicador «El asistente está pensando…»');
  assert.match(line, /role="status"/, 'el indicador lleva role="status"');
  assert.match(line, /aria-live="polite"/);
  assert.match(line, /className="assist-thinking[^"]*"/);
});

test('ProposalCard: importe visible, un solo botón y «Detalles» plegado', () => {
  const card = fnBody(chat(), 'ProposalCard');
  const buttons = card.match(/<button\b/g) ?? [];
  assert.equal(buttons.length, 1, `ProposalCard debe tener exactamente un <button> (tiene ${buttons.length})`);
  const details = card.match(/<details\b[^>]*>/g) ?? [];
  assert.equal(details.length, 1, 'ProposalCard tiene un único <details>');
  assert.ok(!/\bopen\b/.test(details[0]!), '«Detalles» está plegado por defecto (sin atributo open)');
  assert.ok(card.includes('<summary>Detalles</summary>'), 'el <summary> dice «Detalles»');
  assert.ok(card.includes('fmtUsd(action.estimatedUsd'), 'la tarjeta muestra el importe estimado');
  assert.match(card, /proposal-card__amount/, 'el importe va en la cabecera (.proposal-card__amount)');
  assert.match(card, /type="checkbox"/, 'la casilla de autorización explícita sigue visible');
  // El presupuesto y el enlace al proceso quedan dentro de «Detalles».
  const inside = card.slice(card.indexOf('<details'), card.indexOf('</details>'));
  assert.ok(inside.includes('Presupuesto máximo (USD)'), 'el presupuesto está dentro de «Detalles»');
  assert.match(inside, /<Link className="lnk"/, 'el enlace al proceso es un Link dentro de «Detalles»');
  // La lógica de autorización no cambia.
  assert.ok(card.includes('api.authorizeProcess('));
  assert.ok(card.includes('api.resolveAssistantProposal('));
  assert.match(card, /disabled=\{!auth/, 'el botón exige la autorización explícita');
});

test('styles.css: respuestas a ~72ch y clases nuevas solo con tokens, sin valores de respaldo', () => {
  const sheet = css();
  assert.match(sheet, /\.msg-bubble--assistant\{[^}]*max-width:min\(72ch,100%\)/, '.msg-bubble--assistant limita a 72ch');
  const rules = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const own = /(^|[\s,>])\.(assist-|proposal-card|msg-bubble--|action-row|lnk-on-dark)/;
  const mine = rules.filter(r => own.test(r[1]!.trim()));
  for (const cls of ['.assist-scroll', '.assist-msg', '.assist-thinking', '.assist-form--dragging', '.proposal-card__amount', '.proposal-card__details', '.msg-bubble--user']) {
    assert.ok(mine.some(r => r[1]!.includes(cls)), `falta la clase ${cls} en styles.css`);
  }
  for (const r of mine) {
    assert.ok(!/var\(--[\w-]+\s*,/.test(r[2]!), `${r[1]!.trim()} usa var(--…) con valor de respaldo`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-170: Autorizaciones y Presupuestos con la cifra primero (comprobación estática, sin IA).
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const card = read('components/PendingDecisionCard.tsx');
const meter = read('components/BudgetMeter.tsx');
const styles = read('styles.css');
const meterCss = read('components/BudgetMeter.css');
const inbox = read('screens/InboxScreen.tsx');
const budgets = read('screens/Budgets.tsx');

/** Cuerpos de las reglas CSS cuyo selector (también en listas con coma) es exactamente `sel`. */
const rules = (css: string, sel: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(',').map(s => s.trim()).includes(sel))
    .map(m => m[2]);
const has28 = (css: string, sel: string) => rules(css, sel).some(b => /font-size:\s*28px/.test(b));

test('decisionRisk es una función pura exportada con los tres niveles', () => {
  const fn = card.slice(card.indexOf('export function decisionRisk'), card.indexOf('const RISK_ICON'));
  assert.ok(fn.length > 0, 'falta export function decisionRisk');
  assert.match(fn, /kind === 'publish' \|\| d\.kind === 'integrate'\) return \{ level: 'alto', label: 'Riesgo alto' \}/);
  assert.match(fn, /level: 'medio', label: 'Riesgo medio'/);
  assert.match(fn, /level: 'bajo', label: 'Riesgo bajo'/);
  assert.ok(!/complete\(|api\./.test(fn), 'decisionRisk no debe llamar a la IA ni a la API');
});

test('la tarjeta muestra arriba el importe y el riesgo con icono, a 28 px', () => {
  assert.ok(card.includes('className="inbox-card__amount"'));
  assert.ok(card.includes("'0,00 USD · Sin costo de IA'"));
  assert.ok(card.includes('className={`inbox-card__risk inbox-card__risk--${risk.level}`}'));
  assert.ok(card.includes('{RISK_ICON[risk.level]()}') && card.includes('{risk.label}'), 'el riesgo lleva icono y texto');
  assert.ok(has28(styles, '.inbox-card__amount'), '.inbox-card__amount debe tener 28px');
  assert.ok(has28(styles, '.inbox-card__risk'), '.inbox-card__risk debe tener 28px');
  for (const lvl of ['alto', 'medio', 'bajo']) assert.ok(rules(styles, `.inbox-card__risk--${lvl}`).length > 0, `falta .inbox-card__risk--${lvl}`);
});

test('Aprobar y Denegar van justo debajo de las cifras; las superadas no muestran cifras grandes', () => {
  const figures = card.indexOf('className="inbox-card__figures"');
  const approve = card.indexOf('>Aprobar<');
  const deny = card.indexOf('>Denegar<');
  const title = card.indexOf('{decision.title}');
  assert.ok(figures > 0 && figures < approve && approve < deny && deny < title, 'orden esperado: cifras, Aprobar, Denegar, título');
  assert.ok(card.slice(figures - 80, figures).includes('{!superseded && ('), 'las cifras solo en tarjetas vigentes');
  assert.ok(card.includes('Solo se puede aprobar'), 'se mantiene la nota de solo aprobar');
  assert.ok(card.includes("'Sí, aprobar'") && card.includes('presupuesto máximo de'), 'se mantiene la confirmación en dos pasos y el máximo');
});

test('Presupuestos: saldo disponible a 28 px y alertas con icono aria-hidden', () => {
  assert.ok(meter.includes('className={`budget-meter__available'), 'falta la cifra de saldo disponible');
  assert.ok(meter.includes('Disponible este mes'));
  assert.ok(has28(meterCss, '.budget-meter__available-value'), 'el saldo disponible debe tener 28px');
  assert.match(meter, /budget-meter__alert-ic" aria-hidden="true"/);
  const alerts = [...meter.matchAll(/<MeterAlert [^>]*>/g)].map(m => m[0]);
  assert.ok(alerts.length >= 5, 'faltan alertas (error, sin presupuesto, negativo, agotado, saldo bajo)');
  for (const a of alerts) assert.ok(a.includes('icon={Icon.'), `alerta sin icono: ${a}`);
  assert.ok(!meter.includes('className="budget-meter__error"'), 'los errores deben usar budget-meter__alert');
  assert.ok(!/[✔⚠⛔✖○]/.test(meter), 'los estados usan Icon y no caracteres sueltos');
});

test('las introducciones ocupan como máximo 2 líneas, con recorte CSS de respaldo', () => {
  assert.ok(rules(styles, '.lede-2l').some(b => /-webkit-line-clamp:\s*2/.test(b) && /overflow:\s*hidden/.test(b)), 'falta .lede-2l con -webkit-line-clamp:2');
  for (const [name, src] of [['Autorizaciones', inbox], ['Presupuestos', budgets]] as const) {
    const m = src.match(/className="lede lede-2l"[^>]*>([^<]+)</);
    assert.ok(m, `${name}: la introducción debe usar lede-2l`);
    assert.ok(m[1].trim().length <= 110, `${name}: introducción de ${m[1].trim().length} caracteres (máx. 110)`);
  }
  for (const m of budgets.matchAll(/<span className="small[^"]*">([^<]+)<\/span>/g)) {
    assert.ok(m[1].trim().length <= 160, `Presupuestos: descripción demasiado larga: ${m[1].trim()}`);
  }
});

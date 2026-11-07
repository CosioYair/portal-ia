import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentMention } from '@portal-ia/domain';

// EN-015 · Resolución pura de «@nombre propio» y «@puesto» de la barra «Pide algo a tu empresa». Sin IA (0 USD).
const lucia = { id: 'a1', name: 'Diseñador UX/UI', personalName: 'Lucía' };
const arquitecto = { id: 'a2', name: 'Arquitecto de software', personalName: null };
const sinNombre = { id: 'a3', name: 'Coordinador' };

test('«@Lucía revisa» resuelve por nombre propio y deja el resto', () => {
  const r = resolveAgentMention('@Lucía revisa la portada', [lucia, arquitecto, sinNombre]);
  assert.equal(r?.kind, 'agent');
  if (r?.kind !== 'agent') return;
  assert.equal(r.agent.id, 'a1');
  assert.equal(r.mention, 'Lucía');
  assert.equal(r.rest, 'revisa la portada');
});

test('sin distinguir mayúsculas ni acentos, y con coma o dos puntos', () => {
  for (const t of ['@lucia revisa', '@LUCÍA, revisa', '@Lucia: revisa']) {
    const r = resolveAgentMention(t, [lucia, arquitecto]);
    assert.equal(r?.kind, 'agent', t);
    if (r?.kind === 'agent') { assert.equal(r.agent.id, 'a1'); assert.equal(r.rest, 'revisa'); }
  }
});

test('texto en NFD: se normaliza a NFC y el resto se corta en su sitio', () => {
  const r = resolveAgentMention('@Luci\u0301a revisa', [lucia, arquitecto]);
  assert.equal(r?.kind, 'agent');
  if (r?.kind !== 'agent') return;
  assert.equal(r.agent.id, 'a1');
  assert.equal(r.mention, 'Lucía');
  assert.equal(r.rest, 'revisa');
});

test('«@Arquitecto revisa» resuelve por la primera palabra del puesto', () => {
  const r = resolveAgentMention('@Arquitecto revisa el diseño', [lucia, arquitecto, sinNombre]);
  assert.equal(r?.kind, 'agent');
  if (r?.kind !== 'agent') return;
  assert.equal(r.agent.id, 'a2');
  assert.equal(r.rest, 'revisa el diseño');
});

test('gana la coincidencia más larga', () => {
  const datos = { id: 'a4', name: 'Arquitecto de datos' };
  const r = resolveAgentMention('@Arquitecto de datos, revisa', [arquitecto, datos]);
  assert.equal(r?.kind, 'agent');
  if (r?.kind !== 'agent') return;
  assert.equal(r.agent.id, 'a4');
  assert.equal(r.rest, 'revisa');
});

test('caso ambiguo: la misma clave encaja con varios agentes', () => {
  const datos = { id: 'a4', name: 'Arquitecto de datos' };
  const r = resolveAgentMention('@Arquitecto revisa', [lucia, arquitecto, datos]);
  assert.equal(r?.kind, 'ambiguous');
  if (r?.kind !== 'ambiguous') return;
  assert.deepEqual(r.options.map(a => a.id).sort(), ['a2', 'a4']);
  assert.equal(r.mention, 'Arquitecto');
  assert.equal(r.rest, 'revisa');
});

test('sin mención válida devuelve null (agente sin nombre propio sigue igual por puesto)', () => {
  assert.equal(resolveAgentMention('Marketing: investiga', [lucia]), null);
  assert.equal(resolveAgentMention('@Desconocido hola', [lucia, arquitecto]), null);
  assert.equal(resolveAgentMention('@Lucíana hola', [lucia]), null);
  const r = resolveAgentMention('@Coordinador planifica', [lucia, sinNombre]);
  assert.equal(r?.kind, 'agent');
  if (r?.kind === 'agent') assert.equal(r.agent.id, 'a3');
});

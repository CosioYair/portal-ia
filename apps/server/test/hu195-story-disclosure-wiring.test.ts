import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-195 · Espacio de la historia con secciones plegadas: chat, tareas e historial en Disclosure (cerrados por defecto),
// la decisión pendiente dentro de la cabecera y sin el enlace suelto a «Autorizaciones».
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

test('HU-195: chat, tareas e historial son secciones Disclosure cerradas salvo que el hash apunte a ellas', () => {
  const ws = read('screens/StoryWorkspace.tsx');
  assert.ok(ws.includes("import { Disclosure } from '../components/Disclosure.tsx';"), 'StoryWorkspace importa Disclosure');
  for (const [id, testId, tab] of [['sec-chat', 'story-chat', 'chat'], ['sec-tareas', 'story-tareas', 'tareas'], ['sec-iteraciones', 'story-iteraciones', 'iteraciones']] as const) {
    const re = new RegExp(`<Disclosure id="${id}" testId="${testId}"[^\\n]*defaultOpen=\\{tab === '${tab}'\\}>`);
    assert.match(ws, re, `${id}: Disclosure abierto de inicio solo con #${tab}`);
  }
  assert.ok(!ws.includes('role="tablist"') && !ws.includes('role="tab"'), 'ya no hay barra de pestañas');
  assert.ok(!ws.includes('<details') && !ws.includes('<summary'), 'sin plegables hechos a mano: todo pasa por Disclosure');
  assert.ok(ws.includes('<Disclosure title="Contexto que recibirá el equipo">'), 'el contexto de la iteración también usa Disclosure');
  assert.ok(!ws.includes('pestaña Chat'), 'los textos hablan de la sección Chat');
});

test('HU-195: la decisión pendiente vive en la cabecera y desaparece el enlace suelto a Autorizaciones', () => {
  const ws = read('screens/StoryWorkspace.tsx');
  assert.ok(!ws.includes('to="/autorizaciones"'), 'sin enlace suelto a /autorizaciones');
  const headOpen = ws.indexOf('<header'); const headClose = ws.indexOf('</header>');
  const decIdx = ws.indexOf('{currentDecision && !it.archivedAt && <div id="story-decision"');
  assert.ok(headOpen > 0 && decIdx > headOpen && decIdx < headClose, 'la decisión pendiente está dentro de <header>');
  const block = ws.slice(decIdx, headClose);
  assert.ok(block.includes('KIND_LABEL[currentDecision.kind]') && block.includes('currentDecision.impact'), 'muestra tipo e impacto');
  assert.ok(block.includes('Iteración {currentDecision.iteration'), 'muestra la iteración');
  assert.ok(block.includes('onClick={openAuthorize}>Abrir la autorización</button>'), 'botón para decidir la autorización');
  assert.ok(block.includes('Decidir en el proceso</Link>'), 'otras decisiones se deciden en el proceso');
  assert.ok(block.includes("onClick={() => openTab('iteraciones')}"), 'las autorizaciones superadas abren el historial');
});

test('HU-195: el hash y las acciones abren la sección y llevan la vista hasta ella', () => {
  const ws = read('screens/StoryWorkspace.tsx');
  assert.ok(ws.includes('document.getElementById(`sec-${t}`)'), 'localiza la sección por su id');
  assert.ok(ws.includes('if (el instanceof HTMLDetailsElement) el.open = true;'), 'abre el <details>');
  assert.ok(ws.includes("el?.scrollIntoView({ behavior: 'smooth', block: 'start' })"), 'lleva la vista hasta la sección');
  assert.match(ws, /const openTab = \(t: Tab\) => \{ setTab\(t\); revealSection\(t\);/, 'openTab abre la sección aunque el hash no cambie');
  assert.match(ws, /onAsk=\{q => \{ setText\(q\); setAsk\(true\); openTab\('chat'\); \}\}/, '«Preguntar al equipo» abre el chat con la pregunta');
});

test('HU-195: Disclosure acepta un id opcional y sigue cerrado por defecto', () => {
  const d = read('components/Disclosure.tsx');
  assert.match(d, /id\?: string;/);
  assert.ok(d.includes('<details id={id}'), 'el id se pasa al <details>');
  assert.ok(d.includes('defaultOpen = false'), 'cerrado por defecto');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Oficina de agentes: cableado de la interfaz (comprobación estática, sin IA). El recorrido completo en navegador está en
// la evidencia de la entrega (docs/sistema-operativo-agentes.md).
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

test('la oficina es la portada y el Panel sigue existiendo', () => {
  const app = read('App.tsx');
  assert.match(app, /const home = ready \? '\/oficina'/);
  assert.match(app, /<Route path="\/oficina" /);
  assert.match(app, /<Route path="\/oficina\/agente\/:agentId\/:tab\?" /);
  assert.match(app, /<Route path="\/oficina\/nuevo-agente" /);
  assert.match(app, /<Route path="\/panel" element=\{guard\(<Dashboard \/>\)\} \/>/);
  assert.match(read('components/Shell.tsx'), /to="\/oficina">\{Icon\.org\(\)\}<span>Oficina<\/span>/);
});

test('los estados de los agentes nunca dependen solo del color: texto, forma y etiqueta accesible', () => {
  const office = read('screens/Office.tsx'); const fig = read('components/AgentFigure.tsx');
  assert.match(fig, /STATE_TEXT: Record<OfficeState, string> = \{ working: 'Trabajando', queued: 'En cola', attention: 'Te necesita', idle: 'Disponible', retired: 'Retirado' \}/);
  assert.match(office, /aria-label=\{label\}/);
  assert.match(office, /<span className="desk-state">\{STATE_TEXT\[a\.state\]\}<\/span>/);
  assert.match(office, /<caption className="sr">/);
});

test('panel del agente: seis pestañas con rol de pestaña, flechas del teclado y montado sobre los botones flotantes', () => {
  const panel = read('components/AgentPanel.tsx');
  for (const t of ['Chat', 'Solicitudes', 'Trabajo', 'Archivos', 'Memoria', 'Configuración']) assert.ok(panel.includes(`'${t}'`), t);
  assert.match(panel, /role="tablist"/); assert.match(panel, /aria-selected=\{current === id\}/);
  assert.match(panel, /e\.key !== 'ArrowRight' && e\.key !== 'ArrowLeft'/);
  assert.match(panel, /createPortal\(<aside className="agent-panel"/);
});

test('nada que gaste se envía sin autorización explícita en la interfaz', () => {
  const panel = read('components/AgentPanel.tsx'); const wizard = read('screens/AgentWizard.tsx'); const office = read('screens/Office.tsx');
  assert.match(panel, /Autorizo esta llamada facturable/);
  assert.match(panel, /disabled=\{busy \|\| !auth \|\| req\.trim\(\)\.length < 8/);
  assert.match(panel, /disabled=\{busy \|\| !auth \|\| !model/);
  assert.match(wizard, /const valid = \[.*auth\];/);
  assert.match(office, /Autorizo esta petición/);
  assert.match(office, /disabled=\{busy \|\| !auth \|\| !det\?\.restricted/);
});

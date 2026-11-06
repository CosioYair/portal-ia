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
  // La portada es la Oficina, en la última vista usada (Planta por defecto; Lista en móvil sin vista guardada).
  assert.match(app, /const home = ready \? officeHome\(\)/); assert.match(read('lib/routes.ts'), /return width !== undefined && width < 768 \? '\/oficina\/lista' : '\/oficina';/);
  assert.match(app, /<Route path="\/oficina" /);
  assert.match(app, /<Route path="\/oficina\/agente\/:agentId\/:tab\?" /);
  assert.match(app, /<Route path="\/oficina\/nuevo-agente" /);
  assert.match(app, /<Route path="\/panel" element=\{guard\(<Dashboard \/>\)\} \/>/);
  // Portal IA 2.0: el menú sale del registro único de secciones (lib/routes.ts).
  assert.match(read('lib/routes.ts'), /\{ id: 'oficina', label: 'Oficina', path: '\/oficina'/);
  assert.match(read('lib/routes.ts'), /\{ id: 'resumen', label: 'Resumen', path: '\/panel'/, 'el Panel sigue en /panel, como «Resumen»');
  assert.match(read('components/Shell.tsx'), /SECTIONS\.filter\(/);
});

test('los estados de los agentes nunca dependen solo del color: texto, forma y etiqueta accesible', () => {
  const office = read('screens/Office.tsx'); const fig = read('components/AgentFigure.tsx');
  assert.match(fig, /STATE_TEXT: Record<OfficeState, string> = \{ working: 'Trabajando', queued: 'En cola', attention: 'Te necesita', unavailable: 'No puede trabajar', idle: 'Disponible', retired: 'Retirado' \}/);
  assert.match(office, /aria-label=\{label\}/);
  assert.match(office, /<span className="desk-state">\{STATE_TEXT\[a\.state\]\}<\/span>/);
  assert.match(office, /<caption className="sr">/);
});

test('panel del agente: seis pestañas con rol de pestaña, flechas del teclado y montado sobre los botones flotantes', () => {
  const panel = read('components/AgentPanel.tsx');
  for (const t of ['Chat', 'Solicitudes', 'Trabajo', 'Archivos', 'Memoria', 'Configuración']) assert.ok(panel.includes(`'${t}'`), t);
  assert.match(panel, /role="tablist"/); assert.match(panel, /aria-selected=\{current === id\}/);
  assert.match(panel, /\['ArrowRight', 'ArrowLeft', 'Home', 'End'\]\.includes\(e\.key\)/);
  assert.match(panel, /if \(x\.agent\.id !== cur\.current\) return;/, 'una respuesta de otro agente se descarta');
  assert.match(panel, /createPortal\(<>\{modal && <div className="agent-panel-scrim" onClick=\{onClose\} aria-hidden="true" \/>\}<aside className="agent-panel" role="dialog" aria-modal=\{modal\}/);
  // En pantallas anchas va al lado: el contenido se aparta y nada enfocable queda debajo del panel.
  assert.match(panel, /document\.body\.classList\.add\('has-agent-panel'\)/); assert.match(read('system.css'), /body\.has-agent-panel \.content \{ padding-right:/);
  // Portal IA 2.0: cinco grupos; cada nombre antiguo de pestaña sigue valiendo en la ruta (abre su grupo).
  // HU-181: Mejoras se retira del panel; …/mejoras es un alias que abre Memoria (no tiene grupo propio).
  assert.match(panel, /const GROUP_OF: Record<Tab, Group> = \{ chat: 'chat', trabajo: 'trabajo', documentos: 'trabajo', solicitudes: 'revisar', memoria: 'memoria', configuracion: 'ajustes', archivos: 'ajustes', origen: 'ajustes' \};/);
  assert.match(panel, /tab === 'mejoras' \? 'memoria'/);
  // Modal por debajo de 1280 px: foco atrapado (también Mayús+Tab desde el propio panel); Esc de otros diálogos no lo cierra.
  assert.match(panel, /if \(!modal \|\| e\.key !== 'Tab' \|\| !ref\.current\) return;/);
  assert.match(panel, /document\.activeElement === a \|\| document\.activeElement === ref\.current/);
  assert.match(panel, /if \(e\.key !== 'Escape' \|\| e\.defaultPrevented\) return;/);
  // Todas las pestañas a la vista en cualquier ancho: pasan de línea, sin desplazamiento horizontal.
  const css = read('office.css'); const rule = /\.agent-panel-tabs \{([^}]*)\}/.exec(css)![1];
  assert.match(rule, /flex-wrap: wrap/); assert.doesNotMatch(rule, /overflow-x/);
});

test('nada que gaste se envía sin autorización explícita en la interfaz', () => {
  const panel = read('components/AgentPanel.tsx'); const wizard = read('screens/AgentWizard.tsx'); const office = read('screens/Office.tsx'); const chat = read('components/AgentChat.tsx');
  assert.match(chat, /Autorizo esta llamada facturable/);
  // Un mensaje lleva texto o adjuntos ya subidos (nunca a medio subir) y, si factura, la autorización marcada.
  assert.match(chat, /const canSend = !busy && !pending && !uploading && \(text\.trim\(\)\.length >= 2 \|\| ready\.length > 0\) && !p\.retired && !consoleOnly && \(!p\.chat\.estimate\.billable \|\| billOk\);/);
  assert.match(panel, /disabled=\{busy \|\| !auth \|\| req\.trim\(\)\.length < 8/);
  assert.match(panel, /disabled=\{busy \|\| !auth \|\| !model/);
  assert.match(wizard, /const valid = \[.*auth\];/);
  assert.match(office, /Autorizo esta petición/);
  assert.match(read('components/HarnessDialog.tsx'), /disabled=\{busy \|\| !auth \|\| !det\?\.restricted/);
});

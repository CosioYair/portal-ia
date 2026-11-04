import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// EN-004: el panel «Pedir» deja de verse al navegar pero sigue reservando su espacio (comprobación estática, sin IA).
// Falla con d3fb652: la reserva dependía solo de [open, wide] (AssistantDock.tsx:33, antes del return null de la línea 40),
// «Pedir» solo hacía setOpen(true) (AssistantDock.tsx:25-30) y .dock (z-index 30, styles.css:152) quedaba bajo
// .agent-panel (60, office.css:114) y su fondo (59, office.css:123).
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(webSrc, rel));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** z-index de la última regla cuyo selector es exactamente `selector`, en el orden de carga de las hojas. */
function zOf(sheets: string[], selector: string): number {
  const re = new RegExp(`(?:^|[}\\s])${esc(selector)}\\s*\\{[^}]*?z-index:\\s*(-?\\d+)`, 'gm');
  let last: number | null = null;
  for (const css of sheets) for (const m of css.matchAll(re)) last = Number(m[1]);
  assert.ok(last !== null, `no se encontró z-index para ${selector}`);
  return last;
}

const loadLayer = async () => {
  assert.ok(exists('lib/dockLayer.ts'), 'falta apps/web/src/lib/dockLayer.ts (reglas puras del panel)');
  return import('../../web/src/lib/dockLayer.ts');
};

test('la reserva de espacio en <body> depende de que el panel se vea, no solo de que esté abierto', () => {
  const dock = read('components/AssistantDock.tsx');
  assert.ok(!/\[open, wide\]/.test(dock), 'el efecto de has-dock no debe depender solo de [open, wide]');
  assert.match(dock, /const visible = dockVisible\(\{ open, onAssistantPage/);
  assert.match(dock, /bodyClass\(\{ visible, wide \}\)/);
  assert.match(dock, /\}, \[visible, wide\]\);/);
  assert.match(dock, /classList\.remove\('has-dock', 'has-dock-wide'\)/, 'al limpiar se quitan las dos clases');
  assert.match(dock, /const onAssistantPage = isAssistantPath\(loc\.pathname\)/);
});

test('«Pedir» siempre tiene efecto: abre, trae al frente y enfoca, o enfoca la pantalla completa', () => {
  const dock = read('components/AssistantDock.tsx');
  assert.match(dock, /useUiEvent\('assistant'/);
  assert.match(dock, /askAction\(\{ onAssistantPage, open \}\)/);
  // En /asistente se enfoca la caja de la pantalla completa: el selector debe existir de verdad en Assistant.tsx.
  assert.match(dock, /querySelector<HTMLTextAreaElement>\('\.assist-page textarea'\)/);
  assert.ok(!dock.includes("'.assist textarea'"), 'no existe ningún elemento con la clase .assist');
  const full = read('screens/Assistant.tsx');
  assert.ok(full.includes('className="page assist-page"'), 'la pantalla completa lleva la clase assist-page');
  assert.ok(full.includes('<AssistantChat '), 'la caja de mensaje (AssistantChat) está dentro de .assist-page');
  assert.match(dock, /setFront\(true\); setFocusTick\(t => t \+ 1\)/);
  assert.match(dock, /\}, \[open, focusTick\]\);/, 'el foco se repite al pulsar «Pedir» con el panel abierto');
  assert.match(dock, /dock-behind/);
  assert.match(dock, /canYield\(\{ agentModal: !!document\.querySelector\('\.agent-panel-scrim'\) \}\)\) setFront\(false\)/,
    'por debajo de 1280 px (panel de agente modal) el Asistente no cede bajo su fondo');
  assert.match(dock, /document\.querySelector\('\.agent-panel-scrim'\)\) setFront\(true\)/, 'si aparece el fondo modal, vuelve al frente');
});

test('orden de capas: contenido < panel de agente < Asistente < diálogos < búsqueda', () => {
  const sheets = [read('styles.css'), read('system.css'), read('office.css')];
  const dockZ = zOf(sheets, '.dock');
  const behindZ = zOf(sheets, '.dock.dock-behind');
  const agentZ = zOf(sheets, '.agent-panel');
  const scrimZ = zOf(sheets, '.agent-panel-scrim');
  const portalZ = zOf(sheets, '.os-portal');
  const cmdkZ = zOf(sheets, '.cmdk-backdrop');
  assert.ok(dockZ > agentZ && dockZ > scrimZ, `.dock (${dockZ}) debe quedar sobre .agent-panel (${agentZ}) y su fondo (${scrimZ})`);
  assert.ok(dockZ < portalZ && portalZ < cmdkZ, `.dock (${dockZ}) < .os-portal (${portalZ}) < .cmdk-backdrop (${cmdkZ})`);
  assert.ok(behindZ < scrimZ, `.dock.dock-behind (${behindZ}) cede bajo el fondo del panel de agente (${scrimZ})`);
});

test('dockLayer: constantes de capa coherentes con el CSS', async () => {
  const { DOCK_Z, DOCK_Z_BEHIND } = await loadLayer();
  const sheets = [read('styles.css'), read('system.css'), read('office.css')];
  assert.equal(zOf(sheets, '.dock'), DOCK_Z);
  assert.equal(zOf(sheets, '.dock.dock-behind'), DOCK_Z_BEHIND);
});

test('dockLayer: visibilidad, clase de <body> y acción de «Pedir»', async () => {
  const { isAssistantPath, dockVisible, bodyClass, askAction } = await loadLayer();
  for (const p of ['/asistente', '/asistente/c/1', '/empresa/x/asistente']) assert.equal(isAssistantPath(p), true, p);
  for (const p of ['/oficina', '/oficina/agente/abc', '/resumen', '/backlog', '/lotes', '/actividad', '/procesos/p1', '/historias/h1', '/conocimiento', '/decisiones', '/presupuestos', '/ajustes']) {
    assert.equal(isAssistantPath(p), false, p);
    assert.equal(dockVisible({ open: true, onAssistantPage: isAssistantPath(p) }), true, `el panel se ve en ${p}`);
  }
  assert.equal(dockVisible({ open: true, onAssistantPage: true }), false);
  assert.equal(dockVisible({ open: true, onAssistantPage: false, yielded: true }), false);
  assert.equal(dockVisible({ open: false, onAssistantPage: false }), false);
  assert.equal(bodyClass({ visible: false, wide: false }), null);
  assert.equal(bodyClass({ visible: false, wide: true }), null);
  assert.equal(bodyClass({ visible: true, wide: false }), 'has-dock');
  assert.equal(bodyClass({ visible: true, wide: true }), 'has-dock-wide');
  assert.equal(askAction({ onAssistantPage: true, open: true }), 'focus-fullscreen');
  assert.equal(askAction({ onAssistantPage: true, open: false }), 'focus-fullscreen');
  assert.equal(askAction({ onAssistantPage: false, open: false }), 'open');
  assert.equal(askAction({ onAssistantPage: false, open: true }), 'front-focus');
});

test('dockLayer: el Asistente solo cede ante un panel de agente no modal (≥1280 px)', async () => {
  const { canYield } = await loadLayer();
  assert.equal(canYield({ agentModal: false }), true);
  assert.equal(canYield({ agentModal: true }), false);
});

test('reserva responsive: escritorio y tableta reservan; móvil no reserva padding', () => {
  const sys = read('system.css');
  assert.match(sys, /@media \(min-width: 768px\) \{\s*body\.has-dock \.content \{ padding-right: min\(calc\(min\(540px, 100vw - 32px\) \+ 24px\), 100%\); \}/);
  assert.match(sys, /body\.has-dock-wide \.content \{ padding-right: min\(calc\(min\(1100px, 100vw - 32px\) \+ 24px\), 100%\); \}/);
  assert.ok(!/var\(--dock-reserve\)/.test(sys), 'sin variables locales: tokens.css no las declara (design-tokens-migration)');
  assert.match(sys, /body\.has-agent-panel\.has-dock \.content/);
  assert.match(sys, /@media \(max-width: 767px\) \{\s*body\.has-dock \.content, body\.has-dock-wide \.content \{ padding-right: 0; \}/);
});

test('sin cambios: panel ancho, pantalla completa, foco al cerrar, móvil modal y contador de pendientes', () => {
  const dock = read('components/AssistantDock.tsx');
  assert.ok(dock.includes("aria-label={wide ? 'Panel estrecho' : 'Panel ancho'}"));
  assert.ok(dock.includes('aria-pressed={wide}'));
  assert.ok(dock.includes('title="Abrir en pantalla completa"'));
  assert.ok(dock.includes("navigate('/asistente')"));
  assert.match(dock, /\(opener\.current as HTMLElement \| null\)\?\.focus\?\.\(\)/);
  assert.match(dock, /aria-modal=\{mobile \|\| undefined\}/);
  assert.match(dock, /matchMedia\?\.\('\(max-width: 767px\)'\)/, 'móvil se recalcula al cambiar el tamaño');
  assert.match(dock, /if \(e\.key !== 'Tab' \|\| !mobile \|\| !panel\.current\) return;/, 'el atrapado de Tab usa el mismo estado');
  assert.match(dock, /setAssistantPending\(n\)/);
  assert.match(dock, /aria-label="Cerrar asistente"/);
  assert.match(dock, /createPortal\(/);
});

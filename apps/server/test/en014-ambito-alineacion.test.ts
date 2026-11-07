import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * EN-014 · Iteración 2: alineación de los chips del ámbito y estándar de estilo reutilizable (docs/estilos-ui.md).
 * Prueba de cableado: solo lee archivos fuente. Sin IA, sin red y sin base de datos: 0 USD.
 */
const web = (f: string) => fs.readFileSync(new URL(`../../web/src/${f}`, import.meta.url), 'utf8');
const between = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `no se encuentra «${start}»`);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j < 0 ? undefined : j);
};

test('system.css define el estándar .chip-row con sus modificadores, con tokens y sin respaldos', () => {
  const css = web('system.css');
  const row = css.match(/^\.chip-row \{([^}]*)\}/m);
  assert.ok(row, '.chip-row definida en system.css');
  assert.match(row![1], /flex-wrap:\s*wrap/, 'pasa de línea en vez de desbordar');
  assert.match(row![1], /align-items:\s*center/, 'alineados entre sí en vertical');
  assert.match(row![1], /gap:\s*var\(--space-1\)/, 'hueco con el token --space-1, sin respaldo');
  assert.match(row![1], /max-width:\s*100%/);
  assert.match(css, /^\.chip-row-start \{[^}]*justify-content:\s*flex-start/m);
  assert.match(css, /^\.chip-row-center \{[^}]*justify-content:\s*center/m);
  assert.match(css, /^\.chip-row-center \{[^}]*width:\s*100%/m, 'centrado a todo el ancho, también al pasar de línea');
  // office.css solo se carga con la Oficina: la regla base no puede vivir allí (Team, AgentDetail y AgentPanel la usan).
  assert.doesNotMatch(web('office.css'), /^\.chip-row(-start|-center)? \{/m, '.chip-row no se define en office.css');
});

test('Chip admite title y ContextScopeChips usa .chip-row sin estilos en línea ni envolturas', () => {
  const ui = web('components/ui.tsx');
  const chip = between(ui, 'export function Chip(', '\nexport function');
  assert.match(chip, /title\?: string/, 'Chip acepta title opcional');
  assert.match(chip, /title=\{title\}/, 'el title llega al <span class="chip">');
  const wizard = web('screens/AgentWizard.tsx');
  const chips = between(wizard, 'export function ContextScopeChips', '\n}');
  assert.match(chips, /align = 'start'/, 'por defecto alinea al inicio');
  assert.match(chips, /align\?: 'start' \| 'center'/);
  assert.match(chips, /chip-row chip-row-\$\{align\}/, 'usa la clase estándar con su modificador');
  assert.ok(!chips.includes('style={{'), 'sin estilos en línea');
  assert.ok(!/<span title/.test(chips), 'sin <span> de envoltura para el title');
  assert.match(chips, /<Chip [^>]*title=/, 'el title va en el propio Chip');
  assert.match(chips, /aria-label="Ámbito: sin ámbito"/, 'mismo aria-label en el caso «Sin ámbito»');
  assert.match(chips, /aria-label=\{`Ámbito: /, 'mismo aria-label con ámbito');
  assert.match(wizard, /SCOPE_TONE: Record<ContextScopeOption, '' \| 'accent' \| 'ok'> = \{ project: '', company: 'accent', general: 'ok' \}/, 'mismos tonos');
});

test('Oficina: la planta centra los chips en .desk-body; la lista los alinea al inicio; la cabecera usa .chip-row', () => {
  const office = web('screens/Office.tsx');
  const desk = between(office, 'function Desk({', '\nfunction ');
  assert.match(desk, /<span className="desk-body">/, 'columna de textos con clase');
  assert.match(desk, /<ContextScopeChips scope=\{a\.contextScope\} align="center" \/>/, 'centrados bajo el nombre');
  const body = between(desk, 'className="desk-body"', 'align="center"');
  assert.ok(!body.includes('style={{'), 'la columna del puesto no usa estilo en línea');
  assert.match(office, /<td data-label="Ámbito"><ContextScopeChips scope=\{a\.contextScope\} align="start" \/><\/td>/, 'lista alineada al inicio');
  const ocss = web('office.css');
  assert.match(ocss, /^\.desk-body \{[^}]*flex-direction:\s*column[^}]*align-items:\s*center/m, '.desk-body centrada en columna');
  assert.match(ocss, /^\.desk-body \{[^}]*gap:\s*var\(--space-1\)/m, 'hueco con token');
  assert.match(ocss, /\.office-list td \{[^}]*vertical-align:\s*middle/, 'celdas alineadas en vertical con la fila');
  assert.match(ocss, /\.office-list td \.chip-row \{[^}]*max-width:\s*100%/, 'en tarjetas móviles los chips no se desbordan');
  assert.match(web('screens/AgentDetail.tsx'), /<div className="chip-row chip-row-start"><ContextScopeChips /, 'cabecera del agente con .chip-row');
  for (const f of ['screens/Team.tsx', 'components/AgentPanel.tsx'])
    assert.match(web(f), /<ContextScopeChips /, `${f}: sigue mostrando el ámbito real`);
});

test('docs/estilos-ui.md documenta el estándar de alineación, responsividad y clases', () => {
  const url = new URL('../../../docs/estilos-ui.md', import.meta.url);
  assert.ok(fs.existsSync(url), 'existe docs/estilos-ui.md');
  const doc = fs.readFileSync(url, 'utf8');
  assert.match(doc, /^#+ .*Alineaci[oó]n/im, 'sección de alineación');
  assert.match(doc, /\.chip-row/);
  assert.match(doc, /style=\{\{|estilos? en l[ií]nea/i, 'pide clases y tokens en vez de style en línea');
  assert.match(doc, /data-label/, 'tablas que pasan a tarjetas en móvil');
  assert.match(doc, /comprobaci[oó]n/i, 'lista de comprobación');
});

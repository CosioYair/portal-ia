import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sectionOf, sectionRoot, tabFor } from '../../web/src/lib/routes.ts';
import { parentOf } from '../../web/src/lib/nav.ts';

// Portal IA 2.0 (arquitectura de información y sistema de diseño): comprobación estática, sin IA. Lo nuevo de la
// navegación (búsqueda Ctrl+K, barra superior, campana, Decisiones, Ajustes) solo LEE y navega; las decisiones se
// siguen tomando donde siempre, y ninguna ruta antigua se pierde.
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const calls = (src: string) => [...src.matchAll(/\b(api|osApi)\.([a-zA-Z]+)\(/g)].map(m => `${m[1]}.${m[2]}`);

/** Lecturas que la navegación puede hacer (GET); cualquier otra llamada sería una acción. */
// EN-012: Decisiones también lee los encargos que esperan al propietario (GET /inbox/assignments, solo lectura).
// HU-189: la campana y Decisiones leen cuántas acciones del chat esperan tu autorización (GET /api/assistant/pending-count),
// aunque el panel del Asistente esté cerrado.
const READ_ONLY = new Set(['api.inbox', 'api.inboxAssignments', 'osApi.office', 'api.backlog', 'api.usageToday', 'api.systemStatus', 'api.assistantPendingCount']);

test('HU-189: api.assistantPendingCount es una lectura (GET sin cuerpo ni método)', () => {
  const api = read('lib/api.ts');
  assert.match(api, /assistantPendingCount: \(\) => request<\{ count: number \}>\('\/api\/assistant\/pending-count'\),/);
});

test('EN-012: api.inboxAssignments es una lectura (GET sin cuerpo ni método)', () => {
  const api = read('lib/api.ts');
  assert.match(api, /inboxAssignments: \(slug: string\) => request<[A-Za-z[\]]+>\(`\/api\/workspaces\/\$\{slug\}\/inbox\/assignments`\),/);
});

test('la búsqueda, la campana, la barra superior, Decisiones y Ajustes no cambian nada: solo leen y navegan', () => {
  const shell = read('components/Shell.tsx');
  // El diálogo «Nueva empresa / Nuevo proyecto» es lo único del marco que crea algo, y solo al enviarlo.
  const dialog = shell.slice(shell.indexOf('export function CreateDialog'), shell.indexOf('export function Shell'));
  assert.ok(dialog.length > 0, 'falta CreateDialog antes de Shell');
  assert.deepEqual(calls(dialog).sort(), ['api.createProject', 'api.createWorkspace']);
  const files: [string, string][] = [
    ['components/Shell.tsx (sin el diálogo)', shell.replace(dialog, '')],
    ['components/CommandPalette.tsx', read('components/CommandPalette.tsx')],
    ['components/AttentionWatcher.tsx', read('components/AttentionWatcher.tsx')],
    ['lib/uiBus.ts', read('lib/uiBus.ts')],
    ['lib/routes.ts', read('lib/routes.ts')],
    ['screens/InboxScreen.tsx', read('screens/InboxScreen.tsx')],
    ['screens/Settings.tsx', read('screens/Settings.tsx')]
  ];
  for (const [name, src] of files) {
    for (const c of calls(src)) assert.ok(READ_ONLY.has(c), `${name}: ${c}() no es una lectura; la navegación no debe actuar`);
    assert.ok(!/\bfetch\(/.test(src), `${name}: sin fetch directo`);
  }
});

test('Decisiones aprueba o deniega SOLO con la tarjeta de siempre (cifra, riesgo y confirmación)', () => {
  const inbox = read('screens/InboxScreen.tsx');
  assert.match(inbox, /<PendingDecisionCard key=\{d\.id\} decision=\{d\} onResolved=\{onResolved\} \/>/);
  assert.ok(!inbox.includes('decideInbox'), 'la pantalla no decide por su cuenta');
  assert.match(read('components/PendingDecisionCard.tsx'), /api\.decideInbox\(/);
  // Lo que piden los agentes y el Asistente se resuelve en su sitio: aquí solo hay enlaces.
  assert.match(inbox, /to=\{`\/oficina\/agente\/\$\{encodeURIComponent\(agent\.id\)\}\/\$\{tabFor\(item\)\}`\}>Revisar<\/Link>/);
  // Decisiones es de la empresa: las peticiones de agentes de TODOS sus proyectos.
  assert.match(inbox, /osApi\.office\(slug, null\)/); assert.match(read('components/AttentionWatcher.tsx'), /osApi\.office\(slug, null\)/);
  assert.match(inbox, /<Link className="btn btn-secondary btn-sm" to="\/asistente">Abrir el Asistente<\/Link>/);
});

test('cada sección del menú tiene su ruta y las rutas antiguas siguen llevando a su sitio', () => {
  const app = read('App.tsx'); const routes = read('lib/routes.ts');
  const paths = [...routes.matchAll(/\{ id: '[a-z]+', label: '[^']+', path: '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(paths, ['/oficina', '/autorizaciones', '/asistente', '/panel', '/backlog', '/conocimiento', '/ajustes']);
  for (const p of paths) assert.ok(app.includes(`<Route path="${p}" `), `falta la ruta ${p}`);
  assert.match(app, /<Route path="\/equipo" element=\{<Redirect to="\/oficina\/organizacion" \/>\} \/>/);
  assert.match(app, /<Route path="\/decisiones" element=\{<Redirect to="\/autorizaciones" \/>\} \/>/);
  for (const p of ['/equipo/nuevo', '/equipo/:agentId', '/presupuestos', '/configuracion/proveedor', '/lotes', '/lotes/:batchId', '/actividad', '/procesos/:processId', '/historias/:storyId', '/archivo', '/etapa', '/oficina/agente/:agentId/:tab?', '/oficina/nuevo-agente', '/empresa/:slug/proyecto/:pid/*', '/empresa/:slug/*']) {
    assert.ok(app.includes(`<Route path="${p}" `), `se perdió la ruta ${p}`);
  }
  // Redirect conserva ?parámetros y #ancla (los enlaces directos antiguos siguen abriendo su pestaña).
  assert.match(app, /function Redirect\(\{ to \}: \{ to: string \}\) \{[\s\S]{0,200}search[\s\S]{0,40}hash/);
});

test('cambiar de empresa o proyecto va a la raíz de la sección (nunca a un detalle de la anterior) y monta las pantallas de nuevo', () => {
  const shell = read('components/Shell.tsx'); const app = read('App.tsx'); const routes = read('lib/routes.ts');
  assert.match(shell, /select\(slug, pid, \{ to: chosen => sectionRoot\(path, !!chosen\) \}\)/);
  // Selección y destino en la MISMA transición: nunca se monta la ruta anterior con la empresa nueva.
  assert.match(app, /startTransition\(\(\) => \{ setProjects\(ps\); setSel\(next\); if \(go\) navigate\(go\.to\(pid\), \{ replace: go\.replace \}\); \}\);/);
  assert.match(app, /<Routes key=\{`\$\{status\.workspace\?\.slug \?\? ''\}:\$\{status\.project\?\.id \?\? ''\}`\}>/);
  assert.match(routes, /if \(!s \|\| \(s\.needsProject && !hasProject\)\) return '\/oficina';/);
});

test('panel del agente: cada pestaña antigua pertenece a un grupo (los enlaces /oficina/agente/:id/<pestaña> siguen valiendo)', () => {
  const panel = read('components/AgentPanel.tsx');
  const tabs = (name: string) => panel.slice(panel.indexOf(`const ${name} = [`), panel.indexOf('] as const;', panel.indexOf(`const ${name} = [`)));
  const ids = new Set([...(tabs('BASE_TABS') + tabs('EXTERNAL_TABS')).matchAll(/\['([a-z]+)', '[^']+'\]/g)].map(m => m[1]));
  // HU-181: Mejoras se retira; …/mejoras es un alias de Memoria. Quedan 8: chat, solicitudes, trabajo, archivos,
  // memoria, configuracion, documentos y origen.
  assert.ok(ids.size >= 8, 'no se encontraron las pestañas');
  assert.ok(!ids.has('mejoras'), 'Mejoras ya no es una pestaña');
  assert.match(panel, /tab === 'mejoras'/);
  const groupOf = panel.match(/const GROUP_OF: Record<Tab, Group> = \{([^}]*)\}/);
  assert.ok(groupOf, 'falta GROUP_OF');
  for (const id of ids) assert.match(groupOf[1], new RegExp(`\\b${id}: '`), `la pestaña «${id}» no tiene grupo`);
  for (const kind of ['memory', 'improvement', 'source', 'folder', 'action']) assert.match(read('lib/routes.ts'), new RegExp(`${kind}: '[a-z]+'`), `TAB_FOR_KIND sin «${kind}»`);
});

test('la Oficina no inventa actividad: las animaciones de estado terminan y dependen del estado real', () => {
  const css = read('office.css') + read('system.css');
  for (const m of css.matchAll(/animation:\s*([a-zA-Z-]+)[^;}]*/g)) {
    if (/^(fadeIn|fadeUp|spin)$/.test(m[1])) continue;
    assert.match(m[0], /\s(1|2|3)\s*(;|$)|\s(1|2|3)\b/, `«${m[0]}» debe repetirse un número finito de veces`);
  }
  assert.ok(!/Math\.random\(/.test(read('screens/Office.tsx')), 'la Oficina no usa azar para pintar actividad');
});

test('colores solo desde tokens: ningún #hex en los componentes salvo la figura del agente (su ilustración)', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []);
  for (const f of walk(webSrc)) {
    const rel = path.relative(webSrc, f).replace(/\\/g, '/');
    if (rel === 'components/AgentFigure.tsx') continue;
    const src = fs.readFileSync(f, 'utf8');
    const hex = src.match(/['"`(\s:]#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g) ?? [];
    assert.deepEqual(hex, [], `${rel} escribe colores #hex; usa var(--color-…)`);
    assert.deepEqual(src.match(/\b(?:rgba?|hsla?)\(/g) ?? [], [], `${rel} escribe colores rgb()/hsl(); usa var(--color-…)`);
  }
});

test('raíz de sección al cambiar de empresa o proyecto (comportamiento, no solo texto)', () => {
  assert.equal(sectionRoot('/historias/abc', true), '/backlog', 'un detalle de historia → Backlog');
  assert.equal(sectionRoot('/procesos/p1', true), '/actividad');
  assert.equal(sectionRoot('/lotes/b1', true), '/lotes');
  assert.equal(sectionRoot('/lotes/b1', false), '/oficina', 'sin proyecto, las secciones de proyecto llevan a la Oficina');
  assert.equal(sectionRoot('/autorizaciones', false), '/autorizaciones', 'Decisiones es de empresa');
  assert.equal(sectionRoot('/presupuestos', false), '/presupuestos');
  assert.equal(sectionRoot('/oficina/organizacion', true), '/oficina/organizacion', 'se queda en la vista de la Oficina');
  assert.equal(sectionRoot('/equipo/a1', true), '/oficina', 'la ficha avanzada de un agente (de la otra empresa) no se reabre');
  assert.equal(sectionOf('/configuracion/proveedor')?.id, 'ajustes');
  assert.deepEqual(parentOf('/configuracion/proveedor'), { path: '/ajustes', label: 'Ajustes' }, '«Atrás» desde Proveedores va a Ajustes');
  assert.equal(tabFor({ kind: 'memory' }), 'memoria'); assert.equal(tabFor({ kind: 'action' }), 'chat');
  assert.equal(tabFor({ kind: 'decision', processId: 'p1' }), 'solicitudes', 'lo que depende de un proceso se ve en Solicitudes');
});

test('lo compartido no vive en el trozo diferido de la Oficina (el aspecto no depende de haberla visitado)', () => {
  const office = read('office.css'); const sys = read('system.css');
  for (const sel of ['.state-pill', '.tab-count', '.os-portal', '.harness-card', '.toast']) {
    // Una regla PROPIA del selector (al principio de línea); las contextuales (.agent-panel-head .state-pill) sí pueden quedarse.
    assert.ok(!new RegExp(`^${sel.replace('.', '\\.')}\\s*[{,]`, 'm').test(office), `${sel} está en office.css (se carga solo con la Oficina)`);
  }
  assert.match(sys, /\.state-pill \{/); assert.match(sys, /body, \.agent-panel, \.os-portal, \.dock \{ font-family: var\(--font-sans\)/);
  assert.match(sys, /\.harness-card \{/);
});

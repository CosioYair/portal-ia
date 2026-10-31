import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Cableado de la navegación con contexto y del tiempo real en la interfaz (el comportamiento se prueba en el navegador:
 * ver la documentación de la verificación). Aquí: que nadie vuelva a sondear cada pocos segundos, que el «Atrás» global
 * y el estado por entrada del historial sigan conectados, y que las acciones lleven la versión que vio la pestaña.
 */
const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');
const read = (f: string) => fs.readFileSync(path.join(web, f), 'utf8');

test('tiempo real: una sola conexión por pestaña visible, respaldo cada 15 s y resync al reconectar', () => {
  const live = read('lib/live.ts');
  assert.equal(live.split("new EventSource('/api/events')").length - 1, 1, 'una sola conexión');
  assert.match(live, /visibilitychange/); assert.match(live, /disconnect, 30_000/, 'oculta más de 30 s: se cierra');
  assert.match(live, /addEventListener\('resync'/); assert.match(live, /fireAll\(true\)/);
  assert.match(live, /15_000/, 'respaldo sin conexión');
  assert.match(live, /noteResponse\(String\(d\.serverTime\)/, 'los latidos mantienen la hora del servidor y la frescura');
});

test('ninguna pantalla principal sondea cada pocos segundos: se suscriben a los cambios', () => {
  for (const [f, re] of [['screens/StoryWorkspace.tsx', /setTimeout\(tick, c === null \? 5000 : 3000\)/], ['screens/ProcessView.tsx', /setTimeout\(tick, p\.status === 'running' \? 2000 : 5000\)/], ['screens/Batches.tsx', /setInterval\(load, (3000|5000)\)/], ['components/Shell.tsx', /setTimeout\(tick, 5000\)/], ['screens/InboxScreen.tsx', /setInterval\(tick, 30000\)/]] as const) {
    const src = read(f); assert.doesNotMatch(src, re, `${f}: sin el sondeo antiguo`); assert.match(src, /useLive\(/, `${f}: se suscribe`);
  }
  for (const f of ['screens/Backlog.tsx', 'screens/Dashboard.tsx', 'components/SystemBar.tsx', 'components/AssistantChat.tsx', 'components/ConversationPanel.tsx']) assert.match(read(f), /useLive\(/, `${f}: se actualiza sola`);
});

test('respuestas fuera de orden: la más reciente gana (detalle del proceso, historia, lote y Backlog)', () => {
  for (const f of ['screens/ProcessView.tsx', 'screens/StoryWorkspace.tsx', 'screens/Batches.tsx', 'screens/Backlog.tsx']) assert.match(read(f), /latest\.run\(/, f);
});

test('«Atrás» global en la cabecera, con el nombre de la pantalla a la que vuelve; historial por pestaña', () => {
  const shell = read('components/Shell.tsx');
  assert.match(shell, /const back = useBack\(\)/); assert.match(shell, /onClick=\{back\.go\}/); assert.match(shell, /aria-label=\{`Atrás: volver a \$\{back\.label\}`\}/);
  const nav = read('lib/nav.ts');
  assert.match(nav, /sessionStorage/); assert.match(nav, /navigate\(-1\)/, 'usa el historial del navegador (sin entradas artificiales)');
  assert.match(nav, /parentOf\(pathname\)/, 'sin pantalla anterior del Portal: la pantalla madre');
  assert.match(read('App.tsx'), /useEntryRecorder\(\)/);
  assert.match(read('screens/Backlog.tsx'), /useTabState\(`portal-ia\.backlog\.busqueda\./, 'búsqueda y filtros por pestaña');
  assert.match(read('screens/ProcessView.tsx'), /useEntryState<'all' \| ProcessFilterKey>\('actividad\.filtro'/);
});

test('pestaña desactualizada: las acciones sobre un proceso llevan la versión que vio la pestaña', () => {
  const api = read('lib/api.ts');
  assert.match(api, /seenVersion: v/); assert.match(api, /if \(res\.ok\) noteVersions\(body\)/, 'un 409 stale_view no cuenta como visto');
});

test('reiniciar con procesos en marcha exige confirmar que se interrumpen', () => {
  const bar = read('components/SystemBar.tsx');
  assert.match(bar, /Entiendo que se interrumpirán y quiero reiniciar ahora\./); assert.match(bar, /interruptRunning: true/);
});

test('Ronda B · M4: reconstruir no bloquea el carril más que el build, tiene tope de tiempo y no reinicia sobre trabajo nuevo', () => {
  const sys = fs.readFileSync(path.join(web, '..', '..', 'server', 'src', 'services', 'system.ts'), 'utf8');
  assert.match(sys, /timeoutMs = 15 \* 60_000/); assert.match(sys, /append, 10 \* 60_000\)/);
  const start = sys.slice(sys.indexOf('export async function startUpdate'));
  assert.ok(start.indexOf("withRepoLock(REPO_ROOT") > start.indexOf("npm install"), 'npm install va fuera del carril');
  assert.match(start, /const running = runningEverywhere\(\);\s*if \(opts\.restart && running\.length && !opts\.interruptRunning\)/, 'se vuelve a mirar antes de reiniciar');
  const routes = fs.readFileSync(path.join(web, '..', '..', 'server', 'src', 'routes', 'processes.ts'), 'utf8');
  assert.match(routes, /STARTS_WORK\.test\(m\[1\]\) && updateRunning\(\)/, 'durante la reconstrucción no empieza trabajo nuevo');
  assert.match(routes, /addHook\('onRoute'/, 'el arriendo se suelta al terminar el manejador (aunque el navegador se haya ido)');
});

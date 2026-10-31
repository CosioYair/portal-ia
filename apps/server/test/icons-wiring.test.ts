import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-168: biblioteca de iconos ampliada y estados con icono y texto (comprobación estática, sin IA).
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const ui = read('components/ui.tsx');
const iconBlock = ui.slice(ui.indexOf('export const Icon = {'), ui.search(/\r?\n\};/));
const iconLine = (key: string) => {
  const line = iconBlock.split(/\r?\n/).find(l => l.trimStart().startsWith(`${key}: (`));
  assert.ok(line, `falta Icon.${key}`);
  return line;
};

const NEW_KEYS = ['story', 'process', 'authorization', 'agent', 'file', 'publish', 'panelWide', 'panelNarrow', 'statePending', 'stateRunning', 'stateDone', 'stateError', 'stateBlocked'];

test('Icon incluye los 13 iconos nuevos con trazo L de 1,5 px y aria-hidden', () => {
  assert.match(ui, /const L = \{ stroke: 'currentColor', strokeWidth: 1\.5, strokeLinecap: 'round', strokeLinejoin: 'round' \} as const;/);
  assert.match(ui, /aria-hidden="true"/);
  for (const key of NEW_KEYS) {
    const line = iconLine(key);
    assert.ok(line.includes('svg('), `Icon.${key} debe usar svg()`);
    assert.ok(line.includes('{...L}'), `Icon.${key} debe usar el trazo L`);
    assert.ok(!line.includes('{...S}') && !line.includes('{...R}'), `Icon.${key} no debe usar S ni R`);
  }
});

test('los iconos existentes no cambian', () => {
  assert.match(ui, /const S = \{ stroke: 'currentColor', strokeWidth: 1\.5 \} as const;/);
  assert.match(ui, /const R = \{ stroke: 'currentColor', strokeWidth: 1\.6, strokeLinecap: 'round', strokeLinejoin: 'round' \} as const;/);
  const expected: Record<string, string> = {
    arrow: 'd="M3 8h10M9 4l4 4-4 4" {...R}',
    lock: 'd="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" {...S}',
    okc: 'd="M5 8.3l2 2 4-4.5" {...R}',
    alert: 'd="M8 4.8v3.7M8 11.2h.01" {...R}',
    info: 'd="M8 7.2v4M8 4.8h.01" {...R}',
    warn: 'd="M8 2.5l6 10.5H2z" {...S}',
    x: 'd="M4 4l8 8M12 4l-8 8" {...R}',
    gear: 'd="M8 1.75v1.75M8 12.5v1.75M1.75 8H3.5M12.5 8h1.75M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" {...S}'
  };
  for (const [key, frag] of Object.entries(expected)) assert.ok(iconLine(key).includes(frag), `Icon.${key} ha cambiado`);
  const firstNew = iconBlock.indexOf('story: (');
  for (const key of Object.keys(expected)) assert.ok(iconBlock.indexOf(`${key}: (`) < firstNew, `Icon.${key} no debe moverse tras los nuevos`);
});

test('StatusIcon comunica el estado con icono y texto, nunca solo con color', () => {
  assert.match(ui, /export type PortalState = 'pending' \| 'running' \| 'done' \| 'error' \| 'blocked';/);
  for (const label of ['Pendiente', 'En curso', 'Completado', 'Error', 'Bloqueado']) assert.ok(ui.includes(`'${label}'`), `falta el texto «${label}»`);
  const body = ui.slice(ui.indexOf('export function StatusIcon'));
  assert.match(body, /className="sr-only"/);
  assert.match(body, /status-ic-text/);
  assert.match(read('styles.css'), /\.sr-only\s*\{/);
  assert.match(read('styles.css'), /\.status-ic\s*\{/);
});

test('el botón del panel del asistente usa icono y aria-label', () => {
  const dock = read('components/AssistantDock.tsx');
  assert.ok(!dock.includes('⇤ ancho') && !dock.includes('⇥ estrecho'), 'quedan los textos «⇤ ancho» / «⇥ estrecho»');
  assert.ok(dock.includes("aria-label={wide ? 'Panel estrecho' : 'Panel ancho'}"));
  assert.ok(dock.includes('aria-pressed={wide}'));
  assert.ok(dock.includes('{wide ? Icon.panelNarrow() : Icon.panelWide()}'));
});

test('el punto de proceso del Dashboard va con StatusIcon y texto accesible', () => {
  const dash = read('screens/Dashboard.tsx');
  const line = dash.split(/\r?\n/).find(l => l.includes('procs.slice(0, 4).map('));
  assert.ok(line, 'no se encontró la lista de procesos del Dashboard');
  // El texto accesible del icono es el mismo que el visible (PROC_LABEL), para que un proceso cancelado no se anuncie como «Pendiente».
  assert.ok(line.includes('<StatusIcon state={procState(p.status)} label={PROC_LABEL[p.status] ?? p.status} showLabel={false} />'), 'el StatusIcon del proceso debe llevar el texto accesible de PROC_LABEL');
  assert.ok(line.includes('{PROC_LABEL[p.status] ?? p.status}</span>'), 'la fila del proceso debe mostrar también el texto del estado');
  assert.match(dash, /cancelled: 'cancelado'/);
==== FIN
  assert.ok(!/className=\{?[`'"]dot\b/.test(line), 'la fila del proceso no debe usar un punto solo de color');
  assert.match(dash, /function procState\(status: string\): PortalState/);
});

test('apps/web no añade dependencias', () => {
  const baseDeps = ['@portal-ia/domain', 'react', 'react-dom', 'react-router-dom'];
  const baseDev = ['@types/react', '@types/react-dom', '@vitejs/plugin-react', 'vite'];
  const pkg = JSON.parse(fs.readFileSync(path.join(webSrc, '..', 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), baseDeps);
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}).sort(), baseDev);
  const lockPath = path.join(repoRoot, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const entry = JSON.parse(fs.readFileSync(lockPath, 'utf8')).packages?.['apps/web'];
    if (entry) {
      assert.deepEqual(Object.keys(entry.dependencies ?? {}).sort(), baseDeps);
      assert.deepEqual(Object.keys(entry.devDependencies ?? {}).sort(), baseDev);
    }
  }
});

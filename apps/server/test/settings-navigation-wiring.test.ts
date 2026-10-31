import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-159 (bloqueo real): pantallas de configuración accesibles, autorización de Claude Code verificable desde la
// historia y una pestaña con la interfaz anterior que no ignora acciones en silencio. (El recorrido en el navegador se
// comprobó con Playwright sobre una instancia aislada y, en solo lectura, sobre el Portal real.)
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

test('Presupuestos es una sección navegable con el subsistema que ya existe (no «próx.»)', () => {
  const shell = read('components/Shell.tsx'); const app = read('App.tsx'); const screen = read('screens/Budgets.tsx');
  assert.match(app, /<Route path="\/presupuestos" element=\{guard\(<Budgets \/>\)\} \/>/);
  assert.match(shell, /to="\/presupuestos">\{Icon\.wallet\(\)\}<span>Presupuestos<\/span>/);
  assert.ok(!/\['Presupuestos', Icon\.wallet\]/.test(shell), 'ya no aparece deshabilitada');
  assert.match(screen, /<BudgetMeter level="company" scopeId=\{ws\.slug\}/); assert.match(screen, /<BudgetMeter level="project" scopeId=\{project\.id\} workspace=\{ws\.slug\}/);
  assert.match(screen, /presupuesto no positivo/, 'distingue el gasto de pruebas que hablan de presupuestos');
  assert.match(screen, /to="\/configuracion\/proveedor#claude-code"/);
});

test('Claude Code — Local y sus proyectos autorizados tienen enlace directo; autorizar se comprueba con lo guardado', () => {
  const shell = read('components/Shell.tsx'); const panel = read('components/ClaudeCodePanel.tsx'); const agent = read('screens/AgentDetail.tsx');
  assert.match(shell, /to="\/configuracion\/proveedor#claude-code">\{Icon\.plug\(\)\}<span style=\{\{ flex: 1 \}\}>Claude Code — Local/);
  assert.match(panel, /id="claude-code-proyectos"/); assert.match(panel, /window\.location\.hash\.startsWith\('#claude-code'\)/, 'el enlace se desplaza a la sección al cargar');
  assert.match(panel, /const saved = !!v\?\.projects\.includes\(id\)/, 'el mensaje sale de lo releído, no de lo pedido');
  assert.match(agent, /fresh\.projects\.find\(x => x\.id === p\.id\)\?\.authorized/);
});

test('historia bloqueada por Claude Code: tarjeta con el estado real, autorizar NO continúa y una acción desconocida se dice', () => {
  const sfp = read('components/StoryFlowPanel.tsx');
  assert.match(sfp, /api\.claudeCodeFix\(slug, proc\.id, a\.backendFix\)/);
  const fix = sfp.slice(sfp.indexOf("a.id === 'claude_code_fix' && a.backendFix"), sfp.indexOf("a.id === 'recover'"));
  assert.ok(!fix.includes('continueProcess'), 'autorizar y continuar son dos decisiones: primero se comprueba');
  assert.match(fix, /if \(rd\.ready\)/);
  assert.match(sfp, /<ClaudeCodeCard cc=\{cc\} \/>/); assert.match(sfp, /Solo se guarda y se comprueba: <strong>no continúa ni llama a la IA<\/strong>/);
  assert.ok(sfp.indexOf("confirming.id === 'claude_code_fix' ?") < sfp.indexOf('en el sandbox, sobre el worktree del proceso'), 'autorizar Claude Code tiene su propio texto, antes del genérico');
  assert.match(sfp, /if \(!HANDLED\.has\(a\.id\)\) \{ setErr\(/, 'una acción que esta versión no conoce no se ignora');
  assert.match(sfp, /if \(a\.id === 'open_settings'\) \{ if \(a\.href\) navigate\(a\.href\); return; \}/);
  assert.match(sfp, /issue\.links!\.map/, 'el error enlaza la pantalla donde se corrige');
  assert.match(sfp, /code === 'backend_not_ready'/);
});

test('cada acción del flujo que puede enviar el servidor la ejecuta la interfaz (ninguna queda como botón muerto)', () => {
  // «Seguir con este plan» (accept_plan) llegó a la interfaz sin estar en HANDLED: el botón solo decía «recarga la página».
  const types = fs.readFileSync(fileURLToPath(new URL('../../../packages/domain/src/types.ts', import.meta.url)), 'utf8');
  const union = types.slice(types.indexOf('export type FlowActionId ='), types.indexOf('export interface FlowAction {'));
  const ids = [...union.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  const handled = read('components/StoryFlowPanel.tsx').match(/const HANDLED = new Set<FlowActionId>\(\[([^\]]*)\]\)/)![1];
  assert.ok(ids.length >= 30 && ids.includes('accept_plan'), `${ids.length} acciones leídas`);
  assert.deepEqual(ids.filter(id => !handled.includes(`'${id}'`)), []);
});

test('historial: un evento repetido se muestra una vez (×N y la última hora); el registro técnico los conserva todos', () => {
  const sfp = read('components/StoryFlowPanel.tsx');
  assert.match(sfp, /grouped\.delete\(k\); grouped\.set\(k, \{ e, n: \(g\?\.n \?\? 0\) \+ 1 \}\)/);
  assert.match(sfp, /×\{n\}, la última a las \{hhmm\(e\.at\)\}/);
  assert.match(sfp, /Registro técnico completo \(\{pl\.events\.length\} eventos\)/);
});

test('interfaz desactualizada: el servidor dice qué paquete sirve y la pestaña con uno anterior pide recargar', () => {
  const server = fs.readFileSync(fileURLToPath(new URL('../src/app.ts', import.meta.url)), 'utf8');
  assert.match(server, /reply\.header\('x-portal-web', web\)/);
  assert.match(read('lib/api.ts'), /noteBundle\(res\.headers\.get\('x-portal-web'\)\)/);
  assert.match(read('components/Shell.tsx'), /aria-label="Interfaz desactualizada"/);
});

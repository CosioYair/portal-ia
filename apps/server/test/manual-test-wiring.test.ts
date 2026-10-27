import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-147: comprueba que el detalle del proceso (/procesos/<id>) usa de verdad el componente
// de feedback por paso y que ya no quedan casillas en «Qué probar, paso a paso».
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(full);
  }
  return out;
}

const HEADING = 'Qué probar, paso a paso';

/** Componentes de components/ que contienen la lista con feedback por ítem (clases mts-list / mts-item). */
function stepListComponents(): string[] {
  const dir = path.join(webSrc, 'components');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.tsx'))
    .filter(f => { const s = fs.readFileSync(path.join(dir, f), 'utf8'); return s.includes('mts-list') && s.includes('mts-item'); })
    .map(f => f.replace(/\.tsx$/, ''));
}

test('existe el componente de lista de pasos con feedback por ítem (OK, Falla, Observación, comentario)', () => {
  const comps = stepListComponents();
  assert.ok(comps.length > 0, 'no se encontró en src/components un componente con las clases mts-list y mts-item');
  for (const name of comps) {
    const src = read(`components/${name}.tsx`);
    assert.match(src, /OK/);
    assert.match(src, /Falla/);
    assert.match(src, /Observaci[oó]n/);
    assert.match(src, /<textarea/);
  }
});

/** Componentes de src/components renderizados (directa o transitivamente, hasta 3 niveles) por una pantalla. */
function renderedComponents(source: string, depth = 3): Set<string> {
  const out = new Set<string>();
  const visit = (src: string, d: number) => {
    for (const m of src.matchAll(/from\s+['"](?:\.\.\/components|\.)\/([A-Za-z0-9_]+)\.tsx['"]/g)) {
      const name = m[1];
      if (!new RegExp(`<${name}[\\s/>]`).test(src)) continue;
      if (out.has(name)) continue;
      out.add(name);
      if (d > 0) { try { visit(read(`components/${name}.tsx`), d - 1); } catch { /* no es un componente */ } }
    }
  };
  visit(source, depth);
  return out;
}

test('el detalle del proceso importa y renderiza el componente de lista de pasos', () => {
  // M6: ProcessView renderiza StoryResult → StoryOverview → ManualTestStepList (una sola lista, con feedback por paso).
  const screen = read('screens/ProcessView.tsx');
  const comps = stepListComponents();
  const rendered = renderedComponents(screen);
  const used = comps.filter(name => rendered.has(name));
  assert.ok(used.length > 0,
    `ProcessView.tsx no renderiza (ni directa ni transitivamente) ninguno de los componentes de lista de pasos (${comps.join(', ') || 'ninguno'}). El feedback por paso no está conectado en /procesos/<id>.`);
});

test('«Qué probar, paso a paso» ya no usa casillas en el detalle del proceso', () => {
  const screen = read('screens/ProcessView.tsx');
  const comps = stepListComponents();
  const sources = [screen, ...comps.map(c => read(`components/${c}.tsx`))];
  const withHeading = sources.find(s => s.includes(HEADING));
  assert.ok(withHeading, `no aparece el encabezado «${HEADING}» ni en ProcessView.tsx ni en el componente de lista`);
  const from = withHeading.indexOf(HEADING);
  const region = withHeading.slice(from, from + 2500);
  assert.ok(!/type=["']checkbox["']/.test(region), 'la sección «Qué probar, paso a paso» sigue renderizando input type="checkbox"');
});

test('el panel antiguo de feedback ya no se monta aparte en /procesos/:processId', () => {
  const app = read('App.tsx');
  const route = app.split('\n').find(l => l.includes('path="/procesos/:processId"')) ?? '';
  assert.ok(route, 'no se encontró la ruta /procesos/:processId en App.tsx');
  assert.ok(!route.includes('ManualTestFeedbackPanel'), 'App.tsx sigue montando el panel aparte ManualTestFeedbackPanel en el detalle del proceso');
});

test('el CSS del componente de feedback se importa en la aplicación', () => {
  const importing = walk(webSrc).filter(f => /import\s+['"][^'"]*manual-test-feedback\.css['"]/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(importing.length > 0, 'ningún archivo importa manual-test-feedback.css');
});

test('el CSS de la lista no recorta el texto de los pasos', () => {
  const css = fs.readFileSync(path.join(webSrc, 'manual-test-feedback.css'), 'utf8');
  const textRule = css.split('\n').find(l => l.startsWith('.mts-text')) ?? '';
  assert.ok(textRule, 'falta la regla .mts-text');
  assert.ok(!/nowrap|ellipsis/.test(textRule));
  assert.match(textRule, /overflow-wrap:\s*anywhere/);
});

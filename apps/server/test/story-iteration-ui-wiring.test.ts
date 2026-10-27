import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Fase 2: la interfaz usa de verdad las acciones de «Pasos con falla», el componente único de iteración y la edición
// del contexto. (El recorrido completo en el navegador se comprobó con Playwright sobre una instancia aislada.)
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

test('«Pasos con falla» ofrece enviar el feedback al equipo y crear tareas, guardando antes los comentarios', () => {
  const list = read('components/ManualTestStepList.tsx');
  assert.match(list, /failureActions\?\.\(\{ failed: .*flush \}\)/, 'la lista expone el hueco de acciones con flush');
  const overview = read('components/StoryOverview.tsx');
  assert.match(overview, /failureActions=\{proc\.backlogItemId \? .*<FeedbackToTeam /);
  const fb = read('components/FeedbackToTeam.tsx');
  assert.ok(fb.includes('Enviar este feedback al equipo (nueva iteración)')); assert.ok(fb.includes('Crear tareas con estos fallos'));
  assert.match(fb, /api\.storyTasksFromFeedback/); assert.match(fb, /<IterationComposer /);
  assert.match(fb, /navigate\(`\/historias\/\$\{itemId\}#iteraciones`\)/, 'tras crear la iteración abre «Iteraciones»');
  assert.match(fb, /await flush\(\)/);
});

test('una sola implementación de «crear iteración»: reabrir y confirmar el descarte vienen del servidor', () => {
  const comp = read('components/IterationComposer.tsx');
  assert.match(comp, /api\.storyIterate\(slug, itemId, .*\{ reopen: iteration\.needsReopen, discardApplied: iteration\.needsDiscardConfirmation && confirmDiscard \}/);
  assert.match(comp, /disabled=\{busy \|\| blocked\}/, 'sin confirmar el descarte no se puede crear');
  const ws = read('screens/StoryWorkspace.tsx');
  assert.match(ws, /<IterationComposer /); assert.ok(!ws.includes('reábrela desde Backlog'), 'la historia cerrada se reabre desde aquí');
  assert.match(ws, /navigate\(\{ hash: t \}, \{ replace: true \}\)/, 'la pestaña vive en el hash');
});

test('el panel Contexto permite editar título, criterio y descripción con el PATCH existente', () => {
  const ws = read('screens/StoryWorkspace.tsx');
  assert.match(ws, />Editar<\/button>/); assert.match(ws, /api\.patchBacklogItem\(slug, ctx\.item\.id, changed\)/);
  for (const id of ['ctx-title', 'ctx-criterion', 'ctx-description']) assert.ok(ws.includes(`id="${id}"`), id);
});

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

test('recorrido guiado: una sola cabecera (StoryFlowPanel) en la historia y en el proceso, sin orden de cierre calculado en el cliente', () => {
  const ws = read('screens/StoryWorkspace.tsx'); const pv = read('screens/ProcessView.tsx'); const ov = read('components/StoryOverview.tsx');
  assert.match(ws, /<StoryFlowPanel proc=\{last\}/); assert.match(pv, /<StoryFlowPanel proc=\{proc\} variant="process"/);
  assert.ok(!ov.includes('Orden de cierre'), 'el orden de cierre lo calcula el servidor (guidance.flow)');
  const panel = read('components/StoryFlowPanel.tsx');
  for (const id of ['install_and_retry', 'request_fix', 'ask_team', 'tasks_from_issue', 'merge', 'runtime_check', 'retry_process', 'recover']) assert.ok(panel.includes(`'${id}'`), id);
  assert.match(panel, /requires\.some\(r => r === 'authorization' \|\| r === 'network'\) && confirming\?\.id !== a\.id/, 'lo que exige autorización o red pide confirmación antes');
});

// HU-166 · Motivo: la autorización estaba en una pestaña secundaria (Iteraciones); ahora el siguiente paso, incluida la
// autorización, está siempre en la cabecera (StoryFlowPanel, desde guidance.flow), sin cambiar de pestaña ni de hash.
test('HU-166: la autorización se hace desde la cabecera, sin cambiar de pestaña', () => {
  const panel = read('components/StoryFlowPanel.tsx');
  assert.match(panel, /onAuthorize\?: \(\) => void/); assert.match(panel, /authorizeSlot\?: ReactNode/);
  assert.match(panel, /a\.id === 'authorize'\) \{ if \(variant === 'story' && onAuthorize\) onAuthorize\(\)/, '«Autorizar…» abre el formulario en la cabecera');
  assert.ok(panel.includes('{!readOnly && authorizeSlot}'), 'el formulario se muestra bajo las acciones de la cabecera');
  const ws = read('screens/StoryWorkspace.tsx');
  assert.match(ws, /<StoryFlowPanel proc=\{last\}[^\n]*\n?[^\n]*onAuthorize=\{openAuthorize\} authorizeSlot=\{authForm\}/, 'la historia pasa onAuthorize y authorizeSlot a la cabecera');
  assert.ok(ws.includes('id="sec-authorize-story"'), 'el formulario de autorización vive en la cabecera');
  const iterIdx = ws.indexOf("{tab === 'iteraciones' &&"); assert.ok(iterIdx > 0, 'existe la pestaña Iteraciones');
  const authIdx = ws.indexOf('api.authorizeProcess(slug, pending.id, Number(budget), pipeline)');
  assert.ok(authIdx > 0 && authIdx < iterIdx, 'la llamada de autorización no está en la pestaña Iteraciones');
  assert.ok(!ws.slice(iterIdx).includes('onClick={authorize}'), 'en Iteraciones ya no hay un segundo formulario de autorización');
  assert.ok(!ws.includes("btn btn-primary btn-sm\" onClick={() => openTab('iteraciones')}"), 'el aviso de decisión ya no lleva a Iteraciones para autorizar');
  assert.ok(!ws.includes('Autorízala en la pestaña Iteraciones.'));
  // Siempre hay un botón principal: si flow no trae acción principal, el respaldo es «Ver el proceso y los agentes».
  assert.ok(panel.includes("const fallback = variant === 'story' && !primary && !readOnly;"), 'el respaldo solo aparece cuando no hay acción principal');
  assert.match(panel, /fallback && <Link className="btn btn-primary btn-sm" to=\{`\/procesos\/\$\{proc\.id\}`\}>\{Icon\.arrow\(\)\}Ver el proceso y los agentes<\/Link>/, 'el respaldo es el btn-primary de la cabecera');
  assert.ok(panel.includes('(flow.actions.length > 0 || fallback)'), 'el bloque de acciones se muestra también con solo el respaldo');
  assert.ok(panel.includes('!fallback && <Link className="btn btn-ghost btn-sm" to={`/procesos/${proc.id}`}>Ver el proceso y los agentes</Link>'), 'sin duplicar el enlace secundario cuando el respaldo es el principal');
  // Historia archivada: el enlace principal al archivo queda fuera del fieldset desactivado.
  const archIdx = ws.indexOf('{it.archivedAt && <Link className="btn btn-primary btn-sm" to="/archivo">');
  const fsIdx = ws.indexOf('<fieldset disabled={!!it.archivedAt}');
  assert.ok(archIdx > 0, 'la historia archivada tiene un enlace btn-primary al archivo');
  assert.ok(fsIdx > 0 && archIdx < fsIdx, 'el enlace al archivo está fuera del fieldset desactivado');
  // Sin proceso: «pending» → Ejecutar desde Backlog; cualquier otro estado (p. ej. descartada) → Volver al Backlog.
  assert.ok(ws.includes("{!last && it.status === 'pending' && !it.archivedAt && <button className=\"btn btn-primary btn-sm\" onClick={() => navigate(`/backlog?ejecutar=${it.id}`)}>"), 'sin proceso y pendiente: Ejecutar desde Backlog');
  assert.ok(ws.includes("{!last && it.status !== 'pending' && !it.archivedAt && <Link className=\"btn btn-primary btn-sm\" to=\"/backlog\">"), 'sin proceso y no pendiente: btn-primary Volver al Backlog');
});

test('pipeline autorizado: la autorización de una historia incluye el pipeline en las 4 entradas y el panel continúa/repara con presupuesto', () => {
  for (const [file, re] of [['screens/Backlog.tsx', /api\.authorizeProcess\(ws\.slug, p\.id, Number\(budget\), pipeline\)/], ['screens/ProcessView.tsx', /api\.authorizeProcess\(slug, proc\.id, Number\(budget\), proc\.kind === 'story_execution' \? pipeline : undefined\)/], ['screens/StoryWorkspace.tsx', /api\.authorizeProcess\(slug, pending\.id, Number\(budget\), pipeline\)/], ['components/AssistantChat.tsx', /action\.type === 'propose_execution' \? DEFAULT_PIPELINE : undefined/]] as const) assert.match(read(file), re, file);
  for (const file of ['screens/Backlog.tsx', 'screens/ProcessView.tsx', 'screens/StoryWorkspace.tsx']) assert.match(read(file), /<PipelineOptions /, file);
  const panel = read('components/StoryFlowPanel.tsx');
  assert.match(panel, /a\.id === 'pipeline_resume' \|\| a\.id === 'repair_output'/); assert.match(panel, /api\.continueProcess\(slug, proc\.id, \{ addBudgetUsd: add/);
  assert.match(panel, /<PipelineActivity proc=\{proc\} \/>/); assert.match(panel, /flow\.headline/);
  const opts = read('components/PipelineOptions.tsx'); assert.ok(opts.includes('Nunca automático: integrar en main, reiniciar el Portal, publicar en GitHub'));
});

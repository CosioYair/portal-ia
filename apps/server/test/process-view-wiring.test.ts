import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// HU-167 · Detalle de proceso: resumen primero y siguiente paso como botón. Prueba estática (sin IA): cableado de la
// cabecera, del botón (que nunca lanza acciones con costo), de los plegables cerrados y del filtro de Actividad, y las
// funciones puras de lib/processView.ts importadas tal cual.
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const { procLabel, processFilterKey, nextStepTarget, PROCESS_FILTERS } = await import(pathToFileURL(path.join(webSrc, 'lib/processView.ts')).href);

const mk = (over: Record<string, unknown> = {}) => ({
  id: 'p1', kind: 'story_execution', status: 'running', title: 'HU-1', steps: [{ id: 's1', status: 'running' }],
  guidance: { phase: 'Trabajando', tone: 'info', next: 'Espera a que termine' }, result: undefined, archivedAt: undefined,
  backlogItemId: 'b1', inputTokens: 0, outputTokens: 0, spentUsd: 0, budgetUsd: 1, estimatedUsd: 0.5, ...over
});
const paused = { pipeline: { state: 'paused' }, changes: [] };

test('procLabel y processFilterKey: pausado espera tu decisión; budget_exceeded cuenta como error', () => {
  // Portal IA 3: un solo criterio (ownerProcessState); «Completado» deja de existir como estado.
  assert.equal(procLabel(mk({ status: 'done', result: paused })).label, 'Necesita tu decisión');
  assert.equal(procLabel(mk({ status: 'done', result: { pipeline: { state: 'stopped', pauseKind: 'no_changes' }, changes: [] } })).label, 'Sin cambios necesarios');
  assert.equal(procLabel(mk({ status: 'done', result: { pipeline: { state: 'stopped', pauseKind: 'limit' }, applied: { branch: 'b', commit: 'c', worktree: 'w' } } })).label, 'Detenido sin terminar');
  assert.equal(processFilterKey(mk({ status: 'running' })), 'running');
  assert.equal(processFilterKey(mk({ status: 'pending_authorization' })), 'waiting');
  assert.equal(processFilterKey(mk({ status: 'done', result: paused })), 'waiting');
  assert.equal(processFilterKey(mk({ status: 'done', result: { pipeline: { state: 'stopped', pauseKind: 'gate' }, changes: [] } })), 'waiting');
  assert.equal(processFilterKey(mk({ status: 'done' })), 'done');
  assert.equal(processFilterKey(mk({ status: 'failed' })), 'failed');
  assert.equal(processFilterKey(mk({ status: 'budget_exceeded' })), 'failed');
  assert.equal(processFilterKey(mk({ status: 'cancelled' })), 'cancelled');
  assert.deepEqual(PROCESS_FILTERS.map((f: { label: string }) => f.label), ['Todos', 'En curso', 'Esperan tu decisión', 'Completados', 'Con errores', 'Cancelados']);
});

test('nextStepTarget: solo lleva a secciones que se pintan; archivado o sin guidance no hay botón', () => {
  assert.equal(nextStepTarget(mk({ archivedAt: '2026-01-01' })), null, 'archivado: histórico, sin acciones');
  assert.equal(nextStepTarget(mk({ guidance: undefined })), null);
  assert.deepEqual(nextStepTarget(mk({ status: 'pending_authorization' })), { kind: 'anchor', id: 'sec-authorize' });
  assert.deepEqual(nextStepTarget(mk({ status: 'failed', guidance: { phase: 'x', tone: 'err', next: 'y', flow: {} } })), { kind: 'anchor', id: 'sec-flow' }, 'con flow no se pinta la recuperación');
  for (const status of ['failed', 'cancelled', 'budget_exceeded']) assert.deepEqual(nextStepTarget(mk({ status })), { kind: 'anchor', id: 'sec-recovery' }, status);
  assert.deepEqual(nextStepTarget(mk({ status: 'done', result: { changes: [] } })), { kind: 'anchor', id: 'sec-result' });
  assert.deepEqual(nextStepTarget(mk({ status: 'running' })), { kind: 'anchor', id: 'sec-steps' });
  assert.deepEqual(nextStepTarget(mk({ status: 'running', steps: [] })), { kind: 'link', to: '/historias/b1' });
  assert.deepEqual(nextStepTarget(mk({ kind: 'evaluation', status: 'failed', backlogItemId: undefined })), { kind: 'anchor', id: 'sec-steps' });
});

test('cabecera: ProcessHeader con estado, barra de gasto y botón guidance.next; fuera del fieldset pero bloqueada si está archivado', () => {
  const view = read('screens/ProcessView.tsx');
  const header = read('components/ProcessHeader.tsx');
  assert.match(view, /import \{ ProcessHeader \} from '\.\.\/components\/ProcessHeader\.tsx'/);
  assert.match(view, /<ProcessHeader proc=\{proc\} status=\{st\} onNext=\{goNext\} \/>/);
  assert.match(view, /const st = procLabel\(proc\)/, 'el chip usa procLabel (pausado = espera tu decisión)');
  assert.ok(view.indexOf('<ProcessHeader') < view.indexOf('<fieldset disabled={!!proc.archivedAt}'), 'la cabecera va antes del fieldset');
  assert.match(view, /<fieldset disabled=\{!!proc\.archivedAt\}/, 'el archivado sigue deshabilitando las acciones');
  assert.match(header, /role="progressbar"/);
  assert.match(header, /aria-valuenow=\{pct\}/);
  assert.match(header, /gastado de \{fmtUsd\(proc\.budgetUsd\)\} autorizado/);
  assert.match(header, /pct >= 90 \? ' is-err' : pct >= 70 \? ' is-warn'/);
  assert.match(header, /className="btn btn-primary" data-next-step onClick=\{\(\) => onNext\(target\)\}>\{next\}/);
  assert.match(header, /const next = proc\.guidance\?\.next/);
  assert.match(header, /\{next && target && /, 'sin guidance o archivado (target null) no hay botón');
  assert.doesNotMatch(header, /\bapi\.|authorize|retry|recover/, 'la cabecera no lanza acciones');
});

test('el botón del siguiente paso solo desplaza, enfoca o navega: nunca autoriza, reintenta, recupera ni llama a la IA', () => {
  const view = read('screens/ProcessView.tsx');
  const start = view.indexOf('const goNext');
  assert.ok(start > 0, 'goNext existe');
  const body = view.slice(start, view.indexOf('};', view.indexOf('el.focus', start)));
  assert.match(body, /navigate\(t\.to\)/);
  assert.match(body, /scrollIntoView/);
  assert.match(body, /\.focus\(/);
  assert.match(body, /document\.getElementById\('sec-steps'\)/, 'si falta el destino, a los pasos');
  assert.doesNotMatch(body, /\bapi\.|authorize|retry|recover|setProc|complete\(/, body);
  for (const id of ['sec-authorize', 'sec-recovery', 'sec-flow', 'sec-result', 'sec-steps']) assert.match(view, new RegExp(`id="${id}" tabIndex=\\{-1\\}`), id);
  assert.doesNotMatch(view, /Siguiente paso:/, 'el siguiente paso ya no es texto dentro del aviso');
});

test('plegables cerrados por defecto: «Detalles técnicos» del paso y «Agentes activos durante el proceso»', () => {
  const view = read('screens/ProcessView.tsx');
  assert.match(view, /<Disclosure title="Detalles técnicos">/);
  assert.match(view, /<Disclosure title="Agentes activos durante el proceso">/);
  assert.doesNotMatch(view, /<Disclosure[^>]*(Detalles técnicos|Agentes activos)[^>]*defaultOpen/);
  // Dentro del fieldset deshabilitado los <details> siguen abriéndose: se pueden consultar, y es lo correcto.
});

test('Actividad: filtro por estado con aria-pressed, contadores y mensaje sin resultados', () => {
  const view = read('screens/ProcessView.tsx');
  const list = view.slice(view.indexOf('export function ProcessList'));
  // El filtro se conserva por entrada del historial (Atrás lo recupera); por defecto, «Todos».
  assert.match(list, /use(?:State|EntryState)<'all' \| ProcessFilterKey>\((?:'actividad\.filtro', )?'all'\)/);
  assert.match(list, /role="group" aria-label="Filtrar por estado"/);
  assert.match(list, /aria-pressed=\{filter === f\.key\}/);
  assert.match(list, /\{f\.label\} \(\{countOf\(f\.key\)\}\)/);
  assert.match(list, /processFilterKey\(p\) === filter/);
  assert.match(list, /Ningún proceso con este estado\./);
  assert.match(list, /Aún no hay procesos\./, 'el estado vacío general se mantiene');
  assert.match(list, /to="\/archivo">Archivo histórico/);
});

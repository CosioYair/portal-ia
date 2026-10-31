import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Q11–Q14 (docs/autonomia-suscripcion-y-persistencia.md): los borradores de la interfaz se guardan por empresa y proyecto,
// nunca incluyen una autorización ni un secreto, y un borrador de una versión anterior del dato no se aplica solo. La
// comprobación en el navegador (recargar, navegador y servidor reiniciados) está en el recorrido aislado; aquí, el cableado.
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const { draftKey, fingerprint } = await import(pathToFileURL(path.join(webSrc, 'lib/persist.ts')).href);

test('borradores: clave por formulario y ámbito completo; sin ámbito no se guarda nada; la huella cambia con el dato', () => {
  assert.equal(draftKey('lote', 'portal-ia', 'p1'), 'portal-ia.draft.v1.lote.portal-ia.p1');
  assert.notEqual(draftKey('lote', 'empresa-a', 'p1'), draftKey('lote', 'empresa-b', 'p1'), 'otra empresa, otra clave');
  assert.equal(draftKey('historia.edicion', 'portal-ia', null), null, 'sin ámbito (dato aún sin cargar) no hay borrador');
  assert.notEqual(fingerprint(['Título', 'Criterio', 'x']), fingerprint(['Título cambiado', 'Criterio', 'x']));
  assert.equal(fingerprint(['a']), fingerprint(['a']));
});

test('guardado ≠ autorización: ninguna casilla «Autorizo…» ni de descarte forma parte de un borrador', () => {
  const batches = read('screens/Batches.tsx');
  assert.match(batches, /const \[ok, setOk\] = useState\(false\)/, 'la autorización del lote es estado de la pantalla');
  const wizardDraft = batches.slice(batches.indexOf("useDraft(draftKey('lote',"), batches.indexOf('\n', batches.indexOf("useDraft(draftKey('lote',")));
  assert.ok(wizardDraft && !/\bok\b|autoriz/i.test(wizardDraft), wizardDraft);
  const panel = read('components/ConversationPanel.tsx');
  const card = panel.slice(panel.indexOf("useDraft(draftKey('encargo',"), panel.indexOf('\n', panel.indexOf("useDraft(draftKey('encargo',")));
  assert.ok(card && !/\bok\b|discard/.test(card), card);
  assert.match(panel, /const \[ok, setOk\] = useState\(false\); const \[discard, setDiscard\] = useState\(false\)/);
  for (const f of ['screens/Batches.tsx', 'components/ConversationPanel.tsx', 'screens/StoryWorkspace.tsx', 'screens/AgentCreate.tsx', 'components/IterationComposer.tsx']) {
    assert.doesNotMatch(read(f), /useDraft\([^)]*(auth|Auth|confirm)/, `${f}: ninguna confirmación en un borrador`);
  }
  // Tras autorizar, el borrador se borra: el siguiente lote empieza con los valores seguros.
  assert.match(batches, /api\.createBatch\([^)]*\{[^}]*\}\);\s*draft\.clear\(\)/);
});

test('ningún secreto en el navegador: las pantallas con claves o tokens no usan borradores ni estado persistente', () => {
  for (const f of ['screens/ProviderSetup.tsx', 'components/ClaudeCodePanel.tsx']) assert.doesNotMatch(read(f), /useDraft|usePersistentState|localStorage/, f);
});

test('una pantalla por elemento: autorizaciones y ediciones no pasan de una historia, proceso o lote a otro', () => {
  assert.match(read('screens/StoryWorkspace.tsx'), /<StoryWorkspaceOf key=\{storyId\}/);
  assert.match(read('screens/ProcessView.tsx'), /<ProcessViewOf key=\{processId\}/);
  assert.match(read('screens/Batches.tsx'), /<BatchDetailOf key=\{batchId\}/);
});

test('navegación: el enlace directo manda sobre la selección guardada y conserva su #pestaña y sus ?parámetros', () => {
  const app = read('App.tsx');
  assert.match(app, /useState<Selection \| null>\(\(\) => urlSel\(\) \?\? readSel\(\)\)/);
  assert.match(app, /navigate\('\/' \+ \(rest \|\| 'panel'\) \+ search \+ hash/);
  assert.match(read('screens/StoryWorkspace.tsx'), /navigate\(`\/backlog\?ejecutar=\$\{it\.id\}`\)/, 'el enlace «Ejecutar» de la historia abre su diálogo');
});

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
  assert.match(app, /useState<Selection \| null>\(\(\) => urlSel\(\) \?\? histSel\(\) \?\? readSel\(\)\)/);
  assert.match(app, /<SelectionHistory sel=\{sel\}/, 'Atrás/Adelante vuelven a la empresa de cada entrada del historial');
  assert.match(app, /navigate\('\/' \+ \(rest \|\| 'panel'\) \+ search \+ hash/);
  assert.match(read('screens/StoryWorkspace.tsx'), /navigate\(`\/backlog\?ejecutar=\$\{it\.id\}`\)/, 'el enlace «Ejecutar» de la historia abre su diálogo');
});

// Ronda 3 (impugnación de la persistencia): lo recuperado nunca actúa por su cuenta ni pisa datos más nuevos.
test('ronda 3: la versión del borrador se fija al empezar y lo recuperado solo se usa donde sigue valiendo', () => {
  const persist = read('lib/persist.ts');
  assert.match(persist, /base: state\.from \?\? null/, 'se guarda la versión de la que partió el borrador, no la actual');
  assert.match(persist, /from: s\.from === undefined \? baseNow\.current : s\.from/, 'la versión se fija con el primer cambio');
  const story = read('screens/StoryWorkspace.tsx');
  assert.match(story, /setEdit\(\{ \.\.\.f, orig: f \}\)/, 'la edición recuerda los campos de los que partió');
  assert.match(story, /Mientras editabas cambió en la historia/, 'si cambió el mismo campo, se avisa antes de sobrescribirlo');
  const agent = read('screens/AgentDetail.tsx');
  assert.match(agent, /useDraft<\{ cfg: AgentConfig; orig: AgentConfig \} \| null>\(draftKey\('agente\.config'/);
  assert.match(agent, /const cfg: AgentConfig \| null = agent \? \{ \.\.\.agent\.config, \.\.\.mine \}/, 'solo tus campos, sobre la configuración actual');
  // «Aceptar» un encargo no envía el texto escrito para pedir cambios (ni uno recuperado) como nota de aceptación.
  assert.match(read('components/ConversationPanel.tsx'), /api\.acceptAssignment\(slug, a\.id, null\)/);
  const batches = read('screens/Batches.tsx');
  assert.match(batches, /const open = mode === 'retry' \? \(canRetry \? mode : null\) : mode === 'iterate' \? \(canIterate \? mode : null\)/, 'un formulario recuperado solo si la acción sigue siendo posible');
  assert.doesNotMatch(batches, /\{mode === 'retry' &&|\{mode && mode !== 'retry' &&/, 'nada se abre por el modo guardado sin comprobarlo');
  assert.match(batches, /\{restored && \(g\.merge/, 'el aviso de opciones con permisos no depende de no haber tocado nada');
  const chat = read('components/AssistantChat.tsx');
  assert.match(chat, /if \(!loaded \|\| !initialText/, 'el texto propuesto se aplica cuando ya se sabe la conversación');
  assert.match(read('screens/Knowledge.tsx'), /q\.set\('doc', docId\)/, 'el documento abierto vive en la URL');
});

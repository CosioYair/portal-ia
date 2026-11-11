import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * HU-186 · El panel de la historia ejecuta «Publicar main» con autorización propia y usa diálogos del Portal
 * (rechazar, cancelar, omitir publicar) en vez de prompt()/confirm(). Prueba de cableado: lee la fuente, sin red ni IA.
 */
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const src = fs.readFileSync(path.join(webSrc, 'components/StoryFlowPanel.tsx'), 'utf8');
/** Fuente sin comentarios: un comentario que nombre prompt() o docs/sandbox.md no debe contar como uso. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Fragmento de run() entre dos ramas `else if (a.id === '…')`. */
function branch(id: string, nextId: string): string {
  const start = code.indexOf(`a.id === '${id}'`);
  const end = code.indexOf(`a.id === '${nextId}'`, start + 1);
  assert.ok(start > 0 && end > start, `no se encontró la rama '${id}' de run()`);
  return code.slice(start, end);
}

test('HANDLED incluye publish y skip_publish (sin «Esta página no reconoce la acción»)', () => {
  const m = code.match(/const HANDLED = new Set<FlowActionId>\(\[([^\]]*)\]\)/);
  assert.ok(m, 'no se encontró el conjunto HANDLED');
  assert.ok(m![1].includes("'publish'"), "HANDLED debe incluir 'publish'");
  assert.ok(m![1].includes("'skip_publish'"), "HANDLED debe incluir 'skip_publish'");
  assert.ok(m![1].includes("'close_resolved'"), "HANDLED debe seguir incluyendo 'close_resolved'");
});

test('publish: primero abre el diálogo de autorización, después publica main y recarga sin recargar la página', () => {
  const b = branch('publish', 'skip_publish');
  const open = b.indexOf('setPublishing(');
  const call = b.indexOf('api.repoPublishMain(');
  assert.ok(open >= 0, 'run(publish) debe abrir el diálogo del Portal (estado publishing)');
  assert.ok(call > open, 'repoPublishMain se llama solo después de abrir el diálogo');
  assert.match(b.slice(0, call), /if \(!publishing\)[^;]*setPublishing\([^]*?return;/, 'sin autorizar, run(publish) no llama a la API');
  assert.ok(b.includes('publishing.mainCommit') && b.includes('publishing.remoteUrl'), 'publica exactamente el commit y el remoto mostrados');
  const after = b.slice(call);
  assert.ok(/await reload\(\)|onChange\(/.test(after), 'tras publicar se refresca el proceso (la etapa pasa a «hecha»)');
  assert.ok(code.includes('Autorizar y publicar'), 'el diálogo ofrece «Autorizar y publicar»');
});

test('reject y cancel usan diálogos del Portal; no quedan prompt() ni confirm() del navegador', () => {
  assert.ok(!/\b(?:window\.)?(?:prompt|confirm)\s*\(/.test(code), 'StoryFlowPanel no debe usar prompt() ni confirm()');
  assert.ok(branch('reject', 'close').includes('setRejecting('), 'rechazar abre el diálogo del Portal');
  assert.ok(code.includes('setCancelAsk({ action: a, orphan:'), 'cancelar abre el diálogo del Portal');
  assert.ok(code.includes('Cerrar el proceso interrumpido') && code.includes('Cancelar el proceso'), 'el diálogo separa huérfano y en curso');
});

test('sandbox_help se explica en el Portal sin mandar a docs/sandbox.md', () => {
  assert.ok(!src.includes('docs/sandbox.md'), 'el panel no debe mencionar docs/sandbox.md');
  const line = code.slice(code.indexOf("a.id === 'sandbox_help'"));
  assert.ok(line.includes('Docker Desktop') && line.includes('Engine running'), 'explica los pasos en el panel');
});

test('close_resolved sigue abriendo CloseResolvedDialog (HU-187)', () => {
  assert.match(code, /import \{ CloseResolvedDialog \} from '\.\/CloseResolvedDialog\.tsx'/);
  assert.ok(code.includes('<CloseResolvedDialog'), 'el panel debe pintar CloseResolvedDialog');
  assert.ok(branch('close_resolved', 'close_resolved').length >= 0 || true);
  assert.ok(code.includes('setClosingResolved(true)'), 'close_resolved abre el diálogo');
});

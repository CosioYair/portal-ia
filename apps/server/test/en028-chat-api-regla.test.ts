import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/services/agentChat.ts', import.meta.url), 'utf8');

test('EN-028 · el chat por la API aplica la regla de modelo (effectiveModel) antes de llamar al adaptador', () => {
  assert.match(src, /import \{ effectiveModel \} from '\.\/modelRule\.ts';/);
  assert.match(src, /const model = effectiveModel\(slug, a, a\.config\.model\);/);
  assert.match(src, /const req = \{ model, system,/);
  const apiCall = src.slice(src.indexOf('getAdapter(providerId)!.complete('));
  const block = apiCall.slice(0, apiCall.indexOf('} catch'));
  assert.ok(block.length > 0, 'la rama API existe');
  assert.doesNotMatch(block, /a\.config\.model/, 'la rama API no usa el modelo de configuración saltándose la regla');
  assert.match(block, /costUsd\(providerId, model,/);
});

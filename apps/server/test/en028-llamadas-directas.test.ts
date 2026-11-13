import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// EN-028 · Las llamadas directas al adaptador de agentes (fuera de completeWith) pasan por effectiveModel.
const FILES = ['agentNames.ts', 'agentWizardDraft.ts', 'agentFactory.ts', 'assistant.ts'];

for (const f of FILES) {
  test(`EN-028 · ${f}: la llamada directa al adaptador usa el modelo de la regla (effectiveModel)`, () => {
    const src = readFileSync(new URL(`../src/services/${f}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ effectiveModel \} from '\.\/modelRule\.ts';/);
    assert.match(src, /effectiveModel\(/);
    assert.ok(src.includes('.complete(decryptSecret('), 'sigue habiendo una llamada directa que comprobar');
  });
}

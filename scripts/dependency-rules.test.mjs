// Demuestra que el lint falla ante imports prohibidos entre paquetes y pasa ante los permitidos.
// Usa la API de ESLint con rutas virtuales (los archivos no necesitan existir).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });

async function lint(code, relativePath) {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, relativePath) });
  assert.ok(result, 'ESLint debe devolver un resultado');
  return result.messages;
}

function restricciones(messages) {
  return messages.filter((m) => m.ruleId === 'no-restricted-imports' && m.severity === 2);
}

test('A: domain no puede importar @portal/contracts', async () => {
  const messages = await lint(
    "import type { X } from '@portal/contracts';\nexport type Y = X;\n",
    'packages/domain/src/x.ts'
  );
  assert.ok(restricciones(messages).length > 0, 'se esperaba un error no-restricted-imports');
});

test('B: domain no puede importar node:fs', async () => {
  const messages = await lint(
    "import { readFileSync } from 'node:fs';\nexport const leer = readFileSync;\n",
    'packages/domain/src/x.ts'
  );
  assert.ok(restricciones(messages).length > 0, 'se esperaba un error no-restricted-imports');
});

test('C: contracts puede importar @portal/domain', async () => {
  const messages = await lint(
    "import type { CompanyId } from '@portal/domain';\nexport type Id = CompanyId;\n",
    'packages/contracts/src/x.ts'
  );
  assert.deepEqual(messages, []);
});

test('D: un import relativo que cruza paquetes falla', async () => {
  const messages = await lint(
    "import type { CompanyId } from '../../domain/src/index.ts';\nexport type Id = CompanyId;\n",
    'packages/contracts/src/x.ts'
  );
  assert.ok(restricciones(messages).length > 0, 'se esperaba un error no-restricted-imports');
});

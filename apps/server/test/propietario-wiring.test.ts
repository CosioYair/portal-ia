import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Todo cambio en el Portal exige la sesión del propietario (apps/server/src/services/ownerSession.ts). En la interfaz, casi
 * todo pasa por `request` (apps/web/src/lib/api.ts), que la envía; lo que llama directamente con `fetch` o
 * `XMLHttpRequest` para cambiar algo (subidas en flujo, módulos antiguos) tiene que usar `ownerHeaders()` y
 * `noteOwnerResponse()` de lib/owner.ts. Si no, esa acción falla siempre (401) y el aviso para vincular no se abre.
 */
const web = fileURLToPath(new URL('../../web/src/', import.meta.url));
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []);

test('las llamadas que cambian algo sin pasar por request() envían la sesión del propietario', () => {
  const offenders: string[] = []; let raw = 0;
  for (const f of files(web)) {
    if (f.endsWith(path.join('lib', 'api.ts'))) continue;
    const s = fs.readFileSync(f, 'utf8');
    const xhr = /new XMLHttpRequest\(/.test(s);
    const mutatingFetch = /fetch\([^;]*?method:\s*['"](POST|PUT|PATCH|DELETE)['"]/s.test(s);
    if (!xhr && !mutatingFetch) continue;
    raw++;
    if (!s.includes('ownerHeaders(') || !s.includes('noteOwnerResponse(')) offenders.push(path.relative(web, f));
  }
  assert.ok(raw >= 3, `se esperaban las llamadas directas conocidas (subidas, retroalimentación de pruebas manuales, integración): ${raw}`);
  assert.deepEqual(offenders, [], 'estas llamadas no envían la sesión del propietario');
});

test('request() envía la sesión y abre el aviso cuando el servidor la pide', () => {
  const api = fs.readFileSync(path.join(web, 'lib', 'api.ts'), 'utf8');
  assert.match(api, /headers\['X-Portal-Owner'\] = owner/);
  assert.match(api, /res\.status === 401 && body\?\.code === 'owner_required'[^\n]*ownerNeeded\(\)/);
});

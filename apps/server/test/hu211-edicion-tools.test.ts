import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITION_BUNDLE_LIMITS, findSecret, validatePortableBundle } from '@portal-ia/domain';
import { EDITION_FORBIDDEN, EDITION_INCLUDE } from '../src/services/editionBundle.ts';

// HU-211 · documentJobs.ts resuelve apps/server/tools en tiempo de ejecución: la Edición debe llevarla.
const TOOLS = fileURLToPath(new URL('../tools/', import.meta.url));

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel))) {
    const r = rel ? `${rel}/${e}` : e;
    const st = fs.statSync(path.join(dir, r));
    if (st.isDirectory()) out.push(...walk(dir, r));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

test('HU-211: apps/server/tools entra en la Edición y pasa findSecret y validatePortableBundle (perfil edition)', () => {
  const rels = walk(TOOLS).filter(r => !r.includes('__pycache__'));
  assert.ok(rels.includes('doc_qa.py'), 'doc_qa.py existe');
  assert.ok(rels.includes('kits/pdf-word/convertir_editable.py'), 'el kit pdf-word existe');
  const texts: Record<string, string> = {};
  for (const r of rels) {
    const name = `apps/server/tools/${r}`;
    assert.ok(EDITION_INCLUDE.some(re => re.test(name)), `${name} debe entrar en la Edición`);
    assert.equal(EDITION_FORBIDDEN.find(x => x.pattern.test(name)), undefined, `${name} no está prohibido`);
    const c = fs.readFileSync(path.join(TOOLS, r), 'utf8');
    assert.equal(findSecret(c), null, `${name} sin secretos`);
    texts[name] = c;
  }
  const root = path.resolve(TOOLS, '..', '..', '..');
  const problems = validatePortableBundle(texts, {
    profile: 'edition', limits: EDITION_BUNDLE_LIMITS,
    privatePaths: [{ path: root, kind: 'source' }, { path: path.join(root, 'data'), kind: 'portal-data' }]
  });
  assert.deepEqual(problems, []);
});

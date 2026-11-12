import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initPreviewData, PREVIEW_SIM_PROVIDER, type PreviewFetch } from '../src/services/visualCheck.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function fakePreview(opts: { connected?: boolean; initialized?: boolean; verifyOk?: boolean } = {}) {
  const state = { connected: !!opts.connected, initialized: !!opts.initialized, cred: false };
  const calls: string[] = [];
  const reply = (ok: boolean, status: number, data: unknown) => ({ ok, status, json: async () => data });
  const f: PreviewFetch = async (url, init) => {
    const rel = url.replace('http://127.0.0.2:5000/', '');
    calls.push(`${init.method} ${rel}`);
    if (init.method === 'GET' && rel === 'api/bootstrap/status') return reply(true, 200, { providerConnected: state.connected, initialized: state.initialized });
    if (init.method === 'PUT' && rel === `api/providers/${PREVIEW_SIM_PROVIDER}/credential`) { state.cred = !!JSON.parse(init.body ?? '{}').apiKey; return reply(true, 200, {}); }
    if (init.method === 'POST' && rel === `api/providers/${PREVIEW_SIM_PROVIDER}/verify`) { if (opts.verifyOk === false || !state.cred) return reply(false, 401, {}); state.connected = true; return reply(true, 200, {}); }
    if (init.method === 'POST' && rel === 'api/bootstrap/internal') { if (!state.connected) return reply(false, 409, {}); state.initialized = true; return reply(true, 200, {}); }
    return reply(false, 404, {});
  };
  return { f, calls, state };
}

test('HU-207 · la vista previa vacía se inicializa (proveedor simulado + espacio interno) antes de capturar', async () => {
  const p = fakePreview();
  const r = await initPreviewData('http://127.0.0.2:5000', p.f);
  assert.deepEqual(p.calls, [
    'GET api/bootstrap/status',
    `PUT api/providers/${PREVIEW_SIM_PROVIDER}/credential`,
    `POST api/providers/${PREVIEW_SIM_PROVIDER}/verify`,
    'POST api/bootstrap/internal',
    'GET api/bootstrap/status'
  ]);
  assert.equal(r.steps.length, 2);
  assert.ok(p.state.connected && p.state.initialized);
});

test('HU-207 · inicializar es idempotente: si ya lo está, no escribe nada', async () => {
  const p = fakePreview({ connected: true, initialized: true });
  const r = await initPreviewData('http://127.0.0.2:5000/', p.f);
  assert.deepEqual(p.calls, ['GET api/bootstrap/status', 'GET api/bootstrap/status']);
  assert.equal(r.steps.length, 0);
});

test('HU-207 · si el proveedor simulado no se verifica, falla con motivo (no se capturan pantallas redirigidas)', async () => {
  const p = fakePreview({ verifyOk: false });
  await assert.rejects(() => initPreviewData('http://127.0.0.2:5000', p.f), /proveedor simulado no se verificó/);
  assert.ok(!p.calls.includes('POST api/bootstrap/internal'));
});

test('HU-207 · doRun inicializa la vista previa entre readyPreview y el script', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'services', 'visualCheck.ts'), 'utf8');
  const body = src.slice(src.indexOf('async function doRun('));
  const a = body.indexOf('await readyPreview('); const b = body.indexOf('await initPreviewData('); const c = body.indexOf('await runScript(');
  assert.ok(a > 0 && b > a && c > b, 'orden esperado: readyPreview → initPreviewData → runScript');
});

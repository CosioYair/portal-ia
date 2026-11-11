import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * EN-021 · Ajuste «Tu nombre» por HTTP: la ruta está registrada (no 404), está vacía por defecto, cambiarla exige la
 * sesión del propietario y, con valor, la línea 2 del sello usa ese nombre (nunca el correo).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en021-nombre-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX; delete process.env.PORTAL_OWNER_CODE_FILE; delete process.env.PORTAL_PREVIEW;

const { config } = await import('../src/config.ts');
const { buildApp } = await import('../src/app.ts');
const { stopBatchScheduler } = await import('../src/services/batchRunner.ts');
const { codeFile, resetPairingForTests } = await import('../src/services/ownerSession.ts');
const { sealForOwner } = await import('../src/services/portalSeal.ts');

const app = await buildApp();
after(async () => { stopBatchScheduler(); await app.close(); });
const HOST = `127.0.0.1:${config.port}`;
const URL_NAME = '/api/settings/owner-name';
const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { host: HOST, ...headers } });
  let json: any = null; try { json = r.json(); } catch { json = null; }
  return { status: r.statusCode, json, body: r.body };
};
async function pair(): Promise<string> {
  resetPairingForTests();
  assert.equal((await call('POST', '/api/owner/pairing', {})).status, 200);
  const code = fs.readFileSync(codeFile(), 'utf8').match(/\b([A-Z2-9]{4}(?:-[A-Z2-9]{4}){4})\b/)![1];
  const r = await call('POST', '/api/owner/pair', { code }); assert.equal(r.status, 200, r.body); return r.json.token;
}

test('«Tu nombre»: GET y PUT registrados, vacío por defecto, PUT solo con la sesión del propietario', async () => {
  const first = await call('GET', URL_NAME);
  assert.equal(first.status, 200, `la ruta está registrada: ${first.body}`);
  assert.equal(first.json.name, '', 'vacío por defecto');

  const anon = await call('PUT', URL_NAME, { name: 'Intruso' });
  assert.equal(anon.status, 401, anon.body); assert.equal(anon.json?.code, 'owner_required');
  assert.equal((await call('GET', URL_NAME)).json.name, '', 'sin sesión no cambia');

  const token = await pair(); const O = { 'x-portal-owner': token };
  const saved = await call('PUT', URL_NAME, { name: '  Yair  ' }, O);
  assert.equal(saved.status, 200, saved.body); assert.equal(saved.json.name, 'Yair');
  assert.equal((await call('GET', URL_NAME)).json.name, 'Yair');

  const line2 = sealForOwner('', true);
  assert.match(line2, /Yair/, 'la línea 2 usa el nombre guardado');
  assert.doesNotMatch(line2, /@/, 'nunca el correo');

  const tooLong = await call('PUT', URL_NAME, { name: 'x'.repeat(81) }, O);
  assert.equal(tooLong.status, 400); assert.equal(tooLong.json?.code, 'invalid_owner_name');
  assert.equal((await call('GET', URL_NAME)).json.name, 'Yair', 'un nombre no válido no cambia el guardado');

  const cleared = await call('PUT', URL_NAME, { name: '' }, O);
  assert.equal(cleared.status, 200, cleared.body); assert.equal(cleared.json.name, '');
  assert.equal((await call('GET', URL_NAME)).json.name, '');
});

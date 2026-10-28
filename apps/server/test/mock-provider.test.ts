import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * El proveedor simulado relee su guion en cada llamada. Con la caché por fecha de modificación, en Linux (sandbox Docker)
 * dos escrituras dentro del mismo tic del reloj de archivos compartían fecha y una prueba respondía con las reglas de la
 * anterior: así fallaron dos pruebas del Portal en la verificación de HU-155 y costaron tres correcciones pagadas.
 */
const { mockAdapter } = await import('@portal-ia/ai-adapters');

test('el proveedor simulado lee su guion en cada llamada: dos escrituras con la misma fecha no reutilizan reglas viejas', async () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-mock-')), 'script.json');
  const prev = process.env.PORTAL_MOCK_SCRIPT; process.env.PORTAL_MOCK_SCRIPT = p;
  try {
    const call = async () => (await mockAdapter.complete('k', {}, { model: 'claude-haiku-4-5', system: 's', user: 'hola', maxTokens: 100 } as any)).text;
    const t = new Date(Math.floor(Date.now() / 1000) * 1000); // misma fecha exacta en las dos escrituras (tic del reloj de Linux)
    fs.writeFileSync(p, JSON.stringify({ rules: [{ match: 'hola', text: 'REGLAS_VIEJAS' }] })); fs.utimesSync(p, t, t);
    assert.equal(await call(), 'REGLAS_VIEJAS');
    fs.writeFileSync(p, JSON.stringify({ rules: [{ match: 'hola', text: 'REGLAS_NUEVAS' }] })); fs.utimesSync(p, t, t);
    assert.equal(fs.statSync(p).mtimeMs, t.getTime());
    assert.equal(await call(), 'REGLAS_NUEVAS');
  } finally { if (prev === undefined) delete process.env.PORTAL_MOCK_SCRIPT; else process.env.PORTAL_MOCK_SCRIPT = prev; }
});

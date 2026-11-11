import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

// HU-205 · Edición distribuible. node --test ejecuta cada archivo en su propio proceso: la bandera se fija antes de
// cargar config.ts (por eso los módulos del servidor se importan de forma dinámica, después de estas líneas).
process.env.PORTAL_EDITION = 'distributable';
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-hu205-'));

const cfg = await import('../src/config.ts');
const { isPortalRuntime } = await import('../src/services/storyExecution.ts');
const { startUpdate } = await import('../src/services/system.ts');
const { systemRoutes } = await import('../src/routes/system.ts');

const expected = { error: cfg.EDITION_DISABLED_REASON, code: 'edition_distributable' };

test('con PORTAL_EDITION=distributable la automejora queda desactivada', () => {
  assert.equal(cfg.PORTAL_EDITION, 'distributable');
  assert.equal(cfg.config.edition, 'distributable');
  assert.equal(cfg.SELF_IMPROVEMENT_ENABLED, false);
  assert.equal(isPortalRuntime(cfg.REPO_ROOT), false, 'isPortalRuntime(REPO_ROOT) debe ser false en la edición distribuible');
});

test('control: sin valor o con cualquier otro valor, la edición es «studio» (automejora activa)', () => {
  assert.equal(cfg.resolvePortalEdition(undefined), 'studio');
  assert.equal(cfg.resolvePortalEdition(''), 'studio');
  assert.equal(cfg.resolvePortalEdition('studio'), 'studio');
  assert.equal(cfg.resolvePortalEdition('otra-cosa'), 'studio');
  assert.equal(cfg.resolvePortalEdition(' Distributable '), 'distributable');
});

test('reconstruir, activar y reiniciar responden 403 con el motivo', async () => {
  const app = Fastify();
  await app.register(systemRoutes);
  try {
    const cases = [
      { name: 'reconstruir', url: '/api/system/update', payload: { authorized: true, restart: false, expectedHead: null } },
      { name: 'activar', url: '/api/system/update', payload: { authorized: true, restart: true, expectedHead: null } },
      { name: 'reiniciar', url: '/api/system/restart', payload: { confirm: true, expectedHead: null } }
    ];
    for (const c of cases) {
      const res = await app.inject({ method: 'POST', url: c.url, payload: c.payload });
      assert.equal(res.statusCode, 403, `${c.name}: se esperaba 403`);
      assert.deepEqual(res.json(), expected, `${c.name}: motivo y código de la edición`);
    }
    // El 403 no depende del cuerpo: incluso sin cuerpo válido responde con el motivo de la edición.
    const bare = await app.inject({ method: 'POST', url: '/api/system/update', payload: {} });
    assert.equal(bare.statusCode, 403);
    assert.deepEqual(bare.json(), expected);
  } finally {
    await app.close();
  }
});

test('startUpdate() rechaza con 403 aunque se llame fuera de las rutas (p. ej. lotes con activate)', async () => {
  await assert.rejects(
    startUpdate({ install: false, restart: true }, () => {}),
    (e: any) => e.statusCode === 403 && e.code === 'edition_distributable' && e.message === cfg.EDITION_DISABLED_REASON
  );
});

// ---------- Guardián: REPO_ROOT solo en los archivos permitidos ----------
// núcleo = necesita la carpeta de la instalación; deuda = comparación directa que debería pasar a isPortalRuntime().
const ALLOWED_REPO_ROOT: Record<string, 'núcleo' | 'deuda'> = {
  'app.ts': 'núcleo',
  'config.ts': 'núcleo',
  'routes/fs.ts': 'núcleo',
  'routes/processes.ts': 'deuda',
  'routes/workspaces.ts': 'núcleo',
  'services/agentActions.ts': 'núcleo',
  'services/agentCreation.ts': 'núcleo',
  'services/assistant.ts': 'deuda',
  'services/claudeCode/backend.ts': 'núcleo',
  'services/claudeCode/cli.ts': 'núcleo',
  'services/closing.ts': 'deuda',
  'services/documentJobs.ts': 'núcleo',
  'services/integration.ts': 'núcleo',
  'services/lifecycle.ts': 'núcleo',
  'services/operationalPhase.ts': 'núcleo',
  'services/preview.ts': 'núcleo',
  'services/repoStatus.ts': 'deuda',
  'services/storyExecution.ts': 'núcleo',
  'services/storyThread.ts': 'deuda',
  'services/system.ts': 'núcleo'
};

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(full));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
const sources = tsFiles(SRC).map(f => ({ rel: path.relative(SRC, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));

test('guardián: ningún archivo nuevo de apps/server/src usa REPO_ROOT fuera de la lista permitida', () => {
  assert.ok(sources.length > 20, 'no se encontraron los fuentes de apps/server/src');
  const offenders = sources.filter(s => /\bREPO_ROOT\b/.test(s.text) && !(s.rel in ALLOWED_REPO_ROOT)).map(s => s.rel);
  assert.deepEqual(offenders, [], `REPO_ROOT aparece en archivos no permitidos: ${offenders.join(', ')}. Usa isPortalRuntime() o SELF_IMPROVEMENT_ENABLED (bandera de edición); si es núcleo, añádelo a ALLOWED_REPO_ROOT con su justificación (HU-205).`);
});

test('guardián: REPO_ROOT solo se define en config.ts', () => {
  const def = /\b(?:const|let|var)\s+REPO_ROOT\b|\bREPO_ROOT\s*=(?!=)/;
  const offenders = sources.filter(s => s.rel !== 'config.ts' && def.test(s.text)).map(s => s.rel);
  assert.deepEqual(offenders, [], `REPO_ROOT se define fuera de config.ts en: ${offenders.join(', ')}. Debe importarse de config.ts (HU-205).`);
  assert.match(sources.find(s => s.rel === 'config.ts')!.text, /export const REPO_ROOT\b/);
});

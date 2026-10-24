import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_LOCATION_STATES,
  clasificarHistorias,
  compararUbicacion,
  construirPasosCorreccion,
  normalizarRuta
} from '@portal/domain';
import { RuntimeLocationCheckSchema } from '@portal/contracts';
import { createRuntimeLocationService } from '../src/services/runtime-location.ts';

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Dominio puro

const RUTA = '/home/ana/portal';
const entrada = (
  ejecucion: { ruta: string | null; rama: string | null; headDesacoplado?: boolean },
  registrado: { ruta: string | null; rama: string | null },
  plataforma = 'linux'
) => ({
  ejecucion: { headDesacoplado: false, ...ejecucion },
  registrado,
  plataforma
});

test('normalizarRuta resuelve barras finales, separadores y mayúsculas según la plataforma', () => {
  assert.equal(normalizarRuta('/home/Ana/portal/', 'linux'), '/home/Ana/portal');
  assert.notEqual(normalizarRuta('/home/Ana/portal', 'linux'), normalizarRuta('/home/ana/portal', 'linux'));
  assert.equal(
    normalizarRuta('C:\\Mis Proyectos\\Portal IA\\', 'win32'),
    normalizarRuta('c:/mis proyectos/portal ia', 'win32')
  );
  assert.equal(normalizarRuta('/Users/Ana/Portal/', 'darwin'), '/users/ana/portal');
  assert.equal(normalizarRuta('/', 'linux'), '/');
  assert.equal(normalizarRuta('C:/', 'win32'), 'c:/');
});

test('compararUbicacion: coincide', () => {
  const r = compararUbicacion(entrada({ ruta: RUTA, rama: 'main' }, { ruta: RUTA, rama: 'main' }));
  assert.equal(r.estado, 'coincide');
  assert.equal(r.motivoNoVerificable, null);
});

test('compararUbicacion: carpeta distinta, rama distinta y ambas', () => {
  assert.equal(
    compararUbicacion(entrada({ ruta: '/otra', rama: 'main' }, { ruta: RUTA, rama: 'main' })).estado,
    'carpeta-distinta'
  );
  assert.equal(
    compararUbicacion(entrada({ ruta: RUTA, rama: 'hu-1/x' }, { ruta: RUTA, rama: 'main' })).estado,
    'rama-distinta'
  );
  assert.equal(
    compararUbicacion(entrada({ ruta: '/otra', rama: 'hu-1/x' }, { ruta: RUTA, rama: 'main' })).estado,
    'carpeta-y-rama-distintas'
  );
});

test('compararUbicacion: rutas equivalentes con barra final o mayúsculas no son discrepancia', () => {
  assert.equal(
    compararUbicacion(entrada({ ruta: `${RUTA}/`, rama: 'main' }, { ruta: RUTA, rama: 'main' })).estado,
    'coincide'
  );
  assert.equal(
    compararUbicacion(
      entrada(
        { ruta: 'C:\\Mis Proyectos\\Portal IA', rama: 'main' },
        { ruta: 'c:/mis proyectos/portal ia/', rama: 'main' },
        'win32'
      )
    ).estado,
    'coincide'
  );
  assert.equal(
    compararUbicacion(entrada({ ruta: '/home/Ana/portal', rama: 'main' }, { ruta: RUTA, rama: 'main' })).estado,
    'carpeta-distinta'
  );
});

test('compararUbicacion: HEAD desacoplado, sin repositorio y sin ruta son no verificables', () => {
  const desacoplado = compararUbicacion(
    entrada({ ruta: RUTA, rama: null, headDesacoplado: true }, { ruta: RUTA, rama: 'main' })
  );
  assert.equal(desacoplado.estado, 'no-verificable');
  assert.match(desacoplado.motivoNoVerificable ?? '', /desacoplado/);
  assert.equal(
    compararUbicacion(entrada({ ruta: RUTA, rama: 'main' }, { ruta: null, rama: null })).estado,
    'no-verificable'
  );
  assert.equal(
    compararUbicacion(entrada({ ruta: null, rama: null }, { ruta: RUTA, rama: 'main' })).estado,
    'no-verificable'
  );
  assert.equal(RUNTIME_LOCATION_STATES.length, 5);
});

test('construirPasosCorreccion incluye ambas rutas y ramas y no devuelve nada si coincide', () => {
  const ejecucion = { ruta: '/copia/portal', rama: 'hu-124/alerta', headDesacoplado: false };
  const registrado = { ruta: RUTA, rama: 'main' };
  const pasos = construirPasosCorreccion({
    estado: 'carpeta-y-rama-distintas',
    ejecucion,
    registrado,
    historiasNoContenidas: ['HU-122']
  });
  const texto = pasos.join('\n');
  for (const fragmento of ['/copia/portal', RUTA, 'hu-124/alerta', 'main', 'npm run dev', 'HU-122']) {
    assert.ok(texto.includes(fragmento), `falta «${fragmento}» en los pasos`);
  }
  assert.deepEqual(
    construirPasosCorreccion({ estado: 'coincide', ejecucion, registrado, historiasNoContenidas: [] }),
    []
  );
  assert.deepEqual(
    construirPasosCorreccion({ estado: 'no-verificable', ejecucion, registrado, historiasNoContenidas: [] }),
    []
  );
});

test('clasificarHistorias separa no contenidas y desconocidas', () => {
  const r = clasificarHistorias([
    { id: 'HU-1', titulo: 'a', sha: 'a'.repeat(40), contenida: true },
    { id: 'HU-2', titulo: 'b', sha: 'b'.repeat(40), contenida: false },
    { id: 'HU-3', titulo: 'c', sha: null, contenida: null }
  ]);
  assert.deepEqual(r.noContenidas.map((h) => h.id), ['HU-2']);
  assert.deepEqual(r.desconocidas.map((h) => h.id), ['HU-3']);
});

// Servicio sobre repositorio git temporal

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'hu124-'));
  const work = join(dir, 'work');
  g(dir, 'init', work);
  g(work, 'config', 'user.name', 'Test');
  g(work, 'config', 'user.email', 'test@example.com');
  g(work, 'config', 'commit.gpgsign', 'false');
  g(work, 'checkout', '-b', 'main');
  await writeFile(join(work, 'a.txt'), 'uno\n');
  g(work, 'add', '.');
  g(work, 'commit', '-m', 'HU-1: inicial');
  const shaMain = g(work, 'rev-parse', 'HEAD');
  g(work, 'checkout', '-b', 'hu-2/trabajo');
  await writeFile(join(work, 'b.txt'), 'dos\n');
  g(work, 'add', '.');
  g(work, 'commit', '-m', 'HU-2: trabajo');
  const shaRama = g(work, 'rev-parse', 'HEAD');
  g(work, 'checkout', 'main');
  return {
    dir,
    work: await realpath(work),
    shaMain,
    shaRama,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

function crearServicio(
  cwd: string,
  registrado: { ruta: string | null; rama: string | null },
  historias: { id: string; titulo: string; sha: string | null }[]
) {
  return createRuntimeLocationService({
    cwd,
    getRegisteredRepository: async () => registrado,
    getCompletedStories: async () => historias
  });
}

test('servicio: coincide y marca contenida una historia ya integrada', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const servicio = crearServicio(s.work, { ruta: s.work, rama: 'main' }, [
    { id: 'HU-1', titulo: 'Inicial', sha: s.shaMain }
  ]);
  const r = RuntimeLocationCheckSchema.parse(await servicio.check('proj_01'));
  assert.equal(r.estado, 'coincide');
  assert.equal(r.ejecucion.rama, 'main');
  assert.equal(r.historiasCompletadas[0]?.contenida, true);
  assert.deepEqual(r.pasos, []);
});

test('servicio: una historia solo presente en otra rama aparece como no contenida', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const servicio = crearServicio(s.work, { ruta: s.work, rama: 'main' }, [
    { id: 'HU-2', titulo: 'Trabajo', sha: s.shaRama },
    { id: 'HU-3', titulo: 'Sin SHA', sha: null }
  ]);
  const r = await servicio.check('proj_01');
  assert.equal(r.estado, 'coincide');
  assert.equal(r.historiasCompletadas.find((h) => h.id === 'HU-2')?.contenida, false);
  assert.equal(r.historiasCompletadas.find((h) => h.id === 'HU-3')?.contenida, null);
});

test('servicio: rama distinta produce pasos con ambas ramas', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  g(s.work, 'checkout', 'hu-2/trabajo');
  const servicio = crearServicio(s.work, { ruta: s.work, rama: 'main' }, [
    { id: 'HU-1', titulo: 'Inicial', sha: s.shaMain }
  ]);
  const r = RuntimeLocationCheckSchema.parse(await servicio.check('proj_01'));
  assert.equal(r.estado, 'rama-distinta');
  assert.equal(r.ejecucion.rama, 'hu-2/trabajo');
  const texto = r.pasos.join('\n');
  assert.ok(texto.includes('main') && texto.includes('hu-2/trabajo'));
});

test('servicio: carpeta distinta cuando el repositorio registrado es otro', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const otra = await realpath(await mkdtemp(join(tmpdir(), 'hu124-otra-')));
  t.after(() => rm(otra, { recursive: true, force: true }));
  const servicio = crearServicio(s.work, { ruta: otra, rama: 'main' }, []);
  const r = await servicio.check('proj_01');
  assert.equal(r.estado, 'carpeta-distinta');
  assert.equal(r.ejecucion.ruta, s.work);
  assert.equal(r.registrado.ruta, otra);
  assert.ok(r.pasos.join('\n').includes(otra));
});

test('servicio: una carpeta sin git devuelve no-verificable sin lanzar', async (t) => {
  const sinGit = await realpath(await mkdtemp(join(tmpdir(), 'hu124-sin-git-')));
  t.after(() => rm(sinGit, { recursive: true, force: true }));
  const servicio = crearServicio(sinGit, { ruta: sinGit, rama: 'main' }, [
    { id: 'HU-1', titulo: 'Inicial', sha: 'a'.repeat(40) }
  ]);
  const r = RuntimeLocationCheckSchema.parse(await servicio.check('proj_01'));
  assert.equal(r.estado, 'no-verificable');
  assert.ok((r.motivoNoVerificable ?? '').length > 0);
  assert.equal(r.historiasCompletadas[0]?.contenida, null);
});

test('servicio: HEAD desacoplado y proyecto sin repositorio son no verificables', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const sinRepo = await crearServicio(s.work, { ruta: null, rama: null }, []).check('proj_01');
  assert.equal(sinRepo.estado, 'no-verificable');
  assert.match(sinRepo.motivoNoVerificable ?? '', /repositorio registrado/);

  g(s.work, 'checkout', '--detach');
  const desacoplado = await crearServicio(s.work, { ruta: s.work, rama: 'main' }, []).check('proj_01');
  assert.equal(desacoplado.estado, 'no-verificable');
  assert.equal(desacoplado.ejecucion.headDesacoplado, true);
});

test('servicio: si los proveedores fallan devuelve no-verificable sin lanzar', async () => {
  const servicio = createRuntimeLocationService({
    getRegisteredRepository: async () => {
      throw new Error('boom');
    },
    getCompletedStories: async () => []  });
  const r = RuntimeLocationCheckSchema.parse(await servicio.check('proj_01'));
  assert.equal(r.estado, 'no-verificable');
  assert.ok((r.motivoNoVerificable ?? '').length > 0);
  assert.deepEqual(r.historiasCompletadas, []);
});

test('servicio: la contención de historias se limita a las más recientes', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const servicio = createRuntimeLocationService({
    cwd: s.work,
    maxStoriesChecked: 1,
    getRegisteredRepository: async () => ({ ruta: s.work, rama: 'main' }),
    getCompletedStories: async () => [
      { id: 'HU-2', titulo: 'Trabajo', sha: s.shaRama },
      { id: 'HU-1', titulo: 'Inicial', sha: s.shaMain }
    ]
  });
  const r = await servicio.check('proj_01');
  assert.equal(r.historiasCompletadas.find((h) => h.id === 'HU-2')?.contenida, false);
  assert.equal(r.historiasCompletadas.find((h) => h.id === 'HU-1')?.contenida, null);
});

test('servicio: la verificación no modifica el repositorio', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const antes = g(s.work, 'status', '--porcelain=v1') + g(s.work, 'rev-parse', 'HEAD');
  await crearServicio(s.work, { ruta: s.work, rama: 'main' }, [
    { id: 'HU-2', titulo: 'Trabajo', sha: s.shaRama }
  ]).check('proj_01');
  const despues = g(s.work, 'status', '--porcelain=v1') + g(s.work, 'rev-parse', 'HEAD');
  assert.equal(despues, antes);
});

test('arranque: advierte solo cuando carpeta o rama no coinciden', async (t) => {
  const { advertirSiUbicacionNoCoincide } = await import('../src/services/runtime-location.ts');
  const s = await setup();
  t.after(s.cleanup);

  const mensajes: string[] = [];
  g(s.work, 'checkout', 'hu-2/trabajo');
  await advertirSiUbicacionNoCoincide(
    crearServicio(s.work, { ruta: s.work, rama: 'main' }, []),
    'proj_01',
    (mensaje) => void mensajes.push(mensaje)
  );
  assert.equal(mensajes.length, 1);
  assert.ok(mensajes[0]?.includes('hu-2/trabajo') && mensajes[0]?.includes('main'));

  g(s.work, 'checkout', 'main');
  await advertirSiUbicacionNoCoincide(
    crearServicio(s.work, { ruta: s.work, rama: 'main' }, []),
    'proj_01',
    (mensaje) => void mensajes.push(mensaje)
  );
  assert.equal(mensajes.length, 1);

  await advertirSiUbicacionNoCoincide(
    crearServicio(s.work, { ruta: null, rama: null }, []),
    'proj_01',
    (mensaje) => void mensajes.push(mensaje)
  );
  assert.equal(mensajes.length, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-172: textos plegados en Proveedores, Equipo, Etapas y Archivo (comprobación estática, sin IA).
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
const SCREENS = {
  provider: read('screens/ProviderSetup.tsx'),
  team: read('screens/Team.tsx'),
  phase: read('screens/Phase.tsx'),
  archive: read('screens/Archive.tsx')
};
const disclosures = (src: string) => src.match(/<Disclosure\b[\s\S]*?<\/Disclosure>/g) ?? [];
const lede = (src: string) => {
  const m = src.match(/className="med lede-2l"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(m, 'falta la introducción con lede-2l');
  return m[1].replace(/<[^>]+>/g, '').trim();
};

test('las cuatro pantallas usan el plegable «Más información» en el JSX y una introducción corta', () => {
  for (const [name, src] of Object.entries(SCREENS)) {
    assert.ok(src.includes("import { Disclosure } from '../components/Disclosure.tsx';"), `${name}: falta importar Disclosure`);
    assert.ok(src.includes('<Disclosure title="Más información"'), `${name}: falta <Disclosure title="Más información"> en el JSX`);
    assert.ok(lede(src).length <= 140, `${name}: la introducción supera 140 caracteres`);
  }
});

test('los avisos de error y advertencia no quedan plegados', () => {
  for (const [name, src] of Object.entries(SCREENS)) {
    for (const block of disclosures(src)) {
      assert.ok(!block.includes('kind="err"') && !block.includes('kind="warn"'), `${name}: un aviso err/warn está dentro de un plegable`);
    }
  }
  assert.ok(SCREENS.provider.includes('<Notice kind="err"><strong>No se pudo verificar la conexión.</strong>'));
  assert.ok(SCREENS.provider.includes('<Notice kind="ok"><strong>Conexión verificada.</strong>'));
  assert.ok(SCREENS.phase.includes('<Notice kind="warn">Hay worktrees con cambios sin integrar'));
  assert.ok(SCREENS.phase.includes('No se puede iniciar mientras haya procesos en ejecución.'));
  assert.ok(SCREENS.phase.includes('Autorizo archivar el trabajo activo'));
});

test('Organización muestra el estado REAL de cada agente (el de la Oficina), no el campo «activo» de configuración', () => {
  const t = SCREENS.team;
  assert.match(t, /const stateOf = \(id: string\) => office\.find\(o => o\.id === id\)\?\.state \?\? null;/);
  assert.ok(t.includes('<span className={`state-pill state-${st ?? \'idle\'}`}>{STATE_TEXT[st ?? \'idle\']}</span>'), 'el estado se muestra con su texto, no solo con color');
  assert.ok(!t.includes('Trabajando ahora') && !t.includes("a.status === 'active'"), 'sin la franja que confundía «configurado como activo» con «trabajando»');
  assert.ok(!t.includes('>Activar equipo</button>'), 'sin un botón que nunca se habilita');
  assert.ok(lede(t).includes('Ningún agente consume créditos hasta que autorices su trabajo.'), 'la garantía de coste sigue visible');
});

test('los botones principales no cambian', () => {
  for (const label of ['Verificar conexión', 'Guardar y verificar', 'Verificar de nuevo', 'Reintentar verificación']) assert.ok(SCREENS.provider.includes(label), `falta «${label}»`);
  for (const label of ['Evaluar organización', 'Formulario completo de agente']) assert.ok(SCREENS.team.includes(label), `falta «${label}»`);
  assert.ok(read('screens/Office.tsx').includes('Nuevo agente {Icon.chevD()}'), 'crear un agente sigue a un clic desde la Oficina');
  assert.ok(SCREENS.phase.includes("'Iniciar la etapa'"));
  assert.ok(SCREENS.phase.includes('disabled={!auth || busy || !p.canStart || name.trim().length < 3}'));
  assert.ok(SCREENS.archive.includes('>Restaurar al backlog</button>'));
  assert.ok(SCREENS.archive.includes('onClick={restore} disabled={!auth || busy}>Restaurar</button>'));
});

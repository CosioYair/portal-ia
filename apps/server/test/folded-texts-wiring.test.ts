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

test('Team destaca «Trabajando ahora» antes del organigrama', () => {
  const t = SCREENS.team;
  assert.ok(t.includes('Trabajando ahora'));
  assert.ok(t.indexOf('Trabajando ahora') < t.indexOf('Estructura organizativa'), '«Trabajando ahora» debe ir antes del organigrama');
  assert.ok(t.includes("current.filter(a => a.status === 'active')"), 'debe filtrar agentes activos no retirados');
  assert.ok(t.includes('{activeAgents.length > 0'), 'la franja debe depender de que haya agentes activos');
  assert.ok(t.includes(': <p className="sm13 muted">Ningún agente está activo ahora; todos están configurados pero inactivos.</p>}'), 'el estado vacío debe ir en la rama sin agentes activos');
  assert.equal(t.split('configurados pero inactivos').length - 1, 1, 'el mensaje de inactivos debe aparecer una sola vez');
  assert.ok(!t.includes('<Notice kind="info">Todos los agentes están'), 'no debe quedar el aviso duplicado de inactivos');
  assert.ok(lede(t).includes('Ningún agente consume créditos hasta que autorices su ejecución.'), 'la garantía de coste sigue visible');
});

test('los botones principales no cambian', () => {
  for (const label of ['Verificar conexión', 'Guardar y verificar', 'Verificar de nuevo', 'Reintentar verificación']) assert.ok(SCREENS.provider.includes(label), `falta «${label}»`);
  for (const label of ['Evaluar organización', 'Nuevo agente especializado', '>Activar equipo</button>']) assert.ok(SCREENS.team.includes(label), `falta «${label}»`);
  assert.ok(SCREENS.team.includes('disabled title="Requiere autorización de ejecución y presupuesto aprobado">Activar equipo'));
  assert.ok(SCREENS.phase.includes("'Iniciar la etapa'"));
  assert.ok(SCREENS.phase.includes('disabled={!auth || busy || !p.canStart || name.trim().length < 3}'));
  assert.ok(SCREENS.archive.includes('>Restaurar al backlog</button>'));
  assert.ok(SCREENS.archive.includes('onClick={restore} disabled={!auth || busy}>Restaurar</button>'));
});

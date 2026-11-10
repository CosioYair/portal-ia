import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManualTestSteps, isOutsidePortalStep } from '@portal-ia/domain';
import { assessDeveloperOutput, markOutsidePortalSteps, parseFileBlocks } from '../src/services/devOutput.ts';

const SEP = '='.repeat(3);
const sectionHeader = (name: string) => `${SEP} ${name} ${SEP}`;

const POSITIVE: [string, string][] = [
  ['.ts', 'Revisa el cambio en manual-test.ts'],
  ['.tsx', 'Mira ManualTestStepList.tsx en el navegador'],
  ['apps/', 'Entra en apps/web y comprueba la carpeta'],
  ['docs/', 'Lee docs/guia.md antes de seguir'],
  ['abre el archivo', 'Abre el archivo de configuración y revisa la clave'],
  ['abrir el archivo (acentos y mayúsculas)', 'ÁBRIR EL ARCHIVO de notas'],
  ['terminal', 'Ejecuta npm test en la Terminal'],
  ['editor', 'Usa el editor para cambiar el texto']
];

const NEGATIVE = [
  'Abre la pantalla Backlog. Esperado: aparece la lista de historias.',
  'Pulsa «Guardar». Esperado: el estado cambia a Activo.',
  'Revisa la línea editorial del proyecto',
  'Comprueba las terminales de pago en Ajustes',
  'La carpeta webapps/ no aplica aquí',
  'La carpeta mydocs/ no aplica aquí'
];

for (const [pattern, text] of POSITIVE) {
  test(`HU-191: el patrón «${pattern}» marca el paso como fuera del Portal`, () => {
    assert.equal(isOutsidePortalStep(text), true, text);
    assert.deepEqual(markOutsidePortalSteps([text]), [{ text, outsidePortal: true }]);
  });
}

test('HU-191: pasos dentro del Portal no se marcan (casos negativos)', () => {
  for (const text of NEGATIVE) {
    assert.equal(isOutsidePortalStep(text), false, text);
    assert.equal(markOutsidePortalSteps([text])[0].outsidePortal, false, text);
  }
});

test('HU-191: el detector no guarda estado entre llamadas', () => {
  const text = 'abre apps/web/x.ts';
  assert.equal(isOutsidePortalStep(text), true);
  assert.equal(isOutsidePortalStep(text), true);
  assert.equal(isOutsidePortalStep('Abre la pantalla Backlog'), false);
  assert.equal(isOutsidePortalStep('Abre la pantalla Backlog'), false);
});

const OUTPUT = [
  sectionHeader('RESUMEN'),
  'Cambio de prueba.',
  sectionHeader('PRUEBA MANUAL'),
  '1. Abre la pantalla Backlog. Esperado: aparece la lista.',
  '2. abre apps/web/x.ts',
  '3. Ejecuta npm test en la terminal. Esperado: todo pasa.',
  sectionHeader('NOTAS'),
  'Sin notas.'
].join('\n');

test('HU-191: assessDeveloperOutput devuelve manualStepsMarked alineado con manualSteps', () => {
  const { parsed } = assessDeveloperOutput(OUTPUT, { stopReason: 'end_turn', exists: () => false });
  assert.deepEqual(parsed.manualSteps, [
    'Abre la pantalla Backlog. Esperado: aparece la lista.',
    'abre apps/web/x.ts',
    'Ejecuta npm test en la terminal. Esperado: todo pasa.'
  ]);
  assert.ok(Array.isArray(parsed.manualStepsMarked), 'manualStepsMarked debe existir');
  const marked = parsed.manualStepsMarked!;
  assert.deepEqual(marked.map(s => s.text), parsed.manualSteps);
  assert.deepEqual(marked.map(s => s.outsidePortal), [false, true, true]);
});

test('HU-191: parseFileBlocks también marca los pasos', () => {
  const parsed = parseFileBlocks(OUTPUT);
  assert.ok(Array.isArray(parsed.manualStepsMarked), 'manualStepsMarked debe existir');
  assert.deepEqual(parsed.manualStepsMarked!.map(s => s.text), parsed.manualSteps);
  assert.equal(parsed.manualStepsMarked![1].outsidePortal, true);
  assert.equal(parsed.manualStepsMarked![0].outsidePortal, false);
});

test('HU-191: buildManualTestSteps expone outsidePortal para la pantalla', () => {
  const items = buildManualTestSteps(['abre apps/web/x.ts', 'Abre la pantalla Backlog'], []);
  assert.equal(items[0].outsidePortal, true);
  assert.equal(items[1].outsidePortal, false);
});

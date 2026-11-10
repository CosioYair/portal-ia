import { manualTestStepKey } from './types.ts';

/** Resultado del feedback de un paso de la prueba manual (contrato vigente del endpoint). */
export type ManualTestResult = 'ok' | 'fail' | 'observation';

/** Feedback guardado de un paso; el servidor devuelve más campos (processId, updatedAt) que aquí se ignoran. */
export interface ManualTestFeedbackEntry {
  stepKey: string;
  result: ManualTestResult | null;
  comment: string;
}

/** Un paso de la lista «Qué probar, paso a paso» con su feedback ya unido. */
export interface ManualTestStepView {
  index: number;
  stepKey: string;
  /** Texto completo del paso, sin recortar. */
  text: string;
  result: ManualTestResult | null;
  comment: string;
  /** Casilla heredada de versiones anteriores (solo lectura). */
  checked: boolean;
  /** Paso realizado: OK cuenta; un resultado Falla/Observación explícito prevalece sobre la casilla antigua. */
  done: boolean;
  /** El paso obliga a salir del Portal (rutas de código, abrir archivos, terminal o editor). Solo informativo. */
  outsidePortal: boolean;
}

/**
 * Patrones (sin IA) de pasos que obligan a salir del Portal. Se aplican sobre el texto en minúsculas y sin acentos.
 * Sin bandera «g»: no guardan estado entre llamadas (lastIndex).
 */
export const OUTSIDE_PORTAL_PATTERNS: readonly RegExp[] = [
  /[\w./-]+\.tsx?\b/,                       // rutas de archivos .ts / .tsx
  /(?:^|[^\w/.-])apps\//,                   // apps/… (no «webapps/»)
  /(?:^|[^\w/.-])docs\//,                   // docs/… (no «mydocs/»)
  /\babr(?:e|ir|a|es|o)\s+el\s+archivo\b/,  // «abre el archivo», «abrir el archivo»…
  /\bterminal\b/,                           // no «terminales»
  /\beditor\b/                              // no «editorial»
];

/** true si el paso de la prueba manual obliga a salir del Portal (detector determinista, sin IO). */
export function isOutsidePortalStep(text: string): boolean {
  const norm = String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return OUTSIDE_PORTAL_PATTERNS.some(re => re.test(norm));
}

/** Parte de un paso de la prueba manual: la acción y, si existe, el resultado esperado. */
export interface ManualStepParts {
  /** Acción del paso, sin el punto final. */
  action: string;
  /** Texto tras «Esperado:», o null si el paso no lo trae. */
  expected: string | null;
}

/** Marcador «Esperado:» sin distinguir mayúsculas ni acentos («ESPERADO:», «esperado :», «Ésperado:»). Sin bandera «g». */
const EXPECTED_MARK = /(?<![\p{L}\p{N}])[eéèêë]sperad[oóòôö]s?\s*:/iu;

/**
 * HU-192 · Separa un paso en acción y resultado esperado cortando por la primera aparición de «Esperado:».
 * Sin «Esperado:» devuelve el texto completo (recortado) como acción y expected null. Función pura, sin IO.
 */
export function splitManualStep(text: string): ManualStepParts {
  const src = String(text ?? '').normalize('NFC');
  const m = EXPECTED_MARK.exec(src);
  if (!m) return { action: src.trim(), expected: null };
  const action = src.slice(0, m.index).trim().replace(/[\s.]+$/, '').trim();
  const expected = src.slice(m.index + m[0].length).trim();
  if (!action) return { action: src.trim(), expected: null };
  return { action, expected: expected || null };
}

/** Une pasos, feedback (por clave de paso) y casillas antiguas: un ítem por paso, en orden. */
export function buildManualTestSteps(
  steps: readonly string[],
  feedback: readonly ManualTestFeedbackEntry[],
  checks: readonly boolean[] = []
): ManualTestStepView[] {
  const byKey = new Map<string, ManualTestFeedbackEntry>();
  for (const f of feedback) byKey.set(f.stepKey, f);
  return steps.map((text, index) => {
    const stepKey = manualTestStepKey(index, text);
    const f = byKey.get(stepKey);
    const result = f?.result ?? null;
    const checked = checks[index] === true;
    return {
      index, stepKey, text, result, comment: f?.comment ?? '', checked,
      done: result === 'ok' || (result === null && checked),
      outsidePortal: isOutsidePortalStep(text)
    };
  });
}

/** Cuenta los pasos realizados. */
export function countDoneManualSteps(items: readonly ManualTestStepView[]): number {
  return items.filter(i => i.done).length;
}

/** Texto copiable con los pasos en Falla y sus comentarios; cadena vacía si no hay ninguno. */
export function buildFailureBlock(items: readonly ManualTestStepView[]): string {
  const failed = items.filter(i => i.result === 'fail');
  if (!failed.length) return '';
  const blocks = failed.map(i => {
    const comment = i.comment.trim().replace(/\n/g, '\n   ') || '(sin comentario)';
    return `${i.index + 1}. ${i.text}\n   Comentario: ${comment}`;
  });
  return `Pasos con falla (${failed.length}):\n\n${blocks.join('\n\n')}`;
}

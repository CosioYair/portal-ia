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
      done: result === 'ok' || (result === null && checked)
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

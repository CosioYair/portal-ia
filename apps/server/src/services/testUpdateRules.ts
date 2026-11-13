import { weakensTest } from './testTriage.ts';

/**
 * Portal IA 3 (Gauntlet B1) · Actualización de una prueba existente SIN evidencia de línea base (solo está vinculada a un
 * archivo que la historia cambia). Además de `weakensTest` (ni skip/todo/only, ni menos casos, ni menos aserciones):
 *  - no puede cambiar el TIPO de ninguna comprobación (assert.equal por assert.ok, match por doesNotMatch…);
 *  - no puede añadir comprobaciones que siempre pasan (assert.ok(true), assert(1)…);
 *  - no puede renombrar ni quitar casos.
 * Así solo cabe adaptar los valores esperados al comportamiento nuevo. Reescribir una prueba para que pase exige la vía con
 * evidencia (pasa en la base y falla con la historia) y queda a la vista del propietario. Sin IA, determinista.
 */
export function weakensUnprovenUpdate(before: string, after: string): string | null {
  const base = weakensTest(before, after);
  if (base) return base;
  const kinds = (s: string) => {
    const m = new Map<string, number>();
    for (const x of s.matchAll(/\bassert(?:\.(\w+))?\s*\(/g)) { const k = x[1] ?? 'assert'; m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  };
  const b = kinds(before); const a = kinds(after);
  for (const [k, n] of b) if ((a.get(k) ?? 0) < n) return `cambia el tipo de ${n - (a.get(k) ?? 0)} comprobación(es) «assert.${k}»`;
  const trivial = (s: string) => (s.match(/\bassert(?:\.ok)?\s*\(\s*(?:true|1|!0|!!1)\s*[,)]/g) ?? []).length;
  if (trivial(after) > trivial(before)) return 'añade una comprobación que siempre pasa';
  const names = (s: string) => new Set([...s.matchAll(/\b(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2]!));
  const an = names(after);
  const lost = [...names(before)].filter(n => !an.has(n));
  if (lost.length) return `renombra o quita el caso «${lost[0]!.slice(0, 80)}»`;
  return null;
}

import type { IssueSeverity } from './types.ts';

/** Gravedad de una observación de QA: prefijo «[alta]/[media]/[baja]» si lo trae; si no, por palabras clave. */
export function qaSeverity(issue: string): { severity: IssueSeverity; text: string } {
  const m = issue.match(/^\s*\[?\s*(alta|media|baja|cr[ií]tica|grave|menor)\s*[\]:\-–]\s*(.*)$/i);
  if (m) { const k = m[1].toLowerCase(); return { severity: /alta|cr[ií]tica|grave/.test(k) ? 'alta' : k === 'media' ? 'media' : 'baja', text: m[2].trim() }; }
  if (/(seguridad|secreto|credencial|inyecci|rompe|romper|no compila|error de tipos|bloque|cr[ií]tic|grave|p[ée]rdida de datos|regresi[oó]n|incorrect|no cumple|falta .*criterio)/i.test(issue)) return { severity: 'alta', text: issue.trim() };
  if (/(menor|estilo|sugerencia|opcional|cosm[ée]tic|nombre|comentario|legibilidad|podr[ií]a|considera)/i.test(issue)) return { severity: 'baja', text: issue.trim() };
  return { severity: 'media', text: issue.trim() };
}

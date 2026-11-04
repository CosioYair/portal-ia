import { createHash } from 'node:crypto';
import type { BaselineRun, BaselineTriage, FailingTestRef, TestDigest } from '@portal-ia/domain';
import { failingTests } from './failureDiagnosis.ts';

/**
 * Reglas PURAS del triaje frente a la base (sin base de datos, git ni sistema de archivos): qué fallos ya ocurrían sin la
 * historia, cuáles son suyos y qué pruebas existentes puede actualizar. La parte con efectos está en baseline.ts.
 */

/** Ruta de un archivo de prueba relativa al repositorio (la salida trae /work/…, rutas del equipo con \\ o file:///…). */
export function relFile(file: string | null | undefined, roots: string[]): string | null {
  if (!file) return null;
  let f = file.replace(/\\\\/g, '\\').replace(/^file:\/\/\//i, '').replace(/\\/g, '/');
  for (const r of ['/work', ...roots].map(x => x.replace(/\\/g, '/').replace(/\/+$/, ''))) if (r && f.toLowerCase().startsWith(`${r.toLowerCase()}/`)) { f = f.slice(r.length + 1); break; }
  return f.replace(/^\.\//, '');
}

/** Huella de una prueba que pasó (por nombre): prueba POSITIVA de que en la base estaba en verde. */
export const passKey = (name: string) => createHash('sha1').update(name.trim()).digest('hex').slice(0, 12);

/**
 * Resumen de «test» sobre la salida COMPLETA: cuenta, fallos con su error y valores (archivo relativo) y huellas de las
 * pruebas que pasaron. Se calcula antes de recortar la salida (sandbox.ts) para no perder ningún fallo.
 */
export function testDigest(output: string, roots: string[] = []): TestDigest {
  const num = (k: string) => { const m = output.match(new RegExp(`^#\\s*${k}\\s+(\\d+)\\s*$`, 'm')) ?? output.match(new RegExp(`^ℹ\\s*${k}\\s+(\\d+)\\s*$`, 'm')); return m ? Number(m[1]) : null; };
  const failing = failingTests({ command: 'test', output }, 2000).filter(t => t.kind !== 'cancelled').map(t => ({ file: relFile(t.file, roots), name: t.name, message: t.message.slice(0, 900), line: t.line ?? null, ...(t.expected !== undefined || t.actual !== undefined ? { expected: t.expected ?? null, actual: t.actual ?? null } : {}) }));
  const passedKeys = Array.from(new Set(output.split('\n').map(l => l.match(/^\s*ok \d+ - (.+?)(?:\s+#.*)?\s*$/)?.[1]).filter((n): n is string => !!n).map(passKey)));
  return { total: num('tests'), passed: num('pass'), failed: num('fail'), cancelled: num('cancelled'), failing, passedKeys };
}

/** La salida guardada se recortó (no conserva todo): sin su resumen completo no se puede asegurar que se vean todos los fallos. */
export const clippedOutput = (output: string) => /caracteres omitidos/.test(output);

/**
 * Núcleo comparable de un error: solo se quita lo que cambia entre ejecuciones sin cambiar el fallo (duraciones, rutas
 * temporales o de trabajo, ids hexadecimales, puertos). Los números y valores se conservan: «2 !== 3» y «0 !== 3» son
 * errores distintos (antes se igualaban y una regresión pasaba por preexistente).
 */
export function errorKernel(message: string): string {
  return message
    .replace(/(?:file:\/\/\/)?(?:[A-Za-z]:)?(?:[\\/][^\s'"`,()]*?)?[\\/](?:work|tmp|Temp|temp|[^\s'"`,()\\/]*-worktrees)[\\/][^\s'"`,()]*/g, '<ruta>')
    .replace(/\b\d+(?:\.\d+)?\s?ms\b/g, '# ms').replace(/\b[0-9a-f]{8,}\b/gi, '<id>').replace(/(127\.0\.0\.1|localhost):\d{2,5}/g, '$1:<puerto>')
    .replace(/\s+/g, ' ').trim().slice(0, 400);
}

/** Pruebas cuyo cambio debilitaría controles del Portal: nunca se «actualizan» por un cambio de comportamiento. */
export const SENSITIVE_TEST = /propietario|owner|pol[ií]tica|policy|seguridad|security|sandbox|bridge|puente|capabilit|capacidad|git-?safety|permis|secret|credencial|crypto|cifrado/i;

/**
 * Clasifica las pruebas que fallan con la historia frente a la base.
 *  - preexistente: misma prueba (archivo y nombre), misma línea de la aserción, mismos valores y el mismo error.
 *  - cambiada: ya fallaba, pero distinto (otros valores, otra línea, otro error) o la historia dice ocuparse de ella.
 *  - introducida: no fallaba en la base. Si la base demuestra que PASABA (y no es de seguridad), es actualizable.
 * `storyFiles`: archivos que la historia creó o cambió (una prueba suya que falla es suya). `scope`: lo que la historia
 * dice abordar (archivos que cambia o entrega y el texto de su plan y criterio).
 */
export function classify(failing: FailingTestRef[], base: BaselineRun, storyFiles: Set<string>, scope: { files?: Iterable<string>; text?: string } = {}): BaselineTriage {
  const out: BaselineTriage = { baseCommit: base.commit, at: new Date().toISOString(), preexisting: [], introduced: [], changed: [], accepted: false, unavailable: null, updatableFiles: [] };
  const files = new Set(scope.files ?? []); const text = (scope.text ?? '').toLowerCase();
  const base1 = (f: string) => f.split('/').pop()!.toLowerCase();
  const targeted = (f: FailingTestRef) => (!!f.file && (files.has(f.file) || text.includes(f.file.toLowerCase()) || text.includes(base1(f.file)))) || (f.name.length >= 12 && text.includes(f.name.toLowerCase()));
  const sameFailure = (a: FailingTestRef, b: FailingTestRef) => (a.line == null || b.line == null || a.line === b.line) && (a.expected ?? null) === (b.expected ?? null) && (a.actual ?? null) === (b.actual ?? null) && errorKernel(a.message) === errorKernel(b.message);
  const passedOnBase = new Set(base.passedKeys ?? []);
  const updatable = new Set<string>();
  for (const f of failing) {
    if (f.file && storyFiles.has(f.file)) { out.introduced.push(f); continue; }
    const same = base.failing.find(b => b.name === f.name && (b.file ?? '') === (f.file ?? ''));
    if (!same) { out.introduced.push(f); if (f.file && passedOnBase.has(passKey(f.name)) && !SENSITIVE_TEST.test(f.file)) updatable.add(f.file); continue; }
    if (targeted(f)) out.changed.push({ ...f, message: `${f.message} (ya fallaba en la base, pero esta historia se ocupa de ella: aparece en su plan o su criterio)` });
    else if (sameFailure(same, f)) out.preexisting.push(f);
    else out.changed.push({ ...f, message: `${f.message} (en la base fallaba distinto: ${same.message.slice(0, 300)}${same.actual != null || same.expected != null ? ` · base: ${same.actual ?? '?'} vs ${same.expected ?? '?'}` : ''})` });
  }
  // Un archivo con fallos de la historia que NO están probados en verde en la base no es actualizable.
  for (const f of [...out.introduced, ...out.changed]) if (f.file && updatable.has(f.file) && !passedOnBase.has(passKey(f.name))) updatable.delete(f.file);
  out.updatableFiles = Array.from(updatable);
  out.accepted = failing.length > 0 && !out.introduced.length && !out.changed.length;
  return out;
}

/** ¿Es preexistente esta prueba según el triaje? (mismo archivo y nombre) */
export function isPreexisting(t: { file: string | null; name: string }, triage: BaselineTriage | null | undefined): boolean {
  return !!triage && !triage.unavailable && triage.preexisting.some(p => p.name === t.name && (relFile(p.file, []) ?? '') === (relFile(t.file, []) ?? ''));
}

/** Texto del triaje para la evidencia (QA, corrección, propietario). */
export function triageText(t: BaselineTriage | null | undefined): string {
  if (!t) return '';
  if (t.unavailable) return `Línea base no disponible (${t.unavailable}): no se pudo separar lo preexistente; todos los fallos cuentan como de la historia.`;
  const list = (xs: FailingTestRef[]) => xs.map(x => `«${x.name}»${x.file ? ` (${x.file})` : ''}`).join(', ');
  const b = t.baseCommit.slice(0, 7);
  return [
    t.preexisting.length ? `Ya fallan en la base ${b}, sin esta historia y con el mismo error (NO las causó ella; no se tocan): ${list(t.preexisting)}.` : '',
    t.introduced.length ? `No fallaban en la base ${b} y fallan con esta historia (las rompió ella): ${list(t.introduced)}.` : '',
    t.changed.length ? `Ya fallaban en la base ${b}, pero ahora de otra forma o la historia se ocupa de ellas (cuentan como de la historia): ${list(t.changed)}.` : ''
  ].filter(Boolean).join('\n');
}

/**
 * ¿Debilita la prueba? (sin IA, determinista): añade skip/todo/only o quita casos o aserciones. Un cambio así nunca se
 * acepta como «actualización por cambio de comportamiento».
 */
export function weakensTest(before: string, after: string): string | null {
  const n = (s: string, re: RegExp) => (s.match(re) ?? []).length;
  if (n(after, /\.(?:skip|todo|only)\s*\(|\{\s*(?:skip|todo|only)\s*:/g) > n(before, /\.(?:skip|todo|only)\s*\(|\{\s*(?:skip|todo|only)\s*:/g)) return 'añade skip/todo/only';
  if (n(after, /\b(?:test|it)\s*\(/g) < n(before, /\b(?:test|it)\s*\(/g)) return 'quita casos de prueba';
  if (n(after, /\bassert\b|\bexpect\s*\(/g) < n(before, /\bassert\b|\bexpect\s*\(/g)) return 'quita aserciones';
  return null;
}

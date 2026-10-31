import type { DeliveryCheck } from '@portal-ia/domain';
import { git } from './repoWrite.ts';

/**
 * Equivalencia de estilos SIN navegador ni IA (HU-173): en una historia que solo cambia hojas de estilo, ¿los valores
 * resueltos antes y después son idénticos? Se sustituye cada `var(--x[, alternativa])` por el valor del token definido en
 * los bloques `:root` de las hojas del repositorio (en cada versión) y se comparan las hojas normalizadas.
 * - Prueba algo más fuerte que unas capturas de pantalla: cada declaración, en todos los estados (hover, foco, media
 *   queries), resuelve al mismo valor. No prueba nada sobre HTML, JavaScript ni el orden de carga (eso lo cubren las pruebas).
 * - Si un token se define más de una vez con valores distintos (temas, media queries) no se adivina: «no determinada».
 * - Solo informa: QA lo recibe como evidencia junto al resto de comprobaciones; no aprueba nada por sí sola.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** Tokens de los bloques `:root` de varias hojas; `ambiguous` si un nombre tiene valores distintos. */
export function rootTokens(sheets: string[]): { tokens: Map<string, string>; ambiguous: Set<string> } {
  const tokens = new Map<string, string>(); const ambiguous = new Set<string>();
  for (const css of sheets) for (const m of strip(css).matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const d of m[1].split(';')) {
      const i = d.indexOf(':'); if (i <= 0) continue;
      const name = d.slice(0, i).trim(); const value = d.slice(i + 1).trim(); if (!name.startsWith('--')) continue;
      if (tokens.has(name) && tokens.get(name) !== value) ambiguous.add(name); else tokens.set(name, value);
    }
  }
  return { tokens, ambiguous };
}

/** Sustituye `var()` (también anidados y con alternativa) por su valor; cuenta los resueltos y los sin definir. */
export function resolveVars(css: string, tokens: Map<string, string>, stats = { resolved: 0, undefined: new Set<string>() }, depth = 0): string {
  let out = ''; let i = 0;
  while (i < css.length) {
    const j = css.indexOf('var(', i); if (j < 0) { out += css.slice(i); break; }
    out += css.slice(i, j);
    let level = 0; let k = j + 3;
    for (; k < css.length; k++) { if (css[k] === '(') level++; else if (css[k] === ')') { level--; if (level === 0) break; } }
    const inner = css.slice(j + 4, k); const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const value = tokens.get(name);
    if (value !== undefined && depth < 8) { out += resolveVars(value, tokens, stats, depth + 1); stats.resolved++; }
    else { if (comma >= 0) out += resolveVars(inner.slice(comma + 1), tokens, stats, depth + 1); else out += `var(${name})`; stats.undefined.add(name); }
    i = k + 1;
  }
  return out;
}

/** Forma normal: sin comentarios, colores hex en minúsculas y de 6 cifras, espacios mínimos. */
export function normalizeCss(css: string): string {
  return strip(css)
    .replace(/#([0-9a-f]{3})\b(?![0-9a-f])/gi, (_, h: string) => '#' + h.split('').map(x => x + x).join(''))
    .replace(/#[0-9a-f]{6}\b/gi, h => h.toLowerCase())
    .replace(/\s+/g, ' ').replace(/\s*([,:;{}()>+~])\s*/g, '$1').replace(/;}/g, '}').trim();
}

/** Compara hojas antes/después (con los tokens de cada versión). `changed`: rutas de las hojas que cambió la historia. */
export function compareSheets(before: { sheets: Map<string, string> }, after: { sheets: Map<string, string> }, changed: string[]): { identical: boolean; resolved: number; ambiguous: string[]; differences: string[] } {
  const tb = rootTokens([...before.sheets.values()]); const ta = rootTokens([...after.sheets.values()]);
  const ambiguous = [...new Set([...tb.ambiguous, ...ta.ambiguous])];
  let resolved = 0; const differences: string[] = [];
  for (const path of changed) {
    const sb = { resolved: 0, undefined: new Set<string>() }; const sa = { resolved: 0, undefined: new Set<string>() };
    // El propio bloque :root (definición de tokens) no se compara: lo que importa es lo que resuelve cada declaración.
    const body = (css: string) => strip(css).replace(/:root\s*\{[^}]*\}/g, '');
    const rb = normalizeCss(resolveVars(body(before.sheets.get(path) ?? ''), tb.tokens, sb));
    const ra = normalizeCss(resolveVars(body(after.sheets.get(path) ?? ''), ta.tokens, sa));
    resolved += sa.resolved;
    if (rb !== ra) {
      const rulesB = rb.split('}'); const rulesA = ra.split('}');
      for (let n = 0; n < Math.max(rulesB.length, rulesA.length) && differences.length < 6; n++) if (rulesB[n] !== rulesA[n]) differences.push(`${path}: «${(rulesB[n] ?? '').slice(0, 120)}» → «${(rulesA[n] ?? '').slice(0, 120)}»`);
      if (!differences.some(d => d.startsWith(path))) differences.push(`${path}: cambia el orden o el número de reglas`);
    }
  }
  return { identical: differences.length === 0 && ambiguous.length === 0, resolved, ambiguous, differences };
}

/**
 * La comprobación sobre un worktree: base = el commit común con main; head = el commit actual. Solo aplica si TODO lo que
 * cambió la historia (salvo pruebas) son hojas .css; si no, «no aplica» (un cambio de interfaz cambia el aspecto a propósito).
 */
export async function styleEquivalenceCheck(worktree: string, mainBranch: string, changedPaths: string[]): Promise<DeliveryCheck | null> {
  const code = changedPaths.filter(p => !/(^|\/)test\/|\.test\.|\.spec\./.test(p));
  if (!code.length || !code.every(p => p.endsWith('.css'))) return null;
  const name = 'estilos resueltos idénticos (CSS, sin IA)';
  try {
    const head = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
    const base = (await git(worktree, ['merge-base', head, mainBranch])).trim();
    const list = async (ref: string) => (await git(worktree, ['ls-tree', '-r', '--name-only', ref])).split('\n').map(s => s.trim()).filter(p => p.endsWith('.css') && !p.includes('node_modules/'));
    const read = async (ref: string, files: string[]) => { const m = new Map<string, string>(); for (const f of files) { try { m.set(f, await git(worktree, ['show', `${ref}:${f}`])); } catch { /* no existe en esa versión */ } } return m; };
    const before = { sheets: await read(base, await list(base)) }; const after = { sheets: await read(head, await list(head)) };
    const res = compareSheets(before, after, code);
    if (res.ambiguous.length) return { name, state: 'undetermined', detail: `tokens con varios valores (${res.ambiguous.slice(0, 4).join(', ')}): no se puede afirmar la equivalencia sin un navegador` };
    return res.identical
      ? { name, state: 'passed', detail: `${code.length} hoja(s) · ${res.resolved} var() resueltas · base ${base.slice(0, 7)} → ${head.slice(0, 7)}: cada declaración resuelve al mismo valor (no sustituye a unas capturas de pantalla: no mira HTML ni JavaScript)` }
      : { name, state: 'failed', detail: `cambian valores resueltos: ${res.differences.join(' · ')}` };
  } catch (e: any) { return { name, state: 'undetermined', detail: `no se pudo comparar con git: ${String(e?.message ?? e).slice(0, 160)}` }; }
}

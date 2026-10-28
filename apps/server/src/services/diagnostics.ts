import type { FlowIssueDetail, VerificationRun } from '@portal-ia/domain';

/**
 * Lectura de la salida de las verificaciones y de la revisión de QA para explicar un fallo sin obligar al propietario a
 * leer el log: errores de TypeScript con archivo y línea, pruebas que fallan, causa de un build roto y observaciones de
 * QA por gravedad. Sin IA; si no reconoce el formato devuelve las últimas líneas útiles.
 */
const ANSI = /\u001b\[[0-9;]*m/g;
const clean = (s: string) => s.replace(ANSI, '').replace(/\r/g, '');
const uniq = <T,>(xs: T[], key: (x: T) => string) => { const seen = new Set<string>(); return xs.filter(x => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

/** Errores de TypeScript: `src/a.ts(3,7): error TS2322: …` (tsc) y `src/a.ts:3:7 - error TS2322: …` (pretty). */
/** Diagnósticos de una verificación según su comando (un solo sitio: firma de fallos, correcciones y evidencia de QA). */
export function diagnosticsFor(v: Pick<VerificationRun, 'command' | 'output'>): FlowIssueDetail[] {
  return v.command === 'typecheck' ? parseTypeScriptErrors(v.output) : v.command === 'test' ? parseFailingTests(v.output) : parseBuildErrors(v.output);
}

export function parseTypeScriptErrors(output: string, max = 20): FlowIssueDetail[] {
  const out: FlowIssueDetail[] = [];
  for (const raw of clean(output).split('\n')) {
    const l = raw.trim();
    const m = l.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/) ?? l.match(/^(.+?):(\d+):(\d+) - error (TS\d+): (.+)$/);
    if (m) out.push({ file: m[1].replace(/\\/g, '/'), line: Number(m[2]), code: m[4], text: m[5] });
  }
  return uniq(out, d => `${d.file}:${d.line}:${d.code}:${d.text}`).slice(0, max);
}

/** Pruebas que fallan (node --test en TAP o en formato «spec», y el resumen de vitest/jest). */
export function parseFailingTests(output: string, max = 15): FlowIssueDetail[] {
  const lines = clean(output).split('\n'); const out: FlowIssueDetail[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const tap = l.match(/^\s*not ok \d+ - (.+?)\s*(#.*)?$/);
    if (tap) {
      if (/\.test\.[cm]?[jt]s$/.test(tap[1])) continue; // fila del archivo: los subtests ya se listan
      let reason = '', file: string | null = null;
      for (let j = i + 1; j < Math.min(lines.length, i + 30) && !/^\s*(not )?ok \d+ /.test(lines[j]); j++) {
        const e = lines[j].match(/^\s*error: ['|]?(.*?)'?$/); if (e && !reason) reason = e[1].trim() || (lines[j + 1] ?? '').trim();
        const loc = lines[j].match(/location: '(.+?):\d+:\d+'/); if (loc && !file) file = loc[1].replace(/^\/work\//, '');
      }
      out.push({ text: `${tap[1]}${reason ? ` — ${reason.slice(0, 220)}` : ''}`, file });
      continue;
    }
    const spec = l.match(/^\s*✖ (.+?) \(\d+(\.\d+)?ms\)\s*$/);
    if (spec && !/failing tests:/.test(l)) out.push({ text: spec[1] });
    const jest = l.match(/^\s*(?:FAIL|×|✕)\s+(.+)$/);
    if (jest) out.push({ text: jest[1].trim() });
  }
  return uniq(out, d => d.text).slice(0, max);
}

/** Causa probable de un build roto (vite/rollup/esbuild) y, si hay, errores de TypeScript. */
export function parseBuildErrors(output: string, max = 10): FlowIssueDetail[] {
  const ts = parseTypeScriptErrors(output, max); if (ts.length) return ts;
  const out: FlowIssueDetail[] = [];
  for (const raw of clean(output).split('\n')) {
    const l = raw.trim(); if (!l) continue;
    const loc = l.match(/(?:file:\s*)?((?:[\w@.-]+\/)+[\w@.-]+\.(?:tsx?|jsx?|css|json|mjs)):(\d+):(\d+)/);
    if (/(✘ \[ERROR\]|\berror\b|Error:|failed to|Could not resolve|Expected|Unexpected)/i.test(l) && !/^npm (ERR|error)!? (code|path|command|A complete log)/i.test(l) && !/^> /.test(l))
      out.push({ text: l.slice(0, 300), file: loc?.[1] ?? null, line: loc ? Number(loc[2]) : null });
  }
  return uniq(out, d => d.text).slice(0, max);
}

/** Últimas líneas útiles de una salida (para evidencia), sin ruido de npm ni líneas vacías. */
export function tailOf(output: string, lines = 25): string {
  return clean(output).split('\n').filter(l => l.trim() && !/^\{"level":/.test(l) && !/^npm (notice|warn)/i.test(l)).slice(-lines).join('\n');
}

export { qaSeverity } from '@portal-ia/domain';

/** Archivos mencionados en un texto (rutas relativas con extensión). */
export function filesIn(text: string): string[] {
  return Array.from(new Set((clean(text).match(/(?:[\w@.-]+\/)+[\w@.-]+\.(?:tsx?|jsx?|css|json|mjs|md)/g) ?? []).map(f => f.replace(/^\/work\//, '')))).slice(0, 12);
}

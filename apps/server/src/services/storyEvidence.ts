import { verificationPassed, verificationsForApplied, type Process } from '@portal-ia/domain';
import { failingTests } from './failureDiagnosis.ts';
import { isPreexisting, triageText } from './testTriage.ts';

const cut = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

/**
 * Evidencia REAL de una iteración para quien tenga que decidir qué hacer después (el equipo al responder «Preguntar al
 * equipo» y la iteración siguiente): qué falla ahora y con qué error, qué ya fallaba sin la historia (línea base), qué
 * correcciones se intentaron (commit) y qué pasó tras cada una. HU-177: la pregunta al equipo solo recibía títulos y la
 * iteración siguiente repetía los mismos errores sin saber lo que ya se había probado.
 */
export function iterationEvidence(p: Process | null | undefined, max = 6_000): string {
  const r = p?.result; if (!r) return '';
  const out: string[] = [];
  const runs = r.applied ? verificationsForApplied(r) : [];
  for (const cmd of ['typecheck', 'test', 'build']) {
    const v = runs.filter(x => x.command === cmd).at(-1); if (!v || v.exitCode === 0 || v.exitCode === null) continue;
    if (verificationPassed(v)) { out.push(`- ${cmd}: superada frente a la base (${v.triage!.preexisting.length} fallo(s) ya existían sin la historia).`); continue; }
    const fails = failingTests(v, 12).filter(t => t.kind !== 'cancelled' && !isPreexisting(t, v.triage));
    out.push(`- ${cmd} FALLA (código ${v.exitCode}, commit ${v.commit?.slice(0, 7) ?? '?'})${fails.length ? ':' : ''}${fails.map(t => `\n  · «${t.name}»${t.file ? ` (${t.file}${t.line ? `:${t.line}` : ''})` : ''}: ${cut(t.message, 400)}`).join('')}`);
    const t = triageText(v.triage); if (t) out.push(t.split('\n').map(l => `  ${l}`).join('\n'));
  }
  const man = r.manifest;
  const tried = (man?.units ?? []).filter(u => u.kind === 'correction' && (u.status === 'done' || u.status === 'failed'));
  if (tried.length) {
    out.push('Correcciones ya intentadas (no las repitas a ciegas):');
    for (const u of tried.slice(-8)) out.push(`- ${cut(u.title, 160)} → ${u.commits?.length ? `commit ${u.commits.at(-1)!.slice(0, 7)} en ${(u.applied ?? []).join(', ') || 'sin archivos'}` : 'sin cambios aplicados'}${u.error ? ` · problema: ${cut(u.error, 200)}` : ''}${u.disputed ? ` · el equipo lo discutió: ${cut(u.disputed, 200)}` : ''}`);
  }
  if (man?.testUpdates?.length) out.push(`Pruebas existentes actualizadas por cambio de comportamiento: ${man.testUpdates.map(x => x.path).join(', ')}.`);
  const pl = r.pipeline;
  if (pl?.reason) out.push(`Estado del pipeline: ${pl.state} — ${cut(pl.reason, 300)} (correcciones ${pl.corrections}/${pl.config.maxCorrections}).`);
  const text = out.join('\n');
  return text.length > max ? `${text.slice(0, max - 40)}\n… (evidencia recortada)` : text;
}

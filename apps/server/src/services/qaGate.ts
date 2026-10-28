import type { DeliveryCheck, ProposedChange, QaFinding, QaVerdictKind, ReviewVerdict, StoryManifest, StoryPlan, VerificationRun } from '@portal-ia/domain';
import { qaSeverity } from '@portal-ia/domain';
import { diagnosticsFor, filesIn, tailOf } from './diagnostics.ts';

/**
 * Puerta de QA con evidencia real (pipeline autorizado). QA recibe el criterio, el plan, el diff, los archivos y el
 * resultado de typecheck/test/build en el sandbox, más los intentos anteriores, y responde un veredicto estructurado:
 * aprobado, rechazado, bloqueado por el entorno o sin poder verificar. El motor no se fía de una opinión narrativa:
 * si la verificación automática falló o falta, QA no puede aprobar, y un rechazo sin hallazgos con evidencia no es
 * accionable (no dispara correcciones a ciegas).
 */
export const QA_VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'summary', 'findings', 'suggestedTests'],
  properties: {
    verdict: { type: 'string', enum: ['approved', 'rejected', 'blocked_environment', 'unable_to_verify'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'text', 'file', 'evidence', 'requirement', 'expected', 'verify'], properties: { severity: { type: 'string', enum: ['alta', 'media', 'baja'] }, text: { type: 'string' }, file: { type: ['string', 'null'] }, evidence: { type: ['string', 'null'] }, requirement: { type: ['string', 'null'] }, expected: { type: ['string', 'null'] }, verify: { type: ['string', 'null'] } } } },
    suggestedTests: { type: 'array', items: { type: 'string' } }
  }
} as const;

const VERDICTS: QaVerdictKind[] = ['approved', 'rejected', 'blocked_environment', 'unable_to_verify'];

function extractJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const c of [fenced, text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[]) { try { return JSON.parse(c); } catch { /* siguiente */ } }
  return null;
}

/** «test» terminó en verde sin ejecutar ninguna prueba (patrón que no encuentra archivos, carpeta vacía…): no es evidencia. */
export const zeroTests = (output: string) => /^#\s*tests\s+0\b/m.test(output) || /^ℹ\s*tests\s+0\b/m.test(output) || /\b0 passing\b/.test(output) || /no test files? (?:were )?found/i.test(output) || /Tests:\s+0 total/.test(output);

/** Resultado de un comando para QA: estado, duración y, si falló, los diagnósticos y la cola de la salida. */
export function verificationEvidence(v: VerificationRun): string {
  const head = `- ${v.command}: ${v.exitCode === 0 ? 'OK' : v.exitCode === null ? 'NO TERMINÓ (tiempo agotado)' : `FALLÓ (código ${v.exitCode})`} · ${v.isolation} · ${Math.round(v.durationMs / 1000)} s`;
  if (v.exitCode === 0) return head;
  const d = diagnosticsFor(v);
  return `${head}\n${d.slice(0, 12).map(x => `  · ${x.file ? `${x.file}${x.line ? `:${x.line}` : ''} ` : ''}${x.code ? `${x.code} ` : ''}${x.text}`).join('\n')}\n  Salida (final):\n${tailOf(v.output, 15).split('\n').map(l => `    ${l}`).join('\n')}`;
}

/** Lo que dicen las pruebas en verde (cuántas pasaron), para que QA distinga «compila» de «está probado». */
export function testsEvidence(verifications: VerificationRun[]): string {
  const t = verifications.filter(v => v.command === 'test').at(-1);
  if (!t) return '';
  const pass = t.output.match(/^#\s*pass\s+(\d+)/m)?.[1] ?? t.output.match(/(\d+)\s+(?:passed|passing|pruebas? (?:ok|correctas?))/i)?.[1];
  const files = Array.from(new Set(Array.from(t.output.matchAll(/([\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)/g)).map(m => m[1]))).slice(0, 12);
  return `- test: ${t.exitCode === 0 ? 'OK' : 'FALLÓ'}${pass ? ` · ${pass} prueba(s) correctas` : ''}${files.length ? ` · archivos: ${files.join(', ')}` : ''}`;
}

export function qaEvidencePrompt(input: { criterion: string; plan: StoryPlan | null; summary: string; changes: ProposedChange[]; verifications: VerificationRun[]; required: string[]; attempts: string[]; consultText: string; manifest?: StoryManifest | null; previousFindings?: QaFinding[]; tests?: string; checks?: DeliveryCheck[]; unchangedSinceReview?: string[]; reviewedCommit?: string | null }): string {
  const files = input.changes.filter(c => !c.error).map(c => `${c.action} ${c.path} (${c.before}→${c.after} líneas)`).join('\n');
  // Revisión siguiente: el diff completo solo de lo que cambió desde la anterior; lo demás ya lo revisaste (se lista).
  const same = new Set(input.unchangedSinceReview ?? []);
  const diffs = input.changes.filter(c => !c.error && !same.has(c.path)).map(c => c.diff ?? '').join('\n\n').slice(0, 50_000);
  const sameList = same.size ? `# Sin cambios desde tu revisión anterior (commit ${input.reviewedCommit ?? '?'}): ya los revisaste; el diff de abajo es solo lo que cambió\n${Array.from(same).map(p => `- ${p}`).join('\n')}\n` : '';
  const STATE: Record<string, string> = { passed: 'SUPERADA', failed: 'FALLIDA', not_applicable: 'no aplica', undetermined: 'NO DETERMINADA (no es evidencia)' };
  const checks = input.checks?.length ? `# Estado de cada comprobación\n${input.checks.map(c => `- ${c.name}: ${STATE[c.state]} · ${c.detail}`).join('\n')}\n` : '';
  const ran = input.required.map(cmd => { const v = input.verifications.filter(x => x.command === cmd).at(-1); return v ? verificationEvidence(v) : `- ${cmd}: NO SE EJECUTÓ`; }).join('\n');
  const m = input.manifest; const g = m?.gate;
  const STATUS: Record<string, string> = { delivered: 'entregado', pending: 'SIN ENTREGAR', failed: 'NO SE PUDO ENTREGAR', dropped: 'DESCARTADO por el equipo' };
  const manifest = m ? `# Entregables del plan (estado REAL del worktree, no la palabra del agente)
${m.deliverables.map(d => `- [${d.planned ? STATUS[d.status] : 'fuera del plan'}] ${d.path}${d.lines ? ` (${d.lines} líneas)` : ''} — ${d.purpose}${d.status === 'dropped' && d.note ? `\n  motivo del descarte (confírmalo o recházalo con evidencia): ${d.note}` : ''}`).join('\n')}
${g ? `# Comprobación determinista previa (sin IA)\n${g.ok ? '- Sin problemas objetivos.' : ''}${g.missing.map(x => `\n- Falta: ${x}`).join('')}${g.invalid.map(x => `\n- ${x.path}: ${x.problem}`).join('')}${g.notes.map(x => `\n- Aviso: ${x}`).join('')}${g.testsChanged.length ? `\n- Pruebas añadidas o cambiadas: ${g.testsChanged.join(', ')}` : ''}\n` : ''}` : '';
  const prev = input.previousFindings?.length ? `# Hallazgos de tu revisión anterior (comprueba uno por uno si se corrigieron)\n${input.previousFindings.map(f => `- [${f.severity}] ${f.text}${f.file ? ` (${f.file})` : ''}`).join('\n')}\n` : '';
  const lastRound = m?.rounds.length ? m.rounds.length - 1 : -1;
  const disputes = (m?.units ?? []).filter(u => u.round === lastRound && u.disputed);
  const disputed = disputes.length ? `# El equipo discute estos hallazgos sin cambiar el código (decide con la evidencia; si tiene razón, no vuelvas a pedirlo)\n${disputes.map(u => `- «${(u.findings ?? [])[0]?.text ?? u.title}»: ${u.disputed}`).join('\n')}\n` : '';
  return `Evalúa la implementación con la EVIDENCIA real de este proceso (no solo con el diff). Eres la puerta de calidad: tu veredicto decide si se entrega al propietario o vuelve al Desarrollador.
# Criterio de aceptación
${input.criterion || '(no definido: usa el plan)'}
# Plan del Coordinador
${input.plan ? JSON.stringify(input.plan, null, 2) : '(sin plan)'}
# Resumen del Desarrollador
${input.summary.slice(0, 4000)}
${input.consultText}# Archivos modificados
${files || '(ninguno)'}
# Verificación automática en sandbox (sobre el worktree con los cambios aplicados)
${ran}
${input.tests ? `${input.tests}\n` : ''}${checks}${manifest}${prev}${disputed}${sameList}${input.attempts.length ? `# Intentos anteriores y correcciones\n${input.attempts.map(a => `- ${a}`).join('\n')}\n` : ''}# Diff
${diffs || '(vacío)'}

Reglas:
- "approved" solo si el cambio cumple el criterio Y todas las verificaciones requeridas (${input.required.join(', ')}) están en OK. Que compile no basta: comprueba que TODA la funcionalidad del criterio está implementada y probada (pruebas nuevas para lo nuevo). Una comprobación NO DETERMINADA no es evidencia: no apruebes un criterio que dependa solo de ella.
- "rejected" si hay errores en el código o no cumple el criterio. Cada hallazgo debe ser accionable y citar evidencia: "file" (ruta) y/o "evidence" (línea del diff o de la salida de verificación); indica también "requirement" (criterio afectado), "expected" (la corrección esperada, concreta) y "verify" (cómo se comprobará). Un hallazgo por problema y por archivo: el equipo corrige cada uno por separado, sin rehacer lo que funciona.
- "blocked_environment" si no se pudo verificar por el entorno (sandbox, dependencias), no por el código.
- "unable_to_verify" si con esta evidencia no puedes decidir.
- Como máximo 8 hallazgos y 6 pruebas sugeridas, de una línea cada uno. "summary" en 2-4 frases.
Responde SOLO con JSON: {"verdict": "approved"|"rejected"|"blocked_environment"|"unable_to_verify", "summary": string, "findings": [{"severity": "alta"|"media"|"baja", "text": string, "file": string|null, "evidence": string|null, "requirement": string|null, "expected": string|null, "verify": string|null}], "suggestedTests": string[]}`;
}

const issueOf = (f: QaFinding) => `[${f.severity}] ${f.text}${f.file && !f.text.includes(f.file) ? ` (${f.file})` : ''}`;

/** Lee el veredicto estructurado; acepta también el formato antiguo {approve, issues}. Sin veredicto legible → unable_to_verify. */
export function parseQaVerdict(text: string): ReviewVerdict {
  const j = extractJson(text);
  if (!j || typeof j !== 'object') return { approve: false, verdict: 'unable_to_verify', summary: 'QA no devolvió un veredicto legible; no se da por aprobado.', issues: [], findings: [], suggestedTests: [], evidenceBased: true, overridden: null };
  let verdict: QaVerdictKind = VERDICTS.includes(j.verdict) ? j.verdict : typeof j.approve === 'boolean' ? (j.approve ? 'approved' : 'rejected') : 'unable_to_verify';
  const raw: any[] = Array.isArray(j.findings) ? j.findings : Array.isArray(j.issues) ? j.issues : [];
  const findings: QaFinding[] = raw.slice(0, 12).map(x => {
    if (typeof x === 'string') { const q = qaSeverity(x); return { severity: q.severity, text: q.text, file: filesIn(x)[0] ?? null, evidence: null }; }
    const sev = ['alta', 'media', 'baja'].includes(x?.severity) ? x.severity : qaSeverity(String(x?.text ?? '')).severity;
    const opt = (k: string) => typeof x?.[k] === 'string' && x[k].trim() ? String(x[k]).slice(0, 400) : null;
    return { severity: sev, text: String(x?.text ?? '').trim(), file: x?.file ? String(x.file) : null, evidence: x?.evidence ? String(x.evidence).slice(0, 600) : null, requirement: opt('requirement'), expected: opt('expected'), verify: opt('verify') };
  }).filter(f => f.text);
  if (!VERDICTS.includes(verdict)) verdict = 'unable_to_verify';
  return { approve: verdict === 'approved', verdict, summary: String(j.summary ?? '').trim() || '(sin resumen)', issues: findings.map(issueOf), findings, suggestedTests: Array.isArray(j.suggestedTests) ? j.suggestedTests.map(String).slice(0, 6) : [], evidenceBased: true, overridden: null };
}

/** Hallazgos que se pueden corregir: citan archivo o evidencia. */
export const actionableFindings = (v: ReviewVerdict) => (v.findings ?? []).filter(f => !!(f.file || f.evidence));

/**
 * Reglas de la puerta (deterministas): la verificación automática manda sobre la opinión. Devuelve el veredicto final.
 */
export function enforceQaGate(v: ReviewVerdict, required: string[], verifications: VerificationRun[]): ReviewVerdict {
  const last = (c: string) => verifications.filter(x => x.command === c).at(-1);
  const failed = required.filter(c => { const r = last(c); return r && r.exitCode !== 0 && r.exitCode !== null && r.isolation !== 'unavailable' && r.exitCode !== 86; });
  // Un «test» en verde que no ejecutó ninguna prueba cuenta como verificación que falta, no como evidencia.
  const missing = required.filter(c => { const r = last(c); return !r || r.exitCode !== 0 || (c === 'test' && zeroTests(r.output)); }).filter(c => !failed.includes(c));
  const env = missing.some(c => { const r = last(c); return r && (r.isolation === 'unavailable' || r.exitCode === 86 || r.exitCode === null); });
  let out: ReviewVerdict = { ...v, findings: [...(v.findings ?? [])] };
  if (failed.length && out.verdict === 'approved') {
    out = { ...out, verdict: 'rejected', overridden: `QA aprobó, pero ${failed.join(', ')} falló en el sandbox: la verificación automática prevalece.` };
    for (const c of failed) out.findings!.push({ severity: 'alta', text: `${c} falla en el sandbox`, file: filesIn(last(c)!.output)[0] ?? null, evidence: tailOf(last(c)!.output, 4) });
  } else if (missing.length && out.verdict === 'approved') {
    out = { ...out, verdict: env ? 'blocked_environment' : 'unable_to_verify', overridden: `QA aprobó, pero falta verificación en verde de ${missing.join(', ')}: no se puede aprobar sin evidencia.` };
  }
  if (out.verdict === 'rejected' && !actionableFindings(out).length) out = { ...out, verdict: 'unable_to_verify', overridden: (out.overridden ? `${out.overridden} ` : '') + 'QA rechazó sin hallazgos que citen archivo o evidencia: no es accionable y no se lanza una corrección a ciegas.' };
  return { ...out, approve: out.verdict === 'approved', issues: (out.findings ?? []).map(issueOf) };
}

/** Firma de un rechazo (para detectar el mismo rechazo repetido tras una corrección). */
export const rejectionSignature = (v: ReviewVerdict) => (v.findings ?? []).filter(f => f.severity === 'alta' || f.file).map(f => `${f.file ?? ''}|${f.text.toLowerCase().replace(/[^a-záéíóúñ0-9 ]+/g, '').slice(0, 60)}`).sort().join('#');

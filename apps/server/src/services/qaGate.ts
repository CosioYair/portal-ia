import type { DeliveryCheck, ExternalCorrection, ProposedChange, QaFinding, QaVerdictKind, ReviewVerdict, StoryManifest, StoryPlan, VerificationRun } from '@portal-ia/domain';
import { qaSeverity, verificationPassed } from '@portal-ia/domain';
import { diagnosticsFor, filesIn, tailOf } from './diagnostics.ts';
import { triageText } from './testTriage.ts';

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
  const accepted = v.exitCode !== 0 && verificationPassed(v);
  const head = `- ${v.command}: ${v.exitCode === 0 ? 'OK' : v.exitCode === null ? 'NO TERMINÓ (tiempo agotado)' : accepted ? `OK FRENTE A LA BASE (código ${v.exitCode}: solo fallan pruebas que ya fallaban sin esta historia, con el mismo error)` : `FALLÓ (código ${v.exitCode})`} · ${v.isolation} · ${Math.round(v.durationMs / 1000)} s`;
  if (v.exitCode === 0) return head;
  const triage = v.triage ? `\n  Línea base (mismo «test» sin la historia, en el mismo sandbox):\n${triageText(v.triage).split('\n').map(l => `    ${l}`).join('\n')}` : '';
  if (accepted) return `${head}${triage}`;
  const d = diagnosticsFor(v);
  return `${head}${triage}\n${d.slice(0, 12).map(x => `  · ${x.file ? `${x.file}${x.line ? `:${x.line}` : ''} ` : ''}${x.code ? `${x.code} ` : ''}${x.text}`).join('\n')}\n  Salida (final):\n${tailOf(v.output, 15).split('\n').map(l => `    ${l}`).join('\n')}`;
}

/** Lo que dicen las pruebas en verde (cuántas pasaron), para que QA distinga «compila» de «está probado». */
export function testsEvidence(verifications: VerificationRun[]): string {
  const t = verifications.filter(v => v.command === 'test').at(-1);
  if (!t) return '';
  const pass = t.output.match(/^#\s*pass\s+(\d+)/m)?.[1] ?? t.output.match(/(\d+)\s+(?:passed|passing|pruebas? (?:ok|correctas?))/i)?.[1];
  const files = Array.from(new Set(Array.from(t.output.matchAll(/([\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)/g)).map(m => m[1]))).slice(0, 12);
  return `- test: ${t.exitCode === 0 ? 'OK' : verificationPassed(t) ? 'OK FRENTE A LA BASE (solo fallos preexistentes)' : 'FALLÓ'}${pass ? ` · ${pass} prueba(s) correctas` : ''}${files.length ? ` · archivos: ${files.join(', ')}` : ''}`;
}

/**
 * Reparte un tope de caracteres entre varios diffs sin que uno enorme (p. ej. un CSS minificado) deje fuera a los demás:
 * los pequeños van enteros y el resto se reparte a partes iguales; cada recorte se dice con los caracteres omitidos.
 */
export function fairClip(parts: string[], total: number): string[] {
  const out = [...parts]; let budget = total;
  const order = parts.map((p, i) => i).sort((a, b) => parts[a].length - parts[b].length);
  order.forEach((i, k) => {
    const share = Math.floor(budget / (order.length - k));
    if (parts[i].length > share) out[i] = `${parts[i].slice(0, Math.max(0, share - 80))}\n… (diff recortado: ${parts[i].length - Math.max(0, share - 80)} caracteres omitidos)`;
    budget -= Math.min(parts[i].length, share);
  });
  return out;
}

export function qaEvidencePrompt(input: { criterion: string; plan: StoryPlan | null; summary: string; changes: ProposedChange[]; verifications: VerificationRun[]; required: string[]; attempts: string[]; consultText: string; manifest?: StoryManifest | null; previousFindings?: QaFinding[]; tests?: string; checks?: DeliveryCheck[]; unchangedSinceReview?: string[]; reviewedCommit?: string | null; external?: ExternalCorrection[]; visual?: string }): string {
  const files = input.changes.filter(c => !c.error).map(c => `${c.action} ${c.path} (${c.before}→${c.after} líneas)`).join('\n');
  // Revisión siguiente: el diff completo solo de lo que cambió desde la anterior; lo demás ya lo revisaste (se lista).
  const same = new Set(input.unchangedSinceReview ?? []);
  const diffs = fairClip(input.changes.filter(c => !c.error && !same.has(c.path)).map(c => c.diff ?? ''), 50_000).join('\n\n');
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
  const ext = input.external?.length ? `# Correcciones externas registradas por el propietario (hechas fuera del equipo de agentes; el diff las incluye)\n${input.external.map(x => `- commit ${x.commit} sobre ${x.previousCommit}: ${x.files.join(', ')}${x.note ? ` — ${x.note}` : ''}`).join('\n')}\nEvalúalas con el mismo rigor: que las registrara el propietario no las aprueba.\n` : '';
  const updated = m?.testUpdates?.length ? `# Pruebas que YA existían y la historia modificó (la línea base demostró que pasan sin ella y fallan con ella)\n${m.testUpdates.map(u => `- ${u.path}: ${u.reason}`).join('\n')}\nComprueba en el diff que cada cambio solo adapta la prueba al comportamiento que un criterio de aceptación EXIGE cambiar; si debilita la prueba o el criterio no lo pide, recházalo con evidencia.\n` : '';
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
${input.tests ? `${input.tests}\n` : ''}${input.visual ? `# Evidencia visual en el host (la produce el Portal, no el Desarrollador; el propietario ve las imágenes en su revisión)\n${input.visual}\n` : ''}${checks}${manifest}${updated}${prev}${ext}${disputed}${sameList}${input.attempts.length ? `# Intentos anteriores y correcciones\n${input.attempts.map(a => `- ${a}`).join('\n')}\n` : ''}# Diff
${diffs || '(vacío)'}

Reglas:
- "approved" solo si el cambio cumple el criterio Y todas las verificaciones requeridas (${input.required.join(', ')}) están en OK. Que compile no basta: comprueba que TODA la funcionalidad del criterio está implementada y probada (pruebas nuevas para lo nuevo). Una comprobación NO DETERMINADA no es evidencia: no apruebes un criterio que dependa solo de ella.
- "rejected" si hay errores en el código o no cumple el criterio. Cada hallazgo debe ser accionable y citar evidencia: "file" (ruta) y/o "evidence" (línea del diff o de la salida de verificación); indica también "requirement" (criterio afectado), "expected" (la corrección esperada, concreta) y "verify" (cómo se comprobará). Un hallazgo por problema y por archivo: el equipo corrige cada uno por separado, sin rehacer lo que funciona.
- "blocked_environment" si no se pudo verificar por el entorno (sandbox, dependencias), no por el código.
- Capturas de pantalla e informe de accesibilidad: los genera el Portal en el host, nunca el Desarrollador (no puede lanzarlos). Si arriba hay «Evidencia visual en el host», esa ES la evidencia de los criterios que piden capturas o accesibilidad: júzgalos con ella. No pidas que se generen, no lo señales como hallazgo y no devuelvas "blocked_environment" por ello. Un desbordamiento o una violación grave que figure en esa evidencia SÍ es un hallazgo de código (cita la ruta y el ancho).
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
  // «test» con solo fallos preexistentes demostrados frente a la base cuenta como superada (verificationPassed).
  const failed = required.filter(c => { const r = last(c); return r && !verificationPassed(r) && r.exitCode !== null && r.isolation !== 'unavailable' && r.exitCode !== 86; });
  // Un «test» en verde que no ejecutó ninguna prueba cuenta como verificación que falta, no como evidencia.
  const missing = required.filter(c => { const r = last(c); return !r || !verificationPassed(r) || (c === 'test' && zeroTests(r.output)); }).filter(c => !failed.includes(c));
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

// Portal IA 3 · «Falta la evidencia visual» tiene forma de AUSENCIA: la palabra de falta gobierna directamente a
// «capturas / informe / evidencia». Un hallazgo que CITA la evidencia («según las capturas», «@375px», «se desborda»,
// «contraste») es un problema del código y nunca se retira (Gauntlet M1).
const VIS_NOUN = '(?:capturas(?: de pantalla)?|informe de (?:axe|accesibilidad)|evidencia (?:visual|de la verificaci[oó]n visual)|PNG|report\\.json)';
const VIS_ABSENT = new RegExp(`(?:^|[^\\p{L}])(?:faltan?|no hay|sin|sigue sin haber|no existen?|no trae|no se adjuntan?|no se (?:han? )?(?:aportado|generado))\\s+(?:haber\\s+)?(?:(?:las?|los?|el|unas?|ning[uú]n[ao]?s?)\\s+)?(?:\\d+\\s+)?${VIS_NOUN}`, 'iu');
const VIS_ABSENT_AFTER = new RegExp(`${VIS_NOUN}[^.:;]{0,50}?(?:^|[^\\p{L}])(?:no se han? (?:generado|aportado|ejecutado|lanzado)|pendientes?|no existen?)(?![\\p{L}])`, 'iu');
const VIS_NOT_RUN = /visual-check\.mjs\)?[^.;]{0,80}(?:no se (?:ejecut[oó]|ha ejecutado|lanz[oó])|no dej[oó] evidencia|corre en el host)/i;
const VIS_CITES = /seg[uú]n|muestran?|se ve[n ]|desbord|contraste|@\s?\d+\s?px|\d+\s?px\b[^.]{0,30}(?:se |queda|corta|rompe)/i;

/** ¿Este hallazgo solo dice que FALTA la evidencia visual (capturas, informe de axe, lanzar visual-check)? No es corregible por el equipo. */
export function isVisualEvidenceFinding(f: { text?: string | null; file?: string | null }): boolean {
  const text = String(f.text ?? '');
  // Un hallazgo sobre un archivo de pantalla es de código, diga lo que diga.
  if (/(^|\/)apps\/web\/src\//.test(String(f.file ?? '').replace(/\\/g, '/'))) return false;
  if (VIS_CITES.test(text)) return false;
  return VIS_ABSENT.test(text) || VIS_ABSENT_AFTER.test(text) || VIS_NOT_RUN.test(text);
}

/** ¿El veredicto (no aprobado) se debe, al menos en parte, a que faltaba la evidencia visual? */
export function verdictAboutMissingVisual(v: { findings?: { text?: string | null; file?: string | null }[] | null; summary?: string | null } | null | undefined): boolean {
  return (v?.findings ?? []).some(isVisualEvidenceFinding) || isVisualEvidenceFinding({ text: v?.summary ?? '' });
}

/**
 * Portal IA 3 · Con la evidencia visual ya producida por el Portal, un hallazgo que pide «generar las capturas» no tiene
 * a quién ir: se retira (queda dicho en `overridden`). Nunca convierte un veredicto en aprobado: un rechazo que se
 * queda sin nada corregible, o un bloqueo de entorno que solo era por esto, pasa a «no pudo verificar» y decide el
 * propietario. Un bloqueo de entorno con OTROS motivos (la imagen del sandbox) sigue siéndolo.
 */
export function dropSatisfiedVisualFindings(v: ReviewVerdict): ReviewVerdict {
  const all = v.findings ?? []; const kept = all.filter(f => !isVisualEvidenceFinding(f));
  if (kept.length === all.length) return v;
  const note = `${all.length - kept.length} hallazgo(s) pedían generar capturas o el informe de accesibilidad, que ya existen (los hace el Portal): no se envían al equipo.`;
  let out: ReviewVerdict = { ...v, findings: kept, issues: kept.map(issueOf), overridden: [v.overridden, note].filter(Boolean).join(' ') };
  if ((out.verdict === 'blocked_environment' && !kept.length) || (out.verdict === 'rejected' && !actionableFindings(out).length)) out = { ...out, verdict: 'unable_to_verify' };
  return { ...out, approve: out.verdict === 'approved' };
}

/** Firma de un rechazo (para detectar el mismo rechazo repetido tras una corrección). */
export const rejectionSignature = (v: ReviewVerdict) => (v.findings ?? []).filter(f => f.severity === 'alta' || f.file).map(f => `${f.file ?? ''}|${f.text.toLowerCase().replace(/[^a-záéíóúñ0-9 ]+/g, '').slice(0, 60)}`).sort().join('#');

import { createHash } from 'node:crypto';
import { gauntletReviewed, verificationsForApplied, type Process, type RevisionStatus } from '@portal-ia/domain';

/**
 * Qué cubre de verdad la aprobación de QA, por COMMIT (sin IA). Antes cada pantalla leía un campo distinto (el veredicto
 * suelto, `lastQaCommit`, el motivo de la pausa…) y podían contradecirse: «QA aprobó» junto a «QA aún no ha revisado este
 * commit» (HU-166, HU-169). Aquí se decide una vez y todas las superficies lo usan:
 * - `direct`: QA aprobó exactamente el commit actual (o el Evaluador Gauntlet re-evaluó ese commit: `gauntlet`).
 * - `carried_clean_merge`: el commit actual es el candidato de integración = lo que QA aprobó + main, combinado por git
 *   SIN conflictos, main no tocó ningún archivo de la historia ni compartido, y la verificación del sandbox está en verde
 *   sobre el candidato. La aprobación se mantiene, pero se dice que es del commit anterior (nunca «QA aprobó» el candidato).
 * - `carried_with_overlap`: igual, pero main cambió archivos de la historia o compartidos: integrar se puede, revisar con
 *   QA es lo recomendable (una combinación limpia puede romper el significado).
 * - `superseded`: conflictos resueltos por el agente o commits nuevos después de la aprobación: hace falta otra revisión.
 */
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
/** Archivos compartidos por todo el Portal: un cambio de main en ellos puede afectar a cualquier historia. */
const SHARED = /^packages\/domain\/|\/db\/|executionPolicy|tokens\.css$|(^|\/)package(-lock)?\.json$|\/app\.ts$/;

export function revisionStatus(p: Process): RevisionStatus | null {
  const r = p.result; if (p.kind !== 'story_execution' || !r) return null;
  const pl = r.pipeline; const head = r.applied?.commit ?? null;
  const verdict = r.review?.verdict ?? (r.review ? (r.review.approve ? 'approved' : 'rejected') : null);
  const qaCommit = pl?.lastQaCommit ?? r.manifest?.reviewedCommit ?? null;
  const cand = r.integration?.state === 'candidate' && same(r.integration.commit, head) ? r.integration : null;
  const verifiedHead = !!r.applied && (pl?.config.commands ?? ['typecheck']).every(c => verificationsForApplied(r).some(v => v.command === c && v.exitCode === 0));
  const storyFiles = new Set([...(r.changes ?? []).filter(c => !c.error).map(c => c.path), ...(r.plan?.filesToChange ?? []), ...(r.plan?.filesToRead ?? []), ...(r.manifest?.deliverables ?? []).map(d => d.path)]);
  const overlap = cand ? cand.files.filter(f => storyFiles.has(f) || SHARED.test(f)) : [];
  const candidate = cand ? { commit: cand.commit!, previous: cand.previousCommit, target: cand.target, targetHead: cand.targetHead, resolvedBy: cand.resolvedBy, conflicts: cand.conflicts, overlap } : null;
  const state: RevisionStatus['qa']['state'] = !verdict ? 'not_run' : verdict === 'approved' ? 'approved' : verdict === 'rejected' ? 'rejected' : verdict === 'blocked_environment' ? 'blocked_environment' : 'inconclusive';
  let coverage: RevisionStatus['qa']['coverage'] = 'none'; let why = '';
  if (state === 'approved' && head) {
    if (same(qaCommit, head)) { coverage = 'direct'; why = `QA aprobó ${head}, el commit actual.`; }
    else if (gauntletReviewed(r.gauntlet, head)) { coverage = 'gauntlet'; why = `QA aprobó ${qaCommit ?? 'un commit anterior'} y el Evaluador Gauntlet re-evaluó ${head}.`; }
    else if (cand && same(cand.previousCommit, qaCommit) && cand.resolvedBy === 'git' && !cand.conflicts.length) {
      if (!verifiedHead) { coverage = 'superseded'; why = `QA aprobó ${qaCommit}; el candidato ${head} (con ${cand.target} incorporado, sin conflictos) aún no está verificado en el sandbox.`; }
      else if (overlap.length) { coverage = 'carried_with_overlap'; why = `QA aprobó ${qaCommit}; el candidato ${head} incorpora ${cand.target} sin conflictos y está verificado, pero ${cand.target} cambió archivos de la historia o compartidos (${overlap.slice(0, 4).join(', ')}): conviene que QA lo revise.`; }
      else { coverage = 'carried_clean_merge'; why = `QA aprobó ${qaCommit}; el candidato ${head} solo añade ${cand.target} (${cand.behindCount} commit(s), sin conflictos ni archivos de la historia) y está verificado en el sandbox.`; }
    }
    else if (cand && (cand.resolvedBy === 'agent' || cand.conflicts.length)) { coverage = 'superseded'; why = `QA aprobó ${qaCommit ?? 'un commit anterior'}; el candidato ${head} incluye ${cand.conflicts.length} conflicto(s) con ${cand.target} resueltos por ${cand.resolvedBy === 'agent' ? 'el agente' : 'git'} (${cand.conflicts.slice(0, 4).join(', ')}): QA no lo ha revisado.`; }
    else { coverage = 'superseded'; why = `QA aprobó ${qaCommit ?? 'un commit anterior'}; después hubo cambios (commit actual ${head}) que QA no ha revisado.`; }
  } else if (state === 'rejected') why = `QA rechazó ${qaCommit ?? head ?? 'la implementación'} con hallazgos.`;
  else if (state === 'inconclusive') why = `QA no pudo verificar ${qaCommit ?? head ?? 'la implementación'} con la evidencia disponible.`;
  else if (state === 'blocked_environment') why = 'QA no pudo evaluar: el entorno de verificación no estaba disponible.';
  else why = 'QA aún no ha revisado esta implementación.';
  const coversHead = coverage === 'direct' || coverage === 'gauntlet' || coverage === 'carried_clean_merge';
  return { head, qa: { state, commit: qaCommit, coverage, coversHead, why }, candidate, verifiedHead, merged: r.merged ? { commit: r.merged.commit, into: r.merged.into, mergedAt: r.merged.mergedAt } : null };
}

/** Texto corto de la etapa «Revisar los cambios y QA», siempre con el commit al que se refiere. */
export function reviewStageText(rev: RevisionStatus): string {
  const q = rev.qa;
  if (q.state === 'approved') return q.coverage === 'direct' ? `QA aprobó ${rev.head}` : q.coverage === 'gauntlet' ? `QA aprobó ${q.commit}; Gauntlet re-evaluó ${rev.head}` : q.coverage === 'carried_clean_merge' ? `QA aprobó ${q.commit}; el candidato ${rev.head} solo añade main` : `QA aprobó ${q.commit}; ${rev.head} sin revisar`;
  return q.state === 'rejected' ? `QA rechazó ${q.commit ?? rev.head ?? ''}`.trim() : q.state === 'inconclusive' ? `QA no pudo verificar ${q.commit ?? rev.head ?? ''}`.trim() : q.state === 'blocked_environment' ? 'QA sin entorno de verificación' : 'Sin revisión de QA';
}

/**
 * Versión de un proceso para DECIDIR (pestañas desactualizadas): cambia con lo que afecta a una decisión (estado, pausa y
 * su pregunta, commit aplicado, candidato, integración, rechazo, QA, Gauntlet, límites autorizados) y NO con el progreso
 * (pasos, llamada en curso, tokens, eventos), para no rechazar clics válidos mientras el equipo trabaja.
 */
export function processVersion(p: Process): string {
  const r = p.result; const pl = r?.pipeline;
  const key = JSON.stringify([p.status, p.supersededBy ?? null, p.budgetUsd, p.maxSubscriptionCalls ?? null, pl?.state ?? null, pl?.pauseKind ?? null, pl?.ownerRequest?.question ?? null, pl?.corrections ?? null, pl?.config.maxCorrections ?? null, pl?.config.maxSubscriptionCalls ?? null,
    r?.applied?.commit ?? null, r?.integration?.state ?? null, r?.integration?.commit ?? null, r?.merged?.commit ?? null, !!r?.rejected, r?.mergeError?.at ?? null, r?.review?.verdict ?? null, r?.gauntlet?.status ?? null, r?.planNoCode?.analysisProcessId ?? null, p.delegation?.opsApplied ? 1 : 0]);
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

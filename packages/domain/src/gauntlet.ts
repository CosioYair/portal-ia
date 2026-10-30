import type { AgentTemplate } from './types.ts';

/**
 * Evaluación Gauntlet (constructor ≠ crítico). Un Evaluador independiente, con contexto nuevo (sin la explicación del
 * constructor), compara el resultado REAL con los criterios de aceptación y la evidencia del sandbox, exige evidencia
 * para cada hallazgo y nombra la brecha más importante. El constructor corrige solo eso y se vuelve a evaluar.
 * Acotado: nunca hay un bucle sin límite (rondas, correcciones, presupuesto, sin progreso o ganancia marginal).
 *
 * Relación con lo existente (sin pagar dos revisiones iguales):
 *  1. Verificación determinista (sandbox, comprobación previa, evidencia de pruebas) — siempre, sin IA.
 *  2. QA (Especialista QA) — la puerta funcional de cada cambio, una vez por commit.
 *  3. Gauntlet — según el modo: evalúa criterio por criterio el commit que QA aprobó; tras una corrección suya, la
 *     re-evaluación es SOLO del Evaluador (QA no vuelve a revisar lo mismo; el sandbox sí se repite).
 *  4. Comprobación en ejecución — tras activar (Portal en marcha), como hasta ahora.
 *  5. Aceptación del propietario — siempre aparte: ni QA ni el Evaluador aceptan una historia.
 */
/**
 * `auto` (por defecto desde v0.16): la intensidad la decide el Portal sin IA al autorizar cada tarea (tamaño, riesgo,
 * historial y si hay Evaluador), con los motivos a la vista; se guarda el modo resuelto. Nunca llega `auto` a ejecutarse.
 */
export type GauntletMode = 'off' | 'standard' | 'deep' | 'auto';
export interface GauntletConfig {
  mode: GauntletMode;
  /**
   * Correcciones dirigidas por el Evaluador AUTORIZADAS (un límite de recursos, no la definición de calidad): con
   * progreso y margen se sigue; al llegar al límite con progreso, se pausa y puedes conceder más (hasta el tope duro).
   */
  maxRounds: number;
  /** Si el modo salió de `auto`: por qué (señales sin IA). */
  auto?: { reason: string; signals: string[] } | null;
}
/** Correcciones autorizadas por defecto en cada modo y tope duro por proceso (ni la continuación automática lo supera). */
export const GAUNTLET_LIMITS = { standard: 2, deepDefault: 3, deep: 6 } as const;
export const DEFAULT_GAUNTLET: GauntletConfig = { mode: 'auto', maxRounds: 0 };

export function normalizeGauntlet(g: Partial<GauntletConfig> | null | undefined): GauntletConfig {
  const mode: GauntletMode = g?.mode === 'standard' || g?.mode === 'deep' || g?.mode === 'auto' ? g.mode : 'off';
  const auto = g?.auto ? { reason: String(g.auto.reason ?? ''), signals: (g.auto.signals ?? []).map(String) } : undefined;
  if (mode === 'off' || mode === 'auto') return { mode, maxRounds: 0, ...(auto ? { auto } : {}) };
  const n = Math.floor(Number(g?.maxRounds));
  const def = mode === 'standard' ? GAUNTLET_LIMITS.standard : GAUNTLET_LIMITS.deepDefault;
  return { mode, maxRounds: Number.isFinite(n) && n > 0 ? Math.min(GAUNTLET_LIMITS.deep, Math.max(1, n)) : def, ...(auto ? { auto } : {}) };
}

/**
 * Resuelve `auto` con la recomendación (determinista). Cualquier otro modo se respeta tal cual. Lo resuelto se guarda en
 * la autorización: la ejecución nunca ve `auto`.
 */
export function resolveGauntlet(cfg: GauntletConfig, input: Parameters<typeof recommendGauntlet>[0]): GauntletConfig {
  if (cfg.mode !== 'auto') return cfg;
  const rec = recommendGauntlet(input);
  return { ...normalizeGauntlet({ mode: rec.mode }), auto: { reason: rec.reason, signals: rec.signals } };
}

export type CriterionStatus = 'met' | 'partial' | 'unmet' | 'unverifiable';
export interface GauntletCriterion { criterion: string; status: CriterionStatus; evidence: string }
export type GauntletSeverity = 'blocking' | 'major' | 'minor';
export interface GauntletFinding {
  severity: GauntletSeverity;
  /** Criterio de aceptación que falla (texto o número), si aplica. */
  criterion: string | null;
  text: string;
  file: string | null;
  evidence: string | null;
  expected: string | null;
  /** Sin evidencia concreta: se registra, pero no motiva una corrección. */
  unsupported?: boolean;
}
export interface GauntletRound {
  round: number;
  commit: string | null;
  at: string;
  evaluatorId: string;
  evaluatorName: string;
  stepId: string | null;
  verdict: 'pass' | 'gaps' | 'cannot_evaluate';
  criteria: GauntletCriterion[];
  findings: GauntletFinding[];
  largestGap: string | null;
  anotherRoundWorthIt: boolean;
  limitations: string[];
  /** Lo que decidió el Portal con esta ronda (determinista). */
  decision: 'pass' | 'correct' | 'stop';
  /** La misma brecha se repitió sin progreso: diagnóstico de otro especialista (ni el constructor ni el Evaluador) que guía la corrección. */
  diagnosis?: { agentId: string; agentName: string; signature: string; text: string; stepId: string | null } | null;
  reason: string;
  costUsd: number;
  tokensIn: number;
}
export interface GauntletState {
  mode: GauntletMode;
  maxRounds: number;
  rounds: GauntletRound[];
  /** passed: sin hallazgos que corregir · passed_with_findings: quedan hallazgos no bloqueantes documentados ·
   *  stopped: se detuvo con hallazgos bloqueantes (decide el propietario) · skipped: no se pudo aplicar (sin Evaluador…) ·
   *  waived: el propietario siguió sin más evaluación (las brechas quedan documentadas). */
  status: 'pending' | 'passed' | 'passed_with_findings' | 'stopped' | 'skipped' | 'waived';
  reason: string | null;
  /** Hay una corrección del Evaluador aplicada: el siguiente commit lo re-evalúa SOLO el Evaluador (no QA otra vez). */
  pendingReeval?: boolean;
  /** Commit que QA aprobó antes de la primera corrección del Evaluador. */
  qaApprovedCommit?: string | null;
  /** Gauntlet en la planificación: revisión independiente del plan ANTES de pagar la implementación. */
  planReview?: PlanReviewState | null;
}

/** Brecha de un plan técnico (con la misma puerta de evidencia que las del resultado). */
export interface PlanReviewGap { severity: GauntletSeverity; criterion: string | null; text: string; evidence: string | null; fix: string | null; unsupported?: boolean }
export interface PlanReviewRound {
  round: number; at: string; reviewerId: string; reviewerName: string; stepId: string | null;
  verdict: 'approve' | 'revise' | 'cannot_review';
  /** Cobertura de cada criterio de aceptación por el plan, con la parte del plan que lo respalda. */
  coverage: { criterion: string; covered: 'yes' | 'partial' | 'no'; evidence: string }[];
  gaps: PlanReviewGap[];
  decision: 'proceed' | 'revise' | 'pause';
  reason: string;
}
export interface PlanReviewState { rounds: PlanReviewRound[]; status: 'pending' | 'approved' | 'approved_with_gaps' | 'paused' | 'skipped'; reason: string | null }

/**
 * ¿Merece revisión independiente este plan? Adaptativo: en «profundo», siempre; en «estándar», solo si el plan es de
 * cierto alcance (3+ archivos o 3+ criterios); una tarea pequeña no paga una revisión que no cambiaría nada.
 */
export function planReviewWanted(cfg: GauntletConfig, plan: { filesToChange: string[]; acceptance: string[] }): boolean {
  if (cfg.mode === 'deep') return true;
  if (cfg.mode === 'standard') return plan.filesToChange.length >= 3 || plan.acceptance.length >= 3;
  return false;
}
const PLAN_SEV: Record<string, GauntletSeverity> = { blocking: 'blocking', major: 'major', minor: 'minor' };
/** Salida del revisor del plan con la puerta de evidencia: sin cita concreta del plan o del criterio, no motiva revisión. */
export function parsePlanReview(text: string): Pick<PlanReviewRound, 'verdict' | 'coverage' | 'gaps'> {
  let j: any = null;
  try { j = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { j = JSON.parse(m[0]); } catch { j = null; } } }
  if (!j || typeof j !== 'object' || !['approve', 'revise', 'cannot_review'].includes(j.verdict)) return { verdict: 'cannot_review', coverage: [], gaps: [] };
  const gaps: PlanReviewGap[] = (Array.isArray(j.gaps) ? j.gaps : []).slice(0, 10).map((g: any) => {
    const evidence = typeof g?.evidence === 'string' && g.evidence.trim().length >= 6 ? g.evidence.trim().slice(0, 1000) : null;
    return { severity: PLAN_SEV[g?.severity] ?? 'minor', criterion: typeof g?.criterion === 'string' ? g.criterion.slice(0, 300) : null, text: String(g?.text ?? '').slice(0, 600), evidence, fix: typeof g?.fix === 'string' ? g.fix.slice(0, 600) : null, unsupported: !evidence };
  }).filter((g: PlanReviewGap) => g.text.trim());
  const coverage = (Array.isArray(j.coverage) ? j.coverage : []).slice(0, 30).map((c: any) => ({ criterion: String(c?.criterion ?? '').slice(0, 400), covered: ['yes', 'partial', 'no'].includes(c?.covered) ? c.covered : 'no', evidence: String(c?.evidence ?? '').slice(0, 600) }));
  let verdict: PlanReviewRound['verdict'] = j.verdict;
  if (verdict === 'approve' && gaps.some(g => g.severity === 'blocking' && !g.unsupported)) verdict = 'revise';
  return { verdict, coverage, gaps };
}
/**
 * Qué hacer con la revisión del plan (determinista): seguir, revisar el plan (el planificador corrige SOLO las brechas
 * con evidencia) o pausar ANTES de implementar si queda una brecha bloqueante. Una nueva revisión solo con progreso
 * estricto (menos brechas graves y no las mismas); el margen es el del modo (1 revisión en estándar, 2 en profundo).
 */
export function decidePlanReview(cfg: GauntletConfig, rounds: Pick<PlanReviewRound, 'verdict' | 'gaps' | 'decision'>[]): { decision: PlanReviewRound['decision']; status: PlanReviewState['status']; reason: string } {
  const last = rounds.at(-1); if (!last) return { decision: 'proceed', status: 'skipped', reason: 'Sin revisión del plan.' };
  if (last.verdict === 'cannot_review') return { decision: 'proceed', status: 'approved_with_gaps', reason: 'El revisor no pudo revisar el plan con lo disponible: se sigue y queda como limitación.' };
  const severe = (r: Pick<PlanReviewRound, 'gaps'>) => r.gaps.filter(g => !g.unsupported && g.severity !== 'minor');
  const s1 = severe(last);
  if (!s1.length) return { decision: 'proceed', status: last.gaps.length ? 'approved_with_gaps' : 'approved', reason: last.gaps.length ? 'Plan aprobado: lo pendiente es menor o sin evidencia y queda documentado.' : 'Plan aprobado: cubre los criterios de aceptación.' };
  const blocking = s1.some(g => g.severity === 'blocking');
  const stop = (why: string) => blocking
    ? { decision: 'pause' as const, status: 'paused' as const, reason: `${why} Queda una brecha bloqueante en el plan: decides tú ANTES de pagar la implementación (${s1[0].text}).` }
    : { decision: 'proceed' as const, status: 'approved_with_gaps' as const, reason: `${why} Lo pendiente (no bloqueante) queda documentado: ${s1[0].text}` };
  const prev = rounds.at(-2);
  if (prev && prev.decision === 'revise') {
    const sig = (gs: PlanReviewGap[]) => gs.map(g => g.text.toLowerCase().replace(/\s+/g, ' ').trim()).sort().join('|');
    const s0 = severe(prev);
    if (!(s1.length < s0.length && sig(s1) !== sig(s0))) return stop('La revisión del plan no progresó (mismas brechas graves): no se insiste.');
  }
  const max = cfg.mode === 'deep' ? 2 : 1;
  if (rounds.filter(r => r.decision === 'revise').length >= max) return stop(`Se usó el margen de revisiones del plan del modo ${cfg.mode} (${max}).`);
  return { decision: 'revise', status: 'pending', reason: `Revisión del plan con evidencia: ${s1[0].text}` };
}

/** Salida estructurada que se pide al Evaluador. */
export const GAUNTLET_SCHEMA = {
  name: 'gauntlet_evaluation',
  description: 'Evaluación independiente del resultado frente a los criterios de aceptación, con evidencia.',
  schema: {
    type: 'object', additionalProperties: false,
    required: ['verdict', 'criteria', 'findings', 'largestGap', 'anotherRoundWorthIt', 'limitations'],
    properties: {
      verdict: { type: 'string', enum: ['pass', 'gaps', 'cannot_evaluate'] },
      criteria: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['criterion', 'status', 'evidence'], properties: { criterion: { type: 'string' }, status: { type: 'string', enum: ['met', 'partial', 'unmet', 'unverifiable'] }, evidence: { type: 'string' } } } },
      findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'criterion', 'text', 'file', 'evidence', 'expected'], properties: { severity: { type: 'string', enum: ['blocking', 'major', 'minor'] }, criterion: { type: ['string', 'null'] }, text: { type: 'string' }, file: { type: ['string', 'null'] }, evidence: { type: ['string', 'null'] }, expected: { type: ['string', 'null'] } } } },
      largestGap: { type: ['string', 'null'] },
      anotherRoundWorthIt: { type: 'boolean' },
      limitations: { type: 'array', items: { type: 'string' } }
    }
  }
} as const;

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** Huella de un hallazgo (archivo + inicio del texto normalizado): la misma brecha entre rondas y procesos. */
export function findingKey(f: Pick<GauntletFinding, 'file' | 'text'>): string {
  return `${f.file ?? '*'}:${norm(f.text).split(' ').slice(0, 8).join(' ')}`;
}
/** Huella de lo que hay que corregir (archivo + texto normalizado de bloqueantes/mayores). */
export function gauntletSignature(findings: GauntletFinding[]): string {
  return findings.filter(f => !f.unsupported && f.severity !== 'minor').map(findingKey).sort().join('|');
}

/**
 * Decisión determinista tras cada evaluación. `correctionsLeft`: correcciones autorizadas que quedan en el proceso.
 * Pasa si no hay nada que corregir con evidencia; corrige la brecha más importante si queda margen; se detiene (con lo
 * pendiente documentado) por límite de rondas, sin progreso, ganancia marginal o sin correcciones autorizadas.
 */
export function decideGauntlet(cfg: GauntletConfig, rounds: (Pick<GauntletRound, 'verdict' | 'findings' | 'anotherRoundWorthIt' | 'decision'> & Partial<Pick<GauntletRound, 'criteria'>>)[], correctionsLeft: number, opts: { ownerGranted?: boolean; diagnosed?: string[] } = {}): { decision: 'pass' | 'correct' | 'stop' | 'diagnose'; reason: string; toFix: GauntletFinding[]; status: GauntletState['status'] } {
  const last = rounds.at(-1);
  if (!last) return { decision: 'stop', reason: 'Sin evaluación.', toFix: [], status: 'skipped' };
  if (last.verdict === 'cannot_evaluate') return { decision: 'stop', reason: 'El Evaluador no pudo evaluar con la evidencia disponible (queda como limitación para tu revisión).', toFix: [], status: 'passed_with_findings' };
  const rank = { blocking: 0, major: 1, minor: 2 } as const;
  const toFix = last.findings.filter(f => !f.unsupported && f.severity !== 'minor').sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 3);
  if (!toFix.length) return { decision: 'pass', reason: last.findings.length ? 'Sin brechas que corregir con evidencia: los hallazgos restantes son menores o sin evidencia y quedan documentados.' : 'Todos los criterios se cumplen con evidencia.', toFix: [], status: last.findings.length ? 'passed_with_findings' : 'passed' };
  const blocking = toFix.some(f => f.severity === 'blocking');
  const stopStatus: GauntletState['status'] = blocking ? 'stopped' : 'passed_with_findings';
  const corrections = rounds.filter(r => r.decision === 'correct').length;
  const prev = rounds.at(-2);
  // Progreso medible tras una corrección: más criterios cumplidos con evidencia o menos brechas bloqueantes/mayores. Las
  // dos medidas tienen suelo y techo, así que no puede alternar sin fin; la misma brecha (por su huella) tampoco cuenta.
  const progress = !prev || prev.decision !== 'correct' ? null : progressBetween(prev, last);
  // Si el propietario concedió otra ronda tras una detención, decide él: no se aplican «sin progreso» ni «no compensa».
  if (!opts.ownerGranted && progress && !progress.improved && prev && gauntletSignature(prev.findings) === gauntletSignature(last.findings)
    && !(opts.diagnosed ?? []).includes(gauntletSignature(last.findings)) && corrections < cfg.maxRounds && correctionsLeft > 0) {
    return { decision: 'diagnose', reason: `La misma brecha sin progreso tras la corrección (${progress.detail}): otro especialista diagnostica la causa antes de intentarlo de otra forma.`, toFix, status: 'pending' };
  }
  if (!opts.ownerGranted && progress && !progress.improved) return { decision: 'stop', reason: `Sin progreso tras la corrección (${progress.detail}): no se repite la misma estrategia. Replantea el diagnóstico (consulta a otro especialista o cambia el enfoque) o decide tú.`, toFix, status: stopStatus };
  if (corrections >= cfg.maxRounds) return { decision: 'stop', reason: `Se usaron las ${cfg.maxRounds} corrección(es) dirigida(s) autorizadas (modo ${cfg.mode})${progress?.improved ? ` con progreso (${progress.detail})` : ''}: lo pendiente queda documentado; puedes conceder más rondas (hasta ${GAUNTLET_LIMITS.deep}).`, toFix, status: stopStatus };
  if (!opts.ownerGranted && !blocking && !last.anotherRoundWorthIt) return { decision: 'stop', reason: 'El Evaluador estima que otra ronda no compensa: lo pendiente es de alcance menor y queda documentado.', toFix, status: 'passed_with_findings' };
  if (correctionsLeft <= 0) return { decision: 'stop', reason: 'No quedan correcciones autorizadas en este proceso.', toFix, status: stopStatus };
  return { decision: 'correct', reason: `Corrección dirigida de la brecha más importante: ${toFix[0].text}`, toFix, status: 'pending' };
}

/** Progreso entre dos rondas: estrictamente más criterios cumplidos o estrictamente menos brechas graves (con evidencia). */
export function progressBetween(prev: Pick<GauntletRound, 'findings'> & Partial<Pick<GauntletRound, 'criteria'>>, last: Pick<GauntletRound, 'findings'> & Partial<Pick<GauntletRound, 'criteria'>>): { improved: boolean; detail: string } {
  const met = (r: Partial<Pick<GauntletRound, 'criteria'>>) => (r.criteria ?? []).filter(c => c.status === 'met').length;
  const severe = (r: Pick<GauntletRound, 'findings'>) => r.findings.filter(f => !f.unsupported && f.severity !== 'minor').length;
  const same = gauntletSignature(prev.findings) === gauntletSignature(last.findings);
  const m0 = met(prev); const m1 = met(last); const s0 = severe(prev); const s1 = severe(last);
  // Progreso estricto y sin retrocesos: mejora una medida y la otra no empeora (así no puede alternar entre las dos).
  const improved = !same && m1 >= m0 && s1 <= s0 && (m1 > m0 || s1 < s0);
  return { improved, detail: `criterios cumplidos ${m0} → ${m1}, brechas graves ${s0} → ${s1}${same ? ', la misma brecha' : ''}` };
}

/**
 * El commit actual es el que el Evaluador re-evaluó tras su propia corrección (QA aprobó el anterior y no repite la
 * revisión): cuenta como revisado igual que si QA lo hubiera aprobado.
 */
export function gauntletReviewed(g: GauntletState | null | undefined, commit: string | null | undefined): boolean {
  const last = g?.rounds.at(-1);
  return !!g && !!commit && !!last && last.commit === commit && (g.status === 'passed' || g.status === 'passed_with_findings' || g.status === 'waived');
}

export interface GauntletRecommendation { mode: GauntletMode; reason: string; signals: string[] }
const RISK = /seguridad|autoriz|permis|credencial|clave|secreto|presupuesto|pago|factur|datos|migraci|borrar|elimin|git|integra|merge|reinici|organiza|agente|privad/i;
const RISK_G = new RegExp(RISK.source, 'gi');
/**
 * Modo recomendado (determinista, sin IA): tareas pequeñas y de bajo riesgo bastan con las comprobaciones deterministas
 * y QA; las de riesgo o con fallos previos merecen más rondas. Sin Evaluador en el equipo, no aplica.
 */
export function recommendGauntlet(input: { hasEvaluator: boolean; estimate: 'S' | 'M' | 'L' | null; text: string; iterations: number; qaRejections: number }): GauntletRecommendation {
  const signals: string[] = [];
  // Áreas de riesgo DISTINTAS mencionadas (una palabra suelta como «agente» no basta para el modo profundo).
  const hits = Array.from(new Set((input.text.match(RISK_G) ?? []).map(w => w.toLowerCase().slice(0, 6))));
  if (hits.length) signals.push(`toca ${hits.length} área(s) de riesgo (${hits.slice(0, 4).join(', ')})`);
  if (input.estimate === 'L') signals.push('tamaño grande');
  if (input.estimate === null) signals.push('tamaño sin estimar (como mucho, estándar)');
  if (input.iterations > 1) signals.push(`${input.iterations - 1} iteración(es) previas`);
  if (input.qaRejections > 0) signals.push(`${input.qaRejections} rechazo(s) previos de QA`);
  if (!input.hasEvaluator) return { mode: 'off', reason: 'No hay un Evaluador Gauntlet en el equipo del proyecto: se usa la verificación y QA de siempre.', signals };
  if ((input.estimate === 'L' && hits.length >= 1) || hits.length >= 3 || input.iterations > 3 || input.qaRejections > 1) return { mode: 'deep', reason: 'Tarea grande con riesgo, varias áreas de riesgo o fallos repetidos: más rondas, acotadas por progreso.', signals };
  if (input.estimate === 'S' && !hits.length && input.iterations <= 1 && !input.qaRejections) return { mode: 'off', reason: 'Tarea pequeña y de bajo riesgo: las comprobaciones deterministas y QA bastan; no se paga otra revisión.', signals };
  return { mode: 'standard', reason: 'Una evaluación independiente, con una corrección dirigida si hace falta.', signals };
}

/** Sobrecoste máximo del modo (llamadas del Evaluador y correcciones dirigidas), para mostrarlo ANTES de autorizar. */
export function gauntletOverhead(cfg: GauntletConfig): { evaluations: { min: number; max: number }; corrections: { min: number; max: number } } {
  if (cfg.mode === 'off') return { evaluations: { min: 0, max: 0 }, corrections: { min: 0, max: 0 } };
  // Sin resolver (p. ej. un lote antes de ver cada historia): de nada a «profundo» según la historia.
  if (cfg.mode === 'auto') return { evaluations: { min: 0, max: GAUNTLET_LIMITS.deep + 1 + 3 + 1 }, corrections: { min: 0, max: GAUNTLET_LIMITS.deep + 2 } };
  // Máximo honesto: evaluaciones del resultado + revisiones del plan (1 + sus revisiones) + un diagnóstico independiente;
  // correcciones dirigidas + revisiones del plan (se ponderan como una corrección: estimación por encima, nunca por debajo).
  const planRevisions = cfg.mode === 'deep' ? 2 : 1;
  return { evaluations: { min: 1, max: cfg.maxRounds + 1 + planRevisions + 1 + 1 }, corrections: { min: 0, max: cfg.maxRounds + planRevisions } };
}

/**
 * Plantilla PROPUESTA del Evaluador Gauntlet: no se crea en ningún proyecto por sí sola. El propietario la aprueba como
 * cambio organizativo (se crea entonces en el proyecto, versionada, con su capacidad y su jefe).
 */
export const GAUNTLET_TEMPLATE: AgentTemplate = {
  id: 'tpl.project.gauntlet@1', key: 'pj-gauntlet', scope: 'project', name: 'Evaluador Gauntlet', initials: 'EG',
  role: 'Evaluación independiente de entregables',
  specialization: 'Evalúa de forma independiente, con contexto nuevo y sin la explicación del constructor, si un entregable cumple sus criterios de aceptación; exige evidencia para cada hallazgo y nombra la brecha más importante. Nunca implementa lo que evalúa.',
  responsibilities: [
    'Evaluar el resultado real frente a los criterios de aceptación explícitos.',
    'Exigir evidencia (diff, pruebas, verificación, capturas) para cada hallazgo y detectar afirmaciones de éxito sin respaldo.',
    'Identificar la brecha más importante y proponer una corrección dirigida.',
    'Decidir si otra ronda aporta valor y dejar un informe de calidad auditable.'
  ],
  reportsTo: 'pj-coordinador', supervises: [], collaborates: ['pj-qa'], tier: 'mid', fallbackTier: 'low', effort: 'medium',
  tools: { read_repo: true }, knowledge: { objectives: true, context: true, repo: true, history: false },
  evaluation: ['Brechas reales detectadas antes de la aceptación del propietario.', 'Hallazgos con evidencia (sin falsos positivos).', 'Rondas necesarias por historia.'],
  monthlyLimitUsd: 20, perTaskAuthUsd: 2, capabilities: ['evaluar_gauntlet']
};
/** Plantillas preparadas para revisión organizativa (catálogo versionado), que NO se crean al iniciar un proyecto. */
export const PROPOSED_TEMPLATES: AgentTemplate[] = [GAUNTLET_TEMPLATE];

/** Lo que el propietario ve antes de autorizar una historia: modo del proyecto, recomendación y sobrecoste. */
export interface GauntletAdvice {
  projectDefault: GauntletConfig;
  recommended: GauntletRecommendation;
  evaluator: { id: string; name: string; model: string } | null;
  overhead: { standard: ReturnType<typeof gauntletOverhead>; deep: ReturnType<typeof gauntletOverhead> };
}
export interface GauntletProjectInfo {
  config: GauntletConfig;
  evaluator: { id: string; name: string; model: string; effort: string | null; backend: string } | null;
  template: Pick<AgentTemplate, 'key' | 'name' | 'role' | 'specialization' | 'responsibilities' | 'reportsTo' | 'tools' | 'capabilities' | 'evaluation'>;
}

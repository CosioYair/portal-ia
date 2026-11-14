import fs from 'node:fs';
import path from 'node:path';
import { gauntletReviewed, verificationPassed, verificationsForApplied, type Process } from '@portal-ia/domain';
import { backlogRepo } from '../db/workspace.ts';
import { assignmentsRepo } from '../db/assignments.ts';
import { revisionStatus } from './revision.ts';
import { DEPS_MISSING_EXIT } from './sandbox.ts';
import { visualGate } from './visualCheck.ts';
import { assignmentState, storyState, type WorkItem } from './work.ts';

/**
 * Portal IA 3 · LA revisión de un trabajo, lista para leerse sin abrir archivos ni saber de git: qué se pidió, qué cambió,
 * si las comprobaciones pasaron, qué dijeron la revisión de calidad y la evaluación independiente, qué capturas hay, qué
 * pruebas existentes se tocaron, qué conviene probar y qué límites quedan. Una sola fuente para historias y encargos.
 *
 * Regla de oro: «listo» se dice de la VERSIÓN ACTUAL. Todo se decide con las mismas reglas por versión que ya usa el flujo
 * (verificationsForApplied, revisionStatus, gauntletReviewed): una aprobación o una prueba en verde de una versión anterior
 * no cuenta, y lo que no se evaluó se dice «no se hizo», nunca «superado». El estado es el mismo que enseña «Trabajo».
 * Solo lectura, sin IA. Lo técnico va aparte, en `technical`.
 */
export type CheckStatus = 'ok' | 'ok_baseline' | 'fail' | 'not_run' | 'unavailable';
export interface ReviewCheck { key: string; label: string; status: CheckStatus; detail: string }
export interface ReviewFinding { source: 'qa' | 'gauntlet'; severity: 'alta' | 'media' | 'baja'; text: string; where: string | null; /** Sigue impidiendo aceptar (no es una simple observación). */ blocking: boolean }
export interface ReviewShot { route: string; width: number; file: string; overflow: boolean; violations: number }
export type ReviewPhase = 'ready' | 'not_ready' | 'integrated' | 'closed' | 'discarded';
export interface ReviewView {
  processId: string; code: string | null; title: string; kind: 'story' | 'assignment' | 'other';
  state: WorkItem['state'];
  phase: ReviewPhase;
  /** Una frase: en qué punto está y qué toca. */
  headline: string;
  ask: string;
  criteria: string[];
  /** Lo que cambia para quien usa el producto, escrito por el equipo PARA el propietario (null si no lo dejaron). */
  whatChanged: string | null;
  files: { path: string; change: 'nuevo' | 'modificado' | 'eliminado'; lines: number }[];
  checks: ReviewCheck[];
  tests: { total: number; passed: number; failed: number } | null;
  findings: ReviewFinding[];
  qa: { verdict: 'approved' | 'outdated' | 'rejected' | 'inconclusive' | 'none'; note: string };
  gauntlet: { verdict: 'passed' | 'pending' | 'gaps' | 'skipped' | 'waived' | 'off'; note: string };
  testUpdates: { path: string; reason: string; proven: boolean }[];
  visual: { required: boolean; ok: boolean; note: string; shots: ReviewShot[] };
  toTest: string[];
  limitations: string[];
  verdict: { ready: boolean; missing: string[] };
  technical: { branch: string | null; commit: string | null; integratedInto: string | null; integratedCommit: string | null };
}

const CHECK_LABEL: Record<string, string> = { typecheck: 'El código es coherente (tipos)', test: 'Las pruebas automáticas pasan', build: 'El producto se construye' };
const SEV: Record<string, ReviewFinding['severity']> = { alta: 'alta', media: 'media', baja: 'baja', blocking: 'alta', major: 'media', minor: 'baja', high: 'alta', medium: 'media', low: 'baja' };
const clip = (s: string | null | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const lineCount = (d: string | null | undefined) => (d ? d.split('\n').filter(l => /^[+-](?![+-])/.test(l)).length : 0);

export function reviewOf(slug: string, p: Process): ReviewView {
  const r = p.result ?? ({} as NonNullable<Process['result']>);
  const item = p.backlogItemId ? backlogRepo(slug).get(p.backlogItemId) : undefined;
  const asg = p.assignmentId ? assignmentsRepo(slug).get(p.assignmentId) : undefined;
  // El mismo estado que «Trabajo» (historia o encargo): nunca dos nombres para lo mismo.
  const state = item ? storyState(item, p) : asg ? assignmentState(asg, p) : storyState({ status: 'review' }, p);
  const applied = r.applied?.commit ?? null;
  const commands: string[] = r.pipeline?.config?.commands ?? ['typecheck'];
  // Solo las verificaciones de la versión aplicada (por commit; las antiguas sin commit, por su hora).
  const runs = verificationsForApplied(r);
  const lastOf = (c: string) => runs.filter(v => v.command === c).at(-1);
  const checks: ReviewCheck[] = commands.map(c => {
    const v = lastOf(c); const label = CHECK_LABEL[c] ?? c;
    if (!v) return { key: c, label, status: 'not_run', detail: 'Aún no se ha comprobado sobre la versión actual.' };
    if (v.isolation === 'unavailable') return { key: c, label, status: 'unavailable', detail: 'No se pudo comprobar: el entorno aislado no estaba disponible. No es un fallo del trabajo.' };
    if (v.exitCode === null) return { key: c, label, status: 'unavailable', detail: 'La comprobación no terminó (se interrumpió o agotó su plazo). No se sabe si pasa.' };
    if (v.exitCode === DEPS_MISSING_EXIT) return { key: c, label, status: 'unavailable', detail: 'Faltan dependencias en el entorno aislado: no es un fallo del trabajo.' };
    if (v.exitCode === 0) return { key: c, label, status: 'ok', detail: 'Comprobado en el entorno aislado sobre la versión actual.' };
    if (verificationPassed(v)) return { key: c, label, status: 'ok_baseline', detail: 'Lo único que falla ya fallaba antes de este trabajo (no lo causó).' };
    const n = v.triage && !v.triage.unavailable ? v.triage.introduced.length + v.triage.changed.length : v.tests?.failed ?? 0;
    return { key: c, label, status: 'fail', detail: n ? `${n} comprobación(es) fallan por este trabajo.` : 'Falla en el entorno aislado.' };
  });
  const t = lastOf('test')?.tests;

  // Revisión de calidad: la aprobación cuenta solo si cubre la versión actual.
  const rev = revisionStatus(p);
  const qa: ReviewView['qa'] = !rev || rev.qa.state === 'not_run' ? { verdict: 'none', note: 'Aún no se ha revisado.' }
    : rev.qa.state === 'approved' ? (rev.qa.coversHead ? { verdict: 'approved', note: 'Aprobada sobre la versión actual.' } : { verdict: 'outdated', note: 'Se aprobó una versión anterior; la actual tiene cambios que no se han revisado.' })
    : rev.qa.state === 'rejected' ? { verdict: 'rejected', note: 'Pidió cambios.' }
    : { verdict: 'inconclusive', note: rev.qa.state === 'blocked_environment' ? 'No pudo evaluar: el entorno de verificación no estaba disponible.' : 'No pudo concluir con la evidencia disponible.' };

  // Evaluación independiente: «superada» solo si evaluó ESTA versión; lo que no se hizo se dice.
  const g = r.gauntlet; const lastRound = g?.rounds?.at(-1);
  const openGaps = (lastRound?.findings ?? []).filter(f => !f.unsupported && f.severity !== 'minor');
  const gauntlet: ReviewView['gauntlet'] = !g || g.mode === 'off' ? { verdict: 'off', note: '' }
    : g.status === 'skipped' ? { verdict: 'skipped', note: 'No se hizo: no había un evaluador independiente disponible.' }
    : g.status === 'waived' ? { verdict: 'waived', note: 'Decidiste continuar con puntos abiertos, que quedan anotados.' }
    : (g.status === 'passed' || g.status === 'passed_with_findings') && gauntletReviewed(g, applied) ? { verdict: 'passed', note: g.status === 'passed_with_findings' ? 'Superada, con observaciones.' : 'Superada sobre la versión actual.' }
    : g.status === 'stopped' || openGaps.length ? { verdict: 'gaps', note: 'Dejó puntos sin resolver.' }
    : { verdict: 'pending', note: 'Aún no ha evaluado la versión actual.' };

  const findings: ReviewFinding[] = [];
  for (const f of r.review?.findings ?? []) findings.push({ source: 'qa', severity: SEV[String(f.severity)] ?? 'media', text: clip(f.text, 400), where: f.file ?? null, blocking: qa.verdict === 'rejected' });
  for (const f of lastRound?.findings ?? []) if (!f.unsupported) findings.push({ source: 'gauntlet', severity: SEV[String(f.severity)] ?? 'media', text: clip(f.text, 400), where: f.file ?? null, blocking: gauntlet.verdict === 'gaps' && f.severity !== 'minor' });

  // Comprobación visual: si no se puede saber y el trabajo toca pantallas, falta (nunca se da por buena a ciegas).
  const touchesWeb = (r.changes ?? []).some(c => !c.error && /^apps\/web\/src\//.test(c.path));
  let gate: ReturnType<typeof visualGate> | null = null; let gateFailed = false;
  try { gate = visualGate(slug, p); } catch { gateFailed = true; }
  const visualRequired = gate ? gate.required : gateFailed && touchesWeb;
  const visualOk = !!gate?.ok;
  const shots: ReviewShot[] = [];
  if (gate?.dir && gate.report) for (const x of gate.report.results ?? []) if (x.screenshot && fs.existsSync(path.join(gate.dir, path.basename(x.screenshot)))) shots.push({ route: x.route, width: x.width, file: path.basename(x.screenshot), overflow: !!x.overflow, violations: (x.violations ?? []).length });
  const visualNote = !visualRequired ? '' : visualOk ? 'Las pantallas se comprobaron en móvil, tableta y escritorio.'
    : shots.some(s => s.overflow || s.violations) ? 'La comprobación encontró pantallas que se desbordan o tienen problemas de accesibilidad.'
    : 'Aún no hay una comprobación visual de esta versión.';

  const proven = new Set((r.manifest?.units ?? []).flatMap(u => u.testUpdatable ?? []));
  const testUpdates = (r.manifest?.testUpdates ?? []).map(u => ({ path: u.path, reason: clip(u.reason, 300), proven: proven.has(u.path) }));

  const missing: string[] = [];
  const key = state.key as string;
  const closed = !state.open; const integrated = !closed && (key === 'integrated_unaccepted' || !!r.merged);
  if (!closed && !integrated) {
    if (!r.applied) missing.push('Aún no hay cambios preparados.');
    for (const c of checks) if (c.status !== 'ok' && c.status !== 'ok_baseline') missing.push(`${c.label}: ${c.detail}`);
    if (r.applied) {
      if (qa.verdict === 'rejected') missing.push('La revisión de calidad pidió cambios.');
      else if (qa.verdict === 'outdated') missing.push('La revisión de calidad es de una versión anterior: falta revisar la actual.');
      else if (qa.verdict === 'inconclusive') missing.push(`La revisión de calidad no concluyó. ${qa.note}`);
      else if (qa.verdict === 'none') missing.push('Falta la revisión de calidad.');
      if (gauntlet.verdict === 'gaps') missing.push('La evaluación independiente dejó puntos sin resolver.');
      else if (gauntlet.verdict === 'pending' && qa.verdict === 'approved') missing.push('Falta la evaluación independiente de la versión actual.');
      if (visualRequired && !visualOk) missing.push(visualNote);
    }
    // El estado manda: si el trabajo no figura como «listo para revisar», no está listo aunque no falte nada de lo anterior.
    if (!missing.length && key !== 'ready_for_review') missing.push(state.meaning);
  }
  const ready = !closed && !integrated && missing.length === 0;
  const phase: ReviewPhase = closed ? (key === 'accepted' ? 'closed' : 'discarded') : integrated ? 'integrated' : ready ? 'ready' : 'not_ready';
  const headline = phase === 'closed' ? 'Lo diste por bueno y está cerrado.'
    : phase === 'discarded' ? state.meaning
    : phase === 'integrated' ? 'Sus cambios ya están en tu proyecto. Pruébalo y acéptalo para cerrarlo.'
    : phase === 'ready' ? 'Está hecho y comprobado sobre la versión actual. Revísalo y decide.'
    : 'Todavía no está listo para aceptarse.';

  const limitations = [...(r.plan?.risks ?? []), ...(lastRound?.limitations ?? [])].map(x => clip(String(x), 300)).filter(Boolean);
  if (gauntlet.verdict === 'skipped' || gauntlet.verdict === 'waived') limitations.unshift(`Evaluación independiente: ${gauntlet.note}`);

  return {
    processId: p.id, code: item?.storyId ?? asg?.code ?? null, title: item?.title ?? asg?.title ?? p.title, kind: item ? 'story' : asg ? 'assignment' : 'other',
    state, phase, headline,
    ask: asg?.request || item?.description || item?.criterion || p.title,
    criteria: asg?.criteria?.length ? asg.criteria : item?.criterion ? [item.criterion] : (r.plan?.acceptance ?? []),
    whatChanged: r.userFacing?.trim() || null,
    files: (r.changes ?? []).filter(c => !c.error).map(c => ({ path: c.path, change: c.action === 'create' ? 'nuevo' as const : c.action === 'delete' ? 'eliminado' as const : 'modificado' as const, lines: lineCount(c.diff) })),
    checks, tests: t ? { total: t.total ?? 0, passed: t.passed ?? 0, failed: t.failed ?? 0 } : null,
    findings, qa, gauntlet, testUpdates,
    visual: { required: visualRequired, ok: visualOk, note: visualNote, shots },
    toTest: (r.manualTest?.steps ?? []).map(s => (typeof s === 'string' ? s : (s as { text?: string }).text ?? '')).filter(Boolean),
    limitations: limitations.slice(0, 12),
    verdict: { ready, missing },
    technical: { branch: r.applied?.branch ?? null, commit: applied, integratedInto: r.merged?.into ?? null, integratedCommit: r.merged?.commit ?? null }
  };
}

/** Ruta en disco de una captura de la comprobación visual de un proceso (solo PNG de SU carpeta de evidencia). */
export function reviewShotPath(slug: string, p: Process, file: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.png$/.test(file)) return null;
  let gate: ReturnType<typeof visualGate> | null = null;
  try { gate = visualGate(slug, p); } catch { return null; }
  if (!gate?.dir) return null;
  const abs = path.join(gate.dir, file);
  return path.dirname(path.resolve(abs)) === path.resolve(gate.dir) && fs.existsSync(abs) ? abs : null;
}

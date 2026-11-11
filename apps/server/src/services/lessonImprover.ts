import { DEFAULT_LESSON_AUTO_IMPROVE } from '@portal-ia/domain';
import type { Lesson, LessonAutoImproveAuthorization, LessonImprovement, LessonImprovementPendingItem, LessonImprovementReason } from '@portal-ia/domain';
import { settingsRepo } from '../db/platform.ts';
import { processesRepo, workspaceDb } from '../db/workspace.ts';
import { draftLesson, estimatePropose, lessonsRepo } from './lessons.ts';
import { syncLessonPracticesSafe } from './lessonPractices.ts';
import { monotonicNow } from '../clock.ts';

/**
 * EN-022 · Mejora automática de las lecciones. Hay un único camino para las aplicadas o validadas que reinciden en
 * IMPROVE_AFTER_TASKS o más tareas distintas y para las refutadas. Solo llama a un modelo dentro de la autorización
 * permanente que el propietario fija en Ajustes, y la llamada pasa por requirePolicy dentro de draftLesson. Sin esa
 * autorización, o con el tope agotado, no hay ninguna llamada y queda UNA mejora pendiente en Decisiones, que se
 * acepta con un clic. La versión nueva lleva source 'curator', la anterior queda obsoleta con enlace (parentId) y la
 * práctica llega sola a la plantilla y a los agentes (syncLessonPracticesSafe).
 */
export const IMPROVE_AFTER_TASKS = 2;
const now = monotonicNow;
const settingsKey = (slug: string) => `lesson_auto_improve:${slug}`;
const currentMonth = () => new Date().toISOString().slice(0, 7);
const asImprovement = (x: Record<string, unknown>) => x as unknown as LessonImprovement;
const inFlight = new Set<string>();

export type ImproveState = 'applied' | 'pending_decision' | 'skipped';
export interface ImproveResult { state: ImproveState; lesson: Lesson | null }

// ---------- Autorización permanente (Ajustes) ----------
export function getAutoImproveAuthorization(slug: string): LessonAutoImproveAuthorization {
  let raw: any = null;
  try { raw = JSON.parse(settingsRepo.get(settingsKey(slug)) ?? 'null'); } catch { raw = null; }
  const a: LessonAutoImproveAuthorization = { ...DEFAULT_LESSON_AUTO_IMPROVE, ...(raw ?? {}), usage: { ...DEFAULT_LESSON_AUTO_IMPROVE.usage, ...(raw?.usage ?? {}) } };
  if (a.usage.month !== currentMonth()) a.usage = { month: currentMonth(), calls: 0, usd: 0 };
  return a;
}

export function setAutoImproveAuthorization(slug: string, input: { enabled: boolean; monthlyCallCap: number; monthlyUsdCap: number }): LessonAutoImproveAuthorization {
  const ok = (n: number) => Number.isFinite(n) && n >= 0;
  if (!ok(input.monthlyCallCap) || !ok(input.monthlyUsdCap)) throw Object.assign(new Error('Los topes deben ser números mayores o iguales que 0.'), { statusCode: 400 });
  const cur = getAutoImproveAuthorization(slug);
  const next: LessonAutoImproveAuthorization = { ...cur, enabled: !!input.enabled, monthlyCallCap: Math.floor(input.monthlyCallCap), monthlyUsdCap: input.monthlyUsdCap, updatedAt: new Date().toISOString() };
  settingsRepo.set(settingsKey(slug), JSON.stringify(next));
  return next;
}

function saveUsage(slug: string, a: LessonAutoImproveAuthorization) { settingsRepo.set(settingsKey(slug), JSON.stringify(a)); }

/** Hay cupo: autorización activa y, en el mes, menos llamadas y USD que sus topes. */
export function canSpend(a: LessonAutoImproveAuthorization): boolean {
  return !!a.enabled && a.usage.calls < a.monthlyCallCap && a.usage.usd < a.monthlyUsdCap;
}

// ---------- Candidatas ----------
function reasonFor(l: Lesson): LessonImprovementReason | null {
  if (l.status === 'refuted') return 'refuted';
  if (l.status === 'validated' && (l.recurrenceProcesses?.length ?? 0) >= IMPROVE_AFTER_TASKS) return 'recurred';
  return null;
}

function taskCount(l: Lesson, reason: LessonImprovementReason): number {
  if (reason === 'recurred') return l.recurrenceProcesses?.length ?? 0;
  return new Set((l.proof ?? []).filter(p => p.result === 'recurred').map(p => p.processId)).size;
}

export function improvementCandidates(slug: string, projectId: string | null = null): { lesson: Lesson; reason: LessonImprovementReason }[] {
  const repo = lessonsRepo(slug);
  const out: { lesson: Lesson; reason: LessonImprovementReason }[] = [];
  for (const l of repo.list(projectId, null)) {
    const reason = reasonFor(l);
    if (!reason || l.improvement?.state === 'pending_decision' || repo.successorOf(l.id)) continue;
    out.push({ lesson: l, reason });
  }
  return out;
}

/** Evidencia acumulada para la redacción: texto vigente, motivo y lo que pasó en cada tarea. */
function accumulatedEvidence(slug: string, l: Lesson, reason: LessonImprovementReason): string {
  const procs = processesRepo(slug);
  const title = (pid: string) => { try { return procs.get(pid)?.title ?? pid; } catch { return pid; } };
  const pids = reason === 'recurred' ? (l.recurrenceProcesses ?? []) : Array.from(new Set((l.proof ?? []).filter(p => p.result === 'recurred').map(p => p.processId)));
  const detections = lessonsRepo(slug).list(l.projectId ?? null, null)
    .filter(x => x.id !== l.id && x.detector === l.detector && !!x.evidence.processId && pids.includes(x.evidence.processId))
    .slice(0, 6).map(x => `- ${x.title}: ${x.evidence.detail.slice(0, 300)}`);
  const lines = [
    `Lección vigente (versión ${l.version}): «${l.lessonText ?? ''}».`,
    reason === 'recurred' ? `El error reincidió con la lección inyectada en ${pids.length} tareas distintas: ${pids.map(title).join(' · ')}.` : `La lección quedó refutada: el error se repitió con ella presente en ${pids.length} tareas: ${pids.map(title).join(' · ')}.`,
    ...(l.proof ?? []).slice(-6).map(p => `- ${p.result === 'held' ? 'Se cumplió' : 'Reincidió'} en «${p.processTitle ?? p.processId}»: ${p.detail}`),
    ...(detections.length ? ['Detecciones en esas tareas:', ...detections] : []),
    'Redacta una versión MEJOR y más concreta de la lección que evite estas reincidencias.'
  ];
  return lines.join('\n').slice(0, 3500);
}

// ---------- Camino único ----------
/**
 * Mejora una lección. La decisión es síncrona y va dentro de un SAVEPOINT: vuelve a comprobar el estado y que no haya
 * sucesora; luego, o deja la mejora pendiente (0 llamadas), o reserva el cupo. Solo la llamada es asíncrona.
 * `explicit` = el clic «Aceptar mejora» en Decisiones: es una autorización explícita de UNA llamada.
 */
export async function improveLesson(slug: string, id: string, reason: LessonImprovementReason, opts: { explicit?: boolean } = {}): Promise<ImproveResult> {
  const repo = lessonsRepo(slug); const db = workspaceDb(slug); const flightKey = `${slug}:${id}`;
  let decision: 'call' | 'pending' | 'skip' = 'skip'; let l: Lesson | undefined; let tasks = 0; let reserved = false;
  db.exec('SAVEPOINT lesson_improve');
  try {
    l = repo.get(id);
    const valid = !!l && reasonFor(l) === reason && !repo.successorOf(id) && !inFlight.has(flightKey) && (opts.explicit || l.improvement?.state !== 'pending_decision');
    if (l && valid) {
      tasks = taskCount(l, reason);
      if (opts.explicit) decision = 'call';
      else {
        const a = getAutoImproveAuthorization(slug);
        if (canSpend(a)) { a.usage.calls += 1; saveUsage(slug, a); reserved = true; decision = 'call'; }
        else { repo.setImprovement(id, asImprovement({ state: 'pending_decision', reason, tasks, fromVersion: l.version, at: now() })); decision = 'pending'; }
      }
    }
    db.exec('RELEASE lesson_improve');
  } catch (e) {
    try { db.exec('ROLLBACK TO lesson_improve'); db.exec('RELEASE lesson_improve'); } catch { /* sin savepoint */ }
    throw e;
  }
  if (decision === 'skip' || !l) return { state: 'skipped', lesson: l ?? null };
  if (decision === 'pending') return { state: 'pending_decision', lesson: repo.get(id) ?? null };

  const cur = l;
  inFlight.add(flightKey);
  try {
    const d = await draftLesson(slug, id, { authorized: true, extraEvidence: accumulatedEvidence(slug, cur, reason), kind: 'lesson_improve' });
    if (reserved) { const a = getAutoImproveAuthorization(slug); a.usage.usd = Number((a.usage.usd + d.costUsd).toFixed(6)); saveUsage(slug, a); }
    if (!d.lessonText || d.lessonText.length < 10) throw Object.assign(new Error('El modelo no redactó una lección utilizable.'), { statusCode: 502 });
    if (repo.successorOf(id)) return { state: 'skipped', lesson: repo.successorOf(id) ?? null };
    const v = repo.newVersion(id, { lessonText: d.lessonText, rootCause: d.rootCause ?? cur.rootCause, correctiveAction: d.correctiveAction ?? cur.correctiveAction, role: d.role ?? cur.role, tags: d.tags }, 'curator');
    repo.setImprovement(v.id, asImprovement({ state: 'applied', reason, tasks, fromVersion: cur.version, at: now() }));
    repo.setImprovement(id, null);
    syncLessonPracticesSafe(slug);
    return { state: 'applied', lesson: repo.get(v.id) ?? v };
  } catch (e: any) {
    // La llamada no llegó a hacerse (política o proveedor sin conectar): se devuelve el cupo reservado.
    if (reserved && (e?.statusCode === 403 || e?.statusCode === 409)) { const a = getAutoImproveAuthorization(slug); a.usage.calls = Math.max(0, a.usage.calls - 1); saveUsage(slug, a); }
    if (opts.explicit) throw e;
    if (!repo.successorOf(id)) repo.setImprovement(id, asImprovement({ state: 'pending_decision', reason, tasks, fromVersion: cur.version, at: now() }));
    return { state: 'pending_decision', lesson: repo.get(id) ?? null };
  } finally {
    inFlight.delete(flightKey);
  }
}

/** Tras cada tarea: mejora o deja pendientes las candidatas. Nunca lanza error. */
export async function maybeImproveLessons(slug: string, projectId: string | null = null): Promise<{ applied: number; pending: number }> {
  const out = { applied: 0, pending: 0 };
  let candidates: { lesson: Lesson; reason: LessonImprovementReason }[] = [];
  try { candidates = improvementCandidates(slug, projectId); } catch { return out; }
  for (const c of candidates) {
    try {
      const r = await improveLesson(slug, c.lesson.id, c.reason);
      if (r.state === 'applied') out.applied++; else if (r.state === 'pending_decision') out.pending++;
    } catch { /* una lección no debe frenar a las demás */ }
  }
  return out;
}

// ---------- Decisiones ----------
/** Clic en «Aceptar mejora (1 llamada)»: autorización explícita de una llamada; mismo camino. */
export async function acceptImprovement(slug: string, id: string, opts: { authorized: boolean }): Promise<Lesson> {
  if (!opts.authorized) throw Object.assign(new Error('Aceptar la mejora llama a la IA: requiere autorización explícita.'), { statusCode: 403 });
  const l = lessonsRepo(slug).get(id); if (!l) throw Object.assign(new Error('Lección no encontrada'), { statusCode: 404 });
  if (l.improvement?.state !== 'pending_decision') throw Object.assign(new Error('Esta lección no tiene una mejora pendiente.'), { statusCode: 409 });
  const r = await improveLesson(slug, id, l.improvement.reason, { explicit: true });
  if (r.state !== 'applied' || !r.lesson) throw Object.assign(new Error('La lección cambió desde que se propuso la mejora; vuelve a cargar Decisiones.'), { statusCode: 409 });
  return r.lesson;
}

/** Mejoras pendientes de decisión, para la bandeja (lista aparte como /inbox/assignments). */
export function pendingImprovementItems(slug: string): LessonImprovementPendingItem[] {
  const repo = lessonsRepo(slug);
  return repo.list(null, null)
    .filter(l => l.improvement?.state === 'pending_decision' && !repo.successorOf(l.id))
    .map(l => {
      let estimatedUsd: number | null = null;
      try { estimatedUsd = estimatePropose(slug, l.id).estimatedUsd; } catch { estimatedUsd = null; }
      const imp = l.improvement as LessonImprovement;
      return { lessonId: l.id, title: l.title, projectId: l.projectId ?? null, detector: l.detector, version: l.version, lessonText: l.lessonText ?? null, reason: imp.reason, tasks: imp.tasks, at: (imp as unknown as { at?: string }).at ?? l.updatedAt, estimatedUsd } as unknown as LessonImprovementPendingItem;
    });
}

/** Volver a la versión anterior: reactiva la madre, la actual queda obsoleta con improvement «reverted». */
export function revertImprovement(slug: string, id: string): Lesson {
  const repo = lessonsRepo(slug); const db = workspaceDb(slug);
  const l = repo.get(id); if (!l) throw Object.assign(new Error('Lección no encontrada'), { statusCode: 404 });
  if (l.improvement?.state !== 'applied' || !l.parentId || l.status !== 'validated' || repo.successorOf(id)) throw Object.assign(new Error('Esta versión no es una mejora automática vigente.'), { statusCode: 409 });
  const parent = repo.get(l.parentId); if (!parent) throw Object.assign(new Error('No se encontró la versión anterior.'), { statusCode: 404 });
  db.exec('SAVEPOINT lesson_revert');
  try {
    repo.update(parent.id, { status: 'validated' });
    repo.update(id, { status: 'obsolete' });
    repo.setImprovement(id, asImprovement({ ...(l.improvement as unknown as Record<string, unknown>), state: 'reverted', at: now() }));
    db.exec('RELEASE lesson_revert');
  } catch (e) {
    try { db.exec('ROLLBACK TO lesson_revert'); db.exec('RELEASE lesson_revert'); } catch { /* sin savepoint */ }
    throw e;
  }
  syncLessonPracticesSafe(slug);
  return repo.get(parent.id)!;
}

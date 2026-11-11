import { agentCaller, completeWith } from './claudeCode/backend.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findingKey, verificationPassed } from '@portal-ia/domain';
import type { Agent, Lesson, LessonEvidence, LessonImprovement, LessonProof, LessonStatus, ModelInfo, Process, ProviderId, TeamRole } from '@portal-ia/domain';
import { syncLessonPracticesSafe } from './lessonPractices.ts';
import { practicesFor } from './agentTemplates.ts';
import { costUsd, estimatePricing, getAdapter } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, processesRepo, workspaceDb } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';
import { requirePolicy } from './executionPolicy.ts';
import { monotonicNow } from '../clock.ts';

/**
 * Aprendizaje organizacional validado (M4).
 *  1. DETECCIÓN determinista (sin IA) de errores objetivos en un proceso → lección «detectada» con evidencia.
 *  2. PROPUESTA (una llamada de IA, solo con autorización) de causa raíz y acción correctiva → «propuesta».
 *  3. VALIDACIÓN por el propietario (edita si quiere) → «validada». Solo las validadas se inyectan en los prompts.
 *  4. INYECCIÓN por papel/proyecto en los pasos de historias; cada paso registra qué lecciones usó (`lessons_used`).
 *  5. REINCIDENCIA (EN-022): si el mismo detector (y la misma causa) vuelve a saltar en un paso que ya tenía la lección
 *     inyectada, cuenta UNA vez por proceso (recurrence_json); si ese proceso termina verificado, se retira. Cuando una
 *     lección reincide en 2+ tareas o queda refutada, lessonImprover.ts redacta su versión siguiente.
 */
const now = monotonicNow;

export function ensureLessonsTable(slug: string) {
  const db = workspaceDb(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY, project_id TEXT, role TEXT, tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, parent_id TEXT,
    title TEXT NOT NULL, detector TEXT NOT NULL, dedupe_key TEXT, evidence_json TEXT NOT NULL, root_cause TEXT, corrective_action TEXT, lesson_text TEXT,
    source TEXT NOT NULL DEFAULT 'detector', used_count INTEGER NOT NULL DEFAULT 0, recurrence_count INTEGER NOT NULL DEFAULT 0, promoted_to TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, validated_at TEXT
  ); CREATE INDEX IF NOT EXISTS lessons_status ON lessons(status); CREATE UNIQUE INDEX IF NOT EXISTS lessons_dedupe ON lessons(dedupe_key);`);
  // Memoria de UN agente (aprendizaje verificado por el propietario a partir de su trabajo): misma tabla, mismo flujo de
  // validación, pero fuera de las listas e inyecciones de siempre (agent_id NULL en todas las lecciones existentes).
  const cols = (db.prepare(`PRAGMA table_info(lessons)`).all() as any[]).map(c => c.name);
  if (!cols.includes('agent_id')) db.exec(`ALTER TABLE lessons ADD COLUMN agent_id TEXT`);
  // Demostración por tareas posteriores (aprendida / refutada): columnas nuevas, las lecciones existentes empiezan sin pruebas.
  if (!cols.includes('proof_json')) db.exec(`ALTER TABLE lessons ADD COLUMN proof_json TEXT NOT NULL DEFAULT '[]'`);
  if (!cols.includes('proven_at')) db.exec(`ALTER TABLE lessons ADD COLUMN proven_at TEXT`);
  // EN-022: procesos distintos en los que reincidió y estado de la mejora automática (aditivo).
  if (!cols.includes('recurrence_json')) db.exec(`ALTER TABLE lessons ADD COLUMN recurrence_json TEXT NOT NULL DEFAULT '[]'`);
  if (!cols.includes('improvement_json')) db.exec(`ALTER TABLE lessons ADD COLUMN improvement_json TEXT`);
  recalcRecurrenceOnce(db, slug);
  return db;
}

/** EN-022: etiqueta de causa de una lección o detección («causa:<firma>»), o null. */
export const causeOfTags = (tags: string[] | undefined): string | null => (tags ?? []).find(t => t.startsWith('causa:'))?.slice(6) ?? null;
/** La detección repite el error de la lección: mismo detector y, si la lección es específica, la misma causa. */
const sameCause = (l: Lesson, d: { detector: string; tags: string[] }) => (l.detector === d.detector || l.tags.includes(d.detector)) && (!causeOfTags(l.tags) || causeOfTags(l.tags) === causeOfTags(d.tags));

/**
 * EN-022 · Recálculo único (marca en lessons_meta, en la misma transacción que el UPDATE) con la regla nueva: una
 * reincidencia por proceso que no terminó verificado. No borra evidencia ni historial (proof_json intacto). Si el proceso
 * de una prueba «recurred» ya no existe, se conserva la reincidencia.
 */
function recalcRecurrenceOnce(db: ReturnType<typeof workspaceDb>, slug: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS lessons_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  if (db.prepare(`SELECT 1 AS x FROM lessons_meta WHERE key = 'recurrence_per_process'`).get()) return;
  const rows = (db.prepare(`SELECT * FROM lessons`).all() as any[]).map(map);
  const byId = new Map(rows.map(l => [l.id, l]));
  const cache = new Map<string, Process | null>();
  const procOf = (pid: string): Process | null => {
    if (!cache.has(pid)) { let p: Process | null = null; try { p = processesRepo(slug).get(pid) ?? null; } catch { p = null; } cache.set(pid, p); }
    return cache.get(pid) ?? null;
  };
  const sets = new Map<string, Set<string>>(rows.map(l => [l.id, new Set<string>()]));
  for (const l of rows) for (const p of l.proof ?? []) {
    if (p.result !== 'recurred') continue;
    const proc = procOf(p.processId);
    if (!proc || proc.result?.pipeline?.state !== 'verified') sets.get(l.id)!.add(p.processId);
  }
  for (const d of rows) {
    const pid = d.evidence?.processId; if (!pid || d.detector === 'manual') continue;
    const proc = procOf(pid); if (!proc || proc.result?.pipeline?.state === 'verified') continue;
    const step = proc.steps.find(s => s.id === d.evidence.stepId);
    for (const id of realLessonIds(step?.lessonsUsed ?? [])) {
      const l = byId.get(id);
      if (l && l.id !== d.id && l.evidence.processId !== pid && sameCause(l, d)) sets.get(id)!.add(pid);
    }
  }
  db.exec('SAVEPOINT lesson_recurrence_recalc');
  try {
    const st = db.prepare(`UPDATE lessons SET recurrence_json = ?, recurrence_count = ? WHERE id = ?`);
    for (const [id, s] of sets) st.run(JSON.stringify([...s]), s.size, id);
    db.prepare(`INSERT OR IGNORE INTO lessons_meta (key, value) VALUES ('recurrence_per_process', ?)`).run(now());
    db.exec('RELEASE lesson_recurrence_recalc');
  } catch (e) {
    try { db.exec('ROLLBACK TO lesson_recurrence_recalc'); db.exec('RELEASE lesson_recurrence_recalc'); } catch { /* sin savepoint */ }
    throw e;
  }
}

const map = (r: any): Lesson => ({ id: r.id, projectId: r.project_id, role: r.role, tags: JSON.parse(r.tags || '[]'), status: r.status, version: r.version, parentId: r.parent_id, title: r.title, detector: r.detector, evidence: JSON.parse(r.evidence_json), rootCause: r.root_cause, correctiveAction: r.corrective_action, lessonText: r.lesson_text, source: r.source, usedCount: r.used_count, recurrenceCount: r.recurrence_count, promotedTo: r.promoted_to, createdAt: r.created_at, updatedAt: r.updated_at, validatedAt: r.validated_at, agentId: r.agent_id ?? null, proof: JSON.parse(r.proof_json || '[]'), provenAt: r.proven_at ?? null, recurrenceProcesses: JSON.parse(r.recurrence_json || '[]'), improvement: r.improvement_json ? JSON.parse(r.improvement_json) : null });

export function lessonsRepo(slug: string) {
  const db = ensureLessonsTable(slug);
  return {
    list(projectId?: string | null, status?: LessonStatus | null): Lesson[] {
      const rows = db.prepare(`SELECT * FROM lessons WHERE agent_id IS NULL AND (? IS NULL OR project_id IS NULL OR project_id = ?) AND (? IS NULL OR status = ?) ORDER BY updated_at DESC`).all(projectId ?? null, projectId ?? null, status ?? null, status ?? null) as any[];
      return rows.map(map);
    },
    /** Memoria de un agente (todas sus entradas o las de un estado). */
    listForAgent(agentId: string, status?: LessonStatus | null): Lesson[] {
      return (db.prepare(`SELECT * FROM lessons WHERE agent_id = ? AND (? IS NULL OR status = ?) ORDER BY created_at`).all(agentId, status ?? null, status ?? null) as any[]).map(map);
    },
    setAgent(id: string, agentId: string) { db.prepare(`UPDATE lessons SET agent_id = ? WHERE id = ?`).run(agentId, id); },
    get(id: string): Lesson | undefined { const r = db.prepare(`SELECT * FROM lessons WHERE id = ?`).get(id); return r ? map(r) : undefined; },
    insert(l: Omit<Lesson, 'id' | 'createdAt' | 'updatedAt' | 'usedCount' | 'recurrenceCount' | 'validatedAt' | 'agentId'> & { dedupeKey?: string | null; agentId?: string | null }): Lesson | null {
      const id = crypto.randomUUID(); const ts = now();
      try {
        db.prepare(`INSERT INTO lessons (id, project_id, role, tags, status, version, parent_id, title, detector, dedupe_key, evidence_json, root_cause, corrective_action, lesson_text, source, promoted_to, created_at, updated_at, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, l.projectId, l.role, JSON.stringify(l.tags), l.status, l.version, l.parentId ?? null, l.title, l.detector, l.dedupeKey ?? null, JSON.stringify(l.evidence), l.rootCause ?? null, l.correctiveAction ?? null, l.lessonText ?? null, l.source, l.promotedTo ?? null, ts, ts, l.agentId ?? null);
      } catch (e: any) { if (/UNIQUE/.test(e.message)) return null; throw e; }
      return this.get(id)!;
    },
    update(id: string, patch: Partial<{ status: LessonStatus; title: string; rootCause: string | null; correctiveAction: string | null; lessonText: string | null; role: string | null; tags: string[]; validatedAt: string | null; promotedTo: string | null; source: string }>) {
      const cur = this.get(id); if (!cur) return undefined;
      const n = { ...cur, ...patch };
      db.prepare(`UPDATE lessons SET status = ?, title = ?, root_cause = ?, corrective_action = ?, lesson_text = ?, role = ?, tags = ?, validated_at = ?, promoted_to = ?, source = ?, updated_at = ? WHERE id = ?`)
        .run(n.status, n.title, n.rootCause, n.correctiveAction, n.lessonText, n.role, JSON.stringify(n.tags), n.validatedAt, n.promotedTo, n.source, now(), id);
      return this.get(id)!;
    },
    bumpUsed(ids: string[]) { const st = db.prepare(`UPDATE lessons SET used_count = used_count + 1 WHERE id = ?`); for (const id of ids) st.run(id); },
    /** EN-022: suma una reincidencia solo si ese proceso aún no la había sumado (idempotente frente a pausas y reintentos). */
    bumpRecurrence(id: string, processId: string = `sin-proceso:${crypto.randomUUID()}`): boolean {
      const r = db.prepare(`SELECT recurrence_json FROM lessons WHERE id = ?`).get(id) as any; if (!r) return false;
      const ids: string[] = JSON.parse(r.recurrence_json || '[]'); if (ids.includes(processId)) return false;
      ids.push(processId);
      db.prepare(`UPDATE lessons SET recurrence_json = ?, recurrence_count = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(ids), ids.length, now(), id);
      return true;
    },
    /** EN-022: el proceso terminó verificado, así que su fallo intermedio deja de contar como reincidencia. */
    clearRecurrence(id: string, processId: string) {
      const r = db.prepare(`SELECT recurrence_json FROM lessons WHERE id = ?`).get(id) as any; if (!r) return;
      const ids: string[] = JSON.parse(r.recurrence_json || '[]'); if (!ids.includes(processId)) return;
      const next = ids.filter(x => x !== processId);
      db.prepare(`UPDATE lessons SET recurrence_json = ?, recurrence_count = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(next), next.length, now(), id);
    },
    /** Lecciones en las que ese proceso cuenta como reincidencia. */
    withRecurrence(processId: string): string[] {
      return (db.prepare(`SELECT id, recurrence_json FROM lessons WHERE recurrence_json LIKE ?`).all(`%${JSON.stringify(processId)}%`) as any[])
        .filter(r => (JSON.parse(r.recurrence_json || '[]') as string[]).includes(processId)).map(r => String(r.id));
    },
    /** Versión siguiente de una lección (si existe). */
    successorOf(id: string): Lesson | undefined { const r = db.prepare(`SELECT * FROM lessons WHERE parent_id = ? ORDER BY version DESC LIMIT 1`).get(id); return r ? map(r) : undefined; },
    setImprovement(id: string, imp: LessonImprovement | null) { db.prepare(`UPDATE lessons SET improvement_json = ?, updated_at = ? WHERE id = ?`).run(imp ? JSON.stringify(imp) : null, now(), id); },
    /** Añade la evidencia de una tarea posterior (una por proceso) y, si la demuestra por primera vez, la marca aprendida. */
    addProof(id: string, p: LessonProof) {
      const cur = this.get(id); if (!cur || (cur.proof ?? []).some(x => x.processId === p.processId)) return cur;
      const proof = [...(cur.proof ?? []), p].slice(-20);
      db.prepare(`UPDATE lessons SET proof_json = ?, proven_at = COALESCE(proven_at, ?), updated_at = ? WHERE id = ?`).run(JSON.stringify(proof), p.result === 'held' ? p.at : null, now(), id);
      return this.get(id);
    },
    /** Nueva versión de una lección validada (la anterior queda «obsoleta» con enlace). */
    newVersion(id: string, patch: { lessonText?: string | null; rootCause?: string | null; correctiveAction?: string | null; role?: string | null; tags?: string[] }, source: string = 'owner'): Lesson {
      const cur = this.get(id)!;
      const v = this.insert({ ...cur, ...patch, version: cur.version + 1, parentId: cur.id, status: 'validated', source, dedupeKey: null, promotedTo: null })!;
      db.prepare(`UPDATE lessons SET status = 'obsolete', updated_at = ? WHERE id = ?`).run(now(), id);
      db.prepare(`UPDATE lessons SET validated_at = ?, used_count = ? WHERE id = ?`).run(now(), cur.usedCount, v.id);
      return this.get(v.id)!;
    }
  };
}

// ---------- 1 · Detección determinista ----------
export interface Detection { detector: string; title: string; role: TeamRole | null; tags: string[]; evidence: LessonEvidence; dedupeKey: string }

export function detectInProcess(slug: string, proc: Process, repoPath: string | null, extra: { resetReason?: string | null; updateFailedLog?: string | null } = {}): Detection[] {
  if (proc.kind !== 'story_execution') return [];
  const r = proc.result; const out: Detection[] = [];
  const impl = proc.steps.find(s => s.role === 'implementer') ?? proc.steps[1];
  const ev = (file: string | null, detail: string, step = impl): LessonEvidence => ({ processId: proc.id, processTitle: proc.title, stepId: step?.id ?? null, agentId: step?.agentId ?? null, agentName: step?.agentName ?? null, file, detail: detail.slice(0, 600), at: now() });
  const key = (d: string, f: string | null) => `${proc.id}:${d}:${f ?? ''}`;
  // Entrega incremental: lo que una unidad entregó y no se aplicó (o llegó con aviso) queda en el manifiesto.
  for (const c of [...(r?.changes ?? []), ...(r?.manifest?.rejected ?? [])]) {
    if (c.error && /no aparece|aparece más de una vez|búsqueda está vacía|no existe en el repositorio/.test(c.error)) out.push({ detector: 'patch_mismatch', title: `Parche que no encaja en ${c.path}`, role: 'implementer', tags: ['patch', 'implementar', `causa:${c.path}`], evidence: ev(c.path, c.error), dedupeKey: key('patch_mismatch', c.path) });
    if (c.error && /cambió en el repositorio|ya no existe/.test(c.error)) out.push({ detector: 'stale_file', title: `Cambio omitido por archivo desactualizado: ${c.path}`, role: 'implementer', tags: ['stale', 'implementar'], evidence: ev(c.path, c.error), dedupeKey: key('stale_file', c.path) });
    if (c.warning && /reemplazo completo/.test(c.warning)) out.push({ detector: 'big_rewrite', title: `Reemplazo completo que reduce ${c.path}`, role: 'implementer', tags: ['modify', 'implementar'], evidence: ev(c.path, c.warning), dedupeKey: key('big_rewrite', c.path) });
  }
  // Módulo nuevo sin importar: archivo creado en services/ o components/ cuyo nombre no aparece en ningún otro cambio ni en el repositorio.
  for (const c of r?.changes ?? []) {
    if (c.action !== 'create' || c.error || !/(^|\/)(services|components|screens|lib)\/[^/]+\.(ts|tsx|js|mjs)$/.test(c.path)) continue;
    const base = c.path.split('/').pop()!.replace(/\.(ts|tsx|js|mjs)$/, '');
    const referenced = (r?.changes ?? []).some(o => o !== c && !o.error && (o.content ?? '').includes(base)) || (repoPath ? grepRepo(repoPath, base, c.path) : false);
    if (!referenced) out.push({ detector: 'unused_module', title: `Módulo nuevo sin importar: ${c.path}`, role: 'implementer', tags: ['wiring', 'implementar'], evidence: ev(c.path, `Se creó ${c.path} pero ningún otro archivo del diff ni del repositorio menciona «${base}».`), dedupeKey: key('unused_module', c.path) });
  }
  if (r?.review && !r.review.approve) out.push({ detector: 'qa_rejected', title: 'QA no aprobó el diff', role: 'implementer', tags: ['qa', 'implementar'], evidence: ev(null, `${r.review.summary} · ${r.review.issues.slice(0, 3).join(' · ')}`), dedupeKey: key('qa_rejected', null) });
  const lastV = ['typecheck', 'test', 'build'].map(c => (r?.verifications ?? []).filter(v => v.command === c).at(-1)).filter(v => v && !verificationPassed(v) && v.isolation !== 'unavailable');
  for (const v of lastV) {
    const sig = causeSignature(v!.command, v!.output ?? '');
    const what = sig === v!.command ? '' : sig.slice(v!.command.length + 1);
    out.push({ detector: 'verification_failed', title: `Verificación fallida: ${v!.command}${what ? ` (${what})` : ''}`, role: 'implementer', tags: ['verify', v!.command, 'implementar', `causa:${sig}`], evidence: ev(null, v!.output.slice(-600)), dedupeKey: key(`verification_failed:${sig}`, null) });
  }
  if (extra.updateFailedLog) out.push({ detector: 'activation_failed', title: 'Activación fallida (reconstruir y reiniciar)', role: 'implementer', tags: ['activation', 'build'], evidence: ev(null, extra.updateFailedLog.slice(-600)), dedupeKey: key('activation_failed', null) });
  for (const x of r?.runtimeChecks?.results ?? []) if (x.status === 'fail') out.push({ detector: 'runtime_failed', title: `Comprobación en ejecución fallida: ${x.check.kind} ${x.check.path}`, role: 'implementer', tags: ['runtime', x.check.kind], evidence: ev(x.check.path, x.detail), dedupeKey: key(`runtime_failed:${x.check.kind}:${x.check.path}`, null) });
  if (extra.resetReason) out.push({ detector: 'story_reset', title: 'Historia devuelta a pendiente por el propietario', role: 'planner', tags: ['reset', 'planificar'], evidence: ev(null, extra.resetReason, proc.steps.find(s => s.role === 'planner') ?? proc.steps[0]), dedupeKey: key('story_reset', null) });
  // HU-155: fallos clasificados (bloqueo del agente, negativa o plazo del proveedor). Evidencia para revisar; nunca se validan solos.
  const cls = r?.failure?.class ?? r?.pipeline?.failureClass ?? null;
  const req = r?.pipeline?.ownerRequest ?? r?.failure?.request ?? null;
  const a = r?.failure?.assessment ?? r?.pipeline?.lastAssessment ?? null;
  // Credencial rechazada por el proveedor (401/403…): no es un bloqueo del agente.
  const fromProvider = !!r?.failure?.providerCode;
  if (cls === 'PERMISSION_REQUIRED' && fromProvider) out.push({ detector: 'provider_credentials', title: 'El proveedor rechazó la credencial o el permiso', role: null, tags: ['proveedor', 'credencial'], evidence: ev(null, `Código: ${r!.failure!.providerCode}. ${r!.failure!.detail}`.slice(0, 600)), dedupeKey: key('provider_credentials', null) });
  else if (cls === 'MISSING_INFORMATION' || cls === 'PERMISSION_REQUIRED' || cls === 'UNSUPPORTED_CAPABILITY') out.push({ detector: 'agent_blocked', title: `El agente se bloqueó: ${cls === 'MISSING_INFORMATION' ? 'le faltaba información' : cls === 'PERMISSION_REQUIRED' ? 'necesitaba un permiso' : 'le faltaba una capacidad'}`, role: 'implementer', tags: ['bloqueo', cls.toLowerCase()], evidence: ev(null, `Clase: ${cls}. ${a?.blocker ? `${a.blocker.declared ? 'Declarado en la sección BLOQUEO' : 'Deducido del texto (heurística)'}: ${a.blocker.need}. ` : ''}${req ? `Pregunta: ${req.question}` : ''}`.slice(0, 600)), dedupeKey: key('agent_blocked', null) });
  if (cls === 'PROVIDER_REFUSAL') out.push({ detector: 'provider_refusal', title: 'El proveedor rechazó la petición', role: 'implementer', tags: ['proveedor', 'negativa'], evidence: ev(null, `${(a?.reasons ?? []).join(' ') || r?.failure?.detail || 'negativa del proveedor'}. No se reintentó.`.slice(0, 600)), dedupeKey: key('provider_refusal', null) });
  if (cls === 'PROVIDER_TIMEOUT' || cls === 'PROVIDER_CONNECTION_ERROR') out.push({ detector: cls === 'PROVIDER_TIMEOUT' ? 'provider_timeout' : 'provider_unavailable', title: cls === 'PROVIDER_TIMEOUT' ? 'El proveedor no respondió dentro del plazo' : 'No se pudo contactar con el proveedor', role: null, tags: ['proveedor', cls.toLowerCase()], evidence: ev(null, (r?.failure?.detail ?? r?.pipeline?.reason ?? '').slice(0, 600)), dedupeKey: key(cls === 'PROVIDER_TIMEOUT' ? 'provider_timeout' : 'provider_unavailable', null) });
  if (proc.status === 'failed' && proc.error && /no entregó ningún archivo|se cortó/.test(proc.error)) out.push({ detector: 'dev_no_output', title: 'El implementador no entregó archivos en el formato acordado', role: 'implementer', tags: ['format', 'implementar'], evidence: ev(null, proc.error), dedupeKey: key('dev_no_output', null) });
  // EN-022: pausas con un único disparador cada una (las crean storyPipeline.ts y storyUnits.ts).
  const pipe = (r?.pipeline ?? null) as unknown as { pauseKind?: string | null; reason?: string | null } | null;
  const pauseReason = String(pipe?.reason ?? '');
  if (pipe?.pauseKind === 'max_turns') out.push({ detector: 'max_turns_exhausted', title: 'Claude Code agotó los turnos autorizados sin entregar', role: 'implementer', tags: ['turnos', 'claude-code', 'implementar'], evidence: ev(null, pauseReason || 'Pausa por turnos agotados.'), dedupeKey: key('max_turns_exhausted', null) });
  if (pipe?.pauseKind === 'limit' && /máximo de correcciones autorizadas/.test(pauseReason)) out.push({ detector: 'correction_cap_reached', title: 'Se alcanzó el máximo de correcciones autorizadas', role: 'implementer', tags: ['corrección', 'tope', 'implementar'], evidence: ev(null, pauseReason), dedupeKey: key('correction_cap_reached', null) });
  // Entrega incremental y lecciones de HU-155 (tamaño de las respuestas, regeneración, entrega incompleta, correcciones
  // sin efecto, pruebas y contexto). Evidencia objetiva del propio proceso; nunca se validan solas.
  const evs = r?.pipeline?.events ?? []; const man = r?.manifest ?? null;
  const evText = (xs: typeof evs) => xs.map(e => `${e.message}${e.detail ? ` (${e.detail})` : ''}`).join(' · ');
  const cut = evs.filter(e => e.kind === 'continuation' && /se cortó por longitud/.test(e.message));
  if (cut.length) out.push({ detector: 'oversized_response', title: 'Se pidió más código del que cabe en una respuesta del modelo', role: 'implementer', tags: ['tamaño', 'salida', 'implementar'], evidence: ev(cut[0].message.match(/«([^»]+)»/)?.[1] ?? null, `${cut.length} respuesta(s) cortadas por longitud: ${evText(cut)}`), dedupeKey: key('oversized_response', null) });
  const exhausted = evs.filter(e => /agotó toda su salida/.test(e.message));
  if (exhausted.length) out.push({ detector: 'output_exhausted', title: 'El razonamiento interno agotó la salida del modelo sin entregar texto', role: 'implementer', tags: ['razonamiento', 'salida', 'costo'], evidence: ev(null, evText(exhausted)), dedupeKey: key('output_exhausted', null) });
  const regen = evs.filter(e => /no se regenera un archivo terminado|no reescribe entero/.test(`${e.message} ${e.detail ?? ''}`));
  if (regen.length) out.push({ detector: 'regenerated_completed', title: 'Se intentó regenerar un archivo ya terminado en lugar de parchearlo', role: 'implementer', tags: ['regenerar', 'patch', 'implementar'], evidence: ev(null, evText(regen)), dedupeKey: key('regenerated_completed', null) });
  // Plan frente al diff real (también procesos sin manifiesto: HU-155 entregó 2 de 8 archivos y QA lo descubrió pagando).
  const planned = man ? man.deliverables.filter(d => d.planned && d.status !== 'dropped').map(d => d.path) : r?.plan?.filesToChange ?? [];
  const inDiff = new Set((r?.changes ?? []).filter(c => !c.error).map(c => c.path));
  const missingPlan = r?.applied ? planned.filter(p => !inDiff.has(p)) : [];
  const gateIssues = man?.gate && !man.gate.ok ? [...man.gate.missing.map(m => `falta ${m}`), ...man.gate.invalid.map(i => `${i.path}: ${i.problem}`)] : [];
  if (missingPlan.length || gateIssues.length) out.push({ detector: 'incomplete_delivery', title: `Entrega incompleta frente al plan (${planned.length - missingPlan.length} de ${planned.length} entregables)`, role: 'implementer', tags: ['completitud', 'plan', 'implementar'], evidence: ev(missingPlan[0] ?? null, [missingPlan.length ? `Faltan en el diff: ${missingPlan.join(', ')}.` : '', gateIssues.length ? `Comprobación previa a QA: ${gateIssues.join(' · ')}.` : '', man ? 'Detectado sin IA antes de QA.' : 'Sin manifiesto: QA lo descubrió en una revisión pagada.'].filter(Boolean).join(' ')), dedupeKey: key('incomplete_delivery', null) });
  const ineffective = evs.filter(e => /no trajo cambios aplicables|no produjo ningún cambio aplicable|no produjeron ningún cambio aplicable/.test(e.message));
  if (ineffective.length) out.push({ detector: 'ineffective_correction', title: 'Correcciones pagadas sin ningún cambio aplicable', role: 'implementer', tags: ['corrección', 'costo', 'implementar'], evidence: ev(null, evText(ineffective)), dedupeKey: key('ineffective_correction', null) });
  const noTests = man?.gate?.notes.find(n => /sin pruebas/.test(n));
  if (noTests) out.push({ detector: 'missing_tests', title: 'Código nuevo sin pruebas nuevas', role: 'implementer', tags: ['pruebas', 'calidad', 'implementar'], evidence: ev(null, noTests), dedupeKey: key('missing_tests', null) });
  const heavy = proc.steps.filter(s => (s.role === 'implementer' || s.role === 'reviewer') && s.inputTokens > 40_000);
  // Gauntlet: brechas CON evidencia que el Evaluador encontró en el trabajo del constructor. Un hallazgo no es una lección:
  // queda «detectada» (nada se inyecta sin validar) con su evidencia, quién evaluó y si la corrección funcionó. Solo con el
  // resultado decidido: una brecha cuya corrección sigue en curso se detecta en una parada posterior.
  const g = r?.gauntlet; const short = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
  const unfixed: Record<string, string> = { stopped: 'el ciclo se detuvo con la brecha pendiente', passed_with_findings: 'quedó documentada como no bloqueante', waived: 'el propietario siguió sin corregirla' };
  for (const [i, round] of (g?.rounds ?? []).entries()) {
    const next = g!.rounds[i + 1];
    if (!next && g!.status === 'pending') continue;
    for (const f of round.findings) {
      if (f.unsupported || f.severity === 'minor') continue;
      const k = findingKey(f);
      const outcome = next ? (next.findings.some(n => findingKey(n) === k) ? `persistió tras la corrección (ronda ${next.round})` : `corregida en la ronda ${next.round}`) : `sin corregir: ${unfixed[g!.status] ?? 'no se re-evaluó'}`;
      out.push({ detector: 'gauntlet_gap', title: `Brecha del Evaluador Gauntlet: ${short(f.text, 100)}`, role: 'implementer', tags: ['gauntlet', f.severity === 'blocking' ? 'bloqueante' : 'mayor', 'implementar', `causa:${k}`], evidence: ev(f.file, `Resultado: ${outcome}. Evaluó ${round.evaluatorName} (ronda ${round.round}, modo ${g!.mode}). ${f.criterion ? `Criterio: ${short(f.criterion, 120)}. ` : ''}Evidencia: ${short(f.evidence ?? '', 260)}.${f.expected ? ` Esperado: ${short(f.expected, 120)}.` : ''}`), dedupeKey: key(`gauntlet_gap:${k}`, null) });
    }
  }
  if (heavy.length) out.push({ detector: 'excessive_context', title: `Contexto excesivo en ${heavy.length} llamada(s) (hasta ${Math.max(...heavy.map(s => s.inputTokens))} tokens de entrada)`, role: null, tags: ['contexto', 'costo', 'tokens'], evidence: ev(null, heavy.map(s => `${s.title}: ${s.inputTokens} tokens de entrada, ${s.outputTokens} de salida, ${s.costUsd.toFixed(4)} USD`).join(' · '), heavy[0]), dedupeKey: key('excessive_context', null) });
  return out;
}

/**
 * EN-022 · Firma de causa de una verificación fallida, sin IA: «<comando>:<prueba|archivo>» o solo el comando.
 * test: nombre de la primera prueba fallida («not ok N - nombre» o «✖ nombre») o el archivo *.test.ts;
 * typecheck/build: el primer archivo con error TS. Admite CRLF y rutas con «\».
 */
export function causeSignature(command: string, output: string): string {
  const text = output.replace(/\r\n?/g, '\n').replace(/\\/g, '/');
  const pick = (re: RegExp): string | null => { const m = text.match(re)?.[1]?.trim(); return m ? m : null; };
  const what = command === 'test'
    ? pick(/^\s*not ok \d+ - (.+)$/m) ?? pick(/^\s*✖ (.+?)(?: \(\d[\d.]*m?s\))?$/m) ?? pick(/([\w./@-]+\.test\.tsx?)/)
    : pick(/([\w./@-]+\.(?:tsx?|mts|js))\(\d+,\d+\): error TS/) ?? pick(/([\w./@-]+\.(?:tsx?|mts|js)):\d+:\d+ - error TS/) ?? pick(/([\w./@-]+\.(?:tsx?|mts))/);
  const clean = (what ?? '').replace(/\s+/g, ' ').replace(/^#\s*/, '').slice(0, 120);
  return clean ? `${command}:${clean}` : command;
}

/**
 * ¿Algún archivo rastreado del repositorio (distinto del propio módulo) menciona `needle`?
 * Ante cualquier error de git se responde «sí» (desconocido): un detector nunca debe inventar un fallo.
 */
function grepRepo(repoPath: string, needle: string, exceptPath: string): boolean {
  const specs = ['apps', 'packages', 'src', 'lib', 'scripts'].filter(d => fs.existsSync(path.join(repoPath, d)));
  try {
    const out = execFileSync('git', ['grep', '-l', '-F', '--', needle, ...(specs.length ? specs : ['.'])], { cwd: repoPath, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).toString();
    return out.split('\n').some(l => l && l !== exceptPath);
  } catch (e: any) { return e?.status === 1 ? false : true; } // 1 = sin coincidencias; otro código = no se pudo comprobar
}

/** EN-020: id de la lección detrás de una entrada de lessons_used (las prácticas van como practice:<key>@<v>:<lessonId>). */
export const lessonIdOf = (id: string): string => id.startsWith('practice:') ? id.split(':').slice(2).join(':') : id;
const realLessonIds = (ids: string[]): string[] => Array.from(new Set(ids.map(lessonIdOf).filter(x => !!x && x !== 'null' && x !== 'undefined')));

/** Detecta y guarda (sin IA). Devuelve las lecciones nuevas. Contabiliza reincidencias de lecciones ya inyectadas en el paso. */
export function recordDetections(slug: string, processId: string, repoPath: string | null, extra: Parameters<typeof detectInProcess>[3] = {}): Lesson[] {
  const proc = processesRepo(slug).get(processId); if (!proc) return [];
  const repo = lessonsRepo(slug); const created: Lesson[] = [];
  // EN-022: un proceso que terminó verificado corrigió sus fallos intermedios: no es reincidencia.
  const verified = proc.result?.pipeline?.state === 'verified';
  const touched = new Set<string>();
  for (const d of detectInProcess(slug, proc, repoPath, extra)) {
    const step = proc.steps.find(s => s.id === d.evidence.stepId);
    // Reincidencia: una lección validada de la misma causa ya iba inyectada en ese paso. Una por lección y proceso.
    for (const id of realLessonIds(step?.lessonsUsed ?? [])) {
      if (touched.has(id)) continue;
      const l = repo.get(id);
      if (l && l.status === 'validated' && l.evidence.processId !== processId && sameCause(l, d)) { touched.add(id); if (!verified) repo.bumpRecurrence(id, processId); }
    }
    const l = repo.insert({ projectId: proc.projectId, role: d.role, tags: d.tags, status: 'detected', version: 1, parentId: null, title: d.title, detector: d.detector, evidence: d.evidence, rootCause: null, correctiveAction: null, lessonText: null, source: 'detector', promotedTo: null, dedupeKey: d.dedupeKey });
    if (l) created.push(l);
  }
  if (verified) for (const id of repo.withRecurrence(processId)) repo.clearRecurrence(id, processId);
  return created;
}

/** Reincidencias seguidas (sin una tarea demostrada en medio) que retiran una lección de los prompts. */
export const REFUTE_AFTER = 2;

/**
 * Tras una tarea, cada lección validada que llevaba inyectada recibe su evidencia (LessonProof). Solo cuentan tareas
 * POSTERIORES a la que la originó. «Aprendida» = una tarea así terminó verificada sin repetir su error; si el error vuelve
 * a ocurrir con ella presente REFUTE_AFTER veces seguidas, queda «refutada»: deja de inyectarse (una lección equivocada no
 * se queda como conocimiento permanente) y el propietario la revisa. Sin IA.
 */
export function recordLessonOutcomes(slug: string, processId: string, repoPath: string | null): { held: string[]; recurred: string[]; refuted: string[] } {
  const out = { held: [] as string[], recurred: [] as string[], refuted: [] as string[] };
  const proc = processesRepo(slug).get(processId);
  if (!proc || proc.kind !== 'story_execution') return out;
  // Solo con la tarea TERMINADA y verificada hay conclusión: una pausa con un fallo pendiente aún puede corregirse.
  const verified = proc.result?.pipeline?.state === 'verified';
  if (!verified) return out;
  const repo = lessonsRepo(slug);
  // EN-022: terminó verificada, así que sus fallos intermedios dejan de contar como reincidencia (por tarea).
  for (const id of repo.withRecurrence(processId)) repo.clearRecurrence(id, processId);
  const used = new Set(realLessonIds(proc.steps.flatMap(s => s.lessonsUsed ?? [])));
  if (!used.size) return out;
  const fired = detectInProcess(slug, proc, repoPath);
  for (const id of used) {
    const l = repo.get(id); if (!l || l.status !== 'validated' || l.evidence.processId === processId) continue;
    const recurred = fired.some(d => sameCause(l, d));
    const after = repo.addProof(id, { processId, processTitle: proc.title, result: recurred ? 'recurred' : 'held', detail: recurred ? `El mismo error («${l.detector}») volvió a ocurrir con la lección inyectada.` : 'Terminó verificada sin repetir el error de la lección.', at: now() });
    if (!after) continue;
    (recurred ? out.recurred : out.held).push(id);
    const tail: LessonProof[] = []; for (const x of [...(after.proof ?? [])].reverse()) { if (x.result === 'held') break; tail.push(x); }
    if (recurred && tail.length >= REFUTE_AFTER) { repo.update(id, { status: 'refuted' }); out.refuted.push(id); }
  }
  if (out.refuted.length) syncLessonPracticesSafe(slug); // la refutada sale de la plantilla
  return out;
}

// ---------- 2 · Propuesta (IA, autorizada) ----------
export function estimatePropose(slug: string, lessonId: string): { agentId: string; agentName: string; model: string; estimatedUsd: number } {
  const l = lessonsRepo(slug).get(lessonId); if (!l) throw Object.assign(new Error('Lección no encontrada'), { statusCode: 404 });
  const agents = agentsRepo(slug).list();
  const agent = agents.find(a => a.key === 'pj-coordinador' && a.projectId === l.projectId) ?? agents.find(a => a.key === 'pj-coordinador') ?? agents.find(a => a.key === 'ws-gestor');
  if (!agent) throw Object.assign(new Error('No hay Coordinador ni Gestor para proponer la lección.'), { statusCode: 409 });
  const p = estimatePricing(agent.config.provider, agent.config.model);
  return { agentId: agent.id, agentName: agent.config.name, model: agent.config.model, estimatedUsd: (2500 * p.inPerM + 800 * p.outPerM) / 1_000_000 };
}

/** Prompt de propuesta de una lección (EN-022: reutilizado por la mejora automática con la evidencia acumulada). */
export function buildProposalPrompt(slug: string, l: Lesson, extraEvidence = '', agentName = 'Coordinador'): { system: string; user: string } {
  const proc = l.evidence.processId ? processesRepo(slug).get(l.evidence.processId) : undefined;
  const stepOut = proc?.steps.find(s => s.id === l.evidence.stepId)?.outputMd?.slice(0, 6000) ?? '';
  const system = `Eres «${agentName}» en Portal IA. Analizas un error objetivo detectado en la ejecución de una historia y redactas una lección breve y accionable para que el equipo de agentes no lo repita. Responde SOLO con JSON.`;
  const user = `Error detectado: ${l.title} (detector ${l.detector}).
Evidencia: ${l.evidence.detail}
Archivo: ${l.evidence.file ?? '—'} · Agente: ${l.evidence.agentName ?? '—'} · Proceso: ${l.evidence.processTitle ?? l.evidence.processId}
${stepOut ? `Salida del paso (recortada):\n${stepOut}` : ''}${extraEvidence ? `\n${extraEvidence}` : ''}

Responde SOLO con JSON: {"rootCause": string (1-2 frases), "correctiveAction": string (1-2 frases, concreta), "lessonText": string (instrucción imperativa de 1-3 frases que se añadirá al prompt del agente en futuras historias; sin referencias a este caso concreto), "role": "planner"|"implementer"|"reviewer"|"consultant", "tags": string[1-4]}`;
  return { system, user };
}

export interface LessonDraft { rootCause: string | null; correctiveAction: string | null; lessonText: string | null; role: string | null; tags: string[]; costUsd: number }

/** Una llamada de IA (siempre por requirePolicy) que redacta la lección. No cambia la lección: devuelve el borrador. */
export async function draftLesson(slug: string, lessonId: string, opts: { authorized: boolean; extraEvidence?: string; kind?: string }): Promise<LessonDraft> {
  if (!opts.authorized) throw Object.assign(new Error('Redactar una lección llama a la IA: requiere autorización explícita.'), { statusCode: 403 });
  const l = lessonsRepo(slug).get(lessonId); if (!l) throw Object.assign(new Error('Lección no encontrada'), { statusCode: 404 });
  const est = estimatePropose(slug, lessonId); const agent = agentsRepo(slug).get(est.agentId)!;
  const providerId = agent.config.provider as ProviderId; const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
  const cc = agentCaller(slug, agent, l.projectId ?? null, 'Propuesta de lección');
  if (!cc && (!cred || prow.status !== 'connected')) throw Object.assign(new Error('El proveedor no está conectado.'), { statusCode: 409 });
  const models: ModelInfo[] = JSON.parse(prow.models_json);
  const { system, user } = buildProposalPrompt(slug, l, opts.extraEvidence ?? '', agent.config.name);
  const startedAt = now();
  requirePolicy('ai_call', { slug, agentId: agent.id, projectId: l.projectId, authorized: opts.authorized });
  const res = await completeWith(cc, providerId, cred, prow, { model: agent.config.model, system, user, maxTokens: 800, effort: 'low', supportsEffort: !!models.find(m => m.id === agent.config.model)?.supportsEffort });
  const cost = (cc ? 0 : costUsd(providerId, agent.config.model, res.inputTokens, res.outputTokens));
  processesRepo(slug).logExecution({ projectId: l.projectId ?? '', agentId: agent.id, kind: opts.kind ?? 'lesson_propose', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
  let j: any = {}; try { j = JSON.parse(res.text.match(/\{[\s\S]*\}/)?.[0] ?? '{}'); } catch { j = {}; }
  const role = ['planner', 'implementer', 'reviewer', 'consultant'].includes(j.role) ? j.role : l.role;
  return { rootCause: String(j.rootCause ?? '').trim() || null, correctiveAction: String(j.correctiveAction ?? '').trim() || null, lessonText: String(j.lessonText ?? '').trim() || null, role, tags: Array.isArray(j.tags) ? Array.from(new Set([...l.tags, ...j.tags.map(String)])).slice(0, 6) : l.tags, costUsd: cost };
}

export async function proposeLesson(slug: string, lessonId: string, opts: { authorized: boolean }): Promise<Lesson> {
  if (!opts.authorized) throw Object.assign(new Error('Proponer una lección llama a la IA: requiere autorización explícita.'), { statusCode: 403 });
  const repo = lessonsRepo(slug); if (!repo.get(lessonId)) throw Object.assign(new Error('Lección no encontrada'), { statusCode: 404 });
  const d = await draftLesson(slug, lessonId, { authorized: true });
  return repo.update(lessonId, { status: 'proposed', rootCause: d.rootCause, correctiveAction: d.correctiveAction, lessonText: d.lessonText, role: d.role, tags: d.tags, source: 'ai' })!;
}

// ---------- 3 · Validación ----------
export function validateLesson(slug: string, id: string, patch: { lessonText?: string; rootCause?: string; correctiveAction?: string; role?: string | null; tags?: string[] } = {}): Lesson {
  const repo = lessonsRepo(slug); const l = repo.get(id); if (!l) throw Object.assign(new Error('Lección no encontrada'), { statusCode: 404 });
  const text = (patch.lessonText ?? l.lessonText ?? '').trim();
  if (text.length < 10) throw Object.assign(new Error('La lección necesita un texto (≥ 10 caracteres) que se inyectará en los prompts.'), { statusCode: 400 });
  // Una retirada (refutada) que corriges es una versión NUEVA: empieza sin pruebas (la anterior conserva su historial).
  const res = (l.status === 'validated' || l.status === 'refuted')
    ? repo.newVersion(id, { lessonText: text, rootCause: patch.rootCause ?? l.rootCause, correctiveAction: patch.correctiveAction ?? l.correctiveAction, role: patch.role === undefined ? l.role : patch.role, tags: patch.tags ?? l.tags })
    : repo.update(id, { status: 'validated', lessonText: text, rootCause: patch.rootCause ?? l.rootCause, correctiveAction: patch.correctiveAction ?? l.correctiveAction, role: patch.role === undefined ? l.role : patch.role, tags: patch.tags ?? l.tags, validatedAt: now(), source: l.source === 'detector' ? 'owner' : l.source })!;
  syncLessonPracticesSafe(slug); // EN-020: llega sola a la plantilla y a los agentes
  return repo.get(res.id) ?? res;
}
export function setLessonStatus(slug: string, id: string, status: 'rejected' | 'obsolete'): Lesson {
  const repo = lessonsRepo(slug); if (!repo.get(id)) throw Object.assign(new Error('Lección no encontrada'), { statusCode: 404 });
  const res = repo.update(id, { status })!;
  syncLessonPracticesSafe(slug); // sale de la práctica de la plantilla
  return repo.get(id) ?? res;
}
/** Lección escrita a mano por el propietario (queda validada directamente: la escribió él). */
export function createManualLesson(slug: string, input: { projectId: string | null; title: string; lessonText: string; role?: string | null; tags?: string[]; correctiveAction?: string | null }): Lesson {
  const repo = lessonsRepo(slug);
  const l = repo.insert({ projectId: input.projectId, role: input.role ?? null, tags: input.tags ?? [], status: 'validated', version: 1, parentId: null, title: input.title, detector: 'manual', evidence: { processId: null, processTitle: null, stepId: null, agentId: null, agentName: null, file: null, detail: 'Escrita por el propietario.', at: now() }, rootCause: null, correctiveAction: input.correctiveAction ?? null, lessonText: input.lessonText, source: 'owner', promotedTo: null, dedupeKey: null })!;
  const res = repo.update(l.id, { validatedAt: now() })!;
  syncLessonPracticesSafe(slug);
  return repo.get(l.id) ?? res;
}

// ---------- 4 · Recuperación e inyección ----------
export function lessonsFor(slug: string, q: { projectId: string | null; role: TeamRole | null; tags?: string[]; limit?: number }): Lesson[] {
  const all = lessonsRepo(slug).list(q.projectId ?? null, 'validated').filter(l => !l.role || l.role === q.role);
  const tagScore = (l: Lesson) => (q.tags ?? []).filter(t => l.tags.includes(t)).length;
  const sorted = all.sort((a, b) => tagScore(b) - tagScore(a) || b.version - a.version || b.usedCount - a.usedCount);
  return q.limit ? sorted.slice(0, q.limit) : sorted; // EN-020: sin tope por defecto
}
/** Lecciones que no van ya como práctica (por id o por texto idéntico): cada texto llega una sola vez al prompt. */
function withoutPractices(ls: Lesson[], practices: { id: string; text: string }[]): Lesson[] {
  const ids = new Set(practices.map(p => p.id.split(':').slice(2).join(':')).filter(Boolean));
  const texts = new Set(practices.map(p => p.text.trim()));
  const seen = new Set<string>();
  return ls.filter(l => { const t = (l.lessonText ?? '').trim(); if (ids.has(l.id) || texts.has(t) || seen.has(t)) return false; seen.add(t); return true; });
}
const practicesBlock = (practices: { id: string; text: string }[]) => practices.length ? `\n\n# Prácticas de la organización (plantilla)\n${practices.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}\n` : '';
export function lessonsBlock(lessons: Lesson[]): string {
  if (!lessons.length) return '';
  return `\n\n# Lecciones de esta organización (obligatorias)\n${lessons.map((l, i) => `${i + 1}. ${l.lessonText}`).join('\n')}\n`;
}
/** Inyecta en el prompt de sistema y deja constancia en el paso. Devuelve el sistema aumentado. */
export function injectLessons(slug: string, stepId: string, system: string, q: { projectId: string | null; role: TeamRole | null; tags?: string[] }, practices: { id: string; text: string }[] = []): { system: string; used: string[] } {
  const ls = withoutPractices(lessonsFor(slug, q), practices);
  const used = [...ls.map(l => l.id), ...practices.map(p => p.id)];
  if (used.length) { processesRepo(slug).setStepLessons(stepId, used); lessonsRepo(slug).bumpUsed(realLessonIds(used)); }
  return { system: system + lessonsBlock(ls) + practicesBlock(practices), used };
}
/**
 * Lecciones y prácticas del papel para el chat de un agente o un análisis delegado (no toca pasos): devuelve el bloque
 * para el prompt de sistema y los ids usados (lecciones y `practice:<key>@<v>:<lessonId>`) para registrarlos.
 */
export function buildLessonContext(slug: string, q: { projectId: string | null; role: TeamRole | null; agent?: Agent | null; tags?: string[] }): { block: string; used: string[] } {
  const practices = q.agent ? practicesFor(slug, q.agent) : [];
  const ls = withoutPractices(lessonsFor(slug, { projectId: q.projectId, role: q.role, tags: q.tags }), practices);
  const used = [...ls.map(l => l.id), ...practices.map(p => p.id)];
  if (used.length) lessonsRepo(slug).bumpUsed(realLessonIds(used));
  return { block: lessonsBlock(ls) + practicesBlock(practices), used };
}

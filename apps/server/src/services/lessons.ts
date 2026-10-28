import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Lesson, LessonEvidence, LessonStatus, ModelInfo, Process, ProviderId, TeamRole } from '@portal-ia/domain';
import { costUsd, estimatePricing, getAdapter } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, processesRepo, workspaceDb } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';
import { requirePolicy } from './executionPolicy.ts';

/**
 * Aprendizaje organizacional validado (M4).
 *  1. DETECCIÓN determinista (sin IA) de errores objetivos en un proceso → lección «detectada» con evidencia.
 *  2. PROPUESTA (una llamada de IA, solo con autorización) de causa raíz y acción correctiva → «propuesta».
 *  3. VALIDACIÓN por el propietario (edita si quiere) → «validada». Solo las validadas se inyectan en los prompts.
 *  4. INYECCIÓN por papel/proyecto en los pasos de historias; cada paso registra qué lecciones usó (`lessons_used`).
 *  5. REINCIDENCIA: si el mismo detector vuelve a saltar en un paso que ya tenía la lección inyectada, se cuenta y la
 *     lección pasa a «candidata a obsoleta» (reincidencias > 0) para que el propietario la revise.
 */
const now = () => new Date().toISOString();

export function ensureLessonsTable(slug: string) {
  const db = workspaceDb(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY, project_id TEXT, role TEXT, tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, parent_id TEXT,
    title TEXT NOT NULL, detector TEXT NOT NULL, dedupe_key TEXT, evidence_json TEXT NOT NULL, root_cause TEXT, corrective_action TEXT, lesson_text TEXT,
    source TEXT NOT NULL DEFAULT 'detector', used_count INTEGER NOT NULL DEFAULT 0, recurrence_count INTEGER NOT NULL DEFAULT 0, promoted_to TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, validated_at TEXT
  ); CREATE INDEX IF NOT EXISTS lessons_status ON lessons(status); CREATE UNIQUE INDEX IF NOT EXISTS lessons_dedupe ON lessons(dedupe_key);`);
  return db;
}

const map = (r: any): Lesson => ({ id: r.id, projectId: r.project_id, role: r.role, tags: JSON.parse(r.tags || '[]'), status: r.status, version: r.version, parentId: r.parent_id, title: r.title, detector: r.detector, evidence: JSON.parse(r.evidence_json), rootCause: r.root_cause, correctiveAction: r.corrective_action, lessonText: r.lesson_text, source: r.source, usedCount: r.used_count, recurrenceCount: r.recurrence_count, promotedTo: r.promoted_to, createdAt: r.created_at, updatedAt: r.updated_at, validatedAt: r.validated_at });

export function lessonsRepo(slug: string) {
  const db = ensureLessonsTable(slug);
  return {
    list(projectId?: string | null, status?: LessonStatus | null): Lesson[] {
      const rows = db.prepare(`SELECT * FROM lessons WHERE (? IS NULL OR project_id IS NULL OR project_id = ?) AND (? IS NULL OR status = ?) ORDER BY updated_at DESC`).all(projectId ?? null, projectId ?? null, status ?? null, status ?? null) as any[];
      return rows.map(map);
    },
    get(id: string): Lesson | undefined { const r = db.prepare(`SELECT * FROM lessons WHERE id = ?`).get(id); return r ? map(r) : undefined; },
    insert(l: Omit<Lesson, 'id' | 'createdAt' | 'updatedAt' | 'usedCount' | 'recurrenceCount' | 'validatedAt'> & { dedupeKey?: string | null }): Lesson | null {
      const id = crypto.randomUUID(); const ts = now();
      try {
        db.prepare(`INSERT INTO lessons (id, project_id, role, tags, status, version, parent_id, title, detector, dedupe_key, evidence_json, root_cause, corrective_action, lesson_text, source, promoted_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, l.projectId, l.role, JSON.stringify(l.tags), l.status, l.version, l.parentId ?? null, l.title, l.detector, l.dedupeKey ?? null, JSON.stringify(l.evidence), l.rootCause ?? null, l.correctiveAction ?? null, l.lessonText ?? null, l.source, l.promotedTo ?? null, ts, ts);
      } catch (e: any) { if (/UNIQUE/.test(e.message)) return null; throw e; }
      return this.get(id)!;
    },
    update(id: string, patch: Partial<{ status: LessonStatus; rootCause: string | null; correctiveAction: string | null; lessonText: string | null; role: string | null; tags: string[]; validatedAt: string | null; promotedTo: string | null; source: string }>) {
      const cur = this.get(id); if (!cur) return undefined;
      const n = { ...cur, ...patch };
      db.prepare(`UPDATE lessons SET status = ?, root_cause = ?, corrective_action = ?, lesson_text = ?, role = ?, tags = ?, validated_at = ?, promoted_to = ?, source = ?, updated_at = ? WHERE id = ?`)
        .run(n.status, n.rootCause, n.correctiveAction, n.lessonText, n.role, JSON.stringify(n.tags), n.validatedAt, n.promotedTo, n.source, now(), id);
      return this.get(id)!;
    },
    bumpUsed(ids: string[]) { const st = db.prepare(`UPDATE lessons SET used_count = used_count + 1 WHERE id = ?`); for (const id of ids) st.run(id); },
    bumpRecurrence(id: string) { db.prepare(`UPDATE lessons SET recurrence_count = recurrence_count + 1, updated_at = ? WHERE id = ?`).run(now(), id); },
    /** Nueva versión de una lección validada (la anterior queda «obsoleta» con enlace). */
    newVersion(id: string, patch: { lessonText?: string | null; rootCause?: string | null; correctiveAction?: string | null; role?: string | null; tags?: string[] }): Lesson {
      const cur = this.get(id)!;
      const v = this.insert({ ...cur, ...patch, version: cur.version + 1, parentId: cur.id, status: 'validated', source: 'owner', dedupeKey: null, promotedTo: null })!;
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
  for (const c of r?.changes ?? []) {
    if (c.error && /no aparece|aparece más de una vez|búsqueda está vacía|no existe en el repositorio/.test(c.error)) out.push({ detector: 'patch_mismatch', title: `Parche que no encaja en ${c.path}`, role: 'implementer', tags: ['patch', 'implementar'], evidence: ev(c.path, c.error), dedupeKey: key('patch_mismatch', c.path) });
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
  const lastV = ['typecheck', 'test', 'build'].map(c => (r?.verifications ?? []).filter(v => v.command === c).at(-1)).filter(v => v && v.exitCode !== 0 && v.isolation !== 'unavailable');
  for (const v of lastV) out.push({ detector: 'verification_failed', title: `Verificación fallida: ${v!.command}`, role: 'implementer', tags: ['verify', v!.command, 'implementar'], evidence: ev(null, v!.output.slice(-600)), dedupeKey: key(`verification_failed:${v!.command}`, null) });
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
  return out;
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

/** Detecta y guarda (sin IA). Devuelve las lecciones nuevas. Contabiliza reincidencias de lecciones ya inyectadas en el paso. */
export function recordDetections(slug: string, processId: string, repoPath: string | null, extra: Parameters<typeof detectInProcess>[3] = {}): Lesson[] {
  const proc = processesRepo(slug).get(processId); if (!proc) return [];
  const repo = lessonsRepo(slug); const created: Lesson[] = [];
  for (const d of detectInProcess(slug, proc, repoPath, extra)) {
    const step = proc.steps.find(s => s.id === d.evidence.stepId);
    // Reincidencia: una lección validada con la misma etiqueta de detector ya iba inyectada en ese paso.
    for (const id of step?.lessonsUsed ?? []) { const l = repo.get(id); if (l && l.status === 'validated' && (l.detector === d.detector || l.tags.includes(d.detector))) repo.bumpRecurrence(id); }
    const l = repo.insert({ projectId: proc.projectId, role: d.role, tags: d.tags, status: 'detected', version: 1, parentId: null, title: d.title, detector: d.detector, evidence: d.evidence, rootCause: null, correctiveAction: null, lessonText: null, source: 'detector', promotedTo: null, dedupeKey: d.dedupeKey });
    if (l) created.push(l);
  }
  return created;
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

export async function proposeLesson(slug: string, lessonId: string, opts: { authorized: boolean }): Promise<Lesson> {
  if (!opts.authorized) throw Object.assign(new Error('Proponer una lección llama a la IA: requiere autorización explícita.'), { statusCode: 403 });
  const repo = lessonsRepo(slug); const l = repo.get(lessonId); if (!l) throw Object.assign(new Error('Lección no encontrada'), { statusCode: 404 });
  const est = estimatePropose(slug, lessonId); const agent = agentsRepo(slug).get(est.agentId)!;
  const providerId = agent.config.provider as ProviderId; const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
  if (!cred || prow.status !== 'connected') throw Object.assign(new Error('El proveedor no está conectado.'), { statusCode: 409 });
  const models: ModelInfo[] = JSON.parse(prow.models_json);
  const proc = l.evidence.processId ? processesRepo(slug).get(l.evidence.processId) : undefined;
  const stepOut = proc?.steps.find(s => s.id === l.evidence.stepId)?.outputMd?.slice(0, 6000) ?? '';
  const system = `Eres «${agent.config.name}» en Portal IA. Analizas un error objetivo detectado en la ejecución de una historia y redactas una lección breve y accionable para que el equipo de agentes no lo repita. Responde SOLO con JSON.`;
  const user = `Error detectado: ${l.title} (detector ${l.detector}).
Evidencia: ${l.evidence.detail}
Archivo: ${l.evidence.file ?? '—'} · Agente: ${l.evidence.agentName ?? '—'} · Proceso: ${l.evidence.processTitle ?? l.evidence.processId}
${stepOut ? `Salida del paso (recortada):\n${stepOut}` : ''}

Responde SOLO con JSON: {"rootCause": string (1-2 frases), "correctiveAction": string (1-2 frases, concreta), "lessonText": string (instrucción imperativa de 1-3 frases que se añadirá al prompt del agente en futuras historias; sin referencias a este caso concreto), "role": "planner"|"implementer"|"reviewer"|"consultant", "tags": string[1-4]}`;
  const startedAt = now();
  requirePolicy('ai_call', { slug, agentId: agent.id, projectId: l.projectId, authorized: true });
  const res = await getAdapter(providerId)!.complete(decryptSecret(cred.ciphertext), { workspaceId: prow.workspace_id }, { model: agent.config.model, system, user, maxTokens: 800, effort: 'low', supportsEffort: !!models.find(m => m.id === agent.config.model)?.supportsEffort });
  const cost = costUsd(providerId, agent.config.model, res.inputTokens, res.outputTokens);
  processesRepo(slug).logExecution({ projectId: l.projectId ?? '', agentId: agent.id, kind: 'lesson_propose', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
  let j: any = {}; try { j = JSON.parse(res.text.match(/\{[\s\S]*\}/)?.[0] ?? '{}'); } catch { j = {}; }
  const role = ['planner', 'implementer', 'reviewer', 'consultant'].includes(j.role) ? j.role : l.role;
  return repo.update(lessonId, { status: 'proposed', rootCause: String(j.rootCause ?? '').trim() || null, correctiveAction: String(j.correctiveAction ?? '').trim() || null, lessonText: String(j.lessonText ?? '').trim() || null, role, tags: Array.isArray(j.tags) ? Array.from(new Set([...l.tags, ...j.tags.map(String)])).slice(0, 6) : l.tags, source: 'ai' })!;
}

// ---------- 3 · Validación ----------
export function validateLesson(slug: string, id: string, patch: { lessonText?: string; rootCause?: string; correctiveAction?: string; role?: string | null; tags?: string[] } = {}): Lesson {
  const repo = lessonsRepo(slug); const l = repo.get(id); if (!l) throw Object.assign(new Error('Lección no encontrada'), { statusCode: 404 });
  const text = (patch.lessonText ?? l.lessonText ?? '').trim();
  if (text.length < 10) throw Object.assign(new Error('La lección necesita un texto (≥ 10 caracteres) que se inyectará en los prompts.'), { statusCode: 400 });
  if (l.status === 'validated') return repo.newVersion(id, { lessonText: text, rootCause: patch.rootCause ?? l.rootCause, correctiveAction: patch.correctiveAction ?? l.correctiveAction, role: patch.role === undefined ? l.role : patch.role, tags: patch.tags ?? l.tags });
  return repo.update(id, { status: 'validated', lessonText: text, rootCause: patch.rootCause ?? l.rootCause, correctiveAction: patch.correctiveAction ?? l.correctiveAction, role: patch.role === undefined ? l.role : patch.role, tags: patch.tags ?? l.tags, validatedAt: now(), source: l.source === 'detector' ? 'owner' : l.source })!;
}
export function setLessonStatus(slug: string, id: string, status: 'rejected' | 'obsolete'): Lesson {
  const repo = lessonsRepo(slug); if (!repo.get(id)) throw Object.assign(new Error('Lección no encontrada'), { statusCode: 404 });
  return repo.update(id, { status })!;
}
/** Lección escrita a mano por el propietario (queda validada directamente: la escribió él). */
export function createManualLesson(slug: string, input: { projectId: string | null; title: string; lessonText: string; role?: string | null; tags?: string[]; correctiveAction?: string | null }): Lesson {
  const repo = lessonsRepo(slug);
  const l = repo.insert({ projectId: input.projectId, role: input.role ?? null, tags: input.tags ?? [], status: 'validated', version: 1, parentId: null, title: input.title, detector: 'manual', evidence: { processId: null, processTitle: null, stepId: null, agentId: null, agentName: null, file: null, detail: 'Escrita por el propietario.', at: now() }, rootCause: null, correctiveAction: input.correctiveAction ?? null, lessonText: input.lessonText, source: 'owner', promotedTo: null, dedupeKey: null })!;
  return repo.update(l.id, { validatedAt: now() })!;
}

// ---------- 4 · Recuperación e inyección ----------
export function lessonsFor(slug: string, q: { projectId: string | null; role: TeamRole | null; tags?: string[]; limit?: number }): Lesson[] {
  const all = lessonsRepo(slug).list(q.projectId ?? null, 'validated').filter(l => !l.role || l.role === q.role);
  const tagScore = (l: Lesson) => (q.tags ?? []).filter(t => l.tags.includes(t)).length;
  return all.sort((a, b) => tagScore(b) - tagScore(a) || b.version - a.version || b.usedCount - a.usedCount).slice(0, q.limit ?? 8);
}
export function lessonsBlock(lessons: Lesson[]): string {
  if (!lessons.length) return '';
  return `\n\n# Lecciones de esta organización (obligatorias)\n${lessons.map((l, i) => `${i + 1}. ${l.lessonText}`).join('\n')}\n`;
}
/** Inyecta en el prompt de sistema y deja constancia en el paso. Devuelve el sistema aumentado. */
export function injectLessons(slug: string, stepId: string, system: string, q: { projectId: string | null; role: TeamRole | null; tags?: string[] }, practices: { id: string; text: string }[] = []): { system: string; used: string[] } {
  const ls = lessonsFor(slug, q);
  const used = [...ls.map(l => l.id), ...practices.map(p => p.id)];
  if (used.length) { processesRepo(slug).setStepLessons(stepId, used); lessonsRepo(slug).bumpUsed(ls.map(l => l.id)); }
  const practiceBlock = practices.length ? `\n\n# Prácticas de la organización (plantilla)\n${practices.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}\n` : '';
  return { system: system + lessonsBlock(ls) + practiceBlock, used };
}

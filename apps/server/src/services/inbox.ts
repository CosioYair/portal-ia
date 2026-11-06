import type { FastifyInstance } from 'fastify';
import { DEFAULT_PIPELINE, assignmentPendingState } from '@portal-ia/domain';
import type { AssignmentPendingKind } from '@portal-ia/domain';
import { assignmentsRepo } from '../db/assignments.ts';
import type { DecisionVerdict, InboxDecisionResult, PendingDecision, PendingDecisionKind, PendingDecisionsSummary, Process, RestoreSupersededResult, StoryDecisionHistory, SupersededDecision } from '@portal-ia/domain';
import { backlogRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { ensureOpsParsed } from './delegation.ts';
import { config } from '../config.ts';
import { processVersion } from './revision.ts';
import { InboxError } from './inboxError.ts';
import { remoteInclusionChecker } from './publishedSync.ts';

/** Error con código HTTP para que la ruta lo traduzca tal cual (definido en inboxError.ts; misma clase). */
export { InboxError };

const money = (n: number) => `${n.toFixed(2).replace('.', ',')} USD`;

/** Presupuesto que se autoriza al aprobar desde la bandeja: el ya fijado en el proceso o el estimado con un 50 % de margen. */
export function authorizationBudget(p: Process): number {
  const raw = p.budgetUsd > 0 ? p.budgetUsd : p.estimatedUsd * 1.5;
  return Math.max(0.01, Math.ceil(Number((raw * 100).toFixed(6))) / 100);
}

function diffLines(diff: string | null): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of (diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

const OP_NAMES: Record<string, string> = { add: 'añadir', update: 'modificar', discard: 'descartar', merge: 'fusionar', reprioritize: 'repriorizar' };

function requestedBy(p: Process): string {
  return p.delegation?.leadAgentName ?? p.steps[0]?.agentName ?? 'Equipo de agentes';
}

/**
 * Función pura: qué decisiones del propietario espera un proceso (como máximo una a la vez). `inRemote` (opcional,
 * precalculado sin red) indica si lo integrado ya está en la referencia local del remoto: entonces no se pide «Publicar».
 */
export function decisionsFromProcess(slug: string, p: Process, inRemote?: (p: Process) => boolean): PendingDecision[] {
  const make = (kind: PendingDecisionKind, createdAt: string, extra: Pick<PendingDecision, 'estimatedCost' | 'impact' | 'approveEffect' | 'denyEffect'>): PendingDecision => ({
    id: `${kind}:${p.id}`, kind, title: p.title, workspaceSlug: slug, projectId: p.projectId, processId: p.id, requestedBy: requestedBy(p), createdAt,
    storyId: p.backlogItemId ?? null, iteration: null, supersededCount: 0, ...extra, processVersion: processVersion(p)
  });

  if (p.status === 'pending_authorization') {
    const budget = authorizationBudget(p);
    return [make('process_authorization', p.createdAt, {
      estimatedCost: { usd: p.estimatedUsd, budgetUsd: budget },
      impact: `Estimado ${money(p.estimatedUsd)} · presupuesto máximo a autorizar ${money(budget)} · ${p.steps.length} paso${p.steps.length === 1 ? '' : 's'} con agentes de IA.`,
      approveEffect: p.kind === 'story_execution'
        ? `Se autoriza el proceso con un presupuesto máximo de ${money(budget)}: el equipo implementa, aplica en un worktree aislado, verifica en el sandbox (typecheck, test, build), QA valida con evidencia y corrige errores rutinarios dentro de ese presupuesto. No integra, no reinicia el Portal ni publica: eso sigue siendo tu decisión.`
        : `Se autoriza el proceso con un presupuesto máximo de ${money(budget)}; empezará a ejecutarse y consumirá IA.`,
      denyEffect: 'Se cancela el proceso; no se consume IA.'
    })];
  }

  const r = p.result;
  if (p.kind === 'story_execution' && p.status === 'done' && r) {
    if (!r.applied && !r.rejected && r.changes.some(c => !c.error)) {
      const ok = r.changes.filter(c => !c.error);
      const bad = r.changes.length - ok.length;
      const lines = ok.reduce((acc, c) => { const d = diffLines(c.diff); return { added: acc.added + d.added, removed: acc.removed + d.removed }; }, { added: 0, removed: 0 });
      return [make('apply_diff', p.finishedAt ?? p.createdAt, {
        estimatedCost: null,
        impact: `${ok.length} archivo${ok.length === 1 ? '' : 's'} · +${lines.added} −${lines.removed} líneas${bad ? ` · ${bad} cambio${bad === 1 ? '' : 's'} con problemas que no se aplicarán` : ''}.`,
        approveEffect: 'Se aplican los cambios en una rama nueva del repositorio, sin tocar la rama principal.',
        denyEffect: p.assignmentId ? 'Se rechaza el diff: no se aplica y el encargo queda esperando tu decisión.' : 'Se rechaza el diff: no se aplica y la historia vuelve a pendiente.'
      })];
    }
    if (r.applied && !r.merged && !r.rejected) {
      return [make('integrate', r.applied.appliedAt, {
        estimatedCost: null,
        impact: `Integrar la rama ${r.applied.branch} (${r.applied.files.length} archivo${r.applied.files.length === 1 ? '' : 's'}) en la rama principal.`,
        approveEffect: 'Se fusiona la rama en la rama principal (git merge).',
        denyEffect: null
      })];
    }
    if (r.merged && !r.published && !inRemote?.(p)) {
      return [make('publish', r.merged.mergedAt, {
        estimatedCost: null,
        impact: `Publicar en el remoto lo integrado en ${r.merged.into}${r.applied ? ` (rama ${r.applied.branch})` : ''}.`,
        approveEffect: 'Se publican las ramas en el remoto (git push).',
        denyEffect: null
      })];
    }
  }

  const d = p.delegation;
  if (p.kind === 'delegated_task' && p.status === 'done' && d && d.backlogOps.length > 0 && !d.opsApplied) {
    const counts: Record<string, number> = {};
    for (const op of d.backlogOps) counts[op.op] = (counts[op.op] ?? 0) + 1;
    const summary = Object.entries(counts).map(([op, n]) => `${n} ${OP_NAMES[op] ?? op}`).join(', ');
    return [make('backlog_proposal', p.finishedAt ?? p.createdAt, {
      estimatedCost: null,
      impact: `${d.backlogOps.length} cambio${d.backlogOps.length === 1 ? '' : 's'} propuesto${d.backlogOps.length === 1 ? '' : 's'} al backlog: ${summary}.`,
      approveEffect: 'Se aplican las operaciones propuestas al backlog del proyecto.',
      denyEffect: null
    })];
  }
  return [];
}

// ---- HU-161 · Una autorización vigente por historia ----
/** Elemento de trabajo de un proceso de ejecución (historia o encargo): las iteraciones se agrupan por él. */
const storyKey = (p: Process): string | null => (p.kind === 'story_execution' ? p.backlogItemId ?? p.assignmentId ?? null : null);
const byAge = (a: Process, b: Process) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Número de iteración (1..N por fecha de creación) de cada proceso de historia. */
export function iterationNumbers(processes: Process[]): Map<string, number> {
  const byStory = new Map<string, Process[]>();
  for (const p of processes) {
    const key = storyKey(p);
    if (!key) continue;
    const list = byStory.get(key) ?? []; list.push(p); byStory.set(key, list);
  }
  const out = new Map<string, number>();
  for (const list of byStory.values()) [...list].sort(byAge).forEach((p, i) => out.set(p.id, i + 1));
  return out;
}

type Entry = { p: Process; d: PendingDecision };

/** Agrupa las decisiones por historia: la vigente es la iteración más reciente no marcada como superada. */
function storyGroups(slug: string, processes: Process[], all: Process[], inRemote?: (p: Process) => boolean) {
  const iters = iterationNumbers(all);
  const loose: PendingDecision[] = [];
  const groups = new Map<string, Entry[]>();
  for (const p of processes) {
    const key = storyKey(p);
    for (const d of decisionsFromProcess(slug, p, inRemote)) {
      if (!key) { loose.push(d); continue; }
      const list = groups.get(key) ?? [];
      list.push({ p, d: { ...d, iteration: iters.get(p.id) ?? null } });
      groups.set(key, list);
    }
  }
  const stories = new Map<string, { current: Entry | null; superseded: Entry[] }>();
  for (const [key, list] of groups) {
    list.sort((a, b) => byAge(a.p, b.p));
    // Por precaución, aunque una iteración anterior no esté marcada, solo la más reciente sin marcar es la vigente.
    const current = list.filter(e => !e.p.supersededBy).at(-1) ?? null;
    stories.set(key, { current, superseded: list.filter(e => e !== current) });
  }
  return { loose, stories, iters };
}

/**
 * Función pura: como máximo una decisión pendiente por historia (la iteración vigente, con su número y el recuento
 * de superadas). Los procesos sin historia (evaluaciones, encargos) no se agrupan. `all` sirve para numerar iteraciones.
 */
export function consolidateDecisions(slug: string, processes: Process[], all: Process[] = processes, inRemote?: (p: Process) => boolean): PendingDecision[] {
  const { loose, stories } = storyGroups(slug, processes, all, inRemote);
  const out = [...loose];
  for (const g of stories.values()) if (g.current) out.push({ ...g.current.d, supersededCount: g.superseded.length });
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Función pura (invariante de HU-161): número de historias (storyId no nulo) que aparecen más de una vez en la lista
 * recibida. Sobre la salida final de la bandeja debe ser 0. Con una lista sin consolidar que tenga duplicados, es mayor que 0.
 */
export function countStoriesWithMultipleCurrent(decisions: PendingDecision[]): number {
  const seen = new Map<string, number>();
  for (const d of decisions) if (d.storyId) seen.set(d.storyId, (seen.get(d.storyId) ?? 0) + 1);
  let n = 0;
  for (const c of seen.values()) if (c > 1) n++;
  return n;
}

/**
 * Función pura: historias con más de una decisión pendiente entre procesos vigentes, es decir, sin supersededBy y sin
 * archivar. Si es mayor que 0, falta consolidar (migrar) las duplicadas en la base.
 */
export function unmarkedDuplicates(slug: string, processes: Process[]): number {
  const perStory = new Map<string, number>();
  for (const p of processes) {
    if (p.supersededBy || p.archivedAt) continue;
    const key = storyKey(p);
    if (!key) continue;
    const n = decisionsFromProcess(slug, p).length;
    if (n > 0) perStory.set(key, (perStory.get(key) ?? 0) + n);
  }
  let out = 0;
  for (const c of perStory.values()) if (c > 1) out++;
  return out;
}

/** Si la decisión de un proceso de historia está superada, el motivo para el 409; null si es la vigente. */
function supersededMessage(slug: string, p: Process): string | null {
  const key = storyKey(p);
  if (!key) return null;
  const all = p.assignmentId ? processesRepo(slug).listByAssignment(p.assignmentId) : processesRepo(slug).listByBacklogItem(key);
  const self = all.find(x => x.id === p.id) ?? p;
  const { stories, iters } = storyGroups(slug, all.filter(x => !x.archivedAt), all);
  const g = stories.get(key);
  if (!self.supersededBy && (self.archivedAt || !g?.current || g.current.p.id === p.id)) return null;
  const byId = self.supersededBy ?? g?.current?.p.id ?? null;
  const n = byId ? iters.get(byId) : undefined;
  return `Esta autorización fue superada por la iteración ${n ?? 'más reciente'} de la historia: decide sobre la vigente o restáurala desde el historial.`;
}

/**
 * Guardia compartida (bandeja, chat, vista del proceso): lanza 409 si el proceso es una iteración superada de su historia.
 * Solo actúa si el proceso está marcado como superado o espera una decisión propia; no tiene efectos ni consume IA.
 */
export function assertNotSuperseded(slug: string, p: Process): void {
  if (!p.supersededBy && decisionsFromProcess(slug, p).length === 0) return;
  const msg = supersededMessage(slug, p);
  if (msg) throw new InboxError(409, msg);
}

type Call = { status: number; body: Record<string, any> | null };

/**
 * Llamada interna a la API del Portal. Decidir aquí ejecuta la misma acción que su pantalla, por su misma ruta (con sus
 * comprobaciones): con las credenciales del propietario que decidió (`auth`), sin otra vía ni otra identidad.
 */
async function call(app: FastifyInstance, method: 'GET' | 'POST', url: string, payload?: unknown, auth: Record<string, string> = {}): Promise<Call> {
  const res = await app.inject({ method, url, payload: (payload ?? (method === 'POST' ? {} : undefined)) as any, headers: { host: `127.0.0.1:${config.port}`, ...auth } });
  let body: Record<string, any> | null = null;
  try { body = res.body ? JSON.parse(res.body) : null; } catch { body = null; }
  return { status: res.statusCode, body };
}

async function fetchProcess(app: FastifyInstance, slug: string, id: string): Promise<Process | null> {
  const res = await call(app, 'GET', `/api/workspaces/${slug}/processes/${id}`);
  if (res.status === 404) return null;
  if (res.status !== 200 || !res.body) throw new InboxError(res.status, res.body?.error ?? 'No se pudo leer el proceso');
  return res.body as unknown as Process;
}

/**
 * Lista todo lo pendiente del espacio indicado, de más antiguo a más reciente (las más antiguas primero), cada una con su
 * costo e impacto. Solo lee: no cambia nada salvo interpretar (una vez) las propuestas de backlog de un encargo terminado.
 * Lee los procesos SIN el texto de los pasos y directamente de la base (antes pedía el listado completo con su orientación
 * por cada proyecto y lo volvía a leer entero: varios segundos con el servidor bloqueado en cada navegación).
 */
export async function listPendingDecisions(_app: FastifyInstance, slug: string): Promise<PendingDecision[]> {
  const out: PendingDecision[] = [];
  const repo = processesRepo(slug);
  for (const project of projectsRepo(slug).list()) {
    // Todas las iteraciones (también archivadas) para numerar; las vigentes (sin archivar) para decidir.
    const all = repo.listLight(project.id, { archived: true });
    const active = all.filter(p => !p.archivedAt).map(p => p.kind === 'delegated_task' && p.status === 'done' ? ensureOpsParsed(slug, p) : p);
    // EN-009: si lo integrado ya está en la referencia LOCAL del remoto (sin fetch), no se pide «Publicar».
    // Solo se consulta git si hay procesos integrados sin publicar; la caché dura esta llamada.
    const pendingPublish = active.filter(p => p.kind === 'story_execution' && p.status === 'done' && !!p.result?.merged && !p.result?.published);
    let inRemote: ((p: Process) => boolean) | undefined;
    const repoInfo = pendingPublish.length ? projectsRepo(slug).repository(project.id) : null;
    if (repoInfo) {
      try {
        const check = await remoteInclusionChecker(repoInfo.path);
        const included = new Set<string>();
        for (const p of pendingPublish) if (await check(p.result!.merged!.commit, p.result!.merged!.into)) included.add(p.id);
        if (included.size) inRemote = (p: Process) => included.has(p.id);
      } catch { /* sin repositorio legible: la bandeja sigue como antes */ }
    }
    out.push(...consolidateDecisions(slug, active, all, inRemote));
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---- EN-012 · Encargos pendientes del propietario (misma regla que el Asistente y la tarjeta) ----
/** Encargo que espera al propietario en Decisiones: no es una decisión de proceso (no se decide con decide()). */
export interface AssignmentPendingItem {
  id: string; kind: Extract<AssignmentPendingKind, 'awaiting_iteration_authorization' | 'merged_awaiting_acceptance'>;
  assignmentId: string; code: string; title: string; workspaceSlug: string; projectId: string; processId: string | null;
  /** Etiqueta única (assignmentPendingState): la misma en el Asistente, Decisiones y la tarjeta. */
  label: string; where: string | null; link: string; note: string | null; createdAt: string;
}

/**
 * Solo lee (sin IA): encargos con una nueva iteración por autorizar (cambios pedidos) o integrados en main a los que
 * falta aceptar. Nada se ejecuta ni se gasta desde aquí: el enlace lleva a /procesos/<id> o a la tarjeta del encargo.
 */
export function assignmentPendingItems(slug: string): AssignmentPendingItem[] {
  const out: AssignmentPendingItem[] = [];
  for (const a of assignmentsRepo(slug).list()) {
    if (a.status === 'accepted' || a.status === 'cancelled' || a.status === 'draft') continue;
    const p = a.processId ? processesRepo(slug).get(a.processId) : undefined;
    const activeProcess = !!p && (p.status === 'running' || p.status === 'pending_authorization');
    const s = assignmentPendingState(a, { merged: p?.result?.merged ? { into: p.result.merged.into } : null, activeProcess, processId: p?.id ?? null });
    if (s.kind !== 'awaiting_iteration_authorization' && s.kind !== 'merged_awaiting_acceptance') continue;
    out.push({
      id: `${s.kind}:${a.id}`, kind: s.kind, assignmentId: a.id, code: a.code, title: a.title, workspaceSlug: slug, projectId: a.projectId, processId: p?.id ?? null,
      label: s.label, where: s.where, link: p ? `/empresa/${slug}/proyecto/${a.projectId}/procesos/${p.id}` : `/empresa/${slug}/proyecto/${a.projectId}/panel`,
      note: s.kind === 'awaiting_iteration_authorization' ? a.iterationNote : null, createdAt: a.updatedAt
    });
  }
  return out.sort((x, y) => x.createdAt.localeCompare(y.createdAt));
}

/** Igual que assignmentPendingItems, con la firma de la bandeja (para la ruta de Decisiones). */
export async function listPendingAssignments(_app: FastifyInstance, slug: string): Promise<AssignmentPendingItem[]> {
  return assignmentPendingItems(slug);
}

/**
 * Resumen de la bandeja (solo lectura). El invariante storiesWithMultipleCurrent se calcula sobre la MISMA salida de
 * listPendingDecisions que ve el propietario. unmarkedDuplicates y supersededPending se calculan sobre la base sin
 * consolidar (repo.listAll por proyecto). Siempre devuelve las seis claves, aunque no haya nada pendiente.
 */
export async function summarizePendingDecisions(app: FastifyInstance, slug: string): Promise<PendingDecisionsSummary> {
  const decisions = await listPendingDecisions(app, slug);
  const stories = new Set(decisions.map(d => d.storyId).filter((s): s is string => !!s));
  const repo = processesRepo(slug);
  let unmarked = 0;
  let supersededPending = 0;
  for (const project of projectsRepo(slug).list()) {
    const all = repo.listLight(project.id, { archived: true });
    unmarked += unmarkedDuplicates(slug, all);
    supersededPending += all.filter(p => p.supersededBy && !p.archivedAt && decisionsFromProcess(slug, p).length > 0).length;
  }
  return {
    total: decisions.length,
    stories: stories.size,
    storiesWithMultipleCurrent: countStoriesWithMultipleCurrent(decisions),
    unmarkedDuplicates: unmarked,
    supersededPending,
    checkedAt: new Date().toISOString()
  };
}

/**
 * Aprueba o deniega una decisión. No reimplementa nada: reenvía a la MISMA ruta que usa la vista del proceso
 * (autorizar, cancelar, aplicar, rechazar, integrar, publicar, aplicar propuestas al backlog), de modo que
 * validaciones, auditoría y efectos son idénticos. Solo comprueba antes que la decisión siga pendiente.
 */
export async function decide(app: FastifyInstance, slug: string, kind: PendingDecisionKind, processId: string, verdict: DecisionVerdict, reason?: string, auth: Record<string, string> = {}, seenVersion?: string): Promise<InboxDecisionResult> {
  const p = await fetchProcess(app, slug, processId);
  if (!p) throw new InboxError(404, 'El proceso no existe.');
  const current = decisionsFromProcess(slug, p).find(d => d.kind === kind);
  if (!current) throw new InboxError(409, 'Esta decisión ya no está pendiente: el proceso cambió de estado.');
  // Se decide sobre lo que viste: si el proceso cambió desde entonces (otra pestaña, el lote, el equipo), no se hace nada.
  if (seenVersion && seenVersion !== ((p as any).version ?? processVersion(p))) throw new InboxError(409, 'Esta decisión cambió desde que la viste (el proceso avanzó): no se ha hecho nada. Revísala de nuevo.');
  const superseded = supersededMessage(slug, p);
  if (superseded) throw new InboxError(409, superseded);
  if (verdict === 'deny' && current.denyEffect === null) throw new InboxError(400, 'Esta decisión no se puede denegar desde aquí: el proceso original tampoco tiene esa acción.');

  const base = `/api/workspaces/${slug}/processes/${processId}`;
  let res: Call;
  switch (kind) {
    case 'process_authorization':
      res = verdict === 'approve'
        ? await call(app, 'POST', `${base}/authorize`, { budgetUsd: authorizationBudget(p), authorized: true, ...(p.kind === 'story_execution' ? { pipeline: DEFAULT_PIPELINE } : {}) }, auth)
        : await call(app, 'POST', `${base}/cancel`, {}, auth);
      break;
    case 'apply_diff':
      res = verdict === 'approve'
        ? await call(app, 'POST', `${base}/apply`, { authorized: true }, auth)
        : await call(app, 'POST', `${base}/reject`, { reason }, auth);
      break;
    case 'integrate':
      res = await call(app, 'POST', `${base}/merge`, { authorized: true }, auth);
      break;
    case 'publish':
      res = await call(app, 'POST', `${base}/publish`, { authorized: true }, auth);
      break;
    case 'backlog_proposal':
      res = await call(app, 'POST', `${base}/backlog-ops/apply`, { authorized: true }, auth);
      break;
  }
  if (res.status < 200 || res.status >= 300) {
    throw new InboxError(res.status >= 500 ? 502 : res.status, String(res.body?.error ?? 'No se pudo registrar la decisión.'));
  }
  return { ok: true, kind, processId, verdict, processStatus: typeof res.body?.status === 'string' ? res.body.status : null };
}

/** Historial de autorizaciones de una historia: la vigente y las superadas (las más recientes primero). Solo lee. */
export function listStoryDecisionHistory(slug: string, storyId: string): StoryDecisionHistory {
  const item = backlogRepo(slug).get(storyId);
  if (!item) throw new InboxError(404, 'La historia no existe.');
  const all = processesRepo(slug).listByBacklogItem(storyId);
  const { stories, iters } = storyGroups(slug, all.filter(p => !p.archivedAt), all);
  const g = stories.get(storyId);
  const current = g?.current ? { ...g.current.d, supersededCount: g.superseded.length } : null;
  const superseded: SupersededDecision[] = (g?.superseded ?? []).map(({ p, d }) => {
    const by = p.supersededBy ?? g?.current?.p.id ?? null;
    return { ...d, supersededBy: by, supersededByIteration: by ? iters.get(by) ?? null : null, supersededAt: p.supersededAt ?? null };
  }).reverse();
  return { storyId, storyCode: item.storyId, current, superseded };
}

/** Restaura una autorización superada (reversible, sin costo de IA); la que era vigente pasa a superada. */
export function restoreSupersededDecision(slug: string, processId: string): RestoreSupersededResult {
  const repo = processesRepo(slug);
  const p = repo.get(processId);
  if (!p) throw new InboxError(404, 'El proceso no existe.');
  if (!p.supersededBy) throw new InboxError(409, 'Esta autorización no está superada: ya es la vigente.');
  if (p.archivedAt) throw new InboxError(409, 'El proceso está archivado: no se puede restaurar su autorización.');
  if (decisionsFromProcess(slug, p).length === 0) throw new InboxError(409, 'Esta autorización ya no tiene ninguna decisión pendiente: no hay nada que restaurar.');
  const r = repo.restoreSuperseded(processId);
  if (!r) throw new InboxError(409, 'Esta autorización no está superada: ya es la vigente.');
  return { ok: true, processId, superseded: r.superseded };
}

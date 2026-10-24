import type { FastifyInstance } from 'fastify';
import type { DecisionVerdict, InboxDecisionResult, PendingDecision, PendingDecisionKind, Process } from '@portal-ia/domain';
import { projectsRepo } from '../db/workspace.ts';

/** Error con código HTTP para que la ruta lo traduzca tal cual. */
export class InboxError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

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

/** Función pura: qué decisiones del propietario espera un proceso (como máximo una a la vez). */
export function decisionsFromProcess(slug: string, p: Process): PendingDecision[] {
  const make = (kind: PendingDecisionKind, createdAt: string, extra: Pick<PendingDecision, 'estimatedCost' | 'impact' | 'approveEffect' | 'denyEffect'>): PendingDecision => ({
    id: `${kind}:${p.id}`, kind, title: p.title, workspaceSlug: slug, projectId: p.projectId, processId: p.id, requestedBy: requestedBy(p), createdAt, ...extra
  });

  if (p.status === 'pending_authorization') {
    const budget = authorizationBudget(p);
    return [make('process_authorization', p.createdAt, {
      estimatedCost: { usd: p.estimatedUsd, budgetUsd: budget },
      impact: `Estimado ${money(p.estimatedUsd)} · presupuesto máximo a autorizar ${money(budget)} · ${p.steps.length} paso${p.steps.length === 1 ? '' : 's'} con agentes de IA.`,
      approveEffect: `Se autoriza el proceso con un presupuesto máximo de ${money(budget)}; empezará a ejecutarse y consumirá IA.`,
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
        denyEffect: 'Se rechaza el diff: no se aplica y la historia vuelve a pendiente.'
      })];
    }
    if (r.applied && !r.merged) {
      return [make('integrate', r.applied.appliedAt, {
        estimatedCost: null,
        impact: `Integrar la rama ${r.applied.branch} (${r.applied.files.length} archivo${r.applied.files.length === 1 ? '' : 's'}) en la rama principal.`,
        approveEffect: 'Se fusiona la rama en la rama principal (git merge).',
        denyEffect: null
      })];
    }
    if (r.merged && !r.published) {
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

type Call = { status: number; body: Record<string, any> | null };

async function call(app: FastifyInstance, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<Call> {
  const res = await app.inject({ method, url, payload: payload as any });
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

/** Lista todo lo pendiente del espacio indicado, de más antiguo a más reciente (las más antiguas primero), cada una con su costo e impacto. Solo lee: no cambia nada. */
export async function listPendingDecisions(app: FastifyInstance, slug: string): Promise<PendingDecision[]> {
  const out: PendingDecision[] = [];
  for (const project of projectsRepo(slug).list()) {
    const res = await call(app, 'GET', `/api/workspaces/${slug}/projects/${project.id}/processes`);
    if (res.status !== 200 || !Array.isArray(res.body)) {
      const code = res.status === 200 || res.status >= 500 ? 502 : res.status;
      throw new InboxError(code, res.body && !Array.isArray(res.body) ? String(res.body.error ?? 'No se pudo leer los procesos') : 'No se pudo leer los procesos');
    }
    for (const listed of res.body as unknown as Process[]) {
      let p = listed;
      // Si el listado viene sin el resultado estructurado, se lee el proceso completo.
      if (p.status === 'done' && p.result === undefined && p.delegation === undefined) p = (await fetchProcess(app, slug, p.id)) ?? p;
      out.push(...decisionsFromProcess(slug, p));
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Aprueba o deniega una decisión. No reimplementa nada: reenvía a la MISMA ruta que usa la vista del proceso
 * (autorizar, cancelar, aplicar, rechazar, integrar, publicar, aplicar propuestas al backlog), de modo que
 * validaciones, auditoría y efectos son idénticos. Solo comprueba antes que la decisión siga pendiente.
 */
export async function decide(app: FastifyInstance, slug: string, kind: PendingDecisionKind, processId: string, verdict: DecisionVerdict, reason?: string): Promise<InboxDecisionResult> {
  const p = await fetchProcess(app, slug, processId);
  if (!p) throw new InboxError(404, 'El proceso no existe.');
  const current = decisionsFromProcess(slug, p).find(d => d.kind === kind);
  if (!current) throw new InboxError(409, 'Esta decisión ya no está pendiente: el proceso cambió de estado.');
  if (verdict === 'deny' && current.denyEffect === null) throw new InboxError(400, 'Esta decisión no se puede denegar desde aquí: el proceso original tampoco tiene esa acción.');

  const base = `/api/workspaces/${slug}/processes/${processId}`;
  let res: Call;
  switch (kind) {
    case 'process_authorization':
      res = verdict === 'approve'
        ? await call(app, 'POST', `${base}/authorize`, { budgetUsd: authorizationBudget(p), authorized: true })
        : await call(app, 'POST', `${base}/cancel`);
      break;
    case 'apply_diff':
      res = verdict === 'approve'
        ? await call(app, 'POST', `${base}/apply`, { authorized: true })
        : await call(app, 'POST', `${base}/reject`, { reason });
      break;
    case 'integrate':
      res = await call(app, 'POST', `${base}/merge`, { authorized: true });
      break;
    case 'publish':
      res = await call(app, 'POST', `${base}/publish`, { authorized: true });
      break;
    case 'backlog_proposal':
      res = await call(app, 'POST', `${base}/backlog-ops/apply`, { authorized: true });
      break;
  }
  if (res.status < 200 || res.status >= 300) {
    throw new InboxError(res.status >= 500 ? 502 : res.status, String(res.body?.error ?? 'No se pudo registrar la decisión.'));
  }
  return { ok: true, kind, processId, verdict, processStatus: typeof res.body?.status === 'string' ? res.body.status : null };
}

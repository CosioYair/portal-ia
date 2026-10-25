import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { projectsRepo } from '../db/workspace.ts';
import { budgetHierarchyFor } from '../services/budget-store.ts';
import { currentPeriod, PERIOD_RE } from '../services/budget-hierarchy.ts';

const paramsSchema = z.object({ level: z.enum(['company', 'project']), id: z.string().min(1).max(100) });
const balanceQuery = z.object({ workspace: z.string().min(1).max(100).optional(), period: z.string().regex(PERIOD_RE).optional() });
const putBody = z.object({
  workspace: z.string().min(1).max(100).optional(),
  period: z.string().regex(PERIOD_RE).optional(),
  limitUsd: z.number().finite().min(0).max(1_000_000),
  authorized: z.literal(true)
});

type Resolved = { slug: string } | { status: number; error: string };

/** Empresa: el id es el slug del espacio. Proyecto: hay que indicar el espacio al que pertenece. */
function resolveSlug(level: 'company' | 'project', id: string, workspace: string | undefined): Resolved {
  if (level === 'company') {
    if (!workspacesRepo.get(id)) return { status: 404, error: 'La empresa no existe.' };
    return { slug: id };
  }
  if (!workspace) return { status: 400, error: 'Indica el espacio (workspace) al que pertenece el proyecto.' };
  if (!workspacesRepo.get(workspace)) return { status: 404, error: 'El espacio no existe.' };
  if (!projectsRepo(workspace).list().some(p => p.id === id)) return { status: 404, error: 'El proyecto no existe en ese espacio.' };
  return { slug: workspace };
}

export async function budgetRoutes(app: FastifyInstance) {
  app.get('/api/budgets/:level/:id/balance', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    const query = balanceQuery.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'Datos no válidos: revisa el ámbito, el identificador y el periodo (AAAA-MM).' });
    const r = resolveSlug(params.data.level, params.data.id, query.data.workspace);
    if (!('slug' in r)) return reply.code(r.status).send({ error: r.error });
    return budgetHierarchyFor(r.slug).getBalance(params.data.level, params.data.id, query.data.period ?? currentPeriod());
  });

  app.put('/api/budgets/:level/:id', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    const body = putBody.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Datos no válidos: indica un importe mensual en USD y confirma explícitamente la acción.' });
    const r = resolveSlug(params.data.level, params.data.id, body.data.workspace);
    if (!('slug' in r)) return reply.code(r.status).send({ error: r.error });
    const period = body.data.period ?? currentPeriod();
    const h = budgetHierarchyFor(r.slug);
    h.setMonthlyBudget(params.data.level, params.data.id, period, Math.round(body.data.limitUsd * 1_000_000));
    return h.getBalance(params.data.level, params.data.id, period);
  });
}

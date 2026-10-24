import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PENDING_DECISION_KINDS } from '@portal-ia/domain';
import { workspacesRepo } from '../db/platform.ts';
import { decide, InboxError, listPendingDecisions } from '../services/inbox.ts';

const slugParams = z.object({ slug: z.string().min(1) });
const decisionParams = z.object({ slug: z.string().min(1), kind: z.enum(PENDING_DECISION_KINDS), processId: z.string().min(1) });
const decisionBody = z.object({ verdict: z.enum(['approve', 'deny']), reason: z.string().max(2000).optional() });

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof InboxError) return reply.code(e.status).send({ error: e.message });
  throw e;
}

export async function inboxRoutes(app: FastifyInstance) {
  // Todo lo que espera al propietario en una sola lista (solo lectura).
  app.get('/api/workspaces/:slug/inbox', async (req, reply) => {
    const params = slugParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Empresa no válida' });
    if (!workspacesRepo.get(params.data.slug)) return reply.code(404).send({ error: 'Empresa no encontrada' });
    try { return await listPendingDecisions(app, params.data.slug); } catch (e) { return fail(reply, e); }
  });

  // Aprobar o denegar una decisión: delega en las mismas rutas del proceso.
  app.post('/api/workspaces/:slug/inbox/:kind/:processId/decision', async (req, reply) => {
    const params = decisionParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Tipo de decisión no válido' });
    const body = decisionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'La decisión debe ser «approve» o «deny»' });
    if (!workspacesRepo.get(params.data.slug)) return reply.code(404).send({ error: 'Empresa no encontrada' });
    try {
      return await decide(app, params.data.slug, params.data.kind, params.data.processId, body.data.verdict, body.data.reason);
    } catch (e) { return fail(reply, e); }
  });
}

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PENDING_DECISION_KINDS } from '@portal-ia/domain';
import { workspacesRepo } from '../db/platform.ts';
import { decide, InboxError, listPendingAssignments, listPendingDecisions, listStoryDecisionHistory, restoreSupersededDecision, summarizePendingDecisions } from '../services/inbox.ts';

const slugParams = z.object({ slug: z.string().min(1) });
const decisionParams = z.object({ slug: z.string().min(1), kind: z.enum(PENDING_DECISION_KINDS), processId: z.string().min(1) });
const decisionBody = z.object({ verdict: z.enum(['approve', 'deny']), reason: z.string().max(2000).optional(), seenVersion: z.string().max(200).optional() });
const storyParams = z.object({ slug: z.string().min(1), id: z.string().min(1) });
const restoreParams = z.object({ slug: z.string().min(1), processId: z.string().min(1) });
const restoreBody = z.object({ authorized: z.literal(true) });

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

  // EN-012 · Encargos que esperan al propietario (iteración por autorizar o integrado sin aceptar). Solo lectura, sin IA.
  // Lista aparte: no son PendingDecision ni se resuelven con decide(); se actúa en la tarjeta del encargo o en su proceso.
  app.get('/api/workspaces/:slug/inbox/assignments', async (req, reply) => {
    const params = slugParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Empresa no válida' });
    if (!workspacesRepo.get(params.data.slug)) return reply.code(404).send({ error: 'Empresa no encontrada' });
    try { return await listPendingAssignments(app, params.data.slug); } catch (e) { return fail(reply, e); }
  });

  // HU-161 · Resumen de la bandeja con el invariante «una autorización vigente por historia» (solo lectura, sin IA).
  // Siempre devuelve total, stories, storiesWithMultipleCurrent, unmarkedDuplicates, supersededPending y checkedAt.
  app.get('/api/workspaces/:slug/inbox/summary', async (req, reply) => {
    const params = slugParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Empresa no válida' });
    if (!workspacesRepo.get(params.data.slug)) return reply.code(404).send({ error: 'Empresa no encontrada' });
    try { return await summarizePendingDecisions(app, params.data.slug); } catch (e) { return fail(reply, e); }
  });

  // Aprobar o denegar una decisión: delega en las mismas rutas del proceso.
  app.post('/api/workspaces/:slug/inbox/:kind/:processId/decision', async (req, reply) => {
    const params = decisionParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Tipo de decisión no válido' });
    const body = decisionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'La decisión debe ser «approve» o «deny»' });
    if (!workspacesRepo.get(params.data.slug)) return reply.code(404).send({ error: 'Empresa no encontrada' });
    try {
      // Las acciones internas van por su ruta con las credenciales de quien decide (la política del propietario ya las validó).
      const auth = Object.fromEntries(['x-portal-owner'].flatMap(k => typeof req.headers[k] === 'string' ? [[k, req.headers[k] as string]] : []));
      return await decide(app, params.data.slug, params.data.kind, params.data.processId, body.data.verdict, body.data.reason, auth, body.data.seenVersion);
    } catch (e) { return fail(reply, e); }
  });

  // HU-161 · Historial de autorizaciones de una historia: la vigente y las superadas (solo lectura).
  app.get('/api/workspaces/:slug/stories/:id/decisions', async (req, reply) => {
    const params = storyParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Historia no válida' });
    if (!workspacesRepo.get(params.data.slug)) return reply.code(404).send({ error: 'Empresa no encontrada' });
    try { return listStoryDecisionHistory(params.data.slug, params.data.id); } catch (e) { return fail(reply, e); }
  });

  // HU-161 · Restaurar una autorización superada (reversible, sin costo de IA); requiere confirmación explícita.
  app.post('/api/workspaces/:slug/inbox/superseded/:processId/restore', async (req, reply) => {
    const params = restoreParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Proceso no válido' });
    const body = restoreBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Restaurar una autorización requiere confirmación explícita (authorized: true).' });
    if (!workspacesRepo.get(params.data.slug)) return reply.code(404).send({ error: 'Empresa no encontrada' });
    try { return restoreSupersededDecision(params.data.slug, params.data.processId); } catch (e) { return fail(reply, e); }
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { backlogRepo } from '../db/workspace.ts';
import { applyProposals, askTeam, estimateAsk, iterateStory, storyContext, tasksFromFeedback, tasksFromIssue, threadRepo } from '../services/storyThread.ts';
import { PolicyError } from '../services/executionPolicy.ts';

/** M6 · Espacio de la historia: contexto, chat con el equipo (autorizado), tareas, iteraciones. */
export async function storyRoutes(app: FastifyInstance) {
  const guard = (slug: string, reply: any) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };
  const fail = (reply: any, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, code: e instanceof PolicyError || (e.statusCode && typeof e.code === 'string') ? e.code : undefined, branch: e.branch });

  app.get('/api/workspaces/:slug/stories/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return await storyContext(slug, id); } catch (e: any) { return fail(reply, e); }
  });
  app.get('/api/workspaces/:slug/stories/:id/ask/estimate', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return estimateAsk(slug, id, (req.query as any)?.agentId ?? null); } catch (e: any) { return fail(reply, e); }
  });
  app.post('/api/workspaces/:slug/stories/:id/messages', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ text: z.string().trim().min(1).max(8000), ask: z.boolean().optional(), authorized: z.boolean().optional(), maxUsd: z.number().min(0.01).max(20).optional(), agentId: z.string().nullable().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Mensaje no válido' });
    try {
      if (!body.data.ask) {
        if (!backlogRepo(slug).get(id)) return reply.code(404).send({ error: 'Historia no encontrada' });
        const m = threadRepo(slug).add({ backlogItemId: id, role: 'owner', agentId: null, agentName: null, content: body.data.text, processId: null, costUsd: 0, tokens: 0, proposals: null });
        return reply.code(201).send({ user: m, reply: null });
      }
      if (!body.data.authorized) return reply.code(403).send({ error: 'Preguntar al equipo llama a la IA: requiere autorización explícita.', code: 'authorization_required' });
      return reply.code(201).send(await askTeam(slug, id, body.data.text, { authorized: true, maxUsd: body.data.maxUsd ?? 0.5, agentId: body.data.agentId ?? null }, (o, m) => app.log.info(o, m)));
    } catch (e: any) { return fail(reply, e); }
  });
  app.post('/api/workspaces/:slug/stories/:id/messages/:messageId/apply', async (req, reply) => {
    const { slug, id, messageId } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ tasks: z.boolean().optional(), criterion: z.boolean().optional() }).safeParse(req.body ?? {});
    try { return await applyProposals(slug, id, messageId, body.success ? body.data : {}); } catch (e: any) { return fail(reply, e); }
  });
  app.post('/api/workspaces/:slug/stories/:id/tasks', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ title: z.string().trim().min(2).max(300), assigneeAgentId: z.string().nullable().optional(), assigneeName: z.string().nullable().optional(), fromFeedback: z.boolean().optional() }).safeParse(req.body ?? {});
    try {
      if (body.success && body.data.fromFeedback) return reply.code(201).send(await tasksFromFeedback(slug, id));
      if (!body.success) return reply.code(400).send({ error: 'Tarea no válida' });
      if (!backlogRepo(slug).get(id)) return reply.code(404).send({ error: 'Historia no encontrada' });
      return reply.code(201).send(threadRepo(slug).addTask({ backlogItemId: id, title: body.data.title, assigneeAgentId: body.data.assigneeAgentId ?? null, assigneeName: body.data.assigneeName ?? null }));
    } catch (e: any) { return fail(reply, e); }
  });
  app.post('/api/workspaces/:slug/stories/:id/tasks/from-feedback', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return reply.code(201).send(await tasksFromFeedback(slug, id)); } catch (e: any) { return fail(reply, e); }
  });
  app.post('/api/workspaces/:slug/stories/:id/tasks/from-issue', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return reply.code(201).send(await tasksFromIssue(slug, id)); } catch (e: any) { return fail(reply, e); }
  });
  app.patch('/api/workspaces/:slug/stories/:id/tasks/:taskId', async (req, reply) => {
    const { slug, taskId } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ status: z.enum(['open', 'done']) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Estado no válido' });
    const t = threadRepo(slug).setTask(taskId, body.data.status); if (!t) return reply.code(404).send({ error: 'Tarea no encontrada' });
    return t;
  });
  app.delete('/api/workspaces/:slug/stories/:id/tasks/:taskId', async (req, reply) => {
    const { slug, taskId } = req.params as any; if (!guard(slug, reply)) return;
    threadRepo(slug).deleteTask(taskId); return { ok: true };
  });
  app.post('/api/workspaces/:slug/stories/:id/iterate', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    // reopen: reabre una historia cerrada/descartada · discardApplied: confirma descartar el worktree y la rama de una iteración aplicada sin integrar.
    const body = z.object({ note: z.string().trim().max(2000).nullable().optional(), reopen: z.boolean().optional(), discardApplied: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Datos de la iteración no válidos' });
    try { const r = await iterateStory(slug, id, body.data.note || null, { reopen: body.data.reopen, discardApplied: body.data.discardApplied }); app.log.info({ story: id, processId: r.process.id, actions: r.actions }, 'nueva iteración creada'); return reply.code(201).send(r); } catch (e: any) { return fail(reply, e); }
  });
}

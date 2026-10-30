import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BATCH_LIMITS } from '@portal-ia/domain';
import { workspacesRepo } from '../db/platform.ts';
import { batchesRepo } from '../db/batches.ts';
import { acceptItems, batchView, cancelBatch, cancelItem, createBatch, getBatch, iterateItem, pauseBatch, previewBatch, rejectItem, reopenItem, resumeBatch, revokeBatch, setBatchLogger } from '../services/batchRunner.ts';

const BATCH_INPUT = z.object({
  title: z.string().trim().max(120).optional(),
  itemIds: z.array(z.string().min(1)).min(1).max(BATCH_LIMITS.maxItems),
  backends: z.array(z.enum(['api', 'claude_code'])).min(1).max(2).optional(),
  totalBudgetUsd: z.number().min(0.1).max(BATCH_LIMITS.maxTotalUsd),
  perStoryBudgetUsd: z.number().min(0.1).max(BATCH_LIMITS.maxPerStoryUsd),
  maxCorrections: z.number().int().min(0).max(BATCH_LIMITS.maxCorrections).optional(),
  maxDurationMin: z.number().int().min(5).max(BATCH_LIMITS.maxDurationMin).optional(),
  maxSubscriptionCalls: z.number().int().min(0).max(BATCH_LIMITS.maxSubscriptionCalls).optional(),
  gauntlet: z.object({ mode: z.enum(['off', 'standard', 'deep']), maxRounds: z.number().int().min(0).max(3).optional() }).optional(),
  concurrency: z.number().int().min(1).max(BATCH_LIMITS.maxConcurrency).optional(),
  commands: z.array(z.enum(['typecheck', 'test', 'build'])).max(3).optional(),
  allowInstall: z.boolean().optional(),
  git: z.object({ merge: z.boolean().optional(), activate: z.boolean().optional(), publish: z.boolean().optional() }).optional(),
  autoResume: z.boolean().optional()
});

/** Ejecución continua del backlog: vista previa, autorización explícita del lote, monitor, control y aceptación. */
export async function batchRoutes(app: FastifyInstance) {
  setBatchLogger((o, m) => app.log.info(o, m));
  const guard = (slug: string, reply: any) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };
  const send = (reply: any, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code });
  const authorized = (body: unknown) => z.object({ authorized: z.literal(true) }).passthrough().safeParse(body ?? {}).success;
  const DENIED = { error: 'Esta acción exige tu autorización explícita.', code: 'authorization_required' };

  // Vista previa (sin guardar nada ni llamar a la IA): plan, estimación, avisos.
  app.post('/api/workspaces/:slug/projects/:projectId/batches/preview', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    const body = BATCH_INPUT.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Alcance del lote no válido.', issues: body.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
    try { return previewBatch(slug, projectId, body.data); } catch (e) { return send(reply, e); }
  });
  // Autorización del lote (explícita, persistida y auditable).
  app.post('/api/workspaces/:slug/projects/:projectId/batches', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    if (!authorized(req.body)) return reply.code(400).send(DENIED);
    const body = BATCH_INPUT.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Alcance del lote no válido.', issues: body.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
    try { const b = createBatch(slug, projectId, body.data); req.log.info({ batchId: b.id, items: b.items.length }, 'lote autorizado'); return reply.code(201).send(batchView(slug, b)); } catch (e) { return send(reply, e); }
  });
  app.get('/api/workspaces/:slug/projects/:projectId/batches', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    return batchesRepo(slug).list(projectId).map(b => batchView(slug, b));
  });
  app.get('/api/workspaces/:slug/batches/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return batchView(slug, getBatch(slug, id)); } catch (e) { return send(reply, e); }
  });

  const control = (path: string, fn: (slug: string, id: string, body: any) => any, needsAuth = false) =>
    app.post(`/api/workspaces/:slug/batches/:id/${path}`, async (req, reply) => {
      const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
      if (needsAuth && !authorized(req.body)) return reply.code(400).send(DENIED);
      try { const b = await fn(slug, id, req.body ?? {}); return batchView(slug, b); } catch (e) { return send(reply, e); }
    });
  control('pause', (s, id) => pauseBatch(s, id));
  // Reanudar es seguir gastando: exige autorización (y puede ampliar el presupuesto o el tope de la suscripción).
  control('resume', (s, id, b) => resumeBatch(s, id, { addBudgetUsd: Number(b.addBudgetUsd) || 0, addSubscriptionCalls: Number(b.addSubscriptionCalls) || 0 }), true);
  control('cancel', (s, id) => cancelBatch(s, id));
  control('revoke', (s, id, b) => revokeBatch(s, id, typeof b.reason === 'string' ? b.reason.slice(0, 300) : null));

  // Aceptación del propietario (distinta de QA): una o varias a la vez.
  app.post('/api/workspaces/:slug/batches/:id/accept', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ itemIds: z.array(z.string()).min(1).max(BATCH_LIMITS.maxItems), note: z.string().trim().max(1000).optional(), checks: z.record(z.string(), z.array(z.boolean()).max(50)).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Indica qué historias aceptas.' });
    try { return batchView(slug, await acceptItems(slug, id, body.data.itemIds, body.data.note || null, body.data.checks ?? {})); } catch (e) { return send(reply, e); }
  });
  app.post('/api/workspaces/:slug/batches/:id/items/:itemId/reject', async (req, reply) => {
    const { slug, id, itemId } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ note: z.string().trim().min(3).max(2000), failedSteps: z.array(z.string().trim().min(1).max(300)).max(20).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Explica por qué no la aceptas (y, si quieres, qué pasos fallaron).' });
    try { return batchView(slug, rejectItem(slug, id, itemId, body.data)); } catch (e) { return send(reply, e); }
  });
  app.post('/api/workspaces/:slug/batches/:id/items/:itemId/reopen', async (req, reply) => {
    const { slug, id, itemId } = req.params as any; if (!guard(slug, reply)) return;
    try { return batchView(slug, reopenItem(slug, id, itemId)); } catch (e) { return send(reply, e); }
  });
  // Iterar SOLO esta historia dentro de los límites del lote (gasta: exige autorización).
  app.post('/api/workspaces/:slug/batches/:id/items/:itemId/iterate', async (req, reply) => {
    const { slug, id, itemId } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), note: z.string().trim().min(3).max(2000) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Iterar exige tu autorización y una nota con lo que hay que cambiar.', code: 'authorization_required' });
    try { return batchView(slug, await iterateItem(slug, id, itemId, body.data.note)); } catch (e) { return send(reply, e); }
  });
  app.post('/api/workspaces/:slug/batches/:id/items/:itemId/cancel', async (req, reply) => {
    const { slug, id, itemId } = req.params as any; if (!guard(slug, reply)) return;
    try { return batchView(slug, cancelItem(slug, id, itemId)); } catch (e) { return send(reply, e); }
  });
}

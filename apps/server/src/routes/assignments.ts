import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { acceptAssignment, assignmentAuthorizationPreview, assignmentView, authorizeAssignment, cancelAssignment, createAssignment, listAssignments, requestAssignmentChanges, updateAssignment } from '../services/assignments.ts';

const TEXTS = z.array(z.string().trim().min(1).max(600)).max(20);
const DEFINE = z.object({
  request: z.string().trim().min(8).max(8000), title: z.string().trim().min(3).max(160), objective: z.string().trim().min(10).max(4000),
  criteria: TEXTS.min(1), outOfScope: TEXTS.optional(), size: z.enum(['S', 'M', 'L']).nullable().optional(),
  conversationId: z.string().max(80).nullable().optional(), messageId: z.string().max(80).nullable().optional()
});

/**
 * Encargos de desarrollo del propietario (sin historia): definir (sin IA), autorizar (crea y autoriza el proceso del
 * MISMO motor que las historias), revisar, aceptar (regla de cierre de las historias), pedir cambios o cancelar.
 */
export async function assignmentRoutes(app: FastifyInstance) {
  const guard = (slug: string, reply: any) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };
  const send = (reply: any, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code, ...(e.payload ?? {}) });
  const authorized = (body: unknown) => z.object({ authorized: z.literal(true) }).passthrough().safeParse(body ?? {}).success;
  const DENIED = { error: 'Esta acción exige tu autorización explícita.', code: 'authorization_required' };

  app.get('/api/workspaces/:slug/assignments', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const { projectId } = req.query as any;
    return listAssignments(slug, typeof projectId === 'string' ? projectId : undefined);
  });
  app.post('/api/workspaces/:slug/projects/:projectId/assignments', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    const body = DEFINE.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Encargo no válido: hacen falta la petición, un título, el objetivo y al menos un criterio de aceptación.', issues: body.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
    try { const a = createAssignment(slug, projectId, body.data); return reply.code(201).send(assignmentView(slug, a.id)); } catch (e) { return send(reply, e); }
  });
  app.get('/api/workspaces/:slug/assignments/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return assignmentView(slug, id); } catch (e) { return send(reply, e); }
  });
  app.patch('/api/workspaces/:slug/assignments/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = DEFINE.pick({ title: true, objective: true, criteria: true, outOfScope: true, size: true }).partial().safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos.' });
    try { updateAssignment(slug, id, body.data as any); return assignmentView(slug, id); } catch (e) { return send(reply, e); }
  });
  // Lo que se autorizaría (sin IA): equipo, USD si fuera por la API, Gauntlet resuelto y estado de la suscripción.
  app.get('/api/workspaces/:slug/assignments/:id/authorization', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return assignmentAuthorizationPreview(slug, id); } catch (e) { return send(reply, e); }
  });
  // Autorizar: aquí empieza a gastar. Presupuesto de API y tope de llamadas a la suscripción, explícitos.
  app.post('/api/workspaces/:slug/assignments/:id/authorize', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    if (!authorized(req.body)) return reply.code(400).send(DENIED);
    const body = z.object({ budgetUsd: z.number().min(0.1).max(500), maxSubscriptionCalls: z.number().int().min(1).max(2000).optional(), maxCorrections: z.number().int().min(0).max(5).optional(), allowInstall: z.boolean().optional(), gauntlet: z.object({ mode: z.enum(['off', 'standard', 'deep', 'auto']) }).optional() }).passthrough().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Indica el presupuesto de API (USD) y, si quieres, el tope de llamadas a la suscripción.' });
    try { const r = authorizeAssignment(slug, id, body.data, (o, m) => app.log.info(o, m)); return { assignment: assignmentView(slug, r.assignment.id), processId: r.process.id }; } catch (e) { return send(reply, e); }
  });
  app.post('/api/workspaces/:slug/assignments/:id/accept', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ note: z.string().trim().max(1000).optional() }).safeParse(req.body ?? {});
    try { await acceptAssignment(slug, id, body.success ? body.data.note || null : null); return assignmentView(slug, id); } catch (e) { return send(reply, e); }
  });
  app.post('/api/workspaces/:slug/assignments/:id/changes', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ note: z.string().trim().min(3).max(2000) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Explica qué hay que cambiar.' });
    try { await requestAssignmentChanges(slug, id, body.data.note); return assignmentView(slug, id); } catch (e) { return send(reply, e); }
  });
  app.post('/api/workspaces/:slug/assignments/:id/cancel', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { cancelAssignment(slug, id); return assignmentView(slug, id); } catch (e) { return send(reply, e); }
  });
}

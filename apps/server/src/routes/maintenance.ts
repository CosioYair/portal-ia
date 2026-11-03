import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { projectsRepo } from '../db/workspace.ts';
import { createPlan, executePlan, getPlan, listPlans, rejectPlan } from '../services/projectMaintenance.ts';

/**
 * Revisión del proyecto (ramas, worktrees y backlog frente a main). Revisar es de solo lectura; ejecutar exige tu
 * autorización explícita y SOLO los objetivos que elijas (con su motivo cuando cierra o cancela trabajo).
 * Todo queda dentro de la empresa de la ruta: un plan de otra empresa no existe aquí.
 */
export async function maintenanceRoutes(app: FastifyInstance) {
  const guard = (slug: string, reply: any) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Empresa no encontrada' }); return false; } return true; };
  const send = (reply: any, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code });
  const OPTION = z.enum(['keep', 'delete_remote', 'archive_delete_remote', 'delete_local', 'archive_delete_local', 'remove_worktree', 'accept', 'close_done', 'discard', 'close_batch', 'discard_iteration', 'accept_assignment', 'cancel_assignment']);

  app.get('/api/workspaces/:slug/projects/:projectId/maintenance/plans', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    try { return listPlans(slug, projectId); } catch (e) { return send(reply, e); }
  });
  // Revisar (solo lectura): no pide autorización ni llama a la IA.
  app.post('/api/workspaces/:slug/projects/:projectId/maintenance/plans', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    if (!projectsRepo(slug).list().some(p => p.id === projectId)) return reply.code(404).send({ error: 'Proyecto no encontrado en esta empresa.' });
    const from = typeof (req.body as any)?.from === 'string' ? String((req.body as any).from).slice(0, 80) : null; // «Revisar de nuevo»: conserva la tarjeta del chat
    // Cierre de etapa: la revisión llega con lo que se puede cerrar ya elegido y el motivo (no autoriza nada).
    const cs = (req.body as any)?.closeStage; const closeStage = cs && typeof cs.reason === 'string' && cs.reason.trim().length >= 3 ? { reason: cs.reason.trim().slice(0, 300) } : null;
    try { return await createPlan(slug, projectId, { from, closeStage }); } catch (e) { return send(reply, e); }
  });
  app.get('/api/workspaces/:slug/maintenance/plans/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return getPlan(slug, id); } catch (e) { return send(reply, e); }
  });
  app.post('/api/workspaces/:slug/maintenance/plans/:id/execute', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), selection: z.array(z.object({ itemId: z.string().max(600), option: OPTION, reason: z.string().max(300).nullable().optional() })).min(1).max(5000) }).safeParse(req.body ?? {});
    if (!body.success) {
      const b = req.body as any;
      if (Array.isArray(b?.selection) && b.selection.length > 5000) return reply.code(400).send({ error: 'Demasiados objetivos en una sola autorización (máximo 5000): ejecútalo por partes.', code: 'selection_too_large' });
      return reply.code(400).send({ error: b?.authorized !== true ? 'Falta tu autorización explícita.' : 'Elige al menos un objetivo (la selección no es válida).', code: b?.authorized !== true ? 'authorization_required' : 'invalid_selection' });
    }
    try { return executePlan(slug, id, body.data.selection, body.data.authorized); } catch (e) { return send(reply, e); }
  });
  app.post('/api/workspaces/:slug/maintenance/plans/:id/reject', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return rejectPlan(slug, id); } catch (e) { return send(reply, e); }
  });
}

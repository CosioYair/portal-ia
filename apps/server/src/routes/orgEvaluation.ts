import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { PolicyError } from '../services/executionPolicy.ts';
import { clearCancel, isCancelled } from '../services/assessment.ts';
import { trackJob } from '../services/activeJobs.ts';
import { createOrgEvaluation, decideProposal, estimateOrgEvaluation, getOrgEvaluation, listOrgEvaluations, runOrgEvaluation } from '../services/orgEvaluation.ts';
import { revertProposal } from '../services/orgProposalApply.ts';

/** HU-159 · Evaluación organizativa. Solo POST /org-evaluations llama a la IA, con autorización explícita y presupuesto. */
const idSchema = z.string().min(1).max(100);
const estimateQuery = z.object({ projectId: idSchema.optional(), anchorProjectId: idSchema.optional() });
const listQuery = z.object({ projectId: idSchema.optional(), scope: z.enum(['workspace', 'project', 'all']).optional() });
const startBody = z.object({ projectId: idSchema.nullable().optional(), anchorProjectId: idSchema.nullable().optional(), budgetUsd: z.number().finite().positive().max(1000), authorized: z.literal(true) });
// Aceptar aplica cambios estructurales (sin costo de IA); la confirmación explícita la envía la interfaz.
const decisionBody = z.object({ decision: z.enum(['accepted', 'rejected']), confirm: z.literal(true).optional() });
const undoBody = z.object({ confirm: z.literal(true) });

export async function orgEvaluationRoutes(app: FastifyInstance) {
  const guard = (slug: string, reply: any) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };
  const fail = (reply: any, e: any) => reply.code(e instanceof PolicyError ? 403 : e.statusCode ?? 500).send({ error: e.message, code: e.code });

  app.get('/api/workspaces/:slug/org-evaluations/estimate', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const q = estimateQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'Ámbito no válido' });
    try { return estimateOrgEvaluation(slug, q.data.projectId ?? null, q.data.anchorProjectId ?? null); } catch (e: any) { return fail(reply, e); }
  });

  app.post('/api/workspaces/:slug/org-evaluations', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const raw = (req.body ?? {}) as any;
    // Sin autorización explícita y presupuesto no se crea nada (ni proceso ni evaluación).
    if (raw.authorized !== true || !(typeof raw.budgetUsd === 'number' && raw.budgetUsd > 0)) {
      return reply.code(403).send({ error: 'Evaluar la organización llama a la IA: requiere autorización explícita y un presupuesto en USD.', code: 'authorization_required' });
    }
    const body = startBody.safeParse(raw);
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos', issues: body.error.issues });
    try {
      const { evaluation, process } = createOrgEvaluation(slug, body.data.projectId ?? null, body.data.budgetUsd, body.data.anchorProjectId ?? null);
      const pid = process.id;
      void trackJob(pid, runOrgEvaluation(slug, pid, (o, m) => app.log.info(o, m), () => isCancelled(pid)))
        .catch(err => app.log.error({ err, processId: pid }, 'evaluación organizativa con error inesperado'))
        .finally(() => clearCancel(pid));
      return reply.code(202).send({ ...evaluation, process: { id: pid, status: process.status, budgetUsd: process.budgetUsd, estimatedUsd: process.estimatedUsd, spentUsd: process.spentUsd } });
    } catch (e: any) { return fail(reply, e); }
  });

  app.get('/api/workspaces/:slug/org-evaluations', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const q = listQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'Filtro no válido' });
    const filter = q.data.projectId ? { projectId: q.data.projectId } : q.data.scope === 'workspace' ? { projectId: null } : {};
    try { return listOrgEvaluations(slug, filter); } catch (e: any) { return fail(reply, e); }
  });

  app.get('/api/workspaces/:slug/org-evaluations/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return getOrgEvaluation(slug, id); } catch (e: any) { return fail(reply, e); }
  });

  app.post('/api/workspaces/:slug/org-evaluations/:id/proposals/:proposalId', async (req, reply) => {
    const { slug, id, proposalId } = req.params as any; if (!guard(slug, reply)) return;
    const body = decisionBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Indica la decisión: accepted o rejected.' });
    // La respuesta incluye proposal.application (cambios aplicados con sus fotos previas) al aceptar.
    try { return decideProposal(slug, id, proposalId, body.data.decision); } catch (e: any) { return fail(reply, e); }
  });

  /** Deshace una propuesta aplicada (restaura las fotos previas). Sin IA; exige confirmación explícita. */
  app.post('/api/workspaces/:slug/org-evaluations/:id/proposals/:proposalId/undo', async (req, reply) => {
    const { slug, id, proposalId } = req.params as any; if (!guard(slug, reply)) return;
    const params = z.object({ id: idSchema, proposalId: idSchema }).safeParse({ id, proposalId });
    if (!params.success) return reply.code(400).send({ error: 'Identificadores no válidos' });
    const body = undoBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Deshacer requiere confirmación explícita (confirm: true).', code: 'confirmation_required' });
    try { return revertProposal(slug, params.data.id, params.data.proposalId); } catch (e: any) { return fail(reply, e); }
  });
}

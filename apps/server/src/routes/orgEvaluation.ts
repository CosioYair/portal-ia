import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ORG_BRIEF_LIMITS, ORG_BRIEF_REQUIRED_MESSAGE } from '@portal-ia/domain';
import { workspacesRepo } from '../db/platform.ts';
import { PolicyError } from '../services/executionPolicy.ts';
import { clearCancel, isCancelled } from '../services/assessment.ts';
import { trackJob } from '../services/activeJobs.ts';
import { createOrgEvaluation, decideProposal, estimateOrgEvaluation, getOrgEvaluation, listOrgEvaluations, runOrgEvaluation } from '../services/orgEvaluation.ts';
import { reapplyProposal, reopenProposal, revertProposal } from '../services/orgProposalApply.ts';

/** HU-159 · Evaluación organizativa. Solo POST /org-evaluations llama a la IA, con autorización explícita y presupuesto. */
const idSchema = z.string().min(1).max(100);
const estimateQuery = z.object({ projectId: idSchema.optional(), anchorProjectId: idSchema.optional(), briefChars: z.coerce.number().int().min(0).max(1_000_000).optional() });
const listQuery = z.object({ projectId: idSchema.optional(), scope: z.enum(['workspace', 'project', 'all']).optional() });
const L = ORG_BRIEF_LIMITS;
/** Paso «Contexto y dirección»: dirección, contexto inicial y adjuntos (de las imágenes solo nombre y descripción), o skipped. */
const briefAttachment = z.object({
  name: z.string().min(1).max(L.attachmentName, `El nombre de un adjunto supera ${L.attachmentName} caracteres.`),
  kind: z.enum(['text', 'image']),
  content: z.string().max(L.attachmentContent, `Un archivo supera ${L.attachmentContent} caracteres.`).optional(),
  note: z.string().max(L.attachmentNote, `La descripción de un adjunto supera ${L.attachmentNote} caracteres.`).optional()
});
const briefSchema = z.object({
  direction: z.string().max(L.direction, `La dirección supera ${L.direction} caracteres.`).optional().default(''),
  initialContext: z.string().max(L.initialContext, `El contexto inicial supera ${L.initialContext} caracteres.`).optional().default(''),
  attachments: z.array(briefAttachment).max(L.attachments, `Se admiten como máximo ${L.attachments} adjuntos.`)
    .superRefine((list, ctx) => {
      const total = list.reduce((n, a) => n + (a.kind === 'text' ? (a.content?.length ?? 0) : 0), 0);
      if (total > L.attachmentsTotal) ctx.addIssue({ code: 'custom', message: `Los adjuntos suman más de ${L.attachmentsTotal} caracteres.` });
    })
    .optional().default([]),
  skipped: z.boolean().optional().default(false)
});
const startBody = z.object({ projectId: idSchema.nullable().optional(), anchorProjectId: idSchema.nullable().optional(), budgetUsd: z.number().finite().positive().max(1000), authorized: z.literal(true), brief: briefSchema });
// Aceptar aplica cambios estructurales (sin costo de IA) y exige confirmación explícita (confirm: true), igual que deshacer.
// Rechazar también la exige: sin ella, el servicio responde 400 confirmation_required y la propuesta sigue pendiente.
// La exigencia se comprueba en el servicio (las propuestas sin spec solo registran la decisión al aceptarlas).
const decisionBody = z.object({ decision: z.enum(['accepted', 'rejected']), confirm: z.boolean().optional() });
const undoBody = z.object({ confirm: z.literal(true) });
const confirmBody = z.object({ confirm: z.literal(true) });
const proposalParams = z.object({ id: idSchema, proposalId: idSchema });

export async function orgEvaluationRoutes(app: FastifyInstance) {
  const guard = (slug: string, reply: any) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };
  const fail = (reply: any, e: any) => reply.code(e instanceof PolicyError ? 403 : e.statusCode ?? 500).send({ error: e.message, code: e.code });

  app.get('/api/workspaces/:slug/org-evaluations/estimate', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const q = estimateQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'Ámbito no válido' });
    try { return estimateOrgEvaluation(slug, q.data.projectId ?? null, q.data.anchorProjectId ?? null, { briefChars: q.data.briefChars }); } catch (e: any) { return fail(reply, e); }
  });

  app.post('/api/workspaces/:slug/org-evaluations', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const raw = (req.body ?? {}) as any;
    // Sin autorización explícita y presupuesto no se crea nada (ni proceso ni evaluación).
    if (raw.authorized !== true || !(typeof raw.budgetUsd === 'number' && raw.budgetUsd > 0)) {
      return reply.code(403).send({ error: 'Evaluar la organización llama a la IA: requiere autorización explícita y un presupuesto en USD.', code: 'authorization_required' });
    }
    // Después de la autorización, el paso «Contexto y dirección» es obligatorio (dirección/contexto/adjuntos o skipped: true).
    if (raw.brief === undefined || raw.brief === null || typeof raw.brief !== 'object' || Array.isArray(raw.brief)) {
      return reply.code(400).send({ error: ORG_BRIEF_REQUIRED_MESSAGE, code: 'brief_required' });
    }
    const body = startBody.safeParse(raw);
    if (!body.success) {
      const briefIssue = body.error.issues.find(i => i.path[0] === 'brief');
      if (briefIssue) {
        const tooLarge = briefIssue.code === 'too_big' || briefIssue.code === 'custom';
        return reply.code(400).send({ error: tooLarge ? briefIssue.message : 'El paso «Contexto y dirección» no es válido.', code: tooLarge ? 'brief_too_large' : 'brief_invalid', issues: body.error.issues });
      }
      return reply.code(400).send({ error: 'Datos no válidos', issues: body.error.issues });
    }
    try {
      // El servicio vuelve a validar el brief: vacío y sin skipped → 400 brief_required (sin crear nada).
      const { evaluation, process } = createOrgEvaluation(slug, body.data.projectId ?? null, body.data.budgetUsd, body.data.anchorProjectId ?? null, body.data.brief);
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
    try { return decideProposal(slug, id, proposalId, body.data.decision, body.data.confirm === true); } catch (e: any) { return fail(reply, e); }
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

  /** Reabre una propuesta rechazada (vuelve a pendiente). Sin IA; exige confirmación explícita. 409 si no está rechazada. */
  app.post('/api/workspaces/:slug/org-evaluations/:id/proposals/:proposalId/reopen', async (req, reply) => {
    const { slug, id, proposalId } = req.params as any; if (!guard(slug, reply)) return;
    const params = proposalParams.safeParse({ id, proposalId });
    if (!params.success) return reply.code(400).send({ error: 'Identificadores no válidos' });
    const body = confirmBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Reabrir requiere confirmación explícita (confirm: true).', code: 'confirmation_required' });
    try { return reopenProposal(slug, params.data.id, params.data.proposalId, true); } catch (e: any) { return fail(reply, e); }
  });

  /** Vuelve a aplicar una propuesta deshecha, validada contra la organización actual. Sin IA; exige confirmación. 409 si no está revertida y 422 si el sujeto ya no es válido. */
  app.post('/api/workspaces/:slug/org-evaluations/:id/proposals/:proposalId/reapply', async (req, reply) => {
    const { slug, id, proposalId } = req.params as any; if (!guard(slug, reply)) return;
    const params = proposalParams.safeParse({ id, proposalId });
    if (!params.success) return reply.code(400).send({ error: 'Identificadores no válidos' });
    const body = confirmBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Volver a aplicar requiere confirmación explícita (confirm: true).', code: 'confirmation_required' });
    try { return reapplyProposal(slug, params.data.id, params.data.proposalId, true); } catch (e: any) { return fail(reply, e); }
  });
}

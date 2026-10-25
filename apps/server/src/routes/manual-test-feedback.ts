import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MANUAL_TEST_RESULTS } from '@portal-ia/domain';
import { listFeedback, upsertStepFeedback, ProcessNotFoundError } from '../services/manual-test-feedback.ts';

const putBody = z.object({
  result: z.enum(MANUAL_TEST_RESULTS).nullable(),
  comment: z.string().max(2000)
});
const STEP_KEY_RE = /^[A-Za-z0-9_.-]{1,80}$/;

type BaseParams = { slug: string; processId: string };

export async function manualTestFeedbackRoutes(app: FastifyInstance) {
  app.get<{ Params: BaseParams }>('/api/workspaces/:slug/processes/:processId/manual-test-feedback', async (req, reply) => {
    try {
      return listFeedback(req.params.slug, req.params.processId);
    } catch (e) {
      if (e instanceof ProcessNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.put<{ Params: BaseParams & { stepKey: string } }>('/api/workspaces/:slug/processes/:processId/manual-test-feedback/:stepKey', async (req, reply) => {
    if (!STEP_KEY_RE.test(req.params.stepKey)) return reply.code(400).send({ error: 'Clave de paso no válida' });
    const body = putBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Feedback no válido: resultado OK, Falla u Observación y comentario de hasta 2000 caracteres.' });
    try {
      const item = upsertStepFeedback(req.params.slug, req.params.processId, req.params.stepKey, body.data);
      return { item };
    } catch (e) {
      if (e instanceof ProcessNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
  });
}

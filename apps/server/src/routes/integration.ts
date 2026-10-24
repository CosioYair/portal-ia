import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IntegrationError, getIntegrationStatus, integrateIntoMain } from '../services/integration.ts';

const statusSchema = z.object({
  currentBranch: z.string().nullable(),
  mainBranch: z.string(),
  canIntegrate: z.boolean(),
  reasonCode: z.enum(['NOT_ON_MAIN', 'DETACHED_HEAD', 'NOT_A_REPO']).optional(),
  reason: z.string().optional()
});

const bodySchema = z.object({ branch: z.string().min(1).max(200) });

export async function integrationRoutes(app: FastifyInstance) {
  app.get('/api/portal/integration/status', async () => {
    return statusSchema.parse(await getIntegrationStatus());
  });

  app.post('/api/portal/integration', async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Indica la rama que se va a integrar.' });
    try {
      return await integrateIntoMain({ sourceBranch: parsed.data.branch });
    } catch (e) {
      if (e instanceof IntegrationError) return reply.code(409).send(e.body);
      throw e;
    }
  });
}

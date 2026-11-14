import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getIntegrationStatus } from '../services/integration.ts';

const statusSchema = z.object({
  currentBranch: z.string().nullable(),
  mainBranch: z.string(),
  canIntegrate: z.boolean(),
  reasonCode: z.enum(['NOT_ON_MAIN', 'DETACHED_HEAD', 'NOT_A_REPO']).optional(),
  reason: z.string().optional()
});


export async function integrationRoutes(app: FastifyInstance) {
  app.get('/api/portal/integration/status', async () => {
    return statusSchema.parse(await getIntegrationStatus());
  });

  // Portal IA 3: esta ruta integraba CUALQUIER rama local en main y hacia push sin verificacion, QA ni registro del
  // proceso (su pantalla no estaba enlazada en ningun sitio). Se retira: integrar solo existe desde la historia o el
  // encargo, con sus comprobaciones. Responde 410 para que un cliente antiguo reciba el motivo.
  app.post('/api/portal/integration', async (_req, reply) => reply.code(410).send({ code: 'removed', error: 'Esta forma de integrar se ha retirado. Integra desde la historia o el encargo: asi se verifica y se revisa antes de llegar a main.' }));
}

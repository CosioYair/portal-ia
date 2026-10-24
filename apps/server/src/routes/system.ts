import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { startUpdate, systemStatus } from '../services/system.ts';

/** Estado del propio Portal (código arrancado vs. actual) y actualización autorizada (reconstruir + reiniciar). */
export async function systemRoutes(app: FastifyInstance) {
  app.get('/api/system/status', async (_req, reply) => { try { return await systemStatus(); } catch (e: any) { return reply.code(500).send({ error: e.message }); } });
  app.post('/api/system/update', async (req, reply) => {
    const body = z.object({ authorized: z.literal(true), install: z.boolean().optional(), restart: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita.' });
    try {
      const st = await systemStatus();
      const install = body.data.install ?? st.changedFiles.some(f => /(^|\/)package(-lock)?\.json$/.test(f));
      const u = await startUpdate({ install, restart: body.data.restart ?? true }, (o, m) => app.log.info(o, m));
      return { update: u, install };
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
}

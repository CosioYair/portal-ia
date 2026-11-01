import type { FastifyInstance } from 'fastify';
import { workspacesRepo } from '../db/platform.ts';
import { previewsOf, setPreviewLogger, startPreview, stopPreview } from '../services/preview.ts';

/**
 * Vista previa aislada del candidato de una historia (sin IA; ver services/preview.ts): abrirla, ver su estado (y las
 * anteriores, que quedan como evidencia) y detenerla. Nunca toca el worktree ni la rama de la historia ni los datos reales.
 */
export async function previewRoutes(app: FastifyInstance) {
  setPreviewLogger((o, m) => app.log.info(o, m));
  const guard = (slug: string, reply: any) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };
  const send = (reply: any, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code });

  app.get('/api/workspaces/:slug/processes/:id/previews', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return previewsOf(slug, id); } catch (e) { return send(reply, e); }
  });
  app.post('/api/workspaces/:slug/processes/:id/previews', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return reply.code(202).send(await startPreview(slug, id)); } catch (e) { return send(reply, e); }
  });
  app.delete('/api/workspaces/:slug/processes/:id/previews/:previewId', async (req, reply) => {
    const { slug, id, previewId } = req.params as any; if (!guard(slug, reply)) return;
    try { return await stopPreview(slug, id, previewId, 'detenida por ti'); } catch (e) { return send(reply, e); }
  });
}

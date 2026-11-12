import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { previewsOf, setPreviewLogger, startPreview, stopPreview } from '../services/preview.ts';
import { runVisualCheck } from '../services/visualCheck.ts';

const VisualCheckParams = z.object({ slug: z.string().min(1), id: z.string().min(1) });
const VisualCheckBody = z.object({
  vars: z.record(z.string().regex(/^[A-Za-z0-9_]+$/), z.string().max(200)).optional(),
  timeoutMs: z.number().int().min(60_000).max(3_600_000).optional()
}).strict();

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
  // HU-207: verificación visual en el host (sin IA) contra la vista previa del commit aplicado; deja report.json y los PNG.
  app.post('/api/workspaces/:slug/processes/:id/visual-check', async (req, reply) => {
    const params = VisualCheckParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Parámetros no válidos', code: 'invalid_params' });
    const { slug, id } = params.data; if (!guard(slug, reply)) return;
    const body = VisualCheckBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: `Datos no válidos: ${body.error.issues.map(i => i.message).join('; ')}`, code: 'invalid_body' });
    try { return await runVisualCheck(slug, id, { vars: body.data.vars, timeoutMs: body.data.timeoutMs }); } catch (e) { return send(reply, e); }
  });
  app.delete('/api/workspaces/:slug/processes/:id/previews/:previewId', async (req, reply) => {
    const { slug, id, previewId } = req.params as any; if (!guard(slug, reply)) return;
    try { return await stopPreview(slug, id, previewId, 'detenida por ti'); } catch (e) { return send(reply, e); }
  });
}

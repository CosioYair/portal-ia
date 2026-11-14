import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LAB_ANALYSES, LAB_CHECK_FIXES, LAB_CHECK_LABELS, LAB_LIMITS, REA_PIN } from '@portal-ia/domain';
import { workspacesRepo } from '../db/platform.ts';
import { checkReaUpdate, compareLab, labEngine, labRepo, startLabAnalysis } from '../services/artifactLab.ts';
import { acceptOctetStream, streamToTemp, uploadName } from './uploads.ts';

/**
 * Portal IA 4 · Laboratorio de análisis de artefactos (especialista en ingeniería inversa). Todo análisis exige la
 * sesión del propietario (regla global) Y su declaración de que puede examinar ese artefacto.
 */
const fail = (reply: FastifyReply, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, ...(e.code ? { code: e.code } : {}) });

export async function labRoutes(app: FastifyInstance) {
  acceptOctetStream(app);
  const W = '/api/workspaces/:slug/lab';
  const ws = (req: FastifyRequest, reply: FastifyReply): string | null => { const { slug } = req.params as any; if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return null; } return slug; };

  app.get(`${W}/status`, async (req, reply) => { if (!ws(req, reply)) return; return { engine: await labEngine(), analyses: LAB_ANALYSES, limits: LAB_LIMITS, pin: REA_PIN, labels: LAB_CHECK_LABELS, fixes: LAB_CHECK_FIXES }; });
  app.post(`${W}/status/refresh`, async (req, reply) => { if (!ws(req, reply)) return; return { engine: await labEngine(true) }; });
  app.get(`${W}/reports`, async (req, reply) => { const slug = ws(req, reply); if (!slug) return; return labRepo(slug).list(); });
  app.get(`${W}/reports/:id`, async (req, reply) => { const slug = ws(req, reply); if (!slug) return; return labRepo(slug).get((req.params as any).id) ?? reply.code(404).send({ error: 'Informe no encontrado.' }); });
  app.get(`${W}/reports/:id/compare/:other`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return; const { id, other } = req.params as any;
    try { return compareLab(slug, other, id); } catch (e) { return fail(reply, e); }
  });
  // El artefacto llega en flujo; el tipo de análisis y la declaración de autorización, en la dirección (codificados).
  app.put(`${W}/reports`, { bodyLimit: LAB_LIMITS.maxUploadBytes }, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    const q = z.object({ analysis: z.enum(['exposure', 'hardening', 'inventory']), statement: z.string().trim().min(LAB_LIMITS.minStatement).max(1000), authorized: z.literal('true') }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'Elige el análisis y declara por qué puedes examinar este artefacto (es tuyo o tienes permiso de su dueño).', code: 'authorization_required' });
    let up: Awaited<ReturnType<typeof streamToTemp>> | null = null;
    try {
      up = await streamToTemp(req, LAB_LIMITS.maxUploadBytes);
      return reply.code(202).send(await startLabAnalysis(slug, { analysis: q.data.analysis, tempFile: up.file, size: up.size, name: uploadName(req), statement: q.data.statement }));
    } catch (e) { return fail(reply, e); } finally { up?.cleanup(); }
  });
  // Consulta (solo lectura, sin datos del propietario) si hay una versión más nueva de la herramienta. No instala nada.
  app.post(`${W}/update-check`, async (req, reply) => { if (!ws(req, reply)) return; return checkReaUpdate(); });
}

import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { agentsRepo } from '../db/workspace.ts';
import { ATTACHMENT_LIMITS, attachmentPath, deleteAttachment, listAttachments, saveAttachment } from '../services/agentAttachments.ts';
import { confirmAction, dismissAction, rerouteAction } from '../services/agentActions.ts';
import { acceptOctetStream, streamToTemp, uploadName } from './uploads.ts';

/**
 * Adjuntos de las conversaciones con cualquier agente y acciones que nacen del chat (confirmar / descartar).
 * Control de acceso: cada adjunto y cada acción pertenecen a UN agente de UNA empresa (su base y su carpeta de datos).
 */
const err = (reply: FastifyReply, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, ...(e.code ? { code: e.code } : {}) });

export async function agentFilesRoutes(app: FastifyInstance) {
  acceptOctetStream(app);
  const ok = (slug: string, id: string, reply: FastifyReply) => {
    if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; }
    if (!agentsRepo(slug).get(id)) { reply.code(404).send({ error: 'Agente no encontrado' }); return false; }
    return true;
  };
  const W = '/api/workspaces/:slug/agents/:id';
  const MAX = Math.max(...Object.values(ATTACHMENT_LIMITS));

  app.get(`${W}/attachments`, async (req, reply) => {
    const { slug, id } = req.params as any; if (!ok(slug, id, reply)) return;
    return { attachments: listAttachments(slug, id), limits: ATTACHMENT_LIMITS };
  });
  app.put(`${W}/attachments`, { bodyLimit: MAX }, async (req, reply) => {
    const { slug, id } = req.params as any; if (!ok(slug, id, reply)) return;
    const name = uploadName(req); if (!name) return reply.code(400).send({ error: 'Falta el nombre del archivo.' });
    const projectId = typeof (req.query as any)?.projectId === 'string' ? (req.query as any).projectId : null;
    let up: Awaited<ReturnType<typeof streamToTemp>> | null = null;
    try { up = await streamToTemp(req, MAX); return reply.code(201).send(await saveAttachment(slug, id, up.file, name, projectId)); } catch (e) { return err(reply, e); }
    finally { up?.cleanup(); }
  });
  app.delete(`${W}/attachments/:attId`, async (req, reply) => {
    const { slug, id, attId } = req.params as any; if (!ok(slug, id, reply)) return;
    try { deleteAttachment(slug, id, attId); return { ok: true }; } catch (e) { return err(reply, e); }
  });
  app.get(`${W}/attachments/:attId/file`, async (req, reply) => {
    const { slug, id, attId } = req.params as any; if (!ok(slug, id, reply)) return;
    try {
      const { abs, att } = attachmentPath(slug, id, attId);
      reply.header('Content-Type', att.mime).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store')
        .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      if (att.kind !== 'image') reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(att.name)}`);
      return reply.send(fs.createReadStream(abs));
    } catch (e) { return err(reply, e); }
  });

  app.post(`${W}/actions/:actionId/confirm`, async (req, reply) => {
    const { slug, id, actionId } = req.params as any; if (!ok(slug, id, reply)) return;
    const b = z.object({ authorized: z.literal(true) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Confirma la acción.' });
    try { return await confirmAction(slug, id, actionId, { authorized: true }); } catch (e) { return err(reply, e); }
  });
  // El propietario corrige a quién le toca una mejora (del agente ↔ del Portal) antes de confirmarla.
  app.post(`${W}/actions/:actionId/reroute`, async (req, reply) => {
    const { slug, id, actionId } = req.params as any; if (!ok(slug, id, reply)) return;
    try { return rerouteAction(slug, id, actionId); } catch (e) { return err(reply, e); }
  });
  app.post(`${W}/actions/:actionId/dismiss`, async (req, reply) => {
    const { slug, id, actionId } = req.params as any; if (!ok(slug, id, reply)) return;
    try { return dismissAction(slug, id, actionId); } catch (e) { return err(reply, e); }
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assistantInfo, assistantRepo, chat, resolveProposal } from '../services/assistant.ts';
import { createCompany, createProject } from '../services/companies.ts';
import { workspacesRepo } from '../db/platform.ts';

export async function assistantRoutes(app: FastifyInstance) {
  app.get('/api/assistant', async (_req, reply) => { try { return { info: assistantInfo(), messages: assistantRepo.listLive() }; } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); } });
  // Enviar un mensaje = una llamada real al modelo del Asistente. El propio envío es la autorización (costo visible en la UI).
  app.post('/api/assistant/messages', async (req, reply) => {
    const body = z.object({
      text: z.string().trim().min(1, 'El mensaje está vacío.').max(400_000, 'El mensaje supera los 400 000 caracteres.'),
      images: z.array(z.object({
        mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'], { message: 'Formato de imagen no soportado (PNG, JPEG, WebP o GIF).' }),
        data: z.string().min(1).max(7_000_000, 'Una imagen supera 5 MB.'), // base64 (≈5 MB por imagen)
        name: z.string().max(200).optional()
      })).max(4, 'Máximo 4 imágenes por mensaje.').optional(),
      /** Adjuntos de texto ya incorporados al mensaje por el cliente; aquí solo se registran. */
      files: z.array(z.object({ name: z.string().max(200), mediaType: z.string().max(100), bytes: z.number().int().nonnegative() })).max(6).optional()
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: `Mensaje no válido: ${body.error.issues.map(i => i.message).join(' ')}` });
    try { const r = await chat(body.data.text, body.data.images ?? [], body.data.files ?? []); app.log.info({ cost: r.assistant.costUsd.toFixed(4), actions: r.assistant.actions.length, images: body.data.images?.length ?? 0 }, 'asistente respondió'); return { ...r, info: assistantInfo() }; }
    catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  // Marca una propuesta (ejecutar historia / aplicar cambios) como resuelta tras autorizarla desde la tarjeta del chat.
  app.post('/api/assistant/messages/:id/resolve', async (req, reply) => {
    const { id } = req.params as any;
    const body = z.object({ processId: z.string().min(1), status: z.enum(['done', 'failed']), detail: z.string().max(500).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos' });
    if (!assistantRepo.get(id)) return reply.code(404).send({ error: 'Mensaje no encontrado' });
    resolveProposal(id, body.data.processId, body.data.status, body.data.detail);
    return { message: assistantRepo.listLive().find(m => m.id === id) ?? assistantRepo.get(id) };
  });
  app.delete('/api/assistant/messages', async () => { assistantRepo.clear(); return { ok: true }; });

  // Empresas y proyectos (operaciones locales, sin IA)
  app.post('/api/workspaces', async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(2).max(80) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Nombre no válido' });
    try { const ws = createCompany(body.data.name); app.log.info({ slug: ws.slug }, 'empresa creada'); return reply.code(201).send(ws); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/projects', async (req, reply) => {
    const { slug } = req.params as any;
    if (!workspacesRepo.get(slug)) return reply.code(404).send({ error: 'Empresa no encontrada' });
    const body = z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(2000).optional(), objectives: z.array(z.string().trim().min(1).max(300)).max(10).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos' });
    try { const p = createProject(slug, body.data.name, body.data.description ?? '', body.data.objectives ?? []); app.log.info({ slug, project: p.slug }, 'proyecto creado'); return reply.code(201).send(p); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
}

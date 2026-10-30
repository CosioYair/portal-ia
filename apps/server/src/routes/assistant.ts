import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assistantInfo, assistantRepo, chat, decideLocal, decideOperation, resolveProposal } from '../services/assistant.ts';
import { conversationsRepo } from '../db/conversations.ts';
import { conversationDetail, createConversation, createStoriesFrom, decide, decideProposal, getConversation, startArtifact } from '../services/conversations.ts';
import { createCompany, createProject } from '../services/companies.ts';
import { workspacesRepo } from '../db/platform.ts';

export async function assistantRoutes(app: FastifyInstance) {
  // Conversaciones: la elegida (o la más reciente) con sus mensajes, decisiones, artefactos y encargos.
  app.get('/api/assistant', async (req, reply) => {
    try {
      const q = req.query as any; const list = conversationsRepo.list();
      const id = typeof q.conversationId === 'string' ? q.conversationId : list.find(c => c.status === 'active')?.id ?? null;
      return { info: assistantInfo(), conversations: list, conversationId: id, messages: id ? assistantRepo.listLive(80, id) : [], detail: id ? conversationDetail(id) : null };
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/assistant/conversations', async (req, reply) => {
    const body = z.object({ title: z.string().trim().max(120).optional(), workspaceSlug: z.string().max(80).nullable().optional(), projectId: z.string().max(80).nullable().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos' });
    try { return reply.code(201).send(createConversation(body.data.title ?? 'Nueva conversación', body.data.workspaceSlug ?? null, body.data.projectId ?? null)); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.patch('/api/assistant/conversations/:id', async (req, reply) => {
    const { id } = req.params as any;
    const body = z.object({ title: z.string().trim().min(1).max(120).optional(), workspaceSlug: z.string().max(80).nullable().optional(), projectId: z.string().max(80).nullable().optional(), status: z.enum(['active', 'archived']).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos' });
    try { getConversation(id); return conversationsRepo.update(id, body.data as any); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.get('/api/assistant/conversations/:id', async (req, reply) => {
    const { id } = req.params as any;
    try { return { ...conversationDetail(id), messages: assistantRepo.listLive(80, id) }; } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  // Decisión del propietario sobre UNA decisión (sin IA; nada se crea ni se ejecuta).
  app.post('/api/assistant/conversations/:id/decisions/:did/:action', async (req, reply) => {
    const { id, did, action } = req.params as any;
    if (!['approve', 'reject', 'defer', 'revise', 'reopen'].includes(action)) return reply.code(404).send({ error: 'Acción no válida' });
    const body = z.object({ answer: z.string().trim().max(1000).nullable().optional(), note: z.string().trim().max(1000).nullable().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos' });
    try { return decide(id, did, action, body.data); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code }); }
  });
  // Preparar (sin IA ni gasto) propuesta, revisión del equipo o historias: queda pendiente de TU autorización.
  app.post('/api/assistant/conversations/:id/artifacts', async (req, reply) => {
    const { id } = req.params as any;
    const body = z.object({ kind: z.enum(['proposal', 'team_review', 'stories']) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Indica qué preparar.' });
    try { return reply.code(201).send(startArtifact(id, body.data.kind)); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code }); }
  });
  app.post('/api/assistant/conversations/:id/artifacts/:aid/:decision', async (req, reply) => {
    const { id, aid, decision } = req.params as any;
    try {
      if (decision === 'approve' || decision === 'reject') { const body = z.object({ note: z.string().trim().max(1000).optional() }).safeParse(req.body ?? {}); return decideProposal(id, aid, decision, body.success ? body.data.note ?? null : null); }
      // Crear las historias propuestas: solo con tu autorización explícita.
      if (decision === 'create-stories') { if (!z.object({ authorized: z.literal(true) }).safeParse(req.body ?? {}).success) return reply.code(403).send({ error: 'Crear historias exige tu autorización explícita.', code: 'authorization_required' }); return createStoriesFrom(id, aid); }
      return reply.code(404).send({ error: 'Acción no válida' });
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code }); }
  });
  // Cambio local que el Asistente propuso: confirmarlo (exige autorización) o descartarlo.
  app.post('/api/assistant/messages/:id/local/:index/:decision', async (req, reply) => {
    const { id, index, decision } = req.params as any;
    if (decision !== 'approve' && decision !== 'reject') return reply.code(404).send({ error: 'Decisión no válida' });
    if (decision === 'approve' && !z.object({ authorized: z.literal(true) }).safeParse(req.body ?? {}).success) return reply.code(403).send({ error: 'Confirmar este cambio requiere tu autorización explícita.' });
    try { return { message: decideLocal(id, Number(index), decision) }; } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
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
      files: z.array(z.object({ name: z.string().max(200), mediaType: z.string().max(100), bytes: z.number().int().nonnegative() })).max(6).optional(),
      conversationId: z.string().max(80).nullable().optional()
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: `Mensaje no válido: ${body.error.issues.map(i => i.message).join(' ')}` });
    try { const r = await chat(body.data.text, body.data.images ?? [], body.data.files ?? [], body.data.conversationId ?? null); app.log.info({ cost: r.assistant.costUsd.toFixed(4), actions: r.assistant.actions.length, images: body.data.images?.length ?? 0 }, 'asistente respondió'); return { ...r, info: assistantInfo() }; }
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
  // Operación del catálogo propuesta en el chat: autorizar (la ejecuta el servicio existente) o rechazar (sin efectos).
  app.post('/api/assistant/messages/:id/operations/:opId/:decision', async (req, reply) => {
    const { id, opId, decision } = req.params as { id: string; opId: string; decision: string };
    if (decision !== 'approve' && decision !== 'reject') return reply.code(404).send({ error: 'Decisión no válida' });
    if (decision === 'approve' && !z.object({ authorized: z.literal(true) }).strict().safeParse(req.body).success) return reply.code(403).send({ error: 'Ejecutar una operación del Portal requiere tu autorización explícita.' });
    try {
      const m = await decideOperation(id, opId, decision);
      const op = m.actions.find(a => a.operation?.id === opId);
      app.log.info({ operation: op?.operation?.capability, decision, status: op?.status }, 'operación del Asistente decidida');
      return { message: assistantRepo.listLive().find(x => x.id === id) ?? m };
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
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

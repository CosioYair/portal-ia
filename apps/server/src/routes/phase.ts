import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { backlogRepo, processesRepo } from '../db/workspace.ts';
import { PolicyError } from '../services/executionPolicy.ts';
import { DEFAULT_PHASE_NAME, currentPhase, listTransitions, previewTransition, projectArchive, restoreStory, revertPhase, startPhase } from '../services/operationalPhase.ts';

/**
 * Lo archivado es histórico y de solo lectura: ninguna acción (autorizar, aplicar, integrar, verificar, iterar, chatear,
 * ejecutar, cerrar…) se ejecuta sobre un proceso o una historia archivados. Solo «restaurar» los devuelve al flujo.
 * Gancho global (se registra antes que las rutas) para que ninguna ruta nueva se lo salte.
 */
export function registerArchivedGuard(app: FastifyInstance) {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const url = req.url.split('?')[0];
    const m = url.match(/^\/api\/workspaces\/([^/]+)\/(?:processes\/([^/]+)\/|backlog\/([^/]+)(?:\/([^/]+))?$|stories\/([^/]+)\/|projects\/[^/]+\/backlog\/([^/]+)\/execute$)/);
    if (!m) return;
    const [, slug, procId, itemId, sub, storyId, execId] = m;
    if (!workspacesRepo.get(slug)) return;
    if (procId && processesRepo(slug).get(procId)?.archivedAt) return reply.code(409).send({ error: 'Este proceso está archivado (etapa anterior): es histórico y no admite acciones. Restaura su historia desde el archivo si necesitas retomarlo.', code: 'archived' });
    const bid = itemId && sub !== 'restore' ? itemId : storyId ?? execId;
    if (bid && backlogRepo(slug).get(bid)?.archivedAt) return reply.code(409).send({ error: 'Esta historia está archivada (etapa anterior): es histórica y no admite acciones. Restáurala desde el archivo si necesitas retomarla.', code: 'archived' });
  });
}

export async function phaseRoutes(app: FastifyInstance) {
  const guard = (slug: string, reply: any) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };
  const fail = (reply: any, e: any) => reply.code(e instanceof PolicyError ? (e.code === 'authorization_required' ? 400 : 403) : e.statusCode ?? 500).send({ error: e.message, code: e.code, running: e.running });

  app.get('/api/workspaces/:slug/projects/:projectId/phase', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    return { current: currentPhase(slug, projectId), transitions: listTransitions(slug, projectId), defaultName: DEFAULT_PHASE_NAME };
  });
  // Vista previa: solo lee (base y git). Qué se archivaría, qué se conserva, qué bloquea y la línea base que se escribiría.
  app.get('/api/workspaces/:slug/projects/:projectId/phase/preview', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    const name = String((req.query as any)?.name ?? '').trim().slice(0, 120) || undefined;
    try { return await previewTransition(slug, projectId, name); } catch (e: any) { return fail(reply, e); }
  });
  app.post('/api/workspaces/:slug/projects/:projectId/phase', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ name: z.string().trim().max(120).optional(), authorized: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos' });
    try { const t = await startPhase(slug, projectId, body.data); app.log.info({ phase: t.name, stories: t.summary.archivedStories.length, processes: t.summary.archivedProcesses.length }, 'etapa iniciada: trabajo activo archivado'); return t; }
    catch (e: any) { return fail(reply, e); }
  });
  app.post('/api/workspaces/:slug/projects/:projectId/phase/:id/revert', async (req, reply) => {
    const { slug, projectId, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.boolean().optional(), reason: z.string().max(500).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos' });
    try { const t = revertPhase(slug, projectId, id, body.data); app.log.info({ phase: t.name }, 'etapa revertida: lo archivado vuelve al flujo activo'); return t; }
    catch (e: any) { return fail(reply, e); }
  });
  app.get('/api/workspaces/:slug/projects/:projectId/archive', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    return projectArchive(slug, projectId);
  });
  app.post('/api/workspaces/:slug/backlog/:id/restore', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos' });
    try { return restoreStory(slug, id, body.data); } catch (e: any) { return fail(reply, e); }
  });
}

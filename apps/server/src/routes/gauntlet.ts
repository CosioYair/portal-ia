import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GAUNTLET_TEMPLATE } from '@portal-ia/domain';
import { workspacesRepo } from '../db/platform.ts';
import { projectsRepo } from '../db/workspace.ts';
import { createEvaluator, gauntletAdvice, projectEvaluator, projectGauntlet, setProjectGauntlet } from '../services/gauntlet.ts';

const MODE = z.object({ mode: z.enum(['off', 'standard', 'deep']), maxRounds: z.number().int().min(0).max(3).optional() });

/** Evaluación Gauntlet: modo predeterminado del proyecto, recomendación por historia y el Evaluador (aprobación organizativa). */
export async function gauntletRoutes(app: FastifyInstance) {
  const guard = (slug: string, projectId: string, reply: any) => {
    if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; }
    if (!projectsRepo(slug).get(projectId)) { reply.code(404).send({ error: 'Proyecto no encontrado' }); return false; }
    return true;
  };

  app.get('/api/workspaces/:slug/projects/:projectId/gauntlet', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, projectId, reply)) return;
    const ev = projectEvaluator(slug, projectId);
    return { config: projectGauntlet(slug, projectId), evaluator: ev ? { id: ev.id, name: ev.config.name, model: ev.config.model, effort: ev.config.effort, backend: ev.config.backend ?? 'api' } : null, template: { key: GAUNTLET_TEMPLATE.key, name: GAUNTLET_TEMPLATE.name, role: GAUNTLET_TEMPLATE.role, specialization: GAUNTLET_TEMPLATE.specialization, responsibilities: GAUNTLET_TEMPLATE.responsibilities, reportsTo: GAUNTLET_TEMPLATE.reportsTo, tools: GAUNTLET_TEMPLATE.tools, capabilities: GAUNTLET_TEMPLATE.capabilities, evaluation: GAUNTLET_TEMPLATE.evaluation } };
  });

  // Modo predeterminado del proyecto (cada tarea puede cambiarlo al autorizarla). No consume IA.
  app.put('/api/workspaces/:slug/projects/:projectId/gauntlet', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, projectId, reply)) return;
    const body = MODE.extend({ authorized: z.literal(true) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Indica el modo (off, standard o deep) y confirma tu autorización.', code: 'authorization_required' });
    return { config: setProjectGauntlet(slug, projectId, body.data) };
  });

  // Recomendación sin IA y sobrecoste de cada modo para una historia (antes de autorizar).
  app.get('/api/workspaces/:slug/projects/:projectId/backlog/:itemId/gauntlet', async (req, reply) => {
    const { slug, projectId, itemId } = req.params as any; if (!guard(slug, projectId, reply)) return;
    try { return gauntletAdvice(slug, projectId, itemId); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code }); }
  });

  // Aprobación organizativa del propietario: crea el Evaluador Gauntlet en el proyecto (plantilla versionada, jefe: Coordinador).
  app.post('/api/workspaces/:slug/projects/:projectId/gauntlet/evaluator', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, projectId, reply)) return;
    const body = z.object({ authorized: z.literal(true), model: z.string().min(1).max(120).optional(), effort: z.enum(['low', 'medium', 'high']).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Añadir un agente a la organización exige tu aprobación explícita.', code: 'authorization_required' });
    try {
      const a = createEvaluator(slug, projectId, body.data);
      req.log.info({ slug, projectId, agentId: a.id }, 'Evaluador Gauntlet creado (aprobación del propietario)');
      return reply.code(201).send(a);
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code }); }
  });
}

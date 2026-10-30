import type { FastifyInstance } from 'fastify';
import { workspacesRepo } from '../db/platform.ts';
import { processesRepo } from '../db/workspace.ts';
import { callMetricsRepo, summarizeCalls } from '../db/callMetrics.ts';

/**
 * Rendimiento medible (solo lectura): telemetría de las llamadas de los agentes resumida con p50/p95 por papel y origen,
 * tiempo del modelo frente al del Portal, llamadas repetidas, fallos y lecturas del repositorio.
 */
export async function metricsRoutes(app: FastifyInstance) {
  app.get('/api/workspaces/:slug/metrics/calls', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!workspacesRepo.get(slug)) return reply.code(404).send({ error: 'Espacio no encontrado' });
    const q = req.query as { since?: string; processId?: string; projectId?: string; raw?: string };
    const since = q.since && !Number.isNaN(Date.parse(q.since)) ? new Date(q.since).toISOString() : null;
    const processIds = q.projectId ? processesRepo(slug).listAll(q.projectId).map(p => p.id) : null;
    if (q.projectId && !processIds!.length) return { summary: summarizeCalls([], since), calls: [] };
    const rows = callMetricsRepo(slug).list({ since, processId: q.processId ?? null, processIds });
    return { summary: summarizeCalls(rows, since), calls: q.raw === '1' ? rows.slice(-500) : [] };
  });
}

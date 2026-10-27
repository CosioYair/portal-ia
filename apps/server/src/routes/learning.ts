import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { agentsRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { createManualLesson, estimatePropose, lessonsRepo, proposeLesson, recordDetections, setLessonStatus, validateLesson } from '../services/lessons.ts';
import { effectiveVersion, promoteLesson, setAgentTemplateVersion, templatesRepo, versionDiff } from '../services/agentTemplates.ts';
import { PolicyError } from '../services/executionPolicy.ts';

/** M4 · Lecciones validadas y M5 · plantillas versionadas. Ninguna ruta llama a la IA salvo /propose (autorizada). */
export async function learningRoutes(app: FastifyInstance) {
  const guard = (slug: string, reply: any) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };
  const fail = (reply: any, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, code: e instanceof PolicyError ? e.code : undefined });

  app.get('/api/workspaces/:slug/lessons', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const q = (req.query as any) ?? {};
    return lessonsRepo(slug).list(q.projectId ?? null, q.status ?? null);
  });
  app.post('/api/workspaces/:slug/lessons', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ projectId: z.string().nullable().optional(), title: z.string().trim().min(3).max(200), lessonText: z.string().trim().min(10).max(1500), role: z.enum(['planner', 'implementer', 'reviewer', 'consultant']).nullable().optional(), tags: z.array(z.string().max(40)).max(6).optional(), correctiveAction: z.string().max(1000).nullable().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Lección no válida', issues: body.error.issues });
    try { return reply.code(201).send(createManualLesson(slug, { ...body.data, projectId: body.data.projectId ?? null })); } catch (e: any) { return fail(reply, e); }
  });
  /** Detección manual sobre un proceso (idempotente). */
  app.post('/api/workspaces/:slug/processes/:id/detect-lessons', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const p = processesRepo(slug).get(id); if (!p) return reply.code(404).send({ error: 'Proceso no encontrado' });
    const repo = projectsRepo(slug).repository(p.projectId);
    return recordDetections(slug, id, repo?.path ?? null);
  });
  app.get('/api/workspaces/:slug/lessons/:id/propose/estimate', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return estimatePropose(slug, id); } catch (e: any) { return fail(reply, e); }
  });
  app.post('/api/workspaces/:slug/lessons/:id/propose', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true) }).safeParse(req.body);
    if (!body.success) return reply.code(403).send({ error: 'Proponer una lección llama a la IA: requiere autorización explícita.', code: 'authorization_required' });
    try { return await proposeLesson(slug, id, { authorized: true }); } catch (e: any) { return fail(reply, e); }
  });
  app.post('/api/workspaces/:slug/lessons/:id/validate', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ lessonText: z.string().trim().min(10).max(1500).optional(), rootCause: z.string().max(1000).optional(), correctiveAction: z.string().max(1000).optional(), role: z.enum(['planner', 'implementer', 'reviewer', 'consultant']).nullable().optional(), tags: z.array(z.string().max(40)).max(6).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos', issues: body.error.issues });
    try { return validateLesson(slug, id, body.data); } catch (e: any) { return fail(reply, e); }
  });
  app.post('/api/workspaces/:slug/lessons/:id/reject', async (req, reply) => { const { slug, id } = req.params as any; if (!guard(slug, reply)) return; try { return setLessonStatus(slug, id, 'rejected'); } catch (e: any) { return fail(reply, e); } });
  app.post('/api/workspaces/:slug/lessons/:id/obsolete', async (req, reply) => { const { slug, id } = req.params as any; if (!guard(slug, reply)) return; try { return setLessonStatus(slug, id, 'obsolete'); } catch (e: any) { return fail(reply, e); } });

  // ---- M5 · plantillas ----
  app.get('/api/workspaces/:slug/templates', async (req, reply) => { const { slug } = req.params as any; if (!guard(slug, reply)) return; return templatesRepo(slug).keys(); });
  app.get('/api/workspaces/:slug/templates/:key/versions', async (req, reply) => { const { slug, key } = req.params as any; if (!guard(slug, reply)) return; return templatesRepo(slug).versions(key); });
  app.post('/api/workspaces/:slug/lessons/:id/promote', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), targetKey: z.string().max(80).nullable().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita.' });
    try { return reply.code(201).send(promoteLesson(slug, id, body.data.targetKey ?? null)); } catch (e: any) { return fail(reply, e); }
  });
  app.get('/api/workspaces/:slug/agents/:id/template', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const a = agentsRepo(slug).get(id); if (!a) return reply.code(404).send({ error: 'Agente no encontrado' });
    const cur = effectiveVersion(slug, a); const latest = cur ? templatesRepo(slug).latest(cur.key) : null;
    const q = (req.query as any) ?? {};
    let diff = null; try { diff = q.to ? versionDiff(slug, a, String(q.to)) : latest && cur && latest.id !== cur.id ? versionDiff(slug, a, latest.id) : null; } catch { diff = null; }
    return { current: cur, latest, versions: cur ? templatesRepo(slug).versions(cur.key) : [], history: templatesRepo(slug).history(id), diff, templateVersion: a.templateVersion ?? null };
  });
  app.post('/api/workspaces/:slug/agents/:id/template-version', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), version: z.string().regex(/^.+@\d+$/) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Indica la versión (clave@n) y la autorización.' });
    try { return setAgentTemplateVersion(slug, id, body.data.version); } catch (e: any) { return fail(reply, e); }
  });
}

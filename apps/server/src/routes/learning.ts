import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { agentsRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { createManualLesson, estimatePropose, lessonsRepo, proposeLesson, recordDetections, setLessonStatus, validateLesson } from '../services/lessons.ts';
import { effectiveVersion, promoteLesson, setAgentTemplateVersion, templatesRepo, versionDiff } from '../services/agentTemplates.ts';
import { PolicyError } from '../services/executionPolicy.ts';
import { curatePending } from '../services/lessonCurator.ts';
import { acceptImprovement, getAutoImproveAuthorization, pendingImprovementItems, revertImprovement, setAutoImproveAuthorization } from '../services/lessonImprover.ts';
import { lessonTemplateReach } from '../services/lessonPractices.ts';
import { activeAgents } from '../services/activeAgents.ts';

/** M4 · Lecciones validadas y M5 · plantillas versionadas. Ninguna ruta llama a la IA salvo /propose (autorizada). */
/** La memoria de un agente (lessons.agent_id) se gestiona en su panel; estas rutas son de la organización. */
function agentMemoryGuard(slug: string, id: string): string | null { const l = lessonsRepo(slug).get(id); return l?.agentId ? 'Ese aprendizaje es la memoria de un agente: gestiónalo en su panel (Memoria).' : null; }

export async function learningRoutes(app: FastifyInstance) {
  const guard = (slug: string, reply: any) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };
  const fail = (reply: any, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, code: e instanceof PolicyError ? e.code : undefined });

  app.get('/api/workspaces/:slug/lessons', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const q = (req.query as any) ?? {};
    const list = lessonsRepo(slug).list(q.projectId ?? null, q.status ?? null);
    // EN-020: en cada lección aplicada, la versión de plantilla en la que está y a cuántos agentes llega.
    let reach: Record<string, { templateVersion: string; agents: number }> = {};
    try { reach = lessonTemplateReach(slug); } catch { /* sin datos de alcance: la lista sigue */ }
    const active = activeAgents(slug);
    return list.map(l => {
      if (l.status !== 'validated') return l;
      if (l.role) { const r = reach[l.id]; return { ...l, templateVersion: r?.templateVersion ?? null, agents: r?.agents ?? 0 }; }
      // Sin papel: no va a una plantilla; llega por el prompt a los agentes del proyecto (y a los de la empresa).
      const n = active.filter(a => a.scope === 'workspace' || !l.projectId || a.projectId === l.projectId).length;
      return { ...l, templateVersion: null, agents: n };
    });
  });
  app.post('/api/workspaces/:slug/lessons', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ projectId: z.string().nullable().optional(), title: z.string().trim().min(3).max(200), lessonText: z.string().trim().min(10).max(1500), role: z.enum(['planner', 'implementer', 'reviewer', 'consultant']).nullable().optional(), tags: z.array(z.string().max(40)).max(6).optional(), correctiveAction: z.string().max(1000).nullable().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Lección no válida', issues: body.error.issues });
    try { return reply.code(201).send(createManualLesson(slug, { ...body.data, projectId: body.data.projectId ?? null })); } catch (e: any) { return fail(reply, e); }
  });
  /**
   * HU-202 · Limpieza inicial con una sola confirmación del propietario: el Curador agrupa por causa todas las
   * detecciones pendientes, aplica las útiles y descarta el ruido y los duplicados. Por reglas: sin IA y a 0 USD.
   */
  app.post('/api/workspaces/:slug/lessons/curate', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), projectId: z.string().min(1).nullable().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(403).send({ error: 'Depurar las lecciones pendientes requiere tu confirmación explícita (sin IA, 0 USD).', code: 'authorization_required' });
    const projectId = body.data.projectId ?? null;
    const startedAt = new Date().toISOString();
    try {
      const summary = curatePending(slug, { projectId, by: 'owner' });
      if (projectId) { try { processesRepo(slug).logExecution({ projectId, agentId: '', kind: 'lesson_curate', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt }); } catch { /* el registro no debe romper la depuración */ } }
      return summary;
    } catch (e: any) { return fail(reply, e); }
  });
  // ---- EN-022 · Mejora automática de las lecciones ----
  /** Autorización permanente (Ajustes): desactivada por defecto; leerla no tiene costo. */
  app.get('/api/workspaces/:slug/lessons/auto-improve', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    try { return getAutoImproveAuthorization(slug); } catch (e: any) { return fail(reply, e); }
  });
  app.put('/api/workspaces/:slug/lessons/auto-improve', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const raw = (req.body ?? {}) as any;
    if (raw.authorized !== true) return reply.code(403).send({ error: 'Cambiar la autorización de la mejora automática requiere tu confirmación explícita.', code: 'authorization_required' });
    const body = z.object({ authorized: z.literal(true), enabled: z.boolean(), monthlyCallCap: z.number().int().min(0).max(10_000), monthlyUsdCap: z.number().min(0).max(10_000) }).safeParse(raw);
    if (!body.success) return reply.code(400).send({ error: 'Los topes deben ser números mayores o iguales que 0.', issues: body.error.issues });
    try { return setAutoImproveAuthorization(slug, { enabled: body.data.enabled, monthlyCallCap: body.data.monthlyCallCap, monthlyUsdCap: body.data.monthlyUsdCap }); } catch (e: any) { return fail(reply, e); }
  });
  /** Mejoras pendientes de decisión: lista aparte de la bandeja (como /inbox/assignments); no pasa por decide(). */
  app.get('/api/workspaces/:slug/inbox/lessons', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    try { return pendingImprovementItems(slug); } catch (e: any) { return fail(reply, e); }
  });
  /** «Aceptar mejora (1 llamada)»: autorización explícita de UNA llamada; pasa por requirePolicy en el servicio. */
  app.post('/api/workspaces/:slug/lessons/:id/improvement/accept', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const g = agentMemoryGuard(slug, id); if (g) return reply.code(409).send({ error: g });
    const body = z.object({ authorized: z.literal(true) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(403).send({ error: 'Aceptar la mejora llama a la IA: requiere autorización explícita.', code: 'authorization_required' });
    try { return await acceptImprovement(slug, id, { authorized: true }); } catch (e: any) { return fail(reply, e); }
  });
  /** Volver a la versión anterior (sin IA, 0 USD): reactiva la madre y deja obsoleta la mejora. */
  app.post('/api/workspaces/:slug/lessons/:id/improvement/revert', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const g = agentMemoryGuard(slug, id); if (g) return reply.code(409).send({ error: g });
    const body = z.object({ confirm: z.literal(true) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Confirma que quieres volver a la versión anterior.' });
    try { return revertImprovement(slug, id); } catch (e: any) { return fail(reply, e); }
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
  app.post('/api/workspaces/:slug/lessons/:id/propose', async (req, reply) => { { const { slug: s0, id: i0 } = req.params as any; const g = agentMemoryGuard(s0, i0); if (g) return reply.code(409).send({ error: g }); }
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true) }).safeParse(req.body);
    if (!body.success) return reply.code(403).send({ error: 'Proponer una lección llama a la IA: requiere autorización explícita.', code: 'authorization_required' });
    try { return await proposeLesson(slug, id, { authorized: true }); } catch (e: any) { return fail(reply, e); }
  });
  app.post('/api/workspaces/:slug/lessons/:id/validate', async (req, reply) => { { const { slug: s0, id: i0 } = req.params as any; const g = agentMemoryGuard(s0, i0); if (g) return reply.code(409).send({ error: g }); }
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ lessonText: z.string().trim().min(10).max(1500).optional(), rootCause: z.string().max(1000).optional(), correctiveAction: z.string().max(1000).optional(), role: z.enum(['planner', 'implementer', 'reviewer', 'consultant']).nullable().optional(), tags: z.array(z.string().max(40)).max(6).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos', issues: body.error.issues });
    try { return validateLesson(slug, id, body.data); } catch (e: any) { return fail(reply, e); }
  });
  app.post('/api/workspaces/:slug/lessons/:id/reject', async (req, reply) => { { const { slug: s0, id: i0 } = req.params as any; const g = agentMemoryGuard(s0, i0); if (g) return reply.code(409).send({ error: g }); } const { slug, id } = req.params as any; if (!guard(slug, reply)) return; try { return setLessonStatus(slug, id, 'rejected'); } catch (e: any) { return fail(reply, e); } });
  app.post('/api/workspaces/:slug/lessons/:id/obsolete', async (req, reply) => { { const { slug: s0, id: i0 } = req.params as any; const g = agentMemoryGuard(s0, i0); if (g) return reply.code(409).send({ error: g }); } const { slug, id } = req.params as any; if (!guard(slug, reply)) return; try { return setLessonStatus(slug, id, 'obsolete'); } catch (e: any) { return fail(reply, e); } });

  // ---- M5 · plantillas ----
  app.get('/api/workspaces/:slug/templates', async (req, reply) => { const { slug } = req.params as any; if (!guard(slug, reply)) return; return templatesRepo(slug).keys(); });
  app.get('/api/workspaces/:slug/templates/:key/versions', async (req, reply) => { const { slug, key } = req.params as any; if (!guard(slug, reply)) return; return templatesRepo(slug).versions(key); });
  app.post('/api/workspaces/:slug/lessons/:id/promote', async (req, reply) => { { const { slug: s0, id: i0 } = req.params as any; const g = agentMemoryGuard(s0, i0); if (g) return reply.code(409).send({ error: g }); }
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

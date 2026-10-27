import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { KNOWLEDGE, TOOLS, type AgentConfig, type AgentCreateInput } from '@portal-ia/domain';
import { createAgent, deleteAgent, draftAgent, estimateDraft } from '../services/agentFactory.ts';
import { providersRepo, workspacesRepo } from '../db/platform.ts';
import { agentsRepo, projectsRepo } from '../db/workspace.ts';
import { expandHome, gitInfo, isAllowed } from './fs.ts';
import { initMainBranch, normalizeEol, repoStatus, setRemote } from '../services/repoStatus.ts';
import { pushBranches } from '../services/repoWrite.ts';
import { REPO_ROOT } from '../config.ts';

const agentConfigSchema = z.object({
  name: z.string().trim().min(2).max(80),
  specialization: z.string().trim().max(2000),
  responsibilities: z.array(z.string().trim().min(1).max(300)).max(30),
  provider: z.enum(['anthropic', 'openai']),
  model: z.string().min(1).max(120),
  fallbacks: z.array(z.string().min(1).max(120)).max(10),
  effort: z.enum(['low', 'medium', 'high']),
  tools: z.record(z.string(), z.boolean()),
  knowledge: z.record(z.string(), z.boolean()),
  monthlyLimitUsd: z.number().min(0).max(100000),
  perTaskAuthUsd: z.number().min(0).max(100000),
  capabilities: z.array(z.enum(['planificar', 'implementar', 'revisar_calidad', 'generar_pruebas', 'consultar_arquitectura', 'consultar_ux', 'revisar_seguridad', 'consultar', 'documentar'])).max(9).optional()
});

const agentCreateSchema = z.object({
  scope: z.enum(['workspace', 'project']),
  projectId: z.string().nullable(),
  name: z.string().trim().min(2).max(80),
  initials: z.string().trim().max(2).optional(),
  role: z.string().trim().min(2).max(80),
  reportsTo: z.string().trim().min(1).max(80),
  collaborates: z.array(z.string()).max(20),
  evaluation: z.array(z.string().trim().min(1).max(300)).max(10),
  config: agentConfigSchema
});

export async function workspaceRoutes(app: FastifyInstance) {
  app.get('/api/workspaces', async () => workspacesRepo.list());

  // ---- Creación de agentes especializados ----
  app.post('/api/workspaces/:slug/agents', async (req, reply) => {
    const { slug } = req.params as any;
    if (!workspacesRepo.get(slug)) return reply.code(404).send({ error: 'Espacio no encontrado' });
    const body = agentCreateSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Datos del agente no válidos', issues: body.error.issues });
    try { const a = createAgent(slug, body.data as AgentCreateInput); app.log.info({ agent: a.key }, 'agente creado'); return reply.code(201).send(a); }
    catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  app.delete('/api/workspaces/:slug/agents/:id', async (req, reply) => {
    const { slug, id } = req.params as any;
    if (!workspacesRepo.get(slug)) return reply.code(404).send({ error: 'Espacio no encontrado' });
    try { deleteAgent(slug, id); return { ok: true }; } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  app.get('/api/workspaces/:slug/agents/draft/estimate', async (req, reply) => {
    const { slug } = req.params as any;
    if (!workspacesRepo.get(slug)) return reply.code(404).send({ error: 'Espacio no encontrado' });
    try { return estimateDraft(slug); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  // Propuesta con IA (1 llamada real): exige autorización explícita y tope en USD.
  app.post('/api/workspaces/:slug/agents/draft', async (req, reply) => {
    const { slug } = req.params as any;
    if (!workspacesRepo.get(slug)) return reply.code(404).send({ error: 'Espacio no encontrado' });
    const body = z.object({ description: z.string().trim().min(10).max(2000), scope: z.enum(['workspace', 'project']), authorized: z.literal(true), maxUsd: z.number().min(0.01).max(20) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere descripción (≥10 caracteres), ámbito, autorización explícita y tope en USD.' });
    try { const r = await draftAgent(slug, body.data.description, body.data.scope, body.data.maxUsd); app.log.info({ cost: r.costUsd.toFixed(4) }, 'propuesta de agente generada'); return r; }
    catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  app.get('/api/workspaces/:slug/projects', async (req, reply) => {
    const { slug } = req.params as any;
    if (!workspacesRepo.get(slug)) return reply.code(404).send({ error: 'Espacio no encontrado' });
    const repo = projectsRepo(slug);
    return repo.list().map(p => ({ ...p, objectives: repo.objectives(p.id), context: repo.context(p.id), repository: repo.repository(p.id), knowledgeCount: repo.knowledgeCount(p.id) }));
  });

  app.get('/api/workspaces/:slug/usage/today', async (req, reply) => {
    const { slug } = req.params as any;
    if (!workspacesRepo.get(slug)) return reply.code(404).send({ error: 'Espacio no encontrado' });
    return projectsRepo(slug).usageToday();
  });

  // Registro del repositorio: acción explícita y autorizada por el usuario; solo lectura.
  app.post('/api/workspaces/:slug/projects/:projectId/repository', async (req, reply) => {
    const { slug, projectId } = req.params as any;
    if (!workspacesRepo.get(slug)) return reply.code(404).send({ error: 'Espacio no encontrado' });
    const repo = projectsRepo(slug);
    const project = repo.get(projectId);
    if (!project) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    const body = z.object({ path: z.string().trim().min(1).max(1024), authorized: z.literal(true) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere la ruta y la autorización explícita (authorized: true).' });
    const abs = path.resolve(expandHome(body.data.path));
    if (!isAllowed(abs)) return reply.code(403).send({ error: 'La carpeta está fuera de las rutas permitidas (PORTAL_FS_RESTRICT).' });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return reply.code(400).send({ error: 'La carpeta no existe.' });
    const g = gitInfo(abs);
    if (!g.isGit) return reply.code(400).send({ error: 'La carpeta no contiene un repositorio git.' });
    const r = repo.setRepository(project.id, body.data.path, g.branch);
    app.log.info({ project: project.slug, path: body.data.path }, 'repositorio registrado (solo lectura)');
    return r;
  });

  // ---- Estado y operaciones git del repositorio registrado (flujo: main → rama por historia → integrar → publicar) ----
  const withRepo = async (req: any, reply: any) => {
    const { slug, projectId } = req.params as any;
    if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return null; }
    const r = projectsRepo(slug).repository(projectId);
    if (!r) { reply.code(409).send({ error: 'El proyecto no tiene repositorio registrado.' }); return null; }
    return r;
  };
  app.get('/api/workspaces/:slug/projects/:projectId/repository/status', async (req, reply) => {
    const r = await withRepo(req, reply); if (!r) return;
    try { return { ...(await repoStatus(r.path)), portalRoot: REPO_ROOT }; } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/projects/:projectId/repository/init-main', async (req, reply) => {
    const r = await withRepo(req, reply); if (!r) return;
    const body = z.object({ authorized: z.literal(true) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita.' });
    try { const res = await initMainBranch(r.path); app.log.info({ path: r.path, from: res.from }, 'rama main creada'); return res; } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/projects/:projectId/repository/remote', async (req, reply) => {
    const r = await withRepo(req, reply); if (!r) return;
    const body = z.object({ authorized: z.literal(true), url: z.string().trim().min(8).max(300) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere la URL del remoto y autorización explícita.' });
    try { const res = await setRemote(r.path, body.data.url); app.log.info({ path: r.path, url: res.url }, 'remoto configurado'); return res; } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/projects/:projectId/repository/normalize-eol', async (req, reply) => {
    const r = await withRepo(req, reply); if (!r) return;
    const body = z.object({ authorized: z.literal(true) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita.' });
    try { const res = await normalizeEol(r.path); app.log.info({ path: r.path, ...res }, 'finales de línea normalizados'); return res; } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/projects/:projectId/repository/publish-main', async (req, reply) => {
    const r = await withRepo(req, reply); if (!r) return;
    const body = z.object({ authorized: z.literal(true) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita.' });
    try {
      const st = await repoStatus(r.path);
      if (!st.mainBranch) return reply.code(409).send({ error: 'El repositorio no tiene rama principal (main). Créala primero.' });
      const res = await pushBranches(r.path, [st.mainBranch]); app.log.info({ path: r.path, remote: res.remote }, 'main publicada'); return res;
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  app.get('/api/workspaces/:slug/agents', async (req, reply) => {
    const { slug } = req.params as any;
    if (!workspacesRepo.get(slug)) return reply.code(404).send({ error: 'Espacio no encontrado' });
    return agentsRepo(slug).list();
  });

  app.get('/api/workspaces/:slug/agents/:id', async (req, reply) => {
    const { slug, id } = req.params as any;
    const a = workspacesRepo.get(slug) ? agentsRepo(slug).get(id) : undefined;
    return a ?? reply.code(404).send({ error: 'Agente no encontrado' });
  });

  // Edición de configuración: no activa al agente ni realiza llamadas a modelos.
  app.put('/api/workspaces/:slug/agents/:id/config', async (req, reply) => {
    const { slug, id } = req.params as any;
    if (!workspacesRepo.get(slug)) return reply.code(404).send({ error: 'Espacio no encontrado' });
    const agents = agentsRepo(slug);
    const agent = agents.get(id);
    if (!agent) return reply.code(404).send({ error: 'Agente no encontrado' });
    const body = agentConfigSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Configuración no válida', issues: body.error.issues });
    const cfg = body.data as AgentConfig;
    // Validaciones de dominio: proveedor conectado, modelo en catálogo, herramientas/conocimiento conocidos.
    const prov = providersRepo.get(cfg.provider);
    if (!prov || prov.status !== 'connected') return reply.code(409).send({ error: 'El proveedor elegido no está conectado.' });
    const models: { id: string }[] = JSON.parse(prov.models_json);
    if (!models.some(m => m.id === cfg.model)) return reply.code(400).send({ error: 'El modelo preferido no está disponible en el proveedor.' });
    for (const f of cfg.fallbacks) if (!models.some(m => m.id === f)) return reply.code(400).send({ error: `Modelo alternativo no disponible: ${f}` });
    cfg.fallbacks = cfg.fallbacks.filter(f => f !== cfg.model);
    for (const k of Object.keys(cfg.tools)) if (!TOOLS.some(t => t.id === k)) return reply.code(400).send({ error: `Herramienta desconocida: ${k}` });
    for (const k of Object.keys(cfg.knowledge)) if (!KNOWLEDGE.some(t => t.id === k)) return reply.code(400).send({ error: `Fuente de conocimiento desconocida: ${k}` });
    return agents.updateConfig(id, cfg);
  });
}

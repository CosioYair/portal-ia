import type { FastifyInstance } from 'fastify';
import { AGENT_TEMPLATES, INTERNAL_PROJECT, INTERNAL_WORKSPACE, pickByTier, type AgentConfig, type AgentTemplate, type BootstrapResult, type BootstrapStep, type ModelInfo, type ProviderId } from '@portal-ia/domain';
import { providersRepo, workspacesRepo } from '../db/platform.ts';
import { agentsRepo, projectsRepo, workspaceDbPath } from '../db/workspace.ts';
import { inheritLatestTemplate } from '../services/agentTemplates.ts';

/**
 * HU-002 + HU-003: inicialización del espacio interno y del equipo inicial.
 * Idempotente: puede llamarse varias veces; solo crea lo que falta. Cero llamadas a modelos de IA.
 */
export function buildAgentConfig(t: AgentTemplate, provider: ProviderId, models: ModelInfo[], defaultModel: string | null): AgentConfig {
  const preferred = pickByTier(models, t.tier);
  const fallback = pickByTier(models, t.fallbackTier);
  const model = preferred?.id ?? defaultModel ?? '';
  const fallbacks = fallback && fallback.id !== model ? [fallback.id] : [];
  return {
    name: t.name, specialization: t.specialization, responsibilities: [...t.responsibilities],
    provider, model, fallbacks, effort: t.effort,
    tools: { ...t.tools }, knowledge: { ...t.knowledge }, monthlyLimitUsd: t.monthlyLimitUsd, perTaskAuthUsd: t.perTaskAuthUsd, capabilities: [...(t.capabilities ?? [])]
  };
}

export function runBootstrap(): BootstrapResult {
  const connected = providersRepo.connected();
  if (!connected.length) throw Object.assign(new Error('Conecta y verifica un proveedor de IA antes de inicializar el espacio interno.'), { statusCode: 409 });
  const prov = connected[0];
  const providerId = prov.id as ProviderId;
  const models: ModelInfo[] = JSON.parse(prov.models_json);

  const steps: BootstrapStep[] = [];
  let already = true;

  // 1 · Espacio interno
  let ws = workspacesRepo.get(INTERNAL_WORKSPACE.slug);
  if (!ws) { ws = workspacesRepo.create({ slug: INTERNAL_WORKSPACE.slug, name: INTERNAL_WORKSPACE.name, kind: 'internal' }); already = false; steps.push({ id: 'workspace', status: 'done', detail: workspaceDbPath(ws.slug) }); }
  else steps.push({ id: 'workspace', status: 'skipped', detail: 'ya existía' });

  // 2 · Proyecto interno
  const projects = projectsRepo(ws.slug);
  let project = projects.bySlug(INTERNAL_PROJECT.slug);
  if (!project) { project = projects.create({ slug: INTERNAL_PROJECT.slug, name: INTERNAL_PROJECT.name, description: INTERNAL_PROJECT.description }); already = false; steps.push({ id: 'project', status: 'done' }); }
  else steps.push({ id: 'project', status: 'skipped', detail: 'ya existía' });

  // 3 · Objetivos y contexto aprobado (se reescriben desde la definición aprobada si están vacíos)
  if (!projects.objectives(project.id).length) { projects.setObjectives(project.id, INTERNAL_PROJECT.objectives); projects.setContext(project.id, INTERNAL_PROJECT.context); steps.push({ id: 'objectives', status: 'done' }); }
  else steps.push({ id: 'objectives', status: 'skipped', detail: 'ya existían' });

  // 4 · Estructuras persistentes: las tablas se crean al abrir la base (workspaceDb). Registramos el paso.
  steps.push({ id: 'persistence', status: 'done', detail: 'conocimiento, historial de ejecución y memoria' });

  // 5 · Equipo inicial desde plantillas
  const agents = agentsRepo(ws.slug);
  let created = 0;
  for (const t of AGENT_TEMPLATES) {
    const projectId = t.scope === 'project' ? project.id : null;
    if (agents.byKey(t.key, projectId)) continue;
    inheritLatestTemplate(ws.slug, agents.createFromTemplate(t, projectId, buildAgentConfig(t, providerId, models, prov.default_model)));
    created++;
  }
  if (created) already = false;
  steps.push({ id: 'team', status: created ? 'done' : 'skipped', detail: created ? `${created} agentes creados · inactivos` : 'equipo ya existía' });

  return { alreadyInitialized: already, workspace: ws, project, steps, agentsCreated: created, aiCalls: 0 };
}

export async function bootstrapRoutes(app: FastifyInstance) {
  app.get('/api/bootstrap/status', async () => {
    const ws = workspacesRepo.get(INTERNAL_WORKSPACE.slug);
    const project = ws ? projectsRepo(ws.slug).bySlug(INTERNAL_PROJECT.slug) ?? null : null;
    const agentCount = ws ? agentsRepo(ws.slug).count() : 0;
    const connected = providersRepo.connected().length > 0;
    return { providerConnected: connected, initialized: !!(ws && project && agentCount >= AGENT_TEMPLATES.length), workspace: ws ?? null, project, agentCount };
  });

  app.post('/api/bootstrap/internal', async (_req, reply) => {
    try { const r = runBootstrap(); app.log.info({ created: r.agentsCreated }, 'espacio interno inicializado'); return r; }
    catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
}

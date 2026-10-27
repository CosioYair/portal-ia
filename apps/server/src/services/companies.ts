import type { ModelInfo, Project, ProviderId, Workspace } from '@portal-ia/domain';
import { AGENT_TEMPLATES } from '@portal-ia/domain';
import { providersRepo, workspacesRepo } from '../db/platform.ts';
import { agentsRepo, projectsRepo } from '../db/workspace.ts';
import { buildAgentConfig } from '../routes/bootstrap.ts';
import { inheritLatestTemplate } from './agentTemplates.ts';

/**
 * Empresas (espacios de trabajo) y proyectos. Cada empresa tiene su propia base SQLite y sus agentes de espacio;
 * cada proyecto recibe su equipo de proyecto desde las plantillas aprobadas. Crear agentes no llama a modelos.
 */
const slugify = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'empresa';

function connectedProvider() {
  const connected = providersRepo.connected();
  if (!connected.length) throw Object.assign(new Error('Conecta un proveedor de IA antes de crear empresas o proyectos.'), { statusCode: 409 });
  const prov = connected[0];
  return { providerId: prov.id as ProviderId, models: JSON.parse(prov.models_json) as ModelInfo[], defaultModel: prov.default_model };
}

export function createCompany(name: string, _description?: string): Workspace {
  const clean = name.trim(); if (clean.length < 2) throw Object.assign(new Error('Nombre de empresa demasiado corto.'), { statusCode: 400 });
  let slug = slugify(clean); let n = 2; while (workspacesRepo.get(slug)) slug = `${slugify(clean)}-${n++}`;
  const { providerId, models, defaultModel } = connectedProvider();
  const ws = workspacesRepo.create({ slug, name: clean, kind: 'company' });
  const agents = agentsRepo(slug);
  for (const t of AGENT_TEMPLATES.filter(t => t.scope === 'workspace')) inheritLatestTemplate(slug, agents.createFromTemplate(t, null, buildAgentConfig(t, providerId, models, defaultModel)));
  return ws;
}

export function createProject(slug: string, name: string, description = '', objectives: string[] = []): Project {
  if (!workspacesRepo.get(slug)) throw Object.assign(new Error('Empresa no encontrada'), { statusCode: 404 });
  const clean = name.trim(); if (clean.length < 2) throw Object.assign(new Error('Nombre de proyecto demasiado corto.'), { statusCode: 400 });
  const projects = projectsRepo(slug);
  let pslug = slugify(clean); let n = 2; while (projects.bySlug(pslug)) pslug = `${slugify(clean)}-${n++}`;
  const { providerId, models, defaultModel } = connectedProvider();
  const project = projects.create({ slug: pslug, name: clean, description });
  if (objectives.length) projects.setObjectives(project.id, objectives);
  const agents = agentsRepo(slug);
  for (const t of AGENT_TEMPLATES.filter(t => t.scope === 'project')) if (!agents.byKey(t.key, project.id)) inheritLatestTemplate(slug, agents.createFromTemplate(t, project.id, buildAgentConfig(t, providerId, models, defaultModel)));
  return project;
}

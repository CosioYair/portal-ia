import type { Agent } from '@portal-ia/domain';
import { isRetired } from '@portal-ia/domain';
import { agentsRepo } from '../db/workspace.ts';

/**
 * HU-159 · Agentes que pueden recibir trabajo: todos los del espacio menos los retirados por una decisión organizativa
 * (template.retiredAt, reversible). Lo usan todos los servicios que ELIGEN agentes para trabajar (encargos, consultas,
 * Asistente, responsables de historias, evaluación inicial, prueba manual). Las vistas de organización y el compositor
 * de equipos siguen usando agentsRepo(slug).list() para mostrar a los retirados como tales.
 */
export function activeAgents(slug: string): Agent[] {
  return agentsRepo(slug).list().filter(a => !isRetired(a.template));
}

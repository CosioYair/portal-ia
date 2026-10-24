// Ruta delgada de la rama por historia (HU-128): valida con zod y delega en el servicio.
// Sin lógica git aquí. No depende de Fastify en tiempo de ejecución.

import { StoryRouteParamsSchema, validate } from '@portal/contracts';
import type { ApiError, StoryBranchErrorCode } from '@portal/contracts';
import { publishStoryBranch } from '../services/story-branch.ts';
import type { RouteRegistrar } from './story-closure.ts';

export interface StoryBranchTarget {
  readonly repoPath: string;
  readonly title: string;
}

export interface StoryBranchContext {
  /** Repositorio y título de la historia (null si no existe o no tiene repositorio). */
  getTarget(storyId: string): Promise<StoryBranchTarget | null>;
  /** Aplica en el repositorio los cambios del proceso terminado de la historia. */
  applyChanges(storyId: string, repoPath: string): Promise<void>;
}

interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

const STATUS_BY_ERROR: Record<StoryBranchErrorCode, number> = {
  'historia-invalida': 409,
  'repo-sucio': 409,
  'rama-existente': 409,
  'sin-cambios': 409,
  'fetch-fallido': 502,
  'push-fallido': 502,
  'aplicacion-fallida': 500,
  'git-fallido': 500
};

function errorResult(status: number, error: ApiError): RouteResult {
  return { status, body: error };
}

/** POST /stories/:id/branch: crea la rama de la historia desde origin/main y la publica. */
export async function publishStoryBranchHandler(
  ctx: StoryBranchContext,
  rawParams: unknown
): Promise<RouteResult> {
  const params = validate(StoryRouteParamsSchema, rawParams);
  if (!params.ok) {
    return errorResult(400, {
      code: 'validacion',
      message: params.issues.map((issue) => issue.message).join('; '),
      step: 'validacion'
    });
  }
  const storyId = params.data.id;
  const target = await ctx.getTarget(storyId);
  if (target === null) {
    return errorResult(404, {
      code: 'historia_no_encontrada',
      message: 'La historia no existe o no tiene repositorio',
      step: 'proceso'
    });
  }
  const outcome = await publishStoryBranch(
    target.repoPath,
    { id: storyId, title: target.title },
    (repoPath) => ctx.applyChanges(storyId, repoPath)
  );
  if (outcome.ok) return { status: 200, body: outcome.result };
  return errorResult(STATUS_BY_ERROR[outcome.error.code], {
    code: outcome.error.code,
    message: outcome.error.message,
    step: 'proceso'
  });
}

export function registerStoryBranchRoutes(app: RouteRegistrar, ctx: StoryBranchContext): void {
  app.post('/stories/:id/branch', async (request, reply) => {
    const result = await publishStoryBranchHandler(ctx, request.params);
    return reply.code(result.status).send(result.body);
  });
}

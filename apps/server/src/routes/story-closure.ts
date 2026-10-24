// Rutas delgadas del cierre de historias: validan con zod y delegan en el servicio.
// No dependen de Fastify en tiempo de ejecución: usan un registrador mínimo compatible con él.

import { StoryRouteParamsSchema, validate } from '@portal/contracts';
import type { ApiError } from '@portal/contracts';
import {
  StoryNotFoundError,
  completeStory,
  getStoryClosureStatus
} from '../services/story-closure.ts';
import type { StoryClosureContext } from '../services/story-closure.ts';

export interface RouteRequest {
  readonly params: unknown;
}

export interface RouteReply {
  code(status: number): { send(body: unknown): unknown };
}

export type RouteHandler = (request: RouteRequest, reply: RouteReply) => Promise<unknown>;

export interface RouteRegistrar {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

function errorResult(status: number, error: ApiError): RouteResult {
  return { status, body: error };
}

async function run(
  ctx: StoryClosureContext,
  rawParams: unknown,
  action: (storyId: string) => Promise<RouteResult>
): Promise<RouteResult> {
  const params = validate(StoryRouteParamsSchema, rawParams);
  if (!params.ok) {
    return errorResult(400, {
      code: 'validacion',
      message: params.issues.map((issue) => issue.message).join('; '),
      step: 'validacion'
    });
  }
  try {
    return await action(params.data.id);
  } catch (error) {
    if (error instanceof StoryNotFoundError) {
      return errorResult(404, { code: 'historia_no_encontrada', message: error.message, step: 'proceso' });
    }
    return errorResult(500, {
      code: 'error_interno',
      message: 'No se pudo comprobar el cierre de la historia',
      step: 'proceso'
    });
  }
}

/** GET /stories/:id/closure */
export function getClosureHandler(ctx: StoryClosureContext, rawParams: unknown): Promise<RouteResult> {
  return run(ctx, rawParams, async (storyId) => ({
    status: 200,
    body: await getStoryClosureStatus(ctx, storyId)
  }));
}

/** POST /stories/:id/complete: responde 409 con el motivo si el cierre está bloqueado. */
export function completeStoryHandler(ctx: StoryClosureContext, rawParams: unknown): Promise<RouteResult> {
  return run(ctx, rawParams, async (storyId) => {
    const result = await completeStory(ctx, storyId);
    if (!result.ok) {
      return errorResult(409, {
        code: 'cierre_bloqueado',
        message: result.status.reason ?? 'El cierre de la historia está bloqueado',
        step: 'proceso'
      });
    }
    return { status: 200, body: { completed: true } };
  });
}

export function registerStoryClosureRoutes(app: RouteRegistrar, ctx: StoryClosureContext): void {
  app.get('/stories/:id/closure', async (request, reply) => {
    const result = await getClosureHandler(ctx, request.params);
    return reply.code(result.status).send(result.body);
  });
  app.post('/stories/:id/complete', async (request, reply) => {
    const result = await completeStoryHandler(ctx, request.params);
    return reply.code(result.status).send(result.body);
  });
}

// Ruta delgada: valida el parámetro con zod, delega en el servicio y valida la salida con el contrato.

import type { FastifyInstance } from 'fastify';
import { RuntimeLocationCheckSchema, RuntimeLocationParamsSchema } from '@portal/contracts';
import type { RuntimeLocationService } from '../services/runtime-location.ts';

export interface RuntimeLocationRouteDeps {
  readonly service: RuntimeLocationService;
}

export async function runtimeLocationRoutes(
  app: FastifyInstance,
  deps: RuntimeLocationRouteDeps
): Promise<void> {
  app.get('/api/projects/:projectId/runtime-location', async (request, reply) => {
    const params = RuntimeLocationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({
        code: 'validacion_fallida',
        message: 'El identificador del proyecto no es válido.',
        step: 'validacion'
      });
    }
    const resultado = await deps.service.check(params.data.projectId);
    return RuntimeLocationCheckSchema.parse(resultado);
  });
}

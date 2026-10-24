// Rutas delgadas del estado de sincronización del Portal: validan la respuesta con zod y delegan en el servicio.

import { PortalSyncStatusSchema, RestartNoticeSchema } from '@portal/contracts';
import type { PortalSyncPort } from '../services/portal-sync.ts';

export interface SyncReply {
  code(status: number): { send(body: unknown): unknown };
}

export type SyncRouteHandler = (request: unknown, reply: SyncReply) => Promise<unknown>;

export interface SyncRouteRegistrar {
  get(path: string, handler: SyncRouteHandler): unknown;
}

export const SYNC_STATUS_PATH = '/api/portal/sync-status';
export const RESTART_NOTICE_PATH = '/api/portal/restart-notice';

function failure(reply: SyncReply, message: string): unknown {
  return reply.code(503).send({ code: 'sincronizacion_no_disponible', message });
}

export function registerPortalSyncRoutes(app: SyncRouteRegistrar, service: PortalSyncPort): void {
  app.get(SYNC_STATUS_PATH, async (_request, reply) => {
    try {
      return reply.code(200).send(PortalSyncStatusSchema.parse(await service.getSyncStatus()));
    } catch {
      return failure(reply, 'No se pudo leer el estado de git del Portal.');
    }
  });

  app.get(RESTART_NOTICE_PATH, async (_request, reply) => {
    try {
      return reply.code(200).send(RestartNoticeSchema.parse(await service.getRestartNotice()));
    } catch {
      return failure(reply, 'No se pudo calcular el aviso de reinicio del Portal.');
    }
  });
}

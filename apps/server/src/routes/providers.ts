import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROVIDER_META, type ProviderId, type ProviderView } from '@portal-ia/domain';
import { getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { credentialHint, decryptSecret, encryptSecret } from '../security/crypto.ts';

const PROVIDER_IDS = ['anthropic', 'openai'] as const;
const idSchema = z.enum(PROVIDER_IDS);

export function providerView(id: ProviderId): ProviderView {
  const row = providersRepo.get(id)!;
  const cred = providersRepo.credential(id);
  const meta = PROVIDER_META[id];
  return {
    id, name: meta.name, consoleHost: meta.consoleHost, keyHint: meta.keyHint,
    status: row.status as ProviderView['status'],
    credentialHint: cred?.hint ?? null,
    workspaceId: row.workspace_id ?? null,
    verifiedAt: row.verified_at,
    lastError: row.last_error ? JSON.parse(row.last_error) : null,
    defaultModel: row.default_model,
    models: JSON.parse(row.models_json)
  };
}

export async function providerRoutes(app: FastifyInstance) {
  app.get('/api/providers', async () => PROVIDER_IDS.map(providerView));

  app.get('/api/providers/:id', async (req, reply) => {
    const id = idSchema.safeParse((req.params as any).id);
    if (!id.success) return reply.code(404).send({ error: 'Proveedor no soportado' });
    return providerView(id.data);
  });

  // Guarda la credencial cifrada. Nunca se devuelve en claro.
  app.put('/api/providers/:id/credential', async (req, reply) => {
    const id = idSchema.safeParse((req.params as any).id);
    if (!id.success) return reply.code(404).send({ error: 'Proveedor no soportado' });
    const body = z.object({ apiKey: z.string().trim().min(8).max(512), workspaceId: z.string().trim().max(128).nullable().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Clave de API no válida' });
    providersRepo.setCredential(id.data, encryptSecret(body.data.apiKey), credentialHint(body.data.apiKey));
    if (body.data.workspaceId !== undefined) providersRepo.setWorkspaceId(id.data, body.data.workspaceId || null);
    return providerView(id.data);
  });

  // Ajustes no secretos del proveedor (p. ej. ID de workspace de Anthropic).
  app.put('/api/providers/:id/settings', async (req, reply) => {
    const id = idSchema.safeParse((req.params as any).id);
    if (!id.success) return reply.code(404).send({ error: 'Proveedor no soportado' });
    const body = z.object({ workspaceId: z.string().trim().max(128).nullable() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Ajustes no válidos' });
    providersRepo.setWorkspaceId(id.data, body.data.workspaceId || null);
    return providerView(id.data);
  });

  app.delete('/api/providers/:id/credential', async (req, reply) => {
    const id = idSchema.safeParse((req.params as any).id);
    if (!id.success) return reply.code(404).send({ error: 'Proveedor no soportado' });
    providersRepo.deleteCredential(id.data);
    return providerView(id.data);
  });

  // Verificación real: UNA solicitud de listado de modelos. No genera texto.
  app.post('/api/providers/:id/verify', async (req, reply) => {
    const id = idSchema.safeParse((req.params as any).id);
    if (!id.success) return reply.code(404).send({ error: 'Proveedor no soportado' });
    const cred = providersRepo.credential(id.data);
    if (!cred) { providersRepo.setFailed(id.data, { code: 'no_credential', message: 'No hay credencial guardada para este proveedor.' }); return reply.code(400).send(providerView(id.data)); }
    const adapter = getAdapter(id.data)!;
    providersRepo.setConnecting(id.data);
    try {
      const row = providersRepo.get(id.data)!;
      const models = await adapter.listModels(decryptSecret(cred.ciphertext), { workspaceId: row.workspace_id });
      providersRepo.setConnected(id.data, models);
      app.log.info({ provider: id.data, models: models.length }, 'proveedor verificado');
      return providerView(id.data);
    } catch (e) {
      const err = e instanceof ProviderRequestError ? e.error : { code: 'provider_error' as const, message: (e as Error).message };
      providersRepo.setFailed(id.data, err);
      app.log.warn({ provider: id.data, code: err.code }, 'verificación fallida');
      return reply.code(err.code === 'network' ? 502 : 401).send(providerView(id.data));
    }
  });

  app.put('/api/providers/:id/default-model', async (req, reply) => {
    const id = idSchema.safeParse((req.params as any).id);
    if (!id.success) return reply.code(404).send({ error: 'Proveedor no soportado' });
    const body = z.object({ modelId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Modelo no válido' });
    const view = providerView(id.data);
    if (view.status !== 'connected') return reply.code(409).send({ error: 'El proveedor no está conectado' });
    if (!view.models.some(m => m.id === body.data.modelId)) return reply.code(400).send({ error: 'El modelo no está en la lista del proveedor' });
    providersRepo.setDefaultModel(id.data, body.data.modelId);
    return providerView(id.data);
  });
}

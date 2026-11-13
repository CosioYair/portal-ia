import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { PolicyError } from '../services/executionPolicy.ts';
import { generateEdition, listEditions, renewEdition, revokeEdition, setEditionActive } from '../services/editionRegistry.ts';

/**
 * HU-214 · Módulo «Ediciones» (solo en el núcleo). Rutas delgadas: validan con zod y delegan en services/editionRegistry.ts.
 * Toda acción exige `authorized: true` en el cuerpo (autorización explícita del propietario). Sin ella, el servicio audita
 * la denegación (`policy:edition-<acción>:denied`) y la ruta responde 403 sin cambiar nada.
 * La raíz del repositorio llega como opción del plugin (registrada en app.ts); este archivo no importa la constante de config.ts.
 */
export interface EditionRoutesOptions { root: string }

const SlugParams = z.object({ slug: z.string().min(1).max(80) });
const IdParams = SlugParams.extend({ id: z.string().min(1).max(80) });
const ActionBody = z.object({ authorized: z.boolean().optional() }).passthrough();

const fail = (reply: any, e: any) => reply
  .code(e instanceof PolicyError ? 403 : e?.statusCode ?? 500)
  .send({ error: e?.message ?? 'No se pudo completar la acción sobre la edición.', code: typeof e?.code === 'string' ? e.code : undefined });

const badRequest = (reply: any, issues: { message: string }[]) => reply.code(400).send({ error: issues[0]?.message ?? 'Petición no válida.', code: 'invalid_request' });

export async function editionRoutes(app: FastifyInstance, opts: EditionRoutesOptions) {
  app.get('/api/workspaces/:slug/editions', async (req, reply) => {
    const p = SlugParams.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error.issues);
    try { return listEditions(p.data.slug); } catch (e: any) { return fail(reply, e); }
  });

  app.post('/api/workspaces/:slug/editions', async (req, reply) => {
    const p = SlugParams.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error.issues);
    const b = ActionBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error.issues);
    try {
      const edition = await generateEdition(p.data.slug, b.data.authorized === true, { root: opts.root, webDist: config.webDist, dataDir: config.dataDir });
      return reply.code(201).send(edition);
    } catch (e: any) { return fail(reply, e); }
  });

  const transitions: Record<'renew' | 'activate' | 'deactivate' | 'revoke', (slug: string, id: string, authorized: boolean) => unknown> = {
    renew: (slug, id, authorized) => renewEdition(slug, id, authorized),
    activate: (slug, id, authorized) => setEditionActive(slug, id, true, authorized),
    deactivate: (slug, id, authorized) => setEditionActive(slug, id, false, authorized),
    revoke: (slug, id, authorized) => revokeEdition(slug, id, authorized)
  };
  for (const [action, run] of Object.entries(transitions)) {
    app.post(`/api/workspaces/:slug/editions/:id/${action}`, async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success) return badRequest(reply, p.error.issues);
      const b = ActionBody.safeParse(req.body ?? {});
      if (!b.success) return badRequest(reply, b.error.issues);
      try { return run(p.data.slug, p.data.id, b.data.authorized === true); } catch (e: any) { return fail(reply, e); }
    });
  }
}

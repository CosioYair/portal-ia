import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOwner } from '../services/ownerSession.ts';
import { ownerDisplayName, saveOwnerDisplayName } from '../services/portalSeal.ts';

/**
 * EN-021 · Ajuste «Tu nombre» (de la instalación, no de cada empresa). Está vacío por defecto.
 * Con valor, la línea 2 del sello lo usa. Vacío, el agente pregunta una sola vez cómo llamar al propietario.
 * El nombre solo sale de este ajuste: nunca del correo ni de otra fuente.
 */
const OwnerNameBody = z.object({ name: z.string().trim().max(80, 'El nombre admite como máximo 80 caracteres.') });

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings/owner-name', async () => ({ name: ownerDisplayName() ?? '' }));
  app.put('/api/settings/owner-name', async (req, reply) => {
    // El nombre entra en el prompt de todos los agentes: solo lo cambia el propietario (además del gancho central de app.ts).
    if (!requireOwner(req, reply)) return reply;
    const body = OwnerNameBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Nombre no válido.', code: 'invalid_owner_name' });
    try { return { name: saveOwnerDisplayName(body.data.name) ?? '' }; }
    catch (e: any) { return reply.code(500).send({ error: e?.message ?? 'No se pudo guardar el nombre.', code: 'save_failed' }); }
  });
}

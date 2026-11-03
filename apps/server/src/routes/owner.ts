import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isOwner, issuePairingCode, pairingState, pairOwner, requireOwner, revokeAllOwners, revokeOwner, sameOriginJson } from '../services/ownerSession.ts';

/**
 * Vincular el navegador del propietario (ver services/ownerSession.ts). El código nunca viaja por la API: se escribe en un
 * archivo de tu perfil y en la ventana donde se arrancó el Portal; la respuesta solo dice dónde mirar.
 */
export async function ownerRoutes(app: FastifyInstance) {
  const send = (reply: any, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code });
  app.get('/api/owner/session', async req => ({ owner: isOwner(req), ...pairingState() }));
  app.post('/api/owner/pairing', async (req, reply) => {
    if (!sameOriginJson(req, reply)) return;
    try { const r = issuePairingCode(); return { ok: true, expiresInSec: r.expiresInSec, file: r.file, problem: r.problem }; } catch (e) { return send(reply, e); }
  });
  app.post('/api/owner/pair', async (req, reply) => {
    if (!sameOriginJson(req, reply)) return;
    const body = z.object({ code: z.string().max(64) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Escribe el código.', code: 'code_required' });
    try { const { token, expiresAt } = pairOwner(body.data.code, String(req.headers['user-agent'] ?? '').slice(0, 160) || null); return { owner: true, token, expiresAt }; }
    catch (e) { return send(reply, e); }
  });
  app.post('/api/owner/logout', async (req, reply) => {
    if (!sameOriginJson(req, reply)) return;
    revokeOwner(req); return { owner: false };
  });
  app.post('/api/owner/logout-all', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    return { owner: false, closed: revokeAllOwners() };
  });
}

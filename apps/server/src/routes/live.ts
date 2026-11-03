import type { FastifyInstance } from 'fastify';
import { liveCursor, missedSince, subscribeLive, type LiveMessage } from '../services/live.ts';

/** Conexiones abiertas a la vez (una por pestaña visible): un tope evita agotar el servidor. */
const MAX_STREAMS = 32;
let open = 0;
/** Latido: el cliente da la conexión por muerta si pasan 2,5 latidos sin noticias (redes que se cortan sin avisar). */
const PING_MS = () => Number(process.env.PORTAL_LIVE_PING_MS) || 15_000;

/**
 * Canal de cambios en tiempo real (Server-Sent Events). Solo ids y tipos de lo que cambió, nunca contenido ni secretos:
 * la interfaz vuelve a pedir lo que muestra por las rutas de siempre. `Last-Event-ID` (o `?since=epoch:seq`) recupera lo
 * perdido en una desconexión breve; si no se puede (reinicio del servidor u hueco demasiado grande) se envía `resync` y el
 * cliente vuelve a pedir todo. Un latido cada 15 s mantiene viva la conexión y la hora del servidor.
 */
export async function liveRoutes(app: FastifyInstance) {
  app.get('/api/events', (req, reply) => {
    if (open >= MAX_STREAMS) return reply.code(503).send({ error: 'Demasiadas conexiones en tiempo real abiertas; la interfaz seguirá consultando periódicamente.' });
    const since = (req.headers['last-event-id'] as string | undefined) ?? ((req.query as any)?.since as string | undefined) ?? null;
    const origin = req.headers.origin;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no',
      'x-server-time': String(Date.now()),
      // Sin cabecera CORS: la interfaz es del mismo origen; otra página no puede leer este canal.
    });
    open++;
    const send = (m: LiveMessage) => res.write(`id: ${m.epoch}:${m.seq}\ndata: ${JSON.stringify(m)}\n\n`);
    const cur = liveCursor();
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ ...cur, serverTime: Date.now(), pingMs: PING_MS() })}\n\n`);
    const missed = missedSince(since);
    if (missed === null) res.write(`event: resync\ndata: ${JSON.stringify({ ...cur, serverTime: Date.now() })}\n\n`);
    else missed.forEach(send);
    const off = subscribeLive(send);
    const beat = setInterval(() => res.write(`event: ping\ndata: ${JSON.stringify({ serverTime: Date.now() })}\n\n`), PING_MS());
    beat.unref?.();
    let closed = false;
    const close = () => { if (closed) return; closed = true; open--; off(); clearInterval(beat); };
    req.raw.on('close', close); res.on('close', close); res.on('error', close);
  });
}

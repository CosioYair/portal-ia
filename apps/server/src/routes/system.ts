import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runningEverywhere, startUpdate, systemStatus } from '../services/system.ts';
import { buildOutcome, computeStartCommands, scheduleShutdown } from '../services/lifecycle.ts';
import { PolicyError, policyTable, requirePolicy } from '../services/executionPolicy.ts';
import { INTERNAL_WORKSPACE } from '@portal-ia/domain';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const runningError = (running: { title: string }[]) => ({ error: `Hay ${running.length} proceso(s) en ejecución (${running.slice(0, 3).map(r => `«${r.title}»`).join(', ')}${running.length > 3 ? '…' : ''}). Reiniciar los interrumpiría: quedarían en pausa, sin repetir lo hecho, y se retoman a mano. Espera a que terminen o confirma que quieres interrumpirlos.`, code: 'running_processes', running });

/** Estado del propio Portal (código arrancado vs. actual) y actualización autorizada (reconstruir + reiniciar). */
export async function systemRoutes(app: FastifyInstance) {
  app.get('/api/system/status', async (_req, reply) => { try { return await systemStatus(); } catch (e: any) { return reply.code(500).send({ error: e.message }); } });
  // HU-144 · Qué ocurriría al reiniciar (sin hacerlo): modo y comandos exactos para el propietario.
  app.get('/api/system/lifecycle', async () => ({ ...buildOutcome(), startCommands: computeStartCommands().commands }));
  // HU-144 · «Reiniciar»: responde 202 y después apaga limpio (o sale con el código 75 si hay supervisor).
  app.post('/api/system/restart', async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send({ error: 'Solo se puede reiniciar desde la propia máquina.' });
    const body = z.object({ confirm: z.literal(true), interruptRunning: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere confirmación explícita.' });
    { const running = runningEverywhere(); if (running.length && !body.data.interruptRunning) return reply.code(409).send(runningError(running)); }
    try { requirePolicy('restart_portal', { slug: INTERNAL_WORKSPACE.slug, authorized: true }); } catch (e: any) { return reply.code(e.statusCode ?? 403).send({ error: e.message, code: e instanceof PolicyError ? e.code : undefined }); }
    const outcome = buildOutcome();
    scheduleShutdown(app, reply, outcome);
    return reply.code(202).send(outcome);
  });
  app.post('/api/system/update', async (req, reply) => {
    const body = z.object({ authorized: z.literal(true), install: z.boolean().optional(), restart: z.boolean().optional(), interruptRunning: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita.' });
    // Reiniciar interrumpiría los procesos en marcha: solo con tu confirmación expresa (no se cancelan; quedan en pausa).
    if (body.data.restart !== false) { const running = runningEverywhere(); if (running.length && !body.data.interruptRunning) return reply.code(409).send(runningError(running)); }
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send({ error: 'Solo se puede reconstruir desde la propia máquina.' });
    try {
      requirePolicy('restart_portal', { slug: INTERNAL_WORKSPACE.slug, authorized: true });
      const st = await systemStatus();
      const install = body.data.install ?? st.changedFiles.some(f => /(^|\/)package(-lock)?\.json$/.test(f));
      const u = await startUpdate({ install, restart: body.data.restart ?? true, interruptRunning: !!body.data.interruptRunning }, (o, m) => app.log.info(o, m));
      return { update: u, install };
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e instanceof PolicyError ? e.code : undefined }); }
  });
  /** Tabla de la política de ejecución (qué operaciones existen, su nivel y la herramienta que exigen). Solo lectura. */
  app.get('/api/system/policy', async () => policyTable());
}

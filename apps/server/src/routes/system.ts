import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runningEverywhere, startUpdate, systemStatus } from '../services/system.ts';
import { buildOutcome, computeStartCommands, scheduleShutdown } from '../services/lifecycle.ts';
import { PolicyError, policyTable, requirePolicy } from '../services/executionPolicy.ts';
import { INTERNAL_WORKSPACE } from '@portal-ia/domain';
import { EDITION_DISABLED_REASON, SELF_IMPROVEMENT_ENABLED } from '../config.ts';

/** HU-205 · En la edición distribuible no hay automejora: reconstruir, reiniciar y activar responden 403 antes de validar nada. */
const editionDisabled = () => ({ error: EDITION_DISABLED_REASON, code: 'edition_distributable' as const });

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const runningError = (running: { title: string }[]) => ({ error: `Hay ${running.length} proceso(s) en ejecución (${running.slice(0, 3).map(r => `«${r.title}»`).join(', ')}${running.length > 3 ? '…' : ''}). Reiniciar los interrumpiría: quedarían en pausa, sin repetir lo hecho, y se retoman a mano. Espera a que terminen o confirma que quieres interrumpirlos.`, code: 'running_processes', running });

/** Estado del propio Portal (código arrancado vs. actual) y actualización autorizada (reconstruir + reiniciar). */
/**
 * Reiniciar o reconstruir carga el código que haya en disco: solo si es el que viste. `expectedHead` es el commit que
 * mostraba el estado (null si el Portal no corre desde un repositorio git: entonces tiene que seguir sin haberlo).
 */
const EXPECTED_HEAD = z.union([z.string().regex(/^[0-9a-f]{4,40}$/), z.null()]);
const sameHead = (seen: string | null, now: string | null) => seen === null || now === null ? seen === now : now.startsWith(seen) || seen.startsWith(now);
export async function systemRoutes(app: FastifyInstance) {
  app.get('/api/system/status', async (_req, reply) => { try { return await systemStatus(); } catch (e: any) { return reply.code(500).send({ error: e.message }); } });
  // HU-144 · Qué ocurriría al reiniciar (sin hacerlo): modo y comandos exactos para el propietario.
  app.get('/api/system/lifecycle', async () => ({ ...buildOutcome(), startCommands: computeStartCommands().commands }));
  // HU-144 · «Reiniciar»: responde 202 y después apaga limpio (o sale con el código 75 si hay supervisor).
  app.post('/api/system/restart', async (req, reply) => {
    if (!SELF_IMPROVEMENT_ENABLED) return reply.code(403).send(editionDisabled());
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send({ error: 'Solo se puede reiniciar desde la propia máquina.' });
    const body = z.object({ confirm: z.literal(true), interruptRunning: z.boolean().optional(), expectedHead: EXPECTED_HEAD }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere confirmación explícita y el commit que viste.' });
    // Al reiniciar se carga el código que haya en disco: solo si es el que viste (si avanzó, p. ej. otra integración, no).
    { const head = (await systemStatus()).headCommit ?? null; if (!sameHead(body.data.expectedHead, head)) return reply.code(409).send({ error: `El Portal cambió desde que lo viste (ahora ${head ?? '—'}): no se ha reiniciado. Revisa y vuelve a pulsar.`, code: 'stale_state' }); }
    { const running = runningEverywhere(); if (running.length && !body.data.interruptRunning) return reply.code(409).send(runningError(running)); }
    try { requirePolicy('restart_portal', { slug: INTERNAL_WORKSPACE.slug, authorized: true }); } catch (e: any) { return reply.code(e.statusCode ?? 403).send({ error: e.message, code: e instanceof PolicyError ? e.code : undefined }); }
    const outcome = buildOutcome();
    scheduleShutdown(app, reply, outcome);
    return reply.code(202).send(outcome);
  });
  app.post('/api/system/update', async (req, reply) => {
    if (!SELF_IMPROVEMENT_ENABLED) return reply.code(403).send(editionDisabled());
    const body = z.object({ authorized: z.literal(true), install: z.boolean().optional(), restart: z.boolean().optional(), interruptRunning: z.boolean().optional(), expectedHead: EXPECTED_HEAD }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita y el commit que viste.' });
    // Reiniciar interrumpiría los procesos en marcha: solo con tu confirmación expresa (no se cancelan; quedan en pausa).
    if (body.data.restart !== false) { const running = runningEverywhere(); if (running.length && !body.data.interruptRunning) return reply.code(409).send(runningError(running)); }
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send({ error: 'Solo se puede reconstruir desde la propia máquina.' });
    try {
      requirePolicy('restart_portal', { slug: INTERNAL_WORKSPACE.slug, authorized: true });
      const st = await systemStatus();
      // Se activa lo que viste: si el repositorio avanzó desde entonces (p. ej. otra integración), no se reconstruye.
      if (!sameHead(body.data.expectedHead, st.headCommit ?? null)) return reply.code(409).send({ error: `El Portal cambió desde que lo viste (ahora ${st.headCommit ?? '—'}): no se ha reconstruido. Revisa el aviso y vuelve a pulsar.`, code: 'stale_state' });
      const install = body.data.install ?? st.changedFiles.some(f => /(^|\/)package(-lock)?\.json$/.test(f));
      const u = await startUpdate({ install, restart: body.data.restart ?? true, interruptRunning: !!body.data.interruptRunning }, (o, m) => app.log.info(o, m));
      return { update: u, install };
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e instanceof PolicyError || e?.code === 'edition_distributable' ? e.code : undefined }); }
  });
  /** Tabla de la política de ejecución (qué operaciones existen, su nivel y la herramienta que exigen). Solo lectura. */
  app.get('/api/system/policy', async () => policyTable());
}

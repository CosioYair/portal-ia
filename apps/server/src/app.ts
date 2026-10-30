import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { config, REPO_ROOT } from './config.ts';
import { providerRoutes } from './routes/providers.ts';
import { fsRoutes } from './routes/fs.ts';
import { bootstrapRoutes } from './routes/bootstrap.ts';
import { workspaceRoutes } from './routes/workspaces.ts';
import { processRoutes } from './routes/processes.ts';
import { assistantRoutes } from './routes/assistant.ts';
import { systemRoutes } from './routes/system.ts';
import { integrationRoutes } from './routes/integration.ts';
import { inboxRoutes } from './routes/inbox.ts';
import { budgetRoutes } from './routes/budgets.ts';
import { manualTestFeedbackRoutes } from './routes/manual-test-feedback.ts';
import { learningRoutes } from './routes/learning.ts';
import { storyRoutes } from './routes/stories.ts';
import { phaseRoutes, registerArchivedGuard } from './routes/phase.ts';
import { claudeCodeRoutes } from './routes/claudeCode.ts';
import { metricsRoutes } from './routes/metrics.ts';
import { gauntletRoutes } from './routes/gauntlet.ts';
import { orgEvaluationRoutes } from './routes/orgEvaluation.ts';
import { VERSION } from './services/system.ts';

/** Script principal del paquete de la interfaz que se sirve (p. ej. «index-BYW4Vz5N.js»), o null sin paquete construido. Se relee cada 10 s. */
let bundleCache: { at: number; name: string | null } | null = null;
function currentWebBundle(): string | null {
  if (bundleCache && Date.now() - bundleCache.at < 10_000) return bundleCache.name;
  let name: string | null = null;
  try { name = fs.readFileSync(path.join(config.webDist, 'index.html'), 'utf8').match(/\/assets\/(index-[\w-]+\.js)/)?.[1] ?? null; } catch { /* sin paquete construido */ }
  bundleCache = { at: Date.now(), name }; return name;
}

export async function buildApp() {
  const app = Fastify({
    bodyLimit: 25 * 1024 * 1024, // adjuntos (imágenes) del asistente
    forceCloseConnections: true, // HU-144: al cerrar, no esperar a conexiones keep-alive/SSE (el puerto debe liberarse)
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.body.apiKey'] }
  });

  // El frontend de desarrollo (Vite, puerto 5173) habla con este backend; en producción se sirve desde aquí mismo.
  await app.register(cors, { origin: [/^http:\/\/(localhost|127\.0\.0\.1):\d+$/], exposedHeaders: ['x-server-time', 'x-portal-web'] });
  // Cada respuesta de la API lleva la hora del servidor (la interfaz mide con ella, no con el reloj del navegador, y sabe
  // cuándo habló por última vez con el servidor) y nunca se guarda en caché: recargar siempre muestra el estado real.
  // También el paquete de la interfaz que sirve ahora: una pestaña abierta con un paquete anterior (tras reconstruir y
  // reiniciar) lo detecta y pide recargar, en vez de ignorar acciones que no conoce (HU-159).
  app.addHook('onSend', async (req, reply, payload) => { if (req.url.startsWith('/api/')) { reply.header('x-server-time', String(Date.now())).header('cache-control', 'no-store'); const web = currentWebBundle(); if (web) reply.header('x-portal-web', web); } return payload; });

  app.get('/api/health', async () => ({ ok: true, name: 'portal-ia', version: VERSION, dataDir: config.dataDir, repoRoot: REPO_ROOT }));

  registerArchivedGuard(app);
  await app.register(providerRoutes);
  await app.register(fsRoutes);
  await app.register(bootstrapRoutes);
  await app.register(workspaceRoutes);
  await app.register(processRoutes);
  await app.register(assistantRoutes);
  await app.register(systemRoutes);
  await app.register(integrationRoutes);
  await app.register(inboxRoutes);
  await app.register(budgetRoutes);
  await app.register(manualTestFeedbackRoutes);
  await app.register(learningRoutes);
  await app.register(storyRoutes);
  await app.register(phaseRoutes);
  await app.register(claudeCodeRoutes);
  await app.register(metricsRoutes);
  await app.register(gauntletRoutes);
  await app.register(orgEvaluationRoutes);

  // Producción local: sirve apps/web/dist si existe (npm run build). SPA fallback.
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    // index.html y build-info.json nunca se cachean: tras reconstruir, el navegador debe ver la interfaz nueva (M2).
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', setHeaders: (res, filePath) => { if (/index\.html$|build-info\.json$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); } });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Ruta no encontrada' });
      return reply.header('Cache-Control', 'no-cache, no-store, must-revalidate').sendFile('index.html');
    });
  }
  return app;
}

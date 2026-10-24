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
import { VERSION } from './services/system.ts';

export async function buildApp() {
  const app = Fastify({
    bodyLimit: 25 * 1024 * 1024, // adjuntos (imágenes) del asistente
    forceCloseConnections: true, // HU-144: al cerrar, no esperar a conexiones keep-alive/SSE (el puerto debe liberarse)
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.body.apiKey'] }
  });

  // El frontend de desarrollo (Vite, puerto 5173) habla con este backend; en producción se sirve desde aquí mismo.
  await app.register(cors, { origin: [/^http:\/\/(localhost|127\.0\.0\.1):\d+$/] });

  app.get('/api/health', async () => ({ ok: true, name: 'portal-ia', version: VERSION, dataDir: config.dataDir, repoRoot: REPO_ROOT }));

  await app.register(providerRoutes);
  await app.register(fsRoutes);
  await app.register(bootstrapRoutes);
  await app.register(workspaceRoutes);
  await app.register(processRoutes);
  await app.register(assistantRoutes);
  await app.register(systemRoutes);
  await app.register(integrationRoutes);

  // Producción local: sirve apps/web/dist si existe (npm run build). SPA fallback.
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Ruta no encontrada' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}

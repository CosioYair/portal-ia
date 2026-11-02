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
import { batchRoutes } from './routes/batches.ts';
import { previewRoutes } from './routes/previews.ts';
import { assignmentRoutes } from './routes/assignments.ts';
import { orgEvaluationRoutes } from './routes/orgEvaluation.ts';
import { liveRoutes } from './routes/live.ts';
import { agentsOsRoutes } from './routes/agentsOs.ts';
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
  const ALLOWED_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;
  await app.register(cors, { origin: [ALLOWED_ORIGIN], exposedHeaders: ['x-server-time', 'x-portal-web'] });
  // Una petición que CAMBIA algo y llega desde otra página del navegador (otro origen que no es el del Portal ni su interfaz
  // de desarrollo: p. ej. la vista previa del código de un candidato, servida en 127.0.0.2) se rechaza. CORS solo impide
  // leer la respuesta; una petición «simple» (formulario, texto) llegaría igual. Sin cabecera Origin (herramientas, pruebas,
  // la propia interfaz al pedir con GET) no cambia nada.
  // La API solo responde a un Host de bucle local (o a los de PORTAL_ALLOWED_HOSTS): una página de otro dominio que se
  // «reasigne» a 127.0.0.1 (DNS rebinding) no lee ni cambia nada. Escuchando en la red (PORTAL_HOST no local) se acepta
  // cualquier Host: es una decisión explícita de quien lo configura.
  const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;
  const EXTRA_HOSTS = (process.env.PORTAL_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  const LOCAL_ONLY = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/i.test(config.host);
  // Copia de una vista previa (un candidato servido por su proxy): no es el Portal en marcha.
  const PREVIEW = process.env.PORTAL_PREVIEW === '1';
  const hostAllowed = (h: string | undefined) => !h || !LOCAL_ONLY || LOOPBACK_HOST.test(h) || EXTRA_HOSTS.includes(h.replace(/:\d+$/, '').toLowerCase());
  app.addHook('onRequest', async (req, reply) => {
    if (!hostAllowed(req.headers.host)) return reply.code(403).send({ error: 'Petición rechazada: el Portal solo atiende en su dirección local.', code: 'foreign_host' });
    // Llegar al Portal EN MARCHA desde otra página (p. ej. una vista previa que te redirige aquí): se avisa antes de mostrarlo,
    // para que no confundas el Portal real con la copia que estabas probando.
    if (!PREVIEW && !req.url.startsWith('/api/') && req.method === 'GET' && req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] === 'navigate') {
      const to = req.url.startsWith('/') && !req.url.startsWith('//') ? req.url : '/';
      return reply.code(200).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Portal IA en marcha</title></head><body style="font-family:system-ui,sans-serif;max-width:640px;margin:12vh auto;padding:0 20px;line-height:1.5"><h1 style="font-size:22px">Estás entrando en el Portal IA EN MARCHA</h1><p>Has llegado desde otra página (por ejemplo, una vista previa de un candidato). Lo que hagas aquí es real: aceptar, integrar o borrar afecta a tu Portal y a tus datos.</p><p><a href="${to.replace(/"/g, '%22').replace(/</g, '%3C')}">Continuar al Portal en marcha</a></p></body></html>`);
    }
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin; if (!origin || ALLOWED_ORIGIN.test(origin)) return;
    try { if (new URL(origin).host === req.headers.host && hostAllowed(req.headers.host)) return; } catch { /* origen no válido */ }
    return reply.code(403).send({ error: 'Petición rechazada: viene de otra página que no es el Portal.', code: 'foreign_origin' });
  });
  // Cada respuesta de la API lleva la hora del servidor (la interfaz mide con ella, no con el reloj del navegador, y sabe
  // cuándo habló por última vez con el servidor) y nunca se guarda en caché: recargar siempre muestra el estado real.
  // También el paquete de la interfaz que sirve ahora: una pestaña abierta con un paquete anterior (tras reconstruir y
  // reiniciar) lo detecta y pide recargar, en vez de ignorar acciones que no conoce (HU-159).
  // Nunca dentro de un marco de otra página (una vista previa no puede mostrar el Portal y hacerte pulsar en él).
  app.addHook('onSend', async (req, reply, payload) => { reply.header('x-frame-options', 'DENY').header('content-security-policy', "frame-ancestors 'none'"); if (req.url.startsWith('/api/')) { reply.header('x-server-time', String(Date.now())).header('cache-control', 'no-store'); const web = currentWebBundle(); if (web) reply.header('x-portal-web', web); } return payload; });

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
  await app.register(batchRoutes);
  await app.register(previewRoutes);
  await app.register(assignmentRoutes);
  await app.register(orgEvaluationRoutes);
  await app.register(liveRoutes);
  await app.register(agentsOsRoutes);

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

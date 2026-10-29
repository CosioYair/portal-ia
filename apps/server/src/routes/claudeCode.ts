import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { backendLabel, type ClaudeCodeStatusView, type ClaudeCodeWorkspaceView } from '@portal-ia/domain';
import { claudeCodeWorkersRepo, providersRepo, workspacesRepo } from '../db/platform.ts';
import { agentsRepo, claudeCodeRunsRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { agentBackend, BRIDGE_SCRIPT, getBridgeUrl, runningClaudeCode, teamReadiness } from '../services/claudeCode/backend.ts';
import {
  claimTask, createWorker, disconnectWorker, isDenied, listTaskFiles, listTasks, readTaskFile, reportBlocker, reportProgress, scopeFor,
  submitResult, taskContext, taskFor, taskKnowledge, touchWorker, workerView, type BridgeScope, type BridgeTask
} from '../services/claudeCode/bridge.ts';
import { runCliTask } from '../services/claudeCode/cli.ts';
import { cliCommandFor, detectClaudeCode, lastDetection, verifiedDetection } from '../services/claudeCode/detect.ts';
import { getClaudeCodeSettings, saveClaudeCodeSettings } from '../services/claudeCode/settings.ts';

/**
 * Conector «Claude Code — Local».
 * - Configuración (propietario, desde la interfaz): detectar la CLI y su sesión SIN llamar al modelo, activar con
 *   autorización explícita, autorizar proyectos, asignar el backend a agentes concretos, crear y revocar consolas.
 * - Puente (`/api/bridge/v1/*`, lo usa scripts/portal-mcp.mjs): exige un token; el alcance sale del token.
 */
export function claudeCodeStatus(): ClaudeCodeStatusView {
  const s = getClaudeCodeSettings(); const d = lastDetection();
  const ready = s.enabled && d?.billing === 'subscription';
  const readyReason = !s.enabled ? 'Desactivado. Comprueba la instalación y actívalo con tu autorización para poder usarlo.'
    : !d ? 'Sin comprobar todavía.' : d.billing !== 'subscription' ? (d.problems[0] ?? 'No verificado.') : 'Activo: las ejecuciones usan tu suscripción de Claude (con sus límites de uso).';
  return { settings: s, detection: d, sourceLabel: backendLabel('claude-code', d?.billing ?? 'unverified'), ready, readyReason, running: runningClaudeCode() };
}

const settingsBody = z.object({
  authorized: z.literal(true).optional(),
  enabled: z.boolean().optional(),
  cliPath: z.string().trim().min(1).max(1000).nullable().optional(),
  maxConcurrent: z.number().int().min(1).max(4).optional(),
  maxDurationSec: z.number().int().min(60).max(3600).optional(),
  maxTurns: z.number().int().min(1).max(50).optional(),
  repoRead: z.boolean().optional(),
  fallback: z.enum(['none', 'api']).optional()
}).strict();

const BRIDGE_TOOLS_JOB = ['portal_task_context', 'portal_list_files', 'portal_read_file', 'portal_knowledge', 'portal_report_progress'];
const BRIDGE_TOOLS_WORKER = ['portal_whoami', 'portal_list_tasks', 'portal_claim_task', ...BRIDGE_TOOLS_JOB, 'portal_submit_result', 'portal_report_blocker'];

export async function claudeCodeRoutes(app: FastifyInstance) {
  app.get('/api/claude-code', async () => claudeCodeStatus());

  // Detección: `claude --version` y `claude auth status`. No envía nada al modelo ni consume uso.
  app.post('/api/claude-code/detect', async () => { await detectClaudeCode(getClaudeCodeSettings()); return claudeCodeStatus(); });

  app.put('/api/claude-code/settings', async (req, reply) => {
    const body = settingsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Ajustes no válidos', issues: body.error.issues });
    const cur = getClaudeCodeSettings(); const b = body.data;
    if (b.cliPath && !cliCommandFor(b.cliPath)) return reply.code(400).send({ error: 'La ruta no es un ejecutable de Claude Code utilizable (un .cmd se resuelve a su claude.exe; no se ejecuta con un shell).' });
    const next = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'authorized')) };
    // Activar o permitir la API como alternativa son decisiones del propietario: autorización explícita en la petición.
    const enabling = b.enabled === true && !cur.enabled; const allowingApi = b.fallback === 'api' && cur.fallback !== 'api';
    if ((enabling || allowingApi) && b.authorized !== true) return reply.code(403).send({ error: enabling ? 'Activar Claude Code requiere tu autorización explícita.' : 'Usar la API (facturable) como alternativa requiere tu autorización explícita.' });
    if (next.enabled) {
      // Activar o cambiar la CLI repite la comprobación completa, sonda sin modelo incluida.
      const d = enabling || b.cliPath !== undefined ? await detectClaudeCode(next) : await verifiedDetection(next);
      if (d.billing !== 'subscription') return reply.code(409).send({ error: `No se puede activar: ${d.problems[0] ?? 'la suscripción no está verificada'}`, status: claudeCodeStatus() });
    }
    if (allowingApi && !providersRepo.connected().length) return reply.code(409).send({ error: 'No hay ningún proveedor de API conectado que pueda servir de alternativa.' });
    saveClaudeCodeSettings({ ...next, authorizedAt: enabling ? new Date().toISOString() : next.authorizedAt });
    return claudeCodeStatus();
  });

  /**
   * Prueba de humo: UNA llamada real, mínima y de solo lectura (sin herramientas, sin puente, sin datos del proyecto,
   * `haiku`, 1 turno) por el MISMO adaptador que las ejecuciones. Solo con autorización explícita; se registra en el
   * espacio interno para que se vea en «Uso de hoy». Comprueba la sesión antes y el origen de la clave al arrancar.
   */
  app.post('/api/claude-code/smoke-test', async (req, reply) => {
    const body = z.object({ authorized: z.literal(true) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(403).send({ error: 'La prueba de humo usa tu suscripción: requiere tu autorización explícita.' });
    const s = getClaudeCodeSettings();
    const d = await verifiedDetection(s, 0);
    if (d.billing !== 'subscription') return reply.code(409).send({ error: `No se ejecuta: ${d.problems[0] ?? 'la suscripción no está verificada'}`, status: claudeCodeStatus() });
    if (!d.capabilities.includes('restricted')) return reply.code(409).send({ error: `Claude Code ${d.version ?? ''} no admite el modo restringido: actualízalo.`, status: claudeCodeStatus() });
    const cli = cliCommandFor(s.cliPath ?? d.path ?? '');
    if (!cli) return reply.code(409).send({ error: 'No se encontró la CLI de Claude Code.' });
    const ws = workspacesRepo.list().find(w => w.kind === 'internal'); const project = ws ? projectsRepo(ws.slug).list()[0] : undefined;
    const runs = ws && project ? claudeCodeRunsRepo(ws.slug) : null;
    const run = runs?.start({ mode: 'cli', projectId: project!.id, processId: null, stepId: null, agentId: 'prueba-de-humo', agentName: 'Prueba de humo del conector', model: 'haiku', billing: d.billing, authMethod: d.authMethod, subscriptionType: d.subscriptionType });
    const started = Date.now();
    try {
      const r = await runCliTask({ cli, detection: d, model: 'haiku', system: 'Eres una prueba de conexión de Portal IA. No uses herramientas.', prompt: 'Respond with exactly the word OK.', maxTurns: 1, timeoutMs: 120_000, signal: AbortSignal.timeout(130_000) });
      if (run) runs!.finish(run.id, 'done', { durationMs: r.durationMs, numTurns: r.numTurns, tokensIn: r.inputTokens, tokensOut: r.outputTokens, apiEquivalentUsd: r.apiEquivalentUsd, rateLimit: r.rateLimit });
      req.log.info({ authMethod: d.authMethod, apiKeySource: r.apiKeySource }, 'prueba de humo de Claude Code completada');
      return { ok: true, answer: r.text.slice(0, 200), expected: r.text.trim() === 'OK', model: r.session?.model ?? null, session: r.session, exitCode: r.exitCode, numTurns: r.numTurns, stopReason: r.stopReason, permissionDenials: r.permissionDenials, authMethod: d.authMethod, subscriptionType: d.subscriptionType, apiKeySource: r.apiKeySource, tokensIn: r.inputTokens, tokensOut: r.outputTokens, apiEquivalentUsd: r.apiEquivalentUsd, rateLimit: r.rateLimit, durationMs: r.durationMs, apiBudgetChargedUsd: 0, runId: run?.id ?? null };
    } catch (e: any) {
      if (run) runs!.finish(run.id, e?.error?.code === 'usage_limit' ? 'limit' : 'failed', { durationMs: Date.now() - started, error: e?.message ?? String(e) });
      return reply.code(502).send({ ok: false, error: e?.message ?? String(e), code: e?.error?.code ?? null });
    }
  });

  const guard = (slug: string, reply: FastifyReply) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };

  app.get('/api/workspaces/:slug/claude-code', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!guard(slug, reply)) return;
    const s = getClaudeCodeSettings(); const runs = claudeCodeRunsRepo(slug);
    const view: ClaudeCodeWorkspaceView = {
      status: claudeCodeStatus(),
      projects: s.projects[slug] ?? [],
      agents: agentsRepo(slug).list().map(a => ({ id: a.id, name: a.config.name, projectId: a.projectId, provider: a.config.provider, backend: agentBackend(a) })),
      workers: claudeCodeWorkersRepo.list(slug).map(workerView),
      runs: runs.recent(20),
      usageToday: runs.usageToday(),
      bridge: { command: process.execPath, args: [BRIDGE_SCRIPT], portalUrl: getBridgeUrl() }
    };
    return view;
  });

  app.put('/api/workspaces/:slug/claude-code/projects', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), projectIds: z.array(z.string().min(1).max(80)).max(200) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Indica los proyectos y confirma tu autorización.' });
    const own = new Set(projectsRepo(slug).list().map(p => p.id));
    const bad = body.data.projectIds.filter(id => !own.has(id));
    if (bad.length) return reply.code(404).send({ error: `Proyecto no encontrado en este espacio: ${bad[0]}` });
    const s = getClaudeCodeSettings();
    saveClaudeCodeSettings({ ...s, projects: { ...s.projects, [slug]: [...new Set(body.data.projectIds)] } });
    return { projects: getClaudeCodeSettings().projects[slug] ?? [] };
  });

  // Backend de ejecución de UN agente. Asignar Claude Code es una autorización del propietario (por agente).
  app.put('/api/workspaces/:slug/agents/:id/backend', async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string };
    if (!guard(slug, reply)) return;
    const agents = agentsRepo(slug); const agent = agents.get(id);
    if (!agent) return reply.code(404).send({ error: 'Agente no encontrado' });
    const body = z.object({ backend: z.enum(['api', 'claude-code', 'claude-code-terminal']), authorized: z.literal(true).optional() }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Backend no válido' });
    const backend = body.data.backend;
    if (backend !== 'api') {
      if (body.data.authorized !== true) return reply.code(403).send({ error: 'Asignar Claude Code a un agente requiere tu autorización explícita.' });
      const s = getClaudeCodeSettings();
      if (!s.enabled) return reply.code(409).send({ error: 'Activa primero el conector «Claude Code — Local».' });
      if (agent.config.provider !== 'anthropic') return reply.code(409).send({ error: 'Solo los agentes con modelos de Anthropic pueden ejecutarse con Claude Code.' });
      if (backend === 'claude-code') {
        const d = await verifiedDetection(s);
        if (d.billing !== 'subscription') return reply.code(409).send({ error: `La suscripción no está verificada: ${d.problems[0] ?? 'No verificado'}` });
      }
    }
    const updated = agents.updateConfig(id, { ...agent.config, backend });
    req.log.info({ slug, agent: id, backend }, 'backend de ejecución del agente actualizado');
    return updated;
  });

  // Preparación de los backends del equipo de un proceso (antes de autorizarlo o al retomarlo). Solo lectura.
  app.get('/api/workspaces/:slug/processes/:id/backends', async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string };
    if (!guard(slug, reply)) return;
    const r = teamReadiness(slug, id);
    return r ?? reply.code(404).send({ error: 'Proceso no encontrado' });
  });

  /**
   * Corrige lo que bloquea a Claude Code en un proceso, con autorización explícita: autorizar el proyecto del proceso y/o
   * pasar a «gestionado» agentes de su equipo que usan la consola sin ninguna conectada. No continúa por sí solo: después
   * se usa el «Continuar» de siempre, que retoma la operación pendiente sin repetir lo hecho. Nunca pasa a la API.
   */
  app.post('/api/workspaces/:slug/processes/:id/claude-code/fix', async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string };
    if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), authorizeProject: z.boolean().optional(), switchToManaged: z.array(z.string().min(1).max(80)).max(20).optional() }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Indica qué autorizar y confirma tu autorización.' });
    const proc = processesRepo(slug).get(id);
    if (!proc) return reply.code(404).send({ error: 'Proceso no encontrado' });
    const s = getClaudeCodeSettings();
    if (!s.enabled) return reply.code(409).send({ error: 'Activa primero el conector «Claude Code — Local».' });
    const team = new Set(proc.steps.map(st => st.agentId)); const agents = agentsRepo(slug);
    const switching = body.data.switchToManaged ?? [];
    for (const aid of switching) {
      const a = agents.get(aid);
      if (!a || !team.has(aid)) return reply.code(404).send({ error: 'Ese agente no pertenece al equipo de este proceso.' });
      if (a.config.backend !== 'claude-code-terminal') return reply.code(409).send({ error: `«${a.config.name}» no usa la consola.` });
    }
    if (switching.length) {
      const d = await verifiedDetection(s);
      if (d.billing !== 'subscription') return reply.code(409).send({ error: `La suscripción no está verificada: ${d.problems[0] ?? 'No verificado'}` });
      for (const aid of switching) { const a = agents.get(aid)!; agents.updateConfig(aid, { ...a.config, backend: 'claude-code' }); }
    }
    if (body.data.authorizeProject) saveClaudeCodeSettings({ ...s, projects: { ...s.projects, [slug]: Array.from(new Set([...(s.projects[slug] ?? []), proc.projectId])) } });
    // Se comprueba contra lo GUARDADO (no contra lo que se pidió): nunca se informa de un éxito que la configuración no refleja.
    const after = teamReadiness(slug, id)!;
    if (body.data.authorizeProject && !after.projectAuthorized) return reply.code(500).send({ error: 'La autorización no quedó guardada: la configuración sigue sin incluir el proyecto. No se ha continuado.', code: 'not_persisted', readiness: after });
    req.log.info({ slug, processId: id, authorizeProject: !!body.data.authorizeProject, switched: switching.length, ready: after.ready }, 'Claude Code: autorización corregida para el proceso');
    return { ...after, verified: true };
  });

  // Vista por agente: su backend, si su proyecto está autorizado, los límites del conector, su uso con Claude Code (aparte
  // del gasto en USD de la API) y sus últimas ejecuciones con errores e interrupciones. Solo lectura.
  app.get('/api/workspaces/:slug/agents/:id/claude-code', async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string };
    if (!guard(slug, reply)) return;
    const agent = agentsRepo(slug).get(id);
    if (!agent) return reply.code(404).send({ error: 'Agente no encontrado' });
    const s = getClaudeCodeSettings(); const runs = claudeCodeRunsRepo(slug);
    const authorized = s.projects[slug] ?? [];
    return {
      backend: agentBackend(agent), status: claudeCodeStatus(),
      projects: agent.projectId ? [{ id: agent.projectId, authorized: authorized.includes(agent.projectId) }] : projectsRepo(slug).list().map(p => ({ id: p.id, authorized: authorized.includes(p.id) })),
      limits: { maxConcurrent: s.maxConcurrent, maxDurationSec: s.maxDurationSec, maxTurns: s.maxTurns, repoRead: s.repoRead, fallback: s.fallback },
      usage: runs.usageByAgent(id), runs: runs.byAgent(id, 10),
      consoles: claudeCodeWorkersRepo.list(slug).map(workerView).filter(w => !w.revokedAt && w.agentIds.includes(id)).map(w => ({ id: w.id, name: w.name, connected: w.connected, expired: w.expired }))
    };
  });

  app.post('/api/workspaces/:slug/claude-code/workers', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), name: z.string().trim().min(2).max(80), agentIds: z.array(z.string().min(1).max(80)).min(1).max(50), days: z.number().int().min(1).max(90).optional() }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Indica un nombre, los agentes y confirma tu autorización.' });
    if (!getClaudeCodeSettings().enabled) return reply.code(409).send({ error: 'Activa primero el conector «Claude Code — Local».' });
    const agents = agentsRepo(slug);
    const bad = body.data.agentIds.find(a => !agents.get(a));
    if (bad) return reply.code(404).send({ error: `Agente no encontrado en este espacio: ${bad}` });
    const w = createWorker(slug, body.data.name, [...new Set(body.data.agentIds)], body.data.days ?? 30);
    // Alcance LOCAL en una carpeta dedicada: el puente solo existe cuando abres Claude Code en esa carpeta, no en el
    // resto de tus proyectos (con «user» estaría disponible en todos).
    const cwd = path.join(os.homedir(), 'PortalIA-consola', slug);
    const url = getBridgeUrl();
    // El token se muestra UNA vez (se guarda solo su hash). La orden registra el puente en la consola del propietario.
    return reply.code(201).send({
      worker: workerView(claudeCodeWorkersRepo.get(w.id)!), token: w.token,
      setup: { cwd, command: 'claude', args: ['mcp', 'add', '--scope', 'local', 'portal-ia', '-e', `PORTAL_URL=${url}`, '-e', `PORTAL_BRIDGE_TOKEN=${w.token}`, '--', process.execPath, BRIDGE_SCRIPT] }
    });
  });

  app.delete('/api/workspaces/:slug/claude-code/workers/:id', async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string };
    if (!guard(slug, reply)) return;
    const w = claudeCodeWorkersRepo.get(id);
    if (!w || w.workspace_slug !== slug) return reply.code(404).send({ error: 'Consola no encontrada' });
    claudeCodeWorkersRepo.revoke(id); disconnectWorker(id);
    return workerView(claudeCodeWorkersRepo.get(id)!);
  });

  // ---------------------------------------------------------------- Puente (token obligatorio)

  const scoped = (req: FastifyRequest, reply: FastifyReply): BridgeScope | null => {
    const s = scopeFor(req.headers.authorization);
    if (!s) { reply.code(401).send({ error: 'Token del puente no válido, revocado o caducado.' }); return null; }
    if (s.kind === 'worker') touchWorker(s.workerId);
    return s;
  };
  const send = <T>(reply: FastifyReply, r: T) => isDenied(r) ? reply.code(r.status).send({ error: r.error }) : r;
  const taskId = (req: FastifyRequest) => { const id = (req.params as { id: string }).id; return id === 'current' ? undefined : id; };
  const summary = (t: BridgeTask) => ({ id: t.id, title: t.title, role: t.role, agent: t.agentName, project: projectsRepo(t.slug).get(t.projectId)?.name ?? null, status: t.status, createdAt: t.createdAt });

  app.post('/api/bridge/v1/hello', async (req, reply) => {
    const s = scoped(req, reply); if (!s) return;
    const client = z.object({ version: z.string().max(40).optional(), envCredentials: z.array(z.string().max(60)).max(20).optional() }).partial().safeParse((req.body as any)?.client ?? {});
    if (s.kind === 'worker') touchWorker(s.workerId, client.success ? client.data : {});
    const agents = agentsRepo(s.slug);
    return {
      kind: s.kind, company: workspacesRepo.get(s.slug)?.name ?? s.slug,
      agents: s.kind === 'worker' ? s.agentIds.map(id => agents.get(id)).filter(Boolean).map(a => ({ id: a!.id, name: a!.config.name, role: a!.template.role, backend: agentBackend(a!) })) : [],
      tools: s.kind === 'worker' ? BRIDGE_TOOLS_WORKER : BRIDGE_TOOLS_JOB
    };
  });
  app.post('/api/bridge/v1/heartbeat', async (req, reply) => { const s = scoped(req, reply); if (!s) return; return { ok: true }; });
  app.post('/api/bridge/v1/bye', async (req, reply) => { const s = scoped(req, reply); if (!s) return; if (s.kind === 'worker') disconnectWorker(s.workerId); return { ok: true }; });

  app.get('/api/bridge/v1/tasks', async (req, reply) => { const s = scoped(req, reply); if (!s) return; return { tasks: listTasks(s).map(summary) }; });
  app.post('/api/bridge/v1/tasks/:id/claim', async (req, reply) => {
    const s = scoped(req, reply); if (!s) return;
    const t = claimTask(s, (req.params as { id: string }).id); if (isDenied(t)) return send(reply, t);
    return { ...summary(t), context: taskContext(t), instructions: t.system, prompt: t.prompt, outputSchema: t.schema?.schema ?? null };
  });
  app.get('/api/bridge/v1/tasks/:id', async (req, reply) => {
    const s = scoped(req, reply); if (!s) return;
    const t = taskFor(s, taskId(req)); if (isDenied(t)) return send(reply, t);
    return { ...summary(t), context: taskContext(t), progress: t.progress };
  });
  app.post('/api/bridge/v1/tasks/:id/progress', async (req, reply) => {
    const s = scoped(req, reply); if (!s) return;
    const b = z.object({ message: z.string().trim().min(1).max(500) }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Mensaje de progreso no válido (1–500 caracteres).' });
    const t = reportProgress(s, taskId(req), b.data.message); if (isDenied(t)) return send(reply, t);
    return { ok: true };
  });
  app.post('/api/bridge/v1/tasks/:id/result', async (req, reply) => {
    const s = scoped(req, reply); if (!s) return;
    const b = z.object({ text: z.string().min(1).max(2_000_000) }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Resultado no válido.' });
    return send(reply, submitResult(s, (req.params as { id: string }).id, b.data.text));
  });
  app.post('/api/bridge/v1/tasks/:id/blocker', async (req, reply) => {
    const s = scoped(req, reply); if (!s) return;
    const b = z.object({ reason: z.string().trim().min(3).max(2000) }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Explica el bloqueo (3–2000 caracteres).' });
    return send(reply, reportBlocker(s, (req.params as { id: string }).id, b.data.reason));
  });
  app.get('/api/bridge/v1/tasks/:id/files', async (req, reply) => {
    const s = scoped(req, reply); if (!s) return;
    const t = taskFor(s, taskId(req)); if (isDenied(t)) return send(reply, t);
    if (s.kind === 'worker' && t.claimedBy !== s.workerId) return reply.code(409).send({ error: 'Toma la tarea antes de leer su carpeta de trabajo.' });
    return send(reply, listTaskFiles(t, String((req.query as any)?.dir ?? '')));
  });
  app.get('/api/bridge/v1/tasks/:id/file', async (req, reply) => {
    const s = scoped(req, reply); if (!s) return;
    const t = taskFor(s, taskId(req)); if (isDenied(t)) return send(reply, t);
    if (s.kind === 'worker' && t.claimedBy !== s.workerId) return reply.code(409).send({ error: 'Toma la tarea antes de leer su carpeta de trabajo.' });
    const p = String((req.query as any)?.path ?? '');
    if (!p) return reply.code(400).send({ error: 'Falta la ruta.' });
    return send(reply, readTaskFile(t, p));
  });
  app.get('/api/bridge/v1/tasks/:id/knowledge', async (req, reply) => {
    const s = scoped(req, reply); if (!s) return;
    const t = taskFor(s, taskId(req)); if (isDenied(t)) return send(reply, t);
    return { documents: taskKnowledge(t) };
  });
}

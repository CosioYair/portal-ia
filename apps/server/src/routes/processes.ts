import type { FastifyInstance } from 'fastify';
import type { Process, VerificationRun } from '@portal-ia/domain';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { agentsRepo, knowledgeRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { cancelProcess, clearCancel, createAssessment, estimateAssessment, isCancelled, runAssessment } from '../services/assessment.ts';
import { isActiveJob, trackJob } from '../services/activeJobs.ts';
import { abortProcessCalls } from '../services/providerCalls.ts';
import { createStoryProcess, estimateManualTest, estimateStory, generateManualTest, recoverStory, retryStory, runStory, stepByRole } from '../services/storyExecution.ts';
import { applyBacklogOps, createDelegation, ensureOpsParsed, estimateDelegation, runDelegation } from '../services/delegation.ts';
import { describeProcess } from '../services/guidance.ts';
import { flowOptions } from '../services/processView.ts';
import { DEPS_MISSING_EXIT } from '../services/sandbox.ts';
import { recordContextEdit } from '../services/storyThread.ts';
import { teamReadiness } from '../services/claudeCode/backend.ts';
import { INTERNAL_WORKSPACE } from '@portal-ia/domain';
import { applyChanges, checkStaleChanges, discardBranch, mergeBranch, pushBranches, removeWorktree, worktreePathFor } from '../services/repoWrite.ts';
import { requirePolicy, PolicyError } from '../services/executionPolicy.ts';
import { detectSandbox } from '../services/sandbox.ts';
import { runVerification } from '../services/verification.ts';
import { newPipeline, resumeStory } from '../services/storyPipeline.ts';
import { normalizePipeline } from '@portal-ia/domain';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config.ts';
import { activationOf } from '../services/system.ts';
import { defaultChecks, runRuntimeChecks, runtimeVerified } from '../services/runtimeChecks.ts';
import { recordDetections } from '../services/lessons.ts';
import { addManualItem, estimateExtraction, extractBacklogWithAI, importBacklogFromKnowledge, resetStory } from '../services/backlog.ts';
import { backlogRepo } from '../db/workspace.ts';

/**
 * Procesos autorizados (HU-004). Un proceso nace 'pending_authorization' con una estimación; solo empieza a consumir
 * IA cuando el usuario lo autoriza con un presupuesto (POST /authorize). Puede cancelarse; se detiene entre pasos.
 */
/** Configuración del pipeline autorizado (se normaliza y acota en el servidor). */
const PIPELINE_INPUT = z.object({ autoApply: z.boolean().optional(), autoVerify: z.boolean().optional(), commands: z.array(z.enum(['typecheck', 'test', 'build'])).max(3).optional(), allowInstall: z.boolean().optional(), maxOutputRepairs: z.number().int().min(0).max(10).optional(), maxCorrections: z.number().int().min(0).max(10).optional(), maxIdenticalFailures: z.number().int().min(1).max(10).optional(), maxDurationMin: z.number().int().min(1).max(600).optional(), maxConsultations: z.number().int().min(0).max(3).optional(), maxProviderRetries: z.number().int().min(0).max(3).optional(), providerTimeoutSec: z.number().int().min(5).max(900).nullable().optional(), maxContinuations: z.number().int().min(0).max(12).optional() });

export async function processRoutes(app: FastifyInstance) {
  // Al servir un proceso se calcula (no se persiste) su estado de activación en el Portal en marcha y la orientación.
  const withGuidance = async (slug: string, p: Process): Promise<Process> => {
    const isPortalRepo = slug === INTERNAL_WORKSPACE.slug;
    let q = p;
    if (isPortalRepo && p.kind === 'story_execution' && p.result?.merged) {
      const repo = projectsRepo(slug).repository(p.projectId);
      const runtime = !!repo && path.resolve(repo.path) === path.resolve(REPO_ROOT);
      const activation = runtime ? await activationOf(p.result.merged.commit, p.result.merged.mergedAt).catch(() => null) : null;
      q = { ...p, result: { ...p.result, activation } };
    }
    const item = q.kind === 'story_execution' && q.backlogItemId ? backlogRepo(slug).get(q.backlogItemId) : undefined;
    const fo = await flowOptions(slug, q, item);
    return { ...q, guidance: describeProcess(q, { isPortalRepo, storyStatus: item && (item.lastProcessId === q.id || !item.lastProcessId) ? item.status : null, ...fo, backends: q.kind === 'story_execution' ? teamReadiness(slug, q.id) : null }) };
  };
  const guard = (slug: string, reply: any) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };

  app.get('/api/workspaces/:slug/projects/:projectId/assessment/estimate', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    try { return estimateAssessment(slug, projectId); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  app.post('/api/workspaces/:slug/projects/:projectId/assessment', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    if (!projectsRepo(slug).get(projectId)) return reply.code(404).send({ error: 'Proyecto no encontrado' });
    try { return createAssessment(slug, projectId); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  app.get('/api/workspaces/:slug/projects/:projectId/processes', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    return Promise.all(processesRepo(slug).list(projectId).map(p => withGuidance(slug, p.kind === 'delegated_task' && p.status === 'done' ? ensureOpsParsed(slug, p) : p)));
  });

  app.get('/api/workspaces/:slug/processes/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const p = processesRepo(slug).get(id); if (!p) return reply.code(404).send({ error: 'Proceso no encontrado' });
    return await withGuidance(slug, p.kind === 'delegated_task' && p.status === 'done' ? ensureOpsParsed(slug, p) : p);
  });

  // Autorización explícita: aquí y solo aquí empieza el consumo de IA.
  app.post('/api/workspaces/:slug/processes/:id/authorize', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ budgetUsd: z.number().min(0.1).max(500), authorized: z.literal(true), pipeline: PIPELINE_INPUT.optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere presupuesto (USD) y autorización explícita.' });
    const procs = processesRepo(slug);
    const proc = procs.get(id);
    if (!proc) return reply.code(404).send({ error: 'Proceso no encontrado' });
    if (proc.status !== 'pending_authorization') return reply.code(409).send({ error: 'El proceso ya fue autorizado o finalizado.' });
    if (procs.running().length) return reply.code(409).send({ error: 'Ya hay un proceso en ejecución. Espera a que termine.' });
    // Claude Code: un equipo que no puede ejecutar (proyecto sin autorizar, consola sin conectar…) no empieza: el
    // proceso seguiría «autorizado» y fallaría en el primer paso. Se rechaza sin cambiar nada y se dice qué falta.
    const readiness = proc.kind === 'story_execution' ? teamReadiness(slug, id) : null;
    if (readiness && !readiness.ready && readiness.fallback !== 'api') return reply.code(409).send({ error: `No se inicia: ${readiness.team.find(t => !t.ready)!.reason}`, code: 'backend_not_ready', readiness });
    // El pipeline (aplicar, verificar, QA con evidencia, correcciones acotadas) forma parte de ESTA autorización; sin él, cada paso se autoriza a mano como antes.
    if (proc.kind === 'story_execution' && body.data.pipeline && proc.result) procs.setResult(id, { ...proc.result, pipeline: newPipeline(normalizePipeline(body.data.pipeline)) });
    procs.authorize(id, body.data.budgetUsd);
    app.log.info({ processId: id, kind: proc.kind, budget: body.data.budgetUsd }, 'proceso autorizado · inicia ejecución');
    const logger = (o: any, m: string) => app.log.info(o, m);
    const run = proc.kind === 'story_execution' ? runStory(slug, id, logger, () => isCancelled(id)).finally(() => clearCancel(id)) : proc.kind === 'delegated_task' ? runDelegation(slug, id, logger, () => isCancelled(id)).finally(() => clearCancel(id)) : runAssessment(slug, id, logger);
    // Se registra ya (no en el siguiente tick): un proceso en marcha nunca debe parecer huérfano.
    trackJob(id, run).catch(e => app.log.error(e, 'fallo inesperado en el proceso'));
    return procs.get(id);
  });

  // Continuar de forma autónoma (autorizado por el propietario): reanuda un pipeline pausado o detenido, lo inicia sobre un
  // proceso terminado con cambios sin aplicar, o repara la entrega de un proceso que falló por el formato del Desarrollador.
  // Lo ya hecho no se repite; el presupuesto adicional es un máximo, no un objetivo.
  app.post('/api/workspaces/:slug/processes/:id/continue', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), addBudgetUsd: z.number().min(0).max(100).optional(), pipeline: PIPELINE_INPUT.optional(), answer: z.string().trim().min(2).max(8000).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Continuar exige tu autorización explícita.', code: 'authorization_required' });
    const procs = processesRepo(slug); const proc = procs.get(id);
    if (!proc || proc.kind !== 'story_execution' || !proc.result) return reply.code(404).send({ error: 'Proceso de historia no encontrado' });
    if (proc.status === 'running' || proc.status === 'pending_authorization') return reply.code(409).send({ error: 'El proceso sigue activo o pendiente de autorizar.' });
    if (proc.result.merged || proc.result.rejected) return reply.code(409).send({ error: proc.result.merged ? 'Ya está integrado en la rama principal.' : 'Este diff se rechazó; crea una nueva iteración.' });
    const hasOutput = proc.steps.some(s => s.role === 'implementer' && s.outputMd?.trim());
    if (!proc.result.applied && !proc.result.changes.some(c => !c.error) && !hasOutput && !proc.result.manifest) return reply.code(409).send({ error: 'El Desarrollador no entregó nada que continuar: vuelve a ejecutar la historia.', code: 'nothing_to_continue' });
    if (procs.running().length) return reply.code(409).send({ error: 'Ya hay un proceso en ejecución. Espera a que termine.' });
    // Claude Code: si la configuración GUARDADA no deja ejecutar al equipo (proyecto sin autorizar, conector desactivado,
    // consola sin conectar) y no autorizaste la API como alternativa, continuar solo volvería a detenerse. Se rechaza
    // aquí, sin eventos, pasos ni cambios en el proceso (HU-159 acumuló pausas idénticas por cada «Continuar»).
    const readiness = teamReadiness(slug, id);
    if (readiness && !readiness.ready && readiness.fallback !== 'api') {
      const first = readiness.team.find(t => !t.ready)!;
      return reply.code(409).send({ error: `No se continúa: ${first.reason}`, code: 'backend_not_ready', readiness });
    }
    const prev = proc.result.pipeline;
    // Si el equipo preguntó algo (información, permiso o decisión), continuar sin respuesta solo repetiría la pregunta y gastaría créditos.
    const request = prev?.ownerRequest ?? proc.result.failure?.request ?? null;
    if (request && !body.data.answer) return reply.code(400).send({ error: `El equipo necesita tu respuesta para seguir: «${request.question}»`, code: 'answer_required', request });
    const cfg = normalizePipeline({ ...(prev?.config ?? {}), ...(body.data.pipeline ?? {}) });
    // Los límites nuevos se suman a lo ya consumido: continuar tras un tope concede ese margen otra vez, no más.
    // Una pausa de Claude Code (proyecto sin autorizar, consola, límite de la suscripción) no consumió ningún margen:
    // continuar tras ella conserva los límites que había, sin conceder correcciones nuevas.
    const backendPause = !!prev && (prev.pauseKind === 'subscription_limit' || (prev.pauseKind === 'permission' && !request && /Claude Code/.test(prev.reason ?? '')));
    const pipeline = prev && backendPause
      ? { ...prev, config: { ...prev.config, ...(body.data.pipeline ? { allowInstall: cfg.allowInstall } : {}) }, failures: [], ineffectiveRounds: 0, startedAt: new Date().toISOString() }
      : prev
      ? { ...prev, config: { ...cfg, maxCorrections: prev.corrections + cfg.maxCorrections, maxOutputRepairs: prev.outputRepairs + cfg.maxOutputRepairs, maxConsultations: (prev.consultations?.length ?? 0) + cfg.maxConsultations, maxContinuations: (prev.continuations ?? 0) + (cfg.maxContinuations ?? 6) }, failures: [], ineffectiveRounds: 0, startedAt: new Date().toISOString() }
      : newPipeline(cfg);
    // La respuesta del propietario se entrega al agente que la pidió (una vez) al reanudar.
    if (request && body.data.answer) { pipeline.ownerAnswers = [...(pipeline.ownerAnswers ?? []), { at: new Date().toISOString(), question: request.question, answer: body.data.answer, delivered: false }]; pipeline.ownerRequest = null; }
    procs.setResult(id, { ...proc.result, pipeline });
    procs.resume(id, Math.max(proc.budgetUsd, proc.spentUsd) + (body.data.addBudgetUsd ?? 0));
    app.log.info({ processId: id, addBudget: body.data.addBudgetUsd ?? 0, allowInstall: cfg.allowInstall }, 'pipeline de la historia: continuar (autorizado)');
    const logger = (o: any, m: string) => app.log.info(o, m);
    const run = resumeStory(slug, id, logger, () => isCancelled(id)).finally(() => clearCancel(id));
    trackJob(id, run).catch(e => app.log.error(e, 'fallo inesperado al continuar el proceso'));
    return await withGuidance(slug, procs.get(id)!);
  });

  app.post('/api/workspaces/:slug/processes/:id/cancel', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const proc = processesRepo(slug).get(id);
    if (!proc) return reply.code(404).send({ error: 'Proceso no encontrado' });
    if (proc.status === 'pending_authorization') { processesRepo(slug).finish(id, 'cancelled'); return processesRepo(slug).get(id); }
    if (proc.status === 'running' && !isActiveJob(id)) {
      // Huérfano: su ejecución murió con un servidor anterior. Se cierra como cancelado, igual que al cancelar en marcha.
      const procs = processesRepo(slug);
      for (const s of proc.steps) {
        if (s.status === 'pending') procs.stepFinish(s.id, 'skipped', { error: 'interrumpido: el servidor se reinició durante la ejecución' });
        else if (s.status === 'running') {
          // La llamada interrumpida pudo facturarse: su entrada estimada queda como costo NO confirmado (nunca como gasto real).
          const est = s.live?.inputUsd ? Number(s.live.inputUsd.toFixed(6)) : 0;
          procs.stepFinish(s.id, 'failed', { tokensIn: s.inputTokens, tokensOut: s.outputTokens, cost: s.costUsd, outputMd: s.outputMd, error: `Interrumpido: el servidor se reinició durante esta llamada; no se sabe si el proveedor la completó${est ? `; posible costo NO confirmado ≈ ${est.toFixed(4)} USD` : ''}.` });
          if (est) procs.addUnconfirmed(id, s.id, est);
        }
      }
      new Set(proc.steps.map(s => s.agentId)).forEach(aid => agentsRepo(slug).setStatus(aid, 'inactive'));
      const item = proc.backlogItemId ? backlogRepo(slug).get(proc.backlogItemId) : undefined;
      if (item?.status === 'in_progress') backlogRepo(slug).setStatus(item.id, 'pending', proc.id);
      procs.finish(id, 'cancelled', 'Interrumpido: el servidor se reinició mientras se ejecutaba; cancelado por el propietario.');
      app.log.info({ processId: id }, 'proceso huérfano cancelado');
      return processesRepo(slug).get(id);
    }
    if (proc.status === 'running') {
      // Cancelar de verdad: además de la marca entre pasos, se abortan las llamadas al proveedor en curso.
      cancelProcess(id); const aborted = abortProcessCalls(id);
      app.log.info({ processId: id, abortedCalls: aborted }, 'cancelación solicitada');
      return { ...proc, cancelling: true, abortedCalls: aborted };
    }
    return proc;
  });

  // ---- Backlog ----
  app.get('/api/workspaces/:slug/projects/:projectId/backlog', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    return backlogRepo(slug).list(projectId);
  });
  app.get('/api/workspaces/:slug/projects/:projectId/backlog/import/estimate', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    return estimateExtraction(slug, projectId) ?? { model: null, byAgent: null, estimatedUsd: 0 };
  });
  // Importa sin IA; si no encuentra historias y el usuario autorizó (authorized + maxUsd), el Coordinador las extrae con una llamada.
  app.post('/api/workspaces/:slug/projects/:projectId/backlog/import', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.boolean().optional(), maxUsd: z.number().min(0).max(5).optional() }).safeParse(req.body ?? {});
    const r = importBacklogFromKnowledge(slug, projectId);
    if (r.imported > 0 || r.total > 0 || !r.source || !body.success || !body.data.authorized) return { ...r, usedAI: false, costUsd: 0 };
    try { const ai = await extractBacklogWithAI(slug, projectId, body.data.maxUsd ?? 0.5); app.log.info({ imported: ai.imported, cost: ai.costUsd.toFixed(4) }, 'backlog extraído con IA'); return { ...ai, parsed: ai.imported, usedAI: true }; }
    catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/projects/:projectId/backlog', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ title: z.string().trim().min(3).max(200), description: z.string().trim().max(4000).optional(), criterion: z.string().trim().max(600).optional(), ownerKey: z.string().nullable().optional(), estimate: z.enum(['S', 'M', 'L']).nullable().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Solicitud no válida (título de al menos 3 caracteres).' });
    return reply.code(201).send(addManualItem(slug, projectId, body.data));
  });
  app.patch('/api/workspaces/:slug/backlog/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const repo = backlogRepo(slug); if (!repo.get(id)) return reply.code(404).send({ error: 'Historia no encontrada' });
    const body = z.object({ status: z.enum(['pending', 'in_progress', 'review', 'done', 'blocked']).optional(), title: z.string().trim().min(3).max(200).optional(), criterion: z.string().max(600).optional(), description: z.string().max(4000).optional(), ownerKey: z.string().nullable().optional(), estimate: z.enum(['S', 'M', 'L']).nullable().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos' });
    const { status, ...rest } = body.data;
    const before = repo.get(id)!;
    if (Object.keys(rest).length) repo.update(id, rest);
    if (status) repo.setStatus(id, status);
    // Una historia ya ejecutada (en revisión, integrada, cerrada…) guarda en su historial qué cambió del contexto.
    if (before.lastProcessId || before.status !== 'pending') recordContextEdit(slug, before, repo.get(id)!);
    return repo.get(id);
  });
  app.delete('/api/workspaces/:slug/backlog/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    backlogRepo(slug).delete(id); return { ok: true };
  });
  app.get('/api/workspaces/:slug/projects/:projectId/backlog/:id/estimate', async (req, reply) => {
    const { slug, projectId, id } = req.params as any; if (!guard(slug, reply)) return;
    const q = (req.query as any) ?? {}; const skipQa = String(q.skipQa ?? '') === '1';
    // Anulación manual del equipo (M3): ?add=id1,id2&remove=id3
    const override = q.add || q.remove ? { add: String(q.add ?? '').split(',').filter(Boolean), remove: String(q.remove ?? '').split(',').filter(Boolean), by: 'owner' as const, at: new Date().toISOString() } : null;
    try { return estimateStory(slug, projectId, id, { skipQa, override }); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  // Crea el proceso de ejecución (pendiente de autorización). El consumo empieza en /authorize.
  app.post('/api/workspaces/:slug/projects/:projectId/backlog/:id/execute', async (req, reply) => {
    const { slug, projectId, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ skipQa: z.boolean().optional(), team: z.object({ add: z.array(z.string()).max(10).optional(), remove: z.array(z.string()).max(10).optional() }).optional() }).safeParse(req.body ?? {});
    const override = body.success && body.data.team && ((body.data.team.add?.length ?? 0) + (body.data.team.remove?.length ?? 0) > 0) ? { ...body.data.team, by: 'owner' as const, at: new Date().toISOString() } : null;
    try { return createStoryProcess(slug, projectId, id, { skipQa: body.success ? !!body.data.skipQa : false, override }); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  // M3 · Métricas de participación de un agente (derivadas de process_steps, sin IA).
  app.get('/api/workspaces/:slug/agents/:id/stats', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    return processesRepo(slug).agentStats(id);
  });

  // ---- Prueba manual: el propietario marca cada paso probado ----
  app.post('/api/workspaces/:slug/processes/:id/manual-test', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ checks: z.array(z.boolean()).max(20).optional(), steps: z.array(z.string().trim().min(4).max(400)).min(1).max(20).optional(), note: z.string().max(500).nullable().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos' });
    const procs = processesRepo(slug); const proc = procs.get(id);
    if (!proc?.result) return reply.code(404).send({ error: 'Proceso de historia no encontrado.' });
    const cur = proc.result.manualTest;
    // Pasos escritos a mano por el propietario (o editados): reemplazan la lista y reinician las marcas.
    const steps = body.data.steps ?? cur?.steps; if (!steps) return reply.code(404).send({ error: 'Este proceso no tiene prueba manual; genera una o añade los pasos.' });
    const checks = steps.map((_, i) => body.data.steps ? false : !!(body.data.checks ?? cur?.checks ?? [])[i]);
    procs.setResult(id, { ...proc.result, manualTest: { steps, checks, note: body.data.note === undefined ? (cur?.note ?? null) : body.data.note } });
    return await withGuidance(slug, procs.get(id)!);
  });
  app.get('/api/workspaces/:slug/processes/:id/manual-test/estimate', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { return estimateManualTest(slug, id); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/processes/:id/manual-test/generate', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita (consume una llamada).' });
    try { const p = await generateManualTest(slug, id, (o, m) => app.log.info(o, m)); return await withGuidance(slug, p); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  // ---- Rechazar el diff de un proceso (la historia vuelve a pendiente) / devolver una historia a pendiente ----
  app.post('/api/workspaces/:slug/processes/:id/reject', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ reason: z.string().trim().max(300).optional() }).safeParse(req.body ?? {});
    const proc = processesRepo(slug).get(id);
    if (!proc || proc.kind !== 'story_execution') return reply.code(404).send({ error: 'Proceso de historia no encontrado' });
    if (proc.result?.merged) return reply.code(409).send({ error: 'Los cambios ya están integrados en la rama principal; no se pueden rechazar. Crea una nueva iteración o devuelve la historia a pendiente.' });
    if (proc.result?.applied && !proc.result.applied.worktree) {
      // Iteración anterior a v0.12 (aplicada en la carpeta, sin worktree): solo se marca descartada; la rama se conserva para que decidas tú.
      app.log.info({ processId: id, branch: proc.result.applied.branch }, 'iteración anterior a v0.12 descartada; rama conservada');
    } else if (proc.result?.applied) {
      // M1: aplicado en worktree pero no integrado → se retira el worktree y se borra la rama (nunca el checkout principal).
      const repo = projectsRepo(slug).repository(proc.projectId);
      if (repo) { try { requirePolicy('delete_worktree', { slug, processId: id, projectId: proc.projectId, authorized: true }); const d = await discardBranch(repo.path, id, proc.result.applied.branch); app.log.info({ processId: id, ...d }, 'rama de historia descartada'); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); } }
    }
    try { if (proc.backlogItemId) resetStory(slug, proc.backlogItemId, body.success && body.data.reason ? body.data.reason : 'diff rechazado por el propietario'); else processesRepo(slug).setResult(id, { ...(proc.result ?? { plan: null, implementationSummary: null, changes: [], verifyCommands: [], review: null, applied: null, verifications: [] }), rejected: { at: new Date().toISOString(), reason: 'rechazado' } }); app.log.info({ processId: id }, 'diff rechazado'); return await withGuidance(slug, processesRepo(slug).get(id)!); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/backlog/:id/reset', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ reason: z.string().trim().max(300).optional() }).safeParse(req.body ?? {});
    try {
      const reason = body.success && body.data.reason ? body.data.reason : 'devuelta a pendiente por el propietario';
      const item = backlogRepo(slug).get(id); const lastId = item?.lastProcessId ?? null;
      const r = resetStory(slug, id, reason);
      if (lastId) { try { recordDetections(slug, lastId, projectsRepo(slug).repository(item!.projectId)?.path ?? null, { resetReason: reason }); } catch { /* sin lección */ } }
      return r;
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  // ---- Recuperar (sin IA) o reintentar un proceso de historia ----
  app.post('/api/workspaces/:slug/processes/:id/recover', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { const p = await recoverStory(slug, id); app.log.info({ processId: id, changes: p.result?.changes.length }, 'proceso recuperado sin IA'); return await withGuidance(slug, p); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/processes/:id/retry', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ skipQa: z.boolean().optional() }).safeParse(req.body ?? {});
    try { const p = retryStory(slug, id, { skipQa: body.success ? !!body.data.skipQa : false }); app.log.info({ from: id, processId: p.id }, 'historia relanzada (pendiente de autorización)'); return reply.code(201).send(await withGuidance(slug, p)); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  // ---- Encargos delegados a un agente responsable (sin IA hasta autorizar) ----
  app.post('/api/workspaces/:slug/delegations/estimate', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ projectId: z.string().nullable().optional(), agent: z.string().optional(), request: z.string().trim().min(8).max(4000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Describe el encargo (mínimo 8 caracteres).' });
    try { return estimateDelegation(slug, body.data.projectId ?? null, body.data.agent, body.data.request); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/delegations', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ projectId: z.string().nullable().optional(), agent: z.string().optional(), request: z.string().trim().min(8).max(4000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Describe el encargo (mínimo 8 caracteres).' });
    try { const p = createDelegation(slug, body.data.projectId ?? null, body.data.agent, body.data.request); app.log.info({ processId: p.id, title: p.title }, 'encargo creado (pendiente de autorización)'); return reply.code(201).send(p); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/processes/:id/backlog-ops/apply', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita.' });
    try { applyBacklogOps(slug, id); app.log.info({ processId: id }, 'propuestas al backlog aplicadas'); return processesRepo(slug).get(id); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  // ---- Aplicar cambios (write_repo · requiere autorización por uso) ----
  app.post('/api/workspaces/:slug/processes/:id/apply', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), branch: z.string().trim().min(1).max(80).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita.' });
    const procs = processesRepo(slug); const proc = procs.get(id);
    if (!proc || proc.kind !== 'story_execution' || !proc.result) return reply.code(404).send({ error: 'Proceso de historia no encontrado' });
    if (proc.status !== 'done') return reply.code(409).send({ error: 'El proceso no terminó correctamente.' });
    if (proc.result.applied) return reply.code(409).send({ error: 'Los cambios ya fueron aplicados.' });
    if (!proc.result.changes.length) return reply.code(409).send({ error: 'No hay cambios que aplicar.' });
    const repo = projectsRepo(slug).repository(proc.projectId);
    if (!repo) return reply.code(409).send({ error: 'No hay repositorio registrado.' });
    const item = proc.backlogItemId ? backlogRepo(slug).get(proc.backlogItemId) : undefined;
    const branch = body.data.branch ?? `portal-ia/${(item?.storyId ?? 'cambio').toLowerCase()}`;
    try {
      requirePolicy('write_worktree', { slug, processId: id, agentId: stepByRole(proc, 'implementer')?.agentId ?? null, projectId: proc.projectId, authorized: true });
      // Última comprobación: ningún «modify» completo sobre un archivo que cambió después de leerse.
      const checked = checkStaleChanges(repo.path, proc.result.changes);
      if (checked.some((c, i) => c.error && !proc.result!.changes[i].error)) { procs.setResult(id, { ...proc.result, changes: checked }); recordDetections(slug, id, repo.path); }
      if (!checked.some(c => !c.error)) return reply.code(409).send({ error: `Ningún cambio es aplicable ya: ${checked.filter(c => c.error).map(c => `${c.path}: ${c.error}`).join(' · ')}` });
      proc.result.changes = checked;
      const applied = await applyChanges(repo.path, branch, proc.result.changes, `${item?.storyId ?? 'Portal IA'}: ${item?.title ?? proc.title}

Cambios propuestos por el equipo de agentes de Portal IA y aprobados por el propietario.
Proceso: ${proc.id}`, { processId: proc.id });
      const result = { ...proc.result, applied: { ...applied, appliedAt: new Date().toISOString() } };
      procs.setResult(id, result);
      procs.logExecution({ projectId: proc.projectId, agentId: stepByRole(proc, 'implementer')?.agentId ?? '', kind: 'repo_write', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: new Date().toISOString() });
      app.log.info({ processId: id, branch: applied.branch, commit: applied.commit, files: applied.files.length, worktree: applied.worktree }, 'cambios aplicados en worktree aislado');
      return await withGuidance(slug, procs.get(id)!);
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e instanceof PolicyError ? e.code : undefined }); }
  });

  // ---- Integrar en la rama principal (merge --no-ff · requiere autorización por uso) ----
  app.post('/api/workspaces/:slug/processes/:id/merge', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), into: z.string().trim().min(1).max(80).optional(), skipVerification: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita.' });
    const procs = processesRepo(slug); const proc = procs.get(id);
    if (!proc?.result?.applied) return reply.code(409).send({ error: 'Primero aplica los cambios en la rama.' });
    if (proc.result.merged) return reply.code(409).send({ error: `Ya integrada en ${proc.result.merged.into}.` });
    if (!proc.result.applied.worktree) return reply.code(409).send({ error: 'Esta iteración se aplicó antes de v0.12 (sin worktree aislado) y no se integra con el flujo actual. Ciérrala como resuelta o descártala y prepara una nueva iteración.', code: 'legacy_applied' });
    // Orden de cierre: no se integra sin que typecheck haya pasado en esta rama (salvo que el propietario lo fuerce a sabiendas).
    const after = new Date(proc.result.applied.appliedAt).getTime();
    const okTypecheck = proc.result.verifications.some(v => v.command === 'typecheck' && v.exitCode === 0 && new Date(v.startedAt).getTime() >= after - 1000);
    const failedLast = ['typecheck', 'build', 'test'].map(c => proc.result!.verifications.filter(v => v.command === c).at(-1)).filter(v => v && v.exitCode !== 0);
    // Proyecto interno (el propio Portal): además de typecheck, test y build en sandbox real; en otros proyectos basta typecheck.
    const internal = slug === INTERNAL_WORKSPACE.slug;
    const okAfter = (cmd: string, sandboxOnly = false) => proc.result!.verifications.some(v => v.command === cmd && v.exitCode === 0 && new Date(v.startedAt).getTime() >= after - 1000 && (!sandboxOnly || v.isolation === 'docker' || v.isolation === 'wsl' || v.isolation === 'linux-ns'));
    const missing = internal ? [!okTypecheck ? 'typecheck' : '', !okAfter('test', true) ? 'test (sandbox)' : '', !okAfter('build', true) ? 'build (sandbox)' : ''].filter(Boolean) : [!okTypecheck ? 'typecheck' : ''].filter(Boolean);
    if (!body.data.skipVerification || internal) {
      // El proyecto interno (el propio Portal) nunca se integra saltándose la verificación: es un control de seguridad.
      if (failedLast.length) return reply.code(409).send({ error: `La última verificación falló (${failedLast.map(v => v!.command).join(', ')}). Corrige en la rama o rechaza el diff; integrar código roto dejaría el Portal sin compilar.`, code: 'verification_failed' });
      if (missing.length) return reply.code(409).send({ error: `Antes de integrar faltan verificaciones en verde tras aplicar: ${missing.join(', ')}. ${internal && missing.some(m => m.includes('sandbox')) ? 'El proyecto interno exige test y build en un sandbox real (Docker/WSL2); sin sandbox no se integra.' : ''}`, code: 'verification_required', missing });
    }
    const repo = projectsRepo(slug).repository(proc.projectId); if (!repo) return reply.code(409).send({ error: 'No hay repositorio registrado.' });
    try {
      requirePolicy('git_merge', { slug, processId: id, projectId: proc.projectId, authorized: true });
      const m = await mergeBranch(repo.path, proc.result.applied.branch, body.data.into, { affectedFiles: proc.result.changes.filter(c => !c.error).map(c => c.path), processId: id });
      procs.setResult(id, { ...proc.result, merged: { into: m.into, commit: m.commit, mergedAt: new Date().toISOString() }, mergeError: null });
      await removeWorktree(repo.path, id).catch(() => false);
      procs.logExecution({ projectId: proc.projectId, agentId: proc.steps[0]?.agentId ?? '', kind: 'repo_merge', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: new Date().toISOString() });
      app.log.info({ processId: id, into: m.into, commit: m.commit, viaWorktree: m.viaWorktree }, 'rama integrada');
      return await withGuidance(slug, procs.get(id)!);
    } catch (e: any) {
      // Conflicto: se guarda para que el recorrido lo explique y ofrezca la corrección (el merge ya se deshizo).
      if (e.statusCode === 409 && /conflict/i.test(e.message)) {
        const files = Array.from(new Set(Array.from(String(e.message).matchAll(/Merge conflict in (\S+)/g)).map(x => x[1])));
        procs.setResult(id, { ...proc.result, mergeError: { at: new Date().toISOString(), message: String(e.message).slice(0, 2000), files: files.length ? files : proc.result.changes.filter(c => !c.error).map(c => c.path) } });
        return reply.code(409).send({ error: e.message, code: 'merge_conflict', process: await withGuidance(slug, procs.get(id)!) });
      }
      return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e instanceof PolicyError ? e.code : undefined });
    }
  });

  // ---- Publicar en el remoto (git push · requiere autorización por uso) ----
  app.post('/api/workspaces/:slug/processes/:id/publish', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita.' });
    const procs = processesRepo(slug); const proc = procs.get(id);
    if (!proc?.result?.applied) return reply.code(409).send({ error: 'Primero aplica los cambios en la rama.' });
    const repo = projectsRepo(slug).repository(proc.projectId); if (!repo) return reply.code(409).send({ error: 'No hay repositorio registrado.' });
    const branches = [proc.result.applied.branch, ...(proc.result.merged ? [proc.result.merged.into] : [])];
    try {
      requirePolicy('git_push', { slug, processId: id, projectId: proc.projectId, authorized: true });
      const p = await pushBranches(repo.path, branches);
      procs.setResult(id, { ...proc.result, published: { ...p, pushedAt: new Date().toISOString() } });
      procs.logExecution({ projectId: proc.projectId, agentId: proc.steps[0]?.agentId ?? '', kind: 'repo_push', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: new Date().toISOString() });
      app.log.info({ processId: id, remote: p.remote, branches }, 'ramas publicadas');
      return procs.get(id);
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  // ---- Verificación local (sandbox_exec · requiere autorización por uso; ejecución local sin sandbox) ----
  // Misma verificación para la ruta (autorización por uso) y para el pipeline autorizado: services/verification.ts.
  const runVerify = (slug: string, id: string, command: 'install' | 'typecheck' | 'test' | 'build', allowNetwork: boolean): Promise<VerificationRun> => runVerification(slug, id, command, allowNetwork);
  const sendError = (reply: any, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, code: e instanceof PolicyError || typeof e.code === 'string' ? e.code : undefined });
  app.post('/api/workspaces/:slug/processes/:id/verify', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), command: z.enum(['install', 'typecheck', 'test', 'build']), allowNetwork: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita y un comando permitido.' });
    try { await runVerify(slug, id, body.data.command, !!body.data.allowNetwork); return await withGuidance(slug, processesRepo(slug).get(id)!); } catch (e: any) { return sendError(reply, e); }
  });
  // Recuperación de «faltan las dependencias Linux» (Docker, código 86): install con red temporal y, si termina bien, se
  // repiten sin red los comandos pendientes. Exige autorizar la ejecución y la red explícitamente; conserva el historial.
  app.post('/api/workspaces/:slug/processes/:id/verify/install-and-retry', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), allowNetwork: z.literal(true), commands: z.array(z.enum(['typecheck', 'test', 'build'])).min(1).max(3) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Instalar dependencias necesita tu autorización explícita y permitir la red temporalmente (solo durante la instalación).', code: 'authorization_required' });
    try {
      const install = await runVerify(slug, id, 'install', true);
      const ran: string[] = ['install'];
      if (install.exitCode === 0) for (const c of body.data.commands) { const v = await runVerify(slug, id, c, false); ran.push(c); if (v.exitCode === DEPS_MISSING_EXIT) break; }
      app.log.info({ processId: id, install: install.exitCode, ran }, 'dependencias instaladas y verificación repetida');
      return await withGuidance(slug, processesRepo(slug).get(id)!);
    } catch (e: any) { return sendError(reply, e); }
  });
  app.get('/api/system/sandbox', async (req) => detectSandbox(String((req.query as any)?.force ?? '') === '1'));
  // ---- Verificación en ejecución (M2): el Portal se comprueba a sí mismo tras activar el cambio ----
  app.post('/api/workspaces/:slug/processes/:id/runtime-check', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita.' });
    const procs = processesRepo(slug); const proc = procs.get(id);
    if (!proc?.result?.merged) return reply.code(409).send({ error: 'Primero integra los cambios: la verificación en ejecución comprueba el Portal en marcha con el cambio activado.' });
    const served = await withGuidance(slug, proc);
    const act = served.result?.activation;
    if (act && !act.active) return reply.code(409).send({ error: `El cambio aún no está activo en el Portal en marcha: ${act.reason}`, code: 'not_activated' });
    try {
      requirePolicy('runtime_check', { slug, processId: id, projectId: proc.projectId, authorized: true });
      const own = proc.result.runtimeChecks?.checks ?? [];
      const checks = slug === INTERNAL_WORKSPACE.slug ? [...defaultChecks(), ...own] : own;
      if (!checks.length) return reply.code(409).send({ error: 'Esta historia no define comprobaciones en ejecución y el proyecto no es el Portal: nada que comprobar automáticamente.', code: 'no_checks' });
      const results = await runRuntimeChecks(id, checks);
      procs.setResult(id, { ...proc.result, runtimeChecks: { checks, results, ranAt: new Date().toISOString() } });
      procs.logExecution({ projectId: proc.projectId, agentId: '', kind: `runtime_check:${results.every(r => r.status === 'ok') ? 'ok' : results.some(r => r.status === 'fail') ? 'fail' : 'skipped'}`, status: results.every(r => r.status === 'ok') ? 'done' : 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: new Date().toISOString() });
      if (results.some(r => r.status === 'fail')) recordDetections(slug, id, projectsRepo(slug).repository(proc.projectId)?.path ?? null);
      return await withGuidance(slug, procs.get(id)!);
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e instanceof PolicyError ? e.code : undefined }); }
  });
  // Cierre de historia: solo cuando sus cambios están integrados en la rama principal (regla de cierre), salvo cierre
  // explícito «resuelta fuera del flujo» (force) que el propietario asume.
  app.post('/api/workspaces/:slug/backlog/:id/done', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ force: z.boolean().optional(), reason: z.string().max(300).optional() }).safeParse(req.body ?? {});
    const item = backlogRepo(slug).get(id); if (!item) return reply.code(404).send({ error: 'Historia no encontrada' });
    const procs = processesRepo(slug);
    const last = (item.lastProcessId ? procs.get(item.lastProcessId) : undefined) ?? procs.list(item.projectId).find(p => p.backlogItemId === item.id && p.kind === 'story_execution');
    const r = last?.result;
    if (!body.data?.force) {
      if (!r?.applied) return reply.code(409).send({ error: 'La historia no tiene cambios aplicados. Ejecútala y aplica su diff, o ciérrala como «resuelta fuera del flujo».', code: 'not_applied' });
      if (!r.merged) return reply.code(409).send({ error: `Los cambios están en la rama ${r.applied.branch} pero no integrados en la rama principal. Intégralos desde el proceso antes de cerrar la historia.`, code: 'not_merged' });
      // Proyecto interno (el propio Portal): el merge no basta. Debe estar ACTIVADO (servidor reiniciado con el cambio y web
      // reconstruida) y VERIFICADO en ejecución; publicar en GitHub no es requisito para cerrar.
      if (slug === INTERNAL_WORKSPACE.slug && last) {
        const served = await withGuidance(slug, last); const act = served.result?.activation;
        if (act && !act.active) return reply.code(409).send({ error: `La historia está integrada pero no activa en el Portal en marcha: ${act.reason}`, code: 'not_activated' });
        if (act && !runtimeVerified(served.result?.runtimeChecks)) return reply.code(409).send({ error: 'Falta la verificación en ejecución: pulsa «Comprobar en ejecución» en el proceso (el Portal se comprueba a sí mismo) y que todas las comprobaciones queden en verde.', code: 'not_runtime_verified' });
      }
      if (!r.manualTest) return reply.code(409).send({ error: 'Falta la prueba manual: en el Resumen del proceso, genera la lista de prueba con QA o escríbela, pruébala paso a paso y entonces cierra la historia.', code: 'no_test' });
      if (r.manualTest && r.manualTest.checks.some(c => !c)) { const n = r.manualTest.checks.filter(Boolean).length; return reply.code(409).send({ error: `Falta probar la historia: ${n} de ${r.manualTest.steps.length} pasos marcados. Sigue la lista «Qué probar» en el proceso y marca cada paso; si no puedes probarla, ciérrala como «resuelta fuera del flujo» indicando por qué.`, code: 'not_tested' }); }
    }
    backlogRepo(slug).setStatus(id, 'done');
    app.log.info({ story: item.storyId, force: !!body.data?.force, reason: body.data?.reason }, 'historia cerrada');
    return backlogRepo(slug).get(id);
  });

  app.get('/api/workspaces/:slug/projects/:projectId/knowledge', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    return knowledgeRepo(slug).list(projectId);
  });

  // Corrección externa (consola) autorizada por el propietario: se registra con su commit y sus archivos reales, se verifica
  // en el sandbox SIN IA y se detiene antes de QA. No crea pasos de agentes ni tokens, y no cambia las correcciones del equipo.
  app.post('/api/workspaces/:slug/processes/:id/external-correction', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), commit: z.string().trim().regex(/^[0-9a-f]{4,40}$/i).optional(), note: z.string().trim().min(3).max(2000) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Registrar una corrección externa exige tu autorización explícita y una nota con lo que se corrigió.', code: 'authorization_required' });
    const procs = processesRepo(slug); const proc0 = procs.get(id);
    try {
      if (proc0) requirePolicy('write_worktree', { slug, processId: id, agentId: null, projectId: proc0.projectId, authorized: true });
      const { registerExternalCorrection, verifyExternalCorrection } = await import('../services/externalCorrection.ts');
      const entry = await registerExternalCorrection(slug, id, { commit: body.data.commit ?? null, note: body.data.note });
      const proc = procs.get(id)!;
      procs.resume(id, Math.max(proc.budgetUsd, proc.spentUsd));
      app.log.info({ processId: id, commit: entry.commit, files: entry.files.length }, 'corrección externa registrada (autorizada)');
      const run = verifyExternalCorrection(slug, id, (o: any, m: string) => app.log.info(o, m), () => isCancelled(id)).finally(() => clearCancel(id));
      trackJob(id, run).catch(e => app.log.error(e, 'fallo inesperado al verificar la corrección externa'));
      return await withGuidance(slug, procs.get(id)!);
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e instanceof PolicyError ? e.code : e.code }); }
  });
}

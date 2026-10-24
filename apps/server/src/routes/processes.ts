import type { FastifyInstance } from 'fastify';
import type { Process } from '@portal-ia/domain';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { knowledgeRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { cancelProcess, clearCancel, createAssessment, estimateAssessment, isCancelled, runAssessment } from '../services/assessment.ts';
import { createStoryProcess, estimateStory, recoverStory, retryStory, runStory } from '../services/storyExecution.ts';
import { applyBacklogOps, createDelegation, ensureOpsParsed, estimateDelegation, runDelegation } from '../services/delegation.ts';
import { describeProcess } from '../services/guidance.ts';
import { INTERNAL_WORKSPACE } from '@portal-ia/domain';
import { applyChanges, checkStaleChanges, mergeBranch, pushBranches, remoteInfo, runVerification } from '../services/repoWrite.ts';
import { addManualItem, estimateExtraction, extractBacklogWithAI, importBacklogFromKnowledge, resetStory } from '../services/backlog.ts';
import { backlogRepo } from '../db/workspace.ts';

/**
 * Procesos autorizados (HU-004). Un proceso nace 'pending_authorization' con una estimación; solo empieza a consumir
 * IA cuando el usuario lo autoriza con un presupuesto (POST /authorize). Puede cancelarse; se detiene entre pasos.
 */
export async function processRoutes(app: FastifyInstance) {
  const withGuidance = (slug: string, p: Process): Process => ({ ...p, guidance: describeProcess(p, { isPortalRepo: slug === INTERNAL_WORKSPACE.slug }) });
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
    return processesRepo(slug).list(projectId).map(p => withGuidance(slug, p.kind === 'delegated_task' && p.status === 'done' ? ensureOpsParsed(slug, p) : p));
  });

  app.get('/api/workspaces/:slug/processes/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const p = processesRepo(slug).get(id); if (!p) return reply.code(404).send({ error: 'Proceso no encontrado' });
    return withGuidance(slug, p.kind === 'delegated_task' && p.status === 'done' ? ensureOpsParsed(slug, p) : p);
  });

  // Autorización explícita: aquí y solo aquí empieza el consumo de IA.
  app.post('/api/workspaces/:slug/processes/:id/authorize', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ budgetUsd: z.number().min(0.1).max(500), authorized: z.literal(true) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere presupuesto (USD) y autorización explícita.' });
    const procs = processesRepo(slug);
    const proc = procs.get(id);
    if (!proc) return reply.code(404).send({ error: 'Proceso no encontrado' });
    if (proc.status !== 'pending_authorization') return reply.code(409).send({ error: 'El proceso ya fue autorizado o finalizado.' });
    if (procs.running().length) return reply.code(409).send({ error: 'Ya hay un proceso en ejecución. Espera a que termine.' });
    procs.authorize(id, body.data.budgetUsd);
    app.log.info({ processId: id, kind: proc.kind, budget: body.data.budgetUsd }, 'proceso autorizado · inicia ejecución');
    const logger = (o: any, m: string) => app.log.info(o, m);
    const run = proc.kind === 'story_execution' ? runStory(slug, id, logger, () => isCancelled(id)).finally(() => clearCancel(id)) : proc.kind === 'delegated_task' ? runDelegation(slug, id, logger, () => isCancelled(id)).finally(() => clearCancel(id)) : runAssessment(slug, id, logger);
    setImmediate(() => { run.catch(e => app.log.error(e, 'fallo inesperado en el proceso')); });
    return procs.get(id);
  });

  app.post('/api/workspaces/:slug/processes/:id/cancel', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const proc = processesRepo(slug).get(id);
    if (!proc) return reply.code(404).send({ error: 'Proceso no encontrado' });
    if (proc.status === 'pending_authorization') { processesRepo(slug).finish(id, 'cancelled'); return processesRepo(slug).get(id); }
    if (proc.status === 'running') { cancelProcess(id); return { ...proc, cancelling: true }; }
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
    if (Object.keys(rest).length) repo.update(id, rest);
    if (status) repo.setStatus(id, status);
    return repo.get(id);
  });
  app.delete('/api/workspaces/:slug/backlog/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    backlogRepo(slug).delete(id); return { ok: true };
  });
  app.get('/api/workspaces/:slug/projects/:projectId/backlog/:id/estimate', async (req, reply) => {
    const { slug, projectId, id } = req.params as any; if (!guard(slug, reply)) return;
    const skipQa = String((req.query as any)?.skipQa ?? '') === '1';
    try { return estimateStory(slug, projectId, id, { skipQa }); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  // Crea el proceso de ejecución (pendiente de autorización). El consumo empieza en /authorize.
  app.post('/api/workspaces/:slug/projects/:projectId/backlog/:id/execute', async (req, reply) => {
    const { slug, projectId, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ skipQa: z.boolean().optional() }).safeParse(req.body ?? {});
    try { return createStoryProcess(slug, projectId, id, { skipQa: body.success ? !!body.data.skipQa : false }); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  // ---- Prueba manual: el propietario marca cada paso probado ----
  app.post('/api/workspaces/:slug/processes/:id/manual-test', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ checks: z.array(z.boolean()).max(20), note: z.string().max(500).nullable().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Datos no válidos' });
    const procs = processesRepo(slug); const proc = procs.get(id);
    if (!proc?.result?.manualTest) return reply.code(404).send({ error: 'Este proceso no tiene prueba manual.' });
    const mt = proc.result.manualTest; const checks = mt.steps.map((_, i) => !!body.data.checks[i]);
    procs.setResult(id, { ...proc.result, manualTest: { ...mt, checks, note: body.data.note === undefined ? mt.note : body.data.note } });
    return withGuidance(slug, procs.get(id)!);
  });

  // ---- Rechazar el diff de un proceso (la historia vuelve a pendiente) / devolver una historia a pendiente ----
  app.post('/api/workspaces/:slug/processes/:id/reject', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ reason: z.string().trim().max(300).optional() }).safeParse(req.body ?? {});
    const proc = processesRepo(slug).get(id);
    if (!proc || proc.kind !== 'story_execution') return reply.code(404).send({ error: 'Proceso de historia no encontrado' });
    if (proc.result?.applied) return reply.code(409).send({ error: 'Los cambios ya se aplicaron en una rama; si no los quieres, borra la rama con git.' });
    try { if (proc.backlogItemId) resetStory(slug, proc.backlogItemId, body.success && body.data.reason ? body.data.reason : 'diff rechazado por el propietario'); else processesRepo(slug).setResult(id, { ...(proc.result ?? { plan: null, implementationSummary: null, changes: [], verifyCommands: [], review: null, applied: null, verifications: [] }), rejected: { at: new Date().toISOString(), reason: 'rechazado' } }); app.log.info({ processId: id }, 'diff rechazado'); return withGuidance(slug, processesRepo(slug).get(id)!); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/backlog/:id/reset', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ reason: z.string().trim().max(300).optional() }).safeParse(req.body ?? {});
    try { return resetStory(slug, id, body.success && body.data.reason ? body.data.reason : 'devuelta a pendiente por el propietario'); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  // ---- Recuperar (sin IA) o reintentar un proceso de historia ----
  app.post('/api/workspaces/:slug/processes/:id/recover', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { const p = await recoverStory(slug, id); app.log.info({ processId: id, changes: p.result?.changes.length }, 'proceso recuperado sin IA'); return withGuidance(slug, p); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });
  app.post('/api/workspaces/:slug/processes/:id/retry', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ skipQa: z.boolean().optional() }).safeParse(req.body ?? {});
    try { const p = retryStory(slug, id, { skipQa: body.success ? !!body.data.skipQa : false }); app.log.info({ from: id, processId: p.id }, 'historia relanzada (pendiente de autorización)'); return reply.code(201).send(withGuidance(slug, p)); } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
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
      // Última comprobación: ningún «modify» completo sobre un archivo que cambió después de leerse.
      const checked = checkStaleChanges(repo.path, proc.result.changes);
      if (checked.some((c, i) => c.error && !proc.result!.changes[i].error)) { procs.setResult(id, { ...proc.result, changes: checked }); }
      if (!checked.some(c => !c.error)) return reply.code(409).send({ error: `Ningún cambio es aplicable ya: ${checked.filter(c => c.error).map(c => `${c.path}: ${c.error}`).join(' · ')}` });
      proc.result.changes = checked;
      const applied = await applyChanges(repo.path, branch, proc.result.changes, `${item?.storyId ?? 'Portal IA'}: ${item?.title ?? proc.title}

Cambios propuestos por el equipo de agentes de Portal IA y aprobados por el propietario.
Proceso: ${proc.id}`);
      const result = { ...proc.result, applied: { ...applied, appliedAt: new Date().toISOString() } };
      procs.setResult(id, result);
      procs.logExecution({ projectId: proc.projectId, agentId: proc.steps[1]?.agentId ?? '', kind: 'repo_write', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: new Date().toISOString() });
      app.log.info({ processId: id, branch: applied.branch, commit: applied.commit, files: applied.files.length }, 'cambios aplicados en rama');
      return procs.get(id);
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  // ---- Integrar en la rama principal (merge --no-ff · requiere autorización por uso) ----
  app.post('/api/workspaces/:slug/processes/:id/merge', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), into: z.string().trim().min(1).max(80).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita.' });
    const procs = processesRepo(slug); const proc = procs.get(id);
    if (!proc?.result?.applied) return reply.code(409).send({ error: 'Primero aplica los cambios en la rama.' });
    if (proc.result.merged) return reply.code(409).send({ error: `Ya integrada en ${proc.result.merged.into}.` });
    const repo = projectsRepo(slug).repository(proc.projectId); if (!repo) return reply.code(409).send({ error: 'No hay repositorio registrado.' });
    try {
      const m = await mergeBranch(repo.path, proc.result.applied.branch, body.data.into);
      procs.setResult(id, { ...proc.result, merged: { ...m, mergedAt: new Date().toISOString() } });
      procs.logExecution({ projectId: proc.projectId, agentId: proc.steps[0]?.agentId ?? '', kind: 'repo_merge', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: new Date().toISOString() });
      app.log.info({ processId: id, into: m.into, commit: m.commit }, 'rama integrada');
      return procs.get(id);
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
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
      const p = await pushBranches(repo.path, branches);
      procs.setResult(id, { ...proc.result, published: { ...p, pushedAt: new Date().toISOString() } });
      procs.logExecution({ projectId: proc.projectId, agentId: proc.steps[0]?.agentId ?? '', kind: 'repo_push', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: new Date().toISOString() });
      app.log.info({ processId: id, remote: p.remote, branches }, 'ramas publicadas');
      return procs.get(id);
    } catch (e: any) { return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  // ---- Verificación local (sandbox_exec · requiere autorización por uso; ejecución local sin sandbox) ----
  app.post('/api/workspaces/:slug/processes/:id/verify', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const body = z.object({ authorized: z.literal(true), command: z.enum(['install', 'typecheck', 'test', 'build']) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Se requiere autorización explícita y un comando permitido.' });
    const procs = processesRepo(slug); const proc = procs.get(id);
    if (!proc || !proc.result) return reply.code(404).send({ error: 'Proceso no encontrado' });
    const repo = projectsRepo(slug).repository(proc.projectId);
    if (!repo) return reply.code(409).send({ error: 'No hay repositorio registrado.' });
    const run = await runVerification(repo.path, body.data.command);
    procs.setResult(id, { ...proc.result, verifications: [...proc.result.verifications, run] });
    procs.logExecution({ projectId: proc.projectId, agentId: proc.steps[2]?.agentId ?? '', kind: 'local_exec', status: run.exitCode === 0 ? 'done' : 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: run.startedAt });
    return procs.get(id);
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
      if (r.manualTest && r.manualTest.checks.some(c => !c)) { const n = r.manualTest.checks.filter(Boolean).length; return reply.code(409).send({ error: `Falta probar la historia: ${n} de ${r.manualTest.steps.length} pasos marcados. Sigue la lista «Qué probar» en el proceso y marca cada paso; si no puedes probarla, ciérrala como «resuelta fuera del flujo» indicando por qué.`, code: 'not_tested' }); }
      if (!r.published) { const repo = projectsRepo(slug).repository(item.projectId); const { remote } = repo ? await remoteInfo(repo.path) : { remote: null }; if (remote) return reply.code(409).send({ error: 'Falta publicar: pulsa «Publicar en el remoto» en el proceso antes de cerrar la historia.', code: 'not_published' }); }
    }
    backlogRepo(slug).setStatus(id, 'done');
    app.log.info({ story: item.storyId, force: !!body.data?.force, reason: body.data?.reason }, 'historia cerrada');
    return backlogRepo(slug).get(id);
  });

  app.get('/api/workspaces/:slug/projects/:projectId/knowledge', async (req, reply) => {
    const { slug, projectId } = req.params as any; if (!guard(slug, reply)) return;
    return knowledgeRepo(slug).list(projectId);
  });
}

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CAPABILITIES, isRetired, slugify, type Agent } from '@portal-ia/domain';
import { workspacesRepo } from '../db/platform.ts';
import { agentsRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { listPendingDecisions } from '../services/inbox.ts';
import { agentMemory, agentWork, officeView } from '../services/agentOs.ts';
import { departmentsRepo } from '../services/departments.ts';
import { harnessCatalog, harnessOptions, switchHarness } from '../services/harness/index.ts';
import { detectCodex, getCodexSettings, lastCodexDetection, saveCodexSettings } from '../services/harness/codex.ts';
import { chatEstimate, chatMessages, chatUsageToday, sendChat } from '../services/agentChat.ts';
import { adoptExternal, agentFoldersRepo, discardExternal, ensureAgentFolders, folderStatus, restoreRevision, syncAgentFolder, updateExtras } from '../services/agentFolders.ts';
import { createAgentFromWizard, exportFiles, exportTo, importConfirm, importPreview } from '../services/agentCreation.ts';
import { proposeFromFeedback, retireMemory, verifyMemory } from '../services/agentLearning.ts';
import { agentEvents, recordAgentEvent } from '../services/agentEvents.ts';
import { createDelegation, estimateDelegation, MAX_DEPARTMENT_CONSULTS } from '../services/delegation.ts';
import { authorizeProcess } from '../services/processAuthorization.ts';
import { identityParts } from '../services/agentIdentity.ts';
import { externalSource } from '../services/externalAgents.ts';

/**
 * Rutas del «sistema operativo de agentes»: oficina, departamentos, panel de cada agente (chat, trabajo, archivos,
 * memoria, configuración), arneses, creación sin código, importación y exportación. Nada aquí llama a un modelo salvo:
 * enviar un mensaje a un agente (una llamada, la autoriza el propio envío) y los encargos, que pasan por la autorización
 * única de siempre (processAuthorization.ts).
 */
/**
 * Encargos y peticiones se crean y autorizan en el mismo acto. Si la autorización no procede (sin presupuesto, equipo no
 * listo, límite de la suscripción…), el proceso recién creado se cancela con el motivo: nunca queda una autorización
 * pendiente fantasma en la bandeja por cada reintento.
 */
function authorizeOrDiscard(slug: string, processId: string, budgetUsd: number, log: (o: any, m: string) => void) {
  try { return authorizeProcess(slug, processId, { budgetUsd }, log); }
  catch (e: any) { try { processesRepo(slug).finish(processId, 'cancelled', `No se inició: ${e?.message ?? e}`); } catch { /* ya no existe */ } throw e; }
}
const err = (reply: FastifyReply, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, ...(e.estimate ? { estimate: e.estimate } : {}), ...(e.code ? { code: e.code } : {}), ...(e.payload ?? {}) });

const SKILL = z.object({ slug: z.string().max(64).default(''), name: z.string().trim().min(2).max(80), description: z.string().max(400).default(''), body: z.string().max(20_000).default('') });
const REF = z.object({ slug: z.string().max(64).default(''), title: z.string().trim().min(2).max(120), body: z.string().max(20_000).default('') });
const HARNESS = z.enum(['api', 'claude-code', 'claude-code-terminal', 'codex']);
const CAP = z.enum(CAPABILITIES.map(c => c.id) as [string, ...string[]]);
const WIZARD = z.object({
  name: z.string().trim().min(2).max(80), role: z.string().trim().min(2).max(80), summary: z.string().trim().max(2000).default(''),
  responsibilities: z.array(z.string().trim().min(1).max(300)).max(30).default([]), deliverables: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  department: z.string().trim().min(2).max(60), departmentPurpose: z.string().max(400).nullable().optional(),
  scope: z.enum(['workspace', 'project']), projectId: z.string().nullable(),
  harness: HARNESS, model: z.string().trim().min(1).max(120), provider: z.enum(['anthropic', 'openai']).nullable().optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  tools: z.array(z.string().max(40)).max(12).default([]), knowledge: z.array(z.string().max(40)).max(8).default([]), capabilities: z.array(CAP).max(6).default([]),
  autonomy: z.enum(['ask', 'within_scope']).default('ask'), instructions: z.string().max(20_000).nullable().optional(),
  skills: z.array(SKILL).max(20).default([]), references: z.array(REF).max(20).default([]), initials: z.string().max(2).nullable().optional(),
  authorized: z.boolean()
});

export async function agentsOsRoutes(app: FastifyInstance) {
  const guard = (slug: string, reply: FastifyReply) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };
  const agentOr404 = (slug: string, id: string, reply: FastifyReply): Agent | null => { const a = agentsRepo(slug).get(id); if (!a) { reply.code(404).send({ error: 'Agente no encontrado' }); return null; } return a; };

  // ---------- Oficina
  app.get('/api/workspaces/:slug/office', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const q = z.object({ projectId: z.string().optional() }).parse(req.query ?? {});
    return officeView(slug, await listPendingDecisions(app, slug), { projectId: q.projectId ?? null });
  });

  // ---------- Departamentos
  app.get('/api/workspaces/:slug/departments', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const deps = departmentsRepo(slug);
    return deps.list().map(d => ({ ...d, coordinatorAgentId: deps.coordinatorOf(d.slug)?.id ?? null, members: deps.members(d.slug).map(a => ({ id: a.id, name: a.config.name, role: a.template.role })) }));
  });
  app.post('/api/workspaces/:slug/departments', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const b = z.object({ name: z.string().trim().min(2).max(60), purpose: z.string().max(400).optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'El departamento necesita un nombre (2–60 caracteres).' });
    try { if (departmentsRepo(slug).list().some(d => d.name.toLowerCase() === b.data.name.toLowerCase() && !d.implicit)) return reply.code(409).send({ error: 'Ya existe ese departamento.' }); return reply.code(201).send(departmentsRepo(slug).materialize(b.data)); } catch (e) { return err(reply, e); }
  });
  app.put('/api/workspaces/:slug/departments/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const b = z.object({ name: z.string().trim().min(2).max(60).optional(), purpose: z.string().max(400).optional(), coordinatorAgentId: z.string().nullable().optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Datos del departamento no válidos.' });
    try { return departmentsRepo(slug).update(id, b.data); } catch (e) { return err(reply, e); }
  });
  app.delete('/api/workspaces/:slug/departments/:id', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    try { departmentsRepo(slug).archive(id); return { ok: true }; } catch (e) { return err(reply, e); }
  });
  app.put('/api/workspaces/:slug/agents/:id/department', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; const a = agentOr404(slug, id, reply); if (!a) return;
    const b = z.object({ department: z.string().trim().min(2).max(60) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Indica el departamento.' });
    try {
      const deps = departmentsRepo(slug); const d = deps.get(b.data.department) ?? deps.materialize({ name: b.data.department });
      deps.assign(id, d.slug); recordAgentEvent(slug, id, 'department_changed', { to: d.name });
      if (agentFoldersRepo(slug).folderOf(id)) await syncAgentFolder(slug, agentsRepo(slug).get(id)!).catch(() => null);
      return agentsRepo(slug).get(id);
    } catch (e) { return err(reply, e); }
  });
  // Petición a un departamento: la recibe su coordinador, consulta a los miembros confirmados y entrega UN resultado.
  app.post('/api/workspaces/:slug/departments/:id/requests', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const b = z.object({ request: z.string().trim().min(8).max(8000), projectId: z.string().min(1), memberIds: z.array(z.string()).max(MAX_DEPARTMENT_CONSULTS), budgetUsd: z.number().min(0).max(500).default(0), maxSubscriptionCalls: z.number().int().min(1).max(60).optional(), authorized: z.literal(true), preview: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'La petición necesita el texto (≥8 caracteres), el proyecto y tu autorización explícita.' });
    try {
      const deps = departmentsRepo(slug); const d = deps.get(id); if (!d) return reply.code(404).send({ error: 'Departamento no encontrado' });
      if (!projectsRepo(slug).get(b.data.projectId)) return reply.code(400).send({ error: 'Proyecto no encontrado' });
      const coord = deps.coordinatorOf(d.slug); if (!coord) return reply.code(409).send({ error: `«${d.name}» no tiene miembros activos que puedan coordinar la petición.` });
      const members = deps.members(d.slug).map(a => a.id);
      const bad = b.data.memberIds.find(m => !members.includes(m)); if (bad) return reply.code(400).send({ error: 'Solo se puede consultar a miembros del departamento.' });
      const teamIds = b.data.memberIds.filter(m => m !== coord.id);
      if (b.data.preview) return { coordinator: { id: coord.id, name: coord.config.name }, estimate: estimateDelegation(slug, b.data.projectId, coord.id, b.data.request, 'department', teamIds) };
      const proc = createDelegation(slug, b.data.projectId, coord.id, b.data.request, { purpose: 'department', teamIds, department: { slug: d.slug, name: d.name } });
      if (b.data.maxSubscriptionCalls) processesRepo(slug).setCallCap(proc.id, b.data.maxSubscriptionCalls);
      return reply.code(201).send(authorizeOrDiscard(slug, proc.id, b.data.budgetUsd, (o, m) => app.log.info(o, m)));
    } catch (e) { return err(reply, e); }
  });

  // ---------- Panel del agente
  app.get('/api/workspaces/:slug/agents/:id/panel', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; const a = agentOr404(slug, id, reply); if (!a) return;
    const decisions = (await listPendingDecisions(app, slug));
    const office = officeView(slug, decisions, { onlyAgentId: id }).agents[0] ?? null;
    const identity = identityParts(slug, a, null);
    return {
      agent: a, office, department: departmentsRepo(slug).departmentOf(a), retired: isRetired(a.template),
      work: agentWork(slug, id), memory: agentMemory(slug, id), chat: { usage: chatUsageToday(slug, id), estimate: chatEstimate(slug, a, '') },
      identity: { hasInstructions: !!identity.instructions, skills: identity.skills.length, memory: identity.memory.length },
      folder: (() => { const s = folderStatus(slug, a); return { ...s, adopted: s.adopted ? { ...s.adopted, files: undefined, fileList: Object.keys(s.adopted.files).sort() } : null }; })(),
      events: agentEvents(slug, id, 30),
      external: (() => { const s = externalSource(slug, id); return s ? { state: s.state, hasOutputs: !!s.layout.outputs, root: s.root } : null; })()
    };
  });

  // ---------- Arneses
  app.get('/api/harnesses', async () => ({ harnesses: harnessCatalog(), codex: { settings: getCodexSettings(), detection: lastCodexDetection() } }));
  app.post('/api/harnesses/codex/detect', async () => ({ settings: getCodexSettings(), detection: await detectCodex() }));
  app.put('/api/harnesses/codex', async (req, reply) => {
    const b = z.object({ enabled: z.boolean(), cliPath: z.string().max(1024).nullable().optional(), maxDurationSec: z.number().int().min(60).max(3600).optional(), authorized: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Ajustes de Codex no válidos.' });
    const cur = getCodexSettings();
    if (b.data.enabled) {
      if (b.data.authorized !== true) return reply.code(403).send({ error: 'Habilitar Codex requiere tu autorización explícita.' });
      const det = await detectCodex({ ...cur, cliPath: b.data.cliPath ?? cur.cliPath });
      if (det.billing !== 'subscription' || !det.restricted) return reply.code(409).send({ error: det.problems[0] ?? 'Codex no se puede habilitar todavía.', detection: det });
    }
    return { settings: saveCodexSettings({ ...cur, enabled: b.data.enabled, cliPath: b.data.cliPath === undefined ? cur.cliPath : b.data.cliPath, maxDurationSec: b.data.maxDurationSec ?? cur.maxDurationSec, authorizedAt: b.data.enabled ? new Date().toISOString() : null }), detection: lastCodexDetection() };
  });
  app.get('/api/workspaces/:slug/agents/:id/harness', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; const a = agentOr404(slug, id, reply); if (!a) return;
    return harnessOptions(slug, a);
  });
  app.put('/api/workspaces/:slug/agents/:id/harness', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; if (!agentOr404(slug, id, reply)) return;
    const b = z.object({ harness: HARNESS, model: z.string().trim().min(1).max(120), provider: z.enum(['anthropic', 'openai']).nullable().optional(), authorized: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Arnés no válido.' });
    if (externalSource(slug, id) && (b.data.harness === 'api' || b.data.harness === 'claude-code-terminal')) return reply.code(409).send({ error: 'Un agente externo trabaja con Claude Code gestionado (tu suscripción): no se pasa a la API facturable ni a la consola.' });
    try {
      const updated = switchHarness(slug, id, b.data);
      if (agentFoldersRepo(slug).folderOf(id)) await syncAgentFolder(slug, updated, `Arnés cambiado a ${b.data.harness}`).catch(() => null);
      return updated;
    } catch (e) { return err(reply, e); }
  });

  // ---------- Chat directo
  app.get('/api/workspaces/:slug/agents/:id/chat', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; const a = agentOr404(slug, id, reply); if (!a) return;
    return { messages: chatMessages(slug, id), usage: chatUsageToday(slug, id), estimate: chatEstimate(slug, a, '') };
  });
  app.post('/api/workspaces/:slug/agents/:id/chat', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const b = z.object({ text: z.string().trim().max(8000).default(''), projectId: z.string().nullable().optional(), authorizeBillable: z.boolean().optional(), attachmentIds: z.array(z.string().max(80)).max(10).default([]) }).safeParse(req.body);
    if (!b.success || (b.data.text.length < 2 && !b.data.attachmentIds.length)) return reply.code(400).send({ error: 'Escribe un mensaje (máx. 8000 caracteres) o adjunta algo.' });
    try { return reply.code(202).send(await sendChat(slug, id, { text: b.data.text, projectId: b.data.projectId ?? null, authorizeBillable: b.data.authorizeBillable, attachmentIds: b.data.attachmentIds })); } catch (e) { return err(reply, e); }
  });

  // ---------- Encargo directo (tablero de trabajo): creado y autorizado en el mismo acto, con su tope de llamadas.
  app.post('/api/workspaces/:slug/agents/:id/tasks', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; const a = agentOr404(slug, id, reply); if (!a) return;
    const b = z.object({ request: z.string().trim().min(8).max(8000), projectId: z.string().nullable().optional(), budgetUsd: z.number().min(0).max(500).default(0), maxSubscriptionCalls: z.number().int().min(1).max(30).optional(), authorized: z.literal(true), preview: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'El encargo necesita una descripción (≥8 caracteres) y tu autorización explícita.' });
    if (isRetired(a.template)) return reply.code(409).send({ error: 'Este agente está retirado.' });
    try {
      const projectId = b.data.projectId ?? (a.scope === 'project' ? a.projectId : null);
      if (b.data.preview) return { estimate: estimateDelegation(slug, projectId, a.id, b.data.request, 'task') };
      const proc = createDelegation(slug, projectId, a.id, b.data.request, { purpose: 'task' });
      processesRepo(slug).setCallCap(proc.id, b.data.maxSubscriptionCalls ?? 3);
      const started = authorizeOrDiscard(slug, proc.id, b.data.budgetUsd, (o, m) => app.log.info(o, m));
      recordAgentEvent(slug, a.id, 'task_created', { processId: proc.id });
      return reply.code(201).send(started);
    } catch (e) { return err(reply, e); }
  });

  // ---------- Carpeta portable
  app.get('/api/workspaces/:slug/agents/:id/folder', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; const a = agentOr404(slug, id, reply); if (!a) return;
    return folderStatus(slug, a);
  });
  app.post('/api/workspaces/:slug/agents/:id/folder', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; const a = agentOr404(slug, id, reply); if (!a) return;
    try { const r = await syncAgentFolder(slug, a); if (r.created) recordAgentEvent(slug, id, 'folder_created', { revision: r.revision?.n ?? null }); return folderStatus(slug, a); } catch (e) { return err(reply, e); }
  });
  app.post('/api/workspaces/:slug/agent-folders', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const b = z.object({ authorized: z.literal(true) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Confirma que quieres crear las carpetas.' });
    return ensureAgentFolders(slug);
  });
  const onRow = (slug: string, id: string) => (p: { name: string; role: string; summary: string; responsibilities: string[]; initials: string; department: string | null }) => {
    const agents = agentsRepo(slug); const cur = agents.get(id)!;
    agents.updateConfig(id, { ...cur.config, name: p.name, specialization: p.summary, responsibilities: p.responsibilities });
    const after = agents.get(id)!; agents.updateTemplateMeta(id, { ...after.template, role: p.role, initials: (p.initials || after.template.initials).slice(0, 2).toUpperCase() });
    if (p.department) { const deps = departmentsRepo(slug); const d = deps.get(p.department) ?? deps.materialize({ name: p.department }); if (deps.departmentOf(agents.get(id)!).slug !== d.slug) deps.assign(id, d.slug); }
  };
  app.post('/api/workspaces/:slug/agents/:id/folder/adopt', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; if (!agentOr404(slug, id, reply)) return;
    const b = z.object({ hash: z.string().length(64) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Falta la huella de la versión revisada.' });
    try { const r = await adoptExternal(slug, id, b.data.hash, onRow(slug, id)); recordAgentEvent(slug, id, 'folder_adopted', { revision: r.n }); return r; } catch (e) { return err(reply, e); }
  });
  app.post('/api/workspaces/:slug/agents/:id/folder/discard', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; if (!agentOr404(slug, id, reply)) return;
    try { await discardExternal(slug, id); recordAgentEvent(slug, id, 'folder_discarded'); return { ok: true }; } catch (e) { return err(reply, e); }
  });
  app.post('/api/workspaces/:slug/agents/:id/folder/restore', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; if (!agentOr404(slug, id, reply)) return;
    const b = z.object({ n: z.number().int().min(1) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Indica la revisión.' });
    try { const r = await restoreRevision(slug, id, b.data.n, onRow(slug, id)); recordAgentEvent(slug, id, 'folder_restored', { to: b.data.n, revision: r.n }); return r; } catch (e) { return err(reply, e); }
  });
  app.put('/api/workspaces/:slug/agents/:id/identity', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; if (!agentOr404(slug, id, reply)) return;
    const b = z.object({ instructions: z.string().max(20_000).optional(), skills: z.array(SKILL).max(20).optional(), references: z.array(REF).max(20).optional(), deliverables: z.array(z.string().trim().min(1).max(200)).max(20).optional(), autonomy: z.enum(['ask', 'within_scope']).optional(), expectN: z.number().int().nullable() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Datos de identidad no válidos.' });
    const cur = agentFoldersRepo(slug).folderOf(id)?.adoptedN ?? null;
    if (b.data.expectN !== cur) return reply.code(409).send({ error: 'La identidad del agente cambió mientras la editabas: recarga para ver la versión actual.' });
    try {
      const { expectN: _e, references, ...rest } = b.data;
      const r = await updateExtras(slug, id, { ...rest, ...(references ? { knowledge: references.map(k => ({ ...k, slug: slugify(k.slug || k.title) })) } : {}), ...(rest.skills ? { skills: rest.skills.map(s => ({ ...s, slug: slugify(s.slug || s.name) })) } : {}) } as any, 'portal', 'Identidad editada por el propietario');
      recordAgentEvent(slug, id, 'identity_updated', { revision: r.n });
      return r;
    } catch (e) { return err(reply, e); }
  });

  // ---------- Memoria
  app.get('/api/workspaces/:slug/agents/:id/memory', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; if (!agentOr404(slug, id, reply)) return;
    return agentMemory(slug, id);
  });
  app.post('/api/workspaces/:slug/agents/:id/memory/feedback', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return;
    const b = z.object({ processId: z.string().nullable().optional(), messageId: z.string().nullable().optional(), rating: z.enum(['useful', 'needs_changes']), feedback: z.string().trim().min(3).max(2000), lesson: z.string().max(2000).nullable().optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Indica tu valoración y qué debería aprender.' });
    try { return reply.code(201).send(proposeFromFeedback(slug, id, b.data)); } catch (e) { return err(reply, e); }
  });
  app.post('/api/workspaces/:slug/agents/:id/memory/:lessonId/verify', async (req, reply) => {
    const { slug, id, lessonId } = req.params as any; if (!guard(slug, reply)) return;
    const b = z.object({ title: z.string().max(120).optional(), text: z.string().max(2000).optional() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'Texto no válido.' });
    try { return await verifyMemory(slug, id, lessonId, b.data); } catch (e) { return err(reply, e); }
  });
  app.post('/api/workspaces/:slug/agents/:id/memory/:lessonId/retire', async (req, reply) => {
    const { slug, id, lessonId } = req.params as any; if (!guard(slug, reply)) return;
    try { return await retireMemory(slug, id, lessonId); } catch (e) { return err(reply, e); }
  });

  // ---------- Crear, importar, exportar
  app.post('/api/workspaces/:slug/agents/wizard', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const b = WIZARD.safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Datos del agente no válidos.', issues: b.error.issues });
    try { return reply.code(201).send(await createAgentFromWizard(slug, b.data as any)); } catch (e) { return err(reply, e); }
  });
  app.post('/api/workspaces/:slug/agents/import/preview', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const b = z.object({ path: z.string().min(1).max(1024) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Elige la carpeta del agente.' });
    try { return importPreview(slug, b.data.path); } catch (e) { return err(reply, e); }
  });
  app.post('/api/workspaces/:slug/agents/import', async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const b = z.object({ path: z.string().min(1).max(1024), hash: z.string().length(64), department: z.string().trim().min(2).max(60), scope: z.enum(['workspace', 'project']), projectId: z.string().nullable(), harness: HARNESS, model: z.string().trim().min(1).max(120), provider: z.enum(['anthropic', 'openai']).nullable().optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'), tools: z.array(z.string().max(40)).max(12).default([]), knowledge: z.array(z.string().max(40)).max(8).default([]), capabilities: z.array(CAP).max(6).nullable().optional(), autonomy: z.enum(['ask', 'within_scope']).default('ask'), authorized: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Datos de importación no válidos.', issues: b.error.issues });
    try { const { path: p, hash, ...grant } = b.data; return reply.code(201).send(await importConfirm(slug, p, hash, grant as any)); } catch (e) { return err(reply, e); }
  });
  app.get('/api/workspaces/:slug/agents/:id/export', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; if (!agentOr404(slug, id, reply)) return;
    try { return await exportFiles(slug, id); } catch (e) { return err(reply, e); }
  });
  app.post('/api/workspaces/:slug/agents/:id/export', async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply)) return; if (!agentOr404(slug, id, reply)) return;
    const b = z.object({ path: z.string().min(1).max(1024) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Elige la carpeta de destino.' });
    try { return { path: await exportTo(slug, id, b.data.path) }; } catch (e) { return err(reply, e); }
  });
}

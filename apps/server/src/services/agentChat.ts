import crypto from 'node:crypto';
import { backendLabel, isRetired, type Agent, type ModelInfo, type ProviderId } from '@portal-ia/domain';
import { costUsd, estimatePricing, estimateTokens, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo, workspacesRepo } from '../db/platform.ts';
import { agentsRepo, processesRepo, projectsRepo, workspaceDb } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';
import { agentBackend, agentCaller } from './claudeCode/backend.ts';
import { requirePolicy } from './executionPolicy.ts';
import { harnessLabelFor } from './harness/index.ts';
import { agentFoldersRepo } from './agentFolders.ts';
import { identityBlock } from './agentIdentity.ts';
import { changed } from './live.ts';
import { recordAgentEvent } from './agentEvents.ts';
import { monotonicNow } from '../clock.ts';
import { attachmentsOfMessages, harnessSendsImages, linkToMessage, listAttachments, MAX_IMAGE_BYTES_PER_MESSAGE, modelContext, resolveForMessage, type ChatAttachment } from './agentAttachments.ts';
import { actionsOfMessages, actionsPrompt, extractAction, registerAction, workContext, type AgentAction } from './agentActions.ts';

/**
 * Conversación directa con un agente (pestaña «Chat» de la oficina). Cada mensaje que envía el propietario es UNA llamada
 * del agente con SU arnés — enviarlo es autorizarla, como en el Asistente —, con estas salvaguardas:
 *  - carril propio (uno a la vez) y tope diario de mensajes por agente, visible;
 *  - con la API (facturable): estimación por mensaje, autorización explícita en cada envío y límite mensual del agente;
 *  - nunca cambia de arnés ni cae a la API si su arnés no está disponible (se dice por qué);
 *  - contexto acotado: su identidad portable, un resumen del proyecto y los últimos mensajes;
 *  - la respuesta llega sin bloquear la petición; un reinicio a mitad deja el mensaje como «interrumpido» (no se repite).
 * Conversar no ejecuta nada: para un trabajo con entregable, el agente lo propone y el propietario crea un encargo.
 */
export const CHAT_DAILY_CAP = 40;
const HISTORY = 10; const HISTORY_CHARS = 12_000; const MAX_TOKENS = 2500;
const now = monotonicNow;

export interface AgentMessage { id: string; agentId: string; role: 'owner' | 'agent'; content: string; status: 'done' | 'running' | 'failed' | 'interrupted'; harness: string | null; model: string | null; tokensIn: number; tokensOut: number; costUsd: number; error: string | null; createdAt: string; finishedAt: string | null; replyTo: string | null;
  /** Adjuntos del mensaje, qué recibió el modelo de cada uno y las acciones que pidió el agente (con su estado actual). */
  attachments?: ChatAttachment[]; sent?: { id: string; how: string }[]; actions?: AgentAction[];
  /** Si la llamada al modelo terminó bien (true), falló (false) o no consta (null: interrumpida o en curso). */
  delivered?: boolean | null }

function ensure(slug: string) {
  const db = workspaceDb(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, harness TEXT, model TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, error TEXT, reply_to TEXT,
    project_id TEXT, created_at TEXT NOT NULL, finished_at TEXT
  ); CREATE INDEX IF NOT EXISTS agent_messages_agent ON agent_messages(agent_id, created_at);`);
  // 0.19 (aditivo): qué recibió el modelo de los adjuntos de cada mensaje.
  if (!(db.prepare(`PRAGMA table_info(agent_messages)`).all() as any[]).some(c => c.name === 'meta_json')) db.exec(`ALTER TABLE agent_messages ADD COLUMN meta_json TEXT`);
  return db;
}
const map = (r: any): AgentMessage => ({ id: r.id, agentId: r.agent_id, role: r.role, content: r.content, status: r.status, harness: r.harness, model: r.model, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd, error: r.error, createdAt: r.created_at, finishedAt: r.finished_at, replyTo: r.reply_to, ...(r.meta_json ? (({ sent, delivered }) => ({ sent: sent ?? undefined, delivered: delivered ?? null }))(JSON.parse(r.meta_json)) : {}) });

const inFlight = new Map<string, { slug: string; agentId: string; messageId: string }>();
export const chatInFlight = (slug: string) => [...inFlight.values()].filter(c => c.slug === slug);

export function chatMessages(slug: string, agentId: string, limit = 60): AgentMessage[] {
  const db = ensure(slug);
  // Una respuesta «en curso» que este proceso del servidor no está atendiendo es de antes de un reinicio: interrumpida.
  for (const r of db.prepare(`SELECT id FROM agent_messages WHERE agent_id = ? AND status = 'running'`).all(agentId) as any[]) {
    if (!inFlight.has(r.id)) db.prepare(`UPDATE agent_messages SET status = 'interrupted', error = 'El Portal se reinició mientras el agente respondía: no se repite la llamada.', finished_at = ? WHERE id = ?`).run(now(), r.id);
  }
  const msgs = (db.prepare(`SELECT * FROM (SELECT * FROM agent_messages WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at`).all(agentId, limit) as any[]).map(map);
  // Adjuntos y acciones de cada mensaje (las acciones con el estado actual de lo que crearon).
  const ids = msgs.map(m => m.id);
  const atts = attachmentsOfMessages(slug, ids); const acts = actionsOfMessages(slug, agentId, ids);
  return msgs.map(m => ({ ...m, attachments: atts.get(m.id) ?? [], actions: acts.get(m.id) ?? [] }));
}

export function chatUsageToday(slug: string, agentId: string): { used: number; cap: number } {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const n = (ensure(slug).prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE agent_id = ? AND role = 'agent' AND created_at >= ?`).get(agentId, start.toISOString()) as any).n as number;
  return { used: n, cap: CHAT_DAILY_CAP };
}

/** Lo que costaría (API) un mensaje: aproximado, con el contexto que se enviaría. Con una suscripción, 0 USD. */
/** Tokens que se estiman por imagen adjunta (una captura grande ronda los 1600). */
export const IMAGE_TOKENS = 1600;
/** Costo estimado de un mensaje: el texto escrito, lo que se envía de los adjuntos (texto e imágenes) y el contexto fijo. */
export function chatEstimate(slug: string, agent: Agent, text: string, images = 0) {
  const harness = agentBackend(agent);
  if (harness !== 'api') return { harness, label: harnessLabelFor(agent), billable: false, estimatedUsd: 0, inputUsdPerMTok: 0, imagesToModel: harnessSendsImages(harness) };
  const p = estimatePricing(agent.config.provider, agent.config.model);
  const inTok = estimateTokens(text) + images * IMAGE_TOKENS + 3500;
  return { harness, label: backendLabel(harness, null, agent.config.provider), billable: true, estimatedUsd: (inTok * p.inPerM + MAX_TOKENS * p.outPerM) / 1_000_000, inputUsdPerMTok: p.inPerM, imagesToModel: harnessSendsImages(harness) };
}

function systemFor(slug: string, a: Agent, projectId: string | null): string {
  const ws = workspacesRepo.get(slug)!;
  const project = projectId ? projectsRepo(slug).get(projectId) : null;
  const objectives = project ? projectsRepo(slug).objectives(project.id).map(o => o.text).slice(0, 6) : [];
  const revision = agentFoldersRepo(slug).folderOf(a.id)?.adoptedN ?? null;
  return `Eres «${a.config.name}», ${a.template.role.toLowerCase()} en la empresa «${ws.name}» (Portal IA). Hablas directamente con el propietario.
Especialización: ${a.config.specialization}
Responsabilidades:
${a.config.responsibilities.map(r => '- ' + r).join('\n')}
${project ? `\nProyecto actual: «${project.name}». ${project.description.slice(0, 600)}${objectives.length ? `\nObjetivos: ${objectives.join(' · ')}` : ''}` : ''}

Reglas: en español; claro y breve; nunca inventes datos, cifras ni resultados (distingue lo comprobado de lo supuesto). En esta conversación no ejecutas nada tú mismo: puedes pedir al Portal las acciones de abajo (él las valida, las ejecuta con sus controles y pide la aprobación del propietario cuando hace falta). Para trabajo con entregable que no esté en esas acciones, propónlo como encargo concreto para que el propietario lo cree desde tu panel.${identityBlock(slug, a, revision)}${actionsPrompt(slug, a)}${workContext(slug, a, listAttachments(slug, a.id).filter(x => x.status === 'attached'))}`;
}

export async function sendChat(slug: string, agentId: string, input: { text: string; projectId: string | null; authorizeBillable?: boolean; attachmentIds?: string[] }): Promise<{ owner: AgentMessage; reply: AgentMessage }> {
  const db = ensure(slug);
  const a = agentsRepo(slug).get(agentId);
  if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
  if (isRetired(a.template)) throw Object.assign(new Error('Este agente está retirado: reactívalo para conversar.'), { statusCode: 409 });
  const atts = resolveForMessage(slug, agentId, input.attachmentIds ?? []);
  const imageBytes = atts.filter(x => x.kind === 'image').reduce((t, x) => t + x.size, 0);
  if (imageBytes > MAX_IMAGE_BYTES_PER_MESSAGE) throw Object.assign(new Error(`Las imágenes de este mensaje suman ${(imageBytes / 1048576).toFixed(1)} MB: el máximo por mensaje es ${MAX_IMAGE_BYTES_PER_MESSAGE / 1048576} MB. Envíalas en varios mensajes.`), { statusCode: 413 });
  const text = input.text.trim() || (atts.length ? `(Adjunto${atts.length > 1 ? 's' : ''}: ${atts.map(x => x.name).join(', ')})` : '');
  if (text.length < 2 && !atts.length) throw Object.assign(new Error('Escribe un mensaje.'), { statusCode: 400 });
  if ([...inFlight.values()].some(c => c.slug === slug && c.agentId === agentId)) throw Object.assign(new Error(`«${a.config.name}» aún está respondiendo tu mensaje anterior.`), { statusCode: 409 });
  const usage = chatUsageToday(slug, agentId);
  if (usage.used >= usage.cap) throw Object.assign(new Error(`Hoy ya enviaste ${usage.used} mensajes a «${a.config.name}» (tope diario ${usage.cap}). Mañana se renueva; para trabajo largo, crea un encargo.`), { statusCode: 429 });
  const harness = agentBackend(a);
  const projectId = input.projectId && projectsRepo(slug).get(input.projectId) ? input.projectId : (a.scope === 'project' ? a.projectId : null);
  // Lo que el modelo recibe de los adjuntos (imágenes si su arnés las admite; de PDF y ZIP solo metadatos): cuenta en el costo.
  const ctx = modelContext(slug, a, harness, atts);
  // Con la API: autorización explícita por mensaje y límite mensual del agente (antes de enviar nada).
  let caller: ReturnType<typeof agentCaller> = null;
  if (harness === 'api') {
    if (input.authorizeBillable !== true) throw Object.assign(new Error(`«${a.config.name}» usa la API (facturable): confirma el costo estimado de este mensaje.`), { statusCode: 402, estimate: chatEstimate(slug, a, `${text}${ctx.text}`, ctx.images.length) });
    const prov = providersRepo.get(a.config.provider as ProviderId); const cred = providersRepo.credential(a.config.provider as ProviderId);
    if (!prov || prov.status !== 'connected' || !cred) throw Object.assign(new Error('El proveedor de API del agente no está conectado.'), { statusCode: 409 });
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const spent = (db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c FROM execution_history WHERE agent_id = ? AND started_at >= ?`).get(a.id, monthStart.toISOString()) as any).c as number;
    const est = chatEstimate(slug, a, `${text}${ctx.text}`, ctx.images.length).estimatedUsd;
    if (!(a.config.monthlyLimitUsd > 0)) throw Object.assign(new Error(`«${a.config.name}» no tiene límite mensual de gasto en la API: fíjalo en su configuración avanzada antes de conversar por la API.`), { statusCode: 409 });
    if (spent + est > a.config.monthlyLimitUsd) throw Object.assign(new Error(`Este mensaje superaría el límite mensual de «${a.config.name}» (${spent.toFixed(2)} + ≈${est.toFixed(3)} de ${a.config.monthlyLimitUsd.toFixed(2)} USD).`), { statusCode: 409 });
  } else {
    caller = agentCaller(slug, a, projectId, 'Conversación', null, null, { lane: 'chat' }); // lanza 409 si su arnés no está disponible (sin sustituto)
  }
  // Últimos mensajes (del más reciente hacia atrás, hasta el tope de caracteres) en orden cronológico.
  const newestFirst = db.prepare(`SELECT role, content FROM agent_messages WHERE agent_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT ?`).all(agentId, HISTORY) as any[];
  let budget = HISTORY_CHARS; const hist: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const h of newestFirst) { if (budget <= 0) break; const c = String(h.content).slice(0, budget); budget -= c.length; hist.unshift({ role: h.role === 'owner' ? 'user' : 'assistant', content: c }); }
  // Turnos alternados: sin respuesta inicial del agente y sin dos mensajes seguidos del mismo lado (se unen).
  while (hist.length && hist[0].role === 'assistant') hist.shift();
  for (let i = hist.length - 1; i > 0; i--) if (hist[i].role === hist[i - 1].role) { hist[i - 1] = { ...hist[i - 1], content: `${hist[i - 1].content}\n\n${hist[i].content}` }; hist.splice(i, 1); }
  if (hist.length && hist[hist.length - 1].role === 'user') hist.pop();
  const system = systemFor(slug, a, projectId);
  const ts = now(); const ownerId = crypto.randomUUID(); const replyId = crypto.randomUUID();
  db.prepare(`INSERT INTO agent_messages (id, agent_id, role, content, status, harness, model, project_id, created_at, finished_at, meta_json) VALUES (?, ?, 'owner', ?, 'done', NULL, NULL, ?, ?, ?, ?)`).run(ownerId, agentId, text, projectId, ts, ts, JSON.stringify({ sent: ctx.sent, delivered: null }));
  linkToMessage(slug, ownerId, atts);
  db.prepare(`INSERT INTO agent_messages (id, agent_id, role, content, status, harness, model, reply_to, project_id, created_at) VALUES (?, ?, 'agent', '', 'running', ?, ?, ?, ?, ?)`).run(replyId, agentId, harness, a.config.model, ownerId, projectId, now());
  inFlight.set(replyId, { slug, agentId, messageId: replyId });
  changed({ ws: slug, entity: 'agent_chat', id: agentId }); changed({ ws: slug, entity: 'agent', id: agentId, kind: 'progress' });
  const startedAt = new Date().toISOString();
  const finish = (status: 'done' | 'failed', patch: { content?: string; error?: string | null; tokensIn?: number; tokensOut?: number; cost?: number }) => {
    db.prepare(`UPDATE agent_messages SET status = ?, content = ?, error = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, finished_at = ? WHERE id = ?`)
      .run(status, patch.content ?? '', patch.error ?? null, patch.tokensIn ?? 0, patch.tokensOut ?? 0, patch.cost ?? 0, now(), replyId);
    // «El modelo recibió…» solo cuenta si la llamada terminó bien.
    db.prepare(`UPDATE agent_messages SET meta_json = ? WHERE id = ?`).run(JSON.stringify({ sent: ctx.sent, delivered: status === 'done' }), ownerId);
    inFlight.delete(replyId);
    try { processesRepo(slug).logExecution({ projectId: projectId ?? '', agentId, kind: 'agent_chat', status, tokensIn: patch.tokensIn ?? 0, tokensOut: patch.tokensOut ?? 0, cost: patch.cost ?? 0, startedAt }); } catch { /* auditoría */ }
    changed({ ws: slug, entity: 'agent_chat', id: agentId }); changed({ ws: slug, entity: 'agent', id: agentId, kind: 'progress' }); changed({ ws: slug, entity: 'usage', id: null });
  };
  void (async () => {
    try {
      requirePolicy('ai_call', { slug, agentId, authorized: true, route: harness === 'api' ? 'api' : harness === 'codex' ? 'codex' : 'claude-code' });
      const req = { model: a.config.model, system, user: `${text}${ctx.text}`, maxTokens: MAX_TOKENS, effort: a.config.effort, supportsEffort: false, history: hist.length ? hist : undefined, ...(ctx.images.length ? { images: ctx.images } : {}) };
      // Si la respuesta pide una acción, se quita del texto visible y se dirige al ciclo que corresponde.
      const done = async (raw: string, extra: { tokensIn: number; tokensOut: number; cost?: number }) => {
        const { visible, action } = extractAction(raw.trim());
        finish('done', { content: visible || (action ? 'Preparo la acción que me pediste.' : '(El modelo respondió sin texto.)'), ...extra });
        if (action) await registerAction(slug, agentId, replyId, ownerId, action.kind, action.payload, atts).catch(() => null);
      };
      if (caller) {
        const r = await caller.complete(req);
        await done(r.text, { tokensIn: r.inputTokens, tokensOut: r.outputTokens });
      } else {
        const providerId = a.config.provider as ProviderId; const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId)!;
        const models: ModelInfo[] = JSON.parse(prow.models_json);
        const r = await getAdapter(providerId)!.complete(decryptSecret(cred.ciphertext), { workspaceId: prow.workspace_id }, { ...req, supportsEffort: !!models.find(m => m.id === a.config.model)?.supportsEffort });
        await done(r.text, { tokensIn: r.inputTokens, tokensOut: r.outputTokens, cost: costUsd(providerId, a.config.model, r.inputTokens, r.outputTokens) });
      }
    } catch (e: any) {
      const msg = e instanceof ProviderRequestError ? e.error.message : e?.message ?? String(e);
      const u = e?.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      finish('failed', { error: `${msg} No se ha usado otro arnés ni la API en su lugar.`, tokensIn: u?.inputTokens ?? 0, tokensOut: u?.outputTokens ?? 0 });
    }
  })();
  recordAgentEvent(slug, agentId, 'chat', { harness, messageId: ownerId });
  const all = chatMessages(slug, agentId, 4);
  return { owner: all.find(m => m.id === ownerId)!, reply: all.find(m => m.id === replyId) ?? map(db.prepare(`SELECT * FROM agent_messages WHERE id = ?`).get(replyId)) };
}

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

export interface AgentMessage { id: string; agentId: string; role: 'owner' | 'agent'; content: string; status: 'done' | 'running' | 'failed' | 'interrupted'; harness: string | null; model: string | null; tokensIn: number; tokensOut: number; costUsd: number; error: string | null; createdAt: string; finishedAt: string | null; replyTo: string | null }

function ensure(slug: string) {
  const db = workspaceDb(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, harness TEXT, model TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, error TEXT, reply_to TEXT,
    project_id TEXT, created_at TEXT NOT NULL, finished_at TEXT
  ); CREATE INDEX IF NOT EXISTS agent_messages_agent ON agent_messages(agent_id, created_at);`);
  return db;
}
const map = (r: any): AgentMessage => ({ id: r.id, agentId: r.agent_id, role: r.role, content: r.content, status: r.status, harness: r.harness, model: r.model, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd, error: r.error, createdAt: r.created_at, finishedAt: r.finished_at, replyTo: r.reply_to });

const inFlight = new Map<string, { slug: string; agentId: string; messageId: string }>();
export const chatInFlight = (slug: string) => [...inFlight.values()].filter(c => c.slug === slug);

export function chatMessages(slug: string, agentId: string, limit = 60): AgentMessage[] {
  const db = ensure(slug);
  // Una respuesta «en curso» que este proceso del servidor no está atendiendo es de antes de un reinicio: interrumpida.
  for (const r of db.prepare(`SELECT id FROM agent_messages WHERE agent_id = ? AND status = 'running'`).all(agentId) as any[]) {
    if (!inFlight.has(r.id)) db.prepare(`UPDATE agent_messages SET status = 'interrupted', error = 'El Portal se reinició mientras el agente respondía: no se repite la llamada.', finished_at = ? WHERE id = ?`).run(now(), r.id);
  }
  return (db.prepare(`SELECT * FROM (SELECT * FROM agent_messages WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at`).all(agentId, limit) as any[]).map(map);
}

export function chatUsageToday(slug: string, agentId: string): { used: number; cap: number } {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const n = (ensure(slug).prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE agent_id = ? AND role = 'agent' AND created_at >= ?`).get(agentId, start.toISOString()) as any).n as number;
  return { used: n, cap: CHAT_DAILY_CAP };
}

/** Lo que costaría (API) un mensaje: aproximado, con el contexto que se enviaría. Con una suscripción, 0 USD. */
export function chatEstimate(slug: string, agent: Agent, text: string) {
  const harness = agentBackend(agent);
  if (harness !== 'api') return { harness, label: harnessLabelFor(agent), billable: false, estimatedUsd: 0 };
  const p = estimatePricing(agent.config.provider, agent.config.model);
  const inTok = estimateTokens(text) + 3500;
  return { harness, label: backendLabel(harness, null, agent.config.provider), billable: true, estimatedUsd: (inTok * p.inPerM + MAX_TOKENS * p.outPerM) / 1_000_000 };
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

Reglas: en español; claro y breve; nunca inventes datos, cifras ni resultados (distingue lo comprobado de lo supuesto). En esta conversación NO ejecutas nada ni tienes herramientas: si algo requiere trabajo con entregable, propónlo como encargo concreto (qué harías y qué entregarías) para que el propietario lo cree desde tu panel.${identityBlock(slug, a, revision)}`;
}

export async function sendChat(slug: string, agentId: string, input: { text: string; projectId: string | null; authorizeBillable?: boolean }): Promise<{ owner: AgentMessage; reply: AgentMessage }> {
  const db = ensure(slug);
  const a = agentsRepo(slug).get(agentId);
  if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
  if (isRetired(a.template)) throw Object.assign(new Error('Este agente está retirado: reactívalo para conversar.'), { statusCode: 409 });
  const text = input.text.trim();
  if (text.length < 2) throw Object.assign(new Error('Escribe un mensaje.'), { statusCode: 400 });
  if ([...inFlight.values()].some(c => c.slug === slug && c.agentId === agentId)) throw Object.assign(new Error(`«${a.config.name}» aún está respondiendo tu mensaje anterior.`), { statusCode: 409 });
  const usage = chatUsageToday(slug, agentId);
  if (usage.used >= usage.cap) throw Object.assign(new Error(`Hoy ya enviaste ${usage.used} mensajes a «${a.config.name}» (tope diario ${usage.cap}). Mañana se renueva; para trabajo largo, crea un encargo.`), { statusCode: 429 });
  const harness = agentBackend(a);
  const projectId = input.projectId && projectsRepo(slug).get(input.projectId) ? input.projectId : (a.scope === 'project' ? a.projectId : null);
  // Con la API: autorización explícita por mensaje y límite mensual del agente (antes de enviar nada).
  let caller: ReturnType<typeof agentCaller> = null;
  if (harness === 'api') {
    if (input.authorizeBillable !== true) throw Object.assign(new Error(`«${a.config.name}» usa la API (facturable): confirma el costo estimado de este mensaje.`), { statusCode: 402, estimate: chatEstimate(slug, a, text) });
    const prov = providersRepo.get(a.config.provider as ProviderId); const cred = providersRepo.credential(a.config.provider as ProviderId);
    if (!prov || prov.status !== 'connected' || !cred) throw Object.assign(new Error('El proveedor de API del agente no está conectado.'), { statusCode: 409 });
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const spent = (db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c FROM execution_history WHERE agent_id = ? AND started_at >= ?`).get(a.id, monthStart.toISOString()) as any).c as number;
    const est = chatEstimate(slug, a, text).estimatedUsd;
    if (a.config.monthlyLimitUsd > 0 && spent + est > a.config.monthlyLimitUsd) throw Object.assign(new Error(`Este mensaje superaría el límite mensual de «${a.config.name}» (${spent.toFixed(2)} + ≈${est.toFixed(3)} de ${a.config.monthlyLimitUsd.toFixed(2)} USD).`), { statusCode: 409 });
  } else {
    caller = agentCaller(slug, a, projectId, 'Conversación', null, null, { lane: 'chat' }); // lanza 409 si su arnés no está disponible (sin sustituto)
  }
  // Últimos mensajes (del más reciente hacia atrás, hasta el tope de caracteres) en orden cronológico.
  const newestFirst = db.prepare(`SELECT role, content FROM agent_messages WHERE agent_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT ?`).all(agentId, HISTORY) as any[];
  let budget = HISTORY_CHARS; const hist: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const h of newestFirst) { if (budget <= 0) break; const c = String(h.content).slice(0, budget); budget -= c.length; hist.unshift({ role: h.role === 'owner' ? 'user' : 'assistant', content: c }); }
  const ts = now(); const ownerId = crypto.randomUUID(); const replyId = crypto.randomUUID();
  db.prepare(`INSERT INTO agent_messages (id, agent_id, role, content, status, harness, model, project_id, created_at, finished_at) VALUES (?, ?, 'owner', ?, 'done', NULL, NULL, ?, ?, ?)`).run(ownerId, agentId, text, projectId, ts, ts);
  db.prepare(`INSERT INTO agent_messages (id, agent_id, role, content, status, harness, model, reply_to, project_id, created_at) VALUES (?, ?, 'agent', '', 'running', ?, ?, ?, ?, ?)`).run(replyId, agentId, harness, a.config.model, ownerId, projectId, now());
  inFlight.set(replyId, { slug, agentId, messageId: replyId });
  changed({ ws: slug, entity: 'agent_chat', id: agentId }); changed({ ws: slug, entity: 'agent', id: agentId, kind: 'progress' });
  const system = systemFor(slug, a, projectId);
  const startedAt = new Date().toISOString();
  const finish = (status: 'done' | 'failed', patch: { content?: string; error?: string | null; tokensIn?: number; tokensOut?: number; cost?: number }) => {
    db.prepare(`UPDATE agent_messages SET status = ?, content = ?, error = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, finished_at = ? WHERE id = ?`)
      .run(status, patch.content ?? '', patch.error ?? null, patch.tokensIn ?? 0, patch.tokensOut ?? 0, patch.cost ?? 0, now(), replyId);
    inFlight.delete(replyId);
    try { processesRepo(slug).logExecution({ projectId: projectId ?? '', agentId, kind: 'agent_chat', status, tokensIn: patch.tokensIn ?? 0, tokensOut: patch.tokensOut ?? 0, cost: patch.cost ?? 0, startedAt }); } catch { /* auditoría */ }
    changed({ ws: slug, entity: 'agent_chat', id: agentId }); changed({ ws: slug, entity: 'agent', id: agentId, kind: 'progress' }); changed({ ws: slug, entity: 'usage', id: null });
  };
  void (async () => {
    try {
      requirePolicy('ai_call', { slug, agentId, authorized: true, route: harness === 'api' ? 'api' : harness === 'codex' ? 'codex' : 'claude-code' });
      const req = { model: a.config.model, system, user: text, maxTokens: MAX_TOKENS, effort: a.config.effort, supportsEffort: false, history: hist.length ? hist : undefined };
      if (caller) {
        const r = await caller.complete(req);
        finish('done', { content: r.text.trim(), tokensIn: r.inputTokens, tokensOut: r.outputTokens });
      } else {
        const providerId = a.config.provider as ProviderId; const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId)!;
        const models: ModelInfo[] = JSON.parse(prow.models_json);
        const r = await getAdapter(providerId)!.complete(decryptSecret(cred.ciphertext), { workspaceId: prow.workspace_id }, { ...req, supportsEffort: !!models.find(m => m.id === a.config.model)?.supportsEffort });
        finish('done', { content: r.text.trim(), tokensIn: r.inputTokens, tokensOut: r.outputTokens, cost: costUsd(providerId, a.config.model, r.inputTokens, r.outputTokens) });
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

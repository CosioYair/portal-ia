import { agentDisplayName, agentPersonalName, backendLabel, buildNameProposalPrompt, isRetired, parseNameProposal, validateAgentName, type Agent, type AgentNameCheck, type ModelInfo, type ProviderId } from '@portal-ia/domain';
import { costUsd, estimatePricing, estimateTokens, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, processesRepo, workspaceDb } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';
import { agentBackend, agentCaller } from './claudeCode/backend.ts';
import { requirePolicy } from './executionPolicy.ts';
import { harnessLabelFor } from './harness/index.ts';
import { agentFoldersRepo, nameContextFor, storePersonalName, syncAgentFolder } from './agentFolders.ts';
import { recordAgentEvent } from './agentEvents.ts';
import { changed } from './live.ts';

/**
 * EN-015 · Nombre propio del agente («Lucía»), distinto de su puesto (config.name, que no cambia) y de su carpeta (no se
 * renombra). Lo propone el propio agente con UNA llamada a su arnés, solo con la autorización del propietario
 * (requirePolicy 'ai_call'), y la llamada queda registrada con tokens y costo: 0 USD con suscripción y USD con la API,
 * dentro del límite mensual del agente. Si choca con otro nombre, se marca y no se reintenta solo.
 * Escribirlo a mano no llama a ningún modelo ni cuesta nada.
 */
const MAX_TOKENS = 300;
export const MAX_BATCH = 30;
const fail = (msg: string, statusCode: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(msg), { statusCode, ...extra });
type EventKind = Parameters<typeof recordAgentEvent>[2];

export interface NameEstimate { agentId: string; harness: string; label: string; billable: boolean; estimatedUsd: number }
export interface NameProposalResult { agentId: string; name: string; reason: string; check: AgentNameCheck; harness: string; tokensIn: number; tokensOut: number; costUsd: number }
export interface BatchItem { agentId: string; ok: boolean; proposal: NameProposalResult | null; error: string | null }

const projectOf = (a: Agent) => (a.scope === 'project' ? a.projectId : null);
const routeOf = (h: string) => (h === 'api' ? 'api' : h === 'codex' ? 'codex' : 'claude-code');

function getAgent(slug: string, agentId: string): Agent {
  const a = agentsRepo(slug).get(agentId);
  if (!a) throw fail('Agente no encontrado', 404);
  return a;
}

function promptFor(slug: string, a: Agent, rejected: readonly string[], extraTaken: readonly string[] = []): string {
  const ctx = nameContextFor(slug, a.id, extraTaken);
  return buildNameProposalPrompt({ role: a.config.name, specialization: a.config.specialization, responsibilities: a.config.responsibilities ?? [], taken: ctx.taken, roles: ctx.roles, rejected });
}

/** Costo estimado de UNA propuesta: 0 USD con suscripción y USD aproximados con la API. */
export function estimateNameCost(slug: string, agentId: string): NameEstimate {
  const a = getAgent(slug, agentId); const harness = agentBackend(a);
  if (harness !== 'api') return { agentId, harness, label: harnessLabelFor(a), billable: false, estimatedUsd: 0 };
  const p = estimatePricing(a.config.provider, a.config.model);
  const inTok = estimateTokens(promptFor(slug, a, [])) + 200;
  return { agentId, harness, label: backendLabel(harness, null, a.config.provider), billable: true, estimatedUsd: (inTok * p.inPerM + MAX_TOKENS * p.outPerM) / 1_000_000 };
}

/** Costo estimado del lote (una llamada por agente) para la tarjeta de autorización única. */
export function estimateNamesCost(slug: string, agentIds: string[]): { items: NameEstimate[]; totalUsd: number; calls: number } {
  const items = [...new Set(agentIds)].slice(0, MAX_BATCH).map(id => estimateNameCost(slug, id));
  return { items, totalUsd: items.reduce((t, i) => t + i.estimatedUsd, 0), calls: items.length };
}

/** Sin autorización no hay llamada: la política registra la negativa y respondemos 403. */
function authorize(slug: string, a: Agent, authorized: boolean) {
  const route = routeOf(agentBackend(a));
  try { requirePolicy('ai_call', { slug, agentId: a.id, authorized, route } as any); }
  catch (e: any) { throw fail(e?.message ?? 'Llamada no autorizada.', e?.statusCode ?? 403); }
  if (!authorized) throw fail(`Para que «${a.config.name}» elija su nombre hace falta tu autorización (una llamada con su arnés).`, 403);
}

/** UNA llamada con el arnés del agente (sin sustituto: si su arnés no está disponible, se dice por qué). */
async function callOnce(slug: string, a: Agent, prompt: string): Promise<{ text: string; tokensIn: number; tokensOut: number; cost: number; harness: string }> {
  const harness = agentBackend(a);
  const req = { model: a.config.model, system: `Eres «${a.config.name}», un agente de Portal IA. Respondes solo con el JSON que se te pide.`, user: prompt, maxTokens: MAX_TOKENS, effort: a.config.effort, supportsEffort: false };
  const startedAt = new Date().toISOString();
  const log = (status: 'done' | 'failed', tIn: number, tOut: number, cost: number) => {
    try { processesRepo(slug).logExecution({ projectId: projectOf(a) ?? '', agentId: a.id, kind: 'agent_name', status, tokensIn: tIn, tokensOut: tOut, cost, startedAt }); } catch { /* auditoría */ }
    changed({ ws: slug, entity: 'usage', id: null });
  };
  if (harness !== 'api') {
    const caller = agentCaller(slug, a, projectOf(a), 'Nombre propio'); // 409 si su arnés no está disponible
    if (!caller) throw fail('El arnés del agente no está disponible ahora.', 409);
    try { const r = await caller.complete(req as any); log('done', r.inputTokens, r.outputTokens, 0); return { text: r.text, tokensIn: r.inputTokens, tokensOut: r.outputTokens, cost: 0, harness }; }
    catch (e: any) { log('failed', e?.usage?.inputTokens ?? 0, e?.usage?.outputTokens ?? 0, 0); throw fail(`${e?.message ?? e} No se ha usado otro arnés ni la API en su lugar.`, e?.statusCode ?? 502); }
  }
  const providerId = a.config.provider as ProviderId; const prow = providersRepo.get(providerId); const cred = providersRepo.credential(providerId);
  if (!prow || prow.status !== 'connected' || !cred) throw fail('El proveedor de API del agente no está conectado.', 409);
  if (!(a.config.monthlyLimitUsd > 0)) throw fail(`«${a.config.name}» no tiene límite mensual de gasto en la API: fíjalo en su configuración avanzada.`, 409);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const spent = (workspaceDb(slug).prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c FROM execution_history WHERE agent_id = ? AND started_at >= ?`).get(a.id, monthStart.toISOString()) as any).c as number;
  const est = estimateNameCost(slug, a.id).estimatedUsd;
  if (spent + est > a.config.monthlyLimitUsd) throw fail(`La propuesta superaría el límite mensual de «${a.config.name}» (${spent.toFixed(2)} + ≈${est.toFixed(3)} de ${a.config.monthlyLimitUsd.toFixed(2)} USD).`, 409);
  const models: ModelInfo[] = JSON.parse(prow.models_json);
  try {
    const r = await getAdapter(providerId)!.complete(decryptSecret(cred.ciphertext), { workspaceId: prow.workspace_id }, { ...req, supportsEffort: !!models.find(m => m.id === a.config.model)?.supportsEffort } as any);
    const cost = costUsd(providerId, a.config.model, r.inputTokens, r.outputTokens);
    log('done', r.inputTokens, r.outputTokens, cost);
    return { text: r.text, tokensIn: r.inputTokens, tokensOut: r.outputTokens, cost, harness };
  } catch (e: any) {
    log('failed', e?.usage?.inputTokens ?? 0, e?.usage?.outputTokens ?? 0, 0);
    throw fail(e instanceof ProviderRequestError ? e.error.message : e?.message ?? String(e), 502);
  }
}

async function proposeChecked(slug: string, a: Agent, rejected: readonly string[], extraTaken: readonly string[]): Promise<NameProposalResult> {
  if (isRetired(a.template)) throw fail('Este agente está retirado: reactívalo antes.', 409);
  const r = await callOnce(slug, a, promptFor(slug, a, rejected, extraTaken));
  const parsed = parseNameProposal(r.text);
  if (!parsed) throw fail('El agente no devolvió un nombre legible. Pide otro o escríbelo a mano.', 422);
  const check = validateAgentName(parsed.name, nameContextFor(slug, a.id, extraTaken));
  recordAgentEvent(slug, a.id, 'name_proposed' as EventKind, { harness: r.harness, ok: check.ok });
  return { agentId: a.id, name: check.name, reason: parsed.reason, check, harness: r.harness, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.cost };
}

/** «Que elija su nombre»: una llamada autorizada. No guarda nada: el propietario acepta, pide otro o lo escribe. */
export async function proposeName(slug: string, agentId: string, input: { authorized: boolean; rejected?: string[] }): Promise<NameProposalResult> {
  const a = getAgent(slug, agentId);
  authorize(slug, a, input.authorized === true);
  return proposeChecked(slug, a, input.rejected ?? [], []);
}

/** Lote de la Oficina: una autorización y una llamada por agente; los errores se informan por agente. */
export async function proposeNames(slug: string, agentIds: string[], input: { authorized: boolean }): Promise<{ items: BatchItem[]; calls: number; costUsd: number }> {
  const ids = [...new Set(agentIds)];
  if (!ids.length) throw fail('Elige al menos un agente.', 400);
  if (ids.length > MAX_BATCH) throw fail(`Como máximo ${MAX_BATCH} agentes por lote.`, 400);
  const agents = ids.map(id => getAgent(slug, id));
  if (input.authorized !== true) { authorize(slug, agents[0], false); }
  const items: BatchItem[] = []; const reserved: string[] = []; let calls = 0; let total = 0;
  for (const a of agents) {
    try {
      authorize(slug, a, true);
      calls++;
      const p = await proposeChecked(slug, a, [], reserved);
      total += p.costUsd;
      if (p.check.ok) reserved.push(p.name);
      items.push({ agentId: a.id, ok: true, proposal: p, error: null });
    } catch (e: any) { items.push({ agentId: a.id, ok: false, proposal: null, error: e?.message ?? String(e) }); }
  }
  return { items, calls, costUsd: total };
}

/** Comprueba un nombre sin costo (para la escritura a mano y para marcar choques antes de aceptar). */
export function checkName(slug: string, agentId: string, name: string): AgentNameCheck {
  getAgent(slug, agentId);
  return validateAgentName(name, nameContextFor(slug, agentId));
}

/** Acepta o escribe el nombre (null lo borra). Sin IA ni costo; no toca el puesto ni la carpeta, que se regenera. */
export async function setPersonalName(slug: string, agentId: string, name: string | null): Promise<{ agent: Agent; personalName: string | null; displayName: string }> {
  const a = getAgent(slug, agentId);
  let next: string | null = null;
  if (name !== null) {
    const check = validateAgentName(name, nameContextFor(slug, agentId));
    if (!check.ok) throw fail(check.reason ?? 'Nombre no válido.', check.code === 'taken' || check.code === 'role' ? 409 : 400, { code: check.code, payload: { check } });
    next = check.name;
  }
  const before = agentPersonalName(a);
  if (before === next) return { agent: a, personalName: next, displayName: agentDisplayName(a) };
  const agent = storePersonalName(slug, agentId, next);
  recordAgentEvent(slug, agentId, 'name_changed' as EventKind, { from: before, to: next });
  const folders = agentFoldersRepo(slug);
  if (folders.folderOf(agentId)) await syncAgentFolder(slug, agent, next ? `Nombre propio: ${next} (el puesto no cambia)` : 'Nombre propio retirado').catch(() => null);
  // Quien le reporta lo nombra en su AGENTS.md por defecto.
  for (const x of agentsRepo(slug).list()) {
    if (x.id !== agentId && x.template.reportsTo && x.template.reportsTo === a.key && folders.folderOf(x.id)) await syncAgentFolder(slug, x).catch(() => null);
  }
  changed({ ws: slug, entity: 'agent', id: agentId });
  return { agent, personalName: next, displayName: agentDisplayName(agent) };
}

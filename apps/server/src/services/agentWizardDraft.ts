import { backendLabel, buildWizardDraftPrompt, parseWizardDraft, WIZARD_DRAFT_LIMITS, type Agent, type AgentWizardDraft, type ModelInfo, type ProviderId } from '@portal-ia/domain';
import { costUsd, estimatePricing, estimateTokens, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, processesRepo, workspaceDb } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';
import { agentBackend, agentCaller } from './claudeCode/backend.ts';
import { requirePolicy } from './executionPolicy.ts';
import { harnessLabelFor } from './harness/index.ts';
import { changed } from './live.ts';

/**
 * HU-204 · «Redactar con IA» en «Nuevo agente». El Agente de Onboarding redacta papel, resumen, responsabilidades,
 * entregables, habilidades e instrucciones a partir de la necesidad del propietario. Es UNA llamada y solo con su
 * autorización (requirePolicy 'ai_call', el mismo mecanismo que el nombre propio de EN-015). Va por su arnés
 * (suscripción, 0 USD) o por complete() de la API (USD, con tope y límite mensual). Queda registrada con tokens y costo,
 * también si falla (0 USD). No se guarda nada ni se toca ningún permiso: la propuesta solo rellena los campos del asistente.
 */
const MAX_TOKENS = 3000;
const KIND = 'agent_wizard_draft';
const fail = (msg: string, statusCode: number) => Object.assign(new Error(msg), { statusCode });

export interface WizardDraftEstimate {
  agentId: string; byAgent: string; harness: string; label: string; provider: ProviderId; model: string;
  costKind: 'subscription' | 'usd'; estimatedUsd: number; calls: 1;
}
export interface WizardDraftResult {
  draft: AgentWizardDraft; discarded: string[];
  byAgent: string; harness: string; model: string; tokensIn: number; tokensOut: number; costUsd: number;
}

function onboardingOf(slug: string): Agent {
  const a = agentsRepo(slug).list().find(x => x.key === 'ws-onboarding');
  if (!a) throw fail('Falta el Agente de Onboarding en este espacio: no se puede redactar con IA. Sigue sin IA.', 409);
  return a;
}

function promptFor(slug: string, need: string) {
  const roles = agentsRepo(slug).list().map(a => `${a.config.name} (${a.template.role})`);
  return buildWizardDraftPrompt(need, { existingRoles: roles });
}

/** Motor y costo de la redacción, sin llamar a nada. Sin necesidad se estima con la longitud máxima. */
export function estimateWizardDraft(slug: string, need?: string | null): WizardDraftEstimate {
  const a = onboardingOf(slug); const harness = agentBackend(a);
  const base = { agentId: a.id, byAgent: a.config.name, harness, provider: a.config.provider as ProviderId, model: a.config.model, calls: 1 as const };
  if (harness !== 'api') return { ...base, label: harnessLabelFor(a), costKind: 'subscription', estimatedUsd: 0 };
  const p = estimatePricing(a.config.provider, a.config.model);
  const prompt = promptFor(slug, (need ?? '').trim() || 'x'.repeat(WIZARD_DRAFT_LIMITS.need));
  const inTok = estimateTokens(`${prompt.system}\n${prompt.user}`) + 200;
  return { ...base, label: backendLabel(harness, null, a.config.provider), costKind: 'usd', estimatedUsd: (inTok * p.inPerM + MAX_TOKENS * p.outPerM) / 1_000_000 };
}

/** Una sola llamada autorizada. Sin authorized:true no se llama a nada ni se registra ejecución. */
export async function draftWizardProposal(slug: string, need: string, opts: { authorized: boolean; maxUsd: number }): Promise<WizardDraftResult> {
  if (opts.authorized !== true) throw fail('Redactar con IA requiere tu autorización explícita (una llamada al Agente de Onboarding).', 403);
  const text = (need ?? '').trim();
  if (text.length < 10) throw fail('Describe qué debería conseguir el agente (al menos 10 caracteres).', 400);
  if (text.length > WIZARD_DRAFT_LIMITS.need) throw fail(`La necesidad admite como máximo ${WIZARD_DRAFT_LIMITS.need} caracteres.`, 400);
  const a = onboardingOf(slug); const harness = agentBackend(a);
  const est = estimateWizardDraft(slug, text);
  if (est.estimatedUsd > opts.maxUsd) throw fail(`La redacción cuesta aprox. ${est.estimatedUsd.toFixed(3)} USD, por encima del tope autorizado (${opts.maxUsd.toFixed(2)} USD).`, 409);
  const route = harness === 'api' ? 'api' : harness === 'codex' ? 'codex' : 'claude-code';
  try { requirePolicy('ai_call', { slug, agentId: a.id, authorized: true, route } as any); }
  catch (e: any) { throw fail(e?.message ?? 'Llamada no autorizada.', e?.statusCode ?? 403); }

  const prompt = promptFor(slug, text);
  const req = { model: a.config.model, system: prompt.system, user: prompt.user, maxTokens: MAX_TOKENS, effort: 'low' as const, supportsEffort: false };
  const startedAt = new Date().toISOString();
  const log = (status: 'done' | 'failed', tIn: number, tOut: number, cost: number) => {
    try { processesRepo(slug).logExecution({ projectId: '', agentId: a.id, kind: KIND, status, tokensIn: tIn, tokensOut: tOut, cost, startedAt } as any); } catch { /* auditoría */ }
    changed({ ws: slug, entity: 'usage', id: null });
  };

  let out: { text: string; tokensIn: number; tokensOut: number; cost: number };
  if (harness !== 'api') {
    const caller = agentCaller(slug, a, null, 'Redactar agente con IA');
    if (!caller) throw fail('El arnés del Agente de Onboarding no está disponible ahora. Sigue sin IA.', 409);
    try { const r = await caller.complete(req as any); log('done', r.inputTokens, r.outputTokens, 0); out = { text: r.text, tokensIn: r.inputTokens, tokensOut: r.outputTokens, cost: 0 }; }
    catch (e: any) { log('failed', e?.usage?.inputTokens ?? 0, e?.usage?.outputTokens ?? 0, 0); throw fail(`${e?.message ?? e} No se ha usado otro arnés ni la API en su lugar.`, e?.statusCode ?? 502); }
  } else {
    const providerId = a.config.provider as ProviderId; const prow = providersRepo.get(providerId); const cred = providersRepo.credential(providerId);
    if (!prow || prow.status !== 'connected' || !cred) throw fail('El proveedor de API del Agente de Onboarding no está conectado. Sigue sin IA.', 409);
    if (!(a.config.monthlyLimitUsd > 0)) throw fail(`«${a.config.name}» no tiene límite mensual de gasto en la API: fíjalo en su configuración avanzada.`, 409);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const spent = (workspaceDb(slug).prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c FROM execution_history WHERE agent_id = ? AND started_at >= ?`).get(a.id, monthStart.toISOString()) as any).c as number;
    if (spent + est.estimatedUsd > a.config.monthlyLimitUsd) throw fail(`La redacción superaría el límite mensual de «${a.config.name}» (${spent.toFixed(2)} + ≈${est.estimatedUsd.toFixed(3)} de ${a.config.monthlyLimitUsd.toFixed(2)} USD).`, 409);
    const models: ModelInfo[] = JSON.parse(prow.models_json);
    try {
      const r = await getAdapter(providerId)!.complete(decryptSecret(cred.ciphertext), { workspaceId: prow.workspace_id }, { ...req, supportsEffort: !!models.find(m => m.id === a.config.model)?.supportsEffort } as any);
      const cost = costUsd(providerId, a.config.model, r.inputTokens, r.outputTokens);
      log('done', r.inputTokens, r.outputTokens, cost);
      out = { text: r.text, tokensIn: r.inputTokens, tokensOut: r.outputTokens, cost };
    } catch (e: any) {
      log('failed', e?.usage?.inputTokens ?? 0, e?.usage?.outputTokens ?? 0, 0);
      throw fail(e instanceof ProviderRequestError ? e.error.message : e?.message ?? String(e), 502);
    }
  }

  const parsed = parseWizardDraft(out.text);
  if (!parsed) throw fail('El Agente de Onboarding no devolvió una propuesta legible. Puedes seguir sin IA o volver a intentarlo.', 422);
  return { draft: parsed.draft, discarded: parsed.discarded, byAgent: a.config.name, harness, model: a.config.model, tokensIn: out.tokensIn, tokensOut: out.tokensOut, costUsd: out.cost };
}

import {
  costUsd, estimateTokens,
  type CompletionRequest, type CompletionResult, type CredentialOptions, type ProviderAdapter
} from '@portal-ia/ai-adapters';
import type { BudgetLedger } from './budget-ledger.ts';

export interface GuardedCall {
  apiKey: string;
  options?: CredentialOptions;
  request: CompletionRequest;
  signal?: AbortSignal;
}

export interface GuardedResult {
  result: CompletionResult;
  reservationId: string;
  estimatedMicros: number;
  actualMicros: number;
}

/** Presupuesto de razonamiento que el adaptador de Anthropic suma a max_tokens. */
function thinkingBudget(req: CompletionRequest): number {
  if (!req.supportsEffort) return 0;
  return req.effort === 'high' ? 8000 : req.effort === 'medium' ? 3000 : 0;
}

/**
 * Estimación conservadora (cota superior) del coste de una llamada en micro-USD:
 * tokens de entrada estimados por caracteres + salida máxima (maxTokens + razonamiento).
 * No contabiliza imágenes adjuntas.
 */
export function estimateCallMicros(adapter: ProviderAdapter, req: CompletionRequest): number {
  const inputText = [req.system, req.user, ...(req.history ?? []).map(h => h.content)].join('\n');
  const inputTokens = estimateTokens(inputText);
  const outputTokens = req.maxTokens + thinkingBudget(req);
  const usd = costUsd(adapter.id, req.model, inputTokens, outputTokens);
  // toFixed evita que el ruido de coma flotante (p. ej. 33000.00000000001) suba un micro de más.
  return Math.ceil(Number((usd * 1_000_000).toFixed(4)));
}

/** Coste real en micro-USD a partir de los tokens que devuelve complete(). */
export function actualCallMicros(adapter: ProviderAdapter, req: CompletionRequest, result: CompletionResult): number {
  return Math.round(costUsd(adapter.id, req.model, result.inputTokens, result.outputTokens) * 1_000_000);
}

/**
 * Único punto de entrada para llamadas a modelos con corte duro de presupuesto:
 * estimar → reservar → complete() → liquidar al coste real (o liberar si falla).
 * Si no cabe la estimación, lanza BudgetExceededError y el adaptador nunca se invoca.
 */
export async function guardedComplete(
  ledger: BudgetLedger,
  adapter: ProviderAdapter,
  scopeId: string,
  call: GuardedCall
): Promise<GuardedResult> {
  const estimatedMicros = estimateCallMicros(adapter, call.request);
  const reservationId = ledger.reserve(scopeId, estimatedMicros); // propaga BudgetExceededError sin llamar al adaptador

  let result: CompletionResult;
  try {
    result = await adapter.complete(call.apiKey, call.options, call.request, call.signal);
  } catch (e) {
    ledger.release(reservationId);
    throw e;
  }

  // La llamada ya se hizo (y se facturó): se registra el coste real aunque supere la estimación.
  const actualMicros = actualCallMicros(adapter, call.request, result);
  ledger.settle(reservationId, actualMicros);
  return { result, reservationId, estimatedMicros, actualMicros };
}

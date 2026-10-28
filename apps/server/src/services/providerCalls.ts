import type { AgentFailureKind, ProviderErrorCode } from '@portal-ia/domain';
import { ProviderRequestError } from '@portal-ia/ai-adapters';

/**
 * Ciclo de vida de una llamada al proveedor: plazo, cancelación real, reintentos acotados y clasificación del fallo.
 *
 * PLAZO. Sin streaming, una respuesta solo llega cuando el modelo termina. El plazo de cada llamada se calcula a partir de
 * lo máximo que puede tener que generar: 60 s de margen (red, cola, lectura del prompt) + (salida máxima + presupuesto de
 * razonamiento) a 25 tokens/s, entre 90 s y 10 min. 25 tokens/s es deliberadamente lento (los modelos actuales suelen
 * ir más rápido): un plazo demasiado corto cancelaría respuestas legítimas que ya se están facturando, y uno demasiado
 * largo deja al propietario esperando. Se puede fijar con PORTAL_PROVIDER_TIMEOUT_SEC (todas las llamadas) o por
 * proceso (PipelineConfig.providerTimeoutSec).
 *
 * CANCELACIÓN. Cada llamada registra su AbortController en el proceso; «Cancelar» los aborta todos: la petición HTTP se
 * corta de verdad. Abortar no garantiza que el proveedor no facture lo ya procesado: se registra una estimación NO
 * confirmada aparte del gasto confirmado.
 *
 * REINTENTOS. Solo errores de conexión que no producen respuesta (red, 429, 5xx/529 sobrecargado), con espera
 * exponencial (2 s, 8 s…). Un plazo agotado NO se reintenta solo (la llamada pudo facturarse entera): se pausa y decide
 * el propietario. Errores de credencial, permisos o petición no se reintentan.
 */
const THINKING: Record<string, number> = { high: 8000, medium: 3000, low: 0 };
export const TIMEOUT_LIMITS = { minMs: 90_000, maxMs: 10 * 60_000, marginMs: 60_000, tokensPerSec: 25 } as const;

export function callTimeoutMs(maxTokens: number, effort: string | null | undefined, overrideSec?: number | null): number {
  const env = Number(process.env.PORTAL_PROVIDER_TIMEOUT_SEC);
  const fixed = overrideSec && overrideSec > 0 ? overrideSec : Number.isFinite(env) && env > 0 ? env : null;
  if (fixed) return Math.round(fixed * 1000); // explícito: se respeta tal cual (las pruebas usan plazos cortos)
  const ms = TIMEOUT_LIMITS.marginMs + ((maxTokens + (THINKING[effort ?? 'low'] ?? 0)) / TIMEOUT_LIMITS.tokensPerSec) * 1000;
  return Math.round(Math.min(TIMEOUT_LIMITS.maxMs, Math.max(TIMEOUT_LIMITS.minMs, ms)));
}

export function maxProviderRetries(override?: number | null): number {
  const env = Number(process.env.PORTAL_PROVIDER_RETRIES);
  const v = override ?? (Number.isFinite(env) && process.env.PORTAL_PROVIDER_RETRIES !== undefined ? env : 2);
  return Math.max(0, Math.min(3, Math.floor(v)));
}

/** Espera antes del reintento n (1, 2…): 2 s, 8 s, 32 s (+ hasta 25 % aleatorio). PORTAL_PROVIDER_BACKOFF_MS cambia la base (pruebas). */
export function backoffMs(attempt: number): number {
  const base = Number(process.env.PORTAL_PROVIDER_BACKOFF_MS) || 2000;
  const ms = base * 4 ** (attempt - 1);
  return Math.round(ms + Math.random() * ms * 0.25);
}

/** ¿Merece la pena reintentar? Solo fallos de transporte o de capacidad del proveedor, sin respuesta útil. */
export function isTransient(e: unknown): boolean {
  if (!(e instanceof ProviderRequestError)) return false;
  const { code, httpStatus } = e.error;
  return code === 'network' || code === 'rate_limited' || (code === 'provider_error' && (httpStatus ?? 0) >= 500);
}

/** Clase de fallo de una llamada al proveedor. */
export function providerFailureClass(e: unknown): { kind: AgentFailureKind; code: ProviderErrorCode | null } {
  if (!(e instanceof ProviderRequestError)) return { kind: 'UNKNOWN_FAILURE', code: null };
  const code = e.error.code;
  if (code === 'timeout') return { kind: 'PROVIDER_TIMEOUT', code };
  if (code === 'invalid_key' || code === 'forbidden' || code === 'no_credential' || code === 'workspace_required') return { kind: 'PERMISSION_REQUIRED', code };
  if (code === 'network' || code === 'rate_limited' || code === 'provider_error') return { kind: 'PROVIDER_CONNECTION_ERROR', code };
  return { kind: 'UNKNOWN_FAILURE', code };
}

/**
 * ¿Pudo facturarse? (el proveedor pudo recibir la petición y procesarla). Errores de autenticación o 4xx: no. Un error
 * que no viene del proveedor (p. ej. la política lo rechaza antes de enviar nada) tampoco: no hubo petición.
 */
export function maybeBilled(e: unknown): boolean {
  if (!(e instanceof ProviderRequestError)) return false;
  const { code, httpStatus } = e.error;
  return code === 'timeout' || code === 'cancelled' || code === 'network' || (httpStatus ?? 0) >= 500;
}

// ---------------------------------------------------------------- Registro de llamadas en curso por proceso

const inflight = new Map<string, Set<AbortController>>();
export function registerCall(processId: string): AbortController {
  const c = new AbortController();
  let set = inflight.get(processId); if (!set) inflight.set(processId, set = new Set());
  set.add(c); return c;
}
export function unregisterCall(processId: string, c: AbortController) {
  const set = inflight.get(processId); if (!set) return;
  set.delete(c); if (!set.size) inflight.delete(processId);
}
/** Aborta las llamadas en curso del proceso (cancelar). Devuelve cuántas había. */
export function abortProcessCalls(processId: string): number {
  const set = inflight.get(processId); if (!set) return 0;
  const n = set.size; for (const c of set) c.abort(); inflight.delete(processId); return n;
}
export const inflightCount = (processId: string) => inflight.get(processId)?.size ?? 0;

/** Espera abortable (entre reintentos): si se cancela el proceso, deja de esperar. */
export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => { const t = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
}

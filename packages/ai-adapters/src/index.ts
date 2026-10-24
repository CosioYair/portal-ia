import { classifyModel, sortModels, type ModelInfo, type ProviderError, type ProviderId } from '@portal-ia/domain';

/**
 * Adaptador de proveedor: contrato mínimo para HU-001.
 * Solo `listModels` (verificación de credencial + catálogo). NO genera texto.
 * Las operaciones de generación se añadirán en historias posteriores, siempre tras autorización.
 */
export interface CredentialOptions {
  /** Anthropic: claves no asociadas a un workspace requieren `anthropic-workspace-id`. */
  workspaceId?: string | null;
}

export interface CompletionRequest {
  model: string;
  system: string;
  /** Un único turno de usuario basta para los procesos de evaluación. */
  user: string;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
  supportsEffort: boolean;
  /** Imágenes adjuntas al turno de usuario (base64 sin prefijo). */
  images?: { mediaType: string; data: string }[];
  /** Turnos previos (para continuar una respuesta cortada): se insertan antes del turno de usuario actual. */
  history?: { role: 'user' | 'assistant'; content: string }[];
}
export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export interface ProviderAdapter {
  id: ProviderId;
  listModels(apiKey: string, options?: CredentialOptions, signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Generación real (HU-004). Solo se invoca dentro de un proceso autorizado por el usuario con presupuesto. */
  complete(apiKey: string, options: CredentialOptions | undefined, req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>;
}

export class ProviderRequestError extends Error {
  constructor(public readonly error: ProviderError) { super(error.message); }
}

const LIST_TIMEOUT_MS = 15_000;
/** La generación con razonamiento extendido sobre contextos grandes puede tardar minutos. */
const COMPLETE_TIMEOUT_MS = 10 * 60_000;
/** Estimación de tokens a partir de caracteres (código/markdown ≈ 3.5 caracteres por token). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = LIST_TIMEOUT_MS): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  signal?.addEventListener('abort', () => ctrl.abort());
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    clearTimeout(t);
    throw new ProviderRequestError({ code: 'network', message: e?.name === 'AbortError' ? `Tiempo de espera agotado (${Math.round(timeoutMs / 1000)} s) esperando al proveedor. La solicitud pudo haberse procesado y facturado parcialmente.` : `No se pudo contactar con el proveedor: ${e?.message ?? 'error de red'}.` });
  }
  clearTimeout(t);
  if (!res.ok) {
    let detail = '';
    try { const j: any = await res.json(); detail = j?.error?.message || j?.message || ''; } catch { /* sin cuerpo */ }
    const needsWorkspace = (res.status === 400 && /anthropic-workspace-id|scoped to a workspace/i.test(detail)) || (res.status === 404 && /workspace/i.test(detail));
    const code: ProviderError['code'] = needsWorkspace ? 'workspace_required' : res.status === 401 ? 'invalid_key' : res.status === 403 ? 'forbidden' : res.status === 429 ? 'rate_limited' : 'provider_error';
    const message = code === 'workspace_required'
      ? (/must be a valid workspace|not found/i.test(detail)
        ? 'El ID de workspace indicado no existe o no es válido. Copia el valor de la columna «ID» en console.anthropic.com → Settings → Workspaces: empieza por wrkspc_ (el identificador con guiones que aparece en la URL no sirve).'
        : 'Esta clave de Anthropic no está asociada a un workspace. Indica el ID del workspace en el campo correspondiente (console.anthropic.com → Settings → Workspaces) o crea una clave de API dentro de un workspace.')
      : code === 'invalid_key' ? 'El proveedor rechazó la credencial (401 · clave no válida).'
      : code === 'forbidden' ? 'La credencial no tiene permiso para esta operación (403).'
      : code === 'rate_limited' ? 'El proveedor limitó las solicitudes (429). Inténtalo de nuevo en unos segundos.'
      : `El proveedor devolvió un error (${res.status}).`;
    throw new ProviderRequestError({ code, message: detail && code !== 'workspace_required' ? `${message} ${detail}` : message, httpStatus: res.status });
  }
  return res.json();
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  async listModels(apiKey, options, signal) {
    // https://docs.claude.com/en/api/models-list — GET /v1/models (paginado; 1 página basta para verificar)
    const headers: Record<string, string> = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    if (options?.workspaceId) headers['anthropic-workspace-id'] = options.workspaceId;
    const out: ModelInfo[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const url = new URL('https://api.anthropic.com/v1/models');
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after_id', after);
      const j = await fetchJson(url.toString(), { headers }, signal);
      for (const m of j.data ?? []) out.push(classifyModel('anthropic', m.id, m.display_name));
      if (!j.has_more || !j.last_id) break;
      after = j.last_id;
    }
    return sortModels(out);
  },
  async complete(apiKey, options, req, signal) {
    // https://docs.claude.com/en/api/messages — POST /v1/messages
    const headers: Record<string, string> = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    if (options?.workspaceId) headers['anthropic-workspace-id'] = options.workspaceId;
    const budget = req.effort === 'high' ? 8000 : req.effort === 'medium' ? 3000 : 0;
    const content: any[] = [...(req.images ?? []).map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })), { type: 'text', text: req.user }];
    const base: any = { model: req.model, max_tokens: req.maxTokens + budget, system: req.system, messages: [...(req.history ?? []).map(h => ({ role: h.role, content: h.content })), { role: 'user', content }] };
    const withThinking = req.supportsEffort && budget > 0 ? { ...base, thinking: { type: 'enabled', budget_tokens: budget } } : base;
    let j: any;
    try {
      j = await fetchJson('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(withThinking) }, signal, COMPLETE_TIMEOUT_MS);
    } catch (e) {
      // Si el modelo no acepta el parámetro de razonamiento, reintentamos sin él (una sola vez).
      if (withThinking !== base && e instanceof ProviderRequestError && e.error.httpStatus === 400 && /thinking|budget_tokens/i.test(e.error.message)) {
        j = await fetchJson('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(base) }, signal, COMPLETE_TIMEOUT_MS);
      } else throw e;
    }
    const text = (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    return { text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: (j.usage?.output_tokens ?? 0), stopReason: j.stop_reason ?? null };
  }
};

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  async listModels(apiKey, _options, signal) {
    // https://platform.openai.com/docs/api-reference/models/list — GET /v1/models
    const j = await fetchJson('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } }, signal);
    const ids: string[] = (j.data ?? []).map((m: any) => String(m.id));
    // Filtramos a modelos de chat/razonamiento relevantes para agentes (el catálogo de OpenAI incluye embeddings, audio, etc.).
    const relevant = ids.filter(id => /^(gpt-5|gpt-4\.1|gpt-4o|o1|o3|o4)/.test(id) && !/(audio|realtime|transcribe|tts|search|image|embedding|instruct|moderation|-\d{4}-\d{2}-\d{2}$)/.test(id));
    return sortModels(relevant.map(id => classifyModel('openai', id)));
  },
  async complete(apiKey, _options, req, signal) {
    // https://platform.openai.com/docs/api-reference/chat — POST /v1/chat/completions
    const userContent: any = req.images?.length ? [...req.images.map(im => ({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.data}` } })), { type: 'text', text: req.user }] : req.user;
    const body: any = { model: req.model, messages: [{ role: 'system', content: req.system }, ...(req.history ?? []), { role: 'user', content: userContent }], max_completion_tokens: req.maxTokens };
    if (req.supportsEffort) body.reasoning_effort = req.effort;
    const j = await fetchJson('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, signal, COMPLETE_TIMEOUT_MS);
    const choice = j.choices?.[0];
    return { text: choice?.message?.content ?? '', inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0, stopReason: choice?.finish_reason ?? null };
  }
};

/**
 * Precios estimados en USD por millón de tokens (entrada / salida), por familia. Se usan para
 * estimar y limitar presupuestos; el costo real lo factura el proveedor. Actualizar al cambiar tarifas.
 */
export function estimatePricing(provider: ProviderId, modelId: string): { inPerM: number; outPerM: number; approximate: true } {
  const m = modelId.toLowerCase();
  if (provider === 'anthropic') {
    if (m.includes('opus')) return { inPerM: 15, outPerM: 75, approximate: true };
    if (m.includes('haiku')) return { inPerM: 1, outPerM: 5, approximate: true };
    return { inPerM: 3, outPerM: 15, approximate: true };
  }
  if (/^o1|^o3(?!-mini)/.test(m)) return { inPerM: 15, outPerM: 60, approximate: true };
  if (/mini|nano/.test(m)) return { inPerM: 0.4, outPerM: 1.6, approximate: true };
  if (/gpt-5/.test(m)) return { inPerM: 1.25, outPerM: 10, approximate: true };
  return { inPerM: 2, outPerM: 8, approximate: true };
}
export function costUsd(provider: ProviderId, modelId: string, inputTokens: number, outputTokens: number): number {
  const p = estimatePricing(provider, modelId);
  return (inputTokens * p.inPerM + outputTokens * p.outPerM) / 1_000_000;
}

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = { anthropic: anthropicAdapter, openai: openaiAdapter };
export function getAdapter(id: string): ProviderAdapter | null { return (ADAPTERS as Record<string, ProviderAdapter>)[id] ?? null; }

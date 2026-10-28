import { classifyModel, sortModels, type ModelInfo, type ProviderError, type ProviderId } from '@portal-ia/domain';
import { isMockProvider, mockAdapter } from './mock.ts';

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
  /**
   * Salida estructurada nativa del proveedor (si la admite): Anthropic fuerza una herramienta con este esquema de entrada;
   * OpenAI usa response_format json_schema estricto. El texto devuelto es el JSON. Si el proveedor rechaza el parámetro
   * (400), se repite UNA vez sin él y el motor valida el JSON igualmente.
   */
  responseSchema?: { name: string; description?: string; schema: Record<string, unknown> };
  /** Plazo de esta llamada (ms). Al agotarse se aborta la petición HTTP (código `timeout`). Por defecto, 10 minutos. */
  timeoutMs?: number;
  /** Hitos confirmados de la llamada (enviada, cabeceras recibidas, cuerpo recibido), para mostrar el estado real. */
  onProgress?: (e: CallProgress) => void;
}
export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  /** El proveedor o el modelo rechazó la petición (señal explícita del proveedor, no deducida del texto). */
  refusal?: string | null;
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

/** Hitos confirmados de una llamada (sin streaming, el proveedor no informa de progreso entre «enviada» y «cabeceras»). */
export type CallProgress = 'sent' | 'headers' | 'body';

/**
 * Petición HTTP con plazo y cancelación reales: el plazo y la señal del llamante abortan la petición en curso (también
 * la lectura del cuerpo). Distingue plazo agotado (`timeout`), cancelación (`cancelled`) y fallo de red (`network`).
 * Abortar no garantiza que el proveedor no facture lo que ya procesó: los mensajes lo dicen.
 */
async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = LIST_TIMEOUT_MS, onProgress?: (e: CallProgress) => void): Promise<any> {
  const ctrl = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); };
  const aborted = () => timedOut
    ? new ProviderRequestError({ code: 'timeout', message: `El proveedor no respondió dentro del plazo de esta llamada (${Math.round(timeoutMs / 1000)} s) y se abortó. La solicitud pudo haberse procesado y facturado parcialmente.` })
    : new ProviderRequestError({ code: 'cancelled', message: 'Llamada cancelada antes de terminar. El proveedor puede haber facturado lo que ya había procesado.' });
  let res: Response;
  try {
    onProgress?.('sent');
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    cleanup();
    if (e?.name === 'AbortError' || ctrl.signal.aborted) throw aborted();
    throw new ProviderRequestError({ code: 'network', message: `No se pudo contactar con el proveedor: ${e?.message ?? 'error de red'}.` });
  }
  onProgress?.('headers');
  if (!res.ok) {
    cleanup();
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
  try { const j = await res.json(); onProgress?.('body'); return j; }
  catch (e: any) {
    if (ctrl.signal.aborted) throw aborted();
    throw new ProviderRequestError({ code: 'network', message: `La respuesta del proveedor llegó incompleta: ${e?.message ?? 'cuerpo no válido'}.` });
  }
  finally { cleanup(); }
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
    const thinking = req.supportsEffort && budget > 0;
    // Forzar una herramienta no es compatible con el razonamiento extendido: con razonamiento, el esquema va solo en el prompt.
    const structured = req.responseSchema && !thinking ? { ...base, tools: [{ name: req.responseSchema.name, description: req.responseSchema.description ?? 'Devuelve el resultado estructurado.', input_schema: req.responseSchema.schema }], tool_choice: { type: 'tool', name: req.responseSchema.name } } : base;
    const withThinking = thinking ? { ...base, thinking: { type: 'enabled', budget_tokens: budget } } : structured;
    let j: any;
    try {
      j = await fetchJson('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(withThinking) }, signal, req.timeoutMs ?? COMPLETE_TIMEOUT_MS, req.onProgress);
    } catch (e) {
      // Si el modelo no acepta el parámetro de razonamiento, reintentamos sin él (una sola vez).
      if (withThinking !== base && e instanceof ProviderRequestError && e.error.httpStatus === 400 && /thinking|budget_tokens|tool/i.test(e.error.message)) {
        j = await fetchJson('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(base) }, signal, req.timeoutMs ?? COMPLETE_TIMEOUT_MS, req.onProgress);
      } else throw e;
    }
    const tool = (j.content ?? []).find((c: any) => c.type === 'tool_use' && c.input && typeof c.input === 'object');
    const text = tool ? JSON.stringify(tool.input) : (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    // stop_reason «refusal»: el modelo se negó por sus políticas (señal explícita de la API).
    return { text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: (j.usage?.output_tokens ?? 0), stopReason: j.stop_reason ?? null, refusal: j.stop_reason === 'refusal' ? (text || 'refusal') : null };
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
    if (req.responseSchema) body.response_format = { type: 'json_schema', json_schema: { name: req.responseSchema.name, schema: req.responseSchema.schema, strict: true } };
    const post = (b: any) => fetchJson('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(b) }, signal, req.timeoutMs ?? COMPLETE_TIMEOUT_MS, req.onProgress);
    let j: any;
    try { j = await post(body); }
    catch (e) {
      // Si el modelo no admite response_format (400), se repite una vez sin él: el motor valida el JSON igualmente.
      if (body.response_format && e instanceof ProviderRequestError && e.error.httpStatus === 400 && /response_format|json_schema|schema/i.test(e.error.message)) { const { response_format: _omit, ...plain } = body; j = await post(plain); }
      else throw e;
    }
    const choice = j.choices?.[0];
    // Negativa explícita: `message.refusal` (salidas estructuradas) o finish_reason «content_filter».
    const refusal = typeof choice?.message?.refusal === 'string' && choice.message.refusal ? choice.message.refusal : choice?.finish_reason === 'content_filter' ? 'content_filter' : null;
    return { text: choice?.message?.content ?? '', inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0, stopReason: choice?.finish_reason ?? null, refusal };
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
/** Con PORTAL_MOCK_PROVIDER=1 (solo pruebas) todas las llamadas van al proveedor simulado: 0 USD, sin red, respuestas de guion. */
export function getAdapter(id: string): ProviderAdapter | null {
  if (isMockProvider()) return mockAdapter;
  return (ADAPTERS as Record<string, ProviderAdapter>)[id] ?? null;
}
export { mockAdapter, isMockProvider, mockCalls, resetMockCalls } from './mock.ts';

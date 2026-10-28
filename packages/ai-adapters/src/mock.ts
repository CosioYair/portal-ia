import fs from 'node:fs';
import { classifyModel } from '@portal-ia/domain';
import { ProviderRequestError, estimateTokens, type CompletionRequest, type CompletionResult, type ProviderAdapter } from './index.ts';

/**
 * Proveedor SIMULADO para pruebas automáticas (0 USD, sin red). Se activa solo con PORTAL_MOCK_PROVIDER=1.
 * Respuestas deterministas definidas en un guion JSON (PORTAL_MOCK_SCRIPT): lista de reglas evaluadas en orden;
 * la primera cuyo `match` (expresión regular sobre "system\n---\nuser") coincide decide la respuesta.
 *   { "rules": [ { "match": "Desarrollador", "text": "=== RESUMEN ===...", "stopReason": "end_turn" }, { "match": "QA", "error": "rate_limited" } ] }
 * Cada llamada se registra en PORTAL_MOCK_LOG (JSONL) con el modelo, el tamaño del prompt y los marcadores encontrados,
 * para que las pruebas puedan afirmar qué recibió cada agente (p. ej. que una lección llegó al prompt) y contar llamadas.
 * Nunca se usa fuera de pruebas: el servidor lo rechaza si PORTAL_MOCK_PROVIDER no está definido.
 */
interface Rule { match: string; text?: string; textFile?: string; stopReason?: string; error?: string; /** Solo responde si el prompt contiene este texto (p. ej. una lección). */ requires?: string; /** Texto alternativo si falta `requires`. */ otherwise?: string;
  /** Tarda este tiempo en responder (respeta el plazo y la cancelación de la llamada, como una petición HTTP real). */ delayMs?: number;
  /** Las primeras N llamadas que encajan fallan con `error` (o `network`); después responde normalmente. */ failTimes?: number;
  /** Señal explícita de negativa del proveedor (como stop_reason «refusal»). */ refusal?: boolean;
  /** No termina nunca e ignora el plazo y la cancelación (adaptador roto o lectura que no se corta): lo cierra el vigilante. */ hang?: boolean;
  /** Respuestas sucesivas: la llamada N que encaja usa responses[N-1] (la última se repite). */
  responses?: { text: string; stopReason?: string; thinkingTokens?: number }[];
  /** Tokens de razonamiento oculto que se facturan además del texto (como en Opus 5.5: cuentan en output_tokens). */
  thinkingTokens?: number;
  /** Continuación realista: el resto de este contenido a partir de la línea que el prompt dice llevar («N líneas completas»). */
  continueFromLines?: string }
interface Script { rules: Rule[]; /** Marcadores a buscar en cada prompt para el registro. */ markers?: string[];
  /** Límite de salida REAL: el texto que no cabe en max_tokens (menos el razonamiento oculto) se corta con stop «max_tokens». */
  enforceMaxTokens?: boolean }

let cachedScript: { path: string; mtime: number; script: Script } | null = null;
function loadScript(): Script {
  const p = process.env.PORTAL_MOCK_SCRIPT;
  if (!p || !fs.existsSync(p)) return { rules: [] };
  const mtime = fs.statSync(p).mtimeMs;
  if (cachedScript && cachedScript.path === p && cachedScript.mtime === mtime) return cachedScript.script;
  const script = JSON.parse(fs.readFileSync(p, 'utf8')) as Script;
  cachedScript = { path: p, mtime, script };
  return script;
}

export let mockCalls = 0;
/** Llamadas por regla (para failTimes). */
const ruleCalls = new Map<string, number>();
export function resetMockCalls() { mockCalls = 0; ruleCalls.clear(); }

/** Espera abortable: plazo de la llamada (`timeout`) o señal del llamante (`cancelled`), igual que fetchJson. */
function wait(ms: number, timeoutMs: number | undefined, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => { clearTimeout(a); clearTimeout(b); signal?.removeEventListener('abort', onAbort); fn(); };
    const onAbort = () => done(() => reject(new ProviderRequestError({ code: 'cancelled', message: 'Llamada cancelada antes de terminar (simulado).' })));
    const a = setTimeout(() => done(resolve), ms);
    const b = setTimeout(() => done(() => reject(new ProviderRequestError({ code: 'timeout', message: `El proveedor no respondió dentro del plazo de esta llamada (${Math.round((timeoutMs ?? 0) / 1000)} s) y se abortó (simulado).` }))), timeoutMs ?? 2 ** 31 - 1);
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const DEFAULT_TEXT = '=== RESUMEN ===\nRespuesta simulada sin regla aplicable.\n=== NOTAS ===\nEl guion de pruebas no define una regla para este prompt.';

export const mockAdapter: ProviderAdapter = {
  id: 'anthropic',
  async listModels() { return ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)); },
  async complete(_apiKey: string, _options, req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    mockCalls++;
    const script = loadScript();
    const hay = `${req.system}\n---\n${(req.history ?? []).map(h => h.content).join('\n')}\n${req.user}`;
    const rule = script.rules.find(r => { try { return new RegExp(r.match, 'is').test(hay); } catch { return false; } });
    const markers = (script.markers ?? []).filter(m => hay.includes(m));
    const log = process.env.PORTAL_MOCK_LOG;
    if (log) fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), model: req.model, chars: hay.length, rule: rule?.match ?? null, markers, images: req.images?.length ?? 0, history: req.history?.length ?? 0, schema: req.responseSchema?.name ?? null }) + '\n');
    req.onProgress?.('sent');
    if (!rule) { req.onProgress?.('headers'); req.onProgress?.('body'); return { text: DEFAULT_TEXT, inputTokens: estimateTokens(hay), outputTokens: estimateTokens(DEFAULT_TEXT), stopReason: 'end_turn' }; }
    const n = (ruleCalls.get(rule.match) ?? 0) + 1; ruleCalls.set(rule.match, n);
    if (rule.hang) { req.onProgress?.('headers'); return new Promise<CompletionResult>(() => { /* nunca */ }); }
    if (rule.delayMs) await wait(rule.delayMs, req.timeoutMs, signal);
    else if (signal?.aborted) throw new ProviderRequestError({ code: 'cancelled', message: 'Llamada cancelada antes de terminar (simulado).' });
    if (rule.failTimes !== undefined ? n <= rule.failTimes : !!rule.error) throw new ProviderRequestError({ code: (rule.error ?? 'network') as any, message: `Error simulado: ${rule.error ?? 'network'} (llamada ${n})`, httpStatus: rule.error === 'provider_error' ? 529 : undefined });
    req.onProgress?.('headers');
    const seq = rule.responses?.length ? rule.responses[Math.min(n, rule.responses.length) - 1] : null;
    let text = seq ? seq.text : rule.textFile ? fs.readFileSync(rule.textFile, 'utf8') : (rule.text ?? '');
    if (rule.continueFromLines !== undefined) { const n = Number(req.user.match(/\((\d+) líneas completas\)/)?.[1] ?? 0); text = rule.continueFromLines.replace(/\r\n/g, '\n').split('\n').slice(n).join('\n').replace(/\n?$/, '\n') + '=== FIN ARCHIVO ===\n'; }
    if (rule.requires && !hay.includes(rule.requires)) text = rule.otherwise ?? text;
    req.onProgress?.('body');
    const thinking = seq?.thinkingTokens ?? rule.thinkingTokens ?? 0;
    // Como un modelo real: el razonamiento oculto y el texto comparten max_tokens; lo que no cabe se corta.
    if (script.enforceMaxTokens) { const room = Math.max(0, req.maxTokens - thinking); if (estimateTokens(text) > room) return { text: text.slice(0, Math.floor(room * 3.5)), inputTokens: estimateTokens(hay), outputTokens: req.maxTokens, stopReason: 'max_tokens', refusal: null }; }
    return { text, inputTokens: estimateTokens(hay), outputTokens: estimateTokens(text) + thinking, stopReason: rule.refusal ? 'refusal' : (seq?.stopReason ?? rule.stopReason ?? 'end_turn'), refusal: rule.refusal ? (text || 'refusal') : null };
  }
};

export const isMockProvider = () => process.env.PORTAL_MOCK_PROVIDER === '1';

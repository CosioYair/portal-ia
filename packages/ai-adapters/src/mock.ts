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
interface Rule { match: string; text?: string; textFile?: string; stopReason?: string; error?: string; /** Solo responde si el prompt contiene este texto (p. ej. una lección). */ requires?: string; /** Texto alternativo si falta `requires`. */ otherwise?: string }
interface Script { rules: Rule[]; /** Marcadores a buscar en cada prompt para el registro. */ markers?: string[] }

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
export function resetMockCalls() { mockCalls = 0; }

const DEFAULT_TEXT = '=== RESUMEN ===\nRespuesta simulada sin regla aplicable.\n=== NOTAS ===\nEl guion de pruebas no define una regla para este prompt.';

export const mockAdapter: ProviderAdapter = {
  id: 'anthropic',
  async listModels() { return ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)); },
  async complete(_apiKey: string, _options, req: CompletionRequest): Promise<CompletionResult> {
    mockCalls++;
    const script = loadScript();
    const hay = `${req.system}\n---\n${(req.history ?? []).map(h => h.content).join('\n')}\n${req.user}`;
    const rule = script.rules.find(r => { try { return new RegExp(r.match, 'is').test(hay); } catch { return false; } });
    const markers = (script.markers ?? []).filter(m => hay.includes(m));
    const log = process.env.PORTAL_MOCK_LOG;
    if (log) fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), model: req.model, chars: hay.length, rule: rule?.match ?? null, markers, images: req.images?.length ?? 0, history: req.history?.length ?? 0, schema: req.responseSchema?.name ?? null }) + '\n');
    if (!rule) return { text: DEFAULT_TEXT, inputTokens: estimateTokens(hay), outputTokens: estimateTokens(DEFAULT_TEXT), stopReason: 'end_turn' };
    if (rule.error) throw new ProviderRequestError({ code: rule.error as any, message: `Error simulado: ${rule.error}` });
    let text = rule.textFile ? fs.readFileSync(rule.textFile, 'utf8') : (rule.text ?? '');
    if (rule.requires && !hay.includes(rule.requires)) text = rule.otherwise ?? text;
    return { text, inputTokens: estimateTokens(hay), outputTokens: estimateTokens(text), stopReason: rule.stopReason ?? 'end_turn' };
  }
};

export const isMockProvider = () => process.env.PORTAL_MOCK_PROVIDER === '1';

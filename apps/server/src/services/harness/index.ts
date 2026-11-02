import { HARNESSES, backendLabel, harnessCompatibility, type Agent, type ExecutionBackend, type ModelInfo, type ProviderId } from '@portal-ia/domain';
import { providersRepo } from '../../db/platform.ts';
import { agentsRepo, workspaceDb } from '../../db/workspace.ts';
import { batchesRepo } from '../../db/batches.ts';
import { agentBackend } from '../claudeCode/backend.ts';
import { lastDetection } from '../claudeCode/detect.ts';
import { getClaudeCodeSettings } from '../claudeCode/settings.ts';
import { getCodexSettings, lastCodexDetection } from './codex.ts';
import { recordAgentEvent } from '../agentEvents.ts';

/**
 * Registro de arneses y cambio de arnés de un agente (docs/arneses.md). Un cambio:
 *  - lo autoriza el propietario explícitamente (también hacia la API, que es facturable);
 *  - solo a un arnés disponible ahora mismo (instalado, con sesión verificada y, en Codex, en modo restringido);
 *  - nunca con una llamada del agente en curso;
 *  - no altera trabajos ya autorizados: encargos y lotes fijaron su arnés al autorizarse y, si ya no coincide, esa
 *    llamada no se hace (se dice por qué). Lo que verá el propietario antes de confirmar está en `harnessOptions`.
 */
export interface HarnessAvailability { id: ExecutionBackend; state: 'ready' | 'needs_console' | 'disabled' | 'not_installed' | 'blocked' | 'not_connected'; available: boolean; reason: string | null; detail: string | null }

export function harnessAvailability(id: ExecutionBackend, provider: ProviderId | null = null): HarnessAvailability {
  if (id === 'claude-code' || id === 'claude-code-terminal') {
    const s = getClaudeCodeSettings(); const d = lastDetection();
    if (!s.enabled) return { id, state: 'disabled', available: false, reason: 'El conector «Claude Code — Local» está desactivado (Proveedores → Claude Code).', detail: null };
    if (id === 'claude-code-terminal') return { id, state: 'needs_console', available: true, reason: 'Solo avanza cuando atiendes las tareas en tu consola de Claude Code.', detail: null };
    if (!d?.installed) return { id, state: 'not_installed', available: false, reason: 'No se encontró la CLI de Claude Code.', detail: null };
    if (d.billing !== 'subscription') return { id, state: 'blocked', available: false, reason: `Claude Code no está verificado con tu suscripción (${backendLabel('claude-code', d.billing)}).`, detail: d.version ?? null };
    return { id, state: 'ready', available: true, reason: null, detail: `Claude Code ${d.version ?? ''} · ${d.subscriptionType ?? 'suscripción'}`.trim() };
  }
  if (id === 'codex') {
    const s = getCodexSettings(); const d = lastCodexDetection();
    if (!d) return { id, state: 'not_installed', available: false, reason: 'Codex aún no se ha comprobado (Proveedores → Codex → Comprobar).', detail: null };
    if (!d.installed) return { id, state: 'not_installed', available: false, reason: d.problems[0] ?? 'No se encontró la CLI de Codex.', detail: null };
    const detail = `Codex ${d.version ?? ''} · ${d.auth === 'chatgpt' ? 'sesión de ChatGPT' : d.auth === 'api_key' ? 'clave de API' : 'sin sesión'}`.trim();
    if (d.billing !== 'subscription') return { id, state: 'blocked', available: false, reason: d.problems[0] ?? 'Codex no tiene una sesión de ChatGPT.', detail };
    if (!d.restricted) return { id, state: 'blocked', available: false, reason: d.problems.find(p => /herramientas/.test(p)) ?? 'Codex no está verificado en modo restringido.', detail };
    if (!s.enabled || !s.authorizedAt) return { id, state: 'disabled', available: false, reason: 'Codex está listo pero no habilitado: habilítalo en Proveedores → Codex.', detail };
    return { id, state: 'ready', available: true, reason: null, detail };
  }
  const connected = (['anthropic', 'openai'] as ProviderId[]).filter(p => providersRepo.get(p)?.status === 'connected' && (!provider || p === provider));
  return connected.length ? { id, state: 'ready', available: true, reason: 'Facturable por uso: cada trabajo necesita presupuesto autorizado.', detail: connected.map(p => p === 'openai' ? 'OpenAI API' : 'Anthropic API').join(' · ') }
    : { id, state: 'not_connected', available: false, reason: 'No hay ningún proveedor de API conectado.', detail: null };
}

/** Modelos que se pueden elegir con cada arnés (los de la API, del catálogo conectado; los de Codex, de su caché local). */
export function harnessModels(id: ExecutionBackend, provider: ProviderId | null): { provider: ProviderId; models: { id: string; name: string }[] }[] {
  const catalog = (p: ProviderId) => { try { return (JSON.parse(providersRepo.get(p)?.models_json ?? '[]') as ModelInfo[]).map(m => ({ id: m.id, name: m.name })); } catch { return []; } };
  if (id === 'codex') return [{ provider: 'openai', models: [{ id: 'default', name: 'Predeterminado de Codex' }, ...(lastCodexDetection()?.models ?? [])] }];
  if (id === 'claude-code' || id === 'claude-code-terminal') return [{ provider: 'anthropic', models: catalog('anthropic') }];
  return (['anthropic', 'openai'] as ProviderId[]).filter(p => providersRepo.get(p)?.status === 'connected' && (!provider || p === provider)).map(p => ({ provider: p, models: catalog(p) }));
}

/** Trabajo en marcha o autorizado con este agente: lo que NO cambia con el arnés (y por qué). */
export function affectedWork(slug: string, agentId: string) {
  const db = workspaceDb(slug);
  const running = (db.prepare(`SELECT DISTINCT p.id, p.title, p.status, s.status AS step FROM process_steps s JOIN processes p ON p.id = s.process_id
    WHERE s.agent_id = ? AND p.status IN ('running', 'pending_authorization') AND p.archived_at IS NULL`).all(agentId) as any[]);
  const inFlight = running.filter(r => r.step === 'running').map(r => ({ id: r.id, title: r.title }));
  const open = Array.from(new Map(running.map(r => [r.id, { id: r.id, title: r.title, status: r.status as string }])).values());
  const batches = batchesRepo(slug).list().filter(b => b.status === 'running' || b.status === 'paused').map(b => ({ id: b.id, title: b.title, status: b.status, sources: b.auth.backends }));
  return { inFlight, open, batches };
}

/** Etiqueta del arnés de un agente con la facturación DETECTADA (sin llamar a nada): «Claude Code — Suscripción», etc. */
export function harnessLabelFor(a: Agent): string {
  const b = agentBackend(a);
  return backendLabel(b, b === 'codex' ? (lastCodexDetection()?.billing as any ?? null) : b === 'api' ? null : lastDetection()?.billing ?? null, a.config.provider);
}

export function harnessCatalog() {
  return HARNESSES.map(h => ({ ...h, availability: harnessAvailability(h.id), models: harnessModels(h.id, null) }));
}

export function harnessOptions(slug: string, agent: Agent) {
  const current = agentBackend(agent);
  const work = affectedWork(slug, agent.id);
  return {
    current, currentLabel: harnessLabelFor(agent), model: agent.config.model, provider: agent.config.provider,
    work,
    continuity: 'Cada ejecución empieza de cero: el Portal le pasa a cualquier arnés la identidad, las instrucciones, las habilidades y la memoria verificada del agente. No hay una sesión que continuar.',
    pinned: 'Los encargos y lotes ya autorizados conservan el arnés con el que los autorizaste: si este cambia, sus siguientes llamadas con este agente no se hacen (se dice por qué) y nada cambia en silencio.',
    options: HARNESSES.filter(h => h.id !== 'api' || true).map(h => {
      const availability = harnessAvailability(h.id);
      return { id: h.id, name: h.name, vendor: h.vendor, billing: h.id === 'api' ? 'api' as const : h.billing, summary: h.summary, availability, models: harnessModels(h.id, null), compatibility: harnessCompatibility(agent.config, current, h.id), current: h.id === current };
    })
  };
}

export function switchHarness(slug: string, agentId: string, input: { harness: ExecutionBackend; model: string; provider?: ProviderId | null; authorized: boolean }): Agent {
  const agents = agentsRepo(slug); const a = agents.get(agentId);
  if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
  if (!input.authorized) throw Object.assign(new Error('Cambiar el arnés de un agente requiere tu autorización explícita.'), { statusCode: 403 });
  const from = agentBackend(a);
  const work = affectedWork(slug, agentId);
  if (work.inFlight.length) throw Object.assign(new Error(`«${a.config.name}» tiene una llamada en curso («${work.inFlight[0].title}»): espera a que termine o cancélala antes de cambiar su arnés.`), { statusCode: 409 });
  const provider: ProviderId = input.harness === 'codex' ? 'openai' : input.harness === 'api' ? (input.provider ?? a.config.provider) : 'anthropic';
  const av = harnessAvailability(input.harness, input.harness === 'api' ? provider : null);
  if (!av.available) throw Object.assign(new Error(av.reason ?? 'Ese arnés no está disponible.'), { statusCode: 409 });
  const models = harnessModels(input.harness, provider).find(m => m.provider === provider)?.models ?? [];
  const model = input.model.trim();
  if (!model || (models.length && !models.some(m => m.id === model))) throw Object.assign(new Error(`El modelo «${model}» no está disponible con ${av.id === 'codex' ? 'Codex' : av.id === 'api' ? 'la API' : 'Claude Code'}.`), { statusCode: 400 });
  const cfg = { ...a.config, backend: input.harness, provider, model, fallbacks: input.harness === a.config.backend && provider === a.config.provider ? a.config.fallbacks.filter(f => f !== model) : [] };
  const updated = agents.updateConfig(agentId, cfg);
  recordAgentEvent(slug, agentId, 'harness_changed', { from, to: input.harness, fromModel: a.config.model, toModel: model, provider, openWork: work.open.length, batches: work.batches.map(b => b.id) });
  return updated;
}

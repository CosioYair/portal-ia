import { INTERNAL_WORKSPACE, type Agent, type ModelInfo, type ProviderId } from '@portal-ia/domain';
import { providersRepo, settingsRepo } from '../db/platform.ts';

/**
 * EN-028 · Regla de modelo de Portal IA. Es un DATO de platform.sqlite (settingsRepo, clave «modelRule:<slug>»), nunca
 * código ni plantillas: no viaja en la Edición ni en las carpetas exportadas. Solo existe para la empresa interna.
 * Se aplica a los agentes Anthropic (Claude Code, consola o API de Anthropic) desde la siguiente llamada; a Codex o a
 * otros proveedores no se les aplica y se dice por qué. Nunca se usa otro modelo en silencio.
 */
export interface ModelRule { model: string; active: boolean; confirmedBy: string | null; confirmedAt: string | null }
export interface ModelRuleStatus { applies: boolean; reason: string; model: string | null }

export class ModelRuleError extends Error {
  statusCode = 400;
  error: { code: 'model_rule'; message: string };
  constructor(message: string) { super(message); this.name = 'ModelRuleError'; this.error = { code: 'model_rule', message }; }
}

/** Única empresa con regla de modelo: la interna (portal-ia). */
export const MODEL_RULE_SLUG = INTERNAL_WORKSPACE.slug;
const key = (slug: string) => `modelRule:${slug}`;

/** Modelos del catálogo conectado de Anthropic (los mismos que ofrece harnessModels para Claude Code). */
export function anthropicModels(): { id: string; name: string }[] {
  try { return (JSON.parse(providersRepo.get('anthropic' as ProviderId)?.models_json ?? '[]') as ModelInfo[]).map(m => ({ id: m.id, name: m.name })); }
  catch { return []; }
}

/** ¿El id es válido? Vacío nunca. Si hay catálogo de Anthropic, tiene que estar en él (igual que al cambiar de arnés). */
export function validateRuleModel(model: string): string {
  const id = model.trim();
  if (!id) throw new ModelRuleError('La regla de modelo de Portal IA necesita un id de modelo.');
  const cat = anthropicModels();
  if (cat.length && !cat.some(m => m.id === id)) {
    throw new ModelRuleError(`El modelo «${id}» de la regla de Portal IA no está en la lista de modelos de Anthropic. No se ha hecho la llamada ni se ha usado otro modelo en su lugar: elige un modelo de la lista en Ajustes → Regla de modelo de Portal IA.`);
  }
  return id;
}

export function getModelRule(slug: string): ModelRule | null {
  if (slug !== MODEL_RULE_SLUG) return null;
  const raw = settingsRepo.get(key(slug)); if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<ModelRule>;
    if (typeof r.model !== 'string') return null;
    return { model: r.model, active: r.active === true, confirmedBy: r.confirmedBy ?? null, confirmedAt: r.confirmedAt ?? null };
  } catch { return null; }
}

/** Guarda la regla. Exige la confirmación explícita del propietario y solo admite la empresa portal-ia. */
export function setModelRule(slug: string, input: { model: string; active: boolean; confirmed: boolean; by?: string | null }): ModelRule {
  if (slug !== MODEL_RULE_SLUG) throw Object.assign(new Error('La regla de modelo solo existe para la empresa Portal IA.'), { statusCode: 400 });
  if (input.confirmed !== true) throw Object.assign(new Error('Activar o cambiar la regla de modelo requiere tu confirmación explícita.'), { statusCode: 400 });
  const model = validateRuleModel(input.model);
  const rule: ModelRule = { model, active: input.active === true, confirmedBy: input.by ?? 'propietario', confirmedAt: new Date().toISOString() };
  settingsRepo.set(key(slug), JSON.stringify(rule));
  return rule;
}

/** ¿Se aplica la regla a este agente? Con el motivo exacto en cada caso (sin efectos ni IA). */
export function ruleApplies(slug: string, agent: Agent): ModelRuleStatus {
  if (slug !== MODEL_RULE_SLUG) return { applies: false, reason: 'La regla de modelo solo se aplica a los agentes de Portal IA.', model: null };
  const rule = getModelRule(slug);
  if (!rule || !rule.active) return { applies: false, reason: 'La regla de modelo de Portal IA no está activa.', model: rule?.model ?? null };
  const backend = agent.config.backend ?? 'api';
  if (backend === 'codex') return { applies: false, reason: 'La regla de modelo de Portal IA no se aplica a este agente: usa Codex (ChatGPT), no un modelo de Anthropic. Su modelo no cambia.', model: rule.model };
  if (agent.config.provider !== 'anthropic') return { applies: false, reason: `La regla de modelo de Portal IA no se aplica a este agente: usa el proveedor ${agent.config.provider === 'openai' ? 'OpenAI' : agent.config.provider}, no Anthropic. Su modelo no cambia.`, model: rule.model };
  return { applies: true, reason: `Se aplica la regla de modelo de Portal IA: cada llamada usa «${rule.model}».`, model: rule.model };
}

/** Modelo que se usa de verdad: el de la regla si se aplica (validado; si no es válido, error claro), o el pedido. */
export function effectiveModel(slug: string, agent: Agent, requested: string): string {
  const st = ruleApplies(slug, agent);
  if (!st.applies || !st.model) return requested;
  return validateRuleModel(st.model);
}

/**
 * Modelo con el que se calcula el COSTE de una llamada: el que se usó de verdad (el de la regla si se aplica) o el pedido.
 * No valida ni lanza: sirve también en el manejo de errores sin tapar el fallo original.
 */
export function costModel(slug: string, agent: Agent, requested: string): string {
  const st = ruleApplies(slug, agent);
  return st.applies && st.model && st.model.trim() ? st.model.trim() : requested;
}

/** Modelo con el que se crean los agentes nuevos de la empresa (null = sin regla: lo de siempre). */
export function ruleModelFor(slug: string, provider: ProviderId): string | null {
  if (slug !== MODEL_RULE_SLUG || provider !== 'anthropic') return null;
  const rule = getModelRule(slug);
  return rule && rule.active && rule.model.trim() ? rule.model.trim() : null;
}

/** ¿El fallo de Claude Code es un rechazo del modelo? (texto de la CLI: «model … not found / invalid / issue with…»). */
export function isModelRejection(text: string): boolean {
  return /model/i.test(text) && /(not found|invalid|not exist|does not exist|unknown|not available|not supported|issue with the selected model|no disponible|no existe)/i.test(text);
}

/** Convierte el rechazo del modelo de la regla en un error claro, sin reintentar con otro modelo. */
export function explainModelRejection(e: any, model: string): any {
  const detail = String(e?.error?.message ?? e?.message ?? e);
  if (!isModelRejection(detail)) return e;
  const msg = `Claude Code rechazó el modelo «${model}» de la regla de Portal IA (${detail.slice(0, 300)}). No se ha usado otro modelo en su lugar: revisa la regla en Ajustes.`;
  try { if (e && typeof e === 'object') { e.message = msg; if (e.error && typeof e.error === 'object') e.error.message = msg; return e; } } catch { /* error inmutable */ }
  return new ModelRuleError(msg);
}

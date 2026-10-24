import type { ModelInfo, ModelTier, ProviderId } from './types.ts';

/**
 * Heurísticas para clasificar los modelos que devuelve cada proveedor.
 * El listado real viene de la API (HU-001); aquí solo se deriva tier, soporte de esfuerzo y costo relativo.
 * Son heurísticas documentadas: si el proveedor publica metadatos, deben sustituirlas.
 */
export function classifyModel(provider: ProviderId, id: string, displayName?: string): ModelInfo {
  const lower = id.toLowerCase();
  let tier: ModelTier = 'mid';
  let supportsEffort = false;
  if (provider === 'anthropic') {
    if (lower.includes('opus')) tier = 'top';
    else if (lower.includes('haiku')) tier = 'low';
    else tier = 'mid';
    // Esfuerzo/razonamiento extendido: Claude 3.7 y cualquier familia 4.x o superior (4, 4.1, 4.5, 5, 5.5, …).
    const base = lower.replace(/-\d{8}$/, '');
    const major = Number((base.match(/-(\d+)(?:-\d+)?$/) ?? [])[1] ?? 0);
    supportsEffort = /claude-3-7/.test(lower) || major >= 4;
  } else {
    if (/^(o1|o3|o4)/.test(lower) || /gpt-5(?!.*(mini|nano))/.test(lower)) tier = 'top';
    else if (/mini|nano/.test(lower)) tier = 'low';
    else tier = 'mid';
    supportsEffort = /^(o1|o3|o4)/.test(lower) || /gpt-5/.test(lower);
  }
  const relativeCost: 1 | 2 | 3 = tier === 'top' ? 3 : tier === 'mid' ? 2 : 1;
  const name = displayName || prettyName(id);
  return {
    id, name, short: shortName(provider, name), tier, supportsEffort, relativeCost,
    description: tier === 'top' ? 'Máxima capacidad de razonamiento. Mayor costo por token.'
      : tier === 'mid' ? 'Equilibrio entre capacidad y costo.'
      : 'Rápido y económico para tareas acotadas.'
  };
}

function prettyName(id: string): string {
  return id
    .replace(/-\d{8}$/, '')                 // sufijo de fecha (claude-sonnet-4-5-20250929)
    .replace(/-(\d+)-(\d+)(?=-|$)/g, '-$1.$2') // 4-5 → 4.5
    .replace(/-/g, ' ')
    .replace(/\b[a-z]/g, c => c.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT');
}
function shortName(provider: ProviderId, name: string): string {
  return provider === 'anthropic' ? name.replace(/^Claude\s+/i, '') : name;
}

/** Ordena: top → mid → low, y dentro de cada tier alfabético inverso (versiones más nuevas primero, heurístico). */
export function sortModels(models: ModelInfo[]): ModelInfo[] {
  const rank: Record<ModelTier, number> = { top: 0, mid: 1, low: 2 };
  return [...models].sort((a, b) => rank[a.tier] - rank[b.tier] || b.id.localeCompare(a.id));
}

/** Elige el modelo del tier pedido dentro de una lista; si no hay, el más cercano. */
export function pickByTier(models: ModelInfo[], tier: ModelTier): ModelInfo | null {
  if (!models.length) return null;
  const order: ModelTier[] = tier === 'top' ? ['top', 'mid', 'low'] : tier === 'mid' ? ['mid', 'top', 'low'] : ['low', 'mid', 'top'];
  for (const t of order) { const m = sortModels(models).find(x => x.tier === t); if (m) return m; }
  return models[0];
}

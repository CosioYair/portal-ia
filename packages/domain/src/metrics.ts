/**
 * Telemetría de las llamadas de los agentes (rendimiento medible). Cada llamada al modelo deja una fila: quién, qué
 * operación, por qué origen (API o Claude Code), cuánto tardó el modelo frente a lo que tardó el Portal en prepararla,
 * tokens (incluida la parte leída de caché), turnos y herramientas usadas, tamaño y origen del contexto, y una huella
 * del encargo para detectar llamadas repetidas. Sin prompts ni respuestas: solo medidas.
 */
export interface CallMetric {
  id: string;
  processId: string | null;
  stepId: string | null;
  agentId: string | null;
  role: string | null;
  operation: string | null;
  backend: string | null;
  model: string | null;
  attempt: number;
  status: 'done' | 'failed';
  startedAt: string;
  finishedAt: string;
  /** Espera al modelo (envío → respuesta completa) del último intento. */
  waitMs: number;
  /** Tiempo del Portal dentro del paso antes de enviar (lecciones, presupuesto, política, cola). */
  buildMs: number;
  systemChars: number;
  promptChars: number;
  /** Orígenes del contexto entregado y su tamaño (lo que de verdad recibió el agente). */
  context: { source: string; chars: number }[];
  tokensIn: number;
  tokensOut: number;
  /** Parte de la entrada leída de la caché del proveedor (Claude Code informa por separado). */
  cacheReadTokens: number | null;
  turns: number | null;
  /** Herramientas usadas por Claude Code (lecturas del repositorio por el puente, etc.). */
  tools: Record<string, number> | null;
  /** Huella de system+prompt: dos llamadas con la misma huella en el mismo proceso repiten trabajo. */
  promptHash: string;
  errorClass: string | null;
}

/** Estadística de una serie: p50/p95 solo con muestras suficientes (p95 con 10 o más). */
export interface SeriesStat { n: number; p50: number | null; p95: number | null; total: number }

export function seriesStat(values: (number | null | undefined)[]): SeriesStat {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  const at = (q: number) => (v.length ? v[Math.min(v.length - 1, Math.round(q * (v.length - 1)))] : null);
  return { n: v.length, p50: at(0.5), p95: v.length >= 10 ? at(0.95) : null, total: v.reduce((a, b) => a + b, 0) };
}

export interface CallMetricsSummary {
  since: string | null;
  calls: number;
  failed: number;
  byRole: Record<string, { calls: number; failed: number; waitMs: SeriesStat; buildMs: SeriesStat; tokensIn: SeriesStat; tokensOut: SeriesStat; cacheShare: number | null; turns: SeriesStat; toolCalls: number; promptChars: SeriesStat }>;
  byBackend: Record<string, { calls: number; waitMs: SeriesStat; tokensIn: SeriesStat }>;
  /** Modelo frente a Portal: suma de esperas al modelo y de preparación del Portal. */
  split: { modelMs: number; portalMs: number };
  /** Llamadas con la misma huella dentro de un proceso (trabajo repetido). */
  duplicates: { processId: string | null; promptHash: string; count: number; role: string | null; operation: string | null }[];
  failures: Record<string, number>;
  /** Lecturas del repositorio por herramientas (Claude Code) y cuántas llamadas las usaron. */
  repoReads: { total: number; callsWithReads: number };
}

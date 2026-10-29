/**
 * Lo que la interfaz sabe del servidor, separado de lo que supone: hora del servidor (cabecera `x-server-time` de cada
 * respuesta de la API), cuándo respondió por última vez y si la última petición falló. Con esto los contadores miden con
 * el reloj del servidor (no con el del navegador) y la pantalla avisa cuando lo que muestra puede estar desactualizado.
 * Las funciones puras se prueban sin navegador (apps/server/test/live-status.test.ts).
 */

/** Desfase servidor − navegador a partir de una respuesta: se toma el punto medio de la petición. */
export function computeOffset(serverMs: number, sentAtMs: number, receivedAtMs: number): number {
  return serverMs - (sentAtMs + receivedAtMs) / 2;
}

export type Freshness = { kind: 'fresh' | 'stale' | 'offline'; sinceOkMs: number | null; error: string | null };
/** Datos «frescos» si el servidor respondió hace poco; «sin conexión» si la última petición falló; «desactualizados» si no hay respuesta reciente. */
export function freshness(lastOkAt: number | null, lastFailAt: number | null, error: string | null, now: number, staleAfterMs = 10_000): Freshness {
  const sinceOkMs = lastOkAt === null ? null : Math.max(0, now - lastOkAt);
  if (lastFailAt !== null && (lastOkAt === null || lastFailAt > lastOkAt)) return { kind: 'offline', sinceOkMs, error };
  if (sinceOkMs === null || sinceOkMs > staleAfterMs) return { kind: 'stale', sinceOkMs, error: null };
  return { kind: 'fresh', sinceOkMs, error: null };
}

export interface CallTiming {
  /** Desde que se preparó la llamada (inicio de esta llamada del paso). */
  sinceStartMs: number;
  /** Desde el último hecho confirmado por el proveedor (envío, cabeceras, cuerpo). */
  sinceLastEventMs: number;
  /** Hasta el plazo (negativo: superado). */
  untilDeadlineMs: number;
  overdue: boolean;
}
/** Tiempos de una llamada en curso medidos con la hora del SERVIDOR (`serverNowMs`). */
export function callTiming(live: { startedAt: string; lastEventAt: string; deadlineAt: string }, serverNowMs: number): CallTiming {
  const untilDeadlineMs = Date.parse(live.deadlineAt) - serverNowMs;
  return { sinceStartMs: Math.max(0, serverNowMs - Date.parse(live.startedAt)), sinceLastEventMs: Math.max(0, serverNowMs - Date.parse(live.lastEventAt)), untilDeadlineMs, overdue: untilDeadlineMs < 0 };
}

/** Duración de un paso: en curso, hasta ahora (un final de una llamada anterior no cuenta); terminado, hasta su final. */
export function stepDurationMs(s: { status: string; startedAt: string | null; finishedAt: string | null }, serverNowMs: number): number | null {
  if (!s.startedAt) return null;
  const end = s.status === 'running' || !s.finishedAt ? serverNowMs : Date.parse(s.finishedAt);
  return Math.max(0, end - Date.parse(s.startedAt));
}

// ---------------------------------------------------------------- Estado global (lo alimenta lib/api.ts)

let offsetMs = 0; let lastOkAt: number | null = null; let lastFailAt: number | null = null; let lastError: string | null = null;
export function noteResponse(serverTimeHeader: string | null, sentAtMs: number, receivedAtMs: number) {
  const t = Number(serverTimeHeader);
  if (serverTimeHeader && Number.isFinite(t)) offsetMs = computeOffset(t, sentAtMs, receivedAtMs);
  lastOkAt = receivedAtMs; lastError = null;
}
export function noteFailure(message: string, at = Date.now()) { lastFailAt = at; lastError = message; }

// ---------------------------------------------------------------- Versión de la interfaz

/** Script principal con el que se cargó ESTA pestaña (null en desarrollo). */
const doc = (globalThis as any).document as { querySelectorAll(sel: string): ArrayLike<{ src: string }> } | undefined;
const loadedBundle: string | null = doc ? (Array.from(doc.querySelectorAll('script[type="module"][src]')).map(s => s.src.match(/\/assets\/(index-[\w-]+\.js)/)?.[1]).find(Boolean) ?? null) : null;
let servedBundle: string | null = null;
const bundleListeners = new Set<() => void>();
/** El servidor dice qué paquete sirve ahora; si cambió desde que se abrió la pestaña, la interfaz está desactualizada. */
export function noteBundle(header: string | null) { if (header && header !== servedBundle) { servedBundle = header; bundleListeners.forEach(f => f()); } }
export const staleInterface = () => !!loadedBundle && !!servedBundle && loadedBundle !== servedBundle;
export const onBundleChange = (f: () => void) => { bundleListeners.add(f); return () => { bundleListeners.delete(f); }; };
/** Hora del servidor estimada ahora mismo. */
export const serverNow = () => Date.now() + offsetMs;
export const clockOffsetMs = () => offsetMs;
export const connection = (now = Date.now()) => freshness(lastOkAt, lastFailAt, lastError, now);

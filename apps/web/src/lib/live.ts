import { useEffect, useRef, useState } from 'react';
import { noteFailure, noteResponse } from './liveStatus.ts';

/**
 * Tiempo real en la interfaz: UNA conexión (Server-Sent Events, /api/events) por pestaña visible. El servidor solo dice
 * QUÉ cambió (espacio, entidad, id); cada pantalla vuelve a pedir lo que muestra por las rutas de siempre, así que el
 * servidor sigue siendo la única fuente de verdad. Sin conexión, se consulta cada 15 s como respaldo.
 * - Al volver a conectar tras una caída o un reinicio del servidor (otra «época»), todas las pantallas vuelven a pedir.
 * - Cada suscripción agrupa los avisos (como mucho una petición cada `minMs`, con la última siempre garantizada).
 * - Una pestaña oculta más de 30 s cierra su conexión (no ocupa una de las 6 que el navegador permite por servidor) y al
 *   volver a verse se reconecta y vuelve a pedir todo.
 * - Los latidos llevan la hora del servidor: la pantalla sabe que está al día aunque no haga peticiones.
 */
export interface LiveChange { ws: string | null; entity: 'process' | 'backlog' | 'batch' | 'assignment' | 'assistant' | 'system' | 'knowledge' | 'agent' | 'story' | 'usage' | 'department' | 'agent_chat'; id: string | null; projectId?: string | null; itemId?: string | null; kind?: 'state' | 'progress' }
type Sub = { match: (c: LiveChange) => boolean; fire: (resync: boolean) => void };

const subs = new Set<Sub>();
let es: EventSource | null = null; let epoch: string | null = null;
let state: 'connecting' | 'open' | 'down' = 'connecting'; let downSince: number | null = null;
const stateListeners = new Set<() => void>();
let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
const setState = (s: typeof state) => { if (state === s) return; state = s; downSince = s === 'open' ? null : downSince ?? Date.now(); stateListeners.forEach(f => f()); };
const fireAll = (resync: boolean) => subs.forEach(s => s.fire(resync));
// Una conexión puede quedarse muda sin error (red que se cae, proxy, equipo que despierta): si pasan 2,5 latidos sin
// noticias se da por muerta y se reconecta (al volver, se vuelve a pedir todo).
let pingMs = 15_000; let lastBeat = Date.now();
const beat = () => { lastBeat = Date.now(); };

function connect() {
  if (es || typeof EventSource === 'undefined') return;
  if (state !== 'down') setState('connecting'); lastBeat = Date.now();
  const sentAt = Date.now();
  es = new EventSource('/api/events');
  es.addEventListener('hello', (e: MessageEvent) => {
    const d = JSON.parse(e.data); noteResponse(String(d.serverTime), sentAt, Date.now()); beat(); if (Number(d.pingMs) > 0) pingMs = Number(d.pingMs);
    // Primera conexión de la pestaña: nada que recuperar. Otra época (el servidor se reinició) o reconexión: todo de nuevo.
    const again = epoch !== null; epoch = d.epoch; setState('open');
    if (again) fireAll(true);
  });
  es.addEventListener('resync', () => { beat(); fireAll(true); });
  es.addEventListener('ping', (e: MessageEvent) => { beat(); const d = JSON.parse(e.data); noteResponse(String(d.serverTime), Date.now(), Date.now()); });
  es.onmessage = (e: MessageEvent) => {
    beat(); let m: { changes: LiveChange[] }; try { m = JSON.parse(e.data); } catch { return; }
    noteResponse(null, Date.now(), Date.now());
    for (const s of subs) if (m.changes.some(c => { try { return s.match(c); } catch { return false; } })) s.fire(false);
  };
  es.onerror = () => {
    // EventSource reintenta solo (con Last-Event-ID); si el servidor está caído, se marca y se consulta como respaldo.
    if (es?.readyState === EventSource.CLOSED) { es = null; setTimeout(() => { if (!document.hidden) connect(); }, 3000); }
    setState('down'); noteFailure('Sin conexión en tiempo real con el servidor del Portal');
  };
}
function disconnect() { es?.close(); es = null; setState('connecting'); }

let started = false;
function start() {
  if (started || typeof document === 'undefined') return; started = true;
  connect();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenTimer = setTimeout(disconnect, 30_000); return; }
    if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; }
    if (!es) { connect(); fireAll(true); }
  });
  // Conexión muda: se cierra y se vuelve a abrir (sin esperar a un error que puede no llegar nunca).
  setInterval(() => {
    if (!es || document.hidden || Date.now() - lastBeat < pingMs * 2.5) return;
    es.close(); es = null; setState('down'); noteFailure('Sin noticias del servidor del Portal: se reconecta');
    setTimeout(() => { if (!document.hidden) connect(); }, 1000);
  }, 1000);
  // Respaldo: sin conexión más de 10 s, cada pantalla vuelve a pedir lo suyo cada 15 s (nunca más a menudo).
  setInterval(() => { if (state !== 'open' && downSince !== null && Date.now() - downSince > 10_000 && !document.hidden) fireAll(true); }, 15_000);
}

/** Estado de la conexión en tiempo real (para avisar si lo que se ve puede no estar al día). */
export function useLiveConnection(): 'connecting' | 'open' | 'down' {
  const [, force] = useState(0);
  useEffect(() => { start(); const f = () => force(x => x + 1); stateListeners.add(f); return () => { stateListeners.delete(f); }; }, []);
  return state;
}

/**
 * Vuelve a pedir lo que muestra la pantalla cuando cambia algo que le importa (`match`), como mucho una vez cada `minMs`
 * (la última siempre se hace). `refetch` debe leer del servidor; nunca recibe datos del aviso.
 */
export function useLive(match: (c: LiveChange) => boolean, refetch: () => unknown, opts: { minMs?: number; enabled?: boolean } = {}) {
  const ref = useRef({ match, refetch }); ref.current = { match, refetch };
  const minMs = opts.minMs ?? 800; const enabled = opts.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    start();
    let last = 0; let timer: ReturnType<typeof setTimeout> | null = null;
    // Una lectura que falla (servidor caído) no rompe la pantalla: se reintenta con el siguiente aviso o el respaldo.
    const run = () => { timer = null; last = Date.now(); try { const r = ref.current.refetch() as unknown; if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => undefined); } catch { /* la pantalla decide */ } };
    const sub: Sub = {
      match: c => ref.current.match(c),
      fire: () => { if (timer) return; const wait = Math.max(0, last + minMs - Date.now()); timer = setTimeout(run, Math.max(wait, 120)); }
    };
    subs.add(sub);
    return () => { subs.delete(sub); if (timer) clearTimeout(timer); };
  }, [minMs, enabled]);
}

/**
 * Respuestas fuera de orden: solo se aplica la de la petición más reciente (una respuesta lenta y antigua nunca pisa a
 * una más nueva, ni la de una acción del propietario).
 */
export function useLatest() {
  const seq = useRef(0);
  return {
    /** Ejecuta la lectura y devuelve su resultado, o `undefined` si mientras tanto empezó otra más reciente. */
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> { const n = ++seq.current; const r = await fn(); return n === seq.current ? r : undefined; },
    /** Una acción del propietario fija el estado: invalida las lecturas que estuvieran en vuelo. */
    bump() { seq.current++; }
  };
}

/** Pruebas: estado interno. */
export const liveDebug = () => ({ state, epoch, subscribers: subs.size, connected: !!es });

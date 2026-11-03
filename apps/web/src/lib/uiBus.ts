import { useEffect, useSyncExternalStore } from 'react';

/**
 * Portal IA 2.0 · comunicación mínima entre la estructura (menú y barra superior, en cada pantalla) y las piezas que
 * viven una sola vez en la aplicación (búsqueda Ctrl+K, panel del Asistente, contador de Decisiones).
 * - `openUi('palette' | 'assistant')`: abrir; solo abre o navega, nunca ejecuta una acción.
 * - `attention`: cifras de «lo que te espera» por empresa (las calcula App; las leen menú, barra y Decisiones).
 */
type UiEvent = 'palette' | 'assistant';
const listeners = new Map<UiEvent, Set<() => void>>();
export function openUi(e: UiEvent) { for (const f of listeners.get(e) ?? []) f(); }
export function useUiEvent(e: UiEvent, f: () => void) {
  useEffect(() => { const s = listeners.get(e) ?? new Set(); s.add(f); listeners.set(e, s); return () => { s.delete(f); }; }, [e, f]);
}

/**
 * Lo que espera al propietario: decisiones de procesos y peticiones de agentes de la empresa elegida, y propuestas del
 * Asistente (global: vive en la empresa interna y cada propuesta dice a qué empresa va).
 */
export interface Attention { slug: string; decisions: number; agentItems: number; assistant: number; known: boolean }
let attention: Attention = { slug: '', decisions: 0, agentItems: 0, assistant: 0, known: false };
const subs = new Set<() => void>();
const notify = () => { for (const f of subs) f(); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const snapshot = () => attention;
export function setAttention(next: Partial<Omit<Attention, 'assistant'>> & { slug: string }) {
  // Las cifras de otra empresa nunca se mezclan: al cambiar de empresa se empieza de cero (salvo las del Asistente, globales).
  const base = attention.slug === next.slug ? attention : { slug: next.slug, decisions: 0, agentItems: 0, assistant: attention.assistant, known: false };
  attention = { ...base, ...next }; notify();
}
/** Propuestas del Asistente pendientes de tu autorización (las publica su conversación abierta, en el panel o a pantalla completa). */
export function setAssistantPending(n: number) { if (attention.assistant === n) return; attention = { ...attention, assistant: n }; notify(); }
export function useAttention(slug: string | null | undefined): Attention {
  const a = useSyncExternalStore(subscribe, snapshot);
  return a.slug === slug ? a : { slug: slug ?? '', decisions: 0, agentItems: 0, assistant: a.assistant, known: false };
}
export const attentionTotal = (a: Attention) => a.decisions + a.agentItems + a.assistant;

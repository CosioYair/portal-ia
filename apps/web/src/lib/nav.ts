import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';

/**
 * Navegación con contexto, POR PESTAÑA (sessionStorage: cada pestaña tiene su propio historial y no pisa a las demás).
 * - «Atrás» global: vuelve a la pantalla anterior DEL PORTAL en esta pestaña (el historial del navegador, así que
 *   Atrás/Adelante del navegador y este botón son lo mismo). Si se entró por un enlace directo y no hay pantalla anterior
 *   del Portal, va a la pantalla «madre» (historia → Backlog, proceso → Actividad…): nunca sale del Portal.
 * - Estado de cada entrada del historial (filtros, búsqueda, paneles abiertos, selección): `useEntryState`. Volver con
 *   Atrás lo recupera tal cual; una visita nueva a la pantalla empieza limpia. Nunca se guardan autorizaciones ni secretos.
 * - Título legible de cada entrada (p. ej. «HU-175»): el botón dice a dónde vuelve.
 */
const PREFIX = 'portal-ia.entrada.';
const TITLES = 'portal-ia.entrada.titulos';
const MAX_ENTRIES = 300;

function readJson<T>(k: string, fallback: T): T { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } }
function writeJson(k: string, v: unknown) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento: solo se pierde la comodidad */ } }

/** Clave de la entrada actual del historial (la que react-router guarda en history.state). */
export function entryKey(): string { try { return ((globalThis as any).history?.state as { key?: string } | null)?.key ?? 'default'; } catch { return 'default'; } }
const entryIdx = (): number => { try { return Number(((globalThis as any).history?.state as { idx?: number } | null)?.idx ?? 0); } catch { return 0; } };

/** Registro de entradas (por pestaña): clave → ruta, título e índice; se conservan las últimas 300. */
type Entry = { path: string; title: string | null; idx: number; prev: string | null };
const CURRENT = 'portal-ia.entrada.actual';
function entries(): Record<string, Entry> { return readJson<Record<string, Entry>>(TITLES, {}); }
function saveEntry(key: string, e: Entry) {
  const all = entries(); all[key] = e;
  const keys = Object.keys(all); for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) { delete all[k]; try { for (const s of Object.keys(sessionStorage)) if (s.startsWith(`${PREFIX}${k}.`)) sessionStorage.removeItem(s); } catch { /* nada */ } }
  writeJson(TITLES, all);
}

/** Registra la entrada actual (lo llama la aplicación en cada cambio de ruta). */
export function useEntryRecorder() {
  const { pathname, search, hash, key } = useLocation(); const type = useNavigationType();
  useEffect(() => {
    const all = entries(); const existing = all[key]; const last = readJson<string | null>(CURRENT, null);
    // De dónde se llegó: al entrar (PUSH) la entrada anterior; al sustituir (REPLACE, p. ej. cambiar de pestaña) la misma
    // de la que venía la sustituida; volviendo (POP), lo que ya se sabía de esa entrada.
    const prev = existing ? existing.prev : type === 'PUSH' ? last : type === 'REPLACE' && last ? all[last]?.prev ?? null : null;
    saveEntry(key, { path: `${pathname}${search}${hash}`, title: existing?.title ?? null, idx: entryIdx(), prev: prev === key ? null : prev });
    writeJson(CURRENT, key);
  }, [key, pathname, search, hash]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** La pantalla dice cómo se llama (p. ej. «HU-175 · Auditoría del chat»): el «Atrás» de la siguiente lo muestra. */
export function useEntryTitle(title: string | null | undefined) {
  const { key, pathname, search, hash } = useLocation();
  useEffect(() => { if (!title) return; const e = entries()[key]; saveEntry(key, { path: e?.path ?? `${pathname}${search}${hash}`, title, idx: e?.idx ?? entryIdx(), prev: e?.prev ?? null }); }, [title, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Estado de interfaz de ESTA entrada del historial (vuelve con Atrás; una visita nueva empieza con `initial`). */
export function useEntryState<T>(name: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const { key } = useLocation();
  const storageKey = `${PREFIX}${key}.${name}`;
  const [value, setValue] = useState<T>(() => readJson<T>(storageKey, initial));
  // Otra entrada (otra visita a la misma pantalla): su propio estado.
  useEffect(() => { setValue(readJson<T>(storageKey, initial)); }, [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback((v: T | ((p: T) => T)) => setValue(prev => { const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v; writeJson(storageKey, next); return next; }), [storageKey]);
  return [value, set];
}

/** Pantalla «madre» de una ruta (para entrar por un enlace directo y volver sin salir del Portal). */
export function parentOf(pathname: string): { path: string; label: string } | null {
  if (/^\/historias\//.test(pathname)) return { path: '/backlog', label: 'Backlog' };
  if (/^\/procesos\//.test(pathname)) return { path: '/actividad', label: 'Actividad' };
  if (/^\/lotes\/[^/]+/.test(pathname)) return { path: '/lotes', label: 'Lotes' };
  if (/^\/equipo\/.+/.test(pathname)) return { path: '/oficina/organizacion', label: 'Organización' };
  if (/^\/oficina\/.+/.test(pathname)) return { path: '/oficina', label: 'Oficina' };
  if (/^\/(presupuestos|configuracion)(\/|$)/.test(pathname)) return { path: '/ajustes', label: 'Ajustes' };
  if (pathname === '/panel' || pathname === '/' || pathname === '/oficina') return null;
  // Secciones que no dependen de un proyecto vuelven a la Oficina (la portada); las del proyecto, a su Resumen.
  if (/^\/(autorizaciones|decisiones|asistente|ajustes)(\/|$)/.test(pathname)) return { path: '/oficina', label: 'Oficina' };
  return { path: '/panel', label: 'Resumen' };
}

/** Nombre genérico de una pantalla por su ruta (si la pantalla no dio uno más concreto). */
export function screenName(path: string): string {
  const p = path.split(/[?#]/)[0];
  if (p.startsWith('/historias/')) return 'la historia';
  if (p.startsWith('/procesos/')) return 'el proceso';
  if (p.startsWith('/lotes/')) return 'el lote';
  if (p.startsWith('/oficina/agente/')) return 'el agente';
  if (p === '/oficina/nuevo-agente') return 'Nuevo agente';
  if (p.startsWith('/equipo/')) return 'la configuración del agente';
  const names: Record<string, string> = { '/backlog': 'Backlog', '/lotes': 'Lotes', '/actividad': 'Actividad', '/panel': 'Resumen', '/oficina': 'Oficina', '/oficina/organizacion': 'Organización', '/oficina/departamentos': 'Departamentos', '/oficina/lista': 'la lista de agentes', '/asistente': 'Asistente', '/autorizaciones': 'Decisiones', '/conocimiento': 'Conocimiento', '/presupuestos': 'Presupuestos', '/ajustes': 'Ajustes', '/archivo': 'Archivo', '/etapa': 'Nueva etapa', '/configuracion/proveedor': 'Proveedores' };
  return names[p] ?? 'la pantalla anterior';
}

/**
 * Destino del «Atrás» global: la entrada anterior de esta pestaña (si es del Portal) o la pantalla madre. `go` usa el
 * historial del navegador (no crea entradas artificiales), así Adelante sigue funcionando.
 */
export function useBack(): { label: string; go: () => void } | null {
  const { pathname, key } = useLocation(); const navigate = useNavigate();
  // Hay una pantalla anterior del Portal en ESTA pestaña (índice del historial de la aplicación > 0): se vuelve a ella.
  if (entryIdx() > 0) {
    const all = entries(); const prevKey = all[key]?.prev; const prev = prevKey ? all[prevKey] : undefined;
    return { label: prev ? (prev.title ?? screenName(prev.path)) : 'Atrás', go: () => navigate(-1) };
  }
  const parent = parentOf(pathname);
  return parent ? { label: parent.label, go: () => navigate(parent.path) } : null;
}

/**
 * Preferencia de una pantalla POR PESTAÑA (búsqueda, filtro, secciones abiertas): cada pestaña conserva la suya mientras
 * vive (sessionStorage) y una pestaña nueva empieza con la última usada (localStorage). Así dos pestañas con filtros
 * distintos no se pisan, y recargar o volver con Atrás mantiene lo que tenías.
 */
export function useTabState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const read = () => { try { const t = sessionStorage.getItem(key) ?? localStorage.getItem(key); return t !== null ? JSON.parse(t) as T : initial; } catch { return initial; } };
  const [state, setState] = useState(() => ({ key, value: read() }));
  if (state.key !== key) setState({ key, value: read() });
  const set = useCallback((v: T | ((p: T) => T)) => setState(s => {
    const value = typeof v === 'function' ? (v as (p: T) => T)(s.value) : v;
    try { const t = JSON.stringify(value); sessionStorage.setItem(s.key, t); localStorage.setItem(s.key, t); } catch { /* sin almacenamiento */ }
    return { ...s, value };
  }), []);
  return [state.key === key ? state.value : read(), set];
}

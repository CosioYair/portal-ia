import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Estado de la interfaz que sobrevive a recargar, navegar y reiniciar el navegador o el Portal. Un solo mecanismo:
 * - preferencias y navegación: `usePersistentState` (clave fija, sin caducidad);
 * - borradores de formularios: `useDraft` (clave por empresa/proyecto y formulario, caducidad y estado visible).
 * Se guarda en el navegador (es del propietario y de este equipo; el servidor no necesita borradores). NUNCA se guarda
 * una autorización (las casillas «Autorizo…» viven solo en la pantalla: un borrador no autoriza nada) ni un secreto.
 */
const DRAFT_PREFIX = 'portal-ia.draft.v1.';
const MAX_AGE_MS = 30 * 24 * 3600_000;

export function readStored<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v) as T; } catch { return fallback; }
}
export function writeStored(key: string, value: unknown): boolean {
  try { if (value === undefined) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/**
 * Como useState, pero el valor se conserva entre recargas (preferencias: secciones abiertas, filtros, pestaña…). Si la
 * clave cambia (otra empresa o proyecto), se carga el valor de ESA clave: nunca se arrastra el de otro ámbito.
 */
export function usePersistentState<T>(key: string, initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
  const init = () => typeof initial === 'function' ? (initial as () => T)() : initial;
  const [state, setState] = useState(() => ({ key, value: readStored(key, init()) }));
  if (state.key !== key) setState({ key, value: readStored(key, init()) });
  const set = useCallback((v: T | ((prev: T) => T)) => setState(s => {
    const value = typeof v === 'function' ? (v as (p: T) => T)(s.value) : v;
    writeStored(s.key, value); return { ...s, value };
  }), []);
  return [state.key === key ? state.value : readStored(key, init()), set];
}

/** Huella corta de un valor (p. ej. los campos que se editan): sirve de `base` cuando el dato no tiene versión propia. */
export function fingerprint(value: unknown): string {
  const s = JSON.stringify(value) ?? ''; let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}.${(h >>> 0).toString(36)}`;
}

/** Clave de un borrador: formulario y su ámbito (empresa, proyecto, elemento). Sin ámbito no se guarda nada. */
export function draftKey(form: string, ...scope: (string | null | undefined)[]): string | null {
  return scope.some(s => !s) ? null : `${DRAFT_PREFIX}${form}.${scope.join('.')}`;
}

// Los borradores caducados se retiran al cargar la interfaz (no crecen sin límite).
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith(DRAFT_PREFIX) && !(readStored<{ at?: number } | null>(k, null)?.at! > Date.now() - MAX_AGE_MS)) localStorage.removeItem(k);
  }
} catch { /* sin almacenamiento */ }

export type DraftStatus = 'idle' | 'restored' | 'unsaved' | 'saved' | 'error';
interface StoredDraft<T> { v: T; at: number; base: string | null }
const isPlain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * Borrador de un formulario. Se guarda solo (sin peticiones al servidor) poco después de cada cambio y se restaura al
 * volver. `base` identifica la versión del dato que se edita (p. ej. su fecha de actualización): si el dato cambió en el
 * servidor desde que se guardó el borrador, NO se aplica solo; se ofrece en `stale` para recuperarlo o descartarlo.
 * `clear()` lo borra (tras enviar el formulario o al descartarlo).
 */
export function useDraft<T>(key: string | null, initial: T, opts: { base?: string | null; delayMs?: number; revive?: (stored: T) => T } = {}) {
  const base = opts.base ?? null; const delay = opts.delayMs ?? 400;
  // Un borrador de una versión anterior de la interfaz recibe los campos nuevos con su valor inicial.
  const merge = (stored: T): T => opts.revive ? opts.revive(stored) : isPlain(initial) && isPlain(stored) ? { ...initial, ...stored } as T : stored;
  const load = (k: string | null) => k ? readStored<StoredDraft<T> | null>(k, null) : null;
  const [state, setState] = useState(() => {
    const s = load(key); const fresh = !!s && s.base === base;
    return { key, value: fresh ? merge(s!.v) : initial, status: (fresh ? 'restored' : 'idle') as DraftStatus, stale: s && !fresh ? s : null, dirty: false };
  });
  // Otro ámbito (otra empresa, proyecto o elemento): se carga SU borrador; nunca se guarda uno con la clave del otro.
  if (state.key !== key) {
    const s = load(key); const fresh = !!s && s.base === base;
    setState({ key, value: fresh ? merge(s!.v) : initial, status: fresh ? 'restored' : 'idle', stale: s && !fresh ? s : null, dirty: false });
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!state.dirty || !key) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const ok = writeStored(key, { v: state.value, at: Date.now(), base } satisfies StoredDraft<T>);
      setState(s => s.key === key ? { ...s, status: ok ? 'saved' : 'error', dirty: false } : s);
    }, delay);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [state.value, state.dirty, key, base, delay]);
  const set = useCallback((v: T | ((prev: T) => T)) => setState(s => {
    const value = typeof v === 'function' ? (v as (p: T) => T)(s.value) : v;
    return { ...s, value, dirty: true, status: 'unsaved' };
  }), []);
  const clear = useCallback(() => { if (key) writeStored(key, undefined); setState(s => ({ ...s, value: initial, status: 'idle', stale: null, dirty: false })); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const recover = useCallback(() => setState(s => s.stale ? { ...s, value: merge(s.stale.v), stale: null, status: 'unsaved', dirty: true } : s), // eslint-disable-next-line react-hooks/exhaustive-deps
  []);
  return { value: state.value, set, status: state.status, clear, stale: state.stale ? { at: state.stale.at, recover, discard: clear } : null };
}

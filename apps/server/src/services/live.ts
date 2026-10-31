import crypto from 'node:crypto';

/**
 * Cambios en tiempo real (sin contenido): cada escritura relevante avisa QUÉ cambió (espacio, entidad, id), nunca los
 * datos. La interfaz vuelve a pedir lo que muestra por las rutas de siempre, así que el servidor sigue siendo la única
 * fuente de verdad y un aviso perdido solo retrasa una actualización (al reconectar se vuelve a pedir todo).
 * - Se agrupan en un mensaje cada ~200 ms (sin duplicados): un paso que informa de su llamada varias veces por segundo
 *   no genera una tormenta de avisos.
 * - `seq` es monótono por arranque del servidor y `epoch` identifica el arranque: tras un reinicio el cliente lo sabe y
 *   vuelve a pedir todo; tras una desconexión breve recibe lo que se perdió (últimos 500 mensajes) o, si no alcanza, también.
 * - `kind: 'progress'` (llamada en curso, consumo) frente a `'state'` (estado, resultado, pasos): los listados solo
 *   escuchan cambios de estado; la vista abierta de ese proceso, ambos.
 */
export type LiveEntity = 'process' | 'backlog' | 'batch' | 'assignment' | 'assistant' | 'system' | 'knowledge' | 'agent' | 'story' | 'usage';
export interface LiveChange { ws: string | null; entity: LiveEntity; id: string | null; projectId?: string | null; itemId?: string | null; kind?: 'state' | 'progress' }
export interface LiveMessage { seq: number; epoch: string; at: string; changes: LiveChange[] }

const EPOCH = crypto.randomUUID().slice(0, 8);
const RING = 500;
let seq = 0;
const pending = new Map<string, LiveChange>();
let timer: NodeJS.Timeout | null = null;
const ring: LiveMessage[] = [];
const listeners = new Set<(m: LiveMessage) => void>();

const keyOf = (c: LiveChange) => `${c.ws ?? ''}|${c.entity}|${c.id ?? ''}`;

/** Avisa de un cambio (se agrupa con los demás del mismo instante). Nunca lanza: avisar no puede romper una escritura. */
export function changed(c: LiveChange): void {
  try {
    const k = keyOf(c); const prev = pending.get(k);
    // Un cambio de estado prevalece sobre uno de progreso del mismo objeto.
    pending.set(k, prev && prev.kind !== 'progress' ? { ...c, kind: 'state' } : { ...c, kind: c.kind ?? 'state' });
    if (!timer) { timer = setTimeout(flush, 200); timer.unref?.(); }
  } catch { /* nunca bloquea */ }
}

function flush() {
  timer = null; if (!pending.size) return;
  const m: LiveMessage = { seq: ++seq, epoch: EPOCH, at: new Date().toISOString(), changes: [...pending.values()] };
  pending.clear();
  ring.push(m); if (ring.length > RING) ring.shift();
  for (const l of listeners) { try { l(m); } catch { /* un oyente roto no afecta a los demás */ } }
}

export function subscribeLive(fn: (m: LiveMessage) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function liveCursor(): { epoch: string; seq: number } { return { epoch: EPOCH, seq }; }

/**
 * Lo que se perdió desde `epoch:seq`: los mensajes posteriores, o null si no se puede saber (otro arranque o ya no están
 * en la memoria) → el cliente debe volver a pedir todo.
 */
export function missedSince(cursor: string | null | undefined): LiveMessage[] | null {
  if (!cursor) return [];
  const [e, s] = String(cursor).split(':'); const n = Number(s);
  if (e !== EPOCH || !Number.isInteger(n) || n < 0 || n > seq) return null;
  if (n === seq) return [];
  const first = ring[0]?.seq ?? seq + 1;
  if (n + 1 < first) return null;
  return ring.filter(m => m.seq > n);
}

/** Pruebas: vacía lo pendiente ya (sin esperar el agrupado). */
export function flushLiveNow(): void { if (timer) { clearTimeout(timer); timer = null; } flush(); }

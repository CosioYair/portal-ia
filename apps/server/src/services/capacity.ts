/**
 * Capacidad compartida entre procesos que corren a la vez (sin IA): tiempo que cada proceso pasó esperando turno.
 * - Cola de Claude Code: esperar un hueco no consume el plazo de la llamada ni la duración autorizada de la historia.
 * - Sandbox (Docker): contenedores a la vez y el volumen de dependencias de cada package-lock (ver services/sandbox.ts).
 * En memoria: tras un reinicio no hay nada en cola (los procesos en marcha quedan interrumpidos y se retoman a mano).
 */
const queued = new Map<string, { at: number; ms: number }[]>();

export function addQueuedMs(processId: string, ms: number): void { if (ms > 0) queued.set(processId, [...(queued.get(processId) ?? []), { at: Date.now(), ms }]); }
/** Espera en cola de ESTA ejecución (desde `sinceIso`, el inicio de la ejecución actual): al continuar no se arrastra la anterior. */
export function queuedMsOf(processId: string, sinceIso?: string | null): number {
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  return (queued.get(processId) ?? []).filter(e => e.at >= since).reduce((s, e) => s + e.ms, 0);
}
/** Al terminar el proceso se olvida (no crece con cada proceso). */
export function clearQueued(processId: string): void { queued.delete(processId); }

/** Semáforo con cola (FIFO) y aviso mientras se espera; `release` es idempotente. */
export function semaphore(max: () => number) {
  let active = 0; const waiters: (() => void)[] = [];
  return {
    async acquire(onWait?: (running: number) => void, signal?: AbortSignal): Promise<() => void> {
      while (active >= Math.max(1, max())) {
        if (signal?.aborted) throw Object.assign(new Error('Cancelado mientras esperaba turno.'), { cancelled: true });
        onWait?.(active);
        await new Promise<void>(res => { const w = () => { signal?.removeEventListener('abort', w); res(); }; waiters.push(w); signal?.addEventListener('abort', w, { once: true }); });
      }
      active++;
      let done = false;
      return () => { if (done) return; done = true; active = Math.max(0, active - 1); waiters.shift()?.(); };
    },
    get active() { return active; },
    get waiting() { return waiters.length; }
  };
}

/**
 * Cerrojo lector/escritor por clave (p. ej. el volumen de dependencias de un package-lock): muchos lectores a la vez
 * (typecheck, test, build lo montan en solo lectura) o UN escritor (install lo vacía y lo llena) sin lectores.
 */
const rw = new Map<string, { readers: number; writer: boolean; queue: { write: boolean; go: () => void }[] }>();
function pump(key: string) {
  const s = rw.get(key)!;
  while (s.queue.length) {
    const next = s.queue[0];
    if (next.write ? (s.writer || s.readers > 0) : s.writer) break;
    s.queue.shift();
    if (next.write) s.writer = true; else s.readers++;
    next.go();
    if (next.write) break;
  }
  if (!s.readers && !s.writer && !s.queue.length) rw.delete(key);
}
export async function withRwLock<T>(key: string, write: boolean, fn: () => Promise<T>): Promise<T> {
  if (!rw.has(key)) rw.set(key, { readers: 0, writer: false, queue: [] });
  const s = rw.get(key)!;
  await new Promise<void>(go => { s.queue.push({ write, go }); pump(key); });
  try { return await fn(); }
  finally { const t = rw.get(key)!; if (write) t.writer = false; else t.readers--; pump(key); }
}

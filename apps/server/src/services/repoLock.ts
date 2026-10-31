import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Carril único por repositorio para lo que toca la rama principal o la lista de worktrees: integrar en main, preparar un
 * candidato (main entra en la rama), crear o quitar worktrees, reconstruir el Portal. Así dos historias que corren a la vez
 * nunca integran a la vez (una sobre un main que la otra acaba de cambiar sin verificar) ni pisan el `index.lock`.
 * - La clave es la ruta real normalizada (en Windows sin distinguir mayúsculas): la misma carpeta escrita de dos formas
 *   es el mismo carril.
 * - Reentrante dentro de la misma operación (AsyncLocalStorage): una integración del lote que llama a `mergeStory`, que a
 *   su vez quita el worktree, no se bloquea a sí misma.
 * - Planificar, implementar, verificar, QA o esperar tu revisión NO pasan por aquí: siguen en paralelo.
 */
const tails = new Map<string, Promise<unknown>>();
const held = new AsyncLocalStorage<Set<string>>();
const waiting = new Map<string, number>();

export function repoKey(repoPath: string): string {
  let p = path.resolve(repoPath);
  try { p = fs.realpathSync.native(p); } catch { /* aún no existe: la ruta resuelta */ }
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

export async function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = repoKey(repoPath);
  const mine = held.getStore();
  if (mine?.has(key)) return fn();
  const prev = tails.get(key) ?? Promise.resolve();
  waiting.set(key, (waiting.get(key) ?? 0) + 1);
  const run = prev.catch(() => undefined).then(() => { waiting.set(key, Math.max(0, (waiting.get(key) ?? 1) - 1)); return held.run(new Set([...(mine ?? []), key]), fn); });
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}

/** ¿Hay alguna operación de la rama principal en curso o esperando en este repositorio? (para explicarlo, no para decidir). */
export function repoLaneBusy(repoPath: string): boolean { const key = repoKey(repoPath); return tails.has(key) || (waiting.get(key) ?? 0) > 0; }

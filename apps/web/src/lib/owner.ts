/**
 * Sesión del propietario en ESTE navegador (ver apps/server/src/services/ownerSession.ts). Se guarda en el almacenamiento
 * de este origen: otro puerto local no la lee (una cookie, en cambio, el navegador la enviaría a cualquier puerto del
 * mismo host). La envía `request` en la cabecera X-Portal-Owner.
 */
const KEY = 'portal-ia.owner-session';
const listeners = new Set<() => void>();
let memory: string | null = null;

export function ownerToken(): string | null {
  try { return localStorage.getItem(KEY); } catch { return memory; }
}
export function setOwnerToken(token: string | null) {
  memory = token;
  try { if (token) localStorage.setItem(KEY, token); else localStorage.removeItem(KEY); } catch { /* sin almacenamiento: queda en memoria */ }
  listeners.forEach(f => f());
}
export function onOwnerChange(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }
// Vincular o desvincular en otra pestaña se refleja aquí.
if (typeof window !== 'undefined') window.addEventListener('storage', e => { if (e.key === KEY) listeners.forEach(f => f()); });

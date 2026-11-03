/**
 * Sesión del propietario en ESTE navegador (ver apps/server/src/services/ownerSession.ts): todo cambio en el Portal la
 * exige; consultar, no. Se guarda en el almacenamiento de este origen: otro puerto local no la lee (una cookie, en cambio,
 * el navegador la enviaría a cualquier puerto del mismo host). La envía `request` en la cabecera X-Portal-Owner.
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
/**
 * Para las pocas llamadas que no pasan por `request` (subidas en flujo, módulos antiguos): la cabecera de la sesión y qué
 * hacer si el servidor la pide. Toda llamada que cambia algo debe usarlas (lo comprueba test/propietario-wiring.test.ts).
 */
export function ownerHeaders(): Record<string, string> { const t = ownerToken(); return t ? { 'X-Portal-Owner': t } : {}; }
export function noteOwnerResponse(status: number, body: any) { if (status === 401 && body?.code === 'owner_required') { if (ownerToken()) setOwnerToken(null); ownerNeeded(); } }
/** Una acción pidió la sesión del propietario: el aviso «Vincula este navegador» se abre y recibe el foco. */
export const OWNER_NEEDED = 'portal-owner-needed';
export function ownerNeeded() { if (typeof window !== 'undefined') window.dispatchEvent(new Event(OWNER_NEEDED)); }
// Vincular o desvincular en otra pestaña se refleja aquí.
if (typeof window !== 'undefined') window.addEventListener('storage', e => { if (e.key === KEY) listeners.forEach(f => f()); });

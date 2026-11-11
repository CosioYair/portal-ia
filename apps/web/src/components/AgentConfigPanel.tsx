import { useEffect, useState } from 'react';
import { SEAL_L1_MARK, SEAL_L2_MARK, SEAL_NOTE, sealLines } from '@portal-ia/domain';

/**
 * EN-021 · Sello Portal IA en solo lectura (Ajustes › Configuración de cada agente y Ajustes del Portal).
 * El texto vive solo en @portal-ia/domain (portal-seal.ts): aquí no se duplica ni se puede editar.
 * «Tu nombre» se lee de /api/settings/owner-name: nunca del correo ni de otra fuente.
 */
const OWNER_NAME_URL = '/api/settings/owner-name';

export async function ownerNameRequest(init?: RequestInit): Promise<string> {
  const r = await fetch(OWNER_NAME_URL, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const j = (await r.json().catch(() => ({}))) as { name?: unknown; error?: unknown };
  if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : `No se pudo completar (error ${r.status}).`);
  return typeof j.name === 'string' ? j.name : '';
}
export const loadOwnerName = () => ownerNameRequest();
export const saveOwnerName = (name: string) => ownerNameRequest({ method: 'PUT', body: JSON.stringify({ name }) });

const stripMark = (line: string) => line.replace(SEAL_L1_MARK, '').replace(SEAL_L2_MARK, '').trim();

/** Bloque de solo lectura con las dos líneas del sello. Sin `ownerName`, lee el nombre guardado. */
export function PortalSealPanel({ ownerName }: { ownerName?: string | null }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (ownerName !== undefined) return;
    let alive = true;
    void loadOwnerName().then(n => { if (alive) setLoaded(n); }).catch(() => { if (alive) setLoaded(''); });
    return () => { alive = false; };
  }, [ownerName]);
  const name = ownerName !== undefined ? ownerName : loaded;
  const [l1, l2] = sealLines({ owner: true, firstReply: true, ownerName: name || null });
  return <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }} aria-labelledby="portal-seal-h">
    <h3 id="portal-seal-h" className="h3" style={{ margin: 0 }}>Sello Portal IA</h3>
    <p className="small muted" style={{ margin: 0 }}>{SEAL_NOTE}. Solo lectura.</p>
    <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <li>{stripMark(l1)} <span className="muted">(en cada llamada)</span></li>
      {l2 && <li>{stripMark(l2)} <span className="muted">(solo en la primera respuesta de cada conversación contigo)</span></li>}
    </ol>
  </section>;
}

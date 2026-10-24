import { useCallback, useEffect, useState } from 'react';
import type { IntegrationStatus } from '@portal-ia/domain';
import { fetchIntegrationStatus, integrateBranch, type IntegrationFailure } from '../lib/integration.ts';
import { Icon } from './ui.tsx';

/**
 * Botón Integrar (HU-143). Siempre integra en la rama principal configurada.
 * Estados explícitos: cargando, error, bloqueado, listo, integrando, integrado, fallo accionable.
 */
export function IntegrarMain({ branch, onDone }: { branch: string; onDone?: () => void }) {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<IntegrationFailure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try { setStatus(await fetchIntegrationStatus()); }
    catch { setLoadError('No se pudo comprobar en qué rama está la carpeta del Portal.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const integrate = async () => {
    setRunning(true); setFailure(null); setDone(null);
    const res = await integrateBranch(branch);
    if (res.ok) { setDone(`«${branch}» se integró en «${res.into}» y se publicó en «${res.remote}».`); onDone?.(); }
    else setFailure(res.failure);
    await load(); // revalida el estado tras cada intento
    setRunning(false);
  };

  if (loading && !status) {
    return <div role="status"><span className="spin" aria-label="Comprobando la rama" /> Comprobando la rama…</div>;
  }
  if (loadError) {
    return <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p className="med">{Icon.alert()} {loadError}</p>
      <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => void load()}>Reintentar</button>
    </div>;
  }

  const blocked = !!status && !status.canIntegrate;
  const reasonId = 'integrar-motivo';

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => void integrate()}
      disabled={blocked || running || !status} aria-describedby={blocked ? reasonId : undefined}>
      {running ? 'Integrando…' : `Integrar en ${status?.mainBranch ?? 'main'}`}
    </button>
    {blocked && <p id={reasonId} className="med" role="status">{Icon.alert()} Integrar está bloqueado. {status?.reason}</p>}
    {!blocked && status && !done && <p className="med">Se integrará «{branch}» en «{status.mainBranch}» y se publicará en el remoto.</p>}
    {done && <p className="med" role="status">{Icon.okc()} {done}</p>}
    {failure && <div role="alert" className="med" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {failure.reason && <p>{Icon.alert()} {failure.reason}</p>}
      {failure.cause && <p>{Icon.alert()} <strong>Causa:</strong> {failure.cause}</p>}
      {failure.solution && <p><strong>Solución:</strong> {failure.solution}</p>}
      {failure.mergedCommit && <p>La integración local ya se hizo (commit <code className="mono">{failure.mergedCommit.slice(0, 7)}</code>); falta publicarla.</p>}
    </div>}
  </div>;
}

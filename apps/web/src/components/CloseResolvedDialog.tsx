import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.tsx';
import { api, type StoryClosePreview } from '../lib/api.ts';

/**
 * HU-187 · Diálogo del Portal para «Cerrar como resuelta» (Backlog y vista general). Antes de cerrar enseña lo que se
 * omitirá, pide un motivo (vacío y obligatorio) y propone como acción principal «Integrar primero».
 * Replicable a cualquier empresa: no depende del espacio del Portal.
 */
export function CloseResolvedDialog({ slug, item, onClosed, onIntegrateFirst, onCancel }: {
  slug: string;
  item: { id: string; storyId: string; title: string };
  onClosed: () => void | Promise<void>;
  onIntegrateFirst: (lastProcessId: string) => void;
  onCancel: () => void;
}) {
  const [preview, setPreview] = useState<StoryClosePreview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  const load = async () => {
    setLoading(true); setLoadErr(null);
    try { setPreview(await api.storyClosePreview(slug, item.id)); }
    catch (e: any) { setLoadErr(e?.message ?? 'No se pudo consultar qué se omitiría.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [slug, item.id]);
  // El foco va a la acción principal, no al motivo: así el diálogo no empuja a cerrar sin integrar.
  useEffect(() => { if (preview?.lastProcessId) primaryRef.current?.focus(); }, [preview?.lastProcessId]);

  const lastProcessId = preview?.lastProcessId ?? null;
  const canClose = reason.trim().length > 0 && !busy && !loading;
  const close = async () => {
    if (!canClose) return;
    setBusy(true); setErr(null);
    try { await api.markStoryDone(slug, item.id, { force: true, reason: reason.trim() }); await onClosed(); }
    catch (e: any) { setErr(e?.message ?? 'No se pudo cerrar la historia.'); }
    finally { setBusy(false); }
  };

  const footer = <>
    {lastProcessId && <button ref={primaryRef} className="btn btn-primary" disabled={busy} onClick={() => onIntegrateFirst(lastProcessId)}>Integrar primero</button>}
    <button className="btn" disabled={!canClose} title={reason.trim() ? undefined : 'Indica el motivo para cerrar'} onClick={() => void close()}>{busy ? 'Cerrando…' : lastProcessId ? 'Cerrar sin integrar' : 'Cerrar sin ejecutar'}</button>
    <button className="btn" disabled={busy} onClick={onCancel}>Cancelar</button>
  </>;

  return <Modal title={`Cerrar ${item.storyId} como resuelta`} onClose={onCancel} footer={footer}>
    <div className="muted">{item.title}</div>
    {loading && <div role="status">Comprobando qué se omitiría…</div>}
    {!loading && loadErr && <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span>{loadErr}</span>
      <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => void load()}>Reintentar</button>
    </div>}
    {!loading && !loadErr && preview && (preview.omittedChecks.length
      ? <div>
          <div>Si cierras ahora, se omitirá:</div>
          <ul style={{ margin: '6px 0 0 18px' }}>{preview.omittedChecks.map(c => <li key={c}>{c}</li>)}</ul>
        </div>
      : <div>No se omite ninguna comprobación.</div>)}
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span>Motivo (obligatorio; queda registrado en el hilo de la historia)</span>
      <textarea rows={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} />
    </label>
    {err && <div role="alert" className="err">{err}</div>}
  </Modal>;
}

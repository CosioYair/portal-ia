import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AssistantAction, type AssistantMessage } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Chip, Icon, Notice } from './ui.tsx';
import { OwnerPairing, useOwner } from './OwnerPairing.tsx';

const STATUS: Record<AssistantAction['status'], { label: string; tone: '' | 'ok' | 'warn' | 'err' }> = {
  pending: { label: 'Pendiente de tu autorización', tone: 'warn' }, running: { label: 'Ejecutando…', tone: 'warn' },
  done: { label: 'Hecha', tone: 'ok' }, failed: { label: 'No se completó', tone: 'err' }, rejected: { label: 'Rechazada: nada se ejecutó', tone: '' }
};

/**
 * Operación del Portal propuesta por el Asistente: muestra exactamente qué se hará (vista previa calculada en el servidor),
 * qué queda fuera y qué lo impide. Solo se ejecuta al autorizarla aquí; rechazarla no cambia nada. Decidir exige que
 * este navegador esté vinculado como propietario.
 */
export function OperationCard({ msgId, action, onResolved }: { msgId: string; action: AssistantAction; onResolved: (m: AssistantMessage) => void }) {
  const { flash } = useApp();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const owner = useOwner();
  const op = action.operation!; const pv = op.preview; const st = STATUS[action.status];
  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    try { const r = await api.decideAssistantOperation(msgId, op.id, decision); onResolved(r.message); flash(decision === 'approve' ? (r.message.actions.find(a => a.operation?.id === op.id)?.detail ?? 'Hecho') : 'Operación rechazada: no se ejecutó nada'); }
    catch (e: any) { flash(e.message, 'err'); } finally { setBusy(null); }
  };
  return (
    <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }} data-operation={op.capability}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{pv.title}</strong><Chip xs tone={st.tone}>{st.label}</Chip>
      </div>
      <div className="mono small" style={{ whiteSpace: 'pre-wrap', background: 'var(--color-surface-alt)', border: '1px solid var(--color-divider)', borderRadius: 8, padding: 8, maxHeight: 220, overflow: 'auto' }}>{pv.details.join('\n')}</div>
      {pv.excluded.length > 0 && <div className="small muted">Queda fuera: {pv.excluded.join(' · ')}</div>}
      {pv.blockers.map((b, i) => <Notice key={i} kind="warn">{b}</Notice>)}
      {action.status === 'pending' && pv.reviewPath && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Link className="btn btn-primary btn-sm" to={pv.reviewPath}>Abrir la revisión para elegir y autorizar {Icon.arrow()}</Link>
        {owner === true && <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => decide('reject')}>Rechazar</button>}
        <span className="small muted">Nada se ejecuta hasta que elijas y autorices en la revisión.{owner === false ? ' Para rechazarla o autorizarla, vincula allí este navegador como propietario.' : ''}</span>
      </div>}
      {action.status === 'pending' && !pv.reviewPath && owner === false && <OwnerPairing compact what="autorizar o rechazar esta operación" />}
      {action.status === 'pending' && !pv.reviewPath && owner === true && <>
        <label className="ck small"><input className="cb" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>Autorizo esta operación tal como se describe arriba (sin forzar y sin otras ramas).</span></label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" disabled={!consent || busy !== null} onClick={() => decide('approve')}>{busy === 'approve' ? <span className="spin spin-light" /> : null}Autorizar y ejecutar</button>
          <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => decide('reject')}>Rechazar</button>
        </div>
      </>}
      {action.status !== 'pending' && action.detail && <div className="small">{action.detail}</div>}
      {action.status !== 'pending' && pv.reviewPath && <Link className="lnk small" to={pv.reviewPath}>Ver la revisión completa</Link>}
      {op.result && op.result.details.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{op.result.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DecisionVerdict, PendingDecision, PendingDecisionKind } from '@portal-ia/domain';
import { api, ApiError } from '../lib/api.ts';

export const KIND_LABEL: Record<PendingDecisionKind, string> = {
  process_authorization: 'Autorizar proceso',
  apply_diff: 'Aplicar diff',
  integrate: 'Integrar',
  publish: 'Publicar',
  backlog_proposal: 'Propuesta al backlog'
};

const KIND_GLYPH: Record<PendingDecisionKind, string> = {
  process_authorization: '$',
  apply_diff: '±',
  integrate: '⇄',
  publish: '↑',
  backlog_proposal: '≡'
};

type CardState =
  | { phase: 'ready' }
  | { phase: 'confirming'; verdict: DecisionVerdict }
  | { phase: 'sending'; verdict: DecisionVerdict }
  | { phase: 'resolved'; verdict: DecisionVerdict }
  | { phase: 'error'; message: string; stale: boolean };

const money = (n: number) => `${n.toFixed(2).replace('.', ',')} USD`;
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es'); };

type RestoreState = { phase: 'idle' } | { phase: 'sending' } | { phase: 'error'; message: string };

interface Props {
  decision: PendingDecision;
  /** Se invoca tras resolverse la decisión en el servidor (la pantalla recarga la lista). */
  onResolved?: (decision: PendingDecision, verdict: DecisionVerdict) => void;
  /** HU-161 · si viene, la tarjeta es de una iteración anterior ya superada: sin aprobar ni denegar. */
  superseded?: { byIteration: number | null; at?: string | null } | null;
  /** Restaurar la superada (reversible, sin costo de IA). Si falla, la promesa se rechaza y la tarjeta muestra el error. */
  onRestore?: (decision: PendingDecision) => Promise<void>;
  /** Elemento contenedor: 'li' en listas (bandeja, historial) y 'div' cuando la tarjeta va suelta (chat). */
  as?: 'li' | 'div';
}

export function PendingDecisionCard({ decision, onResolved, superseded = null, onRestore, as = 'li' }: Props) {
  const [state, setState] = useState<CardState>({ phase: 'ready' });
  const [reason, setReason] = useState('');
  const [restore, setRestore] = useState<RestoreState>({ phase: 'idle' });
  const busy = state.phase === 'sending' || restore.phase === 'sending';
  const canDeny = decision.denyEffect !== null;
  const Tag = as;
  const history = decision.storyId ? `/historias/${decision.storyId}#iteraciones` : null;
  const byLabel = superseded ? `Superada por la iteración ${superseded.byIteration ?? 'más reciente'}` : null;
  const older = decision.supersededCount;

  async function doRestore() {
    if (!onRestore) return;
    setRestore({ phase: 'sending' });
    try { await onRestore(decision); setRestore({ phase: 'idle' }); }
    catch (e) { setRestore({ phase: 'error', message: e instanceof Error ? e.message : 'No se pudo contactar con el servidor local.' }); }
  }

  async function send(verdict: DecisionVerdict) {
    setState({ phase: 'sending', verdict });
    try {
      await api.decideInbox(decision.workspaceSlug, decision.kind, decision.processId, verdict, verdict === 'deny' && decision.kind === 'apply_diff' ? reason : undefined);
      setState({ phase: 'resolved', verdict });
      onResolved?.(decision, verdict);
    } catch (e) {
      if (e instanceof ApiError) {
        const stale = e.status === 409 || e.status === 410 || e.status === 404;
        setState({ phase: 'error', message: e.message, stale });
      } else {
        setState({ phase: 'error', message: 'No se pudo contactar con el servidor local.', stale: false });
      }
    }
  }

  const confirming = state.phase === 'confirming' || (state.phase === 'sending' ? state : null);
  const verdictShown = state.phase === 'confirming' || state.phase === 'sending' ? state.verdict : null;

  return (
    <Tag className="card inbox-card" aria-busy={busy}>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="chip chip-accent"><span aria-hidden="true" className="mono">{KIND_GLYPH[decision.kind]}</span> {KIND_LABEL[decision.kind]}</span>
          {decision.iteration != null && <span className="chip">Iteración {decision.iteration}</span>}
          {byLabel && <span className="chip">{byLabel}</span>}
          {decision.estimatedCost
            ? <span className="chip chip-warn">Costo estimado · {money(decision.estimatedCost.usd)}</span>
            : <span className="chip">Sin costo de IA</span>}
          <span className="small muted" style={{ marginLeft: 'auto' }}>{when(decision.createdAt)}</span>
        </div>

        <div>
          <div className="h3">{decision.title}</div>
          <div className="small muted">Solicita: {decision.requestedBy} · Proceso <span className="mono">{decision.processId.slice(0, 8)}</span></div>
          {!superseded && older > 0 && (
            <div className="small muted">
              {older === 1 ? '1 autorización anterior superada' : `${older} autorizaciones anteriores superadas`}
              {history && <> · <Link className="lnk" to={history}>ver historial</Link></>}
            </div>
          )}
        </div>

        <p className="sm13 med"><strong>Impacto:</strong> {decision.impact}</p>

        {superseded && (
          <div className="notice notice-info" role="status">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div><strong>{byLabel}.</strong> Ya no se puede aprobar ni denegar: decide sobre la autorización vigente.{superseded.at ? ` Superada el ${when(superseded.at)}.` : ''}</div>
              {onRestore && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void doRestore()}>
                    {restore.phase === 'sending' ? <><span className="spin" aria-hidden="true" /> Restaurando…</> : 'Restaurar'}
                  </button>
                  <span className="small muted">Sin costo de IA. Vuelve a ser la vigente y la actual pasa a superada (reversible).</span>
                </div>
              )}
              {!onRestore && history && <div><Link className="lnk" to={history}>Ver el historial de la historia</Link></div>}
              {restore.phase === 'error' && <div role="alert"><strong>No se pudo restaurar.</strong> {restore.message}</div>}
            </div>
          </div>
        )}

        {state.phase === 'ready' && !superseded && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-primary btn-sm" onClick={() => setState({ phase: 'confirming', verdict: 'approve' })}>Aprobar</button>
            {canDeny
              ? <button className="btn btn-secondary btn-sm" onClick={() => setState({ phase: 'confirming', verdict: 'deny' })}>Denegar</button>
              : <span className="small muted">Solo se puede aprobar; si no quieres hacerlo, déjala pendiente.</span>}
          </div>
        )}

        {confirming && verdictShown && (
          <div className="notice notice-warn" role="group" aria-label="Confirmación">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
              <div>
                <strong>{verdictShown === 'approve' ? 'Confirmar aprobación' : 'Confirmar denegación'}</strong>
                <div>{verdictShown === 'approve' ? decision.approveEffect : decision.denyEffect}</div>
                {verdictShown === 'approve' && decision.estimatedCost && (
                  <div>Se autorizará un presupuesto máximo de <strong>{money(decision.estimatedCost.budgetUsd)}</strong>.</div>
                )}
              </div>
              {verdictShown === 'deny' && decision.kind === 'apply_diff' && (
                <div>
                  <label className="label" htmlFor={`motivo-${decision.id}`}>Motivo (opcional)</label>
                  <textarea id={`motivo-${decision.id}`} className="input" value={reason} maxLength={2000} disabled={busy} onChange={e => setReason(e.target.value)} />
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className={`btn btn-sm ${verdictShown === 'approve' ? 'btn-primary' : 'btn-secondary'}`} disabled={busy} onClick={() => void send(verdictShown)}>
                  {busy ? <><span className="spin" aria-hidden="true" /> Enviando…</> : verdictShown === 'approve' ? 'Sí, aprobar' : 'Sí, denegar'}
                </button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setState({ phase: 'ready' })}>Volver</button>
              </div>
            </div>
          </div>
        )}

        {state.phase === 'resolved' && (
          <div className="notice notice-ok" role="status"><span aria-hidden="true">✓</span> {state.verdict === 'approve' ? 'Aprobada.' : 'Denegada.'} Actualizando la lista…</div>
        )}

        {state.phase === 'error' && (
          <div className="notice notice-err" role="alert">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div><strong>{state.stale ? 'Esta decisión ya no está disponible.' : 'No se pudo registrar la decisión.'}</strong> {state.message}</div>
              {!state.stale && <div><button className="btn btn-secondary btn-sm" onClick={() => setState({ phase: 'ready' })}>Reintentar</button></div>}
            </div>
          </div>
        )}
      </div>
    </Tag>
  );
}

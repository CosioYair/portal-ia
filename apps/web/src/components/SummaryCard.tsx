import { useId } from 'react';
import { Notice, Spinner } from './ui.tsx';

/**
 * HU-163 · Tarjeta de resumen con estados explícitos.
 * Uso: una acción como máximo. El tipo solo admite un objeto, no una lista.
 * - loading: muestra el Spinner (role="status") y nunca una cifra.
 * - error: muestra un Notice de error con el botón «Reintentar».
 * - ready: muestra la cifra opcional, el mensaje y la acción si la hay.
 * Solo navega o reintenta: no consume IA ni lanza acciones con costo.
 */
export type SummaryTone = 'ok' | 'warn' | 'info';
export type SummaryState = 'loading' | 'error' | 'ready';
export interface SummaryAction { label: string; onClick: () => void }

export function SummaryCard({ tone, title, value, message, action, state, errorMessage, onRetry }: {
  tone: SummaryTone;
  title: string;
  value?: number | string;
  message: string;
  action?: SummaryAction;
  state: SummaryState;
  errorMessage?: string;
  onRetry?: () => void;
}) {
  const titleId = useId();
  return (
    <section className={`card summary-card summary-card-${state === 'ready' ? tone : 'info'}`} aria-labelledby={titleId} aria-busy={state === 'loading' ? true : undefined}>
      <div className="card-b summary-card-body">
        <h2 id={titleId} className="h3">{title}</h2>
        {state === 'loading' && <Spinner />}
        {state === 'error' && (
          <Notice kind="err">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div><strong>No se pudo cargar.</strong> {errorMessage ?? 'Inténtalo de nuevo.'}</div>
              {onRetry && <div><button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Reintentar</button></div>}
            </div>
          </Notice>
        )}
        {state === 'ready' && (
          <div className="summary-card-content" aria-live="polite">
            {value !== undefined && <span className="summary-card-value mono">{value}</span>}
            <p className="summary-card-message">{message}</p>
          </div>
        )}
        {state === 'ready' && action && (
          <div>
            <button type="button" className="btn btn-primary" onClick={action.onClick}>{action.label}</button>
          </div>
        )}
      </div>
    </section>
  );
}

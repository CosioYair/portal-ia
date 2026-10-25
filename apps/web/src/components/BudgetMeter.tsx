import { useCallback, useEffect, useState } from 'react';
import type { BudgetBalance, BudgetLevel } from '@portal-ia/domain';
import { api, ApiError } from '../lib/api.ts';
import './BudgetMeter.css';

/** HU-138 · Indicador de saldo: gasto real, reservas de procesos en curso y disponible. */

type MeterState = 'loading' | 'error' | 'none' | 'ok' | 'warn' | 'exhausted';

const WARN_RATIO = 0.8;

export const formatMicros = (micros: number): string =>
  (micros / 1_000_000).toLocaleString('es', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** Estado visual a partir del saldo (función pura, fácil de probar). */
export function meterState(b: BudgetBalance): Exclude<MeterState, 'loading' | 'error'> {
  if (!b.configured) return 'none';
  if (b.availableMicros <= 0) return 'exhausted';
  if (b.limitMicros > 0 && (b.spentMicros + b.reservedMicros) / b.limitMicros >= WARN_RATIO) return 'warn';
  return 'ok';
}

const STATUS_TEXT: Record<MeterState, { icon: string; text: string }> = {
  loading: { icon: '…', text: 'Cargando saldo' },
  error: { icon: '✖', text: 'No se pudo cargar' },
  none: { icon: '○', text: 'Sin presupuesto' },
  ok: { icon: '✔', text: 'Saldo suficiente' },
  warn: { icon: '⚠', text: 'Saldo bajo (80 % o más usado)' },
  exhausted: { icon: '⛔', text: 'Presupuesto agotado' }
};

export interface BudgetMeterProps {
  level: BudgetLevel;
  /** Empresa: slug del espacio. Proyecto: id del proyecto. */
  scopeId: string;
  /** Espacio al que pertenece el proyecto (obligatorio para level = 'project'). */
  workspace?: string;
  title?: string;
  /** Permite fijar el presupuesto mensual (requiere confirmación explícita; no tiene costo de IA). */
  editable?: boolean;
}

export function BudgetMeter({ level, scopeId, workspace, title, editable = true }: BudgetMeterProps) {
  const [balance, setBalance] = useState<BudgetBalance | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [limitUsd, setLimitUsd] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api.getBudgetBalance(level, scopeId, workspace)
      .then(b => { if (!cancelled) { setBalance(b); setLoading(false); } })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof ApiError || e instanceof Error ? e.message : 'Error desconocido.');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [level, scopeId, workspace, reloadKey]);

  const save = useCallback(async () => {
    const value = Number(limitUsd.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) { setSaveError('Indica un importe mensual en USD válido (0 o mayor).'); return; }
    setSaving(true);
    setSaveError(null);
    try {
      const b = await api.setMonthlyBudget(level, scopeId, value, workspace);
      setBalance(b);
      setLimitUsd('');
      setConfirmed(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'No se pudo guardar el presupuesto.');
    } finally {
      setSaving(false);
    }
  }, [limitUsd, level, scopeId, workspace]);

  const state: MeterState = loading ? 'loading' : loadError ? 'error' : balance ? meterState(balance) : 'error';
  const heading = title ?? (level === 'company' ? 'Presupuesto mensual de la empresa' : 'Presupuesto mensual del proyecto');
  const st = STATUS_TEXT[state];

  const total = balance ? Math.max(balance.limitMicros, balance.spentMicros + balance.reservedMicros, 1) : 1;
  const pct = (m: number) => `${Math.max(0, Math.min(100, (m / total) * 100))}%`;

  return (
    <section className={`budget-meter budget-meter--${state}`} aria-label={heading} aria-busy={state === 'loading'}>
      <div className="budget-meter__head">
        <h3 className="budget-meter__title">{heading}</h3>
        <span className="budget-meter__status" role="status"><span aria-hidden="true">{st.icon}</span>{st.text}</span>
      </div>

      {state === 'loading' && <p className="budget-meter__note">Consultando el saldo del mes…</p>}

      {state === 'error' && (
        <>
          <p className="budget-meter__error" role="alert">{loadError ?? 'No se pudo cargar el saldo.'}</p>
          <div className="budget-meter__row">
            <button type="button" className="btn secondary sm" onClick={() => setReloadKey(k => k + 1)}>Reintentar</button>
          </div>
        </>
      )}

      {balance && state !== 'loading' && state !== 'error' && (
        <>
          <span className="budget-meter__period">Periodo {balance.period} (UTC)</span>
          {state === 'none' ? (
            <p className="budget-meter__note">No hay presupuesto mensual definido. Mientras tanto, ningún proceso de este ámbito puede autorizarse.</p>
          ) : (
            <>
              <div className="budget-meter__bar" role="img" aria-label={`Gasto real ${formatMicros(balance.spentMicros)}, reservado ${formatMicros(balance.reservedMicros)}, disponible ${formatMicros(balance.availableMicros)} de ${formatMicros(balance.limitMicros)}`}>
                <div className="budget-meter__seg budget-meter__seg--spent" style={{ width: pct(balance.spentMicros) }} />
                <div className="budget-meter__seg budget-meter__seg--reserved" style={{ width: pct(balance.reservedMicros) }} />
                <div className="budget-meter__seg budget-meter__seg--available" style={{ width: pct(Math.max(balance.availableMicros, 0)) }} />
              </div>
              <ul className="budget-meter__legend">
                <li><span className="label"><span className="budget-meter__dot budget-meter__dot--spent" aria-hidden="true" />Gasto real</span><span className="value">{formatMicros(balance.spentMicros)}</span></li>
                <li><span className="label"><span className="budget-meter__dot budget-meter__dot--reserved" aria-hidden="true" />Reservado (procesos en curso)</span><span className="value">{formatMicros(balance.reservedMicros)}</span></li>
                <li><span className="label"><span className="budget-meter__dot budget-meter__dot--available" aria-hidden="true" />Disponible</span><span className="value">{formatMicros(balance.availableMicros)}</span></li>
                <li><span className="label">Límite mensual</span><span className="value">{formatMicros(balance.limitMicros)}</span></li>
              </ul>
              {balance.availableMicros < 0 && (
                <p className="budget-meter__note">El coste real superó lo reservado: el saldo es negativo y no se autorizarán más procesos este mes.</p>
              )}
            </>
          )}

          {editable && (
            <form className="budget-meter__form" onSubmit={e => { e.preventDefault(); if (confirmed && limitUsd.trim()) void save(); }}>
              <label className="budget-meter__note" htmlFor={`bm-${level}-${scopeId}`}>
                {state === 'none' ? 'Fijar presupuesto mensual (USD)' : 'Cambiar presupuesto mensual (USD)'}
              </label>
              <div className="budget-meter__row">
                <input id={`bm-${level}-${scopeId}`} type="number" min="0" step="0.01" inputMode="decimal" value={limitUsd} onChange={e => setLimitUsd(e.target.value)} disabled={saving} />
                <button type="submit" className="btn primary sm" disabled={saving || !confirmed || !limitUsd.trim()}>{saving ? 'Guardando…' : 'Guardar presupuesto'}</button>
              </div>
              <label className="budget-meter__confirm">
                <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={saving} />
                <span>Confirmo fijar este límite para {balance.period}. Fijarlo no consume IA; solo limita lo que se podrá autorizar.</span>
              </label>
              {saveError && <p className="budget-meter__error" role="alert">{saveError}</p>}
            </form>
          )}
        </>
      )}
    </section>
  );
}

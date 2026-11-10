import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { AssistantModelOption } from '../lib/api.ts';

/** Etiqueta del tipo de costo: «Suscripción» o «≈ X USD por mensaje» (API). */
export function modelCostLabel(m: Pick<AssistantModelOption, 'billing' | 'estimatedPerMessageUsd'>): string {
  if (m.billing === 'subscription') return 'Suscripción';
  const v = m.estimatedPerMessageUsd;
  return `≈ ${v.toFixed(v > 0 && v < 0.01 ? 4 : 3)} USD por mensaje`;
}

export interface ModelPickerProps {
  models: AssistantModelOption[];
  /** Modelo de esta conversación. */
  value: string;
  /** Modelo configurado del agente (el «por defecto»). */
  defaultModel: string;
  billing: 'api' | 'subscription';
  /** Cargando la información del Asistente. */
  loading?: boolean;
  /** Bloqueado temporalmente (p. ej., un envío en curso). */
  disabled?: boolean;
  /** Si existe, el modelo se muestra en solo lectura con este motivo. */
  readOnlyReason?: string | null;
  /** Guardando el modelo por defecto del agente. */
  savingDefault?: boolean;
  compact?: boolean;
  onChange: (model: string) => void;
  onSetDefault: (model: string) => void;
}

export function ModelPicker({ models, value, defaultModel, billing, loading, disabled, readOnlyReason, savingDefault, compact, onChange, onSetDefault }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [asDefault, setAsDefault] = useState(false);
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const current = models.find(m => m.id === value) ?? { id: value, label: value, billing, estimatedPerMessageUsd: 0 };
  const cost = current.billing === 'api' && !models.some(m => m.id === value) ? 'API' : modelCostLabel(current);
  const cls = `model-picker${compact ? ' model-picker--compact' : ''}`;

  useEffect(() => { if (open) { const i = Math.max(0, models.findIndex(m => m.id === value)); setActive(i); list.current?.focus(); } }, [open, models, value]);
  useEffect(() => { if ((disabled || savingDefault) && open) setOpen(false); }, [disabled, savingDefault, open]);

  if (loading) return <span className={cls} aria-live="polite">Cargando modelos…</span>;
  if (readOnlyReason || !models.length) {
    return (
      <span className={`${cls} model-picker--readonly`} title={readOnlyReason ?? undefined}>
        <span className="model-picker-name">{current.label}</span> · <span className="model-picker-cost">{cost}</span>
        {readOnlyReason && <span className="model-picker-reason"> — {readOnlyReason}</span>}
      </span>
    );
  }

  const close = () => { setOpen(false); btn.current?.focus(); };
  const choose = (m: AssistantModelOption) => { onChange(m.id); if (asDefault && m.id !== defaultModel) onSetDefault(m.id); close(); };
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(models.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(models.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const m = models[active]; if (m) choose(m); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className={cls}>
      <button ref={btn} type="button" className="model-picker-button" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-label={`Modelo de esta conversación: ${current.label}, ${cost}. Cambiar modelo`} disabled={disabled || savingDefault} onClick={() => setOpen(o => !o)}>
        <span className="model-picker-name">{current.label}</span>
        {!compact && <span className="model-picker-cost"> · {cost}</span>}
        <span aria-hidden="true"> ▾</span>
      </button>
      {savingDefault && <span className="model-picker-status" role="status">Guardando el modelo por defecto…</span>}
      {open && (
        <div className="model-picker-popup">
          <ul ref={list} id={listId} role="listbox" tabIndex={-1} aria-label="Modelos del Asistente" aria-activedescendant={`${listId}-${active}`} onKeyDown={onKey}>
            {models.map((m, i) => (
              <li key={m.id} id={`${listId}-${i}`} role="option" aria-selected={m.id === value}
                className={`model-picker-option${i === active ? ' is-active' : ''}${m.id === value ? ' is-selected' : ''}`}
                onMouseEnter={() => setActive(i)} onClick={() => choose(m)}>
                <span className="model-picker-name">{m.label}</span>
                <span className="model-picker-cost">{modelCostLabel(m)}</span>
                {m.id === defaultModel && <span className="model-picker-default"> (por defecto)</span>}
              </li>
            ))}
          </ul>
          <label className="model-picker-check">
            <input type="checkbox" checked={asDefault} onChange={e => setAsDefault(e.target.checked)} />
            Usar por defecto en el Asistente
          </label>
          <p className="model-picker-hint">{asDefault ? 'El modelo elegido se guardará en la configuración del agente.' : 'Sin marcarla, el cambio solo vale para esta conversación.'}</p>
        </div>
      )}
    </div>
  );
}

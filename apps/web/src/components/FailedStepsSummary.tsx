import { useRef, useState } from 'react';

export interface FailedStep { index: number; text: string; comment: string; }

const firstLine = (s: string) => s.split('\n')[0].trim();

export function formatFailedSteps(steps: FailedStep[]): string {
  return steps.map(s => `#${s.index + 1} ${firstLine(s.text)} — ${s.comment.trim() || '(sin comentario)'}`).join('\n');
}

/** Bloque de solo lectura con los pasos en Falla y su comentario, copiable. */
export function FailedStepsSummary({ steps }: { steps: FailedStep[] }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [copy, setCopy] = useState<'idle' | 'done' | 'manual'>('idle');
  const text = formatFailedSteps(steps);

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy('done');
    } catch {
      area.current?.focus();
      area.current?.select();
      setCopy('manual');
    }
    window.setTimeout(() => setCopy('idle'), 3000);
  };

  return (
    <section className="mtf-summary" aria-label="Pasos con falla">
      <div className="mtf-summary-head">
        <h3 className="h3">Pasos con falla</h3>
        {steps.length > 0 && <button type="button" className="btn" onClick={() => { void doCopy(); }}>Copiar</button>}
        <span role="status" aria-live="polite">
          {copy === 'done' && 'Copiado'}
          {copy === 'manual' && 'No se pudo copiar automáticamente: el texto está seleccionado, usa Ctrl+C'}
        </span>
      </div>
      {steps.length === 0
        ? <p className="med">Sin pasos con falla</p>
        : <textarea ref={area} className="mtf-comment mono" readOnly rows={Math.min(12, steps.length + 1)} value={text} aria-label="Resumen de pasos con falla" onFocus={e => e.currentTarget.select()} />}
    </section>
  );
}

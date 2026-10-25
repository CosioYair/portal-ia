import { useEffect, useRef, useState } from 'react';
import type { ManualTestStepResult } from '@portal-ia/domain';
import type { StepFeedbackPayload } from '../lib/manualTestFeedback.ts';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const OPTIONS: { value: ManualTestStepResult; label: string; icon: string }[] = [
  { value: 'ok', label: 'OK', icon: '✓' },
  { value: 'fail', label: 'Falla', icon: '✕' },
  { value: 'observation', label: 'Observación', icon: '●' }
];

interface Props {
  index: number;
  text: string;
  initial: StepFeedbackPayload | null;
  onSave: (payload: StepFeedbackPayload) => Promise<void>;
}

/** Feedback de un paso: resultado de selección exclusiva + comentario libre, con guardado explícito. */
export function ManualTestStepFeedback({ index, text, initial, onSave }: Props) {
  const [result, setResult] = useState<ManualTestStepResult | null>(initial?.result ?? null);
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [state, setState] = useState<SaveState>('idle');
  const latest = useRef<StepFeedbackPayload>({ result, comment });
  const onSaveRef = useRef(onSave);
  const timer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const seq = useRef(0);
  onSaveRef.current = onSave;

  const persist = async () => {
    window.clearTimeout(timer.current);
    dirty.current = false;
    const n = ++seq.current;
    setState('saving');
    try {
      await onSaveRef.current({ ...latest.current });
      if (n === seq.current) setState('saved');
    } catch {
      if (n === seq.current) setState('error');
    }
  };

  // Al desmontar con un comentario pendiente, se intenta guardar (último en escribir gana).
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (dirty.current) void onSaveRef.current({ ...latest.current }).catch(() => { /* sin UI al desmontar */ });
  }, []);

  const choose = (value: ManualTestStepResult) => {
    const next = result === value ? null : value;
    setResult(next);
    latest.current = { ...latest.current, result: next };
    void persist();
  };

  const changeComment = (value: string) => {
    setComment(value);
    latest.current = { ...latest.current, comment: value };
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void persist(); }, 600);
  };

  const blurComment = () => { if (dirty.current) void persist(); };

  return (
    <div className="mtf-step">
      <div className="mtf-text"><strong>#{index + 1}</strong> {text}</div>
      <div className="mtf-options" role="group" aria-label={`Resultado del paso ${index + 1}`}>
        {OPTIONS.map(o => (
          <button key={o.value} type="button" className={`btn${result === o.value ? ' btn-primary' : ''}`} aria-pressed={result === o.value} onClick={() => choose(o.value)}>
            <span aria-hidden="true">{o.icon}</span> {o.label}
          </button>
        ))}
      </div>
      <textarea
        className="mtf-comment" rows={2} maxLength={2000} value={comment}
        placeholder="Comentario (opcional)" aria-label={`Comentario del paso ${index + 1}`}
        onChange={e => changeComment(e.target.value)} onBlur={blurComment}
      />
      <div className="mtf-status" role="status" aria-live="polite">
        {state === 'saving' && 'Guardando…'}
        {state === 'saved' && 'Guardado'}
        {state === 'error' && <>Error al guardar · <button type="button" className="btn" onClick={() => { void persist(); }}>Reintentar</button></>}
      </div>
    </div>
  );
}

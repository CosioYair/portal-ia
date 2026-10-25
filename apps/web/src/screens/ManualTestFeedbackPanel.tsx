import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ManualTestFeedbackView, ManualTestStepFeedback } from '@portal-ia/domain';
import { AppContext } from '../lib/store.ts';
import { getManualTestFeedback, saveManualTestStepFeedback, type StepFeedbackPayload } from '../lib/manualTestFeedback.ts';
import { ManualTestStepFeedback as StepFeedback } from '../components/ManualTestStepFeedback.tsx';
import { FailedStepsSummary } from '../components/FailedStepsSummary.tsx';
import '../manual-test-feedback.css';

/** Feedback por paso de la prueba manual de /procesos/:processId. No lanza ejecuciones ni tiene coste. */
export function ManualTestFeedbackPanel() {
  const { processId } = useParams();
  const ctx = useContext(AppContext);
  const slug = ctx?.status.workspace?.slug;
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [view, setView] = useState<ManualTestFeedbackView | null>(null);
  const [items, setItems] = useState<Record<string, ManualTestStepFeedback>>({});

  const load = useCallback(() => {
    if (!slug || !processId) return;
    setState('loading');
    getManualTestFeedback(slug, processId)
      .then(v => { setView(v); setItems(Object.fromEntries(v.items.map(i => [i.stepKey, i]))); setState('ready'); })
      .catch(() => setState('error'));
  }, [slug, processId]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (stepKey: string, payload: StepFeedbackPayload) => {
    if (!slug || !processId) throw new Error('Sin proceso');
    const { item } = await saveManualTestStepFeedback(slug, processId, stepKey, payload);
    setItems(prev => { const next = { ...prev }; if (item) next[stepKey] = item; else delete next[stepKey]; return next; });
  }, [slug, processId]);

  const failed = useMemo(() => (view?.steps ?? [])
    .filter(s => items[s.stepKey]?.result === 'fail')
    .map(s => ({ index: s.index, text: s.text, comment: items[s.stepKey]?.comment ?? '' })), [view, items]);

  if (!slug || !processId) return null;
  if (state === 'ready' && (view?.steps.length ?? 0) === 0) return null; // este proceso no tiene prueba manual

  return (
    <section className="card mtf-panel" aria-label="Feedback de la prueba manual">
      <h2 className="h3">Feedback de la prueba manual</h2>
      {state === 'loading' && <p className="med" role="status">Cargando feedback…</p>}
      {state === 'error' && <p className="med" role="alert">No se pudo cargar el feedback · <button type="button" className="btn" onClick={load}>Reintentar</button></p>}
      {state === 'ready' && view && (
        <>
          {view.steps.map(s => {
            const saved = items[s.stepKey];
            return <StepFeedback key={s.stepKey} index={s.index} text={s.text} initial={saved ? { result: saved.result, comment: saved.comment } : null} onSave={p => save(s.stepKey, p)} />;
          })}
          <FailedStepsSummary steps={failed} />
        </>
      )}
    </section>
  );
}

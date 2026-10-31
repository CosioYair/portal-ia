import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildFailureBlock, buildManualTestSteps, countDoneManualSteps, type ManualTestFeedbackEntry, type ManualTestResult, type ManualTestStepView } from '@portal-ia/domain';
import '../manual-test-feedback.css';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type Draft = { result: ManualTestResult | null; comment: string };

const OPTIONS: { value: ManualTestResult; label: string; icon: string }[] = [
  { value: 'ok', label: 'OK', icon: '✓' },
  { value: 'fail', label: 'Falla', icon: '✕' },
  { value: 'observation', label: 'Observación', icon: '!' }
];
const EMPTY: Draft = { result: null, comment: '' };

interface Props {
  /** Texto de cada paso de la prueba manual. */
  steps: string[];
  /** Casillas heredadas (solo lectura); OK sustituye a la casilla. */
  checks?: boolean[];
  /** Feedback ya guardado. Monta el componente cuando esté cargado (p. ej. con `key` por proceso). */
  initialFeedback: ManualTestFeedbackEntry[];
  /** Guarda el feedback de un paso (PUT del endpoint existente). Debe rechazar si falla. */
  onSave: (stepKey: string, result: ManualTestResult | null, comment: string) => Promise<void>;
  /** Se llama cuando cambian los ítems (para actualizar el contador de pasos realizados). */
  onChange?: (items: ManualTestStepView[]) => void;
  /**
   * Acciones bajo «Pasos con falla» (p. ej. enviar el feedback al equipo). `flush` guarda antes los comentarios
   * escritos y aún no guardados y espera a que terminen los guardados en curso.
   */
  failureActions?: (ctx: { failed: ManualTestStepView[]; flush: () => Promise<void> }) => ReactNode;
}

/** Lista «Qué probar, paso a paso»: cada ítem lleva en su fila OK, Falla, Observación y su comentario. */
export function ManualTestStepList({ steps, checks, initialFeedback, onSave, onChange, failureActions }: Props) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(
    () => Object.fromEntries(initialFeedback.map(f => [f.stepKey, { result: f.result, comment: f.comment }]))
  );
  const [status, setStatus] = useState<Record<string, SaveState>>({});
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const seq = useRef<Record<string, number>>({});
  const dirty = useRef<Set<string>>(new Set());
  const inflight = useRef<Set<Promise<void>>>(new Set());
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const items = useMemo(
    () => buildManualTestSteps(steps, Object.entries(drafts).map(([stepKey, d]) => ({ stepKey, ...d })), checks ?? []),
    [steps, checks, drafts]
  );
  useEffect(() => { onChangeRef.current?.(items); }, [items]);

  const persist = useCallback((stepKey: string, draft: Draft): Promise<void> => {
    const n = (seq.current[stepKey] ?? 0) + 1;
    seq.current[stepKey] = n;
    setStatus(s => ({ ...s, [stepKey]: 'saving' }));
    const run = (async () => {
      try {
        await onSave(stepKey, draft.result, draft.comment);
        if (seq.current[stepKey] === n) setStatus(s => ({ ...s, [stepKey]: 'saved' }));
      } catch {
        if (seq.current[stepKey] === n) setStatus(s => ({ ...s, [stepKey]: 'error' }));
        throw new Error('No se pudo guardar el feedback de un paso.');
      }
    })();
    inflight.current.add(run);
    void run.catch(() => undefined).finally(() => inflight.current.delete(run));
    return run;
  }, [onSave]);
  /** Guarda los comentarios pendientes y espera a todos los guardados (antes de enviar el feedback a otro sitio). */
  const flush = useCallback(async () => {
    for (const k of Array.from(dirty.current)) { dirty.current.delete(k); void persist(k, draftsRef.current[k] ?? EMPTY); }
    await Promise.all(Array.from(inflight.current));
  }, [persist]);
  // Un comentario a medio escribir se guarda también al salir de la pantalla o al recargar (no solo al perder el foco).
  useEffect(() => { const h = () => { void flush(); }; window.addEventListener('pagehide', h); return () => { window.removeEventListener('pagehide', h); void flush(); }; }, [flush]);

  const pick = (stepKey: string, value: ManualTestResult) => {
    const cur = drafts[stepKey] ?? EMPTY;
    const next: Draft = { result: cur.result === value ? null : value, comment: cur.comment };
    dirty.current.delete(stepKey);
    setDrafts(d => ({ ...d, [stepKey]: next }));
    void persist(stepKey, next).catch(() => undefined);
  };
  const typeComment = (stepKey: string, comment: string) => {
    dirty.current.add(stepKey);
    setDrafts(d => ({ ...d, [stepKey]: { result: (d[stepKey] ?? EMPTY).result, comment } }));
  };
  const blurComment = (stepKey: string) => {
    if (!dirty.current.has(stepKey)) return;
    dirty.current.delete(stepKey);
    void persist(stepKey, drafts[stepKey] ?? EMPTY).catch(() => undefined);
  };

  const failureBlock = buildFailureBlock(items);
  const copy = async () => {
    try { await navigator.clipboard.writeText(failureBlock); setCopyMsg('✓ Copiado'); }
    catch { setCopyMsg('⚠ No se pudo copiar: selecciona el texto y cópialo a mano'); }
  };

  if (!items.length) return <p className="muted sm13">Este proceso no tiene prueba manual.</p>;

  return (
    <section className="mts" aria-label="Qué probar, paso a paso">
      <p className="mts-summary small muted">{countDoneManualSteps(items)} de {items.length} pasos realizados</p>
      <ol className="mts-list">
        {items.map(item => {
          const st = status[item.stepKey] ?? 'idle';
          const n = item.index + 1;
          return (
            <li key={item.stepKey} className={`mts-item${item.done ? ' is-done' : ''}${item.result === 'fail' ? ' is-fail' : ''}`} data-result={item.result ?? 'none'}>
              <div className="mts-row">
                <span className="mts-num">{n}.</span>
                <p className="mts-text">{item.text}</p>
                <div className="mts-actions" role="group" aria-label={`Resultado del paso ${n}`}>
                  {OPTIONS.map(o => (
                    <button key={o.value} type="button" className={`btn btn-sm btn-secondary mts-opt mts-opt-${o.value}`} aria-pressed={item.result === o.value} onClick={() => pick(item.stepKey, o.value)}>
                      <span aria-hidden="true">{o.icon}</span> {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <textarea className="input mts-comment" rows={2} maxLength={2000} placeholder="Comentario del paso (opcional)" aria-label={`Comentario del paso ${n}`}
                value={item.comment} onChange={e => typeComment(item.stepKey, e.target.value)} onBlur={() => blurComment(item.stepKey)} />
              <div className="mts-status small" role="status" aria-live="polite">
                {st === 'saving' && <span>… Guardando</span>}
                {st === 'saved' && <span>✓ Guardado</span>}
                {st === 'error' && <span className="mts-error">⚠ No se pudo guardar. <button type="button" className="lnk" onClick={() => void persist(item.stepKey, drafts[item.stepKey] ?? EMPTY).catch(() => undefined)}>Reintentar</button></span>}
              </div>
            </li>
          );
        })}
      </ol>
      {failureBlock && (
        <section className="mts-failures" aria-label="Pasos con falla">
          <div className="mts-failures-head">
            <h3 className="h3">Pasos con falla</h3>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => void copy()}>Copiar</button>
            {copyMsg && <span className="small" role="status">{copyMsg}</span>}
          </div>
          <pre className="mts-failures-text">{failureBlock}</pre>
          {failureActions?.({ failed: items.filter(i => i.result === 'fail'), flush })}
        </section>
      )}
    </section>
  );
}

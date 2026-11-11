import { useEffect, useState } from 'react';
import { api, type LessonAutoImproveAuthorization } from '../lib/api.ts';

/**
 * EN-022 · Autorización permanente para que el Portal mejore solo las lecciones que reinciden o quedan refutadas.
 * Viene desactivada. Cada mejora es una llamada a un modelo y tiene costo; el Portal no pasa nunca de los topes
 * mensuales. Sin autorización, o con el tope agotado, no hace ninguna llamada: la mejora queda como una decisión
 * pendiente que se acepta con un clic.
 */
export function LessonAutoImproveSettings({ slug }: { slug: string }) {
  const [auth, setAuth] = useState<LessonAutoImproveAuthorization | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [calls, setCalls] = useState('0');
  const [usd, setUsd] = useState('0');
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const apply = (a: LessonAutoImproveAuthorization) => { setAuth(a); setEnabled(a.enabled); setCalls(String(a.monthlyCallCap)); setUsd(String(a.monthlyUsdCap)); };
  useEffect(() => {
    setState('loading');
    void api.lessonAutoImprove(slug).then(a => { apply(a); setState('idle'); }).catch((e: Error) => { setError(e.message); setState('error'); });
  }, [slug]);

  const callsN = Number(calls); const usdN = Number(usd);
  const valid = Number.isFinite(callsN) && callsN >= 0 && Number.isInteger(callsN) && Number.isFinite(usdN) && usdN >= 0;
  const dirty = !!auth && (enabled !== auth.enabled || callsN !== auth.monthlyCallCap || usdN !== auth.monthlyUsdCap);
  const busy = state === 'loading' || state === 'saving';

  const save = () => {
    if (!valid) return;
    if (enabled && !confirm(`Autorizas al Portal a mejorar solo las lecciones que reinciden, con un máximo de ${callsN} llamada(s) al mes con tu suscripción y ${usdN.toFixed(2)} USD al mes de la API. Cada mejora es una llamada a un modelo y tiene costo. ¿Guardar?`)) return;
    setState('saving'); setError(null);
    api.setLessonAutoImprove(slug, { enabled, monthlyCallCap: callsN, monthlyUsdCap: usdN })
      .then(a => { apply(a); setState('saved'); })
      .catch((e: Error) => { setError(e.message); setState('error'); });
  };

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="leccion-automejora-ajustes">
    <p style={{ margin: 0 }}>Cuando una lección aplicada reincide en 2 o más tareas, o queda refutada, el Curador redacta su versión siguiente y la aplica sola en la plantilla y en los agentes. <strong>Cada mejora es una llamada a un modelo y tiene costo.</strong> Viene desactivada: sin esta autorización, o con el tope agotado, no se hace ninguna llamada y la mejora queda en Decisiones para que la aceptes con un clic.</p>
    <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input type="checkbox" checked={enabled} disabled={busy} onChange={e => { setEnabled(e.target.checked); if (state === 'saved' || state === 'error') setState('idle'); }} />
      Mejorar las lecciones solas dentro de estos topes
    </label>
    <label htmlFor="lai-calls">Tope mensual de llamadas a la suscripción</label>
    <input id="lai-calls" className="input" type="number" min={0} step={1} value={calls} disabled={busy} onChange={e => { setCalls(e.target.value); if (state === 'saved') setState('idle'); }} />
    <label htmlFor="lai-usd">Tope mensual de la API (USD)</label>
    <input id="lai-usd" className="input" type="number" min={0} step={0.01} value={usd} disabled={busy} onChange={e => { setUsd(e.target.value); if (state === 'saved') setState('idle'); }} />
    {auth && <span className="muted">Usado este mes: {auth.usage.calls} llamada(s) y {auth.usage.usd.toFixed(2)} USD.</span>}
    {!valid && <span role="alert">Los topes deben ser números mayores o iguales que 0 (las llamadas, un número entero).</span>}
    <p role="status" aria-live="polite" style={{ margin: 0 }}>{state === 'loading' ? 'Cargando…' : state === 'saving' ? 'Guardando…' : state === 'saved' ? 'Guardado.' : state === 'error' ? `Error: ${error ?? 'no se pudo guardar.'}` : null}</p>
    <div><button type="button" className="btn btn-secondary btn-sm" disabled={busy || !valid || !dirty} onClick={save}>{state === 'saving' ? 'Guardando…' : 'Guardar autorización'}</button></div>
  </div>;
}

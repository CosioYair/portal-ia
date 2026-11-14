import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AcceptanceResult, AcceptanceView } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, Icon, Notice, Spinner } from '../components/ui.tsx';
import { PageHeader } from '../components/kit.tsx';
import '../acceptance.css';

/**
 * Portal IA 3 · Recorrido de aceptación: lo pruebas tú, en las pantallas reales, y anotas si funciona. Cada paso recuerda
 * lo que pediste, te lleva a donde se prueba y dice qué deberías ver. Nada se marca solo. Si algo falla, lo cuentas aquí.
 */
export function Acceptance() {
  const [v, setV] = useState<AcceptanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [stepError, setStepError] = useState<Record<string, string>>({});
  useEffect(() => { api.acceptance().then(x => { setV(x); setDraft(Object.fromEntries(x.steps.map(s => [s.id, s.mark.comment]))); }).catch((e: any) => setError(e?.message ?? 'No se pudo cargar el recorrido.')); }, []);
  const mark = async (id: string, result: AcceptanceResult | null) => {
    const comment = (draft[id] ?? '').trim();
    if (result === 'fail' && !comment) { setStepError(x => ({ ...x, [id]: 'Cuenta qué falló para que se pueda corregir.' })); document.getElementById(`acc-c-${id}`)?.focus(); return; }
    setBusy(id); setStepError(x => ({ ...x, [id]: '' }));
    try { setV(await api.acceptanceMark(id, result, comment)); } catch (e: any) { setStepError(x => ({ ...x, [id]: e?.message ?? 'No se pudo guardar.' })); } finally { setBusy(null); }
  };
  const groups = v ? [...new Set(v.steps.map(s => s.group))] : [];
  return (
    <Shell crumb="Recorrido de aceptación">
      <main className="page acc-page">
        <PageHeader icon={Icon.gauge(22)} tone="work" eyebrow="Portal IA 3" title="Recorrido de aceptación"
          description="Prueba tú mismo lo que pediste, en las pantallas reales, y anota si funciona. Nada se marca solo." />
        {error && <Notice kind="err">{error}</Notice>}
        {!v && !error && <Spinner label="Cargando el recorrido…" />}
        {v && <>
          <section className="acc-summary card" aria-live="polite">
            <div className="acc-bar" role="img" aria-label={`${v.summary.ok} de ${v.summary.total} pasos correctos, ${v.summary.fail} con fallo, ${v.summary.pending} sin probar`}>
              <span className="acc-bar-ok" style={{ width: `${(v.summary.ok / v.summary.total) * 100}%` }} />
              <span className="acc-bar-fail" style={{ width: `${(v.summary.fail / v.summary.total) * 100}%` }} />
            </div>
            <div className="acc-counts">
              <Chip tone="ok">{v.summary.ok} correctos</Chip>
              <Chip tone={v.summary.fail ? 'err' : ''}>{v.summary.fail} con fallo</Chip>
              <Chip>{v.summary.pending} sin probar</Chip>
            </div>
            <p className="acc-verdict">{v.summary.accepted ? 'Has dado por bueno todo el recorrido.' : v.summary.fail ? 'Hay pasos con fallo: quedan anotados aquí con tu comentario hasta que se corrijan y los pruebes de nuevo.' : 'Aún hay pasos sin probar. Puedes hacerlos en el orden que quieras y volver cuando quieras: lo marcado se guarda.'}</p>
          </section>
          {groups.map(g => (
            <section key={g} className="acc-group" aria-labelledby={`acc-g-${g}`}>
              <h2 className="acc-group-h" id={`acc-g-${g}`}>{g}</h2>
              <ol className="acc-list">
                {v.steps.filter(s => s.group === g).map(s => (
                  <li key={s.id} className={`acc-step card acc-${s.mark.result ?? 'pending'}`}>
                    <div className="acc-step-head">
                      <h3 className="acc-title">{s.title}</h3>
                      <Chip xs tone={s.mark.result === 'ok' ? 'ok' : s.mark.result === 'fail' ? 'err' : ''}>{s.mark.result === 'ok' ? 'Funciona' : s.mark.result === 'fail' ? 'Falla' : 'Sin probar'}</Chip>
                    </div>
                    <p className="acc-asked"><span className="acc-label">Lo que pediste</span> {s.asked}</p>
                    <div className="acc-cols">
                      <div><span className="acc-label">Qué hacer</span><ol className="acc-how">{s.how.map((h, i) => <li key={i}>{h}</li>)}</ol></div>
                      <div><span className="acc-label">Qué deberías ver</span><p className="acc-expect">{s.expect}</p></div>
                    </div>
                    <div className="acc-actions">
                      <Link className="btn btn-secondary btn-sm acc-btn" to={s.to}>{s.go}</Link>
                      <button type="button" className={`btn btn-sm acc-btn ${s.mark.result === 'ok' ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={s.mark.result === 'ok'} disabled={busy === s.id} onClick={() => void mark(s.id, s.mark.result === 'ok' ? null : 'ok')}>Funciona</button>
                      <button type="button" className={`btn btn-sm acc-btn ${s.mark.result === 'fail' ? 'btn-danger' : 'btn-secondary'}`} aria-pressed={s.mark.result === 'fail'} disabled={busy === s.id} onClick={() => void mark(s.id, s.mark.result === 'fail' ? null : 'fail')}>No funciona</button>
                    </div>
                    <label className="acc-comment" htmlFor={`acc-c-${s.id}`}><span className="acc-label">Tu comentario {s.mark.result === 'fail' ? '(qué falló)' : '(opcional)'}</span>
                      <textarea id={`acc-c-${s.id}`} className="input" rows={2} value={draft[s.id] ?? ''} onChange={e => setDraft(x => ({ ...x, [s.id]: e.target.value }))} /></label>
                    {/* El comentario se guarda al marcar el paso o con su botón; nunca al salir del campo (se perdían clics y atrapaba el foco). */}
                    {(draft[s.id] ?? '').trim() !== s.mark.comment && <div className="acc-actions"><button type="button" className="btn btn-ghost btn-sm" disabled={busy === s.id} onClick={() => void mark(s.id, s.mark.result)}>Guardar comentario</button></div>}
                    {stepError[s.id] && <Notice kind="err">{stepError[s.id]}</Notice>}
                    {s.mark.at && <p className="acc-at">Marcado el {new Date(s.mark.at).toLocaleString('es-MX')}</p>}
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </>}
      </main>
    </Shell>
  );
}

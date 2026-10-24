import { useEffect, useState } from 'react';
import type { AssessmentEstimate, Process } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Chip, Icon, Notice } from './ui.tsx';

/**
 * Evaluación inicial del proyecto (HU-004): el único punto donde se autoriza consumo real de IA.
 * Muestra agentes, modelos y estimación; el usuario fija el presupuesto y autoriza explícitamente.
 */
export function AssessmentCard({ projectId, hasRepo, compact }: { projectId: string; hasRepo: boolean; compact?: boolean }) {
  const { status, flash, navigate } = useApp();
  const slug = status.workspace!.slug;
  const [est, setEst] = useState<AssessmentEstimate | null>(null);
  const [existing, setExisting] = useState<Process | null>(null);
  const [budget, setBudget] = useState('');
  const [auth, setAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.assessmentEstimate(slug, projectId).then(e => { setEst(e); setBudget(e.suggestedBudgetUsd.toFixed(2)); }).catch(e => setError(e.message));
    api.processes(slug, projectId).then(ps => setExisting(ps.find(p => p.kind === 'initial_assessment') ?? null)).catch(() => {});
  }, [slug, projectId, hasRepo]);

  const start = async () => {
    if (!auth) return; setBusy(true); setError(null);
    try {
      const proc = await api.createAssessment(slug, projectId);
      const authorized = await api.authorizeProcess(slug, proc.id, Number(budget));
      flash(`Evaluación autorizada · presupuesto ${fmtUsd(authorized.budgetUsd)}`);
      navigate(`/procesos/${authorized.id}`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (existing && (existing.status === 'running' || existing.status === 'done')) {
    const done = existing.status === 'done';
    return <section className="card">
      <div className="card-h"><div><div className="h3">Evaluación inicial del proyecto</div><div className="small muted">{done ? 'Completada. Sus documentos están en Conocimiento.' : 'En ejecución…'}</div></div>
        <Chip tone={done ? 'ok' : 'warn'} dot={done ? 'ok' : 'pulse'}>{done ? 'Completada' : 'En ejecución'}</Chip></div>
      <div className="card-b" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <span className="sm13 med">Consumo: <span className="mono">{existing.inputTokens + existing.outputTokens} tokens · {fmtUsd(existing.spentUsd)}</span> de {fmtUsd(existing.budgetUsd)} autorizados.</span>
        <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-secondary btn-sm" onClick={() => navigate(`/procesos/${existing.id}`)}>Ver proceso</button>{done && <button className="btn btn-primary btn-sm" onClick={() => navigate('/conocimiento')}>Ver dirección y backlog</button>}</div>
      </div>
    </section>;
  }

  return (
    <section className="card">
      <div className="card-h">
        <div><div className="h3">Evaluación inicial del proyecto</div><div className="small muted">Primer trabajo real del equipo: analizar la idea, el código y el diseño, y proponer dirección y backlog.</div></div>
        <Chip tone="warn" xs>consume IA · requiere autorización</Chip>
      </div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!compact && <p className="sm13 med" style={{ lineHeight: 1.5 }}>Cuatro pasos de solo lectura: el Coordinador analiza producto y dirección; el Arquitecto evalúa la arquitectura frente a la aprobada; el Diseñador revisa la dirección de diseño; el Coordinador sintetiza y propone un backlog priorizado. {hasRepo ? 'Los agentes leerán el repositorio registrado (solo lectura).' : 'No hay repositorio registrado: trabajarán solo con los objetivos y el contexto aprobado; registrar el repositorio antes mejora mucho el resultado.'}</p>}
        {error && <Notice kind="err">{error}</Notice>}
        {existing && (existing.status === 'failed' || existing.status === 'budget_exceeded') && <Notice kind="warn">El intento anterior terminó con incidencias ({existing.status === 'budget_exceeded' ? 'presupuesto agotado' : 'error del proveedor'}): {existing.error} <button className="lnk" onClick={() => navigate(`/procesos/${existing.id}`)}>Ver detalle</button>. Puedes corregir la causa y volver a autorizar.</Notice>}
        {est && <div style={{ display: 'flex', flexDirection: 'column' }}>
          {est.steps.map((s, i) => <div key={i} className="rrow"><span className="mono small muted">{String(i + 1).padStart(2, '0')}</span><span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}><span style={{ fontWeight: 500 }}>{s.title}</span><span className="small muted">{s.agentName} · <span className="mono">{s.model}</span></span></span><span className="mono small muted">≈ {fmtUsd(s.estimatedUsd)}</span></div>)}
          <div className="kv" style={{ marginTop: 6 }}><span>Contexto del repositorio</span><span className="mono">{est.contextChars ? `${Math.round(est.contextChars / 1000)} k caracteres` : 'sin repositorio'}</span></div>
          <div className="kv"><span>Costo estimado total</span><span className="mono">≈ {fmtUsd(est.estimatedUsd)} <span className="muted">(aprox., según tarifas públicas)</span></span></div>
        </div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 14, alignItems: 'end' }}>
          <div><label className="label" htmlFor="budget">Presupuesto máximo (USD)</label><input id="budget" className="input mono" type="number" min={0.1} step={0.5} value={budget} onChange={e => setBudget(e.target.value)} /><div className="help">El proceso se detiene entre pasos si el gasto se acerca a este límite.</div></div>
          <div className="help" style={{ paddingBottom: 26 }}>Puedes bajar el costo cambiando el modelo de los agentes en Equipo de IA antes de autorizar.</div>
        </div>
        <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo que los agentes <strong>Coordinador del Proyecto</strong>, <strong>Arquitecto de Software</strong> y <strong>Diseñador UX/UI</strong> realicen llamadas al proveedor de IA conectado, en modo solo lectura, hasta un máximo de <strong>{fmtUsd(Number(budget) || 0)}</strong>. Los agentes volverán a estar inactivos al terminar.</span></label>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={start} disabled={!auth || busy || !est || !(Number(budget) > 0)}>{busy ? <span className="spin spin-light" /> : Icon.arrow()}{busy ? 'Autorizando…' : 'Autorizar y ejecutar la evaluación'}</button>
          <span className="small muted">Podrás cancelarla en cualquier momento; se detiene al terminar el paso en curso.</span>
        </div>
      </div>
    </section>
  );
}

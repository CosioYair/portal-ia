import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { OrgAction, OrgDecision, OrgEvaluationStatus, OrgProposal, OrgTarget } from '@portal-ia/domain';
import { api, ApiError, type OrgEvaluationEstimate, type OrgEvaluationFilter, type OrgEvaluationView } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Chip, Icon, Notice } from './ui.tsx';
import { Markdown } from './Markdown.tsx';

/**
 * HU-159 · Evaluación organizativa. Selector de ámbito (empresa o proyecto), estimación sin costo, autorización explícita
 * con presupuesto, seguimiento del proceso, propuestas con decisión individual e historial. Decidir NO aplica cambios.
 */
const ACTION: Record<OrgAction, string> = { add: 'Añadir', merge: 'Fusionar', retire: 'Retirar', adjust: 'Ajustar' };
const TARGET: Record<OrgTarget, string> = { agent: 'agente', department: 'departamento' };
const STATUS: Record<OrgEvaluationStatus, { label: string; tone: '' | 'ok' | 'warn' | 'err'; dot: '' | 'ok' | 'warn' | 'err' | 'pulse' }> = {
  pending_authorization: { label: 'Pendiente de autorización', tone: 'warn', dot: 'warn' },
  running: { label: 'En curso', tone: 'warn', dot: 'pulse' },
  done: { label: 'Completada', tone: 'ok', dot: 'ok' },
  failed: { label: 'Fallida', tone: 'err', dot: 'err' },
  cancelled: { label: 'Cancelada', tone: '', dot: '' }
};
const DECISION: Record<OrgDecision, { label: string; tone: '' | 'ok' | 'err' }> = { pending: { label: 'Pendiente', tone: '' }, accepted: { label: 'Aceptada', tone: 'ok' }, rejected: { label: 'Rechazada', tone: 'err' } };
const finished = (s: OrgEvaluationStatus) => s === 'done' || s === 'failed' || s === 'cancelled';
const usd = (n: number) => `${n.toFixed(n < 1 ? 3 : 2)} USD`;
const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Error inesperado');
const backendNotReady = (e: unknown) => e instanceof ApiError && e.body?.code === 'backend_not_ready';
const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export function OrgEvaluationPanel({ slug, defaultProjectId, onClose }: { slug: string; defaultProjectId: string | null; onClose: () => void }) {
  const { projects, flash } = useApp();
  const projectName = (id: string | null) => (id ? projects.find(p => p.id === id)?.name ?? id : null);
  const scopeLabel = (ev: { scopeKind: string; projectId: string | null }) => (ev.scopeKind === 'project' ? `Proyecto «${projectName(ev.projectId)}»` : 'Empresa completa');

  const [scope, setScope] = useState<string>(defaultProjectId ?? '');
  const [estimate, setEstimate] = useState<OrgEvaluationEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estErr, setEstErr] = useState<unknown>(null);
  const [authorized, setAuthorized] = useState(false);
  const [budget, setBudget] = useState('');
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<unknown>(null);
  const [current, setCurrent] = useState<OrgEvaluationView | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [history, setHistory] = useState<OrgEvaluationView[] | null>(null);
  const [histErr, setHistErr] = useState<string | null>(null);
  const [histFilter, setHistFilter] = useState<string>('all');

  // Estimación sin costo cada vez que cambia el ámbito; la autorización se reinicia.
  useEffect(() => {
    let alive = true;
    setEstimate(null); setEstErr(null); setAuthorized(false); setEstimating(true);
    api.orgEvaluationEstimate(slug, scope || null)
      .then(e => { if (!alive) return; setEstimate(e); setBudget(String(e.suggestedBudgetUsd)); })
      .catch(e => { if (alive) setEstErr(e); })
      .finally(() => { if (alive) setEstimating(false); });
    return () => { alive = false; };
  }, [slug, scope]);

  const loadHistory = useCallback(() => {
    const f: OrgEvaluationFilter = histFilter === 'all' ? { scope: 'all' } : histFilter === 'workspace' ? { scope: 'workspace' } : { projectId: histFilter };
    return api.orgEvaluations(slug, f).then(list => { setHistory(list); setHistErr(null); }).catch(e => setHistErr(errMsg(e)));
  }, [slug, histFilter]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  // Sondeo mientras la evaluación está en curso; se detiene al terminar.
  const currentId = current?.id ?? null;
  const running = current ? !finished(current.status) : false;
  useEffect(() => {
    if (!currentId || !running) return;
    const t = window.setInterval(() => {
      api.orgEvaluation(slug, currentId).then(ev => { setCurrent(ev); if (finished(ev.status)) void loadHistory(); }).catch(() => { /* se reintenta en el siguiente ciclo */ });
    }, 2500);
    return () => window.clearInterval(t);
  }, [slug, currentId, running, loadHistory]);

  const budgetNum = Number(budget.replace(',', '.'));
  const budgetOk = Number.isFinite(budgetNum) && budgetNum > 0;
  const canStart = !!estimate && authorized && budgetOk && !starting && !running;

  const start = async () => {
    if (!canStart) return;
    setStarting(true); setStartErr(null);
    try { const ev = await api.startOrgEvaluation(slug, scope || null, budgetNum); setCurrent(ev); setAuthorized(false); void loadHistory(); }
    catch (e) { setStartErr(e); }
    finally { setStarting(false); }
  };

  const cancel = async () => {
    if (!current?.process) return;
    try { await api.cancelProcess(slug, current.process.id); flash('Cancelación solicitada'); }
    catch (e) { flash(errMsg(e), 'err'); }
  };

  const open = async (id: string) => {
    try { setCurrent(await api.orgEvaluation(slug, id)); } catch (e) { flash(errMsg(e), 'err'); }
  };

  const decide = async (p: OrgProposal, decision: Exclude<OrgDecision, 'pending'>) => {
    if (!current) return;
    setDeciding(p.id);
    try {
      const r = await api.decideOrgProposal(slug, current.id, p.id, decision);
      setCurrent(c => (c && c.id === r.evaluation.id ? { ...c, ...r.evaluation, process: c.process } : c));
      flash(decision === 'accepted' ? 'Propuesta aceptada (pendiente de aplicar desde Equipo)' : 'Propuesta rechazada');
      void loadHistory();
    } catch (e) { flash(errMsg(e), 'err'); }
    finally { setDeciding(null); }
  };

  const errorNotice = (e: unknown) => backendNotReady(e)
    ? <Notice kind="warn">{errMsg(e)} Revisa la configuración en <Link className="lnk" to="/configuracion/proveedor">Proveedores</Link> antes de volver a intentarlo.</Notice>
    : <Notice kind="err">{errMsg(e)}</Notice>;

  return (
    <section className="card" aria-label="Evaluar organización">
      <div className="card-h">
        <div className="h3">Evaluar organización</div>
        <button className="btn btn-secondary" onClick={onClose} aria-label="Cerrar">{Icon.x()}Cerrar</button>
      </div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p className="med" style={{ margin: 0 }}>El Gestor Organizacional (y, si eliges un proyecto, también su Coordinador) analiza el repositorio, la línea base, el backlog, la actividad y los agentes actuales con sus papeles, permisos y jerarquía. Después propone añadir, fusionar, retirar o ajustar agentes o departamentos.</p>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="small muted">Ámbito</span>
            <select className="input" value={scope} onChange={e => setScope(e.target.value)} disabled={running || starting}>
              <option value="">Empresa completa</option>
              {projects.map(p => <option key={p.id} value={p.id}>Proyecto: {p.name}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="small muted">Presupuesto máximo (USD)</span>
            <input className="input mono" type="number" min="0.01" step="0.05" value={budget} onChange={e => setBudget(e.target.value)} disabled={!estimate || running || starting} style={{ width: 140 }} />
          </label>
        </div>

        {estimating && <div className="small muted"><span className="spin" aria-hidden="true" /> Estimando costo…</div>}
        {!!estErr && errorNotice(estErr)}
        {estimate && <div className="small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div>Costo estimado: <strong className="mono">{usd(estimate.estimatedUsd)}</strong> (aproximado) · presupuesto sugerido <span className="mono">{usd(estimate.suggestedBudgetUsd)}</span></div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>{estimate.steps.map(s => <li key={s.title}>{s.title} · {s.agentName} · <span className="mono">{s.model}</span> · ≈ {usd(s.estimatedUsd)}</li>)}</ul>
        </div>}
        {estimate && !budgetOk && <Notice kind="warn">Indica un presupuesto mayor que 0 USD.</Notice>}

        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={authorized} onChange={e => setAuthorized(e.target.checked)} disabled={!estimate || running || starting} />
          <span className="sm13">Autorizo esta evaluación, que hará llamadas a modelos de IA con costo, hasta el presupuesto indicado.</span>
        </label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={!canStart} onClick={start} title={canStart ? undefined : 'Necesitas la estimación, la casilla de autorización y un presupuesto mayor que 0'}>
            {starting ? 'Iniciando…' : 'Autorizar y evaluar'}
          </button>
        </div>
        {!!startErr && errorNotice(startErr)}

        {current && <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <strong>{scopeLabel(current)}</strong>
            <Chip xs tone={STATUS[current.status].tone} dot={STATUS[current.status].dot}>{STATUS[current.status].label}</Chip>
            <span className="small muted">{when(current.createdAt)}</span>
            {current.process && <span className="small mono muted">gastado {usd(current.process.spentUsd)} de {usd(current.process.budgetUsd)}</span>}
            {current.process && <Link className="lnk small" to={`/procesos/${current.process.id}`}>Ver proceso</Link>}
          </div>
          {running && <>
            <div className="small muted"><span className="spin" aria-hidden="true" /> El equipo está analizando la organización. Esta vista se actualiza sola.</div>
            {current.process?.steps && <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>{current.process.steps.map(s => <li key={s.title}>{s.title} · {s.agentName} · {s.status}</li>)}</ul>}
            <div><button className="btn btn-secondary" onClick={cancel}>Cancelar evaluación</button></div>
          </>}
          {(current.status === 'failed' || current.status === 'cancelled') && <Notice kind={current.status === 'failed' ? 'err' : 'warn'}>{current.status === 'failed' ? 'La evaluación falló' : 'La evaluación se canceló'}: {current.error ?? current.process?.error ?? 'sin motivo registrado'}.</Notice>}
          {current.status === 'done' && <>
            {current.summary && <Markdown text={current.summary} />}
            {current.knowledgeDocId && <div><Link className="lnk" to={`/empresa/${slug}/proyecto/${current.anchorProjectId}/conocimiento`}>{Icon.book()} Ver el documento completo en Conocimiento{current.scopeKind === 'workspace' ? ` (proyecto «${projectName(current.anchorProjectId)}»)` : ''}</Link></div>}
            <Notice kind="info">Aceptar no crea ni elimina nada; aplícalo desde Equipo.</Notice>
            {current.proposals.length === 0
              ? <div className="small muted">Sin propuestas: el Gestor considera adecuada la organización actual.</div>
              : <div style={{ overflowX: 'auto' }}><table className="tbl">
                <thead><tr><th>Propuesta</th><th>Justificación</th><th>Decisión</th></tr></thead>
                <tbody>{current.proposals.map(p => <tr key={p.id}>
                  <td><strong>{ACTION[p.action]} {TARGET[p.target]}</strong><div className="med">{p.subject}</div>{p.details && <div className="small muted">{p.details}</div>}</td>
                  <td className="med" style={{ maxWidth: '48ch' }}>{p.rationale}</td>
                  <td>{p.decision === 'pending'
                    ? <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-primary" disabled={deciding === p.id} onClick={() => decide(p, 'accepted')}>Aceptar</button>
                      <button className="btn btn-secondary" disabled={deciding === p.id} onClick={() => decide(p, 'rejected')}>Rechazar</button>
                    </div>
                    : <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <Chip xs tone={DECISION[p.decision].tone}>{DECISION[p.decision].label}{p.decidedAt ? ` · ${when(p.decidedAt)}` : ''}</Chip>
                      {p.decision === 'accepted' && p.action === 'add' && p.target === 'agent' && <Link className="lnk small" to="/equipo/nuevo">Crear el agente</Link>}
                    </div>}</td>
                </tr>)}</tbody>
              </table></div>}
          </>}
        </div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="h3" style={{ fontSize: 14 }}>Historial de evaluaciones</div>
            <select className="input" value={histFilter} onChange={e => setHistFilter(e.target.value)} aria-label="Filtrar historial">
              <option value="all">Todas</option>
              <option value="workspace">Solo de empresa</option>
              {projects.map(p => <option key={p.id} value={p.id}>Proyecto: {p.name}</option>)}
            </select>
          </div>
          {histErr && <Notice kind="err">{histErr}</Notice>}
          {!history && !histErr && <div className="small muted"><span className="spin" aria-hidden="true" /> Cargando historial…</div>}
          {history && history.length === 0 && <div className="small muted">Aún no hay evaluaciones en este filtro.</div>}
          {history && history.length > 0 && <div style={{ overflowX: 'auto' }}><table className="tbl">
            <thead><tr><th>Fecha</th><th>Ámbito</th><th>Estado</th><th>Propuestas</th><th /></tr></thead>
            <tbody>{history.map(ev => {
              const decided = ev.proposals.filter(p => p.decision !== 'pending').length;
              return <tr key={ev.id}>
                <td className="mono small">{when(ev.createdAt)}</td>
                <td className="med">{scopeLabel(ev)}</td>
                <td><Chip xs tone={STATUS[ev.status].tone} dot={STATUS[ev.status].dot}>{STATUS[ev.status].label}</Chip></td>
                <td className="small">{ev.proposals.length} ({decided} decididas)</td>
                <td><button className="lnk" onClick={() => open(ev.id)}>{current?.id === ev.id ? 'Abierta' : 'Abrir'}</button></td>
              </tr>;
            })}</tbody>
          </table></div>}
        </div>
      </div>
    </section>
  );
}

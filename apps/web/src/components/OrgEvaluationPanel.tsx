import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { OrgAction, OrgDecision, OrgEvaluationStatus, OrgProposal, OrgTarget } from '@portal-ia/domain';
import { api, ApiError, type OrgChange, type OrgEvaluationEstimate, type OrgEvaluationFilter, type OrgEvaluationView, type OrgProposalResult } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Chip, Icon, Notice } from './ui.tsx';
import { Markdown } from './Markdown.tsx';

/**
 * HU-159 · Evaluación organizativa. Selector de ámbito (empresa o proyecto), estimación sin costo, autorización explícita
 * con presupuesto, seguimiento del proceso, propuestas con decisión individual e historial. Aceptar (con confirmación
 * explícita y sin costo de IA) APLICA la propuesta con su configuración y permite «Deshacer» y «Volver a aplicar»;
 * rechazar (con confirmación) solo registra la decisión y se puede «Reabrir».
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
const listOr = (l?: string[]) => (l && l.length ? l.join(', ') : 'ninguna');
const OP: Record<OrgChange['op'], string> = { create: 'Creado', update: 'Ajustado', retire: 'Retirado', unretire: 'Reactivado' };
const APP: Record<'applied' | 'reverted' | 'failed', { label: string; tone: '' | 'ok' | 'err' }> = { applied: { label: 'Aplicada', tone: 'ok' }, reverted: { label: 'Revertida', tone: '' }, failed: { label: 'Error al aplicar', tone: 'err' } };

/** Mismo criterio que splitSubjects del servidor (orgProposalApply.ts): « + » o comas. */
const splitSubjects = (s: string) => s.split(/\s*\+\s*|\s*,\s*/).map(x => x.trim()).filter(Boolean);
/** Lo que se conserva en una fusión, igual que planProposal: keep; si falta, el primer sujeto (o spec.department en departamentos). */
function keptOf(p: OrgProposal): string {
  if (p.keep) return p.keep;
  if (p.target === 'department' && p.spec?.department) return p.spec.department;
  return splitSubjects(p.subject)[0] ?? p.subject;
}

/** Qué hará «Aceptar y aplicar» (texto de la confirmación). */
function impact(p: OrgProposal): string {
  const s = `«${p.subject}»`;
  if (!p.spec && (p.action === 'add' || p.action === 'adjust')) return 'no hay configuración propuesta (evaluación anterior), así que solo se registrará la decisión';
  if (p.action === 'add') return p.target === 'agent' ? `se creará el agente «${p.spec?.name ?? p.subject}»` : `se crearán o etiquetarán los agentes del departamento ${s}`;
  if (p.action === 'adjust') return `se ajustarán la configuración y la jerarquía de ${s}`;
  if (p.action === 'retire') return `se retirará ${s} (se desactiva sin borrarlo y se puede revertir)`;
  return `se conservará «${keptOf(p)}» con la configuración propuesta y se retirará el resto de ${s}`;
}

function SpecView({ p }: { p: OrgProposal }) {
  const s = p.spec;
  if (!s) return <div className="small muted">Sin configuración propuesta.</div>;
  const rows: [string, string | undefined][] = [
    ['Nombre', s.name ? `${s.name}${s.role ? ` · ${s.role}` : ''}` : undefined],
    ['Especialización', s.specialization],
    ['Reporta a', s.reportsTo],
    ['Herramientas', s.tools ? listOr(s.tools) : undefined],
    ['Capacidades', s.capabilities ? listOr(s.capabilities) : undefined],
    ['Modelo', s.model ? `${s.model}${s.effort ? ` (${s.effort})` : ''}` : undefined],
    ['Departamento', s.department],
    ['Se conserva', p.keep],
    ['Agentes nuevos', s.agents?.length ? s.agents.map(a => a.name).join(', ') : undefined],
    ['Miembros', s.members?.length ? s.members.join(', ') : undefined],
    ['Responsabilidades', s.responsibilities?.length ? s.responsibilities.join('; ') : undefined]
  ];
  return <div className="small" style={{ marginTop: 6 }}>
    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px' }}>
      {rows.filter(r => r[1]).map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt className="muted">{k}</dt><dd style={{ margin: 0 }}>{v}</dd></div>)}
    </dl>
    {p.specWarnings?.length ? <div className="muted" style={{ marginTop: 4 }}>⚠ {p.specWarnings.join(' ')}</div> : null}
  </div>;
}

export function OrgEvaluationPanel({ slug, defaultProjectId, onClose }: { slug: string; defaultProjectId: string | null; onClose: () => void }) {
  const { projects, flash, status } = useApp();
  // Ancla de una evaluación de empresa: el proyecto activo (el servidor comprueba que pertenece a la empresa).
  const anchorId = status.project?.id ?? defaultProjectId ?? null;
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
  const [deciding, setDeciding] = useState<{ id: string; decision: Exclude<OrgDecision, 'pending'> } | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [acting, setActing] = useState<{ id: string; kind: 'reopen' | 'reapply' } | null>(null);
  /** Confirmación en curso: id de la propuesta (aceptar), «reject:id», «undo:id», «reopen:id» o «reapply:id». */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [propErr, setPropErr] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<OrgEvaluationView[] | null>(null);
  const [histErr, setHistErr] = useState<string | null>(null);
  const [histFilter, setHistFilter] = useState<string>('all');

  // Estimación sin costo cada vez que cambia el ámbito; la autorización se reinicia.
  useEffect(() => {
    let alive = true;
    setEstimate(null); setEstErr(null); setAuthorized(false); setEstimating(true);
    api.orgEvaluationEstimate(slug, scope || null, anchorId)
      .then(e => { if (!alive) return; setEstimate(e); setBudget(String(e.suggestedBudgetUsd)); })
      .catch(e => { if (alive) setEstErr(e); })
      .finally(() => { if (alive) setEstimating(false); });
    return () => { alive = false; };
  }, [slug, scope, anchorId]);

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
    try { const ev = await api.startOrgEvaluation(slug, scope || null, budgetNum, anchorId); setCurrent(ev); setAuthorized(false); void loadHistory(); }
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

  const mergeResult = (r: OrgProposalResult) => setCurrent(c => (c && c.id === r.evaluation.id ? { ...c, ...r.evaluation, process: c.process } : c));
  const clearErr = (id: string) => setPropErr(x => { const n = { ...x }; delete n[id]; return n; });

  const decide = async (p: OrgProposal, decision: Exclude<OrgDecision, 'pending'>) => {
    if (!current) return;
    setDeciding({ id: p.id, decision }); setConfirming(null); clearErr(p.id);
    try {
      const r = await api.decideOrgProposal(slug, current.id, p.id, decision);
      mergeResult(r);
      flash(decision === 'rejected' ? 'Propuesta rechazada (sin cambios en la organización)' : r.proposal.application?.status === 'applied' ? 'Propuesta aceptada y aplicada' : 'Propuesta aceptada');
      void loadHistory();
    } catch (e) { setPropErr(x => ({ ...x, [p.id]: errMsg(e) })); flash(errMsg(e), 'err'); }
    finally { setDeciding(null); }
  };

  const undo = async (p: OrgProposal) => {
    if (!current) return;
    setUndoing(p.id); setConfirming(null); clearErr(p.id);
    try { mergeResult(await api.undoOrgProposal(slug, current.id, p.id)); flash('Cambios deshechos: se restauró el estado previo'); void loadHistory(); }
    catch (e) { setPropErr(x => ({ ...x, [p.id]: errMsg(e) })); flash(errMsg(e), 'err'); }
    finally { setUndoing(null); }
  };

  const act = async (p: OrgProposal, kind: 'reopen' | 'reapply') => {
    if (!current) return;
    setActing({ id: p.id, kind }); setConfirming(null); clearErr(p.id);
    try {
      mergeResult(kind === 'reopen' ? await api.reopenOrgProposal(slug, current.id, p.id) : await api.reapplyOrgProposal(slug, current.id, p.id));
      flash(kind === 'reopen' ? 'Propuesta reabierta: vuelve a estar pendiente' : 'Propuesta aplicada de nuevo (puedes deshacerla)');
      void loadHistory();
    } catch (e) { setPropErr(x => ({ ...x, [p.id]: errMsg(e) })); flash(errMsg(e), 'err'); }
    finally { setActing(null); }
  };

  const decisionCell = (p: OrgProposal) => {
    const busy = deciding?.id === p.id || undoing === p.id || acting?.id === p.id;
    const app = p.application;
    const err = propErr[p.id] ?? (p.decision === 'pending' && app?.status === 'failed' ? app.error : null);
    if (p.decision === 'pending') return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {p.reopenedAt && <Chip xs>Reabierta · {when(p.reopenedAt)}</Chip>}
      {deciding?.id === p.id
        ? <div className="small muted"><span className="spin" aria-hidden="true" /> {deciding.decision === 'accepted' ? 'Aplicando…' : 'Rechazando…'}</div>
        : confirming === p.id
          ? <>
            <div className="small"><strong>Aceptar y aplicar:</strong> {impact(p)}. No tiene costo de IA y podrás deshacerlo.</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-primary" onClick={() => decide(p, 'accepted')}>Confirmar y aplicar</button>
              <button className="btn btn-secondary" onClick={() => setConfirming(null)}>Volver</button>
            </div>
          </>
          : confirming === `reject:${p.id}`
            ? <>
              <div className="small"><strong>Rechazar:</strong> no se cambia ningún agente. Podrás reabrirla después.</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-primary" onClick={() => decide(p, 'rejected')}>Confirmar rechazo</button>
                <button className="btn btn-secondary" onClick={() => setConfirming(null)}>Volver</button>
              </div>
            </>
            : <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-primary" disabled={busy} onClick={() => setConfirming(p.id)}>Aceptar y aplicar</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(`reject:${p.id}`)}>Rechazar</button>
            </div>}
      {err && <Notice kind="err">No se aplicó nada y la propuesta sigue pendiente: {err}</Notice>}
    </div>;
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Chip xs tone={DECISION[p.decision].tone}>{DECISION[p.decision].label}{p.decidedAt ? ` · ${when(p.decidedAt)}` : ''}</Chip>
      {app && <Chip xs tone={APP[app.status].tone}>{APP[app.status].label}{app.status === 'reverted' && app.revertedAt ? ` · ${when(app.revertedAt)}` : ''}</Chip>}
      {app?.reappliedAt && <Chip xs tone="ok">Aplicada de nuevo{(app.reapplyCount ?? 0) > 1 ? ` (${app.reapplyCount} veces)` : ''} · {when(app.reappliedAt)}</Chip>}
      {p.decision === 'accepted' && !app && <span className="small muted">Sin cambios aplicados: la propuesta no traía configuración.</span>}
      {app && app.changes.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{app.changes.map(c => <li key={`${c.op}-${c.agentId}`}>
        {OP[c.op]}: {app.status === 'reverted' && c.op === 'create' ? `${c.agentName} (eliminado al deshacer)` : <Link className="lnk" to={`/equipo/${c.agentId}`}>{c.agentName}</Link>} <span className="mono muted">({c.agentKey})</span>
      </li>)}</ul>}
      {app?.warnings?.length ? <div className="small muted">⚠ {app.warnings.join(' ')}</div> : null}
      {app?.status === 'applied' && (undoing === p.id
        ? <div className="small muted"><span className="spin" aria-hidden="true" /> Deshaciendo…</div>
        : confirming === `undo:${p.id}`
          ? <>
            <div className="small">Deshacer: se restaurará el estado previo de los agentes afectados (se borran los creados y se reactivan los retirados).</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-primary" onClick={() => undo(p)}>Confirmar deshacer</button>
              <button className="btn btn-secondary" onClick={() => setConfirming(null)}>Volver</button>
            </div>
          </>
          : <div><button className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(`undo:${p.id}`)}>Deshacer</button></div>)}
      {p.decision === 'rejected' && (acting?.id === p.id && acting.kind === 'reopen'
        ? <div className="small muted"><span className="spin" aria-hidden="true" /> Reabriendo…</div>
        : confirming === `reopen:${p.id}`
          ? <>
            <div className="small"><strong>Reabrir:</strong> vuelve a pendiente para que puedas aceptarla y aplicarla. No cambia ningún agente.</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-primary" onClick={() => act(p, 'reopen')}>Confirmar reabrir</button>
              <button className="btn btn-secondary" onClick={() => setConfirming(null)}>Volver</button>
            </div>
          </>
          : <div><button className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(`reopen:${p.id}`)}>Reabrir</button></div>)}
      {p.decision === 'accepted' && app?.status === 'reverted' && (acting?.id === p.id && acting.kind === 'reapply'
        ? <div className="small muted"><span className="spin" aria-hidden="true" /> Aplicando de nuevo…</div>
        : confirming === `reapply:${p.id}`
          ? <>
            <div className="small"><strong>Volver a aplicar:</strong> {impact(p)}. Se valida contra la organización actual: si algo ya no es válido, no se cambia nada. No tiene costo de IA y podrás deshacerlo otra vez.</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-primary" onClick={() => act(p, 'reapply')}>Confirmar y aplicar de nuevo</button>
              <button className="btn btn-secondary" onClick={() => setConfirming(null)}>Volver</button>
            </div>
          </>
          : <div><button className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(`reapply:${p.id}`)}>Volver a aplicar</button></div>)}
      {app?.status === 'reverted' && app.error && !propErr[p.id] && <Notice kind="err">No se volvió a aplicar y la propuesta sigue revertida: {app.error}</Notice>}
      {propErr[p.id] && <Notice kind="err">{propErr[p.id]}</Notice>}
    </div>;
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
            <Notice kind="info">Al confirmar «Aceptar y aplicar», el Portal aplica la propuesta con su configuración, sin costo de IA. Puedes deshacerla y, después, volver a aplicarla. Rechazar pide confirmación, solo registra la decisión y se puede reabrir más tarde. Nada se crea, ajusta ni retira sin tu aprobación.</Notice>
            {current.proposals.length === 0
              ? <div className="small muted">Sin propuestas: el Gestor considera adecuada la organización actual.</div>
              : <div style={{ overflowX: 'auto' }}><table className="tbl">
                <thead><tr><th>Propuesta</th><th>Justificación</th><th>Decisión</th></tr></thead>
                <tbody>{current.proposals.map(p => <tr key={p.id}>
                  <td><strong>{ACTION[p.action]} {TARGET[p.target]}</strong><div className="med">{p.subject}</div>{p.details && <div className="small muted">{p.details}</div>}<SpecView p={p} /></td>
                  <td className="med" style={{ maxWidth: '48ch' }}>{p.rationale}</td>
                  <td style={{ minWidth: 240 }}>{decisionCell(p)}</td>
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

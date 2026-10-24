import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Process, ProcessStep } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, Icon, KV, Notice } from '../components/ui.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { StoryResult } from '../components/StoryResult.tsx';
import { DelegationResultView } from '../components/DelegationResultView.tsx';

const P_LABEL: Record<Process['status'], { label: string; tone: '' | 'ok' | 'warn' | 'err'; dot: '' | 'ok' | 'pulse' | 'err' }> = {
  pending_authorization: { label: 'Pendiente de autorización', tone: 'warn', dot: '' },
  running: { label: 'En ejecución', tone: 'warn', dot: 'pulse' },
  done: { label: 'Completado', tone: 'ok', dot: 'ok' },
  failed: { label: 'Con errores', tone: 'err', dot: 'err' },
  cancelled: { label: 'Cancelado', tone: '', dot: '' },
  budget_exceeded: { label: 'Presupuesto agotado', tone: 'err', dot: 'err' }
};

export function ProcessView() {
  const { processId } = useParams();
  const { status, flash } = useApp();
  const slug = status.workspace!.slug;
  const [proc, setProc] = useState<Process | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => { try { const p = await api.process(slug, processId!); if (!alive) return; setProc(p); if (p.status === 'running' || p.status === 'pending_authorization') setTimeout(tick, p.status === 'running' ? 2000 : 5000); } catch (e: any) { if (alive) setError(e.message); } };
    void tick();
    return () => { alive = false; };
  }, [slug, processId]);

  useEffect(() => { if (proc && !open) { const last = [...proc.steps].reverse().find(s => s.status === 'done' || s.status === 'running'); if (last) setOpen(last.id); } }, [proc, open]);

  const cancel = async () => { if (!proc || !confirm('¿Cancelar el proceso? Se detendrá al terminar el paso en curso.')) return; await api.cancelProcess(slug, proc.id); flash('Cancelación solicitada'); };
  const [budget, setBudget] = useState('');
  const [auth, setAuth] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);
  useEffect(() => { if (proc && proc.status === 'pending_authorization' && !budget) setBudget(Math.max(0.5, Math.ceil(proc.estimatedUsd * 2 * 2) / 2).toFixed(2)); }, [proc, budget]);
  const authorize = async () => { if (!proc) return; setAuthBusy(true); setAuthErr(null); try { const p = await api.authorizeProcess(slug, proc.id, Number(budget)); setProc(p); flash(`Autorizado con presupuesto ${fmtUsd(p.budgetUsd)}`); setTimeout(async () => { try { setProc(await api.process(slug, proc.id)); } catch { /* seguirá el sondeo */ } }, 1500); } catch (e: any) { setAuthErr(e.message); } finally { setAuthBusy(false); } };

  if (error) return <Shell crumb="Proceso"><main className="page"><Notice kind="err">{error}</Notice></main></Shell>;
  if (!proc) return <Shell crumb="Proceso"><main className="page"><span className="spin" aria-label="Cargando" /></main></Shell>;
  const st = P_LABEL[proc.status];
  const tokens = proc.inputTokens + proc.outputTokens;
  const pct = proc.budgetUsd ? Math.min(100, Math.round((proc.spentUsd / proc.budgetUsd) * 100)) : 0;

  const stepChip = (s: ProcessStep) => s.status === 'done' ? <Chip tone="ok" xs dot="ok">completado</Chip> : s.status === 'running' ? <Chip tone="warn" xs dot="pulse">en curso</Chip> : s.status === 'failed' ? <Chip tone="err" xs dot="err">error</Chip> : s.status === 'skipped' ? <Chip xs>omitido</Chip> : <Chip xs dot="">pendiente</Chip>;

  return (
    <Shell crumb={<>Actividad / {proc.title}</>}>
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Link className="lnk sm13" to="/actividad">← Actividad</Link>
            <h1 className="h1" style={{ fontSize: 26 }}>{proc.title}</h1>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Chip tone={st.tone} dot={st.dot}>{st.label}</Chip><Chip className="mono">{tokens} tokens · {fmtUsd(proc.spentUsd)} de {fmtUsd(proc.budgetUsd)}</Chip><Chip xs>{proc.steps.filter(s => s.status === 'done').length} de {proc.steps.length} pasos</Chip></div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {proc.status === 'running' && <button className="btn btn-secondary" onClick={cancel}>Cancelar proceso</button>}
            {proc.status === 'done' && proc.kind === 'initial_assessment' && <Link className="btn btn-primary" to="/backlog">Ver backlog y ejecutar {Icon.arrow()}</Link>}
            {proc.kind === 'story_execution' && <Link className="btn btn-secondary" to="/backlog">Volver al backlog</Link>}
          </div>
        </div>

        {proc.guidance && proc.status !== 'pending_authorization' && <Notice kind={proc.guidance.tone}><div><strong>{proc.guidance.phase}.</strong> <span style={{ fontWeight: 600 }}>Siguiente paso:</span> {proc.guidance.next}</div></Notice>}
        {proc.status === 'pending_authorization' && <section className="card" style={{ borderColor: '#F0C66B', background: '#FFFBF0' }}>
          <div className="card-h"><div><div className="h3">Autorizar este proceso</div><div className="small muted">Consume IA. Nada se ha gastado todavía. Costo estimado ≈ {fmtUsd(proc.estimatedUsd)}.</div></div><Chip tone="warn" xs>requiere tu autorización</Chip></div>
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {authErr && <Notice kind="err">{authErr}</Notice>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 14, alignItems: 'end' }}>
              <div><label className="label" htmlFor="pv-budget">Presupuesto máximo (USD)</label><input id="pv-budget" className="input mono" type="number" min={0.1} step={0.5} value={budget} onChange={e => setBudget(e.target.value)} /></div>
              <div className="help" style={{ paddingBottom: 26 }}>El proceso se detiene entre pasos si el gasto se acerca al límite.</div>
            </div>
            <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo a los agentes indicados a trabajar en este proceso hasta <strong>{fmtUsd(Number(budget) || 0)}</strong>. Los resultados son propuestas que revisaré antes de aplicarse.</span></label>
            <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={authorize} disabled={!auth || authBusy || !(Number(budget) > 0)}>{authBusy ? <span className="spin spin-light" /> : Icon.arrow()}{authBusy ? 'Autorizando…' : 'Autorizar y comenzar'}</button>
          </div></section>}
        {proc.error && proc.status !== 'failed' && proc.status !== 'budget_exceeded' && <Notice kind="err">{proc.error}</Notice>}
        {proc.status === 'running' && <Notice kind="info">Los agentes implicados están <strong>activos</strong> durante este proceso y volverán a estar inactivos al terminar. {proc.kind === 'story_execution' ? 'Proponen cambios; nada se escribe en el repositorio sin tu aprobación.' : proc.kind === 'delegated_task' ? 'El responsable valida el encargo, consulta a su equipo y entrega el resultado; las propuestas al backlog las aplicas tú.' : 'Solo realizan lectura y análisis; ninguna acción sobre el repositorio.'}</Notice>}
        {proc.kind === 'story_execution' && proc.result && (proc.status === 'done' || proc.result.changes.length > 0) && <StoryResult proc={proc} onChange={setProc} />}
        {proc.kind === 'delegated_task' && proc.delegation && (proc.delegation.triage || proc.status !== 'running') && <DelegationResultView proc={proc} onChange={setProc} />}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
          <div style={{ flex: '999 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {proc.steps.map((s, i) => (
              <section key={s.id} className="card">
                <button className="card-h" style={{ width: '100%', background: 'transparent', border: 0, borderBottom: open === s.id ? '1px solid #EEECE6' : 0, font: 'inherit', cursor: 'pointer', textAlign: 'left', borderRadius: 10 }} onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
                    <span className="ili-ic" style={s.status === 'done' ? { background: '#E3F1EF', color: '#0B5652' } : undefined}>{s.status === 'done' ? Icon.check() : s.status === 'running' ? <span className="spin" /> : <span className="mono">{i + 1}</span>}</span>
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}><span className="h3">{s.title}</span><span className="small muted">{s.agentName} · <span className="mono">{s.model}</span>{s.status === 'done' && <> · {s.inputTokens + s.outputTokens} tokens · {fmtUsd(s.costUsd)}</>}</span></span>
                  </div>
                  {stepChip(s)}
                </button>
                {open === s.id && <div className="card-b">
                  {s.error && <Notice kind="err">{s.error}</Notice>}
                  {s.status === 'running' && <p className="sm13 muted">El agente está trabajando… esta vista se actualiza cada 2 segundos.</p>}
                  {s.outputMd && <Markdown text={s.outputMd} />}
                </div>}
              </section>
            ))}
          </div>
          <aside style={{ flex: '1 1 280px', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <section className="card card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="h3">Presupuesto</div>
              <div style={{ height: 8, background: '#EEECE6', borderRadius: 999, overflow: 'hidden' }}><div style={{ width: `${pct}%`, height: '100%', background: pct >= 90 ? '#D93025' : pct >= 70 ? '#E39B1C' : '#0F6E6A', transition: 'width .3s' }} /></div>
              <KV k="Gastado"><span className="mono">{fmtUsd(proc.spentUsd)}</span></KV>
              <KV k="Autorizado"><span className="mono">{fmtUsd(proc.budgetUsd)}</span></KV>
              <KV k="Estimado inicial"><span className="mono">≈ {fmtUsd(proc.estimatedUsd)}</span></KV>
              <KV k="Tokens entrada / salida"><span className="mono">{proc.inputTokens} / {proc.outputTokens}</span></KV>
              <div className="help">Costos estimados con tarifas públicas; el importe exacto lo factura el proveedor.</div>
            </section>
            <section className="card card-b" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="h3">Tiempos</div>
              <KV k="Autorizado">{proc.authorizedAt ? new Date(proc.authorizedAt).toLocaleTimeString('es-MX') : '—'}</KV>
              <KV k="Finalizado">{proc.finishedAt ? new Date(proc.finishedAt).toLocaleTimeString('es-MX') : '—'}</KV>
            </section>
          </aside>
        </div>
      </main>
    </Shell>
  );
}

export function ProcessList() {
  const { status, navigate } = useApp();
  const slug = status.workspace!.slug; const projectId = status.project!.id;
  const [list, setList] = useState<Process[] | null>(null);
  useEffect(() => { api.processes(slug, projectId).then(setList).catch(() => setList([])); }, [slug, projectId]);
  return (
    <Shell crumb="Actividad">
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div><div className="eyebrow">Actividad</div><h1 className="h1" style={{ fontSize: 26 }}>Procesos del proyecto</h1></div>
        <section className="card">
          <div className="card-h"><div className="h3">Procesos</div><span className="small muted">{list?.length ?? 0} en total</span></div>
          {list && list.length === 0 && <div className="card-b"><p className="muted sm13">Aún no hay procesos. La evaluación inicial se lanza desde el panel; las historias, desde el backlog.</p></div>}
          {list && list.length > 0 && <div style={{ overflowX: 'auto' }}><table className="tbl"><thead><tr><th>Proceso</th><th>Estado</th><th>Pasos</th><th>Tokens</th><th>Costo</th><th>Creado</th></tr></thead>
            <tbody>{list.map(p => { const st = P_LABEL[p.status]; return <tr key={p.id}><td><button className="lnk" onClick={() => navigate(`/procesos/${p.id}`)}>{p.title}</button></td><td><Chip tone={st.tone} xs dot={st.dot}>{st.label}</Chip></td><td className="med">{p.steps.filter(s => s.status === 'done').length}/{p.steps.length}</td><td className="mono" style={{ fontSize: 12 }}>{p.inputTokens + p.outputTokens}</td><td className="mono" style={{ fontSize: 12 }}>{fmtUsd(p.spentUsd)}</td><td className="med">{new Date(p.createdAt).toLocaleString('es-MX')}</td></tr>; })}</tbody></table></div>}
        </section>
      </main>
    </Shell>
  );
}

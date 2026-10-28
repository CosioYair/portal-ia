import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PipelineConfig, Process, ProcessStep } from '@portal-ia/domain';
import { DEFAULT_PIPELINE } from '@portal-ia/domain';
import { PipelineOptions } from '../components/PipelineOptions.tsx';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, Icon, KV, Notice } from '../components/ui.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { StoryResult } from '../components/StoryResult.tsx';
import { DelegationResultView } from '../components/DelegationResultView.tsx';
import { StoryFlowPanel } from '../components/StoryFlowPanel.tsx';
import { serverNow, stepDurationMs } from '../lib/liveStatus.ts';

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
  const { status, flash, navigate } = useApp();
  const slug = status.workspace!.slug;
  const [proc, setProc] = useState<Process | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // El sondeo se reanuda cuando el proceso vuelve a estar activo (p. ej. al continuar): nunca se muestra un estado congelado.
  const active = proc?.status === 'running' || proc?.status === 'pending_authorization';
  // Un fallo del sondeo no lo detiene ni borra la pantalla: se sigue intentando y la cabecera avisa de que los datos
  // pueden estar desactualizados (el proceso puede seguir trabajando en el servidor).
  const loaded = useRef(false);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try { const p = await api.process(slug, processId!); if (!alive) return; loaded.current = true; setError(null); setProc(p); if (p.status === 'running' || p.status === 'pending_authorization') timer = setTimeout(tick, p.status === 'running' ? 2000 : 5000); }
      catch (e: any) { if (!alive) return; if (!loaded.current) setError(e.message); timer = setTimeout(tick, 5000); }
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [slug, processId, active]);

  useEffect(() => { if (proc && !open) { const last = [...proc.steps].reverse().find(s => s.status === 'done' || s.status === 'running'); if (last) setOpen(last.id); } }, [proc, open]);

  const cancel = async () => { if (!proc || !confirm('¿Cancelar el proceso? Se aborta la llamada en curso al proveedor; lo terminado se conserva.')) return; await api.cancelProcess(slug, proc.id); flash('Cancelando: se aborta la llamada en curso'); };
  const [fixBusy, setFixBusy] = useState<'recover' | 'retry' | null>(null);
  const [fixErr, setFixErr] = useState<string | null>(null);
  const recover = async () => { if (!proc) return; setFixBusy('recover'); setFixErr(null); try { const p = await api.recoverProcess(slug, proc.id); setProc(p); flash(`Resultado recuperado: ${p.result?.changes.filter(c => !c.error).length ?? 0} cambio(s) listos para revisar`); } catch (e: any) { setFixErr(e.message); } finally { setFixBusy(null); } };
  const retry = async () => { if (!proc) return; setFixBusy('retry'); setFixErr(null); try { const p = await api.retryProcess(slug, proc.id); flash('Nuevo proceso creado: autorízalo con un presupuesto'); navigate(`/procesos/${p.id}`); setProc(p); setBudget(''); } catch (e: any) { setFixErr(e.message); } finally { setFixBusy(null); } };
  const [budget, setBudget] = useState('');
  const [auth, setAuth] = useState(false);
  const [pipeline, setPipeline] = useState<PipelineConfig>(DEFAULT_PIPELINE);
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);
  useEffect(() => { if (proc && proc.status === 'pending_authorization' && !budget) setBudget(Math.max(0.5, Math.ceil(proc.estimatedUsd * 2 * 2) / 2).toFixed(2)); }, [proc, budget]);
  const authorize = async () => { if (!proc) return; setAuthBusy(true); setAuthErr(null); try { const p = await api.authorizeProcess(slug, proc.id, Number(budget), proc.kind === 'story_execution' ? pipeline : undefined); setProc(p); flash(`Autorizado con presupuesto ${fmtUsd(p.budgetUsd)}`); setTimeout(async () => { try { setProc(await api.process(slug, proc.id)); } catch { /* seguirá el sondeo */ } }, 1500); } catch (e: any) { setAuthErr(e.message); } finally { setAuthBusy(false); } };

  if (error) return <Shell crumb="Proceso"><main className="page"><Notice kind="err">{error}</Notice></main></Shell>;
  if (!proc) return <Shell crumb="Proceso"><main className="page"><span className="spin" aria-label="Cargando" /></main></Shell>;
  const st = P_LABEL[proc.status];
  const tokens = proc.inputTokens + proc.outputTokens;
  const pct = proc.budgetUsd ? Math.min(100, Math.round((proc.spentUsd / proc.budgetUsd) * 100)) : 0;

  // En curso: hasta ahora (hora del servidor), aunque el paso conserve el final de una llamada anterior (continuación).
  const stepTime = (s: ProcessStep) => { const sec = Math.round((stepDurationMs(s, serverNow()) ?? 0) / 1000); return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${sec % 60} s`; };
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
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {proc.kind === 'story_execution' && proc.backlogItemId && <Link className="btn btn-secondary" to={`/historias/${proc.backlogItemId}`}>Espacio de la historia {Icon.arrow()}</Link>}
            {proc.status === 'running' && !proc.archivedAt && <button className="btn btn-secondary" onClick={cancel}>Cancelar proceso</button>}
            {proc.status === 'done' && proc.kind === 'initial_assessment' && <Link className="btn btn-primary" to="/backlog">Ver backlog y ejecutar {Icon.arrow()}</Link>}
            {proc.kind === 'story_execution' && <Link className="btn btn-secondary" to="/backlog">Volver al backlog</Link>}
          </div>
        </div>

        {proc.archivedAt && <Notice kind="info"><strong>Proceso archivado</strong> con la etapa anterior ({new Date(proc.archivedAt).toLocaleDateString('es-MX')}). Es histórico: se puede consultar, pero no admite acciones. <Link className="lnk" to="/archivo">Archivo histórico</Link>.</Notice>}
        <fieldset disabled={!!proc.archivedAt} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {proc.kind === 'story_execution' && proc.guidance?.flow && <StoryFlowPanel proc={proc} variant="process" onChange={setProc}
          story={proc.backlogItemId ? { id: proc.backlogItemId, storyId: proc.title.split(' · ')[0], title: proc.title.split(' · ').slice(1).join(' · ') || proc.title } : null} />}
        {proc.guidance && !proc.guidance.flow && proc.status !== 'pending_authorization' && !proc.archivedAt && <Notice kind={proc.guidance.tone}><div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
          <div><strong>{proc.guidance.phase}.</strong> <span style={{ fontWeight: 600 }}>Siguiente paso:</span> {proc.guidance.next}</div>
          {proc.kind === 'story_execution' && !proc.archivedAt && (proc.status === 'failed' || proc.status === 'cancelled' || proc.status === 'budget_exceeded') && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {!!proc.steps[1]?.outputMd && !proc.result?.applied && <button className="btn btn-primary btn-sm" onClick={recover} disabled={fixBusy !== null}>{fixBusy === 'recover' ? <span className="spin spin-light" /> : Icon.check()}Recuperar el resultado (sin IA)</button>}
            <button className="btn btn-secondary btn-sm" onClick={retry} disabled={fixBusy !== null}>{fixBusy === 'retry' ? <span className="spin" /> : Icon.arrow()}Volver a ejecutar la historia</button>
            {fixErr && <span className="sm13" style={{ color: '#9A1F18' }}>{fixErr}</span>}
          </div>}
        </div></Notice>}
        {proc.status === 'pending_authorization' && !proc.archivedAt && <section className="card" id="sec-authorize" style={{ borderColor: '#F0C66B', background: '#FFFBF0' }}>
          <div className="card-h"><div><div className="h3">Autorizar este proceso</div><div className="small muted">Consume IA. Nada se ha gastado todavía. Costo estimado ≈ {fmtUsd(proc.estimatedUsd)}.</div></div><Chip tone="warn" xs>requiere tu autorización</Chip></div>
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {authErr && <Notice kind="err">{authErr}</Notice>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 14, alignItems: 'end' }}>
              <div><label className="label" htmlFor="pv-budget">Presupuesto máximo (USD)</label><input id="pv-budget" className="input mono" type="number" min={0.1} step={0.5} value={budget} onChange={e => setBudget(e.target.value)} /></div>
              <div className="help" style={{ paddingBottom: 26 }}>El proceso se detiene entre pasos si el gasto se acerca al límite.</div>
            </div>
            {proc.kind === 'story_execution' && <PipelineOptions value={pipeline} onChange={setPipeline} team={proc.steps.map(s => ({ agentName: s.agentName, role: s.title, model: s.model ?? '' }))} />}
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
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}><span className="h3">{s.title}</span><span className="small muted">{s.agentName}{s.role ? ` · ${s.role === 'planner' ? 'planifica' : s.role === 'implementer' ? 'implementa' : s.role === 'reviewer' ? 'revisa' : 'consulta'}` : ''} · <span className="mono">{s.model}</span>{s.status === 'done' && <> · {s.inputTokens + s.outputTokens} tokens · {fmtUsd(s.costUsd)} <span title="Costo calculado con los tokens que devolvió el proveedor">real</span></>}{s.reason && <span title={s.reason}> · ⓘ</span>}</span></span>
                  </div>
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>{s.startedAt && <span className="small muted mono" title={s.status === 'running' && s.inputTokens + s.outputTokens ? 'Uso confirmado de las llamadas ANTERIORES de este paso; la llamada en curso aún no tiene consumo confirmado.' : undefined}>{stepTime(s)}{s.inputTokens + s.outputTokens ? ` · ${s.inputTokens + s.outputTokens} tok · ${fmtUsd(s.costUsd)}${s.status === 'running' ? ' confirmados antes' : ''}` : ''}</span>}{stepChip(s)}</span>
                </button>
                {open === s.id && <div className="card-b">
                  {s.error && <Notice kind="err">{s.error}</Notice>}
                  {s.status === 'running' && <p className="sm13 muted">En curso: el estado real de la llamada al proveedor está en la cabecera de arriba. Esta vista consulta el servidor cada 2 segundos.</p>}
                  {/* Paso en curso con salida de llamadas anteriores (continuación): texto plano y plegado, sin interpretarlo. */}
                  {s.status === 'running' && s.outputMd ? <details><summary className="small" style={{ cursor: 'pointer' }}>Salida de las llamadas anteriores de este paso ({s.outputMd.length.toLocaleString('es-MX')} caracteres, incompleta)</summary><pre className="mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }}>{s.outputMd}</pre></details>
                  : s.outputMd && (/^\s*[{[]/.test(s.outputMd) ? <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><p className="sm13 muted" style={{ margin: 0 }}>{s.role === 'reviewer' ? 'El veredicto de QA se muestra arriba, en «Revisión de calidad», con las observaciones por gravedad.' : s.role === 'planner' ? 'El plan se muestra arriba, en «Plan técnico».' : 'El resultado estructurado se muestra arriba.'}</p><details><summary className="small" style={{ cursor: 'pointer' }}>Ver la respuesta técnica del agente</summary><pre className="mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }}>{(() => { try { return JSON.stringify(JSON.parse(s.outputMd), null, 2); } catch { return s.outputMd; } })()}</pre></details></div> : <Markdown text={s.outputMd} />)}
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
        </fieldset>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}><div><div className="eyebrow">Actividad</div><h1 className="h1" style={{ fontSize: 26 }}>Procesos del proyecto</h1></div><Link className="btn btn-ghost btn-sm" to="/archivo">Archivo histórico</Link></div>
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

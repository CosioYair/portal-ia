import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, AssessmentEstimate, BacklogItem, Process } from '@portal-ia/domain';
import { api, type ProjectFull } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { BACKLOG_STATUS, fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, Empty, Icon, Notice } from '../components/ui.tsx';

/** Backlog del proyecto: historias del plan (importadas de la síntesis) y solicitudes del propietario. Desde aquí se ejecutan. */
export function Backlog() {
  const { status, flash, navigate } = useApp();
  const ws = status.workspace!; const projectId = status.project!.id;
  const [items, setItems] = useState<BacklogItem[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [procs, setProcs] = useState<Process[]>([]);
  const [project, setProject] = useState<ProjectFull | null>(null);
  const [sel, setSel] = useState<BacklogItem | null>(null);
  const [est, setEst] = useState<AssessmentEstimate | null>(null);
  const [estError, setEstError] = useState<string | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [budget, setBudget] = useState('');
  const [auth, setAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCrit, setNewCrit] = useState('');
  const [aiOffer, setAiOffer] = useState<{ source: string; model: string | null; byAgent: string | null; estimatedUsd: number } | null>(null);

  const load = async () => {
    const [b, a, p, ps] = await Promise.all([api.backlog(ws.slug, projectId), api.agents(ws.slug), api.processes(ws.slug, projectId), api.projects(ws.slug)]);
    setItems(b); setAgents(a); setProcs(p); setProject(ps[0] ?? null);
  };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug, projectId]);

  useEffect(() => {
    setEst(null); setEstError(null); setExecError(null); setAuth(false);
    if (!sel) return;
    api.storyEstimate(ws.slug, projectId, sel.id).then(e => { setEst(e); setBudget(e.suggestedBudgetUsd.toFixed(2)); }).catch(e => setEstError(e.message));
  }, [sel, ws.slug, projectId]);

  const importPlan = async (useAI = false) => {
    setBusy(true);
    try {
      const est = useAI ? aiOffer : null;
      const r = await api.importBacklog(ws.slug, projectId, useAI ? { authorized: true, maxUsd: Math.max(0.1, (est?.estimatedUsd ?? 0.1) * 3) } : undefined);
      if (!r.source) { flash('No hay una síntesis todavía: ejecuta la evaluación inicial desde el panel', 'err'); }
      else if (r.imported === 0 && r.total === 0 && !useAI) { const e = await api.importEstimate(ws.slug, projectId).catch(() => null); setAiOffer({ source: r.source, model: e?.model ?? null, byAgent: e?.byAgent ?? null, estimatedUsd: e?.estimatedUsd ?? 0 }); }
      else { setAiOffer(null); flash(r.imported ? `${r.imported} historias importadas desde «${r.source}»${r.usedAI ? ` · extraídas por IA (${fmtUsd(r.costUsd)})` : ''}` : 'El backlog ya contenía estas historias'); }
      await load();
    } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); }
  };
  const addItem = async () => { if (newTitle.trim().length < 3) return; setBusy(true); try { await api.addBacklogItem(ws.slug, projectId, { title: newTitle.trim(), criterion: newCrit.trim() || undefined }); setNewTitle(''); setNewCrit(''); flash('Solicitud añadida al backlog'); await load(); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } };
  const execute = async () => {
    if (!sel || !auth) return; setBusy(true); setExecError(null);
    try { const p = await api.executeStory(ws.slug, projectId, sel.id); const a = await api.authorizeProcess(ws.slug, p.id, Number(budget)); flash(`Historia ${sel.storyId} en ejecución · presupuesto ${fmtUsd(a.budgetUsd)}`); navigate(`/procesos/${a.id}`); }
    catch (e: any) { setExecError(e.message); flash(e.message, 'err'); } finally { setBusy(false); }
  };

  const [delegText, setDelegText] = useState('');
  const delegate = async () => { if (delegText.trim().length < 8) return; setBusy(true); try { const p = await api.createDelegation(ws.slug, { projectId, request: delegText.trim() }); setDelegText(''); flash('Encargo creado: autorízalo con un presupuesto'); navigate(`/procesos/${p.id}`); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } };
  const closeStory = async (it: BacklogItem, force: boolean) => {
    if (force) { const reason = prompt(`Cerrar ${it.storyId} como resuelta fuera del flujo (sin ejecutarla ni integrar cambios). Indica brevemente por qué:`); if (reason === null) return; setBusy(true); try { await api.markStoryDone(ws.slug, it.id, { force: true, reason: reason.trim() || 'resuelta fuera del flujo' }); flash(`${it.storyId} cerrada`); await load(); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } return; }
    setBusy(true); try { await api.markStoryDone(ws.slug, it.id); flash(`${it.storyId} completada`); await load(); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); }
  };
  const owner = (k: string | null) => agents.find(a => a.key === k);
  const running = procs.find(p => p.status === 'running');
  const lastProc = (it: BacklogItem) => procs.find(p => p.id === it.lastProcessId) ?? procs.find(p => p.backlogItemId === it.id);
  const depOk = (it: BacklogItem) => !it.dependsOn || items?.find(x => x.storyId === it.dependsOn)?.status === 'done' || !items?.some(x => x.storyId === it.dependsOn);
  const pending = items?.filter(i => i.status !== 'done') ?? [];
  const next = pending.find(i => i.status === 'pending' && depOk(i));

  return (
    <Shell crumb="Backlog">
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="eyebrow">Backlog</div>
            <h1 className="h1" style={{ fontSize: 26 }}>Plan del proyecto y solicitudes</h1>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Chip>{items?.length ?? 0} historias</Chip><Chip tone="ok">{items?.filter(i => i.status === 'done').length ?? 0} completadas</Chip><Chip tone="accent">{items?.filter(i => i.status === 'review').length ?? 0} para revisar</Chip>{running && <Chip tone="warn" dot="pulse">1 en ejecución</Chip>}</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => importPlan(false)} disabled={busy}>{Icon.book()}Importar historias de la síntesis</button>
            {next && <button className="btn btn-primary" onClick={() => setSel(next)} disabled={!!running}>{Icon.arrow()}Ejecutar siguiente: {next.storyId}</button>}
          </div>
        </div>

        {aiOffer && <Notice kind="warn"><strong>No encontré historias estructuradas en «{aiOffer.source}».</strong> El {aiOffer.byAgent ?? 'Coordinador del Proyecto'} puede extraerlas con una llamada ({aiOffer.model && <span className="mono">{aiOffer.model}</span>}, costo estimado <strong>≈ {fmtUsd(aiOffer.estimatedUsd)}</strong>). <button className="btn btn-primary btn-sm" style={{ marginLeft: 8 }} onClick={() => importPlan(true)} disabled={busy}>{busy ? 'Extrayendo…' : 'Autorizar y extraer con IA'}</button></Notice>}
        {!project?.repository && <Notice kind="warn">Para ejecutar historias hace falta el repositorio registrado (los agentes leen el código y proponen cambios sobre él). <Link className="lnk" to="/panel">Registrarlo desde el panel</Link>.</Notice>}
        {running && <Notice kind="info">Hay un proceso en ejecución: <button className="lnk" onClick={() => navigate(`/procesos/${running.id}`)}>{running.title}</button>. Las historias se ejecutan de una en una.</Notice>}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
          <div style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <section className="card">
              <div className="card-h"><div className="h3">Historias</div><span className="small muted">Ordenadas por prioridad del plan</span></div>
              {items && items.length === 0 && <div className="card-b"><Empty icon={Icon.inbox()} title="El backlog está vacío" hint="Importa las historias de la síntesis de la evaluación inicial o añade una solicitud a la derecha." style={{ padding: '24px 0 8px' }} /></div>}
              {items && items.length > 0 && <div style={{ overflowX: 'auto' }}><table className="tbl">
                <thead><tr><th>ID</th><th>Historia</th><th>Responsable</th><th>Depende de</th><th>Tamaño</th><th>Estado</th><th></th></tr></thead>
                <tbody>{items.map(it => { const st = BACKLOG_STATUS[it.status]; const o = owner(it.ownerKey); const lp = lastProc(it); const blocked = !depOk(it); return <tr key={it.id} style={sel?.id === it.id ? { background: '#F3FAF9' } : undefined}>
                  <td className="mono" style={{ fontSize: 12 }}>{it.storyId}</td>
                  <td><div style={{ fontWeight: 500 }}>{it.title}</div>{it.criterion && <div className="small muted" style={{ maxWidth: '52ch' }}>{it.criterion}</div>}</td>
                  <td className="med">{o?.config.name ?? it.ownerKey ?? '—'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{it.dependsOn ?? '—'}</td>
                  <td className="med">{it.estimate ?? '—'}</td>
                  <td><Chip tone={blocked && it.status === 'pending' ? 'err' : st.tone} xs dot={it.status === 'in_progress' ? 'pulse' : undefined}>{blocked && it.status === 'pending' ? `Espera ${it.dependsOn}` : st.label}</Chip></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {it.status === 'review' && lp?.result?.applied && !lp.result.merged && <Chip tone="warn" xs>aplicada · falta integrar</Chip>}
                    {it.status === 'review' && lp?.result?.merged && !lp.result.published && <Chip tone="accent" xs>integrada · falta publicar</Chip>}
                    {it.status === 'review' && lp?.result?.merged && <button className="btn btn-primary btn-sm" style={{ marginLeft: 6 }} onClick={() => closeStory(it, false)} disabled={busy}>Cerrar historia</button>}
                    {it.status === 'review' && lp && <button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={() => navigate(`/procesos/${lp.id}`)}>{lp.result?.applied ? 'Ver proceso' : 'Revisar cambios'}</button>}
                    {it.status === 'in_progress' && lp && <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/procesos/${lp.id}`)}>Ver proceso</button>}
                    {(it.status === 'pending' || it.status === 'blocked') && <button className="btn btn-primary btn-sm" onClick={() => setSel(it)} disabled={!!running || !project?.repository}>Ejecutar</button>}
                    {it.status === 'done' && lp && <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/procesos/${lp.id}`)}>Ver</button>}
                    {it.status !== 'done' && it.status !== 'in_progress' && <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} title="Cerrar sin ejecutar: la historia ya está resuelta por otra vía" onClick={() => closeStory(it, true)} disabled={busy}>Cerrar</button>}
                  </td></tr>; })}</tbody>
              </table></div>}
            </section>

          </div>

          {sel && (
            <div className="backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setSel(null); }}>
              <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ex-title" id="ejecutar" style={{ width: 'min(760px, 100%)' }}>
                <div className="modal-h"><div><div className="h3" id="ex-title">Ejecutar {sel.storyId} · {sel.title}</div><div className="small muted">Coordinador planifica → Desarrollador implementa → QA revisa. Nada se escribe en el repositorio hasta que apruebes el diff.</div></div><button className="xbtn" onClick={() => setSel(null)} aria-label="Cerrar" disabled={busy}>{Icon.x(16)}</button></div>
                <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
                  <div><Chip tone="warn" xs>consume IA · requiere autorización</Chip></div>
                  {estError && <Notice kind="err"><strong>No se pudo estimar la historia.</strong> {estError}</Notice>}
                  {execError && <Notice kind="err"><strong>No se pudo iniciar la ejecución.</strong> {execError}</Notice>}
                  {sel.criterion && <div className="kv"><span>Criterio de aceptación</span><span style={{ textAlign: 'right', maxWidth: '60ch' }}>{sel.criterion}</span></div>}
                  {!est && !estError && <div className="muted sm13" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="spin" /> Estimando costo con los modelos de los agentes…</div>}
                  {est && <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {est.steps.map((s, i) => <div key={i} className="rrow"><span className="mono small muted">{String(i + 1).padStart(2, '0')}</span><span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}><span style={{ fontWeight: 500 }}>{s.title}</span><span className="small muted">{s.agentName} · <span className="mono">{s.model}</span></span></span><span className="mono small muted">≈ {fmtUsd(s.estimatedUsd)}</span></div>)}
                    <div className="kv" style={{ marginTop: 6 }}><span>Costo estimado total</span><span className="mono">≈ {fmtUsd(est.estimatedUsd)} <span className="muted">(aprox.)</span></span></div>
                  </div>}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 14, alignItems: 'end' }}>
                    <div><label className="label" htmlFor="st-budget">Presupuesto máximo (USD)</label><input id="st-budget" className="input mono" type="number" min={0.1} step={0.5} value={budget} onChange={e => setBudget(e.target.value)} /></div>
                    <div className="help" style={{ paddingBottom: 26 }}>Si el gasto se acerca al límite, el proceso se detiene entre pasos. El Desarrollador genera archivos completos, así que es el paso más caro.</div>
                  </div>
                  <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo que los agentes del proyecto trabajen en la historia <strong>{sel.storyId}</strong> con lectura del repositorio, hasta <strong>{fmtUsd(Number(budget) || 0)}</strong>. Los cambios resultantes serán <strong>propuestas</strong> que revisaré antes de aplicarse en una rama git.</span></label>
                </div>
                <div className="modal-f">
                  <span className="small muted">{running ? 'Hay otro proceso en ejecución; espera a que termine.' : 'Podrás seguir cada paso en Procesos.'}</span>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button className="btn btn-ghost" onClick={() => setSel(null)} disabled={busy}>Cancelar</button>
                    <button className="btn btn-primary" onClick={execute} disabled={!auth || busy || !est || !(Number(budget) > 0) || !!running}>{busy ? <span className="spin spin-light" /> : Icon.arrow()}{busy ? 'Autorizando…' : 'Autorizar y ejecutar historia'}</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <aside style={{ flex: '1 1 320px', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <section className="card">
              <div className="card-h"><div className="h3">Nueva solicitud de desarrollo</div></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input className="input" value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Qué quieres que el equipo construya o corrija" aria-label="Título de la solicitud" />
                <textarea className="input" value={newCrit} onChange={e => setNewCrit(e.target.value)} placeholder="Criterio de aceptación (opcional): cómo sabremos que está hecho" aria-label="Criterio de aceptación" style={{ minHeight: 70 }} />
                <button className="btn btn-secondary" onClick={addItem} disabled={busy || newTitle.trim().length < 3}>Añadir al backlog</button>
                <div className="help">Se asigna al Coordinador del Proyecto. Añadirla no consume IA; ejecutarla sí, con tu autorización.</div>
              </div>
            </section>
            <section className="card">
              <div className="card-h"><div className="h3">Encargo al equipo</div><Chip tone="warn" xs>consume IA · autorizas después</Chip></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <textarea className="input" value={delegText} onChange={e => setDelegText(e.target.value)} placeholder="Ej.: Revisa y replantea el backlog según el flujo actual: fusiona lo solapado, descarta lo resuelto y repriotiza." aria-label="Encargo al equipo" style={{ minHeight: 80 }} />
                <button className="btn btn-secondary" onClick={delegate} disabled={busy || delegText.trim().length < 8}>{busy ? <span className="spin" /> : Icon.users()}Encargar al Coordinador del Proyecto</button>
                <div className="help">El Coordinador valida el encargo, consulta a los agentes a su cargo si hace falta y entrega el resultado con propuestas al backlog que tú apruebas. Se crea pendiente de tu autorización (presupuesto).</div>
              </div>
            </section>
            <section className="card card-b" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="h3">Cómo funciona</div>
              <p className="sm13 med" style={{ lineHeight: 1.5 }}>1 · Ejecutas una historia con presupuesto. 2 · Los agentes entregan un <strong>diff</strong> y una revisión de QA. 3 · Lo revisas y, si apruebas, se aplica en una rama <span className="mono">portal-ia/hu-xxx</span> con un commit. 4 · Ejecutas la verificación (typecheck / test / build) y marcas la historia como completada. Integrar la rama en <span className="mono">main</span> es decisión tuya (git).</p>
            </section>
          </aside>
        </div>
      </main>
    </Shell>
  );
}

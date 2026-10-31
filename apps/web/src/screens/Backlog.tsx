import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, AssessmentEstimate, BacklogItem, PendingDecision, PendingDecisionKind, PhaseTransition, PipelineConfig, Process } from '@portal-ia/domain';
import { DEFAULT_PIPELINE } from '@portal-ia/domain';
import { PipelineOptions } from '../components/PipelineOptions.tsx';
import { GauntletOptions } from '../components/Gauntlet.tsx';
import { api, type ProjectFull } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { BACKLOG_STATUS, fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, Icon, Notice } from '../components/ui.tsx';
import { draftKey, useDraft, usePersistentState } from '../lib/persist.ts';
import { TeamReady } from '../components/TeamReady.tsx';

const DECISION_CTA: Record<PendingDecisionKind, string> = {
  process_authorization: 'Autorizar',
  apply_diff: 'Revisar diff',
  integrate: 'Integrar',
  publish: 'Publicar',
  backlog_proposal: 'Revisar y aplicar'
};
const decisionTarget = (d: PendingDecision) => d.storyId ? `/historias/${d.storyId}${d.kind === 'process_authorization' ? '#iteraciones' : ''}` : `/procesos/${d.processId}`;
const supersededNote = (n: number) => n === 1 ? '1 autorización anterior superada' : `${n} autorizaciones anteriores superadas`;

/** Backlog del proyecto: historias del plan (importadas de la síntesis) y solicitudes del propietario. Desde aquí se ejecutan. */
export function Backlog() {
  const { status, flash, navigate } = useApp();
  const ws = status.workspace!; const projectId = status.project!.id;
  const [items, setItems] = useState<BacklogItem[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [procs, setProcs] = useState<Process[]>([]);
  // HU-161 · lo pendiente sale de la bandeja consolidada (una entrada por historia), no se deduce de los procesos.
  const [inbox, setInbox] = useState<PendingDecision[] | null>(null);
  const [inboxErr, setInboxErr] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectFull | null>(null);
  const [phase, setPhase] = useState<PhaseTransition | null>(null);
  const [sel, setSel] = useState<BacklogItem | null>(null);
  const [est, setEst] = useState<AssessmentEstimate | null>(null);
  const [estError, setEstError] = useState<string | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [budget, setBudget] = useState('');
  const [auth, setAuth] = useState(false);
  const [pipeline, setPipeline] = useState<PipelineConfig>(DEFAULT_PIPELINE);
  const [busy, setBusy] = useState(false);
  // Borradores (por empresa y proyecto): la solicitud nueva y el análisis pedido al equipo sobreviven a recargar.
  const newDraft = useDraft(draftKey('backlog.nueva', ws.slug, projectId), { title: '', crit: '' });
  const newTitle = newDraft.value.title; const newCrit = newDraft.value.crit;
  const setNewTitle = (v: string) => newDraft.set(d => ({ ...d, title: v })); const setNewCrit = (v: string) => newDraft.set(d => ({ ...d, crit: v }));
  const [aiOffer, setAiOffer] = useState<{ source: string; model: string | null; byAgent: string | null; estimatedUsd: number } | null>(null);
  const [skipQa, setSkipQa] = useState(false);
  const [teamAdd, setTeamAdd] = useState<string[]>([]);
  const [teamRemove, setTeamRemove] = useState<string[]>([]);
  // Búsqueda, filtro y secciones abiertas: por proyecto (antes las secciones eran comunes a todos los proyectos).
  const [q, setQ] = usePersistentState(`portal-ia.backlog.busqueda.${ws.slug}.${projectId}`, '');
  const [filter, setFilter] = usePersistentState<'open' | 'all' | 'done' | 'discarded'>(`portal-ia.backlog.filtro.${ws.slug}.${projectId}`, 'open');
  const [openSec, setOpenSec] = usePersistentState<Record<string, boolean>>(`portal-ia.backlog.sec.${ws.slug}.${projectId}`, {});
  const toggleSec = (k: string) => setOpenSec(o => ({ ...o, [k]: !(o[k] ?? true) }));

  const load = async () => {
    const [b, a, p, ps, ph] = await Promise.all([api.backlog(ws.slug, projectId), api.agents(ws.slug), api.processes(ws.slug, projectId), api.projects(ws.slug), api.phase(ws.slug, projectId).catch(() => null)]);
    setItems(b); setAgents(a); setProcs(p); setProject(ps[0] ?? null); setPhase(ph?.current ?? null);
    // Enlace directo «/backlog?ejecutar=<id>» (p. ej. desde la historia): abre su diálogo, que sigue pidiendo tu autorización.
    const want = new URLSearchParams(location.search).get('ejecutar'); const target = want ? b.find(i => i.id === want && (i.status === 'pending' || i.status === 'blocked')) : null;
    if (want) { navigate(`${location.pathname}${location.hash}`, { replace: true }); if (target) setSel(target); }
    void api.inbox(ws.slug).then(d => { setInbox(d); setInboxErr(null); }).catch((e: any) => setInboxErr(e.message));
  };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug, projectId]);

  useEffect(() => {
    setEst(null); setEstError(null); setExecError(null); setAuth(false);
    if (!sel) return;
    api.storyEstimate(ws.slug, projectId, sel.id, skipQa, { add: teamAdd, remove: teamRemove }).then(e => { setEst(e); setBudget(e.suggestedBudgetUsd.toFixed(2)); }).catch(e => setEstError(e.message));
  }, [sel, ws.slug, projectId, skipQa, teamAdd, teamRemove]);

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
  const addItem = async () => { if (newTitle.trim().length < 3) return; setBusy(true); try { await api.addBacklogItem(ws.slug, projectId, { title: newTitle.trim(), criterion: newCrit.trim() || undefined }); newDraft.clear(); flash('Solicitud añadida al backlog'); await load(); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } };
  const execute = async () => {
    if (!sel || !auth) return; setBusy(true); setExecError(null);
    try { const p = await api.executeStory(ws.slug, projectId, sel.id, skipQa, { add: teamAdd, remove: teamRemove }); const a = await api.authorizeProcess(ws.slug, p.id, Number(budget), pipeline); flash(`Historia ${sel.storyId} en ejecución · presupuesto ${fmtUsd(a.budgetUsd)}`); navigate(`/procesos/${a.id}`); }
    catch (e: any) { setExecError(e.message); flash(e.message, 'err'); } finally { setBusy(false); }
  };

  const delegDraft = useDraft(draftKey('backlog.analisis', ws.slug, projectId), ''); const delegText = delegDraft.value; const setDelegText = delegDraft.set;
  const delegate = async () => { if (delegText.trim().length < 8) return; setBusy(true); try { const p = await api.createDelegation(ws.slug, { projectId, request: delegText.trim() }); delegDraft.clear(); flash('Encargo creado: autorízalo con un presupuesto'); navigate(`/procesos/${p.id}`); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } };
  const resetItem = async (it: BacklogItem) => { const reason = prompt(`Devolver ${it.storyId} a pendiente (su diff pendiente queda rechazado). Motivo:`, 'alcance replanteado'); if (reason === null) return; setBusy(true); try { await api.resetStory(ws.slug, it.id, reason.trim() || undefined); flash(`${it.storyId} devuelta a pendiente`); await load(); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } };
  const closeStory = async (it: BacklogItem, force: boolean) => {
    if (force) { const reason = prompt(`Cerrar ${it.storyId} como resuelta fuera del flujo (sin ejecutarla ni integrar cambios). Indica brevemente por qué:`); if (reason === null) return; setBusy(true); try { await api.markStoryDone(ws.slug, it.id, { force: true, reason: reason.trim() || 'resuelta fuera del flujo' }); flash(`${it.storyId} cerrada`); await load(); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } return; }
    setBusy(true); try { await api.markStoryDone(ws.slug, it.id); flash(`${it.storyId} completada`); await load(); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); }
  };
  const decisions = (() => {
    // El servidor ya consolida por historia; por seguridad se deja una sola entrada por historia (la iteración más alta).
    const loose: PendingDecision[] = []; const byStory = new Map<string, PendingDecision>();
    for (const d of inbox ?? []) {
      if (d.projectId !== projectId) continue;
      if (!d.storyId) { loose.push(d); continue; }
      const prev = byStory.get(d.storyId);
      if (!prev || (d.iteration ?? 0) > (prev.iteration ?? 0)) byStory.set(d.storyId, d);
    }
    return [...loose, ...byStory.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  })();
  const owner = (k: string | null) => agents.find(a => a.key === k);
  const running = procs.find(p => p.status === 'running');
  const lastProc = (it: BacklogItem) => procs.find(p => p.id === it.lastProcessId) ?? procs.find(p => p.backlogItemId === it.id);
  const depOk = (it: BacklogItem) => { if (!it.dependsOn) return true; const d = items?.find(x => x.storyId === it.dependsOn); return !d || d.status === 'done' || d.status === 'discarded'; };
  const pending = items?.filter(i => i.status !== 'done' && i.status !== 'discarded') ?? [];
  const next = pending.find(i => i.status === 'pending' && depOk(i));
  const match = (it: BacklogItem) => !q.trim() || `${it.storyId} ${it.title} ${it.criterion ?? ''}`.toLowerCase().includes(q.trim().toLowerCase());
  const all = (items ?? []).filter(match);
  const sections: { key: string; title: string; hint: string; rows: BacklogItem[]; defaultOpen: boolean }[] = [
    { key: 'active', title: 'En curso y para revisar', hint: 'Requieren tu atención', rows: all.filter(i => i.status === 'in_progress' || i.status === 'review'), defaultOpen: true },
    { key: 'pending', title: 'Pendientes (por prioridad)', hint: 'La primera ejecutable es la siguiente', rows: all.filter(i => i.status === 'pending' || i.status === 'blocked'), defaultOpen: true },
    { key: 'done', title: 'Completadas', hint: '', rows: all.filter(i => i.status === 'done'), defaultOpen: false },
    { key: 'discarded', title: 'Descartadas y fusionadas', hint: 'Conservadas como historial', rows: all.filter(i => i.status === 'discarded'), defaultOpen: false }
  ].filter(sec => filter === 'all' || (filter === 'open' && (sec.key === 'active' || sec.key === 'pending')) || (filter === 'done' && sec.key === 'done') || (filter === 'discarded' && sec.key === 'discarded'));
  const isOpen = (sec: { key: string; defaultOpen: boolean }) => openSec[sec.key] ?? sec.defaultOpen;

  return (
    <Shell crumb="Backlog">
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="eyebrow">Backlog{phase ? ` · etapa «${phase.name}»` : ''}</div>
            <h1 className="h1" style={{ fontSize: 26 }}>Plan del proyecto y solicitudes</h1>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Chip>{items?.length ?? 0} historias</Chip><Chip tone="ok">{items?.filter(i => i.status === 'done').length ?? 0} completadas</Chip><Chip tone="accent">{items?.filter(i => i.status === 'review').length ?? 0} para revisar</Chip><Chip>{pending.length} abiertas</Chip>{running && <Chip tone="warn" dot="pulse">1 en ejecución</Chip>}</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {!phase && <button className="btn btn-secondary" onClick={() => importPlan(false)} disabled={busy}>{Icon.book()}Importar historias de la síntesis</button>}
            <Link className="btn btn-ghost" to="/archivo">Archivo histórico</Link>
            <Link className="btn btn-ghost" to="/etapa">Nueva etapa</Link>
            {next && <button className="btn btn-primary" onClick={() => setSel(next)} disabled={!!running}>{Icon.arrow()}Ejecutar siguiente: {next.storyId}</button>}
          </div>
        </div>

        {aiOffer && <Notice kind="warn"><strong>No encontré historias estructuradas en «{aiOffer.source}».</strong> El {aiOffer.byAgent ?? 'Coordinador del Proyecto'} puede extraerlas con una llamada ({aiOffer.model && <span className="mono">{aiOffer.model}</span>}, costo estimado <strong>≈ {fmtUsd(aiOffer.estimatedUsd)}</strong>). <button className="btn btn-primary btn-sm" style={{ marginLeft: 8 }} onClick={() => importPlan(true)} disabled={busy}>{busy ? 'Extrayendo…' : 'Autorizar y extraer con IA'}</button></Notice>}
        {!project?.repository && <Notice kind="warn">Para ejecutar historias hace falta el repositorio registrado (los agentes leen el código y proponen cambios sobre él). <Link className="lnk" to="/panel">Registrarlo desde el panel</Link>.</Notice>}
        {inboxErr && <Notice kind="err"><strong>No se pudieron cargar las autorizaciones pendientes.</strong> {inboxErr} <Link className="lnk" to="/autorizaciones">Abrir Autorizaciones</Link></Notice>}
        {decisions.length > 0 && <Notice kind="warn"><div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}><strong>Pendientes de tu decisión ({decisions.length})</strong>
          {decisions.map(d => <div key={d.storyId ?? d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{d.title}{d.iteration != null && <> <Chip tone="accent" xs>Iteración {d.iteration}</Chip></>}: {d.impact}{d.supersededCount > 0 ? ` · ${supersededNote(d.supersededCount)}` : ''}</span>
            <button className="btn btn-primary btn-sm" onClick={() => navigate(decisionTarget(d))}>{DECISION_CTA[d.kind]}</button>
          </div>)}
          <div><Link className="lnk small" to="/autorizaciones">Ver todas en Autorizaciones</Link></div>
        </div></Notice>}
        {running && <Notice kind="info">Hay un proceso en ejecución: <button className="lnk" onClick={() => navigate(`/procesos/${running.id}`)}>{running.title}</button>. Las historias se ejecutan de una en una.</Notice>}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
          <div style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <section className="card">
              <div className="card-h" style={{ gap: 12, flexWrap: 'wrap' }}><div className="h3">Historias</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por id o texto…" aria-label="Buscar historias" style={{ height: 32, width: 220 }} />
                  <div style={{ display: 'flex', gap: 4 }}>{([['open', 'Abiertas'], ['all', 'Todas'], ['done', 'Completadas'], ['discarded', 'Descartadas']] as const).map(([k, l]) => <button key={k} className={`btn btn-sm ${filter === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(k)}>{l}</button>)}</div>
                </div></div>
              {items && items.length === 0 && <TeamReady phase={phase} onCreate={() => document.getElementById('new-story-title')?.focus()} />}
              {items && items.length > 0 && sections.map(sec => <div key={sec.key} style={{ borderTop: '1px solid #EEECE6' }}>
                <button className="arow" style={{ borderRadius: 0, padding: '10px 18px', background: '#FAF9F6' }} onClick={() => toggleSec(sec.key)} aria-expanded={isOpen(sec)}>
                  <span style={{ display: 'inline-block', transform: isOpen(sec) ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>{Icon.chevR()}</span>
                  <span style={{ flex: 1, textAlign: 'left', fontWeight: 600, fontSize: 13 }}>{sec.title} <span className="muted" style={{ fontWeight: 400 }}>· {sec.rows.length}</span></span>
                  {sec.hint && <span className="small muted">{sec.hint}</span>}
                </button>
                {isOpen(sec) && sec.rows.length === 0 && <div className="small muted" style={{ padding: '8px 18px 12px' }}>Nada aquí{q ? ' con ese filtro' : ''}.</div>}
                {isOpen(sec) && sec.rows.length > 0 && <div style={{ overflowX: 'auto' }}><table className="tbl">
                  <thead><tr><th style={{ width: 70 }}>ID</th><th>Historia</th><th style={{ width: 150 }}>Responsable</th><th style={{ width: 70 }}>Tam.</th><th style={{ width: 150 }}>Estado</th><th style={{ width: 280 }}></th></tr></thead>
                  <tbody>{sec.rows.map(it => { const st = BACKLOG_STATUS[it.status]; const o = owner(it.ownerKey); const lp = lastProc(it); const blocked = !depOk(it); const g = lp?.guidance; return <tr key={it.id} style={sel?.id === it.id ? { background: '#F3FAF9' } : it.id === next?.id ? { background: '#FFFBF0' } : undefined}>
                    <td className="mono" style={{ fontSize: 12, verticalAlign: 'top' }}>{it.storyId}</td>
                    <td style={{ verticalAlign: 'top' }}><div style={{ fontWeight: 500 }}>{it.title}{it.id === next?.id && <Chip tone="warn" xs className="" >siguiente</Chip>}</div>{it.criterion && <div className="small muted" style={{ maxWidth: '70ch', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{it.criterion}</div>}{it.dependsOn && <div className="small muted mono">depende de {it.dependsOn}</div>}</td>
                    <td className="med" style={{ verticalAlign: 'top', fontSize: 13 }}>{o?.config.name ?? it.ownerKey ?? '—'}</td>
                    <td className="med" style={{ verticalAlign: 'top' }}>{it.estimate ?? '—'}</td>
                    <td style={{ verticalAlign: 'top' }}><Chip tone={blocked && it.status === 'pending' ? 'err' : st.tone} xs dot={it.status === 'in_progress' ? 'pulse' : undefined}>{blocked && it.status === 'pending' ? `Espera ${it.dependsOn}` : st.label}</Chip>{it.status === 'review' && g && <div className="small muted" style={{ marginTop: 4, maxWidth: '24ch' }}>{g.phase}</div>}</td>
                    <td style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                      {it.status === 'review' && lp?.result?.merged && /Listo para cerrar/.test(lp.guidance?.phase ?? '') && <button className="btn btn-primary btn-sm" onClick={() => closeStory(it, false)} disabled={busy}>Cerrar historia</button>}
                      {it.status === 'review' && lp && <button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={() => navigate(`/historias/${it.id}`)}>{lp.result?.applied ? 'Continuar' : 'Revisar diff'}</button>}
                      {(lp || it.status !== 'pending') && it.status !== 'review' && <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} onClick={() => navigate(`/historias/${it.id}`)}>Espacio de la historia</button>}
                      {it.status === 'review' && lp && !lp.result?.applied && <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} title="Rechaza el diff pendiente y deja la historia lista para ejecutarse de nuevo" onClick={() => resetItem(it)} disabled={busy}>Devolver a pendiente</button>}
                      {it.status === 'in_progress' && lp && <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/procesos/${lp.id}`)}>Ver proceso</button>}
                      {(it.status === 'pending' || it.status === 'blocked') && <button className="btn btn-primary btn-sm" onClick={() => setSel(it)} disabled={!!running || !project?.repository}>Ejecutar</button>}
                      {(it.status === 'done' || it.status === 'discarded') && lp && <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/procesos/${lp.id}`)}>Ver</button>}
                      {it.status !== 'done' && it.status !== 'in_progress' && it.status !== 'discarded' && <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} title="Cerrar sin ejecutar: la historia ya está resuelta por otra vía" onClick={() => closeStory(it, true)} disabled={busy}>Cerrar</button>}
                    </td></tr>; })}</tbody>
                </table></div>}
              </div>)}
            </section>

          </div>

          {sel && (
            <div className="backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setSel(null); }}>
              <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ex-title" id="ejecutar" style={{ width: 'min(760px, 100%)' }}>
                <div className="modal-h"><div><div className="h3" id="ex-title">Ejecutar {sel.storyId} · {sel.title}</div><div className="small muted">Plan → consultas de especialistas (si la historia lo pide) → implementación → revisión QA. Nada se escribe en tu carpeta hasta que apruebes el diff.</div></div><button className="xbtn" onClick={() => setSel(null)} aria-label="Cerrar" disabled={busy}>{Icon.x(16)}</button></div>
                <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
                  <div><Chip tone="warn" xs>consume IA · requiere autorización</Chip></div>
                  {estError && <Notice kind="err"><strong>No se pudo estimar la historia.</strong> {estError}</Notice>}
                  {execError && <Notice kind="err"><strong>No se pudo iniciar la ejecución.</strong> {execError}</Notice>}
                  {sel.criterion && <div className="kv"><span>Criterio de aceptación</span><span style={{ textAlign: 'right', maxWidth: '60ch' }}>{sel.criterion}</span></div>}
                  {!est && !estError && <div className="muted sm13" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="spin" /> Estimando costo con los modelos de los agentes…</div>}
                  {est && <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <div className="eyebrow" style={{ marginBottom: 6 }}>Equipo y pasos · elegidos por capacidades, sin IA</div>
                    {est.steps.map((s, i) => { const canRemove = s.role === 'consultant' || s.role === 'reviewer'; return <div key={i} className="rrow"><span className="mono small muted">{String(i + 1).padStart(2, '0')}</span><span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}><span style={{ fontWeight: 500 }}>{s.title}</span><span className="small muted">{s.agentName} · <span className="mono">{s.model}</span>{s.reason ? ` · ${s.reason}` : ''}</span></span><span className="mono small muted">≈ {fmtUsd(s.estimatedUsd)}</span>{canRemove && s.role === 'consultant' && <button className="lnk small" onClick={() => { setTeamRemove(r => [...r, s.agentId]); setTeamAdd(a => a.filter(x => x !== s.agentId)); }}>quitar</button>}</div>; })}
                    {est.team && est.team.excluded.length > 0 && <details style={{ marginTop: 6 }}><summary className="small muted" style={{ cursor: 'pointer' }}>Agentes no incluidos ({est.team.excluded.length}) · añadir manualmente</summary>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>{est.team.excluded.map(e => <div key={e.agentId} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ flex: 1 }}><strong>{e.agentName}</strong> <span className="muted">· {e.reason}</span></span>{!/write_repo/.test(e.reason) && <button className="lnk small" onClick={() => { setTeamAdd(a => [...a, e.agentId]); setTeamRemove(r => r.filter(x => x !== e.agentId)); }}>añadir como consultor</button>}</div>)}</div></details>}
                    <div className="kv" style={{ marginTop: 6 }}><span>Costo estimado total</span><span className="mono">≈ {fmtUsd(est.estimatedUsd)} <span className="muted">(estimación; el costo real se registra por paso)</span></span></div>
                  </div>}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 14, alignItems: 'end' }}>
                    <div><label className="label" htmlFor="st-budget">Presupuesto máximo (USD)</label><input id="st-budget" className="input mono" type="number" min={0.1} step={0.5} value={budget} onChange={e => setBudget(e.target.value)} /></div>
                    <div className="help" style={{ paddingBottom: 26 }}>Si el gasto se acerca al límite, el proceso se detiene entre pasos. El Desarrollador modifica archivos con parches y crea los nuevos completos; es el paso más caro.</div>
                  </div>
                  <label className="ck"><input className="cb" type="checkbox" checked={!skipQa} onChange={e => setSkipQa(!e.target.checked)} /><span>Incluir la <strong>revisión de QA</strong> (recomendado). Sin ella la historia termina antes y cuesta menos; el diff lo revisas tú.</span></label>
                  <PipelineOptions value={pipeline} onChange={setPipeline} repo={project?.repository?.path ?? null} team={(est?.steps ?? []).map(s => { const ag = agents.find(a => a.id === s.agentId); return { agentName: s.agentName, role: s.title, model: s.model, effort: ag?.config.effort ?? null, tools: Object.entries(ag?.config.tools ?? {}).filter(([, v]) => v).map(([k]) => k) }; })} />
                  <GauntletOptions slug={ws.slug} projectId={projectId} itemId={sel.id} value={pipeline.gauntlet} onChange={g => setPipeline(p => ({ ...p, gauntlet: g }))} />
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
                <input id="new-story-title" className="input" value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Qué quieres que el equipo construya o corrija" aria-label="Título de la solicitud" />
                <textarea className="input" value={newCrit} onChange={e => setNewCrit(e.target.value)} placeholder="Criterio de aceptación (opcional): cómo sabremos que está hecho" aria-label="Criterio de aceptación" style={{ minHeight: 70 }} />
                <button className="btn btn-secondary" onClick={addItem} disabled={busy || newTitle.trim().length < 3}>Añadir al backlog</button>
                <div className="help">Se asigna al Coordinador del Proyecto. Añadirla no consume IA; ejecutarla sí, con tu autorización.</div>
              </div>
            </section>
            <section className="card">
              <div className="card-h"><div className="h3">Análisis del equipo</div><Chip tone="warn" xs>consume IA · autorizas después</Chip></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <textarea className="input" value={delegText} onChange={e => setDelegText(e.target.value)} placeholder="Ej.: Revisa y replantea el backlog según el flujo actual: fusiona lo solapado, descarta lo resuelto y repriotiza." aria-label="Análisis del equipo" style={{ minHeight: 80 }} />
                <button className="btn btn-secondary" onClick={delegate} disabled={busy || delegText.trim().length < 8}>{busy ? <span className="spin" /> : Icon.users()}Encargar al Coordinador del Proyecto</button>
                <div className="help">El Coordinador valida el encargo, consulta a los agentes a su cargo si hace falta y entrega el resultado con propuestas al backlog que tú apruebas. Se crea pendiente de tu autorización (presupuesto).</div>
              </div>
            </section>
            <section className="card card-b" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="h3">Cómo funciona</div>
              <p className="sm13 med" style={{ lineHeight: 1.5 }}>1 · Ejecutas una historia con presupuesto. 2 · Los agentes entregan un <strong>diff</strong> (y una revisión de QA si la incluyes). 3 · Lo revisas y, si apruebas, se aplica en una rama <span className="mono">portal-ia/hu-xxx</span>. 4 · Verificas (install / typecheck / test / build), <strong>integras en main</strong> y <strong>publicas</strong> desde el mismo proceso. 5 · Si es el propio Portal, la barra amarilla reconstruye y reinicia. 6 · Cierras la historia. Cada proceso te dice su «siguiente paso».</p>
            </section>
          </aside>
        </div>
      </main>
    </Shell>
  );
}

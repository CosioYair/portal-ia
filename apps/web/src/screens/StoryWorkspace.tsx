import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import type { Process, StoryContext } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, Icon, KV, Notice } from '../components/ui.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { StoryResult } from '../components/StoryResult.tsx';
import { IterationComposer } from '../components/IterationComposer.tsx';
import { StoryFlowPanel } from '../components/StoryFlowPanel.tsx';

const ROLE: Record<string, string> = { planner: 'planifica', implementer: 'implementa', reviewer: 'revisa', consultant: 'consulta' };
type Tab = 'estado' | 'chat' | 'tareas' | 'iteraciones';
const TABS: Tab[] = ['estado', 'chat', 'tareas', 'iteraciones'];
const tabFromHash = (hash: string): Tab | null => { const t = hash.replace(/^#/, '') as Tab; return TABS.includes(t) ? t : null; };
const STATUS: Record<string, { label: string; tone: '' | 'ok' | 'warn' | 'err' | 'accent' }> = { pending: { label: 'pendiente', tone: '' }, in_progress: { label: 'en ejecución', tone: 'warn' }, review: { label: 'en revisión', tone: 'accent' }, done: { label: 'completada', tone: 'ok' }, blocked: { label: 'bloqueada', tone: 'err' }, discarded: { label: 'descartada', tone: '' } };

/**
 * Espacio de la historia (M6): un solo lugar con contexto, equipo, orden de cierre, prueba paso a paso con feedback,
 * chat con los agentes implicados, tareas e iteraciones. Lo que ya existía (resumen, diff, verificación, integración)
 * se reutiliza tal cual: no hay dos sistemas.
 */
export function StoryWorkspace() {
  const { storyId } = useParams();
  const { status, flash, navigate } = useApp();
  const slug = status.workspace!.slug;
  const [ctx, setCtx] = useState<StoryContext | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { hash, state: navState } = useLocation();
  const [tab, setTab] = useState<Tab>(() => tabFromHash(hash) ?? 'estado');
  const load = async () => { try { const c = await api.story(slug, storyId!); setCtx(c); setErr(null); return c; } catch (e: any) { setErr(e.message); return null; } };
  useEffect(() => { let alive = true; const tick = async () => { const c = await load(); if (!alive) return; if (c?.lastProcess && (c.lastProcess.status === 'running' || c.lastProcess.status === 'pending_authorization')) setTimeout(tick, 3000); }; void tick(); return () => { alive = false; }; // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, storyId]);
  // La pestaña vive en el hash (#estado, #iteraciones…): así navegar a /historias/:id#iteraciones desde cualquier pestaña
  // (p. ej. tras enviar el feedback de la prueba) siempre la abre y recarga el contexto.
  const openTab = (t: Tab) => { setTab(t); if (tabFromHash(hash) !== t) navigate({ hash: t }, { replace: true }); };
  useEffect(() => { const t = tabFromHash(hash); if (t) { setTab(t); void load(); } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  // Chat (también llega una pregunta preparada desde el recorrido: «Preguntar al equipo sobre este problema»)
  const [text, setText] = useState(''); const [ask, setAsk] = useState(true); const [auth, setAuth] = useState(false); const [agentId, setAgentId] = useState<string>(''); const [est, setEst] = useState<{ agentName: string; estimatedUsd: number } | null>(null); const [sending, setSending] = useState(false);
  useEffect(() => { const q = (navState as any)?.ask; if (typeof q === 'string' && q) { setText(q); setAsk(true); } }, [navState]);
  useEffect(() => { if (ctx) api.storyAskEstimate(slug, ctx.item.id, agentId || null).then(setEst).catch(() => setEst(null)); }, [slug, ctx?.item.id, agentId]);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [ctx?.messages.length, tab]);
  const send = async () => {
    if (!ctx || text.trim().length < 1 || (ask && !auth)) return; setSending(true);
    try { await api.storyMessage(slug, ctx.item.id, text.trim(), ask ? { maxUsd: Math.max(0.1, (est?.estimatedUsd ?? 0.1) * 3), agentId: agentId || null } : undefined); setText(''); setAuth(false); await load(); }
    catch (e: any) { flash(e.message, 'err'); } finally { setSending(false); }
  };
  const applyProposal = async (messageId: string, what: { tasks?: boolean; criterion?: boolean }) => { if (!ctx) return; try { const c = await api.storyApplyProposals(slug, ctx.item.id, messageId, what); setCtx(c); flash('Propuesta aplicada'); } catch (e: any) { flash(e.message, 'err'); } };

  // Tareas
  const [newTask, setNewTask] = useState('');
  const addTask = async () => { if (!ctx || newTask.trim().length < 2) return; try { await api.storyAddTask(slug, ctx.item.id, newTask.trim()); setNewTask(''); await load(); } catch (e: any) { flash(e.message, 'err'); } };
  const fromFeedback = async () => { if (!ctx) return; try { const t = await api.storyTasksFromFeedback(slug, ctx.item.id); flash(t.length ? `${t.length} tarea(s) creadas desde la prueba` : 'No hay pasos con falla u observación nuevos'); await load(); } catch (e: any) { flash(e.message, 'err'); } };

  // Iteraciones
  const [note, setNote] = useState(''); const [iterBusy, setIterBusy] = useState(false);

  // Contexto editable (PATCH existente; el servidor registra el cambio en el historial si la historia ya se ejecutó)
  const [edit, setEdit] = useState<{ title: string; criterion: string; description: string } | null>(null);
  const [editBusy, setEditBusy] = useState(false); const [editErr, setEditErr] = useState<string | null>(null);
  const startEdit = () => { if (ctx) { setEdit({ title: ctx.item.title, criterion: ctx.item.criterion, description: ctx.item.description }); setEditErr(null); } };
  const saveEdit = async () => {
    if (!ctx || !edit) return; setEditBusy(true); setEditErr(null);
    const patch = { title: edit.title.trim(), criterion: edit.criterion.trim(), description: edit.description };
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== (ctx.item as any)[k]));
    try { if (Object.keys(changed).length) await api.patchBacklogItem(slug, ctx.item.id, changed); setEdit(null); flash(Object.keys(changed).length ? 'Contexto de la historia actualizado' : 'Sin cambios'); await load(); }
    catch (e: any) { setEditErr(e.message); } finally { setEditBusy(false); }
  };
  const [budget, setBudget] = useState(''); const [authIter, setAuthIter] = useState(false);
  const pending = ctx?.processes.find(p => p.status === 'pending_authorization') ?? null;
  useEffect(() => { if (pending && !budget) setBudget(Math.max(0.5, Math.ceil(pending.estimatedUsd * 2 * 2) / 2).toFixed(2)); }, [pending, budget]);
  const authorize = async () => { if (!pending) return; setIterBusy(true); try { await api.authorizeProcess(slug, pending.id, Number(budget)); flash(`Iteración autorizada con ${fmtUsd(Number(budget))}`); setAuthIter(false); await load(); } catch (e: any) { flash(e.message, 'err'); } finally { setIterBusy(false); } };

  if (err) return <Shell crumb="Historia"><main className="page"><Notice kind="err">{err}</Notice></main></Shell>;
  if (!ctx) return <Shell crumb="Historia"><main className="page"><span className="spin" aria-label="Cargando" /></main></Shell>;
  const it = ctx.item; const last = ctx.lastProcess; const st = STATUS[it.status] ?? { label: it.status, tone: '' as const };
  const onProcChange = (p: Process) => setCtx(c => c ? { ...c, lastProcess: c.lastProcess?.id === p.id ? { ...p } : c.lastProcess, processes: c.processes.map(x => x.id === p.id ? p : x) } : c);
  const openTasks = ctx.tasks.filter(t => t.status === 'open').length;
  const fails = ctx.feedback.items.filter(i => i.result === 'fail').length;

  return (
    <Shell crumb={<><Link to="/backlog" className="lnk">Backlog</Link> / {it.storyId}</>}>
      <main className="page" style={{ maxWidth: 1180 }}>
        <header style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow">Espacio de la historia · iteración {ctx.iterations || '—'}</div>
            <h1 className="h2" style={{ margin: '4px 0' }}>{it.storyId} · {it.title}</h1>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}><Chip tone={st.tone}>{st.label}</Chip>{it.estimate && <Chip xs>{it.estimate}</Chip>}{openTasks > 0 && <Chip tone="warn" xs>{openTasks} tarea(s) abiertas</Chip>}{fails > 0 && <Chip tone="err" xs>{fails} paso(s) con falla</Chip>}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!last && it.status === 'pending' && <button className="btn btn-primary btn-sm" onClick={() => navigate('/backlog#ejecutar')}>{Icon.arrow()}Ejecutar desde Backlog</button>}
          </div>
        </header>
        {last?.guidance?.flow ? <StoryFlowPanel proc={last} story={{ id: it.id, storyId: it.storyId, title: it.title }} variant="story" onChange={onProcChange}
          onAsk={q => { setText(q); setAsk(true); openTab('chat'); }} onOpenIterations={() => openTab('iteraciones')} />
          : last?.guidance && <Notice kind={last.guidance.tone === 'err' ? 'err' : last.guidance.tone === 'ok' ? 'ok' : last.guidance.tone === 'warn' ? 'warn' : 'info'}><div><strong>Siguiente paso:</strong> {last.guidance.next}</div></Notice>}

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 320px)', gap: 16, alignItems: 'start', marginTop: 14 }}>
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['estado', 'chat', 'tareas', 'iteraciones'] as const).map(t => <button key={t} className={`btn btn-sm ${tab === t ? 'btn-primary' : 'btn-ghost'}`} onClick={() => openTab(t)}>{t === 'estado' ? 'Estado y prueba' : t === 'chat' ? `Chat con el equipo${ctx.messages.length ? ` (${ctx.messages.length})` : ''}` : t === 'tareas' ? `Tareas${openTasks ? ` (${openTasks})` : ''}` : `Iteraciones (${ctx.iterations})`}</button>)}
            </div>

            {tab === 'estado' && (last ? (last.status === 'done' || (last.result?.changes.length ?? 0) > 0 ? <StoryResult proc={last} onChange={onProcChange} /> : <section className="card card-b"><p className="sm13">La iteración actual está <strong>{last.status === 'running' ? 'en ejecución' : last.status === 'pending_authorization' ? 'pendiente de autorización' : last.status}</strong>. {last.status === 'pending_authorization' ? 'Autorízala en la pestaña Iteraciones.' : ''}<Link className="lnk" to={`/procesos/${last.id}`}> Ver el proceso</Link>.</p></section>) : <section className="card card-b"><p className="sm13 muted">Esta historia aún no se ha ejecutado. Hazlo desde Backlog («Ejecutar») para que el equipo proponga el diff; después todo el seguimiento ocurre aquí.</p></section>)}

            {tab === 'chat' && <section className="card">
              <div className="card-h"><div><div className="h3">Chat con los agentes de la historia</div><div className="small muted">El agente elegido responde con todo el contexto (criterio, diff, QA, prueba, tareas). Cada pregunta es una llamada autorizada; las notas sin IA son gratis.</div></div></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 460, overflow: 'auto', padding: 2 }}>
                  {ctx.messages.length === 0 && <p className="sm13 muted" style={{ margin: 0 }}>Sin mensajes. Pregunta por qué falló un paso, pide que replanteen el alcance o deja una nota para la próxima iteración.</p>}
                  {ctx.messages.map(m => <div key={m.id} style={{ alignSelf: m.role === 'owner' ? 'flex-end' : 'flex-start', maxWidth: '92%', background: m.role === 'owner' ? '#1A1B1E' : m.role === 'system' ? '#FFFBF0' : '#FAF9F6', color: m.role === 'owner' ? '#fff' : '#1A1B1E', borderRadius: 10, padding: '8px 12px' }}>
                    <div className="small" style={{ opacity: 0.75, marginBottom: 2 }}>{m.role === 'owner' ? 'Tú' : m.role === 'system' ? 'Portal' : m.agentName} · {new Date(m.createdAt).toLocaleString()}{m.costUsd ? ` · ${m.costUsd.toFixed(4)} USD real` : ''}</div>
                    {m.role === 'owner' ? <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div> : <Markdown text={m.content} />}
                    {m.proposals && !m.proposals.applied && (m.proposals.tasks.length > 0 || m.proposals.criterion || m.proposals.iterate) && <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid #E5E3DC', paddingTop: 8 }}>
                      {m.proposals.tasks.length > 0 && <div className="sm13"><strong>Propone tareas:</strong> {m.proposals.tasks.map(t => t.title).join(' · ')} <button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={() => applyProposal(m.id, { tasks: true })}>Crear tareas</button></div>}
                      {m.proposals.criterion && <div className="sm13"><strong>Propone criterio:</strong> {m.proposals.criterion} <button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={() => applyProposal(m.id, { criterion: true })}>Aplicar criterio</button></div>}
                      {m.proposals.iterate && <div className="sm13"><strong>Propone una nueva iteración</strong>{m.proposals.iterationNote ? `: ${m.proposals.iterationNote}` : ''} <button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={() => { setNote(m.proposals!.iterationNote ?? ''); openTab('iteraciones'); }}>Preparar iteración</button></div>}
                    </div>}
                    {m.proposals?.applied && <div className="small muted" style={{ marginTop: 4 }}>propuesta aplicada</div>}
                  </div>)}
                  <div ref={endRef} />
                </div>
                <textarea className="input" style={{ minHeight: 70 }} value={text} onChange={e => setText(e.target.value)} placeholder="Escribe al equipo…" onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(); }} />
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label className="ck"><input className="cb" type="checkbox" checked={ask} onChange={e => setAsk(e.target.checked)} /><span>Pedir respuesta a</span></label>
                  <select className="input" style={{ maxWidth: 240, height: 34 }} value={agentId} onChange={e => setAgentId(e.target.value)} disabled={!ask}><option value="">Coordinador (responde por el equipo)</option>{ctx.team.map(m => <option key={m.agentId} value={m.agentId}>{m.agentName} · {ROLE[m.role] ?? m.role}</option>)}</select>
                  {ask && <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo una llamada ({est ? `≈ ${est.estimatedUsd.toFixed(3)} USD` : '…'})</span></label>}
                  <button className="btn btn-primary btn-sm" onClick={send} disabled={sending || text.trim().length < 1 || (ask && !auth)}>{sending ? <span className="spin spin-light" /> : Icon.arrow()}{ask ? 'Preguntar' : 'Guardar nota'}</button>
                </div>
              </div>
            </section>}

            {tab === 'tareas' && <section className="card">
              <div className="card-h"><div><div className="h3">Tareas de la historia</div><div className="small muted">Lo que falta para cerrarla. Las abiertas se incluyen en la siguiente iteración.</div></div><button className="btn btn-secondary btn-sm" onClick={fromFeedback}>Crear desde los pasos con falla</button></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {ctx.tasks.length === 0 && <p className="sm13 muted" style={{ margin: 0 }}>Sin tareas.</p>}
                {ctx.tasks.map(t => <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <input className="cb" type="checkbox" checked={t.status === 'done'} onChange={async e => { await api.storySetTask(slug, it.id, t.id, e.target.checked ? 'done' : 'open'); await load(); }} />
                  <span style={{ flex: 1, textDecoration: t.status === 'done' ? 'line-through' : undefined, color: t.status === 'done' ? '#686B72' : undefined }}>{t.title}<span className="small muted"> · {t.assigneeName ?? 'sin asignar'} · {t.source === 'feedback' ? 'de la prueba' : t.source === 'agent' ? 'propuesta del equipo' : 'tuya'}</span></span>
                  <button className="lnk small" onClick={async () => { await api.storyDeleteTask(slug, it.id, t.id); await load(); }}>quitar</button>
                </div>)}
                <div style={{ display: 'flex', gap: 8 }}><input className="input" style={{ flex: 1, height: 34 }} value={newTask} onChange={e => setNewTask(e.target.value)} placeholder="Nueva tarea…" onKeyDown={e => { if (e.key === 'Enter') void addTask(); }} /><button className="btn btn-secondary btn-sm" onClick={addTask} disabled={newTask.trim().length < 2}>Añadir</button></div>
              </div>
            </section>}

            {tab === 'iteraciones' && <section className="card">
              <div className="card-h"><div><div className="h3">Iteraciones</div><div className="small muted">Cada iteración es un proceso del equipo con el contexto de la anterior: feedback de la prueba, tareas abiertas, conversación y tu nota.</div></div></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {ctx.processes.map((p, i) => <div key={p.id} className="rrow" style={{ alignItems: 'flex-start' }}><span className="mono small muted">#{ctx.processes.length - i}</span><span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontWeight: 500 }}>{p.guidance?.phase ?? p.status}</span><span className="small muted">{new Date(p.createdAt).toLocaleString()} · {p.steps.length} pasos · gastado {fmtUsd(p.spentUsd)} de {fmtUsd(p.budgetUsd)}{p.result?.iterationContext ? ' · con contexto de iteración' : ''}</span></span><Link className="btn btn-ghost btn-sm" to={`/procesos/${p.id}`}>Abrir</Link></div>)}
                {pending ? <Notice kind="warn"><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div><strong>Iteración pendiente de autorización</strong> · estimación ≈ {fmtUsd(pending.estimatedUsd)} · {pending.steps.length} pasos ({pending.steps.map(s => s.agentName).join(', ')})</div>
                  {pending.result?.iterationContext && <details><summary className="small muted" style={{ cursor: 'pointer' }}>Contexto que recibirá el equipo</summary><pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#FAF9F6', padding: 8, borderRadius: 8 }}>{pending.result.iterationContext}</pre></details>}
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}><label className="label" htmlFor="it-budget" style={{ margin: 0 }}>Presupuesto (USD)</label><input id="it-budget" className="input mono" style={{ width: 120, height: 34 }} type="number" min={0.1} step={0.5} value={budget} onChange={e => setBudget(e.target.value)} /><label className="ck"><input className="cb" type="checkbox" checked={authIter} onChange={e => setAuthIter(e.target.checked)} /><span>Autorizo al equipo a trabajar hasta ese importe</span></label><button className="btn btn-primary btn-sm" onClick={authorize} disabled={!authIter || iterBusy || !(Number(budget) > 0)}>{iterBusy ? <span className="spin spin-light" /> : Icon.arrow()}Autorizar iteración</button></div>
                </div></Notice> : ctx.iteration.state !== 'in_progress' && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="eyebrow">{ctx.iteration.needsReopen ? 'Reabrir la historia y crear una nueva iteración' : 'Nueva iteración'}</div>
                  <IterationComposer key={`${ctx.iterations}:${note}`} slug={slug} itemId={it.id} iteration={ctx.iteration} nextNumber={ctx.iterations + 1} initialNote={note}
                    onCreated={async () => { setNote(''); flash('Iteración creada: autorízala con un presupuesto'); await load(); }} />
                </div>}
              </div>
            </section>}
          </div>

          <aside style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <section className="card" aria-label="Contexto"><div className="card-h"><div className="h3">Contexto</div>{!edit && <button className="btn btn-ghost btn-sm" onClick={startEdit}>Editar</button>}</div><div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {edit ? <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="ctx-title" style={{ margin: 0 }}>Título</label>
                <input id="ctx-title" className="input" style={{ height: 34 }} value={edit.title} maxLength={200} onChange={e => setEdit({ ...edit, title: e.target.value })} />
                <label className="label" htmlFor="ctx-criterion" style={{ margin: 0 }}>Criterio de aceptación</label>
                <textarea id="ctx-criterion" className="input" style={{ minHeight: 80 }} value={edit.criterion} maxLength={600} onChange={e => setEdit({ ...edit, criterion: e.target.value })} />
                <label className="label" htmlFor="ctx-description" style={{ margin: 0 }}>Descripción e historial</label>
                <textarea id="ctx-description" className="input" style={{ minHeight: 120 }} value={edit.description} maxLength={4000} onChange={e => setEdit({ ...edit, description: e.target.value })} />
                {(it.lastProcessId || it.status !== 'pending') && <span className="small muted">El cambio queda registrado en el historial de la historia (pestaña Chat) y la próxima iteración usa este contexto.</span>}
                {editErr && <Notice kind="err">{editErr}</Notice>}
                <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" onClick={saveEdit} disabled={editBusy || edit.title.trim().length < 3}>{editBusy ? <span className="spin spin-light" /> : Icon.check()}Guardar</button><button className="btn btn-ghost btn-sm" onClick={() => { setEdit(null); setEditErr(null); }} disabled={editBusy}>Cancelar</button></div>
              </div> : <>
              <div><div className="eyebrow" style={{ marginBottom: 4 }}>Título</div><div className="sm13">{it.title}</div></div>
              <div><div className="eyebrow" style={{ marginBottom: 4 }}>Criterio de aceptación</div><div className="sm13">{it.criterion || <span className="muted">sin criterio</span>}</div></div>
              {it.description && <div><div className="eyebrow" style={{ marginBottom: 4 }}>Descripción e historial</div><div className="sm13" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{it.description}</div></div>}
              </>}
              {!edit && last?.result?.userFacing && <div><div className="eyebrow" style={{ marginBottom: 4 }}>Qué cambia para ti</div><div className="sm13"><Markdown text={last.result.userFacing} /></div></div>}
              <KV k="Proyecto">{ctx.project.name}</KV>
              {it.dependsOn && <KV k="Depende de">{it.dependsOn}</KV>}
            </div></section>
            <section className="card"><div className="card-h"><div className="h3">Equipo de la historia</div><span className="small muted">{ctx.team.length}</span></div><div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ctx.team.length === 0 && <span className="sm13 muted">Se compone al ejecutar (por capacidades, sin IA).</span>}
              {ctx.team.map(m => <div key={m.agentId} style={{ display: 'flex', flexDirection: 'column' }}><span className="sm13"><strong>{m.agentName}</strong> · {ROLE[m.role] ?? m.role}{m.override ? ' · añadido por ti' : ''}</span><span className="small muted">{m.reason}{m.model ? ` · ${m.model}` : ''}</span></div>)}
            </div></section>
            {ctx.lessons.length > 0 && <section className="card"><div className="card-h"><div className="h3">Lecciones de esta historia</div><Link className="lnk small" to="/conocimiento#lecciones">ver</Link></div><div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ctx.lessons.map(l => <div key={l.id} className="sm13"><Chip tone={l.status === 'validated' ? 'ok' : l.status === 'detected' ? 'warn' : ''} xs>{({ detected: 'detectada', proposed: 'propuesta', validated: 'validada', rejected: 'rechazada', obsolete: 'obsoleta' } as Record<string, string>)[l.status] ?? l.status}</Chip> {l.title}</div>)}
            </div></section>}
          </aside>
        </div>
      </main>
    </Shell>
  );
}

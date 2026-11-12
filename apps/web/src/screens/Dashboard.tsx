import { useEffect, useRef, useState } from 'react';
import { useLive } from '../lib/live.ts';
import { Link } from 'react-router-dom';
import type { BacklogItem, KnowledgeDoc, Process, UsageToday, PhaseTransition } from '@portal-ia/domain';
import { BACKLOG_STATUS } from '../lib/labels.ts';
import { api, type ProjectFull } from '../lib/api.ts';
import { osApi, type OfficeAgent } from '../lib/osApi.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { TeamReady } from '../components/TeamReady.tsx';
import { Avatar, Chip, Empty, Icon, KV, StatusIcon, type PortalState } from '../components/ui.tsx';
import { STATE_TEXT } from '../components/AgentFigure.tsx';
import { PageHeader, Stat } from '../components/kit.tsx';
import { RepoCard } from '../components/RepoCard.tsx';
import { AssessmentCard } from '../components/AssessmentCard.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { SummaryCard } from '../components/SummaryCard.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { officeHome } from '../lib/routes.ts';

/** HU-168 · Traduce el estado de un proceso a un estado del Portal (icono + texto), para no depender solo del color. */
function procState(status: string): PortalState {
  switch (status) {
    case 'running': return 'running';
    case 'done': return 'done';
    case 'failed':
    case 'budget_exceeded': return 'error';
    case 'cancelled': return 'blocked';
    case 'pending_authorization': return 'pending';
    default: return 'pending';
  }
}

/** HU-168 · Texto visible de cada estado; también es el texto accesible del icono, para que lo que se oye y lo que se ve coincidan. */
const PROC_LABEL: Record<Process['status'], string> = {
  running: 'en ejecución',
  done: 'completado',
  pending_authorization: 'pendiente de autorización',
  failed: 'con errores',
  cancelled: 'cancelado',
  budget_exceeded: 'presupuesto agotado',
};

/** HU-163 · Estado de «Qué necesita tu atención»: solo hay cifra cuando los datos ya han llegado. */
type Attention = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; count: number };

/**
 * Resumen del proyecto (Portal IA 2.0, antes «Panel»): primero lo que te necesita, luego las cifras del trabajo,
 * el contexto plegado, la etapa, el backlog y lo integrado; a la derecha el equipo con su estado REAL de la Oficina.
 */
export function Dashboard() {
  const { status, providers, flash, navigate } = useApp();
  const ws = status.workspace!;
  const [project, setProject] = useState<ProjectFull | null>(null);
  const [team, setTeam] = useState<OfficeAgent[] | null>(null);
  const [usage, setUsage] = useState<UsageToday | null>(null);
  const [procs, setProcs] = useState<Process[]>([]);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [backlog, setBacklog] = useState<BacklogItem[]>([]);
  const [phase, setPhase] = useState<PhaseTransition | null>(null);
  const [reqText, setReqText] = useState('');
  const [sending, setSending] = useState(false);
  const [attention, setAttention] = useState<Attention>({ phase: 'loading' });
  const attentionSeq = useRef(0);

  // HU-163 · Mismo endpoint que la bandeja de Decisiones (más lo que piden los agentes, como la campana). Aparte de load(); no consume IA.
  const loadAttention = async () => {
    const seq = ++attentionSeq.current;
    // Solo la primera vez se muestra «cargando»: al actualizar en tiempo real se conserva lo que había (sin parpadeo).
    setAttention(a => a.phase === 'ready' ? a : { phase: 'loading' });
    try {
      const [pending, office] = await Promise.all([api.inbox(ws.slug), osApi.office(ws.slug, null).catch(() => null)]);
      const asks = office ? office.agents.reduce((n, a) => n + a.attention.filter(x => !x.processId).length, 0) : 0;
      if (seq === attentionSeq.current) setAttention({ phase: 'ready', count: pending.length + asks });
    } catch (e) {
      if (seq === attentionSeq.current) setAttention({ phase: 'error', message: e instanceof Error ? e.message : 'No se pudieron cargar las decisiones pendientes.' });
    }
  };
  useEffect(() => { void loadAttention(); return () => { attentionSeq.current++; }; // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug]);
  const pendingCount = attention.phase === 'ready' ? attention.count : 0;

  const load = async () => {
    const [ps, us] = await Promise.all([api.projects(ws.slug), api.usageToday(ws.slug)]);
    const cur = ps.find(p => p.id === status.project?.id) ?? ps[0] ?? null;
    setProject(cur); setUsage(us);
    // El equipo con el estado que calcula el servidor para la Oficina (trabajando, en cola, te necesita…), no un «activo» guardado.
    void osApi.office(ws.slug, cur?.id ?? null).then(o => setTeam(o.agents.filter(a => a.scope === 'workspace' || a.projectId === cur?.id))).catch(() => setTeam([]));
    if (cur) { const [pr, kd, bl, ph] = await Promise.all([api.processSummaries(ws.slug, cur.id).catch(() => []), api.knowledge(ws.slug, cur.id).catch(() => []), api.backlog(ws.slug, cur.id).catch(() => []), api.phase(ws.slug, cur.id).catch(() => null)]); setProcs(pr); setDocs(kd); setBacklog(bl); setPhase(ph?.current ?? null); }
  };
  // Un fallo al cargar (p. ej. el servidor reiniciándose) no rompe la pantalla: se conserva lo que había y el tiempo
  // real (o su respaldo) lo vuelve a pedir.
  useEffect(() => { load().catch(() => undefined); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug, status.project?.id]);
  // Tiempo real: procesos, historias, lotes, encargos y agentes del espacio (aquí, en otra pestaña o en un lote) sin recargar.
  useLive(c => c.ws === ws.slug && c.kind !== 'progress' && ['process', 'backlog', 'batch', 'assignment', 'knowledge', 'agent', 'agent_chat'].includes(c.entity), () => Promise.all([load(), loadAttention()]), { minMs: 2500 });

  const connected = providers.filter(p => p.status === 'connected');
  const synthesis = docs.find(d => d.title.startsWith('Síntesis') && (!phase || d.createdAt > phase.startedAt)) ?? null;
  const baseline = phase?.baselineDocId ? docs.find(d => d.id === phase.baselineDocId) ?? null : null;
  const running = procs.filter(p => p.status === 'running');
  const integrated = procs.filter(p => p.kind === 'story_execution' && p.result?.merged).slice(0, 5);
  const open = backlog.filter(b => b.status !== 'done' && b.status !== 'discarded');
  const inProgress = backlog.filter(b => b.status === 'in_progress').length;
  const done = backlog.filter(b => b.status === 'done').length;
  const projectTeam = (team ?? []).filter(a => a.scope === 'project');
  const companyTeam = (team ?? []).filter(a => a.scope === 'workspace');
  const busy = (team ?? []).filter(a => a.state === 'working' || a.state === 'queued').length;
  const member = (a: OfficeAgent) => (
    <Link key={a.id} className="arow" to={`/oficina/agente/${encodeURIComponent(a.id)}`} title={`Abrir el panel de ${a.name}`}>
      <Avatar initials={a.initials} ws={a.scope === 'workspace'} />
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{a.name}</span><span className="small muted">{a.role}</span></span>
      <span className={`state-pill state-${a.state}`}>{STATE_TEXT[a.state]}</span>
    </Link>
  );

  return (
    <Shell crumb="Resumen">
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <PageHeader icon={Icon.gauge(22)} tone="project" eyebrow={`${ws.name} · Resumen del proyecto`} title={project?.name ?? status.project!.name}
          actions={<>
            <Link className="btn btn-primary" to="/backlog">{Icon.arrow()}{open.length ? 'Ejecutar backlog' : 'Backlog'}</Link>
          </>}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Chip tone={project?.repository ? 'ok' : 'warn'}>{project?.repository ? `Repositorio registrado · solo lectura${project.repository.branch ? ` · ${project.repository.branch}` : ''}` : 'Repositorio no registrado'}</Chip>
            {phase && <Chip tone="accent">Etapa · {phase.name}</Chip>}
            <Chip dot={busy ? 'ok' : ''}>{team ? `${team.length} agentes · ${busy ? `${busy} trabajando o en cola` : 'ninguno trabajando'}` : 'Equipo…'}</Chip>
          </div>
        </PageHeader>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
          <div style={{ flex: '999 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <SummaryCard
              title="Qué necesita tu atención"
              state={attention.phase}
              tone={pendingCount > 0 ? 'warn' : 'ok'}
              value={pendingCount > 0 ? pendingCount : undefined}
              message={pendingCount > 0 ? (pendingCount === 1 ? 'decisión espera tu respuesta' : 'decisiones esperan tu respuesta') : 'Todo al día'}
              action={pendingCount > 0 ? { label: 'Revisar y decidir', onClick: () => navigate('/autorizaciones') } : undefined}
              errorMessage={attention.phase === 'error' ? attention.message : undefined}
              onRetry={() => void loadAttention()}
            />

            <div className="stats" role="group" aria-label="Cifras del proyecto">
              <Stat icon={Icon.kanban()} tone="work" value={open.length} label="historias abiertas" />
              <Stat icon={Icon.activity()} tone={inProgress ? 'working' : undefined} value={inProgress} label="en curso" />
              <Stat icon={Icon.check()} tone="ok" value={backlog.length ? `${done}/${backlog.length}` : '0'} label="completadas" />
              <Stat icon={Icon.wallet()} value={(usage?.costUsd ?? 0).toFixed(2)} label="USD de API hoy" />
            </div>

            <section className="card" aria-label="Contexto aprobado del proyecto">
              <div className="card-b" style={{ padding: '4px 18px', display: 'flex', flexDirection: 'column' }}>
                <Disclosure title="Qué construye este proyecto" hint="Descripción aprobada">
                  <p className="med" style={{ lineHeight: 1.55 }}>{project?.description}</p>
                </Disclosure>
                <Disclosure title="Objetivos iniciales" hint={`${project?.objectives.length ?? 0} objetivos`}>
                  <ol style={{ paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column' }}>
                    {project?.objectives.map((o, i) => <li key={o.id} className="rrow"><span className="mono small muted">0{i + 1}</span><span>{o.text}</span></li>)}
                  </ol>
                </Disclosure>
                <Disclosure title="Arquitectura aprobada" hint={`${project?.context.length ?? 0} elementos`}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{project?.context.map(c => <Chip key={c.id}>{c.label}</Chip>)}</div>
                </Disclosure>
                {project && synthesis && <Disclosure title="Dirección del proyecto" hint={`Síntesis del Coordinador del Proyecto tras la evaluación inicial · ${new Date(synthesis.createdAt).toLocaleString('es-MX')}`}>
                  <div style={{ maxHeight: 520, overflow: 'auto' }}><Markdown text={synthesis.body} /></div>
                </Disclosure>}
              </div>
              <div className="card-f"><Link className="lnk sm13" to="/conocimiento">Ver todos los documentos</Link></div>
            </section>

            {phase && <section className="card" aria-label="Etapa vigente" style={{ borderColor: 'var(--color-accent-border)' }}>
              <div className="card-h"><div><div className="eyebrow">Etapa vigente</div><div className="h3">{phase.name}</div><div className="small muted">Desde {new Date(phase.startedAt).toLocaleDateString('es-MX')} · base: commit <span className="mono">{phase.gitHead?.slice(0, 7) ?? '—'}</span> · {phase.summary.archivedStories.length} historias de la etapa anterior en el archivo</div></div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Link className="btn btn-ghost btn-sm" to="/archivo">Archivo histórico</Link><Link className="btn btn-ghost btn-sm" to="/etapa">Etapas</Link></div></div>
              {baseline && <div className="card-b"><details><summary className="sm13" style={{ cursor: 'pointer' }}>Línea base del proyecto (lo que ya existe y está verificado)</summary><div style={{ maxHeight: 520, overflow: 'auto', marginTop: 8 }}><Markdown text={baseline.body} /></div></details></div>}
            </section>}
            {!phase && project && <div className="small muted">Sin etapa iniciada. <Link className="lnk" to="/etapa">Etapas del proyecto</Link></div>}

            {project && !synthesis && !phase && <AssessmentCard projectId={project.id} hasRepo={!!project.repository} compact />}

            <section className="card">
              <div className="card-h"><div><div className="h3">Backlog y solicitudes</div><div className="small muted">Historias del plan y peticiones tuyas. Se ejecutan una a una con tu autorización.</div></div><Link className="lnk sm13" to="/backlog">Abrir backlog</Link></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {backlog.length === 0 && phase && <TeamReady phase={phase} onCreate={() => document.getElementById('dash-request')?.focus()} />}
                {backlog.length === 0 && !phase && <Empty icon={Icon.inbox()} title="Aún no hay historias" hint={synthesis ? 'Importa las historias del plan desde el backlog o añade una solicitud aquí.' : 'Ejecuta la evaluación inicial para obtener el plan, o añade una solicitud aquí.'} style={{ padding: '14px 16px 6px' }} />}
                {backlog.length > 0 && <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {backlog.filter(b => b.status !== 'done').slice(0, 5).map(b => { const st = BACKLOG_STATUS[b.status]; return <Link key={b.id} className="rrow rrow-link" to={`/historias/${encodeURIComponent(b.id)}`}><span className="mono small muted">{b.storyId}</span><span style={{ flex: 1, fontWeight: 500 }}>{b.title}</span><Chip tone={st.tone} xs dot={b.status === 'in_progress' ? 'pulse' : undefined}>{st.label}</Chip></Link>; })}
                  <div className="small muted" style={{ paddingTop: 8 }}>{done} de {backlog.length} completadas</div>
                </div>}
                <form style={{ display: 'flex', flexDirection: 'column', gap: 8 }} onSubmit={async e => { e.preventDefault(); if (!project || reqText.trim().length < 3) return; setSending(true); try { await api.addBacklogItem(ws.slug, project.id, { title: reqText.trim() }); setReqText(''); flash('Solicitud añadida al backlog'); await load(); } catch (err: any) { flash(err.message, 'err'); } finally { setSending(false); } }}>
                  <textarea id="dash-request" className="input" value={reqText} onChange={e => setReqText(e.target.value)} placeholder="Describe lo que quieres que el equipo construya o corrija…" aria-label="Nueva solicitud de desarrollo" style={{ minHeight: 72 }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}><span className="small muted">Añadirla no consume IA. Se ejecuta desde el backlog con presupuesto autorizado.</span><button className="btn btn-secondary btn-sm" type="submit" disabled={sending || reqText.trim().length < 3}>Añadir al backlog</button></div>
                </form>
              </div>
            </section>

            {integrated.length > 0 && <section className="card">
              <div className="card-h"><div><div className="h3">Novedades integradas</div><div className="small muted">Lo último que llegó a la rama principal y en qué paso de cierre va.</div></div><Link className="lnk sm13" to="/actividad">Ver actividad</Link></div>
              <ul className="news-list">
                {integrated.map(p => { const r = p.result!; const mt = r.manualTest; const tested = mt ? mt.checks.filter(Boolean).length : 0; const g = p.guidance; return <li key={p.id} className="news-row">
                  <div className="news-row-h"><span className="news-title">{p.title}</span>{g && <Chip tone={g.tone === 'ok' ? 'ok' : g.tone === 'err' ? 'err' : 'warn'} xs>{g.phase}</Chip>}{mt && <Chip xs tone={tested === mt.steps.length ? 'ok' : ''}>probado {tested}/{mt.steps.length}</Chip>}<button className="lnk sm13 news-open" onClick={() => navigate(`/procesos/${p.id}`)}>Abrir{g?.next ? ` · ${g.next}` : ''}</button></div>
                  <details className="news-more"><summary className="small">Qué aporta</summary><div className="sm13" style={{ lineHeight: 1.55 }}>{r.userFacing ? <Markdown text={r.userFacing} /> : <span className="muted">Sin explicación para el propietario (historia anterior a v0.11). Archivos: {r.changes.slice(0, 5).map(c => c.path).join(', ')}.</span>}</div></details>
                </li>; })}
              </ul>
            </section>}

            {project && <RepoCard project={project} onChanged={load} />}
          </div>

          <aside style={{ flex: '1 1 320px', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 20 }} aria-label="Equipo, procesos y proveedores">
            <section className="card">
              <div className="card-h"><div className="h3">Equipo del proyecto</div><Link className="lnk sm13" to={officeHome()}>Ver la Oficina</Link></div>
              {team === null && <div className="card-b"><span className="small muted">Cargando el equipo…</span></div>}
              {team && <div className="card-b" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 1 }}>{projectTeam.length ? projectTeam.map(member) : <span className="small muted" style={{ padding: 8 }}>Este proyecto aún no tiene agentes propios.</span>}</div>}
              {companyTeam.length > 0 && <><div className="side-sec" style={{ paddingTop: 6 }}>Agentes de la empresa</div>
                <div className="card-b" style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>{companyTeam.map(member)}</div></>}
            </section>
            <section className="card">
              <div className="card-h"><div className="h3">Procesos</div><Chip xs dot={running.length ? 'pulse' : ''}>{running.length ? `${running.length} en ejecución` : 'ninguno en ejecución'}</Chip></div>
              <div className="card-b">
                {procs.length === 0 && <Empty icon={Icon.activity()} title="Ningún proceso todavía" hint="Ningún agente ejecuta tareas ni consume créditos sin tu autorización." style={{ padding: '8px 0 12px' }} />}
                {procs.slice(0, 4).map(p => <button key={p.id} className="arow" onClick={() => navigate(`/procesos/${p.id}`)}><StatusIcon state={procState(p.status)} label={PROC_LABEL[p.status] ?? p.status} showLabel={false} /><span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{p.title}</span><span className="small muted">{PROC_LABEL[p.status] ?? p.status}</span></span><span className="small mono muted">{fmtUsd(p.spentUsd)}</span></button>)}
                {procs.length > 0 && <div style={{ padding: '6px 10px 0' }}><Link className="lnk sm13" to="/actividad">Ver actividad</Link></div>}
                <KV k="Procesos hoy"><span className="mono">{usage?.processes ?? 0}</span></KV>
                <KV k="Tokens consumidos"><span className="mono">{usage?.tokens ?? 0}</span></KV>
                <KV k="Costo acumulado"><span className="mono">{fmtUsd(usage?.costUsd ?? 0)}</span></KV>
              </div>
            </section>
            <section className="card">
              <div className="card-h"><div className="h3">Proveedores</div></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {connected.length === 0 && <span className="small muted">Ningún proveedor de API conectado (Claude Code usa tu suscripción).</span>}
                {connected.map(p => <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className="plogo mono" style={{ width: 32, height: 32, fontSize: 13 }}>{p.name[0]}</span>
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</span><span className="small muted">Predeterminado · {p.models.find(m => m.id === p.defaultModel)?.name ?? '—'}</span></span>
                  <Chip tone="ok" xs dot="ok">conectado</Chip>
                </div>)}
                <Link className="btn btn-secondary btn-sm" to="/configuracion/proveedor" style={{ alignSelf: 'flex-start' }}>Añadir o revisar proveedores</Link>
              </div>
            </section>
          </aside>
        </div>
      </main>
    </Shell>
  );
}

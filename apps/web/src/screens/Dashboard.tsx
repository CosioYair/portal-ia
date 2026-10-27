import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, BacklogItem, KnowledgeDoc, Process, UsageToday, PhaseTransition } from '@portal-ia/domain';
import { BACKLOG_STATUS } from '../lib/labels.ts';
import { api, type ProjectFull } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { TeamReady } from '../components/TeamReady.tsx';
import { Avatar, Chip, Empty, Icon, KV } from '../components/ui.tsx';
import { FolderPicker } from '../components/FolderPicker.tsx';
import { RepoCard } from '../components/RepoCard.tsx';
import { AssessmentCard } from '../components/AssessmentCard.tsx';
import { Markdown } from '../components/Markdown.tsx';

export function Dashboard() {
  const { status, providers, flash, navigate } = useApp();
  const ws = status.workspace!;
  const [project, setProject] = useState<ProjectFull | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [usage, setUsage] = useState<UsageToday | null>(null);
  const [picker, setPicker] = useState(false);
  const [procs, setProcs] = useState<Process[]>([]);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [backlog, setBacklog] = useState<BacklogItem[]>([]);
  const [phase, setPhase] = useState<PhaseTransition | null>(null);
  const [reqText, setReqText] = useState('');
  const [sending, setSending] = useState(false);

  const load = async () => {
    const [ps, ag, us] = await Promise.all([api.projects(ws.slug), api.agents(ws.slug), api.usageToday(ws.slug)]);
    const cur = ps.find(p => p.id === status.project?.id) ?? ps[0] ?? null;
    setProject(cur); setAgents(ag.filter(a => a.scope === 'workspace' || a.projectId === cur?.id)); setUsage(us);
    if (cur) { const [pr, kd, bl, ph] = await Promise.all([api.processes(ws.slug, cur.id).catch(() => []), api.knowledge(ws.slug, cur.id).catch(() => []), api.backlog(ws.slug, cur.id).catch(() => []), api.phase(ws.slug, cur.id).catch(() => null)]); setProcs(pr); setDocs(kd); setBacklog(bl); setPhase(ph?.current ?? null); }
  };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug, status.project?.id]);

  const connected = providers.filter(p => p.status === 'connected');
  const modelShort = (a: Agent) => providers.find(p => p.id === a.config.provider)?.models.find(m => m.id === a.config.model)?.short ?? a.config.model;
  const active = agents.filter(a => a.status === 'active').length;
  const synthesis = docs.find(d => d.title.startsWith('Síntesis') && (!phase || d.createdAt > phase.startedAt)) ?? null;
  const baseline = phase?.baselineDocId ? docs.find(d => d.id === phase.baselineDocId) ?? null : null;
  const running = procs.filter(p => p.status === 'running');
  const integrated = procs.filter(p => p.kind === 'story_execution' && p.result?.merged).slice(0, 6);
  const row = (a: Agent) => (
    <button key={a.id} className="arow" onClick={() => navigate(`/equipo/${a.id}`)}>
      <Avatar initials={a.template.initials} ws={a.scope === 'workspace'} />
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{a.config.name}</span><span className="small muted">{a.template.role}</span></span>
      <span className="small mono muted">{modelShort(a)}</span>
    </button>
  );

  return (
    <Shell crumb="Panel">
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="eyebrow">Proyecto interno</div>
            <h1 className="h1" style={{ fontSize: 26 }}>{project?.name ?? status.project!.name}</h1>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Chip tone="accent">Espacio · {ws.name}</Chip>
              <Chip tone={project?.repository ? 'ok' : 'warn'}>{project?.repository ? `Repositorio registrado · solo lectura${project.repository.branch ? ` · ${project.repository.branch}` : ''}` : 'Repositorio no registrado'}</Chip>
              <Chip dot={active ? 'ok' : ''}>{agents.length} agentes · {active} activos</Chip>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link className="btn btn-secondary" to="/equipo">Configurar equipo</Link>
            <Link className="btn btn-primary" to="/backlog">{Icon.arrow()}{backlog.some(b => b.status !== 'done' && b.status !== 'discarded') ? 'Ejecutar backlog' : 'Backlog'}</Link>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
          <div style={{ flex: '999 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <section className="card">
              <div className="card-h"><div className="h3">Qué construye este proyecto</div><Chip xs>contexto aprobado</Chip></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <p className="med" style={{ lineHeight: 1.55 }}>{project?.description}</p>
                <div><div className="eyebrow" style={{ marginBottom: 8 }}>Objetivos iniciales</div>
                  <ol style={{ paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column' }}>
                    {project?.objectives.map((o, i) => <li key={o.id} className="rrow"><span className="mono small muted">0{i + 1}</span><span>{o.text}</span></li>)}
                  </ol></div>
                <div><div className="eyebrow" style={{ marginBottom: 8 }}>Arquitectura aprobada</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{project?.context.map(c => <Chip key={c.id}>{c.label}</Chip>)}</div></div>
              </div>
            </section>

            {phase && <section className="card" aria-label="Etapa vigente" style={{ borderColor: '#BFD9D6' }}>
              <div className="card-h"><div><div className="eyebrow">Etapa vigente</div><div className="h3">{phase.name}</div><div className="small muted">Desde {new Date(phase.startedAt).toLocaleDateString('es-MX')} · base: commit <span className="mono">{phase.gitHead?.slice(0, 7) ?? '—'}</span> · {phase.summary.archivedStories.length} historias de la etapa anterior en el archivo</div></div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Link className="btn btn-ghost btn-sm" to="/archivo">Archivo histórico</Link><Link className="btn btn-ghost btn-sm" to="/etapa">Etapas</Link></div></div>
              {baseline && <div className="card-b"><details><summary className="sm13" style={{ cursor: 'pointer' }}>Línea base del proyecto (lo que ya existe y está verificado)</summary><div style={{ maxHeight: 520, overflow: 'auto', marginTop: 8 }}><Markdown text={baseline.body} /></div></details></div>}
            </section>}

            {project && synthesis && (
              <section className="card">
                <div className="card-h"><div><div className="h3">Dirección del proyecto</div><div className="small muted">Síntesis del Coordinador del Proyecto tras la evaluación inicial · {new Date(synthesis.createdAt).toLocaleString('es-MX')}</div></div><Link className="lnk sm13" to="/conocimiento">Ver todos los documentos</Link></div>
                <div className="card-b" style={{ maxHeight: 520, overflow: 'auto' }}><Markdown text={synthesis.body} /></div>
              </section>
            )}
            {project && !synthesis && !phase && <AssessmentCard projectId={project.id} hasRepo={!!project.repository} compact />}

            {project && <RepoCard project={project} onPick={() => setPicker(true)} onChanged={load} />}

            {integrated.length > 0 && <section className="card">
              <div className="card-h"><div><div className="h3">Novedades integradas</div><div className="small muted">Qué aportó cada historia integrada en la rama principal y en qué paso de cierre va.</div></div><Link className="lnk sm13" to="/actividad">Ver actividad</Link></div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {integrated.map(p => { const r = p.result!; const mt = r.manualTest; const tested = mt ? mt.checks.filter(Boolean).length : 0; const g = p.guidance; return <div key={p.id} style={{ padding: '12px 18px', borderTop: '1px solid #EEECE6', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><span style={{ fontWeight: 600 }}>{p.title}</span>{g && <Chip tone={g.tone === 'ok' ? 'ok' : g.tone === 'err' ? 'err' : 'warn'} xs>{g.phase}</Chip>}{mt && <Chip xs tone={tested === mt.steps.length ? 'ok' : ''}>probado {tested}/{mt.steps.length}</Chip>}</div>
                  <div className="sm13" style={{ lineHeight: 1.55 }}>{r.userFacing ? <Markdown text={r.userFacing} /> : <span className="muted">Sin explicación para el propietario (historia anterior a v0.11). Archivos: {r.changes.slice(0, 5).map(c => c.path).join(', ')}.</span>}</div>
                  <div><button className="lnk sm13" onClick={() => navigate(`/procesos/${p.id}`)}>Abrir el proceso → {g?.next}</button></div>
                </div>; })}
              </div>
            </section>}

            <section className="card">
              <div className="card-h"><div><div className="h3">Backlog y solicitudes</div><div className="small muted">Historias del plan y peticiones tuyas. Se ejecutan una a una con tu autorización.</div></div><Link className="lnk sm13" to="/backlog">Abrir backlog</Link></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {backlog.length === 0 && phase && <TeamReady phase={phase} onCreate={() => document.getElementById('dash-request')?.focus()} />}
                {backlog.length === 0 && !phase && <Empty icon={Icon.inbox()} title="Aún no hay historias" hint={synthesis ? 'Importa las historias del plan desde el backlog o añade una solicitud aquí.' : 'Ejecuta la evaluación inicial para obtener el plan, o añade una solicitud aquí.'} style={{ padding: '14px 16px 6px' }} />}
                {backlog.length > 0 && <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {backlog.filter(b => b.status !== 'done').slice(0, 5).map(b => { const st = BACKLOG_STATUS[b.status]; return <div key={b.id} className="rrow"><span className="mono small muted">{b.storyId}</span><span style={{ flex: 1, fontWeight: 500 }}>{b.title}</span><Chip tone={st.tone} xs dot={b.status === 'in_progress' ? 'pulse' : undefined}>{st.label}</Chip></div>; })}
                  <div className="small muted" style={{ paddingTop: 8 }}>{backlog.filter(b => b.status === 'done').length} de {backlog.length} completadas</div>
                </div>}
                <form style={{ display: 'flex', flexDirection: 'column', gap: 8 }} onSubmit={async e => { e.preventDefault(); if (!project || reqText.trim().length < 3) return; setSending(true); try { await api.addBacklogItem(ws.slug, project.id, { title: reqText.trim() }); setReqText(''); flash('Solicitud añadida al backlog'); await load(); } catch (err: any) { flash(err.message, 'err'); } finally { setSending(false); } }}>
                  <textarea id="dash-request" className="input" value={reqText} onChange={e => setReqText(e.target.value)} placeholder="Describe lo que quieres que el equipo construya o corrija…" aria-label="Nueva solicitud de desarrollo" style={{ minHeight: 72 }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}><span className="small muted">Añadirla no consume IA. Se ejecuta desde el backlog con presupuesto autorizado.</span><button className="btn btn-secondary btn-sm" type="submit" disabled={sending || reqText.trim().length < 3}>Añadir al backlog</button></div>
                </form>
              </div>
            </section>
          </div>

          <aside style={{ flex: '1 1 320px', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <section className="card">
              <div className="card-h"><div className="h3">Equipo del proyecto</div><Chip xs dot="">{agents.filter(a => a.scope === 'project').length} · inactivos</Chip></div>
              <div className="card-b" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 1 }}>{agents.filter(a => a.scope === 'project').map(row)}</div>
              <div className="side-sec" style={{ paddingTop: 6 }}>Agentes del espacio</div>
              <div className="card-b" style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>{agents.filter(a => a.scope === 'workspace').map(row)}</div>
              <div className="card-f" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span className="small muted">Creados desde plantillas aprobadas</span><Link className="lnk sm13" to="/equipo">Gestionar equipo</Link></div>
            </section>
            <section className="card">
              <div className="card-h"><div className="h3">Procesos</div><Chip xs dot={running.length ? 'pulse' : ''}>{running.length ? `${running.length} en ejecución` : 'ninguno en ejecución'}</Chip></div>
              <div className="card-b">
                {procs.length === 0 && <Empty icon={Icon.activity()} title="Ningún proceso todavía" hint="Los agentes inactivos no ejecutan tareas ni consumen créditos." style={{ padding: '8px 0 12px' }} />}
                {procs.slice(0, 4).map(p => <button key={p.id} className="arow" onClick={() => navigate(`/procesos/${p.id}`)}><span className={`dot ${p.status === 'running' ? 'dot-warn dot-pulse' : p.status === 'done' ? 'dot-ok' : p.status === 'failed' || p.status === 'budget_exceeded' ? 'dot-err' : ''}`} /><span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{p.title}</span><span className="small muted">{({ running: 'en ejecución', done: 'completado', pending_authorization: 'pendiente de autorización', failed: 'con errores', cancelled: 'cancelado', budget_exceeded: 'presupuesto agotado' } as Record<string, string>)[p.status] ?? p.status}</span></span><span className="small mono muted">{fmtUsd(p.spentUsd)}</span></button>)}
                {procs.length > 0 && <div style={{ padding: '6px 10px 0' }}><Link className="lnk sm13" to="/actividad">Ver actividad</Link></div>}
                <KV k="Procesos hoy"><span className="mono">{usage?.processes ?? 0}</span></KV>
                <KV k="Tokens consumidos"><span className="mono">{usage?.tokens ?? 0}</span></KV>
                <KV k="Costo acumulado"><span className="mono">{fmtUsd(usage?.costUsd ?? 0)}</span></KV>
              </div>
            </section>
            <section className="card">
              <div className="card-h"><div className="h3">Proveedores</div></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
      {picker && project && <FolderPicker title="Seleccionar carpeta del repositorio" hint="Elige la carpeta local que contiene el código de Portal IA. Al seleccionarla, autorizas su registro con acceso de solo lectura." requireGit
        onSelect={async (p) => { setPicker(false); try { await api.registerRepository(ws.slug, project.id, p); await load(); flash('Repositorio registrado con acceso de solo lectura'); } catch (e: any) { flash(e.message, 'err'); } }}
        onClose={() => setPicker(false)} />}
    </Shell>
  );
}

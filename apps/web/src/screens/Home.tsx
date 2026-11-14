import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AcceptanceView, Agent } from '@portal-ia/domain';
import { api, type WorkItem, type WorkView } from '../lib/api.ts';
import { studioApi, type StudioProjectSummary } from '../lib/studioApi.ts';
import { useApp } from '../lib/store.ts';
import { useLive } from '../lib/live.ts';
import { openUi } from '../lib/uiBus.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, Icon, Notice } from '../components/ui.tsx';
import '../home.css';

/**
 * Portal IA 4 · «Inicio»: tu oficina hoy. Responde, sin abrir nada más, a tres preguntas: qué te necesita, qué está
 * haciendo el equipo y qué se terminó. Cada tarjeta tiene UNA acción. No repite lo que ya dicen las otras pantallas:
 * enlaza a ellas. Funciona también sin proyecto (empresa recién creada).
 */
const workHref = (i: WorkItem) => (i.kind === 'story' ? `/historias/${i.id}` : i.processId ? `/procesos/${i.processId}` : '/asistente');
function actionLabel(i: WorkItem): string {
  switch (i.state.key) {
    case 'needs_authorization': return 'Revisar y autorizar';
    case 'ready_for_review': return 'Revisar el resultado';
    case 'integrated_unaccepted': return 'Probar y aceptar';
    case 'working': case 'queued': return 'Ver el avance';
    default: return i.segment === 'done' ? 'Ver' : 'Ver qué pasó y continuar';
  }
}
const ago = (iso: string): string => { const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); return m < 1 ? 'ahora' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`; };

function Item({ i }: { i: WorkItem }) {
  return <li className={`home-item home-tone-${i.state.tone || 'none'}`}>
    <div className="home-item-main">
      <span className="home-item-top"><span className="home-code">{i.code}</span><Chip tone={i.state.tone} xs>{i.state.label}</Chip></span>
      <strong className="home-item-title">{i.title}</strong>
      <span className="home-item-meaning">{i.state.meaning}</span>
    </div>
    <Link className={`btn ${i.state.needsOwner ? 'btn-primary' : 'btn-secondary'} btn-sm home-go`} to={workHref(i)}>{actionLabel(i)}<span className="sr-only">: {i.code} {i.title}</span></Link>
  </li>;
}

export function Home() {
  const { status } = useApp(); const ws = status.workspace!; const project = status.project;
  const [work, setWork] = useState<WorkView | null>(null); const [agents, setAgents] = useState<Agent[] | null>(null);
  const [videos, setVideos] = useState<StudioProjectSummary[] | null>(null); const [acc, setAcc] = useState<AcceptanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadWork = () => { if (!project) { setWork({ items: [], counts: { needs_you: 0, running: 0, todo: 0, done: 0 } }); return; } api.work(ws.slug, project.id).then(v => { setWork(v); setError(null); }).catch(e => setError(e?.message ?? 'No se pudo cargar el trabajo.')); };
  useEffect(() => { loadWork(); api.agents(ws.slug).then(setAgents).catch(() => setAgents([])); studioApi.list(ws.slug).then(setVideos).catch(() => setVideos([])); api.acceptance().then(setAcc).catch(() => undefined); }, [ws.slug, project?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(c => c.ws === ws.slug && c.kind !== 'progress' && ['process', 'backlog', 'assignment', 'batch'].includes(c.entity), loadWork, { minMs: 5000 });

  const items = work?.items ?? [];
  const needs = items.filter(i => i.segment === 'needs_you'); const running = items.filter(i => i.segment === 'running');
  const recent = items.filter(i => i.segment === 'done').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  const accSteps = acc?.steps ?? []; const accFail = accSteps.filter(s => s.mark?.result === 'fail').length; const accTodo = accSteps.filter(s => !s.mark?.result).length;
  const calm = work && needs.length === 0;

  return <Shell crumb="Inicio">
    <div className="page home">
      <header className="home-hero">
        <div>
          <h1 className="h1">{calm ? 'Todo en orden' : work ? `${needs.length === 1 ? 'Una cosa te necesita' : `${needs.length} cosas te necesitan`}` : 'Tu oficina'}</h1>
          <p className="lede">{project ? <>{ws.name} · {project.name}</> : ws.name}{work && running.length > 0 ? ` · el equipo trabaja en ${running.length === 1 ? 'un encargo' : `${running.length} encargos`}` : ''}</p>
        </div>
        <button type="button" className="btn btn-primary home-ask" onClick={() => openUi('assistant')}>{Icon.sparkles()} Pedir algo al equipo</button>
      </header>
      {error && <Notice kind="err">{error}</Notice>}

      {needs.length > 0 && <section className="home-sec" aria-labelledby="home-needs">
        <div className="home-sec-h"><h2 id="home-needs" className="home-h2">Te necesitan</h2>{needs.length > 4 && <Link className="lnk" to="/trabajo?ver=te-necesitan">Ver los {needs.length}</Link>}</div>
        <ul className="home-list">{needs.slice(0, 4).map(i => <Item key={`${i.kind}:${i.id}`} i={i} />)}</ul>
      </section>}

      {running.length > 0 && <section className="home-sec" aria-labelledby="home-running">
        <div className="home-sec-h"><h2 id="home-running" className="home-h2">En marcha</h2>{running.length > 3 && <Link className="lnk" to="/trabajo?ver=en-marcha">Ver todo</Link>}</div>
        <ul className="home-list">{running.slice(0, 3).map(i => <Item key={`${i.kind}:${i.id}`} i={i} />)}</ul>
      </section>}

      {calm && running.length === 0 && <section className="home-calm"><p>{project ? 'Nadie espera una decisión tuya y el equipo no tiene nada en marcha.' : 'Esta empresa aún no tiene un proyecto.'} Portal IA es tu equipo de agentes de IA: tú pides un resultado con tus palabras, ellos lo hacen y tú lo revisas y lo aceptas. Empieza con «Pedir algo al equipo».</p></section>}

      <div className="home-grid">
        <section className="home-card" aria-labelledby="home-done">
          <div className="home-sec-h"><h2 id="home-done" className="home-h2">Terminado hace poco</h2><Link className="lnk" to="/trabajo?ver=terminado">Todo el trabajo</Link></div>
          {recent.length === 0 ? <p className="home-empty">Todavía no hay trabajo cerrado.</p> : <ul className="home-mini">{recent.map(i => <li key={`${i.kind}:${i.id}`}><Link to={workHref(i)}><span className="home-code">{i.code}</span> {i.title}</Link><span className="home-when">{ago(i.updatedAt)}</span></li>)}</ul>}
        </section>

        <section className="home-card" aria-labelledby="home-team">
          <div className="home-sec-h"><h2 id="home-team" className="home-h2">Tu equipo</h2><Link className="lnk" to="/oficina">Ver los agentes</Link></div>
          {!agents ? <p className="home-empty">Cargando…</p> : agents.length === 0 ? <p className="home-empty">Aún no hay agentes.</p> : <>
            <p className="home-big"><strong>{agents.length}</strong> {agents.length === 1 ? 'agente' : 'agentes'}</p>
            <ul className="home-chips">{agents.slice(0, 6).map(a => <li key={a.id}><Link className="home-agent" to={`/oficina/agente/${a.id}`}>{a.config.name}</Link></li>)}{agents.length > 6 && <li className="home-more">y {agents.length - 6} más</li>}</ul>
          </>}
          <div className="home-actions"><Link className="btn btn-ghost btn-sm" to="/oficina/nuevo-agente">{Icon.plus()} Crear un agente</Link><Link className="btn btn-ghost btn-sm" to="/oficina/analisis">{Icon.shield()} Analizar un programa</Link></div>
        </section>

        <section className="home-card" aria-labelledby="home-studio">
          <div className="home-sec-h"><h2 id="home-studio" className="home-h2">Estudio</h2><Link className="lnk" to="/estudio">Abrir el Estudio</Link></div>
          {!videos ? <p className="home-empty">Cargando…</p> : videos.length === 0 ? <p className="home-empty">Monta vídeos con tus clips, música y texto, y expórtalos en MP4.</p> : <ul className="home-mini">{videos.slice(0, 3).map(v => <li key={v.id}><Link to={`/estudio/${v.id}`}>{v.name}</Link><span className="home-when">{ago(v.updatedAt)}</span></li>)}</ul>}
        </section>

        {acc && (accFail > 0 || accTodo > 0) && <section className="home-card" aria-labelledby="home-acc">
          <div className="home-sec-h"><h2 id="home-acc" className="home-h2">Tu prueba del Portal</h2><Link className="lnk" to="/aceptacion">Abrir el recorrido</Link></div>
          <p className="home-empty">{accFail > 0 ? `${accFail} ${accFail === 1 ? 'paso que marcaste como fallo sigue abierto' : 'pasos que marcaste como fallo siguen abiertos'}.` : ''} {accTodo > 0 ? `${accTodo} ${accTodo === 1 ? 'paso por probar' : 'pasos por probar'}.` : ''} Solo tú decides si el Portal hace lo que pediste.</p>
        </section>}
      </div>
    </div>
  </Shell>;
}

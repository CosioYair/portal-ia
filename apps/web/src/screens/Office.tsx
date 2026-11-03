import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Shell } from '../components/Shell.tsx';
import { Icon, Notice, Spinner } from '../components/ui.tsx';
import { PageHeader, SectionTabs, EmptyState } from '../components/kit.tsx';
import { AgentFigure, STATE_TEXT, StateBadge } from '../components/AgentFigure.tsx';
import { AgentPanel } from '../components/AgentPanel.tsx';
import { Modal } from '../components/Modal.tsx';
import { HarnessDialog } from '../components/HarnessDialog.tsx';
import { CommandBar } from '../components/CommandBar.tsx';
import { OrganizationView } from './Team.tsx';
import { useApp } from '../lib/store.ts';
import { useLive, useLiveConnection } from '../lib/live.ts';
import { rememberOfficeView, OFFICE_VIEWS, tabFor } from '../lib/routes.ts';
import { osApi, type Department, type OfficeAgent, type OfficeView } from '../lib/osApi.ts';
import '../office.css';

/**
 * La oficina (Portal IA 2.0): la empresa como un lugar y como punto de partida. Cifras que filtran la planta, lo que te
 * necesita (con su enlace), salas por departamento con el estado REAL de cada puesto (calculado en el servidor a partir
 * de procesos, conversaciones y decisiones), y las vistas Departamentos, Organización y Lista. Clic en un puesto → su
 * panel. Nada aquí llama a la IA por sí solo.
 */
type View = 'planta' | 'departamentos' | 'organizacion' | 'lista';
let lastView: View = 'planta';
type Filter = null | 'attention' | 'working' | 'queued' | 'unavailable';
const deptStyle = (hue: number) => ({ '--dept-h': Math.max(0, Math.min(360, Number(hue) || 0)) } as CSSProperties);

export function Office({ view: routeView }: { view?: Exclude<View, 'planta'> }) {
  const { status, flash } = useApp();
  const ws = status.workspace!; const project = status.project;
  const { agentId, tab } = useParams();
  const navigate = useNavigate();
  const liveConn = useLiveConnection();
  const [view, setView] = useState<OfficeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // La vista la decide la ruta (enlace directo, historial); con el panel de un agente abierto, la última vista sigue debajo.
  const mode: View = routeView ?? (agentId ? lastView : 'planta');
  useEffect(() => { if (!agentId) { lastView = mode; rememberOfficeView(mode); } }, [mode, agentId]);
  const [dialog, setDialog] = useState<null | 'department' | 'harness' | { request: Department }>(null);
  const [filter, setFilter] = useState<Filter>(null);
  // Con muchos agentes: búsqueda y salas que muestran primero a quien te necesita o trabaja (12 por sala, «Ver todos»).
  const [q, setQ] = useState(''); const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const ROOM_MAX = 12;
  const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const matches = (a: OfficeAgent) => (!q.trim() || norm(`${a.name} ${a.role} ${a.department}`).includes(norm(q.trim())))
    && (!filter || (filter === 'attention' ? a.attention.length > 0 : a.state === filter));
  const load = useCallback(() => osApi.office(ws.slug, project?.id ?? null).then(v => { setView(v); setError(null); }).catch(e => setError(e.message)), [ws.slug, project?.id]);
  useEffect(() => { void load(); }, [load]);
  useLive(c => c.ws === ws.slug && ['process', 'agent', 'department', 'agent_chat', 'batch', 'assignment'].includes(c.entity) && (c.kind !== 'progress' || c.entity === 'agent_chat' || c.entity === 'agent'), () => void load(), { minMs: 1200 });
  // Abrir un panel desde la oficina crea una entrada en el historial; cerrarlo vuelve atrás (Atrás no lo reabre) y devuelve
  // el foco al puesto del agente.
  const openedHere = useRef(false); const lastDesk = useRef<string | null>(null);
  const open = (id: string, t = 'chat') => { openedHere.current = true; lastDesk.current = id; navigate(`/oficina/agente/${id}/${t}`); };
  const close = useCallback(() => {
    const id = agentId ?? lastDesk.current;
    if (openedHere.current) { openedHere.current = false; navigate(-1); } else navigate(OFFICE_VIEWS.find(v => v.view === mode)?.to ?? '/oficina', { replace: true });
    requestAnimationFrame(() => (document.querySelector(`[data-agent-id="${id}"]`) as HTMLElement | null)?.focus());
  }, [agentId, navigate, mode]);
  const byDep = useMemo(() => {
    const m = new Map<string, OfficeAgent[]>();
    const rank: Record<OfficeAgent['state'], number> = { attention: 0, working: 1, queued: 2, unavailable: 3, idle: 4, retired: 5 };
    for (const a of view?.agents ?? []) { if (!matches(a)) continue; const l = m.get(a.departmentSlug) ?? []; l.push(a); m.set(a.departmentSlug, l); }
    for (const l of m.values()) l.sort((x, y) => (y.attention.length ? 1 : 0) - (x.attention.length ? 1 : 0) || rank[x.state] - rank[y.state] || x.name.localeCompare(y.name, 'es'));
    return m;
  }, [view, q, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = view?.agents.find(a => a.id === agentId) ?? null;
  const hueOf = (slug: string) => view?.departments.find(d => d.slug === slug)?.hue ?? 260;
  const alive = (view?.agents ?? []).filter(a => a.state !== 'retired');
  // «Te necesita» es independiente del estado: un agente puede estar trabajando y tener algo esperándote.
  const needs = alive.filter(a => a.attention.length > 0);
  const count = (s: OfficeAgent['state']) => alive.filter(a => a.state === s).length;
  const kpis: { key: Exclude<Filter, null>; label: string; value: number; tone: string; icon: ReactNode }[] = [
    { key: 'attention', label: `te necesitan${view?.counts.decisions ? ` · ${view.counts.decisions} decisiones` : ''}`, value: needs.length, tone: 'attention', icon: Icon.bell() },
    { key: 'working', label: 'trabajando ahora', value: count('working'), tone: 'working', icon: Icon.bolt() },
    { key: 'queued', label: 'en cola', value: count('queued'), tone: 'queued', icon: Icon.history() },
    { key: 'unavailable', label: 'no pueden trabajar', value: count('unavailable'), tone: 'err', icon: Icon.warn() }
  ];
  const viewLabel = OFFICE_VIEWS.find(v => v.view === mode)?.label ?? 'Planta';

  return (
    <Shell crumb={viewLabel}>
      <main className="page office">
        <PageHeader icon={Icon.building(22)} tone="office" eyebrow="Tu empresa" title={ws.name}
          description="Tus departamentos y agentes, con lo que hacen ahora. Abre un puesto para conversar, encargar o revisar."
          actions={<>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDialog('harness')}>{Icon.sliders()} Motores de IA</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog('department')}>{Icon.plus()} Departamento</button>
            <NewAgentMenu disabled={!project} />
          </>}>
          <SectionTabs label="Vistas de la oficina" tabs={OFFICE_VIEWS.map(v => ({ to: v.to, label: v.label, end: true, match: v.view === mode ? /(?:)/ : /^(?!)/ }))} />
        </PageHeader>

        {view && (mode === 'planta' || mode === 'lista') && <div className="stats office-kpis" role="group" aria-label="Filtrar la planta por estado">
          {kpis.map(k => <button key={k.key} type="button" className={`stat stat-${k.tone}${k.value ? '' : ' is-zero'}`} aria-pressed={filter === k.key}
            onClick={() => { setFilter(f => f === k.key ? null : k.key); if (mode !== 'planta' && mode !== 'lista') navigate('/oficina'); }}>
            <span className={`tile tile-sm tile-${k.value ? k.tone : 'idle'}`} aria-hidden="true">{k.icon}</span>
            <span><span className="stat-value">{k.value}</span><span className="stat-label" style={{ display: 'block' }}>{k.label}</span></span>
          </button>)}
        </div>}
        {view && <div className="office-live" role="status">{liveConn === 'down' ? <>{Icon.warn()} Sin tiempo real: los estados se actualizan cada 15 s.</> : <>{Icon.okc()} Estados en tiempo real{filter ? <> · filtro «{kpis.find(k => k.key === filter)?.label}» <button type="button" className="lnk" onClick={() => setFilter(null)}>quitar</button></> : null}</>}</div>}

        {view && needs.length > 0 && mode === 'planta' && !filter && <section className="card" aria-labelledby="needs-h">
          <div className="card-h"><div className="h3" id="needs-h">Te necesitan</div><Link className="small" to="/autorizaciones">Ver todo en Decisiones →</Link></div>
          <div className="needs">{needs.slice(0, 5).map(a => { const first = a.attention[0]; return <div key={a.id} className="needs-row">
            <AgentFigure id={a.id} hue={hueOf(a.departmentSlug)} state={a.state} size={32} />
            <div className="needs-text"><strong>{a.name}</strong><span>{first.label}{a.attention.length > 1 ? ` · y ${a.attention.length - 1} más` : ''}</span></div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => open(a.id, tabFor(first))}>Revisar</button>
          </div>; })}</div>
        </section>}

        <CommandBar agents={view?.agents ?? []} departments={view?.departments ?? []} onAgent={id => open(id, 'chat')} onDepartment={d => setDialog({ request: d })} />
        {view && view.agents.length > 12 && mode !== 'organizacion' && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><label className="sr" htmlFor="office-q">Buscar agente</label><input id="office-q" className="input" style={{ maxWidth: 340, height: 36 }} value={q} onChange={e => setQ(e.target.value)} placeholder={`Buscar entre ${view.agents.length} agentes (nombre, papel o departamento)`} />{q && <span className="small muted">{[...byDep.values()].reduce((n, l) => n + l.length, 0)} coinciden</span>}</div>}

        {error && <Notice kind="err">{error}</Notice>}
        {!view && !error && <Spinner />}
        {view && !view.agents.length && <EmptyState art="office" title="Tu oficina está vacía" action={<Link className="btn btn-primary" to="/oficina/nuevo-agente">{Icon.plus()} Crear el primer agente</Link>}>Crea un agente describiendo lo que necesitas, importa uno portable o integra uno que ya trabaja en su propia carpeta.</EmptyState>}

        {view && view.agents.length > 0 && mode === 'planta' && <div className="office-floor">
          {view.departments.filter(d => (!q.trim() && !filter) || (byDep.get(d.slug)?.length ?? 0) > 0).map(d => {
            const all = byDep.get(d.slug) ?? []; const showAll = expanded.has(d.slug) || !!q.trim() || !!filter;
            const members = showAll ? all : all.slice(0, ROOM_MAX);
            const aliveHere = all.filter(m => m.state !== 'retired'); const needHere = aliveHere.filter(m => m.attention.length).length; const workHere = aliveHere.filter(m => m.state === 'working').length;
            return <section key={d.slug} className="room" aria-labelledby={`room-${d.slug}`} style={deptStyle(d.hue)}>
              <div className="room-wall">
                <h2 className="room-sign" id={`room-${d.slug}`}><span className="swatch" aria-hidden="true" />{d.name}</h2>
                <span className="room-meta">{aliveHere.length} {aliveHere.length === 1 ? 'agente' : 'agentes'}{workHere > 0 && <span className="state-pill state-working">{workHere} trabajando</span>}{needHere > 0 && <span className="state-pill state-attention">{needHere} te necesita{needHere > 1 ? 'n' : ''}</span>}</span>
              </div>
              {d.purpose && <div className="room-purpose">{d.purpose}</div>}
              {members.length ? <Desks agents={members} name={d.name} hue={d.hue} current={agentId ?? null} onOpen={a => open(a.id, a.attention.length ? tabFor(a.attention[0]) : 'chat')} />
                : <div className="room-empty">Sala vacía. Crea un agente para este departamento o mueve uno desde su panel.</div>}
              {all.length > ROOM_MAX && !q.trim() && !filter && <button type="button" className="btn btn-ghost btn-sm" style={{ margin: '0 12px 8px' }} aria-expanded={showAll} onClick={() => setExpanded(s0 => { const n = new Set(s0); if (n.has(d.slug)) n.delete(d.slug); else n.add(d.slug); return n; })}>{showAll ? 'Mostrar menos' : `Ver todos (${all.length})`}</button>}
              <div className="room-actions">
                {aliveHere.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDialog({ request: d })}>{Icon.chat()} Pedir algo a {d.name}</button>}
                {project && <Link className="btn btn-ghost btn-sm" to={`/oficina/nuevo-agente?departamento=${encodeURIComponent(d.name)}`}>{Icon.plus()} Añadir agente</Link>}
              </div>
            </section>;
          })}
        </div>}
        {view && mode === 'departamentos' && <div className="dept-grid">{view.departments.map(d => {
          const ms = view.agents.filter(a => a.departmentSlug === d.slug && a.state !== 'retired'); const coord = ms.find(a => a.id === d.coordinatorAgentId);
          return <section key={d.slug} className="card dept-card" style={deptStyle(d.hue)} aria-labelledby={`dep-${d.slug}`}>
            <div><h2 className="h3" id={`dep-${d.slug}`}>{d.name}</h2>{d.purpose && <p className="small med" style={{ marginTop: 4 }}>{d.purpose}</p>}</div>
            <div className="small">{coord ? <>Coordina <strong>{coord.name}</strong></> : <span className="muted">Sin coordinador</span>} · {ms.length} {ms.length === 1 ? 'agente' : 'agentes'}{ms.some(m => m.attention.length) && <> · <span className="state-pill state-attention">te necesita</span></>}</div>
            <div className="dept-faces">{ms.slice(0, 10).map(a => <button key={a.id} type="button" className="xbtn" style={{ width: 'auto', height: 'auto', padding: 2 }} onClick={() => open(a.id)} aria-label={`${a.name}: ${STATE_TEXT[a.state]}`} title={`${a.name} · ${STATE_TEXT[a.state]}`}><AgentFigure id={a.id} hue={d.hue} state={a.state} size={30} /></button>)}{!ms.length && <span className="small muted">Sala vacía</span>}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {ms.length > 0 && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog({ request: d })}>Pedir algo</button>}
              {project && <Link className="btn btn-ghost btn-sm" to={`/oficina/nuevo-agente?departamento=${encodeURIComponent(d.name)}`}>Añadir agente</Link>}
            </div>
          </section>;
        })}</div>}
        {view && mode === 'organizacion' && <OrganizationView office={view.agents} onOpen={(id, t) => open(id, t)} />}
        {view && mode === 'lista' && <OfficeList agents={view.agents.filter(matches)} onOpen={id => open(id)} current={agentId ?? null} />}
      </main>
      {agentId && <AgentPanel slug={ws.slug} agentId={agentId} tab={tab ?? 'chat'} office={current} departments={view?.departments ?? []} projects={view?.projects ?? []} onTab={t => navigate(`/oficina/agente/${agentId}/${t}`, { replace: true })} onClose={close} onChanged={() => void load()} />}
      {dialog === 'department' && <DepartmentDialog slug={ws.slug} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); flash('Departamento creado'); }} />}
      {dialog === 'harness' && <HarnessDialog onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && <DepartmentRequestDialog slug={ws.slug} department={dialog.request} agents={(view?.agents ?? []).filter(a => a.departmentSlug === dialog.request.slug && a.state !== 'retired')} projects={view?.projects ?? []} defaultProject={project?.id ?? null} onClose={() => setDialog(null)} onDone={id => { setDialog(null); flash('Petición enviada al departamento'); navigate(`/procesos/${id}`); }} />}
    </Shell>
  );
}

/** «Nuevo agente ▾»: crear, importar una carpeta portable o integrar un agente que ya trabaja en su carpeta. */
function NewAgentMenu({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false); const btn = useRef<HTMLButtonElement>(null); const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) list.current?.querySelector<HTMLElement>('a')?.focus(); }, [open]);
  const onKey = (e: RKeyboardEvent) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('a') ?? [])]; const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  return <div className="menu" onKeyDown={onKey}>
    <button ref={btn} type="button" className="btn btn-primary btn-sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} disabled={disabled} title={disabled ? 'Crea primero un proyecto (menú › Proyecto › ＋)' : undefined}>{Icon.agent()} Nuevo agente {Icon.chevD()}</button>
    {open && <div ref={list} className="menu-list" role="menu" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <Link role="menuitem" className="menu-item" to="/oficina/nuevo-agente">Crear un agente<span>Describe lo que necesitas; te propone su perfil</span></Link>
      <Link role="menuitem" className="menu-item" to="/oficina/nuevo-agente?importar=portable">Importar carpeta portable<span>Un agente exportado de otro Portal o empresa</span></Link>
      <Link role="menuitem" className="menu-item" to="/oficina/nuevo-agente?importar=externo">Integrar agente existente<span>Uno que ya trabaja en su carpeta (AGENTS.md…)</span></Link>
    </div>}
  </div>;
}

/** Puestos de una sala: una sola parada de Tab por sala y flechas para moverse entre puestos (Enter abre). */
function Desks({ agents, name, hue, current, onOpen }: { agents: OfficeAgent[]; name: string; hue: number; current: string | null; onOpen: (a: OfficeAgent) => void }) {
  const [focus, setFocus] = useState<string | null>(null);
  const active = agents.some(a => a.id === focus) ? focus : agents.some(a => a.id === current) ? current : agents[0]?.id;
  const onKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']; if (!keys.includes(e.key)) return;
    e.preventDefault(); const i = agents.findIndex(a => a.id === active);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? agents.length - 1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? Math.min(agents.length - 1, i + 1) : Math.max(0, i - 1);
    const root = e.currentTarget; setFocus(agents[n].id); requestAnimationFrame(() => (root.querySelector(`[data-agent-id="${agents[n].id}"]`) as HTMLElement | null)?.focus());
  };
  return <div className="room-desks" role="group" aria-label={`Puestos de ${name} (flechas para moverte entre agentes)`} onKeyDown={onKey}>{agents.map(a => <Desk key={a.id} a={a} hue={hue} current={a.id === current} tabbable={a.id === active} onFocus={() => setFocus(a.id)} onOpen={() => onOpen(a)} />)}</div>;
}

function Desk({ a, hue, current, tabbable, onFocus, onOpen }: { a: OfficeAgent; hue: number; current: boolean; tabbable: boolean; onFocus: () => void; onOpen: () => void }) {
  const label = `${a.name}, ${a.role}${a.integration ? ` (${a.integration === 'integrated' ? 'agente externo integrado' : 'agente externo'})` : ''}. ${STATE_TEXT[a.state]}${a.state === 'unavailable' && a.harnessIssue ? `: ${a.harnessIssue}` : ''}${a.activity ? `: ${a.activity}` : ''}${a.attention.length ? `. ${a.attention.length} asunto(s) para ti` : ''}. Motor de IA: ${a.harnessLabel}.`;
  return <button type="button" data-agent-id={a.id} className="desk" tabIndex={tabbable ? 0 : -1} onFocus={onFocus} aria-current={current} aria-label={label} title={a.activity ?? a.attention[0]?.label ?? a.harnessIssue ?? STATE_TEXT[a.state]} data-state={a.state} onClick={onOpen}>
    <StateBadge state={a.state} />
    {a.attention.length > 0 && <span className="desk-needs" aria-hidden="true">{a.attention.length}</span>}
    <AgentFigure id={a.id} hue={hue} state={a.state} />
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'inherit', gap: 3, minWidth: 0 }}>
      <span className="desk-name">{a.name}</span>
      <span className="desk-role">{a.role}</span>
      <span className="desk-state">{STATE_TEXT[a.state]}</span>
      {(a.activity || (a.state === 'unavailable' && a.harnessIssue)) && <span className="desk-activity">{a.activity ?? a.harnessIssue}</span>}
      {a.integration && <span className="desk-ext">{a.integration === 'integrated' ? 'Externo · integrado' : 'Externo'}</span>}
    </span>
  </button>;
}

function OfficeList({ agents, onOpen, current }: { agents: OfficeAgent[]; onOpen: (id: string) => void; current: string | null }) {
  return <div style={{ overflowX: 'auto' }}><table className="office-list">
    <caption className="sr">Agentes de la empresa con su estado</caption>
    <thead><tr><th scope="col">Agente</th><th scope="col">Departamento</th><th scope="col">Estado</th><th scope="col">Ahora</th><th scope="col">Motor de IA</th><th scope="col">Para ti</th></tr></thead>
    <tbody>{agents.map(a => <tr key={a.id} aria-current={a.id === current}>
      <td><button type="button" className="lnk" onClick={() => onOpen(a.id)}>{a.name}</button><div className="small muted">{a.role}</div></td>
      <td data-label="Departamento">{a.department}</td>
      <td data-label="Estado"><span className={`state-pill state-${a.state}`}>{STATE_TEXT[a.state]}</span></td>
      <td data-label="Ahora" className="small">{a.activity ?? '—'}</td>
      <td data-label="Motor" className="small">{a.harnessLabel}</td>
      <td data-label="Para ti" className="small">{a.attention.length ? a.attention.map(x => x.label).join(' · ') : '—'}</td>
    </tr>)}</tbody>
  </table></div>;
}

function DepartmentDialog({ slug, onClose, onDone }: { slug: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(''); const [purpose, setPurpose] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const submit = async () => { setBusy(true); setError(null); try { await osApi.createDepartment(slug, name.trim(), purpose.trim()); onDone(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return <Modal title="Nuevo departamento" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancelar</button><button className="btn btn-primary" disabled={busy || name.trim().length < 2} onClick={() => void submit()}>{busy ? 'Creando…' : 'Crear departamento'}</button></>}>
    {error && <Notice kind="err">{error}</Notice>}
    <div><label className="label" htmlFor="dep-name">Nombre</label><input id="dep-name" className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Marketing, Administración, Investigación…" autoFocus /></div>
    <div><label className="label" htmlFor="dep-purpose">Propósito</label><textarea id="dep-purpose" className="input" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="Qué consigue este departamento para la empresa" /></div>
    <p className="small muted">Sin IA. Después añade agentes a la sala o mueve los existentes desde su panel.</p>
  </Modal>;
}

/** Petición a un departamento: la recibe su coordinador, consulta a los miembros que confirmes y entrega UN resultado. */
function DepartmentRequestDialog({ slug, department, agents, projects, defaultProject, onClose, onDone }: { slug: string; department: Department; agents: OfficeAgent[]; projects: { id: string; name: string }[]; defaultProject: string | null; onClose: () => void; onDone: (processId: string) => void }) {
  const [text, setText] = useState(() => { const k = `portal-ia.dep.prefill.${department.slug}`; const v = sessionStorage.getItem(k) ?? ''; sessionStorage.removeItem(k); return v; });
  const [projectId, setProjectId] = useState(defaultProject ?? projects[0]?.id ?? '');
  const [members, setMembers] = useState<string[]>(agents.slice(0, 6).map(a => a.id));
  const [budget, setBudget] = useState(0); const [auth, setAuth] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const coordinator = agents.find(a => a.id === department.coordinatorAgentId) ?? null;
  const billable = agents.some(a => (members.includes(a.id) || a.id === coordinator?.id) && a.harness === 'api');
  const ready = text.trim().length >= 8 && !!projectId;
  const doPreview = async () => { setError(null); try { setPreview(await osApi.departmentRequest(slug, department.id, { request: text.trim(), projectId, memberIds: members, preview: true })); } catch (e: any) { setError(e.message); } };
  const submit = async () => { setBusy(true); setError(null); try { const p = await osApi.departmentRequest(slug, department.id, { request: text.trim(), projectId, memberIds: members, budgetUsd: billable ? budget : 0 }); onDone(p.id); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return <Modal title={`Pedir algo a ${department.name}`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancelar</button><button className="btn btn-secondary" disabled={!ready} onClick={() => void doPreview()}>Ver quién y cuánto</button><button className="btn btn-primary" disabled={busy || !ready || !auth || (billable && budget < 0.1)} onClick={() => void submit()}>{busy ? 'Enviando…' : 'Enviar al departamento'}</button></>}>
    {error && <Notice kind="err">{error}</Notice>}
    <div><label className="label" htmlFor="dr-text">¿Qué necesitas?</label><textarea id="dr-text" className="input" rows={4} value={text} onChange={e => setText(e.target.value)} placeholder={`Ej.: «Investiga oportunidades para promocionar Orbiventt»`} autoFocus /></div>
    <div><label className="label" htmlFor="dr-project">Proyecto (donde se guarda el entregable)</label><select id="dr-project" className="input" value={projectId} onChange={e => setProjectId(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="label">Quién participa (máx. 6)</legend>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{agents.map(a => <label key={a.id} className="ck"><input className="cb" type="checkbox" checked={members.includes(a.id)} disabled={!members.includes(a.id) && members.length >= 6} onChange={e => setMembers(m => e.target.checked ? [...m, a.id] : m.filter(x => x !== a.id))} /> {a.name} <span className="small muted">· {a.role} · {a.harnessLabel}</span></label>)}</div>
    </fieldset>
    {preview && <Notice kind="info">Coordina <strong>{preview.coordinator.name}</strong>; {preview.estimate.steps.length} paso(s) (validación, consultas y entregable). {billable ? `≈ ${preview.estimate.estimatedUsd.toFixed(2)} USD por la API.` : 'Va por suscripción: sin USD de la API (cuenta en el tope de llamadas).'}</Notice>}
    {billable && <div><label className="label" htmlFor="dr-budget">Presupuesto de API (USD)</label><input id="dr-budget" className="input" type="number" min={0.1} step={0.1} value={budget} onChange={e => setBudget(Number(e.target.value))} /></div>}
    <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /> Autorizo esta petición: {billable ? 'llamadas facturables hasta el presupuesto indicado' : 'llamadas a la suscripción con su tope'}.</label>
  </Modal>;
}

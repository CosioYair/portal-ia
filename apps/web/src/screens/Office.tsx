import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { Shell } from '../components/Shell.tsx';
import { Chip, Icon, Notice, Spinner } from '../components/ui.tsx';
import { AgentFigure, STATE_TEXT, StateBadge } from '../components/AgentFigure.tsx';
import { AgentPanel } from '../components/AgentPanel.tsx';
import { useApp } from '../lib/store.ts';
import { useLive } from '../lib/live.ts';
import { usePersistentState } from '../lib/persist.ts';
import { osApi, type CodexDetection, type CodexSettings, type Department, type OfficeAgent, type OfficeView } from '../lib/osApi.ts';
import '../office.css';

/**
 * La oficina: la empresa como un lugar. Cada departamento es una sala; cada agente, un puesto con su personaje y su
 * estado REAL (calculado en el servidor a partir de procesos, conversaciones y decisiones pendientes). Clic en un puesto
 * → su panel (Chat, Solicitudes, Trabajo, Archivos, Memoria, Configuración). La vista «Lista» es la misma información,
 * densa y accesible. Nada aquí llama a la IA por sí solo.
 */
export function Office() {
  const { status, flash } = useApp();
  const ws = status.workspace!; const project = status.project;
  const { agentId, tab } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState<OfficeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = usePersistentState<'oficina' | 'lista'>('portal-ia.oficina.vista', () => (typeof window !== 'undefined' && window.innerWidth < 720 ? 'lista' : 'oficina'));
  const [dialog, setDialog] = useState<null | 'department' | 'harness' | { request: Department }>(null);
  // Con muchos agentes: búsqueda y salas que muestran primero a quien te necesita o trabaja (12 por sala, «Ver todos»).
  const [q, setQ] = useState(''); const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const ROOM_MAX = 12;
  const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const matches = (a: OfficeAgent) => !q.trim() || norm(`${a.name} ${a.role} ${a.department}`).includes(norm(q.trim()));
  const load = useCallback(() => osApi.office(ws.slug, project?.id ?? null).then(v => { setView(v); setError(null); }).catch(e => setError(e.message)), [ws.slug, project?.id]);
  useEffect(() => { void load(); }, [load]);
  useLive(c => c.ws === ws.slug && ['process', 'agent', 'department', 'agent_chat', 'batch', 'assignment'].includes(c.entity) && (c.kind !== 'progress' || c.entity === 'agent_chat' || c.entity === 'agent'), () => void load(), { minMs: 1200 });
  // Abrir un panel desde la oficina crea una entrada en el historial; cerrarlo vuelve atrás (Atrás no lo reabre) y devuelve
  // el foco al puesto del agente.
  const openedHere = useRef(false); const lastDesk = useRef<string | null>(null);
  const open = (id: string, t = 'chat') => { openedHere.current = true; lastDesk.current = id; navigate(`/oficina/agente/${id}/${t}`); };
  const close = useCallback(() => {
    const id = agentId ?? lastDesk.current;
    if (openedHere.current) { openedHere.current = false; navigate(-1); } else navigate('/oficina', { replace: true });
    requestAnimationFrame(() => (document.querySelector(`[data-agent-id="${id}"]`) as HTMLElement | null)?.focus());
  }, [agentId, navigate]);
  const byDep = useMemo(() => {
    const m = new Map<string, OfficeAgent[]>();
    const rank: Record<OfficeAgent['state'], number> = { attention: 0, working: 1, queued: 2, unavailable: 3, idle: 4, retired: 5 };
    for (const a of view?.agents ?? []) { if (!matches(a)) continue; const l = m.get(a.departmentSlug) ?? []; l.push(a); m.set(a.departmentSlug, l); }
    for (const l of m.values()) l.sort((x, y) => rank[x.state] - rank[y.state] || x.name.localeCompare(y.name, 'es'));
    return m;
  }, [view, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = view?.agents.find(a => a.id === agentId) ?? null;

  return (
    <Shell crumb="Oficina">
      <main className="page office">
        <div className="office-head">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="eyebrow">Tu empresa</div>
            <h1 className="h1" style={{ fontSize: 26 }}>{ws.name}</h1>
            {view && <div className="office-counts">
              <Chip>{view.counts.agents} agentes</Chip>
              <Chip dot={view.counts.working ? 'pulse' : ''}>{view.counts.working} trabajando</Chip>
              <Chip tone={view.counts.attention ? 'warn' : ''}>{view.counts.attention} te necesitan</Chip>
              <Link to="/autorizaciones" className="chip" style={{ textDecoration: 'none' }}>{Icon.authorization()} {view.counts.decisions} decisiones pendientes</Link>
            </div>}
          </div>
          <div className="office-actions">
            <div className="seg" role="group" aria-label="Vista">
              <button type="button" aria-pressed={mode === 'oficina'} onClick={() => setMode('oficina')}>{Icon.grid()} Oficina</button>
              <button type="button" aria-pressed={mode === 'lista'} onClick={() => setMode('lista')}>{Icon.users()} Lista</button>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDialog('harness')}>{Icon.plug()} Arneses</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog('department')}>Nuevo departamento</button>
            <Link className="btn btn-primary btn-sm" to="/oficina/nuevo-agente">{Icon.agent()} Nuevo agente</Link>
          </div>
        </div>

        {view && view.agents.length > 12 && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><label className="sr" htmlFor="office-q">Buscar agente</label><input id="office-q" className="input" style={{ maxWidth: 320, height: 34 }} value={q} onChange={e => setQ(e.target.value)} placeholder={`Buscar entre ${view.agents.length} agentes (nombre, papel o departamento)`} />{q && <span className="small muted">{[...byDep.values()].reduce((n, l) => n + l.length, 0)} coinciden</span>}</div>}
        <CommandBar agents={view?.agents ?? []} departments={view?.departments ?? []} onAgent={id => open(id, 'chat')} onDepartment={d => setDialog({ request: d })} />

        {error && <Notice kind="err">{error}</Notice>}
        {!view && !error && <Spinner />}
        {view && mode === 'oficina' && <div className="office-floor">
          {view.departments.filter(d => !q.trim() || (byDep.get(d.slug)?.length ?? 0) > 0).map(d => {
            const all = byDep.get(d.slug) ?? []; const showAll = expanded.has(d.slug) || !!q.trim();
            const members = showAll ? all : all.slice(0, ROOM_MAX);
            return <section key={d.slug} className="room" aria-labelledby={`room-${d.slug}`}>
              <div className="room-wall">
                <span className="room-sign" id={`room-${d.slug}`}><span className="swatch" style={{ background: `hsl(${d.hue} 42% 46%)` }} aria-hidden="true" />{d.name}</span>
                <span className="room-meta">{(n => `${n} ${n === 1 ? 'agente' : 'agentes'}`)(all.filter(m => m.state !== 'retired').length)}{all.some(m => m.state === 'attention') && <Chip xs tone="warn">te necesita</Chip>}</span>
              </div>
              {d.purpose && <div className="room-purpose">{d.purpose}</div>}
              {members.length ? <div className="room-desks">
                {members.map(a => <Desk key={a.id} a={a} hue={d.hue} current={a.id === agentId} onOpen={() => open(a.id, a.attention.length ? 'solicitudes' : 'chat')} />)}
              </div> : <div className="room-empty">Sala vacía. Crea un agente para este departamento o mueve uno desde su panel.</div>}
              {all.length > ROOM_MAX && !q.trim() && <button type="button" className="btn btn-ghost btn-sm" style={{ margin: '0 12px 8px' }} aria-expanded={showAll} onClick={() => setExpanded(s0 => { const n = new Set(s0); if (n.has(d.slug)) n.delete(d.slug); else n.add(d.slug); return n; })}>{showAll ? 'Mostrar menos' : `Ver todos (${all.length})`}</button>}
              <div className="room-actions">
                {members.some(m => m.state !== 'retired') && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDialog({ request: d })}>Pedir algo a {d.name}</button>}
                <Link className="btn btn-ghost btn-sm" to={`/oficina/nuevo-agente?departamento=${encodeURIComponent(d.name)}`}>Añadir agente</Link>
              </div>
              <span className="room-plant" aria-hidden="true" />
            </section>;
          })}
        </div>}
        {view && mode === 'lista' && <OfficeList agents={view.agents.filter(matches)} onOpen={id => open(id)} current={agentId ?? null} />}
        {view && !view.agents.length && <Notice kind="info">Aún no hay agentes. Empieza con «Nuevo agente».</Notice>}
      {view && view.agents.length > 0 && <nav className="agent-strip" aria-label="Agentes">
        <span className="agent-strip-label">{view.agents.length} agentes</span>
        {view.agents.filter(a => a.state !== 'retired').map(a => <button key={a.id} type="button" className="strip-agent" aria-current={a.id === agentId} onClick={() => open(a.id)} title={`${a.name} · ${STATE_TEXT[a.state]}`}>
          <AgentFigure id={a.id} hue={view.departments.find(d => d.slug === a.departmentSlug)?.hue ?? 200} state={a.state} size={24} />
          <span>{a.name}</span><span className={`strip-dot strip-dot-${a.state}`} aria-hidden="true" /><span className="sr">{STATE_TEXT[a.state]}</span>
        </button>)}
      </nav>}
      </main>
      {agentId && <AgentPanel slug={ws.slug} agentId={agentId} tab={tab ?? 'chat'} office={current} departments={view?.departments ?? []} projects={view?.projects ?? []} onTab={t => navigate(`/oficina/agente/${agentId}/${t}`, { replace: true })} onClose={close} onChanged={() => void load()} />}
      {dialog === 'department' && <DepartmentDialog slug={ws.slug} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); flash('Departamento creado'); }} />}
      {dialog === 'harness' && <HarnessDialog onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && <DepartmentRequestDialog slug={ws.slug} department={dialog.request} agents={(view?.agents ?? []).filter(a => a.departmentSlug === dialog.request.slug && a.state !== 'retired')} projects={view?.projects ?? []} defaultProject={project?.id ?? null} onClose={() => setDialog(null)} onDone={id => { setDialog(null); flash('Petición enviada al departamento'); navigate(`/procesos/${id}`); }} />}
    </Shell>
  );
}

function Desk({ a, hue, current, onOpen }: { a: OfficeAgent; hue: number; current: boolean; onOpen: () => void }) {
  const label = `${a.name}, ${a.role}${a.integration ? ` (${a.integration === 'integrated' ? 'agente externo integrado' : 'agente externo'})` : ''}. ${STATE_TEXT[a.state]}${a.state === 'unavailable' && a.harnessIssue ? `: ${a.harnessIssue}` : ''}${a.activity ? `: ${a.activity}` : ''}${a.attention.length ? `. ${a.attention.length} asunto(s) para ti` : ''}. Arnés: ${a.harnessLabel}.`;
  return <button type="button" data-agent-id={a.id} className={`desk${a.state === 'retired' ? ' desk-retired' : ''}`} aria-current={current} aria-label={label} title={a.activity ?? a.attention[0]?.label ?? a.harnessIssue ?? STATE_TEXT[a.state]} data-state={a.state} onClick={onOpen}>
    <StateBadge state={a.state} />
    <AgentFigure id={a.id} hue={hue} state={a.state} />
    <span className="desk-name">{a.name}</span>
    <span className="desk-role">{a.role}</span>
    {a.integration && <span className="desk-ext small">{a.integration === 'integrated' ? 'Integrado' : 'Externo'}</span>}
    <span className="desk-state">{STATE_TEXT[a.state]}</span>
  </button>;
}

function OfficeList({ agents, onOpen, current }: { agents: OfficeAgent[]; onOpen: (id: string) => void; current: string | null }) {
  return <div style={{ overflowX: 'auto' }}><table className="office-list">
    <caption className="sr">Agentes de la empresa con su estado</caption>
    <thead><tr><th scope="col">Agente</th><th scope="col">Departamento</th><th scope="col">Estado</th><th scope="col">Ahora</th><th scope="col">Arnés</th><th scope="col">Para ti</th></tr></thead>
    <tbody>{agents.map(a => <tr key={a.id} aria-current={a.id === current}>
      <td><button type="button" className="lnk" onClick={() => onOpen(a.id)}>{a.name}</button><div className="small muted">{a.role}</div></td>
      <td>{a.department}</td>
      <td><span className="desk-state"><StateBadgeInline state={a.state} />{STATE_TEXT[a.state]}</span></td>
      <td className="small">{a.activity ?? '—'}</td>
      <td className="small">{a.harnessLabel}</td>
      <td className="small">{a.attention.length ? a.attention.map(x => x.label).join(' · ') : '—'}</td>
    </tr>)}</tbody>
  </table></div>;
}
const StateBadgeInline = ({ state }: { state: OfficeAgent['state'] }) => <span style={{ position: 'relative', display: 'inline-block', width: 20, height: 20 }}><StateBadge state={state} /></span>;

/**
 * Barra de órdenes: «@Nombre …» abre la conversación con ese agente; «Marketing: …» (o «Equipo de Marketing, …») prepara
 * una petición a ese departamento; cualquier otra cosa va al Asistente, que decide si basta una respuesta, un agente, un
 * encargo o una historia. La ruta se muestra antes de enviar; nada se ejecuta sin tu confirmación.
 */
function CommandBar({ agents, departments, onAgent, onDepartment }: { agents: OfficeAgent[]; departments: Department[]; onAgent: (id: string) => void; onDepartment: (d: Department) => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const route = useMemo(() => {
    const t = text.trim(); if (!t) return null;
    if (t.startsWith('@')) {
      // El nombre (o la primera palabra del nombre) más largo que coincide con lo escrito tras «@»: «@Arquitecto revisa…».
      const after = norm(t.slice(1));
      const cands = agents.flatMap(x => [norm(x.name), norm(x.name).split(/[\s,]+/)[0]].map(k => ({ x, k }))).filter(c => c.k.length >= 2 && after.startsWith(c.k) && /^($|[\s,:])/.test(after.slice(c.k.length)));
      const best = cands.sort((p, q) => q.k.length - p.k.length)[0];
      if (best) return { kind: 'agent' as const, label: `Conversar con ${best.x.name}`, id: best.x.id, rest: t.slice(1 + best.k.length).replace(/^[\s,:]+/, '') };
    }
    const dm = norm(t).match(/^(?:equipo de |departamento de |el equipo de |el departamento de )?([^,:]{2,40})[,:]/);
    if (dm) { const d = departments.find(x => norm(x.name) === dm[1].trim()); if (d) return { kind: 'department' as const, label: `Petición al departamento ${d.name}`, dep: d, rest: t.replace(/^[^,:]+[,:]\s*/, '') }; }
    return { kind: 'assistant' as const, label: 'El Asistente lo estudia y te propone cómo hacerlo' };
  }, [text, agents, departments]);
  const go = () => {
    if (!route) return;
    if (route.kind === 'agent') { sessionStorage.setItem(`portal-ia.chat.prefill.${route.id}`, route.rest); onAgent(route.id); }
    else if (route.kind === 'department') { sessionStorage.setItem(`portal-ia.dep.prefill.${route.dep.slug}`, route.rest); onDepartment(route.dep); }
    else navigate('/asistente', { state: { draft: text.trim() } });
    setText('');
  };
  return <div>
    <form className="cmd-bar" onSubmit={e => { e.preventDefault(); go(); }} role="search" aria-label="Pide algo a tu empresa">
      <label className="sr" htmlFor="cmd">Pide algo a tu empresa</label>
      <input id="cmd" className="input" value={text} onChange={e => setText(e.target.value)} placeholder="Pide algo a tu empresa… («@Arquitecto revisa…», «Marketing: investiga…» o cualquier idea)" autoComplete="off" />
      <button className="btn btn-primary" type="submit" disabled={!route}>Enviar</button>
    </form>
    <div className="cmd-route" aria-live="polite">{route ? `→ ${route.label}` : ''}</div>
  </div>;
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

function HarnessDialog({ onClose }: { onClose: () => void }) {
  const { flash } = useApp();
  const [data, setData] = useState<{ harnesses: any[]; codex: { settings: CodexSettings; detection: CodexDetection | null } } | null>(null);
  const [busy, setBusy] = useState(false); const [auth, setAuth] = useState(false); const [error, setError] = useState<string | null>(null);
  const load = () => osApi.harnesses().then(setData).catch(e => setError(e.message));
  useEffect(() => { void load(); }, []);
  const detect = async () => { setBusy(true); setError(null); try { await osApi.detectCodex(); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const toggle = async (enabled: boolean) => { setBusy(true); setError(null); try { await osApi.setCodex(enabled); await load(); flash(enabled ? 'Codex habilitado' : 'Codex deshabilitado'); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const det = data?.codex.detection;
  return <Modal title="Arneses de ejecución" wide onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Cerrar</button>}>
    <p className="small muted">Un arnés es <strong>cómo</strong> trabaja un agente; no es el agente. Su identidad, instrucciones, habilidades y memoria son tuyas y se conservan al cambiar de arnés.</p>
    {error && <Notice kind="err">{error}</Notice>}
    {!data ? <Spinner /> : <div className="harness-cards">{data.harnesses.map(h => <div key={h.id} className="harness-card" style={{ cursor: 'default' }}>
      <strong>{h.name}</strong><span className="small muted">{h.vendor} · {h.billing === 'subscription' ? 'tu suscripción' : h.billing === 'api' ? 'API facturable' : 'no verificable'}</span>
      <span className="small">{h.summary}</span>
      <Chip xs tone={h.availability.available ? 'ok' : 'warn'}>{h.availability.available ? 'Disponible' : 'No disponible'}</Chip>
      {h.availability.reason && <span className="small muted">{h.availability.reason}</span>}
      {h.availability.detail && <span className="small mono muted">{h.availability.detail}</span>}
    </div>)}</div>}
    <section className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }} aria-labelledby="codex-h">
      <div className="h3" id="codex-h">Codex</div>
      {det ? <>
        <div className="small">{det.installed ? `Codex ${det.version ?? ''} · ${det.auth === 'chatgpt' ? 'sesión de ChatGPT' : det.auth === 'api_key' ? 'clave de API (facturable)' : 'sin sesión'}` : 'No instalado'} · comprobado {new Date(det.checkedAt).toLocaleString('es-MX')}</div>
        {det.exposedTools && <div className="small">Herramientas que expondría (comprobado sin llamar al modelo): {det.exposedTools.length ? det.exposedTools.join(', ') : 'ninguna'}</div>}
        {det.problems.map((p, i) => <Notice key={i} kind="warn">{p}</Notice>)}
        {det.restricted && det.billing === 'subscription' && <Notice kind="ok">Modo restringido verificado: sin herramientas, sin claves, carpeta vacía.</Notice>}
      </> : <p className="small muted">Aún no se ha comprobado. La comprobación no llama al modelo.</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void detect()}>{busy ? 'Comprobando…' : 'Comprobar Codex'}</button>
        {data?.codex.settings.enabled ? <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void toggle(false)}>Deshabilitar Codex</button>
          : <><label className="ck small"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} disabled={!det?.restricted} /> Autorizo que los agentes que yo elija trabajen con Codex y mi sesión de ChatGPT</label>
            <button className="btn btn-primary btn-sm" disabled={busy || !auth || !det?.restricted || det.billing !== 'subscription'} onClick={() => void toggle(true)}>Habilitar Codex</button></>}
      </div>
    </section>
  </Modal>;
}

export function Modal({ title, children, footer, onClose, wide }: { title: string; children: React.ReactNode; footer: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const box = ref.current;
    if (box && !box.contains(document.activeElement)) (box.querySelector<HTMLElement>('input, textarea, select, button:not(.xbtn)') ?? box).focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !box) return;
      const f = [...box.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!f.length) return; const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', k, true);
    return () => { window.removeEventListener('keydown', k, true); opener.current?.focus?.(); };
  }, []);
  return createPortal(<div className="backdrop os-portal" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1} style={{ width: wide ? 'min(860px, 100%)' : 'min(560px, 100%)' }}>
      <div className="modal-h"><div className="h3">{title}</div><button className="xbtn" onClick={onClose} aria-label="Cerrar">{Icon.x(16)}</button></div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>{children}</div>
      <div className="modal-f"><span /><div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{footer}</div></div>
    </div>
  </div>, document.body);
}

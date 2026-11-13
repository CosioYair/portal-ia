import { PackageReadiness } from './PortablePackage.tsx';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { ExecutionBackend, Lesson, PortableSkill, ProviderId } from '@portal-ia/domain';
import { Chip, Icon, Notice, Spinner } from './ui.tsx';
import { AgentFigure, STATE_TEXT } from './AgentFigure.tsx';
import { Markdown } from './Markdown.tsx';
import { useApp } from '../lib/store.ts';
import { useLive } from '../lib/live.ts';
import { api, type AgentCapabilitiesView, type AgentLearningEntry, type AgentLearningView } from '../lib/api.ts';
import { TOOL_LABELS, fmtUsd } from '../lib/labels.ts';
import { HARNESSES, agentDisplayName, workplaceLabel } from '@portal-ia/domain';
import { ContextScopeChips } from '../screens/AgentWizard.tsx';
import { AgentAdvancedSettings } from '../screens/AgentDetail.tsx';
import { FolderPicker } from './FolderPicker.tsx';
import { DocumentsTab, OriginTab } from './ExternalAgent.tsx';
import { AgentZipImport } from './AgentZipImport.tsx';
import { ChatTab, FeedbackForm } from './AgentChat.tsx';
import { PortalSealPanel } from './AgentConfigPanel.tsx';
import { INTEGRATION_LABEL } from '@portal-ia/domain';
import { osApi, officeDisplayName, type AgentPanel as Panel, type Department, type FolderStatus, type HarnessOptions, type ImprovementHistoryItem, type NameEstimate, type NameProposal, type OfficeAgent, type WorkItem } from '../lib/osApi.ts';

/**
 * Panel de un agente: todo lo suyo en un sitio, sin navegar por seis pantallas.
 *  Chat · Trabajo · Para revisar (Solicitudes) · Memoria · Ajustes (Configuración, Archivos).
 * Cada acción que gasta (un mensaje, un encargo) lo dice antes; nada se autoriza solo.
 */
const BASE_TABS = [['chat', 'Chat'], ['solicitudes', 'Solicitudes'], ['trabajo', 'Trabajo'], ['archivos', 'Archivos'], ['memoria', 'Memoria'], ['configuracion', 'Configuración']] as const;
/**
 * Agente externo (su carpeta original es la fuente): Documentos y Origen; «Archivos» es su carpeta original (en Origen).
 * HU-181: Mejoras se retira; sus automejoras se ven (y se deshacen) en Memoria › Historial de automejoras.
 */
const EXTERNAL_TABS = [['chat', 'Chat'], ['documentos', 'Documentos'], ['solicitudes', 'Solicitudes'], ['trabajo', 'Trabajo'], ['origen', 'Origen'], ['memoria', 'Memoria'], ['configuracion', 'Configuración']] as const;
type Tab = typeof BASE_TABS[number][0] | typeof EXTERNAL_TABS[number][0];
/**
 * Portal IA 2.0: las pestañas se agrupan en cinco (Chat · Trabajo · Para revisar · Memoria · Ajustes). Cada nombre antiguo
 * sigue siendo una ruta válida (/oficina/agente/:id/documentos, …/origen): abre su grupo con esa vista elegida.
 * …/mejoras (HU-181) ya no es una pestaña: es un alias que abre Memoria con el historial de automejoras a la vista.
 */
type Group = 'chat' | 'trabajo' | 'revisar' | 'memoria' | 'ajustes';
const GROUP_OF: Record<Tab, Group> = { chat: 'chat', trabajo: 'trabajo', documentos: 'trabajo', solicitudes: 'revisar', memoria: 'memoria', configuracion: 'ajustes', archivos: 'ajustes', origen: 'ajustes' };
const GROUP_LABEL: Record<Group, string> = { chat: 'Chat', trabajo: 'Trabajo', revisar: 'Para revisar', memoria: 'Memoria', ajustes: 'Ajustes' };
const GROUP_ORDER: Group[] = ['chat', 'trabajo', 'revisar', 'memoria', 'ajustes'];
/** Vista con la que se abre cada grupo (va primera en su selector). */
const GROUP_FIRST: Record<Group, Tab> = { chat: 'chat', trabajo: 'trabajo', revisar: 'solicitudes', memoria: 'memoria', ajustes: 'configuracion' };

export function AgentPanel({ slug, agentId, tab, office, departments, projects, onTab, onClose, onChanged }: { slug: string; agentId: string; tab: string; office: OfficeAgent | null; departments: Department[]; projects: { id: string; name: string }[]; onTab: (t: Tab) => void; onClose: () => void; onChanged: () => void }) {
  const [p, setP] = useState<Panel | null>(null); const [error, setError] = useState<string | null>(null);
  const cur = useRef(agentId); cur.current = agentId;
  const load = useCallback(() => osApi.panel(slug, agentId).then(x => { if (x.agent.id !== cur.current) return; setP(x); setError(null); }).catch(e => { if (agentId === cur.current) setError(e.message); }), [slug, agentId]);
  useEffect(() => { setP(null); void load(); }, [load]);
  useLive(c => c.ws === slug && ((c.entity === 'agent' && c.id === agentId) || (c.entity === 'process' && c.kind !== 'progress') || (c.entity === 'agent_chat' && c.id === agentId)), () => void load(), { minMs: 1000 });
  const external = !!(p?.office?.integration ?? office?.integration);
  // Sin «documentos/» en su carpeta no hay banco de documentos.
  const TABS: readonly (readonly [Tab, string])[] = external ? EXTERNAL_TABS.filter(t => t[0] !== 'documentos' || p?.external?.hasOutputs !== false) : BASE_TABS;
  // Alias de la antigua pestaña Mejoras: abre Memoria (el historial de automejoras).
  const now = (TABS.some(t => t[0] === tab) ? tab : tab === 'mejoras' ? 'memoria' : external && tab === 'archivos' ? 'origen' : 'chat') as Tab;
  const GROUPS = GROUP_ORDER.filter(g => TABS.some(t => GROUP_OF[t[0]] === g));
  const membersOf = (g: Group) => TABS.filter(t => GROUP_OF[t[0]] === g).sort((a, b) => Number(b[0] === GROUP_FIRST[g]) - Number(a[0] === GROUP_FIRST[g]));
  const current: Group = GROUP_OF[now];
  // Por debajo de 1280 px el panel tapa casi toda la pantalla: es modal (fondo, foco atrapado, Esc cierra). En pantallas
  // anchas va al lado: el contenido se aparta (body.has-agent-panel), así nada enfocable queda debajo del panel.
  const [modal, setModal] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1280);
  useEffect(() => { const r = () => setModal(window.innerWidth < 1280); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r); }, []);
  useEffect(() => { if (modal) return; document.body.classList.add('has-agent-panel'); return () => document.body.classList.remove('has-agent-panel'); }, [modal]);
  const hue = departments.find(d => d.slug === (office?.departmentSlug ?? p?.office?.departmentSlug))?.hue ?? 200;
  const ref = useRef<HTMLDivElement>(null);
  // El foco va al panel al abrir OTRO agente (no en cada render: si no, se lo quitaría a la pestaña que eliges con el teclado).
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => { ref.current?.focus(); }, [agentId]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key !== 'Escape' || e.defaultPrevented) return; const el = document.activeElement as HTMLElement | null; if (el && el !== document.body && !ref.current?.contains(el)) return; /* Esc de otro diálogo (búsqueda, Asistente) no cierra este */ if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && (el as HTMLInputElement).value) return; closeRef.current(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  const onTabKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = GROUPS.indexOf(current); const n = e.key === 'Home' ? 0 : e.key === 'End' ? GROUPS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : GROUPS.length - 1)) % GROUPS.length;
    onTab(membersOf(GROUPS[n])[0][0]); requestAnimationFrame(() => (document.getElementById(`tab-${GROUPS[n]}`) as HTMLButtonElement | null)?.focus());
  };
  const onTrap = (e: RKeyboardEvent<HTMLElement>) => {
    if (!modal || e.key !== 'Tab' || !ref.current) return;
    const f = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')].filter(x => x.offsetParent !== null);
    if (!f.length) return; const a = f[0]; const z = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === a || document.activeElement === ref.current)) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  };
  const refresh = () => { void load(); onChanged(); };
  const requests = p?.office?.attention.length ?? 0;
  // En el nivel raíz del documento: por encima de los botones flotantes (Asistente, Autorizaciones) y de cualquier contexto de apilamiento.
  return createPortal(<>{modal && <div className="agent-panel-scrim" onClick={onClose} aria-hidden="true" />}<aside className="agent-panel" role="dialog" aria-modal={modal} aria-labelledby="agent-panel-title" tabIndex={-1} ref={ref} onKeyDown={onTrap}>
    <div className="agent-panel-head">
      <AgentFigure id={agentId} hue={hue} state={p?.office?.state ?? office?.state ?? 'idle'} size={56} />
      <div className="who">
        <h2 id="agent-panel-title">{p?.displayName ?? (office ? officeDisplayName(office) : null) ?? (p ? agentDisplayName(p.agent) : null) ?? 'Agente'}</h2>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Chip xs>{p?.agent.template.role ?? office?.role}</Chip>
          <Chip xs tone="accent">{p?.department?.name ?? office?.department}</Chip>
          <Chip xs>{p?.office?.harnessLabel ?? office?.harnessLabel}</Chip>
          {p?.office && <span className={`state-pill state-${p.office.state}`}>{STATE_TEXT[p.office.state]}</span>}
          {p?.office?.integration && <Chip xs tone={p.office.integration === 'integrated' ? 'ok' : 'soon'}>{INTEGRATION_LABEL[p.office.integration]}</Chip>}
        </div>
        {/* EN-014 · Ámbito real (contextScope), no Template.scope. Solo presentación: no toca permisos ni gasta. */}
        {(p || office) && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <ContextScopeChips scope={p?.agent.contextScope ?? office?.contextScope} />
          {p && <span className="small muted">Trabaja en: {workplaceLabel(p.agent.scope).toLowerCase()}</span>}
        </div>}
        {p?.office?.activity && <span className="small muted">{p.office.activity}</span>}
      </div>
      <button type="button" className="xbtn" onClick={onClose} aria-label="Cerrar el panel">{Icon.x(16)}</button>
    </div>
    <div className="agent-panel-tabs" role="tablist" aria-label="Secciones del agente" onKeyDown={onTabKey}>
      {GROUPS.map(id => <button key={id} id={`tab-${id}`} role="tab" type="button" aria-selected={current === id} aria-controls={`tp-${id}`} tabIndex={current === id ? 0 : -1} onClick={() => { if (current !== id) onTab(membersOf(id)[0][0]); }}>
        {GROUP_LABEL[id]}{id === 'revisar' && requests > 0 && <><span className="tab-count" aria-hidden="true">{requests}</span><span className="sr-only"> ({requests} pendiente{requests === 1 ? '' : 's'})</span></>}{id === 'memoria' && (p?.memory.proposed.length ?? 0) > 0 && <span className="tab-count">{p!.memory.proposed.length}</span>}
      </button>)}
    </div>
    {membersOf(current).length > 1 && <div className="agent-panel-sub"><div className="seg" role="group" aria-label={`Vistas de ${GROUP_LABEL[current]}`}>
      {membersOf(current).map(([id, label]) => <button key={id} type="button" aria-pressed={now === id} onClick={() => onTab(id)}>{label}</button>)}
    </div></div>}
    {error && <div style={{ padding: 12 }}><Notice kind="err">{error}</Notice></div>}
    {!p && !error && <div style={{ padding: 24 }}><Spinner /></div>}
    {p && <div role="tabpanel" tabIndex={0} id={`tp-${current}`} aria-labelledby={`tab-${current}`} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {now === 'chat' && p.agent.key === 'ws-asistente' && <div style={{ padding: '10px 16px 0' }}><Notice kind="info">Este es el Asistente de Empresa. Sus conversaciones con propuestas y reparto de trabajo están en <Link className="lnk" to="/asistente">Asistente</Link> y en «Pedir»; aquí hablas con él como con cualquier agente.</Notice></div>}
      {now === 'chat' && <ChatTab slug={slug} p={p} projects={projects} onChanged={refresh} />}
      {now !== 'chat' && <div className="agent-panel-body">
        {now === 'solicitudes' && <RequestsTab p={p} onTab={onTab} />}
        {now === 'trabajo' && <WorkTab slug={slug} p={p} projects={projects} onChanged={refresh} />}
        {now === 'archivos' && <FilesTab slug={slug} p={p} onChanged={refresh} />}
        {now === 'documentos' && <DocumentsTab slug={slug} p={p} onChanged={refresh} onTab={onTab} />}
        {now === 'origen' && <OriginTab slug={slug} p={p} onChanged={refresh} />}
        {now === 'memoria' && <MemoryTab slug={slug} p={p} onChanged={refresh} focusHistory={tab === 'mejoras'} />}
        {now === 'configuracion' && <ConfigTab slug={slug} p={p} departments={departments} onChanged={refresh} />}
      </div>}
    </div>}
  </aside></>, document.body);
}

// ---------------------------------------------------------------- Solicitudes

function RequestsTab({ p, onTab }: { p: Panel; onTab: (t: Tab) => void }) {
  const items = p.office?.attention ?? [];
  return <>
    <p className="small muted">Lo que este agente necesita de ti: autorizaciones, decisiones, aprendizaje por verificar y cambios en sus archivos.</p>
    {!items.length && !p.memory.proposed.length && <Notice kind="ok">Nada pendiente con {p.agent.config.name}.</Notice>}
    {items.map((a, i) => <div key={i} className="work-card">
      <strong>{a.label}</strong>
      <div style={{ display: 'flex', gap: 8 }}>
        {a.processId && <Link className="btn btn-secondary btn-sm" to={`/procesos/${a.processId}`}>Abrir y decidir</Link>}
        {a.kind === 'memory' && <button className="btn btn-secondary btn-sm" onClick={() => onTab('memoria')}>Revisar en Memoria</button>}
        {a.kind === 'folder' && <button className="btn btn-secondary btn-sm" onClick={() => onTab('archivos')}>Revisar en Archivos</button>}

        {a.kind === 'source' && <button className="btn btn-secondary btn-sm" onClick={() => onTab('origen')}>Revisar en Origen</button>}
        {a.kind === 'action' && <button className="btn btn-secondary btn-sm" onClick={() => onTab('chat')}>Revisar en el Chat</button>}
      </div>
    </div>)}
    <Link className="btn btn-ghost btn-sm" to="/autorizaciones" style={{ alignSelf: 'flex-start' }}>{Icon.authorization()} Todas las decisiones pendientes</Link>
  </>;
}

// ---------------------------------------------------------------- Trabajo

const COLS: [WorkItem['column'], string][] = [['requested', 'Por autorizar'], ['queued', 'En cola'], ['doing', 'Haciendo'], ['done', 'Hecho'], ['stopped', 'Detenido']];
function WorkTab({ slug, p, projects, onChanged }: { slug: string; p: Panel; projects: { id: string; name: string }[]; onChanged: () => void }) {
  const { flash, status } = useApp();
  const [req, setReq] = useState(''); const [projectId, setProjectId] = useState(p.agent.scope === 'project' ? p.agent.projectId ?? '' : status.project?.id ?? projects[0]?.id ?? '');
  const [budget, setBudget] = useState(1); const [auth, setAuth] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); const [fb, setFb] = useState<string | null>(null);
  const billable = p.agent.config.backend === undefined || p.agent.config.backend === 'api';
  const submit = async () => {
    setBusy(true); setError(null);
    try { await osApi.task(slug, p.agent.id, { request: req.trim(), projectId: projectId || null, budgetUsd: billable ? budget : 0 }); setReq(''); setAuth(false); flash('Encargo autorizado: ya está en marcha'); onChanged(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <>
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }} aria-labelledby="new-task">
      <div className="h3" id="new-task">Nuevo encargo</div>
      {error && <Notice kind="err">{error}</Notice>}
      <textarea className="input" rows={3} value={req} onChange={e => setReq(e.target.value)} placeholder={`¿Qué debe entregarte ${p.agent.config.name}?`} aria-label="Encargo" disabled={p.retired} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="small" htmlFor="task-project">Proyecto</label>
        <select id="task-project" className="input" style={{ maxWidth: 240, height: 32 }} value={projectId} onChange={e => setProjectId(e.target.value)}>{projects.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        {billable && <><label className="small" htmlFor="task-budget">Presupuesto API (USD)</label><input id="task-budget" className="input" style={{ width: 90, height: 32 }} type="number" min={0.1} step={0.1} value={budget} onChange={e => setBudget(Number(e.target.value))} /></>}
      </div>
      <label className="ck small"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /> Autorizo este encargo: {billable ? `llamadas facturables hasta ${fmtUsd(budget)}` : `una llamada con ${p.office?.harnessLabel ?? 'su arnés'} (tope de 3 llamadas)`}. El resultado se guarda en Conocimiento.</label>
      <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-end' }} disabled={busy || !auth || req.trim().length < 8 || !projectId || p.retired} onClick={() => void submit()}>{busy ? 'Enviando…' : 'Encargar'}</button>
    </section>
    {open && (() => { const w = p.work.find(x => x.id === open); return w?.deliverable ? <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }} aria-label={`Entregable: ${w.title}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}><strong className="small">{w.title}</strong><button type="button" className="xbtn" onClick={() => setOpen(null)} aria-label="Cerrar el entregable">{Icon.x(14)}</button></div>
      <div className="file-view" style={{ fontFamily: 'var(--font-sans)', maxHeight: 420 }}><Markdown text={w.deliverable} /></div>
      <Link className="lnk small" to={`/procesos/${w.id}`}>{w.deliverable.length >= 3990 ? 'Está recortado: ábrelo completo en su proceso' : 'Abrir su proceso'}</Link>
    </section> : null; })()}
    <div className="board">{COLS.map(([col, label]) => { const items = p.work.filter(w => w.column === col); return <div key={col} className="board-col">
      <h4>{label}<span>{items.length}</span></h4>
      {items.slice(0, 12).map(w => <div key={w.id} className="work-card">
        <Link to={`/procesos/${w.id}`} className="lnk" style={{ fontWeight: 600 }}>{w.title}</Link>
        <span className="small muted">{new Date(w.createdAt).toLocaleString('es-MX')}{w.lead ? ' · responsable' : ' · participa'}</span>
        {w.deliverable && <button type="button" className="lnk small" onClick={() => setOpen(open === w.id ? null : w.id)} aria-expanded={open === w.id}>{open === w.id ? 'Ocultar entregable' : 'Ver entregable'}</button>}

        {w.column === 'done' && w.lead && <button type="button" className="lnk small" onClick={() => setFb(fb === w.id ? null : w.id)}>Valorar y enseñar</button>}
        {fb === w.id && <FeedbackForm slug={slug} agentId={p.agent.id} processId={w.id} onDone={() => { setFb(null); flash('Aprendizaje propuesto: verifícalo en Memoria'); onChanged(); }} />}
      </div>)}
    </div>; })}</div>
  </>;
}

// ---------------------------------------------------------------- Archivos

/** EN-013 · Marca de las instrucciones por defecto (la misma que DEFAULT_INSTRUCTIONS_MARK en el servidor). */
const DEFAULT_INSTRUCTIONS_RE = /portal-ia: instrucciones por defecto/;

/**
 * EN-013 · Contenido de AGENTS.md en solo lectura, sin la línea de la marca. Si son las instrucciones por defecto, se dice
 * que las genera el Portal y que se actualizan solas. No llama a la IA ni tiene costo.
 */
function InstructionsView({ text }: { text: string }) {
  const isDefault = DEFAULT_INSTRUCTIONS_RE.test(text);
  const shown = text.split(/\r?\n/).filter(l => !DEFAULT_INSTRUCTIONS_RE.test(l)).join('\n').trim();
  if (!shown) return <span className="small muted">Aún no tiene instrucciones en su carpeta.</span>;
  return <>
    {isDefault && <Notice kind="info">Generadas por el Portal a partir del papel, las responsabilidades y los permisos del agente. Se actualizan solas hasta que las edites.</Notice>}
    <pre className="file-view" aria-label="Contenido de AGENTS.md" tabIndex={0} style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}>{shown}</pre>
  </>;
}

function FilesTab(props: { slug: string; p: Panel; onChanged: () => void }) {
  return <><CapabilitiesBlock slug={props.slug} agentId={props.p.agent.id} /><FilesTabBody {...props} /></>;
}

/** EN-011 · «Qué sabe hacer»: herramientas concedidas, dónde funcionan y si el sandbox está disponible ahora. */
function CapabilitiesBlock({ slug, agentId }: { slug: string; agentId: string }) {
  const [st, setSt] = useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; v: AgentCapabilitiesView }>({ kind: 'loading' });
  useEffect(() => {
    let alive = true; setSt({ kind: 'loading' });
    api.agentCapabilities(slug, agentId).then(v => { if (alive) setSt({ kind: 'ok', v }); }).catch(e => { if (alive) setSt({ kind: 'error', message: e?.message ?? String(e) }); });
    return () => { alive = false; };
  }, [slug, agentId]);
  return <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }} aria-labelledby="caps-h">
    <div className="h3" id="caps-h">Qué sabe hacer</div>
    {st.kind === 'loading' && <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Spinner /> Cargando sus habilidades…</div>}
    {st.kind === 'error' && <Notice kind="err">No se pudo cargar lo que sabe hacer: {st.message}</Notice>}
    {st.kind === 'ok' && <>
      {st.v.tools.length === 0
        ? <p className="small muted">No tiene herramientas concedidas: solo conversa y propone. Puedes concederlas en Configuración.</p>
        : <ul className="cap-list">{st.v.tools.map(t => <li key={t.tool}>{Icon.stateDone()} <span><strong>{t.label}</strong>{t.description ? ` — ${t.description}` : ''}<br /><span className="muted">Dónde funciona: {t.whereText}{t.skill ? <> · habilidad <span className="mono">skills/{t.skill}</span></> : null}</span></span></li>)}</ul>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {!st.v.sandbox || !st.v.sandbox.checked
          ? <Chip xs>Sandbox: no comprobado</Chip>
          : <Chip xs tone={st.v.sandbox.available ? 'ok' : 'soon'}>{st.v.sandbox.available ? `Sandbox disponible ahora${st.v.sandbox.kind && SANDBOX_KIND_LABEL[st.v.sandbox.kind] ? ` (${SANDBOX_KIND_LABEL[st.v.sandbox.kind]})` : ''}` : 'Sandbox no disponible ahora'}</Chip>}
        {st.v.sandbox?.detail && <span className="small muted">{st.v.sandbox.detail}</span>}
      </div>
      <div className="small muted">Las habilidades no conceden permisos: se cambian en Configuración. Editar un SKILL.md no concede nada. Las pruebas y el sandbox solo se ejecutan por el pipeline autorizado; sin terminal (web) el agente lo dice y no simula resultados.</div>
    </>}
  </section>;
}

function FilesTabBody({ slug, p, onChanged }: { slug: string; p: Panel; onChanged: () => void }) {
  const { flash } = useApp();
  const [st, setSt] = useState<FolderStatus | null>(null); const [file, setFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | null>(null); const [skill, setSkill] = useState<PortableSkill | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false); const [confirmRestore, setConfirmRestore] = useState<number | null>(null); const [zip, setZip] = useState(false);
  const load = useCallback(() => osApi.folder(slug, p.agent.id).then(setSt).catch(e => setError(e.message)), [slug, p.agent.id]);
  useEffect(() => { void load(); }, [load, p.folder.adopted?.n]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setError(null); try { await fn(); flash(ok); await load(); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  if (!st) return error ? <Notice kind="err">{error}</Notice> : <Spinner />;
  if (!st.folder) return <>
    <Notice kind="info">Este agente aún no tiene carpeta portable. Al crearla, su identidad queda en archivos que son tuyos (AGENTS.md, habilidades, memoria verificada) y que puedes llevar a otro arnés o exportar. Su configuración no cambia.</Notice>
    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => osApi.createFolder(slug, p.agent.id), 'Carpeta creada')} style={{ alignSelf: 'flex-start' }}>Crear su carpeta</button>
  </>;
  const files = st.adopted?.files ?? {};
  const instr = files['AGENTS.md'] ?? '';
  return <>
    {error && <Notice kind="err">{error}</Notice>}
    <div className="small"><strong>Carpeta</strong> <code className="mono">{st.path}</code></div>
    <div className="small muted">Revisión adoptada {st.adopted?.n} · {st.adopted?.source} · {st.adopted ? new Date(st.adopted.at).toLocaleString('es-MX') : ''}</div>
    {st.external && <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, borderColor: 'var(--color-warn-border)' }}>
      <div className="h3">Cambios hechos fuera del Portal</div>
      <p className="small">Ningún agente los usa hasta que los adoptes. {st.external.notAdopted.length > 0 && 'Algunas partes nunca se adoptan desde la carpeta:'}</p>
      {st.external.notAdopted.map((n, i) => <Notice key={i} kind="info">{n}</Notice>)}
      {st.external.problems.map((x, i) => <Notice key={i} kind={x.blocking ? 'err' : 'warn'}>{x.path}: {x.message}</Notice>)}
      {st.external.diff.map(d => <div key={d.path}><div className="small mono"><strong>{d.path}</strong> · {d.change === 'added' ? 'nuevo' : d.change === 'removed' ? 'eliminado' : 'modificado'}</div>
        <div className="file-view">{d.removed.map((l, i) => <div key={`r${i}`} className="diff-del">- {l}</div>)}{d.added.map((l, i) => <div key={`a${i}`} className="diff-add">+ {l}</div>)}</div></div>)}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary btn-sm" disabled={busy || st.external.problems.some(x => x.blocking)} onClick={() => void act(() => osApi.adopt(slug, p.agent.id, st.external!.hash), 'Cambios adoptados')}>Adoptar los cambios</button>
        {confirmDiscard ? <><button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setConfirmDiscard(false); void act(() => osApi.discard(slug, p.agent.id), 'Cambios descartados: carpeta restaurada'); }}>Sí, descartarlos (se pierden)</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirmDiscard(false)}>No</button></>
          : <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setConfirmDiscard(true)}>Descartarlos…</button>}
      </div>
    </section>}
    <section aria-labelledby="files-h" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="h3" id="files-h">Archivos</div>
      <ul className="file-list">{Object.keys(files).sort().map(f => <li key={f}><button type="button" onClick={() => setFile(file === f ? null : f)} aria-expanded={file === f}>{Icon.file()} {f}</button>{file === f && <div className="file-view">{files[f]}</div>}</li>)}</ul>
    </section>
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="h3">Instrucciones (AGENTS.md)</div>
      {edit === null ? <><p className="small muted">Lo que este agente debe tener siempre presente, con cualquier arnés.</p><InstructionsView text={instr} /><button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={!!st.external} onClick={() => setEdit(/portal-ia: instrucciones por defecto/.test(instr) ? '' : instr)}>Editar instrucciones</button></>
        : <><textarea className="input" rows={8} value={edit} onChange={e => setEdit(e.target.value)} aria-label="Instrucciones del agente" />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="btn btn-ghost btn-sm" onClick={() => setEdit(null)}>Cancelar</button><button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => osApi.identity(slug, p.agent.id, { instructions: edit, expectN: st.adopted?.n ?? null }), 'Instrucciones guardadas (nueva revisión)').then(() => setEdit(null))}>Guardar</button></div></>}
    </section>
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="h3">Habilidades</div>
      <SkillsList files={files} />
      {skill === null ? <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={!!st.external} onClick={() => setSkill({ slug: '', name: '', description: '', body: '' })}>Añadir habilidad</button>
        : <><input className="input" placeholder="Nombre (p. ej. «Plan de campaña»)" value={skill.name} onChange={e => setSkill({ ...skill, name: e.target.value })} aria-label="Nombre de la habilidad" />
          <input className="input" placeholder="Para qué sirve (una frase)" value={skill.description} onChange={e => setSkill({ ...skill, description: e.target.value })} aria-label="Descripción" />
          <textarea className="input" rows={5} placeholder="Cómo se hace, paso a paso" value={skill.body} onChange={e => setSkill({ ...skill, body: e.target.value })} aria-label="Cuerpo" />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="btn btn-ghost btn-sm" onClick={() => setSkill(null)}>Cancelar</button>
            <button className="btn btn-primary btn-sm" disabled={busy || skill.name.trim().length < 2} onClick={() => void act(() => osApi.identity(slug, p.agent.id, { skills: [...skillsOf(files), { ...skill, slug: '' }], expectN: st.adopted?.n ?? null }), 'Habilidad añadida').then(() => setSkill(null))}>Guardar habilidad</button></div></>}
    </section>
    <section aria-labelledby="rev-h" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="h3" id="rev-h">Revisiones</div>
      {st.revisions.filter(r => r.state === 'adopted' || r.state === 'superseded').slice(0, 12).map(r => <div key={r.n} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="mono">#{r.n}</span><span>{r.source}</span><span className="muted">{new Date(r.at).toLocaleString('es-MX')}</span><span className="muted" style={{ flex: 1 }}>{r.note}</span>
        {r.state === 'superseded' && (confirmRestore === r.n ? <><button className="lnk" disabled={busy || !!st.external} onClick={() => { setConfirmRestore(null); void act(() => osApi.restore(slug, p.agent.id, r.n), `Vuelta a la revisión ${r.n}`); }}>Sí, volver (queda como revisión nueva)</button><button className="lnk" onClick={() => setConfirmRestore(null)}>No</button></>
          : <button className="lnk" disabled={busy || !!st.external} onClick={() => setConfirmRestore(r.n)}>Volver a esta…</button>)}
        {r.state === 'adopted' && <Chip xs tone="ok">actual</Chip>}
      </div>)}
    </section>
    {zip ? <AgentZipImport slug={slug} projectId={null} harnesses={null} departments={[]} agentId={p.agent.id} onCancel={() => setZip(false)} onDone={() => { setZip(false); void load(); onChanged(); }} />
      : <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="h3">Importar desde ZIP</div>
        <span className="small muted">Trae lo que este agente aprendió fuera (instrucciones, habilidades, memoria, referencias y CAMBIOS.md): se adopta solo como revisión nueva, que puedes deshacer, y solo te preguntamos si un archivo cambió también aquí desde la exportación. Arnés, permisos e id no cambian. No tiene costo.</span>
        <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={busy || !!st.external} title={st.external ? 'Primero adopta o descarta los cambios hechos en su carpeta' : undefined} onClick={() => setZip(true)}>Importar desde ZIP…</button>
      </section>}
    <ExportBox slug={slug} agentId={p.agent.id} />
  </>;
}
const skillsOf = (files: Record<string, string>): PortableSkill[] => Object.entries(files).filter(([k]) => /^skills\/[^/]+\/SKILL\.md$/.test(k)).map(([k, v]) => {
  const slugName = k.split('/')[1]; const m = v.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm = m?.[1] ?? ''; const name = fm.match(/^name: (.*)$/m)?.[1]?.replace(/^"|"$/g, '') ?? slugName; const description = fm.match(/^description: (.*)$/m)?.[1]?.replace(/^"|"$/g, '') ?? '';
  return { slug: slugName, name, description, body: (m?.[2] ?? v).trim() };
});
function SkillsList({ files }: { files: Record<string, string> }) {
  const skills = skillsOf(files);
  return skills.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{skills.map(s => <li key={s.slug}><strong>{s.name}</strong>{s.description ? ` — ${s.description}` : ''}</li>)}</ul> : <p className="small muted">Sin habilidades todavía.</p>;
}
/**
 * «Descargar paquete (ZIP)»: el mismo botón en Ajustes › Archivos (agentes internos) y en Ajustes › Origen (externos).
 * No llama a la IA ni tiene costo. Estados explícitos: preparando → listo / error. Si el servidor responde 409, muestra
 * cada archivo con su motivo: nunca se entrega un paquete incompleto.
 */
export function BundleDownloadButton({ slug, agentId, external = false, onChat }: { slug: string; agentId: string; external?: boolean; onChat?: () => void }) {
  const helpId = useId();
  const [zip, setZip] = useState<{ state: 'idle' | 'preparing' | 'ready' | 'error'; fileName?: string; message?: string; problems?: ExportProblem[] }>({ state: 'idle' });
  const download = async () => {
    setZip({ state: 'preparing' });
    try { const r = await osApi.downloadZip(slug, agentId); setZip({ state: 'ready', fileName: r.fileName }); }
    catch (e: any) {
      const problems = Array.isArray(e?.body?.problems) ? (e.body.problems as ExportProblem[]) : [];
      setZip({ state: 'error', message: problems.length ? 'No se puede exportar el paquete mientras tenga estos problemas:' : (e?.message ?? 'No se pudo descargar el paquete.'), problems });
    }
  };
  return <>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <button type="button" className="btn btn-secondary btn-sm" disabled={zip.state === 'preparing'} aria-describedby={helpId} onClick={() => void download()}>{zip.state === 'preparing' ? 'Preparando el paquete…' : 'Descargar paquete (ZIP)'}</button>
      {zip.state === 'preparing' && <Spinner />}
    </div>
    <span id={helpId} className="small muted">{external
      ? <>Para usar el agente fuera del Portal con todo lo que usa hoy: sus instrucciones, contexto, habilidades con sus scripts (sin modificar), toda su memoria y los planes que ya funcionaron (PLANES.json). También incluye las reglas de automejora (AUTOMEJORA.md), el registro de cambios (CAMBIOS.md) y una guía (GUIA.md) para procesar un PDF o un ZIP con PDFs sin el Portal. No incluye documentos, la bandeja de entrada, dependencias instaladas, credenciales ni datos internos del Portal. No usa la IA ni tiene costo.</>
      : <>Para usar el agente fuera del Portal. Incluye sus instrucciones, habilidades, memoria verificada y referencias, y las lecciones validadas de su papel si las hay. También incluye las reglas de automejora (AUTOMEJORA.md), el registro de cambios (CAMBIOS.md), un script para anotar cambios y una guía para Claude Code web, Cowork y ChatGPT. No incluye credenciales ni datos internos del Portal. No usa la IA ni tiene costo.</>}</span>
    <div aria-live="polite">
      {zip.state === 'ready' && <Notice kind="ok">Paquete descargado: {zip.fileName}. Para empezar, abre GUIA.md.</Notice>}
      {zip.state === 'error' && <Notice kind="err">{zip.message}{zip.problems && zip.problems.length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{zip.problems.map((x, i) => <li key={i}>{x.path ? <span className="mono">{x.path}{x.line ? `:${x.line}` : ''}</span> : null}{x.path ? ': ' : ''}{x.snippet ? <><code>{x.snippet}</code> — {x.reason ?? x.message}</> : x.message}</li>)}</ul>}
            {zip.problems && zip.problems.some(x => x.hint) && <div className="small" style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>Qué cambiar: {zip.problems.filter(x => x.hint && x.line).map(x => `${x.path}:${x.line}`).join(', ')}. Usa una ruta relativa o un argumento del script.</span>
              <span>Puedes pedírselo al agente en la pestaña Chat, por ejemplo: «Cambia {zip.problems.filter(x => x.hint && x.line).length > 1 ? 'esas líneas' : `la línea ${zip.problems.find(x => x.hint && x.line)?.line ?? ''} de ${zip.problems.find(x => x.hint && x.line)?.path ?? 'ese archivo'}`} para que no use una ruta de mi equipo». La automejora guarda una copia y la puedes deshacer.</span>
              {onChat && <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onChat}>Pedírselo en el chat</button>}
            </div>}</Notice>}
    </div>
  </>;
}
function ExportBox({ slug, agentId }: { slug: string; agentId: string }) {
  const { flash } = useApp();
  const [path, setPath] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [picking, setPicking] = useState(false);
  const toFolder = async () => { setBusy(true); setError(null); try { const r = await osApi.exportTo(slug, agentId, path.trim()); flash(`Exportado a ${r.path}`); setPath(''); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div className="h3">Exportar</div>
    {error && <Notice kind="err">{error}</Notice>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <input className="input" style={{ flex: 1, minWidth: 200 }} value={path} onChange={e => setPath(e.target.value)} placeholder="Carpeta de destino (p. ej. ~/Documentos/agentes)" aria-label="Carpeta de destino" />
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicking(true)}>{Icon.folder()} Elegir…</button>
      {picking && <FolderPicker title="Exportar a…" hint="Elige dónde copiar la carpeta del agente (no se sobrescribe nada)." initialPath={path || null} onSelect={x => { setPicking(false); setPath(x); }} onClose={() => setPicking(false)} />}
      <button className="btn btn-secondary btn-sm" disabled={busy || !path.trim()} onClick={() => void toFolder()}>Copiar carpeta</button>
    </div>
    <span className="small muted">Sin credenciales: la carpeta solo lleva identidad, instrucciones, habilidades, memoria verificada y referencias.</span>
    <PackageReadiness slug={slug} agentId={agentId} />
    <BundleDownloadButton slug={slug} agentId={agentId} />
  </section>;
}

// ---------------------------------------------------------------- Memoria

const ORIGIN_LABEL: Record<ImprovementHistoryItem['origin'], string> = { chat: 'Chat', reintento: 'Reintento' };
const HISTORY_STATUS: Record<ImprovementHistoryItem['status'], string> = { applied: 'Aplicada', undone: 'Deshecha', archived: 'Archivada' };

/**
 * HU-181 · Historial de automejoras de un agente externo: una fila por cambio con fecha, origen (Chat o Reintento),
 * archivos cambiados y resumen. Deshacer no usa la IA ni tiene costo, pero siempre pide confirmación. Solo se puede
 * deshacer la última: si hay cambios posteriores, el servidor responde 409 (later_improvements) y se avisa en la fila.
 */
function ImprovementHistory({ slug, p, onChanged, focus }: { slug: string; p: Panel; onChanged: () => void; focus: boolean }) {
  const { flash } = useApp();
  const items = p.office?.improvementHistory;
  const [confirm, setConfirm] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: 'start' }); }, [focus]);
  const undo = async (pid: string) => {
    setBusy(pid); setError(null);
    try { await osApi.undoImprovement(slug, p.agent.id, pid); setConfirm(null); flash('Automejora deshecha: se restauró la versión anterior de sus archivos'); onChanged(); }
    catch (e: any) {
      setConfirm(null);
      const later = (e?.status ?? e?.statusCode) === 409 || e?.body?.code === 'later_improvements';
      setError({ id: pid, text: later ? 'Deshaz primero la última: hay automejoras posteriores a esta.' : (e?.message ?? 'No se pudo deshacer.') });
    } finally { setBusy(null); }
  };
  return <section ref={ref} id="improvement-history" aria-labelledby="improvement-history-h" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <h3 className="h3" id="improvement-history-h" style={{ margin: 0 }}>Historial de automejoras{items ? ` (${items.length})` : ''}</h3>
    <p className="small muted">Cambios que {p.agent.config.name} hizo en sus instrucciones y habilidades desde el chat o al reintentar un documento. Cada uno tiene respaldo y queda en CAMBIOS.md. Deshacer no usa la IA ni tiene costo.</p>
    {!items && <Notice kind="err">No se pudo cargar el historial de automejoras. Vuelve a abrir el panel para reintentarlo.</Notice>}
    {items && !items.length && <p className="small muted">Aún no hay automejoras.</p>}
    {items?.map(it => <div key={it.id} className="work-card" aria-busy={busy === it.id}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="small muted">{new Date(it.at).toLocaleString('es-MX')}</span>
        <Chip xs>{ORIGIN_LABEL[it.origin]}</Chip>
        <Chip xs tone={it.status === 'applied' ? 'ok' : 'soon'}>{HISTORY_STATUS[it.status]}</Chip>
      </div>
      <span>{it.summary || 'Sin resumen.'}</span>
      {it.files.length > 0 ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{it.files.map(f => <li key={f} className="mono">{f}</li>)}</ul> : <span className="small muted">Sin archivos cambiados.</span>}
      {it.status === 'archived' && it.reason && <span className="small muted">Motivo: {it.reason}</span>}
      {error?.id === it.id && <Notice kind="err">{error.text}</Notice>}
      {it.status === 'applied' && !it.undone && (confirm === it.id
        ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="small">¿Deshacer este cambio? Sus archivos vuelven a la versión anterior.</span>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void undo(it.id)}>{busy === it.id ? 'Deshaciendo…' : 'Sí, deshacer'}</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => setConfirm(null)}>No</button>
          </div>
        : <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={busy !== null} title={it.canUndo ? undefined : 'Solo se puede deshacer la última automejora'} onClick={() => { setError(null); setConfirm(it.id); }}>Deshacer</button>)}
    </div>)}
  </section>;
}

function MemoryTab(props: { slug: string; p: Panel; onChanged: () => void; focusHistory?: boolean }) {
  return <><LearningBlock slug={props.slug} agentId={props.p.agent.id} /><MemoryTabBody {...props} /></>;
}

/** EN-011 · Aprendizaje verificado, pendiente y de procesos en los que participó (solo lectura: nada cambia de estado). */
function LearningBlock({ slug, agentId }: { slug: string; agentId: string }) {
  const [st, setSt] = useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; v: AgentLearningView }>({ kind: 'loading' });
  useEffect(() => {
    let alive = true; setSt({ kind: 'loading' });
    api.agentLearning(slug, agentId).then(v => { if (alive) setSt({ kind: 'ok', v }); }).catch(e => { if (alive) setSt({ kind: 'error', message: e?.message ?? String(e) }); });
    return () => { alive = false; };
  }, [slug, agentId]);
  const entries = (list: AgentLearningEntry[], empty: string) => list.length === 0
    ? <span className="small muted">{empty}</span>
    : <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{list.map(l => <li key={l.id}><strong>{l.title}</strong> — {l.text}{l.processTitle ? <span className="muted"> · de «{l.processTitle}»{l.link === 'paso' ? ' (participó en un paso)' : l.link === 'evidencia' ? ' (según la evidencia)' : ''}</span> : null}</li>)}</ul>;
  return <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }} aria-labelledby="learn-h">
    <div className="h3" id="learn-h">Lo que aprendió</div>
    {st.kind === 'loading' && <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Spinner /> Cargando su aprendizaje…</div>}
    {st.kind === 'error' && <Notice kind="err">No se pudo cargar su aprendizaje: {st.message}</Notice>}
    {st.kind === 'ok' && <>
      <div className="small"><strong>Verificado</strong> ({st.v.verified.length})</div>
      {st.v.verified.length === 0 ? <span className="small muted">Aún no tiene aprendizaje verificado.</span>
        : <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{st.v.verified.map((m, i) => <li key={i}><strong>{m.title}</strong> — {m.text}</li>)}</ul>}
      <div className="small"><strong>Pendiente de tu verificación</strong> ({st.v.pending.length})</div>
      {entries(st.v.pending, 'Nada pendiente de verificar.')}
      <div className="small"><strong>De historias o encargos en los que participó</strong> ({st.v.related.length})</div>
      {entries(st.v.related, 'No hay lecciones detectadas de procesos en los que participó.')}
      <div className="small muted">{st.v.note}</div>
    </>}
  </section>;
}

function MemoryTabBody({ slug, p, onChanged, focusHistory = false }: { slug: string; p: Panel; onChanged: () => void; focusHistory?: boolean }) {
  const { flash } = useApp();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [edits, setEdits] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setError(null); try { await fn(); flash(ok); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const card = (l: Lesson, kind: 'verified' | 'proposed') => <div key={l.id} className="work-card">
    <strong>{l.title}</strong>
    {kind === 'proposed' ? <textarea className="input" rows={3} value={edits[l.id] ?? l.lessonText ?? ''} onChange={e => setEdits({ ...edits, [l.id]: e.target.value })} aria-label={`Texto del aprendizaje «${l.title}»`} /> : <span>{l.lessonText}</span>}
    <span className="small muted">Origen: {l.evidence.processTitle ?? 'conversación'} · {l.evidence.detail.slice(0, 220)}</span>
    <div style={{ display: 'flex', gap: 8 }}>
      {kind === 'proposed' && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => osApi.verifyMemory(slug, p.agent.id, l.id, edits[l.id] ? { text: edits[l.id] } : {}), 'Aprendizaje verificado: lo usará en adelante')}>Verificar</button>}
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => osApi.retireMemory(slug, p.agent.id, l.id), kind === 'proposed' ? 'Propuesta descartada' : 'Aprendizaje retirado')}>{kind === 'proposed' ? 'Descartar' : 'Retirar'}</button>
    </div>
  </div>;
  return <>
    <p className="small muted">{p.external ? <>La memoria de {p.agent.config.name} es su propio archivo de memoria (en su carpeta original; lo cambian sus automejoras) más lo que verifiques aquí a partir de su trabajo.</> : <>La memoria de {p.agent.config.name} es lo que tú has verificado a partir de su trabajo. Se aplica con cualquier arnés y viaja en su carpeta (memory/MEMORY.md).</>} Nada generado por un modelo entra aquí solo.</p>
    {error && <Notice kind="err">{error}</Notice>}
    {p.external && <ImprovementHistory slug={slug} p={p} onChanged={onChanged} focus={focusHistory} />}
    <div className="h3">Por verificar ({p.memory.proposed.length})</div>
    {p.memory.proposed.length ? p.memory.proposed.map(l => card(l, 'proposed')) : <p className="small muted">Nada pendiente.</p>}
    <div className="h3">Verificada ({p.memory.verified.length})</div>
    {p.memory.verified.length ? p.memory.verified.map(l => card(l, 'verified')) : <p className="small muted">Aún sin aprendizaje verificado.</p>}
    {adding ? <FeedbackForm slug={slug} agentId={p.agent.id} onDone={() => { setAdding(false); onChanged(); }} /> : <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>Proponer un aprendizaje</button>}
  </>;
}

// ---------------------------------------------------------------- Configuración

function ConfigTab({ slug, p, departments, onChanged }: { slug: string; p: Panel; departments: Department[]; onChanged: () => void }) {
  const { flash } = useApp();
  const [opts, setOpts] = useState<HarnessOptions | null>(null); const [pick, setPick] = useState<ExecutionBackend | null>(null); const [model, setModel] = useState(''); const [provider, setProvider] = useState<ProviderId | null>(null);
  const [auth, setAuth] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [dep, setDep] = useState(p.department?.name ?? '');
  const load = useCallback(() => osApi.harnessOptions(slug, p.agent.id).then(setOpts).catch(e => setError(e.message)), [slug, p.agent.id]);
  useEffect(() => { void load(); }, [load, p.agent.config.backend]);
  const chosen = opts?.options.find(o => o.id === pick) ?? null;
  const modelGroups = chosen?.models ?? [];
  useEffect(() => { if (!chosen) return; const g = chosen.models[0]; setProvider(g?.provider ?? null); setModel(g?.models.find(m => m.id === p.agent.config.model)?.id ?? g?.models[0]?.id ?? ''); setAuth(false); }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps
  const doSwitch = async () => { if (!pick) return; setBusy(true); setError(null); try { await osApi.switchHarness(slug, p.agent.id, pick, model, provider); flash(`Arnés de ${p.agent.config.name}: ${chosen?.name}`); setPick(null); await load(); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const move = async () => { setBusy(true); setError(null); try { await osApi.moveAgent(slug, p.agent.id, dep); flash(`${p.agent.config.name} ahora está en ${dep}`); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const tools = useMemo(() => Object.keys(p.agent.config.tools).filter(k => p.agent.config.tools[k]), [p.agent.config.tools]);
  return <>
    {error && <Notice kind="err">{error}</Notice>}
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="h3">Identidad</div>
      <div className="small">{p.personalName ? <><strong>{p.personalName}</strong> · </> : null}<strong>{p.agent.config.name}</strong> · {p.agent.template.role}</div>
      <NameSection slug={slug} p={p} onChanged={onChanged} />
      <div className="small muted">{p.agent.config.specialization}</div>
      {p.agent.config.responsibilities.length > 0 && <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{p.agent.config.responsibilities.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="small" htmlFor="cfg-dep">Departamento</label>
        <select id="cfg-dep" className="input" style={{ maxWidth: 240, height: 32 }} value={dep} onChange={e => setDep(e.target.value)}>{departments.map(d => <option key={d.slug} value={d.name}>{d.name}</option>)}</select>
        <button className="btn btn-secondary btn-sm" disabled={busy || dep === p.department?.name} onClick={() => void move()}>Mover</button>
      </div>
    </section>
    {/* EN-021 · Sello Portal IA en solo lectura: igual para agentes propios y externos (EXTERNAL_TABS también abre ConfigTab). */}
    <PortalSealPanel />
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }} aria-labelledby="harness-h">
      <div className="h3" id="harness-h">Motor de IA (cómo trabaja)</div>
      {!opts ? <Spinner /> : <>
        <p className="small">Ahora trabaja con <strong>{opts.currentLabel}</strong>. {opts.continuity}</p>
        <details className="small muted"><summary style={{ cursor: 'pointer' }}>Detalles técnicos</summary>Modelo: <span className="mono">{opts.model}</span></details>
        <div className="harness-cards">{opts.options.filter(o => o.id !== 'claude-code-terminal' || o.current).map(o => <button key={o.id} type="button" className="harness-card" aria-pressed={(pick ?? opts.current) === o.id} disabled={!o.availability.available && !o.current} onClick={() => setPick(o.current ? null : o.id)}>
          <strong>{o.name}{o.current ? ' · actual' : ''}</strong>
          <span className="small muted">{o.vendor} · {o.billing === 'subscription' ? 'tu suscripción' : o.billing === 'api' ? 'API facturable' : 'no verificable'}</span>
          <span className="small">{o.availability.available ? (o.availability.detail ?? 'Disponible') : o.availability.reason}</span>
        </button>)}</div>
        {chosen && <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="h3">Cambiar a {chosen.name}</div>
          <p className="small">{chosen.summary}</p>
          {(chosen.compatibility.missing.length > 0 || chosen.compatibility.reduced.length > 0) && <ul className="cap-list">
            {chosen.compatibility.missing.map(m => <li key={m.capability}>{Icon.stateError()} <span><strong>Pierde:</strong> {m.label}{m.note ? ` — ${m.note}` : ''}</span></li>)}
            {chosen.compatibility.reduced.map(m => <li key={m.capability}>{Icon.warn()} <span><strong>Parcial:</strong> {m.label}{m.note ? ` — ${m.note}` : ''}</span></li>)}
          </ul>}
          {chosen.compatibility.gains.length > 0 && <ul className="cap-list">{chosen.compatibility.gains.map(g => <li key={g.capability}>{Icon.stateDone()} <span><strong>Gana:</strong> {g.label}</span></li>)}</ul>}
          {/* Lo que cambia aunque su trabajo de hoy no lo use: también se dice, para decidir con todo a la vista. */}
          {chosen.compatibility.losses.filter(l => !l.needed).length > 0 && <ul className="cap-list">{chosen.compatibility.losses.filter(l => !l.needed).map(l => <li key={l.capability}>{Icon.info()} <span><strong>Cambia:</strong> {l.label} ({LEVEL[l.from.level]} → {LEVEL[l.to.level]}){l.to.note ? ` — ${l.to.note.replace(/\.$/, '')}` : ''}. Hoy no lo usa.</span></li>)}</ul>}
          {!chosen.compatibility.missing.length && !chosen.compatibility.reduced.length && !chosen.compatibility.losses.length && !chosen.compatibility.gains.length && <p className="small">Mismas capacidades que con su arnés actual.</p>}
          {chosen.id === 'codex' && <Notice kind="info">Con Codex, este agente puede conversar, recibir encargos y participar en peticiones de departamento. Las historias del backlog y los lotes aún no se ejecutan con Codex: allí se detendrá y te lo dirá.</Notice>}
          {chosen.billing === 'api' && <Notice kind="warn">La API se factura por uso: cada encargo te pedirá presupuesto y cada mensaje, confirmación.</Notice>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {modelGroups.length > 1 && <select className="input" style={{ maxWidth: 160, height: 32 }} value={provider ?? ''} onChange={e => { const g = modelGroups.find(x => x.provider === e.target.value); setProvider(g?.provider ?? null); setModel(g?.models[0]?.id ?? ''); }} aria-label="Proveedor">{modelGroups.map(g => <option key={g.provider} value={g.provider}>{g.provider === 'openai' ? 'OpenAI' : 'Anthropic'}</option>)}</select>}
            <select className="input" style={{ maxWidth: 280, height: 32 }} value={model} onChange={e => setModel(e.target.value)} aria-label="Modelo">{(modelGroups.find(g => g.provider === provider)?.models ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          </div>
          {opts.work.open.length > 0 && <Notice kind="info">{opts.pinned} Trabajos abiertos: {opts.work.open.map(w => `«${w.title}»`).join(', ')}.</Notice>}
          {opts.work.batches.length > 0 && <Notice kind="info">Lotes abiertos: {opts.work.batches.map(b => `«${b.title}» (${b.status})`).join(', ')}. Solo usarán a este agente con un origen que el lote autorice.</Notice>}
          <label className="ck small"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /> Autorizo que {p.agent.config.name} trabaje con {chosen.name}{chosen.billing === 'api' ? ' (facturable por uso)' : chosen.billing === 'subscription' ? ' y mi suscripción' : ''}. Su identidad, instrucciones, habilidades y memoria no cambian.</label>
          <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-end' }} disabled={busy || !auth || !model || opts.work.inFlight.length > 0} onClick={() => void doSwitch()}>{busy ? 'Cambiando…' : `Cambiar a ${chosen.name}`}</button>
          {opts.work.inFlight.length > 0 && <span className="small" style={{ color: 'var(--color-err-text)' }}>Tiene una llamada en curso: espera a que termine.</span>}
        </div>}
      </>}
    </section>
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="h3">Permisos</div>
      <div className="small">Permisos concedidos: {tools.length ? tools.map(t => TOOL_LABELS[t]?.name ?? t).join(', ') : 'ninguno'}</div>
      <div className="small">Trabaja en: {workplaceLabel(p.agent.scope).toLowerCase()} · las acciones externas, publicar o gastar siempre te piden aprobación.</div>
      <div className="small muted">Las instrucciones o habilidades de su carpeta nunca amplían estos permisos.</div>
    </section>
    {/* HU-210 · Única pantalla de configuración del agente: lo que antes estaba en /equipo/:id se edita aquí. */}
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }} aria-labelledby="adv-h">
      <div className="h3" id="adv-h">Modelo, herramientas, límites y capacidades</div>
      <AgentAdvancedSettings key={p.agent.id} slug={slug} agentId={p.agent.id} onChanged={onChanged} />
    </section>
    <section style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div className="h3">Registro</div>
      {p.events.slice(0, 12).map(e => <div key={e.id} className="small"><span className="muted">{new Date(e.at).toLocaleString('es-MX')}</span> · {EVENT_TEXT[e.kind] ?? e.kind}{e.kind === 'integration_state' && e.detail?.to ? ` → ${INTEGRATION_TO[String(e.detail.to)] ?? String(e.detail.to)}` : e.kind === 'document_job' ? `: ${JOB_ACTION[String(e.detail?.action)] ?? String(e.detail?.action ?? '')}${e.detail?.version ? ` (v${e.detail.version})` : ''}` : e.detail?.to ? ` → ${HARNESS_NAME[String(e.detail.to)] ?? String(e.detail.to)}` : ''}</div>)}
      {!p.events.length && <span className="small muted">Sin eventos todavía.</span>}
    </section>
  </>;
}
/**
 * EN-015 · Nombre propio, distinto del puesto (config.name no cambia y la carpeta no se renombra). «Que elija su nombre»
 * hace UNA llamada con su arnés solo después de tu autorización en la tarjeta; escribirlo a mano no cuesta nada.
 */
type NameState = { kind: 'idle' } | { kind: 'authorize' } | { kind: 'loading' } | { kind: 'proposal'; proposal: NameProposal } | { kind: 'error'; message: string; clash: boolean };
function NameSection({ slug, p, onChanged }: { slug: string; p: Panel; onChanged: () => void }) {
  const { flash } = useApp();
  const [st, setSt] = useState<NameState>({ kind: 'idle' });
  const [est, setEst] = useState<NameEstimate | null>(p.nameEstimate ?? null); const [estErr, setEstErr] = useState<string | null>(null);
  const [auth, setAuth] = useState(false); const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [manualOpen, setManualOpen] = useState(false); const [manual, setManual] = useState(''); const [manualErr, setManualErr] = useState<string | null>(null);
  const inputId = useId();
  const current = p.personalName ?? null; const role = p.agent.config.name;
  const m = manual.trim(); const manualOk = m.length >= 2 && m.length <= 30;
  const openAuth = () => {
    setAuth(false); setManualOpen(false); setSt({ kind: 'authorize' });
    if (!est) { setEstErr(null); osApi.nameEstimate(slug, p.agent.id).then(setEst).catch((e: any) => setEstErr(e.message)); }
  };
  const propose = async () => {
    setSt({ kind: 'loading' }); setAuth(false);
    try { setSt({ kind: 'proposal', proposal: await osApi.proposeName(slug, p.agent.id, rejected) }); onChanged(); }
    catch (e: any) { setSt({ kind: 'error', message: e.message, clash: false }); }
  };
  const another = (name: string) => { setRejected(r => [...r.filter(x => x !== name), name].slice(-10)); openAuth(); };
  const save = async (name: string | null, fromManual: boolean) => {
    setBusy(true); setManualErr(null);
    try {
      const r = await osApi.setName(slug, p.agent.id, name);
      flash(name ? `${role} ahora se llama ${r.personalName ?? name}` : `${role} ya no tiene nombre propio`);
      setSt({ kind: 'idle' }); setRejected([]); setManualOpen(false); setManual(''); onChanged();
    } catch (e: any) {
      const clash = e?.status === 409 || e?.body?.code === 'taken' || e?.body?.code === 'role';
      if (fromManual && name !== null) setManualErr(e.message); else setSt({ kind: 'error', message: e.message, clash });
    } finally { setBusy(false); }
  };
  const box = { padding: 10, display: 'flex', flexDirection: 'column', gap: 6 } as const;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--color-border)', paddingTop: 8, marginTop: 4 }} role="group" aria-labelledby={`${inputId}-h`}>
    <div className="small" id={`${inputId}-h`}><strong>Nombre propio</strong></div>
    <div className="small">{current ? <>Se llama <strong>{current}</strong>. Su puesto sigue siendo «{role}».</> : <>Aún no tiene nombre propio: se le muestra por su puesto, «{role}».</>}</div>
    {st.kind === 'idle' && !manualOpen && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button type="button" className="btn btn-secondary btn-sm" disabled={p.retired || busy} onClick={openAuth}>Que elija su nombre</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setManualOpen(true); setManual(current ?? ''); }}>Escribirlo a mano</button>
      {current && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save(null, false)}>Quitar el nombre</button>}
    </div>}
    {p.retired && st.kind === 'idle' && <span className="small muted">Está retirado: reactívalo para que proponga un nombre.</span>}
    {st.kind === 'authorize' && <div className="card" style={box} role="group" aria-label="Autorizar la propuesta de nombre">
      <strong className="small">Autorizar una llamada</strong>
      <span className="small">{role} hará UNA llamada con su motor de IA{est ? ` (${est.label})` : ''} para proponer un nombre propio con un motivo breve. No se guarda nada hasta que lo aceptes.</span>
      <span className="small">{estErr ? `No se pudo calcular el costo: ${estErr}` : !est ? 'Calculando el costo…' : est.billable ? `Costo estimado: ≈ ${est.estimatedUsd.toFixed(3)} USD de la API, contra su límite mensual.` : 'Costo: 0 USD (llamada de tu suscripción).'}</span>
      {rejected.length > 0 && <span className="small muted">Le pediremos uno distinto de {rejected.map(r => `«${r}»`).join(', ')}.</span>}
      <label className="ck small"><input className="cb" type="checkbox" checked={auth} disabled={!est} onChange={e => setAuth(e.target.checked)} /> Autorizo esta llamada{est?.billable ? ' facturable por uso' : ' con mi suscripción'}.</label>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSt({ kind: 'idle' })}>Cancelar</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!auth || !est} onClick={() => void propose()}>Pedirle un nombre</button>
      </div>
    </div>}
    {st.kind === 'loading' && <div className="small" role="status" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Spinner /> {role} está eligiendo su nombre…</div>}
    {st.kind === 'proposal' && <div className="card" style={box} aria-live="polite">
      <div><span className="small muted">Propone:</span> <strong style={{ fontSize: 16 }}>{st.proposal.name}</strong></div>
      {st.proposal.reason && <span className="small">«{st.proposal.reason}»</span>}
      <span className="small muted">{st.proposal.costUsd > 0 ? `Costó ${st.proposal.costUsd.toFixed(3)} USD` : 'Costó 0 USD (suscripción)'} · {st.proposal.tokensIn + st.proposal.tokensOut} tokens</span>
      {!st.proposal.check.ok && <Notice kind="warn">No se puede usar: {st.proposal.check.reason ?? 'nombre no válido'}. Pide otro o escríbelo a mano.</Notice>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !st.proposal.check.ok} onClick={() => void save(st.proposal.name, false)}>{busy ? 'Guardando…' : 'Aceptar'}</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => another(st.proposal.name)}>Pedir otro</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setManual(st.proposal.check.ok ? st.proposal.name : ''); setSt({ kind: 'idle' }); setManualOpen(true); }}>Escribirlo a mano</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setSt({ kind: 'idle' })}>Descartar</button>
      </div>
    </div>}
    {st.kind === 'error' && <>
      <Notice kind={st.clash ? 'warn' : 'err'}>{st.clash ? `Ese nombre no está libre: ${st.message} Pide otro o escríbelo a mano.` : st.message}</Notice>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!p.retired && <button type="button" className="btn btn-secondary btn-sm" onClick={openAuth}>Pedir otro</button>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSt({ kind: 'idle' }); setManualOpen(true); }}>Escribirlo a mano</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSt({ kind: 'idle' })}>Volver</button>
      </div>
    </>}
    {manualOpen && st.kind === 'idle' && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label className="small" htmlFor={inputId}>Nombre propio (2–30 caracteres, sin costo ni IA)</label>
      <input id={inputId} className="input" style={{ maxWidth: 260, height: 32 }} maxLength={30} value={manual} autoFocus
        onChange={e => { setManual(e.target.value); setManualErr(null); }} onKeyDown={e => { if (e.key === 'Enter' && manualOk && !busy) void save(m, true); }} />
      {m.length > 0 && !manualOk && <span className="small muted">Debe tener entre 2 y 30 caracteres.</span>}
      {manualErr && <Notice kind="err">{manualErr}</Notice>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !manualOk} onClick={() => void save(m, true)}>{busy ? 'Guardando…' : 'Guardar'}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setManualOpen(false); setManualErr(null); }}>Cancelar</button>
      </div>
    </div>}
  </div>;
}
const LEVEL: Record<string, string> = { yes: 'sí', partial: 'parcial', no: 'no' };
/** EN-011 · Tipo de sandbox en lenguaje claro; solo se muestra si está disponible (otros valores, como 'none', no se enseñan). */
const SANDBOX_KIND_LABEL: Record<string, string> = { docker: 'Docker', wsl: 'WSL2', 'linux-ns': 'espacios de nombres de Linux' };
/** Problema de la exportación (409): EN-010 añade la línea, el fragmento, el motivo y la sugerencia de pedirlo en el chat. */
type ExportProblem = { path: string; message: string; line?: number; snippet?: string; reason?: string; hint?: string };
const HARNESS_NAME: Record<string, string> = Object.fromEntries(HARNESSES.map(h => [h.id, h.name]));
const EVENT_TEXT: Record<string, string> = { created: 'Creado', imported: 'Importado', exported: 'Exportado', harness_changed: 'Arnés cambiado', department_changed: 'Cambio de departamento', folder_created: 'Carpeta creada', folder_adopted: 'Cambios externos adoptados', folder_discarded: 'Cambios externos descartados', folder_restored: 'Vuelta a una revisión anterior', identity_updated: 'Identidad editada', memory_proposed: 'Aprendizaje propuesto', memory_verified: 'Aprendizaje verificado', memory_retired: 'Aprendizaje retirado', task_created: 'Encargo creado', chat: 'Conversación',
  source_imported: 'Integrado desde su carpeta', source_adopted: 'Cambios externos adoptados', source_grants: 'Permisos cambiados', source_restored: 'Vuelta a una versión anterior', integration_state: 'Estado de integración', document_job: 'Documento', improvement_proposed: 'Automejora propuesta', improvement_applied: 'Automejora aplicada', improvement_rejected: 'Automejora archivada', improvement_undone: 'Automejora deshecha' };
const INTEGRATION_TO: Record<string, string> = { pending: 'pendiente', evaluating: 'en evaluación', integrated: 'integrado' };
const JOB_ACTION: Record<string, string> = { received: 'recibido', run: 'en proceso', ready: 'pasó las comprobaciones', rejected: 'no pasó las comprobaciones' };

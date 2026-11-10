import type { KeyboardEvent as RKeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { UsageToday } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { onBundleChange, staleInterface } from '../lib/liveStatus.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Chip, Icon, Notice } from './ui.tsx';
import { Modal } from './Modal.tsx';
import { PortalMark } from './illustrations.tsx';
import { SystemBar } from './SystemBar.tsx';
import { useLive, useLiveConnection } from '../lib/live.ts';
import { useBack } from '../lib/nav.ts';
import { officeHome, SECTIONS, sectionOf, sectionRoot, type IconName, type Section } from '../lib/routes.ts';
import { attentionTotal, openUi, useAttention } from '../lib/uiBus.ts';
import { OwnerBar } from './OwnerPairing.tsx';

/** Diálogo mínimo para crear empresa o proyecto (operación local, sin IA). */
export function CreateDialog({ kind, onClose }: { kind: 'company' | 'project'; onClose: () => void }) {
  const { status, select, refreshStructure, flash } = useApp();
  const [name, setName] = useState(''); const [desc, setDesc] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (name.trim().length < 2) return; setBusy(true); setError(null);
    try {
      if (kind === 'company') { const ws = await api.createWorkspace(name.trim()); await refreshStructure(); await select(ws.slug, null, { to: () => '/oficina' }); flash(`Empresa «${ws.name}» creada con sus 3 agentes de empresa`); }
      else { const p = await api.createProject(status.workspace!.slug, name.trim(), desc.trim()); await select(status.workspace!.slug, p.id, { to: () => '/panel' }); flash(`Proyecto «${p.name}» creado con su equipo`); }
      onClose();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <Modal title={kind === 'company' ? 'Nueva empresa' : `Nuevo proyecto en ${status.workspace?.name}`} onClose={onClose}
    footer={<><button className="btn btn-ghost" onClick={onClose}>Cancelar</button><button className="btn btn-primary" onClick={create} disabled={busy || name.trim().length < 2}>{busy ? 'Creando…' : 'Crear'}</button></>}>
    <p className="small muted" style={{ margin: 0 }}>{kind === 'company' ? 'Empresa aislada con su propia base de datos y sus 3 agentes de empresa.' : 'Recibe su equipo de 5 agentes desde las plantillas aprobadas.'} No consume IA.</p>
    {error && <Notice kind="err">{error}</Notice>}
    <div><label className="label" htmlFor="cd-name">Nombre</label><input id="cd-name" className="input" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void create(); }} /></div>
    {kind === 'project' && <div><label className="label" htmlFor="cd-desc">Descripción</label><textarea id="cd-desc" className="input" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Qué se construye y para quién" /></div>}
  </Modal>;
}

const usageCache = new Map<string, UsageToday>();
const ICONS: Record<IconName, () => ReactNode> = { building: () => Icon.building(), bell: () => Icon.bell(), sparkles: () => Icon.sparkles(), gauge: () => Icon.gauge(), kanban: () => Icon.kanban(), book: () => Icon.book(), sliders: () => Icon.sliders() };
export const sectionIcon = (s: Section) => ICONS[s.icon]();

/**
 * Estructura de Portal IA 2.0: menú lateral índigo (contexto empresa/proyecto y 7 secciones), barra superior con migas,
 * búsqueda (Ctrl+K), «Pedir» (Asistente) y Decisiones. En tableta el menú es un rail; en móvil, un cajón con foco atrapado.
 * Cambiar de empresa o de proyecto lleva a la RAÍZ de la sección actual (nunca a un detalle de la empresa anterior) y
 * crea una entrada nueva en el historial.
 */
/** Ruta de la pantalla anterior (para mover el foco solo al cambiar de pantalla) y selector a reenfocar tras cambiar de empresa. */
let lastPath: string | null = null;
let refocus: string | null = null;

export function Shell({ crumb, children }: { crumb: ReactNode; children: ReactNode }) {
  const { status, workspaces, projects, select, navigate } = useApp();
  const ws = status.workspace!; const project = status.project;
  // Cada pantalla monta su Shell: el consumo de hoy se recuerda entre pantallas (se ve al instante) y se actualiza cuando
  // algo cambia (procesos, llamadas), no cada 5 s. Sin conexión en tiempo real, el respaldo de lib/live.ts lo vuelve a pedir.
  const [usage, setUsage] = useState<UsageToday | null>(() => usageCache.get(ws.slug) ?? null);
  const [dialog, setDialog] = useState<'company' | 'project' | null>(null);
  const loadUsage = () => api.usageToday(ws.slug).then(u => { usageCache.set(ws.slug, u); setUsage(u); }).catch(() => { /* backend ausente */ });
  useEffect(() => { void loadUsage(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug]);
  useLive(c => c.ws === ws.slug && (c.entity === 'usage' || (c.entity === 'process' && c.kind !== 'progress')), () => loadUsage(), { minMs: 2500 });
  const back = useBack();
  const liveConn = useLiveConnection();
  const att = useAttention(ws.slug); const pending = attentionTotal(att);
  const path = useLocation().pathname;
  const section = sectionOf(path);
  // Móvil: el menú es un cajón (Esc lo cierra, el foco queda dentro y vuelve al botón al cerrar); se cierra al navegar.
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null); const sideRef = useRef<HTMLElement>(null);
  useEffect(() => { setMenu(false); }, [path]);
  useEffect(() => {
    if (!menu) return;
    const first = sideRef.current?.querySelector<HTMLElement>('select, a, button'); first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenu(false); menuBtn.current?.focus(); return; }
      if (e.key !== 'Tab' || !sideRef.current) return;
      const els = [...sideRef.current.querySelectorAll<HTMLElement>('select, a[href], button:not([disabled])')].filter(x => x.offsetParent !== null);
      if (!els.length) return; const a = els[0]; const z = els[els.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [menu]);
  // Título de la pestaña (lectores de pantalla, historial) y, al cambiar de pantalla, el foco al contenido; tras cambiar
  // de empresa o proyecto con el teclado, el foco vuelve al selector (la pantalla se montó de nuevo).
  useEffect(() => {
    document.title = [typeof crumb === 'string' && crumb !== section?.label ? crumb : null, section?.label, ws.name, 'Portal IA'].filter(Boolean).join(' · ');
  });
  useEffect(() => {
    const prev = lastPath; lastPath = path;
    if (refocus) { const id = refocus; refocus = null; requestAnimationFrame(() => document.getElementById(id)?.focus()); return; }
    if (prev === null || prev === path || /^\/oficina\/agente\//.test(path) || /^\/oficina\/agente\//.test(prev)) return;
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body && el.closest('.agent-panel, .dock, .cmdk, .modal, .side-open')) return;
    document.getElementById('contenido')?.focus({ preventScroll: true });
  }, [path]);
  // Pestaña abierta con una interfaz anterior a la que sirve ahora el Portal (reconstruido y reiniciado): sus acciones
  // pueden no existir o comportarse distinto. Se pide recargar en vez de seguir con botones obsoletos.
  const [stale, setStale] = useState(staleInterface());
  useEffect(() => onBundleChange(() => setStale(staleInterface())), []);
  // Cambio de empresa o proyecto: una navegación NUEVA a la raíz de la sección, en la misma actualización que la selección.
  const switchTo = (slug: string, pid: string | null, from: string) => { refocus = from; return select(slug, pid, { to: chosen => sectionRoot(path, !!chosen) }); };
  // Con el ratón, elegir cambia; con el teclado (flechas), se marca y se cambia al pulsar Intro.
  const [pick, setPick] = useState<{ ws?: string; pj?: string }>({}); const byKeys = useRef(false);
  const apply = (which: 'ws' | 'pj', v: string) => { setPick({}); if (which === 'ws') { if (v !== ws.slug) void switchTo(v, null, 'ws-select'); } else if (v && v !== project?.id) void switchTo(ws.slug, v, 'pj-select'); };
  const onPick = (which: 'ws' | 'pj', v: string) => { if (byKeys.current) { byKeys.current = false; setPick({ [which]: v }); } else apply(which, v); };
  const onPickKey = (e: RKeyboardEvent<HTMLSelectElement>, which: 'ws' | 'pj') => {
    if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key) || e.key.length === 1) byKeys.current = true;
    if (e.key === 'Enter') { const v = pick[which]; if (v) { e.preventDefault(); apply(which, v); } }
  };
  // HU-196 · Las secciones con inMenu === false (Decisiones) no se listan en el menú: se llega a ellas con la campana y Ctrl+K.
  const group = (g: Section['group']) => SECTIONS.filter(s => s.group === g && s.inMenu !== false && (!s.needsProject || project));
  const navItem = (s: Section) => <Link key={s.id} to={s.id === 'oficina' ? officeHome() : s.path} className={`navi${section?.id === s.id ? ' is-active' : ''}`} aria-current={section?.id === s.id ? 'page' : undefined}
    title={s.hint}>
    {sectionIcon(s)}<span className="navi-text">{s.label}</span>
    {s.id === 'trabajo' && usage && usage.running > 0 && <span className="navi-live" title={`${usage.running} en ejecución`}><span className="live-dot" aria-hidden="true" /><span>{usage.running}</span><span className="sr-only"> en ejecución</span></span>}
  </Link>;

  return (
    <div className="screen shell">
      <a className="skip-link" href="#contenido">Saltar al contenido</a>
      {menu && <div className="side-scrim" onClick={() => { setMenu(false); menuBtn.current?.focus(); }} aria-hidden="true" />}
      <aside className={`side${menu ? ' side-open' : ''}`} ref={sideRef} aria-label="Menú principal" {...(menu ? { role: 'dialog', 'aria-modal': true } : {})}>
        <button type="button" className="side-close" onClick={() => { setMenu(false); menuBtn.current?.focus(); }} aria-label="Cerrar menú">{Icon.x(16)}</button>
        <Link className="side-brand" to={officeHome()} aria-label="Portal IA · ir a la Oficina" style={{ textDecoration: 'none' }}><PortalMark size={30} /><span>Portal IA<small>Estudio de agentes</small></span></Link>
        <div className="ctx" role="group" aria-label="Contexto de trabajo">
          <label className="ctx-label" htmlFor="ws-select">Empresa</label>
          <select id="ws-select" value={pick.ws ?? ws.slug} aria-describedby="ctx-hint" onKeyDown={e => onPickKey(e, 'ws')} onBlur={() => setPick({})} onChange={e => onPick('ws', e.target.value)}>
            {workspaces.map(w => <option key={w.slug} value={w.slug}>{w.name}{w.kind === 'internal' ? ' · interna' : ''}</option>)}
          </select>
          <div className="ctx-project">
            <label className="ctx-label" htmlFor="pj-select">Proyecto</label>
            <select id="pj-select" value={pick.pj ?? project?.id ?? ''} aria-describedby="ctx-hint" onKeyDown={e => onPickKey(e, 'pj')} onBlur={() => setPick({})} onChange={e => onPick('pj', e.target.value)}>
              {!project && <option value="">Sin proyecto</option>}
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <span id="ctx-hint" className="sr-only">Con el teclado: elige con las flechas y pulsa Intro para cambiar.</span>
          {/* Crear va aparte de elegir: con el teclado, recorrer la lista nunca abre un diálogo. */}
          <div className="ctx-actions"><button type="button" className="ctx-add" onClick={() => setDialog('company')}>{Icon.plus()} Empresa</button><button type="button" className="ctx-add" onClick={() => setDialog('project')}>{Icon.plus()} Proyecto</button></div>
        </div>
        <nav aria-label="Secciones" style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 10 }}>
          {group('main').map(navItem)}
          {project ? <><div className="side-sec">Proyecto</div>{group('project').map(navItem)}</>
            : <button type="button" className="navi" onClick={() => setDialog('project')}>{Icon.plus()}<span className="navi-text">Crear un proyecto</span></button>}
          <div className="side-sec">Empresa</div>
          {group('company').map(navItem)}
        </nav>
        <div className="side-foot">
          <Link to="/presupuestos" className="side-usage" style={{ textDecoration: 'none' }} title={`Consumo de hoy: ${usage?.calls ?? 0} llamadas, ${usage?.tokens ?? 0} tokens, ${fmtUsd(usage?.costUsd ?? 0)} (abre Presupuestos)`}>
            Hoy · <strong className="num">{usage?.calls ?? 0}</strong> llamadas · <strong className="num">{fmtUsd(usage?.costUsd ?? 0)}</strong>
            {usage && usage.running > 0 ? <> · <strong>{usage.running}</strong> en ejecución</> : null}
          </Link>
        </div>
      </aside>
      <div className="content">
        <header className="top">
          <div className="top-left">
            <button ref={menuBtn} type="button" className="top-icon top-menu-btn" aria-expanded={menu} aria-label="Abrir menú: empresa, proyecto y secciones" onClick={() => setMenu(true)}>{Icon.menu()}</button>
            {back && <button type="button" className="btn btn-ghost btn-sm back-global" onClick={back.go} aria-label={`Atrás: volver a ${back.label}`} title={`Volver a ${back.label} (como el botón Atrás del navegador)`}>{Icon.back()}<span className="back-label">{back.label}</span></button>}
            <nav className="crumbs" aria-label="Ubicación actual">
              <span className="crumb-ctx crumb-ws">{ws.name}</span>
              {project && section?.needsProject && <><span className="sep crumb-ctx" aria-hidden="true">›</span><span className="crumb-ctx">{project.name}</span></>}
              {section && <><span className="sep crumb-ctx" aria-hidden="true">›</span>{crumb === section.label ? <span className="cur" aria-current="page">{section.label}</span> : <Link to={section.path}>{section.label}</Link>}</>}
              {!(section && crumb === section.label) && <><span className="sep" aria-hidden="true">›</span><span className="cur">{crumb}</span></>}
            </nav>
          </div>
          <div className="top-right">
            {liveConn === 'down' && <span role="status" aria-label="Sin conexión en tiempo real: la pantalla se actualiza cada 15 s mientras tanto."><Chip tone="warn" xs>sin tiempo real</Chip></span>}
            <button type="button" className="top-search" onClick={() => openUi('palette')} aria-label="Buscar e ir a… (Ctrl+K)">{Icon.search()}<span className="top-search-text">Buscar…</span><kbd>Ctrl K</kbd></button>
            <button type="button" className="btn btn-primary btn-sm top-ask" onClick={() => openUi('assistant')} aria-label={att.assistant ? `Pedir al Asistente, ${att.assistant} propuestas pendientes` : 'Pedir al Asistente'}>
              {Icon.sparkles()}<span className="top-ask-text">Pedir</span>{att.assistant > 0 && <span className="top-badge" aria-hidden="true">{att.assistant}</span>}
            </button>
            <Link className="top-icon" to="/autorizaciones" aria-current={section?.id === 'decisiones' ? 'page' : undefined}
              aria-label={pending ? `Decisiones: ${pending} pendiente${pending === 1 ? '' : 's'} e historial` : 'Decisiones: historial'} title="Decisiones pendientes e historial">
              {Icon.bell()}{pending > 0 && <span className="top-badge" aria-hidden="true">{pending > 99 ? '99+' : pending}</span>}
            </Link>
          </div>
        </header>
        {stale && <div className="sf-conn" role="alert" aria-label="Interfaz desactualizada" style={{ margin: '8px 24px 0' }}>{Icon.warn()}<span>Hay una versión nueva del Portal: esta pestaña usa la interfaz anterior y algunas acciones podrían no funcionar. </span><button className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>Recargar</button></div>}
        <SystemBar />
        <OwnerBar />
        <div id="contenido" tabIndex={-1} className="content-main">{children}</div>
      </div>
      {dialog && <CreateDialog kind={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

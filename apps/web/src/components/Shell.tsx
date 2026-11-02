import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import type { UsageToday } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { onBundleChange, staleInterface } from '../lib/liveStatus.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Chip, Icon, Notice, StatusIcon } from './ui.tsx';
import { SystemBar } from './SystemBar.tsx';
import { AssistantDock } from './AssistantDock.tsx';
import { useLive, useLiveConnection } from '../lib/live.ts';
import { useBack } from '../lib/nav.ts';

const SOON = [['Herramientas y MCP', Icon.plug]] as const;

/** Diálogo mínimo para crear empresa o proyecto (operación local, sin IA). */
function CreateDialog({ kind, onClose }: { kind: 'company' | 'project'; onClose: () => void }) {
  const { status, select, refreshStructure, flash, navigate } = useApp();
  const [name, setName] = useState(''); const [desc, setDesc] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (name.trim().length < 2) return; setBusy(true); setError(null);
    try {
      if (kind === 'company') { const ws = await api.createWorkspace(name.trim()); await refreshStructure(); await select(ws.slug, null); flash(`Empresa «${ws.name}» creada con sus 3 agentes de espacio (inactivos)`); navigate('/panel'); }
      else { const p = await api.createProject(status.workspace!.slug, name.trim(), desc.trim()); await select(status.workspace!.slug, p.id); flash(`Proyecto «${p.name}» creado con su equipo (inactivo)`); navigate('/panel'); }
      onClose();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <div className="backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" style={{ width: 'min(520px, 100%)' }}>
      <div className="modal-h"><div><div className="h3">{kind === 'company' ? 'Nueva empresa' : `Nuevo proyecto en ${status.workspace?.name}`}</div><div className="small muted">{kind === 'company' ? 'Espacio aislado con su propia base de datos y sus 3 agentes de espacio.' : 'Recibe su equipo de 5 agentes desde las plantillas aprobadas.'} No consume IA.</div></div><button className="xbtn" onClick={onClose} aria-label="Cerrar">{Icon.x(16)}</button></div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && <Notice kind="err">{error}</Notice>}
        <div><label className="label" htmlFor="cd-name">Nombre</label><input id="cd-name" className="input" value={name} onChange={e => setName(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') void create(); }} /></div>
        {kind === 'project' && <div><label className="label" htmlFor="cd-desc">Descripción</label><textarea id="cd-desc" className="input" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Qué se construye y para quién" /></div>}
      </div>
      <div className="modal-f"><span /><div style={{ display: 'flex', gap: 10 }}><button className="btn btn-ghost" onClick={onClose}>Cancelar</button><button className="btn btn-primary" onClick={create} disabled={busy || name.trim().length < 2}>{busy ? 'Creando…' : 'Crear'}</button></div></div>
    </div></div>;
}

const usageCache = new Map<string, UsageToday>();

export function Shell({ crumb, children }: { crumb: ReactNode; children: ReactNode }) {
  const { status, providers, workspaces, projects, select, navigate } = useApp();
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
  const connected = providers.filter(p => p.status === 'connected');
  // Pestaña abierta con una interfaz anterior a la que sirve ahora el Portal (reconstruido y reiniciado): sus acciones
  // pueden no existir o comportarse distinto. Se pide recargar en vez de seguir con botones obsoletos.
  // Móvil: el menú lateral se pliega (solo la empresa y «Menú») y se cierra al navegar.
  const [menu, setMenu] = useState(false);
  const path = useLocation().pathname;
  useEffect(() => { setMenu(false); }, [path]);
  const [stale, setStale] = useState(staleInterface());
  useEffect(() => onBundleChange(() => setStale(staleInterface())), []);

  return (
    <div className="screen shell">
      <aside className={`side${menu ? ' side-open' : ''}`}>
        <label className="sr" htmlFor="ws-select">Empresa</label>
        <div className="ws-btn" style={{ padding: '6px 8px 6px 10px', gap: 8 }}>
          <span className="mark" />
          <select id="ws-select" className="input" style={{ height: 34, border: 0, background: 'transparent', padding: '0 24px 0 4px', fontWeight: 600, fontSize: 13.5, flex: 1 }} value={ws.slug} onChange={e => { if (e.target.value === '__new') { setDialog('company'); return; } void select(e.target.value).then(() => navigate('/panel')); }}>
            {workspaces.map(w => <option key={w.slug} value={w.slug}>{w.name}{w.kind === 'internal' ? ' · espacio interno' : ''}</option>)}
            <option value="__new">＋ Nueva empresa…</option>
          </select>
        </div>
        <button type="button" className="btn btn-ghost btn-sm side-toggle" aria-expanded={menu} onClick={() => setMenu(v => !v)}>{menu ? 'Cerrar menú' : 'Menú'}</button>
        <div className="side-sec">Proyecto</div>
        <label className="sr" htmlFor="pj-select">Proyecto</label>
        <select id="pj-select" className="input" style={{ height: 36, fontSize: 13.5, fontWeight: 500, background: 'transparent', borderColor: 'transparent' }} value={project?.id ?? ''} onChange={e => { if (e.target.value === '__new') { setDialog('project'); return; } void select(ws.slug, e.target.value).then(() => navigate('/panel')); }}>
          {!project && <option value="">Sin proyecto</option>}
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          <option value="__new">＋ Nuevo proyecto…</option>
        </select>
        <div className="side-sec">Navegación</div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }} aria-label="Secciones">
          <NavLink className={({ isActive }) => `navi ${isActive ? 'is-active' : ''}`} to="/oficina">{Icon.org()}<span>Oficina</span></NavLink>
          <NavLink className={({ isActive }) => `navi ${isActive ? 'is-active' : ''}`} to="/asistente">{Icon.user(16)}<span>Asistente</span></NavLink>
          <NavLink className={({ isActive }) => `navi ${isActive ? 'is-active' : ''}`} to="/panel">{Icon.grid()}<span>Panel</span></NavLink>
          <NavLink className={({ isActive }) => `navi ${isActive ? 'is-active' : ''}`} to="/equipo">{Icon.users()}<span>Equipo de IA</span></NavLink>
          <NavLink className={({ isActive }) => `navi ${isActive ? 'is-active' : ''}`} to="/backlog">{Icon.inbox()}<span>Backlog</span></NavLink>
          <NavLink className={({ isActive }) => `navi ${isActive ? 'is-active' : ''}`} to="/lotes">{Icon.activity()}<span>Ejecución continua</span></NavLink>
          <NavLink className={({ isActive }) => `navi ${isActive ? 'is-active' : ''}`} to="/actividad">{Icon.activity()}<span>Actividad</span>{usage && usage.running > 0 && <span style={{ marginLeft: 'auto', display: 'inline-flex' }}><StatusIcon state="running" label={`${usage.running} en ejecución`} showLabel={false} /></span>}</NavLink>
          <NavLink className={({ isActive }) => `navi ${isActive ? 'is-active' : ''}`} to="/conocimiento">{Icon.book()}<span>Conocimiento</span></NavLink>
          <NavLink className={({ isActive }) => `navi ${isActive ? 'is-active' : ''}`} to="/presupuestos">{Icon.wallet()}<span>Presupuestos</span></NavLink>
          {SOON.map(([label, icon]) => <button key={label} className="navi" disabled>{icon()}<span>{label}</span><span className="soon">próx.</span></button>)}
        </nav>
        <div style={{ flex: 1 }} />
        <div className="side-sec">Proveedores</div>
        {connected.map(p => <Link key={p.id} className="navi" to="/configuracion/proveedor"><span className="dot dot-ok" aria-hidden="true" /><span style={{ flex: 1 }}>{p.name}</span><span className="small muted">conectado</span></Link>)}
        <Link className="navi" to="/configuracion/proveedor#claude-code">{Icon.plug()}<span style={{ flex: 1 }}>Claude Code — Local</span></Link>
        <Link className="navi" to="/configuracion/proveedor"><span className="dot" aria-hidden="true" /><span style={{ flex: 1 }}>Añadir proveedor</span></Link>
        <button className="navi" disabled>{Icon.gear()}<span>Configuración</span><span className="soon">próx.</span></button>
      </aside>
      <div className="content">
        <header className="top">
          <div className="top-left">
            {back && <button type="button" className="btn btn-ghost btn-sm back-global" onClick={back.go} aria-label={`Atrás: volver a ${back.label}`} title={`Volver a ${back.label} (como el botón Atrás del navegador)`}>{Icon.back()}<span className="back-label">{back.label}</span></button>}
            <nav className="crumbs" aria-label="Ubicación actual"><span>{ws.name}</span><span className="sep">/</span><span>{project?.name ?? 'Sin proyecto'}</span><span className="sep">/</span><span className="cur">{crumb}</span></nav>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {liveConn === 'down' && <span role="status" aria-label="Sin conexión en tiempo real: la pantalla se actualiza cada 15 s mientras tanto."><Chip tone="warn" xs>sin tiempo real</Chip></span>}
            <Chip dot={usage && usage.running > 0 ? 'pulse' : ''}>{usage && usage.running > 0 ? `${usage.running} proceso(s) en ejecución` : 'Sin procesos en ejecución'}</Chip>
            <Chip className="mono" >hoy · {usage?.calls ?? 0} llamadas · {usage?.tokens ?? 0} tokens · {fmtUsd(usage?.costUsd ?? 0)}</Chip>
            <span className="avatar" role="img" aria-label="Propietario">{Icon.user()}</span>
          </div>
        </header>
        {stale && <div className="sf-conn" role="alert" aria-label="Interfaz desactualizada" style={{ margin: '8px 24px 0' }}>{Icon.warn()}<span>Hay una versión nueva del Portal: esta pestaña usa la interfaz anterior y algunas acciones podrían no funcionar. </span><button className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>Recargar</button></div>}
        <SystemBar />
        {children}
      </div>
      <AssistantDock />
      {dialog && <CreateDialog kind={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

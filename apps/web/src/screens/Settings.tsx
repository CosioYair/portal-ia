import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { SystemStatus } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { osApi, type OfficeAgent } from '../lib/osApi.ts';
import { useApp } from '../lib/store.ts';
import { Shell, CreateDialog } from '../components/Shell.tsx';
import { Chip, Icon } from '../components/ui.tsx';
import { PageHeader, Tile } from '../components/kit.tsx';
import { INTERNAL_SLUG } from '../lib/routes.ts';
import { HarnessDialog } from '../components/HarnessDialog.tsx';
import { OwnerStatus, useOwner } from '../components/OwnerPairing.tsx';
import { ownerNeeded } from '../lib/owner.ts';
import { loadOwnerName, PortalSealPanel, saveOwnerName } from '../components/AgentConfigPanel.tsx';
import { OWNER_NAME_MAX } from '@portal-ia/domain';
import { LessonAutoImproveSettings } from '../components/LessonAutoImproveSettings.tsx';

/**
 * Ajustes (Portal IA 2.0): un sitio para lo que antes estaba repartido (proveedores en el pie del menú, motores en un
 * diálogo de la Oficina, el límite del Asistente en su ficha, empresas y proyectos en los selectores). Cada tarjeta dice a
 * qué afecta (todo el Portal, la empresa o el proyecto). Aquí solo se navega o se abren los diálogos de siempre, con sus
 * mismas confirmaciones.
 */
export function Settings() {
  const { status, workspaces, projects, providers } = useApp();
  const connected = providers.filter(p => p.status === 'connected');
  const [params, setParams] = useSearchParams();
  const ws = status.workspace!;
  const [sys, setSys] = useState<SystemStatus | null>(null);
  const [assistant, setAssistant] = useState<OfficeAgent | null>(null);
  // /ajustes?ver=motores abre directamente los Motores de IA (enlace desde la búsqueda y los avisos).
  const [dialog, setDialog] = useState<null | 'harness' | 'company' | 'project'>(() => params.get('ver') === 'motores' ? 'harness' : null);
  useEffect(() => { void api.systemStatus().then(setSys).catch(() => undefined); }, []);
  // El Asistente de Empresa es uno para todo el Portal: el de la empresa interna (el que contesta en «Pedir»).
  useEffect(() => { void osApi.office(INTERNAL_SLUG, null).then(o => setAssistant(o.agents.find(a => a.key === 'ws-asistente') ?? null)).catch(() => undefined); }, []);
  const owner = useOwner() === true;
  // EN-021 · «Tu nombre»: vacío por defecto; solo sale de este ajuste (nunca del correo). Guardar no tiene coste.
  const [ownerName, setOwnerName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [nameState, setNameState] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>('loading');
  const [nameError, setNameError] = useState<string | null>(null);
  useEffect(() => { void loadOwnerName().then(n => { setOwnerName(n); setSavedName(n); setNameState('idle'); }).catch((e: Error) => { setNameError(e.message); setNameState('error'); }); }, []);
  const submitName = () => {
    setNameState('saving'); setNameError(null);
    saveOwnerName(ownerName.trim()).then(n => { setOwnerName(n); setSavedName(n); setNameState('saved'); }).catch((e: Error) => { setNameError(e.message); setNameState('error'); });
  };
  const card = (icon: ReactNode, title: string, scope: string, body: ReactNode, action: ReactNode) => <section className="card settings-card">
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><Tile icon={icon} tone="settings" /><div style={{ flex: 1, minWidth: 0 }}><h2 className="h3" style={{ margin: 0 }}>{title}</h2><Chip xs>{scope}</Chip></div></div>
    <div className="small med">{body}</div>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>{action}</div>
  </section>;
  return <Shell crumb="Ajustes">
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader icon={Icon.sliders(22)} tone="settings" eyebrow={ws.name} title="Ajustes" description="Motores de IA, presupuestos, el Asistente, empresas y proyectos, y el estado del Portal." />
      <div className="settings-grid">
        {card(Icon.plug(), 'Proveedores y Claude Code', 'Todo el Portal',
          <>Conectados: {connected.length ? connected.map((p, i) => <span key={p.id}>{i ? ', ' : ''}<strong>{p.name}</strong></span>) : 'ninguno'}. Claude Code con tu suscripción: comprobación, límites, proyectos autorizados y consolas.</>,
          <><Link className="btn btn-secondary btn-sm" to="/configuracion/proveedor">Proveedores</Link><Link className="btn btn-ghost btn-sm" to="/configuracion/proveedor#claude-code">Claude Code</Link></>)}
        {card(Icon.bolt(), 'Motores de IA (arneses)', 'Todo el Portal',
          <>Qué motores hay y si están disponibles; Codex se comprueba y se habilita aquí. El motor de cada agente se elige en su panel › Ajustes.</>,
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog('harness')}>Ver motores</button>)}
        {card(Icon.wallet(), 'Presupuestos', status.project ? `Empresa y proyecto «${status.project.name}»` : 'Empresa',
          <>Cuánto se puede gastar en la API y cuánto queda. El trabajo con tu suscripción no gasta de la API.</>,
          <Link className="btn btn-secondary btn-sm" to="/presupuestos">Abrir Presupuestos</Link>)}
        {card(Icon.sparkles(), 'Asistente de Empresa', 'Todo el Portal · vive en «Portal IA»',
          <>{assistant ? <>Trabaja con <strong>{assistant.harnessLabel}</strong>. Su modelo, su límite mensual y sus permisos están en su configuración.</> : 'Su modelo, su límite mensual y sus permisos están en su configuración.'}</>,
          assistant ? <><Link className="btn btn-secondary btn-sm" to={`/empresa/${INTERNAL_SLUG}/oficina/agente/${encodeURIComponent(assistant.id)}/configuracion`}>Configurar</Link><Link className="btn btn-ghost btn-sm" to={`/empresa/${INTERNAL_SLUG}/equipo/${encodeURIComponent(assistant.id)}`}>Ajustes avanzados</Link></> : <Link className="btn btn-ghost btn-sm" to="/asistente">Abrir el Asistente</Link>)}
        {card(Icon.building(), 'Empresas y proyectos', 'Todo el Portal',
          <>{workspaces.length} empresa{workspaces.length === 1 ? '' : 's'} (cada una aislada, con su propia base de datos) · {projects.length} proyecto{projects.length === 1 ? '' : 's'} en «{ws.name}». Crear no consume IA.</>,
          <><button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog('project')}>{Icon.plus()} Proyecto</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setDialog('company')}>{Icon.plus()} Empresa</button></>)}
        {card(Icon.sparkles(), 'Tu nombre', 'Todo el Portal',
          <>
            <label htmlFor="owner-name" style={{ display: 'block', marginBottom: 4 }}>Cómo te llaman los agentes al presentarse. Si lo dejas vacío, te lo preguntan una vez. Nunca se toma de tu correo.</label>
            <input id="owner-name" className="input" type="text" value={ownerName} maxLength={OWNER_NAME_MAX} disabled={nameState === 'loading' || nameState === 'saving'} placeholder="Vacío: el agente te lo pregunta" onChange={e => { setOwnerName(e.target.value); if (nameState === 'saved' || nameState === 'error') setNameState('idle'); }} />
            <p role="status" aria-live="polite" style={{ margin: '4px 0 8px' }}>{nameState === 'loading' ? 'Cargando…' : nameState === 'saving' ? 'Guardando…' : nameState === 'saved' ? 'Guardado.' : nameState === 'error' ? `Error: ${nameError ?? 'no se pudo guardar.'}` : null}</p>
            <PortalSealPanel ownerName={savedName} />
          </>,
          <button type="button" className="btn btn-secondary btn-sm" disabled={nameState === 'loading' || nameState === 'saving' || ownerName.trim() === savedName} onClick={submitName}>{nameState === 'saving' ? 'Guardando…' : 'Guardar nombre'}</button>)}
        {card(Icon.sparkles(), 'Mejora automática de lecciones', `Empresa «${ws.name}» · con costo · desactivada por defecto`,
          <LessonAutoImproveSettings slug={ws.slug} />,
          <Link className="btn btn-ghost btn-sm" to="/autorizaciones">Ver mejoras pendientes en Decisiones</Link>)}
        {card(Icon.shield(), 'Propietario', 'Este navegador',
          owner ? <>Este navegador está vinculado como propietario: puede hacer cambios (autorizar, integrar, cerrar, configurar). La sesión dura 7 días desde el último uso.</> : <>Sin vincular puedes consultarlo todo; para hacer cambios, vincula este navegador con un código de un solo uso (la vinculación dura 7 días desde el último uso).</>,
          owner ? <OwnerStatus /> : <button type="button" className="btn btn-secondary btn-sm" onClick={() => ownerNeeded()}>Vincular este navegador</button>)}
        {card(Icon.gear(), 'Sistema', 'Este equipo',
          sys ? <>Portal IA {sys.version} · en marcha <span className="mono">{sys.startCommit ?? '—'}</span> · interfaz <span className="mono">{sys.buildCommit ?? '—'}</span>{sys.sandbox ? <> · sandbox: {sys.sandbox.detail}</> : null}. Cuando hay una actualización, la barra de sistema aparece arriba en todas las pantallas.</> : 'Cargando el estado del Portal…',
          <Link className="btn btn-ghost btn-sm" to="/panel">Repositorio (en el Resumen del proyecto)</Link>)}
      </div>
    </main>
    {dialog === 'harness' && <HarnessDialog onClose={() => { setDialog(null); if (params.get('ver')) setParams({}, { replace: true }); }} />}
    {(dialog === 'company' || dialog === 'project') && <CreateDialog kind={dialog} onClose={() => setDialog(null)} />}
  </Shell>;
}

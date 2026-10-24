import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import type { AssistantInfo } from '../lib/api.ts';
import { Icon } from './ui.tsx';
import { AssistantChat } from './AssistantChat.tsx';

/** Asistente siempre visible: botón flotante con contador de propuestas pendientes y panel lateral con el chat. */
export function AssistantDock() {
  const loc = useLocation();
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('portal-ia.dock') === '1'; } catch { return false; } });
  const [pending, setPending] = useState(0);
  const [info, setInfo] = useState<AssistantInfo | null>(null);
  const [wide, setWide] = useState(() => { try { return localStorage.getItem('portal-ia.dock.wide') === '1'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('portal-ia.dock.wide', wide ? '1' : '0'); } catch { /* sin almacenamiento */ } }, [wide]);
  useEffect(() => { try { localStorage.setItem('portal-ia.dock', open ? '1' : '0'); } catch { /* sin almacenamiento */ } }, [open]);
  if (loc.pathname.startsWith('/asistente') || loc.pathname.endsWith('/asistente')) return null; // la pantalla completa ya lo muestra
  // Se monta en <body> (portal) para que position:fixed sea relativo a la ventana y no a un contenedor animado.
  return createPortal(<>
    {open && <div className={`dock${wide ? ' dock-wide' : ''}`} role="dialog" aria-label="Asistente de Empresa">
      <div className="dock-h"><div><div className="h3" style={{ fontSize: 14 }}>{info?.name ?? 'Asistente de Empresa'}</div><div className="small muted">Siempre disponible · {info ? <span className="mono">{info.model}</span> : '…'}</div></div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setWide(v => !v)} title={wide ? 'Panel estrecho' : 'Panel ancho'} aria-label={wide ? 'Panel estrecho' : 'Panel ancho'}>{wide ? '⇥ estrecho' : '⇤ ancho'}</button>
          <button className="xbtn" onClick={() => setOpen(false)} aria-label="Cerrar asistente">{Icon.x(16)}</button>
        </div></div>
      <AssistantChat compact onInfo={setInfo} onPending={setPending} />
    </div>}
    <button className="dock-fab" onClick={() => setOpen(v => !v)} aria-label={open ? 'Ocultar asistente' : 'Abrir asistente'} title="Asistente de Empresa">
      {Icon.user()}<span>Asistente</span>{pending > 0 && <span className="dock-badge">{pending}</span>}
    </button>
  </>, document.body);
}

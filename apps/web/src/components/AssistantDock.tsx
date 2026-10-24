import { useEffect, useState } from 'react';
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
  useEffect(() => { try { localStorage.setItem('portal-ia.dock', open ? '1' : '0'); } catch { /* sin almacenamiento */ } }, [open]);
  if (loc.pathname.startsWith('/asistente') || loc.pathname.endsWith('/asistente')) return null; // la pantalla completa ya lo muestra
  return <>
    {open && <div className="dock" role="dialog" aria-label="Asistente de Empresa">
      <div className="dock-h"><div><div className="h3" style={{ fontSize: 14 }}>{info?.name ?? 'Asistente de Empresa'}</div><div className="small muted">Siempre disponible · {info ? <span className="mono">{info.model}</span> : '…'}</div></div><button className="xbtn" onClick={() => setOpen(false)} aria-label="Cerrar asistente">{Icon.x(16)}</button></div>
      <AssistantChat compact onInfo={setInfo} onPending={setPending} />
    </div>}
    <button className="dock-fab" onClick={() => setOpen(v => !v)} aria-label={open ? 'Ocultar asistente' : 'Abrir asistente'} title="Asistente de Empresa">
      {Icon.user()}<span>Asistente</span>{pending > 0 && <span className="dock-badge">{pending}</span>}
    </button>
  </>;
}

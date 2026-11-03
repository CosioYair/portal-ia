import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AssistantInfo } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { setAssistantPending, useUiEvent } from '../lib/uiBus.ts';
import { Icon } from './ui.tsx';
import { AssistantChat } from './AssistantChat.tsx';

/**
 * Asistente siempre a mano (Portal IA 2.0): se abre desde «Pedir» en la barra superior (ya no hay botón flotante que tape
 * contenido) y su número de propuestas pendientes aparece en la barra. En la pantalla completa del Asistente, «Pedir»
 * lleva el foco a su caja de mensaje.
 */
export function AssistantDock() {
  const loc = useLocation(); const navigate = useNavigate();
  const { status } = useApp(); const slug = status.workspace?.slug ?? '';
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('portal-ia.dock') === '1'; } catch { return false; } });
  const [info, setInfo] = useState<AssistantInfo | null>(null);
  const [wide, setWide] = useState(() => { try { return localStorage.getItem('portal-ia.dock.wide') === '1'; } catch { return false; } });
  const opener = useRef<Element | null>(null); const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem('portal-ia.dock.wide', wide ? '1' : '0'); } catch { /* sin almacenamiento */ } }, [wide]);
  useEffect(() => { try { localStorage.setItem('portal-ia.dock', open ? '1' : '0'); } catch { /* sin almacenamiento */ } }, [open]);
  const onAssistantPage = loc.pathname.startsWith('/asistente') || loc.pathname.endsWith('/asistente');
  useUiEvent('assistant', useCallback(() => {
    if (onAssistantPage) { (document.querySelector('.assist textarea, textarea') as HTMLTextAreaElement | null)?.focus(); return; }
    opener.current = document.activeElement; setOpen(true);
  }, [onAssistantPage]));
  // Al abrir, el foco va al panel; al cerrar, vuelve a donde estaba. Esc cierra.
  useEffect(() => { if (open) requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>('textarea') ?? panel.current?.querySelector<HTMLElement>('button'))?.focus()); }, [open]);
  const close = () => { setOpen(false); (opener.current as HTMLElement | null)?.focus?.(); };
  const onPending = useCallback((n: number) => setAssistantPending(n), []);
  useEffect(() => { if (!open) return; document.body.classList.add(wide ? 'has-dock-wide' : 'has-dock'); return () => document.body.classList.remove('has-dock', 'has-dock-wide'); }, [open, wide]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key !== 'Escape' || e.defaultPrevented) return; const el = document.activeElement as HTMLElement | null; if (el?.closest('.agent-panel, .cmdk, .modal, .side-open')) return; close(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (onAssistantPage) return null; // la pantalla completa ya lo muestra
  // Se monta en <body> (portal) para que position:fixed sea relativo a la ventana y no a un contenedor animado.
  return createPortal(<>
    {open && <div ref={panel} className={`dock${wide ? ' dock-wide' : ''}`} role="dialog" aria-label="Asistente de Empresa" aria-modal={window.innerWidth < 768 || undefined} onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab' || window.innerWidth >= 768 || !panel.current) return;
      const f = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])')].filter(x => x.offsetParent !== null);
      if (!f.length) return; const a = f[0]; const z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    }}>
      <div className="dock-h"><div><div className="h3" style={{ fontSize: 14 }}>{info?.name ?? 'Asistente de Empresa'}</div><div className="small muted">Global · {info ? <span className="mono" style={{ whiteSpace: 'nowrap' }}>{info.model}</span> : '…'}</div></div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/asistente')} title="Abrir en pantalla completa">{Icon.external()}<span className="sr-only">Abrir en pantalla completa</span></button>
          <button className="btn btn-ghost btn-sm" onClick={() => setWide(v => !v)} title={wide ? 'Panel estrecho' : 'Panel ancho'} aria-label={wide ? 'Panel estrecho' : 'Panel ancho'} aria-pressed={wide}>{wide ? Icon.panelNarrow() : Icon.panelWide()}</button>
          <button className="xbtn" onClick={close} aria-label="Cerrar asistente">{Icon.x(16)}</button>
        </div></div>
      <AssistantChat compact onInfo={setInfo} onPending={onPending} />
    </div>}
  </>, document.body);
}

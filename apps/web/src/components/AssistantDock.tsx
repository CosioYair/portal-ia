import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AssistantInfo } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { setAssistantPending, useUiEvent } from '../lib/uiBus.ts';
import { askAction, bodyClass, dockVisible, isAssistantPath } from '../lib/dockLayer.ts';
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
  const onAssistantPage = isAssistantPath(loc.pathname);
  // EN-004: «front» es falso cuando el usuario trabaja en el panel de agente (el Asistente cede y queda detrás);
  // «focusTick» hace que «Pedir» enfoque aunque el panel ya estuviera abierto.
  const [front, setFront] = useState(true); const [focusTick, setFocusTick] = useState(0);
  const visible = dockVisible({ open, onAssistantPage, yielded: !front });
  useUiEvent('assistant', useCallback(() => {
    const action = askAction({ onAssistantPage, open });
    if (action === 'focus-fullscreen') { document.querySelector<HTMLTextAreaElement>('.assist textarea')?.focus(); return; }
    if (action === 'open') opener.current = document.activeElement;
    setOpen(true); setFront(true); setFocusTick(t => t + 1);
  }, [onAssistantPage, open]));
  // Al abrir (o al pulsar «Pedir» con el panel ya abierto), el foco va al panel; al cerrar, vuelve a donde estaba. Esc cierra.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>('textarea') ?? panel.current?.querySelector<HTMLElement>('button'))?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, focusTick]);
  const close = () => { setOpen(false); setFront(true); (opener.current as HTMLElement | null)?.focus?.(); };
  const onPending = useCallback((n: number) => setAssistantPending(n), []);
  // La reserva de espacio existe solo mientras el panel se ve: se quita al cerrar, en /asistente, al ceder y al desmontar.
  useEffect(() => {
    const c = bodyClass({ visible, wide }); if (c) document.body.classList.add(c);
    return () => document.body.classList.remove('has-dock', 'has-dock-wide');
  }, [visible, wide]);
  // Capas junto al panel de agente: pulsar o enfocar dentro de él hace que el Asistente ceda; dentro del Asistente, lo trae
  // al frente. Si el panel de agente desaparece, el Asistente vuelve al frente.
  useEffect(() => {
    if (!open || onAssistantPage) return;
    const onIn = (e: Event) => {
      const t = e.target as Element | null; if (!t || typeof t.closest !== 'function') return;
      if (t.closest('.agent-panel')) setFront(false); else if (t.closest('.dock')) setFront(true);
    };
    document.addEventListener('pointerdown', onIn, true); document.addEventListener('focusin', onIn, true);
    const mo = new MutationObserver(() => { if (!document.querySelector('.agent-panel')) setFront(true); });
    mo.observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] });
    return () => { document.removeEventListener('pointerdown', onIn, true); document.removeEventListener('focusin', onIn, true); mo.disconnect(); };
  }, [open, onAssistantPage]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key !== 'Escape' || e.defaultPrevented) return; const el = document.activeElement as HTMLElement | null; if (el?.closest('.agent-panel, .cmdk, .modal, .side-open')) return; close(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (onAssistantPage) return null; // la pantalla completa ya lo muestra
  // Se monta en <body> (portal) para que position:fixed sea relativo a la ventana y no a un contenedor animado.
  return createPortal(<>
    {open && <div ref={panel} className={`dock${wide ? ' dock-wide' : ''}${front ? '' : ' dock-behind'}`} role="dialog" aria-label="Asistente de Empresa" aria-modal={window.innerWidth < 768 || undefined} onKeyDown={e => {
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

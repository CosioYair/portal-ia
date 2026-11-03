import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './ui.tsx';

/**
 * Diálogo modal compartido (Portal IA 2.0: fuera de la Oficina para que cualquier pantalla lo use sin cargarla): foco al
 * primer campo, Tab atrapado, Esc cierra solo el de arriba y el foco vuelve a quien lo abrió.
 */
export function Modal({ title, children, footer, onClose, wide }: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void; wide?: boolean }) {
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

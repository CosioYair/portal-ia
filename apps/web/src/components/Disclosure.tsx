import type { ReactNode } from 'react';

/**
 * HU-163 · Sección plegable accesible basada en <details>/<summary> nativos.
 * Uso: cerrada por defecto; solo se abre de inicio si se pide expresamente con defaultOpen.
 * El navegador gestiona el teclado (Tab para enfocar, Intro o Espacio para abrir y cerrar)
 * y anuncia el estado expandido. No añade dependencias.
 */
export function Disclosure({ id, title, hint, defaultOpen = false, className, testId, children }: {
  /** HU-195 · id opcional del <details>: permite abrir y localizar la sección desde el hash (#) o desde una acción. */
  id?: string;
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  /** HU-201 · Clases extra que se suman a «disclosure» (opcional; sin ellas el marcado no cambia). */
  className?: string;
  /** HU-201 · Se pone en data-testid del <details> (opcional). */
  testId?: string;
  children: ReactNode;
}) {
  return (
    <details id={id} className={className ? `disclosure ${className}` : 'disclosure'} open={defaultOpen ? true : undefined} data-testid={testId}>
      <summary className="disclosure-summary">
        <span className="disclosure-marker" aria-hidden="true" />
        <span className="disclosure-text">
          <span className="disclosure-title">{title}</span>
          {hint && <span className="disclosure-hint">{hint}</span>}
        </span>
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

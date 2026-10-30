import type { ReactNode } from 'react';

/**
 * HU-163 · Sección plegable accesible basada en <details>/<summary> nativos.
 * Uso: cerrada por defecto; solo se abre de inicio si se pide expresamente con defaultOpen.
 * El navegador gestiona el teclado (Tab para enfocar, Intro o Espacio para abrir y cerrar)
 * y anuncia el estado expandido. No añade dependencias.
 */
export function Disclosure({ title, hint, defaultOpen = false, children }: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="disclosure" open={defaultOpen ? true : undefined}>
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

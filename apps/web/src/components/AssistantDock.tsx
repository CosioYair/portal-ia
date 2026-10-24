import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { AssistantChat } from './AssistantChat.tsx';
import { useAsistente } from './AssistantProvider.tsx';
import './AssistantDock.css';

/**
 * Botón flotante fijo y panel del asistente. Debe renderizarse fuera del outlet de rutas,
 * dentro de AssistantProvider, para estar presente en todas las pantallas sin remontarse.
 * Minimizar solo oculta el panel (atributo hidden): no desmonta ni navega ni recarga.
 */
export function AssistantDock() {
  const { abierto, ocupado, abrir, minimizar } = useAsistente();
  const botonRef = useRef<HTMLButtonElement | null>(null);
  const campoRef = useRef<HTMLTextAreaElement | null>(null);
  const abiertoAnterior = useRef(abierto);

  // Gestión de foco: al abrir, al campo de texto; al cerrar, de vuelta al botón.
  useEffect(() => {
    if (abiertoAnterior.current === abierto) {
      return;
    }
    abiertoAnterior.current = abierto;
    if (abierto) {
      campoRef.current?.focus();
    } else {
      botonRef.current?.focus();
    }
  }, [abierto]);

  const alPulsarTecla = (evento: KeyboardEvent<HTMLElement>) => {
    if (evento.key === 'Escape') {
      evento.stopPropagation();
      minimizar();
    }
  };

  const etiquetaBoton = abierto
    ? 'Minimizar asistente'
    : ocupado
      ? 'Abrir asistente (hay una petición en curso)'
      : 'Abrir asistente';

  return (
    <div className="asistente-dock">
      <section
        id="asistente-panel"
        className="asistente-dock__panel"
        role="dialog"
        aria-modal="false"
        aria-label="Asistente"
        hidden={!abierto}
        onKeyDown={alPulsarTecla}
      >
        <header className="asistente-dock__cabecera">
          <h2 className="asistente-dock__titulo">Asistente</h2>
          <button type="button" className="asistente-dock__minimizar" onClick={minimizar}>
            Minimizar
          </button>
        </header>
        <div className="asistente-dock__cuerpo">
          <AssistantChat campoRef={campoRef} />
        </div>
      </section>

      <button
        ref={botonRef}
        type="button"
        className="asistente-dock__boton"
        aria-label={etiquetaBoton}
        aria-expanded={abierto}
        aria-controls="asistente-panel"
        onClick={abierto ? minimizar : abrir}
      >
        <svg
          className="asistente-dock__icono"
          viewBox="0 0 24 24"
          width="24"
          height="24"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
            fill="currentColor"
          />
        </svg>
        {ocupado && !abierto ? (
          <span className="asistente-dock__indicador" aria-hidden="true" />
        ) : null}
      </button>
    </div>
  );
}

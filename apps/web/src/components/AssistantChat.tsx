import { useEffect, useRef } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { useAsistente } from './AssistantProvider.tsx';

export interface AssistantChatProps {
  /** Referencia al campo de texto, para que el contenedor gestione el foco. */
  readonly campoRef: RefObject<HTMLTextAreaElement | null>;
}

/** Vista de chat presentacional: todo el estado vive en AssistantProvider. */
export function AssistantChat({ campoRef }: AssistantChatProps) {
  const {
    mensajes,
    borrador,
    estado,
    ocupado,
    cambiarBorrador,
    solicitarEnvio,
    autorizarEnvio,
    cancelarEnvio,
    descartarError
  } = useAsistente();

  const listaRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    const lista = listaRef.current;
    if (lista !== null) {
      lista.scrollTop = lista.scrollHeight;
    }
  }, [mensajes.length, estado.tipo]);

  const alPulsarTecla = (evento: KeyboardEvent<HTMLTextAreaElement>) => {
    if (evento.key === 'Enter' && !evento.shiftKey && !evento.nativeEvent.isComposing) {
      evento.preventDefault();
      solicitarEnvio();
    }
  };

  return (
    <div className="asistente-chat">
      <ul
        ref={listaRef}
        className="asistente-chat__mensajes"
        role="log"
        aria-live="polite"
        aria-label="Conversación con el asistente"
      >
        {mensajes.length === 0 ? (
          <li className="asistente-chat__vacio">
            Aún no hay mensajes. Escribe tu consulta para empezar.
          </li>
        ) : (
          mensajes.map((mensaje) => (
            <li
              key={mensaje.id}
              className={`asistente-chat__mensaje asistente-chat__mensaje--${mensaje.rol}`}
            >
              <span className="asistente-chat__autor">
                {mensaje.rol === 'usuario' ? 'Tú' : 'Asistente'}
              </span>
              <span className="asistente-chat__texto">{mensaje.texto}</span>
            </li>
          ))
        )}
      </ul>

      {estado.tipo === 'esperando_autorizacion' ? (
        <div className="asistente-chat__aviso" role="group" aria-label="Autorización de envío">
          <p>
            Enviar este mensaje usa el modelo de IA y puede generar un coste. ¿Autorizas el envío?
          </p>
          <div className="asistente-chat__acciones">
            <button type="button" onClick={() => void autorizarEnvio()}>
              Autorizar y enviar
            </button>
            <button type="button" onClick={cancelarEnvio}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      {estado.tipo === 'enviando' ? (
        <p className="asistente-chat__estado" role="status">
          El asistente está respondiendo…
        </p>
      ) : null}

      {estado.tipo === 'error' ? (
        <div className="asistente-chat__error" role="alert">
          <p>{estado.mensaje}</p>
          <button type="button" onClick={descartarError}>
            Descartar
          </button>
        </div>
      ) : null}

      <form
        className="asistente-chat__formulario"
        onSubmit={(evento) => {
          evento.preventDefault();
          solicitarEnvio();
        }}
      >
        <textarea
          ref={campoRef}
          className="asistente-chat__campo"
          aria-label="Mensaje para el asistente"
          placeholder="Escribe tu mensaje…"
          rows={2}
          value={borrador}
          onChange={(evento) => cambiarBorrador(evento.target.value)}
          onKeyDown={alPulsarTecla}
        />
        <button type="submit" disabled={ocupado || borrador.trim() === ''}>
          Enviar
        </button>
      </form>
    </div>
  );
}

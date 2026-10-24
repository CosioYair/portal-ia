import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type RolMensajeAsistente = 'usuario' | 'asistente';

export interface MensajeAsistente {
  readonly id: string;
  readonly rol: RolMensajeAsistente;
  readonly texto: string;
}

/** Estado explícito de la petición al asistente. */
export type EstadoPeticionAsistente =
  | { readonly tipo: 'inactivo' }
  | { readonly tipo: 'esperando_autorizacion'; readonly texto: string }
  | { readonly tipo: 'enviando' }
  | { readonly tipo: 'error'; readonly mensaje: string };

/**
 * Función de envío existente del asistente (cliente HTTP / servicio actual).
 * Recibe el historial previo y el texto nuevo, y devuelve el texto de la respuesta.
 * Debe lanzar un Error con mensaje en español si falla.
 */
export type EnviarMensajeAsistente = (
  historial: readonly MensajeAsistente[],
  texto: string
) => Promise<string>;

export interface AsistenteContextValue {
  readonly abierto: boolean;
  readonly mensajes: readonly MensajeAsistente[];
  readonly borrador: string;
  readonly estado: EstadoPeticionAsistente;
  /** Verdadero mientras se espera autorización o se está enviando (bloquea dobles envíos). */
  readonly ocupado: boolean;
  readonly abrir: () => void;
  readonly minimizar: () => void;
  readonly cambiarBorrador: (texto: string) => void;
  /** Pide autorización para enviar el borrador. No ejecuta ninguna llamada con coste. */
  readonly solicitarEnvio: () => void;
  /** Gesto explícito del usuario: autoriza y ejecuta el envío pendiente. */
  readonly autorizarEnvio: () => Promise<void>;
  readonly cancelarEnvio: () => void;
  readonly descartarError: () => void;
}

const INACTIVO: EstadoPeticionAsistente = { tipo: 'inactivo' };

const AsistenteContext = createContext<AsistenteContextValue | null>(null);

export interface AssistantProviderProps {
  readonly enviar: EnviarMensajeAsistente;
  readonly children: ReactNode;
}

/**
 * Proveedor del asistente. Debe montarse por encima del enrutador para que la conversación,
 * el borrador y las peticiones en curso sobrevivan a la navegación.
 */
export function AssistantProvider({ enviar, children }: AssistantProviderProps) {
  const [abierto, setAbierto] = useState(false);
  const [mensajes, setMensajes] = useState<readonly MensajeAsistente[]>([]);
  const [borrador, setBorrador] = useState('');
  const [estado, setEstado] = useState<EstadoPeticionAsistente>(INACTIVO);

  // Réplicas síncronas para evitar condiciones de carrera (doble clic, cierres obsoletos).
  const estadoRef = useRef<EstadoPeticionAsistente>(INACTIVO);
  const mensajesRef = useRef<readonly MensajeAsistente[]>([]);
  const borradorRef = useRef('');
  const contadorRef = useRef(0);

  const cambiarEstado = useCallback((siguiente: EstadoPeticionAsistente) => {
    estadoRef.current = siguiente;
    setEstado(siguiente);
  }, []);

  const cambiarMensajes = useCallback(
    (actualizar: (previos: readonly MensajeAsistente[]) => readonly MensajeAsistente[]) => {
      mensajesRef.current = actualizar(mensajesRef.current);
      setMensajes(mensajesRef.current);
    },
    []
  );

  const fijarBorrador = useCallback((texto: string) => {
    borradorRef.current = texto;
    setBorrador(texto);
  }, []);

  const abrir = useCallback(() => setAbierto(true), []);
  const minimizar = useCallback(() => setAbierto(false), []);

  const solicitarEnvio = useCallback(() => {
    const texto = borradorRef.current.trim();
    if (texto === '') {
      return;
    }
    const actual = estadoRef.current.tipo;
    if (actual === 'enviando' || actual === 'esperando_autorizacion') {
      return;
    }
    cambiarEstado({ tipo: 'esperando_autorizacion', texto });
  }, [cambiarEstado]);

  const cancelarEnvio = useCallback(() => {
    if (estadoRef.current.tipo === 'esperando_autorizacion') {
      cambiarEstado(INACTIVO);
    }
  }, [cambiarEstado]);

  const descartarError = useCallback(() => {
    if (estadoRef.current.tipo === 'error') {
      cambiarEstado(INACTIVO);
    }
  }, [cambiarEstado]);

  const autorizarEnvio = useCallback(async () => {
    const actual = estadoRef.current;
    if (actual.tipo !== 'esperando_autorizacion') {
      return;
    }
    const texto = actual.texto;
    const historial = mensajesRef.current;
    contadorRef.current += 1;
    const mensajeUsuario: MensajeAsistente = {
      id: `m-${contadorRef.current}`,
      rol: 'usuario',
      texto
    };

    cambiarMensajes((previos) => [...previos, mensajeUsuario]);
    if (borradorRef.current.trim() === texto) {
      fijarBorrador('');
    }
    cambiarEstado({ tipo: 'enviando' });

    try {
      const respuesta = await enviar(historial, texto);
      contadorRef.current += 1;
      const mensajeAsistente: MensajeAsistente = {
        id: `m-${contadorRef.current}`,
        rol: 'asistente',
        texto: respuesta
      };
      cambiarMensajes((previos) => [...previos, mensajeAsistente]);
      cambiarEstado(INACTIVO);
    } catch (causa) {
      // Se revierte el mensaje y se recupera el borrador para poder reintentar sin duplicar.
      cambiarMensajes((previos) => previos.filter((m) => m.id !== mensajeUsuario.id));
      if (borradorRef.current === '') {
        fijarBorrador(texto);
      }
      cambiarEstado({
        tipo: 'error',
        mensaje:
          causa instanceof Error && causa.message !== ''
            ? causa.message
            : 'No se pudo obtener la respuesta del asistente.'
      });
    }
  }, [cambiarEstado, cambiarMensajes, enviar, fijarBorrador]);

  const ocupado = estado.tipo === 'enviando' || estado.tipo === 'esperando_autorizacion';

  const valor = useMemo<AsistenteContextValue>(
    () => ({
      abierto,
      mensajes,
      borrador,
      estado,
      ocupado,
      abrir,
      minimizar,
      cambiarBorrador: fijarBorrador,
      solicitarEnvio,
      autorizarEnvio,
      cancelarEnvio,
      descartarError
    }),
    [
      abierto,
      mensajes,
      borrador,
      estado,
      ocupado,
      abrir,
      minimizar,
      fijarBorrador,
      solicitarEnvio,
      autorizarEnvio,
      cancelarEnvio,
      descartarError
    ]
  );

  return <AsistenteContext.Provider value={valor}>{children}</AsistenteContext.Provider>;
}

export function useAsistente(): AsistenteContextValue {
  const contexto = useContext(AsistenteContext);
  if (contexto === null) {
    throw new Error('useAsistente debe usarse dentro de AssistantProvider.');
  }
  return contexto;
}

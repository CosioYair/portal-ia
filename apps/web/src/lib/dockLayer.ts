/**
 * EN-004 · Reglas puras (sin DOM) del panel flotante del Asistente: cuándo se ve, qué clase lleva <body> para reservar su
 * espacio, qué hace «Pedir» y en qué capa queda. AssistantDock las aplica; la prueba de regresión las comprueba sin navegador.
 *
 * Orden de capas al nivel de <body> (.shell crea su propio contexto con z-index 0, así que el menú lateral no compite):
 *   contenido < fondo del panel de agente (59) < panel de agente (60) < Asistente (DOCK_Z = 65; DOCK_Z_BEHIND = 58 si cede)
 *   < diálogos .os-portal (70) < búsqueda Ctrl+K (80) < avisos (90).
 */

/** z-index del panel del Asistente al frente: sobre el panel de agente (60) y bajo los diálogos (.os-portal, 70). */
export const DOCK_Z = 65;
/** z-index cuando el usuario trabaja en el panel de agente: el Asistente queda detrás (bajo su fondo, 59). «Pedir» lo trae al frente. */
export const DOCK_Z_BEHIND = 58;

export type AskAction = 'focus-fullscreen' | 'open' | 'front-focus';

/** Pantalla completa del Asistente (/asistente, /asistente/…, /empresa/<x>/asistente): allí el panel no se monta. */
export function isAssistantPath(pathname: string): boolean {
  return pathname.startsWith('/asistente') || pathname.endsWith('/asistente');
}

/** El panel se ve si está abierto, no estamos en la pantalla completa y no ha cedido el frente a otra capa. */
export function dockVisible(s: { open: boolean; onAssistantPage: boolean; yielded?: boolean }): boolean {
  return s.open && !s.onAssistantPage && !s.yielded;
}

/** Clase de <body> que reserva el espacio del panel: solo si se ve; nunca sin panel visible. */
export function bodyClass(s: { visible: boolean; wide: boolean }): 'has-dock' | 'has-dock-wide' | null {
  if (!s.visible) return null;
  return s.wide ? 'has-dock-wide' : 'has-dock';
}

/**
 * ¿Puede el Asistente ceder el frente al panel de agente? Solo si este NO es modal (≥1280 px, sin .agent-panel-scrim).
 * Por debajo de 1280 px el panel de agente es modal: su fondo (59) cubre también «Pedir», así que si el Asistente bajara a 58
 * no habría forma de recuperarlo. Allí el Asistente se queda delante (65); para usar el panel de agente se cierra (X o Esc).
 */
export function canYield(s: { agentModal: boolean }): boolean {
  return !s.agentModal;
}

/** «Pedir» nunca se queda sin efecto: enfoca la pantalla completa, abre el panel o lo trae al frente y lo enfoca. */
export function askAction(s: { onAssistantPage: boolean; open: boolean }): AskAction {
  if (s.onAssistantPage) return 'focus-fullscreen';
  return s.open ? 'front-focus' : 'open';
}

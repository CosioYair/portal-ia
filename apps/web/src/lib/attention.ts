/**
 * Tipos y filtros de los avisos en vivo SIN dependencias del navegador (ni EventSource ni document), para que también
 * los puedan importar las pruebas del servidor. lib/live.ts los vuelve a exportar.
 */
export interface LiveChange { ws: string | null; entity: 'process' | 'backlog' | 'batch' | 'assignment' | 'assistant' | 'system' | 'knowledge' | 'agent' | 'story' | 'usage' | 'department' | 'agent_chat'; id: string | null; projectId?: string | null; itemId?: string | null; kind?: 'state' | 'progress' }

/** Entidades cuyos avisos pueden crear o cerrar algo que espera al propietario en una empresa. */
const ATTENTION_ENTITIES: ReadonlySet<LiveChange['entity']> = new Set<LiveChange['entity']>(['process', 'assignment', 'batch', 'agent', 'agent_chat', 'backlog', 'assistant']);

/**
 * HU-189 · Filtro compartido de Decisiones y de la campana: ¿este aviso puede cambiar lo que espera al propietario en
 * la empresa `slug`? Los avisos de progreso (`kind: 'progress'`) nunca cuentan.
 * - Avisos de la propia empresa sobre procesos, encargos, lotes, agentes, chats de agente, backlog o el Asistente.
 * - Avisos del Asistente SIN empresa (`ws: null`): los mensajes del chat y sus acciones pendientes, las conversaciones y
 *   los artefactos se publican sin empresa. Si se ignoraran, una acción que espera aprobación no aparecería hasta recargar.
 *   El precio es como mucho una petición de más cada `minMs`.
 */
export function attentionChange(slug: string | null): (c: LiveChange) => boolean {
  return (c: LiveChange) => {
    if (!slug || c.kind === 'progress') return false;
    if (c.ws === slug && ATTENTION_ENTITIES.has(c.entity)) return true;
    return c.entity === 'assistant' && c.ws === null;
  };
}

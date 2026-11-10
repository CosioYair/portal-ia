/**
 * HU-189 · Regla única de «acciones del Asistente que esperan tu autorización» (propose_operation, propose_execution,
 * propose_local, propose_assignment…): toda acción en estado 'pending', salvo las propuestas cuyo proceso ya fue
 * sustituido por una iteración posterior. Pura y sin IO: la usan el chat (AssistantChat) y el servidor
 * (GET /api/assistant/pending-count), para que la campana y Decisiones no dependan de que el chat esté montado.
 */
export interface PendingCountMessage { actions: ReadonlyArray<{ status: string; processId?: string | null }> }

export function assistantPendingCount(
  messages: ReadonlyArray<PendingCountMessage>,
  isSuperseded: (processId: string) => boolean = () => false
): number {
  return messages.reduce((n, m) => n + m.actions.filter(a => a.status === 'pending' && !(a.processId && isSuperseded(a.processId))).length, 0);
}

/**
 * Conversaciones del Asistente (v0.16): idea → decisiones una a una → propuesta (cuestionada) → revisión del equipo →
 * historias (con tu clic) o encargo de desarrollo. Nada de esto cambia código ni crea historias por sí solo: cada paso
 * que gasta o modifica algo es una operación del propietario. Las decisiones no se borran (solo cambian de estado, con
 * su historial).
 */
export type ConversationStage = 'exploration' | 'decisions' | 'proposal' | 'team_review' | 'approved' | 'backlog' | 'execution';
export const STAGE_LABEL: Record<ConversationStage, string> = {
  exploration: 'Exploración', decisions: 'Decisiones', proposal: 'Propuesta', team_review: 'Revisión del equipo',
  approved: 'Propuesta aprobada', backlog: 'Historias creadas', execution: 'Encargo de desarrollo'
};

export interface AssistantConversation {
  id: string;
  title: string;
  stage: ConversationStage;
  /** Alcance (empresa y proyecto): lo pone el servidor; las acciones del modelo no pueden salirse de él. */
  workspaceSlug: string | null;
  projectId: string | null;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export type DecisionStatus = 'open' | 'approved' | 'rejected' | 'deferred';
export interface DecisionOption { label: string; pros?: string | null; cons?: string | null }
export interface ConversationDecision {
  id: string;
  conversationId: string;
  /** D1, D2… en el orden en que se abrieron. */
  seq: number;
  question: string;
  context: string | null;
  options: DecisionOption[];
  recommendation: string | null;
  risks: string[];
  /** Números de las decisiones de las que depende (seq). */
  dependsOn: number[];
  status: DecisionStatus;
  /** Lo decidido (la opción elegida o la respuesta del propietario). */
  answer: string | null;
  note: string | null;
  /** Historial completo: cada cambio de estado con su respuesta (nada se pierde al revisar). */
  history: { at: string; status: DecisionStatus; answer: string | null; note: string | null }[];
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

/** Artefactos de la conversación: cada uno es un encargo de análisis (proceso) con su propósito. */
export type ConversationArtifactKind = 'proposal' | 'team_review' | 'stories';
export type ConversationArtifactStatus = 'pending_authorization' | 'running' | 'ready' | 'approved' | 'rejected' | 'failed' | 'applied' | 'cancelled';
export interface ConversationArtifact {
  id: string;
  conversationId: string;
  kind: ConversationArtifactKind;
  version: number;
  status: ConversationArtifactStatus;
  content: { processId: string | null; workspaceSlug: string | null; summary?: string | null };
  /** Artefacto en el que se basa (p. ej. la propuesta que revisa el equipo). */
  basedOn: string | null;
  calls: number;
  agents: string[];
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

/** Lo siguiente recomendado según la etapa (sin IA): el chat lo muestra siempre. */
export function nextConversationAction(stage: ConversationStage, open: number, hasProposal: boolean, proposalApproved: boolean): string {
  if (stage === 'exploration') return 'Cuéntale la idea al Asistente y pídele que la investigue; él propondrá las decisiones que hay que cerrar.';
  if (open > 0) return `Cierra las decisiones abiertas (${open}) una a una: aprobar, rechazar, revisar o aplazar.`;
  if (!hasProposal) return 'Con las decisiones cerradas, «Preparar propuesta» (el equipo la redacta y otro especialista la cuestiona antes de presentártela).';
  if (!proposalApproved) return 'Revisa la propuesta: «Consultar al equipo», apruébala o pide cambios.';
  if (stage === 'approved') return 'Con la propuesta aprobada: «Crear historias» (borradores que confirmas) o «Ejecutar como encargo».';
  if (stage === 'backlog') return 'Las historias están en el backlog: ejecútalas una a una o en un lote.';
  return 'Sigue el encargo en curso: progreso, cambios y revisión.';
}

// Tipos de dominio compartidos entre backend y frontend.
// Todo texto visible al usuario vive en el frontend; aquí solo identificadores y estructuras.

export type ProviderId = 'anthropic' | 'openai';

export type ConnectionStatus = 'not_configured' | 'connecting' | 'connected' | 'failed';

export type ModelTier = 'top' | 'mid' | 'low';

export interface ModelInfo {
  id: string;
  name: string;
  /** Nombre corto para listas densas (p. ej. "Sonnet 4.5"). */
  short: string;
  tier: ModelTier;
  supportsEffort: boolean;
  /** Costo relativo 1–3 dentro del catálogo del proveedor (heurístico). */
  relativeCost: 1 | 2 | 3;
  description: string;
}

export interface ProviderView {
  id: ProviderId;
  name: string;
  consoleHost: string;
  keyHint: string;
  status: ConnectionStatus;
  /** Pista no sensible de la credencial guardada, p. ej. "sk-ant-…cg-D". */
  credentialHint: string | null;
  /** Anthropic: ID de workspace opcional (cabecera anthropic-workspace-id). No es secreto. */
  workspaceId: string | null;
  verifiedAt: string | null;
  lastError: ProviderError | null;
  defaultModel: string | null;
  models: ModelInfo[];
}

export type ProviderErrorCode = 'invalid_key' | 'forbidden' | 'rate_limited' | 'network' | 'provider_error' | 'no_credential' | 'workspace_required'
  /** El proveedor no respondió dentro del plazo de la llamada (se abortó). */
  | 'timeout'
  /** La llamada se abortó por decisión del propietario (cancelar). */
  | 'cancelled';

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  httpStatus?: number;
}

export type Scope = 'workspace' | 'project';
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type ToolRisk = 'local' | 'auth';
export type AgentStatus = 'inactive' | 'active' | 'paused';

export interface ToolDef { id: string; risk: ToolRisk; }
export interface KnowledgeDef { id: string; }

/** Plantilla aprobada: inmutable, define identidad, relaciones y valores por defecto. */
export interface AgentTemplate {
  id: string;            // tpl.project.coordinator@1
  key: string;           // pj-coordinador
  scope: Scope;
  name: string;
  initials: string;
  role: string;
  specialization: string;
  responsibilities: string[];
  reportsTo: string | 'owner';   // key de otro agente u 'owner'
  supervises: string[];
  collaborates: string[];
  tier: ModelTier;
  fallbackTier: ModelTier;
  effort: ReasoningEffort;
  tools: Record<string, boolean>;
  knowledge: Record<string, boolean>;
  evaluation: string[];
  monthlyLimitUsd: number;
  perTaskAuthUsd: number;
  /** Capacidades (M3): qué puede hacer el agente en una historia; deciden su papel en el equipo sin llamar a la IA. */
  capabilities?: Capability[];
}

/** Capacidades reconocidas por el compositor de equipos (M3). */
export type Capability = 'planificar' | 'implementar' | 'revisar_calidad' | 'generar_pruebas' | 'consultar_arquitectura' | 'consultar_ux' | 'revisar_seguridad' | 'consultar' | 'documentar';
export const CAPABILITIES: { id: Capability; label: string; role: 'planner' | 'implementer' | 'reviewer' | 'consultant' }[] = [
  { id: 'planificar', label: 'Planificar historias (plan técnico)', role: 'planner' },
  { id: 'implementar', label: 'Implementar cambios en el código', role: 'implementer' },
  { id: 'revisar_calidad', label: 'Revisar calidad del diff (QA)', role: 'reviewer' },
  { id: 'generar_pruebas', label: 'Redactar pruebas manuales', role: 'consultant' },
  { id: 'consultar_arquitectura', label: 'Consultar sobre arquitectura', role: 'consultant' },
  { id: 'consultar_ux', label: 'Consultar sobre UX/UI', role: 'consultant' },
  { id: 'revisar_seguridad', label: 'Revisar seguridad', role: 'consultant' },
  { id: 'consultar', label: 'Consultar en su especialidad', role: 'consultant' },
  { id: 'documentar', label: 'Documentar', role: 'consultant' }
];
/** Capacidades por defecto de las plantillas del equipo inicial (para agentes creados antes de M3). */
export function defaultCapabilitiesFor(key: string): Capability[] {
  if (key === 'pj-coordinador') return ['planificar'];
  if (key === 'pj-dev') return ['implementar'];
  if (key === 'pj-qa') return ['revisar_calidad', 'generar_pruebas'];
  if (key === 'pj-arquitecto') return ['consultar_arquitectura'];
  if (key === 'pj-ux') return ['consultar_ux'];
  return [];
}

/** Configuración editable por el usuario; parte de la plantilla. */
export interface AgentConfig {
  name: string;
  specialization: string;
  responsibilities: string[];
  provider: ProviderId;
  model: string;
  fallbacks: string[];
  effort: ReasoningEffort;
  tools: Record<string, boolean>;
  knowledge: Record<string, boolean>;
  monthlyLimitUsd: number;
  perTaskAuthUsd: number;
  /** Capacidades (M3). */
  capabilities?: Capability[];
}

export interface Agent {
  id: string;             // uuid
  key: string;            // key de plantilla (estable, único por ámbito)
  workspaceSlug: string;
  projectId: string | null;
  templateId: string;
  scope: Scope;
  status: AgentStatus;
  config: AgentConfig;
  configEdited: boolean;
  createdAt: string;
  updatedAt: string;
  /** Datos inmutables heredados de la plantilla, para la UI. */
  template: Pick<AgentTemplate, 'initials' | 'role' | 'reportsTo' | 'supervises' | 'collaborates' | 'evaluation' | 'tier'>;
  /** Versión de plantilla aplicada (M5), p. ej. «pj-dev@2»; null = versión original (@1). */
  templateVersion?: string | null;
}

export interface Workspace {
  slug: string;
  name: string;
  kind: 'internal' | 'company';
  createdAt: string;
}

export interface Project {
  id: string;
  workspaceSlug: string;
  slug: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface Objective { id: string; projectId: string; position: number; text: string; }
export interface ContextItem { id: string; projectId: string; position: number; label: string; }

export interface Repository {
  id: string;
  projectId: string;
  path: string;
  mode: 'read-only';
  branch: string | null;
  authorizedAt: string;
}

export interface BootstrapStep {
  id: 'workspace' | 'project' | 'objectives' | 'persistence' | 'team';
  status: 'done' | 'skipped' | 'error';
  detail?: string;
}

export interface BootstrapResult {
  alreadyInitialized: boolean;
  workspace: Workspace;
  project: Project;
  steps: BootstrapStep[];
  agentsCreated: number;
  aiCalls: 0;
}

export interface FsEntry { name: string; path: string; isGit: boolean; branch: string | null; subdirs: number; }
export interface FsListing { path: string; parent: string | null; entries: FsEntry[]; isGit: boolean; branch: string | null; }

export interface UsageToday { processes: number; tokens: number; costUsd: number; running: number; calls: number; failedCalls: number; }

// ---- HU-004 · Procesos autorizados y conocimiento ----
export type ProcessKind = 'initial_assessment' | 'story_execution' | 'delegated_task';
export type ProcessStatus = 'pending_authorization' | 'running' | 'done' | 'failed' | 'cancelled' | 'budget_exceeded';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface ProcessStep {
  id: string;
  processId: string;
  position: number;
  agentId: string;
  agentName: string;
  title: string;
  /** Papel en el equipo (M3): planner · consultant · implementer · reviewer. */
  role?: TeamRole | null;
  /** Por qué este agente ocupa este papel (compositor determinista o anulación manual). */
  reason?: string | null;
  /** Ids de lecciones/prácticas inyectadas en el prompt de este paso (M4/M5). */
  lessonsUsed?: string[];
  status: StepStatus;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  outputMd: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Llamada al proveedor en curso (solo mientras el paso está «en ejecución»): qué se sabe de verdad y qué es estimación. */
  live?: LiveCall | null;
  /** Costo posiblemente facturado pero NO confirmado por el proveedor (llamada abortada, caída de red, reinicio). Estimación. */
  unconfirmedUsd?: number;
}

/**
 * Estado real de una llamada al proveedor. Sin streaming, el proveedor no informa de progreso hasta terminar: «esperando
 * respuesta» no significa que esté generando; solo se sabe cuándo se envió, cuándo llegaron las cabeceras y el plazo.
 */
export type LiveCallState = 'preparing' | 'sending' | 'waiting' | 'receiving' | 'processing' | 'retrying' | 'cancelling';
export interface LiveCall {
  state: LiveCallState;
  provider: string;
  model: string;
  /** Inicio de la llamada (preparación del prompt). */
  startedAt: string;
  /** Último hecho confirmado (envío, cabeceras recibidas, cuerpo recibido) y cuándo. */
  lastEvent: string;
  lastEventAt: string;
  /** Plazo máximo de esta llamada: al alcanzarlo se aborta. */
  deadlineAt: string;
  timeoutMs: number;
  /** Intento actual (reintentos por errores de conexión). */
  attempt: number;
  maxAttempts: number;
  /** Estimación del costo de esta llamada (no confirmada hasta que el proveedor la cierre). */
  estimatedUsd: number;
  inputTokensEstimated: number;
  /** Costo estimado de la entrada enviada (lo mínimo que pudo facturarse si la llamada se interrumpe). */
  inputUsd: number;
  maxOutputTokens: number;
  /** Qué es esta llamada dentro del paso (p. ej. una continuación porque la respuesta anterior se cortó). */
  operation?: string | null;
}

export interface Process {
  id: string;
  projectId: string;
  kind: ProcessKind;
  title: string;
  status: ProcessStatus;
  budgetUsd: number;
  estimatedUsd: number;
  spentUsd: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  authorizedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  steps: ProcessStep[];
  /** Resultado estructurado (ejecución de historia: plan, cambios propuestos, revisión, aplicación, verificaciones). */
  result: ExecutionResult | null;
  /** Resultado de un encargo delegado (kind = delegated_task). */
  delegation: DelegationResult | null;
  backlogItemId: string | null;
  /** Suma de costos posiblemente facturados y no confirmados (estimación; el gasto confirmado es spentUsd). */
  unconfirmedUsd?: number;
  /** Archivado al iniciar una etapa: histórico, sin acciones. null = activo. */
  archivedAt?: string | null;
  archiveId?: string | null;
  /** Descripción de «qué pasa y qué hacer» calculada por el servidor al servir el proceso (no se persiste). */
  guidance?: ProcessGuidance;
}

/** Orientación calculada por el servidor (services/guidance.ts): en qué fase está el proceso y cuál es el siguiente paso del propietario. */
export interface ProcessGuidance {
  /** Fase legible: «Pendiente de autorización», «En ejecución», «Diff listo para revisar», «Aplicado · falta integrar», «Integrado · falta publicar», «Publicado», «Falló», … */
  phase: string;
  /** Qué debe hacer ahora el propietario (una frase). */
  next: string;
  tone: 'info' | 'warn' | 'ok' | 'err';
  /** Si el proceso ya no requiere acción del propietario. */
  settled: boolean;
  /** Recorrido guiado de una historia (solo story_execution): etapas, problema actual y acciones de recuperación. */
  flow?: StoryFlow;
}

// ---- Recorrido guiado de la historia (una sola fuente de verdad: services/storyFlow.ts) ----
export type FlowStageKey = 'execute' | 'review' | 'apply' | 'verify' | 'integrate' | 'activate' | 'runtime' | 'manual' | 'close';
/** done: completada · warning: completada con advertencias · rejected · failed · blocked: falta un requisito previo · waiting: espera tu autorización · running · current: es lo que toca · pending: aún no disponible. */
export type FlowStageStatus = 'done' | 'warning' | 'rejected' | 'failed' | 'blocked' | 'waiting' | 'running' | 'current' | 'pending';
export interface FlowStage { key: FlowStageKey; label: string; status: FlowStageStatus; detail: string }
export type FlowIssueKind =
  | 'deps_missing' | 'sandbox_unavailable' | 'sandbox_timeout' | 'typecheck_failed' | 'test_failed' | 'build_failed' | 'qa_rejected' | 'patch_failed'
  | 'merge_conflict' | 'activation_failed' | 'runtime_failed' | 'runtime_unavailable' | 'manual_failed' | 'budget_exceeded'
  | 'process_failed' | 'cancelled' | 'diff_rejected' | 'legacy'
  | 'output_contract' | 'provider_failed' | 'agent_refused' | 'pipeline_paused' | 'pipeline_stopped' | 'qa_blocked'
  | 'agent_blocked' | 'provider_timeout' | 'process_interrupted' | 'call_overdue';
export type IssueSeverity = 'alta' | 'media' | 'baja';
export interface FlowIssueDetail { text: string; file?: string | null; line?: number | null; code?: string | null; severity?: IssueSeverity | null }
export interface FlowIssue {
  kind: FlowIssueKind;
  /** blocker: no se puede avanzar · warning: se puede avanzar, pero conviene resolverlo. */
  level: 'blocker' | 'warning';
  /** ¿Lo tiene que corregir el equipo (código) o es un requisito del entorno? */
  cause: 'code' | 'environment' | 'decision';
  title: string;
  explanation: string;
  /** Comando o comprobación que falló (typecheck, test, build, merge, ui /backlog…). */
  command?: string | null;
  details: FlowIssueDetail[];
  files: string[];
  /** Extracto de la salida (las últimas líneas relevantes). La salida completa sigue en la verificación. */
  evidence?: string | null;
  /** Agentes responsables de corregirlo (por papel en el equipo). */
  responsible: string[];
  /** Lo que el equipo pide al propietario para seguir (si aplica). */
  request?: OwnerRequest | null;
}
export type FlowActionId =
  | 'authorize' | 'cancel' | 'review_diff' | 'apply' | 'reject' | 'install_and_retry' | 'verify' | 'retry_verification'
  | 'sandbox_help' | 'refresh_sandbox' | 'request_fix' | 'ask_team' | 'tasks_from_issue' | 'merge' | 'rebuild'
  | 'runtime_check' | 'manual_test' | 'close' | 'close_resolved' | 'retry_process' | 'recover' | 'new_iteration'
  | 'pipeline_resume' | 'repair_output';
export interface FlowAction {
  id: FlowActionId;
  label: string;
  primary: boolean;
  /** Qué ocurrirá al pulsarlo (y qué no). */
  description: string;
  /** Lo que exige antes de ejecutarse: tu autorización, red temporal, gasto de IA (con presupuesto) o una confirmación. */
  requires: ('authorization' | 'network' | 'ai_budget' | 'confirmation')[];
  /** Comandos a (re)ejecutar (verify, retry_verification, install_and_retry). */
  commands?: string[];
  /** Continuar el pipeline (pipeline_resume / repair_output): ajustes que propone la acción y presupuesto adicional sugerido. */
  pipeline?: Partial<PipelineConfig>;
  /** La acción exige responder antes a esta pregunta del equipo (información, permiso o decisión). */
  answer?: { question: string; why: string; options: string[] } | null;
  suggestedBudgetUsd?: number;
}
export interface StoryFlow {
  stages: FlowStage[];
  current: FlowStageKey;
  progress: { done: number; total: number };
  issue: FlowIssue | null;
  actions: FlowAction[];
  /** Agentes que trabajan ahora o de los que depende la etapa actual. */
  responsible: { agentName: string; role: string; status: string }[];
  iteration: { number: number; total: number } | null;
  /** Mensaje principal cuando el pipeline autorizado terminó bien o está trabajando (p. ej. «Implementación verificada por QA — lista para revisión del propietario»). */
  headline?: string | null;
  /** Entrega incremental (procesos con manifiesto): entregables, unidad en curso, niveles de verificación, correcciones y costo. */
  delivery?: DeliveryProgress | null;
}

export interface KnowledgeDoc {
  id: string;
  projectId: string | null;
  title: string;
  body: string;
  authorAgentId: string | null;
  authorAgentName: string | null;
  processId: string | null;
  version: number;
  createdAt: string;
}

export type TeamRole = 'planner' | 'consultant' | 'implementer' | 'reviewer';
export interface TeamMember { agentId: string; agentName: string; agentKey: string; role: TeamRole; capability: Capability | null; model: string; reason: string; override?: boolean }
export interface TeamOverride { add?: string[]; remove?: string[]; by: 'owner'; at: string }
export interface TeamComposition { members: TeamMember[]; excluded: { agentId: string; agentName: string; reason: string }[]; override: TeamOverride | null; aiCalls: 0 }

export interface AssessmentEstimate {
  steps: { agentId: string; agentName: string; title: string; model: string; estimatedUsd: number; role?: TeamRole; reason?: string }[];
  /** Equipo compuesto por capacidades (M3), con motivos y exclusiones. */
  team?: TeamComposition;
  contextChars: number;
  estimatedUsd: number;
  suggestedBudgetUsd: number;
  approximate: true;
}

// ---- Creación de agentes especializados ----
export interface AgentCreateInput {
  scope: Scope;
  projectId: string | null;
  name: string;
  initials?: string;
  role: string;
  reportsTo: string | 'owner';      // key de agente u 'owner'
  collaborates: string[];           // keys
  evaluation: string[];
  config: AgentConfig;
}
export interface AgentDraftInput {
  description: string;
  scope: Scope;
  authorized: true;
  maxUsd: number;
}
export interface AgentDraftResult {
  proposal: Partial<AgentCreateInput> & { config: Partial<AgentConfig> };
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  byAgent: string;
}

// ---- HU-005 · Backlog y ejecución de historias ----
export type BacklogStatus = 'pending' | 'in_progress' | 'review' | 'done' | 'blocked' | 'discarded';
export interface BacklogItem {
  id: string;
  projectId: string;
  storyId: string;          // HU-005
  title: string;
  ownerKey: string | null;  // key del agente responsable
  dependsOn: string | null; // storyId
  estimate: 'S' | 'M' | 'L' | null;
  criterion: string;
  description: string;
  status: BacklogStatus;
  position: number;
  sourceProcessId: string | null;
  lastProcessId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Archivada al iniciar una etapa (histórico consultable, fuera del flujo activo). null = activa. */
  archivedAt?: string | null;
  archiveId?: string | null;
}

// ---- Etapas operativas: archivo reversible del trabajo activo sin perder el conocimiento ----
export interface PhaseTransition {
  id: string;
  projectId: string;
  name: string;
  startedAt: string;
  startedBy: string;
  gitHead: string | null;
  gitBranch: string | null;
  /** Documento de Conocimiento con la línea base de la etapa. */
  baselineDocId: string | null;
  summary: PhaseTransitionSummary;
  revertedAt: string | null;
  revertReason: string | null;
}
export interface PhaseTransitionSummary {
  archivedStories: { id: string; storyId: string; title: string; status: BacklogStatus }[];
  archivedProcesses: { id: string; title: string; kind: string; status: string }[];
  /** Decisiones del propietario que dejaron de estar pendientes (siguen en el histórico de su proceso). */
  clearedDecisions: { kind: string; processId: string; title: string }[];
  preserved: PreservedCounts;
  unmergedBranches: { name: string; ahead: number }[];
  version: string;
}
export interface PreservedCounts {
  agents: number; knowledgeDocs: number; lessonsValidated: number; lessonsPending: number; lessonsOther: number;
  templates: number; storyMessages: number; storyTasks: number; manualTestFeedback: number; assistantMessages: number;
  executionHistory: number; recordedCostUsd: number;
}
export interface PhaseTransitionPreview {
  phaseName: string;
  current: PhaseTransition | null;
  stories: { total: number; byStatus: Record<string, number> };
  processes: { total: number; byStatus: Record<string, number> };
  pendingDecisions: { kind: string; processId: string; title: string }[];
  /** Procesos en ejecución: bloquean la transición hasta que el propietario los cancele o terminen. */
  running: { id: string; title: string; /** Marcado «en ejecución» pero sin ejecución viva en este servidor (interrumpido por un reinicio). */ orphan: boolean }[];
  git: { repoPath: string | null; branch: string | null; head: string | null; headSubject: string | null; dirty: boolean | null; aheadOfRemote: number | null; unmergedBranches: { name: string; ahead: number }[]; worktrees: { path: string; branch: string | null; dirty: boolean }[] };
  preserved: PreservedCounts;
  baselinePreview: string;
  canStart: boolean;
  blockers: string[];
}
export interface ProjectArchive {
  transitions: PhaseTransition[];
  stories: BacklogItem[];
  processes: Process[];
}

export interface StoryPlan {
  summary: string;
  tasks: string[];
  filesToRead: string[];
  filesToChange: string[];
  acceptance: string[];
  risks: string[];
  /** Entregables del Coordinador (propósito, tipo y tamaño previsto por archivo); si faltan, se derivan de filesToChange. */
  deliverables?: { path: string; purpose: string; kind?: DeliverableKind; estimatedLines?: number }[];
}
export interface ProposedChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  content: string | null;
  /** Problema que impide aplicar este cambio (ruta protegida, parche que no encaja, archivo cambiado desde que se leyó…); el resto sí se aplica. */
  error?: string | null;
  /** Aviso no bloqueante (posible secreto, borrado masivo de líneas, copia posiblemente desactualizada…). */
  warning?: string | null;
  /** Hash (sha1) del archivo tal como lo leyó el Desarrollador; al aplicar se comprueba que no haya cambiado. */
  baseHash?: string | null;
  /** Diff unificado (texto) calculado por el servidor para revisión humana. */
  diff: string | null;
  before: number; after: number; // líneas
}
export interface ReviewVerdict {
  approve: boolean; issues: string[]; suggestedTests: string[]; summary: string;
  /** Veredicto estructurado de la puerta de QA (procesos con pipeline): aprobado, rechazado, bloqueado por el entorno o sin poder verificar. */
  verdict?: QaVerdictKind;
  /** Hallazgos con su evidencia (archivo, salida de verificación o línea del diff). */
  findings?: QaFinding[];
  /** QA evaluó evidencia real del sandbox (diff + typecheck/test/build), no solo el diff. */
  evidenceBased?: boolean;
  /** El motor corrigió el veredicto narrativo de QA porque contradecía la verificación automática (motivo). */
  overridden?: string | null;
}
export type QaVerdictKind = 'approved' | 'rejected' | 'blocked_environment' | 'unable_to_verify';
export interface QaFinding { severity: IssueSeverity; text: string; file: string | null; evidence: string | null;
  /** Criterio de aceptación afectado, corrección esperada y verificación necesaria (si QA los indica). */
  requirement?: string | null; expected?: string | null; verify?: string | null }

// ---- Contrato de salida del Desarrollador y pipeline autónomo autorizado ----
/** Qué entregó el Desarrollador, clasificado sin IA. */
export type DevOutputKind = 'implementation' | 'no_changes' | 'incomplete' | 'truncated' | 'malformed'
  /** El agente declara (sección BLOQUEO o texto inequívoco) que le falta información, un permiso o una capacidad. */
  | 'blocked'
  /** El proveedor o el modelo rechaza la petición (señal del proveedor o negativa breve e inequívoca). */
  | 'provider_refusal'
  /** Clasificación antigua (antes de la corrección de HU-155): se trata como «bloqueado sin detalle». */
  | 'refusal';
export interface DevOutputAssessment {
  kind: DevOutputKind;
  /** Motivos concretos (marcadores ausentes, bloque sin cerrar, parche vacío, ruta inválida…). */
  reasons: string[];
  /** Variante del formato con la que se recuperaron los cambios (canonical, lenient-headers, conflict-markers, unified-diff, fenced-new-files, legacy-json). */
  recoveredBy: string | null;
  files: number;
  /** Archivo cuyo bloque quedó abierto (respuesta cortada). */
  truncatedFile: string | null;
  /** Rutas del repositorio que el agente dice necesitar y no tenía en su contexto. */
  requestedFiles: string[];
  /** Bloqueo declarado por el agente (kind = blocked). */
  blocker?: AgentBlocker | null;
}
/** Lo que el agente necesita para seguir y a quién preguntarlo. */
export interface AgentBlocker {
  type: 'information' | 'permission' | 'capability';
  /** Qué falta, en palabras del agente. */
  need: string;
  /** Pregunta concreta (para otro agente o para el propietario). */
  question: string;
  /** Agente o papel que podría saberlo, si el agente lo indicó. */
  consult: string | null;
  /** true si salió de la sección BLOQUEO; false si se dedujo del texto (heurística conservadora). */
  declared: boolean;
}

/** Clasificación explícita de por qué un agente no pudo seguir: decide la recuperación (y si se gasta IA en ella). */
export type AgentFailureKind =
  | 'INVALID_OUTPUT' | 'INCOMPLETE_OUTPUT' | 'RECOVERABLE_IMPLEMENTATION_ERROR' | 'MISSING_INFORMATION' | 'PERMISSION_REQUIRED'
  | 'UNSUPPORTED_CAPABILITY' | 'PROVIDER_REFUSAL' | 'PROVIDER_TIMEOUT' | 'PROVIDER_CONNECTION_ERROR' | 'BUDGET_EXHAUSTED'
  | 'ENVIRONMENT_FAILURE' | 'UNKNOWN_FAILURE';
/** Lo que el equipo pide al propietario cuando no puede resolverlo dentro de su autoridad. */
export interface OwnerRequest {
  kind: 'information' | 'permission' | 'decision' | 'budget';
  /** Pregunta concreta. */
  question: string;
  /** Por qué hace falta y qué pasará al responder. */
  why: string;
  /** Quién lo pide. */
  askedBy: string;
  /** Alternativas posibles (p. ej. cerrar como resuelta, acotar la historia). */
  options: string[];
  at: string;
}
export interface PipelineConfig {
  /** Aplicar los cambios válidos en el worktree aislado del proceso sin esperar al propietario. */
  autoApply: boolean;
  /** Ejecutar la verificación en sandbox tras aplicar. */
  autoVerify: boolean;
  /** Comandos de verificación autorizados (orden fijo). */
  commands: ('typecheck' | 'test' | 'build')[];
  /** Instalar dependencias en el sandbox con red temporal si faltan (código 86). */
  allowInstall: boolean;
  /** Reparaciones de formato con IA (misma salida del Desarrollador, sin repetir el plan). */
  maxOutputRepairs: number;
  /** Ciclos de corrección del código (verificación fallida o rechazo de QA). */
  maxCorrections: number;
  /** Fallos equivalentes tolerados antes de detenerse. */
  maxIdenticalFailures: number;
  /** Duración máxima del proceso (minutos). */
  maxDurationMin: number;
  /** Consultas a especialistas del equipo cuando a un agente le falta información (cada pregunta, una vez). */
  maxConsultations: number;
  /** Reintentos por errores de conexión con el proveedor (por llamada; con espera exponencial). */
  maxProviderRetries: number;
  /** Plazo fijo de cada llamada (s). null = automático según la salida máxima (ver providerCalls.ts). */
  providerTimeoutSec: number | null;
  /** Continuaciones de respuestas cortadas por longitud (en todo el proceso; cada archivo, como máximo 2). No consumen correcciones. */
  maxContinuations?: number;
}
export type PipelineEventKind = 'info' | 'recovery' | 'repair' | 'apply' | 'verify' | 'environment' | 'qa' | 'correction' | 'pause' | 'done' | 'error'
  /** Entrega incremental: unidad de trabajo, continuación de una respuesta cortada y comprobación determinista previa a QA. */
  | 'unit' | 'continuation' | 'gate';
export interface PipelineEvent { at: string; kind: PipelineEventKind; message: string; detail?: string | null; aiCall?: boolean; costUsd?: number | null }
export type PipelineState = 'running' | 'verified' | 'paused' | 'stopped';
export type PipelinePauseKind = 'budget' | 'network' | 'environment' | 'limit' | 'repeated_failure' | 'duration' | 'no_changes' | 'refusal' | 'qa' | 'cancelled'
  | 'missing_information' | 'permission' | 'unsupported' | 'provider_refusal' | 'provider_timeout' | 'provider_error' | 'interrupted' | 'unknown'
  /** Entrega incremental: un entregable no cabe en la salida del modelo ni por secciones, o faltan entregables tras los intentos permitidos. */
  | 'too_large' | 'incomplete';
export type PipelinePhase = 'implementing' | 'recovering' | 'repairing' | 'applying' | 'verifying' | 'installing' | 'qa' | 'correcting' | 'finished';
export interface PipelineStatus {
  config: PipelineConfig;
  state: PipelineState;
  phase: PipelinePhase;
  /** Motivo de la pausa o de la parada (para el propietario). */
  reason: string | null;
  pauseKind: PipelinePauseKind | null;
  events: PipelineEvent[];
  outputRepairs: number;
  corrections: number;
  /** Firmas de fallos vistos (comando/archivo/código) y cuántas veces se repitieron. */
  failures: { signature: string; count: number; label: string }[];
  lastAssessment: DevOutputAssessment | null;
  /** Commit del worktree que QA evaluó por última vez (si cambia, QA vuelve a evaluar). */
  lastQaCommit?: string | null;
  /** Clase del último fallo (decide la recuperación). */
  failureClass?: AgentFailureKind | null;
  /** Pregunta pendiente para el propietario (información, permiso o decisión). */
  ownerRequest?: OwnerRequest | null;
  /** Respuestas del propietario aún no entregadas al equipo. */
  ownerAnswers?: { at: string; question: string; answer: string; delivered: boolean }[];
  /** Consultas a especialistas del equipo (para no repetir la misma pregunta). */
  consultations?: { at: string; agentName: string; question: string }[];
  /** Entregas de contexto solicitado (archivos del repositorio que el agente pidió). */
  contextSupplies?: number;
  /** Reintentos por errores de conexión con el proveedor (en total). */
  providerRetries?: number;
  /** Continuaciones de respuestas cortadas (contador propio: no consume correcciones ni reparaciones de formato). */
  continuations?: number;
  /** Llamadas de corrección pagadas (aplicadas o no). `corrections` cuenta solo las rondas que produjeron cambios aplicados. */
  correctionAttempts?: number;
  /** Rondas de corrección sin ningún cambio aplicable (se detiene en vez de repetir lo mismo). */
  ineffectiveRounds?: number;
  startedAt: string;
  finishedAt: string | null;
}

// ---- Entrega incremental: manifiesto de entregables y unidades de trabajo ----
export type DeliverableKind = 'code' | 'test' | 'docs' | 'config';
/**
 * pending: aún no entregado · delivered: está en el diff del worktree (evidencia: commit) · failed: no se pudo entregar tras
 * los intentos permitidos · dropped: el equipo justificó que no hace falta (QA lo confirma) · extra: fuera del plan.
 */
export type DeliverableStatus = 'pending' | 'delivered' | 'failed' | 'dropped';
export interface Deliverable {
  path: string;
  purpose: string;
  kind: DeliverableKind;
  /** false = añadido por el equipo durante la implementación (no estaba en el plan). */
  planned: boolean;
  status: DeliverableStatus;
  /** Unidad que lo entrega (o lo entregó). */
  unitId: string | null;
  /** Commit del worktree en el que quedó y líneas resultantes (evidencia real, no la palabra del agente). */
  commit: string | null;
  lines: number | null;
  estimatedLines: number;
  /** Motivo de un descarte o de un fallo. */
  note: string | null;
}
export type WorkUnitKind = 'build' | 'correction';
export type WorkUnitStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface WorkUnit {
  id: string;
  kind: WorkUnitKind;
  title: string;
  purpose: string;
  /** Ámbito autorizado: archivos que esta unidad entrega o corrige. */
  files: string[];
  /** Criterios de aceptación de la historia que cubre. */
  acceptance: string[];
  /** Unidades que deben estar terminadas antes. */
  dependsOn: string[];
  agentId: string; agentName: string; role: TeamRole;
  status: WorkUnitStatus;
  /** Llamadas de implementación de la unidad (sin contar continuaciones ni reparaciones de formato). */
  attempts: number;
  continuations: number;
  repairs: number;
  /** Salida de texto prevista (tokens) y costo estimado antes de llamar. */
  estimatedOutputTokens: number;
  estimatedUsd: number;
  /** Costo confirmado de sus llamadas (suma de sus pasos). */
  costUsd: number;
  stepIds: string[];
  /** Origen (unidades de corrección): QA, verificación o comprobación de completitud, con los hallazgos que corrige. */
  source?: 'plan' | 'qa' | 'verification' | 'completeness';
  findings?: { severity: IssueSeverity; text: string; file: string | null; evidence: string | null; expected?: string | null }[];
  /** Último problema (para no repetir lo mismo y para el propietario). */
  error: string | null;
  startedAt: string | null; finishedAt: string | null;
  /** Paso planificado que usa la primera llamada (la «Implementación» del equipo autorizado). */
  reservedStepId?: string | null;
  /** Ronda de corrección a la que pertenece (unidades de corrección). */
  round?: number;
  /** Archivos que esta unidad dejó aplicados en el worktree (evidencia). */
  applied?: string[];
  /** Continuaciones por archivo cortado (máximo 2 cada uno). */
  continued?: Record<string, number>;
  /** Veces que el modelo agotó la salida sin escribir texto (todo en razonamiento oculto). */
  exhausted?: number;
  /** Entregables que esta unidad descartó de verdad (con motivo) y respuesta del equipo que discute un hallazgo (correcciones). */
  dropped?: string[];
  disputed?: string | null;
  /** Salidas pagadas del intento en curso (paso + motivo de parada + prefijo de una continuación): al reanudar se releen sin volver a llamar. */
  outputs?: { stepId: string; stopReason: string | null; prefix?: string | null }[];
}
/** Comprobación determinista previa a QA (sin IA): lo que el motor ya sabe sin preguntar a nadie. */
export interface CompletenessGate {
  at: string;
  /** Commit del worktree comprobado (si cambia, se vuelve a comprobar). */
  commit: string | null;
  ok: boolean;
  /** Entregables planificados que no están en el diff del worktree (ni justificados como descartados). */
  missing: string[];
  /** Archivos entregados con problemas objetivos (JSON no válido, marcadores de conflicto, contenido omitido «...», prueba que el script de test no descubre). */
  invalid: { path: string; problem: string }[];
  dropped: { path: string; reason: string }[];
  /** Archivos cambiados fuera del plan. */
  extra: string[];
  /** Pruebas añadidas o modificadas en el diff. */
  testsChanged: string[];
  notes: string[];
}
export interface StoryManifest {
  version: 1;
  deliverables: Deliverable[];
  units: WorkUnit[];
  /** Salida de texto máxima por unidad (tokens) con la que se dividió el trabajo. */
  unitOutputBudget: number;
  /** Rondas de corrección: de dónde vienen, cuántas unidades y cuántas aplicaron cambios. */
  rounds: { at: string; source: 'qa' | 'verification' | 'completeness'; units: number; applied: number }[];
  gate: CompletenessGate | null;
  createdAt: string;
}
/** Resumen de la entrega para la interfaz (calculado al servir el proceso). */
export interface DeliveryProgress {
  deliverables: { path: string; kind: DeliverableKind; status: DeliverableStatus; planned: boolean; note: string | null; unit: string | null; lines: number | null }[];
  delivered: number; total: number;
  units: { done: number; total: number };
  currentUnit: { title: string; agentName: string; kind: WorkUnitKind; index: number; total: number } | null;
  /** Tres niveles distintos: compila ≠ funcionalidad completa ≠ QA aprobó los criterios. */
  levels: { compiles: boolean | null; complete: boolean; qaApproved: boolean };
  corrections: { applied: number; max: number; requested: number; ineffective: number; attempts: number };
  continuations: number;
  spentUsd: number;
  /** Estimación de lo que falta (unidades pendientes + QA), nunca confirmada. */
  remainingEstimateUsd: number;
  blocker: string | null;
  next: string;
}
/** Por qué terminó mal un proceso de historia (clasificado al fallar; evita adivinar por el texto del error). */
export interface ProcessFailure { kind: 'output_contract' | 'provider' | 'budget' | 'cancelled' | 'internal' | 'refusal'; detail: string; assessment?: DevOutputAssessment | null;
  /** Clase explícita (desde la corrección de HU-155): decide la recuperación y lo que se muestra. */
  class?: AgentFailureKind;
  /** Código del proveedor cuando aplica (timeout, network, rate_limited…). */
  providerCode?: ProviderErrorCode | null;
  /** Lo que se pide al propietario para seguir (procesos sin pipeline). */
  request?: OwnerRequest | null }
export type Isolation = 'docker' | 'wsl' | 'linux-ns' | 'host-min' | 'unavailable';
export interface VerificationRun { command: string; exitCode: number | null; output: string; startedAt: string; finishedAt: string; durationMs: number; /** Dónde se ejecutó: sandbox real (docker/wsl), verificación mínima en el equipo (solo tsc) o no disponible. */ isolation?: Isolation; }
export interface ExecutionResult {
  plan: StoryPlan | null;
  implementationSummary: string | null;
  /** Explicación para el propietario, sin tecnicismos: qué verá tras integrar y reconstruir, y dónde (menú, botón, ruta). */
  userFacing?: string | null;
  /** Prueba manual paso a paso que el propietario sigue y marca; la historia no se cierra hasta que todos los pasos estén probados. */
  manualTest?: { steps: string[]; checks: boolean[]; note: string | null } | null;
  /** Comprobaciones en ejecución definidas por el equipo (http/ui) y sus resultados tras activar (M2). */
  runtimeChecks?: { checks: RuntimeCheck[]; results: RuntimeCheckResult[]; ranAt: string | null } | null;
  /** Estado de activación calculado al leer (no se persiste): ¿el Portal en marcha contiene el merge y la web fue reconstruida después? */
  activation?: ActivationState | null;
  /** Equipo de la historia (M3): quién hizo qué y por qué, incluidas anulaciones manuales. */
  team?: TeamComposition | null;
  /** Aportaciones de los consultores (M3), por agente. */
  consultations?: { agentId: string; agentName: string; role: string; text: string }[];
  /** Contexto de iteración (M6): feedback de la prueba, tareas abiertas y nota del propietario que recibe el equipo. */
  iterationContext?: string | null;
  changes: ProposedChange[];
  verifyCommands: string[];
  review: ReviewVerdict | null;
  applied: { branch: string; commit: string; files: string[]; appliedAt: string; /** Worktree aislado donde viven los cambios hasta integrarse (M1). */ worktree?: string | null } | null;
  verifications: VerificationRun[];
  /** Integración de la rama en la rama principal (git merge --no-ff), autorizada por el propietario. */
  merged?: { into: string; commit: string; mergedAt: string } | null;
  /** Último intento de integrar que falló (conflictos): se conserva para explicarlo y corregirlo; se borra al integrar. */
  mergeError?: { at: string; message: string; files: string[] } | null;
  /** Publicación en el remoto (git push), autorizada por el propietario. */
  published?: { remote: string; url: string | null; branches: string[]; pushedAt: string } | null;
  /** HU-146 · Intentos de «Corregir y revalidar» dentro de esta misma historia. */
  repairs?: ValidationRepairAttempt[];
  /** El propietario rechazó este diff (o replanteó la historia): no se aplicará; la historia volvió a pendiente. */
  rejected?: { at: string; reason: string } | null;
  /** Pipeline autónomo autorizado (aplicar, verificar, QA con evidencia, correcciones acotadas). */
  pipeline?: PipelineStatus | null;
  /** Clasificación del fallo del proceso (si falló). */
  failure?: ProcessFailure | null;
  /** Entrega incremental: entregables del plan, unidades de trabajo y comprobación previa a QA (puntos de control duraderos). */
  manifest?: StoryManifest | null;
}

/** Estado del repositorio registrado (solo lectura, sin red). */
export interface RepoStatus {
  path: string; isGit: boolean;
  /** true si el repositorio es la carpeta desde la que corre este Portal (automejora real). */
  isPortalRuntime: boolean;
  branch: string | null; mainBranch: string | null; hasMain: boolean; hasCommits: boolean;
  dirty: boolean; dirtyFiles: number;
  /** Los cambios sin confirmar son solo de finales de línea (CRLF/LF): se normalizan con un clic. */
  eolOnly: boolean;
  remote: string | null; remoteUrl: string | null;
  /** Commits de main por delante / por detrás de origin/main según las referencias locales; -1 = main nunca publicada; null = sin remoto. */
  aheadOfRemote: number | null; behindRemote: number | null;
  headCommit: string | null;
  storyBranches: string[];
}

/** Estado del propio Portal en ejecución: código arrancado frente a código actual del repositorio. */
export interface SystemStatus {
  version: string; startedAt: string; repoRoot: string; isGit: boolean;
  startCommit: string | null; headCommit: string | null; branch: string | null;
  /** Commit con el que se construyó la web servida (apps/web/dist/build-info.json) y cuándo. */
  buildCommit?: string | null; buildAt?: string | null;
  /** Sandbox detectado para verificar código generado. */
  sandbox?: { available: Isolation; detail: string } | null;
  /** Archivos cambiados entre el commit arrancado y HEAD (y sin confirmar). */
  changedFiles: string[];
  /** Acción necesaria para ver los cambios: ninguna, recargar el navegador o reconstruir y reiniciar. */
  action: 'none' | 'reload' | 'restart';
  stories: string[];
  update: { status: 'idle' | 'running' | 'done' | 'failed'; log: string; startedAt: string | null; finishedAt: string | null; /** Qué pasará al terminar: reinicio automático (supervisor) o apagado con comandos para arrancar a mano. */ outcome?: ServerLifecycleOutcome | null } | null;
}

/** Operación propuesta sobre el backlog por un agente (se aplica solo con aprobación del propietario). */
export type BacklogOp =
  | { op: 'add'; title: string; criterion?: string; description?: string; ownerKey?: string | null; estimate?: 'S' | 'M' | 'L' | null; dependsOn?: string | null; reason?: string }
  | { op: 'update'; story: string; title?: string; criterion?: string; description?: string; ownerKey?: string | null; estimate?: 'S' | 'M' | 'L' | null; dependsOn?: string | null; reason?: string }
  | { op: 'discard'; story: string; reason: string }
  | { op: 'merge'; into: string; from: string[]; title?: string; criterion?: string; reason?: string }
  | { op: 'reprioritize'; order: string[]; reason?: string };

/** Encargo delegado a un agente responsable, que valida la petición y consulta a los agentes a su cargo. */
export interface DelegationResult {
  request: string;
  leadAgentId: string; leadAgentName: string;
  /** Validación del responsable: si acepta el encargo, cómo lo entiende y qué necesita de su equipo. */
  triage: { accepted: boolean; understanding: string; rejectionReason: string | null; plan: string[] } | null;
  consulted: { agentId: string; agentName: string; question: string; answer: string }[];
  /** Entregable final en markdown (también se guarda en Conocimiento). */
  deliverable: string | null;
  knowledgeDocId: string | null;
  backlogOps: BacklogOp[];
  opsApplied: { at: string; summary: string[] } | null;
}

// ---- HU-143 · Integrar siempre contra la rama principal ----
/** Motivo por el que la integración está bloqueada. */
export type IntegrationBlockCode = 'NOT_ON_MAIN' | 'DETACHED_HEAD' | 'NOT_A_REPO';

/** Estado de la carpeta del Portal respecto a la integración. El motivo va en español. */
export interface IntegrationStatus {
  /** Rama activa; null si HEAD está desacoplado o la carpeta no es un repositorio. */
  currentBranch: string | null;
  /** Rama principal configurada (la única sobre la que se integra). */
  mainBranch: string;
  canIntegrate: boolean;
  reasonCode?: IntegrationBlockCode;
  reason?: string;
}

/** Error de git traducido a una causa y una solución legibles. */
export interface GitActionableError {
  code: string;
  cause: string;
  solution: string;
}

// ---- HU-144 · Reinicio / apagado del servidor ----
/**
 * Resultado de «Reiniciar» el servidor desde el Portal.
 * - `restarting`: hay un supervisor externo que relanzará el proceso en el mismo puerto.
 * - `shutdown`: el proceso termina por completo (puerto libre) y el propietario debe arrancarlo con `commands`.
 */
export interface ServerLifecycleOutcome {
  mode: 'restarting' | 'shutdown';
  port: number;
  /** Directorio absoluto donde ejecutar `commands`. */
  cwd: string;
  /** Comandos exactos y en orden (vacío si el reinicio es automático). */
  commands: string[];
  reason: string;
}

// ---- HU-146 · Corregir y revalidar ----
/** Máximo de intentos de autocorrección por proceso; cada uno requiere autorización del propietario. */
export const MAX_REPAIR_ATTEMPTS = 3;

export type RepairAttemptStatus = 'esperando_autorizacion' | 'corrigiendo' | 'revision_qa' | 'revalidando' | 'resuelto' | 'fallido';

/** Resultado de un comando de validación (salida ya redactada de secretos y truncada). */
export interface RepairCommandResult { command: string; exitCode: number | null; output: string; }

export interface ValidationRepairAttempt {
  id: string;
  processId: string;
  /** 1–MAX_REPAIR_ATTEMPTS */
  attemptNumber: number;
  failedCommands: RepairCommandResult[];
  /** Hash normalizado del error: la autorización solo vale mientras el error siga siendo el mismo. */
  errorSignature: string;
  /** Token de un solo uso que el propietario debe presentar para ejecutar el intento. */
  authorizationId: string;
  budgetUsd: number | null;
  estimatedCost: number;
  actualCost: number;
  qaVerdict: { approve: boolean; summary: string; issues: string[] } | null;
  diff: string | null;
  files: string[];
  /** Causa del error según el Desarrollador. */
  cause: string | null;
  rerunResults: RepairCommandResult[];
  status: RepairAttemptStatus;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ValidationRepairOverview {
  attempts: ValidationRepairAttempt[];
  failedCommands: RepairCommandResult[];
  used: number;
  remaining: number;
  maxAttempts: number;
  running: boolean;
  waiting: ValidationRepairAttempt | null;
  resolved: boolean;
  stopped: boolean;
  lastError: string | null;
}

// ---- HU-007 · Libro de presupuesto con reserva y corte duro ----
// Todos los importes son enteros en micro-USD (1 USD = 1_000_000) para evitar errores de coma flotante.
export interface BudgetScope {
  /** Clave de ámbito (hoy un espacio/proyecto; extensible a empresa > proyecto > proceso sin migrar). */
  scopeId: string;
  limitMicros: number;
}

export type BudgetReservationStatus = 'active' | 'settled' | 'released';

export interface BudgetReservation {
  id: string;
  scopeId: string;
  estimatedMicros: number;
  status: BudgetReservationStatus;
  /** Coste real; solo presente cuando la reserva está liquidada. */
  actualMicros?: number;
}

export interface BudgetSnapshot {
  limitMicros: number;
  /** Suma del coste real de las reservas liquidadas. */
  spentMicros: number;
  /** Suma de las estimaciones de las reservas activas. */
  reservedMicros: number;
  /** límite − gastado − reservado; puede ser negativo si el coste real superó la estimación. */
  availableMicros: number;
}

// ---- HU-133 / HU-138 · Presupuestos jerárquicos empresa > proyecto > proceso ----
// Mismos importes enteros en micro-USD que HU-007. Periodo mensual en UTC con formato 'YYYY-MM'.
// (BudgetScope y BudgetReservation ya existen en HU-007; aquí se usan nombres distintos para no colisionar.)
export type BudgetLevel = 'company' | 'project';

export interface MonthlyBudget {
  scope: BudgetLevel;
  /** Empresa: slug del espacio. Proyecto: id del proyecto. */
  scopeId: string;
  period: string;
  limitMicros: number;
}

export type ProcessReservationStatus = 'active' | 'settled' | 'released';

/** Reserva de presupuesto de un proceso en curso (se descuenta del saldo del proyecto y de la empresa). */
export interface ProcessBudgetReservation {
  processId: string;
  projectId: string;
  amountMicros: number;
  status: ProcessReservationStatus;
}

export interface BudgetBalance {
  level: BudgetLevel;
  scopeId: string;
  period: string;
  /** false si no hay presupuesto definido para el ámbito y el periodo (la autorización se deniega por defecto). */
  configured: boolean;
  limitMicros: number;
  /** Gasto real del periodo en el ámbito. */
  spentMicros: number;
  /** Suma de reservas activas de procesos en curso. */
  reservedMicros: number;
  /** límite − gasto real − reservado; puede ser negativo si el coste real superó la reserva. */
  availableMicros: number;
}

// ---- HU-009 / HU-137 · Bandeja de autorizaciones ----
/** Clases de decisión que esperan al propietario. */
export const PENDING_DECISION_KINDS = ['process_authorization', 'apply_diff', 'integrate', 'publish', 'backlog_proposal'] as const;
export type PendingDecisionKind = typeof PENDING_DECISION_KINDS[number];
export type DecisionVerdict = 'approve' | 'deny';

/** Decisión pendiente normalizada para la bandeja. Se calcula al vuelo a partir de los procesos; no se persiste. */
export interface PendingDecision {
  /** `${kind}:${processId}`; estable mientras la decisión siga pendiente. */
  id: string;
  kind: PendingDecisionKind;
  title: string;
  workspaceSlug: string;
  projectId: string;
  processId: string;
  requestedBy: string;
  createdAt: string;
  /** Costo de IA que implica aprobar; null si aprobar no consume IA. */
  estimatedCost: { usd: number; budgetUsd: number } | null;
  /** Resumen legible del impacto (archivos y líneas, rama, alcance, historias propuestas…). */
  impact: string;
  /** Qué ocurre al aprobar. */
  approveEffect: string;
  /** Qué ocurre al denegar; null si el proceso original no tiene una acción de denegar (la decisión solo se puede aprobar o dejar pendiente). */
  denyEffect: string | null;
}

export interface InboxDecisionResult {
  ok: true;
  kind: PendingDecisionKind;
  processId: string;
  verdict: DecisionVerdict;
  processStatus: string | null;
}

// ---- HU-147 · Feedback por paso en la prueba manual ----
export const MANUAL_TEST_RESULTS = ['ok', 'fail', 'observation'] as const;
export type ManualTestStepResult = typeof MANUAL_TEST_RESULTS[number];

/** Feedback del propietario sobre un paso de la prueba manual de un proceso. */
export interface ManualTestStepFeedback {
  processId: string;
  /** Ver manualTestStepKey. */
  stepKey: string;
  /** null = sin resultado (solo comentario). */
  result: ManualTestStepResult | null;
  comment: string;
  updatedAt: string;
}

/** Paso de la prueba manual con su clave estable. */
export interface ManualTestStepRef { stepKey: string; index: number; text: string; }

/** Lectura completa: pasos del proceso + feedback guardado (puede incluir pasos huérfanos si la prueba cambió). */
export interface ManualTestFeedbackView { steps: ManualTestStepRef[]; items: ManualTestStepFeedback[]; }

/**
 * Clave estable de un paso. Los pasos de la prueba manual son texto sin id, así que la clave combina
 * la posición y un hash corto (FNV-1a) del texto: si el texto cambia, el feedback antiguo deja de
 * asociarse al paso nuevo (queda huérfano en la base) en lugar de aplicarse a un paso distinto.
 */
export function manualTestStepKey(index: number, text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `p${index + 1}-${h.toString(36)}`;
}

// ---- M6 · Espacio de la historia ----
export interface StoryMessage { id: string; backlogItemId: string; role: 'owner' | 'agent' | 'system'; agentId: string | null; agentName: string | null; content: string; processId: string | null; costUsd: number; tokens: number; proposals: { tasks: { title: string; assignee: string | null }[]; criterion: string | null; iterate: boolean; iterationNote: string | null; applied: boolean } | null; createdAt: string }
export interface StoryTask { id: string; backlogItemId: string; title: string; status: 'open' | 'done'; assigneeAgentId: string | null; assigneeName: string | null; source: string; processId: string | null; createdAt: string; doneAt: string | null }
export interface StoryContext {
  item: BacklogItem; project: Project; processes: Process[]; lastProcess: Process | null; iterations: number; team: TeamMember[];
  manualTest: { steps: string[]; checks: boolean[]; note: string | null } | null; feedback: ManualTestFeedbackView;
  tasks: StoryTask[]; messages: StoryMessage[]; lessons: Lesson[];
  /** Qué ocurrirá al crear una nueva iteración (lo calcula el servidor; la interfaz pide las confirmaciones que indique). */
  iteration: StoryIterationState;
}
/**
 * Estado de la iteración anterior frente a una nueva:
 * - `none`: sin iteraciones o la anterior ya se rechazó · `not_applied`: el diff anterior queda superado
 * - `applied_worktree`: aplicada en un worktree sin integrar → se descartan worktree y rama (confirmación explícita)
 * - `legacy`: aplicada antes de v0.12 sin worktree → se marca descartada y la rama se conserva
 * - `merged`: integrada → la nueva iteración parte de main · `in_progress`: hay una en ejecución o pendiente (no se crea otra)
 */
export interface StoryIterationState {
  state: 'none' | 'not_applied' | 'applied_worktree' | 'legacy' | 'merged' | 'in_progress';
  /** Rama afectada (la que se descarta en `applied_worktree`, la que se conserva en `legacy`, la integrada en `merged`). */
  branch: string | null;
  /** La historia está cerrada o descartada: hay que reabrirla (`reopen: true`). */
  needsReopen: boolean;
  /** Hay que confirmar el descarte del worktree y la rama (`discardApplied: true`). */
  needsDiscardConfirmation: boolean;
  /** Pasos de la prueba manual marcados con «Falla» en la última iteración. */
  failedSteps: number;
  /** Explicación para el propietario de lo que hará el Portal. */
  summary: string;
}

// ---- M4 · Lecciones validadas ----
export type LessonStatus = 'detected' | 'proposed' | 'validated' | 'rejected' | 'obsolete';
export interface LessonEvidence { processId: string | null; processTitle: string | null; stepId: string | null; agentId: string | null; agentName: string | null; file: string | null; detail: string; at: string }
export interface Lesson {
  id: string; projectId: string | null; role: string | null; tags: string[]; status: LessonStatus; version: number; parentId: string | null;
  title: string; detector: string; evidence: LessonEvidence; rootCause: string | null; correctiveAction: string | null;
  /** Texto que se inyecta en los prompts (solo si está validada). */
  lessonText: string | null;
  source: 'detector' | 'ai' | 'owner' | string; usedCount: number; recurrenceCount: number;
  /** Versión de plantilla a la que se promovió como práctica (M5), p. ej. «pj-dev@2». */
  promotedTo: string | null;
  createdAt: string; updatedAt: string; validatedAt: string | null;
}

// ---- M5 · Plantillas versionadas ----
export interface AgentTemplatePractice { lessonId: string; text: string; title: string; addedAt: string }
export interface AgentTemplateVersion {
  key: string; version: number; /** «pj-dev@2» */ id: string; name: string; role: string; responsibilities: string[]; practices: AgentTemplatePractice[];
  /** Diff legible respecto a la versión anterior. */ diffMd: string; source: 'seed' | 'promotion' | string; lessonId: string | null; createdAt: string; createdBy: string;
}

export interface RuntimeCheck { kind: 'http' | 'ui'; path: string; selector?: string | null; expect: string; }
export interface RuntimeCheckResult { check: RuntimeCheck; status: 'ok' | 'fail' | 'skipped'; detail: string; evidence?: string | null; at: string; }
export interface ActivationState { active: boolean; runningCommit: string | null; buildCommit: string | null; buildAt: string | null; reason: string; }

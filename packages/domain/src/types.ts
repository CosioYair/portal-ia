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

export type ProviderErrorCode = 'invalid_key' | 'forbidden' | 'rate_limited' | 'network' | 'provider_error' | 'no_credential' | 'workspace_required';

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
}

export interface StoryPlan {
  summary: string;
  tasks: string[];
  filesToRead: string[];
  filesToChange: string[];
  acceptance: string[];
  risks: string[];
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
export interface ReviewVerdict { approve: boolean; issues: string[]; suggestedTests: string[]; summary: string; }
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
  /** Publicación en el remoto (git push), autorizada por el propietario. */
  published?: { remote: string; url: string | null; branches: string[]; pushedAt: string } | null;
  /** HU-146 · Intentos de «Corregir y revalidar» dentro de esta misma historia. */
  repairs?: ValidationRepairAttempt[];
  /** El propietario rechazó este diff (o replanteó la historia): no se aplicará; la historia volvió a pendiente. */
  rejected?: { at: string; reason: string } | null;
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

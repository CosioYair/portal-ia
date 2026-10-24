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

export interface AssessmentEstimate {
  steps: { agentId: string; agentName: string; title: string; model: string; estimatedUsd: number }[];
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
  /** Diff unificado (texto) calculado por el servidor para revisión humana. */
  diff: string | null;
  before: number; after: number; // líneas
}
export interface ReviewVerdict { approve: boolean; issues: string[]; suggestedTests: string[]; summary: string; }
export interface VerificationRun { command: string; exitCode: number | null; output: string; startedAt: string; finishedAt: string; durationMs: number; }
export interface ExecutionResult {
  plan: StoryPlan | null;
  implementationSummary: string | null;
  changes: ProposedChange[];
  verifyCommands: string[];
  review: ReviewVerdict | null;
  applied: { branch: string; commit: string; files: string[]; appliedAt: string } | null;
  verifications: VerificationRun[];
  /** Integración de la rama en la rama principal (git merge --no-ff), autorizada por el propietario. */
  merged?: { into: string; commit: string; mergedAt: string } | null;
  /** Publicación en el remoto (git push), autorizada por el propietario. */
  published?: { remote: string; url: string | null; branches: string[]; pushedAt: string } | null;
}

/** Estado del repositorio registrado (solo lectura, sin red). */
export interface RepoStatus {
  path: string; isGit: boolean;
  /** true si el repositorio es la carpeta desde la que corre este Portal (automejora real). */
  isPortalRuntime: boolean;
  branch: string | null; mainBranch: string | null; hasMain: boolean; hasCommits: boolean;
  dirty: boolean; dirtyFiles: number;
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
  /** Archivos cambiados entre el commit arrancado y HEAD (y sin confirmar). */
  changedFiles: string[];
  /** Acción necesaria para ver los cambios: ninguna, recargar el navegador o reconstruir y reiniciar. */
  action: 'none' | 'reload' | 'restart';
  stories: string[];
  update: { status: 'idle' | 'running' | 'done' | 'failed'; log: string; startedAt: string | null; finishedAt: string | null } | null;
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

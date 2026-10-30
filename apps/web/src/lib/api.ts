import type { RestoreSupersededResult, StoryDecisionHistory } from '@portal-ia/domain';
import type { PipelineConfig, PhaseTransition, PhaseTransitionPreview, ProjectArchive, StoryContext, StoryMessage, StoryTask, Lesson, AgentTemplateVersion, DecisionVerdict, InboxDecisionResult, PendingDecision, PendingDecisionKind, RepoStatus, SystemStatus, Agent, AgentConfig, AgentCreateInput, AgentDraftResult, AssessmentEstimate, BacklogItem, BacklogStatus, BootstrapResult, ContextItem, FsEntry, FsListing, KnowledgeDoc, Objective, Process, Project, ProviderView, Repository, UsageToday, Workspace } from '@portal-ia/domain';

import type { BudgetBalance, BudgetLevel } from '@portal-ia/domain';
import type { BatchPreview, BatchView, GauntletAdvice, GauntletConfig, GauntletProjectInfo } from '@portal-ia/domain';
import type { OrgApplication, OrgBriefAttachment, OrgChange, OrgDecision, OrgEvaluation, OrgEvaluationBrief, OrgProposal, OrgProposalSpec } from '@portal-ia/domain';
import type { ClaudeCodeRun, ClaudeCodeStatusView, ClaudeCodeUsage, ClaudeCodeUsageReport, ClaudeCodeWorkerView, ClaudeCodeWorkspaceView, ExecutionBackend } from '@portal-ia/domain';
import type { Assignment, AssistantConversation, ConversationArtifact, ConversationDecision, ConversationStage } from '@portal-ia/domain';
import { noteBundle, noteFailure, noteResponse } from './liveStatus.ts';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) { super(message); }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = init?.body ? { 'Content-Type': 'application/json' } : {};
  // Las lecturas no pueden quedarse colgadas: un sondeo sin respuesta detendría la actualización de la pantalla.
  const isRead = !init?.method || init.method === 'GET';
  const sentAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) }, ...(isRead && !init?.signal ? { signal: AbortSignal.timeout(20_000) } : {}) });
  } catch (e: any) {
    noteFailure(e?.name === 'TimeoutError' ? 'El servidor no respondió en 20 s' : 'No se pudo contactar con el servidor del Portal');
    throw new ApiError(0, e?.name === 'TimeoutError' ? 'El servidor no respondió a tiempo.' : 'No se pudo contactar con el servidor del Portal.', { code: 'unreachable' });
  }
  noteResponse(res.headers.get('x-server-time'), sentAt, Date.now()); noteBundle(res.headers.get('x-portal-web'));
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? body?.lastError?.message ?? `Error ${res.status}`, body);
  return body as T;
}

export interface AssistantInfo { agentId: string; name: string; model: string; provider: string; monthlyLimitUsd: number; spentThisMonthUsd: number; estimatedPerMessageUsd: number;
  /** Backend del Asistente y su origen de facturación (se muestran antes de enviar). */
  backend: ExecutionBackend; backendLabel: string; billing: 'api' | 'subscription'; available: boolean; unavailableReason: string | null }
export type AssistantActionType = 'create_company' | 'create_project' | 'add_backlog_item' | 'propose_execution' | 'propose_apply' | 'propose_delegation' | 'propose_operation' | 'propose_local' | 'open_decision' | 'propose_assignment' | 'info';
export interface AssistantAction {
  type: AssistantActionType; status: 'done' | 'failed' | 'pending' | 'running' | 'rejected'; label: string; detail?: string; link?: string;
  operation?: { id: string; capability: string; params: Record<string, unknown>; preview: { ok: boolean; title: string; details: string[]; blockers: string[]; excluded: string[] }; result?: { summary: string; details: string[] } | null; decidedAt?: string | null };
  processId?: string; workspaceSlug?: string; projectId?: string; storyId?: string; estimatedUsd?: number; suggestedBudgetUsd?: number; changes?: number;
  /** propose_local: cambio que el propietario confirma; open_decision / propose_assignment: a qué apuntan. */
  local?: { op: string; params: Record<string, unknown>; result?: string | null }; decisionId?: string; assignmentId?: string;
  live?: { status: string; phase: string; next: string; tone: 'info' | 'warn' | 'ok' | 'err'; settled: boolean };
}
export interface ProcessBackends { processId: string; projectId: string; projectName: string | null; connectorEnabled: boolean; subscriptionVerified: boolean; projectAuthorized: boolean; fallback: 'none' | 'api'; ready: boolean;
  team: { agentId: string; name: string; roles: string[]; backend: ExecutionBackend; label: string; ready: boolean; reason: string | null; problem: string | null }[];
  cli: { installed: boolean; version: string | null; authMethod: string | null; subscriptionType: string | null; verified: boolean; checkedAt: string | null };
  worker: { managedAvailable: boolean; running: number; maxConcurrent: number };
  scope: string[]; nextOperation: string | null; staleCorrections: number; corrections: { used: number; max: number } | null;
  /** Solo en la respuesta de «autorizar»: comprobado contra la configuración guardada. */
  verified?: boolean }
export interface AssistantAttachment { name: string; mediaType: string; bytes: number }
/** Artefacto de una conversación con el estado real de su proceso (propuesta, revisión del equipo, borradores). */
export type ConversationArtifactView = ConversationArtifact & {
  process: { id: string; status: string; spentUsd: number; budgetUsd: number | null; estimatedUsd: number | null; steps: { title: string; agentName: string; status: string }[] } | null;
  deliverable: string | null; challenge: { agentName: string; text: string } | null; consulted: { agentName: string; question: string; answer: string }[];
  backlogOps: { op: string; title?: string; criterion?: string; estimate?: string | null; dependsOn?: string | null }[]; opsApplied: { summary: string[] } | null;
};
export type AssignmentView = Assignment & { statusLabel: string; process: { id: string; status: string; spentUsd: number; budgetUsd: number | null; estimatedUsd: number | null; steps: number; pipeline: { state: string; phase: string | null; reason: string | null; corrections: number } | null } | null };
export interface ConversationDetailView { conversation: AssistantConversation; stage: ConversationStage; decisions: ConversationDecision[]; artifacts: ConversationArtifactView[]; assignments: AssignmentView[]; next: string }
export interface UsageGateView { report: ClaudeCodeUsageReport | null; ok: boolean; reason: string | null; warning: string | null }
export interface AssignmentAuthPreview {
  /** Lo que falta para autorizar (o null si está listo). */
  missing: string | null; estimatedUsd: number; suggestedBudgetUsd: number; steps: number; agents: { name: string; role: string | null; model: string | null }[];
  gauntlet: GauntletConfig; suggestedSubscriptionCalls: number; subscription: { ok: boolean; reason?: string; warning?: string | null; report: ClaudeCodeUsageReport | null };
}
export interface AssistantImage { mediaType: string; data: string; name?: string }
export interface AssistantMessage { id: string; role: 'user' | 'assistant'; content: string; actions: AssistantAction[]; attachments: AssistantAttachment[]; tokensIn: number; tokensOut: number; costUsd: number; model: string | null; createdAt: string }
export type ProjectFull = Project & { objectives: Objective[]; context: ContextItem[]; repository: Repository | null; knowledgeCount: number };
export interface BootstrapStatus { providerConnected: boolean; initialized: boolean; workspace: Workspace | null; project: Project | null; agentCount: number }
/** HU-159 · estimación previa de la evaluación organizativa (sin costo). */
export interface OrgEvaluationEstimate {
  scopeKind: 'workspace' | 'project'; projectId: string | null;
  /** Proyecto donde se guardan el proceso y el documento (en una evaluación de empresa, el proyecto activo). */
  anchorProjectId?: string | null;
  steps: { agentId: string; agentName: string; title: string; model: string; estimatedUsd: number }[];
  contextChars: number; estimatedUsd: number; suggestedBudgetUsd: number; approximate: boolean;
  /** Proyectos del ámbito sin repositorio vinculado (la interfaz lo avisa en «Contexto y dirección»). */
  missingRepository?: string[];
}
/** Evaluación con el estado de su proceso (pasos y gasto). */
export type OrgEvaluationView = OrgEvaluation & {
  process: { id: string; status: Process['status']; budgetUsd: number; estimatedUsd: number; spentUsd: number; error?: string | null; steps?: { title: string; agentName: string; status: string }[] } | null;
};
export type OrgEvaluationFilter = { projectId?: string; scope?: 'workspace' | 'project' | 'all' };
/** HU-159 · propuesta con su configuración (spec) y el resultado de aplicarla (cambios con fotos previas). */
export type OrgProposalView = OrgProposal & { spec?: OrgProposalSpec; application?: OrgApplication };
export type { OrgApplication, OrgBriefAttachment, OrgChange, OrgEvaluationBrief, OrgProposalSpec };
/** Respuesta de decidir o deshacer una propuesta. */
export interface OrgProposalResult { evaluation: OrgEvaluation; proposal: OrgProposalView }

export const api = {
  health: () => request<{ ok: boolean; dataDir: string; repoRoot: string; version: string }>('/api/health'),
  providers: () => request<ProviderView[]>('/api/providers'),
  saveCredential: (id: string, apiKey: string, workspaceId?: string | null) => request<ProviderView>(`/api/providers/${id}/credential`, { method: 'PUT', body: JSON.stringify({ apiKey, workspaceId }) }),
  saveProviderSettings: (id: string, workspaceId: string | null) => request<ProviderView>(`/api/providers/${id}/settings`, { method: 'PUT', body: JSON.stringify({ workspaceId }) }),
  deleteCredential: (id: string) => request<ProviderView>(`/api/providers/${id}/credential`, { method: 'DELETE' }),
  /** Devuelve la vista aunque falle (status 'failed' con lastError). */
  verify: async (id: string): Promise<ProviderView> => {
    try { return await request<ProviderView>(`/api/providers/${id}/verify`, { method: 'POST' }); }
    catch (e) { if (e instanceof ApiError && e.body?.status) return e.body as ProviderView; throw e; }
  },
  setDefaultModel: (id: string, modelId: string) => request<ProviderView>(`/api/providers/${id}/default-model`, { method: 'PUT', body: JSON.stringify({ modelId }) }),
  fsRoots: () => request<FsEntry[]>('/api/fs/roots'),
  fsDirs: (path?: string) => request<FsListing>(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  bootstrapStatus: () => request<BootstrapStatus>('/api/bootstrap/status'),
  bootstrap: () => request<BootstrapResult>('/api/bootstrap/internal', { method: 'POST' }),
  workspaces: () => request<Workspace[]>('/api/workspaces'),
  projects: (slug: string) => request<ProjectFull[]>(`/api/workspaces/${slug}/projects`),
  usageToday: (slug: string) => request<UsageToday>(`/api/workspaces/${slug}/usage/today`),
  registerRepository: (slug: string, projectId: string, path: string) =>
    request<Repository>(`/api/workspaces/${slug}/projects/${projectId}/repository`, { method: 'POST', body: JSON.stringify({ path, authorized: true }) }),
  agents: (slug: string) => request<Agent[]>(`/api/workspaces/${slug}/agents`),
  // Conector «Claude Code — Local»
  claudeCode: () => request<ClaudeCodeStatusView>('/api/claude-code'),
  claudeCodeDetect: () => request<ClaudeCodeStatusView>('/api/claude-code/detect', { method: 'POST' }),
  claudeCodeSettings: (patch: Record<string, unknown>) => request<ClaudeCodeStatusView>('/api/claude-code/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  claudeCodeSmokeTest: () => request<{ ok: boolean; answer: string; authMethod: string | null; subscriptionType: string | null; apiKeySource: string | null; tokensIn: number; tokensOut: number; apiEquivalentUsd: number | null; durationMs: number; apiBudgetChargedUsd: number }>('/api/claude-code/smoke-test', { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  agentClaudeCode: (slug: string, id: string) => request<{ backend: ExecutionBackend; status: ClaudeCodeStatusView; projects: { id: string; authorized: boolean }[]; limits: { maxConcurrent: number; maxDurationSec: number; maxTurns: number; repoRead: boolean; fallback: 'none' | 'api' }; usage: ClaudeCodeUsage; runs: ClaudeCodeRun[]; consoles: { id: string; name: string; connected: boolean; expired: boolean }[] }>(`/api/workspaces/${slug}/agents/${id}/claude-code`),
  decideAssistantOperation: (messageId: string, operationId: string, decision: 'approve' | 'reject') => request<{ message: AssistantMessage }>(`/api/assistant/messages/${messageId}/operations/${operationId}/${decision}`, { method: 'POST', body: JSON.stringify(decision === 'approve' ? { authorized: true } : {}) }),
  processBackends: (slug: string, id: string) => request<ProcessBackends>(`/api/workspaces/${slug}/processes/${id}/backends`),
  claudeCodeFix: (slug: string, id: string, fix: { authorizeProject: boolean; switchToManaged: string[] }) => request<ProcessBackends>(`/api/workspaces/${slug}/processes/${id}/claude-code/fix`, { method: 'POST', body: JSON.stringify({ authorized: true, ...fix }) }),
  claudeCodeWorkspace: (slug: string) => request<ClaudeCodeWorkspaceView>(`/api/workspaces/${slug}/claude-code`),
  claudeCodeProjects: (slug: string, projectIds: string[]) => request<{ projects: string[] }>(`/api/workspaces/${slug}/claude-code/projects`, { method: 'PUT', body: JSON.stringify({ authorized: true, projectIds }) }),
  setAgentBackend: (slug: string, id: string, backend: ExecutionBackend) => request<Agent>(`/api/workspaces/${slug}/agents/${id}/backend`, { method: 'PUT', body: JSON.stringify(backend === 'api' ? { backend } : { backend, authorized: true }) }),
  createClaudeCodeWorker: (slug: string, name: string, agentIds: string[]) => request<{ worker: ClaudeCodeWorkerView; token: string; setup: { cwd: string; command: string; args: string[] } }>(`/api/workspaces/${slug}/claude-code/workers`, { method: 'POST', body: JSON.stringify({ authorized: true, name, agentIds }) }),
  revokeClaudeCodeWorker: (slug: string, id: string) => request<ClaudeCodeWorkerView>(`/api/workspaces/${slug}/claude-code/workers/${id}`, { method: 'DELETE' }),
  agent: (slug: string, id: string) => request<Agent>(`/api/workspaces/${slug}/agents/${id}`),
  updateAgentConfig: (slug: string, id: string, config: AgentConfig) => request<Agent>(`/api/workspaces/${slug}/agents/${id}/config`, { method: 'PUT', body: JSON.stringify(config) }),
  createAgent: (slug: string, input: AgentCreateInput) => request<Agent>(`/api/workspaces/${slug}/agents`, { method: 'POST', body: JSON.stringify(input) }),
  deleteAgent: (slug: string, id: string) => request<{ ok: boolean }>(`/api/workspaces/${slug}/agents/${id}`, { method: 'DELETE' }),
  draftEstimate: (slug: string) => request<{ model: string; byAgent: string; estimatedUsd: number }>(`/api/workspaces/${slug}/agents/draft/estimate`),
  draftAgent: (slug: string, description: string, scope: 'workspace' | 'project', maxUsd: number) => request<AgentDraftResult>(`/api/workspaces/${slug}/agents/draft`, { method: 'POST', body: JSON.stringify({ description, scope, authorized: true, maxUsd }) }),
  // HU-004 · procesos autorizados y conocimiento
  assessmentEstimate: (slug: string, projectId: string) => request<AssessmentEstimate>(`/api/workspaces/${slug}/projects/${projectId}/assessment/estimate`),
  createAssessment: (slug: string, projectId: string) => request<Process>(`/api/workspaces/${slug}/projects/${projectId}/assessment`, { method: 'POST' }),
  processes: (slug: string, projectId: string) => request<Process[]>(`/api/workspaces/${slug}/projects/${projectId}/processes`),
  process: (slug: string, id: string) => request<Process>(`/api/workspaces/${slug}/processes/${id}`),
  /** Autoriza un proceso. En historias, `pipeline` incluye en ESTA autorización aplicar, verificar, QA con evidencia y correcciones acotadas. */
  authorizeProcess: (slug: string, id: string, budgetUsd: number, pipeline?: PipelineConfig) => request<Process>(`/api/workspaces/${slug}/processes/${id}/authorize`, { method: 'POST', body: JSON.stringify({ budgetUsd, authorized: true, ...(pipeline ? { pipeline } : {}) }) }),
  /** Continuar de forma autónoma (pipeline pausado/detenido, proceso sin pipeline o entrega a reparar). Autorizado por el propietario. Si el equipo preguntó algo, `answer` es obligatoria y llega una vez al agente que lo pidió. */
  continueProcess: (slug: string, id: string, body: { addBudgetUsd?: number; pipeline?: Partial<PipelineConfig>; answer?: string }) => request<Process>(`/api/workspaces/${slug}/processes/${id}/continue`, { method: 'POST', body: JSON.stringify({ authorized: true, ...body }) }),
  integrationPrepare: (slug: string, id: string) => request<Process & { note?: string }>(`/api/workspaces/${slug}/processes/${id}/integration/prepare`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  integrationResolve: (slug: string, id: string, addBudgetUsd?: number) => request<Process>(`/api/workspaces/${slug}/processes/${id}/integration/resolve`, { method: 'POST', body: JSON.stringify({ authorized: true, ...(addBudgetUsd ? { addBudgetUsd } : {}) }) }),
  registerExternalCorrection: (slug: string, id: string, body: { commit: string; note: string }) => request<Process>(`/api/workspaces/${slug}/processes/${id}/external-correction`, { method: 'POST', body: JSON.stringify({ authorized: true, ...body }) }),
  cancelProcess: (slug: string, id: string) => request<Process>(`/api/workspaces/${slug}/processes/${id}/cancel`, { method: 'POST' }),
  knowledge: (slug: string, projectId: string) => request<KnowledgeDoc[]>(`/api/workspaces/${slug}/projects/${projectId}/knowledge`),
  // HU-159 · evaluación organizativa (solo «start» llama a la IA, con autorización explícita y presupuesto)
  /** `briefChars`: tamaño del contexto aportado en «Contexto y dirección», para que el presupuesto lo incluya. */
  orgEvaluationEstimate: (slug: string, projectId: string | null, anchorProjectId?: string | null, briefChars = 0) => {
    const q = new URLSearchParams();
    if (projectId) q.set('projectId', projectId);
    if (!projectId && anchorProjectId) q.set('anchorProjectId', anchorProjectId);
    if (briefChars > 0) q.set('briefChars', String(Math.floor(briefChars)));
    const qs = q.toString();
    return request<OrgEvaluationEstimate>(`/api/workspaces/${slug}/org-evaluations/estimate${qs ? `?${qs}` : ''}`);
  },
  /** En una evaluación de empresa, `anchorProjectId` (proyecto activo) indica dónde se guardan el proceso y el documento. `brief` (paso «Contexto y dirección») es obligatorio: sin él el servidor responde 400 brief_required. */
  startOrgEvaluation: (slug: string, projectId: string | null, budgetUsd: number, anchorProjectId: string | null | undefined, brief: OrgEvaluationBrief) => request<OrgEvaluationView>(`/api/workspaces/${slug}/org-evaluations`, { method: 'POST', body: JSON.stringify({ projectId, budgetUsd, authorized: true, brief, ...(!projectId && anchorProjectId ? { anchorProjectId } : {}) }) }),
  orgEvaluations: (slug: string, filter: OrgEvaluationFilter = {}) => {
    const q = new URLSearchParams();
    if (filter.projectId) q.set('projectId', filter.projectId);
    if (filter.scope) q.set('scope', filter.scope);
    const qs = q.toString();
    return request<OrgEvaluationView[]>(`/api/workspaces/${slug}/org-evaluations${qs ? `?${qs}` : ''}`);
  },
  orgEvaluation: (slug: string, id: string) => request<OrgEvaluationView>(`/api/workspaces/${slug}/org-evaluations/${encodeURIComponent(id)}`),
  /** Aceptar APLICA la propuesta (crea, ajusta o retira agentes, sin costo de IA, con «Deshacer»). Rechazar solo registra la decisión y se puede reabrir. La interfaz confirma antes de llamar, así que siempre se envía confirm. */
  decideOrgProposal: (slug: string, id: string, proposalId: string, decision: Exclude<OrgDecision, 'pending'>) =>
    request<OrgProposalResult>(`/api/workspaces/${slug}/org-evaluations/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}`, { method: 'POST', body: JSON.stringify({ decision, confirm: true }) }),
  /** Reabre una propuesta rechazada: vuelve a pendiente (409 not_rejected si no está rechazada). Sin IA. */
  reopenOrgProposal: (slug: string, id: string, proposalId: string) =>
    request<OrgProposalResult>(`/api/workspaces/${slug}/org-evaluations/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/reopen`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  /** Vuelve a aplicar una propuesta deshecha, validada contra la organización actual (422 si el sujeto ya no es válido). Sin IA. */
  reapplyOrgProposal: (slug: string, id: string, proposalId: string) =>
    request<OrgProposalResult>(`/api/workspaces/${slug}/org-evaluations/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/reapply`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  /** Deshace una propuesta aplicada restaurando el estado previo (409 stale_undo si el agente cambió después). */
  undoOrgProposal: (slug: string, id: string, proposalId: string) =>
    request<OrgProposalResult>(`/api/workspaces/${slug}/org-evaluations/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/undo`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  // HU-005 · backlog y ejecución de historias
  // Etapas operativas: archivo reversible del trabajo activo (el conocimiento se conserva)
  phase: (slug: string, projectId: string) => request<{ current: PhaseTransition | null; transitions: PhaseTransition[]; defaultName: string }>(`/api/workspaces/${slug}/projects/${projectId}/phase`),
  phasePreview: (slug: string, projectId: string, name?: string) => request<PhaseTransitionPreview>(`/api/workspaces/${slug}/projects/${projectId}/phase/preview${name ? `?name=${encodeURIComponent(name)}` : ''}`),
  startPhase: (slug: string, projectId: string, name: string) => request<PhaseTransition>(`/api/workspaces/${slug}/projects/${projectId}/phase`, { method: 'POST', body: JSON.stringify({ name, authorized: true }) }),
  revertPhase: (slug: string, projectId: string, id: string, reason?: string) => request<PhaseTransition>(`/api/workspaces/${slug}/projects/${projectId}/phase/${id}/revert`, { method: 'POST', body: JSON.stringify({ authorized: true, reason }) }),
  archive: (slug: string, projectId: string) => request<ProjectArchive>(`/api/workspaces/${slug}/projects/${projectId}/archive`),
  restoreStory: (slug: string, id: string) => request<BacklogItem>(`/api/workspaces/${slug}/backlog/${id}/restore`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  backlog: (slug: string, projectId: string) => request<BacklogItem[]>(`/api/workspaces/${slug}/projects/${projectId}/backlog`),
  importBacklog: (slug: string, projectId: string, opts?: { authorized: true; maxUsd: number }) => request<{ imported: number; total: number; source: string | null; parsed: number; usedAI: boolean; costUsd: number }>(`/api/workspaces/${slug}/projects/${projectId}/backlog/import`, { method: 'POST', body: JSON.stringify(opts ?? {}) }),
  importEstimate: (slug: string, projectId: string) => request<{ model: string | null; byAgent: string | null; estimatedUsd: number }>(`/api/workspaces/${slug}/projects/${projectId}/backlog/import/estimate`),
  createWorkspace: (name: string) => request<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) }),
  createProject: (slug: string, name: string, description?: string) => request<Project>(`/api/workspaces/${slug}/projects`, { method: 'POST', body: JSON.stringify({ name, description }) }),
  assistant: (conversationId?: string | null) => request<{ info: AssistantInfo; conversations: AssistantConversation[]; conversationId: string | null; messages: AssistantMessage[]; detail: ConversationDetailView | null }>(`/api/assistant${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`),
  createConversation: (body: { title?: string; workspaceSlug?: string | null; projectId?: string | null }) => request<AssistantConversation>('/api/assistant/conversations', { method: 'POST', body: JSON.stringify(body) }),
  updateConversation: (id: string, body: { title?: string; workspaceSlug?: string | null; projectId?: string | null; status?: 'active' | 'archived' }) => request<AssistantConversation>(`/api/assistant/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  decideDecision: (conversationId: string, decisionId: string, action: 'approve' | 'reject' | 'defer' | 'revise' | 'reopen', body: { answer?: string | null; note?: string | null } = {}) => request<ConversationDecision>(`/api/assistant/conversations/${conversationId}/decisions/${decisionId}/${action}`, { method: 'POST', body: JSON.stringify(body) }),
  startArtifact: (conversationId: string, kind: 'proposal' | 'team_review' | 'stories') => request<{ artifact: ConversationArtifact; estimatedUsd: number; suggestedBudgetUsd: number }>(`/api/assistant/conversations/${conversationId}/artifacts`, { method: 'POST', body: JSON.stringify({ kind }) }),
  decideArtifact: (conversationId: string, artifactId: string, decision: 'approve' | 'reject', note?: string) => request<ConversationArtifact>(`/api/assistant/conversations/${conversationId}/artifacts/${artifactId}/${decision}`, { method: 'POST', body: JSON.stringify(note ? { note } : {}) }),
  createStoriesFromArtifact: (conversationId: string, artifactId: string) => request<{ summary: string[] }>(`/api/assistant/conversations/${conversationId}/artifacts/${artifactId}/create-stories`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  decideLocal: (messageId: string, index: number, decision: 'approve' | 'reject') => request<{ message: AssistantMessage }>(`/api/assistant/messages/${messageId}/local/${index}/${decision}`, { method: 'POST', body: JSON.stringify(decision === 'approve' ? { authorized: true } : {}) }),
  assignment: (slug: string, id: string) => request<AssignmentView>(`/api/workspaces/${slug}/assignments/${id}`),
  assignmentAuthorization: (slug: string, id: string) => request<AssignmentAuthPreview>(`/api/workspaces/${slug}/assignments/${id}/authorization`),
  authorizeAssignment: (slug: string, id: string, body: { budgetUsd: number; maxSubscriptionCalls?: number; gauntlet?: { mode: 'auto' | 'off' | 'standard' | 'deep' } }) => request<{ assignment: Assignment }>(`/api/workspaces/${slug}/assignments/${id}/authorize`, { method: 'POST', body: JSON.stringify({ ...body, authorized: true }) }),
  acceptAssignment: (slug: string, id: string, note: string | null) => request<Assignment>(`/api/workspaces/${slug}/assignments/${id}/accept`, { method: 'POST', body: JSON.stringify(note ? { note } : {}) }),
  requestAssignmentChanges: (slug: string, id: string, note: string) => request<Assignment>(`/api/workspaces/${slug}/assignments/${id}/changes`, { method: 'POST', body: JSON.stringify({ note }) }),
  cancelAssignment: (slug: string, id: string) => request<Assignment>(`/api/workspaces/${slug}/assignments/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) }),
  claudeCodeUsage: () => request<UsageGateView>('/api/claude-code/usage'),
  acknowledgeUsage: () => request<UsageGateView>('/api/claude-code/usage/acknowledge', { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  sendAssistant: (text: string, images: AssistantImage[] = [], files: AssistantAttachment[] = [], conversationId: string | null = null) => request<{ user: AssistantMessage; assistant: AssistantMessage; info: AssistantInfo; conversationId: string }>('/api/assistant/messages', { method: 'POST', body: JSON.stringify({ conversationId, text, images: images.length ? images : undefined, files: files.length ? files : undefined }) }),
  resolveAssistantProposal: (messageId: string, processId: string, status: 'done' | 'failed', detail?: string) => request<{ message: AssistantMessage }>(`/api/assistant/messages/${messageId}/resolve`, { method: 'POST', body: JSON.stringify({ processId, status, detail }) }),
  clearAssistant: () => request<{ ok: boolean }>('/api/assistant/messages', { method: 'DELETE' }),
  addBacklogItem: (slug: string, projectId: string, input: { title: string; description?: string; criterion?: string; ownerKey?: string | null; estimate?: 'S' | 'M' | 'L' | null }) => request<BacklogItem>(`/api/workspaces/${slug}/projects/${projectId}/backlog`, { method: 'POST', body: JSON.stringify(input) }),
  patchBacklogItem: (slug: string, id: string, patch: Partial<Pick<BacklogItem, 'title' | 'criterion' | 'description' | 'ownerKey' | 'estimate' | 'dependsOn'>> & { status?: BacklogStatus }) => request<BacklogItem>(`/api/workspaces/${slug}/backlog/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteBacklogItem: (slug: string, id: string) => request<{ ok: boolean }>(`/api/workspaces/${slug}/backlog/${id}`, { method: 'DELETE' }),
  storyEstimate: (slug: string, projectId: string, id: string, skipQa = false, team?: { add?: string[]; remove?: string[] }) => { const q = new URLSearchParams(); if (skipQa) q.set('skipQa', '1'); if (team?.add?.length) q.set('add', team.add.join(',')); if (team?.remove?.length) q.set('remove', team.remove.join(',')); const qs = q.toString(); return request<AssessmentEstimate>(`/api/workspaces/${slug}/projects/${projectId}/backlog/${id}/estimate${qs ? `?${qs}` : ''}`); },
  executeStory: (slug: string, projectId: string, id: string, skipQa = false, team?: { add?: string[]; remove?: string[] }) => request<Process>(`/api/workspaces/${slug}/projects/${projectId}/backlog/${id}/execute`, { method: 'POST', body: JSON.stringify({ skipQa, team }) }),
  agentStats: (slug: string, id: string) => request<{ steps: number; done: number; failed: number; costUsd: number; byRole: Record<string, number>; lastAt: string | null }>(`/api/workspaces/${slug}/agents/${id}/stats`),
  repoStatus: (slug: string, projectId: string) => request<RepoStatus & { portalRoot: string }>(`/api/workspaces/${slug}/projects/${projectId}/repository/status`),
  repoInitMain: (slug: string, projectId: string) => request<{ mainBranch: string; from: string }>(`/api/workspaces/${slug}/projects/${projectId}/repository/init-main`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  repoSetRemote: (slug: string, projectId: string, url: string) => request<{ remote: string; url: string }>(`/api/workspaces/${slug}/projects/${projectId}/repository/remote`, { method: 'POST', body: JSON.stringify({ authorized: true, url }) }),
  repoNormalizeEol: (slug: string, projectId: string) => request<{ commit: string | null; files: number }>(`/api/workspaces/${slug}/projects/${projectId}/repository/normalize-eol`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  repoPublishMain: (slug: string, projectId: string) => request<{ remote: string; url: string | null; branches: string[] }>(`/api/workspaces/${slug}/projects/${projectId}/repository/publish-main`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  systemStatus: () => request<SystemStatus>('/api/system/status'),
  systemUpdate: (opts: { install?: boolean; restart?: boolean } = {}) => request<{ update: NonNullable<SystemStatus['update']>; install: boolean }>('/api/system/update', { method: 'POST', body: JSON.stringify({ authorized: true, ...opts }) }),
  delegationEstimate: (slug: string, body: { projectId?: string | null; agent?: string; request: string }) => request<AssessmentEstimate & { leadAgentId: string; teamSize: number }>(`/api/workspaces/${slug}/delegations/estimate`, { method: 'POST', body: JSON.stringify(body) }),
  createDelegation: (slug: string, body: { projectId?: string | null; agent?: string; request: string }) => request<Process>(`/api/workspaces/${slug}/delegations`, { method: 'POST', body: JSON.stringify(body) }),
  applyBacklogOps: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/backlog-ops/apply`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  manualTest: (slug: string, processId: string, checks: boolean[], note?: string | null) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/manual-test`, { method: 'POST', body: JSON.stringify({ checks, note }) }),
  manualTestSteps: (slug: string, processId: string, steps: string[]) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/manual-test`, { method: 'POST', body: JSON.stringify({ steps }) }),
  manualTestEstimate: (slug: string, processId: string) => request<{ agentName: string; model: string; estimatedUsd: number }>(`/api/workspaces/${slug}/processes/${processId}/manual-test/estimate`),
  manualTestGenerate: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/manual-test/generate`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  rejectProcess: (slug: string, processId: string, reason?: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  resetStory: (slug: string, id: string, reason?: string) => request<BacklogItem>(`/api/workspaces/${slug}/backlog/${id}/reset`, { method: 'POST', body: JSON.stringify({ reason }) }),
  recoverProcess: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/recover`, { method: 'POST' }),
  retryProcess: (slug: string, processId: string, skipQa = false) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/retry`, { method: 'POST', body: JSON.stringify({ skipQa }) }),
  mergeProcess: (slug: string, processId: string, skipVerification = false) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/merge`, { method: 'POST', body: JSON.stringify({ authorized: true, skipVerification }) }),
  publishProcess: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/publish`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  applyChanges: (slug: string, processId: string, branch?: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/apply`, { method: 'POST', body: JSON.stringify({ authorized: true, branch }) }),
  verifyProcess: (slug: string, processId: string, command: 'install' | 'typecheck' | 'test' | 'build', allowNetwork = false) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/verify`, { method: 'POST', body: JSON.stringify({ authorized: true, command, allowNetwork }) }),
  /** M2 · el Portal se comprueba a sí mismo (HTTP y navegador) una vez activado el cambio. */
  runtimeCheck: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/runtime-check`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  systemSandbox: (force = false) => request<{ available: 'docker' | 'wsl' | 'host-min' | 'unavailable'; docker: boolean; wsl: boolean; detail: string; checkedAt: string }>(`/api/system/sandbox${force ? '?force=1' : ''}`),
  systemPolicy: () => request<{ op: string; level: 'local' | 'auth' | 'external'; tool: string | null; label: string }[]>('/api/system/policy'),
  markStoryDone: (slug: string, id: string, opts?: { force: boolean; reason?: string }) => request<BacklogItem>(`/api/workspaces/${slug}/backlog/${id}/done`, { method: 'POST', body: opts ? JSON.stringify(opts) : undefined }),
  // M6 · espacio de la historia
  story: (slug: string, id: string) => request<StoryContext>(`/api/workspaces/${slug}/stories/${id}`),
  storyAskEstimate: (slug: string, id: string, agentId?: string | null) => request<{ agentId: string; agentName: string; model: string; estimatedUsd: number }>(`/api/workspaces/${slug}/stories/${id}/ask/estimate${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`),
  storyMessage: (slug: string, id: string, text: string, ask?: { maxUsd: number; agentId?: string | null }) => request<{ user: StoryMessage; reply: StoryMessage | null }>(`/api/workspaces/${slug}/stories/${id}/messages`, { method: 'POST', body: JSON.stringify(ask ? { text, ask: true, authorized: true, maxUsd: ask.maxUsd, agentId: ask.agentId ?? null } : { text }) }),
  storyApplyProposals: (slug: string, id: string, messageId: string, what: { tasks?: boolean; criterion?: boolean }) => request<StoryContext>(`/api/workspaces/${slug}/stories/${id}/messages/${messageId}/apply`, { method: 'POST', body: JSON.stringify(what) }),
  storyAddTask: (slug: string, id: string, title: string, assigneeAgentId?: string | null, assigneeName?: string | null) => request<StoryTask>(`/api/workspaces/${slug}/stories/${id}/tasks`, { method: 'POST', body: JSON.stringify({ title, assigneeAgentId, assigneeName }) }),
  /** Tareas a partir del problema actual del recorrido (QA, verificación, comprobaciones…). Sin IA. */
  storyTasksFromIssue: (slug: string, id: string) => request<StoryTask[]>(`/api/workspaces/${slug}/stories/${id}/tasks/from-issue`, { method: 'POST' }),
  /** «Faltan las dependencias Linux»: install con red temporal y repetir los comandos pendientes (autorización y red explícitas). */
  installAndRetry: (slug: string, processId: string, commands: string[]) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/verify/install-and-retry`, { method: 'POST', body: JSON.stringify({ authorized: true, allowNetwork: true, commands }) }),
  storyTasksFromFeedback: (slug: string, id: string) => request<StoryTask[]>(`/api/workspaces/${slug}/stories/${id}/tasks/from-feedback`, { method: 'POST' }),
  storySetTask: (slug: string, id: string, taskId: string, status: 'open' | 'done') => request<StoryTask>(`/api/workspaces/${slug}/stories/${id}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  storyDeleteTask: (slug: string, id: string, taskId: string) => request<{ ok: boolean }>(`/api/workspaces/${slug}/stories/${id}/tasks/${taskId}`, { method: 'DELETE' }),
  /** reopen: reabre una historia cerrada · discardApplied: confirma descartar el worktree y la rama de la iteración aplicada sin integrar. */
  storyIterate: (slug: string, id: string, note?: string | null, opts: { reopen?: boolean; discardApplied?: boolean } = {}) => request<{ process: Process; context: string; actions: string[] }>(`/api/workspaces/${slug}/stories/${id}/iterate`, { method: 'POST', body: JSON.stringify({ note: note ?? null, ...opts }) }),
  // M4 · lecciones validadas
  lessons: (slug: string, projectId?: string | null, status?: string) => { const q = new URLSearchParams(); if (projectId) q.set('projectId', projectId); if (status) q.set('status', status); const qs = q.toString(); return request<Lesson[]>(`/api/workspaces/${slug}/lessons${qs ? `?${qs}` : ''}`); },
  createLesson: (slug: string, input: { projectId: string | null; title: string; lessonText: string; role?: string | null; tags?: string[] }) => request<Lesson>(`/api/workspaces/${slug}/lessons`, { method: 'POST', body: JSON.stringify(input) }),
  lessonProposeEstimate: (slug: string, id: string) => request<{ agentId: string; agentName: string; model: string; estimatedUsd: number }>(`/api/workspaces/${slug}/lessons/${id}/propose/estimate`),
  lessonPropose: (slug: string, id: string) => request<Lesson>(`/api/workspaces/${slug}/lessons/${id}/propose`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  lessonValidate: (slug: string, id: string, patch: { lessonText?: string; rootCause?: string; correctiveAction?: string; role?: string | null; tags?: string[] } = {}) => request<Lesson>(`/api/workspaces/${slug}/lessons/${id}/validate`, { method: 'POST', body: JSON.stringify(patch) }),
  lessonReject: (slug: string, id: string) => request<Lesson>(`/api/workspaces/${slug}/lessons/${id}/reject`, { method: 'POST' }),
  lessonObsolete: (slug: string, id: string) => request<Lesson>(`/api/workspaces/${slug}/lessons/${id}/obsolete`, { method: 'POST' }),
  lessonPromote: (slug: string, id: string, targetKey?: string | null) => request<AgentTemplateVersion>(`/api/workspaces/${slug}/lessons/${id}/promote`, { method: 'POST', body: JSON.stringify({ authorized: true, targetKey }) }),
  detectLessons: (slug: string, processId: string) => request<Lesson[]>(`/api/workspaces/${slug}/processes/${processId}/detect-lessons`, { method: 'POST' }),
  // M5 · plantillas versionadas
  agentTemplate: (slug: string, id: string, to?: string) => request<{ current: AgentTemplateVersion | null; latest: AgentTemplateVersion | null; versions: AgentTemplateVersion[]; history: { fromVersion: string | null; toVersion: string; at: string; by: string }[]; diff: { from: string | null; to: string; added: string[]; removed: string[]; diffMd: string } | null; templateVersion: string | null }>(`/api/workspaces/${slug}/agents/${id}/template${to ? `?to=${encodeURIComponent(to)}` : ''}`),
  setAgentTemplateVersion: (slug: string, id: string, version: string) => request<Agent>(`/api/workspaces/${slug}/agents/${id}/template-version`, { method: 'POST', body: JSON.stringify({ authorized: true, version }) }),
  // HU-133 / HU-138 · presupuestos jerárquicos (empresa > proyecto) con saldo real
  getBudgetBalance: (level: BudgetLevel, id: string, workspace?: string, period?: string) => {
    const q = new URLSearchParams();
    if (workspace) q.set('workspace', workspace);
    if (period) q.set('period', period);
    const qs = q.toString();
    return request<BudgetBalance>(`/api/budgets/${level}/${encodeURIComponent(id)}/balance${qs ? `?${qs}` : ''}`);
  },
  /** Fija el presupuesto mensual del periodo actual (UTC). No tiene costo de IA, pero exige confirmación explícita. */
  setMonthlyBudget: (level: BudgetLevel, id: string, limitUsd: number, workspace?: string) =>
    request<BudgetBalance>(`/api/budgets/${level}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ workspace, limitUsd, authorized: true }) }),
  // HU-009 / HU-137 · bandeja de autorizaciones
  inbox: (slug: string) => request<PendingDecision[]>(`/api/workspaces/${slug}/inbox`),
  decideInbox: (slug: string, kind: PendingDecisionKind, processId: string, verdict: DecisionVerdict, reason?: string) =>
    request<InboxDecisionResult>(`/api/workspaces/${slug}/inbox/${kind}/${processId}/decision`, { method: 'POST', body: JSON.stringify({ verdict, reason: reason?.trim() ? reason.trim() : undefined }) }),
  // HU-161 · una autorización vigente por historia: historial (vigente + superadas) y restauración reversible sin costo.
  storyDecisions: (slug: string, storyId: string) => request<StoryDecisionHistory>(`/api/workspaces/${slug}/stories/${encodeURIComponent(storyId)}/decisions`),
  restoreSuperseded: (slug: string, processId: string) =>
    request<RestoreSupersededResult>(`/api/workspaces/${slug}/inbox/superseded/${encodeURIComponent(processId)}/restore`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  // Evaluación Gauntlet: modo del proyecto, recomendación por historia y el Evaluador (aprobación organizativa).
  projectGauntlet: (slug: string, projectId: string) => request<GauntletProjectInfo>(`/api/workspaces/${slug}/projects/${projectId}/gauntlet`),
  setProjectGauntlet: (slug: string, projectId: string, g: GauntletConfig) => request<{ config: GauntletConfig }>(`/api/workspaces/${slug}/projects/${projectId}/gauntlet`, { method: 'PUT', body: JSON.stringify({ ...g, authorized: true }) }),
  gauntletAdvice: (slug: string, projectId: string, itemId: string) => request<GauntletAdvice>(`/api/workspaces/${slug}/projects/${projectId}/backlog/${itemId}/gauntlet`),
  createEvaluator: (slug: string, projectId: string, opts: { model?: string; effort?: 'low' | 'medium' | 'high' } = {}) => request<Agent>(`/api/workspaces/${slug}/projects/${projectId}/gauntlet/evaluator`, { method: 'POST', body: JSON.stringify({ authorized: true, ...opts }) }),
  // Ejecución continua del backlog (lotes autorizados).
  batches: (slug: string, projectId: string) => request<BatchView[]>(`/api/workspaces/${slug}/projects/${projectId}/batches`),
  batch: (slug: string, id: string) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}`),
  previewBatch: (slug: string, projectId: string, body: BatchRequest) => request<BatchPreview>(`/api/workspaces/${slug}/projects/${projectId}/batches/preview`, { method: 'POST', body: JSON.stringify(body) }),
  createBatch: (slug: string, projectId: string, body: BatchRequest) => request<BatchView>(`/api/workspaces/${slug}/projects/${projectId}/batches`, { method: 'POST', body: JSON.stringify({ ...body, authorized: true }) }),
  batchControl: (slug: string, id: string, action: 'pause' | 'resume' | 'cancel' | 'revoke', body: Record<string, unknown> = {}) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/${action}`, { method: 'POST', body: JSON.stringify(action === 'resume' ? { ...body, authorized: true } : body) }),
  acceptBatchItems: (slug: string, id: string, itemIds: string[], note?: string, checks?: Record<string, boolean[]>) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/accept`, { method: 'POST', body: JSON.stringify({ itemIds, note: note?.trim() || undefined, checks }) }),
  rejectBatchItem: (slug: string, id: string, itemId: string, note: string, failedSteps: string[]) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/items/${itemId}/reject`, { method: 'POST', body: JSON.stringify({ note, failedSteps }) }),
  reopenBatchItem: (slug: string, id: string, itemId: string) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/items/${itemId}/reopen`, { method: 'POST', body: '{}' }),
  iterateBatchItem: (slug: string, id: string, itemId: string, note: string) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/items/${itemId}/iterate`, { method: 'POST', body: JSON.stringify({ authorized: true, note }) }),
  retryBatchItem: (slug: string, id: string, itemId: string) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/items/${itemId}/retry`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  cancelBatchItem: (slug: string, id: string, itemId: string) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/items/${itemId}/cancel`, { method: 'POST', body: '{}' })
};

/** Alcance que el propietario autoriza para un lote (lo normaliza y acota el servidor). */
export interface BatchRequest {
  title?: string; itemIds: string[]; backends?: ('api' | 'claude_code')[]; apiFallback?: boolean;
  totalBudgetUsd: number; perStoryBudgetUsd: number; maxCorrections?: number; maxDurationMin?: number; maxSubscriptionCalls?: number;
  gauntlet?: GauntletConfig; concurrency?: number; commands?: ('typecheck' | 'test' | 'build')[]; allowInstall?: boolean;
  git?: { merge?: boolean; activate?: boolean; publish?: boolean }; autoResume?: boolean;
}

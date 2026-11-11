import type { RestoreSupersededResult, StoryDecisionHistory, MaintenancePlan, MaintenanceSelection } from '@portal-ia/domain';
import type { PipelineConfig, PhaseTransition, PhaseTransitionPreview, ProjectArchive, StoryContext, StoryMessage, StoryTask, Lesson, AgentTemplateVersion, DecisionVerdict, InboxDecisionResult, PendingDecision, PendingDecisionKind, RepoStatus, SystemStatus, Agent, AgentConfig, AgentCreateInput, AgentDraftResult, AssessmentEstimate, BacklogItem, BacklogStatus, BootstrapResult, ContextItem, FsEntry, FsListing, KnowledgeDoc, Objective, Process, Project, ProviderView, Repository, UsageToday, Workspace } from '@portal-ia/domain';

import type { BudgetBalance, BudgetLevel } from '@portal-ia/domain';
import type { BatchPolicyChange, BatchPreview, BatchView, GauntletAdvice, GauntletConfig, GauntletProjectInfo, PreviewRecord } from '@portal-ia/domain';
import type { OrgApplication, OrgBriefAttachment, OrgChange, OrgDecision, OrgEvaluation, OrgEvaluationBrief, OrgProposal, OrgProposalSpec } from '@portal-ia/domain';
import type { ClaudeCodeRun, ClaudeCodeStatusView, ClaudeCodeUsage, ClaudeCodeUsageReport, ClaudeCodeWorkerView, ClaudeCodeWorkspaceView, ExecutionBackend } from '@portal-ia/domain';
import type { Assignment, AssignmentPendingState, AssistantConversation, ConversationArtifact, ConversationDecision, ConversationStage } from '@portal-ia/domain';
/** EN-012: iteración siguiente lista para autorizar (sin IA, sin proceso creado): nota, estimación y pasos. */
export interface AssignmentNextIteration { note: string; estimatedUsd: number; suggestedBudgetUsd: number; steps: number; merged: boolean }
/** EN-012: encargo pendiente del propietario en Decisiones (misma etiqueta que el Asistente y la tarjeta). */
export interface AssignmentPendingItem { id: string; kind: 'awaiting_iteration_authorization' | 'merged_awaiting_acceptance'; assignmentId: string; code: string; title: string; workspaceSlug: string; projectId: string; processId: string | null; label: string; where: string | null; link: string; note: string | null; createdAt: string }
/** HU-196: decisión ya resuelta (historial de la empresa, solo lectura y sin costo). */
export type DecisionHistoryVerdict = 'approve' | 'deny' | 'superseded';
export interface DecisionHistoryItem { id: string; kind: PendingDecisionKind; title: string; workspaceSlug: string; projectId: string; storyId: string | null; processId: string; conversationId: string | null; verdict: DecisionHistoryVerdict; reason: string | null; decidedAt: string }
import type { DocumentBatch, DocumentJob, RemovalPreview, RemovalRecord } from '@portal-ia/domain';
import { noteBundle, noteFailure, noteResponse } from './liveStatus.ts';
import { ownerNeeded, ownerToken, setOwnerToken } from './owner.ts';

/** Invocación real del arnés de un agente (lo que se le pasa de verdad, calculado en el servidor sin ejecutar nada). */
export interface AgentInvocation { harness: ExecutionBackend; model: string; effort: string; modelLevels: string[]; cli: { version: string | null; billing: string; effortLevels: string[]; checkedAt: string } | null; effortPassed: string | null; note: string }
/** HU-187 · Previsualización (solo lectura) de lo que omitiría cerrar una historia como resuelta. */
export interface StoryClosePreview { omittedChecks: string[]; lastProcessId: string | null; merged: boolean }
export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) { super(message); }
}

/**
 * Versión de cada proceso tal como la vio ESTA pestaña (la sirve el servidor). Las acciones sobre un proceso la envían
 * como `seenVersion`: si otra pestaña, un lote o el equipo lo cambiaron mientras tanto, el servidor no hace nada (409
 * `stale_view`) y la pantalla se actualiza para decidir con el estado real.
 */
const seenVersions = new Map<string, string>();
function noteVersions(body: any) {
  const one = (p: any) => { if (p && typeof p === 'object' && typeof p.id === 'string' && typeof p.version === 'string') seenVersions.set(p.id, p.version); };
  if (Array.isArray(body)) body.forEach(one);
  else if (body && typeof body === 'object') { one(body); if (Array.isArray(body.processes)) body.processes.forEach(one); one(body.lastProcess); one(body.process); }
}
const VERSIONED = /\/processes\/([^/?]+)\/(authorize|continue|accept-plan|apply|merge|publish|reject|recover|retry|verify|verify\/install-and-retry|runtime-check|integration\/prepare|integration\/resolve|external-correction|manual-test\/generate|convert-to-analysis)$/;
function withSeenVersion(url: string, init?: RequestInit): RequestInit | undefined {
  const m = init?.method === 'POST' ? url.match(VERSIONED) : null; const v = m ? seenVersions.get(m[1]) : undefined;
  if (!m || !v) return init;
  let body: any = {}; try { body = init!.body ? JSON.parse(String(init!.body)) : {}; } catch { return init; }
  if (!body || typeof body !== 'object' || Array.isArray(body) || 'seenVersion' in body) return init;
  return { ...init, body: JSON.stringify({ ...body, seenVersion: v }) };
}

async function request<T>(url: string, init0?: RequestInit): Promise<T> {
  const init = withSeenVersion(url, init0);
  const headers: Record<string, string> = init?.body ? { 'Content-Type': 'application/json' } : {};
  // Sesión del propietario de este navegador (decidir revisiones y operaciones del Asistente).
  const owner = ownerToken(); if (owner) headers['X-Portal-Owner'] = owner;
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
  // Solo lo que la pantalla va a mostrar cuenta como «visto»: el estado que acompaña a un 409 «stale_view» no (un segundo
  // clic en el mismo botón antiguo también se rechaza hasta que la pantalla se actualiza y lo enseña).
  if (res.ok) noteVersions(body);
  // La sesión ya no vale (caducó o se cerró): la pantalla vuelve a ofrecer vincular este navegador.
  // Hace falta la sesión del propietario: la de este navegador ya no vale (se olvida) o no la tiene; el aviso global se abre.
  if (res.status === 401 && body?.code === 'owner_required') { if (owner) setOwnerToken(null); ownerNeeded(); }
  if (!res.ok) throw new ApiError(res.status, body?.error ?? body?.lastError?.message ?? `Error ${res.status}`, body);
  return body as T;
}

export interface AssistantInfo { agentId: string; name: string; model: string; provider: string; monthlyLimitUsd: number; spentThisMonthUsd: number; estimatedPerMessageUsd: number;
  /** Backend del Asistente y su origen de facturación (se muestran antes de enviar). */
  backend: ExecutionBackend; backendLabel: string; billing: 'api' | 'subscription'; available: boolean; unavailableReason: string | null;
  /** HU-198 · Catálogo que el servidor acepta como `model` por mensaje (vacío: solo el modelo configurado) y, si no se puede elegir, el motivo. */
  models: AssistantModelOption[]; modelsReason: string | null }
/** HU-198 · Modelo elegible en el chat del Asistente con su tipo de costo. */
export interface AssistantModelOption { id: string; label: string; billing: 'api' | 'subscription'; estimatedPerMessageUsd: number }

/** HU-198 · Petición al Asistente con un `model` opcional en el cuerpo (null: el configurado del agente). */
function withModel(model: string | null | undefined) {
  return <T,>(url: string, init?: RequestInit): Promise<T> => {
    if (!model || !init?.body) return request<T>(url, init);
    let body: any; try { body = JSON.parse(String(init.body)); } catch { return request<T>(url, init); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return request<T>(url, init);
    return request<T>(url, { ...init, body: JSON.stringify({ ...body, model }) });
  };
}
export type AssistantActionType = 'create_company' | 'create_project' | 'add_backlog_item' | 'propose_execution' | 'propose_apply' | 'propose_delegation' | 'propose_operation' | 'propose_local' | 'open_decision' | 'propose_assignment' | 'info';
export interface AssistantAction {
  type: AssistantActionType; status: 'done' | 'failed' | 'pending' | 'running' | 'rejected'; label: string; detail?: string; link?: string;
  operation?: { id: string; capability: string; params: Record<string, unknown>; preview: { ok: boolean; title: string; details: string[]; blockers: string[]; excluded: string[]; planId?: string | null; reviewPath?: string | null; target?: { workspace: string; projectId: string; projectName: string } }; result?: { summary: string; details: string[] } | null; decidedAt?: string | null };
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
export type AssignmentView = Assignment & { statusLabel: string; pending: AssignmentPendingState; nextIteration: AssignmentNextIteration | null; process: { id: string; status: string; spentUsd: number; budgetUsd: number | null; estimatedUsd: number | null; steps: number; resumable?: boolean; ownerRound?: boolean; question?: string | null; pipeline: { state: string; phase: string | null; reason: string | null; corrections: number } | null; changes?: { path: string; action: string; before: number; after: number }[]; applied?: { branch: string; commit: string } | null; merged?: { commit: string; into: string; mergedAt: string } | null; checks?: { command: string; exitCode: number | null; isolation: string | null; passed: boolean; preexisting: number }[]; qa?: string | null; gauntlet?: string | null; ack?: { preexisting: string[]; testUpdates: string[] } } | null };
export interface ConversationDetailView { conversation: AssistantConversation; stage: ConversationStage; decisions: ConversationDecision[]; artifacts: ConversationArtifactView[]; assignments: AssignmentView[]; next: string }
export interface UsageGateView { report: ClaudeCodeUsageReport | null; ok: boolean; reason: string | null; warning: string | null }
export interface AssignmentAuthPreview {
  /** Lo que falta para autorizar (o null si está listo). */
  missing: string | null; estimatedUsd: number; suggestedBudgetUsd: number; steps: number; agents: { name: string; role: string | null; model: string | null }[];
  gauntlet: GauntletConfig; suggestedSubscriptionCalls: number; subscription: { ok: boolean; reason?: string; warning?: string | null; report: ClaudeCodeUsageReport | null };
  /** Rama de una versión anterior aplicada sin integrar: otra ejecución exige descartarla (con tu confirmación). */
  discardBranch: string | null;
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

/** EN-011 · «Qué sabe hacer»: herramientas concedidas en lenguaje claro y estado del sandbox (no ejecuta nada). */
export interface AgentCapabilityTool { tool: string; label: string; where: ('portal' | 'authorized' | 'sandbox')[]; whereText: string; skill: string | null; description: string; inFolder: boolean }
export interface AgentCapabilitiesView {
  tools: AgentCapabilityTool[];
  sandbox: { checked: boolean; available: boolean; kind: string | null; detail: string | null; checkedAt?: string | null } | null;
  note?: string;
}
/** EN-011 · Entrada de aprendizaje pendiente o relacionada (sigue esperando la verificación del propietario). */
export interface AgentLearningEntry { id: string; title: string; text: string; detail: string; status: string; detector: string; at: string; processId: string | null; processTitle: string | null; link: 'evidencia' | 'paso' | null }
export interface AgentLearningView { verified: { title: string; text: string; [k: string]: unknown }[]; pending: AgentLearningEntry[]; related: AgentLearningEntry[]; note: string }
/** HU-202 · Resumen de una depuración del Curador de Aprendizaje (sin IA, 0 USD). */
export interface LessonCurateSummary { applied: number; merged: number; discarded: number; groups: number; appliedIds: string[] }
/** EN-011 · Resumen «Qué trae y qué aprendió» de una importación de ZIP (sin IA). */
export interface ImportLearnedSkill { slug: string; name: string; description: string; base: boolean; note: string | null }
export interface ImportLearned {
  skillsNew: ImportLearnedSkill[]; skillsChanged: ImportLearnedSkill[]; memoryNew: { title: string; text: string }[];
  changelogSince: { heading: string; text: string }[]; changelogMark: string | null; warnings: string[];
}

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
  agentClaudeCode: (slug: string, id: string) => request<{ backend: ExecutionBackend; status: ClaudeCodeStatusView; projects: { id: string; authorized: boolean }[]; limits: { maxConcurrent: number; maxDurationSec: number; maxTurns: number; repoRead: boolean; fallback: 'none' | 'api' }; usage: ClaudeCodeUsage; runs: ClaudeCodeRun[]; consoles: { id: string; name: string; connected: boolean; expired: boolean }[]; invocation?: AgentInvocation }>(`/api/workspaces/${slug}/agents/${id}/claude-code`),
  decideAssistantOperation: (messageId: string, operationId: string, decision: 'approve' | 'reject') => request<{ message: AssistantMessage }>(`/api/assistant/messages/${messageId}/operations/${operationId}/${decision}`, { method: 'POST', body: JSON.stringify(decision === 'approve' ? { authorized: true } : {}) }),
  processBackends: (slug: string, id: string) => request<ProcessBackends>(`/api/workspaces/${slug}/processes/${id}/backends`),
  claudeCodeFix: (slug: string, id: string, fix: { authorizeProject: boolean; switchToManaged: string[] }) => request<ProcessBackends>(`/api/workspaces/${slug}/processes/${id}/claude-code/fix`, { method: 'POST', body: JSON.stringify({ authorized: true, ...fix }) }),
  claudeCodeWorkspace: (slug: string) => request<ClaudeCodeWorkspaceView>(`/api/workspaces/${slug}/claude-code`),
  claudeCodeProjects: (slug: string, projectIds: string[]) => request<{ projects: string[] }>(`/api/workspaces/${slug}/claude-code/projects`, { method: 'PUT', body: JSON.stringify({ authorized: true, projectIds }) }),
  setAgentBackend: (slug: string, id: string, backend: ExecutionBackend) => request<Agent>(`/api/workspaces/${slug}/agents/${id}/backend`, { method: 'PUT', body: JSON.stringify({ backend, authorized: true }) }),
  // EN-014 · Ámbito del agente: sin costo; no cambia herramientas ni permisos.
  setAgentContextScope: (slug: string, id: string, scope: import('@portal-ia/domain').AgentContextScope) => request<Agent>(`/api/workspaces/${slug}/agents/${id}/context-scope`, { method: 'PUT', body: JSON.stringify({ project: scope.project ? { id: scope.project.id, name: scope.project.name } : null, company: !!scope.company, general: !!scope.general }) }),
  createClaudeCodeWorker: (slug: string, name: string, agentIds: string[]) => request<{ worker: ClaudeCodeWorkerView; token: string; setup: { cwd: string; command: string; args: string[] } }>(`/api/workspaces/${slug}/claude-code/workers`, { method: 'POST', body: JSON.stringify({ authorized: true, name, agentIds }) }),
  revokeClaudeCodeWorker: (slug: string, id: string) => request<ClaudeCodeWorkerView>(`/api/workspaces/${slug}/claude-code/workers/${id}`, { method: 'DELETE' }),
  agent: (slug: string, id: string) => request<Agent>(`/api/workspaces/${slug}/agents/${id}`),
  /** EN-011 · Lo que sabe hacer el agente según sus herramientas concedidas y si el sandbox está disponible ahora. */
  agentCapabilities: (slug: string, id: string) => request<AgentCapabilitiesView>(`/api/workspaces/${slug}/agents/${encodeURIComponent(id)}/capabilities`),
  /** EN-011 · Aprendizaje verificado, pendiente y relacionado del agente (solo lectura: nada cambia de estado). */
  agentLearning: (slug: string, id: string) => request<AgentLearningView>(`/api/workspaces/${slug}/agents/${encodeURIComponent(id)}/learning`),
  updateAgentConfig: (slug: string, id: string, config: AgentConfig) => request<Agent>(`/api/workspaces/${slug}/agents/${id}/config`, { method: 'PUT', body: JSON.stringify(config) }),
  createAgent: (slug: string, input: AgentCreateInput) => request<Agent>(`/api/workspaces/${slug}/agents`, { method: 'POST', body: JSON.stringify(input) }),
  deleteAgent: (slug: string, id: string) => request<{ ok: boolean }>(`/api/workspaces/${slug}/agents/${id}`, { method: 'DELETE' }),
  draftEstimate: (slug: string) => request<{ model: string; byAgent: string; estimatedUsd: number }>(`/api/workspaces/${slug}/agents/draft/estimate`),
  draftAgent: (slug: string, description: string, scope: 'workspace' | 'project', maxUsd: number) => request<AgentDraftResult>(`/api/workspaces/${slug}/agents/draft`, { method: 'POST', body: JSON.stringify({ description, scope, authorized: true, maxUsd }) }),
  // HU-004 · procesos autorizados y conocimiento
  assessmentEstimate: (slug: string, projectId: string) => request<AssessmentEstimate>(`/api/workspaces/${slug}/projects/${projectId}/assessment/estimate`),
  createAssessment: (slug: string, projectId: string) => request<Process>(`/api/workspaces/${slug}/projects/${projectId}/assessment`, { method: 'POST' }),
  processes: (slug: string, projectId: string) => request<Process[]>(`/api/workspaces/${slug}/projects/${projectId}/processes`),
  /** Listado resumido (sin salidas de los agentes ni diffs): lo que usan Actividad, Panel, Backlog y la evaluación inicial. */
  processSummaries: (slug: string, projectId: string) => request<Process[]>(`/api/workspaces/${slug}/projects/${projectId}/processes?view=summary`),
  process: (slug: string, id: string) => request<Process>(`/api/workspaces/${slug}/processes/${id}`),
  /** Autoriza un proceso. En historias, `pipeline` incluye en ESTA autorización aplicar, verificar, QA con evidencia y correcciones acotadas. */
  authorizeProcess: (slug: string, id: string, budgetUsd: number, pipeline?: PipelineConfig) => request<Process>(`/api/workspaces/${slug}/processes/${id}/authorize`, { method: 'POST', body: JSON.stringify({ budgetUsd, authorized: true, ...(pipeline ? { pipeline } : {}) }) }),
  /** Continuar de forma autónoma (pipeline pausado/detenido, proceso sin pipeline o entrega a reparar). Autorizado por el propietario. Si el equipo preguntó algo, `answer` es obligatoria y llega una vez al agente que lo pidió. */
  continueProcess: (slug: string, id: string, body: { addBudgetUsd?: number; addSubscriptionCalls?: number; pipeline?: Partial<PipelineConfig>; answer?: string }) => request<Process>(`/api/workspaces/${slug}/processes/${id}/continue`, { method: 'POST', body: JSON.stringify({ authorized: true, ...body }) }),
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
  /** Deshace una mejora aplicada a un agente (también las aprendidas de un reintento): restaura su copia previa. */
  undoAgentProposal: (slug: string, agentId: string, pid: string) =>
    request<unknown>(`/api/workspaces/${slug}/agents/${encodeURIComponent(agentId)}/proposals/${encodeURIComponent(pid)}/undo`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
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
  authorizeAssignment: (slug: string, id: string, body: { budgetUsd: number; maxSubscriptionCalls?: number; gauntlet?: { mode: 'auto' | 'off' | 'standard' | 'deep' }; discardApplied?: boolean }) => request<{ assignment: Assignment }>(`/api/workspaces/${slug}/assignments/${id}/authorize`, { method: 'POST', body: JSON.stringify({ ...body, authorized: true }) }),
  /** EN-009 · `ownerReason`: tu motivo para aceptar aunque la regla de cierre lo bloquee o ya esté integrado con cambios pedidos (queda en sus eventos). */
  acceptAssignment: (slug: string, id: string, note: string | null, ownerReason?: string | null, discardNote = false) => request<Assignment>(`/api/workspaces/${slug}/assignments/${id}/accept`, { method: 'POST', body: JSON.stringify({ ...(note ? { note } : {}), ...(discardNote ? { discardNote: true } : {}), ...(ownerReason?.trim() ? { ownerReason: ownerReason.trim() } : {}) }) }),
  requestAssignmentChanges: (slug: string, id: string, note: string, discardApplied = false) => request<AssignmentView>(`/api/workspaces/${slug}/assignments/${id}/changes`, { method: 'POST', body: JSON.stringify({ note, discardApplied }) }),
  cancelAssignment: (slug: string, id: string) => request<Assignment>(`/api/workspaces/${slug}/assignments/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) }),
  claudeCodeUsage: () => request<UsageGateView>('/api/claude-code/usage'),
  acknowledgeUsage: () => request<UsageGateView>('/api/claude-code/usage/acknowledge', { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  sendAssistant: (text: string, images: AssistantImage[] = [], files: AssistantAttachment[] = [], conversationId: string | null = null, model: string | null = null) => withModel(model)<{ user: AssistantMessage; assistant: AssistantMessage; info: AssistantInfo; conversationId: string }>('/api/assistant/messages', { method: 'POST', body: JSON.stringify({ conversationId, text, images: images.length ? images : undefined, files: files.length ? files : undefined }) }),
  resolveAssistantProposal: (messageId: string, processId: string, status: 'done' | 'failed', detail?: string) => request<{ message: AssistantMessage }>(`/api/assistant/messages/${messageId}/resolve`, { method: 'POST', body: JSON.stringify({ processId, status, detail }) }),
  clearAssistant: () => request<{ ok: boolean }>('/api/assistant/messages', { method: 'DELETE' }),
  assistantPendingCount: () => request<{ count: number }>('/api/assistant/pending-count'),
  addBacklogItem: (slug: string, projectId: string, input: { title: string; description?: string; criterion?: string; ownerKey?: string | null; estimate?: 'S' | 'M' | 'L' | null }) => request<BacklogItem>(`/api/workspaces/${slug}/projects/${projectId}/backlog`, { method: 'POST', body: JSON.stringify(input) }),
  patchBacklogItem: (slug: string, id: string, patch: Partial<Pick<BacklogItem, 'title' | 'criterion' | 'description' | 'ownerKey' | 'estimate' | 'dependsOn'>> & { status?: BacklogStatus }) => request<BacklogItem>(`/api/workspaces/${slug}/backlog/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteBacklogItem: (slug: string, id: string) => request<{ ok: boolean }>(`/api/workspaces/${slug}/backlog/${id}`, { method: 'DELETE' }),
  storyEstimate: (slug: string, projectId: string, id: string, skipQa = false, team?: { add?: string[]; remove?: string[] }) => { const q = new URLSearchParams(); if (skipQa) q.set('skipQa', '1'); if (team?.add?.length) q.set('add', team.add.join(',')); if (team?.remove?.length) q.set('remove', team.remove.join(',')); const qs = q.toString(); return request<AssessmentEstimate>(`/api/workspaces/${slug}/projects/${projectId}/backlog/${id}/estimate${qs ? `?${qs}` : ''}`); },
  executeStory: (slug: string, projectId: string, id: string, skipQa = false, team?: { add?: string[]; remove?: string[] }) => request<Process>(`/api/workspaces/${slug}/projects/${projectId}/backlog/${id}/execute`, { method: 'POST', body: JSON.stringify({ skipQa, team }) }),
  agentStats: (slug: string, id: string) => request<{ steps: number; done: number; failed: number; costUsd: number; byRole: Record<string, number>; lastAt: string | null }>(`/api/workspaces/${slug}/agents/${id}/stats`),
  repoStatus: (slug: string, projectId: string) => request<RepoStatus & { portalRoot: string }>(`/api/workspaces/${slug}/projects/${projectId}/repository/status`),
  repoInitMain: (slug: string, projectId: string) => request<{ mainBranch: string; from: string }>(`/api/workspaces/${slug}/projects/${projectId}/repository/init-main`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  repoSetRemote: (slug: string, projectId: string, url: string, expectedUrl: string | null) => request<{ remote: string; url: string }>(`/api/workspaces/${slug}/projects/${projectId}/repository/remote`, { method: 'POST', body: JSON.stringify({ authorized: true, url, expectedUrl }) }),
  repoNormalizeEol: (slug: string, projectId: string) => request<{ commit: string | null; files: number }>(`/api/workspaces/${slug}/projects/${projectId}/repository/normalize-eol`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  repoPublishMain: (slug: string, projectId: string, expectedMain: string, expectedRemoteUrl: string | null) => request<{ remote: string; url: string | null; branches: string[] }>(`/api/workspaces/${slug}/projects/${projectId}/repository/publish-main`, { method: 'POST', body: JSON.stringify({ authorized: true, expectedMain, expectedRemoteUrl }) }),
  systemStatus: () => request<SystemStatus>('/api/system/status'),
  systemUpdate: (opts: { install?: boolean; restart?: boolean; interruptRunning?: boolean; expectedHead: string | null }) => request<{ update: NonNullable<SystemStatus['update']>; install: boolean }>('/api/system/update', { method: 'POST', body: JSON.stringify({ authorized: true, ...opts }) }),
  delegationEstimate: (slug: string, body: { projectId?: string | null; agent?: string; request: string }) => request<AssessmentEstimate & { leadAgentId: string; teamSize: number }>(`/api/workspaces/${slug}/delegations/estimate`, { method: 'POST', body: JSON.stringify(body) }),
  createDelegation: (slug: string, body: { projectId?: string | null; agent?: string; request: string }) => request<Process>(`/api/workspaces/${slug}/delegations`, { method: 'POST', body: JSON.stringify(body) }),
  applyBacklogOps: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/backlog-ops/apply`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  manualTest: (slug: string, processId: string, checks: boolean[], note?: string | null) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/manual-test`, { method: 'POST', body: JSON.stringify({ checks, note }) }),
  manualTestSteps: (slug: string, processId: string, steps: string[]) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/manual-test`, { method: 'POST', body: JSON.stringify({ steps }) }),
  manualTestEstimate: (slug: string, processId: string) => request<{ agentName: string; model: string; estimatedUsd: number }>(`/api/workspaces/${slug}/processes/${processId}/manual-test/estimate`),
  /** HU-192 · `regenerate`: QA rehace una lista ya revisada para quitar los pasos que salen del Portal (409 si no hay ninguno). */
  manualTestGenerate: (slug: string, processId: string, opts: { regenerate?: boolean } = {}) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/manual-test/generate`, { method: 'POST', body: JSON.stringify(opts.regenerate ? { authorized: true, regenerate: true } : { authorized: true }) }),
  rejectProcess: (slug: string, processId: string, reason?: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  resetStory: (slug: string, id: string, reason?: string) => request<BacklogItem>(`/api/workspaces/${slug}/backlog/${id}/reset`, { method: 'POST', body: JSON.stringify({ reason }) }),
  recoverProcess: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/recover`, { method: 'POST' }),
  acceptPlan: (slug: string, processId: string, addBudgetUsd = 0) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/accept-plan`, { method: 'POST', body: JSON.stringify({ authorized: true, addBudgetUsd }) }),
  convertToAnalysis: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/convert-to-analysis`, { method: 'POST', body: JSON.stringify({}) }),
  retryProcess: (slug: string, processId: string, skipQa = false) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/retry`, { method: 'POST', body: JSON.stringify({ skipQa }) }),
  /**
   * EN-005 · «Reabrir la historia» desde un proceso de una historia integrada, completada o descartada. Lleva siempre
   * confirmación explícita y motivo. Crea una iteración nueva pendiente de autorización (sin consumir IA) y devuelve ese proceso.
   */
  reopenStory: (slug: string, processId: string, reason: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/reopen-story`, { method: 'POST', body: JSON.stringify({ confirm: true, reason }) }),
  /** `expectedCommit`: el commit que viste; `acknowledge`: confirmas lo que la línea base dejó pasar (ver mergeAcknowledgementsOf). */
  mergeProcess: (slug: string, processId: string, skipVerification = false, opts: { expectedCommit?: string | null; acknowledge?: { preexisting?: boolean; testUpdates?: boolean } } = {}) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/merge`, { method: 'POST', body: JSON.stringify({ authorized: true, skipVerification, ...(opts.expectedCommit ? { expectedCommit: opts.expectedCommit } : {}), ...(opts.acknowledge ? { acknowledge: opts.acknowledge } : {}) }) }),
  publishProcess: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/publish`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  /** HU-185 · El propietario omite publicar (sin IA ni git; no cambia el cierre). */
  skipPublish: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/skip-publish`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  applyChanges: (slug: string, processId: string, branch?: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/apply`, { method: 'POST', body: JSON.stringify({ authorized: true, branch }) }),
  verifyProcess: (slug: string, processId: string, command: 'install' | 'typecheck' | 'test' | 'build', allowNetwork = false) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/verify`, { method: 'POST', body: JSON.stringify({ authorized: true, command, allowNetwork }) }),
  /** M2 · el Portal se comprueba a sí mismo (HTTP y navegador) una vez activado el cambio. */
  runtimeCheck: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/runtime-check`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  systemSandbox: (force = false) => request<{ available: 'docker' | 'wsl' | 'host-min' | 'unavailable'; docker: boolean; wsl: boolean; detail: string; checkedAt: string }>(`/api/system/sandbox${force ? '?force=1' : ''}`),
  systemPolicy: () => request<{ op: string; level: 'local' | 'auth' | 'external'; tool: string | null; label: string }[]>('/api/system/policy'),
  markStoryDone: (slug: string, id: string, opts?: { force: boolean; reason?: string }) => request<BacklogItem>(`/api/workspaces/${slug}/backlog/${id}/done`, { method: 'POST', body: opts ? JSON.stringify(opts) : undefined }),
  /** HU-187 · Qué comprobaciones se omitirían al cerrar como resuelta (sin efectos). */
  storyClosePreview: (slug: string, id: string) => request<StoryClosePreview>(`/api/workspaces/${slug}/backlog/${encodeURIComponent(id)}/close-preview`),
  /** HU-165 · Cancelar historia: queda en «Descartadas» con su motivo (sin IA). 409 si está en curso, completada o descartada. */
  discardStory: (slug: string, id: string, reason: string) => request<BacklogItem>(`/api/workspaces/${slug}/backlog/${id}/discard`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }),
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
  /** HU-202 · El Curador agrupa y aplica (o descarta) todas las detecciones pendientes con una sola confirmación. Sin IA, 0 USD. */
  lessonsCurate: (slug: string, projectId: string | null) => request<LessonCurateSummary>(`/api/workspaces/${slug}/lessons/curate`, { method: 'POST', body: JSON.stringify({ authorized: true, projectId }) }),
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
  inboxAssignments: (slug: string) => request<AssignmentPendingItem[]>(`/api/workspaces/${slug}/inbox/assignments`),
  /** HU-196 · Historial de decisiones resueltas de la empresa, de la más reciente a la más antigua (por defecto 200; máximo 500). Sin IA. */
  inboxHistory: (slug: string, limit?: number) => request<DecisionHistoryItem[]>(`/api/workspaces/${slug}/inbox/history${limit ? `?limit=${encodeURIComponent(String(limit))}` : ''}`),
  decideInbox: (slug: string, kind: PendingDecisionKind, processId: string, verdict: DecisionVerdict, reason?: string, seenVersion?: string) =>
    request<InboxDecisionResult>(`/api/workspaces/${slug}/inbox/${kind}/${processId}/decision`, { method: 'POST', body: JSON.stringify({ verdict, reason: reason?.trim() ? reason.trim() : undefined, seenVersion }) }),
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
  /** Cierre manual de un lote en pausa con motivo obligatorio (sin costo de IA). 409 si el lote no está en pausa. */
  // Revisión del proyecto (ramas, worktrees y backlog frente a main): revisar es solo lectura; ejecutar, solo lo elegido.
  maintenancePlans: (slug: string, projectId: string) => request<MaintenancePlan[]>(`/api/workspaces/${slug}/projects/${projectId}/maintenance/plans`),
  createMaintenancePlan: (slug: string, projectId: string, from: string | null = null) => request<MaintenancePlan>(`/api/workspaces/${slug}/projects/${projectId}/maintenance/plans`, { method: 'POST', body: JSON.stringify(from ? { from } : {}) }),
  maintenancePlan: (slug: string, id: string) => request<MaintenancePlan>(`/api/workspaces/${slug}/maintenance/plans/${id}`),
  executeMaintenancePlan: (slug: string, id: string, selection: MaintenanceSelection[]) => request<MaintenancePlan>(`/api/workspaces/${slug}/maintenance/plans/${id}/execute`, { method: 'POST', body: JSON.stringify({ authorized: true, selection }) }),
  rejectMaintenancePlan: (slug: string, id: string) => request<MaintenancePlan>(`/api/workspaces/${slug}/maintenance/plans/${id}/reject`, { method: 'POST', body: '{}' }),
  ownerSession: () => request<{ owner: boolean; file: string }>('/api/owner/session'),
  requestOwnerCode: () => request<{ ok: true; expiresInSec: number; file: string | null; problem: string | null }>('/api/owner/pairing', { method: 'POST', body: '{}' }),
  pairOwner: (code: string) => request<{ owner: true; token: string; expiresAt: string }>('/api/owner/pair', { method: 'POST', body: JSON.stringify({ code }) }),
  ownerLogout: () => request<{ owner: false }>('/api/owner/logout', { method: 'POST', body: '{}' }),
  ownerLogoutAll: () => request<{ owner: false; closed: number }>('/api/owner/logout-all', { method: 'POST', body: '{}' }),
  closeBatch: (slug: string, projectId: string, id: string, reason: string) => request<BatchView>(`/api/workspaces/${slug}/projects/${projectId}/batches/${id}/close`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }),
  batchControl: (slug: string, id: string, action: 'pause' | 'resume' | 'cancel' | 'revoke', body: Record<string, unknown> = {}) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/${action}`, { method: 'POST', body: JSON.stringify(action === 'resume' ? { ...body, authorized: true } : body) }),
  /** `revisions`: commit que tenías delante al decidir (p. ej. el de la vista previa): si cambió, el servidor no lo aplica. */
  acceptBatchItems: (slug: string, id: string, itemIds: string[], note?: string, checks?: Record<string, boolean[]>, revisions?: Record<string, string>) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/accept`, { method: 'POST', body: JSON.stringify({ itemIds, note: note?.trim() || undefined, checks, revisions }) }),
  batchPolicy: (slug: string, id: string) => request<BatchPolicyView>(`/api/workspaces/${slug}/batches/${id}/policy`),
  changeBatchPolicy: (slug: string, id: string, body: { publish: boolean; activate: boolean; note?: string }) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/policy`, { method: 'POST', body: JSON.stringify({ ...body, note: body.note?.trim() || undefined, integration: 'on_acceptance', authorized: true }) }),
  previews: (slug: string, processId: string) => request<(PreviewRecord & { live: boolean })[]>(`/api/workspaces/${slug}/processes/${processId}/previews`),
  startPreview: (slug: string, processId: string) => request<PreviewRecord>(`/api/workspaces/${slug}/processes/${processId}/previews`, { method: 'POST', body: '{}' }),
  stopPreview: (slug: string, processId: string, previewId: string) => request<PreviewRecord | null>(`/api/workspaces/${slug}/processes/${processId}/previews/${previewId}`, { method: 'DELETE' }),
  rejectBatchItem: (slug: string, id: string, itemId: string, note: string, failedSteps: string[]) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/items/${itemId}/reject`, { method: 'POST', body: JSON.stringify({ note, failedSteps }) }),
  reopenBatchItem: (slug: string, id: string, itemId: string) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/items/${itemId}/reopen`, { method: 'POST', body: '{}' }),
  iterateBatchItem: (slug: string, id: string, itemId: string, note: string, revision?: string | null) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/items/${itemId}/iterate`, { method: 'POST', body: JSON.stringify({ authorized: true, note, revision: revision || undefined }) }),
  retryBatchItem: (slug: string, id: string, itemId: string) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/items/${itemId}/retry`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  cancelBatchItem: (slug: string, id: string, itemId: string) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/items/${itemId}/cancel`, { method: 'POST', body: '{}' }),
  postponeBatchItem: (slug: string, id: string, itemId: string, note: string) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/items/${itemId}/postpone`, { method: 'POST', body: JSON.stringify({ note }) }),
  restoreBatchItem: (slug: string, id: string, itemId: string) => request<BatchView>(`/api/workspaces/${slug}/batches/${id}/items/${itemId}/restore`, { method: 'POST', body: '{}' }),
  // HU-177 · Eliminación autorizada de lotes y documentos de un agente externo (borrado blando: el histórico y el aprendizaje se conservan).
  /** Documentos del agente. Con `includeRemoved` también devuelve lo eliminado y el histórico de eliminaciones. Los conteos los calcula el servidor. */
  agentDocuments: (slug: string, agentId: string, includeRemoved = false) => request<{ jobs: DocumentJob[]; batches: DocumentBatch[]; removals?: RemovalRecord[] }>(`/api/workspaces/${slug}/agents/${encodeURIComponent(agentId)}/documents${includeRemoved ? '?includeRemoved=1' : ''}`),
  /** Vista previa sin borrar nada: carpeta, archivos, bytes que se liberan, qué se conserva y `token` de lo mostrado. */
  batchRemovalPreview: (slug: string, agentId: string, batchId: string) => request<RemovalPreview>(`/api/workspaces/${slug}/agents/${encodeURIComponent(agentId)}/batches/${encodeURIComponent(batchId)}/removal-preview`),
  documentRemovalPreview: (slug: string, agentId: string, jobId: string) => request<RemovalPreview>(`/api/workspaces/${slug}/agents/${encodeURIComponent(agentId)}/documents/${encodeURIComponent(jobId)}/removal-preview`),
  /** Borra de tu equipo la carpeta del lote (origen y resultados). Se hace por POST para no perder el cuerpo. Responde 409 si se está procesando o si cambió desde la vista previa. */
  removeDocumentBatch: (slug: string, agentId: string, batchId: string, o: RemovalRequest) => request<RemovalRecord>(`/api/workspaces/${slug}/agents/${encodeURIComponent(agentId)}/batches/${encodeURIComponent(batchId)}/remove`, { method: 'POST', body: JSON.stringify({ authorized: true, reason: o.reason?.trim() || null, previewToken: o.previewToken }) }),
  /** Borra de tu equipo la carpeta de un documento. Los conteos de su lote se recalculan y los eliminados cuentan aparte. */
  removeDocument: (slug: string, agentId: string, jobId: string, o: RemovalRequest) => request<RemovalRecord>(`/api/workspaces/${slug}/agents/${encodeURIComponent(agentId)}/documents/${encodeURIComponent(jobId)}/remove`, { method: 'POST', body: JSON.stringify({ authorized: true, reason: o.reason?.trim() || null, previewToken: o.previewToken }) })
};

/** Eliminación autorizada: `previewToken` es el de la vista previa que viste (si el contenido cambió, el servidor responde 409). */
export interface RemovalRequest { previewToken: string; reason?: string | null }

/** Alcance que el propietario autoriza para un lote (lo normaliza y acota el servidor). */
export interface BatchRequest {
  title?: string; itemIds: string[]; backends?: ('api' | 'claude_code')[]; apiFallback?: boolean;
  totalBudgetUsd: number; perStoryBudgetUsd: number; maxCorrections?: number; maxDurationMin?: number; maxSubscriptionCalls?: number;
  gauntlet?: GauntletConfig; concurrency?: number; commands?: ('typecheck' | 'test' | 'build')[]; allowInstall?: boolean;
  git?: { merge?: boolean; activate?: boolean; publish?: boolean; integration?: 'auto' | 'on_acceptance'; prepareDependents?: boolean }; autoResume?: boolean;
}

/** Política de integración de un lote y lo que haría cambiarla / reanudar (GET /batches/:id/policy). */
export interface BatchPolicyView {
  policy: string; label: string; git: BatchView['auth']['git'];
  canChange: boolean; blockedBy: string | null;
  alreadyIntegrated: { itemId: string; storyId: string; commit: string; activated: boolean; accepted: boolean }[];
  willBecomeReady: { itemId: string; storyId: string; from: string }[];
  resumeNow: { itemId: string; storyId: string; effect: string }[];
  resumeAfter: { itemId: string; storyId: string; effect: string }[];
  history: BatchPolicyChange[];
}

/** Para los clientes de API de otras áreas (lib/osApi.ts): mismas cabeceras, errores y control de versiones. */
export { request as apiRequest };

// ---------- HU-204 · «Redactar con IA» en «Nuevo agente» (apps/server/src/routes/agentsOs.ts)
/** Motor y costo de la redacción. Pedirlo no llama a ningún modelo. */
export interface WizardDraftEstimate {
  agentId: string; byAgent: string; harness: string; label: string; provider: string; model: string;
  costKind: 'subscription' | 'usd'; estimatedUsd: number; calls: 1;
}
/** Propuesta ya limpia en el servidor: sin permisos, herramientas, arnés, modelo ni autonomía (`discarded` dice qué se quitó). */
export interface WizardDraftResult {
  draft: import('@portal-ia/domain').AgentWizardDraft; discarded: string[];
  byAgent: string; harness: string; model: string; tokensIn: number; tokensOut: number; costUsd: number;
}
/** Datos de «Nuevo agente» más el texto de la necesidad (se guarda en knowledge/necesidad-original.md). */
export type WizardCreateInput = import('./osApi.ts').WizardInput & { need?: string | null };

const wsUrl = (slug: string) => `/api/workspaces/${encodeURIComponent(slug)}`;

/** Sin costo: solo devuelve el motor (agente, arnés, modelo) y el costo estimado. */
export const wizardDraftEstimate = (slug: string, need?: string | null) =>
  request<WizardDraftEstimate>(`${wsUrl(slug)}/agents/wizard-draft/estimate${need?.trim() ? `?need=${encodeURIComponent(need.trim().slice(0, 4000))}` : ''}`);

/** UNA llamada al modelo. Úsalo SOLO desde el botón «Autorizar y redactar»: es lo único que envía authorized:true. */
export const wizardDraft = (slug: string, need: string, maxUsd: number) =>
  request<WizardDraftResult>(`${wsUrl(slug)}/agents/wizard-draft`, { method: 'POST', body: JSON.stringify({ need, authorized: true, maxUsd }) });

/** Crea el agente (sin IA) y envía también la necesidad y las habilidades (las del perfil y las añadidas a mano). */
export const createAgentWizard = (slug: string, input: WizardCreateInput) =>
  request<import('@portal-ia/domain').Agent>(`${wsUrl(slug)}/agents/wizard`, { method: 'POST', body: JSON.stringify({ ...input, need: input.need?.trim() ? input.need.trim().slice(0, 4000) : null, skills: input.skills ?? [] }) });

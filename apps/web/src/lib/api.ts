import type { PipelineConfig, PhaseTransition, PhaseTransitionPreview, ProjectArchive, StoryContext, StoryMessage, StoryTask, Lesson, AgentTemplateVersion, DecisionVerdict, InboxDecisionResult, PendingDecision, PendingDecisionKind, RepoStatus, SystemStatus, Agent, AgentConfig, AgentCreateInput, AgentDraftResult, AssessmentEstimate, BacklogItem, BacklogStatus, BootstrapResult, ContextItem, FsEntry, FsListing, KnowledgeDoc, Objective, Process, Project, ProviderView, Repository, UsageToday, Workspace } from '@portal-ia/domain';

import type { BudgetBalance, BudgetLevel } from '@portal-ia/domain';
import type { ClaudeCodeStatusView, ClaudeCodeWorkerView, ClaudeCodeWorkspaceView, ExecutionBackend } from '@portal-ia/domain';
import { noteFailure, noteResponse } from './liveStatus.ts';

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
  noteResponse(res.headers.get('x-server-time'), sentAt, Date.now());
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? body?.lastError?.message ?? `Error ${res.status}`, body);
  return body as T;
}

export interface AssistantInfo { agentId: string; name: string; model: string; provider: string; monthlyLimitUsd: number; spentThisMonthUsd: number; estimatedPerMessageUsd: number }
export type AssistantActionType = 'create_company' | 'create_project' | 'add_backlog_item' | 'propose_execution' | 'propose_apply' | 'propose_delegation' | 'info';
export interface AssistantAction {
  type: AssistantActionType; status: 'done' | 'failed' | 'pending'; label: string; detail?: string; link?: string;
  processId?: string; workspaceSlug?: string; projectId?: string; storyId?: string; estimatedUsd?: number; suggestedBudgetUsd?: number; changes?: number;
  live?: { status: string; phase: string; next: string; tone: 'info' | 'warn' | 'ok' | 'err'; settled: boolean };
}
export interface AssistantAttachment { name: string; mediaType: string; bytes: number }
export interface AssistantImage { mediaType: string; data: string; name?: string }
export interface AssistantMessage { id: string; role: 'user' | 'assistant'; content: string; actions: AssistantAction[]; attachments: AssistantAttachment[]; tokensIn: number; tokensOut: number; costUsd: number; model: string | null; createdAt: string }
export type ProjectFull = Project & { objectives: Objective[]; context: ContextItem[]; repository: Repository | null; knowledgeCount: number };
export interface BootstrapStatus { providerConnected: boolean; initialized: boolean; workspace: Workspace | null; project: Project | null; agentCount: number }

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
  claudeCodeWorkspace: (slug: string) => request<ClaudeCodeWorkspaceView>(`/api/workspaces/${slug}/claude-code`),
  claudeCodeProjects: (slug: string, projectIds: string[]) => request<{ projects: string[] }>(`/api/workspaces/${slug}/claude-code/projects`, { method: 'PUT', body: JSON.stringify({ authorized: true, projectIds }) }),
  setAgentBackend: (slug: string, id: string, backend: ExecutionBackend) => request<Agent>(`/api/workspaces/${slug}/agents/${id}/backend`, { method: 'PUT', body: JSON.stringify(backend === 'api' ? { backend } : { backend, authorized: true }) }),
  createClaudeCodeWorker: (slug: string, name: string, agentIds: string[]) => request<{ worker: ClaudeCodeWorkerView; token: string; setup: { command: string; args: string[] } }>(`/api/workspaces/${slug}/claude-code/workers`, { method: 'POST', body: JSON.stringify({ authorized: true, name, agentIds }) }),
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
  registerExternalCorrection: (slug: string, id: string, body: { commit: string; note: string }) => request<Process>(`/api/workspaces/${slug}/processes/${id}/external-correction`, { method: 'POST', body: JSON.stringify({ authorized: true, ...body }) }),
  cancelProcess: (slug: string, id: string) => request<Process>(`/api/workspaces/${slug}/processes/${id}/cancel`, { method: 'POST' }),
  knowledge: (slug: string, projectId: string) => request<KnowledgeDoc[]>(`/api/workspaces/${slug}/projects/${projectId}/knowledge`),
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
  assistant: () => request<{ info: AssistantInfo; messages: AssistantMessage[] }>('/api/assistant'),
  sendAssistant: (text: string, images: AssistantImage[] = [], files: AssistantAttachment[] = []) => request<{ user: AssistantMessage; assistant: AssistantMessage; info: AssistantInfo }>('/api/assistant/messages', { method: 'POST', body: JSON.stringify({ text, images: images.length ? images : undefined, files: files.length ? files : undefined }) }),
  resolveAssistantProposal: (messageId: string, processId: string, status: 'done' | 'failed', detail?: string) => request<{ message: AssistantMessage }>(`/api/assistant/messages/${messageId}/resolve`, { method: 'POST', body: JSON.stringify({ processId, status, detail }) }),
  clearAssistant: () => request<{ ok: boolean }>('/api/assistant/messages', { method: 'DELETE' }),
  addBacklogItem: (slug: string, projectId: string, input: { title: string; description?: string; criterion?: string; ownerKey?: string | null; estimate?: 'S' | 'M' | 'L' | null }) => request<BacklogItem>(`/api/workspaces/${slug}/projects/${projectId}/backlog`, { method: 'POST', body: JSON.stringify(input) }),
  patchBacklogItem: (slug: string, id: string, patch: Partial<Pick<BacklogItem, 'title' | 'criterion' | 'description' | 'ownerKey' | 'estimate'>> & { status?: BacklogStatus }) => request<BacklogItem>(`/api/workspaces/${slug}/backlog/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
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
    request<InboxDecisionResult>(`/api/workspaces/${slug}/inbox/${kind}/${processId}/decision`, { method: 'POST', body: JSON.stringify({ verdict, reason: reason?.trim() ? reason.trim() : undefined }) })
};

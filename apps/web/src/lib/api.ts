import type { DecisionVerdict, InboxDecisionResult, PendingDecision, PendingDecisionKind, RepoStatus, SystemStatus, Agent, AgentConfig, AgentCreateInput, AgentDraftResult, AssessmentEstimate, BacklogItem, BacklogStatus, BootstrapResult, ContextItem, FsEntry, FsListing, KnowledgeDoc, Objective, Process, Project, ProviderView, Repository, UsageToday, Workspace } from '@portal-ia/domain';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) { super(message); }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = init?.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
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
  authorizeProcess: (slug: string, id: string, budgetUsd: number) => request<Process>(`/api/workspaces/${slug}/processes/${id}/authorize`, { method: 'POST', body: JSON.stringify({ budgetUsd, authorized: true }) }),
  cancelProcess: (slug: string, id: string) => request<Process>(`/api/workspaces/${slug}/processes/${id}/cancel`, { method: 'POST' }),
  knowledge: (slug: string, projectId: string) => request<KnowledgeDoc[]>(`/api/workspaces/${slug}/projects/${projectId}/knowledge`),
  // HU-005 · backlog y ejecución de historias
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
  storyEstimate: (slug: string, projectId: string, id: string, skipQa = false) => request<AssessmentEstimate>(`/api/workspaces/${slug}/projects/${projectId}/backlog/${id}/estimate${skipQa ? '?skipQa=1' : ''}`),
  executeStory: (slug: string, projectId: string, id: string, skipQa = false) => request<Process>(`/api/workspaces/${slug}/projects/${projectId}/backlog/${id}/execute`, { method: 'POST', body: JSON.stringify({ skipQa }) }),
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
  mergeProcess: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/merge`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  publishProcess: (slug: string, processId: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/publish`, { method: 'POST', body: JSON.stringify({ authorized: true }) }),
  applyChanges: (slug: string, processId: string, branch?: string) => request<Process>(`/api/workspaces/${slug}/processes/${processId}/apply`, { method: 'POST', body: JSON.stringify({ authorized: true, branch }) }),
  verifyProcess: (slug: string, processId: string, command: 'install' | 'typecheck' | 'test' | 'build') => request<Process>(`/api/workspaces/${slug}/processes/${processId}/verify`, { method: 'POST', body: JSON.stringify({ authorized: true, command }) }),
  markStoryDone: (slug: string, id: string, opts?: { force: boolean; reason?: string }) => request<BacklogItem>(`/api/workspaces/${slug}/backlog/${id}/done`, { method: 'POST', body: opts ? JSON.stringify(opts) : undefined }),
  // HU-009 / HU-137 · bandeja de autorizaciones
  inbox: (slug: string) => request<PendingDecision[]>(`/api/workspaces/${slug}/inbox`),
  decideInbox: (slug: string, kind: PendingDecisionKind, processId: string, verdict: DecisionVerdict, reason?: string) =>
    request<InboxDecisionResult>(`/api/workspaces/${slug}/inbox/${kind}/${processId}/decision`, { method: 'POST', body: JSON.stringify({ verdict, reason: reason?.trim() ? reason.trim() : undefined }) })
};

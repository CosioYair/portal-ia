import type { Agent, Capability, ExecutionBackend, HarnessCapability, HarnessDescriptor, Lesson, Process, PortableFiles, PortableKnowledge, PortableSkill, ProviderId } from '@portal-ia/domain';
import { apiRequest as request } from './api.ts';

/** Cliente del «sistema operativo de agentes» (apps/server/src/routes/agentsOs.ts). */
export type OfficeState = 'working' | 'queued' | 'attention' | 'idle' | 'retired';
export interface OfficeAgent {
  id: string; key: string; name: string; role: string; initials: string; scope: 'workspace' | 'project'; projectId: string | null;
  department: string; departmentSlug: string; harness: ExecutionBackend; harnessLabel: string; model: string;
  state: OfficeState; activity: string | null; attention: { kind: string; label: string; processId?: string | null }[]; hasFolder: boolean; custom: boolean;
}
export interface Department { id: string; slug: string; name: string; purpose: string; hue: number; coordinatorAgentId: string | null; createdAt: string; archivedAt: string | null; implicit?: boolean; members: string[] }
export interface OfficeView { agents: OfficeAgent[]; departments: Department[]; counts: { agents: number; working: number; attention: number; decisions: number }; projects: { id: string; name: string }[] }
export interface HarnessAvailability { id: ExecutionBackend; state: string; available: boolean; reason: string | null; detail: string | null }
export interface HarnessOption { id: ExecutionBackend; name: string; vendor: string; billing: 'subscription' | 'api' | 'unverified'; summary: string; availability: HarnessAvailability; models: { provider: ProviderId; models: { id: string; name: string }[] }[];
  compatibility: { needs: HarnessCapability[]; gains: CompatItem[]; losses: CompatItem[]; missing: { capability: HarnessCapability; label: string; note: string | null }[]; reduced: { capability: HarnessCapability; label: string; note: string | null }[] }; current: boolean }
interface CompatItem { capability: HarnessCapability; label: string; needed: boolean; from: { level: string; note?: string }; to: { level: string; note?: string } }
export interface HarnessOptions { current: ExecutionBackend; currentLabel: string; model: string; provider: ProviderId; continuity: string; pinned: string; options: HarnessOption[];
  work: { inFlight: { id: string; title: string }[]; open: { id: string; title: string; status: string }[]; batches: { id: string; title: string; status: string; sources: string[] }[] } }
export interface CodexDetection { checkedAt: string; installed: boolean; path: string | null; version: string | null; auth: string; billing: string; exposedTools: string[] | null; blockedTools: string[]; userContext: string[]; restricted: boolean; models: { id: string; name: string }[]; credentialVars: string[]; problems: string[] }
export interface CodexSettings { enabled: boolean; cliPath: string | null; maxDurationSec: number; authorizedAt: string | null }
export interface AgentMessage { id: string; agentId: string; role: 'owner' | 'agent'; content: string; status: 'done' | 'running' | 'failed' | 'interrupted'; harness: string | null; model: string | null; tokensIn: number; tokensOut: number; costUsd: number; error: string | null; createdAt: string; finishedAt: string | null; replyTo: string | null }
export interface ChatEstimate { harness: ExecutionBackend; label: string; billable: boolean; estimatedUsd: number }
export interface WorkItem { id: string; kind: string; title: string; status: string; column: 'requested' | 'queued' | 'doing' | 'done' | 'stopped'; createdAt: string; finishedAt: string | null; projectId: string; lead: boolean; purpose: string | null; deliverable: string | null; knowledgeDocId: string | null; steps: { title: string; status: string }[] }
export interface Revision { n: number; hash: string; state: string; source: string; note: string; by: string; at: string }
export interface FolderStatus { folder: string | null; path: string | null; adopted: { n: number; hash: string; at: string; source: string; files?: PortableFiles; fileList?: string[] } | null; missingOnDisk?: boolean;
  external: { hash: string; diff: { path: string; change: string; added: string[]; removed: string[] }[]; problems: { path: string; message: string; blocking: boolean }[]; notAdopted: string[] } | null; revisions: Revision[]; ignored: string[] }
export interface AgentEvent { id: string; kind: string; detail: Record<string, unknown>; at: string; by: string }
export interface AgentPanel { agent: Agent; office: OfficeAgent | null; department: { slug: string; name: string; purpose: string } | null; retired: boolean; work: WorkItem[];
  memory: { verified: Lesson[]; proposed: Lesson[]; retired: Lesson[] }; chat: { usage: { used: number; cap: number }; estimate: ChatEstimate }; identity: { hasInstructions: boolean; skills: number; memory: number }; folder: FolderStatus; events: AgentEvent[] }
export interface WizardInput {
  name: string; role: string; summary: string; responsibilities: string[]; deliverables: string[]; department: string; departmentPurpose?: string | null;
  scope: 'workspace' | 'project'; projectId: string | null; harness: ExecutionBackend; model: string; provider?: ProviderId | null; effort: 'low' | 'medium' | 'high';
  tools: string[]; knowledge: string[]; capabilities: Capability[]; autonomy: 'ask' | 'within_scope'; instructions?: string | null; skills?: PortableSkill[]; references?: PortableKnowledge[]; authorized: boolean;
}
export interface ImportPreview { path: string; hash: string; files: string[]; ignored: string[]; problems: { path: string; message: string; blocking: boolean }[]; ok: boolean;
  agent: { name: string; role: string; summary: string; department: string | null; responsibilities: string[]; deliverables: string[]; capabilities: string[] } | null;
  requests: { harness: string; model: string; tools: string[]; autonomy: string } | null; instructions: string; skills: { slug: string; name: string; description: string }[]; memory: { title: string; text: string }[]; references: { slug: string; title: string }[]; note: string }

const J = (body: unknown) => JSON.stringify(body);
const W = (slug: string) => `/api/workspaces/${encodeURIComponent(slug)}`;
export const osApi = {
  office: (slug: string, projectId?: string | null) => request<OfficeView>(`${W(slug)}/office${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  departments: (slug: string) => request<(Department & { members: { id: string; name: string; role: string }[] })[]>(`${W(slug)}/departments`),
  createDepartment: (slug: string, name: string, purpose: string) => request<Department>(`${W(slug)}/departments`, { method: 'POST', body: J({ name, purpose }) }),
  updateDepartment: (slug: string, id: string, patch: { name?: string; purpose?: string; coordinatorAgentId?: string | null }) => request<Department>(`${W(slug)}/departments/${id}`, { method: 'PUT', body: J(patch) }),
  archiveDepartment: (slug: string, id: string) => request<{ ok: boolean }>(`${W(slug)}/departments/${id}`, { method: 'DELETE' }),
  moveAgent: (slug: string, agentId: string, department: string) => request<Agent>(`${W(slug)}/agents/${agentId}/department`, { method: 'PUT', body: J({ department }) }),
  departmentRequest: (slug: string, id: string, body: { request: string; projectId: string; memberIds: string[]; budgetUsd?: number; maxSubscriptionCalls?: number; preview?: boolean }) =>
    request<any>(`${W(slug)}/departments/${id}/requests`, { method: 'POST', body: J({ ...body, authorized: true }) }),
  panel: (slug: string, id: string) => request<AgentPanel>(`${W(slug)}/agents/${id}/panel`),
  harnesses: () => request<{ harnesses: (HarnessDescriptor & { availability: HarnessAvailability; models: { provider: ProviderId; models: { id: string; name: string }[] }[] })[]; codex: { settings: CodexSettings; detection: CodexDetection | null } }>(`/api/harnesses`),
  detectCodex: () => request<{ settings: CodexSettings; detection: CodexDetection }>(`/api/harnesses/codex/detect`, { method: 'POST', body: J({}) }),
  setCodex: (enabled: boolean, cliPath?: string | null) => request<{ settings: CodexSettings; detection: CodexDetection | null }>(`/api/harnesses/codex`, { method: 'PUT', body: J({ enabled, ...(cliPath !== undefined ? { cliPath } : {}), authorized: enabled ? true : undefined }) }),
  harnessOptions: (slug: string, id: string) => request<HarnessOptions>(`${W(slug)}/agents/${id}/harness`),
  switchHarness: (slug: string, id: string, harness: ExecutionBackend, model: string, provider?: ProviderId | null) => request<Agent>(`${W(slug)}/agents/${id}/harness`, { method: 'PUT', body: J({ harness, model, provider: provider ?? null, authorized: true }) }),
  chat: (slug: string, id: string) => request<{ messages: AgentMessage[]; usage: { used: number; cap: number }; estimate: ChatEstimate }>(`${W(slug)}/agents/${id}/chat`),
  sendChat: (slug: string, id: string, text: string, projectId: string | null, authorizeBillable?: boolean) => request<{ owner: AgentMessage; reply: AgentMessage }>(`${W(slug)}/agents/${id}/chat`, { method: 'POST', body: J({ text, projectId, authorizeBillable }) }),
  task: (slug: string, id: string, body: { request: string; projectId: string | null; budgetUsd?: number; maxSubscriptionCalls?: number; preview?: boolean }) => request<Process & { estimate?: any }>(`${W(slug)}/agents/${id}/tasks`, { method: 'POST', body: J({ ...body, authorized: true }) }),
  folder: (slug: string, id: string) => request<FolderStatus>(`${W(slug)}/agents/${id}/folder`),
  createFolder: (slug: string, id: string) => request<FolderStatus>(`${W(slug)}/agents/${id}/folder`, { method: 'POST', body: J({}) }),
  createAllFolders: (slug: string) => request<{ created: number; failed: { agentId: string; error: string }[] }>(`${W(slug)}/agent-folders`, { method: 'POST', body: J({ authorized: true }) }),
  adopt: (slug: string, id: string, hash: string) => request<Revision>(`${W(slug)}/agents/${id}/folder/adopt`, { method: 'POST', body: J({ hash }) }),
  discard: (slug: string, id: string) => request<{ ok: boolean }>(`${W(slug)}/agents/${id}/folder/discard`, { method: 'POST', body: J({}) }),
  restore: (slug: string, id: string, n: number) => request<Revision>(`${W(slug)}/agents/${id}/folder/restore`, { method: 'POST', body: J({ n }) }),
  identity: (slug: string, id: string, patch: { instructions?: string; skills?: PortableSkill[]; deliverables?: string[]; autonomy?: 'ask' | 'within_scope'; expectN: number | null }) => request<Revision>(`${W(slug)}/agents/${id}/identity`, { method: 'PUT', body: J(patch) }),
  feedback: (slug: string, id: string, body: { processId?: string | null; messageId?: string | null; rating: 'useful' | 'needs_changes'; feedback: string; lesson?: string | null }) => request<Lesson>(`${W(slug)}/agents/${id}/memory/feedback`, { method: 'POST', body: J(body) }),
  verifyMemory: (slug: string, id: string, lessonId: string, patch: { title?: string; text?: string } = {}) => request<Lesson>(`${W(slug)}/agents/${id}/memory/${lessonId}/verify`, { method: 'POST', body: J(patch) }),
  retireMemory: (slug: string, id: string, lessonId: string) => request<Lesson>(`${W(slug)}/agents/${id}/memory/${lessonId}/retire`, { method: 'POST', body: J({}) }),
  createAgent: (slug: string, input: WizardInput) => request<Agent>(`${W(slug)}/agents/wizard`, { method: 'POST', body: J(input) }),
  importPreview: (slug: string, path: string) => request<ImportPreview>(`${W(slug)}/agents/import/preview`, { method: 'POST', body: J({ path }) }),
  importAgent: (slug: string, body: Omit<WizardInput, 'name' | 'role' | 'summary' | 'responsibilities' | 'deliverables' | 'instructions' | 'skills' | 'references' | 'capabilities'> & { path: string; hash: string }) => request<Agent>(`${W(slug)}/agents/import`, { method: 'POST', body: J(body) }),
  exportFiles: (slug: string, id: string) => request<{ folder: string; files: PortableFiles }>(`${W(slug)}/agents/${id}/export`),
  exportTo: (slug: string, id: string, path: string) => request<{ path: string }>(`${W(slug)}/agents/${id}/export`, { method: 'POST', body: J({ path }) })
};

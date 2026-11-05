import type { Agent, Capability, DocumentBatch, DocumentJob, ExecutionBackend, ExternalFileChange, ExternalGrants, ExternalLayout, ExternalProvenance, HarnessCapability, HarnessDescriptor, ImprovementProposal, IntegrationState, Lesson, Process, PortableFiles, PortableKnowledge, PortableSkill, ProviderId } from '@portal-ia/domain';
import { ApiError, apiRequest as request } from './api.ts';
import { noteOwnerResponse, ownerHeaders } from './owner.ts';

/** Cliente del «sistema operativo de agentes» (apps/server/src/routes/agentsOs.ts). */
export type OfficeState = 'working' | 'queued' | 'attention' | 'unavailable' | 'idle' | 'retired';
export interface OfficeAgent {
  id: string; key: string; name: string; role: string; initials: string; scope: 'workspace' | 'project'; projectId: string | null;
  department: string; departmentSlug: string; harness: ExecutionBackend; harnessLabel: string; model: string;
  state: OfficeState; activity: string | null; attention: { kind: string; label: string; processId?: string | null }[]; harnessIssue: string | null; hasFolder: boolean; custom: boolean;
  integration: IntegrationState | null;
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
export interface AgentMessage { id: string; agentId: string; role: 'owner' | 'agent'; content: string; status: 'done' | 'running' | 'failed' | 'interrupted'; harness: string | null; model: string | null; tokensIn: number; tokensOut: number; costUsd: number; error: string | null; createdAt: string; finishedAt: string | null; replyTo: string | null;
  /** Adjuntos del mensaje, qué recibió el modelo de cada uno y acciones que propuso el agente (apps/server/src/services/agentAttachments.ts, agentActions.ts). */
  attachments?: ChatAttachment[]; sent?: { id: string; how: 'image' | 'metadata' | 'text' | 'not_sent' }[]; actions?: AgentAction[];
  /** La llamada terminó bien (true), falló (false) o no consta (null). */
  delivered?: boolean | null }
export type AttachmentKind = 'image' | 'pdf' | 'zip' | 'text';
export interface ChatAttachment { id: string; agentId: string; projectId: string | null; name: string; mime: string; kind: AttachmentKind; size: number; sha256: string;
  status: 'uploaded' | 'attached' | 'deleted' | 'expired'; meta: Record<string, any>; createdAt: string; messageIds: string[] }
export type AgentActionKind = 'mejorar_agente' | 'mejorar_portal' | 'procesar_documentos' | 'corregir_documento';
export interface AgentAction { id: string; agentId: string; messageId: string; kind: AgentActionKind; payload: Record<string, any>; status: 'proposed' | 'running' | 'done' | 'failed' | 'dismissed';
  result: Record<string, any> | null; error: string | null; link: string | null; createdAt: string; updatedAt: string; needsConfirmation: boolean }
export interface DocumentQueue { queued: number; active: number; maxActive: number; minFreeMb: number; freeMb: number }
export interface BatchLimits { maxUploadBytes: number; maxEntries: number; maxDocs: number; maxPdfBytes: number; maxTotal: number; maxRatio: number }
export type ReceiveResult = { kind: 'pdf'; jobs: (DocumentJob & { duplicate?: boolean })[] } | { kind: 'zip'; batch: DocumentBatch };
export interface ChatEstimate { harness: ExecutionBackend; label: string; billable: boolean; estimatedUsd: number;
  /** USD por millón de tokens de entrada (0 si no factura) y si su arnés envía de verdad las imágenes al modelo. */
  inputUsdPerMTok?: number; imagesToModel?: boolean }
export interface WorkItem { id: string; kind: string; title: string; status: string; column: 'requested' | 'queued' | 'doing' | 'done' | 'stopped'; createdAt: string; finishedAt: string | null; projectId: string; lead: boolean; purpose: string | null; deliverable: string | null; knowledgeDocId: string | null; steps: { title: string; status: string }[] }
export interface Revision { n: number; hash: string; state: string; source: string; note: string; by: string; at: string }
export interface FolderStatus { folder: string | null; path: string | null; adopted: { n: number; hash: string; at: string; source: string; files?: PortableFiles; fileList?: string[] } | null; missingOnDisk?: boolean;
  external: { hash: string; diff: { path: string; change: string; added: string[]; removed: string[] }[]; problems: { path: string; message: string; blocking: boolean }[]; notAdopted: string[] } | null; revisions: Revision[]; ignored: string[] }
export interface AgentEvent { id: string; kind: string; detail: Record<string, unknown>; at: string; by: string }
export interface AgentPanel { agent: Agent; office: OfficeAgent | null; department: { slug: string; name: string; purpose: string } | null; retired: boolean; work: WorkItem[];
  memory: { verified: Lesson[]; proposed: Lesson[]; retired: Lesson[] }; chat: { usage: { used: number; cap: number }; estimate: ChatEstimate }; identity: { hasInstructions: boolean; skills: number; memory: number }; folder: FolderStatus; events: AgentEvent[];
  external: { state: IntegrationState; hasOutputs: boolean; root: string } | null }
export interface WizardInput {
  name: string; role: string; summary: string; responsibilities: string[]; deliverables: string[]; department: string; departmentPurpose?: string | null;
  scope: 'workspace' | 'project'; projectId: string | null; harness: ExecutionBackend; model: string; provider?: ProviderId | null; effort: 'low' | 'medium' | 'high';
  tools: string[]; knowledge: string[]; capabilities: Capability[]; autonomy: 'ask' | 'within_scope'; instructions?: string | null; skills?: PortableSkill[]; references?: PortableKnowledge[]; authorized: boolean;
}
export interface ImportPreview { path: string; hash: string; files: string[]; ignored: string[]; problems: { path: string; message: string; blocking: boolean }[]; ok: boolean;
  agent: { name: string; role: string; summary: string; department: string | null; responsibilities: string[]; deliverables: string[]; capabilities: string[] } | null;
  requests: { harness: string; model: string; tools: string[]; autonomy: string } | null; instructions: string; skills: { slug: string; name: string; description: string; body: string }[]; memory: { title: string; text: string }[]; references: { slug: string; title: string; body: string }[]; note: string }

const J = (body: unknown) => JSON.stringify(body);
/** Problema que impide exportar el paquete (409 de export.zip). */
export interface BundleProblem { path: string; message: string }
/**
 * Descarga un archivo binario (GET) como blob y lo guarda con el nombre que da el servidor. Si falla, lanza un ApiError
 * con el motivo del servidor; en un 409 de export.zip, `body.problems` trae la lista de lo que impide exportar.
 */
async function downloadBlob(url: string, fallbackName: string): Promise<{ fileName: string; bytes: number }> {
  let res: Response;
  try { res = await fetch(url, { headers: { ...ownerHeaders() } }); }
  catch { throw new ApiError(0, 'No se pudo conectar con el Portal para descargar el paquete.'); }
  if (!res.ok) {
    let body: any = null; try { body = await res.json(); } catch { /* sin JSON */ }
    const problems: BundleProblem[] = Array.isArray(body?.problems) ? body.problems : [];
    const reason = problems.length ? problems.map(p => (p.path ? `${p.path}: ${p.message}` : p.message)).join(' · ') : null;
    throw new ApiError(res.status, body?.error ?? reason ?? `No se pudo descargar el paquete (error ${res.status}).`, body);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd); const plain = /filename="([^"]+)"/i.exec(cd);
  let fileName = fallbackName;
  try { fileName = star ? decodeURIComponent(star[1]!) : plain ? plain[1]! : fallbackName; } catch { fileName = plain ? plain[1]! : fallbackName; }
  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a'); a.href = href; a.download = fileName; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  } finally { setTimeout(() => URL.revokeObjectURL(href), 1000); }
  return { fileName, bytes: blob.size };
}
/** PUT del archivo tal cual (application/octet-stream) con progreso: el servidor lo escribe en disco por partes. */
function streamUpload<T>(url: string, file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open('PUT', url); x.setRequestHeader('Content-Type', 'application/octet-stream');
    for (const [k, v] of Object.entries(ownerHeaders())) x.setRequestHeader(k, v); // subir es un cambio: con la sesión del propietario
    if (onProgress) x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let body: any = null; try { body = x.responseText ? JSON.parse(x.responseText) : null; } catch { /* respuesta no JSON */ }
      if (x.status >= 200 && x.status < 300) resolve(body as T);
      else { noteOwnerResponse(x.status, body); reject(new ApiError(x.status, body?.error ?? (x.status === 413 ? 'El archivo supera el tamaño permitido.' : `Error ${x.status}`), body)); }
    };
    x.onerror = () => reject(new ApiError(0, 'No se pudo contactar con el servidor del Portal.', { code: 'unreachable' }));
    x.onabort = () => reject(new ApiError(0, 'Subida cancelada.', { code: 'aborted' }));
    signal?.addEventListener('abort', () => x.abort());
    x.send(file);
  });
}
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
  sendChat: (slug: string, id: string, text: string, projectId: string | null, authorizeBillable?: boolean, attachmentIds: string[] = []) => request<{ owner: AgentMessage; reply: AgentMessage }>(`${W(slug)}/agents/${id}/chat`, { method: 'POST', body: J({ text, projectId, authorizeBillable, attachmentIds }) }),
  attachments: (slug: string, id: string) => request<{ attachments: ChatAttachment[]; limits: Record<AttachmentKind, number> }>(`${W(slug)}/agents/${id}/attachments`),
  uploadAttachment: (slug: string, id: string, file: File, projectId: string | null, onProgress?: (fraction: number) => void, signal?: AbortSignal) =>
    streamUpload<ChatAttachment>(`${W(slug)}/agents/${id}/attachments?name=${encodeURIComponent(file.name)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`, file, onProgress, signal),
  deleteAttachment: (slug: string, id: string, attId: string) => request<{ ok: boolean }>(`${W(slug)}/agents/${id}/attachments/${attId}`, { method: 'DELETE' }),
  attachmentUrl: (slug: string, id: string, attId: string) => `${W(slug)}/agents/${id}/attachments/${attId}/file`,
  confirmAction: (slug: string, id: string, actionId: string) => request<AgentAction>(`${W(slug)}/agents/${id}/actions/${actionId}/confirm`, { method: 'POST', body: J({ authorized: true }) }),
  rerouteAction: (slug: string, id: string, actionId: string) => request<AgentAction>(`${W(slug)}/agents/${id}/actions/${actionId}/reroute`, { method: 'POST', body: J({}) }),
  dismissAction: (slug: string, id: string, actionId: string) => request<AgentAction>(`${W(slug)}/agents/${id}/actions/${actionId}/dismiss`, { method: 'POST', body: J({}) }),
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
  /** URL del paquete portable (ZIP) del agente. */
  exportZipUrl: (slug: string, id: string) => `${W(slug)}/agents/${encodeURIComponent(id)}/export.zip`,
  /** Descarga el paquete portable (ZIP). Sin costo de IA. Lanza ApiError con el motivo (y `body.problems` en un 409). */
  downloadZip: (slug: string, id: string) => downloadBlob(`${W(slug)}/agents/${encodeURIComponent(id)}/export.zip`, 'agente-paquete-portable.zip'),
  exportTo: (slug: string, id: string, path: string) => request<{ path: string }>(`${W(slug)}/agents/${id}/export`, { method: 'POST', body: J({ path }) }),
  // Agentes externos (referencia gestionada) y su banco de documentos — apps/server/src/routes/externalAgents.ts
  externalPreview: (slug: string, path: string) => request<ExternalPreview>(`${W(slug)}/agents/external/preview`, { method: 'POST', body: J({ path }) }),
  importExternal: (slug: string, body: { path: string; hash: string; name: string; role: string; summary: string; department: string; harness: ExecutionBackend; model: string; effort?: 'low' | 'medium' | 'high'; grants: ExternalGrants }) =>
    request<Agent>(`${W(slug)}/agents/external`, { method: 'POST', body: J({ ...body, authorized: true }) }),
  source: (slug: string, id: string) => request<SourceStatus>(`${W(slug)}/agents/${id}/source`),
  adoptSource: (slug: string, id: string, hash: string) => request<{ revision: number }>(`${W(slug)}/agents/${id}/source/adopt`, { method: 'POST', body: J({ hash }) }),
  setGrants: (slug: string, id: string, grants: ExternalGrants) => request<unknown>(`${W(slug)}/agents/${id}/source/grants`, { method: 'PUT', body: J({ grants, authorized: true }) }),
  restoreSource: (slug: string, id: string, n: number) => request<{ revision: number; backup: string }>(`${W(slug)}/agents/${id}/source/restore`, { method: 'POST', body: J({ n, authorized: true }) }),
  documents: (slug: string, id: string) => request<{ jobs: DocumentJob[]; batches: DocumentBatch[]; running: { slug: string; agentId: string; jobId: string }[]; proposals: ImprovementProposal[]; queue: DocumentQueue; limits: BatchLimits }>(`${W(slug)}/agents/${id}/documents`),
  /** Subida en flujo (sin base64 ni límite de 10 PDF): un PDF → documento; un ZIP → lote con todos sus PDF. */
  uploadDocumentFile: (slug: string, id: string, file: File, onProgress?: (fraction: number) => void) => streamUpload<ReceiveResult>(`${W(slug)}/agents/${id}/documents/upload?name=${encodeURIComponent(file.name)}`, file, onProgress),
  batchAction: (slug: string, id: string, batchId: string, action: 'start' | 'pause' | 'resume' | 'retry' | 'cancel', body: { includeRejected?: boolean; items?: number[] } = {}) =>
    request<DocumentBatch>(`${W(slug)}/agents/${id}/batches/${batchId}/${action}`, { method: 'POST', body: J({ ...body, authorized: true }) }),
  batchDeliverable: (slug: string, id: string, batchId: string) => request<{ deliverable: string | null }>(`${W(slug)}/agents/${id}/batches/${batchId}/deliverable`, { method: 'POST', body: J({}) }),
  batchFileUrl: (slug: string, id: string, batchId: string, path: string) => `${W(slug)}/agents/${id}/batches/${batchId}/file?path=${encodeURIComponent(path)}`,
  uploadDocument: (slug: string, id: string, name: string, contentBase64: string) => request<{ jobs: (DocumentJob & { duplicate?: boolean })[]; skipped: string[] }>(`${W(slug)}/agents/${id}/documents`, { method: 'POST', body: J({ name, contentBase64 }) }),
  processDocument: (slug: string, id: string, jobId: string, feedback?: string | null) => request<DocumentJob>(`${W(slug)}/agents/${id}/documents/${jobId}/process`, { method: 'POST', body: J({ authorized: true, feedback: feedback ?? null }) }),
  documentFileUrl: (slug: string, id: string, jobId: string, path: string, download = false) => `${W(slug)}/agents/${id}/documents/${jobId}/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`,
  evidence: (slug: string, id: string, jobId: string, n: number) => request<{ images: string[] }>(`${W(slug)}/agents/${id}/documents/${jobId}/versions/${n}/evidence`),
  sendFeedback: (slug: string, id: string, jobId: string | null, text: string) => request<ImprovementProposal>(`${W(slug)}/agents/${id}/feedback`, { method: 'POST', body: J({ jobId, text }) }),
  applyProposal: (slug: string, id: string, pid: string) => request<{ revision: number; backup: string; files: ExternalFileChange[] }>(`${W(slug)}/agents/${id}/proposals/${pid}/apply`, { method: 'POST', body: J({ authorized: true }) }),
  rejectProposal: (slug: string, id: string, pid: string) => request<ImprovementProposal>(`${W(slug)}/agents/${id}/proposals/${pid}/reject`, { method: 'POST', body: J({}) })
};

export interface ExternalPreview {
  path: string; hash: string; layout: ExternalLayout; links: string[]; problems: { path: string; message: string; blocking: boolean }[]; otherFiles: number; ok: boolean;
  duplicate: { agentId: string; name: string } | null; suggested: { name: string; summary: string };
  prompt: { instructions: string; context: { path: string; text: string }[]; skills: (ExternalLayout['skills'][number] & { body: string })[]; memory: { path: string; text: string } | null };
  adapters: { path: string; text: string }[]; scripts: { path: string; sha256: string; bytes: number }[]; note: string;
}
export interface SourceStatus {
  root: string; layout: ExternalLayout; provenance: ExternalProvenance; state: IntegrationState; grants: ExternalGrants; revision: number; adoptedHash: string; diskHash: string | null; readError: string | null;
  changes: ExternalFileChange[]; diff: { path: string; before: string | null; after: string | null }[]; problems: { path: string; message: string; blocking: boolean }[]; links: string[]; scripts: { path: string; sha256: string; changedOnDisk: boolean }[];
  revisions: { n: number; hash: string; source: string; note: string; by: string; at: string }[];
  toolchain: { python: string | null; pythonVersion: string | null; soffice: string | null; problems: string[] };
}

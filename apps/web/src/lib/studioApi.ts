import type { StudioAsset, StudioClip, StudioFormat, StudioHeight, StudioLimits, StudioProject, StudioQuality, StudioRender } from '@portal-ia/domain';
import { apiRequest, ApiError } from './api.ts';
import { noteOwnerResponse, ownerHeaders } from './owner.ts';

/** Portal IA 4 · cliente del Estudio. */
export type MediaEngine = { state: 'ready' } | { state: 'no_docker' | 'missing_image'; detail: string; hint: string };
export interface StudioProviderInfo { id: string; name: string; capabilities: string[]; state: 'verified' | 'configured_untested' | 'requires_connection' | 'requires_paid_auth' | 'unsupported'; note: string; priceHint: string | null }
export interface StudioStatus { engine: MediaEngine; limits: StudioLimits; providers: StudioProviderInfo[] }
export interface StudioProjectSummary { id: string; name: string; format: StudioFormat; revision: number; duration: number; clips: number; createdAt: string; updatedAt: string }
export interface StudioFull { project: StudioProject; assets: StudioAsset[]; renders: StudioRender[] }
export interface StudioVersion { revision: number; label: string | null; at: string }

const W = (slug: string) => `/api/workspaces/${slug}/studio`;
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

export const studioApi = {
  status: (slug: string, fresh = false) => apiRequest<StudioStatus>(`${W(slug)}/status${fresh ? '?fresh=1' : ''}`),
  list: (slug: string) => apiRequest<StudioProjectSummary[]>(`${W(slug)}/projects`),
  create: (slug: string, name: string, format: StudioFormat) => apiRequest<StudioFull>(`${W(slug)}/projects`, json('POST', { name, format })),
  get: (slug: string, id: string) => apiRequest<StudioFull>(`${W(slug)}/projects/${id}`),
  save: (slug: string, id: string, project: StudioProject, baseRevision: number, label?: string | null) => apiRequest<{ project: StudioProject; fixes: string[] }>(`${W(slug)}/projects/${id}`, json('PUT', { project, baseRevision, label: label ?? null })),
  duplicate: (slug: string, id: string) => apiRequest<StudioFull>(`${W(slug)}/projects/${id}/duplicate`, json('POST', {})),
  remove: (slug: string, id: string) => apiRequest<{ ok: true }>(`${W(slug)}/projects/${id}`, json('DELETE', { confirm: true })),
  versions: (slug: string, id: string) => apiRequest<StudioVersion[]>(`${W(slug)}/projects/${id}/versions`),
  restore: (slug: string, id: string, revision: number) => apiRequest<StudioFull>(`${W(slug)}/projects/${id}/versions/${revision}/restore`, json('POST', {})),
  removeAsset: (slug: string, assetId: string) => apiRequest<{ ok: true }>(`${W(slug)}/assets/${assetId}`, json('DELETE', {})),
  assetUrl: (slug: string, assetId: string) => `${W(slug)}/assets/${assetId}/file`,
  parseSrt: (slug: string, srt: string) => apiRequest<{ clips: StudioClip[] }>(`${W(slug)}/captions/parse`, json('POST', { srt })),
  srtUrl: (slug: string, id: string) => `${W(slug)}/projects/${id}/captions.srt`,
  render: (slug: string, id: string, height: StudioHeight, quality: StudioQuality) => apiRequest<StudioRender>(`${W(slug)}/projects/${id}/renders`, json('POST', { height, quality })),
  renderState: (slug: string, renderId: string) => apiRequest<StudioRender>(`${W(slug)}/renders/${renderId}`),
  cancelRender: (slug: string, renderId: string) => apiRequest<StudioRender>(`${W(slug)}/renders/${renderId}/cancel`, json('POST', {})),
  renderUrl: (slug: string, renderId: string, download = false) => `${W(slug)}/renders/${renderId}/file${download ? '?download=1' : ''}`,

  /** Subida en flujo con avance (XMLHttpRequest: fetch no informa del progreso de envío). Lleva la sesión del propietario. */
  upload(slug: string, projectId: string, file: File, onProgress: (fraction: number) => void): Promise<StudioAsset> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${W(slug)}/projects/${projectId}/assets`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
      for (const [k, v] of Object.entries(ownerHeaders())) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onerror = () => reject(new ApiError(0, 'No se pudo subir el archivo: se perdió la conexión con el Portal.'));
      xhr.onload = () => {
        let body: any = null; try { body = JSON.parse(xhr.responseText); } catch { /* sin cuerpo */ }
        noteOwnerResponse(xhr.status, body);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as StudioAsset); else reject(new ApiError(xhr.status, body?.error ?? `Error ${xhr.status}`, body));
      };
      xhr.send(file);
    });
  }
};

export const fmtTime = (s: number): string => { const t = Math.max(0, s); const m = Math.floor(t / 60); const r = t - m * 60; return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`; };
export const fmtBytes = (n: number): string => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

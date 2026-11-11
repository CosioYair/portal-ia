import type { ExecutionResult, FlowStageStatus, PublishInfo } from '@portal-ia/domain';
import { processesRepo } from '../db/workspace.ts';
import { repoStatus } from './repoStatus.ts';

/**
 * HU-185 · Etapa «Publicar» del flujo de la historia (guiada y NO bloqueante). Publicar reutiliza la operación existente
 * (capabilities.ts → publishProjectMain); aquí solo se lee el estado del repositorio (sin red) y se traduce a la etapa.
 * Ningún estado usa 'warning', 'blocked' ni 'failed': publicar es opcional y nunca debe parecer un problema.
 */
export interface PublishStage { status: FlowStageStatus; detail: string; statusText: string }

/** Estado de publicación de main, sin red. Si algo falla, cuenta como «sin remoto» (no aplica). */
export async function getPublishInfo(repoPath: string | null | undefined): Promise<PublishInfo> {
  if (!repoPath) return { hasRemote: false, aheadOfRemote: null };
  try {
    const st = await repoStatus(repoPath);
    return { hasRemote: !!st.remote, aheadOfRemote: st.aheadOfRemote ?? null };
  } catch {
    return { hasRemote: false, aheadOfRemote: null };
  }
}

/**
 * Traduce el estado a la etapa (función pura). Orden: omitida → no aplica → hecha → pendiente.
 * Sin información del repositorio solo se sabe lo que guarda el proceso (omitida o publicada); si no, null.
 */
export function publishStageFor(info: PublishInfo | null | undefined, result: Pick<ExecutionResult, 'published' | 'publishSkipped'> | null | undefined): PublishStage | null {
  if (result?.publishSkipped) return { status: 'done', detail: 'Omitida por el propietario', statusText: 'omitida' };
  if (!info) return result?.published ? { status: 'done', detail: 'Publicada en el remoto', statusText: 'hecha' } : null;
  if (!info.hasRemote) return { status: 'done', detail: 'El proyecto no tiene remoto', statusText: 'no aplica' };
  if (info.aheadOfRemote === 0 || result?.published) return { status: 'done', detail: 'Publicada en el remoto', statusText: 'hecha' };
  const detail = info.aheadOfRemote === -1 ? 'La rama main nunca se publicó' : info.aheadOfRemote && info.aheadOfRemote > 0 ? `${info.aheadOfRemote} commit(s) de main sin publicar` : 'main sin publicar';
  return { status: 'pending', detail, statusText: 'pendiente' };
}

/** Guarda en result que el propietario omite publicar (mismo mecanismo que markPublishedIncluded con result.published). */
export function markPublishSkipped(slug: string, processId: string): { at: string } {
  const procs = processesRepo(slug);
  const p = procs.get(processId);
  if (!p) throw Object.assign(new Error('Proceso no encontrado.'), { statusCode: 404 });
  if (!p.result?.merged) throw Object.assign(new Error('La historia aún no está integrada en main: no hay nada que publicar u omitir.'), { statusCode: 409 });
  const at = new Date().toISOString();
  procs.setResult(p.id, { ...p.result, publishSkipped: { at } });
  return { at };
}

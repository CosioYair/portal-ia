import { useCallback, useEffect, useState } from 'react';
import { PortalSyncStatusSchema, RestartNoticeSchema } from '@portal/contracts';
import type { PortalSyncStatus, RestartNotice } from '@portal/contracts';

const POLL_MS = 30_000;

type SyncState =
  | { readonly kind: 'cargando' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'listo'; readonly status: PortalSyncStatus; readonly notice: RestartNotice };

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Respuesta ${response.status}`);
  return response.json();
}

function branchText(status: PortalSyncStatus): string {
  return status.detached ? 'HEAD suelto (sin rama)' : (status.activeBranch ?? 'desconocida');
}

function mainText(status: PortalSyncStatus): { icon: string; text: string } {
  if (status.mainSha === null) return { icon: '❓', text: 'No existe la rama main' };
  if (status.branchMatchesMain) return { icon: '✅', text: 'Coincide con main' };
  return {
    icon: '⚠️',
    text: `${status.aheadOfMain} por delante / ${status.behindMain} por detrás de main`
  };
}

function remoteText(status: PortalSyncStatus): { icon: string; text: string } {
  if (!status.remote.tracked) return { icon: '🚫', text: 'Sin remoto (origin/main no conocido)' };
  if (status.remote.published) return { icon: '☁️', text: 'Publicado en GitHub' };
  if (status.remote.ahead > 0 && status.remote.behind > 0) {
    return { icon: '⚠️', text: 'main y origin/main han divergido' };
  }
  return { icon: '⏳', text: `Pendiente de publicar (${status.remote.ahead} commits)` };
}

function storiesText(stories: readonly string[]): string {
  return stories.length > 0 ? stories.join(', ') : 'cambios sin historia asociada';
}

export function PortalSyncBar() {
  const [state, setState] = useState<SyncState>({ kind: 'cargando' });

  const refresh = useCallback(async () => {
    try {
      const [rawStatus, rawNotice] = await Promise.all([
        fetchJson('/api/portal/sync-status'),
        fetchJson('/api/portal/restart-notice')
      ]);
      setState({
        kind: 'listo',
        status: PortalSyncStatusSchema.parse(rawStatus),
        notice: RestartNoticeSchema.parse(rawNotice)
      });
    } catch {
      setState({ kind: 'error', message: 'No se pudo consultar el estado de sincronización del Portal.' });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  if (state.kind === 'cargando') {
    return (
      <div role="status" aria-live="polite">
        <span aria-hidden="true">⏳</span> Comprobando sincronización del Portal…
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div role="alert">
        <span aria-hidden="true">❌</span> {state.message}{' '}
        <button type="button" onClick={() => void refresh()}>
          Reintentar
        </button>
      </div>
    );
  }

  const { status, notice } = state;
  const main = mainText(status);
  const remote = remoteText(status);

  return (
    <div aria-label="Sincronización del Portal">
      {notice.action === 'restart' && (
        <div
          role="alert"
          style={{ background: '#fff3cd', border: '2px solid #b58900', padding: '8px 12px', fontWeight: 600 }}
        >
          <span aria-hidden="true">🔄</span> Reinicia el Portal para ver: {storiesText(notice.affectedStories)}
        </div>
      )}
      {notice.action === 'reload' && (
        <div role="status" style={{ background: '#e7f1ff', border: '2px solid #1f6feb', padding: '8px 12px' }}>
          <span aria-hidden="true">🔁</span> Hay cambios de interfaz para ver: {storiesText(notice.affectedStories)}{' '}
          <button type="button" onClick={() => window.location.reload()}>
            Recargar
          </button>
        </div>
      )}
      <ul style={{ display: 'flex', gap: 16, listStyle: 'none', margin: 0, padding: '4px 12px' }}>
        <li>
          <span aria-hidden="true">🌿</span> Rama: <strong>{branchText(status)}</strong>
        </li>
        <li>
          <span aria-hidden="true">{main.icon}</span> {main.text}
        </li>
        <li>
          <span aria-hidden="true">{remote.icon}</span> {remote.text}
        </li>
      </ul>
    </div>
  );
}

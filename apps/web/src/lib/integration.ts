import type { IntegrationStatus } from '@portal-ia/domain';

/** Fallo accionable devuelto por el backend (409): motivo del bloqueo o causa + solución. */
export interface IntegrationFailure {
  code: string;
  reason?: string;
  cause?: string;
  solution?: string;
  mergedCommit?: string;
}

export type IntegrateOutcome =
  | { ok: true; into: string; commit: string; remote: string }
  | { ok: false; failure: IntegrationFailure };

export async function fetchIntegrationStatus(): Promise<IntegrationStatus> {
  const r = await fetch('/api/portal/integration/status');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as IntegrationStatus;
}

export async function integrateBranch(branch: string): Promise<IntegrateOutcome> {
  try {
    const r = await fetch('/api/portal/integration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch })
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, into: data.into, commit: data.commit, remote: data.remote };
    if (r.status === 409) return { ok: false, failure: data as IntegrationFailure };
    return { ok: false, failure: { code: 'HTTP_ERROR', cause: (data as { error?: string }).error ?? `El servidor respondió ${r.status}.`, solution: 'Vuelve a intentarlo en unos segundos.' } };
  } catch {
    return { ok: false, failure: { code: 'NETWORK', cause: 'No se pudo contactar con el backend local.', solution: 'Comprueba que el Portal está en marcha (npm start) y reintenta.' } };
  }
}

import { useCallback, useEffect, useState } from 'react';
import { StoryClosureStatusSchema, isApiError } from '@portal/contracts';
import type { StoryClosureStatus } from '@portal/contracts';
import { StoryStatusBadge } from '../components/StoryStatusBadge.tsx';

export interface BacklogStory {
  readonly id: string;
  readonly title: string;
}

export type CompleteOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface BacklogApi {
  getClosure(storyId: string): Promise<StoryClosureStatus>;
  complete(storyId: string): Promise<CompleteOutcome>;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Cliente HTTP por defecto. El backend es la autoridad: la UI solo refleja su respuesta. */
export const httpBacklogApi: BacklogApi = {
  async getClosure(storyId) {
    const response = await fetch(`/stories/${encodeURIComponent(storyId)}/closure`);
    const body = await readJson(response);
    if (!response.ok) {
      throw new Error(isApiError(body) ? body.message : `Error ${response.status} al consultar el cierre`);
    }
    const parsed = StoryClosureStatusSchema.safeParse(body);
    if (!parsed.success) throw new Error('La respuesta del estado de cierre no es válida');
    return parsed.data;
  },
  async complete(storyId) {
    const response = await fetch(`/stories/${encodeURIComponent(storyId)}/complete`, { method: 'POST' });
    const body = await readJson(response);
    if (response.status === 409 && isApiError(body)) return { ok: false, reason: body.message };
    if (!response.ok) {
      throw new Error(isApiError(body) ? body.message : `Error ${response.status} al completar la historia`);
    }
    return { ok: true };
  }
};

type RowState =
  | { readonly kind: 'cargando' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'listo'; readonly status: StoryClosureStatus; readonly completing: boolean };

interface StoryRowProps {
  readonly story: BacklogStory;
  readonly api: BacklogApi;
}

function StoryRow({ story, api }: StoryRowProps) {
  const [state, setState] = useState<RowState>({ kind: 'cargando' });

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'cargando' });
    try {
      const status = await api.getClosure(story.id);
      setState({ kind: 'listo', status, completing: false });
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : 'Error desconocido' });
    }
  }, [api, story.id]);

  useEffect(() => {
    let cancelled = false;
    api
      .getClosure(story.id)
      .then((status) => {
        if (!cancelled) setState({ kind: 'listo', status, completing: false });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ kind: 'error', message: error instanceof Error ? error.message : 'Error desconocido' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, story.id]);

  async function onComplete(status: StoryClosureStatus): Promise<void> {
    setState({ kind: 'listo', status, completing: true });
    try {
      const outcome = await api.complete(story.id);
      if (outcome.ok) {
        await load();
      } else {
        // El backend rechazó el cierre (409): se muestra su motivo.
        setState({ kind: 'listo', status: { ...status, canClose: false, reason: outcome.reason }, completing: false });
      }
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : 'Error desconocido' });
    }
  }

  const reasonId = `motivo-${story.id}`;

  return (
    <li style={{ padding: '0.75rem 0', borderBottom: '1px solid #e5e7eb' }}>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{story.title}</strong>
        {state.kind === 'listo' && <StoryStatusBadge indicator={state.status.indicator} />}
      </div>

      {state.kind === 'cargando' && <p role="status">Cargando estado de cierre…</p>}

      {state.kind === 'error' && (
        <p role="alert">
          No se pudo obtener el estado de cierre: {state.message}{' '}
          <button type="button" onClick={() => void load()}>
            Reintentar
          </button>
        </p>
      )}

      {state.kind === 'listo' && state.status.indicator !== null && (
        <div>
          <button
            type="button"
            disabled={!state.status.canClose || state.completing}
            aria-describedby={state.status.reason === null ? undefined : reasonId}
            onClick={() => void onComplete(state.status)}
          >
            {state.completing ? 'Completando…' : 'Marcar historia como completada'}
          </button>
          {state.status.reason !== null && (
            <p id={reasonId} role="status">
              Bloqueada: {state.status.reason}.
            </p>
          )}
          {state.status.hasRepository && (
            <p style={{ fontSize: '0.8rem', color: '#4b5563' }}>
              El estado del remoto refleja la última sincronización conocida (no se consulta la red).
            </p>
          )}
        </div>
      )}

      {state.kind === 'listo' && state.status.indicator === null && <p>Historia completada.</p>}
    </li>
  );
}

export interface BacklogScreenProps {
  readonly stories: readonly BacklogStory[];
  readonly api?: BacklogApi;
}

/** Backlog con indicador de progreso por historia y cierre condicionado a integración y publicación. */
export function BacklogScreen({ stories, api = httpBacklogApi }: BacklogScreenProps) {
  if (stories.length === 0) {
    return (
      <section>
        <h1>Backlog</h1>
        <p>No hay historias en el backlog.</p>
      </section>
    );
  }
  return (
    <section>
      <h1>Backlog</h1>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {stories.map((story) => (
          <StoryRow key={story.id} story={story} api={api} />
        ))}
      </ul>
    </section>
  );
}

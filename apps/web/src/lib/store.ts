import { createContext, useContext } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Project, ProviderView, Workspace } from '@portal-ia/domain';
import type { BootstrapStatus } from './api.ts';

export interface Toast { message: string; tone: 'ok' | 'err' }

export interface AppState {
  status: BootstrapStatus;
  providers: ProviderView[];
  connected: ProviderView | null;
  refresh: () => Promise<void>;
  flash: (message: string, tone?: Toast['tone']) => void;
  navigate: NavigateFunction;
  /** Estructura multiempresa: empresas, proyectos de la empresa actual y selección. */
  workspaces: Workspace[];
  projects: Project[];
  /** Elige empresa y proyecto; devuelve el proyecto elegido (null si la empresa no tiene). */
  /** Elige empresa y proyecto; con `go`, navega en la MISMA actualización (la pantalla se monta ya en su destino). */
  select: (workspaceSlug: string, projectId?: string | null, go?: SelectGo) => Promise<string | null>;
  refreshStructure: () => Promise<void>;
}

export interface SelectGo { to: (projectId: string | null) => string; replace?: boolean }
export const AppContext = createContext<AppState | null>(null);
export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp fuera de AppContext');
  return ctx;
}

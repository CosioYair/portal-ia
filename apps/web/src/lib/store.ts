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
  select: (workspaceSlug: string, projectId?: string | null) => Promise<void>;
  refreshStructure: () => Promise<void>;
}

export const AppContext = createContext<AppState | null>(null);
export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp fuera de AppContext');
  return ctx;
}

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { Project, ProviderView, Workspace } from '@portal-ia/domain';
import { api, type BootstrapStatus } from './lib/api.ts';
import { AppContext, type Toast } from './lib/store.ts';
import { Welcome } from './screens/Welcome.tsx';
import { ProviderSetup } from './screens/ProviderSetup.tsx';
import { Initialization } from './screens/Initialization.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { Team } from './screens/Team.tsx';
import { AgentDetail } from './screens/AgentDetail.tsx';
import { AgentCreate } from './screens/AgentCreate.tsx';
import { ProcessList, ProcessView } from './screens/ProcessView.tsx';
import { ManualTestFeedbackPanel } from './screens/ManualTestFeedbackPanel.tsx';
import { Knowledge } from './screens/Knowledge.tsx';
import { Backlog } from './screens/Backlog.tsx';
import { Assistant } from './screens/Assistant.tsx';
import { CompanyHome } from './screens/CompanyHome.tsx';
import { Icon } from './components/ui.tsx';
import { InboxLauncher, InboxScreen } from './screens/InboxScreen.tsx';

const SEL_KEY = 'portal-ia.seleccion';
type Selection = { ws: string; project: string | null };
const readSel = (): Selection | null => { try { const v = localStorage.getItem(SEL_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const writeSel = (s: Selection) => { try { localStorage.setItem(SEL_KEY, JSON.stringify(s)); } catch { /* sin almacenamiento */ } };

/** Ruta profunda /empresa/:slug/proyecto/:pid/<destino>: fija la selección y redirige a la pantalla. */
function SelectRoute({ select }: { select: (ws: string, pid?: string | null) => Promise<void> }) {
  const { slug, pid, '*': rest } = useParams();
  const navigate = useNavigate();
  useEffect(() => { select(slug!, pid ?? null).then(() => navigate('/' + (rest || 'panel'), { replace: true })); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, pid]);
  return <div className="app" style={{ display: 'grid', placeItems: 'center' }}><span className="spin" aria-label="Cargando" /></div>;
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sel, setSel] = useState<Selection | null>(readSel);
  const [offline, setOffline] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const navigate = useNavigate();

  const loadProjects = useCallback(async (ws: string) => { try { return await api.projects(ws); } catch { return []; } }, []);

  const refreshStructure = useCallback(async () => {
    const wss = await api.workspaces().catch(() => [] as Workspace[]);
    setWorkspaces(wss);
    const current = sel && wss.some(w => w.slug === sel.ws) ? sel : wss.length ? { ws: (wss.find(w => w.kind === 'internal') ?? wss[0]).slug, project: null } : null;
    if (current) { const ps = await loadProjects(current.ws); setProjects(ps); const pid = current.project && ps.some(p => p.id === current.project) ? current.project : ps[0]?.id ?? null; const next = { ws: current.ws, project: pid }; setSel(next); writeSel(next); }
  }, [sel, loadProjects]);

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.bootstrapStatus(), api.providers()]);
      setBootstrap(s); setProviders(p); setOffline(false);
      await refreshStructure();
    } catch { setOffline(true); }
  }, [refreshStructure]);

  useEffect(() => { void refresh(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = useCallback(async (ws: string, projectId?: string | null) => {
    const ps = await loadProjects(ws); setProjects(ps);
    const pid = projectId && ps.some(p => p.id === projectId) ? projectId : ps[0]?.id ?? null;
    const next = { ws, project: pid }; setSel(next); writeSel(next);
  }, [loadProjects]);

  const flash = useCallback((message: string, tone: Toast['tone'] = 'ok') => { setToast({ message, tone }); window.setTimeout(() => setToast(null), 2800); }, []);

  // El estado que consumen las pantallas: el bootstrap, pero con la empresa y el proyecto SELECCIONADOS.
  const status = useMemo<BootstrapStatus | null>(() => {
    if (!bootstrap) return null;
    const ws = workspaces.find(w => w.slug === sel?.ws) ?? bootstrap.workspace;
    const project = projects.find(p => p.id === sel?.project) ?? (ws?.slug === bootstrap.workspace?.slug ? bootstrap.project : null);
    return { ...bootstrap, workspace: ws, project };
  }, [bootstrap, workspaces, projects, sel]);

  if (offline) {
    return <div className="app" style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
      <div className="card" style={{ maxWidth: 520, padding: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="h3">No se encuentra el backend local</div>
        <p className="med">La interfaz necesita el servidor local de Portal IA. Arráncalo con <code className="mono">npm start</code> y vuelve a intentarlo.</p>
        <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => refresh()}>Reintentar</button>
      </div>
    </div>;
  }
  if (!status) return <div className="app" style={{ display: 'grid', placeItems: 'center' }}><span className="spin" aria-label="Cargando" /></div>;

  const connected = providers.find(p => p.status === 'connected') ?? null;
  const ready = status.initialized && !!status.workspace;
  const home = ready ? '/panel' : connected ? '/configuracion/inicializar' : '/configuracion/proveedor';
  const guard = (el: ReactElement) => ready ? (status.project ? el : <CompanyHome />) : <Navigate to={home} replace />;

  return (
    <AppContext.Provider value={{ status, providers, connected, refresh, flash, navigate, workspaces, projects, select, refreshStructure }}>
      <div className="app">
        {toast && <div className="toast" role="status">{toast.tone === 'ok' ? Icon.okc() : Icon.alert()} {toast.message}</div>}
        {ready && <InboxLauncher />}
        <Routes>
          <Route path="/" element={ready ? <Navigate to="/panel" replace /> : <Welcome />} />
          <Route path="/configuracion/proveedor" element={<ProviderSetup />} />
          <Route path="/configuracion/inicializar" element={connected ? <Initialization /> : <Navigate to="/configuracion/proveedor" replace />} />
          <Route path="/empresa/:slug/proyecto/:pid/*" element={<SelectRoute select={select} />} />
          <Route path="/empresa/:slug/*" element={<SelectRoute select={select} />} />
          <Route path="/asistente" element={ready ? <Assistant /> : <Navigate to={home} replace />} />
          <Route path="/panel" element={guard(<Dashboard />)} />
          <Route path="/equipo" element={guard(<Team />)} />
          <Route path="/equipo/nuevo" element={guard(<AgentCreate />)} />
          <Route path="/equipo/:agentId" element={guard(<AgentDetail />)} />
          <Route path="/actividad" element={guard(<ProcessList />)} />
          <Route path="/procesos/:processId" element={guard(<><ProcessView /><ManualTestFeedbackPanel /></>)} />
          <Route path="/conocimiento" element={guard(<Knowledge />)} />
          <Route path="/backlog" element={guard(<Backlog />)} />
          <Route path="/autorizaciones" element={ready ? <InboxScreen /> : <Navigate to={home} replace />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </div>
    </AppContext.Provider>
  );
}

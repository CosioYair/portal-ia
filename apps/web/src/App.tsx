import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom';
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
import { StoryWorkspace } from './screens/StoryWorkspace.tsx';
import { Knowledge } from './screens/Knowledge.tsx';
import { Backlog } from './screens/Backlog.tsx';
import { Phase } from './screens/Phase.tsx';
import { Archive } from './screens/Archive.tsx';
import { Assistant } from './screens/Assistant.tsx';
import { Budgets } from './screens/Budgets.tsx';
import { BatchDetail, Batches } from './screens/Batches.tsx';
import { CompanyHome } from './screens/CompanyHome.tsx';
import { Icon, Spinner } from './components/ui.tsx';
import { InboxLauncher, InboxScreen } from './screens/InboxScreen.tsx';

const SEL_KEY = 'portal-ia.seleccion';
type Selection = { ws: string; project: string | null };
const readSel = (): Selection | null => { try { const v = localStorage.getItem(SEL_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const writeSel = (s: Selection) => { try { localStorage.setItem(SEL_KEY, JSON.stringify(s)); } catch { /* sin almacenamiento */ } };
/** Selección de un enlace directo (/empresa/:slug[/proyecto/:pid]/…): manda sobre la guardada desde el primer momento. */
const urlSel = (): Selection | null => { const m = window.location.pathname.match(/^\/empresa\/([^/]+)(?:\/proyecto\/([^/]+))?/); return m ? { ws: decodeURIComponent(m[1]), project: m[2] ? decodeURIComponent(m[2]) : null } : null; };
// Empresa y proyecto con los que se abrió cada entrada del historial de esta pestaña (por la clave de la entrada).
const HIST_KEY = 'portal-ia.seleccion.historial';
const readHist = (): Record<string, Selection> => { try { return JSON.parse(sessionStorage.getItem(HIST_KEY) ?? '{}'); } catch { return {}; } };
/** Al volver con Atrás/Adelante a una entrada de otra página (o recargarla), su selección; no la última elegida. */
const histSel = (): Selection | null => { const k = (window.history.state as { key?: string } | null)?.key; return k ? readHist()[k] ?? null : null; };

/**
 * Atrás/Adelante vuelven a la empresa y al proyecto con los que se abrió esa pantalla (antes mostraban la pantalla
 * anterior con la empresa de la última). Se anota al LLEGAR a cada entrada: cambiar de empresa navega a otra.
 */
function SelectionHistory({ sel, workspaces, select }: { sel: Selection | null; workspaces: Workspace[]; select: (ws: string, pid?: string | null) => Promise<void> }) {
  const { key } = useLocation(); const type = useNavigationType();
  const current = useRef(sel); current.current = sel;
  useEffect(() => {
    if (key === 'default') return; // la primera entrada de la pestaña no tiene clave propia
    const h = readHist(); const saved = h[key]; const cur = current.current;
    if (type === 'POP' && saved) {
      if (cur && (saved.ws !== cur.ws || saved.project !== cur.project) && workspaces.some(w => w.slug === saved.ws)) void select(saved.ws, saved.project);
      return;
    }
    if (!cur) return;
    h[key] = cur; const keys = Object.keys(h); for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete h[k];
    try { sessionStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch { /* sin almacenamiento */ }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/**
 * Posición del desplazamiento por pantalla (en esta pestaña del navegador): al recargar o con Atrás/Adelante se vuelve
 * donde estabas, esperando a que la pantalla cargue su contenido; una navegación nueva empieza arriba (o en su #ancla).
 */
function ScrollMemory() {
  const { pathname, search, hash } = useLocation(); const type = useNavigationType();
  useEffect(() => {
    const key = `portal-ia.scroll.${pathname}${search}`;
    let saved = 0; try { saved = Number(sessionStorage.getItem(key) ?? 0); } catch { /* sin almacenamiento */ }
    let tries = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    const restore = () => { if (window.scrollY >= saved - 2 || ++tries > 20) return; window.scrollTo(0, saved); timer = setTimeout(restore, 100); };
    if (type === 'POP' && saved > 0) timer = setTimeout(restore, 50); else if (type !== 'POP' && !hash) window.scrollTo(0, 0);
    // Se guarda la posición del momento del desplazamiento (al salir, la pantalla nueva ya ha cambiado la altura).
    let pending: number | null = null; let st: ReturnType<typeof setTimeout> | undefined;
    const write = () => { if (pending === null) return; try { sessionStorage.setItem(key, String(pending)); } catch { /* sin almacenamiento */ } pending = null; };
    const save = () => { pending = Math.round(window.scrollY); clearTimeout(st); st = setTimeout(write, 150); };
    window.addEventListener('scroll', save, { passive: true });
    return () => { clearTimeout(timer); clearTimeout(st); write(); window.removeEventListener('scroll', save); };
  }, [pathname, search, hash, type]);
  return null;
}

/** Ruta profunda /empresa/:slug/proyecto/:pid/<destino>: fija la selección y redirige a la pantalla. */
function SelectRoute({ select }: { select: (ws: string, pid?: string | null) => Promise<void> }) {
  const { slug, pid, '*': rest } = useParams();
  const navigate = useNavigate(); const { search, hash } = useLocation();
  // El enlace directo manda sobre la selección guardada; se conservan su pestaña (#…) y sus parámetros (?…).
  useEffect(() => { select(slug!, pid ?? null).then(() => navigate('/' + (rest || 'panel') + search + hash, { replace: true })); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, pid]);
  return <div className="app" style={{ display: 'grid', placeItems: 'center' }}><Spinner /></div>;
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // Un enlace directo se aplica al arrancar; si no, la de esa entrada del historial y, si no, la última selección guardada
  // (antes, la carga inicial podía pisar el enlace).
  const [sel, setSel] = useState<Selection | null>(() => urlSel() ?? histSel() ?? readSel());
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
  if (!status) return <div className="app" style={{ display: 'grid', placeItems: 'center' }}><Spinner /></div>;

  const connected = providers.find(p => p.status === 'connected') ?? null;
  const ready = status.initialized && !!status.workspace;
  const home = ready ? '/panel' : connected ? '/configuracion/inicializar' : '/configuracion/proveedor';
  const guard = (el: ReactElement) => ready ? (status.project ? el : <CompanyHome />) : <Navigate to={home} replace />;

  return (
    <AppContext.Provider value={{ status, providers, connected, refresh, flash, navigate, workspaces, projects, select, refreshStructure }}>
      <div className="app">
        {toast && <div className="toast" role="status">{toast.tone === 'ok' ? Icon.okc() : Icon.alert()} {toast.message}</div>}
        {ready && <InboxLauncher />}
        <ScrollMemory />
        <SelectionHistory sel={sel} workspaces={workspaces} select={select} />
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
          <Route path="/procesos/:processId" element={guard(<ProcessView />)} />
          <Route path="/historias/:storyId" element={guard(<StoryWorkspace />)} />
          <Route path="/conocimiento" element={guard(<Knowledge />)} />
          <Route path="/presupuestos" element={guard(<Budgets />)} />
          <Route path="/backlog" element={guard(<Backlog />)} />
          <Route path="/lotes" element={guard(<Batches />)} />
          <Route path="/lotes/:batchId" element={guard(<BatchDetail />)} />
          <Route path="/etapa" element={guard(<Phase />)} />
          <Route path="/archivo" element={guard(<Archive />)} />
          <Route path="/autorizaciones" element={ready ? <InboxScreen /> : <Navigate to={home} replace />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </div>
    </AppContext.Provider>
  );
}

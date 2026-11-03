import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useEntryRecorder } from './lib/nav.ts';
import { Navigate, Route, Routes, useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom';
import type { Project, ProviderView, Workspace } from '@portal-ia/domain';
import { api, type BootstrapStatus } from './lib/api.ts';
import { AppContext, type SelectGo, type Toast } from './lib/store.ts';
import { Welcome } from './screens/Welcome.tsx';
import { ProviderSetup } from './screens/ProviderSetup.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { Backlog } from './screens/Backlog.tsx';
import { Assistant } from './screens/Assistant.tsx';
import { Budgets } from './screens/Budgets.tsx';
import { CompanyHome } from './screens/CompanyHome.tsx';
import { Icon, Spinner } from './components/ui.tsx';
import { InboxScreen } from './screens/InboxScreen.tsx';
import { AssistantDock } from './components/AssistantDock.tsx';
import { AttentionWatcher } from './components/AttentionWatcher.tsx';
import { openUi, useUiEvent } from './lib/uiBus.ts';
import { officeHome } from './lib/routes.ts';
// La oficina y el asistente de creación se cargan aparte (no engordan la carga del resto de pantallas).
const Office = lazy(() => import('./screens/Office.tsx').then(m => ({ default: m.Office })));
const AgentWizard = lazy(() => import('./screens/AgentWizard.tsx').then(m => ({ default: m.AgentWizard })));
// Portal IA 2.0: también aparte Ajustes y la búsqueda (Ctrl+K), que se carga la primera vez que se abre.
const Settings = lazy(() => import('./screens/Settings.tsx').then(m => ({ default: m.Settings })));
const CommandPalette = lazy(() => import('./components/CommandPalette.tsx').then(m => ({ default: m.CommandPalette })));
// Y las pantallas de detalle y las menos frecuentes: el primer pintado solo carga el marco, la Oficina y el Resumen.
const Initialization = lazy(() => import('./screens/Initialization.tsx').then(m => ({ default: m.Initialization })));
const AgentDetail = lazy(() => import('./screens/AgentDetail.tsx').then(m => ({ default: m.AgentDetail })));
const AgentCreate = lazy(() => import('./screens/AgentCreate.tsx').then(m => ({ default: m.AgentCreate })));
const ProcessList = lazy(() => import('./screens/ProcessView.tsx').then(m => ({ default: m.ProcessList })));
const ProcessView = lazy(() => import('./screens/ProcessView.tsx').then(m => ({ default: m.ProcessView })));
const StoryWorkspace = lazy(() => import('./screens/StoryWorkspace.tsx').then(m => ({ default: m.StoryWorkspace })));
const Knowledge = lazy(() => import('./screens/Knowledge.tsx').then(m => ({ default: m.Knowledge })));
const Phase = lazy(() => import('./screens/Phase.tsx').then(m => ({ default: m.Phase })));
const Archive = lazy(() => import('./screens/Archive.tsx').then(m => ({ default: m.Archive })));
const Batches = lazy(() => import('./screens/Batches.tsx').then(m => ({ default: m.Batches })));
const BatchDetail = lazy(() => import('./screens/Batches.tsx').then(m => ({ default: m.BatchDetail })));

const SEL_KEY = 'portal-ia.seleccion';
type Selection = { ws: string; project: string | null };
const readSel = (): Selection | null => { try { const v = localStorage.getItem(SEL_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const writeSel = (s: Selection) => { try { localStorage.setItem(SEL_KEY, JSON.stringify(s)); } catch { /* sin almacenamiento */ } };
/** Selección de un enlace directo (/empresa/:slug[/proyecto/:pid]/…): manda sobre la guardada desde el primer momento. */
const urlSel = (): Selection | null => { const m = window.location.pathname.match(/^\/empresa\/([^/]+)(?:\/proyecto\/([^/]+))?/); return m ? { ws: decodeURIComponent(m[1]), project: m[2] ? decodeURIComponent(m[2]) : null } : null; };
// Empresa y proyecto con los que se abrió cada entrada del historial de esta pestaña (por la clave de la entrada).
const HIST_KEY = 'portal-ia.seleccion.historial';
const readHist = (): Record<string, Selection> => { try { return JSON.parse(sessionStorage.getItem(HIST_KEY) ?? '{}'); } catch { return {}; } };
// La primera entrada de la pestaña no trae clave propia: se le da una antes de que la lea el router, para que también
// recuerde su empresa (abrir /panel directamente, cambiar de empresa y volver con Atrás).
try { const st = window.history.state as { key?: string } | null; if (!st?.key) window.history.replaceState({ ...(st ?? {}), key: Math.random().toString(36).slice(2, 10) }, ''); } catch { /* sin historial */ }
/** Al volver con Atrás/Adelante a una entrada de otra página (o recargarla), su selección; no la última elegida. */
const histSel = (): Selection | null => { const k = (window.history.state as { key?: string } | null)?.key; return k ? readHist()[k] ?? null : null; };

/**
 * Atrás/Adelante vuelven a la empresa y al proyecto con los que se abrió esa pantalla (antes mostraban la pantalla
 * anterior con la empresa de la última). Se anota al LLEGAR a cada entrada: cambiar de empresa navega a otra.
 */
function SelectionHistory({ sel, workspaces, select }: { sel: Selection | null; workspaces: Workspace[]; select: (ws: string, pid?: string | null, go?: SelectGo) => Promise<string | null> }) {
  const { key } = useLocation(); const type = useNavigationType();
  const current = useRef(sel); current.current = sel;
  useEffect(() => {
    if (key === 'default') return; // sin clave (no debería ocurrir: la primera entrada recibe una al cargar)
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
  const { pathname, search, hash, key: entry } = useLocation(); const type = useNavigationType();
  useEntryRecorder();
  useEffect(() => {
    // Por ENTRADA del historial (Atrás vuelve exactamente donde estabas en esa visita); al recargar, la de la pantalla.
    const key = `portal-ia.scroll.${pathname}${search}`; const keyEntry = `portal-ia.scroll.e.${entry}`;
    let saved = 0; try { saved = Number(sessionStorage.getItem(keyEntry) ?? sessionStorage.getItem(key) ?? 0); } catch { /* sin almacenamiento */ }
    // Se espera a que la pantalla tenga altura suficiente (datos que llegan después), hasta 8 s; si te desplazas tú, se para.
    let tries = 0; let timer: ReturnType<typeof setTimeout> | undefined; let userMoved = false;
    const stop = () => { userMoved = true; };
    const restore = () => { if (userMoved || Math.abs(window.scrollY - saved) <= 2 || ++tries > 80) return; if (document.documentElement.scrollHeight - window.innerHeight >= saved - 2) window.scrollTo(0, saved); timer = setTimeout(restore, 100); };
    window.addEventListener('wheel', stop, { passive: true }); window.addEventListener('touchmove', stop, { passive: true }); window.addEventListener('keydown', stop);
    if (type === 'POP' && saved > 0) timer = setTimeout(restore, 50); else if (type !== 'POP' && !hash) window.scrollTo(0, 0);
    // Se guarda la posición del momento del desplazamiento (al salir, la pantalla nueva ya ha cambiado la altura).
    let pending: number | null = null; let st: ReturnType<typeof setTimeout> | undefined;
    const write = () => { if (pending === null) return; try { sessionStorage.setItem(key, String(pending)); sessionStorage.setItem(keyEntry, String(pending)); } catch { /* sin almacenamiento */ } pending = null; };
    const save = () => { pending = Math.round(window.scrollY); clearTimeout(st); st = setTimeout(write, 150); };
    window.addEventListener('scroll', save, { passive: true });
    return () => { clearTimeout(timer); clearTimeout(st); write(); window.removeEventListener('scroll', save); window.removeEventListener('wheel', stop); window.removeEventListener('touchmove', stop); window.removeEventListener('keydown', stop); };
  }, [pathname, search, hash, type, entry]);
  return null;
}

/** Ruta profunda /empresa/:slug/proyecto/:pid/<destino>: fija la selección y redirige a la pantalla. */
function SelectRoute({ select }: { select: (ws: string, pid?: string | null, go?: SelectGo) => Promise<string | null> }) {
  const { slug, pid, '*': rest } = useParams();
  const { search, hash } = useLocation();
  // El enlace directo manda sobre la selección guardada; se conservan su pestaña (#…) y sus parámetros (?…).
  useEffect(() => { void select(slug!, pid ?? null, { to: () => '/' + ((rest ?? '').replace(/^[/\\]+/, '') || (pid ? 'panel' : 'oficina')) + search + hash, replace: true }); // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const select = useCallback(async (ws: string, projectId?: string | null, go?: SelectGo) => {
    const ps = await loadProjects(ws);
    const pid = projectId && ps.some(p => p.id === projectId) ? projectId : ps[0]?.id ?? null;
    const next = { ws, project: pid }; writeSel(next);
    // La selección y el destino van en la misma transición: las rutas (con clave empresa:proyecto) se montan una sola vez,
    // ya en su destino; nunca la pantalla anterior con identificadores de otra empresa.
    startTransition(() => { setProjects(ps); setSel(next); if (go) navigate(go.to(pid), { replace: go.replace }); });
    return pid;
  }, [loadProjects, navigate]);

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
  // La oficina es la portada: la empresa, sus departamentos y sus agentes de un vistazo (el Panel sigue en /panel).
  const home = ready ? officeHome() : connected ? '/configuracion/inicializar' : '/configuracion/proveedor';
  const guard = (el: ReactElement) => ready ? (status.project ? el : <CompanyHome />) : <Navigate to={home} replace />;
  // Oficina, Decisiones, Asistente y Ajustes son de la EMPRESA: funcionan aunque todavía no tenga proyectos.
  const company = (el: ReactElement) => ready ? el : <Navigate to={home} replace />;

  return (
    <AppContext.Provider value={{ status, providers, connected, refresh, flash, navigate, workspaces, projects, select, refreshStructure }}>
      <div className="app">
        {toast && <div className="toast" role="status">{toast.tone === 'ok' ? Icon.okc() : Icon.alert()} {toast.message}</div>}
        {ready && <AttentionWatcher />}
        {ready && <AssistantDock />}
        {ready && <PaletteHost />}
        <ScrollMemory />
        <SelectionHistory sel={sel} workspaces={workspaces} select={select} />
        <Suspense fallback={<div className="app" style={{ display: 'grid', placeItems: 'center' }}><Spinner /></div>}>
        <Routes key={`${status.workspace?.slug ?? ''}:${status.project?.id ?? ''}`}>
          <Route path="/" element={ready ? <Navigate to={officeHome()} replace /> : <Welcome />} />
          <Route path="/configuracion/proveedor" element={<ProviderSetup />} />
          <Route path="/configuracion/inicializar" element={connected ? <Initialization /> : <Navigate to="/configuracion/proveedor" replace />} />
          <Route path="/empresa/:slug/proyecto/:pid/*" element={<SelectRoute select={select} />} />
          <Route path="/empresa/:slug/*" element={<SelectRoute select={select} />} />
          <Route path="/asistente" element={company(<Assistant />)} />
          <Route path="/panel" element={guard(<Dashboard />)} />
          <Route path="/oficina" element={company(<Office />)} />
          <Route path="/oficina/organizacion" element={company(<Office view="organizacion" />)} />
          <Route path="/oficina/departamentos" element={company(<Office view="departamentos" />)} />
          <Route path="/oficina/lista" element={company(<Office view="lista" />)} />
          <Route path="/oficina/nuevo-agente" element={guard(<AgentWizard />)} />
          <Route path="/oficina/agente/:agentId/:tab?" element={company(<Office />)} />
          {/* «Equipo de IA» es ahora Oficina › Organización (se conservan ?… y #…); su ficha avanzada sigue en /equipo/:id. */}
          <Route path="/equipo" element={<Redirect to="/oficina/organizacion" />} />
          <Route path="/equipo/nuevo" element={guard(<AgentCreate />)} />
          <Route path="/equipo/:agentId" element={guard(<AgentDetail />)} />
          <Route path="/actividad" element={guard(<ProcessList />)} />
          <Route path="/procesos/:processId" element={guard(<ProcessView />)} />
          <Route path="/historias/:storyId" element={guard(<StoryWorkspace />)} />
          <Route path="/conocimiento" element={guard(<Knowledge />)} />
          <Route path="/presupuestos" element={company(<Budgets />)} />
          <Route path="/backlog" element={guard(<Backlog />)} />
          <Route path="/lotes" element={guard(<Batches />)} />
          <Route path="/lotes/:batchId" element={guard(<BatchDetail />)} />
          <Route path="/etapa" element={guard(<Phase />)} />
          <Route path="/archivo" element={guard(<Archive />)} />
          <Route path="/autorizaciones" element={company(<InboxScreen />)} />
          <Route path="/decisiones" element={<Redirect to="/autorizaciones" />} />
          <Route path="/ajustes" element={company(<Settings />)} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
        </Suspense>
      </div>
    </AppContext.Provider>
  );
}

/** Redirección que conserva los parámetros (?…) y el ancla (#…) del enlace antiguo. */
function Redirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={to + search + hash} replace />;
}

/** Búsqueda (Ctrl+K o el botón de la barra): un solo atajo para toda la aplicación; se carga al abrirla por primera vez. */
function PaletteHost() {
  const [open, setOpen] = useState(false);
  useUiEvent('palette', useCallback(() => setOpen(true), []));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openUi('palette'); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  return open ? <Suspense fallback={null}><CommandPalette onClose={() => setOpen(false)} /></Suspense> : null;
}

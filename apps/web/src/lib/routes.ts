import { INTERNAL_WORKSPACE } from '@portal-ia/domain';

/**
 * Portal IA 2.0 · registro único de secciones. De aquí salen el menú lateral, las migas, la búsqueda (Ctrl+K), la
 * pantalla «madre» del «Atrás» y adónde ir al cambiar de empresa o proyecto. Una sección nueva se añade aquí y aparece
 * en todos esos sitios a la vez.
 */
export type SectionId = 'oficina' | 'decisiones' | 'asistente' | 'resumen' | 'trabajo' | 'conocimiento' | 'ajustes';
export type IconName = 'building' | 'bell' | 'sparkles' | 'gauge' | 'kanban' | 'book' | 'sliders';
export interface Section {
  id: SectionId; label: string; path: string; icon: IconName;
  /** Grupo del menú: principal, del proyecto seleccionado o de la empresa. */
  group: 'main' | 'project' | 'company';
  /** Necesita un proyecto seleccionado (sin proyecto, la sección no se ofrece y se va a la Oficina). */
  needsProject: boolean;
  /** Rutas (pathname) que pertenecen a la sección: el menú la marca como activa. */
  match: RegExp;
  hint: string;
  /** HU-196 · false: la sección no aparece en el menú lateral, pero sigue en las migas, el «Atrás», sectionRoot y Ctrl+K. */
  inMenu?: boolean;
}
export const SECTIONS: Section[] = [
  { id: 'oficina', label: 'Oficina', path: '/oficina', icon: 'building', group: 'main', needsProject: false, match: /^\/(oficina|equipo)(\/|$)/, hint: 'Tu empresa: departamentos, agentes y organización' },
  { id: 'decisiones', label: 'Decisiones', path: '/autorizaciones', icon: 'bell', group: 'main', needsProject: false, match: /^\/(autorizaciones|decisiones)(\/|$)/, hint: 'Pendientes e historial de tus decisiones (campana)', inMenu: false },
  { id: 'asistente', label: 'Asistente', path: '/asistente', icon: 'sparkles', group: 'main', needsProject: false, match: /^\/asistente(\/|$)/, hint: 'Pide en lenguaje natural; el Portal decide a quién le toca' },
  { id: 'resumen', label: 'Resumen', path: '/panel', icon: 'gauge', group: 'project', needsProject: true, match: /^\/(panel|etapa|mantenimiento)(\/|$)/, hint: 'Estado del proyecto, atención, equipo y repositorio' },
  { id: 'trabajo', label: 'Trabajo', path: '/backlog', icon: 'kanban', group: 'project', needsProject: true, match: /^\/(backlog|historias|lotes|actividad|procesos|archivo)(\/|$)/, hint: 'Backlog, lotes, actividad y archivo' },
  { id: 'conocimiento', label: 'Conocimiento', path: '/conocimiento', icon: 'book', group: 'project', needsProject: true, match: /^\/conocimiento(\/|$)/, hint: 'Documentos y lecciones del proyecto' },
  { id: 'ajustes', label: 'Ajustes', path: '/ajustes', icon: 'sliders', group: 'company', needsProject: false, match: /^\/(ajustes|presupuestos|configuracion)(\/|$)/, hint: 'Motores de IA, presupuestos, empresas y sistema' }
];
/** Empresa interna: allí viven el Asistente de Empresa y el propio Portal. */
export const INTERNAL_SLUG = INTERNAL_WORKSPACE.slug;
export const sectionOf = (pathname: string): Section | null => SECTIONS.find(s => s.match.test(pathname)) ?? null;

/** Pestañas del Trabajo (cada una con su ruta; las de detalle marcan la suya). */
export const WORK_TABS = [
  { to: '/backlog', label: 'Backlog', match: /^\/(backlog|historias)(\/|$)/ },
  { to: '/lotes', label: 'Lotes', match: /^\/lotes(\/|$)/ },
  { to: '/actividad', label: 'Actividad', match: /^\/(actividad|procesos)(\/|$)/ },
  { to: '/archivo', label: 'Archivo', match: /^\/archivo(\/|$)/ }
] as const;

/** Vistas de la Oficina (rutas propias: enlace directo, historial y la vista guardada se respetan). */
export const OFFICE_VIEWS = [
  { to: '/oficina', label: 'Planta', view: 'planta' },
  { to: '/oficina/departamentos', label: 'Departamentos', view: 'departamentos' },
  { to: '/oficina/organizacion', label: 'Organización', view: 'organizacion' },
  { to: '/oficina/lista', label: 'Lista', view: 'lista' }
] as const;

/**
 * Adónde ir al cambiar de empresa o proyecto: la raíz de la sección actual (nunca una página de detalle, cuyos
 * identificadores son de la empresa anterior); si la sección necesita proyecto y no lo hay, la Oficina.
 */
export function sectionRoot(pathname: string, hasProject: boolean): string {
  const s = sectionOf(pathname);
  if (!s || (s.needsProject && !hasProject)) return '/oficina';
  if (s.id === 'trabajo') return (WORK_TABS.find(t => t.match.test(pathname)) ?? WORK_TABS[0]).to;
  if (s.id === 'oficina') return (OFFICE_VIEWS.find(v => v.to !== '/oficina' && pathname.startsWith(v.to)) ?? { to: officeHome() }).to;
  if (s.id === 'ajustes') return pathname.startsWith('/presupuestos') ? '/presupuestos' : '/ajustes';
  return s.path;
}

/**
 * La Oficina recuerda la última vista (Planta, Departamentos, Organización o Lista) y abre en ella; sin vista guardada,
 * en móvil empieza en la Lista (más legible que la planta en una columna).
 */
const OFFICE_KEY = 'portal-ia.oficina.vista';
export function officeHome(): string {
  try {
    const raw = JSON.parse(localStorage.getItem(OFFICE_KEY) ?? 'null');
    const hit = OFFICE_VIEWS.find(v => v.view === (raw === 'oficina' ? 'planta' : raw));
    if (hit) return hit.to;
  } catch { /* sin almacenamiento */ }
  const width = (globalThis as { innerWidth?: number }).innerWidth; // sin ventana (pruebas en Node): la Planta
  return width !== undefined && width < 768 ? '/oficina/lista' : '/oficina';
}
export function rememberOfficeView(view: string) { try { localStorage.setItem(OFFICE_KEY, JSON.stringify(view)); } catch { /* sin almacenamiento */ } }

/**
 * Pestaña del panel del agente donde se resuelve cada tipo de petición (las de procesos, en Solicitudes o Decisiones).
 * HU-181: Mejoras se retira; las automejoras (y cualquier aviso o enlace antiguo 'improvement') se ven en Memoria.
 */
export const TAB_FOR_KIND: Record<string, string> = { memory: 'memoria', improvement: 'memoria', source: 'origen', folder: 'archivos', action: 'chat' };
export const tabFor = (item: { kind: string; processId?: string | null }) => (item.processId ? 'solicitudes' : TAB_FOR_KIND[item.kind] ?? 'solicitudes');

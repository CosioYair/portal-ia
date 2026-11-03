import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ILLUSTRATIONS, type IllustrationName } from './illustrations.tsx';
import { WORK_TABS } from '../lib/routes.ts';

/**
 * Portal IA 2.0 · primitivas de composición compartidas por todas las pantallas (sin estilos sueltos por pantalla).
 * - Tile: azulejo de icono con el tono de su sección.
 * - PageHeader: cabecera de pantalla (azulejo, antetítulo, título, descripción breve, acciones y contenido extra).
 * - SectionTabs: navegación entre pantallas hermanas (son enlaces: historial, enlaces directos y Ctrl+clic funcionan).
 * - Stat: cifra con etiqueta (consulta rápida en cabeceras y resúmenes).
 * - EmptyState: estado vacío con ilustración, explicación y la acción para empezar.
 */
export type Tone = 'brand' | 'office' | 'assistant' | 'decisions' | 'project' | 'work' | 'knowledge' | 'settings' | 'working' | 'attention' | 'ok' | 'err' | 'queued' | 'idle';

export function Tile({ icon, tone = 'brand', size = 'md', label }: { icon: ReactNode; tone?: Tone; size?: 'sm' | 'md' | 'lg'; label?: string }) {
  return <span className={`tile tile-${tone} tile-${size}`} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>{icon}</span>;
}

export function PageHeader({ icon, tone = 'brand', eyebrow, title, titleId, description, actions, children }: {
  icon?: ReactNode; tone?: Tone; eyebrow?: ReactNode; title: ReactNode; titleId?: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode;
}) {
  return <header className="page-head">
    <div className="page-head-main">
      {icon && <Tile icon={icon} tone={tone} size="lg" />}
      <div className="page-head-text">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 className="h1" id={titleId}>{title}</h1>
        {description && <p className="lede lede-2l">{description}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
    {children}
  </header>;
}

/** Pestañas de sección: cada una es un enlace a su ruta (o a la misma ruta con otra vista). `match` marca activas rutas hijas. */
export function SectionTabs({ label, tabs }: { label: string; tabs: { to: string; label: ReactNode; icon?: ReactNode; match?: RegExp; count?: number | null; end?: boolean }[] }) {
  const { pathname, search } = useLocation(); const here = pathname + search;
  return <nav className="section-tabs" aria-label={label}>
    {tabs.map(t => {
      const active = t.match ? t.match.test(here) : undefined;
      return <NavLink key={t.to} to={t.to} end={t.end ?? true}
        className={({ isActive }) => `section-tab${(active ?? isActive) ? ' is-active' : ''}`}
        aria-current={active === undefined ? undefined : active ? 'page' : undefined}>
        {t.icon}<span>{t.label}</span>{t.count ? <span className="tab-count">{t.count}</span> : null}
      </NavLink>;
    })}
  </nav>;
}

export function Stat({ value, label, tone, icon }: { value: ReactNode; label: ReactNode; tone?: Tone; icon?: ReactNode }) {
  return <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
    {icon && <Tile icon={icon} tone={tone ?? 'idle'} size="sm" />}
    <div><div className="stat-value">{value}</div><div className="stat-label">{label}</div></div>
  </div>;
}

export function EmptyState({ art = 'desk', title, children, action }: { art?: IllustrationName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Art = ILLUSTRATIONS[art];
  return <div className="empty-state" role="status">
    <Art size={150} className="empty-art" />
    <div className="h3">{title}</div>
    {children && <p className="small med" style={{ maxWidth: '52ch' }}>{children}</p>}
    {action}
  </div>;
}

/** Pestañas del Trabajo (Backlog · Lotes · Actividad · Archivo), las mismas en las cuatro pantallas. */
export function WorkTabs() {
  return <SectionTabs label="Secciones del trabajo" tabs={WORK_TABS.map(t => ({ to: t.to, label: t.label, match: t.match }))} />;
}

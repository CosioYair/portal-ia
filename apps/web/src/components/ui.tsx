import type { ReactNode } from 'react';

const svg = (d: ReactNode, size = 16, extra?: string) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={extra ? { color: extra } : undefined}>{d}</svg>
);
const S = { stroke: 'currentColor', strokeWidth: 1.5 } as const;
const R = { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
/** HU-168 · Trazo de los iconos nuevos: 1,5 px redondeado. S y R no cambian, así los iconos anteriores quedan igual. */
const L = { stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const Icon = {
  arrow: () => svg(<path d="M3 8h10M9 4l4 4-4 4" {...R} />),
  back: () => svg(<path d="M13 8H3M7 4L3 8l4 4" {...R} />, 14),
  lock: () => svg(<><rect x="3" y="7" width="10" height="7" rx="1.5" {...S} /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" {...S} /></>),
  check: (size = 14) => svg(<path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />, size),
  okc: () => svg(<><circle cx="8" cy="8" r="6.25" {...S} /><path d="M5 8.3l2 2 4-4.5" {...R} /></>),
  alert: () => svg(<><circle cx="8" cy="8" r="6.25" {...S} /><path d="M8 4.8v3.7M8 11.2h.01" {...R} /></>),
  info: () => svg(<><circle cx="8" cy="8" r="6.25" {...S} /><path d="M8 7.2v4M8 4.8h.01" {...R} /></>),
  warn: () => svg(<><path d="M8 2.5l6 10.5H2z" {...S} strokeLinejoin="round" /><path d="M8 6.5v3M8 11.2h.01" {...R} /></>),
  git: () => svg(<><circle cx="5" cy="3.5" r="1.75" {...S} /><circle cx="5" cy="12.5" r="1.75" {...S} /><circle cx="11.5" cy="6" r="1.75" {...S} /><path d="M5 5.25v5.5M11.5 7.75c0 2.25-3.5 2-6.5 3" {...S} /></>),
  user: (size = 14) => svg(<><circle cx="8" cy="5.5" r="2.5" {...S} /><path d="M2.75 13.5c.75-2.75 2.75-4 5.25-4s4.5 1.25 5.25 4" {...S} strokeLinecap="round" /></>, size),
  updown: () => svg(<path d="M5 6.5L8 3.5l3 3M5 9.5l3 3 3-3" {...R} />, 14, 'var(--color-text-muted)'),
  x: (size = 12) => svg(<path d="M4 4l8 8M12 4l-8 8" {...R} />, size),
  folder: () => svg(<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z" {...S} strokeLinejoin="round" />),
  folderUp: () => svg(<><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z" {...S} strokeLinejoin="round" /><path d="M8 11V7.5M6.25 9.25 8 7.5l1.75 1.75" {...R} /></>),
  chevR: () => svg(<path d="M6 3.5 10.5 8 6 12.5" {...R} />, 14),
  grid: () => svg(<><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" {...S} /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" {...S} /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" {...S} /><rect x="9" y="9" width="4.5" height="4.5" rx="1" {...S} /></>),
  users: () => svg(<><circle cx="6" cy="5.5" r="2.25" {...S} /><path d="M1.75 13c.5-2.5 2.25-3.5 4.25-3.5s3.75 1 4.25 3.5" {...S} strokeLinecap="round" /><circle cx="11.5" cy="6" r="1.75" {...S} /><path d="M11.5 9.5c1.5 0 2.5.75 2.75 2.5" {...S} strokeLinecap="round" /></>),
  activity: () => svg(<path d="M1.75 8h2.5l2-4.5 3.5 9 2-4.5h2.5" {...R} />),
  inbox: () => svg(<path d="M2.5 9.5h3l1 2h3l1-2h3M2.5 9.5l1.5-6h8l1.5 6v4h-11z" {...S} strokeLinejoin="round" />),
  book: () => svg(<path d="M3 3.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v10l-5-2-5 2z" {...S} strokeLinejoin="round" />),
  plug: () => svg(<path d="M5.5 2v3M10.5 2v3M3.5 5h9v2.5a4.5 4.5 0 0 1-9 0zM8 12v2.5" {...R} strokeWidth={1.5} />),
  wallet: () => svg(<><rect x="2" y="4" width="12" height="9" rx="1.5" {...S} /><path d="M2 7h12M10.5 10.25h1.5" {...S} strokeLinecap="round" /></>),
  org: () => svg(<><rect x="5.5" y="2" width="5" height="3.5" rx="1" {...S} /><rect x="1.5" y="10.5" width="4" height="3.5" rx="1" {...S} /><rect x="10.5" y="10.5" width="4" height="3.5" rx="1" {...S} /><path d="M8 5.5v2.5M3.5 10.5V8h9v2.5" {...S} /></>),
  gear: () => svg(<><circle cx="8" cy="8" r="2.25" {...S} /><path d="M8 1.75v1.75M8 12.5v1.75M1.75 8H3.5M12.5 8h1.75M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" {...S} strokeLinecap="round" /></>),
  // HU-168 · Iconos del Portal (SVG propios, 16×16, trazo 1,5 px, currentColor)
  story: () => svg(<><rect x="3" y="2" width="10" height="12" rx="1.5" {...L} /><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" {...L} /></>),
  process: () => svg(<><circle cx="3.5" cy="8" r="1.75" {...L} /><circle cx="12.5" cy="4" r="1.75" {...L} /><circle cx="12.5" cy="12" r="1.75" {...L} /><path d="M5.25 8h2.5M7.75 4v8M7.75 4h3M7.75 12h3" {...L} /></>),
  authorization: () => svg(<><path d="M8 1.75l5 2v4c0 3-2.25 5.25-5 6.5-2.75-1.25-5-3.5-5-6.5v-4z" {...L} /><path d="M5.75 8l1.6 1.6 2.9-3.1" {...L} /></>),
  agent: () => svg(<><rect x="3" y="5" width="10" height="8" rx="2" {...L} /><path d="M8 2.5V5M6 9h.01M10 9h.01M6.5 11.25h3" {...L} /></>),
  file: () => svg(<path d="M4 1.75h5l3 3v9.5H4zM9 1.75v3h3" {...L} />),
  clip: () => svg(<path d="M10.75 5.25 6.4 9.6a1.25 1.25 0 0 0 1.77 1.77l4.5-4.5a2.75 2.75 0 0 0-3.9-3.9L4.2 7.55a4.25 4.25 0 0 0 6 6l3.3-3.3" {...L} />),
  publish: () => svg(<path d="M8 10.5V2.75M5 5.75l3-3 3 3M2.75 10.5v2.75h10.5V10.5" {...L} />),
  panelWide: () => svg(<><rect x="1.75" y="3" width="12.5" height="10" rx="1.5" {...L} /><path d="M10.5 3v10M8 8H4M5.75 6.25 4 8l1.75 1.75" {...L} /></>),
  panelNarrow: () => svg(<><rect x="1.75" y="3" width="12.5" height="10" rx="1.5" {...L} /><path d="M10.5 3v10M4 8h4M6.25 6.25 8 8l-1.75 1.75" {...L} /></>),
  // HU-168 · Estados: la forma basta para distinguirlos sin color
  statePending: () => svg(<circle cx="8" cy="8" r="6.25" {...L} strokeDasharray="2.2 2.2" />),
  stateRunning: () => svg(<><circle cx="8" cy="8" r="6.25" {...L} /><path d="M8 4.75A3.25 3.25 0 0 1 11.25 8" {...L} /></>),
  stateDone: () => svg(<><circle cx="8" cy="8" r="6.25" {...L} /><path d="M5 8.3l2 2 4-4.5" {...L} /></>),
  stateError: () => svg(<><circle cx="8" cy="8" r="6.25" {...L} /><path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" {...L} /></>),
  stateBlocked: () => svg(<><circle cx="8" cy="8" r="6.25" {...L} /><path d="M3.6 12.4l8.8-8.8" {...L} /></>),
  // Portal IA 2.0 · iconos de navegación y acciones (mismo trazo L).
  building: (size = 16) => svg(<><path d="M2.75 14.25h10.5M4 14.25V3.25A1 1 0 0 1 5 2.25h6a1 1 0 0 1 1 1v11" {...L} /><path d="M6.5 5h.01M9.5 5h.01M6.5 7.75h.01M9.5 7.75h.01M7 14.25v-3h2v3" {...L} /></>, size),
  sparkles: (size = 16) => svg(<><path d="M7 2.25l1.2 3.05 3.05 1.2-3.05 1.2L7 10.75 5.8 7.7 2.75 6.5 5.8 5.3z" {...L} /><path d="M12 9.75l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" {...L} /></>, size),
  bell: (size = 16) => svg(<><path d="M4 11.25V7.5a4 4 0 0 1 8 0v3.75l1.25 1.5H2.75z" {...L} /><path d="M6.5 13.75a1.6 1.6 0 0 0 3 0" {...L} /></>, size),
  gauge: (size = 16) => svg(<><path d="M2.5 11.5a5.75 5.75 0 1 1 11 0" {...L} /><path d="M8 10.25l2.5-3.5M4.25 11.5h7.5" {...L} /></>, size),
  kanban: (size = 16) => svg(<><rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.75" {...L} /><path d="M6 2.75v10.5M10 2.75v10.5M3.75 5.25h1M7.5 5.25h1M7.5 7.5h1M11.25 5.25h1" {...L} /></>, size),
  search: (size = 16) => svg(<><circle cx="7.25" cy="7.25" r="4.5" {...L} /><path d="m10.6 10.6 3.15 3.15" {...L} /></>, size),
  plus: (size = 16) => svg(<path d="M8 3.25v9.5M3.25 8h9.5" {...L} />, size),
  download: (size = 16) => svg(<path d="M8 2.75v7.5M5 7.5 8 10.5l3-3M2.75 12.25v1h10.5v-1" {...L} />, size),
  chat: (size = 16) => svg(<path d="M3.25 3.25h9.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-3 2.5v-2.5H3.25a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" {...L} />, size),
  chevD: (size = 14) => svg(<path d="M3.5 6 8 10.5 12.5 6" {...L} />, size),
  menu: (size = 16) => svg(<path d="M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5" {...L} />, size),
  layers: (size = 16) => svg(<><path d="M8 2.25 13.75 5.5 8 8.75 2.25 5.5z" {...L} /><path d="m2.25 8.5 5.75 3.25 5.75-3.25M2.25 11 8 14.25 13.75 11" {...L} /></>, size),
  history: (size = 16) => svg(<><path d="M2.6 6.25A5.75 5.75 0 1 1 2.25 8M2.25 3.25v3h3" {...L} /><path d="M8 5v3.25l2 1.25" {...L} /></>, size),
  sliders: (size = 16) => svg(<><path d="M2.75 4.5h6M11.75 4.5h1.5M2.75 11.5h1.5M7.25 11.5h6" {...L} /><circle cx="10.25" cy="4.5" r="1.5" {...L} /><circle cx="5.75" cy="11.5" r="1.5" {...L} /></>, size),
  shield: (size = 16) => svg(<><path d="M8 1.75l5 2v4c0 3-2.25 5.25-5 6.5-2.75-1.25-5-3.5-5-6.5v-4z" {...L} /><path d="M5.75 8l1.6 1.6 2.9-3.1" {...L} /></>, size),
  bolt: (size = 16) => svg(<path d="M9 1.75 3.75 9h4l-1 5.25L12.25 7h-4z" {...L} />, size),
  external: (size = 14) => svg(<path d="M9.25 2.75h4v4M13.25 2.75 7.5 8.5M11.5 9.5v3.25a.75.75 0 0 1-.75.75h-7a.75.75 0 0 1-.75-.75v-7A.75.75 0 0 1 3.25 5H6.5" {...L} />, size)
};

/** HU-168 · Estados comunes del Portal. Siempre se comunican con icono y texto, nunca solo con color. */
export type PortalState = 'pending' | 'running' | 'done' | 'error' | 'blocked';
export const STATE_LABEL: Record<PortalState, string> = {
  pending: 'Pendiente',
  running: 'En curso',
  done: 'Completado',
  error: 'Error',
  blocked: 'Bloqueado'
};
const STATE_ICON: Record<PortalState, () => ReactNode> = {
  pending: Icon.statePending,
  running: Icon.stateRunning,
  done: Icon.stateDone,
  error: Icon.stateError,
  blocked: Icon.stateBlocked
};

/** Icono del estado con su texto. Si se oculta el texto visible, queda en un .sr-only para lectores de pantalla. */
export function StatusIcon({ state, label, showLabel = true }: { state: PortalState; label?: string; showLabel?: boolean }) {
  const text = label ?? STATE_LABEL[state];
  return <span className={`status-ic status-ic-${state}`} data-state={state}>
    {STATE_ICON[state]()}
    {showLabel ? <span className="status-ic-text">{text}</span> : <span className="sr-only">{text}</span>}
  </span>;
}

export function Wordmark({ provisional }: { provisional?: boolean }) {
  return <div className="wordmark"><span className="mark" aria-hidden="true" /><span>Portal IA</span>{provisional && <span className="chip chip-soon chip-xs">nombre provisional</span>}</div>;
}

export function Chip({ tone = '', xs, dot, children, className = '' }: { tone?: '' | 'accent' | 'ok' | 'warn' | 'err' | 'soon' | 'working'; xs?: boolean; dot?: '' | 'ok' | 'warn' | 'err' | 'pulse'; children: ReactNode; className?: string }) {
  return <span className={`chip ${tone ? 'chip-' + tone : ''} ${xs ? 'chip-xs' : ''} ${className}`}>{dot !== undefined && <span className={`dot ${dot === 'pulse' ? 'dot-working dot-pulse' : dot ? 'dot-' + dot : ''}`} aria-hidden="true" />}{children}</span>;
}

export function Notice({ kind, children }: { kind: 'info' | 'ok' | 'warn' | 'err'; children: ReactNode }) {
  const icon = kind === 'info' ? Icon.info() : kind === 'ok' ? Icon.okc() : kind === 'warn' ? Icon.warn() : Icon.alert();
  return <div className={`notice notice-${kind}`} role={kind === 'err' ? 'alert' : undefined}>{icon}<div>{children}</div></div>;
}

/**
 * Estado del borrador de un formulario, discreto: nunca dice «guardado» si no se pudo guardar. Un borrador recuperado
 * se puede descartar; uno de una versión anterior del dato se ofrece sin aplicarlo.
 */
export function DraftNote({ status, onDiscard, stale }: { status: 'idle' | 'restored' | 'unsaved' | 'saved' | 'error'; onDiscard?: () => void; stale?: { at: number; recover: () => void; discard: () => void } | null }) {
  if (stale) return <div className="small muted" data-testid="draft-stale" role="status">Hay un borrador tuyo de una versión anterior ({new Date(stale.at).toLocaleString()}). <button type="button" className="lnk small" onClick={stale.recover}>Recuperarlo</button> · <button type="button" className="lnk small" onClick={stale.discard}>Descartarlo</button></div>;
  const text = status === 'restored' ? 'Borrador recuperado' : status === 'saved' ? 'Borrador guardado' : status === 'unsaved' ? 'Cambios sin guardar' : status === 'error' ? 'No se pudo guardar; tus cambios siguen en esta pantalla' : null;
  if (!text) return null;
  return <div className="small muted" data-testid="draft-status" role="status" style={{ color: status === 'error' ? 'var(--color-err-text)' : undefined }}>{text}{status === 'restored' && onDiscard ? <> · <button type="button" className="lnk small" onClick={onDiscard}>Descartar borrador</button></> : null}</div>;
}

export function Stepper({ s1, s2, s3 }: { s1: string; s2: string; s3: string }) {
  return <nav className="stepper" aria-label="Progreso de la configuración">
    <div className={`step ${s1}`}><span className="step-n mono">1</span><span>Proveedor de IA</span></div>
    <div className={`step ${s2}`}><span className="step-n mono">2</span><span>Empresa interna</span></div>
    <div className={`step ${s3}`}><span className="step-n mono">3</span><span>Equipo inicial</span></div>
  </nav>;
}

export function Empty({ icon, title, hint, style }: { icon: ReactNode; title: string; hint: string; style?: React.CSSProperties }) {
  return <div className="empty" style={style}><span className="empty-ic">{icon}</span><div style={{ fontWeight: 500, color: 'var(--color-text)' }}>{title}</div><div className="sm13" style={{ maxWidth: '46ch' }}>{hint}</div></div>;
}

export function KV({ k, children }: { k: string; children: ReactNode }) {
  return <div className="kv"><span>{k}</span><span>{children}</span></div>;
}

export function Avatar({ initials, ws, lg }: { initials: string; ws: boolean; lg?: boolean }) {
  return <span className={`av mono ${ws ? 'av-ws' : ''} ${lg ? 'av-lg' : ''}`}>{initials}</span>;
}

/**
 * HU-162 · Indicador de carga accesible.
 * Se anuncia con role="status" y muestra el texto visible «Cargando…», así que la carga
 * se entiende también cuando el movimiento reducido detiene el giro.
 */
export function Spinner({ label = 'Cargando…', light }: { label?: string; light?: boolean }) {
  return <span className="spin-status" role="status" aria-live="polite">
    <span className={`spin ${light ? 'spin-light' : ''}`} aria-hidden="true" />
    <span>{label}</span>
  </span>;
}

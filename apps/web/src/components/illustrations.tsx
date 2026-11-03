/**
 * Portal IA 2.0 · ilustraciones originales (SVG en línea, hechas para el Portal). Solo usan tokens de color, así que
 * siguen la paleta y se ven bien con cualquier ajuste de tema. Son decorativas: aria-hidden y sin texto propio.
 */
import type { ReactElement } from 'react';

type P = { size?: number; className?: string };
const svg = (w: number, h: number, size: number | undefined, className: string | undefined, body: ReactElement) =>
  <svg className={className} width={size ?? w} height={size ? (size * h) / w : h} viewBox={`0 0 ${w} ${h}`} fill="none" aria-hidden="true" focusable="false">{body}</svg>;

/** Isotipo de Portal IA: un marco («portal») con tres agentes conectados. */
export function PortalMark({ size = 28 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="portal-mark">
    <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="var(--color-brand)" />
    <rect x="6.5" y="6.5" width="19" height="19" rx="6" fill="none" stroke="var(--color-brand-ring)" strokeWidth="1.6" />
    <path d="M12 19.5 16 12.5l4 7" stroke="var(--color-on-dark)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity=".85" />
    <circle cx="12" cy="19.5" r="2.4" fill="var(--color-working)" stroke="var(--color-brand)" strokeWidth="1.2" />
    <circle cx="16" cy="12.5" r="2.4" fill="var(--color-on-dark)" stroke="var(--color-brand)" strokeWidth="1.2" />
    <circle cx="20" cy="19.5" r="2.4" fill="var(--color-brand-ring)" stroke="var(--color-brand)" strokeWidth="1.2" />
  </svg>;
}

/** La oficina vista desde fuera: un edificio con salas iluminadas (bienvenida, oficina vacía). */
export function OfficeBuilding({ size, className }: P) {
  const windows = [[0, 0, 'working'], [1, 0, 'idle'], [2, 0, 'attention'], [0, 1, 'idle'], [1, 1, 'working'], [2, 1, 'idle'], [0, 2, 'brand'], [1, 2, 'idle'], [2, 2, 'working']] as const;
  return svg(220, 170, size, className, <>
    <ellipse cx="110" cy="158" rx="92" ry="8" fill="var(--color-illus-shadow)" />
    <rect x="44" y="26" width="132" height="130" rx="12" fill="var(--color-illus-wall)" />
    <rect x="44" y="26" width="132" height="22" rx="12" fill="var(--color-brand)" />
    <rect x="44" y="38" width="132" height="10" fill="var(--color-brand)" />
    <circle cx="60" cy="37" r="3" fill="var(--color-working)" /><circle cx="70" cy="37" r="3" fill="var(--color-brand-ring)" /><circle cx="80" cy="37" r="3" fill="var(--color-on-dark)" opacity=".7" />
    {windows.map(([c, r, s]) => <g key={`${c}${r}`}>
      <rect x={58 + c * 38} y={60 + r * 30} width="28" height="20" rx="4" fill={s === 'idle' ? 'var(--color-illus-window)' : `var(--color-${s}-soft)`} stroke={s === 'idle' ? 'var(--color-border)' : `var(--color-${s})`} strokeWidth="1.4" />
      {s !== 'idle' && <circle cx={72 + c * 38} cy={70 + r * 30} r="3.2" fill={`var(--color-${s})`} />}
    </g>)}
    <rect x="98" y="132" width="24" height="24" rx="4" fill="var(--color-brand)" />
    <circle cx="116" cy="145" r="1.6" fill="var(--color-on-dark)" />
    <path d="M24 156h172" stroke="var(--color-border-strong)" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M30 156v-16a8 8 0 0 1 16 0v16M188 156v-22a7 7 0 0 1 14 0v22" fill="var(--color-illus-plant)" />
  </>);
}

/** Escritorio libre (sin agentes o sin trabajo). */
export function EmptyDesk({ size, className }: P) {
  return svg(160, 110, size, className, <>
    <ellipse cx="80" cy="100" rx="62" ry="6" fill="var(--color-illus-shadow)" />
    <rect x="30" y="58" width="100" height="8" rx="3" fill="var(--color-illus-desk)" />
    <path d="M38 66v32M122 66v32" stroke="var(--color-illus-desk-dark)" strokeWidth="4" strokeLinecap="round" />
    <rect x="58" y="24" width="44" height="30" rx="4" fill="var(--color-illus-screen)" stroke="var(--color-brand)" strokeWidth="2" />
    <path d="M72 39h16" stroke="var(--color-brand-ring)" strokeWidth="2" strokeLinecap="round" />
    <path d="M80 54v4" stroke="var(--color-brand)" strokeWidth="3" />
    <rect x="104" y="44" width="14" height="14" rx="3" fill="var(--color-working-soft)" stroke="var(--color-working)" strokeWidth="1.4" />
    <path d="M18 98c4-18 10-26 14-26s8 8 6 26" fill="var(--color-illus-plant)" />
  </>);
}

/** Bandeja vacía con una marca de hecho (sin decisiones pendientes). */
export function InboxClear({ size, className }: P) {
  return svg(160, 110, size, className, <>
    <ellipse cx="80" cy="100" rx="56" ry="6" fill="var(--color-illus-shadow)" />
    <path d="M30 62 46 30h68l16 32v26a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6z" fill="var(--color-illus-wall)" stroke="var(--color-border-strong)" strokeWidth="1.6" />
    <path d="M30 62h28l6 10h32l6-10h28" stroke="var(--color-border-strong)" strokeWidth="1.6" fill="none" />
    <circle cx="80" cy="40" r="17" fill="var(--color-ok-soft)" stroke="var(--color-ok)" strokeWidth="2" />
    <path d="m72 40 6 6 10-12" stroke="var(--color-ok)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </>);
}

/** Estantería (conocimiento). */
export function Bookshelf({ size, className }: P) {
  const books = [['brand', 10, 34], ['working', 8, 28], ['attention', 12, 38], ['queued', 9, 30], ['brand-ring', 11, 34], ['ok', 8, 26]] as const;
  let x = 40;
  return svg(160, 110, size, className, <>
    <ellipse cx="80" cy="100" rx="60" ry="6" fill="var(--color-illus-shadow)" />
    <rect x="28" y="22" width="104" height="72" rx="6" fill="var(--color-illus-wall)" stroke="var(--color-border-strong)" strokeWidth="1.6" />
    <path d="M28 58h104" stroke="var(--color-border-strong)" strokeWidth="1.6" />
    {books.map(([c, w, h], i) => { const el = <rect key={i} x={x} y={56 - h} width={w} height={h} rx="2" fill={`var(--color-${c})`} opacity=".9" />; x += w + 3; return el; })}
    <rect x="44" y="70" width="34" height="20" rx="3" fill="var(--color-surface)" stroke="var(--color-border)" />
    <path d="M50 78h22M50 84h14" stroke="var(--color-border-strong)" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="104" cy="80" r="9" fill="var(--color-brand-soft)" stroke="var(--color-brand)" strokeWidth="1.6" />
  </>);
}

/** Tablero de trabajo con tarjetas (backlog, procesos). */
export function WorkBoard({ size, className }: P) {
  return svg(160, 110, size, className, <>
    <ellipse cx="80" cy="100" rx="60" ry="6" fill="var(--color-illus-shadow)" />
    {[0, 1, 2].map(c => <g key={c}>
      <rect x={26 + c * 38} y="20" width="32" height="74" rx="6" fill="var(--color-illus-wall)" stroke="var(--color-border)" />
      {[0, 1, 2].slice(0, 3 - c).map(r => <rect key={r} x={30 + c * 38} y={28 + r * 20} width="24" height="14" rx="3" fill="var(--color-surface)" stroke={c === 1 && r === 0 ? 'var(--color-working)' : 'var(--color-border-strong)'} strokeWidth="1.3" />)}
    </g>)}
    <circle cx="125" cy="80" r="9" fill="var(--color-ok-soft)" stroke="var(--color-ok)" strokeWidth="1.6" />
    <path d="m121 80 3 3 5-6" stroke="var(--color-ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </>);
}

/** Engranajes (ajustes). */
export function Gears({ size, className }: P) {
  const gear = (cx: number, cy: number, r: number, c: string) => <g>
    {Array.from({ length: 8 }, (_, i) => { const a = (i * Math.PI) / 4; return <rect key={i} x={cx - 3} y={cy - r - 5} width="6" height="8" rx="1.5" fill={c} transform={`rotate(${(a * 180) / Math.PI} ${cx} ${cy})`} />; })}
    <circle cx={cx} cy={cy} r={r} fill={c} /><circle cx={cx} cy={cy} r={r * 0.42} fill="var(--color-surface)" />
  </g>;
  return svg(160, 110, size, className, <>
    <ellipse cx="80" cy="100" rx="56" ry="6" fill="var(--color-illus-shadow)" />
    {gear(66, 56, 22, 'var(--color-brand)')}{gear(108, 42, 13, 'var(--color-working)')}{gear(112, 78, 10, 'var(--color-brand-ring)')}
  </>);
}

/** Gráfica que sube (presupuestos, resumen). */
export function ChartRise({ size, className }: P) {
  return svg(160, 110, size, className, <>
    <ellipse cx="80" cy="100" rx="58" ry="6" fill="var(--color-illus-shadow)" />
    <rect x="26" y="18" width="108" height="76" rx="8" fill="var(--color-illus-wall)" stroke="var(--color-border-strong)" strokeWidth="1.6" />
    {[[40, 30], [58, 42], [76, 36], [94, 52]].map(([x, h], i) => <rect key={i} x={x} y={84 - h} width="12" height={h} rx="3" fill={i === 3 ? 'var(--color-brand)' : 'var(--color-brand-soft)'} stroke="var(--color-brand)" strokeWidth="1.2" />)}
    <path d="M40 46 62 38l18 6 30-18" stroke="var(--color-working)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <circle cx="110" cy="26" r="4" fill="var(--color-working)" />
  </>);
}

export const ILLUSTRATIONS = { office: OfficeBuilding, desk: EmptyDesk, inbox: InboxClear, books: Bookshelf, board: WorkBoard, gears: Gears, chart: ChartRise } as const;
export type IllustrationName = keyof typeof ILLUSTRATIONS;

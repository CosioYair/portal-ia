import { memo } from 'react';
import type { OfficeState } from '../lib/osApi.ts';

/**
 * Personaje original de Portal IA para un agente (estilo «pixel» suave, SVG propio, sin recursos de terceros). Es
 * DETERMINISTA: el mismo agente siempre tiene el mismo aspecto (tono de piel, pelo, accesorio) a partir de su id, y la
 * camiseta lleva el color de su departamento. El estado se dibuja con la pantalla del puesto y una insignia, pero nunca
 * solo con color: quien lo use siempre añade el texto del estado (ver Office.tsx).
 */
const SKIN = ['#F2C9A0', '#E0AC7E', '#C68A5C', '#9C6A44', '#6E4A30'];
const HAIR = ['#2B2420', '#5A3A22', '#8C5A2B', '#C9A26B', '#3B3F4A', '#A6492F'];
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

export const AgentFigure = memo(function AgentFigure({ id, hue, state, size = 64, initials }: { id: string; hue: number; state: OfficeState; size?: number; initials?: string }) {
  const h = hash(id);
  const skin = SKIN[h % SKIN.length]; const hair = HAIR[(h >>> 3) % HAIR.length];
  const style = (h >>> 6) % 4; const accessory = (h >>> 9) % 3;
  const shirt = `hsl(${hue} 42% 46%)`; const shirtDark = `hsl(${hue} 42% 36%)`;
  const dim = state === 'retired';
  return (
    <svg className={`fig fig-${state}`} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" shapeRendering="crispEdges" style={dim ? { filter: 'grayscale(1)', opacity: .55 } : undefined}>
      {/* Silla */}
      <rect x="9" y="17" width="14" height="10" rx="1" style={{ fill: 'var(--color-office-chair)' }} />
      {/* Cuerpo y brazos */}
      <g className="fig-body">
        <rect x="10" y="16" width="12" height="9" style={{ fill: shirt }} />
        <rect x="10" y="16" width="12" height="2" style={{ fill: shirtDark }} />
        <rect className="fig-arm-l" x="8" y="18" width="3" height="6" style={{ fill: shirt }} />
        <rect className="fig-arm-r" x="21" y="18" width="3" height="6" style={{ fill: shirt }} />
        {/* Cabeza */}
        <rect x="11" y="6" width="10" height="10" style={{ fill: skin }} />
        {style === 0 && <rect x="11" y="5" width="10" height="3" style={{ fill: hair }} />}
        {style === 1 && <><rect x="10" y="5" width="12" height="3" style={{ fill: hair }} /><rect x="10" y="8" width="2" height="7" style={{ fill: hair }} /><rect x="20" y="8" width="2" height="7" style={{ fill: hair }} /></>}
        {style === 2 && <><rect x="11" y="5" width="10" height="2" style={{ fill: hair }} /><rect x="14" y="2" width="4" height="3" style={{ fill: hair }} /></>}
        {style === 3 && <><rect x="10" y="4" width="12" height="3" style={{ fill: shirtDark }} /><rect x="9" y="6" width="5" height="1" style={{ fill: shirtDark }} /></>}
        {/* Ojos */}
        <rect x="13" y="10" width="2" height="2" style={{ fill: 'var(--color-office-ink)' }} />
        <rect x="17" y="10" width="2" height="2" style={{ fill: 'var(--color-office-ink)' }} />
        {accessory === 1 && <><rect x="12" y="9" width="4" height="4" fill="none" style={{ stroke: 'var(--color-office-ink)' }} strokeWidth=".6" /><rect x="16" y="9" width="4" height="4" fill="none" style={{ stroke: 'var(--color-office-ink)' }} strokeWidth=".6" /></>}
        {accessory === 2 && <><rect x="10" y="9" width="1" height="4" style={{ fill: 'var(--color-office-ink)' }} /><rect x="21" y="9" width="1" height="4" style={{ fill: 'var(--color-office-ink)' }} /><rect x="10" y="7" width="12" height="1" style={{ fill: 'var(--color-office-ink)' }} /></>}
        <rect x="14" y="13" width="4" height="1" style={{ fill: state === 'attention' ? 'var(--color-office-ink)' : shirtDark }} />
      </g>
      {/* Escritorio con pantalla: encendida si trabaja */}
      <rect x="4" y="24" width="24" height="3" style={{ fill: 'var(--color-office-desk-top)' }} />
      <rect x="5" y="27" width="2" height="5" style={{ fill: 'var(--color-office-desk)' }} />
      <rect x="25" y="27" width="2" height="5" style={{ fill: 'var(--color-office-desk)' }} />
      <rect x="2" y="16" width="7" height="8" rx=".5" style={{ fill: 'var(--color-office-screen-frame)' }} />
      <rect className="fig-screen" x="3" y="17" width="5" height="5" style={{ fill: state === 'working' ? 'var(--color-office-screen-on)' : state === 'queued' ? 'var(--color-office-screen-wait)' : 'var(--color-office-screen)' }} />
      {initials && <text x="26" y="22" fontSize="5" fontFamily="var(--font-mono)" textAnchor="middle" style={{ fill: 'var(--color-office-ink)' }}>{initials.slice(0, 2)}</text>}
    </svg>
  );
});

/** Insignia de estado con forma propia (no depende del color): ! atención, reloj en cola, ondas trabajando, raya retirado. */
export function StateBadge({ state }: { state: OfficeState }) {
  if (state === 'idle') return null;
  const shape = state === 'unavailable' ? <><circle cx="8" cy="8" r="4.6" fill="none" strokeWidth="1.6" /><path d="M5 11l6-6" strokeWidth="1.6" strokeLinecap="round" /></>
    : state === 'attention' ? <path d="M8 3.5v5.2M8 11.4h.01" strokeWidth="2.2" strokeLinecap="round" />
    : state === 'queued' ? <><circle cx="8" cy="8" r="4.2" fill="none" strokeWidth="1.6" /><path d="M8 5.8V8l1.6 1.2" strokeWidth="1.6" strokeLinecap="round" /></>
      : state === 'working' ? <path d="M3.5 9.5c1.2-2 2.4-2 3.6 0s2.4 2 3.6 0" fill="none" strokeWidth="1.7" strokeLinecap="round" />
        : <path d="M4 8h8" strokeWidth="2" strokeLinecap="round" />;
  return <span className={`state-badge state-badge-${state}`} aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor">{shape}</svg></span>;
}

export const STATE_TEXT: Record<OfficeState, string> = { working: 'Trabajando', queued: 'En cola', attention: 'Te necesita', unavailable: 'No puede trabajar', idle: 'Disponible', retired: 'Retirado' };

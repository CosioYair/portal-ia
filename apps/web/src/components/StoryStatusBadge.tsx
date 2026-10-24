import type { CSSProperties } from 'react';
import type { StoryProgressIndicator } from '@portal/contracts';

interface BadgeConfig {
  readonly icon: string;
  readonly label: string;
  readonly style: CSSProperties;
}

const BASE_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.35rem',
  padding: '0.1rem 0.6rem',
  borderRadius: '999px',
  border: '1px solid currentColor',
  fontSize: '0.85rem',
  fontWeight: 600
};

const CONFIG: Record<StoryProgressIndicator, BadgeConfig> = {
  pendiente: { icon: '○', label: 'Pendiente', style: { ...BASE_STYLE, color: '#4b5563', background: '#f3f4f6' } },
  en_curso: { icon: '◐', label: 'En curso', style: { ...BASE_STYLE, color: '#1e40af', background: '#dbeafe' } },
  por_cerrar: { icon: '⚑', label: 'Por cerrar', style: { ...BASE_STYLE, color: '#92400e', background: '#fef3c7' } }
};

const COMPLETADA: BadgeConfig = {
  icon: '✓',
  label: 'Completada',
  style: { ...BASE_STYLE, color: '#166534', background: '#dcfce7' }
};

export interface StoryStatusBadgeProps {
  /** Indicador de progreso; null significa que la historia ya está completada. */
  readonly indicator: StoryProgressIndicator | null;
}

/** Indicador de progreso de una historia: icono + texto + color (nunca solo color). */
export function StoryStatusBadge({ indicator }: StoryStatusBadgeProps) {
  const config = indicator === null ? COMPLETADA : CONFIG[indicator];
  return (
    <span style={config.style} data-indicator={indicator ?? 'completada'}>
      <span aria-hidden="true">{config.icon}</span>
      <span>{config.label}</span>
    </span>
  );
}

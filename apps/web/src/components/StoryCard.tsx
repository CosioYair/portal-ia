import type { ReactNode } from 'react';
import type { BacklogItem } from '@portal-ia/domain';
import { Icon } from './ui.tsx';

/**
 * HU-165 · Tarjeta de historia del backlog.
 * Muestra el id, el título, el criterio (2 líneas como máximo), el responsable, el tamaño y la dependencia.
 * El estado lleva siempre icono (decorativo, aria-hidden) y texto.
 * Como máximo hay 2 elementos accionables visibles: la acción principal y el resumen «Más acciones».
 * Las acciones secundarias solo aparecen al desplegar ese <details> nativo, que se maneja con teclado.
 * La tarjeta no lanza nada con costo: «Ejecutar» solo abre el diálogo de autorización de la pantalla.
 */
export type StoryCardTone = '' | 'ok' | 'warn' | 'err' | 'accent';
export interface StoryCardAction { label: string; title?: string; onClick: () => void; disabled?: boolean; variant?: 'primary' | 'secondary' }
export interface StoryCardStatus { label: string; tone: StoryCardTone; icon: () => ReactNode }

export const STATUS_ICON: Record<BacklogItem['status'], () => ReactNode> = {
  done: Icon.okc,
  in_progress: Icon.warn,
  blocked: Icon.alert,
  review: Icon.info,
  pending: Icon.chevR,
  discarded: () => Icon.x(14)
};

export function StoryCard({ item, ownerName, status, primary, secondary, highlight, note }: {
  item: BacklogItem;
  ownerName: string | null;
  status: StoryCardStatus;
  primary?: StoryCardAction;
  secondary: StoryCardAction[];
  highlight?: 'next' | 'selected';
  note?: string | null;
}) {
  const cls = `story-card${highlight ? ` story-card--${highlight}` : ''}`;
  return (
    <article className={cls} aria-label={`${item.storyId} · ${item.title}`}>
      <div className="story-card-main">
        <div className="story-card-head">
          <span className="mono story-card-id">{item.storyId}</span>
          <span className="story-card-title">{item.title}</span>
          {highlight === 'next' && <span className="chip chip-warn chip-xs">Siguiente</span>}
        </div>
        {item.criterion && <p className="story-card-crit small muted">{item.criterion}</p>}
        <div className="story-card-meta small muted">
          <span>{ownerName ?? '—'}</span>
          {item.estimate && <span>· Tam. {item.estimate}</span>}
          {item.dependsOn && <span className="mono">· depende de {item.dependsOn}</span>}
        </div>
      </div>
      <div className="story-card-side">
        <span className={`story-card-status story-card-status-${status.tone || 'neutral'}`}>
          <span className="story-card-status-ic" aria-hidden="true">{status.icon()}</span>
          <span>{status.label}</span>
        </span>
        {note && <span className="small muted story-card-note">{note}</span>}
        {(primary || secondary.length > 0) && <div className="story-card-actions">
          {primary && <button type="button" className={`btn btn-sm ${primary.variant === 'secondary' ? 'btn-secondary' : 'btn-primary'}`} title={primary.title} onClick={primary.onClick} disabled={primary.disabled}>{primary.label}</button>}
          {secondary.length > 0 && <details className="story-card-more">
            <summary className="btn btn-ghost btn-sm">Más acciones</summary>
            <div className="story-card-menu">
              {secondary.map(a => <button key={a.label} type="button" className="btn btn-ghost btn-sm" title={a.title} onClick={a.onClick} disabled={a.disabled}>{a.label}</button>)}
            </div>
          </details>}
        </div>}
      </div>
    </article>
  );
}

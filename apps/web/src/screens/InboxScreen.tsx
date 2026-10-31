import { useCallback, useContext, useEffect, useState } from 'react';
import { useLive } from '../lib/live.ts';
import { useLocation, useNavigate } from 'react-router-dom';
import type { DecisionVerdict, PendingDecision, PendingDecisionKind } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { AppContext } from '../lib/store.ts';
import { KIND_LABEL, PendingDecisionCard } from '../components/PendingDecisionCard.tsx';

type Load = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; items: PendingDecision[] };
type Filter = 'all' | PendingDecisionKind;

export function InboxScreen() {
  const ctx = useContext(AppContext);
  const navigate = useNavigate();
  const slug = ctx?.status.workspace?.slug ?? null;
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [filter, setFilter] = useState<Filter>('all');

  const refresh = useCallback(async () => {
    if (!slug) return;
    setLoad(prev => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
    try { setLoad({ phase: 'ready', items: await api.inbox(slug) }); }
    catch (e) { setLoad({ phase: 'error', message: e instanceof Error ? e.message : 'No se pudo cargar la bandeja.' }); }
  }, [slug]);

  useEffect(() => { void refresh(); }, [refresh]);
  // Una decisión nueva o resuelta (aquí, en otra pestaña, en un lote o desde el Asistente) aparece sin pulsar «Actualizar».
  useLive(c => c.ws === slug && c.kind !== 'progress' && (c.entity === 'process' || c.entity === 'assignment' || c.entity === 'batch'), () => refresh(), { minMs: 2000, enabled: !!slug });

  const onResolved = useCallback((d: PendingDecision, verdict: DecisionVerdict) => {
    ctx?.flash(`${verdict === 'approve' ? 'Aprobada' : 'Denegada'}: ${d.title}`);
    window.setTimeout(() => { void refresh(); }, 900);
  }, [ctx, refresh]);

  const items = load.phase === 'ready' ? load.items : [];
  const visible = filter === 'all' ? items : items.filter(i => i.kind === filter);
  const kinds = (Object.keys(KIND_LABEL) as PendingDecisionKind[]).filter(k => items.some(i => i.kind === k));

  return (
    <main className="page screen" aria-labelledby="inbox-title" style={{ display: 'flex', flexDirection: 'column', gap: 18, margin: '0 auto' }}>
      <header style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <div className="eyebrow">{ctx?.status.workspace?.name ?? 'Portal IA'}</div>
          <h1 id="inbox-title" className="h1">Autorizaciones</h1>
          <p className="lede lede-2l">Lo que espera tu decisión. Aprobar o denegar aquí equivale a hacerlo desde el proceso.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => void refresh()} disabled={load.phase === 'loading'}>Actualizar</button>
          <button className="btn btn-ghost" onClick={() => navigate('/panel')}>Volver al panel</button>
        </div>
      </header>

      {load.phase === 'loading' && (
        <div className="card card-b" role="status" style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span className="spin" aria-hidden="true" /> Cargando decisiones pendientes…</div>
      )}

      {load.phase === 'error' && (
        <div className="notice notice-err" role="alert">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div><strong>No se pudo cargar la bandeja.</strong> {load.message}</div>
            <div><button className="btn btn-secondary btn-sm" onClick={() => void refresh()}>Reintentar</button></div>
          </div>
        </div>
      )}

      {load.phase === 'ready' && items.length === 0 && (
        <div className="card empty" role="status">
          <div className="h3">No hay decisiones pendientes</div>
          <p className="small">Cuando un proceso necesite tu autorización, un diff por aplicar, una integración, una publicación o una propuesta al backlog, aparecerá aquí.</p>
        </div>
      )}

      {load.phase === 'ready' && items.length > 0 && (
        <>
          <div className="seg" role="group" aria-label="Filtrar por tipo" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Todas ({items.length})</button>
            {kinds.map(k => (
              <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{KIND_LABEL[k]} ({items.filter(i => i.kind === k).length})</button>
            ))}
          </div>
          <ul className="inbox-list" aria-label="Decisiones pendientes">
            {visible.map(d => <PendingDecisionCard key={d.id} decision={d} onResolved={onResolved} />)}
          </ul>
        </>
      )}
    </main>
  );
}

/** Acceso flotante a la bandeja con el contador de pendientes (se oculta dentro de la propia pantalla). */
const inboxCountCache = new Map<string, number>();

export function InboxLauncher() {
  const ctx = useContext(AppContext);
  const navigate = useNavigate();
  const location = useLocation();
  const slug = ctx?.status.workspace?.slug ?? null;
  const [count, setCount] = useState<number | null>(() => (slug ? inboxCountCache.get(slug) : undefined) ?? null);
  const here = location.pathname.startsWith('/autorizaciones');
  const tick = () => { if (!slug) return; api.inbox(slug).then(l => { inboxCountCache.set(slug, l.length); setCount(l.length); }).catch(() => setCount(null)); };
  // Al cambiar de espacio se pide; después, solo cuando cambia algo que puede crear o cerrar una decisión (tiempo real),
  // no cada 30 s ni en cada navegación (antes, con muchos procesos, cada navegación bloqueaba el servidor segundos).
  useEffect(() => { tick(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  useLive(c => c.ws === slug && c.kind !== 'progress' && (c.entity === 'process' || c.entity === 'assignment' || c.entity === 'batch'), tick, { minMs: 3000, enabled: !!slug });

  if (!slug || here) return null;
  return (
    <button className="inbox-fab" onClick={() => navigate('/autorizaciones')} aria-label={count ? `Autorizaciones, ${count} pendientes` : 'Autorizaciones'}>
      <span aria-hidden="true">✓</span> Autorizaciones
      {count !== null && count > 0 && <span className="dock-badge" aria-hidden="true">{count}</span>}
    </button>
  );
}

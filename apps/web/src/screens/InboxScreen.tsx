import { useCallback, useContext, useEffect, useState } from 'react';
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
          <p className="lede">Todo lo que espera tu decisión, en un solo lugar. Cada elemento se aprueba o se deniega por separado y tiene el mismo efecto que hacerlo desde el proceso.</p>
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
export function InboxLauncher() {
  const ctx = useContext(AppContext);
  const navigate = useNavigate();
  const location = useLocation();
  const slug = ctx?.status.workspace?.slug ?? null;
  const [count, setCount] = useState<number | null>(null);
  const here = location.pathname.startsWith('/autorizaciones');

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    const tick = () => { api.inbox(slug).then(l => { if (alive) setCount(l.length); }).catch(() => { if (alive) setCount(null); }); };
    tick();
    const t = window.setInterval(tick, 30000);
    return () => { alive = false; window.clearInterval(t); };
  }, [slug, location.pathname]);

  if (!slug || here) return null;
  return (
    <button className="inbox-fab" onClick={() => navigate('/autorizaciones')} aria-label={count ? `Autorizaciones, ${count} pendientes` : 'Autorizaciones'}>
      <span aria-hidden="true">✓</span> Autorizaciones
      {count !== null && count > 0 && <span className="dock-badge" aria-hidden="true">{count}</span>}
    </button>
  );
}

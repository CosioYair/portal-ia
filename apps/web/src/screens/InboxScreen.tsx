import { useCallback, useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLive } from '../lib/live.ts';
import type { DecisionVerdict, PendingDecision, PendingDecisionKind } from '@portal-ia/domain';
import { api, type AssignmentPendingItem } from '../lib/api.ts';
import { osApi, type OfficeAgent } from '../lib/osApi.ts';
import { AppContext } from '../lib/store.ts';
import { useAttention } from '../lib/uiBus.ts';
import { tabFor } from '../lib/routes.ts';
import { Shell } from '../components/Shell.tsx';
import { Icon } from '../components/ui.tsx';
import { EmptyState, PageHeader, Tile } from '../components/kit.tsx';
import { KIND_LABEL, PendingDecisionCard } from '../components/PendingDecisionCard.tsx';

type Load = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; items: PendingDecision[] };
type Filter = 'all' | PendingDecisionKind;

/**
 * Decisiones (Portal IA 2.0, antes «Autorizaciones»): TODO lo que espera al propietario en la empresa, agrupado.
 * - Autorizaciones de procesos: se aprueban o deniegan aquí con su tarjeta de siempre (cifra, riesgo y confirmación).
 * - Lo que te piden tus agentes: aprendizajes por verificar, mejoras, cambios en su carpeta, acciones del chat → enlace a
 *   la pestaña de su panel donde se resuelven (aquí no se decide nada de eso).
 * - Propuestas del Asistente → su conversación.
 */
export function InboxScreen() {
  const ctx = useContext(AppContext);
  const slug = ctx?.status.workspace?.slug ?? null;
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [filter, setFilter] = useState<Filter>('all');
  const [agents, setAgents] = useState<OfficeAgent[] | null>(null); const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  // EN-012: encargos que esperan tu decisión (misma regla de «pendiente» que el Asistente y la tarjeta).
  const [assignments, setAssignments] = useState<AssignmentPendingItem[]>([]); const [assignmentsErr, setAssignmentsErr] = useState<string | null>(null);
  const att = useAttention(slug);

  const refresh = useCallback(async () => {
    if (!slug) return;
    setLoad(prev => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
    try { setLoad({ phase: 'ready', items: await api.inbox(slug) }); }
    catch (e) { setLoad({ phase: 'error', message: e instanceof Error ? e.message : 'No se pudo cargar la bandeja.' }); }
    void osApi.office(slug, null).then(o => { setAgents(o.agents); setProjectNames(Object.fromEntries(o.projects.map(p => [p.id, p.name]))); }).catch(() => setAgents([]));
    void api.inboxAssignments(slug).then(a => { setAssignments(a); setAssignmentsErr(null); }).catch((e: unknown) => setAssignmentsErr(e instanceof Error ? e.message : 'No se pudieron cargar los encargos pendientes.'));
  }, [slug]);

  useEffect(() => { void refresh(); }, [refresh]);
  // Una decisión nueva o resuelta (aquí, en otra pestaña, en un lote o desde el Asistente) aparece sin pulsar «Actualizar».
  useLive(c => c.ws === slug && c.kind !== 'progress' && (c.entity === 'process' || c.entity === 'assignment' || c.entity === 'batch' || c.entity === 'agent' || c.entity === 'agent_chat'), () => refresh(), { minMs: 2000, enabled: !!slug });

  const onResolved = useCallback((d: PendingDecision, verdict: DecisionVerdict) => {
    ctx?.flash(`${verdict === 'approve' ? 'Aprobada' : 'Denegada'}: ${d.title}`);
    window.setTimeout(() => { void refresh(); }, 900);
  }, [ctx, refresh]);

  const items = load.phase === 'ready' ? load.items : [];
  const visible = filter === 'all' ? items : items.filter(i => i.kind === filter);
  const kinds = (Object.keys(KIND_LABEL) as PendingDecisionKind[]).filter(k => items.some(i => i.kind === k));
  const asks = (agents ?? []).flatMap(a => a.attention.filter(x => !x.processId).map(x => ({ agent: a, item: x })));
  const nothing = load.phase === 'ready' && items.length === 0 && asks.length === 0 && !att.assistant && assignments.length === 0 && !assignmentsErr;

  return (
    <Shell crumb="Decisiones">
      <main className="page screen" aria-labelledby="inbox-title" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <PageHeader icon={Icon.bell(22)} tone={items.length + asks.length + att.assistant + assignments.length > 0 ? 'decisions' : 'idle'} eyebrow={ctx?.status.workspace?.name ?? 'Portal IA'} title="Decisiones" titleId="inbox-title"
          description="Lo que espera tu respuesta. Aprobar o denegar aquí equivale a hacerlo desde el proceso."
          actions={<button className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={load.phase === 'loading'}>Actualizar</button>} />

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

        {nothing && <div className="card"><EmptyState art="inbox" title="No hay nada pendiente">Cuando un proceso necesite tu autorización, un agente te pida revisar algo o el Asistente te proponga un paso, aparecerá aquí.</EmptyState></div>}

        {load.phase === 'ready' && items.length > 0 && (
          <section className="dec-group" aria-labelledby="dec-proc">
            <div className="section-title"><h2 className="h2" id="dec-proc">Autorizaciones de procesos <span className="muted">({items.length})</span></h2>
              <div className="seg" role="group" aria-label="Filtrar por tipo">
                <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Todas ({items.length})</button>
                {kinds.map(k => (
                  <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{KIND_LABEL[k]} ({items.filter(i => i.kind === k).length})</button>
                ))}
              </div>
            </div>
            <ul className="inbox-list" aria-label="Decisiones pendientes">
              {visible.map(d => <PendingDecisionCard key={d.id} decision={d} onResolved={onResolved} />)}
            </ul>
          </section>
        )}

        {assignmentsErr && <div className="notice notice-err" role="alert"><strong>No se pudieron cargar los encargos pendientes.</strong> {assignmentsErr}</div>}

        {assignments.length > 0 && <section className="dec-group card" aria-labelledby="dec-assignments">
          <div className="card-h"><h2 className="h3" id="dec-assignments">Encargos que esperan tu decisión <span className="muted">({assignments.length})</span></h2><span className="small muted">Nada se ejecuta ni gasta hasta que lo autorices</span></div>
          <ul className="inbox-list" aria-label="Encargos pendientes" style={{ listStyle: 'none', margin: 0, padding: 0 }}>{assignments.map(it => <li key={it.id} className="dec-item">
            <Tile icon={Icon.bell()} tone="attention" size="sm" />
            <div className="dec-item-text"><strong className="sm13">{it.code} · {it.title}{projectNames[it.projectId] ? <span className="small muted"> · {projectNames[it.projectId]}</span> : null}</strong>
              <span className="small med">{it.label}{it.where ? ` · Actúa ${it.where}` : ''}</span>
              {it.note && <span className="small muted">Tu nota: «{it.note}»</span>}</div>
            <Link className="btn btn-secondary btn-sm" to={it.link}>{it.kind === 'awaiting_iteration_authorization' ? 'Autorizar iteración' : 'Ir a aceptarlo'}</Link>
          </li>)}</ul>
        </section>}

        {asks.length > 0 && <section className="dec-group card" aria-labelledby="dec-agents">
          <div className="card-h"><h2 className="h3" id="dec-agents">Lo que te piden tus agentes <span className="muted">({asks.length})</span></h2><span className="small muted">Se resuelve en el panel de cada agente</span></div>
          <div>{asks.map(({ agent, item }, i) => <div key={`${agent.id}-${i}`} className="dec-item">
            <Tile icon={Icon.agent()} tone="attention" size="sm" />
            <div className="dec-item-text"><strong className="sm13">{agent.name}{agent.projectId && projectNames[agent.projectId] ? <span className="small muted"> · {projectNames[agent.projectId]}</span> : null}</strong><span className="small med">{item.label}</span></div>
            <Link className="btn btn-secondary btn-sm" to={`/oficina/agente/${encodeURIComponent(agent.id)}/${tabFor(item)}`}>Revisar</Link>
          </div>)}</div>
        </section>}

        {att.assistant > 0 && <section className="dec-group card" aria-labelledby="dec-assistant">
          <div className="dec-item"><Tile icon={Icon.sparkles()} tone="attention" size="sm" />
            <div className="dec-item-text"><strong className="sm13" id="dec-assistant">El Asistente te propone {att.assistant} paso{att.assistant === 1 ? '' : 's'}</strong><span className="small med">En su conversación abierta (es global: cada propuesta dice a qué empresa va). Revísalos y autorízalos allí.</span></div>
            <Link className="btn btn-secondary btn-sm" to="/asistente">Abrir el Asistente</Link></div>
        </section>}
      </main>
    </Shell>
  );
}

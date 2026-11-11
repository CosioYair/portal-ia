import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as RKeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { attentionChange, useLive } from '../lib/live.ts';
import type { DecisionVerdict, PendingDecision, PendingDecisionKind } from '@portal-ia/domain';
import { api, type AssignmentPendingItem, type DecisionHistoryItem, type DecisionHistoryVerdict, type LessonImprovementInboxItem } from '../lib/api.ts';
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
type Tab = 'pendientes' | 'historial';
type HistLoad = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; items: DecisionHistoryItem[] };
/** HU-196 · Resultado visible de cada decisión resuelta. */
const VERDICT_LABEL: Record<DecisionHistoryVerdict, string> = { approve: 'Aprobada', deny: 'Denegada', superseded: 'Superada' };
const VERDICT_CLASS: Record<DecisionHistoryVerdict, string> = { approve: 'chip chip-ok', deny: 'chip chip-err', superseded: 'chip' };
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const fmtDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }); };

/** HU-188 · Etiqueta visible de cada tipo; las propuestas del Asistente tienen la suya. */
const kindLabel = (k: PendingDecisionKind): string => (k === 'assistant_decision' ? 'Propuesta del Asistente' : KIND_LABEL[k] ?? k);

/**
 * HU-196 · Historial de decisiones resueltas de la empresa (solo lectura, sin IA ni costo). Se carga al abrir la pestaña;
 * los filtros (tipo, resultado y texto) se aplican en el navegador. Se refresca solo cuando se resuelve una decisión.
 */
function HistoryPanel({ slug, projectNames }: { slug: string; projectNames: Record<string, string> }) {
  const [load, setLoad] = useState<HistLoad>({ phase: 'loading' });
  const [kind, setKind] = useState<'all' | PendingDecisionKind>('all');
  const [verdict, setVerdict] = useState<'all' | DecisionHistoryVerdict>('all');
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [staleErr, setStaleErr] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setLoad(prev => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
    try { const items = await api.inboxHistory(slug); setLoad({ phase: 'ready', items }); setStaleErr(null); }
    catch (e) {
      const message = e instanceof Error ? e.message : 'No se pudo cargar el historial.';
      setLoad(prev => (prev.phase === 'ready' ? prev : { phase: 'error', message }));
      setStaleErr(message);
    }
  }, [slug]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useLive(attentionChange(slug), () => loadHistory(), { minMs: 1500 });

  const items = load.phase === 'ready' ? load.items : [];
  const kinds = useMemo(() => Array.from(new Set(items.map(i => i.kind))), [items]);
  const visible = useMemo(() => {
    const needle = norm(q.trim());
    return items.filter(i => (kind === 'all' || i.kind === kind) && (verdict === 'all' || i.verdict === verdict)
      && (!needle || norm([i.title, i.reason ?? '', i.storyId ?? '', projectNames[i.projectId] ?? '', kindLabel(i.kind)].join(' ')).includes(needle)));
  }, [items, kind, verdict, q, projectNames]);
  const filtered = kind !== 'all' || verdict !== 'all' || q.trim() !== '';
  const clear = () => { setKind('all'); setVerdict('all'); setQ(''); searchRef.current?.focus(); };

  if (load.phase === 'loading') return <div className="card card-b" role="status" style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span className="spin" aria-hidden="true" /> Cargando el historial de decisiones…</div>;
  if (load.phase === 'error') return (
    <div className="notice notice-err" role="alert">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div><strong>No se pudo cargar el historial.</strong> {load.message}</div>
        <div><button className="btn btn-secondary btn-sm" onClick={() => void loadHistory()}>Reintentar</button></div>
      </div>
    </div>
  );
  if (items.length === 0) return <div className="card"><EmptyState art="inbox" title="Aún no hay decisiones resueltas">Cuando apruebes o deniegues algo, o una autorización quede superada, aparecerá aquí.</EmptyState></div>;

  return (
    <section className="dec-group" aria-labelledby="dec-history" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="section-title"><h2 className="h2" id="dec-history">Historial <span className="muted">({items.length})</span></h2>
        <button className="btn btn-secondary btn-sm" onClick={() => void loadHistory()}>Actualizar</button></div>
      {staleErr && <div className="notice small muted" role="status">No se pudo actualizar el historial; se muestran los últimos datos cargados. <span className="muted">({staleErr})</span></div>}
      <div role="group" aria-label="Filtrar el historial" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
        <div><label className="label" htmlFor="hist-q">Buscar</label>
          <input id="hist-q" ref={searchRef} className="input" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Título, historia o motivo" /></div>
        <div><label className="label" htmlFor="hist-kind">Tipo</label>
          <select id="hist-kind" className="input" value={kind} onChange={e => setKind(e.target.value as 'all' | PendingDecisionKind)}>
            <option value="all">Todos</option>
            {kinds.map(k => <option key={k} value={k}>{kindLabel(k)}</option>)}
          </select></div>
        <div><label className="label" htmlFor="hist-verdict">Resultado</label>
          <select id="hist-verdict" className="input" value={verdict} onChange={e => setVerdict(e.target.value as 'all' | DecisionHistoryVerdict)}>
            <option value="all">Todos</option>
            <option value="approve">Aprobada</option>
            <option value="deny">Denegada</option>
            <option value="superseded">Superada</option>
          </select></div>
        {filtered && <button className="btn btn-ghost btn-sm" onClick={clear}>Limpiar filtros</button>}
      </div>
      <p className="small muted" role="status" style={{ margin: 0 }}>{visible.length} de {items.length} decisiones</p>
      {visible.length === 0
        ? <div className="card card-b" role="status"><strong>Sin resultados con estos filtros.</strong> <button className="btn btn-ghost btn-sm" onClick={clear}>Limpiar filtros</button></div>
        : <ul className="inbox-list" aria-label="Decisiones resueltas" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {visible.map(it => <li key={it.id} className="dec-item">
            <Tile icon={Icon.bell()} tone="idle" size="sm" />
            <div className="dec-item-text">
              <strong className="sm13">{it.title}{projectNames[it.projectId] ? <span className="small muted"> · {projectNames[it.projectId]}</span> : null}</strong>
              <span className="small med"><time dateTime={it.decidedAt}>{fmtDate(it.decidedAt)}</time> · {kindLabel(it.kind)} · <span className={VERDICT_CLASS[it.verdict]}>{VERDICT_LABEL[it.verdict]}</span></span>
              {it.reason && <span className="small muted">Motivo: «{it.reason}»</span>}
            </div>
            {it.conversationId
              ? <Link className="btn btn-secondary btn-sm" to={`/asistente?conversacion=${encodeURIComponent(it.conversationId)}`}>Ver conversación</Link>
              : it.storyId
                ? <Link className="btn btn-secondary btn-sm" to={`/historias/${encodeURIComponent(it.storyId)}`}>Ver historia</Link>
                : <Link className="btn btn-secondary btn-sm" to={`/procesos/${encodeURIComponent(it.processId)}`}>Ver proceso</Link>}
          </li>)}
        </ul>}
    </section>
  );
}

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
  // EN-022: mejoras de lecciones pendientes de tu decisión (una por lección; aceptar = 1 llamada).
  const [lessonItems, setLessonItems] = useState<LessonImprovementInboxItem[]>([]); const [lessonsErr, setLessonsErr] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null); const [acceptErr, setAcceptErr] = useState<{ id: string; message: string } | null>(null);
  const att = useAttention(slug);
  // Fallo de un refresco con datos ya visibles: se conservan y se avisa con discreción (sin pantalla de error completa).
  const [staleErr, setStaleErr] = useState<string | null>(null);
  // HU-196 · Pestaña en la URL (?vista=historial) para poder enlazarla; «Pendientes» por defecto.
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('vista') === 'historial' ? 'historial' : 'pendientes';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'historial') next.set('vista', 'historial'); else next.delete('vista');
    setParams(next, { replace: true });
  };
  const onTabKey = (e: RKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const t: Tab = e.key === 'Home' ? 'pendientes' : e.key === 'End' ? 'historial' : tab === 'pendientes' ? 'historial' : 'pendientes';
    setTab(t); document.getElementById(`tab-${t}`)?.focus();
  };

  const refresh = useCallback(async () => {
    if (!slug) return;
    setLoad(prev => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
    try { const items = await api.inbox(slug); setLoad({ phase: 'ready', items }); setStaleErr(null); }
    catch (e) {
      const message = e instanceof Error ? e.message : 'No se pudo cargar la bandeja.';
      // Solo la primera carga (o «Reintentar» desde el error) muestra la pantalla de error completa.
      setLoad(prev => (prev.phase === 'ready' ? prev : { phase: 'error', message }));
      setStaleErr(message);
    }
    void osApi.office(slug, null).then(o => { setAgents(o.agents); setProjectNames(Object.fromEntries(o.projects.map(p => [p.id, p.name]))); }).catch(() => setAgents(prev => prev ?? []));
    void api.inboxAssignments(slug).then(a => { setAssignments(a); setAssignmentsErr(null); }).catch((e: unknown) => setAssignmentsErr(e instanceof Error ? e.message : 'No se pudieron cargar los encargos pendientes.'));
    void api.inboxLessons(slug).then(l => { setLessonItems(l); setLessonsErr(null); }).catch((e: unknown) => setLessonsErr(e instanceof Error ? e.message : 'No se pudieron cargar las mejoras de lecciones.'));
  }, [slug]);

  useEffect(() => { void refresh(); }, [refresh]);
  // Una decisión nueva o resuelta (aquí, en otra pestaña, en un lote, en el backlog o desde el Asistente, con o sin
  // empresa en su aviso) aparece sin pulsar «Actualizar», en menos de 3 s (HU-189).
  useLive(attentionChange(slug), () => refresh(), { minMs: 1500, enabled: !!slug });

  const onResolved = useCallback((d: PendingDecision, verdict: DecisionVerdict) => {
    ctx?.flash(`${verdict === 'approve' ? 'Aprobada' : 'Denegada'}: ${d.title}`);
    window.setTimeout(() => { void refresh(); }, 900);
  }, [ctx, refresh]);

  const items = load.phase === 'ready' ? load.items : [];
  const visible = filter === 'all' ? items : items.filter(i => i.kind === filter);
  const kinds = Array.from(new Set(items.map(i => i.kind)));
  // HU-188 · Las propuestas del Asistente van en su propia sección, con el enlace a su conversación.
  const visibleProc = visible.filter(i => i.kind !== 'assistant_decision');
  const visibleAssistant = visible.filter(i => i.kind === 'assistant_decision');
  const asks = (agents ?? []).flatMap(a => a.attention.filter(x => !x.processId).map(x => ({ agent: a, item: x })));
  const nothing = load.phase === 'ready' && items.length === 0 && asks.length === 0 && !att.assistant && assignments.length === 0 && !assignmentsErr && lessonItems.length === 0 && !lessonsErr;
  const pendingTotal = items.length + asks.length + att.assistant + assignments.length + lessonItems.length;
  const acceptLesson = async (it: LessonImprovementInboxItem) => {
    if (!slug || accepting) return;
    setAccepting(it.lessonId); setAcceptErr(null);
    try {
      const v = await api.acceptLessonImprovement(slug, it.lessonId);
      ctx?.flash(`Mejora aplicada: «${it.title}» pasa a la versión ${v.version}`);
      setLessonItems(prev => prev.filter(x => x.lessonId !== it.lessonId));
      window.setTimeout(() => { void refresh(); }, 900);
    } catch (e) { setAcceptErr({ id: it.lessonId, message: e instanceof Error ? e.message : 'No se pudo aplicar la mejora.' }); }
    finally { setAccepting(null); }
  };

  return (
    <Shell crumb="Decisiones">
      <main className="page screen" aria-labelledby="inbox-title" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <PageHeader icon={Icon.bell(22)} tone={pendingTotal > 0 ? 'decisions' : 'idle'} eyebrow={ctx?.status.workspace?.name ?? 'Portal IA'} title="Decisiones" titleId="inbox-title"
          description="Lo que espera tu respuesta. Aprobar o denegar aquí equivale a hacerlo desde el proceso."
          actions={tab === 'pendientes' ? <button className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={load.phase === 'loading'}>Actualizar</button> : undefined} />

        <div className="seg" role="tablist" aria-label="Decisiones">
          <button type="button" role="tab" id="tab-pendientes" aria-selected={tab === 'pendientes'} aria-controls="panel-pendientes" tabIndex={tab === 'pendientes' ? 0 : -1} aria-pressed={tab === 'pendientes'} onClick={() => setTab('pendientes')} onKeyDown={onTabKey}>
            Pendientes ({pendingTotal})</button>
          <button type="button" role="tab" id="tab-historial" aria-selected={tab === 'historial'} aria-controls="panel-historial" tabIndex={tab === 'historial' ? 0 : -1} aria-pressed={tab === 'historial'} onClick={() => setTab('historial')} onKeyDown={onTabKey}>
            Historial</button>
        </div>

        {tab === 'historial' && <div role="tabpanel" id="panel-historial" aria-labelledby="tab-historial" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {slug ? <HistoryPanel slug={slug} projectNames={projectNames} /> : <div className="card card-b" role="status">Elige una empresa para ver su historial.</div>}
        </div>}

        {tab === 'pendientes' && <div role="tabpanel" id="panel-pendientes" aria-labelledby="tab-pendientes" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

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

        {load.phase === 'ready' && staleErr && (
          <div className="notice small muted" role="status">No se pudo actualizar la bandeja; se muestran los últimos datos cargados. Se volverá a intentar con el próximo cambio. <span className="muted">({staleErr})</span></div>
        )}

        {nothing && <div className="card"><EmptyState art="inbox" title="No hay nada pendiente">Cuando un proceso necesite tu autorización, un agente te pida revisar algo o el Asistente te proponga un paso, aparecerá aquí.</EmptyState>
          <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 16 }}><button className="btn btn-secondary btn-sm" onClick={() => setTab('historial')}>Ver historial</button></div></div>}

        {load.phase === 'ready' && items.length > 0 && (
          <section className="dec-group" aria-labelledby="dec-proc">
            <div className="section-title"><h2 className="h2" id="dec-proc">Autorizaciones de procesos <span className="muted">({items.length})</span></h2>
              <div className="seg" role="group" aria-label="Filtrar por tipo">
                <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Todas ({items.length})</button>
                {kinds.map(k => (
                  <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{kindLabel(k)} ({items.filter(i => i.kind === k).length})</button>
                ))}
              </div>
            </div>
            {visibleProc.length > 0 && <ul className="inbox-list" aria-label="Decisiones pendientes">
              {visibleProc.map(d => <PendingDecisionCard key={d.id} decision={d} onResolved={onResolved} />)}
            </ul>}
          </section>
        )}

        {load.phase === 'ready' && visibleAssistant.length > 0 && (
          <section className="dec-group" aria-labelledby="dec-assistant-proposals">
            <div className="section-title"><h2 className="h2" id="dec-assistant-proposals">Propuestas del Asistente <span className="muted">({visibleAssistant.length})</span></h2>
              <span className="small muted">Aprobar o denegar aquí no llama a la IA ni tiene costo</span></div>
            <ul className="inbox-list" aria-label="Propuestas del Asistente pendientes" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {visibleAssistant.map(d => (
                <li key={d.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="chip chip-accent" style={{ alignSelf: 'flex-start' }}>{kindLabel(d.kind)}</span>
                  <PendingDecisionCard as="div" decision={d} onResolved={onResolved} />
                  {d.conversationId && <div><Link className="btn btn-secondary btn-sm" to={`/asistente?conversacion=${encodeURIComponent(d.conversationId)}`}>Ver conversación</Link></div>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {assignmentsErr && <div className="notice notice-err" role="alert"><strong>No se pudieron cargar los encargos pendientes.</strong> {assignmentsErr}</div>}

        {assignments.length > 0 && <section className="dec-group card" aria-labelledby="dec-assignments">
          <div className="card-h"><h2 className="h3" id="dec-assignments">Encargos pendientes de ti <span className="muted">({assignments.length})</span></h2><span className="small muted">Nada se ejecuta ni gasta hasta que lo autorices</span></div>
          <ul className="inbox-list" aria-label="Encargos pendientes" style={{ listStyle: 'none', margin: 0, padding: 0 }}>{assignments.map(it => <li key={it.id} className="dec-item">
            <Tile icon={Icon.bell()} tone="attention" size="sm" />
            <div className="dec-item-text"><strong className="sm13">{it.code} · {it.title}{projectNames[it.projectId] ? <span className="small muted"> · {projectNames[it.projectId]}</span> : null}</strong>
              <span className="small med">{it.label}{it.where ? ` · Actúa ${it.where}` : ''}</span>
              {it.note && <span className="small muted">Tu nota: «{it.note}»</span>}</div>
            <Link className="btn btn-secondary btn-sm" to={it.link}>{it.kind === 'awaiting_iteration_authorization' ? 'Autorizar iteración' : 'Ir a aceptarlo'}</Link>
          </li>)}</ul>
        </section>}

        {lessonsErr && <div className="notice notice-err" role="alert"><strong>No se pudieron cargar las mejoras de lecciones.</strong> {lessonsErr}</div>}

        {lessonItems.length > 0 && <section className="dec-group card" aria-labelledby="dec-lessons">
          <div className="card-h"><h2 className="h3" id="dec-lessons">Mejoras de lecciones <span className="muted">({lessonItems.length})</span></h2><span className="small muted">Sin autorización permanente en Ajustes no se llama a la IA: aceptar redacta la versión nueva con 1 llamada</span></div>
          <ul className="inbox-list" aria-label="Mejoras de lecciones pendientes" style={{ listStyle: 'none', margin: 0, padding: 0 }}>{lessonItems.map(it => <li key={it.lessonId} className="dec-item">
            <Tile icon={Icon.sparkles()} tone="attention" size="sm" />
            <div className="dec-item-text"><strong className="sm13">{it.title} · v{it.version}{it.projectId && projectNames[it.projectId] ? <span className="small muted"> · {projectNames[it.projectId]}</span> : null}</strong>
              <span className="small med">{it.reason === 'refuted' ? `Quedó refutada: el error se repitió con ella en ${it.tasks} tarea${it.tasks === 1 ? '' : 's'}` : `Reincidió en ${it.tasks} tareas distintas con la lección aplicada`}</span>
              {it.lessonText && <span className="small muted">Texto actual: «{it.lessonText}»</span>}
              <span className="small muted">Costo estimado: {it.estimatedUsd != null ? `≈ ${it.estimatedUsd.toFixed(4)} USD` : 'no disponible'} · La versión actual queda obsoleta y podrás volver a ella desde Lecciones.</span>
              {acceptErr?.id === it.lessonId && <span className="small" role="alert" style={{ color: 'var(--err, #b42318)' }}>{acceptErr.message}</span>}</div>
            <button className="btn btn-primary btn-sm" onClick={() => void acceptLesson(it)} disabled={accepting !== null} aria-busy={accepting === it.lessonId}>
              {accepting === it.lessonId ? 'Redactando…' : 'Aceptar mejora (1 llamada)'}</button>
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
        </div>}
      </main>
    </Shell>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type WorkItem, type WorkSegment, type WorkView } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { useLive } from '../lib/live.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, Icon, Notice, Spinner } from '../components/ui.tsx';
import { EmptyState, PageHeader, WorkTabs } from '../components/kit.tsx';
import '../work.css';

/**
 * Portal IA 3 · «Trabajo»: todo lo que has pedido, en una sola lista y con su estado real. Historias y encargos juntos
 * (para ti son lo mismo: algo que pediste). Responde a tres preguntas sin abrir nada más: qué te necesita, qué está en
 * marcha y dónde continúo. El filtro y la búsqueda viven en la dirección: Atrás/Adelante y recargar los conservan.
 */
const SEGMENTS: { key: WorkSegment; label: string; empty: string }[] = [
  { key: 'needs_you', label: 'Te necesitan', empty: 'Nada espera una decisión tuya.' },
  { key: 'running', label: 'En marcha', empty: 'El equipo no está trabajando en nada ahora.' },
  { key: 'todo', label: 'Por empezar', empty: 'No hay nada planificado sin empezar.' },
  { key: 'done', label: 'Terminado', empty: 'Todavía no hay trabajo cerrado.' }
];
const VIEW: Record<string, WorkSegment | 'open'> = { abierto: 'open', 'te-necesitan': 'needs_you', 'en-marcha': 'running', 'por-empezar': 'todo', terminado: 'done' };
const SLUG: Record<WorkSegment | 'open', string> = { open: 'abierto', needs_you: 'te-necesitan', running: 'en-marcha', todo: 'por-empezar', done: 'terminado' };

/** Qué hace el botón de cada elemento: una sola acción, con el verbo de lo que toca. */
function actionLabel(i: WorkItem): string {
  switch (i.state.key as string) {
    case 'needs_authorization': return 'Revisar y autorizar';
    case 'needs_decision': case 'stopped': case 'failed': case 'no_changes': case 'ended_unverified': return 'Ver qué pasó y continuar';
    case 'ready_for_review': return 'Revisar el resultado';
    case 'integrated_unaccepted': return 'Probar y aceptar';
    case 'working': case 'queued': return 'Ver el avance';
    case 'todo': return i.kind === 'story' ? 'Abrir' : 'Retomar';
    default: return 'Consultar';
  }
}
const hrefOf = (i: WorkItem) => i.kind === 'story' ? `/historias/${i.id}` : i.processId ? `/procesos/${i.processId}` : '/asistente';

export function Work() {
  const { status } = useApp();
  const ws = status.workspace!; const projectId = status.project!.id;
  const [params, setParams] = useSearchParams();
  const view = VIEW[params.get('ver') ?? 'abierto'] ?? 'open';
  const q = params.get('q') ?? '';
  const [data, setData] = useState<WorkView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => { try { setData(await api.work(ws.slug, projectId)); setError(null); } catch (e: any) { setError(e?.message ?? 'No se pudo cargar el trabajo.'); } };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug, projectId]);
  // Solo este proyecto y como mucho una vez cada 5 s: la lista no necesita mas y asi no compite con lo que este trabajando.
  useLive(c => c.ws === ws.slug && (!c.projectId || c.projectId === projectId) && ['process', 'backlog', 'assignment', 'batch'].includes(c.entity), load, { minMs: 5000 });

  const set = (k: 'ver' | 'q', v: string) => { const next = new URLSearchParams(params); if (!v || (k === 'ver' && v === 'abierto')) next.delete(k); else next.set(k, v); setParams(next, { replace: k === 'q' }); };
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.items ?? []).filter(i => (view === 'open' ? i.segment !== 'done' : i.segment === view) && (!term || `${i.code} ${i.title} ${i.ask}`.toLowerCase().includes(term)));
  }, [data, view, q]);
  const groups = SEGMENTS.filter(s => view === 'open' ? s.key !== 'done' : s.key === view);
  const open = data ? data.counts.needs_you + data.counts.running + data.counts.todo : 0;

  return (
    <Shell crumb="Todo">
      <main className="page work-page">
        <PageHeader icon={Icon.kanban(22)} tone="work" eyebrow="Trabajo" title="Todo lo que has pedido"
          description="Historias y encargos en un solo lugar, con su estado real. Empieza por lo que te necesita.">
          <WorkTabs />
        </PageHeader>

        <div className="work-bar" role="group" aria-label="Qué ver">
          <div className="work-filters">
            <button type="button" className={`work-filter${view === 'open' ? ' is-on' : ''}`} aria-pressed={view === 'open'} onClick={() => set('ver', 'abierto')}>Abierto <span className="work-n">{open}</span></button>
            {SEGMENTS.map(s => <button key={s.key} type="button" className={`work-filter${view === s.key ? ' is-on' : ''}${s.key === 'needs_you' && (data?.counts.needs_you ?? 0) > 0 ? ' is-attn' : ''}`} aria-pressed={view === s.key} onClick={() => set('ver', SLUG[s.key])}>{s.label} <span className="work-n">{data?.counts[s.key] ?? 0}</span></button>)}
          </div>
          <label className="work-search"><span className="sr-only">Buscar en el trabajo</span>
            <input className="input" type="search" placeholder="Buscar por código o texto…" value={q} onChange={e => set('q', e.target.value)} /></label>
        </div>

        {error && <Notice kind="err">{error} <button type="button" className="lnk" onClick={() => void load()}>Reintentar</button></Notice>}
        {!data && !error && <Spinner label="Cargando el trabajo…" />}
        {data && data.items.length === 0 && <section className="card"><EmptyState art="desk" title="Aún no has pedido nada">Pide algo al Asistente con el botón «Pedir» y aparecerá aquí con su avance.</EmptyState></section>}

        {data && data.items.length > 0 && groups.map(g => {
          const rows = shown.filter(i => i.segment === g.key);
          return (
            <section key={g.key} className="work-group" aria-labelledby={`work-${g.key}`}>
              <h2 className="work-group-h" id={`work-${g.key}`}>{g.label} <span className="work-n">{rows.length}</span></h2>
              {rows.length === 0 ? <p className="work-empty">{q ? 'Nada coincide con la búsqueda.' : g.empty}</p> : (
                <ul className="work-list">
                  {rows.map(i => (
                    <li key={`${i.kind}-${i.id}`} className={`work-item work-tone-${i.state.tone || 'none'}`}>
                      <div className="work-item-main">
                        <div className="work-item-top">
                          <span className="work-code">{i.code}</span>
                          <span className="work-kind">{i.kind === 'story' ? 'Historia' : 'Encargo'}</span>
                          <Chip xs tone={i.state.tone} dot={i.state.dot}>{i.state.label}</Chip>
                        </div>
                        <h3 className="work-title">{i.title}</h3>
                        <p className="work-meaning">{i.state.meaning}{i.dependsOn && i.segment === 'todo' ? ` Va después de ${i.dependsOn}.` : ''}</p>
                      </div>
                      <Link className={`btn btn-sm ${i.segment === 'needs_you' ? 'btn-primary' : 'btn-secondary'} work-go`} to={hrefOf(i)} aria-label={`${actionLabel(i)}: ${i.code} ${i.title}`}>{actionLabel(i)}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </main>
    </Shell>
  );
}

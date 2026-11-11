import { useCallback, useContext, useEffect, useState } from 'react';
import { api, type LessonImprovementInboxItem } from '../lib/api.ts';
import { attentionChange, useLive } from '../lib/live.ts';
import { AppContext } from '../lib/store.ts';
import { Icon } from './ui.tsx';
import { Tile } from './kit.tsx';

/**
 * EN-022 · Mejoras de lecciones pendientes de tu decisión (una por lección). Se muestran en Decisiones; aceptar con un
 * clic redacta la versión nueva (1 llamada). Sin autorización permanente en Ajustes nada llama a la IA por su cuenta.
 */
export function LessonImprovementsInbox({ slug, projectNames, onState }: {
  slug: string;
  projectNames: Record<string, string>;
  onState?: (s: { count: number; error: boolean }) => void;
}) {
  const ctx = useContext(AppContext);
  const [items, setItems] = useState<LessonImprovementInboxItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acceptErr, setAcceptErr] = useState<{ id: string; message: string } | null>(null);

  const refresh = useCallback(async () => {
    try { const l = await api.inboxLessons(slug); setItems(l); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'No se pudieron cargar las mejoras de lecciones.'); }
  }, [slug]);
  useEffect(() => { void refresh(); }, [refresh]);
  useLive(attentionChange(slug), () => refresh(), { minMs: 1500 });
  useEffect(() => { onState?.({ count: items.length, error: !!err }); }, [items.length, err, onState]);

  const accept = async (it: LessonImprovementInboxItem) => {
    if (accepting) return;
    setAccepting(it.lessonId); setAcceptErr(null);
    try {
      const v = await api.acceptLessonImprovement(slug, it.lessonId);
      ctx?.flash(`Mejora aplicada: «${it.title}» pasa a la versión ${v.version}`);
      setItems(prev => prev.filter(x => x.lessonId !== it.lessonId));
      window.setTimeout(() => { void refresh(); }, 900);
    } catch (e) { setAcceptErr({ id: it.lessonId, message: e instanceof Error ? e.message : 'No se pudo aplicar la mejora.' }); }
    finally { setAccepting(null); }
  };

  return (
    <>
      {err && <div className="notice notice-err" role="alert"><strong>No se pudieron cargar las mejoras de lecciones.</strong> {err}</div>}
      {items.length > 0 && <section className="dec-group card" aria-labelledby="dec-lessons">
        <div className="card-h"><h2 className="h3" id="dec-lessons">Mejoras de lecciones <span className="muted">({items.length})</span></h2><span className="small muted">Sin autorización permanente en Ajustes no se llama a la IA: aceptar redacta la versión nueva con 1 llamada</span></div>
        <ul className="inbox-list" aria-label="Mejoras de lecciones pendientes" style={{ listStyle: 'none', margin: 0, padding: 0 }}>{items.map(it => <li key={it.lessonId} className="dec-item">
          <Tile icon={Icon.sparkles()} tone="attention" size="sm" />
          <div className="dec-item-text"><strong className="sm13">{it.title} · v{it.version}{it.projectId && projectNames[it.projectId] ? <span className="small muted"> · {projectNames[it.projectId]}</span> : null}</strong>
            <span className="small med">{it.reason === 'refuted' ? `Quedó refutada: el error se repitió con ella en ${it.tasks} tarea${it.tasks === 1 ? '' : 's'}` : `Reincidió en ${it.tasks} tareas distintas con la lección aplicada`}</span>
            {it.lessonText && <span className="small muted">Texto actual: «{it.lessonText}»</span>}
            <span className="small muted">Costo estimado: {it.estimatedUsd != null ? `≈ ${it.estimatedUsd.toFixed(4)} USD` : 'no disponible'} · La versión actual queda obsoleta y podrás volver a ella desde Lecciones.</span>
            {acceptErr?.id === it.lessonId && <span className="small" role="alert" style={{ color: 'var(--err)' }}>{acceptErr.message}</span>}</div>
          <button className="btn btn-primary btn-sm" onClick={() => void accept(it)} disabled={accepting !== null} aria-busy={accepting === it.lessonId}>
            {accepting === it.lessonId ? 'Redactando…' : 'Aceptar mejora (1 llamada)'}</button>
        </li>)}</ul>
      </section>}
    </>
  );
}

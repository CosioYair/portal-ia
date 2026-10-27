import { useState } from 'react';
import type { ManualTestStepView, StoryContext } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { IterationComposer } from './IterationComposer.tsx';
import { Notice } from './ui.tsx';

/**
 * Acciones de «Pasos con falla» en la prueba paso a paso: devolver el feedback al equipo como nueva iteración (con los
 * pasos, sus comentarios, las tareas abiertas y tu nota) o convertir los fallos en tareas. Nada gasta IA: la iteración
 * queda pendiente de autorización en «Iteraciones».
 */
export function FeedbackToTeam({ slug, itemId, failed, flush }: { slug: string; itemId: string; failed: ManualTestStepView[]; flush: () => Promise<void> }) {
  const { flash, navigate } = useApp();
  const [ctx, setCtx] = useState<StoryContext | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tasksMsg, setTasksMsg] = useState<string | null>(null);

  const openComposer = async () => {
    if (open) { setOpen(false); return; }
    setBusy(true); setErr(null);
    try { await flush(); setCtx(await api.story(slug, itemId)); setOpen(true); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const createTasks = async () => {
    setBusy(true); setErr(null); setTasksMsg(null);
    try {
      await flush();
      const t = await api.storyTasksFromFeedback(slug, itemId);
      setTasksMsg(t.length ? `${t.length} tarea(s) creadas desde los pasos con falla.` : 'Ya existían tareas para estos fallos; no se duplican.');
      flash(t.length ? `${t.length} tarea(s) creadas` : 'Sin tareas nuevas');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="mts-failure-actions" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void openComposer()} disabled={busy} aria-expanded={open}>Enviar este feedback al equipo (nueva iteración)</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void createTasks()} disabled={busy}>Crear tareas con estos fallos</button>
      </div>
      {tasksMsg && <div className="small" role="status">{tasksMsg} <button type="button" className="lnk" onClick={() => navigate(`/historias/${itemId}#tareas`)}>Ver tareas</button></div>}
      {open && ctx && <div style={{ background: '#fff', border: '1px solid #E5E3DC', borderRadius: 8, padding: 12 }}>
        <div className="small" style={{ marginBottom: 6 }}><strong>El equipo recibirá</strong> {failed.length} paso(s) con falla y sus comentarios, {ctx.tasks.filter(t => t.status === 'open').length} tarea(s) abiertas, el criterio de aceptación vigente y tu nota.</div>
        <IterationComposer slug={slug} itemId={itemId} iteration={ctx.iteration} nextNumber={ctx.iterations + 1} beforeSubmit={flush}
          placeholder="Nota adicional para el equipo (opcional): qué esperabas ver, prioridades, qué no tocar…"
          onCreated={() => { flash('Iteración creada con tu feedback: revísala y autorízala'); navigate(`/historias/${itemId}#iteraciones`); }} />
      </div>}
      {err && <Notice kind="err">{err}</Notice>}
    </div>
  );
}

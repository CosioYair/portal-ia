import { useState } from 'react';
import type { StoryIterationState } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { Icon, Notice } from './ui.tsx';

interface Props {
  slug: string;
  itemId: string;
  /** Lo que calcula el servidor (StoryContext.iteration): qué pasará con la iteración anterior y qué hay que confirmar. */
  iteration: StoryIterationState;
  /** Número de la iteración que se creará. */
  nextNumber: number;
  initialNote?: string;
  placeholder?: string;
  /** Antes de crear (p. ej. guardar los comentarios de la prueba aún no guardados). */
  beforeSubmit?: () => Promise<void>;
  onCreated: (r: { processId: string; actions: string[] }) => void;
}

/**
 * Crear una nueva iteración de la historia (pendiente de autorización). Una sola implementación para «Iteraciones» y para
 * «Pasos con falla»: el servidor decide qué ocurre con la iteración anterior y esta tarjeta pide lo que haga falta
 * (reabrir la historia, confirmar el descarte del worktree y la rama).
 */
export function IterationComposer({ slug, itemId, iteration, nextNumber, initialNote = '', placeholder, beforeSubmit, onCreated }: Props) {
  const [note, setNote] = useState(initialNote);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (iteration.state === 'in_progress') return <Notice kind="info">{iteration.summary}</Notice>;
  const blocked = iteration.needsDiscardConfirmation && !confirmDiscard;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await beforeSubmit?.();
      const r = await api.storyIterate(slug, itemId, note.trim() || null, { reopen: iteration.needsReopen, discardApplied: iteration.needsDiscardConfirmation && confirmDiscard });
      setNote(''); setConfirmDiscard(false);
      onCreated({ processId: r.process.id, actions: r.actions });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="iter-composer" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p className="small muted" style={{ margin: 0 }}>{iteration.summary}</p>
      <textarea className="input" style={{ minHeight: 60 }} value={note} onChange={e => setNote(e.target.value)} aria-label="Nota para el equipo"
        placeholder={placeholder ?? 'Nota para el equipo (qué corregir o completar). Se añaden solos los pasos con falla y sus comentarios, las tareas abiertas, el criterio vigente y la conversación reciente.'} />
      {iteration.needsDiscardConfirmation && <label className="ck"><input className="cb" type="checkbox" checked={confirmDiscard} onChange={e => setConfirmDiscard(e.target.checked)} />
        <span>Autorizo descartar la iteración aplicada sin integrar: se retira su worktree y se borra la rama <span className="mono">{iteration.branch}</span>. Tu carpeta del Portal y <span className="mono">main</span> no cambian.</span></label>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy || blocked}>{busy ? <span className="spin spin-light" /> : Icon.arrow()}{iteration.needsReopen ? `Reabrir y crear iteración ${nextNumber}` : `Crear iteración ${nextNumber}`}</button>
        <span className="small muted">Queda pendiente de tu autorización; no gasta nada hasta entonces.</span>
      </div>
      {err && <Notice kind="err">{err}</Notice>}
    </div>
  );
}

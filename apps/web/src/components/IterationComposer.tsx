import { useEffect, useState } from 'react';
import type { StoryIterationState } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { DraftNote, Icon, Notice } from './ui.tsx';
import { draftKey, useDraft } from '../lib/persist.ts';

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
  onCreated: (r: { processId: string; actions: string[]; continued: boolean }) => void;
}

/**
 * Crear una nueva iteración de la historia (pendiente de autorización). Una sola implementación para «Iteraciones» y para
 * «Pasos con falla»: el servidor decide qué ocurre con la iteración anterior y esta tarjeta pide lo que haga falta
 * (reabrir la historia, confirmar el descarte del worktree y la rama).
 */
export function IterationComposer({ slug, itemId, iteration, nextNumber, initialNote = '', placeholder, beforeSubmit, onCreated }: Props) {
  // La nota a medias se conserva por historia e iteración (también al recargar); una propuesta aplicada la sustituye.
  const noteDraft = useDraft(draftKey('iteracion', slug, itemId, String(nextNumber)), initialNote); const note = noteDraft.value; const setNote = noteDraft.set;
  useEffect(() => { if (initialNote) setNote(initialNote); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNote]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (iteration.state === 'in_progress') return <Notice kind="info">{iteration.summary}</Notice>;
  // Portal IA 3: por defecto se CONTINUA sobre la rama ya hecha; descartarla es una eleccion explicita, nunca un requisito.
  const keeps = iteration.needsDiscardConfirmation && !confirmDiscard;
  const blocked = false;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await beforeSubmit?.();
      const r = await api.storyIterate(slug, itemId, note.trim() || null, { reopen: iteration.needsReopen, discardApplied: iteration.needsDiscardConfirmation && confirmDiscard });
      noteDraft.clear(); setConfirmDiscard(false);
      onCreated({ processId: r.process.id, actions: r.actions, continued: !!r.continued });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="iter-composer" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p className="small muted" style={{ margin: 0 }}>{keeps ? 'Di qué hay que corregir o completar. Lo que ya está hecho y verificado se conserva.' : iteration.summary}</p>
      {noteDraft.status === 'restored' && <DraftNote status="restored" onDiscard={noteDraft.clear} />}
      <textarea className="input" style={{ minHeight: 60 }} value={note} onChange={e => setNote(e.target.value)} aria-label="Nota para el equipo"
        placeholder={placeholder ?? 'Nota para el equipo (qué corregir o completar). Se añaden solos los pasos con falla y sus comentarios, las tareas abiertas, el criterio vigente y la conversación reciente.'} />
      {iteration.needsDiscardConfirmation && <label className="ck"><input className="cb" type="checkbox" checked={confirmDiscard} onChange={e => setConfirmDiscard(e.target.checked)} />
        <span>Empezar de cero: descartar lo ya hecho en esta historia y rehacerla entera. Sin marcar, el equipo corrige sobre lo que ya hay (recomendado).</span></label>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy || blocked}>{busy ? <span className="spin spin-light" /> : Icon.arrow()}{iteration.needsReopen ? `Reabrir y crear iteración ${nextNumber}` : keeps ? 'Pedir estos cambios' : `Crear iteración ${nextNumber}`}</button>
        <span className="small muted">{keeps ? 'El equipo corrige sobre lo que ya hay. No gasta nada hasta que pulses «Aplicar los cambios pedidos».' : 'Queda pendiente de tu autorización; no gasta nada hasta entonces.'}</span>
      </div>
      {err && <Notice kind="err">{err}</Notice>}
    </div>
  );
}

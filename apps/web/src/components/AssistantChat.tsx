import { useEffect, useRef, useState, type ClipboardEvent, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type AssistantAction, type AssistantImage, type AssistantInfo, type AssistantMessage } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Chip, Icon, KV, Notice } from './ui.tsx';
import { Markdown } from './Markdown.tsx';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

type Pending = AssistantImage & { preview: string; bytes: number };

function fileToPending(f: File): Promise<Pending> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`No se pudo leer ${f.name}`));
    r.onload = () => { const url = String(r.result); resolve({ mediaType: f.type, data: url.slice(url.indexOf(',') + 1), name: f.name || 'imagen', preview: url, bytes: f.size }); };
    r.readAsDataURL(f);
  });
}

/** Tarjeta de propuesta: ejecutar historia / aplicar cambios. La autorización ocurre aquí, con costo visible. */
function ProposalCard({ msgId, action, onResolved }: { msgId: string; action: AssistantAction; onResolved: (m: AssistantMessage) => void }) {
  const { flash } = useApp();
  const [budget, setBudget] = useState((action.suggestedBudgetUsd ?? Math.max(0.5, (action.estimatedUsd ?? 0.5) * 2)).toFixed(2));
  const [auth, setAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isDeleg = action.type === 'propose_delegation';
  const isExec = action.type === 'propose_execution' || isDeleg;

  const run = async () => {
    if (!action.processId || !action.workspaceSlug) return;
    setBusy(true); setErr(null);
    try {
      if (isExec) {
        const p = await api.authorizeProcess(action.workspaceSlug, action.processId, Number(budget));
        const r = await api.resolveAssistantProposal(msgId, action.processId, 'done', `En ejecución con presupuesto ${fmtUsd(p.budgetUsd)}. Sigue el avance en el proceso.`);
        onResolved(r.message); flash(isDeleg ? `Encargo en curso · presupuesto ${fmtUsd(p.budgetUsd)}` : `Historia ${action.storyId ?? ''} en ejecución · presupuesto ${fmtUsd(p.budgetUsd)}`);
      } else {
        const p = await api.applyChanges(action.workspaceSlug, action.processId);
        const ap = p.result?.applied;
        const r = await api.resolveAssistantProposal(msgId, action.processId, 'done', ap ? `Aplicado en la rama ${ap.branch} · commit ${ap.commit}` : 'Cambios aplicados.');
        onResolved(r.message); flash('Cambios aplicados en una rama git');
      }
    } catch (e: any) {
      setErr(e.message);
      // Dejamos constancia en la conversación de que falló (visible y persistente).
      try { const r = await api.resolveAssistantProposal(msgId, action.processId, 'failed', e.message); onResolved(r.message); } catch { /* el error ya se muestra */ }
    } finally { setBusy(false); }
  };

  const link = action.link ? `/empresa/${action.workspaceSlug}/proyecto/${action.projectId}/procesos/${action.processId}` : null;
  return (
    <div className="card" style={{ borderColor: '#F0C66B', background: '#FFFBF0' }}>
      <div className="card-h" style={{ alignItems: 'flex-start' }}><div><div className="h3" style={{ fontSize: 14 }}>{action.label}</div>{action.detail && <div className="small muted">{action.detail}</div>}</div><Chip tone="warn" xs>{isExec ? 'consume IA' : 'escribe en git'} · requiere tu autorización</Chip></div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {err && <Notice kind="err"><strong>No se pudo {isExec ? 'iniciar la ejecución' : 'aplicar los cambios'}.</strong> {err}</Notice>}
        {isExec && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: 12, alignItems: 'end' }}>
          <div><label className="label" htmlFor={`b-${action.processId}`}>Presupuesto máximo (USD)</label><input id={`b-${action.processId}`} className="input mono" type="number" min={0.1} step={0.5} value={budget} onChange={e => setBudget(e.target.value)} /></div>
          <div className="help" style={{ paddingBottom: 6 }}>Estimado ≈ {fmtUsd(action.estimatedUsd ?? 0)}. El proceso se detiene entre pasos si se acerca al límite.</div>
        </div>}
        <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>{isExec
          ? (isDeleg
            ? <>Autorizo este <strong>encargo</strong> al agente responsable y a los agentes a su cargo, hasta <strong>{fmtUsd(Number(budget) || 0)}</strong>. El resultado quedará en Conocimiento; los cambios al backlog que proponga los aplicaré yo desde el proceso.</>
            : <>Autorizo que el equipo del proyecto trabaje en <strong>{action.storyId}</strong> leyendo el repositorio, hasta <strong>{fmtUsd(Number(budget) || 0)}</strong>. El resultado será un <strong>diff propuesto</strong> que revisaré antes de aplicarse.</>)
          : <>Autorizo aplicar <strong>{action.changes ?? 0} cambio(s)</strong> en una rama <span className="mono">portal-ia/hu-xxx</span> del repositorio (con commit). La rama no se integra en <span className="mono">main</span> sin mi intervención.</>}</span></label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" onClick={run} disabled={!auth || busy || (isExec && !(Number(budget) > 0))}>{busy ? <span className="spin spin-light" /> : Icon.arrow()}{busy ? (isExec ? 'Autorizando…' : 'Aplicando…') : (isDeleg ? 'Autorizar el encargo' : isExec ? 'Autorizar y ejecutar' : 'Aplicar cambios')}</button>
          {link && <Link className="btn btn-ghost btn-sm" to={link}>{isExec ? 'Ver detalle del proceso' : 'Revisar el diff antes'}</Link>}
        </div>
      </div>
    </div>
  );
}

function ActionRow({ a }: { a: AssistantAction }) {
  const ok = a.status === 'done';
  return <div className={`notice ${ok ? 'notice-ok' : 'notice-err'}`} style={{ padding: '8px 12px' }}>{ok ? Icon.okc() : Icon.alert()}<div><strong>{a.label}</strong>{a.detail && <> — {a.detail}</>}{a.link && ok && <> · <Link className="lnk" to={a.link}>abrir</Link></>}</div></div>;
}

/** Conversación con el Asistente de Empresa (compartida por la pantalla Asistente y el dock flotante). */
export function AssistantChat({ compact = false, onInfo, onPending }: { compact?: boolean; onInfo?: (i: AssistantInfo) => void; onPending?: (n: number) => void }) {
  const { flash, refreshStructure } = useApp();
  const [info, setInfo] = useState<AssistantInfo | null>(null);
  const [msgs, setMsgs] = useState<AssistantMessage[]>([]);
  const [text, setText] = useState('');
  const [images, setImages] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api.assistant().then(r => { setInfo(r.info); onInfo?.(r.info); setMsgs(r.messages); }).catch(e => setError(e.message)); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs.length, busy]);
  const pendingCount = msgs.reduce((n, m) => n + m.actions.filter(a => a.status === 'pending').length, 0);
  useEffect(() => { onPending?.(pendingCount); }, [pendingCount, onPending]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!list.length) return;
    const errs: string[] = []; const next = [...images];
    for (const f of list) {
      if (next.length >= MAX_IMAGES) { errs.push(`Máximo ${MAX_IMAGES} imágenes por mensaje.`); break; }
      if (!ACCEPTED.includes(f.type)) { errs.push(`${f.name}: formato no soportado (PNG, JPEG, WebP o GIF).`); continue; }
      if (f.size > MAX_IMAGE_BYTES) { errs.push(`${f.name}: supera 5 MB.`); continue; }
      try { next.push(await fileToPending(f)); } catch (e: any) { errs.push(e.message); }
    }
    setImages(next);
    if (errs.length) setError(errs.join(' ')); else setError(null);
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); void addFiles(files); }
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; };

  const send = async () => {
    const t = text.trim(); if ((!t && !images.length) || busy) return;
    const content = t || `(${images.length} imagen(es) adjunta(s))`;
    const imgs = images;
    setBusy(true); setError(null); setText(''); setImages([]);
    setMsgs(m => [...m, { id: 'tmp', role: 'user', content, actions: [], attachments: imgs.map(i => ({ name: i.name ?? 'imagen', mediaType: i.mediaType, bytes: i.bytes })), tokensIn: 0, tokensOut: 0, costUsd: 0, model: null, createdAt: new Date().toISOString() }]);
    try {
      const r = await api.sendAssistant(content, imgs.map(({ mediaType, data, name }) => ({ mediaType, data, name })));
      setMsgs(m => [...m.filter(x => x.id !== 'tmp'), r.user, r.assistant]); setInfo(r.info); onInfo?.(r.info);
      if (r.assistant.actions.some(a => a.status === 'done' && (a.type === 'create_company' || a.type === 'create_project'))) await refreshStructure();
      const done = r.assistant.actions.filter(a => a.status === 'done' && a.type !== 'info').length; const pend = r.assistant.actions.filter(a => a.status === 'pending').length;
      if (done || pend) flash([done ? `${done} acción(es) realizadas` : '', pend ? `${pend} propuesta(s) esperan tu autorización` : ''].filter(Boolean).join(' · '));
    } catch (e: any) { setError(e.message); setMsgs(m => m.filter(x => x.id !== 'tmp')); setText(t); setImages(imgs); }
    finally { setBusy(false); }
  };
  const replaceMsg = (m: AssistantMessage) => setMsgs(list => list.map(x => x.id === m.id ? m : x));
  const clear = async () => { if (!confirm('¿Borrar la conversación?')) return; await api.clearAssistant(); setMsgs([]); };

  return (
    <section className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {error && <div style={{ padding: '10px 12px 0' }}><Notice kind="err">{error}</Notice></div>}
      <div style={{ flex: 1, overflow: 'auto', padding: compact ? 12 : 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {msgs.length === 0 && <div className="notice notice-info" style={{ alignSelf: 'flex-start', maxWidth: 760 }}>{Icon.info()}<div>
          Pídeme cosas en lenguaje natural. Puedo <strong>encargar tareas al agente responsable</strong> (revisar y replantear el backlog, proponer la organización de una empresa, evaluar una idea…): él valida la petición, consulta a su equipo y entrega el resultado con propuestas. También <strong>añado historias al backlog</strong> (incluido el propio Portal: así se modifica su código), <strong>propongo ejecutarlas</strong>, <strong>aplico los cambios</strong> aprobados, <strong>creo proyectos y empresas</strong> y respondo sobre el estado real. Todo lo que consume IA o escribe en git aparece como una tarjeta que <strong>tú autorizas aquí mismo</strong>. También puedes adjuntar o pegar capturas de pantalla.
          {!compact && <div className="small muted" style={{ marginTop: 6 }}>Ejemplos: «añade una historia para que el chat soporte adjuntar imágenes y ejecútala» · «ejecuta la siguiente historia pendiente del portal» · «crea la empresa Panadería Luna con un proyecto Tienda en línea» · «¿qué historias quedan por revisar?»</div>}
        </div></div>}
        {msgs.map(m => <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 6 }}>
          <div style={{ maxWidth: 760, padding: '10px 14px', borderRadius: 12, background: m.role === 'user' ? '#1A1B1E' : '#FAF9F6', color: m.role === 'user' ? '#fff' : '#1A1B1E', border: m.role === 'user' ? 0 : '1px solid #E5E3DC' }}>
            {m.role === 'user' ? <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span> : <Markdown text={m.content} />}
            {m.attachments?.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>{m.attachments.map((at, i) => <span key={i} className="chip chip-xs" style={{ background: 'rgba(255,255,255,.12)', color: '#fff', border: 0 }}>🖼 {at.name} · {Math.round(at.bytes / 1024)} KB</span>)}</div>}
          </div>
          {m.actions.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 760 }}>
            {m.actions.map((a, i) => a.status === 'pending' && (a.type === 'propose_execution' || a.type === 'propose_apply' || a.type === 'propose_delegation')
              ? <ProposalCard key={`${m.id}-${i}`} msgId={m.id} action={a} onResolved={replaceMsg} />
              : <ActionRow key={`${m.id}-${i}`} a={a} />)}
          </div>}
          {m.role === 'assistant' && m.costUsd > 0 && <span className="small mono muted">{m.tokensIn + m.tokensOut} tokens · {fmtUsd(m.costUsd)}</span>}
        </div>)}
        {busy && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} className="muted sm13"><span className="spin" /> El asistente está pensando…</div>}
        <div ref={endRef} />
      </div>
      <form style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: compact ? 10 : 12, borderTop: '1px solid #EEECE6' }} onSubmit={e => { e.preventDefault(); void send(); }}>
        {images.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {images.map((im, i) => <div key={i} style={{ position: 'relative', width: 72, height: 72, borderRadius: 8, overflow: 'hidden', border: '1px solid #E5E3DC', background: '#FAF9F6' }}>
            <img src={im.preview} alt={im.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            <button type="button" className="xbtn" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label={`Quitar ${im.name}`} style={{ position: 'absolute', top: 2, right: 2, background: '#fff', borderRadius: 999, width: 22, height: 22, display: 'grid', placeItems: 'center' }}>{Icon.x(12)}</button>
          </div>)}
          <span className="small muted" style={{ alignSelf: 'center' }}>{images.length}/{MAX_IMAGES} · las imágenes se envían al modelo del asistente (aumentan el costo del mensaje)</span>
        </div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <input ref={fileRef} type="file" accept={ACCEPTED.join(',')} multiple hidden onChange={onPick} />
          <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy || images.length >= MAX_IMAGES} title="Adjuntar imagen (también puedes pegarla con Ctrl+V)" aria-label="Adjuntar imagen">📎</button>
          <textarea className="input" value={text} onChange={e => setText(e.target.value)} onPaste={onPaste} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder={compact ? 'Pídele algo al asistente…' : 'Escribe tu petición o pega una captura… (Enter envía · Shift+Enter salto de línea)'} aria-label="Mensaje para el asistente" style={{ minHeight: 48, height: 48, flex: 1 }} disabled={busy} />
          <button className="btn btn-primary" type="submit" disabled={busy || (!text.trim() && !images.length)}>{Icon.arrow()}{compact ? '' : 'Enviar'}</button>
        </div>
        {compact && info && <div className="small muted" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>≈ {fmtUsd(info.estimatedPerMessageUsd)} por mensaje · mes {fmtUsd(info.spentThisMonthUsd)} de {fmtUsd(info.monthlyLimitUsd)}</span><button type="button" className="lnk" onClick={clear}>limpiar</button></div>}
      </form>
    </section>
  );
}

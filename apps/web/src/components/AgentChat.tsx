import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { HARNESSES } from '@portal-ia/domain';
import { Chip, Icon, Notice, Spinner } from './ui.tsx';
import { Markdown } from './Markdown.tsx';
import { useApp } from '../lib/store.ts';
import { useLive } from '../lib/live.ts';
import { fmtUsd } from '../lib/labels.ts';
import { osApi, type AgentAction, type AgentMessage, type AgentPanel as Panel, type AttachmentKind, type ChatAttachment } from '../lib/osApi.ts';

/**
 * Chat con cualquier agente: mensajes, adjuntos (capturas, PDF, ZIP, texto) y acciones que propone el agente.
 * Los adjuntos se suben al registro del Portal (no son rutas del disco) y antes de enviar se dice qué recibirá el modelo de cada uno.
 */
const MAX_FILES = 10;
const KIND_OF = (name: string): AttachmentKind | null => /\.(png|jpe?g|gif|webp)$/i.test(name) ? 'image' : /\.pdf$/i.test(name) ? 'pdf' : /\.zip$/i.test(name) ? 'zip' : /\.(txt|md|csv|json|log)$/i.test(name) ? 'text' : null;
const KIND_TEXT: Record<AttachmentKind, string> = { image: 'Imagen', pdf: 'PDF', zip: 'ZIP', text: 'Texto' };
const DEFAULT_LIMITS: Record<AttachmentKind, number> = { image: 3.5 * 1048576, pdf: 100 * 1048576, zip: 1024 * 1048576, text: 1048576 };
const IMAGE_TOKENS = 1600; // lo mismo que estima el servidor por imagen
export const fmtBytes = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
/** Si su arnés envía de verdad las imágenes: lo dice el servidor (un agente sin arnés fijado usa la API, que sí las envía). */
const sendsImages = (p: Panel) => p.chat.estimate.imagesToModel ?? HARNESSES.find(h => h.id === (p.agent.config.backend ?? 'api'))?.capabilities.images.level === 'yes';
/** Qué recibe el modelo de cada tipo de adjunto (lo mismo que hace el servidor en agentAttachments.modelContext). */
const RECEIVES = (kind: AttachmentKind, images: boolean) => kind === 'image' ? (images ? 'verá la imagen' : 'no la verá: su arnés no recibe imágenes (solo el nombre)')
  : kind === 'text' ? 'recibe su texto (hasta 20 000 caracteres), como datos' : 'solo el nombre y datos básicos; su contenido no se envía';
const HOW_TEXT: Record<string, string> = { image: 'recibió la imagen', metadata: 'recibió solo el nombre y datos básicos', text: 'recibió el texto', not_sent: 'no la recibió (su arnés no admite imágenes)' };
const LIMITS_TEXT = (l: Record<AttachmentKind, number>) => `Capturas hasta ${fmtBytes(l.image)}, PDF hasta ${fmtBytes(l.pdf)}, ZIP hasta ${fmtBytes(l.zip)} o texto; ${MAX_FILES} por mensaje.`;

interface Draft { key: string; name: string; size: number; kind: AttachmentKind; preview: string | null; progress: number; state: 'uploading' | 'ready' | 'error'; att: ChatAttachment | null; error: string | null; abort?: AbortController }

export function ChatTab({ slug, p, projects, onChanged }: { slug: string; p: Panel; projects: { id: string; name: string }[]; onChanged: () => void }) {
  const { flash, status } = useApp();
  const id = p.agent.id;
  const [msgs, setMsgs] = useState<AgentMessage[] | null>(null);
  const [text, setText] = useState(() => { const k = `portal-ia.chat.prefill.${id}`; const v = sessionStorage.getItem(k) ?? ''; sessionStorage.removeItem(k); return v; });
  const [billOk, setBillOk] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [fb, setFb] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]); const [limits, setLimits] = useState(DEFAULT_LIMITS); const [dragging, setDragging] = useState(false);
  const [said, setSaid] = useState(''); // anuncios para lectores de pantalla (subidas terminadas o fallidas)
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const fileRef = useRef<HTMLInputElement>(null); const attachBtn = useRef<HTMLButtonElement>(null); const depth = useRef(0);
  const projectId = p.agent.scope === 'project' ? p.agent.projectId : status.project?.id ?? projects[0]?.id ?? null;
  const load = useCallback(() => osApi.chat(slug, id).then(r => setMsgs(r.messages)).catch(e => setError(e.message)), [slug, id]);
  useEffect(() => { void load(); }, [load]);
  // Lo que subiste y no llegaste a enviar (p. ej. antes de recargar la página) vuelve a la caja de mensaje: no se pierde ni se envía solo.
  useEffect(() => {
    void osApi.attachments(slug, id).then(r => {
      setLimits({ ...DEFAULT_LIMITS, ...r.limits });
      const unsent = r.attachments.filter(a => a.status === 'uploaded').reverse();
      if (unsent.length) setDrafts(d => [...unsent.filter(a => !d.some(x => x.att?.id === a.id)).map(a => ({ key: a.id, name: a.name, size: a.size, kind: a.kind, preview: a.kind === 'image' ? osApi.attachmentUrl(slug, id, a.id) : null, progress: 1, state: 'ready' as const, att: a, error: null })), ...d].slice(0, MAX_FILES));
    }).catch(() => { /* sin la lista se usan los límites por defecto */ });
  }, [slug, id]);
  useEffect(() => () => { for (const d of draftsRef.current) { d.abort?.abort(); if (d.preview?.startsWith('blob:')) URL.revokeObjectURL(d.preview); } }, []);
  useLive(c => c.ws === slug && c.entity === 'agent_chat' && c.id === id, () => void load(), { minMs: 300 });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs?.length]);
  const pending = msgs?.some(m => m.status === 'running');
  const consoleOnly = p.agent.config.backend === 'claude-code-terminal';
  const images = sendsImages(p);
  const ready = drafts.filter(d => d.state === 'ready' && d.att);
  const uploading = drafts.some(d => d.state === 'uploading');
  const canSend = !busy && !pending && !uploading && (text.trim().length >= 2 || ready.length > 0) && !p.retired && !consoleOnly && (!p.chat.estimate.billable || billOk);
  const lastReply = msgs?.filter(m => m.role === 'agent' && m.status !== 'running').slice(-1)[0];
  // Con la API: lo que añaden los adjuntos al costo (texto ≈ 4 caracteres por token; imágenes, lo que estima el servidor).
  const extraUsd = p.chat.estimate.billable && p.chat.estimate.inputUsdPerMTok ? ready.reduce((t, d) => t + (d.kind === 'text' ? Math.min(d.size, 20_000) / 4 : d.kind === 'image' && images ? IMAGE_TOKENS : 60), 0) * p.chat.estimate.inputUsdPerMTok / 1_000_000 : 0;

  const patch = (key: string, x: Partial<Draft>) => setDrafts(ds => ds.map(d => d.key === key ? { ...d, ...x } : d));
  const addFiles = (files: File[]) => {
    if (!files.length) return;
    if (p.retired || consoleOnly) { setError('Este agente no puede recibir adjuntos ahora.'); return; }
    setError(null);
    const room = MAX_FILES - draftsRef.current.length; const notes: string[] = [];
    if (files.length > room) notes.push(`Máximo ${MAX_FILES} adjuntos por mensaje: no se añadieron ${files.slice(Math.max(0, room)).map(f => `«${f.name}»`).join(', ')}.`);
    for (const f of files.slice(0, Math.max(0, room))) {
      const kind = KIND_OF(f.name);
      if (!kind) { notes.push(`«${f.name}»: tipo no admitido (imágenes PNG/JPG/GIF/WEBP, PDF, ZIP o texto).`); continue; }
      if (f.size > limits[kind]) { notes.push(`«${f.name}» pesa ${fmtBytes(f.size)}: el máximo para ${KIND_TEXT[kind].toLowerCase()} es ${fmtBytes(limits[kind])}.`); continue; }
      if (f.size === 0) { notes.push(`«${f.name}» está vacío.`); continue; }
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`; const abort = new AbortController();
      const d: Draft = { key, name: f.name, size: f.size, kind, preview: kind === 'image' ? URL.createObjectURL(f) : null, progress: 0, state: 'uploading', att: null, error: null, abort };
      setDrafts(ds => [...ds, d]);
      void osApi.uploadAttachment(slug, id, f, projectId, fr => patch(key, { progress: fr }), abort.signal).then(att => {
        // Si lo quitaste mientras se subía, se borra al terminar (nunca queda enviado sin querer).
        if (!draftsRef.current.some(x => x.key === key)) { void osApi.deleteAttachment(slug, id, att.id).catch(() => undefined); return; }
        patch(key, { state: 'ready', att, progress: 1, name: att.name, abort: undefined }); setSaid(`«${att.name}» listo para enviar.`);
      }).catch((e: any) => { if (e?.body?.code === 'aborted') return; patch(key, { state: 'error', error: e.message, abort: undefined }); setSaid(`No se pudo subir «${f.name}»: ${e.message}`); });
    }
    if (notes.length) setError(notes.join(' '));
  };
  const remove = (d: Draft) => {
    const i = drafts.findIndex(x => x.key === d.key);
    setDrafts(ds => ds.filter(x => x.key !== d.key));
    d.abort?.abort();
    if (d.preview?.startsWith('blob:')) URL.revokeObjectURL(d.preview);
    if (d.att) void osApi.deleteAttachment(slug, id, d.att.id).catch((e: any) => setError(`No se pudo quitar «${d.name}»: ${e.message}`));
    setSaid(`«${d.name}» quitado.`);
    // El foco va a la ficha siguiente (o a «Adjuntar» si era la última): nunca se pierde.
    requestAnimationFrame(() => { const btns = document.querySelectorAll<HTMLButtonElement>('.att-drafts .xbtn'); (btns[Math.min(i, btns.length - 1)] ?? attachBtn.current)?.focus(); });
  };
  const send = async () => {
    if (!canSend) return;
    setBusy(true); setError(null);
    try {
      await osApi.sendChat(slug, id, text.trim(), projectId, p.chat.estimate.billable ? billOk : undefined, ready.map(d => d.att!.id));
      for (const d of ready) if (d.preview?.startsWith('blob:')) URL.revokeObjectURL(d.preview);
      setText(''); setBillOk(false); setDrafts(ds => ds.filter(d => d.state !== 'ready')); await load(); onChanged();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const canAttach = !p.retired && !consoleOnly && drafts.length < MAX_FILES;
  // Arrastrar: un contador de entradas/salidas (salir de un elemento hijo no quita el aviso; soltar o salir del todo, sí).
  const dragOn = (e: DragEvent) => { if (!canAttach || !e.dataTransfer.types.includes('Files')) return; e.preventDefault(); depth.current++; setDragging(true); };
  const dragOff = () => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); };
  const onDrop = (e: DragEvent) => { e.preventDefault(); depth.current = 0; setDragging(false); addFiles(Array.from(e.dataTransfer.files)); };
  // Pegar: una captura se adjunta; si también hay texto (Word, Excel), se pega el texto.
  const onPaste = (e: ClipboardEvent) => {
    const fs = Array.from(e.clipboardData.files); if (!fs.length || e.clipboardData.getData('text/plain').trim()) return;
    e.preventDefault(); addFiles(fs.map((f, i) => f.name && f.name !== 'image.png' ? f : new File([f], `captura-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}${i ? `-${i}` : ''}.png`, { type: f.type })));
  };
  return <div className="chat-drop" onDragEnter={dragOn} onDragOver={e => { if (canAttach && e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDragLeave={dragOff} onDrop={onDrop}>
    {dragging && <div className="chat-drop-hint" aria-hidden="true">Suelta aquí para adjuntar. {LIMITS_TEXT(limits)}</div>}
    <div className="agent-panel-body">
      {p.retired && <Notice kind="warn">Agente retirado: reactívalo desde Oficina › Organización para conversar.</Notice>}
      {consoleOnly && <Notice kind="info">{p.agent.config.name} trabaja desde tu propia consola de Claude Code, así que no puede conversar aquí. Dale trabajo en la pestaña <strong>Trabajo</strong>, o cambia con qué IA trabaja en <strong>Configuración</strong>.</Notice>}
      <div className="sr" role="status" aria-live="polite">{lastReply ? `${p.agent.config.name} respondió.` : ''}</div>
      <div className="chat-log">
        {msgs === null ? <Spinner /> : msgs.length === 0 ? <p className="small muted">Aún no habéis hablado. Pregúntale lo que quieras sobre su especialidad, adjunta capturas o documentos, o dile qué debería mejorar. Para un trabajo con entregable, usa la pestaña Trabajo.</p>
          : msgs.map(m => <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'owner' ? 'flex-end' : 'flex-start' }}>
            {(m.content || m.role === 'agent') && <div className={`msg msg-${m.role}`}>{m.role === 'agent' && m.status === 'running' ? <span className="small">Pensando…</span> : m.role === 'agent' && m.content ? <Markdown text={m.content} /> : m.content}</div>}
            {!!m.attachments?.length && <MessageAttachments slug={slug} agentId={id} m={m} />}
            {!!m.actions?.length && <div className="chat-actions">{m.actions.map(a => <ActionCard key={a.id} slug={slug} agentId={id} a={a} external={!!p.external} onDone={() => { void load(); onChanged(); }} />)}</div>}
            {m.role === 'agent' && <div className="msg-meta">
              {m.status === 'failed' && <span style={{ color: 'var(--color-err-text)' }}>{m.error}</span>}
              {m.status === 'interrupted' && <span>{m.error}</span>}
              {m.status === 'done' && <><span>{m.harness === 'api' ? fmtUsd(m.costUsd) : 'con tu suscripción'}</span>
                <button type="button" className="lnk" onClick={() => setFb(fb === m.id ? null : m.id)}>¿Qué debería aprender?</button></>}
            </div>}
            {fb === m.id && <FeedbackForm slug={slug} agentId={id} messageId={m.id} onDone={() => { setFb(null); flash('Aprendizaje propuesto: verifícalo en Memoria'); onChanged(); }} />}
          </div>)}
        <div ref={end} />
      </div>
    </div>
    <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}>
      {error && <Notice kind="err">{error}</Notice>}
      <div className="sr" role="status" aria-live="polite">{said}</div>
      {drafts.length > 0 && <ul className="att-drafts" aria-label="Adjuntos de este mensaje">
        {drafts.map(d => <li key={d.key} className="att-chip" data-state={d.state}>
          {d.preview ? <img src={d.preview} alt="" className="att-thumb" /> : <span className="att-icon" aria-hidden="true">{d.kind === 'zip' ? 'ZIP' : d.kind === 'pdf' ? 'PDF' : 'TXT'}</span>}
          <span className="att-text"><span className="att-name" title={d.name}>{d.name}</span>
            <span className="small muted">{KIND_TEXT[d.kind]} · {fmtBytes(d.size)}{d.att ? attDetail(d.att) : ''} · {d.state === 'uploading' ? (d.progress < 1 ? `subiendo ${Math.round(d.progress * 100)} %` : 'revisando en el servidor…') : d.state === 'error' ? <span style={{ color: 'var(--color-err-text)' }}>{d.error}</span> : 'listo'}</span>
            {d.state === 'uploading' && <progress className="att-progress" value={d.progress} max={1} aria-label={`Subiendo ${d.name}`} />}
            {d.state === 'ready' && <span className="small muted">El modelo: {RECEIVES(d.kind, images)}.</span>}
          </span>
          <button type="button" className="xbtn" onClick={() => remove(d)} aria-label={`Quitar ${d.name}`} title="Quitar">{Icon.x(12)}</button>
        </li>)}
      </ul>}
      <label className="sr" htmlFor="chat-text">Mensaje para {p.agent.config.name}</label>
      <textarea id="chat-text" className="input" rows={3} value={text} onChange={e => setText(e.target.value)} onPaste={onPaste} placeholder={`Escribe a ${p.agent.config.name}… (puedes pegar una captura o arrastrar archivos)`} disabled={p.retired} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
      <input ref={fileRef} type="file" multiple accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.zip,.txt,.md,.csv,.json,.log,image/*,application/pdf,application/zip" style={{ display: 'none' }} onChange={e => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; addFiles(fs); }} aria-hidden="true" tabIndex={-1} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <button ref={attachBtn} type="button" className="btn btn-ghost btn-sm" disabled={!canAttach} onClick={() => fileRef.current?.click()} aria-describedby="chat-att-limits">{Icon.clip()} Adjuntar</button>
          <span id="chat-att-limits" className="sr">{LIMITS_TEXT(limits)}</span>
          <span className="small muted">{p.chat.estimate.label} · {p.chat.estimate.billable ? `≈ ${fmtUsd(p.chat.estimate.estimatedUsd)} por mensaje${extraUsd > 0 ? ` + ≈ ${fmtUsd(extraUsd)} por los adjuntos` : ''}` : 'sin cargo a la API'} · hoy {p.chat.usage.used}/{p.chat.usage.cap}</span>
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {p.chat.estimate.billable && <label className="ck small"><input className="cb" type="checkbox" checked={billOk} onChange={e => setBillOk(e.target.checked)} /> Autorizo esta llamada facturable{ready.some(d => d.kind === 'image') && images ? ' (incluye las imágenes adjuntas)' : ''}</label>}
          <button className="btn btn-primary btn-sm" type="submit" disabled={!canSend}>{busy ? 'Enviando…' : pending ? 'Respondiendo…' : uploading ? 'Subiendo…' : 'Enviar'}</button>
        </div>
      </div>
    </form>
  </div>;
}

const attDetail = (a: ChatAttachment) => {
  const m = a.meta ?? {};
  if (a.kind === 'image' && m.width) return ` · ${m.width}×${m.height}`;
  if (a.kind === 'pdf' && m.pages) return ` · ${m.pages} págs.`;
  if (a.kind === 'zip' && m.files !== undefined) return ` · ${m.pdfs ?? 0} PDF de ${m.files} archivos`;
  return '';
};

function MessageAttachments({ slug, agentId, m }: { slug: string; agentId: string; m: AgentMessage }) {
  const how = new Map((m.sent ?? []).map(s => [s.id, s.how]));
  // «Recibió» solo si la llamada terminó bien; si falló o se interrumpió, no consta.
  const got = (a: ChatAttachment) => { const h = how.get(a.id); if (!h) return ''; if (m.delivered === false) return ' · la llamada falló: no consta que el modelo lo recibiera'; if (m.delivered === null && h !== 'not_sent') return ' · sin confirmar que el modelo lo recibiera'; return ` · el modelo ${HOW_TEXT[h]}`; };
  return <ul className={`att-list att-list-${m.role}`} aria-label="Adjuntos">
    {m.attachments!.map(a => { const url = osApi.attachmentUrl(slug, agentId, a.id); return <li key={a.id} className="att-chip">
      {a.kind === 'image' ? <a href={url} target="_blank" rel="noreferrer" title="Abrir a tamaño completo"><img src={url} alt={`Imagen adjunta: ${a.name}`} className="att-thumb att-thumb-lg" loading="lazy" /></a>
        : <span className="att-icon" aria-hidden="true">{a.kind === 'zip' ? 'ZIP' : a.kind === 'pdf' ? 'PDF' : 'TXT'}</span>}
      <span className="att-text">
        <a className="att-name" href={url} {...(a.kind === 'image' ? { target: '_blank', rel: 'noreferrer' } : { download: a.name })} title={a.name}>{a.name}</a>
        <span className="small muted">{KIND_TEXT[a.kind]} · {fmtBytes(a.size)}{attDetail(a)}{got(a)}</span>
      </span>
    </li>; })}
  </ul>;
}

const ACTION_TITLE: Record<AgentAction['kind'], string> = {
  mejorar_agente: 'Mejora de su forma de trabajar', mejorar_portal: 'Mejora del Portal (historia de desarrollo)', procesar_documentos: 'Procesar documentos adjuntos', corregir_documento: 'Nueva versión de un documento'
};
const ACTION_STATUS: Record<AgentAction['status'], { text: string; tone: '' | 'ok' | 'warn' | 'err' | 'accent' }> = {
  proposed: { text: 'Espera tu confirmación', tone: 'warn' }, running: { text: 'En curso…', tone: 'accent' }, done: { text: 'Hecho', tone: 'ok' }, failed: { text: 'Falló', tone: 'err' }, dismissed: { text: 'Descartada', tone: '' }
};
const PROPOSAL_STATE: Record<string, string> = { proposed: 'propuesta: revísala y apruébala en Mejoras', approved: 'aprobada', applied: 'aplicada', rejected: 'rechazada', failed: 'no se pudo aplicar' };

/** Una acción que el agente pidió al Portal desde la conversación: qué es, quién la hace, qué cuesta, su estado y adónde ir. */
function ActionCard({ slug, agentId, a, external, onDone }: { slug: string; agentId: string; a: AgentAction; external: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const st = ACTION_STATUS[a.status]; const r = a.result ?? {};
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); onDone(); } catch (e: any) { setError(e.message); } finally { setBusy(false); requestAnimationFrame(() => box.current?.focus()); } };
  const lotes = Number(a.payload.lotes) || 1; const pdfs = Number(a.payload.pdfs) || null;
  const what = a.kind === 'procesar_documentos' ? `Convertirá ${pdfs ? `${pdfs} PDF` : 'los PDF adjuntos'} en ${lotes} lote${lotes > 1 ? 's' : ''} (uno por ZIP y otro con los PDF sueltos): el programa del agente se ejecuta en este equipo, de uno en uno, y usa como máximo ${lotes * 2} consulta${lotes * 2 > 1 ? 's' : ''} a tu suscripción (plan y resumen de cada lote).`
    : a.kind === 'corregir_documento' ? 'Creará una nueva versión del documento con esta corrección (2 consultas a tu suscripción y el programa del agente en este equipo). Las versiones anteriores no se tocan.'
    : a.kind === 'mejorar_agente' ? (external ? 'Preparará una propuesta de cambio de su habilidad o sus instrucciones con tus palabras (una consulta a tu suscripción). Nada cambia hasta que la apruebes en Mejoras.' : 'Propondrá un aprendizaje que verificas en Memoria (sin consultas).')
    : 'Creará una historia en el backlog del Portal con tus palabras y la evidencia; la investiga y la hace el equipo de desarrollo del Portal con su propio proceso y tu aprobación. Este agente no toca el código del Portal.';
  const linkText = a.kind === 'mejorar_portal' ? 'Ver en el backlog' : a.kind === 'mejorar_agente' ? (a.link?.endsWith('/memoria') ? 'Ver en Memoria' : 'Revisar en Mejoras') : 'Ver en Documentos';
  return <div ref={box} tabIndex={-1} className="card action-card" role="group" aria-label={ACTION_TITLE[a.kind]}>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><strong className="small">{ACTION_TITLE[a.kind]}</strong><Chip xs tone={st.tone}>{st.text}</Chip>
      {a.kind === 'mejorar_portal' && <Chip xs>la hace el equipo de desarrollo del Portal, no este agente</Chip>}{a.payload.reasignada && <Chip xs>reasignada por ti</Chip>}</div>
    {(a.payload.titulo || a.payload.descripcion) && <div className="small">{a.payload.titulo && <strong>{a.payload.titulo}. </strong>}{a.payload.descripcion} <span className="muted">(resumen del agente)</span></div>}
    {a.kind === 'procesar_documentos' && !!a.payload.nombres?.length && <div className="small">Adjuntos: {a.payload.nombres.map((n: string) => `«${n}»`).join(', ')}</div>}
    {a.kind === 'corregir_documento' && a.payload.correccion && <div className="small">{a.payload.documento && <>Documento «{a.payload.documento}». </>}<strong>Corrección:</strong> {a.payload.correccion}</div>}
    {error && <Notice kind="err">{error}</Notice>}
    {a.error && <Notice kind="err">{a.error}</Notice>}
    {a.status === 'proposed' && <>
      <span className="small muted" role="note">{what}</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(() => osApi.confirmAction(slug, agentId, a.id))}>{busy ? 'Un momento…' : 'Sí, hazlo'}</button>
        {(a.kind === 'mejorar_agente' || a.kind === 'mejorar_portal') && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(() => osApi.rerouteAction(slug, agentId, a.id))}>{a.kind === 'mejorar_agente' ? 'Es del Portal, no del agente' : 'Es del agente, no del Portal'}</button>}
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => osApi.dismissAction(slug, agentId, a.id))}>Descartar</button>
      </div>
    </>}
    {a.status !== 'proposed' && (r.summary || r.proposalState || r.storyStatus || r.batchStatus || r.jobStatus) && <div className="small">
      {r.summary && <span>{r.summary} </span>}
      {r.proposalState && <span className="muted">Propuesta {PROPOSAL_STATE[r.proposalState] ?? r.proposalState}. </span>}
      {r.storyId && <span className="muted">Historia {r.storyId}{r.storyStatus ? ` (${r.storyStatus})` : ''}{r.projectName ? ` en «${r.projectName}»` : ''}. </span>}
      {r.counts && <span className="muted">Lote: {r.counts.passed} listos de {r.counts.accepted + r.counts.duplicates}{r.counts.failed ? `, ${r.counts.failed} fallaron` : ''}{r.counts.rejectedQa ? `, ${r.counts.rejectedQa} no pasaron las comprobaciones` : ''}. </span>}
      {r.jobStatus && <span className="muted">Documento: {r.jobStatus}. </span>}
    </div>}
    {a.kind === 'mejorar_agente' && a.status === 'done' && r.proposalId && <span className="small muted">Nada cambia hasta que apruebes la propuesta.</span>}
    {a.link && (a.status === 'done' || a.status === 'failed') && <Link className="small" to={a.link}>{linkText} →</Link>}
  </div>;
}

export function FeedbackForm({ slug, agentId, processId, messageId, onDone }: { slug: string; agentId: string; processId?: string; messageId?: string; onDone: () => void }) {
  const [rating, setRating] = useState<'useful' | 'needs_changes'>('needs_changes');
  const [feedback, setFeedback] = useState(''); const [lesson, setLesson] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const submit = async () => { setBusy(true); setError(null); try { await osApi.feedback(slug, agentId, { processId: processId ?? null, messageId: messageId ?? null, rating, feedback: feedback.trim(), lesson: lesson.trim() || null }); onDone(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return <div className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
    {error && <Notice kind="err">{error}</Notice>}
    <div className="seg" role="group" aria-label="Valoración"><button type="button" aria-pressed={rating === 'useful'} onClick={() => setRating('useful')}>Útil</button><button type="button" aria-pressed={rating === 'needs_changes'} onClick={() => setRating('needs_changes')}>Necesita cambios</button></div>
    <textarea className="input" rows={2} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Tu opinión (qué estuvo bien o qué faltó)" aria-label="Tu opinión" />
    <textarea className="input" rows={2} value={lesson} onChange={e => setLesson(e.target.value)} placeholder="Lo que debería aprender para la próxima vez (opcional: si no, se usa tu opinión)" aria-label="Lo que debería aprender" />
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><span className="small muted" style={{ marginRight: 'auto' }}>Queda como propuesta: solo cuenta cuando la verifiques en Memoria.</span><button className="btn btn-primary btn-sm" disabled={busy || feedback.trim().length < 3} onClick={() => void submit()}>Proponer aprendizaje</button></div>
  </div>;
}

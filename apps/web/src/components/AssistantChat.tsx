import { OperationCard } from './OperationCard.tsx';
import React, { useEffect, useRef, useState, type ClipboardEvent, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { DEFAULT_PIPELINE } from '@portal-ia/domain';
import type { PendingDecision, Process, StoryDecisionHistory, SupersededDecision } from '@portal-ia/domain';
import type { AssistantConversation } from '@portal-ia/domain';
import { api, type AssistantAction, type AssistantImage, type AssistantInfo, type AssistantMessage, type ConversationDetailView } from '../lib/api.ts';
import { AssignmentCard, CardBoundary, ConversationBar, ConversationPanel, LocalChangeCard, UsageBanner } from './ConversationPanel.tsx';
import { PendingDecisionCard } from './PendingDecisionCard.tsx';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Chip, Icon, KV, Notice } from './ui.tsx';
import { Markdown } from './Markdown.tsx';

const MAX_IMAGES = 4;
const MAX_FILES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 120_000;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|log|yaml|yml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|sql|sh|ps1|ini|toml|env\.example)$/i;
const ACCEPT_ATTR = [...ACCEPTED, '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.sql', '.sh', '.ini', '.toml'].join(',');

type Pending = (AssistantImage & { kind: 'image'; preview: string; bytes: number }) | { kind: 'text'; name: string; text: string; bytes: number; mediaType: string };
const isTextFile = (f: File) => f.type.startsWith('text/') || f.type === 'application/json' || TEXT_EXT.test(f.name);
function readText(f: File): Promise<string> { return new Promise((resolve, reject) => { const r = new FileReader(); r.onerror = () => reject(new Error(`No se pudo leer ${f.name}`)); r.onload = () => resolve(String(r.result)); r.readAsText(f); }); }

function fileToPending(f: File): Promise<Pending> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`No se pudo leer ${f.name}`));
    r.onload = () => { const url = String(r.result); resolve({ kind: 'image', mediaType: f.type, data: url.slice(url.indexOf(',') + 1), name: f.name || 'imagen', preview: url, bytes: f.size }); };
    r.readAsDataURL(f);
  });
}

/** HU-161 · propuesta del chat que espera autorización (candidata a consolidarse con la bandeja). */
const isProposal = (a: AssistantAction) => a.status === 'pending' && (a.type === 'propose_execution' || a.type === 'propose_apply' || a.type === 'propose_delegation');

/** HU-161 · propuesta de una iteración anterior: ya no es la vigente de su historia. */
type SupersededInfo = { decision: SupersededDecision | null; byIteration: number | null; at: string | null; storyId: string | null };

/** Tarjeta de una propuesta superada: sin aprobar ni ejecutar; solo informa y permite restaurarla (sin costo). */
function SupersededProposalCard({ action, info, onRestore }: { action: AssistantAction; info: SupersededInfo; onRestore: (d: PendingDecision) => Promise<void> }) {
  if (info.decision) return <PendingDecisionCard as="div" decision={info.decision} superseded={{ byIteration: info.byIteration, at: info.at }} onRestore={onRestore} />;
  const label = `Superada por la iteración ${info.byIteration ?? 'más reciente'}`;
  return <div className="notice notice-info" role="status">{Icon.info()}<div>
    <strong>{action.label}</strong> · <strong>{label}.</strong> Ya no se puede autorizar desde aquí: decide sobre la autorización vigente en la bandeja.
    {info.storyId && <> <Link className="lnk" to={`/historias/${info.storyId}#iteraciones`}>ver historial</Link></>}
  </div></div>;
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
        const p = await api.authorizeProcess(action.workspaceSlug, action.processId, Number(budget), action.type === 'propose_execution' ? DEFAULT_PIPELINE : undefined);
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
          <div className="help" style={{ paddingBottom: 6 }}>Estimado ≈ {fmtUsd(action.estimatedUsd ?? 0)}. El proceso se detiene entre pasos si se acerca al límite.{action.type === 'propose_execution' && ' Incluye aplicar en un worktree aislado, verificar en el sandbox y la validación de QA con evidencia (con hasta 2 correcciones). Nunca integra ni publica.'}</div>
        </div>}
        <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>{isExec
          ? (isDeleg
            ? <>Autorizo este <strong>encargo</strong> al agente responsable y a los agentes a su cargo, hasta <strong>{fmtUsd(Number(budget) || 0)}</strong>. El resultado quedará en Conocimiento; los cambios al backlog que proponga los aplicaré yo desde el proceso.</>
            : <>Autorizo que el equipo del proyecto trabaje en <strong>{action.storyId}</strong> hasta <strong>{fmtUsd(Number(budget) || 0)}</strong> de API: aplica los cambios en un <strong>worktree aislado</strong> (rama propia), los verifica en el sandbox y QA los evalúa. No integra en main ni publica: eso lo decides después. Con Claude Code consume tu suscripción en lugar de API.</>)
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
  const live = a.live;
  const tone = live ? (live.tone === 'err' ? 'notice-err' : live.tone === 'warn' ? 'notice-warn' : live.tone === 'ok' ? 'notice-ok' : 'notice-info') : ok ? 'notice-ok' : 'notice-err';
  return <div className={`notice ${tone}`} style={{ padding: '8px 12px' }}>{live ? (live.tone === 'err' ? Icon.alert() : live.tone === 'ok' ? Icon.okc() : live.tone === 'warn' ? Icon.warn() : Icon.info()) : ok ? Icon.okc() : Icon.alert()}<div>
    <strong>{a.label}</strong>
    {live ? <div style={{ marginTop: 2 }}><span style={{ fontWeight: 600 }}>{live.phase}.</span> {live.next}{a.link && <> <Link className="lnk" to={a.link}>{live.settled ? 'ver' : 'ir al proceso'}</Link></>}</div> : <>{a.detail && <> — {a.detail}</>}{a.link && ok && <> · <Link className="lnk" to={a.link}>abrir</Link></>}</>}
  </div></div>;
}

/** Conversación con el Asistente de Empresa (compartida por la pantalla Asistente y el dock flotante). */
export function AssistantChat({ compact = false, onInfo, onPending, initialText }: { compact?: boolean; onInfo?: (i: AssistantInfo) => void; onPending?: (n: number) => void; initialText?: string }) {
  const { flash, refreshStructure } = useApp();
  const [info, setInfo] = useState<AssistantInfo | null>(null);
  const [msgs, setMsgs] = useState<AssistantMessage[]>([]);
  const [text, setText] = useState(initialText ?? '');
  const [images, setImages] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Conversación actual (sobrevive a recargar: la última elegida; si ya no existe, la activa más reciente).
  const [convId, setConvId] = useState<string | null>(() => { try { return localStorage.getItem('portal-ia.conversation'); } catch { return null; } });
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [detail, setDetail] = useState<ConversationDetailView | null>(null);
  useEffect(() => { try { if (convId) localStorage.setItem('portal-ia.conversation', convId); else localStorage.removeItem('portal-ia.conversation'); } catch { /* sin almacenamiento */ } }, [convId]);
  const load = async (id: string | null = convId) => {
    const r = await api.assistant(id).catch(e => { if (id && e?.status === 404) return api.assistant(null); throw e; });
    setInfo(r.info); onInfo?.(r.info); setMsgs(r.messages); setConversations(r.conversations); setConvId(r.conversationId); setDetail(r.detail);
  };

  useEffect(() => { load().catch(e => setError(e.message)); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs.length, busy]);
  const unsettled = msgs.some(m => m.actions.some(a => a.live && !a.live.settled)) || !!detail?.artifacts.some(a => a.status === 'running');
  useEffect(() => { if (!unsettled) return; const t = setInterval(() => { load().catch(() => null); }, 10_000); return () => clearInterval(t); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsettled, convId]);
  // HU-161 · consolidación con la bandeja: una sola autorización vigente por historia.
  const [superseded, setSuperseded] = useState<Record<string, SupersededInfo>>({});
  const [decTick, setDecTick] = useState(0);
  const proposalKey = msgs.flatMap(m => m.actions).filter(a => isProposal(a) && a.processId && a.workspaceSlug).map(a => `${a.workspaceSlug}\t${a.processId}`).join('\n');
  useEffect(() => {
    if (!proposalKey) { setSuperseded({}); return; }
    let cancelled = false;
    void (async () => {
      const bySlug = new Map<string, Set<string>>();
      for (const line of proposalKey.split('\n')) {
        const [slug, pid] = line.split('\t');
        if (!slug || !pid) continue;
        if (!bySlug.has(slug)) bySlug.set(slug, new Set());
        bySlug.get(slug)!.add(pid);
      }
      const next: Record<string, SupersededInfo> = {};
      for (const [slug, ids] of bySlug) {
        let current: Set<string>;
        try { current = new Set((await api.inbox(slug)).map(d => d.processId)); } catch { continue; }
        const histories = new Map<string, StoryDecisionHistory | null>();
        for (const pid of ids) {
          if (current.has(pid)) continue;
          let p: Process;
          try { p = await api.process(slug, pid); } catch { continue; }
          if (!p.supersededBy) continue;
          const story = p.backlogItemId ?? null;
          let h: StoryDecisionHistory | null = null;
          if (story) {
            if (!histories.has(story)) histories.set(story, await api.storyDecisions(slug, story).catch(() => null));
            h = histories.get(story) ?? null;
          }
          const d = h?.superseded.find(s => s.processId === pid) ?? null;
          next[pid] = { decision: d, byIteration: d?.supersededByIteration ?? h?.current?.iteration ?? null, at: d?.supersededAt ?? p.supersededAt ?? null, storyId: story };
        }
      }
      if (!cancelled) setSuperseded(next);
    })();
    return () => { cancelled = true; };
  }, [proposalKey, decTick]);
  const restoreSuperseded = async (d: PendingDecision) => {
    await api.restoreSuperseded(d.workspaceSlug, d.processId);
    setDecTick(t => t + 1);
    flash('Autorización restaurada como vigente · la anterior vigente pasa a superada');
  };
  const pendingCount = msgs.reduce((n, m) => n + m.actions.filter(a => a.status === 'pending' && !(a.processId && superseded[a.processId])).length, 0);
  useEffect(() => { onPending?.(pendingCount); }, [pendingCount, onPending]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const errs: string[] = []; const next = [...images];
    for (const f of list) {
      if (f.type.startsWith('image/')) {
        if (next.filter(x => x.kind === 'image').length >= MAX_IMAGES) { errs.push(`Máximo ${MAX_IMAGES} imágenes por mensaje.`); continue; }
        if (!ACCEPTED.includes(f.type)) { errs.push(`${f.name}: formato de imagen no soportado (PNG, JPEG, WebP o GIF).`); continue; }
        if (f.size > MAX_IMAGE_BYTES) { errs.push(`${f.name}: supera 5 MB.`); continue; }
        try { next.push(await fileToPending(f)); } catch (e: any) { errs.push(e.message); }
      } else if (isTextFile(f)) {
        if (next.filter(x => x.kind === 'text').length >= MAX_FILES) { errs.push(`Máximo ${MAX_FILES} archivos de texto por mensaje.`); continue; }
        try { let text = await readText(f); if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS) + '\n… (recortado a 120 000 caracteres)'; errs.push(`${f.name}: se recortó a 120 000 caracteres.`); } next.push({ kind: 'text', name: f.name, text, bytes: f.size, mediaType: f.type || 'text/plain' }); } catch (e: any) { errs.push(e.message); }
      } else errs.push(`${f.name}: solo se admiten imágenes (PNG, JPEG, WebP, GIF) y archivos de texto (.md, .txt, .json, .csv, código…).`);
    }
    setImages(next);
    if (errs.length) setError(errs.join(' ')); else setError(null);
  };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragging(false); if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files); };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); void addFiles(files); }
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; };

  const send = async () => {
    const t = text.trim(); if ((!t && !images.length) || busy) return;
    const imgs = images.filter((x): x is Extract<Pending, { kind: 'image' }> => x.kind === 'image');
    const texts = images.filter((x): x is Extract<Pending, { kind: 'text' }> => x.kind === 'text');
    const base = t || (imgs.length ? `(${imgs.length} imagen(es) adjunta(s))` : 'Revisa el archivo adjunto.');
    // Los archivos de texto viajan dentro del mensaje, delimitados, para que el modelo los lea íntegros.
    const content = base + texts.map(f => `\n\n--- Adjunto «${f.name}» ---\n${f.text}\n--- Fin de «${f.name}» ---`).join('');
    const all = images;
    setBusy(true); setError(null); setText(''); setImages([]);
    setMsgs(m => [...m, { id: 'tmp', role: 'user', content, actions: [], attachments: all.map(i => ({ name: i.name ?? 'adjunto', mediaType: i.mediaType, bytes: i.bytes })), tokensIn: 0, tokensOut: 0, costUsd: 0, model: null, createdAt: new Date().toISOString() }]);
    try {
      const r = await api.sendAssistant(content, imgs.map(({ mediaType, data, name }) => ({ mediaType, data, name })), texts.map(f => ({ name: f.name, mediaType: f.mediaType, bytes: f.bytes })), convId);
      setMsgs(m => [...m.filter(x => x.id !== 'tmp'), r.user, r.assistant]); setInfo(r.info); onInfo?.(r.info);
      await load(r.conversationId).catch(() => null); // decisiones, etapa y siguiente acción al día
      if (r.assistant.actions.some(a => a.status === 'done' && (a.type === 'create_company' || a.type === 'create_project'))) await refreshStructure();
      const done = r.assistant.actions.filter(a => a.status === 'done' && a.type !== 'info').length; const pend = r.assistant.actions.filter(a => a.status === 'pending').length;
      if (done || pend) flash([done ? `${done} acción(es) realizadas` : '', pend ? `${pend} propuesta(s) esperan tu autorización` : ''].filter(Boolean).join(' · '));
    } catch (e: any) { setError(e.message); setMsgs(m => m.filter(x => x.id !== 'tmp')); setText(t); setImages(all); }
    finally { setBusy(false); }
  };
  const replaceMsg = (m: AssistantMessage) => setMsgs(list => list.map(x => x.id === m.id ? m : x));
  // Archivar no borra nada: mensajes, decisiones y artefactos se conservan y la conversación se puede reactivar.
  const archive = async () => { if (!convId) return; await api.updateConversation(convId, { status: 'archived' }); await load(null); };
  const inMessages = new Set(msgs.flatMap(m => m.actions.map(a => a.assignmentId).filter(Boolean) as string[]));
  const current = conversations.find(c => c.id === convId) ?? null;

  return (
    <section className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: compact ? '8px 12px' : '10px 18px', borderBottom: '1px solid #EEECE6' }}>
        <ConversationBar conversations={conversations} current={current} onSelect={id => { setConvId(id); load(id).catch(e => setError(e.message)); }} onChanged={() => { load().catch(e => setError(e.message)); }} />
      </div>
      <UsageBanner />
      <div className={`assist-cols${compact ? '' : ' assist-wide'}`}>
      {detail && <div className="assist-side"><ConversationPanel detail={{ ...detail, assignments: detail.assignments.filter(x => !inMessages.has(x.id)) }} compact={compact} onChanged={() => { load().catch(e => setError(e.message)); }} /></div>}
      <div className="assist-main">
      {error && <div style={{ padding: '10px 12px 0' }}><Notice kind="err">{error}</Notice></div>}
      <div style={{ flex: 1, overflow: 'auto', padding: compact ? 12 : 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {msgs.length === 0 && <div className="notice notice-info" style={{ alignSelf: 'flex-start', maxWidth: 760 }}>{Icon.info()}<div>
          Pídeme cosas en lenguaje natural. Puedo <strong>investigar una idea contigo</strong> y abrir las decisiones que haya que cerrar (las cierras tú, una a una), preparar la <strong>propuesta</strong> (el equipo la redacta y otro especialista la cuestiona), consultar al equipo y, con tu aprobación, <strong>crear las historias</strong>. Para un cambio concreto propongo un <strong>encargo de desarrollo</strong> sin historia (worktree aislado, sandbox, QA y Gauntlet). También respondo sobre el estado real, propongo ejecutar historias y encargo análisis al agente responsable. Todo lo que consume IA o cambia algo aparece como una tarjeta que <strong>tú autorizas aquí mismo</strong>; nada se hace solo por cómo lo escribas. Elige arriba la empresa y el proyecto de la conversación.
          {!compact && <div className="small muted" style={{ marginTop: 6 }}>Ejemplos: «quiero un modo oscuro, ayúdame a decidir cómo» · «arregla el texto del pie y déjalo listo para revisar» · «¿por qué falló la última historia?» · «¿qué historias quedan por revisar?»</div>}
        </div></div>}
        {msgs.map(m => <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 6 }}>
          <div className="msg-bubble" style={{ padding: '10px 14px', borderRadius: 12, background: m.role === 'user' ? '#1A1B1E' : '#FAF9F6', color: m.role === 'user' ? '#fff' : '#1A1B1E', border: m.role === 'user' ? 0 : '1px solid #E5E3DC' }}>
            {m.role === 'user'
              ? <span style={{ whiteSpace: 'pre-wrap' }}>{m.content.length > 900 && !expanded[m.id] ? m.content.slice(0, 900) + '…' : m.content}{m.content.length > 900 && <> <button type="button" className="lnk" style={{ color: '#9BD5CC' }} onClick={() => setExpanded(x => ({ ...x, [m.id]: !x[m.id] }))}>{expanded[m.id] ? 'ver menos' : `ver todo (${m.content.length.toLocaleString()} caracteres)`}</button></>}</span>
              : <Markdown text={m.content} />}
            {m.attachments?.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>{m.attachments.map((at, i) => <span key={i} className="chip chip-xs" style={{ background: 'rgba(255,255,255,.12)', color: '#fff', border: 0 }}>{at.mediaType.startsWith('image/') ? '🖼' : '📄'} {at.name} · {Math.max(1, Math.round(at.bytes / 1024))} KB</span>)}</div>}
          </div>
          {m.actions.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 760 }}>
            {m.actions.map((a, i) => a.type === 'propose_operation' && a.operation
              ? <OperationCard key={`${m.id}-${i}`} msgId={m.id} action={a} onResolved={replaceMsg} />
              : a.type === 'propose_local' && a.status === 'pending'
              ? <CardBoundary key={`${m.id}-${i}`}><LocalChangeCard msgId={m.id} index={i} action={a} onResolved={replaceMsg} /></CardBoundary>
              : a.type === 'propose_assignment' && a.assignmentId && a.workspaceSlug && a.status !== 'failed'
              ? <CardBoundary key={`${m.id}-${i}`}><AssignmentCard slug={a.workspaceSlug} assignmentId={a.assignmentId} onChanged={() => { load().catch(() => null); }} /></CardBoundary>
              : isProposal(a) && a.processId && superseded[a.processId]
              ? <SupersededProposalCard key={`${m.id}-${i}`} action={a} info={superseded[a.processId]} onRestore={restoreSuperseded} />
              : isProposal(a)
              ? <ProposalCard key={`${m.id}-${i}`} msgId={m.id} action={a} onResolved={replaceMsg} />
              : <ActionRow key={`${m.id}-${i}`} a={a} />)}
          </div>}
          {m.role === 'assistant' && m.costUsd > 0 && <span className="small mono muted">{m.tokensIn + m.tokensOut} tokens · {fmtUsd(m.costUsd)}</span>}
        </div>)}
        {busy && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} className="muted sm13"><span className="spin" /> El asistente está pensando…</div>}
        <div ref={endRef} />
      </div>
      <form style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: compact ? 10 : 12, borderTop: '1px solid #EEECE6', background: dragging ? '#E3F1EF' : undefined }} onSubmit={e => { e.preventDefault(); void send(); }} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        {images.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {images.map((im, i) => im.kind === 'image' ? <div key={i} style={{ position: 'relative', width: 72, height: 72, borderRadius: 8, overflow: 'hidden', border: '1px solid #E5E3DC', background: '#FAF9F6' }}>
            <img src={im.preview} alt={im.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            <button type="button" className="xbtn" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label={`Quitar ${im.name}`} style={{ position: 'absolute', top: 2, right: 2, background: '#fff', borderRadius: 999, width: 22, height: 22, display: 'grid', placeItems: 'center' }}>{Icon.x(12)}</button>
          </div> : <span key={i} className="chip" style={{ height: 'auto', padding: '4px 6px 4px 10px', gap: 8 }}>📄 {im.name} · {im.text.length.toLocaleString()} caracteres<button type="button" className="xbtn" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label={`Quitar ${im.name}`}>{Icon.x(12)}</button></span>)}
          <span className="small muted" style={{ alignSelf: 'center' }}>Los adjuntos se envían al modelo del asistente y aumentan el costo del mensaje.</span>
        </div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <input ref={fileRef} type="file" accept={ACCEPT_ATTR} multiple hidden onChange={onPick} />
          <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy} title="Adjuntar imagen o archivo de texto (también puedes pegar o arrastrar)" aria-label="Adjuntar archivo">📎</button>
          <textarea className="input" value={text} onChange={e => setText(e.target.value)} onPaste={onPaste} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder={compact ? 'Pídele algo al asistente… (arrastra o pega archivos)' : 'Escribe tu petición, pega una captura o arrastra un archivo .md/.txt… (Enter envía · Shift+Enter salto de línea)'} aria-label="Mensaje para el asistente" style={{ minHeight: 48, height: 48, flex: 1 }} disabled={busy} />
          <button className="btn btn-primary" type="submit" disabled={busy || (!text.trim() && !images.length)}>{Icon.arrow()}{compact ? '' : 'Enviar'}</button>
        </div>
        {compact && info && <div className="small muted" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>{info.backendLabel} · {info.billing === 'subscription' ? 'sin cargo a la API' : `≈ ${fmtUsd(info.estimatedPerMessageUsd)} por mensaje · mes ${fmtUsd(info.spentThisMonthUsd)} de ${fmtUsd(info.monthlyLimitUsd)}`}{!info.available && info.unavailableReason ? ` · ⚠ ${info.unavailableReason}` : ''}</span>{convId && <button type="button" className="lnk" onClick={() => void archive()} title="Se conserva todo; puedes reactivarla">archivar</button>}</div>}
      </form>
      </div>
      </div>
    </section>
  );
}

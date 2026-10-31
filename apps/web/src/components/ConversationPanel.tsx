import { Component, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { STAGE_LABEL, type AssistantConversation, type ConversationDecision, type Project } from '@portal-ia/domain';
import { api, type AssignmentAuthPreview, type AssignmentView, type AssistantAction, type AssistantMessage, type ConversationArtifactView, type ConversationDetailView, type UsageGateView } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Chip, DraftNote, Icon, Notice } from './ui.tsx';
import { draftKey, fingerprint, useDraft } from '../lib/persist.ts';
import { Markdown } from './Markdown.tsx';

/**
 * Conversaciones del Asistente (v0.16): selector y alcance, etapa con la siguiente acción, registro de decisiones (una a
 * una), artefactos (propuesta cuestionada, revisión del equipo, borradores de historias), encargos de desarrollo,
 * cambios locales por confirmar y el informe de límites de Claude Code. Cada botón hace exactamente lo que dice: lo que
 * gasta IA o cambia algo pide tu autorización explícita en la propia tarjeta; nada se ejecuta por lenguaje natural.
 */

/** Una tarjeta que falla no deja la pantalla en blanco: se muestra el error en su lugar y lo demás sigue funcionando. */
export class CardBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  render() { return this.state.error ? <Notice kind="err">Esta tarjeta no se pudo mostrar ({this.state.error}). Recarga la página; el resto sigue disponible.</Notice> : this.props.children; }
}

const GMODE: Record<string, string> = { off: 'sin Gauntlet', standard: 'estándar', deep: 'profundo', auto: 'automático' };
const DECISION_TONE: Record<ConversationDecision['status'], '' | 'ok' | 'warn' | 'err'> = { open: 'warn', approved: 'ok', rejected: 'err', deferred: '' };
const DECISION_LABEL: Record<ConversationDecision['status'], string> = { open: 'abierta', approved: 'aprobada', rejected: 'rechazada', deferred: 'aplazada' };
const ARTIFACT_LABEL = { proposal: 'Propuesta', team_review: 'Revisión del equipo', stories: 'Borradores de historias' } as const;
const ARTIFACT_STATUS: Record<string, { label: string; tone: '' | 'ok' | 'warn' | 'err' | 'accent' }> = {
  pending_authorization: { label: 'espera tu autorización', tone: 'warn' }, running: { label: 'en curso', tone: 'accent' }, ready: { label: 'lista para revisar', tone: 'accent' },
  approved: { label: 'aprobada', tone: 'ok' }, rejected: { label: 'rechazada', tone: 'err' }, failed: { label: 'fallida', tone: 'err' }, applied: { label: 'historias creadas', tone: 'ok' }, cancelled: { label: 'cancelada', tone: '' }
};

/** Selector de conversación y su alcance (empresa y proyecto: el modelo no puede salirse de él). */
export function ConversationBar({ conversations, current, onSelect, onChanged }: { conversations: AssistantConversation[]; current: AssistantConversation | null; onSelect: (id: string | null) => void; onChanged: () => void }) {
  const { workspaces, flash } = useApp();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const slug = current?.workspaceSlug ?? '';
  useEffect(() => { if (!slug) { setProjects([]); return; } api.projects(slug).then(setProjects).catch(() => setProjects([])); }, [slug]);
  const list = conversations.filter(c => showArchived || c.status === 'active' || c.id === current?.id);
  const create = async () => { const c = await api.createConversation({ title: 'Nueva conversación', workspaceSlug: current?.workspaceSlug ?? null, projectId: current?.projectId ?? null }); onSelect(c.id); onChanged(); };
  const patch = async (p: Parameters<typeof api.updateConversation>[1]) => { if (!current) return; try { await api.updateConversation(current.id, p); onChanged(); } catch (e: any) { flash(e.message, 'err'); } };
  return (
    <div className="conv-bar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <label className="sr" htmlFor="conv-select">Conversación</label>
      <select id="conv-select" className="input" style={{ maxWidth: 260, height: 32 }} value={current?.id ?? ''} onChange={e => onSelect(e.target.value || null)}>
        {!current && <option value="">Sin conversación</option>}
        {list.map(c => <option key={c.id} value={c.id}>{c.status === 'archived' ? '🗄 ' : ''}{c.title} · {STAGE_LABEL[c.stage]}</option>)}
      </select>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void create()}>+ Nueva</button>
      {current && <>
        <label className="sr" htmlFor="conv-ws">Empresa</label>
        <select id="conv-ws" className="input" style={{ maxWidth: 180, height: 32 }} value={slug} onChange={e => void patch({ workspaceSlug: e.target.value || null, projectId: null })} title="Alcance: empresa">
          <option value="">Toda la plataforma</option>
          {workspaces.map(w => <option key={w.slug} value={w.slug}>{w.name}</option>)}
        </select>
        {slug && <><label className="sr" htmlFor="conv-pj">Proyecto</label>
          <select id="conv-pj" className="input" style={{ maxWidth: 200, height: 32 }} value={current.projectId ?? ''} onChange={e => void patch({ projectId: e.target.value || null })} title="Alcance: proyecto">
            <option value="">Todos los proyectos</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></>}
        {current.status === 'active'
          ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => void patch({ status: 'archived' })} title="Se conserva todo: mensajes, decisiones y artefactos">Archivar</button>
          : <button type="button" className="btn btn-ghost btn-sm" onClick={() => void patch({ status: 'active' })}>Reactivar</button>}
      </>}
      <label className="ck small" style={{ gap: 4 }}><input className="cb" type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /><span>ver archivadas</span></label>
    </div>
  );
}

/** Autorización de un encargo de análisis (propuesta, revisión, historias): presupuesto visible y marca explícita. */
function AnalysisAuthorize({ a, onDone }: { a: ConversationArtifactView; onDone: () => void }) {
  const { flash } = useApp();
  const [budget, setBudget] = useState(Math.max(0.5, (a.process?.estimatedUsd ?? 0.5) * 2).toFixed(2));
  const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  if (!a.process || !a.content.workspaceSlug) return null;
  const go = async () => {
    setBusy(true); setErr(null);
    try { await api.authorizeProcess(a.content.workspaceSlug!, a.process!.id, Number(budget)); flash(`${ARTIFACT_LABEL[a.kind]} en curso · hasta ${fmtUsd(Number(budget))}`); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    {err && <Notice kind="err">{err}</Notice>}
    <div className="small muted">{a.calls} llamada(s) · {a.agents.join(', ')} · estimado ≈ {fmtUsd(a.process.estimatedUsd ?? 0)}{a.kind === 'proposal' ? ' · incluye el cuestionamiento de otro especialista' : ''}</div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
      <div><label className="label" htmlFor={`ab-${a.id}`}>Presupuesto máximo (USD)</label><input id={`ab-${a.id}`} className="input mono" style={{ width: 110 }} type="number" min={0.1} step={0.5} value={budget} onChange={e => setBudget(e.target.value)} /></div>
      <label className="ck" style={{ flex: 1, minWidth: 220 }}><input className="cb" type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /><span>Autorizo este análisis hasta <strong>{fmtUsd(Number(budget) || 0)}</strong>. No cambia código ni crea historias.</span></label>
      <button type="button" className="btn btn-primary btn-sm" disabled={!ok || busy || !(Number(budget) > 0)} onClick={() => void go()}>{busy ? <span className="spin spin-light" /> : Icon.arrow()}Autorizar</button>
    </div>
  </div>;
}

function ArtifactCard({ conversationId, a, onChanged }: { conversationId: string; a: ConversationArtifactView; onChanged: () => void }) {
  const { flash, refreshStructure } = useApp();
  const [open, setOpen] = useState(a.status === 'ready');
  const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const st = ARTIFACT_STATUS[a.status] ?? { label: a.status, tone: '' as const };
  const act = async (fn: () => Promise<unknown>, msg: string) => { setBusy(true); setErr(null); try { await fn(); flash(msg); onChanged(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const link = a.process && a.content.workspaceSlug ? `/empresa/${a.content.workspaceSlug}/procesos/${a.process.id}` : null;
  return <div className="card" style={{ borderColor: a.status === 'pending_authorization' ? '#F0C66B' : undefined }}>
    <div className="card-h" style={{ alignItems: 'flex-start', gap: 8 }}>
      <div><div className="h3" style={{ fontSize: 14 }}>{ARTIFACT_LABEL[a.kind]} v{a.version}</div>{a.process && <div className="small muted">{fmtUsd(a.process.spentUsd)} gastados{a.process.budgetUsd ? ` de ${fmtUsd(a.process.budgetUsd)}` : ''}</div>}</div>
      <Chip xs tone={st.tone}>{st.label}</Chip>
    </div>
    <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {err && <Notice kind="err">{err}</Notice>}
      {a.status === 'pending_authorization' && <AnalysisAuthorize a={a} onDone={onChanged} />}
      {a.status === 'running' && <div className="small muted"><span className="spin" /> {a.process?.steps.filter(s => s.status === 'done').length ?? 0} de {a.process?.steps.length ?? 0} pasos. {link && <Link className="lnk" to={link}>ver el proceso</Link>}</div>}
      {a.deliverable && <details open={open} onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="small" style={{ cursor: 'pointer' }}><strong>{a.kind === 'stories' ? 'Historias propuestas' : 'Documento'}</strong></summary>
        <div style={{ marginTop: 8 }}><Markdown text={a.deliverable} /></div>
      </details>}
      {a.challenge && <div className="notice notice-warn">{Icon.warn()}<div><strong>Cuestionamiento independiente</strong> · {a.challenge.agentName} (no la redactó)<div style={{ marginTop: 4 }}><Markdown text={a.challenge.text} /></div></div></div>}
      {a.consulted.length > 0 && <details><summary className="small" style={{ cursor: 'pointer' }}>Aportaciones del equipo ({a.consulted.length})</summary>
        {a.consulted.map((c, i) => <div key={i} style={{ marginTop: 6 }}><div className="small"><strong>{c.agentName}</strong> — {c.question}</div><Markdown text={c.answer} /></div>)}
      </details>}
      {a.kind === 'stories' && a.backlogOps.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{a.backlogOps.map((o: any, i: number) => <li key={i}><strong>{o.title}</strong>{o.estimate ? ` · ${o.estimate}` : ''}{o.dependsOn ? <span className="muted"> · tras {o.dependsOn}</span> : null}<div className="muted">{o.criterion}</div></li>)}</ul>}
      {a.opsApplied && <Notice kind="ok">{a.opsApplied.summary.join(' · ')}</Notice>}
      {a.kind === 'proposal' && a.status === 'ready' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => api.decideArtifact(conversationId, a.id, 'approve'), 'Propuesta aprobada')}>Aprobar la propuesta</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => api.decideArtifact(conversationId, a.id, 'reject'), 'Propuesta rechazada')}>Rechazar</button>
      </div>}
      {a.kind === 'stories' && a.status === 'ready' && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="ck" style={{ flex: 1, minWidth: 220 }}><input className="cb" type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /><span>Autorizo crear estas <strong>{a.backlogOps.length} historia(s)</strong> en el backlog (las que ya existen no se duplican). No se ejecuta ninguna.</span></label>
        <button type="button" className="btn btn-primary btn-sm" disabled={!ok || busy} onClick={() => void act(async () => { await api.createStoriesFromArtifact(conversationId, a.id); await refreshStructure(); }, 'Historias creadas en el backlog')}>Crear historias</button>
      </div>}
      {link && a.status !== 'running' && <Link className="lnk small" to={link}>ver el proceso</Link>}
    </div>
  </div>;
}

function DecisionRow({ conversationId, d, onChanged }: { conversationId: string; d: ConversationDecision; onChanged: () => void }) {
  const { flash } = useApp();
  // Respuesta a medias: borrador por conversación y decisión mientras está abierta; si la decisión cambió, se ofrece sin aplicarlo.
  const answerDraft = useDraft(draftKey('decision', conversationId, d.status === 'open' ? d.id : null), d.answer ?? d.recommendation ?? '', { base: fingerprint([d.status, d.answer]) });
  const answer = answerDraft.value; const setAnswer = answerDraft.set;
  const [editing, setEditing] = useState(false); const [busy, setBusy] = useState(false);
  const run = async (action: 'approve' | 'reject' | 'defer' | 'revise' | 'reopen', body: { answer?: string | null; note?: string | null } = {}) => {
    setBusy(true); try { await api.decideDecision(conversationId, d.id, action, body); setEditing(false); answerDraft.clear(); onChanged(); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); }
  };
  return <div className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }} data-testid={`decision-${d.seq}`}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between' }}>
      <div className="sm13"><strong className="mono">D{d.seq}</strong> {d.question}{d.dependsOn.length ? <span className="small muted"> · depende de {d.dependsOn.map(n => `D${n}`).join(', ')}</span> : null}</div>
      <Chip xs tone={DECISION_TONE[d.status]}>{DECISION_LABEL[d.status]}</Chip>
    </div>
    {d.context && <div className="small muted">{d.context}</div>}
    {d.options.length > 0 && d.status === 'open' && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{d.options.map((o, i) => <li key={i}><button type="button" className="lnk" onClick={() => setAnswer(o.label)}>{o.label}</button>{o.pros ? <span className="muted"> · a favor: {o.pros}</span> : null}{o.cons ? <span className="muted"> · en contra: {o.cons}</span> : null}</li>)}</ul>}
    {d.recommendation && d.status === 'open' && <div className="small">Recomendación del Asistente: <strong>{d.recommendation}</strong> <span className="muted">(decides tú)</span></div>}
    {d.risks.length > 0 && d.status === 'open' && <div className="small muted">Riesgos: {d.risks.join(' · ')}</div>}
    {d.status !== 'open' && d.answer && <div className="small">→ <strong>{d.answer}</strong>{d.note ? <span className="muted"> ({d.note})</span> : null}</div>}
    {(d.status === 'open' || editing) && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <label className="sr" htmlFor={`ans-${d.id}`}>Tu respuesta a D{d.seq}</label>
      <input id={`ans-${d.id}`} className="input" style={{ flex: 1, minWidth: 160, height: 30 }} value={answer} onChange={e => setAnswer(e.target.value)} placeholder="Tu respuesta u opción" />
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !answer.trim()} onClick={() => void run(editing && d.status !== 'open' ? 'revise' : 'approve', { answer })}>{editing && d.status !== 'open' ? 'Guardar' : 'Aprobar'}</button>
      {d.status === 'open' && <>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run('defer')}>Aplazar</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run('reject', { answer: answer || null })}>Rechazar</button>
      </>}
      {editing && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancelar</button>}
    </div>}
    {d.status !== 'open' && !editing && <div style={{ display: 'flex', gap: 10 }} className="small">
      <button type="button" className="lnk" onClick={() => { setAnswer(d.answer ?? ''); setEditing(true); }}>revisar</button>
      <button type="button" className="lnk" disabled={busy} onClick={() => void run('reopen')}>reabrir</button>
      {d.history.length > 1 && <span className="muted">{d.history.length} cambios</span>}
    </div>}
  </div>;
}

/** Panel de la conversación: etapa, siguiente acción, decisiones, artefactos y encargos. */
export function ConversationPanel({ detail, compact, onChanged }: { detail: ConversationDetailView; compact?: boolean; onChanged: () => void }) {
  const { flash } = useApp();
  const [busy, setBusy] = useState(false);
  const c = detail.conversation;
  const open = detail.decisions.filter(d => d.status === 'open').length;
  const proposals = detail.artifacts.filter(a => a.kind === 'proposal');
  const live = (k: string) => detail.artifacts.some(a => a.kind === k && ['pending_authorization', 'running'].includes(a.status));
  const start = async (kind: 'proposal' | 'team_review' | 'stories') => { setBusy(true); try { await api.startArtifact(c.id, kind); onChanged(); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } };
  const scoped = !!c.workspaceSlug && !!c.projectId;
  const canPropose = scoped && open === 0 && detail.decisions.some(d => d.status === 'approved') && !live('proposal');
  const ready = proposals.some(a => ['ready', 'approved'].includes(a.status));
  const approved = proposals.some(a => a.status === 'approved');
  // En el dock y en móvil, plegado salvo que haya algo que decidir (el resumen con la siguiente acción siempre se ve).
  const narrow = typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 720px)').matches;
  return <details className="conv-panel" open={!(compact || narrow) || open > 0 || detail.artifacts.some(a => a.status === 'pending_authorization' || a.status === 'ready')} style={{ borderBottom: '1px solid #EEECE6' }}>
    <summary style={{ cursor: 'pointer', padding: compact ? '8px 12px' : '10px 18px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Chip xs tone="accent">{STAGE_LABEL[detail.stage]}</Chip>
      <span className="sm13" data-testid="next-action"><strong>Siguiente:</strong> {detail.next}</span>
      {open > 0 && <Chip xs tone="warn">{open} decisión(es) abierta(s)</Chip>}
    </summary>
    <div style={{ padding: compact ? '0 12px 10px' : '0 18px 12px', display: 'flex', flexDirection: 'column', gap: 8, maxHeight: compact ? 320 : 420, overflow: 'auto' }}>
      {!scoped && <Notice kind="info">Para preparar propuestas, historias o encargos, elige arriba la <strong>empresa y el proyecto</strong> de esta conversación.</Notice>}
      {detail.decisions.map(d => <CardBoundary key={d.id}><DecisionRow conversationId={c.id} d={d} onChanged={onChanged} /></CardBoundary>)}
      {detail.artifacts.map(a => <CardBoundary key={a.id}><ArtifactCard conversationId={c.id} a={a} onChanged={onChanged} /></CardBoundary>)}
      {detail.assignments.map(x => <CardBoundary key={x.id}><AssignmentCard slug={c.workspaceSlug!} assignmentId={x.id} initial={x} onChanged={onChanged} /></CardBoundary>)}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !canPropose} title={canPropose ? 'Lo redacta el equipo y otro especialista lo cuestiona (pide tu autorización antes de gastar)' : 'Cierra antes las decisiones abiertas y aprueba al menos una (con empresa y proyecto elegidos)'} onClick={() => void start('proposal')}>{proposals.length ? 'Nueva versión de la propuesta' : 'Preparar propuesta'}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !scoped || !ready || live('team_review')} title="Revisión de la propuesta por el equipo (pide tu autorización)" onClick={() => void start('team_review')}>Consultar al equipo</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !scoped || !approved || live('stories')} title={approved ? 'Borradores de historias a partir de la propuesta aprobada (los creas tú después)' : 'Aprueba antes la propuesta'} onClick={() => void start('stories')}>Preparar historias</button>
      </div>
    </div>
  </details>;
}

/** Encargo de desarrollo (sin historia): borrador → autorizar (presupuesto, tope de suscripción) → progreso → revisar. */
export function AssignmentCard({ slug, assignmentId, initial, onChanged }: { slug: string; assignmentId: string; initial?: AssignmentView | null; onChanged?: () => void }) {
  const { flash } = useApp();
  const [a, setA] = useState<AssignmentView | null>(initial ?? null);
  const [pre, setPre] = useState<AssignmentAuthPreview | null>(null);
  // Borrador de la tarjeta (solo lo que TÚ escribes: límites, Gauntlet y la nota para pedir cambios). Sin valor propio se
  // muestra lo que sugiere el Portal. Las casillas «Autorizo…» y «descarto…» nunca se guardan.
  const cardDraft = useDraft(draftKey('encargo', slug, assignmentId), { budget: '', calls: '', mode: '' as '' | 'off' | 'standard' | 'deep', note: '' });
  const { mode, note } = cardDraft.value; // mode '' = lo que resuelve el Portal (la vista previa)
  const budget = cardDraft.value.budget || (pre ? pre.suggestedBudgetUsd.toFixed(2) : ''); const calls = cardDraft.value.calls || (pre ? String(pre.suggestedSubscriptionCalls) : '');
  const setBudget = (v: string) => cardDraft.set(d => ({ ...d, budget: v })); const setCalls = (v: string) => cardDraft.set(d => ({ ...d, calls: v }));
  const setMode = (v: '' | 'off' | 'standard' | 'deep') => cardDraft.set(d => ({ ...d, mode: v })); const setNote = (v: string) => cardDraft.set(d => ({ ...d, note: v }));
  const [ok, setOk] = useState(false); const [discard, setDiscard] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const load = () => api.assignment(slug, assignmentId).then(setA).catch(e => setErr(e.message));
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, assignmentId]);
  const authorizable = !!a && ['draft', 'changes_requested', 'needs_owner', 'failed'].includes(a.status);
  useEffect(() => { if (!authorizable || pre) return; api.assignmentAuthorization(slug, assignmentId).then(p => { setPre(p); }).catch(e => setErr(e.message)); }, [authorizable, pre, slug, assignmentId]);
  useEffect(() => { if (a?.status !== 'running') return; const t = setInterval(() => void load(), 8000); return () => clearInterval(t); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.status]);
  if (!a) return err ? <Notice kind="err">{err}</Notice> : null;
  const act = async (fn: () => Promise<unknown>, msg: string) => { setBusy(true); setErr(null); try { await fn(); flash(msg); setOk(false); cardDraft.clear(); setDiscard(false); setPre(null); await load(); onChanged?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const link = a.process ? `/empresa/${slug}/procesos/${a.process.id}` : null;
  return <div className="card" style={{ borderColor: authorizable ? '#F0C66B' : undefined }} data-testid={`assignment-${a.code}`}>
    <div className="card-h" style={{ alignItems: 'flex-start', gap: 8 }}>
      <div><div className="h3" style={{ fontSize: 14 }}><span className="mono">{a.code}</span> {a.title}</div><div className="small muted">Encargo de desarrollo, sin historia{a.size ? ` · tamaño ${a.size}` : ''}</div></div>
      <Chip xs tone={a.status === 'ready_for_review' ? 'accent' : a.status === 'accepted' ? 'ok' : a.status === 'failed' || a.status === 'cancelled' ? 'err' : authorizable ? 'warn' : ''}>{a.statusLabel}</Chip>
    </div>
    <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {err && <Notice kind="err">{err}</Notice>}
      <div className="small"><strong>Objetivo:</strong> {a.objective}</div>
      {a.criteria.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{a.criteria.map((c, i) => <li key={i}>{c}</li>)}</ul>}
      {a.outOfScope.length > 0 && <div className="small muted">Fuera de alcance: {a.outOfScope.join(' · ')}</div>}
      {a.reason && a.status !== 'accepted' && <Notice kind="warn">{a.reason}</Notice>}
      {a.process && <div className="small muted">{a.status === 'running' && a.process.pipeline?.phase ? `${a.process.pipeline.phase} · ` : ''}{a.process.pipeline?.reason && a.process.pipeline.reason !== a.reason ? `${a.process.pipeline.reason} · ` : ''}{fmtUsd(a.process.spentUsd)} de {fmtUsd(a.process.budgetUsd ?? 0)} de API{link && <> · <Link className="lnk" to={link}>ver el proceso y la evidencia</Link></>}</div>}
      {authorizable && pre && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {pre.missing && <Notice kind="warn">Falta antes de autorizar: {pre.missing}</Notice>}
        {!pre.subscription.ok && <Notice kind="warn">{pre.subscription.reason}</Notice>}
        {pre.subscription.ok && pre.subscription.warning && <Notice kind="info">{pre.subscription.warning}</Notice>}
        <div className="small muted">{pre.steps} paso(s): {pre.agents.map(x => x.name).join(', ')} · estimado de API ≈ {fmtUsd(pre.estimatedUsd)} (con Claude Code, consume tu suscripción en lugar de API) · Gauntlet que se aplicará: <strong>{GMODE[mode || pre.gauntlet.mode] ?? (mode || pre.gauntlet.mode)}</strong>{!mode && pre.gauntlet.auto?.reason ? ` — ${pre.gauntlet.auto.reason}` : ''}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: 8, alignItems: 'end' }}>
          <div><label className="label" htmlFor={`eb-${a.id}`} title="0 = solo la suscripción de Claude Code (si algún agente usa la API, el Portal lo rechaza y te dice cuál)">Presupuesto API (USD) · 0 = solo suscripción</label><input id={`eb-${a.id}`} className="input mono" type="number" min={0} step={0.5} value={budget} onChange={e => setBudget(e.target.value)} /></div>
          <div><label className="label" htmlFor={`ec-${a.id}`}>Tope de llamadas a la suscripción</label><input id={`ec-${a.id}`} className="input mono" type="number" min={1} max={2000} step={1} value={calls} onChange={e => setCalls(e.target.value)} /></div>
          <div><label className="label" htmlFor={`eg-${a.id}`}>Gauntlet</label><select id={`eg-${a.id}`} className="input" value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="">Automático ({GMODE[pre.gauntlet.mode] ?? pre.gauntlet.mode})</option><option value="off">Sin Gauntlet</option><option value="standard">Estándar</option><option value="deep">Profundo</option></select></div>
        </div>
        <label className="ck"><input className="cb" type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /><span>Autorizo ejecutar <strong>{a.code}</strong> en un worktree aislado (rama propia, verificación en el sandbox, QA{(mode || pre.gauntlet.mode) !== 'off' ? ' y Gauntlet' : ''}) hasta <strong>{fmtUsd(Number(budget) || 0)}</strong> de API y <strong>{Number(calls) || 0}</strong> llamadas a la suscripción. Nunca integra en main ni publica.</span></label>
        {pre.discardBranch && <label className="ck small"><input className="cb" type="checkbox" checked={discard} onChange={e => setDiscard(e.target.checked)} /><span>Para ejecutar otra versión, descarto la anterior, aplicada sin integrar (su worktree y la rama <span className="mono">{pre.discardBranch}</span>).</span></label>}
        <div><button type="button" className="btn btn-primary btn-sm" disabled={!ok || busy || !!pre.missing || !pre.subscription.ok || budget === '' || !(Number(budget) >= 0) || !(Number(calls) >= 1) || (!!pre.discardBranch && !discard)} onClick={() => void act(() => api.authorizeAssignment(slug, a.id, { budgetUsd: Number(budget), maxSubscriptionCalls: Math.floor(Number(calls)), ...(mode ? { gauntlet: { mode } } : {}), ...(pre.discardBranch ? { discardApplied: discard } : {}) }), `${a.code} en marcha`)}>{busy ? <span className="spin spin-light" /> : Icon.arrow()}Autorizar y ejecutar</button></div>
      </div>}
      {a.status === 'ready_for_review' && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => api.acceptAssignment(slug, a.id, note.trim() || null), `${a.code} aceptado`)}>Aceptar</button>
          <label className="sr" htmlFor={`en-${a.id}`}>Qué cambiar</label>
          <input id={`en-${a.id}`} className="input" style={{ flex: 1, minWidth: 180, height: 30 }} value={note} onChange={e => setNote(e.target.value)} placeholder="Qué cambiar (para pedir cambios)" />
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy || note.trim().length < 3 || !discard} onClick={() => void act(() => api.requestAssignmentChanges(slug, a.id, note.trim(), discard), 'Cambios pedidos: autoriza la siguiente iteración')}>Pedir cambios</button>
        </div>
        <label className="ck small"><input className="cb" type="checkbox" checked={discard} onChange={e => setDiscard(e.target.checked)} /><span>Para pedir cambios, descarto esta versión (su worktree y su rama sin integrar).</span></label>
        <div className="small muted">Aceptar exige lo mismo que cerrar una historia (aplicado, verificado, probado); integrar en main sigue siendo una decisión aparte. Pedir cambios descarta esta versión (su rama sin integrar) y prepara otra ejecución desde main con tu nota, que autorizas aparte.</div>
      </div>}
      {['draft', 'changes_requested', 'needs_owner', 'failed', 'ready_for_review'].includes(a.status) && <div><button type="button" className="lnk small" disabled={busy} onClick={() => void act(() => api.cancelAssignment(slug, a.id), `${a.code} cancelado`)}>cancelar el encargo</button></div>}
    </div>
  </div>;
}

/** Cambio local propuesto por el Asistente (crear/editar historia, reiniciarla, crear empresa o proyecto): tú lo confirmas. */
export function LocalChangeCard({ msgId, index, action, onResolved }: { msgId: string; index: number; action: AssistantAction; onResolved: (m: AssistantMessage) => void }) {
  const { flash, refreshStructure } = useApp();
  const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const decide = async (d: 'approve' | 'reject') => {
    setBusy(true); setErr(null);
    try { const r = await api.decideLocal(msgId, index, d); onResolved(r.message); if (d === 'approve') { await refreshStructure(); flash('Hecho'); } } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <div className="card" style={{ borderColor: '#F0C66B', background: '#FFFBF0' }}>
    <div className="card-h" style={{ alignItems: 'flex-start' }}><div><div className="h3" style={{ fontSize: 14 }}>{action.label}</div>{action.detail && <div className="small muted">{action.detail}</div>}</div><Chip tone="warn" xs>sin IA · requiere tu confirmación</Chip></div>
    <div className="card-b" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {err && <Notice kind="err">{err}</Notice>}
      <label className="ck" style={{ flex: 1, minWidth: 200 }}><input className="cb" type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /><span>Confirmo este cambio.</span></label>
      <button type="button" className="btn btn-primary btn-sm" disabled={!ok || busy} onClick={() => void decide('approve')}>Hacerlo</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void decide('reject')}>Descartar</button>
    </div>
  </div>;
}

/** Último informe de límites de Claude Code (de la cuenta, tal como lo envía el CLI; nunca se inventa una cuota). */
export function UsageBanner() {
  const [g, setG] = useState<UsageGateView | null>(null);
  const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => { api.claudeCodeUsage().then(setG).catch(() => null); }, []);
  if (!g || (g.ok && !g.warning)) return null;
  const ack = async () => { setBusy(true); try { setG(await api.acknowledgeUsage()); } finally { setBusy(false); setOk(false); } };
  return <div style={{ padding: '10px 12px 0' }}><div className={`notice ${g.ok ? 'notice-info' : 'notice-warn'}`} role="status">{g.ok ? Icon.info() : Icon.warn()}<div>
    <strong>{g.ok ? 'Aviso de Claude Code' : 'Trabajo nuevo con la suscripción en pausa'}</strong> — {g.ok ? g.warning : g.reason}
    {g.report && <div className="small muted" style={{ marginTop: 2 }}>Dato del último informe del CLI ({new Date(g.report.receivedAt).toLocaleString()}), no una estimación. El Portal no conoce tu cuota restante.</div>}
    {!g.ok && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
      <label className="ck"><input className="cb" type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /><span className="small">He revisado mi cuenta (límite renovado o uso adicional aceptado).</span></label>
      <button type="button" className="btn btn-ghost btn-sm" disabled={!ok || busy} onClick={() => void ack()}>Reconocer</button>
      <span className="small muted">Permite empezar trabajo nuevo. Lo que quedó en pausa se reanuda desde su proceso o su lote.</span>
    </div>}
  </div></div></div>;
}

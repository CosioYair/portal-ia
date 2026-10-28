import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FlowAction, FlowIssue, Process, StoryContext } from '@portal-ia/domain';
import { api, ApiError } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Chip, Icon, Notice } from './ui.tsx';
import { IterationComposer } from './IterationComposer.tsx';
import '../story-flow.css';

const STATUS_TXT: Record<string, string> = { done: 'hecho', warning: 'hecho con advertencias', rejected: 'rechazado', failed: 'falló', blocked: 'bloqueado', waiting: 'espera tu autorización', running: 'en curso', current: 'toca ahora', pending: 'aún no disponible' };
const STATUS_TONE: Record<string, '' | 'ok' | 'warn' | 'err' | 'accent'> = { done: 'ok', warning: 'warn', rejected: 'err', failed: 'err', blocked: 'warn', waiting: 'warn', running: 'accent', current: 'accent', pending: '' };
const CAUSE: Record<FlowIssue['cause'], string> = { environment: 'Entorno (no es un error del código)', code: 'Código: lo corrige el equipo', decision: 'Requiere tu decisión' };
const REQ: Record<string, string> = { authorization: 'requiere tu autorización', network: 'red temporal', ai_budget: 'gasta IA con tu presupuesto', confirmation: 'pide confirmación' };
const ROLE: Record<string, string> = { planner: 'planifica', implementer: 'implementa', reviewer: 'revisa', consultant: 'consulta' };
const elapsed = (from: string | null, to: string | null) => { if (!from) return ''; const s = Math.max(0, Math.round(((to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()) / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };
const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

interface Props {
  proc: Process;
  /** Historia a la que pertenece (título e identificador). */
  story?: { id: string; storyId: string; title: string } | null;
  /** Dónde se muestra: en el espacio de la historia o en la página del proceso. */
  variant: 'story' | 'process';
  onChange: (p: Process) => void;
  /** Espacio de la historia: abre el chat con la pregunta preparada / la pestaña Iteraciones. */
  onAsk?: (text: string) => void;
  onOpenIterations?: () => void;
}

/**
 * Cabecera persistente del proceso de una historia: qué historia e iteración, en qué etapa está, qué agentes trabajan o
 * son responsables, cuánto se ha gastado, qué lo bloquea y qué hacer ahora. Todo viene del servidor (guidance.flow); las
 * acciones usan las rutas existentes y piden la autorización que cada una exige antes de ejecutar nada.
 */
export function StoryFlowPanel({ proc, story, variant, onChange, onAsk, onOpenIterations }: Props) {
  const { status, flash, navigate } = useApp();
  const slug = status.workspace!.slug;
  const flow = proc.guidance?.flow;
  const [confirming, setConfirming] = useState<FlowAction | null>(null);
  const [okAuth, setOkAuth] = useState(false);
  const [addBudget, setAddBudget] = useState('0.50');
  const [allowInstall, setAllowInstall] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [composer, setComposer] = useState<StoryContext | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { if (proc.status !== 'running') return; const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, [proc.status]);
  useEffect(() => { setConfirming(null); setComposer(null); setErr(null); setMsg(null); setOkAuth(false); }, [proc.id, flow?.current, flow?.issue?.kind]);
  if (!flow) return null;
  const itemId = proc.backlogItemId ?? story?.id ?? null;
  const issue = flow.issue;
  const cur = flow.stages.find(s => s.key === flow.current)!;
  const curIdx = flow.stages.findIndex(s => s.key === flow.current);

  const reload = async () => { try { onChange(await api.process(slug, proc.id)); } catch { /* sin cambios */ } };
  const askText = issue ? `Sobre «${issue.title}»${issue.command ? ` (${issue.command})` : ''}: ¿por qué ocurre y cómo propones corregirlo? Responde con las causas y los cambios concretos.` : '¿Qué falta para cerrar esta historia?';
  const run = async (a: FlowAction) => {
    setErr(null); setMsg(null);
    // Acciones que solo llevan a la sección donde se completan (con su propia autorización y opciones)
    if (a.id === 'review_diff') return go('sec-diff');
    if (a.id === 'apply') return go('sec-apply');
    if (a.id === 'manual_test') return go('sec-test');
    if (a.id === 'rebuild') { window.scrollTo({ top: 0, behavior: 'smooth' }); setMsg('Usa «Reconstruir y reiniciar» en la barra amarilla de arriba: construye la versión nueva aparte y reinicia el Portal; si el build falla, la versión anterior sigue en marcha.'); return; }
    if (a.id === 'sandbox_help') { setShowAll(true); setMsg('Guía completa: docs/sandbox.md en la carpeta del Portal. Cuando Docker Desktop diga «Engine running», pulsa «Comprobar el sandbox de nuevo».'); return; }
    if (a.id === 'authorize') { if (variant === 'story' && onOpenIterations) onOpenIterations(); else go('sec-authorize'); return; }
    if (a.id === 'ask_team') { if (!itemId) return; if (onAsk) onAsk(askText); else navigate(`/historias/${itemId}#chat`, { state: { ask: askText } }); return; }
    if ((a.id === 'request_fix' || a.id === 'new_iteration') && itemId) { setBusy(a.id); try { setComposer(await api.story(slug, itemId)); } catch (e: any) { setErr(e.message); } finally { setBusy(null); } return; }
    // El resto se ejecuta aquí: las que exigen autorización/red piden confirmación explícita antes
    if (a.requires.some(r => r === 'authorization' || r === 'network') && confirming?.id !== a.id) { setConfirming(a); setOkAuth(false); setAddBudget((a.suggestedBudgetUsd ?? 0.5).toFixed(2)); setAllowInstall(!!a.pipeline?.allowInstall); return; }
    setBusy(a.id);
    try {
      if (a.id === 'install_and_retry') { const p = await api.installAndRetry(slug, proc.id, a.commands ?? []); onChange(p); const v = p.result?.verifications ?? []; const inst = v.filter(x => x.command === 'install').at(-1); flash(inst?.exitCode === 0 ? 'Dependencias instaladas; verificación repetida' : 'La instalación no terminó bien: revisa el detalle', inst?.exitCode === 0 ? 'ok' : 'err'); }
      else if (a.id === 'verify' || a.id === 'retry_verification') {
        let p = proc;
        for (const c of a.commands ?? []) { p = await api.verifyProcess(slug, proc.id, c as any, false); onChange(p); const last = p.result?.verifications.at(-1); if (last && last.exitCode !== 0 && last.exitCode === 86) break; }
        const ran = (a.commands ?? []).map(c => p.result?.verifications.filter(v => v.command === c).at(-1)).filter(Boolean);
        const blocked = ran.some(v => v!.exitCode === 86);
        flash(ran.every(v => v!.exitCode === 0) ? 'Verificación en verde' : blocked ? 'Verificación bloqueada: faltan las dependencias (no es un error del código)' : 'La verificación encontró problemas: mira el detalle arriba', ran.every(v => v!.exitCode === 0) ? 'ok' : 'err');
      }
      else if (a.id === 'merge') { try { const p = await api.mergeProcess(slug, proc.id); onChange(p); flash(`Integrada en ${p.result?.merged?.into}`); } catch (e: any) { if (e instanceof ApiError && e.body?.process) onChange(e.body.process); else throw e; } }
      else if (a.id === 'runtime_check') { const p = await api.runtimeCheck(slug, proc.id); onChange(p); }
      else if (a.id === 'refresh_sandbox') { const s = await api.systemSandbox(true); await reload(); flash(s.available === 'unavailable' ? 'Sigue sin sandbox: arranca Docker Desktop' : `Sandbox disponible: ${s.available}`, s.available === 'unavailable' ? 'err' : 'ok'); }
      else if (a.id === 'tasks_from_issue' && itemId) { const t = await api.storyTasksFromIssue(slug, itemId); setMsg(t.length ? `${t.length} tarea(s) creadas a partir del problema.` : 'Ya existían tareas para estos hallazgos; no se duplican.'); }
      else if (a.id === 'reject') { const reason = prompt('¿Por qué rechazas esta iteración? (la historia vuelve a pendiente)', issue?.title ?? 'replanteada'); if (reason === null) return; onChange(await api.rejectProcess(slug, proc.id, reason.trim() || undefined)); }
      else if (a.id === 'close' && itemId) { await api.markStoryDone(slug, itemId); flash('Historia completada'); await reload(); }
      else if (a.id === 'close_resolved' && itemId) { const reason = prompt('Cerrar como resuelta: indica brevemente por qué (queda registrado).', 'Lo pedido ya funciona en el Portal'); if (reason === null) return; await api.markStoryDone(slug, itemId, { force: true, reason: reason.trim() || 'resuelta fuera del flujo' }); await reload(); }
      else if (a.id === 'retry_process') { const p = await api.retryProcess(slug, proc.id); flash('Proceso nuevo creado: elige el presupuesto y autorízalo'); navigate(`/procesos/${p.id}`); }
      else if (a.id === 'pipeline_resume' || a.id === 'repair_output') {
        const add = a.requires.includes('ai_budget') ? Math.max(0, Number(addBudget) || 0) : 0;
        const p = await api.continueProcess(slug, proc.id, { addBudgetUsd: add, pipeline: { ...(a.pipeline ?? {}), ...(allowInstall ? { allowInstall: true } : {}) } });
        onChange(p); flash(a.id === 'repair_output' ? 'El Desarrollador está reparando su entrega (sin repetir el plan)' : 'El equipo retoma el trabajo donde lo dejó');
      }
      else if (a.id === 'recover') { const p = await api.recoverProcess(slug, proc.id); onChange(p); flash('Resultado recuperado sin IA'); }
      else if (a.id === 'cancel') { if (!confirm('¿Cancelar el proceso? Se detendrá al terminar el paso en curso.')) return; await api.cancelProcess(slug, proc.id); flash('Cancelación solicitada'); }
      setConfirming(null);
    } catch (e: any) { setErr(explainError(e)); } finally { setBusy(null); }
  };

  const primary = flow.actions.find(a => a.primary);
  const secondary = flow.actions.filter(a => !a.primary);
  const details = issue ? (showAll ? issue.details : issue.details.slice(0, 6)) : [];
  const agents = proc.steps;

  return (
    <section className="sf" aria-label="Estado de la historia">
      <div className="sf-top">
        <div className="sf-title">
          <div className="eyebrow">{story ? <>{variant === 'process' ? <Link className="lnk" to={`/historias/${story.id}`}>{story.storyId}</Link> : story.storyId}</> : 'Historia'}{flow.iteration ? ` · iteración ${flow.iteration.number} de ${flow.iteration.total}` : ''} · etapa {curIdx + 1} de {flow.stages.length}</div>
          <div className="h3">{story ? story.title : proc.title}</div>
        </div>
        <div className="sf-meta">
          <Chip xs className="mono">{fmtUsd(proc.spentUsd)} de {fmtUsd(proc.budgetUsd)} autorizados</Chip>
          <Chip xs>{flow.progress.done} de {flow.progress.total} etapas</Chip>
          {variant === 'story' ? <Link className="btn btn-ghost btn-sm" to={`/procesos/${proc.id}`}>Ver el proceso y los agentes</Link> : itemId && <Link className="btn btn-ghost btn-sm" to={`/historias/${itemId}`}>{Icon.back()} Espacio de la historia</Link>}
        </div>
      </div>

      <ol className="sf-stages" style={{ ['--n' as any]: flow.stages.length }} aria-label="Etapas">
        {flow.stages.map(s => <li key={s.key} className={`sf-stage${s.key === flow.current ? ' is-current' : ''}`} data-status={s.status} title={`${s.label}: ${STATUS_TXT[s.status]}${s.detail ? ` · ${s.detail}` : ''}`} aria-current={s.key === flow.current ? 'step' : undefined}>
          <span className="sf-bar" /><span className="sf-stage-label">{s.label}</span>
        </li>)}
      </ol>

      {flow.headline && <div className={`sf-headline${proc.result?.pipeline?.state === 'verified' ? ' is-ok' : ''}`} role="status" aria-label="Estado del pipeline">{proc.result?.pipeline?.state === 'verified' ? Icon.okc() : proc.status === 'running' ? <span className="spin" /> : Icon.info()}<span>{flow.headline}</span></div>}

      <div className="sf-now" aria-label="Etapa actual">
        <div className="sf-now-head"><strong>Ahora: {cur.label}</strong><Chip tone={STATUS_TONE[cur.status]} xs>{STATUS_TXT[cur.status]}</Chip></div>
        {cur.detail && <span className="small muted">{cur.detail}</span>}
        {flow.responsible.length > 0 && <span className="small">{flow.responsible.map(r => `${r.agentName} (${r.role})`).join(' · ')} — {flow.responsible[0].status}</span>}
        {flow.stages.filter(s => s.status === 'warning' || s.status === 'rejected').filter(s => s.key !== flow.current).map(s => <span key={s.key} className="small" style={{ color: '#7A4A00' }}>⚠ {s.label}: {s.detail}</span>)}
      </div>

      {(proc.status === 'running' || proc.status === 'pending_authorization') && <div className="sf-agents" aria-label="Agentes">
        {agents.map(s => <div key={s.id} className="sf-agent">
          <span>{s.status === 'done' ? Icon.check(14) : s.status === 'running' ? <span className="spin" /> : s.status === 'failed' ? '✕' : '·'}</span>
          <span><strong>{s.agentName}</strong> · {ROLE[s.role ?? ''] ?? s.title}{s.status === 'running' ? ` · ${s.title}` : ''}</span>
          <span className="small muted mono">{s.status === 'pending' ? 'en espera' : `${elapsed(s.startedAt, s.finishedAt)}${s.inputTokens + s.outputTokens ? ` · ${s.inputTokens + s.outputTokens} tokens · ${fmtUsd(s.costUsd)}` : ''}`}</span>
        </div>)}
      </div>}

      {proc.result?.pipeline && <PipelineActivity proc={proc} />}

      {issue && <div className="sf-issue" data-cause={issue.cause} data-level={issue.level} role={issue.level === 'blocker' ? 'alert' : undefined} aria-label="Problema actual">
        <div className="sf-issue-title">{issue.level === 'blocker' ? Icon.alert() : Icon.warn()}<span>{issue.title}</span><Chip xs tone={issue.cause === 'environment' ? 'warn' : issue.cause === 'code' ? 'err' : ''}>{CAUSE[issue.cause]}</Chip></div>
        <p className="sm13" style={{ margin: 0, lineHeight: 1.5 }}>{issue.explanation}</p>
        {details.length > 0 && <ul className="sf-details" aria-label="Detalle del problema">
          {details.map((d, i) => <li key={i}>{d.severity && <span className={`sf-sev sf-sev-${d.severity}`}>{d.severity}</span>}{d.file && <span className="mono">{d.file}{d.line ? `:${d.line}` : ''} </span>}{d.code && <span className="mono muted">{d.code} </span>}{d.text}</li>)}
        </ul>}
        {issue.details.length > 6 && <button className="lnk small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll(v => !v)}>{showAll ? 'Ver menos' : `Ver los ${issue.details.length}`}</button>}
        {issue.files.length > 0 && <span className="small muted">Archivos: <span className="mono">{issue.files.join(', ')}</span></span>}
        {issue.responsible.length > 0 && <span className="small muted">Responsables de corregirlo: {issue.responsible.join(', ')}</span>}
        {issue.evidence && <details><summary className="small" style={{ cursor: 'pointer' }}>Ver la salida técnica</summary><pre className="sf-evidence mono">{issue.evidence}</pre></details>}
      </div>}

      {flow.actions.length > 0 && <div className="sf-actions" aria-label="Acciones">
        {primary && <button className="btn btn-primary btn-sm" onClick={() => void run(primary)} disabled={busy !== null} title={primary.description}>{busy === primary.id ? <span className="spin spin-light" /> : Icon.arrow()}{primary.label}</button>}
        {secondary.map(a => <button key={a.id} className="btn btn-secondary btn-sm" onClick={() => void run(a)} disabled={busy !== null} title={a.description}>{busy === a.id ? <span className="spin" /> : null}{a.label}</button>)}
      </div>}
      {primary && !confirming && !composer && <span className="small muted">{primary.description}{primary.requires.length ? ` · ${primary.requires.map(r => REQ[r]).join(', ')}` : ''}</span>}

      {confirming && <div className="sf-confirm" aria-label="Confirmar acción">
        <strong className="sm13">{confirming.label}</strong>
        <span className="sm13">{confirming.description}</span>
        <label className="ck"><input className="cb" type="checkbox" checked={okAuth} onChange={e => setOkAuth(e.target.checked)} />
          <span>{confirming.requires.includes('network') ? <>Autorizo ejecutar en el sandbox y <strong>permitir red solo durante la instalación de dependencias</strong> (npm ci, sin scripts del repositorio); lo demás se ejecuta sin red.</> : confirming.id === 'pipeline_resume' || confirming.id === 'repair_output' ? <>Autorizo al equipo a continuar {confirming.requires.includes('ai_budget') ? <>con hasta <strong>{fmtUsd(Number(addBudget) || 0)}</strong> adicionales (máximo, no objetivo)</> : 'sin gasto de IA adicional'}. No integra, no reinicia el Portal ni publica.</> : <>Autorizo esta acción{confirming.id === 'merge' ? ' (merge en main)' : confirming.id === 'runtime_check' ? ' (el Portal se consulta a sí mismo)' : ' en el sandbox, sobre el worktree del proceso'}.</>}</span></label>
        {(confirming.id === 'pipeline_resume' || confirming.id === 'repair_output') && confirming.requires.includes('ai_budget') && <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>Presupuesto adicional (USD) <input className="input mono" type="number" min={0} step={0.25} value={addBudget} onChange={e => setAddBudget(e.target.value)} style={{ width: 100, height: 30 }} aria-label="Presupuesto adicional" /><span className="muted">quedan {fmtUsd(Math.max(0, proc.budgetUsd - proc.spentUsd))} del autorizado</span></label>}
        {(confirming.id === 'pipeline_resume' || confirming.id === 'repair_output') && !confirming.requires.includes('network') && <label className="ck small"><input className="cb" type="checkbox" checked={allowInstall} onChange={e => setAllowInstall(e.target.checked)} /><span>Si faltan dependencias en el sandbox, instalarlas con red temporal (solo durante la instalación).</span></label>}
        <div className="sf-actions"><button className="btn btn-primary btn-sm" disabled={!okAuth || busy !== null} onClick={() => void run(confirming)}>{busy === confirming.id ? <span className="spin spin-light" /> : Icon.check()}Confirmar y ejecutar</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirming(null)} disabled={busy !== null}>Cancelar</button></div>
      </div>}

      {composer && itemId && <div className="sf-confirm" aria-label="Iteración correctiva">
        <strong className="sm13">{issue ? 'Pedir al equipo que lo corrija' : 'Nueva iteración'}</strong>
        <span className="small">{issue ? 'El equipo recibirá automáticamente el problema (comando, errores, archivos, evidencia), los intentos anteriores, las tareas abiertas y el criterio vigente.' : 'El equipo recibirá el contexto acumulado de la historia.'}</span>
        <IterationComposer slug={slug} itemId={itemId} iteration={composer.iteration} nextNumber={composer.iterations + 1} placeholder="Indicaciones adicionales para el equipo (opcional)"
          onCreated={() => { flash('Iteración correctiva creada: revísala y autorízala'); setComposer(null); if (variant === 'story' && onOpenIterations) onOpenIterations(); else navigate(`/historias/${itemId}#iteraciones`); }} />
        <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setComposer(null)}>Cancelar</button>
      </div>}

      {msg && <Notice kind="info"><div>{msg}{msg.includes('tarea') && itemId && <> <button className="lnk" onClick={() => navigate(`/historias/${itemId}#tareas`)}>Ver tareas</button></>}</div></Notice>}
      {err && <Notice kind="err">{err}</Notice>}
    </section>
  );
}

const EV_ICON: Record<string, string> = { recovery: '♻', repair: '✎', apply: '⎇', verify: '✓', environment: '⚙', qa: '◎', correction: '✎', pause: '⏸', done: '★', error: '✕', info: '·' };
const QA_TXT: Record<string, string> = { approved: 'QA aprobó con evidencia', rejected: 'QA rechazó', blocked_environment: 'QA bloqueada por el entorno', unable_to_verify: 'QA no pudo verificar' };

/** Actividad del pipeline como una sola actividad coordinada: eventos breves, intentos, QA y presupuesto. */
function PipelineActivity({ proc }: { proc: Process }) {
  const pl = proc.result!.pipeline!; const review = proc.result!.review;
  // Hitos siempre visibles (recuperación, reparación, aplicación, correcciones, QA, pausas, final) y los últimos pasos;
  // el detalle rutinario (cada comando verificado) queda en el registro técnico plegado.
  const MILESTONE = new Set(['recovery', 'repair', 'apply', 'correction', 'qa', 'pause', 'error', 'done']);
  const events = pl.events.filter(e => e.kind !== 'info' || pl.events.length < 6);
  const recent = events.filter((e, i) => MILESTONE.has(e.kind) || i >= events.length - 3).slice(-8);
  const aiCost = pl.events.reduce((a, e) => a + (e.costUsd ?? 0), 0);
  return <div className="sf-pipe" aria-label="Actividad del equipo">
    <div className="sf-pipe-meta small">
      <span>Pipeline autorizado · {pl.config.autoApply ? `aplicar, ${pl.config.commands.join(', ')}, QA` : 'manual'}</span>
      <span>Correcciones {pl.corrections}/{pl.config.maxCorrections} · reparaciones {pl.outputRepairs}/{pl.config.maxOutputRepairs}</span>
      {review?.verdict && <span>{QA_TXT[review.verdict]}{review.overridden ? ' (corregido por la verificación)' : ''}</span>}
      <span className="mono">{fmtUsd(proc.spentUsd)} gastados · quedan {fmtUsd(Math.max(0, proc.budgetUsd - proc.spentUsd))}{aiCost ? ` · reparaciones/correcciones ${fmtUsd(aiCost)}` : ''}</span>
    </div>
    <ol className="sf-pipe-events">
      {recent.map((e, i) => <li key={i} data-kind={e.kind}><span aria-hidden="true">{EV_ICON[e.kind] ?? '·'}</span><span>{e.message}{e.costUsd ? <span className="muted mono"> · {fmtUsd(e.costUsd)}</span> : null}</span></li>)}
    </ol>
    {pl.events.length > 0 && <details><summary className="small" style={{ cursor: 'pointer' }}>Registro técnico completo ({pl.events.length} eventos)</summary>
      <ol className="sf-pipe-log small mono">{pl.events.map((e, i) => <li key={i}>{new Date(e.at).toLocaleTimeString('es-MX')} · {e.kind} · {e.message}{e.detail ? ` — ${e.detail}` : ''}</li>)}</ol>
    </details>}
  </div>;
}

/** Errores de la API en lenguaje claro (permisos, autorización, conflictos). */
export function explainError(e: any): string {
  const code = e instanceof ApiError ? e.body?.code : undefined;
  if (code === 'tool_not_granted') return `${e.message} Actívala en Equipo de IA → el agente → Herramientas, o elige otro agente para este papel.`;
  if (code === 'authorization_required' || code === 'network_confirmation_required') return `${e.message} Marca la autorización y vuelve a intentarlo.`;
  if (code === 'merge_conflict') return 'No se pudo integrar por conflictos con main. Arriba tienes la explicación y la corrección.';
  return e?.message ?? String(e);
}

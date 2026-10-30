import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { BacklogItem, BatchItemState, BatchItemView, BatchPreview, BatchView, GauntletConfig } from '@portal-ia/domain';
import { BATCH_LIMITS, INTERNAL_WORKSPACE, normalizeGauntlet } from '@portal-ia/domain';
import { api, type BatchRequest } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { GAUNTLET_MODE } from '../components/Gauntlet.tsx';
import { Chip, Icon, Notice } from '../components/ui.tsx';

const STATUS: Record<BatchView['status'], { label: string; tone: '' | 'ok' | 'warn' | 'err' | 'accent' }> = {
  running: { label: 'en marcha', tone: 'accent' }, paused: { label: 'en pausa', tone: 'warn' }, completed: { label: 'terminado', tone: 'ok' }, cancelled: { label: 'cancelado', tone: '' }, revoked: { label: 'autorización revocada', tone: 'err' }
};
const TONE: Record<BatchItemState, '' | 'ok' | 'warn' | 'err' | 'accent'> = {
  queued: '', waiting_dependency: '', running: 'accent', integrating: 'accent', needs_owner: 'warn', awaiting_integration: 'warn', awaiting_acceptance: 'warn', accepted: 'ok', rejected: 'err', failed: 'err', blocked: 'err', cancelled: ''
};
const GROUPS: { label: string; states: BatchItemState[] }[] = [
  { label: 'Pendientes de tu aceptación', states: ['awaiting_acceptance'] },
  { label: 'Aceptadas', states: ['accepted'] },
  { label: 'En curso o en cola', states: ['running', 'integrating', 'queued', 'waiting_dependency'] },
  { label: 'Esperan tu decisión', states: ['needs_owner', 'awaiting_integration', 'rejected'] },
  { label: 'Bloqueadas, fallidas o canceladas', states: ['blocked', 'failed', 'cancelled'] }
];
const GSTATUS: Record<string, string> = { pending: 'en curso', passed: 'todo con evidencia', passed_with_findings: 'con hallazgos menores', stopped: 'detenido con brechas', skipped: 'no aplicado', waived: 'sin más evaluación' };
const QA: Record<string, string> = { approved: 'aprobó', rejected: 'rechazó', unable_to_verify: 'no pudo verificar', blocked_environment: 'bloqueada por el entorno' };
const when = (iso: string) => new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });

/** Ejecución continua del backlog: lotes autorizados del proyecto y el asistente para autorizar uno nuevo. */
export function Batches() {
  const { status } = useApp();
  const ws = status.workspace!; const projectId = status.project!.id;
  const [list, setList] = useState<BatchView[] | null>(null); const [creating, setCreating] = useState(false);
  const load = () => api.batches(ws.slug, projectId).then(setList).catch(() => setList([]));
  useEffect(() => { void load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [ws.slug, projectId]);
  const active = list?.find(b => b.status === 'running' || b.status === 'paused');
  return (
    <Shell crumb="Ejecución continua">
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><div className="eyebrow">Backlog</div><h1 className="h1" style={{ fontSize: 26 }}>Ejecución continua</h1>
            <div className="sm13 muted" style={{ maxWidth: '75ch' }}>Autorizas una vez un alcance acotado (historias, presupuesto, límites, Gauntlet, qué operaciones git) y el coordinador del lote, sin IA, las ejecuta en orden seguro, integra de una en una y te deja cada historia lista para <strong>tu aceptación</strong>, que es distinta de QA.</div></div>
          {!creating && <button className="btn btn-primary" onClick={() => setCreating(true)} disabled={!!active} title={active ? 'Ya hay un lote activo en este proyecto' : undefined}>{Icon.activity()}Nuevo lote</button>}
        </div>
        {creating && <BatchWizard onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load(); }} />}
        {active && !creating && <Notice kind="info">Lote activo: <Link to={`/lotes/${active.id}`}><strong>{active.title}</strong></Link> · {STATUS[active.status].label}{active.reason ? ` · ${active.reason}` : ''}</Notice>}
        <section className="card">
          <div className="card-h"><div className="h3">Lotes del proyecto</div></div>
          {!list ? <div className="card-b"><span className="spin" /></div> : !list.length ? <div className="card-b small muted">Todavía no hay lotes. Crea uno con las historias pendientes que quieras ejecutar seguidas.</div> :
            <div style={{ overflowX: 'auto' }}><table className="tbl"><thead><tr><th>Lote</th><th>Estado</th><th>Historias</th><th>Pendientes de aceptación</th><th>Gasto</th><th>Creado</th></tr></thead><tbody>
              {list.map(b => <tr key={b.id}><td><Link className="lnk" to={`/lotes/${b.id}`}>{b.title}</Link></td><td><Chip xs tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Chip></td><td className="mono">{b.items.length}</td><td className="mono">{b.summary.awaiting_acceptance}</td><td className="mono">{fmtUsd(b.budget.spent)} / {fmtUsd(b.auth.totalBudgetUsd)}</td><td className="small">{when(b.createdAt)}</td></tr>)}
            </tbody></table></div>}
        </section>
      </main>
    </Shell>
  );
}

/** Asistente: historias y orden, límites, Gauntlet, operaciones git; vista previa sin IA; autorización explícita. */
function BatchWizard({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { status, flash, navigate } = useApp();
  const ws = status.workspace!; const projectId = status.project!.id;
  const internal = ws.slug === INTERNAL_WORKSPACE.slug;
  const [items, setItems] = useState<BacklogItem[]>([]); const [all, setAll] = useState<BacklogItem[]>([]); const [sel, setSel] = useState<string[]>([]);
  const [req, setReq] = useState<Omit<BatchRequest, 'itemIds'>>({ totalBudgetUsd: 5, perStoryBudgetUsd: 1.5, maxCorrections: 3, maxDurationMin: 240, maxSubscriptionCalls: 60, concurrency: 1, gauntlet: normalizeGauntlet(null), backends: ['api', 'claude_code'], commands: ['typecheck', 'test', 'build'], allowInstall: false, git: { merge: false, activate: false, publish: false } });
  const [preview, setPreview] = useState<BatchPreview | null>(null); const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const loadItems = () => api.backlog(ws.slug, projectId).then(list => { setAll(list.filter(i => !i.archivedAt)); setItems(list.filter(i => !i.archivedAt && (i.status === 'pending' || i.status === 'blocked'))); }).catch(e => setErr(e.message));
  useEffect(() => { void loadItems(); }, [ws.slug, projectId]);
  // «Depende de» se guarda en la historia (el plan del lote lo respeta siempre, también en lotes futuros).
  const setDep = async (id: string, dependsOn: string | null) => { try { await api.patchBacklogItem(ws.slug, id, { dependsOn }); await loadItems(); setPreview(null); } catch (e: any) { setErr(e.message); } };
  useEffect(() => { setPreview(null); setOk(false); }, [sel, req]);
  const set = (patch: Partial<typeof req>) => setReq(r => ({ ...r, ...patch }));
  const toggle = (id: string) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const move = (id: string, d: -1 | 1) => setSel(s => { const i = s.indexOf(id); const j = i + d; if (j < 0 || j >= s.length) return s; const c = [...s]; [c[i], c[j]] = [c[j], c[i]]; return c; });
  const num = (k: 'totalBudgetUsd' | 'perStoryBudgetUsd' | 'maxCorrections' | 'maxDurationMin' | 'maxSubscriptionCalls' | 'concurrency', label: string, min: number, max: number, step = 1) =>
    <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{label}<input className="input mono" type="number" min={min} max={max} step={step} value={req[k] as number} onChange={e => set({ [k]: Math.max(min, Math.min(max, Number(e.target.value) || min)) } as any)} style={{ height: 32 }} /></label>;
  const body = (): BatchRequest => ({ ...req, itemIds: sel });
  const doPreview = async () => { setBusy(true); setErr(null); try { setPreview(await api.previewBatch(ws.slug, projectId, body())); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const authorize = async () => { setBusy(true); setErr(null); try { const b = await api.createBatch(ws.slug, projectId, body()); flash(`Lote autorizado: ${b.items.length} historia(s)`); onCreated(); navigate(`/lotes/${b.id}`); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
  const g = req.git ?? {};
  return (
    <section className="card" data-testid="batch-wizard">
      <div className="card-h"><div className="h3">Nuevo lote</div><button className="xbtn" onClick={onClose} aria-label="Cerrar">{Icon.x(16)}</button></div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {err && <Notice kind="err">{err}</Notice>}
        <div><div className="eyebrow" style={{ marginBottom: 6 }}>1 · Historias y orden</div>
          {!items.length ? <div className="small muted">No hay historias pendientes en el backlog.</div> :
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto' }}>
              {items.map(i => <label key={i.id} className="ck" style={{ gap: 8 }}><input className="cb" type="checkbox" checked={sel.includes(i.id)} onChange={() => toggle(i.id)} /><span><span className="mono small">{i.storyId}</span> {i.title}{i.dependsOn ? <span className="small muted"> · depende de {i.dependsOn}</span> : null}{i.estimate ? <span className="small muted"> · {i.estimate}</span> : null}</span></label>)}
            </div>}
          {sel.length > 0 && <ol className="small" style={{ margin: '8px 0 0', paddingLeft: 20 }}>{sel.map(id => <li key={id}><span className="mono">{byId.get(id)?.storyId}</span> {byId.get(id)?.title} <select className="input" style={{ height: 26, width: 'auto', display: 'inline-block', fontSize: 12 }} aria-label={`Depende de (${byId.get(id)?.storyId})`} value={byId.get(id)?.dependsOn ?? ''} onChange={e => void setDep(id, e.target.value || null)}><option value="">sin dependencia</option>{all.filter(o => o.id !== id).map(o => <option key={o.id} value={o.storyId}>depende de {o.storyId}</option>)}</select> <button className="btn btn-ghost btn-sm" onClick={() => move(id, -1)} aria-label="Subir">↑</button><button className="btn btn-ghost btn-sm" onClick={() => move(id, 1)} aria-label="Bajar">↓</button></li>)}</ol>}
          <div className="small muted">El plan respeta «depende de» aunque el orden diga otra cosa; a igualdad, usa este orden.</div>
        </div>
        <div><div className="eyebrow" style={{ marginBottom: 6 }}>2 · Límites (nunca ilimitados)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: 12 }}>
            {num('totalBudgetUsd', 'Presupuesto total (USD)', 0.1, BATCH_LIMITS.maxTotalUsd, 0.5)}
            {num('perStoryBudgetUsd', 'Tope por historia (USD)', 0.1, BATCH_LIMITS.maxPerStoryUsd, 0.5)}
            {num('maxCorrections', 'Correcciones por historia', 0, BATCH_LIMITS.maxCorrections)}
            {num('maxDurationMin', 'Duración máx. del lote (min)', 5, BATCH_LIMITS.maxDurationMin, 5)}
            {num('concurrency', 'Historias a la vez', 1, BATCH_LIMITS.maxConcurrency)}
            {num('maxSubscriptionCalls', 'Llamadas a la suscripción (tope)', 0, BATCH_LIMITS.maxSubscriptionCalls)}
          </div>
          <div className="small" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
            <span className="muted">Orígenes permitidos:</span>
            {(['api', 'claude_code'] as const).map(b => <label key={b} className="ck" style={{ gap: 4 }}><input className="cb" type="checkbox" checked={req.backends!.includes(b)} onChange={e => set({ backends: e.target.checked ? [...req.backends!, b] : req.backends!.filter(x => x !== b) })} /><span>{b === 'api' ? 'API (facturable)' : 'Claude Code (suscripción)'}</span></label>)}
            <span className="muted">· nunca se cambia de origen por su cuenta.</span>
          </div>
          <div className="small" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
            <span className="muted">Verificación:</span>
            {(['typecheck', 'test', 'build'] as const).map(c => <label key={c} className="ck" style={{ gap: 4 }}><input className="cb" type="checkbox" checked={req.commands!.includes(c)} onChange={e => set({ commands: e.target.checked ? (['typecheck', 'test', 'build'] as const).filter(x => x === c || req.commands!.includes(x)) : req.commands!.filter(x => x !== c) })} /><span>{c}</span></label>)}
            <label className="ck" style={{ gap: 4 }}><input className="cb" type="checkbox" checked={!!req.allowInstall} onChange={e => set({ allowInstall: e.target.checked })} /><span>instalar dependencias con red temporal si faltan</span></label>
          </div>
        </div>
        <div><div className="eyebrow" style={{ marginBottom: 6 }}>3 · Evaluación Gauntlet</div>
          <div role="radiogroup" aria-label="Modo Gauntlet del lote" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['off', 'standard', 'deep'] as const).map(m => <label key={m} className="ck" style={{ gap: 6 }}><input type="radio" name="batch-gauntlet" checked={req.gauntlet!.mode === m} onChange={() => set({ gauntlet: normalizeGauntlet({ mode: m }) as GauntletConfig })} /><span><strong>{GAUNTLET_MODE[m].label}</strong> <span className="small muted">{GAUNTLET_MODE[m].help}</span></span></label>)}
          </div>
        </div>
        <div><div className="eyebrow" style={{ marginBottom: 6 }}>4 · Operaciones git pre-autorizadas</div>
          <label className="ck"><input className="cb" type="checkbox" checked={!!g.merge} onChange={e => set({ git: { ...g, merge: e.target.checked } })} /><span><strong>Integrar en main</strong> cada historia terminada técnicamente, de una en una y con las mismas verificaciones que la integración manual. Sin esto, integrar sigue siendo tuyo (y las dependientes esperan).</span></label>
          {internal && <label className="ck"><input className="cb" type="checkbox" checked={!!g.activate} disabled={!g.merge} onChange={e => set({ git: { ...g, activate: e.target.checked } })} /><span><strong>Activar en el Portal</strong> (reconstruir y reiniciar) cuando no haya nada en marcha, y comprobarlo en ejecución al volver.</span></label>}
          <label className="ck"><input className="cb" type="checkbox" checked={!!g.publish} disabled={!g.merge} onChange={e => set({ git: { ...g, publish: e.target.checked } })} /><span><strong>Publicar en GitHub</strong> tras integrar (desactivado por defecto; es una operación externa).</span></label>
        </div>
        <div style={{ display: 'flex', gap: 10 }}><button className="btn btn-secondary" onClick={doPreview} disabled={!sel.length || busy}>{busy && !preview ? <span className="spin" /> : null}Vista previa del plan (sin IA)</button></div>
        {preview && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="batch-preview">
          {preview.warnings.map((w, i) => <Notice key={i} kind="warn">{w}</Notice>)}
          <table className="tbl"><thead><tr><th>#</th><th>Historia</th><th>Oleada</th><th>Depende de</th><th>Estimación</th><th>Orígenes</th><th>Estado</th></tr></thead><tbody>
            {preview.plan.map(p => <tr key={p.id}><td className="mono">{p.order + 1}</td><td><span className="mono small">{p.storyId}</span> {p.title}</td><td className="mono">{p.wave + 1}</td><td className="small">{p.dependsOn ?? '—'}{p.dependsInBatch ? ' (en el lote)' : ''}</td><td className="mono">{p.estimatedUsd == null ? '—' : `≈ ${fmtUsd(p.estimatedUsd)}`}</td><td className="small">{p.backends.join(', ')}{p.disallowedBackends.length ? <Chip xs tone="err">no autorizado</Chip> : null}</td><td className="small">{p.blockedReason ? <Chip xs tone="err">bloqueada</Chip> : 'se ejecutará'}{p.blockedReason ? ` ${p.blockedReason}` : ''}{p.error ? ` · ${p.error}` : ''}</td></tr>)}
          </tbody></table>
          <div className="small">Estimación total ≈ <strong className="mono">{fmtUsd(preview.estimateUsd)}</strong> · Gauntlet por historia: {preview.gauntletOverheadPerStory.evaluations.max ? `${preview.gauntletOverheadPerStory.evaluations.min}–${preview.gauntletOverheadPerStory.evaluations.max} evaluación(es) y hasta ${preview.gauntletOverheadPerStory.corrections.max} corrección(es) más` : 'sin sobrecoste'}.</div>
          <label className="ck"><input className="cb" type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /><span>Autorizo este lote: {sel.length} historia(s), hasta <strong>{fmtUsd(req.totalBudgetUsd)}</strong> en total ({fmtUsd(req.perStoryBudgetUsd)} por historia), {req.maxCorrections} corrección(es), Gauntlet {GAUNTLET_MODE[req.gauntlet!.mode].label.toLowerCase()}, {req.concurrency} a la vez, {req.maxDurationMin} min; integrar {g.merge ? 'sí' : 'no'}{internal ? `, activar ${g.activate ? 'sí' : 'no'}` : ''}, publicar {g.publish ? 'sí' : 'no'}. Puedo pausarlo, cancelarlo o revocarlo en cualquier momento.</span></label>
          <div><button className="btn btn-primary" onClick={authorize} disabled={!ok || busy || preview.plan.every(p => !!p.blockedReason)}>{busy ? <span className="spin spin-light" /> : Icon.arrow()}Autorizar lote</button></div>
        </div>}
      </div>
    </section>
  );
}

/** Monitor del lote y revisión de aceptación (una o varias), con pausa, reanudación, cancelación y revocación. */
export function BatchDetail() {
  const { status, flash } = useApp();
  const ws = status.workspace!; const { batchId } = useParams();
  const [b, setB] = useState<BatchView | null>(null); const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [addBudget, setAddBudget] = useState('0'); const [addCalls, setAddCalls] = useState('0'); const [resumeOk, setResumeOk] = useState(false);
  const [revoking, setRevoking] = useState(false); const [revokeReason, setRevokeReason] = useState('');
  const [picked, setPicked] = useState<string[]>([]); const [checks, setChecks] = useState<Record<string, boolean[]>>({}); const [note, setNote] = useState('');
  const load = () => api.batch(ws.slug, batchId!).then(x => { setB(x); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => { void load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [ws.slug, batchId]);
  const act = async (fn: () => Promise<BatchView>, ok: string) => { setBusy(true); try { setB(await fn()); flash(ok); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } };
  if (!b) return <Shell crumb="Ejecución continua"><main className="page">{err ? <Notice kind="err">{err}</Notice> : <span className="spin" />}</main></Shell>;
  const st = STATUS[b.status]; const closed = b.status === 'cancelled' || b.status === 'revoked';
  const pct = (n: number) => `${Math.min(100, Math.round((n / Math.max(0.0001, b.auth.totalBudgetUsd)) * 100))}%`;
  return (
    <Shell crumb={`Ejecución continua / ${b.title}`}>
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 18 }} data-testid="batch-detail">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><div className="eyebrow"><Link className="lnk" to="/lotes">Ejecución continua</Link></div><h1 className="h1" style={{ fontSize: 24 }}>{b.title}</h1>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}><Chip tone={st.tone}>{st.label}</Chip><Chip xs>Gauntlet {GAUNTLET_MODE[b.auth.gauntlet.mode].label.toLowerCase()}</Chip><Chip xs>{b.auth.concurrency} a la vez</Chip><Chip xs>integrar {b.auth.git.merge ? 'sí' : 'no'}</Chip>{b.auth.git.activate && <Chip xs>activar sí</Chip>}<Chip xs>publicar {b.auth.git.publish ? 'sí' : 'no'}</Chip></div></div>
          {!closed && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {b.status === 'running' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act(() => api.batchControl(ws.slug, b.id, 'pause'), 'Lote en pausa')}>Pausar</button>}
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api.batchControl(ws.slug, b.id, 'cancel'), 'Lote cancelado')}>Cancelar lote</button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRevoking(r => !r)} aria-expanded={revoking}>Revocar autorización…</button>
          </div>}
        </div>
        {revoking && !closed && <section className="card card-b" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="small">Revocar detiene lo que está en marcha, cancela lo pendiente y nada terminado se integra, activa ni publica solo.</span>
          <input className="input" placeholder="Motivo (opcional)" value={revokeReason} onChange={e => setRevokeReason(e.target.value)} style={{ flex: '1 1 220px', height: 32 }} />
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setRevoking(false); void act(() => api.batchControl(ws.slug, b.id, 'revoke', { reason: revokeReason }), 'Autorización revocada'); }}>Revocar</button>
        </section>}
        {b.reason && <Notice kind={b.status === 'paused' ? 'warn' : b.status === 'revoked' ? 'err' : 'info'}>{b.reason}</Notice>}
        {(b.status === 'paused' || b.status === 'completed') && !closed && b.items.some(i => ['queued', 'waiting_dependency', 'needs_owner', 'awaiting_integration'].includes(i.state)) && <section className="card card-b" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>Añadir presupuesto (USD)<input className="input mono" type="number" min={0} step={0.5} value={addBudget} onChange={e => setAddBudget(e.target.value)} style={{ width: 120, height: 32 }} /></label>
          <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>Añadir llamadas a la suscripción<input className="input mono" type="number" min={0} value={addCalls} onChange={e => setAddCalls(e.target.value)} style={{ width: 120, height: 32 }} /></label>
          <label className="ck" style={{ flex: '1 1 260px' }}><input className="cb" type="checkbox" checked={resumeOk} onChange={e => setResumeOk(e.target.checked)} /><span>Autorizo reanudar con estos límites (la duración autorizada cuenta desde ahora).</span></label>
          <button className="btn btn-primary btn-sm" disabled={!resumeOk || busy} onClick={() => { setResumeOk(false); void act(() => api.batchControl(ws.slug, b.id, 'resume', { addBudgetUsd: Number(addBudget) || 0, addSubscriptionCalls: Number(addCalls) || 0 }), 'Lote reanudado'); }}>Reanudar</button>
        </section>}
        <section className="card card-b" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{(Object.keys(b.summary) as BatchItemState[]).filter(k => b.summary[k]).map(k => <Chip key={k} xs tone={TONE[k]}>{b.summary[k]} {b.items.find(i => i.state === k)?.label}</Chip>)}</div>
          <div className="small">Gasto {fmtUsd(b.budget.spent)} · reservado {fmtUsd(b.budget.reserved)} · disponible {fmtUsd(b.budget.remaining)} de {fmtUsd(b.auth.totalBudgetUsd)} (máx. {fmtUsd(b.auth.perStoryBudgetUsd)} por historia) · suscripción {b.subscriptionCalls}/{b.auth.maxSubscriptionCalls} llamadas</div>
          <div style={{ height: 6, background: '#EEECE6', borderRadius: 4, overflow: 'hidden', display: 'flex' }} aria-hidden><span style={{ width: pct(b.budget.spent), background: '#1F6F5C' }} /><span style={{ width: pct(b.budget.reserved), background: '#9CC7B9' }} /></div>
        </section>
        {GROUPS.map(gr => { const its = b.items.filter(i => gr.states.includes(i.state)); if (!its.length) return null; return (
          <section key={gr.label} className="card">
            <div className="card-h"><div className="h3">{gr.label}</div><span className="small muted">{its.length}</span></div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {gr.states.includes('awaiting_acceptance') && <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="input" placeholder="Nota de aceptación (opcional)" value={note} onChange={e => setNote(e.target.value)} style={{ flex: '1 1 260px', height: 32 }} />
                <button className="btn btn-primary btn-sm" disabled={!picked.length || busy} onClick={() => { const ids = picked; setPicked([]); void act(() => api.acceptBatchItems(ws.slug, b.id, ids, note, Object.fromEntries(ids.filter(id => checks[id]).map(id => [id, checks[id]]))), `${ids.length} historia(s) aceptada(s)`); }}>{Icon.check()}Aceptar seleccionadas ({picked.length})</button>
              </div>}
              {its.map(it => <ItemCard key={it.itemId} slug={ws.slug} b={b} it={it} picked={picked.includes(it.itemId)} onPick={v => setPicked(p => v ? [...p, it.itemId] : p.filter(x => x !== it.itemId))} checks={checks[it.itemId]} onChecks={c => setChecks(x => ({ ...x, [it.itemId]: c }))} onChange={setB} busy={busy} />)}
            </div>
          </section>); })}
        <section className="card">
          <div className="card-h"><div className="h3">Registro del lote</div><span className="small muted">auditable</span></div>
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
            {[...b.events].reverse().slice(0, 80).map((e, i) => <div key={i} className="small"><span className="mono muted">{when(e.at)}</span> · {e.message}</div>)}
          </div>
        </section>
      </main>
    </Shell>
  );
}

function ItemCard({ slug, b, it, picked, onPick, checks, onChecks, onChange, busy }: { slug: string; b: BatchView; it: BatchItemView; picked: boolean; onPick: (v: boolean) => void; checks?: boolean[]; onChecks: (c: boolean[]) => void; onChange: (b: BatchView) => void; busy: boolean }) {
  const { flash } = useApp();
  const [mode, setMode] = useState<'reject' | 'iterate' | null>(null); const [text, setText] = useState(''); const [auth, setAuth] = useState(false);
  const p = it.process; const steps = p?.manualTest?.steps ?? []; const c = checks ?? steps.map(() => false);
  const run = async (fn: () => Promise<BatchView>, ok: string) => { try { onChange(await fn()); flash(ok); setMode(null); setText(''); setAuth(false); } catch (e: any) { flash(e.message, 'err'); } };
  const canIterate = ['rejected', 'needs_owner', 'failed', 'awaiting_acceptance', 'awaiting_integration'].includes(it.state) && b.status !== 'cancelled' && b.status !== 'revoked';
  return (
    <div style={{ border: '1px solid #E4E2DC', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }} data-testid={`batch-item-${it.storyId}`}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {it.state === 'awaiting_acceptance' && <input className="cb" type="checkbox" checked={picked} onChange={e => onPick(e.target.checked)} aria-label={`Seleccionar ${it.storyId}`} />}
        <span className="mono small">{it.storyId}</span><strong className="sm13" style={{ flex: 1 }}>{it.title}</strong>
        <Chip xs tone={TONE[it.state]}>{it.label}</Chip>
        {p && <Link className="lnk small" to={`/procesos/${p.id}`}>proceso</Link>}
      </div>
      {it.reason && <div className="small muted">{it.reason}</div>}
      {p && <div className="small" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <span>Implementa: <strong>{p.implementer ?? '—'}</strong></span>
        <span>Evalúa: <strong>{p.evaluator ?? (p.gauntlet ? '—' : 'sin Gauntlet')}</strong>{p.gauntlet ? ` (${GSTATUS[p.gauntlet.status] ?? p.gauntlet.status}, ${p.gauntlet.rounds} ronda/s)` : ''}</span>
        <span>QA: {p.review ? QA[p.review] ?? p.review : '—'}</span>
        <span>Gasto: <span className="mono">{fmtUsd(p.spentUsd)}{p.unconfirmedUsd ? ` (+${fmtUsd(p.unconfirmedUsd)} sin confirmar)` : ''}</span></span>
        {p.merged && <span>main: <span className="mono">{p.merged.commit}</span></span>}
      </div>}
      {it.state === 'awaiting_acceptance' && <>
        {p?.userFacing && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{p.userFacing}</div>}
        {steps.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><div className="small muted">Prueba de aceptación (marca cada paso que comprobaste):</div>
          {steps.map((s, i) => <label key={i} className="ck small" style={{ gap: 6 }}><input className="cb" type="checkbox" checked={!!c[i]} onChange={e => { const n = [...c]; n[i] = e.target.checked; onChecks(n); }} /><span>{i + 1}. {s}</span></label>)}</div>}
      </>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(it.state === 'awaiting_acceptance' || it.state === 'accepted') && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setMode('reject'); setText(''); }}>No aceptar…</button>}
        {it.state === 'accepted' && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.reopenBatchItem(slug, b.id, it.itemId), `${it.storyId} reabierta`)}>Reabrir</button>}
        {canIterate && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setMode('iterate')}>Iterar solo esta…</button>}
        {['queued', 'waiting_dependency', 'running', 'needs_owner', 'blocked'].includes(it.state) && b.status !== 'cancelled' && b.status !== 'revoked' && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.cancelBatchItem(slug, b.id, it.itemId), `${it.storyId} cancelada`)}>Cancelar esta</button>}
      </div>
      {mode && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea className="input" placeholder={mode === 'reject' ? 'Qué no cumple (se registra en la historia)' : 'Qué debe cambiar en la nueva iteración'} value={text} onChange={e => setText(e.target.value)} />
        {mode === 'reject' && steps.some((_, i) => !c[i]) && <div className="small muted">Se crearán tareas con los pasos sin marcar: {steps.filter((_, i) => !c[i]).map((s, i) => <span key={i}>«{s}» </span>)}</div>}
        {mode === 'iterate' && <label className="ck small"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo una iteración de esta historia dentro de los límites del lote (las demás no se repiten).</span></label>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary btn-sm" disabled={text.trim().length < 3 || (mode === 'iterate' && !auth)} onClick={() => mode === 'reject'
            ? run(() => api.rejectBatchItem(slug, b.id, it.itemId, text.trim(), steps.filter((_, i) => !c[i])), `${it.storyId}: no aceptada`)
            : run(() => api.iterateBatchItem(slug, b.id, it.itemId, text.trim()), `${it.storyId}: iteración en cola`)}>{mode === 'reject' ? 'Registrar no aceptación' : 'Iterar'}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setMode(null)}>Cancelar</button>
        </div>
      </div>}
    </div>
  );
}

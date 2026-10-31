import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { BacklogItem, BatchItemState, BatchItemView, BatchPreview, BatchView, GauntletConfig } from '@portal-ia/domain';
import { BATCH_LIMITS, INTERNAL_WORKSPACE, batchMoving, normalizeGauntlet } from '@portal-ia/domain';
import { api, type BatchRequest } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { GAUNTLET_MODE } from '../components/Gauntlet.tsx';
import { BatchStoryPicker, STATUS_LABEL } from '../components/BatchStoryPicker.tsx';
import { Chip, DraftNote, Icon, Notice } from '../components/ui.tsx';
import { draftKey, useDraft, usePersistentState } from '../lib/persist.ts';

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
  const [list, setList] = useState<BatchView[] | null>(null);
  // El asistente abierto (y su borrador) sobreviven a recargar o ir a otra pantalla y volver.
  const [creating, setCreating] = usePersistentState(`portal-ia.lotes.asistente.${ws.slug}.${projectId}`, false);
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

const ROLE: Record<string, string> = { planner: 'plan', consultant: 'consulta', implementer: 'implementa', reviewer: 'QA', evaluator: 'Gauntlet' };
const range = (r: { min: number; max: number }) => r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`;
const minutes = (m: number) => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;

/** Valores de un lote nuevo: nada facturable, ni integrar, activar, publicar ni ceder a la API. */
const NEW_BATCH: Omit<BatchRequest, 'itemIds'> = { totalBudgetUsd: 5, perStoryBudgetUsd: 1.5, maxCorrections: 3, maxDurationMin: 240, maxSubscriptionCalls: 60, concurrency: 1, gauntlet: normalizeGauntlet({ mode: 'auto' }), backends: ['claude_code'], apiFallback: false, commands: ['typecheck', 'test', 'build'], allowInstall: false, git: { merge: false, activate: false, publish: false } };

/**
 * Asistente del lote: historias (búsqueda, filtros y selección masiva para cientos), equipo y orígenes por agente,
 * límites, Gauntlet y operaciones git; a la derecha, un resumen persistente con la vista previa sin IA (se actualiza
 * sola tras cada cambio) y la autorización explícita. Nada se hereda de lotes anteriores.
 */
function BatchWizard({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { status, flash, navigate } = useApp();
  const ws = status.workspace!; const projectId = status.project!.id;
  const internal = ws.slug === INTERNAL_WORKSPACE.slug;
  const [all, setAll] = useState<BacklogItem[] | null>(null);
  // Valores seguros en CADA lote nuevo: la API (facturable), integrar, activar, publicar y ceder a la API, desmarcados.
  // El borrador (historias, orden, límites, Gauntlet, orígenes y preferencias git) se guarda en este navegador para esta
  // empresa y este proyecto; la casilla de autorización NO: un borrador recuperado nunca autoriza nada.
  const draft = useDraft(draftKey('lote', ws.slug, projectId), { sel: [] as string[], custom: false, req: NEW_BATCH }, { revive: d => ({ sel: Array.isArray(d.sel) ? d.sel : [], custom: !!d.custom, req: { ...NEW_BATCH, ...d.req } }) });
  const { sel, custom, req } = draft.value;
  const setSel = (f: string[] | ((s: string[]) => string[])) => draft.set(d => ({ ...d, sel: typeof f === 'function' ? f(d.sel) : f }));
  const setCustom = (c: boolean) => draft.set(d => ({ ...d, custom: c }));
  const setReq = (f: (r: typeof req) => typeof req) => draft.set(d => ({ ...d, req: f(d.req) }));
  const [preview, setPreview] = useState<BatchPreview | null>(null); const [fresh, setFresh] = useState(false);
  const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [editDep, setEditDep] = useState<{ id: string; value: string } | null>(null);
  const [owners, setOwners] = useState<Map<string, string>>(new Map());
  const loadItems = () => api.backlog(ws.slug, projectId).then(list => setAll(list.filter(i => !i.archivedAt))).catch(e => setErr(e.message));
  useEffect(() => { void loadItems(); api.agents(ws.slug).then(a => setOwners(new Map(a.map(x => [x.key, x.config.name])))).catch(() => undefined); }, [ws.slug, projectId]);
  const items = all ?? [];
  const pos = useMemo(() => new Map(items.map((i, n) => [i.id, n])), [items]);
  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
  const byPos = (a: string, b: string) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0);
  // Orden: el del backlog (su prioridad) salvo que lo cambies a mano; el plan pone siempre las dependencias antes.
  const add = (ids: string[]) => setSel(s => { const next = [...s, ...ids.filter(id => !s.includes(id))]; return custom ? next : next.sort(byPos); });
  const remove = (ids: string[]) => { const r = new Set(ids); setSel(s => s.filter(id => !r.has(id))); };
  const move = (id: string, d: -1 | 1) => { setCustom(true); setSel(s => { const i = s.indexOf(id); const j = i + d; if (j < 0 || j >= s.length) return s; const c = [...s]; [c[i], c[j]] = [c[j], c[i]]; return c; }); };
  const toTop = (id: string) => { setCustom(true); setSel(s => [id, ...s.filter(x => x !== id)]); };
  const resetOrder = () => { setCustom(false); setSel(s => [...s].sort(byPos)); };
  // «Depende de» se guarda en la historia (el plan del lote lo respeta siempre, también en lotes futuros).
  const saveDep = async (id: string, dependsOn: string | null) => { try { await api.patchBacklogItem(ws.slug, id, { dependsOn }); setEditDep(null); await loadItems(); setSel(s => [...s]); } catch (e: any) { setErr(e.message); } };
  const set = (patch: Partial<typeof req>) => setReq(r => ({ ...r, ...patch }));
  // Vista previa automática y sin IA: una petición tras cada ráfaga de cambios; cualquier cambio desmarca la autorización.
  const seq = useRef(0);
  useEffect(() => {
    setOk(false); setFresh(false);
    if (!sel.length || !req.backends?.length) { setPreview(null); return; }
    const n = ++seq.current;
    const t = setTimeout(() => {
      api.previewBatch(ws.slug, projectId, { ...req, itemIds: sel })
        .then(p => { if (n === seq.current) { setPreview(p); setFresh(true); setErr(null); } })
        .catch(e => { if (n === seq.current) { setPreview(null); setErr(e.message); } });
    }, 350);
    return () => clearTimeout(t);
  }, [sel, req, ws.slug, projectId]);
  // Un borrador recuperado puede nombrar historias que ya no se pueden elegir (terminadas, en curso…): se retiran.
  useEffect(() => { if (all) { const ok0 = new Set(all.filter(i => !['in_progress', 'review', 'done', 'discarded'].includes(i.status)).map(i => i.id)); if (sel.some(id => !ok0.has(id))) setSel(s => s.filter(id => ok0.has(id))); } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all]);
  // Autorizado: el borrador cumplió su función y se borra (el siguiente lote empieza con los valores seguros).
  const authorize = async () => { setBusy(true); setErr(null); try { const b = await api.createBatch(ws.slug, projectId, { ...req, itemIds: sel }); draft.clear(); flash(`Lote autorizado: ${b.items.length} historia(s)`); onCreated(); navigate(`/lotes/${b.id}`); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const num = (k: 'totalBudgetUsd' | 'perStoryBudgetUsd' | 'maxCorrections' | 'maxDurationMin' | 'maxSubscriptionCalls' | 'concurrency', label: string, min: number, max: number, step = 1) =>
    <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{label}<input className="input mono" type="number" min={min} max={max} step={step} value={req[k] as number} onChange={e => set({ [k]: Math.max(min, Math.min(max, Number(e.target.value) || min)) } as any)} style={{ height: 32 }} /></label>;
  const g = req.git ?? {};
  const sum = fresh ? preview?.summary ?? null : null;
  const agents = preview?.summary.agents ?? [];
  const usedBy = (src: 'api' | 'claude_code') => agents.filter(a => a.source === src).map(a => a.name);
  const fallbackOn = !!req.apiFallback && req.backends!.includes('api') && preview?.summary.connector.fallback === 'api';
  const notReady = (preview?.plan ?? []).filter(p => !p.blockedReason && !p.executable).map(p => p.id);
  const autoCount = sum ? sum.executable - sum.waitForManualIntegration.length : 0;
  const blockReason = !sel.length ? null : !req.backends?.length ? 'Marca al menos un origen de ejecución (sección 2).' : !fresh ? 'Actualizando la vista previa…' : !sum ? 'Sin vista previa.' : sum.blockedByPermission ? `Hay ${sum.blockedByPermission} historia(s) cuyo equipo no puede ejecutar con lo autorizado: corrígelo (sección 2) o quítalas.` : !sum.executable ? 'Ninguna historia puede empezar.' : !ok ? 'Marca la casilla de autorización.' : null;
  const autonomous = sum ? [`Ejecutar ${autoCount} historia(s) con su equipo: plan, implementación en un worktree aislado, verificación en el sandbox y QA`, req.gauntlet!.mode === 'auto' ? 'Gauntlet automático: cada historia con la intensidad que le corresponde (en el plan detallado, con el motivo)' : req.gauntlet!.mode !== 'off' ? `Evaluación Gauntlet ${GAUNTLET_MODE[req.gauntlet!.mode].label.toLowerCase()}` : null, `Hasta ${req.maxCorrections} corrección(es) por historia`, g.merge ? 'Integrar en main cada historia terminada (de una en una, con las mismas verificaciones)' : null, internal && g.activate ? 'Reconstruir y reiniciar el Portal tras integrar (sin nada en marcha)' : null, g.publish ? 'Publicar en GitHub tras integrar' : null, fallbackOn ? 'Ceder a la API (facturable) si Claude Code no está disponible' : null].filter(Boolean) as string[] : [];
  const yours = [!g.merge ? 'Integrar en main' : null, internal && !g.activate ? 'Reconstruir y reiniciar el Portal' : null, !g.publish ? 'Publicar en GitHub' : null, 'Aceptar (o no) cada historia: es distinto de QA', 'Ampliar presupuesto, tope de llamadas o duración', 'Lo que se detenga: conflictos, fallos o límites'].filter(Boolean) as string[];
  return (
    <section className="card" data-testid="batch-wizard">
      <div className="card-h"><div className="h3">Nuevo lote</div><button className="xbtn" onClick={onClose} aria-label="Cerrar">{Icon.x(16)}</button></div>
      <div className="card-b">
        <DraftNote status={draft.status} onDiscard={draft.clear} />
        {draft.status === 'restored' && (g.merge || g.publish || g.activate || req.backends?.includes('api') || req.apiFallback || req.allowInstall) && <Notice kind="warn">El borrador recuperado tiene marcado: {[g.merge && 'integrar en main', g.activate && 'reconstruir y reiniciar', g.publish && 'publicar en GitHub', req.backends?.includes('api') && 'la API (facturable)', req.apiFallback && 'ceder a la API', req.allowInstall && 'instalar con red'].filter(Boolean).join(', ')}. Son preferencias guardadas, no permisos: revísalas; nada se hace hasta que marques la casilla de autorización.</Notice>}
        <div className="bw-layout">
          <div className="bw-main">
            <div className="bw-section">
              <div className="eyebrow">1 · Historias</div>
              {!all ? <span className="spin" /> : !items.some(i => i.status === 'pending' || i.status === 'blocked') ? <div className="small muted">No hay historias pendientes en el backlog.</div> :
                <BatchStoryPicker items={items} owners={owners} selected={sel} onAdd={add} onRemove={remove} onClear={() => setSel([])} persistKey={`portal-ia.lote.filtros.${ws.slug}.${projectId}`} />}
              {sel.length > 0 && <details open={sel.length <= 12} data-testid="batch-order">
                <summary className="small" style={{ cursor: 'pointer' }}><strong>Orden de la selección ({sel.length})</strong> · {custom ? 'orden manual' : 'orden del backlog (su prioridad)'}; el plan pone siempre las dependencias antes</summary>
                <div className="small muted" style={{ display: 'flex', gap: 8, margin: '6px 0', alignItems: 'center', flexWrap: 'wrap' }}>{custom && <button type="button" className="btn btn-ghost btn-sm" onClick={resetOrder}>Volver al orden del backlog</button>}<span>Cambiar «depende de» se guarda en la historia del backlog (también para lotes futuros), aunque no autorices este lote.</span></div>
                <datalist id="bw-story-ids">{items.map(i => <option key={i.id} value={i.storyId}>{i.title}</option>)}</datalist>
                <ol className="bw-selected">
                  {sel.map((id, n) => { const it = byId.get(id); if (!it) return null; return (
                    <li key={id}>
                      <span className="mono small muted" style={{ width: 28, textAlign: 'right' }}>{n + 1}</span>
                      <span className="bw-sel-title"><span className="mono small">{it.storyId}</span> {it.title}</span>
                      {editDep?.id === id
                        ? <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input className="input mono" list="bw-story-ids" style={{ height: 26, width: 96, fontSize: 12 }} aria-label={`Depende de (${it.storyId})`} value={editDep.value} onChange={e => setEditDep({ id, value: e.target.value.trim().toUpperCase() })} />
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void saveDep(id, editDep.value || null)}>Guardar</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditDep(null)}>Cancelar</button></span>
                        : <button type="button" className="lnk small" onClick={() => setEditDep({ id, value: it.dependsOn ?? '' })} aria-label={`Cambiar «depende de» de ${it.storyId}`}>{it.dependsOn ? `depende de ${it.dependsOn}` : 'sin dependencia'}</button>}
                      <button type="button" className="bw-icon-btn" onClick={() => toTop(id)} disabled={n === 0} aria-label={`Mover ${it.storyId} al principio`} title="Al principio">⤒</button>
                      <button type="button" className="bw-icon-btn" onClick={() => move(id, -1)} disabled={n === 0} aria-label={`Subir ${it.storyId}`}>↑</button>
                      <button type="button" className="bw-icon-btn" onClick={() => move(id, 1)} disabled={n === sel.length - 1} aria-label={`Bajar ${it.storyId}`}>↓</button>
                      <button type="button" className="bw-icon-btn" onClick={() => remove([id])} aria-label={`Quitar ${it.storyId} de la selección`}>×</button>
                    </li>); })}
                </ol>
              </details>}
            </div>

            <div className="bw-section" data-testid="batch-sources">
              <div className="eyebrow">2 · Equipo y orígenes de ejecución</div>
              <div className="small muted">El origen es de cada agente (se cambia en <Link className="lnk" to="/equipo">Equipo de IA</Link>). Aquí autorizas qué orígenes puede usar este lote; nunca cambia de origen por su cuenta.</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(['claude_code', 'api'] as const).map(b => <label key={b} className="ck"><input className="cb" type="checkbox" checked={req.backends!.includes(b)} onChange={e => set({ backends: e.target.checked ? [...req.backends!, b] : req.backends!.filter(x => x !== b), ...(b === 'api' && !e.target.checked ? { apiFallback: false } : {}) })} />
                  <span><strong>{b === 'api' ? 'API del proveedor (facturable, en USD)' : 'Claude Code (tu suscripción)'}</strong>{preview ? <span className="muted"> · {usedBy(b).length ? `lo usan: ${usedBy(b).join(', ')}` : 'ningún agente del lote lo usa'}</span> : null}</span></label>)}
                {preview?.summary.connector.fallback === 'api'
                  ? <label className="ck"><input className="cb" type="checkbox" checked={!!req.apiFallback} disabled={!req.backends!.includes('api')} onChange={e => set({ apiFallback: e.target.checked })} /><span>Si Claude Code no está disponible, <strong>ceder a la API (facturable)</strong> en este lote. Desmarcado: el lote se pausa y decides tú.</span></label>
                  : <div className="small muted">Si Claude Code no está disponible, el lote se pausa (el conector no permite ceder a la API).</div>}
              </div>
              {agents.length > 0 && <div className="bw-table-wrap"><table className="tbl bw-agents" data-testid="batch-agents"><caption className="bw-sr">Agentes del lote y su origen</caption>
                <thead><tr><th scope="col">Agente</th><th scope="col">Hace</th><th scope="col">Origen</th><th scope="col">¿Puede ejecutar?</th></tr></thead>
                <tbody>{agents.map(a => <tr key={a.agentId}>
                  <td className="small"><strong>{a.name}</strong><div className="muted">{a.stories} historia(s)</div></td>
                  <td className="small">{a.roles.map(r => ROLE[r] ?? r).join(', ')}</td>
                  <td className="small">{a.label}</td>
                  <td className="small">{a.ready ? (a.viaFallback ? <><Chip xs tone="warn">por la API</Chip> {a.problem}</> : <Chip xs tone="ok">sí</Chip>) : <><Chip xs tone="err">no</Chip> {a.problem}{a.fix ? <> <Link className="lnk" to={a.fix.href}>{a.fix.label}</Link></> : null}</>}</td>
                </tr>)}</tbody></table></div>}
            </div>

            <div className="bw-section">
              <div className="eyebrow">3 · Límites (nunca ilimitados)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: 12 }}>
                {num('totalBudgetUsd', 'Presupuesto de API total (USD)', req.backends!.includes('api') ? 0.1 : 0, BATCH_LIMITS.maxTotalUsd, 0.5)}
                {num('perStoryBudgetUsd', 'Tope de API por historia (USD)', req.backends!.includes('api') ? 0.1 : 0, BATCH_LIMITS.maxPerStoryUsd, 0.5)}
                {num('maxSubscriptionCalls', 'Llamadas a la suscripción (tope)', 0, BATCH_LIMITS.maxSubscriptionCalls)}
                {num('maxCorrections', 'Correcciones por historia', 0, BATCH_LIMITS.maxCorrections)}
                {num('maxDurationMin', 'Duración máx. del lote (min)', 5, BATCH_LIMITS.maxDurationMin, 5)}
                {num('concurrency', 'Historias a la vez', 1, BATCH_LIMITS.maxConcurrency)}
              </div>
              <div className="small" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <span className="muted">Verificación:</span>
                {(['typecheck', 'test', 'build'] as const).map(c => <label key={c} className="ck" style={{ gap: 4 }}><input className="cb" type="checkbox" checked={req.commands!.includes(c)} onChange={e => set({ commands: e.target.checked ? (['typecheck', 'test', 'build'] as const).filter(x => x === c || req.commands!.includes(x)) : req.commands!.filter(x => x !== c) })} /><span>{c}</span></label>)}
                <label className="ck" style={{ gap: 4 }}><input className="cb" type="checkbox" checked={!!req.allowInstall} onChange={e => set({ allowInstall: e.target.checked })} /><span>instalar dependencias con red temporal si faltan</span></label>
              </div>
            </div>

            <div className="bw-section">
              <div className="eyebrow">4 · Evaluación Gauntlet</div>
              <div role="radiogroup" aria-label="Modo Gauntlet del lote" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(['auto', 'off', 'standard', 'deep'] as const).map(m => <label key={m} className="ck" style={{ gap: 6 }}><input type="radio" name="batch-gauntlet" checked={req.gauntlet!.mode === m} onChange={() => set({ gauntlet: normalizeGauntlet({ mode: m }) as GauntletConfig })} /><span><strong>{GAUNTLET_MODE[m].label}</strong> <span className="small muted">{GAUNTLET_MODE[m].help}</span></span></label>)}
              </div>
            </div>

            <div className="bw-section">
              <div className="eyebrow">5 · Operaciones git (solo con tu marca, en cada lote)</div>
              <label className="ck"><input className="cb" type="checkbox" checked={!!g.merge} onChange={e => set({ git: e.target.checked ? { ...g, merge: true } : { merge: false, activate: false, publish: false } })} /><span><strong>Integrar en main</strong> cada historia terminada técnicamente, de una en una y con las mismas verificaciones que la integración manual. Sin esto, integrar sigue siendo tuyo (y las dependientes esperan).</span></label>
              {internal && <label className="ck"><input className="cb" type="checkbox" checked={!!g.activate} disabled={!g.merge} onChange={e => set({ git: { ...g, activate: e.target.checked } })} /><span><strong>Reconstruir y reiniciar el Portal</strong> cuando no haya nada en marcha, y comprobarlo en ejecución al volver.{!g.merge ? ' (exige integrar)' : ''}</span></label>}
              <label className="ck"><input className="cb" type="checkbox" checked={!!g.publish} disabled={!g.merge} onChange={e => set({ git: { ...g, publish: e.target.checked } })} /><span><strong>Publicar en GitHub</strong> tras integrar: es una operación externa y visible.{!g.merge ? ' (exige integrar)' : ''}</span></label>
            </div>

            {preview && fresh && <details data-testid="batch-preview">
              <summary className="small" style={{ cursor: 'pointer' }}><strong>Plan detallado ({preview.plan.length} historia(s))</strong> · orden, oleadas, llamadas y motivo de cada una</summary>
              <div className="bw-table-wrap" style={{ marginTop: 8 }}><table className="tbl"><thead><tr><th>#</th><th>Historia</th><th>Oleada</th><th>Gauntlet</th><th>Llamadas</th><th>API</th><th>Estado</th></tr></thead><tbody>
                {preview.plan.map(p => <tr key={p.id}><td className="mono">{p.order + 1}</td><td className="small"><span className="mono">{p.storyId}</span> {p.title}{p.dependsOn ? <span className="muted"> · tras {p.dependsOn}{p.dependsInBatch ? '' : ' (fuera del lote)'}</span> : null}</td><td className="mono">{p.wave + 1}</td><td className="small" title={p.gauntlet?.reason ?? undefined}>{p.gauntlet ? GAUNTLET_MODE[p.gauntlet.mode].label : '—'}</td><td className="mono small">{range(p.calls)}</td><td className="mono small">{p.estimatedUsd == null ? '—' : fmtUsd(p.estimatedUsd)}</td>
                  <td className="small">{p.executable ? 'se ejecutará' : <><Chip xs tone="err">{p.blockedReason ? 'bloqueada' : 'no empezará'}</Chip> {p.problems.join(' ')}</>}</td></tr>)}
              </tbody></table></div>
            </details>}
          </div>

          <aside className="bw-aside" aria-label="Resumen del lote" id="bw-summary">
            <section className="card"><div className="card-b bw-sum" data-testid="batch-summary">
              <div className="h3">Resumen del lote</div>
              {!sel.length ? <div className="small muted">Elige historias: aquí verás qué empezará, con qué equipo, cuántas llamadas y qué gasto, y lo que seguirá siendo decisión tuya.</div> : !req.backends?.length ? <Notice kind="warn">Ningún origen autorizado: marca Claude Code, la API o ambos en la sección 2.</Notice> : !sum ? <div className="small muted"><span className="spin" /> Actualizando la vista previa (sin IA)…</div> : <>
                <div className="bw-kpis">
                  <div className="bw-kpi"><span className="small muted">Seleccionadas</span><b>{sum.selected}</b></div>
                  <div className="bw-kpi"><span className="small muted">Pueden empezar</span><b>{sum.executable}</b></div>
                  <div className="bw-kpi" data-tone={sum.blockedByDependency ? 'warn' : undefined}><span className="small muted">Bloqueadas por dependencias</span><b>{sum.blockedByDependency}</b></div>
                  <div className="bw-kpi" data-tone={sum.blockedByPermission ? 'err' : undefined}><span className="small muted">Sin permiso para empezar</span><b>{sum.blockedByPermission}</b></div>
                </div>
                {sum.blockedByPermission > 0 && <button type="button" className="btn btn-secondary btn-sm" onClick={() => remove(notReady)}>Quitar las {notReady.length} que no pueden empezar</button>}
                {(sum.waitForManualIntegration.length > 0 || sum.fits.min < autoCount) && <div className="small" data-testid="batch-capacity" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {sum.waitForManualIntegration.length > 0 && <Notice kind="warn"><span><strong>{sum.waitForManualIntegration.length}</strong> esperarán a que integres tú su dependencia (no marcaste «Integrar en main»): {sum.waitForManualIntegration.slice(0, 6).join(', ')}{sum.waitForManualIntegration.length > 6 ? '…' : ''}.</span></Notice>}
                  {sum.fits.min < autoCount && <Notice kind="warn"><span>Con estos límites, el lote se pausará tras ≈ <strong>{sum.fits.min === sum.fits.max ? sum.fits.max : `${sum.fits.min}–${sum.fits.max}`}</strong> de {autoCount} historias ({sum.fits.limitedBy.map(l => l === 'subscription' ? `tope de ${req.maxSubscriptionCalls} llamadas a la suscripción` : l === 'duration' ? `duración máxima de ${minutes(req.maxDurationMin!)}` : `presupuesto de ${fmtUsd(req.totalBudgetUsd)}`).join(' y ')}); después decides si lo amplías.</span></Notice>}
                  {sum.fits.min < autoCount && sum.fits.limitedBy.includes('duration') && sum.duration && <button type="button" className="btn btn-secondary btn-sm" onClick={() => set({ maxDurationMin: Math.min(BATCH_LIMITS.maxDurationMin, Math.ceil(autoCount / (req.concurrency ?? 1)) * sum.duration!.p75 + 5) })}>Subir la duración máxima a {minutes(Math.min(BATCH_LIMITS.maxDurationMin, Math.ceil(autoCount / (req.concurrency ?? 1)) * sum.duration.p75 + 5))}</button>}
                  {sum.fits.min < autoCount && sum.fits.limitedBy.includes('subscription') && <button type="button" className="btn btn-secondary btn-sm" onClick={() => set({ maxSubscriptionCalls: Math.min(BATCH_LIMITS.maxSubscriptionCalls, sum.subscriptionCalls.max) })}>Subir el tope de llamadas a {Math.min(BATCH_LIMITS.maxSubscriptionCalls, sum.subscriptionCalls.max)} (máximo estimado)</button>}
                </div>}
                <ul className="bw-list">
                  <li><strong>Llamadas a modelos:</strong> {range(sum.calls)} (mín. sin correcciones; máx. con las autorizadas; reparaciones y reintentos pueden sumar más).</li>
                  <li><strong>Suscripción de Claude Code:</strong> {range(sum.subscriptionCalls)} llamada(s) de un tope de {req.maxSubscriptionCalls}. No se cobra por llamada, pero <strong>consume la cuota de tu plan</strong>; el tope se comprueba antes de empezar cada historia.</li>
                  <li><strong>API (facturable):</strong> ≈ {sum.apiUsd.min === sum.apiUsd.max ? fmtUsd(sum.apiUsd.min) : `${fmtUsd(sum.apiUsd.min)} – ${fmtUsd(sum.apiUsd.max)}`} (con las correcciones autorizadas) de {fmtUsd(req.totalBudgetUsd)}; tope {fmtUsd(req.perStoryBudgetUsd)} por historia.{sum.worstCaseUsd > sum.apiUsd.max ? <> Si Claude Code cede a la API: hasta ≈ {fmtUsd(sum.worstCaseUsd)}.</> : null} Estimación orientativa, no un precio.</li>
                  <li><strong>Duración:</strong> {sum.duration ? <>≈ {minutes(sum.duration.minutes)} ({req.concurrency} a la vez). Por historia, {minutes(sum.duration.perStoryMinutes)} de mediana (entre {minutes(sum.duration.p25)} y {minutes(sum.duration.p75)}) en {sum.duration.samples} historias anteriores terminadas y verificadas. Orientativa.</> : 'sin historial suficiente (menos de 5 historias terminadas y verificadas en este proyecto) para estimarla.'}</li>
                </ul>
                {sum.missingDependencies.length > 0 && <div className="small" data-testid="batch-missing-deps"><strong>Dependencias que faltan</strong> (no se añaden solas):
                  <ul className="bw-list">{sum.missingDependencies.map(m => <li key={m.storyId}><span className="mono">{m.storyId}</span> {m.title ?? ''} <span className="muted">({m.status ? STATUS_LABEL[m.status] : 'no encontrada'}; la necesita{m.requiredBy.length > 1 ? 'n' : ''} {m.requiredBy.join(', ')})</span>{m.eligible && m.itemId ? <> <button type="button" className="lnk" onClick={() => add([m.itemId!])}>Añadir {m.storyId}</button></> : null}</li>)}</ul>
                  {sum.missingDependencies.filter(m => m.eligible && m.itemId).length > 1 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => add(sum.missingDependencies.filter(m => m.eligible && m.itemId).map(m => m.itemId!))}>Añadir las {sum.missingDependencies.filter(m => m.eligible && m.itemId).length} elegibles</button>}</div>}
                {sum.waves.length > 0 && <div className="small"><strong>Orden:</strong> {(req.concurrency ?? 1) > 1 ? `hasta ${req.concurrency} a la vez dentro de cada oleada` : 'de una en una'}; cada oleada espera a la anterior.
                  <ul className="bw-list">{sum.waves.slice(0, 4).map((w, n) => <li key={n}>Oleada {n + 1}: {w.slice(0, 8).join(', ')}{w.length > 8 ? ` y ${w.length - 8} más` : ''}</li>)}{sum.waves.length > 4 ? <li>… y {sum.waves.length - 4} oleada(s) más (plan detallado)</li> : null}</ul></div>}
                <div className="bw-ops small"><strong>Hará sin preguntarte:</strong><ul className="bw-list">{autonomous.map(x => <li key={x}>{x}</li>)}</ul>
                  <strong>Seguirá siendo decisión tuya:</strong><ul className="bw-list">{yours.map(x => <li key={x}>{x}</li>)}</ul></div>
                {preview!.warnings.map((w, i) => <Notice key={i} kind="warn">{w}</Notice>)}
                <label className="ck"><input className="cb" type="checkbox" checked={ok} disabled={!sum.executable || sum.blockedByPermission > 0} onChange={e => setOk(e.target.checked)} /><span>Autorizo este lote: <strong>{sum.executable}</strong> de {sum.selected} historia(s) pueden empezar{sum.fits.min < autoCount ? <> (con estos límites, ≈ {sum.fits.min === sum.fits.max ? sum.fits.max : `${sum.fits.min}–${sum.fits.max}`} antes de pausarse)</> : null}{sum.waitForManualIntegration.length ? <>, {sum.waitForManualIntegration.length} esperarán a que integres</> : null}, con {req.backends!.map(b => b === 'api' ? 'la API (facturable)' : 'Claude Code (suscripción)').join(' y ')}; hasta <strong>{fmtUsd(req.totalBudgetUsd)}</strong> de API y <strong>{req.maxSubscriptionCalls}</strong> llamadas a la suscripción; integrar <strong>{g.merge ? 'sí' : 'no'}</strong>{internal ? <>, reiniciar <strong>{g.activate ? 'sí' : 'no'}</strong></> : null}, publicar <strong>{g.publish ? 'sí' : 'no'}</strong>. Puedo pausarlo, cancelarlo o revocarlo en cualquier momento.</span></label>
              </>}
              {err && <Notice kind="err">{err}</Notice>}
              <button className="btn btn-primary" onClick={authorize} disabled={!!blockReason || busy}>{busy ? <span className="spin spin-light" /> : Icon.arrow()}Autorizar lote</button>
              {blockReason && sel.length > 0 && <div className="small muted" data-testid="authorize-reason">{blockReason}</div>}
            </div></section>
          </aside>
        </div>
        {sel.length > 0 && <div className="bw-mobilebar" aria-hidden="true"><span className="small"><strong>{sel.length}</strong> seleccionada(s){sum ? <> · <strong>{sum.executable}</strong> empezarán{sum.blockedByDependency + sum.blockedByPermission ? <> · {sum.blockedByDependency + sum.blockedByPermission} no</> : null}</> : null}</span><a className="btn btn-primary btn-sm" href="#bw-summary" tabIndex={-1}>Ver resumen y autorizar</a></div>}
      </div>
    </section>
  );
}

/** Monitor del lote y revisión de aceptación (una o varias), con pausa, reanudación, cancelación y revocación. */
export function BatchDetail() {
  const { batchId } = useParams();
  // Una pantalla por lote: confirmaciones, selección para aceptar y comprobaciones nunca pasan de un lote a otro.
  return <BatchDetailOf key={batchId} batchId={batchId!} />;
}

function BatchDetailOf({ batchId }: { batchId: string }) {
  const { status, flash } = useApp();
  const ws = status.workspace!;
  const [b, setB] = useState<BatchView | null>(null); const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [addBudget, setAddBudget] = useState('0'); const [addCalls, setAddCalls] = useState('0'); const [resumeOk, setResumeOk] = useState(false);
  const [revoking, setRevoking] = useState(false); const [revokeReason, setRevokeReason] = useState(''); const [cancelling, setCancelling] = useState(false);
  const [picked, setPicked] = useState<string[]>([]); const [checks, setChecks] = useState<Record<string, boolean[]>>({});
  // La nota de aceptación a medias se conserva (por lote); lo que marcas para aceptar, no: es una comprobación tuya, no un borrador.
  const noteDraft = useDraft(draftKey('lote.aceptacion', ws.slug, batchId), ''); const note = noteDraft.value; const setNote = noteDraft.set;
  const load = () => api.batch(ws.slug, batchId!).then(x => { setB(x); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => { void load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [ws.slug, batchId]);
  const act = async (fn: () => Promise<BatchView>, ok: string) => { setBusy(true); try { setB(await fn()); flash(ok); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } };
  if (!b) return <Shell crumb="Ejecución continua"><main className="page">{err ? <Notice kind="err">{err}</Notice> : <span className="spin" />}</main></Shell>;
  // «En marcha» solo si algo avanza: si todo espera tu decisión, se dice.
  const idle = b.status === 'running' && !batchMoving(b.items);
  const st = idle ? { label: 'espera tu decisión', tone: 'warn' as const } : STATUS[b.status]; const closed = b.status === 'cancelled' || b.status === 'revoked';
  const pct = (n: number) => `${Math.min(100, Math.round((n / Math.max(0.0001, b.auth.totalBudgetUsd)) * 100))}%`;
  return (
    <Shell crumb={`Ejecución continua / ${b.title}`}>
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 18 }} data-testid="batch-detail">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><div className="eyebrow"><Link className="lnk" to="/lotes">Ejecución continua</Link></div><h1 className="h1" style={{ fontSize: 24 }}>{b.title}</h1>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}><Chip tone={st.tone}>{st.label}</Chip><Chip xs>Gauntlet {GAUNTLET_MODE[b.auth.gauntlet.mode].label.toLowerCase()}</Chip><Chip xs>{b.auth.concurrency} a la vez</Chip><Chip xs>integrar {b.auth.git.merge ? 'sí' : 'no'}</Chip>{b.auth.git.activate && <Chip xs>activar sí</Chip>}<Chip xs>publicar {b.auth.git.publish ? 'sí' : 'no'}</Chip></div></div>
          {!closed && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {b.status === 'running' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act(() => api.batchControl(ws.slug, b.id, 'pause'), 'Lote en pausa')}>Pausar</button>}
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setCancelling(c => !c); setRevoking(false); }} aria-expanded={cancelling}>Cancelar lote…</button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setRevoking(r => !r); setCancelling(false); }} aria-expanded={revoking}>Revocar autorización…</button>
          </div>}
        </div>
        {cancelling && !closed && <section className="card card-b" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="small" style={{ flex: '1 1 260px' }}>Cancelar detiene lo que está en marcha entre pasos y cierra lo pendiente y lo que espera tu decisión. Lo terminado se conserva y puedes aceptarlo; lo hecho en cada proceso, también. Las historias que llegaron a empezar quedan en el backlog «en curso» o «en revisión» con su proceso, y no se pueden elegir en otro lote mientras no vuelvan a «pendiente».</span>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setCancelling(false); void act(() => api.batchControl(ws.slug, b.id, 'cancel'), 'Lote cancelado'); }}>Confirmar cancelación</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setCancelling(false)}>No cancelar</button>
        </section>}
        {revoking && !closed && <section className="card card-b" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="small">Revocar detiene lo que está en marcha, cancela lo pendiente y nada terminado se integra, activa ni publica solo.</span>
          <input className="input" placeholder="Motivo (opcional)" value={revokeReason} onChange={e => setRevokeReason(e.target.value)} style={{ flex: '1 1 220px', height: 32 }} />
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setRevoking(false); void act(() => api.batchControl(ws.slug, b.id, 'revoke', { reason: revokeReason }), 'Autorización revocada'); }}>Revocar</button>
        </section>}
        {b.reason && <Notice kind={b.status === 'paused' || idle ? 'warn' : b.status === 'revoked' ? 'err' : 'info'}><span>{b.reason}{b.reasonFix ? <> <Link className="lnk" to={b.reasonFix.href}>{b.reasonFix.label}</Link></> : null}</span></Notice>}
        {(b.status === 'paused' || b.status === 'completed' || idle) && !closed && b.items.some(i => ['queued', 'waiting_dependency', 'needs_owner', 'awaiting_integration'].includes(i.state)) && <section className="card card-b" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
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
                <button className="btn btn-primary btn-sm" disabled={!picked.length || busy} onClick={() => { const ids = picked; setPicked([]); void act(async () => { const r = await api.acceptBatchItems(ws.slug, b.id, ids, note, Object.fromEntries(ids.filter(id => checks[id]).map(id => [id, checks[id]]))); noteDraft.clear(); return r; }, `${ids.length} historia(s) aceptada(s)`); }}>{Icon.check()}Aceptar seleccionadas ({picked.length})</button>
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
  // El formulario abierto (no aceptar, iterar, reintentar) y su texto se conservan por historia; la casilla «Autorizo…» no.
  const itemDraft = useDraft(draftKey('lote.historia', slug, b.id, it.itemId), { mode: null as 'reject' | 'iterate' | 'retry' | null, text: '' });
  const { mode, text } = itemDraft.value; const setMode = (m: typeof mode) => itemDraft.set(d => ({ ...d, mode: m })); const setText = (t: string) => itemDraft.set(d => ({ ...d, text: t }));
  const [auth, setAuth] = useState(false);
  const p = it.process; const steps = p?.manualTest?.steps ?? []; const c = checks ?? steps.map(() => false);
  const run = async (fn: () => Promise<BatchView>, ok: string) => { try { onChange(await fn()); flash(ok); itemDraft.clear(); setAuth(false); } catch (e: any) { flash(e.message, 'err'); } };
  const canIterate = ['rejected', 'needs_owner', 'failed', 'awaiting_acceptance', 'awaiting_integration'].includes(it.state) && b.status !== 'cancelled' && b.status !== 'revoked';
  // Sin trabajo que conservar (no llegó a empezar o su proceso falló): se puede reintentar con los límites del lote.
  const canRetry = (it.state === 'needs_owner' || it.state === 'failed') && (!p || p.status === 'cancelled' || p.status === 'failed') && b.status !== 'cancelled' && b.status !== 'revoked';
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
        {canRetry && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setMode('retry'); setAuth(false); }}>Reintentar…</button>}
        {canIterate && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setMode('iterate')}>Iterar solo esta…</button>}
        {['queued', 'waiting_dependency', 'running', 'needs_owner', 'blocked'].includes(it.state) && b.status !== 'cancelled' && b.status !== 'revoked' && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.cancelBatchItem(slug, b.id, it.itemId), `${it.storyId} cancelada`)}>Cancelar esta</button>}
      </div>
      {mode === 'retry' && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label className="ck small"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo reintentarla con los límites de este lote: vuelve a la cola y se comprueban otra vez su equipo y sus orígenes{b.status === 'running' ? '' : ' (empezará al reanudar el lote)'}. No tenía trabajo que conservar.</span></label>
        <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" disabled={!auth} onClick={() => run(() => api.retryBatchItem(slug, b.id, it.itemId), `${it.storyId}: de nuevo en la cola`)}>Reintentar</button><button className="btn btn-ghost btn-sm" onClick={() => setMode(null)}>Cancelar</button></div>
      </div>}
      {mode && mode !== 'retry' && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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

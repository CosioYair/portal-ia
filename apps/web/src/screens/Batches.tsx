import { useEffect, useMemo, useRef, useState } from 'react';
import { useEntryTitle } from '../lib/nav.ts';
import { useLatest, useLive } from '../lib/live.ts';
import { Link, useParams } from 'react-router-dom';
import type { BacklogItem, BatchItemState, BatchItemView, BatchPreview, BatchView, GauntletConfig } from '@portal-ia/domain';
import { BATCH_LIMITS, INTERNAL_WORKSPACE, batchHasWork, batchMoving, normalizeGauntlet } from '@portal-ia/domain';
import { api, type BatchPolicyView, type BatchRequest } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { GAUNTLET_MODE } from '../components/Gauntlet.tsx';
import { BatchStoryPicker, STATUS_LABEL } from '../components/BatchStoryPicker.tsx';
import { Chip, DraftNote, Icon, Notice } from '../components/ui.tsx';
import { EmptyState, Tile, WorkTabs } from '../components/kit.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { draftKey, useDraft, usePersistentState } from '../lib/persist.ts';
import { officeHome } from '../lib/routes.ts';

const STATUS: Record<BatchView['status'], { label: string; tone: '' | 'ok' | 'warn' | 'err' | 'accent' }> = {
  running: { label: 'en marcha', tone: 'accent' }, paused: { label: 'en pausa', tone: 'warn' }, needs_decision: { label: 'necesita tu decisión', tone: 'warn' }, completed: { label: 'terminado', tone: 'ok' }, cancelled: { label: 'cancelado', tone: '' }, revoked: { label: 'autorización revocada', tone: 'err' }
};
/** Estados con los que un lote en 'needs_decision' aún lanza trabajo solo (orientativo; el servidor decide con 409). */
const AUTONOMOUS: BatchItemState[] = ['queued', 'waiting_dependency', 'running', 'integrating', 'revalidating'];
/** Lo que «Reanudar» puede retomar: pendientes, esperando decisión, fallidas o bloqueadas. */
const RESUMABLE: BatchItemState[] = ['queued', 'waiting_dependency', 'needs_owner', 'awaiting_integration', 'failed', 'blocked'];
const TONE: Record<BatchItemState, '' | 'ok' | 'warn' | 'err' | 'accent'> = {
  queued: '', waiting_dependency: '', running: 'accent', integrating: 'accent', needs_owner: 'warn', awaiting_integration: 'warn', awaiting_acceptance: 'warn', accepted: 'ok', rejected: 'err', failed: 'err', blocked: 'err', cancelled: '', external: 'accent',
  ready: 'warn', revalidating: 'accent', postponed: '', prepared: 'accent'
};
const GROUPS: { label: string; states: BatchItemState[] }[] = [
  { label: 'Listas para tu revisión (sin integrar), en el orden de integración', states: ['ready'] },
  { label: 'Preparadas sobre su dependencia (sin integrar): se revisan e integran después de ella', states: ['prepared'] },
  { label: 'Ya integradas en main: pendientes de tu aceptación', states: ['awaiting_acceptance'] },
  { label: 'Aceptadas', states: ['accepted'] },
  { label: 'En curso o en cola', states: ['running', 'revalidating', 'integrating', 'queued', 'waiting_dependency'] },
  { label: 'Esperan tu decisión', states: ['needs_owner', 'awaiting_integration', 'rejected'] },
  { label: 'Aplazadas', states: ['postponed'] },
  { label: 'Bloqueadas, fallidas o canceladas', states: ['blocked', 'failed', 'cancelled'] }
];
const FRESH: Record<string, { label: string; tone: '' | 'ok' | 'warn' | 'err' | 'accent' }> = {
  current: { label: 'evidencia vigente', tone: 'ok' }, clean_carry: { label: 'evidencia arrastrada (main no tocó sus archivos)', tone: 'ok' },
  stale: { label: 'evidencia no al día', tone: 'warn' }, unknown: { label: 'vigencia sin comprobar', tone: 'err' }
};
const PHASE: Record<string, string> = { technical: 'el equipo trabaja', acceptance: 'te toca revisar', integrating: 'integrando', done: 'resuelto' };
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
  const load = () => api.batches(ws.slug, projectId).then(setList).catch(() => setList(l => l ?? []));
  // Tiempo real (lotes y procesos de este proyecto) en vez de pedir la lista cada 5 s aunque nada cambie.
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug, projectId]);
  useLive(c => c.ws === ws.slug && (c.entity === 'batch' || (c.entity === 'process' && c.kind !== 'progress')) && (!c.projectId || c.projectId === projectId), () => load(), { minMs: 1500 });
  const active = list?.find(b => b.status === 'running' || b.status === 'paused' || (b.status === 'needs_decision' && b.items.some(i => AUTONOMOUS.includes(i.state))));
  return (
    <Shell crumb="Lotes">
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <header className="page-head"><div className="page-head-main">
          <Tile icon={Icon.layers(22)} tone="work" size="lg" />
          <div className="page-head-text"><div className="eyebrow">Trabajo · ejecución continua</div><h1 className="h1">Lotes</h1>
            <p className="lede lede-2l">Varias historias seguidas con una sola autorización; cada una queda lista para tu aceptación.</p>
            </div>
          {!creating && <div className="page-head-actions"><button className="btn btn-primary" onClick={() => setCreating(true)} disabled={!!active} title={active ? 'Ya hay un lote activo en este proyecto' : undefined}>{Icon.activity()}Nuevo lote</button></div>}
        </div><WorkTabs /></header>
        <Disclosure title="Cómo funciona un lote"><div className="sm13 muted" style={{ maxWidth: '75ch' }}>Autorizas una vez un alcance acotado (historias, presupuesto, límites, Gauntlet, qué operaciones git) y el coordinador del lote, sin IA, las ejecuta en orden seguro, integra de una en una y te deja cada historia lista para <strong>tu aceptación</strong>, que es distinta de QA.</div></Disclosure>
        {creating && <BatchWizard onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load(); }} />}
        {active && !creating && <Notice kind="info">Lote activo: <Link to={`/lotes/${active.id}`}><strong>{active.title}</strong></Link> · {STATUS[active.status].label}{active.reason ? ` · ${active.reason}` : ''}</Notice>}
        <section className="card">
          <div className="card-h"><div className="h3">Lotes del proyecto</div></div>
          {!list ? <div className="card-b"><span className="spin" /></div> : !list.length ? <EmptyState art="board" title="Todavía no hay lotes">Un lote ejecuta seguidas las historias pendientes que elijas, con una sola autorización y límites que fijas tú.</EmptyState> :
            <div style={{ overflowX: 'auto' }}><table className="tbl"><thead><tr><th>Lote</th><th>Estado</th><th>Historias</th><th>Para tu revisión</th><th>Gasto</th><th>Creado</th></tr></thead><tbody>
              {list.map(b => <tr key={b.id}><td><Link className="lnk" to={`/lotes/${b.id}`}>{b.title}</Link></td><td><Chip xs tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Chip></td><td className="mono">{b.items.length}</td><td className="mono">{b.lifecycle.readyForOwner}</td><td className="mono">{fmtUsd(b.budget.spent)} / {fmtUsd(b.auth.totalBudgetUsd)}</td><td className="small">{when(b.createdAt)}</td></tr>)}
            </tbody></table></div>}
        </section>
      </main>
    </Shell>
  );
}

const ROLE: Record<string, string> = { planner: 'plan', consultant: 'consulta', implementer: 'implementa', reviewer: 'QA', evaluator: 'Gauntlet' };
const range = (r: { min: number; max: number }) => r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`;
const minutes = (m: number) => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;

/** Con «Integrar en main», la política va siempre explícita: lo que muestra el asistente es lo que autoriza el servidor. */
const explicitGit = <T extends { git?: BatchRequest['git'] }>(r: T): T => {
  if (!r.git?.merge) return r;
  const integration = r.git.integration ?? 'on_acceptance';
  return { ...r, git: { ...r.git, integration, ...(integration === 'on_acceptance' ? { prepareDependents: r.git.prepareDependents !== false } : { prepareDependents: undefined }) } };
};
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
  const draft = useDraft(draftKey('lote', ws.slug, projectId), { sel: [] as string[], custom: false, req: NEW_BATCH }, { revive: d => { const req = { ...NEW_BATCH, ...d.req }; if (req.git?.merge && !req.git.integration) req.git = { ...req.git, integration: 'on_acceptance' }; return { sel: Array.isArray(d.sel) ? d.sel : [], custom: !!d.custom, req }; } });
  const { sel, custom, req } = draft.value;
  // Si el borrador vino guardado, el aviso de opciones con permisos sigue mientras estén marcadas (antes desaparecía al
  // tocar cualquier otra cosa, p. ej. elegir una historia, aunque siguieran marcadas).
  const [restoredFor, setRestoredFor] = useState<string | null>(draft.status === 'restored' ? `${ws.slug}/${projectId}` : null);
  if (draft.status === 'restored' && restoredFor !== `${ws.slug}/${projectId}`) setRestoredFor(`${ws.slug}/${projectId}`);
  const restored = restoredFor === `${ws.slug}/${projectId}` && draft.status !== 'idle';
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
      api.previewBatch(ws.slug, projectId, { ...explicitGit(req), itemIds: sel })
        .then(p => { if (n === seq.current) { setPreview(p); setFresh(true); setErr(null); } })
        .catch(e => { if (n === seq.current) { setPreview(null); setErr(e.message); } });
    }, 350);
    return () => clearTimeout(t);
  }, [sel, req, ws.slug, projectId]);
  // Un borrador recuperado puede nombrar historias que ya no se pueden elegir (terminadas, en curso…): se retiran.
  useEffect(() => { if (all) { const ok0 = new Set(all.filter(i => !['in_progress', 'review', 'done', 'discarded'].includes(i.status)).map(i => i.id)); if (sel.some(id => !ok0.has(id))) setSel(s => s.filter(id => ok0.has(id))); } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all]);
  // Autorizado: el borrador cumplió su función y se borra (el siguiente lote empieza con los valores seguros).
  const authorize = async () => { setBusy(true); setErr(null); try { const b = await api.createBatch(ws.slug, projectId, { ...explicitGit(req), itemIds: sel }); draft.clear(); flash(`Lote autorizado: ${b.items.length} historia(s)`); onCreated(); navigate(`/lotes/${b.id}`); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
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
  const autonomous = sum ? [`Ejecutar ${autoCount} historia(s) con su equipo: plan, implementación en un worktree aislado, verificación en el sandbox y QA`, req.gauntlet!.mode === 'auto' ? 'Gauntlet automático: cada historia con la intensidad que le corresponde (en el plan detallado, con el motivo)' : req.gauntlet!.mode !== 'off' ? `Evaluación Gauntlet ${GAUNTLET_MODE[req.gauntlet!.mode].label.toLowerCase()}` : null, `Hasta ${req.maxCorrections} corrección(es) por historia`, g.merge ? (g.integration === 'auto' ? 'Integrar en main cada historia terminada (de una en una, con las mismas verificaciones)' : 'Terminar técnicamente TODAS las historias; al aceptar cada una, integrarla en main en el orden de integración y poner al día las siguientes (git, sandbox y QA)') : null, g.merge && g.integration !== 'auto' && g.prepareDependents !== false ? 'Preparar las dependientes sobre la versión verificada de su dependencia (sin integrar), sin esperar a tu revisión' : null, internal && g.activate ? 'Reconstruir y reiniciar el Portal tras integrar (sin nada en marcha)' : null, g.publish ? 'Publicar en GitHub tras integrar' : null, fallbackOn ? 'Ceder a la API (facturable) si Claude Code no está disponible' : null].filter(Boolean) as string[] : [];
  const yours = [!g.merge ? 'Integrar en main' : g.integration !== 'auto' ? 'Aceptar cada historia antes de que entre en main (en el orden propuesto)' : null, internal && !g.activate ? 'Reconstruir y reiniciar el Portal' : null, !g.publish ? 'Publicar en GitHub' : null, 'Aceptar (o no) cada historia: es distinto de QA', 'Ampliar presupuesto, tope de llamadas o duración', 'Lo que se detenga: conflictos, fallos o límites'].filter(Boolean) as string[];
  return (
    <section className="card" data-testid="batch-wizard">
      <div className="card-h"><div className="h3">Nuevo lote</div><button className="xbtn" onClick={onClose} aria-label="Cerrar">{Icon.x(16)}</button></div>
      <div className="card-b">
        <DraftNote status={draft.status} onDiscard={draft.clear} />
        {restored && (g.merge || g.publish || g.activate || req.backends?.includes('api') || req.apiFallback || req.allowInstall) && <Notice kind="warn">El borrador recuperado tiene marcado: {[g.merge && 'integrar en main', g.activate && 'reconstruir y reiniciar', g.publish && 'publicar en GitHub', req.backends?.includes('api') && 'la API (facturable)', req.apiFallback && 'ceder a la API', req.allowInstall && 'instalar con red'].filter(Boolean).join(', ')}. Son preferencias guardadas, no permisos: revísalas; nada se hace hasta que marques la casilla de autorización.</Notice>}
        <div className="bw-layout">
          <div className="bw-main">
            <div className="bw-section">
              <div className="eyebrow">1 · Historias</div>
              {!all ? <span className="spin" /> : !items.some(i => i.status === 'pending' || i.status === 'blocked') ? <div className="small muted">No hay historias pendientes en el backlog.</div> :
                <BatchStoryPicker items={items} owners={owners} selected={sel} onAdd={add} onRemove={remove} onClear={() => setSel([])} persistKey={`portal-ia.lote.filtros.${ws.slug}.${projectId}`} />}
              {sel.length > 0 && <Disclosure testId="batch-order" defaultOpen={sel.length <= 12} title={`Orden de la selección (${sel.length})`} hint={`${custom ? 'orden manual' : 'orden del backlog (su prioridad)'}; el plan pone siempre las dependencias antes`}>
                
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
              </Disclosure>}
            </div>

            <div className="bw-section" data-testid="batch-sources">
              <div className="eyebrow">2 · Equipo y orígenes de ejecución</div>
              <div className="small muted">El origen es de cada agente (se cambia en el panel de cada agente, en la <Link className="lnk" to={officeHome()}>Oficina</Link>). Aquí autorizas qué orígenes puede usar este lote; nunca cambia de origen por su cuenta.</div>
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
              <label className="ck"><input className="cb" type="checkbox" checked={!!g.merge} onChange={e => set({ git: e.target.checked ? { ...g, merge: true, integration: g.integration ?? 'on_acceptance' } : { merge: false, activate: false, publish: false } })} /><span><strong>Integrar en main</strong> de una en una y con las mismas verificaciones que la integración manual. Sin esto, integrar sigue siendo tuyo (y las dependientes esperan).</span></label>
              {g.merge && <div role="radiogroup" aria-label="Cuándo integrar" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginLeft: 26 }} data-testid="batch-integration-policy">
                <label className="ck" style={{ gap: 6 }}><input type="radio" name="batch-integration" checked={g.integration !== 'auto'} onChange={() => set({ git: { ...g, integration: 'on_acceptance' } })} /><span><strong>Al aceptar cada historia (recomendado)</strong> <span className="small muted">El equipo termina técnicamente todo el lote; tú revisas cada historia en el orden de integración (con vista previa aislada) y, al aceptarla, entra en main. Las siguientes se ponen al día con lo integrado antes de presentártelas.</span></span></label>
                {g.integration !== 'auto' && <label className="ck" style={{ gap: 6, marginLeft: 26 }} data-testid="batch-prepare-dependents"><input className="cb" type="checkbox" checked={g.prepareDependents !== false} onChange={e => set({ git: { ...g, prepareDependents: e.target.checked } })} /><span><strong>Preparar también las dependientes</strong> <span className="small muted">sobre la versión verificada y revisada de su dependencia, sin esperar a que la aceptes. Nunca se integran antes que ella; al integrarla se ponen al día con su versión final. Si no la aceptas o la rehaces desde cero, ese trabajo puede perderse.</span></span></label>}
                <label className="ck" style={{ gap: 6 }}><input type="radio" name="batch-integration" checked={g.integration === 'auto'} onChange={() => set({ git: { ...g, integration: 'auto' } })} /><span><strong>Al terminar cada una</strong> <span className="small muted">Se integra{internal ? ' y activa' : ''} sin esperar tu revisión; la aceptas ya integrada (útil para probar la interfaz en el Portal en marcha).</span></span></label>
              </div>}
              {internal && <label className="ck"><input className="cb" type="checkbox" checked={!!g.activate} disabled={!g.merge} onChange={e => set({ git: { ...g, activate: e.target.checked } })} /><span><strong>Reconstruir y reiniciar el Portal</strong> cuando no haya nada en marcha, y comprobarlo en ejecución al volver.{!g.merge ? ' (exige integrar)' : ''}</span></label>}
              <label className="ck"><input className="cb" type="checkbox" checked={!!g.publish} disabled={!g.merge} onChange={e => set({ git: { ...g, publish: e.target.checked } })} /><span><strong>Publicar en GitHub</strong> tras integrar: es una operación externa y visible.{!g.merge ? ' (exige integrar)' : ''}</span></label>
            </div>

            {preview && fresh && <Disclosure testId="batch-preview" title={`Plan detallado (${preview.plan.length} historia(s))`} hint="orden, oleadas, llamadas y motivo de cada una">
              
              <div className="bw-table-wrap" style={{ marginTop: 8 }}><table className="tbl"><thead><tr><th>#</th><th>Historia</th><th>Oleada</th><th>Gauntlet</th><th>Llamadas</th><th>API</th><th>Estado</th></tr></thead><tbody>
                {preview.plan.map(p => <tr key={p.id}><td className="mono">{p.order + 1}</td><td className="small"><span className="mono">{p.storyId}</span> {p.title}{p.dependsOn ? <span className="muted"> · tras {p.dependsOn}{p.dependsInBatch ? '' : ' (fuera del lote)'}</span> : null}</td><td className="mono">{p.wave + 1}</td><td className="small" title={p.gauntlet?.reason ?? undefined}>{p.gauntlet ? GAUNTLET_MODE[p.gauntlet.mode].label : '—'}</td><td className="mono small">{range(p.calls)}</td><td className="mono small">{p.estimatedUsd == null ? '—' : fmtUsd(p.estimatedUsd)}</td>
                  <td className="small">{p.executable ? 'se ejecutará' : <><Chip xs tone="err">{p.blockedReason ? 'bloqueada' : 'no empezará'}</Chip> {p.problems.join(' ')}</>}</td></tr>)}
              </tbody></table></div>
            </Disclosure>}
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
                <label className="ck"><input className="cb" type="checkbox" checked={ok} disabled={!sum.executable || sum.blockedByPermission > 0} onChange={e => setOk(e.target.checked)} /><span>Autorizo este lote: <strong>{sum.executable}</strong> de {sum.selected} historia(s) pueden empezar{sum.fits.min < autoCount ? <> (con estos límites, ≈ {sum.fits.min === sum.fits.max ? sum.fits.max : `${sum.fits.min}–${sum.fits.max}`} antes de pausarse)</> : null}{sum.waitForManualIntegration.length ? <>, {sum.waitForManualIntegration.length} esperarán a que integres</> : null}, con {req.backends!.map(b => b === 'api' ? 'la API (facturable)' : 'Claude Code (suscripción)').join(' y ')}; hasta <strong>{fmtUsd(req.totalBudgetUsd)}</strong> de API y <strong>{req.maxSubscriptionCalls}</strong> llamadas a la suscripción; integrar <strong>{g.merge ? (g.integration === 'auto' ? 'sí, al terminar cada una' : 'al aceptar cada una, en orden') : 'no'}</strong>{internal ? <>, reiniciar <strong>{g.activate ? 'sí' : 'no'}</strong></> : null}, publicar <strong>{g.publish ? 'sí' : 'no'}</strong>. Puedo pausarlo, cancelarlo o revocarlo en cualquier momento.</span></label>
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
  const [closing, setClosing] = useState(false); const [closeReason, setCloseReason] = useState('');
  const closeEvent = b ? [...b.events].reverse().find(e => e.message.startsWith('Cerrado manualmente por el propietario')) : undefined;
  const [picked, setPicked] = useState<string[]>([]); const [checks, setChecks] = useState<Record<string, boolean[]>>({});
  // La nota de aceptación a medias se conserva (por lote); lo que marcas para aceptar, no: es una comprobación tuya, no un borrador.
  const noteDraft = useDraft(draftKey('lote.aceptacion', ws.slug, batchId), ''); const note = noteDraft.value; const setNote = noteDraft.set;
  const latest = useLatest();
  useEntryTitle(b ? `Lote · ${b.title.slice(0, 40)}` : null);
  const load = () => latest.run(() => api.batch(ws.slug, batchId!)).then(x => { if (x === undefined) return; setB(x); setErr(null); }).catch(e => setErr(e.message));
  // Tiempo real: el lote y los procesos de sus historias (aquí, en otra pestaña o fuera del lote) al momento; mientras
  // está en marcha, un respaldo cada 20 s por si el canal calla.
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug, batchId]);
  useLive(c => c.ws === ws.slug && ((c.entity === 'batch' && c.id === batchId) || (c.entity === 'process' && c.kind !== 'progress' && !!b?.items.some(i => i.processId === c.id || i.followedProcessId === c.id || i.itemId === c.itemId))), () => load(), { minMs: 1000 });
  useEffect(() => { if (b?.status !== 'running') return; const t = setInterval(() => { void load(); }, 20_000); return () => clearInterval(t); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug, batchId, b?.status]);
  const act = async (fn: () => Promise<BatchView>, ok: string) => { setBusy(true); latest.bump(); try { setB(await fn()); flash(ok); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } };
  if (!b) return <Shell crumb="Lotes"><main className="page">{err ? <Notice kind="err">{err}</Notice> : <span className="spin" />}</main></Shell>;
  // «En marcha» solo si algo avanza: si todo espera tu decisión, se dice.
  const idle = b.status === 'running' && !batchMoving(b.items);
  const st = idle ? { label: 'espera tu decisión', tone: 'warn' as const } : STATUS[b.status]; const closed = b.status === 'cancelled' || b.status === 'revoked';
  const pct = (n: number) => `${Math.min(100, Math.round((n / Math.max(0.0001, b.auth.totalBudgetUsd)) * 100))}%`;
  return (
    <Shell crumb={b.title}>
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 18 }} data-testid="batch-detail">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><div className="eyebrow"><Link className="lnk" to="/lotes">Trabajo · Lotes</Link></div><h1 className="h1" style={{ fontSize: 24 }}>{b.title}</h1>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}><Chip tone={st.tone}>{st.label}</Chip><Chip xs>Gauntlet {GAUNTLET_MODE[b.auth.gauntlet.mode].label.toLowerCase()}</Chip><Chip xs>{b.auth.concurrency} a la vez</Chip><Chip xs>integrar {b.auth.git.merge ? (b.auth.git.integration === 'on_acceptance' ? 'al aceptar' : 'al terminar') : 'no'}</Chip>{b.auth.git.activate && <Chip xs>activar sí</Chip>}<Chip xs>publicar {b.auth.git.publish ? 'sí' : 'no'}</Chip></div></div>
          {!closed && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {b.status === 'running' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act(() => api.batchControl(ws.slug, b.id, 'pause'), 'Lote en pausa')}>Pausar</button>}
            {(b.status === 'paused' || b.status === 'needs_decision') && !closing && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setClosing(true); setCloseReason(''); }} title="Sin costo de IA">Cerrar lote…</button>}
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setCancelling(c => !c); setRevoking(false); }} aria-expanded={cancelling}>Cancelar lote…</button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setRevoking(r => !r); setCancelling(false); }} aria-expanded={revoking}>Revocar autorización…</button>
          </div>}
        </div>
        {cancelling && !closed && <section className="card card-b" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="small" style={{ flex: '1 1 260px' }}>Cancelar detiene lo que está en marcha entre pasos y cierra lo pendiente y lo que espera tu decisión. Lo terminado se conserva y puedes aceptarlo; lo hecho en cada proceso, también. Las historias que llegaron a empezar quedan en el backlog «en curso» o «en revisión» con su proceso, y no se pueden elegir en otro lote mientras no vuelvan a «pendiente».</span>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setCancelling(false); void act(() => api.batchControl(ws.slug, b.id, 'cancel'), 'Lote cancelado'); }}>Confirmar cancelación</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setCancelling(false)}>No cancelar</button>
        </section>}
        {closing && (b.status === 'paused' || b.status === 'needs_decision') && <section className="card card-b" style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="batch-close">
          <div className="sm13"><strong>Cerrar lote</strong> · Sin costo de IA. Queda completado si todas sus historias ya están integradas; si no, cancelado. El motivo y la fecha se registran en el lote.</div>
          <textarea className="input" placeholder="Motivo del cierre (obligatorio)" maxLength={500} value={closeReason} onChange={e => setCloseReason(e.target.value)} aria-label="Motivo del cierre" />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary btn-sm" disabled={busy || closeReason.trim().length < 3} onClick={() => { const r = closeReason.trim(); setClosing(false); void act(() => api.closeBatch(ws.slug, b.projectId, b.id, r), 'Lote cerrado'); }}>Confirmar cierre</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setClosing(false)}>Volver</button>
          </div>
        </section>}
        {closeEvent && <Notice kind="info"><span>{closeEvent.message} · <span className="mono">{when(closeEvent.at)}</span></span></Notice>}
        {revoking && !closed && <section className="card card-b" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="small">Revocar detiene lo que está en marcha, cancela lo pendiente y nada terminado se integra, activa ni publica solo.</span>
          <input className="input" placeholder="Motivo (opcional)" value={revokeReason} onChange={e => setRevokeReason(e.target.value)} style={{ flex: '1 1 220px', height: 32 }} />
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setRevoking(false); void act(() => api.batchControl(ws.slug, b.id, 'revoke', { reason: revokeReason }), 'Autorización revocada'); }}>Revocar</button>
        </section>}
        <section className="card card-b" data-testid="batch-lifecycle" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Chip xs tone={b.lifecycle.phase === 'done' ? 'ok' : b.lifecycle.phase === 'acceptance' ? 'warn' : 'accent'}>{PHASE[b.lifecycle.phase]}</Chip><strong className="sm13">{b.lifecycle.headline}</strong></div>
          {b.lifecycle.next && (() => { const n = b.items.find(i => i.itemId === b.lifecycle.next); return n ? <div className="small">Siguiente a revisar: <a className="lnk" href={`#item-${n.storyId}`}><span className="mono">{n.storyId}</span> {n.title}</a></div> : null; })()}
        </section>
        {b.integrationPlan && b.integrationPlan.order.length > 0 && <section className="card card-b"><Disclosure testId="batch-integration-plan" title="Orden de integración" hint={`sin IA, por ${b.integrationPlan.basis.actual ? 'los archivos reales de cada rama' : b.integrationPlan.basis.planned ? 'los archivos de los planes' : 'los archivos que menciona cada historia'}; no es el orden de los identificadores`}>
          <ol className="bw-list" style={{ marginTop: 6 }}>{b.integrationPlan.order.map(iid => { const x = b.items.find(i => i.itemId === iid); const notes = b.integrationPlan!.notes.filter(n => n.itemId === iid); return x ? <li key={iid}><span className="mono">{x.storyId}</span> {x.title} <Chip xs tone={TONE[x.state]}>{x.label}</Chip>{notes.map((n, k) => <div key={k} className="small muted">{n.text}</div>)}</li> : null; })}</ol>
          {b.integrationPlan.overlaps.length > 0 && <div className="small muted">Comparten archivos: {b.integrationPlan.overlaps.slice(0, 8).map(o => `${b.items.find(i => i.itemId === o.a)?.storyId}↔${b.items.find(i => i.itemId === o.b)?.storyId} (${o.files.slice(0, 2).join(', ')}${o.files.length > 2 ? '…' : ''})`).join(' · ')}</div>}
        </Disclosure></section>}
        {b.status === 'needs_decision' && <div aria-live="polite" className="small" data-testid="batch-needs-decision"><Chip tone="warn">necesita tu decisión</Chip> Ninguna historia avanza sola y alguna aún no está aceptada, cerrada ni cancelada en el Backlog.</div>}
            {b.reason && b.reason !== b.lifecycle.headline && <Notice kind={b.status === 'paused' || b.status === 'needs_decision' || idle ? 'warn' : b.status === 'revoked' ? 'err' : 'info'}><span>{b.reason}{b.reasonFix ? <> <Link className="lnk" to={b.reasonFix.href}>{b.reasonFix.label}</Link></> : null}</span></Notice>}
        {!closed && <PolicyCard b={b} onChange={setB} />}
        {(b.status === 'paused' || b.status === 'needs_decision' || idle) && !closed && (batchHasWork(b.items) || b.items.some(i => RESUMABLE.includes(i.state))) && <ResumeEffects b={b} />}
        {(b.status === 'paused' || b.status === 'needs_decision' || idle) && !closed && (batchHasWork(b.items) || b.items.some(i => RESUMABLE.includes(i.state))) && <section className="card card-b" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <span className="small muted" data-testid="resume-spend-note" style={{ flexBasis: '100%' }}>«Reanudar» vuelve a poner en cola las historias pendientes, fallidas o bloqueadas que se puedan retomar. Solo gasta dentro de la autorización vigente del lote (sus límites y su presupuesto restante). Si el presupuesto se agota, el lote se pausa y te explica el motivo.</span>
          <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>Añadir presupuesto (USD)<input className="input mono" type="number" min={0} step={0.5} value={addBudget} onChange={e => setAddBudget(e.target.value)} style={{ width: 120, height: 32 }} /></label>
          <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>Añadir llamadas a la suscripción<input className="input mono" type="number" min={0} value={addCalls} onChange={e => setAddCalls(e.target.value)} style={{ width: 120, height: 32 }} /></label>
          <label className="ck" style={{ flex: '1 1 260px' }}><input className="cb" type="checkbox" checked={resumeOk} onChange={e => setResumeOk(e.target.checked)} /><span>Autorizo reanudar con estos límites (la duración autorizada cuenta desde ahora).</span></label>
          <button className="btn btn-primary btn-sm" data-testid="batch-resume" disabled={!resumeOk || busy} onClick={() => { setResumeOk(false); void act(() => api.batchControl(ws.slug, b.id, 'resume', { addBudgetUsd: Number(addBudget) || 0, addSubscriptionCalls: Number(addCalls) || 0, expectPolicy: b.lifecycle.policy }), 'Lote reanudado'); }}>Reanudar con «{POLICY[b.lifecycle.policy]}»</button>
        </section>}
        <section className="card card-b" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{(Object.keys(b.summary) as BatchItemState[]).filter(k => b.summary[k]).map(k => <Chip key={k} xs tone={TONE[k]}>{b.summary[k]} {b.items.find(i => i.state === k)?.label}</Chip>)}</div>
          <div className="small">Gasto {fmtUsd(b.budget.spent)} · reservado {fmtUsd(b.budget.reserved)} · disponible {fmtUsd(b.budget.remaining)} de {fmtUsd(b.auth.totalBudgetUsd)} (máx. {fmtUsd(b.auth.perStoryBudgetUsd)} por historia) · suscripción {b.subscriptionCalls}/{b.auth.maxSubscriptionCalls} llamadas</div>
          <div style={{ height: 6, background: 'var(--color-divider)', borderRadius: 4, overflow: 'hidden', display: 'flex' }} aria-hidden><span style={{ width: pct(b.budget.spent), background: 'var(--color-ok-text)' }} /><span style={{ width: pct(b.budget.reserved), background: 'var(--color-flow-run-mid)' }} /></div>
        </section>
        {GROUPS.map(gr => { const rank = new Map((b.integrationPlan?.order ?? []).map((x, k) => [x, k])); const its = b.items.filter(i => gr.states.includes(i.state)).sort((x, y) => (rank.get(x.itemId) ?? 1e6) - (rank.get(y.itemId) ?? 1e6) || x.order - y.order); if (!its.length) return null; return (
          <section key={gr.label} className="card">
            <div className="card-h"><div className="h3">{gr.label}</div><span className="small muted">{its.length}</span></div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {gr.states.includes('awaiting_acceptance') && <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="input" placeholder="Nota de aceptación (opcional)" value={note} onChange={e => setNote(e.target.value)} style={{ flex: '1 1 260px', height: 32 }} />
                <button className="btn btn-primary btn-sm" data-testid="acknowledge-selected" disabled={!picked.length || busy} onClick={() => { const ids = picked; setPicked([]); void act(async () => { const r = await api.acceptBatchItems(ws.slug, b.id, ids, note, Object.fromEntries(ids.filter(id => checks[id]).map(id => [id, checks[id]])), Object.fromEntries(ids.map(id => [id, b.items.find(i => i.itemId === id)?.evidence?.head ?? '']).filter(([, h]) => h))); noteDraft.clear(); return r; }, `${ids.length} historia(s) reconocida(s)`); }}>{Icon.check()}Reconocer y aceptar seleccionadas ({picked.length})</button>
                <span className="small muted" style={{ flexBasis: '100%' }}>Ya están en main (se integraron antes de tu revisión): aceptarlas es reconocerlas; no autoriza ninguna integración nueva. Si alguna no te vale, «No aceptar» la devuelve al equipo (no se des-integra sola).</span>
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
  const canIterate = ['rejected', 'needs_owner', 'failed', 'awaiting_acceptance', 'awaiting_integration', 'ready', 'postponed', 'prepared'].includes(it.state) && b.status !== 'cancelled' && b.status !== 'revoked';
  const live = b.status !== 'cancelled' && b.status !== 'revoked' && b.status !== 'completed';
  // Su dependencia del lote debe estar integrada antes (necesita su código en main).
  const dep = it.dependsInBatch && it.dependsOn ? b.items.find(i => i.storyId === it.dependsOn) : undefined;
  const depPending = !!dep && !dep.mergedCommit && dep.state !== 'accepted';
  const fr = it.freshness;
  // Sin trabajo que conservar (no llegó a empezar o su proceso falló): se puede reintentar con los límites del lote.
  const canRetry = (it.state === 'needs_owner' || it.state === 'failed') && (!p || p.status === 'cancelled' || p.status === 'failed') && b.status !== 'cancelled' && b.status !== 'revoked';
  // Un formulario recuperado del borrador solo se abre si la acción sigue siendo posible (la historia pudo avanzar).
  const open = mode === 'retry' ? (canRetry ? mode : null) : mode === 'iterate' ? (canIterate ? mode : null) : mode === 'reject' ? (it.state === 'awaiting_acceptance' || it.state === 'accepted' || it.state === 'ready' || it.state === 'prepared' ? mode : null) : null;
  const onBranch = it.state === 'ready' || it.state === 'postponed' || it.state === 'prepared';
  // Decides sobre lo que probaste: con una vista previa abierta, su commit; si el candidato ya es otro, primero vuelve a abrirla.
  const pvOpen = !!it.preview?.live && (it.preview.status === 'ready' || it.preview.status === 'starting');
  const pvOther = pvOpen && !!it.evidence?.head && it.preview!.commit.slice(0, 7) !== it.evidence.head.slice(0, 7);
  const revision = pvOpen && !pvOther ? it.preview!.commit : it.evidence?.head ?? null;
  return (
    <div id={`item-${it.storyId}`} style={{ border: '1px solid var(--color-border-soft)', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }} data-testid={`batch-item-${it.storyId}`}>
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
      {it.stackInfo && <div className="small" data-testid={`stack-${it.storyId}`}><Chip xs tone={it.stackInfo.invalid ? 'err' : it.stackInfo.moved ? 'warn' : 'accent'}>{it.stackInfo.invalid ? 'versión provisional anulada' : 'sobre versión provisional'}</Chip> Preparada sobre <span className="mono">{it.stackInfo.storyId}</span> <span className="mono">{it.stackInfo.commit.slice(0, 7)}</span> (verificada y revisada, sin integrar){it.stackInfo.moved && it.stackInfo.dependencyHead ? <> · {it.stackInfo.storyId} cambió desde entonces (<span className="mono">{it.stackInfo.dependencyHead.slice(0, 7)}</span>): se pondrá al día con su versión final y QA la revisará otra vez</> : null}{it.stackInfo.invalid ? <> · {it.stackInfo.invalid}</> : null}</div>}
      {it.state === 'ready' && fr && <div className="small" data-testid={`freshness-${it.storyId}`}><Chip xs tone={FRESH[fr.status].tone}>{FRESH[fr.status].label}</Chip> {fr.status === 'current' ? `con main ${fr.mainHead} (commit ${fr.head})` : fr.detail}{fr.conflicts?.length ? <span> · conflictos previstos: {fr.conflicts.slice(0, 4).join(', ')}</span> : null}</div>}
      {(((it.state === 'ready' || it.state === 'prepared') && live) || it.preview?.live) && <PreviewPanel slug={slug} it={it} />}
      {(it.state === 'awaiting_acceptance' || it.state === 'ready' || it.state === 'prepared') && <>
        {p?.userFacing && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{p.userFacing}</div>}
        {steps.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><div className="small muted">Prueba de aceptación (marca cada paso que comprobaste):</div>
          {steps.map((s, i) => <label key={i} className="ck small" style={{ gap: 6 }}><input className="cb" type="checkbox" checked={!!c[i]} onChange={e => { const n = [...c]; n[i] = e.target.checked; onChecks(n); }} /><span>{i + 1}. {s}</span></label>)}</div>}
      </>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {it.state === 'ready' && live && <button className="btn btn-primary btn-sm" disabled={busy || depPending || pvOther} title={depPending ? `Acepta antes ${dep!.storyId}: esta necesita su código en main` : pvOther ? 'La vista previa abierta es de otro commit: vuelve a abrirla (o detenla) antes de aceptar' : undefined} data-testid={`accept-${it.storyId}`} onClick={() => run(() => api.acceptBatchItems(slug, b.id, [it.itemId], '', steps.length && c.some(Boolean) ? { [it.itemId]: c } : {}, revision ? { [it.itemId]: revision } : {}), `${it.storyId}: aceptada; se integra en su turno`)}>{Icon.check()}Aceptar {revision ? <span className="mono">{revision.slice(0, 7)}</span> : null} e integrar en main{b.auth.git.publish ? ' (y publicar en GitHub)' : ''}{fr && fr.status !== 'current' ? ' (se pone al día antes)' : ''}</button>}
        {(it.state === 'awaiting_acceptance' || it.state === 'accepted' || it.state === 'ready' || it.state === 'prepared') && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setMode('reject'); setText(''); }}>No aceptar…</button>}
        {['ready', 'prepared', 'queued', 'waiting_dependency', 'needs_owner', 'failed', 'blocked', 'awaiting_integration'].includes(it.state) && live && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.postponeBatchItem(slug, b.id, it.itemId, ''), `${it.storyId}: aplazada`)}>Aplazar</button>}
        {it.state === 'postponed' && (live || b.status === 'completed') && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run(() => api.restoreBatchItem(slug, b.id, it.itemId), `${it.storyId}: recuperada`)}>Recuperar</button>}
        {it.state === 'accepted' && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.reopenBatchItem(slug, b.id, it.itemId), `${it.storyId} reabierta`)}>Reabrir</button>}
        {canRetry && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setMode('retry'); setAuth(false); }}>Reintentar…</button>}
        {canIterate && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setMode('iterate')}>{onBranch ? 'Pedir cambios…' : 'Iterar solo esta…'}</button>}
        {['queued', 'waiting_dependency', 'running', 'needs_owner', 'blocked'].includes(it.state) && b.status !== 'cancelled' && b.status !== 'revoked' && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.cancelBatchItem(slug, b.id, it.itemId), `${it.storyId} cancelada`)}>Cancelar esta</button>}
      </div>
      {open === 'retry' && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label className="ck small"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo reintentarla con los límites de este lote: vuelve a la cola y se comprueban otra vez su equipo y sus orígenes{b.status === 'running' ? '' : ' (empezará al reanudar el lote)'}. No tenía trabajo que conservar.</span></label>
        <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" disabled={!auth} onClick={() => run(() => api.retryBatchItem(slug, b.id, it.itemId), `${it.storyId}: de nuevo en la cola`)}>Reintentar</button><button className="btn btn-ghost btn-sm" onClick={() => setMode(null)}>Cancelar</button></div>
      </div>}
      {open && open !== 'retry' && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea className="input" placeholder={open === 'reject' ? 'Qué no cumple (se registra en la historia)' : onBranch ? `Qué cambiar${it.evidence?.head ? ` (sobre el commit ${it.evidence.head} que revisaste)` : ''}: se aplica sobre su rama, sin rehacerla` : 'Qué debe cambiar en la nueva iteración'} value={text} onChange={e => setText(e.target.value)} />
        {open === 'reject' && steps.some((_, i) => !c[i]) && <div className="small muted">Se crearán tareas con los pasos sin marcar: {steps.filter((_, i) => !c[i]).map((s, i) => <span key={i}>«{s}» </span>)}</div>}
        {open === 'iterate' && <label className="ck small"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>{onBranch ? 'Autorizo estos cambios sobre su rama dentro de los límites del lote (una corrección más; se repiten verificación, QA y Gauntlet; las demás no se repiten).' : 'Autorizo una iteración de esta historia dentro de los límites del lote (las demás no se repiten).'}</span></label>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary btn-sm" disabled={text.trim().length < 3 || (open === 'iterate' && !auth)} onClick={() => open === 'reject'
            ? run(() => api.rejectBatchItem(slug, b.id, it.itemId, text.trim(), steps.filter((_, i) => !c[i])), `${it.storyId}: no aceptada`)
            : run(() => api.iterateBatchItem(slug, b.id, it.itemId, text.trim(), onBranch ? revision : null), `${it.storyId}: iteración en cola`)}>{open === 'reject' ? 'Registrar no aceptación' : onBranch ? 'Pedir cambios' : 'Iterar'}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setMode(null)}>Cancelar</button>
        </div>
      </div>}
    </div>
  );
}

const POLICY: Record<string, string> = { auto: 'integrar al terminar cada historia', on_acceptance: 'integrar al aceptar cada historia', manual: 'sin integrar (manual)' };

/**
 * Política de integración del lote. Un lote autorizado con integración automática se puede pasar EXPLÍCITAMENTE a «integrar
 * al aceptar» (solo restringe): se ve antes qué ya está en main (no se des-integra), qué pasa a esperar tu revisión y qué
 * hará «Reanudar» con la nueva política; publicar y activar se pueden mantener o quitar, nunca añadir.
 */
function PolicyCard({ b, onChange }: { b: BatchView; onChange: (b: BatchView) => void }) {
  const { status, flash } = useApp(); const slug = status.workspace!.slug; const internal = slug === INTERNAL_WORKSPACE.slug;
  const [open, setOpen] = useState(false); const [view, setView] = useState<BatchPolicyView | null>(null);
  const [publish, setPublish] = useState(!!b.auth.git.publish); const [activate, setActivate] = useState(!!b.auth.git.activate);
  const [note, setNote] = useState(''); const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) api.batchPolicy(slug, b.id).then(setView).catch(e => flash(e.message, 'err')); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, b.updatedAt]);
  const last = b.policyHistory?.at(-1);
  if (b.lifecycle.policy !== 'auto') return last ? <Notice kind="info"><span data-testid="batch-policy-changed">Política cambiada por ti el {when(last.at)}: ahora <strong>integra al aceptar cada historia</strong>{last.to.publish ? ' y publica en GitHub al integrarla' : ', sin publicar en GitHub'}{internal ? (last.to.activate ? ', con activación en el Portal' : ', sin activar el Portal') : ''}. Ya estaban en main y no se des-integraron: {last.alreadyIntegrated.map(a => a.storyId).join(', ') || 'ninguna'}.</span></Notice> : null;
  const g = b.auth.git;
  const submit = async () => { setBusy(true); try { onChange(await api.changeBatchPolicy(slug, b.id, { publish, activate, note })); setOpen(false); setOk(false); flash('Política cambiada: nada entra en main sin tu aceptación'); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } };
  return (
    <section className="card card-b" data-testid="batch-policy" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="sm13"><Chip xs tone="warn">integra al terminar</Chip> <strong>Este lote se autorizó para integrar cada historia en main en cuanto termina</strong>{g.publish ? ', publicarla en GitHub' : ''}{internal && g.activate ? ' y activarla en el Portal (reconstruir y reiniciar)' : ''}, sin esperar tu revisión.</div>
      {!open && <div><button className="btn btn-secondary btn-sm" data-testid="policy-open" onClick={() => setOpen(true)}>Cambiar a «integrar al aceptar»…</button> <span className="small muted">Decisión explícita y registrada; no cambia nada hasta que la confirmes.</span></div>}
      {open && !view && <span className="spin" />}
      {open && view && <div className="small" style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="policy-dialog">
        {view.blockedBy && <Notice kind="warn">{view.blockedBy}</Notice>}
        <div><strong>Ya están en main</strong> (se integraron con la política anterior; no se pueden des-integrar; aceptarlas será <em>reconocerlas</em>): {view.alreadyIntegrated.length ? view.alreadyIntegrated.map(a => `${a.storyId} (${a.commit}${a.accepted ? ', ya aceptada' : ''}${internal ? (a.activated ? ', activa' : ', sin activar') : ''})`).join(', ') : 'ninguna'}.</div>
        {view.willBecomeReady.length > 0 && <div><strong>Pasan a esperar tu revisión sin integrar:</strong> {view.willBecomeReady.map(w => w.storyId).join(', ')}.</div>}
        <div><strong>Con la nueva política, «Reanudar» hará:</strong>{view.resumeAfter.length ? <ul className="bw-list">{view.resumeAfter.map(r => <li key={r.itemId}><span className="mono">{r.storyId}</span>: {r.effect}</li>)}</ul> : ' nada técnico pendiente.'}</div>
        <label className="ck"><input className="cb" type="checkbox" checked={publish} disabled={!g.publish} onChange={e => setPublish(e.target.checked)} /><span>Mantener «publicar en GitHub» al integrar cada historia que aceptes{!g.publish ? ' (no estaba autorizado: no se puede añadir aquí)' : ''}</span></label>
        {internal && <label className="ck"><input className="cb" type="checkbox" checked={activate} disabled={!g.activate} onChange={e => setActivate(e.target.checked)} /><span>Mantener «reconstruir y reiniciar el Portal» al integrar cada historia que aceptes{!g.activate ? ' (no estaba autorizado)' : ''}</span></label>}
        <input className="input" placeholder="Nota (opcional; queda en el registro)" value={note} onChange={e => setNote(e.target.value)} style={{ height: 32 }} />
        <label className="ck"><input className="cb" type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} data-testid="policy-confirm" /><span>Entiendo: a partir de ahora ninguna historia de este lote entra en main sin mi aceptación; lo ya integrado no se deshace y la autorización original queda en el registro.</span></label>
        <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" data-testid="policy-submit" disabled={!ok || busy || !view.canChange} onClick={() => void submit()}>Cambiar la política</button><button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancelar</button></div>
      </div>}
    </section>
  );
}

/** Qué hará «Reanudar» con cada historia, con la política ACTUAL, antes de pulsarlo (sin IA ni git). */
function ResumeEffects({ b }: { b: BatchView }) {
  const { status } = useApp(); const slug = status.workspace!.slug;
  const [view, setView] = useState<BatchPolicyView | null>(null);
  useEffect(() => { api.batchPolicy(slug, b.id).then(setView).catch(() => setView(null)); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, b.id, b.updatedAt]);
  if (!view || !view.resumeNow.length) return null;
  const integrates = view.policy === 'auto';
  return <section className="card card-b small" data-testid="resume-effects" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <div><strong>Al reanudar, con «{POLICY[view.policy]}»:</strong></div>
    <ul className="bw-list">{view.resumeNow.map(r => <li key={r.itemId}><span className="mono">{r.storyId}</span>: {r.effect}</li>)}</ul>
    {integrates && <Notice kind="warn">Con esta política, lo que apruebe QA entra en main{b.auth.git.publish ? ', se publica en GitHub' : ''}{b.auth.git.activate ? ' y se activa' : ''} sin tu revisión. Si prefieres revisarlo antes, cambia la política arriba antes de reanudar.</Notice>}
  </section>;
}

/**
 * Vista previa aislada del candidato EXACTO (commit + main) y la evidencia de ese commit, para probarlo antes de decidir.
 * Ni la vista previa ni QA sustituyen tu prueba: lo que aceptes o pidas queda ligado a ese commit.
 */
function PreviewPanel({ slug, it }: { slug: string; it: BatchItemView }) {
  const { flash } = useApp(); const p = it.process; const pv = it.preview; const ev = it.evidence;
  const [busy, setBusy] = useState(false);
  if (!p || !ev) return null;
  const running = !!pv && pv.live && (pv.status === 'starting' || pv.status === 'ready');
  const start = async () => { setBusy(true); try { await api.startPreview(slug, p.id); flash(`${it.storyId}: preparando la vista previa (aislada, sin IA)`); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } };
  const stop = async () => { if (!pv) return; setBusy(true); try { await api.stopPreview(slug, p.id, pv.id); flash('Vista previa detenida'); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); } };
  return (
    <div className="small" data-testid={`preview-${it.storyId}`} style={{ border: '1px dashed var(--color-border-strong)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div><strong>Revisión que decides:</strong> commit <span className="mono" data-testid={`head-${it.storyId}`}>{ev.head}</span> · verificación {ev.commands.map(c => `${c.command} ${c.ok ? '✓' : '✗'}`).join(' · ')}{ev.commands.some(c => c.isolation === 'docker') ? ' (sandbox Docker)' : ''} · QA: {ev.qa?.why ?? 'sin revisión'}{ev.notes?.length ? <><br /><strong>Al aceptar confirmas:</strong> {ev.notes.join(' · ')}</> : null}</div>
      {running && pv ? <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {pv.status === 'ready' && pv.url ? <><Chip xs tone="ok">vista previa lista</Chip><a className="lnk" href={pv.url} target="_blank" rel="noopener noreferrer" data-testid={`preview-open-${it.storyId}`}>Abrir vista previa ↗</a></> : <><span className="spin" /> preparándose: compila y arranca el candidato sin red ni IA…</>}
        <span>commit <span className="mono">{pv.commit}</span>{pv.combined ? <> + main <span className="mono">{pv.mainHead}</span></> : ' (rama sola: choca con main)'}</span>
        {pv.includesProvisional && <span>· incluye la versión provisional de {pv.includesProvisional.storyId} ({pv.includesProvisional.commit})</span>}
        {pv.outdated && <Chip xs tone="warn">desactualizada: el candidato cambió</Chip>}
        <span className="muted">· caduca {when(pv.expiresAt)}</span>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void stop()} data-testid={`preview-stop-${it.storyId}`}>Detener</button>
      </div> : <div>
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void start()} data-testid={`preview-start-${it.storyId}`}>Vista previa aislada</button> <span className="muted">Prueba esta versión exacta en tu navegador: se ejecuta aparte del Portal en marcha, en un contenedor sin red, con datos temporales e IA simulada. Es código aún no aceptado: no escribas en ella claves ni datos reales.</span>
        {pv && <div className="muted" data-testid={`preview-last-${it.storyId}`}>Última: commit {pv.commit} · {pv.status === 'failed' ? 'no arrancó' : 'detenida'}{pv.reason ? ` (${pv.reason})` : ''}{pv.outdated ? ' · era de otro commit' : ''}</div>}
      </div>}
      <div className="muted">Ni la vista previa ni QA sustituyen tu prueba: lo que aceptes o pidas queda ligado al commit {ev.head}.</div>
    </div>
  );
}

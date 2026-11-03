import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MAINTENANCE_CATEGORY_LABEL, requiresOf, type MaintenanceCategory, type MaintenanceItem, type MaintenanceOptionId, type MaintenanceOutcome, type MaintenancePlan } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, Icon, Notice, Spinner } from '../components/ui.tsx';
import { EmptyState, PageHeader, Stat, Tile, type Tone } from '../components/kit.tsx';
import { OwnerPairing, OwnerStatus, useOwner } from '../components/OwnerPairing.tsx';

/**
 * Revisión del proyecto: ramas (del remoto y locales), carpetas de trabajo, historias y lotes frente a main. Revisar es
 * de solo lectura. El propietario elige objetivo a objetivo (lo seguro viene marcado; lo que requiere decisión, en
 * «Conservar»; lo protegido no se puede elegir), ve el estado final esperado y autoriza exactamente esas acciones. Tras
 * ejecutar: primero lo que falló o no se tocó, la verificación independiente y cómo recuperar lo borrado.
 * Preparar, ejecutar y rechazar exigen que este navegador esté vinculado como propietario (consultar, no).
 */
const CATS: { id: MaintenanceCategory; tone: Tone; icon: () => ReactNode; hint: string }[] = [
  { id: 'safe', tone: 'ok', icon: () => Icon.check(), hint: 'Todo su contenido ya está en main: cerrarlo o borrarlo no pierde nada.' },
  { id: 'decision', tone: 'attention', icon: () => Icon.warn(), hint: 'Contiene trabajo que no está en main, o cerrarlo es una decisión tuya. Por defecto se conserva.' },
  { id: 'protected', tone: 'idle', icon: () => Icon.lock(), hint: 'Main, lo que está en uso o lo que protege un lote abierto: no se puede elegir.' },
  { id: 'outside', tone: 'idle', icon: () => Icon.external(), hint: 'No lo creó el Portal: no lo gestiona.' }
];
const KIND_ORDER: MaintenanceItem['kind'][] = ['story', 'assignment', 'iteration', 'batch', 'remote_branch', 'local_branch', 'worktree'];
const OUTCOME_LABEL: Record<MaintenanceOutcome['status'], string> = { done: 'Ejecutado', noop: 'Ya estaba así', failed: 'Con error', skipped: 'Sin tocar', started: 'Interrumpido' };
const COLLAPSE_AT = 8;
const REASON_LABEL: Partial<Record<MaintenanceOptionId, (n: string) => string>> = { discard_iteration: n => `Motivo para descartar la «${n}»`, cancel_assignment: n => `Motivo para cancelar el encargo «${n}»`, accept_assignment: n => `Motivo para aceptar el encargo «${n}»`, discard: n => `Motivo de la cancelación de «${n}»`, close_done: n => `Motivo para cerrar «${n}» como hecha`, accept: n => `Motivo para aceptar «${n}»`, close_batch: n => `Motivo para cerrar el lote «${n}»` };
/** Acciones que se pueden elegir en bloque en «Requiere tu decisión»: solo borrar ramas YA integradas (nada que se pierda). */
const BULK_DECISION: MaintenanceOptionId[] = ['delete_local', 'delete_remote'];

export function Maintenance() {
  const { status, flash } = useApp();
  const ws = status.workspace!; const project = status.project!;
  const { planId } = useParams(); const navigate = useNavigate();
  const [plan, setPlan] = useState<MaintenancePlan | null>(null);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState<null | 'review' | 'run' | 'reject'>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, MaintenanceOptionId>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [common, setCommon] = useState(''); // cierre de etapa: el motivo común que adoptas al autorizar
  const [undo, setUndo] = useState<{ prev: Record<string, MaintenanceOptionId>; count: number; of: string } | null>(null);
  const resultsRef = useRef<HTMLHeadingElement>(null); const rejectedRef = useRef<HTMLDivElement>(null);
  const prevStatus = useRef<string | null>(null);
  const owner = useOwner(); const isOwner = owner === true;
  const [others, setOthers] = useState<MaintenancePlan[]>([]); // otras revisiones pendientes del proyecto (al ejecutar una, las demás dejan de valer)
  const paired = () => { flash('Navegador vinculado: ya puedes decidir aquí'); requestAnimationFrame(() => (document.getElementById('mnt-confirm-h') ?? document.querySelector<HTMLElement>('main h1'))?.focus()); };

  // Sin id: la última revisión del proyecto (o ninguna). Con id: esa.
  useEffect(() => {
    let live = true; setLoading(true); setError(null);
    (planId ? api.maintenancePlan(ws.slug, planId) : api.maintenancePlans(ws.slug, project.id).then(l => l[0] ?? null))
      .then(p => { if (live) setPlan(p); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [ws.slug, project.id, planId]);
  useEffect(() => {
    if (!plan || (plan.status !== 'proposed' && plan.status !== 'partial')) { setOthers([]); return; }
    let live = true;
    api.maintenancePlans(ws.slug, project.id).then(l => { if (live) setOthers(l.filter(p => p.id !== plan.id && p.status === 'proposed')); }).catch(() => undefined);
    return () => { live = false; };
  }, [ws.slug, project.id, plan?.id, plan?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // Selección: sin ejecutar, lo seguro con su acción y lo demás en «Conservar». Ya ejecutada, lo que se eligió de verdad;
  // al reanudar, solo vuelve marcado lo que falló o no se tocó (lo que dejaste fuera sigue fuera).
  useEffect(() => {
    if (!plan) return;
    const ex = plan.execution;
    if (!ex && plan.prepared?.length) {
      // Cierre de etapa: la selección preparada (lo demás en «Conservar») con su motivo; nada se ejecuta sin tu autorización.
      setChoice(Object.fromEntries([...plan.items.filter(i => i.category === 'safe' || i.category === 'decision').map(i => [i.id, 'keep' as MaintenanceOptionId]), ...plan.prepared.map(s => [s.itemId, s.option] as const)]));
      setReasons(Object.fromEntries(plan.prepared.filter(s => s.reason).map(s => [s.itemId, s.reason!])));
      setCommon(plan.intent?.reason ?? '');
    }
    else if (!ex) setChoice(Object.fromEntries(plan.items.filter(i => i.category === 'safe' || i.category === 'decision').map(i => [i.id, i.defaultOption])));
    else {
      const out = new Map(ex.outcomes.map(o => [o.itemId, o.status]));
      setChoice(Object.fromEntries(ex.selection.map(s => [s.itemId, s.option !== 'keep' && (plan.status !== 'partial' || ['failed', 'started', undefined].includes(out.get(s.itemId))) ? s.option : 'keep'])));
      setReasons(Object.fromEntries(ex.selection.filter(s => s.reason).map(s => [s.itemId, s.reason!])));
    }
    setConsent(false); setShowErrors(false);
  }, [plan?.id, plan?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mientras se ejecuta, el progreso objetivo a objetivo (anunciado) y, al terminar, el foco va al resultado.
  useEffect(() => {
    if (!plan) return;
    const ex = plan.execution; const total = ex?.selection.filter(s => s.option !== 'keep').length ?? 0;
    if (plan.status === 'running') setAnnounce(`Ejecutando ${ex?.outcomes.filter(o => o.status !== 'started').length ?? 0} de ${total}…`);
    if (prevStatus.current === 'running' && plan.status !== 'running') {
      const c = (s: string) => ex?.outcomes.filter(o => o.status === s).length ?? 0;
      setAnnounce(`Terminado: ${c('done')} hecho(s), ${c('failed')} con error, ${c('skipped')} sin tocar.`);
      requestAnimationFrame(() => resultsRef.current?.focus());
    }
    prevStatus.current = plan.status;
    if (plan.status !== 'running') return;
    const t = window.setInterval(() => { void api.maintenancePlan(ws.slug, plan.id).then(setPlan).catch(() => undefined); }, 1200);
    return () => window.clearInterval(t);
  }, [plan, ws.slug]);

  const review = async () => {
    setBusy('review'); setError(null);
    try { const p = await api.createMaintenancePlan(ws.slug, project.id, plan?.id ?? null); setPlan(p); navigate(`/mantenimiento/${p.id}`, { replace: !!planId }); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };
  const outcomeOf = useMemo(() => new Map((plan?.execution?.outcomes ?? []).map(o => [o.itemId, o])), [plan]);
  const isDone = (id: string) => ['done', 'noop'].includes(outcomeOf.get(id)?.status ?? '');
  const editable = plan?.status === 'proposed' || plan?.status === 'partial';
  const selected = useMemo(() => plan && editable ? plan.items.filter(i => !isDone(i.id) && choice[i.id] && choice[i.id] !== 'keep') : [], [plan, choice, editable]); // eslint-disable-line react-hooks/exhaustive-deps
  const missingReason = selected.filter(i => i.options.find(o => o.id === choice[i.id])?.needsReason && (reasons[i.id] ?? '').trim().length < 3);
  // Elegir una rama que sigue abierta en su carpeta de trabajo elige también retirar la carpeta (si no, se omitiría).
  /** Elegir (pura): elegir algo elige su carpeta segura; dejarlo en «Conservar» deja también lo que depende de ello. */
  const applyPick = (ch: Record<string, MaintenanceOptionId>, it: MaintenanceItem, o: MaintenanceOptionId) => {
    const next: Record<string, MaintenanceOptionId> = { ...ch, [it.id]: o }; const cascaded: string[] = [];
    if (o !== 'keep') { for (const r of requiresOf(it.requires)) { const x = plan?.items.find(i => i.id === r); if (x?.kind === 'worktree' && x.category === 'safe' && (next[r] ?? 'keep') === 'keep') next[r] = 'remove_worktree'; } }
    else for (const stack = [it.id]; stack.length;) { const id = stack.pop()!; for (const x of plan?.items ?? []) if (requiresOf(x.requires).includes(id) && (next[x.id] ?? 'keep') !== 'keep') { next[x.id] = 'keep'; cascaded.push(x.id); stack.push(x.id); } }
    return { next, cascaded };
  };
  const pick = (it: MaintenanceItem, o: MaintenanceOptionId) => {
    if (o !== 'keep' && common.trim() && it.options.find(x => x.id === o)?.needsReason && !(reasons[it.id] ?? '').trim()) setReasons(rs => ({ ...rs, [it.id]: common.trim() }));
    const { cascaded } = applyPick(choice, it, o);
    if (cascaded.length) {
      // Se anuncia y se puede deshacer (solo lo que cambió la cascada y el objetivo que la provocó).
      const ids = [it.id, ...cascaded];
      // Varias en el mismo gesto (p. ej. «Conservar todas»): se acumulan y «Deshacer» las restaura todas.
      const prev = Object.fromEntries(ids.map(id => [id, choice[id] ?? 'keep'])) as Record<string, MaintenanceOptionId>;
      setUndo(u => u ? { prev: { ...prev, ...u.prev }, count: u.count + cascaded.length, of: u.of === it.name ? it.name : 'varios objetivos' } : { prev, count: cascaded.length, of: it.name });
      setAnnounce(`Al conservar «${it.name}» también pasan a «Conservar» ${cascaded.length} objetivo(s) que dependían de él.`);
    }
    setChoice(ch => applyPick(ch, it, o).next);
  };
  const run = async () => {
    if (!plan) return;
    if (missingReason.length) { setShowErrors(true); requestAnimationFrame(() => (document.getElementById(`${missingReason[0].id}-reason`) as HTMLInputElement | null)?.focus()); return; }
    setBusy('run'); setError(null);
    try { setPlan(await api.executeMaintenancePlan(ws.slug, plan.id, selected.map(i => ({ itemId: i.id, option: choice[i.id], reason: reasons[i.id]?.trim() || null })))); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };
  const reject = async () => {
    if (!plan) return; setBusy('reject');
    try { setPlan(await api.rejectMaintenancePlan(ws.slug, plan.id)); flash('Revisión rechazada: no se ejecutó nada'); requestAnimationFrame(() => rejectedRef.current?.focus()); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const n = (k: MaintenanceItem['kind']) => selected.filter(i => i.kind === k && (k !== 'story' || i.id.startsWith('story:'))).length;
  const gone = (k: MaintenanceItem['kind']) => plan ? plan.items.filter(i => i.kind === k && (k !== 'story' || i.id.startsWith('story:')) && isDone(i.id)).length : 0;
  const openOf = (k: MaintenanceItem['kind']) => plan ? plan.items.filter(i => i.kind === k && (i.category === 'safe' || i.category === 'decision' || i.category === 'protected')).length : 0;
  const remoteName = plan?.repo.remote ?? 'el remoto';
  /** Qué hay que elegir para que algo que depende de ello se haga (mismo lenguaje que el servidor). */
  const needAction = (x: MaintenanceItem) => x.kind === 'batch' ? `cerrar el lote «${x.name}»` : x.kind === 'story' ? `cancelar ${x.story?.storyId || x.name}` : x.kind === 'iteration' ? `descartar la ${x.name.charAt(0).toLowerCase()}${x.name.slice(1)}` : x.kind === 'worktree' ? `retirar «${x.name}»` : x.name;
  const kindLabel = (k: MaintenanceItem['kind']) => ({ remote_branch: `Ramas en ${remoteName}`, local_branch: 'Ramas en este equipo', worktree: 'Carpetas de trabajo', story: 'Historias', batch: 'Lotes', iteration: 'Iteraciones sin integrar', assignment: 'Encargos' }[k]);
  const after = plan ? {
    remote: plan.repo.remoteAvailable ? `${Math.max(0, plan.counts.remoteBranches - n('remote_branch') - gone('remote_branch'))} rama(s) en ${remoteName}` : `ramas en el remoto sin comprobar`,
    local: `${Math.max(0, plan.counts.localBranches - n('local_branch') - gone('local_branch'))} en este equipo`,
    wt: `${Math.max(0, plan.counts.worktrees - n('worktree') - gone('worktree'))} carpeta(s) de trabajo`,
    stories: `${Math.max(0, plan.counts.openStories - n('story') - gone('story'))} historia(s) abiertas`,
    batches: `${Math.max(0, plan.counts.openBatches - n('batch') - gone('batch'))} lote(s) abiertos`
  } : null;

  return <Shell crumb="Revisión del proyecto">
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
      <PageHeader icon={Icon.git()} tone="project" eyebrow={`${ws.name} · ${plan?.projectName ?? project.name}`} title="Revisión del proyecto"
        description="Ramas, carpetas de trabajo y backlog frente a main. Revisar no cambia nada; solo se ejecuta lo que elijas y autorices."
        actions={<button type="button" className="btn btn-secondary" onClick={() => void review()} disabled={busy !== null || plan?.status === 'running' || !isOwner} aria-describedby={owner === false ? 'mnt-owner' : undefined}>{busy === 'review' ? <span className="spin" /> : Icon.history()}{plan ? 'Revisar de nuevo' : 'Revisar ahora'}</button>} />
      {owner === false && <OwnerPairing id="mnt-owner" what="preparar, ejecutar o rechazar una revisión" onPaired={paired} />}
      {owner === true && <OwnerStatus />}
      {others.length > 0 && <Notice kind="info">Hay {others.length === 1 ? 'otra revisión pendiente' : `${others.length} revisiones pendientes más`} de este proyecto ({others.map((o, i) => <span key={o.id}>{i ? ', ' : ''}<Link className="lnk" to={`/mantenimiento/${o.id}`}>{o.intent?.kind === 'close_stage' ? 'cierre de etapa' : 'revisión'} del {new Date(o.createdAt).toLocaleString('es')}{o.createdBy === 'assistant' || o.source ? ', pedida al Asistente' : ''}</Link></span>)}). Al ejecutar una, las demás dejan de valer.</Notice>}
      {error && <Notice kind="err">{error}</Notice>}
      {loading && <Spinner />}
      {!loading && !plan && <div className="card"><EmptyState art="gears" title="Aún no hay ninguna revisión" action={<button type="button" className="btn btn-primary" onClick={() => void review()} disabled={busy !== null || !isOwner} aria-describedby={owner === false ? 'mnt-owner' : undefined}>{Icon.history()}Revisar ahora</button>}>
        Compara cada rama (en el remoto y en este equipo), cada carpeta de trabajo y cada historia abierta con main, y te propone qué cerrar o limpiar. No cambia nada hasta que lo autorices.
      </EmptyState></div>}
      {plan && <>
        <div className="stats" role="group" aria-label="Estado revisado">
          <Stat icon={Icon.git()} value={plan.repo.mainSha?.slice(0, 7) ?? '—'} label={`${plan.repo.mainBranch ?? 'main'} (referencia)`} />
          <Stat icon={Icon.external()} tone={plan.repo.remoteAvailable ? undefined : 'attention'} value={plan.repo.remoteAvailable ? plan.counts.remoteBranches : '—'} label={plan.repo.remoteAvailable ? `ramas en ${remoteName}` : 'remoto sin comprobar'} />
          <Stat icon={Icon.layers()} value={plan.counts.localBranches} label="ramas en este equipo" />
          <Stat icon={Icon.kanban()} value={plan.counts.openStories} label="historias abiertas" />
        </div>
        <div className="small muted">Revisado el {new Date(plan.createdAt).toLocaleString('es-MX')}</div>
        {!plan.repo.remoteAvailable && <Notice kind="warn"><strong>El remoto no se pudo comprobar.</strong> {plan.repo.remoteError} Lo local se revisa igual; no se propone borrar nada en el remoto.</Notice>}
        {plan.intent?.kind === 'close_stage' && editable && !plan.execution && (() => {
          const sel = selected.map(i => ({ it: i, o: i.options.find(x => x.id === choice[i.id])! }));
          const count = (ids: string[]) => sel.filter(x => ids.includes(x.o.id)).length;
          const named = (ids: string[]) => sel.filter(x => ids.includes(x.o.id));
          const link = (x: { it: MaintenanceItem }) => <a key={x.it.id} className="lnk" href={`#row-${x.it.id}`}>{x.it.kind === 'story' ? x.it.story?.storyId || x.it.name : x.it.kind === 'assignment' ? x.it.name.split(' · ')[0] : x.it.name}</a>;
          const list = (label: string, xs: { it: MaintenanceItem }[]) => xs.length ? <li key={label}>{label} ({xs.length}): {xs.map((x, i) => <span key={x.it.id}>{i ? ', ' : ''}{link(x)}</span>)}</li> : null;
          const prepared = new Map((plan.prepared ?? []).map(x => [x.itemId, x.option]));
          const changed = (plan.items.some(i => (choice[i.id] ?? 'keep') !== (prepared.get(i.id) ?? 'keep')));
          return <div className="card card-b mnt-stage" role="region" aria-labelledby="mnt-stage-h" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 className="h3" id="mnt-stage-h" style={{ margin: 0 }}>Cierre de etapa: {selected.length} acción(es) elegidas{changed ? ` (preparadas: ${plan.prepared?.length ?? 0})` : ''}</h2>
            <div className="small">Viene elegido todo lo que se puede cerrar o retirar; nunca carpetas con cambios sin guardar ni lo protegido. Nada se ejecuta hasta que marques la autorización y pulses «Ejecutar lo elegido».</div>
            <ul className="small mnt-stage-list" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {count(['delete_remote', 'delete_local']) > 0 && <li>Borrar ramas ya integradas en main ({count(['delete_remote', 'delete_local'])}): no se pierde nada.</li>}
              {count(['archive_delete_remote', 'archive_delete_local']) > 0 && <li><strong>Guardar copia y borrar ramas con trabajo que no está en main ({count(['archive_delete_remote', 'archive_delete_local'])})</strong>: la copia queda en este equipo.</li>}
              {count(['remove_worktree']) > 0 && <li>Retirar carpetas de trabajo sin cambios sin guardar ({count(['remove_worktree'])}).</li>}
              {list('Cancelar historias', named(['discard']))}
              {list('Cerrar como hechas o aceptar (su código está en main)', named(['accept', 'close_done']).filter(x => !x.o.needsReason))}
              {list('Cerrar como hechas aunque les falta un paso de la regla de cierre (queda constancia de lo que faltaba)', named(['accept', 'close_done']).filter(x => x.o.needsReason))}
              {list('Aceptar encargos (su trabajo está en main)', named(['accept_assignment']))}
              {list('Cancelar encargos', named(['cancel_assignment']))}
              {list('Descartar iteraciones sin integrar', named(['discard_iteration']))}
              {list('Cerrar el lote', named(['close_batch']))}
            </ul>
            {(changed || undo) && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {undo && <><span className="small">Al conservar «{undo.of}» también pasaron a «Conservar» {undo.count} objetivo(s) que dependían de él.</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => { const prev = undo.prev; setChoice(ch => ({ ...ch, ...prev })); setUndo(null); setAnnounce('Deshecho.'); }}>Deshacer</button></>}
              {changed && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setChoice(Object.fromEntries([...plan.items.filter(i => i.category === 'safe' || i.category === 'decision').map(i => [i.id, 'keep' as MaintenanceOptionId]), ...(plan.prepared ?? []).map(x => [x.itemId, x.option] as const)])); setUndo(null); setAnnounce('Vuelve la selección preparada.'); }}>Volver a la selección preparada</button>}
            </div>}
            <label className="label" htmlFor="mnt-common">{plan.intent.source === 'assistant' ? 'Motivo propuesto por el Asistente (revísalo: al autorizar queda en el historial como tuyo)' : 'Motivo del cierre (queda en el historial)'}</label>
            <input id="mnt-common" className="input" value={common} maxLength={300} onChange={e => { const prev = common; const next = e.target.value; setCommon(next); setReasons(rs => Object.fromEntries(Object.entries(rs).map(([k, v]) => [k, v === prev ? next : v]))); }} />
          </div>; })()}
        {plan.status === 'stale' && <Notice kind="warn"><strong>Esta revisión caducó:</strong> {plan.supersededBy ? <>hay una más reciente (<Link className="lnk" to={`/mantenimiento/${plan.supersededBy}`}>abrirla</Link>)</> : 'el repositorio cambió desde que se hizo'} y no se ejecuta.{plan.supersededBy ? '' : ' Pulsa «Revisar de nuevo».'}</Notice>}
        {plan.status === 'rejected' && <div ref={rejectedRef} tabIndex={-1}><Notice kind="info">Rechazaste esta revisión: no se ejecutó nada.</Notice></div>}
        {plan.execution?.interrupted && plan.status === 'partial' && <Notice kind="warn">La ejecución se interrumpió (p. ej. un reinicio). Lo hecho está anotado; puedes reanudar lo que falta.</Notice>}
        {plan.status === 'running' && <div className="card card-b" style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span className="spin" aria-hidden="true" /> Ejecutando lo que autorizaste: {plan.execution?.outcomes.filter(o => o.status !== 'started').length ?? 0} de {plan.execution?.selection.filter(s => s.option !== 'keep').length ?? 0}…</div>}
        {editable && selected.length > 0 && <div className="mnt-jump small"><strong>{selected.length} acción(es) elegida(s)</strong> · <a className="lnk" href="#mnt-confirm-h">Ir a autorizar</a></div>}

        {plan.execution && plan.status !== 'running' && <Results plan={plan} headingRef={resultsRef} />}

        {CATS.map(c => { const list = plan.items.filter(i => i.category === c.id); if (!list.length) return null; return <section key={c.id} className="card" aria-labelledby={`mnt-${c.id}`}>
          <div className="card-h"><div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Tile icon={c.icon()} tone={c.tone} size="sm" /><div><h2 className="h3" id={`mnt-${c.id}`} style={{ margin: 0 }}>{MAINTENANCE_CATEGORY_LABEL[c.id]} <span className="muted">({list.length})</span></h2><div className="small muted">{c.hint}</div></div></div></div>
          {KIND_ORDER.map(k => { const rows = list.filter(i => i.kind === k); if (!rows.length) return null;
            const gid = `mnt-${c.id}-${k}`; const pickables = rows.filter(r => !isDone(r.id));
            const on = pickables.filter(r => (choice[r.id] ?? 'keep') !== 'keep').length;
            // En bloque: lo seguro entero; en «Requiere tu decisión», solo «borrar» sobre las ramas ya integradas que lo admiten.
            const groupLabel = `${kindLabel(k).toLowerCase()} (${MAINTENANCE_CATEGORY_LABEL[c.id].toLowerCase()})`;
            const bulkOpts = c.id === 'decision' ? BULK_DECISION.map(id => ({ id, rows: pickables.filter(r => r.options.some(o => o.id === id)) })).filter(x => x.rows.length > 1).map(x => ({ ...x, label: x.rows[0].options.find(o => o.id === x.id)!.label })) : [];
            const bulk = editable && pickables.length > 1 && (c.id === 'safe' || bulkOpts.length > 0);
            const body = <ul className="mnt-list" aria-labelledby={gid}>{rows.map(it => <Row key={it.id} it={it} done={isDone(it.id)} editable={editable} executed={!!plan.execution} choice={choice[it.id] ?? 'keep'} requirements={requiresOf(it.requires).filter(r => plan.items.some(i => i.id === r)).map(r => { const x = plan.items.find(i => i.id === r)!; return { id: r, name: needAction(x), kind: x.kind, chosen: (choice[r] ?? 'keep') !== 'keep', done: isDone(r) }; })} reason={reasons[it.id] ?? ''} showError={showErrors}
              onChoice={o => pick(it, o)} onReason={r => setReasons(rs => ({ ...rs, [it.id]: r }))} outcome={outcomeOf.get(it.id)} />)}</ul>;
            return <div key={k} className="mnt-group">
              <div className="mnt-group-h"><h3 className="mnt-group-title" id={gid}>{kindLabel(k)} <span className="muted">({rows.length})</span></h3>
                {bulk && <span className="mnt-bulk">
                  {c.id === 'safe' && <button type="button" className="btn btn-ghost btn-sm" aria-label={`Marcar las ${pickables.length}: ${groupLabel}`} onClick={() => pickables.forEach(r => pick(r, r.defaultOption))}>Marcar las {pickables.length}</button>}
                  {bulkOpts.map(b => <button key={b.id} type="button" className="btn btn-ghost btn-sm" aria-label={`«${b.label}» en las ${b.rows.length} ya integradas: ${groupLabel}`} onClick={() => b.rows.forEach(r => pick(r, b.id))}>«{b.label}» en las {b.rows.length} ya integradas</button>)}
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Conservar todas las ${pickables.length}: ${groupLabel}`} onClick={() => pickables.forEach(r => pick(r, 'keep'))}>Conservar todas</button>
                  <span className="small muted">{on} de {pickables.length} elegidas</span></span>}
              </div>
              {c.id === 'safe' && rows[0] && <div className="small muted mnt-group-effect">{rows[0].options.find(o => o.id === rows[0].defaultOption)?.effect}</div>}
              {rows.length > COLLAPSE_AT ? <details className="mnt-more"><summary className="small">Ver las {rows.length}{c.id === 'safe' || c.id === 'decision' ? ` (${on} elegidas)` : ''}</summary>{body}</details> : body}
            </div>; })}
        </section>; })}

        {editable && <section className="card" aria-labelledby="mnt-confirm-h">
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h2 className="h3" id="mnt-confirm-h" tabIndex={-1} style={{ margin: 0 }}>{selected.length ? `Se ejecutarán ${selected.length} acción(es)` : 'No hay nada elegido'}</h2>
            {selected.length > 0 && <div className="small">{[n('story') && `${n('story')} historia(s)`, selected.length - selected.filter(i => i.kind !== 'story' || i.id.startsWith('story:')).length > 0 && `${selected.length - selected.filter(i => i.kind !== 'story' || i.id.startsWith('story:')).length} aceptación(es) en su lote`, n('assignment') && `${n('assignment')} encargo(s)`, n('iteration') && `${n('iteration')} iteración(es)`, n('batch') && `${n('batch')} lote(s)`, n('remote_branch') && `${n('remote_branch')} rama(s) en ${remoteName}`, n('local_branch') && `${n('local_branch')} rama(s) de este equipo`, n('worktree') && `${n('worktree')} carpeta(s) de trabajo`].filter(Boolean).join(' · ')}</div>}
            {after && <div className="mnt-after"><strong>Estado final esperado:</strong> {after.remote} · {after.local} · {after.wt} · {after.stories} · {after.batches}{openOf('assignment') ? ` · ${Math.max(0, openOf('assignment') - n('assignment') - gone('assignment'))} encargo(s) abiertos` : ''}{openOf('iteration') ? ` · ${Math.max(0, openOf('iteration') - n('iteration') - gone('iteration'))} iteración(es) sin integrar` : ''}.</div>}
            {showErrors && missingReason.length > 0 && <Notice kind="warn">Falta el motivo en {missingReason.length} objetivo(s): {missingReason.map(i => i.name).join(' · ')}.</Notice>}
            <label className="ck"><input className="cb" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={!selected.length} /><span>Autorizo exactamente estas {selected.length} acción(es) sobre «{plan.projectName}»{plan.intent?.kind === 'close_stage' && common.trim() ? <> con el motivo «{common.trim()}»</> : null}. Justo antes de ejecutar se comprueba de nuevo el estado real; lo que haya cambiado no se toca. Nada se fuerza.</span></label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" disabled={!consent || !selected.length || busy !== null || !isOwner} aria-describedby={owner === false ? 'mnt-owner-needed' : undefined} onClick={() => void run()}>{busy === 'run' ? <span className="spin spin-light" /> : Icon.check()}{plan.status === 'partial' ? 'Reanudar lo elegido' : 'Ejecutar lo elegido'}</button>
              {plan.status === 'proposed' && <button type="button" className="btn btn-ghost" disabled={busy !== null || !isOwner} aria-describedby={owner === false ? 'mnt-owner-needed' : undefined} onClick={() => void reject()}>Rechazar la revisión</button>}
            </div>
            {owner === false && <div id="mnt-owner-needed" className="small muted">Para autorizar o rechazar, vincula antes este navegador como propietario (arriba).</div>}
          </div>
        </section>}
      </>}
      <div className="small muted">Todo queda registrado: cada historia guarda su motivo en su hilo, cada lote en sus eventos y cada operación en la auditoría. <Link className="lnk" to="/backlog">Ir al backlog</Link></div>
    </main>
  </Shell>;
}

function Row({ it, done, editable, executed, choice, requirements, reason, showError, onChoice, onReason, outcome }: { it: MaintenanceItem; done: boolean; editable: boolean; executed: boolean; requirements: { id: string; name: string; kind: MaintenanceItem['kind'] | null; chosen: boolean; done: boolean }[]; choice: MaintenanceOptionId; reason: string; showError: boolean; onChoice: (o: MaintenanceOptionId) => void; onReason: (r: string) => void; outcome?: MaintenanceOutcome }) {
  const pickable = (it.category === 'safe' || it.category === 'decision') && editable && !done;
  const opt = it.options.find(o => o.id === choice);
  const branchy = it.kind === 'remote_branch' || it.kind === 'local_branch';
  const action = it.options.find(o => o.id !== 'keep');
  const reasonBad = showError && opt?.needsReason && reason.trim().length < 3;
  const storyLabel = it.story?.storyId || it.name;
  const asCheckbox = it.category === 'safe' && it.options.length === 2 && !!action;
  const asRadios = !asCheckbox && (it.category === 'safe' || it.category === 'decision') && it.options.length > 1;
  const showDeps = pickable && !!opt && opt.id !== 'keep' && requirements.length > 0;
  const describedBy = `${it.id}-why${showDeps ? ` ${it.id}-deps` : ''}`;
  const depLink = (r: { id: string; name: string }) => <a key={r.id} className="lnk" href={`#row-${r.id}`}>{r.name}</a>;
  return <li className={`mnt-row mnt-${it.category}`} id={`row-${it.id}`}>
    <div className="mnt-row-main">
      <div className="mnt-row-h">
        {asCheckbox && action && pickable
          ? <label className="ck"><input className="cb" type="checkbox" checked={choice !== 'keep'} onChange={e => onChoice(e.target.checked ? it.defaultOption : 'keep')} aria-label={`${action.label}: ${it.name}`} aria-describedby={describedBy} /><span className={branchy ? 'mono' : undefined}>{it.name}</span></label>
          : <span className={branchy ? 'mono mnt-name' : 'mnt-name'}>{it.name}</span>}
        <Chip xs tone={it.category === 'safe' ? 'ok' : it.category === 'decision' ? 'warn' : ''}>{it.status}</Chip>
        {it.sha && <span className="small mono muted">{it.sha}</span>}
        {outcome && outcome.status !== 'started' && <Chip xs tone={outcome.status === 'done' || outcome.status === 'noop' ? 'ok' : outcome.status === 'failed' ? 'err' : ''}>{OUTCOME_LABEL[outcome.status]}</Chip>}
        {!outcome && !done && (editable || executed) && it.category === 'safe' && choice === 'keep' && <Chip xs>No elegido</Chip>}
      </div>
      <div className="small med" id={`${it.id}-why`}>{it.reason}{it.story && it.kind !== 'story' ? <> · Historia <Link className="lnk" to={`/historias/${encodeURIComponent(it.story.id)}`}>{it.story.storyId}</Link></> : null}{it.kind === 'story' && it.story ? <> · <Link className="lnk" to={`/historias/${encodeURIComponent(it.story.id)}`}>Abrir la historia</Link></> : null}</div>
      {(it.uniqueCommits?.length ?? 0) > 0 && <details className="mnt-commits"><summary className="small">{it.unique} cambio(s) que no están en main</summary><ul className="small mono">{it.uniqueCommits!.map(c => <li key={c}>{c}</li>)}</ul></details>}
      {asRadios && <fieldset className="mnt-choices" disabled={!pickable}>
        <legend className="sr-only">Qué hacer con {it.name}</legend>
        {it.options.map(o => <label key={o.id} className={`mnt-choice${o.destructive ? ' is-destructive' : ''}`}><input type="radio" className="sr-only" name={`opt-${it.id}`} checked={choice === o.id} onChange={() => onChoice(o.id)} aria-describedby={describedBy} />{choice === o.id ? Icon.check() : null}<span>{o.label}</span></label>)}
      </fieldset>}
      {pickable && opt && opt.id !== 'keep' && asRadios && <div className="small">{opt.effect}</div>}
      {showDeps && (requirements.every(r => r.chosen || r.done)
        ? <div className="small muted" id={`${it.id}-deps`}>{requirements.length === 1 && requirements[0].kind === 'worktree' ? <>También se retirará {depLink(requirements[0])} (la rama sigue abierta en ella).</> : <>Antes se hará (está elegido): {requirements.map((r, i) => <span key={r.id}>{i ? ' · ' : ''}{depLink(r)}{r.done ? ' (ya hecho)' : ''}</span>)}.</>}</div>
        : <div className="small" id={`${it.id}-deps`} style={{ color: 'var(--color-attention-text)' }}>{requirements.length === 1 && requirements[0].kind === 'worktree' ? <>Se omitirá: sigue abierta en {depLink(requirements[0])}, que has dejado en «Conservar».</> : <>Se omitirá: para hacerlo hay que elegir también {requirements.filter(r => !r.chosen && !r.done).map((r, i) => <span key={r.id}>{i ? ' · ' : ''}{depLink(r)}</span>)}.</>}</div>)}
      {pickable && opt?.needsReason && <div><label className="label" htmlFor={`${it.id}-reason`}>{(REASON_LABEL[opt.id] ?? (n => `Motivo para «${n}»`))(it.kind === 'batch' || it.kind === 'iteration' ? it.name : it.kind === 'assignment' ? it.name.split(' · ')[0] : storyLabel)} (queda en el historial)</label>
        <input id={`${it.id}-reason`} className="input" required value={reason} maxLength={300} aria-invalid={reasonBad || undefined} aria-describedby={reasonBad ? `${it.id}-reason-err` : undefined} onChange={e => onReason(e.target.value)} placeholder="Ej.: sustituida por el rediseño 2.0" />
        {reasonBad && <div className="small" id={`${it.id}-reason-err`} style={{ color: 'var(--color-err-text)' }}>Escribe el motivo (al menos 3 caracteres).</div>}</div>}
      {outcome && outcome.status !== 'started' && <div className="small"><strong>{outcome.status === 'done' ? 'Resultado:' : outcome.status === 'failed' ? 'Error:' : outcome.status === 'noop' ? 'Nada que hacer:' : 'No se tocó:'}</strong> {outcome.message}</div>}
      {(outcome?.recovery || (pickable && opt && opt.id !== 'keep' && it.recovery)) && <details className="mnt-tech"><summary className="small">Cómo recuperarlo (detalles técnicos)</summary><div className="small mono">{outcome?.recovery ?? it.recovery}</div></details>}
    </div>
  </li>;
}

function Results({ plan, headingRef }: { plan: MaintenancePlan; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const outs = plan.execution!.outcomes; const c = (s: string) => outs.filter(o => o.status === s).length;
  const problems = outs.filter(o => o.status === 'failed' || o.status === 'skipped' || o.status === 'started');
  const name = (id: string) => plan.items.find(i => i.id === id)?.name ?? id;
  const ok = plan.status === 'done';
  return <section className="card" aria-labelledby="mnt-res-h">
    <div className="card-h"><div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Tile icon={ok ? Icon.check() : Icon.warn()} tone={ok ? 'ok' : 'attention'} size="sm" /><h2 className="h3" id="mnt-res-h" ref={headingRef} tabIndex={-1} style={{ margin: 0 }}>Resultado</h2></div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><Chip xs tone="ok">{c('done')} hecho(s)</Chip>{c('noop') > 0 && <Chip xs>{c('noop')} ya estaban así</Chip>}{c('failed') > 0 && <Chip xs tone="err">{c('failed')} con error</Chip>}{(c('skipped') + c('started')) > 0 && <Chip xs>{c('skipped') + c('started')} sin tocar</Chip>}</div></div>
    <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {problems.length > 0 && <><div className="small"><strong>Necesitan tu atención:</strong></div><ul className="small mnt-problems">{problems.map(o => <li key={o.itemId}><a className="lnk" href={`#row-${o.itemId}`}>{name(o.itemId)}</a> — {OUTCOME_LABEL[o.status]}: {o.message}</li>)}</ul>
        {plan.status === 'partial' && <div className="small muted">Lo que falló o se interrumpió vuelve marcado: corrige la causa y pulsa «Reanudar lo elegido» abajo. Lo que cambió desde la revisión necesita «Revisar de nuevo».</div>}</>}
      {plan.execution!.verification.length > 0 && <details open={problems.length === 0}><summary className="small">Verificación independiente (estado leído de nuevo tras ejecutar): {plan.execution!.verification.filter(v => v.startsWith('✓')).length} de {plan.execution!.verification.length} correctas</summary><ul className="small mono" style={{ margin: '6px 0 0', paddingLeft: 18, maxHeight: 260, overflow: 'auto' }}>{plan.execution!.verification.map((v, i) => <li key={i}>{v}</li>)}</ul></details>}
    </div>
  </section>;
}

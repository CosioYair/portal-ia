import { useEffect, useMemo, useRef, useState } from 'react';
import { usePersistentState } from '../lib/persist.ts';
import type { BacklogItem, BacklogStatus } from '@portal-ia/domain';
import { BATCH_LIMITS } from '@portal-ia/domain';
import { Chip } from './ui.tsx';
import '../batch-wizard.css';

/**
 * Selección de historias para un lote, pensada para cientos: búsqueda (ID, título, descripción), filtros (estado,
 * tamaño, dependencias), selección masiva SOLO de lo filtrado y elegible, rango con Mayús, paginación y la selección
 * conservada al cambiar de filtro o de página (siempre se dice cuántas quedan fuera de la vista).
 */
export const ELIGIBLE = (s: BacklogStatus) => s === 'pending' || s === 'blocked';
export const STATUS_LABEL: Record<BacklogStatus, string> = { pending: 'pendiente', blocked: 'bloqueada', in_progress: 'en curso', review: 'en revisión', done: 'terminada', discarded: 'descartada' };
const NOT_ELIGIBLE: Partial<Record<BacklogStatus, string>> = { in_progress: 'Ya está en curso: no entra en un lote.', review: 'Está en revisión: no entra en un lote.', done: 'Ya está terminada.', discarded: 'Está descartada.' };
const PAGE = 25;
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

type StatusFilter = 'eligible' | 'pending' | 'blocked' | 'all';
type SizeFilter = 'all' | 'S' | 'M' | 'L' | 'none';
type DepFilter = 'all' | 'with' | 'without' | 'missing';
type Sort = 'backlog' | 'id' | 'size';
const SIZE_RANK: Record<string, number> = { S: 0, M: 1, L: 2 };

export function BatchStoryPicker({ items, owners, selected, onAdd, onRemove, onClear, persistKey }: {
  /** Historias activas del proyecto, en el orden del backlog (su prioridad). */
  items: BacklogItem[];
  /** Nombre del responsable por su clave (agente), para el filtro. */
  owners: Map<string, string>;
  selected: string[];
  onAdd: (ids: string[]) => void;
  onRemove: (ids: string[]) => void;
  onClear: () => void;
  /** Clave (por empresa y proyecto) para conservar búsqueda, filtros y orden entre recargas. */
  persistKey?: string;
}) {
  const [f, setF] = usePersistentState(persistKey ?? 'portal-ia.lote.filtros', { q: '', status: 'eligible' as StatusFilter, size: 'all' as SizeFilter, dep: 'all' as DepFilter, onlySel: false, owner: 'all', sort: 'backlog' as Sort });
  const { q, status, size, dep, onlySel, owner, sort } = f;
  const setQ = (v: string) => setF(x => ({ ...x, q: v })); const setStatus = (v: StatusFilter) => setF(x => ({ ...x, status: v }));
  const setSize = (v: SizeFilter) => setF(x => ({ ...x, size: v })); const setDep = (v: DepFilter) => setF(x => ({ ...x, dep: v })); const setOnlySel = (v: boolean) => setF(x => ({ ...x, onlySel: v }));
  const setOwner = (v: string) => setF(x => ({ ...x, owner: v })); const setSort = (v: Sort) => setF(x => ({ ...x, sort: v }));
  const [page, setPage] = useState(0); const anchor = useRef<string | null>(null); const [note, setNote] = useState<string | null>(null);
  const sel = useMemo(() => new Set(selected), [selected]);
  const byStory = useMemo(() => new Map(items.map(i => [i.storyId, i])), [items]);
  const index = useMemo(() => items.map(i => ({ i, text: norm(`${i.storyId} ${i.title} ${i.description ?? ''}`) })), [items]);
  /** Dependencia que falta: depende de una historia sin terminar que no está seleccionada. */
  const missingDep = (i: BacklogItem) => { if (!i.dependsOn) return false; const d = byStory.get(i.dependsOn); return !!d && d.status !== 'done' && !sel.has(d.id); };
  const filtered = useMemo(() => {
    const words = norm(q).split(/\s+/).filter(Boolean);
    const out = index.filter(({ i, text }) =>
      (status === 'all' ? true : status === 'eligible' ? ELIGIBLE(i.status) : i.status === status)
      && (size === 'all' ? true : size === 'none' ? !i.estimate : i.estimate === size)
      && (dep === 'all' ? true : dep === 'with' ? !!i.dependsOn : dep === 'without' ? !i.dependsOn : missingDep(i))
      && (owner === 'all' ? true : owner === 'none' ? !i.ownerKey : i.ownerKey === owner)
      && (!onlySel || sel.has(i.id))
      && words.every(w => text.includes(w))).map(x => x.i);
    // Ordenar no cambia la selección: solo cómo se ve (y el rango con Mayús sigue lo que ves).
    if (sort === 'id') out.sort((a, b) => a.storyId.localeCompare(b.storyId, 'es', { numeric: true }));
    if (sort === 'size') out.sort((a, b) => (SIZE_RANK[a.estimate ?? ''] ?? 3) - (SIZE_RANK[b.estimate ?? ''] ?? 3));
    return out;
  }, [index, q, status, size, dep, owner, sort, onlySel, sel, byStory]);
  useEffect(() => { setPage(0); setNote(null); }, [q, status, size, dep, owner, sort, onlySel]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE)); const cur = Math.min(page, pages - 1);
  const rows = filtered.slice(cur * PAGE, cur * PAGE + PAGE);
  const visible = new Set(filtered.map(i => i.id));
  const hidden = selected.filter(id => !visible.has(id)).length;
  const addable = filtered.filter(i => ELIGIBLE(i.status) && !sel.has(i.id));
  const removable = filtered.filter(i => sel.has(i.id));
  const room = BATCH_LIMITS.maxItems - selected.length;
  const filtersOn = !!q.trim() || status !== 'eligible' || size !== 'all' || dep !== 'all' || owner !== 'all' || onlySel;
  const ownerKeys = useMemo(() => Array.from(new Set(items.map(i => i.ownerKey).filter((k): k is string => !!k))), [items]);

  const click = (i: BacklogItem, shift: boolean) => {
    const on = !sel.has(i.id);
    const a = anchor.current ? filtered.findIndex(x => x.id === anchor.current) : -1; const b = filtered.findIndex(x => x.id === i.id);
    // Mayús + clic: el rango entre el último clic y este, dentro de la lista filtrada (solo las elegibles).
    const range = shift && a >= 0 && b >= 0 ? filtered.slice(Math.min(a, b), Math.max(a, b) + 1).filter(x => ELIGIBLE(x.status)) : [i];
    anchor.current = i.id;
    if (on) {
      const want = range.filter(x => !sel.has(x.id)).map(x => x.id); const added = want.slice(0, Math.max(0, room));
      onAdd(added);
      // Nunca se recorta en silencio: si el máximo corta el rango, se dice.
      setNote(added.length < want.length ? `Se añadieron ${added.length} de ${want.length}: alcanzaste el máximo de ${BATCH_LIMITS.maxItems} historias por lote.` : null);
    } else { onRemove(range.map(x => x.id)); setNote(null); }
  };

  return (
    <div className="bw-picker" data-testid="batch-picker">
      <div className="bw-filters" role="search" aria-label="Buscar y filtrar historias">
        <label className="bw-field bw-search"><span className="small muted">Buscar</span>
          <input className="input" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="ID, título o descripción" aria-label="Buscar por ID, título o descripción" /></label>
        <label className="bw-field"><span className="small muted">Estado</span>
          <select className="input" aria-label="Filtrar por estado" value={status} onChange={e => setStatus(e.target.value as StatusFilter)}>
            <option value="eligible" title="Pendientes y bloqueadas: las que pueden entrar en un lote">Elegibles</option><option value="pending">Pendientes</option><option value="blocked">Bloqueadas</option><option value="all" title="También en curso, en revisión y terminadas (no seleccionables)">Todas</option>
          </select></label>
        <label className="bw-field"><span className="small muted">Tamaño</span>
          <select className="input" aria-label="Filtrar por tamaño" value={size} onChange={e => setSize(e.target.value as SizeFilter)}>
            <option value="all">Todos</option><option value="S">S</option><option value="M">M</option><option value="L">L</option><option value="none">Sin tamaño</option>
          </select></label>
        <label className="bw-field"><span className="small muted">Dependencias</span>
          <select className="input" aria-label="Filtrar por dependencias" value={dep} onChange={e => setDep(e.target.value as DepFilter)}>
            <option value="all">Todas</option><option value="with">Con dependencia</option><option value="without">Sin dependencia</option><option value="missing">Les falta su dependencia</option>
          </select></label>
        <label className="bw-field"><span className="small muted">Responsable</span>
          <select className="input" aria-label="Filtrar por responsable" value={owner} onChange={e => setOwner(e.target.value)}>
            <option value="all">Todos</option>{ownerKeys.map(k => <option key={k} value={k}>{owners.get(k) ?? k}</option>)}<option value="none">Sin responsable</option>
          </select></label>
        <label className="bw-field"><span className="small muted">Ordenar</span>
          <select className="input" aria-label="Ordenar historias" value={sort} onChange={e => setSort(e.target.value as Sort)}>
            <option value="backlog">Prioridad del backlog</option><option value="id">ID</option><option value="size">Tamaño (S → L)</option>
          </select></label>
        <label className="ck bw-only"><input className="cb" type="checkbox" checked={onlySel} onChange={e => setOnlySel(e.target.checked)} /><span>Solo las seleccionadas</span></label>
      </div>

      <div className="bw-bulk">
        <span className="small" aria-live="polite" data-testid="picker-count"><strong>{selected.length}</strong> seleccionada(s) de {BATCH_LIMITS.maxItems} posibles · {filtered.length} coinciden{hidden ? <> · <strong>{hidden}</strong> seleccionada(s) no se ven con estos filtros</> : null}</span>
        <span className="bw-bulk-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={!addable.length || addable.length > room} onClick={() => onAdd(addable.map(i => i.id))}
            title={addable.length > room ? `Superaría el máximo de ${BATCH_LIMITS.maxItems} por lote: filtra más.` : 'Solo las elegibles que ves con estos filtros (todas sus páginas)'}>
            Seleccionar {filtersOn ? 'las filtradas' : 'todas las elegibles'} ({addable.length})</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!removable.length} onClick={() => onRemove(removable.map(i => i.id))}>Quitar {filtersOn ? 'las filtradas' : 'todas'} ({removable.length})</button>
          {filtersOn && selected.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>Vaciar la selección ({selected.length})</button>}
        </span>
      </div>
      {note && <div className="small" role="status" data-testid="picker-note"><strong>{note}</strong></div>}
      {addable.length > room && <div className="small muted">Las {addable.length} {filtersOn ? 'filtradas' : 'elegibles'} superan las {Math.max(0, room)} plazas que quedan (máximo {BATCH_LIMITS.maxItems} por lote): filtra más o divide el trabajo en varios lotes. No se recorta en silencio.</div>}

      <div className="bw-table-wrap">
        <table className="tbl bw-tbl">
          <caption className="bw-sr">Historias del backlog en su orden de prioridad. Mayús + clic selecciona un rango.</caption>
          <thead><tr><th scope="col" className="bw-c-cb"><span className="bw-sr">Seleccionar</span></th><th scope="col">Historia</th><th scope="col" className="bw-c-size">Tamaño</th><th scope="col" className="bw-c-dep">Depende de</th><th scope="col" className="bw-c-st">Estado</th></tr></thead>
          <tbody>
            {rows.map(i => {
              const ok = ELIGIBLE(i.status); const on = sel.has(i.id); const d = i.dependsOn ? byStory.get(i.dependsOn) : undefined;
              const depNote = !i.dependsOn ? null : !d ? 'fuera del backlog activo' : d.status === 'done' ? 'terminada' : sel.has(d.id) ? 'en el lote' : 'falta';
              return (
                <tr key={i.id} className={on ? 'bw-on' : !ok ? 'bw-off' : undefined}>
                  <td className="bw-c-cb"><input className="cb" type="checkbox" checked={on} disabled={!ok || (!on && room <= 0)}
                    aria-label={`Seleccionar ${i.storyId} ${i.title}`} title={!ok ? NOT_ELIGIBLE[i.status] : undefined}
                    onClick={e => click(i, e.shiftKey)} onChange={() => undefined} /></td>
                  <td className="bw-c-title"><span className="mono small">{i.storyId}</span> <span>{i.title}</span>
                    {i.description ? <div className="small muted bw-desc">{i.description}</div> : null}
                    <div className="bw-meta-sm small muted">{i.estimate ?? 'sin tamaño'} · {STATUS_LABEL[i.status]}{i.dependsOn ? ` · depende de ${i.dependsOn} (${depNote})` : ''}</div></td>
                  <td className="bw-c-size mono small">{i.estimate ?? '—'}</td>
                  <td className="bw-c-dep small">{i.dependsOn ? <><span className="mono">{i.dependsOn}</span> {depNote === 'falta' ? <Chip xs tone="warn">falta</Chip> : <span className="muted">({depNote})</span>}</> : <span className="muted">—</span>}</td>
                  <td className="bw-c-st small">{ok ? STATUS_LABEL[i.status] : <Chip xs>{STATUS_LABEL[i.status]}</Chip>}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={5} className="small muted">Ninguna historia coincide con la búsqueda y los filtros.</td></tr>}
          </tbody>
        </table>
      </div>
      <nav className="bw-pages small" aria-label="Páginas de historias">
        <span>{filtered.length ? `${cur * PAGE + 1}–${Math.min(filtered.length, cur * PAGE + PAGE)} de ${filtered.length}` : '0 de 0'}</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={cur === 0} onClick={() => setPage(cur - 1)}>‹ Anterior</button>
        <span>Página {cur + 1} de {pages}</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Siguiente ›</button>
      </nav>
    </div>
  );
}

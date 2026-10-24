import { useEffect, useState } from 'react';
import type { FsEntry, FsListing } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { Chip, Empty, Icon } from './ui.tsx';

/**
 * FolderPicker — regla general del producto: toda ruta local se fija desde este componente.
 * Recorre todo el equipo (inicio, unidades, carpeta de esta instalación), permite saltar a una ruta escrita
 * (que se valida contra el disco antes de aceptarla) y solo lista carpetas (backend GET /api/fs/dirs).
 * Nota: un navegador no puede abrir el diálogo nativo del sistema devolviendo la ruta; eso llegará con la versión de escritorio.
 */
const splitPath = (p: string) => p.split(/[\\/]+/).filter((s, i) => s.length || i === 0);
const joinPath = (segs: string[], sample: string) => { const sep = sample.includes('\\') ? '\\' : '/'; const j = segs.join(sep); return /^[A-Za-z]:$/.test(j) ? j + sep : j || sep; };

export function FolderPicker({ title, hint, initialPath, requireGit, onSelect, onClose }: {
  title: string; hint: string; initialPath?: string | null; requireGit?: boolean;
  onSelect: (path: string, info: { isGit: boolean; branch: string | null }) => void; onClose: () => void;
}) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [roots, setRoots] = useState<FsEntry[] | null>(null);
  const [showRoots, setShowRoots] = useState(false);
  const [selected, setSelected] = useState<string | null>(initialPath ?? null);
  const [info, setInfo] = useState<{ isGit: boolean; branch: string | null } | null>(null);
  const [goto, setGoto] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (p?: string) => {
    setLoading(true); setError(null); setShowRoots(false);
    try { const l = await api.fsDirs(p); setListing(l); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  const openRoots = async () => { setShowRoots(true); setError(null); if (!roots) { try { setRoots(await api.fsRoots()); } catch (e: any) { setError(e.message); } } };

  useEffect(() => {
    api.fsRoots().then(setRoots).catch(() => {});
    const segs = initialPath ? splitPath(initialPath) : null;
    void load(segs && segs.length > 1 ? joinPath(segs.slice(0, -1), initialPath!) : undefined);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) { setInfo(null); return; }
    const e = listing?.entries.find(x => x.path === selected) ?? roots?.find(r => r.path === selected);
    if (e) setInfo({ isGit: e.isGit, branch: e.branch });
    else if (listing && listing.path === selected) setInfo({ isGit: listing.isGit, branch: listing.branch });
  }, [listing, roots, selected]);

  // "Ir a ruta": valida contra el disco (lista la carpeta) y la deja seleccionada.
  const jump = async () => {
    const p = goto.trim(); if (!p) return;
    setLoading(true); setError(null);
    try { const l = await api.fsDirs(p); setListing(l); setShowRoots(false); setSelected(l.path); setInfo({ isGit: l.isGit, branch: l.branch }); setGoto(''); }
    catch (e: any) { setError(`No se pudo abrir «${p}»: ${e.message}`); } finally { setLoading(false); }
  };

  const canConfirm = !!selected && (!requireGit || !!info?.isGit);
  const segs = listing ? splitPath(listing.path) : [];
  const entries: FsEntry[] = showRoots ? (roots ?? []) : (listing?.entries ?? []);

  return (
    <div className="backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="fp-title">
        <div className="modal-h">
          <div><div className="h3" id="fp-title">{title}</div><div className="small muted">{hint}</div></div>
          <button className="xbtn" onClick={onClose} aria-label="Cerrar" autoFocus>{Icon.x(16)}</button>
        </div>
        <div className="fp-bar">
          <button className="btn btn-ghost btn-sm" onClick={openRoots} aria-pressed={showRoots}>{Icon.grid()}Este equipo</button>
          <button className="btn btn-ghost btn-sm" onClick={() => listing?.parent ? load(listing.parent) : openRoots()} disabled={showRoots} aria-label="Subir un nivel">{Icon.folderUp()}Subir</button>
          <nav className="fp-crumbs" aria-label="Ruta actual">
            {!showRoots && segs.map((s, i) => { const path = joinPath(segs.slice(0, i + 1), listing!.path); const last = i === segs.length - 1;
              return <span key={path + i} style={{ display: 'contents' }}><button className="fp-crumb" aria-current={last} disabled={last} onClick={() => load(path)}>{s === '~' ? '~ (inicio)' : s || '/'}</button>{!last && <span className="sep">/</span>}</span>; })}
            {showRoots && <span className="fp-crumb" aria-current="true">Este equipo</span>}
          </nav>
          {!showRoots && listing?.isGit && <Chip tone="accent" xs>repositorio git</Chip>}
        </div>
        <form className="fp-bar" style={{ borderBottom: '1px solid #EEECE6', padding: '8px 18px' }} onSubmit={e => { e.preventDefault(); void jump(); }}>
          <input className="input mono" style={{ height: 34, fontSize: 13, flex: 1 }} value={goto} onChange={e => setGoto(e.target.value)} placeholder="Ir a ruta… (p. ej. C:\Mis Proyectos\Portal IA o ~/proyectos)" aria-label="Ir a ruta" />
          <button className="btn btn-secondary btn-sm" type="submit" disabled={!goto.trim() || loading}>Ir</button>
        </form>
        <ul className="fp-list" role="listbox" aria-label={showRoots ? 'Raíces del equipo' : listing ? `Carpetas en ${listing.path}` : 'Carpetas'}>
          {error && <li style={{ padding: 16 }}><div className="notice notice-err">{Icon.alert()}<div>{error}</div></div></li>}
          {!error && !showRoots && listing && listing.entries.length === 0 && <li><Empty icon={Icon.folder()} title="Carpeta vacía" hint="No hay subcarpetas aquí. Puedes seleccionar esta carpeta abajo si es la correcta." style={{ padding: '40px 16px' }} /></li>}
          {!error && entries.map(e => (
            <li key={e.path}>
              <div className={`fp-row ${selected === e.path ? 'is-selected' : ''}`} role="option" aria-selected={selected === e.path}>
                <button className="fp-row" style={{ padding: 0, border: 0, background: 'transparent', flex: 1 }} onClick={() => setSelected(selected === e.path ? null : e.path)} onDoubleClick={() => load(e.path)}>
                  {Icon.folder()}
                  <span className="fp-sel"><span style={{ fontWeight: 500, fontSize: 13.5 }}>{e.name}</span>
                    <span className="small muted mono">{showRoots ? e.path : e.isGit ? `repositorio git · rama ${e.branch ?? '?'}` : `${e.subdirs} subcarpeta${e.subdirs === 1 ? '' : 's'}`}</span></span>
                  {e.isGit && <Chip tone="accent" xs>git</Chip>}
                </button>
                <button className="fp-enter" onClick={() => load(e.path)} aria-label={`Abrir ${e.name}`}>{Icon.chevR()}</button>
              </div>
            </li>
          ))}
          {loading && !listing && <li className="muted sm13" style={{ padding: 16 }}>Cargando…</li>}
        </ul>
        <div className="modal-f">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
            <span className="small muted">Selección</span>
            <span className="mono sm13" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected ?? 'Ninguna carpeta seleccionada'}</span>
            {!showRoots && listing && selected !== listing.path && <button className="lnk small" style={{ alignSelf: 'flex-start' }} onClick={() => setSelected(listing.path)}>Usar la carpeta actual ({listing.path})</button>}
            {selected && requireGit && info && !info.isGit && <span className="small" style={{ color: '#7A4A00' }}>Esta carpeta no contiene un repositorio git.</span>}
            {selected && info?.isGit && <span className="small" style={{ color: '#166534' }}>Repositorio git{info.branch ? ` · rama ${info.branch}` : ''}</span>}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button className="btn btn-primary" disabled={!canConfirm} onClick={() => selected && onSelect(selected, info ?? { isGit: false, branch: null })}>Seleccionar esta carpeta</button>
          </div>
        </div>
      </div>
    </div>
  );
}

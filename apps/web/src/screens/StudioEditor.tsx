import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as RDragEvent, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { StudioAsset, StudioClip, StudioFormat, StudioHeight, StudioProject, StudioQuality, StudioRender, StudioTrack, StudioTrackKind } from '@portal-ia/domain';
import { STUDIO_FORMATS, STUDIO_HEIGHTS, STUDIO_QUALITY, STUDIO_TEXT_BG, STUDIO_TEXT_PRESETS, newStudioClip, splitStudioClip, studioCanvas, studioDuration } from '@portal-ia/domain';
import { ApiError } from '../lib/api.ts';
import { fmtBytes, fmtTime, studioApi, type StudioFull, type StudioVersion } from '../lib/studioApi.ts';
import { useApp } from '../lib/store.ts';
import { Shell } from '../components/Shell.tsx';
import { Modal } from '../components/Modal.tsx';
import { Chip, Icon, Notice, Spinner } from '../components/ui.tsx';
import '../studio.css';

/**
 * Portal IA 4 · Estudio: el editor. Biblioteca, vista previa, línea de tiempo con varias pistas y ajustes del fragmento.
 * Todo lo que se hace arrastrando se puede hacer también con el teclado o con los campos de «Ajustes del fragmento».
 * El proyecto se guarda solo (con historial en el servidor) y deshacer/rehacer vive en esta pestaña.
 */
const uid = () => `c-${crypto.randomUUID().slice(0, 8)}`;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const clipEnd = (c: StudioClip) => c.start + c.duration;
/** La misma regla que aplica el servidor al guardar: dentro de una pista nada se pisa; lo que pisa se empuja. */
function tidy(t: StudioTrack): StudioTrack {
  const clips = [...t.clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)).map(c => ({ ...c }));
  for (let i = 1; i < clips.length; i++) { const end = r3(clipEnd(clips[i - 1])); if (clips[i].start < end - 0.0005) clips[i].start = end; }
  return { ...t, clips };
}
const KIND_LABEL: Record<StudioTrackKind, string> = { video: 'Vídeo e imagen', audio: 'Audio', text: 'Texto' };
const trackKindFor = (a: StudioAsset): StudioTrackKind => (a.kind === 'audio' ? 'audio' : 'video');
const fadeGain = (c: StudioClip, t: number) => { const rel = t - c.start; let g = 1; if (c.fadeIn > 0) g = Math.min(g, rel / c.fadeIn); if (c.fadeOut > 0) g = Math.min(g, (c.duration - rel) / c.fadeOut); return clamp(g, 0, 1); };

// ---------- Vista previa ----------
function Preview({ slug, project, assets, time, playing, onTime, onEnd }: { slug: string; project: StudioProject; assets: Map<string, StudioAsset>; time: number; playing: boolean; onTime: (t: number) => void; onEnd: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const media = useRef(new Map<string, HTMLVideoElement | HTMLAudioElement | HTMLImageElement>());
  const state = useRef({ project, time, playing }); state.current = { project, time, playing };
  const size = useMemo(() => studioCanvas(project.format, 540), [project.format]);
  const total = studioDuration(project);

  const draw = useCallback((t: number) => {
    const cv = canvas.current; const ctx = cv?.getContext('2d'); if (!cv || !ctx) return;
    const { project: p } = state.current; const W = cv.width, H = cv.height;
    ctx.globalAlpha = 1; ctx.fillStyle = 'black'; ctx.fillRect(0, 0, W, H);
    for (const track of [...p.tracks].reverse()) {
      if (track.kind !== 'video' || track.hidden) continue;
      for (const c of track.clips) {
        if (t < c.start || t >= clipEnd(c)) continue;
        const el = media.current.get(c.id) as HTMLVideoElement | HTMLImageElement | undefined; if (!el) continue;
        const sw = (el as HTMLVideoElement).videoWidth || (el as HTMLImageElement).naturalWidth; const sh = (el as HTMLVideoElement).videoHeight || (el as HTMLImageElement).naturalHeight;
        if (!sw || !sh) continue;
        const sx = sw * c.crop.left, sy = sh * c.crop.top, scw = sw * (1 - c.crop.left - c.crop.right), sch = sh * (1 - c.crop.top - c.crop.bottom);
        const k = Math.min(W * c.scale / scw, H * c.scale / sch); const dw = scw * k, dh = sch * k;
        ctx.globalAlpha = fadeGain(c, t);
        try { ctx.drawImage(el, sx, sy, scw, sch, (W - dw) / 2 + c.x * W, (H - dh) / 2 + c.y * H, dw, dh); } catch { /* fotograma aún no disponible */ }
      }
    }
    for (const track of [...p.tracks].reverse()) {
      if (track.kind !== 'text' || track.hidden) continue;
      for (const c of track.clips) {
        const tx = c.text; if (!tx || !tx.content.trim() || t < c.start || t >= clipEnd(c)) continue;
        const px = Math.max(8, Math.round(tx.size * H / 1080)); const lh = px * 1.2;
        ctx.font = `${tx.bold ? 700 : 400} ${px}px "DejaVu Sans", Verdana, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const lines = tx.content.split('\n'); const tw = Math.max(...lines.map(l => ctx.measureText(l).width)); const th = lines.length * lh;
        const y = tx.position === 'top' ? H * 0.08 : tx.position === 'bottom' ? H * 0.9 - th : (H - th) / 2;
        const a = fadeGain(c, t);
        if (tx.background) { const pad = px * 0.3; ctx.globalAlpha = 0.65 * a; ctx.fillStyle = tx.background; ctx.fillRect(W / 2 - tw / 2 - pad, y - pad, tw + pad * 2, th + pad * 2); }
        ctx.globalAlpha = a;
        if (!tx.background) { ctx.lineWidth = Math.max(2, px / 12); ctx.strokeStyle = 'black'; lines.forEach((l, i) => ctx.strokeText(l, W / 2, y + i * lh)); }
        ctx.fillStyle = tx.color; lines.forEach((l, i) => ctx.fillText(l, W / 2, y + i * lh));
      }
    }
    ctx.globalAlpha = 1;
  }, []);

  /** Pone cada vídeo y audio en su segundo, con su velocidad y su volumen; lo que no toca, en pausa. */
  const sync = useCallback((t: number, play: boolean) => {
    for (const track of state.current.project.tracks) {
      if (track.kind === 'text') continue;
      for (const c of track.clips) {
        const el = media.current.get(c.id); if (!el || el instanceof HTMLImageElement) continue;
        const on = t >= c.start && t < clipEnd(c);
        if (!on) { if (!el.paused) el.pause(); continue; }
        const want = c.offset + (t - c.start) * c.speed;
        el.playbackRate = c.speed; el.muted = track.muted || c.volume === 0; el.volume = clamp(c.volume * fadeGain(c, t), 0, 1);
        if (play) { if (el.paused) { if (Math.abs(el.currentTime - want) > 0.08) el.currentTime = want; void el.play().catch(() => undefined); } else if (Math.abs(el.currentTime - want) > 0.4) el.currentTime = want; }
        else { if (!el.paused) el.pause(); if (Math.abs(el.currentTime - want) > 0.04) el.currentTime = want; }
      }
    }
  }, []);

  useEffect(() => { if (!playing) { sync(time, false); draw(time); } }, [time, playing, project, sync, draw]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0; let last = performance.now(); let t = state.current.time; let shown = 0;
    const step = (now: number) => {
      t += (now - last) / 1000; last = now;
      if (t >= total) { sync(total, false); draw(Math.max(0, total - 0.001)); onTime(total); onEnd(); return; }
      sync(t, true); draw(t);
      if (now - shown > 80) { shown = now; onTime(t); }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); for (const el of media.current.values()) if (!(el instanceof HTMLImageElement) && !el.paused) el.pause(); };
  }, [playing, total, sync, draw, onTime, onEnd]);

  const ready = () => { if (!state.current.playing) draw(state.current.time); };
  const reg = (id: string) => (el: HTMLVideoElement | HTMLAudioElement | HTMLImageElement | null) => { if (el) media.current.set(id, el); else media.current.delete(id); };
  return <div className="st-preview">
    <canvas ref={canvas} width={size.width} height={size.height} className={`st-canvas st-${project.format}`} role="img" aria-label={`Vista previa del vídeo en el segundo ${fmtTime(time)}`} />
    <div className="st-media" aria-hidden="true">
      {project.tracks.flatMap(t => t.kind === 'text' ? [] : t.clips.map(c => {
        const a = c.assetId ? assets.get(c.assetId) : undefined; if (!a) return null; const src = studioApi.assetUrl(slug, a.id);
        if (a.kind === 'image') return <img key={c.id} ref={reg(c.id)} src={src} alt="" onLoad={ready} />;
        if (t.kind === 'audio' || !a.hasVideo) return <audio key={c.id} ref={reg(c.id)} src={src} preload="auto" onLoadedData={ready} />;
        return <video key={c.id} ref={reg(c.id)} src={src} preload="auto" playsInline onLoadedData={ready} onSeeked={ready} />;
      }))}
    </div>
  </div>;
}

// ---------- Exportar ----------
function ExportDialog({ slug, project, renders, dirty, onClose, onRenders }: { slug: string; project: StudioProject; renders: StudioRender[]; dirty: boolean; onClose: () => void; onRenders: () => void }) {
  const [height, setHeight] = useState<StudioHeight>(720); const [quality, setQuality] = useState<StudioQuality>('standard');
  const [cur, setCur] = useState<StudioRender | null>(renders.find(r => r.status === 'queued' || r.status === 'running') ?? null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const running = cur?.status === 'queued' || cur?.status === 'running';
  useEffect(() => {
    if (!running || !cur) return;
    const t = setInterval(async () => { try { const r = await studioApi.renderState(slug, cur.id); setCur(r); if (r.status !== 'queued' && r.status !== 'running') onRenders(); } catch { /* se reintenta */ } }, 900);
    return () => clearInterval(t);
  }, [running, cur?.id, slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => { setBusy(true); setErr(null); try { setCur(await studioApi.render(slug, project.id, height, quality)); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const cancel = async () => { if (!cur) return; try { setCur(await studioApi.cancelRender(slug, cur.id)); onRenders(); } catch (e: any) { setErr(e.message); } };
  const size = studioCanvas(project.format, height);
  const done = renders.filter(r => r.status === 'done' && r.id !== cur?.id).slice(0, 5);
  return <Modal title="Exportar vídeo" wide onClose={onClose} footer={<>
    <button className="btn btn-ghost" onClick={onClose}>Cerrar</button>
    {running ? <button className="btn btn-danger" onClick={cancel}>Cancelar la exportación</button> : <button className="btn btn-primary" onClick={start} disabled={busy || dirty || studioDuration(project) <= 0}>{busy ? 'Preparando…' : cur ? 'Exportar otra vez' : 'Exportar MP4'}</button>}
  </>}>
    {err && <Notice kind="err">{err}</Notice>}
    {dirty && <Notice kind="info">Guardando los últimos cambios… en un momento podrás exportar.</Notice>}
    {!running && <div className="st-export-opts">
      <fieldset className="st-fs"><legend className="label">Resolución</legend>
        {STUDIO_HEIGHTS.map(h => { const s = studioCanvas(project.format, h); return <label key={h} className="st-radio"><input type="radio" name="st-h" checked={height === h} onChange={() => setHeight(h)} /> {h}p <span className="muted small">{s.width}×{s.height}</span></label>; })}
      </fieldset>
      <fieldset className="st-fs"><legend className="label">Calidad</legend>
        {(Object.keys(STUDIO_QUALITY) as StudioQuality[]).map(q => <label key={q} className="st-radio"><input type="radio" name="st-q" checked={quality === q} onChange={() => setQuality(q)} /> {STUDIO_QUALITY[q].label}</label>)}
      </fieldset>
      <p className="small muted" style={{ margin: 0 }}>Saldrá un archivo MP4 de {size.width}×{size.height} y {fmtTime(studioDuration(project))} de duración. Se procesa en esta máquina, sin coste y sin enviar nada fuera.</p>
    </div>}
    {cur && <section className="st-export-state" aria-live="polite">
      {running && <><div className="st-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(cur.progress * 100)} aria-label="Avance de la exportación"><span style={{ width: `${Math.round(cur.progress * 100)}%` }} /></div>
        <p className="small" style={{ margin: 0 }}>{cur.status === 'queued' ? 'En cola…' : `Exportando… ${Math.round(cur.progress * 100)} %`} Puedes cerrar esta ventana: sigue en segundo plano.</p></>}
      {cur.status === 'failed' && <Notice kind="err">No se pudo exportar. {cur.error}</Notice>}
      {cur.status === 'cancelled' && <Notice kind="info">Exportación cancelada. No quedó ningún archivo a medias.</Notice>}
      {cur.status === 'done' && cur.check && <>
        <Notice kind="ok"><strong>Vídeo exportado y comprobado.</strong> {cur.check.width}×{cur.check.height} · {fmtTime(cur.check.duration ?? 0)} · vídeo {cur.check.videoCodec?.toUpperCase()} y audio {cur.check.audioCodec?.toUpperCase()} · {fmtBytes(cur.check.bytes)}</Notice>
        <video className="st-result" controls preload="metadata" src={studioApi.renderUrl(slug, cur.id)} aria-label="Vídeo exportado" />
        <a className="btn btn-primary" href={studioApi.renderUrl(slug, cur.id, true)} download>{Icon.download()} Descargar el MP4</a>
      </>}
    </section>}
    {done.length > 0 && <section><h3 className="st-h3">Exportaciones anteriores</h3>
      <ul className="st-plain">{done.map(r => <li key={r.id} className="st-row"><span className="small">{new Date(r.finishedAt ?? r.createdAt).toLocaleString()} · {r.check?.width}×{r.check?.height} · {fmtBytes(r.check?.bytes ?? 0)}</span><a className="btn btn-ghost btn-sm" href={studioApi.renderUrl(slug, r.id, true)} download>{Icon.download()} Descargar</a></li>)}</ul>
    </section>}
  </Modal>;
}

function VersionsDialog({ slug, projectId, onClose, onRestored }: { slug: string; projectId: string; onClose: () => void; onRestored: (f: StudioFull) => void }) {
  const [list, setList] = useState<StudioVersion[] | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => { studioApi.versions(slug, projectId).then(setList).catch(e => setErr(e.message)); }, [slug, projectId]);
  const restore = async (rev: number) => { setBusy(rev); setErr(null); try { onRestored(await studioApi.restore(slug, projectId, rev)); onClose(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); } };
  return <Modal title="Historial de versiones" onClose={onClose} footer={<button className="btn btn-ghost" onClick={onClose}>Cerrar</button>}>
    <p className="small muted" style={{ margin: 0 }}>Cada guardado queda aquí. Volver a una versión crea una versión nueva: nunca se pierde lo posterior.</p>
    {err && <Notice kind="err">{err}</Notice>}
    {!list ? <Spinner /> : <ul className="st-plain st-versions">{list.map((v, i) => <li key={v.revision} className="st-row">
      <span><strong>Versión {v.revision}</strong>{v.label ? ` · ${v.label}` : ''}<br /><span className="small muted">{new Date(v.at).toLocaleString()}</span></span>
      {i === 0 ? <Chip tone="ok" xs>actual</Chip> : <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => restore(v.revision)}>{busy === v.revision ? 'Volviendo…' : 'Volver a esta'}</button>}
    </li>)}</ul>}
  </Modal>;
}

// ---------- Editor ----------
type Drag = { id: string; mode: 'move' | 'left' | 'right'; x0: number; orig: StudioClip; trackId: string; cur: StudioClip; curTrack: string };
type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

export function StudioEditor() {
  const { projectId = '' } = useParams(); const { status, flash } = useApp(); const slug = status.workspace!.slug;
  const [project, setProject] = useState<StudioProject | null>(null);
  const [assets, setAssets] = useState<StudioAsset[]>([]); const [renders, setRenders] = useState<StudioRender[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null); const [time, setTime] = useState(0); const [playing, setPlaying] = useState(false);
  const [pps, setPps] = useState(60); const [saveState, setSaveState] = useState<SaveState>('saved');
  const [dialog, setDialog] = useState<'export' | 'versions' | null>(null); const [drag, setDrag] = useState<Drag | null>(null);
  const [uploads, setUploads] = useState<{ name: string; fraction: number }[]>([]); const [dropping, setDropping] = useState(false);
  const [panel, setPanel] = useState<'library' | 'inspector'>('library');
  const hist = useRef<{ past: StudioProject[]; future: StudioProject[] }>({ past: [], future: [] });
  const rev = useRef(0); const latest = useRef<StudioProject | null>(null); latest.current = project; const saving = useRef(false);
  const [, bump] = useState(0);

  const adopt = (f: StudioFull) => { setProject(f.project); setAssets(f.assets); setRenders(f.renders); rev.current = f.project.revision; hist.current = { past: [], future: [] }; setSaveState('saved'); };
  useEffect(() => { studioApi.get(slug, projectId).then(adopt).catch(e => setLoadErr(e.message)); }, [slug, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const reloadSide = () => studioApi.get(slug, projectId).then(f => { setAssets(f.assets); setRenders(f.renders); }).catch(() => undefined);

  const commit = useCallback((fn: (p: StudioProject) => StudioProject) => {
    setProject(p => { if (!p) return p; const next = fn(p); if (next === p) return p; hist.current.past.push(p); if (hist.current.past.length > 100) hist.current.past.shift(); hist.current.future = []; return next; });
    setSaveState(s => (s === 'conflict' ? s : 'dirty'));
  }, []);
  const undo = () => { const h = hist.current; const p = latest.current; const prev = h.past.pop(); if (!prev || !p) return; h.future.push(p); setProject(prev); setSaveState('dirty'); bump(n => n + 1); };
  const redo = () => { const h = hist.current; const p = latest.current; const next = h.future.pop(); if (!next || !p) return; h.past.push(p); setProject(next); setSaveState('dirty'); bump(n => n + 1); };

  // Guardado automático: poco después del último cambio, y siempre sobre la última revisión que confirmó el servidor.
  const save = useCallback(async (label?: string) => {
    const p = latest.current; if (!p || saving.current) return;
    saving.current = true; setSaveState('saving');
    try {
      const res = await studioApi.save(slug, p.id, p, rev.current, label);
      rev.current = res.project.revision;
      if (res.fixes.length) { setProject(res.project); flash(`Se ajustó el proyecto al guardar: ${res.fixes.join(' ')}`, 'err'); setSaveState('saved'); }
      else setSaveState(latest.current === p ? 'saved' : 'dirty');
    } catch (e: any) {
      if (e instanceof ApiError && e.body?.code === 'stale_revision') setSaveState('conflict'); else { setSaveState('error'); setErr(e.message); }
    } finally { saving.current = false; }
  }, [slug, flash]);
  useEffect(() => { if (saveState !== 'dirty') return; const t = setTimeout(() => void save(), 1200); return () => clearTimeout(t); }, [saveState, project, save]);
  useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (saveState === 'dirty' || saveState === 'saving') e.preventDefault(); }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [saveState]);

  const assetMap = useMemo(() => new Map(assets.map(a => [a.id, a])), [assets]);
  const total = project ? studioDuration(project) : 0;
  const found = useMemo(() => { if (!project || !sel) return null; for (const t of project.tracks) { const c = t.clips.find(x => x.id === sel); if (c) return { track: t, clip: c }; } return null; }, [project, sel]);

  const mapTrack = (p: StudioProject, id: string, fn: (t: StudioTrack) => StudioTrack): StudioProject => ({ ...p, tracks: p.tracks.map(t => (t.id === id ? tidy(fn(t)) : t)) });
  const patchClip = (id: string, patch: Partial<StudioClip>) => commit(p => ({ ...p, tracks: p.tracks.map(t => (t.clips.some(c => c.id === id) ? tidy({ ...t, clips: t.clips.map(c => (c.id === id ? { ...c, ...patch } : c)) }) : t)) }));
  const removeClip = (id: string) => { commit(p => ({ ...p, tracks: p.tracks.map(t => ({ ...t, clips: t.clips.filter(c => c.id !== id) })) })); if (sel === id) setSel(null); };
  const maxDur = (c: StudioClip) => { const a = c.assetId ? assetMap.get(c.assetId) : undefined; return (c.kind === 'video' || c.kind === 'audio') && a?.duration ? (a.duration - c.offset) / c.speed : 3600; };

  const addAsset = (a: StudioAsset, at?: number, trackId?: string) => {
    const kind = trackKindFor(a); const id = uid();
    commit(p => {
      let tracks = p.tracks; let t = tracks.find(x => x.id === trackId && x.kind === kind) ?? tracks.find(x => x.kind === kind);
      if (!t) { t = { id: `t-${crypto.randomUUID().slice(0, 6)}`, kind, name: kind === 'audio' ? 'Audio' : 'Vídeo', muted: false, hidden: false, clips: [] }; tracks = [...tracks, t]; }
      const start = at ?? t.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
      const clip = newStudioClip(kind === 'audio' ? 'audio' : a.kind === 'image' ? 'image' : 'video', id, { assetId: a.id, start: r3(start), duration: r3(a.kind === 'image' ? 4 : a.duration ?? 4) });
      return mapTrack({ ...p, tracks }, t.id, x => ({ ...x, clips: [...x.clips, clip] }));
    });
    setSel(id); setPanel('inspector');
  };
  const addText = (subtitle: boolean) => {
    const id = uid();
    commit(p => {
      let tracks = p.tracks; let t = tracks.find(x => x.kind === 'text');
      if (!t) { t = { id: `t-${crypto.randomUUID().slice(0, 6)}`, kind: 'text', name: 'Texto', muted: false, hidden: false, clips: [] }; tracks = [t, ...tracks]; }
      const clip = newStudioClip('text', id, { start: r3(time), duration: 3, text: { ...STUDIO_TEXT_PRESETS[subtitle ? 'subtitle' : 'title'] } });
      return mapTrack({ ...p, tracks }, t.id, x => ({ ...x, clips: [...x.clips, clip] }));
    });
    setSel(id); setPanel('inspector');
  };
  const split = () => {
    if (!found) return; const parts = splitStudioClip(found.clip, time, uid());
    if (!parts) { flash('Coloca la cabeza de reproducción dentro del fragmento seleccionado para partirlo.', 'err'); return; }
    commit(p => mapTrack(p, found.track.id, t => ({ ...t, clips: t.clips.flatMap(c => (c.id === found.clip.id ? parts : [c])) })));
  };
  const addTrack = (kind: StudioTrackKind) => commit(p => { const t: StudioTrack = { id: `t-${crypto.randomUUID().slice(0, 6)}`, kind, name: `${kind === 'text' ? 'Texto' : kind === 'audio' ? 'Audio' : 'Vídeo'} ${p.tracks.filter(x => x.kind === kind).length + 1}`, muted: false, hidden: false, clips: [] }; return { ...p, tracks: kind === 'audio' ? [...p.tracks, t] : [t, ...p.tracks] }; });
  const patchTrack = (id: string, patch: Partial<StudioTrack>) => commit(p => ({ ...p, tracks: p.tracks.map(t => (t.id === id ? { ...t, ...patch } : t)) }));
  const moveToTrack = (clipId: string, toId: string) => commit(p => { let moved: StudioClip | undefined; const tracks = p.tracks.map(t => { const c = t.clips.find(x => x.id === clipId); if (c) moved = c; return c ? { ...t, clips: t.clips.filter(x => x.id !== clipId) } : t; }); return moved ? { ...p, tracks: tracks.map(t => (t.id === toId ? tidy({ ...t, clips: [...t.clips, moved!] }) : t)) } : p; });

  // Subidas
  const uploadFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUploads(u => [...u, { name: f.name, fraction: 0 }]);
      try { const a = await studioApi.upload(slug, projectId, f, fr => setUploads(u => u.map(x => (x.name === f.name ? { ...x, fraction: fr } : x)))); setAssets(l => (l.some(x => x.id === a.id) ? l : [...l, a])); }
      catch (e: any) { setErr(`«${f.name}»: ${e.message}`); }
      finally { setUploads(u => u.filter(x => x.name !== f.name)); }
    }
  };
  const removeAsset = async (a: StudioAsset) => { try { await studioApi.removeAsset(slug, a.id); setAssets(l => l.filter(x => x.id !== a.id)); } catch (e: any) { setErr(e.message); } };
  const importSrt = async (file: File) => { try { const { clips } = await studioApi.parseSrt(slug, await file.text()); commit(p => { let tracks = p.tracks; const t: StudioTrack = { id: `t-${crypto.randomUUID().slice(0, 6)}`, kind: 'text', name: 'Subtítulos', muted: false, hidden: false, clips }; tracks = [t, ...tracks]; return { ...p, tracks }; }); flash(`${clips.length} subtítulos añadidos en una pista nueva`); } catch (e: any) { setErr(e.message); } };

  // Arrastrar en la línea de tiempo (mover y recortar). Solo cambia el proyecto al soltar: un gesto = un paso de deshacer.
  const snap = (v: number, self: string) => {
    const pts = [0, time, ...(project?.tracks.flatMap(t => t.clips.filter(c => c.id !== self).flatMap(c => [c.start, clipEnd(c)])) ?? [])]; const tol = 8 / pps;
    let best = v; let d = tol; for (const p of pts) { const k = Math.abs(p - v); if (k < d) { d = k; best = p; } }
    return r3(d < tol ? best : Math.round(v * 20) / 20);
  };
  const startDrag = (e: RPointerEvent<HTMLElement>, c: StudioClip, trackId: string, mode: Drag['mode']) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setSel(c.id); setDrag({ id: c.id, mode, x0: e.clientX, orig: c, trackId, cur: c, curTrack: trackId }); };
  const onDragMove = (e: RPointerEvent<HTMLElement>) => {
    if (!drag) return; const d = (e.clientX - drag.x0) / pps; const o = drag.orig; let cur = o; let curTrack = drag.curTrack;
    if (drag.mode === 'move') {
      cur = { ...o, start: Math.max(0, snap(o.start + d, o.id)) };
      const lane = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-track]');
      const kind = project?.tracks.find(t => t.id === drag.trackId)?.kind;
      if (lane && project?.tracks.find(t => t.id === lane.dataset.track)?.kind === kind) curTrack = lane.dataset.track!;
    } else if (drag.mode === 'left') {
      const end = clipEnd(o); let start = clamp(snap(o.start + d, o.id), 0, end - 0.1);
      if (o.kind === 'video' || o.kind === 'audio') start = Math.max(start, o.start - o.offset / o.speed);
      cur = { ...o, start: r3(start), duration: r3(end - start), offset: o.kind === 'video' || o.kind === 'audio' ? r3(o.offset + (start - o.start) * o.speed) : 0 };
    } else cur = { ...o, duration: r3(clamp(snap(clipEnd(o) + d, o.id) - o.start, 0.1, maxDur(o))) };
    setDrag({ ...drag, cur, curTrack });
  };
  const endDrag = () => {
    if (!drag) return; const { cur, orig, trackId, curTrack, id } = drag; setDrag(null);
    if (cur.start === orig.start && cur.duration === orig.duration && curTrack === trackId) return;
    commit(p => { const tracks = p.tracks.map(t => (t.id === trackId ? { ...t, clips: t.clips.filter(c => c.id !== id) } : t)); return { ...p, tracks: tracks.map(t => (t.id === curTrack ? tidy({ ...t, clips: [...t.clips.filter(c => c.id !== id), cur] }) : t)) }; });
  };
  const onClipKey = (e: RKeyboardEvent, c: StudioClip) => {
    const stepBy = e.shiftKey ? 1 : 0.1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); patchClip(c.id, { start: r3(Math.max(0, c.start - stepBy)) }); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); patchClip(c.id, { start: r3(c.start + stepBy) }); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeClip(c.id); }
  };
  const onLaneDrop = (e: RDragEvent<HTMLDivElement>, t: StudioTrack) => {
    e.preventDefault(); const a = assetMap.get(e.dataTransfer.getData('text/x-studio-asset')); if (!a || trackKindFor(a) !== t.kind) return;
    const box = e.currentTarget.getBoundingClientRect(); addAsset(a, Math.max(0, r3((e.clientX - box.left) / pps)), t.id);
  };
  const seekFromRuler = (e: RPointerEvent<HTMLDivElement>) => { const box = e.currentTarget.getBoundingClientRect(); setPlaying(false); setTime(clamp(r3((e.clientX - box.left) / pps), 0, Math.max(total, 0))); };

  // Atajos: espacio reproduce, S parte, Ctrl+Z / Ctrl+Y deshacen y rehacen (nunca mientras se escribe en un campo).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null; if (dialog || (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.code === 'Space' && !(el && el.tagName === 'BUTTON')) { e.preventDefault(); setPlaying(p => !p); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey) split();
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });
  const onEnd = useCallback(() => setPlaying(false), []);
  const togglePlay = () => { if (!playing && time >= total - 0.01) setTime(0); setPlaying(p => !p); };

  if (loadErr) return <Shell crumb="Proyecto"><Notice kind="err">{loadErr}</Notice><p><Link className="btn btn-ghost" to="/estudio">Volver al Estudio</Link></p></Shell>;
  if (!project) return <Shell crumb="Proyecto"><Spinner /></Shell>;
  const width = Math.max(total + 8, 20) * pps; const tick = pps >= 50 ? 1 : pps >= 20 ? 5 : 10;
  const shownClip = (c: StudioClip, t: StudioTrack) => (drag && drag.id === c.id ? (drag.curTrack === t.id ? drag.cur : null) : c);
  const c = found?.clip; const sameKind = found ? project.tracks.filter(t => t.kind === found.track.kind) : [];
  const numField = (label: string, value: number, on: (n: number) => void, o: { min?: number; max?: number; step?: number; unit?: string } = {}) => <label className="st-field"><span>{label}{o.unit ? ` (${o.unit})` : ''}</span><input className="input" type="number" value={Number.isFinite(value) ? value : 0} min={o.min} max={o.max} step={o.step ?? 0.1} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) on(clamp(n, o.min ?? -1e9, o.max ?? 1e9)); }} /></label>;

  return <Shell crumb={project.name}>
    <div className="st-editor">
      <header className="st-head">
        <input className="input st-name" aria-label="Nombre del proyecto" value={project.name} maxLength={120} onChange={e => commit(p => ({ ...p, name: e.target.value }))} />
        <label className="st-format"><span className="sr-only">Formato</span><select className="input" value={project.format} onChange={e => commit(p => ({ ...p, format: e.target.value as StudioFormat }))}>{(Object.keys(STUDIO_FORMATS) as StudioFormat[]).map(f => <option key={f} value={f}>{STUDIO_FORMATS[f].label} {STUDIO_FORMATS[f].ratio}</option>)}</select></label>
        <span className={`st-save st-save-${saveState}`} role="status">{saveState === 'saved' ? 'Guardado' : saveState === 'saving' ? 'Guardando…' : saveState === 'dirty' ? 'Cambios sin guardar' : saveState === 'conflict' ? 'Abierto en otra pestaña' : 'No se pudo guardar'}</span>
        <div className="st-head-actions">
          <button className="btn btn-ghost btn-sm" onClick={undo} disabled={!hist.current.past.length} title="Deshacer (Ctrl+Z)">Deshacer</button>
          <button className="btn btn-ghost btn-sm" onClick={redo} disabled={!hist.current.future.length} title="Rehacer (Ctrl+Y)">Rehacer</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setDialog('versions')}>{Icon.history()} Versiones</button>
          <button className="btn btn-primary btn-sm" onClick={() => setDialog('export')} disabled={total <= 0}>{Icon.download()} Exportar</button>
        </div>
      </header>
      {err && <div className="st-alert"><Notice kind="err">{err} <button className="lnk" onClick={() => setErr(null)}>Entendido</button></Notice></div>}
      {saveState === 'conflict' && <Notice kind="warn">Este proyecto se guardó desde otra pestaña. Para no pisar esos cambios, aquí ya no se guarda. <button className="btn btn-secondary btn-sm" onClick={() => studioApi.get(slug, projectId).then(adopt)}>Cargar la versión actual</button></Notice>}
      {saveState === 'error' && <Notice kind="err">Los últimos cambios no se han guardado. <button className="btn btn-secondary btn-sm" onClick={() => void save()}>Reintentar</button></Notice>}

      <div className="st-top">
        <section className="st-stage" aria-label="Vista previa">
          <Preview slug={slug} project={project} assets={assetMap} time={time} playing={playing} onTime={setTime} onEnd={onEnd} />
          <div className="st-transport">
            <button className="btn btn-primary btn-sm" onClick={togglePlay} disabled={total <= 0} aria-pressed={playing}>{playing ? 'Pausa' : 'Reproducir'}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setPlaying(false); setTime(0); }} disabled={total <= 0}>Al inicio</button>
            <span className="st-time num" aria-live="off">{fmtTime(time)} / {fmtTime(total)}</span>
            <input className="st-seek" type="range" min={0} max={Math.max(total, 0.1)} step={0.05} value={Math.min(time, total)} onChange={e => { setPlaying(false); setTime(Number(e.target.value)); }} aria-label="Posición en el vídeo" disabled={total <= 0} />
          </div>
        </section>

        <aside className="st-side">
          <div className="st-tabs" role="tablist" aria-label="Paneles">
            <button role="tab" aria-selected={panel === 'library'} className={`st-tab${panel === 'library' ? ' is-on' : ''}`} onClick={() => setPanel('library')}>Biblioteca</button>
            <button role="tab" aria-selected={panel === 'inspector'} className={`st-tab${panel === 'inspector' ? ' is-on' : ''}`} onClick={() => setPanel('inspector')}>Ajustes del fragmento</button>
          </div>
          {panel === 'library' ? <div className="st-panel" role="tabpanel">
            <label className={`st-drop${dropping ? ' is-over' : ''}`} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }} onDragLeave={() => setDropping(false)} onDrop={e => { e.preventDefault(); setDropping(false); if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files); }}>
              <input type="file" className="sr-only" multiple accept="video/mp4,video/quicktime,video/webm,audio/*,image/png,image/jpeg,image/webp" onChange={e => { if (e.target.files?.length) void uploadFiles(e.target.files); e.target.value = ''; }} />
              {Icon.plus()} <span><strong>Añadir vídeos, audios o imágenes</strong><br /><span className="small muted">Arrástralos aquí o pulsa para elegirlos</span></span>
            </label>
            {uploads.map(u => <div key={u.name} className="st-upload" role="status"><span className="small">{u.fraction >= 1 ? 'Analizando' : 'Subiendo'} «{u.name}»…</span><div className="st-progress"><span style={{ width: `${Math.round(u.fraction * 100)}%` }} /></div></div>)}
            {assets.length === 0 && !uploads.length ? <p className="small muted">Aún no hay medios en este proyecto.</p> : <ul className="st-plain st-assets">{assets.map(a => <li key={a.id} className="st-asset" draggable onDragStart={e => { e.dataTransfer.setData('text/x-studio-asset', a.id); e.dataTransfer.effectAllowed = 'copy'; }}>
              <span className={`st-thumb st-thumb-${a.kind}`} aria-hidden="true">{a.kind === 'image' ? <img src={studioApi.assetUrl(slug, a.id)} alt="" loading="lazy" /> : a.kind === 'video' ? <video src={`${studioApi.assetUrl(slug, a.id)}#t=0.5`} preload="metadata" muted /> : '♪'}</span>
              <span className="st-asset-text"><span className="st-asset-name" title={a.name}>{a.name}</span><span className="small muted">{a.kind === 'video' ? 'Vídeo' : a.kind === 'audio' ? 'Audio' : 'Imagen'}{a.duration ? ` · ${fmtTime(a.duration)}` : ''} · {fmtBytes(a.bytes)}</span></span>
              <button className="btn btn-secondary btn-sm" onClick={() => addAsset(a)} aria-label={`Añadir «${a.name}» a la línea de tiempo`}>Añadir</button>
              <button className="xbtn" onClick={() => void removeAsset(a)} aria-label={`Quitar «${a.name}» de la biblioteca`}>{Icon.x(14)}</button>
            </li>)}</ul>}
          </div> : <div className="st-panel" role="tabpanel">
            {!c || !found ? <p className="small muted">Selecciona un fragmento en la línea de tiempo para ajustarlo.</p> : <div className="st-form">
              <p className="st-form-title"><strong>{c.kind === 'text' ? 'Texto' : assetMap.get(c.assetId ?? '')?.name ?? 'Fragmento'}</strong> <span className="small muted">en «{found.track.name}»</span></p>
              {c.text && <>
                <label className="st-field st-wide"><span>Texto</span><textarea className="input st-textarea" value={c.text.content} maxLength={500} onChange={e => patchClip(c.id, { text: { ...c.text!, content: e.target.value } })} /></label>
                {numField('Tamaño', c.text.size, n => patchClip(c.id, { text: { ...c.text!, size: n } }), { min: 12, max: 240, step: 2 })}
                <label className="st-field"><span>Posición</span><select className="input" value={c.text.position} onChange={e => patchClip(c.id, { text: { ...c.text!, position: e.target.value as any } })}><option value="top">Arriba</option><option value="center">Centro</option><option value="bottom">Abajo (subtítulo)</option></select></label>
                <label className="st-field"><span>Color</span><input className="st-color" type="color" value={c.text.color} onChange={e => patchClip(c.id, { text: { ...c.text!, color: e.target.value.toUpperCase() } })} /></label>
                <label className="st-check"><input type="checkbox" checked={!!c.text.background} onChange={e => patchClip(c.id, { text: { ...c.text!, background: e.target.checked ? STUDIO_TEXT_BG : null } })} /> Fondo oscuro</label>
                <label className="st-check"><input type="checkbox" checked={c.text.bold} onChange={e => patchClip(c.id, { text: { ...c.text!, bold: e.target.checked } })} /> Negrita</label>
              </>}
              {numField('Empieza en', c.start, n => patchClip(c.id, { start: r3(n) }), { min: 0, unit: 's' })}
              {numField('Duración', c.duration, n => patchClip(c.id, { duration: r3(Math.min(n, maxDur(c))) }), { min: 0.1, max: r3(maxDur(c)), unit: 's' })}
              {(c.kind === 'video' || c.kind === 'audio') && <>
                {numField('Empezar el original en', c.offset, n => patchClip(c.id, { offset: r3(n), duration: r3(Math.min(c.duration, ((assetMap.get(c.assetId ?? '')?.duration ?? 3600) - n) / c.speed)) }), { min: 0, max: Math.max(0, (assetMap.get(c.assetId ?? '')?.duration ?? 3600) - 0.1), unit: 's' })}
                <label className="st-field"><span>Velocidad</span><select className="input" value={c.speed} onChange={e => { const s = Number(e.target.value); patchClip(c.id, { speed: s, duration: r3(Math.max(0.1, c.duration * c.speed / s)) }); }}>{[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].map(s => <option key={s} value={s}>×{s}</option>)}</select></label>
                <label className="st-field st-wide"><span>Volumen: {Math.round(c.volume * 100)} %</span><input type="range" min={0} max={2} step={0.05} value={c.volume} onChange={e => patchClip(c.id, { volume: Number(e.target.value) })} /></label>
              </>}
              {numField('Aparece en', c.fadeIn, n => patchClip(c.id, { fadeIn: n }), { min: 0, max: r3(c.duration / 2), unit: 's' })}
              {numField('Desaparece en', c.fadeOut, n => patchClip(c.id, { fadeOut: n }), { min: 0, max: r3(c.duration / 2), unit: 's' })}
              {(c.kind === 'video' || c.kind === 'image') && <>
                <label className="st-field st-wide"><span>Tamaño: {Math.round(c.scale * 100)} %</span><input type="range" min={0.1} max={2} step={0.05} value={c.scale} onChange={e => patchClip(c.id, { scale: Number(e.target.value) })} /></label>
                {numField('Mover a la derecha', Math.round(c.x * 100), n => patchClip(c.id, { x: n / 100 }), { min: -100, max: 100, step: 1, unit: '%' })}
                {numField('Mover hacia abajo', Math.round(c.y * 100), n => patchClip(c.id, { y: n / 100 }), { min: -100, max: 100, step: 1, unit: '%' })}
                <fieldset className="st-fs st-wide"><legend className="label">Recortar la imagen (%)</legend><div className="st-crop">
                  {(['left', 'right', 'top', 'bottom'] as const).map(k => <label key={k} className="st-field"><span>{k === 'left' ? 'Izquierda' : k === 'right' ? 'Derecha' : k === 'top' ? 'Arriba' : 'Abajo'}</span><input className="input" type="number" min={0} max={45} step={1} value={Math.round(c.crop[k] * 100)} onChange={e => patchClip(c.id, { crop: { ...c.crop, [k]: clamp(Number(e.target.value) || 0, 0, 45) / 100 } })} /></label>)}
                </div></fieldset>
              </>}
              {sameKind.length > 1 && <label className="st-field st-wide"><span>Pista</span><select className="input" value={found.track.id} onChange={e => moveToTrack(c.id, e.target.value)}>{sameKind.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
              <div className="st-form-actions st-wide"><button className="btn btn-ghost btn-sm" onClick={split}>Partir aquí (S)</button><button className="btn btn-danger btn-sm" onClick={() => removeClip(c.id)}>Quitar fragmento</button></div>
            </div>}
          </div>}
        </aside>
      </div>

      <section className="st-timeline" aria-label="Línea de tiempo">
        <div className="st-tools">
          <button className="btn btn-ghost btn-sm" onClick={() => addText(false)}>{Icon.plus()} Título</button>
          <button className="btn btn-ghost btn-sm" onClick={() => addText(true)}>{Icon.plus()} Subtítulo</button>
          <label className="btn btn-ghost btn-sm st-filebtn">Importar .srt<input type="file" className="sr-only" accept=".srt,text/plain" onChange={e => { const f = e.target.files?.[0]; if (f) void importSrt(f); e.target.value = ''; }} /></label>
          <a className="btn btn-ghost btn-sm" href={studioApi.srtUrl(slug, project.id)} download>Descargar .srt</a>
          <button className="btn btn-ghost btn-sm" onClick={split} disabled={!found}>Partir (S)</button>
          <span className="st-tools-sep" />
          <label className="st-zoom"><span className="small">Zoom</span><input type="range" min={10} max={160} step={5} value={pps} onChange={e => setPps(Number(e.target.value))} aria-label="Zoom de la línea de tiempo" /></label>
          <label className="st-addtrack"><span className="sr-only">Añadir pista</span><select className="input" value="" onChange={e => { if (e.target.value) addTrack(e.target.value as StudioTrackKind); }}><option value="">+ Pista…</option><option value="video">Vídeo e imagen</option><option value="audio">Audio</option><option value="text">Texto</option></select></label>
        </div>
        <div className="st-scroll">
          <div className="st-grid" style={{ width: width + 148 }}>
            <div className="st-track st-rulerrow">
              <div className="st-rowhead st-corner">Pistas</div>
              <div className="st-ruler" style={{ width }} onPointerDown={seekFromRuler} role="presentation">
                {Array.from({ length: Math.floor(width / pps / tick) + 1 }, (_, i) => <span key={i} className="st-tick" style={{ left: i * tick * pps }}>{fmtTime(i * tick).replace('.0', '')}</span>)}
              </div>
            </div>
            {project.tracks.map(t => <div key={t.id} className="st-track">
              <div className="st-rowhead">
                <input className="st-trackname" aria-label={`Nombre de la pista (${KIND_LABEL[t.kind]})`} value={t.name} maxLength={60} onChange={e => patchTrack(t.id, { name: e.target.value })} />
                <div className="st-trackbtns">
                  {t.kind !== 'text' && <button className={`st-tg${t.muted ? ' is-on' : ''}`} aria-pressed={t.muted} onClick={() => patchTrack(t.id, { muted: !t.muted })} title="Silenciar la pista">{t.muted ? 'Silenciada' : 'Suena'}</button>}
                  {t.kind !== 'audio' && <button className={`st-tg${t.hidden ? ' is-on' : ''}`} aria-pressed={t.hidden} onClick={() => patchTrack(t.id, { hidden: !t.hidden })} title="Ocultar la pista">{t.hidden ? 'Oculta' : 'Visible'}</button>}
                  {t.clips.length === 0 && project.tracks.length > 1 && <button className="xbtn" onClick={() => commit(p => ({ ...p, tracks: p.tracks.filter(x => x.id !== t.id) }))} aria-label={`Quitar la pista «${t.name}»`}>{Icon.x(12)}</button>}
                </div>
              </div>
              <div className={`st-lane st-lane-${t.kind}`} data-track={t.id} style={{ width }} onPointerDown={() => setSel(null)} onDragOver={e => { if (e.dataTransfer.types.includes('text/x-studio-asset')) e.preventDefault(); }} onDrop={e => onLaneDrop(e, t)}>
                {[...t.clips, ...(drag && drag.curTrack === t.id && drag.trackId !== t.id ? [drag.orig] : [])].map(orig => { const k = shownClip(orig, t); if (!k) return null; const a = k.assetId ? assetMap.get(k.assetId) : undefined; const label = k.kind === 'text' ? k.text?.content.split('\n')[0] || 'Texto' : a?.name ?? 'Fragmento';
                  return <div key={k.id} className={`st-clip st-clip-${k.kind}${sel === k.id ? ' is-sel' : ''}${drag?.id === k.id ? ' is-drag' : ''}`} style={{ left: k.start * pps, width: Math.max(8, k.duration * pps) }}
                    role="button" tabIndex={0} aria-label={`${label}, empieza en ${fmtTime(k.start)}, dura ${fmtTime(k.duration)}. Flechas para mover, Supr para quitar.`} aria-pressed={sel === k.id}
                    onPointerDown={e => startDrag(e, k, t.id, 'move')} onPointerMove={onDragMove} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={e => onClipKey(e, k)} onFocus={() => setSel(k.id)} onDoubleClick={() => setPanel('inspector')}>
                    <span className="st-handle st-handle-l" onPointerDown={e => startDrag(e, k, t.id, 'left')} onPointerMove={onDragMove} onPointerUp={endDrag} aria-hidden="true" />
                    <span className="st-clip-label">{label}</span>
                    <span className="st-handle st-handle-r" onPointerDown={e => startDrag(e, k, t.id, 'right')} onPointerMove={onDragMove} onPointerUp={endDrag} aria-hidden="true" />
                  </div>; })}
              </div>
            </div>)}
            <div className="st-playhead" style={{ left: `calc(var(--st-head) + ${time * pps}px)` }} aria-hidden="true" />
          </div>
        </div>
        {total <= 0 && <p className="small muted st-hint">Añade un medio desde la biblioteca para empezar. Después podrás moverlo, recortarlo por los bordes y partirlo con «Partir».</p>}
      </section>
    </div>
    {dialog === 'export' && <ExportDialog slug={slug} project={project} renders={renders} dirty={saveState !== 'saved'} onClose={() => { setDialog(null); void reloadSide(); }} onRenders={() => void reloadSide()} />}
    {dialog === 'versions' && <VersionsDialog slug={slug} projectId={project.id} onClose={() => setDialog(null)} onRestored={adopt} />}
  </Shell>;
}

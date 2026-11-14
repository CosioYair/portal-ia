/**
 * Portal IA 4 · Estudio (edición de vídeo). Modelo del proyecto: lo comparten el editor del navegador (vista previa) y
 * el servidor (exportación con FFmpeg aislado). Todo son datos planos y versionados: el proyecto se guarda entero, con
 * historial, y la exportación se calcula a partir de él sin estado oculto.
 */
export const STUDIO_SCHEMA = 1;

export type StudioFormat = 'landscape' | 'portrait' | 'square';
export const STUDIO_FORMATS: Record<StudioFormat, { label: string; ratio: string; w: number; h: number }> = {
  landscape: { label: 'Horizontal', ratio: '16:9', w: 16, h: 9 },
  portrait: { label: 'Vertical', ratio: '9:16', w: 9, h: 16 },
  square: { label: 'Cuadrado', ratio: '1:1', w: 1, h: 1 }
};

export type StudioAssetKind = 'video' | 'audio' | 'image';
export interface StudioAsset {
  id: string; projectId: string; name: string; kind: StudioAssetKind; mime: string; bytes: number;
  /** Medido con ffprobe al importar (nunca se confía en lo que diga el nombre del archivo). */
  duration: number | null; width: number | null; height: number | null; hasAudio: boolean; hasVideo: boolean;
  createdAt: string;
}

export type StudioTrackKind = 'video' | 'audio' | 'text';
export type StudioClipKind = 'video' | 'image' | 'audio' | 'text';

export interface StudioCrop { left: number; top: number; right: number; bottom: number }
export interface StudioText {
  content: string; size: number; color: string; background: string | null;
  /** Posición vertical del texto: arriba, centro o abajo (los subtítulos van abajo). */
  position: 'top' | 'center' | 'bottom'; bold: boolean;
}
export interface StudioClip {
  id: string; kind: StudioClipKind; assetId: string | null;
  /** Segundos en la línea de tiempo. */
  start: number; duration: number;
  /** Segundo del original donde empieza el fragmento (recorte por delante). */
  offset: number;
  /** Velocidad de reproducción (0,25–4). La duración en la línea de tiempo ya la tiene en cuenta. */
  speed: number;
  /** 0–2 (1 = original). */
  volume: number;
  fadeIn: number; fadeOut: number;
  /** 1 = encaja en el lienzo. x/y: desplazamiento como fracción del lienzo (-1…1). */
  scale: number; x: number; y: number;
  crop: StudioCrop;
  text: StudioText | null;
}
export interface StudioTrack { id: string; kind: StudioTrackKind; name: string; muted: boolean; hidden: boolean; clips: StudioClip[] }

export interface StudioProject {
  schema: number; id: string; name: string; format: StudioFormat; fps: number;
  /** tracks[0] es la capa de arriba. */
  tracks: StudioTrack[];
  createdAt: string; updatedAt: string;
  /** Sube en cada guardado; el servidor rechaza un guardado hecho sobre una revisión vieja. */
  revision: number;
}

/** Estilos de partida de un título y de un subtítulo (colores del VÍDEO del usuario, no de la interfaz). */
export const STUDIO_TEXT_BG = '#000000';
export const STUDIO_TEXT_PRESETS: Record<'title' | 'subtitle', StudioText> = {
  title: { content: 'Título', size: 72, color: '#FFFFFF', background: null, position: 'center', bold: true },
  subtitle: { content: 'Subtítulo', size: 44, color: '#FFFFFF', background: STUDIO_TEXT_BG, position: 'bottom', bold: false }
};

export type StudioQuality = 'draft' | 'standard' | 'high';
export const STUDIO_QUALITY: Record<StudioQuality, { label: string; crf: number; preset: string; audioKbps: number }> = {
  draft: { label: 'Borrador (rápido)', crf: 30, preset: 'ultrafast', audioKbps: 96 },
  standard: { label: 'Estándar', crf: 23, preset: 'veryfast', audioKbps: 160 },
  high: { label: 'Alta', crf: 18, preset: 'medium', audioKbps: 192 }
};
export const STUDIO_HEIGHTS = [480, 720, 1080] as const;
export type StudioHeight = (typeof STUDIO_HEIGHTS)[number];

export type StudioRenderStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface StudioRenderCheck { ok: boolean; duration: number | null; width: number | null; height: number | null; hasVideo: boolean; hasAudio: boolean; videoCodec: string | null; audioCodec: string | null; bytes: number; problems: string[] }
export interface StudioRender {
  id: string; projectId: string; projectRevision: number; status: StudioRenderStatus; progress: number;
  height: StudioHeight; quality: StudioQuality; fileName: string; error: string | null;
  /** Comprobación del archivo exportado con ffprobe: no se da por bueno un MP4 que no se pudo leer. */
  check: StudioRenderCheck | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}

export interface StudioLimits { maxAssetBytes: number; maxProjectBytes: number; maxDurationSec: number; maxClips: number; maxTracks: number }
export const STUDIO_LIMITS: StudioLimits = { maxAssetBytes: 500 * 1024 * 1024, maxProjectBytes: 4 * 1024 * 1024 * 1024, maxDurationSec: 30 * 60, maxClips: 400, maxTracks: 12 };

const num = (v: unknown, d: number, min: number, max: number) => { const n = typeof v === 'number' && Number.isFinite(v) ? v : d; return Math.min(max, Math.max(min, n)); };
const str = (v: unknown, d: string, max: number) => (typeof v === 'string' ? v : d).slice(0, max);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const round = (n: number) => Math.round(n * 1000) / 1000;

export function studioCanvas(format: StudioFormat, height: number): { width: number; height: number } {
  const f = STUDIO_FORMATS[format] ?? STUDIO_FORMATS.landscape;
  // «height» es el lado corto para vertical (720p vertical = 720×1280), como en cualquier editor.
  const short = height; const even = (n: number) => Math.round(n / 2) * 2;
  if (format === 'portrait') return { width: even(short), height: even(short * f.h / f.w) };
  if (format === 'square') return { width: even(short), height: even(short) };
  return { width: even(short * f.w / f.h), height: even(short) };
}

export function newStudioClip(kind: StudioClipKind, id: string, patch: Partial<StudioClip> = {}): StudioClip {
  return {
    id, kind, assetId: null, start: 0, duration: 3, offset: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, scale: 1, x: 0, y: 0,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    text: kind === 'text' ? { content: 'Texto', size: 64, color: '#FFFFFF', background: null, position: 'center', bold: true } : null,
    ...patch
  };
}

export function newStudioProject(id: string, name: string, format: StudioFormat, at: string): StudioProject {
  return {
    schema: STUDIO_SCHEMA, id, name: name.trim().slice(0, 120) || 'Proyecto sin título', format, fps: 30, revision: 1, createdAt: at, updatedAt: at,
    tracks: [
      { id: 't-texto', kind: 'text', name: 'Texto', muted: false, hidden: false, clips: [] },
      { id: 't-video', kind: 'video', name: 'Vídeo', muted: false, hidden: false, clips: [] },
      { id: 't-audio', kind: 'audio', name: 'Audio', muted: false, hidden: false, clips: [] }
    ]
  };
}

/**
 * Deja un proyecto recibido del navegador en un estado válido y acotado (nunca se confía en la forma de la entrada):
 * identificadores seguros, números dentro de rango, clips del tipo de su pista y sin solapes dentro de una pista.
 * Devuelve también lo que tuvo que corregir, para que el editor lo diga.
 */
export function normalizeStudioProject(input: unknown, base: Pick<StudioProject, 'id' | 'createdAt'>, assets: Map<string, Pick<StudioAsset, 'kind' | 'duration'>>): { project: StudioProject; fixes: string[] } {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const fixes: string[] = [];
  const format: StudioFormat = src.format === 'portrait' || src.format === 'square' ? src.format : 'landscape';
  const seen = new Set<string>(); let clipCount = 0;
  const uid = (v: unknown, prefix: string) => { let id = typeof v === 'string' && ID.test(v) ? v : ''; let i = seen.size; while (!id || seen.has(id)) id = `${prefix}-${++i}`; seen.add(id); return id; };
  const tracks: StudioTrack[] = [];
  for (const t of Array.isArray(src.tracks) ? src.tracks.slice(0, STUDIO_LIMITS.maxTracks) : []) {
    if (!t || typeof t !== 'object') continue;
    const kind: StudioTrackKind = t.kind === 'audio' || t.kind === 'text' ? t.kind : 'video';
    const clips: StudioClip[] = [];
    for (const c of Array.isArray(t.clips) ? t.clips : []) {
      if (!c || typeof c !== 'object') continue;
      if (++clipCount > STUDIO_LIMITS.maxClips) { fixes.push(`Se admiten como mucho ${STUDIO_LIMITS.maxClips} fragmentos.`); break; }
      const asset = typeof c.assetId === 'string' ? assets.get(c.assetId) : undefined;
      let ck: StudioClipKind;
      if (kind === 'text') ck = 'text';
      else if (!asset) { fixes.push('Se quitó un fragmento cuyo archivo ya no está en la biblioteca.'); continue; }
      else if (kind === 'audio') { if (asset.kind === 'image') { fixes.push('Una imagen no puede ir en una pista de audio.'); continue; } ck = 'audio'; }
      else { if (asset.kind === 'audio') { fixes.push('Un audio no puede ir en una pista de vídeo.'); continue; } ck = asset.kind === 'image' ? 'image' : 'video'; }
      const speed = ck === 'video' || ck === 'audio' ? num(c.speed, 1, 0.25, 4) : 1;
      let offset = ck === 'video' || ck === 'audio' ? num(c.offset, 0, 0, 86_400) : 0;
      let duration = num(c.duration, 3, 0.1, STUDIO_LIMITS.maxDurationSec);
      const srcDur = asset?.duration ?? null;
      if ((ck === 'video' || ck === 'audio') && srcDur != null) {
        if (offset > srcDur - 0.05) offset = Math.max(0, srcDur - 0.05);
        const maxDur = (srcDur - offset) / speed;
        if (duration > maxDur + 0.001) { duration = Math.max(0.1, maxDur); }
      }
      const crop = c.crop && typeof c.crop === 'object' ? c.crop : {};
      const cl = num(crop.left, 0, 0, 0.9), cr = num(crop.right, 0, 0, 0.9), ct = num(crop.top, 0, 0, 0.9), cb = num(crop.bottom, 0, 0, 0.9);
      const tx = c.text && typeof c.text === 'object' ? c.text : {};
      clips.push({
        id: uid(c.id, 'c'), kind: ck, assetId: ck === 'text' ? null : c.assetId, start: round(num(c.start, 0, 0, STUDIO_LIMITS.maxDurationSec)), duration: round(duration), offset: round(offset), speed,
        volume: num(c.volume, 1, 0, 2), fadeIn: round(num(c.fadeIn, 0, 0, duration / 2)), fadeOut: round(num(c.fadeOut, 0, 0, duration / 2)),
        scale: num(c.scale, 1, 0.05, 4), x: num(c.x, 0, -1, 1), y: num(c.y, 0, -1, 1),
        crop: cl + cr >= 0.95 || ct + cb >= 0.95 ? { left: 0, top: 0, right: 0, bottom: 0 } : { left: cl, top: ct, right: cr, bottom: cb },
        text: ck === 'text' ? { content: str(tx.content, 'Texto', 500), size: num(tx.size, 64, 12, 240), color: COLOR.test(tx.color) ? tx.color : '#FFFFFF', background: COLOR.test(tx.background) ? tx.background : null, position: tx.position === 'top' || tx.position === 'bottom' ? tx.position : 'center', bold: tx.bold !== false } : null
      });
    }
    // Sin solapes dentro de una pista: el fragmento que pisa al anterior se empuja a su final.
    clips.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    for (let i = 1; i < clips.length; i++) { const end = round(clips[i - 1].start + clips[i - 1].duration); if (clips[i].start < end - 0.0005) clips[i].start = end; }
    tracks.push({ id: uid(t.id, 't'), kind, name: str(t.name, kind === 'text' ? 'Texto' : kind === 'audio' ? 'Audio' : 'Vídeo', 60) || 'Pista', muted: !!t.muted, hidden: !!t.hidden, clips });
  }
  const project: StudioProject = {
    schema: STUDIO_SCHEMA, id: base.id, name: str(src.name, 'Proyecto sin título', 120).trim() || 'Proyecto sin título', format, fps: [24, 25, 30, 60].includes(src.fps) ? src.fps : 30,
    tracks, createdAt: base.createdAt, updatedAt: str(src.updatedAt, base.createdAt, 40), revision: Math.max(1, Math.floor(num(src.revision, 1, 1, 1e9)))
  };
  if (studioDuration(project) > STUDIO_LIMITS.maxDurationSec) fixes.push(`El proyecto supera los ${STUDIO_LIMITS.maxDurationSec / 60} minutos admitidos.`);
  return { project, fixes: Array.from(new Set(fixes)) };
}

export function studioDuration(p: Pick<StudioProject, 'tracks'>): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  return round(end);
}

/** Parte un fragmento en el instante `at` de la línea de tiempo. Devuelve null si `at` no cae dentro. */
export function splitStudioClip(c: StudioClip, at: number, newId: string): [StudioClip, StudioClip] | null {
  if (at <= c.start + 0.05 || at >= c.start + c.duration - 0.05) return null;
  const first = round(at - c.start);
  const a: StudioClip = { ...c, crop: { ...c.crop }, text: c.text ? { ...c.text } : null, duration: first, fadeOut: 0, fadeIn: Math.min(c.fadeIn, first / 2) };
  const rest = round(c.duration - first);
  const b: StudioClip = { ...c, crop: { ...c.crop }, text: c.text ? { ...c.text } : null, id: newId, start: round(at), duration: rest, offset: round(c.offset + first * c.speed), fadeIn: 0, fadeOut: Math.min(c.fadeOut, rest / 2) };
  return [a, b];
}

const stamp = (s: number) => { const ms = Math.round(s * 1000); const p = (n: number, l = 2) => String(n).padStart(l, '0'); return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
/** Subtítulos del proyecto (los textos colocados «abajo») en formato SRT. */
export function studioSrt(p: Pick<StudioProject, 'tracks'>): string {
  const cues = p.tracks.filter(t => t.kind === 'text' && !t.hidden).flatMap(t => t.clips).filter(c => c.text?.position === 'bottom').sort((a, b) => a.start - b.start);
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.start + c.duration)}\n${c.text!.content.trim()}\n`).join('\n');
}
/** Lee un SRT y devuelve los subtítulos como fragmentos de texto (abajo). Ignora lo que no entiende. */
export function parseSrt(srt: string, mkId: () => string): StudioClip[] {
  const out: StudioClip[] = [];
  const t = (h: string, m: string, s: string, ms: string) => +h * 3600 + +m * 60 + +s + +ms.padEnd(3, '0').slice(0, 3) / 1000;
  for (const block of srt.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const i = lines.findIndex(l => l.includes('-->')); if (i < 0) continue;
    const m = lines[i].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/); if (!m) continue;
    const start = t(m[1], m[2], m[3], m[4]), end = t(m[5], m[6], m[7], m[8]);
    const content = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').slice(0, 500);
    if (!content || end <= start) continue;
    out.push(newStudioClip('text', mkId(), { start: round(start), duration: round(end - start), text: { content, size: 44, color: '#FFFFFF', background: '#000000', position: 'bottom', bold: false } }));
    if (out.length >= STUDIO_LIMITS.maxClips) break;
  }
  return out;
}

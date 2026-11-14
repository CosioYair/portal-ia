import type { StudioAsset, StudioClip, StudioHeight, StudioProject, StudioQuality } from '@portal-ia/domain';
import { STUDIO_QUALITY, studioCanvas, studioDuration } from '@portal-ia/domain';

/**
 * Portal IA 4 · Estudio: del proyecto a la orden de FFmpeg. Función pura (sin disco ni procesos): se puede probar entera
 * y lo que exporta es exactamente lo que describe el proyecto guardado.
 *
 * Seguridad: ningún texto del usuario entra en la línea de órdenes ni en el grafo de filtros. Los archivos se nombran
 * por posición (`/in/a0.mp4`), nunca con su nombre original, y los textos van en archivos aparte (`textfile=`).
 */
export interface RenderInput { file: string; args: string[] }
export interface RenderPlan {
  /** Entradas en orden: `-i` de FFmpeg. `file` es el nombre dentro de /in. */
  inputs: RenderInput[];
  /** Archivo de la biblioteca que corresponde a cada entrada (para montarlo con ese nombre). */
  sources: { file: string; assetId: string }[];
  /** Textos a escribir en /in antes de exportar. */
  textFiles: { file: string; content: string }[];
  filter: string;
  args: string[];
  width: number; height: number; fps: number; duration: number;
  hasAudio: boolean;
}

const FONT = '/usr/share/fonts/dejavu/DejaVuSans.ttf';
const FONT_BOLD = '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf';
const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
const EXT: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'weba', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const studioExt = (mime: string): string | null => EXT[mime] ?? null;

/** atempo solo admite 0,5–2 por eslabón: se encadenan los necesarios. */
function atempo(speed: number): string[] {
  const out: string[] = []; let s = speed;
  while (s > 2.0001) { out.push('atempo=2'); s /= 2; }
  while (s < 0.4999) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 0.0005) out.push(`atempo=${n(s)}`);
  return out;
}

export function buildRenderPlan(project: StudioProject, assets: Map<string, StudioAsset>, opts: { height: StudioHeight; quality: StudioQuality; outFile: string }): RenderPlan {
  const { width: W, height: H } = studioCanvas(project.format, opts.height);
  const fps = project.fps; const total = studioDuration(project);
  if (total <= 0) throw Object.assign(new Error('El proyecto está vacío: añade al menos un fragmento antes de exportar.'), { statusCode: 409, code: 'empty_project' });
  const q = STUDIO_QUALITY[opts.quality];
  const inputs: RenderInput[] = []; const sources: RenderPlan['sources'] = []; const textFiles: RenderPlan['textFiles'] = [];
  const chains: string[] = [];
  const addInput = (c: StudioClip, a: StudioAsset): number => {
    const ext = studioExt(a.mime); if (!ext) throw Object.assign(new Error(`Formato no admitido: ${a.mime}`), { statusCode: 409 });
    const file = `a${inputs.length}.${ext}`;
    inputs.push({ file, args: a.kind === 'image' ? ['-loop', '1', '-framerate', String(fps), '-t', n(c.duration), '-i', `/in/${file}`] : ['-i', `/in/${file}`] });
    sources.push({ file, assetId: a.id });
    return inputs.length - 1;
  };

  // Fondo: lienzo negro y silencio durante todo el proyecto (así siempre hay vídeo y audio válidos).
  chains.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${n(total)},format=yuv420p[bg0]`);
  let last = 'bg0'; let vi = 0; const audio: string[] = [];

  // De la capa de abajo a la de arriba: tracks[0] queda encima.
  for (const track of [...project.tracks].reverse()) {
    if (track.kind === 'text') continue;
    for (const c of track.clips) {
      const a = c.assetId ? assets.get(c.assetId) : undefined; if (!a) continue;
      const i = addInput(c, a);
      const end = c.start + c.duration;
      if (track.kind === 'video' && !track.hidden && a.hasVideo) {
        const f: string[] = [];
        if (c.kind === 'video') f.push(`trim=start=${n(c.offset)}:duration=${n(c.duration * c.speed)}`, `setpts=(PTS-STARTPTS)/${n(c.speed)}`);
        else f.push('setpts=PTS-STARTPTS');
        f.push(`fps=${fps}`);
        const cr = c.crop;
        if (cr.left || cr.right || cr.top || cr.bottom) f.push(`crop=iw*${n(1 - cr.left - cr.right)}:ih*${n(1 - cr.top - cr.bottom)}:iw*${n(cr.left)}:ih*${n(cr.top)}`);
        const bw = Math.max(2, Math.round(W * c.scale / 2) * 2), bh = Math.max(2, Math.round(H * c.scale / 2) * 2);
        f.push(`scale=${bw}:${bh}:force_original_aspect_ratio=decrease:force_divisible_by=2`, 'setsar=1', 'format=yuva420p');
        if (c.fadeIn > 0) f.push(`fade=t=in:st=0:d=${n(c.fadeIn)}:alpha=1`);
        if (c.fadeOut > 0) f.push(`fade=t=out:st=${n(c.duration - c.fadeOut)}:d=${n(c.fadeOut)}:alpha=1`);
        f.push(`trim=duration=${n(c.duration)}`, `setpts=PTS+${n(c.start)}/TB`);
        chains.push(`[${i}:v]${f.join(',')}[v${vi}]`);
        const out = `bg${vi + 1}`;
        chains.push(`[${last}][v${vi}]overlay=x=(W-w)/2+${n(c.x)}*W:y=(H-h)/2+${n(c.y)}*H:enable='between(t,${n(c.start)},${n(end)})':eof_action=pass[${out}]`);
        last = out; vi++;
      }
      if (!track.muted && a.hasAudio && c.kind !== 'image' && c.volume > 0) {
        const f = [`atrim=start=${n(c.offset)}:duration=${n(c.duration * c.speed)}`, 'asetpts=PTS-STARTPTS', ...atempo(c.speed), 'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
        if (Math.abs(c.volume - 1) > 0.001) f.push(`volume=${n(c.volume)}`);
        if (c.fadeIn > 0) f.push(`afade=t=in:st=0:d=${n(c.fadeIn)}`);
        if (c.fadeOut > 0) f.push(`afade=t=out:st=${n(c.duration - c.fadeOut)}:d=${n(c.fadeOut)}`);
        f.push(`atrim=duration=${n(c.duration)}`, `adelay=${Math.round(c.start * 1000)}:all=1`);
        chains.push(`[${i}:a]${f.join(',')}[a${audio.length}]`);
        audio.push(`a${audio.length}`);
      }
    }
  }

  // Textos: siempre encima de todo. El contenido va en un archivo; aquí solo números y colores ya validados.
  let ti = 0;
  for (const track of [...project.tracks].reverse()) {
    if (track.kind !== 'text' || track.hidden) continue;
    for (const c of track.clips) {
      const t = c.text; if (!t || !t.content.trim()) continue;
      const file = `t${ti}.txt`; textFiles.push({ file, content: t.content });
      const size = Math.max(8, Math.round(t.size * H / 1080));
      const y = t.position === 'top' ? `h*0.08` : t.position === 'bottom' ? `h*0.90-text_h` : `(h-text_h)/2`;
      const alpha = c.fadeIn > 0 || c.fadeOut > 0
        ? `:alpha='min(1,min(${c.fadeIn > 0 ? `(t-${n(c.start)})/${n(c.fadeIn)}` : '1'},${c.fadeOut > 0 ? `(${n(c.start + c.duration)}-t)/${n(c.fadeOut)}` : '1'}))'` : '';
      const box = t.background ? `:box=1:boxcolor=0x${t.background.slice(1)}@0.65:boxborderw=${Math.round(size * 0.3)}` : `:borderw=${Math.max(1, Math.round(size / 24))}:bordercolor=black@0.6`;
      const out = `tx${ti}`;
      chains.push(`[${last}]drawtext=fontfile=${t.bold ? FONT_BOLD : FONT}:textfile=/in/${file}:expansion=none:fontsize=${size}:fontcolor=0x${t.color.slice(1)}:x=(w-text_w)/2:y=${y}:line_spacing=${Math.round(size * 0.2)}${box}${alpha}:enable='between(t,${n(c.start)},${n(c.start + c.duration)})'[${out}]`);
      last = out; ti++;
    }
  }
  chains.push(`[${last}]format=yuv420p[vout]`);
  chains.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n(total)}[sil]`);
  chains.push(`[sil]${audio.map(a => `[${a}]`).join('')}amix=inputs=${audio.length + 1}:normalize=0:duration=first:dropout_transition=0,alimiter=limit=0.97[aout]`);

  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
    ...inputs.flatMap(x => x.args), '-filter_complex_script', '/in/graph.txt', '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf), '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', `${q.audioKbps}k`, '-ar', '48000', '-t', n(total), '-movflags', '+faststart', '-threads', '2', `/out/${opts.outFile}`];
  return { inputs, sources, textFiles, filter: chains.join(';\n'), args, width: W, height: H, fps, duration: total, hasAudio: audio.length > 0 };
}

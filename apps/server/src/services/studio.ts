import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { StudioAsset, StudioAssetKind, StudioHeight, StudioProject, StudioQuality, StudioRender, StudioRenderCheck } from '@portal-ia/domain';
import { STUDIO_LIMITS, normalizeStudioProject, newStudioProject, studioCanvas, studioDuration } from '@portal-ia/domain';
import { config } from '../config.ts';
import { studioRepo } from '../db/studio.ts';
import { dockerCliEnv, dockerMountArg } from './sandbox.ts';
import { buildRenderPlan, studioExt } from './studioPlan.ts';
import { changed } from './live.ts';

/**
 * Portal IA 4 · Estudio: biblioteca de medios y exportación.
 *
 * FFmpeg corre SIEMPRE en un contenedor aparte (imagen `portal-ia-media`): sin red, sin privilegios, sistema de archivos
 * de solo lectura, con tope de memoria, CPU, procesos y tiempo. El servidor del Portal solo lanza el proceso y lee su
 * progreso: exportar no lo bloquea. Un archivo subido es contenido NO fiable: se identifica con ffprobe dentro del
 * contenedor (nunca por su nombre) y jamás se interpreta en el proceso del servidor.
 */
export const MEDIA_IMAGE = process.env.PORTAL_MEDIA_IMAGE || 'portal-ia-media:1';
const BUILD_HINT = `docker build -t portal-ia-media:1 -f docker/media.Dockerfile docker`;
const err = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, code });
const ID = /^[A-Za-z0-9-]{1,64}$/;
const safeId = (id: string) => { if (!ID.test(id)) throw err(400, 'Identificador no válido.'); return id; };

export function studioDir(slug: string, projectId: string, sub: 'assets' | 'exports' | 'jobs'): string {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw err(400, 'Espacio no válido.');
  const d = path.join(config.dataDir, 'studio', slug, safeId(projectId), sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ---------- Motor de medios (Docker) ----------
export type MediaEngine = { state: 'ready' } | { state: 'no_docker' | 'missing_image'; detail: string; hint: string };
function run(cmd: string, args: string[], timeoutMs: number, onOut?: (chunk: string) => void, stallMs = 0): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; stalled: boolean }> {
  return new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false, stalled = false, done = false;
    const child = spawn(cmd, args, { env: dockerCliEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* ya terminó */ } }, timeoutMs);
    // Sin ninguna salida durante «stallMs»: el proceso está atascado (no se espera al tiempo máximo).
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const alive = () => { if (!stallMs) return; if (quiet) clearTimeout(quiet); quiet = setTimeout(() => { stalled = true; timedOut = true; try { child.kill(); } catch { /* ya terminó */ } }, stallMs); };
    alive();
    const end = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); if (quiet) clearTimeout(quiet); resolve({ code, stdout, stderr, timedOut, stalled }); };
    child.stdout.on('data', b => { const s = String(b); if (stdout.length < 2_000_000) stdout += s; alive(); onOut?.(s); });
    child.stderr.on('data', b => { if (stderr.length < 200_000) stderr += String(b); });
    child.on('error', e => { stderr += String(e.message); end(null); });
    child.on('close', code => end(code));
  });
}
let engineCache: { at: number; value: MediaEngine } | null = null;
export async function mediaEngine(fresh = false): Promise<MediaEngine> {
  if (!fresh && engineCache && Date.now() - engineCache.at < 30_000) return engineCache.value;
  let value: MediaEngine;
  const v = await run('docker', ['version', '--format', '{{.Server.Version}}'], 8000);
  if (v.code !== 0) value = { state: 'no_docker', detail: 'Docker no está en marcha: el Estudio lo usa para procesar vídeo de forma aislada.', hint: 'Abre Docker Desktop y vuelve a intentarlo.' };
  else {
    const i = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', MEDIA_IMAGE], 8000);
    value = i.code === 0 ? { state: 'ready' } : { state: 'missing_image', detail: `Falta la imagen de medios (${MEDIA_IMAGE}).`, hint: BUILD_HINT };
  }
  engineCache = { at: Date.now(), value };
  return value;
}
async function requireEngine(): Promise<void> {
  const e = await mediaEngine();
  if (e.state !== 'ready') throw err(503, `${e.detail} ${e.hint}`, `media_${e.state}`);
}
const baseArgs = (name: string, memory: string, cpus: string) => ['run', '--rm', '--init', '--pull', 'never', '--name', name, '--label', 'portal-ia.media=1',
  '--network', 'none', '--memory', memory, '--memory-swap', memory, '--cpus', cpus, '--pids-limit', '256', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--user', '1000:1000',
  '--read-only', '--mount', dockerMountArg({ type: 'tmpfs', target: '/tmp', 'tmpfs-mode': '1777', 'tmpfs-size': '268435456' })];
const bind = (source: string, target: string, readonly: boolean) => ['--mount', dockerMountArg({ type: 'bind', source, target, ...(readonly ? { readonly: true as const } : {}) })];

/** Enlace duro (o copia, si está en otro disco) del archivo dentro de una carpeta temporal de ruta corta. */
function shortLink(file: string): { dir: string; cleanup: () => void } {
  if (path.dirname(file).length < 80 && path.basename(file) === 'media') return { dir: path.dirname(file), cleanup: () => undefined };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pia-pr-')); const dst = path.join(dir, 'media');
  try { fs.linkSync(file, dst); } catch { fs.copyFileSync(file, dst); }
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temporal */ } } };
}

interface Probe { format: string; duration: number | null; streams: { type: string; codec: string; width: number | null; height: number | null; frames: number | null }[] }
/** ffprobe dentro del contenedor, con el archivo montado en solo lectura y sin su nombre original. */
export async function probeFile(file: string): Promise<Probe> {
  await requireEngine();
  const name = `pia-probe-${crypto.randomUUID().slice(0, 12)}`;
  // Ruta corta (ver runRender): se monta una carpeta temporal con un enlace al archivo, nunca la ruta original.
  const short = shortLink(file);
  let r: Awaited<ReturnType<typeof run>>;
  try {
    r = await run('docker', [...baseArgs(name, '512m', '1'), ...bind(short.dir, '/in', true), MEDIA_IMAGE,
      'ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '/in/media'], 45_000);
  } finally { short.cleanup(); }
  if (r.timedOut) { void run('docker', ['rm', '-f', name], 10_000); throw err(422, 'No se pudo analizar el archivo a tiempo: puede estar dañado.', 'probe_timeout'); }
  if (r.code !== 0) throw err(422, 'El archivo no es un vídeo, un audio ni una imagen que el Estudio pueda leer.', 'unreadable_media');
  let j: any; try { j = JSON.parse(r.stdout); } catch { throw err(422, 'El archivo no se pudo analizar.', 'unreadable_media'); }
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  return {
    format: String(j?.format?.format_name ?? ''), duration: num(j?.format?.duration),
    streams: (Array.isArray(j?.streams) ? j.streams : []).map((s: any) => ({ type: String(s.codec_type ?? ''), codec: String(s.codec_name ?? ''), width: num(s.width), height: num(s.height), frames: num(s.nb_frames) }))
  };
}

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'webp']);
const FORMAT_MIME: [RegExp, StudioAssetKind, string][] = [
  [/(^|,)mp4(,|$)|(^|,)mov(,|$)/, 'video', 'video/mp4'], [/matroska|webm/, 'video', 'video/webm'],
  [/(^|,)mp3(,|$)/, 'audio', 'audio/mpeg'], [/(^|,)wav(,|$)/, 'audio', 'audio/wav'], [/(^|,)ogg(,|$)/, 'audio', 'audio/ogg'], [/(^|,)aac(,|$)/, 'audio', 'audio/aac'],
  [/png_pipe/, 'image', 'image/png'], [/jpeg_pipe|image2/, 'image', 'image/jpeg'], [/webp_pipe/, 'image', 'image/webp']
];
/** Qué es el archivo según su CONTENIDO (lo que midió ffprobe). */
export function classifyProbe(p: Probe): { kind: StudioAssetKind; mime: string; duration: number | null; width: number | null; height: number | null; hasAudio: boolean; hasVideo: boolean } {
  const v = p.streams.find(s => s.type === 'video'); const a = p.streams.find(s => s.type === 'audio');
  const hit = FORMAT_MIME.find(([re]) => re.test(p.format));
  if (!hit) throw err(415, 'Formato no admitido. El Estudio acepta MP4, MOV, WebM, MP3, WAV, OGG, AAC/M4A, PNG, JPG y WebP.', 'unsupported_media');
  let [, kind, mime] = hit;
  const still = !!v && IMAGE_CODECS.has(v.codec) && (hit[1] === 'image' || (p.duration ?? 0) < 0.1);
  if (still) { kind = 'image'; mime = v!.codec === 'png' ? 'image/png' : v!.codec === 'webp' ? 'image/webp' : 'image/jpeg'; }
  else if (kind === 'video' && !v) { if (!a) throw err(415, 'El archivo no contiene vídeo ni audio.', 'unsupported_media'); kind = 'audio'; mime = /webm|matroska/.test(p.format) ? 'audio/webm' : 'audio/mp4'; }
  else if (kind === 'audio' && !a) throw err(415, 'El archivo no contiene audio.', 'unsupported_media');
  else if (kind === 'image' && !v) throw err(415, 'La imagen no se pudo leer.', 'unsupported_media');
  if ((kind === 'video' || kind === 'audio') && !p.duration) throw err(422, 'No se pudo medir la duración del archivo.', 'unreadable_media');
  if (v && ((v.width ?? 0) > 8192 || (v.height ?? 0) > 8192)) throw err(413, 'La imagen o el vídeo es demasiado grande (máximo 8192 px por lado).', 'too_large');
  return { kind, mime, duration: kind === 'image' ? null : p.duration, width: v?.width ?? null, height: v?.height ?? null, hasAudio: kind !== 'image' && !!a, hasVideo: kind !== 'audio' && !!v };
}

async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve()).on('error', reject));
  return h.digest('hex');
}

// ---------- Proyectos ----------
export function createStudioProject(slug: string, name: string, format: StudioProject['format']): StudioProject {
  const p = studioRepo(slug).insert(newStudioProject(crypto.randomUUID(), name, format, new Date().toISOString()));
  changed({ ws: slug, entity: 'studio', id: p.id });
  return p;
}
const assetMap = (slug: string, projectId: string) => new Map(studioRepo(slug).assets(projectId).map(a => [a.id, a]));

export function saveStudioProject(slug: string, id: string, input: unknown, baseRevision: number, label: string | null): { project: StudioProject; fixes: string[] } {
  const repo = studioRepo(slug); const cur = repo.get(safeId(id));
  if (!cur) throw err(404, 'Proyecto no encontrado.');
  const { project, fixes } = normalizeStudioProject(input, { id: cur.id, createdAt: cur.createdAt }, assetMap(slug, id));
  project.updatedAt = new Date().toISOString();
  const saved = repo.save(project, baseRevision, label ? label.trim().slice(0, 80) || null : null);
  if (!saved) throw Object.assign(err(409, 'Este proyecto se guardó desde otra pestaña después de que lo abrieras. No se ha perdido nada: recarga para ver la versión actual.', 'stale_revision'), { current: repo.get(id) });
  changed({ ws: slug, entity: 'studio', id });
  return { project: saved, fixes };
}

export function duplicateStudioProject(slug: string, id: string): StudioProject {
  const repo = studioRepo(slug); const src = repo.get(safeId(id));
  if (!src) throw err(404, 'Proyecto no encontrado.');
  const at = new Date().toISOString(); const copyId = crypto.randomUUID();
  // Los medios se comparten por contenido: enlaces duros (o copia si no se puede) con identificadores nuevos.
  const map = new Map<string, string>(); const from = studioDir(slug, id, 'assets'); const to = studioDir(slug, copyId, 'assets');
  const copies: { a: StudioAsset; file: string; sha: string }[] = [];
  for (const a of repo.assets(id)) {
    const row = repo.asset(a.id)!; const nid = crypto.randomUUID(); const file = `${nid}${path.extname(row.file)}`;
    try { fs.linkSync(path.join(from, row.file), path.join(to, file)); } catch { fs.copyFileSync(path.join(from, row.file), path.join(to, file)); }
    map.set(a.id, nid); copies.push({ a: { ...a, id: nid, projectId: copyId, createdAt: at }, file, sha: row.sha256 });
  }
  const copy: StudioProject = { ...src, id: copyId, name: `${src.name} (copia)`.slice(0, 120), revision: 1, createdAt: at, updatedAt: at,
    tracks: src.tracks.map(t => ({ ...t, clips: t.clips.map(c => ({ ...c, crop: { ...c.crop }, text: c.text ? { ...c.text } : null, assetId: c.assetId ? map.get(c.assetId) ?? null : null })) })) };
  repo.insert(copy);
  for (const c of copies) repo.addAsset(c.a, c.file, c.sha);
  changed({ ws: slug, entity: 'studio', id: copyId });
  return copy;
}

export function restoreStudioVersion(slug: string, id: string, revision: number): StudioProject {
  const repo = studioRepo(slug); const cur = repo.get(safeId(id)); const old = repo.version(id, revision);
  if (!cur || !old) throw err(404, 'Versión no encontrada.');
  // Restaurar es guardar la versión antigua como revisión NUEVA: el historial nunca se reescribe.
  return saveStudioProject(slug, id, old, cur.revision, `Restaurada la versión ${revision}`).project;
}

// ---------- Biblioteca ----------
export async function importStudioAsset(slug: string, projectId: string, tempFile: string, size: number, originalName: string): Promise<StudioAsset> {
  const repo = studioRepo(slug);
  if (!repo.get(safeId(projectId))) throw err(404, 'Proyecto no encontrado.');
  if (size <= 0) throw err(400, 'El archivo está vacío.');
  if (size > STUDIO_LIMITS.maxAssetBytes) throw err(413, `El archivo supera el máximo de ${Math.round(STUDIO_LIMITS.maxAssetBytes / 1048576)} MB.`, 'too_large');
  if (repo.assetBytes(projectId) + size > STUDIO_LIMITS.maxProjectBytes) throw err(413, 'La biblioteca de este proyecto está llena. Quita medios que no uses.', 'project_full');
  const sha = await sha256File(tempFile);
  const same = repo.assetBySha(projectId, sha); if (same) return same;
  const info = classifyProbe(await probeFile(tempFile));
  const id = crypto.randomUUID(); const ext = studioExt(info.mime)!; const file = `${id}.${ext}`;
  const dest = path.join(studioDir(slug, projectId, 'assets'), file);
  try { fs.renameSync(tempFile, dest); } catch { fs.copyFileSync(tempFile, dest); }
  // El nombre visible es solo una etiqueta: sin rutas ni caracteres de control. Nunca se usa como ruta.
  const name = path.basename(String(originalName || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().slice(0, 120) || `Medio.${ext}`;
  const asset = repo.addAsset({ id, projectId, name, bytes: size, createdAt: new Date().toISOString(), ...info }, file, sha);
  changed({ ws: slug, entity: 'studio', id: projectId });
  return asset;
}
export function studioAssetFile(slug: string, assetId: string): { file: string; asset: StudioAsset } {
  const row = studioRepo(slug).asset(safeId(assetId)); if (!row) throw err(404, 'Medio no encontrado.');
  const { file, sha256: _s, ...asset } = row;
  const full = path.join(studioDir(slug, row.projectId, 'assets'), path.basename(file));
  if (!fs.existsSync(full)) throw err(410, 'El archivo de este medio ya no está en el disco. Súbelo de nuevo.', 'gone');
  return { file: full, asset };
}
export function removeStudioAsset(slug: string, assetId: string): void {
  const repo = studioRepo(slug); const row = repo.asset(safeId(assetId)); if (!row) throw err(404, 'Medio no encontrado.');
  const p = repo.get(row.projectId);
  if (p?.tracks.some(t => t.clips.some(c => c.assetId === assetId))) throw err(409, 'Este medio se usa en la línea de tiempo. Quita primero sus fragmentos.', 'asset_in_use');
  if (repo.renders(row.projectId).some(r => r.status === 'queued' || r.status === 'running')) throw err(409, 'Hay una exportación en marcha en este proyecto: espera a que termine para quitar medios.', 'render_busy');
  repo.removeAsset(assetId);
  try { fs.rmSync(path.join(studioDir(slug, row.projectId, 'assets'), path.basename(row.file)), { force: true }); } catch { /* ya no está */ }
  changed({ ws: slug, entity: 'studio', id: row.projectId });
}

// ---------- Exportación ----------
const active = new Map<string, { container: string; cancelled: boolean }>();
let queue: Promise<void> = Promise.resolve();
const key = (slug: string, id: string) => `${slug}:${id}`;

export async function startStudioRender(slug: string, projectId: string, opts: { height: StudioHeight; quality: StudioQuality }): Promise<StudioRender> {
  const repo = studioRepo(slug); const project = repo.get(safeId(projectId));
  if (!project) throw err(404, 'Proyecto no encontrado.');
  await requireEngine();
  const total = studioDuration(project);
  if (total <= 0) throw err(409, 'El proyecto está vacío: añade al menos un fragmento antes de exportar.', 'empty_project');
  if (total > STUDIO_LIMITS.maxDurationSec) throw err(409, `El proyecto dura más de ${STUDIO_LIMITS.maxDurationSec / 60} minutos, el máximo que se exporta.`, 'too_long');
  if (repo.renders(projectId).some(r => r.status === 'queued' || r.status === 'running')) throw err(409, 'Ya hay una exportación en marcha para este proyecto.', 'render_busy');
  const id = crypto.randomUUID();
  // Se comprueba ya que el proyecto se puede exportar (medios presentes, formatos válidos): fallar ahora es más claro.
  buildRenderPlan(project, assetMap(slug, projectId), { ...opts, outFile: `${id}.mp4` });
  const render = repo.putRender({ id, projectId, projectRevision: project.revision, status: 'queued', progress: 0, height: opts.height, quality: opts.quality, fileName: `${id}.mp4`, error: null, check: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null });
  // Una exportación a la vez en toda la máquina: es el trabajo más pesado del Portal.
  queue = queue.then(() => runRender(slug, id, project).catch(() => undefined));
  changed({ ws: slug, entity: 'studio', id: projectId });
  return render;
}

async function runRender(slug: string, renderId: string, project: StudioProject): Promise<void> {
  const repo = studioRepo(slug); let r = repo.render(renderId);
  if (!r || r.status !== 'queued') return;
  const update = (patch: Partial<StudioRender>, kind: 'state' | 'progress' = 'state') => { r = repo.putRender({ ...r!, ...patch }); changed({ ws: slug, entity: 'studio', id: r.projectId, kind }); };
  // Carpeta de trabajo CORTA en el temporal del sistema: el motor de Docker en Windows falla (error de E/S) al montar
  // rutas muy largas. Se exporta y se comprueba ahí; solo el MP4 ya comprobado pasa a la carpeta del proyecto.
  let work = '';
  const container = `pia-render-${renderId.slice(0, 12)}`;
  const state = { container, cancelled: false }; active.set(key(slug, renderId), state);
  try {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'pia-st-')); const jobDir = path.join(work, 'in'); const tmpOut = path.join(work, 'out'); fs.mkdirSync(tmpOut);
    const outDir = studioDir(slug, project.id, 'exports');
    const assets = assetMap(slug, project.id);
    const plan = buildRenderPlan(project, assets, { height: r.height, quality: r.quality, outFile: r.fileName });
    fs.mkdirSync(jobDir, { recursive: true });
    const assetsDir = studioDir(slug, project.id, 'assets');
    for (const s of plan.sources) {
      const row = repo.asset(s.assetId); if (!row) throw new Error('Falta un medio del proyecto.');
      const src = path.join(assetsDir, path.basename(row.file)); const dst = path.join(jobDir, s.file);
      try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
    }
    for (const t of plan.textFiles) fs.writeFileSync(path.join(jobDir, t.file), t.content.replace(/\r/g, ''), 'utf8');
    fs.writeFileSync(path.join(jobDir, 'graph.txt'), plan.filter, 'utf8');
    if (state.cancelled) { update({ status: 'cancelled', finishedAt: new Date().toISOString() }); return; }
    update({ status: 'running', startedAt: new Date().toISOString() });
    let lastSaved = 0;
    const onOut = (chunk: string) => {
      const m = [...chunk.matchAll(/out_time_(?:us|ms)=(\d+)/g)].at(-1); if (!m) return;
      const pct = Math.min(0.99, Number(m[1]) / 1_000_000 / plan.duration);
      if (pct - lastSaved >= 0.02) { lastSaved = pct; update({ progress: Math.round(pct * 100) / 100 }, 'progress'); }
    };
    // Como mucho 8 veces la duración del vídeo (16 en calidad alta), nunca más de 2 horas; y si FFmpeg pasa 3 minutos
    // sin avanzar nada, está atascado. Dentro del contenedor hay además un tope propio, por si el Portal se cierra.
    const timeoutMs = Math.min(RENDER_MAX_MS, Math.max(180_000, Math.round(plan.duration * 8_000 * (r.quality === 'high' ? 2 : 1))));
    const res = await run('docker', [...baseArgs(container, '2g', '2'), ...bind(jobDir, '/in', true), ...bind(tmpOut, '/out', false), MEDIA_IMAGE, 'timeout', '-s', 'KILL', String(Math.ceil(timeoutMs / 1000) + 30), 'ffmpeg', ...plan.args], timeoutMs, onOut, 180_000);
    if (state.cancelled) { update({ status: 'cancelled', finishedAt: new Date().toISOString() }); return; }
    if (res.timedOut) { await run('docker', ['rm', '-f', container], 15_000); throw new Error(res.stalled ? 'La exportación dejó de avanzar y se detuvo. Suele deberse a un medio dañado: prueba a quitar el último que añadiste.' : 'La exportación superó el tiempo máximo y se detuvo. Prueba con calidad «Borrador» o un proyecto más corto.'); }
    if (res.code !== 0) throw new Error(res.code === 137 ? 'La exportación se quedó sin memoria (límite de 2 GB). Prueba con una resolución menor.' : `FFmpeg no pudo exportar el vídeo: ${res.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400) || `código ${res.code}`}`);
    const check = await verifyExport(path.join(tmpOut, r.fileName), plan);
    if (state.cancelled) { update({ status: 'cancelled', finishedAt: new Date().toISOString() }); return; }
    if (check.ok) { const dest = path.join(outDir, r.fileName); try { fs.renameSync(path.join(tmpOut, r.fileName), dest); } catch { fs.copyFileSync(path.join(tmpOut, r.fileName), dest); } }
    if (!check.ok) { update({ status: 'failed', check, error: `El archivo exportado no pasó la comprobación: ${check.problems.join(' ')}`, finishedAt: new Date().toISOString() }); return; }
    update({ status: 'done', progress: 1, check, finishedAt: new Date().toISOString() });
    pruneExports(slug, project.id);
  } catch (e: any) {
    update({ status: state.cancelled ? 'cancelled' : 'failed', error: state.cancelled ? null : String(e?.message ?? e).slice(0, 600), finishedAt: new Date().toISOString() });
  } finally {
    active.delete(key(slug, renderId));
    if (work) try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temporal */ }
  }
}

/** El MP4 exportado se vuelve a leer: debe tener vídeo H.264, audio AAC, el tamaño pedido y la duración del proyecto. */
export async function verifyExport(file: string, plan: { width: number; height: number; duration: number }): Promise<StudioRenderCheck> {
  const problems: string[] = []; let bytes = 0;
  try { bytes = fs.statSync(file).size; } catch { return { ok: false, duration: null, width: null, height: null, hasVideo: false, hasAudio: false, videoCodec: null, audioCodec: null, bytes: 0, problems: ['No se generó ningún archivo.'] }; }
  let p: Probe;
  try { p = await probeFile(file); } catch { return { ok: false, duration: null, width: null, height: null, hasVideo: false, hasAudio: false, videoCodec: null, audioCodec: null, bytes, problems: ['El archivo generado no se puede leer.'] }; }
  const v = p.streams.find(s => s.type === 'video'); const a = p.streams.find(s => s.type === 'audio');
  if (!v) problems.push('No tiene pista de vídeo.'); else { if (v.codec !== 'h264') problems.push(`El vídeo no es H.264 (${v.codec}).`); if (v.width !== plan.width || v.height !== plan.height) problems.push(`Mide ${v.width}×${v.height} y se pidió ${plan.width}×${plan.height}.`); }
  if (!a) problems.push('No tiene pista de audio.'); else if (a.codec !== 'aac') problems.push(`El audio no es AAC (${a.codec}).`);
  if (p.duration == null || Math.abs(p.duration - plan.duration) > Math.max(0.5, plan.duration * 0.02)) problems.push(`Dura ${p.duration?.toFixed(2) ?? '?'} s y el proyecto dura ${plan.duration.toFixed(2)} s.`);
  if (bytes < 1024) problems.push('El archivo está casi vacío.');
  return { ok: problems.length === 0, duration: p.duration, width: v?.width ?? null, height: v?.height ?? null, hasVideo: !!v, hasAudio: !!a, videoCodec: v?.codec ?? null, audioCodec: a?.codec ?? null, bytes, problems };
}

export async function cancelStudioRender(slug: string, renderId: string): Promise<StudioRender> {
  const repo = studioRepo(slug); const r = repo.render(safeId(renderId)); if (!r) throw err(404, 'Exportación no encontrada.');
  if (r.status !== 'queued' && r.status !== 'running') return r;
  const st = active.get(key(slug, renderId));
  if (st) { st.cancelled = true; await run('docker', ['rm', '-f', st.container], 15_000); }
  else repo.putRender({ ...r, status: 'cancelled', finishedAt: new Date().toISOString() });
  changed({ ws: slug, entity: 'studio', id: r.projectId });
  return repo.render(renderId)!;
}
export function studioRenderFile(slug: string, renderId: string): { file: string; render: StudioRender; name: string } {
  const repo = studioRepo(slug); const r = repo.render(safeId(renderId)); if (!r) throw err(404, 'Exportación no encontrada.');
  if (r.status !== 'done') throw err(409, 'Esta exportación no terminó bien: no hay archivo que descargar.', 'not_ready');
  const file = path.join(studioDir(slug, r.projectId, 'exports'), path.basename(r.fileName));
  if (!fs.existsSync(file)) throw err(410, 'El archivo exportado ya no está en el disco. Exporta de nuevo.', 'gone');
  const p = repo.get(r.projectId);
  const base = (p?.name ?? 'video').normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'video';
  return { file, render: r, name: `${base}-${studioCanvas(p?.format ?? 'landscape', r.height).height}p.mp4` };
}

const RENDER_MAX_MS = 2 * 60 * 60 * 1000;
/** Exportaciones terminadas que se conservan por proyecto (las anteriores se borran del disco; su registro queda). */
export const STUDIO_KEEP_EXPORTS = 10;
function pruneExports(slug: string, projectId: string): void {
  const dir = studioDir(slug, projectId, 'exports');
  const keep = new Set(studioRepo(slug).renders(projectId).filter(r => r.status === 'done').slice(0, STUDIO_KEEP_EXPORTS).map(r => r.fileName));
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.mp4') && !keep.has(f)) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* en uso */ } }
}

/** Papelera: proyectos quitados de la lista, con lo que ocupan sus archivos. */
function dirBytes(d: string): number { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size; } } catch { /* no existe */ } return n; }
export function studioTrash(slug: string): { projects: number; bytes: number } {
  const ids = studioRepo(slug).trashedIds();
  return { projects: ids.length, bytes: ids.reduce((n, id) => n + dirBytes(path.join(config.dataDir, 'studio', slug, id)), 0) };
}
/** Vaciar la papelera: borra del disco los proyectos quitados (medios, exportaciones e historial). No se puede deshacer. */
export function purgeStudioTrash(slug: string): { projects: number; bytes: number } {
  const before = studioTrash(slug); const repo = studioRepo(slug);
  for (const id of repo.trashedIds()) {
    if (!ID.test(id)) continue;
    try { fs.rmSync(path.join(config.dataDir, 'studio', slug, id), { recursive: true, force: true }); } catch { /* se intentará la próxima vez */ }
    repo.purge(id);
  }
  return before;
}

/**
 * Al arrancar el Portal: nada del Estudio puede estar trabajando de verdad. Se detienen los contenedores de medios que
 * dejó un cierre brusco, se retiran sus carpetas temporales y las exportaciones «en marcha» pasan a «no terminó».
 */
export async function recoverStudioAtStartup(slugs: string[]): Promise<{ renders: number; containers: number; temp: number }> {
  let renders = 0, containers = 0, temp = 0;
  for (const s of slugs) { try { renders += recoverStudioRenders(s); } catch { /* espacio sin Estudio */ } }
  const ps = await run('docker', ['ps', '-aq', '--filter', 'label=portal-ia.media=1'], 8000);
  const ids = ps.code === 0 ? ps.stdout.split(/\s+/).filter(Boolean) : [];
  if (ids.length) { await run('docker', ['rm', '-f', ...ids], 20_000); containers = ids.length; }
  try { for (const e of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) if (e.isDirectory() && /^pia-(st|pr)-/.test(e.name)) { try { fs.rmSync(path.join(os.tmpdir(), e.name), { recursive: true, force: true }); temp++; } catch { /* en uso */ } } } catch { /* sin acceso */ }
  return { renders, containers, temp };
}

/** Al arrancar: una exportación «en marcha» de antes del reinicio ya no tiene proceso; se dice y se puede repetir. */
export function recoverStudioRenders(slug: string): number {
  const repo = studioRepo(slug); let n = 0;
  for (const r of repo.unfinishedRenders()) { if (active.has(key(slug, r.id))) continue; repo.putRender({ ...r, status: 'failed', error: 'El Portal se reinició durante la exportación. No se perdió el proyecto: exporta de nuevo.', finishedAt: new Date().toISOString() }); n++; }
  return n;
}

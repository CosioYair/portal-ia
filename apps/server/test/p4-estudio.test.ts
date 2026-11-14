import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Portal IA 4 · Estudio. Dos partes:
 *  1) Sin Docker: el modelo del proyecto (normalizar, partir, subtítulos) y el plan de FFmpeg son funciones puras.
 *  2) Con Docker y la imagen de medios: el recorrido REAL de punta a punta por la API, con medios de verdad generados
 *     aquí mismo: crear proyecto, importar, montar, recortar, partir, texto, audio, guardar, reabrir, exportar un MP4 y
 *     volver a leerlo. Si el motor no está, esa parte se SALTA (se ve como «skipped», nunca como aprobada).
 */
// Carpeta de datos PROFUNDA a propósito: el motor de Docker en Windows da error de E/S al montar rutas muy largas, y así
// fallaba la exportación en una instalación con la carpeta de datos lejos de la raíz. Exportar no debe depender de eso.
process.env.PORTAL_DATA_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p4est-')), 'una-carpeta-de-datos-bastante-profunda', 'como-la-de-una-instalacion-real-lejos-de-la-raiz', 'datos');
fs.mkdirSync(process.env.PORTAL_DATA_DIR, { recursive: true });
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const { newStudioClip, newStudioProject, normalizeStudioProject, parseSrt, splitStudioClip, studioCanvas, studioDuration, studioSrt, INTERNAL_WORKSPACE, classifyModel } = await import('@portal-ia/domain');
const { buildRenderPlan } = await import('../src/services/studioPlan.ts');
const { classifyProbe, mediaEngine, MEDIA_IMAGE } = await import('../src/services/studio.ts');
const { studioProviders } = await import('../src/services/studioProviders.ts');

const asset = (id: string, kind: 'video' | 'audio' | 'image', o: any = {}): any => ({ id, projectId: 'p', name: id, kind, mime: kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/png', bytes: 1000, duration: kind === 'image' ? null : 6, width: kind === 'audio' ? null : 1280, height: kind === 'audio' ? null : 720, hasAudio: kind !== 'image', hasVideo: kind !== 'audio', createdAt: 'x', ...o });
const ASSETS = new Map<string, any>([['v1', asset('v1', 'video')], ['m1', asset('m1', 'audio', { duration: 8 })], ['i1', asset('i1', 'image')]]);
const base = { id: 'p', createdAt: '2026-11-14T00:00:00.000Z' };

test('el lienzo sale del formato: horizontal, vertical y cuadrado, siempre con lados pares', () => {
  assert.deepEqual(studioCanvas('landscape', 720), { width: 1280, height: 720 });
  assert.deepEqual(studioCanvas('portrait', 720), { width: 720, height: 1280 });
  assert.deepEqual(studioCanvas('square', 1080), { width: 1080, height: 1080 });
  assert.deepEqual(studioCanvas('landscape', 480), { width: 854, height: 480 });
});

test('un proyecto recibido se acota: tipos de pista, duración del original, solapes e identificadores', () => {
  const { project, fixes } = normalizeStudioProject({
    name: '  Mi vídeo  ', format: 'portrait', fps: 999, revision: 3,
    tracks: [
      { id: 'tv', kind: 'video', clips: [
        { id: 'a', assetId: 'v1', start: 0, duration: 99, offset: 2, speed: 2 },      // el original solo da (6-2)/2 = 2 s
        { id: 'b', assetId: 'v1', start: 1, duration: 2 },                            // pisa al anterior → se empuja
        { id: '../../etc', assetId: 'v1', start: 20, duration: 1 },                   // id peligroso → se sustituye
        { id: 'x', assetId: 'm1', start: 0, duration: 1 },                            // audio en pista de vídeo → fuera
        { id: 'y', assetId: 'no-existe', start: 0, duration: 1 }                      // medio ausente → fuera
      ] },
      { id: 'tt', kind: 'text', clips: [{ id: 't', start: 0, duration: 2, text: { content: 'Hola', color: 'red; rm -rf', size: 99999, position: 'bottom' } }] }
    ]
  }, base, ASSETS);
  assert.equal(project.name, 'Mi vídeo'); assert.equal(project.format, 'portrait'); assert.equal(project.fps, 30);
  const v = project.tracks[0].clips;
  assert.equal(v.length, 3);
  assert.equal(v[0].duration, 2, 'no dura más de lo que da el original a esa velocidad');
  assert.equal(v[1].start, 2, 'sin solapes dentro de una pista');
  assert.match(v[2].id, /^[A-Za-z0-9_-]+$/);
  const t = project.tracks[1].clips[0].text!;
  assert.equal(t.color, '#FFFFFF', 'un color que no es #hex no pasa'); assert.equal(t.size, 240); assert.equal(t.position, 'bottom');
  assert.ok(fixes.some(f => /audio no puede ir/.test(f))); assert.ok(fixes.some(f => /ya no está en la biblioteca/.test(f)));
});

test('partir un fragmento conserva el contenido: el segundo trozo empieza donde acaba el primero', () => {
  const c = newStudioClip('video', 'c1', { assetId: 'v1', start: 4, duration: 6, offset: 1, speed: 2, fadeIn: 0.5, fadeOut: 0.5 });
  const [a, b] = splitStudioClip(c, 6, 'c2')!;
  assert.equal(a.duration, 2); assert.equal(b.start, 6); assert.equal(b.duration, 4);
  assert.equal(b.offset, 1 + 2 * 2, 'con velocidad ×2, dos segundos de línea de tiempo son cuatro del original');
  assert.equal(a.fadeOut, 0); assert.equal(b.fadeIn, 0); assert.equal(a.fadeIn, 0.5); assert.equal(b.fadeOut, 0.5);
  assert.equal(splitStudioClip(c, 4, 'z'), null); assert.equal(splitStudioClip(c, 99, 'z'), null);
});

test('subtítulos: se exportan a SRT y un SRT se lee de vuelta', () => {
  const p = newStudioProject('p', 'x', 'landscape', 'now');
  p.tracks[0].clips.push(newStudioClip('text', 's1', { start: 1, duration: 2.5, text: { content: 'Hola mundo', size: 44, color: '#FFFFFF', background: '#000000', position: 'bottom', bold: false } }));
  p.tracks[0].clips.push(newStudioClip('text', 't1', { start: 0, duration: 1 })); // título centrado: no es subtítulo
  const srt = studioSrt(p);
  assert.equal(srt, '1\n00:00:01,000 --> 00:00:03,500\nHola mundo\n');
  let i = 0; const back = parseSrt(`${srt}\n2\n00:01:00,250 --> 00:01:02,000\n<i>Segunda</i>\nlínea\n\nbasura sin tiempos\n`, () => `n${++i}`);
  assert.equal(back.length, 2);
  assert.deepEqual([back[0].start, back[0].duration, back[0].text!.content], [1, 2.5, 'Hola mundo']);
  assert.deepEqual([back[1].start, back[1].duration, back[1].text!.content], [60.25, 1.75, 'Segunda\nlínea']);
});

function sample(): any {
  const p = newStudioProject('p', 'Demo', 'landscape', 'now');
  p.tracks[1].clips.push(newStudioClip('video', 'c1', { assetId: 'v1', start: 0, duration: 3, offset: 1, fadeIn: 0.5 }), newStudioClip('image', 'c2', { assetId: 'i1', start: 3, duration: 2, scale: 0.5, x: 0.2, crop: { left: 0.1, top: 0, right: 0.1, bottom: 0 } }));
  p.tracks[2].clips.push(newStudioClip('audio', 'c3', { assetId: 'm1', start: 0, duration: 5, volume: 0.4, fadeOut: 1, speed: 4 }));
  p.tracks[0].clips.push(newStudioClip('text', 'c4', { start: 0.5, duration: 2, text: { content: `Título'; rm -rf / :enable=0 [x] %{pts}`, size: 64, color: '#FFCC00', background: null, position: 'top', bold: true } }));
  return p;
}

test('el plan de FFmpeg describe el proyecto y no deja entrar texto del usuario en la orden', () => {
  const plan = buildRenderPlan(sample(), ASSETS, { height: 720, quality: 'standard', outFile: 'out.mp4' });
  assert.deepEqual([plan.width, plan.height, plan.fps, plan.duration], [1280, 720, 30, 5]);
  assert.deepEqual(plan.sources.map(s => s.file), ['a0.mp3', 'a1.mp4', 'a2.png'], 'los archivos se nombran por posición, nunca con su nombre original');
  assert.match(plan.filter, /trim=start=1:duration=3/); assert.match(plan.filter, /fade=t=in:st=0:d=0\.5:alpha=1/);
  assert.match(plan.filter, /crop=iw\*0\.8:ih\*1:iw\*0\.1:ih\*0/); assert.match(plan.filter, /scale=640:360/);
  assert.match(plan.filter, /atempo=2,atempo=2/, 'velocidad ×4 = dos eslabones de atempo'); assert.match(plan.filter, /volume=0\.4/);
  assert.match(plan.filter, /amix=inputs=3/, 'silencio de base + música + audio del vídeo');
  const all = plan.filter + ' ' + plan.args.join(' ');
  assert.doesNotMatch(all, /rm -rf|Título|%\{pts\}/, 'el texto solo viaja en su archivo');
  assert.deepEqual(plan.textFiles, [{ file: 't0.txt', content: `Título'; rm -rf / :enable=0 [x] %{pts}` }]);
  assert.match(plan.filter, /drawtext=[^;]*textfile=\/in\/t0\.txt[^;]*fontcolor=0xFFCC00/);
  assert.ok(plan.args.includes('-filter_complex_script')); assert.equal(plan.args.at(-1), '/out/out.mp4');
  assert.throws(() => buildRenderPlan(newStudioProject('p', 'x', 'square', 'now'), ASSETS, { height: 720, quality: 'draft', outFile: 'o.mp4' }), /vacío/);
});

test('una pista oculta no se ve y una silenciada no suena; el resto sigue', () => {
  const p = sample(); p.tracks[1].hidden = true; p.tracks[2].muted = true;
  const plan = buildRenderPlan(p, ASSETS, { height: 480, quality: 'draft', outFile: 'o.mp4' });
  assert.doesNotMatch(plan.filter, /overlay=/); assert.match(plan.filter, /amix=inputs=2/, 'solo queda el audio del vídeo');
});

test('lo que es un archivo lo dice su contenido, no su nombre', () => {
  const vid = classifyProbe({ format: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 6, streams: [{ type: 'video', codec: 'h264', width: 1280, height: 720, frames: 180 }, { type: 'audio', codec: 'aac', width: null, height: null, frames: null }] });
  assert.deepEqual([vid.kind, vid.mime, vid.hasAudio, vid.hasVideo], ['video', 'video/mp4', true, true]);
  const m4a = classifyProbe({ format: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 3, streams: [{ type: 'audio', codec: 'aac', width: null, height: null, frames: null }] });
  assert.deepEqual([m4a.kind, m4a.mime], ['audio', 'audio/mp4']);
  const png = classifyProbe({ format: 'png_pipe', duration: null, streams: [{ type: 'video', codec: 'png', width: 800, height: 600, frames: null }] });
  assert.deepEqual([png.kind, png.mime, png.duration, png.hasAudio], ['image', 'image/png', null, false]);
  assert.throws(() => classifyProbe({ format: 'avi', duration: 3, streams: [] }), /Formato no admitido/);
  assert.throws(() => classifyProbe({ format: 'png_pipe', duration: null, streams: [{ type: 'video', codec: 'png', width: 20000, height: 10, frames: null }] }), /demasiado grande/);
});

test('las capacidades de IA dicen su estado real: nada generativo figura como disponible sin conexión', () => {
  const list = studioProviders();
  assert.equal(list.find(p => p.id === 'local-ffmpeg')!.state, 'verified');
  for (const p of list.filter(p => p.capabilities.length)) assert.notEqual(p.state, 'verified', `${p.id} no está probado: no puede figurar como verificado`);
  assert.equal(list.find(p => p.id === 'higgsfield')!.state, 'unsupported');
});

// ---------- Recorrido real, con FFmpeg de verdad ----------
const engine = await mediaEngine(true);
const SKIP = engine.state === 'ready' ? false : `motor de medios no disponible (${engine.state}): el recorrido real no se ejecutó`;
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-p4media-'));
after(() => { try { fs.rmSync(MEDIA, { recursive: true, force: true }); } catch { /* temporal */ } });

test('recorrido real: crear, importar, montar, recortar, partir, texto, audio, guardar, reabrir, exportar y comprobar el MP4', { skip: SKIP, timeout: 600_000 }, async () => {
  // Medios de verdad, generados por el propio FFmpeg (vídeo con audio, vídeo mudo, música e imagen).
  execFileSync('docker', ['run', '--rm', '--network', 'none', '--user', '0', '-v', `${MEDIA}:/gen`, MEDIA_IMAGE, 'sh', '-c',
    'cd /gen && ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=s=1280x720:r=30:d=6 -f lavfi -i sine=frequency=440:duration=6 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest clipA.mp4'
    + ' && ffmpeg -hide_banner -loglevel error -y -f lavfi -i smptebars=s=640x480:r=25:d=5 -c:v libx264 -pix_fmt yuv420p clipB.mp4'
    + ' && ffmpeg -hide_banner -loglevel error -y -f lavfi -i sine=frequency=220:duration=8 music.mp3'
    + ' && ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=teal:s=800x600 -frames:v 1 logo.png && chmod a+r *'], { stdio: 'pipe', timeout: 180_000 });
  fs.writeFileSync(path.join(MEDIA, 'falso.mp4'), 'esto no es un vídeo, es texto con extensión de vídeo');

  const { encryptSecret } = await import('../src/security/crypto.ts');
  const { providersRepo } = await import('../src/db/platform.ts');
  const { runBootstrap } = await import('../src/routes/bootstrap.ts');
  const { buildApp } = await import('./fixtures/owner-app.ts');
  providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
  providersRepo.setConnected('anthropic', ['claude-opus-5-5'].map(id => classifyModel('anthropic', id)));
  runBootstrap();
  const app = await buildApp();
  try {
    const W = `/api/workspaces/${INTERNAL_WORKSPACE.slug}/studio`;
    const json = async (method: string, url: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url, payload: payload as any }); return { status: r.statusCode, body: r.headers['content-type']?.toString().includes('json') ? r.json() : r.body, raw: r }; };
    const upload = (pid: string, file: string, name = file) => app.inject({ method: 'PUT', url: `${W}/projects/${pid}/assets`, payload: fs.readFileSync(path.join(MEDIA, file)), headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) } });

    assert.equal((await json('GET', `${W}/status`)).body.engine.state, 'ready');
    // 1-2 · Abrir el Estudio y crear un proyecto
    const created = await json('POST', `${W}/projects`, { name: 'Recorrido de aceptación', format: 'landscape' });
    assert.equal(created.status, 201); const pid = created.body.project.id as string;

    // 3 · Importar medios reales (y uno falso, y uno con nombre malicioso)
    const a = (await upload(pid, 'clipA.mp4', '..\\..\\Windows\\clip <A>.mp4')); assert.equal(a.statusCode, 201, a.body);
    const A = a.json(); assert.deepEqual([A.kind, A.hasAudio, Math.round(A.duration), A.width, A.height], ['video', true, 6, 1280, 720]);
    assert.equal(A.name, 'clip A.mp4', 'el nombre es solo una etiqueta sin ruta ni caracteres raros');
    const B = (await upload(pid, 'clipB.mp4')).json(); assert.deepEqual([B.kind, B.hasAudio, B.width], ['video', false, 640]);
    const M = (await upload(pid, 'music.mp3')).json(); assert.deepEqual([M.kind, M.mime, Math.round(M.duration)], ['audio', 'audio/mpeg', 8]);
    const L = (await upload(pid, 'logo.png')).json(); assert.deepEqual([L.kind, L.duration, L.width], ['image', null, 800]);
    const fake = await upload(pid, 'falso.mp4'); assert.equal(fake.statusCode, 422, 'un texto con extensión .mp4 no entra en la biblioteca');
    assert.equal((await upload(pid, 'clipA.mp4')).json().id, A.id, 'el mismo archivo no se guarda dos veces');
    const ranged = await app.inject({ method: 'GET', url: `${W}/assets/${A.id}/file`, headers: { range: 'bytes=0-99' } });
    assert.equal(ranged.statusCode, 206); assert.equal(ranged.rawPayload.length, 100); assert.match(String(ranged.headers['content-range']), /^bytes 0-99\/\d+$/);

    // 4-7 · Montar: A recortado (2 s → 5 s del original), partido en dos; B después; logo encima; texto, subtítulo y música
    const p = created.body.project;
    const clipA = newStudioClip('video', 'cA', { assetId: A.id, start: 0, duration: 3, offset: 2, fadeIn: 0.4 });
    const [a1, a2] = splitStudioClip(clipA, 1.5, 'cA2')!;
    p.tracks[1].clips = [a1, a2, newStudioClip('video', 'cB', { assetId: B.id, start: 3, duration: 2.5, fadeOut: 0.5 })];
    p.tracks.splice(1, 0, { id: 't-logo', kind: 'video', name: 'Logo', muted: false, hidden: false, clips: [newStudioClip('image', 'cL', { assetId: L.id, start: 0.5, duration: 4, scale: 0.25, x: 0.35, y: -0.35 })] });
    p.tracks[0].clips = [
      newStudioClip('text', 'cT', { start: 0.2, duration: 2, fadeIn: 0.3, fadeOut: 0.3, text: { content: 'Portal IA 4 · Estudio', size: 72, color: '#FFFFFF', background: null, position: 'top', bold: true } }),
      newStudioClip('text', 'cS', { start: 3, duration: 2, text: { content: `Subtítulo con 'comillas': y dos puntos`, size: 44, color: '#FFFFFF', background: '#000000', position: 'bottom', bold: false } })
    ];
    p.tracks[3].clips = [newStudioClip('audio', 'cM', { assetId: M.id, start: 0, duration: 5.5, volume: 0.5, fadeOut: 1 })];
    const saved = await json('PUT', `${W}/projects/${pid}`, { project: p, baseRevision: 1 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.project.revision, 2); assert.deepEqual(saved.body.fixes, []);
    // Dos pestañas: guardar sobre una revisión vieja no pisa nada
    const stale = await json('PUT', `${W}/projects/${pid}`, { project: { ...p, name: 'pisado' }, baseRevision: 1 });
    assert.equal(stale.status, 409); assert.equal(stale.body.code, 'stale_revision');

    // 9 · Reabrir: el proyecto vuelve exactamente como se guardó
    const reopened = (await json('GET', `${W}/projects/${pid}`)).body;
    assert.equal(reopened.project.name, 'Recorrido de aceptación'); assert.equal(reopened.assets.length, 4);
    assert.deepEqual(reopened.project.tracks.map((t: any) => t.clips.map((c: any) => c.id)), [['cT', 'cS'], ['cL'], ['cA', 'cA2', 'cB'], ['cM']]);
    assert.equal(reopened.project.tracks[2].clips[1].offset, 3.5, 'el segundo trozo empieza donde cortó el primero');
    assert.equal(studioDuration(reopened.project), 5.5);
    const inUse = await json('DELETE', `${W}/assets/${A.id}`); assert.equal(inUse.status, 409, 'un medio en uso no se borra');
    const srt = await app.inject({ method: 'GET', url: `${W}/projects/${pid}/captions.srt` });
    assert.match(srt.body, /00:00:03,000 --> 00:00:05,000\nSubtítulo con 'comillas': y dos puntos/);

    // Historial: una versión con nombre, un cambio, y restaurar
    await json('PUT', `${W}/projects/${pid}`, { project: { ...reopened.project, name: 'Otro nombre' }, baseRevision: 2, label: 'Antes de exportar' });
    const versions = (await json('GET', `${W}/projects/${pid}/versions`)).body;
    assert.deepEqual(versions.map((v: any) => v.revision), [3, 2, 1]); assert.equal(versions[0].label, 'Antes de exportar');
    const restored = (await json('POST', `${W}/projects/${pid}/versions/2/restore`)).body;
    assert.equal(restored.project.name, 'Recorrido de aceptación'); assert.equal(restored.project.revision, 4, 'restaurar crea una revisión nueva; no reescribe el historial');

    // 10 · Exportar un MP4 de verdad (sin bloquear: la respuesta llega enseguida y el progreso se consulta)
    const started = await json('POST', `${W}/projects/${pid}/renders`, { height: 480, quality: 'draft' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal((await json('POST', `${W}/projects/${pid}/renders`, { height: 480, quality: 'draft' })).status, 409, 'una exportación a la vez por proyecto');
    let r = started.body; const t0 = Date.now();
    while ((r.status === 'queued' || r.status === 'running') && Date.now() - t0 < 300_000) { await new Promise(x => setTimeout(x, 700)); r = (await json('GET', `${W}/renders/${r.id}`)).body; }
    assert.equal(r.status, 'done', `la exportación terminó como ${r.status}: ${r.error}`);

    // 11 · El archivo: se vuelve a leer con ffprobe y se descarga
    assert.deepEqual([r.check.ok, r.check.videoCodec, r.check.audioCodec, r.check.width, r.check.height, r.check.hasVideo, r.check.hasAudio], [true, 'h264', 'aac', 854, 480, true, true]);
    assert.ok(Math.abs(r.check.duration - 5.5) < 0.3, `dura ${r.check.duration} s`); assert.ok(r.check.bytes > 20_000);
    const file = await app.inject({ method: 'GET', url: `${W}/renders/${r.id}/file?download=1` });
    assert.equal(file.statusCode, 200); assert.equal(file.headers['content-type'], 'video/mp4'); assert.match(String(file.headers['content-disposition']), /Recorrido-de-aceptacin-480p\.mp4|Recorrido-de-aceptacion-480p\.mp4/);
    assert.equal(file.rawPayload.length, r.check.bytes); assert.equal(file.rawPayload.subarray(4, 8).toString('latin1'), 'ftyp', 'es un MP4 de verdad');
    if (process.env.PORTAL_STUDIO_KEEP) fs.writeFileSync(process.env.PORTAL_STUDIO_KEEP, file.rawPayload);

    // Cancelar una exportación en marcha la detiene y no deja archivo a medias
    const second = (await json('POST', `${W}/projects/${pid}/renders`, { height: 1080, quality: 'high' })).body;
    const cancelled = (await json('POST', `${W}/renders/${second.id}/cancel`)).body;
    let c = cancelled; const t1 = Date.now();
    while ((c.status === 'queued' || c.status === 'running') && Date.now() - t1 < 60_000) { await new Promise(x => setTimeout(x, 500)); c = (await json('GET', `${W}/renders/${second.id}`)).body; }
    assert.equal(c.status, 'cancelled'); assert.equal((await json('GET', `${W}/renders/${second.id}/file`)).status, 409);

    // Duplicar y quitar (a la papelera)
    const dup = await json('POST', `${W}/projects/${pid}/duplicate`); assert.equal(dup.status, 201);
    assert.equal(dup.body.project.name, 'Recorrido de aceptación (copia)'); assert.equal(dup.body.assets.length, 4);
    assert.notEqual(dup.body.project.tracks[2].clips[0].assetId, A.id, 'la copia tiene sus propios medios');
    assert.equal((await json('DELETE', `${W}/projects/${dup.body.project.id}`, {})).status, 400, 'quitar exige confirmación');
    assert.equal((await json('DELETE', `${W}/projects/${dup.body.project.id}`, { confirm: true })).status, 200);
    assert.deepEqual((await json('GET', `${W}/projects`)).body.map((x: any) => x.id), [pid]);
  } finally { await app.close(); }
});

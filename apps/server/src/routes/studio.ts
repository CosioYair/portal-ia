import fs from 'node:fs';
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { STUDIO_FORMATS, STUDIO_HEIGHTS, STUDIO_LIMITS, STUDIO_QUALITY, parseSrt, studioDuration, studioSrt, type StudioProject } from '@portal-ia/domain';
import { workspacesRepo } from '../db/platform.ts';
import { studioRepo } from '../db/studio.ts';
import { cancelStudioRender, createStudioProject, duplicateStudioProject, importStudioAsset, mediaEngine, purgeStudioTrash, removeStudioAsset, restoreStudioVersion, saveStudioProject, startStudioRender, studioAssetFile, studioRenderFile, studioTrash } from '../services/studio.ts';
import { studioProviders } from '../services/studioProviders.ts';
import { acceptOctetStream, streamToTemp, uploadName } from './uploads.ts';

/**
 * Portal IA 4 · Estudio (vídeo). Todo cambio exige la sesión del propietario (regla global de app.ts). Las lecturas
 * de archivos admiten rangos (el reproductor del navegador los necesita para moverse por el vídeo).
 */
const fail = (reply: FastifyReply, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.current ? { current: e.current } : {}) });

function sendFile(req: FastifyRequest, reply: FastifyReply, file: string, mime: string, download?: string) {
  const size = fs.statSync(file).size;
  reply.header('accept-ranges', 'bytes').header('content-type', mime).header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff').header('cross-origin-resource-policy', 'same-origin');
  if (download) reply.header('content-disposition', `attachment; filename="${download.replace(/[^\w.\- ]/g, '_')}"`);
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
    end = Math.min(end, size - 1);
    return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(fs.createReadStream(file, { start, end }));
  }
  return reply.header('content-length', size).send(fs.createReadStream(file));
}

const summary = (p: StudioProject) => ({ id: p.id, name: p.name, format: p.format, revision: p.revision, duration: studioDuration(p), clips: p.tracks.reduce((n, t) => n + t.clips.length, 0), createdAt: p.createdAt, updatedAt: p.updatedAt });

export async function studioRoutes(app: FastifyInstance) {
  acceptOctetStream(app);
  const W = '/api/workspaces/:slug/studio';
  const ws = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const { slug } = req.params as any;
    if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return null; }
    return slug;
  };
  const full = (slug: string, id: string) => { const repo = studioRepo(slug); const project = repo.get(id); return project ? { project, assets: repo.assets(id), renders: repo.renders(id) } : null; };

  const statusOf = async (slug: string, fresh: boolean) => ({ engine: await mediaEngine(fresh), limits: STUDIO_LIMITS, formats: STUDIO_FORMATS, heights: STUDIO_HEIGHTS, quality: STUDIO_QUALITY, providers: studioProviders(), trash: studioTrash(slug) });
  app.get(`${W}/status`, async (req, reply) => { const slug = ws(req, reply); if (!slug) return; return statusOf(slug, false); });
  // Volver a comprobar el motor lanza procesos: es una acción (exige la sesión del propietario), no una lectura.
  app.post(`${W}/status/refresh`, async (req, reply) => { const slug = ws(req, reply); if (!slug) return; return statusOf(slug, true); });
  app.post(`${W}/trash/purge`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    if (!z.object({ confirm: z.literal(true) }).safeParse(req.body ?? {}).success) return reply.code(400).send({ error: 'Confirma que quieres borrar definitivamente los proyectos quitados.' });
    return { freed: purgeStudioTrash(slug), trash: studioTrash(slug) };
  });

  app.get(`${W}/projects`, async (req, reply) => { const slug = ws(req, reply); if (!slug) return; return studioRepo(slug).list().map(summary); });
  app.post(`${W}/projects`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    const b = z.object({ name: z.string().trim().min(1).max(120), format: z.enum(['landscape', 'portrait', 'square']).default('landscape') }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'Ponle un nombre al proyecto.' });
    return reply.code(201).send(full(slug, createStudioProject(slug, b.data.name, b.data.format).id));
  });
  app.get(`${W}/projects/:id`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    return full(slug, (req.params as any).id) ?? reply.code(404).send({ error: 'Proyecto no encontrado.' });
  });
  app.put(`${W}/projects/:id`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    const b = z.object({ project: z.record(z.string(), z.any()), baseRevision: z.number().int().min(1), label: z.string().max(80).nullish() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'Guardado no válido.' });
    try { return saveStudioProject(slug, (req.params as any).id, b.data.project, b.data.baseRevision, b.data.label ?? null); } catch (e) { return fail(reply, e); }
  });
  app.post(`${W}/projects/:id/duplicate`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    try { return reply.code(201).send(full(slug, duplicateStudioProject(slug, (req.params as any).id).id)); } catch (e) { return fail(reply, e); }
  });
  app.delete(`${W}/projects/:id`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    if (!z.object({ confirm: z.literal(true) }).safeParse(req.body ?? {}).success) return reply.code(400).send({ error: 'Confirma que quieres quitar el proyecto.' });
    const id = (req.params as any).id;
    if (studioRepo(slug).renders(id).some(r => r.status === 'queued' || r.status === 'running')) return reply.code(409).send({ error: 'Hay una exportación en marcha: cancélala antes.' });
    // Papelera: el proyecto deja de listarse; sus medios y exportaciones siguen en el disco.
    return studioRepo(slug).trash(id, new Date().toISOString()) ? { ok: true } : reply.code(404).send({ error: 'Proyecto no encontrado.' });
  });

  app.get(`${W}/projects/:id/versions`, async (req, reply) => { const slug = ws(req, reply); if (!slug) return; return studioRepo(slug).versions((req.params as any).id); });
  app.post(`${W}/projects/:id/versions/:revision/restore`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return; const { id, revision } = req.params as any;
    try { restoreStudioVersion(slug, id, Number(revision)); return full(slug, id); } catch (e) { return fail(reply, e); }
  });

  app.put(`${W}/projects/:id/assets`, { bodyLimit: STUDIO_LIMITS.maxAssetBytes }, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    let up: Awaited<ReturnType<typeof streamToTemp>> | null = null;
    try {
      up = await streamToTemp(req, STUDIO_LIMITS.maxAssetBytes);
      return reply.code(201).send(await importStudioAsset(slug, (req.params as any).id, up.file, up.size, uploadName(req)));
    } catch (e) { return fail(reply, e); } finally { up?.cleanup(); }
  });
  app.get(`${W}/assets/:assetId/file`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    try { const { file, asset } = studioAssetFile(slug, (req.params as any).assetId); return sendFile(req, reply, file, asset.mime); } catch (e) { return fail(reply, e); }
  });
  app.delete(`${W}/assets/:assetId`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    try { removeStudioAsset(slug, (req.params as any).assetId); return { ok: true }; } catch (e) { return fail(reply, e); }
  });

  app.get(`${W}/projects/:id/captions.srt`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return; const p = studioRepo(slug).get((req.params as any).id);
    if (!p) return reply.code(404).send({ error: 'Proyecto no encontrado.' });
    return reply.header('content-type', 'application/x-subrip; charset=utf-8').header('content-disposition', 'attachment; filename="subtitulos.srt"').send(studioSrt(p));
  });
  // Solo lee un SRT y devuelve los fragmentos: el editor decide dónde ponerlos y los guarda con el proyecto.
  app.post(`${W}/captions/parse`, async (req, reply) => {
    if (!ws(req, reply)) return;
    const b = z.object({ srt: z.string().min(1).max(500_000) }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'Pega o sube un archivo de subtítulos (.srt).' });
    const clips = parseSrt(b.data.srt, () => `c-${crypto.randomUUID().slice(0, 8)}`);
    if (!clips.length) return reply.code(422).send({ error: 'No se encontró ningún subtítulo con formato SRT.' });
    return { clips };
  });

  app.post(`${W}/projects/:id/renders`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    const b = z.object({ height: z.union([z.literal(480), z.literal(720), z.literal(1080)]).default(720), quality: z.enum(['draft', 'standard', 'high']).default('standard') }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'Elige resolución y calidad.' });
    try { return reply.code(202).send(await startStudioRender(slug, (req.params as any).id, b.data)); } catch (e) { return fail(reply, e); }
  });
  app.get(`${W}/renders/:renderId`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    return studioRepo(slug).render((req.params as any).renderId) ?? reply.code(404).send({ error: 'Exportación no encontrada.' });
  });
  app.post(`${W}/renders/:renderId/cancel`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    try { return await cancelStudioRender(slug, (req.params as any).renderId); } catch (e) { return fail(reply, e); }
  });
  app.get(`${W}/renders/:renderId/file`, async (req, reply) => {
    const slug = ws(req, reply); if (!slug) return;
    try { const { file, name } = studioRenderFile(slug, (req.params as any).renderId); return sendFile(req, reply, file, 'video/mp4', (req.query as any)?.download === '1' ? name : undefined); } catch (e) { return fail(reply, e); }
  });
}

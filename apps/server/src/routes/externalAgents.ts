import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { agentsRepo } from '../db/workspace.ts';
import { adoptSourceChange, externalPreview, importExternal, restoreSourceRevision, sourceStatus, updateGrants } from '../services/externalAgents.ts';
import { applyProposal, classifyFeedback, detectToolchain, documentJobsRunning, jobFile, listJobs, listProposals, receiveDocuments, rejectProposal, startProcessing, versionEvidence } from '../services/documentJobs.ts';

/**
 * Agentes externos (referencia gestionada) y su banco de trabajo de documentos. Ver docs/agentes-externos.md.
 * Modelo: Claude Code con la suscripción del propietario (plan, informe y clasificación del feedback); nunca la API.
 */
const err = (reply: FastifyReply, e: any) => reply.code(e.statusCode ?? 500).send({ error: e.message, ...(e.code ? { code: e.code } : {}) });
const GRANTS = z.object({ writeDocuments: z.boolean(), runScripts: z.boolean(), applyImprovements: z.boolean() });

export async function externalAgentsRoutes(app: FastifyInstance) {
  const guard = (slug: string, reply: FastifyReply) => { if (!workspacesRepo.get(slug)) { reply.code(404).send({ error: 'Espacio no encontrado' }); return false; } return true; };
  const agentOk = (slug: string, id: string, reply: FastifyReply) => { if (!agentsRepo(slug).get(id)) { reply.code(404).send({ error: 'Agente no encontrado' }); return false; } return true; };
  const W = '/api/workspaces/:slug';

  // ---------- Importar como referencia gestionada
  app.post(`${W}/agents/external/preview`, async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const b = z.object({ path: z.string().min(1).max(1024) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Elige la carpeta del agente.' });
    try { return externalPreview(slug, b.data.path); } catch (e) { return err(reply, e); }
  });
  app.post(`${W}/agents/external`, async (req, reply) => {
    const { slug } = req.params as any; if (!guard(slug, reply)) return;
    const b = z.object({
      path: z.string().min(1).max(1024), hash: z.string().length(64), name: z.string().trim().min(2).max(80), role: z.string().trim().min(2).max(80),
      summary: z.string().max(2000).default(''), department: z.string().trim().min(2).max(60),
      harness: z.enum(['claude-code', 'codex']), model: z.string().trim().min(1).max(120), effort: z.enum(['low', 'medium', 'high']).default('medium'),
      grants: GRANTS, authorized: z.literal(true)
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Datos de importación no válidos (nombre, papel, departamento, arnés y tu confirmación).', issues: b.error.issues });
    try { return reply.code(201).send(await importExternal(slug, b.data)); } catch (e) { return err(reply, e); }
  });

  // ---------- Origen: procedencia, integración, cambios externos, permisos, revisiones
  app.get(`${W}/agents/:id/source`, async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply) || !agentOk(slug, id, reply)) return;
    const s = sourceStatus(slug, id); if (!s) return reply.code(404).send({ error: 'Este agente no tiene carpeta externa.' });
    return { ...s, toolchain: await detectToolchain() };
  });
  app.post(`${W}/agents/:id/source/adopt`, async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply) || !agentOk(slug, id, reply)) return;
    const b = z.object({ hash: z.string().length(64) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Falta la huella de la versión revisada.' });
    try { return adoptSourceChange(slug, id, b.data.hash); } catch (e) { return err(reply, e); }
  });
  app.put(`${W}/agents/:id/source/grants`, async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply) || !agentOk(slug, id, reply)) return;
    const b = z.object({ grants: GRANTS, authorized: z.literal(true) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Permisos no válidos o sin tu confirmación.' });
    try { return updateGrants(slug, id, b.data.grants); } catch (e) { return err(reply, e); }
  });
  app.post(`${W}/agents/:id/source/restore`, async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply) || !agentOk(slug, id, reply)) return;
    const b = z.object({ n: z.number().int().min(1), authorized: z.literal(true) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Indica la revisión y confírmalo.' });
    try { return restoreSourceRevision(slug, id, b.data.n); } catch (e) { return err(reply, e); }
  });

  // ---------- Documentos
  app.get(`${W}/agents/:id/documents`, async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply) || !agentOk(slug, id, reply)) return;
    try { return { jobs: listJobs(slug, id), running: documentJobsRunning(), proposals: listProposals(slug, id) }; } catch (e) { return err(reply, e); }
  });
  app.post(`${W}/agents/:id/documents`, { bodyLimit: 90 * 1024 * 1024 }, async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply) || !agentOk(slug, id, reply)) return;
    const b = z.object({ name: z.string().min(1).max(200), contentBase64: z.string().min(8) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Adjunta un PDF o un ZIP.' });
    try { return reply.code(201).send(receiveDocuments(slug, id, b.data)); } catch (e) { return err(reply, e); }
  });
  app.post(`${W}/agents/:id/documents/:jobId/process`, async (req, reply) => {
    const { slug, id, jobId } = req.params as any; if (!guard(slug, reply) || !agentOk(slug, id, reply)) return;
    const b = z.object({ authorized: z.literal(true), feedback: z.string().trim().max(4000).nullable().optional() }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Confirma que el agente ejecute sus scripts y use tu suscripción.' });
    try { return reply.code(202).send(await startProcessing(slug, id, jobId, { authorized: true, feedback: b.data.feedback ?? null })); } catch (e) { return err(reply, e); }
  });
  app.get(`${W}/agents/:id/documents/:jobId/file`, async (req, reply) => {
    const { slug, id, jobId } = req.params as any; if (!guard(slug, reply) || !agentOk(slug, id, reply)) return;
    const q = z.object({ path: z.string().min(1).max(300), download: z.string().optional() }).safeParse(req.query); if (!q.success) return reply.code(400).send({ error: 'Falta el archivo.' });
    try {
      const f = jobFile(slug, id, jobId, q.data.path);
      reply.header('Content-Type', f.type).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
      if (q.data.download || !/^image\//.test(f.type)) reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      return reply.send(fs.createReadStream(f.abs));
    } catch (e) { return err(reply, e); }
  });
  app.get(`${W}/agents/:id/documents/:jobId/versions/:n/evidence`, async (req, reply) => {
    const { slug, id, jobId, n } = req.params as any; if (!guard(slug, reply) || !agentOk(slug, id, reply)) return;
    try { return { images: versionEvidence(slug, id, jobId, Number(n)) }; } catch (e) { return err(reply, e); }
  });

  // ---------- Feedback y mejoras
  app.post(`${W}/agents/:id/feedback`, async (req, reply) => {
    const { slug, id } = req.params as any; if (!guard(slug, reply) || !agentOk(slug, id, reply)) return;
    const b = z.object({ jobId: z.string().nullable(), text: z.string().trim().min(5).max(4000) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Escribe tu feedback (≥5 caracteres).' });
    try { return reply.code(201).send(await classifyFeedback(slug, id, b.data)); } catch (e) { return err(reply, e); }
  });
  app.post(`${W}/agents/:id/proposals/:pid/apply`, async (req, reply) => {
    const { slug, id, pid } = req.params as any; if (!guard(slug, reply) || !agentOk(slug, id, reply)) return;
    const b = z.object({ authorized: z.literal(true) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'Confirma la aprobación de la mejora.' });
    try { return await applyProposal(slug, id, pid, { authorized: true }); } catch (e) { return err(reply, e); }
  });
  app.post(`${W}/agents/:id/proposals/:pid/reject`, async (req, reply) => {
    const { slug, id, pid } = req.params as any; if (!guard(slug, reply) || !agentOk(slug, id, reply)) return;
    try { return rejectProposal(slug, id, pid); } catch (e) { return err(reply, e); }
  });
}

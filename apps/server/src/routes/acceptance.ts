import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACCEPTANCE_GUIDE_VERSION, ACCEPTANCE_STEPS, acceptanceStepSignature, acceptanceView, type AcceptanceMark } from '@portal-ia/domain';
import { settingsRepo } from '../db/platform.ts';

/**
 * Portal IA 3 · Recorrido de aceptación del propietario. Guarda lo que ÉL marca en cada paso (correcto / falla y su
 * comentario). Nada lo marca por él: ni los agentes ni las pruebas. Marcar exige su sesión (como todo cambio).
 */
const KEY = `acceptance.${ACCEPTANCE_GUIDE_VERSION}`;
function load(): Record<string, AcceptanceMark> {
  try { const j = JSON.parse(settingsRepo.get(KEY) ?? '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

export async function acceptanceRoutes(app: FastifyInstance) {
  app.get('/api/acceptance', async () => acceptanceView(load()));
  app.put('/api/acceptance/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ACCEPTANCE_STEPS.some(s => s.id === id)) return reply.code(404).send({ error: 'Paso no encontrado.' });
    const b = z.object({ result: z.enum(['ok', 'fail']).nullable(), comment: z.string().trim().max(2000).default('') }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'Indica si funcionó («ok»), si falló («fail») o déjalo sin marcar.' });
    if (b.data.result === 'fail' && !b.data.comment) return reply.code(400).send({ error: 'Cuenta qué falló: así se puede corregir.', code: 'comment_required' });
    const marks = load();
    // La marca guarda la huella del paso: si el texto del paso cambia más adelante, habrá que probarlo de nuevo.
    marks[id] = { result: b.data.result, comment: b.data.comment, at: b.data.result ? new Date().toISOString() : null, sig: acceptanceStepSignature(ACCEPTANCE_STEPS.find(s => s.id === id)!) };
    settingsRepo.set(KEY, JSON.stringify(marks));
    return acceptanceView(marks);
  });
}

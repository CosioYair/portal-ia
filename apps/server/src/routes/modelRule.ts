import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOwner } from '../services/ownerSession.ts';
import { MODEL_RULE_SLUG, anthropicModels, getModelRule, setModelRule } from '../services/modelRule.ts';

/**
 * EN-028 · Regla de modelo de Portal IA (solo para la empresa interna). GET devuelve la regla y los modelos de Anthropic
 * disponibles. PUT la guarda solo con la confirmación explícita del propietario (confirm: true). Sin ella, o con un id
 * vacío o que no está en el catálogo, responde 400. La regla se aplica desde la siguiente llamada; los pasos en curso no cambian.
 */
const Params = z.object({ slug: z.string().min(1) });
const RuleBody = z.object({
  model: z.string().trim().min(1, 'Elige un modelo para la regla.').max(200),
  active: z.boolean(),
  confirm: z.literal(true, { errorMap: () => ({ message: 'Activar o cambiar la regla de modelo requiere tu confirmación explícita.' }) })
});

export async function modelRuleRoutes(app: FastifyInstance) {
  app.get('/api/workspaces/:slug/model-rule', async (req, reply) => {
    const p = Params.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'Empresa no válida.', code: 'invalid_slug' });
    const slug = p.data.slug;
    return { slug, supported: slug === MODEL_RULE_SLUG, rule: getModelRule(slug), models: slug === MODEL_RULE_SLUG ? anthropicModels() : [] };
  });

  app.put('/api/workspaces/:slug/model-rule', async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    const p = Params.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'Empresa no válida.', code: 'invalid_slug' });
    const body = RuleBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Regla de modelo no válida.', code: 'invalid_model_rule' });
    try {
      const rule = setModelRule(p.data.slug, { model: body.data.model, active: body.data.active, confirmed: body.data.confirm === true, by: 'propietario' });
      return { slug: p.data.slug, rule };
    } catch (e: any) {
      const status = typeof e?.statusCode === 'number' ? e.statusCode : 500;
      return reply.code(status).send({ error: e?.message ?? 'No se pudo guardar la regla de modelo.', code: status === 400 ? 'invalid_model_rule' : 'save_failed' });
    }
  });
}

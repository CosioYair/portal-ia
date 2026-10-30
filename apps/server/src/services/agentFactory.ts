import type { Agent, AgentConfig, AgentCreateInput, AgentDraftResult, ModelInfo, ProviderId, Scope } from '@portal-ia/domain';
import { CAPABILITIES, KNOWLEDGE, TOOLS, pickByTier } from '@portal-ia/domain';
import { costUsd, estimatePricing, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';
import { requirePolicy } from './executionPolicy.ts';
import { inheritLatestTemplate } from './agentTemplates.ts';

/**
 * Creación de agentes especializados (propósito central del producto).
 * - createAgent: alta manual completa, sin IA.
 * - draftAgent: el Agente de Onboarding propone la configuración a partir de una descripción (1 llamada real, autorizada).
 */
const slugify = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const initialsOf = (name: string) => name.split(/\s+/).filter(w => w.length > 2 && !/^(de|del|la|el|los|las|y|en|para)$/i.test(w)).map(w => w[0]!.toUpperCase()).slice(0, 2).join('') || name.slice(0, 2).toUpperCase();

export function createAgent(slug: string, input: AgentCreateInput): Agent {
  const agents = agentsRepo(slug);
  if (input.scope === 'project' && !input.projectId) throw Object.assign(new Error('Un agente de proyecto necesita proyecto.'), { statusCode: 400 });
  if (input.scope === 'project' && !projectsRepo(slug).get(input.projectId!)) throw Object.assign(new Error('Proyecto no encontrado'), { statusCode: 404 });
  const all = agents.list();
  if (input.reportsTo !== 'owner' && !all.some(a => a.key === input.reportsTo)) throw Object.assign(new Error('El agente al que reporta no existe.'), { statusCode: 400 });
  for (const k of input.collaborates) if (!all.some(a => a.key === k)) throw Object.assign(new Error(`Colaborador desconocido: ${k}`), { statusCode: 400 });
  // Validación de modelo/proveedor como en la edición.
  const prov = providersRepo.get(input.config.provider);
  if (!prov || prov.status !== 'connected') throw Object.assign(new Error('El proveedor elegido no está conectado.'), { statusCode: 409 });
  const models: ModelInfo[] = JSON.parse(prov.models_json);
  if (!models.some(m => m.id === input.config.model)) throw Object.assign(new Error('El modelo preferido no está disponible en el proveedor.'), { statusCode: 400 });
  for (const k of Object.keys(input.config.tools)) if (!TOOLS.some(t => t.id === k)) throw Object.assign(new Error(`Herramienta desconocida: ${k}`), { statusCode: 400 });
  for (const k of Object.keys(input.config.knowledge)) if (!KNOWLEDGE.some(t => t.id === k)) throw Object.assign(new Error(`Fuente de conocimiento desconocida: ${k}`), { statusCode: 400 });
  let key = `${input.scope === 'project' ? 'pj' : 'ws'}-${slugify(input.name) || 'agente'}`;
  let n = 2; while (agents.keyExists(key)) key = `${key.replace(/-\d+$/, '')}-${n++}`;
  const tier = models.find(m => m.id === input.config.model)?.tier ?? 'mid';
  const created = agents.createCustom({
    key, scope: input.scope, projectId: input.scope === 'project' ? input.projectId : null,
    config: { ...input.config, fallbacks: input.config.fallbacks.filter(f => f !== input.config.model) },
    template: { initials: (input.initials || initialsOf(input.name)).slice(0, 2).toUpperCase(), role: input.role, reportsTo: input.reportsTo, supervises: [], collaborates: input.collaborates, evaluation: input.evaluation, tier }
  });
  // Mantener la relación inversa: el supervisor pasa a "supervisar" al nuevo agente.
  if (input.reportsTo !== 'owner') {
    // Jefe del mismo ámbito: el del proyecto del nuevo agente, luego el de empresa (evita el pj-coordinador de otro proyecto).
    const pid = input.scope === 'project' ? (input.projectId ?? null) : null;
    const boss = all.find(a => a.key === input.reportsTo && pid !== null && a.projectId === pid)
      ?? all.find(a => a.key === input.reportsTo && a.scope === 'workspace')
      ?? all.find(a => a.key === input.reportsTo)!;
    if (!boss.template.supervises.includes(key)) agents.updateTemplateMeta(boss.id, { ...boss.template, supervises: [...boss.template.supervises, key] });
  }
  // M5: hereda las prácticas vigentes del papel de su primera capacidad.
  return inheritLatestTemplate(slug, created);
}

export function deleteAgent(slug: string, id: string) {
  const agents = agentsRepo(slug);
  const a = agents.get(id);
  if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
  if (a.templateId !== 'tpl.custom@1') throw Object.assign(new Error('Los agentes del equipo inicial no se eliminan en esta versión; puedes editarlos.'), { statusCode: 409 });
  if (a.status === 'active') throw Object.assign(new Error('No se puede eliminar un agente mientras participa en un proceso.'), { statusCode: 409 });
  for (const other of agents.list()) {
    if (other.template.supervises.includes(a.key) || other.template.collaborates.includes(a.key)) {
      agents.updateTemplateMeta(other.id, { ...other.template, supervises: other.template.supervises.filter(k => k !== a.key), collaborates: other.template.collaborates.filter(k => k !== a.key) });
    }
  }
  agents.delete(id);
}

export function estimateDraft(slug: string): { model: string; byAgent: string; estimatedUsd: number } {
  const onboarding = agentsRepo(slug).list().find(a => a.key === 'ws-onboarding');
  if (!onboarding) throw Object.assign(new Error('Falta el Agente de Onboarding'), { statusCode: 409 });
  const p = estimatePricing(onboarding.config.provider, onboarding.config.model);
  return { model: onboarding.config.model, byAgent: onboarding.config.name, estimatedUsd: (2500 * p.inPerM + 1500 * p.outPerM) / 1_000_000 };
}

/** El Agente de Onboarding propone un agente a partir de una descripción. Una llamada real; requiere autorización y tope. */
export async function draftAgent(slug: string, description: string, scope: Scope, maxUsd: number): Promise<AgentDraftResult> {
  const agents = agentsRepo(slug);
  const onboarding = agents.list().find(a => a.key === 'ws-onboarding');
  if (!onboarding) throw Object.assign(new Error('Falta el Agente de Onboarding'), { statusCode: 409 });
  const est = estimateDraft(slug);
  if (est.estimatedUsd > maxUsd) throw Object.assign(new Error(`La propuesta cuesta aprox. ${est.estimatedUsd.toFixed(3)} USD, por encima del tope autorizado (${maxUsd.toFixed(2)} USD).`), { statusCode: 409 });
  const providerId = onboarding.config.provider as ProviderId;
  const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
  if (!cred || prow.status !== 'connected') throw Object.assign(new Error('El proveedor del Agente de Onboarding no está conectado.'), { statusCode: 409 });
  const models: ModelInfo[] = JSON.parse(prow.models_json);
  const existing = agents.list().map(a => `- ${a.key}: ${a.config.name} (${a.template.role}, ámbito ${a.scope})`).join('\n');
  const system = `Eres «${onboarding.config.name}» en Portal IA. ${onboarding.config.specialization}
Tu tarea: proponer la configuración de un nuevo agente especializado, en JSON estricto, para que el propietario la revise y edite antes de crearlo. No creas nada tú; solo propones.
Herramientas disponibles (id · riesgo): ${TOOLS.map(t => `${t.id} · ${t.risk === 'auth' ? 'requiere autorización' : 'local'}`).join(', ')}.
Conocimiento disponible (id): ${KNOWLEDGE.map(k => k.id).join(', ')}.
Capacidades (id · qué permite en una historia): ${CAPABILITIES.map(c => `${c.id} · ${c.label}`).join(', ')}. Un agente que implementa necesita write_repo; uno que revisa o consulta necesita read_repo.
Modelos disponibles (id · nivel): ${models.map(m => `${m.id} · ${m.tier}`).join(', ')}.
Agentes existentes (key: nombre):
${existing}
Principios: mínimo privilegio (activa solo las herramientas imprescindibles), presupuestos prudentes, esfuerzo acorde a la complejidad, nombres y textos en español.`;
  const user = `Descripción del agente que quiere el propietario (ámbito: ${scope === 'project' ? 'proyecto' : 'espacio de trabajo'}):
"""${description}"""

Responde SOLO con un objeto JSON con esta forma exacta:
{"name": string, "role": string (3–6 palabras), "specialization": string (1–2 frases), "responsibilities": string[3-5], "reportsTo": key existente u "owner", "collaborates": key[], "evaluation": string[3], "model": id de la lista, "effort": "low"|"medium"|"high", "tools": {id: true}, "knowledge": {id: true}, "capabilities": id[] (1-3 de la lista), "monthlyLimitUsd": number, "perTaskAuthUsd": number, "rationale": string (por qué estas decisiones, 2 frases)}`;
  const startedAt = new Date().toISOString();
  try {
    requirePolicy('ai_call', { slug, agentId: onboarding.id, authorized: true });
    const res = await getAdapter(providerId)!.complete(decryptSecret(cred.ciphertext), { workspaceId: prow.workspace_id }, {
      model: onboarding.config.model, system, user, maxTokens: 1500, effort: 'low', supportsEffort: false
    });
    const cost = costUsd(providerId, onboarding.config.model, res.inputTokens, res.outputTokens);
    processesRepo(slug).logExecution({ projectId: agents.list().find(a => a.projectId)?.projectId ?? '', agentId: onboarding.id, kind: 'agent_draft', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
    const jsonText = res.text.match(/\{[\s\S]*\}/)?.[0] ?? '{}';
    let j: any = {}; try { j = JSON.parse(jsonText); } catch { j = {}; }
    const model = models.some(m => m.id === j.model) ? j.model : (pickByTier(models, 'mid')?.id ?? models[0]?.id);
    const tools: Record<string, boolean> = {}; for (const k of Object.keys(j.tools ?? {})) if (TOOLS.some(t => t.id === k) && j.tools[k]) tools[k] = true;
    const knowledge: Record<string, boolean> = {}; for (const k of Object.keys(j.knowledge ?? {})) if (KNOWLEDGE.some(t => t.id === k) && j.knowledge[k]) knowledge[k] = true;
    const keys = agents.list().map(a => a.key);
    const config: Partial<AgentConfig> = {
      name: typeof j.name === 'string' ? j.name : undefined, specialization: typeof j.specialization === 'string' ? j.specialization : undefined,
      responsibilities: Array.isArray(j.responsibilities) ? j.responsibilities.filter((x: any) => typeof x === 'string').slice(0, 8) : undefined,
      provider: providerId, model, effort: ['low', 'medium', 'high'].includes(j.effort) ? j.effort : 'medium', tools, knowledge,
      monthlyLimitUsd: typeof j.monthlyLimitUsd === 'number' ? j.monthlyLimitUsd : 20, perTaskAuthUsd: typeof j.perTaskAuthUsd === 'number' ? j.perTaskAuthUsd : 2, fallbacks: [],
      capabilities: Array.isArray(j.capabilities) ? j.capabilities.filter((c: any) => CAPABILITIES.some(k => k.id === c)).slice(0, 3) : ['consultar']
    };
    return {
      proposal: { scope, name: config.name, role: typeof j.role === 'string' ? j.role : undefined, reportsTo: j.reportsTo === 'owner' || keys.includes(j.reportsTo) ? j.reportsTo : undefined,
        collaborates: Array.isArray(j.collaborates) ? j.collaborates.filter((k: any) => keys.includes(k)) : [], evaluation: Array.isArray(j.evaluation) ? j.evaluation.filter((x: any) => typeof x === 'string').slice(0, 5) : [], config, ...(typeof j.rationale === 'string' ? { rationale: j.rationale } as any : {}) },
      inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: cost, model: onboarding.config.model, byAgent: onboarding.config.name
    };
  } catch (e) {
    processesRepo(slug).logExecution({ projectId: '', agentId: onboarding.id, kind: 'agent_draft', status: 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt });
    if (e instanceof ProviderRequestError) throw Object.assign(new Error(e.error.message), { statusCode: 502 });
    throw e;
  }
}

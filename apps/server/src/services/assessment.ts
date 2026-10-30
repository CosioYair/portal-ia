import { agentCaller, completeWith } from './claudeCode/backend.ts';
import type { Agent, AssessmentEstimate, Process, ProviderId } from '@portal-ia/domain';
import { costUsd, estimatePricing, estimateTokens, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, knowledgeRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { activeAgents } from './activeAgents.ts';
import { decryptSecret } from '../security/crypto.ts';
import { requirePolicy } from './executionPolicy.ts';
import { buildRepoContext, renderRepoContext } from './repoContext.ts';
import { importBacklogFromKnowledge } from './backlog.ts';
import { callTimeoutMs, maybeBilled, registerCall, unregisterCall, withWatchdog } from './providerCalls.ts';

/**
 * HU-004 · Evaluación inicial del proyecto.
 * Proceso real de varios pasos ejecutado por agentes del proyecto, SOLO tras autorización explícita del usuario
 * y dentro de un presupuesto en USD. Cada llamada queda registrada (tokens, costo). Los resultados se guardan en el
 * conocimiento del proyecto. Los agentes implicados pasan a 'active' durante el proceso y vuelven a 'inactive' al terminar.
 */
const STEP_PLAN = [
  { agentKey: 'pj-coordinador', title: 'Comprensión del producto y dirección', maxTokens: 3500 },
  { agentKey: 'pj-arquitecto', title: 'Evaluación técnica y arquitectura', maxTokens: 3500 },
  { agentKey: 'pj-ux', title: 'Dirección de diseño y experiencia', maxTokens: 3000 },
  { agentKey: 'pj-coordinador', title: 'Síntesis y backlog inicial priorizado', maxTokens: 4000 }
] as const;

const PRINCIPLES = `Principios del producto (no negociables): local-first; multiempresa con espacios aislados; agentes con ámbito, permisos y presupuestos explícitos; ninguna acción peligrosa sin autorización del usuario; minimizar consumo de IA; el propio Portal IA es su primer cliente (sus agentes construyen el producto). Arquitectura aprobada: monorepositorio TypeScript, React + Vite, Node.js + Fastify, SQLite por empresa, adaptadores de IA por proveedor, sandbox Docker/WSL2.`;

function systemFor(agent: Agent, project: { name: string; description: string }, objectives: string[]): string {
  return `Eres «${agent.config.name}», ${agent.template.role.toLowerCase()} del proyecto «${project.name}» en Portal IA, una plataforma local de gestión de empresas operadas por agentes de IA.
Especialización: ${agent.config.specialization}
Responsabilidades: ${agent.config.responsibilities.map(r => '- ' + r).join('\n')}
Criterios con los que se evaluará tu trabajo: ${agent.template.evaluation.join(' · ')}

Contexto del proyecto: ${project.description}
Objetivos aprobados:
${objectives.map((o, i) => `${i + 1}. ${o}`).join('\n')}
${PRINCIPLES}

Reglas: responde en español, en Markdown claro y accionable, sin relleno. No inventes hechos sobre el repositorio: si algo no está en el contexto, dilo. No propongas acciones que requieran ejecutar código o escribir archivos: este proceso es de análisis (solo lectura). Sé concreto y prioriza.`;
}

function userFor(stepIndex: number, repoCtx: string, previous: { title: string; output: string }[]): string {
  const prev = previous.length ? `\n\n# Resultados de pasos anteriores\n${previous.map(p => `## ${p.title}\n${p.output}`).join('\n\n')}` : '';
  const asks = [
    `Analiza la idea del producto y el estado actual del repositorio. Entrega: (1) qué es el producto y para quién, en tus palabras; (2) qué existe hoy realmente en el código y qué falta respecto a los objetivos; (3) dirección recomendada para las próximas 4–6 semanas, con criterios de éxito; (4) los 5 riesgos principales; (5) preguntas que necesitas que responda el propietario. Máximo ~900 palabras.`,
    `Evalúa la arquitectura actual frente a la aprobada. Entrega: (1) valoración de la estructura del monorepositorio, contratos (dominio, adaptadores, API) y persistencia; (2) deuda técnica y riesgos de seguridad detectados (credenciales, permisos, ejecución); (3) propuesta de arquitectura para activar agentes con autorización de ejecución, presupuestos por proceso y sandbox; (4) convenciones que el equipo debe seguir; (5) 6–10 historias técnicas ordenadas. Máximo ~1000 palabras.`,
    `Evalúa la dirección de diseño y la experiencia de usuario a partir del handoff y las pantallas implementadas. Entrega: (1) valoración de la identidad visual y el sistema de diseño (coherencia, legibilidad, estados); (2) principios de experiencia para un producto que gestiona agentes autónomos con límites explícitos (confianza, visibilidad de estado, autorización); (3) mejoras concretas a las pantallas actuales; (4) qué pantallas o componentes faltan para las próximas historias (activación, solicitudes, procesos, presupuestos); (5) riesgos de usabilidad. Máximo ~800 palabras.`,
    `Sintetiza los tres análisis anteriores en un documento de dirección para el propietario. Entrega: (1) resumen ejecutivo (≤120 palabras); (2) dirección y estilo del proyecto acordados; (3) backlog inicial priorizado de 10–14 historias con: id (HU-0xx), título, agente responsable, dependencia, estimación relativa (S/M/L) y criterio de aceptación en una línea; (4) decisiones que requieren al propietario; (5) presupuesto de IA sugerido por historia (bajo/medio/alto). Al final incluye un bloque \`\`\`json con el backlog como lista de objetos {id, titulo, responsable, dependeDe, estimacion, criterio}.`
  ];
  const ctx = stepIndex === 3 ? '' : `\n\n# Repositorio registrado (solo lectura)\n${repoCtx}`;
  return `${asks[stepIndex]}${prev}${ctx}`;
}

function resolveAgents(slug: string, projectId: string) {
  const agents = activeAgents(slug).filter(a => a.projectId === projectId || a.scope === 'workspace');
  const byKey = (k: string) => agents.find(a => a.key === k);
  return STEP_PLAN.map(s => { const a = byKey(s.agentKey); if (!a) throw Object.assign(new Error(`Falta el agente ${s.agentKey}`), { statusCode: 409 }); return { ...s, agent: a }; });
}

export function estimateAssessment(slug: string, projectId: string): AssessmentEstimate {
  const project = projectsRepo(slug).get(projectId);
  if (!project) throw Object.assign(new Error('Proyecto no encontrado'), { statusCode: 404 });
  const repo = projectsRepo(slug).repository(projectId);
  const ctxChars = repo ? buildRepoContext(repo.path).totalChars : 0;
  const ctxTokens = Math.ceil(ctxChars / 3.5) + 1500; // ~3.5 caracteres por token para código/markdown
  const steps = resolveAgents(slug, projectId).map((s, i) => {
    const p = estimatePricing(s.agent.config.provider, s.agent.config.model);
    const inTok = (i === 3 ? 1500 : ctxTokens) + i * 2500; // los pasos posteriores incluyen los resultados anteriores
    const outTok = s.maxTokens * 0.8 + (s.agent.config.effort === 'high' ? 6000 : s.agent.config.effort === 'medium' ? 2500 : 0);
    const estimatedUsd = (inTok * p.inPerM + outTok * p.outPerM) / 1_000_000;
    return { agentId: s.agent.id, agentName: s.agent.config.name, title: s.title, model: s.agent.config.model, estimatedUsd };
  });
  const estimatedUsd = steps.reduce((a, s) => a + s.estimatedUsd, 0);
  return { steps, contextChars: ctxChars, estimatedUsd, suggestedBudgetUsd: Math.max(0.5, Math.ceil(estimatedUsd * 1.6 * 2) / 2), approximate: true };
}

export function createAssessment(slug: string, projectId: string): Process {
  const procs = processesRepo(slug);
  const pending = procs.list(projectId).find(p => p.kind === 'initial_assessment' && (p.status === 'pending_authorization' || p.status === 'running'));
  if (pending) return pending;
  const est = estimateAssessment(slug, projectId);
  return procs.create({ projectId, kind: 'initial_assessment', title: 'Evaluación inicial del proyecto', estimatedUsd: est.estimatedUsd, steps: est.steps.map(s => ({ agentId: s.agentId, agentName: s.agentName, title: s.title, model: s.model })) });
}

const cancelFlags = new Map<string, boolean>();
export function cancelProcess(id: string) { cancelFlags.set(id, true); }
export function isCancelled(id: string) { return !!cancelFlags.get(id); }
export function clearCancel(id: string) { cancelFlags.delete(id); }

/** Ejecuta el proceso de forma asíncrona (no bloquea la respuesta HTTP). */
export async function runAssessment(slug: string, processId: string, log: (o: any, msg: string) => void) {
  const procs = processesRepo(slug); const agents = agentsRepo(slug); const knowledge = knowledgeRepo(slug);
  const proc = procs.get(processId)!;
  const project = projectsRepo(slug).get(proc.projectId)!;
  const objectives = projectsRepo(slug).objectives(project.id).map(o => o.text);
  const repo = projectsRepo(slug).repository(project.id);
  const repoCtx = repo ? renderRepoContext(buildRepoContext(repo.path)) : '_(No hay repositorio registrado: evalúa solo a partir de los objetivos y el contexto aprobado.)_';
  const involved = Array.from(new Set(proc.steps.map(s => s.agentId)));
  involved.forEach(id => agents.setStatus(id, 'active'));
  const previous: { title: string; output: string }[] = [];
  let finalStatus: Process['status'] = 'done'; let finalError: string | null = null;

  try {
    for (let i = 0; i < proc.steps.length; i++) {
      const step = proc.steps[i];
      if (cancelFlags.get(processId)) { procs.stepFinish(step.id, 'skipped', { error: 'cancelado por el usuario' }); finalStatus = 'cancelled'; continue; }
      if (finalStatus !== 'done') { procs.stepFinish(step.id, 'skipped', {}); continue; }
      const agent = agents.get(step.agentId)!;
      const providerId = agent.config.provider as ProviderId;
      const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
      const cc = agentCaller(slug, agent, proc.projectId, 'Evaluación inicial');
      if (!cc && (!cred || prow.status !== 'connected')) { procs.stepFinish(step.id, 'failed', { error: 'proveedor no conectado' }); finalStatus = 'failed'; finalError = `El proveedor ${providerId} no está conectado.`; continue; }
      const models: { id: string; supportsEffort: boolean }[] = JSON.parse(prow.models_json);
      const modelInfo = models.find(m => m.id === agent.config.model);
      // Comprobación de presupuesto ANTES de llamar: estimación conservadora del paso.
      const current = procs.get(processId)!;
      const p = estimatePricing(providerId, agent.config.model);
      const stepEstimate = ((repoCtx.length / 3.5 + 4000) * p.inPerM + STEP_PLAN[i].maxTokens * p.outPerM) / 1_000_000;
      if (current.spentUsd + (current.unconfirmedUsd ?? 0) + stepEstimate * 0.6 > current.budgetUsd) {
        procs.stepFinish(step.id, 'skipped', { error: `presupuesto insuficiente (gastado ${current.spentUsd.toFixed(2)} de ${current.budgetUsd.toFixed(2)} USD)` });
        finalStatus = 'budget_exceeded'; finalError = 'Se alcanzó el presupuesto autorizado antes de completar todos los pasos.'; continue;
      }
      procs.stepStart(step.id);
      const startedAt = new Date().toISOString();
      const systemPrompt = systemFor(agent, project, objectives); const userPrompt = userFor(i, repoCtx, previous);
      // Plazo proporcional y cancelación real: «Cancelar» aborta esta petición (ver providerCalls.ts).
      const ctrl = registerCall(processId);
      try {
        requirePolicy('ai_call', { slug, processId, agentId: agent.id, projectId: proc.projectId, authorized: true });
      const timeoutMs = callTimeoutMs(STEP_PLAN[i].maxTokens, agent.config.effort);
      const res = await withWatchdog(completeWith(cc, providerId, cred, prow, {
          model: agent.config.model, system: systemPrompt, user: userPrompt,
          maxTokens: STEP_PLAN[i].maxTokens, effort: agent.config.effort, supportsEffort: !!modelInfo?.supportsEffort,
          timeoutMs
        }, ctrl.signal), ctrl, timeoutMs);
        const cost = (cc ? 0 : costUsd(providerId, agent.config.model, res.inputTokens, res.outputTokens));
        procs.stepFinish(step.id, 'done', { tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, outputMd: res.text });
        procs.addUsage(processId, res.inputTokens, res.outputTokens, cost);
        procs.logExecution({ projectId: project.id, agentId: agent.id, kind: 'assessment_step', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
        knowledge.add({ projectId: project.id, title: `${step.title} — ${agent.config.name}`, body: res.text, authorAgentId: agent.id, authorAgentName: agent.config.name, processId });
        previous.push({ title: step.title, output: res.text });
        log({ step: step.title, tokens: res.inputTokens + res.outputTokens, cost: cost.toFixed(4) }, 'paso completado');
      } catch (e) {
        const err = e instanceof ProviderRequestError ? e.error : null;
        let msg = err ? err.message : (e as Error).message;
        // Si la solicitud llegó al proveedor pero se cortó (plazo, cancelación, red) o falló en servidor, la entrada pudo
        // facturarse: su costo ESTIMADO se guarda como no confirmado, aparte del gasto confirmado (nunca un 0 engañoso).
        const billed = !cc && maybeBilled(e);
        const estIn = billed ? estimateTokens(systemPrompt + userPrompt) : 0;
        const estCost = billed ? costUsd(providerId, agent.config.model, estIn, 0) : 0;
        if (billed) msg += ` Posible costo NO confirmado: ≈ ${estCost.toFixed(4)} USD (≈${estIn} tokens de entrada; sin confirmación del proveedor).`;
        procs.stepFinish(step.id, 'failed', { error: msg });
        if (billed) procs.addUnconfirmed(processId, step.id, estCost);
        procs.logExecution({ projectId: project.id, agentId: agent.id, kind: 'assessment_step', status: 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt });
        finalStatus = err?.code === 'cancelled' ? 'cancelled' : 'failed'; finalError = msg;
        log({ step: step.title, error: msg }, 'paso fallido');
      } finally { unregisterCall(processId, ctrl); }
    }
  } finally {
    involved.forEach(id => agents.setStatus(id, 'inactive'));
    procs.finish(processId, finalStatus, finalError);
    cancelFlags.delete(processId);
    if (finalStatus === 'done') { try { const r = importBacklogFromKnowledge(slug, project.id); log({ imported: r.imported }, 'backlog importado desde la síntesis'); } catch (e) { log({ err: (e as Error).message }, 'no se pudo importar el backlog'); } }
    log({ processId, status: finalStatus, spent: procs.get(processId)?.spentUsd.toFixed(4) }, 'proceso finalizado');
  }
}

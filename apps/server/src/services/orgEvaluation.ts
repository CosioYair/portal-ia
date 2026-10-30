import { agentCaller, completeWith } from './claudeCode/backend.ts';
import type { Agent, DelegationResult, ModelInfo, OrgDecision, OrgEvaluation, OrgEvaluationStatus, OrgProposal, Process, ProviderId } from '@portal-ia/domain';
import { ORG_ACTION_LABEL, ORG_TARGET_LABEL, departmentOf, isRetired, parseOrgProposals } from '@portal-ia/domain';
import { costUsd, estimatePricing, estimateTokens, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo, workspacesRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, knowledgeRepo, processesRepo, projectsRepo, workspaceDb } from '../db/workspace.ts';
import { orgEvaluationsRepo } from '../db/orgEvaluationSchema.ts';
import { requirePolicy } from './executionPolicy.ts';
import { buildRepoContext } from './repoContext.ts';
import { phaseContext } from './operationalPhase.ts';
import { callTimeoutMs, maybeBilled, registerCall, unregisterCall, withWatchdog } from './providerCalls.ts';
import { acceptProposal, orgCatalog } from './orgProposalApply.ts';

/**
 * HU-159 · Evaluación organizativa. Con ámbito de proyecto participan el Coordinador del proyecto y el Gestor
 * Organizacional; con ámbito de empresa, el Gestor. Se reutiliza el proceso «delegated_task» (cancelación, vista de
 * procesos y presupuesto). El resultado va a Conocimiento con propuestas que traen su configuración (spec). Aceptar una
 * propuesta la aplica (orgProposalApply.ts, reversible con «Deshacer»); rechazarla solo registra la decisión.
 * Los agentes retirados no participan como responsables de la evaluación.
 */
const TOKENS = { coordinator: 4000, gestor: 12000 } as const;
const CTX_MAX = 48_000;
const STEP_COORD = 'Análisis del Coordinador';
const STEP_GESTOR = 'Evaluación del Gestor';
const isTruncated = (stop: string | null | undefined) => stop === 'max_tokens' || stop === 'length';
const httpError = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, code });
const cancelledError = () => Object.assign(new Error('cancelado'), { cancelled: true });

function resolveScope(slug: string, projectId: string | null, anchorProjectId?: string | null) {
  const ws = workspacesRepo.get(slug);
  if (!ws) throw httpError(404, 'Espacio no encontrado');
  const projects = projectsRepo(slug);
  if (projectId) {
    const p = projects.get(projectId);
    if (!p) throw httpError(404, 'El proyecto no pertenece a esta empresa.');
    return { ws, project: p, anchor: p, label: `proyecto «${p.name}»` };
  }
  // Evaluación de empresa: se ancla al proyecto activo que envía la interfaz (validado); si no llega, al primero.
  if (anchorProjectId) {
    const active = projects.get(anchorProjectId);
    if (!active) throw httpError(422, 'El proyecto activo no pertenece a esta empresa.', 'invalid_anchor');
    return { ws, project: null, anchor: active, label: `empresa «${ws.name}»` };
  }
  const anchor = projects.list()[0];
  if (!anchor) throw httpError(409, 'La empresa no tiene proyectos: crea uno para guardar la evaluación en Conocimiento.', 'no_project');
  return { ws, project: null, anchor, label: `empresa «${ws.name}»` };
}

function findLeads(slug: string, projectId: string | null): { gestor: Agent; coordinator: Agent | null } {
  const all = agentsRepo(slug).list().filter(a => !isRetired(a.template));
  const gestor = all.find(a => a.key === 'ws-gestor');
  if (!gestor) throw httpError(409, 'Falta el Gestor Organizacional (ws-gestor) en esta empresa.', 'missing_agent');
  if (!projectId) return { gestor, coordinator: null };
  const coordinator = all.find(a => a.key === 'pj-coordinador' && a.projectId === projectId);
  if (!coordinator) throw httpError(409, 'Falta el Coordinador (pj-coordinador) de este proyecto.', 'missing_agent');
  return { gestor, coordinator };
}

function agentLine(slug: string, a: Agent, projectNames: Map<string, string>): string {
  const caps = Array.isArray(a.config.capabilities) ? (a.config.capabilities as unknown[]).map(c => (typeof c === 'string' ? c : JSON.stringify(c))).join(', ') : '—';
  const tpl = a.template as any;
  const supervises = Array.isArray(tpl.supervises) ? tpl.supervises.join(', ') : '';
  const st = processesRepo(slug).agentStats(a.id);
  const scope = a.scope === 'workspace' ? 'empresa' : `proyecto «${projectNames.get(a.projectId ?? '') ?? a.projectId}»`;
  return `- ${a.config.name}${isRetired(a.template) ? ' (retirado)' : ''} · clave ${a.key} · papel ${tpl.role}${departmentOf(a.template) ? ` · departamento ${departmentOf(a.template)}` : ''} · ámbito ${scope}${tpl.tier ? ` · nivel ${tpl.tier}` : ''} · reporta a ${tpl.reportsTo || '—'} · supervisa ${supervises || '—'} · modelo ${a.config.provider}/${a.config.model}${a.config.effort ? ` (${a.config.effort})` : ''} · herramientas/permisos: ${caps || '—'} · actividad: ${st.steps} pasos (${st.failed} fallidos, ${st.costUsd.toFixed(2)} USD)${st.lastAt ? `, último ${st.lastAt.slice(0, 10)}` : ''}`;
}

/** Contexto real y recortado: agentes (papel, permisos, modelo, jerarquía, actividad), línea base, backlog, actividad y repositorio. */
export function buildOrgContext(slug: string, projectId: string | null): string {
  const ws = workspacesRepo.get(slug)!; const projects = projectsRepo(slug); const procs = processesRepo(slug);
  const all = projects.list(); const names = new Map(all.map(p => [p.id, p.name]));
  const list = projectId ? all.filter(p => p.id === projectId) : all;
  const agents = agentsRepo(slug).list().filter(a => !projectId || a.scope === 'workspace' || a.projectId === projectId);
  const lines: string[] = [`# Empresa «${ws.name}» · ámbito evaluado: ${projectId ? `proyecto «${list[0]?.name ?? projectId}»` : 'toda la empresa'}`];
  lines.push(`\n## Agentes actuales (${agents.length})\n${agents.map(a => agentLine(slug, a, names)).join('\n') || '(ninguno)'}`);
  for (const p of list) {
    lines.push(`\n## Proyecto «${p.name}»\n${p.description}\nObjetivos: ${projects.objectives(p.id).map(o => o.text).join(' · ') || '—'}`);
    try { const phase = phaseContext(slug, p.id, projectId ? 12000 : 3000); if (phase) lines.push(`### Línea base\n${phase}`); } catch { /* sin línea base */ }
    const bl = backlogRepo(slug).list(p.id);
    const byStatus = bl.reduce<Record<string, number>>((acc, b) => { acc[b.status] = (acc[b.status] ?? 0) + 1; return acc; }, {});
    lines.push(`### Backlog activo (${bl.length}: ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ') || 'vacío'})\n${bl.slice(0, projectId ? 40 : 12).map(b => `- ${b.storyId} [${b.status}]${b.ownerKey ? ` (responsable ${b.ownerKey})` : ''} ${b.title}`).join('\n') || '(vacío)'}`);
    const recent = procs.list(p.id).slice(0, projectId ? 15 : 5);
    lines.push(`### Actividad reciente\n${recent.map(r => `- ${r.createdAt.slice(0, 10)} · ${r.kind} · ${r.status} · ${r.title} · ${r.spentUsd.toFixed(2)} USD · pasos: ${r.steps.map(s => s.agentName).join(', ')}`).join('\n') || '(sin procesos)'}`);
    const repo = projects.repository(p.id);
    if (repo) { try { const ctx = buildRepoContext(repo.path, 20_000); lines.push(`### Repositorio ${repo.path} (rama ${repo.branch ?? '?'})\n\`\`\`\n${ctx.tree.slice(0, projectId ? 6000 : 1500)}\n\`\`\``); } catch { /* sin árbol */ } }
  }
  return lines.join('\n').slice(0, CTX_MAX);
}

function price(a: Agent, inTok: number, outTok: number): number {
  const p = estimatePricing(a.config.provider, a.config.model);
  const think = a.config.effort === 'high' ? 6000 : a.config.effort === 'medium' ? 2500 : 0;
  return (inTok * p.inPerM + (outTok + think) * p.outPerM) / 1_000_000;
}

export function estimateOrgEvaluation(slug: string, projectId: string | null, anchorProjectId?: string | null) {
  const { project, anchor } = resolveScope(slug, projectId, anchorProjectId);
  const { gestor, coordinator } = findLeads(slug, project?.id ?? null);
  const ctx = buildOrgContext(slug, project?.id ?? null);
  const ctxTok = estimateTokens(ctx) + 900;
  const steps: { agentId: string; agentName: string; title: string; model: string; estimatedUsd: number }[] = [];
  if (coordinator) steps.push({ agentId: coordinator.id, agentName: coordinator.config.name, title: STEP_COORD, model: coordinator.config.model, estimatedUsd: price(coordinator, ctxTok, TOKENS.coordinator) });
  steps.push({ agentId: gestor.id, agentName: gestor.config.name, title: STEP_GESTOR, model: gestor.config.model, estimatedUsd: price(gestor, ctxTok + (coordinator ? TOKENS.coordinator : 0), TOKENS.gestor) });
  const estimatedUsd = steps.reduce((acc, s) => acc + s.estimatedUsd, 0);
  return { scopeKind: project ? 'project' as const : 'workspace' as const, projectId: project?.id ?? null, anchorProjectId: anchor.id, steps, contextChars: ctx.length, estimatedUsd, suggestedBudgetUsd: Math.max(0.5, Math.ceil(estimatedUsd * 2 * 2) / 2), approximate: true };
}

/** Crea el proceso ya autorizado con su presupuesto (la ruta exige autorización explícita) y la fila del historial. */
export function createOrgEvaluation(slug: string, projectId: string | null, budgetUsd: number, anchorProjectId?: string | null): { evaluation: OrgEvaluation; process: Process } {
  if (!(budgetUsd > 0)) throw httpError(403, 'Indica un presupuesto mayor que 0 USD.', 'authorization_required');
  const est = estimateOrgEvaluation(slug, projectId, anchorProjectId);
  const { project, anchor, label } = resolveScope(slug, projectId, anchorProjectId);
  const { gestor } = findLeads(slug, project?.id ?? null);
  const evals = orgEvaluationsRepo(slug);
  if (evals.list({ projectId: project?.id ?? null }).some(e => e.status === 'running')) throw httpError(409, 'Ya hay una evaluación en curso para este ámbito.', 'already_running');
  const procs = processesRepo(slug);
  const proc = procs.create({ projectId: anchor.id, kind: 'delegated_task', title: `Evaluación organizativa · ${label}`, estimatedUsd: est.estimatedUsd, steps: est.steps.map(s => ({ agentId: s.agentId, agentName: s.agentName, title: s.title, model: s.model })) });
  const d: DelegationResult = { request: `Evaluar si la organización (${label}) tiene los agentes y departamentos adecuados según el contenido real.`, leadAgentId: gestor.id, leadAgentName: gestor.config.name, triage: null, consulted: [], deliverable: null, knowledgeDocId: null, backlogOps: [], opsApplied: null };
  procs.setDelegation(proc.id, d);
  procs.authorize(proc.id, budgetUsd);
  const evaluation = evals.create({ scopeKind: project ? 'project' : 'workspace', projectId: project?.id ?? null, anchorProjectId: anchor.id, processId: proc.id, status: 'running' });
  return { evaluation, process: procs.get(proc.id)! };
}

function sys(agent: Agent, slug: string): string {
  const ws = workspacesRepo.get(slug)!;
  return `Eres «${agent.config.name}», ${agent.template.role.toLowerCase()} en la empresa «${ws.name}» dentro de Portal IA (plataforma local donde empresas son operadas por equipos de agentes de IA bajo la autoridad del propietario).
Especialización: ${agent.config.specialization}
Responsabilidades: ${agent.config.responsibilities.map(r => '- ' + r).join('\n')}
Trabajas en español, con criterio profesional y sin inventar datos: usa solo el estado real que se te da.`;
}

const coordPrompt = (ctx: string) => `El propietario pide evaluar si la organización tiene los agentes correctos para este proyecto. Tu análisis lo usará el Gestor Organizacional.

# Estado real
${ctx}

Analiza en markdown breve (máx. ~600 palabras): qué trabajo real hay (repositorio, línea base, backlog, actividad), qué capacidades exige, qué agentes participan de verdad y cuáles apenas intervienen, cuellos de botella y huecos de capacidad. Cita evidencias concretas. No propongas aún cambios formales.`;

const gestorPrompt = (ctx: string, label: string, coordNotes: string, catalog: string) => `El propietario pide evaluar si la organización (${label}) tiene los agentes y departamentos correctos según el contenido real.
${coordNotes ? `\n# Análisis del Coordinador del proyecto\n${coordNotes}\n` : ''}
# Estado real
${ctx}

# Catálogo permitido para las configuraciones
${catalog}

Entrega en markdown (máx. ~900 palabras): empieza con «## Resumen» (3-5 frases) y después el diagnóstico (papeles, permisos, jerarquía, carga real, solapamientos y huecos).
Al final, UN bloque \`\`\`org con un array JSON de propuestas (máx. 12) con este formato exacto:
{"action":"add"|"merge"|"retire"|"adjust","target":"agent"|"department","subject":string,"keep":string,"rationale":string,"details":string,"spec":{"name":string,"role":string,"specialization":string,"responsibilities":string[],"reportsTo":clave existente|"owner","tools":id[],"capabilities":id[],"model":id,"effort":"low"|"medium"|"high","department":string,"agents":spec[],"members":clave[]}}
Reglas: "rationale" obligatorio y basado en evidencias reales del contexto; en merge, retire y adjust usa las claves existentes de agentes activos ("subject" de merge: "A + B"; "keep": el que se conserva). "spec" es la configuración concreta que el Portal aplicará si el propietario acepta: obligatorio en add y adjust (en adjust, solo los campos que cambian), opcional en merge (configuración del que se conserva) y omitido en retire. Para añadir un departamento usa "spec.agents" (agentes nuevos) o "spec.members" (claves existentes). Usa solo herramientas, capacidades y modelos del catálogo, con mínimo privilegio. No retires al Gestor Organizacional ni al último Coordinador de un proyecto; los agentes marcados «(retirado)» ya están desactivados. En "details" resume el cambio en lenguaje llano. Si la organización es adecuada, devuelve []. Cierra el bloque con \`\`\`. Nada se aplicará sin la aprobación del propietario.`;

function summarize(body: string): string {
  const sec = /##\s*Resumen[^\n]*\n([\s\S]*?)(?=\n#|$)/i.exec(body)?.[1]?.trim();
  const para = sec || body.split(/\n\s*\n/).map(s => s.trim()).find(s => s && !s.startsWith('#')) || '';
  return para.slice(0, 600);
}

const proposalLine = (p: OrgProposal) => `- **${p.id} · ${ORG_ACTION_LABEL[p.action]} ${ORG_TARGET_LABEL[p.target]}: ${p.subject}** — ${p.rationale}${p.details ? `\n  ${p.details}` : ''}${p.spec ? `\n  Configuración propuesta: \`${JSON.stringify(p.spec).slice(0, 600)}\`` : ''}${p.specWarnings?.length ? `\n  Avisos: ${p.specWarnings.join(' ')}` : ''}`;

export async function runOrgEvaluation(slug: string, processId: string, log: (o: any, m: string) => void, isCancelled: () => boolean) {
  const procs = processesRepo(slug); const agents = agentsRepo(slug); const knowledge = knowledgeRepo(slug); const evals = orgEvaluationsRepo(slug);
  const proc = procs.get(processId); if (!proc) return;
  const ev = evals.byProcess(processId);
  if (!ev) { procs.finish(processId, 'failed', 'Evaluación organizativa no encontrada.'); return; }
  const d = proc.delegation!;
  const projectId = ev.projectId;
  const ws = workspacesRepo.get(slug)!;
  const scopeName = projectId ? (projectsRepo(slug).get(projectId)?.name ?? projectId) : ws.name;
  const label = projectId ? `proyecto «${scopeName}»` : `empresa «${scopeName}»`;
  const involved = Array.from(new Set(proc.steps.map(s => s.agentId)));
  involved.forEach(id => agents.setStatus(id, 'active'));
  let finalStatus: Process['status'] = 'done'; let finalError: string | null = null;

  const call = async (stepIdx: number, system: string, user: string, maxTokens: number, history?: { role: 'user' | 'assistant'; content: string }[]) => {
    const step = proc.steps[stepIdx]; const agent = agents.get(step.agentId)!;
    const providerId = agent.config.provider as ProviderId;
    const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
    const cc = agentCaller(slug, agent, proc.projectId, 'Evaluación organizativa');
    if (!cc && (!cred || prow.status !== 'connected')) throw new Error(`El proveedor ${providerId} no está conectado.`);
    const models: ModelInfo[] = JSON.parse(prow.models_json);
    const cur = procs.get(processId)!; const p = estimatePricing(providerId, agent.config.model);
    const stepEst = (estimateTokens(system + user) * p.inPerM + maxTokens * p.outPerM) / 1_000_000;
    if (cur.spentUsd + (cur.unconfirmedUsd ?? 0) + stepEst * 0.5 > cur.budgetUsd) throw Object.assign(new Error(`Presupuesto insuficiente para «${step.title}» (gastado ${cur.spentUsd.toFixed(2)} de ${cur.budgetUsd.toFixed(2)} USD).`), { budget: true });
    procs.stepStart(step.id); const startedAt = new Date().toISOString();
    const ctrl = registerCall(processId);
    try {
      requirePolicy('ai_call', { slug, processId, agentId: agent.id, projectId: proc.projectId, authorized: true });
      const timeoutMs = callTimeoutMs(maxTokens, agent.config.effort);
      const res = await withWatchdog(completeWith(cc, providerId, cred, prow, { model: agent.config.model, system, user, maxTokens, effort: agent.config.effort, supportsEffort: !!models.find(m => m.id === agent.config.model)?.supportsEffort, history, timeoutMs }, ctrl.signal), ctrl, timeoutMs);
      const cost = cc ? 0 : costUsd(providerId, agent.config.model, res.inputTokens, res.outputTokens);
      const prev = procs.get(processId)!.steps[stepIdx]; const acc = history?.length ? prev : { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      procs.stepFinish(step.id, 'done', { tokensIn: acc.inputTokens + res.inputTokens, tokensOut: acc.outputTokens + res.outputTokens, cost: acc.costUsd + cost, outputMd: history?.length ? `${history.filter(h => h.role === 'assistant').map(h => h.content).join('')}${res.text}` : res.text });
      procs.addUsage(processId, res.inputTokens, res.outputTokens, cost);
      procs.logExecution({ projectId: proc.projectId, agentId: agent.id, kind: 'org_evaluation_step', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
      log({ step: step.title, tokens: res.inputTokens + res.outputTokens, cost: cost.toFixed(4) }, 'paso completado');
      return res;
    } catch (e) {
      const err = e instanceof ProviderRequestError ? e.error : null; let msg = err ? err.message : (e as Error).message;
      const billed = !cc && maybeBilled(e); const estCost = billed ? costUsd(providerId, agent.config.model, estimateTokens(system + user), 0) : 0;
      if (billed) msg += ` Posible costo NO confirmado por el proveedor: ≈ ${estCost.toFixed(4)} USD (estimación de la entrada enviada).`;
      procs.stepFinish(step.id, 'failed', { error: msg }); if (billed) procs.addUnconfirmed(processId, step.id, estCost);
      procs.logExecution({ projectId: proc.projectId, agentId: agent.id, kind: 'org_evaluation_step', status: 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt });
      throw Object.assign(new Error(msg), { cancelled: err?.code === 'cancelled' });
    } finally { unregisterCall(processId, ctrl); }
  };

  try {
    const ctx = buildOrgContext(slug, projectId);
    let coordNotes = ''; let idx = 0;
    if (ev.scopeKind === 'project' && proc.steps.length > 1) {
      if (isCancelled()) throw cancelledError();
      const coord = agents.get(proc.steps[0].agentId)!;
      const res = await call(0, sys(coord, slug), coordPrompt(ctx), TOKENS.coordinator);
      coordNotes = res.text;
      d.consulted.push({ agentId: coord.id, agentName: coord.config.name, question: 'Análisis del proyecto para la evaluación organizativa', answer: res.text });
      procs.setDelegation(processId, d); idx = 1;
    }
    if (isCancelled()) throw cancelledError();
    const gestor = agents.get(proc.steps[idx].agentId)!;
    const prompt = gestorPrompt(ctx, label, coordNotes, orgCatalog(slug));
    let res = await call(idx, sys(gestor, slug), prompt, TOKENS.gestor);
    let text = res.text;
    for (let i = 0; i < 2 && isTruncated(res.stopReason); i++) {
      if (isCancelled()) throw cancelledError();
      log({ step: STEP_GESTOR, continuation: i + 1 }, 'respuesta cortada: se pide continuación');
      res = await call(idx, sys(gestor, slug), 'Tu respuesta anterior se cortó por el límite de longitud. Continúa EXACTAMENTE desde el último carácter que escribiste, sin repetir nada y manteniendo el formato (si estabas dentro del bloque org, continúa el JSON y ciérralo con ```).', TOKENS.gestor, [{ role: 'user', content: prompt }, { role: 'assistant', content: text }]);
      text += res.text;
    }
    const parsed = parseOrgProposals(text);
    const body = parsed.body + (parsed.truncated ? '\n\n> ⚠ La respuesta se cortó por longitud: se recuperaron las propuestas completas; puede faltar alguna.' : '');
    d.deliverable = body;
    const date = new Date().toISOString().slice(0, 10);
    const participants = [d.consulted[0]?.agentName, gestor.config.name].filter(Boolean).join(' y ');
    const doc = knowledge.add({
      projectId: proc.projectId, title: `Evaluación organizativa · ${scopeName} · ${date}`, authorAgentId: gestor.id, authorAgentName: gestor.config.name, processId,
      body: `# Evaluación organizativa\n**Ámbito:** ${label}\n**Fecha:** ${date}\n**Participantes:** ${participants}\n\n${coordNotes ? `# Análisis del Coordinador\n${coordNotes}\n\n` : ''}# Evaluación del Gestor\n${body}\n\n# Propuestas (${parsed.proposals.length})\n${parsed.proposals.map(proposalLine).join('\n') || '(sin propuestas: la organización se considera adecuada)'}\n\n> Al aceptar una propuesta, el Portal la aplica automáticamente con su configuración y deja disponible «Deshacer»; rechazarla solo registra la decisión. Nada se crea, ajusta ni retira sin la aprobación del propietario.\n\n# Decisiones del propietario`
    });
    d.knowledgeDocId = doc.id; procs.setDelegation(processId, d);
    evals.update(ev.id, { status: 'done', knowledgeDocId: doc.id, summary: summarize(parsed.body), proposals: parsed.proposals, error: null });
  } catch (e: any) {
    finalStatus = e.cancelled ? 'cancelled' : e.budget ? 'budget_exceeded' : 'failed'; finalError = e.message;
    const cur = procs.get(processId)!;
    cur.steps.filter(s => s.status === 'pending' || s.status === 'running').forEach(s => procs.stepFinish(s.id, s.status === 'running' ? 'failed' : 'skipped', { error: s.status === 'running' ? e.message : null }));
  } finally {
    procs.finish(processId, finalStatus, finalError);
    if (finalStatus !== 'done') {
      try { evals.update(ev.id, { status: finalStatus === 'cancelled' ? 'cancelled' : 'failed', error: finalStatus === 'cancelled' ? 'Cancelada por el propietario.' : finalError }); } catch { /* fila ausente */ }
    }
    involved.forEach(id => agents.setStatus(id, 'inactive'));
    log({ processId, status: finalStatus }, 'evaluación organizativa finalizada');
  }
}

/** Evaluación con su proceso; si el proceso terminó sin actualizarla (reinicio del servidor), la sincroniza. */
export function getOrgEvaluation(slug: string, id: string) {
  const evals = orgEvaluationsRepo(slug);
  let ev = evals.get(id);
  if (!ev) throw httpError(404, 'Evaluación no encontrada');
  const proc = ev.processId ? processesRepo(slug).get(ev.processId) : undefined;
  if (ev.status === 'running' && proc && proc.status !== 'running' && proc.status !== 'pending_authorization') {
    const status: OrgEvaluationStatus = proc.status === 'cancelled' ? 'cancelled' : 'failed';
    ev = evals.update(ev.id, { status, error: proc.error ?? 'El proceso terminó sin completar la evaluación.' });
  }
  return {
    ...ev,
    process: proc ? { id: proc.id, status: proc.status, budgetUsd: proc.budgetUsd, estimatedUsd: proc.estimatedUsd, spentUsd: proc.spentUsd, error: proc.error, steps: proc.steps.map(s => ({ title: s.title, agentName: s.agentName, status: s.status })) } : null
  };
}

export function listOrgEvaluations(slug: string, filter: { projectId?: string | null } = {}) {
  return orgEvaluationsRepo(slug).list(filter).map(e => getOrgEvaluation(slug, e.id));
}

/**
 * Decisión del propietario sobre UNA propuesta. Aceptar la aplica (validación previa, transacción, auditoría y
 * deshacer) y solo entonces registra la decisión; si falla, la propuesta sigue pendiente. Rechazar solo registra.
 */
export function decideProposal(slug: string, evalId: string, proposalId: string, decision: Exclude<OrgDecision, 'pending'>, confirmed = false) {
  if (decision === 'accepted') return acceptProposal(slug, evalId, proposalId, confirmed);
  const evals = orgEvaluationsRepo(slug);
  const cur = evals.get(evalId);
  if (!cur) throw httpError(404, 'Evaluación no encontrada');
  if (cur.status !== 'done') throw httpError(409, 'La evaluación aún no ha terminado.', 'not_finished');
  const r = evals.setProposalDecision(evalId, proposalId, decision, 'owner');
  if (cur.knowledgeDocId) {
    const p = r.proposal;
    const line = `\n- ${p.decidedAt?.slice(0, 16).replace('T', ' ')} · ${p.id} · Rechazada: ${ORG_ACTION_LABEL[p.action]} ${ORG_TARGET_LABEL[p.target]} «${p.subject}». Sin cambios en la organización.`;
    workspaceDb(slug).prepare(`UPDATE knowledge SET body = body || ? WHERE id = ?`).run(line, cur.knowledgeDocId);
  }
  return r;
}

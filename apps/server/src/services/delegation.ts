import type { Agent, AssessmentEstimate, BacklogItem, BacklogOp, DelegationResult, ModelInfo, Process, ProviderId } from '@portal-ia/domain';
import { costUsd, estimatePricing, estimateTokens, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo, workspacesRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, knowledgeRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';
import { requirePolicy } from './executionPolicy.ts';
import { buildRepoContext } from './repoContext.ts';
import { addManualItem, resetStory } from './backlog.ts';
import { phaseContext } from './operationalPhase.ts';

/**
 * Encargos delegados: el Asistente (o el propietario) encarga una tarea a un agente responsable —revisar y replantear
 * el backlog, redactar una propuesta organizativa, evaluar una idea, etc.— y ese agente la valida, consulta a los
 * agentes a su cargo si lo necesita y entrega un resultado (Conocimiento) con propuestas de cambio al backlog que el
 * propietario aplica con un clic. No todo se resuelve con historias de desarrollo: esto es el resto del trabajo.
 */
const MAX_CONSULTS = 3;
const TOKENS = { triage: 2000, consult: 3000, synthesis: 12000 } as const;
const isTruncated = (stop: string | null) => stop === 'max_tokens' || stop === 'length';

/**
 * Extrae las propuestas al backlog de un entregable: bloque ```backlog (o ```json con objetos {op}), cerrado o no.
 * Si el JSON llegó cortado, recupera los objetos completos y señala el corte. Devuelve también el texto sin el bloque.
 */
export function extractBacklogOps(text: string): { ops: BacklogOp[]; body: string; truncated: boolean } {
  const re = /```(\w*)[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*```|$(?![\s\S]))/g; // cualquier cerca; se filtra por nombre o contenido
  let m: RegExpExecArray | null; let found: { start: number; end: number; raw: string; closed: boolean } | null = null;
  while ((m = re.exec(text))) {
    if (!m[0].length) { re.lastIndex++; continue; }
    const lang = (m[1] ?? '').toLowerCase(); const raw = m[2]; const closed = /```\s*$/.test(m[0]);
    if (lang === 'backlog' || ((lang === 'json' || lang === '') && /^\s*\[\s*\{\s*"op"\s*:/.test(raw))) { found = { start: m.index, end: m.index + m[0].length, raw, closed }; if (lang === 'backlog') break; }
  }
  if (!found) return { ops: [], body: text.trim(), truncated: false };
  let ops: any[] = []; let truncated = !found.closed;
  try { const v = JSON.parse(found.raw); ops = Array.isArray(v) ? v : []; }
  catch {
    truncated = true;
    // Recuperar objetos completos de un array cortado: equilibrio de llaves fuera de cadenas.
    const src = found.raw; let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') { if (depth === 0) start = i; depth++; }
      else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { try { ops.push(JSON.parse(src.slice(start, i + 1))); } catch { /* objeto ilegible */ } start = -1; } }
    }
  }
  const valid = ops.filter((o: any) => o && typeof o.op === 'string' && ['add', 'update', 'discard', 'merge', 'reprioritize'].includes(o.op)) as BacklogOp[];
  const body = (text.slice(0, found.start) + text.slice(found.end)).trim();
  return { ops: valid, body, truncated };
}

/** Procesos antiguos: si el entregable aún contiene el bloque de propuestas sin extraer, lo extrae y lo persiste. */
export function ensureOpsParsed(slug: string, proc: Process): Process {
  const d = proc.delegation;
  if (!d || d.backlogOps.length || !d.deliverable || !/```(backlog|json)/i.test(d.deliverable)) return proc;
  const { ops, body, truncated } = extractBacklogOps(d.deliverable);
  if (!ops.length) return proc;
  d.backlogOps = ops; d.deliverable = body + (truncated ? '\n\n> ⚠ La respuesta se cortó por longitud: se recuperaron las propuestas completas; puede faltar alguna.' : '');
  processesRepo(slug).setDelegation(proc.id, d);
  return processesRepo(slug).get(proc.id)!;
}

export function pickLeadAgent(slug: string, projectId: string | null, ref: any): Agent {
  const all = agentsRepo(slug).list();
  const r = String(ref ?? '').trim().toLowerCase();
  const inScope = all.filter(a => a.scope === 'workspace' || !projectId || a.projectId === projectId);
  if (r) {
    const hit = inScope.find(a => a.key.toLowerCase() === r || a.id === r) ?? inScope.find(a => a.config.name.toLowerCase() === r) ?? inScope.find(a => a.template.role.toLowerCase() === r) ?? inScope.find(a => a.config.name.toLowerCase().includes(r) || a.template.role.toLowerCase().includes(r));
    if (hit) return hit;
  }
  // Por defecto: el Coordinador del proyecto si hay proyecto; si no, el Gestor Organizacional.
  const def = (projectId ? inScope.find(a => a.key === 'pj-coordinador' && a.projectId === projectId) : undefined) ?? inScope.find(a => a.key === 'ws-gestor') ?? inScope.find(a => a.key !== 'ws-asistente');
  if (!def) throw Object.assign(new Error('No hay un agente responsable disponible para este encargo.'), { statusCode: 409 });
  return def;
}

/** Agentes bajo el mando del responsable (relación reportsTo real, incluidos agentes personalizados). */
export function teamOf(slug: string, lead: Agent): Agent[] {
  return agentsRepo(slug).list().filter(a => a.id !== lead.id && a.template.reportsTo === lead.key && a.key !== 'ws-asistente' && (lead.scope === 'workspace' || a.scope === 'workspace' || a.projectId === lead.projectId));
}

function contextFor(slug: string, projectId: string | null): string {
  const ws = workspacesRepo.get(slug)!; const projects = projectsRepo(slug); const agents = agentsRepo(slug).list();
  const lines: string[] = [`# Empresa «${ws.name}»`];
  lines.push(`Agentes de espacio: ${agents.filter(a => a.scope === 'workspace').map(a => `${a.config.name} (${a.template.role}, clave ${a.key})`).join('; ')}`);
  const list = projectId ? projects.list().filter(p => p.id === projectId) : projects.list();
  for (const p of list) {
    const bl = backlogRepo(slug).list(p.id); const docs = knowledgeRepo(slug).list(p.id); const repo = projects.repository(p.id);
    lines.push(`\n## Proyecto «${p.name}»\n${p.description}\nObjetivos: ${projects.objectives(p.id).map(o => o.text).join(' · ') || '—'}`);
    lines.push(`Equipo: ${agents.filter(a => a.projectId === p.id).map(a => `${a.config.name} (${a.template.role}, clave ${a.key}, reporta a ${a.template.reportsTo})`).join('; ') || '—'}`);
    const phase = phaseContext(slug, p.id, projectId ? 16000 : 4000); if (phase) lines.push(phase);
    lines.push(`Backlog activo (${bl.length}):\n${bl.map(b => `- ${b.storyId} [${b.status}]${b.estimate ? ` (${b.estimate})` : ''}${b.dependsOn ? ` depende de ${b.dependsOn}` : ''} ${b.title}${b.criterion ? ` — criterio: ${b.criterion.slice(0, 220)}` : ''}${b.description ? ` — ${b.description.slice(0, 200)}` : ''}`).join('\n') || '(vacío)'}`);
    lines.push(`Conocimiento (${docs.length}): ${docs.map(d => `«${d.title}» (${d.authorAgentName}, ${d.createdAt.slice(0, 10)})`).join('; ') || '—'}`);
    if (repo && projectId) { try { const ctx = buildRepoContext(repo.path, 20_000); lines.push(`Repositorio ${repo.path} (rama ${repo.branch ?? '?'}):\n\`\`\`\n${ctx.tree.slice(0, 6000)}\n\`\`\``); } catch { /* sin árbol */ } }
  }
  return lines.join('\n');
}

function sys(agent: Agent, slug: string): string {
  const ws = workspacesRepo.get(slug)!;
  return `Eres «${agent.config.name}», ${agent.template.role.toLowerCase()} en la empresa «${ws.name}» dentro de Portal IA (plataforma local donde empresas son operadas por equipos de agentes de IA bajo la autoridad del propietario).
Especialización: ${agent.config.specialization}
Responsabilidades: ${agent.config.responsibilities.map(r => '- ' + r).join('\n')}
Trabajas en español, con criterio profesional y sin inventar datos: usa solo el estado real que se te da. Si algo no procede o falta información, dilo con claridad.`;
}

function extractJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const c of [fenced, text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[]) { try { return JSON.parse(c); } catch { /* siguiente */ } }
  return null;
}

export function estimateDelegation(slug: string, projectId: string | null, agentRef: any, request: string): AssessmentEstimate & { leadAgentId: string; teamSize: number } {
  const lead = pickLeadAgent(slug, projectId, agentRef);
  const team = teamOf(slug, lead).slice(0, MAX_CONSULTS);
  const ctxTok = estimateTokens(contextFor(slug, projectId) + request) + 600;
  const price = (a: Agent, inTok: number, outTok: number) => { const p = estimatePricing(a.config.provider, a.config.model); const think = a.config.effort === 'high' ? 6000 : a.config.effort === 'medium' ? 2500 : 0; return (inTok * p.inPerM + (outTok + think) * p.outPerM) / 1_000_000; };
  const steps = [
    { agentId: lead.id, agentName: lead.config.name, title: 'Validación y plan del encargo', model: lead.config.model, estimatedUsd: price(lead, ctxTok, TOKENS.triage) },
    ...team.map(a => ({ agentId: a.id, agentName: a.config.name, title: `Consulta a ${a.config.name}`, model: a.config.model, estimatedUsd: price(a, ctxTok, TOKENS.consult) })),
    { agentId: lead.id, agentName: lead.config.name, title: 'Entregable y propuestas', model: lead.config.model, estimatedUsd: price(lead, ctxTok + team.length * TOKENS.consult, TOKENS.synthesis) }
  ];
  const estimatedUsd = steps.reduce((a, s) => a + s.estimatedUsd, 0);
  return { steps, estimatedUsd, suggestedBudgetUsd: Math.max(0.5, Math.ceil(estimatedUsd * 2 * 2) / 2), leadAgentId: lead.id, teamSize: team.length } as any;
}

export function createDelegation(slug: string, projectId: string | null, agentRef: any, request: string): Process {
  const req = request.trim();
  if (req.length < 8) throw Object.assign(new Error('Describe el encargo con más detalle.'), { statusCode: 400 });
  const est = estimateDelegation(slug, projectId, agentRef, req);
  const lead = agentsRepo(slug).get(est.leadAgentId)!;
  const pid = projectId ?? projectsRepo(slug).list()[0]?.id ?? '';
  const proc = processesRepo(slug).create({ projectId: pid, kind: 'delegated_task', title: `Encargo a ${lead.config.name}: ${req.slice(0, 90)}${req.length > 90 ? '…' : ''}`, estimatedUsd: est.estimatedUsd, steps: est.steps.map(s => ({ agentId: s.agentId, agentName: s.agentName, title: s.title, model: s.model })) });
  const d: DelegationResult = { request: req, leadAgentId: lead.id, leadAgentName: lead.config.name, triage: null, consulted: [], deliverable: null, knowledgeDocId: null, backlogOps: [], opsApplied: null };
  processesRepo(slug).setDelegation(proc.id, d);
  return processesRepo(slug).get(proc.id)!;
}

export async function runDelegation(slug: string, processId: string, log: (o: any, m: string) => void, isCancelled: () => boolean) {
  const procs = processesRepo(slug); const agents = agentsRepo(slug); const knowledge = knowledgeRepo(slug);
  const proc = procs.get(processId)!; const d = proc.delegation!;
  const lead = agents.get(d.leadAgentId)!;
  const projectId = lead.scope === 'project' ? lead.projectId : proc.projectId || null;
  const ctx = contextFor(slug, projectId);
  const involved = Array.from(new Set(proc.steps.map(s => s.agentId)));
  involved.forEach(id => agents.setStatus(id, 'active'));
  let finalStatus: Process['status'] = 'done'; let finalError: string | null = null;

  const call = async (stepIdx: number, system: string, user: string, maxTokens: number, history?: { role: 'user' | 'assistant'; content: string }[]) => {
    const step = proc.steps[stepIdx]; const agent = agents.get(step.agentId)!;
    const providerId = agent.config.provider as ProviderId;
    const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
    if (!cred || prow.status !== 'connected') throw new Error(`El proveedor ${providerId} no está conectado.`);
    const models: ModelInfo[] = JSON.parse(prow.models_json);
    const cur = procs.get(processId)!; const p = estimatePricing(providerId, agent.config.model);
    const stepEst = (estimateTokens(system + user) * p.inPerM + maxTokens * p.outPerM) / 1_000_000;
    if (cur.spentUsd + stepEst * 0.5 > cur.budgetUsd) throw Object.assign(new Error(`Presupuesto insuficiente para «${step.title}» (gastado ${cur.spentUsd.toFixed(2)} de ${cur.budgetUsd.toFixed(2)} USD).`), { budget: true });
    procs.stepStart(step.id); const startedAt = new Date().toISOString();
    try {
      requirePolicy('ai_call', { slug, processId, agentId: agent.id, projectId: proc.projectId, authorized: true });
      const res = await getAdapter(providerId)!.complete(decryptSecret(cred.ciphertext), { workspaceId: prow.workspace_id }, { model: agent.config.model, system, user, maxTokens, effort: agent.config.effort, supportsEffort: !!models.find(m => m.id === agent.config.model)?.supportsEffort, history });
      const cost = costUsd(providerId, agent.config.model, res.inputTokens, res.outputTokens);
      const prev = procs.get(processId)!.steps[stepIdx]; const acc = history?.length ? prev : { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      procs.stepFinish(step.id, 'done', { tokensIn: acc.inputTokens + res.inputTokens, tokensOut: acc.outputTokens + res.outputTokens, cost: acc.costUsd + cost, outputMd: history?.length ? `${history.filter(h => h.role === 'assistant').map(h => h.content).join('')}${res.text}` : res.text });
      procs.addUsage(processId, res.inputTokens, res.outputTokens, cost);
      procs.logExecution({ projectId: proc.projectId, agentId: agent.id, kind: 'delegated_step', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
      log({ step: step.title, tokens: res.inputTokens + res.outputTokens, cost: cost.toFixed(4) }, 'paso completado');
      return res;
    } catch (e) {
      const err = e instanceof ProviderRequestError ? e.error : null; let msg = err ? err.message : (e as Error).message;
      const maybeBilled = !err || err.code === 'network' || (err.httpStatus ?? 0) >= 500;
      const estIn = maybeBilled ? estimateTokens(system + user) : 0; const estCost = maybeBilled ? costUsd(providerId, agent.config.model, estIn, 0) : 0;
      if (maybeBilled) msg += ` Costo estimado de la entrada enviada: ${estCost.toFixed(4)} USD (sin confirmación del proveedor).`;
      procs.stepFinish(step.id, 'failed', { tokensIn: estIn, cost: estCost, error: msg }); if (maybeBilled) procs.addUsage(processId, estIn, 0, estCost);
      procs.logExecution({ projectId: proc.projectId, agentId: agent.id, kind: 'delegated_step', status: 'failed', tokensIn: estIn, tokensOut: 0, cost: estCost, startedAt });
      throw new Error(msg);
    }
  };

  const team = teamOf(slug, lead).slice(0, MAX_CONSULTS);
  const consultSteps = proc.steps.slice(1, -1); // uno por miembro del equipo, en el mismo orden
  try {
    // 1 · Validación y plan
    if (isCancelled()) throw Object.assign(new Error('cancelado'), { cancelled: true });
    const triRes = await call(0, sys(lead, slug), `El propietario te hace este encargo a través del Asistente:
«${d.request}»

Tu equipo directo (puedes consultar hasta ${team.length} de ellos, una pregunta concreta a cada uno): ${team.map(a => `${a.config.name} (${a.template.role}, clave ${a.key})`).join('; ') || 'ninguno'}

# Estado real
${ctx}

Valida el encargo: ¿procede, está dentro de tu ámbito, hay información suficiente? Decide qué necesitas de tu equipo (solo si aporta de verdad; puedes no consultar a nadie).
Responde SOLO con JSON: {"accepted": boolean, "rejectionReason": string|null, "understanding": string (2-4 frases: cómo entiendes el encargo y qué entregarás), "plan": string[] (pasos), "consults": [{"agentKey": string, "question": string}] (máx ${team.length})}`, TOKENS.triage);
    const tri = extractJson(triRes.text);
    d.triage = { accepted: tri ? tri.accepted !== false : true, understanding: String(tri?.understanding ?? triRes.text.slice(0, 600)), rejectionReason: tri?.rejectionReason ? String(tri.rejectionReason) : null, plan: Array.isArray(tri?.plan) ? tri.plan.map(String) : [] };
    procs.setDelegation(processId, d);
    if (!d.triage.accepted) {
      consultSteps.forEach(s => procs.stepFinish(s.id, 'skipped', {})); procs.stepFinish(proc.steps.at(-1)!.id, 'skipped', {});
      d.deliverable = `**El responsable no aceptó el encargo.** ${d.triage.rejectionReason ?? ''}\n\n${d.triage.understanding}`;
      procs.setDelegation(processId, d);
    } else {
      // 2 · Consultas al equipo (solo las que pidió el responsable)
      const wanted: { agentKey: string; question: string }[] = Array.isArray(tri?.consults) ? tri.consults.filter((c: any) => c && c.agentKey && c.question) : [];
      for (let i = 0; i < consultSteps.length; i++) {
        const member = team[i]; const step = consultSteps[i];
        const q = wanted.find(w => String(w.agentKey).toLowerCase() === member.key.toLowerCase() || String(w.agentKey).toLowerCase() === member.config.name.toLowerCase());
        if (!q) { procs.stepFinish(step.id, 'skipped', {}); continue; }
        if (isCancelled()) throw Object.assign(new Error('cancelado'), { cancelled: true });
        const ans = await call(i + 1, sys(member, slug), `Tu responsable, ${lead.config.name}, trabaja en este encargo del propietario: «${d.request}».
Te pregunta: ${q.question}

# Estado real
${ctx}

Responde en markdown breve y útil (máx. 500 palabras), con recomendaciones concretas y sin inventar datos.`, TOKENS.consult);
        d.consulted.push({ agentId: member.id, agentName: member.config.name, question: q.question, answer: ans.text });
        procs.setDelegation(processId, d);
      }
      // 3 · Entregable y propuestas
      if (isCancelled()) throw Object.assign(new Error('cancelado'), { cancelled: true });
      const synPrompt = `Encargo del propietario: «${d.request}»
Tu validación previa: ${d.triage.understanding}
${d.consulted.length ? `# Aportaciones de tu equipo\n${d.consulted.map(c => `## ${c.agentName} — pregunta: ${c.question}\n${c.answer}`).join('\n\n')}` : ''}

# Estado real
${ctx}

Entrega el resultado del encargo en markdown claro y conciso para el propietario (diagnóstico, decisiones, qué cambia; máx. ~900 palabras). Si el encargo implica cambios en el backlog (replantear, fusionar, descartar, repriorizar, añadir), NO los apliques: propónlos al final en UN bloque \`\`\`backlog con un array JSON de operaciones (máx. 30; "reason" en una frase), usando exactamente estos formatos:
{"op":"add","title":string,"criterion":string,"description":string,"estimate":"S"|"M"|"L","dependsOn":"HU-xxx"|null,"reason":string}
{"op":"update","story":"HU-xxx","title"?:string,"criterion"?:string,"description"?:string,"estimate"?:"S"|"M"|"L","dependsOn"?:"HU-xxx"|null,"reason":string}
{"op":"discard","story":"HU-xxx","reason":string}
{"op":"merge","into":"HU-xxx","from":["HU-yyy"],"title"?:string,"criterion"?:string,"reason":string}
{"op":"reprioritize","order":["HU-xxx", ...] (ids en el nuevo orden, solo los que cambian de sitio o todos),"reason":string}
Usa solo ids de historias que existen en el estado real. Cierra el bloque con \`\`\`. Si no hay cambios al backlog, omite el bloque.`;
      let synRes = await call(proc.steps.length - 1, sys(lead, slug), synPrompt, TOKENS.synthesis);
      let synText = synRes.text;
      for (let i = 0; i < 2 && isTruncated(synRes.stopReason); i++) {
        if (isCancelled()) throw Object.assign(new Error('cancelado'), { cancelled: true });
        log({ step: 'Entregable', continuation: i + 1 }, 'respuesta cortada: se pide continuación');
        synRes = await call(proc.steps.length - 1, sys(lead, slug), 'Tu respuesta anterior se cortó por el límite de longitud. Continúa EXACTAMENTE desde el último carácter que escribiste, sin repetir nada, sin saludos, manteniendo el formato (si estabas dentro del bloque backlog, continúa el JSON y ciérralo con ```).', TOKENS.synthesis, [{ role: 'user', content: synPrompt }, { role: 'assistant', content: synText }]);
        synText += synRes.text;
      }
      const ex = extractBacklogOps(synText);
      const ops = ex.ops;
      d.deliverable = ex.body + (ex.truncated ? '\n\n> ⚠ La respuesta se cortó por longitud: se recuperaron las propuestas completas; puede faltar alguna.' : '');
      d.backlogOps = ops;
      const doc = knowledge.add({ projectId: proc.projectId, title: `Encargo · ${d.request.slice(0, 70)}${d.request.length > 70 ? '…' : ''}`, body: `# Encargo\n${d.request}\n\n# Responsable\n${lead.config.name}\n\n${d.consulted.length ? `# Consultas al equipo\n${d.consulted.map(c => `## ${c.agentName}\n**Pregunta:** ${c.question}\n\n${c.answer}`).join('\n\n')}\n\n` : ''}# Entregable\n${d.deliverable}${ops.length ? `\n\n# Propuestas al backlog (${ops.length})\n${ops.map(o => '- ' + JSON.stringify(o)).join('\n')}` : ''}`, authorAgentId: lead.id, authorAgentName: lead.config.name, processId });
      d.knowledgeDocId = doc.id;
      procs.setDelegation(processId, d);
    }
  } catch (e: any) {
    finalStatus = e.cancelled ? 'cancelled' : e.budget ? 'budget_exceeded' : 'failed'; finalError = e.message;
    const cur = procs.get(processId)!; cur.steps.filter(s => s.status === 'pending' || s.status === 'running').forEach(s => procs.stepFinish(s.id, s.status === 'running' ? 'failed' : 'skipped', { error: s.status === 'running' ? e.message : null }));
  } finally {
    procs.finish(processId, finalStatus, finalError);
    involved.forEach(id => agents.setStatus(id, 'inactive'));
    log({ processId, status: finalStatus }, 'encargo finalizado');
  }
}

/** Aplica las operaciones propuestas al backlog (acción local, con aprobación explícita del propietario). */
export function applyBacklogOps(slug: string, processId: string): DelegationResult {
  const procs = processesRepo(slug); const proc = procs.get(processId);
  if (!proc?.delegation) throw Object.assign(new Error('Encargo no encontrado'), { statusCode: 404 });
  const d = proc.delegation; if (d.opsApplied) throw Object.assign(new Error('Las propuestas ya se aplicaron.'), { statusCode: 409 });
  const repo = backlogRepo(slug); const list = () => repo.list(proc.projectId);
  const find = (ref: string) => { const r = String(ref).trim().toLowerCase(); const n = parseInt(r.replace(/\D+/g, ''), 10); return list().find(b => b.storyId.toLowerCase() === r) ?? (Number.isFinite(n) ? list().find(b => parseInt(b.storyId.replace(/\D+/g, ''), 10) === n) : undefined); };
  const summary: string[] = [];
  for (const op of d.backlogOps) {
    try {
      if (op.op === 'add') { const it = addManualItem(slug, proc.projectId, { title: op.title, criterion: op.criterion, description: [op.description, op.reason ? `Motivo: ${op.reason}` : ''].filter(Boolean).join('\n'), ownerKey: op.ownerKey ?? undefined, estimate: op.estimate ?? null }); if (op.dependsOn) repo.update(it.id, { dependsOn: op.dependsOn }); summary.push(`${it.storyId} añadida: ${it.title}`); }
      else if (op.op === 'update') {
        const it = find(op.story); if (!it) throw new Error(`${op.story} no existe`); const patch: any = {}; for (const k of ['title', 'criterion', 'description', 'ownerKey', 'estimate', 'dependsOn'] as const) if (op[k] !== undefined) patch[k] = op[k]; repo.update(it.id, patch);
        // Replantear una historia que estaba en revisión (con un diff pendiente) la devuelve a pendiente: el diff anterior queda superado.
        const reformulated = (op.title !== undefined && op.title !== it.title) || (op.criterion !== undefined && op.criterion !== it.criterion);
        if (reformulated && (it.status === 'review' || it.status === 'blocked')) { resetStory(slug, it.id, `replanteada por encargo: ${op.reason ?? 'nuevo alcance'}`); summary.push(`${it.storyId} actualizada y devuelta a pendiente (el diff anterior queda superado)${op.reason ? ` — ${op.reason}` : ''}`); }
        else summary.push(`${it.storyId} actualizada${op.reason ? ` (${op.reason})` : ''}`);
      }
      else if (op.op === 'discard') { const it = find(op.story); if (!it) throw new Error(`${op.story} no existe`); if (it.status === 'in_progress') throw new Error(`${it.storyId} está en ejecución`); repo.update(it.id, { description: `${it.description ? it.description + '\n' : ''}Descartada: ${op.reason}` }); repo.setStatus(it.id, 'discarded'); summary.push(`${it.storyId} descartada: ${op.reason}`); }
      else if (op.op === 'merge') { const into = find(op.into); if (!into) throw new Error(`${op.into} no existe`); const from = op.from.map(f => find(f)).filter(Boolean) as BacklogItem[]; repo.update(into.id, { title: op.title ?? into.title, criterion: op.criterion ?? into.criterion, description: `${into.description ? into.description + '\n' : ''}Incluye: ${from.map(f => `${f.storyId} (${f.title})`).join(', ')}` }); for (const f of from) { if (f.status !== 'in_progress') { repo.update(f.id, { description: `${f.description ? f.description + '\n' : ''}Fusionada en ${into.storyId}` }); repo.setStatus(f.id, 'discarded'); } } summary.push(`${from.map(f => f.storyId).join(', ')} fusionadas en ${into.storyId}`); }
      else if (op.op === 'reprioritize') { const items = op.order.map(o => find(o)).filter(Boolean) as BacklogItem[]; const positions = items.map(i => i.position).sort((a, b) => a - b); items.forEach((it, i) => repo.setPosition(it.id, positions[i])); summary.push(`Reordenadas ${items.length} historias`); }
    } catch (e: any) { summary.push(`✖ ${op.op}: ${e.message}`); }
  }
  d.opsApplied = { at: new Date().toISOString(), summary };
  procs.setDelegation(processId, d);
  return d;
}

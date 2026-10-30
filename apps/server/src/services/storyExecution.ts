import { agentCaller, completeWith } from './claudeCode/backend.ts';
import type { Agent, AssessmentEstimate, BacklogItem, DevOutputAssessment, ExecutionResult, ModelInfo, Process, ProcessStep, ProviderId, ReviewVerdict, RuntimeCheck, StoryPlan, TeamOverride, TeamRole } from '@portal-ia/domain';
import { composeTeam, orderedMembers, type StoryText } from './teamComposer.ts';
import { injectLessons, recordDetections } from './lessons.ts';
import { practicesFor } from './agentTemplates.ts';
import { costUsd, estimatePricing, estimateTokens, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, knowledgeRepo, processesRepo, projectsRepo, workspaceDb } from '../db/workspace.ts';
import { decisionsFromProcess } from './inbox.ts';
import { activeAgents } from './activeAgents.ts';
import { decryptSecret } from '../security/crypto.ts';
import { requirePolicy } from './executionPolicy.ts';
import { currentPhase, phaseContext } from './operationalPhase.ts';
import { buildRepoContext } from './repoContext.ts';
import { annotateChanges, fileChangedSince, readRepoFile, type RawChange } from './repoWrite.ts';
import { DEV_MAX_TOKENS, FILE_FORMAT, sys } from './storyPrompts.ts';
import { assessDeveloperOutput, failureClassOf, mergeChanges, type ParsedDevOutput } from './devOutput.ts';
import { callAgentStep, implementerOutputs, isTruncatedStop, newPipeline, pausePipeline, PipelinePause, providerPause, runPipelineStages, settleImplementation, StoryFailure, updateResult, type StoryRunCtx } from './storyPipeline.ts';
export { parseFileBlocks, parseRuntimeChecks } from './devOutput.ts';
import path from 'node:path';
import { INTERNAL_WORKSPACE } from '@portal-ia/domain';
import { REPO_ROOT } from '../config.ts';
import { expandHome } from '../routes/fs.ts';

/**
 * HU-005 · Ejecución de una historia del backlog.
 * Tres pasos reales (Coordinador planifica → Desarrollador implementa → QA revisa) dentro de un presupuesto autorizado.
 * El resultado son CAMBIOS PROPUESTOS con diff. Nada se escribe en el repositorio hasta que el usuario los aprueba
 * (repoWrite.applyChanges), y la verificación local también requiere autorización por uso.
 */
export interface StoryOptions { skipQa?: boolean; override?: TeamOverride | null; iterationContext?: string | null; gauntlet?: boolean }
const MAX_TOKENS: Record<TeamRole, number> = { planner: 2500, consultant: 2500, implementer: 16000, reviewer: 6000, evaluator: 6000 };
const TITLES: Record<TeamRole, (name: string) => string> = { planner: () => 'Plan técnico de la historia', consultant: n => `Consulta: ${n}`, implementer: () => 'Implementación (cambios propuestos)', reviewer: () => 'Revisión de calidad', evaluator: () => 'Evaluación Gauntlet (independiente)' };

/** Pasos de la historia a partir del equipo compuesto por capacidades (M3). Sin IA. */
function stepPlanFor(agents: Agent[], projectId: string, story: StoryText, opts: StoryOptions = {}) {
  const team = composeTeam(agents, projectId, story, { skipQa: opts.skipQa, override: opts.override ?? null, gauntlet: opts.gauntlet });
  const byId = new Map(agents.map(a => [a.id, a]));
  const missing = (['planner', 'implementer'] as TeamRole[]).filter(r => !team.members.some(m => m.role === r));
  if (missing.length) throw Object.assign(new Error(`Faltan agentes con capacidad para ${missing.map(r => r === 'planner' ? 'planificar' : 'implementar (con herramienta write_repo)').join(' y ')} en este proyecto. ${team.excluded.map(e => `${e.agentName}: ${e.reason}`).join(' · ')}`), { statusCode: 409 });
  const steps = orderedMembers(team).map(m => ({ agent: byId.get(m.agentId)!, title: TITLES[m.role](m.agentName), maxTokens: MAX_TOKENS[m.role], role: m.role, reason: m.reason }));
  return { steps, team };
}
/** Paso por papel (procesos antiguos sin `role`: por posición). */
export function stepByRole(proc: Process, role: TeamRole): ProcessStep | undefined {
  const byRole = proc.steps.find(s => s.role === role);
  if (byRole || proc.steps.some(s => s.role)) return byRole;
  const legacy: Record<TeamRole, number> = { planner: 0, implementer: 1, reviewer: 2, consultant: -1, evaluator: -1 };
  return legacy[role] >= 0 ? proc.steps[legacy[role]] : undefined;
}

/** Lista de textos a partir de lo que devuelva el modelo: un texto suelto, objetos con ruta/texto o valores sueltos. */
export function asStrings(v: unknown, max = Infinity): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return arr.map(x => typeof x === 'string' ? x : x && typeof x === 'object' ? String((x as any).path ?? (x as any).file ?? (x as any).ruta ?? (x as any).text ?? (x as any).title ?? (x as any).description ?? JSON.stringify(x)) : x == null ? '' : String(x)).map(s => s.trim()).filter(Boolean).slice(0, max);
}
/** «`apps/x.ts` (nuevo)», «- apps/x.ts: crear…» → «apps/x.ts». */
const planPath = (s: string) => s.trim().replace(/^[-*•\s`'"]+/, '').split(/\s+/)[0].replace(/[`'",;:)]+$/, '').replace(/\\/g, '/').replace(/^\.\//, '');
/**
 * Plan del Coordinador normalizado SIN perder nada en silencio: los archivos a cambiar y los criterios de aceptación se
 * conservan todos (antes se recortaban a 10 y 12); el exceso se detecta después y se explica, no se descarta.
 */
export function planFrom(j: any, fallbackSummary: string): StoryPlan {
  const deliverables = (Array.isArray(j?.deliverables) ? j.deliverables : []).map((d: any) => typeof d === 'string' ? { path: d } : d).filter((d: any) => d && typeof (d.path ?? d.file ?? d.ruta) === 'string')
    .map((d: any) => ({ path: planPath(String(d.path ?? d.file ?? d.ruta)), purpose: String(d.purpose ?? d.proposito ?? '').slice(0, 300), kind: ['code', 'test', 'docs', 'config'].includes(d.kind) ? d.kind : undefined, estimatedLines: Number.isFinite(Number(d.estimatedLines)) ? Number(d.estimatedLines) : undefined })).filter((d: any) => d.path);
  return { summary: String(j?.summary ?? fallbackSummary), tasks: asStrings(j?.tasks, 40), filesToRead: asStrings(j?.filesToRead, 8).map(planPath).filter(Boolean), filesToChange: Array.from(new Set(asStrings(j?.filesToChange).map(planPath).filter(Boolean))), acceptance: asStrings(j?.acceptance), risks: asStrings(j?.risks, 20), ...(deliverables.length ? { deliverables } : {}) };
}
const planHasFiles = (p: StoryPlan) => p.filesToChange.length > 0 || (p.deliverables?.length ?? 0) > 0;

function extractJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[];
  for (const c of candidates) { try { return JSON.parse(c); } catch { /* siguiente */ } }
  return null;
}

/** Lee el veredicto de QA; si el JSON llegó cortado (max_tokens) rescata lo legible y lo señala. */
export function parseReview(text: string, stopReason: string | null): ReviewVerdict {
  const j = extractJson(text);
  if (j && typeof j === 'object') return { approve: !!j.approve, summary: String(j.summary ?? '').trim() || text.slice(0, 800), issues: Array.isArray(j.issues) ? j.issues.map(String) : [], suggestedTests: Array.isArray(j.suggestedTests) ? j.suggestedTests.map(String) : [] };
  const str = (k: string) => text.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"?`))?.[1]?.replace(/\\"/g, '"').replace(/\\n/g, ' ') ?? '';
  const arr = (k: string) => Array.from(text.slice(text.indexOf(`"${k}"`)).matchAll(/"((?:[^"\\]|\\.)*)"/g)).map(m => m[1]).slice(1, 9);
  const truncated = stopReason === 'max_tokens' || stopReason === 'length';
  const summary = str('summary') || text.replace(/[{}"\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800);
  return { approve: /"approve"\s*:\s*true/.test(text), summary: `${summary}${truncated ? ' (La respuesta de QA se cortó por el límite de salida; se muestra lo recibido.)' : ''}`, issues: text.includes('"issues"') ? arr('issues') : [], suggestedTests: text.includes('"suggestedTests"') ? arr('suggestedTests') : [] };
}

/**
 * Comprobación previa (sin IA ni costo): el proyecto interno «Desarrollo del Portal» debe tener registrada la carpeta
 * desde la que corre este Portal. Si apunta a otra carpeta, los agentes construirían un proyecto paralelo que nunca
 * llegaría a este Portal: se detiene aquí, con la corrección a un clic en el Panel. (PORTAL_ALLOW_FOREIGN_REPO=1 lo permite.)
 */
export function preflightRepo(slug: string, repoPath: string) {
  if (slug !== INTERNAL_WORKSPACE.slug || process.env.PORTAL_ALLOW_FOREIGN_REPO === '1') return;
  const a = path.resolve(expandHome(repoPath)).toLowerCase(); const b = path.resolve(REPO_ROOT).toLowerCase();
  if (a !== b) throw Object.assign(new Error(`El repositorio registrado del proyecto interno (${repoPath}) no es la carpeta desde la que corre este Portal (${REPO_ROOT}). Las mejoras del Portal deben hacerse sobre su propio código: en el Panel, pulsa «Usar la carpeta de esta instalación» y vuelve a intentarlo.`), { statusCode: 409, code: 'foreign_repo' });
}

export function estimateStory(slug: string, projectId: string, itemId: string, opts: StoryOptions = {}): AssessmentEstimate {
  const item = backlogRepo(slug).get(itemId);
  if (!item || item.projectId !== projectId) throw Object.assign(new Error('Historia no encontrada'), { statusCode: 404 });
  const repo = projectsRepo(slug).repository(projectId);
  if (!repo) throw Object.assign(new Error('Registra el repositorio del proyecto antes de ejecutar historias.'), { statusCode: 409 });
  preflightRepo(slug, repo.path);
  const ctxChars = buildRepoContext(repo.path, 60_000).totalChars;
  const agents = agentsRepo(slug).list();
  const { steps: plan, team } = stepPlanFor(agents, projectId, item, opts);
  const steps = plan.map(s => {
    const p = estimatePricing(s.agent.config.provider, s.agent.config.model);
    const inTok = Math.ceil(ctxChars / 3.5) + 2000 + (s.role === 'implementer' ? 20000 : s.role === 'reviewer' ? 12000 : 0);
    const outTok = s.maxTokens * (s.role === 'implementer' ? 0.7 : 0.6) + (s.agent.config.effort === 'high' ? 6000 : s.agent.config.effort === 'medium' ? 2500 : 0);
    return { agentId: s.agent.id, agentName: s.agent.config.name, title: s.title, model: s.agent.config.model, estimatedUsd: (inTok * p.inPerM + outTok * p.outPerM) / 1_000_000, role: s.role, reason: s.reason };
  });
  const estimatedUsd = steps.reduce((a, s) => a + s.estimatedUsd, 0);
  return { steps, team, contextChars: ctxChars, estimatedUsd, suggestedBudgetUsd: Math.max(0.5, Math.ceil(estimatedUsd * 1.6 * 2) / 2), approximate: true };
}

export function createStoryProcess(slug: string, projectId: string, itemId: string, opts: StoryOptions = {}): Process {
  const item = backlogRepo(slug).get(itemId)!;
  const procs = processesRepo(slug);
  const pending = procs.list(projectId).find(p => p.backlogItemId === itemId && (p.status === 'pending_authorization' || p.status === 'running'));
  if (pending) return pending;
  const est = estimateStory(slug, projectId, itemId, opts);
  // HU-161 · Crear el proceso y superar las autorizaciones pendientes de las iteraciones anteriores en la MISMA
  // transacción, venga de donde venga (Backlog, asistente, pipeline, reintento o nueva iteración). Se usa un
  // SAVEPOINT para que también funcione anidado dentro de la transacción de iterateStory.
  const db = workspaceDb(slug);
  db.exec('SAVEPOINT create_story_process');
  try {
    const proc = procs.create({ projectId, kind: 'story_execution', title: `${item.storyId} · ${item.title}`, estimatedUsd: est.estimatedUsd, backlogItemId: itemId, steps: est.steps.map(s => ({ agentId: s.agentId, agentName: s.agentName, title: s.title, model: s.model, role: s.role, reason: s.reason })) });
    // El equipo (con motivos y anulaciones) queda registrado desde el principio; runStory lo conserva.
    procs.setResult(proc.id, { plan: null, implementationSummary: null, changes: [], verifyCommands: [], review: null, applied: null, verifications: [], team: est.team ?? null, iterationContext: opts.iterationContext ?? null });
    supersedePreviousIterations(slug, itemId, proc.id);
    db.exec('RELEASE create_story_process');
    return procs.get(proc.id)!;
  } catch (e) {
    try { db.exec('ROLLBACK TO create_story_process'); db.exec('RELEASE create_story_process'); } catch { /* el savepoint ya no existía */ }
    throw e;
  }
}

/**
 * HU-161 · Una autorización vigente por historia: las iteraciones anteriores (no archivadas ni ya superadas) que
 * todavía esperan una decisión del propietario quedan marcadas como superadas por `currentId`. No cambia su estado
 * ni borra nada; se puede deshacer con «Restaurar» desde el historial. Devuelve los procesos marcados.
 */
export function supersedePreviousIterations(slug: string, itemId: string, currentId: string): string[] {
  const repo = processesRepo(slug); const out: string[] = [];
  for (const p of repo.listByBacklogItem(itemId)) {
    if (p.id === currentId || p.kind !== 'story_execution' || p.archivedAt || p.supersededBy) continue;
    if (decisionsFromProcess(slug, p).length === 0) continue;
    if (repo.markSuperseded(p.id, currentId)) out.push(p.id);
  }
  return out;
}

export async function runStory(slug: string, processId: string, log: (o: any, m: string) => void, isCancelled: () => boolean) {
  const procs = processesRepo(slug); const agents = agentsRepo(slug); const backlog = backlogRepo(slug); const knowledge = knowledgeRepo(slug);
  const proc = procs.get(processId)!;
  const item = backlog.get(proc.backlogItemId!)!;
  const project = projectsRepo(slug).get(proc.projectId)!;
  const repo = projectsRepo(slug).repository(project.id)!;
  const ctx = buildRepoContext(repo.path, 60_000);
  const treeText = `## Árbol del repositorio\n\`\`\`\n${ctx.tree}\n\`\`\``;
  const docs = knowledge.list(project.id);
  // Con una etapa vigente, la dirección es su línea base (y una síntesis escrita en la etapa); la síntesis anterior es histórica.
  const phase = currentPhase(slug, project.id);
  const synthesis = docs.find(d => /^Síntesis/.test(d.title) && (!phase || d.createdAt > phase.startedAt))?.body.slice(0, 6000) ?? '';
  const direction = phase ? `${phaseContext(slug, project.id, 16000)}${synthesis ? `\n\n${synthesis}` : ''}` : synthesis;
  // Pipeline autorizado (si el propietario lo incluyó al autorizar): aplicar, verificar, QA con evidencia y correcciones acotadas.
  const config = proc.result?.pipeline?.config ?? null;
  const result: ExecutionResult = { plan: null, implementationSummary: null, changes: [], verifyCommands: [], review: null, applied: null, verifications: [], team: proc.result?.team ?? null, consultations: [], iterationContext: proc.result?.iterationContext ?? null, pipeline: config ? newPipeline(config) : null, failure: null };
  const iterText = result.iterationContext ? `\n# Contexto de iteración (feedback del propietario y estado anterior; OBLIGATORIO tenerlo en cuenta)\n${result.iterationContext}\n` : '';
  const involved = Array.from(new Set(proc.steps.map(s => s.agentId)));
  const roleStep = (role: TeamRole) => { const st = stepByRole(proc, role); if (!st) throw new Error(`El proceso no tiene paso de ${role}.`); return st; };
  involved.forEach(id => agents.setStatus(id, 'active'));
  backlog.setStatus(item.id, 'in_progress', processId);
  procs.setResult(processId, result);
  let finalStatus: Process['status'] = 'done'; let finalError: string | null = null;
  let handedOff = false; // desde la entrega del Desarrollador, el resultado se actualiza en la base (no con el objeto local)
  const injected = new Map<string, string>();
  // Plazo y reintentos del proceso (si el propietario los fijó al autorizar) también para el plan y la implementación.
  const call = (stepId: string, system0: string, user: string, maxTokens: number, history?: { role: 'user' | 'assistant'; content: string }[], operation?: string) => callAgentStep(slug, processId, stepId, system0, user, maxTokens, { history, injected, log, timeoutSec: config?.providerTimeoutSec ?? null, retries: config?.maxProviderRetries ?? null, operation });
  // Antes de la entrega el resultado vive en este objeto: al guardarlo se conservan los reintentos que la llamada anotó en la base.
  const save = () => { const saved = procs.get(processId)?.result?.pipeline; if (result.pipeline && saved?.providerRetries) result.pipeline = { ...result.pipeline, providerRetries: saved.providerRetries }; procs.setResult(processId, result); };
  const cancelled = () => { if (isCancelled()) throw Object.assign(new Error('cancelado'), { cancelled: true }); };
  let runCtx: StoryRunCtx | null = null;

  try {
    // 1 · Plan técnico
    cancelled();
    const planStep = roleStep('planner'); const coord = agents.get(planStep.agentId)!;
    const planRes = await call(planStep.id, sys(coord, project, item),
      `Elabora el plan técnico para implementar esta historia en el repositorio. Sé concreto: qué archivos hay que leer, qué archivos hay que crear o modificar y qué tareas en orden. Mantén el alcance mínimo que cumpla el criterio de aceptación.
${direction ? `\n# Dirección del proyecto (${phase ? 'etapa vigente y línea base' : 'síntesis previa'})\n${direction}\n` : ''}${iterText}
${treeText}

El equipo implementará por partes (unidades que caben en una respuesta), así que indica también, por cada archivo a crear o modificar, su propósito, tipo y tamaño previsto en líneas.
Responde SOLO con JSON: {"summary": string, "tasks": string[], "filesToRead": string[] (rutas existentes relativas al repo, máx 8), "filesToChange": string[] (rutas a crear/modificar, máx 10), "deliverables": [{"path": string, "purpose": string (una frase), "kind": "code"|"test"|"docs"|"config", "estimatedLines": number}] (uno por cada ruta de filesToChange, en orden de dependencia), "acceptance": string[], "risks": string[]}`, 4000);
    let plan: StoryPlan = planFrom(extractJson(planRes.text), planRes.text.slice(0, 500));
    // Entrega incremental: un plan sin entregables legibles (JSON cortado o mal formado) se pide UNA vez más, compacto y en
    // el mismo paso; nunca se convierte en una respuesta enorme del Desarrollador con la historia entera.
    if (config?.autoApply && !planHasFiles(plan)) {
      log({ processId, stop: planRes.stopReason }, 'plan sin entregables legibles: se pide una vez en formato compacto');
      const again = await call(planStep.id, sys(coord, project, item), `Tu respuesta anterior no se pudo leer como un plan con archivos (JSON cortado o sin «filesToChange»). Devuelve SOLO el JSON del plan, compacto y completo: "summary" (máximo 3 frases), "tasks" (máximo 10, una línea cada una), "filesToRead" (máximo 6), "filesToChange" (TODAS las rutas a crear o modificar), "deliverables" (una por ruta: path, purpose de 12 palabras como mucho, kind, estimatedLines), "acceptance" (todos los criterios) y "risks" (máximo 3). Sin texto alrededor.`, 3000, [{ role: 'user', content: 'Elabora el plan técnico de la historia (JSON).' }, { role: 'assistant', content: planRes.text.slice(0, 12_000) }], 'Plan en formato compacto: el anterior no traía entregables legibles');
      plan = planFrom(extractJson(again.text), plan.summary);
    }
    // El criterio de la historia es obligatorio: si el plan no trae criterios, se usa el del propietario.
    if (!plan.acceptance.length && item.criterion?.trim()) plan.acceptance = [item.criterion.trim()];
    result.plan = plan; save();
    if (config?.autoApply) {
      // Antes de pagar consultas: un plan sin entregables, con demasiados o con rutas no permitidas se explica y se pausa.
      const team0 = involved.map(id => agents.get(id)).filter(Boolean) as Agent[];
      const implStep0 = roleStep('implementer'); const qaStep0 = stepByRole(proc, 'reviewer');
      runCtx = { slug, processId, item, project, repoPath: repo.path, plan, consultText: '', iterText, dev: agents.get(implStep0.agentId)!, qa: qaStep0 ? agents.get(qaStep0.agentId)! : null, team: team0, log, isCancelled, injected };
      const problem = (await import('./storyUnits.ts')).planProblem(plan);
      if (problem) { handedOff = true; throw new PipelinePause('plan', problem); }
      runCtx = null;
    }

    // 1b · Consultas de especialistas (M3): aportan recomendaciones concretas que recibe el implementador.
    for (const cs of proc.steps.filter(s => s.role === 'consultant')) {
      cancelled();
      const consultant = agents.get(cs.agentId)!;
      const cRes = await call(cs.id, sys(consultant, project, item), `Como ${consultant.template.role.toLowerCase()}, aporta recomendaciones concretas y accionables para esta historia desde tu especialidad, a partir del plan del Coordinador. Máximo 10 puntos, cada uno de una o dos líneas, en orden de importancia; indica archivos o pantallas cuando aplique. No escribas código completo.
# Plan
${JSON.stringify(plan, null, 2)}

${treeText}`, MAX_TOKENS.consultant);
      result.consultations!.push({ agentId: consultant.id, agentName: consultant.config.name, role: consultant.template.role, text: cRes.text.trim().slice(0, 8000) });
      save();
    }
    const consultText = result.consultations!.length ? `\n# Aportaciones de especialistas (tenlas en cuenta)\n${result.consultations!.map(c => `## ${c.agentName} · ${c.role}\n${c.text}`).join('\n\n')}\n` : '';

    // 2 · Implementación
    cancelled();
    const implStep = roleStep('implementer'); const dev = agents.get(implStep.agentId)!;
    const qaStep = stepByRole(proc, 'reviewer'); const qa = qaStep ? agents.get(qaStep.agentId)! : null;
    if (config?.autoApply) {
      // Pipeline con aplicación automática: entrega INCREMENTAL por unidades (manifiesto duradero, continuaciones por
      // archivo, comprobación previa a QA y correcciones dirigidas). El paso «Implementación» planificado pasa a ser
      // la primera unidad; cada llamada siguiente es su propio paso con su modelo, tokens y costo.
      handedOff = true; save();
      const team = involved.map(id => agents.get(id)).filter(Boolean) as Agent[];
      const rc: StoryRunCtx = { slug, processId, item, project, repoPath: repo.path, plan, consultText, iterText, dev, qa, team, log, isCancelled, injected };
      runCtx = rc;
      const units = await import('./storyUnits.ts');
      units.startIncremental(rc, implStep.status === 'pending' ? implStep.id : null);
      await runPipelineStages(rc);
      const fin = procs.get(processId)!.result!;
      knowledge.add({ projectId: project.id, title: `${item.storyId} · Plan e implementación incremental — ${item.title}`, body: `# Plan\n${plan.summary}\n\n${plan.tasks.map(t => '- ' + t).join('\n')}\n\n# Entregables\n${(fin.manifest?.deliverables ?? []).map(d => `- [${d.status}] ${d.path}${d.note ? ` — ${d.note}` : ''}`).join('\n')}\n\n# Implementación\n${fin.implementationSummary ?? ''}\n\n# Revisión QA\n${fin.review ? `${fin.review.verdict ?? (fin.review.approve ? 'approved' : 'rejected')} — ${fin.review.summary}` : 'sin revisión'}${fin.pipeline ? `\n\n# Pipeline\n${fin.pipeline.events.map(e => `- ${e.message}`).join('\n')}` : ''}`, authorAgentId: coord.id, authorAgentName: coord.config.name, processId });
      backlog.setStatus(item.id, 'review', processId);
      return;
    }
    // Contexto acotado: archivos del plan, cada uno hasta 30 000 caracteres y 120 000 en total (lo demás, el modelo lo parchea a ciegas con contexto suficiente o lo pide en NOTAS).
    let ctxBudget = 120_000;
    const filesCtx = Array.from(new Set([...plan.filesToRead, ...plan.filesToChange])).map(f => {
      const c = readRepoFile(repo.path, f, 30_000); if (c === null) return `## ${f}\n(no existe aún)`;
      if (ctxBudget <= 0) return `## ${f}\n(omitido por tamaño del contexto: ${c.length} caracteres; si debes modificarlo usa patch con fragmentos que conozcas o crea un módulo nuevo)`;
      ctxBudget -= c.length; return `## ${f}\n\`\`\`\n${c}\n\`\`\``;
    }).join('\n\n');
    const implPrompt = `Implementa la historia siguiendo este plan del Coordinador:
${JSON.stringify(plan, null, 2)}
${iterText}${consultText}
${treeText}

# Contenido actual de los archivos relevantes
${filesCtx}

Para archivos nuevos entrega el contenido íntegro (create). Para archivos existentes usa patch con bloques BUSCAR/REEMPLAZAR exactos (copia el fragmento tal cual está en el archivo); usa modify solo si reescribes casi todo un archivo pequeño. Nada de fragmentos con "...": lo que entregues es lo que se escribirá. Respeta las convenciones. Mantén el alcance mínimo que cumpla el criterio de aceptación.

FORMATO DE RESPUESTA (texto plano, sin JSON ni bloques de código alrededor de los archivos):
${FILE_FORMAT}`;
    let implRes = await call(implStep.id, sys(dev, project, item), implPrompt, DEV_MAX_TOKENS);
    let implText = implRes.text;
    // Si la respuesta se cortó por longitud, pedimos continuar (hasta 2 veces) exactamente donde quedó.
    for (let i = 0; i < 2 && isTruncatedStop(implRes.stopReason); i++) {
      cancelled();
      log({ step: 'Implementación', continuation: i + 1 }, 'respuesta cortada: se pide continuación');
      implRes = await call(implStep.id, sys(dev, project, item), 'Tu respuesta anterior se cortó por el límite de longitud. Continúa EXACTAMENTE desde el último carácter que escribiste, sin repetir nada de lo anterior, sin saludos ni explicaciones, manteniendo el mismo formato de marcadores.', DEV_MAX_TOKENS, [{ role: 'user', content: implPrompt }, { role: 'assistant', content: implText }], `Continuación ${i + 1} de 2: la respuesta anterior se cortó por longitud (se reenvía la petición con lo ya escrito)`);
      implText += implRes.text;
    }

    // 3 · De la entrega a cambios válidos: recuperación local (sin IA) y, si está autorizado, reparación acotada.
    handedOff = true; save();
    const team = involved.map(id => agents.get(id)).filter(Boolean) as Agent[];
    const rc: StoryRunCtx = { slug, processId, item, project, repoPath: repo.path, plan, consultText, iterText, dev, qa, team, log, isCancelled, injected };
    runCtx = rc;
    const outcome = await settleImplementation(rc, [{ text: implText, stopReason: implRes.stopReason, refusal: implRes.refusal ?? null }], { config });
    if (outcome === 'no_changes') throw new PipelinePause('no_changes', 'El Desarrollador concluye que la historia no requiere cambios de código. Revisa su justificación en el resumen.');

    if (config?.autoApply) {
      // 4 · Pipeline autorizado: aplicar → verificar → QA con evidencia → correcciones acotadas.
      await runPipelineStages(rc);
    } else if (qa && qaStep) {
      // 4' · Sin pipeline: QA revisa el diff (como antes) y el propietario sigue cada paso.
      cancelled();
      const r = procs.get(processId)!.result!;
      const diffs = r.changes.map(c => `${c.error ? `[NO APLICABLE: ${c.error}] ` : ''}${c.warning ? `[AVISO: ${c.warning}] ` : ''}${c.diff ?? ''}`).join('\n\n').slice(0, 60_000);
      const revRes = await call(qaStep.id, sys(qa, project, item),
        `Revisa los cambios propuestos para la historia frente al plan y al criterio de aceptación. Busca errores, incoherencias con las convenciones, riesgos de seguridad y qué pruebas deberían ejecutarse.
# Plan
${JSON.stringify(plan, null, 2)}
# Resumen del desarrollador
${r.implementationSummary}
${consultText}# Diffs
${diffs}

Sé concreto y breve: "summary" en 3-5 frases, como máximo 8 "issues" y 6 "suggestedTests", cada uno de una línea. Empieza cada issue con su gravedad entre corchetes: "[alta]" (rompe algo, inseguro o no cumple el criterio), "[media]" o "[baja]" (estilo, mejora opcional); si citas un archivo, usa su ruta.
Responde SOLO con JSON: {"approve": boolean, "summary": string, "issues": string[], "suggestedTests": string[]}`, 6000);
      updateResult(slug, processId, x => ({ ...x, review: parseReview(revRes.text, revRes.stopReason) }));
    }
    const fin = procs.get(processId)!.result!;
    knowledge.add({ projectId: project.id, title: `${item.storyId} · Plan e implementación propuesta — ${item.title}`, body: `# Plan\n${plan.summary}\n\n${plan.tasks.map(t => '- ' + t).join('\n')}\n\n# Implementación\n${fin.implementationSummary}\n\nArchivos: ${fin.changes.map(c => `${c.action} ${c.path}`).join(', ')}\n\n# Revisión QA\n${fin.review ? `${fin.review.approve ? 'Aprobada' : 'Con observaciones'} — ${fin.review.summary}\n${fin.review.issues.map(i => '- ' + i).join('\n')}` : 'Omitida por el propietario'}${fin.pipeline ? `\n\n# Pipeline\n${fin.pipeline.events.map(e => `- ${e.message}`).join('\n')}` : ''}`, authorAgentId: coord.id, authorAgentName: coord.config.name, processId });
    backlog.setStatus(item.id, 'review', processId);
  } catch (e: any) {
    // Fallo del proveedor tras la entrega del Desarrollador (con pipeline): pausa, no fallo; lo hecho se conserva.
    const pp = runCtx && config && !(e instanceof PipelinePause) ? providerPause(e) : null;
    if (pp && e?.failure) updateResult(slug, processId, x => ({ ...x, failure: e.failure }));
    if ((e instanceof PipelinePause || pp) && runCtx) {
      // Pausa o parada del pipeline: el proceso termina «done» con lo hecho conservado y el motivo; «Continuar» lo retoma.
      pausePipeline(runCtx, e instanceof PipelinePause ? e : pp!);
      const fin = procs.get(processId)!.result!;
      backlog.setStatus(item.id, fin.applied || fin.changes.some(c => !c.error) ? 'review' : 'pending', processId);
    } else {
      if (e?.cancelled) { finalStatus = 'cancelled'; } else if (e?.budget) { finalStatus = 'budget_exceeded'; finalError = e.message; } else { finalStatus = 'failed'; finalError = e.message; }
      const failure = e instanceof StoryFailure ? e.failure : e?.cancelled ? { kind: 'cancelled' as const, detail: 'Cancelado por el propietario.' } : e?.budget ? { kind: 'budget' as const, detail: e.message } : e?.failure ?? { kind: 'internal' as const, detail: e?.message ?? String(e) };
      if (handedOff) updateResult(slug, processId, x => ({ ...x, failure, pipeline: x.pipeline ? { ...x.pipeline, state: 'stopped', phase: 'finished', reason: failure.detail, finishedAt: new Date().toISOString(), events: [...x.pipeline.events, { at: new Date().toISOString(), kind: 'error', message: failure.detail }] } : null }));
      else { result.failure = failure; save(); }
      for (const s of procs.get(processId)!.steps) if (s.status === 'pending') procs.stepFinish(s.id, 'skipped', { error: finalStatus === 'cancelled' ? 'cancelado por el usuario' : null });
      const fin = procs.get(processId)!.result!;
      backlog.setStatus(item.id, fin.applied ? 'review' : 'pending', processId);
    }
  } finally {
    involved.forEach(id => agents.setStatus(id, 'inactive'));
    // El QA que no llegó a usarse (p. ej. pipeline pausado antes de QA) queda como omitido, no «pendiente» para siempre.
    for (const s of procs.get(processId)!.steps) if (s.status === 'pending' && finalStatus === 'done') procs.stepFinish(s.id, 'skipped', { error: null });
    procs.finish(processId, finalStatus, finalError);
    log({ processId, status: finalStatus, pipeline: procs.get(processId)?.result?.pipeline?.state, spent: procs.get(processId)?.spentUsd.toFixed(4) }, 'historia finalizada');
    // M4: detección determinista de errores objetivos (sin IA) → lecciones «detectadas» con evidencia.
    try { const ls = recordDetections(slug, processId, repo.path); if (ls.length) log({ processId, lessons: ls.map(l => l.detector) }, 'lecciones detectadas'); } catch (e: any) { log({ err: e.message }, 'detección de lecciones fallida'); }
  }
}

/**
 * Recuperar sin IA un proceso fallido: si el Desarrollador ya entregó su salida (paso 2) pero el proceso cayó después
 * (p. ej. una ruta que antes se consideraba protegida), se vuelve a leer esa salida con las reglas actuales y, si hay
 * cambios aplicables, el proceso pasa a «terminado» con su diff listo para revisar. No se gasta nada.
 */
export async function recoverStory(slug: string, processId: string): Promise<Process> {
  const procs = processesRepo(slug); const proc = procs.get(processId);
  if (!proc || proc.kind !== 'story_execution') throw Object.assign(new Error('Proceso de historia no encontrado'), { statusCode: 404 });
  if (proc.status === 'running' || proc.status === 'pending_authorization') throw Object.assign(new Error('El proceso no ha terminado.'), { statusCode: 409 });
  if (proc.result?.applied) throw Object.assign(new Error('Los cambios de este proceso ya se aplicaron.'), { statusCode: 409 });
  const outputs = implementerOutputs(proc);
  const dev = stepByRole(proc, 'implementer');
  if (!outputs.length && dev?.outputMd?.trim()) outputs.push({ text: dev.outputMd, stopReason: null });
  if (!outputs.length) throw Object.assign(new Error('El Desarrollador no llegó a entregar nada en este proceso: no hay salida que recuperar. Vuelve a ejecutar la historia.'), { statusCode: 409 });
  const repo = projectsRepo(slug).repository(proc.projectId);
  if (!repo) throw Object.assign(new Error('No hay repositorio registrado.'), { statusCode: 409 });
  // Misma recuperación que el pipeline (formato canónico, variantes, diff unificado, archivos nuevos en bloques de código, JSON antiguo), sin IA.
  const planStep = stepByRole(proc, 'planner');
  const planJson = planStep?.outputMd ? extractJson(planStep.outputMd) : null;
  const plan: StoryPlan | null = planJson ? planFrom(planJson, '') : proc.result?.plan ?? null;
  const exists = (p: string) => readRepoFile(repo.path, p, 1) !== null;
  let pool: RawChange[] = []; let assessment: DevOutputAssessment | null = null; let meta: ParsedDevOutput | null = null;
  for (const o of outputs) {
    const r = assessDeveloperOutput(o.text, { stopReason: o.stopReason, exists, knownFiles: plan ? [...plan.filesToRead, ...plan.filesToChange] : [] });
    pool = mergeChanges(pool, r.parsed.changes); assessment = r.assessment;
    const prevMeta = meta as ParsedDevOutput | null;
    meta = prevMeta ? { ...prevMeta, summary: prevMeta.summary || r.parsed.summary, notes: prevMeta.notes || r.parsed.notes } : r.parsed;
  }
  const a = assessment!; const m = meta!;
  if (!pool.length) {
    const base: ExecutionResult = proc.result ?? { plan, implementationSummary: null, changes: [], verifyCommands: [], review: null, applied: null, verifications: [] };
    procs.setResult(processId, { ...base, failure: { kind: a.kind === 'refusal' || a.kind === 'blocked' || a.kind === 'provider_refusal' ? 'refusal' : 'output_contract', class: failureClassOf(a) ?? undefined, detail: `Recuperación sin IA: ${a.reasons.join(' ')}`, assessment: a } });
    throw Object.assign(new Error(`No se pudo recuperar ningún cambio sin IA (${a.kind}): ${a.reasons.slice(0, 3).join(' ')} Puedes pedir al Desarrollador que repare su entrega (sin repetir el plan) o volver a ejecutar la historia.`), { statusCode: 409, code: 'not_recoverable', assessment: a });
  }
  const changes = annotateChanges(repo.path, pool);
  // El Desarrollador leyó los archivos cuando empezó su paso: si alguno cambió después, un «modify» completo lo machacaría.
  const readAt = dev?.startedAt ?? proc.createdAt;
  for (const c of changes) { if (!c.error && c.action === 'modify' && await fileChangedSince(repo.path, c.path, readAt)) c.error = `El archivo cambió en el repositorio después de que el Desarrollador lo leyera (${new Date(readAt).toLocaleString()}): aplicar esta versión completa sobrescribiría ese trabajo. Si necesitas el cambio, vuelve a ejecutar la historia.`; }
  const applicable = changes.filter(c => !c.error);
  if (!applicable.length) throw Object.assign(new Error(`Ningún cambio es aplicable: ${changes.map(c => `${c.path}: ${c.error}`).join(' · ')}`), { statusCode: 409 });
  const invalid = changes.filter(c => c.error);
  const how = a.recoveredBy && a.recoveredBy !== 'canonical' ? ` Formato recuperado: ${a.recoveredBy}.` : '';
  const prev = proc.result;
  const now = new Date().toISOString();
  const pipeline = prev?.pipeline ? { ...prev.pipeline, state: 'stopped' as const, phase: 'finished' as const, reason: 'Entrega recuperada sin IA: puedes continuar automáticamente (aplicar, verificar y QA).', pauseKind: null, lastAssessment: a, events: [...prev.pipeline.events, { at: now, kind: 'recovery' as const, message: `Entrega recuperada sin IA: ${applicable.length} archivo(s) aplicables.`, detail: a.reasons.slice(0, 3).join(' ') || null }] } : null;
  const result: ExecutionResult = {
    plan, changes, review: null, applied: null, verifications: [],
    implementationSummary: `♻ Resultado recuperado sin IA de la salida del Desarrollador (el proceso había fallado por: ${proc.error ?? 'error posterior'}).${how}${a.truncatedFile ? ` ⚠ La salida se cortó a mitad de «${a.truncatedFile}»; ese archivo no está incluido.` : ''}${invalid.length ? ` ⚠ ${invalid.length} cambio(s) no aplicables: ${invalid.map(c => c.path).join(', ')}.` : ''}\n\n${m.summary}${m.notes ? `\n\n${m.notes}` : ''}`,
    verifyCommands: m.verify.filter(c => ['install', 'typecheck', 'test', 'build'].includes(c)).length ? m.verify : ['typecheck'],
    userFacing: m.userFacing || null,
    manualTest: m.manualSteps.length ? { steps: m.manualSteps, checks: m.manualSteps.map(() => false), note: null } : null,
    runtimeChecks: m.runtimeChecks.length ? { checks: m.runtimeChecks, results: [], ranAt: null } : null,
    team: prev?.team ?? null, consultations: prev?.consultations ?? [], iterationContext: prev?.iterationContext ?? null, pipeline, failure: null
  };
  procs.setResult(processId, result);
  procs.finish(processId, 'done', null);
  if (proc.backlogItemId) backlogRepo(slug).setStatus(proc.backlogItemId, 'review', processId);
  return procs.get(processId)!;
}

/** Volver a ejecutar la historia de un proceso terminado (nuevo proceso pendiente de autorización). */
export function retryStory(slug: string, processId: string, opts: StoryOptions = {}): Process {
  const proc = processesRepo(slug).get(processId);
  if (!proc || proc.kind !== 'story_execution' || !proc.backlogItemId) throw Object.assign(new Error('Proceso de historia no encontrado'), { statusCode: 404 });
  if (proc.status === 'running' || proc.status === 'pending_authorization') throw Object.assign(new Error('El proceso sigue activo.'), { statusCode: 409 });
  const item = backlogRepo(slug).get(proc.backlogItemId);
  if (!item) throw Object.assign(new Error('La historia ya no existe en el backlog.'), { statusCode: 404 });
  if (item.status === 'done' || item.status === 'discarded') throw Object.assign(new Error(`La historia está ${item.status === 'done' ? 'completada' : 'descartada'}; reábrela desde el backlog si quieres repetirla.`), { statusCode: 409 });
  if (item.status === 'in_progress') throw Object.assign(new Error('La historia ya está en ejecución.'), { statusCode: 409 });
  return createStoryProcess(slug, proc.projectId, item.id, opts);
}

/** Estimación de generar la lista de prueba manual (1 llamada corta del Especialista QA o, en su defecto, del Coordinador). */
export function estimateManualTest(slug: string, processId: string): { agentId: string; agentName: string; model: string; estimatedUsd: number } {
  const proc = processesRepo(slug).get(processId);
  if (!proc || proc.kind !== 'story_execution' || !proc.result) throw Object.assign(new Error('Proceso de historia no encontrado'), { statusCode: 404 });
  const agents = activeAgents(slug).filter(a => a.projectId === proc.projectId || a.projectId === null);
  const agent = agents.find(a => a.key === 'pj-qa') ?? agents.find(a => a.key === 'pj-coordinador');
  if (!agent) throw Object.assign(new Error('No hay agente de QA ni Coordinador en el proyecto.'), { statusCode: 409 });
  const p = estimatePricing(agent.config.provider, agent.config.model);
  const inTok = estimateTokens(JSON.stringify(proc.result.plan ?? '') + (proc.result.implementationSummary ?? '') + proc.result.changes.map(c => c.path + (c.diff ?? '').slice(0, 2000)).join('')) + 800;
  return { agentId: agent.id, agentName: agent.config.name, model: agent.config.model, estimatedUsd: (inTok * p.inPerM + 1500 * p.outPerM) / 1_000_000 };
}

/**
 * Genera, con una llamada autorizada, la explicación para el propietario y la prueba manual paso a paso de una
 * historia ya ejecutada que no las trae (procesos anteriores a v0.11). Guarda ambas en el resultado del proceso.
 */
export async function generateManualTest(slug: string, processId: string, log: (o: any, m: string) => void): Promise<Process> {
  const procs = processesRepo(slug); const proc = procs.get(processId)!;
  const est = estimateManualTest(slug, processId);
  const agent = agentsRepo(slug).get(est.agentId)!;
  const project = projectsRepo(slug).get(proc.projectId)!;
  const item = proc.backlogItemId ? backlogRepo(slug).get(proc.backlogItemId) : undefined;
  const providerId = agent.config.provider as ProviderId;
  const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
  const cc = agentCaller(slug, agent, proc.projectId, 'Prueba manual');
  if (!cc && (!cred || prow.status !== 'connected')) throw Object.assign(new Error(`El proveedor ${providerId} no está conectado.`), { statusCode: 409 });
  const models: ModelInfo[] = JSON.parse(prow.models_json);
  const r = proc.result!;
  const system = `Eres «${agent.config.name}», ${agent.template.role.toLowerCase()} del proyecto «${project.name}» en Portal IA. Escribes para el propietario, que no es técnico.`;
  const user = `Historia: ${item ? `${item.storyId} · ${item.title}` : proc.title}
Criterio de aceptación: ${item?.criterion || '(no definido)'}
Plan: ${r.plan?.summary ?? '—'}
Resumen de la implementación: ${(r.implementationSummary ?? '').slice(0, 3000)}
Archivos cambiados: ${r.changes.map(c => `${c.action} ${c.path}`).join(', ')}
Fragmentos de diff (recortados):
${r.changes.slice(0, 8).map(c => `## ${c.path}\n${(c.diff ?? '').slice(0, 1500)}`).join('\n\n')}

Responde SOLO con JSON: {"userFacing": string (3-8 líneas en lenguaje llano: qué cambia para quien usa el Portal y DÓNDE lo verá: menú, botón, pantalla o ruta exacta; si no hay nada visible, dilo), "steps": string[] (3-10 pasos numerados de prueba manual en el Portal, cada uno "acción. Esperado: resultado"; empieza por dónde entrar)}`;
  const startedAt = new Date().toISOString();
  requirePolicy('ai_call', { slug, agentId: agent.id, projectId: proc.projectId, authorized: true });
  const res = await completeWith(cc, providerId, cred, prow, { model: agent.config.model, system, user, maxTokens: 2000, effort: 'low', supportsEffort: !!models.find(m => m.id === agent.config.model)?.supportsEffort });
  const cost = (cc ? 0 : costUsd(providerId, agent.config.model, res.inputTokens, res.outputTokens));
  procs.addUsage(processId, res.inputTokens, res.outputTokens, cost);
  procs.logExecution({ projectId: proc.projectId, agentId: agent.id, kind: 'manual_test_gen', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
  const j = extractJson(res.text);
  const steps: string[] = Array.isArray(j?.steps) ? j.steps.map((s: any) => String(s).replace(/^\s*\d+[.)]\s*/, '').trim()).filter((s: string) => s.length > 3).slice(0, 12) : [];
  if (!steps.length) throw Object.assign(new Error('QA no devolvió pasos de prueba legibles; inténtalo de nuevo o añádelos a mano.'), { statusCode: 502 });
  procs.setResult(processId, { ...r, userFacing: r.userFacing || (typeof j?.userFacing === 'string' ? j.userFacing : null), manualTest: { steps, checks: steps.map(() => false), note: null } });
  log({ processId, steps: steps.length, cost: cost.toFixed(4) }, 'lista de prueba manual generada');
  return procs.get(processId)!;
}

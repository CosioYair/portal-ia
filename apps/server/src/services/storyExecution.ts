import type { Agent, AssessmentEstimate, BacklogItem, ExecutionResult, ModelInfo, Process, ProviderId, ReviewVerdict, StoryPlan } from '@portal-ia/domain';
import { costUsd, estimatePricing, estimateTokens, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, knowledgeRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';
import { buildRepoContext } from './repoContext.ts';
import { annotateChanges, readRepoFile } from './repoWrite.ts';
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
const CONVENTIONS = `Convenciones del repositorio: monorepositorio npm workspaces; TypeScript estricto con ESM e imports con extensión .ts/.tsx; dominio compartido en packages/domain (tipos y plantillas, sin IO); adaptadores en packages/ai-adapters (toda llamada a modelos pasa por complete() y registra tokens/costo); backend Fastify en apps/server (rutas delgadas que validan con zod y delegan en services/; una base SQLite por espacio vía node:sqlite); frontend React 19 + Vite en apps/web (pantallas en src/screens, componentes en src/components, textos en español, estados explícitos, ninguna acción con costo sin autorización explícita en la UI). Pruebas: node --test en apps/server/test. No introducir dependencias nuevas salvo necesidad justificada.`;

function stepPlanFor(agents: Agent[]) {
  const by = (k: string) => agents.find(a => a.key === k);
  return [
    { agent: by('pj-coordinador')!, title: 'Plan técnico de la historia', maxTokens: 2500 },
    { agent: by('pj-dev')!, title: 'Implementación (cambios propuestos)', maxTokens: 16000 },
    { agent: by('pj-qa')!, title: 'Revisión de calidad', maxTokens: 6000 }
  ].map(s => { if (!s.agent) throw Object.assign(new Error('Faltan agentes del proyecto (coordinador, desarrollador o QA).'), { statusCode: 409 }); return s; });
}

function sys(agent: Agent, project: { name: string; description: string }, story: BacklogItem): string {
  return `Eres «${agent.config.name}», ${agent.template.role.toLowerCase()} del proyecto «${project.name}» en Portal IA.
Especialización: ${agent.config.specialization}
Responsabilidades: ${agent.config.responsibilities.map(r => '- ' + r).join('\n')}
Contexto del proyecto: ${project.description}
Historia a ejecutar: ${story.storyId} · ${story.title}
Criterio de aceptación: ${story.criterion || '(no definido; propón uno verificable)'}
${story.description ? `Detalle del propietario: ${story.description}` : ''}
${CONVENTIONS}
Responde en español. Cuando se te pida JSON, responde SOLO con JSON válido, sin texto alrededor ni bloques de código.`;
}

function extractJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[];
  for (const c of candidates) { try { return JSON.parse(c); } catch { /* siguiente */ } }
  return null;
}

const DEV_MAX_TOKENS = 16000;
const isTruncated = (stop: string | null) => stop === 'max_tokens' || stop === 'length';
const FILE_FORMAT = `=== RESUMEN ===
(2-6 frases: qué se hizo y por qué)
=== ARCHIVO: ruta/relativa/al/repo | create ===
(contenido íntegro del archivo, tal cual, sin cercas de código)
=== FIN ARCHIVO ===
=== ARCHIVO: otra/ruta.ts | modify ===
(contenido íntegro final)
=== FIN ARCHIVO ===
=== ARCHIVO: ruta/a/borrar.ts | delete ===
=== FIN ARCHIVO ===
=== VERIFICAR: typecheck, test, build ===
=== NOTAS ===
(opcional: decisiones, riesgos, pasos manuales)
Reglas: la acción es create, modify o delete; cada archivo abre con "=== ARCHIVO:" y cierra con "=== FIN ARCHIVO ==="; nada fuera de estos bloques salvo RESUMEN, VERIFICAR y NOTAS.`;

/** Lee la respuesta del Desarrollador en formato de bloques; detecta un archivo cortado (abierto sin cierre). */
export function parseFileBlocks(text: string): { summary: string; notes: string; verify: string[]; changes: { path: string; action: 'create' | 'modify' | 'delete'; content: string | null }[]; truncatedFile: string | null } {
  const changes: { path: string; action: 'create' | 'modify' | 'delete'; content: string | null }[] = [];
  const re = /^[ \t]*={3,}\s*ARCHIVO:\s*(.+?)\s*\|\s*(create|modify|delete)\s*={3,}[ \t]*\r?\n?([\s\S]*?)(?:^[ \t]*={3,}\s*FIN ARCHIVO\s*={3,}[ \t]*$|(?![\s\S]))/gmi;
  let truncatedFile: string | null = null; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const closed = /={3,}\s*FIN ARCHIVO\s*={3,}\s*$/i.test(m[0]);
    const path = m[1].trim().replace(/^[`'"]|[`'"]$/g, ''); const action = m[2].toLowerCase() as 'create' | 'modify' | 'delete';
    let content = m[3].replace(/\r\n/g, '\n');
    // Tolerancia: si el modelo envolvió el contenido en una cerca de código, la quitamos.
    const fence = content.match(/^\s*```[\w+-]*\n([\s\S]*?)\n```\s*$/); if (fence) content = fence[1] + '\n';
    if (!closed && action !== 'delete') { truncatedFile = path; break; }
    changes.push({ path, action, content: action === 'delete' ? null : content.replace(/^\n/, '') });
  }
  const section = (name: string) => text.match(new RegExp(`^[ \\t]*={3,}\\s*${name}\\s*={3,}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^[ \\t]*={3,}\\s*(?:ARCHIVO:|VERIFICAR:|NOTAS|RESUMEN)|(?![\\s\\S]))`, 'mi'))?.[1]?.trim() ?? '';
  const verify = (text.match(/^[ \t]*={3,}\s*VERIFICAR:\s*(.*?)\s*={3,}/mi)?.[1] ?? '').split(/[\s,]+/).map(v => v.trim().toLowerCase()).filter(Boolean);
  return { summary: section('RESUMEN'), notes: section('NOTAS'), verify, changes, truncatedFile };
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

export function estimateStory(slug: string, projectId: string, itemId: string): AssessmentEstimate {
  const item = backlogRepo(slug).get(itemId);
  if (!item || item.projectId !== projectId) throw Object.assign(new Error('Historia no encontrada'), { statusCode: 404 });
  const repo = projectsRepo(slug).repository(projectId);
  if (!repo) throw Object.assign(new Error('Registra el repositorio del proyecto antes de ejecutar historias.'), { statusCode: 409 });
  preflightRepo(slug, repo.path);
  const ctxChars = buildRepoContext(repo.path, 60_000).totalChars;
  const agents = agentsRepo(slug).list().filter(a => a.projectId === projectId);
  const steps = stepPlanFor(agents).map((s, i) => {
    const p = estimatePricing(s.agent.config.provider, s.agent.config.model);
    const inTok = Math.ceil(ctxChars / 3.5) + 2000 + (i === 1 ? 20000 : i === 2 ? 12000 : 0);
    const outTok = s.maxTokens * (i === 1 ? 0.7 : 0.6) + (s.agent.config.effort === 'high' ? 6000 : s.agent.config.effort === 'medium' ? 2500 : 0);
    return { agentId: s.agent.id, agentName: s.agent.config.name, title: s.title, model: s.agent.config.model, estimatedUsd: (inTok * p.inPerM + outTok * p.outPerM) / 1_000_000 };
  });
  const estimatedUsd = steps.reduce((a, s) => a + s.estimatedUsd, 0);
  return { steps, contextChars: ctxChars, estimatedUsd, suggestedBudgetUsd: Math.max(0.5, Math.ceil(estimatedUsd * 1.6 * 2) / 2), approximate: true };
}

export function createStoryProcess(slug: string, projectId: string, itemId: string): Process {
  const item = backlogRepo(slug).get(itemId)!;
  const procs = processesRepo(slug);
  const pending = procs.list(projectId).find(p => p.backlogItemId === itemId && (p.status === 'pending_authorization' || p.status === 'running'));
  if (pending) return pending;
  const est = estimateStory(slug, projectId, itemId);
  return procs.create({ projectId, kind: 'story_execution', title: `${item.storyId} · ${item.title}`, estimatedUsd: est.estimatedUsd, backlogItemId: itemId, steps: est.steps.map(s => ({ agentId: s.agentId, agentName: s.agentName, title: s.title, model: s.model })) });
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
  const direction = docs.find(d => /^Síntesis/.test(d.title))?.body.slice(0, 6000) ?? '';
  const result: ExecutionResult = { plan: null, implementationSummary: null, changes: [], verifyCommands: [], review: null, applied: null, verifications: [] };
  const involved = Array.from(new Set(proc.steps.map(s => s.agentId)));
  involved.forEach(id => agents.setStatus(id, 'active'));
  backlog.setStatus(item.id, 'in_progress', processId);
  let finalStatus: Process['status'] = 'done'; let finalError: string | null = null;

  const call = async (stepIdx: number, system: string, user: string, maxTokens: number, history?: { role: 'user' | 'assistant'; content: string }[]) => {
    const step = proc.steps[stepIdx]; const agent = agents.get(step.agentId)!;
    const providerId = agent.config.provider as ProviderId;
    const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
    if (!cred || prow.status !== 'connected') throw new Error(`El proveedor ${providerId} no está conectado.`);
    const models: ModelInfo[] = JSON.parse(prow.models_json);
    const cur = procs.get(processId)!;
    const p = estimatePricing(providerId, agent.config.model);
    const stepEst = (estimateTokens(system + user) * p.inPerM + maxTokens * p.outPerM) / 1_000_000;
    if (cur.spentUsd + stepEst * 0.5 > cur.budgetUsd) throw Object.assign(new Error(`Presupuesto insuficiente para «${step.title}» (gastado ${cur.spentUsd.toFixed(2)} de ${cur.budgetUsd.toFixed(2)} USD).`), { budget: true });
    procs.stepStart(step.id);
    const startedAt = new Date().toISOString();
    try {
      const res = await getAdapter(providerId)!.complete(decryptSecret(cred.ciphertext), { workspaceId: prow.workspace_id }, { model: agent.config.model, system, user, maxTokens, effort: agent.config.effort, supportsEffort: !!models.find(m => m.id === agent.config.model)?.supportsEffort, history });
      const cost = costUsd(providerId, agent.config.model, res.inputTokens, res.outputTokens);
      const prev = procs.get(processId)!.steps[stepIdx];
      // Un paso puede necesitar varias llamadas (continuación de una respuesta cortada): acumulamos.
      const acc = history?.length ? prev : { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      procs.stepFinish(step.id, 'done', { tokensIn: acc.inputTokens + res.inputTokens, tokensOut: acc.outputTokens + res.outputTokens, cost: acc.costUsd + cost, outputMd: history?.length ? `${history.filter(h => h.role === 'assistant').map(h => h.content).join('')}${res.text}` : res.text });
      procs.addUsage(processId, res.inputTokens, res.outputTokens, cost);
      procs.logExecution({ projectId: project.id, agentId: agent.id, kind: 'story_step', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
      log({ step: step.title, tokens: res.inputTokens + res.outputTokens, cost: cost.toFixed(4), stop: res.stopReason }, 'paso completado');
      return res;
    } catch (e) {
      const err = e instanceof ProviderRequestError ? e.error : null;
      let msg = err ? err.message : (e as Error).message;
      const maybeBilled = !err || err.code === 'network' || (err.httpStatus ?? 0) >= 500;
      const estIn = maybeBilled ? estimateTokens(system + user) : 0; const estCost = maybeBilled ? costUsd(providerId, agent.config.model, estIn, 0) : 0;
      if (maybeBilled) msg += ` Costo estimado de la entrada enviada: ${estCost.toFixed(4)} USD (sin confirmación del proveedor).`;
      procs.stepFinish(step.id, 'failed', { tokensIn: estIn, cost: estCost, error: msg });
      if (maybeBilled) procs.addUsage(processId, estIn, 0, estCost);
      procs.logExecution({ projectId: project.id, agentId: agent.id, kind: 'story_step', status: 'failed', tokensIn: estIn, tokensOut: 0, cost: estCost, startedAt });
      throw new Error(msg);
    }
  };

  try {
    // 1 · Plan técnico
    if (isCancelled()) throw Object.assign(new Error('cancelado'), { cancelled: true });
    const coord = agents.get(proc.steps[0].agentId)!;
    const planRes = await call(0, sys(coord, project, item),
      `Elabora el plan técnico para implementar esta historia en el repositorio. Sé concreto: qué archivos hay que leer, qué archivos hay que crear o modificar y qué tareas en orden. Mantén el alcance mínimo que cumpla el criterio de aceptación.
${direction ? `\n# Dirección del proyecto (síntesis previa)\n${direction}\n` : ''}
${treeText}

Responde SOLO con JSON: {"summary": string, "tasks": string[], "filesToRead": string[] (rutas existentes relativas al repo, máx 8), "filesToChange": string[] (rutas a crear/modificar, máx 10), "acceptance": string[], "risks": string[]}`, 2500);
    const planJson = extractJson(planRes.text);
    const plan: StoryPlan = { summary: String(planJson?.summary ?? planRes.text.slice(0, 500)), tasks: planJson?.tasks ?? [], filesToRead: (planJson?.filesToRead ?? []).slice(0, 8), filesToChange: (planJson?.filesToChange ?? []).slice(0, 10), acceptance: planJson?.acceptance ?? [], risks: planJson?.risks ?? [] };
    result.plan = plan; procs.setResult(processId, result);

    // 2 · Implementación
    if (isCancelled()) throw Object.assign(new Error('cancelado'), { cancelled: true });
    const dev = agents.get(proc.steps[1].agentId)!;
    const filesCtx = Array.from(new Set([...plan.filesToRead, ...plan.filesToChange])).map(f => { const c = readRepoFile(repo.path, f, 40_000); return c === null ? `## ${f}\n(no existe aún)` : `## ${f}\n\`\`\`\n${c}\n\`\`\``; }).join('\n\n');
    const implPrompt = `Implementa la historia siguiendo este plan del Coordinador:
${JSON.stringify(plan, null, 2)}

${treeText}

# Contenido actual de los archivos relevantes
${filesCtx}

Entrega los cambios COMPLETOS: para cada archivo a crear o modificar incluye su contenido íntegro final (no fragmentos ni "...", el archivo se sobrescribirá con lo que entregues). Respeta las convenciones. Si un archivo es demasiado grande para reescribirlo entero, prefiere crear un módulo nuevo y un cambio mínimo en el existente. Mantén el alcance mínimo que cumpla el criterio de aceptación.

FORMATO DE RESPUESTA (texto plano, sin JSON ni bloques de código alrededor de los archivos):
${FILE_FORMAT}`;
    let implRes = await call(1, sys(dev, project, item), implPrompt, DEV_MAX_TOKENS);
    let implText = implRes.text;
    // Si la respuesta se cortó por longitud, pedimos continuar (hasta 2 veces) exactamente donde quedó.
    for (let i = 0; i < 2 && isTruncated(implRes.stopReason); i++) {
      if (isCancelled()) throw Object.assign(new Error('cancelado'), { cancelled: true });
      log({ step: 'Implementación', continuation: i + 1 }, 'respuesta cortada: se pide continuación');
      implRes = await call(1, sys(dev, project, item), 'Tu respuesta anterior se cortó por el límite de longitud. Continúa EXACTAMENTE desde el último carácter que escribiste, sin repetir nada de lo anterior, sin saludos ni explicaciones, manteniendo el mismo formato de marcadores.', DEV_MAX_TOKENS, [{ role: 'user', content: implPrompt }, { role: 'assistant', content: implText }]);
      implText += implRes.text;
    }
    const parsed = parseFileBlocks(implText);
    if (!parsed.changes.length) {
      const legacy = extractJson(implText);
      if (legacy && Array.isArray(legacy.changes)) { parsed.changes = legacy.changes.filter((c: any) => c && typeof c.path === 'string' && ['create', 'modify', 'delete'].includes(c.action)).map((c: any) => ({ path: c.path, action: c.action, content: typeof c.content === 'string' ? c.content : null })); parsed.summary = String(legacy.summary ?? ''); parsed.verify = Array.isArray(legacy.verifyCommands) ? legacy.verifyCommands : []; }
    }
    if (!parsed.changes.length) throw new Error(`El Desarrollador no entregó ningún archivo en el formato acordado${isTruncated(implRes.stopReason) ? ' (su respuesta se cortó por longitud incluso tras pedir continuación)' : ''}. Revisa su salida en el paso 2; puedes volver a ejecutar la historia con un criterio más acotado o un modelo con más salida.`);
    if (parsed.truncatedFile) throw new Error(`La respuesta del Desarrollador se cortó a mitad del archivo «${parsed.truncatedFile}» (se recibieron ${parsed.changes.length} archivo(s) completos). No se aplicará nada incompleto: vuelve a ejecutar la historia con un alcance más acotado o divide la historia.`);
    result.changes = annotateChanges(repo.path, parsed.changes);
    result.implementationSummary = parsed.summary + (parsed.notes ? `\n\n${parsed.notes}` : '');
    result.verifyCommands = parsed.verify.filter(c => ['typecheck', 'test', 'build'].includes(c));
    if (!result.verifyCommands.length) result.verifyCommands = ['typecheck'];
    procs.setResult(processId, result);

    // 3 · Revisión QA
    if (isCancelled()) throw Object.assign(new Error('cancelado'), { cancelled: true });
    const qa = agents.get(proc.steps[2].agentId)!;
    const diffs = result.changes.map(c => c.diff ?? '').join('\n\n').slice(0, 60_000);
    const revRes = await call(2, sys(qa, project, item),
      `Revisa los cambios propuestos para la historia frente al plan y al criterio de aceptación. Busca errores, incoherencias con las convenciones, riesgos de seguridad y qué pruebas deberían ejecutarse.
# Plan
${JSON.stringify(plan, null, 2)}
# Resumen del desarrollador
${result.implementationSummary}
# Diffs
${diffs}

Sé concreto y breve: "summary" en 3-5 frases, como máximo 8 "issues" y 6 "suggestedTests", cada uno de una línea.
Responde SOLO con JSON: {"approve": boolean, "summary": string, "issues": string[], "suggestedTests": string[]}`, 6000);
    result.review = parseReview(revRes.text, revRes.stopReason);
    procs.setResult(processId, result);
    knowledge.add({ projectId: project.id, title: `${item.storyId} · Plan e implementación propuesta — ${item.title}`, body: `# Plan\n${plan.summary}\n\n${plan.tasks.map(t => '- ' + t).join('\n')}\n\n# Implementación\n${result.implementationSummary}\n\nArchivos: ${result.changes.map(c => `${c.action} ${c.path}`).join(', ')}\n\n# Revisión QA\n${result.review.approve ? 'Aprobada' : 'Con observaciones'} — ${result.review.summary}\n${result.review.issues.map(i => '- ' + i).join('\n')}`, authorAgentId: coord.id, authorAgentName: coord.config.name, processId });
    backlog.setStatus(item.id, 'review', processId);
  } catch (e: any) {
    if (e?.cancelled) { finalStatus = 'cancelled'; } else if (e?.budget) { finalStatus = 'budget_exceeded'; finalError = e.message; } else { finalStatus = 'failed'; finalError = e.message; }
    for (const s of procs.get(processId)!.steps) if (s.status === 'pending') procs.stepFinish(s.id, 'skipped', { error: finalStatus === 'cancelled' ? 'cancelado por el usuario' : null });
    backlog.setStatus(item.id, 'pending', processId);
  } finally {
    involved.forEach(id => agents.setStatus(id, 'inactive'));
    procs.setResult(processId, result);
    procs.finish(processId, finalStatus, finalError);
    log({ processId, status: finalStatus, spent: procs.get(processId)?.spentUsd.toFixed(4) }, 'historia finalizada');
  }
}

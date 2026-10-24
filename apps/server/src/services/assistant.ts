import crypto from 'node:crypto';
import path from 'node:path';
import { REPO_ROOT } from '../config.ts';
import { expandHome } from '../routes/fs.ts';
import type { ModelInfo, ProviderId } from '@portal-ia/domain';
import { INTERNAL_WORKSPACE } from '@portal-ia/domain';
import { costUsd, estimatePricing, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { platform, providersRepo, workspacesRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, knowledgeRepo, processesRepo, projectsRepo, workspaceDb } from '../db/workspace.ts';
import { decryptSecret } from '../security/crypto.ts';
import { addManualItem } from './backlog.ts';
import { createCompany, createProject } from './companies.ts';
import { createStoryProcess, estimateStory } from './storyExecution.ts';
import { createDelegation, estimateDelegation } from './delegation.ts';

/**
 * Asistente global (lo encarna el «Asistente de Empresa» del espacio interno).
 * - Responde sobre el estado real; ejecuta acciones LOCALES gratuitas al instante (crear empresa/proyecto, añadir historias).
 * - Para lo que cuesta IA o escribe en el repositorio (ejecutar una historia, aplicar cambios) genera una PROPUESTA
 *   que el propietario autoriza en el propio chat (presupuesto + confirmación). Así el asistente sí puede llevar el
 *   proyecto adelante —incluido el código del propio Portal— sin saltarse la autorización.
 * - Cada mensaje consume una llamada; se aplica el límite mensual del agente. Admite imágenes adjuntas.
 */
platform.exec(`CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, actions_json TEXT, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, model TEXT, created_at TEXT NOT NULL
)`);
{ const cols = (platform.prepare(`PRAGMA table_info(assistant_messages)`).all() as any[]).map(c => c.name); if (!cols.includes('attachments_json')) platform.exec(`ALTER TABLE assistant_messages ADD COLUMN attachments_json TEXT`); }

export type AssistantActionType = 'create_company' | 'create_project' | 'add_backlog_item' | 'propose_execution' | 'propose_apply' | 'propose_delegation' | 'info';
export interface AssistantAction {
  type: AssistantActionType; status: 'done' | 'failed' | 'pending'; label: string; detail?: string; link?: string;
  /** propose_execution / propose_apply */
  processId?: string; workspaceSlug?: string; projectId?: string; storyId?: string; estimatedUsd?: number; suggestedBudgetUsd?: number; changes?: number;
}
export interface AssistantAttachment { name: string; mediaType: string; bytes: number }
export interface AssistantMessage { id: string; role: 'user' | 'assistant'; content: string; actions: AssistantAction[]; attachments: AssistantAttachment[]; tokensIn: number; tokensOut: number; costUsd: number; model: string | null; createdAt: string }

const mapMsg = (r: any): AssistantMessage => ({ id: r.id, role: r.role, content: r.content, actions: r.actions_json ? JSON.parse(r.actions_json) : [], attachments: r.attachments_json ? JSON.parse(r.attachments_json) : [], tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd, model: r.model, createdAt: r.created_at });

export const assistantRepo = {
  list(limit = 80): AssistantMessage[] { return (platform.prepare(`SELECT * FROM (SELECT * FROM assistant_messages ORDER BY created_at DESC LIMIT ?) ORDER BY created_at`).all(limit) as any[]).map(mapMsg); },
  add(m: Omit<AssistantMessage, 'id' | 'createdAt'>): AssistantMessage {
    const id = crypto.randomUUID(); const ts = new Date().toISOString();
    platform.prepare(`INSERT INTO assistant_messages (id, role, content, actions_json, attachments_json, tokens_in, tokens_out, cost_usd, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, m.role, m.content, JSON.stringify(m.actions), JSON.stringify(m.attachments), m.tokensIn, m.tokensOut, m.costUsd, m.model, ts);
    return { ...m, id, createdAt: ts };
  },
  updateActions(id: string, actions: AssistantAction[]) { platform.prepare(`UPDATE assistant_messages SET actions_json = ? WHERE id = ?`).run(JSON.stringify(actions), id); },
  get(id: string): AssistantMessage | undefined { const r = platform.prepare(`SELECT * FROM assistant_messages WHERE id = ?`).get(id); return r ? mapMsg(r) : undefined; },
  clear() { platform.exec(`DELETE FROM assistant_messages`); }
};

function assistantAgent() {
  const a = agentsRepo(INTERNAL_WORKSPACE.slug).list().find(x => x.key === 'ws-asistente');
  if (!a) throw Object.assign(new Error('El Asistente de Empresa no existe todavía (inicializa el espacio interno).'), { statusCode: 409 });
  return a;
}

export function assistantInfo() {
  const a = assistantAgent();
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const spent = (workspaceDb(INTERNAL_WORKSPACE.slug).prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c FROM execution_history WHERE agent_id = ? AND started_at >= ?`).get(a.id, monthStart.toISOString()) as any).c as number;
  const p = estimatePricing(a.config.provider, a.config.model);
  return { agentId: a.id, name: a.config.name, model: a.config.model, provider: a.config.provider, monthlyLimitUsd: a.config.monthlyLimitUsd, spentThisMonthUsd: spent, estimatedPerMessageUsd: (7000 * p.inPerM + 900 * p.outPerM) / 1_000_000 };
}

function platformSnapshot(): string {
  const lines: string[] = [];
  for (const ws of workspacesRepo.list()) {
    lines.push(`- Empresa «${ws.name}» (slug: ${ws.slug}${ws.kind === 'internal' ? ', espacio interno: aquí vive el propio Portal IA' : ''})`);
    const projects = projectsRepo(ws.slug); const agents = agentsRepo(ws.slug).list();
    lines.push(`  agentes de espacio: ${agents.filter(a => a.scope === 'workspace').map(a => a.config.name).join(', ') || 'ninguno'}`);
    for (const p of projects.list()) {
      const bl = backlogRepo(ws.slug).list(p.id); const procs = processesRepo(ws.slug).list(p.id); const repo = projects.repository(p.id);
      const foreign = repo && ws.kind === 'internal' && path.resolve(expandHome(repo.path)).toLowerCase() !== path.resolve(REPO_ROOT).toLowerCase();
      lines.push(`  · Proyecto «${p.name}» (slug: ${p.slug}) — repositorio: ${repo ? `${repo.path} (rama ${repo.branch ?? '?'})${foreign ? ` ⚠ NO es la carpeta desde la que corre este Portal (${REPO_ROOT}): las historias están detenidas hasta que el propietario pulse «Usar la carpeta de esta instalación» en el Panel` : ws.kind === 'internal' ? ' ✓ es la carpeta de este Portal (automejora real)' : ''}` : 'NO registrado (sin él no se pueden ejecutar historias)'}; agentes: ${agents.filter(a => a.projectId === p.id).map(a => a.config.name).join(', ') || 'ninguno'}`);
      lines.push(`    backlog (${bl.length}): ${bl.map(b => `${b.storyId} [${b.status}] ${b.title}`).join(' | ') || 'vacío'}`);
      const review = procs.filter(x => x.kind === 'story_execution' && x.status === 'done' && x.result && !x.result.applied && x.result.changes.length);
      const encargos = procs.filter(x => x.kind === 'delegated_task');
      if (encargos.length) lines.push(`    encargos: ${encargos.map(x => `${x.title} [${x.status}${x.delegation?.backlogOps.length ? `, ${x.delegation.backlogOps.length} propuestas al backlog${x.delegation.opsApplied ? ' aplicadas' : ' sin aplicar'}` : ''}]`).join(' | ')}`);
      lines.push(`    procesos: ${procs.length} (${procs.filter(x => x.status === 'running').length} en ejecución; ${review.length} con cambios pendientes de aplicar${review.length ? ': ' + review.map(x => `${x.title} (id ${x.id})`).join(', ') : ''}); conocimiento: ${knowledgeRepo(ws.slug).list(p.id).length} documentos`);
    }
  }
  return lines.join('\n');
}

const ACTION_SCHEMA = `# Acciones
Escribe tu respuesta en markdown breve y, si procede, termina con UN bloque:
\`\`\`actions
[ ...acciones JSON... ]
\`\`\`
Acciones locales (gratis, se ejecutan al instante):
- {"type":"create_company","name":string}
- {"type":"create_project","company":slug,"name":string,"description":string,"objectives":string[]}
- {"type":"add_backlog_item","company":slug,"project":slug,"title":string,"criterion":string,"description":string}
Acciones que requieren autorización del propietario (tú las PROPONES; el chat le muestra una tarjeta para autorizar con presupuesto):
- {"type":"execute_story","company":slug,"project":slug,"story":"HU-0xx"} → el equipo del proyecto (Coordinador, Desarrollador, QA) implementa la historia y entrega un diff.
- {"type":"apply_changes","company":slug,"processId":string} → escribe en una rama git los cambios de un proceso terminado.
- {"type":"delegate_task","company":slug,"project":slug|null,"agent":clave o nombre del agente responsable,"request":string} → ENCARGO: el agente responsable valida la petición, consulta a los agentes a su cargo si hace falta y entrega un resultado (documento en Conocimiento) con propuestas de cambio al backlog que el propietario aplica con un clic.
Cómo elegir: NO todo es una historia de desarrollo. Si el propietario pide implementar/corregir/añadir una funcionalidad concreta en el código → add_backlog_item (+ execute_story si pide hacerlo ya). Si pide revisar, replantear, repriorizar, analizar, evaluar, proponer, organizar, redactar, planificar, auditar o decidir algo (p. ej. «revisa y replantea el backlog», «propón la organización de la nueva empresa», «evalúa si conviene X», «redacta la política de Y») → delegate_task al agente responsable del ámbito: asuntos de un proyecto (backlog, arquitectura, calidad, diseño) → su Coordinador del Proyecto (pj-coordinador); organización de la empresa, varias áreas o nuevos equipos → Gestor Organizacional (ws-gestor); creación o configuración de agentes → Agente de Onboarding (ws-onboarding); o el agente especializado que el propietario nombre. Escribe "request" completo y claro con lo que el propietario quiere. Cuando el propietario pida "ejecuta", "haz", "implementa" una historia que no existe, añádela y propón ejecutarla en la misma respuesta. El equipo SÍ puede modificar el código del propio Portal IA; así se construye el producto.`;

export function parseResponse(text: string): { reply: string; actions: any[] } {
  const m = text.match(/```actions\s*([\s\S]*?)```\s*$/i) ?? text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```\s*$/i);
  if (m) { let actions: any[] = []; try { const v = JSON.parse(m[1]); actions = Array.isArray(v) ? v : Array.isArray(v?.actions) ? v.actions : []; } catch { /* bloque truncado: ignorar acciones */ } return { reply: text.slice(0, m.index).trim(), actions }; }
  // Compatibilidad: respuesta JSON completa {"reply","actions"}
  try { const j = JSON.parse(text.trim()); if (j && typeof j.reply === 'string') return { reply: j.reply, actions: Array.isArray(j.actions) ? j.actions : [] }; } catch { /* texto plano */ }
  const cut = text.match(/^\s*\{\s*"reply"\s*:\s*"((?:[^"\\]|\\.)*)/); // JSON legado cortado: rescatar el texto legible
  if (cut) { try { return { reply: JSON.parse(`"${cut[1]}"`), actions: [] }; } catch { return { reply: cut[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'), actions: [] }; } }
  return { reply: text.replace(/\{"reply"[\s\S]*$/, '').trim() || text, actions: [] };
}

function resolveCompany(ref: any) {
  const list = workspacesRepo.list(); const r = String(ref ?? '').trim().toLowerCase();
  const ws = list.find(w => w.slug === r) ?? list.find(w => w.name.toLowerCase() === r) ?? (!r || list.length === 1 ? list.find(w => w.kind === 'internal') ?? list[0] : undefined);
  if (!ws) throw new Error(`Empresa no encontrada: ${ref}`); return ws;
}
function resolveProject(slug: string, ref: any) {
  const list = projectsRepo(slug).list(); const r = String(ref ?? '').trim().toLowerCase();
  const p = list.find(x => x.id === r || x.slug === r) ?? list.find(x => x.name.toLowerCase() === r) ?? (list.length === 1 || !r ? list[0] : undefined);
  if (!p) throw new Error(`Proyecto no encontrado: ${ref}`); return p;
}
const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function resolveStory(slug: string, projectId: string, ref: any, exclude: Set<string> = new Set()) {
  const list = backlogRepo(slug).list(projectId).filter(b => !exclude.has(b.id)); const r = String(ref ?? '').trim().toLowerCase();
  const num = r.match(/(\d+)\s*$/)?.[1]; const n = num ? parseInt(num, 10) : NaN;
  const it = list.find(b => b.storyId.toLowerCase() === r)
    ?? (Number.isFinite(n) ? list.find(b => parseInt(b.storyId.replace(/\D+/g, ''), 10) === n) : undefined)
    ?? list.find(b => norm(b.title) === norm(r))
    ?? (r.length > 6 ? list.find(b => norm(b.title).includes(norm(r)) || norm(r).includes(norm(b.title))) : undefined);
  if (!it) throw new Error(`Historia no encontrada en el backlog: ${ref}`); return it;
}

/** Ejecuta acciones locales y construye propuestas para las que requieren autorización. */
export function performActions(actionsReq: any[]): AssistantAction[] {
  const actions: AssistantAction[] = [];
  for (const act of actionsReq.slice(0, 8)) {
    try {
      if (act.type === 'create_company') { const ws = createCompany(String(act.name ?? '')); actions.push({ type: 'create_company', status: 'done', label: `Empresa «${ws.name}» creada`, detail: 'Con sus 3 agentes de espacio, inactivos.', link: `/empresa/${ws.slug}/panel` }); }
      else if (act.type === 'create_project') { const ws = resolveCompany(act.company); const p = createProject(ws.slug, String(act.name ?? ''), String(act.description ?? ''), Array.isArray(act.objectives) ? act.objectives.map(String) : []); actions.push({ type: 'create_project', status: 'done', label: `Proyecto «${p.name}» creado en ${ws.name}`, detail: 'Con sus 5 agentes de proyecto, inactivos. Registra su repositorio para poder ejecutar historias.', link: `/empresa/${ws.slug}/proyecto/${p.id}/panel` }); }
      else if (act.type === 'add_backlog_item') { const ws = resolveCompany(act.company); const p = resolveProject(ws.slug, act.project); const it = addManualItem(ws.slug, p.id, { title: String(act.title ?? ''), criterion: act.criterion ? String(act.criterion) : undefined, description: act.description ? String(act.description) : undefined }); actions.push({ type: 'add_backlog_item', status: 'done', label: `${it.storyId} añadida al backlog de «${p.name}»`, detail: it.title, link: `/empresa/${ws.slug}/proyecto/${p.id}/backlog`, storyId: it.storyId, workspaceSlug: ws.slug, projectId: p.id }); }
      else if (act.type === 'execute_story') {
        const ws = resolveCompany(act.company); const p = resolveProject(ws.slug, act.project);
        // Si la historia se acaba de crear en esta misma respuesta, resuélvela por título.
        const proposed = new Set(actions.filter(a => a.type === 'propose_execution' && a.projectId === p.id && a.storyId).map(a => a.storyId!.toLowerCase()));
        let story; try { story = resolveStory(ws.slug, p.id, act.story); } catch (e) {
          // Referencia inválida (p. ej. id inventado): usar la historia creada en esta misma respuesta que aún no se haya propuesto.
          const created = actions.filter(a => a.type === 'add_backlog_item' && a.projectId === p.id && a.storyId && !proposed.has(a.storyId.toLowerCase()));
          const byTitle = created.find(a => a.detail && norm(a.detail) === norm(String(act.story ?? ''))) ?? created[0];
          if (!byTitle?.storyId) throw e; story = resolveStory(ws.slug, p.id, byTitle.storyId);
        }
        if (proposed.has(story.storyId.toLowerCase())) { actions.push({ type: 'info', status: 'done', label: `${story.storyId} ya estaba propuesta en esta respuesta`, detail: 'Se omite la propuesta duplicada.' }); continue; }
        const runningNow = processesRepo(ws.slug).running();
        if (runningNow.length) throw new Error(`Hay un proceso en ejecución («${runningNow[0].title}»). Las historias se ejecutan de una en una; vuelve a pedirlo cuando termine.`);
        const est = estimateStory(ws.slug, p.id, story.id);
        const proc = createStoryProcess(ws.slug, p.id, story.id);
        actions.push({ type: 'propose_execution', status: proc.status === 'pending_authorization' ? 'pending' : 'done', label: `Ejecutar ${story.storyId} · ${story.title}`, detail: `Coordinador → Desarrollador → QA sobre el repositorio registrado. Costo estimado ≈ ${est.estimatedUsd.toFixed(2)} USD.`, link: `/empresa/${ws.slug}/proyecto/${p.id}/procesos/${proc.id}`, processId: proc.id, workspaceSlug: ws.slug, projectId: p.id, storyId: story.storyId, estimatedUsd: est.estimatedUsd, suggestedBudgetUsd: est.suggestedBudgetUsd });
      }
      else if (act.type === 'delegate_task') {
        const ws = resolveCompany(act.company);
        let project = null; if (act.project) { try { project = resolveProject(ws.slug, act.project); } catch { project = null; } }
        const runningNow = processesRepo(ws.slug).running();
        if (runningNow.length) throw new Error(`Hay un proceso en ejecución («${runningNow[0].title}»). Vuelve a pedirlo cuando termine.`);
        const est = estimateDelegation(ws.slug, project?.id ?? null, act.agent, String(act.request ?? ''));
        const proc = createDelegation(ws.slug, project?.id ?? null, act.agent, String(act.request ?? ''));
        const lead = est.steps[0];
        actions.push({ type: 'propose_delegation', status: 'pending', label: `Encargo a ${lead.agentName}: ${String(act.request ?? '').slice(0, 80)}${String(act.request ?? '').length > 80 ? '…' : ''}`, detail: `${lead.agentName} valida el encargo${est.teamSize ? `, consulta hasta ${est.teamSize} agente(s) a su cargo` : ''} y entrega el resultado con propuestas. Costo estimado ≈ ${est.estimatedUsd.toFixed(2)} USD.`, link: `/empresa/${ws.slug}/proyecto/${proc.projectId}/procesos/${proc.id}`, processId: proc.id, workspaceSlug: ws.slug, projectId: proc.projectId, estimatedUsd: est.estimatedUsd, suggestedBudgetUsd: est.suggestedBudgetUsd });
      }
      else if (act.type === 'apply_changes') {
        const ws = resolveCompany(act.company); const proc = processesRepo(ws.slug).get(String(act.processId ?? ''));
        if (!proc || !proc.result) throw new Error('Proceso no encontrado');
        if (proc.result.applied) actions.push({ type: 'info', status: 'done', label: 'Esos cambios ya estaban aplicados', detail: `Rama ${proc.result.applied.branch} · commit ${proc.result.applied.commit}` });
        else actions.push({ type: 'propose_apply', status: 'pending', label: `Aplicar ${proc.result.changes.length} cambio(s) de «${proc.title}» en una rama git`, detail: 'Revisa el diff en el proceso antes de autorizar.', link: `/empresa/${ws.slug}/proyecto/${proc.projectId}/procesos/${proc.id}`, processId: proc.id, workspaceSlug: ws.slug, projectId: proc.projectId, changes: proc.result.changes.length });
      }
    } catch (e: any) { actions.push({ type: act.type === 'execute_story' ? 'propose_execution' : act.type === 'apply_changes' ? 'propose_apply' : act.type === 'delegate_task' ? 'propose_delegation' : (act.type ?? 'info'), status: 'failed', label: `No se pudo preparar «${act.type}»`, detail: e.message }); }
  }
  return actions;
}

export async function chat(userText: string, images: { mediaType: string; data: string; name?: string }[] = [], files: AssistantAttachment[] = []): Promise<{ user: AssistantMessage; assistant: AssistantMessage }> {
  const a = assistantAgent();
  const info = assistantInfo();
  if (info.spentThisMonthUsd >= info.monthlyLimitUsd) throw Object.assign(new Error(`El Asistente alcanzó su límite mensual (${info.monthlyLimitUsd.toFixed(2)} USD). Puedes ampliarlo en su ficha de Equipo de IA.`), { statusCode: 409 });
  const providerId = a.config.provider as ProviderId;
  const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
  if (!cred || prow.status !== 'connected') throw Object.assign(new Error('El proveedor del Asistente no está conectado.'), { statusCode: 409 });
  const models: ModelInfo[] = JSON.parse(prow.models_json);
  const attachments: AssistantAttachment[] = [...images.map((im, i) => ({ name: im.name ?? `imagen-${i + 1}`, mediaType: im.mediaType, bytes: Math.round(im.data.length * 0.75) })), ...files];
  const user = assistantRepo.add({ role: 'user', content: userText, actions: [], attachments, tokensIn: 0, tokensOut: 0, costUsd: 0, model: null });
  const history = assistantRepo.list(16).filter(m => m.id !== user.id).slice(-12).map(m => `${m.role === 'user' ? 'Propietario' : 'Asistente'}: ${m.content.slice(0, 1200)}${m.actions.length ? ` [acciones: ${m.actions.map(x => `${x.type}:${x.status}`).join(', ')}]` : ''}`).join('\n');
  const system = `Eres «${a.config.name}», ${a.template.role.toLowerCase()} de Portal IA, una plataforma local para gestionar empresas operadas por agentes de IA. Hablas con el propietario.
${a.config.specialization}
Qué es Portal IA: su primer cliente es él mismo; el proyecto «Desarrollo del Portal» del espacio interno tiene registrado el repositorio del propio Portal, y su equipo (Coordinador, Arquitecto, Desarrollador, Diseñador, QA) implementa mejoras ejecutando historias del backlog: producen un diff que el propietario aprueba y se aplica en una rama git. Por tanto, cualquier mejora del Portal (incluido este chat) se consigue añadiendo la historia y ejecutándola.
Principios: respuestas breves y concretas en español; nunca inventes datos: usa solo el estado real de abajo; nada con costo sin autorización (tú propones, el propietario autoriza en la tarjeta); si algo no existe aún, dilo y conviértelo en historia.
${ACTION_SCHEMA}

# Estado real de la plataforma
${platformSnapshot()}`;
  const prompt = `${history ? `# Conversación reciente\n${history}\n\n` : ''}Propietario: ${userText}${images.length ? `\n(adjunta ${images.length} imagen(es))` : ''}`;
  const startedAt = new Date().toISOString();
  try {
    const res = await getAdapter(providerId)!.complete(decryptSecret(cred.ciphertext), { workspaceId: prow.workspace_id }, {
      model: a.config.model, system, user: prompt, maxTokens: 3000, effort: a.config.effort, supportsEffort: !!models.find(m => m.id === a.config.model)?.supportsEffort, images
    });
    const cost = costUsd(providerId, a.config.model, res.inputTokens, res.outputTokens);
    processesRepo(INTERNAL_WORKSPACE.slug).logExecution({ projectId: '', agentId: a.id, kind: 'assistant_chat', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
    const { reply, actions: actionsReq } = parseResponse(res.text);
    const actions = performActions(actionsReq);
    const assistant = assistantRepo.add({ role: 'assistant', content: reply, actions, attachments: [], tokensIn: res.inputTokens, tokensOut: res.outputTokens, costUsd: cost, model: a.config.model });
    return { user, assistant };
  } catch (e) {
    processesRepo(INTERNAL_WORKSPACE.slug).logExecution({ projectId: '', agentId: a.id, kind: 'assistant_chat', status: 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt });
    const msg = e instanceof ProviderRequestError ? e.error.message : (e as Error).message;
    const assistant = assistantRepo.add({ role: 'assistant', content: `No pude responder: ${msg}`, actions: [], attachments: [], tokensIn: 0, tokensOut: 0, costUsd: 0, model: a.config.model });
    return { user, assistant };
  }
}

/** Marca una propuesta del chat como resuelta (autorizada/aplicada) para que la tarjeta no se repita. */
export function resolveProposal(messageId: string, processId: string, status: 'done' | 'failed', detail?: string) {
  const m = assistantRepo.get(messageId); if (!m) return;
  assistantRepo.updateActions(messageId, m.actions.map(a => a.processId === processId && a.status === 'pending' ? { ...a, status, detail: detail ?? a.detail } : a));
}

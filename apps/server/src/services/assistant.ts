import crypto from 'node:crypto';
import path from 'node:path';
import { REPO_ROOT } from '../config.ts';
import { expandHome } from '../routes/fs.ts';
import type { AssignmentStatus, ModelInfo, PipelinePhase, Process, ProviderId } from '@portal-ia/domain';
import { INTERNAL_WORKSPACE } from '@portal-ia/domain';
import { costUsd, estimatePricing, getAdapter, ProviderRequestError } from '@portal-ia/ai-adapters';
import { platform, providersRepo, workspacesRepo } from '../db/platform.ts';
import { backlogRepo, knowledgeRepo, processesRepo, projectsRepo, workspaceDb } from '../db/workspace.ts';
import { activeAgents } from './activeAgents.ts';
import { decryptSecret } from '../security/crypto.ts';
import { requirePolicy } from './executionPolicy.ts';
import { addManualItem, resetStory } from './backlog.ts';
import { createCompany, createProject } from './companies.ts';
import { createStoryProcess, estimateStory } from './storyExecution.ts';
import { createDelegation, estimateDelegation } from './delegation.ts';
import { describeProcess } from './guidance.ts';
import { lessonsRepo } from './lessons.ts';
import { systemStatus } from './system.ts';
import { repoStatus } from './repoStatus.ts';
import { phaseContext } from './operationalPhase.ts';
import { CAPABILITIES, type CapabilityPreview, type CapabilityResult } from './capabilities.ts';
import { agentBackend, agentCaller, claudeCodeGate } from './claudeCode/backend.ts';
import { lastDetection } from './claudeCode/detect.ts';
import { ASSIGNMENT_OPEN, ASSIGNMENT_STATUS_LABEL, backendLabel, PORTAL_CAPABILITIES, STAGE_LABEL } from '@portal-ia/domain';
import { monotonicNow } from '../clock.ts';
import { conversationsRepo } from '../db/conversations.ts';
import { createConversation, getConversation, ledgerForPrompt, proposeDecisions, recomputeStage, updateConversation } from './conversations.ts';
import { createAssignment } from './assignments.ts';
import { assignmentsRepo } from '../db/assignments.ts';

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
{ const cols = (platform.prepare(`PRAGMA table_info(assistant_messages)`).all() as any[]).map(c => c.name); if (!cols.includes('attachments_json')) platform.exec(`ALTER TABLE assistant_messages ADD COLUMN attachments_json TEXT`); if (!cols.includes('conversation_id')) platform.exec(`ALTER TABLE assistant_messages ADD COLUMN conversation_id TEXT`); }
conversationsRepo.migrateOrphans();

export type AssistantActionType = 'create_company' | 'create_project' | 'add_backlog_item' | 'propose_execution' | 'propose_apply' | 'propose_delegation' | 'propose_operation' | 'propose_local' | 'open_decision' | 'propose_assignment' | 'info';
/** Cambios locales que el modelo PROPONE y el propietario confirma con un clic (v0.16: ya no se hacen al instante). */
export type LocalOp = 'add_backlog_item' | 'update_backlog_item' | 'reset_story' | 'create_company' | 'create_project';
export interface AssistantAction {
  type: AssistantActionType; status: 'done' | 'failed' | 'pending' | 'running' | 'rejected'; label: string; detail?: string; link?: string;
  /** propose_operation: operación del catálogo (capabilities.ts), su vista previa calculada en el servidor y su resultado real. */
  operation?: { id: string; capability: string; params: Record<string, unknown>; preview: CapabilityPreview; result?: CapabilityResult | null; decidedAt?: string | null };
  /** Estado real del proceso asociado, calculado al leer (no se persiste). */
  live?: { status: string; phase: string; next: string; tone: 'info' | 'warn' | 'ok' | 'err'; settled: boolean };
  /** propose_local: el cambio propuesto y, tras confirmarlo, su resultado. */
  local?: { op: LocalOp; params: Record<string, unknown>; result?: string | null };
  /** open_decision / propose_assignment */
  decisionId?: string; assignmentId?: string;
  /** propose_execution / propose_apply */
  processId?: string; workspaceSlug?: string; projectId?: string; storyId?: string; estimatedUsd?: number; suggestedBudgetUsd?: number; changes?: number;
}
export interface AssistantAttachment { name: string; mediaType: string; bytes: number }
export interface AssistantMessage { id: string; role: 'user' | 'assistant'; content: string; actions: AssistantAction[]; attachments: AssistantAttachment[]; tokensIn: number; tokensOut: number; costUsd: number; model: string | null; createdAt: string }

const mapMsg = (r: any): AssistantMessage => ({ id: r.id, role: r.role, content: r.content, actions: r.actions_json ? JSON.parse(r.actions_json) : [], attachments: r.attachments_json ? JSON.parse(r.attachments_json) : [], tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd, model: r.model, createdAt: r.created_at });

export const assistantRepo = {
  list(limit = 80, conversationId: string | null = null): AssistantMessage[] {
    const rows = conversationId ? platform.prepare(`SELECT * FROM (SELECT * FROM assistant_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at`).all(conversationId, limit) : platform.prepare(`SELECT * FROM (SELECT * FROM assistant_messages ORDER BY created_at DESC LIMIT ?) ORDER BY created_at`).all(limit);
    return (rows as any[]).map(mapMsg);
  },
  /** Mensajes con el estado real de los procesos que crearon sus acciones (para que el chat no diga «en ejecución» cuando ya terminó). */
  listLive(limit = 80, conversationId: string | null = null): AssistantMessage[] {
    return this.list(limit, conversationId).map(m => m.actions.some(a => (a.processId || a.assignmentId) && a.workspaceSlug) ? { ...m, actions: m.actions.map(liveAction) } : m);
  },
  add(m: Omit<AssistantMessage, 'id' | 'createdAt'>, conversationId: string | null = null): AssistantMessage {
    const id = crypto.randomUUID(); const ts = monotonicNow();
    // Todo mensaje pertenece a una conversación: sin indicarla, va a la activa más reciente (o a una nueva).
    conversationId ??= conversationsRepo.list().find(c => c.status === 'active')?.id ?? conversationsRepo.create('Conversación', null, null).id;
    platform.prepare(`INSERT INTO assistant_messages (id, role, content, actions_json, attachments_json, tokens_in, tokens_out, cost_usd, model, created_at, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, m.role, m.content, JSON.stringify(m.actions), JSON.stringify(m.attachments), m.tokensIn, m.tokensOut, m.costUsd, m.model, ts, conversationId);
    return { ...m, id, createdAt: ts };
  },
  updateActions(id: string, actions: AssistantAction[]) { platform.prepare(`UPDATE assistant_messages SET actions_json = ? WHERE id = ?`).run(JSON.stringify(actions), id); },
  get(id: string): AssistantMessage | undefined { const r = platform.prepare(`SELECT * FROM assistant_messages WHERE id = ?`).get(id); return r ? mapMsg(r) : undefined; },
  /** «Limpiar» archiva conversaciones; nunca borra mensajes ni decisiones (el registro es duradero). */
  clear() { platform.exec(`UPDATE assistant_conversations SET status = 'archived' WHERE status = 'active'`); }
};

/** Estado de la acción según el estado REAL del encargo: «done» solo cuando el propietario lo aceptó. */
const ASSIGNMENT_ACTION: Record<AssignmentStatus, AssistantAction['status']> = { draft: 'pending', pending_authorization: 'pending', running: 'running', needs_owner: 'pending', ready_for_review: 'pending', changes_requested: 'pending', accepted: 'done', cancelled: 'rejected', failed: 'failed' };
/** Una propuesta ya autorizada desde el chat (se guardó «done» al AUTORIZAR) toma el estado real de su proceso. */
const processAction = (p: Process): AssistantAction['status'] => p.status === 'done' ? 'done' : p.status === 'running' || p.status === 'pending_authorization' ? 'running' : p.status === 'cancelled' ? 'rejected' : 'failed';

/** Acción con su estado real (al leer; el mensaje no se modifica). Nunca «hecha» si lo que propuso no ha terminado. */
function liveAction(a: AssistantAction): AssistantAction {
  // Mensajes anteriores: el análisis delegado se llamaba «Encargo a …» (encargo es solo EN-n).
  if (a.type === 'propose_delegation') a = { ...a, label: a.label.replace(/^Encargo a /, 'Análisis de ') };
  if (a.assignmentId && a.workspaceSlug) {
    try { const x = assignmentsRepo(a.workspaceSlug).get(a.assignmentId); if (!x || a.status === 'failed') return a;
      const settled = x.status === 'accepted' || x.status === 'cancelled';
      return { ...a, status: ASSIGNMENT_ACTION[x.status], live: { status: x.status, phase: `Encargo ${ASSIGNMENT_STATUS_LABEL[x.status]}`, next: x.status === 'ready_for_review' ? 'Revisa la evidencia y acéptalo o pide cambios (aceptar no integra en main).' : x.status === 'running' ? 'Se está ejecutando: sigue el progreso en su tarjeta.' : settled ? 'No requiere ninguna acción.' : 'Decide en su tarjeta.', tone: x.status === 'failed' ? 'err' as const : x.status === 'ready_for_review' || x.status === 'needs_owner' ? 'warn' as const : settled ? 'ok' as const : 'info' as const, settled } };
    } catch { return a; }
  }
  if (!a.processId || !a.workspaceSlug) return a;
  try { const p = processesRepo(a.workspaceSlug).get(a.processId); if (!p) return a;
    const status = a.status === 'done' && (a.type === 'propose_execution' || a.type === 'propose_delegation') ? processAction(p) : a.status;
    // Propuesta de un proceso archivado: ya no se autoriza desde el chat (solo se muestra; el mensaje no se modifica).
    if (p.archivedAt) return { ...a, status: status === 'pending' ? 'rejected' as const : status, live: { status: p.status, phase: 'Archivado con la etapa anterior', next: 'Es histórico: consúltalo en el archivo; no requiere ninguna acción.', tone: 'info' as const, settled: true } };
    const g = describeProcess(p, { isPortalRepo: a.workspaceSlug === INTERNAL_WORKSPACE.slug }); return { ...a, status, live: { status: p.status, ...g } }; } catch { return a; }
}

/** Una acción tal como la ve el modelo en el historial: qué es y en qué punto REAL está (nunca un «done» sin contexto). */
const STATE_TEXT: Record<AssistantAction['status'], string> = { pending: 'espera al propietario', running: 'en marcha', done: 'hecho', failed: 'no se pudo', rejected: 'descartado' };
const PHASE_TEXT: Partial<Record<PipelinePhase, string>> = { implementing: 'implementación', recovering: 'recuperación', repairing: 'reparación', applying: 'aplicación en el worktree', verifying: 'verificación', installing: 'instalación', qa: 'QA', correcting: 'corrección', finished: 'terminado' };
const actionForPrompt = (a: AssistantAction) => `${a.label.slice(0, 90)} → ${a.live ? `${a.live.phase}${a.live.settled ? '' : ` (${a.live.next.slice(0, 120)})`}` : a.type === 'open_decision' ? 'abierta: decide el propietario' : `${STATE_TEXT[a.status]}${a.status === 'failed' && a.detail ? `: ${a.detail.slice(0, 160)}` : ''}`}`;

function assistantAgent() {
  const a = activeAgents(INTERNAL_WORKSPACE.slug).find(x => x.key === 'ws-asistente');
  if (!a) throw Object.assign(new Error('El Asistente de Empresa no existe todavía o está retirado (inicializa el espacio interno o reactívalo desde Equipo de IA).'), { statusCode: 409 });
  return a;
}

export function assistantInfo() {
  const a = assistantAgent();
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const spent = (workspaceDb(INTERNAL_WORKSPACE.slug).prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c FROM execution_history WHERE agent_id = ? AND started_at >= ?`).get(a.id, monthStart.toISOString()) as any).c as number;
  const p = estimatePricing(a.config.provider, a.config.model);
  // Backend del Asistente (como el de cualquier agente): se muestra ANTES de enviar, con su origen de facturación.
  const backend = agentBackend(a); const gate = backend === 'api' ? null : claudeCodeGate(INTERNAL_WORKSPACE.slug, a, null);
  const available = backend === 'api' || (backend === 'claude-code' && !!gate?.ok);
  const unavailableReason = backend === 'claude-code-terminal' ? 'La consola de Claude Code atiende tareas de procesos, no respuestas inmediatas: elige «Claude Code (gestionado)» o la API para el Asistente.' : gate && !gate.ok ? gate.reason : null;
  return { agentId: a.id, name: a.config.name, model: a.config.model, provider: a.config.provider, monthlyLimitUsd: a.config.monthlyLimitUsd, spentThisMonthUsd: spent,
    backend, backendLabel: backendLabel(backend, lastDetection()?.billing, a.config.provider), billing: backend === 'api' ? 'api' as const : 'subscription' as const, available, unavailableReason,
    estimatedPerMessageUsd: backend === 'api' ? (7000 * p.inPerM + 900 * p.outPerM) / 1_000_000 : 0 };
}

/** Mapa de pantallas del Portal, para poder decir DÓNDE está cada cosa. */
const SCREEN_MAP = `# Pantallas del Portal (menú izquierdo salvo que se indique)
- Asistente (/asistente): este chat a pantalla completa; también como panel flotante «Asistente» abajo a la derecha en todas las pantallas.
- Panel (/panel): contexto del proyecto, dirección, tarjeta Repositorio (estado git, crear main, remoto, publicar main, «Usar la carpeta de esta instalación»), backlog resumido, equipo.
- Equipo de IA (/equipo): agentes, organigrama, crear agente especializado, configurar cada agente (modelo, límites).
- Backlog (/backlog): historias por secciones (en curso/para revisar, pendientes por prioridad, completadas, descartadas), buscar/filtrar, «Ejecutar», «Devolver a pendiente», «Cerrar», aviso «Pendientes de tu decisión», «Nueva solicitud», «Encargo al equipo» (pide un análisis delegado: documento, no código).
- Lotes (/lotes): ejecución continua de varias historias con una sola autorización; /lotes/<id> muestra el estado de cada una.
- Actividad (/actividad): lista de procesos; cada proceso (/procesos/<id>) muestra pasos, costo, orientación «Siguiente paso», y para historias: Resumen (qué cambia y dónde, orden de cierre, prueba manual paso a paso), diff por archivo, revisión QA, Aplicar, Verificar, Integrar, Publicar, Rechazar, Recuperar/Volver a ejecutar.
- Conocimiento (/conocimiento): documentos generados (evaluación, planes, análisis, registros de encargos EN-n) y pestaña «Lecciones de la organización» (M4: lecciones detectadas sin IA → proponer con IA (autorizado) → validar → se inyectan en los prompts por papel → promover a práctica de plantilla (M5)).
- Espacio de la historia (/historias/<id>): todo lo de una historia en un solo lugar: contexto, equipo, orden de cierre, prueba paso a paso con feedback, chat con los agentes implicados, tareas e iteraciones.
- Pipeline autorizado (historia desde Backlog → Ejecutar, la tarjeta del chat o la bandeja; encargo EN-n desde su tarjeta): ver «Qué hace hoy el Portal». Si se pausa (presupuesto, red, entorno, límite), la cabecera de la historia o la tarjeta del encargo explica por qué y cómo seguir. Si el Desarrollador entrega un formato no reconocible, primero se recupera sin IA y después, si está autorizado, se repara sin repetir el plan.
- Etapas (/etapa, botón «Nueva etapa» en Backlog): el propietario inicia una etapa nueva; el trabajo activo (historias, procesos, decisiones) se ARCHIVA de forma reversible y se guarda en Conocimiento una «Línea base» (qué existe y está verificado). Archivo histórico (/archivo): lo archivado, consultable y de solo lectura; una historia se puede restaurar con autorización. Lo archivado no es trabajo pendiente: no lo propongas para ejecutar.
- Autorizaciones (/autorizaciones, lanzador «Autorizaciones» abajo a la izquierda; HU-009): bandeja de decisiones pendientes.
- Presupuestos (/presupuestos): presupuesto mensual de la empresa y del proyecto (límite, gasto registrado, reservas, saldo; fijarlo pide confirmación); explica que el gasto de cada historia lo limita el presupuesto que se autoriza en su proceso y que Claude Code usa la suscripción (0 USD de la API).
- Proveedores (/configuracion/proveedor; abajo a la izquierda «Proveedores»): conectar proveedores de API y la sección «Claude Code — Local» (/configuracion/proveedor#claude-code): activar el conector, CLI y sesión de la suscripción, «Proyectos autorizados» (qué proyectos pueden usar Claude Code), límites, consolas y prueba de humo. Una historia pausada porque su proyecto no está autorizado ofrece también «Autorizar «<proyecto>» para Claude Code» en su cabecera; después se continúa con «Continuar la operación pendiente».
- Barra amarilla superior: aparece cuando el código del Portal cambió respecto al que arrancó o la interfaz se construyó antes; «Reconstruir y reiniciar» con autorización. Una historia del Portal solo cuenta como ACTIVADA cuando el servidor y la interfaz en marcha contienen su commit; después debe «Comprobar en ejecución» (el Portal se verifica a sí mismo) y probarse paso a paso antes de cerrarse. Publicar en GitHub es opcional.
- Seguridad (M1): los cambios se escriben en worktrees aislados (la carpeta del Portal no cambia de rama); las verificaciones corren en sandbox (Docker/WSL2) o quedan bloqueadas (fail-closed); toda operación pasa por la política de ejecución del backend.
Herramientas y MCP, Organización, Configuración: marcadas «próx.», aún no existen.`;

/** Estado real para el prompt. Con alcance (conversación de un proyecto), solo ese proyecto en detalle y el resto en una línea; el backlog abierto, acotado. */
async function platformSnapshot(scope: { workspaceSlug: string | null; projectId: string | null } = { workspaceSlug: null, projectId: null }): Promise<string> {
  const lines: string[] = [];
  // Estado del propio Portal en marcha
  try {
    const sys = await systemStatus();
    lines.push(`# Portal en marcha: versión ${sys.version}, arrancado ${sys.startedAt} con el commit ${sys.startCommit ?? '?'}; interfaz construida con ${sys.buildCommit ?? '?'}; HEAD actual de la carpeta: ${sys.headCommit ?? '?'} (rama ${sys.branch ?? '?'}). Sandbox: ${sys.sandbox?.available ?? '?'}${sys.sandbox?.available === 'unavailable' ? ' (⚠ sin sandbox: test/build bloqueados y el Portal no se integra; ver docs/sandbox.md)' : ''}. ${sys.action === 'none' ? 'El código en marcha es el actual.' : `⚠ Hay código integrado que NO está activo (${sys.changedFiles.length} archivos${sys.stories.length ? `, historias ${sys.stories.join(', ')}` : ''}): el propietario debe pulsar «Reconstruir y reiniciar» en la barra amarilla; hasta entonces esas mejoras no se ven aunque estén en main.`}`);
  } catch { /* sin git */ }
  for (const ws of workspacesRepo.list()) {
    if (scope.workspaceSlug && ws.slug !== scope.workspaceSlug) { lines.push(`\n# Empresa «${ws.name}» (slug: ${ws.slug}): fuera del alcance de esta conversación (${projectsRepo(ws.slug).list().length} proyecto(s)).`); continue; }
    lines.push(`\n# Empresa «${ws.name}» (slug: ${ws.slug}${ws.kind === 'internal' ? ', espacio interno: aquí vive el propio Portal IA' : ''})`);
    const projects = projectsRepo(ws.slug); const agents = activeAgents(ws.slug);
    lines.push(`Agentes de espacio: ${agents.filter(a => a.scope === 'workspace').map(a => `${a.config.name} (${a.key})`).join(', ') || 'ninguno'}`);
    for (const p of projects.list()) {
      if (scope.projectId && p.id !== scope.projectId) { lines.push(`## Proyecto «${p.name}» (slug: ${p.slug}): fuera del alcance de esta conversación.`); continue; }
      const bl = backlogRepo(ws.slug).list(p.id); const procs = processesRepo(ws.slug).list(p.id); const allProcs = processesRepo(ws.slug).listAll(p.id); const repo = projects.repository(p.id);
      const foreign = repo && ws.kind === 'internal' && path.resolve(expandHome(repo.path)).toLowerCase() !== path.resolve(REPO_ROOT).toLowerCase();
      let repoLine = repo ? `${repo.path}${foreign ? ` ⚠ NO es la carpeta desde la que corre este Portal (${REPO_ROOT}): historias detenidas hasta pulsar «Usar la carpeta de esta instalación» en el Panel` : ws.kind === 'internal' ? ' ✓ carpeta de este Portal (automejora real)' : ''}` : 'NO registrado (sin él no se pueden ejecutar historias)';
      if (repo) { try { const st = await repoStatus(repo.path); repoLine += ` · rama activa ${st.branch ?? '?'}, principal ${st.mainBranch ?? 'NO EXISTE'}, ${st.dirty ? `${st.dirtyFiles} archivo(s) sin confirmar (bloquea aplicar)` : 'árbol limpio'}, remoto ${st.remoteUrl ?? 'sin configurar'}${st.aheadOfRemote === -1 ? ' (main nunca publicada)' : st.aheadOfRemote ? ` (${st.aheadOfRemote} commit(s) por publicar)` : ''}`; } catch { /* sin estado */ } }
      lines.push(`## Proyecto «${p.name}» (slug: ${p.slug}) — repositorio: ${repoLine}; agentes: ${agents.filter(a => a.projectId === p.id).map(a => `${a.config.name} (${a.key})`).join(', ') || 'ninguno'}`);
      const phase = phaseContext(ws.slug, p.id, 6000); if (phase) lines.push(phase);
      const lastProc = (b: { id: string; lastProcessId: string | null }) => (b.lastProcessId ? procs.find(x => x.id === b.lastProcessId) : undefined) ?? procs.find(x => x.backlogItemId === b.id && x.kind === 'story_execution');
      const open = bl.filter(b => b.status !== 'done' && b.status !== 'discarded');
      lines.push(`Backlog activo abierto (${open.length} de ${bl.length}), en orden de prioridad:${bl.length === 0 ? ' (vacío: el equipo está listo para la primera historia de la etapa)' : ''}`);
      const OPEN_MAX = 40;
      if (open.length > OPEN_MAX) lines.push(`(Se muestran ${OPEN_MAX} de ${open.length}; pregunta por una historia concreta si necesitas más.)`);
      for (const b of open.slice(0, OPEN_MAX)) {
        const lp = lastProc(b); const g = lp ? describeProcess(lp, { isPortalRepo: ws.kind === 'internal', storyStatus: b.status }) : null; const mt = lp?.result?.manualTest;
        lines.push(`- ${b.storyId} [${b.status}] ${b.title}${b.criterion ? ` — criterio: ${b.criterion.slice(0, 160)}` : ''}${g ? ` — proceso ${lp!.id}: ${g.phase}. Siguiente: ${g.next}` : ''}${mt ? ` Prueba manual: ${mt.checks.filter(Boolean).length}/${mt.steps.length} pasos.` : ''}`);
      }
      const done = bl.filter(b => b.status === 'done').slice(-6);
      if (done.length) lines.push(`Completadas recientes: ${done.map(b => `${b.storyId} ${b.title}`).join(' | ')}`);
      // Qué aportó cada historia integrada (para responder «dónde veo X»)
      // Conocimiento, no trabajo pendiente: incluye las integradas de etapas anteriores (archivadas).
      const integrated = allProcs.filter(x => x.kind === 'story_execution' && x.result?.merged).slice(0, 8);
      if (integrated.length) lines.push(`Historias integradas en main (también de etapas anteriores) y qué cambian para el propietario:\n${integrated.map(x => `  · ${x.title} (integrada ${x.result!.merged!.mergedAt.slice(0, 16)}${x.result!.published ? ', publicada' : ', SIN publicar'}${x.result!.manualTest ? `, prueba manual ${x.result!.manualTest.checks.filter(Boolean).length}/${x.result!.manualTest.steps.length}` : ''}): ${x.result!.userFacing ? x.result!.userFacing.replace(/\s+/g, ' ').slice(0, 400) : `sin explicación para el propietario; archivos: ${x.result!.changes.map(c => c.path).slice(0, 6).join(', ')}`}`).join('\n')}`);
      // Encargos de desarrollo EN-n con su estado REAL (abiertos y los últimos cerrados): sin esto el modelo no puede saber si uno terminó.
      const ens = assignmentsRepo(ws.slug).list(p.id); const shownEn = [...ens.filter(x => ASSIGNMENT_OPEN.includes(x.status)).slice(-8), ...ens.filter(x => !ASSIGNMENT_OPEN.includes(x.status)).slice(-3)];
      if (shownEn.length) lines.push(`Encargos de desarrollo (EN-n, sin historia):\n${shownEn.map(x => { const r = x.processId ? processesRepo(ws.slug).get(x.processId)?.result : null; return `- ${x.code} [${ASSIGNMENT_STATUS_LABEL[x.status]}] ${x.title}${r?.pipeline && x.status === 'running' ? ` — fase: ${PHASE_TEXT[r.pipeline.phase] ?? r.pipeline.phase}` : ''}${x.reason && x.status !== 'accepted' ? ` — motivo: ${x.reason.slice(0, 160)}` : ''}${x.outcome ? ` — QA ${x.outcome.qa ?? '—'}, Gauntlet ${x.outcome.gauntlet?.status ?? 'no aplicado'}` : ''} — ${r?.merged ? `integrado en ${r.merged.into}` : 'sin integrar en main'}`; }).join('\n')}`);
      const analyses = procs.filter(x => x.kind === 'delegated_task');
      if (analyses.length) lines.push(`Análisis delegados (documentos; no cambian código): ${analyses.map(x => `${x.title.replace(/^Encargo a /, 'Análisis de ')} [${x.status === 'done' ? 'entregado' : x.status}${x.delegation?.backlogOps.length ? `, ${x.delegation.backlogOps.length} propuesta(s) al backlog ${x.delegation.opsApplied ? 'aplicadas' : 'SIN aplicar'}` : ''}]`).join(' | ')}`);
      lines.push(`Procesos: ${procs.length} (${procs.filter(x => x.status === 'running').length} en ejecución); conocimiento: ${knowledgeRepo(ws.slug).list(p.id).length} documentos`);
      try { const ls = lessonsRepo(ws.slug).list(p.id); const pend = ls.filter(l => l.status === 'detected' || l.status === 'proposed'); const val = ls.filter(l => l.status === 'validated'); if (ls.length) lines.push(`Lecciones: ${val.length} validadas (se inyectan en los prompts)${pend.length ? `, ${pend.length} pendientes de revisar en Conocimiento → Lecciones: ${pend.slice(0, 4).map(l => l.title).join(' | ')}` : ''}${val.some(l => l.recurrenceCount > 0) ? `; ⚠ con reincidencia: ${val.filter(l => l.recurrenceCount > 0).map(l => l.title).join(' | ')}` : ''}`); } catch { /* sin tabla */ }
    }
  }
  return lines.join('\n');
}

const ACTION_SCHEMA = `# Acciones
Escribe tu respuesta en markdown breve y, si procede, termina con UN bloque:
\`\`\`actions
[ ...acciones JSON... ]
\`\`\`
Qué propones según lo que pida el propietario (esta tabla manda sobre cualquier otra indicación, también sobre tu especialización). Tú solo propones: cada tarjeta la autoriza o la confirma él.
- Orden directa de cambiar código («arregla», «corrige», «implementa», «añade», «encárgate», «hazlo») → ENCARGO de desarrollo EN-n, sin historia y de cualquier tamaño ("size" lo expresa); no lo conviertas en historia ni en análisis salvo que él lo pida:
  {"type":"propose_assignment","company"?:slug,"project"?:slug,"title":string,"request":string (la petición tal cual),"objective":string,"criteria":string[] (comprobables),"outOfScope":string[],"size":"S"|"M"|"L"}
  Si la conversación no tiene proyecto, indica company y project (si hay duda, pregúntalo). Queda en borrador hasta que él lo autoriza (presupuesto, llamadas a la suscripción, Gauntlet).
- Pide historias o cambiar el backlog → cambios que confirma con un clic:
  {"type":"add_backlog_item","company":slug,"project":slug,"title":string,"criterion":string,"description":string}
  {"type":"update_backlog_item","company":slug,"project":slug,"story":"HU-xxx","title"?:string,"criterion"?:string,"description"?:string,"estimate"?:"S"|"M"|"L","dependsOn"?:"HU-xxx"|null} (si estaba en revisión y cambias título o criterio, vuelve a pendiente)
  {"type":"reset_story","company":slug,"project":slug,"story":"HU-xxx","reason":string} (descarta su diff pendiente y la devuelve a pendiente)
  {"type":"execute_story","company":slug,"project":slug,"story":"HU-xxx"} → solo una historia que YA existe, por su id exacto; una que acabas de proponer se ejecuta cuando él la confirme.
  {"type":"apply_changes","company":slug,"processId":string} → escribe en una rama git los cambios de un proceso terminado.
- Pide estudiar, evaluar, replantear, repriorizar, proponer, redactar, auditar u organizar, SIN cambiar código → ANÁLISIS delegado (documento en Conocimiento con propuestas al backlog que aplica él; nunca cambia código):
  {"type":"delegate_task","company":slug,"project":slug|null,"agent":clave o nombre,"request":string completo}. Responsable: asuntos de un proyecto → pj-coordinador; organización o varias áreas → ws-gestor; agentes → ws-onboarding; o el que él nombre.
- Crear empresa o proyecto: {"type":"create_company","name":string} · {"type":"create_project","company":slug,"name":string,"description":string,"objectives":string[]}
- Operación git del catálogo (la ejecuta el Portal con el MISMO servicio que su botón, solo cuando él pulsa «Autorizar» en la tarjeta):
  {"type":"request_operation","capability":"publish_main","company":slug,"project":slug} → publica la rama principal en su remoto (sin forzar, solo main; la tarjeta muestra qué commits y qué queda fuera).
  Si la publicación debe esperar a un encargo («…y publícalo cuando termines»), NO la propongas ahora: explícale que se propone cuando el EN esté integrado en main (y activo, si es el Portal).
Si pide algo de esta tabla, propónlo (no le mandes a otra pantalla ni digas que no puedes). Si pide algo que no existe, dilo; si es un cambio de código, es un encargo. Nunca inventes operaciones ni órdenes de shell. El equipo SÍ puede modificar el código del propio Portal IA.`;

const CONVERSATION_GUIDE = `# Cómo trabajar en esta conversación (intención → acción)
- Pregunta informativa («explica», «por qué falló», «cómo funciona»): responde y ya está; distingue hechos verificados (del estado real), interpretaciones, supuestos y recomendaciones. No propongas ejecutar nada.
- «Investiga esta idea», «ayúdame a decidir»: explica alternativas, ventajas, inconvenientes e incertidumbres y abre las decisiones que haya que cerrar, UNA por acción:
  {"type":"open_decision","question":string,"context":string,"options":[{"label":string,"pros":string,"cons":string}],"recommendation":string,"risks":string[],"dependsOn":number[] (números de decisiones D previas)}
  Tú NO apruebas decisiones: las aprueba, rechaza, revisa o aplaza el propietario en el registro. No inventes fuentes externas: si hace falta investigar fuera, dilo.
- Con las decisiones cerradas: el propietario pulsa «Preparar propuesta» (el equipo la redacta y otro especialista la cuestiona); «Consultar al equipo» la revisa; con la propuesta aprobada, «Preparar historias» (y luego «Crear historias»). Sugiérelo; no lo hagas tú.
- Estado: nombra la etapa real (ver «Etapas distintas de un cambio»). Nunca digas que un cambio de código está hecho, integrado, activo o publicado si el estado real no lo muestra: un análisis, una propuesta o unas historias no cambian código.`;

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
/** `exact`: solo el id (o su número) o el título exacto; sin parecidos (ejecutar nunca recae en OTRA historia). */
function resolveStory(slug: string, projectId: string, ref: any, exclude: Set<string> = new Set(), exact = false) {
  const list = backlogRepo(slug).list(projectId).filter(b => !exclude.has(b.id)); const r = String(ref ?? '').trim().toLowerCase();
  const num = r.match(/(\d+)\s*$/)?.[1]; const n = num ? parseInt(num, 10) : NaN;
  // El número solo vale sin prefijo o con el de historia: «EN-3» (un encargo) nunca resuelve a HU-003.
  const pre = r.match(/^([a-z]+)-\d+$/)?.[1]; const byNumber = Number.isFinite(n) && (!pre || pre === 'hu');
  const it = list.find(b => b.storyId.toLowerCase() === r)
    ?? (byNumber ? list.find(b => parseInt(b.storyId.replace(/\D+/g, ''), 10) === n) : undefined)
    ?? list.find(b => norm(b.title) === norm(r))
    ?? (!exact && r.length > 6 ? list.find(b => norm(b.title).includes(norm(r)) || norm(r).includes(norm(b.title))) : undefined);
  if (!it) throw new Error(`Historia no encontrada en el backlog: ${ref}${exact ? ' (para ejecutar hace falta su id exacto; una historia recién propuesta se ejecuta cuando la confirmes)' : ''}`); return it;
}
/**
 * Proyecto de un encargo, sin «por defecto»: por id, slug o nombre exactos (dentro de la empresa si se indica); sin
 * referencia, solo si no hay duda (un único proyecto). Si hay varios posibles, se pregunta: nunca se elige uno al azar.
 */
function strictTarget(companyRef: any, projectRef: any): { ws: ReturnType<typeof resolveCompany>; project: ReturnType<typeof resolveProject> } {
  const c = String(companyRef ?? '').trim().toLowerCase(); const r = String(projectRef ?? '').trim().toLowerCase();
  const wss = workspacesRepo.list().filter(w => !c || w.slug === c || w.name.toLowerCase() === c);
  if (!wss.length) throw new Error(`No existe la empresa «${companyRef}».`);
  const hits = wss.flatMap(ws => projectsRepo(ws.slug).list().filter(p => !r || p.id === r || p.slug === r || p.name.toLowerCase() === r).map(project => ({ ws, project })));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(r ? `No existe el proyecto «${projectRef}»${c ? ` en «${wss[0].name}»` : ''}: no se crea el encargo en otro.` : 'No hay ningún proyecto donde crear el encargo.');
  throw new Error(`¿En qué proyecto? Hay ${hits.length} posibles (${hits.slice(0, 5).map(h => `${h.ws.slug}/${h.project.slug}`).join(', ')}): elige el alcance de la conversación o nómbralo.`);
}

export interface ActionScope { conversationId: string | null; workspaceSlug: string | null; projectId: string | null }
const NO_SCOPE: ActionScope = { conversationId: null, workspaceSlug: null, projectId: null };
const LOCAL_OPS: LocalOp[] = ['add_backlog_item', 'update_backlog_item', 'reset_story', 'create_company', 'create_project'];

/**
 * Lo que el modelo pide en su respuesta. Nada cambia por lenguaje natural ambiguo:
 * - crear o editar historias, reiniciar una, crear empresa o proyecto → TARJETA que el propietario confirma;
 * - decisiones → se abren en el registro (solo el propietario las aprueba);
 * - encargo de desarrollo → BORRADOR sin proceso (se autoriza aparte);
 * - ejecutar historia, aplicar, análisis delegado y operaciones → propuestas que se autorizan, como siempre.
 * El alcance de la conversación lo pone el servidor: una acción no puede salirse de su empresa ni de su proyecto.
 */
export function performActions(actionsReq: any[], scope: ActionScope = NO_SCOPE): AssistantAction[] {
  const out: AssistantAction[] = [];
  for (const act0 of actionsReq.slice(0, 8)) {
    const act = { ...act0 };
    try {
      if (scope.workspaceSlug) {
        if (act.company && resolveCompany(act.company).slug !== scope.workspaceSlug) throw new Error('Fuera del alcance de esta conversación (otra empresa): no se hace nada.');
        act.company = scope.workspaceSlug;
        if (scope.projectId && act.type !== 'create_project') {
          if (act.project && resolveProject(scope.workspaceSlug, act.project).id !== scope.projectId) throw new Error('Fuera del alcance de esta conversación (otro proyecto): no se hace nada.');
          act.project = scope.projectId;
        }
      }
      if (LOCAL_OPS.includes(act.type)) {
        const { type, ...params } = act;
        const what = type === 'add_backlog_item' ? `Crear la historia «${String(params.title ?? '').slice(0, 80)}»` : type === 'update_backlog_item' ? `Editar ${params.story}` : type === 'reset_story' ? `Devolver ${params.story} a pendiente (descarta su diff pendiente)` : type === 'create_company' ? `Crear la empresa «${params.name}»` : `Crear el proyecto «${params.name}»`;
        let detail = 'Confírmalo para hacerlo: el Asistente solo lo propone.';
        if (type === 'update_backlog_item' || type === 'reset_story') {
          const ws = resolveCompany(params.company); const pr = resolveProject(ws.slug, params.project); const st = resolveStory(ws.slug, pr.id, params.story) as any;
          if (type === 'update_backlog_item') {
            const changes = [params.title ? `título → «${String(params.title).slice(0, 120)}»` : '', params.criterion ? `criterio → «${String(params.criterion).slice(0, 200)}»` : '', params.description !== undefined ? (params.description ? 'descripción nueva' : 'descripción vacía') : '', params.estimate ? `tamaño → ${params.estimate}` : '', params.dependsOn !== undefined ? `depende de → ${params.dependsOn ?? 'nada'}` : ''].filter(Boolean);
            const resets = (params.title || params.criterion) && st && (st.status === 'review' || st.status === 'blocked');
            detail = `${changes.length ? `Cambios: ${changes.join(' · ')}.` : 'Sin cambios concretos.'}${resets ? ` Atención: ${st.storyId} está ${st.status === 'review' ? 'en revisión' : 'bloqueada'}; cambiar el título o el criterio la devuelve a pendiente y descarta su diff pendiente.` : ''} Confírmalo para hacerlo.`;
          }
        }
        out.push({ type: 'propose_local', status: 'pending', label: what, detail, local: { op: type, params } });
      } else if (act.type === 'open_decision') {
        if (!scope.conversationId) throw new Error('Las decisiones viven en una conversación.');
        const [d] = proposeDecisions(scope.conversationId, null, [act]);
        if (d) out.push({ type: 'open_decision', status: 'done', label: `Decisión D${d.seq} abierta: ${d.question}`, detail: d.recommendation ? `Recomendación: ${d.recommendation}. Decides tú.` : 'Decides tú.', decisionId: d.id });
      } else if (act.type === 'propose_assignment') {
        const { ws, project: pr } = strictTarget(act.company, act.project);
        // Conversación sin proyecto: el que se nombró pasa a ser su alcance (su panel y su etapa muestran el encargo).
        if (scope.conversationId && !scope.projectId) { updateConversation(scope.conversationId, { workspaceSlug: ws.slug, projectId: pr.id }); scope = { ...scope, workspaceSlug: ws.slug, projectId: pr.id }; }
        const a = createAssignment(ws.slug, pr.id, { request: String(act.request ?? act.objective ?? ''), title: String(act.title ?? ''), objective: String(act.objective ?? ''), criteria: Array.isArray(act.criteria) ? act.criteria.map(String) : [], outOfScope: Array.isArray(act.outOfScope) ? act.outOfScope.map(String) : [], size: ['S', 'M', 'L'].includes(act.size) ? act.size : null, conversationId: scope.conversationId });
        out.push({ type: 'propose_assignment', status: 'pending', label: `Encargo ${a.code}: ${a.title}`, detail: 'Borrador de encargo de desarrollo (sin historia). Revísalo y autorízalo: hasta entonces no se ejecuta nada.', assignmentId: a.id, workspaceSlug: ws.slug, projectId: pr.id });
      } else out.push(...executeActions([act]));
    } catch (e: any) { out.push({ type: LOCAL_OPS.includes(act.type) ? 'propose_local' : act.type === 'propose_assignment' ? 'propose_assignment' : act.type === 'open_decision' ? 'open_decision' : 'info', status: 'failed', label: act.type === 'propose_assignment' ? 'No se preparó el encargo' : `No se pudo: ${act.type}`, detail: e.message }); }
  }
  return out;
}

/** Confirmar (hacer) o descartar un cambio local que el Asistente propuso. Una sola vez. */
export function decideLocal(messageId: string, index: number, decision: 'approve' | 'reject'): AssistantMessage {
  const m = assistantRepo.get(messageId); const a = m?.actions[index];
  if (!m || !a || a.type !== 'propose_local' || !a.local) throw Object.assign(new Error('Propuesta no encontrada.'), { statusCode: 404 });
  if (a.status !== 'pending') throw Object.assign(new Error(`Esta propuesta ya está «${a.status}»: no se repite.`), { statusCode: 409 });
  let next: AssistantAction;
  if (decision === 'reject') next = { ...a, status: 'rejected', detail: 'Descartada por el propietario: no se hizo nada.' };
  else { const [r] = executeActions([{ type: a.local.op, ...a.local.params }]); next = { ...a, status: r.status === 'done' ? 'done' : 'failed', detail: r.detail ?? r.label, link: r.link, local: { ...a.local, result: r.label } }; }
  assistantRepo.updateActions(messageId, m.actions.map((x, i) => i === index ? next : x));
  return assistantRepo.get(messageId)!;
}

/** Ejecuta acciones al instante (solo tras la confirmación del propietario para las locales) y prepara propuestas. */
export function executeActions(actionsReq: any[]): AssistantAction[] {
  const actions: AssistantAction[] = [];
  for (const act of actionsReq.slice(0, 8)) {
    try {
      if (act.type === 'create_company') { const ws = createCompany(String(act.name ?? '')); actions.push({ type: 'create_company', status: 'done', label: `Empresa «${ws.name}» creada`, detail: 'Con sus 3 agentes de espacio, inactivos.', link: `/empresa/${ws.slug}/panel` }); }
      else if (act.type === 'create_project') { const ws = resolveCompany(act.company); const p = createProject(ws.slug, String(act.name ?? ''), String(act.description ?? ''), Array.isArray(act.objectives) ? act.objectives.map(String) : []); actions.push({ type: 'create_project', status: 'done', label: `Proyecto «${p.name}» creado en ${ws.name}`, detail: 'Con sus 5 agentes de proyecto, inactivos. Registra su repositorio para poder ejecutar historias.', link: `/empresa/${ws.slug}/proyecto/${p.id}/panel` }); }
      else if (act.type === 'add_backlog_item') { const ws = resolveCompany(act.company); const p = resolveProject(ws.slug, act.project); const it = addManualItem(ws.slug, p.id, { title: String(act.title ?? ''), criterion: act.criterion ? String(act.criterion) : undefined, description: act.description ? String(act.description) : undefined }); actions.push({ type: 'add_backlog_item', status: 'done', label: `${it.storyId} añadida al backlog de «${p.name}»`, detail: it.title, link: `/empresa/${ws.slug}/proyecto/${p.id}/backlog`, storyId: it.storyId, workspaceSlug: ws.slug, projectId: p.id }); }
      else if (act.type === 'update_backlog_item') {
        const ws = resolveCompany(act.company); const p = resolveProject(ws.slug, act.project); const story = resolveStory(ws.slug, p.id, act.story);
        const patch: any = {}; for (const k of ['title', 'criterion', 'description', 'estimate', 'dependsOn'] as const) if (act[k] !== undefined) patch[k] = act[k];
        backlogRepo(ws.slug).update(story.id, patch);
        const reformulated = (patch.title && patch.title !== story.title) || (patch.criterion && patch.criterion !== story.criterion);
        let detail = Object.keys(patch).join(', ');
        if (reformulated && (story.status === 'review' || story.status === 'blocked')) { resetStory(ws.slug, story.id, 'replanteada desde el asistente'); detail += ' · devuelta a pendiente (el diff anterior queda superado)'; }
        actions.push({ type: 'add_backlog_item', status: 'done', label: `${story.storyId} actualizada`, detail, link: `/empresa/${ws.slug}/proyecto/${p.id}/backlog`, storyId: story.storyId, workspaceSlug: ws.slug, projectId: p.id });
      }
      else if (act.type === 'reset_story') {
        const ws = resolveCompany(act.company); const p = resolveProject(ws.slug, act.project); const story = resolveStory(ws.slug, p.id, act.story);
        resetStory(ws.slug, story.id, String(act.reason ?? 'rechazada desde el asistente'));
        actions.push({ type: 'info', status: 'done', label: `${story.storyId} devuelta a pendiente`, detail: 'El diff anterior queda superado; puedes ejecutarla de nuevo.', link: `/empresa/${ws.slug}/proyecto/${p.id}/backlog` });
      }
      else if (act.type === 'execute_story') {
        const ws = resolveCompany(act.company); const p = resolveProject(ws.slug, act.project);
        // Si la historia se acaba de crear en esta misma respuesta, resuélvela por título.
        const proposed = new Set(actions.filter(a => a.type === 'propose_execution' && a.projectId === p.id && a.storyId).map(a => a.storyId!.toLowerCase()));
        let story; try { story = resolveStory(ws.slug, p.id, act.story, undefined, true); } catch (e) {
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
        actions.push({ type: 'propose_delegation', status: 'pending', label: `Análisis de ${lead.agentName}: ${String(act.request ?? '').slice(0, 80)}${String(act.request ?? '').length > 80 ? '…' : ''}`, detail: `Análisis delegado: ${lead.agentName} valida la petición${est.teamSize ? `, consulta hasta ${est.teamSize} agente(s) a su cargo` : ''} y entrega un documento con propuestas al backlog; no cambia código. Costo estimado ≈ ${est.estimatedUsd.toFixed(2)} USD.`, link: `/empresa/${ws.slug}/proyecto/${proc.projectId}/procesos/${proc.id}`, processId: proc.id, workspaceSlug: ws.slug, projectId: proc.projectId, estimatedUsd: est.estimatedUsd, suggestedBudgetUsd: est.suggestedBudgetUsd });
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

export async function chat(userText: string, images: { mediaType: string; data: string; name?: string }[] = [], files: AssistantAttachment[] = [], conversationId: string | null = null): Promise<{ user: AssistantMessage; assistant: AssistantMessage; conversationId: string }> {
  const a = assistantAgent();
  const info = assistantInfo();
  if (info.billing === 'api' && info.spentThisMonthUsd >= info.monthlyLimitUsd) throw Object.assign(new Error(`El Asistente alcanzó su límite mensual (${info.monthlyLimitUsd.toFixed(2)} USD). Puedes ampliarlo en su ficha de Equipo de IA.`), { statusCode: 409 });
  const providerId = a.config.provider as ProviderId;
  const prow = providersRepo.get(providerId)!; const cred = providersRepo.credential(providerId);
  // Con la API, el proveedor debe estar conectado; con Claude Code NO se usa la API aunque esté conectada.
  if (info.backend === 'api' && (!cred || prow.status !== 'connected')) throw Object.assign(new Error('El proveedor del Asistente no está conectado.'), { statusCode: 409 });
  const models: ModelInfo[] = (() => { try { return JSON.parse(prow.models_json); } catch { return []; } })();
  const attachments: AssistantAttachment[] = [...images.map((im, i) => ({ name: im.name ?? `imagen-${i + 1}`, mediaType: im.mediaType, bytes: Math.round(im.data.length * 0.75) })), ...files];
  const conv = conversationId ? getConversation(conversationId) : (conversationsRepo.list().find(c => c.status === 'active') ?? createConversation(userText.slice(0, 60), null, null));
  if (conv.title === 'Nueva conversación' && !assistantRepo.list(1, conv.id).length) conversationsRepo.update(conv.id, { title: userText.replace(/\s+/g, ' ').trim().slice(0, 60) || conv.title });
  const user = assistantRepo.add({ role: 'user', content: userText, actions: [], attachments, tokensIn: 0, tokensOut: 0, costUsd: 0, model: null }, conv.id);
  // Las acciones, con su estado REAL (no el guardado al proponer o autorizar): el modelo no puede dar por hecho lo que no terminó.
  const history = assistantRepo.listLive(16, conv.id).filter(m => m.id !== user.id).slice(-12).map(m => `${m.role === 'user' ? 'Propietario' : 'Asistente'}: ${m.content.slice(0, 1200)}${m.actions.length ? ` [acciones: ${m.actions.map(actionForPrompt).join('; ')}]` : ''}`).join('\n');
  const system = `Eres «${a.config.name}», ${a.template.role.toLowerCase()} de Portal IA, una plataforma local para gestionar empresas operadas por agentes de IA. Hablas con el propietario.
${a.config.specialization}
Qué es Portal IA: su primer cliente es él mismo; el proyecto «Desarrollo del Portal» del espacio interno tiene registrado el repositorio del propio Portal y su equipo lo mejora (incluido este chat) con encargos EN-n o historias.
Principios: nunca inventes datos: usa solo el estado real de abajo (tienes visibilidad completa del Portal: versión en marcha, git, cada historia con su fase y siguiente paso, qué aportó cada historia integrada y dónde se ve); cuando el propietario pregunte «dónde veo X» o «ya está hecho», responde con el estado real y la pantalla exacta; si algo está integrado pero el Portal en marcha es anterior, dilo claramente; nada con costo sin autorización (tú propones, el propietario autoriza en la tarjeta); si algo no existe aún, dilo y propón el encargo (o historias, si las pide).
Formato de respuesta: claro y aireado. Empieza con una frase de respuesta directa; luego, si hace falta, 2-4 apartados cortos con título en negrita, viñetas de una línea y pasos numerados cuando haya un orden; sin párrafos largos; máximo ~200 palabras salvo que pidan detalle.
${PORTAL_CAPABILITIES}
${SCREEN_MAP}
${ACTION_SCHEMA}
${CONVERSATION_GUIDE}

# Esta conversación: «${conv.title}» · etapa ${STAGE_LABEL[conv.stage]}${conv.workspaceSlug ? ` · alcance: ${conv.workspaceSlug}${conv.projectId ? ` / ${projectsRepo(conv.workspaceSlug).get(conv.projectId)?.name ?? conv.projectId}` : ''}` : ' · sin alcance fijado'}
${ledgerForPrompt(conv.id) || '(sin decisiones todavía)'}

# Estado real de la plataforma
${await platformSnapshot({ workspaceSlug: conv.workspaceSlug, projectId: conv.projectId })}`;
  const prompt = `${history ? `# Conversación reciente\n${history}\n\n` : ''}Propietario: ${userText}${images.length ? `\n(adjunta ${images.length} imagen(es))` : ''}`;
  const startedAt = new Date().toISOString();
  try {
    requirePolicy('ai_call', { slug: INTERNAL_WORKSPACE.slug, agentId: a.id, authorized: true }); // enviar el mensaje es la autorización (límite mensual ya comprobado)
    const req = { model: a.config.model, system, user: prompt, maxTokens: 3000, effort: a.config.effort, supportsEffort: !!models.find(m => m.id === a.config.model)?.supportsEffort, images };
    // Backend del Asistente: con Claude Code, la suscripción (sin cargo a la API); si no está disponible, se dice y NO se usa la API.
    const caller = agentCaller(INTERNAL_WORKSPACE.slug, a, null, 'Asistente');
    const res = caller
      ? await caller.complete({ ...req, images: images.length ? images : undefined, user: prompt })
      : await getAdapter(providerId)!.complete(decryptSecret(cred!.ciphertext), { workspaceId: prow.workspace_id }, req);
    const cost = caller ? 0 : costUsd(providerId, a.config.model, res.inputTokens, res.outputTokens);
    processesRepo(INTERNAL_WORKSPACE.slug).logExecution({ projectId: '', agentId: a.id, kind: 'assistant_chat', status: 'done', tokensIn: res.inputTokens, tokensOut: res.outputTokens, cost, startedAt });
    const { reply, actions: actionsReq } = parseResponse(res.text);
    const done = performActions(actionsReq.filter(x => x?.type !== 'request_operation'), { conversationId: conv.id, workspaceSlug: conv.workspaceSlug, projectId: conv.projectId });
    const scoped = getConversation(conv.id); // un encargo con proyecto explícito puede haber fijado el alcance
    const actions = [...done, ...(await prepareOperations(actionsReq.filter(x => x?.type === 'request_operation'), { conversationId: conv.id, workspaceSlug: scoped.workspaceSlug, projectId: scoped.projectId }))];
    const assistant = assistantRepo.add({ role: 'assistant', content: reply, actions, attachments: [], tokensIn: res.inputTokens, tokensOut: res.outputTokens, costUsd: cost, model: a.config.model }, conv.id);
    conversationsRepo.touch(conv.id); recomputeStage(conv.id);
    return { user, assistant, conversationId: conv.id };
  } catch (e) {
    processesRepo(INTERNAL_WORKSPACE.slug).logExecution({ projectId: '', agentId: a.id, kind: 'assistant_chat', status: 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt });
    const msg = e instanceof ProviderRequestError ? e.error.message : (e as Error).message;
    // Un fallo del proveedor no congela la conversación: queda el error y se puede seguir escribiendo.
    const assistant = assistantRepo.add({ role: 'assistant', content: `No pude responder: ${msg}`, actions: [], attachments: [], tokensIn: 0, tokensOut: 0, costUsd: 0, model: a.config.model }, conv.id);
    return { user, assistant, conversationId: conv.id };
  }
}

/** Marca una propuesta del chat como resuelta (autorizada/aplicada) para que la tarjeta no se repita. */
export function resolveProposal(messageId: string, processId: string, status: 'done' | 'failed', detail?: string) {
  const m = assistantRepo.get(messageId); if (!m) return;
  assistantRepo.updateActions(messageId, m.actions.map(a => a.processId === processId && a.status === 'pending' ? { ...a, status, detail: detail ?? a.detail } : a));
}

/**
 * Operaciones propuestas por el modelo → tarjetas pendientes con su vista previa calculada en el servidor. Nada se ejecuta
 * aquí: solo decideOperation(…, 'approve') tras la autorización explícita del propietario.
 */
export async function prepareOperations(reqs: any[], scope: ActionScope = NO_SCOPE): Promise<AssistantAction[]> {
  const out: AssistantAction[] = [];
  for (const r of reqs.slice(0, 3)) {
    const cap = CAPABILITIES[String(r?.capability ?? '')];
    if (!cap) { out.push({ type: 'info', status: 'failed', label: `Operación no disponible: «${String(r?.capability ?? '?')}»`, detail: 'No existe en el catálogo de operaciones del Portal; si es un cambio de código, pídelo como encargo.' }); continue; }
    const { type: _t, capability: _c, ...raw } = r;
    // El alcance de la conversación manda (como en performActions): sin empresa o proyecto, los suyos; con otros, nada.
    if (scope.workspaceSlug) { raw.company ||= scope.workspaceSlug; if (scope.projectId) raw.project ||= scope.projectId; }
    const parsed = cap.params.safeParse(raw);
    if (!parsed.success) { out.push({ type: 'info', status: 'failed', label: `No se pudo preparar «${cap.label}»`, detail: 'Parámetros no válidos.' }); continue; }
    try {
      const preview = await cap.preview(parsed.data);
      if ((scope.workspaceSlug && preview.target.workspace !== scope.workspaceSlug) || (scope.projectId && preview.target.projectId !== scope.projectId)) { out.push({ type: 'info', status: 'failed', label: `No se preparó: ${preview.title}`, detail: 'Fuera del alcance de esta conversación (otro proyecto): no se hace nada.' }); continue; }
      out.push({ type: 'propose_operation', status: preview.ok ? 'pending' : 'failed', label: preview.title, detail: preview.ok ? 'Revisa lo que se hará y autorízalo aquí.' : `No se puede ahora: ${preview.blockers.join(' ')}`,
        workspaceSlug: preview.target.workspace, projectId: preview.target.projectId, operation: { id: crypto.randomUUID(), capability: cap.id, params: parsed.data as Record<string, unknown>, preview, result: null, decidedAt: null } });
    } catch (e: any) { out.push({ type: 'info', status: 'failed', label: `No se pudo preparar «${cap.label}»`, detail: e.message }); }
  }
  return out;
}

/** Autorizar (ejecuta con el servicio existente) o rechazar (sin ningún efecto) una operación propuesta en el chat. */
export async function decideOperation(messageId: string, operationId: string, decision: 'approve' | 'reject'): Promise<AssistantMessage> {
  const m = assistantRepo.get(messageId);
  const action = m?.actions.find(x => x.type === 'propose_operation' && x.operation?.id === operationId);
  if (!m || !action?.operation) throw Object.assign(new Error('Operación no encontrada.'), { statusCode: 404 });
  if (action.status !== 'pending') throw Object.assign(new Error(`Esta operación ya está «${action.status}»: no se repite.`), { statusCode: 409 });
  const op = action.operation; const decidedAt = new Date().toISOString();
  const save = (patch: Partial<AssistantAction>) => { const cur = assistantRepo.get(messageId)!; assistantRepo.updateActions(messageId, cur.actions.map(x => x.operation?.id === operationId ? { ...x, ...patch } : x)); };
  if (decision === 'reject') { save({ status: 'rejected', detail: 'Rechazada por el propietario: no se ejecutó nada.', operation: { ...op, decidedAt } }); return assistantRepo.get(messageId)!; }
  const cap = CAPABILITIES[op.capability];
  if (!cap) throw Object.assign(new Error('La operación ya no existe en el catálogo.'), { statusCode: 409 });
  save({ status: 'running', detail: 'Ejecutando con tu autorización…', operation: { ...op, decidedAt } });
  try {
    const result = await cap.execute(cap.params.parse(op.params));
    save({ status: 'done', detail: result.summary, operation: { ...op, decidedAt, result } });
  } catch (e: any) {
    save({ status: 'failed', detail: `No se completó: ${e.message}`, operation: { ...op, decidedAt, result: { summary: 'Fallida', details: [String(e.message)] } } });
  }
  return assistantRepo.get(messageId)!;
}

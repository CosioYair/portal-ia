import type { FlowAction, FlowActionId, FlowIssue, FlowIssueDetail, FlowStage, FlowStageKey, FlowStageStatus, Isolation, IssueSeverity, Process, StoryFlow, VerificationRun, WorktreeDrift, BranchIntegration } from '@portal-ia/domain';
import { GAUNTLET_LIMITS, gauntletReviewed, verificationsForApplied } from '@portal-ia/domain';
import { filesIn, parseBuildErrors, parseFailingTests, parseTypeScriptErrors, qaSeverity, tailOf } from './diagnostics.ts';
import { deliveryProgress } from './storyUnits.ts';
import { runtimeVerified } from './runtimeChecks.ts';
import { driftMessage } from './worktreeDrift.ts';
import { staleCorrectionUnits, testRunSummary } from './failureDiagnosis.ts';
import type { teamReadiness } from './claudeCode/backend.ts';

/**
 * Recorrido guiado de una historia (una sola fuente de verdad, sin IA): en qué etapa está, qué la bloquea, de qué tipo
 * es el problema (entorno, código o decisión) y qué acciones lo resuelven por el flujo existente. La interfaz solo dibuja
 * esto; las acciones usan las rutas de siempre (verificar, iterar, tareas, chat, integrar…) con sus autorizaciones.
 */
export const DEPS_MISSING_EXIT = 86; // services/sandbox.ts: el volumen de dependencias Linux no está instalado
export interface FlowOptions {
  isPortalRepo?: boolean;
  storyStatus?: string | null;
  /** Pasos de la prueba manual con «Falla» y su comentario. */
  failedSteps?: { index: number; text: string; comment: string }[];
  /** Sandbox disponible ahora (null = desconocido). */
  sandbox?: Isolation | null;
  /** Preparación de los backends del equipo (conector Claude Code): qué falta para que puedan ejecutar. */
  backends?: ReturnType<typeof teamReadiness> | null;
  /** La última reconstrucción del Portal falló (log). */
  updateFailedLog?: string | null;
  iteration?: { number: number; total: number } | null;
  /** «En ejecución» pero sin ejecución viva en este servidor (reinicio o caída): nada está trabajando de verdad. */
  orphan?: boolean;
  /** Worktree respecto al último commit registrado (commits o cambios hechos fuera del equipo). */
  drift?: WorktreeDrift | null;
  /** Integración con la rama principal (git, sin IA): avanzó main, se combina limpio o hay conflictos reales. */
  integration?: BranchIntegration | null;
}

const LABELS: Record<FlowStageKey, string> = {
  execute: 'Planificar e implementar (agentes)', review: 'Revisar los cambios y QA', apply: 'Aplicar en un worktree aislado',
  verify: 'Verificar en sandbox', integrate: 'Integrar en main', activate: 'Activar el Portal (reconstruir y reiniciar)',
  runtime: 'Comprobar en ejecución', manual: 'Prueba de aceptación paso a paso', close: 'Cerrar o iterar'
};
const usd = (n: number | null | undefined) => (n ?? 0).toFixed(2);
/** Margen tras el plazo de una llamada antes de declararla «sin cerrar»: vigilante (15 s por defecto) + 30 s. */
export const OVERDUE_GRACE_MS = 45_000;
/** Estado real de una llamada al proveedor (lo que de verdad se sabe; sin streaming no hay progreso intermedio). */
export const LIVE_LABEL: Record<string, string> = { preparing: 'preparando la solicitud', sending: 'enviando la solicitud al proveedor', waiting: 'esperando la respuesta del proveedor', receiving: 'recibiendo la respuesta', processing: 'procesando la respuesta', retrying: 'esperando para reintentar', cancelling: 'cancelando' };
const ROLE: Record<string, string> = { planner: 'planifica', implementer: 'implementa', reviewer: 'revisa', consultant: 'consulta' };
const act = (id: FlowActionId, label: string, description: string, requires: FlowAction['requires'] = [], extra: Partial<FlowAction> = {}): FlowAction => ({ id, label, description, requires, primary: false, ...extra });
const ASK = act('ask_team', 'Preguntar al equipo sobre este problema', 'Abre el chat de la historia con el problema ya citado. Cada pregunta es una llamada a la IA que autorizas con un tope.', ['ai_budget']);
const TASKS = act('tasks_from_issue', 'Convertir en tareas', 'Crea una tarea por cada hallazgo (sin IA). Las tareas abiertas entran en la siguiente iteración.');
const fix = (label = 'Pedir al equipo que lo corrija') => act('request_fix', label, 'Prepara una iteración correctiva con el error, la evidencia, los archivos y los intentos anteriores. Queda pendiente de tu autorización y presupuesto: no gasta nada hasta entonces.', ['confirmation']);

/** Verificaciones relevantes desde que se aplicó (las anteriores son de otra versión del código). */
function sinceApplied(p: Process): VerificationRun[] {
  const r = p.result!;
  return verificationsForApplied(r, r.pipeline ? 0 : 1000); // sin commit registrado: el pipeline puede corregir en menos de 1 s
}

export function verificationIssue(v: VerificationRun, responsible: string[]): FlowIssue {
  const files = (d: FlowIssueDetail[]) => Array.from(new Set(d.map(x => x.file).filter(Boolean) as string[]));
  if (v.command === 'typecheck') {
    const d = parseTypeScriptErrors(v.output);
    return { kind: 'typecheck_failed', level: 'blocker', cause: 'code', command: 'typecheck', title: `El código no compila: ${d.length ? `${d.length} error(es) de TypeScript` : 'typecheck falló'}`, explanation: 'TypeScript encontró errores en los cambios del equipo. No se puede integrar código que no compila; el equipo debe corregirlo en una nueva iteración.', details: d.length ? d : [{ text: tailOf(v.output, 6) || `typecheck terminó con código ${v.exitCode}` }], files: files(d).length ? files(d) : filesIn(v.output), evidence: tailOf(v.output), responsible };
  }
  if (v.command === 'test') {
    // Canceladas ≠ fallidas (HU-159): una suite cuya preparación falla cancela sus pruebas sin ejecutarlas.
    const sum = testRunSummary(v);
    const hooks = sum.causes.filter(c => c.kind === 'hook');
    if (sum.onlyCancellations) return { kind: 'test_failed', level: 'blocker', cause: 'environment', command: 'test', title: `Pruebas canceladas sin un fallo propio (${sum.cancelled}): no es un error de la implementación`, explanation: 'Ninguna aserción falló: las pruebas se cancelaron y la causa no aparece en la evidencia (fin del proceso de pruebas, plazo o salida recortada). El equipo repite «test» una vez sin IA para ver la causa antes de corregir nada.', details: [{ text: `${sum.cancelled} prueba(s) canceladas · ${sum.failed} fallida(s)` }], files: filesIn(v.output).slice(0, 4), evidence: tailOf(v.output), responsible };
    if (hooks.length && !sum.causes.some(c => c.kind === 'assertion')) return { kind: 'test_failed', level: 'blocker', cause: 'code', command: 'test', title: `Falla la preparación de la prueba (${hooks.length}); ${sum.cancelled} prueba(s) canceladas sin ejecutarse`, explanation: 'No falla ninguna aserción de la implementación: falla la preparación (before/after) de la suite de pruebas y sus pruebas quedan canceladas. La corrección va a la preparación de la prueba, con la pila del error.', details: hooks.map(h => ({ text: `${h.name}: ${h.message}`, file: h.file ?? undefined })), files: Array.from(new Set(hooks.map(h => h.file).filter(Boolean) as string[])), evidence: tailOf(v.output), responsible };
    const d = parseFailingTests(v.output);
    return { kind: 'test_failed', level: 'blocker', cause: 'code', command: 'test', title: `Fallan las pruebas: ${d.length ? `${d.length} prueba(s)` : 'npm test terminó con error'}`, explanation: 'Las pruebas automáticas fallan con los cambios aplicados. Puede ser un error del cambio o una prueba que hay que actualizar: el equipo lo corrige en una nueva iteración. Si crees que es intermitente, repite la verificación.', details: d.length ? d : [{ text: tailOf(v.output, 6) || `test terminó con código ${v.exitCode}` }], files: files(d).length ? files(d) : filesIn(v.output), evidence: tailOf(v.output), responsible };
  }
  const d = parseBuildErrors(v.output);
  return { kind: 'build_failed', level: 'blocker', cause: 'code', command: v.command, title: 'El build falla', explanation: 'La aplicación no se puede construir con los cambios. No se integra (dejaría el Portal sin interfaz); el equipo debe corregirlo.', details: d.length ? d : [{ text: tailOf(v.output, 6) || `${v.command} terminó con código ${v.exitCode}` }], files: files(d).length ? files(d) : filesIn(v.output), evidence: tailOf(v.output), responsible };
}

export function buildStoryFlow(p0: Process, opts: FlowOptions = {}): StoryFlow {
  const p: Process = { ...p0, steps: p0.steps ?? [] };
  const r = p.result;
  const team = r?.team?.members ?? [];
  const name = (role: string) => team.filter(m => m.role === role).map(m => m.agentName);
  const devs = name('implementer').length ? name('implementer') : p.steps.filter(s => s.role === 'implementer').map(s => s.agentName);
  const qa = name('reviewer').length ? name('reviewer') : p.steps.filter(s => s.role === 'reviewer').map(s => s.agentName);
  const portal = !!opts.isPortalRepo && !!r?.merged && r.activation !== undefined && r.activation !== null;
  // Procesos anteriores a la clasificación CLAUDE_CODE_MAX_TURNS_EXHAUSTED (HU-159): un «provider_error» que en realidad fue
  // turnos agotados se presenta como tal (sin ofrecer repetir el mismo encargo). Solo al leer: el dato guardado no cambia.
  const pl0 = r?.pipeline ?? null;
  const pl = pl0 && pl0.state === 'paused' && pl0.pauseKind === 'provider_error' && /m[aá]ximo de turnos|agot[oó] los turnos/i.test(pl0.reason ?? '') ? { ...pl0, pauseKind: 'max_turns' as const, failureClass: 'CLAUDE_CODE_MAX_TURNS_EXHAUSTED' as const } : pl0;
  const keys: FlowStageKey[] = [...(pl ? ['execute', 'apply', 'verify', 'review'] as FlowStageKey[] : ['execute', 'review', 'apply', 'verify'] as FlowStageKey[]), 'integrate', ...(opts.isPortalRepo ? ['activate', 'runtime'] as FlowStageKey[] : []), 'manual', 'close'];
  const st: Record<string, { status: FlowStageStatus; detail: string }> = Object.fromEntries(keys.map(k => [k, { status: 'pending' as FlowStageStatus, detail: '' }]));
  const set = (k: FlowStageKey, status: FlowStageStatus, detail = '') => { if (st[k]) st[k] = { status, detail }; };
  let issue: FlowIssue | null = null; const actions: FlowAction[] = [];
  let headline: string | null = null;
  let forced: FlowStageKey | null = null; // etapa actual cuando una advertencia aún espera tu decisión
  const responsible = p.steps.filter(s => s.status === 'running').map(s => ({ agentName: s.agentName, role: ROLE[s.role ?? ''] ?? 'trabaja', status: 'trabajando' }));
  const implOut = p.steps.some(s => s.role === 'implementer' && !!s.outputMd?.trim()) || !!p.steps[1]?.outputMd?.trim();
  // Entrega incremental: entregables, unidad en curso, niveles (compila ≠ completa ≠ QA aprobó), correcciones y costo.
  const delivery = deliveryProgress(p);
  // Llamada «en curso» más allá de su plazo + el margen del vigilante + 30 s: algo impidió cerrarla (nunca se da por sana).
  const overdue = p.steps.find(s => s.status === 'running' && s.live && Date.now() > Date.parse(s.live.deadlineAt) + OVERDUE_GRACE_MS);

  // 1 · Ejecución de los agentes
  if (p.status === 'pending_authorization') {
    set('execute', 'waiting', `Pendiente de autorización · estimación ≈ ${usd(p.estimatedUsd)} USD · ${p.steps.length} agentes`);
    // Claude Code no listo para este equipo: se resuelve ANTES de autorizar la ejecución (si no, fallaría en el primer paso).
    const rd = opts.backends;
    if (rd && !rd.ready && rd.fallback !== 'api') {
      const needProject = !rd.projectAuthorized && rd.team.some(t => t.backend !== 'api');
      const consoleAgents = rd.team.filter(t => t.problem === 'console').map(t => t.agentId);
      const first = rd.team.find(t => !t.ready);
      const settings = { label: 'Proveedores → Claude Code — Local', href: '/configuracion/proveedor#claude-code' };
      issue = { kind: 'pipeline_paused', level: 'blocker', cause: 'decision', title: needProject ? `Falta autorizar «${rd.projectName ?? 'el proyecto'}» para Claude Code` : consoleAgents.length ? 'Falta una consola de Claude Code conectada' : 'Claude Code no está disponible para este equipo', explanation: `${first?.reason ?? ''} Hasta resolverlo no se puede autorizar la ejecución: fallaría en el primer paso. Nada se ha gastado.`, details: [], files: [], responsible: [], links: [settings] };
      if (needProject || consoleAgents.length) actions.push(act('claude_code_fix', needProject ? `Autorizar «${rd.projectName ?? 'el proyecto'}» para Claude Code` : `Pasar ${consoleAgents.length} agente(s) a Claude Code gestionado`, 'Guarda solo esa autorización y la vuelve a comprobar. No inicia el proceso ni llama a la IA.', ['authorization'], { primary: true, backendFix: { authorizeProject: needProject, switchToManaged: consoleAgents } }));
      actions.push(act('open_settings', 'Abrir Proveedores → Claude Code', 'Conector, CLI y sesión, proyectos autorizados y límites. No cambia nada por sí solo.', [], { href: settings.href }));
    }
    else actions.push(act('authorize', 'Revisar y autorizar la iteración', 'Revisa el equipo, el contexto que recibirá y fija un presupuesto máximo. Nada se gasta hasta que lo autorices.', ['authorization', 'ai_budget']));
  } else if (p.status === 'running' && opts.orphan) {
    set('execute', 'blocked', 'Sin ejecución activa: el Portal se reinició o perdió el proceso');
    issue = { kind: 'process_interrupted', level: 'blocker', cause: 'environment', title: 'Nadie está trabajando en este proceso', explanation: 'Figura «en ejecución», pero no hay ninguna ejecución viva en el Portal (se reinició o se cayó a mitad). Ninguna llamada al proveedor sigue en curso. Ciérralo: lo terminado se conserva y el paso interrumpido queda registrado con su posible costo no confirmado.', details: p.steps.filter(s => s.status === 'running').map(s => ({ text: `${s.agentName}: ${s.title} — interrumpido` })), files: [], responsible: [] };
    actions.push(act('cancel', 'Cerrar el proceso interrumpido', 'Lo marca como interrumpido sin reenviar nada; después podrás continuar o volver a ejecutar.'));
  } else if (p.status === 'running' && overdue) {
    // El plazo y el vigilante deberían haberla cerrado: si sigue «en curso» pasado el margen, no se muestra como sana.
    const l = overdue.live!; const late = Math.round((Date.now() - Date.parse(l.deadlineAt)) / 1000);
    set('execute', 'blocked', `${overdue.agentName}: la llamada superó su plazo hace ${late} s y no se ha cerrado`);
    issue = { kind: 'call_overdue', level: 'blocker', cause: 'environment', title: 'Una llamada al proveedor superó su plazo y no se cerró', explanation: `La llamada de ${overdue.agentName} («${overdue.title}») debía terminar o abortarse antes de ${new Date(l.deadlineAt).toLocaleTimeString('es-MX')} y sigue sin cerrarse. No se sabe si el proveedor la completó ni si la facturó. Cancelar aborta lo que quede y conserva lo terminado.`, details: [{ text: `Último hecho confirmado: ${l.lastEvent} (${new Date(l.lastEventAt).toLocaleTimeString('es-MX')})` }, { text: `${l.provider} · ${l.model} · intento ${l.attempt} de ${l.maxAttempts}` }], files: [], responsible: [] };
    actions.push(act('cancel', 'Cancelar el proceso', 'Aborta la llamada y detiene el proceso; lo terminado se conserva.'));
  } else if (p.status === 'running' && delivery && pl?.phase === 'implementing') {
    const u = delivery.currentUnit;
    headline = pl.events.at(-1)?.message ?? null;
    const live = p.steps.find(s => s.status === 'running')?.live;
    set('execute', 'running', `${delivery.delivered} de ${delivery.total} entregables${u ? ` · ${u.kind === 'correction' ? 'corrección' : `unidad ${u.index} de ${u.total}`}: ${u.title} (${u.agentName})` : ''}${live ? ` · ${LIVE_LABEL[live.state]}` : ''}`);
    if (live) headline = `${headline ?? ''} · ${LIVE_LABEL[live.state]}`.replace(/^ · /, '');
    actions.push(act('cancel', 'Cancelar', 'Aborta la llamada en curso al proveedor y detiene el proceso; lo entregado y aplicado se conserva.'));
  } else if (p.status === 'running' && pl && pl.phase !== 'implementing') {
    const valid = (r?.changes ?? []).filter(c => !c.error).length;
    headline = pl.events.at(-1)?.message ?? null;
    const repairing = pl.phase === 'recovering' || pl.phase === 'repairing';
    set('execute', repairing ? 'running' : 'done', pl.phase === 'repairing' ? `Reparando la entrega del Desarrollador (intento ${pl.outputRepairs + 1})` : pl.phase === 'recovering' ? 'Recuperando la entrega sin IA' : `${delivery ? `${delivery.delivered} de ${delivery.total} entregables` : `${valid} archivo(s)`} · ${usd(p.spentUsd)} de ${usd(p.budgetUsd)} USD`);
    if (r?.applied) set('apply', 'done', `${r.applied.branch} · ${r.applied.commit}`); else if (pl.phase === 'applying') set('apply', 'running', 'Aplicando en el worktree aislado');
    if (pl.phase === 'verifying' || pl.phase === 'installing') set('verify', 'running', pl.phase === 'installing' ? 'Instalando dependencias (red temporal autorizada)' : `Verificando en el sandbox: ${pl.config.commands.join(', ')}`);
    else if (pl.phase === 'correcting') set('verify', 'running', `El Desarrollador prepara la corrección ${pl.corrections + 1} de ${pl.config.maxCorrections}`);
    else if (pl.phase === 'qa') { set('verify', 'done', 'Verificación en verde'); set('review', 'running', 'QA evalúa la evidencia'); }
    const live = p.steps.find(s => s.status === 'running')?.live;
    if (live && pl.phase !== 'verifying' && pl.phase !== 'installing' && pl.phase !== 'applying') headline = `${headline ?? ''} · ${LIVE_LABEL[live.state]}`.replace(/^ · /, '');
    actions.push(act('cancel', 'Cancelar', 'Aborta la llamada en curso al proveedor y detiene el proceso; lo hecho se conserva.'));
  } else if (p.status === 'running') {
    const cur = p.steps.find(s => s.status === 'running'); const done = p.steps.filter(s => s.status === 'done').length;
    set('execute', 'running', `${cur ? `${cur.agentName} ${ROLE[cur.role ?? ''] ?? 'trabaja'}: ${cur.title}${cur.live ? ` · ${LIVE_LABEL[cur.live.state]}` : ''}` : 'En curso'} · paso ${Math.min(done + 1, p.steps.length)} de ${p.steps.length}`);
    actions.push(act('cancel', 'Cancelar', 'Aborta la llamada en curso al proveedor y detiene el proceso; lo gastado hasta ahora se conserva.'));
  } else if (p.status === 'budget_exceeded') {
    set('execute', 'failed', `Detenido por presupuesto: ${usd(p.spentUsd)} de ${usd(p.budgetUsd)} USD`);
    issue = { kind: 'budget_exceeded', level: 'blocker', cause: 'decision', title: 'Se agotó el presupuesto autorizado', explanation: `El equipo gastó ${usd(p.spentUsd)} de ${usd(p.budgetUsd)} USD y se detuvo antes de terminar, como pediste. Para seguir hay que autorizar un presupuesto nuevo (o recuperar lo que ya entregó, sin IA).`, details: p.steps.filter(s => s.status !== 'done').map(s => ({ text: `${s.agentName}: ${s.title} — sin terminar` })), files: [], responsible: [] };
    if (implOut && !r?.applied) actions.push(act('recover', 'Recuperar lo entregado (sin IA)', 'Vuelve a leer lo que el Desarrollador ya entregó y deja el diff listo para revisar, sin gastar nada.'));
    actions.push(act('retry_process', 'Volver a ejecutar con un presupuesto nuevo', 'Crea un proceso nuevo pendiente de autorización: eliges el presupuesto antes de que empiece.', ['authorization', 'ai_budget']));
  } else if (p.status === 'failed' || p.status === 'cancelled') {
    // Con la clasificación del fallo no se adivina por el texto: solo es «parche que no encaja» si hubo cambios con forma
    // válida que no encajan; una entrega sin formato reconocible es un fallo del contrato de salida.
    const contract = r?.failure?.kind === 'output_contract' && !!r.failure.assessment && r.failure.assessment.kind !== 'implementation';
    const patch = !contract && (/aplicable|BUSCAR|parche|no aparece en el archivo/i.test(p.error ?? '') || (r?.changes ?? []).some(c => c.error));
    set('execute', 'failed', p.status === 'cancelled' ? 'Cancelado' : `Falló: ${(p.error ?? '').slice(0, 140)}`);
    if (p.status === 'cancelled') issue = { kind: 'cancelled', level: 'blocker', cause: 'decision', title: 'Proceso cancelado', explanation: 'Se canceló antes de terminar. Puedes recuperar lo entregado (sin IA) o volver a ejecutarlo.', details: [], files: [], responsible: [] };
    else if (patch) {
      const bad = (r?.changes ?? []).filter(c => c.error);
      issue = { kind: 'patch_failed', level: 'blocker', cause: 'code', title: 'Los cambios del equipo no encajan en el código actual', explanation: 'El Desarrollador propuso modificar texto que ya no existe (o cambió desde que lo leyó). No se escribió nada. Una nueva iteración le da el estado actual de esos archivos para rehacerlo.', details: bad.length ? bad.map(c => ({ text: c.error!, file: c.path })) : [{ text: p.error ?? 'parche no aplicable' }], files: bad.map(c => c.path), responsible: devs };
    } else if (r?.failure?.class === 'PROVIDER_REFUSAL') {
      issue = { kind: 'agent_refused', level: 'blocker', cause: 'decision', title: 'El proveedor rechazó la petición', explanation: `${r.failure.detail} La respuesta queda guardada como evidencia; repetir la misma petición no cambiaría el resultado y gastaría créditos.`, details: (r.failure.assessment?.reasons ?? []).map(t => ({ text: t })), files: [], responsible: [], request: r.failure.request ?? null };
    } else if (r?.failure?.request) {
      const q = r.failure.request;
      issue = { kind: 'agent_blocked', level: 'blocker', cause: 'decision', title: q.kind === 'permission' ? 'El equipo necesita un permiso que no tiene' : q.kind === 'information' ? 'El equipo necesita información para seguir' : 'El equipo necesita una decisión tuya', explanation: `${q.why} No se reintentó: repetir la misma petición no cambiaría el resultado.`, details: [{ text: q.question }, ...q.options.map(o => ({ text: `Opción: ${o}` }))], files: [], responsible: [], request: q };
    } else if (r?.failure?.class === 'PROVIDER_TIMEOUT') {
      issue = { kind: 'provider_timeout', level: 'blocker', cause: 'environment', title: 'El proveedor no respondió a tiempo', explanation: `${r.failure.detail} No es un fallo del código ni del equipo; no se reintentó solo porque la llamada pudo facturarse.`, details: [{ text: r.failure.detail }], files: [], responsible: [] };
    } else if (r?.failure?.kind === 'output_contract' || (!r?.failure && /formato acordado|no entregó ningún archivo|se cortó a mitad del archivo/i.test(p.error ?? ''))) {
      const a = r?.failure?.assessment;
      issue = { kind: 'output_contract', level: 'blocker', cause: 'code', title: 'El Desarrollador no entregó cambios en el formato acordado', explanation: `No es un problema del entorno (Docker, TypeScript o red): la respuesta del agente no se pudo convertir en cambios${a ? ` (${({ truncated: 'respuesta cortada', incomplete: 'entrega incompleta', malformed: 'formato no reconocible', refusal: 'el agente no completó la tarea', no_changes: 'sin cambios', implementation: 'cambios no aplicables' } as Record<string, string>)[a.kind] ?? a.kind})` : ''}. Primero se intenta recuperar lo entregado sin IA; si no basta, el mismo Desarrollador puede reparar su entrega sin repetir el plan del Coordinador.`, details: (a?.reasons.length ? a.reasons : [p.error ?? 'sin detalle']).map(t => ({ text: t })), files: a?.truncatedFile ? [a.truncatedFile] : [], responsible: devs };
    } else if (r?.failure?.kind === 'refusal') {
      const a = r.failure.assessment;
      issue = { kind: 'agent_refused', level: 'blocker', cause: 'decision', title: 'El Desarrollador no completó la tarea', explanation: `${r.failure.detail} ${a?.requestedFiles.length ? 'Una reparación le dará el contenido de esos archivos.' : 'Quizá la historia necesita más contexto o un alcance más acotado.'}`, details: (a?.reasons ?? []).map(t => ({ text: t })), files: a?.requestedFiles ?? [], responsible: devs };
    } else if (r?.failure?.kind === 'provider') {
      issue = { kind: 'provider_failed', level: 'blocker', cause: 'environment', title: 'El proveedor de IA falló', explanation: `${r.failure.detail} No es un fallo del código ni del equipo. ${implOut ? 'Lo entregado se conserva y se puede continuar sin repetir lo hecho.' : 'Puedes volver a ejecutarlo cuando el proveedor responda.'}`, details: [{ text: r.failure.detail }], files: [], responsible: [] };
    } else issue = { kind: 'process_failed', level: 'blocker', cause: 'environment', title: 'La ejecución del equipo falló', explanation: `El proceso se detuvo con un error: ${p.error ?? 'desconocido'}. ${implOut ? 'El Desarrollador sí entregó su trabajo: puedes recuperarlo sin IA.' : 'Puedes volver a ejecutarlo (quizá acotando la historia).'}`, details: p.error ? [{ text: p.error }] : [], files: [], responsible: [] };
    if (issue?.kind === 'agent_blocked' && implOut && !r?.applied) actions.push(act('pipeline_resume', 'Responder y continuar', 'Tu respuesta llega al agente que la pidió y el equipo sigue (aplicar, verificar y QA) dentro del presupuesto que autorices.', ['authorization', 'ai_budget'], { pipeline: {}, suggestedBudgetUsd: 0.5, answer: { question: r!.failure!.request!.question, why: r!.failure!.request!.why, options: r!.failure!.request!.options } }));
    if (issue?.kind === 'agent_refused' && r?.failure?.class === 'PROVIDER_REFUSAL') actions.push(fix('Reformular la historia (nueva iteración)'), act('close_resolved', 'Cerrar como resuelta', 'Indica el motivo.'), act('reject', 'Rechazar', 'La historia vuelve a pendiente.'));
    if (implOut && !r?.applied && issue?.kind !== 'agent_blocked' && r?.failure?.class !== 'PROVIDER_REFUSAL') actions.push(act('recover', 'Recuperar lo entregado (sin IA)', 'Vuelve a leer lo que el Desarrollador ya entregó con las reglas actuales (formato canónico, variantes, diff), sin gastar nada.'));
    if (implOut && !r?.applied && (issue?.kind === 'output_contract' || issue?.kind === 'provider_failed' || issue?.kind === 'provider_timeout' || issue?.kind === 'patch_failed')) actions.push(act('repair_output', 'Reparar la entrega con IA (sin repetir el plan)', 'El mismo Desarrollador recibe su respuesta anterior y el diagnóstico, y reenvía solo lo necesario. Después el equipo aplica, verifica y QA valida automáticamente, dentro del presupuesto que autorices.', ['authorization', 'ai_budget'], { pipeline: {}, suggestedBudgetUsd: 0.5 }));
    if (issue?.kind === 'patch_failed') actions.push(fix('Pedir al equipo que lo rehaga sobre el código actual'));
    actions.push(act('retry_process', 'Volver a ejecutar la historia', 'Crea un proceso nuevo pendiente de autorización (eliges el presupuesto).', ['authorization', 'ai_budget']));
  } else set('execute', 'done', `${p.steps.filter(s => s.status === 'done').length} agentes · ${usd(p.spentUsd)} USD de ${usd(p.budgetUsd)} USD`);

  const finish = (): StoryFlow => {
    const stages: FlowStage[] = keys.map(k => ({ key: k, label: LABELS[k], ...st[k] }));
    const current = forced ?? (stages.find(s => !['done', 'warning'].includes(s.status)) ?? stages[stages.length - 1]).key;
    if (st[current]?.status === 'pending') st[current].status = 'current';
    const stages2: FlowStage[] = keys.map(k => ({ key: k, label: LABELS[k], ...st[k] }));
    if (actions.length && !actions.some(a => a.primary)) actions[0].primary = true;
    const resp = responsible.length ? responsible : (issue?.responsible ?? []).map(n => ({ agentName: n, role: devs.includes(n) ? 'implementa' : qa.includes(n) ? 'revisa' : 'responsable', status: 'responsable de corregirlo' }));
    return { stages: stages2, current, progress: { done: stages2.filter(s => s.status === 'done' || s.status === 'warning').length, total: stages2.length }, issue, actions, responsible: resp, iteration: opts.iteration ?? null, headline, delivery };
  };
  if (p.status !== 'done' || !r) return finish();

  if (pl && (pl.state === 'paused' || pl.state === 'stopped') && !r.merged && !r.rejected) {
    const valid = r.changes.filter(c => !c.error).length;
    const since = sinceApplied(p); const lastOf = (c: string) => since.filter(v => v.command === c).at(-1);
    set('execute', valid ? (delivery && !delivery.levels.complete ? 'warning' : 'done') : 'blocked', valid ? (delivery ? `${delivery.delivered} de ${delivery.total} entregables` : `${valid} archivo(s)`) : 'Sin cambios aplicables todavía');
    if (r.applied) set('apply', 'done', `${r.applied.branch} · ${r.applied.commit}`);
    const verifyFailed = pl.config.commands.map(lastOf).find(v => v && v.exitCode !== 0 && v.exitCode !== null && v.exitCode !== DEPS_MISSING_EXIT && v.isolation !== 'unavailable');
    const verifyOk = r.applied && pl.config.commands.every(c => lastOf(c)?.exitCode === 0);
    if (verifyOk) set('verify', 'done', pl.config.commands.map(c => `${c}: ok`).join(' · '));
    if (r.review?.verdict) set('review', r.review.verdict === 'approved' ? 'done' : r.review.verdict === 'rejected' ? 'rejected' : 'blocked', r.review.verdict === 'approved' ? 'QA aprobó con evidencia' : r.review.verdict === 'rejected' ? `QA rechaza · ${(r.review.findings ?? []).length} hallazgo(s)` : 'QA no pudo verificar');
    const stageOf: Record<string, FlowStageKey> = { budget: !r.applied ? 'execute' : verifyOk ? 'review' : 'verify', subscription_limit: !r.applied ? 'execute' : verifyOk ? 'review' : 'verify', network: 'verify', environment: 'verify', duration: !r.applied ? 'execute' : 'verify', limit: verifyFailed ? 'verify' : 'review', repeated_failure: verifyFailed ? 'verify' : 'review', qa: 'review', no_changes: 'execute', refusal: 'execute', cancelled: !r.applied ? 'execute' : 'verify', missing_information: 'execute', permission: !r.applied ? 'execute' : 'verify', unsupported: 'execute', provider_refusal: 'execute', provider_timeout: !r.applied ? 'execute' : verifyOk ? 'review' : 'verify', provider_error: !r.applied ? 'execute' : verifyOk ? 'review' : 'verify', interrupted: !r.applied ? 'execute' : verifyOk ? 'review' : 'verify', unknown: !r.applied ? 'execute' : 'verify', too_large: 'execute', incomplete: 'execute', plan: 'execute', disagreement: 'review', gauntlet: 'review', external: verifyOk ? 'review' : 'verify' };
    const k = pl.pauseKind ? stageOf[pl.pauseKind] ?? 'verify' : (!valid ? 'execute' : 'review');
    forced = k; set(k, pl.state === 'paused' ? 'blocked' : 'failed', (pl.reason ?? '').slice(0, 140));
    const cause = ['environment', 'network', 'provider_timeout', 'provider_error', 'interrupted', 'subscription_limit'].includes(pl.pauseKind ?? '') ? 'environment' : ['limit', 'repeated_failure', 'too_large', 'incomplete'].includes(pl.pauseKind ?? '') ? 'code' : 'decision';
    const req = pl.ownerRequest ?? null;
    const fromVerify = verifyFailed ? verificationIssue(verifyFailed, devs) : null;
    const qaDetails = pl.pauseKind === 'gauntlet'
      ? (r.gauntlet?.rounds.at(-1)?.findings ?? []).filter(x => !x.unsupported && x.severity !== 'minor').map(x => ({ text: `[Evaluador · ${x.severity === 'blocking' ? 'bloqueante' : 'mayor'}] ${x.text}${x.evidence ? ` — evidencia: ${x.evidence.split('\n')[0].slice(0, 200)}` : ''}`, file: x.file, severity: (x.severity === 'blocking' ? 'alta' : 'media') as IssueSeverity }))
      : (r.review?.findings ?? []).map(x => ({ text: x.text, file: x.file, severity: x.severity }));
    const title = ({ budget: 'Pausado: el presupuesto autorizado no alcanza para el siguiente paso', subscription_limit: 'Pausado: la suscripción de Claude alcanzó su límite de uso', network: 'Pausado: falta autorizar la instalación de dependencias', environment: 'Pausado por el entorno (sandbox)', duration: 'Pausado: se alcanzó la duración máxima', limit: 'Detenido: se alcanzó el máximo de correcciones', repeated_failure: 'Detenido: el mismo fallo se repite', qa: 'QA no pudo verificar: decides tú', no_changes: 'El Desarrollador concluye que no hacen falta cambios', refusal: 'El Desarrollador no completó la tarea', cancelled: 'Cancelado', missing_information: 'El equipo necesita información para seguir', permission: 'Pausado: hace falta un permiso', unsupported: 'Detenido: falta una capacidad que el equipo no tiene', provider_refusal: 'El proveedor rechazó la petición', provider_timeout: 'Pausado: el proveedor no respondió a tiempo', max_turns: 'Pausado: Claude Code agotó sus turnos sin terminar (no es un error de conexión)', provider_error: 'Pausado: no se pudo contactar con el proveedor', interrupted: 'Interrumpido por un reinicio del Portal', unknown: 'Detenido por un fallo no identificado', too_large: 'Detenido: un entregable no cabe en la salida del modelo', incomplete: 'Pausado: la entrega está incompleta (no se pagó a QA)', plan: 'Detenido: el plan no se puede ejecutar por partes', disagreement: 'QA y el Desarrollador no están de acuerdo: decides tú', gauntlet: 'El Evaluador Gauntlet dejó brechas bloqueantes: decides tú', external: verifyOk ? 'Corrección externa verificada: falta QA' : 'Corrección externa: decides el siguiente paso' } as Record<string, string>)[pl.pauseKind ?? ''] ?? 'El pipeline se detuvo';
    issue = { kind: pl.pauseKind === 'provider_refusal' ? 'agent_refused' : req ? 'agent_blocked' : pl.state === 'paused' ? 'pipeline_paused' : pl.pauseKind === 'qa' ? 'qa_blocked' : 'pipeline_stopped', level: 'blocker', cause, command: fromVerify?.command, title, explanation: req ? `${req.why}` : `${pl.reason ?? ''} Todo lo hecho se conserva (cambios, verificaciones y registro).`, request: req, details: req ? [{ text: req.question }, ...req.options.map(o => ({ text: `Opción: ${o}` }))] : fromVerify?.details.length ? fromVerify.details : qaDetails.length ? qaDetails : pl.failures.map(x => ({ text: `${x.label} · ${x.count} vez/veces` })), files: fromVerify?.files ?? Array.from(new Set(qaDetails.map(x => x.file).filter(Boolean) as string[])), evidence: fromVerify?.evidence ?? null, responsible: cause === 'code' ? devs : [] };
    const resume = (label: string, description: string, requires: FlowAction['requires'], extra: Partial<FlowAction> = {}) => act('pipeline_resume', label, description, requires, { pipeline: {}, ...extra });
    const answer = req ? { question: req.question, why: req.why, options: req.options } : null;
    if (req && (pl.pauseKind === 'missing_information' || pl.pauseKind === 'permission' || pl.pauseKind === 'unsupported')) {
      actions.push(resume('Responder y continuar', 'Tu respuesta llega (una vez) al agente que la pidió y el equipo retoma donde lo dejó, dentro del presupuesto que autorices. No se amplía ningún permiso.', ['authorization', 'ai_budget'], { suggestedBudgetUsd: 0.5, answer }));
      actions.push(act('new_iteration', 'Acotar la historia (nueva iteración)', 'Reformula o reduce el alcance para que el equipo pueda hacerlo con lo que tiene.', ['confirmation']), act('close_resolved', 'Cerrar como resuelta', 'Si ya no hace falta, ciérrala indicando el motivo.'), act('reject', 'Rechazar', 'La historia vuelve a pendiente; nada se aplica.'));
    }
    else if (pl.pauseKind === 'provider_refusal') actions.push(act('new_iteration', 'Reformular la historia (nueva iteración)', 'Una petición distinta; la negativa queda guardada como evidencia.', ['confirmation']), act('close_resolved', 'Cerrar como resuelta', 'Indica el motivo.'), act('reject', 'Rechazar', 'La historia vuelve a pendiente.'));
    else if (pl.pauseKind === 'max_turns') {
      // Turnos agotados: capacidad de la ejecución, no conexión. Nunca se ofrece repetir el mismo encargo.
      const stale = staleCorrectionUnits(r);
      const retry = r.manifest?.units.find(u => u.status === 'pending' && (u.maxTurns ?? 0) === 1);
      issue = { ...issue!, cause: 'decision', explanation: `${pl.reason ?? ''} Todo lo hecho se conserva: commits, unidades terminadas, salidas y verificaciones.` };
      if (stale.length) actions.push(resume('Volver a verificar sin IA y corregir solo lo que falle', `La corrección pendiente quedó obsoleta (${stale.some(s => s.reason === 'overlap') ? `otra de su ronda ya cambió ${Array.from(new Set(stale.flatMap(s => s.files))).join(', ')}` : 'se planificó con pruebas canceladas'}): se sustituye sin IA y se vuelve a verificar en Docker. Solo si algo sigue fallando se planifica una corrección, acotada.`, ['authorization'], { primary: true }));
      else if (retry) actions.push(resume('Reintentar solo lo pendiente, acotado', `Un único intento de «${retry.title}» con el contenido de los archivos relacionados ya incluido (sin explorar), con los mismos límites autorizados. Si vuelve a agotar los turnos, se detiene. No concede correcciones nuevas.`, ['authorization'], { primary: true }));
      else actions.push(resume('Volver a verificar sin IA', 'No se repite la tarea que agotó dos veces los turnos ni se planifica otra corrección: se verifica de nuevo en Docker el código actual y, si algo sigue fallando, se detiene con esa evidencia para que decidas.', ['authorization'], { primary: true, pipeline: { maxCorrections: 0 } }));
      actions.push(fix('Acotar la historia (nueva iteración)'), ASK, act('reject', 'Rechazar el diff', 'Descarta el worktree y la rama; la historia vuelve a pendiente.'));
    }
    else if (pl.pauseKind === 'provider_timeout' || pl.pauseKind === 'provider_error' || pl.pauseKind === 'interrupted') actions.push(resume('Repetir la llamada y continuar', 'Repite SOLO la llamada que no terminó (lo hecho no se repite ni se vuelve a cobrar). Puede facturarse de nuevo.', ['authorization', 'ai_budget'], { suggestedBudgetUsd: 0.5 }));
    // Conector Claude Code: límite de la suscripción o backend no disponible. Continuar repite solo la llamada pendiente con Claude Code (sin pasar a la API).
    else if (pl.pauseKind === 'subscription_limit' || (pl.pauseKind === 'permission' && !req)) {
      // Claude Code bloqueado: la autorización concreta que falta, en una sola acción que después retoma lo pendiente.
      const rd = opts.backends; const consoleAgents = rd?.team.filter(t => t.problem === 'console').map(t => t.agentId) ?? [];
      const needProject = !!rd && !rd.projectAuthorized && rd.team.some(t => t.backend !== 'api');
      // La pausa la causó Claude Code (no un permiso pedido por el equipo ni la credencial de la API).
      const ccPause = pl.pauseKind === 'subscription_limit' || /Claude Code/.test(pl.reason ?? '');
      const settings = { label: 'Proveedores → Claude Code — Local', href: '/configuracion/proveedor#claude-code' };
      const next = rd?.nextOperation ? ` Al continuar se retoma solo: ${rd.nextOperation}.` : '';
      if (ccPause && rd && !rd.ready && rd.fallback !== 'api') {
        // Sigue bloqueado según la configuración GUARDADA: se dice exactamente qué falta y no se ofrece «Continuar»
        // (solo volvería a detenerse y llenaría el historial de pausas repetidas, como en HU-159).
        const first = rd.team.find(t => !t.ready);
        issue = { ...issue!, title: needProject ? `Falta autorizar «${rd.projectName ?? 'el proyecto'}» para Claude Code` : first?.problem === 'console' ? 'Falta una consola de Claude Code conectada' : first?.problem === 'disabled' ? 'El conector «Claude Code — Local» está desactivado' : 'Claude Code no está disponible para este equipo', explanation: `${first?.reason ?? pl.reason ?? ''} Todo lo hecho se conserva (cambios, verificaciones, costos y correcciones) y no se ha llamado a la IA.${next}`, links: [settings] };
        if (needProject || consoleAgents.length) {
          const what = [needProject ? `autorizar «${rd.projectName ?? 'el proyecto'}» para Claude Code` : null, consoleAgents.length ? `pasar ${consoleAgents.length === 1 ? `a «${rd.team.find(t => t.agentId === consoleAgents[0])!.name}»` : `${consoleAgents.length} agentes`} a Claude Code gestionado (tu suscripción; sin consola conectada)` : null].filter(Boolean).join(' y ');
          actions.push(act('claude_code_fix', `${what[0].toUpperCase()}${what.slice(1)}`, 'Guarda solo esa autorización y la vuelve a comprobar en la configuración guardada. No continúa ni llama a la IA: cuando quede verificada aparece «Continuar la operación pendiente».', ['authorization'], { primary: true, backendFix: { authorizeProject: needProject, switchToManaged: consoleAgents } }));
        }
        actions.push(act('open_settings', 'Abrir Proveedores → Claude Code', 'Conector, CLI y sesión, proyectos autorizados y límites. No cambia nada por sí solo.', [], { href: settings.href }));
      }
      else if (ccPause && rd?.ready) {
        // Ya resuelto y verificado: la pausa guardada es historia; lo que toca es continuar lo pendiente.
        if (pl.pauseKind !== 'subscription_limit') issue = { ...issue!, level: 'warning', title: 'Claude Code ya está listo: falta continuar', explanation: `Se detuvo porque: «${pl.reason ?? ''}». Ahora está resuelto y comprobado en la configuración guardada (proyecto autorizado y backend disponible).${next} Lo hecho no se repite ni se vuelve a cobrar.` };
        actions.push(resume(pl.pauseKind === 'subscription_limit' ? 'Continuar cuando se renueve el límite' : 'Continuar la operación pendiente', `Retoma solo lo pendiente${rd.nextOperation ? ` (${rd.nextOperation})` : ''} con el backend de cada agente. No se conceden correcciones nuevas ni se cambia a la API.`, ['authorization'], { primary: true }));
      }
      else {
        if (pl.pauseKind === 'permission' && (needProject || consoleAgents.length)) {
          const what = [needProject ? `autorizar «${rd!.projectName ?? 'el proyecto'}» para Claude Code` : null, consoleAgents.length ? `pasar ${consoleAgents.length === 1 ? `a «${rd!.team.find(t => t.agentId === consoleAgents[0])!.name}»` : `${consoleAgents.length} agentes`} a Claude Code gestionado (tu suscripción; sin consola conectada)` : null].filter(Boolean).join(' y ');
          actions.push(act('claude_code_fix', `${what[0].toUpperCase()}${what.slice(1)}`, 'Guarda solo esa autorización y la vuelve a comprobar. No continúa ni llama a la IA.', ['authorization'], { primary: true, backendFix: { authorizeProject: needProject, switchToManaged: consoleAgents } }));
        }
        actions.push(resume(pl.pauseKind === 'subscription_limit' ? 'Continuar cuando se renueve el límite' : 'Continuar cuando el proveedor esté disponible', 'Repite SOLO la llamada pendiente con el mismo backend del agente; lo hecho no se repite. No cambia a la API salvo que lo hayas autorizado como alternativa.', ['authorization']));
        if (ccPause) issue = { ...issue!, links: [settings] };
      }
    }
    else if (pl.pauseKind === 'unknown') actions.push(ASK, act('retry_process', 'Volver a ejecutar la historia', 'Crea un proceso nuevo pendiente de autorización.', ['authorization', 'ai_budget']));
    else if (pl.pauseKind === 'budget') actions.push(resume('Continuar con más presupuesto', 'El equipo retoma donde lo dejó (no repite lo hecho). Fijas el presupuesto adicional máximo; solo se gasta lo necesario.', ['authorization', 'ai_budget'], { suggestedBudgetUsd: 0.5 }));
    else if (pl.pauseKind === 'network') actions.push(resume('Permitir instalar dependencias y continuar', 'Instala las dependencias en el sandbox con red temporal (solo durante la instalación) y sigue verificando. No llama a la IA.', ['authorization', 'network'], { pipeline: { allowInstall: true } }));
    else if (pl.pauseKind === 'environment') actions.push(act('refresh_sandbox', 'Comprobar el sandbox de nuevo', 'Vuelve a detectar Docker sin ejecutar nada.'), resume('Continuar cuando el entorno esté listo', 'Retoma la verificación; no llama a la IA salvo que haga falta corregir código.', ['authorization']));
    else if (pl.pauseKind === 'plan') actions.push(act('new_iteration', 'Reformular o dividir la historia (nueva iteración)', 'Prepara la iteración con el motivo; el plan nuevo se valida antes de gastar en consultas o implementación.', ['confirmation']), act('retry_process', 'Volver a ejecutar la historia', 'Crea un proceso nuevo pendiente de autorización.', ['authorization', 'ai_budget']), act('close_resolved', 'Cerrar como resuelta', 'Indica el motivo.'));
    else if (pl.pauseKind === 'disagreement') { actions.push(act('review_diff', 'Revisar el diff, el hallazgo y la respuesta del equipo', 'Decide tú con la evidencia de ambos.')); if (verifyOk) actions.push(act('merge', 'Integrar en main bajo tu criterio', 'La verificación automática está en verde; QA y el equipo discrepan. Requiere tu autorización.', ['authorization'])); actions.push(fix('Preparar una iteración con tu decisión'), ASK, act('reject', 'Rechazar el diff', 'Descarta el worktree y la rama.')); }
    else if (pl.pauseKind === 'too_large' || pl.pauseKind === 'incomplete') actions.push(resume('Reintentar solo lo que falta', 'Vuelve a intentar SOLO los entregables pendientes, con el motivo del fallo como instrucción (lo entregado no se repite ni se vuelve a cobrar), dentro del presupuesto que autorices.', ['authorization', 'ai_budget'], { pipeline: { maxCorrections: 1 }, suggestedBudgetUsd: 0.5 }), fix('Acotar o dividir la historia (nueva iteración)'), ASK, act('reject', 'Rechazar el diff', 'Descarta el worktree y la rama; la historia vuelve a pendiente.'));
    else if (pl.pauseKind === 'limit' || pl.pauseKind === 'repeated_failure') actions.push(resume('Conceder otra corrección', 'Autoriza una corrección más con la evidencia actual (un intento, dentro del presupuesto que fijes).', ['authorization', 'ai_budget'], { pipeline: { maxCorrections: 1 }, suggestedBudgetUsd: 0.5 }), fix('Preparar una iteración con el diagnóstico'), ASK, act('reject', 'Rechazar el diff', 'Descarta el worktree y la rama; la historia vuelve a pendiente.'));
    else if (pl.pauseKind === 'duration' || pl.pauseKind === 'cancelled') actions.push(resume('Continuar', 'Retoma donde lo dejó, sin repetir lo hecho.', ['authorization', 'ai_budget'], { suggestedBudgetUsd: 0 }));
    else if (pl.pauseKind === 'qa') { actions.push(act('review_diff', 'Revisar el diff y la evidencia', 'Decide tú con la verificación del sandbox a la vista.')); if (verifyOk) actions.push(act('merge', 'Integrar en main bajo tu criterio', 'La verificación automática está en verde; QA no pudo concluir. Requiere tu autorización.', ['authorization'])); actions.push(resume('Pedir a QA que vuelva a evaluar', 'Una nueva evaluación de QA con la misma evidencia.', ['authorization', 'ai_budget'], { suggestedBudgetUsd: 0.3 }), act('reject', 'Rechazar el diff', 'Descarta el worktree y la rama.')); }
    else if (pl.pauseKind === 'gauntlet') {
      // El Evaluador se detuvo (límite de rondas o sin progreso) con brechas bloqueantes y evidencia: lo hecho se conserva.
      const gs = r.gauntlet; const done = gs?.rounds.filter(x => x.decision === 'correct').length ?? 0;
      actions.push(act('review_diff', 'Revisar el diff y los hallazgos del Evaluador', 'Cada hallazgo trae su evidencia (archivo, fragmento o salida de la verificación).'));
      if (done < GAUNTLET_LIMITS.deep) actions.push(resume('Conceder otra corrección dirigida', `El Desarrollador corrige SOLO la brecha señalada y el Evaluador re-evalúa (ronda ${done + 2} como máximo; QA no repite lo ya aprobado).`, ['authorization', 'ai_budget'], { pipeline: { maxCorrections: 1, gauntlet: { mode: 'deep', maxRounds: done + 1 } }, suggestedBudgetUsd: 0.5 }));
      actions.push(resume('Continuar sin más evaluación', 'Las brechas quedan documentadas en el informe del Evaluador; la historia sigue a tu revisión y aceptación. No llama a la IA.', ['authorization'], { pipeline: { gauntlet: { mode: 'off', maxRounds: 0 } } }), fix('Preparar una iteración con los hallazgos'), act('reject', 'Rechazar el diff', 'Descarta el worktree y la rama; la historia vuelve a pendiente.'));
    }
    else if (pl.pauseKind === 'integration') {
      // Candidato de integración (main incorporado en la rama) verificado o no, sin IA. Integrar lo decide el propietario.
      const cand = r.integration;
      issue = { ...issue!, cause: verifyOk ? 'decision' : 'code', title: verifyOk ? `Candidato de integración verificado contra ${cand?.target ?? 'main'} ${cand?.targetHead ?? ''}`.trim() : 'El candidato de integración no pasa la verificación', level: verifyOk ? 'warning' : 'blocker' };
      if (verifyOk) {
        actions.push(resume('Pedir a QA que revise el candidato (sin correcciones nuevas)', 'QA evalúa el candidato (la historia con el main actual incorporado) con la evidencia del sandbox. No se autoriza ninguna corrección nueva: si QA rechaza, se detiene y decides tú.', ['authorization', 'ai_budget'], { pipeline: { maxCorrections: 0 }, suggestedBudgetUsd: 0.5, primary: true }));
        actions.push(act('merge', 'Integrar en main sin nueva revisión de QA', `El candidato está verificado en el sandbox con el main actual incorporado; QA ${pl.lastQaCommit === r.applied?.commit ? 'ya revisó este commit' : gauntletReviewed(r.gauntlet, r.applied?.commit) ? 'aprobó el commit anterior y el Evaluador Gauntlet re-evaluó este' : 'no ha revisado este commit'}. Merge sin fast-forward en main. Requiere tu autorización.`, ['authorization']));
      } else actions.push(resume('Pedir al equipo que corrija el candidato', 'Una corrección dirigida con la evidencia del sandbox sobre el candidato (la historia con el main actual incorporado), dentro del presupuesto que autorices.', ['authorization', 'ai_budget'], { pipeline: { maxCorrections: 1 }, suggestedBudgetUsd: 0.5, primary: true }), ASK);
      actions.push(act('review_diff', 'Revisar el diff del candidato', 'Incluye lo que aporta main y lo de la historia.'), act('reject', 'Rechazar el diff', 'Descarta el worktree y la rama; la historia vuelve a pendiente.'));
    }
    else if (pl.pauseKind === 'integration_conflict') {
      const files = opts.integration?.state === 'conflicts' ? opts.integration.conflicts.map(c => c.path) : r.integration?.conflicts ?? [];
      issue = { ...issue!, cause: 'decision', title: `Conflictos reales con main en ${files.length} archivo(s): no hace falta otra iteración`, details: [...files.map(f => ({ text: opts.integration?.conflicts.find(c => c.path === f)?.message ?? 'archivo en conflicto', file: f })), ...issue!.details], files };
      actions.push(act('integration_resolve', `Pedir al equipo que resuelva solo ${files.length === 1 ? 'el conflicto' : `los ${files.length} conflictos`}`, 'Una llamada del Desarrollador autorizado con SOLO las secciones en conflicto (base común, versión de main y de la historia, y los criterios de aceptación). Después se verifica en el sandbox sin IA y se detiene: no integra.', ['authorization', 'ai_budget'], { primary: true, suggestedBudgetUsd: 0.5 }), act('integration_prepare', 'Volver a comprobar la integración (sin IA)', 'Por si main cambió: vuelve a calcular la combinación y, si ya no hay conflictos, prepara el candidato con git.', ['authorization']), ASK, fix('Rehacer en una nueva iteración (último recurso)'));
    }
    else if (pl.pauseKind === 'external') {
      actions.push(act('review_diff', 'Revisar el diff', 'Incluye la corrección externa y todo lo del equipo.'));
      if (verifyOk) actions.push(resume('Pasar a QA (sin correcciones nuevas)', 'QA evalúa el commit actual con la evidencia del sandbox. No se autoriza ninguna corrección nueva del equipo: si QA rechaza, se detiene y decides tú.', ['authorization', 'ai_budget'], { pipeline: { maxCorrections: 0 }, suggestedBudgetUsd: 0.5 }));
      else actions.push(resume('Conceder otra corrección al equipo', 'El equipo corrige con la evidencia del sandbox sobre el código actual (un intento, dentro del presupuesto que fijes).', ['authorization', 'ai_budget'], { pipeline: { maxCorrections: 1 }, suggestedBudgetUsd: 0.5 }));
      actions.push(ASK, act('reject', 'Rechazar el diff', 'Descarta el worktree y la rama; la historia vuelve a pendiente.'));
    }
    else if (pl.pauseKind === 'no_changes') actions.push(act('close_resolved', 'Cerrar como resuelta', 'Si estás de acuerdo con la justificación, cierra la historia indicando el motivo.'), act('new_iteration', 'Preparar otra iteración', 'Si sí hacen falta cambios, explica qué en la nueva iteración.', ['confirmation']));
    else if (!r.applied && valid) actions.push(resume('Aplicar, verificar y validar automáticamente', 'El equipo aplica en el worktree aislado, verifica en el sandbox y QA valida con evidencia, dentro del presupuesto que autorices.', ['authorization', 'ai_budget'], { suggestedBudgetUsd: 0.5 }), act('review_diff', 'Ver el diff', 'Revisa los cambios archivo por archivo.'));
    else actions.push(resume('Continuar', 'Retoma donde lo dejó.', ['authorization', 'ai_budget'], { suggestedBudgetUsd: 0.3 }));
    // Commits o cambios hechos fuera del equipo: continuar con la evidencia guardada pagaría contra un código que ya no
    // existe. Se ofrece registrarlos (sin IA) y no se ofrece continuar hasta entonces.
    const d = opts.drift;
    if (d && d.state !== 'same') {
      for (let i = actions.length - 1; i >= 0; i--) if (actions[i].id === 'pipeline_resume') actions.splice(i, 1);
      issue = { ...issue!, title: d.state === 'ahead' ? 'Hay una corrección hecha fuera del equipo sin registrar' : issue!.title, explanation: `${driftMessage(d)} ${issue!.explanation}`.trim() };
      if (d.state === 'ahead') actions.unshift(act('register_external', 'Registrar la corrección externa y verificarla (sin IA)', `El commit ${d.head} (${d.files.length} archivo(s)) se registra como corrección del propietario, con sus archivos reales; se verifica en el sandbox sin llamar a la IA y se detiene antes de QA. No se borra ni se reescribe nada del historial y las correcciones del equipo no cambian.`, ['authorization'], { external: { commit: d.head, recorded: d.recorded, files: d.files } }));
    }
    return finish();
  }
  // Proceso terminado sin pipeline con cambios sin aplicar: se puede encargar el resto al equipo (opción, no obligación).
  const autoOffer = !pl && !r.applied && !r.rejected && r.changes.some(c => !c.error)
    ? act('pipeline_resume', 'Aplicar, verificar y validar automáticamente', 'El equipo aplica en el worktree aislado, verifica en el sandbox (typecheck, test, build) y QA valida con evidencia, corrigiendo errores rutinarios dentro del presupuesto que autorices. Nunca integra ni publica.', ['authorization', 'ai_budget'], { pipeline: {}, suggestedBudgetUsd: 0.5 })
    : null;

  // 2 · Revisión del diff y de QA
  const applicable = r.changes.filter(c => !c.error).length;
  const qaIssues = (r.review?.issues ?? []).map(i => { const q = qaSeverity(i); return { text: q.text, severity: q.severity, file: filesIn(i)[0] ?? null }; });
  const order = { alta: 0, media: 1, baja: 2 } as const; qaIssues.sort((a, b) => order[a.severity] - order[b.severity]);
  const qaRejects = !!r.review && !r.review.approve;
  if (r.rejected && !r.merged) {
    set('review', 'rejected', `Rechazado: ${r.rejected.reason}`);
    issue = { kind: 'diff_rejected', level: 'blocker', cause: 'decision', title: 'Esta iteración se rechazó', explanation: `Motivo: ${r.rejected.reason}. La historia volvió a pendiente; la siguiente iteración recibe el feedback y lo ocurrido aquí.`, details: [], files: [], responsible: [] };
    actions.push(act('new_iteration', 'Crear una nueva iteración', 'Prepara la siguiente iteración con el contexto acumulado. Queda pendiente de tu autorización.', ['confirmation']));
    return finish();
  }
  if (!applicable) {
    set('review', 'failed', 'Sin cambios aplicables');
    issue = { kind: 'patch_failed', level: 'blocker', cause: 'code', title: 'El equipo no entregó cambios aplicables', explanation: 'Ningún cambio se puede escribir (rutas protegidas o parches que no encajan). Una nueva iteración con el estado actual de los archivos suele resolverlo.', details: r.changes.map(c => ({ text: c.error ?? 'no aplicable', file: c.path })), files: r.changes.map(c => c.path), responsible: devs };
    actions.push(fix('Pedir al equipo que lo rehaga'), act('retry_process', 'Volver a ejecutar la historia', 'Crea un proceso nuevo pendiente de autorización.', ['authorization', 'ai_budget']));
    return finish();
  }
  const partial = r.changes.filter(c => c.error);
  const qaText = r.review ? (r.review.approve ? 'QA aprobó' : `QA no aprueba · ${qaIssues.length} observaciones (${qaIssues.filter(i => i.severity === 'alta').length} altas)`) : 'sin revisión de QA';
  if (r.applied) set('review', qaRejects ? 'warning' : 'done', `${applicable} archivo(s) · ${qaText}${qaRejects ? ' · se aplicó igualmente' : ''}`);
  else {
    set('review', qaRejects ? 'warning' : 'current', `${applicable} archivo(s) · ${qaText}${partial.length ? ` · ${partial.length} no aplicable(s)` : ''}`);
    if (qaRejects) {
      forced = 'review';
      issue = { kind: 'qa_rejected', level: 'warning', cause: 'code', title: `QA no aprueba el diff: ${qaIssues.length} observación(es)`, explanation: `${r.review!.summary} Puedes pedir al equipo que las corrija (recomendado si hay observaciones altas), preguntar a QA, convertirlas en tareas o aplicar igualmente bajo tu criterio.`, details: qaIssues, files: Array.from(new Set(qaIssues.map(i => i.file).filter(Boolean) as string[])), responsible: [...devs, ...qa] };
      actions.push(fix('Pedir al equipo que corrija las observaciones'), ASK, TASKS, act('apply', 'Aplicar igualmente', 'Escribe los cambios en un worktree aislado pese a las observaciones (tu carpeta no cambia). Requiere tu autorización.', ['authorization']), act('reject', 'Rechazar el diff', 'La historia vuelve a pendiente; el diff queda archivado.'));
    } else {
      if (partial.length) issue = { kind: 'patch_failed', level: 'warning', cause: 'code', title: `${partial.length} cambio(s) no se pueden aplicar`, explanation: 'El resto sí. Si esos archivos son necesarios, pide al equipo que los rehaga sobre el código actual.', details: partial.map(c => ({ text: c.error!, file: c.path })), files: partial.map(c => c.path), responsible: devs };
      if (autoOffer) actions.push(autoOffer);
      actions.push(act('apply', `Aplicar ${applicable} cambio(s) en un worktree`, 'Escribe los cambios en una rama propia, fuera de tu carpeta del Portal. Requiere tu autorización.', ['authorization']), act('review_diff', 'Ver el diff', 'Revisa los cambios archivo por archivo.'), ...(partial.length ? [fix('Pedir que rehagan los no aplicables')] : []), act('reject', 'Rechazar el diff', 'La historia vuelve a pendiente.'));
    }
    return finish();
  }

  // 3 · Aplicado
  const legacy = !r.applied.worktree && !r.merged;
  set('apply', legacy ? 'warning' : 'done', legacy ? `En tu carpeta (rama ${r.applied.branch}, antes de v0.12)` : `${r.applied.branch} · ${r.applied.commit}`);
  if (legacy) {
    set('verify', 'blocked', 'No verificable: aplicada sin worktree');
    issue = { kind: 'legacy', level: 'blocker', cause: 'decision', title: 'Iteración anterior a v0.12', explanation: `Se aplicó directamente en tu carpeta (rama ${r.applied.branch}), sin worktree aislado, así que no puede verificarse en sandbox ni integrarse. Si lo pedido ya funciona, ciérrala como resuelta; si no, prepara otra iteración (la rama se conserva).`, details: [], files: r.applied.files, responsible: [] };
    actions.push(act('close_resolved', 'Cerrar como resuelta', 'Cierra la historia indicando el motivo (queda registrado).'), act('new_iteration', 'Descartar y preparar otra iteración', 'La rama se conserva en git; la nueva iteración queda pendiente de tu autorización.', ['confirmation']));
    return finish();
  }

  // 4 · Verificación
  const need = opts.isPortalRepo ? ['typecheck', 'test', 'build'] : ['typecheck'];
  if (!r.merged) {
    const since = sinceApplied(p); const lastOf = (c: string) => since.filter(v => v.command === c).at(-1);
    const lastInstall = lastOf('install');
    const noDeps = (v?: VerificationRun) => !!v && v.exitCode === DEPS_MISSING_EXIT && v.isolation === 'docker' && !(lastInstall?.exitCode === 0 && lastInstall.startedAt > v.startedAt);
    const blockedDeps = need.filter(c => noDeps(lastOf(c)));
    const failed = need.map(lastOf).filter((v): v is VerificationRun => !!v && v.exitCode !== null && v.exitCode !== 0 && v.exitCode !== DEPS_MISSING_EXIT && v.isolation !== 'unavailable');
    const timedOut = need.map(lastOf).filter((v): v is VerificationRun => !!v && v.exitCode === null);
    const ok = need.filter(c => lastOf(c)?.exitCode === 0);
    const missing = need.filter(c => !ok.includes(c));
    const unavailable = opts.sandbox === 'unavailable' || need.some(c => lastOf(c)?.isolation === 'unavailable');
    const summary = need.map(c => { const v = lastOf(c); return `${c}: ${!v ? '—' : v.exitCode === 0 ? 'ok' : v.exitCode === null ? 'no terminó' : noDeps(v) ? 'sin dependencias' : v.isolation === 'unavailable' ? 'sin sandbox' : 'falló'}`; }).join(' · ');
    // Un fallo real del código (se ejecutó y falló) tiene prioridad sobre los requisitos del entorno de lo que falta.
    if (failed.length) {
      set('verify', 'failed', summary);
      issue = verificationIssue(failed[0], devs);
      if (failed.length > 1) issue.explanation += ` También falló: ${failed.slice(1).map(v => v.command).join(', ')}.`;
      actions.push(fix(), ASK, TASKS, act('retry_verification', 'Repetir la verificación', `Vuelve a ejecutar ${failed.map(v => v.command).join(', ')} en el sandbox (útil si el fallo fue intermitente).`, ['authorization'], { commands: failed.map(v => v.command) }), act('reject', 'Rechazar el diff', 'Descarta el worktree y la rama; la historia vuelve a pendiente.'));
      return finish();
    }
    if (timedOut.length) {
      set('verify', 'blocked', summary);
      issue = { kind: 'sandbox_timeout', level: 'blocker', cause: 'environment', command: timedOut.map(v => v.command).join(', '), title: 'La verificación no terminó (tiempo agotado)', explanation: `El sandbox no devolvió resultado de ${timedOut.map(v => v.command).join(', ')} en el tiempo máximo y se detuvo. Suele ser un problema del motor de Docker (Docker Desktop bloqueado o sin recursos), no del código. Comprueba que Docker Desktop responde y repite la verificación; si se repite, reinicia Docker Desktop.`, details: [{ text: 'Abre Docker Desktop y comprueba que dice «Engine running».' }, { text: 'Si no responde, reinícialo (Troubleshoot → Restart) y repite la verificación.' }], files: [], evidence: tailOf(timedOut[0].output), responsible: [] };
      actions.push(act('retry_verification', 'Repetir la verificación', `Vuelve a ejecutar ${timedOut.map(v => v.command).join(', ')} en el sandbox.`, ['authorization'], { commands: missing }), act('refresh_sandbox', 'Comprobar el sandbox de nuevo', 'Vuelve a detectar Docker sin ejecutar nada.'), act('sandbox_help', 'Cómo preparar el sandbox', 'Guía paso a paso (docs/sandbox.md).'));
      return finish();
    }
    if (blockedDeps.length || (lastInstall && lastInstall.exitCode !== 0 && missing.length)) {
      set('verify', 'blocked', summary);
      const installFailed = !!lastInstall && lastInstall.exitCode !== 0 && !blockedDeps.length;
      issue = { kind: 'deps_missing', level: 'blocker', cause: 'environment', command: installFailed ? 'install' : blockedDeps.join(', '), title: installFailed ? 'Verificación bloqueada: la instalación de dependencias falló' : 'Verificación bloqueada: faltan las dependencias Linux', explanation: installFailed ? 'El sandbox no pudo instalar las dependencias de este proyecto (sin red, registro caído o package-lock inválido). No es un fallo del código. Revisa el detalle y vuelve a intentarlo.' : 'El entorno Docker necesita instalar las dependencias Linux de este proyecto antes de poder verificarlo. No es un error del código: se instala una vez por cada versión de package-lock.json y después se verifica sin red.', details: installFailed ? [{ text: tailOf(lastInstall!.output, 4) }] : [], files: [], evidence: installFailed ? tailOf(lastInstall!.output) : null, responsible: [] };
      actions.push(act('install_and_retry', 'Instalar dependencias y repetir la verificación', `Ejecuta «npm ci» en el sandbox con red temporal (solo durante la instalación, sin scripts del repositorio) y después repite ${missing.join(', ')} sin red. Conserva el historial de ejecuciones.`, ['authorization', 'network'], { commands: missing }));
      return finish();
    }
    if (unavailable && missing.length) {
      set('verify', 'blocked', 'Sin sandbox disponible');
      issue = { kind: 'sandbox_unavailable', level: 'blocker', cause: 'environment', title: 'Verificación bloqueada: no hay sandbox', explanation: `El código de los agentes solo se ejecuta en un entorno aislado y ahora no hay ninguno disponible (Docker Desktop parado o sin la imagen del sandbox). ${opts.isPortalRepo ? 'El Portal no se integra sin test y build en sandbox: es un control de seguridad.' : ''} Arranca Docker Desktop y comprueba de nuevo.`, details: [{ text: 'Abre Docker Desktop y espera a «Engine running».' }, { text: 'Si es la primera vez: docker build -t portal-ia-sandbox:1 -f docker/sandbox.Dockerfile docker (en la carpeta del Portal).' }, { text: 'Pulsa «Comprobar el sandbox de nuevo».' }], files: [], responsible: [] };
      actions.push(act('refresh_sandbox', 'Comprobar el sandbox de nuevo', 'Vuelve a detectar Docker/WSL2 sin ejecutar nada.'), act('sandbox_help', 'Cómo preparar el sandbox', 'Guía paso a paso (docs/sandbox.md).'));
      return finish();
    }
    if (missing.length) {
      set('verify', 'current', summary);
      actions.push(act('verify', `Verificar en sandbox (${missing.join(', ')})`, 'Ejecuta los comandos en el sandbox sobre el worktree, sin red y sin tocar tu carpeta. Requiere tu autorización.', ['authorization'], { commands: missing }));
      return finish();
    }
    set('verify', 'done', summary);
    // 5 · Integrar
    const ig = opts.integration ?? null;
    if ((r.mergeError && ig?.state !== 'clean' && ig?.state !== 'up_to_date') || ig?.state === 'conflicts') {
      // Conflictos REALES (los archivos que dice git): la implementación verificada se conserva y solo se resuelven esas
      // secciones. Antes se proponía rehacer la historia en una iteración nueva (HU-159 regeneró 1650 líneas por 2 archivos).
      const files = ig?.state === 'conflicts' ? ig.conflicts.map(c => c.path) : r.mergeError!.files;
      set('integrate', 'failed', `Conflictos reales con ${ig?.target ?? 'main'} en ${files.length} archivo(s)`);
      issue = { kind: 'merge_conflict', level: 'blocker', cause: 'decision', command: 'merge', title: `${ig?.target ?? 'main'} avanzó y hay conflictos reales en ${files.length} archivo(s): no hace falta otra iteración`, explanation: `La implementación verificada se conserva y nada se modificó (ni la rama ni ${ig?.target ?? 'main'}). ${ig ? `${ig.target} tiene ${ig.behindCount} commit(s) que la rama no tiene; ${ig.overlap.length} archivo(s) cambiaron en ambos lados y ${files.length} no se pueden combinar solos. ` : ''}El equipo puede resolver SOLO esas secciones (con la base común, la versión de ${ig?.target ?? 'main'} y la de la historia); el candidato se verifica en el sandbox antes de que decidas integrar.`, details: [...files.map(f => ({ text: ig?.conflicts.find(c => c.path === f)?.message ?? 'archivo en conflicto', file: f })), ...(ig?.behind ?? []).slice(0, 6).map(b => ({ text: `${ig!.target}: ${b.sha} ${b.subject}` }))], files, evidence: r.mergeError?.message ?? null, responsible: devs };
      actions.push(act('integration_resolve', `Pedir al equipo que resuelva solo ${files.length === 1 ? 'el conflicto' : `los ${files.length} conflictos`}`, 'Una llamada del Desarrollador autorizado con SOLO las secciones en conflicto y los criterios de aceptación; después se verifica en el sandbox sin IA y se detiene. No integra.', ['authorization', 'ai_budget'], { primary: true, suggestedBudgetUsd: 0.5 }), act('integration_prepare', 'Volver a comprobar la integración (sin IA)', 'Por si main cambió: si ya no hay conflictos, git prepara el candidato.', ['authorization']), ASK, fix('Rehacer en una nueva iteración (último recurso)'));
      return finish();
    }
    if (ig && ig.state === 'clean' && ig.behindCount > 0) {
      set('integrate', 'current', `${ig.target} avanzó ${ig.behindCount} commit(s): falta el candidato de integración`);
      issue = { kind: 'integration_behind', level: 'warning', cause: 'decision', command: 'merge', title: `${ig.target} avanzó ${ig.behindCount} commit(s) desde que nació la rama: se combinan sin conflictos`, explanation: `Antes de integrar, el Portal prepara el candidato: incorpora ${ig.target} (${ig.targetHead}) en la rama con un merge, sin IA y sin tocar ${ig.target}, y lo verifica en el sandbox. La implementación verificada se conserva. ${ig.overlap.length ? `${ig.overlap.length} archivo(s) cambiaron en ambos lados (${ig.overlap.slice(0, 5).join(', ')}): git los combina, pero hay que verificarlo.` : `Los cambios de ${ig.target} no tocan los archivos de la historia.`}`, details: ig.behind.slice(0, 8).map(b => ({ text: `${b.sha} ${b.subject}` })), files: ig.overlap, responsible: [] };
      actions.push(act('integration_prepare', 'Preparar el candidato de integración (sin IA)', `Incorpora ${ig.target} (${ig.targetHead}) en ${ig.branch} y verifica typecheck, test y build en el sandbox. No llama a la IA ni toca ${ig.target}; integrar sigue siendo tu decisión.`, ['authorization'], { primary: true }), act('review_diff', 'Revisar el diff', 'Lo que aporta la historia.'), act('reject', 'Rechazar el diff', 'Descarta el worktree y la rama.'));
      return finish();
    }
    set('integrate', 'current', `Rama ${r.applied.branch} verificada`);
    if (pl?.state === 'verified') {
      headline = r.review?.verdict === 'approved' ? 'Implementación verificada por QA — lista para revisión del propietario.' : 'Implementación verificada en el sandbox — lista para revisión del propietario (QA omitida).';
      actions.push(act('review_diff', 'Revisar el resultado verificado', 'Diff, verificación del sandbox y veredicto de QA, todo en esta página.'));
    }
    actions.push(act('merge', 'Integrar en main', 'Merge sin fast-forward de la rama verificada en main. Requiere tu autorización.', ['authorization']), act('reject', 'Rechazar el diff', 'Descarta el worktree y la rama.'));
    return finish();
  }
  set('verify', 'done', 'Verificada antes de integrar');
  set('integrate', 'done', `${r.merged.into} · ${r.merged.commit}`);

  // 6 · Activar y comprobar en ejecución (solo el Portal)
  if (opts.isPortalRepo) {
    if (!portal) { set('activate', 'done', 'No aplica (otro repositorio)'); set('runtime', 'done', 'No aplica'); }
    else if (!r.activation!.active) {
      if (opts.updateFailedLog) {
        set('activate', 'failed', 'La reconstrucción falló; la versión anterior sigue en marcha');
        const d = parseBuildErrors(opts.updateFailedLog);
        issue = { kind: 'activation_failed', level: 'blocker', cause: 'code', command: 'npm run build (activación)', title: 'La activación falló: el Portal no se pudo reconstruir', explanation: 'El build de la nueva versión falló, así que el Portal sigue sirviendo la versión anterior (nada se rompió). Si es un error del código integrado, pide una corrección; si fue algo puntual, reintenta.', details: d.length ? d : [{ text: tailOf(opts.updateFailedLog, 6) }], files: Array.from(new Set(d.map(x => x.file).filter(Boolean) as string[])), evidence: tailOf(opts.updateFailedLog), responsible: devs };
        actions.push(act('rebuild', 'Reintentar «Reconstruir y reiniciar»', 'Vuelve a construir la interfaz y reinicia el Portal (con tu autorización, en la barra del sistema).', ['authorization']), fix(), ASK);
        return finish();
      }
      set('activate', 'current', r.activation!.reason);
      actions.push(act('rebuild', 'Reconstruir y reiniciar el Portal', 'Construye la interfaz nueva aparte y reinicia el servidor; si el build falla, la versión anterior sigue funcionando. Requiere tu autorización.', ['authorization']));
      return finish();
    } else {
      set('activate', 'done', `En marcha con ${r.activation!.runningCommit}`);
      const rc = r.runtimeChecks;
      if (!runtimeVerified(rc)) {
        const failedChecks = rc?.results.filter(x => x.status === 'fail') ?? [];
        if (rc?.ranAt && failedChecks.length) {
          set('runtime', 'failed', `${failedChecks.length} comprobación(es) en rojo`);
          issue = { kind: 'runtime_failed', level: 'blocker', cause: 'code', command: failedChecks.map(x => `${x.check.kind} ${x.check.path}`).join(', '), title: 'La comprobación en ejecución falló', explanation: 'El cambio compila y está activo, pero el Portal en marcha no hace lo que prometía la historia. No se puede cerrar así; el equipo debe corregirlo con la evidencia.', details: failedChecks.map(x => ({ text: `${x.check.kind} ${x.check.path}${x.check.selector ? ` · ${x.check.selector}` : ''}: ${x.detail}` })), files: [], evidence: failedChecks.map(x => x.evidence).filter(Boolean).join('\n') || null, responsible: devs };
          actions.push(fix(), act('runtime_check', 'Volver a comprobar', 'Repite las comprobaciones HTTP y de navegador contra el Portal en marcha.', ['authorization']), ASK, TASKS);
          return finish();
        }
        if (rc?.ranAt && rc.results.some(x => x.status === 'skipped')) {
          set('runtime', 'blocked', 'Comprobaciones de interfaz sin ejecutar');
          issue = { kind: 'runtime_unavailable', level: 'blocker', cause: 'environment', title: 'Comprobación de interfaz pendiente: falta el navegador', explanation: 'Las comprobaciones HTTP pasaron, pero las de interfaz necesitan Playwright con Chromium y no están disponibles. No se dan por buenas sin evidencia.', details: [{ text: 'En la carpeta del Portal: npm i -D playwright && npx playwright install chromium' }, { text: 'Después pulsa «Volver a comprobar».' }], files: [], responsible: [] };
          actions.push(act('runtime_check', 'Volver a comprobar', 'Repite las comprobaciones.', ['authorization']));
          return finish();
        }
        set('runtime', 'current', `${(rc?.checks.length ?? 0) + 2} comprobaciones (HTTP y navegador)`);
        actions.push(act('runtime_check', 'Comprobar en ejecución', 'El Portal se consulta a sí mismo (HTTP y navegador) y guarda capturas como evidencia.', ['authorization']));
        return finish();
      }
      set('runtime', 'done', `${rc!.results.length} comprobaciones en verde`);
    }
  }

  // 7 · Prueba manual
  const mt = r.manualTest; const fails = opts.failedSteps ?? [];
  if (!mt) {
    set('manual', 'current', 'Falta la lista de prueba');
    actions.push(act('manual_test', 'Crear la lista de prueba', 'Genérala con QA (una llamada corta, autorizada) o escríbela a mano.'));
    return finish();
  }
  const tested = mt.checks.filter(Boolean).length;
  if (fails.length) {
    set('manual', 'failed', `${fails.length} paso(s) con falla · ${tested} de ${mt.steps.length} OK`);
    issue = { kind: 'manual_failed', level: 'blocker', cause: 'code', title: `La prueba de aceptación falló en ${fails.length} paso(s)`, explanation: 'Lo que marcaste con «Falla» y tus comentarios van al equipo en una nueva iteración, junto con las tareas abiertas y el criterio vigente.', details: fails.map(f => ({ text: `Paso ${f.index + 1}: ${f.text}${f.comment ? ` → ${f.comment}` : ''}` })), files: [], responsible: devs };
    actions.push(fix('Enviar feedback al equipo (nueva iteración)'), TASKS, ASK);
    return finish();
  }
  if (tested < mt.steps.length) {
    set('manual', 'current', `${tested} de ${mt.steps.length} pasos probados`);
    actions.push(act('manual_test', 'Probar paso a paso', 'Sigue la lista «Qué probar» y marca OK, Falla u Observación en cada paso.'));
    return finish();
  }
  set('manual', 'done', `${mt.steps.length} de ${mt.steps.length} pasos OK`);
  if (opts.storyStatus === 'done') { set('close', 'done', r.published ? 'Cerrada y publicada' : 'Cerrada'); return finish(); }
  set('close', 'current', 'Lista para cerrar');
  actions.push(act('close', 'Marcar la historia como completada', 'Cierra la historia. Publicar en GitHub es opcional.'), act('new_iteration', 'Crear otra iteración', 'Si aún falta algo, prepara una iteración más (pendiente de autorización).', ['confirmation']));
  return finish();
}

/** Texto para el equipo (iteración correctiva / chat): el problema con su evidencia, sin que el propietario copie logs. */
export function issueForPrompt(issue: FlowIssue, p: Process): string {
  const r = p.result;
  return [
    `Problema: ${issue.title}${issue.command ? ` (comando/comprobación: ${issue.command})` : ''}.`,
    issue.explanation,
    r?.applied ? `Rama: ${r.applied.branch} (commit ${r.applied.commit}).` : '',
    issue.files.length ? `Archivos afectados: ${issue.files.join(', ')}.` : '',
    issue.details.length ? `Detalle:\n${issue.details.slice(0, 15).map(d => `- ${d.severity ? `[${d.severity}] ` : ''}${d.file ? `${d.file}${d.line ? `:${d.line}` : ''} ` : ''}${d.code ? `${d.code} ` : ''}${d.text}`).join('\n')}` : '',
    issue.evidence ? `Salida (últimas líneas):\n${issue.evidence.split('\n').slice(-20).join('\n')}` : ''
  ].filter(Boolean).join('\n');
}

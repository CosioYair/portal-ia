import type { FlowAction, FlowActionId, FlowIssue, FlowIssueDetail, FlowStage, FlowStageKey, FlowStageStatus, Isolation, Process, StoryFlow, VerificationRun } from '@portal-ia/domain';
import { filesIn, parseBuildErrors, parseFailingTests, parseTypeScriptErrors, qaSeverity, tailOf } from './diagnostics.ts';
import { runtimeVerified } from './runtimeChecks.ts';

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
  /** La última reconstrucción del Portal falló (log). */
  updateFailedLog?: string | null;
  iteration?: { number: number; total: number } | null;
}

const LABELS: Record<FlowStageKey, string> = {
  execute: 'Planificar e implementar (agentes)', review: 'Revisar los cambios y QA', apply: 'Aplicar en un worktree aislado',
  verify: 'Verificar en sandbox', integrate: 'Integrar en main', activate: 'Activar el Portal (reconstruir y reiniciar)',
  runtime: 'Comprobar en ejecución', manual: 'Prueba de aceptación paso a paso', close: 'Cerrar o iterar'
};
const usd = (n: number | null | undefined) => (n ?? 0).toFixed(2);
const ROLE: Record<string, string> = { planner: 'planifica', implementer: 'implementa', reviewer: 'revisa', consultant: 'consulta' };
const act = (id: FlowActionId, label: string, description: string, requires: FlowAction['requires'] = [], extra: Partial<FlowAction> = {}): FlowAction => ({ id, label, description, requires, primary: false, ...extra });
const ASK = act('ask_team', 'Preguntar al equipo sobre este problema', 'Abre el chat de la historia con el problema ya citado. Cada pregunta es una llamada a la IA que autorizas con un tope.', ['ai_budget']);
const TASKS = act('tasks_from_issue', 'Convertir en tareas', 'Crea una tarea por cada hallazgo (sin IA). Las tareas abiertas entran en la siguiente iteración.');
const fix = (label = 'Pedir al equipo que lo corrija') => act('request_fix', label, 'Prepara una iteración correctiva con el error, la evidencia, los archivos y los intentos anteriores. Queda pendiente de tu autorización y presupuesto: no gasta nada hasta entonces.', ['confirmation']);

/** Verificaciones relevantes desde que se aplicó (las anteriores son de otra versión del código). */
function sinceApplied(p: Process): VerificationRun[] {
  const r = p.result!; if (!r.applied) return [];
  const after = new Date(r.applied.appliedAt).getTime() - 1000;
  return (r.verifications ?? []).filter(v => new Date(v.startedAt).getTime() >= after);
}

export function verificationIssue(v: VerificationRun, responsible: string[]): FlowIssue {
  const files = (d: FlowIssueDetail[]) => Array.from(new Set(d.map(x => x.file).filter(Boolean) as string[]));
  if (v.command === 'typecheck') {
    const d = parseTypeScriptErrors(v.output);
    return { kind: 'typecheck_failed', level: 'blocker', cause: 'code', command: 'typecheck', title: `El código no compila: ${d.length ? `${d.length} error(es) de TypeScript` : 'typecheck falló'}`, explanation: 'TypeScript encontró errores en los cambios del equipo. No se puede integrar código que no compila; el equipo debe corregirlo en una nueva iteración.', details: d.length ? d : [{ text: tailOf(v.output, 6) || `typecheck terminó con código ${v.exitCode}` }], files: files(d).length ? files(d) : filesIn(v.output), evidence: tailOf(v.output), responsible };
  }
  if (v.command === 'test') {
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
  const keys: FlowStageKey[] = ['execute', 'review', 'apply', 'verify', 'integrate', ...(opts.isPortalRepo ? ['activate', 'runtime'] as FlowStageKey[] : []), 'manual', 'close'];
  const st: Record<string, { status: FlowStageStatus; detail: string }> = Object.fromEntries(keys.map(k => [k, { status: 'pending' as FlowStageStatus, detail: '' }]));
  const set = (k: FlowStageKey, status: FlowStageStatus, detail = '') => { if (st[k]) st[k] = { status, detail }; };
  let issue: FlowIssue | null = null; const actions: FlowAction[] = [];
  let forced: FlowStageKey | null = null; // etapa actual cuando una advertencia aún espera tu decisión
  const responsible = p.steps.filter(s => s.status === 'running').map(s => ({ agentName: s.agentName, role: ROLE[s.role ?? ''] ?? 'trabaja', status: 'trabajando' }));
  const implOut = !!p.steps.find(s => s.role === 'implementer')?.outputMd?.trim() || !!p.steps[1]?.outputMd?.trim();

  // 1 · Ejecución de los agentes
  if (p.status === 'pending_authorization') {
    set('execute', 'waiting', `Pendiente de autorización · estimación ≈ ${usd(p.estimatedUsd)} USD · ${p.steps.length} agentes`);
    actions.push(act('authorize', 'Revisar y autorizar la iteración', 'Revisa el equipo, el contexto que recibirá y fija un presupuesto máximo. Nada se gasta hasta que lo autorices.', ['authorization', 'ai_budget']));
  } else if (p.status === 'running') {
    const cur = p.steps.find(s => s.status === 'running'); const done = p.steps.filter(s => s.status === 'done').length;
    set('execute', 'running', `${cur ? `${cur.agentName} ${ROLE[cur.role ?? ''] ?? 'trabaja'}: ${cur.title}` : 'En curso'} · paso ${Math.min(done + 1, p.steps.length)} de ${p.steps.length}`);
    actions.push(act('cancel', 'Cancelar', 'Detiene el proceso al terminar el paso en curso; lo gastado hasta ahora se conserva.'));
  } else if (p.status === 'budget_exceeded') {
    set('execute', 'failed', `Detenido por presupuesto: ${usd(p.spentUsd)} de ${usd(p.budgetUsd)} USD`);
    issue = { kind: 'budget_exceeded', level: 'blocker', cause: 'decision', title: 'Se agotó el presupuesto autorizado', explanation: `El equipo gastó ${usd(p.spentUsd)} de ${usd(p.budgetUsd)} USD y se detuvo antes de terminar, como pediste. Para seguir hay que autorizar un presupuesto nuevo (o recuperar lo que ya entregó, sin IA).`, details: p.steps.filter(s => s.status !== 'done').map(s => ({ text: `${s.agentName}: ${s.title} — sin terminar` })), files: [], responsible: [] };
    if (implOut && !r?.applied) actions.push(act('recover', 'Recuperar lo entregado (sin IA)', 'Vuelve a leer lo que el Desarrollador ya entregó y deja el diff listo para revisar, sin gastar nada.'));
    actions.push(act('retry_process', 'Volver a ejecutar con un presupuesto nuevo', 'Crea un proceso nuevo pendiente de autorización: eliges el presupuesto antes de que empiece.', ['authorization', 'ai_budget']));
  } else if (p.status === 'failed' || p.status === 'cancelled') {
    const patch = /aplicable|BUSCAR|parche|no aparece en el archivo/i.test(p.error ?? '') || (r?.changes ?? []).some(c => c.error);
    set('execute', 'failed', p.status === 'cancelled' ? 'Cancelado' : `Falló: ${(p.error ?? '').slice(0, 140)}`);
    if (p.status === 'cancelled') issue = { kind: 'cancelled', level: 'blocker', cause: 'decision', title: 'Proceso cancelado', explanation: 'Se canceló antes de terminar. Puedes recuperar lo entregado (sin IA) o volver a ejecutarlo.', details: [], files: [], responsible: [] };
    else if (patch) {
      const bad = (r?.changes ?? []).filter(c => c.error);
      issue = { kind: 'patch_failed', level: 'blocker', cause: 'code', title: 'Los cambios del equipo no encajan en el código actual', explanation: 'El Desarrollador propuso modificar texto que ya no existe (o cambió desde que lo leyó). No se escribió nada. Una nueva iteración le da el estado actual de esos archivos para rehacerlo.', details: bad.length ? bad.map(c => ({ text: c.error!, file: c.path })) : [{ text: p.error ?? 'parche no aplicable' }], files: bad.map(c => c.path), responsible: devs };
    } else issue = { kind: 'process_failed', level: 'blocker', cause: 'environment', title: 'La ejecución del equipo falló', explanation: `El proceso se detuvo con un error: ${p.error ?? 'desconocido'}. ${implOut ? 'El Desarrollador sí entregó su trabajo: puedes recuperarlo sin IA.' : 'Puedes volver a ejecutarlo (quizá acotando la historia).'}`, details: p.error ? [{ text: p.error }] : [], files: [], responsible: [] };
    if (implOut && !r?.applied) actions.push(act('recover', 'Recuperar lo entregado (sin IA)', 'Vuelve a leer lo que el Desarrollador ya entregó con las reglas actuales, sin gastar nada.'));
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
    return { stages: stages2, current, progress: { done: stages2.filter(s => s.status === 'done' || s.status === 'warning').length, total: stages2.length }, issue, actions, responsible: resp, iteration: opts.iteration ?? null };
  };
  if (p.status !== 'done' || !r) return finish();

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
    if (r.mergeError) {
      set('integrate', 'failed', 'Conflicto al integrar');
      issue = { kind: 'merge_conflict', level: 'blocker', cause: 'code', command: 'merge', title: 'No se pudo integrar: hay conflictos con main', explanation: 'Mientras esta iteración estaba en su rama, main cambió en los mismos archivos. Nada se modificó (el merge se deshizo). La forma controlada de resolverlo es que el equipo rehaga los cambios sobre el main actual en una nueva iteración.', details: [{ text: r.mergeError.message.slice(0, 400) }, ...r.mergeError.files.map(f => ({ text: 'archivo en conflicto', file: f }))], files: r.mergeError.files, evidence: r.mergeError.message, responsible: devs };
      actions.push(fix('Pedir al equipo que lo rehaga sobre el main actual'), ASK, act('merge', 'Reintentar la integración', 'Vuelve a intentar el merge (por si main cambió). Requiere tu autorización.', ['authorization']));
      return finish();
    }
    set('integrate', 'current', `Rama ${r.applied.branch} verificada`);
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

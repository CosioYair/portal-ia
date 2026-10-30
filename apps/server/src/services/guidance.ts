import type { Process, ProcessGuidance } from '@portal-ia/domain';
import { runtimeVerified } from './runtimeChecks.ts';
import { DEPS_MISSING_EXIT } from './sandbox.ts';
import { buildStoryFlow, type FlowOptions } from './storyFlow.ts';

/** Aplicada con el flujo anterior a v0.12 (sin worktree aislado) y sin integrar. */
export const isLegacyApplied = (p: Process) => !!p.result?.applied && !p.result.applied.worktree && !p.result.merged;
const implStep = (p: Process) => p.steps.find(s => s.role === 'implementer') ?? (p.steps.some(s => s.role) ? undefined : p.steps[1]);

/**
 * Una sola fuente de verdad sobre «qué pasa y qué toca hacer» con un proceso. La usan la vista del proceso, el backlog
 * y las tarjetas del Asistente, para que el estado que se muestra sea siempre el real.
 */
export type GuidanceOptions = Omit<FlowOptions, 'failedSteps'> & { failedSteps?: number; failedStepDetails?: FlowOptions['failedSteps']; supersededByIteration?: number | null };

/** Orientación + recorrido guiado (para historias). */
export function describeProcess(p: Process, opts: GuidanceOptions = {}): ProcessGuidance {
  // Archivado con una etapa anterior: histórico, sin recorrido ni acciones que recomendar.
  if (p.archivedAt) return { phase: 'Archivado (etapa anterior)', next: 'Es histórico y no requiere ninguna acción. Si necesitas retomarlo, restaura su historia desde el archivo.', tone: 'info', settled: true };
  // HU-161 · Iteración superada por otra más reciente: sin recorrido ni acciones de decisión (autorizar, aplicar,
  // integrar, publicar). Solo se puede decidir sobre la vigente o restaurar esta desde el historial.
  if (p.supersededBy) {
    const by = opts.supersededByIteration ? `la iteración ${opts.supersededByIteration}` : 'una iteración más reciente';
    return { phase: `Superada por ${by}`, next: `Superada por ${by}: decide sobre la vigente o restáurala desde el historial de la historia.`, tone: 'info', settled: true };
  }
  const g = describePhase(p, { ...opts, failedSteps: opts.failedSteps ?? opts.failedStepDetails?.length ?? 0 });
  if (p.kind !== 'story_execution') return g;
  // El recorrido nunca debe tumbar la orientación: si algo no encaja, se sirve sin él.
  try { return { ...g, flow: buildStoryFlow(p, { ...opts, failedSteps: opts.failedStepDetails ?? [] }) }; } catch { return g; }
}

function describePhase(p: Process, opts: GuidanceOptions): ProcessGuidance {
  // La historia ya se cerró (o se descartó): nada que hacer, aunque el proceso quede en su último paso.
  if (p.kind === 'story_execution' && p.status === 'done' && opts.storyStatus === 'done') return { phase: 'Historia completada', next: p.result?.published ? 'Cerrada y publicada. Nada pendiente.' : 'Cerrada. Publicar en el remoto es opcional y puede hacerse desde el proceso.', tone: 'ok', settled: true };
  if (p.kind === 'story_execution' && opts.storyStatus === 'discarded') return { phase: 'Historia descartada', next: 'La historia se descartó; reábrela desde el backlog si la necesitas.', tone: 'info', settled: true };
  const done = p.steps.filter(s => s.status === 'done').length;
  if (p.status === 'pending_authorization') return { phase: 'Pendiente de autorización', next: 'Nada se ha gastado. Autoriza el proceso con un presupuesto para que empiece.', tone: 'warn', settled: false };
  if (p.status === 'running') { const cur = p.steps.find(s => s.status === 'running'); return { phase: `En ejecución · paso ${Math.min(done + 1, p.steps.length)} de ${p.steps.length}${cur ? ` (${cur.title})` : ''}`, next: 'Espera a que termine; puedes cancelarlo entre pasos.', tone: 'info', settled: false }; }
  if (p.status === 'cancelled') return { phase: 'Cancelado', next: 'Si quieres retomarlo, pulsa «Volver a ejecutar».', tone: 'warn', settled: true };
  if (p.status === 'budget_exceeded') return { phase: 'Detenido por presupuesto', next: `Gastó ${p.spentUsd.toFixed(2)} de ${p.budgetUsd.toFixed(2)} USD. ${p.kind === 'story_execution' && implStep(p)?.outputMd?.trim() ? 'El Desarrollador sí entregó: puedes «Recuperar el resultado» sin IA, o ' : ''}«Volver a ejecutar» con más presupuesto o una historia más acotada.`, tone: 'warn', settled: true };
  if (p.status === 'failed') {
    const recoverable = p.kind === 'story_execution' && !!implStep(p)?.outputMd?.trim() && !p.result?.applied;
    return { phase: 'Falló', next: `${p.error ? `Motivo: ${p.error} ` : ''}${recoverable ? 'El Desarrollador sí entregó su trabajo: puedes «Recuperar el resultado» sin gastar IA, o «Volver a ejecutar».' : 'Pulsa «Volver a ejecutar» (acotando la historia si hizo falta).'}`, tone: 'err', settled: true };
  }
  // status === 'done'
  if (p.kind === 'initial_assessment') return { phase: 'Evaluación completada', next: 'Importa las historias de la síntesis en Backlog y ejecuta la primera.', tone: 'ok', settled: true };
  if (p.kind === 'delegated_task') {
    const d = p.delegation;
    if (d?.triage && !d.triage.accepted) return { phase: 'Encargo no aceptado por el responsable', next: d.triage.rejectionReason ?? 'Reformula el encargo o encárgalo a otro agente.', tone: 'warn', settled: true };
    if (d?.backlogOps.length && !d.opsApplied) return { phase: `Entregado · ${d.backlogOps.length} propuesta(s) al backlog esperan tu aprobación`, next: 'Revisa las propuestas y pulsa «Aplicar propuestas al backlog» si estás de acuerdo.', tone: 'warn', settled: false };
    return { phase: 'Encargo entregado', next: d?.opsApplied ? 'Propuestas aplicadas. El entregable está en Conocimiento.' : 'El entregable está en Conocimiento; no propuso cambios al backlog.', tone: 'ok', settled: true };
  }
  const r = p.result;
  if (!r) return { phase: 'Terminado', next: '—', tone: 'ok', settled: true };
  const applicable = r.changes.filter(c => !c.error).length;
  if (r.rejected && !r.merged) return { phase: r.applied ? (r.applied.worktree ? 'Diff rechazado (rama descartada)' : 'Iteración anterior a v0.12 descartada (rama conservada)') : 'Diff rechazado', next: `Motivo: ${r.rejected.reason}. La historia volvió a pendiente; ejecútala de nuevo cuando quieras.`, tone: 'warn', settled: true };
  if (!r.applied) {
    if (!applicable) return { phase: 'Terminado sin cambios aplicables', next: 'El Desarrollador no entregó cambios válidos. Acota la historia y vuelve a ejecutarla.', tone: 'err', settled: true };
    if (r.review && !r.review.approve) return { phase: `Diff entregado · QA NO aprueba (${r.review.issues.length} observaciones)`, next: 'Lee las observaciones de QA antes de decidir. Si son graves, pulsa «Rechazar el diff» y vuelve a ejecutar con un criterio más acotado; si son menores, aplica, verifica con typecheck/test y corrige en la rama.', tone: 'warn', settled: false };
    return { phase: `Diff listo para revisar (${applicable} archivo(s)${r.review ? ', QA aprobó' : ''})`, next: 'Revisa los cambios y, si estás conforme, pulsa «Aplicar» para escribirlos en una rama.', tone: 'warn', settled: false };
  }
  const mt = r.manualTest; const tested = mt ? mt.checks.filter(Boolean).length : 0; const untested = !mt || tested < mt.steps.length;
  // Orden del cierre (M2). Portal: aplicar → verificar (sandbox) → integrar → activar (reconstruir y reiniciar) →
  // comprobar en ejecución → probar paso a paso → cerrar. Otros repositorios: sin activar/comprobar. Publicar es opcional.
  // Portal: 8 pasos siempre; la rama de activación solo se evalúa cuando el servidor pudo calcularla (repositorio = carpeta en marcha).
  const portal = !!opts.isPortalRepo && r.activation !== undefined && r.activation !== null;
  // Misma numeración que el recorrido guiado (storyFlow): etapa 1 = planificar e implementar.
  const total = opts.isPortalRepo ? 9 : 7;
  const step = (n: number, label: string) => `Etapa ${n} de ${total} · ${label}`;
  // Prueba manual con pasos en «Falla» (integrada o iteración anterior a v0.12, que también se prueba): el siguiente
  // paso es devolver ese feedback al equipo, no cerrar.
  const fails = opts.failedSteps ?? 0;
  if (fails > 0 && (r.merged || isLegacyApplied(p))) return { phase: step(r.merged ? total - 1 : 4, `Probada · ${fails} paso(s) con falla`), next: `Hay ${fails} paso(s) marcados con «Falla» en «Qué probar». Pulsa «Enviar feedback al equipo» en «Pasos con falla» para crear una nueva iteración con esos fallos y tus comentarios (queda pendiente de tu autorización), o «Crear tareas con estos fallos» para seguirlos aparte.`, tone: 'err', settled: false };
  // Iteración aplicada antes de v0.12 (en la carpeta del Portal, sin worktree): no puede verificarse en sandbox ni integrarse
  // con el flujo actual. Salidas: cerrar la historia si ya está resuelta, o descartar la iteración y preparar una nueva.
  if (!r.merged && isLegacyApplied(p)) return { phase: `Iteración anterior a v0.12 · aplicada sin aislamiento en ${r.applied.branch}`, next: 'Esta iteración se aplicó con el método anterior (directamente en tu carpeta, sin worktree), así que no puede verificarse en sandbox ni integrarse. Si lo que pedía la historia ya funciona en tu Portal, pulsa «Cerrar como resuelta»; si no, pulsa «Descartar esta iteración y preparar otra» (la rama se conserva) y autoriza la nueva iteración.', tone: 'warn', settled: false };
  if (!r.merged) {
    const after = new Date(r.applied.appliedAt).getTime() - 1000;
    const since = (r.verifications ?? []).filter(v => new Date(v.startedAt).getTime() >= after);
    const lastOf = (c: string) => since.filter(v => v.command === c).at(-1);
    // Docker: sin dependencias Linux instaladas para este package-lock el sandbox no ejecuta nada (no es un fallo del código).
    // Si después se instaló bien, esa ejecución solo queda pendiente de repetir.
    const lastInstall = since.filter(v => v.command === 'install').at(-1);
    const noDeps = (v: (typeof since)[number]) => v.exitCode === DEPS_MISSING_EXIT && v.isolation === 'docker';
    const installedAfter = (v: (typeof since)[number]) => !!lastInstall && lastInstall.exitCode === 0 && lastInstall.startedAt > v.startedAt;
    const failed = ['typecheck', 'test', 'build'].map(lastOf).filter(v => v && v.exitCode !== null && v.exitCode !== 0 && !(noDeps(v) && installedAfter(v))) as typeof since;
    const depsMissing = failed.filter(noDeps);
    if (depsMissing.length) return { phase: step(4, `Aplicado en ${r.applied.branch} · faltan las dependencias del sandbox`), next: 'El sandbox Docker aún no tiene las dependencias (Linux) de este package-lock. En Verificar, marca «Permitir red solo para install» y pulsa «npm ci (install)» una vez; después repite typecheck, test y build (sin red).', tone: 'warn', settled: false };
    if (failed.length) return { phase: step(4, `Aplicado en ${r.applied.branch} · verificación FALLÓ (${failed.map(v => v.command).join(', ')})`), next: 'Lee la salida de la verificación. Corrige con una nueva iteración de la historia (el equipo recibe el error) o rechaza el diff; no se integra código que no compila.', tone: 'err', settled: false };
    const need = opts.isPortalRepo ? ['typecheck', 'test', 'build'] : ['typecheck'];
    const missing = need.filter(c => !(lastOf(c)?.exitCode === 0));
    if (missing.length) return { phase: step(4, `Aplicado en ${r.applied.branch} · falta verificar (${missing.join(', ')})`), next: `Ejecuta ${missing.join(', ')} desde el proceso (en sandbox${opts.isPortalRepo ? '; el Portal exige test y build en Docker/WSL2' : ''}) y, en verde, pulsa «Integrar en la rama principal».`, tone: 'warn', settled: false };
    return { phase: step(5, `Verificado en ${r.applied.branch} · falta integrar`), next: 'Pulsa «Integrar en la rama principal» (merge sin fast-forward en main).', tone: 'warn', settled: false };
  }
  if (portal) {
    const act = r.activation!;
    if (!act.active) return { phase: step(6, `Integrada en ${r.merged.into} · NO activada`), next: `${act.reason} Pulsa «Reconstruir y reiniciar» en la barra del sistema; el estado pasará a «Activada» solo cuando el Portal en marcha contenga el commit ${r.merged.commit}.`, tone: 'warn', settled: false };
    const rc = r.runtimeChecks;
    if (!runtimeVerified(rc)) {
      if (rc?.ranAt && rc.results.some(x => x.status === 'fail')) return { phase: step(7, `Activada (${act.runningCommit}) · comprobación en ejecución FALLÓ`), next: `Falló: ${rc.results.filter(x => x.status === 'fail').map(x => `${x.check.kind} ${x.check.path}`).join(', ')}. Revisa el detalle y la evidencia; corrige con una nueva iteración o devuelve la historia a pendiente con el motivo. No puede cerrarse así.`, tone: 'err', settled: false };
      if (rc?.ranAt && rc.results.some(x => x.status === 'skipped')) return { phase: step(7, `Activada (${act.runningCommit}) · comprobación de interfaz pendiente`), next: 'Las comprobaciones HTTP pasaron pero las de interfaz no pudieron ejecutarse (falta Playwright). Instálalo y vuelve a «Comprobar en ejecución»; no se da por verificada sin evidencia.', tone: 'warn', settled: false };
      return { phase: step(7, `Activada (${act.runningCommit}) · falta comprobar en ejecución`), next: 'Pulsa «Comprobar en ejecución»: el Portal se consulta a sí mismo (HTTP y navegador) y guarda la evidencia.', tone: 'warn', settled: false };
    }
    if (untested && !mt) return { phase: step(8, 'Verificada en ejecución · falta la lista de prueba'), next: 'Genera la lista de prueba con QA (una llamada corta) o escríbela a mano; después pruébala paso a paso.', tone: 'warn', settled: false };
    if (untested) return { phase: step(8, `Verificada en ejecución · falta probar (${tested} de ${mt!.steps.length} pasos)`), next: 'Sigue la lista «Qué probar» en el Portal y marca «OK» en cada paso que funcione. Si algo falla, márcalo con «Falla», comenta qué viste y pulsa «Enviar feedback al equipo».', tone: 'warn', settled: false };
    return { phase: step(9, `Listo para cerrar (activada y probada${r.published ? ', publicada' : ''})`), next: `Pulsa «Marcar historia como completada».${r.published ? '' : ' Publicar en el remoto es opcional y puede hacerse después.'}`, tone: 'ok', settled: false };
  }
  if (untested && !mt) return { phase: step(6, `Integrado en ${r.merged.into} · falta la lista de prueba`), next: 'En el Resumen del proceso, genera la lista de prueba con QA (una llamada corta) o escríbela a mano; después pruébala paso a paso.', tone: 'warn', settled: false };
  if (untested) return { phase: step(6, `Integrado en ${r.merged.into} · falta probar (${tested} de ${mt!.steps.length} pasos)`), next: `${opts.isPortalRepo ? 'Reconstruye y reinicia el Portal (barra amarilla) si aún no lo has hecho; luego s' : 'S'}igue la lista «Qué probar» y marca «OK» en cada paso que funcione. Si algo falla, márcalo con «Falla», comenta qué viste y pulsa «Enviar feedback al equipo».`, tone: 'warn', settled: false };
  return { phase: step(7, `Listo para cerrar (${r.merged.into}, probado${r.published ? `, publicado en ${r.published.remote}` : ''})`), next: `Pulsa «Marcar historia como completada».${r.published ? '' : ' Publicar en el remoto es opcional.'}`, tone: 'ok', settled: false };
}

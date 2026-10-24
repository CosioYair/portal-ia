import type { Process, ProcessGuidance } from '@portal-ia/domain';

/**
 * Una sola fuente de verdad sobre «qué pasa y qué toca hacer» con un proceso. La usan la vista del proceso, el backlog
 * y las tarjetas del Asistente, para que el estado que se muestra sea siempre el real.
 */
export function describeProcess(p: Process, opts: { isPortalRepo?: boolean } = {}): ProcessGuidance {
  const done = p.steps.filter(s => s.status === 'done').length;
  if (p.status === 'pending_authorization') return { phase: 'Pendiente de autorización', next: 'Nada se ha gastado. Autoriza el proceso con un presupuesto para que empiece.', tone: 'warn', settled: false };
  if (p.status === 'running') { const cur = p.steps.find(s => s.status === 'running'); return { phase: `En ejecución · paso ${Math.min(done + 1, p.steps.length)} de ${p.steps.length}${cur ? ` (${cur.title})` : ''}`, next: 'Espera a que termine; puedes cancelarlo entre pasos.', tone: 'info', settled: false }; }
  if (p.status === 'cancelled') return { phase: 'Cancelado', next: 'Si quieres retomarlo, pulsa «Volver a ejecutar».', tone: 'warn', settled: true };
  if (p.status === 'budget_exceeded') return { phase: 'Detenido por presupuesto', next: `Gastó ${p.spentUsd.toFixed(2)} de ${p.budgetUsd.toFixed(2)} USD. ${p.kind === 'story_execution' && p.steps[1]?.outputMd?.trim() ? 'El Desarrollador sí entregó: puedes «Recuperar el resultado» sin IA, o ' : ''}«Volver a ejecutar» con más presupuesto o una historia más acotada.`, tone: 'warn', settled: true };
  if (p.status === 'failed') {
    const recoverable = p.kind === 'story_execution' && !!p.steps[1]?.outputMd?.trim() && !p.result?.applied;
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
  if (r.rejected && !r.applied) return { phase: 'Diff rechazado', next: `Motivo: ${r.rejected.reason}. La historia volvió a pendiente; ejecútala de nuevo cuando quieras.`, tone: 'warn', settled: true };
  if (!r.applied) {
    if (!applicable) return { phase: 'Terminado sin cambios aplicables', next: 'El Desarrollador no entregó cambios válidos. Acota la historia y vuelve a ejecutarla.', tone: 'err', settled: true };
    if (r.review && !r.review.approve) return { phase: `Diff entregado · QA NO aprueba (${r.review.issues.length} observaciones)`, next: 'Lee las observaciones de QA antes de decidir. Si son graves, pulsa «Rechazar el diff» y vuelve a ejecutar con un criterio más acotado; si son menores, aplica, verifica con typecheck/test y corrige en la rama.', tone: 'warn', settled: false };
    return { phase: `Diff listo para revisar (${applicable} archivo(s)${r.review ? ', QA aprobó' : ''})`, next: 'Revisa los cambios y, si estás conforme, pulsa «Aplicar» para escribirlos en una rama.', tone: 'warn', settled: false };
  }
  const mt = r.manualTest; const tested = mt ? mt.checks.filter(Boolean).length : 0; const untested = !!mt && tested < mt.steps.length;
  // Orden del cierre: aplicar → verificar → integrar → (reconstruir y reiniciar si es el Portal) → probar paso a paso → publicar → cerrar.
  if (!r.merged) return { phase: `Paso 2 de 7 · Aplicado en ${r.applied.branch} · falta integrar`, next: `Ejecuta la verificación (${r.verifyCommands.join(', ') || 'typecheck'}) y pulsa «Integrar en la rama principal».`, tone: 'warn', settled: false };
  if (untested) return { phase: `Paso 5 de 7 · Integrado en ${r.merged.into} · falta probar (${tested} de ${mt!.steps.length} pasos)`, next: `${opts.isPortalRepo ? 'Reconstruye y reinicia el Portal (barra amarilla) si aún no lo has hecho; luego s' : 'S'}igue la lista «Qué probar» y marca cada paso que funcione. Si algo falla, devuelve la historia a pendiente con el motivo.`, tone: 'warn', settled: false };
  if (!r.published) return { phase: `Paso 6 de 7 · ${mt ? 'Probado' : 'Integrado'} · falta publicar`, next: 'Pulsa «Publicar en el remoto» para subir main a GitHub y después cierra la historia.', tone: 'warn', settled: false };
  return { phase: `Paso 7 de 7 · Listo para cerrar (${r.merged.into} → ${r.published.remote}${mt ? ', probado' : ''})`, next: 'Pulsa «Marcar historia como completada».', tone: 'ok', settled: false };
}

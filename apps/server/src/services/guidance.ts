import type { Process, ProcessGuidance } from '@portal-ia/domain';

/**
 * Una sola fuente de verdad sobre «qué pasa y qué toca hacer» con un proceso. La usan la vista del proceso, el backlog
 * y las tarjetas del Asistente, para que el estado que se muestra sea siempre el real.
 */
export function describeProcess(p: Process, opts: { isPortalRepo?: boolean } = {}): ProcessGuidance {
  const done = p.steps.filter(s => s.status === 'done').length;
  if (p.status === 'pending_authorization') return { phase: 'Pendiente de autorización', next: 'Nada se ha gastado. Autoriza el proceso con un presupuesto para que empiece.', tone: 'warn', settled: false };
  if (p.status === 'running') { const cur = p.steps.find(s => s.status === 'running'); return { phase: `En ejecución · paso ${Math.min(done + 1, p.steps.length)} de ${p.steps.length}${cur ? ` (${cur.title})` : ''}`, next: 'Espera a que termine; puedes cancelarlo entre pasos.', tone: 'info', settled: false }; }
  if (p.status === 'cancelled') return { phase: 'Cancelado', next: 'Si quieres retomarlo, vuelve a ejecutarlo desde el backlog.', tone: 'warn', settled: true };
  if (p.status === 'budget_exceeded') return { phase: 'Detenido por presupuesto', next: `Gastó ${p.spentUsd.toFixed(2)} de ${p.budgetUsd.toFixed(2)} USD. Vuelve a ejecutarlo con más presupuesto o acota la historia.`, tone: 'warn', settled: true };
  if (p.status === 'failed') return { phase: 'Falló', next: p.error ? `Motivo: ${p.error} Corrige la causa (o acota la historia) y vuelve a ejecutar.` : 'Revisa el error del paso fallido y vuelve a ejecutar.', tone: 'err', settled: true };
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
  if (!r.applied) {
    if (!applicable) return { phase: 'Terminado sin cambios aplicables', next: 'El Desarrollador no entregó cambios válidos. Acota la historia y vuelve a ejecutarla.', tone: 'err', settled: true };
    return { phase: `Diff listo para revisar (${applicable} archivo(s)${r.review ? r.review.approve ? ', QA aprobó' : ', QA con observaciones' : ''})`, next: 'Revisa los cambios y, si estás conforme, pulsa «Aplicar» para escribirlos en una rama.', tone: 'warn', settled: false };
  }
  if (!r.merged) return { phase: `Aplicado en ${r.applied.branch} · falta integrar`, next: `Ejecuta la verificación si quieres (${r.verifyCommands.join(', ') || 'typecheck'}) y pulsa «Integrar en la rama principal».`, tone: 'warn', settled: false };
  if (!r.published) return { phase: `Integrado en ${r.merged.into} · falta publicar`, next: `Pulsa «Publicar en el remoto» para subirlo a GitHub${opts.isPortalRepo ? ' y luego reconstruye y reinicia el Portal desde la barra amarilla' : ''}.`, tone: 'warn', settled: false };
  return { phase: `Integrado y publicado (${r.merged.into} → ${r.published.remote})`, next: opts.isPortalRepo ? 'Reconstruye y reinicia el Portal (barra amarilla) para que el cambio entre en funcionamiento, y cierra la historia.' : 'Cierra la historia en Backlog.', tone: 'ok', settled: true };
}

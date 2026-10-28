import { workspacesRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, processesRepo } from '../db/workspace.ts';
import { isActiveJob } from './activeJobs.ts';
import { implementerOutputs } from './storyPipeline.ts';

/**
 * Recuperación tras un reinicio del Portal (o un proceso huérfano): un proceso «en ejecución» sin ejecución viva en este
 * servidor no puede continuar solo. No se repite NINGUNA llamada automáticamente (duplicaría gasto):
 *  - el paso que estaba llamando al proveedor queda «fallido · interrumpido», con su costo posible como NO confirmado;
 *  - los pasos terminados se conservan tal cual (sin volver a contabilizarlos);
 *  - una historia con pipeline cuyo Desarrollador ya entregó queda «pausada · interrumpida»: «Continuar» retoma donde
 *    quedó, sin repetir lo hecho;
 *  - el resto (incluida una historia interrumpida antes de la entrega: no hay nada que retomar) queda «fallido» con el
 *    motivo; volver a ejecutarla es una decisión del propietario con su propio presupuesto.
 */
export function recoverInterruptedProcesses(log: (o: any, m: string) => void, opts: { onlyOrphans?: boolean } = {}): number {
  let n = 0;
  for (const ws of workspacesRepo.list()) {
    let procs; try { procs = processesRepo(ws.slug); } catch { continue; }
    for (const p of procs.running()) {
      if (opts.onlyOrphans && isActiveJob(p.id)) continue;
      const at = new Date().toISOString();
      for (const s of p.steps) {
        if (s.status === 'running') {
          const est = s.live?.inputUsd ? Number(s.live.inputUsd.toFixed(6)) : 0; // al menos la entrada enviada pudo facturarse
          procs.stepFinish(s.id, 'failed', { tokensIn: s.inputTokens, tokensOut: s.outputTokens, cost: s.costUsd, outputMd: s.outputMd, error: `Interrumpido: el Portal se reinició (o perdió la ejecución) durante esta llamada al proveedor. No se sabe si la completó ni si la facturó${est ? `; posible costo NO confirmado ≈ ${est.toFixed(4)} USD` : ''}. No se repite sola.` });
          if (est) procs.addUnconfirmed(p.id, s.id, est);
        }
      }
      new Set(p.steps.map(s => s.agentId)).forEach(aid => { try { agentsRepo(ws.slug).setStatus(aid, 'inactive'); } catch { /* agente borrado */ } });
      const r = p.result;
      if (p.kind === 'story_execution' && r?.pipeline && implementerOutputs(p).length) {
        procs.setResult(p.id, { ...r, pipeline: { ...r.pipeline, state: 'paused', pauseKind: 'interrupted', failureClass: 'UNKNOWN_FAILURE', phase: 'finished', finishedAt: at, reason: 'El Portal se reinició mientras el equipo trabajaba. Lo terminado se conserva; «Continuar» retoma desde aquí sin repetir lo hecho (la llamada interrumpida se vuelve a enviar solo si continúas).', events: [...r.pipeline.events, { at, kind: 'pause' as const, message: 'Interrumpido por un reinicio del Portal. Nada se reenvía solo.' }].slice(-80) } });
        procs.finish(p.id, 'done', null);
        if (p.backlogItemId) { const it = backlogRepo(ws.slug).get(p.backlogItemId); if (it?.status === 'in_progress') backlogRepo(ws.slug).setStatus(it.id, r.applied || r.changes.some(c => !c.error) ? 'review' : 'pending', p.id); }
      } else {
        const detail = 'Interrumpido por un reinicio del Portal durante la ejecución (antes de la entrega del Desarrollador: no hay nada que retomar).';
        if (r) procs.setResult(p.id, { ...r, failure: { kind: 'internal', class: 'UNKNOWN_FAILURE', detail }, pipeline: r.pipeline ? { ...r.pipeline, state: 'stopped', phase: 'finished', failureClass: 'UNKNOWN_FAILURE', finishedAt: at, reason: detail, events: [...r.pipeline.events, { at, kind: 'error' as const, message: detail }].slice(-80) } : r.pipeline ?? null });
        procs.finish(p.id, 'failed', 'Interrumpido: el Portal se reinició durante la ejecución. Lo terminado se conserva; nada se reenvía solo.');
        if (p.backlogItemId) { const it = backlogRepo(ws.slug).get(p.backlogItemId); if (it?.status === 'in_progress') backlogRepo(ws.slug).setStatus(it.id, 'pending', p.id); }
      }
      n++;
      log({ processId: p.id, title: p.title }, 'proceso interrumpido por reinicio: marcado sin reenviar nada');
    }
  }
  return n;
}

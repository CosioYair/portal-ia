import fs from 'node:fs';
import type { ExternalCorrection, Process } from '@portal-ia/domain';
import { backlogRepo, processesRepo } from '../db/workspace.ts';
import { changesSinceBase, git, readRepoFile, safeRelPath } from './repoWrite.ts';
import { pausePipeline, PipelinePause, pipelineOf, storyRunContext, updatePipeline, updateResult } from './storyPipeline.ts';
import { monotonicNow } from '../clock.ts';
import { setWorkStatus } from './workItems.ts';

/**
 * Corrección externa (hecha fuera del equipo de agentes, p. ej. desde la consola) sobre una historia que ya tiene su
 * worktree: el propietario la autoriza y el Portal la registra SIN fabricar actividad de agentes. Se conserva todo
 * (pasos, gasto, correcciones, veredictos y eventos); se añade un registro con el commit y los archivos reales, se
 * vuelve a verificar en el sandbox sin IA y se detiene ANTES de QA: QA la evalúa aparte, solo si el propietario continúa.
 */

const fail = (statusCode: number, message: string, code: string) => Object.assign(new Error(message), { statusCode, code });
const now = monotonicNow;

/** Valida y registra la corrección. `commit` (opcional) avanza el worktree a ese commit SOLO si es un avance rápido. */
export async function registerExternalCorrection(slug: string, processId: string, input: { commit?: string | null; note: string }): Promise<ExternalCorrection> {
  const procs = processesRepo(slug); const proc = procs.get(processId);
  if (!proc || proc.kind !== 'story_execution' || !proc.result) throw fail(404, 'Proceso de historia no encontrado.', 'not_found');
  if (proc.status === 'running' || proc.status === 'pending_authorization') throw fail(409, 'El proceso sigue activo o pendiente de autorizar: espera a que se detenga.', 'active');
  if (procs.running().length) throw fail(409, 'Hay otro proceso en ejecución. Espera a que termine.', 'busy');
  const r = proc.result;
  if (r.merged || r.rejected) throw fail(409, r.merged ? 'Ya está integrado en la rama principal.' : 'Este diff se rechazó; crea una nueva iteración.', 'closed');
  const wt = r.applied?.worktree;
  if (!r.applied || !wt || !fs.existsSync(wt)) throw fail(409, 'Este proceso no tiene un worktree aislado donde registrar la corrección.', 'no_worktree');
  const branch = await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== r.applied.branch) throw fail(409, `El worktree está en la rama ${branch}, no en ${r.applied.branch}.`, 'wrong_branch');
  if ((await git(wt, ['status', '--porcelain', '--untracked-files=no'])).trim()) throw fail(409, 'El worktree tiene cambios sin confirmar: confírmalos en un commit (la corrección se registra por commit, con sus archivos reales).', 'dirty');
  const prev = await git(wt, ['rev-parse', `${r.applied.commit}^{commit}`]);
  const head = await git(wt, ['rev-parse', 'HEAD']);
  const target = input.commit ? await git(wt, ['rev-parse', '--verify', '-q', `${input.commit}^{commit}`]).catch(() => '') : head;
  if (!target) throw fail(400, `El commit ${input.commit} no existe en el repositorio.`, 'unknown_commit');
  if (target === prev) throw fail(409, `No hay nada nuevo: ${r.applied.commit} ya es el último commit registrado.`, 'nothing_new');
  const ancestor = (a: string, b: string) => git(wt, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);
  if (!await ancestor(prev, target)) throw fail(409, `El commit no continúa la rama de la historia desde ${r.applied.commit} (no se reescribe su historia).`, 'not_descendant');
  if (target !== head && !await ancestor(head, target)) throw fail(409, 'El worktree no puede avanzar a ese commit sin perder commits (no es un avance rápido).', 'not_fast_forward');
  const files = (await git(wt, ['diff', '--name-only', prev, target])).split('\n').filter(Boolean);
  if (!files.length) throw fail(409, 'El commit no cambia ningún archivo respecto al último registrado.', 'no_files');
  for (const f of files) { try { safeRelPath(f); } catch (e: any) { throw fail(400, `La corrección toca una ruta protegida (${f}): no se registra.`, 'protected_path'); } }
  // Validado todo: solo ahora se mueve el worktree (avance rápido, sin reescribir nada).
  if (target !== head) await git(wt, ['merge', '--ff-only', '-q', target]);
  const short = await git(wt, ['rev-parse', '--short', 'HEAD']);
  const repoPath = storyRunContext(slug, processId, () => undefined, () => false).repoPath;
  const changes = await changesSinceBase(repoPath, wt);
  const entry: ExternalCorrection = { at: now(), commit: short, previousCommit: r.applied.commit, files, note: input.note.trim(), by: 'owner' };
  updateResult(slug, processId, x => ({
    ...x, changes,
    applied: { ...x.applied!, commit: short, files: Array.from(new Set([...x.applied!.files, ...files])), appliedAt: now() },
    externalCorrections: [...(x.externalCorrections ?? []), entry],
    // La comprobación previa se rehace sobre el commit nuevo; los entregables tocados pasan a ese commit (estado intacto).
    manifest: x.manifest ? { ...x.manifest, gate: null, deliverables: x.manifest.deliverables.map(d => files.includes(d.path) ? { ...d, commit: short, lines: (readRepoFile(wt, d.path, 400_000) ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length } : d) } : x.manifest
  }));
  const p = pipelineOf(slug, processId);
  updatePipeline(slug, processId, {}, { kind: 'external', message: `Corrección externa registrada por el propietario (consola): commit ${short} sobre ${r.applied.commit}, ${files.length} archivo(s). No es trabajo de los agentes: ni llamadas a la IA ni tokens; las correcciones del equipo no cambian (${p.corrections} de ${p.config.maxCorrections}). Se verifica en el sandbox antes de QA.`, detail: `${files.join(', ')}${entry.note ? ` · nota: ${entry.note}` : ''}` });
  return entry;
}

/**
 * Verificación objetiva de lo registrado (sin IA): comprobación previa, typecheck/test/build en el sandbox y evidencia de
 * las pruebas nuevas. Termina SIEMPRE en pausa antes de QA, con el resultado explicado.
 */
export async function verifyExternalCorrection(slug: string, processId: string, log: (o: any, m: string) => void, isCancelled: () => boolean): Promise<Process> {
  const procs = processesRepo(slug);
  const { ctx } = storyRunContext(slug, processId, log, isCancelled);
  const units = await import('./storyUnits.ts');
  let status: Process['status'] = 'done';
  try {
    updatePipeline(slug, processId, { state: 'running', reason: null, pauseKind: null, finishedAt: null, phase: 'verifying' });
    const cfg = pipelineOf(slug, processId).config;
    const { gate, failed, notRun } = await units.objectiveChecks(ctx, cfg);
    const r = procs.get(processId)!.result!; const commit = r.applied!.commit;
    const qaNote = r.review?.verdict ? `El último veredicto de QA (${r.review.verdict === 'approved' ? 'aprobado' : r.review.verdict === 'rejected' ? 'rechazo' : 'sin concluir'}) es de otro commit (${pipelineOf(slug, processId).lastQaCommit ?? '—'}): no vale para este.` : 'QA aún no ha evaluado este commit.';
    const problems = [
      ...(gate && !gate.ok ? [`comprobación previa: ${[...gate.missing.map(m => `falta ${m}`), ...gate.invalid.map(i => `${i.path}: ${i.problem}`)].join(' · ')}`] : []),
      ...(failed ? [`${failed.command} falla en el sandbox (código ${failed.exitCode})`] : []),
      ...(notRun.length ? [`pruebas nuevas que no se ejecutaron: ${notRun.join(', ')}`] : [])
    ];
    throw new PipelinePause('external', problems.length
      ? `La corrección externa (commit ${commit}) no supera las comprobaciones objetivas: ${problems.join(' · ')}. No se llamó a ningún agente. Corrígelo y registra otro commit, o decide cómo seguir.`
      : `Corrección externa verificada sin IA sobre el commit ${commit}: ${cfg.autoVerify ? `${cfg.commands.join(', ')} en verde en el sandbox` : 'sin verificación automática configurada'}${gate ? ' y todos los entregables del plan presentes' : ''}. ${qaNote} «Continuar» paga una revisión de QA; para que no haya correcciones nuevas, continúa con 0 correcciones.`);
  } catch (e: any) {
    if (e instanceof PipelinePause) pausePipeline(ctx, e);
    else if (e?.cancelled) { status = 'cancelled'; pausePipeline(ctx, new PipelinePause('cancelled', 'Cancelado por el propietario. Lo hecho se conserva.')); }
    else { pausePipeline(ctx, new PipelinePause('external', `No se pudo verificar la corrección externa: ${e?.message ?? e}. No se llamó a ningún agente.`)); }
  } finally {
    procs.finish(processId, status, null);
    const fin = procs.get(processId)!;
    setWorkStatus(slug, ctx.item, 'review', processId);
    log({ processId, state: fin.result?.pipeline?.state, pause: fin.result?.pipeline?.pauseKind }, 'corrección externa verificada (sin IA)');
  }
  return procs.get(processId)!;
}

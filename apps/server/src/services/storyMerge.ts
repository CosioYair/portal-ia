import { INTERNAL_WORKSPACE, verificationsForApplied, type BranchIntegration, type Process } from '@portal-ia/domain';
import { changed } from './live.ts';
import { processesRepo, projectsRepo, backlogRepo } from '../db/workspace.ts';
import { requirePolicy } from './executionPolicy.ts';
import { git, mainBranch, mergeBranch, removeWorktree, repoRoot } from './repoWrite.ts';
import { branchIntegration } from './storyIntegration.ts';
import { withRepoLock } from './repoLock.ts';

/**
 * Integración de la rama de una historia en la rama principal (una sola implementación para la ruta manual y para el
 * lote pre-autorizado): mismas reglas de cierre (verificación en verde tras aplicar; el proyecto interno exige test y
 * build en un sandbox real y nunca se salta), main avanzado → candidato primero, conflictos → se dicen sin tocar nada.
 */
export type MergeError = Error & { statusCode: number; code?: string; missing?: string[]; integration?: BranchIntegration; conflictFiles?: string[] };
const fail = (statusCode: number, message: string, code?: string, extra: Record<string, unknown> = {}): MergeError => Object.assign(new Error(message), { statusCode, code, ...extra });

/**
 * `guard`: última comprobación de quien integra, evaluada DENTRO del carril del repositorio justo antes del merge (después
 * de cualquier espera por el carril): si devuelve un motivo, no se integra (409 'integration_vetoed'). La usa el lote para
 * que un cambio de política, una pausa o una aceptación anulada mientras esperaba el carril nunca acaben en main.
 */
export type MergeOpts = { into?: string; skipVerification?: boolean; guard?: () => string | null };
export async function mergeStory(slug: string, id: string, opts: MergeOpts = {}, log: (o: any, m: string) => void = () => undefined): Promise<Process> {
  // Todo (leer el proceso, comprobar si main avanzó, combinar y registrar) en el carril del repositorio: dos integraciones
  // a la vez (lote y manual, o dos historias) se hacen una detrás de otra y la segunda ve el main que dejó la primera.
  const p0 = processesRepo(slug).get(id); const repo0 = p0 ? projectsRepo(slug).repository(p0.projectId) : null;
  if (!repo0) return mergeStoryLocked(slug, id, opts, log);
  return withRepoLock(repo0.path, () => mergeStoryLocked(slug, id, opts, log));
}
async function mergeStoryLocked(slug: string, id: string, opts: MergeOpts, log: (o: any, m: string) => void): Promise<Process> {
  const procs = processesRepo(slug); const proc = procs.get(id);
  if (!proc?.result?.applied) throw fail(409, 'Primero aplica los cambios en la rama.');
  if (proc.result.merged) throw fail(409, `Ya integrada en ${proc.result.merged.into}.`);
  if (proc.result.rejected) throw fail(409, `Esta iteración se descartó (${proc.result.rejected.reason}): no se integra.`);
  if (proc.backlogItemId && backlogRepo(slug).get(proc.backlogItemId)?.status === 'discarded') throw fail(409, 'La historia está cancelada (Descartadas): su código no se integra.');
  if (!proc.result.applied.worktree) throw fail(409, 'Esta iteración se aplicó antes de v0.12 (sin worktree aislado) y no se integra con el flujo actual. Ciérrala como resuelta o descártala y prepara una nueva iteración.', 'legacy_applied');
  const repoA = projectsRepo(slug).repository(proc.projectId);
  if (repoA) {
    const root = repoRoot(repoA.path); const branch = proc.result.applied.branch; const verified = proc.result.applied.commit;
    const target = opts.into ?? await mainBranch(root, branch);
    // Se integra EXACTAMENTE el commit verificado: un commit añadido después a la rama (sin registrar) no entra a ciegas.
    const head = await git(root, ['rev-parse', branch]).catch(() => '');
    const full = await git(root, ['rev-parse', `${verified}^{commit}`]).catch(() => '');
    if (head && full && head !== full) throw fail(409, `La rama ${branch} tiene commits sin registrar (${verified} → ${head.slice(0, 7)}): registra primero la corrección externa para integrar lo verificado.`, 'unregistered_commits');
    // Preparada sobre la versión PROVISIONAL de su dependencia: su rama contiene commits de la dependencia. Solo se integra
    // cuando ESA versión ya está en main (la aceptaste e integraste); nunca entra en main código de la dependencia sin aprobar.
    const st = proc.result.stack;
    if (st && !(await git(root, ['merge-base', '--is-ancestor', st.commit, target]).then(() => true).catch(() => false))) throw fail(409, `${branch} se preparó sobre una versión provisional de ${st.storyId} (${st.commit.slice(0, 7)}) que no está en ${target}: integra antes ${st.storyId} (y pon esta al día) o rehazla sobre ${target}. Integrarla metería en ${target} cambios de ${st.storyId} sin aprobar.`, 'stack_base_not_integrated');
    // Ya está en main (p. ej. un reinicio entre la integración y su registro): se registra la integración existente en vez
    // de crear otra (nunca dos merges de la misma historia).
    const inMain = full ? await git(root, ['merge-base', '--is-ancestor', full, target]).then(() => true).catch(() => false) : false;
    if (inMain) {
      const merges = (await git(root, ['log', '--first-parent', '--merges', '--format=%h', '--ancestry-path', `${full}..${target}`]).catch(() => '')).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      const commit = merges.at(-1) ?? (await git(root, ['rev-parse', '--short', target]));
      procs.setResult(id, { ...proc.result, merged: { into: target, commit, mergedAt: new Date().toISOString() }, mergeError: null });
      changed({ ws: null, entity: 'system', id: null });
      log({ processId: id, into: target, commit }, 'la rama ya estaba integrada: se registra la integración existente (sin otro merge)');
      return procs.get(id)!;
    }
  }
  // Orden de cierre: no se integra sin que typecheck haya pasado en esta rama (salvo que el propietario lo fuerce a sabiendas).
  // Evidencia de ESTA versión del código (por el commit verificado; la hora solo en registros antiguos sin commit).
  const fresh = verificationsForApplied(proc.result, 1000);
  const okTypecheck = fresh.some(v => v.command === 'typecheck' && v.exitCode === 0);
  const failedLast = ['typecheck', 'build', 'test'].map(c => proc.result!.verifications.filter(v => v.command === c).at(-1)).filter(v => v && v.exitCode !== 0);
  // Proyecto interno (el propio Portal): además de typecheck, test y build en sandbox real; en otros proyectos basta typecheck.
  const internal = slug === INTERNAL_WORKSPACE.slug;
  const okAfter = (cmd: string, sandboxOnly = false) => fresh.some(v => v.command === cmd && v.exitCode === 0 && (!sandboxOnly || v.isolation === 'docker' || v.isolation === 'wsl' || v.isolation === 'linux-ns'));
  const missing = internal ? [!okTypecheck ? 'typecheck' : '', !okAfter('test', true) ? 'test (sandbox)' : '', !okAfter('build', true) ? 'build (sandbox)' : ''].filter(Boolean) : [!okTypecheck ? 'typecheck' : ''].filter(Boolean);
  if (!opts.skipVerification || internal) {
    // El proyecto interno (el propio Portal) nunca se integra saltándose la verificación: es un control de seguridad.
    if (failedLast.length) throw fail(409, `La última verificación falló (${failedLast.map(v => v!.command).join(', ')}). Corrige en la rama o rechaza el diff; integrar código roto dejaría el Portal sin compilar.`, 'verification_failed');
    if (missing.length) throw fail(409, `Antes de integrar faltan verificaciones en verde tras aplicar: ${missing.join(', ')}. ${internal && missing.some(m => m.includes('sandbox')) ? 'El proyecto interno exige test y build en un sandbox real (Docker/WSL2); sin sandbox no se integra.' : ''}`, 'verification_required', { missing });
  }
  const repo = projectsRepo(slug).repository(proc.projectId); if (!repo) throw fail(409, 'No hay repositorio registrado.');
  // main avanzó desde que nació la rama: no se integra a ciegas. Conflictos reales → se dicen con sus archivos (sin
  // intentar el merge); sin conflictos → primero el candidato (main incorporado en la rama y verificado en el sandbox).
  const integ = await branchIntegration(repo.path, proc.result.applied.branch, opts.into).catch(() => null);
  if (integ?.state === 'conflicts') {
    const files = integ.conflicts.map(c => c.path);
    procs.setResult(id, { ...proc.result, mergeError: { at: new Date().toISOString(), message: `main avanzó ${integ.behindCount} commit(s) y hay conflictos reales en ${files.length} archivo(s): ${files.join(', ')}. Nada se modificó.`, files } });
    throw fail(409, `Hay conflictos reales con ${integ.target} en ${files.join(', ')}: prepara el candidato de integración (se resuelven solo esos conflictos; no hace falta otra iteración).`, 'merge_conflict', { integration: integ });
  }
  if (integ && integ.behindCount > 0) throw fail(409, `${integ.target} avanzó ${integ.behindCount} commit(s) desde que nació la rama: prepara el candidato de integración (incorpora ${integ.target} en la rama sin IA y se vuelve a verificar) antes de integrar.`, 'integration_candidate_required', { integration: integ });
  const veto = opts.guard?.();
  if (veto) throw fail(409, veto, 'integration_vetoed');
  requirePolicy('git_merge', { slug, processId: id, projectId: proc.projectId, authorized: true });
  try {
    const m = await mergeBranch(repo.path, proc.result.applied.branch, opts.into, { affectedFiles: proc.result.changes.filter(c => !c.error).map(c => c.path), processId: id });
    const pl0 = proc.result.pipeline;
    const pipeline = pl0 && (pl0.state === 'paused' || pl0.state === 'stopped') ? { ...pl0, state: 'verified' as const, pauseKind: null, reason: null, events: [...pl0.events, { at: new Date().toISOString(), kind: 'integration' as const, message: `Integrada en ${m.into} (${m.commit}). La pausa anterior («${(pl0.reason ?? '').slice(0, 160)}») queda resuelta.` }] } : pl0;
    procs.setResult(id, { ...proc.result, merged: { into: m.into, commit: m.commit, mergedAt: new Date().toISOString() }, mergeError: null, pipeline });
    // main cambió: el aviso «Reconstruir y reiniciar» de cualquier pestaña debe aparecer ya (sin esperar a su sondeo).
    changed({ ws: null, entity: 'system', id: null });
    await removeWorktree(repo.path, id).catch(() => false);
    procs.logExecution({ projectId: proc.projectId, agentId: proc.steps[0]?.agentId ?? '', kind: 'repo_merge', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: new Date().toISOString() });
    log({ processId: id, into: m.into, commit: m.commit, viaWorktree: m.viaWorktree }, 'rama integrada');
    return procs.get(id)!;
  } catch (e: any) {
    // Conflicto: se guarda para que el recorrido lo explique y ofrezca la corrección (el merge ya se deshizo).
    if (e.statusCode === 409 && (e.conflict || /conflict/i.test(e.message))) {
      // Solo los archivos que git dice en conflicto (antes, sin ellos, se listaban TODOS los de la historia).
      const files: string[] = e.conflictFiles ?? Array.from(new Set(Array.from(String(e.message).matchAll(/Merge conflict in (\S+)/g)).map(x => x[1])));
      procs.setResult(id, { ...proc.result, mergeError: { at: new Date().toISOString(), message: String(e.message).slice(0, 2000), files } });
      throw fail(409, e.message, 'merge_conflict', { conflictFiles: files });
    }
    throw e;
  }
}

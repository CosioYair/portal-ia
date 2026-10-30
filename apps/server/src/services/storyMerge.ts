import { INTERNAL_WORKSPACE, type BranchIntegration, type Process } from '@portal-ia/domain';
import { processesRepo, projectsRepo } from '../db/workspace.ts';
import { requirePolicy } from './executionPolicy.ts';
import { mergeBranch, removeWorktree } from './repoWrite.ts';
import { branchIntegration } from './storyIntegration.ts';

/**
 * Integración de la rama de una historia en la rama principal (una sola implementación para la ruta manual y para el
 * lote pre-autorizado): mismas reglas de cierre (verificación en verde tras aplicar; el proyecto interno exige test y
 * build en un sandbox real y nunca se salta), main avanzado → candidato primero, conflictos → se dicen sin tocar nada.
 */
export type MergeError = Error & { statusCode: number; code?: string; missing?: string[]; integration?: BranchIntegration; conflictFiles?: string[] };
const fail = (statusCode: number, message: string, code?: string, extra: Record<string, unknown> = {}): MergeError => Object.assign(new Error(message), { statusCode, code, ...extra });

export async function mergeStory(slug: string, id: string, opts: { into?: string; skipVerification?: boolean } = {}, log: (o: any, m: string) => void = () => undefined): Promise<Process> {
  const procs = processesRepo(slug); const proc = procs.get(id);
  if (!proc?.result?.applied) throw fail(409, 'Primero aplica los cambios en la rama.');
  if (proc.result.merged) throw fail(409, `Ya integrada en ${proc.result.merged.into}.`);
  if (!proc.result.applied.worktree) throw fail(409, 'Esta iteración se aplicó antes de v0.12 (sin worktree aislado) y no se integra con el flujo actual. Ciérrala como resuelta o descártala y prepara una nueva iteración.', 'legacy_applied');
  // Orden de cierre: no se integra sin que typecheck haya pasado en esta rama (salvo que el propietario lo fuerce a sabiendas).
  const after = new Date(proc.result.applied.appliedAt).getTime();
  const okTypecheck = proc.result.verifications.some(v => v.command === 'typecheck' && v.exitCode === 0 && new Date(v.startedAt).getTime() >= after - 1000);
  const failedLast = ['typecheck', 'build', 'test'].map(c => proc.result!.verifications.filter(v => v.command === c).at(-1)).filter(v => v && v.exitCode !== 0);
  // Proyecto interno (el propio Portal): además de typecheck, test y build en sandbox real; en otros proyectos basta typecheck.
  const internal = slug === INTERNAL_WORKSPACE.slug;
  const okAfter = (cmd: string, sandboxOnly = false) => proc.result!.verifications.some(v => v.command === cmd && v.exitCode === 0 && new Date(v.startedAt).getTime() >= after - 1000 && (!sandboxOnly || v.isolation === 'docker' || v.isolation === 'wsl' || v.isolation === 'linux-ns'));
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
  requirePolicy('git_merge', { slug, processId: id, projectId: proc.projectId, authorized: true });
  try {
    const m = await mergeBranch(repo.path, proc.result.applied.branch, opts.into, { affectedFiles: proc.result.changes.filter(c => !c.error).map(c => c.path), processId: id });
    procs.setResult(id, { ...proc.result, merged: { into: m.into, commit: m.commit, mergedAt: new Date().toISOString() }, mergeError: null });
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

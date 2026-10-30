import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gauntletReviewed } from '@portal-ia/domain';
import type { IntegrationCandidate, BranchIntegration, Process } from '@portal-ia/domain';
import { backlogRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { changesSinceBase, mainBranch, repoRoot, safeRelPath } from './repoWrite.ts';
import { parseFileBlocks } from './devOutput.ts';
import { FILE_FORMAT, sys } from './storyPrompts.ts';
import { pausePipeline, PipelinePause, pipelineOf, providerPause, stepCall, storyRunContext, updatePipeline, updateResult } from './storyPipeline.ts';
import { monotonicNow } from '../clock.ts';
import { setWorkStatus } from './workItems.ts';

/**
 * Integración de una historia verificada con la rama principal cuando esta avanzó (HU-159).
 *
 * Una historia terminada NO se convierte en una tarea de desarrollo nueva porque main haya cambiado. El flujo es:
 *  1. detectar (git, sin IA): commits de main que la rama no tiene, archivos de cada lado y si se combinan limpios
 *     o hay conflictos reales (`git merge-tree`, en memoria: no toca ninguna rama ni carpeta);
 *  2. preparar el CANDIDATO en el worktree de la historia: main se incorpora en la rama con un merge (nunca se
 *     reescribe la historia de nadie ni se toca main). Sin conflictos lo hace git; con conflictos, el agente autorizado
 *     recibe SOLO las secciones en conflicto (base común, main y la historia) y devuelve esos archivos resueltos;
 *  3. verificar el candidato en el sandbox sin IA y detenerse: QA e integrar en main los decide el propietario.
 * Si algo falla a mitad, `git merge --abort` deja la rama exactamente como estaba.
 */

const execFileP = promisify(execFile);
const GIT_ID = ['-c', 'user.name=Portal IA', '-c', 'user.email=portal-ia@local'];
const MARKER = /^(<{7}|={7}|>{7})( |$)/m;
const fail = (statusCode: number, message: string, code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { statusCode, code, ...extra });
const now = monotonicNow;

/** git sin lanzar: código de salida, stdout y stderr (merge-tree sale con 1 si hay conflictos y la salida importa). */
async function run(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  try { const { stdout, stderr } = await execFileP('git', args, { cwd, maxBuffer: 50 * 1024 * 1024, windowsHide: true }); return { code: 0, out: stdout, err: stderr }; }
  catch (e: any) { return { code: typeof e.code === 'number' ? e.code : 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? e.message ?? '') }; }
}
async function must(cwd: string, args: string[]): Promise<string> {
  const r = await run(cwd, args);
  if (r.code !== 0) throw fail(500, `git ${args.filter(a => !a.startsWith('user.')).slice(0, 3).join(' ')}: ${(r.err || r.out).trim().split('\n').slice(-3).join(' ')}`, 'git_failed');
  return r.out.trim();
}
const lines = (s: string) => s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);

/** ¿Cómo se combina `branch` con `target`? Solo lectura (merge-tree trabaja en memoria y no mueve ninguna referencia). */
export async function branchIntegration(repoPath: string, branch: string, target?: string): Promise<BranchIntegration> {
  const cwd = repoRoot(repoPath);
  const tgt = target ?? await mainBranch(cwd, branch);
  const [targetHead, branchHead] = [await must(cwd, ['rev-parse', '--short', tgt]), await must(cwd, ['rev-parse', '--short', branch])];
  const base = await must(cwd, ['merge-base', tgt, branch]);
  const behindCount = Number(await must(cwd, ['rev-list', '--count', `${branch}..${tgt}`])) || 0;
  const ahead = Number(await must(cwd, ['rev-list', '--count', `${tgt}..${branch}`])) || 0;
  const behind = behindCount ? lines(await must(cwd, ['log', '-30', '--format=%h%x09%s', `${branch}..${tgt}`])).map(l => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t').slice(0, 160) }; }) : [];
  const targetFiles = behindCount ? lines(await must(cwd, ['diff', '--name-only', base, tgt])) : [];
  const branchFiles = lines(await must(cwd, ['diff', '--name-only', base, branch]));
  const overlap = targetFiles.filter(f => branchFiles.includes(f));
  const st: BranchIntegration = { target: tgt, branch, base: base.slice(0, 7), targetHead, branchHead, behind, behindCount, ahead, targetFiles, branchFiles, overlap, state: 'up_to_date', conflicts: [], detail: null };
  if (!behindCount) return st;
  const mt = await run(cwd, ['merge-tree', '--write-tree', '--name-only', '--messages', tgt, branch]);
  if (mt.code === 0) return { ...st, state: 'clean' };
  if (mt.code !== 1) return { ...st, state: 'unknown', detail: `git merge-tree no está disponible o falló: ${(mt.err || mt.out).trim().slice(0, 300)}` };
  // Salida: árbol · archivos en conflicto · (línea en blanco) · mensajes informativos.
  const [head, ...msgs] = mt.out.split(/\r?\n\r?\n/);
  const files = lines(head).slice(1);
  const info = lines(msgs.join('\n'));
  return { ...st, state: 'conflicts', conflicts: files.map(p => ({ path: p, message: info.find(m => m.includes(p) && /CONFLICT/.test(m)) ?? 'CONFLICT' })) };
}

/** Cada archivo en conflicto con su base común, la versión de main, la de la historia y la combinación con marcadores. */
export interface ConflictDetail { path: string; message: string; base: string | null; target: string | null; branch: string | null; merged: string | null }
export async function conflictDetails(repoPath: string, st: BranchIntegration, max = 40_000): Promise<ConflictDetail[]> {
  const cwd = repoRoot(repoPath);
  const show = async (ref: string, p: string) => { const r = await run(cwd, ['show', `${ref}:${p}`]); return r.code === 0 ? r.out.slice(0, max) : null; };
  const mt = await run(cwd, ['merge-tree', '--write-tree', st.target, st.branch]);
  const tree = lines(mt.out)[0] ?? '';
  const base = await must(cwd, ['merge-base', st.target, st.branch]);
  const out: ConflictDetail[] = [];
  for (const c of st.conflicts) out.push({ path: c.path, message: c.message, base: await show(base, c.path), target: await show(st.target, c.path), branch: await show(st.branch, c.path), merged: tree ? await show(tree, c.path) : null });
  return out;
}

/**
 * Prepara el candidato de integración EN EL WORKTREE de la historia: incorpora `target` en la rama con un merge sin
 * avance rápido. Sin conflictos lo resuelve git; con conflictos solo si llegan `resolutions` para TODOS los archivos en
 * conflicto (y sin marcadores). Cualquier fallo deja la rama como estaba (`git merge --abort`).
 */
export async function prepareCandidate(repoPath: string, worktree: string, branch: string, target: string, resolutions?: { path: string; content: string }[]): Promise<{ state: 'up_to_date' | 'candidate' | 'conflicts'; status: BranchIntegration; commit: string | null; previous: string; files: string[] }> {
  const head = (await must(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']));
  if (head !== branch) throw fail(409, `El worktree está en ${head}, no en ${branch}.`, 'wrong_branch');
  if ((await must(worktree, ['status', '--porcelain', '--untracked-files=no']))) throw fail(409, 'El worktree tiene cambios sin confirmar: no se prepara el candidato sobre un estado a medias.', 'dirty');
  const previous = await must(worktree, ['rev-parse', '--short', 'HEAD']);
  const status = await branchIntegration(repoPath, branch, target);
  if (status.state === 'up_to_date') return { state: 'up_to_date', status, commit: null, previous, files: [] };
  if (status.state === 'unknown') throw fail(409, status.detail ?? 'No se pudo calcular la integración.', 'integration_unknown');
  const conflicted = status.conflicts.map(c => c.path);
  if (status.state === 'conflicts' && !resolutions) return { state: 'conflicts', status, commit: null, previous, files: conflicted };
  const msg = `Incorpora ${target} (${status.targetHead}) en ${branch} para integrar${conflicted.length ? `, resolviendo ${conflicted.length} conflicto(s): ${conflicted.join(', ')}` : ''} (Portal IA)`;
  const m = await run(worktree, [...GIT_ID, 'merge', '--no-ff', '--no-commit', target]);
  try {
    if (m.code !== 0 && !conflicted.length) throw fail(409, `git no pudo combinar ${target}: ${(m.out + m.err).trim().split('\n').slice(-4).join(' ')}`, 'merge_failed');
    const unmerged = lines(await must(worktree, ['diff', '--name-only', '--diff-filter=U']));
    for (const p of unmerged) {
      const r = resolutions?.find(x => x.path === p);
      if (!r) throw fail(409, `Falta la resolución de ${p}: no se integra a medias.`, 'unresolved');
      if (MARKER.test(r.content)) throw fail(422, `La resolución de ${p} aún contiene marcadores de conflicto.`, 'markers_left');
      const abs = path.join(worktree, safeRelPath(p));
      const crlf = fs.existsSync(abs) && /\r\n/.test(fs.readFileSync(abs, 'utf8').slice(0, 4000));
      fs.writeFileSync(abs, crlf ? r.content.replace(/\r?\n/g, '\r\n') : r.content, 'utf8');
      await must(worktree, ['add', '--', p]);
    }
    if (lines(await must(worktree, ['diff', '--name-only', '--diff-filter=U'])).length) throw fail(409, 'Quedan archivos sin resolver.', 'unresolved');
    for (const p of unmerged) { const c = fs.readFileSync(path.join(worktree, safeRelPath(p)), 'utf8'); if (MARKER.test(c)) throw fail(422, `${p} aún contiene marcadores de conflicto.`, 'markers_left'); }
    await must(worktree, [...GIT_ID, 'commit', '--no-edit', '-m', msg]);
  } catch (e) {
    await run(worktree, ['merge', '--abort']);
    throw e;
  }
  const commit = await must(worktree, ['rev-parse', '--short', 'HEAD']);
  const files = lines(await must(worktree, ['diff', '--name-only', previous, 'HEAD']));
  return { state: 'candidate', status, commit, previous, files };
}

// ---------------------------------------------------------------- Proceso de historia

function storyOf(slug: string, processId: string, opts: { allowOthersRunning?: boolean } = {}) {
  const procs = processesRepo(slug); const proc = procs.get(processId);
  if (!proc || proc.kind !== 'story_execution' || !proc.result) throw fail(404, 'Proceso de historia no encontrado.', 'not_found');
  if (proc.status === 'running' || proc.status === 'pending_authorization') throw fail(409, 'El proceso sigue activo o pendiente de autorizar.', 'active');
  // El lote pre-autorizado integra de una en una mientras otras historias trabajan en sus propios worktrees.
  if (!opts.allowOthersRunning && procs.running().length) throw fail(409, 'Hay otro proceso en ejecución. Espera a que termine.', 'busy');
  const r = proc.result;
  if (r.merged || r.rejected) throw fail(409, r.merged ? 'Ya está integrada.' : 'Este diff se rechazó.', 'closed');
  const wt = r.applied?.worktree;
  if (!r.applied || !wt || !fs.existsSync(wt)) throw fail(409, 'Este proceso no tiene un worktree aislado con la rama de la historia.', 'no_worktree');
  const repo = projectsRepo(slug).repository(proc.projectId);
  if (!repo) throw fail(409, 'No hay repositorio registrado.', 'no_repo');
  return { proc, r, wt, repo };
}

/** Estado de integración del proceso (git, sin IA), con el detalle de los conflictos si los hay. */
export async function processIntegration(slug: string, processId: string): Promise<{ status: BranchIntegration; conflicts: ConflictDetail[] }> {
  const proc = processesRepo(slug).get(processId);
  if (!proc?.result?.applied) throw fail(409, 'La historia aún no tiene una rama aplicada.', 'not_applied');
  const repo = projectsRepo(slug).repository(proc.projectId); if (!repo) throw fail(409, 'No hay repositorio registrado.', 'no_repo');
  const status = await branchIntegration(repo.path, proc.result.applied.branch);
  return { status, conflicts: status.state === 'conflicts' ? await conflictDetails(repo.path, status, 6_000) : [] };
}

/** Registra el candidato preparado: nuevo commit de la rama, archivos y cambios desde la base, y el evento. */
async function recordCandidate(slug: string, processId: string, repoPath: string, wt: string, res: Awaited<ReturnType<typeof prepareCandidate>>, resolvedBy: IntegrationCandidate['resolvedBy']) {
  const changes = await changesSinceBase(repoPath, wt);
  const rec: IntegrationCandidate = { state: 'candidate', at: now(), target: res.status.target, targetHead: res.status.targetHead, behindCount: res.status.behindCount, commit: res.commit, previousCommit: res.previous, files: res.files, conflicts: res.status.conflicts.map(c => c.path), resolvedBy };
  updateResult(slug, processId, x => ({
    ...x, changes, mergeError: null, integration: rec,
    applied: { ...x.applied!, commit: res.commit!, appliedAt: now() },
    manifest: x.manifest ? { ...x.manifest, gate: null } : x.manifest
  }));
  updatePipeline(slug, processId, {}, { kind: 'integration', message: `Candidato de integración preparado: ${res.status.target} (${res.status.targetHead}, ${res.status.behindCount} commit(s) que la rama no tenía) incorporado en ${res.status.branch} como ${res.commit}${rec.conflicts.length ? `, con ${rec.conflicts.length} conflicto(s) resuelto(s) por ${resolvedBy === 'agent' ? 'el agente autorizado (solo esas secciones)' : 'git'}` : ' sin conflictos'}. La implementación verificada se conserva; main no cambia. Se verifica en el sandbox sin IA.`, detail: res.files.slice(0, 30).join(', ') || null });
}

/**
 * Verificación del candidato sin IA (comprobación previa, typecheck/test/build en el sandbox, evidencia de pruebas) y
 * pausa SIEMPRE antes de QA e integrar: el propietario decide con la evidencia.
 */
export async function verifyCandidate(slug: string, processId: string, log: (o: any, m: string) => void, isCancelled: () => boolean): Promise<Process> {
  const procs = processesRepo(slug);
  const { ctx } = storyRunContext(slug, processId, log, isCancelled);
  const units = await import('./storyUnits.ts');
  let status: Process['status'] = 'done';
  try {
    updatePipeline(slug, processId, { state: 'running', reason: null, pauseKind: null, finishedAt: null, phase: 'verifying' });
    const cfg = pipelineOf(slug, processId).config;
    const { gate, failed, notRun } = await units.objectiveChecks(ctx, cfg);
    const r = procs.get(processId)!.result!; const commit = r.applied!.commit;
    const problems = [
      ...(gate && !gate.ok ? [`comprobación previa: ${[...gate.missing.map(m => `falta ${m}`), ...gate.invalid.map(i => `${i.path}: ${i.problem}`)].join(' · ')}`] : []),
      ...(failed ? [`${failed.command} falla en el sandbox (código ${failed.exitCode})`] : []),
      ...(notRun.length ? [`pruebas nuevas que no se ejecutaron: ${notRun.join(', ')}`] : [])
    ];
    throw new PipelinePause('integration', problems.length
      ? `El candidato de integración (commit ${commit}) no supera las comprobaciones objetivas contra el main actual: ${problems.join(' · ')}. No se llamó a ningún agente y main no cambió.`
      : `Candidato de integración verificado sin IA (commit ${commit}): ${cfg.autoVerify ? `${cfg.commands.join(', ')} en verde en el sandbox` : 'sin verificación automática configurada'} con el main actual incorporado. ${pipelineOf(slug, processId).lastQaCommit === commit || gauntletReviewed(r.gauntlet, commit) ? '' : 'QA aún no ha revisado este commit. '}Integrar en main sigue siendo decisión tuya.`);
  } catch (e: any) {
    if (e instanceof PipelinePause) pausePipeline(ctx, e);
    else if (e?.cancelled) { status = 'cancelled'; pausePipeline(ctx, new PipelinePause('cancelled', 'Cancelado por el propietario. Lo hecho se conserva.')); }
    else pausePipeline(ctx, new PipelinePause('integration', `No se pudo verificar el candidato de integración: ${e?.message ?? e}. No se llamó a ningún agente y main no cambió.`));
  } finally {
    procs.finish(processId, status, null);
    setWorkStatus(slug, ctx.item, 'review', processId);
    log({ processId }, 'candidato de integración verificado (sin IA)');
  }
  return procs.get(processId)!;
}

/** Sin conflictos: git prepara el candidato (sin IA). Con conflictos: se registran y se explican; nada cambia. */
export async function prepareIntegration(slug: string, processId: string, opts: { allowOthersRunning?: boolean } = {}): Promise<{ state: 'up_to_date' | 'candidate' | 'conflicts'; status: BranchIntegration }> {
  const { r, wt, repo } = storyOf(slug, processId, opts);
  const head = await must(wt, ['rev-parse', '--short', 'HEAD']);
  const recorded = await must(wt, ['rev-parse', '--short', `${r.applied!.commit}^{commit}`]);
  if (head !== recorded) throw fail(409, `El worktree tiene commits sin registrar (${recorded} → ${head}): registra primero la corrección externa para que el candidato parta de lo verificado.`, 'unregistered_commits');
  const res = await prepareCandidate(repo.path, wt, r.applied!.branch, await mainBranch(repoRoot(repo.path), r.applied!.branch));
  if (res.state === 'conflicts') {
    updateResult(slug, processId, x => ({ ...x, integration: { state: 'conflicts', at: now(), target: res.status.target, targetHead: res.status.targetHead, behindCount: res.status.behindCount, commit: null, previousCommit: head, files: [], conflicts: res.files, resolvedBy: null } }));
    updatePipeline(slug, processId, { state: 'paused', pauseKind: 'integration_conflict', phase: 'finished', finishedAt: now(), reason: `main avanzó ${res.status.behindCount} commit(s) y hay ${res.files.length} conflicto(s) reales con la rama de la historia: ${res.files.join(', ')}. Nada cambió (ni la rama ni main).` }, { kind: 'integration', message: `Conflictos reales con ${res.status.target} (${res.status.targetHead}) en ${res.files.length} archivo(s): ${res.files.join(', ')}. La rama y main no cambian; la implementación verificada se conserva.` });
    return { state: 'conflicts', status: res.status };
  }
  if (res.state === 'candidate') await recordCandidate(slug, processId, repo.path, wt, res, 'git');
  return { state: res.state, status: res.status };
}

/**
 * Conflictos reales: el Desarrollador autorizado recibe SOLO las secciones en conflicto (base común, main, historia y la
 * combinación con marcadores) y los criterios de aceptación, y devuelve esos archivos resueltos. Una llamada, autorizada
 * por el propietario; nada se integra en main.
 */
export async function resolveIntegrationConflicts(slug: string, processId: string, log: (o: any, m: string) => void, isCancelled: () => boolean): Promise<Process> {
  const procs = processesRepo(slug);
  const { ctx } = storyRunContext(slug, processId, log, isCancelled);
  const proc = procs.get(processId)!; const r = proc.result!; const wt = r.applied!.worktree!;
  const repo = projectsRepo(slug).repository(proc.projectId)!;
  try {
    updatePipeline(slug, processId, { state: 'running', reason: null, pauseKind: null, finishedAt: null, phase: 'correcting' });
    const status = await branchIntegration(repo.path, r.applied!.branch);
    if (status.state !== 'conflicts') {
      const res = await prepareCandidate(repo.path, wt, r.applied!.branch, status.target);
      if (res.state === 'candidate') await recordCandidate(slug, processId, repo.path, wt, res, 'git');
    } else {
      const details = await conflictDetails(repo.path, status, 30_000);
      const block = (title: string, c: string | null) => `### ${title}\n${c === null ? '(no existe)' : `\`\`\`\n${c}\n\`\`\``}`;
      const prompt = `Integración de la historia con ${status.target}: resuelve SOLO los conflictos. La implementación de la historia ya está verificada y ${status.target} avanzó ${status.behindCount} commit(s) (${status.behind.slice(0, 8).map(b => `${b.sha} ${b.subject}`).join(' · ')}). NO reimplementes la historia ni cambies otros archivos.
Para cada archivo en conflicto devuelve su contenido COMPLETO resuelto: conserva lo que aporta ${status.target} (cambios ajenos a esta historia) Y lo que aporta la historia; sin marcadores <<<<<<< ======= >>>>>>>.
# Criterios de aceptación de la historia (deben seguir cumpliéndose)
${(ctx.plan?.acceptance ?? []).map(a => `- ${a}`).join('\n') || `- ${ctx.item.criterion || '(los de la historia)'}`}
# Archivos en conflicto
${details.map(d => `## ${d.path}\n${d.message}\n${block('Base común', d.base)}\n${block(`En ${status.target} (cambios ajenos que se conservan)`, d.target)}\n${block('En la rama de la historia', d.branch)}\n${block('Combinación de git con marcadores', d.merged)}`).join('\n\n')}

FORMATO DE RESPUESTA (solo los archivos en conflicto, completos):
${FILE_FORMAT}`;
      const res0 = await stepCall(ctx, ctx.dev, 'implementer', `Integración: resolver ${details.length} conflicto(s) con ${status.target}`, `Solo los conflictos reales con ${status.target}: ${details.map(d => d.path).join(', ')}`.slice(0, 300), sys(ctx.dev, ctx.project, ctx.item), prompt, 16_000, undefined, undefined, 'Resolver conflictos de integración');
      const parsed = parseFileBlocks(res0.text, res0.stopReason);
      const resolutions = parsed.changes.filter(c => details.some(d => d.path === c.path) && typeof c.content === 'string').map(c => ({ path: c.path, content: c.content as string }));
      const res = await prepareCandidate(repo.path, wt, r.applied!.branch, status.target, resolutions);
      if (res.state !== 'candidate') throw new PipelinePause('integration_conflict', 'Los conflictos cambiaron mientras se resolvían: vuelve a preparar el candidato.');
      await recordCandidate(slug, processId, repo.path, wt, res, 'agent');
    }
  } catch (e: any) {
    // Cualquier salida termina en pausa explicada (nunca «en ejecución» sin nadie trabajando). Una resolución inválida
    // (faltan archivos, quedan marcadores…) ya se deshizo con git merge --abort: la rama y main están como antes.
    const pause = e instanceof PipelinePause ? e
      : e?.cancelled ? new PipelinePause('cancelled', 'Cancelado por el propietario. Lo hecho se conserva.')
      : e?.failure ? (providerPause(e) ?? new PipelinePause('integration_conflict', `La llamada para resolver los conflictos falló: ${e.message}. La rama de la historia y main están como antes.`))
      : new PipelinePause('integration_conflict', `La resolución de conflictos no se aplicó: ${e?.message ?? e}. La rama de la historia y main están como antes (git merge --abort).`);
    pausePipeline(ctx, pause);
    procs.finish(processId, e?.cancelled ? 'cancelled' : 'done', null);
    return procs.get(processId)!;
  }
  return verifyCandidate(slug, processId, log, isCancelled);
}


import fs from 'node:fs';
import path from 'node:path';
import type { BaselineRun, BaselineTriage, Process, VerificationRun } from '@portal-ia/domain';
import { workspacesRepo } from '../db/platform.ts';
import { processesRepo, projectsRepo } from '../db/workspace.ts';
import { testRunSummary } from './failureDiagnosis.ts';
import { git, mainBranch, repoRoot } from './repoWrite.ts';
import { withRepoLock } from './repoLock.ts';
import { DEPS_MISSING_EXIT } from './sandbox.ts';
import { classify, clippedOutput, testDigest } from './testTriage.ts';
import { workItemOf } from './workItems.ts';
import { monotonicNow } from '../clock.ts';
export { classify, errorKernel, isPreexisting, triageText } from './testTriage.ts';

/**
 * LÍNEA BASE de las pruebas (sin IA). Cuando «test» falla en el worktree de una historia, ¿esos fallos son suyos?
 * Se ejecuta el MISMO «test», en el MISMO sandbox, sobre el commit de main del que parte la historia (merge-base con la
 * rama principal: siempre código ya integrado), en un worktree temporal y desechable bajo la carpeta de worktrees del
 * Portal (nunca bajo /tmp: un sandbox sin /tmp propio lo compartiría con el equipo), y se compara prueba a prueba con
 * las reglas de testTriage.ts. Una ejecución por commit de base (se reutiliza entre historias).
 * HU-177: dos pruebas de main fallaban en el sandbox Linux y el Portal las cargaba a la historia, que agotó sus
 * correcciones intentando arreglar lo que no había roto.
 */
const now = monotonicNow;
/** Subcarpeta de `<repo>-worktrees` para los worktrees temporales (línea base y run_checks). */
export const BASELINE_DIR = '.linea-base';
export const isBaselineWorktree = (p: string) => p.replace(/\\/g, '/').includes(`/${BASELINE_DIR}/`);
const tempRoot = (repoPath: string) => { const cwd = repoRoot(repoPath); return path.resolve(cwd, '..', `${path.basename(cwd)}-worktrees`, BASELINE_DIR); };
const keyOf = (repoPath: string, commit: string) => `${path.resolve(repoPath).toLowerCase()}@${commit}`;
const cache = new Map<string, BaselineRun>();
/** Líneas base que no se pudieron obtener (plazo, dependencias…): no se repiten en esta sesión del servidor. */
const problems = new Map<string, BaselineRun>();
const running = new Map<string, Promise<BaselineRun>>();

/**
 * Ejecuta comandos permitidos (typecheck, test, build) sobre `commit` en un worktree temporal y desechable (carpeta única
 * por ejecución), con el MISMO ejecutor que las verificaciones de las historias (mismo sandbox; en las pruebas, el mismo
 * doble). Se retira siempre. Nunca instala nada ni toca la rama de trabajo, main ni otros worktrees.
 */
export async function runOnCommit(repoPath: string, commit: string, commands: string[], tag = 'base'): Promise<VerificationRun[]> {
  const root = tempRoot(repoPath); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, `${tag}-`));
  await withRepoLock(repoPath, async () => {
    await git(repoPath, ['worktree', 'prune']).catch(() => undefined);
    await git(repoPath, ['worktree', 'add', '--detach', dir, commit]);
  }).catch(e => { fs.rmSync(dir, { recursive: true, force: true }); throw e; });
  try {
    const { sandboxDeps } = await import('./verification.ts');
    const runs: VerificationRun[] = [];
    for (const c of commands) {
      const run = await sandboxDeps.run(dir, repoPath, c, {});
      runs.push({ ...run, commit, ...(c === 'test' && !run.tests && !clippedOutput(run.output) ? { tests: testDigest(run.output, [dir]) } : {}) });
      // Sin sandbox o sin dependencias, lo siguiente tampoco correría: se para y se dice.
      if (run.isolation === 'unavailable' || run.exitCode === DEPS_MISSING_EXIT || run.tampered) break;
    }
    return runs;
  } finally { await removeTemp(repoPath, dir); }
}

async function removeTemp(repoPath: string, dir: string) {
  await withRepoLock(repoPath, async () => {
    await git(repoPath, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
    await git(repoPath, ['worktree', 'prune']).catch(() => undefined);
  }).catch(() => undefined);
}

/** Al arrancar: retira los worktrees temporales que dejó un apagado brusco (son del Portal: carpeta propia). */
export async function cleanupBaselineWorktrees(): Promise<number> {
  let n = 0;
  for (const ws of workspacesRepo.list()) for (const p of projectsRepo(ws.slug).list()) {
    const repo = projectsRepo(ws.slug).repository(p.id); if (!repo) continue;
    const root = tempRoot(repo.path); if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) { await removeTemp(repo.path, path.join(root, d)); n++; }
  }
  return n;
}

/** Commit de main del que parte la historia: la base común con la rama principal (siempre código ya integrado). */
export async function storyBase(repoPath: string, head: string): Promise<string | null> {
  const main = await mainBranch(repoPath).catch(() => null); if (!main) return null;
  return (await git(repoPath, ['merge-base', head, main]).catch(() => null))?.trim() || null;
}

/** «test» sobre la base. Nunca instala nada: si la base necesita otras dependencias, no hay línea base y se dice. */
async function runBaseline(repoPath: string, commit: string): Promise<BaselineRun> {
  const started = Date.now();
  const fail = (problem: string, run?: VerificationRun): BaselineRun => ({ commit, at: now(), exitCode: run?.exitCode ?? null, isolation: run?.isolation, durationMs: Date.now() - started, failing: [], problem });
  const [run] = await runOnCommit(repoPath, commit, ['test']);
  if (run.tampered) return fail('lo ejecutado en la base modificó su .git (se restauró)', run);
  if (run.isolation === 'unavailable') return fail('el sandbox no estaba disponible', run);
  if (run.exitCode === DEPS_MISSING_EXIT) return fail('la base usa otras dependencias que no están instaladas en el sandbox (la línea base no instala nada)', run);
  if (run.exitCode === null) return fail('«test» no terminó en la base (tiempo agotado)', run);
  if (run.exitCode !== 0 && run.exitCode !== 1) return fail(`«test» terminó en la base con el código ${run.exitCode} (no es un fallo de pruebas identificable)`, run);
  const d = run.tests;
  if (!d) return fail('la salida de «test» en la base no permite un resumen completo', run);
  if (run.exitCode !== 0 && !d.failing.length) return fail(testRunSummary(run).onlyCancellations ? 'en la base solo hubo pruebas canceladas por su suite' : 'en la base «test» falló sin pruebas identificables en la salida', run);
  return { commit, at: now(), exitCode: run.exitCode, isolation: run.isolation, durationMs: run.durationMs, failing: d.failing, total: d.total, passedKeys: d.passedKeys, problem: null };
}

/** Línea base ya calculada (esta sesión, o guardada en un proceso del proyecto con la misma base). */
function known(slug: string, projectId: string, repoPath: string, commit: string): BaselineRun | null {
  const k = keyOf(repoPath, commit);
  const hit = cache.get(k) ?? problems.get(k); if (hit) return hit;
  for (const p of processesRepo(slug).list(projectId)) {
    const b = p.result?.pipeline?.baseline;
    if (b && b.commit === commit && !b.problem && b.passedKeys) { cache.set(k, b); return b; }
  }
  return null;
}

/** Línea base de `commit` (calculada una vez; las peticiones simultáneas comparten la misma ejecución). */
export async function baselineFor(slug: string, projectId: string, repoPath: string, commit: string): Promise<BaselineRun> {
  const hit = known(slug, projectId, repoPath, commit); if (hit) return hit;
  const k = keyOf(repoPath, commit);
  let p = running.get(k);
  if (!p) {
    p = runBaseline(repoPath, commit).then(b => { (b.problem ? problems : cache).set(k, b); return b; }).finally(() => running.delete(k));
    running.set(k, p);
  }
  return p;
}

/** Solo para pruebas: olvida las líneas base en memoria (simula un reinicio). */
export function forgetBaselines() { cache.clear(); problems.clear(); }

/** Lo que la historia dice abordar: archivos que cambia o entrega y el texto de su historia, plan y criterios. */
function scopeOf(slug: string, p: Process) {
  const r = p.result!; const item = workItemOf(slug, p);
  return { files: [...(r.plan?.filesToChange ?? []), ...(r.manifest?.deliverables.filter(d => d.planned).map(d => d.path) ?? [])], text: [p.title, item?.title, item?.criterion, item?.description, r.plan?.summary, ...(r.plan?.acceptance ?? [])].filter(Boolean).join('\n') };
}

/**
 * Triaje de una ejecución de «test» que falla (pipeline y verificación manual): la clasifica frente a la base y lo deja
 * guardado en la ejecución. `needsFreshRun`: la evidencia guardada está recortada y no tiene el resumen completo (procesos
 * de una versión anterior): hay que repetir «test» sin IA antes de decidir. Nunca lanza: si algo falla, «no disponible».
 */
export async function triageRun(slug: string, processId: string, run: VerificationRun, opts: { noRerun?: boolean } = {}): Promise<{ triage: BaselineTriage | null; needsFreshRun?: boolean; fresh?: boolean }> {
  const procs = processesRepo(slug); const p = procs.get(processId); const r = p?.result;
  const repo = p ? projectsRepo(slug).repository(p.projectId) : null;
  if (!p || !r?.applied || !repo || run.command !== 'test' || run.exitCode === 0 || run.exitCode === null || run.exitCode === DEPS_MISSING_EXIT || run.tampered || run.isolation === 'unavailable') return { triage: null };
  if (run.triage) return { triage: run.triage };
  if (testRunSummary(run).onlyCancellations) return { triage: null };
  const digest = run.tests ?? (clippedOutput(run.output) ? null : testDigest(run.output, [r.applied.worktree ?? '']));
  if (!digest && !opts.noRerun && run.exitCode === 1) return { triage: null, needsFreshRun: true };
  let base: string | null = null; let b: BaselineRun | null = null;
  const unavailable = (why: string): BaselineTriage => ({ baseCommit: base ?? '', at: now(), preexisting: [], introduced: digest?.failing ?? [], changed: [], accepted: false, unavailable: why });
  let triage: BaselineTriage;
  try {
    if (run.exitCode !== 1) triage = unavailable(`el proceso de pruebas terminó con el código ${run.exitCode} (no es un fallo de pruebas identificable)`);
    else if (!digest) triage = unavailable('la salida guardada está recortada y no permite ver todos los fallos');
    else if (!digest.failing.length) triage = unavailable('no se identificaron en la salida las pruebas que fallan');
    else if (!(base = await storyBase(repo.path, r.applied.commit))) triage = unavailable('no se pudo determinar el commit de main del que parte la historia');
    else {
      b = await baselineFor(slug, p.projectId, repo.path, base);
      if (b.problem) triage = unavailable(b.problem);
      else if (digest.total != null && b.total != null && digest.total < b.total) triage = unavailable(`se ejecutaron menos pruebas (${digest.total}) que en la base (${b.total}): la ejecución pudo cortarse o la historia quitó pruebas`);
      else triage = classify(digest.failing, b, new Set(r.changes.filter(c => !c.error).map(c => c.path)), scopeOf(slug, p));
    }
  } catch (e: any) { triage = unavailable(`no se pudo ejecutar la línea base: ${String(e?.message ?? e).slice(0, 200)}`); }
  const cur = procs.get(processId)!;
  procs.setResult(processId, { ...cur.result!, verifications: cur.result!.verifications.map(v => v.command === run.command && v.startedAt === run.startedAt ? { ...v, triage } : v), ...(b && cur.result!.pipeline ? { pipeline: { ...cur.result!.pipeline, baseline: b } } : {}) });
  return { triage, fresh: true };
}

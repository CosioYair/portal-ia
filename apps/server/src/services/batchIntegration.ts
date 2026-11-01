import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { SHARED_FILE, integrationOrder, mentionedFiles, type Batch, type BatchItem, type CandidateFreshness, type FileBasis, type IntegrationPlan, type IntegrationPlanInput, type Process } from '@portal-ia/domain';
import { backlogRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { mainBranch, ownBase, repoRoot } from './repoWrite.ts';
import { revisionStatus } from './revision.ts';

/**
 * Integración ordenada de un lote (sin IA): qué archivos toca de verdad cada historia, si su evidencia sigue valiendo con
 * el main actual (`freshness`) y en qué orden conviene integrarlas (`integrationOrder`). Solo lee git: no mueve ninguna
 * referencia ni toca ningún worktree. Los resultados se guardan en el lote para que leerlo no cueste llamadas a git.
 */

const execFileP = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}
const lines = (s: string) => s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
const short = (c: string | null) => c ? c.slice(0, 7) : null;
/** storyIds que nombran los commits de integración de main («Integra portal-ia/hu-172 en main…»). */
export function storiesInSubjects(subjects: string[]): string[] {
  const out = new Set<string>();
  for (const s of subjects) for (const m of s.matchAll(/portal-ia\/([a-z]+-\d+)/gi)) out.add(m[1].toUpperCase());
  return Array.from(out);
}

export interface StoryGitFacts {
  branch: string; target: string;
  /** Último commit de main que la rama incorpora (merge-base) y cabeza de main ahora. */
  base: string; mainHead: string; head: string;
  /** Archivos que cambia la historia respecto a ese main (los suyos, sin lo que trajo main) y los que crea. */
  files: string[]; adds: string[];
}

/**
 * Hechos de git de la rama de una historia frente a main (solo lectura). `stackBase`: preparada sobre la versión
 * provisional de su dependencia (aún no integrada): sus archivos son los que cambia desde ese commit (ver ownBase).
 */
export async function storyGitFacts(repoPath: string, branch: string, stackBase?: string | null): Promise<StoryGitFacts> {
  const root = repoRoot(repoPath);
  const target = await mainBranch(root, branch);
  const [base, mainHead, head] = [await ownBase(root, branch, target, stackBase), await git(root, ['rev-parse', target]), await git(root, ['rev-parse', branch])];
  // --no-renames: un archivo renombrado cuenta por su ruta vieja y la nueva (las dos pueden chocar con otra historia).
  const files = lines(await git(root, ['diff', '--name-only', '--no-renames', base, branch]));
  const adds = lines(await git(root, ['diff', '--name-only', '--no-renames', '--diff-filter=A', base, branch]));
  return { branch, target, base, mainHead, head, files, adds };
}

/**
 * Huella de los cambios PROPIOS de la historia (sin lo que trajo main): `git patch-id --stable` del diff sin contexto
 * entre el main que incorpora y su rama. Un merge limpio de main la conserva; conflictos resueltos o correcciones la
 * cambian. Sirve para saber si lo que aceptaste sigue siendo lo que se integra.
 */
export async function storyPatchId(repoPath: string, branch: string, stackBase?: string | null): Promise<string | null> {
  const root = repoRoot(repoPath);
  try {
    const target = await mainBranch(root, branch);
    const base = await ownBase(root, branch, target, stackBase);
    const diff = (await execFileP('git', ['diff', '-U0', '--no-color', '--no-renames', base, branch], { cwd: root, maxBuffer: 50 * 1024 * 1024, windowsHide: true })).stdout;
    if (!diff.trim()) return 'empty';
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['patch-id', '--stable'], { cwd: root, windowsHide: true });
      let o = ''; child.stdout.on('data', d => { o += d; }); child.on('error', reject); child.on('close', () => resolve(o));
      child.stdin.end(diff);
    });
    return out.trim().split(/\s+/)[0] || null;
  } catch { return null; }
}

/**
 * Archivos de la historia para decidir si main la afecta: los de su rama más los que planificó leer o cambiar y sus
 * entregables (el MISMO conjunto que usa revision.ts para la cobertura de QA, para que la vigencia y la integración no
 * discrepen).
 */
const planFiles = (p: Process) => [...(p.result?.plan?.filesToRead ?? []), ...(p.result?.plan?.filesToChange ?? []), ...(p.result?.manifest?.deliverables ?? []).map(d => d.path), ...(p.result?.changes ?? []).filter(c => !c.error).map(c => c.path)];

/** ¿`a` está contenido en `b`? (git merge-base --is-ancestor; falso si alguno no existe). */
export async function isAncestorIn(repoPath: string, a: string, b: string): Promise<boolean> {
  try { await execFileP('git', ['merge-base', '--is-ancestor', a, b], { cwd: repoRoot(repoPath), windowsHide: true }); return true; } catch { return false; }
}
/** Un merge a medias en el worktree (reinicio entre «merge» y «commit»): se deshace para empezar desde lo registrado. */
export async function abortPendingMerge(worktree: string | null): Promise<boolean> {
  if (!worktree) return false;
  try {
    const mh = await git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '');
    if (!mh) return false;
    await git(worktree, ['merge', '--abort']);
    return true;
  } catch { return false; }
}

/**
 * ¿Sigue valiendo la evidencia de esta historia con el main actual? Sin IA. Una historia sin rama o sin git queda
 * `unknown` (nunca se presenta como vigente). `current` exige además que QA cubra el commit actual (revision.ts).
 */
export async function freshnessOf(slug: string, p: Process, opts: { dependencyHead?: string | null } = {}): Promise<CandidateFreshness> {
  const at = new Date().toISOString();
  const r = p.result; const branch = r?.applied?.branch;
  const repo = projectsRepo(slug).repository(p.projectId);
  if (!branch || !repo) return { status: 'unknown', base: null, mainHead: null, head: r?.applied?.commit ?? null, overlap: [], causes: [], checkedAt: at, detail: 'Sin rama aplicada: no hay evidencia que comparar con main.' };
  let f: StoryGitFacts;
  const st = r?.stack ?? null;
  try { f = await storyGitFacts(repo.path, branch, st?.commit); }
  catch (e: any) { return { status: 'unknown', base: null, mainHead: null, head: r?.applied?.commit ?? null, overlap: [], causes: [], checkedAt: at, detail: `git no pudo comparar la rama con main: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}` }; }
  const rev = revisionStatus(p);
  const base = { base: short(f.base), mainHead: short(f.mainHead), head: short(f.head), checkedAt: at };
  // La evidencia es del commit REGISTRADO; si la rama tiene otro (p. ej. un merge que un reinicio dejó sin registrar), no vale.
  const recorded = r?.applied?.commit ?? null;
  if (recorded && !f.head.startsWith(recorded.slice(0, 7))) return { ...base, status: 'stale', overlap: [], causes: [], detail: `La rama tiene commits que el Portal no registró (${short(recorded)} → ${short(f.head)}): su evidencia no cubre lo que hay; se pone al día antes de presentarla como vigente.` };
  const root0 = repoRoot(repo.path);
  if (st) {
    // Preparada sobre una versión provisional de su dependencia: solo vale si ESA versión acabó en main. Si la dependencia se
    // rehízo desde main (otra versión), su rama arrastra commits que nunca aceptaste: no se pone al día ni se integra.
    if (!(await isAncestorIn(root0, st.commit, f.mainHead))) return { ...base, status: 'unknown', overlap: [], causes: [st.storyId], stackInvalid: true, detail: `Se preparó sobre una versión provisional de ${st.storyId} (${short(st.commit)}) que no está en main: ${st.storyId} se integró con otra versión. Sus commits no se integran; iterarla la rehace sobre main.` };
    // La dependencia cambió mientras la revisabas (p. ej. pediste cambios): hasta que esta rama incorpore la versión final y QA
    // la revise, su evidencia es de la versión provisional.
    const dep = opts.dependencyHead ?? null;
    const qaCommit = rev?.qa.commit ?? null;
    if (dep && !same7(dep, st.commit) && (!(await isAncestorIn(root0, dep, f.head)) || !qaCommit || !(await isAncestorIn(root0, dep, qaCommit)))) {
      const depFiles = lines(await git(root0, ['diff', '--name-only', '--no-renames', st.commit, dep]).catch(() => ''));
      const mt = await mergeConflicts(root0, f.mainHead, f.head);
      return { ...base, status: 'stale', overlap: depFiles.slice(0, 30), causes: [st.storyId], conflicts: mt.slice(0, 20), dependencyChanged: true, detail: `Se preparó sobre ${st.storyId} ${short(st.commit)} y ${st.storyId} se integró con cambios posteriores (${short(dep)}, ${depFiles.length} archivo(s)): se pone al día con la versión final, se verifica en el sandbox y QA la revisa otra vez${mt.length ? ` (conflictos previstos en ${mt.slice(0, 3).join(', ')})` : ''}.` };
    }
  }
  if (f.base === f.mainHead) {
    const covered = !!rev?.qa.coversHead && !!rev.verifiedHead;
    return { ...base, status: covered ? 'current' : 'stale', overlap: [], causes: [], detail: covered ? null : (rev?.qa.why ?? 'La evidencia no cubre el commit actual.') };
  }
  const root = repoRoot(repo.path);
  const changed = lines(await git(root, ['diff', '--name-only', '--no-renames', f.base, f.mainHead]).catch(() => ''));
  const mine = new Set([...f.files, ...planFiles(p)]);
  const overlap = changed.filter(x => mine.has(x) || SHARED_FILE.test(x));
  const causes = storiesInSubjects(lines(await git(root, ['log', '--format=%s', `${f.base}..${f.mainHead}`]).catch(() => '')));
  const behind = Number(await git(root, ['rev-list', '--count', `${f.base}..${f.mainHead}`]).catch(() => '0')) || 0;
  if (!overlap.length) return { ...base, status: rev?.qa.coversHead ? 'clean_carry' : 'stale', overlap: [], causes, detail: rev?.qa.coversHead ? `main avanzó ${behind} commit(s)${causes.length ? ` (${causes.join(', ')})` : ''} sin tocar sus archivos ni compartidos: la evidencia se arrastra y al integrar se verifica otra vez sin IA.` : (rev?.qa.why ?? null) };
  // Predicción de conflictos en memoria (merge-tree, no toca nada): se dice antes de ponerla al día.
  const mt = await mergeConflicts(root, f.mainHead, f.head);
  return { ...base, status: 'stale', overlap: overlap.slice(0, 30), causes, conflicts: mt.slice(0, 20), detail: `main avanzó ${behind} commit(s)${causes.length ? ` (${causes.join(', ')})` : ''} y cambió ${overlap.length} archivo(s) suyos o compartidos (${overlap.slice(0, 4).join(', ')}${overlap.length > 4 ? '…' : ''}): su evidencia es de ${short(f.base)} y hay que ponerla al día${mt.length ? ` (conflictos previstos en ${mt.slice(0, 3).join(', ')})` : ''}.` };
}

const same7 = (a: string, b: string) => a.slice(0, 7) === b.slice(0, 7);
/** Archivos en conflicto al combinar dos commits, calculado en memoria (git merge-tree): no toca ninguna referencia. */
export async function mergeConflicts(root: string, a: string, b: string): Promise<string[]> {
  return execFileP('git', ['merge-tree', '--write-tree', '--name-only', a, b], { cwd: root, maxBuffer: 20 * 1024 * 1024, windowsHide: true }).then(() => [] as string[]).catch((e: any) => e?.code === 1 ? lines(String(e.stdout ?? '').split(/\r?\n\r?\n/)[0]).slice(1) : [] as string[]);
}

// ---------------------------------------------------------------- Orden de integración

const repoFilesCache = new Map<string, { head: string; files: string[] }>();
async function repoFiles(root: string): Promise<string[]> {
  const target = await mainBranch(root);
  const head = await git(root, ['rev-parse', target]);
  const c = repoFilesCache.get(root); if (c && c.head === head) return c.files;
  const files = lines(await git(root, ['ls-files', '--', ':!:node_modules']).catch(() => ''));
  repoFilesCache.set(root, { head, files }); return files;
}
/** Archivos del repositorio que menciona el texto de la historia: rutas exactas o nombres únicos (≤ 3 coincidencias). */
export function predictFiles(text: string, all: string[]): string[] {
  const out = new Set<string>();
  for (const m of mentionedFiles(text)) {
    if (all.includes(m)) { out.add(m); continue; }
    const hits = all.filter(f => f === m || f.endsWith(`/${m}`));
    if (hits.length && hits.length <= 3) hits.forEach(h => out.add(h));
  }
  return Array.from(out);
}

/** Proceso que cuenta para la historia en el lote (iteración seguida fuera del lote, si la hay). */
const procOf = (slug: string, it: BatchItem) => { const id = it.followedProcessId ?? it.processId; return id ? processesRepo(slug).get(id) : undefined; };
/** Estados que ya no entran en el orden (están en main o fuera del lote). */
const OUT_OF_ORDER = new Set(['accepted', 'awaiting_acceptance', 'cancelled', 'rejected', 'postponed', 'blocked', 'failed']);

/** Orden de integración del lote con la mejor información disponible de cada historia (rama real > plan > texto). */
export async function computeIntegrationPlan(slug: string, b: Batch): Promise<IntegrationPlan> {
  const repo = projectsRepo(slug).repository(b.projectId);
  const root = repo ? repoRoot(repo.path) : null;
  const all = root ? await repoFiles(root).catch(() => [] as string[]) : [];
  const backlog = backlogRepo(slug);
  const inputs: IntegrationPlanInput[] = [];
  for (const it of b.items) {
    if (OUT_OF_ORDER.has(it.state) || it.mergedCommit) continue;
    const story = backlog.get(it.itemId);
    const text = story ? `${story.title}\n${story.description ?? ''}\n${story.criterion ?? ''}` : it.title;
    const p = procOf(slug, it);
    let files: string[] = []; let adds: string[] = []; let basis: FileBasis = 'none';
    if (p?.result?.applied?.branch && root) {
      try { const f = await storyGitFacts(root, p.result.applied.branch, p.result.stack?.commit); files = f.files; adds = f.adds; basis = 'actual'; } catch { /* rama desaparecida: se usa el plan */ }
    }
    if (basis === 'none' && p?.result?.plan?.filesToChange?.length) { files = p.result.plan.filesToChange; basis = 'planned'; }
    if (basis === 'none') { files = predictFiles(text, all); basis = files.length ? 'predicted' : 'none'; }
    inputs.push({ itemId: it.itemId, storyId: it.storyId, title: it.title, dependsOn: it.dependsInBatch ? it.dependsOn : null, ownerOrder: b.auth.itemIds.indexOf(it.itemId) >= 0 ? b.auth.itemIds.indexOf(it.itemId) : it.order, files, adds, mentions: mentionedFiles(text), basis });
  }
  return { computedAt: new Date().toISOString(), ...integrationOrder(inputs) };
}

/** Firma barata de lo que cambia el plan: estados, procesos y commits aplicados (sin git). */
export function planSignature(slug: string, b: Batch): string {
  return b.items.map(it => { const p = procOf(slug, it); return `${it.itemId}:${it.state}:${p?.id ?? ''}:${p?.result?.applied?.commit ?? ''}:${p?.result?.plan?.filesToChange?.length ?? 0}`; }).join('|');
}

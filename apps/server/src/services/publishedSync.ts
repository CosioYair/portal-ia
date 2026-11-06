import { processesRepo, projectsRepo } from '../db/workspace.ts';
import { git, remoteInfo, repoRoot } from './repoWrite.ts';

/**
 * EN-009 · Saber, SIN red (nunca fetch ni push), si un commit integrado ya está en la referencia local del remoto
 * (`refs/remotes/<remoto>/<main>`) y marcar como publicados los procesos integrados que ya lo están. Así Decisiones no
 * pide «Publicar» lo que el remoto ya tiene (p. ej. tras publicar main con la operación del Asistente).
 */
export type GitRun = (cwd: string, args: string[]) => Promise<string>;

const SHA = /^[0-9a-f]{7,40}$/i;
const REF_NAME = /^[A-Za-z0-9._\/-]{1,80}$/;

/**
 * ¿`commit` es antecesor (o igual) de `refs/remotes/<remote>/<mainBranch>`? Devuelve false si el commit no es un hash
 * válido, si la referencia no existe o si git falla: nunca lanza y nunca usa la red.
 */
export async function commitInOriginMain(repoPath: string, commit: string | null | undefined, mainBranch: string | null | undefined, remote: string | null = 'origin', run: GitRun = git): Promise<boolean> {
  if (!commit || !SHA.test(commit)) return false;
  const rem = remote || 'origin';
  if (!mainBranch || !REF_NAME.test(mainBranch) || !REF_NAME.test(rem) || mainBranch.startsWith('-') || rem.startsWith('-')) return false;
  const cwd = repoRoot(repoPath);
  const ref = `refs/remotes/${rem}/${mainBranch}`;
  try { await run(cwd, ['rev-parse', '--verify', '--quiet', ref]); } catch { return false; }
  try { await run(cwd, ['merge-base', '--is-ancestor', commit, ref]); return true; } catch { return false; }
}

/**
 * Predicado con caché por llamada (commit + rama) para la bandeja: resuelve el remoto una sola vez, sin red.
 * Devuelve una función asíncrona; quien la use precalcula los resultados antes de la parte pura.
 */
export async function remoteInclusionChecker(repoPath: string, run: GitRun = git): Promise<(commit: string | null | undefined, mainBranch: string | null | undefined) => Promise<boolean>> {
  const { remote } = await remoteInfo(repoPath).catch(() => ({ remote: null as string | null, url: null }));
  const cache = new Map<string, Promise<boolean>>();
  return (commit, mainBranch) => {
    if (!remote) return Promise.resolve(false);
    const key = `${mainBranch ?? ''}:${commit ?? ''}`;
    let hit = cache.get(key);
    if (!hit) { hit = commitInOriginMain(repoPath, commit, mainBranch, remote, run); cache.set(key, hit); }
    return hit;
  };
}

/**
 * Marca como publicados (result.published) los procesos de historia/encargo del proyecto que están integrados
 * (result.merged), aún sin publicar y cuyo commit integrado ya está en la referencia local del remoto. Devuelve los ids
 * marcados. Sin red: solo lee referencias locales (las que actualiza el propio push). La caché dura solo esta llamada.
 */
export async function markPublishedIncluded(slug: string, projectId: string, opts: { remote?: string | null; url?: string | null; run?: GitRun } = {}): Promise<string[]> {
  const repo = projectsRepo(slug).repository(projectId);
  if (!repo) return [];
  const run = opts.run ?? git;
  let remote = opts.remote ?? null; let url = opts.url ?? null;
  if (!remote) {
    const info = await remoteInfo(repo.path).catch(() => ({ remote: null as string | null, url: null as string | null }));
    remote = info.remote; url = url ?? info.url;
  }
  if (!remote) return [];
  const procs = processesRepo(slug);
  const candidates = procs.list(projectId).filter(p => p.kind === 'story_execution' && !!p.result?.merged && !p.result?.published);
  const cache = new Map<string, boolean>();
  const marked: string[] = [];
  for (const p of candidates) {
    const merged = p.result!.merged!;
    const key = `${merged.into}:${merged.commit}`;
    let inRemote = cache.get(key);
    if (inRemote === undefined) { inRemote = await commitInOriginMain(repo.path, merged.commit, merged.into, remote, run); cache.set(key, inRemote); }
    if (!inRemote) continue;
    const fresh = procs.get(p.id);
    if (!fresh?.result?.merged || fresh.result.published) continue;
    procs.setResult(p.id, { ...fresh.result, published: { remote, url, branches: [merged.into], pushedAt: new Date().toISOString() } });
    marked.push(p.id);
  }
  return marked;
}

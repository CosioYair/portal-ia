import fs from 'node:fs';
import path from 'node:path';
import type { RepoStatus } from '@portal-ia/domain';
import { REPO_ROOT } from '../config.ts';
import { git, mainBranch, remoteInfo, repoRoot } from './repoWrite.ts';

/**
 * Estado del repositorio registrado de un proyecto (solo lectura, sin red): rama activa, rama principal, limpieza,
 * remoto y relación con `origin/<main>`; y si el repositorio es la carpeta desde la que corre este Portal.
 * Es la base de las reglas del flujo git: una rama por historia desde main, integrar en main, publicar main.
 */
export async function repoStatus(repoPath: string): Promise<RepoStatus> {
  const cwd = repoRoot(repoPath);
  const isGit = fs.existsSync(path.join(cwd, '.git'));
  const isPortalRuntime = path.resolve(cwd).toLowerCase() === path.resolve(REPO_ROOT).toLowerCase();
  if (!isGit) return { path: cwd, isGit: false, isPortalRuntime, branch: null, mainBranch: null, hasMain: false, hasCommits: false, dirty: false, dirtyFiles: 0, eolOnly: false, remote: null, remoteUrl: null, aheadOfRemote: null, behindRemote: null, headCommit: null, storyBranches: [] };
  const branch = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => null) || null;
  const hasCommits = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true).catch(() => false);
  const all = (await git(cwd, ['branch', '--format=%(refname:short)']).catch(() => '')).split('\n').map(s => s.trim()).filter(Boolean);
  const hasMain = all.includes('main') || all.includes('master');
  const main = hasMain ? await mainBranch(cwd) : null;
  const porcelain = await git(cwd, ['status', '--porcelain']).catch(() => '');
  const dirtyFiles = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  // ¿Los cambios sin confirmar son solo finales de línea (CRLF/LF)? Entonces se pueden normalizar con un clic.
  let eolOnly = false;
  if (dirtyFiles > 0 && !porcelain.split('\n').some(l => /^\?\?/.test(l))) { const real = await git(cwd, ['diff', '--ignore-all-space', '--ignore-blank-lines', '--numstat']).catch(() => 'x'); eolOnly = real.trim() === ''; }
  const { remote, url } = await remoteInfo(cwd);
  let ahead: number | null = null, behind: number | null = null;
  if (main && remote) {
    const hasRemoteRef = await git(cwd, ['rev-parse', '--verify', '-q', `${remote}/${main}`]).then(() => true).catch(() => false);
    if (hasRemoteRef) { const lr = await git(cwd, ['rev-list', '--left-right', '--count', `${main}...${remote}/${main}`]).catch(() => ''); const [a, b] = lr.split(/\s+/).map(n => parseInt(n, 10)); if (Number.isFinite(a)) { ahead = a; behind = b; } }
    else { ahead = -1; } // la rama principal nunca se publicó
  }
  const headCommit = hasCommits ? await git(cwd, ['rev-parse', '--short', 'HEAD']).catch(() => null) : null;
  return { path: cwd, isGit, isPortalRuntime, branch, mainBranch: main, hasMain, hasCommits, dirty: dirtyFiles > 0, dirtyFiles, eolOnly, remote, remoteUrl: url, aheadOfRemote: ahead, behindRemote: behind, headCommit, storyBranches: all.filter(b => b.startsWith('portal-ia/')) };
}

/** Crea la rama principal `main` a partir de la rama activa (repositorios que nacieron sin main) y la deja activa. */
export async function initMainBranch(repoPath: string): Promise<{ mainBranch: string; from: string }> {
  const cwd = repoRoot(repoPath);
  const st = await repoStatus(cwd);
  if (!st.isGit) throw Object.assign(new Error('La carpeta no es un repositorio git.'), { statusCode: 400 });
  if (st.hasMain) throw Object.assign(new Error(`La rama principal ya existe (${st.mainBranch}).`), { statusCode: 409 });
  if (!st.hasCommits) throw Object.assign(new Error('El repositorio no tiene commits todavía: aplica una primera historia o crea un commit inicial.'), { statusCode: 409 });
  if (st.dirty) throw Object.assign(new Error('El repositorio tiene cambios sin confirmar. Confírmalos o descártalos antes.'), { statusCode: 409 });
  const from = st.branch ?? 'HEAD';
  await git(cwd, ['branch', 'main']);
  await git(cwd, ['checkout', 'main']);
  return { mainBranch: 'main', from };
}

/** Configura (o corrige) el remoto `origin`. Solo URLs https:// o ssh de git. */
export async function setRemote(repoPath: string, url: string): Promise<{ remote: string; url: string }> {
  const cwd = repoRoot(repoPath);
  const clean = url.trim();
  if (!/^(https:\/\/[\w.-]+\/[\w./-]+|git@[\w.-]+:[\w./-]+)(\.git)?$/.test(clean)) throw Object.assign(new Error('URL de remoto no válida. Ejemplo: https://github.com/usuario/repositorio.git'), { statusCode: 400 });
  const { remote } = await remoteInfo(cwd);
  if (remote) await git(cwd, ['remote', 'set-url', remote, clean]); else await git(cwd, ['remote', 'add', 'origin', clean]);
  return { remote: remote ?? 'origin', url: clean };
}

/** Normaliza finales de línea: fija .gitattributes (text=auto), renormaliza el índice y confirma. Deja el árbol limpio. */
export async function normalizeEol(repoPath: string): Promise<{ commit: string | null; files: number }> {
  const cwd = repoRoot(repoPath);
  const ga = path.join(cwd, '.gitattributes');
  if (!fs.existsSync(ga) || !/text=auto/.test(fs.readFileSync(ga, 'utf8'))) fs.appendFileSync(ga, `${fs.existsSync(ga) ? '\n' : ''}# Normaliza finales de línea en el repositorio (LF); el árbol de trabajo puede usar CRLF en Windows.\n* text=auto\n*.png binary\n*.jpg binary\n*.ico binary\n`);
  await git(cwd, ['add', '--renormalize', '.']);
  await git(cwd, ['add', '.gitattributes']);
  const staged = (await git(cwd, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
  if (!staged.length) return { commit: null, files: 0 };
  await git(cwd, ['-c', 'user.name=Portal IA', '-c', 'user.email=portal-ia@local', 'commit', '-q', '-m', 'Normaliza finales de línea (.gitattributes text=auto)']);
  return { commit: await git(cwd, ['rev-parse', '--short', 'HEAD']), files: staged.length };
}

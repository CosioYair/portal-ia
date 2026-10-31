import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { projectsRepo } from '../db/workspace.ts';
import { requirePolicy, type PolicyOp } from './executionPolicy.ts';
import { repoStatus } from './repoStatus.ts';
import { git, pushBranches, repoRoot } from './repoWrite.ts';

/**
 * Operaciones del Portal que el Asistente puede PROPONER y el propietario autoriza en la conversación. Cada capacidad:
 *  - valida sus parámetros (lo que propone el modelo no es una autorización ni amplía nada);
 *  - calcula en el servidor una vista previa de solo lectura: qué se hará exactamente, sobre qué, y qué lo impide;
 *  - se ejecuta SOLO con la autorización explícita del propietario, con la política de ejecución (auditoría) y el MISMO
 *    servicio que usa el botón de la interfaz (sin duplicar su lógica).
 * No hay órdenes de shell ni operaciones genéricas: lo que no está en este catálogo no existe para el Asistente.
 */
export interface CapabilityPreview {
  ok: boolean;
  title: string;
  /** Qué se hará exactamente (y qué no). */
  details: string[];
  /** Lo que impide ejecutarla ahora (si hay algo, no se ejecuta). */
  blockers: string[];
  /** Lo que queda fuera a propósito (p. ej. otras ramas). */
  excluded: string[];
  target: { workspace: string; projectId: string; projectName: string };
  /** Estado exacto que muestra la vista previa (p. ej. el commit de main): autorizar exige que siga igual. */
  fingerprint?: string | null;
}
export interface CapabilityResult { summary: string; details: string[] }
export interface Capability<P = any> {
  id: string;
  label: string;
  policy: PolicyOp;
  params: z.ZodType<P>;
  preview(p: P): Promise<CapabilityPreview>;
  execute(p: P): Promise<CapabilityResult>;
}

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** Proyecto por slug o nombre dentro de la empresa indicada (por slug o nombre). */
function resolveProject(company: string, project: string): { slug: string; projectId: string; projectName: string } {
  const ws = workspacesRepo.list().find(w => w.slug === company || w.name.toLowerCase() === company.toLowerCase());
  if (!ws) throw err(404, `No existe la empresa «${company}».`);
  const p = projectsRepo(ws.slug).list().find(x => x.slug === project || x.id === project || x.name.toLowerCase() === project.toLowerCase());
  if (!p) throw err(404, `No existe el proyecto «${project}» en «${ws.name}».`);
  return { slug: ws.slug, projectId: p.id, projectName: p.name };
}

/**
 * Publicar la rama principal del repositorio AUTORIZADO de un proyecto (el mismo servicio que el botón «Publicar main»
 * del Panel): `git push -u <remoto> <main>`, nunca forzado y nunca otra rama. Queda en la auditoría (política git_push).
 */
export async function publishProjectMain(slug: string, projectId: string): Promise<{ remote: string; url: string | null; branches: string[] }> {
  const repo = projectsRepo(slug).repository(projectId);
  if (!repo) throw err(409, 'El proyecto no tiene repositorio registrado.');
  const st = await repoStatus(repo.path);
  if (!st.mainBranch) throw err(409, 'El repositorio no tiene rama principal (main). Créala primero.');
  requirePolicy('git_push', { slug, projectId, authorized: true });
  return pushBranches(repo.path, [st.mainBranch]);
}

const publishMain: Capability<{ company: string; project: string }> = {
  id: 'publish_main',
  label: 'Publicar la rama principal en el remoto (git push, sin forzar)',
  policy: 'git_push',
  params: z.object({ company: z.string().trim().min(1).max(120), project: z.string().trim().min(1).max(160) }),
  async preview({ company, project }) {
    const t = resolveProject(company, project);
    const repo = projectsRepo(t.slug).repository(t.projectId);
    const base = { title: `Publicar «main» de «${t.projectName}»`, target: { workspace: t.slug, projectId: t.projectId, projectName: t.projectName } };
    if (!repo) return { ...base, ok: false, details: [], blockers: ['El proyecto no tiene repositorio registrado (Panel → Repositorio).'], excluded: [] };
    const st = await repoStatus(repo.path); const cwd = repoRoot(repo.path);
    const blockers: string[] = []; const details: string[] = [];
    if (!st.isGit) blockers.push('La carpeta registrada no es un repositorio git.');
    if (!st.mainBranch) blockers.push('El repositorio no tiene rama principal (main).');
    if (!st.remote) blockers.push('No hay un remoto configurado (Panel → Repositorio → remoto).');
    if ((st.behindRemote ?? 0) > 0) blockers.push(`El remoto tiene ${st.behindRemote} commit(s) que tu «main» no tiene: publicar sería rechazado y el Portal NUNCA fuerza. Trae primero esos cambios.`);
    if (st.mainBranch && st.remote && st.aheadOfRemote === 0) blockers.push('No hay nada que publicar: el remoto ya tiene todos los commits de «main».');
    let commits: string[] = [];
    if (st.mainBranch && st.remote) {
      const range = st.aheadOfRemote === -1 ? st.mainBranch : `${st.remote}/${st.mainBranch}..${st.mainBranch}`;
      try { commits = (await git(cwd, ['log', '--oneline', '-n', '30', range])).trim().split('\n').filter(Boolean); } catch { /* sin historial */ }
    }
    details.push(`Repositorio: ${cwd}`, `Remoto: ${st.remote ?? '—'}${st.remoteUrl ? ` (${st.remoteUrl})` : ''}`, `Rama que se publica: ${st.mainBranch ?? '—'} (rama activa: ${st.branch ?? '—'})`);
    details.push(st.aheadOfRemote === -1 ? `«${st.mainBranch}» nunca se ha publicado: se publica entera (${commits.length}${commits.length === 30 ? '+' : ''} commit(s) recientes abajo).` : `${st.aheadOfRemote ?? 0} commit(s) por publicar:`);
    details.push(...commits.map(c => `  · ${c}`));
    if (st.dirty) details.push(`Hay ${st.dirtyFiles} archivo(s) sin confirmar: NO se publican (solo viajan commits).`);
    details.push('Orden exacta: git push -u <remoto> <main> · sin --force · ninguna otra rama.');
    const excluded = st.storyBranches.filter(b => b !== st.mainBranch).map(b => `${b} (rama de historia: no se publica)`);
    // Lo que se autoriza es ESTE main: si recibe otros commits antes de autorizar, la tarjeta ya no vale.
    const fingerprint = st.mainBranch ? await git(cwd, ['rev-parse', st.mainBranch]).then(x => x.trim()).catch(() => null) : null;
    return { ...base, ok: !blockers.length, details, blockers, excluded, fingerprint };
  },
  async execute(p) {
    const pv = await publishMain.preview(p);
    if (!pv.ok) throw err(409, `No se publica: ${pv.blockers.join(' ')}`);
    const res = await publishProjectMain(pv.target.workspace, pv.target.projectId);
    const repo = projectsRepo(pv.target.workspace).repository(pv.target.projectId)!;
    const after = await repoStatus(repo.path);
    const remoteHead = await git(repoRoot(repo.path), ['rev-parse', '--short', `${res.remote}/${after.mainBranch}`]).then(s => s.trim()).catch(() => null);
    return {
      summary: `«${res.branches.join(', ')}» publicada en ${res.remote}${res.url ? ` (${res.url})` : ''}.`,
      details: [`${res.remote}/${after.mainBranch} ahora en ${remoteHead ?? '?'} (main local en ${after.headCommit ?? '?'}).`, `Commits pendientes tras publicar: ${after.aheadOfRemote ?? '?'}.`, 'Registrado en la auditoría (política git_push).']
    };
  }
};

export const CAPABILITIES: Record<string, Capability> = { [publishMain.id]: publishMain };

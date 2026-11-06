import { z } from 'zod';
import { workspacesRepo } from '../db/platform.ts';
import { projectsRepo } from '../db/workspace.ts';
import { requirePolicy, type PolicyOp } from './executionPolicy.ts';
import { repoStatus } from './repoStatus.ts';
import { git, pushBranches, repoRoot } from './repoWrite.ts';
import { createPlan, pendingPlans, rejectPlan, setPlanSource } from './projectMaintenance.ts';
import { markPublishedIncluded } from './publishedSync.ts';
import type { MaintenanceItem, MaintenancePlan, VerificationRun } from '@portal-ia/domain';

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
  /** Operaciones con varios objetivos: el plan persistido y dónde se revisa y se autoriza objetivo a objetivo. */
  planId?: string | null;
  reviewPath?: string | null;
  /** Esta misma conversación ya tiene esa revisión pendiente (nada cambió): no se crea otra tarjeta. */
  alreadyPending?: boolean;
  /** Por qué se remite a la pendiente cuando no es «nada cambió» (p. ej. un cierre de etapa que solo sustituye el propietario). */
  pendingNote?: string | null;
}
/** Desde dónde se pide la vista previa (la conversación del Asistente). */
export interface CapabilityContext { conversationId?: string | null }
export interface CapabilityResult { summary: string; details: string[] }
export interface Capability<P = any> {
  id: string;
  label: string;
  policy: PolicyOp;
  params: z.ZodType<P>;
  /** Línea del catálogo que ve el modelo: qué hace y cuándo usarla (el catálogo del prompt sale de aquí). */
  promptHint: string;
  /** Empresa y proyecto afectados, SIN efectos: el alcance de la conversación se comprueba antes de la vista previa. */
  target?(p: P): { workspace: string; projectId: string };
  preview(p: P, ctx?: CapabilityContext): Promise<CapabilityPreview>;
  /** `approved`: la vista previa que autorizó el propietario (lo que se ejecuta es eso, no una vista nueva). */
  execute(p: P, approved?: CapabilityPreview): Promise<CapabilityResult>;
  /** Tarda minutos (p. ej. pruebas en el sandbox): al autorizar se lanza y la tarjeta muestra el resultado al terminar. */
  background?: boolean;
  /** Operaciones con plan: enlazar el plan con su tarjeta del chat y rechazarlo desde ella (lanza si ya no se puede). */
  onLink?(preview: CapabilityPreview, source: { messageId: string; operationId: string; conversationId?: string | null }): void;
  onReject?(preview: CapabilityPreview): void;
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
/** Publica main; con `commit`, exactamente ese commit (el que se autorizó), aunque main haya avanzado después. */
export async function publishProjectMain(slug: string, projectId: string, commit: string | null = null): Promise<{ remote: string; url: string | null; branches: string[]; markedPublished: number }> {
  const repo = projectsRepo(slug).repository(projectId);
  if (!repo) throw err(409, 'El proyecto no tiene repositorio registrado.');
  const st = await repoStatus(repo.path);
  if (!st.mainBranch) throw err(409, 'El repositorio no tiene rama principal (main). Créala primero.');
  requirePolicy('git_push', { slug, projectId, authorized: true });
  const res = await pushBranches(repo.path, [st.mainBranch], commit ? { [st.mainBranch]: commit } : {});
  // EN-009 · Los procesos integrados que esta publicación incluye quedan publicados (su «Publicar» sale de Decisiones).
  // Sin red (solo la referencia local que actualizó el push); si falla, la publicación sigue siendo válida.
  let markedPublished = 0;
  try { markedPublished = (await markPublishedIncluded(slug, projectId, { remote: res.remote, url: res.url })).length; } catch { /* la publicación ya se hizo */ }
  return { ...res, markedPublished };
}

const publishMain: Capability<{ company: string; project: string }> = {
  id: 'publish_main',
  label: 'Publicar la rama principal en el remoto (git push, sin forzar)',
  policy: 'git_push',
  params: z.object({ company: z.string().trim().min(1).max(120), project: z.string().trim().min(1).max(160) }),
  promptHint: '{"type":"request_operation","capability":"publish_main","company":slug,"project":slug} → publica la rama principal en su remoto (sin forzar, solo main; la tarjeta muestra qué commits y qué queda fuera). Si la publicación debe esperar a un encargo («…y publícalo cuando termines»), NO la propongas ahora: explícale que se propone cuando el EN esté integrado en main (y activo, si es el Portal).',
  target({ company, project }) { const t = resolveProject(company, project); return { workspace: t.slug, projectId: t.projectId }; },
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
    // …y a ESE remoto: con otro remoto (o sin él) la tarjeta tampoco vale.
    const sha = st.mainBranch ? await git(cwd, ['rev-parse', st.mainBranch]).then(x => x.trim()).catch(() => null) : null;
    const fingerprint = sha ? `${sha}@${st.remote ?? ''} ${st.remoteUrl ?? ''}` : null;
    return { ...base, ok: !blockers.length, details, blockers, excluded, fingerprint };
  },
  async execute(p) {
    const pv = await publishMain.preview(p);
    if (!pv.ok) throw err(409, `No se publica: ${pv.blockers.join(' ')}`);
    const res = await publishProjectMain(pv.target.workspace, pv.target.projectId, pv.fingerprint?.split('@')[0] ?? null);
    const repo = projectsRepo(pv.target.workspace).repository(pv.target.projectId)!;
    const after = await repoStatus(repo.path);
    const remoteHead = await git(repoRoot(repo.path), ['rev-parse', '--short', `${res.remote}/${after.mainBranch}`]).then(s => s.trim()).catch(() => null);
    return {
      summary: `«${res.branches.join(', ')}» publicada en ${res.remote}${res.url ? ` (${res.url})` : ''}.`,
      details: [`${res.remote}/${after.mainBranch} ahora en ${remoteHead ?? '?'} (main local en ${after.headCommit ?? '?'}).`, `Commits pendientes tras publicar: ${after.aheadOfRemote ?? '?'}.`, `${res.markedPublished} proceso(s) marcados como publicados (ya no piden «Publicar» en Decisiones).`, 'Registrado en la auditoría (política git_push).']
    };
  }
};

/** Resumen de una revisión para su tarjeta del chat (también cuando la tarjeta pasa a una revisión nueva). */
export function reviewDetails(plan: MaintenancePlan): string[] {
  const by = (c: MaintenanceItem['category']) => plan.items.filter(i => i.category === c);
  const kinds = (list: MaintenanceItem[]) => {
    const n = (k: MaintenanceItem['kind']) => list.filter(i => i.kind === k).length;
    return [n('remote_branch') && `${n('remote_branch')} rama(s) en ${plan.repo.remote}`, n('local_branch') && `${n('local_branch')} rama(s) locales`, n('worktree') && `${n('worktree')} worktree(s)`, n('story') && `${n('story')} historia(s)`, n('batch') && `${n('batch')} lote(s)`].filter(Boolean).join(', ') || 'nada';
  };
  return [
    `Repositorio: ${plan.repo.path} · ${plan.repo.mainBranch ?? 'sin main'} en ${plan.repo.mainSha?.slice(0, 7) ?? '—'}`,
    plan.repo.remoteAvailable ? `Remoto: ${plan.repo.remote} (${plan.counts.remoteBranches} rama(s), comprobado en vivo)` : `Remoto: ${plan.repo.remoteError ?? 'no disponible'}`,
    `Ya integrado — seguro: ${kinds(by('safe'))}`,
    `Requiere tu decisión: ${kinds(by('decision'))}`,
    `Protegido — no se toca: ${kinds(by('protected'))}`,
    ...(by('outside').length ? [`Fuera del alcance del Portal: ${kinds(by('outside'))}`] : []),
    ...(plan.intent?.kind === 'close_stage' ? [`Cierre de etapa: ${plan.prepared?.length ?? 0} acción(es) ya elegidas con el motivo ${plan.intent.source === 'assistant' ? 'propuesto por el Asistente' : 'tuyo'} «${plan.intent.reason}» (nunca carpetas con cambios sin guardar ni lo protegido); las revisas y confirmas tú en la revisión.`] : []),
    'Nada se ejecuta desde aquí: abre la revisión, elige objetivo a objetivo y autoriza allí.'
  ];
}

/**
 * Revisar el proyecto frente a main (ramas del remoto y locales, worktrees, historias, lotes) y preparar un plan de
 * limpieza y reconciliación. La vista previa es la revisión misma (solo lectura, sin IA, sin autorización); NADA se
 * ejecuta desde la tarjeta: el propietario elige objetivo a objetivo en la pantalla de revisión y allí autoriza.
 */
const reconcileProject: Capability<{ company: string; project: string; closeStage?: { reason: string } }> = {
  id: 'reconcile_project',
  label: 'Revisar el proyecto: ramas, worktrees y backlog frente a main (plan para autorizar objetivo a objetivo)',
  policy: 'read_repo',
  params: z.object({ company: z.string().trim().min(1).max(120), project: z.string().trim().min(1).max(160), closeStage: z.object({ reason: z.string().trim().min(3).max(300) }).optional() }),
  promptHint: '{"type":"request_operation","capability":"reconcile_project","company":slug,"project":slug,"closeStage"?:{"reason":string}} → REVISA el proyecto frente a main (ramas del remoto y locales, carpetas de trabajo, historias abiertas, lotes) y prepara un plan: lo ya integrado y seguro, lo que contiene trabajo que no está en main (requiere decisión) y lo protegido (main, en uso, lote abierto). Es la operación para «limpia/borra las ramas viejas u obsoletas (también en GitHub)», «reconcilia o cierra el backlog obsoleto», «que no aparezca trabajo viejo como pendiente», «revisa el estado del repositorio», también si te dice «encárgate», «hazlo» u «organiza»: NO es un encargo ni un análisis delegado ni ediciones de historias. Revisar es de solo lectura y sin IA; el propietario elige objetivo a objetivo y autoriza en la pantalla de revisión (borrar ramas en el remoto sin forzar, guardar copia y borrar trabajo no integrado, retirar carpetas de trabajo, aceptar/cerrar/cancelar historias con motivo, cerrar un lote). Al pedirla, la revisión YA queda preparada (no hay que autorizar nada para prepararla): la tarjeta muestra su resumen y el botón «Abrir la revisión para elegir y autorizar» (NO tiene botón «Autorizar»); en esa pantalla lo seguro viene marcado, lo demás en «Conservar», y se autoriza una sola vez lo elegido; solo cerrar o cancelar historias o cerrar un lote pide motivo. Las cifras y qué está protegido las calcula el Portal y las muestra en la tarjeta (y, al prepararla, debajo de tu respuesta): no las inventes, no digas qué carpeta o rama se borrará ni qué opciones tendrá cada historia, rama o carpeta concreta (integrar, guardar copia, borrar, cancelar…): eso lo muestran los datos del Portal y la revisión. Si el propietario YA DECIDIÓ cerrar la etapa (adoptar main como base y descartar todo el trabajo antiguo: ramas, historias, lote, encargos), añade "closeStage":{"reason":"<su motivo, tal cual o resumido>"}: la revisión llega con todo lo que se puede cerrar ya elegido y él lo confirma una sola vez; nunca lo uses si no lo ha decidido él. Si en esta conversación ya hay una revisión pendiente de ese proyecto, remítele a su tarjeta en vez de pedir otra, salvo que ahora decida cerrar la etapa: entonces pídela con closeStage (tu revisión nunca sustituye a otra: queda al lado y el propietario elige cuál ejecutar; si ya hay un cierre de etapa pendiente en esta conversación, el Portal te remite a él y solo el propietario lo renueva con «Revisar de nuevo»). Para decidir (preparar de nuevo, autorizar o rechazar) en la revisión o en una tarjeta, el propietario vincula su navegador una vez con un código de un solo uso que el Portal muestra en la ventana donde lo arrancó y en un archivo de su perfil («Vincula este navegador como propietario»): tú nunca ves ni pides ese código. Nunca digas que algo se borró o se cerró hasta que la tarjeta muestre el resultado; si antes dijiste que no se podía, corrígelo.',
  target({ company, project }) { const t = resolveProject(company, project); return { workspace: t.slug, projectId: t.projectId }; },
  onLink(pv, source) { if (pv.planId) setPlanSource(pv.target.workspace, pv.planId, source); },
  onReject(pv) { if (pv.planId) rejectPlan(pv.target.workspace, pv.planId); },
  async preview({ company, project, closeStage }, ctx) {
    const t = resolveProject(company, project);
    const target = { workspace: t.slug, projectId: t.projectId, projectName: t.projectName };
    const title = closeStage ? `Cierre de etapa de «${t.projectName}»: ramas y backlog` : `Revisión del proyecto «${t.projectName}»: ramas y backlog`;
    if (!projectsRepo(t.slug).repository(t.projectId)) return { ok: false, title, details: [], blockers: ['El proyecto no tiene repositorio registrado (Resumen › Repositorio).'], excluded: [], target };
    const reviewPath = (id: string) => `/empresa/${encodeURIComponent(t.slug)}/proyecto/${encodeURIComponent(t.projectId)}/mantenimiento/${id}`;
    // Un cierre de etapa pendiente en esta conversación solo lo sustituye el propietario (con su sesión, «Revisar de nuevo»):
    // cualquiera puede escribir al Asistente, así que desde aquí se remite a él en vez de preparar otro al lado.
    const stage = ctx?.conversationId ? pendingPlans(t.slug, t.projectId).find(p => p.intent?.kind === 'close_stage' && p.source?.conversationId === ctx.conversationId) : null;
    if (stage) return { ok: true, title: `Cierre de etapa de «${t.projectName}»: ramas y backlog`, details: reviewDetails(stage), blockers: [], excluded: [], target, fingerprint: stage.repo.mainSha, planId: stage.id, reviewPath: reviewPath(stage.id), alreadyPending: true,
      pendingNote: 'Esta conversación ya tiene un cierre de etapa pendiente: no se prepara otro. Solo tú lo sustituyes: ábrelo desde su tarjeta y, si el repositorio cambió, pulsa «Revisar de nuevo» (con este navegador vinculado como propietario).' };
    // Otra petición en minutos, sin cambios y desde esta conversación (o sin tarjeta aún), reutiliza la revisión.
    const plan = await createPlan(t.slug, t.projectId, { reuseMinutes: 10, conversationId: ctx?.conversationId ?? null, closeStage: closeStage ? { reason: closeStage.reason, source: 'assistant' } : null });
    return { ok: true, title, details: reviewDetails(plan), blockers: [], excluded: [], target, fingerprint: plan.repo.mainSha, planId: plan.id, reviewPath: reviewPath(plan.id),
      alreadyPending: !!ctx?.conversationId && plan.source?.conversationId === ctx.conversationId };
  },
  async execute() { throw err(409, 'Esta revisión se autoriza en su pantalla, objetivo a objetivo (no desde la tarjeta).'); }
};

const CHECKS = ['typecheck', 'test', 'build'] as const;
/**
 * Ejecutar typecheck, pruebas y compilación DE VERDAD sobre «main» del proyecto, en el sandbox (el mismo que verifica las
 * historias: sin red, contenedor de solo lectura), en un worktree temporal y desechable. Sin IA y sin cambiar nada: ni tu
 * carpeta, ni ramas, ni otros worktrees. Es la forma de que el Asistente compruebe el estado real («¿pasan las pruebas?»,
 * «¿se integró bien?») en vez de suponerlo. La autoriza el propietario (usa su equipo y Docker unos minutos).
 */
const runChecks: Capability<{ company: string; project: string; commands?: (typeof CHECKS[number])[] }> = {
  id: 'run_checks',
  label: 'Ejecutar typecheck, pruebas y compilación de main en el sandbox (sin IA, sin cambiar nada)',
  policy: 'sandbox_exec',
  params: z.object({ company: z.string().trim().min(1).max(120), project: z.string().trim().min(1).max(160), commands: z.array(z.enum(CHECKS)).min(1).max(3).optional() }),
  promptHint: '{"type":"request_operation","capability":"run_checks","company":slug,"project":slug,"commands"?:["typecheck","test","build"]} → ejecuta DE VERDAD typecheck/test/build sobre «main» del proyecto en el sandbox (worktree temporal, sin red ni IA; no cambia nada) y devuelve el resultado con las pruebas que fallan. Úsala cuando pida «ejecuta las pruebas», «¿compila?», «¿quedó bien?», o para comprobar el estado real antes de proponer o después de integrar un encargo.',
  background: true,
  target({ company, project }) { const t = resolveProject(company, project); return { workspace: t.slug, projectId: t.projectId }; },
  async preview({ company, project, commands }) {
    const t = resolveProject(company, project);
    const repo = projectsRepo(t.slug).repository(t.projectId);
    const cmds = commands?.length ? Array.from(new Set(commands)) : [...CHECKS];
    const base = { title: `Ejecutar ${cmds.join(', ')} sobre «main» de «${t.projectName}»`, target: { workspace: t.slug, projectId: t.projectId, projectName: t.projectName } };
    if (!repo) return { ...base, ok: false, details: [], blockers: ['El proyecto no tiene repositorio registrado (Panel → Repositorio).'], excluded: [] };
    const st = await repoStatus(repo.path); const cwd = repoRoot(repo.path);
    const blockers: string[] = [];
    if (!st.isGit) blockers.push('La carpeta registrada no es un repositorio git.');
    if (!st.mainBranch) blockers.push('El repositorio no tiene rama principal (main).');
    const { sandboxDeps } = await import('./verification.ts');
    const sb = await sandboxDeps.detect().catch(() => null);
    if (!sb || sb.available === 'unavailable') blockers.push(`No hay sandbox disponible (${sb?.detail ?? 'sin respuesta'}): arranca Docker Desktop y pídela de nuevo. Sin sandbox no se ejecuta nada en tu equipo.`);
    const sha = st.mainBranch ? await git(cwd, ['rev-parse', st.mainBranch]).then(x => x.trim()).catch(() => null) : null;
    const subject = sha ? await git(cwd, ['log', '-1', '--format=%h %s', sha]).then(x => x.trim()).catch(() => sha.slice(0, 7)) : '—';
    const details = [`Commit: ${subject} («${st.mainBranch ?? 'main'}»).`, `Se ejecuta, en este orden: ${cmds.join(' → ')}, en un worktree temporal de ese commit dentro del sandbox ${sb?.available ?? ''} (sin red, sin IA).`, 'No cambia nada: ni tu carpeta, ni ramas, ni otros worktrees; el worktree temporal se retira al terminar.', 'Puede tardar varios minutos; el resultado aparece en esta tarjeta.'];
    return { ...base, ok: !blockers.length, details, blockers, excluded: [], fingerprint: sha };
  },
  async execute(p, approved) {
    const pv = await runChecks.preview(p);
    if (!pv.ok || !pv.fingerprint) throw err(409, `No se ejecuta: ${pv.blockers.join(' ')}`);
    // Se ejecuta el commit que mostró la tarjeta autorizada; si main se movió desde entonces, no se ejecuta otro.
    if (approved?.fingerprint && approved.fingerprint !== pv.fingerprint) throw err(409, 'No se ejecutó: «main» cambió desde que viste la tarjeta. Pídela de nuevo.');
    const repo = projectsRepo(pv.target.workspace).repository(pv.target.projectId)!;
    requirePolicy('sandbox_exec', { slug: pv.target.workspace, projectId: pv.target.projectId, authorized: true });
    const { runOnCommit } = await import('./baseline.ts');
    const { testDigest } = await import('./testTriage.ts');
    const { DEPS_MISSING_EXIT } = await import('./sandbox.ts');
    const cmds = p.commands?.length ? Array.from(new Set(p.commands)) : [...CHECKS];
    const runs = await runOnCommit(repo.path, pv.fingerprint, cmds, 'checks');
    const line = (v: VerificationRun) => v.exitCode === 0 ? `${v.command} ✓` : v.exitCode === DEPS_MISSING_EXIT ? `${v.command}: sin dependencias` : v.isolation === 'unavailable' ? `${v.command}: sin sandbox` : v.exitCode === null ? `${v.command}: no terminó` : `${v.command} ✗`;
    const details: string[] = [];
    for (const v of runs) {
      details.push(`${line(v)} · código ${v.exitCode ?? '—'} · ${Math.round(v.durationMs / 1000)} s · ${v.isolation ?? '?'}`);
      if (v.exitCode === DEPS_MISSING_EXIT) details.push('  Faltan las dependencias Linux de este package-lock en el sandbox: se instalan al autorizar una ejecución (encargo o historia) con «Permitir instalar dependencias». No se instaló nada.');
      else if (v.exitCode !== 0 && v.command === 'test') for (const t of (v.tests ?? testDigest(v.output)).failing.slice(0, 12)) details.push(`  ✗ «${t.name}»${t.file ? ` (${t.file})` : ''}: ${t.message.replace(/\s+/g, ' ').slice(0, 240)}`);
      else if (v.exitCode !== 0) details.push(...v.output.trim().split('\n').slice(-6).map(l => `  ${l.slice(0, 240)}`));
    }
    const skipped = cmds.filter(c => !runs.some(v => v.command === c));
    if (skipped.length) details.push(`No se ejecutó: ${skipped.join(', ')} (el anterior lo impidió).`);
    details.push('Registrado en la auditoría (política sandbox_exec). Worktree temporal retirado.');
    return { summary: `${runs.map(line).join(' · ')} sobre ${pv.fingerprint.slice(0, 7)} (${runs[0]?.isolation ?? 'sandbox'}).`, details };
  }
};

export const CAPABILITIES: Record<string, Capability> = { [publishMain.id]: publishMain, [reconcileProject.id]: reconcileProject, [runChecks.id]: runChecks };

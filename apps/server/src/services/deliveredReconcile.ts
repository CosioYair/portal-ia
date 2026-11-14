import type { Process } from '@portal-ia/domain';
import { processesRepo, workspaceDb } from '../db/workspace.ts';
import { assignmentsRepo } from '../db/assignments.ts';
import { isNewerThan, latestMerged } from './storyClosure.ts';

/**
 * Portal IA 4 · un trabajo ya integrado no deja de estarlo.
 *
 * EN-029: el cambio estaba integrado y en marcha; una iteración correctiva posterior concluyó (con razón) que no
 * quedaba código que cambiar y aun así pasó a ser «la vigente», de modo que el trabajo figuraba como «Detenido sin
 * terminar». Aquí está la regla, en un solo sitio: si la iteración vigente de un trabajo es un «sin código» y una
 * iteración ANTERIOR del mismo trabajo está integrada, la vigente vuelve a ser la integrada. No usa IA, no cambia
 * código, no acepta ni cierra nada en nombre del propietario y es reversible (la iteración sin código se conserva
 * como historial, marcada como superada).
 */
export interface Delivered { processId: string; commit: string; mergedAt: string }

/** La entrega integrada a la que debe volver `p`, o null si `p` no es un «sin código» posterior a una integración. */
export function deliveredFor(slug: string, p: Process): Delivered | null {
  const r = p.result;
  if (p.kind !== 'story_execution' || !r?.planNoCode || r.merged) return null;
  const repo = processesRepo(slug);
  const fam = p.backlogItemId ? repo.listByBacklogItem(p.backlogItemId) : p.assignmentId ? repo.listByAssignment(p.assignmentId) : [];
  const m = latestMerged(fam.filter(x => x.id !== p.id && !x.archivedAt));
  return m && isNewerThan(p, m) ? { processId: m.id, commit: m.result!.merged!.commit, mergedAt: m.result!.merged!.mergedAt } : null;
}

/** Deja como vigente la entrega integrada. Devuelve el proceso integrado, o null si no había a dónde volver. */
export function restoreDelivered(slug: string, p: Process, by: 'owner' | 'portal'): Process | null {
  if (p.status === 'running' || p.status === 'pending_authorization') return null;
  const d = deliveredFor(slug, p); if (!d) return null;
  const repo = processesRepo(slug);
  repo.makeCurrentDelivered(d.processId);
  if (p.assignmentId) {
    const asg = assignmentsRepo(slug);
    const a = asg.get(p.assignmentId);
    if (a && a.processId !== d.processId) asg.update(p.assignmentId, x => {
      x.processId = d.processId;
      // El encargo ya está integrado: lo que falta es la prueba y la aceptación del propietario, no otra iteración.
      if (x.status === 'changes_requested' || x.status === 'needs_owner' || x.status === 'failed' || x.status === 'running') { x.status = 'ready_for_review'; x.iterationNote = null as any; }
      x.events.push({ at: new Date().toISOString(), kind: 'status', processId: d.processId, message: by === 'owner'
        ? `Se volvió a la entrega integrada (${d.commit}): la revisión posterior concluyó que no queda código que cambiar.`
        : `El Portal volvió a la entrega integrada (${d.commit}): la iteración posterior concluyó que no queda código que cambiar. Falta tu prueba y tu aceptación.` });
    });
  }
  return repo.get(d.processId) ?? null;
}

/**
 * Corrige el estado de todos los trabajos del espacio que estén en esa situación (al arrancar, y cada vez que termina
 * un proceso). Idempotente: una segunda pasada no encuentra nada.
 */
export function reconcileDelivered(slug: string, only?: { processId?: string }): { restored: string; from: string }[] {
  const rows = workspaceDb(slug).prepare(`SELECT id FROM processes WHERE kind = 'story_execution' AND archived_at IS NULL AND superseded_by IS NULL
    AND status IN ('done', 'failed') AND json_type(result_json, '$.planNoCode') = 'object' AND json_type(result_json, '$.merged') IS NULL${only?.processId ? ' AND id = ?' : ''}`).all(...(only?.processId ? [only.processId] : [])) as { id: string }[];
  const out: { restored: string; from: string }[] = [];
  const repo = processesRepo(slug);
  for (const row of rows) {
    const p = repo.get(row.id); if (!p) continue;
    const back = restoreDelivered(slug, p, 'portal');
    if (back) out.push({ restored: back.id, from: p.id });
  }
  return out;
}

/**
 * Portal IA 4 · El estado sale de los hechos de git. Si el commit VERIFICADO de un trabajo ya está contenido en la rama
 * principal (se integró fuera de su tarjeta: en una consolidación, o un reinicio cortó el registro), el trabajo se
 * registra como integrado en vez de seguir figurando como «detenido». No crea ningún merge (usa la misma vía que ya
 * registraba «la rama ya estaba integrada»), no usa IA y no acepta ni cierra nada: después siguen faltando la
 * activación, la comprobación en ejecución y la aceptación del propietario.
 */
export async function reconcileIntegrated(slug: string, log: (o: any, m: string) => void = () => undefined): Promise<string[]> {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const run = promisify(execFile);
  const { projectsRepo } = await import('../db/workspace.ts');
  const { mainBranch, repoRoot } = await import('./repoWrite.ts');
  const { mergeStory } = await import('./storyMerge.ts');
  const rows = workspaceDb(slug).prepare(`SELECT id FROM processes WHERE kind = 'story_execution' AND archived_at IS NULL AND superseded_by IS NULL AND status IN ('done', 'failed')
    AND json_type(result_json, '$.applied') = 'object' AND json_type(result_json, '$.merged') IS NULL AND json_type(result_json, '$.rejected') IS NULL`).all() as { id: string }[];
  const out: string[] = []; const repo = processesRepo(slug);
  for (const row of rows) {
    try {
      const p = repo.get(row.id); const r = p?.result; const commit = r?.applied?.commit; const branch = r?.applied?.branch; const base = (r as any)?.baseCommit as string | undefined;
      const rp = p ? projectsRepo(slug).repository(p.projectId) : null;
      if (!p || !commit || !branch || !base || !rp) continue;
      const root = repoRoot(rp.path); const git = async (...a: string[]) => (await run('git', a, { cwd: root, windowsHide: true })).stdout.trim();
      // Solo cuenta un trabajo que de verdad aportó commits propios sobre su base y cuyo commit verificado está en main.
      if (Number(await git('rev-list', '--count', `${base}..${commit}`)) < 1) continue;
      const main = await mainBranch(root, branch);
      try { await git('merge-base', '--is-ancestor', commit, main); } catch { continue; }
      const done = await mergeStory(slug, p.id, {}, log);
      if (done.result?.merged) out.push(p.id);
    } catch (e) { log({ processId: row.id, err: (e as Error).message }, 'conciliación con git: este trabajo se deja como está'); }
  }
  return out;
}

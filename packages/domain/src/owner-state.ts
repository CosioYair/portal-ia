import type { Process } from './types.ts';

/**
 * Portal IA 3 · EL estado de un trabajo tal como lo ve el propietario. Una sola función, pura, usada por todas las
 * pantallas (antes había cinco mapas distintos y uno de ellos mostraba «completado» para un proceso detenido con las
 * pruebas en rojo: la fila de la base dice `done` siempre que el proceso deja de ejecutarse, aunque no haya terminado).
 *
 * Regla: «completado» no existe como estado. Un trabajo está listo para revisar (verificado), integrado, o no ha
 * terminado y dice por qué. Verificado, integrado y aceptado son cosas distintas y se nombran distinto.
 */
export type OwnerStateKey =
  | 'needs_authorization' | 'queued' | 'working' | 'needs_decision' | 'stopped' | 'ready_for_review'
  | 'integrated' | 'no_changes' | 'finished' | 'ended_unverified' | 'failed' | 'cancelled' | 'discarded' | 'superseded';
export interface OwnerState {
  key: OwnerStateKey;
  /** Texto corto para chips y listas. */
  label: string;
  /** Una frase que dice qué significa y qué falta, sin jerga. */
  meaning: string;
  tone: '' | 'ok' | 'warn' | 'err';
  dot: '' | 'ok' | 'pulse' | 'err';
  /** ¿Espera algo de ti? */
  needsOwner: boolean;
  /** ¿Sigue vivo (trabajando o esperando) o ya es historia? */
  open: boolean;
}

const S = (key: OwnerStateKey, label: string, meaning: string, tone: OwnerState['tone'], dot: OwnerState['dot'], needsOwner: boolean, open: boolean): OwnerState => ({ key, label, meaning, tone, dot, needsOwner, open });

export function ownerProcessState(p: Pick<Process, 'status' | 'result'> & { steps?: Process['steps']; supersededBy?: string | null }): OwnerState {
  const r = p.result; const pl = r?.pipeline;
  if (r?.merged) return S('integrated', 'Integrada en main', 'Sus cambios ya están en la rama principal de tu proyecto.', 'ok', 'ok', false, false);
  if (r?.rejected) return S('discarded', 'Descartado', 'Se descartó; no llegó a tu proyecto.', '', '', false, false);
  if (p.supersededBy) return S('superseded', 'Sustituido', 'Lo sustituyó un intento posterior.', '', '', false, false);
  if (p.status === 'pending_authorization') return S('needs_authorization', 'Espera tu autorización', 'Está preparado y no gasta nada hasta que lo autorices.', 'warn', '', true, true);
  if (p.status === 'running') {
    const queued = (p.steps ?? []).some(s => s.status === 'running' && s.live?.state === 'queued');
    return queued ? S('queued', 'En cola · espera un hueco', 'Espera su turno para empezar.', '', 'pulse', false, true) : S('working', 'Trabajando', 'El equipo está trabajando en ello ahora.', '', 'pulse', false, true);
  }
  if (p.status === 'cancelled') return S('cancelled', 'Cancelado', 'Lo cancelaste antes de terminar.', '', '', false, false);
  if (p.status === 'failed' || p.status === 'budget_exceeded') return S('failed', p.status === 'budget_exceeded' ? 'Sin presupuesto' : 'No terminó', p.status === 'budget_exceeded' ? 'Se quedó sin el presupuesto autorizado antes de terminar.' : 'Se interrumpió por un error antes de terminar.', 'err', 'err', true, true);
  // status === 'done': el proceso dejó de ejecutarse. Lo que pasó de verdad lo dicen el pipeline y git.
  if (pl?.state === 'paused') return S('needs_decision', 'Necesita tu decisión', 'Se detuvo en un punto que solo tú puedes resolver; lo hecho se conserva.', 'warn', '', true, true);
  if (pl?.state === 'stopped' && pl.pauseKind === 'no_changes') return S('no_changes', 'Sin cambios necesarios', 'El equipo concluyó que no hacía falta cambiar nada.', '', '', true, true);
  if (pl?.state === 'stopped') return S('stopped', 'Detenido sin terminar', 'El equipo no consiguió dejarlo verificado; lo hecho se conserva y puedes continuar.', 'err', 'err', true, true);
  if (pl?.state === 'verified' && r?.applied) return S('ready_for_review', 'Listo para revisar', 'Está hecho y verificado, pero aún no forma parte de tu proyecto: falta que lo revises y lo aceptes.', 'ok', '', true, true);
  if (r?.applied) return S('ended_unverified', 'Hecho, sin verificar', 'Hay cambios preparados, pero no consta una verificación completa.', 'warn', '', true, true);
  if (pl?.state === 'verified') return S('ended_unverified', 'Verificado, sin aplicar', 'El equipo terminó y lo verificó, pero los cambios no están aplicados en ninguna rama: revísalo.', 'warn', '', true, true);
  return S('finished', 'Terminado', 'Terminó sin dejar cambios en el proyecto.', '', 'ok', false, false);
}

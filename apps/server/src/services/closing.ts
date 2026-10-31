import path from 'node:path';
import { INTERNAL_WORKSPACE, type Process } from '@portal-ia/domain';
import { REPO_ROOT } from '../config.ts';
import { projectsRepo } from '../db/workspace.ts';
import { runtimeVerified } from './runtimeChecks.ts';
import { activationOf } from './system.ts';

/**
 * Regla de cierre ÚNICA para el trabajo de código (historia o encargo de desarrollo): no se da por terminado sin cambios
 * aplicados, integrados en la rama principal, (en el propio Portal) activos y verificados en ejecución, y con la prueba
 * manual hecha paso a paso. Devuelve qué falta o null. Sin IA.
 */
export async function closingBlocker(slug: string, last: Process | undefined, noun: 'historia' | 'encargo' = 'historia'): Promise<{ code: string; error: string } | null> {
  const r = last?.result;
  const el = noun === 'historia' ? 'La historia' : 'El encargo';
  if (!r?.applied) return { code: 'not_applied', error: `${el} no tiene cambios aplicados. ${noun === 'historia' ? 'Ejecútala' : 'Ejecútalo'} y aplica su diff${noun === 'historia' ? ', o ciérrala como «resuelta fuera del flujo»' : ''}.` };
  if (!r.merged) return { code: 'not_merged', error: `Los cambios están en la rama ${r.applied.branch} pero no integrados en la rama principal. Intégralos desde el proceso antes de ${noun === 'historia' ? 'cerrar la historia' : 'aceptar el encargo'}.` };
  // Proyecto interno (el propio Portal): el merge no basta. Debe estar ACTIVADO (servidor reiniciado con el cambio y web
  // reconstruida) y VERIFICADO en ejecución; publicar en GitHub no es requisito.
  if (slug === INTERNAL_WORKSPACE.slug && last) {
    const repo = projectsRepo(slug).repository(last.projectId);
    const runtime = !!repo && path.resolve(repo.path) === path.resolve(REPO_ROOT);
    const act = runtime ? await activationOf(r.merged.commit, r.merged.mergedAt).catch(() => null) : null;
    if (act && !act.active) return { code: 'not_activated', error: `${el} está ${noun === 'historia' ? 'integrada' : 'integrado'} pero no activo en el Portal en marcha: ${act.reason}` };
    if (act && !runtimeVerified(r.runtimeChecks)) return { code: 'not_runtime_verified', error: 'Falta la verificación en ejecución: pulsa «Comprobar en ejecución» en el proceso (el Portal se comprueba a sí mismo) y vuelve a intentarlo.' };
  }
  if (!r.manualTest) return { code: 'no_test', error: 'Falta la prueba manual: en el Resumen del proceso, genera la lista de prueba con QA o escríbela, pruébala paso a paso y vuelve a intentarlo.' };
  if (r.manualTest.checks.some(c => !c)) { const n = r.manualTest.checks.filter(Boolean).length; return { code: 'not_tested', error: `Falta probar ${noun === 'historia' ? 'la historia' : 'el encargo'}: ${n} de ${r.manualTest.steps.length} pasos marcados.` }; }
  return null;
}

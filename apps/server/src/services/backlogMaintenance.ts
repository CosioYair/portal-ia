import { INTERNAL_WORKSPACE } from '@portal-ia/domain';
import { settingsRepo, workspacesRepo } from '../db/platform.ts';
import { backlogRepo, projectsRepo } from '../db/workspace.ts';

/**
 * Saneamiento del backlog del proyecto interno «Desarrollo del Portal» (una sola vez por versión).
 *
 * El backlog nació de la evaluación inicial (HU-001..014: construir la plataforma desde cero) y de encargos hechos
 * cuando los agentes trabajaban sobre un repositorio paralelo. Buena parte de eso ya está implementado en este Portal
 * (v0.1–v0.9) o quedó obsoleto. Aquí se registra, historia por historia y con motivo, qué se cierra como hecho,
 * qué se descarta, qué se fusiona y en qué orden queda lo pendiente, con la automejora del Portal como prioridad.
 * Se identifica cada historia por su id Y una palabra clave del título para no tocar historias distintas.
 */
type Rule = { id: string; kw: RegExp; action: 'done' | 'discard' | 'merge'; into?: string; reason: string };
const RULES: Rule[] = [
  { id: 'HU-003', kw: /SQLite|persistencia/i, action: 'done', reason: 'Implementado: una base SQLite por empresa (data/workspaces/<slug>) y registro global en platform.sqlite (v0.1, v0.5).' },
  { id: 'HU-004', kw: /API local/i, action: 'done', reason: 'Implementado: API local Fastify con validación zod, solo en 127.0.0.1, credenciales cifradas y nunca devueltas (v0.1).' },
  { id: 'HU-006', kw: /adaptador/i, action: 'done', reason: 'Implementado: packages/ai-adapters con Anthropic y OpenAI, registro de tokens y costo por llamada (v0.1).' },
  { id: 'HU-010', kw: /solo lectura.*CLI|CLI/i, action: 'discard', reason: 'Obsoleta: el ciclo de solo lectura de punta a punta existe en la interfaz (evaluación inicial), no hace falta una CLI.' },
  { id: 'HU-013', kw: /diff/i, action: 'done', reason: 'Implementado: cada historia entrega un diff revisable y la verificación (install/typecheck/test/build) se ejecuta con autorización (v0.4, v0.9).' },
  { id: 'HU-014', kw: /hito/i, action: 'discard', reason: 'Obsoleta: era un hito de validación del plan original; el hito se cumplió con la ejecución real de historias en el Portal.' },
  { id: 'HU-116', kw: /im[aá]genes/i, action: 'done', reason: 'Implementado: el chat admite adjuntar o pegar imágenes y archivos de texto (v0.6, v0.8.1).' },
  { id: 'HU-117', kw: /secretos/i, action: 'done', reason: 'Implementado: escaneo de posibles secretos en cada cambio propuesto, con aviso antes de aplicar o publicar (v0.9).' },
  { id: 'HU-129', kw: /main/i, action: 'done', reason: 'Hecho por el propietario: main consolidada y publicada en GitHub con el código real del Portal (v0.8).' },
  { id: 'HU-130', kw: /main/i, action: 'done', reason: 'Implementado: comprobación previa de carpeta de ejecución y ramas de historia creadas siempre desde main (v0.8).' },
  { id: 'HU-131', kw: /evidencia/i, action: 'discard', reason: 'Obsoleta: se refería a historias del repositorio paralelo; la regla de cierre actual exige integración real en main.' },
  { id: 'HU-132', kw: /SQLite/i, action: 'done', reason: 'Duplicada de HU-003: ya implementado (base por empresa + registro global).' },
  { id: 'HU-136', kw: /procesos/i, action: 'done', reason: 'Implementado: Actividad y la vista de proceso muestran pasos, tokens, costo, errores y el siguiente paso (v0.2–v0.9).' },
  { id: 'HU-140', kw: /fusi[oó]n|aprobaci[oó]n/i, action: 'done', reason: 'Implementado: integrar en main y publicar requieren autorización explícita desde el proceso (v0.7).' },
  { id: 'HU-142', kw: /compacto|plegables|filtros/i, action: 'done', reason: 'Implementado: backlog por secciones plegables con búsqueda y filtros (v0.9).' },
  { id: 'HU-143', kw: /main|publicar/i, action: 'done', reason: 'Implementado: la integración siempre apunta a main y la publicación comprueba la rama local antes del push (v0.7, v0.9).' },
  { id: 'HU-012', kw: /bandeja/i, action: 'merge', into: 'HU-009', reason: 'Fusionada en HU-009 (bandeja de autorizaciones: especificación + vista + aprobar/denegar).' },
  { id: 'HU-137', kw: /bandeja|aprobar/i, action: 'merge', into: 'HU-009', reason: 'Fusionada en HU-009 (bandeja de autorizaciones).' },
  { id: 'HU-135', kw: /BudgetMeter|presupuesto/i, action: 'merge', into: 'HU-133', reason: 'Fusionada en HU-133 (presupuestos jerárquicos con indicador de saldo real).' },
  { id: 'HU-138', kw: /BudgetMeter|saldo/i, action: 'merge', into: 'HU-133', reason: 'Fusionada en HU-133 (presupuestos jerárquicos con indicador de saldo real).' }
];
/** Orden de prioridad de lo que queda pendiente: primero lo que hace más autónoma y segura la automejora. */
const PRIORITY = ['HU-011', 'HU-009', 'HU-133', 'HU-007', 'HU-008', 'HU-134', 'HU-141', 'HU-005', 'HU-139'];
const RETITLE: Record<string, { title: string; criterion: string }> = {
  'HU-009': { title: 'Bandeja de autorizaciones: ver, aprobar y denegar todo lo pendiente en un solo lugar', criterion: 'Una pantalla lista todas las decisiones pendientes (autorizar procesos, aplicar diffs, integrar, publicar, propuestas al backlog) con su costo/impacto; aprobar o denegar desde ahí produce el mismo efecto que hacerlo en el proceso.' },
  'HU-133': { title: 'Presupuestos jerárquicos empresa > proyecto > proceso con saldo real', criterion: 'Cada empresa y proyecto tiene un presupuesto mensual; un proceso no puede autorizarse por encima del saldo disponible; el indicador de saldo muestra gasto real y reservas de procesos en curso.' }
};

export function runBacklogMaintenance(log: (o: any, m: string) => void): { applied: boolean; summary: string[] } {
  const KEY = 'migrations.backlog-saneamiento-v0.9';
  if (settingsRepo.get(KEY)) return { applied: false, summary: [] };
  if (!workspacesRepo.get(INTERNAL_WORKSPACE.slug)) return { applied: false, summary: [] };
  const projects = projectsRepo(INTERNAL_WORKSPACE.slug).list();
  const summary: string[] = [];
  for (const project of projects) {
    const repo = backlogRepo(INTERNAL_WORKSPACE.slug);
    const items = repo.list(project.id);
    const byId = (id: string) => items.find(i => i.storyId === id);
    const note = (it: { id: string; description: string }, text: string) => repo.update(it.id, { description: `${it.description ? it.description + '\n' : ''}[Saneamiento v0.9] ${text}` });
    for (const r of RULES) {
      const it = byId(r.id); if (!it || !r.kw.test(it.title) || it.status === 'done' || it.status === 'discarded' || it.status === 'in_progress') continue;
      if (r.action === 'done') { note(it, r.reason); repo.setStatus(it.id, 'done'); summary.push(`${it.storyId} → completada (${r.reason.split(':')[0].toLowerCase()})`); }
      else if (r.action === 'discard') { note(it, r.reason); repo.setStatus(it.id, 'discarded'); summary.push(`${it.storyId} → descartada`); }
      else if (r.action === 'merge' && r.into) { const into = byId(r.into); if (!into) continue; note(it, r.reason); repo.setStatus(it.id, 'discarded'); repo.update(into.id, { description: `${into.description ? into.description + '\n' : ''}Incluye ${it.storyId} (${it.title}).` }); summary.push(`${it.storyId} → fusionada en ${r.into}`); }
    }
    for (const [id, t] of Object.entries(RETITLE)) { const it = byId(id); if (it && it.status !== 'done' && it.status !== 'discarded') repo.update(it.id, { title: t.title, criterion: t.criterion }); }
    // Reordenar: prioridad explícita primero, luego el resto de pendientes en su orden actual, luego el resto.
    const fresh = repo.list(project.id);
    const open = fresh.filter(i => i.status !== 'done' && i.status !== 'discarded');
    const ordered = [...PRIORITY.map(id => open.find(i => i.storyId === id)).filter(Boolean) as typeof open, ...open.filter(i => !PRIORITY.includes(i.storyId)), ...fresh.filter(i => i.status === 'done' || i.status === 'discarded')];
    ordered.forEach((it, idx) => repo.setPosition(it.id, idx));
    if (ordered.length) summary.push(`Reordenadas ${ordered.length} historias (prioridad: ${PRIORITY.filter(id => open.some(i => i.storyId === id)).join(', ')})`);
  }
  settingsRepo.set(KEY, new Date().toISOString());
  if (summary.length) log({ changes: summary.length }, 'saneamiento del backlog aplicado');
  return { applied: true, summary };
}

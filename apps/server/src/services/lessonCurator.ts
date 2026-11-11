import type { Lesson, TeamRole } from '@portal-ia/domain';
import { causeOfTags, lessonsRepo } from './lessons.ts';
import { maybeImproveLessons } from './lessonImprover.ts';
import { agentsRepo, processesRepo, workspaceDb } from '../db/workspace.ts';
import { syncLessonPracticesSafe } from './lessonPractices.ts';

/**
 * HU-202 · Curador de Aprendizaje (la curación no usa IA y cuesta 0 USD).
 * Agrupa las detecciones pendientes por causa (proyecto + detector + papel + firma de causa, EN-022) y, por reglas:
 *  - aplica (validated, source 'curator') la lección del catálogo a la detección más reciente de cada causa útil;
 *  - rechaza el resto del grupo («agrupada»), el ruido del proveedor («descartada:ruido»), los detectores sin catálogo
 *    («descartada:sin-catalogo») y las causas ya refutadas o retiradas por el propietario (no se reaplican en bucle).
 * Las filas rechazadas conservan su dedupeKey: volver a detectar el mismo error no crea copias.
 * La curación no llama a ningún modelo. EN-022: tras cada tarea dispara maybeImproveLessons (lessonImprover.ts), el único
 * sitio con llamada de IA, y solo dentro de la autorización permanente de Ajustes; si no, deja una decisión pendiente.
 */
export interface CatalogEntry { title: string; text: string; role: TeamRole; tags: string[] }

export const LESSON_CATALOG: Record<string, CatalogEntry> = {
  patch_mismatch: { title: 'Parches que encajan con el archivo actual', role: 'implementer', tags: ['patch', 'implementar'], text: 'Antes de escribir un parche, copia el fragmento BUSCAR literalmente del contenido actual del archivo, con contexto suficiente para que sea único. Si no tienes el contenido actual, pídelo en lugar de inventarlo.' },
  stale_file: { title: 'No sobrescribir archivos que cambiaron', role: 'implementer', tags: ['stale', 'implementar'], text: 'Trabaja sobre la versión actual de cada archivo y usa parches en lugar de reemplazos completos; si un archivo cambió después de leerlo, vuelve a leerlo antes de modificarlo.' },
  big_rewrite: { title: 'Modificar sin reescribir', role: 'implementer', tags: ['modify', 'implementar'], text: 'No reemplaces un archivo existente entero: modifica solo los fragmentos necesarios con parches y conserva todo el código que no forma parte del cambio.' },
  unused_module: { title: 'Conectar los módulos nuevos', role: 'implementer', tags: ['wiring', 'implementar'], text: 'Cada módulo nuevo debe quedar importado y usado desde el código existente en el mismo cambio; no entregues archivos nuevos sin conectarlos.' },
  qa_rejected: { title: 'Cumplir el criterio antes de entregar', role: 'implementer', tags: ['qa', 'implementar'], text: 'Antes de entregar, repasa cada criterio de aceptación y comprueba que el diff lo cumple con código y pruebas; explica en el resumen cómo se cumple cada uno.' },
  verification_failed: { title: 'Entregar código que compila y pasa las pruebas', role: 'implementer', tags: ['verify', 'implementar'], text: 'Entrega código que pase typecheck, test y build: respeta los tipos estrictos, los imports con extensión .ts/.tsx y actualiza las pruebas afectadas por el cambio.' },
  activation_failed: { title: 'Cambios que se pueden activar', role: 'implementer', tags: ['activation', 'build'], text: 'Asegúrate de que el cambio se reconstruye y arranca: no dejes imports rotos, dependencias sin declarar ni configuración incompleta.' },
  runtime_failed: { title: 'Comprobar el comportamiento en ejecución', role: 'implementer', tags: ['runtime', 'implementar'], text: 'Comprueba que las rutas y pantallas que declaras en las comprobaciones en ejecución existen y responden como describes; declara solo las que tu cambio cumple.' },
  story_reset: { title: 'Planes acotados al criterio', role: 'planner', tags: ['reset', 'planificar'], text: 'Planifica solo lo que pide el criterio de aceptación, con archivos y tareas concretos; si la historia es ambigua, dilo en los riesgos en lugar de suponer.' },
  agent_blocked: { title: 'Pedir lo que falta de forma concreta', role: 'implementer', tags: ['bloqueo', 'implementar'], text: 'Si te falta información o un permiso, decláralo en la sección BLOQUEO con lo que necesitas y una pregunta concreta, y entrega todo lo que sí puedas hacer.' },
  dev_no_output: { title: 'Respetar el formato de entrega', role: 'implementer', tags: ['format', 'implementar'], text: 'Entrega siempre los cambios en el formato de archivos acordado (=== ARCHIVO: … === FIN ARCHIVO ===), sin texto suelto en lugar de código.' },
  oversized_response: { title: 'Respuestas que caben en la salida', role: 'implementer', tags: ['tamaño', 'salida', 'implementar'], text: 'Divide el trabajo para que cada respuesta quepa en la salida del modelo: usa parches pequeños en lugar de archivos completos largos.' },
  output_exhausted: { title: 'No agotar la salida razonando', role: 'implementer', tags: ['razonamiento', 'salida', 'costo'], text: 'Razona lo justo y entrega los cambios pronto: la respuesta debe incluir el código antes de agotar la salida disponible.' },
  regenerated_completed: { title: 'Parchear lo ya terminado', role: 'implementer', tags: ['regenerar', 'patch', 'implementar'], text: 'No regeneres un archivo que ya entregaste completo: si necesitas corregirlo, usa un parche sobre su contenido actual.' },
  incomplete_delivery: { title: 'Entregar todos los archivos del plan', role: 'implementer', tags: ['completitud', 'plan', 'implementar'], text: 'Entrega todos los archivos que el plan incluye en tu ámbito; si alguno no hace falta, decláralo con DESCARTE y un motivo verificable.' },
  ineffective_correction: { title: 'Correcciones con cambios aplicables', role: 'implementer', tags: ['corrección', 'costo', 'implementar'], text: 'En cada corrección, entrega cambios aplicables que ataquen el diagnóstico recibido; no repitas la entrega anterior ni respondas solo con explicaciones.' },
  missing_tests: { title: 'Pruebas para el código nuevo', role: 'implementer', tags: ['pruebas', 'calidad', 'implementar'], text: 'Acompaña el código nuevo con pruebas nuevas en apps/server/test (node --test) que cubran su comportamiento principal.' },
  gauntlet_gap: { title: 'Cerrar las brechas del Evaluador', role: 'implementer', tags: ['gauntlet', 'implementar'], text: 'Antes de entregar, comprueba cada criterio con evidencia en el diff (código, prueba o texto visible); no des por cumplido un criterio sin esa evidencia.' },
  max_turns_exhausted: { title: 'Entregar antes de agotar los turnos', role: 'implementer', tags: ['turnos', 'claude-code', 'implementar'], text: 'Acota la exploración y entrega antes de agotar los turnos: lee solo los archivos imprescindibles, agrupa las lecturas en pocas llamadas y entrega los cambios en cuanto tengas lo necesario.' },
  correction_cap_reached: { title: 'Correcciones que atacan el diagnóstico', role: 'implementer', tags: ['corrección', 'tope', 'implementar'], text: 'Ataca el diagnóstico concreto en cada corrección: lee el error exacto (archivo, prueba y mensaje), corrige esa causa y comprueba que tu cambio la resuelve antes de entregar.' }
};

export const NOISE = new Set(['provider_refusal', 'provider_timeout', 'provider_unavailable', 'provider_credentials', 'excessive_context']);

/** EN-022: proyecto:detector:papel[:firma]. Sin firma de causa conserva la clave antigua. */
export const causeKey = (l: Pick<Lesson, 'projectId' | 'detector' | 'role'> & { tags?: string[] }) => {
  const base = `${l.projectId ?? ''}:${l.detector}:${l.role ?? ''}`; const sig = causeOfTags(l.tags);
  return sig ? `${base}:${sig}` : base;
};

export interface CurateSummary { applied: number; merged: number; discarded: number; groups: number; appliedIds: string[] }

const isoNow = () => new Date().toISOString();

/** Cura todas las detecciones pendientes (del proyecto, o de todo el espacio). Idempotente: sin pendientes no cambia nada. */
export function curatePending(slug: string, opts: { projectId?: string | null; by?: string } = {}): CurateSummary {
  const repo = lessonsRepo(slug);
  const out: CurateSummary = { applied: 0, merged: 0, discarded: 0, groups: 0, appliedIds: [] };
  const all = repo.list(opts.projectId ?? null, null);
  const pending = all.filter(l => l.status === 'detected' && (!opts.projectId || l.projectId === opts.projectId));
  if (!pending.length) return out;
  const groups = new Map<string, Lesson[]>();
  for (const l of pending) { const k = causeKey(l); groups.set(k, [...(groups.get(k) ?? []), l]); }
  const statusOf = (k: string, s: string) => all.some(l => l.status === s && causeKey(l) === k);
  const reject = (l: Lesson, tag: string) => { repo.update(l.id, { status: 'rejected', tags: Array.from(new Set([...l.tags, tag])) }); };
  const db = workspaceDb(slug);
  db.exec('SAVEPOINT lesson_curate');
  try {
    for (const [k, ls] of groups) {
      out.groups++;
      const detector = ls[0].detector; const entry = LESSON_CATALOG[detector];
      const why = NOISE.has(detector) || detector.startsWith('provider_') ? 'descartada:ruido'
        : !entry ? 'descartada:sin-catalogo'
        : statusOf(k, 'validated') ? 'agrupada'
        : statusOf(k, 'refuted') ? 'descartada:refutada'
        : statusOf(k, 'obsolete') ? 'descartada:retirada'
        : null;
      if (why) { for (const l of ls) reject(l, why); if (why === 'agrupada') out.merged += ls.length; else out.discarded += ls.length; continue; }
      const sorted = [...ls].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const [keep, ...rest] = sorted;
      // EN-022: con firma de causa, la lección es específica de esa causa (título y texto con el caso).
      const sig = causeOfTags(keep.tags);
      const text = sig ? `${entry!.text} Caso: ${sig}.` : entry!.text;
      // La brecha del Evaluador ya trae en su título el texto original del hallazgo (más legible que el findingKey normalizado).
      const specificTitle = sig && detector !== 'gauntlet_gap' ? `${entry!.title}: ${sig.slice(0, 140)}` : null;
      repo.update(keep.id, { status: 'validated', ...(specificTitle ? { title: specificTitle } : {}), lessonText: text, correctiveAction: text, role: keep.role ?? entry!.role, tags: Array.from(new Set([...keep.tags, ...entry!.tags, 'curador'])), validatedAt: isoNow(), source: 'curator' });
      out.applied++; out.appliedIds.push(keep.id);
      for (const l of rest) { reject(l, 'agrupada'); out.merged++; }
    }
    db.exec('RELEASE lesson_curate');
    // EN-020: una sola sincronización por curación. Las lecciones aplicadas llegan solas a la plantilla y a los agentes.
    // El Curador solo rechaza detecciones sin aplicar, que nunca han estado en una plantilla.
    if (out.applied) syncLessonPracticesSafe(slug);
  } catch (e) {
    try { db.exec('ROLLBACK TO lesson_curate'); db.exec('RELEASE lesson_curate'); } catch { /* el savepoint ya no existía */ }
    throw e;
  }
  return out;
}

/** Tras cada tarea: cura las pendientes de su proyecto y lo registra a 0 USD. Nunca lanza error. */
export function curateAfterTask(slug: string, processId: string): CurateSummary | null {
  const startedAt = isoNow();
  try {
    const procs = processesRepo(slug); const proc = procs.get(processId);
    if (!proc) return null;
    const summary = curatePending(slug, { projectId: proc.projectId, by: 'curator' });
    // EN-022: mejora de las lecciones que reinciden o quedan refutadas (en segundo plano; nunca lanza error).
    void maybeImproveLessons(slug, proc.projectId).catch(() => undefined);
    let agentId = '';
    try { agentId = agentsRepo(slug).list().find(a => a.key === 'pj-curador-de-aprendizaje' && (a.projectId === proc.projectId || a.projectId === null))?.id ?? ''; } catch { /* sin agente */ }
    try { procs.logExecution({ projectId: proc.projectId, agentId, kind: 'lesson_curate', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt }); } catch { /* el registro no debe romper la tarea */ }
    return summary;
  } catch {
    return null;
  }
}

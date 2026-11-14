import type { Lesson } from './types.ts';

/** Estado de la ficha de una lección: «Aprendida» y la insignia de reincidencia, calculados por tarea. */
export interface LessonCardState {
  learned: boolean;
  recurrenceBadge: boolean;
  /** Tareas en las que se cumplió (terminaron verificadas sin reincidencia pendiente). */
  heldTasks: number;
  /** Tareas en las que reincidió sin terminar verificadas. */
  recurredTasks: number;
  /** Portal IA 4 · Tareas que tocaron la zona del error y terminaron bien: las únicas que demuestran la lección. */
  provenTasks: number;
  /** Tareas que la llevaron y terminaron bien SIN tocar esa zona: no demuestran nada (no son mérito de la lección). */
  unprovenTasks: number;
}

const INACTIVE = new Set<string>(['refuted', 'obsolete', 'rejected']);

/**
 * EN-022 · Función pura. Cada tarea (proceso) cuenta una sola vez. Si en la misma tarea hay un fallo intermedio y
 * luego termina verificada, cuenta como cumplida y no como reincidencia. La insignia solo aparece con recurrenceCount
 * mayor que 0, y en ese caso la lección no se marca como «Aprendida»: las dos cosas nunca se muestran a la vez.
 * Portal IA 4 · «Aprendida» exige una tarea EXPUESTA (tocó la zona del error) que terminó bien: que la lección se haya
 * entregado muchas veces no dice si funciona.
 */
export function lessonCardState(lesson: Pick<Lesson, 'status' | 'recurrenceCount' | 'proof' | 'recurrenceProcesses'>): LessonCardState {
  const recurredSet = new Set(lesson.recurrenceProcesses ?? []);
  const held = new Set<string>(); const proven = new Set<string>();
  for (const p of lesson.proof ?? []) if (p.result === 'held') { held.add(p.processId); if (p.exposed === true) proven.add(p.processId); }
  for (const id of held) recurredSet.delete(id);
  const recurrenceBadge = (lesson.recurrenceCount ?? 0) > 0;
  const heldTasks = held.size;
  const recurredTasks = recurrenceBadge ? Math.max(recurredSet.size, lesson.recurrenceCount) : 0;
  // Aprendida = evitó su error al menos una vez donde podía repetirse. Llevarla en tareas ajenas no cuenta.
  const learned = !recurrenceBadge && proven.size > 0 && !INACTIVE.has(String(lesson.status));
  return { learned, recurrenceBadge, heldTasks, recurredTasks, provenTasks: proven.size, unprovenTasks: heldTasks - proven.size };
}

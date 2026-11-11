import type { Lesson } from './types.ts';

/** Estado de la ficha de una lección: «Aprendida» y la insignia de reincidencia, calculados por tarea. */
export interface LessonCardState {
  learned: boolean;
  recurrenceBadge: boolean;
  /** Tareas en las que se cumplió (terminaron verificadas sin reincidencia pendiente). */
  heldTasks: number;
  /** Tareas en las que reincidió sin terminar verificadas. */
  recurredTasks: number;
}

const INACTIVE = new Set<string>(['refuted', 'obsolete', 'rejected']);

/**
 * EN-022 · Función pura. Cada tarea (proceso) cuenta una sola vez. Si en la misma tarea hay un fallo intermedio y
 * luego termina verificada, cuenta como cumplida y no como reincidencia. La insignia solo aparece con recurrenceCount
 * mayor que 0, y en ese caso la lección no se marca como «Aprendida»: las dos cosas nunca se muestran a la vez.
 */
export function lessonCardState(lesson: Pick<Lesson, 'status' | 'recurrenceCount' | 'proof' | 'recurrenceProcesses'>): LessonCardState {
  const recurredSet = new Set(lesson.recurrenceProcesses ?? []);
  const held = new Set<string>();
  for (const p of lesson.proof ?? []) if (p.result === 'held') held.add(p.processId);
  for (const id of held) recurredSet.delete(id);
  const recurrenceBadge = (lesson.recurrenceCount ?? 0) > 0;
  const heldTasks = held.size;
  const recurredTasks = recurrenceBadge ? Math.max(recurredSet.size, lesson.recurrenceCount) : 0;
  const learned = !recurrenceBadge && heldTasks > 0 && !INACTIVE.has(String(lesson.status));
  return { learned, recurrenceBadge, heldTasks, recurredTasks };
}

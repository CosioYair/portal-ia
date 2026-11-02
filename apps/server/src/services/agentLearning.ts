import type { Lesson } from '@portal-ia/domain';
import { agentsRepo, processesRepo } from '../db/workspace.ts';
import { lessonsRepo } from './lessons.ts';
import { agentFoldersRepo, syncAgentFolder } from './agentFolders.ts';
import { recordAgentEvent } from './agentEvents.ts';
import { chatMessages } from './agentChat.ts';
import { monotonicNow } from '../clock.ts';

/**
 * Aprendizaje de un agente a partir de su trabajo real (docs/agentes-portables.md, «Memoria»):
 *  1. El propietario opina sobre un entregable o una respuesta (útil / necesita cambios + qué aprender) → OBSERVACIÓN
 *     ligada a la tarea o al mensaje, guardada como lección «propuesta» del agente (nunca se aplica todavía).
 *  2. El propietario la VERIFICA (puede editar el texto) → «validada»: desde ese momento entra en los prompts de ESE agente
 *     y en su memory/MEMORY.md, con su procedencia. Solo el propietario verifica; nada generado por un modelo se
 *     convierte solo en memoria.
 *  3. Se puede retirar (queda como «obsoleta», con historial).
 * Usa la tabla de lecciones de siempre (con agent_id): ni las listas ni las inyecciones de la organización la ven.
 */
const now = monotonicNow;

export function proposeFromFeedback(slug: string, agentId: string, input: { processId?: string | null; messageId?: string | null; rating: 'useful' | 'needs_changes'; feedback: string; lesson?: string | null }): Lesson {
  const a = agentsRepo(slug).get(agentId); if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
  const feedback = input.feedback.trim(); const text = (input.lesson ?? '').trim() || feedback;
  if (text.length < 8) throw Object.assign(new Error('Describe qué debería aprender el agente (al menos una frase).'), { statusCode: 400 });
  const proc = input.processId ? processesRepo(slug).get(input.processId) : null;
  if (input.processId && (!proc || !proc.steps.some(s => s.agentId === agentId))) throw Object.assign(new Error('Esa tarea no es de este agente.'), { statusCode: 400 });
  const msg = input.messageId ? chatMessages(slug, agentId, 200).find(m => m.id === input.messageId) : null;
  if (input.messageId && !msg) throw Object.assign(new Error('Ese mensaje no es de este agente.'), { statusCode: 400 });
  const ts = now();
  const l = lessonsRepo(slug).insert({
    projectId: null, role: null, tags: [input.rating === 'useful' ? 'acierto' : 'mejora'], status: 'proposed', version: 1, parentId: null,
    title: text.split('\n')[0].slice(0, 100), detector: 'owner_feedback',
    evidence: { processId: proc?.id ?? null, processTitle: proc?.title ?? (msg ? 'conversación directa' : null), stepId: null, agentId, agentName: a.config.name, file: null,
      detail: `${input.rating === 'useful' ? 'Útil' : 'Necesita cambios'} — opinión del propietario: «${feedback.slice(0, 600)}»${msg ? ` (sobre la respuesta del ${msg.createdAt.slice(0, 16).replace('T', ' ')})` : ''}`, at: ts },
    rootCause: null, correctiveAction: null, lessonText: text.slice(0, 2000), source: 'owner_feedback', promotedTo: null, dedupeKey: null
  })!;
  lessonsRepo(slug).setAgent(l.id, agentId);
  recordAgentEvent(slug, agentId, 'memory_proposed', { lessonId: l.id, processId: proc?.id ?? null, messageId: msg?.id ?? null, rating: input.rating });
  return lessonsRepo(slug).get(l.id)!;
}

async function syncIfFolder(slug: string, agentId: string, note: string) {
  const a = agentsRepo(slug).get(agentId);
  if (a && agentFoldersRepo(slug).folderOf(agentId)) { try { await syncAgentFolder(slug, a, note); } catch { /* cambio externo pendiente: la carpeta se pondrá al día al resolverlo */ } }
}

export async function verifyMemory(slug: string, agentId: string, lessonId: string, patch: { title?: string; text?: string } = {}): Promise<Lesson> {
  const repo = lessonsRepo(slug); const l = repo.get(lessonId);
  if (!l || l.agentId !== agentId) throw Object.assign(new Error('Aprendizaje no encontrado'), { statusCode: 404 });
  if (l.status !== 'proposed' && l.status !== 'detected') throw Object.assign(new Error('Ese aprendizaje ya no está pendiente.'), { statusCode: 409 });
  const text = (patch.text ?? l.lessonText ?? '').trim(); if (text.length < 8) throw Object.assign(new Error('El aprendizaje necesita un texto claro.'), { statusCode: 400 });
  repo.update(lessonId, { status: 'validated', lessonText: text.slice(0, 2000), validatedAt: now() });
  if (patch.title?.trim()) { const { workspaceDb } = await import('../db/workspace.ts'); workspaceDb(slug).prepare(`UPDATE lessons SET title = ? WHERE id = ?`).run(patch.title.trim().slice(0, 120), lessonId); }
  recordAgentEvent(slug, agentId, 'memory_verified', { lessonId });
  await syncIfFolder(slug, agentId, 'Memoria verificada por el propietario');
  return repo.get(lessonId)!;
}

export async function retireMemory(slug: string, agentId: string, lessonId: string): Promise<Lesson> {
  const repo = lessonsRepo(slug); const l = repo.get(lessonId);
  if (!l || l.agentId !== agentId) throw Object.assign(new Error('Aprendizaje no encontrado'), { statusCode: 404 });
  repo.update(lessonId, { status: l.status === 'validated' ? 'obsolete' : 'rejected' });
  recordAgentEvent(slug, agentId, 'memory_retired', { lessonId, was: l.status });
  await syncIfFolder(slug, agentId, 'Memoria retirada por el propietario');
  return repo.get(lessonId)!;
}

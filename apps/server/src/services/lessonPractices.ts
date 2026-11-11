import type { Agent, AgentTemplateVersion, Lesson, TeamRole } from '@portal-ia/domain';
import { agentsRepo } from '../db/workspace.ts';
import { settingsRepo } from '../db/platform.ts';
import { lessonsRepo } from './lessons.ts';
import { effectiveVersion, isPinned, ROLE_TEMPLATE, templateKeyFor, templatesRepo } from './agentTemplates.ts';
import { monotonicNow } from '../clock.ts';

/**
 * EN-020 · Lecciones aplicadas → prácticas de plantilla, sin acción del propietario (sin IA, idempotente).
 *  - Solo se gestionan las prácticas con lessonId; las manuales o base (sin lessonId) se copian intactas y en su orden.
 *  - Una lección 'validated' con papel entra en la plantilla de su papel (ROLE_TEMPLATE); una retirada, refutada u
 *    obsoleta sale; una edición (versión nueva de la lección) sustituye a su antecesora en la misma posición.
 *  - Si el resultado cambia, se crea key@N+1 (source 'auto', createdBy 'portal') con un diff legible.
 *  - Los agentes que siguen esa plantilla pasan a la última versión con by 'portal', salvo los fijados por una vuelta
 *    atrás del propietario. Excepción: la primera migración marcada mueve a todos (petición explícita del propietario).
 */
type Practice = AgentTemplateVersion['practices'][number];
const now = monotonicNow;
const markKey = (slug: string) => `migrations.en020-lesson-practices:${slug}`;

export interface LessonPracticesSync { created: string[]; moved: { agentId: string; from: string | null; to: string }[]; migration: boolean }

const textOf = (l: Lesson) => (l.lessonText ?? '').trim();
const practiceOf = (l: Lesson): Practice => ({ lessonId: l.id, text: textOf(l), title: l.title, addedAt: now() });

/** Calcula las prácticas de la versión siguiente de una plantilla a partir de las lecciones aplicadas. */
function planPractices(key: string, prev: AgentTemplateVersion, valid: Map<string, Lesson>): { practices: Practice[]; plus: string[]; minus: string[]; addedIds: string[] } {
  const desired = [...valid.values()].filter(l => !!l.role && ROLE_TEMPLATE[l.role as TeamRole] === key);
  const childOf = new Map<string, Lesson>();
  for (const l of desired) if (l.parentId) childOf.set(l.parentId, l);
  const practices: Practice[] = []; const plus: string[] = []; const minus: string[] = []; const addedIds: string[] = [];
  const placed = new Set<string>();
  const hasText = (t: string) => practices.some(p => p.text === t);
  for (const p of prev.practices) {
    if (!p.lessonId) { practices.push(p); continue; } // manual o base: intacta
    const l = valid.get(p.lessonId);
    if (l && !placed.has(l.id)) {
      const text = textOf(l);
      if (text !== p.text) { minus.push(p.text); plus.push(text); practices.push({ ...p, text, title: l.title }); }
      else practices.push(p);
      placed.add(l.id); continue;
    }
    minus.push(p.text);
    // Edición: la versión nueva de la lección ocupa el sitio de su antecesora.
    const child = childOf.get(p.lessonId);
    if (child && !placed.has(child.id) && !prev.practices.some(x => x.lessonId === child.id)) {
      const text = textOf(child);
      if (!hasText(text)) { practices.push(practiceOf(child)); plus.push(text); addedIds.push(child.id); }
      placed.add(child.id);
    }
  }
  for (const l of desired) {
    if (placed.has(l.id) || prev.practices.some(x => x.lessonId === l.id)) continue;
    const text = textOf(l); placed.add(l.id);
    if (hasText(text)) continue; // el mismo texto ya está (p. ej. práctica manual): una sola vez
    practices.push(practiceOf(l)); plus.push(text); addedIds.push(l.id);
  }
  return { practices, plus, minus, addedIds };
}

/** Recalcula las prácticas de todas las plantillas y pasa a los agentes a la última versión. Sin IA. */
export function syncLessonPractices(slug: string, opts: { migration?: boolean } = {}): LessonPracticesSync {
  const firstMigration = !!opts.migration && !settingsRepo.get(markKey(slug));
  const lessons = lessonsRepo(slug); const repo = templatesRepo(slug);
  const out: LessonPracticesSync = { created: [], moved: [], migration: firstMigration };
  const valid = new Map<string, Lesson>();
  for (const l of lessons.list(null, 'validated')) if (textOf(l)) valid.set(l.id, l);
  const keys = new Set<string>([...Object.values(ROLE_TEMPLATE), ...repo.keys().map(k => k.key)]);
  const agents: Agent[] = agentsRepo(slug).list();
  for (const key of keys) {
    const prev = repo.latest(key); if (!prev) continue;
    let latest = prev;
    const plan = planPractices(key, prev, valid);
    if (plan.plus.length || plan.minus.length) {
      const diffMd = `--- ${prev.id}\n+++ ${key}@${prev.version + 1}\n@@ Prácticas de la organización (automático: lecciones aplicadas) @@\n${[...plan.minus.map(t => `- ${t}`), ...plan.plus.map(t => `+ ${t}`)].join('\n')}`;
      latest = repo.insert({ key, version: prev.version + 1, name: prev.name, role: prev.role, responsibilities: prev.responsibilities, practices: plan.practices, diffMd, source: 'auto' as string as AgentTemplateVersion['source'], lessonId: plan.addedIds[0] ?? null, createdBy: 'portal' });
      out.created.push(latest.id);
    }
    for (const p of latest.practices) {
      if (!p.lessonId) continue;
      const l = valid.get(p.lessonId);
      if (l && l.promotedTo !== latest.id) lessons.update(l.id, { promotedTo: latest.id });
    }
    for (const a of agents) {
      if (templateKeyFor(a) !== key || a.templateVersion === latest.id) continue;
      if (!a.templateVersion && latest.version === 1) continue; // sin versión = v1 efectiva
      if (!firstMigration && isPinned(slug, a.id)) continue; // la vuelta atrás del propietario se respeta
      const from = a.templateVersion ?? effectiveVersion(slug, a)?.id ?? null;
      repo.setAgentVersion(a.id, from, latest.id, 'portal');
      out.moved.push({ agentId: a.id, from, to: latest.id });
    }
  }
  if (firstMigration) settingsRepo.set(markKey(slug), now());
  return out;
}

/** Sincroniza sin romper nunca el flujo que la llama (validar, retirar, curar…). */
export function syncLessonPracticesSafe(slug: string): void {
  try { syncLessonPractices(slug); } catch (e: any) { console.error(`[EN-020] No se pudieron sincronizar las prácticas de ${slug}: ${e?.message ?? e}`); }
}

/** Por lección: versión de plantilla en la que está (la última que la contiene) y a cuántos agentes llega. */
export function lessonTemplateReach(slug: string): Record<string, { templateVersion: string; agents: number }> {
  const repo = templatesRepo(slug);
  const eff = agentsRepo(slug).list().map(a => effectiveVersion(slug, a)).filter((v): v is AgentTemplateVersion => !!v);
  const out: Record<string, { templateVersion: string; agents: number }> = {};
  for (const k of repo.keys()) {
    const latest = repo.latest(k.key); if (!latest) continue;
    for (const p of latest.practices) {
      if (!p.lessonId || out[p.lessonId]) continue;
      out[p.lessonId] = { templateVersion: latest.id, agents: eff.filter(v => v.practices.some(x => x.lessonId === p.lessonId)).length };
    }
  }
  return out;
}

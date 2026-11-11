import { slugify, type PortableSkill } from './portable-agent.ts';

/**
 * HU-204 · «Redactar con IA» en «Nuevo agente». Sin IO: aquí solo están el tipo de la propuesta, el prompt y la limpieza de
 * la respuesta. La IA solo puede proponer textos: papel, resumen, responsabilidades, entregables, habilidades (con su
 * contenido) e instrucciones AGENTS.md. Nunca propone ni concede permisos, herramientas, capacidades, conocimiento, arnés,
 * modelo, presupuesto ni autonomía: si los devuelve, se descartan (y se informa de qué se descartó).
 */
export interface AgentWizardDraft {
  role: string;
  summary: string;
  responsibilities: string[];
  deliverables: string[];
  skills: PortableSkill[];
  instructions: string;
}

export interface AgentWizardDraftParse {
  draft: AgentWizardDraft;
  /** Claves que devolvió el modelo y que no se admiten (permisos, herramientas, arnés, modelo…). Solo informativo. */
  discarded: string[];
}

export interface WizardDraftContext {
  /** Papeles de los agentes que ya existen (para no duplicar funciones). */
  existingRoles?: readonly string[];
  /** Nombre del proyecto o empresa donde trabajará (opcional). */
  where?: string | null;
}

export const WIZARD_DRAFT_LIMITS = {
  need: 4000, role: 80, summary: 600, item: 200, items: 20,
  skills: 8, skillName: 80, skillDescription: 300, skillBody: 8000, instructions: 12000
} as const;

/** Las únicas claves que se aceptan de la respuesta del modelo. */
export const WIZARD_DRAFT_KEYS = ['role', 'summary', 'responsibilities', 'deliverables', 'skills', 'instructions'] as const;

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const oneLine = (v: unknown, max: number): string => clean(v, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = oneLine(x, WIZARD_DRAFT_LIMITS.item);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= WIZARD_DRAFT_LIMITS.items) break;
  }
  return out;
}

function cleanSkills(v: unknown): PortableSkill[] {
  if (!Array.isArray(v)) return [];
  const out: PortableSkill[] = []; const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = oneLine(r.name, WIZARD_DRAFT_LIMITS.skillName);
    if (!name) continue;
    let base = slugify(oneLine(r.slug, 48) || name); let s = base; let n = 2;
    while (seen.has(s)) s = `${base}-${n++}`;
    seen.add(s);
    out.push({ slug: s, name, description: oneLine(r.description, WIZARD_DRAFT_LIMITS.skillDescription), body: clean(r.body ?? r.content, WIZARD_DRAFT_LIMITS.skillBody) });
    if (out.length >= WIZARD_DRAFT_LIMITS.skills) break;
  }
  return out;
}

/** Prompt de UNA llamada. Pide JSON estricto y prohíbe proponer permisos, herramientas, arnés, modelo o autonomía. */
export function buildWizardDraftPrompt(need: string, ctx: WizardDraftContext = {}): { system: string; user: string } {
  const roles = (ctx.existingRoles ?? []).filter(Boolean).slice(0, 40);
  const system = [
    'Eres el Agente de Onboarding de Portal IA. Redactas, en español, el perfil de un nuevo agente especializado para que el propietario lo revise y edite antes de crearlo. No creas nada: solo propones textos.',
    'Prohibido: no propongas permisos, herramientas, capacidades, conocimiento, arnés, modelo, esfuerzo, presupuestos ni autonomía. Eso lo decide siempre el propietario; si lo incluyes, se descarta.',
    'Responde SOLO con un objeto JSON válido, sin texto alrededor ni bloques de código.'
  ].join('\n');
  const user = [
    `Lo que debería conseguir este agente, según el propietario${ctx.where ? ` (trabajará en «${ctx.where}»)` : ''}:`,
    `"""${need.trim().slice(0, WIZARD_DRAFT_LIMITS.need)}"""`,
    roles.length ? `Agentes que ya existen (no dupliques su función): ${roles.join('; ')}.` : '',
    'Forma exacta del JSON:',
    '{"role": string (papel, 2–6 palabras), "summary": string (en qué ayuda, 1–2 frases), "responsibilities": string[3-6], "deliverables": string[2-5], "skills": [{"name": string, "description": string (1 frase), "body": string (Markdown: cuándo usarla y pasos concretos)}] (1-4), "instructions": string (Markdown para AGENTS.md: objetivo, cómo trabaja, reglas y formato de entrega)}'
  ].filter(Boolean).join('\n');
  return { system, user };
}

/** Limpia la respuesta del modelo: lista blanca, longitudes, slugs y límites. null si no hay nada aprovechable. */
export function parseWizardDraft(text: string): AgentWizardDraftParse | null {
  const jsonText = (text ?? '').match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return null;
  let j: unknown;
  try { j = JSON.parse(jsonText); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  const discarded = Object.keys(o).filter(k => !(WIZARD_DRAFT_KEYS as readonly string[]).includes(k));
  const draft: AgentWizardDraft = {
    role: oneLine(o.role, WIZARD_DRAFT_LIMITS.role),
    summary: oneLine(o.summary, WIZARD_DRAFT_LIMITS.summary),
    responsibilities: cleanList(o.responsibilities),
    deliverables: cleanList(o.deliverables),
    skills: cleanSkills(o.skills),
    instructions: clean(o.instructions, WIZARD_DRAFT_LIMITS.instructions)
  };
  const empty = !draft.role && !draft.summary && !draft.responsibilities.length && !draft.deliverables.length && !draft.skills.length && !draft.instructions;
  return empty ? null : { draft, discarded };
}

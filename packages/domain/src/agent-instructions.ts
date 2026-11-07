import { toolCapabilities } from './agent-skills.ts';
import type { AgentContextScope } from './types.ts';
import { findSecret } from './portable-agent.ts';

/**
 * AGENTS.md por defecto de un agente del Portal (EN-013). Función pura y determinista: sin IA, sin IO y sin fechas, para
 * que la huella de la carpeta sea estable mientras no cambien los datos del agente.
 *
 * - Sale de los datos reales del agente: papel, especialización, responsabilidades, a quién reporta y habilidades según
 *   sus herramientas concedidas (`toolCapabilities`).
 * - No concede permisos. Las herramientas y las habilidades base salen solo de lo concedido en Configuración.
 * - No lleva identificadores internos ni rutas locales: el paquete portable lo admite tal cual. El contexto sale del
 *   ámbito (EN-014). Empresa nombra la empresa y sus reglas, Proyecto añade el nombre y los objetivos del proyecto y
 *   General añade «En cualquier entorno». Sin ámbito, el texto es el de antes, para que la huella no cambie.
 * - Termina con la marca de «por defecto». Mientras la lleve, el Portal la regenera; si el propietario la quita, es suya.
 */
export interface DefaultInstructionsInput {
  name: string;
  role?: string | null;
  specialization?: string | null;
  responsibilities?: readonly string[] | null;
  /** Nombre legible de a quién reporta (p. ej. «el propietario» o el nombre del Coordinador). */
  reportsTo?: string | null;
  /** Herramientas concedidas (claves). */
  tools?: readonly string[] | null;
  /** Línea de entorno opcional, en lenguaje llano y sin rutas. */
  environmentNote?: string | null;
  /** EN-014 · Ámbito del agente. Sin valor, se escribe el texto anterior («en Portal IA»). */
  contextScope?: AgentContextScope | null;
  /** Nombre de la empresa (solo se usa con Empresa). */
  companyName?: string | null;
  /** Nombre y objetivos del proyecto (solo se usan con Proyecto). */
  projectName?: string | null;
  projectGoals?: readonly string[] | null;
  /** EN-015 · Nombre propio del agente (p. ej. «Lucía»). Sin valor, el texto es idéntico al anterior. */
  personalName?: string | null;
  /** Marca de instrucciones por defecto (la última línea). */
  mark: string;
}

export const INSTRUCTIONS_NO_GRANT = 'Estas instrucciones no conceden permisos: las herramientas se conceden en Configuración.';

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- EN-015 · Nombre propio del agente

/** Límites del nombre propio (en caracteres visibles). */
export const AGENT_NAME_LIMITS = { min: 2, max: 30 } as const;

/** Nombre tal como se guarda y se muestra: NFC, sin espacios dobles ni en los extremos. */
export function cleanAgentName(s: string | null | undefined): string {
  return (s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Clave de comparación: minúsculas, sin acentos (NFD) y sin espacios dobles. «Lucía» y «LUCIA» dan lo mismo. */
export function normalizeAgentName(s: string | null | undefined): string {
  return cleanAgentName(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export type AgentNameProblem = 'empty' | 'length' | 'chars' | 'id' | 'secret' | 'role' | 'taken';
export interface AgentNameCheck {
  ok: boolean;
  /** El nombre limpio (el que se guardaría). */
  name: string;
  code: AgentNameProblem | null;
  /** Motivo legible para el propietario, o null si es válido. */
  reason: string | null;
}
export interface AgentNameContext {
  /** Nombres propios de los OTROS agentes de la empresa. */
  taken?: readonly (string | null | undefined)[];
  /** Puestos de los agentes de la empresa: el nombre no puede coincidir con un puesto (haría ambigua «@puesto»). */
  roles?: readonly (string | null | undefined)[];
  /** Identificadores que no pueden aparecer como nombre (ids, claves de plantilla, slugs de carpeta…). */
  ids?: readonly (string | null | undefined)[];
}

const UUID_LIKE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}|[0-9a-f]{12,}/i;
const NAME_CHARS = /^\p{L}[\p{L}\p{M}' ’.-]*$/u;

/**
 * Reglas del nombre propio (puras): de 2 a 30 caracteres, solo letras, espacios, apóstrofos, guiones y puntos (sin
 * dígitos, así no cabe un id), sin aspecto de secreto ni de identificador, distinto de los puestos y único entre los
 * demás nombres de la empresa sin distinguir mayúsculas ni acentos. `context` puede ser la lista de nombres ocupados.
 */
export function validateAgentName(raw: string | null | undefined, context: AgentNameContext | readonly (string | null | undefined)[] = {}): AgentNameCheck {
  const ctx: AgentNameContext = Array.isArray(context) ? { taken: context as readonly (string | null | undefined)[] } : context as AgentNameContext;
  const name = cleanAgentName(raw);
  const fail = (code: AgentNameProblem, reason: string): AgentNameCheck => ({ ok: false, name, code, reason });
  if (!name) return fail('empty', 'Escribe un nombre.');
  if (findSecret(name)) return fail('secret', 'El nombre parece una credencial: elige otro.');
  const norm = normalizeAgentName(name);
  const ids = (ctx.ids ?? []).map(normalizeAgentName).filter(Boolean);
  if (UUID_LIKE.test(name) || ids.includes(norm)) return fail('id', 'El nombre no puede ser un identificador: elige un nombre de persona.');
  const len = Array.from(name).length;
  if (len < AGENT_NAME_LIMITS.min || len > AGENT_NAME_LIMITS.max) return fail('length', `El nombre debe tener entre ${AGENT_NAME_LIMITS.min} y ${AGENT_NAME_LIMITS.max} caracteres.`);
  if (!NAME_CHARS.test(name)) return fail('chars', 'Usa solo letras, espacios, apóstrofos, guiones o puntos (sin números ni símbolos).');
  if ((ctx.roles ?? []).some(r => normalizeAgentName(r) === norm)) return fail('role', 'Ese nombre coincide con un puesto de la empresa: elige otro.');
  if ((ctx.taken ?? []).some(t => normalizeAgentName(t) === norm)) return fail('taken', 'Otro agente de la empresa ya se llama así: pide otro nombre.');
  return { ok: true, name, code: null, reason: null };
}

export interface AgentNameSource { name: string; personalName?: string | null | undefined }
const nameSource = (a: AgentNameSource | { config: AgentNameSource }): AgentNameSource => 'config' in a ? a.config : a;

/** El nombre propio limpio o null si no tiene. */
export function agentPersonalName(a: AgentNameSource | { config: AgentNameSource }): string | null {
  return cleanAgentName(nameSource(a).personalName) || null;
}

/** «Lucía · Diseñador UX/UI» si el agente tiene nombre propio; si no, el puesto tal cual (como hoy). */
export function agentDisplayName(a: AgentNameSource | { config: AgentNameSource }): string {
  const src = nameSource(a); const personal = agentPersonalName(src);
  return personal ? `${personal} · ${clean(src.name)}` : src.name;
}

export interface NameProposalInput {
  role: string;
  specialization?: string | null;
  responsibilities?: readonly string[] | null;
  /** Nombres ya usados en la empresa (no puede repetirlos). */
  taken?: readonly (string | null | undefined)[];
  /** Puestos de la empresa (no puede usarlos como nombre). */
  roles?: readonly (string | null | undefined)[];
  /** Propuestas anteriores que el propietario no quiso («Pedir otro»). */
  rejected?: readonly (string | null | undefined)[];
}

/** Prompt de la ÚNICA llamada con la que el agente propone su nombre. Pide JSON {name, reason}; sin ids ni rutas. */
export function buildNameProposalPrompt(input: NameProposalInput): string {
  const list = (xs: readonly (string | null | undefined)[] | undefined) => (xs ?? []).map(cleanAgentName).filter(Boolean);
  const resp = (input.responsibilities ?? []).map(clean).filter(Boolean);
  const taken = list(input.taken); const roles = list(input.roles); const rejected = list(input.rejected);
  const out: string[] = [
    `Eres «${clean(input.role) || 'un agente'}» en un equipo de agentes de IA. Elige tu propio nombre de pila, como el de una persona.`,
    ''
  ];
  if (clean(input.specialization)) out.push(`Especialización: ${clean(input.specialization)}`);
  if (resp.length) { out.push('Responsabilidades:'); for (const r of resp) out.push(`- ${r}`); }
  out.push('', 'Reglas del nombre:');
  out.push(`- Entre ${AGENT_NAME_LIMITS.min} y ${AGENT_NAME_LIMITS.max} caracteres, solo letras (puede llevar acentos y espacios); sin números ni símbolos.`);
  out.push('- No uses tu puesto ni el de otro agente como nombre.');
  if (taken.length) out.push(`- Ya están usados (no los repitas, aunque cambien mayúsculas o acentos): ${taken.join(', ')}.`);
  if (roles.length) out.push(`- Puestos de la empresa: ${roles.join(', ')}.`);
  if (rejected.length) out.push(`- El propietario ya descartó: ${rejected.join(', ')}. Propón uno distinto.`);
  out.push('', 'Da un motivo breve (una frase) que relacione el nombre con tu papel.');
  out.push('Responde SOLO con JSON válido, sin texto alrededor: {"name": "<tu nombre>", "reason": "<motivo breve>"}');
  return out.join('\n');
}

export interface NameProposal { name: string; reason: string }
const tidyName = (s: string) => cleanAgentName(s.replace(/[«»"“”*_`]/g, '')).replace(/^'+|'+$/g, '').replace(/[.,;:!¡?¿]+$/, '').trim();
const tidyReason = (s: unknown) => typeof s === 'string' ? clean(s).slice(0, 240) : '';

/** Lee la propuesta: el JSON {name, reason} (también dentro de un bloque de código) o líneas «Nombre: … / Motivo: …». */
export function parseNameProposal(text: string | null | undefined): NameProposal | null {
  const t = (text ?? '').replace(/```(?:json)?/gi, '').trim();
  if (!t) return null;
  const fromObj = (s: string): NameProposal | null => {
    try {
      const o = JSON.parse(s) as unknown;
      if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
      const r = o as Record<string, unknown>;
      const n = typeof r.name === 'string' ? r.name : typeof r.nombre === 'string' ? r.nombre : '';
      const name = tidyName(n);
      return name ? { name, reason: tidyReason(r.reason ?? r.motivo ?? r.razon ?? r['razón']) } : null;
    } catch { return null; }
  };
  const whole = fromObj(t); if (whole) return whole;
  for (const m of t.match(/\{[\s\S]*?\}/g) ?? []) { const p = fromObj(m); if (p) return p; }
  const nm = t.match(/(?:^|\n)\s*[-*_]*\s*(?:nombre|name)\s*[*_]*\s*[:：]\s*(.+)/i);
  if (!nm) return null;
  const name = tidyName(nm[1] ?? ''); if (!name) return null;
  const rm = t.match(/(?:^|\n)\s*[-*_]*\s*(?:motivo|raz[oó]n|reason|porque)\s*[*_]*\s*[:：]\s*(.+)/i);
  return { name, reason: tidyReason(rm?.[1] ?? '') };
}

export function buildDefaultInstructions(input: DefaultInstructionsInput): string {
  const name = clean(input.name) || 'Agente';
  const role = clean(input.role);
  const spec = clean(input.specialization);
  const resp = (input.responsibilities ?? []).map(clean).filter(Boolean);
  const reportsTo = clean(input.reportsTo) || 'el propietario';
  const caps = toolCapabilities(input.tools ?? []);
  const sandbox = caps.some(c => c.where.includes('sandbox'));

  const personal = cleanAgentName(input.personalName);
  const out: string[] = [personal ? `# ${personal} · ${name}` : `# ${name}`, ''];
  out.push('## Papel');
  if (personal) out.push(`Te llamas ${personal} y eres ${name}.`, '');
  const scope = input.contextScope ?? null;
  const company = clean(input.companyName) || 'la empresa';
  const projectName = clean(input.projectName) || clean(scope?.project?.name);
  const goals = (input.projectGoals ?? []).map(clean).filter(Boolean);
  if (!scope) out.push(role ? `${name} es ${role} en Portal IA.` : `${name} es un agente de Portal IA.`);
  else if (scope.company) out.push(role ? `${name} es ${role} en ${company}.` : `${name} es un agente de ${company}.`);
  else if (scope.project && projectName) out.push(role ? `${name} es ${role} en el proyecto ${projectName}.` : `${name} es un agente del proyecto ${projectName}.`);
  else out.push(role ? `${name} es ${role}.` : `${name} es un agente de propósito general.`);
  if (spec) out.push('', `Especialización: ${spec}`);
  if (scope?.company) {
    out.push('', '## Empresa', `Trabaja para ${company} y sigue sus reglas:`);
    out.push(`- La autoridad es el propietario de ${company}: sus decisiones prevalecen y, ante la duda, se le pregunta.`);
    out.push('- Nada con costo (llamadas pagadas, compras o servicios) sin la autorización explícita del propietario.');
    out.push('- Sigue las convenciones y el conocimiento aprobados de la empresa.');
  }
  if (scope?.project) {
    out.push('', '## Proyecto', `Se especializa en el proyecto ${projectName || '(sin nombre)'}.`);
    if (goals.length) { out.push('', 'Objetivos:'); for (const g of goals) out.push(`- ${g}`); }
    else out.push('', 'Objetivos: sin objetivos descritos todavía.');
  }
  if (scope?.general) {
    out.push('', '## En cualquier entorno');
    out.push('- Sirve también fuera del Portal: se adapta a lo que permita el entorno donde trabaje (herramientas, permisos y órdenes disponibles).');
    out.push('- Antes de actuar, averigua cómo se trabaja allí (p. ej. README, package.json o Makefile) y no da por hecho nada que el entorno no ofrezca.');
    out.push('- Si el entorno no le permite algo, lo dice y propone una alternativa; nunca simula resultados.');
  }
  out.push('');

  out.push('## Responsabilidades');
  if (resp.length) for (const r of resp) out.push(`- ${r}`);
  else out.push('- Sin responsabilidades descritas todavía: se definen en Configuración.');
  out.push('');

  out.push('## Reporta a');
  out.push(`Reporta a ${reportsTo}.`);
  out.push('');

  out.push('## Habilidades');
  if (caps.length) for (const c of caps) out.push(`- **${clean(c.label)}** (${clean(c.whereText)}): ${clean(c.description)}`);
  else out.push('- Sin herramientas concedidas: trabaja con lo que el Portal le entrega en el contexto de cada tarea.');
  const generalOnly = !!scope && scope.general && !scope.company && !scope.project;
  const env = clean(input.environmentNote) || (sandbox ? (generalOnly
    ? 'Para las verificaciones usa un entorno aislado (p. ej. Docker) si existe; no ejecuta código del proyecto sin que se lo autoricen.'
    : 'Trabaja en el sandbox del proyecto (Docker o WSL2) para las verificaciones; no ejecuta código del repositorio fuera de él.') : '');
  if (env) out.push('', `Entorno: ${env}`);
  out.push('');

  out.push('## Límites');
  out.push(`- ${INSTRUCTIONS_NO_GRANT}`);
  if (sandbox) out.push('- Las verificaciones (typecheck, pruebas y compilación) solo se ejecutan por el pipeline autorizado.');
  out.push('- No realiza ninguna acción con costo sin la autorización explícita del propietario.');
  out.push('- Si no puede comprobar algo, lo dice y no simula resultados.');
  out.push('');

  out.push(input.mark);
  return out.join('\n');
}

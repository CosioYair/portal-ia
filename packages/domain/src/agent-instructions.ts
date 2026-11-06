import { toolCapabilities } from './agent-skills.ts';
import type { AgentContextScope } from './types.ts';

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
  /** Marca de instrucciones por defecto (la última línea). */
  mark: string;
}

export const INSTRUCTIONS_NO_GRANT = 'Estas instrucciones no conceden permisos: las herramientas se conceden en Configuración.';

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export function buildDefaultInstructions(input: DefaultInstructionsInput): string {
  const name = clean(input.name) || 'Agente';
  const role = clean(input.role);
  const spec = clean(input.specialization);
  const resp = (input.responsibilities ?? []).map(clean).filter(Boolean);
  const reportsTo = clean(input.reportsTo) || 'el propietario';
  const caps = toolCapabilities(input.tools ?? []);
  const sandbox = caps.some(c => c.where.includes('sandbox'));

  const out: string[] = [`# ${name}`, ''];
  out.push('## Papel');
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

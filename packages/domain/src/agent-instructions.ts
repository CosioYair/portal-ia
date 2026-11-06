import { toolCapabilities } from './agent-skills.ts';

/**
 * AGENTS.md por defecto de un agente del Portal (EN-013). Función pura y determinista: sin IA, sin IO y sin fechas, para
 * que la huella de la carpeta sea estable mientras no cambien los datos del agente.
 *
 * - Sale de los datos reales del agente: papel, especialización, responsabilidades, a quién reporta y habilidades según
 *   sus herramientas concedidas (`toolCapabilities`).
 * - No concede permisos. Las herramientas y las habilidades base salen solo de lo concedido en Configuración.
 * - No lleva identificadores internos, rutas locales ni nada propio de un proyecto: el paquete portable lo admite tal cual.
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
  out.push(role ? `${name} es ${role} en Portal IA.` : `${name} es un agente de Portal IA.`);
  if (spec) out.push('', `Especialización: ${spec}`);
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
  const env = clean(input.environmentNote) || (sandbox ? 'Trabaja en el sandbox del proyecto (Docker o WSL2) para las verificaciones; no ejecuta código del repositorio fuera de él.' : '');
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

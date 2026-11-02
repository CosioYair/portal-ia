import type { ExecutionBackend } from './claude-code.ts';
import type { AgentConfig, ProviderId } from './types.ts';

/**
 * Arneses de ejecución (docs/arneses.md). Un arnés es CÓMO trabaja un agente (Claude Code, Codex, la API de un
 * proveedor…); no es su identidad. Lo que sigue describe lo que cada arnés hace DENTRO del Portal, tal como el Portal lo
 * lanza (modo restringido): no lo que el producto podría hacer por su cuenta. «parcial» siempre lleva su explicación.
 */
export type HarnessCapability = 'unattended' | 'structured_output' | 'progress' | 'read_project' | 'propose_changes' | 'run_commands' | 'web_research' | 'images' | 'session_continuation' | 'delegation' | 'cancellation' | 'usage_reporting';
export type CapabilityLevel = 'yes' | 'partial' | 'no';
export const HARNESS_CAPABILITY_LABELS: Record<HarnessCapability, string> = {
  unattended: 'Trabaja sin que estés delante',
  structured_output: 'Respuestas estructuradas (JSON validado)',
  progress: 'Progreso en directo',
  read_project: 'Lee archivos del proyecto (solo lectura)',
  propose_changes: 'Propone cambios de código (el Portal los aplica en un worktree aislado)',
  run_commands: 'Ejecuta órdenes por su cuenta',
  web_research: 'Investiga en la web',
  images: 'Imágenes en el encargo',
  session_continuation: 'Continúa una sesión anterior',
  delegation: 'Subagentes propios',
  cancellation: 'Se puede cancelar en curso',
  usage_reporting: 'Informa del uso consumido'
};

export interface HarnessDescriptor {
  id: ExecutionBackend;
  name: string;
  vendor: string;
  /** De quién son los modelos que puede usar (la cuenta que factura). */
  modelVendor: ProviderId;
  /** Cómo se paga: tu suscripción (sin cargo por llamada a la API), API facturable por uso, o no verificable. */
  billing: 'subscription' | 'api' | 'unverified';
  summary: string;
  capabilities: Record<HarnessCapability, { level: CapabilityLevel; note?: string }>;
}

const NO_CMDS = { level: 'no' as const, note: 'Las verificaciones (pruebas, build) las ejecuta el Portal en su sandbox Docker, no el arnés.' };
const NO_WEB = { level: 'no' as const, note: 'Desactivado en el modo restringido del Portal.' };
const NO_SESSION = { level: 'no' as const, note: 'Cada llamada es nueva: el Portal le pasa el contexto, la identidad y la memoria del agente.' };
const NO_SUBAGENTS = { level: 'no' as const, note: 'Coordina el Portal (equipos, departamentos, encargos), no el arnés.' };
const PROPOSES = { level: 'yes' as const, note: 'Entrega los cambios como texto; el Portal los valida y los aplica en un worktree aislado.' };

export const HARNESSES: HarnessDescriptor[] = [
  {
    id: 'claude-code', name: 'Claude Code', vendor: 'Anthropic', modelVendor: 'anthropic', billing: 'subscription',
    summary: 'Claude, con tu suscripción de Claude. Solo lee lo que el Portal le permite y nunca cambia nada por su cuenta.',
    capabilities: {
      unattended: { level: 'yes' }, structured_output: { level: 'yes' }, progress: { level: 'yes', note: 'Turnos y herramientas en directo.' },
      read_project: { level: 'yes', note: 'Con el puente de solo lectura del Portal (sin .env, claves, .git ni data/).' }, propose_changes: PROPOSES,
      run_commands: NO_CMDS, web_research: NO_WEB, images: { level: 'yes' }, session_continuation: NO_SESSION, delegation: NO_SUBAGENTS,
      cancellation: { level: 'yes' }, usage_reporting: { level: 'yes', note: 'Tokens e informes de límites de la suscripción.' }
    }
  },
  {
    id: 'claude-code-terminal', name: 'Claude Code (tu consola)', vendor: 'Anthropic', modelVendor: 'anthropic', billing: 'unverified',
    summary: 'Para usuarios avanzados: las tareas esperan a que las atiendas tú en tu propia consola de Claude Code. No trabaja solo.',
    capabilities: {
      unattended: { level: 'no', note: 'Solo avanza cuando la atiendes en tu consola.' }, structured_output: { level: 'partial', note: 'Depende de tu sesión.' }, progress: { level: 'partial', note: 'Lo que informe tu consola.' },
      read_project: { level: 'yes', note: 'Con el puente del Portal.' }, propose_changes: PROPOSES, run_commands: NO_CMDS, web_research: { level: 'partial', note: 'Lo que permita tu consola.' }, images: { level: 'no' },
      session_continuation: NO_SESSION, delegation: NO_SUBAGENTS, cancellation: { level: 'yes' }, usage_reporting: { level: 'no', note: 'El Portal no ve el uso de tu consola.' }
    }
  },
  {
    id: 'codex', name: 'Codex', vendor: 'OpenAI', modelVendor: 'openai', billing: 'subscription',
    summary: 'Codex de OpenAI, con tu cuenta de ChatGPT. El Portal le da solo lo que necesita cada tarea; no puede tocar tus archivos.',
    capabilities: {
      unattended: { level: 'yes' }, structured_output: { level: 'yes', note: 'Con --output-schema.' }, progress: { level: 'yes', note: 'Eventos JSONL de la CLI.' },
      read_project: { level: 'partial', note: 'Recibe del Portal el contexto y los archivos del encargo; no puede pedir más por su cuenta.' }, propose_changes: PROPOSES,
      run_commands: NO_CMDS, web_research: NO_WEB, images: { level: 'yes' }, session_continuation: NO_SESSION, delegation: NO_SUBAGENTS,
      cancellation: { level: 'yes' }, usage_reporting: { level: 'partial', note: 'Tokens por ejecución; Codex no expone el margen de tu plan.' }
    }
  },
  {
    id: 'api', name: 'API del proveedor', vendor: 'Anthropic u OpenAI', modelVendor: 'anthropic', billing: 'api',
    summary: 'Directamente con tu clave de API: se paga por uso, así que cada trabajo te pide un presupuesto.',
    capabilities: {
      unattended: { level: 'yes' }, structured_output: { level: 'yes' }, progress: { level: 'partial', note: 'Tokens recibidos en directo.' },
      read_project: { level: 'partial', note: 'Recibe del Portal el contexto y los archivos del encargo.' }, propose_changes: PROPOSES,
      run_commands: NO_CMDS, web_research: NO_WEB, images: { level: 'yes' }, session_continuation: NO_SESSION, delegation: NO_SUBAGENTS,
      cancellation: { level: 'yes' }, usage_reporting: { level: 'yes', note: 'Tokens y costo en USD.' }
    }
  }
];
export const harnessById = (id: ExecutionBackend | null | undefined) => HARNESSES.find(h => h.id === (id ?? 'api'))!;

/** Lo que el trabajo de un agente usa de su arnés (por sus capacidades y herramientas), para avisar antes de cambiarlo. */
export function agentHarnessNeeds(cfg: Pick<AgentConfig, 'capabilities' | 'tools'>): HarnessCapability[] {
  const caps = cfg.capabilities ?? []; const needs = new Set<HarnessCapability>(['unattended', 'cancellation']);
  if (cfg.tools?.read_repo || caps.some(c => ['implementar', 'revisar_calidad', 'consultar_arquitectura', 'revisar_seguridad', 'planificar'].includes(c))) needs.add('read_project');
  if (caps.includes('implementar')) needs.add('propose_changes');
  if (caps.some(c => ['planificar', 'revisar_calidad', 'evaluar_gauntlet'].includes(c))) needs.add('structured_output');
  if (cfg.tools?.web_search) needs.add('web_research');
  return Array.from(needs);
}

/** Qué gana y qué pierde un agente al pasar de un arnés a otro, frente a lo que su trabajo usa. */
export function harnessCompatibility(cfg: Pick<AgentConfig, 'capabilities' | 'tools'>, from: ExecutionBackend | null | undefined, to: ExecutionBackend) {
  const a = harnessById(from); const b = harnessById(to); const needs = agentHarnessNeeds(cfg);
  const rank = (l: CapabilityLevel) => l === 'yes' ? 2 : l === 'partial' ? 1 : 0;
  const keys = Object.keys(HARNESS_CAPABILITY_LABELS) as HarnessCapability[];
  const losses = keys.filter(k => rank(b.capabilities[k].level) < rank(a.capabilities[k].level)).map(k => ({ capability: k, label: HARNESS_CAPABILITY_LABELS[k], from: a.capabilities[k], to: b.capabilities[k], needed: needs.includes(k) }));
  const gains = keys.filter(k => rank(b.capabilities[k].level) > rank(a.capabilities[k].level)).map(k => ({ capability: k, label: HARNESS_CAPABILITY_LABELS[k], from: a.capabilities[k], to: b.capabilities[k], needed: needs.includes(k) }));
  const missing = needs.filter(k => b.capabilities[k].level === 'no').map(k => ({ capability: k, label: HARNESS_CAPABILITY_LABELS[k], note: b.capabilities[k].note ?? null }));
  const reduced = needs.filter(k => b.capabilities[k].level === 'partial').map(k => ({ capability: k, label: HARNESS_CAPABILITY_LABELS[k], note: b.capabilities[k].note ?? null }));
  return { needs, gains, losses, missing, reduced };
}

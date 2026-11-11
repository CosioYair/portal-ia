/**
 * EN-021 · Sello Portal IA: único lugar con el texto del sello que el Portal añade a TODOS sus agentes al armar las
 * instrucciones de cada llamada (sin tocar su AGENTS.md ni su hash). Puro: sin IO.
 *  - Línea 1: en cada llamada de cualquier agente (chat, pasos, QA, delegación, Asistente), sea cual sea su arnés.
 *  - Línea 2: solo en conversaciones con el propietario y solo en la primera respuesta de cada conversación.
 * Cada línea lleva su propia marca para comprobarla por separado: nunca se repite en una misma llamada.
 */
export const SEAL_L1_MARK = '[Sello Portal IA · 1]';
export const SEAL_L2_MARK = '[Sello Portal IA · 2]';
export const SEAL_NOTE = 'Lo añade el Portal a todos los agentes';
export const OWNER_NAME_MAX = 80;

export const SEAL_LINE_1 = `${SEAL_L1_MARK} Sello Portal IA: aplica las lecciones y la memoria verificada que recibes para mejorar tu trabajo y no repetir errores.`;

/** Normaliza «Tu nombre»: una sola línea, recortado y con tope; vacío → null. */
export function normalizeOwnerName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, OWNER_NAME_MAX).trim();
  return v ? v : null;
}

export function sealLine2(ownerName: string | null): string {
  const name = normalizeOwnerName(ownerName);
  return name
    ? `${SEAL_L2_MARK} En tu primera respuesta de esta conversación, preséntate (nombre y papel) y llama al propietario por su nombre: ${name}.`
    : `${SEAL_L2_MARK} En tu primera respuesta de esta conversación, preséntate (nombre y papel) y pregúntale una sola vez cómo quiere que le llames; no deduzcas su nombre del correo ni de otra fuente.`;
}

export interface SealOptions {
  /** Conversación con el propietario (chat de un agente o Asistente). Por defecto false: pasos estructurados. */
  owner?: boolean;
  /** Primera respuesta de esa conversación. */
  firstReply?: boolean;
  ownerName?: string | null;
}

/** Líneas del sello que corresponden a una llamada (para la vista previa en solo lectura del panel del agente). */
export function sealLines(opts: SealOptions = {}): string[] {
  const out = [SEAL_LINE_1];
  if (opts.owner === true && opts.firstReply === true) out.push(sealLine2(opts.ownerName ?? null));
  return out;
}

/**
 * Añade el sello al system de una llamada: la línea 1 si falta su marca; la línea 2 solo con owner y firstReply y si
 * falta su marca. Idempotente: un system ya sellado (reintentos, llamadas encadenadas) no se repite.
 */
export function withSeal(system: string, opts: SealOptions = {}): string {
  const base = system ?? '';
  const add: string[] = [];
  if (!base.includes(SEAL_L1_MARK)) add.push(SEAL_LINE_1);
  if (opts.owner === true && opts.firstReply === true && !base.includes(SEAL_L2_MARK)) add.push(sealLine2(opts.ownerName ?? null));
  if (!add.length) return base;
  const block = add.join('\n');
  return base.trim() ? `${base.replace(/\s+$/, '')}\n\n${block}` : block;
}

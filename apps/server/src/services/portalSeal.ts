import { normalizeOwnerName, withSeal } from '@portal-ia/domain';
import { settingsRepo } from '../db/platform.ts';

/**
 * EN-021 · Sello Portal IA en el servidor. El texto vive solo en @portal-ia/domain (portal-seal.ts).
 * «Tu nombre» es un ajuste de la instalación (no por empresa), vacío por defecto. El nombre del propietario se toma
 * SOLO de este ajuste: nunca del correo ni de otra fuente.
 */
export const OWNER_NAME_KEY = 'owner.displayName';

export function ownerDisplayName(): string | null {
  try { return normalizeOwnerName(settingsRepo.get(OWNER_NAME_KEY)); } catch { return null; }
}

/** Guarda «Tu nombre» (recortado; vacío lo borra). Devuelve el valor efectivo. */
export function saveOwnerDisplayName(raw: string | null | undefined): string | null {
  const name = normalizeOwnerName(raw);
  settingsRepo.set(OWNER_NAME_KEY, name ?? '');
  return name;
}

/** Pasos sin conversación con el propietario (plan, diff, JSON, QA, Gauntlet, delegación): solo la línea 1. */
export function sealForStep(system: string): string {
  return withSeal(system, { owner: false });
}

/** Conversación con el propietario (chat de agente, Asistente): línea 1 siempre; línea 2 solo en la primera respuesta. */
export function sealForOwner(system: string, firstReply: boolean): string {
  return withSeal(system, { owner: true, firstReply, ownerName: firstReply ? ownerDisplayName() : null });
}

/**
 * HU-214 · Módulo «Ediciones»: copias distribuibles del Portal generadas desde el Estudio y su licencia local.
 * Dominio puro (sin IO): tipos, transiciones permitidas y textos en español.
 * Licencia mínima (DECISIÓN 2 supuesta): identificador, estado, emisión, caducidad y número de renovaciones; sin servidor de licencias.
 * Revocar es definitivo: una edición revocada no se reactiva ni se renueva.
 */

export type EditionLicenseStatus = 'active' | 'inactive' | 'revoked';
export type EditionAction = 'generate' | 'renew' | 'activate' | 'deactivate' | 'revoke';

export const EDITION_ACTIONS: readonly EditionAction[] = ['generate', 'renew', 'activate', 'deactivate', 'revoke'];

/** Días de validez de una licencia nueva y de cada renovación. */
export const EDITION_LICENSE_DAYS = 365;

export interface EditionRecord {
  id: string;
  version: string;
  commit: string;
  sha256: string;
  /** Solo el nombre del zip (nunca la ruta absoluta del host). */
  zipName: string;
  entries: number;
  bytes: number;
  createdAt: string;
}

export interface EditionLicense {
  id: string;
  status: EditionLicenseStatus;
  issuedAt: string;
  expiresAt: string;
  renewals: number;
}

export interface EditionView extends EditionRecord {
  license: EditionLicense;
  updatedAt: string;
}

/**
 * ¿Se puede aplicar `action` a una edición en estado `status`? `null` = la edición aún no existe (solo se puede generar).
 * Revocada es definitivo.
 */
export function canTransition(status: EditionLicenseStatus | null, action: EditionAction): boolean {
  if (action === 'generate') return status === null;
  if (status === null || status === 'revoked') return false;
  switch (action) {
    case 'renew': return true;
    case 'activate': return status === 'inactive';
    case 'deactivate': return status === 'active';
    case 'revoke': return true;
  }
}

/** Estado tras aplicar la acción (supone que `canTransition` la permitió). */
export function nextLicenseStatus(status: EditionLicenseStatus, action: Exclude<EditionAction, 'generate'>): EditionLicenseStatus {
  if (action === 'activate') return 'active';
  if (action === 'deactivate') return 'inactive';
  if (action === 'revoke') return 'revoked';
  return status;
}

/** Nueva caducidad al renovar: suma los días a partir de la caducidad vigente o de ahora si ya caducó. */
export function renewedExpiry(expiresAt: string, now: Date, days = EDITION_LICENSE_DAYS): string {
  const base = Math.max(Date.parse(expiresAt) || 0, now.getTime());
  return new Date(base + days * 86_400_000).toISOString();
}

export function isLicenseExpired(license: Pick<EditionLicense, 'expiresAt'>, now: Date): boolean {
  const t = Date.parse(license.expiresAt);
  return Number.isFinite(t) && t <= now.getTime();
}

export const EDITION_STATUS_LABEL: Record<EditionLicenseStatus, string> = {
  active: 'Activa',
  inactive: 'Desactivada',
  revoked: 'Revocada'
};

export const EDITION_ACTION_LABEL: Record<EditionAction, string> = {
  generate: 'Generar edición',
  renew: 'Renovar licencia',
  activate: 'Activar',
  deactivate: 'Desactivar',
  revoke: 'Revocar'
};

/** Qué hará cada acción, para el diálogo de autorización del propietario. */
export const EDITION_ACTION_EFFECT: Record<EditionAction, string> = {
  generate: 'Genera un ZIP de la edición distribuible desde el commit actual (árbol limpio y build del mismo commit) y le emite una licencia activa.',
  renew: `Amplía la caducidad de la licencia ${EDITION_LICENSE_DAYS} días.`,
  activate: 'Vuelve a activar la licencia de esta edición.',
  deactivate: 'Desactiva la licencia; se puede volver a activar más tarde.',
  revoke: 'Revoca la licencia para siempre: no se podrá reactivar ni renovar.'
};

export function editionTransitionError(status: EditionLicenseStatus | null, action: EditionAction): string {
  if (status === 'revoked') return 'La edición está revocada: la revocación es definitiva y no admite más acciones.';
  if (status === null) return 'La edición no existe.';
  return `No se puede «${EDITION_ACTION_LABEL[action]}» una edición en estado «${EDITION_STATUS_LABEL[status]}».`;
}

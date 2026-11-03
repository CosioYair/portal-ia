/**
 * Revisiones del proyecto ejecutándose en ESTE proceso del servidor (projectMaintenance.ts). Módulo aparte y sin
 * dependencias para que «Reconstruir y reiniciar» (system.ts) las vea sin importar el servicio entero.
 */
export const runningPlans = new Map<string, { slug: string; title: string }>();

/**
 * Procesos cuya ejecución vive en ESTE servidor. Un proceso «running» que no está aquí quedó huérfano (el servidor se
 * reinició o cayó a mitad): nadie leerá su marca de cancelación, así que cancelarlo debe cerrarlo directamente.
 */
const activeJobs = new Set<string>();
export function trackJob<T>(id: string, run: Promise<T>): Promise<T> { activeJobs.add(id); return run.finally(() => activeJobs.delete(id)); }
export const isActiveJob = (id: string) => activeJobs.has(id);

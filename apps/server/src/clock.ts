/**
 * Reloj monótono del servidor para las marcas de tiempo que se guardan y se comparan u ordenan (creación de procesos,
 * pasos, iteraciones, eventos, «aplicado»): nunca retrocede ni repite dentro del proceso. Medido el 30-10-2026: en la VM
 * de Docker (el sandbox donde el Portal verifica sus propias historias) el reloj de pared retrocede entre 0,8 y 1,4 s
 * varias veces por minuto bajo carga; ordenar «lo más reciente» por esa hora daba resultados equivocados.
 */
let last = 0;
export function monotonicNow(): string {
  const t = Math.max(Date.now(), last + 1);
  last = t;
  return new Date(t).toISOString();
}

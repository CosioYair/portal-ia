/**
 * Datos reales de una revisión preparada en un turno del Asistente (operación con plan): el modelo escribe ANTES de que el
 * Portal la calcule, así que debajo de su respuesta van las cifras de la vista previa (sin IA) y cómo seguir exactamente.
 * Es una foto del momento en que se preparó: el estado vivo está en la tarjeta. Por eso no vuelve al modelo ni a los
 * agentes del equipo en el historial (ahí cuenta la tarjeta, con su estado real), donde contradiría un resultado posterior.
 */
export const REVIEW_FACTS_HEADING = '### Datos reales de la revisión';
/** Aviso de una revisión que ya estaba pendiente (tampoco vuelve al historial: la tarjeta tiene el estado vivo). */
export const REVIEW_PENDING_POINTER = '**Cómo seguir:** la revisión ya está pendiente en su tarjeta, más arriba: pulsa «Abrir la revisión para elegir y autorizar».';

/** Líneas de la vista previa que son cifras (no el repositorio ni la advertencia final). */
export const factLines = (details: string[]) => details.filter(d => !/^(Repositorio:|Nada se ejecuta)/.test(d));

export function reviewFactsBlock(projectName: string, details: string[], at = new Date()): string {
  const facts = factLines(details);
  const hhmm = at.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const nothing = facts.some(d => /^Ya integrado — seguro: nada$/.test(d)) && facts.some(d => /^Requiere tu decisión: nada$/.test(d));
  const remoteChecked = facts.some(d => /^Remoto: (.*comprobado en vivo\)|El repositorio no tiene remoto configurado\.)$/.test(d)); // sin remoto, no hay nada que comprobar
  const next = nothing && !remoteChecked
    ? '**Nada que limpiar en lo que se pudo comprobar.** El remoto no se pudo comprobar: vuelve a revisar más tarde para ver sus ramas.'
    : nothing
    ? '**No hay nada que limpiar ahora:** todo está al día o protegido.'
    : '**Cómo seguir** (mientras esté pendiente): en la tarjeta, pulsa «Abrir la revisión para elegir y autorizar». Lo seguro viene marcado y lo demás en «Conservar»; cambia lo que quieras objetivo a objetivo y autoriza una sola vez lo elegido. Solo cerrar o cancelar historias o cerrar un lote te pide motivo. Lo protegido (main, lo que está en uso o lo que protege un lote abierto) no se puede elegir.';
  return `${REVIEW_FACTS_HEADING} (al prepararla, ${hhmm})\n\nCalculados por el Portal para «${projectName}», sin IA. En ese momento no se había ejecutado nada; el estado actual está en la tarjeta.\n\n${facts.map(d => `- ${d}`).join('\n')}\n\n${next}`;
}

/** El mensaje sin la foto de la revisión (para el historial del modelo y de los agentes del equipo). */
export function withoutReviewFacts(content: string): string {
  const at = [`\n\n${REVIEW_FACTS_HEADING}`, `\n\n${REVIEW_PENDING_POINTER}`].map(m => content.indexOf(m)).filter(i => i >= 0);
  return at.length ? content.slice(0, Math.min(...at)) : content;
}

import type { MaintenanceItem } from '@portal-ia/domain';

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
export const factLines = (details: string[]) => details.filter(d => !/^(Repositorio:|Nada se ejecuta|Cierre de etapa:)/.test(d));

// Lo que viene del repositorio o lo escribió alguien (ramas, títulos, carpetas) va como código: el chat no tiene escapes y
// «_x_» o «**x**» en un nombre se convertirían en formato.
const code = (t: string) => `\`${t.replace(/`/g, "'").replace(/\s+/g, ' ').trim()}\``;
const shortName = (i: MaintenanceItem) => i.kind === 'story' && i.story?.storyId ? i.story.storyId : i.kind === 'batch' ? `lote ${code(i.name)}` : code(i.name);
const names = (l: MaintenanceItem[], max = 10) => `${l.slice(0, max).map(shortName).join(', ')}${l.length > max ? ` y ${l.length - max} más` : ''}`;
const groupBy = <K extends string>(l: MaintenanceItem[], key: (i: MaintenanceItem) => K) => { const m = new Map<K, MaintenanceItem[]>(); for (const i of l) m.set(key(i), [...(m.get(key(i)) ?? []), i]); return [...m.entries()]; };
/** El motivo hasta su primer «: » o «. » FUERA de «…» (un título con «: » no lo corta), con lo citado como código. */
export function reasonHead(reason: string): string {
  let depth = 0; let end = reason.length;
  for (let i = 0; i < reason.length; i++) {
    const c = reason[i];
    if (c === '«') depth++; else if (c === '»') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ':' || c === '.') && reason[i + 1] === ' ') { end = i; break; }
  }
  return reason.slice(0, end).replace(/\.$/, '').replace(/«([^»]*)»/g, (_m, t: string) => `«${code(t)}»`);
}

/**
 * Qué propone la revisión objetivo a objetivo, con las opciones que de verdad ofrece cada uno (no lo que el modelo suponga):
 * lo que requiere decisión agrupado por sus opciones, y lo protegido agrupado por su motivo.
 */
export function proposalLines(items: MaintenanceItem[], prepared: Map<string, string> | null = null): string[] {
  const out: string[] = [];
  const decision = items.filter(i => i.category === 'decision');
  if (decision.length) {
    out.push(prepared ? '**Requiere tu decisión** (en este cierre de etapa viene elegido lo marcado «→ elegido»; lo demás, en «Conservar»):' : '**Requiere tu decisión** (todo empieza en «Conservar»):');
    // Agrupado por opciones y, en un cierre preparado, por lo que viene elegido (así nunca se dice «empieza en Conservar» de algo elegido).
    const pick = (i: MaintenanceItem) => { const o = prepared?.get(i.id); return o ? i.options.find(x => x.id === o)?.label ?? o : null; };
    for (const [key, l] of groupBy(decision, i => `${i.options.filter(o => o.id !== 'keep').map(o => o.label).join(' o ') || `solo conservar|${reasonHead(i.reason)}`}§${pick(i) ?? ''}`)) {
      const [opts, chosen] = key.split('§');
      out.push(`- ${names(l)} → ${opts.startsWith('solo conservar|') ? `solo se puede conservar (${opts.slice('solo conservar|'.length)})` : `conservar o ${opts.toLowerCase()}`}${chosen ? ` → elegido: ${chosen.toLowerCase()}` : ''}`);
    }
  }
  const prot = items.filter(i => i.category === 'protected');
  if (prot.length) {
    out.push('**Protegido** (no se puede elegir):');
    for (const [why, l] of groupBy(prot, i => reasonHead(i.reason))) out.push(`- ${why}: ${names(l)}`);
  }
  return out;
}

export function reviewFactsBlock(projectName: string, details: string[], at = new Date(), items: MaintenanceItem[] = [], stage: { reason: string; prepared: number; source?: 'owner' | 'assistant'; selection?: { itemId: string; option: string }[] } | null = null): string {
  const facts = factLines(details);
  const proposal = proposalLines(items, stage?.selection ? new Map(stage.selection.map(x => [x.itemId, x.option])) : null);
  const hhmm = at.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  // Las decisiones que de verdad vienen elegidas en este cierre (no ejemplos fijos).
  const opts = new Set((stage?.selection ?? []).map(x => x.option));
  const stageKinds = [opts.has('discard') && 'cancelar historias', opts.has('cancel_assignment') && 'cancelar encargos', (opts.has('archive_delete_local') || opts.has('archive_delete_remote')) && 'guardar copia y borrar ramas con trabajo sin integrar', opts.has('discard_iteration') && 'descartar iteraciones', opts.has('close_batch') && 'cerrar el lote'].filter(Boolean) as string[];
  const nothing = facts.some(d => /^Ya integrado — seguro: nada$/.test(d)) && facts.some(d => /^Requiere tu decisión: nada$/.test(d));
  const remoteChecked = facts.some(d => /^Remoto: (.*comprobado en vivo\)|El repositorio no tiene remoto configurado\.)$/.test(d)); // sin remoto, no hay nada que comprobar
  const next = nothing && !remoteChecked
    ? '**Nada que limpiar en lo que se pudo comprobar.** El remoto no se pudo comprobar: vuelve a revisar más tarde para ver sus ramas.'
    : nothing
    ? '**No hay nada que limpiar ahora:** todo está al día o protegido.'
    : stage ? `**Cómo seguir** (mientras esté pendiente): en la tarjeta, pulsa «Abrir la revisión para elegir y autorizar». Vienen elegidas las acciones del cierre${stageKinds.length ? `, también las que requieren decisión (${stageKinds.join(', ')})` : ''}; cambia lo que quieras y autoriza una sola vez. Lo protegido no se puede elegir.`
    : '**Cómo seguir** (mientras esté pendiente): en la tarjeta, pulsa «Abrir la revisión para elegir y autorizar». Lo seguro viene marcado y lo demás en «Conservar»; cambia lo que quieras objetivo a objetivo y autoriza una sola vez lo elegido. Solo cerrar o cancelar historias o cerrar un lote te pide motivo. Lo protegido (main, lo que está en uso o lo que protege un lote abierto) no se puede elegir.';
  // Cada título en su párrafo y su lista debajo (el chat solo reconoce una lista tras una línea en blanco).
  const stageLine = stage ? `\n\n**Cierre de etapa preparado:** vienen elegidas ${stage.prepared} acción(es) con el motivo ${stage.source === 'assistant' ? 'que propone el Asistente (revísalo: al autorizar queda como tuyo)' : 'que diste'}: ${code(stage.reason)}. Lo que tiene cambios sin guardar y lo protegido no se eligen. Nada se ejecuta hasta que marques la autorización y pulses «Ejecutar lo elegido».` : '';
  const detail = proposal.length ? `\n${proposal.map(l => l.startsWith('**') ? `\n${l}\n` : l).join('\n')}` : '';
  return `${REVIEW_FACTS_HEADING} (al prepararla, ${hhmm})\n\nCalculados por el Portal para «${projectName}», sin IA. En ese momento no se había ejecutado nada; el estado actual está en la tarjeta.\n\n${facts.map(d => `- ${d}`).join('\n')}${detail}${stageLine}\n\n${next}`;
}

/** El mensaje sin la foto de la revisión (para el historial del modelo y de los agentes del equipo). */
export function withoutReviewFacts(content: string): string {
  const at = [`\n\n${REVIEW_FACTS_HEADING}`, `\n\n${REVIEW_PENDING_POINTER}`].map(m => content.indexOf(m)).filter(i => i >= 0);
  return at.length ? content.slice(0, Math.min(...at)) : content;
}

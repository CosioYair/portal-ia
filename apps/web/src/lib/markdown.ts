/**
 * Análisis del Markdown mínimo del Portal (títulos, listas, tablas, bloques de código y párrafos), separado del
 * renderizado para poder probarlo. GARANTÍA: cada vuelta consume al menos una línea, así que nunca se queda en un
 * bucle (antes, un título con un \r suelto o un separador Unicode congelaba la pestaña entera; incidente HU-155).
 */
export type MdBlock =
  | { kind: 'code'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'para'; lines: string[] };

const LIST = /^\s*([-*•]|\d+[.)])\s+/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const NOT_PARA = /^(#{1,4}\s|```|\||\s*([-*•]|\d+[.)])\s)/;

export function parseMarkdown(text: string): MdBlock[] {
  // Todos los finales de línea a \n: \r\n, \r suelto y los separadores Unicode (que «.» de una expresión no cruza).
  const lines = text.replace(/\r\n?|[\u2028\u2029]/g, '\n').split('\n');
  const blocks: MdBlock[] = []; let i = 0;
  while (i < lines.length) {
    const start = i; const l = lines[i];
    if (l.startsWith('```')) {
      const buf: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++; blocks.push({ kind: 'code', text: buf.join('\n') });
    } else if (HEADING.test(l)) {
      const h = l.match(HEADING)!; blocks.push({ kind: 'heading', level: h[1].length, text: h[2] }); i++;
    } else if (LIST.test(l)) {
      const items: string[] = [];
      while (i < lines.length && LIST.test(lines[i])) items.push(lines[i++].replace(LIST, ''));
      blocks.push({ kind: 'list', ordered: /^\s*\d/.test(l), items });
    } else if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) { const cells = lines[i].split('|').slice(1, -1).map(c => c.trim()); if (!cells.every(c => /^:?-{2,}:?$/.test(c))) rows.push(cells); i++; }
      blocks.push({ kind: 'table', rows });
    } else if (!l.trim()) {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && (i === start || !NOT_PARA.test(lines[i]))) para.push(lines[i++]);
      blocks.push({ kind: 'para', lines: para });
    }
    if (i === start) { blocks.push({ kind: 'para', lines: [l] }); i++; } // red de seguridad: nunca sin avanzar
  }
  return blocks;
}

/** Fragmentos en línea: **negrita**, `código`, _cursiva_ (cada vuelta avanza al menos un carácter). */
export type MdInline = { kind: 'text' | 'strong' | 'code' | 'em'; text: string };
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = []; let rest = text;
  const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/;
  while (rest.length) {
    const m = rest.match(re); if (!m || m.index === undefined) { out.push({ kind: 'text', text: rest }); break; }
    if (m.index > 0) out.push({ kind: 'text', text: rest.slice(0, m.index) });
    const tok = m[0];
    out.push(tok.startsWith('**') ? { kind: 'strong', text: tok.slice(2, -2) } : tok.startsWith('`') ? { kind: 'code', text: tok.slice(1, -1) } : { kind: 'em', text: tok.slice(1, -1) });
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

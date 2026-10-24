import { Fragment, type ReactNode } from 'react';

/** Renderizador Markdown mínimo y seguro (sin HTML crudo): títulos, listas, negrita, código, tablas simples, bloques de código. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []; let rest = text; let k = 0;
  const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/;
  while (rest.length) {
    const m = rest.match(re); if (!m || m.index === undefined) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k++} className="mono" style={{ background: '#F4F3EF', padding: '1px 5px', borderRadius: 4, fontSize: '0.92em' }}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = []; let i = 0; let k = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) { const buf: string[] = []; i++; while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]); i++;
      blocks.push(<pre key={k++} className="mono" style={{ background: '#1A1B1E', color: '#F4F3EF', padding: '12px 14px', borderRadius: 8, fontSize: 12, overflow: 'auto', margin: '4px 0 12px', lineHeight: 1.5 }}>{buf.join('\n')}</pre>); continue; }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const lvl = h[1].length; blocks.push(<div key={k++} className={lvl <= 2 ? 'h3' : 'sm13'} style={{ fontWeight: 600, marginTop: lvl <= 2 ? 20 : 14, marginBottom: 8, fontSize: lvl === 1 ? 17 : lvl === 2 ? 15 : 13.5, paddingBottom: lvl <= 2 ? 4 : 0, borderBottom: lvl <= 2 ? '1px solid #EEECE6' : 'none' }}>{inline(h[2])}</div>); i++; continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) { const items: string[] = []; while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      const ordered = /^\s*\d/.test(l);
      blocks.push(ordered ? <ol key={k++} style={{ margin: '0 0 12px', paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 8, lineHeight: 1.55 }}>{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>
        : <ul key={k++} style={{ margin: '0 0 12px', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8, lineHeight: 1.55 }}>{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>); continue; }
    if (l.startsWith('|')) { const rows: string[][] = []; while (i < lines.length && lines[i].startsWith('|')) { const cells = lines[i].split('|').slice(1, -1).map(c => c.trim()); if (!cells.every(c => /^:?-{2,}:?$/.test(c))) rows.push(cells); i++; }
      blocks.push(<div key={k++} style={{ overflowX: 'auto', margin: '8px 0' }}><table className="tbl"><thead><tr>{rows[0]?.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead><tbody>{rows.slice(1).map((r, j) => <tr key={j}>{r.map((c, x) => <td key={x}>{inline(c)}</td>)}</tr>)}</tbody></table></div>); continue; }
    if (!l.trim()) { i++; continue; }
    const para: string[] = []; while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\||\s*([-*•]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k++} style={{ margin: '0 0 10px', lineHeight: 1.6 }}>{para.map((t, j) => <Fragment key={j}>{inline(t)}{j < para.length - 1 ? ' ' : ''}</Fragment>)}</p>);
  }
  return <div className="md" style={{ fontSize: 14, color: '#1A1B1E' }}>{blocks}</div>;
}

import { Fragment, type ReactNode } from 'react';
import { parseInline, parseMarkdown } from '../lib/markdown.ts';

/** Renderizador Markdown mínimo y seguro (sin HTML crudo): títulos, listas, negrita, código, tablas simples, bloques de código. */
function inline(text: string): ReactNode[] {
  return parseInline(text).map((t, k) => t.kind === 'strong' ? <strong key={k}>{t.text}</strong>
    : t.kind === 'code' ? <code key={k} className="mono" style={{ background: '#F4F3EF', padding: '1px 5px', borderRadius: 4, fontSize: '0.92em' }}>{t.text}</code>
    : t.kind === 'em' ? <em key={k}>{t.text}</em> : <Fragment key={k}>{t.text}</Fragment>);
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text).map((b, k) => {
    if (b.kind === 'code') return <pre key={k} className="mono" style={{ background: '#1A1B1E', color: '#F4F3EF', padding: '12px 14px', borderRadius: 8, fontSize: 12, overflow: 'auto', margin: '4px 0 12px', lineHeight: 1.5 }}>{b.text}</pre>;
    if (b.kind === 'heading') { const lvl = b.level; return <div key={k} className={lvl <= 2 ? 'h3' : 'sm13'} style={{ fontWeight: 600, marginTop: lvl <= 2 ? 20 : 14, marginBottom: 8, fontSize: lvl === 1 ? 17 : lvl === 2 ? 15 : 13.5, paddingBottom: lvl <= 2 ? 4 : 0, borderBottom: lvl <= 2 ? '1px solid #EEECE6' : 'none' }}>{inline(b.text)}</div>; }
    if (b.kind === 'list') return b.ordered
      ? <ol key={k} style={{ margin: '0 0 12px', paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 8, lineHeight: 1.55 }}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>
      : <ul key={k} style={{ margin: '0 0 12px', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8, lineHeight: 1.55 }}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>;
    if (b.kind === 'table') return <div key={k} style={{ overflowX: 'auto', margin: '8px 0' }}><table className="tbl"><thead><tr>{b.rows[0]?.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead><tbody>{b.rows.slice(1).map((r, j) => <tr key={j}>{r.map((c, x) => <td key={x}>{inline(c)}</td>)}</tr>)}</tbody></table></div>;
    return <p key={k} style={{ margin: '0 0 10px', lineHeight: 1.6 }}>{b.lines.map((t, j) => <Fragment key={j}>{inline(t)}{j < b.lines.length - 1 ? ' ' : ''}</Fragment>)}</p>;
  });
  return <div className="md" style={{ fontSize: 14, color: '#1A1B1E' }}>{blocks}</div>;
}

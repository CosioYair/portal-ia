import { useEffect, useMemo, useState } from 'react';
import type { KnowledgeDoc } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, Empty, Icon } from '../components/ui.tsx';
import { EmptyState, PageHeader } from '../components/kit.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { LessonsPanel } from '../components/LessonsPanel.tsx';
import { authorsOf, filterGroups, groupByTitle, groupOf, KIND_LABELS, kindsOf } from '../lib/knowledgeIndex.ts';
import type { KnowledgeKind } from '../lib/knowledgeIndex.ts';

const fmtShort = (iso: string) => new Date(iso).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });

export function Knowledge() {
  const { status } = useApp();
  const slug = status.workspace!.slug; const projectId = status.project!.id;
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<'docs' | 'lessons'>(() => location.hash === '#lecciones' ? 'lessons' : 'docs');
  // La pestaña (#lecciones) y el documento abierto (?doc=) viven en la URL: recargar o Atrás/Adelante los conservan.
  const syncUrl = (t: 'docs' | 'lessons', docId: string | null) => {
    const q = new URLSearchParams(location.search); if (docId) q.set('doc', docId); else q.delete('doc'); const qs = q.toString();
    window.history.replaceState(window.history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${t === 'lessons' ? '#lecciones' : ''}`);
  };
  const openTab = (t: 'docs' | 'lessons') => { setTab(t); syncUrl(t, sel); };
  const openDoc = (id: string) => { setSel(id); syncUrl(tab, id); };
  useEffect(() => { api.knowledge(slug, projectId).then(d => { const want = new URLSearchParams(location.search).get('doc'); setDocs(d); setSel(d.some(x => x.id === want) ? want : groupByTitle(d)[0]?.latest.id ?? null); }).catch(() => setDocs([])); }, [slug, projectId]);
  // HU-171 · Búsqueda y filtros: estado de la pantalla (no se persiste). Autor y tipo se aplican a la versión más reciente.
  const [text, setText] = useState('');
  const [author, setAuthor] = useState('');
  const [kind, setKind] = useState<KnowledgeKind | ''>('');
  const groups = useMemo(() => groupByTitle(docs ?? []), [docs]);
  const visibles = useMemo(() => filterGroups(groups, { q: text, author, kind }), [groups, text, author, kind]);
  const authors = useMemo(() => authorsOf(groups), [groups]);
  const kinds = useMemo(() => kindsOf(groups), [groups]);
  const filtering = !!(text.trim() || author || kind);
  const clearFilters = () => { setText(''); setAuthor(''); setKind(''); };
  // Si el documento abierto queda fuera del filtro, se abre el primero visible (y ?doc= se actualiza).
  useEffect(() => {
    if (!docs || visibles.length === 0) return;
    if (!visibles.some(g => g.latest.id === sel || g.older.some(o => o.id === sel))) openDoc(visibles[0]!.latest.id);
  }, [visibles]); // eslint-disable-line react-hooks/exhaustive-deps
  const doc = docs?.find(d => d.id === sel) ?? null;
  const group = groupOf(groups, sel);
  const versions = group ? [group.latest, ...group.older] : [];
  const pos = doc ? versions.findIndex(v => v.id === doc.id) : -1;
  const isOld = pos > 0;

  return (
    <Shell crumb="Conocimiento">
      <main style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div className="page" style={{ paddingBottom: 0 }}>
          <PageHeader icon={Icon.book()} tone="knowledge" eyebrow={`${status.project?.name ?? 'Proyecto'} · Conocimiento`} title="Conocimiento"
            description="Documentos que analizan y deciden los agentes, y lecciones que se proponen, validan y reutilizan.">
            <div className="section-tabs" role="group" aria-label="Vistas del conocimiento">
              <button type="button" className={`section-tab${tab === 'docs' ? ' is-active' : ''}`} aria-pressed={tab === 'docs'} onClick={() => openTab('docs')}>Documentos</button>
              <button type="button" className={`section-tab${tab === 'lessons' ? ' is-active' : ''}`} aria-pressed={tab === 'lessons'} onClick={() => openTab('lessons')}>Lecciones de la organización</button>
            </div>
          </PageHeader>
        </div>
        {tab === 'lessons' && <div className="page" style={{ maxWidth: 'none' }}><LessonsPanel projectId={projectId} /></div>}
        {tab === 'docs' && <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', flex: 1 }}>
        <aside style={{ flex: '1 1 280px', maxWidth: 340, borderRight: '1px solid var(--color-border)', padding: '16px 12px 24px', background: 'var(--color-surface-alt)', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="side-sec">Documentos del proyecto</div>
          {docs && docs.length === 0 && <EmptyState art="books" title="Sin documentos">Los agentes guardarán aquí sus análisis y decisiones cuando ejecuten procesos autorizados.</EmptyState>}
          {docs && docs.length > 0 && <div className="kn-filters">
            <label className="sr-only" htmlFor="kn-q">Buscar en título y contenido</label>
            <input id="kn-q" className="input kn-input" type="search" placeholder="Buscar en título y contenido" value={text} onChange={e => setText(e.target.value)} />
            <div className="kn-selects">
              <label className="sr-only" htmlFor="kn-author">Autor</label>
              <select id="kn-author" className="input kn-input" value={author} onChange={e => setAuthor(e.target.value)}>
                <option value="">Autor: todos</option>
                {authors.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <label className="sr-only" htmlFor="kn-kind">Tipo</label>
              <select id="kn-kind" className="input kn-input" value={kind} onChange={e => setKind(e.target.value as KnowledgeKind | '')}>
                <option value="">Tipo: todos</option>
                {kinds.map(k => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </select>
            </div>
            <div className="kn-count small muted" aria-live="polite">
              <span>{visibles.length} de {groups.length} documentos</span>
              {filtering && <button type="button" className="lnk small" onClick={clearFilters}>Limpiar filtros</button>}
            </div>
          </div>}
          {docs && docs.length > 0 && visibles.length === 0 && <div className="kn-empty">
            <Empty icon={Icon.book()} title="Ningún documento coincide con la búsqueda" hint="Prueba con otras palabras o quita algún filtro." style={{ padding: '24px 8px 8px' }} />
            <button type="button" className="btn btn-secondary btn-sm" onClick={clearFilters}>Limpiar filtros</button>
          </div>}
          {visibles.map(g => { const active = g.latest.id === sel || g.older.some(o => o.id === sel); return <button key={g.key} className={`rail-i ${active ? 'is-active' : ''}`} onClick={() => openDoc(g.latest.id)} aria-pressed={active}>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2 }}><span style={{ fontWeight: 500, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.latest.title}</span><span className="small muted">{g.author} · {fmtShort(g.latest.createdAt)}</span>
              {g.older.length > 0 && <span className="kn-chip">+{g.older.length} {g.older.length === 1 ? 'versión anterior' : 'versiones anteriores'}</span>}</span></button>; })}
        </aside>
        <div className="page" style={{ flex: '999 1 560px', minWidth: 0, maxWidth: 'none' }}>
          {docs && docs.length > 0 && visibles.length === 0 ? <div className="card card-b"><Empty icon={Icon.book()} title="Ningún documento coincide con la búsqueda" hint="Cambia la búsqueda o los filtros para ver documentos." />
            <div style={{ display: 'flex', justifyContent: 'center' }}><button type="button" className="btn btn-secondary btn-sm" onClick={clearFilters}>Limpiar filtros</button></div></div>
          : doc ? <article className="card">
            <div className="card-h"><div><div className="h3">{doc.title}</div><div className="small muted">Autor: {doc.authorAgentName ?? 'sistema'} · {versions.length > 1 ? `versión ${versions.length - pos} de ${versions.length}` : 'versión única'} · {new Date(doc.createdAt).toLocaleString('es-MX')}</div></div>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{isOld && <Chip xs className="chip-warn">versión anterior</Chip>}{group && <Chip xs>{KIND_LABELS[group.kind]}</Chip>}<Chip xs className="mono">conocimiento</Chip></span></div>
            {isOld && group && <div className="card-b" style={{ paddingBottom: 0 }}><div className="notice notice-warn">Estás viendo una versión anterior. <button type="button" className="lnk" onClick={() => openDoc(group.latest.id)}>Abrir la más reciente</button></div></div>}
            {group && group.older.length > 0 && <div className="card-b" style={{ paddingBottom: 0 }}>
              <details className="kn-versions" open={isOld}>
                <summary>{isOld ? `Versiones del documento (${versions.length})` : `Versiones anteriores (${group.older.length})`}</summary>
                <ul className="kn-ver-list">
                  {(isOld ? versions : group.older).map((v, i) => { const n = versions.length - versions.indexOf(v); return <li key={v.id}>
                    <button type="button" className={`kn-ver ${v.id === doc.id ? 'is-active' : ''}`} aria-current={v.id === doc.id ? 'true' : undefined} onClick={() => openDoc(v.id)}>
                      <span className="kn-ver-n mono">v{n}</span><span className="small">{v.authorAgentName ?? 'sistema'} · {fmtShort(v.createdAt)}</span>{isOld && i === 0 && <span className="small muted">más reciente</span>}
                    </button></li>; })}
                </ul>
              </details></div>}
            <div className="card-b" style={{ maxWidth: 860 }}><Markdown text={doc.body} /></div>
          </article> : <div className="card card-b"><p className="muted sm13">Selecciona un documento. Si aún no hay ninguno, lanza la evaluación inicial desde el Resumen.</p></div>}
        </div>
        </div>}
      </main>
    </Shell>
  );
}

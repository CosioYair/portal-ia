import { useEffect, useState } from 'react';
import type { KnowledgeDoc } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, Empty, Icon } from '../components/ui.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { LessonsPanel } from '../components/LessonsPanel.tsx';

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
  useEffect(() => { api.knowledge(slug, projectId).then(d => { const want = new URLSearchParams(location.search).get('doc'); setDocs(d); setSel(d.some(x => x.id === want) ? want : d[0]?.id ?? null); }).catch(() => setDocs([])); }, [slug, projectId]);
  const doc = docs?.find(d => d.id === sel) ?? null;

  return (
    <Shell crumb="Conocimiento">
      <main style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{ display: 'flex', gap: 6, padding: '12px 24px 0', borderBottom: '1px solid #E5E3DC' }}>
          <button className={`btn btn-sm ${tab === 'docs' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => openTab('docs')}>Documentos</button>
          <button className={`btn btn-sm ${tab === 'lessons' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => openTab('lessons')}>Lecciones de la organización</button>
        </div>
        {tab === 'lessons' && <div className="page" style={{ maxWidth: 'none' }}><LessonsPanel projectId={projectId} /></div>}
        {tab === 'docs' && <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', flex: 1 }}>
        <aside style={{ flex: '1 1 280px', maxWidth: 340, borderRight: '1px solid #E5E3DC', padding: '16px 12px 24px', background: '#FAF9F6', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="side-sec">Documentos del proyecto · {docs?.length ?? 0}</div>
          {docs && docs.length === 0 && <Empty icon={Icon.book()} title="Sin documentos" hint="Los agentes guardarán aquí sus análisis y decisiones cuando ejecuten procesos autorizados." style={{ padding: '32px 8px' }} />}
          {docs?.map(d => <button key={d.id} className={`rail-i ${d.id === sel ? 'is-active' : ''}`} onClick={() => openDoc(d.id)} aria-pressed={d.id === sel}>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}><span style={{ fontWeight: 500, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</span><span className="small muted">{d.authorAgentName ?? 'sistema'} · {new Date(d.createdAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}</span></span></button>)}
        </aside>
        <div className="page" style={{ flex: '999 1 560px', minWidth: 0, maxWidth: 'none' }}>
          {doc ? <article className="card">
            <div className="card-h"><div><div className="h3">{doc.title}</div><div className="small muted">Autor: {doc.authorAgentName ?? 'sistema'} · versión {doc.version} · {new Date(doc.createdAt).toLocaleString('es-MX')}</div></div><Chip xs className="mono">conocimiento</Chip></div>
            <div className="card-b" style={{ maxWidth: 860 }}><Markdown text={doc.body} /></div>
          </article> : <div className="card card-b"><p className="muted sm13">Selecciona un documento. Si aún no hay ninguno, lanza la evaluación inicial desde el panel.</p></div>}
        </div>
        </div>}
      </main>
    </Shell>
  );
}

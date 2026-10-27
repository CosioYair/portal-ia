import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BacklogItem, ProjectArchive } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { BACKLOG_STATUS, fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, Empty, Icon, Notice } from '../components/ui.tsx';

const PROC_STATUS: Record<string, string> = { running: 'en ejecución', done: 'completado', pending_authorization: 'pendiente de autorización', failed: 'con errores', cancelled: 'cancelado', budget_exceeded: 'presupuesto agotado' };

/** Archivo histórico: historias y procesos de etapas anteriores. Solo lectura; una historia puede restaurarse al backlog. */
export function Archive() {
  const { status, flash, navigate } = useApp();
  const ws = status.workspace!; const projectId = status.project!.id;
  const [data, setData] = useState<ProjectArchive | null>(null);
  const [q, setQ] = useState('');
  const [restoring, setRestoring] = useState<BacklogItem | null>(null);
  const [auth, setAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async () => { try { setData(await api.archive(ws.slug, projectId)); } catch (e: any) { flash(e.message, 'err'); } };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug, projectId]);

  const restore = async () => {
    if (!restoring || !auth) return; setBusy(true);
    try { await api.restoreStory(ws.slug, restoring.id); flash(`${restoring.storyId} restaurada al backlog activo`); setRestoring(null); setAuth(false); await load(); }
    catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); }
  };
  const match = (t: string) => !q.trim() || t.toLowerCase().includes(q.trim().toLowerCase());
  const stories = (data?.stories ?? []).filter(s => match(`${s.storyId} ${s.title} ${s.criterion}`));
  const procs = (data?.processes ?? []).filter(p => match(p.title));
  const phaseOf = (archiveId: string | null | undefined) => data?.transitions.find(t => t.id === archiveId)?.name ?? 'etapa anterior';

  return (
    <Shell crumb="Archivo histórico">
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="eyebrow">Archivo histórico</div>
            <h1 className="h1" style={{ fontSize: 26 }}>Trabajo de etapas anteriores</h1>
            <p className="med" style={{ maxWidth: '78ch', lineHeight: 1.55 }}>Historias y procesos archivados al iniciar una etapa. Son registro histórico: no aparecen en el backlog, la actividad ni la bandeja, y no admiten acciones. Lo implementado está en la rama principal; esto describe lo que se planificó o se intentó.</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Chip>{data?.stories.length ?? 0} historias</Chip><Chip>{data?.processes.length ?? 0} procesos</Chip>{data && data.transitions.length > 0 && <Chip tone="accent">{data.transitions.length} etapa(s) registrada(s)</Chip>}</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><Link className="btn btn-ghost" to="/etapa">Etapas</Link><Link className="btn btn-secondary" to="/backlog">Volver al backlog</Link></div>
        </div>

        {data && data.stories.length === 0 && data.processes.length === 0 && <section className="card card-b"><Empty icon={Icon.book()} title="No hay nada archivado" hint="Cuando inicies una etapa nueva, el trabajo activo de la anterior aparecerá aquí." /></section>}

        {data && (data.stories.length > 0 || data.processes.length > 0) && <>
          <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por id o texto…" aria-label="Buscar en el archivo" style={{ maxWidth: 360 }} />
          <section className="card">
            <div className="card-h"><div className="h3">Historias archivadas <span className="muted" style={{ fontWeight: 400 }}>· {stories.length}</span></div></div>
            <div style={{ overflowX: 'auto' }}><table className="tbl">
              <thead><tr><th style={{ width: 80 }}>ID</th><th>Historia</th><th style={{ width: 150 }}>Estado al archivar</th><th style={{ width: 190 }}>Etapa</th><th style={{ width: 230 }}></th></tr></thead>
              <tbody>{stories.map(s => { const st = BACKLOG_STATUS[s.status]; return <tr key={s.id}>
                <td className="mono" style={{ fontSize: 12, verticalAlign: 'top' }}>{s.storyId}</td>
                <td style={{ verticalAlign: 'top' }}><div style={{ fontWeight: 500 }}>{s.title}</div>{s.criterion && <div className="small muted" style={{ maxWidth: '70ch' }}>{s.criterion.slice(0, 220)}</div>}</td>
                <td style={{ verticalAlign: 'top' }}><Chip xs tone={st?.tone ?? ''}>{st?.label ?? s.status}</Chip></td>
                <td className="small muted" style={{ verticalAlign: 'top' }}>{s.archivedAt ? new Date(s.archivedAt).toLocaleDateString('es-MX') : ''} · {phaseOf(s.archiveId)}</td>
                <td style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}><button className="btn btn-ghost btn-sm" onClick={() => navigate(`/historias/${s.id}`)}>Consultar</button><button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={() => { setRestoring(s); setAuth(false); }}>Restaurar al backlog</button></td>
              </tr>; })}</tbody>
            </table></div>
          </section>
          <section className="card">
            <div className="card-h"><div className="h3">Procesos archivados <span className="muted" style={{ fontWeight: 400 }}>· {procs.length}</span></div></div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {procs.map(p => <button key={p.id} className="arow" onClick={() => navigate(`/procesos/${p.id}`)}><span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{p.title}</span><span className="small muted">{PROC_STATUS[p.status] ?? p.status} · {new Date(p.createdAt).toLocaleDateString('es-MX')}</span></span><span className="small mono muted">{fmtUsd(p.spentUsd)}</span></button>)}
            </div>
          </section>
        </>}

        {restoring && <div className="backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setRestoring(null); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rs-title" style={{ width: 'min(620px, 100%)' }}>
            <div className="modal-h"><div><div className="h3" id="rs-title">Restaurar {restoring.storyId} · {restoring.title}</div><div className="small muted">Vuelve al backlog activo con su estado ({BACKLOG_STATUS[restoring.status]?.label ?? restoring.status}) y sus procesos. No consume IA ni ejecuta nada.</div></div><button className="xbtn" onClick={() => setRestoring(null)} aria-label="Cerrar">{Icon.x(16)}</button></div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Notice kind="info">Revisa si sigue teniendo sentido: el código actual pudo cambiar desde entonces. Si prefieres, crea una historia nueva con lo que necesites.</Notice>
              <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo devolver <strong>{restoring.storyId}</strong> al backlog activo.</span></label>
            </div>
            <div className="modal-f"><span /><div style={{ display: 'flex', gap: 10 }}><button className="btn btn-ghost" onClick={() => setRestoring(null)} disabled={busy}>Cancelar</button><button className="btn btn-primary" onClick={restore} disabled={!auth || busy}>Restaurar</button></div></div>
          </div>
        </div>}
      </main>
    </Shell>
  );
}

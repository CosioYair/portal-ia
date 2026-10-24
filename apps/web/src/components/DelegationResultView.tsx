import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { BacklogOp, Process } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Chip, Icon, Notice } from './ui.tsx';
import { Markdown } from './Markdown.tsx';

function opLabel(o: BacklogOp): string {
  switch (o.op) {
    case 'add': return `Añadir: ${o.title}${o.estimate ? ` (${o.estimate})` : ''}${o.dependsOn ? ` · depende de ${o.dependsOn}` : ''}`;
    case 'update': return `Actualizar ${o.story}${o.title ? ` → «${o.title}»` : ''}${o.criterion ? ' · nuevo criterio' : ''}${o.estimate ? ` · ${o.estimate}` : ''}${o.dependsOn !== undefined ? ` · depende de ${o.dependsOn ?? 'nada'}` : ''}`;
    case 'discard': return `Descartar ${o.story}`;
    case 'merge': return `Fusionar ${o.from.join(', ')} en ${o.into}${o.title ? ` → «${o.title}»` : ''}`;
    case 'reprioritize': return `Reordenar: ${o.order.join(' → ')}`;
  }
}

/** Resultado de un encargo delegado: validación del responsable, consultas a su equipo, entregable y propuestas al backlog. */
export function DelegationResultView({ proc, onChange }: { proc: Process; onChange: (p: Process) => void }) {
  const { status, flash } = useApp();
  const slug = status.workspace!.slug;
  const d = proc.delegation!;
  const [auth, setAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const apply = async () => { setBusy(true); setErr(null); try { const p = await api.applyBacklogOps(slug, proc.id); onChange(p); flash('Propuestas aplicadas al backlog'); } catch (e: any) { setErr(e.message); } finally { setBusy(false); setAuth(false); } };

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <section className="card"><div className="card-h"><div><div className="h3">Encargo</div><div className="small muted">Responsable: {d.leadAgentName}</div></div>{d.triage && <Chip tone={d.triage.accepted ? 'ok' : 'err'} xs>{d.triage.accepted ? 'aceptado' : 'no aceptado'}</Chip>}</div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p className="med" style={{ lineHeight: 1.5, margin: 0 }}>«{d.request}»</p>
        {d.triage && <><div><div className="eyebrow" style={{ marginBottom: 4 }}>Cómo lo entiende el responsable</div><p style={{ margin: 0, lineHeight: 1.5 }}>{d.triage.understanding}</p>{d.triage.rejectionReason && <Notice kind="warn">{d.triage.rejectionReason}</Notice>}</div>
          {d.triage.plan.length > 0 && <div><div className="eyebrow" style={{ marginBottom: 4 }}>Plan</div><ol style={{ margin: 0, paddingLeft: 20 }}>{d.triage.plan.map((t, i) => <li key={i}>{t}</li>)}</ol></div>}</>}
      </div></section>

    {d.consulted.length > 0 && <section className="card"><div className="card-h"><div className="h3">Consultas a su equipo</div><Chip xs>{d.consulted.length}</Chip></div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>{d.consulted.map((c, i) => <div key={i}>
        <button className="arow" style={{ borderRadius: 0, padding: '10px 18px' }} onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}><span style={{ flex: 1, textAlign: 'left', display: 'flex', flexDirection: 'column' }}><span style={{ fontWeight: 500, fontSize: 13 }}>{c.agentName}</span><span className="small muted">{c.question}</span></span>{Icon.chevR()}</button>
        {open === i && <div className="card-b" style={{ background: '#FAF9F6', borderTop: '1px solid #EEECE6' }}><Markdown text={c.answer} /></div>}
      </div>)}</div></section>}

    {d.deliverable && <section className="card"><div className="card-h"><div className="h3">Entregable</div>{d.knowledgeDocId && <Link className="lnk sm13" to="/conocimiento">guardado en Conocimiento</Link>}</div><div className="card-b"><Markdown text={d.deliverable} /></div></section>}

    {d.backlogOps.length > 0 && <section className="card">
      <div className="card-h"><div><div className="h3">Propuestas al backlog</div><div className="small muted">Operación local y gratuita; nada cambia hasta que la apruebes.</div></div>{d.opsApplied ? <Chip tone="ok" dot="ok">aplicadas</Chip> : <Chip tone="warn" xs>{d.backlogOps.length} pendientes de tu aprobación</Chip>}</div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>{d.backlogOps.map((o, i) => <li key={i}><span style={{ fontWeight: 500 }}>{opLabel(o)}</span>{'reason' in o && o.reason && <span className="small muted"> — {o.reason}</span>}{o.op === 'add' && o.criterion && <div className="small muted">Criterio: {o.criterion}</div>}</li>)}</ul>
        {err && <Notice kind="err">{err}</Notice>}
        {d.opsApplied ? <div className="small muted">Aplicadas el {new Date(d.opsApplied.at).toLocaleString()}:<ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{d.opsApplied.summary.map((s, i) => <li key={i}>{s}</li>)}</ul> <Link className="lnk" to="/backlog">Ver backlog</Link></div> : <>
          <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>He revisado las propuestas y <strong>autorizo aplicarlas</strong> al backlog del proyecto.</span></label>
          <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={apply} disabled={!auth || busy}>{busy ? <span className="spin spin-light" /> : Icon.check()}Aplicar propuestas al backlog</button></>}
      </div></section>}
  </div>;
}

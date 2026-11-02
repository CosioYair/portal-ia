import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { ExecutionBackend, Lesson, PortableSkill, ProviderId } from '@portal-ia/domain';
import { Chip, Icon, Notice, Spinner } from './ui.tsx';
import { AgentFigure, STATE_TEXT } from './AgentFigure.tsx';
import { Markdown } from './Markdown.tsx';
import { useApp } from '../lib/store.ts';
import { useLive } from '../lib/live.ts';
import { TOOL_LABELS, fmtUsd } from '../lib/labels.ts';
import { HARNESSES } from '@portal-ia/domain';
import { FolderPicker } from './FolderPicker.tsx';
import { DocumentsTab, ImprovementsTab, OriginTab } from './ExternalAgent.tsx';
import { ChatTab, FeedbackForm } from './AgentChat.tsx';
import { INTEGRATION_LABEL } from '@portal-ia/domain';
import { osApi, type AgentPanel as Panel, type Department, type FolderStatus, type HarnessOptions, type OfficeAgent, type WorkItem } from '../lib/osApi.ts';

/**
 * Panel de un agente: todo lo suyo en un sitio, sin navegar por seis pantallas.
 *  Chat · Solicitudes · Trabajo · Archivos · Memoria · Configuración.
 * Cada acción que gasta (un mensaje, un encargo) lo dice antes; nada se autoriza solo.
 */
const BASE_TABS = [['chat', 'Chat'], ['solicitudes', 'Solicitudes'], ['trabajo', 'Trabajo'], ['archivos', 'Archivos'], ['memoria', 'Memoria'], ['configuracion', 'Configuración']] as const;
/** Agente externo (su carpeta original es la fuente): Documentos, Origen y Mejoras; «Archivos» es su carpeta original (en Origen). */
const EXTERNAL_TABS = [['chat', 'Chat'], ['documentos', 'Documentos'], ['solicitudes', 'Solicitudes'], ['trabajo', 'Trabajo'], ['mejoras', 'Mejoras'], ['origen', 'Origen'], ['memoria', 'Memoria'], ['configuracion', 'Configuración']] as const;
type Tab = typeof BASE_TABS[number][0] | typeof EXTERNAL_TABS[number][0];

export function AgentPanel({ slug, agentId, tab, office, departments, projects, onTab, onClose, onChanged }: { slug: string; agentId: string; tab: string; office: OfficeAgent | null; departments: Department[]; projects: { id: string; name: string }[]; onTab: (t: Tab) => void; onClose: () => void; onChanged: () => void }) {
  const [p, setP] = useState<Panel | null>(null); const [error, setError] = useState<string | null>(null);
  const cur = useRef(agentId); cur.current = agentId;
  const load = useCallback(() => osApi.panel(slug, agentId).then(x => { if (x.agent.id !== cur.current) return; setP(x); setError(null); }).catch(e => { if (agentId === cur.current) setError(e.message); }), [slug, agentId]);
  useEffect(() => { setP(null); void load(); }, [load]);
  useLive(c => c.ws === slug && ((c.entity === 'agent' && c.id === agentId) || (c.entity === 'process' && c.kind !== 'progress') || (c.entity === 'agent_chat' && c.id === agentId)), () => void load(), { minMs: 1000 });
  const external = !!(p?.office?.integration ?? office?.integration);
  // Sin «documentos/» en su carpeta no hay banco de documentos.
  const TABS: readonly (readonly [Tab, string])[] = external ? EXTERNAL_TABS.filter(t => t[0] !== 'documentos' || p?.external?.hasOutputs !== false) : BASE_TABS;
  const improvements = p?.office?.attention.filter(a => a.kind === 'improvement').length ?? 0;
  const current = (TABS.some(t => t[0] === tab) ? tab : external && tab === 'archivos' ? 'origen' : 'chat') as Tab;
  const hue = departments.find(d => d.slug === (office?.departmentSlug ?? p?.office?.departmentSlug))?.hue ?? 200;
  const ref = useRef<HTMLDivElement>(null);
  // El foco va al panel al abrir OTRO agente (no en cada render: si no, se lo quitaría a la pestaña que eliges con el teclado).
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => { ref.current?.focus(); }, [agentId]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key !== 'Escape') return; const el = document.activeElement as HTMLElement | null; if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && (el as HTMLInputElement).value) return; closeRef.current(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  const onTabKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = TABS.findIndex(t => t[0] === current); const n = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    onTab(TABS[n][0]); requestAnimationFrame(() => (document.getElementById(`tab-${TABS[n][0]}`) as HTMLButtonElement | null)?.focus());
  };
  const refresh = () => { void load(); onChanged(); };
  const requests = p?.office?.attention.length ?? 0;
  // En el nivel raíz del documento: por encima de los botones flotantes (Asistente, Autorizaciones) y de cualquier contexto de apilamiento.
  return createPortal(<aside className="agent-panel" role="dialog" aria-modal="false" aria-labelledby="agent-panel-title" tabIndex={-1} ref={ref}>
    <div className="agent-panel-head">
      <AgentFigure id={agentId} hue={hue} state={p?.office?.state ?? office?.state ?? 'idle'} size={56} />
      <div className="who">
        <h2 id="agent-panel-title">{p?.agent.config.name ?? office?.name ?? 'Agente'}</h2>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Chip xs>{p?.agent.template.role ?? office?.role}</Chip>
          <Chip xs tone="accent">{p?.department?.name ?? office?.department}</Chip>
          <Chip xs>{p?.office?.harnessLabel ?? office?.harnessLabel}</Chip>
          {p?.office && <Chip xs tone={p.office.state === 'attention' ? 'warn' : p.office.state === 'working' ? 'ok' : ''}>{STATE_TEXT[p.office.state]}</Chip>}
          {p?.office?.integration && <Chip xs tone={p.office.integration === 'integrated' ? 'ok' : 'soon'}>{INTEGRATION_LABEL[p.office.integration]}</Chip>}
        </div>
        {p?.office?.activity && <span className="small muted">{p.office.activity}</span>}
      </div>
      <button type="button" className="xbtn" onClick={onClose} aria-label="Cerrar el panel">{Icon.x(16)}</button>
    </div>
    <div className="agent-panel-tabs" role="tablist" aria-label="Secciones del agente" onKeyDown={onTabKey}>
      {TABS.map(([id, label]) => <button key={id} id={`tab-${id}`} role="tab" type="button" aria-selected={current === id} aria-controls={`tp-${id}`} tabIndex={current === id ? 0 : -1} onClick={() => onTab(id)}>
        {label}{id === 'solicitudes' && requests > 0 && <span className="tab-count">{requests}</span>}{id === 'memoria' && (p?.memory.proposed.length ?? 0) > 0 && <span className="tab-count">{p!.memory.proposed.length}</span>}{id === 'mejoras' && improvements > 0 && <span className="tab-count" aria-label="mejoras pendientes de tu aprobación">{improvements}</span>}
      </button>)}
    </div>
    {error && <div style={{ padding: 12 }}><Notice kind="err">{error}</Notice></div>}
    {!p && !error && <div style={{ padding: 24 }}><Spinner /></div>}
    {p && <div role="tabpanel" tabIndex={0} id={`tp-${current}`} aria-labelledby={`tab-${current}`} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {current === 'chat' && <ChatTab slug={slug} p={p} projects={projects} onChanged={refresh} />}
      {current !== 'chat' && <div className="agent-panel-body">
        {current === 'solicitudes' && <RequestsTab p={p} onTab={onTab} />}
        {current === 'trabajo' && <WorkTab slug={slug} p={p} projects={projects} onChanged={refresh} />}
        {current === 'archivos' && <FilesTab slug={slug} p={p} onChanged={refresh} />}
        {current === 'documentos' && <DocumentsTab slug={slug} p={p} onChanged={refresh} onTab={onTab} />}
        {current === 'origen' && <OriginTab slug={slug} p={p} onChanged={refresh} />}
        {current === 'mejoras' && <ImprovementsTab slug={slug} p={p} onChanged={refresh} onTab={onTab} />}
        {current === 'memoria' && <MemoryTab slug={slug} p={p} onChanged={refresh} />}
        {current === 'configuracion' && <ConfigTab slug={slug} p={p} departments={departments} onChanged={refresh} />}
      </div>}
    </div>}
  </aside>, document.body);
}

// ---------------------------------------------------------------- Solicitudes

function RequestsTab({ p, onTab }: { p: Panel; onTab: (t: Tab) => void }) {
  const items = p.office?.attention ?? [];
  return <>
    <p className="small muted">Lo que este agente necesita de ti: autorizaciones, decisiones, aprendizaje por verificar y cambios en sus archivos.</p>
    {!items.length && !p.memory.proposed.length && <Notice kind="ok">Nada pendiente con {p.agent.config.name}.</Notice>}
    {items.map((a, i) => <div key={i} className="work-card">
      <strong>{a.label}</strong>
      <div style={{ display: 'flex', gap: 8 }}>
        {a.processId && <Link className="btn btn-secondary btn-sm" to={`/procesos/${a.processId}`}>Abrir y decidir</Link>}
        {a.kind === 'memory' && <button className="btn btn-secondary btn-sm" onClick={() => onTab('memoria')}>Revisar en Memoria</button>}
        {a.kind === 'folder' && <button className="btn btn-secondary btn-sm" onClick={() => onTab('archivos')}>Revisar en Archivos</button>}
        {a.kind === 'improvement' && <button className="btn btn-secondary btn-sm" onClick={() => onTab('mejoras')}>Revisar en Mejoras</button>}
        {a.kind === 'source' && <button className="btn btn-secondary btn-sm" onClick={() => onTab('origen')}>Revisar en Origen</button>}
      </div>
    </div>)}
    <Link className="btn btn-ghost btn-sm" to="/autorizaciones" style={{ alignSelf: 'flex-start' }}>{Icon.authorization()} Todas las decisiones pendientes</Link>
  </>;
}

// ---------------------------------------------------------------- Trabajo

const COLS: [WorkItem['column'], string][] = [['requested', 'Por autorizar'], ['queued', 'En cola'], ['doing', 'Haciendo'], ['done', 'Hecho'], ['stopped', 'Detenido']];
function WorkTab({ slug, p, projects, onChanged }: { slug: string; p: Panel; projects: { id: string; name: string }[]; onChanged: () => void }) {
  const { flash, status } = useApp();
  const [req, setReq] = useState(''); const [projectId, setProjectId] = useState(p.agent.scope === 'project' ? p.agent.projectId ?? '' : status.project?.id ?? projects[0]?.id ?? '');
  const [budget, setBudget] = useState(1); const [auth, setAuth] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); const [fb, setFb] = useState<string | null>(null);
  const billable = p.agent.config.backend === undefined || p.agent.config.backend === 'api';
  const submit = async () => {
    setBusy(true); setError(null);
    try { await osApi.task(slug, p.agent.id, { request: req.trim(), projectId: projectId || null, budgetUsd: billable ? budget : 0 }); setReq(''); setAuth(false); flash('Encargo autorizado: ya está en marcha'); onChanged(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <>
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }} aria-labelledby="new-task">
      <div className="h3" id="new-task">Nuevo encargo</div>
      {error && <Notice kind="err">{error}</Notice>}
      <textarea className="input" rows={3} value={req} onChange={e => setReq(e.target.value)} placeholder={`¿Qué debe entregarte ${p.agent.config.name}?`} aria-label="Encargo" disabled={p.retired} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="small" htmlFor="task-project">Proyecto</label>
        <select id="task-project" className="input" style={{ maxWidth: 240, height: 32 }} value={projectId} onChange={e => setProjectId(e.target.value)}>{projects.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        {billable && <><label className="small" htmlFor="task-budget">Presupuesto API (USD)</label><input id="task-budget" className="input" style={{ width: 90, height: 32 }} type="number" min={0.1} step={0.1} value={budget} onChange={e => setBudget(Number(e.target.value))} /></>}
      </div>
      <label className="ck small"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /> Autorizo este encargo: {billable ? `llamadas facturables hasta ${fmtUsd(budget)}` : `una llamada con ${p.office?.harnessLabel ?? 'su arnés'} (tope de 3 llamadas)`}. El resultado se guarda en Conocimiento.</label>
      <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-end' }} disabled={busy || !auth || req.trim().length < 8 || !projectId || p.retired} onClick={() => void submit()}>{busy ? 'Enviando…' : 'Encargar'}</button>
    </section>
    {open && (() => { const w = p.work.find(x => x.id === open); return w?.deliverable ? <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }} aria-label={`Entregable: ${w.title}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}><strong className="small">{w.title}</strong><button type="button" className="xbtn" onClick={() => setOpen(null)} aria-label="Cerrar el entregable">{Icon.x(14)}</button></div>
      <div className="file-view" style={{ fontFamily: 'var(--font-sans)', maxHeight: 420 }}><Markdown text={w.deliverable} /></div>
      <Link className="lnk small" to={`/procesos/${w.id}`}>{w.deliverable.length >= 3990 ? 'Está recortado: ábrelo completo en su proceso' : 'Abrir su proceso'}</Link>
    </section> : null; })()}
    <div className="board">{COLS.map(([col, label]) => { const items = p.work.filter(w => w.column === col); return <div key={col} className="board-col">
      <h4>{label}<span>{items.length}</span></h4>
      {items.slice(0, 12).map(w => <div key={w.id} className="work-card">
        <Link to={`/procesos/${w.id}`} className="lnk" style={{ fontWeight: 600 }}>{w.title}</Link>
        <span className="small muted">{new Date(w.createdAt).toLocaleString('es-MX')}{w.lead ? ' · responsable' : ' · participa'}</span>
        {w.deliverable && <button type="button" className="lnk small" onClick={() => setOpen(open === w.id ? null : w.id)} aria-expanded={open === w.id}>{open === w.id ? 'Ocultar entregable' : 'Ver entregable'}</button>}

        {w.column === 'done' && w.lead && <button type="button" className="lnk small" onClick={() => setFb(fb === w.id ? null : w.id)}>Valorar y enseñar</button>}
        {fb === w.id && <FeedbackForm slug={slug} agentId={p.agent.id} processId={w.id} onDone={() => { setFb(null); flash('Aprendizaje propuesto: verifícalo en Memoria'); onChanged(); }} />}
      </div>)}
    </div>; })}</div>
  </>;
}

// ---------------------------------------------------------------- Archivos

function FilesTab({ slug, p, onChanged }: { slug: string; p: Panel; onChanged: () => void }) {
  const { flash } = useApp();
  const [st, setSt] = useState<FolderStatus | null>(null); const [file, setFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | null>(null); const [skill, setSkill] = useState<PortableSkill | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false); const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const load = useCallback(() => osApi.folder(slug, p.agent.id).then(setSt).catch(e => setError(e.message)), [slug, p.agent.id]);
  useEffect(() => { void load(); }, [load, p.folder.adopted?.n]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setError(null); try { await fn(); flash(ok); await load(); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  if (!st) return error ? <Notice kind="err">{error}</Notice> : <Spinner />;
  if (!st.folder) return <>
    <Notice kind="info">Este agente aún no tiene carpeta portable. Al crearla, su identidad queda en archivos que son tuyos (AGENTS.md, habilidades, memoria verificada) y que puedes llevar a otro arnés o exportar. Su configuración no cambia.</Notice>
    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => osApi.createFolder(slug, p.agent.id), 'Carpeta creada')} style={{ alignSelf: 'flex-start' }}>Crear su carpeta</button>
  </>;
  const files = st.adopted?.files ?? {};
  const instr = files['AGENTS.md'] ?? '';
  return <>
    {error && <Notice kind="err">{error}</Notice>}
    <div className="small"><strong>Carpeta</strong> <code className="mono">{st.path}</code></div>
    <div className="small muted">Revisión adoptada {st.adopted?.n} · {st.adopted?.source} · {st.adopted ? new Date(st.adopted.at).toLocaleString('es-MX') : ''}</div>
    {st.external && <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, borderColor: 'var(--color-warn-border)' }}>
      <div className="h3">Cambios hechos fuera del Portal</div>
      <p className="small">Ningún agente los usa hasta que los adoptes. {st.external.notAdopted.length > 0 && 'Algunas partes nunca se adoptan desde la carpeta:'}</p>
      {st.external.notAdopted.map((n, i) => <Notice key={i} kind="info">{n}</Notice>)}
      {st.external.problems.map((x, i) => <Notice key={i} kind={x.blocking ? 'err' : 'warn'}>{x.path}: {x.message}</Notice>)}
      {st.external.diff.map(d => <div key={d.path}><div className="small mono"><strong>{d.path}</strong> · {d.change === 'added' ? 'nuevo' : d.change === 'removed' ? 'eliminado' : 'modificado'}</div>
        <div className="file-view">{d.removed.map((l, i) => <div key={`r${i}`} className="diff-del">- {l}</div>)}{d.added.map((l, i) => <div key={`a${i}`} className="diff-add">+ {l}</div>)}</div></div>)}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary btn-sm" disabled={busy || st.external.problems.some(x => x.blocking)} onClick={() => void act(() => osApi.adopt(slug, p.agent.id, st.external!.hash), 'Cambios adoptados')}>Adoptar los cambios</button>
        {confirmDiscard ? <><button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setConfirmDiscard(false); void act(() => osApi.discard(slug, p.agent.id), 'Cambios descartados: carpeta restaurada'); }}>Sí, descartarlos (se pierden)</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirmDiscard(false)}>No</button></>
          : <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setConfirmDiscard(true)}>Descartarlos…</button>}
      </div>
    </section>}
    <section aria-labelledby="files-h" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="h3" id="files-h">Archivos</div>
      <ul className="file-list">{Object.keys(files).sort().map(f => <li key={f}><button type="button" onClick={() => setFile(file === f ? null : f)} aria-expanded={file === f}>{Icon.file()} {f}</button>{file === f && <div className="file-view">{files[f]}</div>}</li>)}</ul>
    </section>
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="h3">Instrucciones (AGENTS.md)</div>
      {edit === null ? <><p className="small muted">Lo que este agente debe tener siempre presente, con cualquier arnés.</p><button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={!!st.external} onClick={() => setEdit(/portal-ia: instrucciones por defecto/.test(instr) ? '' : instr)}>Editar instrucciones</button></>
        : <><textarea className="input" rows={8} value={edit} onChange={e => setEdit(e.target.value)} aria-label="Instrucciones del agente" />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="btn btn-ghost btn-sm" onClick={() => setEdit(null)}>Cancelar</button><button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => osApi.identity(slug, p.agent.id, { instructions: edit, expectN: st.adopted?.n ?? null }), 'Instrucciones guardadas (nueva revisión)').then(() => setEdit(null))}>Guardar</button></div></>}
    </section>
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="h3">Habilidades</div>
      <SkillsList files={files} />
      {skill === null ? <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={!!st.external} onClick={() => setSkill({ slug: '', name: '', description: '', body: '' })}>Añadir habilidad</button>
        : <><input className="input" placeholder="Nombre (p. ej. «Plan de campaña»)" value={skill.name} onChange={e => setSkill({ ...skill, name: e.target.value })} aria-label="Nombre de la habilidad" />
          <input className="input" placeholder="Para qué sirve (una frase)" value={skill.description} onChange={e => setSkill({ ...skill, description: e.target.value })} aria-label="Descripción" />
          <textarea className="input" rows={5} placeholder="Cómo se hace, paso a paso" value={skill.body} onChange={e => setSkill({ ...skill, body: e.target.value })} aria-label="Cuerpo" />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="btn btn-ghost btn-sm" onClick={() => setSkill(null)}>Cancelar</button>
            <button className="btn btn-primary btn-sm" disabled={busy || skill.name.trim().length < 2} onClick={() => void act(() => osApi.identity(slug, p.agent.id, { skills: [...skillsOf(files), { ...skill, slug: '' }], expectN: st.adopted?.n ?? null }), 'Habilidad añadida').then(() => setSkill(null))}>Guardar habilidad</button></div></>}
    </section>
    <section aria-labelledby="rev-h" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="h3" id="rev-h">Revisiones</div>
      {st.revisions.filter(r => r.state === 'adopted' || r.state === 'superseded').slice(0, 12).map(r => <div key={r.n} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="mono">#{r.n}</span><span>{r.source}</span><span className="muted">{new Date(r.at).toLocaleString('es-MX')}</span><span className="muted" style={{ flex: 1 }}>{r.note}</span>
        {r.state === 'superseded' && (confirmRestore === r.n ? <><button className="lnk" disabled={busy || !!st.external} onClick={() => { setConfirmRestore(null); void act(() => osApi.restore(slug, p.agent.id, r.n), `Vuelta a la revisión ${r.n}`); }}>Sí, volver (queda como revisión nueva)</button><button className="lnk" onClick={() => setConfirmRestore(null)}>No</button></>
          : <button className="lnk" disabled={busy || !!st.external} onClick={() => setConfirmRestore(r.n)}>Volver a esta…</button>)}
        {r.state === 'adopted' && <Chip xs tone="ok">actual</Chip>}
      </div>)}
    </section>
    <ExportBox slug={slug} agentId={p.agent.id} />
  </>;
}
const skillsOf = (files: Record<string, string>): PortableSkill[] => Object.entries(files).filter(([k]) => /^skills\/[^/]+\/SKILL\.md$/.test(k)).map(([k, v]) => {
  const slugName = k.split('/')[1]; const m = v.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm = m?.[1] ?? ''; const name = fm.match(/^name: (.*)$/m)?.[1]?.replace(/^"|"$/g, '') ?? slugName; const description = fm.match(/^description: (.*)$/m)?.[1]?.replace(/^"|"$/g, '') ?? '';
  return { slug: slugName, name, description, body: (m?.[2] ?? v).trim() };
});
function SkillsList({ files }: { files: Record<string, string> }) {
  const skills = skillsOf(files);
  return skills.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{skills.map(s => <li key={s.slug}><strong>{s.name}</strong>{s.description ? ` — ${s.description}` : ''}</li>)}</ul> : <p className="small muted">Sin habilidades todavía.</p>;
}
function ExportBox({ slug, agentId }: { slug: string; agentId: string }) {
  const { flash } = useApp();
  const [path, setPath] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [picking, setPicking] = useState(false);
  const download = async () => { try { const r = await osApi.exportFiles(slug, agentId); const blob = new Blob([JSON.stringify({ schema: 'portal-ia/agent-bundle@1', folder: r.folder, files: r.files }, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${r.folder}.agente.json`; a.click(); URL.revokeObjectURL(a.href); } catch (e: any) { setError(e.message); } };
  const toFolder = async () => { setBusy(true); setError(null); try { const r = await osApi.exportTo(slug, agentId, path.trim()); flash(`Exportado a ${r.path}`); setPath(''); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div className="h3">Exportar</div>
    {error && <Notice kind="err">{error}</Notice>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <input className="input" style={{ flex: 1, minWidth: 200 }} value={path} onChange={e => setPath(e.target.value)} placeholder="Carpeta de destino (p. ej. ~/Documentos/agentes)" aria-label="Carpeta de destino" />
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicking(true)}>{Icon.folder()} Elegir…</button>
      {picking && <FolderPicker title="Exportar a…" hint="Elige dónde copiar la carpeta del agente (no se sobrescribe nada)." initialPath={path || null} onSelect={x => { setPicking(false); setPath(x); }} onClose={() => setPicking(false)} />}
      <button className="btn btn-secondary btn-sm" disabled={busy || !path.trim()} onClick={() => void toFolder()}>Copiar carpeta</button>
      <button className="btn btn-ghost btn-sm" onClick={() => void download()}>Descargar (.json)</button>
    </div>
    <span className="small muted">Sin credenciales: la carpeta solo lleva identidad, instrucciones, habilidades, memoria verificada y referencias.</span>
  </section>;
}

// ---------------------------------------------------------------- Memoria

function MemoryTab({ slug, p, onChanged }: { slug: string; p: Panel; onChanged: () => void }) {
  const { flash } = useApp();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [edits, setEdits] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setError(null); try { await fn(); flash(ok); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const card = (l: Lesson, kind: 'verified' | 'proposed') => <div key={l.id} className="work-card">
    <strong>{l.title}</strong>
    {kind === 'proposed' ? <textarea className="input" rows={3} value={edits[l.id] ?? l.lessonText ?? ''} onChange={e => setEdits({ ...edits, [l.id]: e.target.value })} aria-label={`Texto del aprendizaje «${l.title}»`} /> : <span>{l.lessonText}</span>}
    <span className="small muted">Origen: {l.evidence.processTitle ?? 'conversación'} · {l.evidence.detail.slice(0, 220)}</span>
    <div style={{ display: 'flex', gap: 8 }}>
      {kind === 'proposed' && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => osApi.verifyMemory(slug, p.agent.id, l.id, edits[l.id] ? { text: edits[l.id] } : {}), 'Aprendizaje verificado: lo usará en adelante')}>Verificar</button>}
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => osApi.retireMemory(slug, p.agent.id, l.id), kind === 'proposed' ? 'Propuesta descartada' : 'Aprendizaje retirado')}>{kind === 'proposed' ? 'Descartar' : 'Retirar'}</button>
    </div>
  </div>;
  return <>
    <p className="small muted">{p.external ? <>La memoria de {p.agent.config.name} es su propio archivo de memoria (en su carpeta original; lo cambian las mejoras que apruebas) más lo que verifiques aquí a partir de su trabajo.</> : <>La memoria de {p.agent.config.name} es lo que tú has verificado a partir de su trabajo. Se aplica con cualquier arnés y viaja en su carpeta (memory/MEMORY.md).</>} Nada generado por un modelo entra aquí solo.</p>
    {error && <Notice kind="err">{error}</Notice>}
    <div className="h3">Por verificar ({p.memory.proposed.length})</div>
    {p.memory.proposed.length ? p.memory.proposed.map(l => card(l, 'proposed')) : <p className="small muted">Nada pendiente.</p>}
    <div className="h3">Verificada ({p.memory.verified.length})</div>
    {p.memory.verified.length ? p.memory.verified.map(l => card(l, 'verified')) : <p className="small muted">Aún sin aprendizaje verificado.</p>}
    {adding ? <FeedbackForm slug={slug} agentId={p.agent.id} onDone={() => { setAdding(false); onChanged(); }} /> : <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>Proponer un aprendizaje</button>}
  </>;
}

// ---------------------------------------------------------------- Configuración

function ConfigTab({ slug, p, departments, onChanged }: { slug: string; p: Panel; departments: Department[]; onChanged: () => void }) {
  const { flash } = useApp();
  const [opts, setOpts] = useState<HarnessOptions | null>(null); const [pick, setPick] = useState<ExecutionBackend | null>(null); const [model, setModel] = useState(''); const [provider, setProvider] = useState<ProviderId | null>(null);
  const [auth, setAuth] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [dep, setDep] = useState(p.department?.name ?? '');
  const load = useCallback(() => osApi.harnessOptions(slug, p.agent.id).then(setOpts).catch(e => setError(e.message)), [slug, p.agent.id]);
  useEffect(() => { void load(); }, [load, p.agent.config.backend]);
  const chosen = opts?.options.find(o => o.id === pick) ?? null;
  const modelGroups = chosen?.models ?? [];
  useEffect(() => { if (!chosen) return; const g = chosen.models[0]; setProvider(g?.provider ?? null); setModel(g?.models.find(m => m.id === p.agent.config.model)?.id ?? g?.models[0]?.id ?? ''); setAuth(false); }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps
  const doSwitch = async () => { if (!pick) return; setBusy(true); setError(null); try { await osApi.switchHarness(slug, p.agent.id, pick, model, provider); flash(`Arnés de ${p.agent.config.name}: ${chosen?.name}`); setPick(null); await load(); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const move = async () => { setBusy(true); setError(null); try { await osApi.moveAgent(slug, p.agent.id, dep); flash(`${p.agent.config.name} ahora está en ${dep}`); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const tools = useMemo(() => Object.keys(p.agent.config.tools).filter(k => p.agent.config.tools[k]), [p.agent.config.tools]);
  return <>
    {error && <Notice kind="err">{error}</Notice>}
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="h3">Identidad</div>
      <div className="small"><strong>{p.agent.config.name}</strong> · {p.agent.template.role}</div>
      <div className="small muted">{p.agent.config.specialization}</div>
      {p.agent.config.responsibilities.length > 0 && <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{p.agent.config.responsibilities.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="small" htmlFor="cfg-dep">Departamento</label>
        <select id="cfg-dep" className="input" style={{ maxWidth: 240, height: 32 }} value={dep} onChange={e => setDep(e.target.value)}>{departments.map(d => <option key={d.slug} value={d.name}>{d.name}</option>)}</select>
        <button className="btn btn-secondary btn-sm" disabled={busy || dep === p.department?.name} onClick={() => void move()}>Mover</button>
      </div>
      <Link className="lnk small" to={`/equipo/${p.agent.id}`}>Configuración avanzada (modelo, herramientas, límites, capacidades)</Link>
    </section>
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }} aria-labelledby="harness-h">
      <div className="h3" id="harness-h">Cómo trabaja (arnés)</div>
      {!opts ? <Spinner /> : <>
        <p className="small">Ahora trabaja con <strong>{opts.currentLabel}</strong>. {opts.continuity}</p>
        <details className="small muted"><summary style={{ cursor: 'pointer' }}>Detalles técnicos</summary>Modelo: <span className="mono">{opts.model}</span></details>
        <div className="harness-cards">{opts.options.filter(o => o.id !== 'claude-code-terminal' || o.current).map(o => <button key={o.id} type="button" className="harness-card" aria-pressed={(pick ?? opts.current) === o.id} disabled={!o.availability.available && !o.current} onClick={() => setPick(o.current ? null : o.id)}>
          <strong>{o.name}{o.current ? ' · actual' : ''}</strong>
          <span className="small muted">{o.vendor} · {o.billing === 'subscription' ? 'tu suscripción' : o.billing === 'api' ? 'API facturable' : 'no verificable'}</span>
          <span className="small">{o.availability.available ? (o.availability.detail ?? 'Disponible') : o.availability.reason}</span>
        </button>)}</div>
        {chosen && <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="h3">Cambiar a {chosen.name}</div>
          <p className="small">{chosen.summary}</p>
          {(chosen.compatibility.missing.length > 0 || chosen.compatibility.reduced.length > 0) && <ul className="cap-list">
            {chosen.compatibility.missing.map(m => <li key={m.capability}>{Icon.stateError()} <span><strong>Pierde:</strong> {m.label}{m.note ? ` — ${m.note}` : ''}</span></li>)}
            {chosen.compatibility.reduced.map(m => <li key={m.capability}>{Icon.warn()} <span><strong>Parcial:</strong> {m.label}{m.note ? ` — ${m.note}` : ''}</span></li>)}
          </ul>}
          {chosen.compatibility.gains.length > 0 && <ul className="cap-list">{chosen.compatibility.gains.map(g => <li key={g.capability}>{Icon.stateDone()} <span><strong>Gana:</strong> {g.label}</span></li>)}</ul>}
          {/* Lo que cambia aunque su trabajo de hoy no lo use: también se dice, para decidir con todo a la vista. */}
          {chosen.compatibility.losses.filter(l => !l.needed).length > 0 && <ul className="cap-list">{chosen.compatibility.losses.filter(l => !l.needed).map(l => <li key={l.capability}>{Icon.info()} <span><strong>Cambia:</strong> {l.label} ({LEVEL[l.from.level]} → {LEVEL[l.to.level]}){l.to.note ? ` — ${l.to.note.replace(/\.$/, '')}` : ''}. Hoy no lo usa.</span></li>)}</ul>}
          {!chosen.compatibility.missing.length && !chosen.compatibility.reduced.length && !chosen.compatibility.losses.length && !chosen.compatibility.gains.length && <p className="small">Mismas capacidades que con su arnés actual.</p>}
          {chosen.id === 'codex' && <Notice kind="info">Con Codex, este agente puede conversar, recibir encargos y participar en peticiones de departamento. Las historias del backlog y los lotes aún no se ejecutan con Codex: allí se detendrá y te lo dirá.</Notice>}
          {chosen.billing === 'api' && <Notice kind="warn">La API se factura por uso: cada encargo te pedirá presupuesto y cada mensaje, confirmación.</Notice>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {modelGroups.length > 1 && <select className="input" style={{ maxWidth: 160, height: 32 }} value={provider ?? ''} onChange={e => { const g = modelGroups.find(x => x.provider === e.target.value); setProvider(g?.provider ?? null); setModel(g?.models[0]?.id ?? ''); }} aria-label="Proveedor">{modelGroups.map(g => <option key={g.provider} value={g.provider}>{g.provider === 'openai' ? 'OpenAI' : 'Anthropic'}</option>)}</select>}
            <select className="input" style={{ maxWidth: 280, height: 32 }} value={model} onChange={e => setModel(e.target.value)} aria-label="Modelo">{(modelGroups.find(g => g.provider === provider)?.models ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          </div>
          {opts.work.open.length > 0 && <Notice kind="info">{opts.pinned} Trabajos abiertos: {opts.work.open.map(w => `«${w.title}»`).join(', ')}.</Notice>}
          {opts.work.batches.length > 0 && <Notice kind="info">Lotes abiertos: {opts.work.batches.map(b => `«${b.title}» (${b.status})`).join(', ')}. Solo usarán a este agente con un origen que el lote autorice.</Notice>}
          <label className="ck small"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /> Autorizo que {p.agent.config.name} trabaje con {chosen.name}{chosen.billing === 'api' ? ' (facturable por uso)' : chosen.billing === 'subscription' ? ' y mi suscripción' : ''}. Su identidad, instrucciones, habilidades y memoria no cambian.</label>
          <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-end' }} disabled={busy || !auth || !model || opts.work.inFlight.length > 0} onClick={() => void doSwitch()}>{busy ? 'Cambiando…' : `Cambiar a ${chosen.name}`}</button>
          {opts.work.inFlight.length > 0 && <span className="small" style={{ color: 'var(--color-err-text)' }}>Tiene una llamada en curso: espera a que termine.</span>}
        </div>}
      </>}
    </section>
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="h3">Permisos</div>
      <div className="small">Permisos concedidos: {tools.length ? tools.map(t => TOOL_LABELS[t]?.name ?? t).join(', ') : 'ninguno'}</div>
      <div className="small">Ámbito: {p.agent.scope === 'workspace' ? 'toda la empresa' : 'su proyecto'} · las acciones externas, publicar o gastar siempre te piden aprobación.</div>
      <div className="small muted">Las instrucciones o habilidades de su carpeta nunca amplían estos permisos.</div>
    </section>
    <section style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div className="h3">Registro</div>
      {p.events.slice(0, 12).map(e => <div key={e.id} className="small"><span className="muted">{new Date(e.at).toLocaleString('es-MX')}</span> · {EVENT_TEXT[e.kind] ?? e.kind}{e.kind === 'integration_state' && e.detail?.to ? ` → ${INTEGRATION_TO[String(e.detail.to)] ?? String(e.detail.to)}` : e.kind === 'document_job' ? `: ${JOB_ACTION[String(e.detail?.action)] ?? String(e.detail?.action ?? '')}${e.detail?.version ? ` (v${e.detail.version})` : ''}` : e.detail?.to ? ` → ${HARNESS_NAME[String(e.detail.to)] ?? String(e.detail.to)}` : ''}</div>)}
      {!p.events.length && <span className="small muted">Sin eventos todavía.</span>}
    </section>
  </>;
}
const LEVEL: Record<string, string> = { yes: 'sí', partial: 'parcial', no: 'no' };
const HARNESS_NAME: Record<string, string> = Object.fromEntries(HARNESSES.map(h => [h.id, h.name]));
const EVENT_TEXT: Record<string, string> = { created: 'Creado', imported: 'Importado', exported: 'Exportado', harness_changed: 'Arnés cambiado', department_changed: 'Cambio de departamento', folder_created: 'Carpeta creada', folder_adopted: 'Cambios externos adoptados', folder_discarded: 'Cambios externos descartados', folder_restored: 'Vuelta a una revisión anterior', identity_updated: 'Identidad editada', memory_proposed: 'Aprendizaje propuesto', memory_verified: 'Aprendizaje verificado', memory_retired: 'Aprendizaje retirado', task_created: 'Encargo creado', chat: 'Conversación',
  source_imported: 'Integrado desde su carpeta', source_adopted: 'Cambios externos adoptados', source_grants: 'Permisos cambiados', source_restored: 'Vuelta a una versión anterior', integration_state: 'Estado de integración', document_job: 'Documento', improvement_proposed: 'Mejora propuesta', improvement_applied: 'Mejora aplicada', improvement_rejected: 'Mejora rechazada' };
const INTEGRATION_TO: Record<string, string> = { pending: 'pendiente', evaluating: 'en evaluación', integrated: 'integrado' };
const JOB_ACTION: Record<string, string> = { received: 'recibido', run: 'en proceso', ready: 'pasó las comprobaciones', rejected: 'no pasó las comprobaciones' };

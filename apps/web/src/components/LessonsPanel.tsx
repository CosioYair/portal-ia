import { useEffect, useState } from 'react';
import type { Lesson } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Chip, Icon, Notice } from './ui.tsx';

const STATUS: Record<string, { label: string; tone: '' | 'ok' | 'warn' | 'err' | 'accent' }> = { detected: { label: 'detectada', tone: 'warn' }, proposed: { label: 'propuesta', tone: 'accent' }, validated: { label: 'validada', tone: 'ok' }, rejected: { label: 'rechazada', tone: '' }, obsolete: { label: 'obsoleta', tone: '' } };
const ROLE: Record<string, string> = { planner: 'planificador', implementer: 'implementador', reviewer: 'revisor', consultant: 'consultor' };

/**
 * Lecciones de la organización (M4): detectadas sin IA → propuestas (una llamada autorizada) → validadas por el
 * propietario (se inyectan en los prompts por papel) → promovidas a práctica de plantilla (M5).
 */
export function LessonsPanel({ projectId }: { projectId: string }) {
  const { status, flash } = useApp();
  const slug = status.workspace!.slug;
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [filter, setFilter] = useState<'open' | 'validated' | 'all'>('open');
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [auth, setAuth] = useState(false);
  const [est, setEst] = useState<{ agentName: string; estimatedUsd: number } | null>(null);
  const [newTitle, setNewTitle] = useState(''); const [newText, setNewText] = useState(''); const [newRole, setNewRole] = useState<string>('implementer');

  const load = async () => { try { const l = await api.lessons(slug, projectId); setLessons(l); } catch (e: any) { setErr(e.message); setLessons([]); } };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, projectId]);
  const cur = lessons?.find(l => l.id === sel) ?? null;
  useEffect(() => { setText(cur?.lessonText ?? ''); setAuth(false); setEst(null); if (cur && cur.status === 'detected') api.lessonProposeEstimate(slug, cur.id).then(setEst).catch(() => setEst(null)); }, [cur?.id, cur?.lessonText, cur?.status, slug]);

  const act = async (key: string, fn: () => Promise<any>, msg: string) => { setBusy(key); setErr(null); try { await fn(); flash(msg); await load(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); } };
  const shown = (lessons ?? []).filter(l => filter === 'all' ? true : filter === 'validated' ? l.status === 'validated' : l.status === 'detected' || l.status === 'proposed');

  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
    <div style={{ flex: '1 1 300px', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{(['open', 'validated', 'all'] as const).map(f => <button key={f} className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(f)}>{f === 'open' ? `Pendientes (${(lessons ?? []).filter(l => l.status === 'detected' || l.status === 'proposed').length})` : f === 'validated' ? `Validadas (${(lessons ?? []).filter(l => l.status === 'validated').length})` : 'Todas'}</button>)}</div>
      {lessons && shown.length === 0 && <p className="muted sm13" style={{ margin: '8px 0' }}>{filter === 'open' ? 'Sin lecciones pendientes. Se detectan solas cuando una historia falla de forma objetiva (parche que no encaja, QA no aprueba, verificación fallida…).' : 'Nada aquí todavía.'}</p>}
      {shown.map(l => <button key={l.id} className={`rail-i ${l.id === sel ? 'is-active' : ''}`} onClick={() => setSel(l.id)} style={{ alignItems: 'flex-start' }}>
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{l.title}</span><span className="small muted"><Chip tone={STATUS[l.status]?.tone ?? ''} xs>{STATUS[l.status]?.label ?? l.status}</Chip> v{l.version}{l.role ? ` · ${ROLE[l.role] ?? l.role}` : ''}{l.usedCount ? ` · usada ${l.usedCount}×` : ''}{l.recurrenceCount ? ` · ⚠ reincidió ${l.recurrenceCount}×` : ''}{l.promotedTo ? ` · práctica ${l.promotedTo}` : ''}</span></span></button>)}
      <details style={{ marginTop: 8 }}><summary className="small muted" style={{ cursor: 'pointer' }}>Escribir una lección a mano</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          <input className="input" placeholder="Título" value={newTitle} onChange={e => setNewTitle(e.target.value)} />
          <textarea className="input" style={{ minHeight: 70 }} placeholder="Instrucción imperativa que se añadirá a los prompts (≥ 10 caracteres)" value={newText} onChange={e => setNewText(e.target.value)} />
          <select className="input" value={newRole} onChange={e => setNewRole(e.target.value)}>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>Para el {v}</option>)}<option value="">Para todos los papeles</option></select>
          <button className="btn btn-primary btn-sm" disabled={busy !== null || newTitle.trim().length < 3 || newText.trim().length < 10} onClick={() => act('new', async () => { await api.createLesson(slug, { projectId, title: newTitle.trim(), lessonText: newText.trim(), role: (newRole || null) as any }); setNewTitle(''); setNewText(''); }, 'Lección guardada y validada')}>Guardar como validada</button>
        </div></details>
    </div>
    <div style={{ flex: '999 1 420px', minWidth: 0 }}>
      {err && <Notice kind="err">{err}</Notice>}
      {!cur && <p className="muted sm13">Selecciona una lección. Solo las <strong>validadas</strong> se inyectan en los prompts de los agentes (por proyecto y papel); cada paso registra cuáles usó, y si el mismo error vuelve a ocurrir con la lección presente, se marca como reincidencia.</p>}
      {cur && <div className="card">
        <div className="card-h"><div><div className="h3">{cur.title}</div><div className="small muted">Detector <span className="mono">{cur.detector}</span> · origen {cur.source} · versión {cur.version} · {new Date(cur.createdAt).toLocaleString()}</div></div><Chip tone={STATUS[cur.status]?.tone ?? ''}>{STATUS[cur.status]?.label}</Chip></div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div><div className="eyebrow" style={{ marginBottom: 4 }}>Evidencia</div><div className="sm13">{cur.evidence.processTitle && <>Proceso <strong>{cur.evidence.processTitle}</strong>{cur.evidence.processId && <> · <a className="lnk" href={`/procesos/${cur.evidence.processId}`}>ver</a></>}<br /></>}{cur.evidence.agentName && <>Agente: {cur.evidence.agentName}{cur.role ? ` (${ROLE[cur.role]})` : ''}<br /></>}{cur.evidence.file && <>Archivo: <span className="mono">{cur.evidence.file}</span><br /></>}<span className="muted">{cur.evidence.detail}</span></div></div>
          {cur.rootCause && <div><div className="eyebrow" style={{ marginBottom: 4 }}>Causa raíz</div><div className="sm13">{cur.rootCause}</div></div>}
          {cur.correctiveAction && <div><div className="eyebrow" style={{ marginBottom: 4 }}>Acción correctiva</div><div className="sm13">{cur.correctiveAction}</div></div>}
          <div><div className="eyebrow" style={{ marginBottom: 4 }}>Lección (texto que se inyecta en el prompt)</div>
            {cur.status === 'validated' || cur.status === 'rejected' || cur.status === 'obsolete' ? <div className="sm13" style={{ padding: 10, background: '#FAF9F6', borderRadius: 8 }}>{cur.lessonText ?? '—'}</div>
              : <textarea className="input" style={{ minHeight: 80 }} value={text} onChange={e => setText(e.target.value)} placeholder="Escríbela tú o pide una propuesta al Coordinador (una llamada de IA, con tu autorización)." />}
          </div>
          {cur.recurrenceCount > 0 && <Notice kind="warn">Esta lección estaba inyectada y el mismo error volvió a ocurrir {cur.recurrenceCount} vez/veces: candidata a obsoleta. Revísala, edítala (crea una versión nueva) o márcala obsoleta.</Notice>}
          {cur.status === 'detected' && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo una llamada a {est?.agentName ?? 'el Coordinador'} ({est ? `≈ ${est.estimatedUsd.toFixed(3)} USD` : 'estimación…'}) para proponer causa raíz, acción correctiva y texto de la lección.</span></label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" disabled={!auth || busy !== null} onClick={() => act('propose', () => api.lessonPropose(slug, cur.id), 'Propuesta recibida: revísala y valida')}>{busy === 'propose' ? <span className="spin spin-light" /> : Icon.arrow()}Proponer con IA</button>
              <button className="btn btn-secondary btn-sm" disabled={busy !== null || text.trim().length < 10} onClick={() => act('validate', () => api.lessonValidate(slug, cur.id, { lessonText: text.trim() }), 'Lección validada: se inyectará en los prompts')}>Validar con mi texto</button>
              <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => act('reject', () => api.lessonReject(slug, cur.id), 'Lección rechazada')}>Rechazar</button>
            </div></div>}
          {cur.status === 'proposed' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" disabled={busy !== null || text.trim().length < 10} onClick={() => act('validate', () => api.lessonValidate(slug, cur.id, { lessonText: text.trim() }), 'Lección validada: se inyectará en los prompts')}>{Icon.check()}Validar (editable arriba)</button>
            <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => act('reject', () => api.lessonReject(slug, cur.id), 'Lección rechazada')}>Rechazar</button>
          </div>}
          {cur.status === 'validated' && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <details><summary className="small muted" style={{ cursor: 'pointer' }}>Editar (crea la versión {cur.version + 1}; la {cur.version} queda obsoleta)</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}><textarea className="input" style={{ minHeight: 70 }} value={text} onChange={e => setText(e.target.value)} /><div><button className="btn btn-secondary btn-sm" disabled={busy !== null || text.trim().length < 10 || text.trim() === cur.lessonText} onClick={() => act('edit', () => api.lessonValidate(slug, cur.id, { lessonText: text.trim() }), `Versión ${cur.version + 1} creada`)}>Guardar nueva versión</button></div></div></details>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {!cur.promotedTo && cur.role && <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => { if (!confirm(`Promover a práctica de la plantilla del ${ROLE[cur.role!]}: se crea una versión nueva de la plantilla. Los agentes existentes NO cambian hasta que los actualices; los nuevos la heredan.`)) return; void act('promote', () => api.lessonPromote(slug, cur.id), 'Práctica añadida a una nueva versión de la plantilla'); }}>{Icon.arrow()}Promover a práctica de plantilla</button>}
              {cur.promotedTo && <Chip tone="ok" xs>práctica en {cur.promotedTo}</Chip>}
              <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => act('obsolete', () => api.lessonObsolete(slug, cur.id), 'Lección marcada obsoleta')}>Marcar obsoleta</button>
            </div></div>}
        </div>
      </div>}
    </div>
  </div>;
}

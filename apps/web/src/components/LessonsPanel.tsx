import { useEffect, useState } from 'react';
import type { Lesson } from '@portal-ia/domain';
import { api, type LessonCurateSummary } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Chip, Notice } from './ui.tsx';

/** EN-020: alcance de cada lección aplicada (lo añade el servidor). */
type LessonReach = Lesson & { templateVersion?: string | null; agents?: number };
const agentsText = (n: number) => `${n} ${n === 1 ? 'agente' : 'agentes'}`;
function reachText(l: LessonReach): string {
  if (typeof l.agents !== 'number') return 'Alcance sin datos todavía';
  if (!l.role) return `Sin papel: se añade a todos los prompts del proyecto, no a una plantilla · llega a ${agentsText(l.agents)}`;
  if (l.templateVersion) return `En la plantilla ${l.templateVersion} · llega a ${agentsText(l.agents)}`;
  return 'Aún no está en la plantilla de su papel: el Portal la añade solo';
}

const STATUS: Record<string, { label: string; tone: '' | 'ok' | 'warn' | 'err' | 'accent' }> = { detected: { label: 'detectada', tone: 'warn' }, proposed: { label: 'propuesta', tone: 'accent' }, validated: { label: 'aplicada', tone: 'ok' }, rejected: { label: 'rechazada', tone: '' }, obsolete: { label: 'obsoleta', tone: '' }, refuted: { label: 'retirada: el error volvió', tone: 'warn' } };
const ROLE: Record<string, string> = { planner: 'planificador', implementer: 'implementador', reviewer: 'revisor', consultant: 'consultor' };

/**
 * Lecciones de la organización (HU-202): se detectan sin IA y el Curador de Aprendizaje las agrupa y aplica solo al
 * terminar cada tarea (0 USD). Aquí solo se ven las aplicadas; el propietario puede editarlas o retirarlas.
 */
export function LessonsPanel({ projectId }: { projectId: string }) {
  const { status, flash } = useApp();
  const slug = status.workspace!.slug;
  const [lessons, setLessons] = useState<LessonReach[] | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [curating, setCurating] = useState(false);
  const [curateErr, setCurateErr] = useState<string | null>(null);
  const [curateRes, setCurateRes] = useState<LessonCurateSummary | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');


  const [newTitle, setNewTitle] = useState(''); const [newText, setNewText] = useState(''); const [newRole, setNewRole] = useState<string>('implementer');

  const load = async () => {
    try { const l = await api.lessons(slug, projectId, 'validated'); setLessons(l); } catch (e: any) { setErr(e.message); setLessons([]); }
    try { const d = await api.lessons(slug, projectId, 'detected'); setPending(d.length); } catch { setPending(null); }
  };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, projectId]);
  const cur = lessons?.find(l => l.id === sel) ?? null;
  useEffect(() => { setText(cur?.lessonText ?? ''); }, [cur?.id, cur?.lessonText]);

  const act = async (key: string, fn: () => Promise<any>, msg: string) => { setBusy(key); setErr(null); try { await fn(); flash(msg); await load(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); } };
  const shown = (lessons ?? []).filter(l => l.status === 'validated');
  const runCurate = async () => {
    if (!confirm(`El Curador de Aprendizaje agrupará por causa las ${pending ?? 0} detecciones sin depurar: aplicará una lección por causa útil y descartará los duplicados y el ruido del proveedor. No llama a la IA (0 USD). ¿Continuar?`)) return;
    setCurating(true); setCurateErr(null); setCurateRes(null);
    try { const r = await api.lessonsCurate(slug, projectId); setCurateRes(r); flash(`Curador: ${r.applied} aplicadas, ${r.merged} agrupadas, ${r.discarded} descartadas`); await load(); }
    catch (e: any) { setCurateErr(e.message); }
    finally { setCurating(false); }
  };

  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
    <div style={{ flex: '1 1 300px', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="small muted" data-testid="lecciones-aplicadas">Lecciones aplicadas ({shown.length}). El Curador de Aprendizaje las aplica solo al terminar cada tarea. Cada lección con papel entra sola en la plantilla de su papel y llega a sus agentes, sin que tengas que hacer nada.</div>
      {pending !== null && pending > 0 && <Notice kind="warn"><div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span>{pending} {pending === 1 ? 'detección sin depurar' : 'detecciones sin depurar'}.</span><div><button className="btn btn-secondary btn-sm" disabled={curating || busy !== null} onClick={() => void runCurate()}>{curating ? <span className="spin" /> : null}Depurar con el Curador (sin IA, 0 USD)</button></div></div></Notice>}
      {curating && <p className="small muted" style={{ margin: 0 }}>Depurando las detecciones pendientes…</p>}
      {curateErr && <Notice kind="err">No se pudo depurar: {curateErr}</Notice>}
      {curateRes && <Notice kind="ok">Depuración hecha: {curateRes.applied} aplicadas, {curateRes.merged} agrupadas y {curateRes.discarded} descartadas ({curateRes.groups} causas).</Notice>}
      {lessons === null && <p className="muted sm13" style={{ margin: '8px 0' }}>Cargando lecciones…</p>}
      {lessons && shown.length === 0 && <p className="muted sm13" style={{ margin: '8px 0' }}>Aún no hay lecciones aplicadas. El Curador las aplica solo al terminar cada tarea.</p>}
      {shown.map(l => <button key={l.id} className={`rail-i ${l.id === sel ? 'is-active' : ''}`} onClick={() => setSel(l.id)} style={{ alignItems: 'flex-start' }}>
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{l.title}</span><span className="small muted"><Chip tone={l.provenAt ? 'ok' : ''} xs>{l.provenAt ? 'Demostrada' : 'Sin demostrar aún'}</Chip> {l.role ? ROLE[l.role] ?? l.role : 'todos los papeles'} · usada {l.usedCount ?? 0} {(l.usedCount ?? 0) === 1 ? 'vez' : 'veces'}{l.recurrenceCount ? ` · ⚠ reincidió ${l.recurrenceCount}×` : ''}</span><span className="small muted" data-testid="leccion-alcance">{reachText(l)}</span></span></button>)}
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
      {!cur && <p className="muted sm13">Selecciona una lección. Solo las <strong>aplicadas</strong> se inyectan en los prompts de los agentes (por proyecto y papel); cada paso registra cuáles usó, y si el mismo error vuelve a ocurrir con la lección presente, se marca como reincidencia.</p>}
      {cur && <div className="card">
        <div className="card-h"><div><div className="h3">{cur.title}</div><div className="small muted">Detector <span className="mono">{cur.detector}</span> · origen {cur.source} · versión {cur.version} · {new Date(cur.createdAt).toLocaleString()}</div></div><Chip tone={STATUS[cur.status]?.tone ?? ''}>{STATUS[cur.status]?.label}</Chip></div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div><div className="eyebrow" style={{ marginBottom: 4 }}>Evidencia</div><div className="sm13">{cur.evidence.processTitle && <>Proceso <strong>{cur.evidence.processTitle}</strong>{cur.evidence.processId && <> · <a className="lnk" href={`/procesos/${cur.evidence.processId}`}>ver</a></>}<br /></>}{cur.evidence.agentName && <>Agente: {cur.evidence.agentName}{cur.role ? ` (${ROLE[cur.role]})` : ''}<br /></>}{cur.evidence.file && <>Archivo: <span className="mono">{cur.evidence.file}</span><br /></>}<span className="muted">{cur.evidence.detail}</span></div></div>
          {cur.rootCause && <div><div className="eyebrow" style={{ marginBottom: 4 }}>Causa raíz</div><div className="sm13">{cur.rootCause}</div></div>}
          {cur.correctiveAction && <div><div className="eyebrow" style={{ marginBottom: 4 }}>Acción correctiva</div><div className="sm13">{cur.correctiveAction}</div></div>}
          <div><div className="eyebrow" style={{ marginBottom: 4 }}>Lección (texto que se inyecta en el prompt)</div>
            {cur.status === 'validated' || cur.status === 'rejected' || cur.status === 'obsolete' || cur.status === 'refuted' ? <div className="sm13" style={{ padding: 10, background: 'var(--color-surface-alt)', borderRadius: 8 }}>{cur.lessonText ?? '—'}</div>
              : <textarea className="input" style={{ minHeight: 80 }} value={text} onChange={e => setText(e.target.value)} placeholder="Escríbela tú o pide una propuesta al Coordinador (una llamada de IA, con tu autorización)." />}
          </div>
          {cur.status === 'validated' && <div className="small" data-testid="leccion-alcance-detalle"><strong>Dónde está:</strong> {reachText(cur)}.</div>}
          {cur.status === 'validated' && <div className="small muted">Medición: {cur.usedCount ? <>inyectada en {cur.usedCount} paso(s); {cur.recurrenceCount ? `el mismo error volvió a ocurrir ${cur.recurrenceCount} vez/veces con ella presente.` : 'sin reincidencias: por ahora el error no se ha repetido con ella presente.'}</> : 'aún sin medir: ninguna historia la ha usado desde que se validó.'}</div>}
          {/* Aprendida solo cuando una tarea POSTERIOR la demuestra (terminó verificada sin repetir su error). */}
          {cur.status === 'validated' && <div className="small" data-testid="leccion-prueba">{cur.provenAt ? <><strong>Aprendida:</strong> la demostró una tarea posterior el {new Date(cur.provenAt).toLocaleDateString('es-MX')} (terminó verificada sin repetir su error).{cur.proof?.at(-1)?.result === 'recurred' ? ' Después su error volvió a ocurrir con ella presente: si se repite otra vez seguida, se retirará sola.' : ''}</> : <><strong>Validada, pendiente de demostrar:</strong> se considerará aprendida cuando una tarea posterior que la lleve termine verificada sin repetir su error.</>}</div>}
          {(cur.proof?.length ?? 0) > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{cur.proof!.slice(-4).map(p => <li key={p.processId}>{p.result === 'held' ? '✓' : '✗'} {p.processTitle ?? p.processId}: {p.detail}</li>)}</ul>}


          {cur.recurrenceCount > 0 && cur.status === 'validated' && <Notice kind="warn">Esta lección estaba inyectada y el mismo error volvió a ocurrir {cur.recurrenceCount} vez/veces: candidata a obsoleta. Revísala, edítala (crea una versión nueva) o márcala obsoleta.</Notice>}

          {cur.status === 'validated' && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <details><summary className="small muted" style={{ cursor: 'pointer' }}>Editar (crea la versión {cur.version + 1}; la {cur.version} queda obsoleta)</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}><textarea className="input" style={{ minHeight: 70 }} value={text} onChange={e => setText(e.target.value)} /><div><button className="btn btn-secondary btn-sm" disabled={busy !== null || text.trim().length < 10 || text.trim() === cur.lessonText} onClick={() => { if (!confirm(`Guardar el texto editado como versión ${cur.version + 1}: es la que se inyectará desde ahora y la ${cur.version} queda obsoleta.`)) return; void act('edit', () => api.lessonValidate(slug, cur.id, { lessonText: text.trim() }), `Versión ${cur.version + 1} creada`); }}>Guardar nueva versión</button></div></div></details>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => { if (!confirm('Retirar esta lección: deja de inyectarse en los prompts, sale de la plantilla de su papel (versión nueva que sus agentes adoptan solos) y desaparece de esta lista. El Curador no volverá a aplicar sola la misma causa.')) return; void act('obsolete', () => api.lessonObsolete(slug, cur.id), 'Lección retirada: ya no se inyecta ni está en la plantilla'); }}>Retirar</button>
            </div></div>}
        </div>
      </div>}
    </div>
  </div>;
}

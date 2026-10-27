import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PhaseTransition, PhaseTransitionPreview } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { BACKLOG_STATUS, fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { Chip, Icon, KV, Notice } from '../components/ui.tsx';

const PROC_LABEL: Record<string, string> = { running: 'en ejecución', done: 'terminados', pending_authorization: 'pendientes de autorización', failed: 'con errores', cancelled: 'cancelados', budget_exceeded: 'presupuesto agotado' };
const DECISION_LABEL: Record<string, string> = { process_authorization: 'autorizar proceso', apply_diff: 'revisar diff', integrate: 'integrar', publish: 'publicar', backlog_proposal: 'propuestas al backlog' };

/**
 * Nueva etapa: archiva (de forma reversible) todo el trabajo activo del proyecto y registra la línea base, sin tocar
 * agentes, conocimiento, lecciones, conversaciones, presupuestos ni git. Vista previa primero; decide el propietario.
 */
export function Phase() {
  const { status, flash, navigate } = useApp();
  const ws = status.workspace!; const projectId = status.project!.id;
  const [current, setCurrent] = useState<PhaseTransition | null>(null);
  const [transitions, setTransitions] = useState<PhaseTransition[]>([]);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<PhaseTransitionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auth, setAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revertAuth, setRevertAuth] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const ph = await api.phase(ws.slug, projectId);
      setCurrent(ph.current); setTransitions(ph.transitions);
      const n = name || ph.defaultName; if (!name) setName(n);
      setPreview(await api.phasePreview(ws.slug, projectId, n));
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug, projectId]);

  const start = async () => {
    if (!auth || !preview?.canStart) return; setBusy(true);
    try { const t = await api.startPhase(ws.slug, projectId, name.trim()); flash(`Etapa «${t.name}» iniciada: ${t.summary.archivedStories.length} historias y ${t.summary.archivedProcesses.length} procesos archivados`); setAuth(false); navigate('/backlog'); }
    catch (e: any) { setError(e.message); flash(e.message, 'err'); await load(); } finally { setBusy(false); }
  };
  const revert = async () => {
    if (!current || !revertAuth) return; setBusy(true);
    try { await api.revertPhase(ws.slug, projectId, current.id, 'revertida por el propietario'); flash('Etapa revertida: el trabajo archivado vuelve al backlog activo'); setRevertAuth(false); await load(); }
    catch (e: any) { flash(e.message, 'err'); } finally { setBusy(false); }
  };

  const p = preview; const nothingActive = !!p && p.stories.total === 0 && p.processes.total === 0;
  return (
    <Shell crumb="Nueva etapa">
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1000 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="eyebrow">Etapas del proyecto</div>
          <h1 className="h1" style={{ fontSize: 26 }}>Empezar una etapa nueva sin perder el conocimiento</h1>
          <p className="med" style={{ maxWidth: '78ch', lineHeight: 1.55 }}>Archiva el trabajo activo (historias, procesos y decisiones pendientes) para que el backlog quede vacío, y registra en Conocimiento una <strong>línea base</strong> del proyecto. Nada se borra: agentes, conversaciones, lecciones, plantillas, costos y git quedan intactos, y lo archivado se puede consultar, restaurar o revertir. No consume IA.</p>
        </div>
        {error && <Notice kind="err">{error}</Notice>}

        {current && <section className="card">
          <div className="card-h"><div><div className="h3">Etapa vigente · {current.name}</div><div className="small muted">Desde {new Date(current.startedAt).toLocaleString('es-MX')} · commit {current.gitHead?.slice(0, 7) ?? '—'} · {current.summary.archivedStories.length} historias y {current.summary.archivedProcesses.length} procesos archivados</div></div>
            <div style={{ display: 'flex', gap: 8 }}><Link className="btn btn-ghost btn-sm" to="/conocimiento">Ver línea base</Link><Link className="btn btn-secondary btn-sm" to="/archivo">Archivo histórico</Link></div></div>
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <details><summary className="small" style={{ cursor: 'pointer' }}>Revertir esta etapa (devuelve al backlog activo exactamente lo que archivó)</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                <label className="ck"><input className="cb" type="checkbox" checked={revertAuth} onChange={e => setRevertAuth(e.target.checked)} /><span>Autorizo devolver al flujo activo las {current.summary.archivedStories.length} historias y {current.summary.archivedProcesses.length} procesos archivados por esta etapa. La línea base se conserva en Conocimiento.</span></label>
                <div><button className="btn btn-secondary btn-sm" onClick={revert} disabled={!revertAuth || busy}>Revertir la etapa</button></div>
              </div></details>
          </div>
        </section>}

        {!p && !error && <div className="muted sm13" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="spin" /> Leyendo el estado del proyecto y de git…</div>}

        {p && <>
          {nothingActive && current && <Notice kind="ok">No hay trabajo activo: el backlog ya está vacío en esta etapa. <Link className="lnk" to="/backlog">Ir al backlog</Link>.</Notice>}
          {!(nothingActive && current) && <section className="card" aria-labelledby="ph-new">
            <div className="card-h"><div className="h3" id="ph-new">Vista previa de la nueva etapa</div><Chip xs>sin IA · reversible</Chip></div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div><label className="label" htmlFor="ph-name">Nombre de la etapa</label><input id="ph-name" className="input" value={name} onChange={e => setName(e.target.value)} onBlur={() => void load()} maxLength={120} /></div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 16 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="eyebrow">Se archiva (sale del flujo activo)</div>
                  <KV k="Historias">{p.stories.total} {p.stories.total > 0 && <span className="muted">({Object.entries(p.stories.byStatus).map(([k, v]) => `${BACKLOG_STATUS[k]?.label.toLowerCase() ?? k}: ${v}`).join(', ')})</span>}</KV>
                  <KV k="Procesos">{p.processes.total} {p.processes.total > 0 && <span className="muted">({Object.entries(p.processes.byStatus).map(([k, v]) => `${PROC_LABEL[k] ?? k}: ${v}`).join(', ')})</span>}</KV>
                  <KV k="Decisiones pendientes">{p.pendingDecisions.length} {p.pendingDecisions.length > 0 && <span className="muted">({Object.entries(p.pendingDecisions.reduce<Record<string, number>>((a, d) => { a[d.kind] = (a[d.kind] ?? 0) + 1; return a; }, {})).map(([k, v]) => `${DECISION_LABEL[k] ?? k}: ${v}`).join(', ')})</span>}</KV>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="eyebrow">Se conserva intacto</div>
                  <KV k="Agentes y plantillas">{p.preserved.agents} agentes · {p.preserved.templates} plantillas</KV>
                  <KV k="Conocimiento">{p.preserved.knowledgeDocs} documentos (+1 línea base)</KV>
                  <KV k="Lecciones">{p.preserved.lessonsValidated} validadas · {p.preserved.lessonsPending} por revisar</KV>
                  <KV k="Conversaciones">{p.preserved.assistantMessages} del asistente · {p.preserved.storyMessages} de historias</KV>
                  <KV k="Historial de uso">{p.preserved.executionHistory} registros · {fmtUsd(p.preserved.recordedCostUsd)}</KV>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="eyebrow">Repositorio (solo lectura: la etapa no toca git)</div>
                <KV k="Rama y commit">{p.git.branch ?? '—'} · <span className="mono">{p.git.head?.slice(0, 7) ?? '—'}</span>{p.git.headSubject ? ` · ${p.git.headSubject}` : ''}</KV>
                <KV k="Sin publicar">{p.git.aheadOfRemote === null ? '—' : `${p.git.aheadOfRemote} commit(s)`}{p.git.dirty ? ' · hay cambios sin confirmar' : ''}</KV>
                {p.git.unmergedBranches.length > 0 && <Notice kind="info">Ramas de historia con commits fuera de la rama principal: {p.git.unmergedBranches.map(b => `${b.name} (+${b.ahead})`).join(', ')}. Se conservan tal cual: no se integran ni se borran.</Notice>}
                {p.git.worktrees.some(w => w.dirty) && <Notice kind="warn">Hay worktrees con cambios sin integrar: {p.git.worktrees.filter(w => w.dirty).map(w => w.path).join(', ')}. Se conservan tal cual.</Notice>}
              </div>

              {p.running.length > 0 && <Notice kind="err"><div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><strong>No se puede iniciar mientras haya procesos en ejecución.</strong>
                {p.running.map(r => <div key={r.id}>{r.title} · <button className="lnk" onClick={() => navigate(`/procesos/${r.id}`)}>abrir el proceso</button> (cancelarlo es tu decisión, desde su pantalla)</div>)}</div></Notice>}

              <details><summary className="small" style={{ cursor: 'pointer' }}>Ver la línea base que se guardará en Conocimiento</summary>
                <div style={{ maxHeight: 420, overflow: 'auto', marginTop: 8, padding: '8px 12px', border: '1px solid #EEECE6', borderRadius: 8 }}><Markdown text={p.baselinePreview} /></div></details>

              <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} disabled={!p.canStart} /><span>Autorizo archivar el trabajo activo de este proyecto e iniciar la etapa <strong>{name || p.phaseName}</strong>. Entiendo que es reversible y que no se borra nada.</span></label>
              <div><button className="btn btn-primary" onClick={start} disabled={!auth || busy || !p.canStart || name.trim().length < 3}>{busy ? <span className="spin spin-light" /> : Icon.arrow()}{busy ? 'Iniciando…' : 'Iniciar la etapa'}</button></div>
            </div>
          </section>}
        </>}

        {transitions.length > 0 && <section className="card">
          <div className="card-h"><div className="h3">Registro de etapas</div></div>
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {transitions.map(t => <div key={t.id} className="rrow"><span style={{ flex: 1 }}><strong>{t.name}</strong> <span className="small muted">· {new Date(t.startedAt).toLocaleString('es-MX')} · {t.summary.archivedStories.length} historias, {t.summary.archivedProcesses.length} procesos archivados</span></span>{t.revertedAt ? <Chip xs>revertida {new Date(t.revertedAt).toLocaleDateString('es-MX')}</Chip> : <Chip xs tone="ok">vigente</Chip>}</div>)}
          </div>
        </section>}
      </main>
    </Shell>
  );
}

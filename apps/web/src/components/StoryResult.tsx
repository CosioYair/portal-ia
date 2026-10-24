import { useState } from 'react';
import type { Process } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Chip, Icon, KV, Notice } from './ui.tsx';
import { Markdown } from './Markdown.tsx';
import { StoryOverview } from './StoryOverview.tsx';

/** Resultado de la ejecución de una historia: plan, cambios propuestos (diff), revisión QA, aplicar en rama y verificar. */
export function StoryResult({ proc, onChange }: { proc: Process; onChange: (p: Process) => void }) {
  const { status, flash } = useApp();
  const slug = status.workspace!.slug;
  const r = proc.result!;
  const [open, setOpen] = useState<string | null>(r.changes[0]?.path ?? null);
  const [authApply, setAuthApply] = useState(false);
  const [authVerify, setAuthVerify] = useState(false);
  const [branch, setBranch] = useState(() => `portal-ia/${(proc.title.split(' · ')[0] || 'cambio').toLowerCase()}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [authGit, setAuthGit] = useState(false);
  const [gitErr, setGitErr] = useState<string | null>(null);
  const isPortalRepo = slug === 'portal-ia';
  const merge = async () => { if (!authGit) return; setBusy('merge'); setGitErr(null); try { const p = await api.mergeProcess(slug, proc.id); onChange(p); flash(`Rama integrada en ${p.result?.merged?.into} · commit ${p.result?.merged?.commit}`); } catch (e: any) { setGitErr(e.message); } finally { setBusy(null); } };
  const publish = async () => { if (!authGit) return; setBusy('publish'); setGitErr(null); try { const p = await api.publishProcess(slug, proc.id); onChange(p); flash(`Publicado en ${p.result?.published?.remote}: ${p.result?.published?.branches.join(', ')}`); } catch (e: any) { setGitErr(e.message); } finally { setBusy(null); } };

  const apply = async () => { if (!authApply) return; setBusy('apply'); setErr(null); try { const p = await api.applyChanges(slug, proc.id, branch.trim() || undefined); onChange(p); flash(`Cambios aplicados en la rama ${p.result?.applied?.branch} · commit ${p.result?.applied?.commit}`); } catch (e: any) { setErr(e.message); } finally { setBusy(null); setAuthApply(false); } };
  const verify = async (cmd: 'install' | 'typecheck' | 'test' | 'build') => { if (!authVerify) return; setBusy(cmd); setErr(null); try { const p = await api.verifyProcess(slug, proc.id, cmd); onChange(p); const last = p.result?.verifications.at(-1); flash(last?.exitCode === 0 ? `${last.command}: correcto` : `${last?.command}: terminó con código ${last?.exitCode}`, last?.exitCode === 0 ? 'ok' : 'err'); } catch (e: any) { setErr(e.message); } finally { setBusy(null); } };

  const added = r.changes.reduce((a, c) => a + Math.max(0, c.after - c.before), 0);
  const applicable = r.changes.filter(c => !c.error).length;
  const canApply = proc.status === 'done' && !r.applied && !r.rejected && applicable > 0;
  const reject = async () => { const reason = prompt('¿Por qué rechazas este diff? (la historia vuelve a pendiente y podrás ejecutarla de nuevo)', 'alcance replanteado'); if (reason === null) return; setBusy('reject'); setErr(null); try { const p = await api.rejectProcess(slug, proc.id, reason.trim() || undefined); onChange(p); flash('Diff rechazado: la historia vuelve a pendiente'); } catch (e: any) { setErr(e.message); } finally { setBusy(null); } };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {proc.status === 'done' && <StoryOverview proc={proc} onChange={onChange} onClose={async () => { if (!proc.backlogItemId) return; await api.markStoryDone(slug, proc.backlogItemId); }} />}
      {err && busy === null && !canApply && <Notice kind="err">{err}</Notice>}
      {r.plan && <section className="card"><div className="card-h"><div className="h3">Plan técnico</div><Chip xs>{r.plan.tasks.length} tareas</Chip></div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p className="med" style={{ lineHeight: 1.5 }}>{r.plan.summary}</p>
          <ol style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>{r.plan.tasks.map((t, i) => <li key={i}>{t}</li>)}</ol>
          {r.plan.acceptance.length > 0 && <div><div className="eyebrow" style={{ marginBottom: 6 }}>Aceptación</div><ul style={{ paddingLeft: 20 }}>{r.plan.acceptance.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
          {r.plan.risks.length > 0 && <div><div className="eyebrow" style={{ marginBottom: 6 }}>Riesgos</div><ul style={{ paddingLeft: 20 }}>{r.plan.risks.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
        </div></section>}

      {r.changes.length > 0 && <section className="card">
        <div className="card-h"><div><div className="h3">Cambios propuestos</div><div className="small muted">{r.changes.length} archivo{r.changes.length === 1 ? '' : 's'} · +{added} líneas · aún no escritos en el repositorio</div></div>
          {r.review && <Chip tone={r.review.approve ? 'ok' : 'warn'} xs>{r.review.approve ? 'QA: aprobado' : 'QA: con observaciones'}</Chip>}</div>
        {r.implementationSummary && <div className="card-b" style={{ borderBottom: '1px solid #EEECE6' }}><Markdown text={r.implementationSummary} /></div>}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {r.changes.map(c => <div key={c.path}>
            <button className="arow" style={{ borderRadius: 0, padding: '10px 18px' }} onClick={() => setOpen(open === c.path ? null : c.path)} aria-expanded={open === c.path}>
              <Chip tone={c.error ? 'err' : c.action === 'create' ? 'ok' : c.action === 'delete' ? 'err' : 'accent'} xs>{c.error ? 'no aplicable' : c.action === 'create' ? 'nuevo' : c.action === 'delete' ? 'eliminar' : 'modificar'}</Chip>
              <span className="mono sm13" style={{ flex: 1, textAlign: 'left', textDecoration: c.error ? 'line-through' : undefined }}>{c.path}</span>
              {c.warning && <Chip tone="warn" xs>⚠ posible secreto</Chip>}
              <span className="small mono muted">{c.before} → {c.after} líneas</span>{Icon.chevR()}
            </button>
            {open === c.path && (c.error || c.warning) && <div className="card-b" style={{ padding: '8px 18px', borderTop: '1px solid #EEECE6' }}>{c.error && <Notice kind="err">{c.error} Este cambio no se escribirá; el resto sí.</Notice>}{c.warning && <Notice kind="warn">{c.warning}</Notice>}</div>}
            {open === c.path && !c.error && <pre className="mono" style={{ margin: 0, padding: '12px 18px', background: '#FAF9F6', borderTop: '1px solid #EEECE6', borderBottom: '1px solid #EEECE6', fontSize: 12, lineHeight: 1.5, overflow: 'auto', maxHeight: 480, whiteSpace: 'pre' }}>
              {(c.diff ?? '').split('\n').map((l, i) => <div key={i} style={{ color: l.startsWith('+') && !l.startsWith('+++') ? '#166534' : l.startsWith('-') && !l.startsWith('---') ? '#9A1F18' : l.startsWith('@@') ? '#686B72' : '#1A1B1E', background: l.startsWith('+') && !l.startsWith('+++') ? '#E4F3EA' : l.startsWith('-') && !l.startsWith('---') ? '#FBE7E5' : 'transparent' }}>{l || ' '}</div>)}
            </pre>}
          </div>)}
        </div>
      </section>}

      {r.review && <section className="card"><div className="card-h"><div><div className="h3">Revisión de calidad</div><div className="small muted">Lo que QA revisó del diff antes de que decidas</div></div><Chip tone={r.review.approve ? 'ok' : 'warn'} xs>{r.review.approve ? 'aprobado' : `no aprueba · ${r.review.issues.length} observaciones`}</Chip></div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Notice kind={r.review.approve ? 'ok' : 'warn'}><div><strong>{r.review.approve ? 'QA aprueba el diff.' : 'QA no aprueba el diff tal cual.'}</strong> <Markdown text={r.review.summary} /></div></Notice>
          {r.review.issues.length > 0 && <div><div className="eyebrow" style={{ marginBottom: 8 }}>Observaciones ({r.review.issues.length})</div><ol style={{ margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 10, lineHeight: 1.55 }}>{r.review.issues.map((t, i) => <li key={i}>{t}</li>)}</ol></div>}
          {r.review.suggestedTests.length > 0 && <div><div className="eyebrow" style={{ marginBottom: 8 }}>Pruebas que QA sugiere</div><ul style={{ margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8, lineHeight: 1.55 }}>{r.review.suggestedTests.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
        </div></section>}

      {r.rejected && !r.applied && <Notice kind="warn"><strong>Diff rechazado</strong> ({new Date(r.rejected.at).toLocaleString()}): {r.rejected.reason}. La historia volvió a pendiente; puedes ejecutarla de nuevo desde Backlog o con «Volver a ejecutar».</Notice>}
      {(canApply || r.applied) && <section className="card">
        <div className="card-h"><div><div className="h3">Aplicar en el repositorio</div><div className="small muted">Escritura en rama de trabajo + commit. Herramienta «Escritura en el repositorio» · requiere tu autorización por uso.</div></div>{r.applied ? <Chip tone="ok" dot="ok">aplicado</Chip> : <Chip tone="warn" xs>pendiente de tu aprobación</Chip>}</div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {r.applied ? <>
            <KV k="Rama"><span className="mono">{r.applied.branch}</span></KV>
            <KV k="Commit"><span className="mono">{r.applied.commit}</span></KV>
            <KV k="Archivos"><span className="mono">{r.applied.files.length}</span></KV>
            <div className="help">Los cambios ya están escritos <strong>en tu disco</strong>, en la rama <span className="mono">{r.applied.branch}</span> (aún no en tu rama principal ni en GitHub). Verifica abajo y, si estás conforme, intégralos y publícalos desde aquí. Si los rechazas: <span className="mono">git checkout main</span> y borra la rama.</div>
          </> : <>
            {!r.review?.approve && <Notice kind="warn">QA no aprobó sin observaciones. Puedes aplicar igualmente y corregir en la rama, o volver a ejecutar la historia con más detalle en el criterio.</Notice>}
            <div><label className="label" htmlFor="branch">Rama de trabajo</label><input id="branch" className="input mono" value={branch} onChange={e => setBranch(e.target.value)} /><div className="help">Se crea desde la rama actual del repositorio (debe estar sin cambios pendientes). Si ya existe, se reutiliza.</div></div>
            <label className="ck"><input className="cb" type="checkbox" checked={authApply} onChange={e => setAuthApply(e.target.checked)} /><span>He revisado los cambios y <strong>autorizo escribirlos</strong> en la rama indicada del repositorio registrado, con un commit a nombre de Portal IA.</span></label>
            {err && <Notice kind="err"><strong>No se pudo aplicar.</strong> {err}</Notice>}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn btn-primary" onClick={apply} disabled={!authApply || busy !== null}>{busy === 'apply' ? <span className="spin spin-light" /> : Icon.git()}{busy === 'apply' ? 'Aplicando…' : `Aplicar ${applicable} cambio${applicable === 1 ? '' : 's'} en la rama`}</button>
              <button className="btn btn-ghost" onClick={reject} disabled={busy !== null}>{busy === 'reject' ? <span className="spin" /> : null}Rechazar el diff y devolver la historia a pendiente</button>
            </div>
          </>}
        </div></section>}

      {r.applied && <section className="card">
        <div className="card-h"><div><div className="h3">Verificación</div><div className="small muted">Ejecución <strong>local</strong> en el repositorio (sin sandbox en esta versión). Herramienta «Ejecución» · requiere tu autorización por uso.</div></div>{r.verifyCommands.length > 0 && <Chip xs>sugerido: {r.verifyCommands.join(', ')}</Chip>}</div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="ck"><input className="cb" type="checkbox" checked={authVerify} onChange={e => setAuthVerify(e.target.checked)} /><span>Autorizo ejecutar comandos <span className="mono">npm</span> permitidos (install, typecheck, test, build) en la carpeta del repositorio. Nada más se ejecuta.</span></label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['install', 'typecheck', 'test', 'build'] as const).map(c => <button key={c} className="btn btn-secondary btn-sm" onClick={() => verify(c)} disabled={!authVerify || busy !== null}>{busy === c ? <span className="spin" /> : null}{c === 'install' ? 'npm install' : `npm run ${c}`}</button>)}

          </div>
          {r.verifications.map((v, i) => <div key={i} className="card" style={{ background: '#FAF9F6' }}>
            <div className="card-h" style={{ padding: '10px 14px' }}><span className="mono sm13">{v.command}</span><Chip tone={v.exitCode === 0 ? 'ok' : 'err'} xs>{v.exitCode === 0 ? 'correcto' : `código ${v.exitCode ?? '?'}`} · {(v.durationMs / 1000).toFixed(1)} s</Chip></div>
            <pre className="mono" style={{ margin: 0, padding: '10px 14px', fontSize: 12, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{v.output || '(sin salida)'}</pre>
          </div>)}
        </div></section>}

      {r.applied && <section className="card">
        <div className="card-h"><div><div className="h3">Integrar y publicar</div><div className="small muted">Herramienta «Escritura en el repositorio» · cada acción requiere tu autorización por uso. Hasta aquí nada ha salido de tu equipo.</div></div>
          <div style={{ display: 'flex', gap: 6 }}>{r.merged && <Chip tone="ok" xs dot="ok">integrada en {r.merged.into}</Chip>}{r.published && <Chip tone="ok" xs dot="ok">publicada en {r.published.remote}</Chip>}</div></div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {r.merged && <KV k="Integración"><span className="mono">{r.merged.into} · {r.merged.commit}</span></KV>}
          {r.published && <KV k="Publicación"><span className="mono">{r.published.branches.join(', ')} → {r.published.url ?? r.published.remote}</span></KV>}
          {gitErr && <Notice kind="err"><strong>No se pudo completar.</strong> {gitErr}</Notice>}
          <label className="ck"><input className="cb" type="checkbox" checked={authGit} onChange={e => setAuthGit(e.target.checked)} /><span>Autorizo <strong>integrar</strong> la rama <span className="mono">{r.applied.branch}</span> en la rama principal del repositorio (merge con commit) y/o <strong>publicarla</strong> en el remoto configurado (<span className="mono">git push</span>, con las credenciales git de este equipo).</span></label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!r.merged && <button className="btn btn-primary btn-sm" onClick={merge} disabled={!authGit || busy !== null}>{busy === 'merge' ? <span className="spin spin-light" /> : Icon.git()}{busy === 'merge' ? 'Integrando…' : 'Integrar en la rama principal'}</button>}
            <button className="btn btn-secondary btn-sm" onClick={publish} disabled={!authGit || busy !== null}>{busy === 'publish' ? <span className="spin" /> : null}{r.published ? 'Volver a publicar (git push)' : 'Publicar en el remoto (git push)'}</button>
          </div>
          {isPortalRepo && r.merged && <Notice kind="info">Esta rama modifica el propio Portal IA. Para que los cambios integrados entren en funcionamiento: detén el servidor, ejecuta <span className="mono">npm install</span> (si cambió package.json), <span className="mono">npm run build</span> y vuelve a arrancar con <span className="mono">npm start</span>.</Notice>}
        </div></section>}
    </div>
  );
}

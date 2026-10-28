import { useEffect, useState } from 'react';
import type { IssueSeverity, Process } from '@portal-ia/domain';
import { qaSeverity } from '@portal-ia/domain';
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
  const appliedAt = r.applied ? new Date(r.applied.appliedAt).getTime() : 0;
  const okV = (c: string) => r.verifications.some(v => v.command === c && v.exitCode === 0 && new Date(v.startedAt).getTime() >= appliedAt - 1000);
  const canMerge = isPortalRepo ? okV('typecheck') && okV('test') && okV('build') : okV('typecheck');
  // 86 (Docker sin dependencias) es un bloqueo del entorno, no un fallo del código: no cuenta como «falló».
  const lastFailed = ['typecheck', 'build', 'test'].map(c => r.verifications.filter(v => v.command === c).at(-1)).filter(v => v && v.exitCode !== 0 && v.exitCode !== 86).map(v => v!.command).join(', ');
  const [sandbox, setSandbox] = useState<{ available: string; detail: string } | null>(null);
  const [allowNet, setAllowNet] = useState(false);
  useEffect(() => { if (r.applied && !r.merged) api.systemSandbox().then(setSandbox).catch(() => setSandbox(null)); }, [r.applied, r.merged]);
  const isoLabel = (i?: string) => i === 'docker' ? 'sandbox Docker' : i === 'wsl' ? 'sandbox WSL2' : i === 'linux-ns' ? 'sandbox Linux (namespaces)' : i === 'host-min' ? 'verificación mínima (tsc)' : i === 'unavailable' ? 'sin sandbox · no ejecutado' : '';
  const merge = async () => { if (!authGit) return; setBusy('merge'); setGitErr(null); try { const p = await api.mergeProcess(slug, proc.id); onChange(p); flash(`Rama integrada en ${p.result?.merged?.into} · commit ${p.result?.merged?.commit}`); } catch (e: any) { setGitErr(e.message); } finally { setBusy(null); } };
  const publish = async () => { if (!authGit) return; setBusy('publish'); setGitErr(null); try { const p = await api.publishProcess(slug, proc.id); onChange(p); flash(`Publicado en ${p.result?.published?.remote}: ${p.result?.published?.branches.join(', ')}`); } catch (e: any) { setGitErr(e.message); } finally { setBusy(null); } };

  const apply = async () => { if (!authApply) return; setBusy('apply'); setErr(null); try { const p = await api.applyChanges(slug, proc.id, branch.trim() || undefined); onChange(p); flash(`Cambios aplicados en la rama ${p.result?.applied?.branch} · commit ${p.result?.applied?.commit}`); } catch (e: any) { setErr(e.message); } finally { setBusy(null); setAuthApply(false); } };
  const verify = async (cmd: 'install' | 'typecheck' | 'test' | 'build') => { if (!authVerify) return; setBusy(cmd); setErr(null); try { const p = await api.verifyProcess(slug, proc.id, cmd, cmd === 'install' && allowNet); onChange(p); const last = p.result?.verifications.at(-1); flash(last?.exitCode === 0 ? `${last.command}: correcto` : `${last?.command}: terminó con código ${last?.exitCode}`, last?.exitCode === 0 ? 'ok' : 'err'); } catch (e: any) { setErr(e.message); } finally { setBusy(null); } };

  // Quién hizo cada parte (resultados por papel) y observaciones de QA ordenadas por gravedad
  const byRole = (role: string) => proc.steps.find(s => s.role === role)?.agentName ?? null;
  const SEV: Record<IssueSeverity, string> = { alta: 'Alta', media: 'Media', baja: 'Baja' };
  const qaGroups = (['alta', 'media', 'baja'] as IssueSeverity[]).map(sev => ({ sev, items: (r.review?.issues ?? []).map(qaSeverity).filter(q => q.severity === sev) })).filter(g => g.items.length);
  const lastLine = (o: string) => o.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '';
  const added = r.changes.reduce((a, c) => a + Math.max(0, c.after - c.before), 0);
  const applicable = r.changes.filter(c => !c.error).length;
  const canApply = proc.status === 'done' && !r.applied && !r.rejected && applicable > 0;
  const reject = async () => { const reason = prompt('¿Por qué rechazas este diff? (la historia vuelve a pendiente y podrás ejecutarla de nuevo)', 'alcance replanteado'); if (reason === null) return; setBusy('reject'); setErr(null); try { const p = await api.rejectProcess(slug, proc.id, reason.trim() || undefined); onChange(p); flash('Diff rechazado: la historia vuelve a pendiente'); } catch (e: any) { setErr(e.message); } finally { setBusy(null); } };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {proc.status === 'done' && <StoryOverview proc={proc} onChange={onChange} onClose={async () => { if (!proc.backlogItemId) return; await api.markStoryDone(slug, proc.backlogItemId); }} />}
      {err && busy === null && !canApply && <Notice kind="err">{err}</Notice>}
      {r.plan && <section className="card"><div className="card-h"><div><div className="h3">Plan técnico</div>{byRole('planner') && <div className="small muted">{byRole('planner')} · planifica</div>}</div><Chip xs>{r.plan.tasks.length} tareas</Chip></div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p className="med" style={{ lineHeight: 1.5 }}>{r.plan.summary}</p>
          <ol style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>{r.plan.tasks.map((t, i) => <li key={i}>{t}</li>)}</ol>
          {r.plan.acceptance.length > 0 && <div><div className="eyebrow" style={{ marginBottom: 6 }}>Aceptación</div><ul style={{ paddingLeft: 20 }}>{r.plan.acceptance.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
          {r.plan.risks.length > 0 && <div><div className="eyebrow" style={{ marginBottom: 6 }}>Riesgos</div><ul style={{ paddingLeft: 20 }}>{r.plan.risks.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
        </div></section>}

      {r.changes.length > 0 && <section className="card" id="sec-diff">
        <div className="card-h"><div><div className="h3">Cambios propuestos</div><div className="small muted">{byRole('implementer') ? `${byRole('implementer')} · ` : ''}{r.changes.length} archivo{r.changes.length === 1 ? '' : 's'} · +{added} líneas{r.applied ? '' : ' · aún no escritos en el repositorio'}</div></div>
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

      {r.review && <section className="card"><div className="card-h"><div><div className="h3">Revisión de calidad</div><div className="small muted">{byRole('reviewer') ? `${byRole('reviewer')} · ` : ''}lo que QA revisó del diff antes de que decidas</div></div><Chip tone={r.review.approve ? 'ok' : 'warn'} xs>{r.review.approve ? 'aprobado' : `no aprueba · ${r.review.issues.length} observaciones`}</Chip></div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Notice kind={r.review.approve ? 'ok' : 'warn'}><div><strong>{r.review.approve ? 'QA aprueba el diff.' : 'QA no aprueba el diff tal cual.'}</strong> <Markdown text={r.review.summary} /></div></Notice>
          {qaGroups.map(g => <div key={g.sev}><div className="eyebrow" style={{ marginBottom: 8 }}><span className={`sf-sev sf-sev-${g.sev}`}>{SEV[g.sev]}</span>Observaciones de gravedad {g.sev} ({g.items.length})</div><ol style={{ margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 10, lineHeight: 1.55 }}>{g.items.map((q, i) => <li key={i}>{q.text}</li>)}</ol></div>)}
          {r.review.suggestedTests.length > 0 && <div><div className="eyebrow" style={{ marginBottom: 8 }}>Pruebas que QA sugiere</div><ul style={{ margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8, lineHeight: 1.55 }}>{r.review.suggestedTests.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
        </div></section>}

      {r.rejected && !r.applied && <Notice kind="warn"><strong>Diff rechazado</strong> ({new Date(r.rejected.at).toLocaleString()}): {r.rejected.reason}. La historia volvió a pendiente; puedes ejecutarla de nuevo desde Backlog o con «Volver a ejecutar».</Notice>}
      {(canApply || r.applied) && <section className="card" id="sec-apply">
        <div className="card-h"><div><div className="h3">Aplicar en el repositorio</div><div className="small muted">Escritura en rama de trabajo + commit. Herramienta «Escritura en el repositorio» · requiere tu autorización por uso.</div></div>{r.applied ? <Chip tone="ok" dot="ok">aplicado</Chip> : <Chip tone="warn" xs>pendiente de tu aprobación</Chip>}</div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {r.applied ? <>
            <KV k="Rama"><span className="mono">{r.applied.branch}</span></KV>
            <KV k="Commit"><span className="mono">{r.applied.commit}</span></KV>
            <KV k="Archivos"><span className="mono">{r.applied.files.length}</span></KV>
            {r.applied.worktree && <KV k="Worktree"><span className="mono small" style={{ overflowWrap: 'anywhere' }}>{r.applied.worktree}</span></KV>}
            {!r.applied.worktree && !r.merged ? <div className="help">Aplicado <strong>antes de v0.12</strong>, directamente en tu carpeta (rama <span className="mono">{r.applied.branch}</span>), sin worktree aislado. Usa las salidas del Resumen: cerrar como resuelta o preparar otra iteración.</div> : <div className="help">Los cambios están en la rama <span className="mono">{r.applied.branch}</span>, escritos en un <strong>worktree aislado</strong> fuera de la carpeta desde la que corre el Portal (esa carpeta no cambia de rama ni se toca). Verifica abajo en sandbox y, en verde, intégralos. Si los rechazas, el worktree se retira y la rama queda sin integrar.</div>}
          </> : <>
            {!r.review?.approve && <Notice kind="warn">QA no aprobó sin observaciones. Puedes aplicar igualmente y corregir en la rama, o volver a ejecutar la historia con más detalle en el criterio.</Notice>}
            <div><label className="label" htmlFor="branch">Rama de trabajo</label><input id="branch" className="input mono" value={branch} onChange={e => setBranch(e.target.value)} /><div className="help">Nace de la rama principal en un worktree aislado (<span className="mono">&lt;repo&gt;-worktrees/&lt;proceso&gt;</span>); los cambios locales sin confirmar de tu carpeta no bloquean ni se tocan. Si la rama ya existe, se reutiliza.</div></div>
            <label className="ck"><input className="cb" type="checkbox" checked={authApply} onChange={e => setAuthApply(e.target.checked)} /><span>He revisado los cambios y <strong>autorizo escribirlos</strong> en la rama indicada del repositorio registrado, con un commit a nombre de Portal IA.</span></label>
            {err && <Notice kind="err"><strong>No se pudo aplicar.</strong> {err}</Notice>}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn btn-primary" onClick={apply} disabled={!authApply || busy !== null}>{busy === 'apply' ? <span className="spin spin-light" /> : Icon.git()}{busy === 'apply' ? 'Aplicando…' : `Aplicar ${applicable} cambio${applicable === 1 ? '' : 's'} en la rama`}</button>
              <button className="btn btn-ghost" onClick={reject} disabled={busy !== null}>{busy === 'reject' ? <span className="spin" /> : null}Rechazar el diff y devolver la historia a pendiente</button>
            </div>
          </>}
        </div></section>}

      {r.applied && <section className="card" id="sec-verify">
        <div className="card-h"><div><div className="h3">Verificación en sandbox</div><div className="small muted">El código generado se ejecuta en un contenedor aislado (Docker), en WSL2 o en espacios de nombres de Linux, nunca sobre tu carpeta del Portal. Sin sandbox, solo la verificación mínima <span className="mono">tsc --noEmit</span>.</div></div>
          <div style={{ display: 'flex', gap: 6 }}>{sandbox && <Chip tone={sandbox.available === 'unavailable' ? 'warn' : 'ok'} xs>{sandbox.available === 'unavailable' ? 'sin sandbox' : `sandbox: ${sandbox.available}`}</Chip>}{r.verifyCommands.length > 0 && <Chip xs>sugerido: {r.verifyCommands.join(', ')}</Chip>}</div></div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!r.applied.worktree && !r.merged && <Notice kind="info">Estas verificaciones son de la iteración anterior a v0.12 (se ejecutaron en tu carpeta). Esta iteración ya no se puede volver a verificar: usa las salidas del Resumen.</Notice>}
          {sandbox?.available === 'unavailable' && !r.merged && r.applied.worktree && <Notice kind="warn"><div><strong>No hay sandbox disponible.</strong> {sandbox.detail} {isPortalRepo ? 'El Portal no se integra sin test y build en sandbox: es una restricción de seguridad, no se puede desactivar.' : ''} Guía: <span className="mono">docs/sandbox.md</span>.</div></Notice>}
          {(r.applied.worktree || r.merged) && <details><summary className="small" style={{ cursor: 'pointer', marginBottom: 8 }}>Ejecutar un comando concreto (opción avanzada; la acción recomendada está arriba, en el estado de la historia)</summary><div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}><label className="ck"><input className="cb" type="checkbox" checked={authVerify} onChange={e => setAuthVerify(e.target.checked)} /><span>Autorizo ejecutar los comandos permitidos (typecheck, test, build; install solo con red confirmada) <strong>sobre el worktree del proceso, dentro del sandbox</strong>. Nada se ejecuta en la carpeta del Portal.</span></label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {(['typecheck', 'test', 'build', 'install'] as const).map(c => <button key={c} className="btn btn-secondary btn-sm" onClick={() => verify(c)} disabled={!authVerify || busy !== null || (c === 'install' && !allowNet)}>{busy === c ? <span className="spin" /> : null}{c === 'install' ? 'npm ci (install)' : `npm run ${c}`}</button>)}
            <label className="ck small" style={{ marginLeft: 4 }}><input className="cb" type="checkbox" checked={allowNet} onChange={e => setAllowNet(e.target.checked)} /><span>Permitir red <strong>solo para install</strong> (revisa antes el diff de package.json)</span></label>
          </div></div></details>}
          {r.verifications.map((v, i) => <div key={i} className="card" style={{ background: '#FAF9F6' }}>
            <div className="card-h" style={{ padding: '10px 14px' }}><span className="mono sm13">{v.command}{v.isolation ? <span className="muted"> · {isoLabel(v.isolation)}</span> : null}</span><Chip tone={v.exitCode === 0 ? 'ok' : v.exitCode === null || (v.exitCode === 86 && v.isolation === 'docker') ? 'warn' : 'err'} xs>{v.exitCode === 0 ? 'correcto' : v.exitCode === null ? 'no terminó · tiempo agotado' : v.exitCode === 86 && v.isolation === 'docker' ? 'bloqueado · faltan dependencias' : v.isolation === 'unavailable' ? 'no ejecutado · sin sandbox' : `falló · código ${v.exitCode ?? '?'}`} · {(v.durationMs / 1000).toFixed(1)} s</Chip></div>
            <details open={i === r.verifications.length - 1 && v.exitCode !== 0 && v.exitCode !== 86}><summary className="small muted" style={{ cursor: 'pointer', padding: '6px 14px' }}>{lastLine(v.output).slice(0, 160) || 'Ver la salida'}</summary>
            <pre className="mono" style={{ margin: 0, padding: '10px 14px', fontSize: 12, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{v.output || '(sin salida)'}</pre></details>
          </div>)}
        </div></section>}

      {r.applied && <section className="card" id="sec-git">
        <div className="card-h"><div><div className="h3">Integrar y publicar</div><div className="small muted">Cada acción pasa por la política de ejecución y requiere tu autorización por uso. Publicar es opcional: nada sale de tu equipo sin pulsarlo.</div></div>
          <div style={{ display: 'flex', gap: 6 }}>{r.merged && <Chip tone="ok" xs dot="ok">integrada en {r.merged.into}</Chip>}{r.published && <Chip tone="ok" xs dot="ok">publicada en {r.published.remote}</Chip>}</div></div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {r.merged && <KV k="Integración"><span className="mono">{r.merged.into} · {r.merged.commit}</span></KV>}
          {r.published && <KV k="Publicación"><span className="mono">{r.published.branches.join(', ')} → {r.published.url ?? r.published.remote}</span></KV>}
          {gitErr && <Notice kind="err"><strong>No se pudo completar.</strong> {gitErr}</Notice>}
          {!r.merged && !canMerge ? <p className="sm13 muted" style={{ margin: 0 }}>Se habilita cuando la verificación esté en verde. {lastFailed ? `Ahora falla ${lastFailed}: arriba tienes el problema y cómo corregirlo.` : 'Arriba, en el estado de la historia, tienes el siguiente paso.'}</p> : <>
          <label className="ck"><input className="cb" type="checkbox" checked={authGit} onChange={e => setAuthGit(e.target.checked)} /><span>Autorizo <strong>integrar</strong> la rama <span className="mono">{r.applied.branch}</span> en la rama principal del repositorio (merge con commit) y/o <strong>publicarla</strong> en el remoto configurado (<span className="mono">git push</span>, con las credenciales git de este equipo).</span></label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!r.merged && <button className="btn btn-primary btn-sm" onClick={merge} disabled={!authGit || busy !== null || !canMerge} title={canMerge ? '' : 'Primero verifica en sandbox'}>{busy === 'merge' ? <span className="spin spin-light" /> : Icon.git()}{busy === 'merge' ? 'Integrando…' : 'Integrar en la rama principal'}</button>}
            {!r.merged && !canMerge && <span className="small muted" style={{ alignSelf: 'center' }}>{lastFailed ? `La última verificación falló (${lastFailed}); corrige con una nueva iteración o rechaza el diff.` : isPortalRepo ? 'Para integrar el Portal hacen falta typecheck, test y build en verde en sandbox tras aplicar.' : 'Para integrar hace falta que «npm run typecheck» pase en Verificación.'}</span>}
            <button className="btn btn-secondary btn-sm" onClick={publish} disabled={!authGit || busy !== null}>{busy === 'publish' ? <span className="spin" /> : null}{r.published ? 'Volver a publicar (git push)' : 'Publicar en el remoto (git push) · opcional'}</button>
          </div></>}
          {isPortalRepo && r.merged && r.activation && !r.activation.active && <Notice kind="warn"><div><strong>Integrada, pero no activa.</strong> {r.activation.reason} El Portal en marcha corre <span className="mono">{r.activation.runningCommit ?? '?'}</span>; la interfaz servida se construyó {r.activation.buildAt ? new Date(r.activation.buildAt).toLocaleString() : 'en fecha desconocida'}. Usa «Reconstruir y reiniciar» en la barra del sistema.</div></Notice>}
          {isPortalRepo && r.merged && r.activation?.active && <Notice kind="ok"><div><strong>Activada.</strong> El servidor y la interfaz en marcha contienen el commit <span className="mono">{r.merged.commit}</span> (arrancado con <span className="mono">{r.activation.runningCommit}</span>). Falta comprobar en ejecución y probar paso a paso (arriba, en el Resumen).</div></Notice>}
        </div></section>}
    </div>
  );
}

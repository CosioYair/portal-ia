import { useEffect, useState } from 'react';
import type { Process, SystemStatus } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Chip, Icon, Notice } from './ui.tsx';
import { Markdown } from './Markdown.tsx';

/**
 * Resumen legible de una historia ejecutada y su orden de cierre:
 * 1 Revisar diff → 2 Aplicar → 3 Verificar → 4 Integrar en main → (5 Reconstruir y reiniciar, solo el Portal) →
 * 6 Probar paso a paso → 7 Publicar → 8 Cerrar. Cada paso se habilita cuando el anterior está hecho.
 */
export function StoryOverview({ proc, onChange, onClose }: { proc: Process; onChange: (p: Process) => void; onClose: () => Promise<void> }) {
  const { status, flash } = useApp();
  const slug = status.workspace!.slug;
  const isPortal = slug === 'portal-ia';
  const r = proc.result!;
  const [sys, setSys] = useState<SystemStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState(r.manualTest?.note ?? '');
  const [genEst, setGenEst] = useState<{ agentName: string; model: string; estimatedUsd: number } | null>(null);
  const [genAuth, setGenAuth] = useState(false);
  const [manualText, setManualText] = useState('');
  const [writing, setWriting] = useState(false);
  useEffect(() => { if (!r.manualTest && proc.status === 'done') api.manualTestEstimate(slug, proc.id).then(setGenEst).catch(() => setGenEst(null)); }, [r.manualTest, proc.id, proc.status, slug]);
  const generate = async () => { setBusy(true); setErr(null); try { const p = await api.manualTestGenerate(slug, proc.id); onChange(p); flash('Lista de prueba generada'); } catch (e: any) { setErr(e.message); } finally { setBusy(false); setGenAuth(false); } };
  const saveSteps = async () => { const steps = manualText.split(/\r?\n/).map(l => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(l => l.length > 3); if (!steps.length) return; setBusy(true); setErr(null); try { const p = await api.manualTestSteps(slug, proc.id, steps); onChange(p); setWriting(false); setManualText(''); flash('Pasos de prueba guardados'); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const go = (id: string) => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  useEffect(() => { if (isPortal && r.merged) api.systemStatus().then(setSys).catch(() => null); }, [isPortal, r.merged]);

  const mt = r.manualTest;
  const tested = mt ? mt.checks.filter(Boolean).length : 0;
  const allTested = !mt || tested === mt.steps.length;
  const rebuilt = !isPortal || !r.merged || (sys ? sys.action === 'none' : false);
  const rejected = !!r.rejected && !r.applied;
  const applicable = r.changes.filter(c => !c.error).length;

  type Step = { key: string; label: string; done: boolean; hint?: string; optional?: boolean; action?: { label: string; onClick: () => void } };
  const steps: Step[] = [
    { key: 'review', label: 'Revisar el diff', done: !!r.applied || rejected, hint: `${applicable} archivo(s)${r.review ? r.review.approve ? ' · QA aprobó' : ` · QA no aprueba (${r.review.issues.length} observaciones)` : ''}`, action: { label: 'Ver el diff y la revisión de QA', onClick: () => go('sec-diff') } },
    { key: 'apply', label: 'Aplicar en una rama', done: !!r.applied, hint: r.applied ? `${r.applied.branch} · ${r.applied.commit}` : undefined, action: { label: 'Ir a Aplicar', onClick: () => go('sec-apply') } },
    { key: 'verify', label: 'Verificar (typecheck obligatorio; build y test recomendados)', done: r.verifications.some(v => v.command === 'typecheck' && v.exitCode === 0 && new Date(v.startedAt).getTime() >= (r.applied ? new Date(r.applied.appliedAt).getTime() - 1000 : 0)), hint: r.verifications.length ? r.verifications.map(v => `${v.command}: ${v.exitCode === 0 ? 'ok' : 'falló'}`).join(' · ') : 'sin typecheck no se puede integrar', action: { label: 'Ir a Verificar', onClick: () => go('sec-verify') } },
    { key: 'merge', label: 'Integrar en la rama principal', done: !!r.merged, hint: r.merged ? `${r.merged.into} · ${r.merged.commit}` : undefined, action: { label: 'Ir a Integrar', onClick: () => go('sec-git') } },
    ...(isPortal ? [{ key: 'rebuild', label: 'Reconstruir y reiniciar el Portal', done: !!r.merged && rebuilt, hint: r.merged && !rebuilt ? 'usa la barra amarilla de arriba' : undefined, action: { label: 'Ir a la barra amarilla', onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) } }] : []),
    { key: 'test', label: 'Probar paso a paso', done: !!r.merged && allTested && !!mt, hint: mt ? `${tested} de ${mt.steps.length} pasos` : 'aún no hay lista de prueba: genérala o escríbela abajo', action: { label: mt ? 'Ir a la lista de prueba' : 'Crear la lista de prueba', onClick: () => go('sec-test') } },
    { key: 'publish', label: 'Publicar en GitHub', done: !!r.published, hint: r.published ? r.published.branches.join(', ') : undefined, action: { label: 'Ir a Publicar', onClick: () => go('sec-git') } },
    { key: 'close', label: 'Cerrar la historia', done: false }
  ];
  const firstPending = steps.findIndex(s => !s.done && !s.optional);
  const canClose = !!r.merged && allTested && !!mt && !!r.published;
  const closeStep = steps.length - 1;

  const toggle = async (i: number) => {
    if (!mt) return; setBusy(true); setErr(null);
    const checks = mt.checks.map((c, j) => j === i ? !c : c);
    try { const p = await api.manualTest(slug, proc.id, checks, note || null); onChange(p); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const saveNote = async () => { if (!mt) return; try { const p = await api.manualTest(slug, proc.id, mt.checks, note || null); onChange(p); } catch (e: any) { setErr(e.message); } };
  const close = async () => { setBusy(true); setErr(null); try { await onClose(); flash('Historia completada'); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };

  return <section className="card" style={{ borderColor: '#C6E2DE' }}>
    <div className="card-h"><div><div className="h3">Resumen de la historia</div><div className="small muted">Qué cambia, en qué paso vas y qué toca ahora.</div></div>{proc.guidance && <Chip tone={proc.guidance.tone === 'err' ? 'err' : proc.guidance.tone === 'ok' ? 'ok' : proc.guidance.tone === 'warn' ? 'warn' : ''} xs>{proc.guidance.phase}</Chip>}</div>
    <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {rejected && <Notice kind="warn">Este diff fue rechazado ({r.rejected!.reason}); la historia volvió a pendiente.</Notice>}
      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Qué cambia para ti y dónde verlo</div>
        {r.userFacing ? <Markdown text={r.userFacing} /> : <p className="muted sm13" style={{ margin: 0 }}>El Desarrollador no incluyó explicación para el propietario (historias anteriores a v0.11). Resumen técnico: {r.plan?.summary ?? r.implementationSummary?.slice(0, 300)}</p>}
      </div>

      <div>
        <div className="eyebrow" style={{ marginBottom: 8 }}>Orden de cierre</div>
        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {steps.map((s, i) => { const current = i === firstPending || (i === closeStep && canClose); return <li key={s.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 8, background: current ? '#FFFBF0' : s.done ? '#F2FAF5' : 'transparent', border: current ? '1px solid #F0C66B' : '1px solid transparent' }}>
            <span style={{ width: 22, height: 22, borderRadius: 999, display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 600, background: s.done ? '#166534' : current ? '#1A1B1E' : '#E5E3DC', color: s.done || current ? '#fff' : '#686B72', flex: 'none' }}>{s.done ? Icon.check(12) : i + 1}</span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}><span style={{ fontWeight: current ? 600 : 500, color: s.done ? '#166534' : '#1A1B1E' }}>{s.label}{s.optional && !s.done && <span className="small muted"> · opcional</span>}</span>{s.hint && <span className="small muted">{s.hint}</span>}
              {current && s.action && i !== closeStep && <span><button className="btn btn-primary btn-sm" onClick={s.action.onClick}>{Icon.arrow()}{s.action.label}</button></span>}</span>
          </li>; })}
        </ol>
      </div>

      {!mt && <div id="sec-test" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="eyebrow">Qué probar, paso a paso</div>
        <Notice kind="info"><div>Esta historia se ejecutó antes de que el Desarrollador entregara la lista de prueba. Puedes <strong>generarla con QA</strong> (una llamada corta{genEst ? `, ≈ ${genEst.estimatedUsd.toFixed(3)} USD, ${genEst.agentName}` : ''}) o <strong>escribir los pasos tú</strong>.</div></Notice>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label className="ck"><input className="cb" type="checkbox" checked={genAuth} onChange={e => setGenAuth(e.target.checked)} /><span>Autorizo una llamada a {genEst?.agentName ?? 'QA'} para redactar la explicación y la lista de prueba a partir del diff.</span></label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" onClick={generate} disabled={!genAuth || busy}>{busy ? <span className="spin spin-light" /> : Icon.arrow()}Generar lista de prueba con QA</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setWriting(w => !w)} disabled={busy}>Escribir los pasos a mano</button>
          </div>
          {writing && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><textarea className="input" value={manualText} onChange={e => setManualText(e.target.value)} placeholder={'Un paso por línea, por ejemplo:\n1. Abre Backlog y pulsa «Ejecutar». Esperado: se abre el diálogo.\n2. …'} style={{ minHeight: 110 }} /><div><button className="btn btn-primary btn-sm" onClick={saveSteps} disabled={busy || manualText.trim().length < 4}>Guardar pasos</button></div></div>}
        </div>
      </div>}
      {mt && <div id="sec-test">
        <div className="eyebrow" style={{ marginBottom: 6 }}>Qué probar, paso a paso · {tested} de {mt.steps.length}</div>
        {!r.merged && <p className="small muted" style={{ margin: '0 0 8px' }}>Se habilita cuando los cambios estén integrados{isPortal ? ' y el Portal reconstruido' : ''}.</p>}
        {r.merged && isPortal && !rebuilt && <Notice kind="warn">Antes de probar, reconstruye y reinicia el Portal desde la barra amarilla: ahora corre con el código anterior.</Notice>}
        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {mt.steps.map((st, i) => <li key={i}><label className="ck" style={{ alignItems: 'flex-start', opacity: r.merged ? 1 : 0.6 }}><input className="cb" type="checkbox" checked={mt.checks[i]} disabled={!r.merged || busy} onChange={() => toggle(i)} /><span style={{ lineHeight: 1.5 }}><span className="mono small muted" style={{ marginRight: 6 }}>{i + 1}.</span>{st}</span></label></li>)}
        </ol>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: 1, minWidth: 240, height: 34 }} value={note} onChange={e => setNote(e.target.value)} onBlur={saveNote} placeholder="Nota de la prueba (opcional): qué viste, qué falló…" disabled={!r.merged} />
          <button className="btn btn-ghost btn-sm" onClick={() => { setManualText(mt.steps.map((st, i) => `${i + 1}. ${st}`).join('\n')); setWriting(true); }} disabled={busy}>Editar pasos</button>
        </div>
        {writing && <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}><textarea className="input" value={manualText} onChange={e => setManualText(e.target.value)} style={{ minHeight: 110 }} /><div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" onClick={saveSteps} disabled={busy || manualText.trim().length < 4}>Guardar pasos (reinicia las marcas)</button><button className="btn btn-ghost btn-sm" onClick={() => setWriting(false)}>Cancelar</button></div></div>}
      </div>}

      {err && <Notice kind="err">{err}</Notice>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={close} disabled={!canClose || busy || !proc.backlogItemId}>{busy ? <span className="spin spin-light" /> : Icon.check()}Marcar historia como completada</button>
        {!canClose && <span className="small muted">{proc.guidance?.next}</span>}
      </div>
    </div>
  </section>;
}

import { useEffect, useState } from 'react';
import type { ManualTestFeedbackEntry, Process } from '@portal-ia/domain';
import { manualTestStepKey } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { getManualTestFeedback, saveManualTestStepFeedback } from '../lib/manualTestFeedback.ts';
import { ManualTestStepList } from './ManualTestStepList.tsx';
import { FeedbackToTeam } from './FeedbackToTeam.tsx';
import { useApp } from '../lib/store.ts';
import { Chip, Icon, Notice } from './ui.tsx';
import { Markdown } from './Markdown.tsx';

/**
 * Resumen legible de una historia ejecutada y su orden de cierre (M2):
 * 1 Revisar diff → 2 Aplicar (worktree) → 3 Verificar (sandbox) → 4 Integrar en main → [Portal: 5 Activar (reconstruir y
 * reiniciar) → 6 Comprobar en ejecución] → Probar paso a paso → Cerrar. Publicar en el remoto es opcional.
 * El orden lo decide el servidor (guidance); aquí solo se dibuja y se ofrecen los botones.
 */
export function StoryOverview({ proc, onChange, onClose }: { proc: Process; onChange: (p: Process) => void; onClose: () => Promise<void> }) {
  const { status, flash, navigate } = useApp();
  const slug = status.workspace!.slug;
  const isPortal = slug === 'portal-ia';
  const r = proc.result!;
  // Iteración aplicada antes de v0.12 (en la carpeta, sin worktree): no puede verificarse ni integrarse con el flujo actual.
  const legacy = !!r.applied && !r.applied.worktree && !r.merged;
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

  const mt = r.manualTest;
  const tested = mt ? mt.checks.filter(Boolean).length : 0;
  const allTested = !mt || tested === mt.steps.length;
  const rejected = !!r.rejected && !r.applied;
  const applicable = r.changes.filter(c => !c.error).length;
  const phase = proc.guidance?.phase ?? '';
  // El servidor es la única fuente de verdad del orden de cierre (services/guidance.ts); aquí solo se dibuja.
  const activation = r.activation ?? null;
  const portalFlow = isPortal && !!activation;
  const appliedAt = r.applied ? new Date(r.applied.appliedAt).getTime() - 1000 : 0;
  const okV = (c: string) => r.verifications.some(v => v.command === c && v.exitCode === 0 && new Date(v.startedAt).getTime() >= appliedAt);
  const verified = isPortal ? okV('typecheck') && okV('test') && okV('build') : okV('typecheck');
  const rc = r.runtimeChecks ?? null;
  const runtimeOk = !!rc?.ranAt && rc.results.length > 0 && rc.results.every(x => x.status === 'ok');
  const [rcBusy, setRcBusy] = useState(false);
  const runtimeCheck = async () => { setRcBusy(true); setErr(null); try { const p = await api.runtimeCheck(slug, proc.id); onChange(p); const ok = p.result?.runtimeChecks?.results.every(x => x.status === 'ok'); flash(ok ? 'Comprobación en ejecución correcta' : 'Alguna comprobación falló', ok ? 'ok' : 'err'); } catch (e: any) { setErr(e.message); } finally { setRcBusy(false); } };

  type Step = { key: string; label: string; done: boolean; hint?: string; optional?: boolean; action?: { label: string; onClick: () => void; busy?: boolean } };
  const steps: Step[] = [
    { key: 'review', label: 'Revisar el diff', done: !!r.applied || rejected, hint: `${applicable} archivo(s)${r.review ? r.review.approve ? ' · QA aprobó' : ` · QA no aprueba (${r.review.issues.length} observaciones)` : ''}`, action: { label: 'Ver el diff y la revisión de QA', onClick: () => go('sec-diff') } },
    { key: 'apply', label: legacy ? 'Aplicado con el método anterior (sin worktree)' : 'Aplicar en un worktree aislado', done: !!r.applied, hint: r.applied ? `${r.applied.branch} · ${r.applied.commit}${r.applied.worktree ? ' · fuera de la carpeta del Portal' : ' · en tu carpeta (antes de v0.12)'}` : 'la carpeta desde la que corre el Portal no se toca', action: { label: 'Ir a Aplicar', onClick: () => go('sec-apply') } },
    { key: 'verify', label: isPortal ? 'Verificar en sandbox (typecheck, test y build)' : 'Verificar (typecheck obligatorio)', done: !!r.applied && (verified || !!r.merged), hint: legacy ? 'no disponible: iteración anterior a v0.12 (usa las salidas de arriba)' : r.verifications.length ? r.verifications.slice(-4).map(v => `${v.command}: ${v.exitCode === 0 ? 'ok' : 'falló'}${v.isolation ? ` (${v.isolation})` : ''}`).join(' · ') : (isPortal ? 'el Portal exige test y build en Docker/WSL2; sin sandbox no se integra' : 'sin typecheck no se puede integrar'), action: legacy ? undefined : { label: 'Ir a Verificar', onClick: () => go('sec-verify') } },
    { key: 'merge', label: 'Integrar en la rama principal', done: !!r.merged, hint: r.merged ? `${r.merged.into} · ${r.merged.commit}` : undefined, action: { label: 'Ir a Integrar', onClick: () => go('sec-git') } },
    ...(portalFlow ? [
      { key: 'activate', label: 'Activar: reconstruir y reiniciar el Portal', done: activation!.active, hint: activation!.active ? `el Portal en marcha corre ${activation!.runningCommit} (interfaz construida ${activation!.buildAt ? new Date(activation!.buildAt).toLocaleString() : '—'})` : activation!.reason, action: { label: 'Ir a la barra «Reconstruir y reiniciar»', onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) } },
      { key: 'runtime', label: 'Comprobar en ejecución (el Portal se verifica a sí mismo)', done: activation!.active && runtimeOk, hint: rc?.ranAt ? `${rc.results.filter(x => x.status === 'ok').length} de ${rc.results.length} comprobaciones en verde · ${new Date(rc.ranAt).toLocaleString()}` : `${(rc?.checks.length ?? 0) + 2} comprobaciones (HTTP y navegador) con evidencia`, action: { label: rc?.ranAt ? 'Volver a comprobar' : 'Comprobar en ejecución', onClick: runtimeCheck, busy: rcBusy } }
    ] : []),
    { key: 'test', label: 'Probar paso a paso', done: !!r.merged && allTested && !!mt, hint: mt ? `${tested} de ${mt.steps.length} pasos` : 'aún no hay lista de prueba: genérala o escríbela abajo', action: { label: mt ? 'Ir a la lista de prueba' : 'Crear la lista de prueba', onClick: () => go('sec-test') } },
    { key: 'close', label: 'Cerrar la historia', done: false }
  ];
  const firstPending = steps.findIndex(s => !s.done && !s.optional);
  const canClose = /Listo para cerrar/.test(phase);
  const closeStep = steps.length - 1;
  // En una iteración anterior a v0.12 se puede probar ya (el código está en tu carpeta) para decidir si cerrarla como resuelta.
  const testEnabled = legacy || (!!r.merged && (!portalFlow || (activation!.active && runtimeOk)));

  // Prueba manual unificada (M6): una sola lista con OK / Falla / Observación + comentario por paso. «OK» marca el paso como
  // probado (checks del proceso, lo que exige la regla de cierre); Falla/Observación lo desmarcan y quedan como feedback.
  const [feedback, setFeedback] = useState<ManualTestFeedbackEntry[] | null>(null);
  useEffect(() => { let alive = true; setFeedback(null); if (mt) getManualTestFeedback(slug, proc.id).then(v => { if (alive) setFeedback(v.items.map(i => ({ stepKey: i.stepKey, result: i.result, comment: i.comment }))); }).catch(() => { if (alive) setFeedback([]); }); return () => { alive = false; }; }, [slug, proc.id, mt?.steps.join('|')]);
  const onStepSave = async (stepKey: string, result: 'ok' | 'fail' | 'observation' | null, comment: string) => {
    if (!mt) return;
    await saveManualTestStepFeedback(slug, proc.id, stepKey, { result, comment });
    const i = mt.steps.findIndex((t, j) => manualTestStepKey(j, t) === stepKey);
    if (i < 0) return;
    const want = result === 'ok' ? true : result ? false : mt.checks[i];
    if (want !== mt.checks[i]) { const p = await api.manualTest(slug, proc.id, mt.checks.map((c, j) => j === i ? want : c), note || null); onChange(p); }
  };
  const saveNote = async () => { if (!mt) return; try { const p = await api.manualTest(slug, proc.id, mt.checks, note || null); onChange(p); } catch (e: any) { setErr(e.message); } };
  const storyClosed = /Historia completada|Historia descartada/.test(proc.guidance?.phase ?? '');
  const refresh = async () => { try { onChange(await api.process(slug, proc.id)); } catch { /* sin cambios */ } };
  const closeResolved = async () => {
    if (!proc.backlogItemId) return;
    const reason = prompt('Cerrar la historia como resuelta (sin integrar esta iteración). Indica brevemente por qué; queda registrado:', legacy ? 'Lo que pedía ya funciona en el Portal (incluido en v0.12)' : 'resuelta fuera del flujo');
    if (reason === null) return;
    setBusy(true); setErr(null);
    try { await api.markStoryDone(slug, proc.backlogItemId, { force: true, reason: reason.trim() || 'resuelta fuera del flujo' }); flash('Historia cerrada como resuelta'); await refresh(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const discardAndIterate = async () => {
    if (!proc.backlogItemId) return;
    if (!confirm('Se descarta esta iteración (la rama se conserva en git) y se prepara una nueva iteración de la historia, pendiente de tu autorización: no gasta nada hasta que la autorices. ¿Continuar?')) return;
    setBusy(true); setErr(null);
    try {
      await api.rejectProcess(slug, proc.id, legacy ? 'iteración anterior a v0.12 descartada' : 'iteración descartada por el propietario');
      await api.storyIterate(slug, proc.backlogItemId, legacy ? 'La iteración anterior se aplicó antes de v0.12 y se descartó. Revisa si lo pedido ya existe en el código actual antes de cambiar nada.' : null);
      flash('Nueva iteración preparada: autorízala en Iteraciones');
      navigate(`/historias/${proc.backlogItemId}`);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const close = async () => { setBusy(true); setErr(null); try { await onClose(); flash('Historia completada'); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };

  return <section className="card" style={{ borderColor: '#C6E2DE' }}>
    <div className="card-h"><div><div className="h3">Resumen de la historia</div><div className="small muted">Qué cambia, en qué paso vas y qué toca ahora.</div></div>{proc.guidance && <Chip tone={proc.guidance.tone === 'err' ? 'err' : proc.guidance.tone === 'ok' ? 'ok' : proc.guidance.tone === 'warn' ? 'warn' : ''} xs>{proc.guidance.phase}</Chip>}</div>
    <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {rejected && <Notice kind="warn">Este diff fue rechazado ({r.rejected!.reason}); la historia volvió a pendiente.</Notice>}
      {legacy && !storyClosed && !rejected && <Notice kind="warn"><div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div><strong>Esta iteración es anterior a v0.12.</strong> Se aplicó directamente en tu carpeta (rama <span className="mono">{r.applied!.branch}</span>), sin worktree aislado, así que no puede verificarse en sandbox ni integrarse con el flujo actual. Elige una salida:</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" onClick={closeResolved} disabled={busy || !proc.backlogItemId}>{Icon.check()}Cerrar como resuelta</button>
          <button className="btn btn-secondary btn-sm" onClick={discardAndIterate} disabled={busy || !proc.backlogItemId}>Descartar esta iteración y preparar otra</button>
        </div>
        <div className="small muted">«Cerrar como resuelta» si lo que pedía la historia ya funciona en tu Portal (pruébalo con la lista de abajo). «Preparar otra» crea una iteración nueva con el feedback que hayas dejado; no gasta nada hasta que la autorices.</div>
      </div></Notice>}
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
              {current && s.action && i !== closeStep && <span><button className="btn btn-primary btn-sm" onClick={s.action.onClick} disabled={!!s.action.busy}>{s.action.busy ? <span className="spin spin-light" /> : Icon.arrow()}{s.action.label}</button></span>}</span>
          </li>; })}
        </ol>
      </div>

      {portalFlow && rc?.ranAt && <div id="sec-runtime">
        <div className="eyebrow" style={{ marginBottom: 6 }}>Comprobaciones en ejecución · {new Date(rc.ranAt).toLocaleString()}</div>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rc.results.map((x, i) => <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 10px', borderRadius: 8, background: x.status === 'ok' ? '#F2FAF5' : x.status === 'fail' ? '#FDF2F1' : '#FFFBF0' }}>
            <Chip tone={x.status === 'ok' ? 'ok' : x.status === 'fail' ? 'err' : 'warn'} xs>{x.status === 'ok' ? 'ok' : x.status === 'fail' ? 'falló' : 'pendiente'}</Chip>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}><span className="mono sm13">{x.check.kind} {x.check.path}{x.check.selector ? ` · ${x.check.selector}` : ''} → {x.check.expect}</span><span className="small muted">{x.detail}{x.evidence ? ` · evidencia: ${x.evidence.split(/[\\/]/).slice(-2).join('/')}` : ''}</span></span>
          </li>)}
        </ul>
      </div>}

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
        {!testEnabled && <p className="small muted" style={{ margin: '0 0 8px' }}>Se habilita cuando los cambios estén integrados{portalFlow ? ', activados en el Portal en marcha y comprobados en ejecución' : ''}.</p>}
        {r.merged && portalFlow && !activation!.active && <Notice kind="warn">Antes de probar, reconstruye y reinicia el Portal desde la barra del sistema: {activation!.reason}</Notice>}
        <div style={{ opacity: testEnabled ? 1 : 0.6, pointerEvents: testEnabled ? 'auto' : 'none' }}>
          {feedback ? <ManualTestStepList key={`${proc.id}:${mt.steps.length}`} steps={mt.steps} checks={mt.checks} initialFeedback={feedback} onSave={onStepSave}
            failureActions={proc.backlogItemId ? ({ failed, flush }) => <FeedbackToTeam slug={slug} itemId={proc.backlogItemId!} failed={failed} flush={flush} /> : undefined} /> : <span className="small muted">Cargando feedback…</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: 1, minWidth: 240, height: 34 }} value={note} onChange={e => setNote(e.target.value)} onBlur={saveNote} placeholder="Nota de la prueba (opcional): qué viste, qué falló…" disabled={!testEnabled} />
          <button className="btn btn-ghost btn-sm" onClick={() => { setManualText(mt.steps.map((st, i) => `${i + 1}. ${st}`).join('\n')); setWriting(true); }} disabled={busy}>Editar pasos</button>
        </div>
        {writing && <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}><textarea className="input" value={manualText} onChange={e => setManualText(e.target.value)} style={{ minHeight: 110 }} /><div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" onClick={saveSteps} disabled={busy || manualText.trim().length < 4}>Guardar pasos (reinicia las marcas)</button><button className="btn btn-ghost btn-sm" onClick={() => setWriting(false)}>Cancelar</button></div></div>}
      </div>}

      {err && <Notice kind="err">{err}</Notice>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={close} disabled={!canClose || busy || !proc.backlogItemId}>{busy ? <span className="spin spin-light" /> : Icon.check()}Marcar historia como completada</button>
        {!canClose && !storyClosed && <span className="small muted">{proc.guidance?.next}</span>}
        {!canClose && !storyClosed && !legacy && proc.backlogItemId && <button className="lnk small" onClick={closeResolved} disabled={busy} title="Si la historia ya está resuelta por otro camino, ciérrala indicando el motivo (queda registrado)">Cerrar como resuelta fuera del flujo</button>}
      </div>
    </div>
  </section>;
}

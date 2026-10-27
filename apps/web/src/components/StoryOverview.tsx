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
  const { status, flash } = useApp();
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

  const mt = r.manualTest;
  const tested = mt ? mt.checks.filter(Boolean).length : 0;
  const rejected = !!r.rejected && !r.applied;
  const phase = proc.guidance?.phase ?? '';
  // El orden de cierre y las acciones los dibuja el recorrido guiado (StoryFlowPanel, servidor: services/storyFlow.ts).
  const activation = r.activation ?? null;
  const portalFlow = isPortal && !!activation;
  const rc = r.runtimeChecks ?? null;
  const runtimeOk = !!rc?.ranAt && rc.results.length > 0 && rc.results.every(x => x.status === 'ok');

  const canClose = /Listo para cerrar/.test(phase);
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
  const close = async () => { setBusy(true); setErr(null); try { await onClose(); flash('Historia completada'); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };

  return <section className="card" style={{ borderColor: '#C6E2DE' }}>
    <div className="card-h"><div><div className="h3">Resumen de la historia</div><div className="small muted">Qué cambia para ti, cómo comprobarlo y la prueba de aceptación.</div></div>{proc.guidance && !proc.guidance.flow && <Chip tone={proc.guidance.tone === 'err' ? 'err' : proc.guidance.tone === 'ok' ? 'ok' : proc.guidance.tone === 'warn' ? 'warn' : ''} xs>{proc.guidance.phase}</Chip>}</div>
    <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {rejected && <Notice kind="warn">Este diff fue rechazado ({r.rejected!.reason}); la historia volvió a pendiente.</Notice>}
      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Qué cambia para ti y dónde verlo</div>
        {r.userFacing ? <Markdown text={r.userFacing} /> : <p className="muted sm13" style={{ margin: 0 }}>El Desarrollador no incluyó explicación para el propietario (historias anteriores a v0.11). Resumen técnico: {r.plan?.summary ?? r.implementationSummary?.slice(0, 300)}</p>}
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
        {!testEnabled ? <details><summary className="small muted" style={{ cursor: 'pointer' }}>Se habilita cuando los cambios estén integrados{portalFlow ? ', activados y comprobados en ejecución' : ''}. Ver los {mt.steps.length} pasos</summary>
          <ol className="sm13" style={{ margin: '8px 0 0', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 4 }}>{mt.steps.map((t, i) => <li key={i}>{t}</li>)}</ol></details> : <>
        <div>
          {feedback ? <ManualTestStepList key={`${proc.id}:${mt.steps.length}`} steps={mt.steps} checks={mt.checks} initialFeedback={feedback} onSave={onStepSave}
            failureActions={proc.backlogItemId ? ({ failed, flush }) => <FeedbackToTeam slug={slug} itemId={proc.backlogItemId!} failed={failed} flush={flush} /> : undefined} /> : <span className="small muted">Cargando feedback…</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: 1, minWidth: 240, height: 34 }} value={note} onChange={e => setNote(e.target.value)} onBlur={saveNote} placeholder="Nota de la prueba (opcional): qué viste, qué falló…" disabled={!testEnabled} />
          <button className="btn btn-ghost btn-sm" onClick={() => { setManualText(mt.steps.map((st, i) => `${i + 1}. ${st}`).join('\n')); setWriting(true); }} disabled={busy}>Editar pasos</button>
        </div></>}
        {writing && <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}><textarea className="input" value={manualText} onChange={e => setManualText(e.target.value)} style={{ minHeight: 110 }} /><div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" onClick={saveSteps} disabled={busy || manualText.trim().length < 4}>Guardar pasos (reinicia las marcas)</button><button className="btn btn-ghost btn-sm" onClick={() => setWriting(false)}>Cancelar</button></div></div>}
      </div>}

      {err && <Notice kind="err">{err}</Notice>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {canClose && <button className="btn btn-primary" onClick={close} disabled={busy || !proc.backlogItemId}>{busy ? <span className="spin spin-light" /> : Icon.check()}Marcar historia como completada</button>}
        {!canClose && !storyClosed && !legacy && proc.backlogItemId && <button className="lnk small" onClick={closeResolved} disabled={busy} title="Si la historia ya está resuelta por otro camino, ciérrala indicando el motivo (queda registrado)">Cerrar como resuelta fuera del flujo</button>}
      </div>
    </div>
  </section>;
}

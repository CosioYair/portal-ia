import { useEffect, useState } from 'react';
import type { GauntletAdvice, GauntletConfig, GauntletMode, GauntletProjectInfo, GauntletState } from '@portal-ia/domain';
import { normalizeGauntlet } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { Chip, Icon, Notice } from './ui.tsx';

export const GAUNTLET_MODE: Record<GauntletMode, { label: string; help: string }> = {
  off: { label: 'Desactivado', help: 'Verificación del sandbox y QA de siempre.' },
  standard: { label: 'Estándar', help: 'Una evaluación independiente y, si hace falta, una corrección dirigida.' },
  deep: { label: 'Profundo', help: 'Varias rondas acotadas (máx. 3) para tareas de riesgo o con fallos previos.' }
};
const STATUS: Record<GauntletState['status'], { label: string; tone: '' | 'ok' | 'warn' | 'err' }> = {
  pending: { label: 'en curso', tone: 'warn' }, passed: { label: 'todos los criterios con evidencia', tone: 'ok' },
  passed_with_findings: { label: 'aprobado con hallazgos menores documentados', tone: 'ok' }, stopped: { label: 'detenido con brechas bloqueantes', tone: 'err' },
  skipped: { label: 'no aplicado', tone: '' }, waived: { label: 'seguiste sin más evaluación', tone: 'warn' }
};
const CRIT: Record<string, string> = { met: 'cumplido', partial: 'a medias', unmet: 'incumplido', unverifiable: 'no verificable' };
const SEV: Record<string, string> = { blocking: 'bloqueante', major: 'mayor', minor: 'menor' };
const overheadText = (o: GauntletAdvice['overhead']['standard']) => o.evaluations.max ? `${o.evaluations.min}–${o.evaluations.max} evaluación(es) y hasta ${o.corrections.max} corrección(es) dirigida(s) más` : 'sin coste adicional';

/**
 * Modo Gauntlet de ESTA tarea antes de autorizarla: el del proyecto preseleccionado, la recomendación (sin IA) con sus
 * motivos y el sobrecoste máximo de cada modo. Sin Evaluador en el proyecto, el modo no se aplica y se dice.
 */
export function GauntletOptions({ slug, projectId, itemId, value, onChange }: { slug: string; projectId: string; itemId: string | null; value: GauntletConfig | undefined; onChange: (g: GauntletConfig) => void }) {
  const [advice, setAdvice] = useState<GauntletAdvice | null>(null);
  useEffect(() => {
    if (!itemId) return; let alive = true;
    api.gauntletAdvice(slug, projectId, itemId).then(a => { if (!alive) return; setAdvice(a); onChange(a.projectDefault); }).catch(() => undefined);
    return () => { alive = false; };
    // Solo al cambiar de historia: el valor inicial es el del proyecto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, projectId, itemId]);
  const cur = normalizeGauntlet(value ?? advice?.projectDefault ?? null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid #E4E2DC', borderRadius: 10, padding: '10px 12px', background: '#FBFAF7' }} data-testid="gauntlet-options">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong className="sm13">Evaluación Gauntlet</strong>
        <span className="small muted">Un Evaluador independiente (no el que implementa) comprueba el resultado contra los criterios con evidencia.</span>
      </div>
      <div role="radiogroup" aria-label="Modo Gauntlet" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(['off', 'standard', 'deep'] as const).map(m => <label key={m} className="ck" style={{ gap: 6, border: `1px solid ${cur.mode === m ? '#1F6F5C' : '#E4E2DC'}`, borderRadius: 8, padding: '6px 10px', background: cur.mode === m ? '#EEF6F3' : 'transparent' }}>
          <input type="radio" name={`gauntlet-${itemId ?? 'x'}`} checked={cur.mode === m} onChange={() => onChange(normalizeGauntlet({ mode: m }))} />
          <span><strong>{GAUNTLET_MODE[m].label}</strong>{advice?.recommended.mode === m && <> <Chip tone="accent" xs>recomendado</Chip></>}{advice?.projectDefault.mode === m && <> <Chip xs>del proyecto</Chip></>}<br /><span className="small muted">{GAUNTLET_MODE[m].help}{m !== 'off' && advice ? ` · ${overheadText(advice.overhead[m])}` : ''}</span></span>
        </label>)}
      </div>
      {cur.mode === 'deep' && <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>Correcciones dirigidas del Evaluador (máx. 3)
        <input className="input mono" type="number" min={1} max={3} value={cur.maxRounds} onChange={e => onChange(normalizeGauntlet({ mode: 'deep', maxRounds: Number(e.target.value) }))} style={{ width: 64, height: 28 }} aria-label="Rondas Gauntlet" /></label>}
      {advice && <div className="small muted">Recomendación: <strong>{GAUNTLET_MODE[advice.recommended.mode].label}</strong> — {advice.recommended.reason}{advice.recommended.signals.length ? ` (${advice.recommended.signals.join(' · ')})` : ''}</div>}
      {advice && !advice.evaluator && cur.mode !== 'off' && <Notice kind="warn">El proyecto no tiene Evaluador Gauntlet: este modo no se aplicará (verificación y QA de siempre). Puedes proponerlo en <strong>Equipo de IA</strong>.</Notice>}
      {advice?.evaluator && cur.mode !== 'off' && <div className="small">Evaluador: <strong>{advice.evaluator.name}</strong> · <span className="mono">{advice.evaluator.model}</span> · nunca evalúa su propio trabajo.</div>}
    </div>
  );
}

/** Informe del Evaluador: rondas, criterios con su evidencia, hallazgos y la decisión del Portal en cada ronda. */
export function GauntletReport({ state, implementer }: { state: GauntletState; implementer?: string | null }) {
  const st = STATUS[state.status];
  return (
    <section className="card" data-testid="gauntlet-report">
      <div className="card-h"><div className="h3">Evaluación Gauntlet</div><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><Chip xs>{GAUNTLET_MODE[state.mode].label}</Chip><Chip xs tone={st.tone}>{st.label}</Chip></div></div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="small muted">Implementa: <strong>{implementer ?? '—'}</strong> · Evalúa: <strong>{state.rounds[0]?.evaluatorName ?? '—'}</strong> (independiente, con contexto nuevo: objetivo, criterios, evidencia y el diff; sin la explicación del equipo).{state.reason ? ` ${state.reason}` : ''}</div>
        {state.rounds.map(r => <details key={r.round} open={r.round === state.rounds.length}>
          <summary style={{ cursor: 'pointer' }}><strong>Ronda {r.round}</strong> · commit <span className="mono">{r.commit ?? '?'}</span> · {r.criteria.filter(c => c.status === 'met').length}/{r.criteria.length} criterios cumplidos · {r.findings.filter(f => !f.unsupported).length} hallazgo(s) con evidencia · <em>{r.decision === 'correct' ? 'corrección dirigida' : r.decision === 'pass' ? 'pasa' : 'se detiene'}</em></summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {r.largestGap && <div className="small"><strong>Brecha principal:</strong> {r.largestGap}</div>}
            {r.criteria.length > 0 && <table className="tbl"><thead><tr><th>Criterio</th><th>Estado</th><th>Evidencia</th></tr></thead><tbody>{r.criteria.map((c, i) => <tr key={i}><td className="med">{c.criterion}</td><td><Chip xs tone={c.status === 'met' ? 'ok' : c.status === 'unmet' ? 'err' : 'warn'}>{CRIT[c.status]}</Chip></td><td className="small mono" style={{ whiteSpace: 'pre-wrap' }}>{c.evidence}</td></tr>)}</tbody></table>}
            {r.findings.map((f, i) => <div key={i} className="small" style={{ borderLeft: `3px solid ${f.unsupported ? '#C9C6BE' : f.severity === 'blocking' ? '#C0392B' : f.severity === 'major' ? '#D68910' : '#7F8C8D'}`, paddingLeft: 8, opacity: f.unsupported ? .7 : 1 }}>
              <strong>[{SEV[f.severity]}]</strong> {f.text}{f.file ? <> · <span className="mono">{f.file}</span></> : null}
              {f.evidence ? <div className="mono muted" style={{ whiteSpace: 'pre-wrap' }}>evidencia: {f.evidence}</div> : <div className="muted">Sin evidencia: queda registrado, no motiva correcciones.</div>}
              {f.expected && <div className="muted">esperado: {f.expected}</div>}
            </div>)}
            {r.limitations.length > 0 && <div className="small muted">Limitaciones: {r.limitations.join(' · ')}</div>}
            <div className="small muted">Decisión del Portal (sin IA): {r.reason}</div>
          </div>
        </details>)}
      </div>
    </section>
  );
}

/**
 * Propuesta organizativa: el Evaluador Gauntlet del proyecto (plantilla versionada, solo lectura, jefe el Coordinador).
 * No existe hasta que lo apruebas; el modo predeterminado del proyecto se fija aquí (cada tarea puede cambiarlo).
 */
export function GauntletProposal({ slug, projectId, onCreated }: { slug: string; projectId: string; onCreated?: () => void }) {
  const [info, setInfo] = useState<GauntletProjectInfo | null>(null);
  const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const load = () => api.projectGauntlet(slug, projectId).then(setInfo).catch(e => setErr(e.message));
  useEffect(() => { void load(); }, [slug, projectId]);
  if (!info) return err ? <Notice kind="err">{err}</Notice> : null;
  const create = async () => { setBusy(true); setErr(null); try { await api.createEvaluator(slug, projectId); setOk(false); await load(); onCreated?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const setMode = async (mode: GauntletMode) => { setErr(null); try { const r = await api.setProjectGauntlet(slug, projectId, normalizeGauntlet({ mode })); setInfo({ ...info, config: r.config }); } catch (e: any) { setErr(e.message); } };
  const t = info.template;
  return (
    <section className="card" data-testid="gauntlet-proposal">
      <div className="card-h"><div className="h3">Evaluador Gauntlet {info.evaluator ? '' : '(propuesta)'}</div>{info.evaluator ? <Chip xs tone="ok">en el equipo</Chip> : <Chip xs tone="warn">pendiente de tu aprobación</Chip>}</div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {err && <Notice kind="err">{err}</Notice>}
        <div className="sm13">{t.specialization}</div>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{t.responsibilities.map((r, i) => <li key={i}>{r}</li>)}</ul>
        <div className="small muted">Reporta a: Coordinador del proyecto · colabora con QA · herramientas: solo lectura del repositorio · capacidad: evaluar entregables · plantilla versionada <span className="mono">{t.key}</span>.</div>
        {info.evaluator
          ? <div className="small">Evaluador: <strong>{info.evaluator.name}</strong> · <span className="mono">{info.evaluator.model}</span> · origen {info.evaluator.backend === 'claude_code' ? 'Claude Code' : 'API'}</div>
          : <>
            <label className="ck"><input className="cb" type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /><span>Apruebo añadir este agente al proyecto (cambio organizativo). Queda inactivo: solo trabaja en las tareas que autorices con Gauntlet.</span></label>
            <div><button className="btn btn-primary btn-sm" onClick={create} disabled={!ok || busy}>{busy ? <span className="spin spin-light" /> : Icon.check()}Aprobar y añadir al equipo</button></div>
          </>}
        <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted">Modo predeterminado del proyecto:</span>
          {(['off', 'standard', 'deep'] as const).map(m => <button key={m} className={`btn btn-sm ${info.config.mode === m ? 'btn-secondary' : 'btn-ghost'}`} onClick={() => setMode(m)} aria-pressed={info.config.mode === m}>{GAUNTLET_MODE[m].label}</button>)}
        </div>
      </div>
    </section>
  );
}

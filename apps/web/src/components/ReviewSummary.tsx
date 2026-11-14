import { useEffect, useState } from 'react';
import { api, type ReviewView } from '../lib/api.ts';
import { Chip, Notice } from './ui.tsx';
import '../review.css';

/**
 * Portal IA 3 · La revisión de un trabajo, entera y en lenguaje llano, dentro del Portal: qué pediste, qué cambió, si las
 * comprobaciones pasan SOBRE LA VERSIÓN ACTUAL, qué dijeron la revisión de calidad y la evaluación independiente, las
 * capturas, qué pruebas existentes se tocaron, qué conviene que pruebes tú y qué límites quedan. Lo técnico va plegado.
 * El estado y la frase de cabecera vienen del servidor (los mismos que «Trabajo»): aquí no se decide nada.
 */
const CHECK_ICON: Record<ReviewView['checks'][number]['status'], { mark: string; tone: 'ok' | 'warn' | 'err'; word: string }> = {
  ok: { mark: '✓', tone: 'ok', word: 'Pasa' }, ok_baseline: { mark: '✓', tone: 'ok', word: 'Pasa' }, fail: { mark: '✕', tone: 'err', word: 'Falla' },
  not_run: { mark: '·', tone: 'warn', word: 'Sin comprobar' }, unavailable: { mark: '!', tone: 'warn', word: 'No se pudo comprobar' }
};
const QA_LABEL: Record<ReviewView['qa']['verdict'], string> = { approved: 'aprobada', outdated: 'de una versión anterior', rejected: 'pidió cambios', inconclusive: 'no concluyó', omitted: 'no se hizo (la omitiste)', none: 'sin revisar' };
const G_LABEL: Record<ReviewView['gauntlet']['verdict'], string> = { passed: 'superada', pending: 'pendiente', gaps: 'con puntos abiertos', skipped: 'no se hizo', waived: 'continuaste con puntos abiertos', off: '' };
const SEV_TONE: Record<string, 'err' | 'warn' | ''> = { alta: 'err', media: 'warn', baja: '' };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function ReviewSummary({ slug, processId, stamp }: { slug: string; processId: string; stamp: string }) {
  const [r, setR] = useState<ReviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.review(slug, processId).then(x => { if (alive) { setR(x); setError(null); } }).catch((e: any) => { if (alive) setError(e?.message ?? 'No se pudo cargar la revisión.'); });
    return () => { alive = false; };
  }, [slug, processId, stamp]);
  if (error) return <Notice kind="err">{error}</Notice>;
  if (!r) return null;
  // Sin nada preparado todavía no hay nada que revisar: la tarjeta de estado ya dice qué pasa.
  if (!r.files.length && !r.technical.integratedInto) return null;
  const blocking = r.findings.filter(f => f.blocking); const notes = r.findings.filter(f => !f.blocking);
  const unproven = r.testUpdates.filter(t => !t.proven);
  return (
    <section className="rv card" aria-labelledby="rv-h">
      <header className="rv-head">
        <div>
          <h2 className="rv-title" id="rv-h">Revisión del resultado</h2>
          <p className="rv-sub">{r.headline}</p>
        </div>
        <Chip tone={r.state.tone}>{r.state.label}</Chip>
      </header>

      {r.phase === 'not_ready' && r.verdict.missing.length > 0 && (
        <div className="rv-missing" role="status">
          <strong>Qué falta</strong>
          <ul>{r.verdict.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </div>
      )}

      <div className="rv-grid">
        <section className="rv-box" aria-label="Qué pediste">
          <h3 className="rv-h">Qué pediste</h3>
          <p className="rv-text">{r.ask}</p>
          {r.criteria.length > 0 && <><p className="rv-label">Se da por bueno si</p><ul className="rv-list">{r.criteria.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
        </section>

        <section className="rv-box" aria-label="Qué cambió">
          <h3 className="rv-h">Qué cambió</h3>
          <p className="rv-text">{r.whatChanged ?? 'El equipo no dejó una explicación escrita para ti. Abajo tienes los archivos que tocó.'}</p>
          <details className="rv-details"><summary>{plural(r.files.length, 'archivo tocado', 'archivos tocados')}</summary>
            <ul className="rv-files">{r.files.map(f => <li key={f.path}><span className="rv-path">{f.path}</span> <span className="rv-muted">{f.change}{f.lines ? ` · ${plural(f.lines, 'línea', 'líneas')}` : ''}</span></li>)}</ul>
          </details>
        </section>

        <section className="rv-box" aria-label="Comprobaciones automáticas">
          <h3 className="rv-h">Comprobaciones automáticas</h3>
          <ul className="rv-checks">
            {r.checks.map(c => { const i = CHECK_ICON[c.status]; return (
              <li key={c.key} className={`rv-check rv-${i.tone}`}>
                <span className="rv-mark" aria-hidden="true">{i.mark}</span>
                <span><strong>{c.label}</strong> — {i.word}.<br /><span className="rv-muted">{c.detail}</span></span>
              </li>); })}
          </ul>
          {r.tests && r.tests.total > 0 && <p className="rv-muted">{r.tests.passed} de {r.tests.total} pruebas superadas{r.tests.failed ? `, ${r.tests.failed} con fallo` : ''}.</p>}
        </section>

        <section className="rv-box" aria-label="Revisión de calidad y evaluación independiente">
          <h3 className="rv-h">Revisión del equipo</h3>
          <div className="rv-chips">
            <Chip xs tone={r.qa.verdict === 'approved' ? 'ok' : r.qa.verdict === 'none' ? '' : 'warn'}>Calidad: {QA_LABEL[r.qa.verdict]}</Chip>
            {r.gauntlet.verdict !== 'off' && <Chip xs tone={r.gauntlet.verdict === 'passed' ? 'ok' : 'warn'}>Evaluación independiente: {G_LABEL[r.gauntlet.verdict]}</Chip>}
          </div>
          <p className="rv-muted">{r.qa.note}{r.gauntlet.note ? ` ${r.gauntlet.note}` : ''}</p>
          {r.findings.length > 0 && (
            <ul className="rv-findings">
              {[...blocking, ...notes].slice(0, 12).map((f, i) => (
                <li key={i}>
                  <Chip xs tone={f.blocking ? SEV_TONE[f.severity] || 'warn' : ''}>{f.blocking ? `por resolver · importancia ${f.severity}` : 'observación'}</Chip> {f.text}
                  {f.where && <span className="rv-muted"> ({f.where})</span>}
                </li>))}
            </ul>)}
        </section>

        {r.testUpdates.length > 0 && (
          <section className={`rv-box${unproven.length ? ' rv-box-warn' : ''}`} aria-label="Pruebas existentes modificadas">
            <h3 className="rv-h">Pruebas que ya existían y este trabajo modificó</h3>
            <p className="rv-text">{unproven.length ? 'Míralas antes de aceptar: se adaptaron al comportamiento nuevo sin una comprobación previa que lo respalde.' : 'Se adaptaron porque el comportamiento cambió a propósito (comprobado contra la versión anterior).'}</p>
            <ul className="rv-list">{r.testUpdates.map(t => <li key={t.path}><span className="rv-path">{t.path}</span><br /><span className="rv-muted">{t.reason}</span></li>)}</ul>
          </section>
        )}

        {r.visual.required && (
          <section className="rv-box rv-wide" aria-label="Capturas de las pantallas">
            <h3 className="rv-h">Cómo se ve</h3>
            <p className="rv-muted">{r.visual.note}</p>
            {r.visual.shots.length > 0 && (
              <ul className="rv-shots">
                {r.visual.shots.map(s => (
                  <li key={s.file}>
                    <a href={api.reviewShotUrl(slug, processId, s.file)} target="_blank" rel="noreferrer" aria-label={`Abrir la captura de ${s.route} a ${s.width} píxeles`}>
                      <img loading="lazy" src={api.reviewShotUrl(slug, processId, s.file)} alt={`Pantalla ${s.route} a ${s.width} píxeles de ancho`} />
                    </a>
                    <span className="rv-muted">{s.route} · {s.width < 500 ? 'móvil' : s.width < 1000 ? 'tableta' : 'escritorio'}{s.overflow ? ' · se desborda' : ''}{s.violations ? ` · ${plural(s.violations, 'problema', 'problemas')} de accesibilidad` : ''}</span>
                  </li>))}
              </ul>)}
          </section>
        )}

        {r.toTest.length > 0 && (
          <section className="rv-box" aria-label="Qué conviene que pruebes">
            <h3 className="rv-h">Qué conviene que pruebes tú</h3>
            <ol className="rv-list">{r.toTest.map((s, i) => <li key={i}>{s}</li>)}</ol>
          </section>
        )}

        {r.limitations.length > 0 && (
          <section className="rv-box" aria-label="Límites y riesgos">
            <h3 className="rv-h">Límites que conviene saber</h3>
            <ul className="rv-list">{r.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </section>
        )}
      </div>

      <details className="rv-details rv-tech">
        <summary>Detalles técnicos</summary>
        <dl className="rv-dl">
          {r.technical.branch && <><dt>Rama de trabajo</dt><dd className="rv-path">{r.technical.branch}</dd></>}
          {r.technical.commit && <><dt>Versión comprobada</dt><dd className="rv-path">{r.technical.commit}</dd></>}
          {r.technical.integratedInto && <><dt>Integrado en</dt><dd className="rv-path">{r.technical.integratedInto}{r.technical.integratedCommit ? ` (${r.technical.integratedCommit})` : ''}</dd></>}
        </dl>
      </details>
    </section>
  );
}

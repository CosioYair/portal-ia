import { useEffect, useState } from 'react';
import type { LabAnalysisDef, LabAnalysisId, LabComparison, LabFinding, LabReport, ReaUpdateCheck } from '@portal-ia/domain';
import { apiRequest, ApiError } from '../lib/api.ts';
import { noteOwnerResponse, ownerHeaders } from '../lib/owner.ts';
import { useApp } from '../lib/store.ts';
import { Shell } from '../components/Shell.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { Chip, Icon, Notice, Spinner } from '../components/ui.tsx';
import { PageHeader } from '../components/kit.tsx';
import '../lab.css';

/**
 * Portal IA 4 · Análisis de artefactos (ingeniería inversa defensiva). Subes un archivo que es tuyo o que puedes
 * examinar, eliges qué quieres saber y recibes un informe con evidencia: lo CONFIRMADO, lo que NO se pudo determinar y
 * cómo corregirlo. Para comprobar una corrección, analiza la versión corregida y compárala con la anterior.
 */
type Engine = { state: 'ready'; version: string } | { state: 'no_docker' | 'missing_image'; detail: string; hint: string };
interface Status { engine: Engine; analyses: LabAnalysisDef[]; limits: { maxUploadBytes: number; minStatement: number }; pin: { version: string; upstream: string; reviewedAt: string; license: string; cooldownDays: number }; labels: Record<string, string>; fixes: Record<string, string> }
const W = (slug: string) => `/api/workspaces/${slug}/lab`;
const SEV: Record<string, { label: string; tone: 'err' | 'warn' | '' }> = { high: { label: 'grave', tone: 'err' }, medium: { label: 'media', tone: 'warn' }, low: { label: 'leve', tone: '' } };

function upload(slug: string, analysis: LabAnalysisId, statement: string, file: File, onProgress: (f: number) => void): Promise<LabReport> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${W(slug)}/reports?analysis=${analysis}&authorized=true&statement=${encodeURIComponent(statement)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    for (const [k, v] of Object.entries(ownerHeaders())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError(0, 'No se pudo subir el archivo: se perdió la conexión con el Portal.'));
    xhr.onload = () => { let body: any = null; try { body = JSON.parse(xhr.responseText); } catch { /* sin cuerpo */ } noteOwnerResponse(xhr.status, body); if (xhr.status >= 200 && xhr.status < 300) resolve(body); else reject(new ApiError(xhr.status, body?.error ?? `Error ${xhr.status}`, body)); };
    xhr.send(file);
  });
}

function Finding({ f, labels, fixes = {} }: { f: LabFinding; labels: Record<string, string>; fixes?: Record<string, string> }) {
  const sev = f.severity ? SEV[f.severity] : null;
  return <li className={`lab-finding lab-${f.status}`}>
    <div className="lab-finding-top"><strong>{labels[f.id] ?? f.id}</strong>
      {f.status === 'exposed' ? <Chip tone={sev?.tone ?? 'warn'} xs>Confirmado{sev ? ` · ${sev.label}` : ''}</Chip> : f.status === 'unknown' ? <Chip xs>No se pudo determinar</Chip> : f.status === 'not_observed' || f.status === 'ok' ? <Chip tone="ok" xs>Sin problema</Chip> : <Chip xs>No aplica</Chip>}
    </div>
    {f.locations.length > 0 && f.status === 'exposed' && <p className="lab-loc"><strong>Dónde:</strong> {f.locations.join(' · ')}</p>}
    {f.observation && <details className="lab-raw"><summary>Detalle técnico</summary><p className="lab-obs">{f.observation}</p></details>}
    {f.remediation && f.status !== 'not_observed' && f.status !== 'not_applicable' && <p className="lab-fix"><strong>Cómo corregirlo:</strong> {fixes[f.id] ?? f.remediation}</p>}
  </li>;
}

export function Lab() {
  const { status: app } = useApp(); const slug = app.workspace!.slug;
  const [st, setSt] = useState<Status | null>(null); const [reports, setReports] = useState<LabReport[] | null>(null);
  const [analysis, setAnalysis] = useState<LabAnalysisId>('exposure'); const [statement, setStatement] = useState(''); const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<number | null>(null); const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<LabReport | null>(null); const [cmp, setCmp] = useState<(LabComparison & { before: { id: string; createdAt: string } }) | null>(null); const [cmpWith, setCmpWith] = useState('');
  const [upd, setUpd] = useState<ReaUpdateCheck | null>(null); const [checking, setChecking] = useState(false);
  const load = () => apiRequest<LabReport[]>(`${W(slug)}/reports`).then(setReports).catch(e => setErr(e.message));
  useEffect(() => { apiRequest<Status>(`${W(slug)}/status`).then(setSt).catch(e => setErr(e.message)); void load(); }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = reports?.some(r => r.status === 'running') || open?.status === 'running';
  useEffect(() => { if (!running) return; const t = setInterval(async () => { await load(); if (open) apiRequest<LabReport>(`${W(slug)}/reports/${open.id}`).then(setOpen).catch(() => undefined); }, 1500); return () => clearInterval(t); }, [running, open?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    if (!file || !st) return; setErr(null); setBusy(0);
    try { const r = await upload(slug, analysis, statement.trim(), file, setBusy); setOpen(r); setCmp(null); setCmpWith(''); setFile(null); await load(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  const compare = async (otherId: string) => { setCmpWith(otherId); setCmp(null); if (!otherId || !open) return; try { setCmp(await apiRequest(`${W(slug)}/reports/${open.id}/compare/${otherId}`)); } catch (e: any) { setErr(e.message); } };
  const checkUpdate = async () => { setChecking(true); try { setUpd(await apiRequest<ReaUpdateCheck>(`${W(slug)}/update-check`, { method: 'POST', body: '{}' })); } catch (e: any) { setErr(e.message); } finally { setChecking(false); } };
  const def = st?.analyses.find(a => a.id === analysis); const min = st?.limits.minStatement ?? 20;
  const labels = st?.labels ?? {}; const engine = st?.engine;
  const confirmed = open?.findings.filter(f => f.status === 'exposed') ?? []; const unknown = open?.findings.filter(f => f.status === 'unknown') ?? []; const rest = open?.findings.filter(f => f.status !== 'exposed' && f.status !== 'unknown') ?? [];
  const others = (reports ?? []).filter(r => open && r.id !== open.id && r.status === 'done' && r.analysis === open.analysis && r.createdAt < open.createdAt);

  return <Shell crumb="Analizar un programa">
    <div className="page lab">
      <PageHeader icon={Icon.shield()} tone="settings" title="Analizar un programa" description="Averigua qué contiene y qué deja ver una aplicación antes de publicarla o de usarla, sin ejecutarla. Solo para programas tuyos o que tengas permiso para examinar." />
      {err && <Notice kind="err">{err} <button className="lnk" onClick={() => setErr(null)}>Entendido</button></Notice>}
      {engine && engine.state !== 'ready' && <Notice kind="warn"><strong>La herramienta de análisis no está lista.</strong> {engine.detail} <span className="small">{engine.state === 'missing_image' ? <>Hay que construir una vez su imagen aislada: <code>{engine.hint}</code></> : engine.hint}</span></Notice>}

      <section className="lab-card" aria-labelledby="lab-new">
        <h2 id="lab-new" className="lab-h2">Nuevo análisis</h2>
        <fieldset className="lab-fs"><legend className="label">¿Qué quieres saber?</legend>
          <div className="lab-options">{(st?.analyses ?? []).map(a => <label key={a.id} className={`lab-option${analysis === a.id ? ' is-on' : ''}`}><input type="radio" name="lab-analysis" className="sr-only" checked={analysis === a.id} onChange={() => setAnalysis(a.id)} /><strong>{a.label}</strong><span className="small muted">{a.question}</span></label>)}</div>
        </fieldset>
        <div><label className="label" htmlFor="lab-file">Archivo que quieres analizar</label>
          <input id="lab-file" className="lab-file" type="file" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <p className="small muted" style={{ margin: '6px 0 0' }}>{def?.accepts}. Máximo {Math.round((st?.limits.maxUploadBytes ?? 0) / 1048576)} MB. No se ejecuta: solo se lee, en un espacio aislado y sin conexión a internet.</p></div>
        <div><label className="label" htmlFor="lab-auth">¿Por qué puedes examinarlo?</label>
          <textarea id="lab-auth" className="input lab-textarea" value={statement} maxLength={1000} onChange={e => setStatement(e.target.value)} placeholder="Por ejemplo: es la versión publicada de mi propia aplicación. / Mi cliente me encargó auditarlo y tengo su permiso por escrito." />
          <p className="small muted" style={{ margin: '6px 0 0' }}>Queda guardado con el informe. Muchos programas prohíben en su licencia que se les haga ingeniería inversa: analiza solo lo que es tuyo o lo que su dueño te autorizó.</p></div>
        <div className="lab-actions"><button className="btn btn-primary" onClick={start} disabled={!file || statement.trim().length < min || busy !== null || engine?.state !== 'ready'}>{busy !== null ? `Subiendo… ${Math.round(busy * 100)} %` : 'Analizar'}</button>
          {statement.trim().length < min && file && <span className="small muted">Falta explicar por qué puedes examinarlo (al menos {min} caracteres).</span>}</div>
      </section>

      {open && <section className="lab-card" aria-labelledby="lab-report" aria-live="polite">
        <div className="lab-report-head"><h2 id="lab-report" className="lab-h2">Informe · {open.target.name}</h2><button className="btn btn-ghost btn-sm" onClick={() => { setOpen(null); setCmp(null); }}>Cerrar el informe</button></div>
        <p className="small muted" style={{ margin: 0 }}>{st?.analyses.find(a => a.id === open.analysis)?.label} · {open.target.kind === 'folder' ? `carpeta con ${open.target.files} archivos` : 'un archivo'} · {new Date(open.createdAt).toLocaleString()}</p>
        {open.status === 'running' && <p><Spinner label="Analizando… (hasta 5 minutos)" /></p>}
        {open.status === 'failed' && <Notice kind="err">{open.error}</Notice>}
        {open.status === 'done' && <>
          <div className="lab-summary">
            <div className={`lab-stat${open.summary.confirmed ? ' is-bad' : ' is-ok'}`}><strong>{open.summary.confirmed}</strong><span>{open.summary.confirmed === 1 ? 'problema confirmado' : 'problemas confirmados'}{open.summary.high ? ` (${open.summary.high} ${open.summary.high === 1 ? 'grave' : 'graves'})` : ''}</span></div>
            <div className="lab-stat"><strong>{open.summary.unknown}</strong><span>sin determinar</span></div>
            <div className="lab-stat"><strong>{open.summary.clean}</strong><span>sin problema</span></div>
          </div>
          {confirmed.length > 0 && <><h3 className="lab-h3">Confirmado en el artefacto</h3><ul className="lab-list">{confirmed.map(f => <Finding key={f.id} f={f} labels={labels} fixes={st?.fixes} />)}</ul></>}
          {confirmed.length === 0 && <Notice kind="ok">El análisis no encontró ningún problema confirmado. Eso no demuestra que la aplicación sea segura: solo dice lo que este análisis estático pudo ver.</Notice>}
          {unknown.length > 0 && <Disclosure title={`No se pudo determinar (${unknown.length})`} hint="Sospechas sin confirmar: no son hallazgos"><ul className="lab-list">{unknown.map(f => <Finding key={f.id} f={f} labels={labels} />)}</ul></Disclosure>}
          {rest.length > 0 && <Disclosure title={`Sin problema o no aplica (${rest.length})`}><ul className="lab-list">{rest.map(f => <Finding key={f.id} f={f} labels={labels} />)}</ul></Disclosure>}
          <p className="small muted">Este informe dice lo que se pudo ver leyendo el archivo. No demuestra que el programa sea seguro.</p>
          <p className="small muted" style={{ margin: 0 }}>Autorización declarada: «{open.authorization.statement}»</p>
          {others.length > 0 && <div className="lab-compare"><label className="label" htmlFor="lab-cmp">¿Corregiste algo? Compara con un informe anterior</label>
            <select id="lab-cmp" className="input" value={cmpWith} onChange={e => void compare(e.target.value)}><option value="">Elegir el informe anterior…</option>{others.map(r => <option key={r.id} value={r.id}>{r.target.name} · {new Date(r.createdAt).toLocaleString()} · {r.summary.confirmed} confirmados</option>)}</select>
            {cmp && <div className="lab-cmp-result">
              {cmp.sameTarget && <Notice kind="warn">Es exactamente el mismo archivo que el anterior (misma huella): no hay ninguna corrección que comprobar.</Notice>}
              <p className="lab-cmp-line"><Chip tone="ok" xs>Corregido</Chip> {cmp.fixed.length ? cmp.fixed.map(i => labels[i] ?? i).join(' · ') : 'nada'}</p>
              <p className="lab-cmp-line"><Chip tone={cmp.stillExposed.length ? 'err' : 'ok'} xs>Sigue igual</Chip> {cmp.stillExposed.length ? cmp.stillExposed.map(i => labels[i] ?? i).join(' · ') : 'nada: todo lo que había está corregido'}</p>
              {cmp.newlyExposed.length > 0 && <p className="lab-cmp-line"><Chip tone="warn" xs>Nuevo</Chip> {cmp.newlyExposed.map(i => labels[i] ?? i).join(' · ')}</p>}
            </div>}
          </div>}
        </>}
      </section>}

      <section className="lab-card" aria-labelledby="lab-past">
        <h2 id="lab-past" className="lab-h2">Informes anteriores</h2>
        {!reports ? <Spinner /> : reports.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Aún no has analizado nada.</p> : <ul className="lab-past">{reports.map(r => <li key={r.id}>
          <button className="lab-past-btn" onClick={() => { setOpen(r); setCmp(null); setCmpWith(''); }}><span><strong>{r.target.name}</strong><br /><span className="small muted">{st?.analyses.find(a => a.id === r.analysis)?.label} · {new Date(r.createdAt).toLocaleString()}</span></span>
            {r.status === 'running' ? <Chip tone="working" xs>Analizando</Chip> : r.status === 'failed' ? <Chip tone="err" xs>No terminó</Chip> : <Chip tone={r.summary.high ? 'err' : r.summary.confirmed ? 'warn' : 'ok'} xs>{r.summary.confirmed} {r.summary.confirmed === 1 ? 'confirmado' : 'confirmados'}</Chip>}</button>
        </li>)}</ul>}
      </section>

      {st && <Disclosure title="Sobre la herramienta y sus actualizaciones" hint={`REA ${st.pin.version}, aislada`}>
        <p className="small">Los análisis los hace <a className="lnk" href={st.pin.upstream} target="_blank" rel="noreferrer">REA</a> (licencia {st.pin.license}), versión <strong>{st.pin.version}</strong>, revisada el {st.pin.reviewedAt}. Corre en un contenedor propio: sin red, sin privilegios, con el artefacto en solo lectura. No instala nada en tu equipo ni toca la configuración de Claude Code. Para quitarla basta borrar su imagen de Docker.</p>
        <button className="btn btn-secondary btn-sm" onClick={checkUpdate} disabled={checking}>{checking ? 'Consultando…' : 'Buscar una versión más nueva'}</button>
        <p className="small muted">Solo consulta los datos públicos del paquete. Nunca se actualiza sola: una versión nueva se propone cuando lleva al menos {st.pin.cooldownDays} días publicada, y adoptarla es una revisión aparte.</p>
        {upd && <Notice kind={upd.verdict === 'up_to_date' ? 'ok' : upd.verdict === 'unavailable' ? 'warn' : 'info'}>
          {upd.verdict === 'up_to_date' ? `Estás en la última versión publicada (${upd.pinned}).` : upd.verdict === 'unavailable' ? 'No se pudo consultar.' : `Versión fijada: ${upd.pinned}. Última publicada: ${upd.latest}.`} {upd.notes.join(' ')}
        </Notice>}
      </Disclosure>}
    </div>
  </Shell>;
}

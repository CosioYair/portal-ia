import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FEEDBACK_LABEL, INTEGRATION_LABEL, type DocumentJob, type ExecutionBackend, type ExternalGrants, type ImprovementProposal } from '@portal-ia/domain';
import { Chip, Icon, Notice, Spinner } from './ui.tsx';
import { Markdown } from './Markdown.tsx';
import { FolderPicker } from './FolderPicker.tsx';
import { useApp } from '../lib/store.ts';
import { useLive } from '../lib/live.ts';
import { osApi, type AgentPanel as Panel, type ExternalPreview, type SourceStatus } from '../lib/osApi.ts';

/**
 * Agentes externos (referencia gestionada): importar sin copiar, banco de documentos, origen e integración, mejoras.
 * La carpeta original es la fuente de verdad; todo lo que cambia sus archivos, ejecuta algo o gasta pide confirmación.
 */
const GRANTS_TEXT: Record<keyof ExternalGrants, { label: string; hint: string }> = {
  writeDocuments: { label: 'Guardar documentos en su carpeta', hint: 'Solo en «documentos/» y «bandeja-de-entrada/». Nunca reemplaza una versión anterior.' },
  runScripts: { label: 'Ejecutar los programas de sus habilidades en este equipo', hint: 'Solo los que ya revisaste (si cambian fuera del Portal, se bloquean hasta que los revises), sin acceso a otros programas y con tiempo límite. Ojo: no corren aislados del resto del equipo; usan tus permisos de usuario.' },
  applyImprovements: { label: 'Aplicar a sus instrucciones y habilidades las mejoras que apruebes', hint: 'Solo cuando apruebas una propuesta concreta: antes guarda una copia en «configuracion/respaldos/», anota el cambio en CAMBIOS.md y siempre se puede volver atrás.' }
};
const NO_GRANTS: ExternalGrants = { writeDocuments: false, runScripts: false, applyImprovements: false };
const PDF_MAX = 40 * 1024 * 1024; const ZIP_MAX = 60 * 1024 * 1024;

function GrantsEditor({ value, onChange, disabled }: { value: ExternalGrants; onChange: (g: ExternalGrants) => void; disabled?: boolean }) {
  return <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}><legend className="label">Permisos que le das (solo en su carpeta)</legend>
    {(Object.keys(GRANTS_TEXT) as (keyof ExternalGrants)[]).map(k => <label key={k} className="ck small" style={{ alignItems: 'flex-start' }}>
      <input className="cb" type="checkbox" disabled={disabled} checked={value[k]} onChange={e => onChange({ ...value, [k]: e.target.checked })} />
      <span><strong>{GRANTS_TEXT[k].label}</strong><br /><span className="muted">{GRANTS_TEXT[k].hint}</span></span>
    </label>)}
  </fieldset>;
}

/** Diferencias línea a línea (solo lo que cambia, con 2 líneas de contexto). Textos enormes: se muestran por separado. */
function LineDiff({ before, after }: { before: string | null; after: string | null }) {
  const rows = useMemo(() => {
    const a = (before ?? '').split('\n'); const b = (after ?? '').split('\n');
    if (a.length * b.length > 4_000_000) return null;
    const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out: { t: ' ' | '+' | '-'; s: string }[] = []; let i = 0; let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i++; j++; }
      else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) out.push({ t: '+', s: b[j++] });
      else out.push({ t: '-', s: a[i++] });
    }
    const keep = out.map((r, k) => r.t !== ' ' || out.slice(Math.max(0, k - 2), k + 3).some(x => x.t !== ' '));
    return out.map((r, k) => keep[k] ? r : null);
  }, [before, after]);
  if (before === null) return <><div className="small muted">Archivo nuevo:</div><div className="file-view">{after}</div></>;
  if (after === null) return <div className="small muted">Se elimina este archivo.</div>;
  if (!rows) return <><div className="small muted">Antes:</div><div className="file-view">{before}</div><div className="small muted">Después:</div><div className="file-view">{after}</div></>;
  return <div className="file-view">{rows.map((r, k) => r === null ? (rows[k - 1] !== null ? <div key={k} className="muted">…</div> : null) : <div key={k} className={r.t === '+' ? 'diff-add' : r.t === '-' ? 'diff-del' : undefined}>{r.t} {r.s}</div>)}</div>;
}

// ---------------------------------------------------------------- Importar como referencia gestionada

type HarnessList = { id: ExecutionBackend; name: string; availability: { available: boolean; reason: string | null }; models: { provider: string; models: { id: string; name: string }[] }[] }[];
export function ExternalImportBox({ slug, harnesses, departments, onCancel, onDone }: { slug: string; harnesses: HarnessList | null; departments: string[]; onCancel: () => void; onDone: (id: string) => void }) {
  const [path, setPath] = useState(''); const [pv, setPv] = useState<ExternalPreview | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false); const [name, setName] = useState(''); const [role, setRole] = useState(''); const [dep, setDep] = useState('');
  const [harness, setHarness] = useState<ExecutionBackend | null>(null); const [grants, setGrants] = useState<ExternalGrants>(NO_GRANTS); const [auth, setAuth] = useState(false);
  const usable = (harnesses ?? []).filter(h => h.id === 'claude-code' || h.id === 'codex');
  const h = usable.find(x => x.id === harness); const modelObj = h?.models[0]?.models.find(m => /sonnet|default/i.test(m.id)) ?? h?.models[0]?.models[0] ?? null; const model = modelObj?.id ?? '';
  const preview = async (p0 = path) => {
    // Otra carpeta: lo concedido y la confirmación anteriores no valen.
    setBusy(true); setError(null); setPv(null); setAuth(false); setGrants(NO_GRANTS); setHarness(null);
    try { const r = await osApi.externalPreview(slug, p0.trim()); setPv(r); setName(r.suggested.name); setDep(d => d || departments.find(x => /document/i.test(x)) || ''); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setError(null);
    try { const a = await osApi.importExternal(slug, { path: pv!.path, hash: pv!.hash, name, role, summary: pv!.suggested.summary, department: dep, harness: harness!, model, grants }); onDone(a.id); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const missing = !pv ? 'revisa la carpeta' : !pv.ok ? 'la carpeta tiene un problema (arriba)' : name.trim().length < 2 ? 'ponle un nombre' : role.trim().length < 2 ? 'describe su papel' : dep.trim().length < 2 ? 'elige el departamento' : !harness ? 'elige con qué trabaja' : !auth ? 'marca la autorización' : null;
  return <section className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div className="h3">Integrar un agente que ya existe en su carpeta</div>
    <p className="small muted">Para carpetas con AGENTS.md (y CLAUDE.md, contexto/, skills/, memoria/…). El Portal no la copia ni la reescribe: su carpeta sigue siendo la original. Antes de integrarlo verás todo lo que leerá el agente.</p>
    {error && <Notice kind="err">{error}</Notice>}
    <div style={{ display: 'flex', gap: 8 }}><input className="input" value={path} onChange={e => { setPath(e.target.value); setPv(null); setAuth(false); }} placeholder="Carpeta del agente (p. ej. ~/Documents/AGENTS/PDF-Word-Fiel-v02)" aria-label="Carpeta del agente externo" />
      <button className="btn btn-ghost" type="button" onClick={() => setPicking(true)}>{Icon.folder()} Elegir…</button><button className="btn btn-secondary" disabled={busy || !path.trim()} onClick={() => void preview()}>Revisar</button></div>
    {picking && <FolderPicker title="Carpeta del agente" hint="Elige la carpeta que contiene AGENTS.md." initialPath={path || null} onSelect={p => { setPicking(false); setPath(p); void preview(p); }} onClose={() => setPicking(false)} />}
    {busy && !pv && <Spinner />}
    {pv && <>
      {pv.duplicate && <Notice kind="err">Esta carpeta ya está integrada como «{pv.duplicate.name}». No se duplica.</Notice>}
      {pv.problems.map((p, i) => <Notice key={i} kind={p.blocking ? 'err' : 'warn'}>{p.path}: {p.message}</Notice>)}
      <div className="card" style={{ padding: 10 }}>
        <div className="small"><strong>Lo que encontramos en la carpeta</strong> <span className="muted">(comprueba que es correcto)</span></div>
        <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          <li>Instrucciones: <code>{pv.layout.identity}</code>{pv.layout.adapters.length ? <> · notas para otras herramientas (no las lee el agente aquí): {pv.layout.adapters.map(a => <code key={a}>{a} </code>)}</> : null}</li>
          <li>Contexto: {pv.layout.context.length ? pv.layout.context.map(c => <code key={c}>{c} </code>) : 'ninguno'}</li>
          <li>Habilidades: {pv.layout.skills.map(s => <span key={s.slug}><strong>{s.name}</strong>{s.version ? ` v${s.version}` : ''} ({s.scripts.length} programa{s.scripts.length === 1 ? '' : 's'}) </span>)}</li>
          <li>Memoria: {pv.layout.memory ? <code>{pv.layout.memory}</code> : 'ninguna'} · Entradas: {pv.layout.inbox ? <code>{pv.layout.inbox}/</code> : '—'} · Entregables: {pv.layout.outputs ? <code>{pv.layout.outputs}/</code> : '— (sin «documentos/»: no podrá recibir PDF)'} · Copias: {pv.layout.backups ? <code>{pv.layout.backups}/</code> : '—'}</li>
          <li className="muted">No se leen: {pv.layout.ignored.join(', ') || 'nada'}{pv.links.length ? ` · accesos directos que no se siguen: ${pv.links.join(', ')}` : ''}</li>
        </ul>
      </div>
      <details className="card" style={{ padding: 10 }}><summary className="small" style={{ cursor: 'pointer' }}><strong>Lo que leerá el agente</strong> (léelo antes de integrarlo)</summary>
        <div className="small" style={{ marginTop: 8 }}><strong>AGENTS.md</strong></div><div className="file-view">{pv.prompt.instructions}</div>
        {pv.prompt.context.map(c => <div key={c.path} style={{ marginTop: 8 }}><div className="small"><strong>{c.path}</strong></div><div className="file-view">{c.text}</div></div>)}
        {pv.prompt.skills.map(s => <div key={s.slug} style={{ marginTop: 8 }}><div className="small"><strong>Habilidad {s.path}</strong></div><div className="file-view">{s.body}</div></div>)}
        {pv.prompt.memory && <div style={{ marginTop: 8 }}><div className="small"><strong>{pv.prompt.memory.path}</strong></div><div className="file-view">{pv.prompt.memory.text}</div></div>}
        {pv.adapters.map(a => <div key={a.path} style={{ marginTop: 8 }}><div className="small"><strong>{a.path}</strong> <Chip xs>no lo lee aquí</Chip></div><div className="file-view">{a.text}</div></div>)}
        <div className="small" style={{ marginTop: 8 }}><strong>Programas</strong> (quedan registrados tal como están; si alguien los cambia fuera del Portal, no se ejecutan hasta que revises el cambio)</div>
        <ul className="small mono" style={{ margin: 0, paddingLeft: 18 }}>{pv.scripts.map(s => <li key={s.path}>{s.path}</li>)}</ul>
      </details>
      <div className="summary-cols">
        <div><label className="label" htmlFor="ext-name">Nombre</label><input id="ext-name" className="input" value={name} onChange={e => setName(e.target.value)} maxLength={80} /></div>
        <div><label className="label" htmlFor="ext-role">Papel (3–6 palabras)</label><input id="ext-role" className="input" value={role} onChange={e => setRole(e.target.value)} placeholder="Ej.: Conversión de PDF a Word" maxLength={80} /></div>
      </div>
      <div><label className="label" htmlFor="ext-dep">Departamento</label><input id="ext-dep" className="input" value={dep} onChange={e => setDep(e.target.value)} list="ext-deps" maxLength={60} /><datalist id="ext-deps">{departments.map(n => <option key={n} value={n} />)}</datalist></div>
      <div className="label">Con qué trabaja (tu suscripción; nunca la API de pago por uso)</div>
      <div className="harness-cards">{usable.map(x => <button key={x.id} type="button" className="harness-card" aria-pressed={harness === x.id} disabled={!x.availability.available} onClick={() => setHarness(x.id)}><strong>{x.name}</strong><span className="small">{x.availability.available ? 'Disponible' : x.availability.reason}</span></button>)}</div>
      {modelObj && <span className="small muted">Modelo: {modelObj.name} (puedes cambiarlo después en Configuración).</span>}
      <GrantsEditor value={grants} onChange={setGrants} />
      <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /> Autorizo integrar este agente con estos permisos. Su carpeta sigue siendo la original.</label>
    </>}
    <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}><button className="btn btn-ghost" onClick={onCancel}>Volver</button>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{missing && <span className="small muted">Falta: {missing}.</span>}<button className="btn btn-primary" disabled={busy || !!missing} onClick={() => void confirm()}>Integrar</button></span></div>
  </section>;
}

// ---------------------------------------------------------------- Documentos (banco de trabajo)

const STATUS: Record<DocumentJob['status'], { text: string; tone: '' | 'ok' | 'warn' | 'err' | 'accent' }> = {
  received: { text: 'Recibido', tone: '' }, processing: { text: 'Procesando…', tone: 'accent' }, ready: { text: 'Listo: pasó las comprobaciones', tone: 'ok' }, rejected: { text: 'No pasó las comprobaciones', tone: 'warn' }, failed: { text: 'Falló', tone: 'err' }
};
const GATE_TEXT: Record<string, string> = {
  texto_editable: 'Texto editable', sin_paginas_como_imagen: 'Sin páginas como imagen', sin_marcos_ni_vml: 'Sin cuadros superpuestos', estructura_compatible_word: 'Se abre bien en Word',
  mismas_paginas: 'Mismas páginas', contenido_completo: 'No falta texto', sin_duplicados: 'Sin texto repetido', paginas_con_contenido: 'Ninguna página vacía', figuras_verificadas: 'Figuras con su texto', conversion_completada: 'Conversión completada', qa_ejecutada: 'Comprobación ejecutada'
};
const pct = (v: unknown) => typeof v === 'number' ? `${Math.round(v * 1000) / 10} %` : String(v);
const METRIC_TEXT: Record<string, (v: unknown) => string> = {
  paginas_pdf: v => `Páginas del PDF: ${v}`, paginas_word: v => `Páginas del Word: ${v}`, texto_editable_fuera_de_figuras: v => `Texto editable fuera de las figuras: ${pct(v)}`,
  palabras_en_figuras: v => `Palabras dentro de figuras (como imagen, con texto alternativo): ${v}`, proporcion_en_figuras: v => `Parte del texto que está en figuras: ${pct(v)}`,
  orden: v => `Orden del texto conservado: ${pct(v)}`, duplicacion: v => `Texto repetido: ${pct(v)}`, imagenes: v => `Imágenes: ${v}`, mayor_imagen_vs_pagina: v => `Imagen más grande: ${pct(v)} de la página`,
  imagenes_de_pagina_completa: v => `Imágenes de página completa: ${v}`, tablas: v => `Tablas: ${v}`, diferencia_visual_media: v => `Diferencia visual media: ${pct(v)}`, exit_code: v => `Código de salida del programa: ${v}`, qa_error: v => `Error de la comprobación: ${v}`
};

export function DocumentsTab({ slug, p, onChanged, onTab }: { slug: string; p: Panel; onChanged: () => void; onTab: (t: 'origen' | 'mejoras') => void }) {
  const { flash } = useApp();
  const [data, setData] = useState<Awaited<ReturnType<typeof osApi.documents>> | null>(null); const [src, setSrc] = useState<SourceStatus | null>(null);
  const [error, setError] = useState<string | null>(null); const [warn, setWarn] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [open, setOpen] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null); const opened = useRef(false);
  const load = useCallback(() => Promise.all([osApi.documents(slug, p.agent.id), osApi.source(slug, p.agent.id)]).then(([d, s]) => {
    setData(d); setSrc(s);
    if (!opened.current && d.jobs[0]) { opened.current = true; setOpen(d.jobs[0].id); } // solo al abrir: no se reabre si lo cierras
  }).catch(e => setError(e.message)), [slug, p.agent.id]);
  useEffect(() => { void load(); }, [load]);
  useLive(c => c.ws === slug && c.entity === 'agent' && c.id === p.agent.id, () => void load(), { minMs: 800 });
  const act = async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => { setBusy(true); setError(null); try { await fn(); flash(ok); await load(); onChanged(); return true; } catch (e: any) { setError(e.message); return false; } finally { setBusy(false); } };
  const upload = (f: File) => {
    const zip = /\.zip$/i.test(f.name);
    if (f.size > (zip ? ZIP_MAX : PDF_MAX)) { setError(`El archivo pesa ${(f.size / 1048576).toFixed(0)} MB: el máximo es ${zip ? 60 : 40} MB.`); return; }
    setWarn(null);
    void act(async () => {
      const b64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(new Error('No se pudo leer el archivo.')); r.readAsDataURL(f); });
      const r = await osApi.uploadDocument(slug, p.agent.id, f.name, b64);
      if (r.skipped.length) setWarn(`Del ZIP no se tomaron: ${r.skipped.join(' · ')}`);
      if (r.jobs[0]) setOpen(r.jobs[0].id);
      if (r.jobs.some(j => j.duplicate)) flash('Ese PDF ya estaba recibido: se reutiliza su trabajo (no se duplica).');
    }, 'Recibido');
  };
  if (!data || !src) return error ? <Notice kind="err">{error}</Notice> : <Spinner />;
  if (!src.layout.outputs) return <Notice kind="info">La carpeta de este agente no tiene «documentos/»: no puede recibir PDF desde aquí.</Notice>;
  const missing = (['writeDocuments', 'runScripts'] as const).filter(k => !src.grants[k]);
  const running = data.running.some(r => r.agentId === p.agent.id);
  return <>
    {error && <Notice kind="err">{error}</Notice>}
    {warn && <Notice kind="warn">{warn}</Notice>}
    {src.toolchain.problems.map((x, i) => <Notice key={i} kind="warn">{x}</Notice>)}
    {missing.length > 0 && <Notice kind="info">Para trabajar con documentos dale en Origen estos permisos: {missing.map(k => `«${GRANTS_TEXT[k].label.toLowerCase()}»`).join(' y ')}. <button type="button" className="lnk" onClick={() => onTab('origen')}>Ir a Origen</button></Notice>}
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="h3">Dar un PDF (o un ZIP con PDF)</div>
      <p className="small muted">Se guarda en su carpeta (<code>{src.layout.outputs}/&lt;documento&gt;/original/</code>). Al procesarlo, el agente decide con su habilidad qué hacer, el Portal ejecuta su programa y comprueba el Word: que el texto sea editable, que no haya páginas convertidas en imagen, que estén todas las páginas y todo el texto, que se abra bien en Word, y lo compara página a página. A Claude se le envían su habilidad, los nombres de archivo, las cifras de las comprobaciones y tu feedback; el texto del PDF no se le envía.</p>
      <input ref={fileRef} type="file" accept=".pdf,.zip,application/pdf,application/zip" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} aria-label="Elegir PDF o ZIP" />
      <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={busy || !src.grants.writeDocuments} onClick={() => fileRef.current?.click()}>{Icon.file()} Elegir PDF o ZIP… <span className="muted">(máx. 40 MB; ZIP 60 MB)</span></button>
    </section>
    {data.jobs.length === 0 && <p className="small muted">Aún no hay documentos.</p>}
    {data.jobs.map(j => <JobCard key={j.id} slug={slug} agentId={p.agent.id} job={j} open={open === j.id} onToggle={() => setOpen(open === j.id ? null : j.id)} busy={busy || running} canRun={src.grants.runScripts && src.grants.writeDocuments && !src.toolchain.problems.length}
      onProcess={fb => act(() => osApi.processDocument(slug, p.agent.id, j.id, fb), fb ? 'Generando una nueva versión con tu corrección' : 'Procesando: el agente decide, el Portal ejecuta y comprueba')}
      onFeedback={text => act(() => osApi.sendFeedback(slug, p.agent.id, j.id, text), 'Feedback clasificado: revísalo en «Mejoras»').then(ok => { if (ok) onTab('mejoras'); return ok; })} />)}
  </>;
}

function JobCard({ slug, agentId, job, open, onToggle, busy, canRun, onProcess, onFeedback }: { slug: string; agentId: string; job: DocumentJob; open: boolean; onToggle: () => void; busy: boolean; canRun: boolean; onProcess: (feedback: string | null) => Promise<boolean>; onFeedback: (text: string) => Promise<boolean> }) {
  const st = STATUS[job.status]; const last = job.versions[job.versions.length - 1] ?? null;
  const [confirm, setConfirm] = useState<null | 'run' | 'fix' | 'feedback'>(null); const [fb, setFb] = useState(''); const [fix, setFix] = useState(''); const [sending, setSending] = useState(false);
  const COST = 'Hará dos consultas a tu suscripción de Claude (decidir y redactar el informe) y ejecutará el programa del agente en este equipo; puede tardar unos minutos.';
  return <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <button type="button" className="lnk" style={{ textAlign: 'left', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} onClick={onToggle} aria-expanded={open}>
      {Icon.file()} <strong>{job.title}</strong> <Chip xs tone={st.tone}>{st.text}</Chip>{job.pages ? <span className="small muted">{job.pages} páginas</span> : null}<span className="small muted">{job.versions.length} versión(es)</span>
    </button>
    {open && <>
      {job.error && <Notice kind={job.status === 'failed' ? 'err' : 'warn'}>{job.error}</Notice>}
      {job.status === 'processing' && <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }} role="status"><Spinner /> El agente decide, el Portal ejecuta su programa y comprueba el resultado. Puede tardar unos minutos.</div>}
      {job.status !== 'processing' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {confirm === 'run' ? <><span className="small">{COST}</span><button className="btn btn-primary btn-sm" disabled={busy || !canRun} onClick={() => { setConfirm(null); void onProcess(null); }}>Sí, procesar</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>No</button></>
          : <button className="btn btn-primary btn-sm" disabled={busy || !canRun} onClick={() => setConfirm('run')}>{job.versions.length ? 'Nueva versión' : 'Procesar'}</button>}
      </div>}
      {job.versions.slice().reverse().map(v => <VersionView key={v.n} slug={slug} agentId={agentId} jobId={job.id} v={v} />)}
      {last && job.status !== 'processing' && <div className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="h3">Tu revisión</div>
        <label className="label" htmlFor={`fb-${job.id}`}>Feedback para el agente (decide si vale solo para este documento o si debe cambiar su forma de trabajar; nada cambia sin tu aprobación)</label>
        <textarea id={`fb-${job.id}`} className="input" rows={2} maxLength={4000} value={fb} onChange={e => setFb(e.target.value)} placeholder="Ej.: «No quiero páginas como imagen: el Word debe ser editable»" />
        {confirm === 'feedback' ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><span className="small">Una consulta a tu suscripción (puede tardar un minuto).</span>
          <button className="btn btn-primary btn-sm" disabled={busy || sending} onClick={() => { setConfirm(null); setSending(true); void onFeedback(fb.trim()).then(ok => { if (ok) setFb(''); }).finally(() => setSending(false)); }}>Sí, enviar</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>No</button></div>
          : <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={busy || sending || fb.trim().length < 5} onClick={() => setConfirm('feedback')}>{sending ? <><Spinner /> Clasificando…</> : 'Enviar feedback'}</button>}
        <label className="label" htmlFor={`fix-${job.id}`}>Corrección solo para este documento (crea una nueva versión; no cambia su habilidad)</label>
        <textarea id={`fix-${job.id}`} className="input" rows={2} maxLength={4000} value={fix} onChange={e => setFix(e.target.value)} placeholder="Ej.: «Reduce un poco la escala: la página 40 queda justa»" />
        {confirm === 'fix' ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><span className="small">{COST}</span>
          <button className="btn btn-primary btn-sm" disabled={busy || !canRun} onClick={() => { setConfirm(null); void onProcess(fix.trim()).then(ok => { if (ok) setFix(''); }); }}>Sí, crear la versión</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>No</button></div>
          : <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={busy || !canRun || fix.trim().length < 5} onClick={() => setConfirm('fix')}>Nueva versión con esta corrección</button>}
      </div>}
    </>}
  </section>;
}

function VersionView({ slug, agentId, jobId, v }: { slug: string; agentId: string; jobId: string; v: DocumentJob['versions'][number] }) {
  const [imgs, setImgs] = useState<string[] | null>(null); const [imgError, setImgError] = useState<string | null>(null);
  const url = (rel: string, dl = false) => osApi.documentFileUrl(slug, agentId, jobId, rel, dl);
  const failed = Object.entries(v.gates).filter(([, ok]) => !ok).map(([g]) => GATE_TEXT[g] ?? g);
  return <div className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6, borderColor: v.passed ? 'var(--color-ok-border)' : 'var(--color-warn-border)' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong>v{v.n}</strong><Chip xs tone={v.passed ? 'ok' : 'warn'}>{v.passed ? 'Pasó las comprobaciones' : 'No pasó las comprobaciones'}</Chip>
      <span className="small muted">{new Date(v.createdAt).toLocaleString('es-MX')} · {(v.durationMs / 1000).toFixed(0)} s · versión {v.skillRevision} de su habilidad · programa <code>{v.plan.script.split('/').pop()}</code></span>
      {v.docx && <a className="btn btn-secondary btn-sm" href={url(v.docx, true)}>Descargar Word</a>}
    </div>
    {failed.length > 0 && <Notice kind="warn">No pasó: {failed.join(', ')}.</Notice>}
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{Object.entries(v.gates).map(([g, ok]) => <Chip key={g} xs tone={ok ? 'ok' : 'err'}>{ok ? '✓' : '✗'} {GATE_TEXT[g] ?? g}</Chip>)}</div>
    {Object.keys(v.metrics).length > 0 && <details><summary className="small" style={{ cursor: 'pointer' }}>Cifras</summary><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{Object.entries(v.metrics).map(([k, val]) => <li key={k}>{METRIC_TEXT[k]?.(val) ?? `${k.replace(/_/g, ' ')}: ${String(val)}`}</li>)}</ul></details>}
    <details><summary className="small" style={{ cursor: 'pointer' }}>Informe ({v.reportBy})</summary><div className="small"><Markdown text={v.report} /></div></details>
    <details><summary className="small" style={{ cursor: 'pointer' }}>Qué decidió hacer el agente</summary><div className="small"><code>{v.plan.script} {v.plan.args.join(' ')}</code><br />{v.plan.reason}{v.feedback ? <><br /><strong>Tu corrección:</strong> {v.feedback}</> : null}</div></details>
    {v.qaDir && <details onToggle={e => { if ((e.target as HTMLDetailsElement).open && !imgs) void osApi.evidence(slug, agentId, jobId, v.n).then(r => setImgs(r.images)).catch(err => { setImgError(err.message); setImgs([]); }); }}>
      <summary className="small" style={{ cursor: 'pointer' }}>Comparación página a página (izquierda el PDF, derecha el Word tal como lo muestra LibreOffice)</summary>
      {!imgs ? <Spinner /> : imgError ? <Notice kind="err">No se pudieron cargar las comparaciones: {imgError}</Notice> : imgs.length === 0 ? <p className="small muted">No hay comparaciones para esta versión.</p>
        : <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{imgs.map(f => <figure key={f} style={{ margin: 0 }}><a href={url(`${v.qaDir}/${f}`)} target="_blank" rel="noreferrer" title="Abrir a tamaño completo"><img src={url(`${v.qaDir}/${f}`)} alt={`Comparación de la página ${Number(f.replace(/\D/g, ''))}`} loading="lazy" style={{ width: '100%', border: '1px solid var(--color-border)' }} /></a><figcaption className="small muted">Página {Number(f.replace(/\D/g, ''))} (clic para verla en grande)</figcaption></figure>)}</div>}
    </details>}
  </div>;
}

// ---------------------------------------------------------------- Origen: procedencia, integración, cambios, permisos

export function OriginTab({ slug, p, onChanged }: { slug: string; p: Panel; onChanged: () => void }) {
  const { flash } = useApp();
  const [s, setS] = useState<SourceStatus | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [grants, setGrants] = useState<ExternalGrants | null>(null); const [confirmRestore, setConfirmRestore] = useState<number | null>(null); const [confirmAdopt, setConfirmAdopt] = useState(false);
  const dirty = useRef(false);
  const load = useCallback(() => osApi.source(slug, p.agent.id).then(x => { setS(x); if (!dirty.current) setGrants(x.grants); }).catch(e => setError(e.message)), [slug, p.agent.id]);
  useEffect(() => { void load(); }, [load]);
  useLive(c => c.ws === slug && c.entity === 'agent' && c.id === p.agent.id && c.kind !== 'progress', () => void load(), { minMs: 1500 });
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setError(null); try { await fn(); flash(ok); dirty.current = false; await load(); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  if (!s || !grants) return error ? <Notice kind="err">{error}</Notice> : <Spinner />;
  const changed = JSON.stringify(grants) !== JSON.stringify(s.grants);
  const restoreBlock = s.changes.length > 0 ? 'Primero revisa los cambios hechos fuera del Portal.' : !s.grants.applyImprovements ? 'Necesita el permiso de aplicar mejoras.' : null;
  return <>
    {error && <Notice kind="err">{error}</Notice>}
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><div className="h3">Integración</div><Chip xs tone={s.state === 'integrated' ? 'ok' : s.state === 'evaluating' ? 'accent' : 'warn'}>{INTEGRATION_LABEL[s.state]}</Chip></div>
      <p className="small muted">{s.state === 'integrated' ? 'El Portal ya aplicó a sus archivos una mejora que aprobaste, comprobada, con copia previa y registro.' : s.state === 'evaluating' ? 'Ya trabajó con el Portal. Pasará a «Integrado» cuando apruebes una mejora y se aplique a su habilidad o instrucciones.' : 'Integrado como referencia: aún no ha trabajado con el Portal.'}</p>
      <div className="small"><strong>De dónde viene</strong> (no cambia): <code className="mono">{s.provenance.path}</code>, integrado el {new Date(s.provenance.importedAt).toLocaleString('es-MX')} por {s.provenance.importedBy === 'owner' ? 'ti' : s.provenance.importedBy}.</div>
      <div className="small">Su carpeta (la original): <code className="mono">{s.root}</code> · versión revisada <strong>{s.revision}</strong></div>
    </section>
    {s.readError && <Notice kind="err">No se puede leer su carpeta: {s.readError}</Notice>}
    {s.changes.length > 0 && <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, borderColor: 'var(--color-warn-border)' }}>
      <div className="h3">Cambios hechos fuera del Portal</div>
      <p className="small">El agente sigue usando la versión que revisaste; los programas cambiados no se ejecutan hasta que adoptes los cambios. Revísalos:</p>
      {s.diff.map(d => <details key={d.path} className="card" style={{ padding: 8 }} open={s.diff.length <= 3}><summary className="small" style={{ cursor: 'pointer' }}><code>{d.path}</code> · {d.before === null ? 'nuevo' : d.after === null ? 'eliminado' : 'modificado'}{d.path.endsWith('.py') ? ' · programa: se ejecutará en este equipo' : ''}</summary><LineDiff before={d.before} after={d.after} /></details>)}
      {s.problems.map((x, i) => <Notice key={i} kind={x.blocking ? 'err' : 'warn'}>{x.path}: {x.message}</Notice>)}
      {confirmAdopt ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><span className="small">El agente usará estos cambios desde ahora{s.diff.some(d => d.path.endsWith('.py')) ? ', incluidos los programas modificados' : ''}.</span>
        <button className="btn btn-primary btn-sm" disabled={busy || !s.diskHash || s.problems.some(x => x.blocking)} onClick={() => { setConfirmAdopt(false); void act(() => osApi.adoptSource(slug, p.agent.id, s.diskHash!), 'Cambios adoptados (nueva versión)'); }}>Sí, adoptarlos</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirmAdopt(false)}>No</button></div>
        : <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={busy || !s.diskHash || s.problems.some(x => x.blocking)} onClick={() => setConfirmAdopt(true)}>Adoptar estos cambios…</button>}
    </section>}
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="h3">Qué hay en su carpeta</div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        <li>Instrucciones <code>{s.layout.identity}</code> · notas para otras herramientas {s.layout.adapters.join(', ') || '—'} · contexto {s.layout.context.length} archivo(s)</li>
        <li>Habilidades: {s.layout.skills.map(k => `${k.name}${k.version ? ` v${k.version}` : ''}`).join(', ') || '—'}</li>
        <li>Memoria {s.layout.memory ?? '—'} · entradas {s.layout.inbox ?? '—'} · entregables {s.layout.outputs ?? '—'} · copias {s.layout.backups ?? '—'}</li>
      </ul>
      <div className="small"><strong>Programas registrados</strong></div>
      <ul className="small mono" style={{ margin: 0, paddingLeft: 18 }}>{s.scripts.map(x => <li key={x.path}>{x.path} {x.changedOnDisk ? <Chip xs tone="warn">cambiado fuera</Chip> : null}</li>)}</ul>
      <div className="small muted">En este equipo: {s.toolchain.python ? `Python ${s.toolchain.pythonVersion}` : 'sin Python utilizable'} · {s.toolchain.soffice ? 'LibreOffice para comprobar el Word' : 'sin LibreOffice'}. Microsoft Word no está instalado: que «se abra bien en Word» se comprueba revisando la estructura del archivo.</div>
    </section>
    <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <GrantsEditor value={grants} onChange={g => { dirty.current = true; setGrants(g); }} disabled={busy} />
      {changed && <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void act(() => osApi.setGrants(slug, p.agent.id, grants), 'Permisos actualizados')}>Guardar permisos (los autorizo)</button>}
    </section>
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="h3">Versiones de sus instrucciones y habilidades</div>
      {restoreBlock && s.revisions.length > 1 && <span className="small muted">Para volver a una versión anterior: {restoreBlock.toLowerCase()}</span>}
      {s.revisions.map(r => <div key={r.n} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="mono">#{r.n}</span><span>{({ import: 'al integrarlo', external: 'cambio externo adoptado', improvement: 'mejora aprobada', restore: 'vuelta atrás' } as Record<string, string>)[r.source] ?? r.source}</span><span className="muted">{new Date(r.at).toLocaleString('es-MX')}</span><span className="muted" style={{ flex: 1 }}>{r.note}</span>
        {r.n === s.revision ? <Chip xs tone="ok">actual</Chip> : confirmRestore === r.n ? <><button className="lnk" disabled={busy || !!restoreBlock} onClick={() => { setConfirmRestore(null); void act(() => osApi.restoreSource(slug, p.agent.id, r.n), `Vuelta a la versión ${r.n} (con copia previa)`); }}>Sí, restaurarla en su carpeta (se guarda copia de lo actual)</button><button className="lnk" onClick={() => setConfirmRestore(null)}>No</button></>
          : <button className="lnk" disabled={busy || !!restoreBlock} onClick={() => setConfirmRestore(r.n)} title={restoreBlock ?? undefined}>Restaurar…</button>}
      </div>)}
    </section>
  </>;
}

// ---------------------------------------------------------------- Mejoras: propuestas del agente a partir de tu feedback

export function ImprovementsTab({ slug, p, onChanged, onTab }: { slug: string; p: Panel; onChanged: () => void; onTab: (t: 'origen' | 'documentos') => void }) {
  const { flash } = useApp();
  const [list, setList] = useState<ImprovementProposal[] | null>(null); const [src, setSrc] = useState<SourceStatus | null>(null);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState<{ id: string; what: 'apply' | 'reject' } | null>(null);
  const load = useCallback(() => Promise.all([osApi.documents(slug, p.agent.id), osApi.source(slug, p.agent.id)]).then(([d, s]) => { setList(d.proposals); setSrc(s); }).catch(e => setError(e.message)), [slug, p.agent.id]);
  useEffect(() => { void load(); }, [load]);
  useLive(c => c.ws === slug && c.entity === 'agent' && c.id === p.agent.id && c.kind !== 'progress', () => void load(), { minMs: 1500 });
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setError(null); try { await fn(); flash(ok); await load(); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  if (!list || !src) return error ? <Notice kind="err">{error}</Notice> : <Spinner />;
  const blocked = !src.grants.applyImprovements ? 'Falta el permiso de aplicar mejoras (en Origen).' : src.changes.length > 0 ? 'Su carpeta tiene cambios hechos fuera del Portal: revísalos primero en Origen.' : null;
  return <>
    {error && <Notice kind="err">{error}</Notice>}
    <p className="small muted">Aquí llega tu feedback ya clasificado. Si debe cambiar su forma de trabajar, el agente propone cambios concretos a su habilidad, instrucciones o memoria; nada se aplica sin tu aprobación. Al aplicarse, el Portal guarda una copia de lo que había, anota el cambio en CAMBIOS.md y siempre se puede volver atrás (Origen → Versiones).</p>
    {blocked && list.some(x => x.state === 'proposed') && <Notice kind="info">{blocked} <button type="button" className="lnk" onClick={() => onTab('origen')}>Ir a Origen</button></Notice>}
    {list.length === 0 && <p className="small muted">Sin propuestas todavía. Puedes dar feedback sobre cualquier documento en «Documentos».</p>}
    {list.map(x => <section key={x.id} className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Chip xs tone={x.classification === 'reusable' ? 'accent' : x.classification === 'invalid' ? 'err' : ''}>{FEEDBACK_LABEL[x.classification]}</Chip>
        <Chip xs tone={x.state === 'applied' ? 'ok' : x.state === 'failed' ? 'err' : x.state === 'proposed' ? 'warn' : ''}>{({ proposed: 'Pendiente de tu aprobación', approved: 'Aplicándose…', applied: 'Aplicada', rejected: x.changes.length ? 'Rechazada' : 'Sin cambios que aplicar', failed: 'Falló (todo volvió a como estaba)' } as const)[x.state]}</Chip>
        <span className="small muted">{new Date(x.createdAt).toLocaleString('es-MX')}</span></div>
      <div className="small"><strong>Tu feedback:</strong> {x.feedback}</div>
      <div className="small"><strong>{x.summary}</strong> — {x.reason}</div>
      {x.classification === 'document_only' && <span className="small muted">Vale solo para ese documento: aplícalo con «Nueva versión con esta corrección» en <button type="button" className="lnk" onClick={() => onTab('documentos')}>Documentos</button>. No cambia su habilidad.</span>}
      {x.classification === 'needs_validation' && <span className="small muted">El agente no está seguro de que deba cambiar siempre: apruébalo solo si quieres que valga para todos los documentos; si no, recházalo y úsalo como corrección de un documento.</span>}
      {x.changes.map((c, i) => <details key={i} className="card" style={{ padding: 8 }} open={x.state === 'proposed' && x.changes.length <= 2}><summary className="small" style={{ cursor: 'pointer' }}><code>{c.path}</code> · {c.kind === 'install' ? 'instala un programa verificado del Portal' : c.kind === 'append' ? 'añade al final' : 'cambia el archivo'} — {c.summary}</summary>
        {c.kind === 'install' ? <p className="small muted">Programa del propio Portal ({c.kit}); no lo escribió el modelo.</p> : c.kind === 'append' ? <><div className="small muted">Se añade al final:</div><div className="file-view">{c.content}</div></> : <LineDiff before={c.previous ?? null} after={c.content ?? ''} />}</details>)}
      {x.backupDir && <div className="small">Copia de lo que había: <code>{x.backupDir}</code></div>}
      {x.error && <Notice kind="err">{x.error}</Notice>}
      {x.state === 'proposed' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {confirm?.id === x.id && confirm.what === 'apply' ? <><span className="small">Se escribirá en su carpeta original (con copia previa).</span><button className="btn btn-primary btn-sm" disabled={busy || !!blocked} onClick={() => { setConfirm(null); void act(() => osApi.applyProposal(slug, p.agent.id, x.id), 'Mejora aplicada a su carpeta (copia, CAMBIOS.md y nueva versión)'); }}>Sí, aplicarla</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>No</button></>
          : confirm?.id === x.id && confirm.what === 'reject' ? <><span className="small">No se podrá aplicar después (puedes volver a dar el feedback).</span><button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setConfirm(null); void act(() => osApi.rejectProposal(slug, p.agent.id, x.id), 'Propuesta rechazada'); }}>Sí, rechazarla</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>No</button></>
          : <><button className="btn btn-primary btn-sm" disabled={busy || !!blocked} title={blocked ?? undefined} onClick={() => setConfirm({ id: x.id, what: 'apply' })}>Aprobar y aplicar…</button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirm({ id: x.id, what: 'reject' })}>Rechazar…</button>
            {blocked && <span className="small muted">{blocked}</span>}</>}
      </div>}
    </section>)}
  </>;
}

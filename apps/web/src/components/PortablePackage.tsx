import { useEffect, useId, useRef, useState } from 'react';
import { osApi, type ExportReadiness, type PackageChange, type PackagePreview, type PackageResult } from '../lib/osApi.ts';
import { Chip, Notice, Spinner } from './ui.tsx';
import '../portable.css';

/**
 * Portal IA 3 · Llevarse un agente y traerlo de vuelta, sin abrir carpetas ni leer manifiestos.
 *  - PackageReadiness: antes de descargar dice qué lleva el paquete, qué deja fuera, qué necesita donde vaya a trabajar
 *    y dónde puede (y no puede) ejecutar sus programas. Es la misma validación que hace la descarga.
 *  - PackageReturn: sube el paquete mejorado fuera; enseña SOLO lo que cambió, archivo a archivo, con su comparación; lo
 *    que cambió también en el Portal se decide uno a uno; al aplicar guarda una copia y se puede deshacer.
 */
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function PackageReadiness({ slug, agentId }: { slug: string; agentId: string }) {
  const [r, setR] = useState<ExportReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { setError(null); osApi.exportReadiness(slug, agentId).then(setR).catch((e: any) => setError(e?.message ?? 'No se pudo comprobar el paquete.')); };
  useEffect(load, [slug, agentId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <Notice kind="err">{error} <button type="button" className="lnk" onClick={load}>Reintentar</button></Notice>;
  if (!r) return <Spinner label="Comprobando qué llevará el paquete…" />;
  const m = r.manifest;
  const rt = m?.runtime;
  return (
    <div className="pkg" aria-live="polite">
      <div className="pkg-head">
        <Chip tone={r.ok ? 'ok' : 'err'} dot={r.ok ? 'ok' : 'err'}>{r.ok ? 'Listo para exportar' : 'Hay algo que corregir antes de exportar'}</Chip>
        <span className="small muted">{plural(r.files.length, 'archivo', 'archivos')} · {kb(r.bytes)}</span>
      </div>
      {r.warnings.map((w, i) => <Notice key={i} kind="warn">{w}</Notice>)}
      {m && (
        <div className="pkg-grid">
          <section className="pkg-box" aria-label="Qué incluye el paquete">
            <h4 className="pkg-h">Qué incluye</h4>
            <ul className="pkg-list">
              <li><strong>Su identidad</strong>: instrucciones{m.contents.context.length ? ` y ${plural(m.contents.context.length, 'documento de contexto', 'documentos de contexto')}` : ''}.</li>
              <li><strong>{plural(m.contents.skills.length, 'habilidad', 'habilidades')}</strong>{m.contents.scripts.length ? ` con ${plural(m.contents.scripts.length, 'programa', 'programas')} (sin modificar)` : ''}.</li>
              <li><strong>Lo aprendido</strong>: {plural(m.contents.memory.length, 'archivo de memoria', 'archivos de memoria')}.</li>
              <li><strong>Para usarlo fuera</strong>: guía, reglas de automejora, registro de cambios{rt?.lock ? ', versiones fijadas de sus dependencias' : ''}{m.contents.scripts.length ? ' y comprobación de entorno' : ''}{m.validation ? ', más la comprobación de calidad que usa el Portal' : ''}.</li>
            </ul>
          </section>
          <section className="pkg-box" aria-label="Qué no incluye el paquete">
            <h4 className="pkg-h">Qué no sale del Portal</h4>
            <ul className="pkg-list">{r.excluded.map(x => <li key={x}>{x}</li>)}</ul>
          </section>
          {rt && (rt.python || rt.requirements.length > 0 || rt.binaries.length > 0) && (
            <section className="pkg-box" aria-label="Qué necesita donde vaya a trabajar">
              <h4 className="pkg-h">Qué necesita donde vaya a trabajar</h4>
              <ul className="pkg-list">
                {rt.python && <li>Python {rt.python.minimum} o posterior{rt.python.tested ? ` (aquí funciona con ${rt.python.tested.split(' · ')[0]})` : ''}.</li>}
                {rt.requirements.map(q => <li key={q.name}>{q.name} {q.version ? <span className="pkg-ver">{q.version}</span> : <Chip xs tone="warn">sin versión fijada</Chip>}</li>)}
                {rt.binaries.map(b => <li key={b.name}>{b.label} instalado.</li>)}
              </ul>
              <p className="small muted pkg-note">El paquete trae una comprobación que dice, en el equipo de destino, qué de esto falta y cómo conseguirlo.</p>
            </section>
          )}
          <section className="pkg-box" aria-label="Dónde puede trabajar">
            <h4 className="pkg-h">Dónde puede trabajar</h4>
            <ul className="pkg-list">
              {m.harnesses.map(h => <li key={h.id}><strong>{h.label}</strong>{m.contents.scripts.length > 0 && <> · {h.runsScripts ? 'ejecuta sus programas' : <span className="pkg-warn">no ejecuta sus programas</span>}</>}<br /><span className="small muted">{h.note}</span></li>)}
            </ul>
          </section>
        </div>
      )}
      {m && m.limitations.length > 0 && <details className="pkg-details"><summary>Límites que conviene saber ({m.limitations.length})</summary><ul className="pkg-list">{m.limitations.map(l => <li key={l}>{l}</li>)}</ul></details>}
      <details className="pkg-details"><summary>Ver la lista de archivos ({r.files.length})</summary><ul className="pkg-files">{r.files.map(f => <li key={f}>{f}</li>)}</ul></details>
    </div>
  );
}

/** Comparación sencilla por líneas: lo que se quita y lo que se añade (sin contexto repetido). */
function LineDiff({ before, after }: { before: string | null; after: string }) {
  const a = (before ?? '').split('\n'); const b = after.split('\n');
  const inB = new Set(b); const inA = new Set(a);
  const removed = a.filter(l => l.trim() && !inB.has(l)); const added = b.filter(l => l.trim() && !inA.has(l));
  if (before === null) return <pre className="pkg-diff"><span className="pkg-add">{after.split('\n').slice(0, 80).map(l => `+ ${l}`).join('\n')}</span></pre>;
  if (!removed.length && !added.length) return <p className="small muted">Solo cambian espacios o el orden de las líneas.</p>;
  return <pre className="pkg-diff">{removed.slice(0, 60).map((l, i) => <span key={`r${i}`} className="pkg-del">{`- ${l}\n`}</span>)}{added.slice(0, 60).map((l, i) => <span key={`a${i}`} className="pkg-add">{`+ ${l}\n`}</span>)}{removed.length + added.length > 120 ? '…\n' : ''}</pre>;
}
const KIND_LABEL: Record<PackageChange['kind'], string> = { adopt: 'Cambió fuera', added: 'Nuevo', conflict: 'Cambió fuera y también aquí' };

export function PackageReturn({ slug, agentId, canRestore, onRestore, onDone }: { slug: string; agentId: string; canRestore: boolean; onRestore: (n: number) => Promise<void>; onDone: () => void }) {
  const inputId = useId(); const authId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [st, setSt] = useState<{ kind: 'idle' } | { kind: 'uploading'; progress: number } | { kind: 'preview'; pv: PackagePreview } | { kind: 'applying'; pv: PackagePreview } | { kind: 'done'; res: PackageResult } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const [choice, setChoice] = useState<Record<string, 'portal' | 'paquete'>>({});
  const [auth, setAuth] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setChoice({}); setAuth(false); setSt({ kind: 'uploading', progress: 0 });
    try { const pv = await osApi.packagePreview(slug, agentId, file, f => setSt(s => (s.kind === 'uploading' ? { ...s, progress: f } : s))); setSt({ kind: 'preview', pv }); }
    catch (e: any) { setSt({ kind: 'error', message: e?.message ?? 'No se pudo leer el paquete.' }); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  };
  const apply = async (pv: PackagePreview) => {
    setSt({ kind: 'applying', pv });
    try { const res = await osApi.packageApply(slug, agentId, pv.token, choice); setSt({ kind: 'done', res }); onDone(); }
    catch (e: any) { setSt({ kind: 'error', message: e?.message ?? 'No se pudo importar el paquete.' }); }
  };
  const reset = () => { setSt({ kind: 'idle' }); setChoice({}); setAuth(false); };

  return (
    <div className="pkg">
      <p className="small muted" style={{ margin: 0 }}>Si este agente trabajó fuera del Portal con su paquete y mejoró (aprendió algo, ajustó un programa), sube aquí ese paquete. Verás solo lo que cambió y decides qué entra. Sus documentos no se tocan.</p>
      {(st.kind === 'idle' || st.kind === 'error') && (
        <div className="pkg-upload">
          <label className="btn btn-secondary btn-sm" htmlFor={inputId}>Elegir el paquete mejorado (ZIP)</label>
          <input id={inputId} ref={fileRef} className="sr-only" type="file" accept=".zip,application/zip" onChange={e => void pick(e.target.files?.[0])} />
        </div>
      )}
      {st.kind === 'error' && <Notice kind="err">{st.message}</Notice>}
      {st.kind === 'uploading' && <Spinner label={`Leyendo el paquete… ${Math.round(st.progress * 100)} %`} />}
      {(st.kind === 'preview' || st.kind === 'applying') && (() => {
        const pv = st.pv; const conflicts = pv.changes.filter(c => c.kind === 'conflict');
        const pending = conflicts.filter(c => !choice[c.path]).length;
        return (
          <div className="pkg-review" aria-live="polite">
            {pv.upToDate ? <Notice kind="ok">Este paquete no trae nada nuevo: el agente ya está al día ({plural(pv.unchanged, 'archivo igual', 'archivos iguales')}).</Notice> : <>
              <div className="pkg-head">
                <strong>{plural(pv.changes.length, 'archivo cambió', 'archivos cambiaron')} fuera</strong>
                <span className="small muted">{plural(pv.unchanged, 'archivo sin cambios', 'archivos sin cambios')}{pv.exportedAt ? ` · exportado el ${new Date(pv.exportedAt).toLocaleDateString('es-MX')}` : ''}</span>
              </div>
              {pv.warnings.map((w, i) => <Notice key={i} kind="warn">{w}</Notice>)}
              <ul className="pkg-changes">
                {pv.changes.map(c => (
                  <li key={c.path} className={`pkg-change pkg-change-${c.kind}`}>
                    <div className="pkg-change-top">
                      <span className="pkg-path">{c.path}</span>
                      <Chip xs tone={c.kind === 'conflict' ? 'warn' : 'accent'}>{KIND_LABEL[c.kind]}</Chip>
                      {c.script && <Chip xs tone="warn">Programa</Chip>}
                    </div>
                    {c.kind === 'conflict' ? (
                      <fieldset className="pkg-choice">
                        <legend className="small">Este archivo también cambió en el Portal desde que se exportó. ¿Cuál se queda?</legend>
                        <label className="ck"><input type="radio" name={`ch-${c.path}`} checked={choice[c.path] === 'portal'} onChange={() => setChoice(x => ({ ...x, [c.path]: 'portal' }))} /><span>Conservar lo que hay aquí</span></label>
                        <label className="ck"><input type="radio" name={`ch-${c.path}`} checked={choice[c.path] === 'paquete'} onChange={() => setChoice(x => ({ ...x, [c.path]: 'paquete' }))} /><span>Usar lo del paquete</span></label>
                      </fieldset>
                    ) : (
                      <label className="ck"><input className="cb" type="checkbox" checked={choice[c.path] !== 'portal'} onChange={e => setChoice(x => ({ ...x, [c.path]: e.target.checked ? 'paquete' : 'portal' }))} /><span>Incorporar este cambio</span></label>
                    )}
                    <details className="pkg-details"><summary>Ver qué cambia</summary><LineDiff before={c.before} after={c.after} /></details>
                  </li>
                ))}
              </ul>
              {pv.notRemoved.length > 0 && <p className="small muted">El paquete no trae {plural(pv.notRemoved.length, 'archivo', 'archivos')} que el agente sí tiene: se conservan, no se borra nada.</p>}
              {!pv.canWrite && <Notice kind="warn">Para importar hace falta el permiso «Aplicar mejoras aprobadas» de este agente (más abajo, en Permisos).</Notice>}
              <label className="ck" htmlFor={authId}><input id={authId} className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo incorporar lo elegido en la carpeta de este agente. Antes se guarda una copia y podré deshacerlo.</span></label>
            </>}
            <div className="pkg-actions">
              {!pv.upToDate && <button type="button" className="btn btn-primary btn-sm" disabled={!auth || pending > 0 || !pv.canWrite || st.kind === 'applying'} onClick={() => void apply(pv)}>{st.kind === 'applying' ? 'Importando…' : pending > 0 ? `Elige en ${plural(pending, 'archivo', 'archivos')}` : 'Importar lo elegido'}</button>}
              <button type="button" className="btn btn-ghost btn-sm" onClick={reset} disabled={st.kind === 'applying'}>{pv.upToDate ? 'Cerrar' : 'Cancelar'}</button>
            </div>
          </div>
        );
      })()}
      {st.kind === 'done' && (
        <div className="pkg-review" aria-live="polite">
          <Notice kind="ok">{st.res.upToDate ? 'No había nada que incorporar.' : `Incorporado: ${plural(st.res.written.length, 'archivo', 'archivos')}. El agente ya trabaja con lo aprendido fuera.`}{st.res.kept.length > 0 ? ` Se conservó lo del Portal en ${plural(st.res.kept.length, 'archivo', 'archivos')}.` : ''}</Notice>
          {st.res.backup && <p className="small muted" style={{ margin: 0 }}>Se guardó una copia de lo anterior en la carpeta de respaldos del agente.</p>}
          <div className="pkg-actions">
            {!st.res.upToDate && <button type="button" className="btn btn-secondary btn-sm" disabled={!canRestore || undoing} onClick={async () => { setUndoing(true); try { await onRestore(st.res.previousRevision); reset(); } finally { setUndoing(false); } }}>{undoing ? 'Deshaciendo…' : 'Deshacer esta importación'}</button>}
            <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>Listo</button>
          </div>
        </div>
      )}
    </div>
  );
}

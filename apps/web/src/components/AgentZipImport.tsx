import { useRef, useState } from 'react';
import { TOOLS, diffFiles, type ExecutionBackend } from '@portal-ia/domain';
import { Icon, Notice, Spinner } from './ui.tsx';
import { TOOL_LABELS } from '../lib/labels.ts';
import { osApi, type ZipImportConflict, type ZipImportPreview, type ZipImportResult } from '../lib/osApi.ts';

/**
 * Importar un agente desde un ZIP (sin costo de IA: nada llama a un modelo).
 * - Agente nuevo: vista previa y el propietario concede arnés, permisos y departamento (nunca salen del ZIP).
 * - Agente existente: lo que solo cambió fuera se adopta solo como revisión nueva de origen «import», con Deshacer.
 *   Si un archivo cambió también en el Portal desde la exportación, no se aplica nada de él hasta elegir versión.
 */
type Harnesses = Awaited<ReturnType<typeof osApi.harnesses>>['harnesses'] | null;
type State =
  | { kind: 'idle' }
  | { kind: 'uploading'; progress: number; name: string }
  | { kind: 'new'; pv: ZipImportPreview }
  | { kind: 'applying'; pv: ZipImportPreview }
  | { kind: 'conflict'; pv: ZipImportPreview; conflicts: ZipImportConflict[] }
  | { kind: 'adopted'; pv: ZipImportPreview; result: ZipImportResult }
  | { kind: 'uptodate'; pv: ZipImportPreview }
  | { kind: 'undone'; agentId: string; revision: number; retired: number }
  | { kind: 'error'; message: string; problems: string[] };

const NOT_ADOPTED_NOTE = 'Arnés, modelo, esfuerzo, herramientas, autonomía, capacidades e id nunca se adoptan desde el ZIP: son concesiones tuyas en el Portal y se conservan.';
const problemsOf = (e: any): string[] => (Array.isArray(e?.body?.problems) ? e.body.problems : []).map((p: any) => typeof p === 'string' ? p : `${p.path}: ${p.message}`);

export function AgentZipImport({ slug, projectId, harnesses, departments, agentId, onCancel, onDone }: { slug: string; projectId: string | null; harnesses: Harnesses; departments: string[]; agentId?: string | null; onCancel: () => void; onDone: (id: string) => void }) {
  const [st, setSt] = useState<State>({ kind: 'idle' });
  const [choice, setChoice] = useState<Record<string, 'portal' | 'zip'>>({});
  const [harness, setHarness] = useState<ExecutionBackend | null>(null); const [dep, setDep] = useState(''); const [tools, setTools] = useState<string[]>([]); const [auth, setAuth] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const fail = (e: any) => setSt({ kind: 'error', message: e?.message ?? String(e), problems: problemsOf(e) });

  const confirm = async (pv: ZipImportPreview, resolutions: Record<string, 'portal' | 'zip'> = {}, grantNew = false) => {
    setSt({ kind: 'applying', pv });
    try {
      const h = harnesses?.find(x => x.id === harness); const g = h?.models[0];
      const grant = grantNew ? { department: dep.trim(), scope: projectId ? 'project' as const : 'workspace' as const, projectId, harness: harness!, model: g?.models[0]?.id ?? '', provider: g?.provider ?? null, effort: 'medium' as const, tools, knowledge: ['context'], autonomy: 'ask' as const, capabilities: [], authorized: true } : undefined;
      const result = await osApi.zipImportConfirm(slug, { token: pv.token, hash: pv.hash, resolutions, ...(grant ? { grant } : {}) });
      if (result.mode === 'nuevo') { onDone(result.agent.id); return; }
      setSt(result.upToDate || !result.revision ? { kind: 'uptodate', pv } : { kind: 'adopted', pv, result });
    } catch (e: any) {
      const conflicts = e?.body?.conflicts as ZipImportConflict[] | undefined;
      if (e?.status === 409 && Array.isArray(conflicts) && conflicts.length) { setChoice({}); setSt({ kind: 'conflict', pv, conflicts }); } else fail(e);
    }
  };

  const upload = async (file: File) => {
    abort.current?.abort(); const ctl = new AbortController(); abort.current = ctl;
    setSt({ kind: 'uploading', progress: 0, name: file.name });
    try {
      const pv = await osApi.zipImportPreview(slug, file, f => setSt(s => s.kind === 'uploading' ? { ...s, progress: f } : s), ctl.signal);
      const blocking = pv.problems.filter(p => p.blocking);
      if (!pv.ok || blocking.length) { setSt({ kind: 'error', message: 'El ZIP no se puede importar.', problems: blocking.map(p => `${p.path}: ${p.message}`) }); return; }
      if (agentId && pv.agentId !== agentId) { setSt({ kind: 'error', message: 'Este ZIP es de otro agente (su id no coincide).', problems: [] }); return; }
      if (pv.mode === 'nuevo') { setDep(pv.agent?.department ?? departments[0] ?? 'Dirección'); setTools([]); setHarness(null); setAuth(false); setSt({ kind: 'new', pv }); return; }
      if (pv.upToDate) { setSt({ kind: 'uptodate', pv }); return; }
      if (pv.conflicts.length) { setChoice({}); setSt({ kind: 'conflict', pv, conflicts: pv.conflicts }); return; }
      await confirm(pv); // solo cambió lo de fuera: se adopta sin intervención (con Deshacer)
    } catch (e: any) { if (e?.body?.code === 'aborted') setSt({ kind: 'idle' }); else fail(e); }
  };

  const undo = async (r: ZipImportResult) => {
    if (!r.undo) return; setUndoing(true);
    try { const u = await osApi.zipImportUndo(slug, r.agent.id, r.undo.importN); setSt({ kind: 'undone', agentId: r.agent.id, revision: u.revision.n, retired: u.retired }); }
    catch (e: any) { fail(e); } finally { setUndoing(false); }
  };

  return <section className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }} aria-live="polite">
    <div className="h3">Importar desde ZIP</div>
    <p className="small muted">Sirve para un agente nuevo o para uno que ya está en el Portal: lo que cambió fuera (instrucciones, habilidades, memoria, referencias y CAMBIOS.md) se incorpora como revisión nueva, que puedes deshacer. Importar no tiene costo.</p>

    {(st.kind === 'idle' || st.kind === 'error' || st.kind === 'undone') && <label className="btn btn-secondary" style={{ alignSelf: 'flex-start', cursor: 'pointer' }}>
      {Icon.folder()} Elegir ZIP…
      <input type="file" accept=".zip,application/zip" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
    </label>}

    {st.kind === 'uploading' && <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Spinner /> Subiendo «{st.name}»… {Math.round(st.progress * 100)} %
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => abort.current?.abort()}>Cancelar</button></div>}
    {st.kind === 'applying' && <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Spinner /> Aplicando la importación…</div>}

    {st.kind === 'error' && <Notice kind="err">{st.message}{st.problems.length > 0 && <ul style={{ margin: '6px 0 0' }}>{st.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      <div className="small" style={{ marginTop: 6 }}>No se ha escrito nada en el agente. Los ZIP con posibles secretos o rutas fuera de la carpeta del agente se rechazan enteros.</div></Notice>}

    {st.kind === 'uptodate' && <Notice kind="info">El ZIP no trae nada nuevo: «{st.pv.agent?.name ?? st.pv.name}» ya está al día. No se ha creado ninguna revisión.</Notice>}

    {st.kind === 'adopted' && <>
      <Notice kind="ok">Se adoptó automáticamente lo que cambió fuera como revisión {st.result.revision?.n} (origen «import»), visible en su historial.
        {st.result.adopted.length > 0 && <> Archivos: {st.result.adopted.join(', ')}.</>}</Notice>
      <NotAdopted list={st.result.notAdopted} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {st.result.undo && <button className="btn btn-secondary" disabled={undoing} onClick={() => void undo(st.result)}>{undoing ? 'Deshaciendo…' : `Deshacer (volver a la revisión ${st.result.undo.n})`}</button>}
        <button className="btn btn-primary" onClick={() => onDone(st.result.agent.id)}>Ver al agente</button>
      </div>
    </>}

    {st.kind === 'undone' && <>
      <Notice kind="ok">Importación deshecha: el agente vuelve a lo de antes (revisión {st.revision}, de origen «restore»){st.retired ? ` y se retiraron ${st.retired} aprendizaje(s) que trajo el ZIP` : ''}.</Notice>
      <button className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => onDone(st.agentId)}>Ver al agente</button>
    </>}

    {st.kind === 'conflict' && <>
      <Notice kind="warn">{st.conflicts.length === 1 ? 'Un archivo cambió' : `${st.conflicts.length} archivos cambiaron`} también en el Portal desde la exportación. No se aplica nada de ellos hasta que elijas qué versión quedarte.
        {st.pv.adopted.length > 0 && <> Lo demás se fusiona sin conflicto: {st.pv.adopted.join(', ')}.</>}</Notice>
      {st.conflicts.map(c => <ConflictRow key={c.path} c={c} value={choice[c.path]} onChange={v => setChoice(x => ({ ...x, [c.path]: v }))} />)}
      <NotAdopted list={st.pv.notAdopted} />
      <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={st.conflicts.some(c => !choice[c.path])} onClick={() => void confirm(st.pv, choice)}>Aplicar lo elegido</button>
    </>}

    {st.kind === 'new' && <>
      {st.pv.agent && <div className="small"><strong>{st.pv.agent.name}</strong> · {st.pv.agent.role} — {st.pv.agent.summary}</div>}
      <div className="small">Archivos: {st.pv.files.join(', ')}</div>
      {st.pv.problems.filter(p => !p.blocking).map((p, i) => <Notice key={i} kind="warn">{p.path}: {p.message}</Notice>)}
      <Notice kind="info">Es un agente nuevo en este espacio: recibirá un id nuevo. {st.pv.memory.length > 0 ? `Trae ${st.pv.memory.length} aprendizaje(s), que llegarán como propuestas para que los verifiques. ` : ''}{NOT_ADOPTED_NOTE}</Notice>
      <div className="harness-cards">{(harnesses ?? []).filter(x => x.id !== 'claude-code-terminal').map(x => <button key={x.id} type="button" className="harness-card" aria-pressed={harness === x.id} disabled={!x.availability.available} onClick={() => setHarness(x.id)}><strong>{x.name}</strong><span className="small">{x.availability.available ? 'Disponible' : x.availability.reason}</span></button>)}</div>
      <div><label className="label" htmlFor="zip-dep">Departamento</label><input id="zip-dep" className="input" value={dep} onChange={e => setDep(e.target.value)} list="zip-deps" /><datalist id="zip-deps">{departments.map(n => <option key={n} value={n} />)}</datalist></div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="label">Permisos que concedes</legend>{TOOLS.map(t => <label key={t.id} className="ck small"><input className="cb" type="checkbox" checked={tools.includes(t.id)} onChange={e => setTools(e.target.checked ? [...tools, t.id] : tools.filter(x => x !== t.id))} /> {TOOL_LABELS[t.id]?.name ?? t.id}</label>)}</fieldset>
      <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /> Autorizo importar este agente con lo que concedo aquí (no con lo que pide el ZIP).</label>
      <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={!harness || !auth || dep.trim().length < 2} onClick={() => void confirm(st.pv, {}, true)}>Importar</button>
    </>}

    <button className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} disabled={st.kind === 'applying'} onClick={() => { abort.current?.abort(); onCancel(); }}>Volver</button>
  </section>;
}

function NotAdopted({ list }: { list: string[] }) {
  return <div className="small muted">{NOT_ADOPTED_NOTE}{list.length > 0 && <> Diferencias del ZIP que no se adoptan: {list.join(', ')}.</>}</div>;
}

function ConflictRow({ c, value, onChange }: { c: ZipImportConflict; value: 'portal' | 'zip' | undefined; onChange: (v: 'portal' | 'zip') => void }) {
  const d = diffFiles(c.ours === null ? {} : { [c.path]: c.ours }, c.theirs === null ? {} : { [c.path]: c.theirs })[0];
  return <fieldset className="card" style={{ padding: 10, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
    <legend className="small"><strong className="mono">{c.path}</strong></legend>
    {c.ours === null && <span className="small muted">En el Portal este archivo se borró.</span>}
    {c.theirs === null && <span className="small muted">En el ZIP este archivo no está (se borró fuera).</span>}
    {d && <div className="file-view small">{d.removed.map((l, i) => <div key={`r${i}`}>− {l} <span className="muted">(solo en el Portal)</span></div>)}{d.added.map((l, i) => <div key={`a${i}`}>+ {l} <span className="muted">(solo en el ZIP)</span></div>)}</div>}
    <label className="ck small"><input type="radio" name={`zc-${c.path}`} checked={value === 'portal'} onChange={() => onChange('portal')} /> Quedarme con la del Portal</label>
    <label className="ck small"><input type="radio" name={`zc-${c.path}`} checked={value === 'zip'} onChange={() => onChange('zip')} /> Quedarme con la del ZIP</label>
  </fieldset>;
}

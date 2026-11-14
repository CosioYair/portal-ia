import { useRef, useState } from 'react';
import { TOOLS, contextScopeLabel, diffFiles, type AgentContextScope, type ExecutionBackend } from '@portal-ia/domain';
import { Icon, Notice, Spinner } from './ui.tsx';
import { TOOL_LABELS } from '../lib/labels.ts';
import { osApi, type ImportScopeView, type ZipImportConflict, type ZipImportPreview, type ZipImportResult } from '../lib/osApi.ts';
import type { ImportLearned } from '../lib/api.ts';

/** EN-011 · `learned` lo añade el servidor a la vista previa y al resultado; si falta (servidor antiguo) no se muestra. */
const learnedOf = (x: unknown): ImportLearned | null => { const l = (x as { learned?: ImportLearned } | null)?.learned; return l && typeof l === 'object' ? l : null; };

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
  | { kind: 'scope'; pv: ZipImportPreview; current: AgentContextScope | null }
  | { kind: 'adopted'; pv: ZipImportPreview; result: ZipImportResult }
  | { kind: 'uptodate'; pv: ZipImportPreview }
  | { kind: 'undone'; agentId: string; revision: number; retired: number }
  | { kind: 'error'; message: string; problems: string[] };

const NOT_ADOPTED_NOTE = 'Arnés, modelo, esfuerzo, herramientas, autonomía, capacidades e id nunca se adoptan desde el ZIP: son concesiones tuyas en el Portal y se conservan.';
const problemsOf = (e: any): string[] => (Array.isArray(e?.body?.problems) ? e.body.problems : []).map((p: any) => typeof p === 'string' ? p : `${p.path}: ${p.message}`);
/** EN-014 · Mismo ámbito (proyecto por id, Empresa y General). */
const sameScope = (a: AgentContextScope, b: AgentContextScope) => a.company === b.company && a.general === b.general && (a.project?.id ?? null) === (b.project?.id ?? null);

export function AgentZipImport({ slug, projectId, harnesses, departments, agentId, onCancel, onDone }: { slug: string; projectId: string | null; harnesses: Harnesses; departments: string[]; agentId?: string | null; onCancel: () => void; onDone: (id: string) => void }) {
  const [st, setSt] = useState<State>({ kind: 'idle' });
  const [choice, setChoice] = useState<Record<string, 'portal' | 'zip'>>({});
  const [harness, setHarness] = useState<ExecutionBackend | null>(null); const [dep, setDep] = useState(''); const [tools, setTools] = useState<string[]>([]); const [auth, setAuth] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const abort = useRef<AbortController | null>(null);
  /** EN-014 · Ámbito que tenía el agente existente antes de importar (null si no se pudo leer o es nuevo). */
  const prevScope = useRef<AgentContextScope | null>(null);
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
      if (agentId && pv.agentId !== agentId) { setSt({ kind: 'error', message: pv.agentId ? 'Este paquete es de otro agente de tu empresa. Impórtalo desde la ficha de ese agente.' : 'Este paquete no es de este agente: no trae su marca de exportación. Si quieres crear un agente nuevo con él, usa «Nuevo agente › Importar».', problems: [] }); return; }
      if (pv.mode === 'nuevo') { setDep(pv.agent?.department ?? departments[0] ?? 'Dirección'); setTools([]); setHarness(null); setAuth(false); setSt({ kind: 'new', pv }); return; }
      if (pv.upToDate) { setSt({ kind: 'uptodate', pv }); return; }
      // EN-014 · Ámbito actual del agente (lectura sin costo) para mostrar el cambio y no adoptarlo sin que el propietario lo vea.
      prevScope.current = null;
      if (pv.agentId) {
        try { const panel = await osApi.panel(slug, pv.agentId); prevScope.current = (panel.agent as { contextScope?: AgentContextScope | null }).contextScope ?? null; }
        catch { prevScope.current = null; }
      }
      if (pv.conflicts.length) { setChoice({}); setSt({ kind: 'conflict', pv, conflicts: pv.conflicts }); return; }
      const sp = pv.contextScope;
      if (sp?.declared && (!prevScope.current || !sameScope(prevScope.current, sp.contextScope))) { setSt({ kind: 'scope', pv, current: prevScope.current }); return; }
      await confirm(pv); // solo cambió lo de fuera y el ámbito no cambia: se adopta sin intervención (con Deshacer)
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
      <ScopeView sp={st.pv.contextScope} isNew={false} current={prevScope.current} />
      <LearnedSummary learned={learnedOf(st.result) ?? learnedOf(st.pv)} />
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
      <ScopeView sp={st.pv.contextScope} isNew={false} current={prevScope.current} />
      <LearnedSummary learned={learnedOf(st.pv)} />
      <NotAdopted list={st.pv.notAdopted} />
      <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={st.conflicts.some(c => !choice[c.path])} onClick={() => void confirm(st.pv, choice)}>Aplicar lo elegido</button>
    </>}

    {st.kind === 'scope' && <>
      <Notice kind="warn">Este ZIP cambia el ámbito de «{st.pv.agent?.name ?? st.pv.name}»{st.current ? <> de «{contextScopeLabel(st.current)}»</> : null} a «{st.pv.contextScope?.label ?? ''}». No se aplica nada hasta que lo confirmes.
        {st.pv.adopted.length > 0 && <> Archivos que se adoptarán: {st.pv.adopted.join(', ')}.</>}</Notice>
      <ScopeView sp={st.pv.contextScope} isNew={false} current={st.current} />
      <LearnedSummary learned={learnedOf(st.pv)} />
      <NotAdopted list={st.pv.notAdopted} />
      <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => void confirm(st.pv)}>Aplicar la importación con este ámbito</button>
    </>}

    {st.kind === 'new' && <>
      {st.pv.agent && <div className="small"><strong>{st.pv.agent.name}</strong> · {st.pv.agent.role} — {st.pv.agent.summary}</div>}
      <div className="small">Archivos: {st.pv.files.join(', ')}</div>
      <ScopeView sp={st.pv.contextScope} isNew current={null} />
      <LearnedSummary learned={learnedOf(st.pv)} />
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

/** «Qué trae y qué aprendió»: habilidades nuevas o cambiadas, memoria nueva (llega pendiente) y CAMBIOS.md desde la exportación. */
function LearnedSummary({ learned }: { learned: ImportLearned | null }) {
  if (!learned) return null;
  const empty = !learned.skillsNew.length && !learned.skillsChanged.length && !learned.memoryNew.length && !learned.changelogSince.length;
  const skill = (s: ImportLearned['skillsNew'][number]) => <li key={s.slug}><strong>{s.name}</strong>{s.description ? ` — ${s.description}` : ''}{s.base ? <span className="muted"> (habilidad base: solo informativa, sale de las herramientas concedidas)</span> : null}{s.note ? <span className="muted"> · {s.note}</span> : null}</li>;
  return <div className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }} aria-label="Qué trae y qué aprendió">
    <div className="h3">Qué trae y qué aprendió</div>
    {empty && <span className="small muted">No trae habilidades nuevas ni cambiadas, memoria nueva ni entradas de CAMBIOS.md desde la exportación.</span>}
    {learned.skillsNew.length > 0 && <div className="small"><strong>Habilidades nuevas</strong><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{learned.skillsNew.map(skill)}</ul></div>}
    {learned.skillsChanged.length > 0 && <div className="small"><strong>Habilidades cambiadas</strong><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{learned.skillsChanged.map(skill)}</ul></div>}
    {learned.memoryNew.length > 0 && <div className="small"><strong>Memoria nueva</strong> (llega pendiente de tu verificación; no se usa hasta que la verifiques)<ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{learned.memoryNew.map((m, i) => <li key={i}><strong>{m.title}</strong> — {m.text}</li>)}</ul></div>}
    {learned.changelogSince.length > 0 && <div className="small"><strong>CAMBIOS.md desde la exportación</strong>{learned.changelogMark ? <span className="muted"> ({learned.changelogMark})</span> : null}<ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{learned.changelogSince.map((c, i) => <li key={i}><strong>{c.heading}</strong>{c.text ? ` — ${c.text}` : ''}</li>)}</ul></div>}
    {learned.warnings.map((w, i) => <Notice key={i} kind="warn">{w}</Notice>)}
    <span className="small muted">Las habilidades no conceden permisos: las herramientas se conceden en Configuración.</span>
  </div>;
}

/** EN-014 · Ámbito del ZIP: etiqueta, qué cambia cada opción, aviso de proyecto inexistente (sin bloquear) y qué pasa si no lo declara. */
function ScopeView({ sp, isNew, current }: { sp: ImportScopeView | undefined; isNew: boolean; current: AgentContextScope | null }) {
  if (!sp) return null;
  const currentLabel = current ? contextScopeLabel(current) : null;
  return <div className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }} aria-label="Ámbito">
    <div className="h3">Ámbito: {sp.label}</div>
    {!isNew && currentLabel && currentLabel !== sp.label && <div className="small">Ámbito actual del agente: «{currentLabel}» → pasará a «{sp.label}».</div>}
    {sp.lines.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{sp.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    {!sp.declared && <span className="small muted">Sin ámbito en el ZIP: {isNew ? 'queda General.' : 'conserva el del agente.'}</span>}
    {sp.warning && <Notice kind="warn">{sp.warning}</Notice>}
    <span className="small muted">El ámbito no concede ni quita herramientas ni permisos y no tiene costo.</span>
  </div>;
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

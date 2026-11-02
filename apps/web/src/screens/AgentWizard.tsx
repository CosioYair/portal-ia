import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Capability, ExecutionBackend, PortableSkill, ProviderId } from '@portal-ia/domain';
import { AGENT_ARCHETYPES, CAPABILITIES, DEPARTMENT_PRESETS, GENERAL_ARCHETYPE, HARNESSES, KNOWLEDGE, TOOLS, suggestArchetypes, type AgentArchetype } from '@portal-ia/domain';
import { FolderPicker } from '../components/FolderPicker.tsx';
import { ExternalImportBox } from '../components/ExternalAgent.tsx';
import { DraftNote } from '../components/ui.tsx';
const HARNESS_NAME: Record<string, string> = Object.fromEntries(HARNESSES.map(h => [h.id, h.name]));
import { Shell } from '../components/Shell.tsx';
import { Chip, Icon, Notice, Spinner } from '../components/ui.tsx';
import { useApp } from '../lib/store.ts';
import { KNOWLEDGE_LABELS, TOOL_LABELS } from '../lib/labels.ts';
import { useDraft, draftKey } from '../lib/persist.ts';
import { osApi, type ImportPreview } from '../lib/osApi.ts';
import '../office.css';

/**
 * Crear un agente sin tocar archivos: 1 ¿Qué necesitas? → 2 Identidad → 3 Cómo trabaja → 4 Revisión → 5 Primera tarea.
 * Las sugerencias son deterministas (sin IA). Crear no llama a ningún modelo: deja el agente, su carpeta portable y un
 * registro auditable. El arnés se elige de forma explícita entre los disponibles (nada se queda en la API facturable por
 * defecto); lo técnico (modelo, esfuerzo) solo aparece en «Opciones avanzadas».
 */
interface Draft {
  need: string; archetype: string | null;
  name: string; role: string; summary: string; department: string; responsibilities: string[]; deliverables: string[];
  skills: PortableSkill[]; knowledge: string[]; scope: 'workspace' | 'project';
  harness: ExecutionBackend | null; model: string; provider: ProviderId | null; effort: 'low' | 'medium' | 'high'; tools: string[]; autonomy: 'ask' | 'within_scope'; capabilities: Capability[];
  instructions: string;
  departmentLocked?: boolean;
}
const EMPTY: Draft = { need: '', archetype: null, name: '', role: '', summary: '', department: 'Dirección', responsibilities: [], deliverables: [], skills: [], knowledge: ['context'], scope: 'project', harness: null, model: '', provider: null, effort: 'medium', tools: ['knowledge_write'], autonomy: 'ask', capabilities: ['consultar'], instructions: '' };
const STEPS = ['¿Qué necesitas?', 'Identidad', 'Cómo trabaja', 'Revisión', 'Primera tarea'];
const RISKY = new Set(TOOLS.filter(t => t.risk === 'auth').map(t => t.id));
/** Permisos propios del desarrollo de software: no se ofrecen de entrada a, p. ej., un agente de Marketing. */
const DEV_TOOLS = new Set(['read_repo', 'write_repo', 'sandbox_exec', 'run_tests', 'install_deps', 'delegate']);

export function AgentWizard() {
  const { status, flash } = useApp();
  const ws = status.workspace!; const project = status.project;
  const navigate = useNavigate(); const [params] = useSearchParams();
  const draft = useDraft<Draft>(draftKey('oficina.nuevo-agente', ws.slug), { ...EMPTY, department: params.get('departamento') ?? EMPTY.department });
  const d = draft.value; const set = (patch: Partial<Draft>) => draft.set(v => ({ ...v, ...patch }));
  const [step, setStep] = useState(0);
  const [harnesses, setHarnesses] = useState<Awaited<ReturnType<typeof osApi.harnesses>>['harnesses'] | null>(null);
  const [departments, setDepartments] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(false); const [auth, setAuth] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string; firstTask: string } | null>(null);
  const [importing, setImporting] = useState<false | 'portable' | 'external'>(false);
  const [showDevTools, setShowDevTools] = useState(false);
  useEffect(() => { osApi.harnesses().then(r => setHarnesses(r.harnesses)).catch(e => setError(e.message)); osApi.departments(ws.slug).then(l => setDepartments(l.map(x => x.name))).catch(() => undefined); }, [ws.slug]);
  const suggestions = useMemo(() => suggestArchetypes(d.need), [d.need]);
  const urlDep = params.get('departamento');
  // Si el departamento vino de la sala («Añadir agente») o lo escribiste tú, un perfil sugerido no lo cambia.
  useEffect(() => { if (urlDep && d.department !== urlDep) set({ department: urlDep, departmentLocked: true }); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlDep]);
  const choose = (a: AgentArchetype) => set({
    archetype: a.id, name: a.name, role: a.role, summary: a.summary, department: d.departmentLocked ? d.department : DEPARTMENT_PRESETS.find(p => p.slug === a.department)?.name ?? d.department,
    responsibilities: a.responsibilities, deliverables: a.deliverables, skills: a.skills, knowledge: a.knowledge, tools: a.tools, capabilities: a.capabilities
  });
  const archetype = AGENT_ARCHETYPES.find(a => a.id === d.archetype) ?? (d.archetype === 'general' ? GENERAL_ARCHETYPE : null);
  const harness = harnesses?.find(h => h.id === d.harness) ?? null;
  const modelGroups = harness?.models ?? [];
  const pickHarness = (id: ExecutionBackend) => { const h = harnesses?.find(x => x.id === id); const g = h?.models[0]; set({ harness: id, provider: g?.provider ?? null, model: g?.models.find(m => /sonnet|default/i.test(m.id))?.id ?? g?.models[0]?.id ?? '' }); };
  const valid = [d.need.trim().length >= 3 || !!d.archetype, d.name.trim().length >= 2 && d.role.trim().length >= 2 && d.department.trim().length >= 2, !!d.harness && !!d.model && !!harness?.availability.available, auth];
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const a = await osApi.createAgent(ws.slug, { name: d.name, role: d.role, summary: d.summary, responsibilities: d.responsibilities.filter(Boolean), deliverables: d.deliverables.filter(Boolean), department: d.department, scope: d.scope === 'project' && project ? 'project' : 'workspace', projectId: d.scope === 'project' && project ? project.id : null,
        harness: d.harness!, model: d.model, provider: d.provider, effort: d.effort, tools: d.tools, knowledge: d.knowledge, capabilities: d.capabilities, autonomy: d.autonomy, instructions: d.instructions || null, skills: d.skills, authorized: true });
      draft.clear(); setCreated({ id: a.id, name: a.config.name, firstTask: archetype?.firstTask ?? GENERAL_ARCHETYPE.firstTask }); setStep(4); flash(`«${a.config.name}» ya está en la oficina`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const canDo = d.capabilities.includes('implementar') ? 'Proponer cambios de código (el Portal los aplica en un worktree aislado y los verifica)' : null;
  return (
    <Shell crumb="Nuevo agente">
      <main className="page wizard">
        <div><div className="eyebrow">Oficina</div><h1 className="h1" style={{ fontSize: 26, margin: '4px 0 0' }}>Nuevo agente</h1><DraftNote status={draft.status} onDiscard={() => { draft.clear(); setStep(0); }} /></div>
        <ol className="wizard-steps" aria-label="Pasos">{STEPS.map((s, i) => <li key={s} aria-current={i === step ? 'step' : undefined} className={i < step ? 'done' : ''}>{i < step ? Icon.check(12) : <span className="mono">{i + 1}</span>} {s}</li>)}</ol>
        {error && <Notice kind="err">{error}</Notice>}

        {step === 0 && !importing && <section className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="h3" htmlFor="need">¿Qué debería conseguir este agente?</label>
          <textarea id="need" className="input" rows={3} value={d.need} onChange={e => set({ need: e.target.value })} placeholder="Ej.: «Ayudarme a promocionar Orbiventt en redes» o «Revisar la arquitectura de mis proyectos»" autoFocus />
          <div className="small muted">Ejemplos:</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{AGENT_ARCHETYPES.slice(0, 6).map(a => <button key={a.id} type="button" className="btn btn-ghost btn-sm" onClick={() => { set({ need: a.label }); choose(a); }}>{a.label}</button>)}</div>
          {(suggestions.length > 0 || d.need.trim().length >= 3) && <>
            <div className="h3" style={{ marginTop: 6 }}>Te sugerimos empezar con</div>
            <div className="choice-grid">{[...suggestions.map(s => s.archetype), GENERAL_ARCHETYPE].slice(0, 4).map(a => <button key={a.id} type="button" className="choice" aria-pressed={d.archetype === a.id} onClick={() => choose(a)}>
              <strong>{a.id === 'general' ? 'Otro tipo de agente' : a.name}</strong><span className="small muted">{a.summary}</span>
            </button>)}</div>
          </>}
          <button type="button" className="lnk small" style={{ alignSelf: 'flex-start' }} onClick={() => setImporting('portable')}>¿Tienes la carpeta portable de un agente (agent.yaml)? Impórtala</button>
          <button type="button" className="lnk small" style={{ alignSelf: 'flex-start' }} onClick={() => setImporting('external')}>¿Es un agente que ya trabaja en su propia carpeta (AGENTS.md, CLAUDE.md, skills…)? Intégralo sin copiarlo</button>
        </section>}
        {step === 0 && importing === 'external' && <ExternalImportBox slug={ws.slug} harnesses={harnesses} departments={departments} onCancel={() => setImporting(false)} onDone={id => navigate(`/oficina/agente/${id}/origen`)} />}
        {step === 0 && importing === 'portable' && <ImportBox slug={ws.slug} projectId={project?.id ?? null} harnesses={harnesses} departments={departments} onCancel={() => setImporting(false)} onDone={id => navigate(`/oficina/agente/${id}/archivos`)} />}

        {step === 1 && <section className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="summary-cols">
            <div><label className="label" htmlFor="w-name">Nombre</label><input id="w-name" className="input" value={d.name} onChange={e => set({ name: e.target.value })} /></div>
            <div><label className="label" htmlFor="w-role">Papel (3–6 palabras)</label><input id="w-role" className="input" value={d.role} onChange={e => set({ role: e.target.value })} /></div>
          </div>
          <div><label className="label" htmlFor="w-dep">Departamento</label>
            <input id="w-dep" className="input" list="w-deps" value={d.department} onChange={e => set({ department: e.target.value, departmentLocked: true })} />
            <datalist id="w-deps">{[...new Set([...departments, ...DEPARTMENT_PRESETS.map(p => p.name)])].map(n => <option key={n} value={n} />)}</datalist>
            {d.department && !departments.includes(d.department) && <span className="small muted">Se creará el departamento «{d.department}».</span>}
          </div>
          <div><label className="label" htmlFor="w-sum">En qué te ayuda</label><textarea id="w-sum" className="input" rows={2} value={d.summary} onChange={e => set({ summary: e.target.value })} /></div>
          <ListEditor label="Responsabilidades" items={d.responsibilities} onChange={responsibilities => set({ responsibilities })} placeholder="Qué hace" />
          <ListEditor label="Entregables" items={d.deliverables} onChange={deliverables => set({ deliverables })} placeholder="Qué te entrega" />
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="label">Habilidades</legend>
            {d.skills.length ? d.skills.map((s, i) => <label key={i} className="ck"><input className="cb" type="checkbox" checked onChange={() => set({ skills: d.skills.filter((_, j) => j !== i) })} /> <strong>{s.name}</strong> <span className="small muted">— {s.description}</span></label>) : <span className="small muted">Sin habilidades: podrás añadirlas después en su pestaña Archivos.</span>}
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="label">Qué conocimiento necesita</legend>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{KNOWLEDGE.map(k => <label key={k.id} className="ck small"><input className="cb" type="checkbox" checked={d.knowledge.includes(k.id)} onChange={e => set({ knowledge: e.target.checked ? [...d.knowledge, k.id] : d.knowledge.filter(x => x !== k.id) })} /> {KNOWLEDGE_LABELS[k.id] ?? k.id}</label>)}</div>
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="label">Dónde trabaja</legend>
            <label className="ck small"><input type="radio" name="scope" checked={d.scope === 'project' && !!project} disabled={!project} onChange={() => set({ scope: 'project' })} /> En el proyecto «{project?.name ?? '—'}»</label>
            <label className="ck small"><input type="radio" name="scope" checked={d.scope === 'workspace' || !project} onChange={() => set({ scope: 'workspace' })} /> En toda la empresa</label>
          </fieldset>
        </section>}

        {step === 2 && <section className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="h3">¿Con qué IA trabaja?</div>
          <p className="small muted">Elige la herramienta de IA que hará su trabajo (en el Portal la llamamos «arnés»). Podrás cambiarla después sin perder su identidad ni su memoria.</p>
          {harnesses && !harnesses.some(h => h.id !== 'claude-code-terminal' && h.availability.available) && <Notice kind="warn">Ahora mismo no hay ninguna IA disponible. Revisa <strong>Proveedores → Claude Code — Local</strong> o, en la Oficina, el botón <strong>Arneses</strong>.</Notice>}
          {!harnesses ? <Spinner /> : <div className="harness-cards">{harnesses.filter(h => h.id !== 'claude-code-terminal').map(h => <button key={h.id} type="button" className="harness-card" aria-pressed={d.harness === h.id} disabled={!h.availability.available} onClick={() => pickHarness(h.id)}>
            <strong>{h.name}</strong><span className="small muted">{h.billing === 'subscription' ? 'con tu suscripción (sin pago por uso)' : h.billing === 'api' ? 'se paga por uso' : 'no verificable'}</span>
            <span className="small">{h.summary}</span>
            <span className="small" style={{ fontWeight: 600 }}>{h.availability.available ? 'Disponible' : `No disponible: ${h.availability.reason}`}</span>
            {h.availability.available && h.availability.reason && <span className="small muted">{h.availability.reason}</span>}
            {h.id === 'codex' && h.availability.available && <span className="small muted">Conversaciones, encargos y departamentos (aún no historias ni lotes).</span>}
          </button>)}</div>}
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="label">Qué puede hacer</legend>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{TOOLS.filter(t => showDevTools || !DEV_TOOLS.has(t.id) || d.tools.includes(t.id)).map(t => <label key={t.id} className="ck small"><input className="cb" type="checkbox" checked={d.tools.includes(t.id)} onChange={e => set({ tools: e.target.checked ? [...d.tools, t.id] : d.tools.filter(x => x !== t.id) })} /> {TOOL_LABELS[t.id]?.name ?? t.id} <span className="muted">— {TOOL_LABELS[t.id]?.desc}{RISKY.has(t.id) ? ' (cada uso requiere tu autorización)' : ''}</span></label>)}</div>
            {!showDevTools && <button type="button" className="lnk small" onClick={() => setShowDevTools(true)}>Más permisos (desarrollo de software: repositorio, pruebas, instalación)</button>}
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="label">Autonomía</legend>
            <label className="ck small"><input type="radio" name="aut" checked={d.autonomy === 'ask'} onChange={() => set({ autonomy: 'ask' })} /> Me pregunta antes de cada trabajo (recomendado al empezar)</label>
            <label className="ck small"><input type="radio" name="aut" checked={d.autonomy === 'within_scope'} onChange={() => set({ autonomy: 'within_scope' })} /> Trabaja sin preguntar dentro de lo que yo autorice (lotes y encargos)</label>
          </fieldset>
          <button type="button" className="lnk small" style={{ alignSelf: 'flex-start' }} aria-expanded={advanced} onClick={() => setAdvanced(v => !v)}>{advanced ? 'Ocultar opciones avanzadas' : 'Opciones avanzadas (modelo, esfuerzo, instrucciones)'}</button>
          {advanced && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {modelGroups.length > 1 && <select className="input" value={d.provider ?? ''} onChange={e => { const g = modelGroups.find(x => x.provider === e.target.value); set({ provider: g?.provider ?? null, model: g?.models[0]?.id ?? '' }); }} aria-label="Proveedor">{modelGroups.map(g => <option key={g.provider} value={g.provider}>{g.provider === 'openai' ? 'OpenAI' : 'Anthropic'}</option>)}</select>}
            <select className="input" value={d.model} onChange={e => set({ model: e.target.value })} aria-label="Modelo">{(modelGroups.find(g => g.provider === d.provider)?.models ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            <select className="input" value={d.effort} onChange={e => set({ effort: e.target.value as Draft['effort'] })} aria-label="Esfuerzo"><option value="low">Esfuerzo bajo</option><option value="medium">Esfuerzo medio</option><option value="high">Esfuerzo alto</option></select>
            <textarea className="input" rows={4} value={d.instructions} onChange={e => set({ instructions: e.target.value })} placeholder="Instrucciones propias (AGENTS.md): lo que debe tener siempre presente" aria-label="Instrucciones" />
          </div>}
        </section>}

        {step === 3 && <section className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="h3">Revisa a {d.name}</div>
          <div className="summary-cols">
            <div><strong>Puede</strong><ul>{d.responsibilities.filter(Boolean).map((r, i) => <li key={i}>{r}</li>)}{canDo && <li>{canDo}</li>}<li>Conversar contigo y recibir encargos</li></ul></div>
            <div><strong>No puede</strong><ul><li>Ejecutar órdenes, instalar ni publicar por su cuenta</li><li>Ampliar sus permisos (ni desde sus archivos)</li><li>Gastar sin tu autorización</li>{d.harness === 'codex' && <li>Ejecutar historias o lotes (con Codex, todavía no)</li>}</ul></div>
            <div><strong>Accede a</strong><ul>{d.knowledge.map(k => <li key={k}>{KNOWLEDGE_LABELS[k] ?? k}</li>)}<li>{d.scope === 'project' && project ? `El proyecto «${project.name}»` : 'La empresa (sin proyectos concretos)'}</li></ul></div>
            <div><strong>Necesita tu aprobación para</strong><ul>{d.tools.filter(t => RISKY.has(t)).map(t => <li key={t}>{TOOL_LABELS[t]?.name ?? t}</li>)}<li>Cada encargo (lo autorizas al crearlo)</li>{harness?.billing === 'api' && <li>Cada mensaje (es facturable)</li>}</ul></div>
          </div>
          <div className="small">Trabaja con <strong>{harness?.name}</strong> ({harness?.billing === 'subscription' ? 'tu suscripción, sin pago por uso' : harness?.billing === 'api' ? 'se paga por uso' : 'no verificable'}) · departamento <strong>{d.department}</strong></div>
          <div className="small muted">Se guardará su carpeta portable (agent.yaml, AGENTS.md, habilidades y memoria) y un registro de la creación. Crear no llama a ningún modelo.</div>
          <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /> Autorizo crear a {d.name} con {harness?.name} y estos permisos.</label>
        </section>}

        {step === 4 && created && <section className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Notice kind="ok">{created.name} ya está en la oficina.</Notice>
          <div className="h3">Primera tarea sugerida</div>
          <p className="small">Una pregunta segura para comprobar que trabaja (una llamada con su arnés; no cambia nada fuera del Portal):</p>
          <blockquote className="file-view" style={{ fontFamily: 'var(--font-sans)' }}>{created.firstTask}</blockquote>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => { sessionStorage.setItem(`portal-ia.chat.prefill.${created.id}`, created.firstTask); navigate(`/oficina/agente/${created.id}/chat`); }}>Abrir su chat con esta pregunta</button>
            <Link className="btn btn-secondary" to={`/oficina/agente/${created.id}/archivos`}>Ver sus archivos</Link>
            <Link className="btn btn-ghost" to="/oficina">Volver a la oficina</Link>
          </div>
        </section>}

        {step < 4 && !importing && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <button className="btn btn-ghost" disabled={step === 0} onClick={() => setStep(s => s - 1)}>Atrás</button>
          {!valid[step] && step < 4 && <span className="small muted" style={{ alignSelf: 'center' }}>{step === 0 ? 'Describe qué necesitas o elige un ejemplo.' : step === 1 ? 'Falta el nombre, el papel o el departamento.' : step === 2 ? 'Elige una IA disponible.' : 'Marca la autorización para crearlo.'}</span>}
          {step < 3 ? <button className="btn btn-primary" disabled={!valid[step]} onClick={() => { if (step === 0 && !d.archetype) choose(suggestions[0]?.archetype ?? GENERAL_ARCHETYPE); setStep(s => s + 1); }}>Continuar</button>
            : <button className="btn btn-primary" disabled={busy || !valid.every(Boolean)} onClick={() => void create()}>{busy ? 'Creando…' : `Crear a ${d.name}`}</button>}
        </div>}
      </main>
    </Shell>
  );
}

function ListEditor({ label, items, onChange, placeholder }: { label: string; items: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  return <fieldset className="list-editor" style={{ border: 0, padding: 0, margin: 0 }}><legend className="label">{label}</legend>
    {items.map((it, i) => <div key={i} className="row"><input className="input" value={it} onChange={e => onChange(items.map((x, j) => j === i ? e.target.value : x))} aria-label={`${label} ${i + 1}`} /><button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Quitar ${label.toLowerCase()} ${i + 1}`}>{Icon.x()}</button></div>)}
    <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...items, ''])}>+ {placeholder}</button>
  </fieldset>;
}

function ImportBox({ slug, projectId, harnesses, departments, onCancel, onDone }: { slug: string; projectId: string | null; harnesses: Awaited<ReturnType<typeof osApi.harnesses>>['harnesses'] | null; departments: string[]; onCancel: () => void; onDone: (id: string) => void }) {
  const [path, setPath] = useState(''); const [pv, setPv] = useState<ImportPreview | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [harness, setHarness] = useState<ExecutionBackend | null>(null); const [dep, setDep] = useState(''); const [tools, setTools] = useState<string[]>([]); const [auth, setAuth] = useState(false);
  const [caps, setCaps] = useState<string[]>([]);
  const h = harnesses?.find(x => x.id === harness); const g = h?.models[0];
  const [picking, setPicking] = useState(false);
  const preview = async (p0 = path) => { setBusy(true); setError(null); try { const r = await osApi.importPreview(slug, p0.trim()); setPv(r); setDep(r.agent?.department ?? departments[0] ?? 'Dirección'); setTools([]); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const confirm = async () => { setBusy(true); setError(null); try { const a = await osApi.importAgent(slug, { path: pv!.path, hash: pv!.hash, department: dep, scope: projectId ? 'project' : 'workspace', projectId, harness: harness!, model: g?.models[0]?.id ?? '', provider: g?.provider ?? null, effort: 'medium', tools, knowledge: ['context'], autonomy: 'ask', capabilities: caps as Capability[], authorized: true } as any); onDone(a.id); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return <section className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div className="h3">Importar un agente</div>
    {error && <Notice kind="err">{error}</Notice>}
    <div style={{ display: 'flex', gap: 8 }}><input className="input" value={path} onChange={e => setPath(e.target.value)} placeholder="Carpeta del agente (con agent.yaml)" aria-label="Carpeta del agente" /><button className="btn btn-ghost" type="button" onClick={() => setPicking(true)}>{Icon.folder()} Elegir…</button><button className="btn btn-secondary" disabled={busy || !path.trim()} onClick={() => void preview()}>Revisar</button></div>
    {picking && <FolderPicker title="Carpeta del agente" hint="Elige la carpeta que contiene agent.yaml." initialPath={path || null} onSelect={p => { setPicking(false); setPath(p); void preview(p); }} onClose={() => setPicking(false)} />}
    {pv && <>
      {pv.problems.map((p, i) => <Notice key={i} kind={p.blocking ? 'err' : 'warn'}>{p.path}: {p.message}</Notice>)}
      {pv.agent && <div className="small"><strong>{pv.agent.name}</strong> · {pv.agent.role} — {pv.agent.summary}</div>}
      <div className="small">Archivos: {pv.files.join(', ')}{pv.ignored.length ? ` · ignorados: ${pv.ignored.join(', ')}` : ''}</div>
      {pv.requests && <Notice kind="info">La carpeta pide: trabajar con {HARNESS_NAME[pv.requests.harness] ?? pv.requests.harness}; permisos: {pv.requests.tools.map(t => TOOL_LABELS[t]?.name ?? t).join(', ') || 'ninguno'}; {pv.requests.autonomy === 'within_scope' ? 'trabajar sin preguntar dentro de lo autorizado' : 'preguntar antes de cada trabajo'}. {pv.note}</Notice>}
      <details className="card" style={{ padding: 10 }}><summary className="small" style={{ cursor: 'pointer' }}><strong>Lo que llegaría a sus instrucciones</strong> (léelo antes de importar)</summary>
        <div className="file-view" style={{ marginTop: 8 }}>{pv.instructions || '(sin instrucciones propias)'}</div>
        {pv.skills.map(s => <div key={s.slug} style={{ marginTop: 8 }}><div className="small"><strong>Habilidad: {s.name}</strong>{s.description ? ` — ${s.description}` : ''}</div><div className="file-view">{s.body}</div></div>)}
        {pv.references.map(k => <div key={k.slug} style={{ marginTop: 8 }}><div className="small"><strong>Referencia: {k.title}</strong></div><div className="file-view">{k.body}</div></div>)}
      </details>
      {pv.memory.length > 0 && <div className="small">Trae {pv.memory.length} aprendizaje(s): llegarán como propuestas para que los verifiques.</div>}
      <div className="harness-cards">{(harnesses ?? []).filter(x => x.id !== 'claude-code-terminal').map(x => <button key={x.id} type="button" className="harness-card" aria-pressed={harness === x.id} disabled={!x.availability.available} onClick={() => setHarness(x.id)}><strong>{x.name}</strong><span className="small">{x.availability.available ? 'Disponible' : x.availability.reason}</span></button>)}</div>
      <div><label className="label" htmlFor="imp-dep">Departamento</label><input id="imp-dep" className="input" value={dep} onChange={e => setDep(e.target.value)} list="imp-deps" /><datalist id="imp-deps">{departments.map(n => <option key={n} value={n} />)}</datalist></div>
      {pv.agent && pv.agent.capabilities.length > 0 && <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="label">Papeles que concedes en el equipo (opcional)</legend>{pv.agent.capabilities.map(c => <label key={c} className="ck small"><input className="cb" type="checkbox" checked={caps.includes(c)} onChange={e => setCaps(e.target.checked ? [...caps, c] : caps.filter(x => x !== c))} /> {CAPABILITIES.find(x => x.id === c)?.label ?? c} <Chip xs>pedido</Chip></label>)}</fieldset>}
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="label">Permisos que concedes</legend>{TOOLS.map(t => <label key={t.id} className="ck small"><input className="cb" type="checkbox" checked={tools.includes(t.id)} onChange={e => setTools(e.target.checked ? [...tools, t.id] : tools.filter(x => x !== t.id))} /> {TOOL_LABELS[t.id]?.name ?? t.id}{pv.requests?.tools.includes(t.id) ? <Chip xs>pedida</Chip> : null}</label>)}</fieldset>
      <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /> Autorizo importar este agente con lo que concedo aquí (no con lo que pide la carpeta).</label>
    </>}
    <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}><button className="btn btn-ghost" onClick={onCancel}>Volver</button><button className="btn btn-primary" disabled={busy || !pv?.ok || !harness || !auth || dep.trim().length < 2} onClick={() => void confirm()}>Importar</button></div>
  </section>;
}
